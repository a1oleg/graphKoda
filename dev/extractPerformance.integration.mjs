import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { startOrchestrator } from '../graph/packages/orchestrator/src/orchestrator.js';
import { parseImportResult, compareImportPerformance, readImportPerformanceHistory, saveImportPerformance } from '../graph/packages/orchestrator/src/orchestrator/extractPerformance.js';
import { getExtractStatus } from '../graph/packages/orchestrator/src/orchestrator/graphExtract.js';

const cwd = process.cwd();
const logs = path.join(cwd, 'graph/.runtime/logs');
const actual = fs.readdirSync(logs).filter(name => /^extract-func-\d.*\.log$/.test(name)).sort().flatMap(name => {
  const lines = fs.readFileSync(path.join(logs, name), 'utf8').split(/\r?\n/);
  const result = lines.map(parseImportResult).filter(Boolean).at(-1);
  const startedAt = lines[0]?.match(/^([^ ]+) \[orchestrator\] starting/)?.[1];
  const finishedAt = lines.findLast(line => /\[orchestrator\] finished exitCode=0/.test(line))?.split(' ')[0];
  return result?.stageSeconds > 0 && startedAt && finishedAt ? [{ result, startedAt, finishedAt, name }] : [];
});
assert.ok(actual.length >= 2, 'Two actual completed full-import logs required');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-performance-'));
let app;
try {
  const directory = path.join(temp, 'graph/.runtime/logs');
  fs.mkdirSync(directory, { recursive: true });
  // Same archived pipeline/configuration is compared; no graph or timings fabricated.
  const selected = actual.slice(-2);
  const context = { catalogLocation: selected[0].result.parquetDir, mode: 'func', catalogOnly: false };
  const reports = selected.map(row => saveImportPerformance({ ...row,
    logPath: path.join(directory, row.name), exitCode: 0, performanceContext: context }, row.result));
  assert.equal(reports[0].comparisonStatus, 'no-compatible-previous-run');
  assert.equal(reports[1].comparisonStatus, 'compared');
  const comparison = reports[1].comparison;
  assert.equal(comparison.previousFinishedAt, reports[0].finishedAt);
  const total = comparison.intervals.find(row => row.name === 'import.total');
  assert.equal(total.deltaSeconds, selected[1].result.elapsedSeconds - selected[0].result.elapsedSeconds);
  assert.equal(total.slower, total.deltaSeconds > 0);
  assert.equal(compareImportPerformance({ ...reports[1], context: { ...context, catalogOnly: true } }, reports[0]), null);
  assert.equal(compareImportPerformance({ ...reports[1], status: 'incomplete' }, reports[0]), null);
  assert.equal(readImportPerformanceHistory(directory).length, 2);
  process.chdir(temp);
  const status = getExtractStatus();
  assert.equal(status.performance.finishedAt, reports[1].finishedAt);
  assert.deepEqual(status.performance.comparison, comparison);
  assert.equal(status.running, false);
  dotenv.config({ path: path.join(cwd, 'graph/.env'), quiet: true });
  app = await startOrchestrator({ uri: process.env.NEO4J_URI,
    user: process.env.NEO4J_USER || process.env.NEO4J_USERNAME, password: process.env.NEO4J_PASSWORD,
    database: process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j', port: 0 });
  const response = await fetch(new URL('/api/extract/status', app.url));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).performance.comparison, comparison);
  console.log(JSON.stringify({ ok: true, actualLogs: selected.map(row => row.name),
    intervals: comparison.intervals.length, slowdowns: comparison.slowdowns.length,
    restartReadback: true, httpStatus: response.status, writesNeo4j: false }));
} finally {
  await app?.stop();
  process.chdir(cwd);
  assert.ok(path.resolve(temp).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
  fs.rmSync(temp, { recursive: true, force: true });
}
