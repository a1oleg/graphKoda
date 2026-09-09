import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import ts from 'typescript';
import projectPaths from '../../../dev/projectPaths.cjs';
import {getExtendedStableId, getRepoRelativePath} from './functionFlowGraph.infrastructure.ts';

test('external source coordinates do not depend on the tool working directory', () => {
  const file=path.join(projectPaths.sourceRoot,'screens','fixture.ts');
  const source=ts.createSourceFile(file,'const value = 1;',ts.ScriptTarget.ESNext,true);
  assert.equal(getRepoRelativePath(file),'screens/fixture.ts');
  assert.equal(getExtendedStableId(source,source.statements[0]),'screens/fixture.ts:1:0:1:16');
});
