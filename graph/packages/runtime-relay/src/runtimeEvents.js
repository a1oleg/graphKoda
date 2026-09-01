import neo4j from 'neo4j-driver';

import {
  fetchRuntimeChainRowsFromRedis,
  fetchRuntimeEventRecordsFromRedis,
  findLatestRuntimeFunctionCandidateFromRedis,
  findRuntimeCausalLinkCandidatesFromRedis,
  isRedisRuntimeStoreConfig,
} from './runtimeRedis.js';

export function normalizeValue(value) {
  if (value === undefined || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }

  if (typeof value === 'object') {
    if (typeof value.toNumber === 'function') {
      return value.toNumber();
    }

    if (typeof value.toString === 'function' && value.constructor?.name === 'DateTime') {
      return value.toString();
    }

    if (typeof value.entries === 'function' && value.constructor?.name === 'Record') {
      return Object.fromEntries([...value.entries()].map(([key, nestedValue]) => [key, normalizeValue(nestedValue)]));
    }

    return Object.fromEntries(Object.entries(value).map(([key, nestedValue]) => [key, normalizeValue(nestedValue)]));
  }

  return value;
}

export async function runReadQuery(driver, database, query, parameters = {}) {
  const session = driver.session({ database, defaultAccessMode: neo4j.session.READ });
  try {
    const result = await session.run(query, parameters);
    return result.records.map((record) => normalizeValue(record.toObject()));
  } finally {
    await session.close();
  }
}

function assertRedisRuntimeStoreConfig(runtimeStore) {
  if (!isRedisRuntimeStoreConfig(runtimeStore)) {
    throw new Error('Non-Redis runtime store configs are no longer supported. Configure a Redis runtime store.');
  }

  return runtimeStore;
}

function buildGuardAnchorPrefix(guardId) {
  if (!guardId) {
    return undefined;
  }

  const [decisionPart] = guardId.split('#');
  if (!decisionPart) {
    return undefined;
  }

  const match = decisionPart.match(/^(.*:\d+:\d+):[^:]+$/);
  if (!match) {
    return undefined;
  }

  return `${match[1]}:`;
}

async function resolveRuntimeGuardAnchors(driver, database, records) {
  const anchorInputs = [];

  for (const record of records) {
    for (const [kind, guardId] of [
      ['decision', record.decisionId],
      ['predicate', record.predicateId],
      ['branch', record.branchId],
    ]) {
      const prefix = buildGuardAnchorPrefix(guardId);
      if (!prefix) {
        continue;
      }

      anchorInputs.push({
        kind,
        guardId,
        prefix,
      });
    }
  }

  if (!anchorInputs.length) {
    return new Map();
  }

  const resolved = await runReadQuery(
    driver,
    database,
    `
      UNWIND $anchors AS anchor
      OPTIONAL MATCH (branch:Step:Branch)
      WHERE branch.stableId STARTS WITH anchor.prefix
      RETURN anchor.kind AS kind,
             anchor.guardId AS guardId,
             head(collect(branch.stableId)) AS stableId
    `,
    { anchors: anchorInputs },
  );

  return new Map(
    resolved
      .filter((record) => record.kind && record.guardId)
      .map((record) => [`${record.kind}:${record.guardId}`, record.stableId || null]),
  );
}

function parseJsonPayload(rawValue) {
  if (!rawValue || rawValue === 'null') {
    return null;
  }

  try {
    return JSON.parse(rawValue);
  } catch {
    return rawValue;
  }
}

export async function fetchRuntimeEventRecords(runtimeStore, {
  limit = 20,
  fnName,
  sessionId,
  ownerFnStableId,
} = {}) {
  return fetchRuntimeEventRecordsFromRedis(assertRedisRuntimeStoreConfig(runtimeStore), {
    limit,
    fnName,
    sessionId,
    ownerFnStableId,
  });
}

function toNullableString(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  return String(value);
}

function toBoolean(value) {
  return value === true || value === 1 || value === '1';
}

function makeCaveat(code, message, { severity = 'warning', nodeId = null, correlationId = null } = {}) {
  return {
    code,
    severity,
    message,
    nodeId,
    correlationId,
  };
}

function createRuntimeCausalLink({
  sourceNodeId,
  targetNodeId,
  kind,
  strength,
  inferredBy,
  correlationId = null,
  boundaryPairId = null,
  asyncKind = null,
  boundaryKind = null,
  message,
}) {
  return {
    id: `${kind}:${sourceNodeId}:${targetNodeId}:${correlationId || boundaryPairId || ''}`,
    sourceNodeId,
    targetNodeId,
    kind,
    strength,
    inferredBy,
    correlationId,
    boundaryPairId,
    asyncKind,
    boundaryKind,
    message,
  };
}

async function fetchRuntimeChainRows(runtimeStore, { nodeId, sessionId, correlationId, boundaryPairId, limit = 1000 }) {
  return fetchRuntimeChainRowsFromRedis(assertRedisRuntimeStoreConfig(runtimeStore), {
    nodeId,
    sessionId,
    correlationId,
    boundaryPairId,
    limit,
  });
}

export async function findRuntimeCausalLinkCandidates(runtimeStore, { sessionId, limit = 20 } = {}) {
  return findRuntimeCausalLinkCandidatesFromRedis(assertRedisRuntimeStoreConfig(runtimeStore), { sessionId, limit });
}

