import fs from 'node:fs';
import path from 'node:path';

import neo4j from 'neo4j-driver';

import { isFunctionFlowTraversalRelationship } from './relationshipSemantics.js';

const DEFAULT_FN_STABLE_ID = 'screens/REPL.tsx:3142:31:3533:3';
const SOURCE = 'semantic/functionFlowGraph';

function readEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const env = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (!/^\s*[^#][^=]*=/.test(line)) continue;
    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    if (Object.prototype.hasOwnProperty.call(env, key)) continue;
    env[key] = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return env;
}

function toPlain(value) {
  if (neo4j.isInt(value)) return value.inSafeRange() ? value.toNumber() : value.toString();
  if (Array.isArray(value)) return value.map(toPlain);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = toPlain(item);
    return result;
  }
  return value;
}

const GRAPH_PROPERTY_ALIASES = {
  operationIndex: 'operation_index',
  operationCode: 'operation_code',
  operationSubjectText: 'operation_subject_text',
  operationValueText: 'operation_value_text',
  operationCalleeText: 'operation_callee_text',
  operationDetailPresent: 'operation_detail_present',
  operationDetailSize: 'operation_detail_size',
  conditionRaw: 'condition_raw',
  actionTextRaw: 'action_text_raw',
  callTextRaw: 'call_text_raw',
  repoRelativePath: 'repo_relative_path',
  filePath: 'file_path',
  startLine: 'start_line',
  startColumn: 'start_column',
  endLine: 'end_line',
  endColumn: 'end_column',
  sourceStateId: 'source_state_id',
  resourceKind: 'resource_kind',
  resourceSubkind: 'resource_subkind',
  settingKind: 'setting_kind',
  settingSubkind: 'setting_subkind',
};

function normalizeGraphProps(props) {
  const normalized = { ...(props || {}) };
  for (const [legacyKey, canonicalKey] of Object.entries(GRAPH_PROPERTY_ALIASES)) {
    if (Object.prototype.hasOwnProperty.call(normalized, legacyKey)
      && !Object.prototype.hasOwnProperty.call(normalized, canonicalKey)) {
      normalized[canonicalKey] = normalized[legacyKey];
    }
    delete normalized[legacyKey];
  }
  return normalized;
}

function sanitizeLabels(labels) {
  return [...new Set((labels || [])
    .map((label) => String(label || '').trim())
    .filter((label) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(label))
    .filter((label) => !['FlowNode', 'FlowArtifact'].includes(label)))];
}

function sanitizeRelType(type) {
  const relType = String(type || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(relType)) {
    throw new Error(`Unsafe relationship type: ${type}`);
  }
  return relType;
}

function isValueAccessSemanticEdgeType(type) {
  return /_VALUE$/u.test(String(type || '')) || type === 'SHORT_CIRCUITS';
}

function isProjectionOnlySemanticEdge(edge) {
  // Extracted family boundaries are coordinate input even when a mosaic seam
  // hides their line. Projection must not have to recreate graph structure.
  if (['ARG', 'ArgJoin', 'FIELD', 'FieldJoin'].includes(edge.type)) return false;
  if (edge.props?.semantic_expansion === 'collection-iteration') return false;
  // State updater callbacks now extract their final boundary directly:
  // argument convergence -> virtual result.set -> enclosing call close.
  // The final NEXT is layout input, not an inferred projection edge.
  if (edge.type === 'NEXT' && edge.props?.semantic_expansion === 'state-update') return false;
  return isValueAccessSemanticEdgeType(edge.type)
    || edge.props?.semantic_expansion === 'primitive-execution'
    || edge.props?.semantic_expansion === 'receiver-method'
    || edge.props?.semantic_expansion === 'operand-evaluation'
    || edge.props?.semantic_expansion === 'call-execution'
    || edge.props?.semantic_expansion === 'state-update'
    || edge.props?.flow_layer === 'structure';
}

function isUiStateResourceValueEdge(edge, nodeByKey) {
  if (!['READS_VALUE', 'WRITES_VALUE', 'CLEARS_VALUE'].includes(edge.type)) return false;
  const source = nodeByKey.get(edge.start);
  const target = nodeByKey.get(edge.end);
  const sourceLabels = new Set(source?.labels || []);
  const labels = new Set(target?.labels || []);
  return sourceLabels.has('Start')
    && sourceLabels.has('Write')
    && source?.props?.call_boundary_design !== 'split'
    && labels.has('UiState')
    && (labels.has('Storage') || labels.has('Cell'));
}

function stableKeyForNode(node) {
  return node.props.stableId
    || node.props.object_key
    || node.props.key
    || node.props.id;
}

