import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import neo4j from 'neo4j-driver';
import { executeAnnotationGraphql } from './annotationGraphql.js';

test('persistent origin discovery advances once and rejects replay', {
  skip: process.env.ANNOTATION_GRAPHQL_INTEGRATION !== '1',
}, async () => {
  config({ path: 'graph/.env', quiet: true });
  const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(process.env.NEO4J_USER || process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD));
  const database = process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j';
  const session = driver.session({ database });
  const id = `origin-test:${randomUUID()}`;
  let runId;
  let structureRunId;
  try {
    await session.run(`CREATE (p:Parameter {stableId:$id})
      CREATE (a:LiteralValue {stableId:$arg, syntax:'42'})
      CREATE (c:Call {stableId:$call})
      CREATE (a)-[:BINDS_TO_PARAMETER {index:0}]->(p), (c)-[:HAS_ARGUMENT {index:0}]->(a)`,
    { id, arg: `${id}:arg`, call: `${id}:call` });
    const run = async (query, variables) => executeAnnotationGraphql({ query, variables }, { driver, database });
    const started = await run('mutation($id:ID!){startValueOrigin(input:{stableId:$id}){runId revision nodes{id state}}}', { id });
    assert.equal(started.errors, undefined);
    runId = started.data.startValueOrigin.runId;
    assert.equal(started.data.startValueOrigin.nodes.length, 1);
    const query = 'mutation($id:ID!,$rev:Int!){nextValueOrigin(runId:$id,expectedRevision:$rev){revision status nodes{id stableId state context} edges{relation evidence}}}';
    const first = await run(query, { id: runId, rev: 0 });
    assert.equal(first.errors, undefined);
    assert.equal(first.data.nextValueOrigin.revision, 1);
    assert.equal(first.data.nextValueOrigin.nodes.length, 2);
    assert.equal(first.data.nextValueOrigin.nodes[1].context.callSiteId, `${id}:call`);
    const replay = await run(query, { id: runId, rev: 0 });
    assert.match(replay.errors[0].message, /revision conflict/);
    const read = await run('query($id:ID!){valueOriginPlan(runId:$id){revision nodes{state}}}', { id: runId });
    assert.equal(read.data.valueOriginPlan.revision, 1);
    assert.equal(read.data.valueOriginPlan.nodes[1].state, 'PENDING');
    const last = await run(query, { id: runId, rev: 1 });
    assert.equal(last.errors, undefined);
    assert.equal(last.data.nextValueOrigin.status, 'COMPLETE');
    await session.run(`MATCH (p {stableId:$id})
      CREATE (t:TypeAliasDeclaration {stableId:$type})
      CREATE (ref:TypeReference {stableId:$ref})
      CREATE (p)-[:TYPED_AS]->(ref)-[:RESOLVES_TO]->(t)
      FOREACH (name IN ['first','second','third'] |
        CREATE (m:MemberDeclaration {stableId:$id + ':' + name, name:name})
        CREATE (t)-[:HAS_MEMBER]->(m))`, { id, type: `${id}:type`, ref: `${id}:ref` });
    await session.run(`MATCH (a {stableId:$arg}), (first {stableId:$first}), (second {stableId:$second})
      CREATE (f:PropertyValue {stableId:$id + ':field'})
      CREATE (s:ValueDeclaration {stableId:$id + ':setter'})
      CREATE (a)-[:HAS_PROPERTY]->(f)-[:SATISFIES_MEMBER]->(first), (f)-[:RESOLVES_TO]->(s)
      CREATE (sibling:PropertyValue {stableId:$id + ':sibling'})
      CREATE (wrong:Fn {stableId:$id + ':wrong'})
      CREATE (a)-[:HAS_PROPERTY]->(sibling)-[:SATISFIES_MEMBER]->(second), (sibling)-[:VALUE_FROM]->(wrong)
      CREATE (other:PropertyValue {stableId:$id + ':other'})
      CREATE (other)-[:SATISFIES_MEMBER]->(first), (other)-[:VALUE_FROM]->(wrong)`,
    { id, arg: `${id}:arg`, first: `${id}:first`, second: `${id}:second` });
    const structured = await run('mutation($id:ID!){startValueOrigin(input:{stableId:$id}){runId}}', { id });
    assert.equal(structured.errors, undefined);
    structureRunId = structured.data.startValueOrigin.runId;
    const horizon = await run(query, { id: structureRunId, rev: 0 });
    assert.equal(horizon.errors, undefined);
    assert.equal(horizon.data.nextValueOrigin.nodes.length, 4);
    assert.ok(horizon.data.nextValueOrigin.edges.every(e => e.relation === 'HAS_MEMBER'));
    const member = await run(query, { id: structureRunId, rev: 1 });
    assert.equal(member.errors, undefined);
    const expanded = member.data.nextValueOrigin;
    assert.equal(expanded.nodes.length, 5);
    assert.equal(expanded.nodes.at(-1).stableId, `${id}:setter`);
    assert.deepEqual(expanded.nodes.at(-1).context.frames[0].memberPath, ['first']);
    assert.ok(!expanded.nodes.some(n => [`${id}:arg`, `${id}:wrong`, `${id}:field`].includes(n.stableId)));
    assert.deepEqual(expanded.edges.at(-1).evidence.path.nodes, [`${id}:first`, `${id}:field`, `${id}:setter`]);
  } finally {
    await session.run('MATCH (n) WHERE n.stableId IN $ids DETACH DELETE n', {
      ids: ['type','ref','first','second','third','field','setter','sibling','wrong','other'].map(suffix => `${id}:${suffix}`),
    });
    await session.run('MATCH (p:Parameter {stableId:$id}) DETACH DELETE p', { id });
    await session.run('MATCH (a:LiteralValue {stableId:$id}) DETACH DELETE a', { id: `${id}:arg` });
    await session.run('MATCH (c:Call {stableId:$id}) DETACH DELETE c', { id: `${id}:call` });
    if (runId) await session.run('MATCH (r:ValueOriginRun {runId:$id}) DELETE r', { id: runId });
    if (structureRunId) await session.run('MATCH (r:ValueOriginRun {runId:$id}) DELETE r', { id: structureRunId });
    await session.close(); await driver.close();
  }
});
