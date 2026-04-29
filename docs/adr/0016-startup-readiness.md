# ADR 0016: Startup readiness contract

## Status

Accepted.

## Context

Aegis composes three subsystems whose readiness is staggered:

1. SQLite state (queue, audit, KV). Synchronous on construction. Always
   ready by the time the rest of the boot continues.
2. Synopsis daemon. Spawned as a child process. The cold scan of the
   workspace dominates startup time and is highly variable: tens of
   seconds for a small fleet on fast hardware, several minutes for a
   20-service .NET fleet on a constrained VM (NuGet restore, Roslyn
   parsing, project resolution).
3. MCP client. Opens a Unix socket to Synopsis. Cheap, but only after
   Synopsis is up.

Before this ADR, the system declared itself "running" the moment the
HTTP server bound its port. Webhooks could arrive within milliseconds
of process start. The worker pool would then claim those jobs and call
into MCP, which had not yet connected. Jobs failed, retried, eventually
DLQed. Operationally noisy on every cold boot, and worse on every Helm
rolling restart since the entire fleet of subscribed repos generates
events when GitHub re-delivers backlog.

The Helm chart had no startupProbe at all - only a livenessProbe with a
60-second start period. On a slow boot the pod entered the failed
liveness loop and got killed before Synopsis finished its cold scan.

## Decision

Introduce an explicit "ready" gate that must be set by all three
subsystems before Aegis accepts work.

### The gate

A small `ReadinessGate` in `@aegis/core` tracks three named flags:
`sqlite`, `synopsis`, `mcp`. Each is set once, by the subsystem that
becomes ready. The gate exposes `isReady(): boolean` and `pending():
string[]` for diagnostics. The gate is in-process state (no SQLite
persistence) - on restart everything starts unready and re-converges.

### Behaviors gated on readiness

While `isReady()` is false:

- `/healthz` returns 503 with `{ "status": "not-ready", "pending":
  [...] }`.
- The HTTP webhook router returns 503 with `{ "status": "starting" }`
  to all inbound POSTs.
- The polling loop does not start. The first poll cycle runs after
  ready.
- The dashboard shows a "Starting" banner listing the pending
  subsystems. Reuses the existing reload-banner component.

A single boolean `isReady()` controls all four. There is no per-
subsystem partial readiness (e.g. "MCP up but Synopsis cold" is not a
distinct state).

### Helm probes

The chart already has `livenessProbe` and `readinessProbe`, both
pointing at `/healthz`. The new addition is a `startupProbe` that
suppresses both during the cold-scan window. Once `/healthz` starts
returning 503 during the not-ready window, the existing readinessProbe
pulls the pod out of Service rotation automatically; the new
startupProbe ensures kubelet does not kill the pod for slow boot. The
three probes compose: startup (boot tolerance), readiness (traffic
gating), liveness (crash detection).

`startupProbe` defaults: `initialDelaySeconds=10`, `periodSeconds=10`,
`failureThreshold=60`. Total tolerance: 10 minutes.

## Consequences

### Positive

- Cold-boot noise is gone. Webhook events delivered while Synopsis is
  still scanning return 503; GitHub and GitLab retry 5xx automatically,
  so the events are not lost.
- The kubelet has a deterministic signal for "the pod is up": all three
  subsystems converged. No more guessing whether the long initial scan
  has completed.
- Operators get a clear dashboard banner during boot instead of
  watching the queue mysteriously fill with failures.

### Negative

- Webhook deliveries during a deploy show as failed retries in the
  upstream UI (red dots in the GitHub webhooks page). A first-time
  operator may panic. The dashboard banner partly compensates but does
  not appear in the upstream's UI.
- The gate is in-process. A short pod restart cycles through "ready"
  → "not-ready" → "ready" multiple times. We accept this; the
  alternative (persisting readiness across restarts) is incoherent
  because the new process has its own subsystems to bring up.

### Risks

- **Wrong probe defaults.** `failureThreshold=60` covers the 20-service
  fleet on a 4-vCPU VM. A 100-service fleet on a 1-vCPU VM may exceed
  it. The default is documented as "raise it for larger fleets."
  Underestimate causes flap; overestimate costs nothing meaningful at
  boot.
- **Subsystem hangs without setting its flag.** If Synopsis spawns but
  never emits the `MCP server listening` line (e.g. crashes early
  during scan), the gate never opens. The `livenessProbe` does not
  fire because the startup probe is still active. Eventually the
  startupProbe `failureThreshold` is exhausted and the pod restarts.
  This is the right behavior - we want a noisy failure signal, not a
  silent hang.

## Alternatives considered

1. **Buffer inbound webhooks during not-ready, replay once ready.**
   Rejected. Adds an in-memory loss surface (process crash during
   buffering loses events the upstream has moved past). Adds replay
   logic with its own complexity. The upstream retries on 5xx for free.
   We may revisit if we onboard a host without 5xx retry semantics, or
   if buffering becomes cheap because we add a durable inbound queue
   for other reasons. The tradeoff is documented in ARCHITECTURE.md
   "Tradeoff: 503 vs buffer-and-replay".

2. **Per-subsystem partial readiness.** Deferred. There is no usable
   middle state today: webhooks need MCP, polling needs MCP, dashboard
   needs everything. Splitting the gate adds branching for no
   real-world benefit yet. We may revisit when a degraded mode (e.g.
   answer chat graph queries from a cached graph snapshot while MCP
   reconnects) becomes a real operator request.

3. **Make the worker loop tolerant of MCP not-yet-connected (retry
   transparently).** Rejected. The worker is the wrong place to wait
   for boot - it should run jobs, not poll for infrastructure. Surface
   readiness at the door (HTTP, polling), not deep in the worker.

4. **Couple readiness to the Helm livenessProbe instead of adding a
   startupProbe.** Rejected. liveness is for ongoing health, not boot.
   Conflating them either makes liveness too lax (slow crash detection
   forever) or startup too strict (flap loops on cold scan).

## Implementation notes

- File: `packages/core/src/readiness.ts`. New `ReadinessGate` class.
- File: `packages/core/src/http-server.ts`. `/healthz` checks the gate;
  webhook router checks the gate before dispatching.
- File: `packages/cli/src/serve.ts`. Construct gate; mark `sqlite`
  immediately after Queue construction; mark `synopsis` in the
  Supervisor `onReady` callback; mark `mcp` after `mcp.connect()`
  resolves. Polling loop starts only after ready.
- File: `packages/core/src/dashboard.ts`. New `startup` field on
  DashboardData; banner above the existing reload banner.
- File: `helm/aegis/templates/deployment.yaml`. Add `startupProbe`.
- File: `helm/aegis/values.yaml`. Expose probe values for operator
  tuning.
