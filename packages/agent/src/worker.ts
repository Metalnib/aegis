import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentTool, AgentMessage } from "@mariozechner/pi-agent-core";
import { getModel, type Model, type Api } from "@mariozechner/pi-ai";
import type { AssistantMessage, TextContent, TSchema } from "@mariozechner/pi-ai";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getProviders } from "@mariozechner/pi-ai";
import type { AegisReview, ReviewJob, DiffBundle, Severity, Logger, KvStore } from "@aegis/sdk";
import { Semaphore, type AgentConfig } from "@aegis/core";
import type { SkillLoader } from "./skill-loader.js";
import type { SynopsisMcpClient } from "./synopsis-mcp.js";

const execFileAsync = promisify(execFile);

// `api` is intentionally excluded - it allows arbitrary HTTP including writes.
// `repo clone` could write to disk; we accept it because the surface is narrow
// and the agent's cwd is the worker process, not user-sensitive paths.
const GH_ALLOWED_SUBCOMMANDS = new Set(["pr", "issue", "repo", "release"]);
const GH_FORBIDDEN_FLAGS = ["--exec", "--editor", "--web"];

function hasForbiddenFlag(argv: string[]): string | null {
  for (const flag of GH_FORBIDDEN_FLAGS) {
    for (const a of argv) {
      if (a === flag || a.startsWith(flag + "=")) return flag;
    }
  }
  return null;
}

export interface WorkerOptions {
  config: AgentConfig;
  skillLoader: SkillLoader;
  skillNames: string[];
  soulPath: string;
  mcp: SynopsisMcpClient;
  logger: Logger;
  store: KvStore;
}

export interface ModelInfo {
  provider: string;
  modelId: string;
  /** True when the active model differs from the config default. */
  isOverride: boolean;
  configProvider: string;
  configModelId: string;
}

interface ActiveModel {
  provider: string;
  modelId: string;
  model: Model<Api>;
}

const MODEL_OVERRIDE_KEY = "model:override";

export class AgentWorker {
  private systemPrompt = "";
  /**
   * Active model bundled into a single object so reads see a consistent
   * (provider, modelId, model) triple even if a concurrent setModel is racing.
   */
  private active!: ActiveModel;
  /** Per-provider concurrency caps. Lazily allocated on first use. */
  private readonly semaphores = new Map<string, Semaphore>();
  /**
   * Live agent config. Mutable so applyConfig() can swap it on hot reload.
   * Reads take a local snapshot to avoid mid-job changes.
   */
  private currentConfig: AgentConfig;

  constructor(private readonly opts: WorkerOptions) {
    this.currentConfig = opts.config;
  }

  private semaphoreFor(provider: string): Semaphore {
    let sem = this.semaphores.get(provider);
    if (!sem) {
      const cap = this.currentConfig.providerLimits[provider]?.concurrency ?? this.currentConfig.concurrency;
      sem = new Semaphore(cap);
      this.semaphores.set(provider, sem);
    }
    return sem;
  }

