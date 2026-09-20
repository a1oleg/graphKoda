import {DOMParser,XMLSerializer} from '@xmldom/xmldom';
import {alignEdgePorts} from './edgePortAlignment.mjs';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const geometry=c=>Array.from(c?.childNodes||[]).find(n=>n.nodeName==='mxGeometry');
const num=(g,k)=>Number(g?.getAttribute(k)||0);
const style=c=>Object.fromEntries(c.getAttribute('style').split(';').filter(Boolean).map(p=>{const i=p.indexOf('=');return[p.slice(0,i),p.slice(i+1)];}));

export function compactVerticalContinuations(xml,{cellIds}={}) {
  const doc=new DOMParser().parseFromString(xml,'text/xml');
  const cells=Array.from(doc.getElementsByTagName('mxCell'));
  const byId=new Map(cells.map(c=>[c.getAttribute('id'),c]));
  const moved=new Set(),affected=new Set();
  const descendant=(c,ancestor)=>{
    for(let n=c;n;n=byId.get(n.getAttribute('parent')))if(n===ancestor)return true;
    return false;
  };
  const x=c=>c?num(geometry(c),'x')+x(byId.get(c.getAttribute('parent'))):0;
  for(const e of cells) {
    if(e.getAttribute('edge')!=='1'||(cellIds&&!cellIds.includes(e.getAttribute('id'))))continue;
    if(!['TRUE','FALSE'].includes(e.getAttribute('edgeType')))continue;
    const s=style(e);
    if(s.exitY!=='1'||s.entryY!=='0')continue;
    const source=byId.get(e.getAttribute('source')),target=byId.get(e.getAttribute('target'));
    if(!source||!target)continue;
    const owner=target.getAttribute('id').includes('-part-')?byId.get(target.getAttribute('parent')):target;
    if(!owner||moved.has(owner))continue;
    const step=owner.getAttribute('ownerStepStableId');
    // Vertical continuation inside the same compound condition: a resized
    // mosaic must not push its next predicate to the right of the current axis.
    // Joins/multiple incoming control routes and intentional side branches stay put.
    if(!step||step!==source.getAttribute('ownerStepStableId')||!owner.getAttribute('graphLabels').split(',').includes('Branch'))continue;
    const incoming=cells.filter(c=>c.getAttribute('edge')==='1'&&['TRUE','FALSE','NEXT'].includes(c.getAttribute('edgeType'))&&descendant(byId.get(c.getAttribute('target')),owner));
    if(incoming.length!==1)continue;
    const sourceX=x(source)+Number(s.exitX)*num(geometry(source),'width');
    const targetX=x(target)+Number(s.entryX)*num(geometry(target),'width');
    const delta=sourceX-targetX;
    if(delta>=-.1||Math.abs(delta)>num(geometry(target),'width')*.25)continue;
    const g=geometry(owner);g.setAttribute('x',String(num(g,'x')+delta));
    moved.add(owner);
    for(const c of cells)if(c.getAttribute('edge')==='1'&&
      (descendant(byId.get(c.getAttribute('source')),owner)||descendant(byId.get(c.getAttribute('target')),owner)))affected.add(c.getAttribute('id'));
  }
  // A side outcome owns a whole folding block. Place that block after the
  // preceding row, not after an obsolete pre-folding vertical reservation.
  for(const e of cells) {
    if(e.getAttribute('edge')!=='1'||!['TRUE','FALSE'].includes(e.getAttribute('edgeType'))||
      (cellIds&&!cellIds.includes(e.getAttribute('id'))))continue;
    const s=style(e),source=byId.get(e.getAttribute('source')),target=byId.get(e.getAttribute('target'));
    if(!source||!target||s.exitY!=='1'||s.entryY!=='0')continue;
    let block=target;
    while(block&&!String(block.getAttribute('stableId')).startsWith('flow-block:side:'))block=byId.get(block.getAttribute('parent'));
    if(!block||descendant(source,block))continue;
    const parent=byId.get(block.getAttribute('parent'));
    let row=source;
    while(row&&byId.get(row.getAttribute('parent'))!==parent)row=byId.get(row.getAttribute('parent'));
    if(!row)continue;
    const incoming=cells.filter(c=>c.getAttribute('edge')==='1'&&descendant(byId.get(c.getAttribute('target')),block)&&!descendant(byId.get(c.getAttribute('source')),block));
    if(incoming.length!==1)continue;
    const bg=geometry(block),oldY=num(bg,'y');
    const preceding=cells.filter(c=>c.getAttribute('vertex')==='1'&&c.getAttribute('parent')===block.getAttribute('parent')&&c!==block&&num(geometry(c),'y')<oldY);
    const nextY=Math.max(...preceding.map(c=>num(geometry(c),'y')+num(geometry(c),'height')))+14;
    const dx=x(source)+num(geometry(source),'width')/2-x(target)-num(geometry(target),'width')/2;
    const dy=Math.min(0,nextY-oldY);
    if(Math.abs(dx)>num(geometry(source),'width')*.25)continue;
    bg.setAttribute('x',String(num(bg,'x')+dx));bg.setAttribute('y',String(oldY+dy));
    e.setAttribute('style',e.getAttribute('style').replace(/exitX=[^;]+/,'exitX=0.5').replace(/entryX=[^;]+/,'entryX=0.5'));
    const eg=geometry(e),points=Array.from(eg?.childNodes||[]).find(n=>n.nodeName==='Array'&&n.getAttribute('as')==='points');
    if(points)eg.removeChild(points); // centred vertical outcome needs no stale bends
    for(const c of cells) {
      if(c.getAttribute('edge')!=='1')continue;
      const a=descendant(byId.get(c.getAttribute('source')),block),b=descendant(byId.get(c.getAttribute('target')),block);
      if(!a&&!b)continue;
      affected.add(c.getAttribute('id'));
      if(a&&b&&!descendant(byId.get(c.getAttribute('parent')),block)) {
        for(const p of Array.from(c.getElementsByTagName('mxPoint'))) {
          p.setAttribute('x',String(num(p,'x')+dx));p.setAttribute('y',String(num(p,'y')+dy));
        }
      }
    }
    if(Math.abs(dx)>.01||Math.abs(dy)>.01)moved.add(block);
  }
  const result=alignEdgePorts(new XMLSerializer().serializeToString(doc),{cellIds:[...affected]});
  return {...result,moved:[...moved].map(c=>c.getAttribute('id')),affected:[...affected]};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const file=process.argv[2];const ids=process.argv.slice(3);
 const r=compactVerticalContinuations(fs.readFileSync(file,'utf8'),{cellIds:ids.length?ids:undefined});
 fs.writeFileSync(file,r.xml);console.log({moved:r.moved,affected:r.affected});
}
