import { buildRuntimeEnvelopeFromLegacyRow, buildRuntimeEnvelopes } from './graphEnvelope.js';

const processEnv = typeof process !== 'undefined' ? process.env : undefined;

type WorkerRuntimeRelayTransportOptions = {
  isEnabled: boolean;
  relayUrl: string;
  batchSize?: number;
  flushIntervalMs?: number;
  maxPendingRows?: number;
};

function resolvePositiveIntegerEnv(name: string, defaultValue: number) {
  const rawValue = processEnv?.[name];
  const parsed = Number(rawValue);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

export function createWorkerRuntimeRelayTransport({
  isEnabled,
  relayUrl,
  batchSize = 100,
  flushIntervalMs = 100,
  maxPendingRows = resolvePositiveIntegerEnv('GRAPH_RELAY_MAX_PENDING_ROWS', 1000),
}: WorkerRuntimeRelayTransportOptions) {
  const FETCH_TIMEOUT_MS = 3_000;
  const FAILURE_COOLDOWN_MS = 5_000;
  let relayQueue = Promise.resolve();
  let pendingRelayRows: ReturnType<typeof buildRuntimeEnvelopes> = [];
  let relayFlushTimer: ReturnType<typeof setTimeout> | undefined;
  let relayDisabledUntil = 0;

  function serializeRelayRows(rows: ReturnType<typeof buildRuntimeEnvelopes>) {
    return JSON.stringify(rows, (key, value) => (typeof value === 'bigint' ? value.toString() : value));
  }

  function createBoundaryEnvelope(
    rows: ReturnType<typeof buildRuntimeEnvelopes>,
    direction: 'send' | 'receive',
    responseStatus?: number,
  ) {
    const firstRow = rows[0];
    const nodeid = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const pairId = rows.map((row: ReturnType<typeof buildRuntimeEnvelopes>[number]) => row.nodeid).join(',');

    return buildRuntimeEnvelopeFromLegacyRow({
      nodeid,
      labels: ['RunTime', 'BoundaryEvent', 'RelayBoundaryEvent'],
      nodeProps: {
        fnName: direction === 'send' ? 'WorkerRelayBoundarySend' : 'WorkerRelayBoundaryReceive',
        kind: 'boundary-event',
        tsMs: Date.now(),
        sessionId: firstRow?.nodeProps?.sessionId || firstRow?.meta?.sessionId,
        gitRevision: firstRow?.nodeProps?.gitRevision || firstRow?.meta?.gitRevision,
        buildGitRevision: firstRow?.nodeProps?.gitRevision || firstRow?.meta?.gitRevision,
        boundaryKind: 'relay',
        boundaryDirection: direction,
        boundaryTransport: 'fetch',
        boundaryUrl: relayUrl,
        payloadCount: rows.length,
        boundaryPairId: pairId,
        responseStatus,
      },
      parentNodeid: '',
      edgeType: 'CROSSED_RUNTIME_BOUNDARY',
      requestProps: {},
      hasResponse: false,
      responseProps: {},
      updateOnly: false,
    });
  }

  function trimPendingRelayRows() {
    if (pendingRelayRows.length > maxPendingRows) {
      pendingRelayRows.splice(0, pendingRelayRows.length - maxPendingRows);
    }
  }

  async function postPayload(payload: string) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    const timeoutId = setTimeout(() => controller?.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(relayUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: payload,
        signal: controller?.signal,
      });

      if (!response.ok) {
        throw new Error(`Relay responded with HTTP ${response.status}`);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function flushRelayRows() {
    if (!pendingRelayRows.length) {
      return;
    }

    if (relayDisabledUntil > Date.now()) {
      scheduleRelayFlush(Math.max(flushIntervalMs, relayDisabledUntil - Date.now()));
      return;
    }

    const rows = pendingRelayRows.splice(0, batchSize);
    const payload = serializeRelayRows(rows);
    let didFlushSucceed = false;

    relayQueue = relayQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          await postPayload(payload);
          didFlushSucceed = true;
        } catch {
          relayDisabledUntil = Date.now() + FAILURE_COOLDOWN_MS;
        }
      });

    await relayQueue;

    if (!didFlushSucceed) {
      scheduleRelayFlush(FAILURE_COOLDOWN_MS);
      return;
    }

    if (pendingRelayRows.length) {
      void flushRelayRows();
    }
  }

  function scheduleRelayFlush(delayMs = flushIntervalMs) {
    if (relayFlushTimer) {
      return;
    }

    relayFlushTimer = setTimeout(() => {
      relayFlushTimer = undefined;
      void flushRelayRows();
    }, delayMs);
  }

  const transport = isEnabled && typeof fetch !== 'undefined'
    ? async (events: unknown[]) => {
      const envelopes = buildRuntimeEnvelopes(events as any[]);
      if (!envelopes.length) {
        return;
      }

      pendingRelayRows.push(...envelopes);
      trimPendingRelayRows();

      if (pendingRelayRows.length >= batchSize) {
        if (relayFlushTimer) {
          clearTimeout(relayFlushTimer);
          relayFlushTimer = undefined;
        }

        void flushRelayRows();
        return;
      }

      scheduleRelayFlush();
    }
    : undefined;

  return {
    transport,
  };
}
