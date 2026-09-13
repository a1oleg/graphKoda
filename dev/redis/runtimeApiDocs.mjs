import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { renderSwaggerUi } from '../../graph/packages/orchestrator/src/orchestrator/apiContract.js';
const assets = createRequire(import.meta.url)('swagger-ui-dist').getAbsoluteFSPath();
export const runtimeOpenApi = {
  openapi: '3.1.0', info: { title: 'ColdKode Runtime API', version: '1' }, servers: [{ url: '/' }],
  paths: Object.fromEntries([
    ['/health', 'Runtime relay and Redis health'], ['/stats', 'Runtime storage statistics'],
    ['/runtime-trace', 'Show executed function Trace'], ['/runtime-values', 'Show recorded variable values'],
    ['/runtime-analysis', 'Show loop statistics (for and collection iterations)'],
  ].map(([route, summary]) => [route, { get: { summary,
    parameters: route.startsWith('/runtime-') ? [
      { name: 'stableId', in: 'query', required: true, description: route === '/runtime-analysis' ? 'Loop node stableId.' : 'Function stableId.', schema: { type: 'string' }, example: route === '/runtime-analysis' ? 'examples/fisher-yates/src/shuffle.ts:6:2:10:3:for' : 'examples/fisher-yates/src/shuffle.ts:1:7:13:1' },
      { name: 'sessionId', in: 'query', description: 'Omit to select the latest session.', schema: { type: 'string' } },
      ...(route === '/runtime-analysis' ? [{ name: 'invocationEventId', in: 'query', schema: { type: 'string' } }] : []),
    ] : [],
    responses: { 200: { description: 'Result', content: { 'application/json': { schema: { type: 'object' } } } },
      400: { description: 'Invalid request' }, 500: { description: 'Storage unavailable' } },
  } }])) ,
};
runtimeOpenApi.paths['/graph-relay'] = { post: { summary: 'Ingest Babel runtime envelopes',
  requestBody: { required: true, content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } },
  responses: { 200: { description: 'Persisted in Redis; returns stored, skipped and queuedRows' }, 500: { description: 'Invalid payload or storage error' }, 503: { description: 'Queue full' } } } };
runtimeOpenApi.paths['/fisher/run'] = { post: { summary: 'Instrument and run the actual Fisher source with Babel',
  description: 'Creates a new runtime session without clearing earlier runs. Returns verified trace, value and loop counts.',
  responses: { 200: { description: 'Verified run summary' }, 409: { description: 'A run is already active' }, 500: { description: 'Run or verification failed' } } } };
runtimeOpenApi.paths['/runtime-data'] = { delete: { summary: 'Delete all runtime data in the configured Redis namespace',
  description: 'Destructive. Not required for Fisher runs.', responses: { 200: { description: 'Deletion result' }, 500: { description: 'Storage error' } } } };
runtimeOpenApi.paths['/runtime-analysis'].get.description = 'For ordinary for loops, totalIterations counts body executions; totalCases also includes the final condition-false case. cases use transition=continue or break (condition-false, not a JavaScript break statement), displayed as repeat/false in the panel, and contain variableName/itemPreview and complete edgePairs. Fisher itemPreview contains the real current object assigned in the body, {current:{index,value}}. The final false case captures the guard state: index is zero and value remains from the last body execution. Initialization before the loop has an undefined value. REPEATS returns to the guard, never to initialization. variableColumns lists body bindings; each case.variableValues maps their names to JSON previews (random is absent in the terminal case). iterations excludes the terminal case. iterationVariable names the table column. Other loop kinds retain their own outcome vocabulary. No accumulator column is needed when accumulatorName and accumulatorState are absent.';
export function serveRuntimeDocs(req, res) {
  const route = new URL(req.url, 'http://localhost').pathname;
  if (req.method !== 'GET') return false;
  if (route === '/api/openapi.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(runtimeOpenApi)); return true;
  }
  if (route === '/api/docs' || route === '/swagger') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderSwaggerUi().replace('ColdKode Graph Orchestrator API', 'ColdKode Runtime API')); return true;
  }
  const asset = route.slice('/api/docs/assets/'.length);
  if (route.startsWith('/api/docs/assets/') && ['swagger-ui.css', 'swagger-ui-bundle.js'].includes(asset)) {
    res.writeHead(200, { 'Content-Type': asset.endsWith('.css') ? 'text/css' : 'text/javascript' });
    fs.createReadStream(path.join(assets, asset)).pipe(res); return true;
  }
  return false;
}
