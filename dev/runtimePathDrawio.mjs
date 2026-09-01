import { readFile, writeFile } from 'node:fs/promises';

function parseAttributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
}

function parseCells(xml) {
  return [...xml.matchAll(/<mxCell\b[^>]*>/g)].map((match) => ({
    tag: match[0],
    index: match.index,
    attrs: parseAttributes(match[0]),
  }));
}

function runtimeStableIdKey(stableId) {
  const normalized = String(stableId || '').replace(/\\/g, '/');
  const match = /(?:^|:)((?:[A-Za-z]:\/)?[^:]+?\.(?:tsx?|jsx?|mjs|cjs)):(\d+):(\d+):(\d+):(\d+)(?::|$)/i.exec(normalized);
  return match
    ? `${match[1]}:${match[2]}:${match[3]}:${match[4]}:${match[5]}`
    : normalized;
}

function observedOutcomeEdge(outgoing, outcome) {
  const expected = outcome ? 'TRUE' : 'FALSE';
  const expectedProducerOutcome = outcome ? 'true' : 'false';
  return outgoing.find((edge) => (
    edge.attrs.edgeType === expected
    || edge.attrs.value?.toUpperCase() === expected
    || edge.attrs.producerOutcome === expectedProducerOutcome
  ));
}

function shortestObservedPath(sourceIds, targetIds, outgoingBySource, outcome) {
  const expectedEdgeType = typeof outcome === 'boolean' ? (outcome ? 'TRUE' : 'FALSE') : null;
  const expectedProducerOutcome = typeof outcome === 'boolean' ? String(outcome) : null;
  const queue = [];
  const visited = new Set(sourceIds);
  for (const sourceId of sourceIds) {
    const outgoing = outgoingBySource.get(sourceId) || [];
    const initialEdges = expectedEdgeType
      ? outgoing.filter((edge) => (
        edge.attrs.edgeType === expectedEdgeType
        || edge.attrs.value?.toUpperCase() === expectedEdgeType
        || edge.attrs.producerOutcome === expectedProducerOutcome
      ))
      : outgoing;
    for (const edge of initialEdges) {
      if (!edge.attrs.target) continue;
      if (targetIds.has(edge.attrs.target)) return [edge];
      queue.push({ nodeId: edge.attrs.target, edges: [edge] });
    }
  }

  while (queue.length) {
    const current = queue.shift();
    if (visited.has(current.nodeId)) continue;
    visited.add(current.nodeId);
    for (const edge of outgoingBySource.get(current.nodeId) || []) {
      const target = edge.attrs.target;
      if (!target || visited.has(target)) continue;
      const edges = [...current.edges, edge];
      if (targetIds.has(target)) return edges;
      queue.push({ nodeId: target, edges });
    }
  }
  return [];
}

const DATA_FANOUT_EDGE_TYPES = new Set(['ARG', 'FIELD']);
const DATA_JOIN_EDGE_TYPES = new Set(['ArgJoin', 'FieldJoin', 'XOR_JOIN']);
const DATA_VALUE_EDGE_TYPES = new Set([
  'ASSIGNS_VALUE',
  'YIELDS_VALUE',
  'PASSES_VALUE',
  'EMITS_VALUE',
  'PRODUCES_VALUE',
  'RESULT',
  'EVAL',
]);

function expandObservedDataEdges(edges, activeNodeIds, selected, activateNode) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      const edgeType = edge.attrs.edgeType || '';
      const source = edge.attrs.source;
      const target = edge.attrs.target;
      if (!source || !target || selected.has(edge.attrs.id)) continue;
      if (edge.attrs.producerOutcome) continue;
      const sourceActive = activeNodeIds.has(source);
      const targetActive = activeNodeIds.has(target);
      const include = DATA_FANOUT_EDGE_TYPES.has(edgeType)
        ? sourceActive || targetActive
        : DATA_JOIN_EDGE_TYPES.has(edgeType) || DATA_VALUE_EDGE_TYPES.has(edgeType)
          ? sourceActive
          : false;
      if (!include) continue;
      selected.set(edge.attrs.id, edge);
      activateNode(source);
      activateNode(target);
      changed = true;
    }
  }
}

