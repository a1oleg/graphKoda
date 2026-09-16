// Actual local draw.io application + actual demo bridge, with the real Fisher scene.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {chromium} from 'playwright';
const require=createRequire(import.meta.url);
const {createDemoControl}=require('../graph/vscode-extension/demoControl.js');
const webapp=path.resolve('graph/vendor/drawio/src/main/webapp');
let editorPage;
const control=createDemoControl({workspaceRoot:path.resolve('.'),tokenFilePath:path.resolve('tmp/graph-scene/live-check/token.local'),runtimeSend:()=>false,runtimeState:()=>null,openDiagram:async file=>{
 const xml=await fs.readFile(file,'utf8');
 await editorPage.evaluate(xml=>sceneTestUi.editor.setGraphXml(mxUtils.parseXml(xml).getElementsByTagName('mxGraphModel')[0]),xml);
}});
const server=http.createServer(async(req,res)=>{
 res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','Content-Type');
 if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
 try{
  const url=new URL(req.url,'http://localhost');if(await control.handle(req,res,url))return;
  const file=path.resolve(webapp,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
  if(!file.startsWith(webapp+path.sep))throw Error('outside webapp');
  res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html','.css':'text/css','.svg':'image/svg+xml','.json':'application/json'})[path.extname(file)]||'application/octet-stream');res.end(await fs.readFile(file));
 }catch(e){res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1600,height:900}});
 editorPage=page;
 page.on('pageerror',e=>console.error('Draw.io:',e.message));
 page.on('console',m=>{if(m.type()==='error')console.error('Console:',m.text().slice(0,300));});
 page.on('requestfailed',r=>console.error('Failed:',r.url(),r.failure()?.errorText));
 page.on('response',r=>{if(r.status()>=400)console.error('HTTP',r.status(),r.url());});
 await page.route('http://127.0.0.1:17843/**',r=>r.continue({url:r.request().url().replace('http://127.0.0.1:17843',base)}));
 await page.goto(base+'/index.html?embed=1&proto=json&splash=0&lang=en&gapi=0&db=0&od=0&tr=0&gh=0&gl=0',{waitUntil:'domcontentloaded'});
 console.log('Draw.io document loaded');
 await page.waitForFunction(()=>window.Draw?.loadPlugin,null,{timeout:45000}).catch(async e=>{console.error(await page.evaluate(()=>({ready:document.readyState,status:document.getElementById('geStatus')?.textContent,app:typeof App,draw:typeof Draw,loaded:window.mxScriptsLoaded,win:window.mxWinLoaded})));throw e;});
 await page.evaluate(()=>Draw.loadPlugin(ui=>{window.sceneTestUi=ui;}));
 await page.waitForFunction(()=>window.sceneTestUi,null,{timeout:45000});
 console.log('Draw.io UI ready');
 const xml=await fs.readFile('graph/draw/scenes/fisher.drawio','utf8');
 await page.evaluate(xml=>sceneTestUi.editor.setGraphXml(mxUtils.parseXml(xml).getElementsByTagName('mxGraphModel')[0]),xml);
 await page.addScriptTag({path:path.join(webapp,'plugins/codexGraph.js')});
 console.log('Scene and plugin loaded');
 const input={surface:'diagram',functionStableId:'graph-scene:fisher'};
 const before=await control.step({...input,action:'sceneRead'});
 assert.equal(before.cells.filter(c=>c.stableId).length,5);
 const moved=await control.step({...input,action:'scenePointer',pointerId:'narrator',pointer:{x:1210.5,y:596.25},durationMs:250});
 assert.equal(moved.x,1210.5);
 const after=await control.step({...input,action:'sceneRead'});
 assert.equal(after.cells.find(c=>c.cellId==='pointer-narrator').targetPoint.y,596.25);
 assert.deepEqual(before.cells.filter(c=>c.stableId),after.cells.filter(c=>c.stableId));
 await control.step({...input,action:'sceneSync',xml});
 const synced=await control.step({...input,action:'sceneRead'});
 assert.equal(synced.cells.find(c=>c.cellId==='pointer-narrator')?.targetPoint?.x,before.cells.find(c=>c.cellId==='pointer-narrator')?.targetPoint?.x);
 const {executeAnnotationGraphql}=await import('../graph/packages/orchestrator/src/orchestrator/annotationGraphql.js');
 const gql=async(query,variables={})=>{const r=await executeAnnotationGraphql({query,variables},{services:{presentationSend:input=>control.step(input)}});assert(!r.errors,JSON.stringify(r.errors));return r.data;};
 const variables=JSON.parse(await fs.readFile('graph/presentation/fisher.variables.json','utf8'));
 variables.input.steps=variables.input.steps.map((s,i)=>({...s,atMs:i*150,durationMs:100}));
 const started=await gql('mutation($input:PresentationInput!){playPresentation(input:$input){runId}}',variables);
 let run;
 for(let i=0;i<150;i++){
  await new Promise(r=>setTimeout(r,100));
  run=(await gql('query($id:ID!){presentationRun(runId:$id){status error events}}',{id:started.playPresentation.runId})).presentationRun;
  if(['COMPLETED','FAILED','CANCELLED'].includes(run.status))break;
 }
 assert.equal(run.status,'COMPLETED',JSON.stringify(run));
 assert(run.events.some(e=>e.result?.cellId==='f1-block'));
 assert(run.events.some(e=>e.result?.cellId==='f2-block'));
 assert(run.events.some(e=>e.action==='EXPAND'&&e.viewId==='fisher-detail'));
 const controlled=await gql('mutation($input:PresentationInput!){playPresentation(input:$input){runId}}',{input:{steps:[{atMs:0,action:'OPEN',viewId:'fisher-functions'},{atMs:5000,action:'FOCUS',viewId:'fisher-functions',stableId:'examples/fisher-yates/src/shuffle.ts:6:7:33:1'}]}});
 const controlId=controlled.playPresentation.runId;
 const command=action=>gql('mutation($id:ID!,$action:PresentationControl!){controlPresentation(runId:$id,action:$action){status}}',{id:controlId,action});
 assert.equal((await command('PAUSE')).controlPresentation.status,'PAUSED');
 await new Promise(r=>setTimeout(r,200));
 assert.equal((await gql('query($id:ID!){presentationRun(runId:$id){status}}',{id:controlId})).presentationRun.status,'PAUSED');
 assert.equal((await command('RESUME')).controlPresentation.status,'RUNNING');
 await new Promise(r=>setTimeout(r,300));
 await command('CANCEL');
 await new Promise(r=>setTimeout(r,200));
 assert.equal((await gql('query($id:ID!){presentationRun(runId:$id){status}}',{id:controlId})).presentationRun.status,'CANCELLED');
 const report={actualDrawioApplication:true,actualFisherScene:true,readCoordinates:true,pointerAnimation:true,unrelatedNodesUnchanged:true,sceneSync:true,camera:synced.camera};
 report.graphqlScenario={status:run.status,steps:run.events.length,nestedFunctionFocus:true,realNeo4jExpansion:true,pauseResumeCancel:true};
 await fs.writeFile('tmp/graph-scene/live-check.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();control.dispose();server.closeAllConnections();await new Promise(r=>server.close(r));}
