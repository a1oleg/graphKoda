import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {DOMParser} from '@xmldom/xmldom';
import {compactBlockEntries} from './compactBlockEntry.mjs';
test('real logEvent branch has compact block and content insets',()=>{
  const xml=fs.readFileSync('graph/draw/generated/queryModel.drawio','utf8');
  const d=new DOMParser().parseFromString(xml,'text/xml'),cells=Array.from(d.getElementsByTagName('mxCell'));
  const g=c=>Array.from(c.childNodes).find(n=>n.nodeName==='mxGeometry');
  const row=cells.find(c=>c.getAttribute('id')==='f0-fold-row-18');
  assert.equal(Number(g(row).getAttribute('y')),12);
  assert.equal(Math.min(...cells.filter(c=>c.getAttribute('parent')===row.getAttribute('id')&&c.getAttribute('vertex')==='1').map(c=>Number(g(c).getAttribute('y')))),12);
  const r=compactBlockEntries(xml,{targetStableId:'services/api/claude.ts:1062:4:1062:42'});
  assert.deepEqual(r.changed,[]);assert.equal(r.xml,xml);
});