function aggregateRuntimeChainNodes(enrichedRecords) {
  const aggregated = new Map();

  for (const record of enrichedRecords) {
    if (!record.nodeId) {
      continue;
    }

    const existing = aggregated.get(record.nodeId);
    if (!existing) {
      aggregated.set(record.nodeId, {
        nodeId: record.nodeId,
        parentNodeId: record.parentNodeId || null,
        sessionId: record.sessionId || null,
        correlationId: record.correlationId || null,
        ingestedAt: record.ingestedAt || null,
        kind: record.kind || null,
        fnName: record.fnName || null,
        edgeType: record.edgeType || null,
        asyncPhase: record.asyncPhase || null,
        asyncKind: record.asyncKind || null,
        resourceKind: record.resourceKind || null,
        boundaryKind: record.boundaryKind || null,
        boundaryDirection: record.boundaryDirection || null,
        boundaryTransport: record.boundaryTransport || null,
        boundaryPairId: record.boundaryPairId || null,
        completionKind: record.completionKind || null,
        functionStableId: record.functionStableId || null,
        ownerFnStableId: record.ownerFnStableId || null,
        staticStepId: record.staticStepId || null,
        staticFilePath: record.staticFilePath || null,
        staticFnStartLine: record.staticFnStartLine ?? null,
        observedKinds: new Set(record.kind ? [record.kind] : []),
        updateOnlyMerged: Boolean(record.updateOnly),
        hasResponseUpdate: Boolean(record.updateOnly && (record.kind === 'response' || record.kind === 'error' || record.completionKind)),
        caveats: [],
        __rows: [record],
      });
      continue;
    }

    existing.__rows.push(record);
    if (record.parentNodeId && !existing.parentNodeId) {
      existing.parentNodeId = record.parentNodeId;
    }
    existing.sessionId = existing.sessionId || record.sessionId || null;
    existing.correlationId = existing.correlationId || record.correlationId || null;
    existing.ingestedAt = existing.ingestedAt || record.ingestedAt || null;
    existing.kind = existing.kind || record.kind || null;
    existing.fnName = existing.fnName || record.fnName || null;
    existing.edgeType = existing.edgeType || record.edgeType || null;
    existing.asyncPhase = existing.asyncPhase || record.asyncPhase || null;
    existing.asyncKind = existing.asyncKind || record.asyncKind || null;
    existing.resourceKind = existing.resourceKind || record.resourceKind || null;
    existing.boundaryKind = existing.boundaryKind || record.boundaryKind || null;
    existing.boundaryDirection = existing.boundaryDirection || record.boundaryDirection || null;
    existing.boundaryTransport = existing.boundaryTransport || record.boundaryTransport || null;
    existing.boundaryPairId = existing.boundaryPairId || record.boundaryPairId || null;
    existing.completionKind = existing.completionKind || record.completionKind || null;
    existing.functionStableId = existing.functionStableId || record.functionStableId || null;
    existing.ownerFnStableId = existing.ownerFnStableId || record.ownerFnStableId || null;
    existing.staticStepId = existing.staticStepId || record.staticStepId || null;
    existing.staticFilePath = existing.staticFilePath || record.staticFilePath || null;
    existing.staticFnStartLine = existing.staticFnStartLine ?? record.staticFnStartLine ?? null;
    if (record.kind) {
      existing.observedKinds.add(record.kind);
    }
    existing.updateOnlyMerged = existing.updateOnlyMerged || Boolean(record.updateOnly);
    existing.hasResponseUpdate = existing.hasResponseUpdate || Boolean(record.updateOnly && (record.kind === 'response' || record.kind === 'error' || record.completionKind));
  }

  return aggregated;
}

function collectConnectedNodeIds(aggregatedNodes, { anchorNodeId, correlationId, boundaryPairId, maxDepth }) {
  const childIdsByParent = new Map();
  const nodeIdsByCorrelation = new Map();
  const nodeIdsByBoundaryPair = new Map();

  for (const node of aggregatedNodes.values()) {
    if (node.parentNodeId) {
      const children = childIdsByParent.get(node.parentNodeId) || [];
      children.push(node.nodeId);
      childIdsByParent.set(node.parentNodeId, children);
    }

    if (node.correlationId) {
      const siblings = nodeIdsByCorrelation.get(node.correlationId) || [];
      siblings.push(node.nodeId);
      nodeIdsByCorrelation.set(node.correlationId, siblings);
    }

    if (node.boundaryPairId) {
      const peers = nodeIdsByBoundaryPair.get(node.boundaryPairId) || [];
      peers.push(node.nodeId);
      nodeIdsByBoundaryPair.set(node.boundaryPairId, peers);
    }
  }

  const seedNodeIds = [];
  if (anchorNodeId && aggregatedNodes.has(anchorNodeId)) {
    seedNodeIds.push(anchorNodeId);
  }
  if (!seedNodeIds.length && correlationId) {
    seedNodeIds.push(...(nodeIdsByCorrelation.get(correlationId) || []));
  }
  if (!seedNodeIds.length && boundaryPairId) {
    seedNodeIds.push(...(nodeIdsByBoundaryPair.get(boundaryPairId) || []));
  }
  if (!seedNodeIds.length) {
    seedNodeIds.push(...aggregatedNodes.keys());
  }

  const visited = new Set();
  const queue = seedNodeIds.map((nodeId) => ({ nodeId, depth: 0 }));

  while (queue.length) {
    const current = queue.shift();
    if (!current || visited.has(current.nodeId)) {
      continue;
    }

    visited.add(current.nodeId);
    if (current.depth >= maxDepth) {
      continue;
    }

    const currentNode = aggregatedNodes.get(current.nodeId);
    if (!currentNode) {
      continue;
    }

    if (currentNode.parentNodeId && aggregatedNodes.has(currentNode.parentNodeId)) {
      queue.push({ nodeId: currentNode.parentNodeId, depth: current.depth + 1 });
    }

    for (const childNodeId of childIdsByParent.get(current.nodeId) || []) {
      queue.push({ nodeId: childNodeId, depth: current.depth + 1 });
    }

    for (const correlatedNodeId of nodeIdsByCorrelation.get(currentNode.correlationId) || []) {
      if (correlatedNodeId !== current.nodeId) {
        queue.push({ nodeId: correlatedNodeId, depth: current.depth + 1 });
      }
    }

    for (const boundaryPeerNodeId of nodeIdsByBoundaryPair.get(currentNode.boundaryPairId) || []) {
      if (boundaryPeerNodeId !== current.nodeId) {
        queue.push({ nodeId: boundaryPeerNodeId, depth: current.depth + 1 });
      }
    }
  }

  return { visited, childIdsByParent, nodeIdsByCorrelation, nodeIdsByBoundaryPair };
}

