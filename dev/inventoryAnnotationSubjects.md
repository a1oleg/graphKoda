# Annotation subject inventory

## Annotation selection

`planAnnotationSubjects.py` runs after the body audit and writes
`annotation-plan.parquet` and `annotation-plan.json`. Status includes the counts;
subject responses include `annotationPlan` with its decision, evidence reason
and context targets. Nothing is scheduled or generated.

- `generation-candidate`: confirmed definition, still subject to task demand and freshness.
- `contract-candidate`: signature without implementation; do not invent a body.
- `review-callback`: callback implementation whose body is not confirmed.
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

Destructuring ownership requires materialized binding patterns: declaration
`AST_CHILD(field=name)` -> pattern `AST_CHILD(field=elements)` -> binding.
The canonical extractor emits these for object/array and nested binding patterns.
An untyped parameter whose coordinates equal its pattern retains its declaration
identity and is not relabelled System. Source/value projection edges are retained.
`node --import tsx dev/bindingPatternOwnership.integration.mts` checks all actual
Telegram patterns against the compiler AST; `python dev/bindingPatternScoped.integration.py`
checks the real scoped transport for object and array destructuring.
This extractor repair requires re-extraction before old snapshot counts can change.
The bots.ts and statistics.ts regression functions were scoped-imported with
annotations preserved. `python dev/verifyLiveBindingPatternOwnership.py` checks
their unique declaration/pattern/binding chains, provenance and retained READS_FROM
in live Neo4j; this is separate from the unchanged extraction snapshot inventory.

Annotation plan v10 distinguishes immediate containment from ancestor evidence.
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
FunctionStart/FunctionEnd boundaries also compose into their explicitly recorded
local or root function. Local ownership takes priority; the target must exist and
carry Fn, FnDeclaration or CallableDeclaration. Missing or invalid local owners do
not fall back to a root owner. This allocates technical boundary context without
creating standalone annotation jobs and does not infer ownership from names.
Synthetic Join nodes explicitly marked operation_code=FLOW_JOIN and join_kind=flow
use the same enclosing block/local function/root function chain as structural nodes.
Existing closer AST/Step evidence still takes precedence. Missing or contradictory
nearest owners remain review; function targets must be callable. ARG_JOIN, operand
and value merges are not classified through this rule. Control edges are retained.

CapturedBinding occurrences reuse an original through incoming CAPTURES_VALUE.
Each hop must have exactly one predecessor, the original must exist, and nested
capture hops must agree on originalStableId. The entire chain must reach that
original without cycles. The plan keeps the immediate predecessor in context_targets
and records capture_original and capture_path; it does not guess from names or
skip intermediate captures. Missing, contradictory, ambiguous or cyclic chains
remain under review, not new generation jobs. The function's use-site context is
not replaced by this reference classification.

An ObjectConstruction/ArgumentValue belongs to its explicit HAS_ARGUMENT caller
(Call). For a PropertyValue reachable both directly via caller HAS_PROPERTY and
through that argument object's HAS_PROPERTY, the object is its immediate owner;
the caller link is ancestor membership. Both paths must exist. This topology rule
also takes precedence over the caller's AST attributes link when an attribute list
and its only property share a source range. Object arguments previously marked as
no-ownership-or-reference-evidence can now compose into a unique confirmed caller;
ambiguous callers remain review-owner.
This topology rule
uses neither JSX names nor ID suffixes, does not follow SATISFIES_MEMBER as an owner,
and retains competing immediate owners rather than choosing one arbitrarily.
The API returns target-associated `immediate_owner_evidence`, not just parallel
lists of targets and relation names.
`owner_status` distinguishes missing evidence from conflicting direct owners.
`ownerReview` in the plan summary groups remaining cases by status and subject
classification with real stable-ID examples. All counts refer to the extraction
snapshot, not subsequent scoped updates in Neo4j.

A callback can compose into its containing call when a unique direct argument
parent is confirmed by both `AST_CHILD(field=arguments)` and `HAS_ARGUMENT`,
with no other incoming functional relations beyond containment. Other callbacks
with confirmed bodies remain independent candidates; unconfirmed bodies stay
under review. This does not imply synchronous execution or discard their
bodies: `required_body_context` remains explicit. No LLM tasks are scheduled.
These rules currently plan context allocation; they do not certify recursive
annotation completeness, cache freshness, or minimal generation counts.

Planner v13 adds explicit `COMPOSES_SYNTAX` ownership for `SyntaxPart` nodes as
a fallback after AST, step and declaration-container evidence. All owners at
this fallback tier are retained: multiple composition owners remain a conflict.
Declarations, parameters, value slots and references are excluded: displaying
an original entity in an expression does not transfer ownership to its caller.
Composition never overrides a stronger direct owner or schedules generation.
An edge reversing direct AST containment (`await` owns its call, not the reverse)
or having reciprocal composition evidence is retained as an invalid owner,
not promoted to ownership. The ambiguity is not misclassified as code recursion.
The real-snapshot regression check is `syntaxCompositionOwnership.integration.py`.

Canonical extraction materializes simple declaration names as `DeclarationName`
syntax parts and emits `AST_CHILD(field=name)` from the declaration. These are
not new bindings or references: the original declaration keeps its identity and
type/value edges. Identical source ranges do not create a self-edge, and property
access expressions are not declaration names. Tests against actual project ASTs:
`declarationNameOwnership.integration.mts` and `declarationNameScoped.integration.py`.

Export assignments retain their declaration identity and expression `VALUE_FROM`
edge, including wrapper calls such as `memo(Component)`. They also carry
`DeclarationContainer` and `ENCLOSED_BY(resolution=nearest-materialized-ast-owner)`
to their source file. This is containment, not an alias bypassing the wrapper.
`exportAssignmentOwnership.integration.mts` checks actual project exports,
expression links when materialized, and call-wrapper identity. Snapshots made
before this extractor change still lack the ownership evidence until re-imported.

