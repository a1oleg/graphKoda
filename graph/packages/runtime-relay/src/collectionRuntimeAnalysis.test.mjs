import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCollectionRuntimeAnalysis } from './collectionRuntimeAnalysis.js';

function record(nodeId, parentNodeId, stableId, score, nodeProps) {
  return {
    nodeId,
    parentNodeId,
    functionStableId: stableId,
    sessionId: 'session-1',
    score,
    raw: { nodeProps },
  };
}

test('iteration highlights only the predicate edge matching its runtime outcome', () => {
  const methodStableId = 'method';
  const analysis = buildCollectionRuntimeAnalysis([
    record('root', null, methodStableId, 1, { role: 'collection-method', methodName: 'find' }),
    record('pull', 'root', 'pull', 2, { role: 'collection-pop', iterationIndex: 0 }),
    record('predicate', 'pull', 'predicate', 3, {
      role: 'predicate-stage',
      iterationIndex: 0,
      outcome: false,
    }),
    record('next', 'predicate', 'next-predicate', 4, {
      role: 'predicate-stage',
      iterationIndex: 0,
      outcome: true,
    }),
    record('result', 'next', 'result', 5, {
      role: 'collection-predicate',
      iterationIndex: 0,
      outcome: true,
      matched: true,
    }),
  ], { stableId: methodStableId });

  assert.equal(analysis.iterations.length, 1);
  assert.deepEqual(
    analysis.iterations[0].nodeHighlights.find((item) => item.stableId === 'predicate'),
    { stableId: 'predicate', outcome: false, role: 'predicate-stage' },
  );
  assert.deepEqual(
    analysis.iterations[0].edgePairs.find((item) => item.sourceStableId === 'predicate'),
    { sourceStableId: 'predicate', targetStableId: 'next-predicate', edgeType: 'FALSE' },
  );
});

test('rejected iteration includes its observed transition back to shift', () => {
  const methodStableId = 'method';
  const analysis = buildCollectionRuntimeAnalysis([
    record('root', null, methodStableId, 1, { role: 'collection-method', methodName: 'find' }),
    record('pull-0', 'root', 'shift', 2, { role: 'collection-pop', iterationIndex: 0 }),
    record('predicate-0', 'pull-0', 'predicate', 3, {
      role: 'predicate-stage',
      iterationIndex: 0,
      outcome: false,
    }),
    record('callback-0', 'predicate-0', 'callback', 4, {
      role: 'collection-predicate',
      iterationIndex: 0,
      outcome: false,
    }),
    record('pull-1', 'callback-0', 'shift', 5, { role: 'collection-pop', iterationIndex: 1 }),
    record('predicate-1', 'pull-1', 'predicate', 6, {
      role: 'predicate-stage',
      iterationIndex: 1,
      outcome: true,
    }),
    record('callback-1', 'predicate-1', 'callback', 7, {
      role: 'collection-predicate',
      iterationIndex: 1,
      outcome: true,
      matched: true,
    }),
    record('result', 'callback-1', 'set', 8, { role: 'collection-result', outcome: true }),
  ], { stableId: methodStableId });

  assert.deepEqual(
    analysis.iterations[0].edgePairs.at(-1),
    { sourceStableId: 'predicate', targetStableId: 'shift', edgeType: 'REPEATS' },
  );
  assert.equal(analysis.iterations[0].staticStableIds.includes('callback'), false);
});

