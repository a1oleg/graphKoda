import { createServer } from 'node:http';

import { createClient } from 'redis';

import {
  DEFAULT_RUNTIME_RELAY_URL,
  buildRuntimeStoreConfig,
} from '../../graph/packages/runtime-relay/src/config.js';
import {
  clearRuntimeRedis,
  fetchCollectionRuntimeAnalysisFromRedis,
  fetchFunctionRuntimeTraceFromRedis,
  fetchFunctionSetValuesFromRedis,
  getRuntimeRedisStats,
  isRedisRuntimeStoreConfig,
  writeRuntimeRowsToRedis,
} from '../../graph/packages/runtime-relay/src/runtimeRedis.js';
import {
  getRelayNodeid,
  normalizeRuntimeRelayPayloads,
} from '../../graph/packages/runtime-relay/src/index.js';

const runtimeStoreConfig = buildRuntimeStoreConfig();

function getRuntimeStore() {
  const runtimeStore = runtimeStoreConfig;
  if (!isRedisRuntimeStoreConfig(runtimeStore)) {
    throw new Error(`Redis relay requires RUNTIME_STORAGE_BACKEND=redis. Received ${runtimeStore.backend || 'unknown'}.`);
  }

  return runtimeStore;
}

const relayUrl = new URL(DEFAULT_RUNTIME_RELAY_URL);
const relayHost = process.env.RUNTIME_RELAY_HOST || relayUrl.hostname;
const relayPort = Number(process.env.RUNTIME_RELAY_PORT || relayUrl.port || 8787);
const relayPath = process.env.RUNTIME_RELAY_PATH || relayUrl.pathname;
const maxQueuedRows = Number(process.env.RUNTIME_RELAY_MAX_QUEUE || 10_000);
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS,DELETE',
  'Access-Control-Allow-Headers': 'Content-Type',
};

let totalRequests = 0;
let totalRows = 0;
let totalStoredRows = 0;
let totalFailedWrites = 0;
let lastRequestAt;
let lastStoredAt;
let lastWriteError;
let recentNodeids = [];
let queuedRows = 0;
let runtimeStoreSession;
let runtimeStoreSessionPromise;

async function getRuntimeStoreSession() {
  if (runtimeStoreSession?.redisClient?.isReady) {
    return runtimeStoreSession;
  }

  if (!runtimeStoreSessionPromise) {
    runtimeStoreSessionPromise = (async () => {
      if (runtimeStoreSession?.redisClient?.isOpen) {
        await runtimeStoreSession.redisClient.disconnect().catch(() => undefined);
      }

      const runtimeStore = getRuntimeStore();
      const redisClient = createClient({
        url: runtimeStore.url,
        socket: {
          connectTimeout: runtimeStore.connectTimeoutMs,
        },
      });
      redisClient.on('error', (error) => {
        lastWriteError = error instanceof Error ? error.message : String(error);
      });

      await redisClient.connect();
      runtimeStoreSession = {
        ...runtimeStore,
        redisClient,
      };
      return runtimeStoreSession;
    })().finally(() => {
      runtimeStoreSessionPromise = undefined;
    });
  }

  return runtimeStoreSessionPromise;
}

function sanitizeRows(rawRows) {
  return normalizeRuntimeRelayPayloads(rawRows).filter((row) => getRelayNodeid(row));
}

