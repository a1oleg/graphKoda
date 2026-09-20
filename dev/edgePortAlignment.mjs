import {DOMParser, XMLSerializer} from '@xmldom/xmldom';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

const geometry=c=>Array.from(c?.childNodes||[]).find(n=>n.nodeName==='mxGeometry');
const num=(g,k)=>Number(g?.getAttribute(k)||0);
const styles=s=>new Map(s.split(';').filter(Boolean).map(p=>{const i=p.indexOf('=');return [p.slice(0,i),p.slice(i+1)];}));

// Run after tile sizing. Orthogonal routes must meet the current port normal,
// not the centre of the tile before mosaic caps/text widths were recalculated.
export function alignEdgePorts(xml,{cellIds}={}) {
  const doc=new DOMParser().parseFromString(xml,'text/xml');
  const cells=Array.from(doc.getElementsByTagName('mxCell'));
  const byId=new Map(cells.map(c=>[c.getAttribute('id'),c]));
  function box(c,seen=new Set()) {
    if(!c||seen.has(c))return null;
    seen.add(c);
    const g=geometry(c);
    if(g?.getAttribute('relative')==='1')return null;
    const parent=byId.get(c.getAttribute('parent'));
    const p=parent?box(parent,seen):{x:0,y:0};
    return p&&{x:p.x+num(g,'x'),y:p.y+num(g,'y'),width:num(g,'width'),height:num(g,'height')};
  }
  let changed=0;
  for(const edge of cells) {
    if(edge.getAttribute('edge')!=='1'||(cellIds&&!cellIds.includes(edge.getAttribute('id'))))continue;
    const g=geometry(edge),array=Array.from(g?.childNodes||[]).find(n=>n.nodeName==='Array'&&n.getAttribute('as')==='points');
    const points=Array.from(array?.childNodes||[]).filter(n=>n.nodeName==='mxPoint');
    if(!points.length)continue;
    const source=box(byId.get(edge.getAttribute('source'))),target=box(byId.get(edge.getAttribute('target')));
    const parent=box(byId.get(edge.getAttribute('parent')));
    if(!source||!target||!parent)continue;
    const s=styles(edge.getAttribute('style'));
    if(!['exitX','exitY','entryX','entryY'].every(k=>s.has(k)))continue;
    const before=edge.toString();
    const side=prefix=>{
      const x=Number(s.get(prefix+'X')),y=Number(s.get(prefix+'Y'));
      return y===0||y===1?'vertical':x===0||x===1?'horizontal':null;
    };
    const sourceSide=side('exit'),targetSide=side('entry');
    // A straight lane may land anywhere in the central half of both flat
    // faces. Preserve that existing lane instead of inserting tiny doglegs.
    const axis=num(points[0],'x')+parent.x;
    if(sourceSide==='vertical'&&targetSide==='vertical'
      &&s.get('exitY')!==s.get('entryY')
      &&points.every(p=>Math.abs(num(p,'x')+parent.x-axis)<0.01)
      &&[source,target].every(b=>axis>=b.x+b.width*.25&&axis<=b.x+b.width*.75)) {
      s.set('exitX',String((axis-source.x)/source.width));
      s.set('entryX',String((axis-target.x)/target.width));
    } else {
      for(const [prefix,b,ordered,orientation] of [
        ['exit',source,points,sourceSide],['entry',target,[...points].reverse(),targetSide],
      ]) {
        if(!orientation)continue;
        const coord=orientation==='vertical'?'x':'y';
        const ratio=Number(s.get(prefix+(coord==='x'?'X':'Y')));
        const desired=b[coord]+ratio*b[coord==='x'?'width':'height']-parent[coord];
        const old=num(ordered[0],coord);
        for(const point of ordered) {
          if(Math.abs(num(point,coord)-old)>0.01)break;
          point.setAttribute(coord,String(desired));
        }
      }
    }
    edge.setAttribute('style',[...s].map(([k,v])=>`${k}=${v};`).join(''));
    if(edge.toString()!==before)changed++;
  }
  return {xml:new XMLSerializer().serializeToString(doc),changed};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const file=process.argv[2];
  const result=alignEdgePorts(fs.readFileSync(file,'utf8'),{cellIds:process.argv.length>3?process.argv.slice(3):undefined});
  fs.writeFileSync(file,result.xml);console.log({changed:result.changed});
}
