# Annotation subject inventory

## Annotation selection

`planAnnotationSubjects.py` runs after the body audit and writes
`annotation-plan.parquet` and `annotation-plan.json`. Status includes the counts;
subject responses include `annotationPlan` with its decision, evidence reason
and context targets. Nothing is scheduled or generated.

- `generation-candidate`: confirmed definition, still subject to task demand and freshness.
- `contract-candidate`: signature without implementation; do not invent a body.
- `review-callback`: callback implementation; do not assume a separate annotation is needed.
- `compose-in-owner`: one explicit owner, retain context there.
- `review-owner`: several owner candidates; do not pick an arbitrary one.
- `follow-original`: reuse the original, including bindings to initializer functions.
- `external-boundary`: context from the external contract/catalog, not a missing local body.
- `syntax-summary`: compiler-confirmed empty body; retain signature context without LLM prose.
- `blocked-*`: retain evidence and surface the missing context rather than discard it.

These are allocation decisions, not proof of a complete annotation DAG. The plan
uses the recorded extraction snapshot, not live Neo4j. Scoped imports do not
silently alter its evidence. `verifyScopedBodyRepairs.py --report <report>` checks
previously missing Step targets in Neo4j and writes a separate timestamped
`live-body-repairs.json`.

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

Annotation plan v5 distinguishes immediate containment from ancestor evidence.
Field-bearing, non-projected `AST_CHILD` and member/property edges marked
`ownership=direct` establish syntax/member owners. `HAS_OPERATION` marked
`ownership=immediate-step` and `parentStepStableId` pointing to an existing Step
establish step ownership when no syntax/member owner is present. This matches
the extractor's `attachImmediateStepOperationGraph` contract. Conflicting targets stay
under review; lexical function ownership alone does not establish direct nesting.
For Step/Block nodes only, structural containment proceeds through the enclosing
flow block (`parentFlowBlockStableId` / structural `NESTED_IN`), then local
function, then root function. `HAS_FLOW_BLOCK` is function membership, potentially
including ancestors, and is excluded from immediate ownership evidence entirely.
Missing or self-referencing nearest
targets and non-block block targets remain `invalid-direct-owner-target`;
they do not fall back to a more distant owner. This rule does not apply broadly
to every operation merely carrying `parentFnStableId`.
The API returns target-associated `immediate_owner_evidence`, not just parallel
lists of targets and relation names.
`owner_status` distinguishes missing evidence from conflicting direct owners.
`ownerReview` in the plan summary groups remaining cases by status and subject
classification with real stable-ID examples. All counts refer to the extraction
snapshot, not subsequent scoped updates in Neo4j.

A callback can compose into its containing call when a unique direct argument
parent is confirmed by both `AST_CHILD(field=arguments)` and `HAS_ARGUMENT`,
with no other incoming functional relations beyond containment. Other callbacks
remain under review. This does not imply synchronous execution or discard their
bodies: `required_body_context` remains explicit. No LLM tasks are scheduled.
These rules currently plan context allocation; they do not certify recursive
annotation completeness, cache freshness, or minimal generation counts.

`node dev/annotationInventoryApi.integration.mjs` exercises real HTTP routes and
the configured Telegram extraction, checks operation conflicts and pagination,
and runs the actual ChatAbortController regression checks. No synthetic graph
is created. The original standalone CLI remains available:

`node --import tsx dev/flowBlockOwnership.integration.mts` extracts the actual
LeftColumn and deeplink functions and verifies that collapsing a block into its
only Step removes internal containment instead of producing `NESTED_IN` self
edges. Existing snapshots still report those errors until re-extracted; the
annotation planner does not repair or conceal them.

```
python dev/inventoryAnnotationSubjects.py --parquet <snapshot> --output <report>
python dev/inventoryAnnotationSubjects.integration.py --report <report>
```