function expandDeterministicControlEdges(outgoingBySource, activeNodeIds, selected, activateNode) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const source of [...activeNodeIds]) {
      const outgoing = outgoingBySource.get(source) || [];
      if (outgoing.some((edge) => ['TRUE', 'FALSE'].includes(edge.attrs.edgeType))) continue;
      const continuations = outgoing.filter((edge) => edge.attrs.edgeType === 'NEXT');
      if (continuations.length !== 1) continue;
      const [edge] = continuations;
      if (!edge.attrs.target || selected.has(edge.attrs.id)) continue;
      selected.set(edge.attrs.id, edge);
      activateNode(source);
      activateNode(edge.attrs.target);
      changed = true;
    }
  }
}

function runtimeNodeRole(cell) {
  const labels = new Set(String(cell?.attrs.graphLabels || '').split(',').filter(Boolean));
  if (labels.has('Branch')) return 'predicate-stage';
  if (labels.has('DataJoin')) return 'join-stage';
  if (labels.has('Join') && (labels.has('Flow') || labels.has('Exclusive')) && !labels.has('FnVisualProxy')) {
    return 'join-stage';
  }
  return '';
}

function clearRuntimeStroke(tag) {
  const attrs = parseAttributes(tag);
  if (attrs.runtimeObserved !== '1') return tag;
  const baseStrokeWidth = attrs.runtimeBaseStrokeWidth || '';
  let style = (attrs.style || '').replace(/(^|;)strokeWidth=[^;]*;?/, '$1');
  if (baseStrokeWidth) {
    style = `${style}${style && !style.endsWith(';') ? ';' : ''}strokeWidth=${baseStrokeWidth};`;
  }
  return tag
    .replace(/style="[^"]*"/, `style="${style}"`)
    .replace(/\s+runtimeObserved="[^"]*"/, '')
    .replace(/\s+runtimeSessionId="[^"]*"/, '')
    .replace(/\s+runtimeBaseStrokeWidth="[^"]*"/, '');
}

function clearPreviousRuntimePath(xml) {
  return xml.replace(/<mxCell\b[^>]*>/g, (tag) => clearRuntimeStroke(tag));
}

