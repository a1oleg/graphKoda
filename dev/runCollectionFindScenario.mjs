import process from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import pty from 'node-pty';
import { createClient } from 'redis';

const COMMAND = '/help';
const OWNER_STABLE_ID = 'screens/REPL.tsx:3142:31:3533:3';
const FIND_STABLE_ID = 'screens/REPL.tsx:3173:30:3173:180';
const RESULT_STABLE_ID = 'screens/REPL.tsx:3173:12:3173:27';
const SHIFT_STABLE_ID = FIND_STABLE_ID;
const REDIS_URL = process.env.RUNTIME_REDIS_URL || 'redis://127.0.0.1:6379';
const RELAY_URL = process.env.RUNTIME_RELAY_URL || 'http://127.0.0.1:8787/graph-relay';
const ANALYSIS_URL = new URL('/runtime-analysis', RELAY_URL);
const TIMEOUT_MS = Number(process.env.COLLECTION_FIND_SCENARIO_TIMEOUT_MS || 60_000);
const SESSION_ID = `collection-find-${Date.now()}`;
const CHAIN_PATH = path.resolve('graph/runtime/onSubmit-3173-find.chain.json');

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
    methodName: props.methodName,
    iterationIndex: props.iterationIndex,
    itemPreview: props.itemPreview,
    matched: props.matched,
    sessionId: event.sessionId,
    tsMs: props.tsMs,
  };
}

function reconstructChain(events) {
  const terminal = events.find((event) => (
    event.sessionId === SESSION_ID
      && event.stableId === RESULT_STABLE_ID
      && event.role === 'collection-result'
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
  const collectionStartIndex = chain.findIndex((event) => (
    event.stableId === FIND_STABLE_ID && event.role === 'collection-method'
  ));
  return collectionStartIndex >= 0 ? chain.slice(collectionStartIndex) : null;
}

async function readRuntimeChain() {
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
    await client.close();
  }
}

function assertFindChain(chain) {
  if (chain[0]?.role !== 'collection-method') {
    throw new Error('Runtime chain does not start at commands.find');
  }
  const predicateEvents = chain.filter((event) => event.role === 'collection-predicate');
  if (!predicateEvents.length || predicateEvents.at(-1)?.matched !== true) {
    throw new Error('Runtime chain does not contain a successful find predicate');
  }
  if (!chain.some((event) => event.role === 'collection-pop')) {
    throw new Error('Runtime chain contains no collection item visits');
  }
  if (chain.at(-1)?.itemPreview !== 'help') {
    throw new Error(`Expected /help to resolve to the help command, received ${chain.at(-1)?.itemPreview}`);
  }
  for (let index = 1; index < chain.length; index += 1) {
    if (chain[index].predecessorEventIds[0] !== chain[index - 1].eventId) {
      throw new Error(`Broken predecessor chain at event ${index}`);
    }
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
      CLAUDE_CODE_MODEL_STUB_RESPONSE: 'model-call-was-not-expected',
      GRAPH_NODE_LOGGING: '1',
      GRAPH_RUNTIME_SESSION_ID: SESSION_ID,
      RUNTIME_RELAY_URL: RELAY_URL,
      TERM: 'xterm-256color',
    },
  },
);

let output = '';
let commandSent = false;
let runtimeChain = null;
let exitRequested = false;

function stopChildProcessTree() {
  try {
    child.kill();
  } catch {
    // The PTY may already have exited.
  }
}

function requestChildExit() {
  if (exitRequested) return;
  exitRequested = true;
  child.write('\x03');
  setTimeout(() => child.write('\x03'), 300);
  setTimeout(stopChildProcessTree, 2_000);
}

const exitResult = await new Promise((resolve) => {
  let settled = false;
  let sendTimer;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    clearTimeout(sendTimer);
    resolve(result);
  };
  const timeout = setTimeout(() => {
    stopChildProcessTree();
    console.error(stripTerminalControl(output).slice(-4_000));
    console.error(`Collection find scenario timed out after ${TIMEOUT_MS} ms`);
    process.exit(1);
  }, TIMEOUT_MS);

  child.onData((data) => {
    output += data;
    const visibleOutput = stripTerminalControl(output);
    if (
      !commandSent
        && !sendTimer
        && (
          visibleOutput.includes('❯')
            || visibleOutput.includes('вќЇ')
            || visibleOutput.includes('РІСњР‡')
        )
    ) {
      sendTimer = setTimeout(() => {
        commandSent = true;
        child.write(`${COMMAND}\r`);
        const poll = async () => {
          runtimeChain = await readRuntimeChain();
          if (!runtimeChain) {
            setTimeout(poll, 200);
            return;
          }
          requestChildExit();
        };
        void poll();
      }, 100);
    }
  });
  child.onExit((result) => finish(result));
});

if (!commandSent) throw new Error('Original application did not accept the slash command');
if (!runtimeChain) throw new Error('Redis does not contain the commands.find causal chain');
assertFindChain(runtimeChain);

ANALYSIS_URL.searchParams.set('stableId', FIND_STABLE_ID);
ANALYSIS_URL.searchParams.set('sessionId', SESSION_ID);
const analysisResponse = await fetch(ANALYSIS_URL);
if (!analysisResponse.ok) throw new Error(`Runtime analysis failed: HTTP ${analysisResponse.status}`);
const { analysis } = await analysisResponse.json();
const visitedItems = runtimeChain.filter((event) => event.role === 'collection-pop').length;
if (analysis.totalIterations !== visitedItems || analysis.matchedIterations !== 1 || analysis.segments.length < 2) {
  throw new Error(`Unexpected collection analysis: ${JSON.stringify(analysis)}`);
}
const rejectedSegment = analysis.segments.find((segment) => segment.outcome === 'rejected');
const matchedSegment = analysis.segments.find((segment) => segment.outcome === 'matched');
const rejectedBoundary = rejectedSegment?.edgePairs.at(-1);
const matchedBoundary = matchedSegment?.edgePairs.at(-1);
if (rejectedBoundary?.targetStableId !== SHIFT_STABLE_ID || rejectedBoundary?.edgeType !== 'REPEATS') {
  throw new Error(`Rejected collection path does not return to shift: ${JSON.stringify(rejectedBoundary)}`);
}
if (matchedBoundary?.targetStableId !== RESULT_STABLE_ID || matchedBoundary?.edgeType !== 'TRUE') {
  throw new Error(`Matched collection path does not return to result set: ${JSON.stringify(matchedBoundary)}`);
}

const artifact = {
  command: COMMAND,
  ownerStableId: OWNER_STABLE_ID,
  sessionId: SESSION_ID,
  chain: runtimeChain,
};
await mkdir(path.dirname(CHAIN_PATH), { recursive: true });
await writeFile(CHAIN_PATH, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  ok: true,
  command: COMMAND,
  appExitCode: exitResult.exitCode,
  sessionId: SESSION_ID,
  visitedItems,
  matchedItem: runtimeChain.at(-1)?.itemPreview,
  chainLength: runtimeChain.length,
  segmentCounts: analysis.segments.map((segment) => segment.count),
  chainPath: CHAIN_PATH,
}, null, 2));
