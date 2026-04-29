import crypto from "node:crypto";
import { Octokit } from "@octokit/rest";
import type {
  CodeHostAdapter, AdapterContext,
  PrRef, PrEvent, PrInfo, DiffBundle, FileDiff,
  AegisReview, PrSearchQuery, CloneSpec,
  WebhookRequest, WebhookResponse,
  RepoEntry, CodeHostSpec, SpecApplyOutcome,
} from "@aegis/sdk";
import { AegisAdapterError, CodeHostAdapterBase } from "@aegis/sdk";

export interface GitHubConfig {
  id?: string;
  host?: string;
  org: string;
  repos: string[];
  pollIntervalSec?: number;
  tokenEnv?: string;
  /** Env var holding the GitHub webhook secret. When set, webhook intake is enabled. */
  webhookSecretEnv?: string;
  /** Path the GitHub webhook will POST to. Default "/webhooks/<id>". */
  webhookPath?: string;
}

const ACCEPTED_PR_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

export function github(cfg: GitHubConfig): CodeHostAdapter {
  return new GitHubAdapter(cfg);
}

const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const DYNAMIC_REPOS_KEY = "repos:dynamic";

export class GitHubAdapter extends CodeHostAdapterBase {
  readonly id: string;
  /**
   * Tier 3 spec keys: changing any of these requires a process restart. They
   * touch authentication identity, the HTTP route table, or the API endpoint.
   */
  protected readonly tier3SpecKeys = new Set([
    "host", "org", "tokenEnv", "webhookSecretEnv", "webhookPath",
  ]);

  private octokit!: Octokit;
  private ctx!: AdapterContext;
  private token = "";
  private webhookSecret = "";
  private subscribers: Array<(e: PrEvent) => void> = [];
  /** Live repo set (configRepos union dynamicRepos). Recomputed after any change. */
  private repos = new Set<string>();
  /** Repos listed in the latest reload of aegis.config.ts. Mutated by applySpec. */
  private configRepos = new Set<string>();
  /** Repos added at runtime via chat. Mutated by addRepo/removeRepo. Persisted in KV. */
  private dynamicRepos = new Set<string>();
  private cfg: GitHubConfig & {
    id: string; host: string; pollIntervalSec: number; tokenEnv: string;
  };

