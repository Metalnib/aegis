# Skill: `dotnet-techne-cross-repo-impact`

The procedural recipe Aegis uses to detect breaking changes that cross
microservice boundaries and to flag whether a compatible fix exists
downstream.

Authored and maintained in
`dotnet-episteme-skills/skills/dotnet-techne-cross-repo-impact/`. Reusable
by any Claude-compatible agent; Aegis is its primary consumer.

## What this skill is not

This is **not** Aegis's identity or soul. Aegis's identity — who it is,
its defensive stance, its severity philosophy, its baseline tool-usage
principles — lives in [`../SOUL.md`](../SOUL.md) and is injected into the
agent's system prompt at every turn.

This skill is **procedural only**: when the soul's reflex to check
cross-repo impact fires, this skill tells the agent *how* to do it
precisely — which MCP tools to call, in what order, with what arguments,
and how to format the output.

The split matters:

- **`SOUL.md`** — Aegis's identity, always present. Sets the default stance:
  "every PR review starts with cross-repo awareness."
- **This skill** — The recipe Aegis follows when that stance triggers work.
  Deterministic, testable, LLM-independent where possible.

## Purpose

Given a .NET PR, answer:

1. Does this change break any **other** repo that depends on this repo?
2. If yes — is there already a compatible PR open in the affected repos?
3. How confident are we, and how urgent is it?

## When the skill triggers

The skill is auto-invocable by the agent when the PR diff touches any of:

- Public types, methods, or records in an assembly referenced by other
  projects (detected via Synopsis `cross_repo_edges`).
- Controllers, minimal API endpoints, or route constants.
- EF Core entity classes, `DbContext` overrides, `ToTable` / `HasColumnName`
  calls, migration files.
- DTO classes marked with `[JsonPropertyName]`, `[DataMember]`, or used by
  any `HttpClient` caller (direct or via Refit).
- `PackageReference` in a `.csproj` or `Directory.Packages.props` that
  bumps a shared library version.
- `appsettings.json` keys referenced as `ConfigurationKey` nodes.

The trigger is expressed in SKILL.md frontmatter `description` so Claude's
auto-invocation heuristic picks it up; it is also enforced by the agent
harness as a pre-check before main review skills run.

## Preconditions

- Synopsis daemon is reachable on the configured MCP socket.
- The repo at `headSha` is checked out under `/workspace/<repo>`.
- `synopsis reindex_repository` has been invoked for this repo (the agent
  harness does this before the skill runs).
- `gh` / `glab` CLIs (or the active code-host adapter) are available as
  tools for compatible-PR search.

If any precondition fails, the skill emits a **degraded report** with
`severity: Unknown` and an explicit reason — it never silently skips.

## Procedure

1. **Compute classified deltas** — call `synopsis breaking_diff` with the
   base and head graphs. Receive a typed list of `BreakingChange` records.

2. **Filter to cross-repo impact** — for each change, query
   `synopsis blast_radius(symbol, direction=upstream)` and retain only
   changes whose upstream callers include nodes with `repositoryName !=
   prRepo.name`. Group hits by downstream repo.

3. **Search compatible PRs** — for each affected downstream repo, call the
   code-host adapter's `searchOpenPrs` with:
   - Keyword: the affected symbol's display name.
   - Branch pattern: `fix/**<symbol>**`, `chore/**<pr-number>**` if
     convention-linked.
   - Opened in the last 30 days.
   Mark each finding with `compatiblePrUrl` or `NONE FOUND`.

4. **Apply severity rules**:

   | Rule | Severity |
   |---|---|
   | Wire-format / DB break AND no compatible PR found | **Critical** |
   | Wire-format / DB break AND compatible PR found (unmerged) | **High** |
   | Public-API signature break AND no compatible PR | **High** |
   | Public-API signature break AND compatible PR | **Medium** |
   | Signature change, only same-repo callers | **Medium** |
   | Internal or fully same-repo impact | **Low** |
   | Ambiguous + no callers resolved | escalate to review, `Low` |

   Severity is "No compatible PR" escalates the classifier's output by one
   level; it never down-escalates.

5. **Render the report** — produce `cross-repo-impact.md` in the strict
   schema below.

6. **Produce structured findings** for the outer agent, so chat adapters
   can notify on criticals without re-parsing markdown:
   ```json
   {
     "severity": "Critical",
     "criticalCount": 2,
     "findings": [
       { "kind": "EndpointRouteChange", "symbol": "...", "recommendation": "BLOCK" }
     ]
   }
   ```

## Output schema — `cross-repo-impact.md`

