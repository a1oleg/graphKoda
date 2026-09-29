# Source extraction benchmark

Uses the configured source repository and the production TypeScript extractor.
Does not import into Neo4j or modify source files. Run from the tooling repository.

```powershell
node dev/benchmarkSourceExtraction.mjs --fn src/util/buildClassName.ts:7:15:9:1 --timeout-seconds 180
node dev/benchmarkSourceExtraction.mjs --full --timeout-seconds 180
```

`--fn` is repeatable. Each selected function is extracted twice using the same
Program and context; output hashes must match. `--full` exercises the in-memory
full-program extraction API, not the DuckDB staging/import pipeline.

The parent process enforces the timeout even when synchronous AST traversal
blocks the worker event loop. Timeout exits with code 124. Other extraction
failures remain failures and are recorded with a stack trace.

JSONL reports default to `<dataRoot>/checks/extraction-benchmark.jsonl`;
`--output` selects another report. Reports contain stage durations, RSS samples,
graph counts, repeated-result checks and termination status. RSS samples are
not a continuous peak-memory measurement. `GRAPH_EXTRACT_TIMINGS=1` also enables
context-stage diagnostics in other extractor entry points.

## Scoped response contract

`extractFunctionFlowGraphs(program, stableId, context)` returns the lexical flow
and outgoing semantic references with boundary entities. It does not expand
incoming callers, parameter sources or their provenance frames.

Explicit expansion is available as the fourth argument
`{ includeParameterOrigins: true }`, the HTTP `/extract` request field
`includeParameterOrigins: true`, or CLI `--include-parameter-origins`.
The scoped database importer requests this explicitly on both HTTP and CLI paths,
so reimport continues to preserve parameter provenance. Full extraction retains
its complete graph. The Program context calculates parameter-origin facts lazily
and reuses them once requested; canonical reference collection remains global.

To compare body-only and expanded responses against real source:

```powershell
node dev/benchmarkSourceExtraction.mjs --fn src/util/buildClassName.ts:7:15:9:1 --compare-origins
```

Use `--include-parameter-origins` to benchmark repeated expanded responses.

Verified on Telegram `buildClassName`: body response has 1 function, 6 flow nodes,
5 flow edges, 22 semantic entities and 43 semantic relationships. Repeated body
responses have identical hashes. Explicit expansion restores the previous 683
function records and 4324 flow nodes; its hash matches the pre-change report
(`37655d04833848f9cfcc671d060b84a3e928372fa9ec3eebc92aa30e682f4a7d`).
Warm body extraction measured 3.73s; cold context still took 72.6s.
Report: `<dataRoot>/checks/scoped-body-vs-origins.jsonl`.

## Telegram baseline, 2026-09-29

Source: telegram-tt, commit `28ffcf710b15571e5a2f7bb3bdce3fc90fc8ec80`.
Tool runtime: Node 22.20.0 (separate from the source application's Node 26).

- Program: 1.99-2.81 seconds; 1825 roots, 2145 source/declaration files.
- Context: 76.6 seconds in the measured scoped run. Parameter origins: 31.9s;
  canonical references: 37.8s. Sampled RSS reached 3836 MiB.
- `buildClassName` (`7:15:9:1`): 9.28s first, 6.60s repeated. Result includes
  683 function records, 4324 flow nodes, 4357 flow edges, 9436 semantic entities,
  13524 semantic relationships. Parameter provenance includes caller boundaries;
  these are not 683 extracted function bodies.
- `createClassNameBuilder` (`11:7:28:1`): 7.53s first, 4.64s repeated;
  2 function records, 8 flow nodes, 7 flow edges, 84 semantic entities,
  125 semantic relationships.
- Both repeated outputs have identical SHA256 hashes. Literal-domain collection
  now runs once per context (5.08s), rather than once per request. This does not
  solve the remaining context cost or whole-program work in scoped requests.
- Full in-memory extraction failed at `src/util/debugOverlay.ts:101:4:101:17`,
  `counters = {}` inside the click callback: `Assignment container node not found`.
  No successful full-extraction or import claim is made.
- External timeout was exercised with a 10ms deadline; the worker terminated
  and the report recorded `timedOut: true`.

Reports: `<dataRoot>/checks/{full-extraction,scoped-extraction,timeout-check}.jsonl`.
No database writes were performed. Next blockers: assignment materialization,
cold context cost, and the scope/size of parameter-origin expansion.

## Callback assignment fix

`createNode` contextualizes IDs inside horizontal callback compositions. Object
assignment now uses its returned ID instead of looking up the raw source ID.
`node --import tsx --test dev/telegramAssignment.integration.test.mjs` passes
against real Telegram `setupOverlay`, checking the contextual write and its edges.

The subsequent full in-memory run passed the former assignment failure but
exhausted the default Node heap (about 4 GiB) after about 146 seconds. This is not
a successful full extraction; the streaming DuckDB path was not exercised by
this run. Report: `<dataRoot>/checks/full-extraction-assignment-fix.jsonl`.
