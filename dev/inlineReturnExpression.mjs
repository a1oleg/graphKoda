import fs from 'node:fs';
import {DOMParser,XMLSerializer} from '@xmldom/xmldom';
import {measureMosaicTile,mosaicTileImage,SIDE_WIDTH} from './mosaicTileGeometry.mjs';
const file=process.argv[2],doc=new DOMParser().parseFromString(fs.readFileSync(file,'utf8'),'text/xml');
const cells=Array.from(doc.getElementsByTagName('mxCell'));
const byId=new Map(cells.map(c=>[c.getAttribute('id'),c]));
const g=c=>Array.from(c.childNodes).find(n=>n.nodeName==='mxGeometry');
const kids=c=>cells.filter(n=>n.getAttribute('parent')===c.getAttribute('id')&&n.getAttribute('vertex')==='1');
const changed=[];
for(const edge of cells){
 const call=byId.get(edge.getAttribute('source')),ret=byId.get(edge.getAttribute('target'));
 if(!call||!ret||call.getAttribute('graphKind')!=='Call'||ret.getAttribute('graphKind')!=='Return')continue;
 const a=kids(call),b=kids(ret);
 if(!a.length||a.length!==b.length||a.some((c,i)=>c.getAttribute('value')!==b[i].getAttribute('value')))continue;
 const width=Number(g(ret).getAttribute('width')),prefix=58;
 g(ret).setAttribute('x',String(Number(g(call).getAttribute('x')||0)-prefix));
 g(ret).setAttribute('y',g(call).getAttribute('y'));
 g(ret).setAttribute('width',String(width+prefix+18));
 for(const part of b)g(part).setAttribute('x',String(Number(g(part).getAttribute('x')||0)+prefix));
 for(const [suffix,text,x,w] of [['return-open','return(',0,prefix],['return-close',')',width+prefix,18]]){
  const c=doc.createElement('mxCell');c.setAttribute('id',ret.getAttribute('id')+'-'+suffix);c.setAttribute('value',text);c.setAttribute('parent',ret.getAttribute('id'));c.setAttribute('vertex','1');
  c.setAttribute('style','rounded=1;arcSize=50;whiteSpace=nowrap;html=0;fillColor=#E1D5E7;strokeColor=#9673A6;strokeWidth=1;fontSize=12;fontColor=#000000;');
  const geo=doc.createElement('mxGeometry');for(const [k,v] of Object.entries({x,y:0,width:w,height:30,as:'geometry'}))geo.setAttribute(k,String(v));c.appendChild(geo);ret.parentNode.appendChild(c);
 }
 for(const e of cells){
  if(e===edge)continue;
  for(const name of ['source','target'])if(e.getAttribute(name)===call.getAttribute('id'))e.setAttribute(name,ret.getAttribute('id'));
 }
 for(const c of [...a,call,edge])c.parentNode.removeChild(c);
 changed.push(ret.getAttribute('id'));
}
for(const c of Array.from(doc.getElementsByTagName('mxCell'))){
 const id=c.getAttribute('id'),open=id.endsWith('-return-open'),close=id.endsWith('-return-close');
 if(!open&&!close)continue;
 const text=open?'return(':')';
 const body='<svg xmlns="http://www.w3.org/2000/svg"><path fill="#E1D5E7" stroke="#9673A6"/></svg>';
 const layout=measureMosaicTile(text,body);
 layout.left=open?'round':'inward';layout.right=open?'inward':'round';
 layout.spacingLeft+=SIDE_WIDTH[layout.left];layout.spacingRight+=SIDE_WIDTH[layout.right];
 layout.width+=SIDE_WIDTH[layout.left]+SIDE_WIDTH[layout.right];
 const delta=layout.width-Number(g(c).getAttribute('width'));
 const parent=byId.get(c.getAttribute('parent'));
 if(open){
  // Preserve the expression's absolute position while making room for the text and caps.
  g(parent).setAttribute('x',String(Number(g(parent).getAttribute('x'))-delta));
  for(const sibling of Array.from(doc.getElementsByTagName('mxCell')).filter(n=>n!==c&&n.getAttribute('parent')===c.getAttribute('parent')&&n.getAttribute('vertex')==='1'))
   g(sibling).setAttribute('x',String(Number(g(sibling).getAttribute('x')||0)+delta));
 }
 g(parent).setAttribute('width',String(Number(g(parent).getAttribute('width'))+delta));
 g(c).setAttribute('width',String(layout.width));
 const image=mosaicTileImage(body,layout,Number(g(c).getAttribute('height')),{system:true});
 c.setAttribute('value',text);
 c.setAttribute('style',`shape=image;imageAspect=0;image=${image};whiteSpace=nowrap;overflow=hidden;html=0;align=left;verticalAlign=middle;fontSize=12;fontColor=#000000;spacing=0;spacingLeft=${layout.spacingLeft};spacingRight=${layout.spacingRight};`);
 changed.push(id);
}
fs.writeFileSync(file,new XMLSerializer().serializeToString(doc));console.log({changed});
