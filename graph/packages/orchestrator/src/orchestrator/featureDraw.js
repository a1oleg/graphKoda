import fs from 'node:fs';
import path from 'node:path';

import {
  fetchRuntimeEventRecords,
  loadRuntimeChainSummary,
} from '../../../runtime-relay/src/runtimeEvents.js';
import { withRuntimeRedisSession } from '../../../runtime-relay/src/runtimeRedis.js';
import { buildStableIdFromCoordinates, parseStableId } from '../../../runtime-core/src/stableId.js';
import { resolveFeaturePrimaryFunctionSetPath, resolveFeatureRequestedStableIdsPath as resolveFallbackRequestedStableIdsPath } from './featureRestore.js';

const FLOW_X_GAP = 280;
const FLOW_Y_GAP = 160;
const FLOW_ORIGIN_X = 20;
const FLOW_ORIGIN_Y = 80;
const FN_ROOT_X = 20;
const FN_ROOT_Y = 100;
const FN_TARGET_X_GAP = 360;
const LANE_WIDTH = 320;
const LANE_GAP = 32;
const LANE_TOP_Y = 90;
const LANE_HEADER_HEIGHT = 40;
const LANE_NODE_TOP_Y = 150;
const FEATURE_DRAW_MODE_RUNTIME_CHAIN = 'runtime-chain';
const FEATURE_DRAW_MODE_GRAPH_PATH = 'graph-path';
const FEATURE_RUNTIME_DRAW_ANCHOR_WINDOW_MS = 2 * 60 * 1000;
const FEATURE_RUNTIME_DRAW_EVENT_LIMIT = 3;

const PRIMARY_LANE_ORDER = [
  'UIIntent',
  'ProjectionSelect',
  'ProcessOrchestrator',
  'APIBridge',
  'BrowserMedia',
  'WebRTCRuntime',
  'TelegramBackend',
  'MediaEngine',
];

const PRIMARY_LANE_TITLES = {
  UIIntent: 'UI Intent',
  ProjectionSelect: 'Projection Select',
  ProcessOrchestrator: 'Process Orchestrator',
  APIBridge: 'API Bridge',
  BrowserMedia: 'Browser Media',
  WebRTCRuntime: 'WebRTC Runtime',
  TelegramBackend: 'Telegram Backend',
  MediaEngine: 'Media Engine',
  Unassigned: 'Unassigned',
};

function sanitizeFileName(text) {
  const sanitized = String(text || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'feature-render';
}

function writeTextFile(filePath, content) {
  const directoryPath = path.dirname(filePath);
  fs.mkdirSync(directoryPath, { recursive: true });
  fs.writeFileSync(filePath, `${content}\n`, 'utf8');
}

function buildDefaultFeatureDrawPath(feature, suffix = 'draw') {
  const featureSlug = sanitizeFileName(`${feature?.key || feature?.name || feature?.stableId || 'feature'}-${suffix}`);
  return path.resolve(process.cwd(), 'graph', 'draw', `${featureSlug}.drawio`);
}

function buildFeatureDrawMessage(code, severity, message) {
  return { code, severity, message };
}

function getFeatureDrawMessagesText(messages) {
  return (messages || [])
    .map(({ severity, code, message }) => `${severity}: ${code} - ${message}`)
    .join(' | ');
}

function classifyFeatureDrawError(error, feature, pathSet) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.toLowerCase().includes('feature selectors must resolve')) {
    return [buildFeatureDrawMessage(
      'FEATURE_SELECTOR_UNRESOLVED',
      'error',
      'Feature head/tail selectors are unresolved, so the feature draw cannot be rendered.',
    )];
  }

  return [buildFeatureDrawMessage('FEATURE_DRAW_FAILED', 'error', message)];
}

function buildFeatureDrawFailureResult(feature, {
  error,
  pathCount = 0,
  payload = null,
  messages = [],
}) {
  const resolvedMessages = messages.length
    ? messages
    : [buildFeatureDrawMessage('FEATURE_DRAW_FAILED', 'error', error || 'Feature draw failed.')];

  return {
    available: false,
    error: error || resolvedMessages[0]?.message || 'Feature draw failed.',
    feature: feature || null,
    saved: false,
    filePath: null,
    format: null,
    pathCount,
    nodeCount: 0,
    edgeCount: 0,
    drawioXml: null,
    messages: resolvedMessages,
    payload,
  };
}

function buildTailDrawSuffix(tailStableId) {
  return sanitizeFileName(`${getShortStableSuffix(tailStableId)}-draw`);
}

function resolveFeatureRequestedStableIdsPath(featureJsonPath) {
  if (!featureJsonPath) {
    return null;
  }

  const staticDrawStableIdsPath = resolveFeaturePrimaryFunctionSetPath(featureJsonPath);
  if (fs.existsSync(staticDrawStableIdsPath)) {
    return staticDrawStableIdsPath;
  }

  const babelConfigPath = resolveFallbackRequestedStableIdsPath(featureJsonPath).replace(/\.requested14\.stableIds\.json$/i, '.functions.babel.json');

  if (fs.existsSync(babelConfigPath)) {
    return babelConfigPath;
  }

  return resolveFallbackRequestedStableIdsPath(featureJsonPath);
}

function normalizeRuntimeSeedStableId(stableId) {
  if (!stableId) {
    return null;
  }

  try {
    const parsed = parseStableId(stableId, { allowSuffix: true });
    const filePath = String(parsed.filePath || '').replace(/\\/g, '/');
    const normalizedRoot = process.cwd().replace(/\\/g, '/').replace(/\/$/, '');
    const repoRelativePath = normalizedRoot && filePath.startsWith(`${normalizedRoot}/`)
      ? filePath.slice(normalizedRoot.length + 1)
      : filePath;
    const normalized = buildStableIdFromCoordinates({
      filePath: repoRelativePath,
      startLine: parsed.startLine,
      startColumn: parsed.startColumn,
      endLine: parsed.endLine,
      endColumn: parsed.endColumn,
    });

    return parsed.suffix ? `${normalized}:${parsed.suffix}` : normalized;
  } catch {
    return String(stableId);
  }
}

function buildRuntimeSeedLocation(stableId) {
  try {
    const parsed = parseStableId(stableId, { allowSuffix: true });
    const filePath = String(parsed.filePath || '').replace(/\\/g, '/');
    const normalizedRoot = process.cwd().replace(/\\/g, '/').replace(/\/$/, '');
    const repoRelativePath = normalizedRoot && filePath.startsWith(`${normalizedRoot}/`)
      ? filePath.slice(normalizedRoot.length + 1)
      : filePath;

    return {
      repoRelativePath,
      startLine: parsed.startLine,
      startColumn: parsed.startColumn,
      endLine: parsed.endLine,
      endColumn: parsed.endColumn,
    };
  } catch {
    return undefined;
  }
}

function buildFunctionMetadataByStableId(payload) {
  const metadataByStableId = new Map();
  const rawMetadataByLocation = payload?.functionMetadataByLocation && typeof payload.functionMetadataByLocation === 'object'
    ? payload.functionMetadataByLocation
    : payload?.functionStableIdsByLocation && typeof payload.functionStableIdsByLocation === 'object'
      ? Object.fromEntries(Object.entries(payload.functionStableIdsByLocation).map(([locationKey, stableId]) => [locationKey, { stableId }]))
      : {};

  Object.values(rawMetadataByLocation).forEach((metadata) => {
    const normalizedStableId = normalizeRuntimeSeedStableId(typeof metadata === 'string' ? metadata : metadata?.stableId);
    if (!normalizedStableId) {
      return;
    }

    metadataByStableId.set(normalizedStableId, {
      stableId: normalizedStableId,
      layer: typeof metadata === 'string' ? undefined : metadata?.layer,
      labels: typeof metadata === 'string' || !Array.isArray(metadata?.labels) ? [] : metadata.labels,
      name: typeof metadata === 'string' ? undefined : metadata?.name,
      location: buildRuntimeSeedLocation(normalizedStableId),
      isExternal: String(normalizedStableId).startsWith('external:'),
    });
  });

  return metadataByStableId;
}

function buildRuntimeSeedGraph(feature, { featureJsonPath } = {}) {
  const nodesById = new Map();
  const requestedStableIdsPath = resolveFeatureRequestedStableIdsPath(featureJsonPath);
  const payload = requestedStableIdsPath && fs.existsSync(requestedStableIdsPath)
    ? JSON.parse(fs.readFileSync(requestedStableIdsPath, 'utf8'))
    : null;
  const functionMetadataByStableId = buildFunctionMetadataByStableId(payload);

  const payloadItems = Array.isArray(payload?.functions)
    ? payload.functions
    : Array.isArray(payload?.items)
      ? payload.items
      : [];

  const requestedNodes = payloadItems.length
    ? payloadItems.map((item) => ({
      stableId: normalizeRuntimeSeedStableId(item?.stableId),
      name: item?.name || item?.requestedName || '<anonymous>',
      isExternal: String(item?.stableId || '').startsWith('external:'),
      layer: item?.layer,
      labels: Array.isArray(item?.labels) ? item.labels : [],
      location: buildRuntimeSeedLocation(item?.stableId),
    }))
    : [];

  const fallbackNodes = [
    {
      stableId: normalizeRuntimeSeedStableId(feature?.stableId),
      name: feature?.name || feature?.label || '<anonymous>',
      isExternal: false,
      location: buildRuntimeSeedLocation(feature?.stableId),
    },
    ...((feature?.endFnStableIds || []).map((stableId) => ({
      stableId: normalizeRuntimeSeedStableId(stableId),
      name: '<anonymous>',
      isExternal: String(stableId || '').startsWith('external:'),
      location: buildRuntimeSeedLocation(stableId),
    }))),
  ];

  for (const node of (requestedNodes.length ? requestedNodes : fallbackNodes)) {
    if (!node?.stableId) {
      continue;
    }

    nodesById.set(node.stableId, {
      stableId: node.stableId,
      name: node.name,
      layer: node.layer,
      labels: [...(node.labels || [])],
      location: node.location,
      isRoot: node.stableId === normalizeRuntimeSeedStableId(feature?.stableId),
      isTarget: (feature?.endFnStableIds || []).map((value) => normalizeRuntimeSeedStableId(value)).includes(node.stableId),
      isExternal: Boolean(node.isExternal),
    });
  }

  const graph = finalizeFeatureGraph(feature, [...nodesById.values()], []);
  graph.functionMetadataByStableId = functionMetadataByStableId;

  return graph;
}

function escapeXml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#xa;');
}

