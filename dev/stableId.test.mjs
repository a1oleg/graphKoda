import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeStableId } from '../graph/packages/runtime-core/src/stableId.js';

test('normalizes role-suffixed stableIds to code coordinates', () => {
  assert.equal(
    normalizeStableId('screens/REPL.tsx:3142:53:3142:80:parameter'),
    'screens/REPL.tsx:3142:53:3142:80',
  );
});

test('removes a synthetic prefix when the source file is known', () => {
  assert.equal(
    normalizeStableId(
      'flow:call:screens/REPL.tsx:3235:33:3235:128:arg0:call0',
      { sourceFilePath: 'screens/REPL.tsx' },
    ),
    'screens/REPL.tsx:3235:33:3235:128',
  );
});
