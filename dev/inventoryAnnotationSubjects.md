# Annotation subject inventory

Uses the configured project's completed extraction Parquet, without re-extraction,
LLM generation or changes to Neo4j. Candidate markings are stored in
`checks/graph-ranking/<runId>/subjects.parquet`; summary and run state persist
alongside it. This is not a certified generation queue or a freshness check.

## API

- `GET /api/graph/annotation-inventory/plan`: policy version and limitations.
- `GET /api/graph/annotation-inventory/preflight`: runtime, files, operation locks.
- `POST /api/graph/annotation-inventory/run` with `{}`: returns 202 and `runId`.
- `GET /api/graph/annotation-inventory/status?runId=...`: completion and summary.
- `GET /api/graph/annotation-inventory/subjects?runId=...&stableId=...`: exact entity.
- `GET /api/graph/annotation-inventory/subjects?mode=unresolved&limit=50&offset=0`:
  paginated markings from the latest inventory. Maximum page size is 200.
- `POST /api/graph/annotation-inventory/recover` with `{}`: recover a dead worker's
  shared analysis lock. A live worker cannot be unlocked.

Ranking and inventory share exclusion with managed extraction/import. Inventory
has a separate latest-run pointer and cannot be published as a ranking result.
Run IDs remain readable after an orchestrator restart.

## Markings

- `standalone`: definition with confirmed body or named structured contract.
- `inline`: owned content; keep the evidence, not a separate generation task yet.
- `reference`: explicit original or external catalog boundary.
- `unresolved`: insufficient evidence; do not silently discard these nodes.

Every row retains all evidenced owners/originals and the classification reason.
Body evidence accepts outgoing `HAS_OPERATION`, `HAS_FLOW_BLOCK`, `RETURNS_VALUE`,
`AST_CHILD(field=body)` and `AST_CHILD(projection=nearest-function-operation)`,
plus incoming `ENCLOSED_BY(resolution=lexical-function-owner)`.
Endpoints must exist and differ; body targets are deduplicated across relations.
The check does not infer bodies from function names or source-range proximity.

`callable-body-not-confirmed` is an investigation category, not a proven extractor
defect. Body evidence establishes presence, not semantic completeness.
Multiple owners and references are retained rather than arbitrarily selected.

## Unconfirmed-body audit

Every run also invokes `auditUnconfirmedCallableBodies.py` and the TypeScript
parser in `inspectCallableSyntax.mjs`, using full declaration text from the same
snapshot (not truncated snippets or a potentially newer working tree).
`body-audit.json` records external boundaries, bindings to confirmed initializer
functions, signatures without bodies, empty bodies, constructor parameter
properties, explicit `NEXT(function-entry) -> BODY_ENTRY` paths, and unresolved
proxies/nonempty bodies. Empty constructor bodies with parameter properties are
not treated as no-ops. Step `syntaxEntryStableId` targets are checked for existence.

The status summary includes `bodyAudit` counts; subject responses include matching
`bodyAudit` details. These audit categories do not silently overwrite candidate
classification or certify complete extraction. Reports made before this audit
can be enriched explicitly with `python dev/auditUnconfirmedCallableBodies.py
--report <report>`.

Body-entry auditing traverses signature parameter/return links between Start
and BODY_ENTRY; a function with parameters must not be reported broken merely
because BODY_ENTRY does not originate directly at Start.
`node --import tsx dev/throwBody.integration.mts` checks the nine real Telegram
regressions against fresh extraction, including step targets and reachability.

## Verification

`node dev/annotationInventoryApi.integration.mjs` exercises real HTTP routes and
the configured Telegram extraction, checks operation conflicts and pagination,
and runs the actual ChatAbortController regression checks. No synthetic graph
is created. The original standalone CLI remains available:

```
python dev/inventoryAnnotationSubjects.py --parquet <snapshot> --output <report>
python dev/inventoryAnnotationSubjects.integration.py --report <report>
```
