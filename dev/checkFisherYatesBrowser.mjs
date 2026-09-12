import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = process.argv.includes('--headless')
  ? await chromium.launch({ channel: 'chrome', headless: true })
  : await chromium.connectOverCDP('http://127.0.0.1:9222');
try {
  const context = browser.contexts()[0] || await browser.newContext();
  const page = await context.newPage();
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.setContent('<html><body style="margin:0"><div class="mxgraph" style="width:1600px;height:1100px"></div></body></html>');
  await page.evaluate(xml => document.querySelector('.mxgraph').setAttribute('data-mxgraph', JSON.stringify({ xml, nav: true, resize: false, autoFit: true })),
    fs.readFileSync(process.argv[2] || 'graph/draw/generated/Fisher-Yates.drawio', 'utf8'));
  const extensions = path.join(process.env.USERPROFILE, '.vscode/extensions');
  const drawio = fs.readdirSync(extensions).find(n => n.startsWith('hediet.vscode-drawio-'));
  await page.addScriptTag({ path: path.join(extensions, drawio, 'drawio/src/main/webapp/js/viewer.min.js') });
  await page.evaluate(() => GraphViewer.processElements());
  await page.waitForTimeout(1000);
  assert(await page.locator('svg').count());
  await page.screenshot({ path: 'tmp/fisher-yates/expanded.png' });
  console.log('Draw.io screenshot: tmp/fisher-yates/expanded.png');
  const replay = browser.contexts()[0].pages().find(p => p.url().includes(':8793'));
  if (replay && !process.argv[2]) {
    await replay.reload();
    await replay.waitForFunction(() => document.getElementById('counter')?.textContent.includes('/'));
    let count = 0;
    while (await replay.locator('#next').isEnabled() && count < 100) { await replay.locator('#next').click(); count++; }
    assert(count > 0 && count < 100);
    console.log('Visualizer:', await replay.locator('#counter').textContent());
    await replay.locator('#reset').click();
  }
} finally { await browser.close(); }
