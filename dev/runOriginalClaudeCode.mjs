import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config as loadDotEnv } from 'dotenv';
import projectPaths from './projectPaths.cjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const loaderImport =
  'data:text/javascript,' +
  encodeURIComponent(
    [
      'import { register } from "node:module";',
      'import { pathToFileURL } from "node:url";',
      'register("./dev/originalAppLoader.mjs", pathToFileURL("./"));',
    ].join(' '),
  );

const hadAnthropicApiKey = Object.hasOwn(process.env, 'ANTHROPIC_API_KEY');
const dotenvResult = loadDotEnv({ path: path.join(root, 'graph', '.env'), quiet: true });

const passthroughArgs = process.argv.slice(2);
if (
  process.env.graphKoda_ORIGINAL_AUTH !== 'api_key' &&
  !hadAnthropicApiKey &&
  dotenvResult.parsed &&
  Object.hasOwn(dotenvResult.parsed, 'ANTHROPIC_API_KEY')
) {
  delete process.env.ANTHROPIC_API_KEY;
}
const debugFileIndex = passthroughArgs.indexOf('--debug-file');
const debugFile =
  debugFileIndex >= 0 && passthroughArgs[debugFileIndex + 1]
    ? path.resolve(root, passthroughArgs[debugFileIndex + 1])
    : null;
if (debugFile) {
  appendFileSync(
    debugFile,
    [
      `${new Date().toISOString()} [DEBUG] [original-runner] stdinTTY=${Boolean(process.stdin.isTTY)} stdoutTTY=${Boolean(process.stdout.isTTY)} stderrTTY=${Boolean(process.stderr.isTTY)}`,
      `${new Date().toISOString()} [DEBUG] [original-runner] cwd=${root}`,
      `${new Date().toISOString()} [DEBUG] [original-runner] CLAUDE_CODE_NO_FLICKER=${process.env.CLAUDE_CODE_NO_FLICKER || '0'}`,
    ].join('\n') + '\n',
  );
}

const args = [
  '--import',
  'tsx',
  '--import',
  './dev/originalAppGlobals.mjs',
  '--import',
  loaderImport,
  path.join(projectPaths.sourceRoot, 'entrypoints', 'cli.tsx'),
  ...passthroughArgs,
];

const child = spawn(process.execPath, args, {
  cwd: root,
  env: {
    ...process.env,
    CLAUDE_CODE_DEV_VERSION:
      process.env.CLAUDE_CODE_DEV_VERSION || '999.0.0',
    DISABLE_TELEMETRY: process.env.DISABLE_TELEMETRY || '1',
    CLAUDE_CODE_ENABLE_TELEMETRY:
      process.env.CLAUDE_CODE_ENABLE_TELEMETRY || '0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:
      process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC || '1',
    CLAUDE_CODE_NO_FLICKER: process.env.CLAUDE_CODE_NO_FLICKER || '0',
  },
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (debugFile) {
    appendFileSync(
      debugFile,
      `${new Date().toISOString()} [DEBUG] [original-runner] child exit code=${code ?? 'null'} signal=${signal ?? 'null'}\n`,
    );
  }
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
