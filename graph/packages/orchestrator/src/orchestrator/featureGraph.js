import { runReadQuery } from '../../../runtime-relay/src/runtimeEvents.js';
import { buildStableIdDescriptorFromRecord, buildStableIdLocation } from '../../../../stableIdModel.js';
import path from 'node:path';
import projectPaths from '../../../../../dev/projectPaths.cjs';

const FUNCTION_FLOW_SOURCE = 'semantic/functionFlowGraph';
const FUNCTION_FLOW_RELATIONSHIP_PATTERN = ':NEXT|TRUE|FALSE|OPTION_CASE|OPTION_DEFAULT|REJOINS|MERGES_TO|CALL|REQUEST|SUBSCRIBE|CALLBACK|EXPECT_UPDATE|APPLY_UPDATE|PRODUCE|RETURN|READ|TEST|CREATE|UPDATE|DELETE|CLEAR|EMIT|WAIT|SIGNAL|START|CANCEL|DERIVE|FEED|PART';
const LOCAL_CONTROL_FLOW_RELATIONSHIP_PATTERN = ':NEXT|TRUE|FALSE|OPTION_CASE|OPTION_DEFAULT|REJOINS|MERGES_TO';
const FEATURE_BACKBONE_DEPTH_STEPS = [20, 60, 120, 200];
const FEATURE_SIDE_BRANCH_DEPTH_STEPS = [4, 8, 12, 20, 40];

export function normalizeGraphNode(node) {
  const stable = buildStableIdDescriptorFromRecord(node.properties || {});
  const stableId = stable?.value || node.properties.stableId;
  const labels = [...(node.labels || [])];
  const isFunction = labels.includes('Fn');
  const isExternal = labels.includes('External');
  const kind = labels[0] || 'Node';
  const common = {
    kind,
    stableId,
    stable,
    labels,
    label: node.properties.label,
    repoRelativePath: node.properties.repo_relative_path,
    loggingUsefulKinds: node.properties.logging_useful_kinds,
    loggingUsefulReasons: node.properties.logging_useful_reasons,
    runtimeLoggable: Boolean(node.properties.runtime_loggable),
    runtimeLoggableKinds: node.properties.runtime_loggable_kinds,
    location: buildStableIdLocation(node.properties || {}),
    isFunction,
    isExternal,
  };

  if (isFunction) {
    return {
      ...common,
      name: node.properties.name || '<anonymous>',
    };
  }

  return {
    ...common,
    name: node.properties.name || node.properties.label || stableId || '<node>',
    parentFnStableId: node.properties.parentFnStableId,
    operationCode: node.properties.operation_code,
    operationSubjectText: node.properties.operation_subject_text,
    operationValueText: node.properties.operation_value_text,
    operationCalleeText: node.properties.operation_callee_text,
    operationDetailJson: node.properties.operation_detail_json,
    actionText: node.properties.action_text_raw,
    conditionRaw: node.properties.condition_raw,
    createdObjectType: node.properties.created_object_type,
    createdObjectSource: node.properties.created_object_source,
    flowArtifactRoles: node.properties.flow_artifact_roles || [],
    flowArtifactEvidence: node.properties.flow_artifact_evidence || [],
    flowArtifactReadKeys: node.properties.flow_artifact_read_keys || [],
    flowArtifactWriteKeys: node.properties.flow_artifact_write_keys || [],
  };
}

function normalizeTailType(tailType) {
  const normalized = String(tailType || '').trim().replace(/^:/, '');
  return normalized || undefined;
}

function describeTailSelector({ tailStableId, tailType } = {}) {
  const normalizedTailType = normalizeTailType(tailType);
  return tailStableId || (normalizedTailType ? `:${normalizedTailType}` : 'tail');
}

export function normalizeGraphRelationship(rel) {
  return {
    type: rel.type,
    role: functionFlowRoleFromType(rel.type, rel.properties.role),
    label: rel.properties.label,
    callTextRaw: rel.properties.call_text_raw,
  };
}

function functionFlowRoleFromType(type, legacyRole) {
  if (legacyRole) return legacyRole;
  if (type === 'CALL' || type === 'REQUEST') return 'call';
  if (type === 'SUBSCRIBE') return 'subscribe';
  if (['CALLBACK', 'EXPECT_UPDATE', 'APPLY_UPDATE', 'PRODUCE', 'RETURN'].includes(type)) return 'semantic';
  if (['READ', 'TEST', 'CREATE', 'UPDATE', 'DELETE', 'CLEAR', 'EMIT', 'WAIT', 'SIGNAL', 'START', 'CANCEL', 'DERIVE', 'FEED', 'PART'].includes(type)) return 'resource';
  return 'control';
}

// Returns the shortest directed function-flow path between two graph nodes.
async function queryShortestPath(driver, database, startFnStableId, endStableId, { maxDepth } = {}) {
  if (!startFnStableId || !endStableId) {
    return undefined;
  }

  const relationshipPattern = maxDepth
    ? `[${FUNCTION_FLOW_RELATIONSHIP_PATTERN}*..${maxDepth}]`
    : `[${FUNCTION_FLOW_RELATIONSHIP_PATTERN}*]`;
  const records = await runReadQuery(
    driver,
    database,
    `
      MATCH (start {stableId: $startFnStableId}), (finish {stableId: $endStableId})
      MATCH path = shortestPath((start)-${relationshipPattern}->(finish))
      WHERE all(rel IN relationships(path) WHERE rel.source = $source)
      RETURN nodes(path) AS nodes, relationships(path) AS rels
      LIMIT 1
    `,
    { startFnStableId, endStableId, source: FUNCTION_FLOW_SOURCE },
  );

  if (records[0]) {
    return {
      nodes: records[0].nodes.map((node) => normalizeGraphNode(node)),
      rels: records[0].rels.map((rel) => normalizeGraphRelationship(rel)),
    };
  }

  return undefined;
}

