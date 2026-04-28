# Chat Commands

Aegis is a bot. Users interact by mentioning `@aegis` in any channel where
the bot is installed (Slack, Google Chat, future: Discord, Teams).

## Command syntax

```
@aegis <verb> [args...]
```

Leading `@aegis` is stripped by the chat adapter before dispatch; the core
command router sees just `<verb> [args]`.

## MVP commands (P1)

| Command | Purpose | Example |
|---|---|---|
| `help` | List commands | `@aegis help` |
| `status` | Daemon state, queue depth, last scan per repo | `@aegis status` |
| `review <pr-url>` | Ad-hoc review of a PR (bypasses polling) | `@aegis review https://github.com/myorg/svc-a/pull/42` |

## P2 commands — interactive graph queries

| Command | Purpose | Example |
|---|---|---|
| `impact <symbol> [--upstream|--downstream] [--depth N]` | Blast radius | `@aegis impact OrdersController --upstream` |
| `paths <from> <to>` | Find paths between two nodes | `@aegis paths OrdersController OrderRepository` |
| `endpoints [--repo X] [--verb GET]` | List endpoints | `@aegis endpoints --repo svc-a` |
| `repos` | Monitored repos + last scan timestamp + head SHA | `@aegis repos` |
| `callers <symbol>` | Who calls this symbol (shorthand for upstream impact at depth 1) | `@aegis callers OrderService.Create` |
| `db <entity|table>` | EF lineage for an entity or table | `@aegis db Orders` |
| `ambiguous [--repo X]` | Top ambiguous edges needing review | `@aegis ambiguous --repo svc-b` |
| `explain <pr-url> <finding-id>` | Expand one finding from a past review | `@aegis explain ...#42 3` |
| `rescan <repo>` | Force a Synopsis re-index of one repo | `@aegis rescan svc-a` |
| `watch <repo>` | Start monitoring a repo (runtime, not config) | `@aegis watch myorg/svc-d` |
| `unwatch <repo>` | Stop monitoring | `@aegis unwatch myorg/svc-d` |

## Post-MVP ideas (P4+)

| Command | Purpose |
|---|---|
| `crap <repo>` | Top CRAP-score hotspots |
| `suggest-compat-pr <finding>` | Draft a skeleton compatible PR in downstream repo |
| `diff-summary <pr-url>` | High-level summary of a PR's changes without full review |
| `changelog <repo> --since <date>` | Auto-generated breaking-change changelog |

## Permission model

Every command has an access level:

| Level | Who |
|---|---|
| `public`  | Anyone in any channel where the bot is installed |
| `member`  | Configured allowlist of users (org members in ops-critical channels) |
| `admin`   | Aegis operators — can invoke state-changing commands |

Default matrix:

| Command | Level |
|---|---|
| `help`, `status`, `repos`, `impact`, `paths`, `endpoints`, `callers`, `db`, `ambiguous`, `explain` | `public` |
| `review`, `rescan` | `member` |
| `watch`, `unwatch` | `admin` |

Allowlists live in `aegis.config.ts`:

```ts
chats: [
  slack({
    channel: "#aegis-ops",
    permissions: {
      memberUsers:  ["UX1...", "UX2..."],
      adminUsers:   ["UX1..."],
    },
  }),
],
```

When a user invokes a command above their level, Aegis replies:
`sorry, `<cmd>` is <level>-only in this channel`.

## Rate limits

- Per-user: 30 commands / 5 minutes.
- Per-channel: 200 commands / 5 minutes.
- `review`, `rescan`: one concurrent per user.
- Exceeded → adapter replies with back-off hint.

Rate-limit state lives in `ctx.store` so it survives restarts.

## Response format

- Short commands (`status`, `callers`) respond as a single threaded reply.
- Long results (`impact`, `endpoints`) reply with a short summary + a code
  block; if output > 3 KB, attach a file or link to a gist (P4 — gist
  hosting).
- Reviews triggered via `review` command reply with a pointer to the PR
  comment, not the full review inline.

## Command routing

```
ChatAdapter.onCommand(cmd)
  → core.commandRouter.parse(cmd.text)
  → Handler lookup
  → Permission check
  → Rate-limit check
  → Handler runs:
      - may call @aegis/agent for graph queries
      - may enqueue a ReviewJob
      - always emits a reply via cmd.adapter.reply()
```

Handlers are registered in `@aegis/core`; adapters never implement commands
themselves. This keeps Slack and Google Chat strictly presentation layers.

## Testing bot commands

- `aegis chat-simulate <command>` (P1) — runs a command against an in-memory
  mock adapter for local testing.
- Snapshot tests per command: expected reply shape given a fixture graph.

## Non-goals

- No slash commands in MVP. `@aegis mention` is enough and works across all
  chat platforms uniformly.
- No interactive buttons / approvals in MVP. All responses are text; action
  happens via re-invocation.
- No multi-turn conversation state in MVP. Each command is one-shot.