async function checkRedisConnectivity() {
  const runtimeStore = await getRuntimeStoreSession();
  await runtimeStore.redisClient.zCard(`${runtimeStore.namespace}:events`);
  return 'PONG';
}

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    checkRedisConnectivity()
      .then((result) => {
        const runtimeStore = getRuntimeStore();
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({
          ok: result === 'PONG',
          relayPath,
          runtimeStore,
          queuedRows,
          lastWriteError,
        }));
      })
      .catch((error) => {
        const runtimeStore = getRuntimeStore();
        res.writeHead(503, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({
          ok: false,
          relayPath,
          runtimeStore,
          queuedRows,
          error: error instanceof Error ? error.message : String(error),
        }));
      });
    return;
  }

  if (req.method === 'GET' && req.url === '/stats') {
    getRuntimeStoreSession()
      .then((runtimeStore) => getRuntimeRedisStats(runtimeStore))
      .then((stats) => {
        const runtimeStore = getRuntimeStore();
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({
          ok: true,
          relayPath,
          runtimeStore,
          totalRequests,
          totalRows,
          totalStoredRows,
          totalFailedWrites,
          queuedRows,
          lastRequestAt,
          lastStoredAt,
          lastWriteError,
          recentNodeids,
          stats,
        }));
      })
      .catch((error) => {
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      });
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/runtime-analysis')) {
    const url = new URL(req.url, `http://${relayHost}:${relayPort}`);
    getRuntimeStoreSession()
      .then((runtimeStore) => fetchCollectionRuntimeAnalysisFromRedis(runtimeStore, {
        stableId: url.searchParams.get('stableId') || '',
        sessionId: url.searchParams.get('sessionId') || undefined,
        invocationEventId: url.searchParams.get('invocationEventId') || undefined,
      }))
      .then((analysis) => {
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: true, analysis }));
      })
      .catch((error) => {
        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      });
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/runtime-trace')) {
    const url = new URL(req.url, `http://${relayHost}:${relayPort}`);
    getRuntimeStoreSession()
      .then((runtimeStore) => fetchFunctionRuntimeTraceFromRedis(runtimeStore, {
        stableId: url.searchParams.get('stableId') || '',
        sessionId: url.searchParams.get('sessionId') || undefined,
      }))
      .then((trace) => {
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: true, trace }));
      })
      .catch((error) => {
        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      });
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/runtime-values')) {
    const url = new URL(req.url, `http://${relayHost}:${relayPort}`);
    getRuntimeStoreSession()
      .then((runtimeStore) => fetchFunctionSetValuesFromRedis(runtimeStore, {
        stableId: url.searchParams.get('stableId') || '',
        sessionId: url.searchParams.get('sessionId') || undefined,
      }))
      .then((values) => {
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: true, values }));
      })
      .catch((error) => {
        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      });
    return;
  }

  if (req.method === 'DELETE' && req.url === '/runtime-data') {
    getRuntimeStoreSession()
      .then((runtimeStore) => clearRuntimeRedis(runtimeStore))
      .then((cleanup) => {
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: true, cleanup }));
      })
      .catch((error) => {
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      });
    return;
  }

  if (req.method !== 'POST' || req.url !== relayPath) {
    res.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
    return;
  }

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    const queuedBeforeRequest = queuedRows;

    try {
      const rawRows = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const rows = Array.isArray(rawRows) ? sanitizeRows(rawRows) : [];
      const skipped = Array.isArray(rawRows) ? rawRows.length - rows.length : 0;

      if (!rows.length) {
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: true, stored: 0, skipped, queuedRows }));
        return;
      }

      if (queuedRows + rows.length > maxQueuedRows) {
        res.writeHead(503, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({
          ok: false,
          error: 'Relay queue is full',
          queuedRows,
          maxQueuedRows,
        }));
        return;
      }

      totalRequests += 1;
      totalRows += rows.length;
      lastRequestAt = new Date().toISOString();
      queuedRows += rows.length;

      const runtimeStore = await getRuntimeStoreSession();
      const storedRecords = await writeRuntimeRowsToRedis(runtimeStore, rows);

      queuedRows = queuedBeforeRequest;
      totalStoredRows += storedRecords.length;
      lastStoredAt = new Date().toISOString();
      recentNodeids = [...recentNodeids, ...storedRecords.map((record) => record.nodeId)].slice(-20);

      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ ok: true, stored: storedRecords.length, skipped, queuedRows }));
    } catch (error) {
      queuedRows = queuedBeforeRequest;
      totalFailedWrites += 1;
      lastWriteError = error instanceof Error ? error.message : String(error);
      res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({
        ok: false,
        error: lastWriteError,
      }));
    }
  });
});

server.listen(relayPort, relayHost, () => {
  const runtimeStore = getRuntimeStore();
  console.log(JSON.stringify({
    relayUrl: `http://${relayHost}:${relayPort}${relayPath}`,
    runtimeStore,
  }, null, 2));
});

async function shutdown(exitCode = 0) {
  if (runtimeStoreSession?.redisClient?.isOpen) {
    await runtimeStoreSession.redisClient.disconnect().catch(() => undefined);
  }

  server.close(() => {
    process.exit(exitCode);
  });
}

process.on('SIGINT', () => {
  shutdown(0);
});

process.on('SIGTERM', () => {
  shutdown(0);
});
