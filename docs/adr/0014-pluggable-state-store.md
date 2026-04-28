# ADR 0014 — Pluggable state store for Synopsis daemon

**Status:** Accepted (interface in P0; SQLite impl deferred to pre-MVP
watch item)

## Context

The Synopsis daemon holds an in-memory combined graph (see ADR 0008 and
[SYNOPSIS_CHANGES.md § M2](../SYNOPSIS_CHANGES.md#m2-per-repo-incremental-re-merge)).
Two persistence questions arise:

1. **Cold-start / crash-recovery** — on restart, must the daemon rescan
   every repo from source, or can it load a persisted snapshot?
2. **Export formats** — users and external tools consume `graph.json`,
   CSV, and JSONL today. These must keep working.

Three backend options were considered:

- **JSON file** (status quo for `scan`/`watch`) — full dump per rewrite.
  Simple, human-readable, no dependency cost. Slow for large fleets
  because every reindex rewrites the whole file.
- **SQLite** — incremental upsert per node/edge, fast cold start, queries
  possible without loading everything into memory. Adds
  `Microsoft.Data.Sqlite` (~1 MB) and schema-design work.
- **Memory only** — no persistence; always rescan on startup. Fine for
  Aegis MVP (startup is seconds with a warm filesystem cache) but loses
  crash-recovery locality.

## Decision

Define a narrow persistence interface in P0. Ship **one** implementation
(`JsonFileStateStore`). Leave the interface open for a SQLite
implementation later without touching any callers.

```csharp
public interface IGraphStateStore
{
    Task<CombinedGraphSnapshot?> LoadAsync(CancellationToken ct);
    Task SaveRepositoryAsync(string repoPath, ScanResult result, CancellationToken ct);
    Task<IReadOnlyList<RepositoryRecord>> ListRepositoriesAsync(CancellationToken ct);
}
```

- `CombinedGraph` holds a reference to one `IGraphStateStore`, calls
  `SaveRepositoryAsync` after every successful `ReplaceRepository`.
- On daemon start: `LoadAsync` restores whatever the store has; missing
  repos get rescanned lazily.
- Export (`synopsis export json|csv|jsonl`) is unchanged — it reads the
  live in-memory graph, not the store.

## Implementations

| Impl | Status | Notes |
|---|---|---|
| `JsonFileStateStore` | P0 | Writes one JSON file per repo under `<state-dir>/repos/<slug>.json`, plus an `index.json` with repo → slug mapping. Full rewrite per reindex; atomic via rename. |
| `SqliteStateStore` | Post-MVP (S1 in roadmap, **flagged pre-MVP watch item**) | Incremental per-node upserts. Schema TBD. Triggered if JSON rewrite cost becomes a bottleneck at scale. |
| `MemoryStateStore` | P0 | No-op; used by `synopsis mcp --root ...` when the daemon is ephemeral. |

## Rationale

- **Narrow interface.** Three methods; no clever queries, no subscriptions.
  Easy to test with a mock.
- **Additive, not a rewrite.** Existing `ScanResult` / JSON serialisation
  code stays. The store wraps them.
- **Export formats untouched.** JSON/CSV/JSONL export happens from the
  live graph; the store is a cold-recovery aid, not a query surface.
- **SQLite can drop in later.** When the JSON cost shows up in a profile
  (large fleet, frequent reindex), add `SqliteStateStore` and flip the
  default. No caller changes.

## Consequences

- P0 ships with one extra abstraction and one extra class
  (`JsonFileStateStore`). Small cost.
- The Synopsis daemon's cold start in the Aegis Docker image loads from
  `<state-dir>/repos/*.json` — typically sub-second for a 20-repo fleet.
- If a PR lands before the SQLite impl and the JSON rewrite dominates a
  reindex, we elevate SQLite to its own mini-phase between P0 and P1.

## Why flagged pre-MVP

Raised by Metalnib during API contract review: if a real fleet has
40+ repos and busy hours see multiple reindexes per minute, the JSON
full-rewrite cost could exceed the incremental scan cost itself. The
interface lets us measure in P0 and decide mid-flight.

## Alternatives rejected

- **SQLite in P0.** Rejected — adds dependency + schema design to an
  already full phase. Interface-first is cheap insurance.
- **No persistence at all.** Rejected — every daemon restart rescanning
  every repo makes crash-recovery unnecessarily expensive once fleets grow.
- **Embedded key-value (LevelDB, LMDB).** Rejected — extra native
  dependencies, marginal win over SQLite, smaller .NET ecosystem.

## Open questions

- Should `JsonFileStateStore` write atomically per file (temp-rename) or
  via a journal? P0 will use temp-rename for simplicity; revisit if
  corruption is observed.
- Where does `<state-dir>` live in the Aegis container? Current plan:
  `/var/lib/aegis/synopsis/`, alongside the SQLite queue. Confirmed in
  [DEPLOYMENT.md](../DEPLOYMENT.md).
