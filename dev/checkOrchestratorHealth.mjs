import process from 'node:process';

import { config as loadDotEnv } from 'dotenv';

import { startOrchestrator } from '../graph/packages/orchestrator/src/orchestrator.js';

const workspaceRoot = process.cwd();
const orchestratorHost = process.env.ORCHESTRATOR_HOST || process.env.GRAPH_GATEWAY_HOST || '127.0.0.1';
const orchestratorPort = Number(process.env.ORCHESTRATOR_PORT || process.env.GRAPH_GATEWAY_PORT || 8791);

function parseArgs(argv) {
  const args = {
    orchestratorUrl: undefined,
    noStart: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === '--orchestrator-url' || arg === '--gateway-url') {
      args.orchestratorUrl = value;
      index += 1;
    } else if (arg === '--no-start') {
      args.noStart = true;
    }
  }

  return args;
}

async function callOrchestrator(url, pathname, options = {}) {
  const response = await fetch(new URL(pathname, url), {
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    throw new Error(`Orchestrator request failed with HTTP ${response.status}`);
  }

  return response.json();
}

async function startDedicatedOrchestrator(port = 0) {
  const orchestrator = await startOrchestrator({
    uri: process.env.NEO4J_URI,
    user: process.env.NEO4J_USER || process.env.NEO4J_USERNAME,
    password: process.env.NEO4J_PASSWORD,
    database: process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j',
    host: orchestratorHost,
    port,
  });

  return {
    ...orchestrator,
    owned: true,
  };
}

async function resolveOrchestratorConnection(preferredUrl, options = {}) {
  const orchestratorUrl = preferredUrl || `http://${orchestratorHost}:${orchestratorPort}/`;

  try {
    await callOrchestrator(orchestratorUrl, '/api/status/gateway');
    return {
      url: orchestratorUrl,
      owned: false,
      async stop() {
      },
    };
  } catch (error) {
    if (options.noStart) {
      return {
        url: orchestratorUrl,
        owned: false,
        connectError: error instanceof Error ? error.message : String(error),
        startError: null,
        async stop() {
        },
      };
    }

    try {
      return await startDedicatedOrchestrator(orchestratorPort);
    } catch (startError) {
      return {
        url: orchestratorUrl,
        owned: false,
        connectError: error instanceof Error ? error.message : String(error),
        startError: startError instanceof Error ? startError.message : String(startError),
        async stop() {
        },
      };
    }
  }
}

async function safeCallOrchestrator(url, pathname, options) {
  try {
    return {
      ok: true,
      data: await callOrchestrator(url, pathname, options),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  loadDotEnv({ path: `${workspaceRoot}/graph/.env` });

  const args = parseArgs(process.argv.slice(2));
  const orchestrator = await resolveOrchestratorConnection(args.orchestratorUrl, { noStart: args.noStart });

  try {
    const gatewayStatusResult = await safeCallOrchestrator(orchestrator.url, '/api/status/gateway');
    const neo4jStatusResult = gatewayStatusResult.ok
      ? await safeCallOrchestrator(orchestrator.url, '/api/status/neo4j')
      : { ok: false, error: 'Skipped neo4j status probe because orchestrator status probe failed.' };

    const healthResult = gatewayStatusResult.ok
      ? await safeCallOrchestrator(orchestrator.url, '/health')
      : { ok: false, error: 'Skipped health probe because orchestrator status probe failed.' };

    const recommendedNeo4jStartAction = !neo4jStatusResult.ok || !neo4jStatusResult.data?.healthy
      ? {
        method: 'POST',
        path: '/api/actions/start-neo4j',
        url: new URL('/api/actions/start-neo4j', orchestrator.url).toString(),
      }
      : null;

    process.stdout.write(`${JSON.stringify({
      orchestratorUrl: orchestrator.url,
      ownedOrchestrator: orchestrator.owned,
      connectError: orchestrator.connectError || null,
      startError: orchestrator.startError || null,
      orchestratorStatus: gatewayStatusResult.ok
        ? gatewayStatusResult.data
        : { ok: false, url: orchestrator.url, error: gatewayStatusResult.error },
      neo4jStatus: neo4jStatusResult.ok
        ? neo4jStatusResult.data
        : { ok: false, database: process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j', uri: process.env.NEO4J_URI || null, error: neo4jStatusResult.error },
      health: healthResult.ok
        ? healthResult.data
        : { ok: false, database: process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j', uri: process.env.NEO4J_URI || null, error: healthResult.error },
      recommendedNeo4jStartAction,
    }, null, 2)}\n`);
  } finally {
    await orchestrator.stop();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