Inventory v5 excludes `AST_CHILD(field=name)` from `ast_count`. Declaration
identity remains in the graph, but a type's own name is not evidence of its
contract structure. This does not remove ownership edges or callable body
context. `declarationNameInventory.integration.py` compares real snapshots.

Planner v14 recognizes `MATERIALIZES_ARGUMENT` as direct call ownership only
when its call-execution/actual-argument metadata and the child's
`sourceCallStableId` agree. The caller must be a materialized `Call`.
Equal-tier conflicts remain explicit; no source-range or name guessing is used.
`materializedArgumentOwnership.integration.py` compares two plans from the same
actual snapshot, checks relation evidence, and preserves generation candidates,
body prerequisites and capture paths.

Planner v12 treats callbacks with confirmed body context as independent
generation candidates when direct callback composition is not proven. Being a
callback alone is not a reason to block annotation. Callbacks without body
evidence remain under review, and confirmed direct argument composition keeps
precedence. `callbackAnnotationPlan.integration.py` compares actual inventories
and checks that only confirmed callback decisions change and body evidence stays.

`python dev/checkAnnotationOwnerChains.py --report <new-inventory> --baseline <old-inventory> --output <check-dir>`
compares the baseline's unresolved value declarations with the new plan and
records complete owner-chain terminals in `declaration-chains.parquet`.
It also simulates plan context dependencies bottom-up: composed children feed
their owner, references require originals, and required bodies are prerequisites.
The check validates endpoints, condenses cycles and verifies component levels.
Blocked evidence propagates to consumers. This checks the inventory plan;
Report v2 separates direct unresolved/review evidence from inherited-only
unconfirmed readiness, with reason counts and direct examples. These counts
are not independent extractor defect counts.
production profile dependencies and annotation freshness are not certified.
It generates no annotations and writes no Neo4j data.

Variable declarations retain their actual `VariableDeclarationList` and
`VariableStatement` containers. The generic AST pass emits
`AST_CHILD(field=declarations)` and `AST_CHILD(field=declarationList)`; rendered
identifier tiles are not used as declaration owners. Identical source ranges
(for example a statement without a semicolon) share a node, without self edges.
Catch clauses are declaration containers too: their binding has a direct
`AST_CHILD(field=variableDeclaration)` parent rather than an inferred mosaic owner.
Containers additionally carry `ENCLOSED_BY(resolution=nearest-materialized-ast-owner)`
to their nearest materialized AST ancestor. Skipped syntax kinds are recorded;
top-level containers terminate at a `SourceFile` node. These are structural
projections, not execution edges. Planner v11 accepts them at fallback tier 5,
after direct AST, Step and Block evidence. Equal-tier conflicts remain errors
for review. This does not certify all other entities' owner chains.
Existing snapshots need re-extraction before inventory counts can reflect it.
`node --import tsx dev/variableDeclarationOwnership.integration.mts` checks all
tracked declarations of the configured source project against its actual AST.
`python dev/variableDeclarationScoped.integration.py` checks that a real scoped
Telegram extraction transports the container edge and retains `VALUE_FROM`.

`node dev/annotationInventoryApi.integration.mjs` exercises real HTTP routes and
the configured Telegram extraction, checks operation conflicts and pagination,
and runs the actual ChatAbortController regression checks. No synthetic graph
is created. The original standalone CLI remains available:

`node --import tsx dev/flowBlockOwnership.integration.mts` extracts the actual
LeftColumn and deeplink functions and verifies that collapsing a block into its
only Step removes internal containment instead of producing `NESTED_IN` self
edges. Existing snapshots still report those errors until re-extracted; the
annotation planner does not repair or conceal them.

FlowBlock occurrence IDs now use the same local-function context as Step IDs.
The ownership regression also extracts GiftCraftModal's component, effect
callback and nested update callback, then checks their combined block IDs and
owners. Structural occurrences from different extraction contexts must not merge
into one block with multiple `NESTED_IN` parents. This is an extractor change;
old snapshot conflicts are intentionally retained until re-extraction.
The whole-component extraction also verifies contextual `for` entry/update
links. Those links must use the ID returned by `createNode`, not the raw source
coordinate, when the loop is expanded in another function's context.

```
python dev/inventoryAnnotationSubjects.py --parquet <snapshot> --output <report>
python dev/inventoryAnnotationSubjects.integration.py --report <report>
python dev/inventoryAnnotationSubjects.integration.py --report <v10-report> --previous-report <v9-report>
```

### Unresolved Reference Audit v2

The existing `/api/graph/annotation-inventory/audit/{plan,preflight,run,status,records}`
routes also report source module kind and compiler diagnostics for each unresolved
coordinate. When the project disables `checkJs`, a separate diagnostic Program
enables it without modifying extraction options or the source files. Reports
distinguish `declaredButUnlinkedReferences` from `unboundSourceReferences`.

`commonjs-binding-in-es-module` identifies an unbound CommonJS binding used by an
ES module. It records the expected runtime contract and `runtimeInjection=not-proven`.
Missing-name diagnostics do not exclude runtime injection by a bundler or host.
Neither this category nor `unbound-identifier` is automatically considered a system
boundary, a resolved dependency, or dead code. Annotation readiness decisions and
the fixed repair-cohort ledger remain unchanged by the diagnostic-only audit.

The CLI reuses an existing snapshot and inventory; it does not re-extract or import:

```text
node --import tsx dev/auditUnresolvedReferences.mts <snapshot> <new-report.json>
node dev/unresolvedReferenceAuditApi.integration.mjs <actual-audited-snapshot>
```