function numeric(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sortBySourceOrder(left, right) {
  return (numeric(left.props.operation_index, Number.MAX_SAFE_INTEGER) - numeric(right.props.operation_index, Number.MAX_SAFE_INTEGER))
    || (numeric(left.props.start_line, Number.MAX_SAFE_INTEGER) - numeric(right.props.start_line, Number.MAX_SAFE_INTEGER))
    || (numeric(left.props.start_column, Number.MAX_SAFE_INTEGER) - numeric(right.props.start_column, Number.MAX_SAFE_INTEGER))
    || String(left.key).localeCompare(String(right.key));
}

function isDiagramParticipant(node) {
  if (!node) return false;
  if (node.props?.renderHidden === true || node.props?.renderHidden === 'true') return false;
  const labels = new Set(node.labels || []);
  if (labels.has('Fn') && String(node.key || '').includes(':local-function-body:start')) return true;
  return [
    'Step',
    'Read',
    'ValueAccess',
    'Boundary',
    'FnDeclaration',
    'Branch',
    'Switch',
    'Case',
    'Join',
    'Return',
    'FunctionEnd',
    'BreakStop',
    'ThrowStop',
    'Call',
    'Request',
    'Value',
    'DataJoin',
    'UpdaterFn',
    'CallbackFn',
    'AsyncContinuation',
    'UiInjection',
    'VirtualView',
    'Arg',
    'Object',
    'Field',
    'Operand',
  ].some((label) => labels.has(label));
}

function isFlowNode(node) {
  return isDiagramParticipant(node);
}

function isCentralNode(node, fnStableId) {
  return node.key === fnStableId || isDiagramParticipant(node);
}

function isBranchNode(node) {
  return node.labels.includes('Branch') || node.labels.includes('Switch') || node.labels.includes('Case');
}

function isArgNode(node) {
  return node?.labels?.includes('Arg');
}

function isCallNode(node) {
  return node?.labels?.includes('Call') || node?.labels?.includes('Request');
}

function isMergeArgsNode(node) {
  return node?.labels?.includes('Arg') && node?.labels?.includes('Join');
}

function isArgsNode(node) {
  return isMergeArgsNode(node) || node?.labels?.includes('DataJoin');
}

function isObjectNode(node) {
  return node?.labels?.includes('Object');
}

function isMergeFieldsNode(node) {
  return node?.labels?.includes('Field') && node?.labels?.includes('Join');
}

function isObjectFieldNode(node) {
  const labels = new Set(node?.labels || []);
  return labels.has('Field') && !labels.has('Join') && !labels.has('Branch');
}

function uniqueGraphRecordsByElementId(records) {
  return [...new Map(records.map((record) => [record.elementId, record])).values()];
}

function isMergeNode(node) {
  return node?.labels?.includes('Flow') && node?.labels?.includes('Join');
}

function isUiNode(node) {
  const labels = new Set(node.labels || []);
  const kind = String(node.props.resource_kind || '').toLowerCase();
  const subkind = String(node.props.resource_subkind || '').toLowerCase();
  return labels.has('UiState')
    || labels.has('InputState')
    || labels.has('UiEffect')
    || labels.has('UiInput')
    || kind === 'ui-state'
    || kind === 'input-state'
    || kind === 'ui-effect'
    || subkind.includes('ui');
}

function isCentralEdge(edge, byKey, fnStableId) {
  const start = byKey.get(edge.start);
  const end = byKey.get(edge.end);
  if (!start || !end) return false;
  if (start.key === fnStableId && isFlowNode(end)) return true;
  if (!isFlowNode(start) || !isFlowNode(end)) return false;
  return !['CALL', 'REQUEST', 'SUBSCRIBE', 'CALLBACK'].includes(edge.type);
}

function isCallLikeEdge(edge) {
  return edge?.type === 'CALL' || edge?.type === 'REQUEST';
}

function shouldProxySharedTarget(node, fnStableId) {
  if (!node || node.key === fnStableId) return false;
  const labels = new Set(node.labels || []);
  if (!labels.has('Fn')) return false;
  if (isFlowNode(node) || labels.has('Branch') || labels.has('Join') || labels.has('FunctionEnd')) return false;
  return true;
}

function materializeVisualProxies(nodes, edges, fnStableId) {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const incomingCallsByTarget = new Map();
  for (const edge of edges) {
    if (!isCallLikeEdge(edge)) continue;
    const target = byKey.get(edge.end);
    const source = byKey.get(edge.start);
    if (!source || !isFlowNode(source) || !shouldProxySharedTarget(target, fnStableId)) continue;
    if (!incomingCallsByTarget.has(edge.end)) incomingCallsByTarget.set(edge.end, []);
    incomingCallsByTarget.get(edge.end).push(edge);
  }

  const proxyNodes = [];
  const proxyKeyByEdgeId = new Map();
  const fnProxyBySource = new Map();
  const proxiedFnKeys = new Set();
  for (const [targetKey, targetEdges] of incomingCallsByTarget.entries()) {
    const sortedEdges = [...targetEdges].sort((left, right) => {
      const leftSource = byKey.get(left.start);
      const rightSource = byKey.get(right.start);
      return sortBySourceOrder(leftSource || { key: left.start, props: {}, labels: [] }, rightSource || { key: right.start, props: {}, labels: [] })
        || String(left.id).localeCompare(String(right.id));
    });
    if (sortedEdges.length < 2) continue;

    proxiedFnKeys.add(targetKey);
    const canonical = byKey.get(targetKey);
    sortedEdges.forEach((edge, index) => {
      const copyIndex = index + 1;
      const copyCount = sortedEdges.length;
      const key = `visual-proxy:${edge.id}:${targetKey}`;
      proxyKeyByEdgeId.set(edge.id, key);
      if (!fnProxyBySource.has(edge.start)) fnProxyBySource.set(edge.start, []);
      fnProxyBySource.get(edge.start).push({
        fnProxyKey: key,
        canonicalTargetKey: targetKey,
        sourceEdgeId: edge.id,
        copyIndex,
        copyCount,
      });
      proxyNodes.push({
        key,
        labels: ['LocalVisualProxy', 'VisualProxy', 'FnProxy'],
        props: {
          stableId: key,
          label: canonical.props.label || canonical.props.name || targetKey,
          name: canonical.props.name || canonical.props.label || 'function',
          canonicalStableId: targetKey,
          visualInstanceOfStableId: targetKey,
          sourceCallStableId: edge.start,
          sourceEdgeStableId: edge.id,
          visualCopyIndex: copyIndex,
          visualCopyCount: copyCount,
          visualProxyKind: 'shared-call-target',
          layoutRole: 'visual-proxy',
          layoutReason: `Visual proxy ${copyIndex}/${copyCount}: shared CALL target copied next to caller to avoid cross-diagram dependency lines`,
        },
      });
    });
  }

  const endIncomingEdges = edges
    .filter((edge) => {
      const target = byKey.get(edge.end);
      const source = byKey.get(edge.start);
      return target?.labels.includes('FunctionEnd')
        && isFlowNode(source);
    })
    .sort((left, right) => {
      const leftSource = byKey.get(left.start);
      const rightSource = byKey.get(right.start);
      return sortBySourceOrder(leftSource || { key: left.start, props: {}, labels: [] }, rightSource || { key: right.start, props: {}, labels: [] })
        || String(left.id).localeCompare(String(right.id));
    });
  const endProxyKeyByEdgeId = new Map();
  const proxiedEndKeys = new Set();
  const endIncomingEdgesByTarget = new Map();
  endIncomingEdges.forEach((edge) => {
    if (!endIncomingEdgesByTarget.has(edge.end)) endIncomingEdgesByTarget.set(edge.end, []);
    endIncomingEdgesByTarget.get(edge.end).push(edge);
  });
  for (const groupedEndIncomingEdges of endIncomingEdgesByTarget.values()) {
    if (groupedEndIncomingEdges.length <= 1) continue;
    groupedEndIncomingEdges.forEach((edge, index) => {
      const canonical = byKey.get(edge.end);
      const copyIndex = index + 1;
      const copyCount = groupedEndIncomingEdges.length;
      const key = `visual-proxy-end:${edge.id}:${edge.end}`;
      proxiedEndKeys.add(edge.end);
      endProxyKeyByEdgeId.set(edge.id, {
        key,
        canonicalTargetKey: edge.end,
      });
      proxyNodes.push({
        key,
        labels: ['LocalVisualProxy', 'VisualProxy', 'EndProxy', 'FunctionEnd'],
        props: {
          ...canonical.props,
          stableId: key,
          label: 'End',
          canonicalStableId: edge.end,
          visualInstanceOfStableId: edge.end,
          sourceCallStableId: edge.start,
          sourceEdgeStableId: edge.id,
          visualCopyIndex: copyIndex,
          visualCopyCount: copyCount,
          visualProxyKind: 'function-end',
          layoutRole: 'visual-proxy-end',
          layoutReason: `Visual end proxy ${copyIndex}/${copyCount}: function end copied next to incoming branch to avoid long convergence lines`,
        },
      });
    });
  }

  if (!proxyNodes.length) return { nodes, edges, proxyCount: 0 };

  const rewrittenEdges = edges.map((edge) => {
    const proxyKey = proxyKeyByEdgeId.get(edge.id);
    if (proxyKey) {
      return {
        ...edge,
        end: proxyKey,
        props: {
          ...edge.props,
          targetStableId: proxyKey,
          canonicalTargetStableId: edge.end,
          visualTargetProxyStableId: proxyKey,
          visualProxyKind: 'shared-call-target',
        },
      };
    }
    return edge;
  }).map((edge) => {
    const endProxy = endProxyKeyByEdgeId.get(edge.id);
    if (!endProxy) return edge;
    return {
      ...edge,
      end: endProxy.key,
      props: {
        ...edge.props,
        targetStableId: endProxy.key,
        canonicalTargetStableId: endProxy.canonicalTargetKey,
        visualTargetProxyStableId: endProxy.key,
        visualProxyKind: 'function-end',
      },
    };
  }).filter((edge) => !proxiedEndKeys.has(edge.start) && !proxiedEndKeys.has(edge.end));

  const visibleNodes = nodes
    .filter((node) => !proxiedEndKeys.has(node.key))
    .map((node) => {
      if (!proxiedFnKeys.has(node.key)) return node;
      return {
        ...node,
        props: {
          ...node.props,
          renderHidden: true,
          renderSkipReason: 'canonical Fn has visual call-site proxies',
          visualProxyCount: proxyNodes.filter((proxy) => proxy.props.canonicalStableId === node.key).length,
        },
      };
    });
  return {
    nodes: [...visibleNodes, ...proxyNodes],
    edges: rewrittenEdges,
    proxyCount: proxyNodes.length,
  };
}

function findFollowingMergeOp(branch, nodes) {
  const branchOp = numeric(branch.props.operation_index, null);
  if (branchOp === null) return null;
  const candidates = nodes
    .filter((node) => isMergeNode(node))
    .map((node) => numeric(node.props.operation_index, null))
    .filter((op) => op !== null && op > branchOp)
    .sort((a, b) => a - b);
  return candidates[0] ?? null;
}

function reachableCentralKeys(startKey, outgoingCentral, centralByKey, limit = 500) {
  const seen = new Set();
  const queue = [startKey];
  while (queue.length && seen.size < limit) {
    const key = queue.shift();
    if (!key || seen.has(key) || !centralByKey.has(key)) continue;
    seen.add(key);
    for (const edge of outgoingCentral.get(key) || []) {
      if (centralByKey.has(edge.end) && !seen.has(edge.end)) queue.push(edge.end);
    }
  }
  return seen;
}

function findBranchJoinOp(branch, outgoing, outgoingCentral, centralByKey) {
  const branchOp = numeric(branch.props.operation_index, null);
  if (branchOp === null || outgoing.length < 2) return null;
  const maxDirectTargetOp = Math.max(...outgoing.map((item) => numeric(item.target.props.operation_index, branchOp)));
  const reachableSets = outgoing.map((item) => reachableCentralKeys(item.edge.end, outgoingCentral, centralByKey));
  const commonKeys = [...reachableSets[0]]
    .filter((key) => reachableSets.every((set) => set.has(key)));
  const commonOps = commonKeys
    .map((key) => ({
      key,
      node: centralByKey.get(key),
      op: numeric(centralByKey.get(key)?.props.operation_index, null),
    }))
    .filter((item) => item.op !== null && item.op > branchOp && item.op >= maxDirectTargetOp)
    .filter((item) => !item.node?.labels.includes('FunctionEnd'))
    .map((item) => item.op)
    .sort((left, right) => left - right);
  return commonOps[0] ?? null;
}

function coordinateLocalGraph(nodes, edges, fnStableId) {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const centralNodes = nodes.filter((node) => isCentralNode(node, fnStableId)).sort(sortBySourceOrder);
  const centralByKey = new Map(centralNodes.map((node) => [node.key, node]));
  const centralEdges = edges.filter((edge) => isCentralEdge(edge, byKey, fnStableId));
  const positions = new Map();

  positions.set(fnStableId, {
    x: 0,
    y: 0,
    role: 'head',
    reason: 'Function head: fixed at unit coordinate 0,0',
  });

  centralNodes
    .filter((node) => node.key !== fnStableId)
    .forEach((node, index) => {
      positions.set(node.key, {
        x: null,
        y: null,
        role: isBranchNode(node) ? 'branch' : isMergeNode(node) ? 'merge' : node.labels.includes('FunctionEnd') ? 'end' : node.labels.includes('Return') ? 'return' : 'step',
        sourceOrderY: index + 1,
        reason: 'Pending semantic placement: flow edges assign row/column before rendering',
      });
    });

  const outgoingCentral = new Map();
  const incomingCentral = new Map();
  for (const edge of centralEdges) {
    if (!outgoingCentral.has(edge.start)) outgoingCentral.set(edge.start, []);
    outgoingCentral.get(edge.start).push(edge);
    if (!incomingCentral.has(edge.end)) incomingCentral.set(edge.end, []);
    incomingCentral.get(edge.end).push(edge);
  }

  const dxByEdge = new Map();
  for (const edge of centralEdges) dxByEdge.set(edge.id, 0);

  for (const branch of centralNodes.filter(isBranchNode)) {
    const outgoing = (outgoingCentral.get(branch.key) || [])
      .filter((edge) => centralByKey.has(edge.end))
      .map((edge) => ({ edge, target: centralByKey.get(edge.end) }));
    if (outgoing.length < 2) continue;

    const mergeOp = findBranchJoinOp(branch, outgoing, outgoingCentral, centralByKey)
      ?? findFollowingMergeOp(branch, centralNodes);
    const ranked = outgoing
      .map((item) => {
        const targetOp = numeric(item.target.props.operation_index, Number.MAX_SAFE_INTEGER);
        const len = mergeOp === null || targetOp > mergeOp ? Number.MAX_SAFE_INTEGER : mergeOp - targetOp;
        return { ...item, len, targetOp };
      })
      .sort((left, right) => (left.len - right.len) || (left.targetOp - right.targetOp) || String(left.edge.end).localeCompare(String(right.edge.end)));

    ranked.forEach((item, rank) => {
      dxByEdge.set(item.edge.id, rank);
      item.edge.layoutBranchRole = rank === 0 ? 'down-shorter' : 'right-longer';
      item.edge.layoutBranchLen = Number.isFinite(item.len) ? item.len : null;
      item.edge.layoutMergeOp = mergeOp;
    });
  }

  const entryEdges = centralEdges
    .filter((edge) => edge.start === fnStableId && centralByKey.has(edge.end))
    .sort((left, right) => sortBySourceOrder(centralByKey.get(left.end), centralByKey.get(right.end)));
  if (entryEdges[0]) {
    const pos = positions.get(entryEdges[0].end);
    positions.set(entryEdges[0].end, {
      ...pos,
      x: 0,
      y: 1,
      reason: 'Entry FlowNode selected as first local target of Fn',
    });
  }

  placeCentralFlow(centralNodes, centralEdges, positions, fnStableId);

  for (const node of centralNodes) {
    const pos = positions.get(node.key);
    if (pos && (pos.x === null || pos.y === null)) {
      const fallbackY = Number.isFinite(pos.sourceOrderY) ? pos.sourceOrderY : numeric(node.props.operation_index, 0);
      positions.set(node.key, {
        ...pos,
        x: pos.x ?? 0,
        y: pos.y ?? fallbackY,
        reason: `${pos.reason}; fallback placement: not reached from function entry during semantic flow placement`,
      });
    }
  }

  enforceDownBranchYOrder(centralEdges, positions);
  positionMergeNodesBeforeTargets(centralNodes, centralEdges, positions);
  applyArgumentParallelLayout(nodes, edges, positions);
  reserveRightBranchFootprintsAfterFamilies(nodes, edges, centralEdges, positions);
  const mergeNextTargetByKey = buildMergeNextTargetByKey(centralNodes, centralEdges);
  for (const edge of centralEdges) {
    if (mergeNextTargetByKey.has(edge.end)) {
      edge.layoutEffectiveTargetStableId = mergeNextTargetByKey.get(edge.end);
    }
  }

  const sideCounters = new Map();
  const sideNodes = nodes.sort(sortBySourceOrder).filter((node) => !positions.has(node.key));

  function resolveSideAnchor(node) {
    const incoming = edges.find((edge) => edge.end === node.key && positions.has(edge.start));
    const parentEdge = edges.find((edge) => edge.start === node.key && edge.type === 'PART' && positions.has(edge.end));
    const parentKey = node.props.parentStableId || node.props.resource_semantic_id || null;
    const parentPos = parentKey ? positions.get(parentKey) : null;
    return incoming
      ? { pos: positions.get(incoming.start), type: incoming.type, key: incoming.start, direction: 'incoming' }
      : parentEdge
        ? { pos: positions.get(parentEdge.end), type: parentEdge.type, key: parentEdge.end, direction: 'parent-edge' }
        : parentPos
          ? { pos: parentPos, type: 'parentStableId', key: parentKey, direction: 'parent-key' }
          : null;
  }

  function placeSideNode(node, anchor) {
    const side = node.labels.includes('ResourceProxy') ? 'right' : isUiNode(node) ? 'left' : 'right';
    const slotKey = `${side}:${anchor.pos.y}`;
    const ordinal = sideCounters.get(slotKey) || 0;
    sideCounters.set(slotKey, ordinal + 1);
    positions.set(node.key, {
      x: anchor.pos.x + (side === 'left' ? -1.4 : 1.4),
      y: anchor.pos.y + ordinal * 0.55,
      role: side === 'left' ? 'ui-side' : 'resource-side',
      reason: `Side node derived from ${anchor.type} ${anchor.direction} ${anchor.key}; side=${side}; ordinal=${ordinal}`,
    });
  }

  for (let pass = 0; pass < sideNodes.length + 2; pass += 1) {
    let changed = false;
    for (const node of sideNodes) {
      if (positions.has(node.key)) continue;
      const anchor = resolveSideAnchor(node);
      if (!anchor) continue;
      placeSideNode(node, anchor);
      changed = true;
    }
    if (!changed) break;
  }

  for (const node of sideNodes) {
    if (positions.has(node.key)) continue;
    placeSideNode(node, { pos: { x: 0, y: 0 }, type: 'fallback', key: 'none', direction: 'none' });
  }

  const { layoutJunctions } = routeEdgesOnCoordinateGrid(edges, positions, nodes);

  return { positions, layoutJunctions, centralEdgeCount: centralEdges.length };
}

function isFlowPlacementEdge(edge) {
  return ['NEXT', 'TRUE', 'FALSE', 'REJOINS', 'MERGES_TO'].includes(edge.type);
}

function desiredTargetPositionForFlowEdge(edge, sourcePos) {
  if (edge.layoutBranchRole === 'right-longer') {
    return {
      x: sourcePos.x + 1,
      y: sourcePos.y,
      xPriority: 70,
      reason: `right branch from ${edge.start}`,
    };
  }
  const xPriority = edge.layoutBranchRole === 'down-shorter' ? 90 : (edge.type === 'REJOINS' || edge.type === 'MERGES_TO') ? 60 : 50;
  return {
    x: sourcePos.x,
    y: sourcePos.y + 1,
    xPriority,
    reason: edge.layoutBranchRole === 'down-shorter'
      ? `down branch from ${edge.start}`
      : `${edge.type} from ${edge.start}`,
  };
}

function placeCentralFlow(centralNodes, centralEdges, positions, fnStableId) {
  const nodeByKey = new Map(centralNodes.map((node) => [node.key, node]));
  const flowEdges = centralEdges
    .filter(isFlowPlacementEdge)
    .filter((edge) => nodeByKey.has(edge.end));
  const orderByKey = new Map(centralNodes.map((node, index) => [node.key, index]));
  const outgoingBySource = new Map();
  const incomingByTarget = new Map();
  for (const edge of flowEdges) {
    if (!outgoingBySource.has(edge.start)) outgoingBySource.set(edge.start, []);
    outgoingBySource.get(edge.start).push(edge);
    if (!incomingByTarget.has(edge.end)) incomingByTarget.set(edge.end, []);
    incomingByTarget.get(edge.end).push(edge);
  }

  function sortNodesForPlacement(left, right) {
    const leftPos = positions.get(left.key);
    const rightPos = positions.get(right.key);
    return (numeric(leftPos?.y, Number.MAX_SAFE_INTEGER) - numeric(rightPos?.y, Number.MAX_SAFE_INTEGER))
      || (numeric(leftPos?.x, Number.MAX_SAFE_INTEGER) - numeric(rightPos?.x, Number.MAX_SAFE_INTEGER))
      || sortBySourceOrder(left, right);
  }

  function setPos(key, next, reason) {
    const prev = positions.get(key);
    if (!prev) return false;
    const nextX = roundGrid(next.x);
    const nextY = roundGrid(next.y);
    const nextXPriority = Number.isFinite(next.xPriority) ? next.xPriority : prev.xPriority;
    if (prev.x === nextX && prev.y === nextY && prev.xPriority === nextXPriority) return false;
    positions.set(key, {
      ...prev,
      x: nextX,
      y: nextY,
      xPriority: nextXPriority,
      reason: `${prev.reason}; placed ${nextX},${nextY}: ${reason}`,
    });
    return true;
  }

  function relaxFlowEdges() {
    let changed = false;
    const orderedEdges = [...flowEdges].sort((left, right) => {
      const leftSource = nodeByKey.get(left.start);
      const rightSource = nodeByKey.get(right.start);
      const sourceCompare = sortBySourceOrder(leftSource || { props: {}, key: left.start }, rightSource || { props: {}, key: right.start });
      return sourceCompare || String(left.id).localeCompare(String(right.id));
    });

    for (const edge of orderedEdges) {
      const sourcePos = positions.get(edge.start);
      const targetPos = positions.get(edge.end);
      if (!sourcePos || !targetPos || !Number.isFinite(sourcePos.x) || !Number.isFinite(sourcePos.y)) continue;
      const desired = desiredTargetPositionForFlowEdge(edge, sourcePos);
      const unplaced = !Number.isFinite(targetPos.x) || !Number.isFinite(targetPos.y);
      const shouldMoveDown = Number.isFinite(targetPos.y) && targetPos.y < desired.y;
      const currentXPriority = Number.isFinite(targetPos.xPriority) ? targetPos.xPriority : 0;
      const shouldAdoptX = !Number.isFinite(targetPos.x)
        || desired.xPriority > currentXPriority;
      if (unplaced || shouldMoveDown || shouldAdoptX) {
        const desiredY = shouldMoveDown || unplaced ? desired.y : targetPos.y;
        const desiredX = shouldAdoptX || unplaced ? desired.x : targetPos.x;
        const nextX = edge.layoutBranchRole === 'right-longer'
          ? firstFreeRightColumn(desiredX, desiredY, new Set([edge.start, edge.end]))
          : desiredX;
        changed = setPos(edge.end, {
          x: nextX,
          y: desiredY,
          xPriority: shouldAdoptX || unplaced ? desired.xPriority : targetPos.xPriority,
        }, nextX === desiredX ? desired.reason : `${desired.reason}; shifted to free vertical axis x ${desiredX}->${nextX}`) || changed;
      }
    }
    return changed;
  }

  function backPlaceDanglingSources() {
    let changed = false;
    const orderedEdges = [...flowEdges].sort((left, right) => {
      const leftTarget = nodeByKey.get(left.end);
      const rightTarget = nodeByKey.get(right.end);
      return sortBySourceOrder(leftTarget || { props: {}, key: left.end }, rightTarget || { props: {}, key: right.end })
        || String(left.id).localeCompare(String(right.id));
    });

    for (const edge of orderedEdges) {
      const sourcePos = positions.get(edge.start);
      const targetPos = positions.get(edge.end);
      if (!sourcePos || !targetPos) continue;
      if (Number.isFinite(sourcePos.x) && Number.isFinite(sourcePos.y)) continue;
      if (!Number.isFinite(targetPos.x) || !Number.isFinite(targetPos.y)) continue;

      const previousY = Math.max(1, targetPos.y - 1);
      changed = setPos(edge.start, {
        x: targetPos.x,
        y: previousY,
        xPriority: 40,
      }, `back-placed dangling source before ${edge.type} target ${edge.end}`) || changed;
    }
    return changed;
  }

  function resolveColumnCollisions() {
    let changed = false;
    const byColumn = new Map();
    for (const node of centralNodes) {
      const pos = positions.get(node.key);
      if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) continue;
      const x = roundGrid(pos.x);
      if (!byColumn.has(x)) byColumn.set(x, []);
      byColumn.get(x).push(node);
    }

    for (const [x, columnNodes] of byColumn.entries()) {
      const sorted = columnNodes.sort(sortNodesForPlacement);
      let floorY = -Infinity;
      for (const node of sorted) {
        if (node.key === fnStableId) {
          floorY = Math.max(floorY, positions.get(node.key)?.y ?? 0);
          continue;
        }
        const pos = positions.get(node.key);
        if (!pos || !Number.isFinite(pos.y)) continue;
        const nextY = Math.max(pos.y, floorY + 1);
        floorY = nextY;
        if (nextY === pos.y) continue;
        const rightBranchIncoming = (incomingByTarget.get(node.key) || [])
          .find((edge) => edge.layoutBranchRole === 'right-longer');
        if (rightBranchIncoming) {
          const sourcePos = positions.get(rightBranchIncoming.start);
          if (sourcePos && Number.isFinite(sourcePos.y) && sourcePos.y < nextY) {
            changed = setPos(rightBranchIncoming.start, {
              x: sourcePos.x,
              y: nextY,
              xPriority: sourcePos.xPriority,
            }, `right-branch source moved with occupied target row ${pos.y}->${nextY}; target ${node.key}`) || changed;
          }
        }
        const nextX = rightBranchIncoming
          ? firstFreeRightColumn(x, nextY, new Set([node.key, rightBranchIncoming.start]))
          : x;
        changed = setPos(
          node.key,
          { x: nextX, y: nextY, xPriority: pos.xPriority },
          nextX === x
            ? `column collision resolved by source order; row ${pos.y}->${nextY}`
            : `column collision resolved by source order and vertical-axis occupancy; row ${pos.y}->${nextY}; x ${x}->${nextX}`,
        ) || changed;
      }
    }
    return changed;
  }

  function verticalFlowAxisOccupiedAt(x, y, ignoreKeys = new Set()) {
    for (const edge of flowEdges) {
      if (ignoreKeys.has(edge.start) || ignoreKeys.has(edge.end)) continue;
      const sourcePos = positions.get(edge.start);
      const targetPos = positions.get(edge.end);
      if (!sourcePos || !targetPos) continue;
      if (!Number.isFinite(sourcePos.x) || !Number.isFinite(sourcePos.y)) continue;
      if (!Number.isFinite(targetPos.x) || !Number.isFinite(targetPos.y)) continue;
      if (!nearlyEqual(sourcePos.x, targetPos.x) || !nearlyEqual(sourcePos.x, x)) continue;
      const minY = Math.min(sourcePos.y, targetPos.y);
      const maxY = Math.max(sourcePos.y, targetPos.y);
      if (y > minY + 0.001 && y < maxY - 0.001) return true;
    }
    return false;
  }

  function firstFreeRightColumn(preferredX, y, ignoreKeys = new Set()) {
    let x = roundGrid(preferredX);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      if (!verticalFlowAxisOccupiedAt(x, y, ignoreKeys)) return x;
      x = roundGrid(x + 1);
    }
    return x;
  }

  function resolveVerticalAxisCollisions() {
    let changed = false;
    const orderedEdges = [...flowEdges]
      .filter((edge) => edge.layoutBranchRole === 'right-longer')
      .sort((left, right) => {
        const leftSource = nodeByKey.get(left.start);
        const rightSource = nodeByKey.get(right.start);
        return sortBySourceOrder(leftSource || { props: {}, key: left.start }, rightSource || { props: {}, key: right.start })
          || String(left.id).localeCompare(String(right.id));
      });

    for (const edge of orderedEdges) {
      const targetPos = positions.get(edge.end);
      if (!targetPos || !Number.isFinite(targetPos.x) || !Number.isFinite(targetPos.y)) continue;
      const nextX = firstFreeRightColumn(targetPos.x, targetPos.y, new Set([edge.start, edge.end]));
      if (nextX === targetPos.x) continue;
      changed = setPos(edge.end, {
        x: nextX,
        y: targetPos.y,
        xPriority: targetPos.xPriority,
      }, `right-branch target moved to free vertical axis; x ${targetPos.x}->${nextX}`) || changed;
    }
    return changed;
  }

  for (let pass = 0; pass < centralNodes.length * 2 + 8; pass += 1) {
    const relaxed = relaxFlowEdges();
    const backPlaced = backPlaceDanglingSources();
    const collisionsResolved = resolveColumnCollisions();
    const axisResolved = resolveVerticalAxisCollisions();
    const changed = relaxed || backPlaced || collisionsResolved || axisResolved;
    if (!changed) break;
  }

  for (const node of centralNodes) {
    if (node.key === fnStableId) continue;
    const pos = positions.get(node.key);
    if (!pos || (Number.isFinite(pos.x) && Number.isFinite(pos.y))) continue;
    const sourceOrderY = orderByKey.get(node.key) + 1;
    setPos(node.key, { x: pos?.x ?? 0, y: pos?.y ?? sourceOrderY }, 'fallback source-order row after semantic placement');
  }
}

