import fs from 'node:fs';
import assert from 'node:assert/strict';
import {DOMParser,XMLSerializer} from '@xmldom/xmldom';
import {structuredHorizontalSize,structuredRenderPartStyle} from './localCoordinateDrawio.mjs';
import {updatePropertyPuzzles} from './propertyPuzzle.mjs';

const [file,payloadFile]=process.argv.slice(2);
assert(file?.endsWith('.drawio') && payloadFile,'Usage: diagram.drawio extracted-payload.json');
const payload=JSON.parse(fs.readFileSync(payloadFile,'utf8'));
const doc=new DOMParser().parseFromString(fs.readFileSync(file,'utf8'),'text/xml');
const cells=Array.from(doc.getElementsByTagName('mxCell'));
const geo=c=>c.getElementsByTagName('mxGeometry')[0];
const changed=[];
for(const row of payload.nodes) {
  if(!row.renderPartsJson)continue;
  const parts=JSON.parse(row.renderPartsJson);
  if(!parts.some(p=>p.labels?.some(label=>['New','TypeArgument','FieldName'].includes(label))))continue;
  const id=row.stableId.value || row.stableId;
  const owner=cells.find(c=>c.getAttribute('stableId')===id && c.getAttribute('vertex')==='1' && !/-part-\d+$/.test(c.getAttribute('id')));
  if(!owner)continue;
  const node={id,labels:row.labels,props:{...row,renderPartsLayout:'horizontal'}};
  const layout=structuredHorizontalSize(node);
  assert(layout && layout.parts.length===parts.length);
  const ownerId=owner.getAttribute('id'),g=geo(owner),oldWidth=Number(g.getAttribute('width'));
  const previous=cells.filter(c=>c.getAttribute('parent')===ownerId && /-part-\d+$/.test(c.getAttribute('id')));
  const remap=new Map(previous.map(c=>[c.getAttribute('id'),parts.findIndex(p=>p.text===(c.getAttribute('puzzleOriginalLabel')||c.getAttribute('value')))]));
  for(const edge of cells.filter(c=>c.getAttribute('edge')==='1'))for(const terminal of ['source','target']) {
    const old=edge.getAttribute(terminal);
    if(!remap.has(old))continue;
    const index=remap.get(old);
    assert(index>=0,`Cannot silently discard connected mosaic part ${old}`);
    edge.setAttribute(terminal,ownerId+'-part-'+(index+1));
  }
  for(const child of previous)child.parentNode.removeChild(child);
  owner.setAttribute('value','');owner.setAttribute('style','group;html=1;container=1;collapsible=0;');
  g.setAttribute('width',String(layout.width)); g.setAttribute('height','30');
  g.setAttribute('x',String(Number(g.getAttribute('x'))+(oldWidth-layout.width)/2));
  let x=0;
  parts.forEach((part,index)=>{
    const child=owner.cloneNode(false);
    child.setAttribute('id',ownerId+'-part-'+(index+1));child.setAttribute('parent',ownerId);
    child.setAttribute('value',part.text);child.setAttribute('connectable','0');
    child.setAttribute('mosaicPartLabels',part.labels.join(','));
    child.setAttribute('style',structuredRenderPartStyle(node,part,index,parts.length,layout.widths[index]));
    child.setAttribute('sourceStableId',part.sourceStableId || id);
    const cg=doc.createElement('mxGeometry');
    for(const [key,value]of Object.entries({x,y:0,width:layout.widths[index],height:30,as:'geometry'}))cg.setAttribute(key,String(value));
    child.appendChild(cg);owner.parentNode.appendChild(child);x+=layout.widths[index];
  });
  changed.push({stableId:id,parts:parts.map(p=>({text:p.text,labels:p.labels}))});
}
const result=updatePropertyPuzzles(new XMLSerializer().serializeToString(doc));
fs.writeFileSync(file,result.xml);
console.log(JSON.stringify({changed,repairedRoutes:result.repairedRoutes}));
