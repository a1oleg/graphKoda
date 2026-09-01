import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchFunctionRuntimeTraceFromRedis } from '../graph/packages/runtime-relay/src/runtimeRedis.js';

const ownerStableId = 'screens/REPL.tsx:3142:31:3533:3';
const sessionId = 'legacy-session';
const rootEventId = 'legacy-root';
const childEventId = 'legacy-child';
const records = new Map([
  [rootEventId, {
    eventId: rootEventId,
    nodeId: rootEventId,
    kind: 'node-visit',
    sessionId,
    ownerFnStableId: ownerStableId,
    functionStableId: ownerStableId,
    staticFilePath: 'screens/REPL.tsx',
    score: 1,
    raw: { nodeProps: { eventId: rootEventId, predecessorEventIds: [], role: 'function', tsMs: 1 } },
  }],
  [childEventId, {
    eventId: childEventId,
    nodeId: childEventId,
    kind: 'node-visit',
    sessionId,
    ownerFnStableId: ownerStableId,
    functionStableId: 'flow:call:screens/REPL.tsx:3235:33:3235:128:arg0:call0',
    staticFilePath: 'screens/REPL.tsx',
    score: 2,
    raw: { nodeProps: { eventId: childEventId, predecessorEventIds: [rootEventId], role: 'call', tsMs: 2 } },
  }],
]);

const redisClient = {
  async zRange(key) {
    if (key === `runtime:owner:${ownerStableId}:events`) return [rootEventId];
    if (key === `runtime:session:${sessionId}:owner:${ownerStableId}:events`) {
      return [rootEventId, childEventId];
    }
    return [];
  },
  async mGet(keys) {
    return keys.map((key) => JSON.stringify(records.get(key.replace('runtime:event:', ''))));
  },
};

test('function trace projects legacy runtime IDs onto coordinate-only graph IDs', async () => {
  const trace = await fetchFunctionRuntimeTraceFromRedis({ redisClient }, { stableId: ownerStableId });
  assert.equal(trace.sessionId, sessionId);
  assert.deepEqual(trace.chain.map((event) => event.stableId), [
    ownerStableId,
    'screens/REPL.tsx:3235:33:3235:128',
  ]);
});
