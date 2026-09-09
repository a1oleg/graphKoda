import test from 'node:test';
import assert from 'node:assert/strict';
import { findContextProviders, inspectValueUsage, transferUsage } from './valueUsage.js';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import neo4j from 'neo4j-driver';
import { inspectOrigin } from './valueOrigin.js';
const records = values => ({ records: values.map(value => ({ toObject: () => value })) });

test('nearest provider shadows outer provider on each ancestry path, preserving alternatives', async () => {
  const queried = [];
  const parents = { read: ['left', 'right'], left: ['inner'], right: ['outer'], inner: ['outer'] };
  const session = { async run(query, { id }) {
    queried.push(id);
    if (query.includes('n:ComponentConstruction')) return records([]);
    if (query.includes('PROVIDES_CONTEXT')) return records(['inner', 'outer'].includes(id)
      ? [{ stableId: `${id}:value`, fieldId: `${id}:field` }] : []);
    if (query.includes('JSX_CHILD')) return records((parents[id] || []).map(stableId => ({
      stableId, relation: 'JSX_CHILD', properties: { conditions: JSON.stringify([{ outcome: id === 'left' }]) },
    })));
    return records([]);
  } };
  const result = await findContextProviders(session, 'read', 'context');
  assert.deepEqual(result.providers.map(p => p.providerId), ['inner', 'outer']);
  assert.equal(result.providers[0].path.at(-1).to, 'inner');
  assert.deepEqual(result.gaps, []);
  assert.equal(queried.filter(id => id === 'outer').length, 1);
});

test('unknown ancestry and cycles remain explicit, not global context matches', async () => {
  const session = { async run(query, { id }) {
    if (query.includes('PROVIDES_CONTEXT')) { assert.match(query, /providerStableId=\$id/); return records([]); }
    return records(id === 'cycle' ? [{ stableId: 'cycle', relation: 'JSX_CHILD', properties: {} }] : []);
  } };
  assert.equal((await findContextProviders(session, 'missing', 'context')).gaps[0].reason, 'COMPONENT_ANCESTRY_MISSING');
  assert.equal((await findContextProviders(session, 'cycle', 'context')).gaps[0].reason, 'PROVIDER_RECURSION');
});

test('direct calls do not hide component wrapper bindings and their call sites', async () => {
  const session = { async run(query, { id }) {
    if (query.includes('n:ComponentConstruction')) return records([]);
    if (query.includes('PROVIDES_CONTEXT')) return records(id === 'provider' ? [{ stableId: 'value', fieldId: 'field' }] : []);
    if (query.includes('JSX_CHILD')) return records(['call', 'direct-call'].includes(id) ? [{ stableId: 'provider', relation: 'JSX_CHILD' }] : []);
    if (query.includes('WRAPS|ALIASES')) return records(id === 'fn' ? [{ stableId: 'wrapper', relation: 'WRAPS' }]
      : id === 'wrapper' ? [{ stableId: 'binding', relation: 'VALUE_FROM' }] : []);
    if (query.includes('(call)-[r:CALLS]')) return records(id === 'binding' ? [{ stableId: 'call', relation: 'CALLS' }]
      : id === 'fn' ? [{ stableId: 'direct-call', relation: 'CALLS' }] : []);
    return records([]);
  } };
  const result = await findContextProviders(session, 'fn', 'context');
  assert.deepEqual(result.gaps, []);
  assert.deepEqual(result.providers.map(p => p.path.map(e => e.relation)),
    [['CALLS', 'JSX_CHILD'], ['WRAPS', 'VALUE_FROM', 'CALLS', 'JSX_CHILD']]);
});

test('consumer traversal uses value edges, never common type membership', async () => {
  const result = await inspectValueUsage({ async run(query) {
    assert.doesNotMatch(query, /SATISFIES_MEMBER|TYPED_AS|HAS_MEMBER/);
    if (query.includes('container:ObjectConstruction')) return records([]);
    assert.match(query, /BINDS_TO_PARAMETER/);
    return records([{ stableId: 'reader', relation: 'RESOLVES_TO', direction: 'incoming' }]);
  } }, { stableId: 'state', context: { frames: [] } });
  assert.equal(result.children[0].context.selection, 'usage');
  assert.equal(result.children[0].stableId, 'reader');
});

