import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium} from '@playwright/test';
import {startOrchestrator} from '../orchestrator.js';
import {scenario,buildFrames} from './annotation-plan/replayModel.js';

test('authored replay is postorder, shares dependencies and retains cumulative context',()=>{
  const frames=buildFrames();
  assert.equal(frames.at(-1).kind,'complete');
  assert.equal(frames.at(-1).ready.length,scenario.nodes.length);
  assert.equal(frames.filter(f=>f.kind==='boundary'&&f.id==='stdin').length,1);
  assert.ok(frames.some(f=>f.kind==='cached'&&f.id==='events'));
  for(const f of frames.filter(f=>f.kind==='synthesize'))
    assert.ok(scenario.nodes.find(n=>n.id===f.id).deps.every(id=>f.ready.includes(id)));
  for(const n of scenario.nodes){const lines=fs.readFileSync(n.file,'utf8').split(/\r?\n/);assert.ok(lines[n.line-1]?.trim(),`${n.file}:${n.line}`);}
  assert.throws(()=>buildFrames({root:'a',nodes:[{id:'a',deps:['a']}]}),/cycle/);
});

test('desktop replay steps without API writes and restores the initial state',async()=>{
  const server=await startOrchestrator({uri:'bolt://127.0.0.1:7687',user:'test',password:'test',port:0});
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[],api=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('/api/'))api.push(r.url());});
    await page.goto(`${server.url}annotation-plan/assets/replay.html`);
    assert.deepEqual(errors,[]);
    await page.waitForFunction(()=>document.querySelector('#counter').textContent.includes('/'));
    await page.locator('#next').click();assert.match(await page.locator('#action').textContent(),/Спуск/);
    await page.locator('#back').click();assert.equal(await page.locator('#back').isDisabled(),true);
    for(let i=0;i<buildFrames().length-1;i++)await page.locator('#next').click();
    assert.equal(await page.locator('#next').isDisabled(),true);
    assert.equal(await page.locator('#context .context-item').count(),3);
    assert.match(await page.locator('#result').textContent(),/не обязательно/);
    fs.mkdirSync('tmp/annotation-replay',{recursive:true});
    await page.screenshot({path:'tmp/annotation-replay/desktop-complete.png',fullPage:true});
    await page.locator('#reset').click();assert.equal(await page.locator('#context .context-item').count(),0);
    await page.screenshot({path:'tmp/annotation-replay/desktop.png',fullPage:true});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.ok(await page.locator('#graph canvas').count()>0);
    assert.deepEqual(errors,[]);assert.deepEqual(api,[]);
  }finally{await browser.close();await server.stop();}
});
