import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {projectSignatureLayout} from '../graph/packages/orchestrator/src/orchestrator/signatureLayout.js';

test('actual extracted queryModel signature: typed graph and layout adapter stay separate',()=>{
  const p=JSON.parse(fs.readFileSync('tmp/model-stub/queryModel-signature.json','utf8'));
  const types=new Set(['SIGNATURE_PARAMETER','SIGNATURE_RETURN','RETURN_TYPE_ARGUMENT','BODY_ENTRY']);
  const edges=p.edges.filter(e=>types.has(e.type));
  assert.equal(edges.filter(e=>e.type==='SIGNATURE_PARAMETER').length,6);
  assert.equal(edges.filter(e=>e.type==='SIGNATURE_RETURN').length,1);
  assert.equal(edges.filter(e=>e.type==='RETURN_TYPE_ARGUMENT').length,2);
  const ret=p.nodes.find(n=>n.labels.includes('ReturnType'));
  assert.equal(ret.diaName,'AsyncGenerator');assert(ret.labels.includes('System'));
  for(const edge of edges.filter(e=>e.type==='SIGNATURE_PARAMETER'))assert(!p.edges.some(e=>e.type==='NEXT'&&e.fromId===edge.fromId&&e.toId===edge.toId));
  const nodes=p.nodes.map(n=>({key:n.stableId.value,labels:n.labels,props:n}));
  const semantic=edges.map(e=>({start:e.fromId,end:e.toId,type:e.type,props:e}));
  const before=JSON.stringify(semantic),layout=projectSignatureLayout(nodes,semantic);
  assert.equal(JSON.stringify(semantic),before,'Projection must not mutate stored semantic types');
  assert.equal(layout.edges.length,7);
  assert(layout.edges.every(e=>e.type==='NEXT'));
  assert(!layout.nodes.some(n=>n.labels.includes('ReturnType')));
});
