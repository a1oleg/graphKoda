import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { config as loadDotEnv } from 'dotenv';
import neo4j from 'neo4j-driver';

import {
  buildDerivedGraphLoggingEnvPayload,
  deriveGraphLoggingProfileFromSession,
  readGraphFromJson,
} from '../graph/derivedLoggingProfile.js';

const workspaceRoot = process.cwd();
const DEFAULT_HOPS = 3;
const DEFAULT_MAX_NODES = 80;
const DEFAULT_MAX_EDGES = 160;

function parseArgs(argv) {
  const args = {
    hops: DEFAULT_HOPS,
    maxNodes: DEFAULT_MAX_NODES,
    maxEdges: DEFAULT_MAX_EDGES,
    skipExtract: false,
    includeCallers: true,
    includeRuntimeBridge: undefined,
    headFnStableId: undefined,
    headFnName: undefined,
    headPathSnippet: undefined,
    featureName: undefined,
    graphJsonPath: undefined,
    configOutput: undefined,
    printConfigOnly: false,
    format: 'env-json',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--skip-extract' || arg === '--skip-import') {
      args.skipExtract = true;
      continue;
    }
    if (arg === '--include-callers') {
      args.includeCallers = true;
      continue;
    }
    if (arg === '--no-include-callers') {
      args.includeCallers = false;
      continue;
    }
    if (arg === '--print-config') {
      args.printConfigOnly = true;
      continue;
    }
    if (arg === '--include-runtime-bridge') {
      args.includeRuntimeBridge = true;
      continue;
    }
    if (arg === '--no-runtime-bridge') {
      args.includeRuntimeBridge = false;
      continue;
    }

    const value = argv[index + 1];
    if (arg === '--hops') {
      args.hops = Number(value);
      index += 1;
    } else if (arg === '--max-nodes') {
      args.maxNodes = Number(value);
      index += 1;
    } else if (arg === '--max-edges') {
      args.maxEdges = Number(value);
      index += 1;
    } else if (arg === '--head-fn-stable-id') {
      args.headFnStableId = value;
      index += 1;
    } else if (arg === '--head-fn-name') {
      args.headFnName = value;
      index += 1;
    } else if (arg === '--head-path-snippet') {
      args.headPathSnippet = value;
      index += 1;
    } else if (arg === '--feature-name') {
      args.featureName = value;
      index += 1;
    } else if (arg === '--graph-json') {
      args.graphJsonPath = path.resolve(value);
      index += 1;
    } else if (arg === '--config-output') {
      args.configOutput = path.resolve(value);
      index += 1;
    } else if (arg === '--format') {
      args.format = value;
      index += 1;
    }
  }

  if (args.headFnStableId && args.headFnName) {
    throw new Error('Use either --head-fn-stable-id or --head-fn-name, not both.');
  }

  if (!Number.isFinite(args.hops) || args.hops < 1) {
    throw new Error(`Expected --hops to be a positive number, got: ${args.hops}`);
  }
  if (!Number.isFinite(args.maxNodes) || args.maxNodes < 1) {
    throw new Error(`Expected --max-nodes to be a positive number, got: ${args.maxNodes}`);
  }
  if (!Number.isFinite(args.maxEdges) || args.maxEdges < 1) {
    throw new Error(`Expected --max-edges to be a positive number, got: ${args.maxEdges}`);
  }

  args.mode = args.headFnStableId || args.headFnName ? 'head' : 'screenshare';

  return args;
}

function runCommand(command, commandArgs, description) {
  const result = spawnSync(command, commandArgs, {
    cwd: workspaceRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32' && !path.isAbsolute(command) && !command.includes(path.sep),
  });

  if (result.error) {
    throw result.error;
  }

  if ((result.status ?? 0) !== 0) {
    throw new Error(`${description} failed with exit code ${result.status ?? 1}`);
  }
}

function printResult(args, payload) {
  if (args.format === 'config-json' || args.printConfigOnly) {
    process.stdout.write(`${JSON.stringify(payload.request.config, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(payload.env, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  loadDotEnv({ path: path.join(workspaceRoot, 'graph', '.env') });

  if (args.graphJsonPath) {
    const graph = readGraphFromJson(args.graphJsonPath);
    const payload = buildDerivedGraphLoggingEnvPayload({
      featureName: args.featureName || (args.mode === 'screenshare' ? 'screenshare' : 'feature'),
      graph,
      graphJsonPath: args.graphJsonPath,
      runtimeBridgeGraph: undefined,
    });

    if (args.configOutput) {
      await import('node:fs/promises').then(({ writeFile }) => writeFile(args.configOutput, `${JSON.stringify(payload, null, 2)}\n`, 'utf8'));
    }

    printResult(args, payload);
    return;
  }

  if (!args.skipExtract) {
    runCommand(process.execPath, ['./dev/runGraphExtract.mjs', 'func'], 'Function-flow extract');
  }

  const database = process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j';
  const driver = neo4j.driver(
    process.env.NEO4J_URI,
    neo4j.auth.basic(process.env.NEO4J_USER || process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD),
  );

  const session = driver.session({ database });
  try {
    const { graph, seedFunctions, runtimeBridgeGraph } = await deriveGraphLoggingProfileFromSession({ session, args });
    const payload = buildDerivedGraphLoggingEnvPayload({
      featureName: args.featureName || (args.mode === 'screenshare' ? 'screenshare' : 'feature'),
      graph,
      seedFunctions,
      runtimeBridgeGraph,
    });

    if (args.configOutput) {
      await import('node:fs/promises').then(({ writeFile }) => writeFile(args.configOutput, `${JSON.stringify(payload, null, 2)}\n`, 'utf8'));
    }

    printResult(args, payload);
  } finally {
    await session.close();
    await driver.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

