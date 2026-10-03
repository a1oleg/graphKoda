import type { FiniteLiteralDomainGraph } from './functionFlowGraph.literalDomains.js';

type Positions = Map<string, number[]>;
type Index = { occurrences: Positions; entities: Positions; members: Positions; resolutions: Positions };

// Collected graphs are immutable snapshots; do not retain them beyond their owner.
const indexes = new WeakMap<FiniteLiteralDomainGraph, Index>();

function add(map: Positions, key: string, position: number) {
  const positions = map.get(key);
  if (positions) positions.push(position);
  else map.set(key, [position]);
}

function selectPositions(map: Positions, keys: Iterable<string>) {
  const selected = new Set<number>();
  for (const key of keys) for (const position of map.get(key) || []) selected.add(position);
  return [...selected].sort((a, b) => a - b);
}

export function selectFiniteLiteralDomainContext(graph: FiniteLiteralDomainGraph, functionIds: Iterable<string>) {
  let index = indexes.get(graph);
  if (!index) {
    index = { occurrences: new Map(), entities: new Map(), members: new Map(), resolutions: new Map() };
    graph.occurrences.forEach((row, position) => {
      if (row.parentFnStableId) add(index!.occurrences, row.parentFnStableId, position);
    });
    graph.entities.forEach((row, position) => add(index!.entities, row.stableId, position));
    graph.relationships.forEach((row, position) => {
      if (row.type === 'HAS_MEMBER') add(index!.members, row.fromId, position);
      if (row.type === 'RESOLVES_TO') add(index!.resolutions, row.fromId, position);
    });
    indexes.set(graph, index);
  }
  const occurrences = selectPositions(index.occurrences, functionIds).map(position => graph.occurrences[position]);
  const occurrenceIds = new Set(occurrences.map(row => row.stableId));
  const domainIds = new Set(occurrences.map(row => row.domainStableId));
  const memberPositions = selectPositions(index.members, domainIds);
  const entityIds = new Set([...occurrenceIds, ...domainIds]);
  for (const position of memberPositions) entityIds.add(graph.relationships[position].toId);
  const relationshipPositions = [...new Set([
    ...memberPositions, ...selectPositions(index.resolutions, occurrenceIds),
  ])].sort((a, b) => a - b);
  return {
    occurrences,
    entities: selectPositions(index.entities, entityIds).map(position => graph.entities[position]),
    relationships: relationshipPositions.map(position => graph.relationships[position]),
  };
}
