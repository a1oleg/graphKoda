import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldMaterializeStorageFactInFunction } from './functionFlowGraph.storage.js';

test('build gates stay at feature(...) call sites instead of becoming function storage', () => {
  assert.equal(shouldMaterializeStorageFactInFunction({ storageClass: 'build-gate' }), false);
  assert.equal(shouldMaterializeStorageFactInFunction({ storageClass: 'runtime-feature-store' }), true);
  assert.equal(shouldMaterializeStorageFactInFunction({ storageClass: 'config-store' }), true);
});
