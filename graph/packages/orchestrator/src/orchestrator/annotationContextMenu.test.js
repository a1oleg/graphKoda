import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {startOrchestrator} from '../orchestrator.js';

test('right click opens the node menu on axes and accumulated contexts', async () => {
  const server=await startOrchestrator({uri:'bolt://127.0.0.1:1',user:'test',password:'test',port:0});
  let browser;
  try {
    browser=await chromium.launch({headless:true,channel:'msedge'});
    const page=await browser.newPage({viewport:{width:1440,height:900}}), errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`${server.url}annotation-plan/assets/replay.html?scenario=speculation&host=vscode`);
    await page.locator('.sequence-axis').first().click({button:'right'});
    await page.getByRole('menu').waitFor();
    assert.equal(await page.getByRole('menuitem').count(),3);
    const bounds=await page.getByRole('menu').boundingBox();
    assert.ok(bounds.x>=0 && bounds.x+bounds.width<=1440);
    assert.ok(bounds.y>=0 && bounds.y+bounds.height<=900);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('menu').isVisible(),false);
    await page.locator('#next').click();
    await page.locator('.sequence-context:not([hidden])').first().click({button:'right'});
    await page.getByRole('menu').waitFor();
    await page.getByRole('menuitem').nth(1).click();
    assert.equal(await page.getByRole('menu').isVisible(),false);
    await page.locator('.sequence-context:not([hidden])').first().click({button:'right'});
    await page.locator('#next').click();
    assert.equal(await page.getByRole('menu').isVisible(),false);
    assert.deepEqual(errors,[]);
  } finally { if(browser)await browser.close();await server.stop(); }
});
