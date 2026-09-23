import {DOMParser,XMLSerializer} from '@xmldom/xmldom';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

// Final visual policy: bold belongs to boxes/stacks and hatched surfaces,
// not to semantic labels such as Call, System or Operator. Preserve italics.
export function updateDiagramTypography(xml,{compactReturns=false}={}) {
  const doc=new DOMParser().parseFromString(xml,'text/xml');
  const cells=Array.from(doc.getElementsByTagName('mxCell'));
  const changed=[];
  for(const c of cells) {
    if(c.getAttribute('edge')==='1'&&c.getAttribute('edgeType')==='ARG'
      &&/^arg\s+\d+$/i.test(c.getAttribute('value')||'')
      &&!c.getAttribute('argumentName')&&!c.getAttribute('fieldName')) {
      c.setAttribute('value','');changed.push(c.getAttribute('id'));
    }
    if(c.getAttribute('vertex')!=='1'||c.getAttribute('graphKind')==='Annotation')continue;
    const before=c.toString();
    const s=new Map((c.getAttribute('style')||'').split(';').filter(Boolean).map(p=>{const i=p.indexOf('=');return i<0?[p,'']:[p.slice(0,i),p.slice(i+1)];}));
    const image=s.get('image')||'';
    let svg=image.startsWith('data:image/svg+xml,')?decodeURIComponent(image.slice('data:image/svg+xml,'.length)):'';
    if(svg.includes('clip-path')) {
      const shape=new DOMParser().parseFromString(svg,'image/svg+xml');
      for(const p of Array.from(shape.getElementsByTagName('path'))) {
        if(!p.hasAttribute('clip-path')||!p.hasAttribute('stroke'))continue;
        p.setAttribute('fill','none');p.setAttribute('stroke-width','4');p.removeAttribute('opacity');p.removeAttribute('stroke-opacity');
      }
      svg=new XMLSerializer().serializeToString(shape);
      s.set('image','data:image/svg+xml,'+encodeURIComponent(svg));
    }
    // Method outlines stay one pixel even when their SVG tile is resized.
    // Hatching is a separate stroke: never thin the clipped hatch paths.
    if(svg) {
      const shape=new DOMParser().parseFromString(svg,'image/svg+xml');
      let normalized=false;
      for(const p of Array.from(shape.getElementsByTagName('path'))) {
        if(p.hasAttribute('clip-path'))continue;
        const color=(p.getAttribute('stroke')||'').toLowerCase();
        if(!['#007fff','#0088ff','#99ccff','#6c8ebf','#9673a6','#b85450','#ff0000'].includes(color))continue;
        if(color==='#99ccff')p.setAttribute('stroke','#007FFF');
        p.setAttribute('stroke-width','1');
        p.setAttribute('vector-effect','non-scaling-stroke');normalized=true;
      }
      if(normalized){svg=new XMLSerializer().serializeToString(shape);s.set('image','data:image/svg+xml,'+encodeURIComponent(svg));}
    }
    const box=svg.includes('M5 32 L27 17 L115 25 L93 40 Z');
    const hatch=svg.includes('sketch-fill')||/clip-path=['"]url\(#[^)]+\)['"]/.test(svg);
    const stack=/viewBox=['"]0 0 137 65['"]/.test(svg);
    const backingLabel=s.get('part')==='1'&&s.has('text')&&(s.get('spacingTop')==='9'||s.get('spacingTop')==='7');
    const bold=box||hatch||stack||backingLabel;
    const old=Number(s.get('fontStyle')||0);
    if(c.hasAttribute('graphKind')||s.has('fontStyle'))s.set('fontStyle',String(bold?old|1:old&~1));
    c.setAttribute('style',[...s].map(([k,v])=>v?`${k}=${v};`:`${k};`).join(''));
    if(compactReturns&&c.getAttribute('graphKind')==='Return'&&c.getAttribute('value')==='Return') {
      const g=Array.from(c.childNodes).find(n=>n.nodeName==='mxGeometry');
      if(g&&Number(g.getAttribute('width'))>72) {
        g.setAttribute('x',String(Number(g.getAttribute('x'))+(Number(g.getAttribute('width'))-72)/2));
        g.setAttribute('width','72');g.setAttribute('height','28');
      }
    }
    if(c.toString()!==before)changed.push(c.getAttribute('id'));
  }
  return {xml:new XMLSerializer().serializeToString(doc),changed};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const file=process.argv[2];const r=updateDiagramTypography(fs.readFileSync(file,'utf8'),{compactReturns:true});
  fs.writeFileSync(file,r.xml);console.log({changed:r.changed});
}
