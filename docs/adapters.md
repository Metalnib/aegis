# Adapters

Aegis has two adapter surfaces:

- **`CodeHostAdapter`** — GitHub, GitLab, Bitbucket, Azure DevOps, Gitea.
  Produces PR/MR events, accepts reviews.
- **`ChatAdapter`** — Slack, Google Chat, Discord, Teams.
  Produces chat commands, accepts notifications.

Both live in `@aegis/sdk` and are implemented as `npm` packages.

## Design principles

1. **Stateless calls.** Adapters never cache state in-process; any cursors,
   seen-ID sets, or tokens live in `ctx.store` (SQLite-backed KV provided
   by core). Restarts are safe.
2. **No LLM or skill awareness.** Adapters never call the agent or touch
   skills. They only produce and consume well-typed events.
3. **Secrets via context.** No secret in constructor args. Every adapter
   pulls from `ctx.secrets.get("GITHUB_TOKEN")` etc.
4. **Fail loud, retry at core.** On API errors, adapters throw typed errors
   (`RateLimited`, `AuthFailed`, `Transient`); the core decides retry policy.

## `CodeHostAdapter` SPI

```ts
// @aegis/sdk
export interface CodeHostAdapter {
  readonly id: string;                 // "github", "gitlab", etc.
  init(ctx: AdapterContext): Promise<void>;
  dispose(): Promise<void>;

  // Inbound — event production.
  // MVP: polling. P3: both polling and subscribe are valid; core picks.
  pollPullRequests(since?: Date): AsyncIterable<PrEvent>;
  subscribe?(handler: (e: PrEvent) => void): Disposable;

  // Lookup and diff.
  fetchPr(ref: PrRef): Promise<PrInfo>;
  fetchDiff(ref: PrRef): Promise<DiffBundle>;

  // Search open PRs — used by soul skill for compatible-PR detection.
  searchOpenPrs(query: PrSearchQuery): Promise<PrRef[]>;

  // Outbound — review posting.
  postReview(ref: PrRef, review: AegisReview): Promise<void>;
  postInlineReport(ref: PrRef, name: string, markdown: string): Promise<void>;
}

export interface PrRef {
  host: string;         // "github.com"
  owner: string;        // "myorg"
  repo: string;         // "svc-a"
  number: number;
  headSha: string;
}

export interface PrEvent {
  kind: "opened" | "synchronize" | "reopened";
  ref: PrRef;
  receivedAt: Date;
}

export interface DiffBundle {
  files: FileDiff[];
  baseSha: string;
  headSha: string;
}

export interface AegisReview {
  severity: "Critical" | "High" | "Medium" | "Low" | "Unknown";
  prComments: InlineComment[];
  summary: string;          // top-of-PR body
  findings: Finding[];      // structured, for chat notify
}

export interface PrSearchQuery {
  repos: string[];          // "owner/repo"
  anyOfKeywords?: string[]; // substring in title/body
  branchPattern?: string;   // regex
  sinceDays?: number;
}
```

## `ChatAdapter` SPI

```ts
export interface ChatAdapter {
  readonly id: string;                 // "slack", "gchat"
  init(ctx: AdapterContext): Promise<void>;
  dispose(): Promise<void>;

  // Inbound — user commands.
  onCommand(handler: (c: ChatCommand) => void): Disposable;

  // Outbound.
  reply(cmd: ChatCommand, body: ChatBody): Promise<void>;
  notify(channel: ChannelRef, body: ChatBody): Promise<void>;
}

export interface ChatCommand {
  channel: ChannelRef;
  user: UserRef;
  text: string;             // raw text minus the @aegis mention
  threadRef?: string;       // provider-specific thread ID
  receivedAt: Date;
}

export interface ChatBody {
  text: string;             // plain text
  markdown?: string;        // if provider supports it
  attachments?: ChatAttachment[];
}
```

## `AdapterContext`

Passed to every adapter at `init`:

```ts
export interface AdapterContext {
  logger: Logger;
  secrets: SecretsProvider;  // env-var backed in MVP
  store: KvStore;            // SQLite-backed; namespaced per adapter id
  clock: () => Date;
  config: Record<string, unknown>;   // adapter-specific config from aegis.config.ts
  emit: (event: BusEvent) => void;   // for subscribing adapters
}
```

## MVP adapters

| Package | Target | Scope |
|---|---|---|
| `@aegis/adapter-github` | github.com and GitHub Enterprise | P1 |
| `@aegis/adapter-gitlab` | gitlab.com and self-hosted | P2 |
| `@aegis/adapter-slack` | Slack app (Socket Mode) | P1 |
| `@aegis/adapter-gchat` | Google Chat app | P2 |

Post-MVP (P4):
- `@aegis/adapter-discord`
- `@aegis/adapter-teams`
- `@aegis/adapter-bitbucket`
- `@aegis/adapter-azure-devops`

## Writing a third-party adapter

1. `npm init @aegis/adapter-template` *(P4)* — scaffolds a package.
2. Implement `CodeHostAdapter` or `ChatAdapter` from `@aegis/sdk`.
3. Export a factory:
   ```ts
   export function bitbucket(cfg: BitbucketConfig): CodeHostAdapter { ... }
   ```
4. Users add it in `aegis.config.ts`:
   ```ts
   import { bitbucket } from "aegis-adapter-bitbucket";
   export default defineConfig({
     codeHosts: [bitbucket({ workspace: "myws", repos: [...] })],
     // ...
   });
   ```

## Adapter lifecycle

```
config load → adapter factory called → instance created
           → core calls init(ctx)
           → core calls pollPullRequests / subscribe
           → events flow during runtime
           → on shutdown: core calls dispose()
```

Adapters must be idempotent: `init` can be called after a crash without
side effects.

## Testing adapters

- `@aegis/sdk/testing` *(P4)* — in-memory `AdapterContext`, mock secrets,
  mock KV store.
- Contract tests: every adapter runs a shared suite asserting SPI
  invariants (dedup keys, retry on transient errors, etc.).

## Non-goals

- Adapters do **not** have direct MCP access. If a chat command needs to
  query the graph, it goes through the agent (which has MCP).
- Adapters do **not** persist reviews. The core audit log is the source
  of truth.
- Adapters do **not** share state with each other. If you need two code
  hosts coordinated, the core's event bus is the integration point.
