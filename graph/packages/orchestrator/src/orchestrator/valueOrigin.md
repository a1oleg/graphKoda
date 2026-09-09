# Value-origin discovery, version 5

This is a separate mode, not `functional-accumulation`. It describes possible
static origins, never an observed execution. The contract is exported as
`valueOriginContract` and is available through GraphQL.

Implemented: persistent manual discovery; declared parameter members first;
all incoming parameter bindings after selecting a member (or immediately for scalars);
argument/parameter position and actual expression per call site; direct value
and reference origins; explicit literal/system boundaries; contextual task IDs;
depth/cycle boundaries and optimistic revision checks under a transaction lock.
No UI, generation, automatic next, or reuse of whole-entity annotations.

`selection: "usage"` starts a forward consumer discovery. A value declaration
with WRITES_TO switches to that traversal at the written state. Consumer hops
reverse RESOLVES_TO/READS_FROM/VALUE_FROM and follow BINDS_TO_PARAMETER forward;
they never use shared type membership as evidence of value transfer. Unsupported
transfers remain CONSUMER_TRANSFER_REQUIRED, not successful terminal nodes.

Forward usage preserves memberPath through HAS_PROPERTY, SPREADS_FROM and
parameter bindings, consuming one member on each matching READS_FROM projection.
Sibling field reads are excluded only with receiver-edge evidence. Ordered
explicit overwrites remove a path; a later unknown spread leaves an unresolved
overwrite, never a proven transfer. Call frames retain the selected invocation.

Context reads resolve providers along incoming JSX_CHILD/DECLARES_JSX and
call-site ancestry. The first matching provider on each path shadows outer
providers; independent paths are preserved with relationship properties and
extracted conditions. JSX passed as a prop is not assumed to be a rendered child.
Search limits, cycles and missing component ancestry remain explicit gaps.
This is structural possibility, not runtime instance identity. No global matching
of all providers by context type is used as a dispatch result.
Callable wrappers and aliases are traversed alongside direct calls, not instead
of them. Known parameter frames restrict call-site alternatives, including
bindings through up to eight identity links. Missing frame ownership is not
equivalent to a proven unique provider.

The structural horizon follows outgoing TYPED_AS, then RESOLVES_TO/ALIASES
(up to eight links), then HAS_MEMBER. It preserves the type path as evidence.
Each pending member keeps its parameter ID and selected member path. Expanding
it follows incoming SATISFIES_MEMBER and outgoing VALUE_FROM/RESOLVES_TO.
HAS_PROPERTY and BINDS_TO_PARAMETER constrain the field to arguments actually
passed to that parameter. Only source entities become tasks; objects and fields
remain path evidence, with call-site frames. Unrelated implementations of the
same type member and sibling fields are excluded. Missing paths are reported,
never replaced by whole-object tasks. Type signatures are not implementations.
No symbol names or framework-specific rules select this strategy.

Not yet implemented: indirect object projections without direct HAS_PROPERTY
evidence, reaching definitions at a use site, selected return/effect
slices with control dependencies, slice-specific intermediate annotations and
their fingerprinted cache. These cases become UNRESOLVED with a specific reason,
not a whole-function traversal or a false successful boundary. They are the next
discovery handlers to develop using the step-by-step evidence.

## Start (no traversal)

POST `/api/annotations/graphql`:

```graphql
mutation {
  startValueOrigin(input: {stableId: "screens/REPL.tsx:3142:38:3142:51", maxDepth: 8}) {
    runId revision rootId status nodes {id stableId state}
  }
}
```

## Expand exactly one task

```graphql
mutation Next($run: ID!, $revision: Int!, $task: ID) {
  nextValueOrigin(runId: $run, expectedRevision: $revision, taskId: $task) {
    runId revision status lastTaskId
    nodes {id stableId depth state profile reason context evidence}
    edges {from to relation direction evidence}
  }
}
```

Omitting taskId selects the first pending task in deterministic discovery order.
An explicit taskId selects the branch to inspect. Repeating an outdated revision
fails without progressing the run. Query `valueOriginPlan(runId: ...)` to resume
after a process restart. Run state is stored in `ValueOriginRun`, separate from
annotation jobs. Preparation does not change existing annotation records.

Plan edges point consumer -> required source. For value-flow visualization draw
sources below consumers, with value arrows upward; discovery traverses downward.
COMPLETE means the supported discovery reached boundaries, not that annotations
were generated or that a runtime path has been proven. Missing or limited paths
leave the run INCOMPLETE once no pending tasks remain.