test('field usage survives containers and bindings without including sibling fields', () => {
  const root = { stableId: 'value', context: { selection: 'usage', frames: [] } };
  const object = transferUsage(root, { stableId: 'object', relation: 'HAS_PROPERTY', properties: { propertyName: 'offset' } });
  assert.deepEqual(object.context.memberPath, ['offset']);
  const parameter = transferUsage(object, { stableId: 'props', relation: 'BINDS_TO_PARAMETER', properties: { index: 0, callSiteStableId: 'call' } });
  assert.equal(parameter.context.frames[0].callSiteId, 'call');
  assert.equal(transferUsage(parameter, { relation: 'READS_FROM', properties: { propertyName: 'text' } }), null);
  assert.deepEqual(transferUsage(parameter, { relation: 'READS_FROM', properties: { propertyName: 'offset' } }).context.memberPath, []);
});

test('later explicit properties overwrite spreads; unknown spreads stay unresolved', () => {
  const item = { stableId: 'spread', context: { memberPath: ['offset'], frames: [] } };
  const row = { stableId: 'object', relation: 'SPREADS_FROM', properties: { index: 0 } };
  assert.equal(transferUsage(item, { ...row, later: [{ relation: 'HAS_PROPERTY', propertyName: 'offset' }] }), null);
  assert.equal(transferUsage(item, { ...row, later: [{ relation: 'SPREADS_FROM' }] }).unresolved, 'COMPOSITION_OVERWRITE_UNRESOLVED');
  assert.deepEqual(transferUsage(item, { ...row, later: [{ relation: 'HAS_PROPERTY', propertyName: 'text' }] }).context.memberPath, ['offset']);
});

