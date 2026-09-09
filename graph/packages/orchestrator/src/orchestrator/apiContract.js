// The orchestrator intentionally keeps its HTTP transport dependency-free.
// This module is the single descriptive contract for that transport: status
// pages, OpenAPI, Swagger UI and coverage tests all consume the same records.

const TAGS = [
  ['Documentation', 'Discovery, health, operational guides and the OpenAPI contract.'],
  ['Status', 'Read-only snapshots of managed processes and infrastructure.'],
  ['Extraction', 'Graph extraction planning, execution and scoped imports.'],
  ['Annotations', 'Graph-first annotation storage, resolution and job workflows.'],
  ['Graph', 'General graph queries and database administration.'],
  ['Diagrams', 'draw.io generation and annotation synchronization.'],
  ['Functions', 'Function-flow graph loading and rendering.'],
  ['Phases', 'Phase selection, graph loading and rendering.'],
  ['Features', 'Feature restoration, graph rendering, runtime evidence and repros.'],
  ['UI Explorer', 'Business-object and UI-surface exploration.'],
  ['Services', 'Lifecycle actions for local dev, browser, relay, Redis and Neo4j services.'],
];

const GROUPS = [
  ['Documentation', 'GET', [
    '/', '/health', '/api/docs', '/swagger', '/api/openapi.json', '/api/docs/audit',
    '/api/knowledge/orchestrator', '/api/knowledge/restart-orchestrator',
  ]],
  ['Status', 'GET', [
    '/api/status/gateway', '/api/status/ordinary-dev-server', '/api/status/neo4j',
    '/api/status/playwright-devops', '/api/status/mocked-dev-server',
    '/api/status/reverse-observation', '/api/status/runtime-ingestion',
    '/api/status/infra-readiness', '/api/status/repro-monitor',
    '/api/status/process-diagnostics', '/api/status/processes',
  ]],
  ['Extraction', 'GET', ['/api/extract/plan', '/api/extract/preflight', '/api/extract/status']],
  ['Extraction', 'POST', [
    '/api/actions/run-extract', '/api/actions/import-functions', '/api/actions/stop-extract',
  ]],
  ['Annotations', 'GET', [
    '/api/annotations/visualizer',
    '/annotation-plan', '/annotation-plan/assets/{name}',
    '/api/annotations/graphql/schema',
    '/api/graph/annotation-profiles', '/api/graph/annotations', '/api/annotation-jobs/{jobId}',
  ]],
  ['Annotations', 'POST', [
    '/api/annotations/graphql',
    '/api/graph/annotations/upsert', '/api/graph/annotations/resolve',
    '/api/graph/annotations/complete', '/api/graph/annotations/workflow/start',
    '/api/graph/annotations/workflow/complete', '/api/annotation-jobs',
    '/api/annotation-jobs/{jobId}/lease-next', '/api/annotation-tasks/{taskId}/complete',
  ]],
  ['Graph', 'POST', ['/api/graph/external-affectors', '/api/actions/reset-graph-database']],
  ['Diagrams', 'POST', ['/api/diagrams/annotations/insert', '/api/diagrams/annotations/update']],
  ['Functions', 'POST', ['/api/functions/flow-graph', '/api/functions/flow-draw']],
  ['Phases', 'POST', [
    '/api/phases/get', '/api/phases/path-graph', '/api/phases/path-graph-draw', '/api/phases/swimlane-draw',
  ]],
  ['Features', 'POST', [
    '/api/features/get', '/api/features/make-repro', '/api/features/path-graph',
    '/api/features/path-graph-draw', '/api/features/draw', '/api/features/runtime-node-logs',
    '/api/features/run-repro',
  ]],
  ['UI Explorer', 'GET', [
    '/ui-explorer', '/api/ui-explorer/roots', '/api/ui-explorer/top-blocks',
    '/api/ui-explorer/children', '/api/ui-explorer/surface',
    '/api/ui-explorer/affordance-flow', '/api/ui-explorer/object-functions',
    '/api/ui-explorer/objects', '/api/ui-explorer/object-paths',
    '/api/ui-explorer/modal-strict-diagnostics',
  ]],
  ['Services', 'POST', [
    '/api/actions/start-ordinary-dev-server', '/api/actions/stop-ordinary-dev-server',
    '/api/actions/start-mocked-dev-server', '/api/actions/stop-mocked-dev-server',
    '/api/actions/cleanup-mocked-dev-server', '/api/actions/launch-graph-session',
    '/api/actions/stop-graph-session', '/api/actions/start-playwright-session-capture',
    '/api/actions/stop-playwright-session-capture', '/api/actions/ensure-reverse-service',
    '/api/actions/stop-reverse-service', '/api/actions/ensure-reverse-observation-stack',
    '/api/actions/ensure-runtime-ingestion-readiness', '/api/actions/ensure-infra-readiness',
    '/api/actions/start-neo4j', '/api/actions/restart-infra-readiness',
    '/api/actions/restart-orchestrator', '/api/actions/recover-neo4j',
    '/api/actions/repair-runtime-materialization', '/api/actions/cleanup-runtime-ingestion',
  ]],
];

