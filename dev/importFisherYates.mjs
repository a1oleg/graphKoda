import './extractFisherYates.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { auraConnection, fisherYatesRoot } from './fisherYatesConfig.mjs';

const payload = JSON.parse(fs.readFileSync(new URL('../tmp/fisher-yates/extracted.json', import.meta.url)));
const nodes = new Map();
function properties(props) {
  return Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [k, typeof v === 'object' && (!Array.isArray(v) || v.some(x => typeof x === 'object')) ? JSON.stringify(v) : v]));
}
for (const n of [...payload.semanticEntities, ...payload.resources, ...payload.functions, ...payload.nodes]) {
  const prior = nodes.get(n.stableId);
  nodes.set(n.stableId, { id: n.stableId, labels: [...new Set([...(prior?.labels || []), ...(n.labels || [])])],
    props: { ...prior?.props, ...properties(n.props), stableId: n.stableId } });
}
const edges = new Map();
for (const e of [...payload.semanticRelationships, ...payload.resourceEdges, ...payload.resourceLinks, ...payload.edges]) {
  if (!nodes.has(e.fromId) || !nodes.has(e.toId)) throw new Error(`Missing endpoint: ${e.type} ${e.fromId} -> ${e.toId}`);
  const key = JSON.stringify([e.fromId, e.type, e.toId]);
  edges.set(key, { from: e.fromId, to: e.toId, type: e.type, props: properties(e.props) });
}
for (const n of nodes.values()) for (const label of n.labels) assert.match(label, /^[A-Za-z_][A-Za-z0-9_]*$/);
for (const e of edges.values()) assert.match(e.type, /^[A-Za-z_][A-Za-z0-9_]*$/);
const aura = auraConnection();
try {
  await aura.session.executeWrite(async tx => {
    // Replace only the example's flow relationships. Context routes and annotations survive.
    await tx.run('MATCH ()-[r {extractionScope: $scope}]->() DELETE r', { scope: 'fisher-yates-flow' });
    // Remove obsolete experiment tiles only when no annotation/context edge owns them.
    await tx.run(`MATCH (n:MosaicPart) WHERE n.mosaicContractVersion = $version
      AND n.ownerStableId STARTS WITH 'examples/fisher-yates/'
      AND NOT n.stableId IN $ids AND NOT (n)--() DELETE n`,
    { version: 'mosaic-vertices/v2', ids: [...nodes.keys()] });
    await tx.run(`MATCH (n) WHERE n.stableId IN $ids AND NOT (n)--() DELETE n`,
      { ids: payload.obsoleteMosaicNodeIds || [] });
    const nodeGroups = Map.groupBy([...nodes.values()], n => n.labels.slice().sort().join(':') || 'CodeEntity');
    const ordinaryParameters = [...nodes.values()].filter(n => n.labels.includes('Parameter') && !n.labels.includes('OperationProvider')).map(n => n.id);
    await tx.run('MATCH (n) WHERE n.stableId IN $ids REMOVE n:OperationProvider:CapabilityBundle', { ids: ordinaryParameters });
    for (const [labels, rows] of nodeGroups) await tx.run(`UNWIND $rows AS row MERGE (n {stableId:row.id})
      SET n:${labels}, n += row.props,
        n.parentFlowBlockStableId = row.props.parentFlowBlockStableId,
        n.parentStepStableId = row.props.parentStepStableId,
        n.render_parts_json = row.props.render_parts_json,
        n.producer_start_stable_id = row.props.producer_start_stable_id,
        n.producer_end_stable_ids = row.props.producer_end_stable_ids`, { rows });
    const aliases = new Map((payload.mergedMosaicNodeIds || []).map(row => [row.from, row.to]));
    if (aliases.size) {
      // Preserve non-extraction context and annotation links before removing aliases.
      const references = await tx.run(`MATCH (a)-[r]->(b)
        WHERE a.stableId IN $ids OR b.stableId IN $ids
        RETURN DISTINCT a.stableId AS source, b.stableId AS target,
          type(r) AS type, properties(r) AS props`, { ids: [...aliases.keys()] });
      for (const record of references.records) {
        const row = record.toObject();
        assert.match(row.type, /^[A-Za-z_][A-Za-z0-9_]*$/);
        assert.ok(row.source && row.target, 'Cannot migrate a reference without stableId');
        const from = aliases.get(row.source) || row.source;
        const to = aliases.get(row.target) || row.target;
        await tx.run(`MATCH (a {stableId:$from}), (b {stableId:$to})
          CREATE (a)-[r:${row.type}]->(b) SET r = $props`, { from, to, props: row.props });
      }
      await tx.run('MATCH (n) WHERE n.stableId IN $ids DETACH DELETE n', { ids: [...aliases.keys()] });
    }
    const edgeGroups = Map.groupBy([...edges.values()], e => e.type);
    for (const [type, rows] of edgeGroups) await tx.run(`UNWIND $rows AS row MATCH (a {stableId:row.from}), (b {stableId:row.to})
      MERGE (a)-[r:${type} {extractionScope:'fisher-yates-flow'}]->(b) SET r += row.props`, { rows });
    await tx.run('MATCH (n {stableId:$id}) SET n.expandDeveloperCalls = true', { id: fisherYatesRoot });
  });
  const result = await aura.session.run('MATCH ()-[r {extractionScope:$scope}]->() RETURN count(r) AS count', { scope: 'fisher-yates-flow' });
  assert.equal(result.records[0].get('count').toNumber(), edges.size);
  for (const { from, to } of payload.mergedMosaicNodeIds || []) {
    const check = await aura.session.run(`MATCH (owner {stableId:$to})
      OPTIONAL MATCH (old {stableId:$from})
      WITH owner, count(old) AS oldCount
      MATCH p=(owner)-[:WRITE]->()-[:ARGUMENT]->()-[:CLOSES]->()
      RETURN oldCount, [r IN relationships(p) | r.layout] AS layouts`, { from, to });
    assert.equal(check.records.length, 1, `Expected one semantic assignment chain: ${to}`);
    assert.equal(check.records[0].get('oldCount').toNumber(), 0, `Declaration alias survived: ${from}`);
    assert.deepEqual(check.records[0].get('layouts'), ['mosaic', 'mosaic', 'mosaic']);
  }
  console.log(JSON.stringify({ importedNodes: nodes.size, importedEdges: edges.size, root: fisherYatesRoot }));
} finally { await aura.session.close(); await aura.driver.close(); }
