import fs from 'node:fs';
import assert from 'node:assert/strict';
import {DOMParser, XMLSerializer} from '@xmldom/xmldom';

const file = new URL('../graph/draw/generated/queryModel.drawio', import.meta.url);
const doc = new DOMParser().parseFromString(fs.readFileSync(file,'utf8'),'text/xml');
const cells = [...doc.getElementsByTagName('mxCell')];
const byId = new Map(cells.map(c=>[c.getAttribute('id'),c]));
// Fixed local scenario: stub enabled; reply comes from the fallback literal.
const ids = Array.from({length:26},(_,i)=>`f0-e${i+1}`).filter(id=>!['f0-e9','f0-e20'].includes(id));
const edgePairs = ids.map(id=>{
  const edge=byId.get(id);assert(edge?.getAttribute('edge')==='1',id);
  assert(!['CALLS','FALSE'].includes(edge.getAttribute('edgeType')) || id==='f0-e21');
  return {cellId:id,sourceStableId:edge.getAttribute('stableId'),targetStableId:edge.getAttribute('targetStableId'),edgeType:edge.getAttribute('edgeType'),weight:1};
});
const selection={version:1,kind:'embedded-scenario',edgePairs,nodeHighlights:[
  {stableId:byId.get('f0-e8').getAttribute('stableId'),role:'predicate-stage',outcome:true},
  {stableId:byId.get('f0-e21').getAttribute('stableId'),role:'predicate-stage',outcome:false},
]};
assert(edgePairs.at(-1).targetStableId.endsWith(':return'));
byId.get('f0-block').setAttribute('embeddedRuntimeTrace',JSON.stringify(selection));
fs.writeFileSync(file,new XMLSerializer().serializeToString(doc),'utf8');
console.log(JSON.stringify({edges:edgePairs.length,externalCalls:0,endsAt:edgePairs.at(-1).targetStableId}));
