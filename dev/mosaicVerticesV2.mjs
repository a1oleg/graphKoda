export const MOSAIC_VERSION = 'mosaic-vertices/v2';
export { projectMosaicGraph } from '../graph/packages/orchestrator/src/orchestrator/mosaicGraph.js';
import { mosaicPart, validateMosaicChains } from '../graph/packages/orchestrator/src/orchestrator/mosaicGraph.js';

// This transport-stage contract is opt-in; ordinary extraction remains v1.
export function materializeMosaicVertices(payload) {
  const entities = new Map(payload.semanticEntities.map(n => [n.stableId, n]));
  const obsolete = new Set();
  const owners = new Set();
  const usedLiterals = new Set();
  const merges = new Map();
  const inlineInitializers = new Map();
  const aliases = new Map();
  for (const owner of payload.nodes) {
    const raw = owner.props?.render_parts_json;
    if (!raw) continue;
    const parts = JSON.parse(raw);
    if (!parts.length) continue;
    const declaration = entities.get(parts[1]?.sourceStableId);
    const assignment = parts.length === 4 && owner.props.container_method_kind === 'set'
      && parts[2].kind === 'literal' && declaration?.labels.includes('ValueDeclaration');
    if (assignment && declaration.stableId !== owner.stableId) {
      merges.set(declaration.stableId, owner.stableId);
      inlineInitializers.set(owner.stableId, parts[2].sourceStableId);
      owner.labels = [...new Set([...(owner.labels || []), 'ValueDeclaration'])];
      owner.props.declarationSourceStableId = declaration.stableId;
      owner.props.declarationKind = declaration.props.declarationKind;
      owner.props.semanticMosaicKind = 'literal-assignment';
    }
    owners.add(owner.stableId);
    owner.props.mosaicContractVersion = MOSAIC_VERSION;
    owner.props.mosaicPartCount = parts.length;
    let previous;
    parts.forEach((part, index) => {
      const literal = part.kind === 'literal' && !usedLiterals.has(part.sourceStableId) && entities.get(part.sourceStableId);
      if (literal) usedLiterals.add(part.sourceStableId);
      const stableId = index === 0 ? owner.stableId
        : literal ? part.sourceStableId : `${owner.stableId}:mosaic-v2:part:${index}`;
      const existing = index === 0 ? owner : literal;
      const props = {
        mosaicContractVersion: MOSAIC_VERSION,
        ownerStableId: owner.stableId,
        sourceStableId: part.sourceStableId,
        canonicalStableId: part.canonicalStableId,
        name: part.text, partKind: part.kind, partOrder: index,
        stableId,
        parentFnStableId: owner.props.parentFnStableId,
        parentStepStableId: owner.props.parentStepStableId,
        tileFields: Object.keys(part).filter(key => part[key] !== undefined && !['stableId', 'graphStableId'].includes(key)),
      };
      for (const key of props.tileFields) {
        const value = part[key];
        if (value !== null && typeof value === 'object'
          && !(Array.isArray(value) && value.every(x => ['string', 'number', 'boolean'].includes(typeof x)))) {
          throw new Error(`Non-scalar mosaic property: ${owner.stableId}.${key}`);
        }
        props[`tile_${key}`] = value;
      }
      if (part.stableId) {
        const candidates = aliases.get(part.stableId) || [];
        candidates.push({ owner: owner.stableId, id: stableId });
        aliases.set(part.stableId, candidates);
      }
      if (existing) {
        existing.labels = [...new Set([...(existing.labels || []), 'MosaicPart'])];
        Object.assign(existing.props, props);
      } else payload.semanticEntities.push({ stableId, labels: [...new Set(['MosaicPart', ...(part.labels || [])])], props });
      if (previous) payload.semanticRelationships.push({ fromId: previous, toId: stableId,
        type: assignment ? ['WRITE', 'ARGUMENT', 'CLOSES'][index - 1] : 'MOSAIC_NEXT',
        props: { ownerStableId: owner.stableId, order: index, source: owner.props.source,
          layout: 'mosaic', mosaicContractVersion: MOSAIC_VERSION, renderHidden: true,
          ...(assignment && index === 1 ? { operation: 'assign', virtual: true } : {}),
          ...(assignment && index === 2 ? { index: 0, role: 'value' } : {}),
          ...(assignment && index === 3 ? { closesStableId: `${owner.stableId}:mosaic-v2:part:1` } : {}),
        } });
      previous = stableId;
    });
    // A literal already in the mosaic needs no synthetic evaluation operation.
    const literal = parts.find(p => p.kind === 'literal');
    const producerId = owner.props.producer_start_stable_id;
    const producer = payload.nodes.find(n => n.stableId === producerId);
    const incident = payload.edges.filter(e => e.fromId === producerId || e.toId === producerId);
    if (literal && producer?.labels.includes('Evaluate')
      && producer.props.instrumentation_target_stable_id === literal.sourceStableId
      && incident.length === 1 && incident[0].type === 'ASSIGNS_VALUE'
      && incident[0].toId === owner.stableId) {
      obsolete.add(producerId);
      owner.props.producer_start_stable_id = null;
      owner.props.producer_end_stable_ids = null;
    }
    delete owner.props.render_parts_json;
    delete owner.props.renderPartsJson;
    delete owner.renderPartsJson;
  }
  payload.nodes = payload.nodes.filter(n => !obsolete.has(n.stableId));
  payload.edges = payload.edges.filter(e => !obsolete.has(e.fromId) && !obsolete.has(e.toId));
  payload.semanticRelationships = payload.semanticRelationships.filter(e =>
    !(e.type === 'COMPOSES_SYNTAX' && owners.has(e.fromId)));
  for (const key of ['semanticRelationships', 'edges', 'resourceLinks', 'resourceEdges']) {
    if (!payload[key]) continue;
    payload[key] = payload[key].map(e => ({ ...e,
      fromId: merges.get(e.fromId) || e.fromId, toId: merges.get(e.toId) || e.toId,
    })).filter(e => !(inlineInitializers.get(e.fromId) === e.toId
      && (e.type === 'VALUE_FROM' || (e.type === 'AST_CHILD' && e.props?.field === 'initializer'))));
  }
  payload.semanticEntities = payload.semanticEntities.filter(n => !merges.has(n.stableId));
  payload.nodes = payload.nodes.filter(n => !merges.has(n.stableId));
  // Canonical reference properties must resolve to the same variable as graph edges.
  const rewriteReferences = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (/^(canonicalStableId|bindingStableId|value_slot_stableId)$/.test(key) && merges.has(item)) value[key] = merges.get(item);
      else if (typeof item === 'object') rewriteReferences(item);
      else if (/^tile_(canonicalStableId|bindingStableId)$/.test(key) && merges.has(item)) value[key] = merges.get(item);
    }
  };
  rewriteReferences(payload);
  const graphParts = [...payload.nodes, ...payload.semanticEntities].filter(n => n.props?.mosaicContractVersion);
  for (const edge of payload.edges) {
    edge.props ||= {};
    if (edge.type === 'ASSIGNS_VALUE' && !edge.sourceRenderPartStableId
      && !edge.props.sourceRenderPartStableId && !edge.props.source_render_part_stable_id) {
      const closing = graphParts.filter(n => n.props.ownerStableId === edge.fromId
        && n.props.tile_text === ')' && (n.props.tile_labels || []).some(label => ['Method', 'CallBoundary'].includes(label)))
        .sort((a, b) => b.props.partOrder - a.props.partOrder)[0];
      if (closing) {
        edge.props.sourceLayoutOwnerStableId = edge.fromId;
        edge.fromId = closing.stableId;
      }
    }
    for (const [side, endpoint] of [['source', 'fromId'], ['target', 'toId']]) {
      const camel = `${side}RenderPartStableId`;
      const snake = `${side}_render_part_stable_id`;
      const alias = edge.props[snake] || edge.props[camel] || edge[camel];
      if (!alias) continue;
      const candidates = aliases.get(alias) || [];
      const local = candidates.filter(p => p.owner === edge[endpoint]);
      const resolved = local.length ? local : candidates;
      if (resolved.length !== 1) throw new Error(`Unresolved mosaic endpoint ${edge.type} ${side}: ${alias} (${resolved.length})`);
      edge.props[`${side}LayoutOwnerStableId`] = edge[endpoint];
      edge[endpoint] = resolved[0].id;
      delete edge[camel];
      delete edge.props[camel];
      delete edge.props[snake];
    }
  }
  validateMosaicChains([...payload.nodes, ...payload.semanticEntities].map(n => ({ key: n.stableId, props: n.props })),
    payload.semanticRelationships.map(e => ({ start: e.fromId, end: e.toId, props: e.props })));
  payload.mergedMosaicNodeIds = [...merges].map(([from, to]) => ({ from, to }));
  payload.obsoleteMosaicNodeIds = [...obsolete];
  return payload;
}

