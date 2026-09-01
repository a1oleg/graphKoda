import fs from 'node:fs';
import path from 'node:path';

import { config } from 'dotenv';

import { startOrchestrator } from '../graph/packages/orchestrator/src/orchestrator.js';
import {
  DEFAULT_ORCHESTRATOR_PORT,
  DEVOPS_SERVICE_LOG_DIR,
  buildOrchestratorConfig,
} from '../graph/packages/orchestrator/src/orchestrator/config.js';

config({ path: 'graph/.env' });

const orchestratorConfig = buildOrchestratorConfig({
  allowStatefulMutations: true,
});
const persistProcessState = orchestratorConfig.persistProcessState;

const ORCHESTRATOR_SERVICE_STATE_PATH = path.join(DEVOPS_SERVICE_LOG_DIR, 'orchestrator.state.json');
const ORCHESTRATOR_LOG_PATH = path.join(DEVOPS_SERVICE_LOG_DIR, 'orchestrator.log');

function ensureOrchestratorLogDir() {
  fs.mkdirSync(DEVOPS_SERVICE_LOG_DIR, { recursive: true });
}

function appendOrchestratorLog(message) {
  if (!persistProcessState) {
    return;
  }

  ensureOrchestratorLogDir();
  fs.appendFileSync(ORCHESTRATOR_LOG_PATH, `[${new Date().toISOString()}] ${message}\n`);
}

function writeOrchestratorState(record) {
  if (!persistProcessState) {
    return;
  }

  ensureOrchestratorLogDir();
  fs.writeFileSync(ORCHESTRATOR_SERVICE_STATE_PATH, JSON.stringify(record, null, 2));
}

const host = process.env.ORCHESTRATOR_HOST || process.env.GRAPH_GATEWAY_HOST || '127.0.0.1';
const port = Number(process.env.ORCHESTRATOR_PORT || process.env.GRAPH_GATEWAY_PORT || DEFAULT_ORCHESTRATOR_PORT);
const user = process.env.NEO4J_USER || process.env.NEO4J_USERNAME;
const database = process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j';
const startedAt = new Date().toISOString();

const orchestrator = await startOrchestrator({
  uri: process.env.NEO4J_URI,
  user,
  password: process.env.NEO4J_PASSWORD,
  database,
  host,
  port,
  orchestratorConfig,
});

writeOrchestratorState({
  pid: process.pid,
  execPath: process.execPath,
  script: 'graph:orchestrator',
  startedAt,
  logPath: ORCHESTRATOR_LOG_PATH,
  running: true,
  lastExitCode: null,
  url: orchestrator.url,
});
appendOrchestratorLog(`orchestrator listening on ${orchestrator.url}`);

let hasExitRecorded = false;

function recordOrchestratorExit(lastExitCode = 0, reason = 'exit') {
  if (hasExitRecorded) {
    return;
  }

  hasExitRecorded = true;
  writeOrchestratorState({
    pid: process.pid,
    execPath: process.execPath,
    script: 'graph:orchestrator',
    startedAt,
    logPath: ORCHESTRATOR_LOG_PATH,
    running: false,
    lastExitCode,
    url: orchestrator.url,
  });
  appendOrchestratorLog(`orchestrator ${reason} code=${lastExitCode}`);
}

async function stopOrchestratorAndExit(lastExitCode = 0, reason = 'exit') {
  recordOrchestratorExit(lastExitCode, reason);
  await orchestrator.stop().catch(() => undefined);
  process.exit(lastExitCode);
}

process.on('exit', (code) => {
  recordOrchestratorExit(code ?? 0, 'exit');
});

process.on('SIGINT', () => {
  stopOrchestratorAndExit(0, 'sigint');
});

process.on('SIGTERM', () => {
  stopOrchestratorAndExit(0, 'sigterm');
});

process.on('uncaughtException', (error) => {
  appendOrchestratorLog(`uncaughtException: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  stopOrchestratorAndExit(1, 'uncaught-exception');
});

process.on('unhandledRejection', (error) => {
  appendOrchestratorLog(`unhandledRejection: ${error instanceof Error ? error.stack || error.message : String(error)}`);
});

console.log(`orchestrator listening on ${orchestrator.url}`);

