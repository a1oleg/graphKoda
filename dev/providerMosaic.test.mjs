import test from 'node:test';
import assert from 'node:assert/strict';
import {providerMosaicParts} from './providerMosaic.mjs';

test('provider calls use property joints, including empty argument lists', () => {
  const provider = { text: 'Math', kind: 'value', labels: ['SystemProvider'] };
  const parts = [provider, { text: 'floor(', kind: 'method' }, provider, { text: 'random()', kind: 'method' }];
  const result = providerMosaicParts(parts);
  assert.deepEqual(result.map(p => p.text), ['Math', '.floor(', 'Math', '.random()']);
  assert.deepEqual(providerMosaicParts(result), result);
  assert.equal(parts[1].text, 'floor(');
});

test('unqualified and virtual methods keep their labels', () => {
  const parts = [{ text: 'value', kind: 'value' }, { text: 'call()', kind: 'method' },
    { text: 'items', kind: 'value', labels: ['OperationProvider'] },
    { text: 'set(', kind: 'method', labels: ['Virtual'] }];
  assert.deepEqual(providerMosaicParts(parts), parts);
});
