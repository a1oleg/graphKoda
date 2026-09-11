import test from 'node:test';
import assert from 'node:assert/strict';
import { contextModel, helpersRoot } from './helpersContext.js';
import { buildFrames } from './annotation-plan/replayModel.js';
import { replayLaunch } from './annotation-plan/replayRoutes.js';

test('graph-backed context preserves IDs and supports descent and return', () => {
  const nodes = [helpersRoot, 'field', 'implementation'].map(stableId => ({ stableId, contextTitle: stableId, startLine: 1 }));
  const edges = [{ from: helpersRoot, to: 'field', type: 'HAS_PROPERTY' }, { from: 'field', to: 'implementation', type: 'RESOLVES_TO_IMPLEMENTATION' }];
  const model = contextModel(nodes, edges);
  const frames = buildFrames(model);
  assert.equal(frames.filter(f => f.kind === 'descend').length, 2);
  assert.equal(frames.filter(f => f.kind === 'receive').length, 2);
  assert.equal(frames.at(-1).kind, 'complete');
  assert.equal(model.nodes[1].stableId, 'field');
  assert.throws(() => contextModel(nodes, [{ from: helpersRoot, to: 'missing' }]));
  assert.equal(replayLaunch(helpersRoot, 'http://localhost').body.mode, 'graph');
});

test('context rejects cycles and disconnected nodes, preserves API boundaries', () => {
  const nodes = [helpersRoot, 'api'].map(stableId => ({ stableId, contextSystemBoundary: stableId === 'api' }));
  const edges = [{ from: helpersRoot, to: 'api', type: 'USES_BINDING' }];
  const model = contextModel(nodes, edges);
  assert.equal(model.nodes[1].system, true);
  assert.equal(buildFrames(model).filter(f => f.kind === 'boundary').length, 1);
  assert.throws(() => contextModel(nodes, [...edges, { from: 'api', to: helpersRoot }]), /cycle/);
  assert.throws(() => contextModel(nodes, []), /Disconnected/);
});
