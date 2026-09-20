import fs from 'node:fs';
import assert from 'node:assert/strict';
import {auraConnection} from './fisherYatesConfig.mjs';

const file=process.argv[2];assert(file,'Expected extracted payload');
const payload=JSON.parse(fs.readFileSync(file,'utf8'));
const types=new Set(['SIGNATURE_PARAMETER','SIGNATURE_RETURN','BODY_ENTRY','RETURN_TYPE_ARGUMENT']);
const edges=payload.edges.filter(e=>types.has(e.type));
const nodes=payload.nodes.filter(n=>n.labels.some(l=>['ReturnType','ReturnTypeArgument'].includes(l)));
const newIds=new Set(nodes.map(n=>n.stableId.value));
const required=[...new Set(edges.flatMap(e=>[e.fromId,e.toId]))].filter(id=>!newIds.has(id));
const {driver,session}=auraConnection();
try{
  const result=await session.run('MATCH (n) WHERE n.stableId IN $ids RETURN n.stableId AS id,properties(n) AS props',{ids:required});
  const found=result.records.map(r=>r.get('id'));
  assert.equal(found.length,required.length,'Signature endpoints missing or ambiguous in Aura; no writes performed');
  assert.equal(new Set(found).size,found.length,'Duplicate stableId in Aura');
  const old=await session.run('MATCH (a)-[r]->(b) WHERE a.stableId IN $ids AND b.stableId IN $ids RETURN a.stableId AS fromId,b.stableId AS toId,type(r) AS type,properties(r) AS props',{ids:[...required,...newIds]});
  if(!process.argv.includes('--apply')){
    console.log(JSON.stringify({ready:true,existingEndpoints:found.length,signatureNodes:nodes.length,signatureEdges:edges.length,existingEdges:old.records.map(r=>({from:r.get('fromId'),to:r.get('toId'),type:r.get('type')}))}));
  }else{
    fs.writeFileSync('tmp/model-stub/signature-aura-before.json',JSON.stringify({nodes:result.records.map(r=>r.toObject()),edges:old.records.map(r=>r.toObject())},null,2));
    const anchor=result.records[0].get('props');
    await session.executeWrite(async tx=>{
      for(const node of nodes){
        const sid=node.stableId,labels=[...new Set(['CodeEntity',...node.labels])];
        assert(labels.every(l=>/^[A-Za-z][A-Za-z0-9_]*$/.test(l)));
        const props={stableId:sid.value,parentFnStableId:node.parentFnStableId?.value,source:anchor.source||'semantic/functionFlowGraph',graphScope:anchor.graphScope||null,
          repo_relative_path:sid.repoRelativePath,file_path:sid.filePath,start_line:sid.startLine,start_column:sid.startColumn,end_line:sid.endLine,end_column:sid.endColumn,
          diaName:node.diaName,action_text_raw:node.actionTextRaw||node.diaName,signatureDeclaration:true};
        await tx.run(`MERGE (n:CodeEntity {stableId:$id}) SET n:${labels.join(':')} SET n += $props`,{id:sid.value,props});
      }
      const last=edges.find(e=>e.type==='SIGNATURE_RETURN'),body=edges.find(e=>e.type==='BODY_ENTRY'&&e.fromId===last?.toId);
      // Delete only superseded links with exact endpoints, never an entire function.
      const obsolete=edges.filter(e=>e.type==='SIGNATURE_PARAMETER').map(e=>({from:e.fromId,to:e.toId}));
      if(last&&body)obsolete.push({from:last.fromId,to:body.toId});
      await tx.run('UNWIND $pairs AS p MATCH (a {stableId:p.from})-[r:NEXT]->(b {stableId:p.to}) DELETE r',{pairs:obsolete});
      for(const edge of edges){
        await tx.run(`MATCH (a {stableId:$from}),(b {stableId:$to}) MERGE (a)-[r:${edge.type}]->(b) SET r.semanticExpansion='function-signature', r.flowLayer=$layer, r.argumentIndex=$index`,{
          from:edge.fromId,to:edge.toId,layer:edge.type==='BODY_ENTRY'?'control':'data',index:edge.argumentIndex??null,
        });
      }
    });
    const check=await session.run('MATCH (a)-[r]->(b) WHERE a.stableId IN $ids AND b.stableId IN $ids AND type(r) IN $types RETURN type(r) AS type,count(*) AS count',{ids:[...required,...newIds],types:[...types]});
    console.log(JSON.stringify({updated:true,nodes:nodes.length,edges:check.records.map(r=>({type:r.get('type'),count:r.get('count').toNumber()}))}));
  }
}finally{await session.close();await driver.close();}
