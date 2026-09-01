import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

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

  return candidates.find((candidate) => {
    if (candidate.includes(path.sep) && !existsSync(candidate)) {
      return false;
    }

    const result = spawnSync(candidate, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
    });
    return result.status === 0;
  });
}

const phaseArgs = {
  func: ['func'],
};

const modePlan = {
  func: ['func'],
};

const [mode = 'func', ...extraArgs] = process.argv.slice(2);
const steps = modePlan[mode];

if (!steps) {
  console.error(`Unknown graph extract mode: ${mode}`);
  console.error(`Expected one of: ${Object.keys(modePlan).join(', ')}`);
  process.exit(1);
}

const pythonExecutable = resolvePythonExecutable();
if (!pythonExecutable) {
  console.error('Could not resolve a Python executable for graph extract.');
  process.exit(1);
}

const importerPath = path.join(workspaceRoot, 'graph', 'static-extract', 'py', 'fromPreGraphToNeo4j.py');

function runExtractPhase(phase) {
  const extractorModeArgs = phaseArgs[phase];
  if (!extractorModeArgs) {
    throw new Error(`Unknown graph extract phase: ${phase}`);
  }

  console.error(`[graph:extract:${mode}] phase ${phase}`);
  const result = spawnSync(
    pythonExecutable,
    [importerPath, ...extractorModeArgs, ...extraArgs],
    {
      cwd: workspaceRoot,
      stdio: 'inherit',
    },
  );

  if (result.error) {
    console.error(result.error.message);
    return 1;
  }

  return result.status ?? 1;
}

for (const step of steps) {
  const status = runExtractPhase(step);
  if (status !== 0) {
    process.exit(status);
  }
}

process.exit(0);