test('for-of branch preserves TRUE and NEXT and repeats from its last effect', () => {
  const methodStableId = 'for-of';
  const analysis = buildCollectionRuntimeAnalysis([
    record('root', null, methodStableId, 1, { role: 'collection-method', methodName: 'for-of' }),
    record('pull-0', 'root', 'shift', 2, { role: 'collection-pop', iterationIndex: 0 }),
    record('item-0', 'pull-0', 'item', 3, { role: 'iteration-value', iterationIndex: 0 }),
    record('predicate-0', 'item-0', 'predicate', 4, {
      role: 'predicate-stage', iterationIndex: 0, outcome: true,
    }),
    record('source-0', 'predicate-0', 'source', 5, { role: 'binding-stage', iterationIndex: 0 }),
    record('push-a-0', 'source-0', 'push-a', 6, { role: 'effect-stage', iterationIndex: 0 }),
    record('push-b-0', 'push-a-0', 'push-b', 7, { role: 'effect-stage', iterationIndex: 0 }),
    record('callback-0', 'push-b-0', 'predicate', 8, {
      role: 'collection-predicate', iterationIndex: 0, outcome: true, matched: true,
    }),
    record('pull-1', 'callback-0', 'shift', 9, { role: 'collection-pop', iterationIndex: 1 }),
    record('item-1', 'pull-1', 'item', 10, { role: 'iteration-value', iterationIndex: 1 }),
    record('predicate-1', 'item-1', 'predicate', 11, {
      role: 'predicate-stage', iterationIndex: 1, outcome: false,
    }),
    record('push-c-1', 'predicate-1', 'push-c', 12, { role: 'effect-stage', iterationIndex: 1 }),
    record('callback-1', 'push-c-1', 'predicate', 13, {
      role: 'collection-predicate', iterationIndex: 1, outcome: false,
    }),
    record('pull-2', 'callback-1', 'shift', 14, { role: 'collection-pop', iterationIndex: 2 }),
  ], { stableId: methodStableId });

  assert.deepEqual(analysis.iterations[0].edgePairs, [
    { sourceStableId: 'shift', targetStableId: 'item', edgeType: null },
    { sourceStableId: 'item', targetStableId: 'predicate', edgeType: null },
    { sourceStableId: 'predicate', targetStableId: 'source', edgeType: 'TRUE' },
    { sourceStableId: 'source', targetStableId: 'push-a', edgeType: null },
    { sourceStableId: 'push-a', targetStableId: 'push-b', edgeType: null },
    { sourceStableId: 'push-b', targetStableId: 'shift', edgeType: 'REPEATS' },
  ]);
  assert.deepEqual(analysis.iterations[1].edgePairs.at(-1), {
    sourceStableId: 'push-c', targetStableId: 'shift', edgeType: 'REPEATS',
  });
});

test('for-of completion does not invent a result edge for the final iteration', () => {
  const methodStableId = 'for-of';
  const analysis = buildCollectionRuntimeAnalysis([
    record('root', null, methodStableId, 1, { role: 'collection-method', methodName: 'for-of' }),
    record('pull', 'root', 'shift', 2, { role: 'collection-pop', iterationIndex: 0 }),
    record('item', 'pull', 'item', 3, { role: 'iteration-value', iterationIndex: 0 }),
    record('predicate', 'item', 'predicate', 4, {
      role: 'predicate-stage', iterationIndex: 0, outcome: true,
    }),
    record('effect', 'predicate', 'effect', 5, { role: 'effect-stage', iterationIndex: 0 }),
    record('callback', 'effect', 'predicate', 6, {
      role: 'collection-predicate', iterationIndex: 0, outcome: true, matched: true,
    }),
    record('result', 'callback', methodStableId, 7, { role: 'collection-result', outcome: true }),
  ], { stableId: methodStableId });

  assert.equal(analysis.iterations[0].staticStableIds.includes(methodStableId), false);
  assert.equal(
    analysis.iterations[0].edgePairs.some((edge) => edge.targetStableId === methodStableId),
    false,
  );
});

