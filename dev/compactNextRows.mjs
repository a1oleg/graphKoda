import {DOMParser,XMLSerializer} from '@xmldom/xmldom';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const geometry=c=>Array.from(c?.childNodes||[]).find(n=>n.nodeName==='mxGeometry');
const num=(c,k)=>Number(geometry(c)?.getAttribute(k)||0);

// Consecutive, single-entry NEXT rows need one content clearance, not the
// sum of two large folding insets. Never compress a branch or a join here.
export function compactNextRows(xml,{cellIds}={}){
 const doc=new DOMParser().parseFromString(xml,'text/xml'),cells=Array.from(doc.getElementsByTagName('mxCell'));
 const byId=new Map(cells.map(c=>[c.getAttribute('id'),c]));
 const parent=c=>byId.get(c?.getAttribute('parent'));
 const row=c=>{for(;c;c=parent(c))if(/^(?:f\d+-)?fold-row-/.test(c.getAttribute('id')))return c;};
 const children=c=>cells.filter(n=>parent(n)===c&&n.getAttribute('vertex')==='1');
 const y=c=>c?num(c,'y')+y(parent(c)):0;
 const changed=[];
 for(const edge of cells){
  if(edge.getAttribute('edge')!=='1'||edge.getAttribute('edgeType')!=='NEXT'||(cellIds&&!cellIds.includes(edge.getAttribute('id'))))continue;
  const a=row(byId.get(edge.getAttribute('source'))),b=row(byId.get(edge.getAttribute('target')));
  if(!a||!b||a===b||parent(a)!==parent(b))continue;
  const rows=children(parent(a)).sort((l,r)=>num(l,'y')-num(r,'y'));
  if(rows.indexOf(b)!==rows.indexOf(a)+1)continue;
  const incoming=cells.filter(e=>e.getAttribute('edge')==='1'&&['NEXT','TRUE','FALSE','REJOINS'].includes(e.getAttribute('edgeType'))&&row(byId.get(e.getAttribute('target')))===b&&row(byId.get(e.getAttribute('source')))!==b);
  if(incoming.length!==1)continue;
  const ca=children(a),cb=children(b);if(!ca.length||!cb.length)continue;
  let bottom=Math.max(...ca.map(c=>num(c,'y')+num(c,'height')));
  // Internal expression return routes are occupied content too.
  for(const e of cells.filter(e=>e.getAttribute('edge')==='1'&&row(byId.get(e.getAttribute('source')))===a&&row(byId.get(e.getAttribute('target')))===a))
   for(const p of Array.from(geometry(e)?.getElementsByTagName('mxPoint')||[]))if(p.getAttribute('as')!=='offset')bottom=Math.max(bottom,y(parent(e))+Number(p.getAttribute('y'))-y(a));
  const inset=Math.min(...cb.map(c=>num(c,'y'))),inside=Math.max(0,inset-12);
  const oldTop=y(b),newHeight=Math.min(num(a,'height'),bottom+12);
  const before=Math.max(0,num(b,'y')-(num(a,'y')+newHeight+8));
  if(before+inside<.1)continue;
  const oldParentY=new Map(cells.map(c=>[c,y(parent(c))]));
  const insideEnd=oldTop+inset;
  const mapY=v=>v>=insideEnd?v-before-inside:v>=oldTop?v-before:v;
  geometry(a).setAttribute('height',String(newHeight));
  geometry(b).setAttribute('y',String(num(b,'y')-before));
  for(const c of cb)geometry(c).setAttribute('y',String(num(c,'y')-inside));
  geometry(b).setAttribute('height',String(num(b,'height')-inside));
  for(const c of rows.slice(rows.indexOf(b)+1))geometry(c).setAttribute('y',String(num(c,'y')-before-inside));
  for(let container=parent(b);container&&geometry(container);container=parent(container))geometry(container).setAttribute('height',String(num(container,'height')-before-inside));
  for(const e of cells.filter(c=>c.getAttribute('edge')==='1')){
   // Only routes attached to this layout; unrelated function blocks stay put.
   const ar=row(byId.get(e.getAttribute('source'))),br=row(byId.get(e.getAttribute('target')));
   if(!rows.includes(ar)&&!rows.includes(br))continue;
   for(const p of Array.from(geometry(e)?.getElementsByTagName('mxPoint')||[])){
    if(p.getAttribute('as')==='offset')continue;
    const old=Number(p.getAttribute('y'))+oldParentY.get(e);
    p.setAttribute('y',String(mapY(old)-y(parent(e))));
   }
  }
  changed.push({edge:edge.getAttribute('id'),reduced:before+inside});
 }
 return {xml:changed.length?new XMLSerializer().serializeToString(doc):xml,changed};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const file=process.argv[2],r=compactNextRows(fs.readFileSync(file,'utf8'),{cellIds:process.argv.slice(3).length?process.argv.slice(3):undefined});fs.writeFileSync(file,r.xml);console.log(JSON.stringify(r.changed));}
