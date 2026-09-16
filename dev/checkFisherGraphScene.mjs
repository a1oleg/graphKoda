// Actual Fisher diagrams and Aura graph; no fabricated graph or diagram XML.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {executeAnnotationGraphql} from '../graph/packages/orchestrator/src/orchestrator/annotationGraphql.js';
const gql=async(query,variables)=>{
 const result=await executeAnnotationGraphql({query,variables},{});
 assert(!result.errors,JSON.stringify(result.errors));return result.data;
};
const variables=JSON.parse(await fs.readFile('graph/presentation/fisher.variables.json','utf8'));
await gql('mutation($input:PresentationInput!){validatePresentation(input:$input)}',variables);
const data=await gql('query($id:ID!){codeEntity(stableId:$id){stableId representations{viewId cellId}}}',{id:'examples/fisher-yates/src/shuffle.ts:35:0:38:1'});
assert.equal(data.codeEntity.representations.length,3);
assert(data.codeEntity.representations.some(r=>r.viewId==='fisher-flow'&&r.cellId==='f1-block'));
console.log(JSON.stringify(data));
const inspector=new Client({name:'fisher-scene-geometry',version:'1.0.0'});
try{
 await inspector.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('../drawio-inspector/src/mcp.mjs')]}));
 for(const scene of ['fisher','fisher-detail']){
  const result=await inspector.callTool({name:'validate_geometry',arguments:{file:path.resolve(`graph/draw/scenes/${scene}.drawio`),mode:'rendered',limit:100}});
  assert(!result.isError,JSON.stringify(result.content));
  await fs.mkdir('tmp/graph-scene',{recursive:true});
  await fs.writeFile(`tmp/graph-scene/${scene}-geometry.json`,JSON.stringify(result.structuredContent,null,2));
  console.log(JSON.stringify({scene,...result.structuredContent}));
  assert(!result.structuredContent.findings.some(f=>f.severity!=='info'),'Fix geometry findings');
 }
}finally{await inspector.close();}