test('matched iteration includes its observed transition to result set', () => {
  const methodStableId = 'method';
  const analysis = buildCollectionRuntimeAnalysis([
    record('root', null, methodStableId, 1, { role: 'collection-method', methodName: 'find' }),
    record('pull', 'root', 'shift', 2, { role: 'collection-pop', iterationIndex: 0 }),
    record('predicate', 'pull', 'predicate', 3, {
      role: 'predicate-stage',
      iterationIndex: 0,
      outcome: true,
    }),
    record('callback', 'predicate', 'callback', 4, {
      role: 'collection-predicate',
      iterationIndex: 0,
      outcome: true,
      matched: true,
    }),
    record('result', 'callback', 'set', 5, { role: 'collection-result', outcome: true }),
  ], { stableId: methodStableId });

  assert.deepEqual(
    analysis.iterations[0].edgePairs.at(-1),
    { sourceStableId: 'predicate', targetStableId: 'set', edgeType: 'TRUE' },
  );
  assert.equal(analysis.iterations[0].staticStableIds.includes('callback'), false);
  assert.equal(analysis.iterations[0].staticStableIds.includes('set'), true);
  assert.equal(
    analysis.iterations[0].nodeHighlights.find((item) => item.stableId === 'set')?.role,
    'collection-result',
  );
});

test('continuing collection result is transparent between the matched predicate and following control flow', () => {
  const methodStableId = 'method';
  const analysis = buildCollectionRuntimeAnalysis([
    record('root', null, methodStableId, 1, {
      role: 'collection-method', methodName: 'find',
    }),
    record('pull', 'root', 'shift', 2, { role: 'collection-pop', iterationIndex: 0 }),
    record('item', 'pull', 'item', 3, { role: 'iteration-value', iterationIndex: 0 }),
    record('name', 'item', 'name', 4, { role: 'value-stage', iterationIndex: 0 }),
    record('predicate', 'name', 'get-name', 5, {
      role: 'predicate-stage', iterationIndex: 0, outcome: true,
    }),
    record('callback', 'predicate', 'callback', 6, {
      role: 'collection-predicate', iterationIndex: 0, outcome: true, matched: true,
    }),
    record('result', 'callback', methodStableId, 7, {
      role: 'collection-result', outcome: true, continuesAfterResult: true,
    }),
    record('outer', 'result', 'outer-predicate', 8, {
      role: 'predicate-stage', outcome: true,
    }),
    record('join', 'outer', 'flow-join', 9, { role: 'flow-join' }),
  ], { stableId: methodStableId });

  assert.deepEqual(analysis.iterations[0].edgePairs.slice(1, 3), [
    { sourceStableId: 'item', targetStableId: 'name', edgeType: null },
    { sourceStableId: 'name', targetStableId: 'get-name', edgeType: null },
  ]);
  assert.deepEqual(
    analysis.iterations[0].edgePairs.find((edge) => edge.sourceStableId === 'get-name'),
    { sourceStableId: 'get-name', targetStableId: 'outer-predicate', edgeType: 'TRUE' },
  );
  assert.equal(
    analysis.iterations[0].edgePairs.some((edge) => edge.targetStableId === methodStableId),
    false,
  );
});

test('segments group iterations by branch path and retain every item', () => {
  const methodStableId = 'method';
  const records = [record('root', null, methodStableId, 1, { role: 'collection-method', methodName: 'find' })];
  let parent = 'root';
  let score = 2;
  for (let index = 0; index < 4; index += 1) {
    const pull = `pull-${index}`;
    const predicate = `predicate-${index}`;
    const callback = `callback-${index}`;
    records.push(record(pull, parent, 'shift', score++, {
      role: 'collection-pop', iterationIndex: index, itemPreview: `item-${index}`,
    }));
    records.push(record(predicate, pull, 'enabled', score++, {
      role: 'predicate-stage', stageName: 'enabled', iterationIndex: index, outcome: false,
    }));
    records.push(record(callback, predicate, 'callback', score++, {
      role: 'collection-predicate', iterationIndex: index, outcome: false,
    }));
    parent = callback;
  }
  records.push(record('next-shift', parent, 'shift', score, { role: 'collection-pop' }));

  const analysis = buildCollectionRuntimeAnalysis(records, { stableId: methodStableId });
  assert.equal(analysis.segments.length, 1);
  assert.equal(analysis.segments[0].count, 4);
  assert.equal(analysis.segments[0].destination, 'repeat');
  assert.equal(analysis.segments[0].label, 'enabled false -> repeat');
  assert.deepEqual(analysis.segments[0].samples.map((sample) => sample.itemPreview), [
    'item-0', 'item-1', 'item-2', 'item-3',
  ]);
});

