import { randomUUID } from 'node:crypto';

import { createClient } from 'redis';

import { buildCollectionRuntimeAnalysis } from './collectionRuntimeAnalysis.js';
import { normalizeStableId } from '../../runtime-core/src/stableId.js';

const DEFAULT_NAMESPACE = 'runtime';

function normalizeText(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  return String(value);
}

function canonicalStableId(value, sourceFilePath) {
  const normalized = normalizeText(value)?.replace(/\\/g, '/');
  if (!normalized) return null;
  try {
    return normalizeStableId(normalized, { sourceFilePath });
  } catch {
    return normalized;
  }
}

function stableIdsMatch(left, right) {
  if (!left || !right) return false;
  return canonicalStableId(left) === canonicalStableId(right);
}

function buildStableIdSelectorAliases(stableId) {
  const normalized = normalizeText(stableId)?.replace(/\\/g, '/');
  if (!normalized) {
    return [];
  }

  const aliases = new Set([normalized, canonicalStableId(normalized)]);
  const normalizedRoot = process.cwd().replace(/\\/g, '/').replace(/\/$/, '');

  if (!normalized.startsWith('external:') && normalizedRoot && normalized.startsWith(`${normalizedRoot}/`)) {
    aliases.add(normalized.slice(normalizedRoot.length + 1));
  }

  return [...aliases].filter(Boolean);
}

function toScore(value) {
  const numericValue = Number(value);
  if (Number.isFinite(numericValue) && numericValue > 0) {
    return numericValue;
  }

  return Date.now();
}

function getNamespace(config) {
  return config?.namespace || DEFAULT_NAMESPACE;
}

function getKey(config, suffix) {
  return `${getNamespace(config)}:${suffix}`;
}

function getEventKey(config, eventId) {
  return getKey(config, `event:${eventId}`);
}

function createEventId(nodeId, score) {
  return `${nodeId || 'runtime'}:${score}:${randomUUID()}`;
}

function buildIndexKeys(config, record) {
  return {
    allEvents: getKey(config, 'events'),
    sessionEvents: record.sessionId ? getKey(config, `session:${record.sessionId}:events`) : null,
    ownerEvents: record.ownerFnStableId ? getKey(config, `owner:${record.ownerFnStableId}:events`) : null,
    sessionOwnerEvents: record.sessionId && record.ownerFnStableId
      ? getKey(config, `session:${record.sessionId}:owner:${record.ownerFnStableId}:events`)
      : null,
    fnEvents: record.fnName ? getKey(config, `fn:${record.fnName}:events`) : null,
    sessionFnEvents: record.sessionId && record.fnName
      ? getKey(config, `session:${record.sessionId}:fn:${record.fnName}:events`)
      : null,
    correlationEvents: record.correlationId ? getKey(config, `correlation:${record.correlationId}:events`) : null,
    boundaryEvents: record.boundaryPairId ? getKey(config, `boundary:${record.boundaryPairId}:events`) : null,
    nodeEvents: record.nodeId ? getKey(config, `node:${record.nodeId}:events`) : null,
    parentEvents: record.parentNodeId ? getKey(config, `parent:${record.parentNodeId}:events`) : null,
    staticEvents: record.functionStableId ? getKey(config, `static:${record.functionStableId}:events`) : null,
    sessionOwners: record.sessionId ? getKey(config, `session:${record.sessionId}:owners`) : null,
  };
}

