import fs from 'node:fs';
import path from 'node:path';

import {
  buildRuntimeLogContract,
  writeRuntimeLogContract,
} from './loggingProfileModel.js';
import { resolveSeedFunctions } from '../dev/featureSeedFunctions.mjs';
import { buildStableIdDescriptorFromRecord, buildStableIdLocation } from './stableIdModel.js';
import { buildStableIdFromCoordinates, parseStableId } from './packages/runtime-core/src/stableId.js';

const FUNCTION_FLOW_SOURCE = 'functionFlowGraph';
const WORKSPACE_ROOT = process.cwd();
const SCREENSHARE_RUNTIME_BRIDGE_SPEC = {
  startFn: {
    name: 'handleToggleGroupCallPresentation',
    pathSnippet: 'src/components/calls/group/GroupCall.tsx',
  },
  bridgeEntryFn: {
    name: 'joinGroupCallPresentation',
    pathSnippet: 'src/api/gramjs/methods/calls.ts',
  },
  bridgeExitFn: {
    name: 'apiUpdate',
    pathSnippet: 'src/global/actions/apiUpdaters/calls.async.ts',
  },
  endFn: {
    name: 'handleUpdateGroupCallConnection',
    pathSnippet: 'src/lib/secret-sauce/secretsauce.ts',
  },
};
const ALWAYS_INSTRUMENT_RUNTIME_BRIDGE_FILES = [
  'src/lib/teact/teactn.tsx',
];
const PROBE_EXCLUDED_INSTRUMENTATION_FILES = [];

function dedupeArray(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function normalizeFeatureTraceFilePath(filePath) {
  const normalizedWorkspaceRoot = WORKSPACE_ROOT.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedFilePath = String(filePath || '').replace(/\\/g, '/');
  const workspacePrefix = `${normalizedWorkspaceRoot}/`;

  if (normalizedFilePath.toLowerCase().startsWith(workspacePrefix.toLowerCase())) {
    return path.posix.relative(normalizedWorkspaceRoot, normalizedFilePath);
  }

  return normalizedFilePath;
}

function normalizeFeatureTraceStableId(stableId) {
  if (!stableId) {
    return null;
  }

  try {
    const parsedStableId = parseStableId(stableId, { allowSuffix: true });
    const normalizedStableId = buildStableIdFromCoordinates({
      filePath: normalizeFeatureTraceFilePath(parsedStableId.filePath),
      startLine: parsedStableId.startLine,
      startColumn: parsedStableId.startColumn,
      endLine: parsedStableId.endLine,
      endColumn: parsedStableId.endColumn,
    });

    return parsedStableId.suffix
      ? `${normalizedStableId}:${parsedStableId.suffix}`
      : normalizedStableId;
  } catch {
    return String(stableId);
  }
}

function normalizeFnRecord(record) {
  const stable = buildStableIdDescriptorFromRecord(record);
  return {
    stableId: stable?.value || record.stableId,
    stable,
    name: record.name || '<anonymous>',
    location: buildStableIdLocation(record),
  };
}

function normalizeGraphNode(node) {
  const stable = buildStableIdDescriptorFromRecord(node.properties || {});
  const stableId = stable?.value || node.properties?.stableId;
  const labels = node.labels || [];
  if (labels.includes('Fn')) {
    return {
      kind: 'Fn',
      stableId,
      stable,
      name: node.properties?.name || '<anonymous>',
      labels,
      location: buildStableIdLocation(node.properties || {}),
    };
  }

  return {
    kind: 'Step',
    stableId,
    stable,
    labels,
    location: buildStableIdLocation(node.properties || {}),
  };
}

function normalizeStringArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values.filter(Boolean).map((value) => String(value));
}

function buildFeatureTraceFunctionLocationKey({ repoRelativePath, startLine, startColumn, endLine, endColumn }) {
  const normalizedRepoRelativePath = normalizeFeatureTraceFilePath(repoRelativePath);
  const resolvedStartLine = Number(startLine);
  const resolvedStartColumn = Number(startColumn);
  const resolvedEndLine = Number(endLine);
  const resolvedEndColumn = Number(endColumn);

  if (!normalizedRepoRelativePath
    || !Number.isInteger(resolvedStartLine)
    || !Number.isInteger(resolvedStartColumn)
    || !Number.isInteger(resolvedEndLine)
    || !Number.isInteger(resolvedEndColumn)) {
    return null;
  }

  return [
    normalizedRepoRelativePath,
    resolvedStartLine,
    resolvedStartColumn,
    resolvedEndLine,
    resolvedEndColumn,
  ].join(':');
}