export function buildRuntimePathSelection(xml, chain) {
  const cells = parseCells(xml);
  const edges = cells.filter((cell) => cell.attrs.edge === '1' && cell.attrs.source && cell.attrs.target);
  const outgoingBySource = new Map();
  const nodesByStableId = new Map();
  const cellsById = new Map(cells.map((cell) => [cell.attrs.id, cell]));
  const relatedStableIds = new Map();
  const objectFamilyMembers = new Map();

  const relateStableIds = (left, right) => {
    left = runtimeStableIdKey(left);
    right = runtimeStableIdKey(right);
    if (!left || !right || left === right) return;
    const leftSet = relatedStableIds.get(left) || new Set();
    const rightSet = relatedStableIds.get(right) || new Set();
    leftSet.add(right);
    rightSet.add(left);
    relatedStableIds.set(left, leftSet);
    relatedStableIds.set(right, rightSet);
  };

  for (const cell of cells) {
    if (cell.attrs.stableId && cell.attrs.vertex === '1') {
      const stableIdKey = runtimeStableIdKey(cell.attrs.stableId);
      const current = nodesByStableId.get(stableIdKey) || [];
      current.push(cell.attrs.id);
      nodesByStableId.set(stableIdKey, current);
      for (const key of [
        'objectBraceMosaicNeighborStableId',
        'compositionOwnerStableId',
        'overlayOwnerStableId',
        'attachmentOwnerStableId',
        'mosaicOwnerStableIds',
      ]) {
        for (const related of String(cell.attrs[key] || '').split(',').filter(Boolean)) {
          relateStableIds(cell.attrs.stableId, related);
        }
      }
      if (cell.attrs.objectFamilyStableId) {
        const members = objectFamilyMembers.get(cell.attrs.objectFamilyStableId) || new Set();
        members.add(stableIdKey);
        objectFamilyMembers.set(cell.attrs.objectFamilyStableId, members);
      }
    }
  }
  for (const members of objectFamilyMembers.values()) {
    const stableIds = [...members];
    for (let index = 1; index < stableIds.length; index += 1) relateStableIds(stableIds[0], stableIds[index]);
  }
  for (const edge of edges) {
    const current = outgoingBySource.get(edge.attrs.source) || [];
    current.push(edge);
    outgoingBySource.set(edge.attrs.source, current);
  }

  const visibleChain = chain.filter((event) => (
    (nodesByStableId.get(runtimeStableIdKey(event.stableId)) || []).length
  ));
  const predicates = visibleChain.filter((event) => event.role === 'predicate' && typeof event.outcome === 'boolean');
  const selected = new Map();
  for (const event of predicates) {
    const sourceIds = nodesByStableId.get(runtimeStableIdKey(event.stableId)) || [];
    const outcomeEdge = sourceIds
      .map((sourceId) => observedOutcomeEdge(outgoingBySource.get(sourceId) || [], event.outcome))
      .find(Boolean);
    if (!outcomeEdge) {
      throw new Error(`No ${event.outcome ? 'TRUE' : 'FALSE'} edge for observed ${event.stableId}`);
    }
    selected.set(outcomeEdge.attrs.id, outcomeEdge);

  }

  for (let index = 0; index + 1 < visibleChain.length; index += 1) {
    const event = visibleChain[index];
    const next = visibleChain[index + 1];
    const sourceIds = nodesByStableId.get(runtimeStableIdKey(event.stableId)) || [];
    const targetIds = new Set(nodesByStableId.get(runtimeStableIdKey(next.stableId)) || []);
    if (!sourceIds.length || !targetIds.size) continue;
    for (const edge of shortestObservedPath(sourceIds, targetIds, outgoingBySource, event.outcome)) {
      selected.set(edge.attrs.id, edge);
    }
  }

  const activeNodeIds = new Set();
  const activateNode = (initialId) => {
    const queue = [initialId];
    while (queue.length) {
      const id = queue.shift();
      if (!id || activeNodeIds.has(id)) continue;
      activeNodeIds.add(id);
      const stableId = runtimeStableIdKey(cellsById.get(id)?.attrs.stableId || '');
      if (!stableId) continue;
      for (const aliasId of nodesByStableId.get(stableId) || []) queue.push(aliasId);
      for (const relatedStableId of relatedStableIds.get(stableId) || []) {
        for (const relatedId of nodesByStableId.get(relatedStableId) || []) queue.push(relatedId);
      }
    }
  };
  for (const event of visibleChain) {
    for (const id of nodesByStableId.get(runtimeStableIdKey(event.stableId)) || []) activateNode(id);
  }
  for (const edge of selected.values()) {
    if (edge.attrs.source) activateNode(edge.attrs.source);
    if (edge.attrs.target) activateNode(edge.attrs.target);
  }
  expandObservedDataEdges(edges, activeNodeIds, selected, activateNode);
  expandDeterministicControlEdges(outgoingBySource, activeNodeIds, selected, activateNode);
  expandObservedDataEdges(edges, activeNodeIds, selected, activateNode);

  const observedOutcomes = new Map(chain
    .filter((event) => event.role === 'predicate')
    .map((event) => [event.stableId, event.outcome]));
  const highlighted = new Map(chain
    .filter((event) => event.role === 'predicate')
    .map((event) => [event.stableId, {
      stableId: event.stableId,
      role: 'predicate-stage',
      outcome: event.outcome,
    }]));
  for (const edge of selected.values()) {
    for (const id of [edge.attrs.source, edge.attrs.target]) {
      const cell = cellsById.get(id);
      const role = runtimeNodeRole(cell);
      const stableId = cell?.attrs.stableId || '';
      if (!role || !stableId || highlighted.has(stableId)) continue;
      let outcome = observedOutcomes.get(stableId);
      if (role === 'predicate-stage' && typeof outcome !== 'boolean' && id === edge.attrs.source) {
        if (edge.attrs.edgeType === 'TRUE' || edge.attrs.edgeType === 'FALSE') outcome = edge.attrs.edgeType === 'TRUE';
        else if (edge.attrs.producerOutcome) outcome = edge.attrs.producerOutcome === 'true';
      }
      highlighted.set(stableId, { stableId, role, outcome });
    }
  }

  return {
    involvedEdgeIds: [...selected.keys()],
    edgePairs: [...selected.values()].map((edge) => ({
      sourceStableId: edge.attrs.stableId || '',
      targetStableId: edge.attrs.targetStableId || '',
      edgeType: edge.attrs.edgeType || '',
      producerOutcome: edge.attrs.producerOutcome || '',
      weight: 1,
    })),
    staticStableIds: [...new Set(chain.map((event) => event.stableId).filter(Boolean))],
    nodeHighlights: [...highlighted.values()],
  };
}

export async function clearRuntimePathFromDiagram(diagramPath) {
  const xml = await readFile(diagramPath, 'utf8');
  await writeFile(diagramPath, clearPreviousRuntimePath(xml), 'utf8');
}
