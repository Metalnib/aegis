# Synopsis Changes (M1–M5)

All changes land in `dotnet-episteme-skills/src/synopsis`. Synopsis must
remain usable standalone (CLI, manual MCP via Claude Code); daemon mode is
additive.

Audit of current Synopsis: see `dotnet-episteme-skills/src/synopsis` at
the Aegis-target commit. Current capabilities covered in detail include
multi-repo discovery, cross-repo edges, certainty tagging, MCP tool surface,
and `WorkspaceScanner` pass pipeline — all reused as-is.

## M1. Daemon-safe MCP transport

**Goal:** Run one long-lived Synopsis process, accept many concurrent MCP
clients, over a non-stdio transport.

**Files touched:**
- `Synopsis/Mcp/IMcpTransport.cs` *(new)* — transport abstraction.
- `Synopsis/Mcp/StdioTransport.cs` *(new)* — current behaviour, extracted.
- `Synopsis/Mcp/UnixSocketTransport.cs` *(new)* — primary for Aegis single-image.
- `Synopsis/Mcp/TcpTransport.cs` *(new)* — future-proof for multi-container.
- `Synopsis/Mcp/McpServer.cs` — decouple from `Console.Open*`; accept-loop over `IMcpTransport`.
- `Synopsis/Commands/McpCommand.cs` — new flags: `--socket <path>`, `--tcp <addr>`; default unchanged (stdio).

**Design notes:**
- `ScanResult` is immutable after `WithAdjacency()`; concurrent reads are
  safe without locks.
- One `McpTools` instance per process; dispatch to it from N connection
  handlers.
- Writes (`reindex_repository`, see M3) serialize through a single writer
  channel to avoid graph-swap races.
- Each connection is its own JSON-RPC framing loop. Unix socket framing:
  newline-delimited (same as stdio) — no protocol change.

**Example:**
```
synopsis mcp --socket /var/run/aegis/synopsis.sock --watch /workspace
synopsis mcp --tcp 127.0.0.1:7878 --watch /workspace
synopsis mcp --graph graph.json                        # stdio, unchanged
```

**Tests:**
- Two clients issue `blast_radius` concurrently → both succeed.
- Client disconnect mid-request does not kill server.

---

## M2. Per-repo incremental re-merge

**Goal:** When one repo changes, re-scan only that repo and re-merge into
the combined in-memory graph without rescanning the others.

**Files touched:**
- `Synopsis.Analysis/Graph/CombinedGraph.cs` *(new)* — holds per-repo
  `ScanResult`s keyed by repo root path; lazily builds a merged view.
- `Synopsis.Analysis/Graph/CrossRepoResolver.cs` *(new)* — post-merge pass
  that recomputes `CrossesRepoBoundary` edges and resolves
  `ExternalEndpoint` HTTP calls against the combined set.
- `Synopsis.Analysis/Graph/IGraphStateStore.cs` *(new)* — pluggable
  persistence interface (see ADR 0014).
- `Synopsis.Analysis/Graph/JsonFileStateStore.cs` *(new)* — P0 impl:
  one JSON file per repo under `<state-dir>/repos/`.
- `Synopsis.Analysis/Graph/MemoryStateStore.cs` *(new)* — no-op impl for
  ephemeral daemons.
- `Synopsis.Analysis/WorkspaceScanner.cs` — add `ScanRepositoryAsync(repoPath, options)`
  returning just that repo's `ScanResult`.
- `Synopsis.Analysis/Roslyn/Passes/HttpCallPass.cs` — move cross-repo
  resolution into `CrossRepoResolver` so it's re-runnable post-merge.

**Design notes:**
- `CombinedGraph.ReplaceRepository(repoPath, scanResult)`:
  1. Store new scan result.
  2. Invalidate merged view.
  3. Re-run `CrossRepoResolver` on the union.
  4. Publish atomically (swap reference) so readers see either the old or
     the new graph, never a partial merge.
  5. Call `stateStore.SaveRepositoryAsync(repoPath, scanResult)` after the
     publish (fire-and-forget with error log; does not block readers).
- The resolver is the *only* component that reasons across repo boundaries;
  per-repo passes stay unchanged.
- Per-repo scan results are keyed by normalized repo root path.
- `IGraphStateStore` is narrow (three methods — load, save-one-repo,
  list-repos). See ADR 0014 for the full contract. Export formats
  (`synopsis export json|csv|jsonl`) are **not** routed through the store
  — they stream from the live in-memory graph, unchanged from today.

**Tests:**
- Scan workspace with repos A, B, C → baseline graph.
- Modify A, call `ReplaceRepository(A)` → same node count as full rescan,
  within tolerance for resolver-emitted edges.