function buildFeatureTraceFunctionLocationKeyFromStableId(stableId) {
  if (!stableId) {
    return null;
  }

  try {
    const parsedStableId = parseStableId(normalizeFeatureTraceStableId(stableId), { allowSuffix: true });

    return buildFeatureTraceFunctionLocationKey({
      repoRelativePath: parsedStableId.filePath,
      startLine: parsedStableId.startLine,
      startColumn: parsedStableId.startColumn,
      endLine: parsedStableId.endLine,
      endColumn: parsedStableId.endColumn,
    });
  } catch {
    return null;
  }
}

function buildFeatureTraceFunctionStableIdsByLocation(graph) {
  const entries = {};
  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];

  for (const node of nodes) {
    if (node?.kind !== 'Fn' || !node?.stableId) {
      continue;
    }

    const normalizedStableId = normalizeFeatureTraceStableId(node.stableId);
    let key = buildFeatureTraceFunctionLocationKey({
      repoRelativePath: node?.location?.repoRelativePath,
      startLine: node?.location?.startLine,
      startColumn: node?.location?.startColumn,
      endLine: node?.location?.endLine,
      endColumn: node?.location?.endColumn,
    });

    if (!key && normalizedStableId) {
      try {
        const parsedStableId = parseStableId(normalizedStableId, { allowSuffix: true });
        key = buildFeatureTraceFunctionLocationKey({
          repoRelativePath: parsedStableId.filePath,
          startLine: parsedStableId.startLine,
          startColumn: parsedStableId.startColumn,
          endLine: parsedStableId.endLine,
          endColumn: parsedStableId.endColumn,
        });
      } catch {
        key = null;
      }
    }

    if (!key || !normalizedStableId) {
      continue;
    }

    entries[key] = normalizedStableId;
  }

  for (const edge of edges) {
    const endpointCandidates = [];

    if (edge?.fromKind === 'Fn' && edge?.fromId) {
      endpointCandidates.push(edge.fromId);
    }

    if (edge?.toKind === 'Fn' && edge?.toId) {
      endpointCandidates.push(edge.toId);
    }

    for (const endpointStableId of endpointCandidates) {
      const normalizedStableId = normalizeFeatureTraceStableId(endpointStableId);
      const key = buildFeatureTraceFunctionLocationKeyFromStableId(normalizedStableId);

      if (!key || !normalizedStableId || entries[key]) {
        continue;
      }

      entries[key] = normalizedStableId;
    }
  }

  return entries;
}

function mergeGraphs(graphs) {
  const seedIds = new Set();
  const nodeMap = new Map();
  const edgeMap = new Map();

  for (const graph of graphs.filter(Boolean)) {
    for (const seedId of graph.seedIds || []) {
      seedIds.add(seedId);
    }
    for (const node of graph.nodes || []) {
      if (node?.stableId) {
        nodeMap.set(node.stableId, node);
      }
    }
    for (const edge of graph.edges || []) {
      const edgeKey = edge.fromId && edge.toId
        ? `${edge.fromId}=>${edge.toId}`
        : JSON.stringify(edge);
      edgeMap.set(edgeKey, edge);
    }
  }

  return {
    seedIds: [...seedIds],
    nodes: [...nodeMap.values()],
    edges: [...edgeMap.values()],
  };
}

function collectGraphNodes(payload) {
  const directNodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
  const pathNodes = Array.isArray(payload?.path?.nodes) ? payload.path.nodes : [];
  const segmentNodes = Object.values(payload?.segments || {}).flatMap((segment) => (
    Array.isArray(segment?.nodes) ? segment.nodes : []
  ));

  return [...directNodes, ...pathNodes, ...segmentNodes];
}

export function readGraphFromJson(graphJsonPath) {
  const parsed = JSON.parse(fs.readFileSync(graphJsonPath, 'utf8'));

  return {
    seedIds: [],
    nodes: dedupeArray(collectGraphNodes(parsed)),
    edges: Array.isArray(parsed?.edges) ? parsed.edges : Array.isArray(parsed?.path?.edges) ? parsed.path.edges : [],
  };
}

