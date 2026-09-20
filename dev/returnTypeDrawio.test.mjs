import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DOMParser} from '@xmldom/xmldom';
import {updateReturnTypeDiagrams} from './returnTypeDrawio.mjs';
import {methodMosaicImage} from './localCoordinateDrawio.mjs';
const xml=fs.readFileSync(new URL('../graph/draw/generated/queryModel.drawio',import.meta.url),'utf8');
const cells=Array.from(new DOMParser().parseFromString(xml,'text/xml').getElementsByTagName('mxCell'));
const byId=new Map(cells.map(c=>[c.getAttribute('id'),c]));
const geo=c=>c.getElementsByTagName('mxGeometry')[0];
const num=(c,k)=>Number(geo(c)?.getAttribute(k)||0);
const pos=c=>{if(!c||c.getAttribute('id')==='1')return{x:0,y:0};const p=pos(byId.get(c.getAttribute('parent')));return{x:p.x+num(c,'x'),y:p.y+num(c,'y')};};

test('actual queryModel: return signature below parameters with vertical union and separate void',()=>{
  const method=cells.find(c=>c.getAttribute('value')==='AsyncGenerator');assert(method);
  const parent=method.getAttribute('parent'),frame=byId.get(parent);
  assert.match(decodeURIComponent(method.getAttribute('style')),/#E1D5E7/);
  const rows=cells.filter(c=>c.getAttribute('parent')===parent&&c.hasAttribute('typeArgumentIndex'));
  assert.deepEqual(rows.map(c=>c.getAttribute('value')),['StreamEvent','AssistantMessage','SystemAPIErrorMessage','void']);
  assert.deepEqual(rows.map(c=>c.getAttribute('typeArgumentIndex')),['0','0','0','1']);
  assert(rows.every((c,i)=>!i||num(c,'y')>num(rows[i-1],'y')));
  assert.deepEqual(cells.filter(c=>c.getAttribute('parent')===parent&&c.hasAttribute('typeDelimiter')).map(c=>c.getAttribute('typeDelimiter')),['<','>']);
  const parameter=byId.get('f0-n7');assert(pos(frame).y>=pos(parameter).y+num(parameter,'height'));
  assert(!byId.has('f0-n1-return-type'));
  assert(cells.some(c=>c.getAttribute('edgeType')==='SIGNATURE_RETURN'&&c.getAttribute('target')===method.getAttribute('id')));
  assert(cells.some(c=>c.getAttribute('edgeType')==='BODY_ENTRY'&&c.getAttribute('source')===method.getAttribute('id')));
  assert(cells.some(c=>c.getAttribute('edgeType')==='RETURN_TYPE_ARGUMENT'&&c.getAttribute('source')===method.getAttribute('id')));
  assert.equal(pos(method).x+num(method,'width')/2,pos(byId.get('f0-n7-part-1')).x+num(byId.get('f0-n7-part-1'),'width')/2);
  const body=decodeURIComponent(method.getAttribute('style'));
  assert.match(body,/ L [\d.]+ 15 L /,'Notch must have a sharp vertex, not a rounded join');
  for(const edge of cells.filter(c=>c.getAttribute('edgeType')==='SIGNATURE_PARAMETER'))assert.match(edge.getAttribute('style'),/strokeColor=#BE7000/);
});
test('actual queryModel: return signature refresh is idempotent',()=>{
  assert.equal(updateReturnTypeDiagrams(xml,methodMosaicImage).xml,xml);
});
test('actual expanded calls: last corridor bend stays aligned with function head',()=>{
  for(const id of ['f0-call-f1-','f0-call-f2-']){
    const edge=byId.get(id),target=byId.get(edge.getAttribute('target'));
    const points=Array.from(geo(edge).getElementsByTagName('mxPoint'));
    const origin=pos(byId.get(edge.getAttribute('parent')));
    assert.equal(Number(points.at(-1).getAttribute('y'))+origin.y,pos(target).y+num(target,'height')/2);
  }
});
