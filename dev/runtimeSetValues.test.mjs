import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFunctionSetValues } from '../graph/packages/runtime-relay/src/runtimeRedis.js';

function record({ stableId, step, name, value, tsMs, role = 'set-value' }) {
  return {
    kind: 'node-visit',
    functionStableId: stableId,
    score: tsMs,
    raw: {
      nodeProps: {
        role,
        ownerStepStableId: step,
        variableName: name,
        valuePreview: value,
        resultType: typeof value,
        tsMs,
      },
    },
  };
}

test('function set values retain only the latest visit per static set', () => {
  const records = [
    record({ stableId: 'set:a', step: 'step:1', name: 'a', value: 'old', tsMs: 1 }),
    record({ stableId: 'set:b', step: 'step:2', name: 'b', value: 'value-b', tsMs: 2 }),
    record({ stableId: 'set:a', step: 'step:1', name: 'a', value: 'new', tsMs: 3 }),
    record({ stableId: 'call:c', step: 'step:3', name: 'c', value: 'ignored', tsMs: 4, role: 'call' }),
  ];

  assert.deepEqual(buildFunctionSetValues(records, {
    stableId: 'fn:test',
    sessionId: 'session:test',
  }), {
    stableId: 'fn:test',
    sessionId: 'session:test',
    values: [
      {
        stableId: 'set:b',
        ownerStepStableId: 'step:2',
        variableName: 'b',
        valuePreview: 'value-b',
        resultType: 'string',
        valueRole: 'set-value',
        tsMs: 2,
      },
      {
        stableId: 'set:a',
        ownerStepStableId: 'step:1',
        variableName: 'a',
        valuePreview: 'new',
        resultType: 'string',
        valueRole: 'set-value',
        tsMs: 3,
      },
    ],
  });
});

test('function values include received parameters from TYPED_AS nodes', () => {
  const values = buildFunctionSetValues([
    record({
      stableId: 'parameter:input',
      step: 'step:input',
      name: 'input',
      value: 'check',
      tsMs: 1,
      role: 'parameter-value',
    }),
  ], { stableId: 'fn:test', sessionId: 'session:test' });

  assert.deepEqual(values.values, [{
    stableId: 'parameter:input',
    ownerStepStableId: 'step:input',
    variableName: 'input',
    valuePreview: 'check',
    resultType: 'string',
    valueRole: 'parameter-value',
    tsMs: 1,
  }]);
});