function readRuntimeBridgeGraphFromJson(graphJsonPath) {
  if (!graphJsonPath || !fs.existsSync(graphJsonPath)) {
    return undefined;
  }

  const parsed = JSON.parse(fs.readFileSync(graphJsonPath, 'utf8'));
  const nodes = dedupeArray(collectGraphNodes(parsed));
  if (!nodes.length) {
    return undefined;
  }

  return {
    seedIds: [
      parsed?.startFn?.stableId,
      parsed?.bridgeEntryFn?.stableId,
      parsed?.bridgeExitFn?.stableId,
      parsed?.endFn?.stableId,
    ].filter(Boolean),
    nodes,
    edges: [],
  };
}

async function queryFunctionByNameAndPath(session, { name, pathSnippet }) {
  const result = await session.run(
    `
      MATCH (fn:Fn)
      WHERE fn.name = $name AND fn.stableId CONTAINS $pathSnippet
      RETURN fn.stableId AS stableId, fn.name AS name
      ORDER BY fn.stableId
      LIMIT 1
    `,
    { name, pathSnippet },
  );
  const row = result.records[0];
  if (!row) {
    throw new Error(`Function was not found in graph: ${name} (${pathSnippet})`);
  }

  return normalizeFnRecord({
    stableId: row.get('stableId'),
    name: row.get('name'),
  });
}

async function queryShortestPath(session, startFnStableId, endFnStableId) {
  const result = await session.run(
    `
      MATCH (start:Fn {stableId: $startFnStableId}), (finish:Fn {stableId: $endFnStableId})
      MATCH path = shortestPath((start)-[:NEXT|TRUE|FALSE|OPTION_CASE|OPTION_DEFAULT|MERGES_TO*]->(finish))
      WHERE all(rel IN relationships(path) WHERE rel.source = $source)
      RETURN nodes(path) AS nodes, relationships(path) AS rels
    `,
    {
      startFnStableId,
      endFnStableId,
      source: FUNCTION_FLOW_SOURCE,
    },
  );
  const record = result.records[0];
  if (!record) {
    return undefined;
  }

  const nodes = record.get('nodes').map((node) => normalizeGraphNode(node));
  const rels = record.get('rels').map((rel, index) => ({
    id: `${startFnStableId}:${endFnStableId}:${index}`,
    type: rel.type,
    source: rel.properties?.source,
  }));

  return { nodes, rels };
}

async function deriveRuntimeBridgeGraphFromSession(session, args) {
  if (args.mode !== 'screenshare' || args.includeRuntimeBridge === false) {
    return undefined;
  }

  try {
    const startFn = await queryFunctionByNameAndPath(session, SCREENSHARE_RUNTIME_BRIDGE_SPEC.startFn);
    const bridgeEntryFn = await queryFunctionByNameAndPath(session, SCREENSHARE_RUNTIME_BRIDGE_SPEC.bridgeEntryFn);
    const bridgeExitFn = await queryFunctionByNameAndPath(session, SCREENSHARE_RUNTIME_BRIDGE_SPEC.bridgeExitFn);
    const endFn = await queryFunctionByNameAndPath(session, SCREENSHARE_RUNTIME_BRIDGE_SPEC.endFn);

    const headSegment = await queryShortestPath(session, startFn.stableId, bridgeEntryFn.stableId);
    const tailSegment = await queryShortestPath(session, bridgeExitFn.stableId, endFn.stableId);
    if (!headSegment || !tailSegment) {
      return readRuntimeBridgeGraphFromJson();
    }

    return {
      seedIds: [startFn.stableId, bridgeEntryFn.stableId, bridgeExitFn.stableId, endFn.stableId],
      nodes: [...headSegment.nodes, bridgeExitFn, ...tailSegment.nodes],
      edges: [...headSegment.rels, ...tailSegment.rels],
    };
  } catch {
    return readRuntimeBridgeGraphFromJson();
  }
}

