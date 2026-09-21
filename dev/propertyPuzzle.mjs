import {DOMParser, XMLSerializer} from '@xmldom/xmldom';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {measureMosaicTile,mosaicTileImage,decodeMosaicImage} from './mosaicTileGeometry.mjs';

export const PROPERTY_TAB=9;
const geometry=c=>Array.from(c?.childNodes || []).find(n=>n.nodeName==='mxGeometry');
const num=(g,k)=>Number(g?.getAttribute(k)||0);
const label=c=>c.getAttribute('puzzleOriginalLabel') || c.getAttribute('value') || '';
const member=c=>c && /^\.[$\p{ID_Start}][\p{ID_Continue}$]*(?:\(\)?)?$/u.test(label(c));
function styles(raw) {
  return new Map(String(raw).split(';').filter(Boolean).map(s=>{
    const i=s.indexOf('='); return i<0?[s,'']:[s.slice(0,i),s.slice(i+1)];
  }));
}

/** Same measured centre + fixed caps contract for fresh renders and targeted refreshes. */
export function updatePropertyPuzzles(xml,{ready=false}={}) {
  const doc=new DOMParser().parseFromString(xml,'text/xml');
  const cells=Array.from(doc.getElementsByTagName('mxCell'));
  const byId=new Map(cells.map(c=>[c.getAttribute('id'),c]));
  const rows=new Map(); let changed=0,yields=0;
  for(const c of cells) {
    if(c.getAttribute('vertex')!=='1' || !/-part-\d+$/.test(c.getAttribute('id'))) continue;
    const key=c.getAttribute('parent');
    if(!rows.has(key)) rows.set(key,[]);
    rows.get(key).push(c);
  }
  for(const [parentId,row] of rows) {
    row.sort((a,b)=>num(geometry(a),'x')-num(geometry(b),'x'));
    let shift=0;
    for(let i=0;i<row.length;i++) {
      const c=row[i],g=geometry(c),prev=row[i-1],next=row[i+1];
      const x=num(g,'x'),w=num(g,'width'),h=num(g,'height');
      // An opening parenthesis at a split call's end faces into the gap.
      // Its silhouette must not look like the closing ')' on the other side.
      const openingCall=!next&&label(c)==='('&&row.some(p=>/Call|Request|Method/.test(p.getAttribute('graphLabels')||''));
      if(c.getAttribute('mosaicGeometryVersion')==='3'&&!openingCall) continue;
      const s=styles(c.getAttribute('style')),body=decodeMosaicImage(c.getAttribute('style'));
      // Storage boxes, provider backings and vertical mosaics retain their own layout.
      const horizontal=other=>other && Math.abs(num(geometry(other),'y')+num(geometry(other),'height')/2-num(g,'y')-h/2)<.1;
      if(!body || h>30 || !(horizontal(prev)||horizontal(next))) continue;
      const left=member(c)&&horizontal(prev),right=member(next)&&horizontal(next);
      const layout=measureMosaicTile(label(c),body,{
        leftTab:left,rightSocket:right,fontSize:Number(s.get('fontSize')||12),bold:(Number(s.get('fontStyle'))&1)!==0,
      });
      if(openingCall)layout.right='inward';
      const wasTab=c.getAttribute('puzzleLeft')==='true';
      const oldAdvance=w-(wasTab?PROPERTY_TAB:0);
      const delta=layout.advance-oldAdvance;
      const start=x+(wasTab?PROPERTY_TAB:0)+shift;
      const system=/^yield\s*\*?$/.test(label(c));
      s.set('image',mosaicTileImage(body,layout,h,{system}));
      s.set('align','left'); s.set('spacing','0');
      s.set('spacingLeft',String(layout.spacingLeft)); s.set('spacingRight',String(layout.spacingRight));
      s.set('whiteSpace','nowrap'); s.set('overflow','hidden');
      c.setAttribute('puzzleOriginalLabel',label(c)); c.setAttribute('value',layout.displayText);
      c.setAttribute('mosaicGeometryVersion','3');
      c.setAttribute('mosaicLeftSide',layout.left); c.setAttribute('mosaicRightSide',layout.right);
      c.setAttribute('mosaicTextWidth',String(layout.textWidth));
      if(left||right) {
        c.setAttribute('puzzleVersion','3');
        c.setAttribute('puzzleLeft',String(left)); c.setAttribute('puzzleRight',String(right));
      }
      g.setAttribute('x',String(start-(left?PROPERTY_TAB:0)));
      g.setAttribute('width',String(layout.width));
      c.setAttribute('style',[...s].map(([k,v])=>v?`${k}=${v}`:k).join(';')+';');
      shift+=delta; changed++; if(system)yields++;
    }
    if(shift) {
      const g=geometry(byId.get(parentId));
      if(g)g.setAttribute('width',String(num(g,'width')+shift));
    }
  }
  // A targeted refresh keeps hand-positioned rows, but an old terminal waypoint
  // may now sit inside the wider tile. Drop that backtracking stub, not the route.
  const position = c => {
    if (!c || c.getAttribute('id')==='1') return {x:0,y:0};
    const p=position(byId.get(c.getAttribute('parent'))), g=geometry(c);
    return {x:p.x+num(g,'x'), y:p.y+num(g,'y')};
  };
  let repairedRoutes=0;
  for (const edge of cells.filter(c=>c.getAttribute('edge')==='1')) {
    const s=styles(edge.getAttribute('style')), g=geometry(edge);
    const array=Array.from(g?.childNodes || []).find(n=>n.nodeName==='Array' && n.getAttribute('as')==='points');
    if (!array) continue;
    const origin=position(byId.get(edge.getAttribute('parent')));
    for (const [terminal,prefix,first] of [['source','exit',true],['target','entry',false]]) {
      const node=byId.get(edge.getAttribute(terminal));
      if (!node || !rows.get(node.getAttribute('parent'))?.some(c=>c.hasAttribute('puzzleVersion'))) continue;
      const p=position(node), ng=geometry(node), side=Number(s.get(prefix+'X'));
      if (Number(s.get(prefix+'Y'))!==.5 || ![0,1].includes(side)) continue;
      const points=Array.from(array.childNodes).filter(n=>n.nodeName==='mxPoint');
      const point=first ? points[0] : points.at(-1);
      if (!point) continue;
      const x=num(point,'x')+origin.x, y=num(point,'y')+origin.y;
      const boundary=p.x+side*num(ng,'width');
      if (Math.abs(y-p.y-num(ng,'height')/2)<1 && (side===1 ? x<boundary : x>boundary)) {
        array.removeChild(point); repairedRoutes++;
      }
    }
  }
  return {xml:new XMLSerializer().serializeToString(doc),changed,yields,repairedRoutes};
}


// Targeted refresh: preserve graph identity, annotations and hand-positioned rows.
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const file=process.argv[2];
  if(!file?.endsWith('.drawio'))throw new Error('Usage: node dev/propertyPuzzle.mjs <diagram.drawio>');
  const result=updatePropertyPuzzles(fs.readFileSync(file,'utf8'));
  fs.writeFileSync(file,result.xml);
  console.log(JSON.stringify({file,changed:result.changed,yields:result.yields,repairedRoutes:result.repairedRoutes}));
}
