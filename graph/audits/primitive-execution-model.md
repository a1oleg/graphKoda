# Primitive execution model

`graph/draw/new.drawio` is a semantic reference, not a schema. Shapes, overlap,
color, and sequence axes must be projections of graph facts. The renderer must
not recover business meaning from text, method names, or assigned coordinates.

## Layers

The model uses composable facets rather than one exclusive node kind:

- Entity: `Binding`, `ValueSlot`, `ValueVersion`, `Collection`, `Object`,
  `Field`, `Cell`, `Fn`, `Method`.
- Operation: `Primitive` plus `primitive_kind`.
- Control: `Branch`, `Join`, `Loop`, `Flow:Block`, `Outcome`.
- Invocation: `CallSite`, `FnVisualProxy`, `Result`.
- Projection: Draw.io shape, nesting, color, and axis placement. Projection is
  not source semantics.

Control and data are independent edge layers. A call edge is control. An
argument or result edge is data. The same source construct may produce both.
Structural relations such as `HAS_FLOW_BLOCK` are neither control nor data and
use `flow_layer = structure`.

## Scope, operations, and axes

An axis is not a graph entity. It is a rendering of an executable scope and
the ordered operations owned by that scope:

- a function axis projects a `Fn` and its control-flow members;
- a collection-method axis projects an `Iterator` and its per-item subflow;
- a callback axis projects a callback `Fn` when that callback has enough
  internal behavior to be useful as a separate scope.

The extractor creates an iterator scope plus executable operations and
ownership/order facts. It must not create `Axis` nodes merely because the
renderer needs a vertical line.

## Primitive vocabulary

The initial vocabulary is:

`Iterate`, `Pull`, `Bind`, `Evaluate`, `Branch`, `Emit`, `Accumulate`,
`Effect`, `Order`, `Repeat`, `Assign`, `Read`, `Write`, `Invoke`.

`firstOrNull` is not a primitive. The reusable primitive is `Pull`, with two
control outcomes:

```text
Pull -[:ITEM_AVAILABLE]-> Bind
     -[:EXHAUSTED]-> ...
```

The Flow projection may render this policy as `nextOrNone` inside the
collection. The static graph retains the two outcomes rather than inventing a
generic result node.

`set` is also not a single primitive:

- `Assign` writes a computed value to a local binding.
- `Write` mutates state or storage visible outside that local evaluation.
- `Emit` adds an accepted/transformed item to the result of a pure collection
  transformation.
- `Accumulate` updates the accumulator of a reduction.

## Collection lowering

Native collection methods are lowered to a common static protocol:

```text
Iterator
  -> Pull
     -[:ITEM_AVAILABLE]-> Bind -> callback body
     -[:EXHAUSTED]-> method-specific terminal route

callback outcome
  -> Emit|Accumulate|Effect|Assign
  -> Repeat -> Pull
```

Method-specific behavior comes from a language semantics catalog, guarded by
TypeScript type and signature resolution. It is not inferred from arbitrary
callee spelling. CodeQL can resolve aliases and developer-defined targets, but
it cannot replace the ECMAScript semantics catalog for native methods.

The result route is consumer-aware. A synthetic `Result` or `Complete` node is
not inserted merely to close the protocol:

- `find`: predicate true routes the bound element into the consumer `Assign`;
  predicate false repeats; exhaustion routes `undefined` into that assignment.
- `filter`: predicate true emits/appends the bound element into the destination
  collection and repeats; predicate false repeats.
- `map`: the callback value is emitted/appended into the destination collection
  and repeats.
- `reduce`: the seed creates the accumulator value; each callback value
  replaces the accumulator; exhaustion routes the accumulator to the consumer.
- `some` / `every`: short-circuit and exhausted outcomes route their boolean
  literals to the consumer.
- `forEach`: the callback effect repeats; exhaustion only exits control.
- explicit `for` / `for..of` use the same `Pull -> Bind -> body -> Repeat`
  protocol, with `break`, `return`, and `throw` as terminal outcomes.

A result value is materialized only when it has an observable identity or an
independent consumer boundary: it is stored, read more than once, crosses an
async boundary, or becomes the receiver/input of another operation. For direct
assignment or argument passing, data flows from the actual producer directly
to `Assign` or the argument binding.

`sequence_owner_stable_id` groups primitive events into sequence-like lanes
without making lane geometry semantic. Runtime completion is an event on the
iterator/call scope; it is not a mandatory static `Complete` node.

## Calls, receivers, and visual nesting

A method drawn inside a collection, variable, object, or storage cell is
backed by occurrence-level facts:

```text
(callSite)-[:INVOKES]->(method)
(method)-[:ON_RECEIVER]->(receiver)
(method or callSite)-[:PRODUCES_VALUE]->(result) // only at a value boundary
```

For a library method, `method` is `:System:Method` and may have no project
source location. The call site still has its own source stable ID.

Draw.io overlap is then a projection of `ON_RECEIVER`; it is not evidence used
by extraction. Receiver occurrences are hidden from the current Flow
projection until it renders collection/object composition directly from these
facts.

