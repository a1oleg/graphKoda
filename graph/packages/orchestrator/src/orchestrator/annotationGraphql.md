# Annotation GraphQL

## Plan Viewer

Open `/annotation-plan`. The default starting subject is the `input` parameter
at `screens/REPL.tsx:3142:38:3142:51`. The form accepts another stableId and depth.
The build action prepares the plan without leasing or generating annotations.
The view uses locally served Cytoscape and Dagre, with consumer nodes above their
dependencies, selection details, state panels, search, zoom, refresh and JSON export.
No third-party CDN is used. This is a separate operational view; existing draw.io
code diagrams are unchanged.

`?jobId=<id>` reopens a persisted snapshot without rebuilding it.
`?stableId=<id>&depth=4&name=<display name>` selects a starting subject without
sending any graph request until the build action. The page updates its URL after
successful preparation. Refresh reads the snapshot and preserves graph positions
and zoom when topology has not changed. Next/save controls are not exposed yet.

## Transport

POST `/api/annotations/graphql`: `{ "query": "...", "variables": {...} }`.
GET `/api/annotations/graphql/schema`: `{ "sdl": "..." }`. Standard GraphQL
introspection is supported. GraphQL execution errors use the `errors` envelope.

The schema uses the executable annotation-profile registry, not the full list of
Neo4j labels. Labels remain provenance metadata. The existing resolver supplies
canonical subjects, cached annotations and depth-boundary references; there is
no second scheduler or LLM-generated execution plan.

## Prepare

```graphql
mutation Prepare($input: AnnotationPlanInput!) {
  prepareAnnotationPlan(input: $input) {
    jobId rootId requestedRootStableId maxDepth state
    nodes { id stableId kind profileId profileVersion state referenceOnly }
    edges { id from to role dependencyKind ordinal }
  }
}
```

Variables: `{ "input": { "stableId": "<graph stableId>", "maxDepth": 4 } }`.
Depth defaults to 4; supported range is 0..8. Preparation runs the existing
context resolver and persists the workflow, but does not lease a task or generate
text. Initial preparation is NOT a cheap ID-only graph traversal.

## Diagram and Panels

```graphql
query Observe($jobId: ID!) {
  annotationPlan(jobId: $jobId) {
    jobId rootId state observedAt
    nodes { id stableId kind state blockedBy referenceOnly }
    edges { id from to role dependencyKind ordinal }
    working { id stableId taskId leaseExpiresAt }
    waiting { id stableId blockedBy }
    available { id stableId }
  }
}
```

This query reads the persisted plan without resolving source contexts or changing
leases. It returns no annotation text or source content. Snapshot reads currently
reject plans exceeding 2000 annotation records. The limit is not silent truncation.

Edges point from consumer to dependency. Layout clients can use these stable IDs
directly. Execution is bottom-up. Shared dependencies have one node, and reference
boundaries have no annotation task. `working` is the current-work panel;
`waiting` contains dependency-blocked tasks; `available` contains runnable tasks
that have not been started. Expired leases become available again. Poll this query
 after mutations; subscriptions are not implemented yet.

## Next and Save

```graphql
mutation Next($jobId: ID!) {
  nextAnnotation(jobId: $jobId) {
    state
    task {
      jobId taskId annotationId stableId leaseToken annotationKind
      objective requirements contextBundle completion
    }
    plan { state working { id } waiting { id } available { id } }
  }
}
```

`nextAnnotation` leases at most one task for this job. Repeating it while an
unexpired task is active returns `WAITING`; it does not start a second task.
The worker receives the context only for its leased task. The existing five-minute
lease timeout applies. This is a job-level stepping control, not a global lock
across different workflows or legacy REST clients.

```graphql
mutation Save($input: AnnotationResultInput!) {
  completeAnnotation(input: $input) {
    jobId state available { id } working { id } waiting { id }
  }
}
```

Input contains `jobId`, `taskId`, `annotationId`, `leaseToken`, `text`.
Saving checks the active lease and uses the existing database writer, including
annotation metadata. It does not automatically lease the next task. The worker's
`completion` descriptor points to this GraphQL operation, not the auto-advancing
legacy REST endpoint. Only an explicit next action advances the GraphQL workflow.
