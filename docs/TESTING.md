# Testing

## Why we test

Aegis manages durable state (SQLite queue, audit log, KV), runs untrusted
LLM output through a tool surface, and absorbs hot-reloadable config from
disk. Quiet failures in any of these are silent data corruption, not
visible errors. The whole point of the project is careful, graph-grounded
review; the work that builds Aegis must be held to the same standard or
higher.

Tests exist to (a) catch regressions during refactors, (b) document
expected behavior in executable form when prose specs go stale, and
(c) give the operator confidence that a build is shippable. They do not
exist to chase coverage numbers.

## Non-negotiable: integration and smoke

Unit tests alone are not enough. They prove individual functions behave;
they do not prove the system runs. Most production bugs in Aegis-shaped
systems live at the seams: the webhook arrives but the body has wrong
encoding, the SQLite WAL is not actually journaling, the MCP socket
hangs, the hot reload fires but the subscriber missed the event. None
of these surface in unit tests.

Therefore:

- **Integration tests are not optional.** Every adapter that talks to a
  network protocol (webhooks, MCP, HTTP server) ships with integration
  tests against a real instance of that protocol. Mock adapters are for
  Layer 2 worker-loop tests where we exercise *our* code, not for
  adapter-vs-protocol verification.
- **Smoke tests are not optional.** Before any deploy,
  `scripts/test-e2e.sh` runs against a real Docker build with a real
  Synopsis cold scan. If this is broken, we do not ship. Period.
- **Integration tests run on every CI build.** Smoke runs before every
  release tag. Both are gates, not nice-to-haves.

This section is the contract. The rest of the doc explains how.

## Framework: `node:test` + `tsx`

The Node 22 built-in test runner is the framework. `tsx` loads `.ts`
sources without a separate compile step. Both run on every supported
Node version we ship.

### Tradeoff: `node:test` vs `vitest`

`vitest` has snapshot tests, parallel execution by default, a clean watch
mode, and friendlier matchers. Real DX wins. `node:test` has zero
runtime dependencies, native ESM support, and a TAP reporter that works
with anything. The project ethos is "no Redis, no sidecars, no extra
packages" - we picked `node:test` to match. We may revisit if matchers
or snapshot ergonomics become a bottleneck during refactors.

## Three layers

### Layer 1 - unit tests (fast, isolated)

Test the highest-risk state machines and pure functions. Real SQLite for
Queue tests (one tmpfile per test); no LLM, no network, no filesystem
beyond temp files. Should run in under 5 seconds total.

Layer 1 alone is necessary but never sufficient. It catches logic bugs
in pure functions and state machines. It does not catch wiring bugs,
encoding mismatches, race conditions across modules, or "the thing
that worked in the test does not actually start in Docker."

Targets:

- `Queue`: claim, claim with `excludeRepoFqns`, delayRetry,
  recoverOrphaned, complete, fail, listDlq, requeue, cancel.
- `ConfigStore.computeChangeSet`: every Tier 1 + Tier 3 classification
  path.
- `ReadinessGate`: initial state, partial-ready, full-ready, idempotent
  re-mark, unknown subsystem rejected, `whenReady` resolves immediately
  when already ready and on transition.
- `Semaphore`: capacity, FIFO order, released-once invariant, no permit
  leak under concurrent acquires.
- `CodeHostAdapterBase.diffSpec`: tier1 vs tier3 keys,
  id-or-type-changed sentinel, deep equality on nested data.
- `EnvSecrets`: env var present, `_FILE` indirection (read + trim +
  cache), env missing, file missing, file empty, both env and `_FILE`
  set (file wins).
- `AgentWorker.resolveModel` (and `makeGetApiKey`): built-in provider,
  custom provider, unknown provider error message includes the
  configured set.

### Layer 2 - integration tests (real subsystems, mandatory)

Span more than one module. Real HTTP server, real adapter classes with
mocked HTTP transport for *upstream* APIs. Should run in under 30
seconds total.

Layer 2 is the one most teams skip and most teams regret. It is the
layer that catches: wrong content-type headers, malformed signatures,
race conditions between the HTTP server and the readiness gate, hot
reload events that fire into a closure with stale config, webhook
bodies that pass HMAC but fail JSON parse, and the dozen other things
that "looked right" in unit tests.

We do not skip Layer 2.

Targets:

- HTTP server: `/healthz` 503 vs 200 driven by `ReadinessGate`. Webhook
  503 vs accept. Metrics token Bearer check (correct, wrong, missing).
  Body size limit. Read timeout.