async function queryFeatureClosureEdges(session, frontierIds, includeCallers) {
  if (!frontierIds.length) {
    return [];
  }

  const result = await session.run(
    `
      MATCH (caller:Fn)-[:NEXT {source: $source}]->(start:Step {source: $source})
      OPTIONAL MATCH path = (start)-[:NEXT|TRUE|FALSE|OPTION_CASE|OPTION_DEFAULT|MERGES_TO*0..]->(reachable:Step {source: $source})
      WITH caller, [node IN collect(DISTINCT start) + collect(DISTINCT reachable) WHERE node IS NOT NULL] AS rawSteps
      UNWIND rawSteps AS step
      WITH DISTINCT caller, step
      MATCH (step)-[rel]->(callee:Fn)
      WHERE rel.source = $source
        AND (
          caller.stableId IN $frontierIds
          OR ($includeCallers AND callee.stableId IN $frontierIds)
        )
      RETURN DISTINCT
        caller.stableId AS fromId,
        caller.name AS fromName,
        callee.stableId AS toId,
        callee.name AS toName,
        step.stableId AS stepStableId,
        type(rel) AS edgeType,
        rel.role AS edgeRole,
        coalesce(rel.call_text_raw, step.operation_callee_text, step.action_text_raw, step.label, step.operation_subject_text) AS callText
      ORDER BY fromId, toId, stepStableId
    `,
    { frontierIds, includeCallers, source: FUNCTION_FLOW_SOURCE },
  );

  return result.records.map((row) => ({
    fromId: row.get('fromId'),
    fromName: row.get('fromName'),
    toId: row.get('toId'),
    toName: row.get('toName'),
    stepStableId: row.get('stepStableId'),
    edgeType: row.get('edgeType'),
    edgeRole: row.get('edgeRole'),
    callText: row.get('callText'),
  }));
}

function upsertFeatureNode(nodeMap, stableId, name, seedIds) {
  const existing = nodeMap.get(stableId);
  if (existing) {
    return existing;
  }

  const node = normalizeFnRecord({ stableId, name });
  node.isSeed = seedIds.has(stableId);
  nodeMap.set(stableId, node);
  return node;
}

function canAddFeatureNode(nodeMap, stableId, maxNodes) {
  return nodeMap.has(stableId) || nodeMap.size < maxNodes;
}

async function buildFullFeatureGraph(session, seedFunctions, options) {
  const seedIds = new Set(seedFunctions.map((fn) => fn.stableId));
  const nodeMap = new Map(seedFunctions.map((fn) => [
    fn.stableId,
    { ...fn, isSeed: true },
  ]));
  const edgeMap = new Map();
  const maxHops = Number.isFinite(options.hops) && options.hops > 0 ? options.hops : undefined;

  let frontierIds = [...seedIds];
  let depth = 0;
  let truncated = false;

  while (frontierIds.length) {
    if (maxHops && depth >= maxHops) {
      truncated = true;
      break;
    }

    const edgeRows = await queryFeatureClosureEdges(session, frontierIds, options.includeCallers);
    const nextFrontier = new Set();

    for (const row of edgeRows) {
      if (!row?.fromId || !row?.toId) {
        continue;
      }

      if (edgeMap.size >= options.maxEdges) {
        truncated = true;
        break;
      }
      if (!canAddFeatureNode(nodeMap, row.fromId, options.maxNodes) || !canAddFeatureNode(nodeMap, row.toId, options.maxNodes)) {
        truncated = true;
        continue;
      }

      const fromNode = upsertFeatureNode(nodeMap, row.fromId, row.fromName, seedIds);
      const toNode = upsertFeatureNode(nodeMap, row.toId, row.toName, seedIds);
      const edgeKey = `${row.fromId}=>${row.toId}`;
      const existingEdge = edgeMap.get(edgeKey) || {
        fromId: row.fromId,
        toId: row.toId,
        edgeTypes: new Set(),
        edgeRoles: new Set(),
        callTexts: new Set(),
        stepStableIds: new Set(),
      };

      if (row.edgeType) {
        existingEdge.edgeTypes.add(row.edgeType);
      }
      if (row.edgeRole) {
        existingEdge.edgeRoles.add(row.edgeRole);
      }
      if (row.callText) {
        existingEdge.callTexts.add(row.callText);
      }
      if (row.stepStableId) {
        existingEdge.stepStableIds.add(row.stepStableId);
      }
      edgeMap.set(edgeKey, existingEdge);

      if (!seedIds.has(fromNode.stableId) && !frontierIds.includes(fromNode.stableId)) {
        nextFrontier.add(fromNode.stableId);
      }
      if (!seedIds.has(toNode.stableId) && !frontierIds.includes(toNode.stableId)) {
        nextFrontier.add(toNode.stableId);
      }
    }

    frontierIds = [...nextFrontier].filter((stableId) => !nodeMap.get(stableId)?.visited);
    frontierIds.forEach((stableId) => {
      const node = nodeMap.get(stableId);
      if (node) {
        node.visited = true;
      }
    });
    depth += 1;

    if (edgeMap.size >= options.maxEdges || nodeMap.size >= options.maxNodes) {
      truncated = true;
      break;
    }
  }

  return {
    seedIds: [...seedIds],
    nodes: [...nodeMap.values()].map((node) => {
      delete node.visited;
      return node;
    }),
    edges: [...edgeMap.values()].map((edge) => ({
      fromId: edge.fromId,
      toId: edge.toId,
      edgeTypes: [...edge.edgeTypes].sort(),
      edgeRoles: [...edge.edgeRoles].sort(),
      callTexts: [...edge.callTexts].sort(),
      stepStableIds: [...edge.stepStableIds].sort(),
    })),
    truncated,
  };
}

