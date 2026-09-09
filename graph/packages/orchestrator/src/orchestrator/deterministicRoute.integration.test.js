import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import neo4j from 'neo4j-driver';
import { executeAnnotationGraphql } from './annotationGraphql.js';

test('GraphQL route persists, resumes, caches and detects new hard facts', {
  skip: process.env.ANNOTATION_GRAPHQL_INTEGRATION !== '1',
}, async () => {
  config({ path: 'graph/.env', quiet: true });
  const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(
    process.env.NEO4J_USER || process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD));
  const database = process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j';
  const session = driver.session({ database });
  const prefix = `det-route-test:${randomUUID()}`, id = `${prefix}:parameter`;
  const invoke = (query, variables) => executeAnnotationGraphql({ query, variables }, { driver, database });
  const start = () => invoke('mutation($id:ID!){startDeterministicRoute(input:{stableId:$id}){runId revision status}}', { id });
  const nextQuery = 'mutation($id:ID!,$rev:Int!){nextDeterministicRoute(runId:$id,expectedRevision:$rev){runId revision status results events}}';
  const runIds = [];
  try {
    await session.run(`CREATE (p:Parameter {stableId:$id, testRun:$prefix})
      CREATE (a:ObjectConstruction:ArgumentValue {stableId:$arg, testRun:$prefix})
      CREATE (c:Call {stableId:$call, testRun:$prefix})
      CREATE (f:FunctionImplementation {stableId:$fn, testRun:$prefix})
      CREATE (a)-[:BINDS_TO_PARAMETER {index:0}]->(p),
        (c)-[:HAS_ARGUMENT {index:0}]->(a), (a)-[:ENCLOSED_BY]->(f)`,
    { id, prefix, arg: `${prefix}:arg`, call: `${prefix}:call`, fn: `${prefix}:fn` });
    const started = await start();
    assert.equal(started.errors, undefined);
    const runId = started.data.startDeterministicRoute.runId;
    runIds.push(runId);
    const one = await invoke(nextQuery, { id: runId, rev: 0 });
    assert.equal(one.errors, undefined);
    assert.equal(one.data.nextDeterministicRoute.status, 'PAUSED');
    const duplicate = await invoke(nextQuery, { id: runId, rev: 0 });
    assert.match(duplicate.errors[0].message, /revision conflict/);
    const snapshot = await invoke('query($id:ID!){deterministicRoute(runId:$id){revision}}', { id: runId });
    assert.equal(snapshot.data.deterministicRoute.revision, 1);
    const two = await invoke(nextQuery, { id: runId, rev: 1 });
    assert.equal(two.errors, undefined);
    assert.equal(two.data.nextDeterministicRoute.status, 'COMPLETE');
    assert.equal(two.data.nextDeterministicRoute.results[0].ownerId, `${prefix}:fn`);
    const cached = await start();
    assert.equal(cached.data.startDeterministicRoute.runId, runId);
    await session.run(`MATCH (p {stableId:$id})
      CREATE (a:LiteralValue {stableId:$arg, testRun:$prefix})
      CREATE (c:Call {stableId:$call, testRun:$prefix})
      CREATE (a)-[:BINDS_TO_PARAMETER {index:0}]->(p), (c)-[:HAS_ARGUMENT {index:0}]->(a)`,
    { id, prefix, arg: `${prefix}:extraArg`, call: `${prefix}:extraCall` });
    const stale = await invoke(nextQuery, { id: runId, rev: 2 });
    assert.equal(stale.data.nextDeterministicRoute.status, 'STALE');
    const renewed = await start();
    runIds.push(renewed.data.startDeterministicRoute.runId);
    assert.notEqual(renewed.data.startDeterministicRoute.runId, runId);
  } finally {
    await session.run('MATCH (n {testRun:$prefix}) DETACH DELETE n', { prefix });
    await session.run('MATCH (r:DeterministicRouteRun) WHERE r.runId IN $ids DELETE r', { ids: runIds });
    await session.close(); await driver.close();
  }
});