  constructor(cfg: GitHubConfig) {
    super();
    this.cfg = {
      ...cfg,
      id: cfg.id ?? "github",
      host: cfg.host ?? "github.com",
      pollIntervalSec: cfg.pollIntervalSec ?? 60,
      tokenEnv: cfg.tokenEnv ?? "GITHUB_TOKEN",
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

  async init(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    const token = ctx.secrets.get(this.cfg.tokenEnv);
    this.token = token;
    if (this.cfg.webhookSecretEnv) {
      this.webhookSecret = ctx.secrets.get(this.cfg.webhookSecretEnv);
    }
    const baseUrl = this.cfg.host !== "github.com"
      ? `https://${this.cfg.host}/api/v3`
      : undefined;
    this.octokit = new Octokit({ auth: token, ...(baseUrl ? { baseUrl } : {}) });

    const stored = await ctx.store.get(DYNAMIC_REPOS_KEY);
    if (stored) {
      try {
        const arr = JSON.parse(stored) as unknown;
        if (Array.isArray(arr)) {
          for (const r of arr) if (typeof r === "string") this.dynamicRepos.add(r);
        }
      } catch (err) {
        ctx.logger.warn(`[github] failed to load dynamic repos: ${(err as Error).message}`);
      }
    }
    this.recomputeRepos();
    ctx.logger.info(`[github] initialised for ${this.cfg.org} (${this.repos.size} repos: ${this.configRepos.size} config, ${this.dynamicRepos.size} dynamic)`);
  }

  /** Recompute the live `repos` set as the union of configRepos and dynamicRepos. */
  private recomputeRepos(): void {
    this.repos = new Set([...this.configRepos, ...this.dynamicRepos]);
  }

  getSpec(): CodeHostSpec {
    return {
      type: "github",
      id: this.id,
      data: {
        host: this.cfg.host,
        org: this.cfg.org,
        repos: [...this.configRepos].sort(),
        pollIntervalSec: this.cfg.pollIntervalSec,
        tokenEnv: this.cfg.tokenEnv,
        webhookSecretEnv: this.cfg.webhookSecretEnv ?? null,
        webhookPath: this.cfg.webhookPath ?? `/webhooks/${this.id}`,
      },
    };
  }

  /**
   * Apply a Tier 1+2 spec change. The supervisor has already verified that no
   * Tier 3 keys differ. Currently the only Tier 1+2 keys are `repos` and
   * `pollIntervalSec`.
   */
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
        this.ctx?.logger.info(`[github] config repos changed: +[${added.join(",")}] -[${removed.join(",")}]`);
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

  /** Serializes addRepo/removeRepo so concurrent calls can't lose each other's writes. */
  override async addRepo(name: string): Promise<void> {
    return this.serializeMutation(async () => {
      if (!REPO_NAME_RE.test(name)) throw new Error(`invalid repo name "${name}"`);
      if (this.repos.has(name)) throw new Error(`already watching ${this.cfg.org}/${name}`);
      try {
        await this.octokit.repos.get({ owner: this.cfg.org, repo: name });
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 404) throw new Error(`${this.cfg.org}/${name} not found or token lacks access`);
        throw new Error(`Failed to verify ${this.cfg.org}/${name}: ${(err as Error).message}`);
      }
      this.dynamicRepos.add(name);
      this.recomputeRepos();
      await this.persistDynamicRepos();
      this.ctx.logger.info(`[github] watching ${this.cfg.org}/${name}`);
    });
  }

  override async removeRepo(name: string): Promise<void> {
    return this.serializeMutation(async () => {
      if (this.configRepos.has(name) && !this.dynamicRepos.has(name)) {
        throw new Error(`${name} is listed in aegis.config.ts; remove it there (the change applies on next config reload)`);
      }
      if (!this.dynamicRepos.has(name)) throw new Error(`not watching ${this.cfg.org}/${name} dynamically`);
      this.dynamicRepos.delete(name);
      this.recomputeRepos();
      await this.persistDynamicRepos();
      this.ctx.logger.info(`[github] unwatched ${this.cfg.org}/${name}`);
    });
  }

  private mutationLock: Promise<void> = Promise.resolve();

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

    const signature = req.headers["x-hub-signature-256"];
    if (!signature || !verifyHmacSha256(this.webhookSecret, req.body, signature)) {
      return { status: 401, body: "invalid signature" };
    }

    const event = req.headers["x-github-event"];
    if (event === "ping") return { status: 200, body: "pong" };
    if (event !== "pull_request") return { status: 200, body: "ignored" };

    let payload: GitHubPrWebhookPayload;
    try {
      payload = JSON.parse(req.body.toString("utf-8")) as GitHubPrWebhookPayload;
    } catch {
      return { status: 400, body: "invalid json" };
    }

    if (!ACCEPTED_PR_ACTIONS.has(payload.action)) return { status: 200, body: "ignored" };
    if (payload.repository?.owner?.login !== this.cfg.org) return { status: 200, body: "wrong org" };
    if (!this.repos.has(payload.repository.name)) return { status: 200, body: "repo not tracked" };

    const ref: PrRef = {
      host: this.cfg.host,
      owner: this.cfg.org,
      repo: payload.repository.name,
      number: payload.pull_request.number,
      headSha: payload.pull_request.head.sha,
    };
    const kind: PrEvent["kind"] =
      payload.action === "opened"      ? "opened"
      : payload.action === "reopened"  ? "reopened"
      :                                  "synchronize";
    const prEvent: PrEvent = { kind, ref, receivedAt: new Date() };
    for (const h of this.subscribers) {
      try { h(prEvent); } catch (err) { this.ctx.logger.warn("[github] subscriber threw", err); }
    }
    return { status: 200, body: "queued" };
  }

  async *pollPullRequests(since?: Date): AsyncIterable<PrEvent> {
    const seenKey = `${this.id}:last-poll`;
    const storedSince = await this.ctx.store.get(seenKey);
    const effectiveSince = since ?? (storedSince ? new Date(storedSince) : new Date(Date.now() - 24 * 60 * 60 * 1000));

    for (const repo of this.repos) {
      try {
        const prs = await this.octokit.pulls.list({
          owner: this.cfg.org,
          repo,
          state: "open",
          sort: "updated",
          direction: "desc",
          per_page: 50,
        });

        for (const pr of prs.data) {
          const updatedAt = new Date(pr.updated_at);
          if (updatedAt <= effectiveSince) continue;

          const ref: PrRef = {
            host: this.cfg.host,
            owner: this.cfg.org,
            repo,
            number: pr.number,
            headSha: pr.head.sha,
          };

          yield { kind: "opened", ref, receivedAt: new Date() };
        }
      } catch (err) {
        this.handleError(err, `pollPullRequests ${this.cfg.org}/${repo}`);
      }
    }

    await this.ctx.store.set(seenKey, new Date().toISOString());
  }

