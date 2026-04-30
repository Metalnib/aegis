# Gaps

The honest list of what is incomplete, untested, or inconsistent in
Aegis as of the alpha cut. Not a roadmap, not a wishlist - a contract
between us and our early users about what they should expect to hit.

The gaps are grouped by severity. Severity is "what happens if you
don't address this before relying on the system." Numbering is for
reference, not priority.

## Critical (must address before depending on Aegis)

### G-1. End-to-end PR review path not exercised against a live PR

We have proven each constituent part: the GitHub adapter accepts a
signed webhook, the queue claims a job, the agent worker calls Vultr
which calls Synopsis tools and produces a grounded response, the
adapter spec defines `postReview`. **But we have never driven a real
PR open-to-comment loop end-to-end.**

The closest we got was the smoke test: a planted webhook with a valid
HMAC reaches the queue, then the adapter tries to fetchDiff against a
fake repo and fails noisily. That is correct behavior, but it is not
proof of the headline feature.

What this means in practice: the first time an alpha user sees Aegis
review a real PR, that is the first time the path runs end-to-end on
real data. There may be a bug in the path between `fetchDiff`,
`gitSync.ensureClone`, and the worker's review prompt that we have not
seen yet.

How to address: drive one real PR through the system, capture the
review, fix whatever surfaces.

### G-2. Helm chart not deployed to a real cluster (and has a known config-path bug)

The chart is structurally complete (templates render, values schema is
sane, probes are defined, secrets handling matches the SecretsProvider
contract). It has never been `helm install`-ed against a real
Kubernetes cluster.

**Known bug**: the chart's deployment template currently mounts the
config at `/opt/aegis/aegis.config.js`. The smoke test against Docker
proved this path does not work because Node's module resolution needs
the config under `/aegis/...`. A real `helm install` will fail at
config load with `MODULE_NOT_FOUND`. The chart needs the same fix
DEPLOYMENT.md and the Docker quick-start already got.

Other untested-on-real-cluster items:
- Whether the readinessProbe + startupProbe combination behaves as
  documented in ADR 0016 under real kubelet timing.
- Whether the secrets snake_case conversion in values.yaml works for
  every provider env var name.
- Whether the storageClass defaults work on common cloud providers
  (EKS gp3, GKE standard, AKS managed-csi).

What this means in practice: alpha users who try to deploy via Helm
will hit the config-path bug first, then potentially others.

How to address: fix the chart's mount path, then pick one cluster
(kind/minikube is enough), do a real install, fix what surfaces.

## Important (alpha-blocking for some users)

### G-3. SQLite single-replica is non-negotiable

