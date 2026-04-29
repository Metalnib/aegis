import { z } from "zod";
import type { CodeHostAdapter, ChatAdapter, CodeHostSpec, ChatSpec } from "@aegis/sdk";

export const SynopsisConfigSchema = z.object({
  transport: z.enum(["unix", "tcp"]),
  path: z.string().optional(),
  host: z.string().optional(),
  port: z.number().optional(),
});

/**
 * One OpenAI-compatible custom provider. Multiple are configured via the
 * `customProviders` map keyed by name. The map key is the provider name
 * referenced from `agent.provider` and from chat (`/model <provider> <id>`).
 */
export const CustomProviderSchema = z.object({
  baseUrl: z.string().url(),
  /** Env var holding the API key. The `_FILE` indirection (KEY_FILE) works too via EnvSecrets. */
  apiKeyEnv: z.string().optional(),
  /**
   * Pi `Api` type. Defaults to "openai-completions" because that's what 99%
   * of self-hosted and OpenAI-clone endpoints implement. Other valid values
   * cover Anthropic-compatible endpoints (Bedrock proxies, etc.).
   */
  api: z.enum([
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "mistral-conversations",
    "google-generative-ai",
  ]).default("openai-completions"),
  /** Model capability flags. Affect which features the agent will exercise. */
  reasoning: z.boolean().default(false),
  vision: z.boolean().default(false),
  contextWindow: z.number().int().min(1024).default(131072),
  maxTokens: z.number().int().min(256).default(32768),
});

export const AgentConfigSchema = z.object({
  provider: z.string().default("anthropic"),
  model: z.string().default("claude-opus-4-7"),
  concurrency: z.number().int().min(1).max(16).default(4),
  jobTimeoutSec: z.number().int().min(30).max(3600).default(600),
  /**
   * Per-LLM-provider concurrency cap. Default for unlisted providers is the
   * global `concurrency`. Lower a provider here when its API has stricter
   * limits than the global worker pool can absorb.
   */
  providerLimits: z.record(z.string(), z.object({
    concurrency: z.number().int().min(1).max(64),
  })).default({}),
  /**
   * Custom providers keyed by name. Use the key as `agent.provider` to make
   * it the default, or switch via chat (`/model <name> <model-id>`).
   * Anything not in this map falls through to Pi's built-in registry.
   */
  customProviders: z.record(z.string(), CustomProviderSchema).default({}),
});

export const QueueConfigSchema = z.object({
  retries: z.number().int().min(0).max(10).default(3),
  backoff: z.enum(["exponential", "linear"]).default("exponential"),
  dlqChannel: z.string().optional(),
});

export const LoggingConfigSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  format: z.enum(["json", "text"]).default("json"),
});

export const HttpConfigSchema = z.object({
  port: z.number().int().min(1).max(65535),
  bindAddr: z.string().default("0.0.0.0"),
  /** Env var holding a bearer token required for GET /metrics. Omit for no auth. */
  metricsTokenEnv: z.string().optional(),
});

export const AegisConfigSchema = z.object({
  workspace: z.string().default("/workspace"),
  dbPath: z.string().default("/var/lib/aegis/aegis.db"),
  synopsis: SynopsisConfigSchema,
  agent: AgentConfigSchema,
  codeHosts: z.array(z.any()).min(1),
  chats: z.array(z.any()).default([]),
  skills: z.array(z.string()).default([]),
  skillsDir: z.string().default("/opt/aegis/skills"),
  soulPath: z.string().default("/opt/aegis/SOUL.md"),
  queue: QueueConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
  http: HttpConfigSchema.optional(),
});

export type SynopsisConfig = z.infer<typeof SynopsisConfigSchema>;
export type CustomProvider = z.infer<typeof CustomProviderSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type QueueConfig = z.infer<typeof QueueConfigSchema>;
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;
export type HttpConfig = z.infer<typeof HttpConfigSchema>;
export type AegisConfig = z.infer<typeof AegisConfigSchema> & {
  codeHosts: CodeHostAdapter[];
  chats: ChatAdapter[];
};

export interface CodeHostConfig {
  adapter: CodeHostAdapter;
}

export interface ChatConfig {
  adapter: ChatAdapter;
}

export function defineConfig(cfg: Partial<AegisConfig> & { synopsis: SynopsisConfig; codeHosts: CodeHostAdapter[] }): typeof cfg {
  return cfg;
}

export function loadConfig(cfg: unknown): AegisConfig {
  return AegisConfigSchema.parse(cfg) as AegisConfig;
}

// ────────────────────────────────────────────────────────────────────────────
// Hot-reload change classification
// ────────────────────────────────────────────────────────────────────────────

/**
 * What's different between two AegisConfig snapshots, classified by reload tier.
 * Tier 1+2 changes are applied to live components. Tier 3 changes refuse the
 * reload and require a process restart.
 *
 * "Tier 3" entries here are top-level fields. Per-adapter Tier 3 changes are
 * detected by each adapter's `diffSpec` and aggregated into `adapterTier3`.
 */
export interface ChangeSet {
  /** Top-level Tier 3 fields that differ. */
  tier3Fields: string[];
  /** Adapter id -> tier-3 spec keys that differ. Non-empty entries refuse reload. */
  adapterTier3: Map<string, string[]>;

  // Tier 1+2 fields. Subscribers consult these flags + diff specs.
  agentChanged: boolean;
  loggingChanged: boolean;
  queueChanged: boolean;
  skillsChanged: boolean;
  /** id -> new spec. Subscribers call applySpec(newSpec) on the matching live adapter. */
  codeHostSpecs: Map<string, CodeHostSpec>;
  chatSpecs: Map<string, ChatSpec>;
}

/**
 * Top-level fields that require a restart to change. Adapter-specific Tier 3
 * keys are declared per-adapter in `tier3SpecKeys`.
 */
export const TIER3_TOP_LEVEL_FIELDS = [
  "workspace",
  "dbPath",
  "synopsis",
  "http",
  "skillsDir",
  "soulPath",
] as const;
