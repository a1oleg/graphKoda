import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import pty from 'node-pty';
import { createClient } from 'redis';

import { buildRuntimePathSelection, clearRuntimePathFromDiagram } from './runtimePathDrawio.mjs';

const PROMPT = 'проверка';
const STUB_RESPONSE = 'заглушка';
const OWNER_STABLE_ID = 'screens/REPL.tsx:3142:31:3533:3';
const SESSION_ID = `on-submit-${Date.now()}`;
const RELAY_URL = process.env.RUNTIME_RELAY_URL || 'http://127.0.0.1:8787/graph-relay';
const REDIS_URL = process.env.RUNTIME_REDIS_URL || 'redis://127.0.0.1:6379';
const TIMEOUT_MS = Number(process.env.ON_SUBMIT_TRACE_TIMEOUT_MS || 60_000);
const DIAGRAM_PATH = path.resolve('graph/draw/generated/onSubmit-REPL.tsx-3142.drawio');
const TRACE_PATH = path.resolve('graph/runtime/onSubmit.trace.json');

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
    stageName: props.stageName,
    outcome: props.outcome,
    completion: props.completion,
    sessionId: event.sessionId,
    tsMs: props.tsMs,
  };
}

async function readSessionEvents() {
  const client = createClient({ url: REDIS_URL });
  await client.connect();
  try {
    const eventIds = await client.zRange(`runtime:session:${SESSION_ID}:events`, 0, -1);
    const events = [];
    for (const eventId of eventIds) {
      const payload = await client.get(`runtime:event:${eventId}`);
      if (!payload) continue;
      const event = JSON.parse(payload);
      if (event.kind === 'node-visit') events.push(projectEvent(event));
    }
    return events.sort((left, right) => left.tsMs - right.tsMs);
  } finally {
    await client.disconnect();
  }
}

function reconstructLongestChain(events) {
  const root = events.find((event) => event.stableId === OWNER_STABLE_ID && event.role === 'function');
  if (!root) return [];
  const children = new Map();
  for (const event of events) {
    const predecessor = event.predecessorEventIds[0];
    if (!predecessor) continue;
    const entries = children.get(predecessor) || [];
    entries.push(event);
    children.set(predecessor, entries);
  }
  const memo = new Map();
  function longestFrom(event) {
    if (memo.has(event.eventId)) return memo.get(event.eventId);
    const descendants = (children.get(event.eventId) || []).map(longestFrom);
    const result = [event, ...(descendants.sort((a, b) => b.length - a.length)[0] || [])];
    memo.set(event.eventId, result);
    return result;
  }
  return longestFrom(root);
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
      MODEL_STUB_REPLY: STUB_RESPONSE,
      GRAPH_NODE_LOGGING: '1',
      GRAPH_RUNTIME_SESSION_ID: SESSION_ID,
      RUNTIME_RELAY_URL: RELAY_URL,
      TERM: 'xterm-256color',
    },
  },
);

let output = '';
let promptSent = false;
let stubObserved = false;

function stopChildProcessTree() {
  try {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    child.kill();
  }
}

await new Promise((resolve, reject) => {
  let settled = false;
  let sendTimer;
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    clearTimeout(sendTimer);
    if (error) reject(error);
    else resolve();
  };
  const timeout = setTimeout(() => {
    stopChildProcessTree();
    finish(new Error(`onSubmit trace scenario timed out after ${TIMEOUT_MS} ms\n${stripTerminalControl(output).slice(-3000)}`));
  }, TIMEOUT_MS);

  child.onData((data) => {
    output += data;
    const visible = stripTerminalControl(output);
    if (!promptSent && !sendTimer && /[❯>]/u.test(visible)) {
      sendTimer = setTimeout(() => {
        promptSent = true;
        child.write(`${PROMPT}\r`);
      }, 100);
    }
    if (!stubObserved && visible.includes(STUB_RESPONSE)) {
      stubObserved = true;
      setTimeout(() => {
        stopChildProcessTree();
        finish();
      }, 1_000);
    }
  });
  child.onExit(() => {
    if (stubObserved) finish();
  });
});

if (!promptSent) throw new Error('Original application did not accept the prompt');
if (!stubObserved) throw new Error('The stub response was not observed');
const events = await readSessionEvents();
const chain = reconstructLongestChain(events);
if (chain.length < 3) throw new Error(`Redis contains no complete onSubmit chain for ${SESSION_ID}`);

await clearRuntimePathFromDiagram(DIAGRAM_PATH);
const runtimeSelection = buildRuntimePathSelection(await readFile(DIAGRAM_PATH, 'utf8'), chain);
const artifact = {
  prompt: PROMPT,
  response: STUB_RESPONSE,
  ownerStableId: OWNER_STABLE_ID,
  sessionId: SESSION_ID,
  eventCount: events.length,
  chain,
  involvedEdgeIds: runtimeSelection.involvedEdgeIds,
  runtimeSelection,
  diagramPath: DIAGRAM_PATH,
};
await mkdir(path.dirname(TRACE_PATH), { recursive: true });
await writeFile(TRACE_PATH, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  ok: true,
  sessionId: SESSION_ID,
  eventCount: events.length,
  chainLength: chain.length,
  highlightedEdgeCount: runtimeSelection.involvedEdgeIds.length,
  tracePath: TRACE_PATH,
  diagramPath: DIAGRAM_PATH,
}, null, 2));

process.exit(0);
