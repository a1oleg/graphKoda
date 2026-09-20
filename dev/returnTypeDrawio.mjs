import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {DOMParser,XMLSerializer} from '@xmldom/xmldom';
import {pathToFileURL} from 'node:url';
import roots from './projectPaths.cjs';
import {mosaicTextWidth} from './mosaicTileGeometry.mjs';
import {wireSignatureFlow} from './signatureFlowDrawio.mjs';

const geo=c=>Array.from(c?.childNodes || []).find(n=>n.nodeName==='mxGeometry');
const num=(g,k)=>Number(g?.getAttribute(k)||0);

/** Type presentation only: no invented CALLS/NEXT edges or runtime operations. */
export function updateReturnTypeDiagrams(xml,methodImage) {
  const doc=new DOMParser().parseFromString(xml,'text/xml');
  const cells=Array.from(doc.getElementsByTagName('mxCell'));
  const byId=new Map(cells.map(c=>[c.getAttribute('id'),c]));
  const position=c=>{if(!c||c.getAttribute('id')==='1')return{x:0,y:0};const p=position(byId.get(c.getAttribute('parent'))),g=geo(c);return{x:p.x+num(g,'x'),y:p.y+num(g,'y')};};
  const alignExpandedFrames=frame=>{
    if(frame.getAttribute('expandedFramesAligned')==='2')return;
    const previous=frame.getAttribute('expandedFramesAligned')==='1';
    const container=byId.get(frame.getAttribute('parent')),scope=container?.getAttribute('parent');
    const threshold=position(frame).y-16,gap=num(geo(frame),'height')+24;
    for(const other of cells.filter(c=>c.getAttribute('parent')===scope && /-block$/.test(c.getAttribute('id')) && c!==container)) {
      const y=position(other).y;
      if(y+num(geo(other),'height')>=threshold && (!previous || y<threshold))geo(other).setAttribute('y',String(num(geo(other),'y')+gap));
    }
    frame.setAttribute('expandedFramesAligned','2');
  };
  let changed=0;
  for(const start of cells.filter(c=>c.getAttribute('value')==='Start' && (c.getAttribute('graphLabels')||'').split(',').includes('FunctionStart'))) {
    const fn=start.getAttribute('functionStableId'),id=start.getAttribute('id')+'-return-signature';
    if(byId.has(id)){alignExpandedFrames(byId.get(id));continue;}
    const match=/^(.*):(\d+):(\d+):(\d+):(\d+)$/.exec(fn);if(!match)continue;
    const file=[roots.sourceRoot,roots.toolRoot].map(root=>path.resolve(root,match[1])).find(f=>fs.existsSync(f));if(!file)continue;
    const program=ts.createProgram([file],{target:ts.ScriptTarget.ESNext,noResolve:true,skipLibCheck:true});
    const sf=program.getSourceFile(file),checker=program.getTypeChecker(),offset=sf.getPositionOfLineAndCharacter(+match[2]-1,+match[3]);
    let declaration;
    function visit(n){if(n.getStart(sf)>offset||n.end<offset)return;if(ts.isFunctionLike(n)&&n.type)declaration=n;ts.forEachChild(n,visit);}
    visit(sf);
    const type=declaration?.type;
    if(!type||!ts.isTypeReferenceNode(type)||!type.typeArguments?.length)continue;
    const parameters=cells.filter(c=>(c.getAttribute('graphLabels')||'').split(',').includes('Parameter') && c.getAttribute('functionStableId')===fn && !/-part-/.test(c.getAttribute('id')));
    const last=parameters.sort((a,b)=>position(a).y-position(b).y).at(-1);if(!last)continue;
    const lastRow=byId.get(last.getAttribute('parent')),container=byId.get(lastRow?.getAttribute('parent'));if(!geo(lastRow)||!geo(container))continue;
    const cg=geo(container),base=position(container),rowGeo=geo(lastRow);
    const insertion=num(rowGeo,'y')+num(rowGeo,'height')+16;
    const variants=type.typeArguments.flatMap((arg,index)=>(ts.isUnionTypeNode(arg)?arg.types:[arg]).map((part,i)=>({text:part.getText(sf),index,union:i>0,system:part.kind===ts.SyntaxKind.VoidKeyword || part.kind===ts.SyntaxKind.NeverKeyword || part.kind===ts.SyntaxKind.UnknownKeyword,source:part})));
    const rowHeight=36,headerHeight=30,height=headerHeight+20+variants.length*rowHeight+14,gap=height+24;
    // Make space in the existing flow, preserving hand-positioned row contents.
    for(const cell of cells.filter(c=>c.getAttribute('parent')===container.getAttribute('id')&&c.getAttribute('vertex')==='1')) {
      const g=geo(cell);if(num(g,'y')>=insertion-16)g.setAttribute('y',String(num(g,'y')+gap));
    }
    for(const edge of cells.filter(c=>c.getAttribute('edge')==='1')) {
      if(!['source','target'].some(key=>byId.get(edge.getAttribute(key))?.getAttribute('functionStableId')===fn))continue;
      const parent=byId.get(edge.getAttribute('parent'));
      let cursor=parent,moved=false;
      while(cursor&&cursor!==container){if(cursor.getAttribute('parent')===container.getAttribute('id')&&num(geo(cursor),'y')>=insertion+gap-16)moved=true;cursor=byId.get(cursor.getAttribute('parent'));}
      if(moved)continue;
      const origin=position(parent);
      for(const point of Array.from(geo(edge)?.getElementsByTagName('mxPoint')||[])) {
        if(point.getAttribute('as')==='offset')continue;
        if(origin.y+num(point,'y')>=base.y+insertion-16)point.setAttribute('y',String(num(point,'y')+gap));
      }
    }
    for(let ancestor=container;ancestor&&geo(ancestor);ancestor=byId.get(ancestor.getAttribute('parent')))geo(ancestor).setAttribute('height',String(num(geo(ancestor),'height')+gap));
    const old=cells.find(c=>c.getAttribute('id')===start.getAttribute('id')+'-return-type');if(old)old.parentNode.removeChild(old);
    const name=type.typeName.getText(sf),symbol=checker.getSymbolAtLocation(type.typeName);
    const system=!!symbol?.declarations?.length&&symbol.declarations.every(d=>program.isSourceFileDefaultLibrary(d.getSourceFile()));
    const fill=system?'#E1D5E7':'#DAE8FC',stroke=system?'#9673A6':'#007FFF';
    const methodWidth=mosaicTextWidth(name)+24,listWidth=Math.max(...variants.map(v=>mosaicTextWidth(v.text)))+28;
    const frameWidth=Math.max(methodWidth,listWidth+44);
    const add=(cellId,value,style,parent,x,y,width,h,extra={})=>{
      const c=doc.createElement('mxCell');for(const[k,v]of Object.entries({id:cellId,value,style,parent,vertex:'1',connectable:'0',functionStableId:fn,returnTypePresentation:'1',...extra}))c.setAttribute(k,String(v));
      const g=doc.createElement('mxGeometry');for(const[k,v]of Object.entries({x,y,width,height:h,as:'geometry'}))g.setAttribute(k,String(v));c.appendChild(g);start.parentNode.appendChild(c);return c;
    };
    // Place alongside (not on) the runtime continuation lane.
    const frameX=position(start).x-base.x+num(geo(start),'width')/2+55;
    const frame=add(id,'','group;container=1;collapsible=0;',container.getAttribute('id'),frameX,insertion,frameWidth,height);
    alignExpandedFrames(frame);
    add(id+'-method',name,`shape=image;imageAspect=0;image=${methodImage('single',fill,stroke,{width:methodWidth})};html=1;align=center;verticalAlign=middle;fontSize=12;`,id,0,0,methodWidth,30,{graphLabels:system?'System,Type':'DeveloperDefined,Type'});
    const bracketHeight=variants.length*rowHeight+8;
    for(const [side,x]of [['left',0],['right',listWidth+24]]) {
      const d=side==='left'?`M 12 1 L 1 ${bracketHeight/2} L 12 ${bracketHeight-1}`:`M 1 1 L 12 ${bracketHeight/2} L 1 ${bracketHeight-1}`;
      const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 ${bracketHeight}"><path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.5"/></svg>`;
      add(id+'-'+side,'',`shape=image;imageAspect=0;image=data:image/svg+xml,${encodeURIComponent(svg)};`,id,x,40,14,bracketHeight,{typeDelimiter:side==='left'?'<':'>'});
    }
    variants.forEach((v,i)=>{
      const prefix=v.union?'|':v.index>0?',':'';
      if(prefix)add(id+'-separator-'+i,prefix,'text;html=0;fontColor=#9673A6;align=center;verticalAlign=middle;',id,15,44+i*rowHeight,12,30);
      add(id+'-variant-'+i,v.text,`rounded=0;html=1;whiteSpace=nowrap;align=left;spacingLeft=4;fillColor=${v.system?'#E1D5E7':'#D5E8D4'};strokeColor=${v.system?'#9673A6':'#82B366'};fontColor=#000000;fontSize=12;`,id,28,44+i*rowHeight,listWidth-8,30,{typeArgumentIndex:v.index,unionVariant:v.union?'1':'0'});
    });
    cg.setAttribute('width',String(Math.max(num(cg,'width'),frameX+frameWidth+20)));changed++;
  }
  // Keep the inter-function corridor, but anchor its terminal bends to moved heads.
  for(const edge of cells.filter(c=>c.getAttribute('edge')==='1')) {
    const source=byId.get(edge.getAttribute('source')),target=byId.get(edge.getAttribute('target'));
    if(!(target?.getAttribute('graphLabels')||'').split(',').includes('FunctionStart') || !source)continue;
    const points=Array.from(geo(edge)?.getElementsByTagName('mxPoint')||[]).filter(p=>p.getAttribute('as')!=='offset');
    if(points.length<2)continue;
    const origin=position(byId.get(edge.getAttribute('parent')));
    points[0].setAttribute('y',String(position(source).y+num(geo(source),'height')/2-origin.y));
    points.at(-1).setAttribute('y',String(position(target).y+num(geo(target),'height')/2-origin.y));
  }
  wireSignatureFlow(doc);
  return {xml:new XMLSerializer().serializeToString(doc),changed};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  import('./localCoordinateDrawio.mjs').then(({methodMosaicImage})=>{
  const file=process.argv[2];if(!file?.endsWith('.drawio'))throw Error('Expected .drawio file');
  const result=updateReturnTypeDiagrams(fs.readFileSync(file,'utf8'),methodMosaicImage);
  fs.writeFileSync(file,result.xml);console.log({changed:result.changed});
  }).catch(error=>{console.error(error);process.exitCode=1;});
}
