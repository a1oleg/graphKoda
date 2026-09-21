import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
import {DOMParser, XMLSerializer} from '@xmldom/xmldom';
import roots from './projectPaths.cjs';
import {awaitedTypeArgumentIndex} from '../graph/static-extract/ts/awaitedTypeContract.mjs';
import {measureMosaicTile,mosaicTileImage} from './mosaicTileGeometry.mjs';
import {refineCallFamilies} from './callFamilyRefinement.mjs';

const geo=c=>Array.from(c?.childNodes||[]).find(n=>n.nodeName==='mxGeometry');
const num=(g,k)=>Number(g?.getAttribute(k)||0);
const label=c=>c.getAttribute('puzzleOriginalLabel')||c.getAttribute('value')||'';
const baseSvg=(fill,stroke)=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 30"><path d="M .5 .5 H 99.5 V 29.5 H .5 Z" fill="${fill}" stroke="${stroke}"/></svg>`;
function normalizeClosing(cell, container) {
  const svg=baseSvg('#DAE8FC','#007FFF'),layout=measureMosaicTile(')',svg);
  layout.left='inward';layout.right='round';layout.width+=20;layout.spacingLeft+=10;layout.spacingRight+=10;
  cell.setAttribute('style',`shape=image;imageAspect=0;image=${mosaicTileImage(svg,layout,30)};html=1;align=left;verticalAlign=middle;fontSize=12;spacingLeft=${layout.spacingLeft};spacingRight=${layout.spacingRight};`);
  cell.setAttribute('puzzleRight','false');cell.setAttribute('mosaicRightSide','round');
  geo(cell).setAttribute('width',String(layout.width));geo(container).setAttribute('width',String(layout.width));
}