function buildRuntimeCausalChainModel(aggregatedNodes, scope, { maxDepth, truncated, limit }) {
  const { visited, childIdsByParent, nodeIdsByCorrelation, nodeIdsByBoundaryPair } = collectConnectedNodeIds(aggregatedNodes, {
    anchorNodeId: scope.anchorNodeId,
    correlationId: scope.correlationId,
    boundaryPairId: scope.boundaryPairId,
    maxDepth,
  });

  const nodes = [...visited]
    .map((nodeId) => aggregatedNodes.get(nodeId))
    .filter(Boolean)
    .sort((left, right) => String(left.ingestedAt || '').localeCompare(String(right.ingestedAt || '')));

  const includedNodeIds = new Set(nodes.map((node) => node.nodeId));
  const nodeDepths = new Map();
  const queue = [];

  const roots = nodes.filter((node) => !node.parentNodeId || !includedNodeIds.has(node.parentNodeId));
  for (const root of roots) {
    nodeDepths.set(root.nodeId, 0);
    queue.push(root.nodeId);
  }

  while (queue.length) {
    const nodeId = queue.shift();
    const depth = nodeDepths.get(nodeId) || 0;
    for (const childNodeId of (childIdsByParent.get(nodeId) || []).filter((candidate) => includedNodeIds.has(candidate))) {
      if (!nodeDepths.has(childNodeId) || (nodeDepths.get(childNodeId) > depth + 1)) {
        nodeDepths.set(childNodeId, depth + 1);
        queue.push(childNodeId);
      }
    }
  }

  let missingParentCount = 0;
  let mergedUpdateOnlyCount = 0;
  let weakAsyncBridgeCount = 0;

  const nodeObjects = nodes.map((node) => {
    const nodeCaveats = [];
    if (node.parentNodeId && !includedNodeIds.has(node.parentNodeId)) {
      missingParentCount += 1;
      nodeCaveats.push(makeCaveat(
        'PARENT_GAP',
        'Parent node is missing from the runtime-store chain slice. This usually means an uninstrumented gap, filtered event kind/profile, or query truncation.',
        { nodeId: node.nodeId, correlationId: node.correlationId },
      ));
    }

    if (node.updateOnlyMerged) {
      mergedUpdateOnlyCount += 1;
      nodeCaveats.push(makeCaveat(
        'UPDATE_ONLY_MERGED',
        'response/error completion rows are stored as updateOnly rows on the same nodeid in the runtime store, so they are merged into this node instead of appearing as standalone child events.',
        { nodeId: node.nodeId, correlationId: node.correlationId, severity: 'info' },
      ));
    }

    const correlationPeers = (node.correlationId ? (nodeIdsByCorrelation.get(node.correlationId) || []).filter((candidate) => candidate !== node.nodeId && includedNodeIds.has(candidate)) : []);
    if (node.correlationId && correlationPeers.length === 0 && (node.asyncKind || node.boundaryKind || node.resourceKind === 'call-api')) {
      weakAsyncBridgeCount += 1;
      nodeCaveats.push(makeCaveat(
        'ASYNC_BRIDGE_PARTIAL',
        'This async or boundary segment has a correlationId but no linked peer in the selected runtime-store slice. Cross-boundary causal continuity depends on explicit bridge instrumentation such as traceCallApiRuntimeInvoke.',
        { nodeId: node.nodeId, correlationId: node.correlationId },
      ));
    }

    return {
      nodeId: node.nodeId,
      parentNodeId: toNullableString(node.parentNodeId),
      sessionId: toNullableString(node.sessionId),
      correlationId: toNullableString(node.correlationId),
      ingestedAt: toNullableString(node.ingestedAt),
      kind: toNullableString(node.kind),
      fnName: toNullableString(node.fnName),
      edgeType: toNullableString(node.edgeType),
      asyncPhase: toNullableString(node.asyncPhase),
      asyncKind: toNullableString(node.asyncKind),
      resourceKind: toNullableString(node.resourceKind),
      boundaryKind: toNullableString(node.boundaryKind),
      boundaryDirection: toNullableString(node.boundaryDirection),
      boundaryTransport: toNullableString(node.boundaryTransport),
      boundaryPairId: toNullableString(node.boundaryPairId),
      completionKind: toNullableString(node.completionKind),
      functionStableId: toNullableString(node.functionStableId),
      ownerFnStableId: toNullableString(node.ownerFnStableId),
      staticStepId: toNullableString(node.staticStepId),
      staticFilePath: toNullableString(node.staticFilePath),
      staticFnStartLine: node.staticFnStartLine ?? null,
      observedKinds: [...node.observedKinds],
      updateOnlyMerged: Boolean(node.updateOnlyMerged),
      hasResponseUpdate: Boolean(node.hasResponseUpdate),
      depth: nodeDepths.get(node.nodeId) ?? 0,
      caveats: nodeCaveats,
      __childrenIds: (childIdsByParent.get(node.nodeId) || []).filter((candidate) => includedNodeIds.has(candidate)),
      __asyncChildrenIds: correlationPeers.filter((candidate) => aggregatedNodes.get(candidate)?.parentNodeId !== node.nodeId),
      __maxDepth: maxDepth,
    };
  });

  const nodeById = new Map(nodeObjects.map((node) => [node.nodeId, node]));
  const rootNodes = roots.map((node) => nodeById.get(node.nodeId)).filter(Boolean);
  const links = [];
  const linkIds = new Set();

  function pushLink(link) {
    if (!link || linkIds.has(link.id)) {
      return;
    }

    linkIds.add(link.id);
    links.push(link);
  }

  for (const node of nodeObjects) {
    if (node.parentNodeId && includedNodeIds.has(node.parentNodeId)) {
      pushLink(createRuntimeCausalLink({
        sourceNodeId: node.parentNodeId,
        targetNodeId: node.nodeId,
        kind: 'PARENT',
        strength: 'strong',
        inferredBy: 'nodeId->parentNodeId',
        correlationId: node.correlationId,
        message: 'Strong causal edge reconstructed directly from parentNodeId in runtime-store logs.',
      }));
    }
  }

  const correlationGroups = new Map();
  for (const node of nodeObjects) {
    if (!node.correlationId) {
      continue;
    }

    const entries = correlationGroups.get(node.correlationId) || [];
    entries.push(node);
    correlationGroups.set(node.correlationId, entries);
  }

  for (const [groupCorrelationId, groupNodes] of correlationGroups) {
    const orderedNodes = [...groupNodes].sort((left, right) => {
      const timeComparison = String(left.ingestedAt || '').localeCompare(String(right.ingestedAt || ''));
      if (timeComparison !== 0) {
        return timeComparison;
      }

      return left.nodeId.localeCompare(right.nodeId);
    });

    for (let i = 1; i < orderedNodes.length; i += 1) {
      const source = orderedNodes[i - 1];
      const target = orderedNodes[i];
      if (!source || !target || source.nodeId === target.nodeId) {
        continue;
      }

      const sharedBoundaryPairId = source.boundaryPairId && target.boundaryPairId && source.boundaryPairId === target.boundaryPairId
        ? source.boundaryPairId
        : null;
      const kind = sharedBoundaryPairId || source.boundaryKind || target.boundaryKind
        ? 'BOUNDARY'
        : 'ASYNC';
      const inferredBy = sharedBoundaryPairId
        ? 'correlationId+boundaryPairId'
        : 'correlationId+time-order';
      const strength = sharedBoundaryPairId || source.asyncKind === 'call-api' || target.asyncKind === 'call-api'
        ? 'strong'
        : 'medium';
      const boundaryKind = source.boundaryKind || target.boundaryKind || null;
      const asyncKind = source.asyncKind || target.asyncKind || null;

      pushLink(createRuntimeCausalLink({
        sourceNodeId: source.nodeId,
        targetNodeId: target.nodeId,
        kind,
        strength,
        inferredBy,
        correlationId: groupCorrelationId,
        boundaryPairId: sharedBoundaryPairId,
        asyncKind,
        boundaryKind,
        message: kind === 'BOUNDARY'
          ? 'Cross-boundary causal edge inferred from correlationId and observed boundary metadata in runtime-store logs.'
          : 'Async causal edge inferred from correlationId ordering in runtime-store logs.',
      }));
    }
  }

  const boundaryPairGroups = new Map();
  for (const node of nodeObjects) {
    if (!node.boundaryPairId) {
      continue;
    }

    const entries = boundaryPairGroups.get(node.boundaryPairId) || [];
    entries.push(node);
    boundaryPairGroups.set(node.boundaryPairId, entries);
  }

  for (const [groupBoundaryPairId, groupNodes] of boundaryPairGroups) {
    const orderedNodes = [...groupNodes].sort((left, right) => {
      const timeComparison = String(left.ingestedAt || '').localeCompare(String(right.ingestedAt || ''));
      if (timeComparison !== 0) {
        return timeComparison;
      }

      return left.nodeId.localeCompare(right.nodeId);
    });

    for (let i = 1; i < orderedNodes.length; i += 1) {
      const source = orderedNodes[i - 1];
      const target = orderedNodes[i];
      if (!source || !target || source.nodeId === target.nodeId) {
        continue;
      }

      pushLink(createRuntimeCausalLink({
        sourceNodeId: source.nodeId,
        targetNodeId: target.nodeId,
        kind: 'BOUNDARY',
        strength: 'strong',
        inferredBy: 'boundaryPairId',
        correlationId: source.correlationId || target.correlationId || null,
        boundaryPairId: groupBoundaryPairId,
        asyncKind: source.asyncKind || target.asyncKind || null,
        boundaryKind: source.boundaryKind || target.boundaryKind || null,
        message: 'Direct boundary causal edge reconstructed from shared boundaryPairId in runtime-store logs.',
      }));
    }
  }

  const outgoingLinkIdsByNodeId = new Map();
  const incomingLinkIdsByNodeId = new Map();
  for (const link of links) {
    const outgoing = outgoingLinkIdsByNodeId.get(link.sourceNodeId) || [];
    outgoing.push(link.id);
    outgoingLinkIdsByNodeId.set(link.sourceNodeId, outgoing);

    const incoming = incomingLinkIdsByNodeId.get(link.targetNodeId) || [];
    incoming.push(link.id);
    incomingLinkIdsByNodeId.set(link.targetNodeId, incoming);
  }

  for (const node of nodeObjects) {
    node.__outgoingLinkIds = outgoingLinkIdsByNodeId.get(node.nodeId) || [];
    node.__incomingLinkIds = incomingLinkIdsByNodeId.get(node.nodeId) || [];
  }

  const caveats = [
    ...(truncated ? [makeCaveat('CHAIN_TRUNCATED', 'The runtime-store chain slice hit the query limit, so downstream parent/child or async links may be incomplete.', { severity: 'warning' })] : []),
    ...(missingParentCount ? [makeCaveat('INSTRUMENTATION_GAPS', 'Some parent links are missing in the runtime-store slice. This usually means uninstrumented or filtered segments, or truncation.', { severity: 'warning' })] : []),
    ...(mergedUpdateOnlyCount ? [makeCaveat('UPDATE_ONLY_ROW_MODEL', 'The runtime store keeps response/error completions as updateOnly rows on the same nodeid, so causal assembly merges them into existing nodes instead of creating child nodes.', { severity: 'info' })] : []),
    ...(weakAsyncBridgeCount ? [makeCaveat('ASYNC_BRIDGE_PARTIAL', 'Some async or boundary transitions have no linked peer in the selected slice. Full cross-boundary continuity depends on explicit bridge instrumentation such as traceCallApiRuntimeInvoke.', { severity: 'warning' })] : []),
  ];

  const completeness = {
    parentTreeComplete: missingParentCount === 0,
    asyncBridgeComplete: weakAsyncBridgeCount === 0,
    mergedUpdateOnly: mergedUpdateOnlyCount > 0,
    potentialInstrumentationGaps: truncated || missingParentCount > 0,
    message: missingParentCount === 0 && weakAsyncBridgeCount === 0
      ? 'The runtime-store slice can reconstruct a strong causal chain from parent links and observed async bridges.'
      : 'The runtime-store slice can reconstruct a partial causal chain, but some parent or async bridge segments remain caveated.',
  };

  return {
    nodeById,
    chain: {
      available: true,
      error: null,
      selector: {
        nodeId: scope.anchorNodeId || null,
        sessionId: scope.sessionId || null,
        correlationId: scope.correlationId || null,
        boundaryPairId: scope.boundaryPairId || null,
        maxDepth,
        limit,
      },
      nodeCount: nodeObjects.length,
      edgeCount: links.length,
      truncated,
      completeness,
      caveats,
      links,
      roots: rootNodes,
      nodes: nodeObjects,
    },
  };
}