async function queryLoggingUsefulNodes(session, functionStableIds) {
  const stableIds = dedupeArray(functionStableIds);
  if (!stableIds.length) {
    return [];
  }

  const result = await session.run(
    `
      MATCH (node:LoggingUseful)
      WHERE ('Fn' IN labels(node) AND node.stableId IN $stableIds)
         OR ('Step' IN labels(node) AND node.parentFnStableId IN $stableIds)
      RETURN
        labels(node) AS labels,
        node.stableId AS stableId,
        node.parentFnStableId AS parentStableId,
        node.name AS name,
        node.label AS label,
        node.repo_relative_path AS repoRelativePath,
        node.logging_useful_kinds AS loggingUsefulKinds,
        node.logging_useful_reasons AS loggingUsefulReasons,
        node.runtime_loggable AS runtimeLoggable,
        node.runtime_loggable_kinds AS runtimeLoggableKinds
    `,
    { stableIds },
  );

  return result.records.map((row) => {
    const stableId = row.get('stableId');
    const repoRelativePath = row.get('repoRelativePath') || buildStableIdLocation({ stableId })?.repoRelativePath;
    return {
      labels: normalizeStringArray(row.get('labels')),
      stableId,
      parentStableId: row.get('parentStableId'),
      name: row.get('name'),
      label: row.get('label'),
      repoRelativePath,
      loggingUsefulKinds: normalizeStringArray(row.get('loggingUsefulKinds')),
      loggingUsefulReasons: normalizeStringArray(row.get('loggingUsefulReasons')),
      runtimeLoggable: Boolean(row.get('runtimeLoggable')),
      runtimeLoggableKinds: normalizeStringArray(row.get('runtimeLoggableKinds')),
    };
  });
}

function buildDerivedIncludeSet(baseInclude, graph) {
  const graphFiles = graph.nodes
    .map((node) => node.location?.repoRelativePath)
    .filter((repoRelativePath) => repoRelativePath && repoRelativePath.startsWith('src/'));

  return dedupeArray([
    ...baseInclude,
    ...graphFiles,
  ]).sort();
}

function buildInstrumentationTargetIncludeSet(baseInclude, graph, instrumentationTargetNodes) {
  const usefulFiles = (instrumentationTargetNodes || [])
    .map((node) => node.repoRelativePath)
    .filter((repoRelativePath) => repoRelativePath && repoRelativePath.startsWith('src/'));

  if (!usefulFiles.length) {
    return dedupeArray([
      ...buildDerivedIncludeSet(baseInclude, graph),
      ...ALWAYS_INSTRUMENT_RUNTIME_BRIDGE_FILES,
    ]).filter((repoRelativePath) => !PROBE_EXCLUDED_INSTRUMENTATION_FILES.includes(repoRelativePath)).sort();
  }

  return dedupeArray([
    ...baseInclude,
    ...usefulFiles,
    ...ALWAYS_INSTRUMENT_RUNTIME_BRIDGE_FILES,
  ]).filter((repoRelativePath) => !PROBE_EXCLUDED_INSTRUMENTATION_FILES.includes(repoRelativePath)).sort();
}