  /**
   * Apply a hot-reloaded agent config to this worker. Returns a list of
   * fields actually applied, plus an optional notice if a saved model
   * override targeted a customProvider that was just removed.
   */
  async applyConfig(next: AgentConfig): Promise<{
    applied: string[];
    droppedOverride: { provider: string; modelId: string; reason: string } | null;
  }> {
    const applied: string[] = [];
    const old = this.currentConfig;

    // Compute everything that can throw BEFORE mutating any state. If the
    // fallback model fails to build, we throw cleanly without leaving the
    // worker in a half-applied state (currentConfig new, active stale).
    let pendingActive = this.active;
    let droppedOverride: { provider: string; modelId: string; reason: string } | null = null;
    const activeIsCustom = !!old.customProviders[this.active.provider];
    const stillExists = !!next.customProviders[this.active.provider];
    if (activeIsCustom && !stillExists) {
      droppedOverride = {
        provider: this.active.provider,
        modelId: this.active.modelId,
        reason: `customProvider "${this.active.provider}" was removed from config`,
      };
      try {
        pendingActive = buildActive(next.provider, next.model, next);
      } catch (err) {
        // Re-throw rather than swallow. The subscriber's error handler will
        // log this and the previous config keeps running. Without this we'd
        // mutate currentConfig but leave `active` pointing at a removed
        // provider, and subsequent jobs would fail opaquely.
        throw new Error(
          `[agent] config reload aborted: cannot revert override ` +
          `${this.active.provider}/${this.active.modelId} to default ` +
          `${next.provider}/${next.model}: ${(err as Error).message}`,
        );
      }
    }

    // Commit phase: state mutations only after every fallible step succeeded.
    this.currentConfig = next;

    if (droppedOverride) {
      await this.opts.store.delete(MODEL_OVERRIDE_KEY);
      this.active = pendingActive;
      this.opts.logger.warn(`[agent] dropped saved override ${droppedOverride.provider}/${droppedOverride.modelId}, reverted to ${next.provider}/${next.model}`);
      applied.push("activeModel");
    }

    if (old.providerLimits !== next.providerLimits || old.concurrency !== next.concurrency) {
      // Drop existing semaphores so the next acquire rebuilds them with new caps.
      // In-flight jobs hold the old permit until release. Capacity contraction can
      // over-subscribe briefly but never wedges because release() does not check the cap.
      this.semaphores.clear();
      applied.push("concurrency", "providerLimits");
    }

    if (old.jobTimeoutSec !== next.jobTimeoutSec) applied.push("jobTimeoutSec");
    if (old.provider !== next.provider || old.model !== next.model) applied.push("defaultModel");

    return { applied, droppedOverride };
  }

  /**
   * Reload skills + soul from disk. Called when the `skills` config field
   * changes during hot reload. Active jobs keep using the prompt they
   * started with; new jobs pick up the rebuilt prompt.
   */
  async reloadSkills(skillNames: string[]): Promise<void> {
    const { skillLoader, soulPath, logger } = this.opts;
    let soul = "";
    try { soul = await readFile(soulPath, "utf-8"); } catch { /* tolerated */ }
    const skills = await skillLoader.load(skillNames);
    const skillBlock = skills.map(s => `## Skill: ${s.name}\n\n${s.content}`).join("\n\n---\n\n");
    this.systemPrompt = [soul, "---", "## Loaded skills", skillBlock].filter(Boolean).join("\n\n");
    logger.info(`[agent] skills reloaded (${skills.length} loaded)`);
  }

  async init(): Promise<void> {
    const { skillLoader, skillNames, soulPath, logger } = this.opts;
    const config = this.currentConfig;

    let soul = "";
    try {
      soul = await readFile(soulPath, "utf-8");
    } catch {
      logger.warn(`[agent] SOUL.md not found at ${soulPath}, proceeding without`);
    }

    const skills = await skillLoader.load(skillNames);
    const skillBlock = skills.map(s => `## Skill: ${s.name}\n\n${s.content}`).join("\n\n---\n\n");

    this.systemPrompt = [soul, "---", "## Loaded skills", skillBlock]
      .filter(Boolean)
      .join("\n\n");

    const saved = await loadSavedOverride(this.opts.store);
    if (saved) {
      try {
        this.active = buildActive(saved.provider, saved.modelId, config);
        logger.info(`[agent] restored saved model ${saved.provider}/${saved.modelId}`);
      } catch (err) {
        logger.warn(`[agent] saved model ${saved.provider}/${saved.modelId} is invalid (${(err as Error).message}), falling back to config default`);
      }
    }

    if (!this.active) {
      this.active = buildActive(config.provider, config.model, config);
    }

    logger.info(`[agent] initialised with ${skills.length} skills, model ${this.active.provider}/${this.active.modelId}`);
  }

  /** Switch the active model at runtime and persist the choice. */
  async setModel(provider: string, modelId: string): Promise<void> {
    const { logger, store } = this.opts;
    const next = buildActive(provider, modelId, this.currentConfig); // throws if unknown
    await store.set(MODEL_OVERRIDE_KEY, JSON.stringify({ provider, modelId }));
    this.active = next;
    logger.info(`[agent] model changed to ${provider}/${modelId}`);
  }

