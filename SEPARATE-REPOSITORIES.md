# Separate Repositories

The development checkout is `graphKoda`. The analyzed source is an external Git
checkout; do not install the overlay for this workflow.

## Ownership

`sourceRoot` means the selected application being analyzed: its TypeScript,
JavaScript, components, services and dependencies. It is not tied to a particular
repository or framework, and never means the graphKoda tooling checkout.

The extractor, annotator, renderer, extension and their diagrams belong to the
tool checkout. All diagram documents, including hand-edited generated diagrams,
live in `graphKoda/graph/draw`, not `sourceRoot/graph/draw` or the data directory.
The migration on 2026-09-10 moved all 22 files from the old `graph/draw` directory
and verified their SHA-256 hashes. The old directory must not be recreated by
running historical tool copies. `.drawio` files in `generated` are versioned;
generated JSON reports remain ignored. Caches, databases and logs are separate
from these diagram documents.

## Local Setup

The active source is configured in ignored `graphKoda.local.json`. As of
2026-09-29 it is `C:\GitHub\telegram-tt`, forked at
`https://github.com/a1oleg/telegram-tt` from `https://github.com/Ajaxy/telegram-tt`.
`origin` is the fork; `upstream` is the original. Its data directory is
`C:\GitHub\graphKoda-data\telegram-tt`, separate from previous source caches.
The tool checkout remains `C:\GitHub\coldKode`; open `coldKode.code-workspace`.
Switching sources does not clear or import Neo4j automatically.

Function exporters require an explicit stable ID; there is no default onSubmit.
Optional extension shortcuts are configured with `functionDiagrams` in the
project JSON. The old model-stub launcher is opt-in with `enableModelStub: true`;
it is specific to the old application, not a generic application launcher.
Historical examples and their diagrams are retained, not used as project defaults.
`examples/source-profiles/claude-code.json` retains the old optional shortcuts.
Select it explicitly through `graphKoda_PROJECT_CONFIG` when working on that source.
`sourceExcludePaths` optionally excludes source-relative directories from flow
extraction; no application-specific directory is silently excluded in the core.

The Fisher-Yates source and tests live in `graphKoda/examples/fisher-yates`.
Its extraction and draw.io export belong to graphKoda (`npm run fisher:import`
and `npm run fisher:draw`). This scoped example overrides the source root only
inside its extractor process; the configured application source root is unchanged.
Fisher uses the parameterized `expanded-functions` diagram view defined in
`dev/expandedFunctionView.mjs`: developer calls expand into nested blocks;
only the root function shows entry parameters. Secondary parameter families
are omitted before coordinate calculation, without changing extraction or Aura.
Called Start centers align with their call centers when the preceding expanded
block leaves room; otherwise the next block keeps a 60px clearance.
`node dev/exportFisherYatesDrawio.mjs --show-secondary-parameters` restores their
display; `--no-align-called-start` disables Start alignment. The selected options
are stored on the draw.io diagram. Standalone function exports are unchanged.
The retired standalone annotation UI and Bloom demo are no longer part of the
workspace. Fisher source, extraction, annotations and draw.io remain in graphKoda.

- Tool repository: `https://github.com/a1oleg/graphKoda`.
- Previous source repository: `https://github.com/a1oleg/claude-code`.
- The previous two GitHub repositories were private (verified through authenticated
  GitHub repository metadata on 2026-09-09). No repository rename is required.
- Local tool checkout: `C:\GitHub\coldKode`.
- Previous source checkout, retained unchanged: `C:\GitHub\claude-code`.
- Use these two checkouts for Claude Code analysis. Do not create `claude-code-source`, detach the
  existing source at STUB, or change its revision as part of this migration.
- Migration input: tool files from `claude-code` commit
  `0a5a922cff7a3e43b027174c70e13017177b5478`.

Copy `graphKoda.example.json` to the ignored `graphKoda.local.json` and adjust paths.
`graphKoda_SOURCE_ROOT` and `graphKoda_DATA_ROOT` override the file; relative paths
are resolved against the tool checkout, not the shell working directory.
`graphKoda_PROJECT_CONFIG` selects an alternative configuration file.

Install each checkout's Node dependencies with `npm ci`. The source checkout
must have its own `tsconfig.json` and dependency resolution environment.
For the importer install `graph/static-extract/requirements.txt` in the tool
checkout's Python venv. Keep credentials in ignored `graph/.env` in graphKoda.

Run from graphKoda:

```powershell
node dev/projectStatus.mjs
node --import tsx graph/static-extract/ts/fromASTtoPreGraphFlow.ts --fn-stable-id <selected-function-stable-id>
```

The second command extracts without writing to Neo4j. Full importer defaults put
DuckDB/Parquet under `dataRoot/cache`; CodeQL uses `dataRoot/codeql`. Service logs
use `dataRoot/logs`. The 2026-09-13 cleanup moved the historical source checkout's
`graph`, `dev`, `.cache`, `tmp`, Redis compose file and analysis notes directly
into graphKoda. Unique files were moved with SHA-256 verification; duplicate files
were removed from the source checkout. Existing graphKoda versions won conflicts
with clean, Git-versioned historical tool files. No third archive was created.
Existing external dataRoot catalogs were not moved or reimported. Legacy runtime
utilities retain their tool-local output paths in graphKoda.

Open `coldKode.code-workspace` to keep the tool folder first for Graph Explorer.
Source navigation in the extension reads the same project configuration.
The gateway status includes `projectRoots`, so the active checkout can be verified
through `/api/status/gateway`. Extension 0.0.413 supports the separate source root.

## Provenance

`projectStatus.mjs` reports independent full Git commits and dirty flags for the
tool and source checkouts. Source-coordinate IDs are relative to `sourceRoot`;
absolute source paths remain available as location metadata.

The source checkout stays at its current revision; application `.ts` and `.tsx`
files are unchanged. Tool npm commands and tool-only dependencies were removed
from its package manifest. Commands, VS Code MCP settings and draw.io plugin
settings now belong to graphKoda. The old configuration used the existing
`claude-code` checkout, not `claude-code-source`; the current selection is above.

Python dependencies from the old environment are installed in `graphKoda/.venv`;
`pip check` passes. The old `claude-code/.venv` is still present: command execution
policy blocked its removal. It is not the configured MCP environment and must be
removed manually to finish filesystem cleanup. Reload VS Code to reconnect MCP
using the updated configuration. Git history is retained; no commit or push was
performed by the cleanup.

Neo4j MCP runs from `graphKoda/graph/mcp/neo4j_mcp_server.py` with the tool
checkout's `.venv/Scripts/python.exe`. Install `graph/mcp/requirements.txt`.
The `local` profile uses `NEO4J_*`; `aura` uses only `AURA_NEO4J_*` from the
ignored `graph/.env`, with verified TLS and no fallback to the local database.
Codex user configuration and `.vscode/mcp.json` register separate `neo4jGraph`
and `neo4jAura` servers. Aura exposes inspection tools only, and read queries
are checked with EXPLAIN before execution. `node dev/checkAuraMcp.mjs` verifies
the real stdio MCP handshake and queries the neighbors of Fisher's alphabet.

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
