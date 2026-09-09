import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import projectPaths from './projectPaths.cjs';

export function repositoryIdentity(root) {
  const git = args => execFileSync('git', args, {cwd:root, encoding:'utf8', stdio:['ignore','pipe','ignore']}).trim();
  const commit = git(['rev-parse', 'HEAD']);
  return {commit, shortCommit:commit.slice(0,12), dirty:Boolean(git(['status','--porcelain','--untracked-files=all']))};
}

export function projectStatus() {
  return {...projectPaths, extractor:repositoryIdentity(projectPaths.toolRoot), source:repositoryIdentity(projectPaths.sourceRoot)};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(projectStatus(), null, 2));
}
