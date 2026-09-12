import assert from 'node:assert/strict';
import test from 'node:test';
import { shuffle } from './shuffle.js';

test('empty and single-item inputs need no randomness', t => {
  t.mock.method(Math, 'random', () => { throw new Error('Unexpected random call'); });
  assert.deepEqual(shuffle([]), []);
  assert.deepEqual(shuffle(['Alice']), ['Alice']);
});

test('known choices produce a reproducible order without mutating the input', t => {
  const input = Object.freeze(['Alice', 'Bob', 'Charlie', 'Diana']);
  const values = [0, 0.5, 0.99];
  let calls = 0;
  t.mock.method(Math, 'random', () => values[calls++]);
  const result = shuffle(input);
  assert.deepEqual(result, ['Diana', 'Charlie', 'Bob', 'Alice']);
  assert.deepEqual(input, ['Alice', 'Bob', 'Charlie', 'Diana']);
  assert.notEqual(result, input);
  assert.equal(calls, input.length - 1);
});

test('upper selection boundary permits swapping a position with itself', t => {
  t.mock.method(Math, 'random', () => 1 - Number.EPSILON);
  assert.deepEqual(shuffle([1, 2, 3]), [1, 2, 3]);
});

test('all six selection sequences for three elements yield distinct permutations', t => {
  const permutations = new Set<string>();
  let choices: number[] = [];
  let call = 0;
  t.mock.method(Math, 'random', () => choices[call++]);
  for (let first = 0; first < 3; first++) {
    for (let second = 0; second < 2; second++) {
      choices = [(first + 0.5) / 3, (second + 0.5) / 2];
      call = 0;
      permutations.add(JSON.stringify(shuffle([1, 2, 3])));
    }
  }
  assert.equal(permutations.size, 6);
});

test('duplicates and object identities are preserved', t => {
  t.mock.method(Math, 'random', () => 0);
  const first = { name: 'Alice' }, second = { name: 'Bob' };
  const result = shuffle([first, second, first]);
  assert.equal(result.filter(item => item === first).length, 2);
  assert.equal(result.filter(item => item === second).length, 1);
});

test('standard randomness preserves all input elements', () => {
  assert.deepEqual(shuffle([1, 2, 3, 4]).sort(), [1, 2, 3, 4]);
});
