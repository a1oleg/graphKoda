import { buildSchema, graphql } from 'graphql';
import { startValueOrigin, readValueOrigin, nextValueOrigin, valueOriginContract } from './valueOrigin.js';
import { annotationProfileContract } from './annotationProfiles.js';
import { startAnnotationWorkflow, leaseNextAnnotationTask, completeAnnotationWorkflow } from './annotationResolver.js';

// Kinds come from the executable profile registry, not from every Neo4j label.
export const annotationSchemaSDL = `
  scalar JSON
  enum ValueOriginState { PENDING EXPANDED BOUNDARY PURPOSE_BOUNDARY UNRESOLVED LIMIT }
  enum ValueOriginRunState { PAUSED COMPLETE PURPOSE_COMPLETE INCOMPLETE }
  type ValueOriginTask {
    id: ID!, stableId: ID!, depth: Int!, state: ValueOriginState!,
    profile: String, reason: String, context: JSON!, evidence: JSON!
  }
  type ValueOriginEdge { from: ID!, to: ID!, relation: String!, direction: String!, evidence: JSON! }
  type ValueOriginPlan {
    runId: ID!, revision: Int!, mode: String!, version: Int!, rootId: ID!, maxDepth: Int!,
    status: ValueOriginRunState!, nodes: [ValueOriginTask!]!, edges: [ValueOriginEdge!]!, lastTaskId: ID
  }
  input ValueOriginInput { stableId: ID!, maxDepth: Int = 8, selection: String = "value", objective: String = "purpose" }
  enum AnnotationKind { ${Object.keys(annotationProfileContract).join(' ')} }
  enum AnnotationNodeState { REFERENCE READY AVAILABLE WAITING RUNNING }
  enum AnnotationPlanState { COMPLETE RUNNING PAUSED WAITING }
  enum AnnotationNextState { LEASED WAITING COMPLETE }
  type AnnotationProfile { kind: AnnotationKind!, id: ID!, version: Int! }
  type AnnotationPlanNode {
    id: ID!, stableId: ID!, displayName: String, annotationId: ID, taskId: ID,
    kind: AnnotationKind, profileId: ID, profileVersion: Int,
    labels: [String!]!, state: AnnotationNodeState!, referenceOnly: Boolean!,
    leaseExpiresAt: String, blockedBy: [ID!]!
  }
  "Direction: consumer -> required dependency. Execution proceeds dependencies first."
  type AnnotationPlanEdge {
    id: ID!, from: ID!, to: ID!, role: String!, dependencyKind: String!, ordinal: Int!
  }
  type AnnotationPlan {
    jobId: ID!, requestedRootStableId: ID!, rootId: ID!, maxDepth: Int!,
    state: AnnotationPlanState!, observedAt: String!,
    nodes: [AnnotationPlanNode!]!, edges: [AnnotationPlanEdge!]!,
    available: [AnnotationPlanNode!]!, working: [AnnotationPlanNode!]!, waiting: [AnnotationPlanNode!]!
  }
  type AnnotationWorkItem {
    jobId: ID!, taskId: ID!, annotationId: ID!, stableId: ID!, leaseToken: String!,
    annotationKind: AnnotationKind!, objective: String!, requirements: [String!]!,
    contextBundle: JSON!, completion: JSON!
  }
  type AnnotationNext { state: AnnotationNextState!, task: AnnotationWorkItem, plan: AnnotationPlan! }
  input AnnotationPlanInput { stableId: ID!, maxDepth: Int = 4, atStableId: ID, atOperationIndex: Int }
  input AnnotationResultInput {
    jobId: ID!, taskId: ID!, annotationId: ID!, leaseToken: String!, text: String!
  }
  type Query {
    valueOriginContract: JSON!
    valueOriginPlan(runId: ID!): ValueOriginPlan!
    annotationProfiles: [AnnotationProfile!]!
    "Read-only snapshot. Does not resolve contexts, generate text, or lease work."
    annotationPlan(jobId: ID!): AnnotationPlan!
  }
  type Mutation {
    startValueOrigin(input: ValueOriginInput!): ValueOriginPlan!
    nextValueOrigin(runId: ID!, expectedRevision: Int!, taskId: ID): ValueOriginPlan!
    "Resolve and persist the plan using existing profiles; do not start a worker."
    prepareAnnotationPlan(input: AnnotationPlanInput!): AnnotationPlan!
    "Lease at most one task. An active task prevents advancing this job."
    nextAnnotation(jobId: ID!): AnnotationNext!
    "Persist the result; leave the next task paused until nextAnnotation."
    completeAnnotation(input: AnnotationResultInput!): AnnotationPlan!
  }
`;
export const annotationSchema = buildSchema(annotationSchemaSDL);