/** Targeted presentation pass, also used by fresh renders. Source IDs stay intact. */
export function updateAwaitedTypeDiagrams(xml) {
  const doc=new DOMParser().parseFromString(xml,'text/xml');
  const cells=Array.from(doc.getElementsByTagName('mxCell'));
  const byId=new Map(cells.map(c=>[c.getAttribute('id'),c]));
  const position=c=>{if(!c||c.getAttribute('id')==='1')return{x:0,y:0};const p=position(byId.get(c.getAttribute('parent'))),g=geo(c);return{x:p.x+num(g,'x'),y:p.y+num(g,'y')};};
  const children=id=>cells.filter(c=>c.getAttribute('parent')===id&&c.getAttribute('vertex')==='1');
  const owner=id=>{let c=byId.get(id);while(c&&/-part-\d+$/.test(c.getAttribute('id')))c=byId.get(c.getAttribute('parent'));return c;};
  const files=new Map();
  const sourceNode=(stableId,predicate)=>{
    const m=/^(.*):(\d+):(\d+):(\d+):(\d+)$/.exec(stableId||'');if(!m)return null;
    const file=[roots.sourceRoot,roots.toolRoot].map(root=>path.resolve(root,m[1])).find(fs.existsSync);if(!file)return null;
    if(!files.has(file))files.set(file,ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true));
    const sf=files.get(file),offset=sf.getPositionOfLineAndCharacter(+m[2]-1,+m[3]);let found;
    const visit=n=>{if(n.getStart(sf)>offset||n.end<offset)return;if(predicate(n))found=n;ts.forEachChild(n,visit);};visit(sf);return found;
  };
  let changed=0;
  for(const opening of cells.filter(c=>c.getAttribute('vertex')==='1'&&/Awaited/.test(c.getAttribute('graphLabels')||'')&&!/-part-\d+$/.test(c.getAttribute('id')))) {
    const id=opening.getAttribute('id');if(opening.hasAttribute('awaitedTypePresentation')){
      const closing=cells.find(c=>c.getAttribute('sourceCallStableId')===opening.getAttribute('sourceCallStableId')&&/FnVisualProxy/.test(c.getAttribute('graphLabels')||'')&&!/-part-\d+$/.test(c.getAttribute('id')));
      const cap=closing&&children(closing.getAttribute('id')).find(c=>label(c)===')');if(cap)normalizeClosing(cap,closing);
      const callId=opening.getAttribute('sourceCallStableId'),call=sourceNode(callId,ts.isCallExpression),type=call?.typeArguments?.[0];
      if(type){
        const sf=type.getSourceFile(),a=sf.getLineAndCharacterOfPosition(type.getStart(sf)),b=sf.getLineAndCharacterOfPosition(type.end);
        const typeId=`${callId.replace(/:\d+:\d+:\d+:\d+$/,'')}:${a.line+1}:${a.character}:${b.line+1}:${b.character}`;
        byId.get(id+'-awaited-type')?.setAttribute('stableId',typeId);
        byId.get(id+'-awaited-type-await')?.setAttribute('targetStableId',typeId);
      }
      continue;
    }
    const parts=children(id).sort((a,b)=>num(geo(a),'x')-num(geo(b),'x'));
    const first=parts.findIndex(c=>label(c)==='<'),last=parts.findLastIndex(c=>label(c)==='>');
    if(first<0||last<=first||label(parts.at(-1))!=='(')continue;
    const callId=opening.getAttribute('sourceCallStableId')||opening.getAttribute('locationStableId');
    const call=sourceNode(callId,ts.isCallExpression);
    const declaration=sourceNode(opening.getAttribute('sourceStableId'),ts.isFunctionLike);
    const index=call&&awaitedTypeArgumentIndex(ts,call,declaration);
    // Multiple type arguments need separate result-selection layout; don't mislabel them.
    if(index!==0||call.typeArguments.length!==1)continue;
    const closing=cells.find(c=>c!==opening&&c.getAttribute('vertex')==='1'
      &&c.getAttribute('sourceCallStableId')===callId&&/FnVisualProxy/.test(c.getAttribute('graphLabels')||'')&&!/-part-\d+$/.test(c.getAttribute('id')));
    if(!closing)continue;
    const closeParts=children(closing.getAttribute('id')).sort((a,b)=>num(geo(a),'x')-num(geo(b),'x'));
    const closeParen=closeParts.find(c=>label(c)===')');if(!closeParen)continue;
    const members=closeParts.filter(c=>/^\./.test(label(c)));
    const family=new Set([id,closing.getAttribute('id')]);
    for(let round=0;round<32;round++) {
      const size=family.size;
      for(const e of cells.filter(c=>c.getAttribute('edge')==='1'&&['ARG','ArgJoin','FIELD','FieldJoin'].includes(c.getAttribute('edgeType')))) {
        if(family.has(owner(e.getAttribute('source'))?.getAttribute('id')))family.add(owner(e.getAttribute('target'))?.getAttribute('id'));
      }
      if(size===family.size)break;
    }
    const parent=byId.get(opening.getAttribute('parent')),origin=position(parent);
    const familyNodes=[...family].map(k=>byId.get(k)).filter(Boolean);
    const bottom=Math.max(...familyNodes.map(c=>position(c).y+num(geo(c),'height')));
    const y=bottom-origin.y+40, x=Math.max(num(geo(opening),'x'),Math.min(...familyNodes.filter(c=>c!==opening&&c!==closing).map(c=>position(c).x-origin.x)));
    const argument=call.typeArguments[index],sf=argument.getSourceFile();
    const startType=sf.getLineAndCharacterOfPosition(argument.getStart(sf)),endType=sf.getLineAndCharacterOfPosition(argument.end);
    const typeId=`${callId.replace(/:\d+:\d+:\d+:\d+$/,'')}:${startType.line+1}:${startType.character}:${endType.line+1}:${endType.character}`;
    const frameId=id+'-awaited-type',frame=doc.createElement('mxCell');
    for(const[k,v]of Object.entries({id:frameId,parent:parent.getAttribute('id'),value:'',vertex:'1',style:'group;container=1;collapsible=0;',awaitedTypePresentation:'1',sourceCallStableId:callId,stableId:typeId}))frame.setAttribute(k,v);
    const fg=doc.createElement('mxGeometry');for(const[k,v]of Object.entries({x,y,width:0,height:30,as:'geometry'}))fg.setAttribute(k,String(v));frame.appendChild(fg);opening.parentNode.appendChild(frame);byId.set(frameId,frame);
    const paint=(cell,text,left,right,fill,stroke)=>{
      const svg=baseSvg(fill,stroke),layout=measureMosaicTile(text,svg,{leftTab:left==='tab',rightSocket:right==='socket'});
      // Side widths belong to caps, not to the text area.
      if(left==='round'){layout.left='round';layout.width+=10;layout.spacingLeft+=10;}
      if(right==='inward'){layout.right='inward';layout.width+=10;layout.spacingRight+=10;}
      cell.setAttribute('value',layout.displayText);cell.setAttribute('puzzleOriginalLabel',text);
      cell.setAttribute('style',`shape=image;imageAspect=0;image=${mosaicTileImage(svg,layout,30)};html=1;fontSize=12;align=left;verticalAlign=middle;spacingLeft=${layout.spacingLeft};spacingRight=${layout.spacingRight};`);
      geo(cell).setAttribute('width',String(layout.width));geo(cell).setAttribute('height','30');
      return layout.width-(left==='tab'?9:0);
    };
    const typeParts=parts.slice(first,last+1);let advance=0;
    for(const p of [...typeParts,...members]) {
      const isMember=members.includes(p),text=label(p);
      p.setAttribute('parent',frameId);geo(p).setAttribute('x',String(advance-(isMember?9:0)));geo(p).setAttribute('y','0');
      if(isMember)advance+=paint(p,text,'tab','flat','#FFE6CC','#BE7000');
      else if(p===typeParts[0]||p===typeParts.at(-1))advance+=paint(p,text,'flat',p===typeParts.at(-1)&&members.length?'socket':'flat','#E1D5E7','#9673A6');
      else advance+=num(geo(p),'width');
    }
    fg.setAttribute('width',String(advance));
    const method=parts[first-1];paint(method,label(method)+'(','round','inward','#DAE8FC','#007FFF');
    geo(method).setAttribute('x','0');geo(opening).setAttribute('width',geo(method).getAttribute('width'));
    for(const p of parts.filter(p=>p!==method&&!typeParts.includes(p)))p.parentNode.removeChild(p);
    normalizeClosing(closeParen,closing);
    opening.setAttribute('awaitedTypePresentation','1');
    const oldHeight=num(geo(parent),'height'),newBottom=y+70,gap=Math.max(0,newBottom-(bottom-origin.y));
    // Move later content, preserving all hand-positioned content above this family.
    for(const c of children(parent.getAttribute('id')))if(!family.has(c.getAttribute('id'))&&position(c).y>=bottom&&geo(c))geo(c).setAttribute('y',String(num(geo(c),'y')+gap));
    geo(parent).setAttribute('height',String(oldHeight+gap));
    const outer=byId.get(parent.getAttribute('parent'));
    for(const c of children(outer?.getAttribute('id')))if(c!==parent&&num(geo(c),'y')>num(geo(parent),'y'))geo(c).setAttribute('y',String(num(geo(c),'y')+gap));
    for(let a=outer;a&&geo(a);a=byId.get(a.getAttribute('parent')))geo(a).setAttribute('height',String(num(geo(a),'height')+gap));
    const setRoute=(edge,points,style)=>{
      edge.setAttribute('style',style);const g=geo(edge);for(const child of Array.from(g.childNodes))g.removeChild(child);
      const array=doc.createElement('Array');array.setAttribute('as','points');for(const p of points){const n=doc.createElement('mxPoint');n.setAttribute('x',String(p.x));n.setAttribute('y',String(p.y));array.appendChild(n);}g.appendChild(array);
    };
    const wait=doc.createElement('mxCell');for(const[k,v]of Object.entries({id:frameId+'-await',parent:parent.getAttribute('id'),edge:'1',source:closeParen.getAttribute('id'),target:typeParts[0].getAttribute('id'),value:'await',edgeType:'AWAITS_TYPE',sourceStableId:callId,targetStableId:typeId,staticOnly:'1'}))wait.setAttribute(k,v);
    const wg=doc.createElement('mxGeometry');wg.setAttribute('relative','1');wg.setAttribute('as','geometry');wait.appendChild(wg);opening.parentNode.appendChild(wait);
    const start=position(closeParen),right=start.x-origin.x+num(geo(closeParen),'width')+24,mid=y-18;
    setRoute(wait,[{x:right,y:start.y-origin.y+15},{x:right,y:mid-12},{x:right-6,y:mid-8},{x:right+6,y:mid-4},{x:right,y:mid},{x:x-20,y:mid},{x:x-20,y:y+15}],
      'edgeStyle=none;rounded=0;endArrow=block;strokeColor=#9673A6;fontColor=#9673A6;exitX=1;exitY=0.5;entryX=0;entryY=0.5;');
    for(const e of cells.filter(c=>c.getAttribute('edge')==='1')) {
      const ep=position(byId.get(e.getAttribute('parent')));
      if(members.some(m=>m.getAttribute('id')===e.getAttribute('source'))&&['VALUE','ASSIGNS_VALUE','YIELDS_VALUE'].includes(e.getAttribute('edgeType'))) {
        const source=position(byId.get(e.getAttribute('source'))),target=position(byId.get(e.getAttribute('target'))),returnY=origin.y+y+54;
        setRoute(e,[{x:source.x+num(geo(byId.get(e.getAttribute('source'))),'width')/2-ep.x,y:returnY-ep.y},{x:target.x-ep.x+num(geo(byId.get(e.getAttribute('target'))),'width')/2,y:returnY-ep.y}],
          'edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;strokeColor=#BE7000;fontColor=#BE7000;exitX=0.5;exitY=1;entryX=0.5;entryY=1;');
      } else {
        for(const p of Array.from(geo(e)?.getElementsByTagName('mxPoint')||[]))if(p.getAttribute('as')!=='offset'&&ep.y+num(p,'y')>=bottom)p.setAttribute('y',String(num(p,'y')+gap));
        if(e.getAttribute('source')===id&&e.getAttribute('edgeType')==='ARG')for(const a of Array.from(geo(e)?.childNodes||[]))if(a.nodeName==='Array')geo(e).removeChild(a);
      }
    }
    changed++;
  }
  refineCallFamilies(doc);
  return {xml:new XMLSerializer().serializeToString(doc),changed};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const file=process.argv[2];const result=updateAwaitedTypeDiagrams(fs.readFileSync(file,'utf8'));fs.writeFileSync(file,result.xml);console.log(JSON.stringify({changed:result.changed,file}));}
