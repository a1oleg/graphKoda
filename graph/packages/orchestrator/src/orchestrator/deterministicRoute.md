# Deterministic origin routes

The hard adapter reads canonical facts from the existing graph. The soft layer
applies the exported `routeRules` and persists `DeterministicRouteRun` records.
It does not load the replay scenario, parse syntax strings, ask an agent to find
links, change extraction facts, or reuse prose annotations as origin evidence.

## Initial scope

Objective: `object-origin`. Start at any stable ID, not a predefined end node.
Parameters follow incoming `BINDS_TO_PARAMETER`, preserving the supplying call
and argument position verified through `HAS_ARGUMENT`. Object constructions stop
at their lexical function owner. Parameter/typed-object display labels do not
count as runtime creation. References follow explicit value/symbol relations;
unknown reaching definitions and call-result slices remain gaps.

`COMPLETE` means all discovered branches have a result in the loaded graph. It
does NOT certify that the extraction contains every runtime caller, that branch
conditions are feasible, or that the source checkout matches the imported graph.
The result records `coverage: loaded-hard-graph-only`. Object contents, state
consumers, return slicing and automatic scoped import are not implemented here.
No syntactic or name-based fallback fills these gaps.

## Execution

From the tool repository:

```powershell
node dev/deterministicRoute.mjs start screens/REPL.tsx:3142:82:3146:3
node dev/deterministicRoute.mjs next <runId> 0
node dev/deterministicRoute.mjs next <runId> 1
node dev/deterministicRoute.mjs read <runId>
```

`run <stableId>` advances until no tasks remain pending. Each `next` expands one
task and collects ready dependency results into waiting parents. Events expose
both expansion and collection. It generates no annotation text.

GraphQL adds `deterministicRouteContract`, `deterministicRoute(runId)`,
`startDeterministicRoute(input)` and
`nextDeterministicRoute(runId, expectedRevision, taskId)` to the existing schema.
Run writes use the existing transaction/lock/revision pattern. Read returns the
saved snapshot; it is not a freshness check. Start reuses a completed result only
after revalidation; next revalidates previously read facts before advancing.

Fingerprints cover the complete bounded query result, including empty results.
An added binding therefore invalidates a plan, not just changed existing edges.
A changed result yields `STALE`; start again to rebuild. Negative results and
incomplete runs are not reused as successful cache entries. Cross-run completed
subtask caching and incremental repair are future work; task sharing within a
run is based on entity and binding context, without arrival history.

The initial bound is 100 tasks, configurable up to 1000, and 500 facts per probe.
Hitting a bound is a gap, never success. Cycles terminate explicitly. This bounds
the implementation; it does not claim general interprocedural analysis is cheap.

## Verified example

For `screens/REPL.tsx:3142:82:3146:3`, two rule applications find:

Saved run: `0b1f0166-18e9-4441-a6cb-bfaadda8a792`, revision 2, COMPLETE
within the loaded graph. Two tasks, one dependency edge, plus owner evidence.

```text
onSubmit.speculationAccept
  <- third argument of PromptInput.tsx:1021:13:1029:10
  = object construction at PromptInput.tsx:1025:11:1029:9
  -> lexical owner at PromptInput.tsx:984:31:1105:3
```

The argument and construction are the same hard entity. There is no invented
intermediate VALUE_FROM edge. The owner is result evidence, not another origin
task requiring a traversal through the entire function body.