  async fetchPr(ref: PrRef): Promise<PrInfo> {
    const { data: pr } = await this.octokit.pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
    });

    return {
      ref,
      title: pr.title,
      body: pr.body ?? "",
      author: pr.user?.login ?? "unknown",
      baseBranch: pr.base.ref,
      headBranch: pr.head.ref,
      createdAt: new Date(pr.created_at),
      updatedAt: new Date(pr.updated_at),
    };
  }

  async fetchDiff(ref: PrRef): Promise<DiffBundle> {
    const { data: files } = await this.octokit.pulls.listFiles({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
      per_page: 100,
    });

    const { data: pr } = await this.octokit.pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
    });

    const fileDiffs: FileDiff[] = files.map(f => ({
      path: f.filename,
      status: mapStatus(f.status),
      ...(f.patch !== undefined ? { patch: f.patch } : {}),
      ...(f.previous_filename !== undefined ? { oldPath: f.previous_filename } : {}),
    }));

    return { files: fileDiffs, baseSha: pr.base.sha, headSha: pr.head.sha };
  }

  async searchOpenPrs(query: PrSearchQuery): Promise<PrRef[]> {
    const results: PrRef[] = [];
    const keywords = (query.anyOfKeywords ?? []).join(" OR ");
    const repoFilter = query.repos.map(r => `repo:${r}`).join(" ");

    if (!keywords && !repoFilter) return results;

    try {
      const q = [`is:pr`, `is:open`, repoFilter, keywords].filter(Boolean).join(" ");
      const { data } = await this.octokit.search.issuesAndPullRequests({ q, per_page: 20 });

      for (const item of data.items) {
        const urlParts = item.html_url.split("/");
        const repo = urlParts[4] ?? "";
        const owner = urlParts[3] ?? "";
        results.push({
          host: this.cfg.host,
          owner,
          repo,
          number: item.number,
          headSha: "",
        });
      }
    } catch (err) {
      this.ctx.logger.warn("[github] searchOpenPrs failed", err);
    }

    return results;
  }

  async postReview(ref: PrRef, review: AegisReview): Promise<void> {
    const body = buildReviewBody(review);

    const comments = review.prComments.map(c => ({
      path: c.path,
      line: c.line,
      body: c.body,
    }));

    await this.octokit.pulls.createReview({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
      commit_id: ref.headSha,
      event: review.severity === "Critical" || review.severity === "High" ? "REQUEST_CHANGES" : "COMMENT",
      body,
      comments,
    });
  }

  async postInlineReport(ref: PrRef, name: string, markdown: string): Promise<void> {
    await this.octokit.issues.createComment({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.number,
      body: `### ${name}\n\n${markdown}`,
    });
  }

  getCloneSpec(ref: PrRef): CloneSpec {
    return {
      url: `https://${ref.host}/${ref.owner}/${ref.repo}.git`,
      username: "x-access-token",
      password: this.token,
    };
  }

  private handleError(err: unknown, context: string): never {
    if (err instanceof Error && "status" in err) {
      const status = (err as { status: number }).status;
      if (status === 403 || status === 429) {
        throw new AegisAdapterError({ kind: "rate-limited", retryAfterSec: 60 });
      }
      if (status === 401) {
        throw new AegisAdapterError({ kind: "auth-failed", message: `GitHub auth failed in ${context}` });
      }
    }
    throw new AegisAdapterError({ kind: "transient", message: `GitHub error in ${context}: ${String(err)}` });
  }
}

function mapStatus(s: string): FileDiff["status"] {
  if (s === "added") return "added";
  if (s === "removed") return "deleted";
  if (s === "renamed") return "renamed";
  return "modified";
}

interface GitHubPrWebhookPayload {
  action: string;
  pull_request: { number: number; head: { sha: string } };
  repository: { name: string; owner: { login: string } };
}

/** Constant-time HMAC-SHA256 verification with the "sha256=..." prefix used by GitHub. */
function verifyHmacSha256(secret: string, body: Buffer, signature: string): boolean {
  if (!signature.startsWith("sha256=")) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function buildReviewBody(review: AegisReview): string {
  const icon = review.severity === "Critical" ? "🔴"
    : review.severity === "High" ? "🟠"
    : review.severity === "Medium" ? "🟡"
    : "🟢";

  const lines = [
    `## Aegis Review - Severity: ${icon} ${review.severity}`,
    "",
    review.summary,
  ];

  if (review.findings.length > 0) {
    lines.push("", "### Findings", "");
    for (const f of review.findings) {
      lines.push(`- **${f.severity}** [${f.category}] ${f.summary}`);
    }
  }

  return lines.join("\n");
}