function flattenRuntimeEnvelope(row, { eventId, score }) {
  const flat = row?.flat || {};
  const nodeProps = row?.nodeProps || {};
  const requestProps = row?.requestProps || {};
  const responseProps = row?.responseProps || {};
  const staticFilePath = normalizeText(flat.staticFilePath || flat.filePath);

  return {
    eventId,
    nodeId: normalizeText(row?.nodeid || row?.meta?.nodeid),
    parentNodeId: normalizeText(row?.parentNodeid || row?.meta?.parentNodeid),
    ingestedAt: new Date(score).toISOString(),
    score,
    sessionId: normalizeText(flat.sessionId || row?.meta?.sessionId),
    updateOnly: Boolean(row?.updateOnly),
    edgeType: normalizeText(flat.edgeType || row?.edgeType || row?.meta?.edgeType),
    correlationId: normalizeText(flat.correlationId),
    kind: normalizeText(flat.kind || row?.meta?.kind),
    fnName: normalizeText(flat.fnName || row?.meta?.fnName),
    asyncPhase: normalizeText(flat.asyncPhase),
    asyncKind: normalizeText(flat.asyncKind),
    resourceKind: normalizeText(flat.resourceKind),
    boundaryKind: normalizeText(flat.boundaryKind),
    boundaryDirection: normalizeText(flat.boundaryDirection),
    boundaryTransport: normalizeText(flat.boundaryTransport),
    boundaryPairId: normalizeText(flat.boundaryPairId),
    boundaryMessageType: normalizeText(nodeProps.boundaryMessageType),
    boundaryChannel: normalizeText(nodeProps.boundaryChannel),
    completionKind: normalizeText(flat.completionKind),
    affectType: normalizeText(nodeProps.affectType),
    topLevelKey: normalizeText(requestProps.topLevelKey),
    functionStableId: canonicalStableId(flat.stableId, staticFilePath),
    ownerFnStableId: canonicalStableId(flat.ownerFnStableId, staticFilePath),
    staticFilePath,
    staticFnStartLine: flat.staticFnStartLine ?? flat.fnStartLine ?? null,
    decisionId: normalizeText(flat.decisionId),
    predicateId: normalizeText(flat.predicateId),
    branchId: normalizeText(flat.branchId),
    storeKey: normalizeText(flat.storeKey),
    statefulStepId: normalizeText(requestProps.stepStableId),
    resourceId: normalizeText(flat.resourceId),
    resourceSemanticId: normalizeText(flat.resourceSemanticId),
    resourceSemanticDetailId: normalizeText(flat.resourceSemanticDetailId),
    requestProps,
    responseProps,
    raw: row,
  };
}

async function withRedisClient(config, callback) {
  if (config?.redisClient) {
    return callback(config.redisClient);
  }

  const client = createClient({
    url: config.url,
    socket: {
      connectTimeout: config.connectTimeoutMs || 3000,
    },
  });

  await client.connect();

  try {
    return await callback(client);
  } finally {
    await client.disconnect();
  }
}

export async function withRuntimeRedisSession(config, callback) {
  const client = createClient({
    url: config.url,
    socket: {
      connectTimeout: config.connectTimeoutMs || 3000,
    },
  });

  await client.connect();

  try {
    return await callback({
      ...config,
      redisClient: client,
    });
  } finally {
    await client.disconnect();
  }
}

