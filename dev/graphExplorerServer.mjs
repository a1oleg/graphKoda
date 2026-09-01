import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@as-integrations/express5';
import cors from 'cors';
import express from 'express';
import { GraphQLScalarType, Kind } from 'graphql';
import neo4j from 'neo4j-driver';
import { createServer as createViteServer } from 'vite';

import { loadProjectEnv } from './load-env.mjs';

loadProjectEnv();

const workspaceRoot = process.cwd();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultPort = Number(process.env.GRAPH_EXPLORER_PORT || 4147);

function normalizeNeo4jUri(uri) {
  return String(uri || '')
    .replace('neo4j://localhost', 'bolt://localhost')
    .replace('neo4j://127.0.0.1', 'bolt://127.0.0.1');
}

function toPlain(value) {
  if (neo4j.isInt(value)) return value.toNumber();
  if (Array.isArray(value)) return value.map(toPlain);
  if (value && typeof value === 'object') {
    if (value.properties) return toPlain(value.properties);
    const result = {};
    for (const [key, nested] of Object.entries(value)) result[key] = toPlain(nested);
    return result;
  }
  return value;
}

function mapNode(row) {
  if (!row) return null;
  return {
    stableId: row.stableId,
    name: row.name,
    label: row.label,
    repoRelativePath: row.repoRelativePath,
    startLine: row.startLine,
    endLine: row.endLine,
    labels: row.labels || [],
  };
}

function sectionSignature(section) {
  const resourceKinds = [...new Set((section.resources || []).map((resource) => resource.resourceKind).filter(Boolean))].sort();
  const labels = new Set((section.steps || []).flatMap((step) => step.labels || []));
  const code = (section.steps || []).map((step) => step.operationCode || step.actionText || '').join('\n');
  const operationCodes = new Set((section.steps || []).map((step) => step.operationCode).filter(Boolean));
  const hasAsync = /\b(await|for\s+await|yield)\b/.test(code);
  if (labels.has('ThrowStop') || labels.has('BreakStop') || operationCodes.has('RETURN')) return 'terminal';
  if (resourceKinds.length) return `resource:${resourceKinds.join('+')}`;
  if (hasAsync && (labels.has('Branch') || labels.has('Switch') || labels.has('Case'))) return 'async-control';
  if (hasAsync) return 'async';
  if (labels.has('Branch') || labels.has('Switch') || labels.has('Case')) return 'control';
  return 'sync';
}

function labelStage(signature) {
  if (signature === 'terminal') return 'Terminal/control';
  if (signature.startsWith('resource:')) return 'Resource side effects';
  if (signature === 'async-control') return 'Async control';
  if (signature === 'async') return 'Async work';
  if (signature === 'control') return 'Control';
  return 'Sync run';
}

function sectionLabel(section) {
  if (section.calls?.length) return section.calls.map((call) => call.targetName || call.calleeText).filter(Boolean).slice(0, 2).join(' + ');
  if (section.resources?.length) return section.resources.map((resource) => `${resource.accessType || 'touch'} ${resource.resourceName}`).slice(0, 2).join(' + ');
  const codes = [...new Set((section.steps || []).map((step) => step.operationCode).filter(Boolean))];
  return codes.join(' + ') || section.steps?.[0]?.actionText || section.steps?.[0]?.label || 'Local section';
}