  /** Revert to the provider/model in aegis.config.js and clear the persisted override. */
  async resetModel(): Promise<void> {
    const { logger, store } = this.opts;
    const config = this.currentConfig;
    const next = buildActive(config.provider, config.model, config);
    await store.delete(MODEL_OVERRIDE_KEY);
    this.active = next;
    logger.info(`[agent] model reset to config default ${config.provider}/${config.model}`);
  }

  /** Return the currently active model and whether it overrides the config default. */
  getModelInfo(): ModelInfo {
    const { provider: configProvider, model: configModelId } = this.currentConfig;
    const a = this.active;
    return {
      provider: a.provider,
      modelId:  a.modelId,
      isOverride: a.provider !== configProvider || a.modelId !== configModelId,
      configProvider,
      configModelId,
    };
  }

  /** Return all provider names available - built-in (Pi) plus configured custom providers. */
  getAvailableProviders(): { name: string; kind: "builtin" | "custom" }[] {
    const builtin = getProviders().map(name => ({ name, kind: "builtin" as const }));
    const custom = Object.keys(this.currentConfig.customProviders).map(name => ({ name, kind: "custom" as const }));
    return [...custom, ...builtin].sort((a, b) => a.name.localeCompare(b.name));
  }

  async review(job: ReviewJob, diff: DiffBundle, repoPath: string): Promise<AegisReview> {
    const { mcp, logger } = this.opts;
    const config = this.currentConfig;

    logger.info(`[agent] starting review for ${job.ref.owner}/${job.ref.repo}#${job.ref.number}`);

    await mcp.callTool("reindex_repository", { path: repoPath });

    const active = this.active;
    const release = await this.semaphoreFor(active.provider).acquire();
    try {
      const tools: AgentTool[] = [...mcp.getAgentTools(), ghCliTool()];

      const getApiKey = makeGetApiKey(config);
      const agent = new Agent({
        initialState: { systemPrompt: this.systemPrompt, model: active.model, tools },
        ...(getApiKey ? { getApiKey } : {}),
      });

      let finalMessages: AgentMessage[] = [];
      const unsubscribe = agent.subscribe(async (event) => {
        if (event.type === "agent_end") finalMessages = event.messages;
      });

      const timeoutId = setTimeout(() => agent.abort(), config.jobTimeoutSec * 1000);

      try {
        await agent.prompt(buildUserMessage(job, diff));
        await agent.waitForIdle();
      } finally {
        clearTimeout(timeoutId);
        unsubscribe();
      }

      const text = extractFinalText(finalMessages);
      logger.info("[agent] review done");
      return parseReview(text);
    } finally {
      release();
    }
  }

