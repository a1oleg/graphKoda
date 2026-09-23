#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClient } from 'redis';
import * as z from 'zod/v4';

const REDIS_URL = process.env.RUNTIME_REDIS_URL || 'redis://127.0.0.1:6379';
const NAMESPACE = process.env.RUNTIME_REDIS_NAMESPACE || 'runtime';

function key(suffix) {
  return `${NAMESPACE}:${suffix}`;
}

async function withRedis(callback) {
  const client = createClient({
    url: REDIS_URL,
    socket: { connectTimeout: 3_000 },
  });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.disconnect();
  }
}

async function readEvent(client, eventId) {
  const payload = await client.get(key(`event:${eventId}`));
  return payload ? JSON.parse(payload) : null;
}

function textResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}

const server = new McpServer({
  name: 'graphKoda-runtime-redis',
  version: '1.0.0',
});

server.registerTool('redis_ping', {
  description: 'Check the runtime Redis connection and namespace.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => withRedis(async (client) => textResult({
  ok: await client.ping() === 'PONG',
  url: REDIS_URL,
  namespace: NAMESPACE,
})));

server.registerTool('redis_runtime_events', {
  description: 'List recent runtime events, optionally filtered by static stableId, sessionId, or kind.',
  inputSchema: {
    stableId: z.string().optional(),
    sessionId: z.string().optional(),
    kind: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(20),
  },
  annotations: { readOnlyHint: true },
}, async ({ stableId, sessionId, kind, limit }) => withRedis(async (client) => {
  const eventIds = await client.zRange(key('events'), 0, 999, { REV: true });
  const events = [];

  for (const eventId of eventIds) {
    const event = await readEvent(client, eventId);
    if (!event) continue;
    if (stableId && event.functionStableId !== stableId) continue;
    if (sessionId && event.sessionId !== sessionId) continue;
    if (kind && event.kind !== kind) continue;

    events.push({
      eventId: event.eventId,
      nodeId: event.nodeId,
      visitEventId: event.raw?.nodeProps?.eventId || event.nodeId,
      predecessorEventIds: event.raw?.nodeProps?.predecessorEventIds || [],
      stableId: event.functionStableId,
      ownerFnStableId: event.ownerFnStableId,
      kind: event.kind,
      role: event.raw?.nodeProps?.role,
      outcome: event.raw?.nodeProps?.outcome,
      completion: event.raw?.nodeProps?.completion,
      edgeType: event.edgeType,
      sessionId: event.sessionId,
      ingestedAt: event.ingestedAt,
      labels: event.raw?.labels || [],
    });
    if (events.length >= limit) break;
  }

  return textResult({ count: events.length, events });
}));

server.registerTool('redis_runtime_event', {
  description: 'Read one complete runtime event by eventId.',
  inputSchema: {
    eventId: z.string().min(1),
  },
  annotations: { readOnlyHint: true },
}, async ({ eventId }) => withRedis(async (client) => {
  const event = await readEvent(client, eventId);
  if (!event) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Runtime event not found: ${eventId}` }],
    };
  }
  return textResult(event);
}));

await server.connect(new StdioServerTransport());
