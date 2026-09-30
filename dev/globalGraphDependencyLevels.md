# Global Dependency Levels

## Orchestrator API

- `GET /api/graph/ranking/plan`: configured snapshot, outputs, both level definitions.
- `GET /api/graph/ranking/preflight`: files, Python dependencies, operation conflicts.
- `POST /api/graph/ranking/run` with `{}`: calculate both scales; returns HTTP 202 and `runId`.
- `GET /api/graph/ranking/status?runId=<uuid>`: progress, completion, report; defaults to active/latest run.
- `POST /api/graph/ranking/persist` with `{"runId":"<uuid>"}`: publish after full snapshot preflight; HTTP 202.
- `POST /api/graph/ranking/recover` with `{}`: recover an orphan lock only when recorded processes are dead.

Runs use the configured project data root, with isolated report directories under
`checks/graph-ranking/<runId>`. Progress, reports and logs survive restarts.
After a crash no success is inferred: recover the lock after the old processes
stop, then calculate again or retry publication of a completed calculation.
These routes are in OpenAPI/Swagger. Managed extraction/reset and ranking are
mutually excluded; external CLI operations must not run concurrently.

HTTP integration on the actual configured graph:
`node dev/graphRankingApi.integration.mjs --persist`.
Omit `--persist` for calculation-only verification.

Read the completed extraction once, without Neo4j queries, recursive per-root
expansion, annotation generation, or database mutations:

```powershell
.\.venv\Scripts\python.exe dev/globalGraphDependencyLevels.py `
  --parquet C:\GitHub\graphKoda-data\telegram-tt\checks\streaming\parquet `
  --output C:\GitHub\graphKoda-data\telegram-tt\checks\global-dependency-levels
```

The input is the same canonical Parquet graph imported into Neo4j. No source
compilation or extraction is repeated. The output contains:

- `levels.parquet`: stable ID, labels, SCC identifier, structural level,
  component level (shared by every member),
  cycle membership, unresolved dependency-semantics flag, `dependency_status`
  (`cyclic-dependency`, `depends-on-cycle`, `acyclic`), and
  `code_recursion_confirmed=false` for every node.
- `summary.json`: provenance, explicit directional policy, its hash, relation
  coverage, waves, cycle samples, a reciprocal-cycle witness when available,
  timings, and verification results.

`consumer -> prerequisite` is the normalized direction. Level zero means no
prerequisites **under this policy**, not an annotation-ready or system node.
Subsequent levels equal `1 + max(prerequisite levels)`. Unknown relationship
semantics taint their endpoints and all dependent consumers. SCCs are not
treated as annotated: cycle members and their consumers have level `-1`.
SCC identifiers are report-local; use stable IDs across runs.

This first inventory is deliberately NOT certified equivalent to production
annotation profiles. It includes canonical references, value provenance,
composition and direct ownership, not all profile-specific context rules.
Combining ownership, calls and inverse parameter binding may create large SCCs
without implying defects in source extraction. Existing annotations are ignored.
Do not use this report alone to dispatch annotation generation.

The annotation resolver separately detects witnessed cycles in its actual loaded
recursive dependencies. It persists `context.dependencyCycle` with a closed
stable-ID path and passes it to generation tasks with an explicit requirement
to disclose the unresolved cyclic dependency. A queued sibling is not cycle
evidence. Detection is limited to the loaded depth; absence of a witness is not
proof that deeper dependencies are acyclic. No runtime ordering or code recursion
is inferred from a dependency cycle. This does not implement fixed-point solving.

Version 3 additionally calculates the condensation DAG of strongly connected
components. `component_level` is zero for groups without external prerequisites,
otherwise one plus the maximum prerequisite-group level. All group members share
this level. Every inter-group dependency and the exact maximum recurrence are
checked, and all groups must be processed. Already defined individual levels
must equal their component levels. Cyclic groups are still marked cyclic; their
group level does not declare internal dependencies resolved or annotations ready.

The next integration must make the dependency policy shared with the annotator,
classify unresolved relation roles, and distinguish task/context facets where
necessary. This is explicit in `annotationProfilesCertified: false`.

The graph algorithms are iterative SCC decomposition and bottom-up Kahn
propagation, linear in the projected node and edge counts. Every assigned level
is verified against every dependency, including the max-level recurrence.

## Persist to Local Neo4j

```powershell
.\.venv\Scripts\python.exe dev/persistGlobalGraphDependencyLevels.py `
  --report C:\GitHub\graphKoda-data\telegram-tt\checks\global-dependency-levels
```

Preflight checks the complete stable-ID set, uniqueness, extraction provenance,
relationship count, report policy checksum and Parquet totals before writing.
Writes use element IDs from one scan, not per-batch full scans by stable ID.
Original labels, relationships and annotations are not changed.

Derived node properties are `dependencyStructuralLevel`, `dependencyComponentLevel`, `dependencyStatus`,
`dependencyComponent`, `dependencySemanticsUnknown`, `dependencyLevelRunId`.
Cycle-blocked nodes have no numeric level, not level zero. A `DependencyLevelRun`
stores policy/version, source provenance and file checksum. Component numbers
are scoped to that run. Consumers must join a run with `status='complete'`;
failed or interrupted batch writes must not be consumed. Rerunning replaces only
these derived properties after preflight. Do not run concurrently with reimport.
After writing, every component's minimum and maximum stored level are checked
against the report, including missing values and total component count.

```cypher
MATCH (run:DependencyLevelRun {status: 'complete'})
MATCH (n)
WHERE n.dependencyLevelRunId = run.runId
RETURN n.dependencyComponentLevel AS level,
       n.dependencyStatus AS status, count(*) AS nodes
ORDER BY level, status
```
