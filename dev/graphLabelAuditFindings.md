# Label Audit Findings

Snapshot: 2026-09-05. No database mutation, deletion, import, or annotation generation was performed.

Reproduce: `node dev/auditGraphLabels.mjs`. Default artifacts: `tmp/graph-label-audit/labels.json` and `labels.md`.

## Scope

- 1,765,970 nodes; 254 registered labels; 248 live labels.
- 3,448 distinct sorted-label/explicit-annotationKind combinations.
- 13 pairs have identical populations. Identity in this snapshot is not semantic equivalence.
- The profile matrix calls production `inferAnnotationKind`, including explicit annotationKind. Canonical subject resolution, invocation edges and traversal hints can override that selection; this is not a complete annotation-plan simulation.
- Source references are lexical matches in graph/dev source files, not a complete static data-flow analysis. No live label lacked a source mention in that scope.

## First Priority: Missing Annotation Profiles

5,197 nodes resolve to unregistered profile kinds:

| Kind | Nodes |
|---|---:|
| LiteralOccurrence | 4,122 |
| LiteralDomainValue | 880 |
| LiteralDomain | 195 |

These are actively emitted, not merely old database residue: see `graph/static-extract/ts/functionFlowGraph.literalDomains.ts:223`, `:235`, `:317`.
The orchestrator accepts explicit kinds in `inferAnnotationKind` but its profile registry has no corresponding implementations.
Direct annotation requests for such subjects risk `No annotation profile`; first decide whether each kind is independently annotatable or reference-only.

## First Priority: System / Developer Boundary

465 nodes carry both `System` and `DeveloperDefined`: 463 FunctionType and 2 ConstructorType declarations.
Example: `QueryEngine.ts:1237:15:1237:29`.

Their label sets also contain ValueDeclaration and CallableDeclaration, so the type-only guard in `annotationProfiles.js:34` does not suppress them; label-based selection yields FunctionalEntity.
Conversely, traversal can stop on their System label. These are inconsistent signals, even though both labels might originate from distinct views of the same source range.

Relevant generation sites: `functionFlowGraph.canonicalReferences.ts:145` assigns callable/value/developer labels; `:482` emits derived types. The exact merge path and the intended type/operation boundary need a focused regression fixture before any relabeling.

## Co-occurrence Candidates, Not Deletion Instructions

| Pair | Nodes | Source-backed assessment |
|---|---:|---|
| CapturedBinding / ValueCapture | 9,530 | Both actively emitted in functionFlowGraph.valueAccess.ts:539. CapturedBinding is used by annotation queries and indexes; do not remove based on overlap. |
| FiniteDomainValue / LiteralOccurrence | 4,122 | Both actively emitted for literal occurrences in functionFlowGraph.literalDomains.ts:309. Could describe domain membership versus occurrence identity. |
| ExternalBoundary / ExternalDeclaration | 4,073 | Emitted together for ambient declarations in functionFlowGraph.canonicalReferences.ts:156. Origin and stopping boundary are distinct concerns. |
| Pull / Shift | 4,033 | Emitted together in fromASTtoPreGraphFlow.ts:10838 and other collection sites. Candidate for explicit semantic-operation versus presentation naming. |
| AssignmentOperator / Operator | 823 | Specific/general roles, actively emitted together in fromASTtoPreGraphFlow.ts:9593. Not automatically duplicates. |
| ResourceProxy / Store | 108 | Active generator at fromASTtoPreGraphFlow.ts:6488. ResourceProxy controls geometry/visibility in localCoordinateDrawio.mjs; Store must not simply be substituted for it. |
| ReactState / StateVariable | 29 | Both actively emitted at functionFlowGraph.canonicalReferences.ts:1360. Framework origin versus state role. |

The remaining exact pairs and all directional overlaps are included in the generated report.

## Empty Registered Labels

ArgJoin, DetachedAsyncCall, File, Obj, Package, UpdaterFn currently have no nodes.
An empty registered label is not evidence that a live node needs changing. Some names remain in supported node-kind enums, normalization allowlists, or profile fallback rules.
In particular, File/Package are still consulted by Module selection; verify the intended importer before calling these obsolete.

## Recommended Order

1. Resolve missing profile registrations / reference policy for finite literal domains.
2. Reproduce the FunctionType and ConstructorType boundary overlap and fix its source, not the database alone.
3. Classify label roles: identity, syntax, execution, origin/boundary, presentation, annotation infrastructure. This is a proposed audit vocabulary, not new graph labels.
4. Verify candidate aliases against actual label-writing and label-reading sites; migrate only explicitly approved equivalents.
5. Freeze the resulting profile-selection contract in tests before exposing it as GraphQL schema.

Neo4j and repository search suffice for this audit. CodeQL could later trace dynamically constructed label arrays through emitters/importers and their consumers; it is not needed to establish the counts or the two priority findings above.