- Concurrent reader during replace sees a consistent snapshot.
- Daemon restart: `JsonFileStateStore.LoadAsync()` reconstitutes the
  combined graph byte-identical (modulo timestamp fields) to the
  pre-restart state.
- `MemoryStateStore` + restart → empty graph (expected).

---

## M3. Push intake via MCP

**Goal:** The Aegis core tells the Synopsis daemon "repo X changed, rescan it."

**Files touched:**
- `Synopsis/Mcp/McpTools.cs` — add three tools:
  - `reindex_repository { path, ref? }` → rescan path, replace in combined graph, return delta stats.
  - `reindex_all { }` → rescan every repo in the workspace root (for cold recovery).
  - `list_repositories { }` → list tracked repos + last-scanned timestamp + head SHA.
- `Synopsis.Analysis/Graph/CombinedGraph.cs` — exposes `ReindexAsync(repoPath)`.

**Design notes:**
- Tool is async-capable but returns synchronously once scan completes (MCP
  JSON-RPC is one-shot). For long scans, agent reads `list_repositories`
  timestamps to decide staleness instead of polling mid-scan.
- Mutating tools go through the same dispatch as query tools; a simple
  in-process mutex serializes writes.
- `ref` parameter is metadata-only (recorded in graph); actual file state
  comes from the filesystem.

**Tests:**
- `reindex_repository` on unknown path → error response with clean message.
- `reindex_repository` then `blast_radius` against a new symbol → resolves.
- `list_repositories` reflects last-scan timestamps.

---

## M4(b). Breaking-change classifier

**Goal:** Turn structural graph diffs into tagged, severity-ranked breaking
changes that feed the soul skill deterministically.

**Files touched:**
- `Synopsis/Commands/BreakingDiffCommand.cs` *(new)* — CLI surface.
- `Synopsis.Analysis/Graph/BreakingChangeClassifier.cs` *(new)* — core logic.
- `Synopsis.Analysis/Model/BreakingChange.cs` *(new)* — data types.
- `Synopsis/Mcp/McpTools.cs` — expose as MCP tool `breaking_diff`.
- `Synopsis.Tests/BreakingDiffTests.cs` *(new)* — fixture-driven tests.

**Classification categories (MVP):**

| Kind | Detected by |
|---|---|
| `ApiSignatureChange` | Method node param/return type metadata change |
| `DtoShapeChange` | Entity or record field removal / type change |
| `EndpointRouteChange` | Endpoint node metadata `route` change |
| `EndpointVerbChange` | Endpoint node metadata `verb` change |
| `EntityColumnChange` | EF Entity → Table column mapping change |
| `TableRename` | Table node DisplayName change with stable ID history |
| `NugetVersionBump` | Package node `version` metadata change (requires M5) |
| `SerializationContractChange` | `[JsonPropertyName]`, `[DataMember]` attribute metadata change |

Each classified change carries:
- `affectedNodes[]` — graph node IDs touched.
- `severity` — `Critical | High | Medium | Low` per severity rubric.
- `certainty` — inherited from Synopsis node/edge certainty.
- `beforeSnippet`, `afterSnippet` — one-line summaries.

**Severity rubric (same as in architecture):**

| Severity | Condition |
|---|---|
| Critical | Wire-format or DB-schema break on a symbol with upstream callers in a different repo |
| High | Public-API signature change with cross-repo callers |
| Medium | Signature change with only same-repo callers, or cross-repo callers all ambiguous |
| Low | Internal change, or unresolved symbol with no known callers |

