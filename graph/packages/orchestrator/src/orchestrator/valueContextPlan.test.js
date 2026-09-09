import test from 'node:test';
import assert from 'node:assert/strict';
import { buildValueContextPlan, contextIdentity } from './valueContextPlan.js';
const node = (id, extra = {}) => ({ id, stableId: id, state: 'EXPANDED', context: {}, ...extra });
test('target slice excludes unrelated uses and retains evidence of folded transfers', () => {
  const p = buildValueContextPlan({ runId: 'r', revision: 1, rootId: 'setter',
    nodes: ['setter','state','ref','arg','parameter','sink','other'].map(id => node(id)),
    edges: [['setter','state','WRITES_TO'], ['state','ref','RESOLVES_TO'], ['ref','arg','VALUE_FROM'],
      ['arg','parameter','BINDS_TO_PARAMETER'], ['parameter','sink','VALUE_FROM'], ['state','other','VALUE_FROM']]
      .map(([from,to,relation]) => ({from,to,relation})) }, 'sink');
  assert.equal(p.nodes.length, 4);
  assert.equal(p.edges.length, 3);
  assert.ok(!p.nodes.some(n => n.stableId === 'other'));
  assert.deepEqual(p.edges.flatMap(e => e.evidenceEdgeIndexes).sort(), [0,1,2,3,4]);
  assert.equal(p.fullMechanismVerified, false);
});
test('arrival history is not identity, different arguments and fields remain distinct', () => {
  const a = node('x', { context: { usagePath: ['a'], memberPath: ['x'] } });
  assert.equal(contextIdentity(a), contextIdentity({ ...a, context: { ...a.context, usagePath: ['b'] } }));
  assert.notEqual(contextIdentity(a), contextIdentity({ ...a, context: { memberPath: ['y'] } }));
});
test('missing target is not fabricated', () => {
  assert.throws(() => buildValueContextPlan({nodes:[node('a')],edges:[],rootId:'a'}, 'b'), /absent/);
});