function alignRightBranchTargetsWithSource(centralEdges, positions) {
  for (let pass = 0; pass < centralEdges.length + 2; pass += 1) {
    let changed = false;
    for (const edge of centralEdges) {
      if (edge.layoutBranchRole !== 'right-longer') continue;
      const sourcePos = positions.get(edge.start);
      const targetPos = positions.get(edge.end);
      if (!sourcePos || !targetPos || !Number.isFinite(sourcePos.y) || !Number.isFinite(targetPos.y)) continue;
      if (targetPos.y === sourcePos.y) continue;
      positions.set(edge.end, {
        ...targetPos,
        y: sourcePos.y,
        reason: `${targetPos.reason}; aligned right-branch Y ${targetPos.y}->${sourcePos.y} from ${edge.type} parent ${edge.start}`,
      });
      changed = true;
    }
    if (!changed) break;
  }
}

function reserveRightBranchFootprintsAfterFamilies(nodes, edges, centralEdges, positions) {
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  const orderByKey = new Map(nodes
    .slice()
    .sort(sortBySourceOrder)
    .map((node, index) => [node.key, index]));
  const outgoingBySource = new Map();
  const footprintShiftedKeys = new Set();
  for (const edge of edges) {
    if (!outgoingBySource.has(edge.start)) outgoingBySource.set(edge.start, []);
    outgoingBySource.get(edge.start).push(edge);
  }

  function collectLocalRightSubtree(startKey, startPos) {
    const result = new Set([startKey]);
    const queue = [startKey];
    while (queue.length && result.size < 96) {
      const key = queue.shift();
      for (const edge of outgoingBySource.get(key) || []) {
        if (!nodeByKey.has(edge.end) || result.has(edge.end)) continue;
        const pos = positions.get(edge.end);
        if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) continue;
        if (pos.x < startPos.x - 0.05) continue;
        result.add(edge.end);
        queue.push(edge.end);
      }
    }
    return result;
  }

  function findFootprintHit(subtreeKeys, anchorOrder, minX, maxX, minY, maxY) {
    let best = null;
    for (const [key, pos] of positions.entries()) {
      if (subtreeKeys.has(key)) continue;
      const hitOrder = orderByKey.get(key);
      if (Number.isFinite(hitOrder) && Number.isFinite(anchorOrder) && hitOrder > anchorOrder) continue;
      if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) continue;
      if (pos.x < minX || pos.x > maxX) continue;
      if (pos.y < minY || pos.y > maxY) continue;
      if (!best || pos.y > best.pos.y) best = { key, pos };
    }
    return best;
  }

  for (const edge of centralEdges) {
    if (edge.layoutBranchRole !== 'right-longer') continue;
    if (footprintShiftedKeys.has(edge.start) || footprintShiftedKeys.has(edge.end)) continue;
    const sourcePos = positions.get(edge.start);
    const targetPos = positions.get(edge.end);
    if (!sourcePos || !targetPos) continue;
    if (!Number.isFinite(sourcePos.x) || !Number.isFinite(sourcePos.y)) continue;
    if (!Number.isFinite(targetPos.x) || !Number.isFinite(targetPos.y)) continue;

    const subtreeKeys = collectLocalRightSubtree(edge.end, targetPos);
    const anchorOrder = orderByKey.get(edge.end);
    const minX = targetPos.x;
    const maxX = targetPos.x + 4;
    const minY = targetPos.y - 0.05;
    const maxY = targetPos.y + 0.45;
    const hit = findFootprintHit(subtreeKeys, anchorOrder, minX, maxX, minY, maxY);
    if (!hit) continue;

    const delta = roundFlowDelta(hit.pos.y + 1 - targetPos.y);
    if (!delta) continue;
    for (const key of subtreeKeys) {
      if (footprintShiftedKeys.has(key)) continue;
      const pos = positions.get(key);
      if (!pos || !Number.isFinite(pos.y)) continue;
      positions.set(key, {
        ...pos,
        y: roundFlowY(pos.y + delta),
        reason: `${pos.reason}; shifted with right-branch local footprint from ${edge.start}; avoided ${hit.key}; deltaY=${delta}`,
      });
      footprintShiftedKeys.add(key);
    }
  }

}