// Returns a feature backbone path inside the head function, ending at the
// concrete call-site that invokes the requested tail function.
async function queryFeatureBackbonePath(driver, database, startFnStableId, endFnStableId, { maxDepth } = {}) {
  if (!startFnStableId || !endFnStableId) {
    return undefined;
  }

  const relationshipPattern = maxDepth
    ? `[${LOCAL_CONTROL_FLOW_RELATIONSHIP_PATTERN}*..${maxDepth}]`
    : `[${LOCAL_CONTROL_FLOW_RELATIONSHIP_PATTERN}*]`;
  const records = await runReadQuery(
    driver,
    database,
    `
      MATCH (start:Fn {stableId: $startFnStableId})
      MATCH (finish:Fn {stableId: $endFnStableId})
      MATCH (callSite:Step {parentFnStableId: $startFnStableId})-[callRel]->(finish)
      WHERE callRel.source = $source
      MATCH path = shortestPath((start)-${relationshipPattern}->(callSite))
      WHERE all(rel IN relationships(path) WHERE rel.source = $source)
        AND all(node IN nodes(path)[1..] WHERE node:Step AND node.parentFnStableId = $startFnStableId)
      RETURN nodes(path) AS pathNodes, relationships(path) AS pathRels, callRel, finish
      ORDER BY length(path), callSite.start_line, callSite.start_column
      LIMIT 1
    `,
    { startFnStableId, endFnStableId, source: FUNCTION_FLOW_SOURCE },
  );

  if (!records[0]) {
    return undefined;
  }

  return {
    nodes: [
      ...records[0].pathNodes.map((node) => normalizeGraphNode(node)),
      normalizeGraphNode(records[0].finish),
    ],
    rels: [
      ...records[0].pathRels.map((rel) => normalizeGraphRelationship(rel)),
      normalizeGraphRelationship(records[0].callRel),
    ],
  };
}

async function resolveTailTargets(driver, database, { tailStableId, tailType } = {}) {
  const normalizedTailType = normalizeTailType(tailType);
  if (tailStableId) {
    return [tailStableId];
  }

  if (!normalizedTailType) {
    return [];
  }

  const records = await runReadQuery(
    driver,
    database,
    `
      MATCH (finish)
      WHERE $normalizedTailType IN labels(finish)
      RETURN DISTINCT finish.stableId AS stableId
      ORDER BY finish.stableId
    `,
    { normalizedTailType },
  );

  return records
    .map((record) => record.stableId)
    .filter(Boolean);
}