test('different branch paths remain separate when both iterations are rejected', () => {
  const methodStableId = 'method';
  const analysis = buildCollectionRuntimeAnalysis([
    record('root', null, methodStableId, 1, { role: 'collection-method', methodName: 'find' }),
    record('pull-0', 'root', 'shift', 2, { role: 'collection-pop', iterationIndex: 0 }),
    record('a-0', 'pull-0', 'a', 3, { role: 'predicate-stage', stageName: 'a', iterationIndex: 0, outcome: false }),
    record('callback-0', 'a-0', 'callback', 4, { role: 'collection-predicate', iterationIndex: 0, outcome: false }),
    record('pull-1', 'callback-0', 'shift', 5, { role: 'collection-pop', iterationIndex: 1 }),
    record('a-1', 'pull-1', 'a', 6, { role: 'predicate-stage', stageName: 'a', iterationIndex: 1, outcome: true }),
    record('b-1', 'a-1', 'b', 7, { role: 'predicate-stage', stageName: 'b', iterationIndex: 1, outcome: false }),
    record('callback-1', 'b-1', 'callback', 8, { role: 'collection-predicate', iterationIndex: 1, outcome: false }),
    record('next-shift', 'callback-1', 'shift', 9, { role: 'collection-pop' }),
  ], { stableId: methodStableId });

  assert.equal(analysis.segments.length, 2);
  assert.deepEqual(new Set(analysis.segments.map((segment) => segment.outcome)), new Set(['rejected']));
  assert.deepEqual(new Set(analysis.segments.map((segment) => segment.label)), new Set([
    'a false -> repeat',
    'a true -> b false -> repeat',
  ]));
});

test('filter reports accepted elements instead of find matches', () => {
  const methodStableId = 'filter-method';
  const analysis = buildCollectionRuntimeAnalysis([
    record('root', null, methodStableId, 1, { role: 'collection-method', methodName: 'filter' }),
    record('pull-0', 'root', 'shift', 2, { role: 'collection-pop', iterationIndex: 0 }),
    record('predicate-0', 'pull-0', 'predicate', 3, {
      role: 'predicate-stage', stageName: 'type === text', iterationIndex: 0, outcome: true,
    }),
    record('callback-0', 'predicate-0', 'callback', 4, {
      role: 'collection-predicate', iterationIndex: 0, outcome: true, matched: true,
    }),
    record('pull-1', 'callback-0', 'shift', 5, { role: 'collection-pop', iterationIndex: 1 }),
    record('predicate-1', 'pull-1', 'predicate', 6, {
      role: 'predicate-stage', stageName: 'type === text', iterationIndex: 1, outcome: false,
    }),
    record('callback-1', 'predicate-1', 'callback', 7, {
      role: 'collection-predicate', iterationIndex: 1, outcome: false,
    }),
    record('result', 'callback-1', 'set', 8, { role: 'collection-result', outcome: true }),
  ], { stableId: methodStableId });

  assert.equal(analysis.methodName, 'filter');
  assert.equal(analysis.acceptedIterations, 1);
  assert.equal(analysis.matchedIterations, 1);
  assert.deepEqual(new Set(analysis.segments.map((segment) => segment.outcome)), new Set([
    'accepted', 'rejected',
  ]));
  assert.equal(analysis.segments.find((segment) => segment.outcome === 'accepted')?.destination, 'emit');
  assert.deepEqual(
    analysis.iterations[0].edgePairs.at(-1),
    { sourceStableId: 'predicate', targetStableId: 'set', edgeType: 'TRUE' },
  );
  assert.equal(analysis.iterations[0].accumulatorState, '[#1]');
  assert.equal(analysis.iterations[1].accumulatorState, '[#1]');
});

