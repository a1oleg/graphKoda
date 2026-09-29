# Global Dependency Levels

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

The next integration must make the dependency policy shared with the annotator,
classify unresolved relation roles, and distinguish task/context facets where
necessary. This is explicit in `annotationProfilesCertified: false`.

The graph algorithms are iterative SCC decomposition and bottom-up Kahn
propagation, linear in the projected node and edge counts. Every assigned level
is verified against every dependency, including the max-level recurrence.