  /**
   * Run a one-shot interactive query using the Synopsis MCP tools.
   * Used by the chat command router for impact, paths, endpoints, etc.
   */
  async query(question: string, timeoutMs = 180_000): Promise<string> {
    const { mcp, logger } = this.opts;
    const config = this.currentConfig;
    const tools: AgentTool[] = mcp.getAgentTools();

    const systemPrompt = [
      this.systemPrompt,
      "---",
      "Answer the user's question concisely using the available Synopsis tools.",
      "Prefer bullet points over JSON unless the user asks for raw data.",
      "If you cannot answer with the available tools, say so clearly.",
    ].join("\n\n");

    const active = this.active;
    logger.info(`[agent] query starting on ${active.provider}/${active.modelId}, ${tools.length} tools available`);
    logger.debug(`[agent] question: ${question.slice(0, 200)}${question.length > 200 ? "..." : ""}`);

    const release = await this.semaphoreFor(active.provider).acquire();
    let timedOut = false;
    try {
      const getApiKey = makeGetApiKey(config);
      // Debug: peek at the outbound API payload so we can see what tools are
      // actually being sent. Required because Vultr / custom providers
      // sometimes ignore the `tools` field silently and the LLM hallucinates
      // an answer with zero tool calls.
      const onPayload = (payload: unknown): unknown | undefined => {
        const p = payload as { tools?: unknown[]; messages?: unknown[]; model?: string };
        const toolNames = Array.isArray(p.tools)
          ? p.tools.map((t) => (t as { function?: { name?: string }; name?: string }).function?.name ?? (t as { name?: string }).name).join(",")
          : "(none)";
        const msgCount = Array.isArray(p.messages) ? p.messages.length : 0;
        logger.info(`[agent] -> ${p.model}: ${msgCount} msgs, tools=[${toolNames}]`);
        return undefined;
      };
      const agent = new Agent({
        initialState: { systemPrompt, model: active.model, tools },
        onPayload,
        ...(getApiKey ? { getApiKey } : {}),
      });

      let finalMessages: AgentMessage[] = [];
      let toolCallCount = 0;
      const unsubscribe = agent.subscribe(async (event) => {
        // Pi Agent emits tool_execution_* events from its Agent class (not the
        // lower-level toolcall_* events from the streaming proxy). The
        // execution variants fire after the LLM emits a tool_call AND the
        // Agent dispatches it to the tool handler.
        const e = event as { type: string; toolCall?: { name?: string }; toolName?: string; message?: { content?: Array<{ type: string; name?: string }>; usage?: { totalTokens?: number } } };
        if (e.type === "tool_execution_start") {
          toolCallCount++;
          const name = e.toolName ?? e.toolCall?.name ?? "unknown";
          logger.info(`[agent] tool #${toolCallCount}: ${name}`);
        } else if (e.type === "agent_end") {
          finalMessages = (event as unknown as { messages: AgentMessage[] }).messages;
          const usage = e.message?.usage?.totalTokens;
          logger.info(`[agent] query complete (${toolCallCount} tool calls${usage ? `, ${usage} tokens` : ""})`);
        } else if (e.type === "error") {
          logger.error(`[agent] error event during query: ${JSON.stringify(event).slice(0, 300)}`);
        } else if (e.type === "turn_end") {
          logger.debug(`[agent] turn_end`);
        }
      });

      const timeoutId = setTimeout(() => { timedOut = true; agent.abort(); }, timeoutMs);
      try {
        await agent.prompt(question);
        await agent.waitForIdle();
      } finally {
        clearTimeout(timeoutId);
        unsubscribe();
      }

      if (timedOut) {
        logger.warn(`[agent] query timed out after ${timeoutMs}ms (${toolCallCount} tool calls before abort)`);
        throw new QueryTimeoutError(timeoutMs);
      }

      const text = extractFinalText(finalMessages);
      logger.debug("[agent] query done");
      return text || "No response.";
    } finally {
      release();
    }
  }
}

export class QueryTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Query timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "QueryTimeoutError";
  }
}