function shorten(text, maxLength = 60) {
  if (!text) {
    return '';
  }

  const normalized = String(text).replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function getShortStableSuffix(stableId) {
  const parts = String(stableId || '').split(':');
  return parts.length >= 5 ? parts.slice(-4).join(':') : String(stableId || '');
}

function buildRootLabel(root) {
  return `Fn&#xa;${escapeXml(root.name || '<anonymous>')}()&#xa;${escapeXml(getShortStableSuffix(root.stableId))}`;
}

function buildFlowLabel(node) {
  const kindLabel = node.isExternal ? 'External' : 'Fn';
  return `${kindLabel}&#xa;${escapeXml(node.name || '<anonymous>')}()&#xa;${escapeXml(getShortStableSuffix(node.stableId))}`;
}

function buildTargetFnLabel(fn) {
  const kindLabel = fn.isExternal ? 'External' : 'Fn';
  return `${kindLabel}&#xa;${escapeXml(fn.name || '<anonymous>')}()&#xa;${escapeXml(getShortStableSuffix(fn.stableId))}`;
}

function getPrimaryLaneLabel(node) {
  const labelFromNodeLabels = PRIMARY_LANE_ORDER.find((label) => node?.labels?.includes(label));
  if (labelFromNodeLabels) {
    return labelFromNodeLabels;
  }

  const normalizedLayer = String(node?.layer || '').replace(/\s+/g, ' ').trim();
  return Object.entries(PRIMARY_LANE_TITLES).find(([, title]) => title === normalizedLayer)?.[0] || 'Unassigned';
}

function getPrimaryLaneTitle(laneLabel) {
  return PRIMARY_LANE_TITLES[laneLabel] || laneLabel;
}

function getRepresentedLaneLabels(nodes) {
  const seen = new Set();
  const represented = [];

  (nodes || []).forEach((node) => {
    const laneLabel = getPrimaryLaneLabel(node);
    if (seen.has(laneLabel)) {
      return;
    }

    seen.add(laneLabel);
    represented.push(laneLabel);
  });

  return represented.sort((left, right) => {
    const leftIndex = PRIMARY_LANE_ORDER.indexOf(left);
    const rightIndex = PRIMARY_LANE_ORDER.indexOf(right);
    const normalizedLeftIndex = leftIndex >= 0 ? leftIndex : Number.MAX_SAFE_INTEGER;
    const normalizedRightIndex = rightIndex >= 0 ? rightIndex : Number.MAX_SAFE_INTEGER;
    return normalizedLeftIndex - normalizedRightIndex || left.localeCompare(right);
  });
}

function buildNodeDepths(rootStableId, nodes, edges) {
  const outgoingById = new Map();
  edges.forEach((edge) => {
    const children = outgoingById.get(edge.fromId) || [];
    children.push(edge.toId);
    outgoingById.set(edge.fromId, children);
  });

  const depthById = new Map();
  const queue = [];

  if (rootStableId) {
    depthById.set(rootStableId, 0);
    queue.push(rootStableId);
  }

  while (queue.length) {
    const sourceId = queue.shift();
    const nextDepth = (depthById.get(sourceId) || 0) + 1;

    (outgoingById.get(sourceId) || []).forEach((targetId) => {
      if (depthById.has(targetId)) {
        return;
      }

      depthById.set(targetId, nextDepth);
      queue.push(targetId);
    });
  }

  let fallbackDepth = Math.max(...depthById.values(), 0);
  [...(nodes || [])]
    .sort((left, right) => String(left?.stableId || '').localeCompare(String(right?.stableId || '')))
    .forEach((node) => {
      if (!node?.stableId || depthById.has(node.stableId)) {
        return;
      }

      fallbackDepth += 1;
      depthById.set(node.stableId, fallbackDepth);
    });

  return depthById;
}

function buildLaneNodeRows(graph) {
  const nodes = [graph.root, ...graph.flowNodes, ...graph.targetFns].filter(Boolean);
  const depthById = buildNodeDepths(graph.root?.stableId, nodes, graph.edges);
  const occupiedRowsByLane = new Map();
  const rowByNodeId = new Map();
  let maxRow = 0;

  [...nodes].sort((left, right) => {
    if (left.stableId === graph.root?.stableId) {
      return -1;
    }
    if (right.stableId === graph.root?.stableId) {
      return 1;
    }

    const leftDepth = depthById.get(left.stableId) || 0;
    const rightDepth = depthById.get(right.stableId) || 0;
    const leftLane = getPrimaryLaneLabel(left);
    const rightLane = getPrimaryLaneLabel(right);
    return leftDepth - rightDepth
      || PRIMARY_LANE_ORDER.indexOf(leftLane) - PRIMARY_LANE_ORDER.indexOf(rightLane)
      || left.stableId.localeCompare(right.stableId);
  }).forEach((node) => {
    const laneLabel = getPrimaryLaneLabel(node);
    const occupiedRows = occupiedRowsByLane.get(laneLabel) || new Set();
    let row = depthById.get(node.stableId) || 0;
    while (occupiedRows.has(row)) {
      row += 1;
    }

    occupiedRows.add(row);
    occupiedRowsByLane.set(laneLabel, occupiedRows);
    rowByNodeId.set(node.stableId, row);
    maxRow = Math.max(maxRow, row);
  });

  return {
    rowByNodeId,
    maxRow,
  };
}

function getLaneNodeBounds(node, laneX, row, isTarget) {
  const [width, height] = node.isRoot
    ? [220, 80]
    : isTarget
      ? [220, 70]
      : getFlowSize(node);
  const x = laneX + Math.trunc((LANE_WIDTH - width) / 2);
  const y = LANE_NODE_TOP_Y + row * FLOW_Y_GAP;

  return [x, y, width, height];
}

function getFlowStyle(node) {
  if (node.isExternal) {
    return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#d79b00;fontColor=#000000;';
  }

  if (node.isRuntimeOnly) {
    return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;fontColor=#000000;';
  }

  if (node.runtimeObserved) {
    return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontColor=#000000;';
  }

  if (node.isMerge) {
    return 'ellipse;whiteSpace=wrap;html=1;fillColor=#b59ac4;strokeColor=#6f4f86;fontColor=#000000;';
  }

  if (node.isBranch) {
    return 'rhombus;whiteSpace=wrap;html=1;fillColor=#d9a066;strokeColor=#9a5d00;fontColor=#000000;';
  }

  return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#8fb3d9;strokeColor=#456c96;fontColor=#000000;';
}

function getFlowSize(node) {
  if (node.isMerge) {
    return [140, 80];
  }

  if (node.isBranch) {
    return [240, 110];
  }

  return [220, 90];
}

function getEdgeStyle(edge) {
  const parts = ['edgeStyle=orthogonalEdgeStyle', 'rounded=0', 'orthogonalLoop=1', 'jettySize=auto', 'html=1', 'endArrow=block'];

  if (edge.displayType === 'TRUE') {
    parts.push('strokeColor=#82b366');
  } else if (edge.displayType === 'FALSE') {
    parts.push('strokeColor=#b85450');
  } else if (edge.displayType === 'OPTION_CASE' || edge.displayType === 'OPTION_DEFAULT') {
    parts.push('strokeColor=#d79b00');
  } else if (edge.displayType === 'RUNTIME_MATCHED') {
    parts.push('strokeColor=#2f5597');
    parts.push('strokeWidth=2');
  } else if (edge.displayType === 'RUNTIME_ONLY') {
    parts.push('strokeColor=#b85450');
    parts.push('strokeWidth=2');
    parts.push('dashed=1');
  }

  if (edge.hasCall) {
    parts.push('dashed=1');
  }

  return `${parts.join(';')};`;
}

function addVertex(lines, cellId, value, style, x, y, width, height) {
  lines.push(`<mxCell id="${escapeXml(cellId)}" value="${value}" style="${style}" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${width}" height="${height}" as="geometry" /></mxCell>`);
}

function addEdge(lines, cellId, value, style, source, target, points) {
  if (points?.length) {
    const serializedPoints = points.map(([x, y]) => `<mxPoint x="${x}" y="${y}" />`).join('');
    lines.push(`<mxCell id="${escapeXml(cellId)}" value="${escapeXml(value)}" style="${style}" edge="1" parent="1" source="${escapeXml(source)}" target="${escapeXml(target)}"><mxGeometry relative="1" as="geometry"><Array as="points">${serializedPoints}</Array></mxGeometry></mxCell>`);
    return;
  }

  lines.push(`<mxCell id="${escapeXml(cellId)}" value="${escapeXml(value)}" style="${style}" edge="1" parent="1" source="${escapeXml(source)}" target="${escapeXml(target)}"><mxGeometry relative="1" as="geometry" /></mxCell>`);
}

function parseStyle(style) {
  const result = {};
  String(style || '').split(';').forEach((part) => {
    if (!part) {
      return;
    }

    const separatorIndex = part.indexOf('=');
    if (separatorIndex < 0) {
      result[part] = '';
      return;
    }

    result[part.slice(0, separatorIndex)] = part.slice(separatorIndex + 1);
  });
  return result;
}

function serializeStyle(styleParts) {
  return `${Object.entries(styleParts).map(([key, value]) => (value ? `${key}=${value}` : key)).join(';')};`;
}

function getNodeCenter(bounds) {
  const [x, y, width, height] = bounds;
  return [x + width / 2, y + height / 2];
}

function getEdgeSide(sourceBounds, targetBounds, isSource) {
  const [sourceCenterX, sourceCenterY] = getNodeCenter(sourceBounds);
  const [targetCenterX, targetCenterY] = getNodeCenter(targetBounds);
  const dx = targetCenterX - sourceCenterX;
  const dy = targetCenterY - sourceCenterY;

  if (Math.abs(dx) > Math.abs(dy)) {
    if (isSource) {
      return dx >= 0 ? 'right' : 'left';
    }

    return dx >= 0 ? 'left' : 'right';
  }

  if (isSource) {
    return dy >= 0 ? 'bottom' : 'top';
  }

  return dy >= 0 ? 'top' : 'bottom';
}

function getAnchorCoordinates(side, isSource) {
  if (side === 'top') {
    return isSource ? [0.65, 0.0] : [0.35, 0.0];
  }
  if (side === 'right') {
    return isSource ? [1.0, 0.65] : [1.0, 0.35];
  }
  if (side === 'bottom') {
    return isSource ? [0.65, 1.0] : [0.35, 1.0];
  }

  return isSource ? [0.0, 0.65] : [0.0, 0.35];
}

function getRhombusVertexCoordinates(side) {
  if (side === 'top') {
    return [0.5, 0.0];
  }
  if (side === 'right') {
    return [1.0, 0.5];
  }
  if (side === 'bottom') {
    return [0.5, 1.0];
  }

  return [0.0, 0.5];
}

function normalizeRhombusPort(styleParts, prefix) {
  const sideX = Number(styleParts[`${prefix}X`]);
  const sideY = Number(styleParts[`${prefix}Y`]);
  let side;

  if (sideY === 0) {
    side = 'top';
  } else if (sideX === 1) {
    side = 'right';
  } else if (sideY === 1) {
    side = 'bottom';
  } else if (sideX === 0) {
    side = 'left';
  } else {
    return;
  }

  const [normalizedX, normalizedY] = getRhombusVertexCoordinates(side);
  styleParts[`${prefix}X`] = String(normalizedX);
  styleParts[`${prefix}Y`] = String(normalizedY);
  styleParts[`${prefix}Dx`] = '0';
  styleParts[`${prefix}Dy`] = '0';
  styleParts[`${prefix}Perimeter`] = '0';
}

function getDistributedAnchorCoordinates(side, index, count, isSource) {
  if (count <= 1) {
    return getAnchorCoordinates(side, isSource);
  }

  if (side === 'top' || side === 'bottom') {
    const positions = count === 2 ? [0.2, 0.8] : [0.2, 0.5, 0.8];
    return [positions[Math.min(index, positions.length - 1)], side === 'top' ? 0.0 : 1.0];
  }

  const positions = count === 2 ? [0.2, 0.8] : [0.2, 0.5, 0.8];
  return [side === 'right' ? 1.0 : 0.0, positions[Math.min(index, positions.length - 1)]];
}

function isBranchSideEdgeType(edgeType) {
  return edgeType === 'FALSE' || edgeType === 'TRUE';
}

function getBranchExitCoordinates(side, edgeType) {
  if (edgeType === 'FALSE') {
    return getRhombusVertexCoordinates('left');
  }
  if (edgeType === 'TRUE') {
    return getRhombusVertexCoordinates('right');
  }

  return getRhombusVertexCoordinates(side);
}

function getBranchEntryCoordinates(sourceBounds, targetBounds) {
  return getRhombusVertexCoordinates(getEdgeSide(sourceBounds, targetBounds, false));
}

function getMergeExitCoordinates(index, count) {
  return getDistributedAnchorCoordinates('bottom', index, count, true);
}

function getMergeEntryCoordinates(sourceBounds, targetBounds, preferredExitSide = 'bottom') {
  const [sourceCenterX, sourceCenterY] = getNodeCenter(sourceBounds);
  const [targetCenterX, targetCenterY] = getNodeCenter(targetBounds);

  if (sourceCenterY < targetCenterY) {
    return [0.5, 0.0];
  }
  if (sourceCenterY > targetCenterY) {
    if (preferredExitSide === 'bottom') {
      return sourceCenterX >= targetCenterX ? [1.0, 0.5] : [0.0, 0.5];
    }
    return [0.5, 1.0];
  }
  if (sourceCenterX < targetCenterX) {
    return [0.0, 0.5];
  }

  return [1.0, 0.5];
}

function dedupeFeaturePaths(paths) {
  const uniquePaths = [];
  const seenPathKeys = new Set();

  (paths || []).forEach((pathItem) => {
    const pathKey = JSON.stringify((pathItem?.nodes || []).map((node) => node?.stableId).filter(Boolean));
    if (!pathKey || seenPathKeys.has(pathKey)) {
      return;
    }

    seenPathKeys.add(pathKey);
    uniquePaths.push(pathItem);
  });

  return uniquePaths;
}

function buildVirtualFeatureGraph(feature, paths) {
  const explicitTargetIds = new Set((feature?.endFnStableIds || []).filter(Boolean));
  const nodesById = new Map();
  const edgesByKey = new Map();

  const ensureNode = (node) => {
    if (!node?.stableId || (!node.isFunction && !node.isExternal)) {
      return undefined;
    }

    const existing = nodesById.get(node.stableId);
    if (existing) {
      return existing;
    }

    const normalized = {
      stableId: node.stableId,
      name: node.name || '<anonymous>',
      labels: [...(node.labels || [])],
      location: node.location,
      isRoot: node.stableId === feature?.stableId,
      isTarget: explicitTargetIds.has(node.stableId),
      isExternal: Boolean(node.isExternal),
    };
    nodesById.set(node.stableId, normalized);
    return normalized;
  };

  for (const path of paths || []) {
    const fnPositions = [];
    (path.nodes || []).forEach((node, index) => {
      if ((!node?.isFunction && !node?.isExternal) || !node?.stableId) {
        return;
      }

      ensureNode(node);
      fnPositions.push({ index, node });
    });

    for (let index = 0; index < fnPositions.length - 1; index += 1) {
      const current = fnPositions[index];
      const next = fnPositions[index + 1];
      if (!current?.node?.stableId || !next?.node?.stableId || current.node.stableId === next.node.stableId) {
        continue;
      }

      const segmentRels = (path.rels || []).slice(current.index, next.index);
      const key = `${current.node.stableId}=>${next.node.stableId}`;
      const existing = edgesByKey.get(key) || {
        fromId: current.node.stableId,
        toId: next.node.stableId,
        edgeTypes: new Set(),
        edgeLabels: new Set(),
        callTexts: new Set(),
        hasCall: false,
        pathEndFnStableIds: new Set(),
      };

      segmentRels.forEach((rel) => {
        if (rel?.type) {
          existing.edgeTypes.add(rel.type);
        }
        if (rel?.label) {
          existing.edgeLabels.add(rel.label);
        }
        if (rel?.callTextRaw) {
          existing.callTexts.add(shorten(rel.callTextRaw, 64));
        }
        if (rel?.role === 'call') {
          existing.hasCall = true;
        }
      });
      if (path?.endFnStableId) {
        existing.pathEndFnStableIds.add(path.endFnStableId);
      }

      edgesByKey.set(key, existing);
    }
  }

  const edges = [...edgesByKey.values()].map((edge) => {
    const edgeTypes = [...edge.edgeTypes];
    const preferredType = edgeTypes.find((type) => type === 'FALSE')
      || edgeTypes.find((type) => type === 'TRUE')
      || edgeTypes.find((type) => type === 'OPTION_CASE')
      || edgeTypes.find((type) => type === 'OPTION_DEFAULT')
      || edgeTypes.find((type) => type === 'MERGES_TO')
      || edgeTypes[0]
      || 'NEXT';

    return {
      fromId: edge.fromId,
      toId: edge.toId,
      displayType: preferredType,
      displayLabel: preferredType === 'OPTION_CASE'
        ? ([...edge.edgeLabels][0] || preferredType)
        : preferredType,
      hasCall: edge.hasCall,
      callTexts: [...edge.callTexts],
      pathEndFnStableIds: [...edge.pathEndFnStableIds],
    };
  });

  const incomingCountById = new Map();
  const outgoingCountById = new Map();
  edges.forEach((edge) => {
    outgoingCountById.set(edge.fromId, (outgoingCountById.get(edge.fromId) || 0) + 1);
    incomingCountById.set(edge.toId, (incomingCountById.get(edge.toId) || 0) + 1);
  });

  const nodes = [...nodesById.values()].map((node) => ({
    ...node,
    isBranch: (outgoingCountById.get(node.stableId) || 0) > 1,
    isMerge: (incomingCountById.get(node.stableId) || 0) > 1,
  }));

  const root = nodes.find((node) => node.stableId === feature?.stableId) || nodes[0];
  const targetFns = nodes.filter((node) => (node.isTarget || node.isExternal) && !node.isRoot);
  const targetIdSet = new Set(targetFns.map((node) => node.stableId));
  const flowNodes = nodes.filter((node) => !node.isRoot && !targetIdSet.has(node.stableId));

  return {
    root,
    flowNodes,
    targetFns,
    edges,
    nodes,
  };
}

function finalizeFeatureGraph(feature, rawNodes, rawEdges) {
  const incomingCountById = new Map();
  const outgoingCountById = new Map();

  rawEdges.forEach((edge) => {
    outgoingCountById.set(edge.fromId, (outgoingCountById.get(edge.fromId) || 0) + 1);
    incomingCountById.set(edge.toId, (incomingCountById.get(edge.toId) || 0) + 1);
  });

  const nodes = rawNodes.map((node) => ({
    ...node,
    isRoot: Boolean(node.isRoot),
    isTarget: Boolean(node.isTarget),
    isExternal: Boolean(node.isExternal),
    runtimeObserved: Boolean(node.runtimeObserved),
    isRuntimeOnly: Boolean(node.isRuntimeOnly),
    isBranch: (outgoingCountById.get(node.stableId) || 0) > 1,
    isMerge: (incomingCountById.get(node.stableId) || 0) > 1,
  }));

  const root = nodes.find((node) => node.isRoot) || nodes[0] || null;
  const targetFns = nodes.filter((node) => node.isTarget && !node.isRoot);
  const targetIdSet = new Set(targetFns.map((node) => node.stableId));
  const flowNodes = nodes.filter((node) => !node.isRoot && !targetIdSet.has(node.stableId));

  return {
    root,
    flowNodes,
    targetFns,
    edges: rawEdges,
    nodes,
  };
}

function buildStaticNodeLookup(graph) {
  return new Map((graph?.nodes || []).map((node) => [node.stableId, node]));
}

function buildStaticNodeCoordinateLookup(graph) {
  const lookup = new Map();

  (graph?.nodes || []).forEach((node) => {
    const repoRelativePath = String(node?.location?.repoRelativePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
    const startLine = Number(node?.location?.startLine);

    if (!repoRelativePath || !Number.isInteger(startLine) || startLine <= 0) {
      return;
    }

    lookup.set(`coord:${repoRelativePath}:${startLine}`, node);
  });

  return lookup;
}

async function loadRuntimeAnchorEventsForFeature(runtimeStore, stableIds, { sessionId } = {}) {
  const anchorGroups = [];

  for (const stableId of stableIds) {
    const events = await fetchRuntimeEventRecords(runtimeStore, {
      limit: FEATURE_RUNTIME_DRAW_EVENT_LIMIT,
      sessionId,
      ownerFnStableId: stableId,
    });

    anchorGroups.push(events.map((event) => ({
      stableId,
      event,
    })));
  }

  const allAnchors = anchorGroups.flat().filter((item) => item?.event?.nodeId);
  if (!allAnchors.length) {
    return [];
  }

  const latestTimestamp = Math.max(...allAnchors.map(({ event }) => Date.parse(event.ingestedAt || '') || 0));
  if (!latestTimestamp) {
    return allAnchors;
  }

  return allAnchors.filter(({ event }) => {
    const timestamp = Date.parse(event.ingestedAt || '') || 0;
    return latestTimestamp - timestamp <= FEATURE_RUNTIME_DRAW_ANCHOR_WINDOW_MS;
  });
}

function mergeRuntimeComparisons(feature, staticGraph, comparisons) {
  const explicitTargetIds = new Set((feature?.endFnStableIds || []).filter(Boolean));
  const staticNodesById = buildStaticNodeLookup(staticGraph);
  const staticNodesByCoordinate = buildStaticNodeCoordinateLookup(staticGraph);
  const nodesById = new Map();
  const edgesByKey = new Map();
  const matchedTransitions = [];
  const runtimeOnlyTransitions = [];
  const staticOnlyTransitions = [];

  function resolveRuntimeNodeIdentity(stableId) {
    if (!stableId) {
      return { stableId: null, staticNode: null, metadata: null };
    }

    const normalizedStableId = normalizeRuntimeSeedStableId(stableId);
    const staticNode = staticNodesById.get(normalizedStableId) || staticNodesById.get(stableId) || staticNodesByCoordinate.get(stableId) || null;
    const metadata = staticGraph?.functionMetadataByStableId?.get(normalizedStableId) || null;
    return {
      stableId: staticNode?.stableId || metadata?.stableId || normalizedStableId || stableId,
      staticNode,
      metadata,
    };
  }

  function ensureNode(stableId, details = {}) {
    const resolved = resolveRuntimeNodeIdentity(stableId);
    if (!resolved.stableId) {
      return null;
    }

    const resolvedStableId = resolved.stableId;

    const existing = nodesById.get(resolvedStableId);
    if (existing) {
      existing.name = details.name || existing.name;
      existing.labels = existing.labels?.length ? existing.labels : [...(details.labels || resolved.staticNode?.labels || resolved.metadata?.labels || [])];
      existing.layer = existing.layer || details.layer || resolved.staticNode?.layer || resolved.metadata?.layer;
      existing.location = existing.location || details.location || resolved.staticNode?.location || resolved.metadata?.location;
      existing.isExternal = Boolean(existing.isExternal || resolved.staticNode?.isExternal || resolved.metadata?.isExternal || details.isExternal);
      existing.runtimeObserved = true;
      existing.isRuntimeOnly = Boolean(existing.isRuntimeOnly && !resolved.staticNode);
      return existing;
    }

    const staticNode = resolved.staticNode;
    const node = {
      stableId: resolvedStableId,
      name: details.name || staticNode?.name || resolved.metadata?.name || '<anonymous>',
      labels: [...(details.labels || staticNode?.labels || resolved.metadata?.labels || [])],
      layer: details.layer || staticNode?.layer || resolved.metadata?.layer,
      location: details.location || staticNode?.location || resolved.metadata?.location,
      isRoot: resolvedStableId === feature?.stableId,
      isTarget: explicitTargetIds.has(resolvedStableId),
      isExternal: Boolean(staticNode?.isExternal || resolved.metadata?.isExternal || details.isExternal),
      runtimeObserved: true,
      isRuntimeOnly: Boolean(!staticNode),
    };
    nodesById.set(resolvedStableId, node);
    return node;
  }

  function mergeEdge(sourceStableId, targetStableId, kind, label, payload) {
    const resolvedSource = resolveRuntimeNodeIdentity(sourceStableId);
    const resolvedTarget = resolveRuntimeNodeIdentity(targetStableId);

    if (!resolvedSource.stableId || !resolvedTarget.stableId || resolvedSource.stableId === resolvedTarget.stableId) {
      return;
    }

    const key = `${resolvedSource.stableId}=>${resolvedTarget.stableId}`;
    const existing = edgesByKey.get(key) || {
      fromId: resolvedSource.stableId,
      toId: resolvedTarget.stableId,
      displayType: kind,
      displayLabel: label,
      hasCall: false,
      callTexts: [],
      pathEndFnStableIds: explicitTargetIds.has(resolvedTarget.stableId) ? [resolvedTarget.stableId] : [],
      transitionCount: 0,
      comparisonKinds: new Set(),
      payloads: [],
    };

    if (kind === 'RUNTIME_MATCHED') {
      existing.displayType = kind;
      existing.displayLabel = label;
    } else if (kind === 'RUNTIME_ONLY' && existing.displayType !== 'RUNTIME_MATCHED') {
      existing.displayType = kind;
      existing.displayLabel = label;
    }

    existing.transitionCount += payload?.transitionCount || 1;
    existing.comparisonKinds.add(kind);
    if (payload) {
      existing.payloads.push(payload);
    }
    edgesByKey.set(key, existing);
  }

  comparisons.forEach((comparison) => {
    const observedFunctions = comparison?.comparison?.observedFunctions || [];
    observedFunctions.forEach((entry) => {
      ensureNode(entry.stableId, {
        name: entry.fnNames?.[0] || '<anonymous>',
      });
    });

    (comparison?.comparison?.matchedTransitions || []).forEach((transition) => {
      ensureNode(transition.sourceStableId, { name: transition.sourceFnNames?.[0] });
      ensureNode(transition.targetStableId, { name: transition.targetFnNames?.[0] });
      mergeEdge(transition.sourceStableId, transition.targetStableId, 'RUNTIME_MATCHED', 'runtime+static', transition);
      matchedTransitions.push(transition);
    });

    (comparison?.comparison?.runtimeOnlyTransitions || []).forEach((transition) => {
      ensureNode(transition.sourceStableId, { name: transition.sourceFnNames?.[0] });
      ensureNode(transition.targetStableId, { name: transition.targetFnNames?.[0] });
      mergeEdge(transition.sourceStableId, transition.targetStableId, 'RUNTIME_ONLY', 'runtime-only', transition);
      runtimeOnlyTransitions.push(transition);
    });

    (comparison?.comparison?.staticOnlyTransitions || []).forEach((transition) => {
      staticOnlyTransitions.push(transition);
    });
  });

  const rawNodes = [...nodesById.values()].sort((left, right) => left.stableId.localeCompare(right.stableId));
  if (!rawNodes.some((node) => node.isRoot) && rawNodes.length) {
    rawNodes[0].isRoot = true;
  }

  const rawEdges = [...edgesByKey.values()].map((edge) => ({
    fromId: edge.fromId,
    toId: edge.toId,
    displayType: edge.displayType,
    displayLabel: edge.displayLabel,
    hasCall: edge.displayType === 'RUNTIME_ONLY',
    callTexts: [],
    pathEndFnStableIds: edge.pathEndFnStableIds,
    transitionCount: edge.transitionCount,
    comparisonKinds: [...edge.comparisonKinds],
    payloads: edge.payloads,
  }));

  return {
    graph: finalizeFeatureGraph(feature, rawNodes, rawEdges),
    comparison: {
      comparedFunctionCount: [...new Set(rawNodes.map((node) => node.stableId))].length,
      runtimeTransitionCount: rawEdges.length,
      matchedTransitionCount: matchedTransitions.length,
      runtimeOnlyTransitionCount: runtimeOnlyTransitions.length,
      staticOnlyTransitionCount: staticOnlyTransitions.length,
      matchedTransitions,
      runtimeOnlyTransitions,
      staticOnlyTransitions,
    },
  };
}

async function buildRuntimeFeatureGraph(feature, staticGraph, {
  runtimeStore,
  driver,
  database,
  sessionId,
  limit = 100,
} = {}) {
  if (!runtimeStore) {
    return {
      available: false,
      error: 'Runtime logs are unavailable.',
      graph: null,
      comparison: null,
      anchors: [],
    };
  }

  const candidateStableIds = [...new Set((staticGraph?.nodes || []).map((node) => node.stableId).filter(Boolean))];
  const anchorEvents = await loadRuntimeAnchorEventsForFeature(runtimeStore, candidateStableIds, { sessionId });
  const anchorNodeIds = [...new Set(anchorEvents.map(({ event }) => event.nodeId).filter(Boolean))];

  if (!anchorNodeIds.length) {
    return {
      available: true,
      error: null,
      graph: finalizeFeatureGraph(feature, [], []),
      comparison: {
        comparedFunctionCount: 0,
        runtimeTransitionCount: 0,
        matchedTransitionCount: 0,
        runtimeOnlyTransitionCount: 0,
        staticOnlyTransitionCount: 0,
        matchedTransitions: [],
        runtimeOnlyTransitions: [],
        staticOnlyTransitions: [],
      },
      anchors: [],
    };
  }

  const comparisons = [];
  for (const anchorNodeId of anchorNodeIds) {
    comparisons.push(await loadRuntimeChainSummary(
      runtimeStore,
      {
        nodeId: anchorNodeId,
        sessionId,
        maxDepth: 25,
        limit: Math.max(50, Math.min(limit, 500)),
      },
    ));
  }
  const merged = mergeRuntimeComparisons(feature, staticGraph, comparisons.filter((item) => item?.available && !item?.error));

  return {
    available: true,
    error: null,
    graph: merged.graph,
    comparison: merged.comparison,
    anchors: anchorEvents.map(({ stableId, event }) => ({
      stableId,
      nodeId: event.nodeId,
      ingestedAt: event.ingestedAt,
      fnName: event.fnName,
      ownerFnStableId: event.ownerFnStableId,
    })),
  };
}

function buildFlowLayout(rootStableId, flowNodes, edges, targetFnIds) {
  const targetIdSet = new Set(targetFnIds);
  const childIdsBySource = new Map();
  edges.forEach((edge) => {
    if (targetIdSet.has(edge.toId)) {
      return;
    }

    const children = childIdsBySource.get(edge.fromId) || [];
    if (!children.includes(edge.toId)) {
      children.push(edge.toId);
    }
    childIdsBySource.set(edge.fromId, children);
  });

  const positions = new Map([[rootStableId, [0, 0]]]);
  const occupiedColumnsByRow = new Map([[0, new Map([[0, rootStableId]])]]);
  const queue = [[rootStableId, 0, 0]];

  while (queue.length) {
    const [sourceId, currentX, currentY] = queue.shift();
    const childIds = childIdsBySource.get(sourceId) || [];
    childIds.forEach((childId, index) => {
      let childX = currentX + index;
      const childY = currentY + 1;
      const existingPosition = positions.get(childId);

      let shouldUpdate = !existingPosition;
      if (existingPosition) {
        const [existingX, existingY] = existingPosition;
        shouldUpdate = childY < existingY || (childY === existingY && childX > existingX);
        if (!shouldUpdate) {
          return;
        }

        if (childY === existingY) {
          childX = Math.max(childX, existingX);
        }

        const existingRow = occupiedColumnsByRow.get(existingY);
        if (existingRow?.get(existingX) === childId) {
          existingRow.delete(existingX);
          if (!existingRow.size) {
            occupiedColumnsByRow.delete(existingY);
          }
        }
      }

      const targetRow = occupiedColumnsByRow.get(childY) || new Map();
      while (targetRow.get(childX) && targetRow.get(childX) !== childId) {
        childX += 1;
      }

      positions.set(childId, [childX, childY]);
      targetRow.set(childX, childId);
      occupiedColumnsByRow.set(childY, targetRow);
      queue.push([childId, childX, childY]);
    });
  }

  [...flowNodes].sort((left, right) => left.stableId.localeCompare(right.stableId)).forEach((node, index) => {
    if (!positions.has(node.stableId)) {
      positions.set(node.stableId, [0, index + 1]);
    }
  });

  return positions;
}

function buildFlowBounds(root, flowNodes, flowLayout) {
  const sizeByNodeId = new Map([[root.stableId, [180, 70]]]);
  flowNodes.forEach((node) => {
    sizeByNodeId.set(node.stableId, getFlowSize(node));
  });

  const rowEntries = new Map();
  flowLayout.forEach(([column, row], nodeId) => {
    const entries = rowEntries.get(row) || [];
    entries.push([column, nodeId]);
    rowEntries.set(row, entries);
  });

  const rowWidths = new Map();
  rowEntries.forEach((entries, row) => {
    let rowRight = 0;
    entries.forEach(([column, nodeId]) => {
      const [width] = sizeByNodeId.get(nodeId) || [220, 90];
      rowRight = Math.max(rowRight, column * FLOW_X_GAP + width);
    });
    rowWidths.set(row, rowRight);
  });

  const diagramWidth = Math.max(...rowWidths.values(), 0);
  const boundsByNodeId = new Map();
  rowEntries.forEach((entries, row) => {
    const rowOffsetX = Math.trunc((diagramWidth - (rowWidths.get(row) || 0)) / 2);
    entries.forEach(([column, nodeId]) => {
      const [width, height] = sizeByNodeId.get(nodeId) || [220, 90];
      const x = FLOW_ORIGIN_X + rowOffsetX + column * FLOW_X_GAP;
      const y = nodeId === root.stableId ? FN_ROOT_Y : FLOW_ORIGIN_Y + row * FLOW_Y_GAP;
      boundsByNodeId.set(nodeId, [x, y, width, height]);
    });
  });

  return boundsByNodeId;
}

function buildTargetFnPositionsWithBounds(targetFns, edges, flowLayout, boundsByNodeId) {
  const anchorYByFn = new Map();
  edges.forEach((edge) => {
    if (!targetFns.some((fn) => fn.stableId === edge.toId)) {
      return;
    }

    const flowPosition = flowLayout.get(edge.fromId);
    if (!flowPosition) {
      return;
    }

    const [, row] = flowPosition;
    const candidate = FN_ROOT_Y + row * FLOW_Y_GAP;
    const current = anchorYByFn.get(edge.toId);
    anchorYByFn.set(edge.toId, current === undefined ? candidate : Math.min(current, candidate));
  });

  const maxFlowRight = Math.max(...[...boundsByNodeId.values()].map(([x, , width]) => x + width), FLOW_ORIGIN_X);
  const targetX = maxFlowRight + FN_TARGET_X_GAP;
  const ordered = [...targetFns].sort((left, right) => {
    const leftY = anchorYByFn.get(left.stableId) || 0;
    const rightY = anchorYByFn.get(right.stableId) || 0;
    return leftY - rightY || left.stableId.localeCompare(right.stableId);
  });

  const positions = new Map();
  const usedY = new Set();
  ordered.forEach((fn, index) => {
    let desiredY = anchorYByFn.get(fn.stableId) || (FN_ROOT_Y + index * FLOW_Y_GAP);
    while (usedY.has(desiredY)) {
      desiredY += 90;
    }
    positions.set(fn.stableId, [targetX, desiredY]);
    usedY.add(desiredY);
  });

  return positions;
}

function getEdgePoints(edge, boundsByNodeId, flowLayout, rightmostColumnByRow, routedRightEdgeTargets) {
  const sourceLayout = flowLayout.get(edge.fromId);
  const targetLayout = flowLayout.get(edge.toId);
  const sourceBounds = boundsByNodeId.get(edge.fromId);
  const targetBounds = boundsByNodeId.get(edge.toId);
  if (!sourceLayout || !targetLayout || !sourceBounds || !targetBounds) {
    return undefined;
  }

  const [sourceColumn, sourceRow] = sourceLayout;
  const [targetColumn] = targetLayout;
  if (sourceColumn >= (rightmostColumnByRow.get(sourceRow) || sourceColumn)) {
    return undefined;
  }
  if (routedRightEdgeTargets.get(edge.fromId) !== edge.toId) {
    return undefined;
  }
  if (targetColumn <= sourceColumn) {
    return undefined;
  }

  const [sourceX, sourceY, sourceWidth, sourceHeight] = sourceBounds;
  const [targetX, targetY, targetWidth] = targetBounds;
  const bendY = sourceY + sourceHeight + Math.trunc(FLOW_Y_GAP / 2);
  const sourceCenterX = sourceX + Math.trunc(sourceWidth / 2);
  const targetCenterX = targetX + Math.trunc(targetWidth / 2);
  const targetTopY = targetY - 20;

  return [
    [sourceCenterX, bendY],
    [targetCenterX, bendY],
    [targetCenterX, targetTopY],
  ];
}

function applyPostcheckPortSeparation(lines, boundsByNodeId, nodeCellIds, branchingNodeIds, mergeNodeIds) {
  const stableIdByCellId = new Map([...nodeCellIds.entries()].map(([stableId, cellId]) => [cellId, stableId]));
  const edgeDescriptors = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.includes(' edge="1" '));

  const incomingByNode = new Map();
  const outgoingByNode = new Map();

  const edgeMeta = edgeDescriptors.map(({ line, index }) => {
    const sourceMatch = line.match(/ source="([^"]+)"/);
    const targetMatch = line.match(/ target="([^"]+)"/);
    const valueMatch = line.match(/ value="([^"]*)"/);
    const sourceCellId = sourceMatch?.[1];
    const targetCellId = targetMatch?.[1];
    const sourceStableId = sourceCellId ? stableIdByCellId.get(sourceCellId) : undefined;
    const targetStableId = targetCellId ? stableIdByCellId.get(targetCellId) : undefined;
    const meta = {
      index,
      sourceCellId,
      targetCellId,
      sourceStableId,
      targetStableId,
      value: valueMatch?.[1] || '',
    };

    if (sourceStableId) {
      const items = outgoingByNode.get(sourceStableId) || [];
      items.push(meta);
      outgoingByNode.set(sourceStableId, items);
    }
    if (targetStableId) {
      const items = incomingByNode.get(targetStableId) || [];
      items.push(meta);
      incomingByNode.set(targetStableId, items);
    }

    return meta;
  });

  const updateStyle = (meta, updater) => {
    const lineIndex = edgeDescriptors.find((item) => item.index === meta.index)?.index;
    if (lineIndex === undefined) {
      return;
    }

    const line = lines[lineIndex];
    const styleMatch = line.match(/ style="([^"]*)"/);
    if (!styleMatch) {
      return;
    }

    const styleParts = parseStyle(styleMatch[1]);
    updater(styleParts);
    lines[lineIndex] = line.replace(styleMatch[0], ` style="${serializeStyle(styleParts)}"`);
  };

  [...incomingByNode.entries()].forEach(([stableId, incomingEdges]) => {
    const outgoingEdges = outgoingByNode.get(stableId);
    const nodeBounds = boundsByNodeId.get(stableId);
    if (!outgoingEdges?.length || !nodeBounds) {
      return;
    }

    const incomingSideByEdge = new Map();
    const incomingSourceBoundsByEdge = new Map();
    const outgoingSideByEdge = new Map();

    incomingEdges.forEach((meta) => {
      const sourceBounds = boundsByNodeId.get(meta.sourceStableId);
      if (!sourceBounds) {
        return;
      }
      incomingSideByEdge.set(meta, getEdgeSide(sourceBounds, nodeBounds, false));
      incomingSourceBoundsByEdge.set(meta, sourceBounds);
    });

    outgoingEdges.forEach((meta) => {
      const targetBounds = boundsByNodeId.get(meta.targetStableId);
      if (!targetBounds) {
        return;
      }
      outgoingSideByEdge.set(meta, getEdgeSide(nodeBounds, targetBounds, true));
    });

    const conflictingSides = new Set([...incomingSideByEdge.values()].filter((side) => [...outgoingSideByEdge.values()].includes(side)));
    if (conflictingSides.size) {
      incomingSideByEdge.forEach((targetSide, meta) => {
        if (!conflictingSides.has(targetSide)) {
          return;
        }
        const [entryX, entryY] = getAnchorCoordinates(targetSide, false);
        updateStyle(meta, (styleParts) => {
          styleParts.entryX = String(entryX);
          styleParts.entryY = String(entryY);
          styleParts.entryDx = '0';
          styleParts.entryDy = '0';
          styleParts.entryPerimeter = '0';
        });
      });

      outgoingSideByEdge.forEach((sourceSide, meta) => {
        if (!conflictingSides.has(sourceSide)) {
          return;
        }
        const [exitX, exitY] = getAnchorCoordinates(sourceSide, true);
        updateStyle(meta, (styleParts) => {
          styleParts.exitX = String(exitX);
          styleParts.exitY = String(exitY);
          styleParts.exitDx = '0';
          styleParts.exitDy = '0';
          styleParts.exitPerimeter = '0';
        });
      });
    }

    if (branchingNodeIds.has(stableId)) {
      incomingSourceBoundsByEdge.forEach((sourceBounds, meta) => {
        const [entryX, entryY] = getBranchEntryCoordinates(sourceBounds, nodeBounds);
        updateStyle(meta, (styleParts) => {
          styleParts.entryX = String(entryX);
          styleParts.entryY = String(entryY);
          styleParts.entryDx = '0';
          styleParts.entryDy = '0';
          styleParts.entryPerimeter = '0';
        });
      });

      const orderedOutgoing = [...outgoingSideByEdge.keys()].sort((left, right) => {
        const leftScore = ({ FALSE: 0, TRUE: 1 }[left.value] ?? 2);
        const rightScore = ({ FALSE: 0, TRUE: 1 }[right.value] ?? 2);
        return leftScore - rightScore || String(left.targetCellId || '').localeCompare(String(right.targetCellId || ''));
      });
      if (orderedOutgoing.length >= 2) {
        orderedOutgoing.forEach((meta) => {
          const side = outgoingSideByEdge.get(meta) || 'bottom';
          const [exitX, exitY] = getBranchExitCoordinates(side, meta.value);
          updateStyle(meta, (styleParts) => {
            styleParts.exitX = String(exitX);
            styleParts.exitY = String(exitY);
            styleParts.exitDx = '0';
            styleParts.exitDy = '0';
            styleParts.exitPerimeter = '0';
          });
        });
      }
    }

    if (!mergeNodeIds.has(stableId)) {
      return;
    }

    const orderedIncoming = [...incomingSourceBoundsByEdge.keys()].sort((left, right) => {
      return String(left.sourceCellId || '').localeCompare(String(right.sourceCellId || ''))
        || String(left.value || '').localeCompare(String(right.value || ''));
    });
    orderedIncoming.forEach((meta) => {
      const sourceBounds = incomingSourceBoundsByEdge.get(meta);
      const [entryX, entryY] = getMergeEntryCoordinates(sourceBounds, nodeBounds);
      updateStyle(meta, (styleParts) => {
        styleParts.entryX = String(entryX);
        styleParts.entryY = String(entryY);
        styleParts.entryDx = '0';
        styleParts.entryDy = '0';
        styleParts.entryPerimeter = '0';
      });
    });

    const orderedOutgoing = [...outgoingSideByEdge.keys()].sort((left, right) => {
      return String(left.targetCellId || '').localeCompare(String(right.targetCellId || ''))
        || String(left.value || '').localeCompare(String(right.value || ''));
    });
    orderedOutgoing.forEach((meta, index) => {
      const [exitX, exitY] = getMergeExitCoordinates(index, orderedOutgoing.length);
      updateStyle(meta, (styleParts) => {
        styleParts.exitX = String(exitX);
        styleParts.exitY = String(exitY);
        styleParts.exitDx = '0';
        styleParts.exitDy = '0';
        styleParts.exitPerimeter = '0';
      });
    });
  });

  edgeMeta.forEach((meta) => {
    updateStyle(meta, (styleParts) => {
      if (meta.sourceStableId && branchingNodeIds.has(meta.sourceStableId)) {
        normalizeRhombusPort(styleParts, 'exit');
      }
      if (meta.targetStableId && branchingNodeIds.has(meta.targetStableId)) {
        normalizeRhombusPort(styleParts, 'entry');
      }
    });
  });

  return edgeMeta;
}