The classifier emits severity from the graph alone; the agent is responsible
for escalating to **Critical** if no compatible PR exists in the downstream
repo (the classifier doesn't know about PRs).

**CLI:**
```
synopsis breaking-diff <before.json> <after.json> [--json] [-o report.json]
```

**MCP tool:**
```json
{
  "name": "breaking_diff",
  "arguments": { "before": "<path>", "after": "<path>" }
}
```
(Paths resolved relative to the Synopsis working directory.)

**Tests:**
- Fixture pairs under `Synopsis.Tests/Fixtures/BreakingDiff/`:
  - `01-endpoint-route-change/{before,after,expected}.json`
  - `02-dto-field-removal/...`
  - `03-package-bump-with-api-break/...`
  - (8+ total, covering each classification kind)
- Golden-file tests: run classifier, assert output matches `expected.json`.

---

## M5. NuGet / Package dependency nodes

**Goal:** Represent NuGet packages in the graph so shared-library version
changes produce blast-radius queries.

**Files touched:**
- `Synopsis.Analysis/Model/GraphModel.cs` — add `NodeType.Package` and
  `EdgeType.DependsOnPackage`.
- `Synopsis.Analysis/Roslyn/Passes/PackagePass.cs` *(new)* — parses
  `PackageReference` elements and central package management.
- `Synopsis.Analysis/ScannerBuilder.cs` — register the new pass.

**Data sources (in order of preference):**
1. `project.assets.json` if present (authoritative, includes transitive).
2. `Directory.Packages.props` for central package management (CPM) versions.
3. `PackageReference` elements in `.csproj` with inline `Version`.

**Node shape (identity only — shared fleet-wide):**
- ID: `package:{sha8(packageId|version)}` — case-normalized.
- DisplayName: `PackageId@Version`.
- Metadata: `packageId`, `version` only. No per-project facts.

**Edge shape (carries per-project relational facts):**
- `Project -[DependsOnPackage]-> Package`.
- Metadata: `isTransitive`, `source` (`project.assets.json` /
  `csproj-inline` / `directory-packages-props`), `frameworks`
  (comma-separated TFMs using this package in this project).
- Certainty: `Exact` when from `project.assets.json`; `Inferred` when from
  `.props` or `.csproj`; `Ambiguous` when version is a floating range.

**Why identity-only on the node.** The same `Serilog@3.1.1` is referenced
by many projects, often with different per-project realities (direct in A,
transitive in B; assets.json in A, csproj-inline in B; net8.0 in A,
net10.0 in B). `GraphBuilder.AddNode`'s metadata merge is first-non-empty-
wins — storing relational facts on the node makes their visible value
depend on parallel-merge order. Putting them on the edge keeps every
project's truth independently correct.

**Blast-radius implication:**
- A package node's upstream set = every project that depends on it.
- In a microservice fleet with a shared NuGet lib, a version bump shows all
  consuming services as direct upstream hits — exactly what Aegis needs.

**Tests:**
- Fixture workspace with CPM + inline + transitive packages; assert graph
  contains correct package nodes and edges.
- Version bump diff produces a `NugetVersionBump` breaking-change (via M4).

**Expected statistics drift (document for consumers).**
`GraphBuilder.IncrementEdgeCounter` bumps `_ambiguousCount` on any edge
with `Ambiguous` or `Unresolved` certainty. With M5, every
`DependsOnPackage` edge on a floating version range (e.g. `"3.*"`,
`"[1.0,2.0)"`) or an unresolved CPM reference now contributes. Before
M5 this counter only reflected call-site / data-access ambiguity, so
`ScanStatistics.AmbiguousEdgeCount` will visibly jump on real
workspaces. Not a bug — the ambiguity is real — but any CI thresholds
or dashboards keyed off this single counter need re-baselining. A
future refinement may split package ambiguity into its own counter; not
blocking for P0.

**Vuln pin bookkeeping.** GHSA-37gx-xxp4-5rgx /
GHSA-w3x6-4m5h-cxqf (CVE-2026-33116) was flagged on the transitive
`System.Security.Cryptography.Xml@10.0.1` pulled through the
`Microsoft.Build.*` / `Microsoft.CodeAnalysis.Workspaces.MSBuild`
packages. Pinned to `10.0.6` via `GlobalPackageReference` in
`src/synopsis/Directory.Packages.props` so every current and future
project in the solution inherits the fix automatically — no per-csproj
ritual required.

---

## Publish targets

Add linux-x64 and linux-arm64 to the publish script:

```bash
dotnet publish Synopsis/Synopsis.csproj -c Release -r linux-x64   -o artifacts/linux-x64
dotnet publish Synopsis/Synopsis.csproj -c Release -r linux-arm64 -o artifacts/linux-arm64
```

Keep osx-arm64 + win-x64 for standalone users.

R2R + single-file stays; NativeAOT stays off (Roslyn/MSBuild.Locator not
AOT-clean).

## Non-goals for this pass

- gRPC / Refit / OpenAPI-generated clients — deferred (S2 in the roadmap).
- On-disk per-repo graph cache — deferred (S1 in the roadmap).
- `git-scan` reusing combined graph — deferred (S3).

## Impact on existing consumers

- CLI: all existing commands unchanged (`scan`, `watch`, `export`, `query`,
  `git-scan`, `diff`, `mcp` with stdio).
- Existing graph.json files load unchanged (node/edge schema is additive:
  new `Package` type ignored by readers that don't know it).
- MCP tool surface is additive; no removed or renamed tools.

Standalone Synopsis users see new capabilities, no breakage.
