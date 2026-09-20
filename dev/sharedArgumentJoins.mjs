import {DOMParser,XMLSerializer} from '@xmldom/xmldom';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
export function sharedArgumentJoins(xml){
 const doc=new DOMParser().parseFromString(xml,'text/xml');
 const cs=Array.from(doc.getElementsByTagName('mxCell')),ids=new Map(cs.map(c=>[c.getAttribute('id'),c]));
 const g=c=>Array.from(c?.childNodes||[]).find(n=>n.nodeName==='mxGeometry');
 const n=(c,k)=>Number(g(c)?.getAttribute(k)||0);
 const pos=c=>{if(!c)return{x:0,y:0};const p=pos(ids.get(c.getAttribute('parent')));return{x:p.x+n(c,'x'),y:p.y+n(c,'y')};};
 const groups=new Map();
 for(const e of cs)if(e.getAttribute('edgeType')==='ArgJoin'){const id=e.getAttribute('target');groups.set(id,[...(groups.get(id)||[]),e]);}
 const changed=[];
 for(const [id,edges]of groups){
  if(edges.length<2)continue;
  const target=ids.get(id),t=pos(target),turn=t.x-24,ty=t.y+n(target,'height')/2;
  if(edges.some(e=>{const s=ids.get(e.getAttribute('source'));return pos(s).x+n(s,'width')>=turn;}))continue;
  for(const e of edges){
   const before=e.toString(),source=ids.get(e.getAttribute('source')),s=pos(source),p=pos(ids.get(e.getAttribute('parent'))),eg=g(e);
   const style=e.getAttribute('style').replace(/(?:exitX|exitY|entryX|entryY|sourceJettySize|targetJettySize)=[^;]*;/g,'');
   e.setAttribute('style',style+'exitX=1;exitY=0.5;entryX=0;entryY=0.5;sourceJettySize=0;targetJettySize=24;');
   for(const a of Array.from(eg.childNodes))if(a.nodeName==='Array'&&a.getAttribute('as')==='points')eg.removeChild(a);
   const a=doc.createElement('Array');a.setAttribute('as','points');eg.appendChild(a);
   for(const [x,y]of [[turn,s.y+n(source,'height')/2],[turn,ty]]){const point=doc.createElement('mxPoint');point.setAttribute('x',String(x-p.x));point.setAttribute('y',String(y-p.y));a.appendChild(point);}
   if(before!==e.toString())changed.push(e.getAttribute('id'));
  }
 }
 return{xml:new XMLSerializer().serializeToString(doc),changed};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const f=process.argv[2],r=sharedArgumentJoins(fs.readFileSync(f,'utf8'));fs.writeFileSync(f,r.xml);console.log({changed:r.changed});}
