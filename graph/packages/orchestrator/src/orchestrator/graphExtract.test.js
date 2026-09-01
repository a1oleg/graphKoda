import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExtractCommand,
  getExtractPlan,
  getExtractPreflight,
  normalizePreserveAnnotations,
} from './graphExtract.js';

test('scoped imports preserve annotations by default', () => {
  assert.equal(getExtractPlan().scopedFuncImport.preserveAnnotations.default, true);
  assert.equal(normalizePreserveAnnotations(undefined), true);
  assert.equal(normalizePreserveAnnotations(true), true);
});

test('scoped imports accept an explicit annotation replacement option', () => {
  assert.equal(normalizePreserveAnnotations(false), false);
  assert.equal(normalizePreserveAnnotations('false'), false);
  assert.equal(normalizePreserveAnnotations('0'), false);
});

test('extract preflight describes concrete runner dependencies', () => {
  const preflight = getExtractPreflight({ mode: 'func' });
  assert.equal(preflight.ok, true);
  assert.equal(preflight.mode, 'func');
  assert.equal(preflight.checks.importer.ready, true);
  assert.equal(preflight.checks.npmScript.name, 'graph:extract:func');
  assert.deepEqual(preflight.checks.python.modules, ['duckdb', 'neo4j']);
  assert.equal(typeof preflight.process.ready, 'boolean');
});

test('extract arguments never pass through a command shell', () => {
  const hostileStableId = 'src/a.ts:1:0:2:1 & echo injected';
  const command = buildExtractCommand('func', ['--fn-stable-id', hostileStableId]);

  assert.equal(command.command, process.execPath);
  assert.match(command.args[0], /dev[\\/]runGraphExtract\.mjs$/u);
  assert.deepEqual(command.args.slice(1), ['func', '--fn-stable-id', hostileStableId]);
});