function filterGraphByCoveredStableIds(graph, coveredStableIds) {
  const coveredSet = new Set((coveredStableIds || []).filter(Boolean));
  const filteredNodes = (graph.nodes || []).filter((node) => coveredSet.has(node.stableId));
  const filteredNodeIds = new Set(filteredNodes.map((node) => node.stableId));
  const filteredEdges = (graph.edges || []).filter((edge) => {
    return filteredNodeIds.has(edge.fromId) && filteredNodeIds.has(edge.toId);
  });
  const filteredRoot = graph.root && filteredNodeIds.has(graph.root.stableId)
    ? filteredNodes.find((node) => node.stableId === graph.root.stableId)
    : null;
  const filteredTargetIds = new Set((graph.targetFns || [])
    .map((node) => node.stableId)
    .filter((stableId) => filteredNodeIds.has(stableId)));

  return {
    root: filteredRoot,
    flowNodes: filteredNodes.filter((node) => !node.isRoot && !filteredTargetIds.has(node.stableId)),
    targetFns: filteredNodes.filter((node) => filteredTargetIds.has(node.stableId)),
    edges: filteredEdges,
    nodes: filteredNodes,
  };
}

function buildRuntimeCoverageFromNodeLogs(runtimeNodeLogs, requestedSessionId) {
  if (!runtimeNodeLogs) {
    return null;
  }

  if (!runtimeNodeLogs.available) {
    return {
      available: false,
      error: runtimeNodeLogs.error || 'Runtime logs are unavailable.',
      requestedSessionId: requestedSessionId || null,
      sessionId: runtimeNodeLogs.sessionId || requestedSessionId || null,
      usedLatestSessionFallback: false,
      latestSessionFallbackEnabled: false,
      coveredStableIds: [],
      coveredNodeCount: 0,
    };
  }

  const coveredStableIds = [...new Set((runtimeNodeLogs.nodes || [])
    .map((item) => item?.node?.stableId)
    .filter(Boolean))];

  return {
    available: true,
    error: null,
    requestedSessionId: requestedSessionId || null,
    sessionId: runtimeNodeLogs.sessionId || requestedSessionId || null,
    usedLatestSessionFallback: false,
    latestSessionFallbackEnabled: false,
    coveredStableIds,
    coveredNodeCount: coveredStableIds.length,
  };
}

