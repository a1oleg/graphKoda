import { buildDerivedGraphLoggingEnvPayload } from '../../../../derivedLoggingProfile.js';
import { resolveFunctionActualCoordinates } from './gatewayForALL.js';

const FEATURE_RUNTIME_CHAIN_PARAMETER_NAMES = [
  'nodeid',
  'parentNodeid',
  'sessionId',
  'correlationId',
  'boundaryPairId',
  'userActionRootId',
  'ownerFnStableId',
  'staticStepId',
  'statefulStepId',
];

const FEATURE_RUNTIME_BRIDGE_FILES = [
  'src/api/gramjs/worker/connector.ts',
  'src/api/gramjs/worker/worker.ts',
  'src/lib/teact/teactn.tsx',
  'src/util/browser/multitab.ts',
  'src/api/gramjs/methods/init.ts',
  'src/api/gramjs/updates/apiUpdateEmitter.ts',
  'src/api/gramjs/updates/updateManager.ts',
];

function collectBackboneFunctionNodes(reproPayload) {
  const nodesByStableId = new Map();

  for (const node of reproPayload?.backboneFunctionNodes || []) {
    if (node?.stableId) {
      nodesByStableId.set(node.stableId, node);
    }
  }

  if (nodesByStableId.size) {
    return [...nodesByStableId.values()];
  }

  const fallbackNodes = [
    reproPayload?.head && {
      kind: 'Fn',
      name: reproPayload.head.name,
      label: reproPayload.head.name,
      repoRelativePath: reproPayload.head.repoRelativePath,
      line: reproPayload.head.line,
      startLine: reproPayload.head.line,
    },
    ...(Array.isArray(reproPayload?.tails)
      ? reproPayload.tails.map((tail) => ({
        kind: 'Fn',
        name: tail?.name,
        label: tail?.name,
        repoRelativePath: tail?.repoRelativePath,
        line: tail?.line,
        startLine: tail?.line,
      }))
      : []),
  ].filter((node) => node?.name && node?.repoRelativePath);

  if (fallbackNodes.length) {
    return fallbackNodes;
  }

  for (const pathItem of reproPayload?.paths || []) {
    for (const node of pathItem?.nodes || []) {
      if (node?.kind === 'Fn' && node?.stableId) {
        nodesByStableId.set(node.stableId, node);
      }
    }
  }

  return [...nodesByStableId.values()];
}

function applyResolvedCoordinatesToNode(node, resolution) {
  if (!resolution?.found || !resolution?.stableId) {
    return node;
  }

  return {
    ...node,
    stableId: resolution.stableId,
    stable: resolution.stable,
    repoRelativePath: resolution.repoRelativePath,
    startLine: resolution.startLine,
    startColumn: resolution.startColumn,
    endLine: resolution.endLine,
    endColumn: resolution.endColumn,
  };
}

export async function resolveFeatureLoggingPayload(driver, database, reproPayload, { repairGraph = true } = {}) {
  const backboneFunctionNodes = collectBackboneFunctionNodes(reproPayload);
  const requiresCoordinateResolution = backboneFunctionNodes.some((node) => node?.kind === 'Fn' && !node?.stableId);

  if (!requiresCoordinateResolution) {
    return {
      ...reproPayload,
      backboneFunctionNodes,
    };
  }

  const resolvedBackboneFunctionNodes = [];

  for (const node of backboneFunctionNodes) {
    if (node?.kind !== 'Fn' || !node?.name) {
      resolvedBackboneFunctionNodes.push(node);
      continue;
    }

    const resolution = await resolveFunctionActualCoordinates(driver, database, {
      stableId: node.stableId,
      name: node.name,
      repoRelativePath: node.repoRelativePath,
      line: node.line,
      startLine: node.startLine,
      startColumn: node.startColumn,
      endLine: node.endLine,
      endColumn: node.endColumn,
      repairGraph: repairGraph && Boolean(node.stableId),
    });

    resolvedBackboneFunctionNodes.push(applyResolvedCoordinatesToNode(node, resolution));
  }

  return {
    ...reproPayload,
    backboneFunctionNodes: resolvedBackboneFunctionNodes,
  };
}

function buildFeatureLoggingGraph(reproPayload) {
  const nodesByStableId = new Map();

  for (const node of reproPayload?.backboneFunctionNodes || []) {
    if (node?.stableId) {
      nodesByStableId.set(node.stableId, node);
    }
  }

  for (const pathItem of reproPayload?.paths || []) {
    for (const node of pathItem?.nodes || []) {
      if (node?.stableId) {
        nodesByStableId.set(node.stableId, node);
      }
    }
  }

  return {
    seedIds: [reproPayload?.feature?.stableId].filter(Boolean),
    nodes: [...nodesByStableId.values()],
    edges: [],
  };
}

export function countFeatureInstrumentationTargets(reproPayload) {
  return collectBackboneFunctionNodes(reproPayload).length;
}

export function buildDerivedFeatureLoggingProfile(reproPayload, { sessionId } = {}) {
  const graph = buildFeatureLoggingGraph(reproPayload);
  const backboneFunctionNodes = collectBackboneFunctionNodes(reproPayload);

  return buildDerivedGraphLoggingEnvPayload({
    graphName: reproPayload?.feature?.key || reproPayload?.feature?.name || 'feature',
    graph,
    instrumentationTargetNodes: backboneFunctionNodes,
    bridgeFiles: FEATURE_RUNTIME_BRIDGE_FILES,
    sessionId,
    seedFunctions: reproPayload?.feature?.stableId ? [{
      stableId: reproPayload.feature.stableId,
      stable: reproPayload.feature.stable,
      name: reproPayload?.feature?.name || reproPayload?.feature?.label || '<anonymous>',
      location: {
        repoRelativePath: reproPayload?.feature?.repoRelativePath || undefined,
      },
    }] : [],
  });
}