const DETAILS = {
  'GET /api/annotations/visualizer': ['Launch the annotation visualizer', 'Returns the URL of an authored annotation route selected by its source stableId. Does not generate annotations or write to Neo4j. Missing stableId returns 400; an unknown route returns 404.'],
  'GET /': ['Discover the orchestrator', 'Returns stable entry points and the normal local runbook.'],
  'GET /health': ['Check Neo4j-backed health', 'Verifies both the HTTP process and its configured Neo4j connection.'],
  'GET /api/docs': ['Open Swagger UI', 'Interactive Swagger UI generated from the live orchestrator contract.'],
  'GET /swagger': ['Open the Swagger UI alias', 'Compatibility alias for /api/docs.'],
  'GET /api/openapi.json': ['Read the OpenAPI document', 'Returns the OpenAPI 3.1 document used by Swagger UI.'],
  'GET /api/docs/audit': ['Audit the HTTP contract', 'Summarizes route groups, aliases, destructive actions and contract coverage.'],
  'GET /api/status/gateway': ['Inspect the orchestrator', 'Returns process identity, uptime, route catalog and extraction status.'],
  'GET /api/status/process-diagnostics': ['Inspect managed processes', 'Aggregates process ownership, ports, readiness and bounded log tails.'],
  'GET /api/status/processes': ['Inspect managed processes (legacy alias)', 'Deprecated compatibility alias for /api/status/process-diagnostics.'],
  'GET /api/extract/preflight': ['Check extraction readiness', 'Validates tooling and Neo4j without starting an extraction.'],
  'POST /api/actions/import-functions': ['Import selected functions', 'Runs append-only scoped extraction for explicit function stable IDs.'],
  'POST /api/actions/run-extract': ['Start graph extraction', 'Starts the managed extractor and returns its observable run state.'],
  'POST /api/graph/annotations/resolve': ['Resolve an annotation DAG', 'Builds typed bottom-up annotation context without requiring generation in the request.'],
  'POST /api/annotation-jobs': ['Start an annotation job', 'Creates or reuses a persistent bottom-up annotation workflow.'],
  'POST /api/actions/reset-graph-database': ['Reset the graph database', 'Deletes all graph data only when the explicit confirmation token is supplied.'],
  'POST /api/features/run-repro': ['Run a feature repro', 'Ensures infrastructure, runs a feature scenario and returns runtime logging identity.'],
  'POST /api/functions/flow-draw': ['Render a function-flow diagram', 'Builds a draw.io document for a selected function flow.'],
};

const ALIASES = {
  'GET /swagger': '/api/docs',
  'GET /api/status/processes': '/api/status/process-diagnostics',
};

const DESTRUCTIVE = new Set([
  'POST /api/actions/reset-graph-database',
  'POST /api/actions/cleanup-runtime-ingestion',
  'POST /api/actions/cleanup-mocked-dev-server',
]);

