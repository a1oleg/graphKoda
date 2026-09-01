import process from 'node:process';

import { config } from 'dotenv';
import neo4j from 'neo4j-driver';

import { runReadQuery } from '../graph/packages/runtime-relay/src/runtimeEvents.js';

config({ path: 'graph/.env' });

const FUNCTION_FLOW_SOURCE = 'functionFlowGraph';
const STATEFUL_SOURCE = 'stateful';

const database = process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j';
const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USER || process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD),
);

function parseArgs(argv) {
  const args = {
    fnStableId: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--fn-stable-id') {
      args.fnStableId = argv[index + 1];
      index += 1;
    }
  }

  if (!args.fnStableId) {
    throw new Error('Pass --fn-stable-id to export function flow paths.');
  }

  return args;
}

function isDecisionEdgeType(edgeType) {
  return edgeType === 'TRUE'
    || edgeType === 'FALSE'
    || edgeType === 'OPTION_CASE'
    || edgeType === 'OPTION_DEFAULT';
}

function normalizeBranchTaken(edgeType, edgeLabel) {
  if (edgeType === 'TRUE') {
    return 'true';
  }

  if (edgeType === 'FALSE') {
    return 'false';
  }

  if (edgeType === 'OPTION_DEFAULT') {
    return 'default';
  }

  if (edgeType === 'OPTION_CASE') {
    return edgeLabel || 'case';
  }

  if (edgeType === 'REJOINS' || edgeType === 'MERGES_TO') {
    return 'rejoin';
  }

  return 'next';
}

function normalizeDecisionLabelText(text) {
  if (!text) {
    return 'decision';
  }

  return String(text)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function safeJsonParse(text) {
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function normalizeObjectStateRef(ref) {
  if (!ref || typeof ref !== 'object') {
    return undefined;
  }

  if (typeof ref.k !== 'string') {
    return undefined;
  }

  const version = Number(ref.v);
  if (!Number.isFinite(version)) {
    return undefined;
  }

  return {
    k: ref.k,
    v: version,
  };
}

function normalizeObjectStateRefs(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => normalizeObjectStateRef(item))
    .filter(Boolean);
}

function normalizeIncomingObjectStateSets(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => ({
    edgeType: item?.edgeType,
    objectKeys: Array.isArray(item?.objectKeys) ? item.objectKeys : [],
    objectStates: normalizeObjectStateRefs(item?.objectStates),
  }));
}

function buildCanonicalStateEffects(stateEffects) {
  return stateEffects.map((effect) => ({
    kind: effect.relType,
    slotKey: effect.slotKey,
    topLevelStateKey: effect.topLevelStateKey,
  }));
}

function buildCanonicalSteps(stepRows, outgoingEdgesByStepId, entryStepIds, stateEffectsByStepId) {
  return stepRows.map((step) => {
    const operationDetail = safeJsonParse(step.operationDetailJson);
    const objectStates = {
      read: normalizeObjectStateRefs(safeJsonParse(step.readObjectStatesJson)),
      tested: normalizeObjectStateRefs(safeJsonParse(step.testedObjectStatesJson)),
      created: normalizeObjectStateRefs(safeJsonParse(step.createdObjectStatesJson)),
      replaced: normalizeObjectStateRefs(safeJsonParse(step.replacedObjectStatesJson)),
      removed: normalizeObjectStateRefs(safeJsonParse(step.removedObjectStatesJson)),
      result: normalizeObjectStateRefs(safeJsonParse(step.resultObjectStatesJson)),
      merged: normalizeObjectStateRefs(safeJsonParse(step.mergedObjectStatesJson)),
      incomingSets: normalizeIncomingObjectStateSets(safeJsonParse(step.incomingObjectStateSetsJson)),
    };

    return {
      stepId: step.stepId,
      isEntry: entryStepIds.includes(step.stepId),
      label: step.stepLabel,
      kinds: step.labels.filter((label) => label !== 'Step'),
      op: {
        index: step.operationIndex,
        code: step.operationCode,
        subjectText: step.operationSubjectText,
        valueText: step.operationValueText,
        calleeText: step.operationCalleeText,
        detail: operationDetail,
        actionText: step.actionText,
        conditionRaw: step.conditionRaw,
      },
      stateEffects: buildCanonicalStateEffects(stateEffectsByStepId.get(step.stepId) || []),
      objectStates,
      successors: (outgoingEdgesByStepId.get(step.stepId) || []).map((edge) => ({
        toStepId: edge.toId,
        edgeType: edge.edgeType,
        edgeLabel: edge.edgeLabel,
        branchTaken: normalizeBranchTaken(edge.edgeType, edge.edgeLabel),
      })),
    };
  });
}

