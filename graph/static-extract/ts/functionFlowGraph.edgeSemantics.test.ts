import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyFlowEdge } from './functionFlowGraph.edgeSemantics.js';

test('keeps technical join types out of display labels', () => {
  assert.deepEqual(classifyFlowEdge('XOR_JOIN', { label: 'exclusive alternative', flowLayer: 'mixed' }), {
    displayLabel: '',
    flowRoles: ['Control'],
    controlKind: 'merge',
  });
});

test('materializes decision outcomes as explicit control labels', () => {
  assert.equal(classifyFlowEdge('TRUE').displayLabel, 'TRUE');
  assert.equal(classifyFlowEdge('FALSE').displayLabel, 'FALSE');
  assert.equal(classifyFlowEdge('FALSE', { label: 'else' }).displayLabel, 'else');
});

test('uses extracted slot names as data labels', () => {
  assert.deepEqual(classifyFlowEdge('ARG', { argumentName: 'commandName' }), {
    displayLabel: 'commandName',
    flowRoles: ['Data'],
    dataKind: 'transfer',
  });
  assert.equal(classifyFlowEdge('FIELD', { fieldName: 'attribution' }).displayLabel, 'attribution');
});

test('represents a request with one relationship and multiple roles', () => {
  assert.deepEqual(classifyFlowEdge('REQUEST'), {
    displayLabel: '',
    flowRoles: ['Control', 'Data', 'Effect'],
    controlKind: 'invoke',
    dataKind: 'demand',
    effectKind: 'request',
  });
});

test('classifies eval as one mixed control and data relationship', () => {
  assert.deepEqual(classifyFlowEdge('EVAL', { label: 'eval' }), {
    displayLabel: 'eval',
    flowRoles: ['Control', 'Data'],
    controlKind: 'initiate',
    dataKind: 'demand',
  });
});