export function renderFeatureFnGraphDrawio(feature, graph, { messages } = {}) {
  const lines = [];
  const nodes = [graph.root, ...graph.flowNodes, ...graph.targetFns].filter(Boolean);
  const laneLabels = getRepresentedLaneLabels(nodes);
  const laneXByLabel = new Map(laneLabels.map((label, index) => [label, FLOW_ORIGIN_X + index * (LANE_WIDTH + LANE_GAP)]));
  const { rowByNodeId, maxRow } = buildLaneNodeRows(graph);
  const boundsByNodeId = new Map();
  const nodeCellIds = new Map([[graph.root.stableId, 'fnRoot']]);

  const diagramWidth = Math.max(laneLabels.length * LANE_WIDTH + Math.max(laneLabels.length - 1, 0) * LANE_GAP + FLOW_ORIGIN_X * 2, 1200);
  const diagramHeight = Math.max(LANE_NODE_TOP_Y + (maxRow + 1) * FLOW_Y_GAP + 180, 1200);

  nodes.forEach((node) => {
    const laneLabel = getPrimaryLaneLabel(node);
    const laneX = laneXByLabel.get(laneLabel) || FLOW_ORIGIN_X;
    const row = rowByNodeId.get(node.stableId) || 0;
    boundsByNodeId.set(node.stableId, getLaneNodeBounds(node, laneX, row, graph.targetFns.some((target) => target.stableId === node.stableId)));
  });

  const branchingNodeIds = new Set(graph.nodes.filter((node) => node.isBranch).map((node) => node.stableId));
  const mergeNodeIds = new Set(graph.nodes.filter((node) => node.isMerge).map((node) => node.stableId));

  lines.push('<mxfile host="app.diagrams.net" modified="2026-05-20T00:00:00.000Z" agent="GitHub Copilot" version="24.7.17">');
  lines.push(`<diagram id="${escapeXml(String(feature?.key || feature?.stableId || 'feature-render'))}" name="Page-1">`);
  lines.push(`<mxGraphModel dx="${diagramWidth}" dy="${diagramHeight}" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${diagramWidth}" pageHeight="${diagramHeight}" math="0" shadow="0">`);
  lines.push('<root>');
  lines.push('<mxCell id="0" />');
  lines.push('<mxCell id="1" parent="0" />');

  const messagesText = getFeatureDrawMessagesText(messages);
  const messagesLine = messagesText ? `&#xa;notes: ${escapeXml(messagesText)}` : '';
  const titleValue = `feature render&#xa;feature: ${feature?.name || feature?.key || feature?.stableId || 'feature'}&#xa;head: ${feature?.stableId || 'unknown'}${messagesLine}`;
  addVertex(lines, 'title', escapeXml(titleValue), 'text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;whiteSpace=wrap;rounded=0;fontSize=16;fontStyle=1;', 20, 20, Math.max(diagramWidth - 40, 900), 50);

  laneLabels.forEach((laneLabel, index) => {
    const laneX = laneXByLabel.get(laneLabel) || FLOW_ORIGIN_X;
    addVertex(
      lines,
      `lane${index + 1}`,
      escapeXml(getPrimaryLaneTitle(laneLabel)),
      'swimlane;whiteSpace=wrap;html=1;rounded=0;horizontal=1;startSize=40;fillColor=#f7f7f7;strokeColor=#d0d0d0;fontColor=#333333;',
      laneX,
      LANE_TOP_Y,
      LANE_WIDTH,
      diagramHeight - LANE_TOP_Y - 40,
    );
  });

  const rootBounds = boundsByNodeId.get(graph.root.stableId) || [FN_ROOT_X, FN_ROOT_Y, 220, 80];
  addVertex(lines, 'fnRoot', buildRootLabel(graph.root), 'rounded=1;whiteSpace=wrap;html=1;fillColor=#9fbe99;strokeColor=#5f874f;fontStyle=1;fontColor=#000000;', ...rootBounds);

  [...graph.flowNodes].sort((left, right) => {
    const leftRow = rowByNodeId.get(left.stableId) || 0;
    const rightRow = rowByNodeId.get(right.stableId) || 0;
    const leftLane = getPrimaryLaneLabel(left);
    const rightLane = getPrimaryLaneLabel(right);
    return leftRow - rightRow
      || laneLabels.indexOf(leftLane) - laneLabels.indexOf(rightLane)
      || left.stableId.localeCompare(right.stableId);
  }).forEach((node, index) => {
    const cellId = `flow${index + 1}`;
    nodeCellIds.set(node.stableId, cellId);
    addVertex(lines, cellId, buildFlowLabel(node), getFlowStyle(node), ...(boundsByNodeId.get(node.stableId) || [FLOW_ORIGIN_X, FLOW_ORIGIN_Y, 220, 90]));
  });

  graph.targetFns.forEach((fn, index) => {
    const cellId = `targetFn${index + 1}`;
    nodeCellIds.set(fn.stableId, cellId);
    addVertex(lines, cellId, buildTargetFnLabel(fn), 'rounded=1;whiteSpace=wrap;html=1;fillColor=#9fbe99;strokeColor=#5f874f;fontColor=#000000;', ...(boundsByNodeId.get(fn.stableId) || [FLOW_ORIGIN_X, FN_ROOT_Y, 220, 70]));
  });

  [...graph.edges].sort((left, right) => {
    return String(left.fromId).localeCompare(String(right.fromId))
      || String(left.displayType).localeCompare(String(right.displayType))
      || String(left.toId).localeCompare(String(right.toId));
  }).forEach((edge, index) => {
    const sourceId = nodeCellIds.get(edge.fromId);
    const targetId = nodeCellIds.get(edge.toId);
    if (!sourceId || !targetId) {
      return;
    }
    const edgeValue = edge.displayLabel || edge.displayType || 'NEXT';
    addEdge(lines, `edge${index + 1}`, edgeValue, getEdgeStyle(edge), sourceId, targetId);
  });

  applyPostcheckPortSeparation(lines, boundsByNodeId, nodeCellIds, branchingNodeIds, mergeNodeIds);

  lines.push('</root>');
  lines.push('</mxGraphModel>');
  lines.push('</diagram>');
  lines.push('</mxfile>');

  return lines.join('');
}

