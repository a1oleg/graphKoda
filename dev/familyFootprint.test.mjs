import test from 'node:test';
import assert from 'node:assert/strict';
import {familyMembers} from './familyFootprint.mjs';
test('owner footprint includes nested arguments and closures, not evaluation or continuation',()=>{
  const edges=[['set','arg','ARG'],['arg','field','FIELD'],['field','close','FieldJoin'],['close','end','ArgJoin'],['set','producer','EVAL'],['set','next','NEXT'],['end','arg','ARG']].map(([start,end,type])=>({start,end,type}));
  assert.deepEqual([...familyMembers('set',edges)],['set','arg','field','close','end']);
  assert.deepEqual([...familyMembers('set',edges,new Set(['arg']))],['set']);
});
