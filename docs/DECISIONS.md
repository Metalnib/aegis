# Design Decisions

Short log of locked-in decisions. Each has an ADR under `adr/` with full
rationale. Intended as a quick lookup; for context, read the ADR.

| # | Decision | ADR |
|---|---|---|
| 1 | Name: **Aegis** (shield framing, guards the microservice fleet) | [adr/0001](adr/0001-name-aegis.md) |
| 2 | Single Docker image — no external deps (no Redis, no sidecars) | [adr/0002](adr/0002-single-image-deployment.md) |
| 3 | SQLite for queue + audit + adapter state | [adr/0003](adr/0003-sqlite-persistence.md) |
| 4 | Pi fork rather than importing Pi as a dependency | [adr/0004](adr/0004-pi-fork.md) |
| 5 | Polling for MVP; webhooks as additive capability in P3 | [adr/0005](adr/0005-polling-first.md) |
| 6 | Env vars for secrets in MVP; Docker/k8s secrets via same interface later | [adr/0006](adr/0006-env-vars-for-secrets.md) |
| 7 | Two adapter surfaces: `CodeHostAdapter` and `ChatAdapter` (don't conflate) | [adr/0007](adr/0007-two-adapter-surfaces.md) |
| 8 | Synopsis communicates via Unix socket inside the container (not TCP) | [adr/0008](adr/0008-synopsis-unix-socket.md) |
| 9 | Synopsis `breaking-diff` classifier is a deterministic CLI/MCP command, not LLM interpretation | [adr/0009](adr/0009-breaking-diff-classifier.md) |
| 10 | Inline PR comments for markdown report in MVP; gist/snippet hosting deferred | [adr/0010](adr/0010-inline-report-mvp.md) |
| 11 | `dotnet-episteme-skills` remains standalone; Aegis consumes it at build time | [adr/0011](adr/0011-standalone-episteme-skills.md) |
| 12 | Node supervises the Synopsis child process (no external supervisor) | [adr/0012](adr/0012-node-supervises.md) |
| 13 | Single-tenant Aegis deployment per container in MVP (multi-tenant deferred) | [adr/0013](adr/0013-single-tenant.md) |
| 14 | Pluggable state store for Synopsis daemon: interface in P0, JSON impl only; SQLite flagged pre-MVP | [adr/0014](adr/0014-pluggable-state-store.md) |

Proposed but **not** adopted:
- Hermes-style self-learning loop (overkill for deterministic PR review; may
  revisit as opt-in in S7).
- Webhook-only intake for MVP (raises auth/infra complexity too early).
- Separate Synopsis container (violates single-image constraint).
- Skills copied into Aegis repo (violates episteme-skills independence).
