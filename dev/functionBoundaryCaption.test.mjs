import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DOMParser} from '@xmldom/xmldom';
import {boundaryCaptionWidth,updateFunctionBoundaryCaptions} from './functionBoundaryCaption.mjs';
import {methodMosaicImage} from './localCoordinateDrawio.mjs';
for(const file of ['graph/draw/generated/Fisher-Yates.drawio','graph/draw/generated/onSubmit-REPL.tsx-3142.drawio'])test(file,()=>{
  const xml=fs.readFileSync(file,'utf8');
  assert.equal(updateFunctionBoundaryCaptions(xml,methodMosaicImage).xml,xml,'Scoped update must be idempotent');
  const doc=new DOMParser().parseFromString(xml,'text/xml');
  const cells=Array.from(doc.getElementsByTagName('mxCell'));
  const captions=cells.filter(c=>c.hasAttribute('functionBoundaryOwner'));
  assert(captions.length>=2);
  for(const c of captions){
    const svg=decodeURIComponent(c.getAttribute('style').match(/image=data:image\/svg\+xml,([^;]+)/)[1]);
    assert(svg.includes('H 0 C 2.567 45.87'),'Inner concave boundary must survive width changes');
    const g=c.getElementsByTagName('mxGeometry')[0];
    const owner=cells.find(o=>o.getAttribute('id')===c.getAttribute('functionBoundaryOwner'));
    const og=owner.getElementsByTagName('mxGeometry')[0];
    assert.equal(+g.getAttribute('width'),boundaryCaptionWidth(c.getAttribute('value')));
    assert.equal(+g.getAttribute('x'),+og.getAttribute('x')+ +og.getAttribute('width'));
    assert.equal(c.getAttribute('parent'),owner.getAttribute('parent'));
  }
});