function collectPathFunctionLikePositions(path) {
  return (path?.nodes || [])
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node?.stableId && (node.isFunction || node.isExternal));
}

function buildSequenceNodeLabel(node, { prefix } = {}) {
  const kind = node?.isExternal ? ':External' : 'Fn';
  const name = node?.name || node?.label || '<anonymous>';
  const location = node?.repoRelativePath || node?.location?.repoRelativePath || getShortStableSuffix(node?.stableId);
  const prefixLine = prefix ? `${escapeXml(prefix)}&#xa;` : '';
  return `${prefixLine}${escapeXml(kind)} ${escapeXml(name)}&#xa;${escapeXml(location)}`;
}

function buildSequenceParticipantLabel(node, fallbackName) {
  const name = node?.name || node?.label || fallbackName || '<anonymous>';
  const kind = node?.isExternal ? ':External' : 'Fn';
  const pathLabel = node?.repoRelativePath || node?.location?.repoRelativePath || '';
  return `${escapeXml(kind)}&#xa;${escapeXml(name)}${pathLabel ? `&#xa;${escapeXml(pathLabel)}` : ''}`;
}

function buildSequenceEdgeLabel(path, fromIndex, toIndex) {
  const rels = (path?.rels || []).slice(fromIndex, toIndex);
  const callRel = rels.find((rel) => rel?.role === 'call' || rel?.callTextRaw);
  if (callRel?.callTextRaw) {
    return shorten(callRel.callTextRaw, 54);
  }
  if (callRel?.label) {
    return shorten(callRel.label, 54);
  }
  const externalRel = rels.find((rel) => rel?.role === 'external' || rel?.type === 'EXTERNAL_BOUNDARY');
  if (externalRel?.label) {
    return shorten(externalRel.label, 54);
  }
  return shorten(rels.map((rel) => rel?.label || rel?.type).filter(Boolean).join(' / '), 54);
}

