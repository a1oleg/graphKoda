import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const workspaceRoot = process.cwd();

function resolvePythonExecutable() {
  const candidates = process.platform === 'win32'
    ? [
      path.join(workspaceRoot, '.venv', 'Scripts', 'python.exe'),
      'python',
      'py',
    ]
    : [
      path.join(workspaceRoot, '.venv', 'bin', 'python3'),
      path.join(workspaceRoot, '.venv', 'bin', 'python'),
      'python3',
      'python',
    ];

  return candidates.find((candidate) => candidate.includes(path.sep) ? existsSync(candidate) : true);
}

const pythonExecutable = resolvePythonExecutable();
if (!pythonExecutable) {
  console.error('Could not resolve a Python executable for graph extract readiness.');
  process.exit(1);
}

console.error(
  [
    'graph extract readiness is not available in the current canonical pipeline.',
    `Workspace: ${workspaceRoot}`,
    'Use graph:extract:func for the TS/CodeQL function-flow import.',
  ].join(' '),
);
process.exit(1);

