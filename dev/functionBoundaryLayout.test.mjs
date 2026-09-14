import assert from 'node:assert/strict';
import test from 'node:test';
import { DOMParser } from '@xmldom/xmldom';
import { makeDrawio } from './localCoordinateDrawio.mjs';

test('End matches Start and follows Steps with sparse semantic orders', () => {
  const nodes = [
    { id: 'start', labels: ['FunctionStart', 'Start'], props: { displayX: 0, displayY: 0 } },
    { id: 'body', labels: ['Call'], props: { displayX: 0, displayY: 1,
      parentStepStableId: 'step', flowStepOrder: 20, diaName: 'work()' } },
    { id: 'end', labels: ['FunctionEnd'], props: { displayX: 0, displayY: 2 } },
  ];
  const xml = makeDrawio(nodes, [
    { start: 'start', end: 'body', type: 'NEXT', props: {} },
    { start: 'body', end: 'end', type: 'NEXT', props: {} },
  ], { semanticNodes: [{ key: 'step', labels: ['Step'], props: { flowStepOrder: 20 } }] });
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const cells = [...doc.getElementsByTagName('mxCell')];
  const byId = new Map(cells.map(c => [c.getAttribute('id'), c]));
  const cell = stableId => cells.find(c => c.getAttribute('stableId') === stableId && c.getAttribute('vertex') === '1');
  const rect = c => c.getElementsByTagName('mxGeometry')[0];
  const y = c => c ? Number(rect(c)?.getAttribute('y') || 0) + y(byId.get(c.getAttribute('parent'))) : 0;
  for (const dimension of ['width', 'height']) {
    assert.equal(rect(cell('end')).getAttribute(dimension), rect(cell('start')).getAttribute(dimension));
  }
  assert(y(cell('end')) > y(cell('body')) + Number(rect(cell('body')).getAttribute('height')));
});