function routeEdgesOnCoordinateGrid(edges, positions, nodes = []) {
  const routableTypes = new Set(['TRUE', 'FALSE', 'NEXT', 'REJOINS', 'ARG', 'ArgJoin', 'XOR_JOIN', 'VALUE', 'FIELD', 'FieldJoin', 'CALL', 'REQUEST', 'INVOKES', 'RESPONSE', 'RESULT', 'READ', 'UPDATE', 'CLEAR']);
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  const nodePositions = [...positions.entries()]
    .filter(([, pos]) => Number.isFinite(pos?.x) && Number.isFinite(pos?.y));
  const axes = buildCoordinateAxes(nodePositions);
  const centerKeys = new Set(nodePositions
    .filter(([key]) => !nodeByKey.get(key)?.labels?.includes('Merge'))
    .map(([, pos]) => gridKey(pos.x, pos.y)));
  const branchSourcePorts = buildBranchSourcePortAssignments(edges, positions);
  const layoutJunctions = [];

  for (const edge of edges) {
    if (!routableTypes.has(edge.type)) continue;
    const sourcePos = positions.get(edge.start);
    const targetPos = targetPositionForEdge(edge, positions);
    if (!sourcePos || !targetPos) continue;
    if (!Number.isFinite(sourcePos.x) || !Number.isFinite(sourcePos.y) || !Number.isFinite(targetPos.x) || !Number.isFinite(targetPos.y)) continue;

    const actualTargetPos = positions.get(edge.end);
    if (isSameColumnActualVerticalRoute(sourcePos, actualTargetPos)) {
      edge.layoutSourcePort = 'bottom';
      edge.layoutTargetPort = 'top';
      edge.layoutRouteJunctionIds = [];
      edge.layoutRouteReason = 'same-column actual target vertical route; no junctions required';
      continue;
    }

    const directPorts = portForDirectEdge(edge, positions, branchSourcePorts);
    if (isSameColumnVerticalRoute(sourcePos, targetPos, directPorts)) {
      edge.layoutRouteJunctionIds = [];
      edge.layoutRouteReason = 'same-column vertical route; no junctions required';
      continue;
    }
    const fanInBends = buildFinishFanInBends(edge, nodeByKey, sourcePos, targetPos);
    if (fanInBends.length) {
      edge.layoutRouteJunctionIds = addLayoutJunctionsForBends(layoutJunctions, edge, fanInBends, 'finish fan-in route: horizontal first, vertical before finish');
      edge.layoutRouteReason = `finish fan-in explicit route; turns=${fanInBends.length}; source=${edge.start}; target=${edge.end}`;
      continue;
    }
    const allowedCenterKeys = new Set();
    if (edge.layoutEffectiveTargetStableId && edge.layoutEffectiveTargetStableId !== edge.end) {
      const collapsedBridgePos = positions.get(edge.end);
      if (collapsedBridgePos) allowedCenterKeys.add(gridKey(collapsedBridgePos.x, collapsedBridgePos.y));
    }
    const mandatoryStartBend = buildMandatoryBottomSideBend(sourcePos, targetPos, directPorts);
    if (mandatoryStartBend) allowedCenterKeys.add(gridKey(mandatoryStartBend.x, mandatoryStartBend.y));
    const route = shortestOrthogonalGridRoute({
      sourcePos,
      targetPos,
      sourcePort: directPorts.sourcePort,
      targetPort: directPorts.targetPort,
      axes,
      blockedCenters: centerKeys,
      allowedCenterKeys,
      startOverride: mandatoryStartBend,
    });
    if (!route || route.length <= 2) {
      edge.layoutRouteReason = 'grid route is direct; no junctions required';
      continue;
    }

    const compressedRoute = normalizeRouteToTargetAxis(
      compressRouteToBends(route),
      targetPos,
      centerKeys,
      allowedCenterKeys,
    );
    const bends = compressedRoute.slice(1, -1);
    if (!bends.length) {
      edge.layoutRouteReason = 'grid route has no turns after compression';
      continue;
    }

    edge.layoutRouteJunctionIds = addLayoutJunctionsForBends(layoutJunctions, edge, bends, 'grid route bend; centers are blocked');
    edge.layoutRouteReason = `grid shortest orthogonal route; turns=${bends.length}; axes=${axes.xs.length}x${axes.ys.length}`;
  }

  return { layoutJunctions };
}

function isSameColumnActualVerticalRoute(sourcePos, targetPos) {
  if (!sourcePos || !targetPos) return false;
  if (!Number.isFinite(sourcePos.x) || !Number.isFinite(sourcePos.y)) return false;
  if (!Number.isFinite(targetPos.x) || !Number.isFinite(targetPos.y)) return false;
  return nearlyEqual(sourcePos.x, targetPos.x) && targetPos.y > sourcePos.y;
}

function isSameColumnVerticalRoute(sourcePos, targetPos, directPorts) {
  if (!nearlyEqual(sourcePos.x, targetPos.x)) return false;
  return directPorts.sourcePort === 'bottom' && directPorts.targetPort === 'top' && targetPos.y > sourcePos.y;
}

function buildMandatoryBottomSideBend(sourcePos, targetPos, directPorts) {
  if (directPorts.sourcePort !== 'bottom') return null;
  if (targetPos.y <= sourcePos.y || targetPos.x === sourcePos.x) return null;
  return {
    x: roundGrid(sourcePos.x),
    y: roundGrid(sourcePos.y + 0.5),
  };
}

function buildFinishFanInBends(edge, nodeByKey, sourcePos, targetPos) {
  if (edge.type !== 'ARG' && edge.type !== 'ArgJoin' && edge.type !== 'VALUE' && edge.type !== 'FIELD' && edge.type !== 'FieldJoin') return [];
  const target = nodeByKey.get(edge.end);
  if (!isArgsNode(target) && !isMergeFieldsNode(target)) return [];
  if (targetPos.x <= sourcePos.x || nearlyEqual(targetPos.y, sourcePos.y)) return [];
  const bendX = roundGrid(targetPos.x - 0.5);
  if (bendX <= sourcePos.x) return [];
  return [
    { x: bendX, y: sourcePos.y },
    { x: bendX, y: targetPos.y },
  ];
}

function addLayoutJunctionsForBends(layoutJunctions, edge, bends, reasonPrefix) {
  const junctionIds = [];
  bends.forEach((point, index) => {
    const key = `layout:${edge.id}:grid-turn-${index + 1}`;
    junctionIds.push(key);
    layoutJunctions.push({
      key,
      labels: ['LayoutJunction'],
      props: {
        stableId: key,
        layoutKind: 'edge-grid-turn',
        ownerStableId: edge.start,
        targetStableId: edge.end,
        edgeType: edge.type,
        displayX: point.x,
        displayY: point.y,
        layoutRole: 'edge-grid-turn',
        layoutReason: `${reasonPrefix} ${index + 1}/${bends.length}; source=${edge.start}; target=${edge.end}`,
      },
    });
  });
  return junctionIds;
}

function buildCoordinateAxes(nodePositions) {
  const xs = sortedUnique(nodePositions.flatMap(([, pos]) => [pos.x]));
  const ys = sortedUnique(nodePositions.flatMap(([, pos]) => [pos.y]));
  return {
    xs: sortedUnique(expandAxesWithCorridors(xs)),
    ys: sortedUnique(expandAxesWithCorridors(ys)),
  };
}

function expandAxesWithCorridors(values) {
  if (!values.length) return [0];
  const expanded = [values[0] - 1, ...values, values[values.length - 1] + 1];
  for (let index = 0; index < values.length - 1; index += 1) {
    const left = values[index];
    const right = values[index + 1];
    if (right !== left) expanded.push((left + right) / 2);
  }
  return expanded;
}

function sortedUnique(values) {
  return [...new Set(values
    .filter((value) => Number.isFinite(value))
    .map((value) => roundGrid(value)))]
    .sort((left, right) => left - right);
}

function roundGrid(value) {
  return Math.round(value * 1000) / 1000;
}

function roundFlowDelta(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(1, Math.ceil(value - 0.001));
}

function roundFlowY(value) {
  if (!Number.isFinite(value)) return value;
  return Math.round(value);
}

function shortestOrthogonalGridRoute({ sourcePos, targetPos, sourcePort, targetPort, axes, blockedCenters, allowedCenterKeys = new Set(), startOverride = null }) {
  const start = routePortAnchorPoint(sourcePos, sourcePort);
  const routeStart = startOverride || start;
  const finalGoal = routePortAnchorPoint(targetPos, targetPort);
  const goalApproach = routeGoalApproachPoint(finalGoal, targetPort);
  const goal = goalApproach || finalGoal;
  const xs = ensureAxis(axes.xs, start.x, routeStart.x, goal.x, finalGoal.x);
  const ys = ensureAxis(axes.ys, start.y, routeStart.y, goal.y, finalGoal.y);
  const startKey = gridKey(routeStart.x, routeStart.y);
  const goalKey = gridKey(goal.x, goal.y);
  const finalGoalKey = gridKey(finalGoal.x, finalGoal.y);
  const portStartKey = gridKey(start.x, start.y);
  const blocked = new Set([...blockedCenters].filter((key) => key !== startKey && key !== portStartKey && key !== goalKey && (!goalApproach || key !== finalGoalKey) && !allowedCenterKeys.has(key)));
  if (goalApproach && finalGoalKey !== startKey && finalGoalKey !== portStartKey && finalGoalKey !== goalKey) {
    blocked.add(finalGoalKey);
  }
  const open = [{
    key: startKey,
    x: routeStart.x,
    y: routeStart.y,
    dir: null,
    distance: 0,
    turns: 0,
    firstSideAt: null,
    cost: 0,
    score: manhattan(routeStart, goal),
    prev: null,
  }];
  const best = new Map([[stateKey(startKey, null), routeRank(open[0])]]);
  const seen = new Map();

  while (open.length) {
    open.sort((left, right) => compareRouteQueueItems(left, right, goal));
    const current = open.shift();
    const currentStateKey = stateKey(current.key, current.dir);
    if (seen.has(currentStateKey)) continue;
    seen.set(currentStateKey, current);
    if (current.key === goalKey) {
      const route = reconstructGridRoute(current);
      const fullRoute = goalApproach ? [...route, finalGoal] : route;
      if (!startOverride) return fullRoute;
      return [start, ...fullRoute];
    }

    for (const next of gridNeighbors(current, xs, ys)) {
      if (blocked.has(next.key)) continue;
      const distanceCost = Math.abs(next.x - current.x) + Math.abs(next.y - current.y);
      const turns = current.turns + (current.dir && current.dir !== next.dir ? 1 : 0);
      const distance = current.distance + distanceCost;
      const firstSideAt = current.firstSideAt ?? (isSideDirection(next.dir) ? current.distance : null);
      const nextCost = distance + (turns * 0.35);
      const nextStateKey = stateKey(next.key, next.dir);
      const nextRank = { distance, turns, firstSideAt: firstSideAt ?? Number.POSITIVE_INFINITY };
      if (best.has(nextStateKey) && compareRouteRanks(best.get(nextStateKey), nextRank) <= 0) continue;
      best.set(nextStateKey, nextRank);
      open.push({
        ...next,
        distance,
        turns,
        firstSideAt,
        cost: nextCost,
        score: nextCost + manhattan(next, goal),
        prev: current,
      });
    }
  }

  return null;
}

function routeGoalApproachPoint(finalGoal, targetPort) {
  if (targetPort === 'top') {
    return { x: finalGoal.x, y: roundGrid(finalGoal.y - 0.5) };
  }
  return null;
}

function routePortAnchorPoint(pos, port) {
  if (!pos) return { x: 0, y: 0 };
  if (port === 'top' || port === 'bottom') {
    return { x: roundGrid(pos.x), y: roundGrid(pos.y) };
  }
  return portGridPoint(pos, port);
}

function isSideDirection(dir) {
  return dir === 'left' || dir === 'right';
}

function routeRank(item) {
  return {
    distance: item.distance ?? item.cost ?? 0,
    turns: item.turns ?? 0,
    firstSideAt: item.firstSideAt ?? Number.POSITIVE_INFINITY,
  };
}

function compareRouteQueueItems(left, right, goal) {
  const leftEstimatedDistance = left.distance + manhattan(left, goal);
  const rightEstimatedDistance = right.distance + manhattan(right, goal);
  return (leftEstimatedDistance - rightEstimatedDistance)
    || (left.turns - right.turns)
    || ((left.firstSideAt ?? Number.POSITIVE_INFINITY) - (right.firstSideAt ?? Number.POSITIVE_INFINITY))
    || (left.cost - right.cost)
    || (routeGoalAxisMiss(left, goal) - routeGoalAxisMiss(right, goal))
    || (routeGoalAxisDrift(left, goal) - routeGoalAxisDrift(right, goal))
    || String(left.key).localeCompare(String(right.key));
}

function compareRouteRanks(left, right) {
  return (left.distance - right.distance)
    || (left.turns - right.turns)
    || (left.firstSideAt - right.firstSideAt);
}

function routeGoalAxisDrift(point, goal) {
  return Math.abs(point.x - goal.x) + Math.abs(point.y - goal.y);
}

function routeGoalAxisMiss(point, goal) {
  return (point.x === goal.x ? 0 : 1) + (point.y === goal.y ? 0 : 1);
}

function portGridPoint(pos, port) {
  const parsed = parsePercentPort(port);
  if (parsed) {
    if (parsed.side === 'top') return { x: roundGrid(pos.x - 0.5 + parsed.ratio), y: roundGrid(pos.y - 0.5) };
    if (parsed.side === 'bottom') return { x: roundGrid(pos.x - 0.5 + parsed.ratio), y: roundGrid(pos.y + 0.5) };
    if (parsed.side === 'left') return { x: roundGrid(pos.x - 0.5), y: roundGrid(pos.y - 0.5 + parsed.ratio) };
    if (parsed.side === 'right') return { x: roundGrid(pos.x + 0.5), y: roundGrid(pos.y - 0.5 + parsed.ratio) };
  }
  if (port === 'top') return { x: roundGrid(pos.x), y: roundGrid(pos.y - 0.5) };
  if (port === 'right') return { x: roundGrid(pos.x + 0.5), y: roundGrid(pos.y) };
  if (port === 'right-top') return { x: roundGrid(pos.x + 0.25), y: roundGrid(pos.y - 0.5) };
  if (port === 'right-bottom') return { x: roundGrid(pos.x + 0.25), y: roundGrid(pos.y + 0.5) };
  if (port === 'bottom') return { x: roundGrid(pos.x), y: roundGrid(pos.y + 0.5) };
  if (port === 'left') return { x: roundGrid(pos.x - 0.5), y: roundGrid(pos.y) };
  if (port === 'left-top') return { x: roundGrid(pos.x - 0.25), y: roundGrid(pos.y - 0.5) };
  if (port === 'left-bottom') return { x: roundGrid(pos.x - 0.25), y: roundGrid(pos.y + 0.5) };
  return { x: roundGrid(pos.x), y: roundGrid(pos.y) };
}

