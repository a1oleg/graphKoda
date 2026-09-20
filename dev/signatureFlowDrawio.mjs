import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import roots from './projectPaths.cjs';
const geo=c=>Array.from(c?.childNodes||[]).find(n=>n.nodeName==='mxGeometry');
const n=(c,k)=>Number(geo(c)?.getAttribute(k)||0);
const labels=c=>(c?.getAttribute('graphLabels')||'').split(',');

export function wireSignatureFlow(doc) {
  const cells=Array.from(doc.getElementsByTagName('mxCell')),byId=new Map(cells.map(c=>[c.getAttribute('id'),c]));
  const pos=c=>{if(!c||c.getAttribute('id')==='1')return{x:0,y:0};const p=pos(byId.get(c.getAttribute('parent')));return{x:p.x+n(c,'x'),y:p.y+n(c,'y')};};
  const typeEdge=(e,type,color)=>{
    e.setAttribute('edgeType',type);e.setAttribute('relationshipType',type);e.setAttribute('value','');
    e.setAttribute('style',e.getAttribute('style').replace(/(?:strokeColor|fontColor)=[^;]*;/g,'')+`strokeColor=${color};fontColor=${color};`);
    e.setAttribute('link',e.getAttribute('link').replace(/([?&](?:type|edgeType)=)(?:NEXT|BODY_ENTRY|SIGNATURE_RETURN)/g,`$1${type}`));
  };
  for(const edge of cells.filter(c=>c.getAttribute('edge')==='1')) {
    const source=byId.get(edge.getAttribute('source')),target=byId.get(edge.getAttribute('target'));
    if(labels(target).includes('Parameter')&&(labels(source).includes('Parameter')||labels(source).includes('FunctionStart')))
      typeEdge(edge,'SIGNATURE_PARAMETER','#BE7000');
  }
  for(const frame of cells.filter(c=>/-return-signature$/.test(c.getAttribute('id')))) {
    const id=frame.getAttribute('id'),method=byId.get(id+'-method');
    if(!method || frame.getAttribute('signatureFlowVersion')==='1')continue;
    const fn=frame.getAttribute('functionStableId'),start=byId.get(id.replace(/-return-signature$/,''));
    const match=/^(.*):(\d+):(\d+):(\d+):(\d+)$/.exec(fn);if(!match)continue;
    const file=[roots.sourceRoot,roots.toolRoot].map(r=>path.resolve(r,match[1])).find(f=>fs.existsSync(f));if(!file)continue;
    const sf=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true),offset=sf.getPositionOfLineAndCharacter(+match[2]-1,+match[3]);let type;
    function visit(node){if(node.getStart(sf)>offset||node.end<offset)return;if(ts.isFunctionLike(node)&&node.type)type=node.type;ts.forEachChild(node,visit);}visit(sf);if(!type)continue;
    const stable=node=>{const a=sf.getLineAndCharacterOfPosition(node.getStart(sf)),b=sf.getLineAndCharacterOfPosition(node.end);return `${match[1]}:${a.line+1}:${a.character}:${b.line+1}:${b.character}`;};
    const returnId=stable(type),args=ts.isTypeReferenceNode(type)?type.typeArguments||[]:[];
    method.setAttribute('stableId',returnId);method.setAttribute('sourceStableId',returnId);
    method.setAttribute('graphLabels',method.getAttribute('graphLabels')+',ReturnType,Signature');
    const last=cells.filter(c=>labels(c).includes('Parameter')&&c.getAttribute('functionStableId')===fn&&/-part-1$/.test(c.getAttribute('id'))).sort((a,b)=>pos(a).y-pos(b).y).at(-1)||start;
    const continuation=cells.find(c=>c.getAttribute('edge')==='1'&&c.getAttribute('source')===last?.getAttribute('id')&&!labels(byId.get(c.getAttribute('target'))).includes('Parameter'));
    if(!continuation)continue;
    const parent=byId.get(frame.getAttribute('parent')),axis=pos(last).x+n(last,'width')/2-pos(parent).x;
    geo(frame).setAttribute('x',String(axis-n(method,'width')/2));
    const left=byId.get(id+'-left'),right=byId.get(id+'-right'),bracketHeight=n(left,'height'),listX=n(method,'width')+60;
    const oldListX=n(left,'x'),oldListY=n(left,'y');
    for(const child of cells.filter(c=>c.getAttribute('parent')===id&&c!==method)){
      geo(child).setAttribute('x',String(n(child,'x')-oldListX+listX));
      geo(child).setAttribute('y',String(n(child,'y')-oldListY));
      if(child.hasAttribute('typeArgumentIndex')){
        const arg=args[Number(child.getAttribute('typeArgumentIndex'))];if(arg)child.setAttribute('stableId',stable(arg));
      }
    }
    geo(method).setAttribute('y',String(bracketHeight/2-15));
    geo(frame).setAttribute('width',String(n(right,'x')+n(right,'width')));
    const w=n(method,'width');
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 30"><path d="M 10 .5 H ${w-.5} L ${w-8.5} 15 L ${w-.5} 29.5 H 10 C -2 22 -2 8 10 .5 Z" fill="#E1D5E7" stroke="#9673A6" stroke-width="1"/></svg>`;
    method.setAttribute('style',`shape=image;imageAspect=0;image=data:image/svg+xml,${encodeURIComponent(svg)};html=1;whiteSpace=nowrap;align=left;spacingLeft=12;spacingRight=10;verticalAlign=middle;fontSize=12;`);
    const addEdge=(edgeId,source,target,type,color,style,parentId)=>{
      const e=doc.createElement('mxCell');for(const[k,v]of Object.entries({id:edgeId,source,target,edge:'1',parent:parentId,edgeType:type,relationshipType:type,style:`edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;strokeColor=${color};fontColor=${color};${style}`}))e.setAttribute(k,v);
      const g=doc.createElement('mxGeometry');g.setAttribute('relative','1');g.setAttribute('as','geometry');e.appendChild(g);frame.parentNode.appendChild(e);return e;
    };
    const incoming=addEdge(id+'-declaration',last.getAttribute('id'),method.getAttribute('id'),'SIGNATURE_RETURN','#9673A6','exitX=0.5;exitY=1;entryX=0.5;entryY=0;',frame.getAttribute('parent'));
    incoming.setAttribute('sourceStableId',last.getAttribute('stableId'));incoming.setAttribute('targetStableId',returnId);
    continuation.setAttribute('source',method.getAttribute('id'));typeEdge(continuation,'BODY_ENTRY','#007FFF');
    // Old waypoints described a direct parameter-to-body segment.
    for(const child of Array.from(geo(continuation)?.childNodes||[]))if(child.nodeName==='Array')geo(continuation).removeChild(child);
    const argumentEdge=addEdge(id+'-type-arguments',method.getAttribute('id'),left.getAttribute('id'),'RETURN_TYPE_ARGUMENT','#9673A6','exitX=1;exitY=0.5;exitPerimeter=0;entryX=0;entryY=0.5;entryPerimeter=0;',id);
    argumentEdge.setAttribute('sourceStableId',returnId);argumentEdge.setAttribute('targetStableIds',JSON.stringify(args.map(stable)));
    frame.setAttribute('signatureFlowVersion','1');
  }
}
