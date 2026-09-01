import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import pty from 'node-pty';
import { createClient } from 'redis';

import { buildRuntimePathSelection, clearRuntimePathFromDiagram } from './runtimePathDrawio.mjs';

const PROMPT = '\u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0430';
const STUB_RESPONSE = '\u0437\u0430\u0433\u043b\u0443\u0448\u043a\u0430';
const FIRST_PREDICATE_STABLE_ID = 'screens/REPL.tsx:3154:8:3154:28';
const TERMINAL_STEP_STABLE_ID = 'flow-step:condition:screens/REPL.tsx:3161:8:3161:58';
const RELAY_URL = process.env.RUNTIME_RELAY_URL || 'http://127.0.0.1:8787/graph-relay';
const REDIS_URL = process.env.RUNTIME_REDIS_URL || 'redis://127.0.0.1:6379';
const TIMEOUT_MS = Number(process.env.NODE_PASS_SCENARIO_TIMEOUT_MS || 30_000);
const DIAGRAM_PATH = path.resolve('graph/draw/generated/onSubmit-REPL.tsx-3142.drawio');
const CHAIN_PATH = path.resolve('graph/runtime/onSubmit-3154-3161.chain.json');

function stripTerminalControl(value) {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '');
}

async function clearRuntimeEvents() {
  const response = await fetch(new URL('/runtime-data', RELAY_URL), { method: 'DELETE' });
  if (!response.ok) throw new Error(`Could not clear runtime events: HTTP ${response.status}`);
}

function projectEvent(event) {
  const props = event.raw?.nodeProps || {};
  return {
    eventId: props.eventId || event.nodeId,
    predecessorEventIds: props.predecessorEventIds || [],
    stableId: event.functionStableId,
    role: props.role,
    outcome: props.outcome,
    completion: props.completion,
    sessionId: event.sessionId,
    tsMs: props.tsMs,
  };
}

function reconstructChain(events) {
  const terminal = events.find((event) => (
    event.stableId === TERMINAL_STEP_STABLE_ID && event.role === 'step'
  ));
  if (!terminal) return null;
  const byId = new Map(events.map((event) => [event.eventId, event]));
  const reversed = [];
  const seen = new Set();
  let current = terminal;
  while (current && !seen.has(current.eventId)) {
    reversed.push(current);
    seen.add(current.eventId);
    const predecessorId = current.predecessorEventIds[0];
    if (!predecessorId) break;
    current = byId.get(predecessorId);
    if (!current) return null;
  }
  const chain = reversed.reverse();
  return chain.some((event) => event.stableId === FIRST_PREDICATE_STABLE_ID) ? chain : null;
}

async function findRuntimeChain() {
  const client = createClient({ url: REDIS_URL });
  await client.connect();
  try {
    const eventIds = await client.zRange('runtime:events', 0, -1, { REV: true });
    const events = [];
    for (const eventId of eventIds) {
      const payload = await client.get(`runtime:event:${eventId}`);
      if (!payload) continue;
      const event = JSON.parse(payload);
      if (event.kind === 'node-visit') events.push(projectEvent(event));
    }
    return reconstructChain(events);
  } finally {
    await client.disconnect();
  }
}

await clearRuntimeEvents();

const child = pty.spawn(
  'cmd.exe',
  ['/d', '/s', '/c', 'chcp 65001>nul && node dev/runOriginalClaudeCodeWithNodeLogging.mjs'],
  {
    cwd: process.cwd(),
    cols: 120,
    rows: 40,
    useConpty: true,
    env: {
      ...process.env,
      CLAUDE_CODE_MODEL_STUB: '1',
      CLAUDE_CODE_MODEL_STUB_RESPONSE: STUB_RESPONSE,
      GRAPH_NODE_LOGGING: '1',
      RUNTIME_RELAY_URL: RELAY_URL,
      TERM: 'xterm-256color',
    },
  },
);

let output = '';
let promptSent = false;
let stubObserved = false;
let exitRequested = false;
let exitConfirmed = false;
let runtimeChain = null;
let runtimePollingStarted = false;

function stopChildProcessTree() {
  try {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    child.kill();
  }
}

const exitResult = await new Promise((resolve) => {
  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    resolve(result);
  };
  const timeout = setTimeout(() => {
    stopChildProcessTree();
    console.error(`Original application scenario timed out after ${TIMEOUT_MS} ms`);
    process.exit(1);
  }, TIMEOUT_MS);

  child.onData((data) => {
    output += data;
    const visibleOutput = stripTerminalControl(output);

    if (!promptSent && (visibleOutput.includes('❯') || visibleOutput.includes('вќЇ'))) {
      promptSent = true;
      child.write(`${PROMPT}\r`);
      if (!runtimePollingStarted) {
        runtimePollingStarted = true;
        const pollRuntimeChain = async () => {
          runtimeChain = await findRuntimeChain();
          if (!runtimeChain) {
            setTimeout(pollRuntimeChain, 250);
            return;
          }
          setTimeout(() => {
            stopChildProcessTree();
            finish({ exitCode: 0, signal: 0, terminatedAfterRuntimeChain: true });
          }, 1_000);
        };
        void pollRuntimeChain();
      }
    }

    if (!stubObserved && visibleOutput.includes(STUB_RESPONSE)) stubObserved = true;
    if (stubObserved && !exitRequested) {
      exitRequested = true;
      setTimeout(() => child.write('\x03'), 300);
    }
    if (exitRequested && !exitConfirmed && visibleOutput.includes('Press Ctrl-C again to exit')) {
      exitConfirmed = true;
      child.write('\x03');
    }
  });
  child.onExit((result) => finish(result));
});

if (!promptSent) throw new Error('Original application prompt was not ready before exit');
if (!runtimeChain) {
  throw new Error(`Redis does not contain a complete causal chain through ${TERMINAL_STEP_STABLE_ID}`);
}

const sessionId = runtimeChain[0].sessionId;
await clearRuntimePathFromDiagram(DIAGRAM_PATH);
const runtimeSelection = buildRuntimePathSelection(await readFile(DIAGRAM_PATH, 'utf8'), runtimeChain);
const involvedEdgeIds = runtimeSelection.involvedEdgeIds;
const chainArtifact = {
  prompt: PROMPT,
  response: STUB_RESPONSE,
  sessionId,
  chain: runtimeChain,
  involvedEdgeIds,
  runtimeSelection,
  diagramPath: DIAGRAM_PATH,
};
await mkdir(path.dirname(CHAIN_PATH), { recursive: true });
await writeFile(CHAIN_PATH, `${JSON.stringify(chainArtifact, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  ok: true,
  prompt: PROMPT,
  response: STUB_RESPONSE,
  stubObservedInPtyOutput: stubObserved,
  appExitCode: exitResult.exitCode,
  runtimeChain,
  involvedEdgeIds,
  chainPath: CHAIN_PATH,
  diagramPath: DIAGRAM_PATH,
}, null, 2));

process.exit(0);
