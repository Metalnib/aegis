# ADR 0002 — Single Docker image

**Status:** Accepted

## Context

The obvious way to package Aegis is multi-container: Synopsis daemon in
one, Aegis worker in another, Redis for the queue, git-sync sidecar. This
is idiomatic k8s but heavy for users who want to try it out or run it on
a single VM.

## Decision

Aegis ships as **one Docker image** with no external dependencies.

## Rationale

- Users can `docker run` and have a working bot in one command.
- No Redis / Postgres / k8s knowledge required.
- Synopsis and Aegis share a filesystem inside the container, so Unix
  sockets and file-based state are cheap and safe.
- Aegis's scale ceiling is bounded by LLM throughput, not by infra
  complexity. One container is enough for single-org fleets up to
  ~100 repos.

## Consequences

- Aegis (Node) supervises the Synopsis child process; no external
  supervisor.
- SQLite instead of Redis for the queue.
- Git-sync runs as an internal loop, not a sidecar.
- Image is larger (~250 MB compressed) than a pure-Node image because it
  includes the Synopsis .NET binary.
- Horizontal scaling (multiple workers across nodes) deferred to P3+; the
  queue contract remains Redis-swappable.

## Alternatives rejected

- **Multi-container compose.** Cleaner separation but higher barrier to
  adopt. Post-MVP `docker-compose.yml` with external services becomes an
  option for users with existing infra, without requiring it by default.
- **Split Synopsis into its own image consumed by multiple Aegis instances.**
  Better for multi-tenant, but out of MVP scope.
