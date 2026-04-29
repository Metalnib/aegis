import crypto from "node:crypto";
import type {
  CodeHostAdapter, AdapterContext,
  PrRef, PrEvent, PrInfo, DiffBundle, FileDiff,
  AegisReview, PrSearchQuery, CloneSpec,
  WebhookRequest, WebhookResponse,
  RepoEntry, CodeHostSpec, SpecApplyOutcome,
} from "@aegis/sdk";
import { AegisAdapterError, CodeHostAdapterBase } from "@aegis/sdk";

export interface GitLabConfig {
  id?: string;
  host?: string;
  group: string;
  repos: string[];
  pollIntervalSec?: number;
  tokenEnv?: string;
  /** Env var holding the GitLab webhook secret token. When set, webhook intake is enabled. */
  webhookSecretEnv?: string;
  /** Path the GitLab webhook will POST to. Default "/webhooks/<id>". */
  webhookPath?: string;
}

const ACCEPTED_MR_ACTIONS = new Set(["open", "reopen", "update"]);
const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const DYNAMIC_REPOS_KEY = "repos:dynamic";

export function gitlab(cfg: GitLabConfig): CodeHostAdapter {
  return new GitLabAdapter(cfg);
}

export class GitLabAdapter extends CodeHostAdapterBase {
  readonly id: string;
  protected readonly tier3SpecKeys = new Set([
    "host", "group", "tokenEnv", "webhookSecretEnv", "webhookPath",
  ]);

  private ctx!: AdapterContext;
  private token = "";
  private webhookSecret = "";
  private subscribers: Array<(e: PrEvent) => void> = [];
  private repos = new Set<string>();
  private configRepos = new Set<string>();
  private dynamicRepos = new Set<string>();
  private cfg: GitLabConfig & {
    id: string; host: string; pollIntervalSec: number; tokenEnv: string;
  };

  constructor(cfg: GitLabConfig) {
    super();
    this.cfg = {
      ...cfg,
      id: cfg.id ?? "gitlab",
      host: cfg.host ?? "gitlab.com",
      pollIntervalSec: cfg.pollIntervalSec ?? 60,
      tokenEnv: cfg.tokenEnv ?? "GITLAB_TOKEN",
    };
    this.id = this.cfg.id;
    this.configRepos = new Set(cfg.repos);

    if (cfg.webhookSecretEnv) {
      this.webhook = {
        path: cfg.webhookPath ?? `/webhooks/${this.id}`,
        handle: (req) => this.handleWebhook(req),
      };
    }
  }

  private recomputeRepos(): void {
    this.repos = new Set([...this.configRepos, ...this.dynamicRepos]);
  }

  async init(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    this.token = ctx.secrets.get(this.cfg.tokenEnv);
    if (this.cfg.webhookSecretEnv) {
      this.webhookSecret = ctx.secrets.get(this.cfg.webhookSecretEnv);
    }

    const stored = await ctx.store.get(DYNAMIC_REPOS_KEY);
    if (stored) {
      try {
        const arr = JSON.parse(stored) as unknown;
        if (Array.isArray(arr)) {
          for (const r of arr) if (typeof r === "string") this.dynamicRepos.add(r);
        }
      } catch (err) {
        ctx.logger.warn(`[gitlab] failed to load dynamic repos: ${(err as Error).message}`);
      }
    }
    this.recomputeRepos();
    ctx.logger.info(`[gitlab] initialised for ${this.cfg.group} (${this.repos.size} repos: ${this.configRepos.size} config, ${this.dynamicRepos.size} dynamic)`);
  }

  getSpec(): CodeHostSpec {
    return {
      type: "gitlab",
      id: this.id,
      data: {
        host: this.cfg.host,
        group: this.cfg.group,
        repos: [...this.configRepos].sort(),
        pollIntervalSec: this.cfg.pollIntervalSec,
        tokenEnv: this.cfg.tokenEnv,
        webhookSecretEnv: this.cfg.webhookSecretEnv ?? null,
        webhookPath: this.cfg.webhookPath ?? `/webhooks/${this.id}`,
      },
    };
  }

