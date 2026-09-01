import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  ORCHESTRATOR_API_OPERATIONS,
  buildApiContractAudit,
  buildApiRouteCatalog,
  buildOpenApiDocument,
  renderSwaggerUi,
} from './apiContract.js';

const orchestratorSource = fs.readFileSync(
  path.resolve('graph', 'packages', 'orchestrator', 'src', 'orchestrator.js'),
  'utf8',
);

function literalRoutes(source, handlerName, nextHandlerName) {
  const start = source.indexOf(`async function ${handlerName}`);
  const end = nextHandlerName ? source.indexOf(`async function ${nextHandlerName}`, start) : source.length;
  assert.ok(start >= 0 && end > start, `cannot locate ${handlerName}`);
  const staticAssets = new Set([
    '/api/docs/assets/swagger-ui.css',
    '/api/docs/assets/swagger-ui-bundle.js',
  ]);
  return [...source.slice(start, end).matchAll(/pathname === '([^']+)'/g)]
    .map((match) => match[1])
    .filter((pathname) => !staticAssets.has(pathname));
}

test('the descriptive API contract covers every concrete router branch', () => {
  const routed = new Set([
    ...literalRoutes(orchestratorSource, 'handleGet', 'handlePost').map((route) => `GET ${route}`),
    ...literalRoutes(orchestratorSource, 'handlePost', null).map((route) => `POST ${route}`),
    'GET /api/annotation-jobs/{jobId}',
    'POST /api/annotation-jobs/{jobId}/lease-next',
    'POST /api/annotation-tasks/{taskId}/complete',
  ]);
  const documented = new Set(ORCHESTRATOR_API_OPERATIONS.map(({ method, path: pathname }) => `${method} ${pathname}`));
  assert.deepEqual([...documented].sort(), [...routed].sort());
});

test('OpenAPI and the gateway catalog are complete projections of one contract', () => {
  const document = buildOpenApiDocument('http://127.0.0.1:8791/');
  const openApiOperations = Object.values(document.paths)
    .flatMap((pathItem) => Object.keys(pathItem).filter((method) => ['get', 'post'].includes(method))).length;
  assert.equal(document.openapi, '3.1.0');
  assert.equal(openApiOperations, ORCHESTRATOR_API_OPERATIONS.length);
  assert.equal(buildApiRouteCatalog().length, ORCHESTRATOR_API_OPERATIONS.length);
  assert.equal(new Set(ORCHESTRATOR_API_OPERATIONS.map(({ operationId }) => operationId)).size, ORCHESTRATOR_API_OPERATIONS.length);
  for (const operation of ORCHESTRATOR_API_OPERATIONS) {
    assert.ok(operation.summary);
    assert.ok(operation.description);
    assert.ok(document.paths[operation.path]?.[operation.method.toLowerCase()]);
  }
});

test('the audit and Swagger page expose aliases and destructive operations explicitly', () => {
  const audit = buildApiContractAudit();
  assert.ok(audit.aliases.some(({ path: pathname }) => pathname === '/api/status/processes'));
  assert.ok(audit.destructiveOperations.some(({ path: pathname }) => pathname === '/api/actions/reset-graph-database'));
  const html = renderSwaggerUi('http://127.0.0.1:8791/');
  assert.match(html, /SwaggerUIBundle/);
  assert.match(html, /\/api\/openapi\.json/);
});