- GitHub webhook: HMAC-SHA256 verification (good, tampered body, missing
  header, wrong scheme prefix). Action filtering (`opened` vs ignored).
  Repo not-tracked rejected.
- GitLab webhook: constant-time token comparison (good, wrong, missing).
  MR action filtering. Wrong namespace rejected.
- Worker loop: per-repo serialization under concurrent enqueue.
  In-flight repo set cleared on completion. Per-provider semaphore caps
  respected.
- Hot reload: write a config to a tempfile, trigger reload, observe
  ChangeSet. Tier 3 change refused without applying any subscribers.
  Persisted model override targeting a removed customProvider gets
  dropped on reload with the right ops-channel notice.
- ConfigStore + adapters end-to-end: factory-built throwaway adapters,
  diff against live, applySpec on the live one.

### Layer 3 - smoke / end-to-end (mandatory before release)

Slow, requires Docker. Lives in `scripts/test-e2e.sh`. Not run on every
commit; **runs before every release tag and is a hard gate**. If smoke
is red, we do not deploy.

This is the only layer that exercises the full image: the same
container that goes to production, the same Synopsis binary, the same
config schema, the same network. If smoke breaks, something is wrong
with the *system* and unit tests will not find it.

Targets:

- Docker container boot: `/healthz` transitions from 503
  (`pending: ["sqlite","synopsis","mcp"]`) to 200 within the configured
  tolerance. Asserts the readiness gate contract from ADR 0016 holds in
  the real container.
- Synopsis cold scan against `dotnet-episteme-skills/src/synopsis`
  itself (small, known-good .NET workspace). Asserts the supervisor +
  MCP wiring works against actual code.
- One planted webhook delivery via curl with a valid HMAC; verify the
  job lands in the audit log within N seconds. The full happy path.
- Hot reload via file edit + `kubectl exec ... kill -HUP 1` (or
  `docker exec ... kill -HUP 1` for plain Docker). Verify the dashboard
  reflects the new config and ops chat got nothing because no Tier 3
  fields changed.

## Where tests live

```
packages/<pkg>/test/<unit>.test.ts          Layer 1 unit tests
packages/<pkg>/test/integration/*.test.ts   Layer 2, scoped to one package
tests/integration/*.test.ts                 Layer 2, cross-package
scripts/test-e2e.sh                         Layer 3 smoke
```

`*.test.ts` is the discovery convention. Anything else is fixtures or
helpers.

## How to run

```bash
pnpm test                                                 # Layer 1 + Layer 2
pnpm --filter @aegis/core test                            # one package
node --import tsx --test packages/core/test/q.test.ts     # one file
./scripts/test-e2e.sh                                     # Layer 3 smoke
```

## Discipline

Backfill is fine for *unit* tests. We are not TDD. Aegis is mid-refactor;
demanding tests-first would tank progress on the inner layer.

What we do require:

- **State machines and pure functions get unit tests** when introduced
  or meaningfully changed. The Layer 1 list is the floor, not the
  ceiling.
- **Adapters that talk to a network protocol get integration tests
  before merge.** Webhook signature paths, HTTP intake, MCP wiring -
  these are not Layer 1 candidates and they do not get to ship without
  Layer 2 coverage.
- **Bug fixes get a regression test** when the bug was caught in
  production or by review. Test names the bug, not the fix.
- **Refactors do not need new tests** if behavior is unchanged. They
  must keep existing tests passing.
- **Smoke must be green before any release tag.** No exceptions.

We do **not** require:

- Tests for adapter glue code that is just wiring.
- Tests for one-line getters.
- Coverage thresholds. Quality is measured by "did the test catch real
  bugs", not "did we hit 80%".

## Tradeoff: backfill vs TDD

TDD shortens the feedback loop on small changes and forces you to think
about the API before the implementation. It also slows down exploratory
work, which is what most of Aegis is right now. We chose backfill so the
refactor velocity stays high. We may revisit if a class of bug starts
recurring that TDD would have caught (signature thrash, off-by-one on
boundaries).

Note: backfill applies to Layer 1 only. Layer 2 and Layer 3 are not
optional regardless of feature timing.

## Tradeoff: real SQLite vs in-memory mock

Queue tests use a real SQLite database in a tempfile, one per test.
This is slower than an in-memory mock but tests the WAL behavior,
indexes, and `ALTER TABLE` forward-compat that the Queue depends on. A
mock would catch logic bugs but not the things that bite in production
(WAL not journaled, index missing, an ALTER racing with a query).
