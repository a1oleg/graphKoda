import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectionMethodSemantics,
  directCollectionAssignmentPlan,
} from './functionFlowGraph.collectionSemantics.ts';
import {
  collectionExecutionProtocol,
  executionPrimitive,
} from './functionFlowGraph.executionPrimitives.ts';

test('find exposes pull, predicate, and short-circuit execution semantics', () => {
  const protocol = collectionExecutionProtocol(collectionMethodSemantics('find'));

  assert.equal(protocol.pull.kind, 'pull');
  assert.equal(protocol.callbackResult.kind, 'branch');
  assert.equal(protocol.itemOutcome, 'item-available');
  assert.equal(protocol.exhaustedOutcome, 'exhausted');
  assert.equal(protocol.shortCircuitOutcome, 'short-circuit');
});

test('filter emits accepted values and reduce accumulates values', () => {
  assert.equal(collectionMethodSemantics('filter').itemParameterIndex, 0);
  assert.equal(collectionMethodSemantics('reduce').itemParameterIndex, 1);
  assert.equal(
    collectionExecutionProtocol(collectionMethodSemantics('filter')).callbackResult.kind,
    'emit',
  );
  assert.equal(
    collectionExecutionProtocol(collectionMethodSemantics('reduce')).callbackResult.kind,
    'accumulate',
  );
});

test('direct assignment routing is derived from collection semantics', () => {
  const find = directCollectionAssignmentPlan(collectionMethodSemantics('find'));
  const findLast = directCollectionAssignmentPlan(collectionMethodSemantics('findLast'));

  assert.deepEqual(find, {
    kind: 'select-one',
    truthy: { action: 'assign', value: 'bound-item' },
    falsy: { action: 'repeat' },
    exhausted: { action: 'assign', value: 'undefined' },
  });
  assert.deepEqual(findLast, find);
  assert.equal(
    directCollectionAssignmentPlan(collectionMethodSemantics('filter'))?.kind,
    'collect-accepted',
  );
  assert.equal(
    directCollectionAssignmentPlan(collectionMethodSemantics('reduce'))?.kind,
    'accumulate',
  );
});

test('local assignment and storage write are different primitives', () => {
  assert.equal(executionPrimitive('assign').runtimeEventKind, 'value.assign');
  assert.equal(executionPrimitive('write').runtimeEventKind, 'storage.write');
});
