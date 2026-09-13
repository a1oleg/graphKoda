import assert from 'node:assert/strict';
import test from 'node:test';
import { shuffle } from './shuffle.js';

test('shuffle preserves the eight letters from its actual starting set', () => {
  assert.deepEqual(shuffle().sort(), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
});