  async applySpec(next: CodeHostSpec): Promise<SpecApplyOutcome> {
    const applied: string[] = [];
    const failed: Array<{ key: string; reason: string }> = [];

    if (Array.isArray(next.data.repos)) {
      const newConfigRepos = new Set(next.data.repos as string[]);
      const added = [...newConfigRepos].filter(r => !this.configRepos.has(r));
      const removed = [...this.configRepos].filter(r => !newConfigRepos.has(r));
      this.configRepos = newConfigRepos;
      this.recomputeRepos();
      if (added.length > 0 || removed.length > 0) {
        this.ctx?.logger.info(`[gitlab] config repos changed: +[${added.join(",")}] -[${removed.join(",")}]`);
      }
      applied.push("repos");
    }

    if (typeof next.data.pollIntervalSec === "number") {
      this.cfg = { ...this.cfg, pollIntervalSec: next.data.pollIntervalSec };
      applied.push("pollIntervalSec");
    }

    return { applied, failed };
  }

  override listRepos(): RepoEntry[] {
    return [...this.repos].sort().map(name => ({
      name,
      source: this.configRepos.has(name) ? "config" : "dynamic",
    }));
  }

  private mutationLock: Promise<void> = Promise.resolve();

  override async addRepo(name: string): Promise<void> {
    return this.serializeMutation(async () => {
      if (!REPO_NAME_RE.test(name)) throw new Error(`invalid repo name "${name}"`);
      if (this.repos.has(name)) throw new Error(`already watching ${this.cfg.group}/${name}`);
      const projectPath = encodeURIComponent(`${this.cfg.group}/${name}`);
      const res = await fetch(`https://${this.cfg.host}/api/v4/projects/${projectPath}`, {
        headers: { "PRIVATE-TOKEN": this.token, Accept: "application/json" },
      });
      if (res.status === 404) throw new Error(`${this.cfg.group}/${name} not found or token lacks access`);
      if (!res.ok) throw new Error(`Failed to verify ${this.cfg.group}/${name}: HTTP ${res.status}`);
      this.dynamicRepos.add(name);
      this.recomputeRepos();
      await this.persistDynamicRepos();
      this.ctx.logger.info(`[gitlab] watching ${this.cfg.group}/${name}`);
    });
  }

  override async removeRepo(name: string): Promise<void> {
    return this.serializeMutation(async () => {
      if (this.configRepos.has(name) && !this.dynamicRepos.has(name)) {
        throw new Error(`${name} is listed in aegis.config.ts; remove it there (the change applies on next config reload)`);
      }
      if (!this.dynamicRepos.has(name)) throw new Error(`not watching ${this.cfg.group}/${name} dynamically`);
      this.dynamicRepos.delete(name);
      this.recomputeRepos();
      await this.persistDynamicRepos();
      this.ctx.logger.info(`[gitlab] unwatched ${this.cfg.group}/${name}`);
    });
  }

