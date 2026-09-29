import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import { DOMParser } from '@xmldom/xmldom';
import { materializeMosaicVertices, projectMosaicGraph } from './mosaicVerticesV2.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
process.env.graphKoda_SOURCE_ROOT = root;
const { structuredHorizontalSize, makeDrawio } = await import('./localCoordinateDrawio.mjs');
const { loadFunctionDiagramSubgraph } = await import('../graph/packages/orchestrator/src/orchestrator/localCoordinateSync.js');
const { extractFunctionFlowGraphs, payloadForTransport } = await import('../graph/static-extract/ts/fromASTtoPreGraphFlow.ts');
const program = ts.createProgram([path.join(root, 'examples/fisher-yates/src/shuffle.ts')], {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: [], strict: true,
});
const original = payloadForTransport(extractFunctionFlowGraphs(program));
const payload = materializeMosaicVertices(structuredClone(original));
assert.equal(payload.functions.length, 3, 'Must exercise all three real functions');
assert.ok(payload.nodes.length > 0, 'Extraction must not be empty');
const baselineNodes = new Map();
for (const n of [...original.semanticEntities, ...original.resources, ...original.functions, ...original.nodes]) {
  const previous = baselineNodes.get(n.stableId);
  baselineNodes.set(n.stableId, { key: n.stableId,
    labels: [...new Set([...(previous?.labels || []), ...(n.labels || [])])],
    props: { ...previous?.props, ...n.props, stableId: n.stableId } });
}
const nodes = new Map();
for (const node of [...payload.semanticEntities, ...payload.resources, ...payload.functions, ...payload.nodes]) {
  const previous = nodes.get(node.stableId);
  nodes.set(node.stableId, { key: node.stableId, elementId: node.stableId,
    labels: [...new Set([...(previous?.labels || []), ...(node.labels || [])])],
    props: { ...previous?.props, ...node.props, stableId: node.stableId } });
}
const edges = [...payload.semanticRelationships, ...payload.resourceEdges, ...payload.resourceLinks, ...payload.edges]
  .map((e, i) => ({ id: `e${i}`, elementId: `e${i}`, start: e.fromId, end: e.toId,
    startElementId: e.fromId, endElementId: e.toId, type: e.type, props: e.props || {} }));

test('full Fisher graph has real routing endpoints and no descriptor JSON', () => {
  for (const node of nodes.values()) {
    if (!node.props.mosaicContractVersion) continue;
    assert.equal(node.props.render_parts_json, undefined);
    assert.equal(node.props.renderPartsJson, undefined);
    assert.equal(node.props.descriptorJson, undefined);
  }
  for (const edge of edges) {
    assert.ok(nodes.has(edge.start), edge.start);
    assert.ok(nodes.has(edge.end), edge.end);
    assert.equal(edge.props.source_render_part_stable_id, undefined);
    assert.equal(edge.props.target_render_part_stable_id, undefined);
  }
});

test('graph-backed mosaics preserve the size of every extracted Fisher composition', () => {
  const view = projectMosaicGraph([...nodes.values()], edges);
  for (const node of original.nodes) {
    const projected = view.nodes.find(n => n.key === node.stableId);
    if (!projected?.mosaicParts) continue;
    const baseline = baselineNodes.get(node.stableId);
    const dimensions = value => value && Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'parts'));
    assert.deepEqual(dimensions(structuredHorizontalSize(projected)), dimensions(structuredHorizontalSize(baseline)), node.stableId);
  }
});

test('draw.io tile bounds survive the switch from JSON to graph vertices', () => {
  const view = projectMosaicGraph([...nodes.values()], edges);
  let checked = 0;
  const geometry = node => {
    // Isolate tile geometry from the enclosing function's layout containers.
    const props = Object.fromEntries(Object.entries(node.props).filter(([key]) => !/(parent|owner).*?(step|block)/i.test(key)));
    const xml = makeDrawio([{ ...node, id: node.key, props: { ...props, displayX: 0, displayY: 0 } }], [],
      { suppressFoldingContainers: true, disableFoldingMechanics: true });
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    return [...doc.getElementsByTagName('mxCell')].filter(c => c.getAttribute('vertex') === '1')
      .map(c => ({ text: c.getAttribute('value'), bounds: [...c.getElementsByTagName('mxGeometry')]
        .map(g => ['x', 'y', 'width', 'height'].map(key => g.getAttribute(key))) }));
  };
  for (const node of original.nodes) {
    if ((node.labels || []).some(label => ['Step', 'Block', 'Fn', 'VisualProxy'].includes(label))) continue;
    const projected = view.nodes.find(n => n.key === node.stableId);
    if (!projected?.mosaicParts) continue;
    assert.deepEqual(geometry(projected), geometry(baselineNodes.get(node.stableId)), node.stableId);
    checked++;
  }
  assert.ok(checked >= 10, `Expected real mosaics, checked ${checked}`);
});

// Emulate the loader's bounded graph queries, not the geometry projection.
function driverFor(fnId) {
  const record = value => ({ get: key => value[key] });
  const response = value => ({ records: [record(value)] });
  const flowSource = 'semantic/functionFlowGraph';
  return { session: () => ({ close: async () => {}, async run(query, params) {
    if (query.includes('OPTIONAL MATCH (fn)-[relationship:NEXT')) {
      const owned = edges.filter(e => e.start === fnId && e.type === 'NEXT' && e.props.source === flowSource);
      return response({ fn: nodes.get(fnId), ownedNodes: owned.map(e => nodes.get(e.end)), ownershipEdges: owned });
    }
    if (query.includes('UNWIND $frontier')) {
      const found = edges.filter(e => params.frontier.includes(e.start) && e.props.source === flowSource
        && nodes.get(e.end)?.props.parentFnStableId === fnId);
      return response({ targetNodes: found.map(e => nodes.get(e.end)), relationships: found });
    }
    if (query.includes('reachedElementIds')) return response({ relationships: edges.filter(e => e.start === fnId && params.reachedElementIds.includes(e.end)) });
    if (query.includes('MATCH (anchor:ObjectBrace)')) return response({ nodes: [], relationships: [] });
    if (query.includes('UNWIND $stableIds')) return response({ nodes: params.stableIds.map(id => nodes.get(id)).filter(Boolean) });
    if (query.includes('COMPOSES_SYNTAX')) return response({ parts: [], relationships: [] });
    throw new Error(`Unexpected query: ${query}`);
  } }) };
}

test('production loader traverses graph tiles and groups them without restoring JSON', async () => {
  for (const fn of payload.functions) {
    const loaded = await loadFunctionDiagramSubgraph(driverFor(fn.stableId), 'test', fn.stableId);
    assert.ok(loaded.nodes.some(n => n.mosaicParts), fn.name);
    for (const n of loaded.nodes.filter(n => n.props.mosaicContractVersion)) {
      assert.ok(n.mosaicParts, n.key);
      assert.equal(n.props.renderPartsJson, undefined);
      assert.equal(n.props.render_parts_json, undefined);
    }
    for (const edge of loaded.edges) {
      for (const side of ['source', 'target']) {
        const endpoint = edge.props[`${side}RenderPartStableId`];
        if (endpoint) assert.ok(nodes.has(endpoint), endpoint);
      }
    }
  }
});