function parsePercentPort(port) {
  const match = String(port || '').match(/^(top|right|bottom|left)-(\d{1,3})$/u);
  if (!match) return null;
  const percent = Math.max(0, Math.min(100, Number(match[2])));
  return { side: match[1], ratio: percent / 100 };
}

function ensureAxis(values, ...required) {
  return sortedUnique([...values, ...required]);
}

function gridNeighbors(point, xs, ys) {
  const xi = xs.indexOf(roundGrid(point.x));
  const yi = ys.indexOf(roundGrid(point.y));
  const result = [];
  if (xi > 0) result.push({ x: xs[xi - 1], y: point.y, dir: 'left', key: gridKey(xs[xi - 1], point.y) });
  if (xi >= 0 && xi < xs.length - 1) result.push({ x: xs[xi + 1], y: point.y, dir: 'right', key: gridKey(xs[xi + 1], point.y) });
  if (yi > 0) result.push({ x: point.x, y: ys[yi - 1], dir: 'top', key: gridKey(point.x, ys[yi - 1]) });
  if (yi >= 0 && yi < ys.length - 1) result.push({ x: point.x, y: ys[yi + 1], dir: 'bottom', key: gridKey(point.x, ys[yi + 1]) });
  return result;
}

function reconstructGridRoute(state) {
  const route = [];
  for (let current = state; current; current = current.prev) {
    route.push({ x: current.x, y: current.y });
  }
  return route.reverse();
}

function compressRouteToBends(route) {
  if (route.length <= 2) return route;
  const result = [route[0]];
  for (let index = 1; index < route.length - 1; index += 1) {
    const previous = route[index - 1];
    const current = route[index];
    const next = route[index + 1];
    const sameHorizontal = previous.y === current.y && current.y === next.y;
    const sameVertical = previous.x === current.x && current.x === next.x;
    if (!sameHorizontal && !sameVertical) result.push(current);
  }
  result.push(route[route.length - 1]);
  return result;
}

function normalizeRouteToTargetAxis(route, targetPos, blockedCenters, allowedCenterKeys = new Set()) {
  if (route.length <= 3 || !Number.isFinite(targetPos?.x)) return route;
  const targetX = roundGrid(targetPos.x);
  let changed = false;
  const normalized = route.map((point) => ({ ...point }));

  for (let index = 1; index < normalized.length - 2; index += 1) {
    const top = normalized[index];
    const bottom = normalized[index + 1];
    if (!nearlyEqual(top.x, bottom.x)) continue;
    if (nearlyEqual(top.x, targetX)) continue;
    if (!routeEventuallyReachesTargetAxis(normalized, index + 1, targetX)) continue;
    if (!isVerticalCorridorClear(targetX, top.y, bottom.y, blockedCenters, allowedCenterKeys)) continue;
    if (!isHorizontalCorridorClear(top.y, top.x, targetX, blockedCenters, allowedCenterKeys)) continue;

    top.x = targetX;
    bottom.x = targetX;
    changed = true;
  }

  return changed ? compressRouteToBends(removeDuplicateRoutePoints(normalized)) : route;
}

function routeEventuallyReachesTargetAxis(route, startIndex, targetX) {
  for (let index = startIndex; index < route.length; index += 1) {
    if (nearlyEqual(route[index].x, targetX)) return true;
  }
  return false;
}

function isVerticalCorridorClear(x, y1, y2, blockedCenters, allowedCenterKeys) {
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  for (const key of blockedCenters) {
    if (allowedCenterKeys.has(key)) continue;
    const point = parseGridKey(key);
    if (!point || !nearlyEqual(point.x, x)) continue;
    if (point.y > minY && point.y < maxY) return false;
  }
  return true;
}

function isHorizontalCorridorClear(y, x1, x2, blockedCenters, allowedCenterKeys) {
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  for (const key of blockedCenters) {
    if (allowedCenterKeys.has(key)) continue;
    const point = parseGridKey(key);
    if (!point || !nearlyEqual(point.y, y)) continue;
    if (point.x > minX && point.x < maxX) return false;
  }
  return true;
}

function parseGridKey(key) {
  const [x, y] = String(key).split(':').map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function removeDuplicateRoutePoints(route) {
  const result = [];
  for (const point of route) {
    const previous = result[result.length - 1];
    if (previous && nearlyEqual(previous.x, point.x) && nearlyEqual(previous.y, point.y)) continue;
    result.push(point);
  }
  return result;
}

function gridKey(x, y) {
  return `${roundGrid(x)}:${roundGrid(y)}`;
}

function stateKey(pointKey, dir) {
  return `${pointKey}:${dir || 'start'}`;
}

function manhattan(left, right) {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y);
}

function enforceDownBranchYOrder(centralEdges, positions) {
  for (let pass = 0; pass < centralEdges.length + 2; pass += 1) {
    let changed = false;
    for (const edge of centralEdges) {
      if (edge.layoutBranchRole !== 'down-shorter') continue;
      const sourcePos = positions.get(edge.start);
      const targetPos = positions.get(edge.end);
      if (!sourcePos || !targetPos || !Number.isFinite(sourcePos.y) || !Number.isFinite(targetPos.y)) continue;
      const minTargetY = sourcePos.y + 1;
      if (targetPos.y >= minTargetY) continue;
      positions.set(edge.end, {
        ...targetPos,
        y: minTargetY,
        reason: `${targetPos.reason}; enforced down-branch Y ${targetPos.y}->${minTargetY} from ${edge.type} parent ${edge.start}`,
      });
      changed = true;
    }
    if (!changed) break;
  }
}

function positionMergeNodesBeforeTargets(centralNodes, centralEdges, positions) {
  const outgoingBySource = new Map();
  for (const edge of centralEdges) {
    if (!outgoingBySource.has(edge.start)) outgoingBySource.set(edge.start, []);
    outgoingBySource.get(edge.start).push(edge);
  }

  for (const node of centralNodes) {
    if (!isMergeNode(node)) continue;
    const outgoing = (outgoingBySource.get(node.key) || [])
      .filter((edge) => edge.type === 'NEXT')
      .sort((left, right) => String(left.end).localeCompare(String(right.end)));
    if (outgoing.length !== 1) continue;

    const pos = positions.get(node.key);
    const targetPos = positions.get(outgoing[0].end);
    if (!pos || !targetPos || !Number.isFinite(targetPos.x) || !Number.isFinite(targetPos.y)) continue;

    let x = targetPos.x;
    let y = targetPos.y - 0.5;
    if (Number.isFinite(pos.x) && targetPos.x > pos.x && targetPos.y === pos.y) x = targetPos.x - 0.5;
    else if (Number.isFinite(pos.x) && targetPos.x < pos.x && targetPos.y === pos.y) x = targetPos.x + 0.5;

    positions.set(node.key, {
      ...pos,
      x,
      y,
      reason: `${pos.reason}; merge positioned half-grid before NEXT target ${outgoing[0].end}`,
    });
  }
}

