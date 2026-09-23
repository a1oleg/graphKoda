import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import path from 'node:path';
import projectPaths from './projectPaths.cjs';

import { transform } from 'esbuild';

import { instrumentNodePassSource } from './instrumentNodePassSource.mjs';

test('instrumented REPL compiles when a logged binding awaits its value', async () => {
  const filePath = 'screens/REPL.tsx';
  const source = await readFile(path.join(projectPaths.sourceRoot, filePath), 'utf8');
  const instrumented = await instrumentNodePassSource(source, filePath);

  assert.match(instrumented, /await globalThis\.__graphKodaEvaluateAsyncNode/);
  assert.equal((instrumented.match(/role:\s*"parameter-value"/g) || []).length, 4);
  assert.ok(
    instrumented.lastIndexOf('role:"parameter-value"')
      < instrumented.indexOf('stableId:"screens/REPL.tsx:3151:4:3151:17"'),
    'received parameters must be logged before the onSubmit body executes',
  );
  await transform(instrumented, {
    sourcefile: filePath,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    loader: 'tsx',
    jsx: 'automatic',
  });
});
