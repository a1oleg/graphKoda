import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import neo4j from 'neo4j-driver';
import { config } from 'dotenv';
import { startOrchestrator } from '../orchestrator.js';

test('HTTP GraphQL workflow on isolated Neo4j records', {
  skip: process.env.ANNOTATION_GRAPHQL_INTEGRATION !== '1',
}, async () => {
  config({ path: 'graph/.env', quiet: true });
  const settings = { uri: process.env.NEO4J_URI,
    user: process.env.NEO4J_USER || process.env.NEO4J_USERNAME,
    password: process.env.NEO4J_PASSWORD,
    database: process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j' };
  const driver = neo4j.driver(settings.uri, neo4j.auth.basic(settings.user, settings.password));
  const session = driver.session({ database: settings.database });
  const fixture = `graphql-test:${randomUUID()}`;
  let server;
  try {
    await session.run(`
      CREATE (j:AnnotationJob {jobId:$fixture, rootStableId:$fixture, maxDepth:1, status:'pending', testFixture:$fixture})
      CREATE (r:Annotation {annotationId:$fixture, headID:$fixture, annotationKind:'Binding', status:'pending', testFixture:$fixture})
      CREATE (c:Annotation {annotationId:$child, headID:$child, annotationKind:'Binding', status:'pending', testFixture:$fixture})
      CREATE (j)-[:ROOT]->(r), (r)-[:DEPENDS_ON {role:'origin',ordinal:0}]->(c)
      WITH j,r,c
      UNWIND [r,c] AS a
      CREATE (t:AnnotationTask {taskId:a.annotationId, status:'pending', testFixture:$fixture})
      CREATE (j)-[:HAS_TASK]->(t), (t)-[:GENERATES]->(a)
    `, { fixture, child: `${fixture}:child` });
    server = await startOrchestrator({ ...settings, port: 0 });
    const schema = await (await fetch(`${server.url}api/annotations/graphql/schema`)).json();
    assert.match(schema.sdl, /type AnnotationPlan/);
    const request = async (query, variables = {}) => {
      const result = await (await fetch(`${server.url}api/annotations/graphql`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }),
      })).json();
      assert.equal(result.errors, undefined, JSON.stringify(result));
      assert.ok(result.data, JSON.stringify(result));
      return result.data;
    };
    const observe = 'query($j:ID!){annotationPlan(jobId:$j){state nodes{id state} edges{from to} working{id} available{id} waiting{id}}}';
    const plan = (await request(observe, { j: fixture })).annotationPlan;
    assert.equal(plan.state, 'PAUSED');
    assert.equal(plan.nodes.length, 2);
    assert.equal(plan.edges.length, 1);
    const next = 'mutation($j:ID!){nextAnnotation(jobId:$j){state task{jobId taskId annotationId leaseToken completion} plan{state}}}';
    const leased = (await request(next, { j: fixture })).nextAnnotation;
    assert.equal(leased.state, 'LEASED');
    assert.equal(leased.task.annotationId, `${fixture}:child`);
    assert.equal(leased.task.completion.endpoint, '/api/annotations/graphql');
    assert.equal((await request(next, { j: fixture })).nextAnnotation.state, 'WAITING');
    const { completion, ...identity } = leased.task;
    const saved = await request('mutation($input:AnnotationResultInput!){completeAnnotation(input:$input){state working{id} available{id}}}', {
      input: { ...identity, text: 'Isolated integration fixture annotation.' },
    });
    assert.equal(saved.completeAnnotation.state, 'PAUSED');
    assert.equal(saved.completeAnnotation.working.length, 0);
    assert.deepEqual(saved.completeAnnotation.available.map(n => n.id), [fixture]);
    const persisted = await session.run('MATCH (a:Annotation {annotationId:$id}) RETURN a.text AS text, a.toolGitCommitShortHash AS commit, a.maxDepth AS depth', { id: `${fixture}:child` });
    assert.equal(persisted.records[0].get('text'), 'Isolated integration fixture annotation.');
    assert.ok(persisted.records[0].get('commit'));
    assert.equal(Number(persisted.records[0].get('depth')), 1);
  } finally {
    if (server) await server.stop();
    await session.run('MATCH (n) WHERE n.testFixture=$fixture DETACH DELETE n', { fixture });
    await session.close();
    await driver.close();
  }
});