function resolveModel(provider: string, modelId: string, cfg: AgentConfig): Model<Api> {
  const custom = cfg.customProviders[provider];
  if (custom) {
    const inputs: ("text" | "image")[] = custom.vision ? ["text", "image"] : ["text"];
    return {
      id: modelId,
      name: modelId,
      api: custom.api as Api,
      provider,
      baseUrl: custom.baseUrl,
      reasoning: custom.reasoning,
      input: inputs,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: custom.contextWindow,
      maxTokens: custom.maxTokens,
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = getModel(provider as any, modelId as any) as Model<Api> | undefined;
  if (!model) {
    const known = Object.keys(cfg.customProviders).concat(getProviders());
    throw new Error(
      `Unknown model "${modelId}" for provider "${provider}". ` +
      `Configured providers: ${known.sort().join(", ")}.`,
    );
  }
  return model;
}

function buildActive(provider: string, modelId: string, cfg: AgentConfig): ActiveModel {
  return { provider, modelId, model: resolveModel(provider, modelId, cfg) };
}

function makeGetApiKey(cfg: AgentConfig): ((provider: string) => string | undefined) | undefined {
  if (Object.keys(cfg.customProviders).length === 0) return undefined;
  return (provider: string) => {
    const custom = cfg.customProviders[provider];
    if (custom?.apiKeyEnv) return process.env[custom.apiKeyEnv];
    return undefined;
  };
}

async function loadSavedOverride(store: KvStore): Promise<{ provider: string; modelId: string } | null> {
  const raw = await store.get(MODEL_OVERRIDE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { provider?: unknown; modelId?: unknown };
    if (typeof parsed.provider === "string" && typeof parsed.modelId === "string") {
      return { provider: parsed.provider, modelId: parsed.modelId };
    }
  } catch {
    // fall through
  }
  return null;
}

function ghCliTool(): AgentTool {
  return {
    name: "gh_cli",
    label: "gh CLI",
    description:
      "Run a read-only gh (GitHub CLI) command. Allowed subcommands: pr, issue, repo, release. " +
      "Use for: pr view, pr list, issue view, pr diff, etc. Use --flag=value form for flags with values.",
    parameters: {
      type: "object",
      properties: {
        args: {
          type: "string",
          description: "Arguments to gh, e.g. 'pr view 42 --json title,body'",
        },
      },
      required: ["args"],
    } as unknown as TSchema,
    execute: async (_id, params: unknown) => {
      const { args } = params as { args: string };
      const argv = tokenizeShellArgs(args);
      if (argv.length === 0) {
        throw new Error("gh_cli: empty args");
      }
      const sub = argv[0]!;
      if (!GH_ALLOWED_SUBCOMMANDS.has(sub)) {
        throw new Error(`gh_cli: subcommand "${sub}" not allowed. Allowed: ${[...GH_ALLOWED_SUBCOMMANDS].join(", ")}`);
      }
      const forbidden = hasForbiddenFlag(argv);
      if (forbidden) {
        throw new Error(`gh_cli: flag "${forbidden}" is not allowed`);
      }
      const { stdout, stderr } = await execFileAsync("gh", argv, { timeout: 30_000 });
      return {
        content: [{ type: "text" as const, text: stdout || stderr }],
        details: { stdout, stderr },
      };
    },
  };
}

/** Split a command-line string into argv, honoring single and double quotes. No shell metacharacter expansion. */
function tokenizeShellArgs(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let inToken = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      cur += ch;
      inToken = true;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; inToken = true; continue; }
    if (/\s/.test(ch)) {
      if (inToken) { out.push(cur); cur = ""; inToken = false; }
      continue;
    }
    cur += ch;
    inToken = true;
  }
  if (quote) throw new Error("gh_cli: unterminated quote in args");
  if (inToken) out.push(cur);
  return out;
}

function buildUserMessage(job: ReviewJob, diff: DiffBundle): string {
  const fileList = diff.files.map(f => `- ${f.status}: ${f.path}`).join("\n");
  const patches = diff.files
    .filter(f => f.patch)
    .map(f => `\n### ${f.path}\n\`\`\`diff\n${f.patch}\n\`\`\``)
    .join("\n");

  return [
    `Review PR #${job.ref.number} in ${job.ref.owner}/${job.ref.repo}.`,
    `Base: ${diff.baseSha.slice(0, 8)}  Head: ${diff.headSha.slice(0, 8)}`,
    `\nChanged files (${diff.files.length}):`,
    fileList,
    patches,
    "\nProduce a structured review. End your response with a JSON block wrapped in ```json ... ``` containing:",
    "severity (Critical/High/Medium/Low/Unknown), summary (string), findings (array of {severity, category, summary}), prComments (array of {path, line, body}).",
  ].join("\n");
}

function extractFinalText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && "role" in m && m.role === "assistant") {
      const am = m as AssistantMessage;
      return am.content
        .filter((b): b is TextContent => b.type === "text")
        .map(b => b.text)
        .join("\n");
    }
  }
  return "";
}

function parseReview(text: string): AegisReview {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  if (match?.[1]) {
    try {
      const parsed = JSON.parse(match[1]) as Partial<AegisReview>;
      return {
        severity: (parsed.severity as Severity) ?? "Unknown",
        summary: parsed.summary ?? "",
        findings: parsed.findings ?? [],
        prComments: parsed.prComments ?? [],
        markdownReport: text,
      };
    } catch {
      // fall through
    }
  }

  const severityMatch = text.match(/\b(Critical|High|Medium|Low)\b/);
  return {
    severity: (severityMatch?.[1] as Severity) ?? "Unknown",
    summary: text.slice(0, 500),
    findings: [],
    prComments: [],
    markdownReport: text,
  };
}
