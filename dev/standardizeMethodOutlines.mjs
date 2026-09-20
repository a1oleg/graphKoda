import fs from 'node:fs';
import {DOMParser,XMLSerializer} from '@xmldom/xmldom';

// Update embedded artwork without regenerating layout or touching annotations.
const file=process.argv[2];
const doc=new DOMParser().parseFromString(fs.readFileSync(file,'utf8'),'text/xml');
const changed=[];
for(const c of Array.from(doc.getElementsByTagName('mxCell'))) {
  if(c.getAttribute('vertex')!=='1')continue;
  const labels=(c.getAttribute('graphLabels')||'').split(',');
  if(!labels.some(l=>['Method','Call','Request','Fn','Function','FunctionStart','FunctionEnd','FnDeclaration','Virtual'].includes(l)))continue;
  const before=c.getAttribute('style')||'';
  const after=before.replace(/image=data:image\/svg\+xml,([^;]+);/g,(_,data)=>{
    let svg=decodeURIComponent(data);
    svg=svg.replace(/<path\b[^>]*\bopacity=['"]0\.55['"][^>]*\/>/g,'');
    svg=svg.replace(/<path\b[^>]*vector-effect=['"]non-scaling-stroke['"][^>]*\/>/g,p=>p.replace(/stroke-width=['"][^'"]+['"]/g,"stroke-width='1'"));
    return `image=data:image/svg+xml,${encodeURIComponent(svg)};`;
  });
  if(after!==before){c.setAttribute('style',after);changed.push(c.getAttribute('id'));}
}
fs.writeFileSync(file,new XMLSerializer().serializeToString(doc));
console.log({changed});
