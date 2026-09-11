import fs from 'node:fs';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import neo4j from 'neo4j-driver';

const rootId = 'screens/REPL.tsx:3142:82:3146:3';
const objectId = 'components/PromptInput/PromptInput.tsx:1025:11:1029:9';
const scope = 'speculation-acceptance';
const config = dotenv.parse(fs.readFileSync(new URL('../graph/.env', import.meta.url)));
function connect(prefix) {
  const uri = config[`${prefix}NEO4J_URI`];
  assert.ok(uri && config[`${prefix}NEO4J_PASSWORD`]);
  if (prefix) assert.match(new URL(uri).hostname, /\.databases\.neo4j\.io$/);
  const driver = neo4j.driver(uri, neo4j.auth.basic(config[`${prefix}NEO4J_USERNAME`], config[`${prefix}NEO4J_PASSWORD`]));
  return { driver, session: driver.session({ database: config[`${prefix}NEO4J_DATABASE`] || 'neo4j' }) };
}
const source = connect('');
let target;
try {
  const graph = await source.session.executeRead(async tx => {
    const binding = await tx.run(`MATCH (o {stableId:$objectId})-[b:BINDS_TO_PARAMETER]->(p {stableId:$rootId}) RETURN properties(b) AS props`, { rootId, objectId });
    assert.equal(binding.records.length, 1, 'Expected one proven binding');
    const result = await tx.run(`MATCH (o {stableId:$objectId})-[r:HAS_PROPERTY|ENCLOSED_BY]->(n)
      RETURN o.stableId AS from, type(r) AS type, n.stableId AS to, properties(r) AS props
      UNION ALL
      MATCH (o {stableId:$objectId})-[:HAS_PROPERTY]->(p)-[r:VALUE_FROM|RESOLVES_TO]->(v)
      RETURN p.stableId AS from, type(r) AS type, v.stableId AS to, properties(r) AS props`, { objectId });
    const edges = result.records.map(r => r.toObject());
    assert.equal(edges.filter(e => e.type === 'HAS_PROPERTY').length, 3);
    edges.push({ from: rootId, to: objectId, type: 'VALUE_FROM', props: {
      ...binding.records[0].get('props'), evidenceRelation: 'BINDS_TO_PARAMETER', evidenceDirection: 'reverse',
    } });
    const ids = [...new Set(edges.flatMap(e => [e.from, e.to]))];
    const nodes = await tx.run('MATCH (n) WHERE n.stableId IN $ids RETURN n.stableId AS id, labels(n) AS labels, properties(n) AS props', { ids });
    assert.equal(nodes.records.length, ids.length);
    return { edges, nodes: nodes.records.map(r => r.toObject()) };
  });
  const labelSet = new Set(['Parameter', 'ObjectConstruction', 'ArgumentValue', 'PropertyValue', 'ValueReference', 'ValueDeclaration', 'FunctionImplementation']);
  const fields = new Set(['name', 'syntax', 'repoRelativePath', 'startLine', 'startColumn', 'endLine', 'endColumn', 'index', 'source_state_id', 'provenance_id']);
  target = connect('AURA_');
  await target.session.executeWrite(async tx => {
    for (const node of graph.nodes) {
      const check = await tx.run('MATCH (n {stableId:$id}) RETURN count(n) AS count', { id: node.id });
      assert.ok(check.records[0].get('count').toNumber() <= 1, `Duplicate ${node.id}`);
      const labels = ['CodeEntity', ...node.labels.filter(l => labelSet.has(l))].join(':');
      const props = Object.fromEntries(Object.entries(node.props).filter(([k]) => fields.has(k)));
      await tx.run(`MERGE (n {stableId:$id}) SET n:${labels}, n += $props`, { id: node.id, props });
    }
    // Remove only the previous authored horizon, preserving unrelated graph data.
    await tx.run(`MATCH (n {stableId:$rootId})-[r]->() WHERE r.scope=$scope AND r.derivation='curated-source-route' DELETE r`, { rootId, scope });
    for (const edge of graph.edges) {
      assert.match(edge.type, /^[A-Z_]+$/);
      await tx.run(`MATCH (a {stableId:$from}), (b {stableId:$to}) MERGE (a)-[r:${edge.type}]->(b)
        SET r += $props, r.scope=$scope, r.derivation='source-graph-projection'`, { ...edge, scope });
    }
    const check = await tx.run(`MATCH (n {stableId:$rootId})-[r]->(o) WHERE r.scope=$scope RETURN type(r) AS type, o.stableId AS id`, { rootId, scope });
    assert.equal(check.records.length, 1);
    assert.equal(check.records[0].get('type'), 'VALUE_FROM');
    assert.equal(check.records[0].get('id'), objectId);
  });
  const check = await target.session.run(`MATCH (n {stableId:$rootId})-[:VALUE_FROM]->(o)-[:HAS_PROPERTY]->(p)
    RETURN p.name AS field, p.stableId AS stableId ORDER BY p.index`, { rootId });
  assert.equal(check.records.length, 3);
  console.log(JSON.stringify({ nodes: graph.nodes.length, edges: graph.edges.length, fields: check.records.map(r => r.toObject()) }, null, 2));
} finally {
  await source.session.close(); await source.driver.close();
  if (target) { await target.session.close(); await target.driver.close(); }
}