function getAllPathGraphPaths(pathGraph) {
  return [
    ...(pathGraph?.items || []).flatMap((item) => item?.paths || []),
    ...(pathGraph?.sideItems || []).flatMap((item) => item?.paths || []),
  ];
}

function findSequenceNode(pathGraph, predicate) {
  for (const path of getAllPathGraphPaths(pathGraph)) {
    for (const node of path?.nodes || []) {
      if (node?.stableId && (node.isFunction || node.isExternal) && predicate(node)) {
        return node;
      }
    }
  }
  return undefined;
}

function findSequenceNodeByName(pathGraph, name) {
  return findSequenceNode(pathGraph, (node) => node.name === name);
}

function findSequenceExternalByStablePrefix(pathGraph, stablePrefix) {
  return findSequenceNode(pathGraph, (node) => node.isExternal && String(node.stableId || '').startsWith(stablePrefix));
}

function findSequencePathBetween(pathGraph, fromName, toName) {
  for (const path of getAllPathGraphPaths(pathGraph)) {
    const positions = collectPathFunctionLikePositions(path);
    for (let index = 0; index < positions.length - 1; index += 1) {
      const current = positions[index];
      const next = positions[index + 1];
      if (current.node.name === fromName && next.node.name === toName) {
        return {
          path,
          fromIndex: current.index,
          toIndex: next.index,
        };
      }
    }
  }
  return undefined;
}

