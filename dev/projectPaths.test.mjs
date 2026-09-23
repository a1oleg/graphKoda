import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import projectPaths from './projectPaths.cjs';
import {repositoryIdentity} from './projectStatus.mjs';

test('source and data roots can be selected independently of cwd', () => {
  const helper=path.join(projectPaths.toolRoot,'dev/projectPaths.cjs');
  const env={...process.env,graphKoda_SOURCE_ROOT:'../fixture-source',graphKoda_DATA_ROOT:'../fixture-data'};
  const output=execFileSync(process.execPath,['-e',`console.log(JSON.stringify(require(${JSON.stringify(helper)})))`],{cwd:path.dirname(projectPaths.toolRoot),env,encoding:'utf8'});
  const roots=JSON.parse(output);
  assert.equal(roots.toolRoot,projectPaths.toolRoot);
  assert.equal(roots.sourceRoot,path.resolve(projectPaths.toolRoot,'../fixture-source'));
  assert.equal(roots.dataRoot,path.resolve(projectPaths.toolRoot,'../fixture-data'));
});

test('repository versions are Git identities, not application version counters', () => {
  const identity=repositoryIdentity(projectPaths.toolRoot);
  assert.match(identity.commit,/^[a-f0-9]{40,64}$/);
  assert.equal(identity.shortCommit,identity.commit.slice(0,12));
  assert.equal(typeof identity.dirty,'boolean');
});
