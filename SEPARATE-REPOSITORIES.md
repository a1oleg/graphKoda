# Separate Repositories

The development checkout is `coldKode`. The analyzed source is an external Git
checkout; do not install the overlay for this workflow.

## Ownership

`sourceRoot` means the application being analyzed: Claude Code's TypeScript,
JavaScript, components, services and their dependencies. It does not mean every
file historically located in the claude-code checkout.

The extractor, annotator, renderer, extension and their diagrams belong to the
tool checkout. All diagram documents, including hand-edited generated diagrams,
live in `coldKode/graph/draw`, not `sourceRoot/graph/draw` or the data directory.
The migration on 2026-09-10 moved all 22 files from the old `graph/draw` directory
and verified their SHA-256 hashes. The old directory must not be recreated by
running historical tool copies. `.drawio` files in `generated` are versioned;
generated JSON reports remain ignored. Caches, databases and logs are separate
from these diagram documents.

## Local Setup

The independent Fisher-Yates example and its standalone annotation visualizer
live in `../fisher-yates`, a separate local Git repository added to the workspace.
It has its own dependencies and ignored Aura configuration; it does not change
the Claude Code source root. Start it with `npm start` there (port 8793).

- Tool repository: `https://github.com/a1oleg/coldKode`.
- Source repository: `https://github.com/a1oleg/claude-code`.
- Both existing GitHub repositories are private (verified through authenticated
  GitHub repository metadata on 2026-09-09). No repository rename is required.
- Local tool checkout: `C:\GitHub\coldKode`.
- Local source checkout: the existing `C:\GitHub\claude-code`.
- Use these two checkouts for Claude Code analysis. Do not create `claude-code-source`, detach the
  existing source at STUB, or change its revision as part of this migration.
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

The existing source checkout stays in place with its current revision, local
files and dependencies, except for the explicitly migrated diagram documents.
Historical graph/dev/tmp tool files may still be present;
active tooling is run from coldKode, not from those historical copies. This
migration does not delete source files, rewrite history, or move databases.

Extraction now persists the passport in DuckDB `extraction_provenance` and
`provenance.parquet`. Every node/relationship row has a `provenance_id` column.
The importer places that ID on Neo4j facts, writes `ExtractionProvenance` records,
and links import runs through `GraphImportRun.provenance_ids`.

Passports contain full extractor/source Git revisions, independent dirty SHA-256
fingerprints (including untracked file contents), extraction options and a capture
timestamp. Display the first 12 characters of commits; do not use them as unique IDs.
The provenance ID hashes code/source/options identity, excluding the timestamp,
so repeat imports of the same snapshot do not conflict merely because time passed.
No independent extractor version counter is used.

Catalog-only imports retain the original passport, even when the importer has
changed. Missing legacy passports, unknown per-fact IDs, and mismatched DuckDB/
Parquet manifests fail before default full-import cleanup. Explicit
`--neo4j-clear-timing parallel` retains its existing early-clear semantics.
Scoped imports reject overlapping facts of different or unknown provenance before
cleanup. Use a deliberate full replacement to migrate such a graph; never stamp
old facts with the current commit. Coordinate stable IDs do not change.
Do not interpret the old source_state_id property as an extractor version.
Extraction checks for checkout changes before publishing its result. The daemon
rebuilds source context when the snapshot changes and must restart for tool changes.
No Git commit or push is performed by the migration itself.