export async function queryFeaturePairPath(driver, database, featureStableId, endFnStableId) {
  if (!featureStableId || !endFnStableId) {
    return [];
  }

  for (const maxDepth of FEATURE_BACKBONE_DEPTH_STEPS) {
    const pathResult = await queryFeatureBackbonePath(driver, database, featureStableId, endFnStableId, { maxDepth });
    if (!pathResult) {
      continue;
    }

    return [{
      ...pathResult,
      endFnStableId,
      maxDepth,
    }];
  }

  return [];
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

function getDeclaredFeatureTailStableIds(feature) {
  return [...new Set((feature?.endFnStableIds || []).filter(Boolean))];
}

function parseCoordinateStableId(stableId) {
  const match = String(stableId || '').match(/^(.+):(\d+):(\d+):(\d+):(\d+)(?::.*)?$/);
  if (!match) {
    return undefined;
  }

  return {
    repoRelativePath: (path.isAbsolute(match[1]) ? path.relative(projectPaths.sourceRoot, match[1]) : match[1]).replace(/\\/g, '/'),
    startLine: Number(match[2]),
    startColumn: Number(match[3]),
    endLine: Number(match[4]),
    endColumn: Number(match[5]),
  };
}

async function resolveGraphStableId(driver, database, stableId, { label = 'Fn' } = {}) {
  if (!stableId) {
    return stableId;
  }

  const exactRecords = await runReadQuery(
    driver,
    database,
    `
      MATCH (node:${label} {stableId: $stableId})
      RETURN node.stableId AS stableId
      LIMIT 1
    `,
    { stableId },
  );
  if (exactRecords[0]?.stableId) {
    return exactRecords[0].stableId;
  }

  const location = parseCoordinateStableId(stableId);
  if (!location?.repoRelativePath) {
    return stableId;
  }

  const locationRecords = await runReadQuery(
    driver,
    database,
    `
      MATCH (node:${label})
      WHERE node.repo_relative_path = $repoRelativePath
        AND node.start_line = $startLine
        AND node.start_column = $startColumn
        AND node.end_line = $endLine
        AND node.end_column = $endColumn
      RETURN node.stableId AS stableId
      LIMIT 1
    `,
    location,
  );

  return locationRecords[0]?.stableId || stableId;
}

async function resolveGraphStableIds(driver, database, stableIds, options = {}) {
  const resolved = [];
  for (const stableId of stableIds || []) {
    resolved.push(await resolveGraphStableId(driver, database, stableId, options));
  }
  return resolved;
}

function buildStableIdCandidates(...stableIds) {
  return [...new Set(
    stableIds
      .flat()
      .filter(Boolean)
      .map((stableId) => String(stableId).trim())
      .filter(Boolean),
  )];
}

function collectFeatureFnStableIds(paths) {
  return [...new Set(
    (paths || []).flatMap((pathItem) => (pathItem.nodes || []))
      .filter((node) => node?.isFunction && node?.stableId)
      .map((node) => node.stableId),
  )];
}

async function queryArtifactBackboneEntrypoints(
  driver,
  database,
  headStableId,
  tailStableIds,
  { headStableIdCandidates = [headStableId] } = {},
) {
  if (!headStableId || !tailStableIds?.length) {
    return [];
  }

  const parentFnStableIds = buildStableIdCandidates(headStableIdCandidates, headStableId);

  const records = await runReadQuery(
    driver,
    database,
    `
      UNWIND range(0, size($tailStableIds) - 1) AS tailIndex
      WITH tailIndex, $tailStableIds[tailIndex] AS tailStableId
      MATCH (head:Fn {stableId: $headStableId})
      MATCH (tail:Fn {stableId: tailStableId})
      MATCH (callSite:Step)-[callRel]->(tail)
      WHERE callRel.source = $source
        AND type(callRel) IN ['CALL', 'REQUEST']
        AND callSite.parentFnStableId IN $parentFnStableIds
      OPTIONAL MATCH (artifactSource:Step:FlowArtifact)
      WHERE 'append-artifact' IN coalesce(artifactSource.flow_artifact_roles, [])
        AND artifactSource.parentFnStableId IN $parentFnStableIds
        AND coalesce(artifactSource.operation_index, -1) < coalesce(callSite.operation_index, 2147483647)
        AND any(
          key IN coalesce(artifactSource.flow_artifact_write_keys, [])
          WHERE key IN coalesce(callSite.flow_artifact_read_keys, [])
        )
      WITH head, tailIndex, tailStableId, tail, callSite, callRel, artifactSource
      ORDER BY tailIndex, callSite.operation_index, artifactSource.operation_index DESC
      WITH head, tailIndex, tailStableId, tail, callSite, callRel, collect(artifactSource)[0] AS artifactSource
      WHERE artifactSource IS NOT NULL
      RETURN head, tailIndex, tailStableId, tail, callSite, callRel, artifactSource
      ORDER BY tailIndex, callSite.operation_index
    `,
    { headStableId, tailStableIds, parentFnStableIds, source: FUNCTION_FLOW_SOURCE },
  );

  const seenTailStableIds = new Set();
  const entrypoints = [];
  for (const record of records) {
    if (!record.tailStableId || seenTailStableIds.has(record.tailStableId)) {
      continue;
    }

    seenTailStableIds.add(record.tailStableId);
    entrypoints.push({
      tailIndex: record.tailIndex,
      tailStableId: record.tailStableId,
      head: normalizeGraphNode(record.head),
      tail: normalizeGraphNode(record.tail),
      callSite: normalizeGraphNode(record.callSite),
      callRel: normalizeGraphRelationship(record.callRel),
      artifactSource: normalizeGraphNode(record.artifactSource),
    });
  }

  return entrypoints;
}

function buildSyntheticFeatureRelationship(type, role, label) {
  return { type, role, label, callTextRaw: undefined };
}

function buildSyntheticExternalNode({ stableId, name, label, repoRelativePath }) {
  return {
    kind: 'External',
    stableId,
    stable: { value: stableId, repoRelativePath },
    labels: ['Fn', 'External'],
    label: label || name,
    repoRelativePath,
    location: buildStableIdLocation({ stableId: stableId, repo_relative_path: repoRelativePath }),
    isFunction: true,
    isExternal: true,
    name,
    runtimeLoggable: false,
    runtimeLoggableKinds: [],
    loggingUsefulKinds: [],
    loggingUsefulReasons: [],
  };
}

async function queryFunctionFlowShortestPath(driver, database, startStableId, endStableId, { maxDepth } = {}) {
  if (!startStableId || !endStableId) {
    return undefined;
  }

  const depth = maxDepth || 80;
  const records = await runReadQuery(
    driver,
    database,
    `
      MATCH (start {stableId: $startStableId})
      MATCH (finish {stableId: $endStableId})
      MATCH path = shortestPath((start)-[${FUNCTION_FLOW_RELATIONSHIP_PATTERN}*..${depth}]->(finish))
      WHERE all(rel IN relationships(path) WHERE rel.source = $source)
      RETURN nodes(path) AS nodes, relationships(path) AS rels
      LIMIT 1
    `,
    { startStableId, endStableId, source: FUNCTION_FLOW_SOURCE },
  );

  if (!records[0]) {
    return undefined;
  }

  return {
    nodes: records[0].nodes.map((node) => normalizeGraphNode(node)),
    rels: records[0].rels.map((rel) => normalizeGraphRelationship(rel)),
  };
}

async function queryNearestExternalPathFromFn(driver, database, startStableId, { stableIdPrefix, maxDepth = 40 } = {}) {
  if (!startStableId) {
    return undefined;
  }

  const records = await runReadQuery(
    driver,
    database,
    `
      MATCH (start:Fn {stableId: $startStableId})
      MATCH (finish:External)
      WHERE $stableIdPrefix IS NULL OR finish.stableId STARTS WITH $stableIdPrefix
      MATCH path = shortestPath((start)-[${FUNCTION_FLOW_RELATIONSHIP_PATTERN}*..${maxDepth}]->(finish))
      WHERE all(rel IN relationships(path) WHERE rel.source = $source)
      RETURN nodes(path) AS nodes, relationships(path) AS rels
      ORDER BY length(path), finish.stableId
      LIMIT 1
    `,
    { startStableId, stableIdPrefix: stableIdPrefix || null, source: FUNCTION_FLOW_SOURCE },
  );

  if (!records[0]) {
    return undefined;
  }

  const normalizedNodes = records[0].nodes.map((node) => normalizeGraphNode(node));
  const startNode = normalizedNodes[0];
  const externalNode = normalizedNodes.at(-1);
  if (!startNode?.stableId || !externalNode?.stableId) {
    return undefined;
  }

  return {
    nodes: [startNode, externalNode],
    rels: [buildSyntheticFeatureRelationship('EXTERNAL_BOUNDARY', 'external', externalNode.name || externalNode.label)],
    pathKind: 'context-external',
  };
}

async function queryDirectContextCallBranches(driver, database, parentStableIds) {
  const uniqueParentStableIds = [...new Set((parentStableIds || []).filter(Boolean))];
  if (!uniqueParentStableIds.length) {
    return [];
  }

  const records = await runReadQuery(
    driver,
    database,
    `
      MATCH (parent:Fn)
      WHERE parent.stableId IN $parentStableIds
      MATCH (step:Step {parentFnStableId: parent.stableId})-[callRel]->(callee:Fn)
      WHERE callRel.source = $source
        AND type(callRel) IN ['CALL', 'REQUEST']
      RETURN parent, step, callRel, callee
      ORDER BY parent.stableId, step.operation_index, step.start_line, step.start_column
    `,
    {
      parentStableIds: uniqueParentStableIds,
      source: FUNCTION_FLOW_SOURCE,
    },
  );

  return records.map((record) => ({
    nodes: [
      normalizeGraphNode(record.parent),
      normalizeGraphNode(record.callee),
    ],
    rels: [normalizeGraphRelationship(record.callRel)],
    endFnStableId: record.callee.properties?.stableId,
    pathKind: 'context-call',
    callSiteStableId: record.step.properties?.stableId,
  }));
}

async function queryDynamicToolExternalBranches(driver, database, parentStableIds) {
  const uniqueParentStableIds = [...new Set((parentStableIds || []).filter(Boolean))];
  if (!uniqueParentStableIds.length) {
    return [];
  }

  const records = await runReadQuery(
    driver,
    database,
    `
      MATCH (parent:Fn)
      WHERE parent.stableId IN $parentStableIds
      MATCH (step:Step {parentFnStableId: parent.stableId})
      WHERE toLower(coalesce(step.operation_callee_text, '')) = 'tool.call'
      OPTIONAL MATCH (step)-[callRel]->(external:External {stableId: 'external:dynamic-tool:tool.call'})
      WHERE callRel.source = $source
        AND type(callRel) = 'CALL'
      RETURN parent, step, callRel, external
      ORDER BY step.operation_index, step.start_line
    `,
    { parentStableIds: uniqueParentStableIds, source: FUNCTION_FLOW_SOURCE },
  );

  return records.map((record) => ({
    nodes: [
      normalizeGraphNode(record.parent),
      record.external
        ? normalizeGraphNode(record.external)
        : buildSyntheticExternalNode({
          stableId: 'external:dynamic-tool:tool.call',
          name: 'selected tool boundary',
          label: 'tool.call',
          repoRelativePath: 'external/dynamic-tool',
        }),
    ],
    rels: [
      record.callRel
        ? normalizeGraphRelationship(record.callRel)
        : buildSyntheticFeatureRelationship('EXTERNAL_TOOL_CALL', 'external', 'tool.call'),
    ],
    endFnStableId: 'external:dynamic-tool:tool.call',
    pathKind: 'context-external',
    callSiteStableId: record.step.properties?.stableId,
  }));
}

function appendPathSegment(basePath, segment) {
  if (!segment?.nodes?.length) {
    return basePath;
  }

  const nodes = [...(basePath?.nodes || [])];
  const rels = [...(basePath?.rels || [])];
  const segmentNodes = segment.nodes || [];
  const duplicateStart = nodes.length
    && segmentNodes[0]?.stableId
    && nodes.at(-1)?.stableId === segmentNodes[0].stableId;

  nodes.push(...(duplicateStart ? segmentNodes.slice(1) : segmentNodes));
  rels.push(...(segment.rels || []));

  return { nodes, rels };
}

function buildFeatureContextSideItems(paths) {
  const groupedByHead = new Map();
  for (const pathItem of paths || []) {
    const headStableId = pathItem?.nodes?.[0]?.stableId;
    if (!headStableId) {
      continue;
    }

    if (!groupedByHead.has(headStableId)) {
      groupedByHead.set(headStableId, []);
    }
    groupedByHead.get(headStableId).push(pathItem);
  }

  return [...groupedByHead.entries()].map(([headStableId, groupedPaths]) => {
    const pathsForHead = dedupeFeaturePaths(groupedPaths);
    const resolvedTailStableIds = [...new Set(
      pathsForHead
        .map((pathItem) => pathItem?.nodes?.at(-1)?.stableId)
        .filter(Boolean),
    )];

    return {
      available: Boolean(pathsForHead.length),
      error: null,
      headStableId,
      tailStableId: null,
      tailType: 'Context',
      resolvedTailStableIds,
      pathCount: pathsForHead.length,
      backboneFnStableIds: collectFeatureFnStableIds(pathsForHead),
      paths: pathsForHead,
      payload: JSON.stringify({
        headStableId,
        tailStableId: null,
        tailType: 'Context',
        resolvedTailStableIds,
        pathCount: pathsForHead.length,
        backboneFnStableIds: collectFeatureFnStableIds(pathsForHead),
        paths: pathsForHead,
      }),
    };
  });
}

async function loadFeatureContextSideItems(driver, database, backboneFnStableIds) {
  const directContextPaths = await queryDirectContextCallBranches(driver, database, backboneFnStableIds);
  const directContextFnStableIds = collectFeatureFnStableIds(directContextPaths);
  let frontierFnStableIds = directContextFnStableIds;
  const expandedContextPaths = [];
  const seenExpansionHeadIds = new Set(backboneFnStableIds);

  for (let depth = 0; depth < 2; depth += 1) {
    const nextHeadIds = frontierFnStableIds.filter((stableId) => !seenExpansionHeadIds.has(stableId));
    nextHeadIds.forEach((stableId) => seenExpansionHeadIds.add(stableId));
    if (!nextHeadIds.length) {
      break;
    }

    const nextPaths = await queryDirectContextCallBranches(driver, database, nextHeadIds);
    expandedContextPaths.push(...nextPaths);
    frontierFnStableIds = collectFeatureFnStableIds(nextPaths);
  }

  const expandedContextFnStableIds = collectFeatureFnStableIds(expandedContextPaths);
  const allContextFnStableIds = [...new Set([
    ...backboneFnStableIds,
    ...directContextFnStableIds,
    ...expandedContextFnStableIds,
  ])];

  const llmEntrypoint = [...directContextPaths, ...expandedContextPaths]
    .flatMap((pathItem) => pathItem.nodes || [])
    .find((node) => node?.isFunction && node?.name === 'queryModelWithStreaming');
  const llmExternalPath = llmEntrypoint
    ? await queryNearestExternalPathFromFn(driver, database, llmEntrypoint.stableId, {
      stableIdPrefix: 'external:llm:',
      maxDepth: 40,
    })
    : undefined;
  const dynamicToolExternalPaths = await queryDynamicToolExternalBranches(driver, database, allContextFnStableIds);

  const paths = dedupeFeaturePaths([
    ...directContextPaths,
    ...expandedContextPaths,
    ...(llmExternalPath ? [llmExternalPath] : []),
    ...dynamicToolExternalPaths,
  ]);

  return buildFeatureContextSideItems(paths);
}

async function loadArtifactFeaturePathsData(driver, database, feature) {
  const declaredHeadStableId = feature?.stableId;
  const declaredTailStableIds = getDeclaredFeatureTailStableIds(feature);
  const headStableId = await resolveGraphStableId(driver, database, declaredHeadStableId, { label: 'Fn' });
  const tailStableIds = await resolveGraphStableIds(driver, database, declaredTailStableIds, { label: 'Fn' });

  if (!headStableId || !tailStableIds.length) {
    return undefined;
  }

  const entrypoints = await queryArtifactBackboneEntrypoints(driver, database, headStableId, tailStableIds, {
    headStableIdCandidates: [declaredHeadStableId, headStableId],
  });
  if (!entrypoints.length) {
    return undefined;
  }

  const entrypoint = entrypoints[0];
  let backbonePath = {
    nodes: [
      entrypoint.head,
      entrypoint.artifactSource,
      entrypoint.callSite,
      entrypoint.tail,
    ],
    rels: [
      buildSyntheticFeatureRelationship('FEATURE_LOCAL_ORDER', 'local-order', 'before'),
      buildSyntheticFeatureRelationship('FEATURE_ARTIFACT_FLOW', 'artifact-flow', 'artifact continuity'),
      entrypoint.callRel,
    ],
    endFnStableId: entrypoint.tailStableId,
    pathKind: 'artifact-backbone',
    artifactSourceStableId: entrypoint.artifactSource.stableId,
    artifactCallSiteStableId: entrypoint.callSite.stableId,
    artifactEntrypointStableId: entrypoint.tailStableId,
  };
  let endFnStableId = entrypoint.tailStableId;

  const downstreamTailStableIds = tailStableIds.slice((entrypoint.tailIndex || 0) + 1);
  for (const downstreamTailStableId of downstreamTailStableIds) {
    const downstreamPath = await queryFunctionFlowShortestPath(
      driver,
      database,
      endFnStableId,
      downstreamTailStableId,
      { maxDepth: 80 },
    );
    if (!downstreamPath) {
      continue;
    }

    backbonePath = {
      ...backbonePath,
      ...appendPathSegment(backbonePath, downstreamPath),
      endFnStableId: downstreamTailStableId,
    };
    endFnStableId = downstreamTailStableId;
    break;
  }

  const paths = dedupeFeaturePaths([{ ...backbonePath, endFnStableId }]);
  const backboneFnStableIds = collectFeatureFnStableIds(paths);
  const sideItems = await loadFeatureContextSideItems(driver, database, backboneFnStableIds);
  const availableSideItems = sideItems.filter((sideItem) => sideItem.available);
  const sideTotalPathCount = availableSideItems.reduce((sum, sideItem) => sum + (sideItem.pathCount || 0), 0);

  const item = {
    available: true,
    error: null,
    headStableId,
    tailStableId: endFnStableId,
    tailType: null,
    resolvedTailStableIds: [endFnStableId],
    pathCount: paths.length,
    backboneFnStableIds,
    paths,
    artifactEntrypoints: entrypoints,
    payload: JSON.stringify({
      headStableId,
      tailStableId: endFnStableId,
      tailType: null,
      resolvedTailStableIds: [endFnStableId],
      pathCount: paths.length,
      backboneFnStableIds,
      paths,
      artifactEntrypoints: entrypoints,
    }),
  };

  return {
    available: true,
    error: null,
    feature: feature || null,
    headStableId,
    pairCount: tailStableIds.length,
    availablePairCount: paths.length,
    totalPathCount: paths.length,
    backboneFnStableIds,
    backbonePairCount: tailStableIds.length,
    backboneAvailablePairCount: paths.length,
    backboneTotalPathCount: paths.length,
    sidePairCount: backboneFnStableIds.length,
    sideAvailablePairCount: availableSideItems.length,
    sideTotalPathCount,
    pathSelectionMode: 'artifact-continuity',
    items: [item],
    sideItems,
    payload: JSON.stringify({
      headStableId,
      pairCount: tailStableIds.length,
      availablePairCount: paths.length,
      totalPathCount: paths.length,
      backboneFnStableIds,
      backbonePairCount: tailStableIds.length,
      backboneAvailablePairCount: paths.length,
      backboneTotalPathCount: paths.length,
      sidePairCount: backboneFnStableIds.length,
      sideAvailablePairCount: availableSideItems.length,
      sideTotalPathCount,
      pathSelectionMode: 'artifact-continuity',
      items: [item],
      sideItems,
    }),
  };
}

export async function loadPathData(driver, database, { headStableId, tailStableId, tailType } = {}) {
  const normalizedTailType = normalizeTailType(tailType);
  const tailSelector = describeTailSelector({ tailStableId, tailType: normalizedTailType });

  if (!headStableId || (!tailStableId && !normalizedTailType)) {
    return {
      available: false,
      error: 'Feature head and tail must resolve before path data can be collected.',
      headStableId: headStableId || null,
      tailStableId: tailStableId || null,
      tailType: normalizedTailType || null,
      resolvedTailStableIds: [],
      pathCount: 0,
      backboneFnStableIds: [],
      paths: [],
      payload: null,
    };
  }

  const resolvedTailStableIds = await resolveTailTargets(driver, database, { tailStableId, tailType: normalizedTailType });
  if (!resolvedTailStableIds.length) {
    return {
      available: false,
      error: `No graph nodes matched tail selector ${tailSelector}.`,
      headStableId,
      tailStableId: tailStableId || null,
      tailType: normalizedTailType || null,
      resolvedTailStableIds: [],
      pathCount: 0,
      backboneFnStableIds: [],
      paths: [],
      payload: null,
    };
  }

  const pathResults = await Promise.all(resolvedTailStableIds.map((resolvedTailStableId) => {
    return queryFeaturePairPath(driver, database, headStableId, resolvedTailStableId);
  }));
  const paths = dedupeFeaturePaths(pathResults.flat());
  if (!paths.length) {
    return {
      available: false,
      error: `No directed function-flow paths were found from ${headStableId} to ${tailSelector}.`,
      headStableId,
      tailStableId: tailStableId || null,
      tailType: normalizedTailType || null,
      resolvedTailStableIds,
      pathCount: 0,
      backboneFnStableIds: [],
      paths: [],
      payload: null,
    };
  }

  const backboneFnStableIds = collectFeatureFnStableIds(paths);

  return {
    available: true,
    error: null,
    headStableId,
    tailStableId: tailStableId || null,
    tailType: normalizedTailType || null,
    resolvedTailStableIds,
    pathCount: paths.length,
    backboneFnStableIds,
    paths,
    payload: JSON.stringify({
      headStableId,
      tailStableId,
      tailType: normalizedTailType || null,
      resolvedTailStableIds,
      pathCount: paths.length,
      backboneFnStableIds,
      paths,
    }),
  };
}

export async function loadFeaturePathsData(driver, database, feature) {
  const declaredHeadStableId = feature?.stableId;
  const artifactPathsData = await loadArtifactFeaturePathsData(driver, database, feature);
  if (artifactPathsData) {
    return artifactPathsData;
  }

  const headStableId = await resolveGraphStableId(driver, database, declaredHeadStableId, { label: 'Fn' });
  const tailStableIds = await resolveGraphStableIds(
    driver,
    database,
    getDeclaredFeatureTailStableIds(feature),
    { label: 'Fn' },
  );

  if (!headStableId || !tailStableIds.length) {
    return {
      available: false,
      error: 'Feature head and tails must resolve before path data can be collected.',
      feature: feature || null,
      headStableId: headStableId || null,
      pairCount: tailStableIds.length,
      availablePairCount: 0,
      totalPathCount: 0,
      backboneFnStableIds: [],
      backbonePairCount: tailStableIds.length,
      backboneAvailablePairCount: 0,
      backboneTotalPathCount: 0,
      sidePairCount: 0,
      sideAvailablePairCount: 0,
      sideTotalPathCount: 0,
      items: [],
      sideItems: [],
      payload: null,
    };
  }

  const items = await Promise.all(tailStableIds.map((tailStableId) => loadPathData(driver, database, {
    headStableId,
    tailStableId,
  })));
  const availableItems = items.filter((item) => item.available);
  const backboneFnStableIds = [...new Set(availableItems.flatMap((item) => item.backboneFnStableIds || []))];
  const sidePaths = await queryFeatureSideBranches(driver, database, backboneFnStableIds, { tailType: 'External' });
  const sideItems = buildFeatureSideBranchItems(backboneFnStableIds, sidePaths);
  const availableSideItems = sideItems.filter((item) => item.available);
  const backboneTotalPathCount = availableItems.reduce((sum, item) => sum + (item.pathCount || 0), 0);
  const sideTotalPathCount = availableSideItems.reduce((sum, item) => sum + (item.pathCount || 0), 0);

  return {
    available: Boolean(availableItems.length || availableSideItems.length),
    error: (availableItems.length || availableSideItems.length)
      ? null
      : `No directed function-flow paths were found for feature ${feature?.key || headStableId}.`,
    feature: feature || null,
    headStableId,
    pairCount: tailStableIds.length,
    availablePairCount: availableItems.length,
    totalPathCount: backboneTotalPathCount + sideTotalPathCount,
    backboneFnStableIds,
    backbonePairCount: tailStableIds.length,
    backboneAvailablePairCount: availableItems.length,
    backboneTotalPathCount,
    sidePairCount: backboneFnStableIds.length,
    sideAvailablePairCount: availableSideItems.length,
    sideTotalPathCount,
    items,
    sideItems,
    payload: JSON.stringify({
      headStableId,
      pairCount: tailStableIds.length,
      availablePairCount: availableItems.length,
      totalPathCount: backboneTotalPathCount + sideTotalPathCount,
      backboneFnStableIds,
      backbonePairCount: tailStableIds.length,
      backboneAvailablePairCount: availableItems.length,
      backboneTotalPathCount,
      sidePairCount: backboneFnStableIds.length,
      sideAvailablePairCount: availableSideItems.length,
      sideTotalPathCount,
      items,
      sideItems,
    }),
  };
}

export async function loadFeaturePathGraphData(driver, database, feature) {
  const pathGraph = await loadFeaturePathsData(driver, database, feature);
  const allPaths = [
    ...(pathGraph.items || []).flatMap((item) => item?.paths || []),
    ...(pathGraph.sideItems || []).flatMap((item) => item?.paths || []),
  ];
  const fnNodes = extractNormalizedFeatureFunctionNodes(allPaths);

  return {
    ...pathGraph,
    fnNodeCount: fnNodes.length,
    fnNodes,
  };
}

async function loadDeclaredFeatureBackbonePaths(driver, database, feature) {
  const headStableId = feature?.stableId;
  const tailStableIds = [...new Set((feature?.endFnStableIds || []).filter(Boolean))];

  if (!headStableId || !tailStableIds.length) {
    return [];
  }

  const items = await Promise.all(tailStableIds.map((tailStableId) => loadPathData(driver, database, {
    headStableId,
    tailStableId,
  })));

  return dedupeFeaturePaths(items.flatMap((item) => (item.available ? item.paths || [] : [])));
}

function buildFeatureSideBranchItems(backboneFnStableIds, paths) {
  const groupedByHead = new Map();
  for (const pathItem of paths || []) {
    const headStableId = pathItem?.nodes?.[0]?.stableId;
    if (!headStableId) {
      continue;
    }

    if (!groupedByHead.has(headStableId)) {
      groupedByHead.set(headStableId, []);
    }
    groupedByHead.get(headStableId).push(pathItem);
  }

  return [...new Set((backboneFnStableIds || []).filter(Boolean))].map((backboneHeadStableId) => {
    const groupedPaths = dedupeFeaturePaths(groupedByHead.get(backboneHeadStableId) || []);
    const resolvedTailStableIds = [...new Set(
      groupedPaths
        .map((pathItem) => pathItem?.nodes?.at(-1))
        .filter((node) => node?.isExternal && node?.stableId)
        .map((node) => node.stableId),
    )];

    return {
      available: Boolean(groupedPaths.length),
      error: groupedPaths.length
        ? null
        : `No directed function-flow side branches were found from ${backboneHeadStableId} to :External.`,
      headStableId: backboneHeadStableId,
      tailStableId: null,
      tailType: 'External',
      resolvedTailStableIds,
      pathCount: groupedPaths.length,
      backboneFnStableIds: collectFeatureFnStableIds(groupedPaths),
      paths: groupedPaths,
      payload: groupedPaths.length
        ? JSON.stringify({
          headStableId: backboneHeadStableId,
          tailStableId: null,
          tailType: 'External',
          resolvedTailStableIds,
          pathCount: groupedPaths.length,
          backboneFnStableIds: collectFeatureFnStableIds(groupedPaths),
          paths: groupedPaths,
        })
        : null,
    };
  });
}

// Finds shortest paths from each backbone Fn to every reachable external boundary node.
// External semantics are provided by graph labels, not by product-specific hardcoding.
export async function queryFeatureSideBranches(driver, database, backboneStableIds, { tailStableIds, tailType } = {}) {
  const uniqueBackboneStableIds = [...new Set((backboneStableIds || []).filter(Boolean))];
  if (!uniqueBackboneStableIds.length) {
    return [];
  }

  const explicitTailStableIds = [...new Set((tailStableIds || []).filter(Boolean))];
  const resolvedTailStableIds = explicitTailStableIds.length
    ? explicitTailStableIds
    : await resolveTailTargets(driver, database, { tailType });
  if (!resolvedTailStableIds.length) {
    return [];
  }

  const uniquePaths = [];
  const seenPathKeys = new Set();

  for (const backboneStableId of uniqueBackboneStableIds) {
    let pendingTailStableIds = [...resolvedTailStableIds];

    for (const maxDepth of FEATURE_SIDE_BRANCH_DEPTH_STEPS) {
      if (!pendingTailStableIds.length) {
        break;
      }

      const records = await runReadQuery(
        driver,
        database,
        `
          MATCH (backbone {stableId: $backboneStableId})
          UNWIND $pendingTailStableIds AS tailStableId
          MATCH (tail {stableId: tailStableId})
          MATCH path = shortestPath((backbone)-[${FUNCTION_FLOW_RELATIONSHIP_PATTERN}*..${maxDepth}]->(tail))
          WHERE all(rel IN relationships(path) WHERE rel.source = $source)
          RETURN tailStableId, nodes(path) AS nodes, relationships(path) AS rels
        `,
        { backboneStableId, pendingTailStableIds, source: FUNCTION_FLOW_SOURCE },
      );

      const resolvedStableIds = new Set();

      for (const record of records) {
        if (record.tailStableId) {
          resolvedStableIds.add(record.tailStableId);
        }

        const pathKey = JSON.stringify(
          (record.nodes || []).map((node) => node.properties?.stableId || node.stableId),
        );
        if (seenPathKeys.has(pathKey)) {
          continue;
        }

        seenPathKeys.add(pathKey);
        uniquePaths.push({
          nodes: record.nodes.map((node) => normalizeGraphNode(node)),
          rels: record.rels.map((rel) => normalizeGraphRelationship(rel)),
        });
      }

      if (!resolvedStableIds.size) {
        continue;
      }

      pendingTailStableIds = pendingTailStableIds.filter(
        (tailStableId) => !resolvedStableIds.has(tailStableId),
      );
    }
  }

  return uniquePaths;
}

function extractPathNodes(paths, { loggingUsefulOnly = false } = {}) {
  const seen = new Set();
  const result = [];
  for (const pathItem of paths || []) {
    for (const node of pathItem?.nodes || []) {
      if (!node?.stableId || seen.has(node.stableId)) {
        continue;
      }

      if (loggingUsefulOnly && !(node.labels || []).includes('LoggingUseful')) {
        continue;
      }

        seen.add(node.stableId);
        result.push(node);
    }
  }
  return result;
}

export function extractFeatureGraphNodes(paths) {
  return extractPathNodes(paths);
}

export function extractFeatureBackboneFunctionNodes(paths) {
  return extractPathNodes(paths).filter((node) => node?.kind === 'Fn' && node?.stableId);
}

export function extractNormalizedFeatureFunctionNodes(paths) {
  return extractFeatureBackboneFunctionNodes(paths).map((node) => normalizeFeatureBackboneNode(node));
}

export function extractLoggingUsefulNodesFromPaths(paths) {
  return extractPathNodes(paths, { loggingUsefulOnly: true });
}

function normalizeFeatureBackboneNode(node) {
  const location = node?.location || buildStableIdLocation({ stableId: node?.stableId });

  return {
    stableId: node?.stableId || '',
    kind: node?.kind || 'Node',
    labels: [...(node?.labels || [])],
    name: node?.name,
    label: node?.label,
    repoRelativePath: node?.repoRelativePath || location?.repoRelativePath,
    parentFnStableId: node?.parentFnStableId,
    startLine: location?.startLine,
    startColumn: location?.startColumn,
    endLine: location?.endLine,
    endColumn: location?.endColumn,
    isFunction: Boolean(node?.isFunction),
    isExternal: Boolean(node?.isExternal),
    runtimeLoggable: Boolean(node?.runtimeLoggable),
    runtimeLoggableKinds: [...(node?.runtimeLoggableKinds || [])],
    loggingUsefulKinds: [...(node?.loggingUsefulKinds || [])],
    loggingUsefulReasons: [...(node?.loggingUsefulReasons || [])],
  };
}

function buildFeatureBackboneData(feature, paths, backboneFunctionNodes) {
  return {
    available: true,
    error: null,
    feature: feature || null,
    headStableId: feature?.stableId || null,
    declaredEndFnStableIds: [...new Set((feature?.endFnStableIds || []).filter(Boolean))],
    pathCount: paths.length,
    backboneFunctionCount: backboneFunctionNodes.length,
    backboneFunctionNodes: backboneFunctionNodes.map((node) => normalizeFeatureBackboneNode(node)),
  };
}

function buildFeatureLoggingPayload(feature, backboneData) {
  return {
    schema: { kind: 'feature-logging', version: 1 },
    generatedAt: new Date().toISOString(),
    source: 'graph',
    feature,
    pathCount: backboneData.pathCount,
    backboneFunctionNodes: backboneData.backboneFunctionNodes,
  };
}

function getFunctionNodes(nodes) {
  return (nodes || []).filter((node) => node.isFunction);
}

async function loadBridgeExitFn(driver, database, feature) {
  if (!feature?.bridgeExitFnStableId) {
    return undefined;
  }

  const bridgeExitRecords = await runReadQuery(
    driver,
    database,
    'MATCH (fn {stableId: $stableId}) RETURN fn LIMIT 1',
    { stableId: feature.bridgeExitFnStableId },
  );

  return bridgeExitRecords[0]?.fn ? normalizeGraphNode(bridgeExitRecords[0].fn) : undefined;
}

function slicePathSegment(path, startStableId, endStableId) {
  const startIndex = (path?.nodes || []).findIndex((node) => node.stableId === startStableId);
  const endIndex = (path?.nodes || []).findIndex((node, index) => index >= startIndex && node.stableId === endStableId);

  if (startIndex < 0 || endIndex < startIndex) {
    return undefined;
  }

  return {
    nodes: path.nodes.slice(startIndex, endIndex + 1),
    rels: path.rels.slice(startIndex, endIndex),
  };
}

export async function resolveFeatureSequenceFromGraph(driver, database, feature) {
  const declaredEndFnStableIds = [...new Set((feature?.endFnStableIds || []).filter(Boolean))];
  const candidatePaths = await loadDeclaredFeatureBackbonePaths(driver, database, feature);

  if (!candidatePaths.length) {
    throw new Error(`Feature sequence connectivity could not be derived for ${feature?.key || feature?.stableId || 'feature'}: no directed path from head to declared tails. Declared tails: ${declaredEndFnStableIds.join(', ') || 'none'}.`);
  }

  const declaredTailOrder = new Map(declaredEndFnStableIds.map((stableId, index) => [stableId, index]));
  const orderedCandidatePaths = [...candidatePaths].sort((left, right) => (
    (declaredTailOrder.get(left.endFnStableId) ?? Number.MAX_SAFE_INTEGER)
    - (declaredTailOrder.get(right.endFnStableId) ?? Number.MAX_SAFE_INTEGER)
  ));
  const headPath = orderedCandidatePaths[0];
  const explicitBridgeExitFn = await loadBridgeExitFn(driver, database, feature);
  const tailPath = orderedCandidatePaths.find((path) => path.endFnStableId !== headPath.endFnStableId) || headPath;

  const startFn = getFunctionNodes(headPath.nodes)[0];
  const bridgeEntryFn = getFunctionNodes(headPath.nodes).at(-1);
  const bridgeExitFn = explicitBridgeExitFn
    || getFunctionNodes(tailPath?.nodes)[0]
    || bridgeEntryFn;
  const endFn = getFunctionNodes(tailPath?.nodes).at(-1);

  if (!startFn?.stableId || !bridgeEntryFn?.stableId || !bridgeExitFn?.stableId || !endFn?.stableId) {
    throw new Error(`Feature sequence anchors could not be derived from the graph for ${feature?.key || feature?.stableId || 'feature'}.`);
  }

  const headSegment = slicePathSegment(headPath, startFn.stableId, bridgeEntryFn.stableId);
  const tailSegment = tailPath.nodes[0]?.stableId === bridgeExitFn.stableId
    ? tailPath
    : await queryShortestPath(driver, database, bridgeExitFn.stableId, endFn.stableId);

  if (!headSegment) {
    throw new Error(`No directed function-flow path was found between ${startFn.stableId} and ${bridgeEntryFn.stableId}.`);
  }
  if (!tailSegment) {
    throw new Error(`No directed function-flow path was found between ${bridgeExitFn.stableId} and ${endFn.stableId}.`);
  }

  return {
    startFn,
    bridgeEntryFn,
    bridgeExitFn,
    endFn,
    headSegment,
    tailSegment,
  };
}

export async function loadFeatureBackboneData(driver, database, feature) {
  const paths = await loadDeclaredFeatureBackbonePaths(driver, database, feature);
  const backboneFunctionNodes = extractFeatureBackboneFunctionNodes(paths);

  if (!paths.length) {
    return {
      available: false,
      error: `No directed function-flow paths were found in the graph for feature ${feature?.key || feature?.stableId || 'feature'}.`,
      feature: feature || null,
      headStableId: feature?.stableId || null,
      declaredEndFnStableIds: [...new Set((feature?.endFnStableIds || []).filter(Boolean))],
      pathCount: 0,
      backboneFunctionCount: 0,
      backboneFunctionNodes: [],
    };
  }

  return buildFeatureBackboneData(feature, paths, backboneFunctionNodes);
}

export async function loadFeatureLoggingPayload(driver, database, feature) {
  const backboneData = await loadFeatureBackboneData(driver, database, feature);

  if (!backboneData.available) {
    throw new Error(backboneData.error || `No feature backbone data is available for ${feature?.key || feature?.stableId || 'feature'}.`);
  }

  return buildFeatureLoggingPayload(feature, backboneData);
}


