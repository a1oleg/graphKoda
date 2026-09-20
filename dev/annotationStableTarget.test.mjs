import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {findMxCellXml} from '../graph/packages/orchestrator/src/orchestrator.js';
const xml=fs.readFileSync('graph/draw/generated/queryModel.drawio','utf8');
const stableId='services/api/claude.ts:1051:5:1051:27';
test('actual queryModel annotation target resolves by stableId despite stale or conflicting view hint',()=>{
 for(const cellId of [undefined,'obsolete-render-id','f0-n22']) {
  const cell=findMxCellXml(xml,{stableId,cellId});
  assert.match(cell,/<mxCell\b[^>]*\bid="f0-n9"/);
 }
 assert.equal(findMxCellXml(xml,{stableId:'missing-entity',cellId:'f0-n9'}),null);
});