## Expressions and outcomes

An expression hexagon is an `Evaluate` or `Branch` primitive. Referenced
bindings are operands connected by data edges. `true`, `false`, `accepted`,
`rejected`, `item-available`, `exhausted`, and `short-circuit` are explicit
outcomes. Overlaying an expression on a sequence lane means
`sequence_owner_stable_id`; it does not mean that the expression is physically
contained in another node.

## Flow blocks

Side execution regions are now extractor facts:

- node labels: `:Flow:Block`;
- `ownerBranchStableIds`;
- `flowBlockRole` and `flowBlockOutcome`;
- `parentFlowBlockStableId`;
- `headStableIds` and `tailStableIds`;
- member nodes carry their direct `parentFlowBlockStableId`.

The renderer may measure and place these regions. It must not rediscover them
by walking positioned `TRUE`, `FALSE`, and `REJOINS` edges.

## Values and initialization

An unfilled variable in the reference diagram means that a binding exists but
no value version has been assigned at that point. This should ultimately be
modelled as binding identity plus value versions:

```text
Declaration -> Binding
Expression -> Assign -> ValueVersion -> Binding
Read -> consumes the dominating ValueVersion
```

The current slice materializes `Assign` between expression results and local
value slots. Direct `RESULT` edges remain temporarily marked
`semantic_expansion = diagram-projection` until the Flow renderer consumes
`Assign -> ValueSlot`.

## Build-time instrumentation

Every executable primitive carries:

- `runtime_event_kind`;
- `instrumentation_strategy`;
- `instrumentation_phase`;
- `instrumentation_target_stable_id`.

`dev/buildPrimitiveInstrumentationManifest.mjs` converts extracted facts into
a Babel-consumable manifest.

For native collection methods, callback wrapping can log every tested or
transformed item without first rewriting the method into a hand-written loop.
The call wrapper logs entry, exhaustion, completion, and thrown errors. A later
explicit loop lowering must preserve sparse arrays, mutation during iteration,
`thisArg`, missing reducer seeds, exception behavior, and short-circuit rules.

## CodeQL boundary

Use AST and the TypeScript checker for local syntax lowering and exact build
rewrite locations. Use CodeQL facts for:

- cross-file target resolution and aliases;
- call graph reachability;
- storage/state provenance;
- accessor and mutator discovery;
- validation that a presumed receiver or method resolves consistently.

Do not make CodeQL a prerequisite for recognizing local `if`, assignment,
callback, or native collection semantics. Async scheduling remains a separate
TODO because its ownership and completion outcomes need a dedicated protocol.

## Projection patterns derived from `graph/draw/new.drawio`

The reference diagram is interpreted by pattern, not copied cell by cell:

| Reference composition | Required graph facts | Projection |
| --- | --- | --- |
| method name over a vertical line | iterator/callback scope with ordered owned operations | draw one sequence-like lane |
| collection with an embedded method | `INVOKES` plus `ON_RECEIVER` | overlap method and receiver shapes |
| item such as `cmd` entering predicates | `Pull -> Bind`, then `PASSES_VALUE` and operand reads | draw value occurrences where they clarify use |
| `cmd -> set -> matchingCommand` | bound item data into `Assign`, then `Assign -> ValueSlot` | draw assignment near its destination |
| false route back to method | callback false outcome to `Repeat -> Pull` | draw the repeat corridor |
| true route into `set`, `push`, or `add` | outcome-controlled `Assign`, `Emit`, or `Accumulate` | draw the data mutation, not a generic result |
| value used by the next dotted call | producer to a materialized value boundary, then `ON_RECEIVER` | draw the intermediate receiver |

## Golden reference workflow

`graph/specs/hybrid-flow-reference.json` is the executable semantic
interpretation of `graph/draw/new.drawio`. It does not copy coordinates. It
stores:

- semantic roles and required labels/properties;
- required control/data relationships;
- forbidden synthetic boundaries;
- relative composition constraints such as `LEFT_OF`, `BELOW`, `OVERLAYS`,
  lane order, and route policy.

Import it with `npm run graph:reference:import`. The importer validates every
referenced draw.io cell and stores the source file hash in Neo4j under
`:GoldenModel`. Run `npm run graph:reference:check` after extraction. The check
fails when the reference file changed since import or when the extracted graph
does not satisfy the golden entity/relationship contract.

Golden labels and source cell IDs are test-fixture metadata. Production
extraction and rendering must continue to use TypeScript/AST/CodeQL facts and
the reusable protocols in this document; they must not query `Golden*` nodes.

## Migration order

1. Consumer-aware primitive collection and assignment facts.
2. Extractor-owned `Flow:Block` facts.
3. Renderer consumes receiver/method facts and removes transitional projection
   edges.
4. Babel consumes the primitive manifest and emits runtime events keyed by the
   same stable IDs.
5. Add async scheduling, cancellation, resumption, and responsibility transfer.
