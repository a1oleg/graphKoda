# Extractor audit

Audit date: 2026-09-01

## Scope and data flow

```text
orchestrator API
  -> dev/runGraphExtract.mjs or scoped extractor daemon
  -> TypeScript AST/checker extraction
  -> JSON (scoped) or DuckDB/Parquet (full)
  -> Python validation and Neo4j writer
```

The audit covers the function-flow path currently exposed as `func`: process
launch, persistent scoped extraction, TypeScript identities and graph contracts,
transport staging, scoped/full replacement, and Neo4j writes.

## Verified controls

- `stableId` is the transport and Neo4j identity field. DuckDB's `stable_id` is
  confined to its tabular staging schema.
- The Python boundary rejects empty IDs, empty/duplicate labels, non-object
  properties, non-serializable properties, and missing relationship endpoints.
- The scoped daemon binds only to `127.0.0.1`, limits request bodies to 64 KiB,
  watches source changes, and reuses both the TypeScript `Program` and prepared
  semantic context between unchanged requests.
- Scoped extraction of `onSubmit` was observed with
  `reusedProgram=true`, `reusedContext=true`; the cached extraction itself took
  about 5 seconds.
- Python importer tests: 16/16 pass using `.venv`.
- Orchestrator extractor tests: 4/4 pass.

## Findings

### Fixed in this audit

1. **High — command injection on Windows process launch.** The asynchronous
   extract route previously concatenated `fnStableId` into `cmd.exe /c npm run`.
   It now invokes `node dev/runGraphExtract.mjs` directly and passes every value
   as a separate argv element. A hostile-ID regression test covers this boundary.

2. **High — stale provenance in the persistent daemon.** `sourceStateId` was
   calculated once when the extractor module loaded, while the daemon rebuilt its
   TypeScript `Program` after source edits without reloading that module. The
   daemon now refreshes provenance whenever it rebuilds the Program.

3. **High — default full import cleared Neo4j before extraction succeeded.**
   The default clear timing is now `after-extract`. The explicitly requested
   `parallel` mode remains available for disposable databases where speed is
   more important than the failure window.

### Open correctness and reliability findings

1. **High — full cleanup is not source-scoped.** Although cleanup now starts only
   after successful extraction by default, `clear_database()` still executes
   `MATCH (n) ... DETACH DELETE n`. It removes annotations and graphs not owned by
   function-flow extraction. The safe design is to replace only the owned source
   in a controlled promotion step. The explicit `parallel` option also retains a
   destructive failure window and should be limited to disposable databases.

2. **High — orchestrated scoped append deletes before replacement is ready.**
   `importFunctionsScoped()` calls `cleanupScopedFunctionImport()` before starting
   the extractor/import subprocess. A timeout or extraction error leaves the
   requested function segment absent. Extraction should precede cleanup, and the
   replacement should use one explicit import transaction or a staged generation.

3. **Medium — five TypeScript extractor regressions are red.** The suite has
   88 passing and 5 failing tests. Failures cover primitive one-argument layout,
   duplicate nested template calls, duplicate materialization of a call argument,
   an incorrect materialized array-updater argument, and awaited project-method
   classification (`remote` instead of `await`). These are representation/semantic
   regressions and should remain visible rather than being accepted as a new
   baseline accidentally.

4. **Medium — source-coordinate identity can silently discard a second role.**
   Inside one function builder, `createNode()` returns immediately when a
   `stableId` has already been seen. It does not merge the new labels/properties
   into the existing source entity. This conflicts with the intended model of one
   coordinate entity carrying several roles. The merge policy needs an explicit
   contract for compatible scalar properties before changing it globally.

5. **Medium — extractor has no isolated static type-check gate.** The repository
   `tsc` invocation is blocked first by a TypeScript 6 deprecation and then by
   thousands of application/Bun-specific errors. Consequently extractor modules
   are exercised through runtime tests but are not independently type-checked.
   Add a small extractor-only `tsconfig` and CI command.

6. **Medium — the main builder is a change-risk hotspot.**
   `fromASTtoPreGraphFlow.ts` is about 846 KB and mixes AST traversal, semantic
   inference, rendering composition metadata, scoping, validation, transport, and
   CLI concerns. Existing extracted helper modules are useful, but the remaining
   central class still makes regressions interact across unrelated constructs.
   Split by contracts first: identity/entity merge, functional graph, syntax
   composition, scoped closure, and transport.

7. **Medium — full identity audit is too expensive and has no progress signal.**
   The observed run was stopped after several minutes while actively consuming
   about 3.3 GB of private memory; it had emitted no progress or partial result.
   Emit phase/file counters to stderr, measure which prepared indexes dominate,
   and support a bounded/scoped identity audit while preserving JSON-only stdout.

8. **Low — untracked source contents are not part of dirty provenance.** The
   provenance fingerprint includes `git status` plus `git diff HEAD`; changes to
   the contents of an already-untracked file can retain the same fingerprint.
   Hash the content of relevant untracked source files as well.

## Recommended order

1. Make full and scoped replacement failure-atomic.
2. Restore the five red semantic tests.
3. Define and test the one-coordinate/multiple-role merge contract.
4. Add extractor-only type checking.
5. Split the central builder along the established graph contracts, without
   changing output in the same commits.
