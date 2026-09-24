import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {DOMParser} from '@xmldom/xmldom';
test('embedded stub trace toggles without fetching runtime data',()=>{
  const doc=new DOMParser().parseFromString(fs.readFileSync('graph/draw/generated/queryModel.drawio','utf8'),'text/xml');
  const cells=Object.fromEntries([...doc.getElementsByTagName('mxCell')].map(c=>[c.getAttribute('id'),c]));
  const plugin=fs.readFileSync('graph/vendor/drawio/src/main/webapp/plugins/codexGraph.js','utf8');
  const start=plugin.indexOf('  function toggleRuntimeTrace(cell) {');
  const end=plugin.indexOf('  function clearRuntimeValues()',start);
  let selection,cleared=false;
  const ctx={model:{cells,getCell:id=>cells[id]},getAttribute:(c,k)=>c.getAttribute(k),runtimeTraceActive:false,
    runtimeHighlight:s=>{selection=s;},clearRuntimeHighlight:()=>{cleared=true;ctx.runtimeTraceActive=false;},
    ui:{handleError:e=>{throw e;}},fetch:()=>{throw Error('Unexpected network request');}};
  vm.createContext(ctx);vm.runInContext(plugin.slice(start,end),ctx);
  ctx.toggleRuntimeTrace(cells['f0-n8']);
  assert.equal(selection.edgePairs.length,24);
  assert(selection.edgePairs.some(p=>p.cellId==='f0-e8'&&p.edgeType==='TRUE'));
  assert(!selection.edgePairs.some(p=>p.cellId==='f0-e9'||p.edgeType==='CALLS'||!p.cellId.startsWith('f0-')));
  assert(selection.edgePairs.at(-1).targetStableId.endsWith(':return'));
  assert.equal(ctx.runtimeTraceActive,true);
  ctx.toggleRuntimeTrace(cells['f0-n8']);assert(cleared);
});
