import fs from 'node:fs';
import assert from 'node:assert/strict';
import {DOMParser,XMLSerializer} from '@xmldom/xmldom';
import {decodeMosaicImage,mosaicTileImage,mosaicTextWidth,SIDE_WIDTH,TEXT_PAD} from './mosaicTileGeometry.mjs';

// Targeted label refresh: retain fixed caps, row origins, links and manual layout.
const [file,...pairs]=process.argv.slice(2);
assert(file&&pairs.length&&pairs.length%2===0,'Usage: relabelMosaic <file> <old> <new> ...');
const replacements=new Map();
for(let i=0;i<pairs.length;i+=2)replacements.set(pairs[i],pairs[i+1]);
const doc=new DOMParser().parseFromString(fs.readFileSync(file,'utf8'),'text/xml');
const cells=Array.from(doc.getElementsByTagName('mxCell'));
const geo=c=>Array.from(c.childNodes).find(n=>n.nodeName==='mxGeometry');
const num=(c,k)=>Number(geo(c).getAttribute(k)||0);
const rows=new Map(),changed=[];
for(const c of cells.filter(c=>c.getAttribute('vertex')==='1')){
 const parent=c.getAttribute('parent');
 if(!rows.has(parent))rows.set(parent,[]);
 rows.get(parent).push(c);
}
for(const [parent,row]of rows){
 row.sort((a,b)=>num(a,'x')-num(b,'x'));
 let shift=0;
 for(const c of row){
  if(shift)geo(c).setAttribute('x',String(num(c,'x')+shift));
  const old=c.getAttribute('value');
  if(!replacements.has(old))continue;
  const text=replacements.get(old),style=c.getAttribute('style'),body=decodeMosaicImage(style);
  assert(body,`No mosaic image: ${c.getAttribute('id')}`);
  const left=c.getAttribute('mosaicLeftSide'),right=c.getAttribute('mosaicRightSide');
  assert(left in SIDE_WIDTH&&right in SIDE_WIDTH,'Missing cap geometry');
  const textWidth=mosaicTextWidth(text,{fontSize:Number(/(?:^|;)fontSize=([\d.]+)/.exec(style)?.[1]||12),bold:/(?:^|;)fontStyle=[1357](?:;|$)/.test(style)});
  const width=textWidth+2*TEXT_PAD+SIDE_WIDTH[left]+SIDE_WIDTH[right];
  shift+=width-num(c,'width');geo(c).setAttribute('width',String(width));
  c.setAttribute('value',text);c.setAttribute('puzzleOriginalLabel',(left==='tab'?'.':'')+text);
  c.setAttribute('mosaicTextWidth',String(textWidth));
  c.setAttribute('style',style.replace(/image=[^;]+;/,`image=${mosaicTileImage(body,{width,left,right},num(c,'height'))};`));
  changed.push({id:c.getAttribute('id'),text,width});
 }
 if(shift){const p=cells.find(c=>c.getAttribute('id')===parent);geo(p).setAttribute('width',String(num(p,'width')+shift));}
}
assert(changed.length>=replacements.size,'Some labels were not found');
fs.writeFileSync(file,new XMLSerializer().serializeToString(doc));
console.log(JSON.stringify({changed}));
