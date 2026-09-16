#!/usr/bin/env node
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {createScene,readScene,neighbors,mutateScene,syncScene,liveCommand} from './scene.mjs';
const server=new McpServer({name:'coldkode-graph-scene',version:'0.1.0'},{instructions:'Read scene first and use its revision for mutations. List neighbors before selecting exact targets; never invent graph edges. Coordinates are draw.io model units. Save manual editor changes before file mutations, then scene_sync the matching open scene. Neo4j access is read-only. Use one controller per scene. This is graph presentation, not evidence of an annotator run.'});
const base={sceneId:z.string()}, revision={...base,expectedRevision:z.number().int().min(1)};
const direction=z.enum(['in','out']),types=z.array(z.string().min(1)).min(1).max(20);
const coord=z.number().finite().min(-100000).max(100000);
let queue=Promise.resolve();
function tool(name,description,schema,fn,readOnly=false){server.registerTool(name,{description,inputSchema:schema,annotations:{readOnlyHint:readOnly,destructiveHint:false,openWorldHint:false}},args=>{
 const run=queue.then(async()=>{try{const result=await fn(args);return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};}catch(e){return {isError:true,content:[{type:'text',text:e.message}]};}});queue=run.catch(()=>{});return run;
});}
tool('scene_create','Create a draw.io scene with exactly one real Neo4j node. Never modifies Neo4j.',{...base,rootStableId:z.string(),profile:z.enum(['aura','local']).default('aura'),x:coord.default(675),y:coord.default(80)},createScene);
tool('scene_read','Read node coordinates, actual edges, pointers and revision from the saved diagram.',base,a=>readScene(a.sceneId),true);
tool('scene_region','Read nodes intersecting a model-coordinate rectangle; no screenshot or pixel recognition.',{...base,x:coord,y:coord,width:z.number().positive().max(100000),height:z.number().positive().max(100000)},async a=>{
 const s=await readScene(a.sceneId),nodes=Object.values(s.nodes).filter(n=>n.x<=a.x+a.width&&n.x+n.width>=a.x&&n.y<=a.y+a.height&&n.y+n.height>=a.y);
 const ids=new Set(nodes.map(n=>n.stableId));return {sceneId:a.sceneId,revision:s.revision,nodes,edges:Object.values(s.edges).filter(e=>ids.has(e.from)||ids.has(e.to))};
},true);
tool('scene_neighbors','List candidates without expanding. Requires explicit edge types and direction; reports truncation.',{...base,stableId:z.string(),direction,types,limit:z.number().int().min(1).max(100).default(30)},neighbors,true);
tool('scene_expand','Add only selected one-hop targets over specified actual relations. Existing coordinates stay fixed.',{...revision,stableId:z.string(),direction,types,targets:z.array(z.string()).min(1).max(20)},a=>mutateScene({...a,action:'expand'}));
tool('scene_move','Place visible nodes at precise decimal draw.io model coordinates, not screen pixels.',{...revision,positions:z.array(z.object({stableId:z.string(),x:coord,y:coord})).min(1).max(100)},a=>mutateScene({...a,action:'move'}));
tool('scene_hide','Hide selected nodes and incident visible edges; never deletes database facts.',{...revision,targets:z.array(z.string()).min(1).max(100)},a=>mutateScene({...a,action:'hide'}));
tool('scene_pointer','Move a named pointer to a node anchor or exact model coordinates. Optional smooth live movement in open draw.io.',{...revision,pointerId:z.string(),stableId:z.string().optional(),u:z.number().min(0).max(1).optional(),v:z.number().min(0).max(1).optional(),x:coord.optional(),y:coord.optional(),visible:z.boolean().default(true),live:z.boolean().default(false),durationMs:z.number().int().min(0).max(5000).default(600)},async a=>{
 const s=await mutateScene({...a,action:'pointer'});
 if(a.live){try{s.live=await liveCommand(a.sceneId,'scenePointer',{pointerId:a.pointerId,pointer:s.pointers[a.pointerId]||null,durationMs:a.durationMs});}catch(e){s.live={error:e.message,saved:true};}}
 return s;
});
tool('scene_sync','Apply saved scene to the matching OPEN draw.io graph scene only. No browser pixel automation.',base,a=>syncScene(a.sceneId));
tool('scene_live_read','Read current open draw.io geometry and camera transform, including unsaved moves.',base,a=>liveCommand(a.sceneId,'sceneRead'),true);
await server.connect(new StdioServerTransport());
