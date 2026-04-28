# ADR 0009 — Deterministic breaking-diff classifier

**Status:** Accepted

## Context

The cross-repo impact skill needs classified breaking changes
(ApiSignatureChange, DtoShapeChange, EndpointRouteChange, etc.) to produce
a reliable report.

Two approaches:

- (a) Hand raw graph diffs (added/removed/changed nodes) to the LLM and
  let it classify.
- (b) Implement a deterministic classifier in Synopsis; LLM consumes
  typed output.

## Decision

**(b)** — deterministic classifier as `synopsis breaking-diff` CLI +
`breaking_diff` MCP tool.

## Rationale

- Classification is a pattern-matching task over graph deltas — it has a
  right answer. LLMs here add cost and jitter without improving accuracy.
- Deterministic output means the skill is testable with golden files,
  fixtures can cover edge cases, and CI can assert no regressions.
- Keeps the LLM's role to what it's best at: synthesising human-readable
  findings, tying causality, picking recommendations.
- The classifier is a natural home for future refinements (e.g. detecting
  nullable-reference changes, analyser-flagged patterns) without touching
  the LLM prompt.

## Consequences

- Extra implementation work in P0 (M4) — ~1–2 days plus fixtures.
- Fixture suite under `Synopsis.Tests/Fixtures/BreakingDiff/` becomes the
  authoritative regression surface.
- LLM prompt in the soul skill explicitly says: "do not re-classify;
  ground every finding in a classifier output row."

## Alternatives rejected

- **(a) LLM classifies from raw diff.** Rejected — loses reproducibility,
  complicates evaluation, and tempts the model to synthesise categories
  not in the schema.
- **Hybrid: classifier with LLM fallback for unclassified deltas.**
  Deferred — if we see "Other" deltas in the wild often, revisit; for now,
  tighten the classifier rules.