export function applyMosaicVertices(nodes, records) {
  const groups = new Map();
  for (const { owner, part } of records) {
    const list = groups.get(owner) || [];
    list.push(part);
    groups.set(owner, list);
  }
  return nodes.map(node => {
    if (node.props?.mosaicContractVersion !== MOSAIC_VERSION) return node;
    const parts = (groups.get(node.key) || []).sort((a, b) => a.partOrder - b.partOrder);
    if (parts.length !== Number(node.props.mosaicPartCount)
      || parts.some((p, i) => Number(p.partOrder) !== i)) throw new Error(`Incomplete v2 mosaic: ${node.key}`);
    return { ...node, props: { ...node.props,
    }, mosaicParts: parts.map(mosaicPart) };
  });
}

export async function loadMosaicVertices(driver, database, nodes) {
  const ids = nodes.filter(n => n.props?.mosaicContractVersion === MOSAIC_VERSION).map(n => n.key);
  if (!ids.length) return nodes;
  const session = driver.session({ database });
  try {
    const result = await session.run(`MATCH (owner) WHERE owner.stableId IN $ids
      MATCH path=(owner)-[:MOSAIC_NEXT|WRITE|ARGUMENT|CLOSES*0..]->(part:MosaicPart)
      WHERE part.mosaicContractVersion = $version AND part.ownerStableId = owner.stableId
        AND all(r IN relationships(path) WHERE r.ownerStableId = owner.stableId)
      RETURN owner.stableId AS owner, properties(part) AS part`, { ids, version: MOSAIC_VERSION });
    return applyMosaicVertices(nodes, result.records.map(r => r.toObject()));
  } finally { await session.close(); }
}
