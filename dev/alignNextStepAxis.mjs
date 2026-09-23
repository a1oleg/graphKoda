import fs from 'node:fs';
import {DOMParser,XMLSerializer} from '@xmldom/xmldom';
import {pathToFileURL} from 'node:url';
export function alignNextStepAxis(xml,startId,count=4){
 const doc=new DOMParser().parseFromString(xml,'text/xml');
 const cells=Array.from(doc.getElementsByTagName('mxCell')),byId=new Map(cells.map(c=>[c.getAttribute('id'),c]));
 const g=c=>Array.from(c?.childNodes||[]).find(n=>n.nodeName==='mxGeometry');
 const parent=c=>byId.get(c?.getAttribute('parent'));
 const x=c=>c?Number(g(c)?.getAttribute('x')||0)+x(parent(c)):0;
 const center=c=>x(c)+Number(g(c)?.getAttribute('width')||0)/2;
 const row=c=>{for(;c;c=parent(c))if(/fold-row-/.test(c.getAttribute('id')))return c;};
 let current=byId.get(startId);if(!current)throw Error('Missing start');
 const axis=center(current),changed=[];
 for(let i=0;i<count;i++){
  const links=cells.filter(e=>e.getAttribute('edgeType')==='NEXT'&&e.getAttribute('source')===current.getAttribute('id'));
  if(links.length!==1)throw Error('Expected an unbranched NEXT chain');
  const edge=links[0],next=byId.get(edge.getAttribute('target')),r=row(next);
  if(!r||r===row(current))throw Error('Expected separate step rows');
  const delta=axis-center(next);g(r).setAttribute('x',String(Number(g(r).getAttribute('x')||0)+delta));
  // NEXT links enter/leave the step heads at the central vertical ports.
  const style=(edge.getAttribute('style')||'').replace(/(?:exitX|exitY|entryX|entryY)=[^;]*;/g,'');
  edge.setAttribute('style',style+'exitX=0.5;exitY=1;entryX=0.5;entryY=0;');
  if(Math.abs(center(next)-axis)>.001)throw Error('Axis mismatch');
  changed.push({id:next.getAttribute('id'),dx:delta,axis});current=next;
 }
 return {xml:new XMLSerializer().serializeToString(doc),changed};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const file=process.argv[2],r=alignNextStepAxis(fs.readFileSync(file,'utf8'),process.argv[3],Number(process.argv[4]||4));
 fs.writeFileSync(file,r.xml);console.log(JSON.stringify(r.changed));
}
