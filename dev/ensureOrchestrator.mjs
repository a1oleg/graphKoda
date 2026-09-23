import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { config as loadDotEnv } from 'dotenv';

import {
  DEFAULT_ORCHESTRATOR_PORT,
  DEVOPS_SERVICE_LOG_DIR,
} from '../graph/packages/orchestrator/src/orchestrator/config.js';

const workspaceRoot = process.cwd();
loadDotEnv({ path: path.join(workspaceRoot, 'graph', '.env') });

const host = process.env.ORCHESTRATOR_HOST || process.env.GRAPH_GATEWAY_HOST || '127.0.0.1';
const port = Number(process.env.ORCHESTRATOR_PORT || process.env.GRAPH_GATEWAY_PORT || DEFAULT_ORCHESTRATOR_PORT);
const baseUrl = `http://${host}:${port}/`;
const statusUrl = new URL('/api/status/gateway', baseUrl);
const startScript = path.join(workspaceRoot, 'dev', 'startOrchestrator.mjs');
const stdoutPath = path.join(DEVOPS_SERVICE_LOG_DIR, 'orchestrator.ensure.out.log');
const stderrPath = path.join(DEVOPS_SERVICE_LOG_DIR, 'orchestrator.ensure.err.log');
const windowsLauncherPath = path.join(DEVOPS_SERVICE_LOG_DIR, 'start-orchestrator.cmd');
const scheduledTaskName = 'graphKodaGraphOrchestrator';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readGatewayStatus() {
  const response = await fetch(statusUrl, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function waitForGateway(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      return await readGatewayStatus();
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }

  throw new Error(`Orchestrator did not become reachable at ${statusUrl}: ${lastError?.message || lastError || 'timeout'}`);
}

function quoteCmd(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function getOneMinuteFromNowHHmm() {
  const date = new Date(Date.now() + 60_000);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function startViaWindowsTaskScheduler() {
  const command = [
    '@echo off',
    `cd /d ${quoteCmd(workspaceRoot)}`,
    `${quoteCmd(process.execPath)} ${quoteCmd(startScript)} >> ${quoteCmd(stdoutPath)} 2>> ${quoteCmd(stderrPath)}`,
  ].join('\r\n');
  fs.writeFileSync(windowsLauncherPath, `${command}\r\n`);
  const taskCommand = `${quoteCmd(process.env.ComSpec || 'cmd.exe')} /d /c ${quoteCmd(windowsLauncherPath)}`;

  const taskResult = runCommand('schtasks.exe', [
    '/Create',
    '/TN',
    scheduledTaskName,
    '/SC',
    'ONCE',
    '/ST',
    getOneMinuteFromNowHHmm(),
    '/TR',
    taskCommand,
    '/F',
  ]);
  if (taskResult.status !== 0) {
    throw new Error(`schtasks /Create failed: ${taskResult.stderr || taskResult.stdout}`);
  }

  const runResult = runCommand('schtasks.exe', ['/Run', '/TN', scheduledTaskName]);
  if (runResult.status !== 0) {
    throw new Error(`schtasks /Run failed: ${runResult.stderr || runResult.stdout}`);
  }

  return {
    launcher: 'windows-task-scheduler',
    taskName: scheduledTaskName,
    launcherPath: windowsLauncherPath,
    stdoutPath,
    stderrPath,
  };
}

function tryStartViaWindowsTaskScheduler() {
  try {
    return startViaWindowsTaskScheduler();
  } catch (error) {
    return {
      ...startViaDetachedChild(),
      launcher: 'detached-child-fallback',
      schedulerError: error instanceof Error ? error.message : String(error),
    };
  }
}

function startViaDetachedChild() {
  const stdout = fs.openSync(stdoutPath, 'a');
  const stderr = fs.openSync(stderrPath, 'a');

  const child = spawn(process.execPath, [startScript], {
    cwd: workspaceRoot,
    detached: true,
    env: process.env,
    stdio: ['ignore', stdout, stderr],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(stdout);
  fs.closeSync(stderr);

  return {
    launcher: 'detached-child',
    pid: child.pid,
    stdoutPath,
    stderrPath,
  };
}

async function main() {
  try {
    const status = await readGatewayStatus();
    process.stdout.write(`${JSON.stringify({
      ok: true,
      action: 'adopted',
      url: baseUrl,
      status,
    }, null, 2)}\n`);
    return;
  } catch {
    // Start below.
  }

  fs.mkdirSync(DEVOPS_SERVICE_LOG_DIR, { recursive: true });
  const launch = process.platform === 'win32'
    ? tryStartViaWindowsTaskScheduler()
    : startViaDetachedChild();

  const status = await waitForGateway();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    action: 'started',
    url: baseUrl,
    ...launch,
    status,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
