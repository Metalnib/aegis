import { z } from "zod";
import type { CodeHostAdapter } from "@aegis/sdk";
import type { ChatAdapter } from "@aegis/sdk";

export const SynopsisConfigSchema = z.object({
  transport: z.enum(["unix", "tcp"]),
  path: z.string().optional(),
  host: z.string().optional(),
  port: z.number().optional(),
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
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type QueueConfig = z.infer<typeof QueueConfigSchema>;
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
