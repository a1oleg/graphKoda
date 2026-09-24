import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import path from 'node:path';
import {transform} from 'esbuild';
import projectPaths from './projectPaths.cjs';
import {instrumentNodePassSource,getNodePassTargetsForFile} from './instrumentNodePassSource.mjs';
test('onSubmit is excluded from the active profile',async()=>{
  assert.deepEqual(getNodePassTargetsForFile('screens/REPL.tsx'),[]);
  assert.equal(await instrumentNodePassSource('unchanged','screens/REPL.tsx'),'unchanged');
});
test('only queryModel entry and stub decision are instrumented',async()=>{
  const file=path.join(projectPaths.sourceRoot,'services/api/claude.ts');
  const source=await readFile(file,'utf8');
  assert.deepEqual(getNodePassTargetsForFile(file,source).map(t=>t.role),['function','predicate']);
  const output=await instrumentNodePassSource(source,file);
  assert.match(output,/__graphKodaLogNodePass/);
  assert.match(output,/__graphKodaEvaluateNode/);
  await transform(output,{loader:'ts',format:'esm',target:'node22'});
});
