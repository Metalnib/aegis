# ADR 0001 — Name: Aegis

**Status:** Accepted

## Context

We need a short, memorable name for the agent. The existing ecosystem uses
Greek-rooted names (`techne`, `episteme`), so a Greek name keeps the family
coherent.

Shortlist considered: Argos (hundred-eyed watchman), Kriterion (standard
of judgment), Pythia (Delphic oracle), Aegis (Zeus's shield).

## Decision

**Aegis (Αἰγίς)** — the shield of Zeus.

## Rationale

- The framing matches the job: guard the microservice fleet against
  breaking changes that cross repo boundaries.
- Fits the "critical mode" of the primary review skill — defensive, not
  prescriptive.
- One syllable, widely recognisable, no namespace collisions with known
  agent projects.

Pythia is held as the runner-up if we later spin a separate oracle-style
prediction agent (e.g. risk scoring pre-PR).

## Consequences

- All package names scoped `@aegis/*`.
- CLI binary is `aegis`.
- Runtime log prefix is `[aegis]`.