function findSequencePathToExternal(pathGraph, fromName, externalStablePrefix) {
  for (const path of getAllPathGraphPaths(pathGraph)) {
    const positions = collectPathFunctionLikePositions(path);
    for (let index = 0; index < positions.length - 1; index += 1) {
      const current = positions[index];
      const next = positions[index + 1];
      if (current.node.name === fromName && next.node.isExternal && String(next.node.stableId || '').startsWith(externalStablePrefix)) {
        return {
          path,
          fromIndex: current.index,
          toIndex: next.index,
        };
      }
    }
  }
  return undefined;
}

function buildFeatureLifelineSequence(feature, pathGraph) {
  const head = findSequenceNode(pathGraph, (node) => node.stableId === feature?.stableId)
    || findSequenceNodeByName(pathGraph, 'queryLoop');
  const buildQueryConfig = findSequenceNodeByName(pathGraph, 'buildQueryConfig');
  const llmWrapper = findSequenceNodeByName(pathGraph, 'queryModelWithStreaming');
  const llmExternal = findSequenceExternalByStablePrefix(pathGraph, 'external:llm:');
  const addTool = findSequenceNodeByName(pathGraph, 'addTool');
  const partitionToolCalls = findSequenceNodeByName(pathGraph, 'partitionToolCalls');
  const runTools = findSequenceNodeByName(pathGraph, 'runTools');
  const runToolsSerially = findSequenceNodeByName(pathGraph, 'runToolsSerially');
  const runToolsConcurrently = findSequenceNodeByName(pathGraph, 'runToolsConcurrently');
  const runToolUse = findSequenceNodeByName(pathGraph, 'runToolUse');
  const checkPermissionsAndCallTool = findSequenceNodeByName(pathGraph, 'checkPermissionsAndCallTool');
  const selectedToolExternal = findSequenceExternalByStablePrefix(pathGraph, 'external:dynamic-tool:tool.call');

  const participants = [
    { key: 'queryLoop', node: head, fallbackName: 'queryLoop' },
    { key: 'config', node: buildQueryConfig, fallbackName: 'buildQueryConfig' },
    { key: 'llmWrapper', node: llmWrapper, fallbackName: 'queryModelWithStreaming' },
    { key: 'llm', node: llmExternal, fallbackName: 'LLM' },
    { key: 'streaming', node: addTool, fallbackName: 'StreamingToolExecutor.addTool' },
    { key: 'runTools', node: runTools, fallbackName: 'runTools' },
    { key: 'partition', node: partitionToolCalls, fallbackName: 'partitionToolCalls' },
    { key: 'serial', node: runToolsSerially, fallbackName: 'runToolsSerially' },
    { key: 'concurrent', node: runToolsConcurrently, fallbackName: 'runToolsConcurrently' },
    { key: 'runToolUse', node: runToolUse, fallbackName: 'runToolUse' },
    { key: 'permissions', node: checkPermissionsAndCallTool, fallbackName: 'checkPermissionsAndCallTool' },
    { key: 'selectedTool', node: selectedToolExternal, fallbackName: 'selected tool boundary' },
  ].filter((participant, index, all) => {
    const stableId = participant.node?.stableId || participant.key;
    return index === all.findIndex((candidate) => (candidate.node?.stableId || candidate.key) === stableId);
  });

  const participantByKey = new Map(participants.map((participant) => [participant.key, participant]));
  const hasParticipant = (key) => participantByKey.has(key);
  const events = [];

  const addEvent = ({ from, to, label, response = false, note }) => {
    if (!hasParticipant(from) || !hasParticipant(to)) {
      return;
    }
    events.push({ from, to, label, response, note });
  };

  const labelBetween = (fromName, toName, fallback) => {
    const segment = findSequencePathBetween(pathGraph, fromName, toName);
    return segment ? buildSequenceEdgeLabel(segment.path, segment.fromIndex, segment.toIndex) : fallback;
  };
  const labelToExternal = (fromName, externalPrefix, fallback) => {
    const segment = findSequencePathToExternal(pathGraph, fromName, externalPrefix);
    return segment ? buildSequenceEdgeLabel(segment.path, segment.fromIndex, segment.toIndex) : fallback;
  };

  addEvent({
    from: 'queryLoop',
    to: 'config',
    label: labelBetween('queryLoop', 'buildQueryConfig', 'buildQueryConfig'),
    note: 'request setup / session gates',
  });
  addEvent({ from: 'config', to: 'queryLoop', label: 'config/context ready', response: true });
  addEvent({
    from: 'queryLoop',
    to: 'llmWrapper',
    label: labelBetween('queryLoop', 'queryModelWithStreaming', 'deps.callModel(...)'),
    note: 'messages/system/tools/mcpTools/toolPermissionContext',
  });
  addEvent({
    from: 'llmWrapper',
    to: 'llm',
    label: labelToExternal('queryModelWithStreaming', 'external:llm:', 'anthropic messages.create'),
  });
  addEvent({
    from: 'llm',
    to: 'queryLoop',
    label: 'assistant response: tool_use { name, input, id }',
    response: true,
  });
  addEvent({
    from: 'queryLoop',
    to: 'streaming',
    label: labelBetween('queryLoop', 'addTool', 'streamingToolExecutor.addTool(toolBlock, message)'),
    note: 'streaming branch',
  });
  addEvent({ from: 'streaming', to: 'runToolUse', label: 'can dispatch runToolUse(...)' });
  addEvent({
    from: 'queryLoop',
    to: 'runTools',
    label: labelBetween('queryLoop', 'runTools', 'runTools(toolUseBlocks, assistantMessages, ...)'),
    note: 'non-streaming branch',
  });
  addEvent({
    from: 'runTools',
    to: 'partition',
    label: labelBetween('runTools', 'partitionToolCalls', 'partitionToolCalls'),
  });
  addEvent({ from: 'partition', to: 'runTools', label: 'validated/classified calls', response: true });
  addEvent({
    from: 'runTools',
    to: 'concurrent',
    label: labelBetween('runTools', 'runToolsConcurrently', 'runToolsConcurrently'),
  });
  addEvent({
    from: 'runTools',
    to: 'serial',
    label: labelBetween('runTools', 'runToolsSerially', 'runToolsSerially'),
  });
  addEvent({
    from: 'serial',
    to: 'runToolUse',
    label: labelBetween('runToolsSerially', 'runToolUse', 'runToolUse(...)'),
  });
  addEvent({
    from: 'runToolUse',
    to: 'permissions',
    label: labelBetween('runToolUse', 'checkPermissionsAndCallTool', 'streamedCheckPermissionsAndCallTool / checkPermissionsAndCallTool'),
  });
  addEvent({
    from: 'permissions',
    to: 'selectedTool',
    label: labelToExternal('checkPermissionsAndCallTool', 'external:dynamic-tool:', 'tool.call(...)'),
  });
  addEvent({ from: 'selectedTool', to: 'permissions', label: 'tool output / progress', response: true });
  addEvent({ from: 'permissions', to: 'runToolUse', label: 'mapped tool result block', response: true });
  addEvent({ from: 'runToolUse', to: 'queryLoop', label: 'tool_result message for next model turn', response: true });

  return { participants, events };
}

function buildSequenceGraphFromPathGraph(feature, pathGraph) {
  const nodesById = new Map();
  const edgesByKey = new Map();
  const mainEdges = new Set();
  const mainPath = (pathGraph?.items || [])
    .flatMap((item) => item?.paths || [])
    .find((path) => path?.pathKind === 'artifact-backbone')
    || (pathGraph?.items || []).flatMap((item) => item?.paths || [])[0];
  const mainPositions = collectPathFunctionLikePositions(mainPath);
  const mainStableIds = mainPositions.map(({ node }) => node.stableId).filter(Boolean);

  const ensureNode = (node) => {
    if (!node?.stableId || (!node.isFunction && !node.isExternal)) {
      return;
    }
    if (nodesById.has(node.stableId)) {
      return;
    }
    nodesById.set(node.stableId, {
      stableId: node.stableId,
      name: node.name || node.label || '<anonymous>',
      label: node.label,
      labels: [...(node.labels || [])],
      isExternal: Boolean(node.isExternal),
      isFunction: Boolean(node.isFunction),
      repoRelativePath: node.repoRelativePath,
      location: node.location,
    });
  };

  const addEdge = (fromNode, toNode, { label, pathKind, isMain = false } = {}) => {
    if (!fromNode?.stableId || !toNode?.stableId || fromNode.stableId === toNode.stableId) {
      return;
    }
    ensureNode(fromNode);
    ensureNode(toNode);
    const key = `${fromNode.stableId}=>${toNode.stableId}`;
    const existing = edgesByKey.get(key) || {
      fromId: fromNode.stableId,
      toId: toNode.stableId,
      labels: new Set(),
      pathKinds: new Set(),
      isMain: false,
    };
    if (label) {
      existing.labels.add(label);
    }
    if (pathKind) {
      existing.pathKinds.add(pathKind);
    }
    existing.isMain = Boolean(existing.isMain || isMain);
    edgesByKey.set(key, existing);
    if (isMain) {
      mainEdges.add(key);
    }
  };

  for (let index = 0; index < mainPositions.length - 1; index += 1) {
    const current = mainPositions[index];
    const next = mainPositions[index + 1];
    addEdge(current.node, next.node, {
      label: buildSequenceEdgeLabel(mainPath, current.index, next.index),
      pathKind: 'backbone',
      isMain: true,
    });
  }

  const sidePaths = (pathGraph?.sideItems || []).flatMap((item) => item?.paths || []);
  for (const path of sidePaths) {
    const positions = collectPathFunctionLikePositions(path);
    for (let index = 0; index < positions.length - 1; index += 1) {
      const current = positions[index];
      const next = positions[index + 1];
      addEdge(current.node, next.node, {
        label: buildSequenceEdgeLabel(path, current.index, next.index),
        pathKind: path?.pathKind || 'context',
      });
    }
  }

  return {
    rootStableId: feature?.stableId || mainStableIds[0],
    mainStableIds,
    nodesById,
    edges: [...edgesByKey.values()].map((edge) => ({
      fromId: edge.fromId,
      toId: edge.toId,
      label: [...edge.labels][0] || [...edge.pathKinds][0] || '',
      pathKinds: [...edge.pathKinds],
      isMain: edge.isMain || mainEdges.has(`${edge.fromId}=>${edge.toId}`),
    })),
  };
}

