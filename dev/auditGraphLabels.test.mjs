import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeGroups } from './auditGraphLabels.mjs';

test('normalizes label order, keeps explicit kind, and computes directional overlap', () => {
  const report = summarizeGroups([
    { labels: ['B', 'A'], count: 2, explicitKind: null, example: 'one' },
    { labels: ['A', 'B'], count: 3, explicitKind: null, example: 'two' },
    { labels: ['A'], count: 5, explicitKind: null },
  ], ['A', 'B', 'Empty']);
  assert.equal(report.totalNodes, 10);
  assert.equal(report.combinations.length, 2);
  assert.deepEqual(report.intersections[0], { left: 'A', right: 'B', count: 5, leftCoverage: 0.5, rightCoverage: 1, identical: false });
  assert.equal(report.labels.find(x => x.label === 'Empty').count, 0);
});

test('uses production profile precedence rather than assuming explicit kind wins', () => {
  const report = summarizeGroups([{ labels: ['Call'], explicitKind: 'Binding', count: 1 }]);
  assert.equal(report.combinations[0].inferredKind, 'CallSite');
  assert.deepEqual(report.combinations[0].decisiveLabels, ['Call']);
});