function applyArgumentParallelLayout(nodes, edges, positions) {
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  const outgoingBySource = new Map();
  const incomingByTarget = new Map();
  for (const edge of edges) {
    if (!outgoingBySource.has(edge.start)) outgoingBySource.set(edge.start, []);
    outgoingBySource.get(edge.start).push(edge);
    if (!incomingByTarget.has(edge.end)) incomingByTarget.set(edge.end, []);
    incomingByTarget.get(edge.end).push(edge);
  }

  const laneSpacing = 0.7;
  const visitedFamilies = new Set();
  const familyParents = nodes
    .filter((node) => getParallelSlotFamilySpec(node))
    .sort(sortBySourceOrder);

  function setEdgePorts(edge) {
    edge.layoutSourcePort = 'right';
    edge.layoutTargetPort = 'left';
  }

  function nestedCallEdges(sourceKey) {
    return (outgoingBySource.get(sourceKey) || [])
      .filter((edge) => isCallLikeEdge(edge))
      .filter((edge) => nodeByKey.has(edge.end))
      .sort((left, right) => sortBySourceOrder(nodeByKey.get(left.end), nodeByKey.get(right.end)));
  }

  function responseEdgesForCall(callEdge) {
    return (outgoingBySource.get(callEdge.end) || [])
      .filter((edge) => edge.type === 'RESPONSE' && edge.end === callEdge.start)
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  }

  function placeNestedCallTargets(sourceKey, sourceX, sourceY, reasonPrefix) {
    const calls = nestedCallEdges(sourceKey);
    if (!calls.length) return { maxX: sourceX, minY: sourceY, maxY: sourceY };

    let maxX = sourceX;
    let maxY = sourceY;
    const callSpacing = 0.7;
    calls.forEach((callEdge, index) => {
      const target = nodeByKey.get(callEdge.end);
      if (!target) return;
      const targetY = roundGrid(sourceY + callSpacing * (index + 1));
      setLayoutPosition(
        positions,
        target.key,
        sourceX,
        targetY,
        `${reasonPrefix} nested CALL target under ${sourceKey}; callIndex=${index + 1}/${calls.length}`,
      );
      callEdge.layoutSourcePort = 'bottom-25';
      callEdge.layoutTargetPort = 'top-25';
      callEdge.layoutRouteReason = 'nested call inside argument/field: vertical call lane at 25% width';
      for (const responseEdge of responseEdgesForCall(callEdge)) {
        responseEdge.layoutSourcePort = 'top-75';
        responseEdge.layoutTargetPort = 'bottom-75';
        responseEdge.layoutRouteReason = 'nested call inside argument/field: vertical response lane at 75% width';
      }
      maxX = Math.max(maxX, sourceX);
      maxY = Math.max(maxY, targetY);
    });
    return { maxX, minY: sourceY, maxY };
  }

  function familyFootprintHitsPlacedNodes(parentKey, familyKeys, minX, maxX, minY, maxY) {
    for (const [key, pos] of positions.entries()) {
      if (familyKeys.has(key) || key === parentKey) continue;
      if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) continue;
      if (pos.x < minX || pos.x > maxX) continue;
      if (pos.y < minY || pos.y > maxY) continue;
      return { key, pos };
    }
    return null;
  }

  function shiftFlowContinuationDown(startKey, delta, reasonPrefix, skipKeys = new Set()) {
    delta = roundFlowDelta(delta);
    if (!delta) return;
    const branchCascadeVisited = new Set();
    function shiftBranchChildrenDown(branchKey) {
      const branch = nodeByKey.get(branchKey);
      if (!isBranchNode(branch)) return;
      if (branchCascadeVisited.has(branchKey)) return;
      branchCascadeVisited.add(branchKey);
      for (const edge of outgoingBySource.get(branchKey) || []) {
        if (edge.layoutBranchRole !== 'right-longer' && edge.layoutBranchRole !== 'down-shorter') continue;
        if (skipKeys.has(edge.end)) continue;
        if (!shifted.has(edge.end)) {
          const childPos = positions.get(edge.end);
          if (!childPos || !Number.isFinite(childPos.y)) continue;
          setLayoutPosition(
            positions,
            edge.end,
            childPos.x ?? 0,
            roundFlowY(childPos.y + delta),
            `${reasonPrefix}; shifted branch child ${edge.type}/${edge.layoutBranchRole} down by ${delta}`,
          );
          shifted.add(edge.end);
        }
        shiftBranchChildrenDown(edge.end);
        for (const nextEdge of outgoingBySource.get(edge.end) || []) {
          if (nextEdge.type !== 'NEXT') continue;
          if (skipKeys.has(nextEdge.end) || shifted.has(nextEdge.end)) continue;
          const nextPos = positions.get(nextEdge.end);
          if (!nextPos || !Number.isFinite(nextPos.y)) continue;
          setLayoutPosition(
            positions,
            nextEdge.end,
            nextPos.x ?? 0,
            roundFlowY(nextPos.y + delta),
            `${reasonPrefix}; shifted branch child NEXT continuation down by ${delta}`,
          );
          shifted.add(nextEdge.end);
          shiftBranchChildrenDown(nextEdge.end);
        }
      }
    }

    const immediateTargets = (outgoingBySource.get(startKey) || [])
      .filter((edge) => ['NEXT', 'TRUE', 'FALSE', 'REJOINS', 'MERGES_TO'].includes(edge.type))
      .filter((edge) => nodeByKey.has(edge.end))
      .filter((edge) => !skipKeys.has(edge.end))
      .map((edge) => edge.end);
    const shifted = new Set();
    for (const key of immediateTargets) {
      const pos = positions.get(key);
      if (pos && Number.isFinite(pos.y)) {
        setLayoutPosition(positions, key, pos.x ?? 0, roundFlowY(pos.y + delta), `${reasonPrefix}; shifted immediate flow successor down by ${delta}`);
        shifted.add(key);
        shiftBranchChildrenDown(key);
      }

      const node = nodeByKey.get(key);
      if (!node?.labels?.includes('Merge')) continue;
      const mergeNext = (outgoingBySource.get(key) || [])
        .filter((edge) => edge.type === 'NEXT')
        .filter((edge) => nodeByKey.has(edge.end))
        .filter((edge) => !skipKeys.has(edge.end))
        .map((edge) => edge.end);
      for (const nextKey of mergeNext) {
        if (shifted.has(nextKey)) continue;
        const nextPos = positions.get(nextKey);
        if (nextPos && Number.isFinite(nextPos.y)) {
          setLayoutPosition(positions, nextKey, nextPos.x ?? 0, roundFlowY(nextPos.y + delta), `${reasonPrefix}; shifted merge NEXT successor down by ${delta}`);
          shifted.add(nextKey);
          shiftBranchChildrenDown(nextKey);
        }
      }
    }
  }

  function reserveFamilyStartRow(parentKey, familyKeys, slotEdges, finishKeys, parentPos, slotX) {
    const estimatedDepth = Math.max(2, 1 + slotEdges.length + finishKeys.size);
    const minX = slotX;
    const maxX = slotX + estimatedDepth;
    const centeredFirstLaneY = parentPos.y - ((slotEdges.length - 1) * laneSpacing) / 2;
    let parentShiftY = 0;
    const maxAttempts = 24;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const minY = roundGrid(centeredFirstLaneY + parentShiftY - 0.35);
      const maxY = roundGrid(centeredFirstLaneY + parentShiftY + (slotEdges.length - 1) * laneSpacing + 0.35);
      const hit = familyFootprintHitsPlacedNodes(parentKey, familyKeys, minX, maxX, minY, maxY);
      if (!hit) break;
      parentShiftY = roundGrid(Math.max(parentShiftY + laneSpacing, hit.pos.y - minY + laneSpacing));
    }

    parentShiftY = roundFlowDelta(parentShiftY);
    if (!parentShiftY) return 0;
    const rightBranchIncoming = (incomingByTarget.get(parentKey) || [])
      .find((edge) => edge.layoutBranchRole === 'right-longer' && positions.has(edge.start));
    if (rightBranchIncoming) {
      const sourcePos = positions.get(rightBranchIncoming.start);
      if (sourcePos && Number.isFinite(sourcePos.y)) {
        setLayoutPosition(
          positions,
          rightBranchIncoming.start,
          sourcePos.x ?? 0,
          roundFlowY(sourcePos.y + parentShiftY),
          `reserved right-side branch footprint before slot layout for ${parentKey}; x=${minX}..${maxX}; shiftY=${parentShiftY}`,
        );
        shiftFlowContinuationDown(
          rightBranchIncoming.start,
          parentShiftY,
          `reserved right-side branch footprint for ${rightBranchIncoming.start}`,
          new Set([parentKey]),
        );
      }
    }
    setLayoutPosition(
      positions,
      parentKey,
      parentPos.x,
      roundFlowY(parentPos.y + parentShiftY),
      `reserved right-side family footprint before slot layout; x=${minX}..${maxX}; shiftY=${parentShiftY}`,
    );
    shiftFlowContinuationDown(parentKey, parentShiftY, `reserved right-side family footprint for ${parentKey}`);
    return parentShiftY;
  }

  function layoutContinuation(startKey, stopKeys, baseX, baseY, reasonPrefix) {
    let maxX = baseX;
    let minY = baseY;
    let maxY = baseY;
    const visited = new Set();
    const queue = [{ key: startKey, x: baseX, y: baseY, depth: 0 }];
    while (queue.length) {
      const item = queue.shift();
      if (!item?.key || visited.has(item.key)) continue;
      visited.add(item.key);
      const node = nodeByKey.get(item.key);
      if (!node) continue;

      const nestedBounds = layoutFamily(item.key);
      if (nestedBounds) {
        maxX = Math.max(maxX, nestedBounds.maxX);
        minY = Math.min(minY, nestedBounds.minY);
        maxY = Math.max(maxY, nestedBounds.maxY);
      }
      const callBounds = placeNestedCallTargets(item.key, item.x, item.y, reasonPrefix);
      maxX = Math.max(maxX, callBounds.maxX);
      minY = Math.min(minY, callBounds.minY);
      maxY = Math.max(maxY, callBounds.maxY);
      const nestedFamilySpec = getParallelSlotFamilySpec(node);
      const sourceIsSlotLeaf = (isArgNode(node) || isObjectFieldNode(node)) && !isBranchNode(node);
      const sourceIsNestedCall = node.labels?.includes('Call');
      const insideParallelFamily = reasonPrefix === 'call argument family' || reasonPrefix === 'object field family';

      const outgoing = (outgoingBySource.get(item.key) || [])
        .filter((outEdge) => ['ARG', 'ArgJoin', 'VALUE', 'FIELD', 'FieldJoin', 'NEXT', 'TRUE', 'FALSE', 'REJOINS', 'MERGES_TO'].includes(outEdge.type))
        .filter((outEdge) => nodeByKey.has(outEdge.end))
        .filter((outEdge) => !stopKeys.has(outEdge.end))
        .filter((outEdge) => !(insideParallelFamily && sourceIsNestedCall && outEdge.type === 'NEXT'))
        .filter((outEdge) => {
          if (!sourceIsSlotLeaf) return true;
          return outEdge.type !== 'NEXT' && outEdge.type !== 'REJOINS' && outEdge.type !== 'MERGES_TO';
        })
        .filter((outEdge) => {
          if (!nestedFamilySpec) return true;
          return !(outEdge.type === nestedFamilySpec.slotEdgeType
            && nestedFamilySpec.isSlotNode(nodeByKey.get(outEdge.end)));
        })
        .sort((left, right) => sortBySourceOrder(nodeByKey.get(left.end), nodeByKey.get(right.end)));

      for (const outEdge of outgoing) {
        const target = nodeByKey.get(outEdge.end);
        if (!target) continue;

        let nextX = item.x + 1;
        let nextY = item.y;
        if (isBranchNode(node) && (outEdge.type === 'TRUE' || outEdge.type === 'FALSE')) {
          nextX = item.x + 1;
          nextY = roundGrid(item.y + (outEdge.type === 'TRUE' ? -0.35 : 0.35));
          outEdge.layoutSourcePort = outEdge.type === 'TRUE' ? 'right-top' : 'right-bottom';
          outEdge.layoutTargetPort = 'left';
        } else {
          setEdgePorts(outEdge);
        }

        const existingTargetPos = positions.get(target.key);
        const localIncoming = incomingByTarget.get(target.key) || [];
        const shouldMoveTarget = !existingTargetPos
          || !Number.isFinite(existingTargetPos.x)
          || localIncoming.some((incoming) => visited.has(incoming.start))
          || existingTargetPos.x < nextX;
        if (shouldMoveTarget) {
          setLayoutPosition(positions, target.key, nextX, nextY, `${reasonPrefix} continuation from ${item.key} via ${outEdge.type}`);
        }
        maxX = Math.max(maxX, nextX);
        minY = Math.min(minY, nextY);
        maxY = Math.max(maxY, nextY);
        queue.push({ key: target.key, x: nextX, y: nextY, depth: item.depth + 1 });
      }
    }
    return { maxX, minY, maxY };
  }

  function layoutFamily(parentKey) {
    if (visitedFamilies.has(parentKey)) return null;
    const parentNode = nodeByKey.get(parentKey);
    const spec = getParallelSlotFamilySpec(parentNode);
    if (!spec) return null;
    let parentPos = positions.get(parentKey);
    if (!parentPos || !Number.isFinite(parentPos.x) || !Number.isFinite(parentPos.y)) return null;

    const slotEdges = (outgoingBySource.get(parentKey) || [])
      .filter((edge) => edge.type === spec.slotEdgeType && spec.isSlotNode(nodeByKey.get(edge.end)))
      .sort((left, right) => sortBySourceOrder(nodeByKey.get(left.end), nodeByKey.get(right.end)));
    if (!slotEdges.length) return null;

    visitedFamilies.add(parentKey);
    const slotWidthPx = Math.max(...slotEdges.map((edge) => estimateNodeWidthPx(nodeByKey.get(edge.end))));
    const finishKeys = new Set(slotEdges
      .map((edge) => findReachableFinishKey(edge.end, spec, outgoingBySource, nodeByKey))
      .filter(Boolean));
    const slotX = parentPos.x + 1;
    const familyKeys = new Set([parentKey, ...slotEdges.map((edge) => edge.end), ...finishKeys]);
    reserveFamilyStartRow(parentKey, familyKeys, slotEdges, finishKeys, parentPos, slotX);
    parentPos = positions.get(parentKey);
    if (!parentPos || !Number.isFinite(parentPos.x) || !Number.isFinite(parentPos.y)) return null;
    const centeredFirstLaneY = parentPos.y - ((slotEdges.length - 1) * laneSpacing) / 2;
    const familyShiftY = findParallelFamilyShiftY(
      edges,
      positions,
      familyKeys,
      slotX,
      slotEdges.map((_, index) => roundGrid(centeredFirstLaneY + index * laneSpacing)),
      findPreviousSiblingFloorY(parentKey, incomingByTarget, outgoingBySource, nodeByKey, positions),
    );
    const firstLaneY = centeredFirstLaneY + familyShiftY;
    let maxX = slotX;
    let minY = parentPos.y;
    let maxY = parentPos.y;
    let extraLaneShift = 0;

    for (let index = 0; index < slotEdges.length; index += 1) {
      const edge = slotEdges[index];
      const slotNode = nodeByKey.get(edge.end);
      const laneY = roundGrid(firstLaneY + index * laneSpacing + extraLaneShift);
      setLayoutPosition(
        positions,
        slotNode.key,
        slotX,
        laneY,
        `${spec.reasonLabel} slot ${index + 1}/${slotEdges.length} from ${parentKey}; ordered by source stableId; centered around parent y=${parentPos.y}; shiftY=${familyShiftY}`,
      );
      const slotPos = positions.get(slotNode.key);
      if (slotPos) positions.set(slotNode.key, { ...slotPos, displayWidth: slotWidthPx });
      setEdgePorts(edge);
      const slotBounds = layoutContinuation(slotNode.key, finishKeys, slotX, laneY, spec.reasonLabel);
      maxX = Math.max(maxX, slotBounds.maxX);
      minY = Math.min(minY, slotBounds.minY);
      maxY = Math.max(maxY, slotBounds.maxY);
      if (slotBounds.maxY > laneY) {
        const shift = roundGrid(slotBounds.maxY - laneY);
        extraLaneShift = roundGrid(extraLaneShift + shift);
      }
    }

    const finishX = maxX + 1;
    for (const finishKey of finishKeys) {
      const finishNode = nodeByKey.get(finishKey);
      if (!finishNode) continue;
      setLayoutPosition(
        positions,
        finishKey,
        finishX,
        parentPos.y,
        `${spec.reasonLabel} fan-in aligned with opener ${parentKey}; family width ${finishX - parentPos.x}; childShiftY=${familyShiftY}`,
      );
      maxY = Math.max(maxY, parentPos.y);
      minY = Math.min(minY, parentPos.y);
    }
    for (const edge of edges) {
      if (!finishKeys.has(edge.end)) continue;
      if (edge.type !== spec.slotEdgeType) continue;
      setEdgePorts(edge);
    }
    return { maxX: finishX, minY, maxY };
  }

  for (const parent of familyParents) {
    layoutFamily(parent.key);
  }
}

function getParallelSlotFamilySpec(node) {
  if (!node) return null;
  if (node.labels?.includes('LocalBinding') && node.labels?.includes('ValueCreate')) {
    return {
      slotEdgeType: 'VALUE',
      isSlotNode: (item) => item?.labels?.includes('Value'),
      isFinishNode: (item) => item?.labels?.includes('DataJoin'),
      reasonLabel: 'const value family',
    };
  }
  if (isCallNode(node)) {
    return {
      slotEdgeType: 'ARG',
      isSlotNode: isArgNode,
      isFinishNode: isArgsNode,
      reasonLabel: 'call argument family',
    };
  }
  if (isObjectNode(node)) {
    return {
      slotEdgeType: 'FIELD',
      isSlotNode: isObjectFieldNode,
      isFinishNode: isMergeFieldsNode,
      reasonLabel: 'object field family',
    };
  }
  return null;
}

function findParallelFamilyShiftY(centralEdges, positions, familyKeys, slotX, laneYs, minTopY = null) {
  let shiftY = 0;
  const maxAttempts = 24;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const shiftedLaneYs = laneYs.map((y) => roundGrid(y + shiftY));
    if (Number.isFinite(minTopY) && shiftedLaneYs[0] <= minTopY + 0.001) {
      shiftY = roundGrid(shiftY + 0.7);
      continue;
    }
    if (!parallelFamilyHitsExistingCorridor(centralEdges, positions, familyKeys, slotX, shiftedLaneYs)) {
      return roundGrid(shiftY);
    }
    shiftY = roundGrid(shiftY + 0.7);
  }
  return roundGrid(shiftY);
}

function findPreviousSiblingFloorY(parentKey, incomingByTarget, outgoingBySource, nodeByKey, positions) {
  const incoming = (incomingByTarget.get(parentKey) || [])
    .filter((edge) => edge.type === 'ARG' || edge.type === 'ArgJoin' || edge.type === 'VALUE' || edge.type === 'FIELD' || edge.type === 'FieldJoin')
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))[0];
  if (!incoming) return null;

  const parentFamilySpec = getParallelSlotFamilySpec(nodeByKey.get(incoming.start));
  if (!parentFamilySpec || incoming.type !== parentFamilySpec.slotEdgeType) return null;

  const siblingEdges = (outgoingBySource.get(incoming.start) || [])
    .filter((edge) => edge.type === parentFamilySpec.slotEdgeType && parentFamilySpec.isSlotNode(nodeByKey.get(edge.end)))
    .sort((left, right) => sortBySourceOrder(nodeByKey.get(left.end), nodeByKey.get(right.end)));
  const parentIndex = siblingEdges.findIndex((edge) => edge.end === parentKey);
  if (parentIndex <= 0) return null;

  const previousYs = siblingEdges
    .slice(0, parentIndex)
    .map((edge) => positions.get(edge.end)?.y)
    .filter((y) => Number.isFinite(y));
  if (!previousYs.length) return null;
  return Math.max(...previousYs);
}

