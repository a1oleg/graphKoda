import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import {DOMParser} from '@xmldom/xmldom';
import roots from './projectPaths.cjs';
import {awaitedTypeArgumentIndex} from '../graph/static-extract/ts/awaitedTypeContract.mjs';
import {updateAwaitedTypeDiagrams} from './awaitedTypeDrawio.mjs';

test('actual GrowthBook call uses its type argument as the awaited result',()=>{
  const load=file=>ts.createSourceFile(file,fs.readFileSync(path.join(roots.sourceRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
  const sf=load('services/api/claude.ts'),target=load('services/analytics/growthbook.ts');
  let call,declaration;
  const visit=n=>{if(ts.isCallExpression(n)&&n.expression.getText(sf)==='getDynamicConfig_BLOCKS_ON_INIT'&&n.typeArguments?.[0]?.getText(sf)==='{ activated: boolean }')call=n;ts.forEachChild(n,visit);};visit(sf);
  const decl=n=>{if(ts.isFunctionDeclaration(n)&&n.name?.text==='getDynamicConfig_BLOCKS_ON_INIT')declaration=n;ts.forEachChild(n,decl);};decl(target);
  assert(call&&declaration);assert.equal(awaitedTypeArgumentIndex(ts,call,declaration),0);
});

test('actual queryModel diagram keeps the awaited family below arguments and returns from its member',()=>{
  const xml=fs.readFileSync('graph/draw/generated/queryModel.drawio','utf8');
  const doc=new DOMParser().parseFromString(xml,'text/xml'),cells=Array.from(doc.getElementsByTagName('mxCell'));
  const children=id=>cells.filter(c=>c.getAttribute('parent')===id&&c.getAttribute('vertex')==='1');
  const opening=cells.find(c=>c.getAttribute('sourceCallStableId')==='services/api/claude.ts:1054:12:1059:7'&&c.getAttribute('awaitedTypePresentation')==='1'&&c.hasAttribute('locationStableId'));
  assert(opening);const tiles=children(opening.getAttribute('id'));
  assert.equal(tiles.length,1);assert.equal(tiles[0].getAttribute('value'),'getDynamicConfig_BLOCKS_ON_INIT(');
  const frame=cells.find(c=>c.getAttribute('id')===opening.getAttribute('id')+'-awaited-type');assert(frame);
  const members=children(frame.getAttribute('id'));
  assert(members.some(c=>c.getAttribute('puzzleOriginalLabel')==='.activated'));
  assert(members.some(c=>c.getAttribute('value')==='boolean'));
  const member=members.find(c=>c.getAttribute('puzzleOriginalLabel')==='.activated');
  assert(cells.some(c=>c.getAttribute('source')===member.getAttribute('id')&&c.getAttribute('edgeType')==='ASSIGNS_VALUE'));
  assert.equal(cells.filter(c=>c.getAttribute('edgeType')==='AWAITS_TYPE').length,1);
  assert.equal(updateAwaitedTypeDiagrams(xml).xml,xml,'repeat render must not duplicate or move the family');
});
