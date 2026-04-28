# ADR 0005 — Polling for MVP; webhooks later

**Status:** Accepted

## Context

GitHub / GitLab can be monitored by polling the REST API or by receiving
webhook events. Webhooks are lower-latency and API-friendlier; polling is
simpler to deploy.

## Decision

**MVP:** polling only. Every code-host adapter implements
`pollPullRequests(since)`.

**Path to webhooks (P3):** every adapter optionally implements
`subscribe(handler)`. Core spins up an embedded webhook HTTP server and
prefers `subscribe` when present.

## Rationale

- Polling works from anywhere — no ingress, no public URL, no
  signature verification. Users can run Aegis behind a corporate NAT on
  day one.
- Webhook wiring (webhook URL registration, secret management,
  signature verification, replay handling) is non-trivial and would
  delay P1.
- The `pollPullRequests(since)` / `subscribe(handler)` split means **the
  adapter SPI does not change** when webhooks are added later.

## Consequences

- Review latency ≈ polling interval (default 60s). Acceptable for MVP.
- GitHub API rate budget: with 60s polling on ~50 repos, well under the
  REST budget even on a single PAT.
- Documented expectation: P3 adds webhook support; users migrating to it
  don't change config semantics, just the adapter's connection mode.

## Alternatives rejected

- **Webhook-only from day one.** Rejected — complexity tax too high for
  first-mile users.
- **Polling forever.** Rejected — GitHub/GitLab rate limits become a real
  constraint at >200 repos and poll intervals < 30 s.
