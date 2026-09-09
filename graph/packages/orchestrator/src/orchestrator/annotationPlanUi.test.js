import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { startOrchestrator } from '../orchestrator.js';

test('plan UI: build only, inspect, refresh, errors and responsive canvas', async () => {
  const server = await startOrchestrator({ uri: 'bolt://127.0.0.1:7687', user: 'test', password: 'test', port: 0 });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const node = (id, state, displayName) => ({ id, stableId: `code:${id}`, displayName,
      state, kind: 'Binding', blockedBy: [], referenceOnly: false });
    const nodes = [node('root', 'WAITING', 'input'), node('a', 'AVAILABLE', 'source')];
    nodes[0].blockedBy = ['a'];
    const plan = { jobId: 'job', rootId: 'root', requestedRootStableId: 'input', maxDepth: 4,
      state: 'PAUSED', observedAt: new Date().toISOString(), nodes,
      edges: [{ id: 'edge', from: 'root', to: 'a', role: 'origin', ordinal: 0, dependencyKind: 'semantic' }],
      working: [], waiting: [{ id: 'root' }], available: [{ id: 'a' }] };
    const requests = [];
    let fail = false;
    await page.route('**/api/annotations/graphql', async route => {
      const body = route.request().postDataJSON(); requests.push(body);
      const key = body.query.includes('prepareAnnotationPlan') ? 'prepareAnnotationPlan' : 'annotationPlan';
      await route.fulfill({ json: fail ? { errors: [{ message: 'Test failure' }] } : { data: { [key]: plan } } });
    });
    await page.goto(`${server.url}annotation-plan`);
    await page.waitForSelector('#graph canvas');
    assert.equal(requests.length, 0);
    await page.locator('#build').click();
    await page.waitForFunction(() => document.querySelector('#counts').textContent.includes('2 узлов'));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].variables.input.maxDepth, 4);
    await page.locator('#available button').click();
    assert.match(await page.locator('#details').innerText(), /source/);
    await page.locator('#search').fill('source');
    await page.locator('#search').fill('');
    await page.locator('#zoomIn').click();
    await page.locator('#fit').click();
    await page.locator('#refresh').click();
    await page.waitForFunction(() => !document.querySelector('#refresh').disabled);
    assert.ok(requests.every(r => !r.query.includes('nextAnnotation') && !r.query.includes('completeAnnotation')));
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.locator('#fit').click();
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.ok(await page.evaluate(() => [...document.querySelectorAll('#graph canvas')].some(canvas => {
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 3; i < data.length; i += 4) if (data[i]) return true;
        return false;
      })));
    }
    fail = true;
    await page.locator('#refresh').click();
    await page.waitForSelector('#error:not([hidden])');
    assert.equal(await page.locator('#error').textContent(), 'Test failure');
    assert.equal(await page.locator('#build').isEnabled(), true);
    assert.match(await page.locator('#counts').innerText(), /2 узлов/);
    assert.deepEqual(errors, []);
    assert.equal((await page.request.get(`${server.url}annotation-plan/assets/not-an-asset.js`)).status(), 404);
  } finally { await browser.close(); await server.stop(); }
});
