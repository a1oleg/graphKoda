// Presentation shares stableIds with annotation tasks; it never invents semantic edges.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {DOMParser} from '@xmldom/xmldom';
import {readScene,mutateScene,neighbors,query,renderScene} from '../scene/scene.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const runs=new Map();let active=null;
const digest=s=>createHash('sha256').update(s).digest('hex');
export async function views(){return JSON.parse(await fs.readFile(new URL('./views.json',import.meta.url),'utf8'));}
async function view(id){const v=(await views()).find(v=>v.id===id);if(!v)throw Error('Unknown view: '+id);return v;}
export async function diagramIndex(v){
 const file=path.resolve(root,v.file);if(!file.startsWith(path.join(root,'graph/draw')+path.sep))throw Error('View outside diagram directory');
 const xml=await fs.readFile(file,'utf8'),doc=new DOMParser().parseFromString(xml,'text/xml');
 const cells=Array.from(doc.getElementsByTagName('mxCell')).filter(c=>c.getAttribute('vertex')==='1').map(c=>{
  const o=c.parentNode?.nodeName==='object'?c.parentNode:c;
  return {cellId:o.getAttribute('id'),stableId:o.getAttribute('stableId'),kind:o.getAttribute('graphKind')||o.getAttribute('labels')||'',parent:c.getAttribute('parent')};
 });return {file,digest:digest(xml),cells};
}
function select(index,step){
 let cells=index.cells.filter(c=>c.stableId===step.stableId&&(!step.cellId||c.cellId===step.cellId));
 if(cells.length!==1)throw Error(`Missing/ambiguous representation of ${step.stableId}; specify cellId`);
 return cells[0];
}
export async function entity(stableId,profile='aura'){
 const rows=await query(profile,'MATCH (n {stableId:$id}) RETURN properties(n) AS properties,labels(n) AS labels LIMIT 2',{id:stableId});
 if(rows.length!==1)throw Error('Entity missing/ambiguous in '+profile+': '+stableId);
 const annotations=await query(profile,'MATCH (n {stableId:$id})-[:HAS_ANNOTATION]->(a) RETURN properties(a) AS annotation LIMIT 100',{id:stableId});
 const representations=[];for(const v of await views()){if(v.profile!==profile)continue;const i=await diagramIndex(v);for(const c of i.cells.filter(c=>c.stableId===stableId))representations.push({...c,viewId:v.id,file:v.file,kind:v.kind});}
 return {stableId,profile,labels:rows[0].labels,properties:rows[0].properties,annotations:annotations.map(r=>r.annotation),representations};
}
export async function graphNeighbors({viewId,stableId,direction,types,limit=30}){
 const v=await view(viewId);if(!v.sceneId)throw Error('Choose a graph view');
 return neighbors({sceneId:v.sceneId,stableId,direction:direction.toLowerCase(),types,limit});
}
export async function bridge(input){
 const health=await fetch('http://127.0.0.1:17844/health',{signal:AbortSignal.timeout(3000)}).then(r=>r.json());
 if(health.presentationWindow!==true)throw Error('Dedicated presentation window is not ready');
 const token=(await fs.readFile(path.join(root,'tmp/graph-presenter-token.local'),'utf8')).trim();
 const r=await fetch('http://127.0.0.1:17844/demo/step',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(input),signal:AbortSignal.timeout(20000)});
 const data=await r.json();if(!r.ok)throw Error(data.error||'Bridge failure');return data;
}
export async function validatePresentation(input){
 if(!input.steps?.length||input.steps.length>200)throw Error('A scenario requires 1..200 steps');
 let last=-1;const hashes={},compiled=[],simulated=new Map();
 for(const step of input.steps){
  if(!Number.isInteger(step.atMs)||step.atMs<last||step.atMs>3600000)throw Error('Step times must increase, within one hour');last=step.atMs;
  if(step.durationMs!=null&&(step.durationMs<0||step.durationMs>5000))throw Error('durationMs must be 0..5000');
  const v=await view(step.viewId),index=await diagramIndex(v);hashes[v.id]=index.digest;
  if(v.sceneId&&!simulated.has(v.id)){const s=await readScene(v.sceneId);simulated.set(v.id,new Set(Object.keys(s.nodes)));}
  const targetSet=simulated.get(v.id);
  let cellId=step.cellId;
  if(step.action==='OPEN_CODE'){
   if(!['RIGHT','BELOW'].includes(step.placement)||!/^.+:\d+:\d+:\d+:\d+$/.test(step.stableId||''))throw Error('OPEN_CODE requires source stableId and RIGHT/BELOW placement');
   await entity(step.stableId,v.profile);
  }
  if(['FOCUS','POINTER'].includes(step.action)){
   if(!step.stableId)throw Error('stableId is required');
   if(targetSet){if(!targetSet.has(step.stableId))throw Error('Target not visible at this step');}
   else cellId=select(index,step).cellId;
  }
  if(['EXPAND','HIDE','ANNOTATIONS','MOVE'].includes(step.action)&&!v.sceneId)throw Error('Graph action requires a graph view');
  if(step.action==='EXPAND'){
   if(!targetSet.has(step.stableId)||!['IN','OUT'].includes(step.direction)||!step.types?.length||!step.targets?.length||step.targets.length>20)throw Error('Explicit visible source, direction, types and targets required');
   const pattern=step.direction==='OUT'?'(n)-[r]->(m)':'(n)<-[r]-(m)';
   const rows=await query(v.profile,`MATCH ${pattern} WHERE n.stableId=$id AND type(r) IN $types AND m.stableId IN $targets RETURN DISTINCT m.stableId AS id`,{id:step.stableId,types:step.types,targets:step.targets});
   if(step.targets.some(id=>!rows.some(r=>r.id===id)))throw Error('Expansion does not exist in Neo4j');
   step.targets.forEach(id=>targetSet.add(id));
  }
  if(step.action==='HIDE'){if(!step.targets?.length||step.targets.includes(v.rootStableId))throw Error('Invalid hide targets');step.targets.forEach(id=>targetSet.delete(id));}
  if(step.action==='ANNOTATIONS'&&(!Number.isInteger(step.visibleThrough)||step.visibleThrough<0))throw Error('visibleThrough required');
  if(step.action==='MOVE'&&(!step.positions?.length||step.positions.some(p=>!targetSet.has(p.stableId)||!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.abs(p.x)>100000||Math.abs(p.y)>100000)))throw Error('Invalid move');
  if(!['OPEN','OPEN_CODE','FOCUS','POINTER','EXPAND','HIDE','ANNOTATIONS','MOVE'].includes(step.action))throw Error('Unsupported step');
  compiled.push({...step,cellId,view:v});
 }
 return {valid:true,steps:compiled,hashes};
}
async function store(run){await fs.mkdir(path.join(root,'tmp/presentation'),{recursive:true});await fs.writeFile(path.join(root,'tmp/presentation',run.runId+'.json'),JSON.stringify(run,null,2));}
export function presentationRun(runId){const run=runs.get(runId);if(!run)throw Error('Unknown run (runs do not auto-resume after orchestrator restart)');return run;}
export async function controlPresentation({runId,action}){
 const r=presentationRun(runId);if(['COMPLETED','FAILED','CANCELLED'].includes(r.status))throw Error('Run has ended');
 if(action==='PAUSE'&&r.status==='RUNNING'){r.status='PAUSED';r.pausedAt=Date.now();}
 else if(action==='RESUME'&&r.status==='PAUSED'){r.pausedMs+=Date.now()-r.pausedAt;r.status='RUNNING';}
 else if(action==='CANCEL')r.status='CANCELLING';else throw Error('Invalid control transition');
 await store(r);return r;
}
export async function playPresentation(input,{send=bridge}={}){
 const plan=await validatePresentation(input);
 if(active)throw Error('Another presentation is active');
 const r={runId:randomUUID(),status:'RUNNING',stepIndex:0,startedAt:Date.now(),pausedMs:0,events:[],plan};runs.set(r.runId,r);active=r.runId;await store(r);
 void execute(r,send);return r;
}
async function execute(r,send){
 let openView=null;
 try{
  // Protect against changes between validation and start.
  for(const [id,hash] of Object.entries(r.plan.hashes))if((await diagramIndex(await view(id))).digest!==hash)throw Error('Diagram changed after validation');
  for(const [index,step] of r.plan.steps.entries()){
   while(r.status==='PAUSED'||(r.status==='RUNNING'&&Date.now()-r.startedAt-r.pausedMs<step.atMs))await new Promise(resolve=>setTimeout(resolve,30));
   if(r.status==='CANCELLING')break;
   const v=step.view,owner=v.sceneId?'graph-scene:'+v.sceneId:v.rootStableId;
   if(openView!==v.id){await send({surface:'editor',action:'openDiagram',functionStableId:owner,filePath:v.file});openView=v.id;}
   if(r.status==='CANCELLING')break;
   const payload={surface:'diagram',functionStableId:owner,stableId:step.stableId,cellId:step.cellId,durationMs:step.durationMs??600};
   let result;
   if(step.action==='OPEN')result={opened:v.id};
   else if(step.action==='OPEN_CODE')result=await send({...payload,surface:'editor',action:'openSource',filePath:v.file,placement:step.placement});
   else if(['FOCUS','POINTER'].includes(step.action))result=await send({...payload,action:step.action==='FOCUS'?'presentFocus':'presentPointer',pointerId:step.pointerId||'narrator'});
   else {
    let s=await readScene(v.sceneId);s=await mutateScene({...step,sceneId:v.sceneId,expectedRevision:s.revision,action:step.action.toLowerCase(),direction:step.direction?.toLowerCase()});
    result=await send({...payload,action:'sceneSync',xml:renderScene(s)});
   }
   r.stepIndex=index+1;r.events.push({step:index,action:step.action,viewId:v.id,stableId:step.stableId,atMs:Date.now()-r.startedAt-r.pausedMs,result});await store(r);
  }
  r.status=r.status==='CANCELLING'?'CANCELLED':'COMPLETED';
 }catch(e){r.status='FAILED';r.error=e.message;}finally{active=null;await store(r);}
}
