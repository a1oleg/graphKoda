import { runReadQuery } from '../../../runtime-relay/src/runtimeEvents.js';

function normalizeStringList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

function normalizeBusinessObjectList(values) {
  if (Array.isArray(values)) {
    return normalizeStringList(values);
  }

  if (typeof values !== 'string') {
    return [];
  }

  const trimmed = values.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('[')) {
    try {
      return normalizeBusinessObjectList(JSON.parse(trimmed));
    } catch {
      return [trimmed];
    }
  }

  return normalizeStringList(trimmed.split(/[\s,]+/));
}

function parseBusinessObjectSummary(summaryJson) {
  if (!summaryJson) {
    return [];
  }

  try {
    const parsed = JSON.parse(summaryJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function createRoute(key) {
  return {
    businessObjectKey: key,
    businessObjectRoles: [],
    businessObjectSummaryJson: null,
    nodes: [],
    edges: [],
    nodeCount: 0,
    edgeCount: 0,
    __nodeById: new Map(),
    __edgeIds: new Set(),
    __summaryBySignature: new Map(),
  };
}

function ensureRoute(routeByKey, key) {
  let route = routeByKey.get(key);
  if (!route) {
    route = createRoute(key);
    routeByKey.set(key, route);
  }

  return route;
}

function mergeRouteRoles(route, roles) {
  route.businessObjectRoles = normalizeStringList([...route.businessObjectRoles, ...normalizeBusinessObjectList(roles)]);
}

function mergeRouteSummary(route, summaryJson, key) {
  const entries = parseBusinessObjectSummary(summaryJson).filter((entry) => entry?.key === key);
  if (!entries.length) {
    return;
  }

  for (const entry of entries) {
    route.__summaryBySignature.set(JSON.stringify(entry), entry);
  }

  route.businessObjectSummaryJson = JSON.stringify([...route.__summaryBySignature.values()]);
}

function addRouteNode(route, node) {
  const stableId = String(node?.stableId || '').trim();
  if (!stableId) {
    return;
  }

  const normalizedRoles = normalizeBusinessObjectList(node.businessObjectRoles);
  const existing = route.__nodeById.get(stableId);
  if (existing) {
    existing.labels = normalizeStringList([...(existing.labels || []), ...(Array.isArray(node.labels) ? node.labels : [])]);
    existing.label = existing.label || node.label || null;
    existing.parentFnStableId = existing.parentFnStableId || node.parentFnStableId || null;
    existing.operationIndex = existing.operationIndex ?? node.operationIndex ?? null;
    existing.businessObjectRoles = normalizeStringList([...(existing.businessObjectRoles || []), ...normalizedRoles]);
    return;
  }

  route.__nodeById.set(stableId, {
    stableId,
    labels: normalizeStringList(node.labels),
    label: node.label || null,
    parentFnStableId: node.parentFnStableId || null,
    operationIndex: node.operationIndex ?? null,
    businessObjectRoles: normalizedRoles,
  });
}

function addRouteEdge(route, edge) {
  const sourceStableId = String(edge?.sourceStableId || '').trim();
  const targetStableId = String(edge?.targetStableId || '').trim();
  const type = String(edge?.type || '').trim();
  if (!sourceStableId || !targetStableId || !type) {
    return;
  }

  const edgeId = [sourceStableId, type, targetStableId, edge.role || '', edge.callTextRaw || '', edge.label || ''].join('|');
  if (route.__edgeIds.has(edgeId)) {
    return;
  }

  route.__edgeIds.add(edgeId);
  route.edges.push({
    type,
    role: edge.role || null,
    label: edge.label || null,
    callTextRaw: edge.callTextRaw || null,
    sourceStableId,
    targetStableId,
    businessObjectRoles: normalizeBusinessObjectList(edge.businessObjectRoles),
  });
}

function finalizeRoute(route) {
  route.nodes = [...route.__nodeById.values()].sort((a, b) => {
    const operationA = a.operationIndex ?? Number.MAX_SAFE_INTEGER;
    const operationB = b.operationIndex ?? Number.MAX_SAFE_INTEGER;
    if (operationA !== operationB) {
      return operationA - operationB;
    }

    return a.stableId.localeCompare(b.stableId);
  });

  route.nodeCount = route.nodes.length;
  route.edgeCount = route.edges.length;
  delete route.__nodeById;
  delete route.__edgeIds;
  delete route.__summaryBySignature;
  return route;
}

function buildRoutesFromBusinessObjectRecords({
  functions = [],
  steps = [],
  edges = [],
}) {
  const routeByKey = new Map();

  for (const fn of functions) {
    const functionKeys = normalizeBusinessObjectList(fn.businessObjectKeys);
    const functionRoles = normalizeBusinessObjectList(fn.businessObjectRoles);

    for (const key of functionKeys) {
      const route = ensureRoute(routeByKey, key);
      mergeRouteRoles(route, functionRoles);
      mergeRouteSummary(route, fn.businessObjectSummaryJson, key);
      addRouteNode(route, {
        stableId: fn.stableId,
        labels: ['Fn'],
        label: fn.label || fn.name || null,
        parentFnStableId: fn.stableId,
        operationIndex: -1,
        businessObjectRoles: functionRoles,
      });
    }
  }

  for (const step of steps) {
    const stepKeys = normalizeBusinessObjectList(step.businessObjectKeys);
    for (const key of stepKeys) {
      const route = ensureRoute(routeByKey, key);
      mergeRouteRoles(route, step.businessObjectRoles);
      mergeRouteSummary(route, step.businessObjectSummaryJson, key);
      addRouteNode(route, step);
    }
  }

  for (const edge of edges) {
    const edgeKeys = normalizeBusinessObjectList(edge.businessObjectKeys);
    for (const key of edgeKeys) {
      const route = ensureRoute(routeByKey, key);
      mergeRouteRoles(route, edge.businessObjectRoles);
      mergeRouteSummary(route, edge.businessObjectSummaryJson, key);
      addRouteNode(route, {
        stableId: edge.sourceStableId,
        labels: edge.sourceLabels,
        label: edge.sourceLabel || edge.sourceName || null,
        parentFnStableId: edge.sourceParentFnStableId || null,
        operationIndex: edge.sourceOperationIndex,
        businessObjectRoles: [],
      });
      addRouteNode(route, {
        stableId: edge.targetStableId,
        labels: edge.targetLabels,
        label: edge.targetLabel || edge.targetName || null,
        parentFnStableId: edge.targetParentFnStableId || null,
        operationIndex: edge.targetOperationIndex,
        businessObjectRoles: [],
      });
      addRouteEdge(route, edge);
    }
  }

  return [...routeByKey.values()]
    .map(finalizeRoute)
    .sort((a, b) => a.businessObjectKey.localeCompare(b.businessObjectKey));
}

export async function loadFunctionBusinessObjectRoutes(driver, database, fn) {
  if (!fn?.stableId) {
    return [];
  }

  const stableId = fn.stableId;
  const [stepRecords, edgeRecords] = await Promise.all([
    runReadQuery(
      driver,
      database,
      `
        MATCH (step:Step {parentFnStableId: $stableId})
        WHERE size(coalesce(step.business_object_keys, [])) > 0
        RETURN step.stableId AS stableId,
               labels(step) AS labels,
               step.label AS label,
               step.parentFnStableId AS parentFnStableId,
               step.operation_index AS operationIndex,
               coalesce(step.business_object_keys, []) AS businessObjectKeys,
               coalesce(step.business_object_roles, []) AS businessObjectRoles,
               step.business_object_summary_json AS businessObjectSummaryJson
        ORDER BY operationIndex, stableId
      `,
      { stableId },
    ),
    runReadQuery(
      driver,
      database,
      `
        MATCH (source)-[rel]->(target)
        WHERE (
            source.stableId = $stableId
            OR source.parentFnStableId = $stableId
          )
          AND size(coalesce(rel.business_object_keys, [])) > 0
        RETURN source.stableId AS sourceStableId,
               labels(source) AS sourceLabels,
               source.label AS sourceLabel,
               source.name AS sourceName,
               source.parentFnStableId AS sourceParentFnStableId,
               source.operation_index AS sourceOperationIndex,
               target.stableId AS targetStableId,
               labels(target) AS targetLabels,
               target.label AS targetLabel,
               target.name AS targetName,
               target.parentFnStableId AS targetParentFnStableId,
               target.operation_index AS targetOperationIndex,
               type(rel) AS type,
               coalesce(
                 rel.role,
                 CASE
                   WHEN type(rel) = 'CALL' THEN 'call'
                   WHEN type(rel) = 'SUBSCRIBE' THEN 'subscribe'
                   WHEN type(rel) IN ['CALLBACK','EXPECT_UPDATE','APPLY_UPDATE','PRODUCE','RETURN','SEMANTIC'] THEN 'semantic'
                   WHEN type(rel) IN ['READ','TEST','CREATE','UPDATE','DELETE','CLEAR','EMIT','WAIT','SIGNAL','FEED','PART'] THEN 'resource'
                   ELSE null
                 END
               ) AS role,
               rel.label AS label,
               rel.call_text_raw AS callTextRaw,
               coalesce(rel.business_object_keys, []) AS businessObjectKeys,
               coalesce(rel.business_object_roles, []) AS businessObjectRoles,
               rel.business_object_summary_json AS businessObjectSummaryJson
        ORDER BY sourceOperationIndex, sourceStableId, targetStableId
      `,
      { stableId },
    ),
  ]);

  return buildRoutesFromBusinessObjectRecords({
    functions: [fn],
    steps: stepRecords,
    edges: edgeRecords,
  });
}

export async function loadBusinessObjectRoute(driver, database, businessObjectKey) {
  const normalizedKey = String(businessObjectKey || '').trim();
  if (!normalizedKey) {
    return null;
  }

  const [functionRecords, stepRecords, edgeRecords] = await Promise.all([
    runReadQuery(
      driver,
      database,
      `
        MATCH (fn:Fn)
        WHERE $businessObjectKey IN coalesce(fn.business_object_keys, [])
        RETURN fn.stableId AS stableId,
               fn.name AS name,
               fn.label AS label,
               coalesce(fn.business_object_keys, []) AS businessObjectKeys,
               coalesce(fn.business_object_roles, []) AS businessObjectRoles,
               fn.business_object_summary_json AS businessObjectSummaryJson
        ORDER BY stableId
      `,
      { businessObjectKey: normalizedKey },
    ),
    runReadQuery(
      driver,
      database,
      `
        MATCH (step:Step)
        WHERE $businessObjectKey IN coalesce(step.business_object_keys, [])
        RETURN step.stableId AS stableId,
               labels(step) AS labels,
               step.label AS label,
               step.parentFnStableId AS parentFnStableId,
               step.operation_index AS operationIndex,
               coalesce(step.business_object_keys, []) AS businessObjectKeys,
               coalesce(step.business_object_roles, []) AS businessObjectRoles,
               step.business_object_summary_json AS businessObjectSummaryJson
        ORDER BY operationIndex, stableId
      `,
      { businessObjectKey: normalizedKey },
    ),
    runReadQuery(
      driver,
      database,
      `
        MATCH (source)-[rel]->(target)
        WHERE $businessObjectKey IN coalesce(rel.business_object_keys, [])
        RETURN source.stableId AS sourceStableId,
               labels(source) AS sourceLabels,
               source.label AS sourceLabel,
               source.name AS sourceName,
               source.parentFnStableId AS sourceParentFnStableId,
               source.operation_index AS sourceOperationIndex,
               source.name AS sourceName,
               source.parentFnStableId AS sourceParentFnStableId,
               source.operation_index AS sourceOperationIndex,
               target.stableId AS targetStableId,
               labels(target) AS targetLabels,
               target.label AS targetLabel,
               target.name AS targetName,
               target.parentFnStableId AS targetParentFnStableId,
               target.operation_index AS targetOperationIndex,
               type(rel) AS type,
               coalesce(
                 rel.role,
                 CASE
                   WHEN type(rel) = 'CALL' THEN 'call'
                   WHEN type(rel) = 'SUBSCRIBE' THEN 'subscribe'
                   WHEN type(rel) IN ['CALLBACK','EXPECT_UPDATE','APPLY_UPDATE','PRODUCE','RETURN','SEMANTIC'] THEN 'semantic'
                   WHEN type(rel) IN ['READ','TEST','CREATE','UPDATE','DELETE','CLEAR','EMIT','WAIT','SIGNAL','FEED','PART'] THEN 'resource'
                   ELSE null
                 END
               ) AS role,
               rel.label AS label,
               rel.call_text_raw AS callTextRaw,
               coalesce(rel.business_object_keys, []) AS businessObjectKeys,
               coalesce(rel.business_object_roles, []) AS businessObjectRoles,
               rel.business_object_summary_json AS businessObjectSummaryJson
        ORDER BY sourceOperationIndex, sourceStableId, targetStableId
      `,
    ),
  ]);

  return buildRoutesFromBusinessObjectRecords({
    functions: functionRecords,
    steps: stepRecords,
    edges: edgeRecords,
  });
}


