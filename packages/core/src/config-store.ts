import { watchFile, unwatchFile } from "node:fs";
import type { CodeHostSpec, ChatSpec, CodeHostAdapter, ChatAdapter } from "@aegis/sdk";
import {
  loadConfig,
  TIER3_TOP_LEVEL_FIELDS,
  type AegisConfig,
  type ChangeSet,
} from "./config.js";

export type ReloadTrigger = "file-watch" | "sighup" | "manual" | "startup";

export interface ReloadAttempt {
  trigger: ReloadTrigger;
  startedAt: Date;
  finishedAt: Date;
  outcome: ReloadOutcome;
}

export type ReloadOutcome =
  | { kind: "applied"; appliedFields: string[]; changedAdapters: string[] }
  | { kind: "no-changes" }
  | { kind: "tier3-refused"; reason: string; tier3Fields: string[]; tier3Adapters: Map<string, string[]> }
  | { kind: "validation-error"; error: string }
  | { kind: "load-error"; error: string };

export interface ReloadStatus {
  /** Most recent attempt (success or failure). null until the first reload. */
  lastAttempt: ReloadAttempt | null;
  /**
   * Tier 3 fields detected by the most recent reload that the operator must
   * resolve by restarting. Cleared on the first successful reload that no
   * longer reports them.
   */
  pendingTier3Fields: string[];
  pendingTier3Adapters: Map<string, string[]>;
}

export interface ConfigStoreOptions {
  /** Path to the config file on disk. Used for fs.watchFile and human-readable logs. */
  configPath: string;
  /** Loader the CLI provides. Must re-import the config from disk on every call (cache-busted). */
  loader: () => unknown;
  /** Initial validated config the store starts with. Skips loading on construct. */
  initial: AegisConfig;
  logger: { info(msg: string): void; warn(msg: string): void; error(msg: string, err?: unknown): void; debug?(msg: string): void };
  /** Debounce for file-watch events. Default 2500ms. K8s ConfigMap atomic swaps can fire twice. */
  debounceMs?: number;
  /** Optional callback for ops-channel notifications. Best-effort. */
  notifyOps?: (text: string) => Promise<void> | void;
}

type Listener = (change: ChangeSet, oldConfig: AegisConfig, newConfig: AegisConfig) => Promise<void>;

/**
 * Single source of truth for runtime config. Watches the config file, listens
 * for SIGHUP, and exposes manual reload. Computes a structured ChangeSet,
 * refuses Tier 3 changes, and notifies subscribers about Tier 1+2 changes
 * one at a time (serialized, never overlapping).
 */
export class ConfigStore {
  private current: AegisConfig;
  private readonly listeners: Listener[] = [];
  private debounceTimer: NodeJS.Timeout | null = null;
  private reloadChain: Promise<unknown> = Promise.resolve();
  private watching = false;
  private status: ReloadStatus = {
    lastAttempt: null,
    pendingTier3Fields: [],
    pendingTier3Adapters: new Map(),
  };
  private readonly debounceMs: number;
  private sighupHandler?: () => void;

  constructor(private readonly opts: ConfigStoreOptions) {
    this.current = opts.initial;
    this.debounceMs = opts.debounceMs ?? 2500;
  }

  get(): AegisConfig {
    return this.current;
  }

  getStatus(): ReloadStatus {
    return {
      lastAttempt: this.status.lastAttempt,
      pendingTier3Fields: [...this.status.pendingTier3Fields],
      pendingTier3Adapters: new Map(this.status.pendingTier3Adapters),
    };
  }

