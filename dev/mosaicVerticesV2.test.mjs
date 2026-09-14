import test from 'node:test';
import assert from 'node:assert/strict';
import { materializeMosaicVertices, applyMosaicVertices } from './mosaicVerticesV2.mjs';

test('four tiles remain distinct even with shared source coordinates', () => {
  const parts = ['alphabet', 'set(', "['A']", ')'].map(text => ({ text, sourceStableId: 'same' }));
  const payload = materializeMosaicVertices({ nodes: [{ stableId: 'owner', props: {
    render_parts_json: JSON.stringify(parts),
  } }], edges: [], semanticEntities: [], semanticRelationships: [] });
  assert.equal(new Set([...payload.nodes, ...payload.semanticEntities].map(n => n.stableId)).size, 4);
  assert.equal(payload.semanticRelationships.length, 3);
  assert.equal(payload.semanticRelationships[0].fromId, 'owner');
  assert.equal(payload.semanticRelationships[1].fromId, payload.semanticRelationships[0].toId);
  assert.equal(payload.semanticRelationships[2].fromId, payload.semanticRelationships[1].toId);
  assert.equal(payload.nodes[0].props.render_parts_json, undefined);
  const nodes = [{ key: 'owner', props: payload.nodes[0].props }];
  const records = [...payload.nodes, ...payload.semanticEntities].map(n => ({ owner: 'owner', part: n.props })).reverse();
  assert.deepEqual(JSON.parse(applyMosaicVertices(nodes, records)[0].props.render_parts_json).map(p => p.text), parts.map(p => p.text));
  assert.throws(() => applyMosaicVertices(nodes, records.slice(1)), /Incomplete/);
});

test('v1 render nodes are untouched', () => {
  const node = { key: 'legacy', props: { render_parts_json: '[]' } };
  assert.equal(applyMosaicVertices([node], [])[0], node);
});

test('literal source is reused and redundant evaluation is removed', () => {
  const payload = materializeMosaicVertices({ nodes: [
    { stableId: 'owner', labels: [], props: { producer_start_stable_id: 'eval', render_parts_json: JSON.stringify([
      { text: 'items' }, { text: 'set(' }, { text: '[]', kind: 'literal', sourceStableId: 'literal' }, { text: ')' },
    ]) } },
    { stableId: 'eval', labels: ['Evaluate'], props: { instrumentation_target_stable_id: 'literal' } },
  ], edges: [{ fromId: 'eval', toId: 'owner', type: 'ASSIGNS_VALUE' }],
  semanticEntities: [{ stableId: 'literal', labels: ['LiteralValue'], props: {} }],
  semanticRelationships: [{ fromId: 'owner', toId: 'literal', type: 'COMPOSES_SYNTAX' }] });
  assert.equal(payload.nodes.length, 1);
  assert.equal(payload.edges.length, 0);
  assert.equal(payload.semanticEntities.length, 3);
  assert.deepEqual(payload.semanticRelationships.map(e => [e.fromId, e.toId]), [
    ['owner', 'owner:mosaic-v2:part:1'], ['owner:mosaic-v2:part:1', 'literal'],
    ['literal', 'owner:mosaic-v2:part:3'],
  ]);
});

test('assignment has one variable identity and semantic layout edges', () => {
  const payload = materializeMosaicVertices({ nodes: [{ stableId: 'variable', labels: ['ValueSlot'], props: {
    container_method_kind: 'set', render_parts_json: JSON.stringify([
      { text: 'items' }, { text: 'set(', sourceStableId: 'declaration' },
      { text: '[]', kind: 'literal', sourceStableId: 'literal' }, { text: ')' },
    ]),
  } }], edges: [{ fromId: 'caller', toId: 'declaration', type: 'MATERIALIZES_ARGUMENT' }],
  semanticEntities: [
    { stableId: 'declaration', labels: ['ValueDeclaration'], props: { declarationKind: 'VariableDeclaration' } },
    { stableId: 'literal', labels: ['LiteralValue'], props: {} },
  ], semanticRelationships: [
    { fromId: 'reference', toId: 'declaration', type: 'RESOLVES_TO' },
    { fromId: 'declaration', toId: 'literal', type: 'VALUE_FROM' },
    { fromId: 'declaration', toId: 'literal', type: 'AST_CHILD', props: { field: 'initializer' } },
  ] });
  assert.ok(!payload.semanticEntities.some(n => n.stableId === 'declaration'));
  assert.equal(payload.edges[0].toId, 'variable');
  assert.equal(payload.semanticRelationships[0].toId, 'variable');
  const chain = payload.semanticRelationships.slice(1);
  assert.deepEqual(chain.map(e => e.type), ['WRITE', 'ARGUMENT', 'CLOSES']);
  assert.ok(chain.every(e => e.props.layout === 'mosaic'));
  assert.equal(chain[1].props.role, 'value');
  assert.equal(chain[1].props.index, 0);
  assert.deepEqual(payload.mergedMosaicNodeIds, [{ from: 'declaration', to: 'variable' }]);
});
