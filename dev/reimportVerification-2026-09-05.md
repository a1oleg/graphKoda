# Full reimport verification, 2026-09-05

Started via `POST /api/actions/run-extract`, mode `func`.
Completed with exit code 0. No full import remains running.

## Data checks

- Catalog and Neo4j agree: 1,772,499 code nodes and 4,090,110 code relationships.
- System + DeveloperDefined conflicts: 465 before, 0 after.
- Duplicate stable IDs: 0 after.
- All 619 Annotation property maps match the pre-import snapshot exactly.
- HAS_ANNOTATION links: 616 before, 619 after; no detached annotations remain.
- An additional 623 DEPENDS_ON relationships belong to preserved annotations,
  not to the imported code catalog.
- The read-only label audit was rerun after import.

## Import fixes

Full cleanup previously ignored preserveAnnotations and deleted annotations.
It now preserves Annotation nodes by default and reattaches them after import.
The orchestrator now passes explicit false for full imports too, and exposes
the preservation setting in run metadata. That JavaScript service change takes
effect on its next restart; the Python importer change was used by this run.

18 Python tests and 4 extraction API tests passed. Whitespace checks passed.
Scoped imports still union existing labels; they do not automatically remove
stale labels. This full replacement does not have that limitation.

## Timing

- Total: 3,493.287 seconds.
- Extraction: 2,250.785 seconds.
- Validation/canonicalization: 459.623 seconds.
- Neo4j entity writes: 329.902 seconds.
- Neo4j relationship writes: 273.178 seconds.

The previous full GraphImportRun reported 1,299.594 seconds for 1,764,923 nodes
and 3,924,399 relationships. The current run is slower; most time is before
Neo4j writes. This is not a controlled benchmark of identical source/tool
versions. The CPU root cause has not been profiled or fixed in this task.

## Renderer check

Generated `tmp/onSubmit-reimport-check.drawio` successfully without replacing
the user's main diagram. Automatic checks are not all green: 51 findings in
2 of 11 checks, versus 39 in the saved September 4 report. Categories:

- 38 container-boundary findings (including 24 node-touch/intersection reports).
- 13 producer-chain-routing findings.
- Projection contract separately reports 3 hidden extracted edges.

The intersection reports concern call/join bounds touching object-family brace
bounds for handlePromptSubmit. They require renderer/checker investigation;
successful import is not evidence that the composition is correct.

## Artifacts

- `graph/.runtime/logs/extract-func-2026-09-05T09-15-23-734Z.log`
- `tmp/reimport-annotations-before.json`
- `tmp/reimport-verification.json`
- `tmp/graph-label-audit-after-reimport/labels.json`
- `tmp/onSubmit-reimport-check.auto-checks.json`

Repeat the data verification with:

```powershell
node dev/checkReimport.mjs --log graph/.runtime/logs/extract-func-2026-09-05T09-15-23-734Z.log
```