test('Neo4j provider search crosses a call frame and stops at the enclosing provider', {
  skip: process.env.ANNOTATION_GRAPHQL_INTEGRATION !== '1',
}, async () => {
  config({ path: 'graph/.env', quiet: true });
  const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(process.env.NEO4J_USER || process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD));
  const session = driver.session({ database: process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j' });
  const tx = session.beginTransaction();
  const prefix = `usage-test:${randomUUID()}`;
  try {
    await tx.run(`CREATE (read {stableId:$p + ':read'}), (fn:FunctionImplementation {stableId:$p + ':fn'}),
      (call {stableId:$p + ':call'}), (provider {stableId:$p + ':provider'}),
      (context {stableId:$p + ':context'}), (field {stableId:$p + ':field'}), (value {stableId:$p + ':value'})
      CREATE (fn)-[:AST_CHILD {projection:'nearest-function-operation'}]->(read),
        (call)-[:CALLS]->(fn), (provider)-[:JSX_CHILD {conditions:'[]'}]->(call),
        (field)-[:PROVIDES_CONTEXT {providerStableId:$p + ':provider'}]->(context), (field)-[:VALUE_FROM]->(value)`, { p: prefix });
    const result = await findContextProviders(tx, `${prefix}:read`, `${prefix}:context`);
    assert.deepEqual(result.gaps, []);
    assert.equal(result.providers[0].stableId, `${prefix}:value`);
    assert.deepEqual(result.providers[0].path.map(e => e.relation), ['AST_CHILD', 'CALLS', 'JSX_CHILD']);
    await tx.run(`MATCH (fn {stableId:$p + ':fn'}), (context {stableId:$p + ':context'})
      CREATE (unusedImport {stableId:$p + ':unused-import'})-[:ALIASES]->(fn),
        (parameter {stableId:$p + ':parameter'}), (otherCall {stableId:$p + ':other-call'}),
        (otherProvider {stableId:$p + ':other-provider'}), (otherField {stableId:$p + ':other-field'}),
        (otherValue {stableId:$p + ':other-value'}), (fn)-[:HAS_PARAMETER]->(parameter),
        (otherCall)-[:CALLS]->(fn), (otherProvider)-[:JSX_CHILD]->(otherCall),
        (otherField)-[:PROVIDES_CONTEXT {providerStableId:$p + ':other-provider'}]->(context),
        (otherField)-[:VALUE_FROM]->(otherValue)`, { p: prefix });
    const selected = await findContextProviders(tx, `${prefix}:read`, `${prefix}:context`, 24,
      [{ parameterId: `${prefix}:parameter`, callSiteId: `${prefix}:call` }]);
    assert.deepEqual(selected.gaps, []);
    assert.deepEqual(selected.providers.map(p => p.stableId), [`${prefix}:value`]);
    await tx.run(`CREATE (field {stableId:$p + ':offset-field'}), (object:ObjectConstruction {stableId:$p + ':object'}),
      (parameter {stableId:$p + ':props'}), (ref:ValueReference {stableId:$p + ':offset-ref'}),
      (otherRef:ValueReference {stableId:$p + ':text-ref'}), (read {stableId:$p + ':offset-read'}),
      (otherRead {stableId:$p + ':text-read'})
      CREATE (object)-[:HAS_PROPERTY {index:0, propertyName:'offset'}]->(field),
        (object)-[:BINDS_TO_PARAMETER {index:0, callSiteStableId:$p + ':selected-call'}]->(parameter),
        (ref)-[:RESOLVES_TO]->(parameter), (otherRef)-[:RESOLVES_TO]->(parameter),
        (read)-[:READS_FROM {role:'receiver', propertyName:'offset'}]->(ref),
        (otherRead)-[:READS_FROM {role:'receiver', propertyName:'text'}]->(otherRef)`, { p: prefix });
    let item = { stableId: `${prefix}:offset-field`, context: { selection: 'usage', frames: [] } };
    for (const expected of ['object', 'props', 'offset-ref', 'offset-read']) {
      const step = await inspectValueUsage(tx, item);
      assert.equal(step.children.length, 1);
      assert.equal(step.children[0].stableId, `${prefix}:${expected}`);
      item = step.children[0];
    }
    assert.deepEqual(item.context.memberPath, []);
    await tx.run(`MATCH (provider {stableId:$p + ':provider'})
      CREATE (element:ComponentConstruction {stableId:$p + ':element'}),
        (argument {stableId:$p + ':element-arg'}), (parameter {stableId:$p + ':element-param'}),
        (reference {stableId:$p + ':element-ref'}), (factory:FunctionImplementation {stableId:$p + ':factory'}),
        (renderCall {stableId:$p + ':render-call'})
      CREATE (argument)-[:VALUE_FROM]->(element), (argument)-[:BINDS_TO_PARAMETER {index:0}]->(parameter),
        (renderCall)-[:HAS_ARGUMENT]->(argument),
        (reference)-[:RESOLVES_TO]->(parameter), (provider)-[:RENDERS_VALUE]->(reference),
        (factory)-[:DECLARES_JSX]->(element)`, { p: prefix });
    const mounted = await findContextProviders(tx, `${prefix}:element`, `${prefix}:context`);
    assert.deepEqual(mounted.gaps, []);
    assert.deepEqual(mounted.providers[0].path.map(e => e.relation),
      ['VALUE_FROM', 'BINDS_TO_PARAMETER', 'RESOLVES_TO', 'RENDERS_VALUE']);
    assert.ok(!mounted.providers[0].path.some(e => e.to === `${prefix}:factory`));
    const argumentUsage = await inspectValueUsage(tx, { stableId: `${prefix}:element-arg`, context: { frames: [] } });
    assert.equal(argumentUsage.children[0].context.frames[0].callSiteId, `${prefix}:render-call`);
    await tx.run(`CREATE (writer {stableId:$p + ':writer'}), (state {stableId:$p + ':state'}),
      (owner:FunctionImplementation {stableId:$p + ':owner'}), (read {stableId:$p + ':read-use'}),
      (operation:ValueConsumption {stableId:$p + ':operation', syntax:'value < bound', consumptionKind:'binary-operation'})
      CREATE (writer)-[:WRITES_TO]->(state), (state)-[:ENCLOSED_BY]->(owner),
        (read)-[:RESOLVES_TO]->(state), (operation)-[:CONSUMES_VALUE]->(read), (operation)-[:ENCLOSED_BY]->(owner)`, { p: prefix });
    let consumer = { stableId: `${prefix}:state`, context: { selection: 'usage', objective: 'purpose',
      frames: [], purposeState: { writerId: `${prefix}:writer`, stateId: `${prefix}:state` }, usagePath: [] } };
    for (const target of ['read-use', 'operation']) {
      consumer = (await inspectValueUsage(tx, consumer)).children[0];
      assert.equal(consumer.stableId, `${prefix}:${target}`);
    }
    const purpose = await inspectOrigin(tx, consumer);
    assert.equal(purpose.purposeBoundary, true);
    await tx.run(`MATCH (n {stableId:$p + ':state'})-[r:ENCLOSED_BY]->() DELETE r`, { p: prefix });
    assert.ok(!(await inspectOrigin(tx, consumer)).purposeBoundary, 'an absent owner must invalidate purpose evidence');
  } finally {
    await tx.rollback();
    await session.close();
    await driver.close();
  }
});
