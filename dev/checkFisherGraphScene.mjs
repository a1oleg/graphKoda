// Integration check on the actual Fisher graph in Aura; no fabricated nodes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const client=new Client({name:'fisher-scene-check',version:'1.0.0'});
const transcript=[];
async function call(name,args){const r=await client.callTool({name,arguments:args});assert(!r.isError,JSON.stringify(r.content));const v=r.structuredContent;transcript.push({name,args,result:v});return v;}
try{
 await client.connect(new StdioClientTransport({command:process.execPath,args:['graph/scene/mcp.mjs']}));
 let s=await call('scene_read',{sceneId:'fisher'});const root=s.rootStableId;
 const origin={x:s.nodes[root].x,y:s.nodes[root].y};
 const candidates=await call('scene_neighbors',{sceneId:'fisher',stableId:root,direction:'out',types:['AST_CHILD'],limit:30});
 const calls=candidates.candidates.filter(c=>['getRandom','swap'].includes(c.node.title)&&c.node.labels.includes('Call'));
 assert.equal(calls.length,2);
 s=await call('scene_expand',{sceneId:'fisher',expectedRevision:s.revision,stableId:root,direction:'out',types:['AST_CHILD'],targets:calls.map(c=>c.node.stableId)});
 assert.deepEqual({x:s.nodes[root].x,y:s.nodes[root].y},origin);
 const implementations=[];
 for(const c of calls){
  const n=await call('scene_neighbors',{sceneId:'fisher',stableId:c.node.stableId,direction:'out',types:['CALLS'],limit:10});
  assert.equal(n.candidates.length,1);implementations.push(n.candidates[0].node);
  s=await call('scene_expand',{sceneId:'fisher',expectedRevision:s.revision,stableId:c.node.stableId,direction:'out',types:['CALLS'],targets:[n.candidates[0].node.stableId]});
 }
 const positions=[{stableId:root,x:675.25,y:80.5},...calls.map((c,i)=>({stableId:c.node.stableId,x:360+i*600,y:300})),...implementations.map((n,i)=>({stableId:n.stableId,x:360+i*600,y:520}))];
 s=await call('scene_move',{sceneId:'fisher',expectedRevision:s.revision,positions});
 assert.equal(s.nodes[root].x,675.25);assert.equal(s.nodes[root].y,80.5);
 const region=await call('scene_region',{sceneId:'fisher',x:700,y:100,width:1,height:1});assert.deepEqual(region.nodes.map(n=>n.stableId),[root]);
 const back=await call('scene_neighbors',{sceneId:'fisher',stableId:implementations[0].stableId,direction:'in',types:['CALLS'],limit:1});
 assert(back.candidates.some(c=>c.edge.to===implementations[0].stableId));
 const old=s.revision;
 s=await call('scene_pointer',{sceneId:'fisher',expectedRevision:s.revision,pointerId:'narrator',stableId:root,u:1,v:1});
 assert.equal(s.pointers.narrator.x,925.25);
 const stale=await client.callTool({name:'scene_move',arguments:{sceneId:'fisher',expectedRevision:old,positions:[{stableId:root,x:0,y:0}]}});assert(stale.isError);
 await fs.mkdir('tmp/graph-scene',{recursive:true});await fs.writeFile('tmp/graph-scene/mcp-check.json',JSON.stringify(transcript,null,2));
 console.log(JSON.stringify({nodes:Object.keys(s.nodes).length,edges:Object.keys(s.edges).length,revision:s.revision,decimalCoordinates:true,incomingQuery:true,staleRevisionRejected:true,file:s.file}));
}finally{await client.close();}
const inspector=new Client({name:'fisher-scene-geometry',version:'1.0.0'});
try{
 await inspector.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('../drawio-inspector/src/mcp.mjs')]}));
 const r=await inspector.callTool({name:'validate_geometry',arguments:{file:path.resolve('graph/draw/scenes/fisher.drawio'),mode:'rendered',limit:100}});
 assert(!r.isError,JSON.stringify(r.content));await fs.writeFile('tmp/graph-scene/geometry.json',JSON.stringify(r.structuredContent,null,2));
 console.log(JSON.stringify(r.structuredContent));assert(!r.structuredContent.findings.some(f=>f.severity!=='info'),'Fix geometry findings');
}finally{await inspector.close();}
