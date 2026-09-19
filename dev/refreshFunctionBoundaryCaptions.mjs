// Scoped mechanical update: existing cells and routes must remain unchanged.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {DOMParser,XMLSerializer} from '@xmldom/xmldom';
import {methodMosaicImage} from './localCoordinateDrawio.mjs';
import {updateFunctionBoundaryCaptions,boundaryCaptionWidth} from './functionBoundaryCaption.mjs';
const serializer=new XMLSerializer();
function cells(xml){return Array.from(new DOMParser().parseFromString(xml,'text/xml').getElementsByTagName('mxCell'));}
for(const file of ['graph/draw/legend.drawio','graph/draw/generated/Fisher-Yates.drawio','graph/draw/generated/onSubmit-REPL.tsx-3142.drawio']) {
  const before=fs.readFileSync(file,'utf8').replace(/^\uFEFF/u,'');let after,changed;
  if(file.endsWith('legend.drawio')) {
    const doc=new DOMParser().parseFromString(before,'text/xml');
    const c=Array.from(doc.getElementsByTagName('mxCell')).find(c=>c.getAttribute('id')==='599');
    assert(c&&c.getAttribute('value')==='Function()');
    const width=boundaryCaptionWidth(c.getAttribute('value'));
    c.getElementsByTagName('mxGeometry')[0].setAttribute('width',String(width));
    c.setAttribute('style',c.getAttribute('style').replace(/image=[^;]+;/,`image=${methodMosaicImage('end','#DAE8FC','#007FFF',{width,torn:true})};`).replace('whiteSpace=wrap','whiteSpace=nowrap').replace(/(?:spacingLeft|spacingRight|fontSize)=[^;]*;/g,'')+'spacingLeft=12;spacingRight=10;fontSize=12;');
    after=serializer.serializeToString(doc);changed=[{id:'599',width}];
  } else ({xml:after,changed}=updateFunctionBoundaryCaptions(before,methodMosaicImage));
  const target=new Map(cells(after).map(c=>[c.getAttribute('id'),serializer.serializeToString(c)]));
  for(const c of cells(before)) {
    if(c.getAttribute('id')==='599'&&file.endsWith('legend.drawio'))continue;
    if(c.hasAttribute('functionBoundaryOwner'))continue;
    assert.equal(target.get(c.getAttribute('id')),serializer.serializeToString(c),'Unexpected edit: '+c.getAttribute('id'));
  }
  fs.writeFileSync(file,after);console.log(JSON.stringify({file,changed,existingCellsAndRoutesPreserved:true}));
}
