# ADR 0015: Config hot reload

## Status

Accepted.

## Context

Earlier docs (and the original CONFIGURATION.md) said hot reload was a
post-MVP concern: edit `aegis.config.ts`, restart the container, done. That
was acceptable while we were still finding the right shape of the system.

Production deployment changed the calculus. Helm mounts the config as a
ConfigMap. Operators expect to `kubectl edit configmap` and have changes take
effect within seconds, not at the next deployment. Single-replica SQLite
also makes restarts comparatively expensive (warm caches, in-flight HTTP
connections, MCP socket handshake to Synopsis).

A second motivation came from the multi-provider LLM work: with a
`customProviders` map in config, operators want to add a provider, alias it
in chat, and use it without bouncing the process. Forcing a restart for
every config edit makes the system feel rigid in a way that doesn't match
how it's supposed to be used.

## Decision

Add structured hot reload.

### Tier classification

Each top-level field and each adapter spec key is classified as Tier 1, Tier
2, or Tier 3.

- **Tier 1+2** are hot-reloadable. The supervisor applies them to live
  components without restart. The boundary between 1 and 2 is operational:
  Tier 1 is "swap a value" (provider, severity filter, log level); Tier 2 is
  "swap a value and reconcile" (repo lists). They share the same code path.
- **Tier 3** requires a restart. Examples: HTTP port, dbPath, adapter
  identity (host/org/tokenEnv), adding or removing a whole adapter.

The full per-field table lives in `docs/CONFIGURATION.md`.

### Reload mechanism

A new `ConfigStore` class in `@aegis/core`:

1. Owns the current validated `AegisConfig`.
2. Watches the config file with `fs.watchFile` (poll-based, 2s interval, 2.5s
   debounce). Polling beats `fs.watch` for k8s ConfigMap atomic-swap
   semantics: kubelet replaces the visible file via a symlink swap, and edge
   triggers can miss it.
3. Listens for `SIGHUP`.
4. Exposes a `reload(trigger)` method called by chat (`@aegis reload`).
5. Loads the new config via a CLI-injected loader (cache-busting `require`
   so the user-config module is re-evaluated).
6. Validates with the existing Zod schema. Validation failure keeps the old
   config and posts a notice to ops chat.
7. Computes a structured `ChangeSet` that classifies changes by tier and
   collects per-adapter specs.
8. If any Tier 3 field differs, refuses the reload as a whole, surfaces the
   refusal on the dashboard and ops chat, and keeps the old config.
9. If only Tier 1+2 changes are present, swaps the live config and
   dispatches the `ChangeSet` to subscribed components.

### Adapter spec contract

Each adapter extends `CodeHostAdapterBase` or `ChatAdapterBase` (new) and
implements:

- `getSpec(): { type, id, data }` - declared shape used for diffing.
- `tier3SpecKeys: ReadonlySet<string>` - which keys force a restart.
- `applySpec(next)` - absorb Tier 1+2 changes into running state.

The base class supplies the diff algorithm. ConfigStore reads `getSpec()` on
both the live adapter and the freshly-constructed throwaway from the new
config, classifies each differing key, and either calls `applySpec` (Tier
1+2) or marks the reload as Tier 3 refused.

### Live vs throwaway adapters

When the config file is re-evaluated, `defineConfig` runs adapter factory
calls again, producing fresh adapter instances. Those throwaways are not
init'd (no secrets, no octokit). The supervisor uses them only for diffing;
the **live** adapters (initialized at startup) keep running and absorb
spec changes via `applySpec`.

This means the live adapter list is stable across reloads. Adding or
removing an adapter is therefore Tier 3 - the live list cannot be safely
mutated without process state changes (HTTP route registration, init
lifecycle, kv store namespace allocation).

### Tier 3 deferral

Tier 3 hot reload (adapter add/remove, port rebinding) is intentionally out
of scope for the initial release. The work to do it safely - rebinding
sockets, recovering pending webhooks, atomic adapter swap - is its own
project. Operators get clear refusal messages with the affected fields, and
restart when ready. The queue is durable, so no work is lost.

