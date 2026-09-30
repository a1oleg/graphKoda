import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { startOrchestrator } from '../graph/packages/orchestrator/src/orchestrator.js';
import { isRankingActive } from '../graph/packages/orchestrator/src/orchestrator/graphRanking.js';

// Exercises the actual configured extraction, Python workers and local Neo4j.
dotenv.config({ path: 'graph/.env', quiet: true });
const app = await startOrchestrator({ uri: process.env.NEO4J_URI,
  user: process.env.NEO4J_USER || process.env.NEO4J_USERNAME,
  password: process.env.NEO4J_PASSWORD,
  database: process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j', port: 0 });
const pause = () => new Promise(resolve => setTimeout(resolve, 2000));
async function request(route, body) {
  const response = await fetch(new URL(route, app.url), body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function wait(runId) {
  let last;
  while (true) {
    const { body } = await request(`/api/graph/ranking/status?runId=${runId}`);
    assert.equal(body.ok, true);
    const progress = JSON.stringify(body.run.progress);
    if (progress !== last) { console.log(progress); last = progress; }
    if (body.run.status !== 'running') return body.run;
    await pause();
  }
}
try {
  assert.equal((await request('/api/graph/ranking/plan')).body.plan.version, 3);
  assert.equal((await request('/api/graph/ranking/preflight')).body.ready, true);
  const started = await request('/api/graph/ranking/run', {});
  assert.equal(started.status, 202);
  const runId = started.body.runId;
  assert.equal((await request('/api/graph/ranking/run', {})).status, 409);
  assert.equal((await request('/api/graph/ranking/recover', {})).status, 409);
  assert.equal((await request('/api/actions/run-extract', {})).status, 409);
  const calculated = await wait(runId);
  assert.equal(calculated.status, 'complete');
  assert.ok(calculated.summary.components > 0);
  assert.ok(calculated.summary.cyclicComponents > 0);
  assert.equal((await request('/api/graph/ranking/status')).body.run.runId, runId);
  if (process.argv.includes('--persist')) {
    assert.equal((await request('/api/graph/ranking/persist', { runId })).status, 202);
    const published = await wait(runId);
    assert.equal(published.status, 'complete');
    assert.equal(published.progress.phase, 'verified');
    assert.equal(published.progress.verifiedComponents, calculated.summary.components);
  }
  console.log(JSON.stringify({ ok: true, runId, persisted: process.argv.includes('--persist') }));
} finally {
  while (isRankingActive()) await pause();
  await app.stop();
}
