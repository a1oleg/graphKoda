import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {DOMParser, XMLSerializer} from '@xmldom/xmldom';
import roots from './projectPaths.cjs';

export function boundaryCaptionWidth(text, fontSize = 12) {
  // Reserve space for both curved ends; never wrap a function name.
  return Math.ceil(Math.max(48, [...text].reduce((w,c)=>w+(/[MWЖШЩЮ]/u.test(c)?1:/[ilI.,' ]/u.test(c)?.32:.64),0)*fontSize+24));
}
function sourceName(stableId, cache) {
  if(cache.has(stableId))return cache.get(stableId);
  const m=/^(.*):(\d+):(\d+):(\d+):(\d+)$/.exec(stableId);
  if(!m)return null;
  const file=[roots.toolRoot,roots.sourceRoot].map(root=>path.resolve(root,m[1])).find(f=>fs.existsSync(f));
  if(!file)return null;
  const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
  const offset=source.getPositionOfLineAndCharacter(+m[2]-1,+m[3]);
  let found;
  function visit(n){
    if(n.getStart(source)>offset||n.end<offset)return;
    if(ts.isFunctionLike(n)) {
      found=n.name?.getText(source);
      let owner=n.parent;
      while(owner&&(ts.isCallExpression(owner)||ts.isParenthesizedExpression(owner)||ts.isAsExpression(owner)))owner=owner.parent;
      if(!found&&owner&&(ts.isVariableDeclaration(owner)||ts.isPropertyAssignment(owner)))found=owner.name.getText(source);
    }
    ts.forEachChild(n,visit);
  }
  visit(source);cache.set(stableId,found||null);return found;
}
export function updateFunctionBoundaryCaptions(xml, image) {
  const doc=new DOMParser().parseFromString(xml,'text/xml');
  const cells=Array.from(doc.getElementsByTagName('mxCell'));
  const cache=new Map(); const changed=[];
  for(const cell of cells) {
    if(cell.getAttribute('vertex')!=='1'||cell.getAttribute('id').includes('fold-'))continue;
    const labels=cell.getAttribute('graphLabels')||'';
    const start=labels.split(',').includes('FunctionStart'),end=labels.split(',').includes('FunctionEnd');
    if(!start&&!end)continue;
    const fn=cell.getAttribute('functionStableId');
    const name=sourceName(fn,cache); if(!name)continue;
    const text=name+'()',g=cell.getElementsByTagName('mxGeometry')[0];if(!g)continue;
    const id=cell.getAttribute('id')+'-function-caption';
    let caption=cells.find(c=>c.getAttribute('id')===id);
    if(!caption){caption=doc.createElement('mxCell');cell.parentNode.appendChild(caption);}
    const width=boundaryCaptionWidth(text),height=34;
    for(const [k,v]of Object.entries({id,value:text,vertex:'1',connectable:'0',parent:cell.getAttribute('parent'),functionBoundaryOwner:cell.getAttribute('id')}))caption.setAttribute(k,v);
    caption.setAttribute('style',`shape=image;imageAspect=0;image=${image('end','#DAE8FC','#007FFF',{width,torn:true})};html=1;whiteSpace=nowrap;align=center;verticalAlign=middle;spacingLeft=12;spacingRight=10;fontSize=12;fontColor=#000000;`);
    while(caption.firstChild)caption.removeChild(caption.firstChild);
    const geo=doc.createElement('mxGeometry');
    for(const [k,v]of Object.entries({x:+g.getAttribute('x')+ +g.getAttribute('width'),y:+g.getAttribute('y')+(+g.getAttribute('height')-height)/2,width,height,as:'geometry'}))geo.setAttribute(k,String(v));
    caption.appendChild(geo);changed.push({id,text,width});
  }
  return {xml:changed.length?new XMLSerializer().serializeToString(doc):xml,changed};
}