function buildCanonicalFlow(stepRows, outgoingEdgesByStepId, entryStepIds, stateEffectsByStepId) {
  const steps = buildCanonicalSteps(stepRows, outgoingEdgesByStepId, entryStepIds, stateEffectsByStepId);

  return {
    schema: { k: 'function-flow-paths', v: 2 },
    entryStepIds,
    stepCount: steps.length,
    steps,
  };
}

function enumeratePaths(entryStepIds, outgoingEdgesByStepId) {
  const paths = [];

  function walk(stepId, currentPath, transitions, visitedStepIds) {
    if (visitedStepIds.has(stepId)) {
      paths.push({
        pathStepIds: [...currentPath, stepId],
        transitions,
      });
      return;
    }

    const nextPath = [...currentPath, stepId];
    const outgoingEdges = outgoingEdgesByStepId.get(stepId) || [];
    if (!outgoingEdges.length) {
      paths.push({
        pathStepIds: nextPath,
        transitions,
      });
      return;
    }

    const nextVisitedStepIds = new Set(visitedStepIds);
    nextVisitedStepIds.add(stepId);
    for (const outgoingEdge of outgoingEdges) {
      walk(
        outgoingEdge.toId,
        nextPath,
        [
          ...transitions,
          {
            fromId: stepId,
            toId: outgoingEdge.toId,
            edgeType: outgoingEdge.edgeType,
            edgeLabel: outgoingEdge.edgeLabel,
          },
        ],
        nextVisitedStepIds,
      );
    }
  }

  for (const entryStepId of entryStepIds) {
    walk(entryStepId, [], [], new Set());
  }

  return paths;
}

function buildDecisionTrace(transitions, stepsById) {
  return transitions
    .filter((transition) => isDecisionEdgeType(transition.edgeType))
    .map((transition, index) => {
      const branchStep = stepsById.get(transition.fromId);
      const decisionBasis = branchStep?.conditionRaw
        || branchStep?.operationSubjectText
        || branchStep?.stepLabel
        || transition.edgeLabel
        || transition.fromId;

      return {
        decisionIndex: index,
        decisionId: transition.fromId,
        decisionLabel: normalizeDecisionLabelText(`${branchStep?.stepLabel || 'decision'}:${decisionBasis}`),
        branchStepId: transition.fromId,
        targetStepId: transition.toId,
        edgeType: transition.edgeType,
        edgeLabel: transition.edgeLabel,
        branchTaken: normalizeBranchTaken(transition.edgeType, transition.edgeLabel),
      };
    });
}

function buildPathSignature(decisionTrace) {
  if (!decisionTrace.length) {
    return 'linear';
  }

  return decisionTrace
    .map((decision) => `${decision.decisionLabel}=${decision.branchTaken}`)
    .join('|');
}

function buildPathStateMap(operations) {
  return operations.reduce((acc, operation) => {
    for (const effect of operation.stateEffects) {
      const slotKey = effect.slotKey || effect.topLevelStateKey || 'unknown';
      const current = acc[slotKey] || { reads: 0, writes: 0, deletes: 0, clears: 0, lastOperationIndex: undefined };

      if (effect.relType === 'READS_STATE') current.reads += 1;
      if (effect.relType === 'WRITES_STATE') current.writes += 1;
      if (effect.relType === 'DELETES_STATE') current.deletes += 1;
      if (effect.relType === 'CLEARS_STATE') current.clears += 1;

      current.lastOperationIndex = operation.operationIndex;
      acc[slotKey] = current;
    }

    return acc;
  }, {});
}