This is by design (ADR 0013 and the Helm chart's `strategy: Recreate`),
but it is not loud enough in the docs. An operator who sees Aegis as
a stateless service and tries to scale it horizontally will corrupt
the queue.

The Helm chart prevents two replicas from running at once
(`Recreate`), so the corruption is bounded to deploy windows. But the
constraint should be on the front page of the README, not in an ADR
nobody reads.

How to address: short paragraph in README under "Status" or
"Architecture in 30 seconds" explicitly calling out single-replica.

### G-4. Mac single-file bind-mount + hot reload

On Docker Desktop / OrbStack for Mac, single-file bind mounts do not
propagate host-side edits to the container. The hot-reload mechanism
itself works (we proved SIGHUP triggers reload), but you cannot
demonstrate the file-watch path from a Mac dev box without using
directory mounts.

Linux / k8s production has none of this issue. It is purely a Mac dev
experience problem.

How to address: documented in CONFIGURATION.md under hot reload. Also
mention in README if hot-reload is featured.

### G-5. Backup / restore for the SQLite state

There is no documented procedure for backing up `/var/lib/aegis/`. A
disk failure on the state PVC means losing the queue, the audit log,
and the KV store (which holds the persisted model overrides and
dynamic-repo lists).

The KV and audit are recoverable in spirit (re-add dynamic repos,
audit is informational). The queue is not - in-flight jobs are lost.

How to address: a paragraph in DEPLOYMENT.md describing
`sqlite3 .backup` against the WAL-mode database. Or accept the data
loss and document it explicitly.

### G-6. No real production secrets management

Aegis ships `EnvSecrets` which supports the `${KEY}_FILE` indirection
used by Docker secrets and k8s file-mounted secrets. Vault, AWS Secrets
Manager, GCP Secret Manager are all reachable through that interface
in principle, but no integration is implemented or tested.

Worse: file-mounted secret rotation requires a pod restart (the secret
is cached for the process lifetime). Aegis logs a one-time notice but
this is a real production concern.

How to address: document the `_FILE` rotation gotcha prominently. For
Vault etc., implement the SecretsProvider interface as a plugin or
defer.

## Documented but partially or fully unimplemented

### G-7. Workspace cache hygiene / daily re-clone

`ARCHITECTURE.md` claims "git-sync... also maintains a daily full
re-clone for cache hygiene". The git-sync only does
`git fetch + git checkout`. There is no scheduled cleanup. A
long-running container will accumulate loose objects, dangling refs,
and removed-from-config repos on disk.

How to address: implement (small) or remove the claim from
ARCHITECTURE.md. We have not made the call.

### G-8. Context files in the prompt layering

`ARCHITECTURE.md` describes a three-layer prompt: SOUL, then
`/opt/aegis/context/*.md`, then skills. The skill loader does not load
a context layer. Project-specific guardrails today must go in SOUL.md
or a skill, neither of which is the right place.

How to address: implement (~30 lines in SkillLoader) or remove the
claim. We have not made the call.

### G-9. Audit log retention

The `audit_log` table grows unbounded. SQLite handles millions of
rows, but on a busy fleet that is months of history with no rotation.

How to address: a periodic prune (e.g. trim older than 30 days, or
keep last N entries). Not yet implemented.

## Production hardening (deferred, called out)

### G-10. PR diff size limits

A 10MB diff blows past LLM context windows and stresses the GitHub
API. The worker has a `jobTimeoutSec` (default 600) that will kill
runaway jobs, but there is no early-exit "diff too large, skipping
with reason" path.

What an alpha user might see: very large PRs DLQ with timeout errors
rather than a clean "skipped, too large" classification.

How to address: a `maxDiffBytes` (or maxFiles) check in `processJob`
before the LLM call.

### G-11. Image size

We ship the .NET SDK so MSBuild can evaluate `.csproj` files at
runtime. The image is ~750MB and may grow when we add additional .NET
target frameworks.

This is documented in DEPLOYMENT.md. Not a bug, a tradeoff. Worth
re-evaluating if we can pin Synopsis to a smaller MSBuild surface.

### G-12. TLS / dashboard authentication

The HTTP server is plain HTTP. The `metricsToken` Bearer protects
`/metrics` and `/dashboard`. There is no per-user auth, no TLS
termination in the image. Helm and Docker docs assume an ingress in
front does both.

This is correct for production but should be loud in the README.

### G-13. Skills are baked into the image

The `dotnet-techne-*` skills are copied from `dotnet-episteme-skills`
at image build time and live at `/opt/aegis/skills/`. The hot reload
of `skills` config field re-reads from this baked-in directory. There
is no way to update skills without rebuilding the image.

How to address: mount a skills volume, or accept the constraint and
document. Either is fine for alpha.

### G-14. Multi-arch publishing

The Dockerfile builds correctly for `linux/amd64` and `linux/arm64`
via `TARGETARCH`. We have only built and run the `arm64` image (Apple
Silicon dev box). The `amd64` build path has not been smoke-tested.

How to address: a CI matrix that builds and smoke-tests both arches.

## Observability and operations

### G-15. Tracing and structured request IDs

Logs have a `jobId` for worker-loop activity and that is it. There is
no end-to-end trace from "webhook arrived" through "review posted".
Debugging a slow review or a stuck job means correlating timestamps.

How to address: OpenTelemetry SDK, propagate a `requestId` through
the bus. Real work, not alpha-blocking.

### G-16. LLM token usage metrics

The `agent_end` event from Pi Agent carries usage info (input/output
tokens, cost). We log the totalTokens count in the new agent
visibility logging, but it is not exposed as a Prometheus metric.

How to address: a `aegis_llm_tokens_total{provider, model, direction}`
counter. Small, useful, not done.

### G-17. Worker activity dashboard

The dashboard shows queue depth, DLQ, audit, reload status, and the
active model. It does not show "what is the worker doing right now"
(which job, which tool call, how long it has been running). For
debugging a stuck job, you have to read logs.

How to address: surface in-flight job state from the worker loop on
the dashboard. Modest work.

## Untested or under-tested

### G-18. Webhook intake under load

We have unit tests for HMAC verification and a planted single-webhook
smoke. We have not tested concurrent webhooks, very large payloads
(within the 5MB limit), or rate-limited GitHub re-deliveries.

### G-19. Hot reload concurrency

`ConfigStore.reload` is serialized via a promise chain. We have unit
tests that prove the serialization shape. We have not tested what
happens if a reload arrives while a `processJob` is mid-flight on a
worker that depends on a config field being changed.

### G-20. Synopsis crash and recover

The Supervisor restarts Synopsis on crash with exponential backoff.
We have unit-tested the wiring. We have not tested what happens to
in-flight reviews when Synopsis is mid-restart - the MCP socket
disappears, MCP calls error, the agent loop sees errors mid-stream.
The behavior is theoretically "review fails closed" but unproven.

### G-21. Adapter spec hot-reload across many adapters

Hot reload of `codeHosts[*]` is unit-tested for diff classification
and adapter `applySpec`. We have not tested with multiple adapters at
once where some change Tier 1 and others change Tier 3.

## Known false-positive features

### G-22. Path drift in older docs

`docs/REPO_LAYOUT.md` and `docs/ARCHITECTURE.md` predate the smoke
test's discovery that the JS workspace lives at `/aegis/` while
static resources live at `/opt/aegis/`. Several references in those
files conflate the two and should be re-read with the split now
explicit. The README's "skills are copied into the image at
`/opt/aegis/skills/`" line is correct (skills are static), but lines
implying the user config lives there are not.

The doc-rewrite pass for the alpha cut deliberately scoped to
`README.md`, `DEPLOYMENT.md`, and `CONFIGURATION.md`. Other files were
flagged but not changed.

How to address: a focused pass on the older docs once the alpha is
out and we know which references operators actually hit. Low priority.

### G-23. Per-repo serialization is in-process only

The worker's `inflightRepos` set is in-memory. It serves the current
single-replica deployment correctly. If we ever go multi-process or
multi-replica, two processes would each track their own inflight set
and could claim the same repo concurrently from the queue.

The DB-level `claim` already returns one row at a time, so the race
is bounded to "one claim each, then both try to checkout the same
repo." Still a corruption risk in multi-replica mode.

How to address: not relevant until we move past single-replica. Make
the constraint explicit in ARCHITECTURE.md when we do.

## What is not on this list

Items that are working, tested, and behave as documented have no
entry. The reload contract, the config schema validation, the queue
state machine, the readiness gate, the per-repo serialization in
single-replica mode, custom LLM providers, multi-arch synopsis build,
the HMAC and constant-time-comparison paths, and the Layer 1+2 test
coverage all belong in that category.

## How this list is maintained

Each gap closed gets removed (not crossed out). New gaps found get
added with a `G-NN` ID. The list is meant to be short enough to scan
and honest enough to trust.
