import {
  findLatestSessionIdForFunctions,
} from './gatewayForALL.js';
import {
  fetchRuntimeEventRecords,
} from '../../../runtime-relay/src/runtimeEvents.js';

function clampRuntimeNodeLogLimit(limit) {
  return Math.max(1, Math.min(Number(limit) || 50, 500));
}

const OWNER_SCOPED_RECENT_WINDOW_MS = 30_000;

function clampRuntimeRecordFetchLimit(limit, functionCount) {
  return Math.max(1, Math.min((Number(limit) || 50) * Math.max(Number(functionCount) || 1, 1), 10_000));
}

function normalizeRuntimeCoordinatePath(filePath) {
  return String(filePath || '').trim().replace(/\\/g, '/').replace(/^\.\//, '') || null;
}

function buildRuntimeFunctionCoordinateKey(node) {
  const staticFilePath = normalizeRuntimeCoordinatePath(node?.staticFilePath);
  const staticFnStartLine = Number(node?.staticFnStartLine);

  if (!staticFilePath || !Number.isInteger(staticFnStartLine) || staticFnStartLine <= 0) {
    return null;
  }

  return `coord:${staticFilePath}:${staticFnStartLine}`;
}

function parseStableIdLocation(stableId) {
  const match = String(stableId || '').match(/^(.*):(\d+):(\d+):(\d+):(\d+)$/);
  if (!match) {
    return null;
  }

  return {
    repoRelativePath: normalizeRuntimeCoordinatePath(match[1]),
    startLine: Number(match[2]),
  };
}

function buildFeatureNodeStableIdAliases(node) {
  const aliases = new Set();
  const stableId = String(node?.stableId || '').trim();
  if (stableId) {
    aliases.add(stableId);
  }

  const parsedLocation = parseStableIdLocation(stableId);
  if (parsedLocation?.repoRelativePath && parsedLocation?.startLine) {
    aliases.add(`coord:${parsedLocation.repoRelativePath}:${parsedLocation.startLine}`);
  }

  return [...aliases];
}

function resolveRuntimeRecordStableId(record) {
  return record?.functionStableId || buildRuntimeFunctionCoordinateKey(record);
}

function buildRuntimeNodeLogs(functionNodes, records, { limit, sessionId }) {
  const nodeStableIdByAlias = new Map();
  functionNodes.forEach((node) => {
    buildFeatureNodeStableIdAliases(node).forEach((alias) => {
      if (!nodeStableIdByAlias.has(alias)) {
        nodeStableIdByAlias.set(alias, node.stableId);
      }
    });
  });

  const runtimeRecordsByFunctionStableId = new Map();
  records.forEach((record) => {
    const resolvedStableId = resolveRuntimeRecordStableId(record);
    const featureStableId = resolvedStableId ? nodeStableIdByAlias.get(resolvedStableId) : undefined;
    if (!featureStableId) {
      return;
    }

    const existing = runtimeRecordsByFunctionStableId.get(featureStableId) || [];
    existing.push(record);
    runtimeRecordsByFunctionStableId.set(featureStableId, existing);
  });

  const nodes = functionNodes.map((node) => {
    const matchingEvents = (runtimeRecordsByFunctionStableId.get(node.stableId) || []).slice(0, limit);

    return {
      node,
      eventCount: matchingEvents.length,
      events: matchingEvents,
    };
  }).filter((item) => item.eventCount > 0);

  return {
    available: true,
    error: null,
    sessionId: sessionId || null,
    nodeCount: nodes.length,
    nodes,
  };
}

async function resolveFeatureBackboneFunctionNodes(feature, { driver, database }) {
  return {
    available: false,
    error: 'Feature backbone nodes must be supplied from the local logging payload.',
    backboneFunctionNodes: [],
  };
}

async function loadRecentOwnerScopedRuntimeNodeLogs(runtimeStore, functionNodes, limit) {
  const allRecords = await fetchRuntimeEventRecords(runtimeStore, {
    limit: clampRuntimeRecordFetchLimit(limit, functionNodes.length),
  });
  if (!allRecords.length) {
    return {
      available: true,
      error: null,
      sessionId: null,
      nodeCount: 0,
      nodes: [],
    };
  }

  const latestTimestamp = Math.max(...allRecords.map((record) => Date.parse(record?.ingestedAt || '') || 0));
  const filteredRecords = !latestTimestamp
    ? allRecords
    : allRecords.filter((record) => {
      const timestamp = Date.parse(record?.ingestedAt || '') || 0;
      return latestTimestamp - timestamp <= OWNER_SCOPED_RECENT_WINDOW_MS;
    });

  return buildRuntimeNodeLogs(functionNodes, filteredRecords, { limit, sessionId: null });
}

export async function loadFeatureLatestRuntimeSessionId(feature, { runtimeStore, backboneFunctionNodes } = {}) {
  if (!runtimeStore) {
    return null;
  }

  const resolvedBackboneFunctionNodes = Array.isArray(backboneFunctionNodes)
    ? backboneFunctionNodes.filter((node) => node?.stableId)
    : [];

  if (!resolvedBackboneFunctionNodes.length) {
    return null;
  }

  return findLatestSessionIdForFunctions(
    runtimeStore,
    resolvedBackboneFunctionNodes.map((node) => node.stableId),
  );
}

export async function loadFeatureLatestRuntimeLogs(feature, {
  limit = 100,
  fnName,
  backboneFunctionNodes,
} = {}, { runtimeStore } = {}) {
  const safeLimit = clampRuntimeNodeLogLimit(limit);

  if (!runtimeStore) {
    return {
      available: false,
      error: 'Runtime logs are unavailable.',
      sessionId: null,
      eventCount: 0,
      events: [],
    };
  }

  const sessionId = await loadFeatureLatestRuntimeSessionId(feature, {
    runtimeStore,
    backboneFunctionNodes,
  });
  if (!sessionId) {
    return {
      available: true,
      error: null,
      sessionId: null,
      eventCount: 0,
      events: [],
    };
  }

  const records = await fetchRuntimeEventRecords(runtimeStore, {
    limit: safeLimit,
    sessionId,
    fnName,
  });

  return {
    available: true,
    error: null,
    sessionId,
    eventCount: records.length,
    events: records,
  };
}

export async function loadFeatureRuntimeNodeLogs(feature, { sessionId, limit = 50, backboneFunctionNodes }, { runtimeStore } = {}) {
  const safeLimit = clampRuntimeNodeLogLimit(limit);

  if (!runtimeStore) {
    return {
      available: false,
      error: 'Runtime logs are unavailable.',
      sessionId: sessionId || null,
      nodeCount: 0,
      nodes: [],
    };
  }

  const resolvedFunctionNodes = Array.isArray(backboneFunctionNodes)
    ? backboneFunctionNodes.filter((node) => node?.stableId)
    : [];

  if (!resolvedFunctionNodes.length) {
    return {
      available: true,
      error: null,
      sessionId: sessionId || null,
      nodeCount: 0,
      nodes: [],
    };
  }

  if (!sessionId) {
    return loadRecentOwnerScopedRuntimeNodeLogs(runtimeStore, resolvedFunctionNodes, safeLimit);
  }

  const runtimeRecords = await fetchRuntimeEventRecords(runtimeStore, {
    sessionId,
    limit: clampRuntimeRecordFetchLimit(safeLimit, resolvedFunctionNodes.length),
  });

  return buildRuntimeNodeLogs(resolvedFunctionNodes, runtimeRecords, { limit: safeLimit, sessionId });
}

