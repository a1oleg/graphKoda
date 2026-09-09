import test from 'node:test';
import assert from 'node:assert/strict';
import {startOrchestrator} from '../orchestrator.js';
import {replayLaunch, replayRoutes, resolveReplayRoute} from './annotation-plan/replayRoutes.js';

test('visualizer selects authored routes by source stableId without fallback', () => {
  for (const route of replayRoutes) {
    const result = replayLaunch(route.stableId, 'http://127.0.0.1:8791');
    assert.equal(result.status, 200);
    assert.equal(new URL(result.body.url).searchParams.get('stableId'), route.stableId);
    assert.equal(resolveReplayRoute(route.stableId).model, route.model);
  }
  assert.equal(replayLaunch(null, 'http://localhost').status, 400);
  assert.equal(replayLaunch(' ', 'http://localhost').status, 400);
  assert.equal(replayLaunch('unknown', 'http://localhost').status, 404);
});

test('HTTP launch API and Swagger expose the parameterized visualizer without Neo4j', async () => {
  const server = await startOrchestrator({uri:'bolt://127.0.0.1:1',user:'test',password:'test',port:0});
  try {
    const endpoint = new URL('/api/annotations/visualizer', server.url);
    assert.equal((await fetch(endpoint)).status, 400);
    endpoint.searchParams.set('stableId', 'unknown');
    assert.equal((await fetch(endpoint)).status, 404);
    endpoint.searchParams.set('stableId', replayRoutes[0].stableId);
    const response = await fetch(endpoint);
    assert.equal(response.status, 200);
    const launch = await response.json();
    assert.equal(launch.mode, 'authored');
    assert.equal((await fetch(launch.url)).status, 200);
    assert.equal((await fetch(new URL('/annotation-plan/assets/replayRoutes.js', server.url))).status, 200);
    const spec = await (await fetch(new URL('/api/openapi.json', server.url))).json();
    const parameter = spec.paths['/api/annotations/visualizer'].get.parameters[0];
    assert.equal(parameter.name, 'stableId');
    assert.equal(parameter.required, true);
  } finally { await server.stop(); }
});