const BODY_SCHEMA_BY_KEY = {
  'POST /api/actions/import-functions': 'ScopedFunctionImportRequest',
  'POST /api/actions/reset-graph-database': 'GraphResetRequest',
  'POST /api/graph/annotations/resolve': 'AnnotationResolveRequest',
  'POST /api/graph/annotations/workflow/start': 'AnnotationWorkflowRequest',
  'POST /api/annotation-jobs': 'AnnotationWorkflowRequest',
  'POST /api/functions/flow-graph': 'FunctionFlowRequest',
  'POST /api/functions/flow-draw': 'FunctionFlowRequest',
  'POST /api/features/get': 'FeatureSelectionRequest',
  'POST /api/features/path-graph': 'FeatureSelectionRequest',
  'POST /api/features/path-graph-draw': 'FeatureSelectionRequest',
};

const QUERY_PARAMETERS = {
  '/api/annotations/visualizer': [['stableId', 'string', true, 'Source node stableId. Example: screens/REPL.tsx:3142:82:3146:3 (speculationAccept).']],
  '/api/status/gateway': [['tailLog', 'boolean', false, 'Include the current extraction log tail.']],
  '/api/status/repro-monitor': [['tailLines', 'integer', false, 'Number of recent log lines, from 1 to 100.']],
  '/api/status/process-diagnostics': [['tailLines', 'integer', false, 'Number of recent log lines, from 1 to 100.']],
  '/api/status/processes': [['tailLines', 'integer', false, 'Number of recent log lines, from 1 to 100.']],
  '/api/extract/status': [['tailLog', 'boolean', false, 'Include the current extraction log tail.']],
  '/api/extract/preflight': [['mode', 'string', false, 'Extraction mode; currently func.']],
  '/api/graph/annotations': [
    ['stableId', 'string', false, 'Filter annotations by graph stableId.'],
    ['targetStableId', 'string', false, 'Optional target-side stableId.'],
  ],
  '/api/ui-explorer/children': [
    ['surfaceKey', 'string', true, 'Surface whose children are requested.'],
    ['parentSurfaceKey', 'string', false, 'Optional parent surface.'],
  ],
  '/api/ui-explorer/surface': [['surfaceKey', 'string', true, 'Surface to load.']],
  '/api/ui-explorer/affordance-flow': [['affordanceKey', 'string', true, 'Affordance flow to load.']],
  '/api/ui-explorer/object-functions': [
    ['objectKey', 'string', false, 'Business-object key.'], ['familyKey', 'string', false, 'Object-family key.'],
  ],
  '/api/ui-explorer/object-paths': [
    ['objectKey', 'string', false, 'Business-object key.'], ['familyKey', 'string', false, 'Object-family key.'],
  ],
  '/api/ui-explorer/modal-strict-diagnostics': [['objectKey', 'string', false, 'Business-object key.']],
};

function humanizePath(pathname) {
  const tail = pathname.split('/').filter(Boolean).at(-1) || 'orchestrator';
  return tail.replace(/[{}]/g, '').replace(/-/g, ' ');
}

