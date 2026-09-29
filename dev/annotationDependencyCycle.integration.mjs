import assert from 'node:assert/strict';
import fs from 'node:fs';
import { annotationDependencyCycle } from '../graph/packages/orchestrator/src/orchestrator/annotationDependencyCycle.js';
import { buildAnnotationTask } from '../graph/packages/orchestrator/src/orchestrator/annotationResolver.js';

// Use the witnessed cycle from the actual extracted project, not a fixture.
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const witness = report.reciprocalCycleWitness;
assert.ok(witness?.length >= 2, 'Real extraction must supply cycle evidence');
const graph = new Map();
for (const edge of witness) {
  assert.ok(edge.evidence.length);
  graph.set(edge.consumer, [...(graph.get(edge.consumer) || []), edge.prerequisite]);
}
for (const start of graph.keys()) {
  const cycle = annotationDependencyCycle(start, graph);
  assert.equal(cycle.kind, 'cyclic-dependency');
  assert.equal(cycle.codeRecursionConfirmed, false);
  assert.equal(cycle.witnessStableIds[0], start);
  assert.equal(cycle.witnessStableIds.at(-1), start);
  for (let i = 1; i < cycle.witnessStableIds.length; i++) {
    assert.ok(graph.get(cycle.witnessStableIds[i - 1]).includes(cycle.witnessStableIds[i]));
  }
  const task = buildAnnotationTask({stableId: start, annotationKind: 'EntityContext',
    context: {dependencyCycle: cycle}, dependencies: []}, start);
  assert.deepEqual(task.contextBundle.context.dependencyCycle, cycle);
  assert.ok(task.requirements.some(text => text.includes('cyclic dependency')));
}
// A partial observation of that same real path must not claim a proven cycle.
const edge = witness[0];
assert.equal(annotationDependencyCycle(edge.consumer,
  new Map([[edge.consumer, [edge.prerequisite]]])), null);
console.log('Verified real cycle witness, task context, reporting requirement, and partial-path boundary.');