export function buildDerivedGraphLoggingRequest({
  graphName,
  graph,
  instrumentationTargetNodes = [],
  loggingUsefulNodes = [],
  bridgeFiles = [],
  sessionId,
}) {
  const resolvedInstrumentationTargetNodes = instrumentationTargetNodes.length
    ? instrumentationTargetNodes
    : loggingUsefulNodes;
  const instrumentationInclude = [];
  const featureTraceHeadStableIds = dedupeArray((graph?.seedIds || [])
    .map((stableId) => normalizeFeatureTraceStableId(stableId)));
  const featureTraceAllowedStableIds = dedupeArray((graph?.nodes || [])
    .filter((node) => node?.kind === 'Fn' && node?.stableId)
    .map((node) => normalizeFeatureTraceStableId(node.stableId)));
  const functionStableIdsByLocation = buildFeatureTraceFunctionStableIdsByLocation(graph);
  const config = {
    loggingEnabled: true,
    runtimeProfile: 'static-replay-minimal',
    runtimeRequireExplicitSession: true,
    sessionId,
    instrumentationInclude,
    featureTrace: {
      featureKey: graphName || 'feature',
      headStableIds: featureTraceHeadStableIds,
      allowedStableIds: featureTraceAllowedStableIds,
      functionStableIdsByLocation,
      bridgeFiles: dedupeArray(bridgeFiles),
    },
    deferManualScreenShareStartup: false,
  };
  config.runtimeLogContract = buildRuntimeLogContract(config);

  return {
    config,
  };
}

export async function deriveGraphLoggingProfileFromSession({ session, args }) {
  const seedFunctions = await resolveSeedFunctions(session, args);
  if (!seedFunctions.length) {
    throw new Error('No seed functions were found in Neo4j.');
  }

  const graph = await buildFullFeatureGraph(session, seedFunctions, {
    ...args,
  });
  if (!graph.nodes.length) {
    throw new Error('Derived graph is empty.');
  }

  const runtimeBridgeGraph = await deriveRuntimeBridgeGraphFromSession(session, args);
  const mergedGraph = mergeGraphs([graph, runtimeBridgeGraph]);
  const loggingUsefulNodes = await queryLoggingUsefulNodes(
    session,
    mergedGraph.nodes.map((node) => node.stableId),
  );

  return {
    graph: mergedGraph,
    runtimeBridgeGraph,
    seedFunctions,
    loggingUsefulNodes,
  };
}

export function buildDerivedGraphLoggingPayload({
  request,
  env,
  graph,
  seedFunctions,
  graphJsonPath,
  runtimeBridgeGraph,
  instrumentationTargetNodes,
}) {
  return {
    request,
    env,
    seedFunctions: (seedFunctions || []).map((seed) => ({
      stableId: seed.stableId,
      name: seed.name,
      repoRelativePath: seed.location?.repoRelativePath,
    })),
    graph: {
      seedCount: graph.seedIds.length,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      graphJsonPath: graphJsonPath || null,
      runtimeBridgeIncluded: Boolean(runtimeBridgeGraph),
      runtimeBridgeNodeCount: runtimeBridgeGraph?.nodes?.length || 0,
      instrumentationTargetNodeCount: instrumentationTargetNodes?.length || 0,
      truncated: Boolean(graph.truncated),
    },
  };
}

export function buildDerivedGraphLoggingEnvPayload({
  graphName,
  graph,
  seedFunctions = [],
  graphJsonPath,
  runtimeBridgeGraph,
  instrumentationTargetNodes = [],
  loggingUsefulNodes = [],
  bridgeFiles = [],
  sessionId,
}) {
  const resolvedInstrumentationTargetNodes = instrumentationTargetNodes.length
    ? instrumentationTargetNodes
    : loggingUsefulNodes;
  const request = buildDerivedGraphLoggingRequest({
    graphName,
    graph,
    instrumentationTargetNodes: resolvedInstrumentationTargetNodes,
    bridgeFiles,
    sessionId,
  });
  const config = request.config;
  writeRuntimeLogContract(config);
  const env = {
    GRAPH_LOGGING_ENABLED: config.loggingEnabled ? '1' : '0',
    RUNTIME_PROFILE: config.runtimeProfile,
  };

  return {
    ...buildDerivedGraphLoggingPayload({
      request,
      env,
      graph,
      seedFunctions,
      graphJsonPath,
      runtimeBridgeGraph,
      instrumentationTargetNodes: resolvedInstrumentationTargetNodes,
    }),
    resolvedConfig: config,
  };
}