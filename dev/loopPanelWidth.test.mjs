import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
import { chromium } from '@playwright/test';

test('ALL ends at Transition in a 1600x900 capture, including filtered cases', async () => {
  const source = await fs.readFile('graph/vscode-extension/extension.js', 'utf8');
  const ast = ts.createSourceFile('extension.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'buildRuntimeAnalysisHtml');
  const { buildRuntimeAnalysisHtml } = await import('data:text/javascript,' + encodeURIComponent(`export ${fn.getText(ast)}`));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    await page.goto('about:blank');
    await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage() {} }); });
    await page.setContent(buildRuntimeAnalysisHtml(''));
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'analysis', analysis: { methodName: 'for', iterationVariable: 'current', totalIterations: 1,
        totalCases: 1, variableColumns: ['random', 'alphabet'], collectionColumns: ['alphabet'],
        segments: [{ id: 'repeat', count: 1, outcome: 'continue', iterationIndexes: [0] }],
        cases: [{ index: 0, itemPreview: '{"current":1}', variableValues: { random: '2', alphabet: '["A","B","C"]' },
          transition: 'continue', durationMs: 1 }] },
    } })));
    for (const width of [1600, 1100]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator('#segments button').click();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      const all = await page.locator('#all').boundingBox();
      const transition = await page.locator('#outcomeHeader').boundingBox();
      assert(Math.abs(all.x + all.width - transition.x - transition.width) < 1);
      assert(all.x + all.width <= width);
      await page.locator('#all').click();
    }
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.screenshot({ path: 'tmp/loop-panel-width.png' });
  } finally { await browser.close(); }
});
