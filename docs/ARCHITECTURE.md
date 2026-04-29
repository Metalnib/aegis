# Architecture

Single-process .NET-aware review agent, packaged as one Docker image, with
pluggable code-host and chat adapters.

## Component diagram

```
┌────────────────────────────── AEGIS CONTAINER ─────────────────────────────┐
│                                                                            │
│  ┌──────────────┐ events ┌──────────────┐  job  ┌─────────────────────┐    │
│  │ Code-host    │───────▶│  Event bus   │──────▶│  Worker pool        │    │
│  │ adapters     │        │   + SQLite   │       │  (Pi LLM agent)     │    │
│  │ github,      │◀───────│    queue     │◀──────│  loads skills from  │    │
│  │ gitlab, …    │ review │              │result │  /opt/aegis/skills  │    │
│  └──────┬───────┘        └──────────────┘       └──────────┬──────────┘    │
│         │                       ▲                          │               │
│         │ post comment +        │ chat commands            │ MCP/JSON-RPC  │
│         │ inline md report      │                          │ over Unix sock│
│         │                ┌──────┴───────┐                  ▼               │
│         │                │ Chat         │           ┌────────────────┐     │
│         │                │ adapters     │           │ synopsis child │     │
│         ▼                │ slack, gchat │           │ process        │     │
│   ┌──────────┐           │ discord, …   │           │ (.NET single-  │     │
│   │ GitHub / │           └──────┬───────┘           │  file binary)  │     │
│   │ GitLab   │                  │                   │  daemon mode   │     │
│   │ external │                  │ notify            └────────┬───────┘     │
│   └──────────┘                  ▼                            │             │
│                            ┌────────┐                        │             │
│                            │ Slack… │                        ▼             │
│                            └────────┘         ┌──────────────────────────┐ │
│                                               │ /workspace               │ │
│                                               │   repo-a/ repo-b/ …      │ │
│                                               │ (cloned, git-fetched by  │ │
│                                               │  internal git-sync task) │ │
│                                               └──────────────────────────┘ │
│                                                                            │
│  /var/lib/aegis/aegis.db  (SQLite: queue + dedup + audit + adapter state)  │
└────────────────────────────────────────────────────────────────────────────┘
```

## Components

### `@aegis/core`
- **Event bus** — in-process pub/sub between adapters, queue, and worker.
- **Queue** — durable SQLite-backed FIFO with dedup keys (PR-ref + head SHA)
  and retry/DLQ semantics.
- **Supervisor** — spawns and health-checks the Synopsis child process;
  restarts on crash with exponential backoff.
- **Git-sync** — internal loop (no sidecar) that `git fetch` + `git checkout`
  the head SHA per job; also maintains a daily full re-clone for cache hygiene.
- **Config loader** — loads and validates `aegis.config.ts`.
- **Adapter registry** — wires adapter packages declared in config.

### `@aegis/agent`
- Wraps the forked Pi runtime.
- Assembles the agent's system prompt at init (see **Prompt layering** below):
  - **Soul**: `/opt/aegis/SOUL.md` (Aegis identity).
  - **Context files**: user/project context if any.
  - **Skills**: SKILL.md files from `/opt/aegis/skills/`.
- Exposes a tool set to the LLM:
  - Synopsis MCP tools (`blast_radius`, `breaking_diff`, `cross_repo_edges`, …).
  - `gh` / `glab` CLI wrappers (through the active code-host adapter).
  - Filesystem read (`/workspace`).
- Produces `AegisReview { prComments[], markdownReport, severity, findings[] }`.

### `@aegis/sdk`
- Public types and SPIs for third-party adapters.
- No runtime dependencies on core (keeps adapter packages light).

### Adapters (`@aegis/adapter-*`)
- Code hosts: implement `CodeHostAdapter`.
- Chat platforms: implement `ChatAdapter`.
- One package per adapter; see [adapters.md](adapters.md).

### Synopsis (from `dotnet-episteme-skills`)
- Runs as a managed child of Aegis, daemon mode.
- Holds the combined multi-repo graph in memory.
- Transport: Unix socket at `/var/run/aegis/synopsis.sock`
  (single image = shared filesystem; no port needed).
- Graph rebuilds per repo on `reindex_repository` MCP call.

## Prompt layering

Aegis follows Pi's (and OpenClaw's) three-layer prompt model. Layers are
assembled once per agent session and cached at the LLM provider when the
backend supports prompt caching.

```
┌────────────────────────────────────────────────────────────────┐
│ 1. Soul (identity)                                             │
│    /opt/aegis/SOUL.md  →  every turn, fixed                    │
│    "Who Aegis is, its defensive stance, severity philosophy"   │
├────────────────────────────────────────────────────────────────┤
│ 2. Context files (project rules + memory)                      │
│    /opt/aegis/context/*.md  →  every turn, project-scoped      │
│    "Project-specific guardrails, operator preferences"         │
├────────────────────────────────────────────────────────────────┤
│ 3. Skills (procedural recipes)                                 │
│    /opt/aegis/skills/<name>/SKILL.md  →  loaded, invoked when  │
│    the LLM matches the skill's trigger description             │
│    "How to actually perform a specific task"                   │
├────────────────────────────────────────────────────────────────┤
│ 4. Per-turn user message (the PR to review, the chat command)  │
└────────────────────────────────────────────────────────────────┘
```

