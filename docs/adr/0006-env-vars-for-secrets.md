# ADR 0006 — Env vars for secrets (MVP)

**Status:** Accepted

## Context

Aegis needs secrets: LLM API key, GitHub/GitLab tokens, Slack tokens,
Google Chat service accounts. Delivery options: env vars, mounted files,
Docker secrets, k8s Secret objects, Vault.

## Decision

**MVP:** env vars. Secrets are passed via `docker run -e ...`.

**Post-MVP TODO:** extend `SecretsProvider` to fall back to
`/run/secrets/<key>` for Docker and k8s secret mounts. Vault integration
via the same interface.

## Rationale

- Env vars are the universal lowest-common-denominator.
- Works identically on a dev laptop, a single VM, docker-compose, and k8s
  (via `env:` in the Deployment).
- Keeps `aegis.config.ts` committable — it references env-var names, not
  values.
- The `SecretsProvider` abstraction lets us upgrade the backend without
  touching any adapter code.

## Consequences

- `docker inspect` exposes secrets to anyone who can read container
  metadata — acceptable for MVP single-tenant deployments, documented as a
  limitation.
- `ps e` could show secrets to anyone on-box — mitigated by containerised
  deployment (container's namespace is isolated).
- Production deployments in security-conscious orgs will need the
  post-MVP secret path before they can adopt.

## Non-goals

- Rotating secrets at runtime — requires restart in MVP.
- Encrypted secrets at rest inside the container — out of scope.

## Migration path (post-MVP)

1. Introduce `SecretsProvider.readFile(path)` backend.
2. Adapters that previously used `ctx.secrets.get("GITHUB_TOKEN")` switch
   transparently: provider tries env var first, then file-based fallback.
3. Document the file-mount convention (`/run/secrets/<key>`).
4. No config schema changes required.