  private async serializeMutation<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.mutationLock;
    let release!: () => void;
    this.mutationLock = new Promise<void>((r) => { release = r; });
    await previous;
    try { return await fn(); } finally { release(); }
  }

  private async persistDynamicRepos(): Promise<void> {
    await this.ctx.store.set(DYNAMIC_REPOS_KEY, JSON.stringify([...this.dynamicRepos].sort()));
  }

  async dispose(): Promise<void> {
    this.subscribers = [];
  }

  override subscribe(handler: (e: PrEvent) => void): Disposable {
    this.subscribers.push(handler);
    return {
      [Symbol.dispose]: () => {
        this.subscribers = this.subscribers.filter(h => h !== handler);
      },
    };
  }

  private async handleWebhook(req: WebhookRequest): Promise<WebhookResponse> {
    if (!this.webhookSecret) return { status: 503, body: "webhook secret not configured" };

    const provided = req.headers["x-gitlab-token"] ?? "";
    if (!constantTimeStringEqual(provided, this.webhookSecret)) {
      return { status: 401, body: "invalid token" };
    }

    if (req.headers["x-gitlab-event"] !== "Merge Request Hook") {
      return { status: 200, body: "ignored" };
    }

    let payload: GitLabMrWebhookPayload;
    try {
      payload = JSON.parse(req.body.toString("utf-8")) as GitLabMrWebhookPayload;
    } catch {
      return { status: 400, body: "invalid json" };
    }

    const action = payload.object_attributes?.action;
    if (!action || !ACCEPTED_MR_ACTIONS.has(action)) return { status: 200, body: "ignored" };

    const repoName = payload.project?.path;
    const namespace = payload.project?.namespace;
    if (!repoName || namespace !== this.cfg.group) return { status: 200, body: "wrong namespace" };
    if (!this.repos.has(repoName)) return { status: 200, body: "repo not tracked" };

    const ref: PrRef = {
      host: this.cfg.host,
      owner: this.cfg.group,
      repo: repoName,
      number: payload.object_attributes.iid,
      headSha: payload.object_attributes.last_commit?.id ?? "",
    };
    const kind: PrEvent["kind"] =
      action === "open"     ? "opened"
      : action === "reopen" ? "reopened"
      :                       "synchronize";
    const prEvent: PrEvent = { kind, ref, receivedAt: new Date() };
    for (const h of this.subscribers) {
      try { h(prEvent); } catch (err) { this.ctx.logger.warn("[gitlab] subscriber threw", err); }
    }
    return { status: 200, body: "queued" };
  }

  async *pollPullRequests(since?: Date): AsyncIterable<PrEvent> {
    const seenKey = `${this.id}:last-poll`;
    const storedSince = await this.ctx.store.get(seenKey);
    const effectiveSince = since ?? (storedSince ? new Date(storedSince) : new Date(Date.now() - 24 * 60 * 60 * 1000));
    const updatedAfter = effectiveSince.toISOString();

    for (const repo of this.repos) {
      try {
        const projectPath = encodeURIComponent(`${this.cfg.group}/${repo}`);
        const mrs = await this.apiGet<GitLabMr[]>(
          `/projects/${projectPath}/merge_requests?state=opened&updated_after=${encodeURIComponent(updatedAfter)}&per_page=50`,
        );
        for (const mr of mrs) {
          yield {
            kind: "opened",
            ref: mrToRef(this.cfg.host, this.cfg.group, repo, mr),
            receivedAt: new Date(),
          };
        }
      } catch (err) {
        this.ctx.logger.warn(`[gitlab] poll error for ${this.cfg.group}/${repo}`, err);
      }
    }

    await this.ctx.store.set(seenKey, new Date().toISOString());
  }

  async fetchPr(ref: PrRef): Promise<PrInfo> {
    const projectPath = encodeURIComponent(`${ref.owner}/${ref.repo}`);
    const mr = await this.apiGet<GitLabMr>(`/projects/${projectPath}/merge_requests/${ref.number}`);
    return {
      ref,
      title: mr.title,
      body: mr.description ?? "",
      author: mr.author.username,
      baseBranch: mr.target_branch,
      headBranch: mr.source_branch,
      createdAt: new Date(mr.created_at),
      updatedAt: new Date(mr.updated_at),
    };
  }

  async fetchDiff(ref: PrRef): Promise<DiffBundle> {
    const projectPath = encodeURIComponent(`${ref.owner}/${ref.repo}`);
    const data = await this.apiGet<GitLabChanges>(
      `/projects/${projectPath}/merge_requests/${ref.number}/changes`,
    );

    const files: FileDiff[] = data.changes.map(c => {
      const status: FileDiff["status"] = c.new_file ? "added"
        : c.deleted_file ? "deleted"
        : c.renamed_file ? "renamed"
        : "modified";
      return {
        path: c.new_path,
        status,
        ...(c.diff ? { patch: c.diff } : {}),
        ...(c.renamed_file && c.old_path !== c.new_path ? { oldPath: c.old_path } : {}),
      };
    });

    return { files, baseSha: data.diff_refs.base_sha, headSha: data.diff_refs.head_sha };
  }

  async searchOpenPrs(query: PrSearchQuery): Promise<PrRef[]> {
    const results: PrRef[] = [];
    const keywords = (query.anyOfKeywords ?? []).join(" ");

    for (const repo of query.repos) {
      try {
        const projectPath = encodeURIComponent(`${this.cfg.group}/${repo}`);
        const searchParam = keywords ? `&search=${encodeURIComponent(keywords)}` : "";
        const branchParam = query.branchPattern ? `&source_branch=${encodeURIComponent(query.branchPattern)}` : "";
        const mrs = await this.apiGet<GitLabMr[]>(
          `/projects/${projectPath}/merge_requests?state=opened${searchParam}${branchParam}&per_page=20`,
        );
        for (const mr of mrs) {
          results.push(mrToRef(this.cfg.host, this.cfg.group, repo, mr));
        }
      } catch (err) {
        this.ctx.logger.warn(`[gitlab] searchOpenPrs error for ${repo}`, err);
      }
    }

    return results;
  }

  async postReview(ref: PrRef, review: AegisReview): Promise<void> {
    const projectPath = encodeURIComponent(`${ref.owner}/${ref.repo}`);
    const base = `/projects/${projectPath}/merge_requests/${ref.number}`;

    await this.apiPost(`${base}/notes`, { body: buildNoteBody(review) });

    for (const comment of review.prComments) {
      await this.apiPost(`${base}/notes`, {
        body: `**${comment.path}:${comment.line}**\n\n${comment.body}`,
      }).catch(() => { /* best-effort inline comments */ });
    }
  }

  async postInlineReport(ref: PrRef, name: string, markdown: string): Promise<void> {
    const projectPath = encodeURIComponent(`${ref.owner}/${ref.repo}`);
    await this.apiPost(`/projects/${projectPath}/merge_requests/${ref.number}/notes`, {
      body: `### ${name}\n\n${markdown}`,
    });
  }

  getCloneSpec(ref: PrRef): CloneSpec {
    return {
      url: `https://${ref.host}/${ref.owner}/${ref.repo}.git`,
      username: "oauth2",
      password: this.token,
    };
  }

  getUserPermission(_userId: string): "public" | "member" | "admin" {
    return "public";
  }

  private async apiGet<T>(path: string): Promise<T> {
    const res = await fetch(`https://${this.cfg.host}/api/v4${path}`, {
      headers: { "PRIVATE-TOKEN": this.token, Accept: "application/json" },
    });
    if (!res.ok) this.handleStatus(res.status, path);
    return res.json() as Promise<T>;
  }

  private async apiPost<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`https://${this.cfg.host}/api/v4${path}`, {
      method: "POST",
      headers: {
        "PRIVATE-TOKEN": this.token,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) this.handleStatus(res.status, path);
    return res.json() as Promise<T>;
  }

  private handleStatus(status: number, context: string): never {
    if (status === 401 || status === 403) {
      throw new AegisAdapterError({ kind: "auth-failed", message: `GitLab auth failed: ${context}` });
    }
    if (status === 429) {
      throw new AegisAdapterError({ kind: "rate-limited", retryAfterSec: 60 });
    }
    throw new AegisAdapterError({ kind: "transient", message: `GitLab HTTP ${status}: ${context}` });
  }
}

