import fs from 'node:fs';
import {DOMParser,XMLSerializer} from '@xmldom/xmldom';
const file=process.argv[2],sourceId=process.argv[3];
const doc=new DOMParser().parseFromString(fs.readFileSync(file,'utf8'),'text/xml');
const cs=Array.from(doc.getElementsByTagName('mxCell')),byId=new Map(cs.map(c=>[c.getAttribute('id'),c]));
const geom=c=>Array.from(c?.childNodes||[]).find(n=>n.nodeName==='mxGeometry');
const x=c=>c?Number(geom(c)?.getAttribute('x')||0)+x(byId.get(c.getAttribute('parent'))):0;
const changed=[];
for(const c of cs){
  if(c.getAttribute('edgeType')!=='ARG'||c.getAttribute('source')!==sourceId)continue;
  const source=byId.get(sourceId),parent=byId.get(c.getAttribute('parent'));
  const turn=x(source)+Number(geom(source).getAttribute('width'))+24-x(parent);
  const points=Array.from(geom(c).getElementsByTagName('mxPoint')).filter(p=>p.getAttribute('as')!=='offset');
  if(points.length<2)continue;
  const old=Number(points[0].getAttribute('x'));
  if(old<=turn)continue;
  for(const p of points){if(Number(p.getAttribute('x'))!==old)break;p.setAttribute('x',String(turn));}
  c.setAttribute('style',c.getAttribute('style').replace(/sourceJettySize=[^;]+/,'sourceJettySize=24'));
  changed.push(c.getAttribute('id'));
}
fs.writeFileSync(file,new XMLSerializer().serializeToString(doc));console.log({changed});
