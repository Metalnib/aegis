/**
 * Abstract base classes for code-host and chat adapters. They standardize the
 * config-reload contract (`getSpec` / `diffSpec` / `applySpec`) so the
 * supervisor can detect Tier 1+2 changes and apply them to live instances
 * without restarting the process.
 *
 * Subclasses declare which spec keys are Tier 3 (restart-required); the base
 * class supplies the diff algorithm. Subclasses implement `applySpec` to
 * absorb Tier 1+2 changes into running state.
 */

import type { CodeHostAdapter, RepoEntry, WebhookEndpoint, CloneSpec } from "./code-host.js";
import type { ChatAdapter } from "./chat.js";
import type { AdapterContext } from "./context.js";
import type { PrRef, PrEvent, DiffBundle, PrInfo, PrSearchQuery, AegisReview } from "./types.js";

/**
 * Declared shape of a code-host adapter, as it appears in `aegis.config.ts`.
 * The `id` is stable across reloads and identifies the running instance.
 * Adapter-specific fields live in `data`; the base class diffs `data` keys.
 */
export interface CodeHostSpec {
  type: string;          // "github" | "gitlab" | ...
  id: string;
  data: Record<string, unknown>;
}

export interface ChatSpec {
  type: string;          // "slack" | "gchat" | ...
  id: string;
  data: Record<string, unknown>;
}

/**
 * Result of comparing the running adapter's spec to a candidate new spec.
 * `tier1` lists keys safe to apply hot. `tier3` lists keys that require a
 * restart. The supervisor refuses the whole reload if any adapter reports
 * `tier3` entries.
 */
export interface SpecDiff {
  tier1: string[];
  tier3: string[];
}

export interface SpecApplyOutcome {
  /** Keys that were successfully applied. */
  applied: string[];
  /** Keys that could not be applied (e.g. live validation rejected them). */
  failed: Array<{ key: string; reason: string }>;
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

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
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao).filter(k => !FORBIDDEN_KEYS.has(k)).sort();
    const bk = Object.keys(bo).filter(k => !FORBIDDEN_KEYS.has(k)).sort();
    if (ak.length !== bk.length) return false;
    for (let i = 0; i < ak.length; i++) {
      const key = ak[i] as string;
      if (key !== bk[i]) return false;
      if (!Object.prototype.hasOwnProperty.call(ao, key)) return false;
      if (!Object.prototype.hasOwnProperty.call(bo, key)) return false;
      if (!deepEqual(ao[key], bo[key])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Common diff algorithm shared by both adapter base classes. Compares the
 * `data` maps of two specs and classifies each changed key as Tier 1 or
 * Tier 3 based on the subclass-declared set.
 */
export function diffSpecData(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
  tier3Keys: ReadonlySet<string>,
): SpecDiff {
  const tier1: string[] = [];
  const tier3: string[] = [];
  const allKeys = new Set([...Object.keys(current), ...Object.keys(next)]);
  for (const key of allKeys) {
    if (deepEqual(current[key], next[key])) continue;
    if (tier3Keys.has(key)) tier3.push(key);
    else tier1.push(key);
  }
  tier1.sort();
  tier3.sort();
  return { tier1, tier3 };
}

/**
 * Base class for code-host adapters. Subclasses must:
 *   1. Set `id` in their constructor.
 *   2. Implement `getSpec()` returning the current declared shape.
 *   3. Declare `tier3SpecKeys` (e.g. host, org, tokenEnv).
 *   4. Implement `applySpec(next)` to absorb Tier 1+2 changes.
 *   5. Implement the rest of the CodeHostAdapter surface as before.
 */
export abstract class CodeHostAdapterBase implements CodeHostAdapter {
  abstract readonly id: string;
  protected abstract readonly tier3SpecKeys: ReadonlySet<string>;

  abstract init(ctx: AdapterContext): Promise<void>;
  abstract dispose(): Promise<void>;

  abstract pollPullRequests(since?: Date): AsyncIterable<PrEvent>;
  abstract fetchPr(ref: PrRef): Promise<PrInfo>;
  abstract fetchDiff(ref: PrRef): Promise<DiffBundle>;
  abstract searchOpenPrs(query: PrSearchQuery): Promise<PrRef[]>;
  abstract postReview(ref: PrRef, review: AegisReview): Promise<void>;
  abstract postInlineReport(ref: PrRef, name: string, markdown: string): Promise<void>;
  abstract getCloneSpec(ref: PrRef): CloneSpec;

  webhook?: WebhookEndpoint;
  subscribe?(handler: (e: PrEvent) => void): Disposable;
  listRepos?(): RepoEntry[];
  addRepo?(name: string): Promise<void>;
  removeRepo?(name: string): Promise<void>;

  /** Snapshot of declared config, in the same shape the supervisor diffs against. */
  abstract getSpec(): CodeHostSpec;

  /** Default diff implementation: compares `data` maps and classifies by `tier3SpecKeys`. */
  diffSpec(next: CodeHostSpec): SpecDiff {
    if (next.id !== this.id || next.type !== this.getSpec().type) {
      return { tier1: [], tier3: ["id-or-type-changed"] };
    }
    return diffSpecData(this.getSpec().data, next.data, this.tier3SpecKeys);
  }

  /**
   * Apply a Tier 1+2 spec change to this live adapter. Caller must have
   * verified `diffSpec(next).tier3` is empty before calling.
   */
  abstract applySpec(next: CodeHostSpec): Promise<SpecApplyOutcome>;
}

/**
 * Base class for chat adapters. Same contract as CodeHostAdapterBase.
 */
export abstract class ChatAdapterBase implements ChatAdapter {
  abstract readonly id: string;
  protected abstract readonly tier3SpecKeys: ReadonlySet<string>;

  abstract init(ctx: AdapterContext): Promise<void>;
  abstract dispose(): Promise<void>;
  abstract onCommand(handler: (c: import("./chat.js").ChatCommand) => void): Disposable;
  abstract reply(cmd: import("./chat.js").ChatCommand, body: import("./chat.js").ChatBody): Promise<void>;
  abstract notify(channel: import("./chat.js").ChannelRef, body: import("./chat.js").ChatBody): Promise<void>;
  getUserPermission?(userId: string): import("./chat.js").CommandPermission;

  abstract getSpec(): ChatSpec;

  diffSpec(next: ChatSpec): SpecDiff {
    if (next.id !== this.id || next.type !== this.getSpec().type) {
      return { tier1: [], tier3: ["id-or-type-changed"] };
    }
    return diffSpecData(this.getSpec().data, next.data, this.tier3SpecKeys);
  }

  abstract applySpec(next: ChatSpec): Promise<SpecApplyOutcome>;
}
