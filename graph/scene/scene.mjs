// A scene is a small, explicitly selected projection, never a replacement graph.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import dotenv from 'dotenv';
import neo4j from 'neo4j-driver';
import {DOMParser} from '@xmldom/xmldom';
import {methodMosaicImage} from '../../dev/localCoordinateDrawio.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const directory=path.join(root,'graph/draw/scenes');
const idFor=(prefix,id)=>prefix+createHash('sha256').update(id).digest('hex').slice(0,24);
const xml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
function paths(id) {
 if(!/^[a-zA-Z0-9_-]{1,64}$/.test(id))throw Error('Invalid sceneId');
 return {file:path.join(directory,id+'.drawio'),state:path.join(directory,id+'.scene.json')};
}
export async function query(profile,cypher,params={}) {
 const env=dotenv.parse(await fs.readFile(path.join(root,'graph/.env')));
 const prefix=profile==='aura'?'AURA_':'';
 const uri=env[prefix+'NEO4J_URI'];if(!uri)throw Error('Database profile not configured');
 const driver=neo4j.driver(uri,neo4j.auth.basic(env[prefix+'NEO4J_USERNAME']||env[prefix+'NEO4J_USER']||'neo4j',env[prefix+'NEO4J_PASSWORD']),{connectionTimeout:5000});
 const session=driver.session({database:env[prefix+'NEO4J_DATABASE']||'neo4j',defaultAccessMode:neo4j.session.READ});
 try{return (await session.executeRead(tx=>tx.run(cypher,params),{timeout:10000})).records.map(r=>r.toObject());}
 finally{await session.close();await driver.close();}
}
function node(n) {
 const p=n.properties;
 if(!p.stableId)throw Error('Node has no stableId');
 return {stableId:p.stableId,cellId:idFor('n-',p.stableId),labels:n.labels,
  title:String(p.name||p.label||p.contextTitle||p.stableId),x:0,y:0,width:250,height:76};
}
function edge(r,a,b) {return {id:r.elementId,cellId:idFor('e-',r.elementId),type:r.type,from:a.properties.stableId,to:b.properties.stableId};}
function finite(n){if(!Number.isFinite(n)||Math.abs(n)>100000)throw Error('Invalid diagram coordinate');return n;}
export async function readScene(sceneId) {
 const p=paths(sceneId);const s=JSON.parse(await fs.readFile(p.state,'utf8'));
 // Read actual draw.io coordinates, including manual moves made in its editor.
 const doc=new DOMParser().parseFromString(await fs.readFile(p.file,'utf8'),'text/xml');
 for(const n of Object.values(s.nodes)){
  const object=Array.from(doc.getElementsByTagName('object')).find(e=>e.getAttribute('id')===n.cellId);
  if(!object)throw Error('Scene structure edited outside controller: '+n.cellId);
  const g=object.getElementsByTagName('mxGeometry')[0];
  for(const k of ['x','y','width','height'])n[k]=finite(Number(g.getAttribute(k)));
 }
 return {...s,file:p.file,coordinateSpace:'draw.io model units; x/y are top-left; no screen pixels'};
}
export function renderScene(s) {
 const cells=Object.values(s.nodes).map(n=>{
  const isCall=n.labels.includes('Call');
  const role=!isCall&&n.labels.includes('FunctionImplementation')?'реализация':'';
  const title=isCall&&!n.title.endsWith(')')?n.title+'()':n.title;
  const label=xml(title+(role?'\n'+role:'')).replaceAll('\n','&#10;');
  const fill=n.labels.includes('Call')?'#007FFF':n.labels.includes('FunctionImplementation')?'#004C54':n.labels.includes('System')?'#eeeeee':'#d5e8d4';
  const font=['#007FFF','#004C54'].includes(fill)?'#ffffff':'#1f2937';
  const style=isCall
   ? `shape=image;imageAspect=0;image=${methodMosaicImage('single','#DAE8FC','#007FFF',{width:n.width})};whiteSpace=wrap;html=0;labelPosition=center;align=center;verticalLabelPosition=middle;verticalAlign=middle;spacing=4;fontSize=18;fontColor=#000000;`
   : `rounded=1;arcSize=20;whiteSpace=wrap;html=0;fontSize=18;fillColor=${fill};fontColor=${font};strokeColor=${fill};`;
  return `<object id="${n.cellId}" stableId="${xml(n.stableId)}" label="${label}" labels="${xml(n.labels.join(' '))}"><mxCell vertex="1" parent="1" style="${xml(style)}"><mxGeometry x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" as="geometry"/></mxCell></object>`;
 });
 for(const e of Object.values(s.edges)){
  const from=s.nodes[e.from],to=s.nodes[e.to];
  const branch=e.type==='AST_CHILD'&&from.labels.includes('FunctionImplementation')&&to.x>from.x+from.width&&to.y>from.y+from.height;
  const ports=branch?'exitX=0.5;exitY=1;entryX=0;entryY=0.5;':to.x>from.x+from.width?'exitX=1;exitY=0.5;entryX=0;entryY=0.5;':'';
  const points=branch?`<Array as="points"><mxPoint x="${from.x+from.width/2}" y="${to.y+to.height/2}"/></Array>`:'';
  cells.push(`<object id="${e.cellId}" relationshipId="${xml(e.id)}" label="${xml(e.type)}"><mxCell edge="1" parent="1" source="${from.cellId}" target="${to.cellId}" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=0;endArrow=block;fontSize=12;labelBackgroundColor=#ffffff;strokeColor=#64748b;${ports}"><mxGeometry relative="1" as="geometry">${points}</mxGeometry></mxCell></object>`);
 }
 for(const [id,p] of Object.entries(s.pointers))cells.push(`<mxCell id="pointer-${id}" edge="1" parent="1" style="endArrow=classic;endFill=1;strokeColor=#e53935;strokeWidth=4;"><mxGeometry relative="1" as="geometry"><mxPoint x="${p.x+42}" y="${p.y+55}" as="sourcePoint"/><mxPoint x="${p.x}" y="${p.y}" as="targetPoint"/></mxGeometry></mxCell>`);
 for(const a of s.snippets||[]){
  const owner=s.nodes[a.ownerStableId];if(!owner||a.order>(s.annotationStep??0))continue;
  const label=xml(a.text).replaceAll('\n','&#10;');
  cells.push(`<object id="snippet-${a.id}" label="${label}" annotationOwnerStableId="${xml(a.ownerStableId)}" revealOrder="${a.order}" annotationSource="authored-scene-snippet"><mxCell vertex="1" parent="1" style="rounded=1;arcSize=10;whiteSpace=wrap;html=0;align=left;verticalAlign=top;spacing=12;fontSize=16;fontColor=#173b3e;fillColor=#f0f7f5;strokeColor=#7ea59d;"><mxGeometry x="${owner.x+owner.width+24}" y="${owner.y}" width="${a.width}" height="${a.height}" as="geometry"/></mxCell></object>`);
 }
 return `<mxfile><diagram id="${s.sceneId}" name="Graph scene"><mxGraphModel page="1" pageWidth="1600" pageHeight="900" grid="0" graphSceneId="${s.sceneId}"><root><mxCell id="0"/><object id="1" graphSceneId="${s.sceneId}" label=""><mxCell parent="0"/></object>${cells.join('')}</root></mxGraphModel></diagram></mxfile>`;
}
async function save(s,action) {
 const p=paths(s.sceneId);s.revision++;s.history.push({revision:s.revision,at:new Date().toISOString(),...action});
 await fs.mkdir(directory,{recursive:true});
 await fs.writeFile(p.file+'.tmp',renderScene(s));await fs.rename(p.file+'.tmp',p.file);
 await fs.writeFile(p.state+'.tmp',JSON.stringify(s,null,2));await fs.rename(p.state+'.tmp',p.state);
 return readScene(s.sceneId);
}
export async function createScene({sceneId,rootStableId,profile='aura',x=675,y=80}) {
 const p=paths(sceneId);try{await fs.access(p.file);throw Error('Scene already exists');}catch(e){if(e.code!=='ENOENT')throw e;}
 const rows=await query(profile,'MATCH (n {stableId:$id}) RETURN n LIMIT 2',{id:rootStableId});
 if(rows.length!==1)throw Error('Root missing or ambiguous');
 const n={...node(rows[0].n),x:finite(x),y:finite(y)};
 return save({sceneId,rootStableId,profile,revision:0,nodes:{[rootStableId]:n},edges:{},pointers:{},history:[]},{action:'create',rootStableId});
}
export async function neighbors({sceneId,stableId,direction,types,limit=30}) {
 const s=await readScene(sceneId);if(!s.nodes[stableId])throw Error('Expand source is not visible');
 if(!['out','in'].includes(direction)||!types?.length)throw Error('Explicit direction and relationship types required');
 const pattern=direction==='out'?'(n)-[r]->(m)':'(n)<-[r]-(m)';
 const rows=await query(s.profile,`MATCH ${pattern} WHERE n.stableId=$id AND type(r) IN $types
 AND m.stableId IS NOT NULL RETURN n,r,m ORDER BY m.stableId,elementId(r) LIMIT $limit`,{id:stableId,types,limit:neo4j.int(limit+1)});
 return {sceneId,revision:s.revision,truncated:rows.length>limit,candidates:rows.slice(0,limit).map(v=>({node:node(v.m),edge:direction==='out'?edge(v.r,v.n,v.m):edge(v.r,v.m,v.n)}))};
}
export async function mutateScene(input) {
 const s=await readScene(input.sceneId);
 if(s.revision!==input.expectedRevision)throw Error('Scene revision changed; read before retrying');
 if(input.action==='expand'){
  // Exact targets AND relation kinds AND direction; never enumerate a whole subgraph.
  if(!input.targets?.length||input.targets.length>20)throw Error('Choose 1..20 explicit target stableIds');
  if(!s.nodes[input.stableId]||!['out','in'].includes(input.direction)||!input.types?.length)throw Error('Invalid expansion');
  const pattern=input.direction==='out'?'(n)-[r]->(m)':'(n)<-[r]-(m)';
  const rows=await query(s.profile,`MATCH ${pattern} WHERE n.stableId=$id AND type(r) IN $types AND m.stableId IN $targets RETURN n,r,m LIMIT 201`,{id:input.stableId,types:input.types,targets:input.targets});
  if(rows.length>200||input.targets.some(id=>!rows.some(r=>r.m.properties.stableId===id)))throw Error('Expansion missing targets or too large');
  const parent=s.nodes[input.stableId];
  for(const v of rows){const n=node(v.m);if(!s.nodes[n.stableId]){
   let x=parent.x+parent.width+180,y=parent.y+180;
   while(Object.values(s.nodes).some(o=>x<o.x+o.width+30&&x+n.width+30>o.x&&y<o.y+o.height+30&&y+n.height+30>o.y))y+=180;
   s.nodes[n.stableId]={...n,x,y};
  }
  const e=input.direction==='out'?edge(v.r,v.n,v.m):edge(v.r,v.m,v.n);s.edges[e.id]=e;}
 }else if(input.action==='move'){
  for(const p of input.positions){if(!s.nodes[p.stableId])throw Error('Unknown node');Object.assign(s.nodes[p.stableId],{x:finite(p.x),y:finite(p.y)});}
 }else if(input.action==='hide'){
  if(input.targets.includes(s.rootStableId))throw Error('Cannot hide root');
  for(const id of input.targets)delete s.nodes[id];
  for(const [id,e] of Object.entries(s.edges))if(!s.nodes[e.from]||!s.nodes[e.to])delete s.edges[id];
 }else if(input.action==='annotations'){
  if(input.snippets){
   const ids=new Set(),orders=new Set();
   for(const a of input.snippets){
    if(!/^[a-zA-Z0-9_-]{1,40}$/.test(a.id)||ids.has(a.id)||orders.has(a.order)||!s.nodes[a.ownerStableId]||!Number.isInteger(a.order)||a.order<1||!a.text?.trim())throw Error('Invalid annotation snippet');
    if(!(a.width>=200&&a.width<=1000&&a.height>=60&&a.height<=1000))throw Error('Invalid snippet dimensions');
    ids.add(a.id);orders.add(a.order);
   }
   s.snippets=input.snippets;
  }
  if(!Number.isInteger(input.visibleThrough)||input.visibleThrough<0)throw Error('Invalid annotation reveal step');
  s.annotationStep=input.visibleThrough;
 }else if(input.action==='pointer'){
  if(!/^[a-zA-Z0-9_-]{1,40}$/.test(input.pointerId))throw Error('Invalid pointer id');
  if(input.visible===false)delete s.pointers[input.pointerId];else{
   const n=s.nodes[input.stableId];
   if(input.stableId&&!n)throw Error('Pointer target is not visible');
   const x=n?n.x+n.width*(input.u??.5):input.x,y=n?n.y+n.height*(input.v??.5):input.y;
   s.pointers[input.pointerId]={x:finite(x),y:finite(y)};
  }
 }else throw Error('Unknown action');
 return save(s,input);
}
export async function liveCommand(sceneId,action,extra={}) {
 paths(sceneId);
 const token=(await fs.readFile(path.join(root,'tmp/graph-demo-token.local'),'utf8')).trim();
 const response=await fetch('http://127.0.0.1:17843/demo/step',{method:'POST',signal:AbortSignal.timeout(18000),headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({surface:'diagram',functionStableId:'graph-scene:'+sceneId,action,...extra})});
 const result=await response.json();if(!response.ok)throw Error(result.error||'Scene bridge failed');return result;
}
export async function syncScene(sceneId){const s=await readScene(sceneId);return liveCommand(sceneId,'sceneSync',{xml:renderScene(s)});}
