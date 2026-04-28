import path from "node:path";
import type { ChatCommand, ChatAdapter, CommandPermission, PrRef } from "@aegis/sdk";
import type { Queue, AegisConfig } from "@aegis/core";
import type { AgentWorker, SynopsisMcpClient } from "@aegis/agent";
import { QueryTimeoutError } from "@aegis/agent";
import type { Logger } from "@aegis/sdk";

export interface CommandRouterDeps {
  queue: Queue;
  mcp: SynopsisMcpClient;
  worker: AgentWorker;
  cfg: AegisConfig;
  logger: Logger;
}

// ── Permission requirements per verb ─────────────────────────────────────────

const COMMAND_PERMISSIONS: Record<string, CommandPermission> = {
  help: "public",
  status: "public",
  repos: "public",
  impact: "public",
  paths: "public",
  endpoints: "public",
  callers: "public",
  db: "public",
  ambiguous: "public",
  explain: "public",
  review: "member",
  rescan: "member",
  model: "public",      // read is public; write is checked inside the handler
  providers: "public",
  watch: "admin",
  unwatch: "admin",
  dlq: "member",
  requeue: "admin",
  cancel: "admin",
};

const PERMISSION_ORDER: CommandPermission[] = ["public", "member", "admin"];

function meetsPermission(actual: CommandPermission, required: CommandPermission): boolean {
  return PERMISSION_ORDER.indexOf(actual) >= PERMISSION_ORDER.indexOf(required);
}

// ── Router ───────────────────────────────────────────────────────────────────

export class CommandRouter {
  constructor(private readonly deps: CommandRouterDeps) {}

