import fs from 'node:fs';
import assert from 'node:assert/strict';
import {DOMParser,XMLSerializer} from '@xmldom/xmldom';
const [file,id]=process.argv.slice(2);
const doc=new DOMParser().parseFromString(fs.readFileSync(file,'utf8'),'text/xml');
const cells=Array.from(doc.getElementsByTagName('mxCell')),byId=new Map(cells.map(c=>[c.getAttribute('id'),c]));
const g=c=>Array.from(c?.childNodes||[]).find(n=>n.nodeName==='mxGeometry');
const n=(c,k)=>Number(g(c)?.getAttribute(k)||0);
const pos=c=>{if(!c||!g(c))return{x:0,y:0};const p=pos(byId.get(c.getAttribute('parent')));return{x:p.x+n(c,'x'),y:p.y+n(c,'y')};};
const branch=byId.get(id);assert(branch);
const parts=new Set(cells.filter(c=>c.getAttribute('parent')===id).map(c=>c.getAttribute('id')));
const exits=cells.filter(c=>parts.has(c.getAttribute('source'))&&['TRUE','FALSE'].includes(c.getAttribute('edgeType')));
assert(exits.length===2&&exits[0].getAttribute('target')===exits[1].getAttribute('target'),'Expected common branch join');
const join=byId.get(exits[0].getAttribute('target')),row=byId.get(branch.getAttribute('parent'));
assert(join.getAttribute('parent')===row.getAttribute('id'));
const gap=36,dx=n(branch,'x')+n(branch,'width')+gap-n(join,'x');
assert(dx<=0,'Compaction must not expand the row');
const moved=new Set(cells.filter(c=>c.getAttribute('parent')===row.getAttribute('id')&&c.getAttribute('vertex')==='1'&&n(c,'x')>=n(join,'x')).map(c=>c.getAttribute('id')));
for(const key of moved){const c=byId.get(key);g(c).setAttribute('x',String(n(c,'x')+dx));}
g(row).setAttribute('width',String(n(row,'width')+dx));
for(const e of cells.filter(c=>c.getAttribute('edge')==='1')){
 const a=moved.has(e.getAttribute('source')),b=moved.has(e.getAttribute('target'));
 const points=Array.from(g(e)?.getElementsByTagName('mxPoint')||[]).filter(p=>p.getAttribute('as')!=='offset');
 if(a&&b)for(const p of points)p.setAttribute('x',String(Number(p.getAttribute('x'))+dx));
 else if(b&&points.length)points.at(-1).setAttribute('x',String(Number(points.at(-1).getAttribute('x'))+dx));
}
for(const e of exits){
 const source=byId.get(e.getAttribute('source')),a=pos(source),b=pos(join),p=pos(byId.get(e.getAttribute('parent'))),truth=e.getAttribute('edgeType')==='TRUE';
 for(const array of Array.from(g(e).childNodes).filter(c=>c.nodeName==='Array'))g(e).removeChild(array);
 const points=truth?[{x:a.x+n(source,'width')/2,y:Math.min(a.y,b.y)-24},{x:b.x+n(join,'width')/2,y:Math.min(a.y,b.y)-24}]:[];
 const array=doc.createElement('Array');array.setAttribute('as','points');
 for(const q of points){const point=doc.createElement('mxPoint');point.setAttribute('x',String(q.x-p.x));point.setAttribute('y',String(q.y-p.y));array.appendChild(point);}g(e).appendChild(array);
 e.setAttribute('style',e.getAttribute('style').replace(/(?:exitX|exitY|entryX|entryY|edgeStyle)=[^;]*;/g,'')+`edgeStyle=none;exitX=${truth?.5:1};exitY=${truth?0:.5};entryX=${truth?.5:0};entryY=${truth?0:.5};`);
}
assert(n(join,'x')-n(branch,'x')-n(branch,'width')===gap);
fs.writeFileSync(file,new XMLSerializer().serializeToString(doc));console.log({dx,moved:[...moved]});
