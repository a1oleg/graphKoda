import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { DOMParser } from '@xmldom/xmldom';
import { chromium } from '@playwright/test';
import { normalizeStableId } from '../graph/packages/runtime-core/src/stableId.js';
import { boxImage } from './localCoordinateDrawio.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const latest = JSON.parse(await fs.readFile('tmp/fisher-yates/runtime/latest.json', 'utf8'));
const url = new URL('http://127.0.0.1:8787/runtime-analysis');
url.searchParams.set('stableId', latest.loop); url.searchParams.set('sessionId', latest.sessionId);
const { analysis } = await (await fetch(url)).json();
assert.equal(analysis.totalIterations, 7); assert.equal(analysis.totalCases, 8);
const xml = new DOMParser().parseFromString(await fs.readFile('graph/draw/generated/Fisher-Yates.drawio', 'utf8'), 'application/xml');
const cells = [...Array.from(xml.getElementsByTagName('mxCell'))];
const byId = new Map(cells.map(cell => [cell.getAttribute('id'), cell]));
const canonical = id => { try { return normalizeStableId(id); } catch { return id; } };
const edgeChecks = analysis.cases.map(c => {
  const ids = c.edgePairs.map(pair => {
    const matches = cells.filter(edge => edge.getAttribute('edge') === '1' && (!pair.edgeType || edge.getAttribute('edgeType') === pair.edgeType)
      && ['source', 'target'].every((side, index) => {
        const node = byId.get(edge.getAttribute(side));
        const ids = [edge.getAttribute(index ? 'targetStableId' : 'stableId'),
          ...['stableId', 'sourceStableId', 'sourceCallStableId'].map(key => node?.getAttribute(key))];
        return ids.map(canonical).includes(canonical(index ? pair.targetStableId : pair.sourceStableId));
      }));
    assert(matches.length, `Missing real diagram edge: ${JSON.stringify(pair)}`);
    return matches[0].getAttribute('id');
  });
  assert.equal(ids.length, c.terminal ? 2 : 5);
  return { case: c.index, transition: c.transition, edges: ids };
});
const mcp = new Client({ name: 'fisher-loop-cases-audit', version: '1.0.0' });
try {
  await mcp.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../../drawio-inspector/src/mcp.mjs', import.meta.url))] }));
  const result = await mcp.callTool({ name: 'inspect_region', arguments: {
    file: fileURLToPath(new URL('../graph/draw/generated/Fisher-Yates.drawio', import.meta.url)),
    stableId: latest.loop, mode: 'rendered', padding: 10000, limit: 500,
  } }, undefined, { timeout: 180000 });
  assert(!result.isError && !result.structuredContent.truncated);
  for (const id of new Set(edgeChecks.flatMap(check => check.edges))) {
    assert(result.structuredContent.elements.some(element => element.cellId === id && element.renderedVisible && element.route?.length >= 2), `MCP: edge ${id} is not rendered`);
  }
} finally { await mcp.close(); }
const source = await fs.readFile('graph/vscode-extension/extension.js', 'utf8');
const ast = ts.createSourceFile('extension.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'buildRuntimeAnalysisHtml');
const { buildRuntimeAnalysisHtml } = await import('data:text/javascript,' + encodeURIComponent(`export ${fn.getText(ast)}`));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.messages = []; window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message) }); });
  await page.goto('about:blank');
  await page.setContent(buildRuntimeAnalysisHtml(boxImage()));
  // VS Code injects theme variables directly on the webview body.
  await page.locator('body').evaluate(node => {
    node.classList.add('vscode-dark');
    node.style.setProperty('--vscode-editor-background', '#1f1f1f');
    node.style.setProperty('--vscode-foreground', '#cccccc');
  });
  await page.evaluate(analysis => window.dispatchEvent(new MessageEvent('message', { data: { type: 'analysis', analysis } })), analysis);
  assert.equal(await page.locator('#details tr').count(), 8);
  assert.equal(await page.locator('#itemHeader').innerText(), 'current');
  assert.equal(await page.locator('#outcomeHeader').innerText(), 'Transition');
  assert.equal(await page.locator('#accumulatorHeader').isVisible(), false);
  assert.equal(await page.locator('#details tr').first().locator('td').count(), 6);
  assert.equal(await page.locator('th[data-variable="random"] .variable-box').innerText(), 'random');
  assert.equal(await page.locator('#itemHeader').evaluate(node => getComputedStyle(node).paddingTop), '9px');
  assert.equal(await page.locator('body').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)');
  assert.equal(await page.locator('body').evaluate(node => getComputedStyle(node).color), 'rgb(32, 33, 36)');
  assert(await page.locator('#itemHeader').evaluate(async node => {
    const background = getComputedStyle(node).backgroundImage;
    if (!background.startsWith('url(')) return false;
    const img = new Image(); img.src = background.slice(5, -2);
    try { await img.decode(); return img.naturalWidth > 0; } catch { return false; }
  }));
  for (let index = 0; index < 8; index++) {
    const row = page.locator('#details tr').nth(index);
    assert.deepEqual(JSON.parse(await row.locator('td').nth(2).innerText()), JSON.parse(analysis.cases[index].itemPreview).current);
    assert.equal(await row.locator('td').nth(2).evaluate(node => getComputedStyle(node).textAlign), 'center');
    assert.equal(await row.locator('td').nth(3).innerText(), analysis.cases[index].variableValues.random ?? '—');
    assert.equal(await row.locator('td').nth(3).evaluate(node => getComputedStyle(node).textAlign), 'center');
    assert.equal(await row.locator('td').nth(4).innerText(), index === 7 ? 'false' : 'repeat');
    assert.equal(await row.locator('.case-marker').evaluate(node => getComputedStyle(node).backgroundColor), index === 7 ? 'rgb(204, 0, 0)' : 'rgb(0, 0, 255)');
    await row.click();
    assert.equal(await page.evaluate(() => window.messages.at(-1).index), index);
  }
  for (const [transition, count] of [['false', 1], ['repeat', 7]]) {
    await page.locator('#segments button').filter({ hasText: transition }).click();
    assert.equal(await page.locator('#details tr').count(), count);
    assert.equal(await page.evaluate(() => window.messages.at(-1).type), 'showSegment');
  }
  await page.locator('#all .all-label').click();
  assert.equal(await page.locator('#details tr').count(), 8);
  for (const width of [380, 1100]) {
    await page.setViewportSize({ width, height: 800 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Panel overflows at ${width}`);
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
await fs.writeFile('tmp/fisher-yates/runtime/panel-audit.json', JSON.stringify({ sessionId: latest.sessionId, edgeChecks }, null, 2));
console.log(JSON.stringify({ cases: 8, continuePaths: 7, breakPaths: 1, panel: 'passed', edgeChecks }, null, 2));
