import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {DOMParser,XMLSerializer} from '@xmldom/xmldom';
const geo=c=>Array.from(c?.childNodes||[]).find(n=>n.nodeName==='mxGeometry');
const num=(c,k)=>Number(geo(c)?.getAttribute(k)||0);

export function compactBlockEntries(xml,{targetStableId}={}){
  const doc=new DOMParser().parseFromString(xml,'text/xml'),cells=Array.from(doc.getElementsByTagName('mxCell'));
  const byId=new Map(cells.map(c=>[c.getAttribute('id'),c]));
  const parent=c=>byId.get(c?.getAttribute('parent'));
  const inside=(c,p)=>{for(;c;c=parent(c))if(c===p)return true;return false;};
  const y=c=>c?num(c,'y')+y(parent(c)):0;
  const children=c=>cells.filter(n=>parent(n)===c&&n.getAttribute('vertex')==='1');
  const oldY=new Map(cells.map(c=>[c,y(c)])),changed=[];
  for(const block of cells.filter(c=>String(c.getAttribute('stableId')).startsWith('flow-block:side:'))){
    if(targetStableId&&!cells.some(c=>c.getAttribute('stableId')===targetStableId&&inside(c,block)))continue;
    const rows=children(block).filter(c=>children(c).length).sort((a,b)=>num(a,'y')-num(b,'y'));
    const first=rows[0];if(!first)continue;
    const incoming=cells.filter(c=>c.getAttribute('edge')==='1'&&['TRUE','FALSE'].includes(c.getAttribute('edgeType'))&&inside(byId.get(c.getAttribute('target')),first)&&!inside(byId.get(c.getAttribute('source')),block));
    if(incoming.length!==1)continue;
    let previous=byId.get(incoming[0].getAttribute('source'));while(previous&&parent(previous)!==parent(block))previous=parent(previous);
    if(!previous)continue;
    // Reserve actual content and internal return routes, not the old row height.
    let bottom=Math.max(...children(previous).map(c=>num(c,'y')+num(c,'height')));
    for(const edge of cells.filter(c=>c.getAttribute('edge')==='1'&&inside(byId.get(c.getAttribute('source')),previous)&&inside(byId.get(c.getAttribute('target')),previous))){
      for(const p of Array.from(geo(edge)?.getElementsByTagName('mxPoint')||[]))if(p.getAttribute('as')!=='offset')bottom=Math.max(bottom,y(parent(edge))+Number(p.getAttribute('y'))-y(previous));
    }
    const previousHeight=Math.min(num(previous,'height'),bottom+12);
    geo(previous).setAttribute('height',String(previousHeight));
    const preceding=children(parent(block)).filter(c=>c!==block&&num(c,'y')<num(block,'y'));
    const nextY=Math.max(...preceding.map(c=>num(c,'y')+num(c,'height')))+8;
    const beforeShift=Math.min(0,nextY-num(block,'y'));
    geo(block).setAttribute('y',String(num(block,'y')+beforeShift));
    // One inset for the block and one for its first content row.
    const rowInset=Math.max(0,num(first,'y')-12);
    const contentInset=Math.max(0,Math.min(...children(first).map(c=>num(c,'y')))-12);
    for(const c of children(first))geo(c).setAttribute('y',String(num(c,'y')-contentInset));
    geo(first).setAttribute('height',String(num(first,'height')-contentInset));
    for(const row of rows)geo(row).setAttribute('y',String(num(row,'y')-rowInset-(row===first?0:contentInset)));
    geo(block).setAttribute('height',String(num(block,'height')-rowInset-contentInset));
    if(beforeShift||rowInset||contentInset)changed.push({block:block.getAttribute('id'),beforeReduced:-beforeShift,insideReduced:rowInset+contentInset});
  }
  for(const e of cells.filter(c=>c.getAttribute('edge')==='1')){
    const a=byId.get(e.getAttribute('source')),b=byId.get(e.getAttribute('target'));if(!a||!b)continue;
    const da=y(a)-oldY.get(a),db=y(b)-oldY.get(b),dp=y(parent(e))-(oldY.get(parent(e))||0);
    if(!da&&!db)continue;
    const points=Array.from(geo(e)?.getElementsByTagName('mxPoint')||[]).filter(p=>p.getAttribute('as')!=='offset');
    if(Math.abs(da-db)<.01){for(const p of points)p.setAttribute('y',String(Number(p.getAttribute('y'))+da-dp));}
    else if(['TRUE','FALSE','NEXT'].includes(e.getAttribute('edgeType'))){for(const p of Array.from(geo(e)?.childNodes||[]))if(p.nodeName==='Array')geo(e).removeChild(p);}
  }
  return{xml:new XMLSerializer().serializeToString(doc),changed};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const file=process.argv[2];const r=compactBlockEntries(fs.readFileSync(file,'utf8'),{targetStableId:process.argv[3]});fs.writeFileSync(file,r.xml);console.log(JSON.stringify(r.changed));}
