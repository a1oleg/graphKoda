import { runReadQuery } from '../../../runtime-relay/src/runtimeEvents.js';
import { normalizeGraphNode, normalizeGraphRelationship } from './featureGraph.js';

const FUNCTION_FLOW_SOURCE = 'semantic/functionFlowGraph';
const PHASE_SOURCE = 'semantic/phaseGraph';
const LOCAL_CONTROL_FLOW_RELATIONSHIP_PATTERN = ':NEXT|TRUE|FALSE|OPTION_CASE|OPTION_DEFAULT|REJOINS|MERGES_TO';

function normalizePhaseRecord(phase) {
  const properties = phase?.properties || {};
  return {
    key: properties.key,
    label: properties.label,
    phaseKind: properties.phase_kind,
    featureKey: properties.feature_key,
    order: properties.order,
    direction: properties.direction,
    ownerFnStableId: properties.ownerFnStableId,
    headStepStableId: properties.headStepStableId,
    tailStepStableId: properties.tailStepStableId,
    source: properties.source,
  };
}

export async function resolvePhaseEntity(driver, database, { key } = {}) {
  const phaseKey = String(key || 'turn.input-intake').trim();
  const records = await runReadQuery(
    driver,
    database,
    `
      MATCH (phase:Phase {source: $source})
      WHERE phase.key = $phaseKey
      OPTIONAL MATCH (owner:Fn {stableId: phase.ownerFnStableId})
      OPTIONAL MATCH (phase)-[:HEADS_AT]->(head:Step)
      OPTIONAL MATCH (phase)-[:TAILS_AT]->(tail:Step)
      RETURN phase, owner, head, tail
      ORDER BY phase.order
      LIMIT 1
    `,
    { source: PHASE_SOURCE, phaseKey },
  );

  const record = records[0];
  if (!record?.phase) {
    throw new Error(`Phase was not found in Neo4j: ${phaseKey}.`);
  }

  return {
    ...normalizePhaseRecord(record.phase),
    owner: record.owner ? normalizeGraphNode(record.owner) : null,
    head: record.head ? normalizeGraphNode(record.head) : null,
    tail: record.tail ? normalizeGraphNode(record.tail) : null,
  };
}

async function queryLocalHeadTailPath(driver, database, phase) {
  if (!phase?.headStepStableId || !phase?.tailStepStableId) {
    return undefined;
  }

  const records = await runReadQuery(
    driver,
    database,
    `
      MATCH (head {stableId: $headStepStableId})
      MATCH (tail {stableId: $tailStepStableId})
      MATCH path = shortestPath((head)-[${LOCAL_CONTROL_FLOW_RELATIONSHIP_PATTERN}*..120]->(tail))
      WHERE all(rel IN relationships(path) WHERE rel.source = $source)
        AND all(node IN nodes(path) WHERE
          (node:Fn AND node.stableId = $ownerFnStableId)
          OR (node:Step AND node.parentFnStableId = $ownerFnStableId)
        )
      RETURN nodes(path) AS nodes, relationships(path) AS rels
      LIMIT 1
    `,
    {
      headStepStableId: phase.headStepStableId,
      tailStepStableId: phase.tailStepStableId,
      ownerFnStableId: phase.ownerFnStableId,
      source: FUNCTION_FLOW_SOURCE,
    },
  );

  if (!records[0]) {
    return undefined;
  }

  return {
    nodes: records[0].nodes.map((node) => normalizeGraphNode(node)),
    rels: records[0].rels.map((rel) => normalizeGraphRelationship(rel)),
    pathKind: 'phase-local-order',
  };
}

function buildSyntheticCallTarget(step) {
  if (!step?.operationCalleeText) {
    return null;
  }

  const normalizedName = String(step.operationCalleeText).replace(/\s+/g, ' ').trim();
  if (!normalizedName) {
    return null;
  }

  return {
    stableId: `call-target:${normalizedName}`,
    name: normalizedName,
    label: normalizedName,
    labels: ['CallTarget'],
    isFunction: false,
    isExternal: false,
    synthetic: true,
  };
}

async function enrichPathCallTargets(driver, database, pathItem) {
  const stepStableIds = (pathItem?.nodes || [])
    .map((node) => node?.stableId)
    .filter(Boolean);
  if (!stepStableIds.length) {
    return pathItem;
  }

  const records = await runReadQuery(
    driver,
    database,
    `
      UNWIND $stepStableIds AS stepStableId
      MATCH (step:Step {stableId: stepStableId})
      OPTIONAL MATCH (step)-[callRel]->(callee:Fn)
      WHERE callRel.source = $source AND type(callRel) = 'CALL'
      RETURN stepStableId, collect(callee)[0] AS callee
    `,
    { stepStableIds, source: FUNCTION_FLOW_SOURCE },
  );
  const calleeByStepStableId = new Map(
    records
      .filter((record) => record.stepStableId)
      .map((record) => [
        record.stepStableId,
        record.callee ? normalizeGraphNode(record.callee) : null,
      ]),
  );

  return {
    ...pathItem,
    nodes: (pathItem.nodes || []).map((node) => {
      const callTarget = calleeByStepStableId.get(node.stableId) || buildSyntheticCallTarget(node);
      return callTarget ? { ...node, callTarget } : node;
    }),
  };
}

export async function loadPhasePathGraphData(driver, database, phase) {
  const resolvedPhase = phase?.headStepStableId && phase?.tailStepStableId
    ? phase
    : await resolvePhaseEntity(driver, database, { key: phase?.key });
  const localPath = await queryLocalHeadTailPath(driver, database, resolvedPhase);

  if (!localPath) {
    return {
      available: false,
      error: `No local phase path was found from head to tail for ${resolvedPhase?.key || 'phase'}.`,
      phase: resolvedPhase,
      headStableId: resolvedPhase?.headStepStableId || null,
      tailStableId: resolvedPhase?.tailStepStableId || null,
      pathCount: 0,
      paths: [],
    };
  }

  const enrichedPath = await enrichPathCallTargets(driver, database, localPath);

  return {
    available: true,
    error: null,
    phase: resolvedPhase,
    headStableId: resolvedPhase.headStepStableId,
    tailStableId: resolvedPhase.tailStepStableId,
    pathCount: 1,
    nodeCount: localPath.nodes.length,
    edgeCount: localPath.rels.length,
    paths: [enrichedPath],
    payload: JSON.stringify({
      phase: resolvedPhase,
      headStableId: resolvedPhase.headStepStableId,
      tailStableId: resolvedPhase.tailStepStableId,
      pathCount: 1,
      paths: [enrichedPath],
    }),
  };
}