  async handle(cmd: ChatCommand, chat: ChatAdapter): Promise<void> {
    const { logger } = this.deps;
    const text = cmd.text.trim();
    const parts = text.split(/\s+/);
    const verb = parts[0]?.toLowerCase() ?? "";
    const rest = parts.slice(1);

    const required = COMMAND_PERMISSIONS[verb] ?? "member";
    const actual = chat.getUserPermission?.(cmd.user.id) ?? "public";

    if (!meetsPermission(actual, required)) {
      await chat.reply(cmd, { text: `Sorry, \`${verb}\` is ${required}-only in this channel.` });
      return;
    }

    try {
      switch (verb) {
        case "review":    return await this.handleReview(rest.join(" "), cmd, chat);
        case "impact":    return await this.handleQuery(`blast radius for symbol: ${rest.join(" ")}`, cmd, chat);
        case "callers":   return await this.handleQuery(`who calls symbol: ${rest.join(" ")} (depth 1)`, cmd, chat);
        case "paths":     return await this.handleQuery(`dependency paths from "${rest[0] ?? ""}" to "${rest[1] ?? ""}"`, cmd, chat);
        case "endpoints": return await this.handleQuery(`list HTTP endpoints${rest.length ? ` matching: ${rest.join(" ")}` : ""}`, cmd, chat);
        case "db":        return await this.handleQuery(`EF entity/table lineage for: ${rest.join(" ")}`, cmd, chat);
        case "ambiguous": return await this.handleQuery(`top ambiguous dependency edges${rest.length ? ` for repo: ${rest.join(" ")}` : ""}`, cmd, chat);
        case "explain":   return await this.handleQuery(`explain finding: ${rest.join(" ")}`, cmd, chat);
        case "repos":     return await this.handleRepos(cmd, chat);
        case "rescan":    return await this.handleRescan(rest.join(" "), cmd, chat);
        case "status":    return await this.handleStatus(cmd, chat);
        case "model":     return await this.handleModel(rest, cmd, chat);
        case "providers": return await this.handleProviders(cmd, chat);
        case "watch":     return await this.handleWatch(rest.join(" "), cmd, chat);
        case "unwatch":   return await this.handleUnwatch(rest.join(" "), cmd, chat);
        case "dlq":       return await this.handleDlqList(cmd, chat);
        case "requeue":   return await this.handleRequeue(rest[0] ?? "", cmd, chat);
        case "cancel":    return await this.handleCancel(rest[0] ?? "", cmd, chat);
        case "help":      return await this.handleHelp(cmd, chat);
        default:
          await chat.reply(cmd, { text: `Unknown command: \`${verb}\`. Try \`help\`.` });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("[command-router] handler error", err);
      await chat.reply(cmd, { text: `Error: ${msg}` }).catch(() => {});
    }
  }

  // ── Handlers ───────────────────────────────────────────────────────────────

  private async handleReview(rawUrl: string, cmd: ChatCommand, chat: ChatAdapter): Promise<void> {
    const ref = parsePrUrl(rawUrl.trim());
    if (!ref) {
      await chat.reply(cmd, { text: "Usage: `review <pr-url>`\nExample: `review https://github.com/org/repo/pull/42`" });
      return;
    }

    const host = this.deps.cfg.codeHosts.find(h => h.id === ref.host)
      ?? this.deps.cfg.codeHosts.find(h => ref.host.includes(h.id));

    if (!host) {
      await chat.reply(cmd, { text: `No adapter configured for \`${ref.host}\`. Check \`codeHosts\` in your config.` });
      return;
    }

    // fetch the real headSha from the host (the URL doesn't carry it)
    let fullRef: PrRef;
    try {
      const pr = await host.fetchPr(ref);
      fullRef = { ...ref, headSha: pr.ref.headSha };
    } catch (err) {
      this.deps.logger.error("[command-router] fetchPr failed", { ref, err });
      await chat.reply(cmd, {
        text: `Could not fetch \`${ref.owner}/${ref.repo}#${ref.number}\` from \`${ref.host}\`. Check the URL and that the bot has access.`,
      });
      return;
    }

    const job = this.deps.queue.enqueue(fullRef);
    if (job) {
      await chat.reply(cmd, {
        text: `Queued review for \`${fullRef.owner}/${fullRef.repo}#${fullRef.number}\` (job \`${job.id.slice(0, 8)}\`). Result will be posted on the PR.`,
      });
    } else {
      await chat.reply(cmd, {
        text: `\`${fullRef.owner}/${fullRef.repo}#${fullRef.number}\` is already in the queue at this commit.`,
      });
    }
  }

  private async handleQuery(question: string, cmd: ChatCommand, chat: ChatAdapter): Promise<void> {
    await chat.reply(cmd, { text: "Querying..." });
    try {
      const result = await this.deps.worker.query(question);
      await chat.reply(cmd, { text: truncate(result, 3000) });
    } catch (err) {
      if (err instanceof QueryTimeoutError) {
        await chat.reply(cmd, { text: `Query timed out after ${Math.round(err.timeoutMs / 1000)}s. Try a narrower question.` });
        return;
      }
      throw err;
    }
  }

  private async handleRepos(cmd: ChatCommand, chat: ChatAdapter): Promise<void> {
    const lines: string[] = ["Aegis is monitoring:"];
    let total = 0;
    for (const host of this.deps.cfg.codeHosts) {
      const list = host.listRepos?.();
      if (!list) {
        lines.push(`  ${host.id}: (this adapter doesn't expose listRepos)`);
        continue;
      }
      lines.push(`  ${host.id} (${list.length}):`);
      for (const e of list) {
        lines.push(`    - ${e.name}${e.source === "dynamic" ? "  [dynamic]" : ""}`);
      }
      total += list.length;
    }
    lines.push("", `${total} repo(s) total. Use \`watch <repo>\` / \`unwatch <repo>\` to change.`);
    await chat.reply(cmd, { text: truncate(lines.join("\n"), 3000) });
  }

  private async handleRescan(repoName: string, cmd: ChatCommand, chat: ChatAdapter): Promise<void> {
    if (!repoName) {
      await chat.reply(cmd, { text: "Usage: `rescan <repo>`\nExample: `rescan svc-a`" });
      return;
    }
    // Refuse anything that could escape the workspace via path components.
    // The repo name segment must look like a real directory name, not a path.
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(repoName) || repoName === "." || repoName === "..") {
      await chat.reply(cmd, { text: `Invalid repo name \`${repoName}\`.` });
      return;
    }

    const repoPath = path.join(this.deps.cfg.workspace, repoName);
    await chat.reply(cmd, { text: `Rescanning \`${repoName}\`...` });
    await this.deps.mcp.callTool("reindex_repository", { path: repoPath });
    await chat.reply(cmd, { text: `Rescan of \`${repoName}\` triggered.` });
  }