**Soul vs. skill, in one sentence.** The soul is identity — always present,
defines default stance. A skill is a procedure — invoked when matched,
defines exact steps.

**Aegis's soul lives at** `aegis/SOUL.md` (repo root) and ships to the
image at `/opt/aegis/SOUL.md`. It defines Aegis as the shield of the
microservice fleet, encodes the severity philosophy, and enforces the
reflex to check cross-repo impact on every PR.

**The `dotnet-techne-cross-repo-impact` skill** is the procedural recipe
the soul's reflex triggers. It tells the LLM which MCP tools to call, in
what order, and how to structure the markdown report. It carries no
identity — just the how.

See [SKILL_CROSS_REPO_IMPACT.md](SKILL_CROSS_REPO_IMPACT.md) for the
skill's full spec and the [SOUL.md](../SOUL.md) file for the identity
content itself.

## Event lifecycle (per PR review)

```
1. CodeHostAdapter emits PrEvent { opened | synchronize | reopened }
2. core.bus dedupes (prRef, headSha) → enqueue ReviewJob in SQLite
3. Worker claims job:
     a. git-sync → /workspace/<repo> at head SHA
     b. MCP call → synopsis.reindex_repository(path=..., ref=sha)  [M3]
     c. MCP call → synopsis.breaking_diff(before, after)           [M4]
     d. Launch Pi agent:
        - system prompt = SOUL.md + context files + loaded skills
        - cross-repo-impact skill fires first (soul's reflex)
        - then intra-PR review skills run (code-review, crap-analysis, …)
     e. Agent calls MCP + `gh pr list` / `glab mr list` for compat-PR search
     f. Agent returns AegisReview
4. codeHost.postReview(ref, review.prComments)
5. codeHost.postReview posts inline `cross-repo-impact.md` (MVP path)
6. If review.severity >= High:
     every ChatAdapter with matching notifyOn → chat.notify(channel, summary)
7. Record audit row; mark job done
8. On failure: retry up to N; after N → DLQ + chat.notify(ops_channel)
```

## Concurrency and ordering

- Worker pool size = `agent.concurrency` in config (default 4).
- Per-repo serialization: jobs with the same repo run one-at-a-time to avoid
  workspace/checkout races; different repos run in parallel.
- Synopsis daemon is single-threaded for writes (`reindex_repository`), lock-free
  for reads (immutable `ScanResult` snapshots after merge).

## Failure modes and degradations

| Component down | Behaviour |
|---|---|
| Synopsis daemon crash | Supervisor restarts; jobs in-flight retry. Reviews continue but fail-closed: soul directs the impact skill to emit `severity=Unknown` with a reason, not a silent skip. |
| Code-host API rate limit | Exponential backoff in adapter; jobs re-enqueue. |
| LLM provider unavailable | Worker parks job, backs off; chat adapters notify on sustained outage. |
| SQLite corruption | Hard fail with log; queue is disposable, replay from adapter cursor on restart. |

## Startup readiness

Aegis has three subsystems that must come up in order before it accepts work:

1. SQLite state (queue, audit, KV) opens immediately on construction. Cheap.
2. Synopsis daemon. The Supervisor spawns it as a child process. Ready when
   the `MCP server listening` line appears on its stdout.
3. MCP client connection. Opens once Synopsis is ready.

The cold-scan time of the Synopsis daemon is the dominant factor. It scales
with workspace size, project count, NuGet restore cost, and the underlying
disk and CPU speed. A small fleet on fast hardware comes up in tens of
seconds. A 20-service fleet on a constrained VM can take several minutes.
Operators tune the Helm `startupProbe` accordingly. The chart default is
generous (10 minutes total tolerance) because underestimating causes pod
restart-flapping during boot, while overestimating only delays failure
detection at startup time, which is cheap compared to the cost of a flap
loop.

### The not-ready window

Until all three subsystems are up, Aegis declares itself "not ready":

- `/healthz` returns `503 not-ready` with a JSON body listing pending
  subsystems.
- The webhook router responds with `503 starting` to inbound POSTs.
- Polling does not run. The first poll cycle starts after ready.
- The dashboard shows a "Starting" banner listing pending subsystems.

A single shared "ready" gate controls all four behaviors. There is no
per-subsystem partial readiness.

### Tradeoff: 503 vs buffer-and-replay

We chose to return 503 over buffering inbound webhooks for replay once
ready. 503 is simpler, has no in-memory loss surface (a process crash
during the not-ready window cannot drop buffered events the upstream has
already moved past), and leans on the retry behavior the upstream already
implements. GitHub and GitLab both retry 5xx with exponential backoff, so
events arriving in this window are deferred to the delivering host's next
attempt rather than lost.

The cost: webhook deliveries during a deploy show as failed retries in
the upstream UI, which can confuse a first-time operator watching their
GitHub webhook page. We may revisit if we ever onboard a host that does
not retry, if buffering becomes cheap because we add a durable inbound
queue for other reasons, or if upstream retry visibility becomes a real
operator-experience complaint.

## Security surface (MVP)

- Single-tenant, single-org deployment assumed.
- Secrets via env vars (see [DEPLOYMENT.md](DEPLOYMENT.md) TODO list for
  Docker/k8s secret management).
- Chat commands gated by adapter-level allow-lists (user, channel).
- No arbitrary code execution in the agent — tools are explicitly enumerated.
- Agent never clones or writes to repos; all checkout happens in git-sync.
