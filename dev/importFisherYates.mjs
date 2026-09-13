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
    const nodeGroups = Map.groupBy([...nodes.values()], n => n.labels.slice().sort().join(':') || 'CodeEntity');
    const ordinaryParameters = [...nodes.values()].filter(n => n.labels.includes('Parameter') && !n.labels.includes('OperationProvider')).map(n => n.id);
    await tx.run('MATCH (n) WHERE n.stableId IN $ids REMOVE n:OperationProvider:CapabilityBundle', { ids: ordinaryParameters });
    for (const [labels, rows] of nodeGroups) await tx.run(`UNWIND $rows AS row MERGE (n {stableId:row.id})
      SET n:${labels}, n += row.props,
        n.parentFlowBlockStableId = row.props.parentFlowBlockStableId,
        n.parentStepStableId = row.props.parentStepStableId`, { rows });
    const edgeGroups = Map.groupBy([...edges.values()], e => e.type);
    for (const [type, rows] of edgeGroups) await tx.run(`UNWIND $rows AS row MATCH (a {stableId:row.from}), (b {stableId:row.to})
      MERGE (a)-[r:${type} {extractionScope:'fisher-yates-flow'}]->(b) SET r += row.props`, { rows });
    await tx.run('MATCH (n {stableId:$id}) SET n.expandDeveloperCalls = true', { id: fisherYatesRoot });
  });
  const result = await aura.session.run('MATCH ()-[r {extractionScope:$scope}]->() RETURN count(r) AS count', { scope: 'fisher-yates-flow' });
  assert.equal(result.records[0].get('count').toNumber(), edges.size);
  console.log(JSON.stringify({ importedNodes: nodes.size, importedEdges: edges.size, root: fisherYatesRoot }));
} finally { await aura.session.close(); await aura.driver.close(); }
