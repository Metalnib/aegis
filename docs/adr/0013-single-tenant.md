# ADR 0013 — Single-tenant deployment (MVP)

**Status:** Accepted

## Context

Aegis could run as:

- (a) One deployment per org, one config, one SQLite DB.
- (b) Multi-tenant: one deployment serving multiple orgs with isolated
  configs and data.

## Decision

**MVP:** (a) — single-tenant per container. Multi-tenant deferred
(see S5 in [ROADMAP.md](../ROADMAP.md)).

## Rationale

- Single-tenant keeps the config, queue, and credentials simple.
- Most teams will run one Aegis per org or per service group. Deploying
  multiple containers is cheap in the single-image model.
- Multi-tenant adds non-trivial authz, quota, config isolation, and
  credential scoping. Not worth the MVP budget.

## Consequences

- Config file has no "tenant" dimension.
- SQLite DB is per-deployment.
- Adapter credentials are global across all repos/channels in a
  deployment.
- Orgs wanting isolation run multiple containers.

## Path forward (S5)

- Introduce `tenants: [{ id, codeHosts, chats, ... }]` in config.
- Partition SQLite DB by tenant id (schema prefix or separate files).
- Secrets provider gains a tenant dimension: `ctx.secrets.get(key, tenant)`.
- Chat adapters gain a `tenantRouting` resolver (channel → tenant).
- Worker pool globally sized; jobs tagged by tenant.

Not a breaking change to the SPI — multi-tenant is additive.

## Alternatives rejected

- **Multi-tenant from day one.** Rejected — ship fast, refactor into
  tenancy when there's a real second tenant.
