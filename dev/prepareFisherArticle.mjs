import fs from 'node:fs';
import {DOMParser,XMLSerializer} from '@xmldom/xmldom';
const file=process.argv[2];
const doc=new DOMParser().parseFromString(fs.readFileSync(file,'utf8'),'text/xml');
let cells=Array.from(doc.getElementsByTagName('mxCell'));
const byId=new Map(cells.map(c=>[c.getAttribute('id'),c]));
const g=c=>Array.from(c?.childNodes||[]).find(n=>n.nodeName==='mxGeometry');
const n=(e,k)=>Number(e?.getAttribute(k)||0);
const parent=c=>byId.get(c?.getAttribute('parent'));
const pos=c=>c?{x:n(g(c),'x')+pos(parent(c)).x,y:n(g(c),'y')+pos(parent(c)).y}:{x:0,y:0};
const remove=new Set(cells.filter(c=>/^f[12]-/.test(c.getAttribute('id'))||c.getAttribute('edgeType')==='CALLS'));
for(let changed=true;changed;){changed=false;for(const c of cells)if(!remove.has(c)&&(remove.has(parent(c))||remove.has(byId.get(c.getAttribute('source')))||remove.has(byId.get(c.getAttribute('target'))))){remove.add(c);changed=true;}}
for(const c of cells)if(c.getAttribute('edge')==='1'&&(!c.getAttribute('source')||!c.getAttribute('target')))remove.add(c);
for(const c of remove)c.parentNode.removeChild(c);
cells=cells.filter(c=>!remove.has(c));
const frame=byId.get('f0-block');frame.setAttribute('value','');frame.setAttribute('style','group;container=1;collapsible=0;');
// Collapse only empty horizontal bands. Glyphs, tiles and their relative sizes
// stay unchanged; the same monotone transform is applied to edge waypoints.
const absolute=new Map(cells.map(c=>[c,pos(c)]));
const leaves=cells.filter(c=>c.getAttribute('vertex')==='1'&&!cells.some(d=>parent(d)===c&&d.getAttribute('vertex')==='1'));
const bands=leaves.map(c=>[absolute.get(c).y-10,absolute.get(c).y+n(g(c),'height')+10]).sort((a,b)=>a[0]-b[0]);
const merged=[];for(const b of bands){const last=merged.at(-1);if(last&&b[0]<=last[1])last[1]=Math.max(last[1],b[1]);else merged.push([...b]);}
const gaps=[];for(let i=1;i<merged.length;i++){const a=merged[i-1][1],b=merged[i][0];if(b-a>20)gaps.push({a,b,cut:b-a-20});}
const map=y=>y-gaps.reduce((sum,q)=>sum+(y>=q.b?q.cut:y>q.a?(y-q.a)/(q.b-q.a)*q.cut:0),0);
for(const c of cells){const geom=g(c);if(!geom)continue;const p=absolute.get(parent(c))||{x:0,y:0};
 if(c.getAttribute('vertex')==='1'&&geom.getAttribute('relative')!=='1'){const a=absolute.get(c);geom.setAttribute('y',String(map(a.y)-map(p.y)));geom.setAttribute('height',String(map(a.y+n(geom,'height'))-map(a.y)));}
 for(const point of Array.from(geom.getElementsByTagName('mxPoint'))){if(point.getAttribute('as')==='offset')continue;point.setAttribute('y',String(map(n(point,'y')+p.y)-map(p.y)));}
}
// Container bounds are editorial scaffolding, not the exported image bounds.
for(const c of cells.filter(c=>/group;/.test(c.getAttribute('style'))).reverse()){
 const kids=cells.filter(d=>parent(d)===c&&d.getAttribute('vertex')==='1');if(!kids.length)continue;
 g(c).setAttribute('width',String(Math.max(...kids.map(d=>n(g(d),'x')+n(g(d),'width')))));
 g(c).setAttribute('height',String(Math.max(...kids.map(d=>n(g(d),'y')+n(g(d),'height')))));
}
// Enter the return operator rather than its whole mosaic (which includes a
// raised collection stack). Enter collection arguments below the rear cards.
const retEdge=byId.get('f0-e10'),ret=byId.get('f0-n6-part-1');
if(retEdge&&ret){retEdge.setAttribute('target',ret.getAttribute('id'));const p=pos(parent(retEdge)),r=pos(ret),s=pos(byId.get(retEdge.getAttribute('source')));const pts=Array.from(g(retEdge).getElementsByTagName('mxPoint'));for(const pt of pts)pt.setAttribute('x',String(r.x+n(g(ret),'width')/2-p.x));pts[0]?.setAttribute('y',String(s.y+n(g(byId.get(retEdge.getAttribute('source'))),'height')/2-p.y));}
const argEdge=byId.get('f0-e18'),arg=byId.get('f0-n15');
if(argEdge&&arg){argEdge.setAttribute('style',argEdge.getAttribute('style').replace('entryY=0.5;','entryY=0.8;'));const y=pos(arg).y+n(g(arg),'height')*.8-pos(parent(argEdge)).y;const pts=Array.from(g(argEdge).getElementsByTagName('mxPoint'));for(const pt of pts.slice(1))pt.setAttribute('y',String(y));}
fs.writeFileSync(file,new XMLSerializer().serializeToString(doc));
console.log(JSON.stringify({removed:remove.size,emptyBands:gaps.length,verticalReduction:gaps.reduce((s,q)=>s+q.cut,0),leaves:leaves.length}));