export async function loadRuntimeCausalChain(runtimeStore, driver, database, {
  nodeId,
  sessionId,
  correlationId,
  boundaryPairId,
  maxDepth = 25,
  limit = 1000,
} = {}) {
  if (!nodeId && !sessionId && !correlationId && !boundaryPairId) {
    return {
      available: false,
      error: 'Provide at least one selector: nodeId, sessionId, correlationId, or boundaryPairId.',
      selector: {
        nodeId: null,
        sessionId: null,
        correlationId: null,
        boundaryPairId: null,
        maxDepth: Math.max(1, Math.min(maxDepth, 100)),
        limit: Math.max(1, Math.min(limit, 5000)),
      },
      nodeCount: 0,
      edgeCount: 0,
      truncated: false,
      completeness: {
        parentTreeComplete: false,
        asyncBridgeComplete: false,
        mergedUpdateOnly: false,
        potentialInstrumentationGaps: false,
        message: 'No causal chain selector was provided.',
      },
      caveats: [],
      roots: [],
      nodes: [],
    };
  }

  try {
    const safeMaxDepth = Math.max(1, Math.min(maxDepth, 100));
    const safeLimit = Math.max(1, Math.min(limit, 5000));
    const { scope, rows, truncated } = await fetchRuntimeChainRows(runtimeStore, {
      nodeId,
      sessionId,
      correlationId,
      boundaryPairId,
      limit: safeLimit,
    });

    if (!rows.length) {
      return {
        available: true,
        error: null,
        selector: {
          nodeId: scope.anchorNodeId || nodeId || null,
          sessionId: scope.sessionId || sessionId || null,
          correlationId: scope.correlationId || correlationId || null,
          boundaryPairId: scope.boundaryPairId || boundaryPairId || null,
          maxDepth: safeMaxDepth,
          limit: safeLimit,
        },
        nodeCount: 0,
        edgeCount: 0,
        truncated: false,
        completeness: {
          parentTreeComplete: false,
          asyncBridgeComplete: false,
          mergedUpdateOnly: false,
          potentialInstrumentationGaps: false,
          message: 'No runtime-store rows matched the requested causal chain selector.',
        },
        caveats: [],
        roots: [],
        nodes: [],
      };
    }

    const enriched = await enrichRuntimeEventRecords(driver, database, rows.map((row) => ({
      ...row,
      updateOnly: toBoolean(row.updateOnly),
    })));
    const aggregatedNodes = aggregateRuntimeChainNodes(enriched);
    const { nodeById, chain } = buildRuntimeCausalChainModel(aggregatedNodes, scope, {
      maxDepth: safeMaxDepth,
      truncated,
      limit: safeLimit,
    });

    const attachedLinks = chain.links.map((link) => ({
      ...link,
      __nodeById: undefined,
    }));
    const attachedLinkById = new Map(attachedLinks.map((link) => [link.id, link]));
    const attachedNodes = chain.nodes.map((node) => ({
      ...node,
      __nodeById: undefined,
      __linkById: undefined,
    }));
    const attachedNodeById = new Map(attachedNodes.map((node) => [node.nodeId, node]));

    for (const node of attachedNodes) {
      node.__nodeById = attachedNodeById;
      node.__linkById = attachedLinkById;
    }

    for (const link of attachedLinks) {
      link.__nodeById = attachedNodeById;
    }

    return {
      ...chain,
      links: attachedLinks,
      roots: chain.roots.map((node) => attachedNodeById.get(node.nodeId)).filter(Boolean),
      nodes: attachedNodes,
    };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
      selector: {
        nodeId: nodeId || null,
        sessionId: sessionId || null,
        correlationId: correlationId || null,
        boundaryPairId: boundaryPairId || null,
        maxDepth: Math.max(1, Math.min(maxDepth, 100)),
        limit: Math.max(1, Math.min(limit, 5000)),
      },
      nodeCount: 0,
      edgeCount: 0,
      truncated: false,
      completeness: {
        parentTreeComplete: false,
        asyncBridgeComplete: false,
        mergedUpdateOnly: false,
        potentialInstrumentationGaps: false,
        message: 'Causal chain assembly failed before a runtime-store-backed chain could be built.',
      },
      caveats: [],
      roots: [],
      nodes: [],
    };
  }
}

