# ADR 0012 — Node supervises the Synopsis child process

**Status:** Accepted

## Context

Inside the single Aegis image, two processes run: the Node-based Aegis
worker and the .NET-based Synopsis daemon. Someone needs to supervise
Synopsis (restart on crash, forward signals, reap the child).

Options: s6-overlay, tini + bash script, systemd (too heavy),
Node-as-supervisor.

## Decision

**Node supervises Synopsis** as a child process via `child_process.spawn`.
No external supervisor; `tini` is used only as PID 1 for signal handling.

## Rationale

- Only one child process needs supervision — not worth a dedicated
  supervisor framework.
- Node can observe crash details (stdio capture, exit code) and decide
  restart policy in-band.
- No additional binary in the image.
- Aegis already has the lifecycle hooks (graceful shutdown, backoff) —
  extending them to cover Synopsis is small.

## Consequences

- `@aegis/core/supervisor` module handles: spawn, health-check loop,
  restart with exponential backoff, crash-loop detection (> N restarts in
  M minutes → give up, exit with error, container restarts).
- Dockerfile uses `tini` as `ENTRYPOINT` to reap zombies and forward
  signals cleanly to Node.
- Synopsis logs to stdout; Aegis logger re-emits them with an `[synopsis]`
  prefix to the container log.
- Graceful shutdown: SIGTERM → Aegis stops accepting jobs → waits for
  in-flight workers → SIGTERM to Synopsis → waits → exit.

## Alternatives rejected

- **s6-overlay.** Rejected — extra complexity and image size for one
  supervised process.
- **No supervision (let the container restart if Synopsis dies).** Rejected
  — would drop in-flight jobs and thrash the queue. The worker is stateful;
  the daemon alone should be restartable.