// ── GitLab API shapes ────────────────────────────────────────────────────────

interface GitLabMr {
  iid: number;
  title: string;
  description: string | null;
  sha: string;
  source_branch: string;
  target_branch: string;
  created_at: string;
  updated_at: string;
  author: { username: string };
}

interface GitLabChange {
  old_path: string;
  new_path: string;
  diff: string | null;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
}

interface GitLabChanges {
  diff_refs: { base_sha: string; head_sha: string; start_sha: string };
  changes: GitLabChange[];
}

interface GitLabMrWebhookPayload {
  object_attributes: { iid: number; action?: string; last_commit?: { id: string } };
  project: { path: string; namespace: string };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function mrToRef(host: string, owner: string, repo: string, mr: GitLabMr): PrRef {
  return { host, owner, repo, number: mr.iid, headSha: mr.sha };
}

/**
 * Constant-time string comparison that does not leak the length of either
 * input. We HMAC both inputs with a per-call random key, then compare the
 * fixed-size HMACs - input length no longer affects timing.
 */
function constantTimeStringEqual(a: string, b: string): boolean {
  const key = crypto.randomBytes(32);
  const aMac = crypto.createHmac("sha256", key).update(a).digest();
  const bMac = crypto.createHmac("sha256", key).update(b).digest();
  return crypto.timingSafeEqual(aMac, bMac);
}

function buildNoteBody(review: AegisReview): string {
  const icon = review.severity === "Critical" ? "🔴"
    : review.severity === "High" ? "🟠"
    : review.severity === "Medium" ? "🟡"
    : "🟢";

  const lines = [`## Aegis Review - ${icon} ${review.severity}`, "", review.summary];

  if (review.findings.length > 0) {
    lines.push("", "### Findings", "");
    for (const f of review.findings) {
      lines.push(`- **${f.severity}** [${f.category}] ${f.summary}`);
    }
  }

  return lines.join("\n");
}