function operationId(method, pathname) {
  const parts = pathname.split('/').filter(Boolean).map((part) => part.replace(/[{}]/g, ''));
  return `${method.toLowerCase()}_${parts.join('_') || 'root'}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

export const ORCHESTRATOR_API_OPERATIONS = Object.freeze(GROUPS.flatMap(([tag, method, paths]) => (
  paths.map((pathname) => {
    const key = `${method} ${pathname}`;
    const [summary, description] = DETAILS[key] || [
      `${method === 'GET' ? 'Read' : 'Run'} ${humanizePath(pathname)}`,
      `${method === 'GET' ? 'Returns' : 'Executes'} the ${humanizePath(pathname)} orchestrator operation.`,
    ];
    return Object.freeze({
      method,
      path: pathname,
      tag,
      operationId: operationId(method, pathname),
      summary,
      description,
      aliasFor: ALIASES[key] || null,
      deprecated: Boolean(ALIASES[key]),
      destructive: DESTRUCTIVE.has(key),
      bodySchema: BODY_SCHEMA_BY_KEY[key] || (method === 'POST' ? 'GenericObject' : null),
      queryParameters: QUERY_PARAMETERS[pathname] || [],
    });
  })
)));

function routeUrl(pathname, baseUrl) {
  const names = [];
  const tokenized = pathname.replace(/\{([^}]+)\}/g, (_match, name) => {
    names.push(name);
    return `__path_parameter_${names.length - 1}__`;
  });
  let result = new URL(tokenized, baseUrl).toString();
  names.forEach((name, index) => {
    result = result.replace(`__path_parameter_${index}__`, `{${name}}`);
  });
  return result;
}

/** Build the human/operator-facing route catalog embedded in gateway status. */
export function buildApiRouteCatalog(baseUrl = 'http://127.0.0.1:8791/') {
  return ORCHESTRATOR_API_OPERATIONS.map((operation) => ({
    method: operation.method,
    path: operation.path,
    url: routeUrl(operation.path, baseUrl),
    tag: operation.tag,
    summary: operation.summary,
    notes: [
      operation.description,
      ...(operation.aliasFor ? [`Deprecated alias for ${operation.aliasFor}.`] : []),
      ...(operation.destructive ? ['Destructive operation; inspect its confirmation contract before calling.'] : []),
    ],
    deprecated: operation.deprecated,
    destructive: operation.destructive,
  }));
}

const schemas = {
  GenericObject: { type: 'object', additionalProperties: true },
  GenericSuccess: {
    type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } }, additionalProperties: true,
  },
  Error: {
    type: 'object', required: ['ok', 'error'], properties: {
      ok: { const: false }, error: { type: 'string' }, stack: { type: 'string' }, cause: {},
    }, additionalProperties: true,
  },
  ScopedFunctionImportRequest: {
    type: 'object', properties: {
      fnStableId: { type: 'string' }, fnStableIds: { type: 'array', items: { type: 'string' } },
      preserveAnnotations: { type: 'boolean', default: true },
    }, anyOf: [{ required: ['fnStableId'] }, { required: ['fnStableIds'] }], additionalProperties: false,
  },
  GraphResetRequest: {
    type: 'object', required: ['confirm'], properties: { confirm: { const: 'RESET_GRAPH' } }, additionalProperties: false,
  },
  AnnotationResolveRequest: {
    type: 'object', required: ['stableId'], properties: {
      stableId: { type: 'string' }, maxDepth: { type: 'integer', minimum: 0 }, persist: { type: 'boolean', default: true },
      refreshMode: { type: 'string', enum: ['reuse', 'root', 'subtree'], default: 'reuse' },
      atStableId: { type: 'string' }, atOperationIndex: { type: 'integer' },
    }, additionalProperties: true,
  },
  AnnotationWorkflowRequest: {
    allOf: [{ $ref: '#/components/schemas/AnnotationResolveRequest' }, {
      type: 'object', properties: { leaseTask: { type: 'boolean', default: true }, clientContext: { type: 'object' } },
    }],
  },
  FunctionFlowRequest: {
    type: 'object', required: ['fnStableId'], properties: {
      fnStableId: { type: 'string' }, rangeStart: { type: 'integer' }, rangeEnd: { type: 'integer' },
      outputPath: { type: 'string' }, includeAnnotations: { type: 'boolean' },
    }, additionalProperties: true,
  },
  FeatureSelectionRequest: {
    type: 'object', properties: {
      name: { type: 'string' }, headStableId: { type: 'string' },
      tailStableIds: { type: 'array', items: { type: 'string' } }, jsonPath: { type: 'string' },
    }, additionalProperties: true,
  },
};

function pathParameters(pathname) {
  return [...pathname.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1], in: 'path', required: true, description: `${match[1]} path identifier.`, schema: { type: 'string' },
  }));
}

function openApiOperation(operation) {
  const parameters = [
    ...pathParameters(operation.path),
    ...operation.queryParameters.map(([name, type, required, description]) => ({
      name, in: 'query', required, description, schema: { type },
    })),
  ];
  return {
    tags: [operation.tag],
    operationId: operation.operationId,
    summary: operation.summary,
    description: `${operation.description}${operation.destructive ? '\n\n**Destructive operation.**' : ''}`,
    deprecated: operation.deprecated || undefined,
    parameters: parameters.length ? parameters : undefined,
    requestBody: operation.bodySchema ? {
      required: false,
      content: { 'application/json': { schema: { $ref: `#/components/schemas/${operation.bodySchema}` } } },
    } : undefined,
    responses: {
      200: { description: 'Successful orchestrator response.', content: { 'application/json': { schema: { $ref: '#/components/schemas/GenericSuccess' } } } },
      400: { description: 'Invalid request.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'Route or graph entity not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      500: { description: 'Operation failed.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };
}

/** Project the route contract into an OpenAPI 3.1 document for tools and UI. */
export function buildOpenApiDocument(baseUrl = 'http://127.0.0.1:8791/') {
  const paths = {};
  for (const operation of ORCHESTRATOR_API_OPERATIONS) {
    paths[operation.path] ||= {};
    paths[operation.path][operation.method.toLowerCase()] = openApiOperation(operation);
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'ColdKode Graph Orchestrator API',
      version: '1.0.0',
      description: 'Local HTTP control plane for graph extraction, annotation workflows, diagrams, runtime repros and managed development services.',
    },
    servers: [{ url: new URL('/', baseUrl).toString().replace(/\/$/, ''), description: 'Current orchestrator process' }],
    tags: TAGS.map(([name, description]) => ({ name, description })),
    paths,
    components: { schemas },
  };
}

/** Return a small machine-readable review of compatibility and safety markers. */
export function buildApiContractAudit() {
  const byTag = Object.fromEntries(TAGS.map(([tag]) => [tag, 0]));
  ORCHESTRATOR_API_OPERATIONS.forEach((operation) => { byTag[operation.tag] += 1; });
  return {
    ok: true,
    operationCount: ORCHESTRATOR_API_OPERATIONS.length,
    pathCount: new Set(ORCHESTRATOR_API_OPERATIONS.map((operation) => operation.path)).size,
    byTag,
    aliases: ORCHESTRATOR_API_OPERATIONS.filter((operation) => operation.aliasFor)
      .map(({ method, path, aliasFor }) => ({ method, path, aliasFor })),
    destructiveOperations: ORCHESTRATOR_API_OPERATIONS.filter((operation) => operation.destructive)
      .map(({ method, path }) => ({ method, path })),
    guarantees: [
      'Every routed HTTP operation is represented in ORCHESTRATOR_API_OPERATIONS.',
      'Swagger UI, OpenAPI JSON and the gateway route catalog use the same contract.',
      'A source-level coverage test detects undocumented router branches.',
    ],
  };
}

/** Render Swagger UI; JavaScript and CSS are served locally by orchestrator.js. */
export function renderSwaggerUi(baseUrl = 'http://127.0.0.1:8791/') {
  const specUrl = new URL('/api/openapi.json', baseUrl).pathname;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ColdKode Graph Orchestrator API</title>
<link rel="stylesheet" href="/api/docs/assets/swagger-ui.css">
<style>body{margin:0;background:#fafafa}.topbar{display:none}</style></head>
<body><div id="swagger-ui"></div>
<script src="/api/docs/assets/swagger-ui-bundle.js"></script>
<script>window.ui=SwaggerUIBundle({url:${JSON.stringify(specUrl)},dom_id:'#swagger-ui',deepLinking:true,displayRequestDuration:true,filter:true,tryItOutEnabled:true});</script>
</body></html>`;
}