function buildTransitionMaps(transitions) {
  const incomingTransitionByStepId = new Map();
  const outgoingTransitionsByStepId = new Map();

  for (const transition of transitions) {
    incomingTransitionByStepId.set(transition.toId, transition);
    outgoingTransitionsByStepId.set(
      transition.fromId,
      [...(outgoingTransitionsByStepId.get(transition.fromId) || []), transition],
    );
  }

  return {
    incomingTransitionByStepId,
    outgoingTransitionsByStepId,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const controlEdgeTypes = ['NEXT', 'TRUE', 'FALSE', 'OPTION_CASE', 'OPTION_DEFAULT', 'REJOINS', 'MERGES_TO'];

  const [fnRows, stepRows, entryRows, edgeRows, stateRows] = await Promise.all([
    runReadQuery(driver, database, 'MATCH (fn:Fn {stableId: $fnStableId}) RETURN fn.name AS fnName, fn.stableId AS fnStableId', { fnStableId: args.fnStableId }),
    runReadQuery(
      driver,
      database,
      `
        MATCH (step:Step {source: $source, parentFnStableId: $fnStableId})
        RETURN step.stableId AS stepId,
               labels(step) AS labels,
           step.label AS stepLabel,
               step.operation_index AS operationIndex,
               step.operation_code AS operationCode,
               step.operation_subject_text AS operationSubjectText,
               step.operation_value_text AS operationValueText,
               step.operation_callee_text AS operationCalleeText,
               step.operation_detail_json AS operationDetailJson,
               step.action_text_raw AS actionText,
               step.condition_raw AS conditionRaw,
               step.read_object_states_json AS readObjectStatesJson,
               step.tested_object_states_json AS testedObjectStatesJson,
               step.created_object_states_json AS createdObjectStatesJson,
               step.replaced_object_states_json AS replacedObjectStatesJson,
               step.removed_object_states_json AS removedObjectStatesJson,
               step.result_object_states_json AS resultObjectStatesJson,
               step.merged_object_states_json AS mergedObjectStatesJson,
               step.incoming_object_state_sets_json AS incomingObjectStateSetsJson
        ORDER BY step.operation_index, step.stableId
      `,
      { fnStableId: args.fnStableId, source: FUNCTION_FLOW_SOURCE },
    ),
    runReadQuery(
      driver,
      database,
      `
        MATCH (fn:Fn {stableId: $fnStableId})-[rel:NEXT {source: $source}]->(step:Step {source: $source, parentFnStableId: $fnStableId})
        RETURN step.stableId AS stepId
      `,
      { fnStableId: args.fnStableId, source: FUNCTION_FLOW_SOURCE },
    ),
    runReadQuery(
      driver,
      database,
      `
        MATCH (from:Step {source: $source, parentFnStableId: $fnStableId})-[rel]->(to:Step {source: $source, parentFnStableId: $fnStableId})
        WHERE rel.source = $source AND type(rel) IN $controlEdgeTypes
        RETURN from.stableId AS fromId,
               to.stableId AS toId,
               type(rel) AS edgeType,
               rel.label AS edgeLabel
      `,
      { fnStableId: args.fnStableId, source: FUNCTION_FLOW_SOURCE, controlEdgeTypes },
    ),
    runReadQuery(
      driver,
      database,
      `
        MATCH (step:Step {source: $functionFlowSource, parentFnStableId: $fnStableId})-[rel]->(slot:StateSlot)
        WHERE rel.source = $statefulSource
        RETURN step.stableId AS stepId,
               type(rel) AS relType,
               slot.slotKey AS slotKey,
               slot.topLevelStateKey AS topLevelStateKey
      `,
      { fnStableId: args.fnStableId, functionFlowSource: FUNCTION_FLOW_SOURCE, statefulSource: STATEFUL_SOURCE },
    ),
  ]);

  if (!fnRows.length) {
    throw new Error(`Function ${args.fnStableId} was not found.`);
  }

  const stepsById = new Map(stepRows.map((row) => [row.stepId, row]));
  const outgoingEdgesByStepId = edgeRows.reduce((acc, row) => {
    acc.set(row.fromId, [...(acc.get(row.fromId) || []), row]);
    return acc;
  }, new Map());
  const stateEffectsByStepId = stateRows.reduce((acc, row) => {
    acc.set(row.stepId, [...(acc.get(row.stepId) || []), row]);
    return acc;
  }, new Map());
  const entryStepIds = entryRows.map((row) => row.stepId);
  const canonicalFlow = buildCanonicalFlow(stepRows, outgoingEdgesByStepId, entryStepIds, stateEffectsByStepId);

  const paths = enumeratePaths(entryStepIds, outgoingEdgesByStepId).map(({ pathStepIds, transitions }) => {
    const decisionTrace = buildDecisionTrace(transitions, stepsById);
    const pathSignature = buildPathSignature(decisionTrace);
    const { incomingTransitionByStepId, outgoingTransitionsByStepId } = buildTransitionMaps(transitions);
    const operations = pathStepIds
      .map((stepId) => stepsById.get(stepId))
      .filter(Boolean)
      .map((step) => ({
        stepId: step.stepId,
        stepLabel: step.stepLabel,
        stepKinds: step.labels.filter((label) => label !== 'Step'),
        operationIndex: step.operationIndex,
        operationCode: step.operationCode,
        operationSubjectText: step.operationSubjectText,
        operationValueText: step.operationValueText,
        operationCalleeText: step.operationCalleeText,
        operationDetail: safeJsonParse(step.operationDetailJson),
        actionText: step.actionText,
        conditionRaw: step.conditionRaw,
        incomingTransition: incomingTransitionByStepId.get(step.stepId)
          ? {
            edgeType: incomingTransitionByStepId.get(step.stepId).edgeType,
            edgeLabel: incomingTransitionByStepId.get(step.stepId).edgeLabel,
            fromStepId: incomingTransitionByStepId.get(step.stepId).fromId,
            decisionId: isDecisionEdgeType(incomingTransitionByStepId.get(step.stepId).edgeType)
              ? incomingTransitionByStepId.get(step.stepId).fromId
              : undefined,
            branchTaken: normalizeBranchTaken(
              incomingTransitionByStepId.get(step.stepId).edgeType,
              incomingTransitionByStepId.get(step.stepId).edgeLabel,
            ),
          }
          : undefined,
        outgoingTransitions: (outgoingTransitionsByStepId.get(step.stepId) || []).map((transition) => ({
          edgeType: transition.edgeType,
          edgeLabel: transition.edgeLabel,
          toStepId: transition.toId,
          decisionId: isDecisionEdgeType(transition.edgeType) ? step.stepId : undefined,
          branchTaken: normalizeBranchTaken(transition.edgeType, transition.edgeLabel),
        })),
        stateEffects: buildCanonicalStateEffects(stateEffectsByStepId.get(step.stepId) || []),
        objectStates: {
          read: normalizeObjectStateRefs(safeJsonParse(step.readObjectStatesJson)),
          tested: normalizeObjectStateRefs(safeJsonParse(step.testedObjectStatesJson)),
          created: normalizeObjectStateRefs(safeJsonParse(step.createdObjectStatesJson)),
          replaced: normalizeObjectStateRefs(safeJsonParse(step.replacedObjectStatesJson)),
          removed: normalizeObjectStateRefs(safeJsonParse(step.removedObjectStatesJson)),
          result: normalizeObjectStateRefs(safeJsonParse(step.resultObjectStatesJson)),
          merged: normalizeObjectStateRefs(safeJsonParse(step.mergedObjectStatesJson)),
          incomingSets: normalizeIncomingObjectStateSets(safeJsonParse(step.incomingObjectStateSetsJson)),
        },
      }));

    return {
      pathSignature,
      branchCount: decisionTrace.length,
      pathStepIds,
      decisionTrace,
      operations,
      stateMap: buildPathStateMap(operations),
    };
  });

  console.log(JSON.stringify({
    fn: fnRows[0],
    flowPaths: {
      fnStableId: args.fnStableId,
      pathCount: paths.length,
      paths,
      canonicalFlow,
    },
  }, null, 2));

  await driver.close();
}

main().catch(async (error) => {
  console.error(error);
  await driver.close();
  process.exitCode = 1;
});