  private async handleStatus(cmd: ChatCommand, chat: ChatAdapter): Promise<void> {
    const s = this.deps.queue.stats();
    const hosts = this.deps.cfg.codeHosts.map(h => h.id).join(", ");
    const text = [
      "Aegis status:",
      `  Hosts:   ${hosts}`,
      `  Pending: ${s.pending}`,
      `  Running: ${s.running}`,
      `  Done:    ${s.done}`,
      `  DLQ:     ${s.dlq}`,
    ].join("\n");
    await chat.reply(cmd, { text });
  }

  private async handleWatch(arg: string, cmd: ChatCommand, chat: ChatAdapter): Promise<void> {
    const target = this.resolveAdapterAndRepo(arg);
    if (!target.ok) { await chat.reply(cmd, { text: target.message }); return; }
    if (!target.host.addRepo) {
      await chat.reply(cmd, { text: `Adapter \`${target.host.id}\` does not support runtime watch.` });
      return;
    }
    try {
      await target.host.addRepo(target.repo);
      await chat.reply(cmd, { text: `Now watching \`${target.host.id}/${target.repo}\`. New PRs will be reviewed.` });
    } catch (err) {
      await chat.reply(cmd, { text: `Failed: ${(err as Error).message}` });
    }
  }

  private async handleUnwatch(arg: string, cmd: ChatCommand, chat: ChatAdapter): Promise<void> {
    const target = this.resolveAdapterAndRepo(arg);
    if (!target.ok) { await chat.reply(cmd, { text: target.message }); return; }
    if (!target.host.removeRepo) {
      await chat.reply(cmd, { text: `Adapter \`${target.host.id}\` does not support runtime unwatch.` });
      return;
    }
    try {
      await target.host.removeRepo(target.repo);
      await chat.reply(cmd, { text: `Unwatched \`${target.host.id}/${target.repo}\`. The cloned working tree is left in place.` });
    } catch (err) {
      await chat.reply(cmd, { text: `Failed: ${(err as Error).message}` });
    }
  }

  /**
   * Parse a watch/unwatch argument. Accepts `<repo>` (only when exactly one
   * code-host adapter is configured) or `<adapter-id>/<repo>`.
   */
  private resolveAdapterAndRepo(arg: string):
    | { ok: true; host: import("@aegis/sdk").CodeHostAdapter; repo: string }
    | { ok: false; message: string }
  {
    const trimmed = arg.trim();
    if (!trimmed) {
      return { ok: false, message: "Usage: `watch <repo>` or `watch <adapter>/<repo>`" };
    }
    const slash = trimmed.indexOf("/");
    const hosts = this.deps.cfg.codeHosts;

    if (slash >= 0) {
      const adapterId = trimmed.slice(0, slash);
      const repo = trimmed.slice(slash + 1);
      const host = hosts.find(h => h.id === adapterId);
      if (!host) return { ok: false, message: `No adapter \`${adapterId}\`. Configured: ${hosts.map(h => h.id).join(", ")}` };
      if (!repo) return { ok: false, message: "Empty repo name." };
      return { ok: true, host, repo };
    }

    if (hosts.length === 1) {
      return { ok: true, host: hosts[0]!, repo: trimmed };
    }
    return {
      ok: false,
      message: `Multiple adapters configured (${hosts.map(h => h.id).join(", ")}). Use \`<adapter-id>/<repo>\`.`,
    };
  }