```markdown
# Cross-repo impact — PR <org>/<repo>#<n>

**Aegis** · `<timestamp>` · head `<sha>`

## Summary
- Critical: <n> | High: <n> | Medium: <n> | Low: <n>
- Affected downstream repos: <n>
- Compatible downstream PRs found: <n>/<total affected>

## Findings

### 1. <Symbol or endpoint or entity> — <Severity>
- **Kind:** `ApiSignatureChange` | `DtoShapeChange` | `EndpointRouteChange`
  | `EndpointVerbChange` | `EntityColumnChange` | `TableRename`
  | `NugetVersionBump` | `SerializationContractChange`
- **Change:** `<one-line before → after>`
- **Source:** `<file>:<line>`
- **Affected repos:** `<repo-b>`, `<repo-c>`
- **Callers (top 5):**
  - `<repo-b>/src/.../BService.cs:42` — `Exact`
  - `<repo-c>/src/.../CClient.cs:108` — `Inferred`
  - ...
- **Constraints violated:** <plain text; e.g. "non-nullable DTO field removed",
  "route /orders/{id} → /v2/orders/{id} (v1 still advertised by svc-b's
  HttpClient)">
- **Compatible PR:** `<url>` | `NONE FOUND`
- **Confidence:** `High` | `Medium` | `Low` | `Unknown` (mirrors Synopsis
  certainty: Exact → High, Inferred → Medium, Ambiguous → Low,
  Unresolved → Unknown)
- **Warnings:** `<e.g. "DB migration missing in svc-b", "wire-format break
  for msgpack consumers", "ambiguous edge — manual review suggested">`
- **Recommendation:** `BLOCK` | `REQUIRE-COORDINATED-PR` | `FLAG` | `OK`

### 2. ...
```

## Severity rubric (procedural reference)

The authoritative rubric lives in [`../SOUL.md`](../SOUL.md). Duplicated
here only as a quick reference when reading the skill in isolation; if
they ever diverge, SOUL.md wins.

| Severity | Trigger |
|---|---|
| Critical | Wire-format / DB-schema break, cross-repo callers exist, no compatible PR |
| High     | Cross-repo API break (signature / contract / route), no compatible PR; OR wire-format break with compatible PR pending |
| Medium   | Cross-repo API break with a compatible open PR detected; OR signature change with callers all in same repo |
| Low      | Internal change; ambiguous edges without resolved callers |
| Unknown  | Synopsis unavailable or degraded input |

## Confidence mapping

Synopsis certainty flows through unchanged (same mapping as `SOUL.md`):

| Synopsis certainty | Skill confidence |
|---|---|
| `Exact`      | High |
| `Inferred`   | Medium |
| `Ambiguous`  | Low |
| `Unresolved` | Unknown |

When multiple certainties contribute to a finding, the skill reports the
**lowest** (weakest-link) confidence.

## Failure modes

| Situation | Behaviour |
|---|---|
| Synopsis daemon unreachable | Emit `severity: Unknown`, one-line reason, still run standard review skills |
| `breaking_diff` returns empty | Skip the skill, note "no breaking changes detected" in PR summary |
| Compat-PR search rate-limited | Mark each finding `compatible_pr: UNKNOWN`, escalate one severity level |
| LLM hallucinates a finding | Classifier-sourced `affectedNodes[]` always wins; skill must cite at least one graph node per finding |

## Skill hygiene

These are the skill-local invariants (not identity; those are in
`SOUL.md`). They constrain how the procedure executes:

- **Classifier-first citation.** Every finding must reference at least one
  row from `breaking_diff`'s classified output and at least one node or
  edge from `blast_radius`. The LLM binds findings to evidence; it never
  synthesises deltas the classifier did not produce.
- **One-pass severity.** Severity is computed once, from the classifier +
  compat-PR rules, and not re-interpreted when rendering the report.
- **Advisory output only.** The skill produces `BLOCK` /
  `REQUIRE-COORDINATED-PR` / `FLAG` / `OK` as recommendations. Gate
  enforcement is the code host's responsibility.

## Test fixtures

Authored alongside the skill under
`dotnet-episteme-skills/skills/dotnet-techne-cross-repo-impact/fixtures/`:

- `01-dto-field-removed-no-compat-pr/` → expected severity `Critical`
- `02-endpoint-route-change-with-compat-pr/` → expected severity `High`
- `03-internal-refactor/` → expected severity `Low`
- `04-nuget-bump-breaking-shared-lib/` → expected severity `Critical`
- `05-ambiguous-http-call-target/` → expected severity `Low` with
  `confidence: Low`, warning noted
- ... (min 10 for P0)

Each fixture contains:
- Synthetic `before.graph.json` and `after.graph.json`.
- Mock code-host adapter responses (compat-PR search results).
- `expected.md` — the golden report.

Test driver: simple CLI `aegis skill-test dotnet-techne-cross-repo-impact`
(P1) that runs all fixtures and diffs against `expected.md`.