function buildSectionsFromSteps(steps) {
  const sections = [];
  const bySpan = new Map();
  for (const step of steps) {
    const spanKey = `${step.startLine}:${step.endLine}`;
    let section = bySpan.get(spanKey);
    if (!section) {
      section = {
        id: spanKey,
        index: sections.length + 1,
        startLine: step.startLine,
        endLine: step.endLine,
        calls: [],
        resources: [],
        steps: [],
      };
      bySpan.set(spanKey, section);
      sections.push(section);
    }
    section.steps.push(step);
    section.calls.push(...(step.calls || []));
    section.resources.push(...(step.resources || []));
  }
  return sections.map((section) => {
    const dedupe = (items, keyFn) => {
      const seen = new Set();
      return items.filter((item) => {
        const key = keyFn(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    const calls = dedupe(section.calls, (call) => call.targetStableId || call.calleeText || '');
    const resources = dedupe(section.resources, (resource) => `${resource.resourceKey}:${resource.accessType}`);
    const normalized = {
      ...section,
      calls,
      resources,
      stepCount: section.steps.length,
    };
    const signature = sectionSignature(normalized);
    return {
      ...normalized,
      id: section.steps[0]?.stableId || section.id,
      label: sectionLabel(normalized),
      signature,
    };
  });
}

function buildStagesFromSteps(phaseKey, functionStableId, steps) {
  const sections = buildSectionsFromSteps(steps);
  const stages = [];
  let currentStage = null;
  for (const section of sections) {
    const signature = section.signature;
    if (!currentStage || currentStage.signature !== signature) {
      currentStage = {
        id: `${phaseKey}:${functionStableId}:stage:${stages.length + 1}`,
        index: stages.length + 1,
        label: labelStage(signature),
        signature,
        startLine: section.startLine,
        endLine: section.endLine,
        sections: [],
      };
      stages.push(currentStage);
    }
    currentStage.endLine = section.endLine;
    currentStage.sections.push({ ...section, index: currentStage.sections.length + 1 });
  }
  return stages.map((stage) => ({
    ...stage,
    sectionCount: stage.sections.length,
    stepCount: stage.sections.reduce((sum, section) => sum + section.stepCount, 0),
    callCount: stage.sections.reduce((sum, section) => sum + section.calls.length, 0),
    resourceCount: stage.sections.reduce((sum, section) => sum + section.resources.length, 0),
  }));
}

const phaseCatalog = [
  { key: 'turn.input-submit', label: 'Input onSubmit', phaseShape: 'Linear' },
  {
    key: 'turn.input-intake',
    label: 'Input Intake',
    phaseShape: 'Linear',
    functions: [{ stableId: 'screens/REPL.tsx:2661:34:2854:3', name: 'onQueryImpl' }],
  },
  { key: 'turn.turn-bootstrap', label: 'Turn Bootstrap', phaseShape: 'Linear' },
  { key: 'turn.context-build-prompt-assembly', label: 'Context Assembly', phaseShape: 'Corridor' },
  { key: 'turn.llm-exchange', label: 'LLM Exchange', phaseShape: 'Corridor' },
  { key: 'turn.assistant-response-intake', label: 'Assistant Response Intake', phaseShape: 'Linear' },
  { key: 'turn.tool-selection', label: 'Tool Selection', phaseShape: 'Corridor' },
  { key: 'turn.tool-validation', label: 'Tool Validation', phaseShape: 'Linear' },
  { key: 'turn.execution-planning', label: 'Execution Planning', phaseShape: 'Corridor' },
  { key: 'turn.permission-decision', label: 'Permission Decision', phaseShape: 'Cross-cutting' },
  { key: 'turn.tool-invocation', label: 'Tool Invocation', phaseShape: 'Corridor' },
  { key: 'turn.result-normalization', label: 'Result Normalization', phaseShape: 'Linear' },
  { key: 'turn.observability', label: 'Observability', phaseShape: 'Cross-cutting' },
  { key: 'turn.failure-handling', label: 'Failure Handling', phaseShape: 'Cross-cutting' },
  { key: 'turn.next-turn-feedback', label: 'Next Turn Feedback', phaseShape: 'Linear' },
];

const phaseCatalogByKey = new Map(phaseCatalog.map((phase) => [phase.key, phase]));

const typeDefs = `#graphql
  scalar JSON

  enum PhaseShape {
    Linear
    Corridor
    Cross_cutting
  }

  type Query {
    schemaHints: [SchemaHint!]!
    phases: [Phase!]!
    phase(key: ID!): Phase
    function(stableId: ID!): FunctionNode
    cypher(query: String!, paramsJson: String): CypherResult!
  }

  type SchemaHint {
    name: String!
    description: String!
    cypher: String!
  }

  type CypherResult {
    columns: [String!]!
    rows: [JSON!]!
  }

  type Phase {
    key: ID!
    label: String
    phaseKind: String
    phaseShape: String!
    canExpandFunctions: Boolean!
    head: GraphEntity
    tail: GraphEntity
    ownerFunction: FunctionNode
    functions: [FunctionNode!]!
  }

  type FunctionNode {
    stableId: ID!
    name: String
    label: String
    repoRelativePath: String
    startLine: Int
    endLine: Int
    labels: [String!]!
    stages(phaseKey: ID): [Stage!]!
  }

  type Stage {
    id: ID!
    index: Int!
    label: String!
    signature: String!
    startLine: Int
    endLine: Int
    sectionCount: Int!
    stepCount: Int!
    callCount: Int!
    resourceCount: Int!
    sections: [Section!]!
  }

  type Section {
    id: ID!
    index: Int!
    label: String!
    signature: String!
    startLine: Int
    endLine: Int
    stepCount: Int!
    calls: [CallEdge!]!
    resources: [ResourceTouch!]!
    steps: [Step!]!
  }

  type Step {
    stableId: ID!
    label: String
    operationCode: String
    actionText: String
    repoRelativePath: String
    startLine: Int
    endLine: Int
    labels: [String!]!
    calls: [CallEdge!]!
    resources: [ResourceTouch!]!
  }

  type CallEdge {
    targetStableId: ID
    targetName: String
    calleeText: String
    line: Int
    column: Int
  }

  type ResourceTouch {
    resourceKey: ID
    resourceName: String
    resourceKind: String
    resourceSubkind: String
    accessType: String
    relType: String
    line: Int
    column: Int
  }

  type GraphEntity {
    stableId: ID
    name: String
    label: String
    repoRelativePath: String
    startLine: Int
    endLine: Int
    labels: [String!]!
  }
`;

const schemaHints = [
  {
    name: 'Agent turn phases',
    description: 'Top-level hand-marked phase catalog. Only Input Intake currently has a schema-pinned super-function.',
    cypher: 'schema: phaseCatalog[] with phaseShape = Linear | Corridor | Cross-cutting',
  },
  {
    name: 'Phase owner function',
    description: 'Resolve phase head/tail to the owning function through Step.parentFnStableId or direct Fn head.',
    cypher: 'MATCH (p:Phase {key:$key})-[:HEADS_AT]->(h) RETURN h.stableId, h.parentFnStableId, labels(h)',
  },
  {
    name: 'Function steps',
    description: 'Lazy Function -> Stage -> Section -> Step rendering uses ordered Step rows inside phase head/tail bounds.',
    cypher: 'MATCH (s:Step {parentFnStableId:$stableId}) RETURN s ORDER BY s.start_line, s.start_column',
  },
  {
    name: 'Side branches',
    description: 'Section branches come from static call edges and stateful/external resource edges attached to Step.',
    cypher: 'MATCH (s:Step)-[r]->(n) WHERE r.role = "call" OR type(r) ENDS WITH "_RESOURCE" RETURN s, r, n LIMIT 25',
  },
];

function createResolvers(driver, database) {
  async function read(query, params = {}) {
    const session = driver.session({ database, defaultAccessMode: neo4j.session.READ });
    try {
      const result = await session.run(query, params);
      return result.records.map((record) => {
        const row = {};
        for (const key of record.keys) row[key] = toPlain(record.get(key));
        return row;
      });
    } finally {
      await session.close();
    }
  }

  async function loadFunction(stableId) {
    const rows = await read(
      `
        MATCH (fn:Fn {stableId: $stableId})
        RETURN fn.stableId AS stableId,
               fn.name AS name,
               fn.label AS label,
               fn.repo_relative_path AS repoRelativePath,
               fn.start_line AS startLine,
               fn.end_line AS endLine,
               labels(fn) AS labels
        LIMIT 1
      `,
      { stableId },
    );
    return mapNode(rows[0]);
  }

  async function resolveCatalogPhase(phaseKey) {
    const catalogPhase = phaseCatalogByKey.get(phaseKey);
    if (!catalogPhase) return null;
    const bounds = await loadPhaseBounds(phaseKey);
    return {
      ...bounds,
      key: catalogPhase.key,
      label: catalogPhase.label,
      phaseKind: bounds?.phaseKind || 'agent-turn',
      phaseShape: catalogPhase.phaseShape,
      canExpandFunctions: Boolean(catalogPhase.functions?.length),
      catalogFunctions: catalogPhase.functions || [],
    };
  }

  async function loadPhaseBounds(phaseKey) {
    const rows = await read(
      `
        MATCH (phase:Phase {key: $phaseKey})
        OPTIONAL MATCH (phase)-[:HEADS_AT]->(head)
        OPTIONAL MATCH (phase)-[:TAILS_AT]->(tail)
        RETURN phase.key AS key,
               phase.label AS label,
               phase.phase_kind AS phaseKind,
               head.stableId AS headStableId,
               head.parentFnStableId AS headParentFnStableId,
               head.name AS headName,
               head.label AS headLabel,
               head.repo_relative_path AS headRepoRelativePath,
               head.start_line AS headStartLine,
               head.end_line AS headEndLine,
               labels(head) AS headLabels,
               tail.stableId AS tailStableId,
               tail.parentFnStableId AS tailParentFnStableId,
               tail.name AS tailName,
               tail.label AS tailLabel,
               tail.repo_relative_path AS tailRepoRelativePath,
               tail.start_line AS tailStartLine,
               tail.end_line AS tailEndLine,
               labels(tail) AS tailLabels
        LIMIT 1
      `,
      { phaseKey },
    );
    const row = rows[0];
    if (!row) return null;
    return {
      key: row.key,
      label: row.label,
      phaseKind: row.phaseKind,
      headLine: row.headStartLine,
      tailLine: row.tailStartLine || row.tailEndLine,
      ownerFunctionStableId: row.headParentFnStableId || ((row.headLabels || []).includes('Fn') ? row.headStableId : null),
      head: mapNode({
        stableId: row.headStableId,
        name: row.headName,
        label: row.headLabel,
        repoRelativePath: row.headRepoRelativePath,
        startLine: row.headStartLine,
        endLine: row.headEndLine,
        labels: row.headLabels || [],
      }),
      tail: mapNode({
        stableId: row.tailStableId,
        name: row.tailName,
        label: row.tailLabel,
        repoRelativePath: row.tailRepoRelativePath,
        startLine: row.tailStartLine,
        endLine: row.tailEndLine,
        labels: row.tailLabels || [],
      }),
    };
  }

  async function loadStepsForFunction(functionStableId, phaseKey) {
    let bounds = null;
    if (phaseKey) bounds = await loadPhaseBounds(phaseKey);
    const rows = await read(
      `
        MATCH (step:Step:FlowArtifact {parentFnStableId: $functionStableId})
        WHERE ($headLine IS NULL OR step.start_line >= $headLine)
          AND ($tailLine IS NULL OR step.start_line <= $tailLine)
        OPTIONAL MATCH (step)-[callRel]->(callee:Fn)
        WHERE callRel.role = 'call'
        OPTIONAL MATCH (step)-[resourceRel]->(resource)
        WHERE resource.resource_kind IS NOT NULL AND type(resourceRel) IN ['READS_RESOURCE','TESTS_RESOURCE','CREATES_RESOURCE','UPDATES_RESOURCE','DELETES_RESOURCE','CLEARS_RESOURCE','EMITS_TO','WAITS_ON','SUBSCRIBES_TO','SIGNALS_RESOURCE']
        RETURN step.stableId AS stableId,
               step.label AS label,
               step.operation_code AS operationCode,
               step.action_text_raw AS actionText,
               step.repo_relative_path AS repoRelativePath,
               step.start_line AS startLine,
               step.start_column AS startColumn,
               step.end_line AS endLine,
               labels(step) AS labels,
               collect(DISTINCT {
                 targetStableId: callee.stableId,
                 targetName: callee.name,
                 calleeText: callRel.callee_text,
                 line: step.start_line,
                 column: step.start_column
               }) AS calls,
               collect(DISTINCT {
                 resourceKey: resource.resource_key,
                 resourceName: resource.resource_name,
                 resourceKind: resource.resource_kind,
                 resourceSubkind: resource.resource_subkind,
                 accessType: resourceRel.access_type,
                 relType: type(resourceRel),
                 line: step.start_line,
                 column: step.start_column
               }) AS resources
        ORDER BY step.start_line, step.start_column
      `,
      {
        functionStableId,
        headLine: bounds?.headLine ?? null,
        tailLine: bounds?.tailLine ?? null,
      },
    );
    return rows.map((row) => ({
      stableId: row.stableId,
      label: row.label,
      operationCode: row.operationCode,
      actionText: row.actionText,
      repoRelativePath: row.repoRelativePath,
      startLine: row.startLine,
      endLine: row.endLine,
      labels: row.labels || [],
      calls: (row.calls || []).filter((call) => call.targetStableId),
      resources: (row.resources || []).filter((resource) => resource.resourceKey),
    }));
  }

  return {
    JSON: new GraphQLScalarType({
      name: 'JSON',
      serialize: toPlain,
      parseValue: toPlain,
      parseLiteral(ast) {
        if (ast.kind === Kind.STRING || ast.kind === Kind.BOOLEAN) return ast.value;
        if (ast.kind === Kind.INT || ast.kind === Kind.FLOAT) return Number(ast.value);
        if (ast.kind === Kind.OBJECT) {
          const value = {};
          for (const field of ast.fields) value[field.name.value] = this.parseLiteral(field.value);
          return value;
        }
        if (ast.kind === Kind.LIST) return ast.values.map((value) => this.parseLiteral(value));
        return null;
      },
    }),
    Query: {
      schemaHints: () => schemaHints,
      phases: async () => Promise.all(phaseCatalog.map((phase) => resolveCatalogPhase(phase.key))),
      phase: async (_, { key }) => resolveCatalogPhase(key),
      function: async (_, { stableId }) => loadFunction(stableId),
      cypher: async (_, { query, paramsJson }) => {
        if (!/^\s*(MATCH|OPTIONAL MATCH|WITH|RETURN|CALL\s+db\.|SHOW)\b/i.test(query)) {
          throw new Error('Only read Cypher queries are allowed.');
        }
        const params = paramsJson ? JSON.parse(paramsJson) : {};
        const rows = await read(query, params);
        return { columns: Object.keys(rows[0] || {}), rows };
      },
    },
    Phase: {
      ownerFunction: async (phase) => {
        const firstCatalogFunction = phase.catalogFunctions?.[0];
        if (firstCatalogFunction?.stableId) return loadFunction(firstCatalogFunction.stableId);
        return null;
      },
      functions: async (phase) => {
        const functions = phase.catalogFunctions || [];
        const loaded = await Promise.all(functions.map((fn) => loadFunction(fn.stableId)));
        return loaded.filter(Boolean);
      },
    },
    FunctionNode: {
      stages: async (fn, { phaseKey }) => {
        const steps = await loadStepsForFunction(fn.stableId, phaseKey);
        return buildStagesFromSteps(phaseKey || 'function', fn.stableId, steps);
      },
    },
  };
}

const driver = neo4j.driver(
  normalizeNeo4jUri(process.env.NEO4J_URI || 'bolt://127.0.0.1:7687'),
  neo4j.auth.basic(process.env.NEO4J_USER || process.env.NEO4J_USERNAME || 'neo4j', process.env.NEO4J_PASSWORD || ''),
);
const database = process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j';

const apollo = new ApolloServer({ typeDefs, resolvers: createResolvers(driver, database) });
await apollo.start();

const app = express();
app.use('/graphql', cors(), express.json({ limit: '2mb' }), expressMiddleware(apollo));

const vite = await createViteServer({
  root: path.join(workspaceRoot, 'graph', 'explorer'),
  server: { middlewareMode: true },
  appType: 'spa',
});
app.use(vite.middlewares);

const server = app.listen(defaultPort, () => {
  console.log(JSON.stringify({
    ok: true,
    url: `http://127.0.0.1:${defaultPort}`,
    graphql: `http://127.0.0.1:${defaultPort}/graphql`,
    database,
    root: path.relative(workspaceRoot, path.join(__dirname, '..', 'graph', 'explorer')),
  }, null, 2));
});

function shutdown() {
  server.close(async () => {
    await apollo.stop();
    await vite.close();
    await driver.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