  private async handleModel(args: string[], cmd: ChatCommand, chat: ChatAdapter): Promise<void> {
    const { worker } = this.deps;

    // Read-only: no args
    if (args.length === 0) {
      const info = worker.getModelInfo();
      const lines = [
        `Active model:  ${info.provider} / ${info.modelId}`,
        info.isOverride
          ? `Config default: ${info.configProvider} / ${info.configModelId}  (overridden)`
          : `Config default: ${info.configProvider} / ${info.configModelId}`,
        "",
        `Use \`model <provider> <model-id>\` to switch, or \`model reset\` to restore the default.`,
        `Use \`providers\` to list available providers.`,
      ];
      await chat.reply(cmd, { text: lines.join("\n") });
      return;
    }

    // Write: requires admin
    const actual = chat.getUserPermission?.(cmd.user.id) ?? "public";
    if (!meetsPermission(actual, "admin")) {
      await chat.reply(cmd, { text: "Sorry, changing the model is `admin`-only." });
      return;
    }

    const sub = args[0]?.toLowerCase();

    if (sub === "reset") {
      await worker.resetModel();
      const info = worker.getModelInfo();
      await chat.reply(cmd, { text: `Model reset to config default: ${info.provider} / ${info.modelId}` });
      return;
    }

    const provider = args[0] ?? "";
    const modelId  = args[1] ?? "";
    if (!provider || !modelId) {
      await chat.reply(cmd, { text: "Usage: `model <provider> <model-id>` or `model reset`\nExample: `model anthropic claude-opus-4-7`" });
      return;
    }

    await worker.setModel(provider, modelId);
    await chat.reply(cmd, { text: `Model switched to: ${provider} / ${modelId}` });
  }

  private async handleProviders(cmd: ChatCommand, chat: ChatAdapter): Promise<void> {
    const { worker } = this.deps;
    const providers = worker.getAvailableProviders();
    const info = worker.getModelInfo();
    const lines = [
      `Available providers (${providers.length}):`,
      ...providers.map(p => `  ${p === info.provider ? "* " : "  "}${p}`),
      "",
      `* = active provider  |  current model: ${info.provider} / ${info.modelId}`,
    ];
    await chat.reply(cmd, { text: lines.join("\n") });
  }

  private async handleDlqList(cmd: ChatCommand, chat: ChatAdapter): Promise<void> {
    const entries = this.deps.queue.listDlq(20);
    if (entries.length === 0) {
      await chat.reply(cmd, { text: "DLQ is empty." });
      return;
    }
    const lines = [`DLQ (${entries.length}):`];
    for (const e of entries) {
      const at = e.dlqAt ? e.dlqAt.toISOString().slice(0, 19).replace("T", " ") : "?";
      const err = e.error.length > 80 ? e.error.slice(0, 77) + "..." : e.error;
      lines.push(`  \`${e.id.slice(0, 8)}\` ${e.ref.owner}/${e.ref.repo}#${e.ref.number} (attempts ${e.attempts}, ${at}) - ${err}`);
    }
    lines.push("", "Use `requeue <job-id>` or `cancel <job-id>` (admin).");
    await chat.reply(cmd, { text: truncate(lines.join("\n"), 3000) });
  }

  private async handleRequeue(jobIdPrefix: string, cmd: ChatCommand, chat: ChatAdapter): Promise<void> {
    const match = this.resolveDlqJob(jobIdPrefix);
    if (!match.ok) { await chat.reply(cmd, { text: match.message }); return; }
    const ok = this.deps.queue.requeueFromDlq(match.id);
    if (!ok) {
      await chat.reply(cmd, { text: `Job \`${match.id.slice(0, 8)}\` is not in DLQ anymore.` });
      return;
    }
    this.deps.queue.audit(match.id, "requeued", `by ${cmd.user.id}`);
    await chat.reply(cmd, { text: `Requeued \`${match.id.slice(0, 8)}\`. It will be picked up shortly.` });
  }

