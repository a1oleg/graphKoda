import test from 'node:test';
import assert from 'node:assert/strict';
import { materializeMosaicVertices, applyMosaicVertices, projectMosaicGraph } from './mosaicVerticesV2.mjs';
import { validateMosaicChains } from '../graph/packages/orchestrator/src/orchestrator/mosaicGraph.js';

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
  assert.deepEqual(applyMosaicVertices(nodes, records)[0].mosaicParts.map(p => p.text), parts.map(p => p.text));
  assert.equal(applyMosaicVertices(nodes, records)[0].props.render_parts_json, undefined);
  assert.ok(records.every(r => !r.part.descriptorJson));
  assert.throws(() => applyMosaicVertices(nodes, records.slice(1)), /Incomplete/);
});

test('v1 render nodes are untouched', () => {
  const node = { key: 'legacy', props: { render_parts_json: '[]' } };
  assert.equal(applyMosaicVertices([node], [])[0], node);
});

function endpointFixture() {
  return materializeMosaicVertices({ nodes: [{ stableId: 'owner', labels: ['ValueSlot'], props: {
    parentStepStableId: 'step', parentFnStableId: 'fn', source: 'semantic/functionFlowGraph',
    render_parts_json: JSON.stringify([
      { stableId: 'box', text: 'items', kind: 'collection-container' },
      { stableId: 'setter', text: 'set(', kind: 'method' },
      { stableId: 'close', text: ')', kind: 'punctuation' },
    ]),
  } }, { stableId: 'producer', props: {} }], semanticEntities: [], semanticRelationships: [],
  edges: [{ fromId: 'producer', toId: 'owner', type: 'ASSIGNS_VALUE',
    props: { target_render_part_stable_id: 'setter' } }] });
}

function graphFixture(payload) {
  return {
    nodes: [...payload.nodes, ...payload.semanticEntities].map(n => ({ key: n.stableId, labels: n.labels, props: n.props })),
    edges: [...payload.edges, ...payload.semanticRelationships].map(e => ({ start: e.fromId, end: e.toId, type: e.type, props: e.props })),
  };
}

test('value addresses a real setter vertex; geometry only groups that vertex', () => {
  const payload = endpointFixture();
  assert.equal(payload.edges[0].toId, 'owner:mosaic-v2:part:1');
  assert.equal(payload.edges[0].props.target_render_part_stable_id, undefined);
  const graph = graphFixture(payload);
  const view = projectMosaicGraph(graph.nodes, graph.edges);
  assert.equal(view.nodes.length, 2);
  assert.equal(view.edges[0].end, 'owner');
  assert.equal(view.edges[0].props.targetRenderPartStableId, payload.edges[0].toId);
  assert.equal(view.nodes[0].mosaicParts[1].stableId, payload.edges[0].toId);
  assert.ok(view.nodes.every(n => !n.props.render_parts_json && !n.props.descriptorJson));
});

test('a missing chain link fails even when every tile exists', () => {
  const { nodes, edges } = graphFixture(endpointFixture());
  assert.throws(() => validateMosaicChains(nodes, edges.slice(0, -1)), /Broken mosaic chain/);
});

test('a cycle or reordered chain cannot pass by matching only tile count', () => {
  const { nodes, edges } = graphFixture(endpointFixture());
  edges.at(-1).end = 'owner';
  assert.throws(() => validateMosaicChains(nodes, edges), /Broken mosaic chain/);
});

test('tiles cannot silently move into a different Step', () => {
  const { nodes, edges } = graphFixture(endpointFixture());
  nodes.find(n => n.key === 'owner:mosaic-v2:part:1').props.parentStepStableId = 'other';
  assert.throws(() => validateMosaicChains(nodes, edges), /crosses Step ownership/);
});

test('single tile compositions also have a graph contract, not a JSON fallback', () => {
  const payload = materializeMosaicVertices({ nodes: [{ stableId: 'only', props: {
    render_parts_json: JSON.stringify([{ stableId: 'only', text: 'x', kind: 'value' }]),
  } }], edges: [], semanticEntities: [], semanticRelationships: [] });
  const graph = graphFixture(payload);
  assert.equal(projectMosaicGraph(graph.nodes, graph.edges).nodes[0].mosaicParts[0].text, 'x');
  assert.equal(payload.nodes[0].props.render_parts_json, undefined);
});

test('unknown explicit endpoint fails extraction instead of attaching to the whole owner', () => {
  assert.throws(() => materializeMosaicVertices({ nodes: [], semanticEntities: [], semanticRelationships: [],
    edges: [{ fromId: 'a', toId: 'b', type: 'EVAL', props: { source_render_part_stable_id: 'missing' } }] }), /Unresolved mosaic endpoint/);
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
