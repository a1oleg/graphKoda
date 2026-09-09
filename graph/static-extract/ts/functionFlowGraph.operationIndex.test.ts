import assert from 'node:assert/strict';
import test from 'node:test';
import { collectOperationIds, attachImmediateStepOperationGraph } from './fromASTtoPreGraphFlow.ts';

test('operation index selects the same IDs and is reusable without rescanning declarations', () => {
  let labelReads = 0;
  const entities = Array.from({ length: 1000 }, (_, i) => ({
    stableId: `source.ts:${i}:0:${i}:1`,
    get labels() { labelReads++; return i % 2 ? ['Declaration'] : ['Operation']; },
    props: {},
  }));
  const index = collectOperationIds(entities);
  assert.equal(index.size, 500);
  assert.equal(labelReads, 1000);
  for (let i = 0; i < 100; i++) {
    const payload = { functions: [], nodes: [], edges: [], semanticEntities: entities };
    attachImmediateStepOperationGraph(payload, index);
  }
  assert.equal(labelReads, 1000);
  assert.deepEqual([...index], entities.filter(e => e.labels.includes('Operation')).map(e => e.stableId));
});

test('shared and local operation indexes emit identical immediate ownership edges', () => {
  const entities = [{ stableId: 'operation', labels: ['Operation'], props: {} }];
  const makePayload = () => ({
    functions: [], edges: [], semanticEntities: entities,
    nodes: ['operation', 'not-operation'].map(value => ({
      stableId: { value }, parentFnStableId: { value: 'fn' },
      parentStepStableId: 'step', labels: [], label: value, repoRelativePath: 'source.ts',
    })),
    semanticRelationships: [] as { fromId: string; toId: string; type: string; props: Record<string, unknown> }[],
  });
  const local = makePayload();
  const shared = makePayload();
  attachImmediateStepOperationGraph(local);
  const index = collectOperationIds(entities);
  attachImmediateStepOperationGraph(shared, index);
  attachImmediateStepOperationGraph(shared, index);
  assert.deepEqual(shared, local);
  assert.equal(shared.semanticRelationships.length, 1);
  assert.equal(shared.semanticRelationships[0].toId, 'operation');
  assert.equal(shared.semanticRelationships[0].fromId, 'step');
});
