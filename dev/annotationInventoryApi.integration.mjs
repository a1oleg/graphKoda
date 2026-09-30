import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import dotenv from 'dotenv';
import paths from './projectPaths.cjs';
import { startOrchestrator } from '../graph/packages/orchestrator/src/orchestrator.js';
import { isRankingActive } from '../graph/packages/orchestrator/src/orchestrator/graphRanking.js';
import { resolvePythonExecutable } from '../graph/packages/orchestrator/src/orchestrator/graphExtract.js';

// Real configured Telegram snapshot and HTTP API, no fabricated graph.
dotenv.config({ path: 'graph/.env', quiet: true });
const app = await startOrchestrator({ uri: process.env.NEO4J_URI,
  user: process.env.NEO4J_USER || process.env.NEO4J_USERNAME, password: process.env.NEO4J_PASSWORD,
  database: process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j', port: 0 });
const pause = () => new Promise(resolve => setTimeout(resolve, 2000));
async function request(route, body) {
  const response = await fetch(new URL(route, app.url), body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
const base = '/api/graph/annotation-inventory';
try {
  assert.equal((await request(`${base}/plan`)).body.plan.version, 4);
  assert.equal((await request(`${base}/preflight`)).body.ready, true);
  const started = await request(`${base}/run`, {});
  assert.equal(started.status, 202);
  const { runId } = started.body;
  assert.equal((await request(`${base}/run`, {})).status, 409);
  assert.equal((await request('/api/graph/ranking/run', {})).status, 409);
  assert.equal((await request(`${base}/recover`, {})).status, 409);
  assert.equal((await request('/api/actions/run-extract', {})).status, 409);
  let run;
  const deadline = Date.now() + 300000;
  do {
    assert.ok(Date.now() < deadline, 'Inventory timeout');
    await pause();
    run = (await request(`${base}/status?runId=${runId}`)).body.run;
  } while (run.status === 'running');
  assert.equal(run.status, 'complete', run.error);
  assert.equal(run.summary.version, 4);
  assert.equal((await request(`${base}/status`)).body.run.runId, runId);
  const node = (await request(`${base}/subjects?runId=${runId}&stableId=${encodeURIComponent('src/api/gramjs/ChatAbortController.ts:15:2:18:3')}`)).body;
  assert.equal(node.total, 1);
  assert.equal(node.subjects[0].reason, 'callable-with-body');
  assert.ok(node.subjects[0].body_evidence.includes('ENCLOSED_BY:lexical-function-owner'));
  const page = (await request(`${base}/subjects?runId=${runId}&mode=unresolved&limit=2`)).body;
  assert.equal(page.subjects.length, 2);
  assert.ok(page.subjects.every(subject => subject.mode === 'unresolved'));
  assert.equal((await request(`${base}/subjects?runId=${runId}&limit=201`)).status, 400);
  assert.equal((await request('/api/graph/ranking/persist', { runId })).status, 409);
  execFileSync(resolvePythonExecutable(), ['dev/inventoryAnnotationSubjects.integration.py', '--report',
    path.join(paths.dataRoot, 'checks', 'graph-ranking', runId)], { stdio: 'inherit', windowsHide: true });
  console.log(JSON.stringify({ ok: true, runId, counts: run.summary.counts,
    unresolvedBodies: run.summary.reasons.find(item => item.reason === 'callable-body-not-confirmed')?.count,
    elapsedSeconds: run.summary.elapsedSeconds }));
} finally {
  while (isRankingActive()) await pause();
  await app.stop();
}
