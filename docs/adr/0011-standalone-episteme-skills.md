# ADR 0011 — `dotnet-episteme-skills` stays standalone

**Status:** Accepted

## Context

Aegis needs the Synopsis binary and the `dotnet-techne-*` skills, both of
which live in `dotnet-episteme-skills`. We could either:

- (a) Vendor them into the Aegis repo (copy or submodule).
- (b) Keep episteme-skills a standalone repo, consumed by Aegis at build
  time.

## Decision

**(b)** — two independent repos. Aegis consumes episteme-skills during
Docker image build; `dotnet-episteme-skills` has **zero** runtime
dependencies on Aegis.

## Rationale

- `dotnet-episteme-skills` has prior users: Claude Code operators,
  developers running skills manually, other agents. Vendoring into Aegis
  would deny them visibility into ongoing changes.
- Breaking changes to Synopsis or to a skill should be considered
  carefully as they affect all consumers, not just Aegis. Keeping the
  repos separate enforces that discipline.
- Clean versioning: Aegis pins a specific episteme-skills tag per release.
  Independent releases are possible (bug-fix a skill without bumping
  Aegis).

## Consequences

- Aegis Dockerfile copies from `../dotnet-episteme-skills/...` in a build
  stage.
- Dev workflow requires both repos checked out as siblings (documented in
  [REPO_LAYOUT.md](../REPO_LAYOUT.md)).
- A `scripts/link-skills.sh` in Aegis symlinks sibling skills during
  development; the `skills/` dir in Aegis is gitignored.
- The soul skill (`dotnet-techne-cross-repo-impact`) is **authored** in
  episteme-skills, not Aegis, even though Aegis is its primary user.

## Alternatives rejected

- **Submodule.** Rejected — git submodules are a footgun for everyone
  except the original author.
- **Merge the repos.** Rejected — would regress episteme-skills' existing
  standalone use cases.
- **Publish episteme-skills as an npm package.** Doesn't make sense —
  the skills are markdown + a .NET binary, not JS.

## Rules for the split

1. episteme-skills never `import`s from Aegis.
2. Aegis never modifies episteme-skills source from its own pipeline;
   PRs go to episteme-skills for any change.
3. When a Synopsis contract changes (MCP tool added, schema bump), the
   change ships in episteme-skills first, then Aegis updates its pin.