async function readRecordsByEventIds(client, config, eventIds) {
  if (!eventIds.length) {
    return [];
  }

  const payloads = await client.mGet(eventIds.map((eventId) => getEventKey(config, eventId)));

  return payloads
    .map((payload) => {
      if (!payload) {
        return null;
      }

      try {
        return JSON.parse(payload);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function readIndexRecords(client, config, key, { limit = 20, newestFirst = true } = {}) {
  if (!key) {
    return [];
  }

  const safeLimit = Math.max(1, Math.min(limit, 5000));
  const eventIds = await client.zRange(key, 0, safeLimit - 1, { REV: newestFirst });
  return readRecordsByEventIds(client, config, eventIds);
}

async function collectConnectedRowsFromAnchor(client, config, anchorNodeId, limit) {
  const rowsByEventId = new Map();
  const pendingNodeIds = anchorNodeId ? [anchorNodeId] : [];
  const pendingCorrelationIds = [];
  const pendingBoundaryPairIds = [];
  const visitedNodeIds = new Set();
  const visitedCorrelationIds = new Set();
  const visitedBoundaryPairIds = new Set();

  function queueNodeId(nodeId) {
    if (!nodeId || visitedNodeIds.has(nodeId) || pendingNodeIds.includes(nodeId)) {
      return;
    }

    pendingNodeIds.push(nodeId);
  }

  function queueCorrelationId(correlationId) {
    if (!correlationId || visitedCorrelationIds.has(correlationId) || pendingCorrelationIds.includes(correlationId)) {
      return;
    }

    pendingCorrelationIds.push(correlationId);
  }

  function queueBoundaryPairId(boundaryPairId) {
    if (!boundaryPairId || visitedBoundaryPairIds.has(boundaryPairId) || pendingBoundaryPairIds.includes(boundaryPairId)) {
      return;
    }

    pendingBoundaryPairIds.push(boundaryPairId);
  }

  function ingestRows(rows) {
    for (const row of rows) {
      if (!row?.eventId || rowsByEventId.has(row.eventId)) {
        continue;
      }

      rowsByEventId.set(row.eventId, row);

      queueNodeId(row.nodeId);
      queueNodeId(row.parentNodeId);
      queueCorrelationId(row.correlationId);
      queueBoundaryPairId(row.boundaryPairId);

      if (rowsByEventId.size >= limit) {
        return true;
      }
    }

    return false;
  }

  while ((pendingNodeIds.length || pendingCorrelationIds.length || pendingBoundaryPairIds.length) && rowsByEventId.size < limit) {
    if (pendingNodeIds.length) {
      const currentNodeId = pendingNodeIds.shift();
      if (!currentNodeId || visitedNodeIds.has(currentNodeId)) {
        continue;
      }

      visitedNodeIds.add(currentNodeId);
      const [nodeRows, childRows] = await Promise.all([
        readIndexRecords(client, config, getKey(config, `node:${currentNodeId}:events`), {
          limit,
          newestFirst: false,
        }),
        readIndexRecords(client, config, getKey(config, `parent:${currentNodeId}:events`), {
          limit,
          newestFirst: false,
        }),
      ]);

      if (ingestRows([...nodeRows, ...childRows])) {
        break;
      }

      continue;
    }

    if (pendingCorrelationIds.length) {
      const currentCorrelationId = pendingCorrelationIds.shift();
      if (!currentCorrelationId || visitedCorrelationIds.has(currentCorrelationId)) {
        continue;
      }

      visitedCorrelationIds.add(currentCorrelationId);
      const correlationRows = await readIndexRecords(client, config, getKey(config, `correlation:${currentCorrelationId}:events`), {
        limit,
        newestFirst: false,
      });

      if (ingestRows(correlationRows)) {
        break;
      }

      continue;
    }

    const currentBoundaryPairId = pendingBoundaryPairIds.shift();
    if (!currentBoundaryPairId || visitedBoundaryPairIds.has(currentBoundaryPairId)) {
      continue;
    }

    visitedBoundaryPairIds.add(currentBoundaryPairId);
    const boundaryRows = await readIndexRecords(client, config, getKey(config, `boundary:${currentBoundaryPairId}:events`), {
      limit,
      newestFirst: false,
    });

    if (ingestRows(boundaryRows)) {
      break;
    }
  }

  return {
    rows: [...rowsByEventId.values()],
    truncated: rowsByEventId.size >= limit,
  };
}

export function isRedisRuntimeStoreConfig(config) {
  return Boolean(config && typeof config === 'object' && (config.backend || 'redis') === 'redis');
}

export async function pingRuntimeRedis(config) {
  if (!config || typeof config !== 'object' || !config.url) {
    return {
      service: 'REDIS',
      healthy: false,
      reachable: false,
      running: false,
      managed: false,
      pid: null,
      error: 'Runtime Redis config is missing or incomplete.',
      details: {
        url: config?.url || null,
        namespace: config?.namespace || null,
      },
    };
  }

  try {
    const result = await withRedisClient(config, (client) => client.ping());
    return {
      service: 'REDIS',
      healthy: result === 'PONG',
      reachable: result === 'PONG',
      running: result === 'PONG',
      managed: false,
      pid: null,
      error: null,
      details: {
        url: config.url,
        namespace: getNamespace(config),
      },
    };
  } catch (error) {
    return {
      service: 'REDIS',
      healthy: false,
      reachable: false,
      running: false,
      managed: false,
      pid: null,
      error: error instanceof Error ? error.message : String(error),
      details: {
        url: config.url,
        namespace: getNamespace(config),
      },
    };
  }
}

export async function writeRuntimeRowsToRedis(config, rows) {
  if (!rows.length) {
    return [];
  }

  return withRedisClient(config, async (client) => {
    const storedRecords = [];

    for (const row of rows) {
      const nodeId = normalizeText(row?.nodeid || row?.meta?.nodeid);
      if (!nodeId) {
        continue;
      }

      const score = toScore(row?.flat?.tsMs || row?.meta?.tsMs);
      const eventId = createEventId(nodeId, score);
      const record = flattenRuntimeEnvelope(row, { eventId, score });
      const keys = buildIndexKeys(config, record);
      const multi = client.multi();

      multi.set(getEventKey(config, eventId), JSON.stringify(record));
      multi.zAdd(keys.allEvents, { score, value: eventId });

      if (keys.sessionEvents) {
        multi.zAdd(keys.sessionEvents, { score, value: eventId });
      }

      if (keys.ownerEvents) {
        multi.zAdd(keys.ownerEvents, { score, value: eventId });
      }

      if (keys.sessionOwnerEvents) {
        multi.zAdd(keys.sessionOwnerEvents, { score, value: eventId });
      }

      if (keys.fnEvents) {
        multi.zAdd(keys.fnEvents, { score, value: eventId });
      }

      if (keys.sessionFnEvents) {
        multi.zAdd(keys.sessionFnEvents, { score, value: eventId });
      }

      if (keys.correlationEvents) {
        multi.zAdd(keys.correlationEvents, { score, value: eventId });
      }

      if (keys.boundaryEvents) {
        multi.zAdd(keys.boundaryEvents, { score, value: eventId });
      }

      if (keys.nodeEvents) {
        multi.zAdd(keys.nodeEvents, { score, value: eventId });
      }

      if (keys.parentEvents) {
        multi.zAdd(keys.parentEvents, { score, value: eventId });
      }

      if (keys.staticEvents) {
        multi.zAdd(keys.staticEvents, { score, value: eventId });
      }

      if (keys.sessionOwners && record.ownerFnStableId) {
        multi.sAdd(keys.sessionOwners, record.ownerFnStableId);
      }

      await multi.exec();
      storedRecords.push(record);
    }

    return storedRecords;
  });
}

export async function fetchRuntimeEventRecordsFromRedis(config, {
  limit = 20,
  fnName,
  sessionId,
  ownerFnStableId,
} = {}) {
  return withRedisClient(config, async (client) => {
    const ownerStableIdAliases = buildStableIdSelectorAliases(ownerFnStableId);
    const keys = ownerStableIdAliases.length
      ? ownerStableIdAliases.map((stableId) => (
        sessionId
          ? getKey(config, `session:${sessionId}:owner:${stableId}:events`)
          : getKey(config, `owner:${stableId}:events`)
      ))
      : [
        sessionId && fnName
          ? getKey(config, `session:${sessionId}:fn:${fnName}:events`)
          : fnName
            ? getKey(config, `fn:${fnName}:events`)
            : sessionId
              ? getKey(config, `session:${sessionId}:events`)
              : getKey(config, 'events'),
      ];

    const recordMap = new Map();
    for (const key of keys) {
      const keyRecords = await readIndexRecords(client, config, key, { limit, newestFirst: true });
      keyRecords.forEach((record) => {
        if (record?.eventId) {
          recordMap.set(record.eventId, record);
        }
      });
    }

    // Records written before coordinate-only stableIds were indexed under
    // role-suffixed keys. Fall back to the enclosing session/global index and
    // compare their canonical coordinate identity.
    if (!recordMap.size && ownerStableIdAliases.length) {
      const fallbackKey = sessionId
        ? getKey(config, `session:${sessionId}:events`)
        : getKey(config, 'events');
      const fallbackRecords = await readIndexRecords(client, config, fallbackKey, {
        limit: Math.max(limit, 5000),
        newestFirst: true,
      });
      fallbackRecords.forEach((record) => {
        if (
          record?.eventId
          && ownerStableIdAliases.some((stableId) => stableIdsMatch(record.ownerFnStableId, stableId))
        ) {
          recordMap.set(record.eventId, record);
        }
      });
    }

    const records = [...recordMap.values()]
      .sort((left, right) => Number(right?.score || 0) - Number(left?.score || 0))
      .slice(0, limit);

    return records.filter((record) => (
      (!fnName || record.fnName === fnName)
      && (!sessionId || record.sessionId === sessionId)
      && (!ownerStableIdAliases.length || ownerStableIdAliases.some((stableId) => (
        stableIdsMatch(record.ownerFnStableId, stableId)
      )))
    ));
  });
}

export async function findLatestSessionIdForFunctionsInRedis(config, stableIds) {
  const selectors = [...new Set((stableIds || []).flatMap((stableId) => buildStableIdSelectorAliases(stableId)))];
  if (!selectors.length) {
    return null;
  }

  return withRedisClient(config, async (client) => {
    let bestMatch;

    for (const stableId of selectors) {
      const records = await readIndexRecords(client, config, getKey(config, `owner:${stableId}:events`), {
        limit: 1,
        newestFirst: true,
      });
      const record = records[0];
      if (!record?.sessionId) {
        continue;
      }

      if (!bestMatch || Number(record.score || 0) > Number(bestMatch.score || 0)) {
        bestMatch = record;
      }
    }

    if (!bestMatch) {
      const records = await readIndexRecords(client, config, getKey(config, 'events'), {
        limit: 5000,
        newestFirst: true,
      });
      bestMatch = records.find((record) => (
        record?.sessionId
        && selectors.some((stableId) => stableIdsMatch(record.ownerFnStableId, stableId))
      ));
    }

    return bestMatch?.sessionId || null;
  });
}

export async function loadFeatureRuntimeCoverageFromRedis(config, stableIds, {
  sessionId,
  useLatestSessionIfMissing = true,
} = {}) {
  try {
    const selectors = [...new Set((stableIds || []).flatMap((stableId) => buildStableIdSelectorAliases(stableId)))];
    if (!selectors.length) {
      return {
        available: true,
        error: null,
        requestedSessionId: sessionId || null,
        sessionId: null,
        usedLatestSessionFallback: false,
        latestSessionFallbackEnabled: useLatestSessionIfMissing,
        coveredStableIds: [],
        coveredNodeCount: 0,
      };
    }

    const resolvedSessionId = sessionId || (useLatestSessionIfMissing
      ? await findLatestSessionIdForFunctionsInRedis(config, selectors)
      : null);

    if (!resolvedSessionId) {
      return {
        available: true,
        error: null,
        requestedSessionId: sessionId || null,
        sessionId: null,
        usedLatestSessionFallback: false,
        latestSessionFallbackEnabled: useLatestSessionIfMissing,
        coveredStableIds: [],
        coveredNodeCount: 0,
      };
    }

    return withRedisClient(config, async (client) => {
      const coveredStableIds = [];
      const storedOwners = await client.sMembers(getKey(config, `session:${resolvedSessionId}:owners`));

      for (const stableId of selectors) {
        const isCovered = storedOwners.some((ownerStableId) => stableIdsMatch(ownerStableId, stableId));
        if (isCovered) {
          coveredStableIds.push(stableId);
        }
      }

      return {
        available: true,
        error: null,
        requestedSessionId: sessionId || null,
        sessionId: resolvedSessionId,
        usedLatestSessionFallback: Boolean(!sessionId && resolvedSessionId),
        latestSessionFallbackEnabled: useLatestSessionIfMissing,
        coveredStableIds,
        coveredNodeCount: coveredStableIds.length,
      };
    });
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
      requestedSessionId: sessionId || null,
      sessionId: sessionId || null,
      usedLatestSessionFallback: false,
      latestSessionFallbackEnabled: useLatestSessionIfMissing,
      coveredStableIds: [],
      coveredNodeCount: 0,
    };
  }
}

export async function fetchRuntimeChainRowsFromRedis(config, {
  nodeId,
  sessionId,
  correlationId,
  boundaryPairId,
  limit = 1000,
} = {}) {
  const safeLimit = Math.max(1, Math.min(limit, 5000));

  return withRedisClient(config, async (client) => {
    let scope = {
      sessionId: sessionId || null,
      correlationId: correlationId || null,
      boundaryPairId: boundaryPairId || null,
      anchorNodeId: nodeId || null,
    };
    let rows = [];

    if (scope.sessionId) {
      rows = await readIndexRecords(client, config, getKey(config, `session:${scope.sessionId}:events`), {
        limit: safeLimit,
        newestFirst: false,
      });
    } else if (scope.boundaryPairId) {
      rows = await readIndexRecords(client, config, getKey(config, `boundary:${scope.boundaryPairId}:events`), {
        limit: safeLimit,
        newestFirst: false,
      });
    } else if (scope.correlationId) {
      rows = await readIndexRecords(client, config, getKey(config, `correlation:${scope.correlationId}:events`), {
        limit: safeLimit,
        newestFirst: false,
      });
    } else if (scope.anchorNodeId) {
      const connected = await collectConnectedRowsFromAnchor(client, config, scope.anchorNodeId, safeLimit);
      rows = connected.rows;

      const anchorRecord = rows.find((row) => row.nodeId === scope.anchorNodeId) || rows[0];
      if (anchorRecord?.sessionId) {
        scope = {
          sessionId: anchorRecord.sessionId,
          correlationId: anchorRecord.correlationId || null,
          boundaryPairId: anchorRecord.boundaryPairId || null,
          anchorNodeId: scope.anchorNodeId,
        };
        rows = await readIndexRecords(client, config, getKey(config, `session:${scope.sessionId}:events`), {
          limit: safeLimit,
          newestFirst: false,
        });

        return {
          scope,
          rows: [...new Map(rows.map((row) => [row.eventId, row])).values()],
          truncated: rows.length >= safeLimit,
        };
      }

      return {
        scope,
        rows: [...new Map(rows.map((row) => [row.eventId, row])).values()],
        truncated: connected.truncated,
      };
    }

    return {
      scope,
      rows: [...new Map(rows.map((row) => [row.eventId, row])).values()],
      truncated: rows.length >= safeLimit,
    };
  });
}

export async function findRuntimeCausalLinkCandidatesFromRedis(config, { sessionId, limit = 20 } = {}) {
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const records = await fetchRuntimeEventRecordsFromRedis(config, {
    limit: Math.max(200, safeLimit * 10),
    sessionId,
  });
  const groups = new Map();

  for (const record of records) {
    if (record.boundaryPairId) {
      const key = `BOUNDARY:${record.sessionId || ''}:${record.boundaryPairId}`;
      const entry = groups.get(key) || {
        basis: 'BOUNDARY',
        sessionId: record.sessionId || null,
        correlationId: record.correlationId || null,
        boundaryPairId: record.boundaryPairId,
        rowCount: 0,
        nodeIds: new Set(),
        resourceKind: record.resourceKind || null,
        boundaryKind: record.boundaryKind || null,
      };
      entry.rowCount += 1;
      entry.nodeIds.add(record.nodeId);
      groups.set(key, entry);
    }

    if (record.correlationId) {
      const key = `CORRELATION:${record.sessionId || ''}:${record.correlationId}`;
      const entry = groups.get(key) || {
        basis: 'CORRELATION',
        sessionId: record.sessionId || null,
        correlationId: record.correlationId,
        boundaryPairId: null,
        rowCount: 0,
        nodeIds: new Set(),
        resourceKind: record.resourceKind || null,
        boundaryKind: record.boundaryKind || null,
      };
      entry.rowCount += 1;
      entry.nodeIds.add(record.nodeId);
      groups.set(key, entry);
    }
  }

  return [...groups.values()]
    .filter((entry) => entry.nodeIds.size > 1)
    .map((entry) => ({
      basis: entry.basis,
      sessionId: entry.sessionId,
      correlationId: entry.correlationId,
      boundaryPairId: entry.boundaryPairId,
      rowCount: entry.rowCount,
      nodeCount: entry.nodeIds.size,
      resourceKind: entry.resourceKind,
      boundaryKind: entry.boundaryKind,
      message: entry.basis === 'BOUNDARY'
        ? 'Multiple runtime nodes share one boundaryPairId in Redis; this is a strong candidate for a boundary causal link.'
        : 'Multiple runtime nodes share one correlationId in Redis; this is a candidate async or request-response causal stitch.',
    }))
    .sort((left, right) => {
      if (right.nodeCount !== left.nodeCount) {
        return right.nodeCount - left.nodeCount;
      }

      if (right.rowCount !== left.rowCount) {
        return right.rowCount - left.rowCount;
      }

      return String(right.sessionId || '').localeCompare(String(left.sessionId || ''));
    })
    .slice(0, safeLimit);
}

export async function findLatestRuntimeFunctionCandidateFromRedis(config) {
  const records = await fetchRuntimeEventRecordsFromRedis(config, { limit: 200 });
  return records.find((record) => record.kind === 'call' && record.ownerFnStableId) || null;
}

export async function getRuntimeRedisStats(config) {
  return withRedisClient(config, async (client) => {
    const [eventCount, latestEventIds] = await Promise.all([
      client.zCard(getKey(config, 'events')),
      client.zRange(getKey(config, 'events'), 0, 0, { REV: true }),
    ]);
    const latestRecord = latestEventIds.length
      ? (await readRecordsByEventIds(client, config, latestEventIds))[0]
      : null;

    return {
      eventCount: Number(eventCount || 0),
      lastIngestedAt: latestRecord?.ingestedAt || null,
      namespace: getNamespace(config),
      latestSessionId: latestRecord?.sessionId || null,
    };
  });
}

export async function clearRuntimeRedis(config) {
  return withRedisClient(config, async (client) => {
    let cursor = '0';
    let removedKeys = 0;

    do {
      const result = await client.scan(cursor, {
        MATCH: `${getNamespace(config)}:*`,
        COUNT: 500,
      });
      cursor = result.cursor;

      if ((result.keys || []).length) {
        removedKeys += await client.del(result.keys);
      }
    } while (cursor !== '0');

    return {
      removedKeys,
      namespace: getNamespace(config),
    };
  });
}

export async function fetchCollectionRuntimeAnalysisFromRedis(config, {
  stableId,
  sessionId,
  invocationEventId,
  limit = 5000,
} = {}) {
  if (!stableId) throw new Error('stableId is required');
  stableId = canonicalStableId(stableId);
  return withRedisClient(config, async (client) => {
    let resolvedSessionId = sessionId || null;
    if (!resolvedSessionId) {
      const latest = await readIndexRecords(client, config, getKey(config, `static:${stableId}:events`), {
        limit: 50,
        newestFirst: true,
      });
      resolvedSessionId = latest.find((record) => runtimePropsRole(record) === 'collection-method')?.sessionId || null;
    }
    if (!resolvedSessionId) {
      return buildCollectionRuntimeAnalysis([], { stableId, sessionId, invocationEventId });
    }
    const records = await readIndexRecords(client, config, getKey(config, `session:${resolvedSessionId}:events`), {
      limit,
      newestFirst: false,
    });
    return buildCollectionRuntimeAnalysis(records, {
      stableId,
      sessionId: resolvedSessionId,
      invocationEventId,
    });
  });
}

function projectNodeVisit(record) {
  if (record?.kind !== 'node-visit' || !record.functionStableId) return null;
  const props = record.raw?.nodeProps || {};
  return {
    eventId: normalizeText(props.eventId || record.nodeId),
    predecessorEventIds: Array.isArray(props.predecessorEventIds)
      ? props.predecessorEventIds.map(String).filter(Boolean)
      : [],
    stableId: canonicalStableId(record.functionStableId, record.staticFilePath),
    role: normalizeText(props.role),
    stageName: normalizeText(props.stageName),
    outcome: typeof props.outcome === 'boolean' ? props.outcome : null,
    completion: normalizeText(props.completion),
    sessionId: record.sessionId,
    tsMs: Number(props.tsMs || record.score || 0),
    eventSequence: Number(props.eventSequence || 0),
  };
}

function longestRuntimeChain(events, ownerStableId) {
  const roots = events
    .filter((event) => stableIdsMatch(event.stableId, ownerStableId) && event.role === 'function')
    .sort((left, right) => right.tsMs - left.tsMs || right.eventSequence - left.eventSequence);
  const root = roots[0];
  if (!root) return [];

  const children = new Map();
  for (const event of events) {
    for (const predecessor of event.predecessorEventIds) {
      const entries = children.get(predecessor) || [];
      entries.push(event);
      children.set(predecessor, entries);
    }
  }

  const memo = new Map();
  function longestFrom(event) {
    if (memo.has(event.eventId)) return memo.get(event.eventId);
    const descendants = (children.get(event.eventId) || [])
      .map(longestFrom)
      .sort((left, right) => right.length - left.length);
    const chain = [event, ...(descendants[0] || [])];
    memo.set(event.eventId, chain);
    return chain;
  }
  return longestFrom(root);
}

export async function fetchFunctionRuntimeTraceFromRedis(config, {
  stableId,
  sessionId,
  limit = 5000,
} = {}) {
  if (!stableId) throw new Error('stableId is required');
  const canonicalOwnerStableId = canonicalStableId(stableId);
  const resolvedSessionId = sessionId || await findLatestSessionIdForFunctionsInRedis(config, [canonicalOwnerStableId]);
  if (!resolvedSessionId) {
    return { stableId: canonicalOwnerStableId, sessionId: null, chain: [] };
  }

  const records = await fetchRuntimeEventRecordsFromRedis(config, {
    ownerFnStableId: canonicalOwnerStableId,
    sessionId: resolvedSessionId,
    limit,
  });
  const events = records.map(projectNodeVisit).filter(Boolean);
  return {
    stableId: canonicalOwnerStableId,
    sessionId: resolvedSessionId,
    chain: longestRuntimeChain(events, canonicalOwnerStableId),
  };
}

export function buildFunctionSetValues(records, { stableId, sessionId } = {}) {
  const latestBySetStableId = new Map();
  for (const record of records || []) {
    const props = record?.raw?.nodeProps || {};
    if (
      record?.kind !== 'node-visit'
      || !['set-value', 'parameter-value'].includes(props.role)
      || !record.functionStableId
    ) continue;
    const previous = latestBySetStableId.get(record.functionStableId);
    const tsMs = Number(props.tsMs || record.score || 0);
    const eventSequence = Number(props.eventSequence || 0);
    if (previous && (previous.tsMs > tsMs || (previous.tsMs === tsMs && previous.eventSequence > eventSequence))) continue;
    latestBySetStableId.set(record.functionStableId, {
      stableId: record.functionStableId,
      ownerStepStableId: normalizeText(props.ownerStepStableId),
      variableName: normalizeText(props.variableName || props.stageName) || 'value',
      valuePreview: props.valuePreview === undefined ? 'undefined' : String(props.valuePreview),
      resultType: normalizeText(props.resultType),
      valueRole: props.role,
      eventSequence,
      tsMs,
    });
  }
  return {
    stableId: stableId || null,
    sessionId: sessionId || null,
    values: [...latestBySetStableId.values()].sort((left, right) => (
      left.tsMs - right.tsMs || left.stableId.localeCompare(right.stableId)
    )),
  };
}

export async function fetchFunctionSetValuesFromRedis(config, {
  stableId,
  sessionId,
  limit = 5000,
} = {}) {
  if (!stableId) throw new Error('stableId is required');
  const resolvedSessionId = sessionId || await findLatestSessionIdForFunctionsInRedis(config, [stableId]);
  if (!resolvedSessionId) return buildFunctionSetValues([], { stableId, sessionId: null });
  const records = await fetchRuntimeEventRecordsFromRedis(config, {
    ownerFnStableId: stableId,
    sessionId: resolvedSessionId,
    limit,
  });
  return buildFunctionSetValues(records, { stableId, sessionId: resolvedSessionId });
}

function runtimePropsRole(record) {
  return record?.raw?.nodeProps?.role || null;
}