const parse = (value, fallback) => {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};
const number = value => typeof value?.toNumber === 'function' ? value.toNumber() : Number(value || 0);
const knownKind = kind => Object.hasOwn(annotationProfileContract, kind) ? kind : null;

export function projectAnnotationPlan(job, rows, now = new Date().toISOString()) {
  const nodes = new Map();
  const edges = new Map();
  for (const row of rows) {
    nodes.set(row.annotationId, {
      id: row.annotationId, stableId: row.stableId, displayName: row.displayName || null, annotationId: row.annotationId,
      taskId: row.taskId || null, kind: knownKind(row.annotationKind),
      profileId: row.profileId || null, profileVersion: row.profileVersion == null ? null : number(row.profileVersion),
      labels: parse(row.labelsJson, []), referenceOnly: false,
      leaseExpiresAt: row.leaseExpiresAt || null,
      state: row.status === 'ready' ? 'READY'
        : row.taskStatus === 'leased' && row.leaseExpiresAt > now ? 'RUNNING' : 'WAITING',
      blockedBy: [],
    });
  }
  const addEdge = (from, to, dependency) => {
    const edge = { from, to, role: dependency.role || 'dependency',
      dependencyKind: dependency.dependencyKind || 'semantic', ordinal: number(dependency.ordinal) };
    edge.id = JSON.stringify([from, to, edge.role, edge.dependencyKind, edge.ordinal]);
    edges.set(edge.id, edge);
  };
  for (const row of rows) {
    for (const dep of row.dependencies || []) {
      if (!nodes.has(dep.annotationId)) throw new Error(`Incomplete annotation plan dependency: ${dep.annotationId}`);
      addEdge(row.annotationId, dep.annotationId, dep);
    }
    for (const ref of parse(row.referenceDependenciesJson, [])) {
      const id = `reference:${ref.stableId}`;
      if (!nodes.has(id)) nodes.set(id, { id, stableId: ref.stableId,
        labels: ref.labels || [], kind: knownKind(ref.annotationKind), state: 'REFERENCE',
        referenceOnly: true, blockedBy: [] });
      addEdge(row.annotationId, id, ref);
    }
  }
  for (const edge of edges.values()) {
    const source = nodes.get(edge.from);
    if (!['READY', 'REFERENCE'].includes(nodes.get(edge.to).state)) source.blockedBy.push(edge.to);
  }
  for (const node of nodes.values()) {
    node.blockedBy = [...new Set(node.blockedBy)].sort();
    if (node.state === 'WAITING' && node.taskId && !node.blockedBy.length) node.state = 'AVAILABLE';
  }
  const ordered = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  const available = ordered.filter(n => n.state === 'AVAILABLE');
  const working = ordered.filter(n => n.state === 'RUNNING');
  const waiting = ordered.filter(n => n.state === 'WAITING');
  if (!nodes.has(job.rootAnnotationId)) throw new Error('Annotation plan root is missing');
  return { jobId: job.jobId, requestedRootStableId: job.rootStableId,
    rootId: job.rootAnnotationId, maxDepth: number(job.maxDepth), observedAt: now,
    state: ordered.every(n => ['READY', 'REFERENCE'].includes(n.state)) ? 'COMPLETE'
      : working.length ? 'RUNNING' : available.length ? 'PAUSED' : 'WAITING',
    nodes: ordered, edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
    available, working, waiting };
}

