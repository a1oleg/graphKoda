import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {createRequire} from 'node:module';
import {DOMParser} from '@xmldom/xmldom';
import roots from './projectPaths.cjs';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {classify}=require('../graph/vscode-source-colors/classify.js');
const {constructorSemantics}=require('../graph/vscode-source-colors/constructorSemantics.cjs');

test('actual queryModel: generic object type and argument field have semantic tile colors',()=>{
  const d=new DOMParser().parseFromString(fs.readFileSync('graph/draw/generated/queryModel.drawio','utf8'),'text/xml');
  const cells=Array.from(d.getElementsByTagName('mxCell'));
  const name=cells.find(c=>c.getAttribute('value')==='getDynamicConfig_BLOCKS_ON_INIT');
  const parts=cells.filter(c=>c.getAttribute('parent')===name.getAttribute('parent'));
  assert.deepEqual(parts.map(c=>c.getAttribute('value')),['await','getDynamicConfig_BLOCKS_ON_INIT','<','{','activated:','boolean','}','>','(']);
  const svg=c=>decodeURIComponent(/image=data:image\/svg\+xml,([^;]+)/.exec(c.getAttribute('style'))[1]);
  for(const i of [3,6]){assert.match(svg(parts[i]),/#FFFFFF/);assert.match(svg(parts[i]),/#000000/);}
  for(const field of cells.filter(c=>c.getAttribute('value')==='activated:')){
    assert.match(svg(field),/#FFFFFF/);assert.match(field.getAttribute('style'),/fontColor=#BE7000;/);
    assert.match(field.getAttribute('style'),/fontStyle=2;/);
  }
  assert.match(svg(parts[5]),/#E1D5E7/);assert.match(svg(parts[5]),/#9673A6/);
  assert.match(svg(parts[8]),/#DAE8FC/);assert.match(svg(parts[8]),/#007FFF/);
  const ids=new Set(cells.map(c=>c.getAttribute('id')));
  for(const edge of cells.filter(c=>c.getAttribute('edge')==='1'))for(const key of ['source','target'])assert(ids.has(edge.getAttribute(key)));
});

test('actual queryModel: new and Error parentheses have independent syntax colors',()=>{
  const file=path.join(roots.sourceRoot,'services/api/claude.ts');
  const text=fs.readFileSync(file,'utf8');
  const start=text.indexOf('new Error(CUSTOM_OFF_SWITCH_MESSAGE)');
  assert(start>=0);
  const marks=classify(ts,file,text).filter(m=>m.start>=start && m.end<=start+'new Error(CUSTOM_OFF_SWITCH_MESSAGE)'.length);
  for(const token of ['Error','(',')'])assert(marks.some(m=>m.text===token && m.role==='systemError'),token);
  assert(marks.some(m=>m.text==='new' && m.role==='system'));
});

test('actual extractor implementation: local class construction is developer-defined',()=>{
  const file=path.resolve('graph/static-extract/ts/fromASTtoPreGraphFlow.ts');
  const p=ts.createProgram([file],{target:ts.ScriptTarget.ESNext,noResolve:true});
  const sf=p.getSourceFile(file),checker=p.getTypeChecker();let count=0;
  function visit(node){
    if(ts.isNewExpression(node)){
      const symbol=checker.getSymbolAtLocation(node.expression);
      if(symbol?.declarations?.some(d=>ts.isClassDeclaration(d)&&d.getSourceFile()===sf)){
        const result=constructorSemantics(ts,checker,node.expression);
        assert.equal(result.system,false);assert.equal(result.error,false);count++;
      }
    }
    ts.forEachChild(node,visit);
  }
  visit(sf);assert(count>0);
});

test('actual queryModel diagram: four tiles, constructor and closing bracket red',()=>{
  const d=new DOMParser().parseFromString(fs.readFileSync('graph/draw/generated/queryModel.drawio','utf8'),'text/xml');
  const cells=Array.from(d.getElementsByTagName('mxCell'));
  const keyword=cells.find(c=>c.getAttribute('value')==='new' && c.getAttribute('mosaicPartLabels').includes('New'));
  assert(keyword);
  const parts=cells.filter(c=>c.getAttribute('parent')===keyword.getAttribute('parent'));
  assert.deepEqual(parts.map(c=>c.getAttribute('value')),['new','Error(','CUSTOM_OFF_SWITCH_MESSAGE',')']);
  const svg=c=>decodeURIComponent(/image=data:image\/svg\+xml,([^;]+)/.exec(c.getAttribute('style'))[1]);
  assert.match(svg(parts[0]),/#E1D5E7/);
  for(const c of [parts[1],parts[3]]) {assert.match(svg(c),/#F8CECC/);assert.match(svg(c),/#CC0000/);}
});
