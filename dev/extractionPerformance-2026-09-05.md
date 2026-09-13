# Extraction performance regression

## Cause and fix

Commit `cea1f021` introduced a full scan of canonical entities inside the
per-function loop, rebuilding the same Operation ID set for each body.
The full extractor now builds one read-only index and reuses it. Scoped
extraction retains its local index. Ownership rules are unchanged.

## Full dataset measurement

Same workspace and input corpus; optimized run includes Node CPU profiling.
No Neo4j writes were performed by the optimized verification run.

| Phase | Before, seconds | After, seconds |
| --- | ---: | ---: |
| Extraction | 2250.785 | 591.677 |
| Validation/canonicalization | 459.623 | 392.780 |
| Complete staging | 2710.616 | 984.595 |

Extraction is 3.80x faster; complete staging is 2.75x faster.
This is not a new end-to-end Neo4j import timing.

The optimized CPU profile samples approximately 0.084 seconds of self time
in collectOperationIds and 0.684 seconds in attachImmediateStepOperationGraph.
Remaining prominent costs include DuckDB appender flushes and garbage collection.

## Equivalence

Both catalogs contain 1,772,499 nodes and 4,090,110 relationships.
EXCEPT ALL in both directions found zero differences in labels and properties
after excluding only source_state_id. That provenance field intentionally
changes with the dirty worktree hash. Relationships matched even without that
exclusion. Raw record counts also matched exactly.

10 regression tests passed, including shared/local ownership equivalence,
idempotence, signature boundaries, and canonical reference resolution.

## Reproduce

```powershell
node --cpu-prof --cpu-prof-dir=tmp --cpu-prof-name=extract-optimized.cpuprofile --import tsx graph/static-extract/ts/fromASTtoPreGraphFlow.ts --output-format duckdb --staging-path tmp/extract-performance.duckdb --parquet-dir tmp/extract-performance-parquet
.venv/Scripts/python.exe dev/compareExtractionCatalogs.py graph/.runtime/cache/function-flow-parquet tmp/extract-performance-parquet --ignore-source-state
node --import tsx --test graph/static-extract/ts/functionFlowGraph.operationIndex.test.ts graph/static-extract/ts/functionFlowGraph.canonicalReferences.test.ts graph/static-extract/ts/functionFlowGraph.signatureBoundary.test.ts
```

Baseline log: graph/.runtime/logs/extract-func-2026-09-05T09-15-23-734Z.log.
Profile: tmp/extract-optimized.cpuprofile.
