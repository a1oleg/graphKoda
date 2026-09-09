# Separate Repositories

The development checkout is `coldKode`. The analyzed source is an external Git
checkout; do not install the overlay for this workflow.

## Local Setup

- Tool repository: `https://github.com/a1oleg/coldKode`.
- Source repository: `https://github.com/a1oleg/claude-code`.
- Both existing GitHub repositories are private (verified through authenticated
  GitHub repository metadata on 2026-09-09). No repository rename is required.
- Pinned source: `af272b9e82955330836f9354229c0a8453c3a3da` (`STUB`).
- Migration input: tool files from `claude-code` commit
  `0a5a922cff7a3e43b027174c70e13017177b5478`.

Copy `coldkode.example.json` to the ignored `coldkode.local.json` and adjust paths.
`COLDKODE_SOURCE_ROOT` and `COLDKODE_DATA_ROOT` override the file; relative paths
are resolved against the tool checkout, not the shell working directory.
`COLDKODE_PROJECT_CONFIG` selects an alternative configuration file.

Install each checkout's Node dependencies with `npm ci`. The source checkout
must have its own `tsconfig.json` and dependency resolution environment.
For the importer install `graph/static-extract/requirements.txt` in the tool
checkout's Python venv. Keep credentials in ignored `graph/.env` in coldKode.

Run from coldKode:

```powershell
node dev/projectStatus.mjs
node --import tsx graph/static-extract/ts/fromASTtoPreGraphFlow.ts --fn-stable-id screens/REPL.tsx:3142:31:3533:3
```

The second command extracts without writing to Neo4j. Full importer defaults put
DuckDB/Parquet under `dataRoot/cache`; CodeQL uses `dataRoot/codeql`. Service logs
use `dataRoot/logs`. Existing caches and databases are not moved or reimported.
Some legacy runtime/repro/rendering utilities still have tool-local cache/output
paths; those workflows require a separate audit before retiring the old checkout.

Open `coldKode.code-workspace` to keep the tool folder first for Graph Explorer.
Source navigation in the extension reads the same project configuration.
The gateway status includes `projectRoots`, so the active checkout can be verified
through `/api/status/gateway`. Extension 0.0.413 supports the separate source root.

## Provenance

`projectStatus.mjs` reports independent full Git commits and dirty flags for the
tool and source checkouts. Source-coordinate IDs are relative to `sourceRoot`;
absolute source paths remain available as location metadata.

The source clone is detached at STUB, has its own Git objects and uses sparse
checkout to omit historical graph/dev/tmp files. Its historical Git commit still
contains the former combined tree; history has not been rewritten.

This migration establishes repository identity, but does not yet persist the
agreed extraction passport and per-fact provenance IDs in DuckDB/Parquet/Neo4j.
Do not interpret the old source_state_id property as an extractor version.
No Git commit or push is performed by the migration itself.
