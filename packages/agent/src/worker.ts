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

  constructor(private readonly opts: WorkerOptions) {}

  private semaphoreFor(provider: string): Semaphore {
    let sem = this.semaphores.get(provider);
    if (!sem) {
      const cap = this.opts.config.providerLimits[provider]?.concurrency ?? this.opts.config.concurrency;
      sem = new Semaphore(cap);
      this.semaphores.set(provider, sem);
    }
    return sem;
  }

  async init(): Promise<void> {
    const { config, skillLoader, skillNames, soulPath, logger } = this.opts;

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
        this.active = buildActive(saved.provider, saved.modelId);
        logger.info(`[agent] restored saved model ${saved.provider}/${saved.modelId}`);
      } catch (err) {
        logger.warn(`[agent] saved model ${saved.provider}/${saved.modelId} is invalid (${(err as Error).message}), falling back to config default`);
      }
    }

    if (!this.active) {
      this.active = buildActive(config.provider, config.model);
    }

    logger.info(`[agent] initialised with ${skills.length} skills, model ${this.active.provider}/${this.active.modelId}`);
  }

  /** Switch the active model at runtime and persist the choice. */
  async setModel(provider: string, modelId: string): Promise<void> {
    const { logger, store } = this.opts;
    const next = buildActive(provider, modelId); // throws if unknown
    await store.set(MODEL_OVERRIDE_KEY, JSON.stringify({ provider, modelId }));
    this.active = next;
    logger.info(`[agent] model changed to ${provider}/${modelId}`);
  }

  /** Revert to the provider/model in aegis.config.js and clear the persisted override. */
  async resetModel(): Promise<void> {
    const { config, logger, store } = this.opts;
    const next = buildActive(config.provider, config.model);
    await store.delete(MODEL_OVERRIDE_KEY);
    this.active = next;
    logger.info(`[agent] model reset to config default ${config.provider}/${config.model}`);
  }

  /** Return the currently active model and whether it overrides the config default. */
  getModelInfo(): ModelInfo {
    const { provider: configProvider, model: configModelId } = this.opts.config;
    const a = this.active;
    return {
      provider: a.provider,
      modelId:  a.modelId,
      isOverride: a.provider !== configProvider || a.modelId !== configModelId,
      configProvider,
      configModelId,
    };
  }

  /** Return all provider names registered in Pi. */
  getAvailableProviders(): string[] {
    return getProviders();
  }

  async review(job: ReviewJob, diff: DiffBundle, repoPath: string): Promise<AegisReview> {
    const { config, mcp, logger } = this.opts;

    logger.info(`[agent] starting review for ${job.ref.owner}/${job.ref.repo}#${job.ref.number}`);

    await mcp.callTool("reindex_repository", { path: repoPath });

    const active = this.active;
    const release = await this.semaphoreFor(active.provider).acquire();
    try {
      const tools: AgentTool[] = [...mcp.getAgentTools(), ghCliTool()];

      const agent = new Agent({
        initialState: { systemPrompt: this.systemPrompt, model: active.model, tools },
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
    const tools: AgentTool[] = mcp.getAgentTools();

    const systemPrompt = [
      this.systemPrompt,
      "---",
      "Answer the user's question concisely using the available Synopsis tools.",
      "Prefer bullet points over JSON unless the user asks for raw data.",
      "If you cannot answer with the available tools, say so clearly.",
    ].join("\n\n");

    const active = this.active;
    const release = await this.semaphoreFor(active.provider).acquire();
    let timedOut = false;
    try {
      const agent = new Agent({ initialState: { systemPrompt, model: active.model, tools } });

      let finalMessages: AgentMessage[] = [];
      const unsubscribe = agent.subscribe(async (event) => {
        if (event.type === "agent_end") finalMessages = event.messages;
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
        logger.warn(`[agent] query timed out after ${timeoutMs}ms`);
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

function resolveModel(provider: string, modelId: string): Model<Api> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = getModel(provider as any, modelId as any) as Model<Api> | undefined;
  if (!model) {
    throw new Error(
      `Unknown model "${modelId}" for provider "${provider}". ` +
      `Check your aegis.config.js agent.provider and agent.model settings.`,
    );
  }
  return model;
}

function buildActive(provider: string, modelId: string): ActiveModel {
  return { provider, modelId, model: resolveModel(provider, modelId) };
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
