import fs from 'node:fs';
import {DOMParser,XMLSerializer} from '@xmldom/xmldom';
const file=process.argv[2];
const doc=new DOMParser().parseFromString(fs.readFileSync(file,'utf8'),'text/xml');
const changed=[];
for(const c of Array.from(doc.getElementsByTagName('mxCell'))) {
  if(c.getAttribute('edgeType')!=='ARG'||!c.getAttribute('value')||!c.getAttribute('style').includes('entryX=0;'))continue;
  c.setAttribute('style',c.getAttribute('style').replace(/(?:^|;)align=[^;]*;/g,';')+'align=right;');
  const g=Array.from(c.childNodes).find(n=>n.nodeName==='mxGeometry');
  g.setAttribute('x','1');
  let offset=Array.from(g.childNodes).find(n=>n.nodeName==='mxPoint'&&n.getAttribute('as')==='offset');
  if(!offset){offset=doc.createElement('mxPoint');g.appendChild(offset);}
  offset.setAttribute('as','offset');offset.setAttribute('x','-8');offset.setAttribute('y','0');
  changed.push(c.getAttribute('id'));
}
fs.writeFileSync(file,new XMLSerializer().serializeToString(doc));console.log({changed});