export async function readAnnotationPlan(driver, database, jobId) {
  const session = driver.session({ database, defaultAccessMode: 'READ' });
  try {
    const result = await session.run(`
      MATCH (job:AnnotationJob {jobId: $jobId})-[:ROOT]->(root:Annotation)
      MATCH (root)-[:DEPENDS_ON*0..8]->(annotation:Annotation)
      WITH DISTINCT job, root, annotation
      LIMIT 2001
      OPTIONAL MATCH (subject)-[:HAS_ANNOTATION]->(annotation)
      WITH job, root, annotation, head(collect(subject)) AS subject
      OPTIONAL MATCH (job)-[:HAS_TASK]->(task:AnnotationTask)-[:GENERATES]->(annotation)
      OPTIONAL MATCH (annotation)-[relation:DEPENDS_ON]->(dependency:Annotation)
      RETURN job.jobId AS jobId, job.rootStableId AS rootStableId, job.maxDepth AS maxDepth,
        root.annotationId AS rootAnnotationId, annotation.annotationId AS annotationId,
        coalesce(subject.diaName, subject.name, subject.displayName) AS displayName,
        annotation.headID AS stableId, annotation.annotationKind AS annotationKind,
        annotation.profileId AS profileId, annotation.profileVersion AS profileVersion,
        annotation.status AS status, annotation.labelsJson AS labelsJson,
        annotation.referenceDependenciesJson AS referenceDependenciesJson,
        task.taskId AS taskId, task.status AS taskStatus, task.leaseExpiresAt AS leaseExpiresAt,
        collect(CASE WHEN dependency IS NULL THEN null ELSE {
          annotationId: dependency.annotationId, role: relation.role,
          dependencyKind: relation.dependencyKind, ordinal: relation.ordinal
        } END) AS dependencies
    `, { jobId });
    if (!result.records.length) throw new Error(`Annotation job not found: ${jobId}`);
    if (result.records.length > 2000) throw new Error('Annotation plan exceeds 2000 nodes; request a smaller depth');
    const rows = result.records.map(r => r.toObject());
    return projectAnnotationPlan(rows[0], rows);
  } finally { await session.close(); }
}

export function createAnnotationGraphqlRoot({ driver, database, services = {} }) {
  const read = services.readPlan || (jobId => readAnnotationPlan(driver, database, jobId));
  const prepare = services.prepare || (input => startAnnotationWorkflow(driver, database, input));
  const next = services.next || (input => leaseNextAnnotationTask(driver, database, input));
  const complete = services.complete || (input => completeAnnotationWorkflow(driver, database, input));
  return {
    valueOriginContract: () => valueOriginContract,
    valueOriginPlan: ({ runId }) => readValueOrigin(driver, database, runId),
    startValueOrigin: ({ input }) => startValueOrigin(driver, database, input),
    nextValueOrigin: input => nextValueOrigin(driver, database, input),
    annotationProfiles: () => Object.entries(annotationProfileContract).map(([kind, profile]) => ({ kind, ...profile })),
    annotationPlan: ({ jobId }) => read(jobId),
    prepareAnnotationPlan: async ({ input }) => {
      const maxDepth = input.maxDepth ?? 4;
      if (maxDepth < 0 || maxDepth > 8) throw new Error('maxDepth must be between 0 and 8');
      const result = await prepare({ ...input, maxDepth, leaseTask: false, createJob: true });
      if (!result.jobId) throw new Error('This entity has no annotatable workflow root');
      return read(result.jobId);
    },
    nextAnnotation: async ({ jobId }) => {
      const result = await next({ jobId, singleStep: true });
      const task = result.task ? { ...result.task, completion: {
        ...result.task.completion,
        endpoint: '/api/annotations/graphql',
        body: {
          query: 'mutation Save($input: AnnotationResultInput!) { completeAnnotation(input: $input) { jobId state } }',
          variables: { input: { jobId, taskId: result.task.taskId,
            annotationId: result.task.annotationId, leaseToken: result.task.leaseToken,
            text: '<generated annotation>' } },
        },
      } } : null;
      return { state: result.status === 'ready' ? 'COMPLETE' : result.task ? 'LEASED' : 'WAITING',
        task, plan: await read(jobId) };
    },
    completeAnnotation: async ({ input }) => {
      const plan = await read(input.jobId);
      await complete({ ...input, maxDepth: plan.maxDepth, leaseNext: false, requireLease: true });
      return read(input.jobId);
    },
  };
}

export function executeAnnotationGraphql(body, context) {
  if (typeof body?.query !== 'string' || body.query.length > 50000) throw new Error('A GraphQL query of at most 50000 characters is required');
  return graphql({ schema: annotationSchema, source: body.query, variableValues: body.variables,
    operationName: body.operationName, rootValue: createAnnotationGraphqlRoot(context) });
}
