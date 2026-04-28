# Roadmap

Phased delivery. Each phase produces something shippable and demonstrable.

## P0 — Synopsis upgrade

**Scope:** M1, M2, M3, M4(b), M5 in `dotnet-episteme-skills/src/synopsis`.
Linux-x64 and Linux-arm64 publish targets added.

**Ships:**
- New Synopsis v2.x binary, daemon-capable.
- New soul skill authored: `dotnet-techne-cross-repo-impact/SKILL.md`
  (spec only — agent invocation tested manually via Claude Code).
- Golden-file tests for breaking-diff classifier.

**Exit criteria:**
- `synopsis mcp --socket ...` accepts >=2 concurrent clients.
- `reindex_repository` updates the graph in <2s for a 10-project repo.
- `breaking_diff` fixture suite at >=10 scenarios, all green.
- Total Synopsis test count >=65.

**Rough sizing:** 1–2 weeks.

---

## P1 — Aegis MVP

**Scope:**
- Fork Pi, set up monorepo (`packages/core`, `/agent`, `/sdk`, `/cli`).
- Implement:
  - Event bus + SQLite queue + supervisor + git-sync.
  - Synopsis child-process supervision.
  - Adapter loader, config validator.
  - `adapter-github` (polling) — diff fetch, PR comment post, inline md
    report attach, open-PR search.
  - `adapter-slack` — `@aegis` mention handling + notify + reply.
  - Agent wiring: soul skill + `dotnet-techne-code-review` + `-crap-analysis`.
  - Single-image Dockerfile with entrypoint + healthcheck.
  - `docker-compose.yml` for local dev.

**Ships:**
- `aegis:0.1.0` Docker image.
- End-to-end demo: commit a DTO field removal in test-repo-a (which is
  called via HTTP by test-repo-b); open a PR; Aegis posts review + md
  report; Slack channel gets a Critical notification.

**Exit criteria:**
- One-command deploy (`docker run ... aegis:0.1.0`).
- A real PR gets a review within 3 minutes of creation (polling interval).
- `cross-repo-impact.md` attached as an inline PR comment.
- Supervisor survives Synopsis crash (`kill -9`) and resumes reviews.

**Rough sizing:** 2–3 weeks.

---

## P2 — Multi-host, richer bot

**Scope:**
- `adapter-gitlab` — parity with adapter-github for MRs.
- `adapter-gchat` — parity with adapter-slack for Google Chat.
- Chat command catalog expanded (see [CHAT_COMMANDS.md](CHAT_COMMANDS.md)):
  - `@aegis review <pr-url>` — ad-hoc review.
  - `@aegis impact <symbol>` — direct Synopsis blast-radius.
  - `@aegis paths <from> <to>` — path finding.
  - `@aegis endpoints [filters]` — list endpoints.
  - `@aegis repos` — monitored repos + scan state.
  - `@aegis status` — queue depth + worker state.
- Compat-PR search hardened (branch-name heuristics + linked-issue lookups).

**Ships:**
- Mixed GitHub + GitLab fleets supported in one deployment.
- Bot is interactive — users can drive Aegis from Slack/GChat without
  touching a PR.

**Rough sizing:** 1 week.

---

## P3 — Production hardening

**Pass 1 (done):**
- Webhook intake. `WebhookEndpoint` on `CodeHostAdapter`; embedded
  `HttpServer` in `@aegis/core` routes by URL path. GitHub uses
  HMAC-SHA256 (`X-Hub-Signature-256`); GitLab uses constant-time
  token comparison (`X-Gitlab-Token`). Polling remains as fallback.
- Prometheus `/metrics` endpoint. Counters for jobs enqueued/completed/
  failed/dlq and webhook events; gauges for queue pending/running/dlq.
  Optional Bearer auth via `metricsTokenEnv`.
- Retry/DLQ surfaced in chat: `dlq`, `requeue <job-id>`, `cancel <job-id>`.
  Permission gates: `dlq` is member, `requeue`/`cancel` are admin.
- Healthz endpoint at `/healthz` for k8s liveness probes.

**Pass 2 (done):**
- Rate limiting. Per-LLM-provider concurrency caps via `agent.providerLimits`
  in config, gated by an in-process `Semaphore`. Adaptive 429 backoff via a
  `not_before` column on `review_jobs` plus `queue.delayRetry()` so
  rate-limited jobs defer without consuming a retry attempt.
- File-mounted secrets. `EnvSecrets` honors the `${KEY}_FILE` env var pattern
  so k8s file-mounted secrets and Docker secrets work without code changes.
- Dynamic repo monitoring. `addRepo`/`removeRepo`/`listRepos` on the GitHub
  and GitLab adapters; KV-backed mutable list seeded from `cfg.repos`. Chat
  commands `watch [adapter/]<repo>` and `unwatch [adapter/]<repo>` are real
  (admin-gated). Config-listed repos are immutable from chat to avoid
  restart-undoes-unwatch surprises. `repos` command now lists adapter-watched
  repos with config/dynamic markers.
- Read-only dashboard at `/dashboard`. Server-rendered HTML, auto-refresh
  every 30s, no JS framework. Reuses the metrics Bearer token for auth.
  Sections: queue stats, active model, watched repos per adapter, DLQ list,
  recent audit log.
- Helm chart at `helm/aegis/`. Single-replica `Deployment` (SQLite is
  single-writer; `strategy: Recreate`), `Service`, `ConfigMap` (config + SOUL),
  optional `Secret` (env vars from values), two PVCs (state + workspace).
  Liveness via `/healthz`, readiness same. No Ingress (delegate).

**Pass 2 deferred to P4 / wishlist:**
- Full SPA dashboard with live updates (current is HTML-refresh).

**Ships:**
- `aegis:1.0.0` — on-call-ready.

**Rough sizing:** 1–2 weeks.

---

## P4 — Ecosystem

**Scope:**
- Reference adapters to unlock contributions:
  - `adapter-discord`
  - `adapter-teams`
  - `adapter-bitbucket`
  - `adapter-azure-devops`
- Plugin template repo (`create-aegis-adapter`).
- Adapter developer docs (API, lifecycle, testing).
- Public SDK package on npm.

**Ships:**
- Third-party adapters viable.

**Rough sizing:** 1–2 weeks, then ongoing.

---

## Post-P4 / wishlist

- **S1.** Per-repo on-disk graph cache for fast Synopsis cold start.
- **S2.** Extended HTTP client coverage: Refit, RestEase, gRPC, OpenAPI
  generated clients.
- **S3.** `git-scan` reuses combined graph (O(changed repo) instead of O(all)).
- **S4.** Gist / Snippet report hosting as alternative to inline md.
- **S5.** Multi-tenant deployment (multiple orgs, isolated configs).
- **S6.** Aegis can propose a compatible PR in the downstream repo instead
  of just flagging the missing fix.
- **S7.** Self-learning loop: Aegis records false positives per reviewer to
  tune its severity rubric (Hermes-style, opt-in).

## Dependency graph of phases

```
P0 (Synopsis) ──┐
                ▼
              P1 (MVP) ──┬──▶ P2 (multi-host)
                         └──▶ P3 (production)
                                 │
                                 ▼
                               P4 (ecosystem)
```

P2 and P3 are independent once P1 lands; they can be interleaved based on
priority.
