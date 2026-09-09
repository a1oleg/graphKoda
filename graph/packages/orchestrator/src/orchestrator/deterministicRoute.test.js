import test from 'node:test';
import assert from 'node:assert/strict';
import { initialRoute, inspectRouteTask, applyRouteStep, validateRoute, routeTaskId } from './deterministicRoute.js';

const node = (stableId, labels) => [{ fact: { stableId, labels } }];
const edge = (from, relation, to, index) => ({ from, relation, to, ...(index == null ? {} : { index }) });
const binding = (call, argument, parameter) => ({ callSiteId: call, argumentIndex: 2,
  edge: edge(argument, 'BINDS_TO_PARAMETER', parameter, 2), supplied: edge(call, 'HAS_ARGUMENT', argument, 2) });
function fixture() {
  const facts = {
    'p:node': node('p', ['Parameter', 'ObjectConstruction', 'ValueDeclaration']),
    'p:bindings': [binding('c', 'a', 'p')],
    'a:node': node('a', ['ArgumentValue', 'ObjectConstruction']),
    'a:owner': [{ edge: edge('a', 'ENCLOSED_BY', 'fn'), owner: { stableId: 'fn' } }],
  };
  return { facts, read: async (id, probe) => facts[`${id}:${probe}`] || [] };
}
async function step(plan, read) {
  const task = plan.nodes.find(n => n.state === 'PENDING');
  return applyRouteStep(plan, task.id, await inspectRouteTask(read, task));
}
test('parameter follows binding rather than its display ObjectConstruction/type', async () => {
  const { read } = fixture();
  let plan = await step(initialRoute({ stableId: 'p' }), read);
  assert.equal(plan.nodes.length, 2);
  assert.equal(plan.nodes[0].rule, 'parameter-bindings');
  plan = await step(plan, read);
  assert.equal(plan.status, 'COMPLETE');
  assert.equal(plan.results[0].ownerId, 'fn');
  assert.equal(plan.results[0].context.bindings[0].callSiteId, 'c');
  assert.equal(plan.edges[0].evidence[0].from, 'a');
  assert.ok(plan.events.some(e => e.kind === 'COLLECT'));
});
test('different call sites stay distinct even when sharing an argument entity', async () => {
  const { read, facts } = fixture();
  facts['p:bindings'].push(binding('d', 'a', 'p'));
  let plan = await step(initialRoute({ stableId: 'p' }), read);
  assert.equal(plan.nodes.length, 3);
  while (plan.status === 'PAUSED') plan = await step(plan, read);
  assert.equal(plan.results.length, 2);
});
test('missing binding is a gap, not an allocation boundary', async () => {
  const { read, facts } = fixture();
  facts['p:bindings'] = [];
  const plan = await step(initialRoute({ stableId: 'p' }), read);
  assert.equal(plan.status, 'INCOMPLETE');
  assert.equal(plan.nodes[0].reason, 'BINDINGS_MISSING');
  assert.deepEqual(plan.results, []);
  assert.equal(await validateRoute(read, plan), true);
  facts['p:bindings'].push(binding('c', 'a', 'p'));
  assert.equal(await validateRoute(read, plan), false);
});
test('added call site invalidates an existing partial plan', async () => {
  const { read, facts } = fixture();
  const plan = await step(initialRoute({ stableId: 'p' }), read);
  facts['p:bindings'].push(binding('d', 'a', 'p'));
  assert.equal(await validateRoute(read, plan), false);
});
test('unknown history and syntax do not get interpreted by name', async () => {
  const read = async () => node('cursor', ['ValueDeclaration']);
  const plan = await step(initialRoute({ stableId: 'cursor' }), read);
  assert.equal(plan.status, 'INCOMPLETE');
  assert.equal(plan.nodes[0].reason, 'NO_ORIGIN_RULE');
});
test('task limit does not claim completeness', async () => {
  const { read } = fixture();
  const plan = await step(initialRoute({ stableId: 'p', maxTasks: 1 }), read);
  assert.equal(plan.status, 'INCOMPLETE');
  assert.equal(plan.nodes[0].reason, 'TASK_LIMIT');
});
test('cycles converge to explicit gaps instead of adding arrival-path tasks', async () => {
  const read = async (id, probe) => probe === 'node' ? node(id, ['Reference'])
    : [{ edge: edge(id, 'RESOLVES_TO', id === 'a' ? 'b' : 'a') }];
  let plan = await step(initialRoute({ stableId: 'a' }), read);
  plan = await step(plan, read);
  assert.equal(plan.nodes.length, 2);
  assert.equal(plan.status, 'INCOMPLETE');
  assert.ok(plan.nodes.every(n => n.reason === 'CYCLIC_DEPENDENCY'));
});
test('identity normalizes context key order', () => {
  assert.equal(routeTaskId('a', { x: 1, y: 2 }), routeTaskId('a', { y: 2, x: 1 }));
});
test('binding with unknown argument position remains a gap', async () => {
  const { read, facts } = fixture();
  facts['p:bindings'][0].argumentIndex = null;
  const plan = await step(initialRoute({ stableId: 'p' }), read);
  assert.equal(plan.nodes[0].reason, 'BINDING_CONTEXT_MISSING');
});
