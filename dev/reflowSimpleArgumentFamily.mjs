import fs from 'node:fs';
import {DOMParser,XMLSerializer} from '@xmldom/xmldom';
import {argumentFamilyMetrics} from './argumentFamilyMetrics.mjs';
import {alignEdgePorts} from './edgePortAlignment.mjs';
const file=process.argv[2],sourceId=process.argv[3];
const doc=new DOMParser().parseFromString(fs.readFileSync(file,'utf8'),'text/xml');
const cells=Array.from(doc.getElementsByTagName('mxCell')),byId=new Map(cells.map(c=>[c.getAttribute('id'),c]));
const g=c=>Array.from(c?.childNodes||[]).find(n=>n.nodeName==='mxGeometry');
const n=(c,k)=>Number(g(c)?.getAttribute(k)||0);
const x=c=>c?n(c,'x')+x(byId.get(c.getAttribute('parent'))):0;
const y=c=>c?n(c,'y')+y(byId.get(c.getAttribute('parent'))):0;
const source=byId.get(sourceId);
const args=cells.filter(c=>c.getAttribute('edgeType')==='ARG'&&c.getAttribute('source')===sourceId);
const targets=args.map(e=>byId.get(e.getAttribute('target')));
// Only complete leaf-argument families can be migrated without graph data.
const joins=targets.map(t=>cells.filter(e=>e.getAttribute('source')===t.getAttribute('id')&&e.getAttribute('edgeType')==='ArgJoin'));
if(args.length<2||joins.some(js=>js.length!==1)||new Set(joins.map(js=>js[0].getAttribute('target'))).size!==1)throw Error('Expected complete shared-close argument family');
const close=byId.get(joins[0][0].getAttribute('target'));
const right=x(source)+n(source,'width'),before=x(close)+n(close,'width')-right;
const metrics=argumentFamilyMetrics(targets.map((t,i)=>({width:n(t,'width'),labelWidth:(args[i].getAttribute('value')||'').length*7})));
targets.forEach((t,i)=>g(t).setAttribute('x',String(right+metrics.offsets[i]-x(byId.get(t.getAttribute('parent'))))));
g(close).setAttribute('x',String(right+metrics.closingOffset-x(byId.get(close.getAttribute('parent')))));
for(let i=0;i<args.length;i++) {
 const e=args[i],t=targets[i],eg=g(e),parent=byId.get(e.getAttribute('parent'));
 for(const a of Array.from(eg.childNodes))if(a.nodeName==='Array')eg.removeChild(a);
 const a=doc.createElement('Array');a.setAttribute('as','points');eg.appendChild(a);
 for(const [px,py] of [[right+metrics.stem,y(source)+n(source,'height')/2],[right+metrics.stem,y(t)+n(t,'height')/2],[x(t)-10,y(t)+n(t,'height')/2]]) {
  const p=doc.createElement('mxPoint');p.setAttribute('x',String(px-x(parent)));p.setAttribute('y',String(py-y(parent)));a.appendChild(p);
 }
}
const withinClose=id=>{for(let c=byId.get(id);c;c=byId.get(c.getAttribute('parent')))if(c===close)return true;return false;};
const affected=cells.filter(e=>e.getAttribute('edge')==='1'&&(withinClose(e.getAttribute('source'))||withinClose(e.getAttribute('target')))).map(e=>e.getAttribute('id'));
const result=alignEdgePorts(new XMLSerializer().serializeToString(doc),{cellIds:affected});
fs.writeFileSync(file,result.xml);
console.log({widthAfterCallBefore:before,widthAfterCallAfter:x(close)+n(close,'width')-right,metrics});