function parallelFamilyHitsExistingCorridor(centralEdges, positions, familyKeys, slotX, laneYs) {
  const upperLaneYs = laneYs.slice(0, Math.max(0, laneYs.length - 1));
  if (!upperLaneYs.length) return false;

  for (const edge of centralEdges) {
    if (familyKeys.has(edge.start) || familyKeys.has(edge.end)) continue;
    const sourcePos = positions.get(edge.start);
    const targetPos = positions.get(edge.layoutEffectiveTargetStableId || edge.end);
    if (!sourcePos || !targetPos) continue;
    if (!Number.isFinite(sourcePos.x) || !Number.isFinite(sourcePos.y)) continue;
    if (!Number.isFinite(targetPos.x) || !Number.isFinite(targetPos.y)) continue;

    if (nearlyEqual(sourcePos.y, targetPos.y)
      && slotX > Math.min(sourcePos.x, targetPos.x)
      && slotX < Math.max(sourcePos.x, targetPos.x)
      && upperLaneYs.some((laneY) => nearlyEqual(laneY, sourcePos.y))) {
      return true;
    }

    if (nearlyEqual(sourcePos.x, targetPos.x)
      && nearlyEqual(slotX, sourcePos.x)
      && upperLaneYs.some((laneY) => laneY > Math.min(sourcePos.y, targetPos.y) && laneY < Math.max(sourcePos.y, targetPos.y))) {
      return true;
    }
  }
  return false;
}

function nearlyEqual(left, right) {
  return Math.abs(Number(left) - Number(right)) < 0.001;
}

function estimateNodeWidthPx(node) {
  if (!node) return 160;
  const props = node.props || {};
  const label = props.label
    || props.operation_subject_text
    || props.operation_value_text
    || props.action_text_raw
    || props.call_text_raw
    || props.name
    || node.key;
  return Math.max(160, Math.min(260, String(label || '').replace(/\s+/g, ' ').trim().length * 6));
}

function setLayoutPosition(positions, key, x, y, reason) {
  const current = positions.get(key) || {};
  positions.set(key, {
    ...current,
    x: roundGrid(x),
    y: roundGrid(y),
    role: current.role || 'argument-flow',
    reason: `${current.reason || 'layout'}; ${reason}`,
  });
}

function findReachableFinishKey(startKey, spec, outgoingBySource, nodeByKey) {
  const seen = new Set();
  const queue = [startKey];
  while (queue.length && seen.size < 100) {
    const key = queue.shift();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const node = nodeByKey.get(key);
    if (spec.isFinishNode(node)) return key;
    for (const edge of outgoingBySource.get(key) || []) {
      if (!['ARG', 'ArgJoin', 'VALUE', 'FIELD', 'FieldJoin', 'NEXT', 'TRUE', 'FALSE', 'REJOINS', 'MERGES_TO'].includes(edge.type)) continue;
      if (nodeByKey.has(edge.end)) queue.push(edge.end);
    }
  }
  return null;
}

function buildMergeNextTargetByKey(centralNodes, centralEdges) {
  const mergeKeys = new Set(centralNodes
    .filter((node) => isMergeNode(node))
    .map((node) => node.key));
  const outgoingBySource = new Map();
  for (const edge of centralEdges) {
    if (!outgoingBySource.has(edge.start)) outgoingBySource.set(edge.start, []);
    outgoingBySource.get(edge.start).push(edge);
  }

  const result = new Map();
  for (const key of mergeKeys) {
    const outgoing = (outgoingBySource.get(key) || [])
      .filter((edge) => edge.type === 'NEXT')
      .sort((left, right) => String(left.end).localeCompare(String(right.end)));
    if (outgoing.length === 1) result.set(key, outgoing[0].end);
  }
  return result;
}

function hasNodeInTargetColumnBetween(centralNodes, positions, edge, sourcePos, targetPos) {
  const minY = Math.min(sourcePos.y, targetPos.y);
  const maxY = Math.max(sourcePos.y, targetPos.y);
  return centralNodes.some((node) => {
    if (node.key === edge.start || node.key === edge.end || node.key === edge.layoutEffectiveTargetStableId) return false;
    const pos = positions.get(node.key);
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return false;
    return pos.x === targetPos.x && pos.y > minY && pos.y < maxY;
  });
}

function canonicalSourceKey(stableId) {
  const match = /^(.*):(\d+):(\d+):(\d+):(\d+)(?::.*)?$/.exec(String(stableId || ''));
  return match ? `${match[1]}:${match[2]}:${match[3]}:${match[4]}:${match[5]}` : stableId;
}

export function hydrateSyntaxCompositions(nodes, compositionNodes, compositionEdges) {
  const partByKey = new Map((compositionNodes || []).map((node) => [node.key, node]));
  const edgesByOwner = new Map();
  for (const edge of compositionEdges || []) {
    if (!edgesByOwner.has(edge.start)) edgesByOwner.set(edge.start, []);
    edgesByOwner.get(edge.start).push(edge);
  }
  return nodes.map((node) => {
    const edges = edgesByOwner.get(node.key) || edgesByOwner.get(canonicalSourceKey(node.key));
    if (!edges?.length) return node;
    const primaryOrder = Number(
      node.props?.compositionPrimaryOrder
      ?? node.props?.composition_primary_order
      ?? 0,
    );
    const parts = edges.map((edge) => {
      const part = partByKey.get(edge.end);
      return {
        stableId: part?.key,
        text: part?.props?.syntax || part?.props?.name || '',
        kind: edge.props?.partKind || edge.props?.part_kind || 'value',
        labels: part?.labels || [],
        order: Number(edge.props?.order ?? 0),
        sourceStableId: part?.key,
      };
    });
    if (!parts.some((part) => part.order === primaryOrder)) {
      parts.push({
        stableId: node.key,
        text: node.props?.diaName
          || node.props?.dia_name
          || node.props?.actionTextRaw
          || node.props?.action_text_raw
          || node.props?.label
          || node.props?.name
          || '',
        kind: 'method',
        labels: node.labels || [],
        order: primaryOrder,
        sourceStableId: node.key,
      });
    }
    parts.sort((left, right) => left.order - right.order || String(left.stableId).localeCompare(String(right.stableId)));
    return {
      ...node,
      props: {
        ...(node.props || {}),
        renderPartsJson: JSON.stringify(parts),
        renderPartsLayout: node.props?.compositionLayout
          || node.props?.composition_layout
          || edges[0]?.props?.layout
          || 'single',
        renderPrimaryPartIndex: primaryOrder,
        renderPartsSource: 'COMPOSES_SYNTAX',
      },
    };
  });
}

async function loadFunctionDiagramSubgraph(localDriver, database, fnStableId) {
  const session = localDriver.session({ database });
  try {
    const rootResult = await session.run(`
      MATCH (fn:Fn {stableId: $fnStableId})
      OPTIONAL MATCH (fn)-[relationship:NEXT {source: $source}]->(owned)
      WHERE coalesce(owned.parentFnStableId, owned.parent_fn_stable_id) = $fnStableId
      RETURN
        {
          elementId: elementId(fn),
          labels: labels(fn),
          props: properties(fn)
        } AS fn,
        collect(DISTINCT CASE WHEN owned IS NULL THEN null ELSE {
          elementId: elementId(owned),
          labels: labels(owned),
          props: properties(owned)
        } END) AS ownedNodes,
        collect(DISTINCT CASE WHEN relationship IS NULL THEN null ELSE {
          elementId: elementId(relationship),
          startElementId: elementId(startNode(relationship)),
          endElementId: elementId(endNode(relationship)),
          type: type(relationship),
          props: properties(relationship)
        } END) AS ownershipEdges
    `, { fnStableId, source: SOURCE });

    const record = rootResult.records[0];
    if (!record) throw new Error(`Function not found: ${fnStableId}`);
    const fnRecord = toPlain(record.get('fn'));
    if (!fnRecord?.elementId) throw new Error(`Function not found: ${fnStableId}`);

    const rawNodesByElementId = new Map([[fnRecord.elementId, fnRecord]]);
    const rawEdgesByElementId = new Map();
    const ownedNodes = toPlain(record.get('ownedNodes')).filter((node) => node?.elementId);
    for (const node of ownedNodes) rawNodesByElementId.set(node.elementId, node);
    for (const edge of toPlain(record.get('ownershipEdges')).filter((item) => item?.elementId)) {
      rawEdgesByElementId.set(edge.elementId, edge);
    }

    const visited = new Set(rawNodesByElementId.keys());
    const traverseFrom = async (initialFrontier) => {
      let frontier = initialFrontier;
      let level = 0;
      while (frontier.length) {
        if (level >= 100) throw new Error(`Function flow traversal exceeded 100 levels: ${fnStableId}`);
        const levelResult = await session.run(`
        UNWIND $frontier AS sourceElementId
        MATCH (source) WHERE elementId(source) = sourceElementId
        MATCH (source)-[relationship {source: $source}]->(target)
        WHERE coalesce(target.parentFnStableId, target.parent_fn_stable_id) = $fnStableId
        RETURN
          collect(DISTINCT {
            elementId: elementId(target),
            labels: labels(target),
            props: properties(target)
          }) AS targetNodes,
          collect(DISTINCT {
            elementId: elementId(relationship),
            startElementId: elementId(startNode(relationship)),
            endElementId: elementId(endNode(relationship)),
            type: type(relationship),
            props: properties(relationship)
          }) AS relationships
        `, { frontier, fnStableId, source: SOURCE });
        const levelRecord = levelResult.records[0];
        const targetNodes = levelRecord ? toPlain(levelRecord.get('targetNodes')) : [];
        const relationships = levelRecord ? toPlain(levelRecord.get('relationships')) : [];
        const nextFrontier = [];
        for (const node of targetNodes) {
          if (!node?.elementId) continue;
          rawNodesByElementId.set(node.elementId, node);
          if (visited.has(node.elementId)) continue;
          visited.add(node.elementId);
          nextFrontier.push(node.elementId);
        }
        for (const edge of relationships) {
          if (edge?.elementId) rawEdgesByElementId.set(edge.elementId, edge);
        }
        frontier = nextFrontier;
        level += 1;
      }
    };
    await traverseFrom(ownedNodes.map((node) => node.elementId));

    const rootEdgesResult = await session.run(`
      MATCH (fn:Fn {stableId: $fnStableId})-[relationship {source: $source}]->(target)
      WHERE elementId(target) IN $reachedElementIds
      RETURN collect(DISTINCT {
        elementId: elementId(relationship),
        startElementId: elementId(startNode(relationship)),
        endElementId: elementId(endNode(relationship)),
        type: type(relationship),
        props: properties(relationship)
      }) AS relationships
    `, {
      fnStableId,
      source: SOURCE,
      reachedElementIds: [...visited],
    });
    for (const edge of toPlain(rootEdgesResult.records[0]?.get('relationships') || [])) {
      if (edge?.elementId) rawEdgesByElementId.set(edge.elementId, edge);
    }

    // Object families can contain several paired brace layers. Each layer is
    // connected only to the fields it encloses; touching mosaic seams and
    // sibling brace layers intentionally have no synthetic graph edges. Once
    // traversal reaches any brace (or the declaration tile touching its outer
    // brace), admit the complete extracted family and its mosaic neighbors.
    const objectFamilyResult = await session.run(`
      MATCH (anchor:ObjectBrace)
      WHERE coalesce(anchor.parentFnStableId, anchor.parent_fn_stable_id) = $fnStableId
        AND (
          anchor.stableId IN $reachedStableIds
          OR coalesce(
            anchor.objectBraceMosaicNeighborStableId,
            anchor.object_brace_mosaic_neighbor_stable_id
          ) IN $reachedStableIds
        )
      WITH collect(DISTINCT coalesce(
        anchor.objectFamilyStableId,
        anchor.object_family_stable_id
      )) AS familyStableIds
      MATCH (member)
      WHERE coalesce(member.parentFnStableId, member.parent_fn_stable_id) = $fnStableId
        AND coalesce(member.objectFamilyStableId, member.object_family_stable_id) IN familyStableIds
      WITH familyStableIds, collect(DISTINCT member) AS members
      UNWIND members AS opening
      OPTIONAL MATCH (opening)-[fieldRelationship:FIELD {source: $source}]->(field)
      WHERE coalesce(field.parentFnStableId, field.parent_fn_stable_id) = $fnStableId
      WITH members,
        collect(DISTINCT field) AS fields,
        collect(DISTINCT fieldRelationship) AS fieldRelationships,
        collect(DISTINCT coalesce(
          opening.objectBraceMosaicNeighborStableId,
          opening.object_brace_mosaic_neighbor_stable_id
        )) AS neighborStableIds
      OPTIONAL MATCH (neighbor)
      WHERE neighbor.stableId IN neighborStableIds
        AND coalesce(neighbor.parentFnStableId, neighbor.parent_fn_stable_id) = $fnStableId
      WITH members, fields, fieldRelationships, collect(DISTINCT neighbor) AS neighbors
      WITH members + fields + neighbors AS familyNodes, fieldRelationships
      UNWIND familyNodes AS familyNode
      WITH collect(DISTINCT familyNode) AS familyNodes, fieldRelationships
      UNWIND familyNodes AS sourceNode
      OPTIONAL MATCH (sourceNode)-[relationship {source: $source}]->(targetNode)
      WHERE targetNode IN familyNodes
      RETURN
        collect(DISTINCT {
          elementId: elementId(sourceNode),
          labels: labels(sourceNode),
          props: properties(sourceNode)
        }) AS nodes,
        collect(DISTINCT CASE WHEN relationship IS NULL THEN null ELSE {
          elementId: elementId(relationship),
          startElementId: elementId(startNode(relationship)),
          endElementId: elementId(endNode(relationship)),
          type: type(relationship),
          props: properties(relationship)
        } END) AS relationships,
        [fieldRelationship IN fieldRelationships WHERE fieldRelationship IS NOT NULL | {
          elementId: elementId(fieldRelationship),
          startElementId: elementId(startNode(fieldRelationship)),
          endElementId: elementId(endNode(fieldRelationship)),
          type: type(fieldRelationship),
          props: properties(fieldRelationship)
        }] AS fieldRelationships
    `, {
      fnStableId,
      source: SOURCE,
      reachedStableIds: [...rawNodesByElementId.values()]
        .map((node) => node?.props?.stableId)
        .filter(Boolean),
    });
    const objectFamilyRecord = objectFamilyResult.records[0];
    const familyFrontier = [];
    for (const node of toPlain(objectFamilyRecord?.get('nodes') || [])) {
      if (!node?.elementId) continue;
      rawNodesByElementId.set(node.elementId, node);
      if (visited.has(node.elementId)) continue;
      visited.add(node.elementId);
      familyFrontier.push(node.elementId);
    }
    const objectFamilyRelationships = [
      ...toPlain(objectFamilyRecord?.get('relationships') || []),
      ...toPlain(objectFamilyRecord?.get('fieldRelationships') || []),
    ];
    for (const edge of objectFamilyRelationships.filter(Boolean)) {
      if (edge?.elementId) rawEdgesByElementId.set(edge.elementId, edge);
    }
    await traverseFrom(familyFrontier);

    const referencedStepStableIds = [...new Set([...rawNodesByElementId.values()]
      .map((node) => node?.props?.parentStepStableId || node?.props?.parent_step_stable_id)
      .filter(Boolean))];
    if (referencedStepStableIds.length) {
      const stepResult = await session.run(`
        UNWIND $stableIds AS stableId
        MATCH (step:Step {stableId: stableId})
        RETURN collect(DISTINCT {
          elementId: elementId(step),
          labels: labels(step),
          props: properties(step)
        }) AS nodes
      `, { stableIds: referencedStepStableIds });
      for (const node of toPlain(stepResult.records[0]?.get('nodes') || [])) {
        if (node?.elementId) rawNodesByElementId.set(node.elementId, node);
      }
    }

    const referencedBlockStableIds = [...new Set([...rawNodesByElementId.values()]
      .map((node) => node?.props?.parentFlowBlockStableId || node?.props?.parent_flow_block_stable_id)
      .filter(Boolean))];
    if (referencedBlockStableIds.length) {
      const blockResult = await session.run(`
        UNWIND $stableIds AS stableId
        MATCH (block:Block {stableId: stableId})
        RETURN collect(DISTINCT {
          elementId: elementId(block),
          labels: labels(block),
          props: properties(block)
        }) AS nodes
      `, { stableIds: referencedBlockStableIds });
      for (const node of toPlain(blockResult.records[0]?.get('nodes') || [])) {
        if (node?.elementId) rawNodesByElementId.set(node.elementId, node);
      }
    }

    let nodes = [...rawNodesByElementId.values()]
      .map((node) => ({
        elementId: node.elementId,
        labels: sanitizeLabels(node.labels),
        props: normalizeGraphProps(toPlain(node.props)),
      }))
      .map((node) => ({
        ...node,
        key: stableKeyForNode(node),
      }))
      .filter((node) => node.key);
    const keyByElementId = new Map(nodes.map((node) => [node.elementId, node.key]));
    const nodeKeySet = new Set(nodes.map((node) => node.key));
    const semanticEdges = uniqueGraphRecordsByElementId([...rawEdgesByElementId.values()])
      .map((edge) => ({
        id: edge.elementId,
        start: keyByElementId.get(edge.startElementId),
        end: keyByElementId.get(edge.endElementId),
        type: sanitizeRelType(edge.type),
        props: toPlain(edge.props),
      }))
      .filter((edge) => edge.start && edge.end && nodeKeySet.has(edge.start) && nodeKeySet.has(edge.end));
    const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
    const edges = semanticEdges.filter((edge) => (
      isFunctionFlowTraversalRelationship(edge.type)
      && (!isProjectionOnlySemanticEdge(edge) || isUiStateResourceValueEdge(edge, nodeByKey))
    ));

    const compositionResult = await session.run(`
      MATCH (owner)
      WHERE owner.stableId IN $ownerStableIds
      MATCH (owner)-[relationship:COMPOSES_SYNTAX]->(part)
      RETURN collect(DISTINCT {
        elementId: elementId(part),
        labels: labels(part),
        props: properties(part)
      }) AS parts,
      collect(DISTINCT {
        startStableId: owner.stableId,
        endElementId: elementId(part),
        type: type(relationship),
        props: properties(relationship)
      }) AS relationships
    `, { ownerStableIds: [...new Set(nodes.map((node) => canonicalSourceKey(node.key)))] });
    const compositionRecord = compositionResult.records[0];
    if (compositionRecord) {
      const compositionNodes = toPlain(compositionRecord.get('parts'))
        .map((node) => ({
          elementId: node.elementId,
          labels: sanitizeLabels(node.labels),
          props: normalizeGraphProps(toPlain(node.props)),
        }))
        .map((node) => ({ ...node, key: stableKeyForNode(node) }))
        .filter((node) => node.key);
      const partKeyByElementId = new Map(compositionNodes.map((node) => [node.elementId, node.key]));
      const compositionEdges = toPlain(compositionRecord.get('relationships'))
        .map((edge) => ({
          start: edge.startStableId,
          end: partKeyByElementId.get(edge.endElementId),
          type: sanitizeRelType(edge.type),
          props: toPlain(edge.props),
        }))
        .filter((edge) => edge.start && edge.end);
      nodes = hydrateSyntaxCompositions(nodes, compositionNodes, compositionEdges);
    }

    return { nodes, edges, semanticEdges };
  } finally {
    await session.close();
  }
}

