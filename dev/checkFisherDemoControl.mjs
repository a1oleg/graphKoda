// Actual Fisher diagram + local draw.io editor + production popup handlers.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { boxImage } from './localCoordinateDrawio.mjs';
const require=createRequire(import.meta.url);
const {createDemoControl}=require('../graph/vscode-extension/demoControl.js');
const root=fileURLToPath(new URL('../',import.meta.url));
const webroot=path.join(root,'graph/vendor/drawio/src/main/webapp');
const latest=JSON.parse(await fs.readFile(path.join(root,'tmp/fisher-yates/runtime/latest.json'),'utf8'));
const xml=await fs.readFile(path.join(root,'graph/draw/generated/Fisher-Yates.drawio'),'utf8');
const temp=await fs.mkdtemp(path.join(root,'tmp/demo-audit-'));
let runtimeState=null, runtimePage=null;
const broker=createDemoControl({workspaceRoot:temp,runtimeState:()=>runtimeState,
 runtimeSend:async message=>{await runtimePage.evaluate(message=>window.dispatchEvent(new MessageEvent('message',{data:message})),message);return true;}});
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  if(await broker.handle(req,res,url))return;
  const file=path.resolve(webroot,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
  if(!file.startsWith(webroot+path.sep))throw Error('Invalid path');
  let data=await fs.readFile(file);
  if(url.pathname.endsWith('/plugins/codexGraph.js'))data=Buffer.from('Draw.loadPlugin(function(ui){window.__demoAuditUi=ui;});\n'+data.toString());
  const type={'.js':'application/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.xml':'application/xml'}[path.extname(file)];
  res.writeHead(200,{'Content-Type':type||'application/octet-stream'});res.end(data);
 }catch(e){res.writeHead(404);res.end(e.message);}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1600,height:900}});
 page.on('pageerror',e=>console.error('PAGE',e.message));
 page.on('console',m=>{if(m.type()==='error')console.error('CONSOLE',m.text());});
 await page.route('http://127.0.0.1:17843/demo/**',async route=>{
  const r=await route.fetch({url:origin+new URL(route.request().url()).pathname+new URL(route.request().url()).search});
  await route.fulfill({response:r});
 });
 await page.route('http://127.0.0.1:17843/runtime-highlight*',r=>r.fulfill({json:{revision:0,message:null}}));
 let dispatched=null;
 await page.route('http://127.0.0.1:17843/graph-context',route=>{
  dispatched=JSON.parse(route.request().postData());return route.fulfill({status:204,body:''});
 });
 await page.addInitScript(xml=>window.addEventListener('message',e=>{
  let m=e.data;try{if(typeof m==='string')m=JSON.parse(m);}catch{return;}
  if(m?.event==='init')window.postMessage(JSON.stringify({action:'load',xml}),'*');
  if(m?.event==='codexGraphContext')window.__demoContext=m.payload;
 }),xml);
 await page.goto(origin+'/index.html?dev=1&embed=1&proto=json&ui=min&plugins=1&p=codexGraph&noSaveBtn=1',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>!!window.__demoAuditUi,{timeout:20000});
 await page.evaluate(xml=>window.__demoAuditUi.editor.setGraphXml(mxUtils.parseXml(xml).getElementsByTagName('mxGraphModel')[0]),xml);
 await page.waitForFunction(id=>window.__demoAuditUi && Object.values(window.__demoAuditUi.editor.graph.model.cells).some(c=>(c.getAttribute?.('stableId')||c.stableId)===id),latest.loop,{timeout:20000}).catch(async error=>{
  console.log(await page.evaluate(()=>({text:document.body.innerText.slice(0,1500),ui:!!window.__demoAuditUi,draw:typeof Draw,editor:typeof EditorUi,cells:window.__demoAuditUi?Object.keys(window.__demoAuditUi.editor.graph.model.cells).length:0})));
  throw error;
 });
 const cellId=await page.evaluate(id=>{
  const graph=window.__demoAuditUi.editor.graph;
  const matches=Object.values(graph.model.cells).filter(c=>(c.getAttribute?.('stableId')||c.stableId)===id && !c.edge);
  const cell=matches.find(c=>graph.convertValueToString(c)==='for')||matches[0];
  return cell.id;
 },latest.loop);
 const opened=await broker.step({surface:'diagram',action:'contextMenu',cellId,functionStableId:latest.root});
 assert.equal(opened.stage,'menu-open');
 assert(opened.items.includes('показать статистику Цикла'));
 const clicked=await broker.step({surface:'diagram',action:'menuClick',label:'показать статистику Цикла',functionStableId:latest.root});
 assert.equal(clicked.stage,'menu-handler-invoked');
 await page.waitForTimeout(100);
 dispatched=dispatched||await page.evaluate(()=>window.__demoContext);
 assert.equal(dispatched?.action,'openRuntimeAnalysis');
 assert.equal(dispatched?.stableId,latest.loop.replace(/:for$/,''));
 await assert.rejects(broker.step({surface:'diagram',action:'menuClick',label:'missing',functionStableId:latest.root}));
 const url=new URL('http://127.0.0.1:8787/runtime-analysis');url.searchParams.set('stableId',latest.loop);url.searchParams.set('sessionId',latest.sessionId);
 const {analysis}=await (await fetch(url)).json();assert(analysis.cases.length);
 runtimeState={functionStableId:latest.root,analysis};
 const extensionSource=await fs.readFile(path.join(root,'graph/vscode-extension/extension.js'),'utf8');
 const ast=ts.createSourceFile('extension.js',extensionSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='buildRuntimeAnalysisHtml');
 const {buildRuntimeAnalysisHtml}=await import('data:text/javascript,'+encodeURIComponent('export '+fn.getText(ast)));
 runtimePage=await browser.newPage();
 const messages=[];
 await runtimePage.exposeFunction('demoPost',message=>{messages.push(message);if(message.type==='demoResult')broker.finish(message.requestId,message);});
 await runtimePage.addInitScript(()=>window.acquireVsCodeApi=()=>({postMessage:message=>window.demoPost(message)}));
 await runtimePage.goto('about:blank');
 await runtimePage.setContent(buildRuntimeAnalysisHtml(boxImage(),boxImage({collection:true})));
 await runtimePage.evaluate(analysis=>window.dispatchEvent(new MessageEvent('message',{data:{type:'analysis',analysis}})),analysis);
 const ready=await broker.step({surface:'runtime',action:'waitForAnalysis',functionStableId:latest.root});
 await broker.step({surface:'diagram',action:'presentFocus',functionStableId:latest.root,stableId:latest.loop,cellId,scale:0.6});
 const camera=()=>page.evaluate(cellId=>{
  const g=window.__demoAuditUi.editor.graph,v=g.view,s=v.getState(g.model.getCell(cellId));
  return {scale:v.scale,x:v.translate.x,y:v.translate.y,left:g.container.scrollLeft,top:g.container.scrollTop,
    screenX:s.x-g.container.scrollLeft,screenY:s.y-g.container.scrollTop};
 },cellId);
 const beforeResize=await camera();
 await page.setViewportSize({width:800,height:900});
 await page.waitForTimeout(400);
 const afterResize=await camera();
 assert(Math.abs(afterResize.screenX-beforeResize.screenX)<1,'Opening statistics moved the diagram horizontally');
 assert(Math.abs(afterResize.screenY-beforeResize.screenY)<1,'Opening statistics moved the diagram vertically');
 assert(afterResize.screenX>=0&&afterResize.screenX<800,'Loop is outside the narrowed viewport');
 const fixedCamera=afterResize;
 for(const item of analysis.cases){
  await broker.step({surface:'runtime',action:'selectCase',functionStableId:latest.root,index:item.index});
  assert(messages.some(m=>m.type==='showCase'&&m.index===item.index));
  assert.equal(await runtimePage.locator('#details tr.selected').getAttribute('data-case-index'),String(item.index));
  assert(await runtimePage.locator('#demo-pointer').isVisible(),'Case pointer is missing');
  const pointerBounds=await runtimePage.locator('#demo-pointer').boundingBox();
  assert(pointerBounds.x>=0&&pointerBounds.y>=0,'Case pointer is outside the panel');
  const outcome=runtimePage.locator('#details tr.selected td').nth(3+analysis.variableColumns.length);
  assert.equal(await outcome.innerText(),item.terminal?'false':'repeat');
  assert.equal(await outcome.evaluate(el=>getComputedStyle(el).color),item.terminal?'rgb(204, 0, 0)':'rgb(0, 0, 255)');
  await page.evaluate(selection=>window.postMessage(JSON.stringify({action:'runtimeHighlight',selection}),'*'),item);
  await page.waitForTimeout(150);
  assert(await page.evaluate(()=>Object.values(window.__demoAuditUi.editor.graph.model.cells)
    .some(c=>c.edge&&/strokeWidth=3;shadow=0/.test(c.style||''))),`Case ${item.index} did not highlight edges`);
  assert.deepEqual(await camera(),fixedCamera,`Case ${item.index} moved the diagram`);
 }
 for(const segment of analysis.segments){
  await broker.step({surface:'runtime',action:'selectSegment',functionStableId:latest.root,id:segment.id});
  assert(messages.some(m=>m.type==='showSegment'&&m.id===segment.id));
 }
 await broker.step({surface:'runtime',action:'selectAll',functionStableId:latest.root});
 assert.equal(await runtimePage.locator('#details tr').count(),analysis.cases.length);
 await page.evaluate(()=>window.postMessage(JSON.stringify({action:'runtimeHighlightClear'}),'*'));
 await page.waitForTimeout(150);
 assert.deepEqual(await camera(),fixedCamera,'Clearing case selection moved the diagram');
 console.log('Verified transition colors and fixed camera for all cases and clear');
 console.log('Runtime case clicks:',ready.cases.length,'segment clicks:',analysis.segments.length);
 console.log(JSON.stringify({file:'Fisher-Yates.drawio',cellId,opened,clicked,dispatchedAction:dispatched.action,missingMenuRejected:true}));
}finally{await browser.close();broker.dispose();await new Promise(r=>server.close(r));}
