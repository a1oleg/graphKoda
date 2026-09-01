import { spawnSync } from 'node:child_process';
import path from 'node:path';

const workspaceRoot = process.cwd();
const runnerPath = path.join(workspaceRoot, 'dev', 'codeqlUiActionLinks.mjs');

const result = spawnSync(
  process.execPath,
  [runnerPath, 'storage', ...process.argv.slice(2)],
  {
    cwd: workspaceRoot,
    stdio: 'inherit',
  },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 0);