function makeTransitionKey(sourceStableId, targetStableId) {
  return `${sourceStableId || ''}->${targetStableId || ''}`;
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

function resolveRuntimeFunctionStableId(node) {
  return node?.functionStableId || node?.ownerFnStableId || buildRuntimeFunctionCoordinateKey(node);
}

function sortRuntimeNodesChronologically(nodes) {
  return [...nodes].sort((left, right) => {
    const timeComparison = String(left?.ingestedAt || '').localeCompare(String(right?.ingestedAt || ''));
    if (timeComparison !== 0) {
      return timeComparison;
    }

    return String(left?.nodeId || '').localeCompare(String(right?.nodeId || ''));
  });
}

function buildRuntimeFunctionChainSummary(chain) {
  const safeNodes = sortRuntimeNodesChronologically(chain?.nodes || []);
  const safeLinks = chain?.links || [];
  const nodeById = new Map(safeNodes.map((node) => [node.nodeId, node]));
  const observedFunctionsByStableId = new Map();
  const runtimeTransitionsByKey = new Map();

  for (const node of safeNodes) {
    const functionStableId = resolveRuntimeFunctionStableId(node);
    if (!functionStableId) {
      continue;
    }

    const existing = observedFunctionsByStableId.get(functionStableId) || {
      stableId: functionStableId,
      fnNames: new Set(),
      nodeIds: new Set(),
      firstSeenAt: node.ingestedAt || null,
      lastSeenAt: node.ingestedAt || null,
      eventCount: 0,
    };

    if (node.fnName) {
      existing.fnNames.add(node.fnName);
    }

    existing.nodeIds.add(node.nodeId);
    existing.eventCount += 1;
    existing.firstSeenAt = existing.firstSeenAt
      ? [existing.firstSeenAt, node.ingestedAt].filter(Boolean).sort()[0]
      : node.ingestedAt || null;
    existing.lastSeenAt = existing.lastSeenAt
      ? [existing.lastSeenAt, node.ingestedAt].filter(Boolean).sort().at(-1)
      : node.ingestedAt || null;
    observedFunctionsByStableId.set(functionStableId, existing);
  }

  for (const link of safeLinks) {
    const sourceNode = nodeById.get(link.sourceNodeId);
    const targetNode = nodeById.get(link.targetNodeId);
    const sourceStableId = resolveRuntimeFunctionStableId(sourceNode);
    const targetStableId = resolveRuntimeFunctionStableId(targetNode);

    if (!sourceStableId || !targetStableId || sourceStableId === targetStableId) {
      continue;
    }

    const key = makeTransitionKey(sourceStableId, targetStableId);
    const existing = runtimeTransitionsByKey.get(key) || {
      key,
      sourceStableId,
      targetStableId,
      sourceFnNames: new Set(),
      targetFnNames: new Set(),
      linkKinds: new Set(),
      inferredBy: new Set(),
      sampleNodeIds: [],
      transitionCount: 0,
      firstSeenAt: null,
      lastSeenAt: null,
    };

    if (sourceNode?.fnName) {
      existing.sourceFnNames.add(sourceNode.fnName);
    }

    if (targetNode?.fnName) {
      existing.targetFnNames.add(targetNode.fnName);
    }

    if (link?.kind) {
      existing.linkKinds.add(link.kind);
    }

    if (link?.inferredBy) {
      existing.inferredBy.add(link.inferredBy);
    }

    if (existing.sampleNodeIds.length < 5) {
      existing.sampleNodeIds.push({
        sourceNodeId: sourceNode?.nodeId || null,
        targetNodeId: targetNode?.nodeId || null,
      });
    }

    existing.transitionCount += 1;
    const times = [existing.firstSeenAt, sourceNode?.ingestedAt, targetNode?.ingestedAt].filter(Boolean).sort();
    existing.firstSeenAt = times[0] || null;
    existing.lastSeenAt = times.at(-1) || null;
    runtimeTransitionsByKey.set(key, existing);
  }

  return {
    observedFunctions: [...observedFunctionsByStableId.values()]
      .map((entry) => ({
        stableId: entry.stableId,
        fnNames: [...entry.fnNames],
        nodeIds: [...entry.nodeIds],
        eventCount: entry.eventCount,
        firstSeenAt: entry.firstSeenAt,
        lastSeenAt: entry.lastSeenAt,
      }))
      .sort((left, right) => String(left.firstSeenAt || '').localeCompare(String(right.firstSeenAt || ''))),
    runtimeTransitions: [...runtimeTransitionsByKey.values()]
      .map((entry) => ({
        key: entry.key,
        sourceStableId: entry.sourceStableId,
        targetStableId: entry.targetStableId,
        sourceFnNames: [...entry.sourceFnNames],
        targetFnNames: [...entry.targetFnNames],
        linkKinds: [...entry.linkKinds],
        inferredBy: [...entry.inferredBy],
        sampleNodeIds: entry.sampleNodeIds,
        transitionCount: entry.transitionCount,
        firstSeenAt: entry.firstSeenAt,
        lastSeenAt: entry.lastSeenAt,
      }))
      .sort((left, right) => String(left.firstSeenAt || '').localeCompare(String(right.firstSeenAt || ''))),
    runtimeNodeCountWithoutStaticAnchor: safeNodes.filter((node) => !resolveRuntimeFunctionStableId(node)).length,
  };
}

async function loadStaticFunctionTransitions(driver, database, stableIds) {
  if (!stableIds.length) {
    return [];
  }

  return runReadQuery(
    driver,
    database,
    `
      UNWIND $stableIds AS sourceStableId
      MATCH (source:Fn {stableId: sourceStableId})
      MATCH (step:Step {parentFnStableId: sourceStableId})-[rel]->(target:Fn)
      WHERE target.stableId IN $stableIds
        AND target.stableId <> sourceStableId
      RETURN source.stableId AS sourceStableId,
             source.name AS sourceName,
             source.label AS sourceLabel,
             source.repo_relative_path AS sourceRepoRelativePath,
             step.stableId AS stepId,
             step.operation_index AS operationIndex,
             coalesce(rel.label, type(rel)) AS edgeLabel,
             rel.call_text_raw AS callTextRaw,
             target.stableId AS targetStableId,
             target.name AS targetName,
             target.label AS targetLabel,
             target.repo_relative_path AS targetRepoRelativePath
      ORDER BY sourceRepoRelativePath, operationIndex, targetStableId
    `,
    { stableIds },
  );
}

function groupStaticTransitions(records) {
  const grouped = new Map();

  for (const record of records) {
    const key = makeTransitionKey(record.sourceStableId, record.targetStableId);
    const existing = grouped.get(key) || {
      key,
      sourceStableId: record.sourceStableId,
      sourceName: record.sourceName || null,
      sourceLabel: record.sourceLabel || null,
      sourceRepoRelativePath: record.sourceRepoRelativePath || null,
      targetStableId: record.targetStableId,
      targetName: record.targetName || null,
      targetLabel: record.targetLabel || null,
      targetRepoRelativePath: record.targetRepoRelativePath || null,
      stepIds: new Set(),
      edgeLabels: new Set(),
      callTexts: new Set(),
    };

    if (record.stepId) {
      existing.stepIds.add(record.stepId);
    }

    if (record.edgeLabel) {
      existing.edgeLabels.add(record.edgeLabel);
    }

    if (record.callTextRaw) {
      existing.callTexts.add(record.callTextRaw);
    }

    grouped.set(key, existing);
  }

  return [...grouped.values()].map((entry) => ({
    ...entry,
    stepIds: [...entry.stepIds],
    edgeLabels: [...entry.edgeLabels],
    callTexts: [...entry.callTexts],
  }));
}

function serializeRuntimeChain(chain) {
  return {
    available: Boolean(chain?.available),
    error: chain?.error || null,
    selector: chain?.selector || null,
    nodeCount: chain?.nodeCount || 0,
    edgeCount: chain?.edgeCount || 0,
    truncated: Boolean(chain?.truncated),
    completeness: chain?.completeness || null,
    caveats: chain?.caveats || [],
    roots: (chain?.roots || []).map((node) => node?.nodeId).filter(Boolean),
    nodes: (chain?.nodes || []).map((node) => ({
      nodeId: node.nodeId,
      parentNodeId: node.parentNodeId,
      sessionId: node.sessionId,
      correlationId: node.correlationId,
      ingestedAt: node.ingestedAt,
      kind: node.kind,
      fnName: node.fnName,
      ownerFnStableId: node.ownerFnStableId,
      staticStepId: node.staticStepId,
      observedKinds: node.observedKinds,
      depth: node.depth,
      caveats: node.caveats,
    })),
    links: (chain?.links || []).map((link) => ({
      id: link.id,
      sourceNodeId: link.sourceNodeId,
      targetNodeId: link.targetNodeId,
      kind: link.kind,
      strength: link.strength,
      inferredBy: link.inferredBy,
      correlationId: link.correlationId,
      boundaryPairId: link.boundaryPairId,
      asyncKind: link.asyncKind,
      boundaryKind: link.boundaryKind,
      message: link.message,
    })),
  };
}

export async function loadRuntimeChainStaticComparison(runtimeStore, driver, database, selectors = {}) {
  const chain = await loadRuntimeCausalChain(runtimeStore, driver, database, selectors);
  const serializedChain = serializeRuntimeChain(chain);

  if (!chain?.available || chain?.error) {
    return {
      ...serializedChain,
      comparison: {
        comparedFunctionCount: 0,
        runtimeTransitionCount: 0,
        staticTransitionCount: 0,
        matchedTransitionCount: 0,
        runtimeOnlyTransitionCount: 0,
        staticOnlyTransitionCount: 0,
        observedFunctions: [],
        matchedTransitions: [],
        runtimeOnlyTransitions: [],
        staticOnlyTransitions: [],
        runtimeNodeCountWithoutStaticAnchor: 0,
      },
    };
  }

  const runtimeSummary = buildRuntimeFunctionChainSummary(chain);
  const observedStableIds = runtimeSummary.observedFunctions.map((entry) => entry.stableId).filter(Boolean);
  const staticTransitions = groupStaticTransitions(await loadStaticFunctionTransitions(driver, database, observedStableIds));
  const staticTransitionByKey = new Map(staticTransitions.map((entry) => [entry.key, entry]));
  const runtimeTransitionByKey = new Map(runtimeSummary.runtimeTransitions.map((entry) => [entry.key, entry]));

  const matchedTransitions = runtimeSummary.runtimeTransitions
    .filter((transition) => staticTransitionByKey.has(transition.key))
    .map((transition) => ({
      ...transition,
      staticTransition: staticTransitionByKey.get(transition.key),
    }));
  const runtimeOnlyTransitions = runtimeSummary.runtimeTransitions
    .filter((transition) => !staticTransitionByKey.has(transition.key));
  const staticOnlyTransitions = staticTransitions
    .filter((transition) => !runtimeTransitionByKey.has(transition.key));

  return {
    ...serializedChain,
    comparison: {
      comparedFunctionCount: observedStableIds.length,
      runtimeTransitionCount: runtimeSummary.runtimeTransitions.length,
      staticTransitionCount: staticTransitions.length,
      matchedTransitionCount: matchedTransitions.length,
      runtimeOnlyTransitionCount: runtimeOnlyTransitions.length,
      staticOnlyTransitionCount: staticOnlyTransitions.length,
      observedFunctions: runtimeSummary.observedFunctions,
      matchedTransitions,
      runtimeOnlyTransitions,
      staticOnlyTransitions,
      runtimeNodeCountWithoutStaticAnchor: runtimeSummary.runtimeNodeCountWithoutStaticAnchor,
    },
  };
}

export async function loadRuntimeChainSummary(runtimeStore, selectors = {}) {
  const chain = await loadRuntimeCausalChain(runtimeStore, undefined, undefined, selectors);
  const serializedChain = serializeRuntimeChain(chain);

  if (!chain?.available || chain?.error) {
    return {
      ...serializedChain,
      comparison: {
        comparedFunctionCount: 0,
        runtimeTransitionCount: 0,
        staticTransitionCount: 0,
        matchedTransitionCount: 0,
        runtimeOnlyTransitionCount: 0,
        staticOnlyTransitionCount: 0,
        observedFunctions: [],
        matchedTransitions: [],
        runtimeOnlyTransitions: [],
        staticOnlyTransitions: [],
        runtimeNodeCountWithoutStaticAnchor: 0,
      },
    };
  }

  const runtimeSummary = buildRuntimeFunctionChainSummary(chain);

  return {
    ...serializedChain,
    comparison: {
      comparedFunctionCount: runtimeSummary.observedFunctions.length,
      runtimeTransitionCount: runtimeSummary.runtimeTransitions.length,
      staticTransitionCount: 0,
      matchedTransitionCount: 0,
      runtimeOnlyTransitionCount: runtimeSummary.runtimeTransitions.length,
      staticOnlyTransitionCount: 0,
      observedFunctions: runtimeSummary.observedFunctions,
      matchedTransitions: [],
      runtimeOnlyTransitions: runtimeSummary.runtimeTransitions,
      staticOnlyTransitions: [],
      runtimeNodeCountWithoutStaticAnchor: runtimeSummary.runtimeNodeCountWithoutStaticAnchor,
    },
  };
}

export async function enrichRuntimeEventRecords(driver, database, records) {
  const hydratedRecords = hydrateRuntimeRecordAnchors(records);

  const guardStableIdsByKey = driver && database
    ? await resolveRuntimeGuardAnchors(driver, database, hydratedRecords)
    : new Map();

  return hydratedRecords.map((record) => {
    const staticStepId = record.statefulStepId
      ? record.statefulStepId
      : record.branchId
      ? (guardStableIdsByKey.get(`branch:${record.branchId}`) || null)
      : record.predicateId
        ? (guardStableIdsByKey.get(`predicate:${record.predicateId}`) || null)
        : record.decisionId
          ? (guardStableIdsByKey.get(`decision:${record.decisionId}`) || null)
          : null;

    return {
      nodeId: record.nodeId,
      ingestedAt: record.ingestedAt,
      sessionId: record.sessionId,
      parentNodeId: record.parentNodeId,
      updateOnly: Boolean(record.updateOnly),
      edgeType: record.edgeType,
      correlationId: record.correlationId,
      kind: record.kind,
      fnName: record.fnName,
      asyncPhase: record.asyncPhase,
      asyncKind: record.asyncKind,
      resourceKind: record.resourceKind,
      boundaryKind: record.boundaryKind,
      boundaryDirection: record.boundaryDirection,
      boundaryTransport: record.boundaryTransport,
      boundaryPairId: record.boundaryPairId,
      boundaryMessageType: record.boundaryMessageType,
      boundaryChannel: record.boundaryChannel,
      completionKind: record.completionKind,
      affectType: record.affectType,
      topLevelKey: record.topLevelKey,
      staticStepId,
      functionStableId: record.functionStableId || null,
      ownerFnStableId: record.ownerFnStableId || null,
      staticFilePath: record.staticFilePath,
      staticFnStartLine: record.staticFnStartLine,
      storeKey: record.storeKey,
      statefulStepId: record.statefulStepId,
      resourceId: record.resourceId,
      resourceSemanticId: record.resourceSemanticId,
      resourceSemanticDetailId: record.resourceSemanticDetailId,
      requestProps: record.requestProps,
      responseProps: record.responseProps,
      decisionId: record.decisionId,
      predicateId: record.predicateId,
      branchId: record.branchId,
    };
  });
}

function hydrateRuntimeRecordAnchors(records) {
  const recordsByNodeId = new Map(
    records
      .filter((record) => record.nodeId)
      .map((record) => [record.nodeId, record]),
  );

  return records.map((record) => ({
    ...record,
    functionStableId: record.functionStableId || resolveInheritedRecordField(recordsByNodeId, record, 'functionStableId'),
    ownerFnStableId: record.ownerFnStableId || resolveInheritedRecordField(recordsByNodeId, record, 'ownerFnStableId'),
    staticFilePath: record.staticFilePath || resolveInheritedRecordField(recordsByNodeId, record, 'staticFilePath'),
    staticFnStartLine: record.staticFnStartLine ?? resolveInheritedRecordField(recordsByNodeId, record, 'staticFnStartLine'),
    decisionId: record.decisionId || resolveInheritedRecordField(recordsByNodeId, record, 'decisionId'),
    predicateId: record.predicateId || resolveInheritedRecordField(recordsByNodeId, record, 'predicateId'),
    branchId: record.branchId || resolveInheritedRecordField(recordsByNodeId, record, 'branchId'),
  }));
}

function resolveInheritedRecordField(recordsByNodeId, record, fieldName, visitedNodeIds = new Set()) {
  const parentNodeId = record.parentNodeId;
  if (!parentNodeId || visitedNodeIds.has(parentNodeId)) {
    return undefined;
  }

  const parentRecord = recordsByNodeId.get(parentNodeId);
  if (!parentRecord) {
    return undefined;
  }

  const parentValue = parentRecord[fieldName];
  if (parentValue !== undefined && parentValue !== null && parentValue !== '') {
    return parentValue;
  }

  const nextVisitedNodeIds = new Set(visitedNodeIds);
  nextVisitedNodeIds.add(parentNodeId);
  return resolveInheritedRecordField(recordsByNodeId, parentRecord, fieldName, nextVisitedNodeIds);
}

export async function findLatestRuntimeFunctionCandidate(runtimeStore) {
  return findLatestRuntimeFunctionCandidateFromRedis(assertRedisRuntimeStoreConfig(runtimeStore));
}