test('filter emit event supplies the observed TRUE edge and accumulator state', () => {
  const methodStableId = 'filter-method';
  const analysis = buildCollectionRuntimeAnalysis([
    record('root', null, methodStableId, 1, { role: 'collection-method', methodName: 'filter' }),
    record('pull', 'root', 'shift', 2, { role: 'collection-pop', iterationIndex: 0, itemPreview: 'id:7' }),
    record('predicate', 'pull', 'predicate', 3, {
      role: 'predicate-stage', iterationIndex: 0, outcome: true,
    }),
    record('callback', 'predicate', 'callback', 4, {
      role: 'collection-predicate', iterationIndex: 0, outcome: true, matched: true, accumulatorState: '[id:7]',
    }),
    record('emit', 'callback', 'result-set', 5, {
      role: 'collection-emit', iterationIndex: 0, outcome: true, accumulatorState: '[id:7]',
    }),
    record('result', 'emit', 'result-set', 6, { role: 'collection-result', outcome: true }),
  ], { stableId: methodStableId });

  assert.deepEqual(analysis.iterations[0].edgePairs.at(-1), {
    sourceStableId: 'predicate',
    targetStableId: 'result-set',
    edgeType: 'TRUE',
  });
  assert.equal(analysis.iterations[0].accumulatorState, '[id:7]');
});

test('reduce reports accumulator state after every item', () => {
  const methodStableId = 'reduce-method';
  const analysis = buildCollectionRuntimeAnalysis([
    record('root', null, methodStableId, 1, {
      role: 'collection-method', methodName: 'reduce', accumulatorName: 'pastedTextBytes',
    }),
    record('pull-0', 'root', 'shift', 2, { role: 'collection-pop', iterationIndex: 0, itemPreview: 'id:1' }),
    record('item-0', 'pull-0', 'r', 3, { role: 'iteration-value', iterationIndex: 0, itemPreview: 'id:1' }),
    record('add-0', 'item-0', 'add', 4, {
      role: 'collection-accumulate', iterationIndex: 0, accumulatorBefore: '0', accumulatorState: '5', outcome: true,
    }),
    record('pull-1', 'add-0', 'shift', 5, { role: 'collection-pop', iterationIndex: 1, itemPreview: 'id:3' }),
    record('item-1', 'pull-1', 'r', 6, { role: 'iteration-value', iterationIndex: 1, itemPreview: 'id:3' }),
    record('add-1', 'item-1', 'add', 7, {
      role: 'collection-accumulate', iterationIndex: 1, accumulatorBefore: '5', accumulatorState: '19', outcome: true,
    }),
    record('result', 'add-1', 'pastedTextBytes', 8, { role: 'collection-result', itemPreview: '19' }),
  ], { stableId: methodStableId });

  assert.deepEqual(analysis.iterations.map((iteration) => iteration.outcome), ['accumulated', 'accumulated']);
  assert.equal(analysis.accumulatorName, 'pastedTextBytes');
  assert.deepEqual(analysis.iterations.map((iteration) => iteration.accumulatorState), ['5', '19']);
  assert.equal(analysis.segments[0].destination, 'accumulate');
  assert.equal(analysis.segments[0].count, 2);
  assert.deepEqual(analysis.iterations[0].edgePairs.at(-1), {
    sourceStableId: 'add', targetStableId: 'shift', edgeType: null,
  });
  assert.deepEqual(analysis.iterations[1].edgePairs.at(-1), {
    sourceStableId: 'add', targetStableId: 'pastedTextBytes', edgeType: null,
  });
});
