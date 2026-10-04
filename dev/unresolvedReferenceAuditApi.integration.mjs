import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import paths from './projectPaths.cjs';
import { startOrchestrator } from '../graph/packages/orchestrator/src/orchestrator.js';
import { isRankingActive, withRankingExclusion } from '../graph/packages/orchestrator/src/orchestrator/graphRanking.js';

const snapshot = process.argv[2];
if (!snapshot) throw new Error('Usage: <actual-audited-snapshot>');
const expected = JSON.parse(fs.readFileSync(path.join(snapshot, 'unresolved-reference-audit.json'), 'utf8'));
dotenv.config({ path: path.join(paths.toolRoot, 'graph/.env'), quiet: true });
const app = await startOrchestrator({ uri: process.env.NEO4J_URI,
  user: process.env.NEO4J_USER || process.env.NEO4J_USERNAME, password: process.env.NEO4J_PASSWORD,
  database: process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j', port: 0 });
const base = '/api/graph/annotation-inventory/audit';
async function request(route, body) {
  const response = await fetch(new URL(route, app.url), body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
const sleep = () => new Promise(resolve => setTimeout(resolve, 200));
try {
  assert.equal((await request(`${base}/plan`)).body.plan.writesGraph, false);
  assert.equal((await request(`${base}/preflight?snapshot=${encodeURIComponent(snapshot)}`)).body.ready, true);
  assert.equal((await request(`${base}/preflight?snapshot=${encodeURIComponent(paths.sourceRoot)}`)).body.ready, false);
  const start = await request(`${base}/run`, { snapshot });
  assert.equal(start.status, 202, JSON.stringify(start.body));
  const { runId } = start.body;
  assert.equal(isRankingActive(), true);
  await assert.rejects(withRankingExclusion(async () => {}), /ranking is active/);
  assert.equal((await request(`${base}/records?runId=${runId}`)).status, 400);
  let run;
  const deadline = Date.now() + 120000;
  do {
    assert.ok(Date.now() < deadline, 'Audit worker timeout');
    await sleep();
    run = (await request(`${base}/status?runId=${runId}`)).body.run;
  } while (run.status === 'running');
  assert.equal(run.status, 'complete', run.error);
  assert.equal(run.summary.nodes, expected.nodes);
  assert.deepEqual(run.summary.counts, expected.counts);
  assert.equal(run.summary.records, undefined);
  assert.equal(isRankingActive(), false);
  assert.equal((await request(`${base}/status`)).body.run.runId, runId);
  const page = (await request(`${base}/records?runId=${runId}&limit=2`)).body;
  assert.equal(page.total, expected.records.length);
  assert.deepEqual(page.records, expected.records.slice(0, 2));
  const id = expected.records[0].stableId;
  const single = (await request(`${base}/records?runId=${runId}&stableId=${encodeURIComponent(id)}`)).body;
  assert.equal(single.total, 1);
  assert.equal(single.records[0].stableId, id);
  const category = expected.records[0].category;
  const filtered = (await request(`${base}/records?runId=${runId}&category=${category}`)).body;
  assert.equal(filtered.total, expected.counts[category]);
  assert.ok(filtered.records.every(record => record.category === category));
  assert.equal((await request(`${base}/records?runId=${runId}&limit=201`)).status, 400);
  assert.equal((await request(`${base}/records?runId=${runId}&category=unknown`)).status, 400);
  console.log(JSON.stringify({ok: true, runId, nodes: run.summary.nodes, counts: run.summary.counts,
    httpRoutesChecked: true, sharedLockChecked: true, writesGraph: false}));
} finally {
  while (isRankingActive()) await sleep();
  await app.stop();
}
