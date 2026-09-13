import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { buildRuntimePathSelection } from './runtimePathDrawio.mjs';

const base = 'http://127.0.0.1:8787';
const latest = JSON.parse(await fs.readFile('tmp/fisher-yates/runtime/latest.json', 'utf8'));
const spec = await (await fetch(`${base}/api/openapi.json`)).json();
for (const endpoint of ['/runtime-trace', '/runtime-values', '/runtime-analysis']) {
  assert(spec.paths[endpoint]?.get);
  const url = new URL(endpoint, base);
  url.searchParams.set('stableId', endpoint === '/runtime-analysis' ? latest.loop : latest.root);
  url.searchParams.set('sessionId', latest.sessionId);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert(body.ok);
  if (body.analysis) assert.equal(body.analysis.totalIterations, 7);
  if (body.trace) assert(body.trace.chain.length >= 49);
  if (body.values) assert.equal(body.values.values.find(v => v.stableId.endsWith(':5:55:5:64')).valuePreview, '0');
  const missing = await fetch(`${base}${endpoint}`);
  assert.equal(missing.status, 400);
}
const xml = await fs.readFile('graph/draw/generated/Fisher-Yates.drawio', 'utf8');
const selection = buildRuntimePathSelection(xml, latest.trace.chain);
assert(selection.edgePairs.some(e => e.edgeType === 'TRUE'));
assert(selection.edgePairs.some(e => e.edgeType === 'FALSE'));
assert(selection.edgePairs.some(e => e.edgeType === 'REPEATS'));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/api/docs`);
  for (const endpoint of ['/runtime-trace', '/runtime-values', '/runtime-analysis']) {
    const operation = page.locator('.opblock').filter({ has: page.locator(`.opblock-summary-path[data-path="${endpoint}"]`) });
    await operation.locator('.opblock-summary').click();
    const tryButton = operation.getByRole('button', { name: 'Try it out', exact: true });
    if (await tryButton.count()) await tryButton.click();
    const responsePromise = page.waitForResponse(response => response.url().startsWith(`${base}${endpoint}?`) && response.request().method() === 'GET');
    await operation.getByRole('button', { name: 'Execute', exact: true }).click();
    const response = await responsePromise;
    assert.equal(response.status(), 200);
    const body = await response.json();
    assert(body.ok);
    if (body.analysis) {
      assert.equal(body.analysis.totalIterations, 7);
      assert.deepEqual(body.analysis.conditionChecks, { total: 8, true: 7, false: 1 });
    }
    checks.push({ endpoint, swaggerStatus: response.status() });
  }
  const runOperation = page.locator('.opblock').filter({ has: page.locator('.opblock-summary-path[data-path="/fisher/run"]') });
  await runOperation.locator('.opblock-summary').click();
  const tryRun = runOperation.getByRole('button', { name: 'Try it out', exact: true });
  if (await tryRun.count()) await tryRun.click();
  const runResponsePromise = page.waitForResponse(response => response.url() === `${base}/fisher/run` && response.request().method() === 'POST');
  await runOperation.getByRole('button', { name: 'Execute', exact: true }).click();
  const runResponse = await runResponsePromise;
  assert.equal(runResponse.status(), 200);
  const runResult = await runResponse.json();
  assert(runResult.ok);
  assert.equal(runResult.run.iterations, 7);
  assert.notEqual(runResult.run.sessionId, latest.sessionId);
  checks.push({ endpoint: '/fisher/run', swaggerStatus: 200, sessionId: runResult.run.sessionId });
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
const report = { sessionId: latest.sessionId, checks, selection };
await fs.writeFile('tmp/fisher-yates/runtime/api-audit.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ sessionId: latest.sessionId, checks, traceEdges: selection.involvedEdgeIds.length }, null, 2));