function buildDiaNameByKey(nodes, edges) {
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  const outgoingBySource = new Map();
  for (const edge of edges) {
    if (!outgoingBySource.has(edge.start)) outgoingBySource.set(edge.start, []);
    outgoingBySource.get(edge.start).push(edge);
  }

  const result = new Map();
  for (const node of nodes) {
    const labels = new Set(node.labels || []);
    const parts = [];

    if (labels.has('Call')) {
      parts.push(`${resolveCallDisplayName(node, outgoingBySource, nodeByKey)}(`);
    }
    if (labels.has('Object')) {
      const objectName = resolveObjectDisplayName(node);
      parts.push(objectName ? `${objectName} {` : '{');
    }
    if (labels.has('Field') && labels.has('Join')) {
      parts.push('}');
    }
    if (labels.has('Arg') && labels.has('Join')) {
      parts.push(')');
    }

    if (parts.length) result.set(node.key, parts.join(' '));
  }
  return result;
}

function resolveCallDisplayName(node, outgoingBySource, nodeByKey) {
  const ownName = node.props.operation_callee_text
    || node.props.callee_name
    || extractCallExpressionName(node.props.action_text_raw || node.props.call_text_raw)
    || node.props.name;
  if (ownName) return ownName;

  const finishKey = findReachableMergeArgsKey(node.key, outgoingBySource, nodeByKey);
  const callTargetEdge = finishKey
    ? (outgoingBySource.get(finishKey) || []).find((edge) => (
      isCallLikeEdge(edge) && nodeByKey.get(edge.end)?.labels?.includes('Fn')
    ))
    : null;
  const targetNode = callTargetEdge ? nodeByKey.get(callTargetEdge.end) : null;
  return targetNode?.props?.name
    || node.props.label
    || 'call';
}

function findReachableMergeArgsKey(startKey, outgoingBySource, nodeByKey) {
  const seen = new Set();
  const queue = [startKey];
  while (queue.length && seen.size < 200) {
    const key = queue.shift();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const node = nodeByKey.get(key);
    if (isMergeArgsNode(node)) return key;
    for (const edge of outgoingBySource.get(key) || []) {
      if (!['ARG', 'ArgJoin', 'VALUE', 'FIELD', 'FieldJoin', 'NEXT', 'TRUE', 'FALSE', 'REJOINS', 'MERGES_TO'].includes(edge.type)) continue;
      if (nodeByKey.has(edge.end)) queue.push(edge.end);
    }
  }
  return null;
}

function resolveObjectDisplayName(node) {
  const props = node.props || {};
  const name = props.object_type
    || props.objectType
    || props.class_name
    || props.className
    || props.object_name
    || props.name;
  const text = String(name || '').trim();
  return text && text !== 'object' ? text : '';
}

function extractCallExpressionName(raw) {
  const text = String(raw || '').trim();
  const match = /^(.+?)\s*\(/u.exec(text);
  if (!match) return '';
  return match[1].trim().replace(/\s+/g, ' ');
}

function portPairForSourcePort(sourcePort, edge, positions) {
  const sourcePos = positions.get(edge.start);
  const targetPos = targetPositionForEdge(edge, positions);
  if (!sourcePos || !targetPos) return { sourcePort, targetPort: null };
  if (sourcePort === 'right-top' || sourcePort === 'right-bottom') return { sourcePort, targetPort: 'left' };
  if (sourcePort === 'left-top' || sourcePort === 'left-bottom') return { sourcePort, targetPort: 'right' };
  if (sourcePort === 'right') return { sourcePort, targetPort: 'left' };
  if (sourcePort === 'left') return { sourcePort, targetPort: 'right' };
  if (sourcePort === 'bottom') return { sourcePort, targetPort: 'top' };
  if (sourcePort === 'top') return { sourcePort, targetPort: 'bottom' };
  return { sourcePort, targetPort: null };
}

function oppositePort(port) {
  if (port === 'right') return 'left';
  if (port === 'left') return 'right';
  if (port === 'bottom') return 'top';
  if (port === 'top') return 'bottom';
  return null;
}

function preferredBranchSourcePort(edge, positions) {
  const sourcePos = positions.get(edge.start);
  const targetPos = targetPositionForEdge(edge, positions);
  if (!sourcePos || !targetPos) return null;
  if (edge.layoutBranchRole === 'down-shorter') return 'bottom';
  if (targetPos.x > sourcePos.x) return 'right';
  if (targetPos.x < sourcePos.x) return 'left';
  if (targetPos.y > sourcePos.y) return 'bottom';
  if (targetPos.y < sourcePos.y) return 'top';
  return null;
}

function buildBranchSourcePortAssignments(edges, positions) {
  const bySource = new Map();
  for (const edge of edges) {
    if (edge.type !== 'TRUE' && edge.type !== 'FALSE') continue;
    if (!bySource.has(edge.start)) bySource.set(edge.start, []);
    bySource.get(edge.start).push(edge);
  }

  const assignments = new Map();
  for (const sourceEdges of bySource.values()) {
    if (sourceEdges.length === 1) {
      const edge = sourceEdges[0];
      const preferred = preferredBranchSourcePort(edge, positions);
      if (preferred) assignments.set(edge.id, preferred);
      continue;
    }

    const used = new Set();
    const ordered = [...sourceEdges].sort((left, right) => {
      const leftRank = left.layoutBranchRole === 'down-shorter' ? 0 : 1;
      const rightRank = right.layoutBranchRole === 'down-shorter' ? 0 : 1;
      return (leftRank - rightRank) || String(left.type).localeCompare(String(right.type));
    });

    for (const edge of ordered) {
      const preferred = preferredBranchSourcePort(edge, positions);
      const candidates = [preferred, 'right', 'left', 'bottom', 'top'].filter(Boolean);
      const selected = candidates.find((port) => !used.has(port)) || preferred || 'bottom';
      assignments.set(edge.id, selected);
      used.add(selected);
    }
  }

  return assignments;
}

function portForDirectEdge(edge, positions, branchSourcePorts) {
  if (edge.layoutSourcePort || edge.layoutTargetPort) {
    return {
      sourcePort: edge.layoutSourcePort || null,
      targetPort: edge.layoutTargetPort || null,
    };
  }

  const assignedBranchPort = branchSourcePorts.get(edge.id);
  if (assignedBranchPort) return portPairForSourcePort(assignedBranchPort, edge, positions);

  const sourcePos = positions.get(edge.start);
  const targetPos = targetPositionForEdge(edge, positions);
  if (!sourcePos || !targetPos) return { sourcePort: null, targetPort: null };
  if (targetPos.y > sourcePos.y) return { sourcePort: 'bottom', targetPort: 'top' };
  if (targetPos.y < sourcePos.y) return { sourcePort: 'top', targetPort: 'bottom' };
  if (targetPos.x > sourcePos.x) return { sourcePort: 'right', targetPort: 'left' };
  if (targetPos.x < sourcePos.x) return { sourcePort: 'left', targetPort: 'right' };
  return { sourcePort: null, targetPort: null };
}

function targetPositionForEdge(edge, positions) {
  return positions.get(edge.layoutEffectiveTargetStableId || edge.end);
}

export {
  DEFAULT_FN_STABLE_ID,
  SOURCE,
  coordinateLocalGraph,
  isProjectionOnlySemanticEdge,
  loadFunctionDiagramSubgraph,
  materializeVisualProxies,
};