function renderFeatureSequenceDrawio(feature, pathGraph, { messages } = {}) {
  const sequence = buildFeatureLifelineSequence(feature, pathGraph);
  const participantWidth = 170;
  const participantGap = 26;
  const leftMargin = 28;
  const topY = 118;
  const headerHeight = 74;
  const eventStartY = 250;
  const eventGap = 78;
  const diagramWidth = Math.max(1200, leftMargin * 2 + sequence.participants.length * participantWidth + Math.max(sequence.participants.length - 1, 0) * participantGap);
  const diagramHeight = Math.max(980, eventStartY + sequence.events.length * eventGap + 140);
  const lines = [];
  const participantXByKey = new Map();

  lines.push('<mxfile host="app.diagrams.net" modified="2026-05-20T00:00:00.000Z" agent="GitHub Copilot" version="24.7.17">');
  lines.push(`<diagram id="${escapeXml(String(feature?.key || feature?.stableId || 'feature-sequence'))}" name="Sequence">`);
  lines.push(`<mxGraphModel dx="${diagramWidth}" dy="${diagramHeight}" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${diagramWidth}" pageHeight="${diagramHeight}" math="0" shadow="0">`);
  lines.push('<root>');
  lines.push('<mxCell id="0" />');
  lines.push('<mxCell id="1" parent="0" />');

  const messagesText = getFeatureDrawMessagesText(messages);
  const title = `feature sequence&#xa;feature: ${feature?.name || feature?.key || feature?.stableId || 'feature'}&#xa;backbone paths: ${pathGraph?.backboneTotalPathCount || 0}; context branches: ${pathGraph?.sideTotalPathCount || 0}${messagesText ? `&#xa;${messagesText}` : ''}`;
  addVertex(lines, 'title', escapeXml(title), 'text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;whiteSpace=wrap;rounded=0;fontSize=16;fontStyle=1;', 20, 20, diagramWidth - 40, 74);

  sequence.participants.forEach((participant, index) => {
    const x = leftMargin + index * (participantWidth + participantGap);
    const cellId = `participant${index + 1}`;
    const axisId = `axis${index + 1}`;
    participantXByKey.set(participant.key, x + participantWidth / 2);

    const isExternal = participant.node?.isExternal;
    const isHead = participant.key === 'queryLoop';
    const headerStyle = isExternal
      ? 'rounded=1;whiteSpace=wrap;html=1;fillColor=#f4cccc;strokeColor=#b85450;fontColor=#000000;'
      : isHead
        ? 'rounded=1;whiteSpace=wrap;html=1;fillColor=#d9ead3;strokeColor=#5f874f;fontStyle=1;fontColor=#000000;'
        : 'rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontColor=#000000;';
    addVertex(lines, cellId, buildSequenceParticipantLabel(participant.node, participant.fallbackName), headerStyle, x, topY, participantWidth, headerHeight);
    addVertex(
      lines,
      axisId,
      '',
      'rounded=0;whiteSpace=wrap;html=1;fillColor=#d9d9d9;strokeColor=#a6a6a6;dashed=1;opacity=60;',
      x + participantWidth / 2 - 1,
      topY + headerHeight + 10,
      2,
      diagramHeight - topY - headerHeight - 70,
    );
  });

  sequence.events.forEach((event, index) => {
    const y = eventStartY + index * eventGap;
    const fromX = participantXByKey.get(event.from);
    const toX = participantXByKey.get(event.to);
    if (fromX === undefined || toX === undefined) {
      return;
    }
    const isResponse = Boolean(event.response);
    const pointColor = isResponse ? '#666666' : '#333333';
    const style = isResponse
      ? 'edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=open;dashed=1;strokeColor=#666666;'
      : 'edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;strokeColor=#333333;strokeWidth=2;';
    const sourcePointId = `msg-src-${index}`;
    const targetPointId = `msg-target-${index}`;
    const pointStyle = `ellipse;whiteSpace=wrap;html=1;aspect=fixed;fillColor=${pointColor};strokeColor=${pointColor};opacity=0;`;
    addVertex(lines, sourcePointId, '', pointStyle, fromX - 4, y - 4, 8, 8);
    addVertex(lines, targetPointId, '', pointStyle, toX - 4, y - 4, 8, 8);
    addEdge(lines, `seqMessage${index + 1}`, event.label || 'message', style, sourcePointId, targetPointId);
  });

  lines.push('</root>');
  lines.push('</mxGraphModel>');
  lines.push('</diagram>');
  lines.push('</mxfile>');
  return {
    drawioXml: lines.join(''),
    nodeCount: sequence.participants.length,
    edgeCount: sequence.events.length,
  };
}

export function buildFeaturePathGraphDrawDiagram(feature, pathGraph) {
  try {
    if (!feature?.stableId || !(feature?.endFnStableIds || []).length) {
      return buildFeatureDrawFailureResult(feature, {
        error: 'Feature selectors must resolve before graph-path draw can assemble paths and render a diagram.',
        messages: [buildFeatureDrawMessage(
          'FEATURE_SELECTOR_UNRESOLVED',
          'error',
          'Feature head/tail selectors are unresolved, so the feature graph-path draw cannot be rendered.',
        )],
      });
    }

    if (!pathGraph?.available) {
      return buildFeatureDrawFailureResult(feature, {
        error: pathGraph?.error || 'Feature graph-path data is unavailable.',
        payload: JSON.stringify({
          feature,
          pathGraph,
          drawMode: FEATURE_DRAW_MODE_GRAPH_PATH,
        }),
        messages: [buildFeatureDrawMessage(
          'GRAPH_PATH_UNAVAILABLE',
          'error',
          pathGraph?.error || 'Feature graph-path data is unavailable.',
        )],
      });
    }

    const paths = dedupeFeaturePaths([
      ...(pathGraph.items || []).flatMap((item) => item?.paths || []),
      ...(pathGraph.sideItems || []).flatMap((item) => item?.paths || []),
    ]);
    if (!paths.length) {
      return buildFeatureDrawFailureResult(feature, {
        error: `No graph-derived paths were found for ${feature?.key || feature?.stableId || 'feature'}.`,
        payload: JSON.stringify({
          feature,
          pathGraph,
          drawMode: FEATURE_DRAW_MODE_GRAPH_PATH,
        }),
        messages: [buildFeatureDrawMessage(
          'GRAPH_PATH_EMPTY',
          'error',
          `No graph-derived paths were found for ${feature?.key || feature?.stableId || 'feature'}.`,
        )],
      });
    }

    const graph = buildVirtualFeatureGraph(feature, paths);
    const messages = [buildFeatureDrawMessage(
      'GRAPH_PATH_RENDERED',
      'info',
      `Rendered Neo4j feature paths: backbone=${pathGraph.backboneTotalPathCount || 0}, external-side=${pathGraph.sideTotalPathCount || 0}, total=${paths.length}.`,
    )];
    const sequenceRender = renderFeatureSequenceDrawio(feature, pathGraph, { messages });
    const drawioXml = sequenceRender.drawioXml;
    const filePath = buildDefaultFeatureDrawPath(feature, 'graph-path-sequence-draw');
    writeTextFile(filePath, drawioXml);

    return {
      available: true,
      error: null,
      feature,
      saved: true,
      filePath,
      format: 'drawio',
      pathCount: paths.length,
      nodeCount: sequenceRender.nodeCount,
      edgeCount: sequenceRender.edgeCount,
      drawioXml,
      messages,
      payload: JSON.stringify({
        feature,
        pathGraph,
        drawMode: FEATURE_DRAW_MODE_GRAPH_PATH,
        drawStyle: 'sequence',
        graph,
      }),
    };
  } catch (error) {
    return buildFeatureDrawFailureResult(feature, {
      error: error instanceof Error ? error.message : String(error),
      messages: classifyFeatureDrawError(error, feature),
    });
  }
}

export async function buildFeatureDrawDiagram(driver, database, feature, {
  runtimeStore,
  sessionId,
  runtimeNodeLogs,
  useLatestSessionIfMissing = false,
  orchestratorConfig,
  featureJsonPath,
} = {}) {
  try {
    if (!feature?.stableId || !(feature?.endFnStableIds || []).length) {
      return buildFeatureDrawFailureResult(feature, {
        error: 'Feature selectors must resolve before buildDraw can assemble paths and render a diagram.',
        messages: [buildFeatureDrawMessage(
          'FEATURE_SELECTOR_UNRESOLVED',
          'error',
          'Feature head/tail selectors are unresolved, so the feature draw cannot be rendered.',
        )],
      });
    }

    const runtimeSeedGraph = buildRuntimeSeedGraph(feature, { featureJsonPath });
    const runtimeGraph = runtimeStore
      ? await withRuntimeRedisSession(runtimeStore, async (runtimeStoreSession) => buildRuntimeFeatureGraph(feature, runtimeSeedGraph, {
        runtimeStore: runtimeStoreSession,
        sessionId,
      }))
      : await buildRuntimeFeatureGraph(feature, runtimeSeedGraph, {
        runtimeStore,
        sessionId,
      });
    const messages = [];

    if (!runtimeGraph.available) {
      return buildFeatureDrawFailureResult(feature, {
        error: runtimeGraph.error || 'Runtime-chain draw is unavailable.',
        payload: JSON.stringify({
          feature,
          runtimeGraph,
          drawMode: FEATURE_DRAW_MODE_RUNTIME_CHAIN,
        }),
        messages: [buildFeatureDrawMessage(
          'RUNTIME_CHAIN_UNAVAILABLE',
          'error',
          runtimeGraph.error || 'Runtime-chain draw is unavailable.',
        )],
      });
    }

    if (!runtimeGraph.graph?.nodes?.length) {
      return buildFeatureDrawFailureResult(feature, {
        error: `No current Redis-backed runtime chains were found for ${feature?.key || feature?.stableId || 'feature'}.`,
        payload: JSON.stringify({
          feature,
          runtimeGraph,
          drawMode: FEATURE_DRAW_MODE_RUNTIME_CHAIN,
        }),
        messages: [buildFeatureDrawMessage(
          'RUNTIME_CHAIN_EMPTY',
          'error',
          `No current Redis-backed runtime chains were found for ${feature?.key || feature?.stableId || 'feature'}.`,
        )],
      });
    }

    messages.push(buildFeatureDrawMessage(
      'RUNTIME_CHAIN_RENDERED',
      'info',
      `Rendered merged Redis runtime chains for ${runtimeGraph.graph.nodes.length} nodes and ${runtimeGraph.graph.edges.length} edges.`,
    ));

    if (runtimeGraph.comparison?.matchedTransitionCount || runtimeGraph.comparison?.runtimeOnlyTransitionCount || runtimeGraph.comparison?.staticOnlyTransitionCount) {
      messages.push(buildFeatureDrawMessage(
        'RUNTIME_STATIC_COMPARISON',
        'info',
        `Redis runtime transitions: matched=${runtimeGraph.comparison.matchedTransitionCount || 0}, runtime-only=${runtimeGraph.comparison.runtimeOnlyTransitionCount || 0}, static-only=${runtimeGraph.comparison.staticOnlyTransitionCount || 0}.`,
      ));
    }

    const drawioXml = renderFeatureFnGraphDrawio(feature, runtimeGraph.graph, { messages });
    const filePath = buildDefaultFeatureDrawPath(feature, 'runtime-chain-draw');
    writeTextFile(filePath, drawioXml);

    return {
      available: true,
      error: null,
      feature,
      saved: true,
      filePath,
      format: 'drawio',
      pathCount: 0,
      nodeCount: runtimeGraph.graph.nodes.length,
      edgeCount: runtimeGraph.graph.edges.length,
      drawioXml,
      messages,
      payload: JSON.stringify({
        feature,
        runtimeGraph,
        drawMode: FEATURE_DRAW_MODE_RUNTIME_CHAIN,
        graph: runtimeGraph.graph,
      }),
    };
  } catch (error) {
    return buildFeatureDrawFailureResult(feature, {
      error: error instanceof Error ? error.message : String(error),
      messages: classifyFeatureDrawError(error, feature),
    });
  }
}


