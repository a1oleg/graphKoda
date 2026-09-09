import assert from 'node:assert/strict';
import test from 'node:test';
import { projectAnnotationPlan, executeAnnotationGraphql } from './annotationGraphql.js';
import { annotationProfileContract } from './annotationProfiles.js';
import { completeAnnotationWorkflow, leaseNextAnnotationTask } from './annotationResolver.js';

const now = '2026-09-05T10:00:00.000Z';
const job = { jobId: 'job', rootAnnotationId: 'root', rootStableId: 'alias', maxDepth: 4 };
const row = (id, extra = {}) => ({ annotationId: id, stableId: `code:${id}`,
  annotationKind: 'Binding', taskId: `task:${id}`, status: 'pending', ...extra });
const snapshot = () => projectAnnotationPlan(job, [row('root')], now);

test('plan preserves shared dependencies, reference boundaries and consumer direction', () => {
  const plan = projectAnnotationPlan(job, [
    row('root', { dependencies: [{ annotationId: 'a' }, { annotationId: 'b' }] }),
    row('a', { dependencies: [{ annotationId: 'cached' }] }),
    row('b', { dependencies: [{ annotationId: 'cached' }] }),
    row('cached', { status: 'ready', referenceDependenciesJson: JSON.stringify([
      { stableId: 'system', annotationKind: 'ExternalComponent', role: 'origin' },
    ]) }),
  ], now);
  assert.equal(plan.nodes.length, 5);
  assert.equal(plan.edges.length, 5);
  assert.deepEqual(plan.available.map(n => n.id), ['a', 'b']);
  assert.deepEqual(plan.waiting.map(n => n.id), ['root']);
  assert.deepEqual(plan.waiting[0].blockedBy, ['a', 'b']);
  assert.equal(plan.state, 'PAUSED');
  assert.equal(plan.requestedRootStableId, 'alias');
  assert.equal(plan.nodes.find(n => n.id === 'reference:system').taskId, undefined);
  assert.equal(JSON.stringify(plan).includes('contextJson'), false);
});

test('active and expired leases produce working and available states', () => {
  const pending = row('root', { taskStatus: 'leased', leaseExpiresAt: '2026-09-05T10:05:00.000Z' });
  assert.equal(projectAnnotationPlan(job, [pending], now).state, 'RUNNING');
  assert.equal(projectAnnotationPlan(job, [pending], '2026-09-05T10:06:00.000Z').state, 'PAUSED');
  assert.equal(projectAnnotationPlan(job, [{ ...pending, status: 'ready' }], now).state, 'COMPLETE');
});

test('missing dependencies are reported, not silently removed from diagram', () => {
  assert.throws(() => projectAnnotationPlan(job, [row('root', {
    dependencies: [{ annotationId: 'missing' }],
  })]), /Incomplete annotation plan/);
});

test('GraphQL kinds come from the executable profile registry', async () => {
  const result = await executeAnnotationGraphql({ query: '{ annotationProfiles { kind id version } }' }, {});
  assert.equal(result.errors, undefined);
  assert.deepEqual(result.data.annotationProfiles.map(p => p.kind), Object.keys(annotationProfileContract));
});

test('prepare queues without leasing; reads do not advance; completion does not auto-next', async () => {
  const calls = [];
  const services = {
    readPlan: async () => snapshot(),
    prepare: async input => { calls.push(['prepare', input]); return { jobId: 'job' }; },
    next: async input => { calls.push(['next', input]); return { status: 'waiting' }; },
    complete: async input => { calls.push(['complete', input]); },
  };
  const run = query => executeAnnotationGraphql({ query }, { services });
  assert.equal((await run('mutation { prepareAnnotationPlan(input:{stableId:"alias"}) { jobId state } }')).errors, undefined);
  assert.equal(calls[0][1].leaseTask, false);
  assert.equal(calls[0][1].createJob, true);
  assert.equal(calls[0][1].maxDepth, 4);
  await run('{ annotationPlan(jobId:"job") { nodes { id state } working { id } waiting { id } } }');
  assert.equal(calls.length, 1);
  const next = await run('mutation { nextAnnotation(jobId:"job") { state task { taskId } } }');
  assert.equal(next.data.nextAnnotation.state, 'WAITING');
  assert.equal(calls[1][1].singleStep, true);
  const complete = await run('mutation { completeAnnotation(input:{jobId:"job",taskId:"task:root",annotationId:"root",leaseToken:"token",text:"Text"}) { state } }');
  assert.equal(complete.errors, undefined);
  assert.equal(calls.length, 3);
  assert.equal(calls[2][1].leaseNext, false);
  assert.equal(calls[2][1].requireLease, true);
});

test('GraphQL validates fields, depth and mandatory completion lease', async () => {
  const context = { services: { prepare: () => assert.fail('must not prepare') } };
  for (const query of [
    '{ annotationProfiles { nonexistent } }',
    'mutation { prepareAnnotationPlan(input:{stableId:"x",maxDepth:9}) { jobId } }',
    'mutation { completeAnnotation(input:{jobId:"j",taskId:"t",annotationId:"a",text:"x"}) { jobId } }',
  ]) assert.ok((await executeAnnotationGraphql({ query }, context)).errors?.length);
});

test('scheduler enforces single step in the lease query under the job write lock', async () => {
  const driver = { session: () => ({
    async run(query, parameters) {
      assert.equal(parameters.singleStep, true);
      assert.match(query, /SET job\.leaseProbeAt/);
      assert.match(query, /active\.leaseExpiresAt > \$now/);
      return { records: [{ get: () => null }] };
    }, close: async () => {},
  }) };
  assert.equal((await leaseNextAnnotationTask(driver, 'neo4j', { jobId: 'job', singleStep: true })).status, 'waiting');
});

test('expired or incorrect leases cannot save GraphQL results', async () => {
  let writes = 0;
  const session = {
    executeWrite: async work => work(session),
    async run() {
      writes++;
      return { records: [{ get: key => ({ taskStatus: 'leased', leaseToken: 'correct',
        leaseExpiresAt: '2000-01-01T00:00:00.000Z', annotationId: 'a' })[key] }] };
    }, close: async () => {},
  };
  const driver = { session: () => session };
  await assert.rejects(completeAnnotationWorkflow(driver, 'neo4j', {
    jobId: 'j', taskId: 't', annotationId: 'a', leaseToken: 'wrong',
    text: 'Text', requireLease: true, leaseNext: false,
  }), /lease/i);
  assert.equal(writes, 2);
});