  /** Subscribe to Tier 1+2 reload events. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Start file-watch + SIGHUP listeners. Idempotent. */
  startWatching(): void {
    if (this.watching) return;
    this.watching = true;

    watchFile(this.opts.configPath, { interval: 2000 }, (curr, prev) => {
      if (curr.mtime.getTime() <= prev.mtime.getTime()) return;
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.opts.logger.info(`[config] file change detected on ${this.opts.configPath}, reloading`);
        void this.reload("file-watch");
      }, this.debounceMs);
    });

    this.sighupHandler = () => {
      this.opts.logger.info("[config] SIGHUP received, reloading");
      void this.reload("sighup");
    };
    process.on("SIGHUP", this.sighupHandler);

    this.opts.logger.info(`[config] watching ${this.opts.configPath} (debounce ${this.debounceMs}ms) and SIGHUP`);
  }

  stop(): void {
    if (!this.watching) return;
    this.watching = false;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    unwatchFile(this.opts.configPath);
    if (this.sighupHandler) process.off("SIGHUP", this.sighupHandler);
  }

  /**
   * Reload from disk, classify changes, and dispatch to subscribers.
   * Serialized: only one reload runs at a time. Failures keep the current config.
   */
  reload(trigger: ReloadTrigger): Promise<ReloadOutcome> {
    const next = this.reloadChain.then(() => this.runReload(trigger));
    this.reloadChain = next.catch(() => undefined);
    return next;
  }

  private async runReload(trigger: ReloadTrigger): Promise<ReloadOutcome> {
    const startedAt = new Date();
    const outcome = await this.attemptReload();
    const finishedAt = new Date();

    this.status.lastAttempt = { trigger, startedAt, finishedAt, outcome };

    if (outcome.kind === "applied" || outcome.kind === "no-changes") {
      this.status.pendingTier3Fields = [];
      this.status.pendingTier3Adapters.clear();
    } else if (outcome.kind === "tier3-refused") {
      this.status.pendingTier3Fields = outcome.tier3Fields;
      this.status.pendingTier3Adapters = outcome.tier3Adapters;
    }

    this.logOutcome(trigger, outcome);
    if (outcome.kind === "tier3-refused" || outcome.kind === "validation-error" || outcome.kind === "load-error") {
      await this.notifyOpsBestEffort(outcome);
    }
    return outcome;
  }

  private async attemptReload(): Promise<ReloadOutcome> {
    let raw: unknown;
    try {
      raw = this.opts.loader();
    } catch (err) {
      return { kind: "load-error", error: (err as Error).message };
    }

    let next: AegisConfig;
    try {
      next = loadConfig(raw) as AegisConfig;
    } catch (err) {
      return { kind: "validation-error", error: (err as Error).message };
    }

    const change = computeChangeSet(this.current, next);

    const hasTopTier3 = change.tier3Fields.length > 0;
    const hasAdapterTier3 = [...change.adapterTier3.values()].some(arr => arr.length > 0);
    if (hasTopTier3 || hasAdapterTier3) {
      const reasonParts: string[] = [];
      if (hasTopTier3) reasonParts.push(`top-level: ${change.tier3Fields.join(", ")}`);
      if (hasAdapterTier3) {
        const detail = [...change.adapterTier3.entries()]
          .filter(([, v]) => v.length > 0)
          .map(([id, keys]) => `${id}[${keys.join(",")}]`)
          .join(", ");
        reasonParts.push(`adapters: ${detail}`);
      }
      return {
        kind: "tier3-refused",
        reason: reasonParts.join("; "),
        tier3Fields: change.tier3Fields,
        tier3Adapters: change.adapterTier3,
      };
    }

    const hasAnyChange =
      change.agentChanged ||
      change.loggingChanged ||
      change.queueChanged ||
      change.skillsChanged ||
      change.codeHostSpecs.size > 0 ||
      change.chatSpecs.size > 0;

    if (!hasAnyChange) {
      return { kind: "no-changes" };
    }

    const oldConfig = this.current;
    this.current = next;

    const appliedFields: string[] = [];
    if (change.agentChanged) appliedFields.push("agent");
    if (change.loggingChanged) appliedFields.push("logging");
    if (change.queueChanged) appliedFields.push("queue");
    if (change.skillsChanged) appliedFields.push("skills");

    const changedAdapters: string[] = [];
    for (const id of change.codeHostSpecs.keys()) changedAdapters.push(`codeHost:${id}`);
    for (const id of change.chatSpecs.keys()) changedAdapters.push(`chat:${id}`);

    for (const listener of [...this.listeners]) {
      try {
        await listener(change, oldConfig, next);
      } catch (err) {
        this.opts.logger.error("[config] subscriber failed during reload", err);
      }
    }

    return { kind: "applied", appliedFields, changedAdapters };
  }

  private logOutcome(trigger: ReloadTrigger, outcome: ReloadOutcome): void {
    const label = `[config] reload (${trigger})`;
    switch (outcome.kind) {
      case "applied":
        this.opts.logger.info(`${label}: applied fields=[${outcome.appliedFields.join(",")}] adapters=[${outcome.changedAdapters.join(",")}]`);
        break;
      case "no-changes":
        this.opts.logger.info(`${label}: no changes`);
        break;
      case "tier3-refused":
        this.opts.logger.warn(`${label}: REFUSED, restart required - ${outcome.reason}`);
        break;
      case "validation-error":
        this.opts.logger.warn(`${label}: validation failed - ${outcome.error}`);
        break;
      case "load-error":
        this.opts.logger.warn(`${label}: load failed - ${outcome.error}`);
        break;
    }
  }

  private async notifyOpsBestEffort(outcome: ReloadOutcome): Promise<void> {
    if (!this.opts.notifyOps) return;
    let text: string;
    switch (outcome.kind) {
      case "tier3-refused":
        text = `Aegis config reload refused. Restart required to apply: ${outcome.reason}`;
        break;
      case "validation-error":
        text = `Aegis config validation failed, keeping previous config. ${outcome.error}`;
        break;
      case "load-error":
        text = `Aegis config load failed, keeping previous config. ${outcome.error}`;
        break;
      default:
        return;
    }
    try {
      await this.opts.notifyOps(text);
    } catch (err) {
      this.opts.logger.warn(`[config] ops notify failed: ${(err as Error).message}`);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Pure change classification. Exported for tests.
// ────────────────────────────────────────────────────────────────────────────

export function computeChangeSet(oldCfg: AegisConfig, newCfg: AegisConfig): ChangeSet {
  const tier3Fields: string[] = [];
  const adapterTier3 = new Map<string, string[]>();

  for (const field of TIER3_TOP_LEVEL_FIELDS) {
    if (!deepEqual(oldCfg[field], newCfg[field])) tier3Fields.push(field);
  }

  // Adapter add/remove is Tier 3. Adapter-internal changes are diffed via the
  // adapter's own diffSpec; we collect new specs here for the supervisor.
  const oldHostsById = new Map(oldCfg.codeHosts.map(a => [a.id, a]));
  const newHostsById = new Map(newCfg.codeHosts.map(a => [a.id, a]));
  for (const id of oldHostsById.keys()) {
    if (!newHostsById.has(id)) tier3Fields.push(`codeHost:${id}:removed`);
  }
  for (const id of newHostsById.keys()) {
    if (!oldHostsById.has(id)) tier3Fields.push(`codeHost:${id}:added`);
  }

  const oldChatsById = new Map(oldCfg.chats.map(a => [a.id, a]));
  const newChatsById = new Map(newCfg.chats.map(a => [a.id, a]));
  for (const id of oldChatsById.keys()) {
    if (!newChatsById.has(id)) tier3Fields.push(`chat:${id}:removed`);
  }
  for (const id of newChatsById.keys()) {
    if (!oldChatsById.has(id)) tier3Fields.push(`chat:${id}:added`);
  }

  // For matching ids: get the candidate spec from the new (throwaway) adapter
  // and ask the LIVE adapter to diff it against itself. This is where each
  // adapter's tier3SpecKeys take effect.
  const codeHostSpecs = new Map<string, CodeHostSpec>();
  for (const [id, oldAdapter] of oldHostsById) {
    const newAdapter = newHostsById.get(id);
    if (!newAdapter) continue;
    const newSpec = readSpec(newAdapter);
    const oldSpec = readSpec(oldAdapter);
    if (!newSpec || !oldSpec) continue;
    if (!deepEqual(oldSpec.data, newSpec.data) || oldSpec.type !== newSpec.type) {
      codeHostSpecs.set(id, newSpec);
      const t3 = adapterDiffTier3(oldAdapter, newSpec);
      if (t3.length > 0) adapterTier3.set(id, t3);
    }
  }

  const chatSpecs = new Map<string, ChatSpec>();
  for (const [id, oldAdapter] of oldChatsById) {
    const newAdapter = newChatsById.get(id);
    if (!newAdapter) continue;
    const newSpec = readSpec(newAdapter);
    const oldSpec = readSpec(oldAdapter);
    if (!newSpec || !oldSpec) continue;
    if (!deepEqual(oldSpec.data, newSpec.data) || oldSpec.type !== newSpec.type) {
      chatSpecs.set(id, newSpec as ChatSpec);
      const t3 = adapterDiffTier3(oldAdapter, newSpec as ChatSpec);
      if (t3.length > 0) adapterTier3.set(id, t3);
    }
  }

  return {
    tier3Fields,
    adapterTier3,
    agentChanged: !deepEqual(oldCfg.agent, newCfg.agent),
    loggingChanged: !deepEqual(oldCfg.logging, newCfg.logging),
    queueChanged: !deepEqual(oldCfg.queue, newCfg.queue),
    skillsChanged: !deepEqual(oldCfg.skills, newCfg.skills),
    codeHostSpecs,
    chatSpecs,
  };
}

interface SpecAware {
  getSpec?(): { type: string; id: string; data: Record<string, unknown> };
  diffSpec?(next: { type: string; id: string; data: Record<string, unknown> }): { tier1: string[]; tier3: string[] };
}

function readSpec(adapter: CodeHostAdapter | ChatAdapter): { type: string; id: string; data: Record<string, unknown> } | null {
  const aware = adapter as unknown as SpecAware;
  if (typeof aware.getSpec === "function") return aware.getSpec();
  return null;
}

function adapterDiffTier3(
  liveAdapter: CodeHostAdapter | ChatAdapter,
  newSpec: { type: string; id: string; data: Record<string, unknown> },
): string[] {
  const aware = liveAdapter as unknown as SpecAware;
  if (typeof aware.diffSpec !== "function") return [];
  return aware.diffSpec(newSpec).tier3;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as object).sort();
    const bk = Object.keys(b as object).sort();
    if (ak.length !== bk.length) return false;
    for (let i = 0; i < ak.length; i++) {
      if (ak[i] !== bk[i]) return false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!deepEqual((a as any)[ak[i] as string], (b as any)[bk[i] as string])) return false;
    }
    return true;
  }
  return false;
}
