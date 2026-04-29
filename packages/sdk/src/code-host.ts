import type { PrRef, PrEvent, DiffBundle, PrInfo, PrSearchQuery, AegisReview } from "./types.js";
import type { AdapterContext } from "./context.js";

/**
 * Optional surface that adapters opt into to support config hot-reload.
 * Adapters extending CodeHostAdapterBase get this for free.
 */
export interface SpecAware<TSpec> {
  getSpec(): TSpec;
  diffSpec(next: TSpec): { tier1: string[]; tier3: string[] };
  applySpec(next: TSpec): Promise<{ applied: string[]; failed: Array<{ key: string; reason: string }> }>;
}

export interface CodeHostAdapter {
  readonly id: string;
  init(ctx: AdapterContext): Promise<void>;
  dispose(): Promise<void>;

  pollPullRequests(since?: Date): AsyncIterable<PrEvent>;
  subscribe?(handler: (e: PrEvent) => void): Disposable;

  fetchPr(ref: PrRef): Promise<PrInfo>;
  fetchDiff(ref: PrRef): Promise<DiffBundle>;
  searchOpenPrs(query: PrSearchQuery): Promise<PrRef[]>;

  postReview(ref: PrRef, review: AegisReview): Promise<void>;
  postInlineReport(ref: PrRef, name: string, markdown: string): Promise<void>;

  /**
   * Return the HTTPS clone URL (without credentials) and the credentials git should use.
   * The caller (GitSync) feeds the credentials to git via GIT_ASKPASS so they never
   * appear in argv, the URL, or git's stderr.
   */
  getCloneSpec(ref: PrRef): CloneSpec;

  /**
   * Webhook intake. Adapters that opt in expose a route the core HTTP server
   * mounts. The handler verifies signatures, parses the payload, and pushes
   * any resulting PrEvent to subscribers registered via subscribe().
   */
  webhook?: WebhookEndpoint;

  /**
   * Return all currently-monitored repos under this adapter (config + dynamic).
   * Caller treats the result as authoritative; polling and webhook intake use
   * it to decide what to act on.
   */
  listRepos?(): RepoEntry[];

  /**
   * Add a repo to the monitored list at runtime. Validates accessibility via
   * the host API. Throws if the repo doesn't exist, the token can't see it,
   * or it's already tracked.
   */
  addRepo?(name: string): Promise<void>;

  /**
   * Remove a repo from the dynamic list. Refuses for repos listed in the
   * static config so a chat-issued unwatch can't be silently undone by a
   * config-driven restart.
   */
  removeRepo?(name: string): Promise<void>;
}

export interface RepoEntry {
  name: string;
  /** "config" = listed in aegis.config.ts; "dynamic" = added via addRepo at runtime. */
  source: "config" | "dynamic";
}

export interface WebhookEndpoint {
  /** URL path the host posts to, e.g. "/webhooks/github". Must start with "/". */
  path: string;
  /** Handle one inbound request. Must validate authentication before reacting. */
  handle(req: WebhookRequest): Promise<WebhookResponse>;
}

export interface WebhookRequest {
  method: string;
  headers: Record<string, string>;
  /** Raw request body; needed verbatim for HMAC verification. */
  body: Buffer;
}

export interface WebhookResponse {
  status: number;
  body?: string;
}

export interface CloneSpec {
  url: string;
  username: string;
  password: string;
}

export type AdapterError =
  | { kind: "rate-limited"; retryAfterSec: number }
  | { kind: "auth-failed"; message: string }
  | { kind: "transient"; message: string };

export class AegisAdapterError extends Error {
  constructor(public readonly error: AdapterError) {
    super(error.kind === "rate-limited" ? `rate-limited (retry after ${error.retryAfterSec}s)` : error.message);
  }
}
