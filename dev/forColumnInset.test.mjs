import test from 'node:test';
import assert from 'node:assert/strict';
import { assignStepAndFlowBlockColumns } from './localCoordinateDrawio.mjs';

test('For continuation uses one third of the block inset and moves its whole axis', () => {
  const node = (id, step, labels = []) => ({ id, labels, props: { parentStepStableId: step } });
  const step = (key, head, block) => ({ key, labels: ['Step'], props: {
    headStableIds: [head], parentFlowBlockStableId: block,
  } });
  const nodes = [node('for', 'root', ['For']), node('condition', 'conditionStep'),
    node('body', 'bodyStep'), node('argument', 'bodyStep'), node('nested', 'nestedStep')];
  const facts = [step('root', 'for'), step('conditionStep', 'condition', 'loop'),
    step('bodyStep', 'body', 'loop'), step('nestedStep', 'nested', 'child'),
    { key: 'loop', labels: ['Block'], props: { headStableIds: ['condition'] } },
    { key: 'child', labels: ['Block'], props: {
      headStableIds: ['nested'], parentFlowBlockStableId: 'loop',
    } }];
  const edges = [{ start: 'for', end: 'condition', type: 'NEXT' },
    { start: 'condition', end: 'nested', type: 'TRUE' }];
  const boxes = new Map(nodes.map(({ id }) => [id, { x: id === 'argument' ? 40 : 0, y: 0, width: 20, height: 20 }]));
  assignStepAndFlowBlockColumns(nodes, edges, facts, boxes, 260);
  assert.equal(boxes.get('condition').x, 260 / 3);
  assert.equal(boxes.get('body').x, 260 / 3);
  assert.equal(boxes.get('argument').x - boxes.get('body').x, 40);
  assert.equal(boxes.get('nested').x, 260 / 3 + 260);
});
