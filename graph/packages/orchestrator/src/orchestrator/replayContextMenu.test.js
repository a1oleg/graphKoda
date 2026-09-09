import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { startOrchestrator } from '../orchestrator.js';

test('node and arrow menus send context and stable IDs to the extension', async () => {
  const server = await startOrchestrator({uri:'bolt://127.0.0.1:7687',user:'test',password:'test',port:0});
  let browser;
  try {
    browser = await chromium.launch({headless:true,channel:'msedge'});
    const page = await browser.newPage({viewport:{width:1440,height:900}});
    const errors=[];
    page.on('pageerror', error=>errors.push(error.message));
    await page.addInitScript(()=>{
      window.sent=[];
      window.addEventListener('message',event=>{if(event.data?.type==='annotationVisualizer')window.sent.push(event.data);});
    });
    await page.goto(`${server.url}annotation-plan/assets/replay.html?host=vscode&stableId=screens/REPL.tsx:3142:82:3146:3`);
    await page.locator('.sequence-axis').first().click({button:'right'});
    assert.deepEqual(await page.getByRole('menuitem').allTextContents(),['Перейти в Код','Добавить в Чат']);
    await page.getByRole('menuitem',{name:'Добавить в Чат'}).click();
    await page.waitForFunction(()=>window.sent.length===1);
    const first=await page.evaluate(()=>window.sent[0]);
    assert.equal(first.action,'addToChat');
    assert.equal(first.stableId,'screens/REPL.tsx:3142:82:3146:3');
    assert.match(first.text,/stableId: screens\/REPL.tsx:3142:82:3146:3/);
    // Use the rendered midpoint so this exercises canvas hit-testing, not just emit().
    const point=await page.evaluate(()=>{
      const cy=document.querySelector('#graph')._cyreg.cy;
      const edge=cy.edges('.message').first();
      const p=edge.renderedMidpoint(),rect=document.querySelector('#graph').getBoundingClientRect();
      return {x:rect.left+p.x,y:rect.top+p.y};
    });
    await page.mouse.click(point.x,point.y,{button:'right'});
    await page.getByRole('menuitem',{name:'Добавить в Чат'}).click();
    await page.waitForFunction(()=>window.sent.length===2);
    const second=await page.evaluate(()=>window.sent[1]);
    assert.match(second.text,/visualEdgeId: message-/);
    assert.match(second.text,/Источник:/);
    assert.match(second.text,/Адресат:/);
    assert.match(second.text,/stableId: screens\/REPL.tsx:3142:82:3146:3/);
    assert.equal(second.stableId,'');
    assert.deepEqual(errors,[]);
  } finally { await browser?.close(); await server.stop(); }
});