### In-flight job policy

When a repo is removed from `codeHosts[*].repos`:

- In-flight jobs for that repo run to completion. The LLM call has already
  been started; aborting wastes the spend.
- Polling stops immediately - the next poll cycle iterates the new repo set.
- Webhook events for the removed repo are dropped at the adapter (the
  `repos` set check rejects them).
- Queued-but-not-started jobs for the removed repo are not cancelled. They
  will retry until the queue retry budget is exhausted, then DLQ. This is
  consistent with how transient adapter failures are handled, and avoids
  silent data loss if the removal was a config typo.

When a `customProviders` entry is removed and a persisted model override
points at it:

- The override is dropped.
- Aegis falls back to `agent.provider/model`.
- Ops chat is notified.
- A warning is logged.

## Consequences

### Positive

- Operators can edit `aegis.config.ts` (or a mounted ConfigMap) and see
  changes within seconds without bouncing the process.
- Multi-provider LLM setups can be tuned at runtime: add Vultr, switch via
  chat, remove the day after.
- The dashboard shows the reload state, so it's obvious when a Tier 3 change
  is pending.
- Ops chat gets a notification on every refusal/error, so failures aren't
  silent.

### Negative

- Adapter authors must implement `getSpec`/`applySpec` and declare
  `tier3SpecKeys`. Base classes minimize boilerplate, but the contract is
  not optional.
- The mental model is more complex: not every field is hot-reloadable,
  and the table in CONFIGURATION.md becomes load-bearing documentation.
- Reload concurrency is serialized - a slow reload (long applySpec)
  blocks the next one. In practice, applySpec is fast (set diffs, no IO),
  but a poorly-implemented adapter could regress this.

### Risks

- **k8s ConfigMap atomic swap.** `fs.watchFile` with `interval: 2000` is
  the path that survives this; using `fs.watch` would silently drop events.
  The implementation is locked to the polling variant.
- **Module cache.** The CLI uses `delete require.cache[resolved]` before
  re-importing. Transitive imports (e.g. `@aegis/core`) stay cached, which
  is desired - we only want to re-evaluate the user's config file. A
  consequence: the user cannot rely on a transitive import in their config
  re-evaluating on reload. Document this.
- **Config validation that is correct but wrong.** The schema cannot detect
  a typo'd repo name or an unreachable webhook URL. Operational mistakes
  surface on the next poll/event and end up in the audit log; they don't
  block reload.

## Alternatives considered

1. **Keep restart-only.** Rejected: production demand is real, and
   single-replica SQLite makes restarts costly enough that the friction
   matters.
2. **Auto-exit on Tier 3 change so the orchestrator restarts.** Rejected:
   surrenders a working process to a config typo. With refuse-and-keep, the
   operator sees the warning and decides when to restart.
3. **Declarative config (JSON/YAML data only, no factory calls).** Rejected:
   would force a config-schema break and lose the typed factory ergonomics
   `defineConfig` provides today.
4. **Per-adapter hot-reload opt-in.** Rejected: makes the contract optional
   and unpredictable. Better to require all first-party adapters to support
   it; third-party adapters that skip it appear as Tier 3 always (the diff
   ends up empty since `getSpec` is missing).

## Implementation notes

- File: `packages/core/src/config-store.ts`. ConfigStore + ChangeSet type +
  pure `computeChangeSet(old, new)`.
- File: `packages/sdk/src/adapter-base.ts`. CodeHostAdapterBase,
  ChatAdapterBase, SpecDiff, SpecApplyOutcome.
- All four first-party adapters migrated.
- Worker: `applyConfig(next)` rebuilds semaphores when caps change, drops
  saved overrides whose customProvider was removed.
- Dashboard: new "Last reload" banner + "Restart required" warning banner
  driven by `ConfigStore.getStatus()`.