  private async handleCancel(jobIdPrefix: string, cmd: ChatCommand, chat: ChatAdapter): Promise<void> {
    const match = this.resolveDlqJob(jobIdPrefix);
    if (!match.ok) { await chat.reply(cmd, { text: match.message }); return; }
    const ok = this.deps.queue.cancelDlq(match.id);
    if (!ok) {
      await chat.reply(cmd, { text: `Job \`${match.id.slice(0, 8)}\` is not in DLQ anymore.` });
      return;
    }
    this.deps.queue.audit(match.id, "cancelled", `by ${cmd.user.id}`);
    await chat.reply(cmd, { text: `Cancelled \`${match.id.slice(0, 8)}\`.` });
  }

  private resolveDlqJob(prefix: string): { ok: true; id: string } | { ok: false; message: string } {
    if (!prefix) return { ok: false, message: "Usage: `requeue <job-id>` or `cancel <job-id>` (8+ hex chars)" };
    const found = this.deps.queue.findByPrefix(prefix);
    if (!found) return { ok: false, message: `No unique match for \`${prefix}\`. Use 8+ hex chars from \`dlq\`.` };
    if (found.status !== "dlq") return { ok: false, message: `Job \`${found.id.slice(0, 8)}\` is not in DLQ (status: ${found.status}).` };
    return { ok: true, id: found.id };
  }

  private async handleHelp(cmd: ChatCommand, chat: ChatAdapter): Promise<void> {
    const text = [
      "Aegis commands:",
      "  help                       This message",
      "  status                     Queue depth and adapter state",
      "  repos                      Repositories tracked by Synopsis",
      "  model                      Show active model and config default",
      "  model <provider> <id>      Switch model  [admin]",
      "  model reset                Revert to config default  [admin]",
      "  providers                  List available LLM providers",
      "  review <pr-url>            Queue an ad-hoc review  [member]",
      "  rescan <repo>              Force Synopsis re-index  [member]",
      "  impact <symbol>            Blast radius for a .NET symbol",
      "  callers <symbol>           Who calls this symbol (depth 1)",
      "  paths <from> <to>          Dependency paths between symbols",
      "  endpoints [filter]         HTTP endpoints (optional filter)",
      "  db <entity|table>          EF entity / table lineage",
      "  ambiguous [repo]           Top ambiguous dependency edges",
      "  dlq                        List dead-letter queue entries  [member]",
      "  requeue <job-id>           Move a DLQ job back to pending  [admin]",
      "  cancel <job-id>            Permanently drop a DLQ job  [admin]",
      "  watch <repo>               Start monitoring a repo  [admin]",
      "  unwatch <repo>             Stop monitoring a repo   [admin]",
    ].join("\n");
    await chat.reply(cmd, { text });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parsePrUrl(url: string): PrRef | null {
  // GitHub: https://github.com/owner/repo/pull/123
  const gh = url.match(/^https?:\/\/(github\.com|[^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (gh) {
    return { host: gh[1]!, owner: gh[2]!, repo: gh[3]!, number: parseInt(gh[4]!, 10), headSha: "" };
  }
  // GitLab: https://gitlab.com/group/repo/-/merge_requests/123
  const gl = url.match(/^https?:\/\/(gitlab\.com|[^/]+)\/([^/]+)\/([^/]+)\/-\/merge_requests\/(\d+)/);
  if (gl) {
    return { host: gl[1]!, owner: gl[2]!, repo: gl[3]!, number: parseInt(gl[4]!, 10), headSha: "" };
  }
  return null;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "\n... (truncated)" : text;
}
