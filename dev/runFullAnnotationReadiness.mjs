import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import paths from './projectPaths.cjs';
import {startOrchestrator} from '../graph/packages/orchestrator/src/orchestrator.js';

dotenv.config({path: path.join(paths.toolRoot, 'graph/.env'), quiet: true});
const app = await startOrchestrator({uri: process.env.NEO4J_URI,
  user: process.env.NEO4J_USER || process.env.NEO4J_USERNAME, password: process.env.NEO4J_PASSWORD,
  database: process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j', port: 0});
const pause = () => new Promise(resolve => setTimeout(resolve, 15000));
async function request(route, body) {
  const response = await fetch(new URL(route, app.url), body === undefined ? {} : {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  const result = await response.json();
  assert.ok(response.ok && result.ok !== false, JSON.stringify(result));
  return result;
}
async function waitForAnalysis(base, runId) {
  for (;;) {
    const {run} = await request(`${base}/status?runId=${runId}`);
    console.log(JSON.stringify({phase: base, runId, status: run.status, progress: run.progress}));
    if (run.status !== 'running') { assert.equal(run.status, 'complete', run.error); return run; }
    await pause();
  }
}
try {
  let imported;
  if (!process.argv.includes('--analysis-only')) {
    const preflight = await request('/api/extract/preflight?mode=func');
    assert.equal(preflight.ready, true, JSON.stringify(preflight));
    const start = await request('/api/actions/run-extract', {mode: 'func', preserveAnnotations: true,
      catalogOnly: process.argv.includes('--catalog-only')});
    console.log(JSON.stringify({phase: 'import-started', logPath: start.logPath || start.activeRun?.logPath}));
    for (;;) {
      const status = await request('/api/extract/status?tailLog=true');
      console.log(JSON.stringify({phase: 'import', running: status.running,
        logTail: (status.activeRun?.logTail || status.lastRun?.logTail || '').slice(-2400)}));
      if (!status.running) {
        imported = status.lastRun;
        assert.ok(imported && imported.exitCode === 0, JSON.stringify(imported));
        break;
      }
      await pause();
    }
  }
  const inventory = await request('/api/graph/annotation-inventory/run', {});
  const inventoryRun = await waitForAnalysis('/api/graph/annotation-inventory', inventory.runId);
  const ranking = await request('/api/graph/ranking/run', {});
  const rankingRun = await waitForAnalysis('/api/graph/ranking', ranking.runId);
  const audit = await request('/api/graph/annotation-inventory/audit/run', {inventoryRunId: inventory.runId});
  const auditRun = await waitForAnalysis('/api/graph/annotation-inventory/audit', audit.runId);
  const report = {ok: true, import: imported, inventory: inventoryRun, ranking: rankingRun, audit: auditRun,
    generatesAnnotations: false, preservesAnnotations: true};
  const output = path.join(paths.dataRoot, 'checks', 'graph-ranking', inventory.runId, 'full-readiness-run.json');
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({phase: 'complete', output, importPerformance: imported?.performance,
    inventory: inventoryRun.summary, ranking: rankingRun.summary, audit: auditRun.summary}));
} finally { await app.stop(); }
