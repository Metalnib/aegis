# ADR 0010 — Inline PR comments for the markdown report (MVP)

**Status:** Accepted

## Context

The `cross-repo-impact.md` report can be:

- (a) Posted as an inline comment on the PR.
- (b) Uploaded as a Gist (GitHub) / Snippet (GitLab) and linked from a
  short PR comment.
- (c) Written to a dedicated `aegis-reports` repo keyed by PR number.

## Decision

**MVP:** (a) — inline PR comment.

**Post-MVP TODO:** (b) — gist/snippet hosting as a configurable
alternative.

## Rationale

- Inline comments are searchable inside the code host and visible without
  clicking out.
- Works with zero extra permissions — the same token that posts review
  comments can post the report.
- Gists/Snippets need extra scopes, add an external link (CSP / blocklist
  issues inside some enterprises), and don't render in PR email
  notifications.
- A dedicated reports repo (c) is nice for audit but is infra sprawl for
  MVP; P3 adds the audit log which satisfies most of the same need.

## Consequences

- Reports can be large (multiple Critical findings). PR comment length
  limits apply (~65k chars on GitHub). Fixes:
  - Truncate at ~60k chars with a "... truncated, see next comment" marker.
  - Split into multiple comments if needed.
- Users who prefer cleaner PR threads can switch to gist hosting post-MVP.

## Alternatives rejected

- **Gist-only in MVP.** Rejected — extra scopes and unreliable rendering
  across enterprise setups.
- **Dedicated reports repo.** Rejected — infra sprawl; P3 audit log covers
  the audit use case.

## TODO (post-MVP)

- Add `reportHosting: "inline" | "gist"` option in `aegis.config.ts` per
  code-host adapter.
- Implement `gist({ ... })` helper that posts via the same token.
- Document token scope requirements.
