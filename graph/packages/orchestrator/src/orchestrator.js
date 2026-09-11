import http from 'node:http';

import neo4j from 'neo4j-driver';
import { serveAnnotationPlanUi } from './orchestrator/annotationPlanUi.js';
import { replayLaunch } from './orchestrator/annotation-plan/replayRoutes.js';
import { loadHelpersContext } from './orchestrator/helpersContext.js';
import { loadInputContext } from './orchestrator/inputContext.js';
import { executeAnnotationGraphql, annotationSchemaSDL } from './orchestrator/annotationGraphql.js';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SWAGGER_UI_DIST_PATH = path.dirname(require.resolve('swagger-ui-dist/package.json'));

import {
  buildDerivedFeatureLoggingProfile,
  resolveFeatureLoggingPayload,
} from './orchestrator/featureLogging.js';
import { buildFeatureDrawDiagram, buildFeaturePathGraphDrawDiagram } from './orchestrator/featureDraw.js';
import { loadFeaturePathGraphData } from './orchestrator/featureGraph.js';
import { buildPhasePathGraphDrawDiagram, buildPhaseSwimlaneDrawDiagram } from './orchestrator/phaseDraw.js';
import { loadPhasePathGraphData, resolvePhaseEntity } from './orchestrator/phaseGraph.js';
import { loadFeatureRuntimeNodeLogs } from './orchestrator/featureRuntimeLogs.js';
import { buildFunctionFlowDrawDiagram } from './orchestrator/functionFlowDraw.js';
import { saveFeatureReproFile } from './orchestrator/featureRepro.js';
import {
  DEFAULT_FEATURE_PRIMARY_FUNCTION_SET_PATH,
  DEFAULT_FEATURE_JSON_PATH,
  readFeatureJsonPayload,
  resolveFeatureEntity,
  resolveFeatureJsonPath,
} from './orchestrator/featureRestore.js';
import {
  resolveFeatureReproContext,
  runResolvedFeatureRepro,
} from './orchestrator/featureWorkflows.js';
import {
  buildOrchestratorConfig,
} from './orchestrator/config.js';
import { buildRuntimeStoreConfig } from '../../runtime-relay/src/config.js';
import {
  getOrchestratorLanding,
  getOrchestratorGuide,
} from './orchestrator/runtimeKnowledge.js';
import {
  loadUiExplorerAffordanceFlow,
  loadUiExplorerChildren,
  loadUiExplorerModalStrictDiagnostics,
  loadUiExplorerObjectCatalog,
  loadUiExplorerObjectFunctions,
  loadUiExplorerObjectPaths,
  loadUiExplorerRoots,
  loadUiExplorerSurface,
  loadUiExplorerTopBlocks,
} from './orchestrator/uiExplorerData.js';
import { renderUiExplorerPage } from './orchestrator/uiExplorerPage.js';
import {
  cleanupMockedDevServer,
  cleanupRuntimeIngestion,
  ensureInfraReadiness,
  ensureReverseObservationStack,
  ensureReverseService,
  ensureRuntimeIngestionReadiness,
  getInfraReadiness,
  getInfraServiceStatus,
  getOrchestratorStatus,
  getProcessDiagnosticsStatus,
  getGraphReproMonitorStatus,
  getMockedDevServerStatus,
  getOrdinaryDevServerStatus,
  getOrchestratorRestartRunbook,
  getPlaywrightDevopsStatus,
  getReverseReadyForObservation,
  getRuntimeIngestionReadiness,
  launchGraphSession,
  normalizeNeo4jDriverUri,
  recoverNeo4j,
  restartInfraReadiness,
  repairRuntimeMaterialization,
  startInfraService,
  startMockedDevServer,
  startOrdinaryDevServer,
  startPlaywrightSessionCapture,
  stopGraphSession,
  stopMockedDevServer,
  stopOrdinaryDevServer,
  stopPlaywrightSessionCapture,
  stopReverseService,
} from './orchestrator/serviceManagement.js';
import {
  getExtractPlan,
  getExtractPreflight,
  getExtractStatus,
  importFunctionsScoped,
  startExtract,
  stopExtract,
} from './orchestrator/graphExtract.js';
import { resetGraphDatabase } from './orchestrator/graphReset.js';
import { Fragment } from './orchestrator/fragment.js';
import {
  completeAnnotation,
  completeAnnotationWorkflow,
  getAnnotationToolMetadata,
  getAnnotationJob,
  leaseNextAnnotationTask,
  resolveAnnotation,
  startAnnotationWorkflow,
  validateAnnotationTextEncoding,
} from './orchestrator/annotationResolver.js';
import { annotationProfileContract } from './orchestrator/annotationProfiles.js';
import {
  buildApiContractAudit,
  buildOpenApiDocument,
  renderSwaggerUi,
} from './orchestrator/apiContract.js';

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendHtml(response, statusCode, html) {
  response.writeHead(statusCode, {
    'content-type': 'text/html; charset=utf-8',
  });
  response.end(html);
}

function sendStaticFile(response, absolutePath, contentType) {
  const body = fs.readFileSync(absolutePath);
  response.writeHead(200, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'public, max-age=3600',
  });
  response.end(body);
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  const rawBody = Buffer.concat(chunks).toString('utf8').trim();
  if (!rawBody) {
    return {};
  }

  return JSON.parse(rawBody);
}

function parseJsonArg(rawValue, fieldName) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return undefined;
  }

  if (typeof rawValue === 'object') {
    return rawValue;
  }

  try {
    return JSON.parse(rawValue);
  } catch {
    throw new Error(`${fieldName} must be valid JSON.`);
  }
}

function parseStableIdStartLine(stableId) {
  const parts = String(stableId || '').split(':');
  if (parts.length < 5) return null;
  const line = Number(parts[parts.length - 4]);
  return Number.isFinite(line) ? line : null;
}

function neo4jNumberToNumber(value) {
  if (value && typeof value.toNumber === 'function') return value.toNumber();
  return Number(value);
}

function plainNeo4jProperties(value) {
  const props = value?.properties || value || {};
  const result = {};
  for (const [key, propValue] of Object.entries(props)) {
    result[key] = propValue && typeof propValue.toNumber === 'function' ? propValue.toNumber() : propValue;
  }
  return result;
}

async function loadFunctionFlowGraph(driver, database, {
  fnStableId,
  source = 'semantic/functionFlowGraph',
  rangeStart,
  rangeEnd,
} = {}) {
  const stableId = String(fnStableId || '').trim();
  if (!stableId) throw new Error('fnStableId is required.');
  const minLine = Number.isFinite(Number(rangeStart)) ? Number(rangeStart) : null;
  const maxLine = Number.isFinite(Number(rangeEnd)) ? Number(rangeEnd) : null;
  const controlEdgeTypes = ['NEXT', 'TRUE', 'FALSE', 'OPTION_CASE', 'OPTION_DEFAULT', 'REJOINS', 'MERGES_TO'];
  const functionEdgeTypes = [...controlEdgeTypes, 'ARG', 'FIELD', 'RESPONSE', 'REQUEST', 'CALL', 'SUBSCRIBE', 'CALLBACK', 'EXPECT_UPDATE', 'APPLY_UPDATE', 'PRODUCE', 'SEMANTIC'];
  const resourceEdgeTypes = ['READ', 'TEST', 'CREATE', 'UPDATE', 'DELETE', 'CLEAR', 'EMIT', 'WAIT', 'SUBSCRIBE', 'SIGNAL', 'START', 'CANCEL', 'DERIVE'];
  const resourceLinkEdgeTypes = ['FEED'];
  const flowNodeLabels = ['Step', 'LocalValue', 'LocalMutation', 'Boundary', 'FnDeclaration', 'Branch', 'Join', 'Flow', 'Field', 'Operand', 'Switch', 'Case', 'Return', 'FunctionEnd', 'BreakStop', 'ThrowStop', 'Call', 'Request', 'Arg', 'Obj', 'Object'];
  const flowNodePredicate = (alias) => `(${flowNodeLabels.map((label) => `${alias}:${label}`).join(' OR ')})`;
  const session = driver.session({ database });
  try {
    const rootRow = await session.run(`
      MATCH (root:Fn {stableId: $fnStableId})
      RETURN root { .stableId, .name, .label, .repo_relative_path } AS root
    `, { fnStableId: stableId });
    const root = rootRow.records[0]?.get('root');
    if (!root) throw new Error(`Root Fn was not found: ${stableId}`);

    const stepRows = await session.run(`
      MATCH (step {source: $source, parentFnStableId: $fnStableId})
      WHERE ${flowNodePredicate('step')}
      RETURN step, labels(step) AS labels
    `, { source, fnStableId: stableId });
    const steps = stepRows.records
      .map((record) => {
        const step = plainNeo4jProperties(record.get('step'));
        return {
          ...step,
          labels: record.get('labels') || [],
          line: parseStableIdStartLine(step.stableId),
        };
      })
      .filter((step) => step.line !== null)
      .filter((step) => minLine === null || step.line >= minLine)
      .filter((step) => maxLine === null || step.line <= maxLine)
      .sort((left, right) => (left.line - right.line) || String(left.stableId).localeCompare(String(right.stableId)));
    const stepIds = steps.map((step) => step.stableId);

    const edgeRows = stepIds.length
      ? await session.run(`
        MATCH (root:Fn {stableId: $fnStableId})-[rel:NEXT {source: $source}]->(target {source: $source})
        WHERE target.stableId IN $stepIds
          AND ${flowNodePredicate('target')}
        RETURN startNode(rel).stableId AS fromId,
               CASE WHEN startNode(rel):Fn THEN 'Fn' ELSE 'Step' END AS fromKind,
               endNode(rel).stableId AS toId,
               CASE WHEN endNode(rel):Fn THEN 'Fn' ELSE 'Step' END AS toKind,
               type(rel) AS relType,
               'control' AS role,
               rel.label AS label,
               rel.call_text_raw AS callTextRaw
        UNION
        MATCH (sourceNode {source: $source})-[rel {source: $source}]->(target)
        WHERE sourceNode.stableId IN $stepIds
          AND ${flowNodePredicate('sourceNode')}
          AND type(rel) IN $functionEdgeTypes
          AND ((target.stableId IN $stepIds AND ${flowNodePredicate('target')}) OR target:Fn)
        RETURN startNode(rel).stableId AS fromId,
               CASE WHEN startNode(rel):Fn THEN 'Fn' ELSE 'Step' END AS fromKind,
               endNode(rel).stableId AS toId,
               CASE WHEN endNode(rel):Fn THEN 'Fn' ELSE 'Step' END AS toKind,
               type(rel) AS relType,
               CASE
                 WHEN type(rel) IN ['CALL', 'REQUEST'] THEN 'call'
                 WHEN type(rel) = 'SUBSCRIBE' THEN 'subscribe'
                 WHEN type(rel) IN ['CALLBACK','EXPECT_UPDATE','APPLY_UPDATE','PRODUCE','SEMANTIC'] THEN 'semantic'
                 ELSE 'control'
               END AS role,
               rel.label AS label,
               rel.call_text_raw AS callTextRaw
        UNION
        MATCH (sourceNode {source: $source})-[rel {source: $source}]->(target {source: $source, parentFnStableId: $fnStableId})
        WHERE sourceNode.stableId IN $stepIds
          AND ${flowNodePredicate('sourceNode')}
          AND target.resource_kind IS NOT NULL
          AND type(rel) IN $resourceEdgeTypes
        RETURN startNode(rel).stableId AS fromId,
               'Step' AS fromKind,
               target.stableId AS toId,
               'Resource' AS toKind,
               type(rel) AS relType,
               'resource' AS role,
               coalesce(rel.access_type, type(rel)) AS label,
               rel.callee_text AS callTextRaw
        UNION
        MATCH (sourceResource {source: $source, parentFnStableId: $fnStableId})-[rel {source: $source}]->(targetResource {source: $source, parentFnStableId: $fnStableId})
        WHERE sourceResource.resource_kind IS NOT NULL
          AND targetResource.resource_kind IS NOT NULL
          AND type(rel) IN $resourceLinkEdgeTypes
        RETURN sourceResource.stableId AS fromId,
               'Resource' AS fromKind,
               targetResource.stableId AS toId,
               'Resource' AS toKind,
               type(rel) AS relType,
               'resource' AS role,
               coalesce(rel.label, type(rel)) AS label,
               rel.callee_text AS callTextRaw
      `, { source, fnStableId: stableId, stepIds, functionEdgeTypes, resourceEdgeTypes, resourceLinkEdgeTypes })
      : { records: [] };
    const edges = edgeRows.records.map((record) => ({
      fromId: record.get('fromId'),
      fromKind: record.get('fromKind'),
      toId: record.get('toId'),
      toKind: record.get('toKind'),
      relType: record.get('relType'),
      role: record.get('role') || roleFromFunctionFlowType(record.get('relType'), record.get('toKind')),
      label: record.get('label') || '',
      callTextRaw: record.get('callTextRaw') || '',
    }));
    rewireStepResourceEdgesThroughCalledFns(edges);
    if (stepIds.length && maxLine !== null) {
      const boundaryRows = await session.run(`
        MATCH (sourceNode {source: $source})-[rel {source: $source}]->(target {source: $source, parentFnStableId: $fnStableId})
        WHERE sourceNode.stableId IN $stepIds
          AND ${flowNodePredicate('sourceNode')}
          AND ${flowNodePredicate('target')}
          AND type(rel) IN $controlEdgeTypes
          AND NOT target.stableId IN $stepIds
        RETURN startNode(rel).stableId AS fromId,
               'Step' AS fromKind,
               target.stableId AS toId,
               'Step' AS toKind,
               type(rel) AS relType,
               'control' AS role,
               rel.label AS label,
               rel.call_text_raw AS callTextRaw,
               target AS targetStep,
               labels(target) AS targetLabels
      `, { source, fnStableId: stableId, stepIds, controlEdgeTypes });
      const knownStepIds = new Set(stepIds);
      for (const record of boundaryRows.records) {
        const targetStep = plainNeo4jProperties(record.get('targetStep'));
        edges.push({
          fromId: record.get('fromId'),
          fromKind: record.get('fromKind'),
          toId: record.get('toId'),
          toKind: record.get('toKind'),
          relType: record.get('relType'),
          role: record.get('role') || roleFromFunctionFlowType(record.get('relType'), record.get('toKind')),
          label: record.get('label') || '',
          callTextRaw: record.get('callTextRaw') || '',
          boundary: true,
        });
        if (!knownStepIds.has(targetStep.stableId)) {
          knownStepIds.add(targetStep.stableId);
          stepIds.push(targetStep.stableId);
          steps.push({
            ...targetStep,
            labels: record.get('targetLabels') || [],
            line: parseStableIdStartLine(targetStep.stableId),
            boundary: true,
          });
        }
      }
      steps.sort((left, right) => (left.line - right.line) || String(left.stableId).localeCompare(String(right.stableId)));
    }
    const controlIncomingIds = new Set(edges
      .filter((edge) => edge.role === 'control' && edge.toKind === 'Step')
      .map((edge) => edge.toId));
    const hasFnEntryEdge = edges.some((edge) => edge.fromKind === 'Fn' && edge.toKind === 'Step');
    if (stepIds.length && !hasFnEntryEdge) {
      steps
        .filter((step) => !controlIncomingIds.has(step.stableId))
        .forEach((step) => {
          edges.push({
            fromId: stableId,
            fromKind: 'Fn',
            toId: step.stableId,
            toKind: 'Step',
            relType: 'NEXT',
            role: 'control',
            label: '',
            callTextRaw: '',
            synthetic: true,
          });
        });
    }

    const targetFnIds = [...new Set(edges.filter((edge) => edge.toKind === 'Fn' && edge.toId !== stableId).map((edge) => edge.toId))].sort();
    const targetFnRows = targetFnIds.length
      ? await session.run(`
        MATCH (fn:Fn)
        WHERE fn.stableId IN $targetFnIds
        RETURN fn { .stableId, .name, .label, .repo_relative_path } AS fn
        ORDER BY fn.stableId
      `, { targetFnIds })
      : { records: [] };
    const targetFns = targetFnRows.records.map((record) => record.get('fn'));
    const targetFnResourceRows = targetFnIds.length
      ? await session.run(`
        MATCH (step {source: $source})-[rel {source: $source}]->(resource {source: $source})
        WHERE step.parentFnStableId IN $targetFnIds
          AND resource.resource_kind IS NOT NULL
          AND ${flowNodePredicate('step')}
          AND type(rel) IN $resourceEdgeTypes
        RETURN step.parentFnStableId AS targetStableId,
               step.stableId AS stepStableId,
               step.start_line AS line,
               step.start_column AS column,
               type(rel) AS relType,
               coalesce(rel.access_type, type(rel)) AS accessType,
               resource {
                 .stableId,
                 .resource_kind,
                 .resource_subkind,
                 .resource_name,
                 .resource_cell_name,
                 .resource_cell_kind,
                 .parentStableId,
                 .resource_semantic_id,
                 .resource_semantic_detail_id,
                 labels: labels(resource)
               } AS resource
        ORDER BY targetStableId, line, column, resource.resource_kind, resource.resource_name, resource.stableId
      `, { source, targetFnIds, resourceEdgeTypes })
      : { records: [] };
    const targetFnResources = targetFnResourceRows.records.map((record) => ({
      targetStableId: record.get('targetStableId'),
      stepStableId: record.get('stepStableId'),
      line: Number(record.get('line') || 0),
      column: Number(record.get('column') || 0),
      relType: record.get('relType'),
      accessType: record.get('accessType'),
      resource: record.get('resource'),
    }));

    const resourceIds = [...new Set(edges.flatMap((edge) => [
      edge.fromKind === 'Resource' ? edge.fromId : null,
      edge.toKind === 'Resource' ? edge.toId : null,
    ].filter(Boolean)))];
    const resourceRows = resourceIds.length
      ? await session.run(`
        MATCH (resource {source: $source, parentFnStableId: $fnStableId})
        WHERE resource.resource_kind IS NOT NULL AND resource.stableId IN $resourceIds
        RETURN resource {
          .stableId,
          .resource_kind,
          .resource_subkind,
          .resource_name,
          .resource_cell_name,
          .resource_cell_kind,
          .parentStableId,
          .resource_semantic_id,
          .resource_semantic_detail_id,
          labels: labels(resource)
        } AS resource
        ORDER BY resource.resource_kind, resource.resource_name, resource.stableId
      `, { source, fnStableId: stableId, resourceIds })
      : { records: [] };
    const resources = resourceRows.records.map((record) => record.get('resource'));
    const asyncFlowSemanticIds = [...new Set(resources
      .filter((resource) => resource?.resource_kind === 'async-flow')
      .map((resource) => resource.resource_semantic_id)
      .filter(Boolean))];
    const asyncFlowPeerRows = asyncFlowSemanticIds.length
      ? await session.run(`
        MATCH (step {source: $source})-[rel {source: $source}]->(resource {source: $source})
        WHERE resource.resource_semantic_id IN $semanticIds
          AND resource.resource_kind IS NOT NULL
          AND ${flowNodePredicate('step')}
          AND type(rel) IN $resourceEdgeTypes
          AND NOT step.stableId IN $stepIds
        OPTIONAL MATCH (fn:Fn {stableId: step.parentFnStableId})
        RETURN resource.resource_semantic_id AS semanticId,
               step.parentFnStableId AS fnStableId,
               fn.name AS fnName,
               fn.repo_relative_path AS fnPath,
               step.stableId AS stepStableId,
               step.start_line AS line,
               step.start_column AS column,
               step.action_text_raw AS actionTextRaw,
               type(rel) AS relType,
               coalesce(rel.access_type, type(rel)) AS accessType,
               resource {
                 .stableId,
                 .resource_kind,
                 .resource_subkind,
                 .resource_name,
                 .resource_cell_name,
                 .resource_cell_kind,
                 .parentStableId,
                 .resource_semantic_id,
                 .resource_semantic_detail_id,
                 labels: labels(resource)
               } AS resource
        ORDER BY semanticId, fnPath, line, column, relType
      `, { source, semanticIds: asyncFlowSemanticIds, stepIds, resourceEdgeTypes })
      : { records: [] };
    const asyncFlowPeers = asyncFlowPeerRows.records.map((record) => ({
      semanticId: record.get('semanticId'),
      fnStableId: record.get('fnStableId'),
      fnName: record.get('fnName'),
      fnPath: record.get('fnPath'),
      stepStableId: record.get('stepStableId'),
      line: Number(record.get('line') || 0),
      column: Number(record.get('column') || 0),
      actionTextRaw: record.get('actionTextRaw') || '',
      relType: record.get('relType'),
      accessType: record.get('accessType'),
      resource: record.get('resource'),
    }));

    return {
      ok: true,
      source,
      fnStableId: stableId,
      rangeStart: minLine,
      rangeEnd: maxLine,
      root,
      steps,
      edges,
      targetFns,
      targetFnResources,
      resources,
      asyncFlowPeers,
      summary: {
        stepCount: steps.length,
        edgeCount: edges.length,
        targetFnCount: targetFns.length,
        targetFnResourceCount: targetFnResources.length,
        resourceCount: resources.length,
        asyncFlowPeerCount: asyncFlowPeers.length,
      },
    };
  } finally {
    await session.close();
  }
}

function rewireStepResourceEdgesThroughCalledFns(edges) {
  const callTargetByStep = new Map();
  for (const edge of edges) {
    if (edge.fromKind === 'Step' && edge.toKind === 'Fn' && edge.toId && !callTargetByStep.has(edge.fromId)) {
      callTargetByStep.set(edge.fromId, edge.toId);
    }
  }
  for (const edge of edges) {
    if (edge.fromKind !== 'Step' || edge.toKind !== 'Resource') continue;
    const callTarget = callTargetByStep.get(edge.fromId);
    if (!callTarget) continue;
    const sourceStepId = edge.fromId;
    edge.fromId = callTarget;
    edge.fromKind = 'Fn';
    edge.visualSourceStepId = edge.visualSourceStepId || sourceStepId;
  }
}

function roleFromFunctionFlowType(relType, toKind) {
  if (relType === 'CALL' || relType === 'REQUEST') return 'call';
  if (relType === 'SUBSCRIBE' && toKind === 'Fn') return 'subscribe';
  if (['CALLBACK', 'EXPECT_UPDATE', 'APPLY_UPDATE', 'PRODUCE', 'SEMANTIC'].includes(relType)) return 'semantic';
  if (['READ', 'TEST', 'CREATE', 'UPDATE', 'DELETE', 'CLEAR', 'EMIT', 'WAIT', 'SUBSCRIBE', 'SIGNAL', 'START', 'CANCEL', 'DERIVE', 'FEED', 'PART'].includes(relType)) return 'resource';
  return 'control';
}

async function buildFeatureLoggingRequest({ loggingEnabled, reproPayload, reproPayloadJson }, { driver, database }) {
  if (!loggingEnabled) {
    return { loggingEnabled: false };
  }

  const resolvedReproPayload = parseJsonArg(reproPayload ?? reproPayloadJson, 'reproPayload');
  if (!resolvedReproPayload) {
    throw new Error('Logging launch requires reproPayload so config is recalculated from the current source graph.');
  }

  const effectiveLoggingPayload = await resolveFeatureLoggingPayload(driver, database, resolvedReproPayload);
  const derivedProfile = buildDerivedFeatureLoggingProfile(effectiveLoggingPayload);

  return {
    loggingEnabled: true,
    config: derivedProfile.resolvedConfig,
  };
}

function createRequestContext(baseContext) {
  return {
    ...baseContext,
    gatewayUrl: baseContext.baseUrl,
    orchestratorConfig: baseContext.orchestratorConfig,
  };
}

function createRuntimeRequestContext(baseContext) {
  return {
    ...createRequestContext(baseContext),
    runtimeStore: baseContext.getRuntimeStore(),
  };
}

function normalizeStringList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

function normalizeFeatureJsonPathInput(jsonPath) {
  return typeof jsonPath === 'string' && jsonPath.trim()
    ? jsonPath.trim()
    : DEFAULT_FEATURE_JSON_PATH;
}

function resolveFeatureLogsMode(body = {}) {
  const rawMode = String(body.logsMode || body.loggingMode || '').trim().toLowerCase();

  if (rawMode === 'with-logs' || rawMode === 'with_logs' || rawMode === 'logs' || rawMode === 'on' || rawMode === 'true') {
    return true;
  }

  if (rawMode === 'without-logs' || rawMode === 'without_logs' || rawMode === 'no-logs' || rawMode === 'off' || rawMode === 'false') {
    return false;
  }

  if (body.enableLogs !== undefined) {
    return Boolean(body.enableLogs);
  }

  return false;
}

function buildFeatureApiHints({ jsonPath, jsonPayload }) {
  const resolvedJsonPath = resolveFeatureJsonPath(jsonPath);
  const reproFilePath = jsonPayload?.repro?.filePath || null;
  const babelInstrumentationConfigPath = resolvedJsonPath === resolveFeatureJsonPath(DEFAULT_FEATURE_JSON_PATH)
    ? DEFAULT_FEATURE_PRIMARY_FUNCTION_SET_PATH
    : null;

  return {
    defaults: {
      featureName: 'tool-selection',
      jsonPath: DEFAULT_FEATURE_JSON_PATH,
      drawMode: 'runtime-chain',
      logsMode: 'without-logs',
    },
    featureHint: {
      label: 'tool selection',
      jsonPath: resolvedJsonPath,
      reproFilePath,
      babelInstrumentationConfigPath,
    },
    logging: {
      modes: ['without-logs', 'with-logs'],
      instrumentationSource: babelInstrumentationConfigPath,
      note: babelInstrumentationConfigPath
        ? `With logs, the function set is loaded from the static-draw JSON sidecar by default; ${babelInstrumentationConfigPath} is the primary source, and the legacy Babel-derived sidecar is used only to fill missing instrumentation metadata when needed.`
        : 'With logs, the function set is loaded from the local static-draw JSON sidecar.',
    },
    draw: {
      modes: ['runtime-chain'],
      note: 'Draw renders from the local FILE payload plus the latest Redis-backed runtime chains.',
    },
    runtimeNodeLogs: {
      method: 'POST',
      path: '/api/features/runtime-node-logs',
      note: 'Reads runtime node logs from Redis for an explicit sessionId instead of embedding them into run-repro responses.',
    },
  };
}

function buildFeatureRunReproStatusPayload(result, { enableLogs, jsonPath, hints }) {
  return {
    feature: result?.feature
      ? {
        stableId: result.feature.stableId || null,
        key: result.feature.key || null,
        name: result.feature.name || null,
      }
      : null,
    reproFilePath: result?.reproFilePath || null,
    logging: result?.logging
      ? {
        enabled: Boolean(result.logging.enabled),
        sessionId: result.logging.sessionId || null,
        source: result.logging.source || null,
        sourcePath: result.logging.sourcePath || null,
      }
      : {
        enabled: false,
        sessionId: null,
        source: null,
        sourcePath: null,
      },
    scenarioOk: Boolean(result?.scenarioOk),
    scenarioExitCode: result?.scenarioExitCode ?? null,
    scenarioSignal: result?.scenarioSignal || null,
    scenarioFailureKind: result?.scenarioFailureKind || null,
    scenarioFailureMessage: result?.scenarioFailureMessage || null,
    logsMode: enableLogs ? 'with-logs' : 'without-logs',
    jsonPath,
    hints,
  };
}

async function resolveFeatureRequest(driver, database, body = {}) {
  const jsonPath = normalizeFeatureJsonPathInput(body.jsonPath);
  const jsonPayload = readFeatureJsonPayload(jsonPath);
  const feature = await resolveFeatureEntity(driver, database, {
    name: body.name,
    headStableId: body.headStableId,
    tailStableIds: normalizeStringList(body.tailStableIds),
    jsonPath,
  });

  if (!feature?.stableId) {
    throw new Error(`Feature could not be resolved from ${resolveFeatureJsonPath(jsonPath)}.`);
  }

  return {
    feature,
    jsonPath,
    jsonPayload,
    hints: buildFeatureApiHints({ jsonPath, jsonPayload }),
  };
}

async function resolvePhaseRequest(driver, database, body = {}) {
  const phase = await resolvePhaseEntity(driver, database, {
    key: body.key || body.phaseKey,
  });

  return { phase };
}

async function loadGraphAnnotations(driver, database) {
  const annotations = await Fragment.loadAnnotations(driver, database);
  const currentProfilesById = new Map(Object.values(annotationProfileContract)
    .map((profile) => [profile.id, profile]));
  for (const [key, annotation] of Object.entries(annotations)) {
    const currentProfile = currentProfilesById.get(annotation.profileId);
    if (currentProfile && annotation.profileVersion !== currentProfile.version) delete annotations[key];
  }
  const session = driver.session({ database, defaultAccessMode: neo4j.session.READ });
  try {
    const declarationRows = await session.run(`
      MATCH (declaration:FnDeclaration)
      OPTIONAL MATCH (declaredFn:Fn {stableId: declaration.calleeStableId})-[:HAS_ANNOTATION]->(annotation:Annotation)
      WHERE annotation IS NULL OR annotation.status = 'ready' OR annotation.status IS NULL
      WITH declaration, annotation
      ORDER BY annotation.updatedAt DESC
      WITH declaration, collect(annotation)[0] AS annotation
      RETURN declaration.stableId AS key,
             annotation.text AS text,
             annotation.annotationKind AS annotationKind,
             annotation.annotationId AS annotationId,
             annotation.profileId AS profileId,
             annotation.profileVersion AS profileVersion,
             annotation.toolGitCommitShortHash AS toolGitCommitShortHash,
             annotation.maxDepth AS maxDepth,
             annotation.updatedAt AS updatedAt
    `);
    for (const record of declarationRows.records) {
      const key = record.get('key');
      const annotationId = record.get('annotationId');
      if (!annotationId) {
        if (annotations[key]?.annotationKind === 'Binding') delete annotations[key];
        continue;
      }
      annotations[key] = {
        text: record.get('text'),
        type: 'function',
        annotationKind: record.get('annotationKind') || 'Callable',
        annotationId,
        profileId: record.get('profileId') || null,
        profileVersion: record.get('profileVersion')?.toNumber?.() ?? record.get('profileVersion') ?? null,
        toolGitCommitShortHash: record.get('toolGitCommitShortHash') || null,
        maxDepth: record.get('maxDepth')?.toNumber?.() ?? record.get('maxDepth') ?? null,
        updatedAt: record.get('updatedAt') || null,
        storage: 'declared-callable-annotation',
        labels: ['FnDeclaration'],
      };
    }

    const edgeRows = await session.run(`
      MATCH (s)-[r]->(target)
      WHERE r.graph_annotation_text IS NOT NULL
        AND s.stableId IS NOT NULL
        AND target.stableId IS NOT NULL
      RETURN s.stableId + '->' + target.stableId AS key,
             s.stableId AS sourceStableId,
             r.graph_annotation_text AS text,
             r.graph_annotation_updated_at AS updatedAt,
             r.graph_annotation_tool_git_commit_short_hash AS toolGitCommitShortHash,
             r.graph_annotation_max_depth AS maxDepth,
             target.stableId AS targetFn,
             type(r) AS relType
    `);
    for (const record of edgeRows.records) {
      annotations[record.get('key')] = {
        text: record.get('text'),
        updatedAt: record.get('updatedAt') || null,
        toolGitCommitShortHash: record.get('toolGitCommitShortHash') || null,
        maxDepth: record.get('maxDepth')?.toNumber?.() ?? record.get('maxDepth') ?? null,
        storage: 'relationship',
        sourceStableId: record.get('sourceStableId') || null,
        targetFn: record.get('targetFn') || null,
        relType: record.get('relType') || null,
      };
    }
    return { ok: true, annotations };
  } finally {
    await session.close();
  }
}

async function upsertGraphAnnotation(driver, database, {
  kind,
  stableId,
  targetFn,
  text,
  source = 'codex',
  maxDepth,
} = {}) {
  const sourceStableId = String(stableId || '').trim();
  const targetStableId = String(targetFn || '').trim();
  const annotationText = validateAnnotationTextEncoding(text);
  const metadata = getAnnotationToolMetadata({ maxDepth });
  if (!sourceStableId || !annotationText) {
    throw new Error('stableId and text are required.');
  }
  if (kind === 'call-edge' && targetStableId) {
    const updatedAt = new Date().toISOString();
    const session = driver.session({ database });
    try {
      const result = await session.run(`
        MATCH (s {stableId: $stableId})-[r]->(target {stableId: $targetFn})
        SET r.graph_annotation_text = $text,
            r.graph_annotation_updated_at = $updatedAt,
            r.graph_annotation_source = $source,
            r.graph_annotation_tool_git_commit_short_hash = $toolGitCommitShortHash,
            r.graph_annotation_max_depth = $maxDepth
        RETURN count(r) AS updated
      `, {
        stableId: sourceStableId,
        targetFn: targetStableId,
        text: annotationText,
        updatedAt,
        source,
        ...metadata,
      });
      const updated = result.records[0]?.get('updated')?.toNumber?.() ?? 0;
      return {
        ok: true,
        storage: 'relationship',
        updated,
        stableId: sourceStableId,
        targetFn: targetStableId,
        ...metadata,
      };
    } finally {
      await session.close();
    }
  }

  return new Fragment({ driver, database, headID: sourceStableId })
    .upsertAnnotation(annotationText, { source, ...metadata });
}

async function loadGraphExternalAffectors(driver, database, {
  stableId,
  limit = 40,
} = {}) {
  const targetStableId = String(stableId || '').trim();
  if (!targetStableId) throw new Error('stableId is required.');
  const affectorsLimit = Math.max(1, Math.min(200, Number(limit) || 40));
  const affectorRelTypes = [
    'CREATE',
    'UPDATE',
    'DELETE',
    'CLEAR',
    'EMIT',
    'SIGNAL',
    'START',
    'CANCEL',
    'DERIVE',
    'SETS',
    'PROVIDES',
    'OVERRIDES',
    'CACHES',
    'FEEDS',
  ];
  const session = driver.session({ database });
  try {
    const result = await session.run(`
      MATCH (target {stableId: $stableId})
      OPTIONAL MATCH (target)-[:PART]->(parentTarget)
      OPTIONAL MATCH (parentByStableId {stableId: target.parentStableId})
      WITH target, [node IN [target, parentTarget, parentByStableId] WHERE node IS NOT NULL] AS effectiveTargets
      UNWIND effectiveTargets AS effectiveTarget
      OPTIONAL MATCH (actor)-[rel]->(effectiveTarget)
      WHERE actor.stableId IS NOT NULL
        AND type(rel) IN $affectorRelTypes
      OPTIONAL MATCH (owner:Fn {stableId: actor.parentFnStableId})
      WITH target, effectiveTarget, actor, rel, owner
      ORDER BY coalesce(actor.line, actor.startLine, 0), coalesce(actor.column, actor.startColumn, 0), actor.stableId, type(rel)
      OPTIONAL MATCH (reader)-[readRel:READ]->(target)
      WHERE reader.stableId IS NOT NULL
      RETURN
        target {
          .stableId,
          labels: labels(target),
          props: properties(target)
        } AS target,
        collect(DISTINCT {
          targetStableId: effectiveTarget.stableId,
          relType: type(rel),
          relProps: properties(rel),
          actor: actor {
            .stableId,
            labels: labels(actor),
            props: properties(actor)
          },
          ownerFn: CASE WHEN owner IS NULL THEN null ELSE owner {
            .stableId,
            .name,
            .label,
            .repo_relative_path
          } END
        })[..$limit] AS affectors,
        count(DISTINCT readRel) AS readCount,
        collect(DISTINCT reader.stableId)[..10] AS readSamples
    `, { stableId: targetStableId, limit: neo4j.int(affectorsLimit), affectorRelTypes });
    const record = result.records[0];
    if (!record) throw new Error(`Graph node was not found: ${targetStableId}`);
    const target = record.get('target');
    const affectors = (record.get('affectors') || [])
      .filter((item) => item?.relType && item?.actor?.stableId)
      .map((item) => ({
        relType: item.relType,
        targetStableId: item.targetStableId || null,
        relProps: plainNeo4jProperties(item.relProps),
        actor: {
          stableId: item.actor.stableId,
          labels: item.actor.labels || [],
          props: plainNeo4jProperties(item.actor.props),
        },
        ownerFn: item.ownerFn ? {
          stableId: item.ownerFn.stableId || null,
          name: item.ownerFn.name || item.ownerFn.label || null,
          repoRelativePath: item.ownerFn.repo_relative_path || null,
        } : null,
      }));
    return {
      ok: true,
      stableId: targetStableId,
      target: {
        stableId: target.stableId,
        labels: target.labels || [],
        props: plainNeo4jProperties(target.props),
      },
      affectorCount: affectors.length,
      affectorRelTypes,
      affectors,
      readCount: neo4jNumberToNumber(record.get('readCount') || 0),
      readSamples: record.get('readSamples') || [],
      notes: [
        'Affectors intentionally exclude READ and PART. For cell nodes they include creation or mutation of the parent store reached through PART.',
        'If affectorCount is 0, the current graph does not show where this external node is created or changed.',
        'For code-backed actors, open actor.stableId or ownerFn.stableId to inspect source code when needed.',
      ],
    };
  } finally {
    await session.close();
  }
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, (char) => `&#x${char.codePointAt(0).toString(16).toUpperCase()};`);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveDiagramPath(diagramPath) {
  const rawPath = String(diagramPath || '').trim();
  if (!rawPath) throw new Error('diagramPath is required.');
  const root = process.cwd();
  const resolved = path.resolve(root, rawPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`diagramPath must stay inside workspace: ${rawPath}`);
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`Diagram file was not found: ${resolved}`);
  }
  return resolved;
}

function findMxCellXml(xml, element = {}) {
  const cellId = String(element.cellId || '').trim();
  if (cellId) {
    const match = xml.match(new RegExp(`<mxCell\\b[^>]*\\bid="${escapeRegExp(cellId)}"[^>]*(?:/>|>[\\s\\S]*?</mxCell>)`));
    if (match) return match[0];
  }

  const stableId = String(element.stableId || '').trim();
  if (stableId) {
    const match = xml.match(new RegExp(`<mxCell\\b[^>]*\\bstableId="${escapeRegExp(stableId)}"[^>]*(?:/>|>[\\s\\S]*?</mxCell>)`));
    if (match) return match[0];
  }

  return null;
}

function readMxGeometry(cellXml) {
  const geometryMatch = String(cellXml || '').match(/<mxGeometry\b[^>]*\bas="geometry"[^>]*>/);
  if (!geometryMatch) return {};
  const attrs = {};
  for (const [, name, value] of geometryMatch[0].matchAll(/\b([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
    attrs[name] = value;
  }
  return {
    x: Number(attrs.x),
    y: Number(attrs.y),
    width: Number(attrs.width),
    height: Number(attrs.height),
  };
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function estimateWrappedLineCount(text, maxCharsPerLine) {
  const normalizedMax = Math.max(12, Math.floor(maxCharsPerLine));
  let lineCount = 0;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const words = rawLine.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      lineCount += 1;
      continue;
    }
    let currentLength = 0;
    for (const word of words) {
      const wordLength = Array.from(word).length;
      if (currentLength === 0) {
        currentLength = wordLength;
      } else if (currentLength + 1 + wordLength <= normalizedMax) {
        currentLength += 1 + wordLength;
      } else {
        lineCount += 1;
        currentLength = wordLength;
      }
      while (currentLength > normalizedMax) {
        lineCount += 1;
        currentLength -= normalizedMax;
      }
    }
    lineCount += 1;
  }
  return Math.max(1, lineCount);
}

function measureDrawioAnnotation(text, { maxHeight = Number.POSITIVE_INFINITY } = {}) {
  const fontSize = 14;
  const minWidth = 180;
  const maxWidth = 680;
  const widthStep = 8;
  const horizontalPadding = 16;
  const verticalPadding = 12;
  const lineHeight = 18;
  const compactHeight = Math.min(maxHeight, 72);
  let measurement = { width: maxWidth, height: 40 };

  for (let width = minWidth; width <= maxWidth; width += widthStep) {
    const averageCharacterWidth = fontSize * 0.61;
    const maxCharsPerLine = Math.max(22, Math.floor((width - horizontalPadding) / averageCharacterWidth));
    const lineCount = estimateWrappedLineCount(text, maxCharsPerLine);
    const height = Math.max(40, verticalPadding + lineCount * lineHeight);
    measurement = { width, height };
    if (height <= compactHeight) return measurement;
  }

  return measurement;
}

async function loadGraphAnnotation(driver, database, { stableId, targetStableId } = {}) {
  const requestedStableId = String(stableId || '').trim();
  const requestedTargetStableId = String(targetStableId || '').trim();
  if (!requestedStableId) return { ok: true, annotation: null };
  const session = driver.session({ database, defaultAccessMode: neo4j.session.READ });
  try {
    if (requestedTargetStableId) {
      const edgeResult = await session.run(`
        MATCH (source {stableId: $stableId})-[relation]->(target {stableId: $targetStableId})
        WHERE relation.graph_annotation_text IS NOT NULL
        RETURN relation.graph_annotation_text AS text,
               relation.graph_annotation_updated_at AS updatedAt,
               relation.graph_annotation_tool_git_commit_short_hash AS toolGitCommitShortHash,
               relation.graph_annotation_max_depth AS maxDepth,
               type(relation) AS relType
        ORDER BY relation.graph_annotation_updated_at DESC
        LIMIT 1
      `, { stableId: requestedStableId, targetStableId: requestedTargetStableId });
      const edge = edgeResult.records[0];
      return { ok: true, annotation: edge ? {
        text: edge.get('text'),
        updatedAt: edge.get('updatedAt') || null,
        toolGitCommitShortHash: edge.get('toolGitCommitShortHash') || null,
        maxDepth: edge.get('maxDepth')?.toNumber?.() ?? edge.get('maxDepth') ?? null,
        storage: 'relationship',
        relType: edge.get('relType') || null,
      } : null };
    }
    let result = await session.run(`
      MATCH (annotation:Annotation {headID: $stableId})
      WHERE annotation.status = 'ready' OR annotation.status IS NULL
      WITH annotation
      ORDER BY annotation.updatedAt DESC
      RETURN annotation.text AS text,
             annotation.annotationKind AS annotationKind,
             annotation.annotationId AS annotationId,
             annotation.profileId AS profileId,
             annotation.profileVersion AS profileVersion,
             annotation.toolGitCommitShortHash AS toolGitCommitShortHash,
             annotation.maxDepth AS maxDepth,
             annotation.updatedAt AS updatedAt
      LIMIT 1
    `, { stableId: requestedStableId });
    if (!result.records.length) {
      result = await session.run(`
        MATCH (requested:FnDeclaration {stableId: $stableId})
        MATCH (declaredFn:Fn {stableId: requested.calleeStableId})-[:HAS_ANNOTATION]->(annotation:Annotation)
        WHERE annotation.status = 'ready' OR annotation.status IS NULL
        WITH annotation
        ORDER BY annotation.updatedAt DESC
        RETURN annotation.text AS text,
               annotation.annotationKind AS annotationKind,
               annotation.annotationId AS annotationId,
               annotation.profileId AS profileId,
               annotation.profileVersion AS profileVersion,
               annotation.toolGitCommitShortHash AS toolGitCommitShortHash,
               annotation.maxDepth AS maxDepth,
               annotation.updatedAt AS updatedAt
        LIMIT 1
      `, { stableId: requestedStableId });
    }
    const record = result.records[0];
    const annotationId = record?.get('annotationId');
    if (!annotationId) return { ok: true, annotation: null };
    const profileId = record.get('profileId') || null;
    const profileVersion = record.get('profileVersion')?.toNumber?.() ?? record.get('profileVersion') ?? null;
    const currentProfile = Object.values(annotationProfileContract).find((profile) => profile.id === profileId);
    if (currentProfile && profileVersion !== currentProfile.version) return { ok: true, annotation: null };
    return { ok: true, annotation: {
      text: record.get('text'),
      annotationKind: record.get('annotationKind') || null,
      annotationId,
      profileId,
      profileVersion,
      toolGitCommitShortHash: record.get('toolGitCommitShortHash') || null,
      maxDepth: record.get('maxDepth')?.toNumber?.() ?? record.get('maxDepth') ?? null,
      updatedAt: record.get('updatedAt') || null,
      storage: 'database',
      labels: [],
    } };
  } finally {
    await session.close();
  }
}

function removeExistingDrawioAnnotationsForTarget(xml, targetId) {
  const annotationIds = new Set();
  const removedCellIds = new Set();
  const cellPattern = /\n?\s*<mxCell\b[\s\S]*?<\/mxCell>/g;
  let match;
  while ((match = cellPattern.exec(xml))) {
    const cellXml = match[0];
    const source = cellXml.match(/\bsource="([^"]+)"/)?.[1];
    const target = cellXml.match(/\btarget="([^"]+)"/)?.[1];
    const id = cellXml.match(/\bid="([^"]+)"/)?.[1];
    const directAnnotationId = cellXml.match(/\bannotationTargetId="([^"]+)"/)?.[1] === targetId
      && id?.startsWith('annotation-') ? id : null;
    const annotationId = directAnnotationId || (source === targetId && target?.startsWith('annotation-')
      ? target
      : target === targetId && source?.startsWith('annotation-')
        ? source
        : null);
    if (annotationId) {
      annotationIds.add(annotationId);
      if (id) removedCellIds.add(id);
    }
  }
  for (const annotationId of annotationIds) {
    removedCellIds.add(annotationId);
  }
  const nextXml = xml.replace(cellPattern, (cellXml) => {
    const id = cellXml.match(/\bid="([^"]+)"/)?.[1];
    return id && removedCellIds.has(id) ? '' : cellXml;
  });
  return { xml: nextXml, removedAnnotationIds: Array.from(annotationIds) };
}

export function insertDrawioAnnotation({
  diagramPath,
  element = {},
  annotationText,
  annotationMetadata = {},
  replaceExistingForTarget = false,
} = {}) {
  const text = validateAnnotationTextEncoding(annotationText);

  const absolutePath = resolveDiagramPath(diagramPath);
  let xml = fs.readFileSync(absolutePath, 'utf8');
  const rootCloseIndex = xml.indexOf('</root>');
  if (rootCloseIndex < 0) {
    throw new Error(`Diagram root close tag was not found: ${absolutePath}`);
  }

  const targetCellXml = findMxCellXml(xml, element);
  if (!targetCellXml) {
    throw new Error(`Target diagram element was not found: ${element.cellId || element.stableId || '<empty>'}`);
  }
  const targetId = targetCellXml.match(/\bid="([^"]+)"/)?.[1];
  if (!targetId) throw new Error('Target diagram element has no mxCell id.');

  let removedAnnotationIds = [];
  if (replaceExistingForTarget) {
    const cleanup = removeExistingDrawioAnnotationsForTarget(xml, targetId);
    xml = cleanup.xml;
    removedAnnotationIds = cleanup.removedAnnotationIds;
  }

  let nextRootCloseIndex = xml.indexOf('</root>');
  if (nextRootCloseIndex < 0) {
    throw new Error(`Diagram root close tag was not found after cleanup: ${absolutePath}`);
  }

  const refreshedTargetCellXml = findMxCellXml(xml, { cellId: targetId }) || targetCellXml;
  const stepRowXml = findStepRowForCell(xml, refreshedTargetCellXml);
  if (!stepRowXml) {
    throw new Error(`Target diagram element is not contained by a Step row: ${targetId}`);
  }
  const stepRowId = readMxCellAttribute(stepRowXml, 'id');
  const stepGeometry = readMxGeometry(stepRowXml);
  const storedBaseWidth = Number(readMxCellAttribute(stepRowXml, 'annotationBaseWidth'));
  const stepBaseWidth = Number.isFinite(storedBaseWidth) && storedBaseWidth > 0
    ? storedBaseWidth
    : firstFiniteNumber(stepGeometry.width, 160);
  const stepHeight = firstFiniteNumber(stepGeometry.height, 80);
  const verticalFramePadding = 4;
  const { width: annotationWidth, height: annotationHeight } = measureDrawioAnnotation(text, {
    maxHeight: Math.max(36, stepHeight - verticalFramePadding * 2),
  });
  const relativeTarget = readRelativeGeometryWithinAncestor(xml, refreshedTargetCellXml, stepRowId);
  const horizontalGap = 24;
  const framePadding = 24;
  const annotationX = stepBaseWidth + horizontalGap;
  const maxAnnotationY = Math.max(verticalFramePadding, stepHeight - annotationHeight - verticalFramePadding);
  const annotationY = Math.max(verticalFramePadding, Math.min(relativeTarget.y, maxAnnotationY));
  const expandedStepWidth = annotationX + annotationWidth + framePadding;
  let expandedStepRowXml = setMxCellAttribute(stepRowXml, 'annotationBaseWidth', stepBaseWidth);
  expandedStepRowXml = setMxGeometryAttribute(expandedStepRowXml, 'width', expandedStepWidth);
  xml = xml.replace(stepRowXml, expandedStepRowXml);
  nextRootCloseIndex = xml.indexOf('</root>');

  const baseId = `annotation-${Date.now().toString(36)}`;
  let annotationId = baseId;
  let suffix = 1;
  while (xml.includes(`id="${annotationId}"`)) {
    annotationId = `${baseId}-${suffix}`;
    suffix += 1;
  }

  const annotationCell = [
    `  <mxCell id="${escapeXml(annotationId)}" annotationTargetId="${escapeXml(targetId)}" annotationSavedText="${escapeXml(text)}" graphKind="Annotation" annotationToolGitCommitShortHash="${escapeXml(annotationMetadata.toolGitCommitShortHash || '')}" annotationMaxDepth="${escapeXml(annotationMetadata.maxDepth ?? '')}" value="${escapeXml(text)}" style="rounded=1;whiteSpace=wrap;html=1;overflow=fill;fillColor=#f5f5f5;strokeColor=#b3b3b3;fontSize=14;align=center;verticalAlign=top;spacing=6;resizable=1;editable=1;" vertex="1" parent="${escapeXml(stepRowId)}">`,
    `    <mxGeometry x="${annotationX}" y="${annotationY}" width="${annotationWidth}" height="${annotationHeight}" as="geometry" />`,
    '  </mxCell>',
  ].join('\n');
  const edgeId = `${annotationId}-link`;
  const annotationEdge = [
    `  <mxCell id="${escapeXml(edgeId)}" annotationLink="1" annotationTargetId="${escapeXml(targetId)}" value="" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;strokeColor=#999999;strokeWidth=1.5;" edge="1" visible="0" parent="${escapeXml(stepRowId)}" source="${escapeXml(annotationId)}" target="${escapeXml(targetId)}">`,
    '    <mxGeometry relative="1" as="geometry" />',
    '  </mxCell>',
  ].join('\n');

  const nextXml = `${xml.slice(0, nextRootCloseIndex)}${annotationCell}\n${annotationEdge}\n${xml.slice(nextRootCloseIndex)}`;
  fs.writeFileSync(absolutePath, nextXml, 'utf8');
  return {
    ok: true,
    diagramPath: absolutePath,
    targetId,
    stepRowId,
    annotationId,
    edgeId,
    removedAnnotationIds,
  };
}

function prepareDrawioAnnotationUpdate({ diagramPath, annotationCellId, annotationText } = {}) {
  const text = validateAnnotationTextEncoding(annotationText);
  const cellId = String(annotationCellId || '').trim();
  if (!cellId) throw new Error('annotationCellId is required.');

  const absolutePath = resolveDiagramPath(diagramPath);
  const xml = fs.readFileSync(absolutePath, 'utf8');
  const annotationCellXml = findMxCellXml(xml, { cellId });
  if (!annotationCellXml || readMxCellAttribute(annotationCellXml, 'graphKind') !== 'Annotation') {
    throw new Error(`Annotation diagram element was not found: ${cellId}`);
  }
  const targetId = readMxCellAttribute(annotationCellXml, 'annotationTargetId');
  if (!targetId || !findMxCellXml(xml, { cellId: targetId })) {
    throw new Error(`Annotation target diagram element was not found: ${targetId || '<empty>'}`);
  }

  let updatedCellXml = setMxCellAttribute(annotationCellXml, 'value', text);
  updatedCellXml = setMxCellAttribute(updatedCellXml, 'annotationSavedText', text);
  return {
    absolutePath,
    annotationCellId: cellId,
    targetId,
    text,
    xml: xml.replace(annotationCellXml, updatedCellXml),
  };
}

export function updateDrawioAnnotation(request = {}) {
  const prepared = prepareDrawioAnnotationUpdate(request);
  fs.writeFileSync(prepared.absolutePath, prepared.xml, 'utf8');
  return {
    ok: true,
    diagramPath: prepared.absolutePath,
    annotationCellId: prepared.annotationCellId,
    targetId: prepared.targetId,
    text: prepared.text,
  };
}

async function updateStoredDrawioAnnotation(driver, database, request = {}) {
  const prepared = prepareDrawioAnnotationUpdate(request);
  const persisted = await upsertGraphAnnotation(driver, database, {
    kind: request.kind,
    stableId: request.stableId,
    targetFn: request.targetFn,
    text: prepared.text,
    source: request.source || 'manual-edit',
    maxDepth: request.maxDepth,
  });
  fs.writeFileSync(prepared.absolutePath, prepared.xml, 'utf8');
  return {
    ok: true,
    persisted,
    diagramPath: prepared.absolutePath,
    annotationCellId: prepared.annotationCellId,
    targetId: prepared.targetId,
    text: prepared.text,
  };
}

function finalizeAnnotationWorkflow(result) {
  const clientContext = result?.clientContext;
  if (result?.status !== 'ready' || !clientContext?.diagramPath) return result;
  return {
    ...result,
    diagramInsertion: insertDrawioAnnotation({
      diagramPath: clientContext.diagramPath,
      element: clientContext.element || {},
      annotationText: result.annotation,
      annotationMetadata: result.annotationMetadata || {},
      replaceExistingForTarget: true,
    }),
  };
}

function readMxCellAttribute(cellXml, name) {
  return String(cellXml || '').match(new RegExp(`\\b${escapeRegExp(name)}="([^"]*)"`))?.[1] || '';
}

function setMxCellAttribute(cellXml, name, value) {
  const attribute = `${name}="${escapeXml(value)}"`;
  const pattern = new RegExp(`\\s${escapeRegExp(name)}="[^"]*"`);
  if (pattern.test(cellXml)) return cellXml.replace(pattern, ` ${attribute}`);
  return cellXml.replace(/<mxCell\b/, `<mxCell ${attribute}`);
}

function setMxGeometryAttribute(cellXml, name, value) {
  const geometryMatch = String(cellXml || '').match(/<mxGeometry\b[^>]*\bas="geometry"[^>]*>/);
  if (!geometryMatch) return cellXml;
  const pattern = new RegExp(`\\s${escapeRegExp(name)}="[^"]*"`);
  const nextGeometry = pattern.test(geometryMatch[0])
    ? geometryMatch[0].replace(pattern, ` ${name}="${value}"`)
    : geometryMatch[0].replace(/\s+as="geometry"/, ` ${name}="${value}" as="geometry"`);
  return cellXml.replace(geometryMatch[0], nextGeometry);
}

function findStepRowForCell(xml, cellXml) {
  let current = cellXml;
  for (let depth = 0; current && depth < 12; depth += 1) {
    const id = readMxCellAttribute(current, 'id');
    if (id.startsWith('fold-row-')) return current;
    const parentId = readMxCellAttribute(current, 'parent');
    if (!parentId) return null;
    current = findMxCellXml(xml, { cellId: parentId });
  }
  return null;
}

function readRelativeGeometryWithinAncestor(xml, cellXml, ancestorId) {
  let x = 0;
  let y = 0;
  let current = cellXml;
  for (let depth = 0; current && depth < 12; depth += 1) {
    const id = readMxCellAttribute(current, 'id');
    if (id === ancestorId) return { x, y };
    const geometry = readMxGeometry(current);
    x += firstFiniteNumber(geometry.x);
    y += firstFiniteNumber(geometry.y);
    const parentId = readMxCellAttribute(current, 'parent');
    if (!parentId) break;
    current = findMxCellXml(xml, { cellId: parentId });
  }
  return { x: 0, y: 0 };
}

async function handleGet(requestUrl, response, context) {
  const { searchParams, pathname } = requestUrl;
  if (pathname === '/api/annotations/helpers-context') {
    sendJson(response, 200, await loadHelpersContext());
    return;
  }
  if (pathname === '/api/annotations/input-context') {
    sendJson(response, 200, await loadInputContext());
    return;
  }
  if (pathname === '/api/annotations/visualizer') {
    const result = replayLaunch(searchParams.get('stableId'), context.baseUrl);
    sendJson(response, result.status, result.body);
    return;
  }
  if (pathname === '/annotation-plan' || pathname.startsWith('/annotation-plan/assets/')) {
    serveAnnotationPlanUi(pathname, response);
    return;
  }
  if (pathname === '/api/annotations/graphql/schema') {
    sendJson(response, 200, { sdl: annotationSchemaSDL });
    return;
  }

  if (pathname === '/') {
    sendJson(response, 200, getOrchestratorLanding(context.baseUrl));
    return;
  }

  if (pathname === '/ui-explorer') {
    sendHtml(response, 200, renderUiExplorerPage(context.baseUrl));
    return;
  }

  // Documentation is generated from the same API contract used by the status
  // catalog. /swagger remains a discoverable compatibility alias.
  if (pathname === '/api/docs' || pathname === '/swagger') {
    sendHtml(response, 200, renderSwaggerUi(context.baseUrl));
    return;
  }

  // Swagger assets are local so API documentation works without internet
  // access. They are implementation resources, not OpenAPI operations.
  if (pathname === '/api/docs/assets/swagger-ui.css') {
    sendStaticFile(response, path.join(SWAGGER_UI_DIST_PATH, 'swagger-ui.css'), 'text/css; charset=utf-8');
    return;
  }

  if (pathname === '/api/docs/assets/swagger-ui-bundle.js') {
    sendStaticFile(response, path.join(SWAGGER_UI_DIST_PATH, 'swagger-ui-bundle.js'), 'text/javascript; charset=utf-8');
    return;
  }

  if (pathname === '/api/openapi.json') {
    sendJson(response, 200, buildOpenApiDocument(context.baseUrl));
    return;
  }

  if (pathname === '/api/docs/audit') {
    sendJson(response, 200, buildApiContractAudit());
    return;
  }

  if (pathname === '/health') {
    await context.driver.verifyConnectivity();
    sendJson(response, 200, {
      ok: true,
      database: context.database,
      uri: context.uri,
    });
    return;
  }

  if (pathname === '/api/status/gateway') {
    sendJson(response, 200, {
      ...getOrchestratorStatus(context.baseUrl),
      extractStatus: getExtractStatus({
        tailLog: searchParams.get('tailLog') === '1' || searchParams.get('tailLog') === 'true',
      }),
    });
    return;
  }

  if (pathname === '/api/knowledge/orchestrator') {
    sendJson(response, 200, getOrchestratorGuide(context.baseUrl));
    return;
  }

  if (pathname === '/api/knowledge/restart-orchestrator') {
    sendJson(response, 200, getOrchestratorRestartRunbook(context.baseUrl));
    return;
  }

  if (pathname === '/api/graph/annotation-profiles') {
    sendJson(response, 200, { ok: true, profiles: annotationProfileContract });
    return;
  }

  if (pathname === '/api/status/ordinary-dev-server') {
    sendJson(response, 200, await getOrdinaryDevServerStatus());
    return;
  }

  if (pathname === '/api/status/neo4j') {
    sendJson(response, 200, await getInfraServiceStatus('NEO4J', createRequestContext(context)));
    return;
  }

  if (pathname === '/api/status/playwright-devops') {
    sendJson(response, 200, await getPlaywrightDevopsStatus());
    return;
  }

  if (pathname === '/api/status/mocked-dev-server') {
    sendJson(response, 200, await getMockedDevServerStatus());
    return;
  }

  if (pathname === '/api/status/reverse-observation') {
    sendJson(response, 200, await getReverseReadyForObservation());
    return;
  }

  if (pathname === '/api/status/runtime-ingestion') {
    sendJson(response, 200, await getRuntimeIngestionReadiness(createRuntimeRequestContext(context)));
    return;
  }

  if (pathname === '/api/status/infra-readiness') {
    sendJson(response, 200, await getInfraReadiness(createRequestContext(context)));
    return;
  }

  if (pathname === '/api/status/repro-monitor') {
    const tailLines = Math.max(1, Math.min(Number(searchParams.get('tailLines')) || 12, 100));
    sendJson(response, 200, await getGraphReproMonitorStatus(createRequestContext(context), { tailLines }));
    return;
  }

  if (pathname === '/api/status/process-diagnostics' || pathname === '/api/status/processes') {
    const tailLines = Math.max(1, Math.min(Number(searchParams.get('tailLines')) || 20, 100));
    sendJson(response, 200, await getProcessDiagnosticsStatus(createRequestContext(context), { tailLines }));
    return;
  }

  if (pathname === '/api/extract/status') {
    sendJson(response, 200, getExtractStatus({
      tailLog: searchParams.get('tailLog') === '1' || searchParams.get('tailLog') === 'true',
    }));
    return;
  }

  const annotationJobMatch = pathname.match(/^\/api\/annotation-jobs\/([^/]+)$/);
  if (annotationJobMatch) {
    sendJson(response, 200, await getAnnotationJob(context.driver, context.database, {
      jobId: decodeURIComponent(annotationJobMatch[1]),
    }));
    return;
  }

  if (pathname === '/api/extract/plan') {
    sendJson(response, 200, { ok: true, plan: getExtractPlan() });
    return;
  }

  if (pathname === '/api/extract/preflight') {
    const preflight = getExtractPreflight({ mode: searchParams.get('mode') || 'func' });
    let neo4j;
    try {
      await context.driver.verifyConnectivity();
      neo4j = { ready: true, database: context.database, uri: context.uri };
    } catch (error) {
      neo4j = { ready: false, database: context.database, uri: context.uri, error: error.message };
    }
    sendJson(response, 200, {
      ...preflight,
      ready: preflight.ready && neo4j.ready,
      checks: { ...preflight.checks, neo4j },
    });
    return;
  }

  if (pathname === '/api/graph/annotations') {
    const stableId = searchParams.get('stableId');
    sendJson(response, 200, stableId
      ? await loadGraphAnnotation(context.driver, context.database, {
          stableId,
          targetStableId: searchParams.get('targetStableId'),
        })
      : await loadGraphAnnotations(context.driver, context.database));
    return;
  }

  if (pathname === '/api/ui-explorer/roots') {
    sendJson(response, 200, await loadUiExplorerRoots(context.driver, context.database));
    return;
  }

  if (pathname === '/api/ui-explorer/top-blocks') {
    sendJson(response, 200, await loadUiExplorerTopBlocks(context.driver, context.database));
    return;
  }

  if (pathname === '/api/ui-explorer/children') {
    const surfaceKey = searchParams.get('surfaceKey');
    const parentSurfaceKey = searchParams.get('parentSurfaceKey');
    if (!surfaceKey) {
      throw new Error('surfaceKey is required for /api/ui-explorer/children.');
    }

    sendJson(response, 200, await loadUiExplorerChildren(context.driver, context.database, surfaceKey, parentSurfaceKey));
    return;
  }

  if (pathname === '/api/ui-explorer/surface') {
    const surfaceKey = searchParams.get('surfaceKey');
    if (!surfaceKey) {
      throw new Error('surfaceKey is required for /api/ui-explorer/surface.');
    }

    sendJson(response, 200, await loadUiExplorerSurface(context.driver, context.database, surfaceKey));
    return;
  }

  if (pathname === '/api/ui-explorer/affordance-flow') {
    const affordanceKey = searchParams.get('affordanceKey');
    if (!affordanceKey) {
      throw new Error('affordanceKey is required for /api/ui-explorer/affordance-flow.');
    }

    sendJson(response, 200, await loadUiExplorerAffordanceFlow(context.driver, context.database, affordanceKey));
    return;
  }

  if (pathname === '/api/ui-explorer/object-functions') {
    sendJson(response, 200, await loadUiExplorerObjectFunctions(context.driver, context.database, {
      objectKey: searchParams.get('objectKey'),
      familyKey: searchParams.get('familyKey'),
    }));
    return;
  }

  if (pathname === '/api/ui-explorer/objects') {
    sendJson(response, 200, await loadUiExplorerObjectCatalog(context.driver, context.database));
    return;
  }

  if (pathname === '/api/ui-explorer/object-paths') {
    sendJson(response, 200, await loadUiExplorerObjectPaths(context.driver, context.database, {
      objectKey: searchParams.get('objectKey'),
      familyKey: searchParams.get('familyKey'),
    }));
    return;
  }

  if (pathname === '/api/ui-explorer/modal-strict-diagnostics') {
    sendJson(response, 200, await loadUiExplorerModalStrictDiagnostics(context.driver, context.database, {
      objectKey: searchParams.get('objectKey'),
    }));
    return;
  }

  sendJson(response, 404, {
    ok: false,
    error: `Unknown GET route: ${pathname}`,
  });
}

async function handlePost(requestUrl, request, response, context) {
  const { pathname } = requestUrl;
  const body = await readJsonBody(request);
  if (pathname === '/api/annotations/graphql') {
    sendJson(response, 200, await executeAnnotationGraphql(body, context));
    return;
  }

  if (pathname === '/api/features/get') {
    const featureRequest = await resolveFeatureRequest(context.driver, context.database, body);
    sendJson(response, 200, featureRequest);
    return;
  }

  if (pathname === '/api/phases/get') {
    const phaseRequest = await resolvePhaseRequest(context.driver, context.database, body);
    sendJson(response, 200, phaseRequest);
    return;
  }

  if (pathname === '/api/graph/annotations/upsert') {
    sendJson(response, 200, await upsertGraphAnnotation(context.driver, context.database, body));
    return;
  }

  if (pathname === '/api/graph/annotations/resolve') {
    sendJson(response, 200, await resolveAnnotation(context.driver, context.database, body));
    return;
  }

  if (pathname === '/api/graph/annotations/complete') {
    sendJson(response, 200, await completeAnnotation(context.driver, context.database, body));
    return;
  }

  if (pathname === '/api/graph/annotations/workflow/start') {
    const result = await startAnnotationWorkflow(context.driver, context.database, body);
    sendJson(response, 200, finalizeAnnotationWorkflow(result));
    return;
  }

  if (pathname === '/api/annotation-jobs') {
    const result = await startAnnotationWorkflow(context.driver, context.database, body);
    sendJson(response, 200, finalizeAnnotationWorkflow(result));
    return;
  }

  const annotationLeaseMatch = pathname.match(/^\/api\/annotation-jobs\/([^/]+)\/lease-next$/);
  if (annotationLeaseMatch) {
    sendJson(response, 200, await leaseNextAnnotationTask(context.driver, context.database, {
      jobId: decodeURIComponent(annotationLeaseMatch[1]),
    }));
    return;
  }

  const annotationTaskMatch = pathname.match(/^\/api\/annotation-tasks\/([^/]+)\/complete$/);
  if (annotationTaskMatch) {
    const result = await completeAnnotationWorkflow(context.driver, context.database, {
      ...body,
      taskId: decodeURIComponent(annotationTaskMatch[1]),
    });
    sendJson(response, 200, finalizeAnnotationWorkflow(result));
    return;
  }

  if (pathname === '/api/graph/annotations/workflow/complete') {
    const result = await completeAnnotationWorkflow(context.driver, context.database, body);
    sendJson(response, 200, finalizeAnnotationWorkflow(result));
    return;
  }

  if (pathname === '/api/graph/external-affectors') {
    sendJson(response, 200, await loadGraphExternalAffectors(context.driver, context.database, body));
    return;
  }

  if (pathname === '/api/actions/import-functions') {
    sendJson(response, 200, await importFunctionsScoped(body));
    return;
  }

  if (pathname === '/api/diagrams/annotations/insert') {
    sendJson(response, 200, insertDrawioAnnotation(body));
    return;
  }

  if (pathname === '/api/diagrams/annotations/update') {
    sendJson(response, 200, await updateStoredDrawioAnnotation(context.driver, context.database, body));
    return;
  }

  if (pathname === '/api/phases/path-graph') {
    const phaseRequest = await resolvePhaseRequest(context.driver, context.database, body);
    const pathGraph = await loadPhasePathGraphData(context.driver, context.database, phaseRequest.phase);
    sendJson(response, 200, {
      available: pathGraph.available,
      error: pathGraph.error,
      phase: pathGraph.phase,
      headStableId: pathGraph.headStableId,
      tailStableId: pathGraph.tailStableId,
      pathCount: pathGraph.pathCount,
      nodeCount: pathGraph.nodeCount,
      edgeCount: pathGraph.edgeCount,
      paths: pathGraph.paths,
    });
    return;
  }

  if (pathname === '/api/phases/path-graph-draw') {
    const phaseRequest = await resolvePhaseRequest(context.driver, context.database, body);
    const pathGraph = await loadPhasePathGraphData(context.driver, context.database, phaseRequest.phase);
    const result = buildPhasePathGraphDrawDiagram(phaseRequest.phase, pathGraph);
    sendJson(response, 200, {
      ...result,
      pathGraph: {
        available: pathGraph.available,
        error: pathGraph.error,
        pathCount: pathGraph.pathCount,
        nodeCount: pathGraph.nodeCount,
        edgeCount: pathGraph.edgeCount,
      },
    });
    return;
  }

  if (pathname === '/api/phases/swimlane-draw') {
    const phaseRequest = await resolvePhaseRequest(context.driver, context.database, body);
    const pathGraph = await loadPhasePathGraphData(context.driver, context.database, phaseRequest.phase);
    const result = buildPhaseSwimlaneDrawDiagram(phaseRequest.phase, pathGraph);
    sendJson(response, 200, {
      ...result,
      pathGraph: {
        available: pathGraph.available,
        error: pathGraph.error,
        pathCount: pathGraph.pathCount,
        nodeCount: pathGraph.nodeCount,
        edgeCount: pathGraph.edgeCount,
      },
    });
    return;
  }

  if (pathname === '/api/functions/flow-draw') {
    const result = buildFunctionFlowDrawDiagram({
      fnStableId: body.fnStableId || body.stableId,
      outputPath: body.outputPath,
      source: body.source,
      rangeStart: body.rangeStart,
      rangeEnd: body.rangeEnd,
      stageLabel: body.stageLabel,
    });
    sendJson(response, 200, result);
    return;
  }

  if (pathname === '/api/functions/flow-graph') {
    sendJson(response, 200, await loadFunctionFlowGraph(context.driver, context.database, {
      fnStableId: body.fnStableId || body.stableId,
      source: body.source,
      rangeStart: body.rangeStart,
      rangeEnd: body.rangeEnd,
    }));
    return;
  }

  if (pathname === '/api/features/make-repro') {
    const featureRequest = await resolveFeatureRequest(context.driver, context.database, body);
    const repro = await saveFeatureReproFile(context.driver, context.database, featureRequest.feature, {
      outputPath: body.outputPath,
    });
    sendJson(response, 200, {
      ...repro,
      jsonPath: featureRequest.jsonPath,
      hints: featureRequest.hints,
    });
    return;
  }

  if (pathname === '/api/features/path-graph') {
    const featureRequest = await resolveFeatureRequest(context.driver, context.database, body);
    const pathGraph = await loadFeaturePathGraphData(context.driver, context.database, featureRequest.feature);
    sendJson(response, 200, {
      available: pathGraph.available,
      error: pathGraph.error,
      feature: pathGraph.feature,
      headStableId: pathGraph.headStableId,
      pairCount: pathGraph.pairCount,
      availablePairCount: pathGraph.availablePairCount,
      totalPathCount: pathGraph.totalPathCount,
      backbonePairCount: pathGraph.backbonePairCount,
      backboneAvailablePairCount: pathGraph.backboneAvailablePairCount,
      backboneTotalPathCount: pathGraph.backboneTotalPathCount,
      sidePairCount: pathGraph.sidePairCount,
      sideAvailablePairCount: pathGraph.sideAvailablePairCount,
      sideTotalPathCount: pathGraph.sideTotalPathCount,
      pathSelectionMode: pathGraph.pathSelectionMode,
      items: pathGraph.items,
      sideItems: pathGraph.sideItems,
      fnNodeCount: pathGraph.fnNodeCount,
      fnNodes: pathGraph.fnNodes,
      jsonPath: featureRequest.jsonPath,
      hints: featureRequest.hints,
    });
    return;
  }

  if (pathname === '/api/features/path-graph-draw') {
    const featureRequest = await resolveFeatureRequest(context.driver, context.database, body);
    const pathGraph = await loadFeaturePathGraphData(context.driver, context.database, featureRequest.feature);
    const result = buildFeaturePathGraphDrawDiagram(featureRequest.feature, pathGraph);
    sendJson(response, 200, {
      ...result,
      pathGraph: {
        available: pathGraph.available,
        error: pathGraph.error,
        pairCount: pathGraph.pairCount,
        availablePairCount: pathGraph.availablePairCount,
        totalPathCount: pathGraph.totalPathCount,
        backboneTotalPathCount: pathGraph.backboneTotalPathCount,
        sideTotalPathCount: pathGraph.sideTotalPathCount,
        fnNodeCount: pathGraph.fnNodeCount,
      },
      jsonPath: featureRequest.jsonPath,
      hints: featureRequest.hints,
    });
    return;
  }

  if (pathname === '/api/features/draw') {
    const featureRequest = await resolveFeatureRequest(context.driver, context.database, body);
    const result = await buildFeatureDrawDiagram(context.driver, context.database, featureRequest.feature, {
      runtimeStore: context.getRuntimeStore(),
      orchestratorConfig: context.orchestratorConfig,
      sessionId: body.sessionId,
      featureJsonPath: featureRequest.jsonPath,
    });
    sendJson(response, 200, {
      ...result,
      jsonPath: featureRequest.jsonPath,
      hints: featureRequest.hints,
    });
    return;
  }

  if (pathname === '/api/features/runtime-node-logs') {
    const featureRequest = body.feature?.stableId
      ? {
        feature: body.feature,
        jsonPath: normalizeFeatureJsonPathInput(body.jsonPath),
        hints: buildFeatureApiHints({
          jsonPath: normalizeFeatureJsonPathInput(body.jsonPath),
          jsonPayload: readFeatureJsonPayload(normalizeFeatureJsonPathInput(body.jsonPath)),
        }),
      }
      : await resolveFeatureRequest(context.driver, context.database, body);

    if (!body.sessionId) {
      throw new Error('sessionId is required for /api/features/runtime-node-logs.');
    }

    const reproContext = await resolveFeatureReproContext(context.driver, context.database, {
      feature: featureRequest.feature,
      featureJsonPath: featureRequest.jsonPath,
      source: body.source || 'FILE',
      enableLogs: true,
    });

    const runtimeNodeLogs = await loadFeatureRuntimeNodeLogs(
      reproContext.graphFeature,
      {
        sessionId: String(body.sessionId),
        limit: body.limit,
        backboneFunctionNodes: reproContext.effectiveLoggingPayload?.backboneFunctionNodes,
      },
      {
        runtimeStore: context.getRuntimeStore(),
        driver: context.driver,
        database: context.database,
      },
    );

    sendJson(response, 200, {
      ...runtimeNodeLogs,
      jsonPath: featureRequest.jsonPath,
      hints: featureRequest.hints,
    });
    return;
  }

  if (pathname === '/api/actions/start-ordinary-dev-server') {
    const loggingRequest = await buildFeatureLoggingRequest(body, context);
    sendJson(response, 200, await startOrdinaryDevServer({
      ...loggingRequest,
      enableBabelAutoInstrumentation: body.enableBabelAutoInstrumentation,
      babelInstrumentationConfigPath: body.babelInstrumentationConfigPath,
    }));
    return;
  }

  if (pathname === '/api/actions/stop-ordinary-dev-server') {
    await stopOrdinaryDevServer();
    sendJson(response, 200, { ok: true });
    return;
  }

  if (pathname === '/api/actions/start-mocked-dev-server') {
    sendJson(response, 200, await startMockedDevServer({ manifest: body.manifest }));
    return;
  }

  if (pathname === '/api/actions/stop-mocked-dev-server') {
    sendJson(response, 200, await stopMockedDevServer());
    return;
  }

  if (pathname === '/api/actions/cleanup-mocked-dev-server') {
    sendJson(response, 200, await cleanupMockedDevServer());
    return;
  }

  if (pathname === '/api/actions/launch-graph-session') {
    const loggingRequest = await buildFeatureLoggingRequest(body, context);
    sendJson(response, 200, await launchGraphSession({
      ...loggingRequest,
      enableBabelAutoInstrumentation: body.enableBabelAutoInstrumentation ?? loggingRequest.loggingEnabled,
      babelInstrumentationConfigPath: body.babelInstrumentationConfigPath,
    }));
    return;
  }

  if (pathname === '/api/actions/stop-graph-session') {
    await stopGraphSession();
    sendJson(response, 200, { ok: true });
    return;
  }

  if (pathname === '/api/actions/start-playwright-session-capture') {
    sendJson(response, 200, await startPlaywrightSessionCapture(body.kind, body.sourceStorageStatePath));
    return;
  }

  if (pathname === '/api/actions/stop-playwright-session-capture') {
    sendJson(response, 200, await stopPlaywrightSessionCapture(body.kind));
    return;
  }

  if (pathname === '/api/actions/ensure-reverse-service') {
    sendJson(response, 200, await ensureReverseService(body.service));
    return;
  }

  if (pathname === '/api/actions/stop-reverse-service') {
    sendJson(response, 200, await stopReverseService(body.service));
    return;
  }

  if (pathname === '/api/actions/ensure-reverse-observation-stack') {
    sendJson(response, 200, await ensureReverseObservationStack(body.services));
    return;
  }

  if (pathname === '/api/actions/ensure-runtime-ingestion-readiness') {
    sendJson(response, 200, await ensureRuntimeIngestionReadiness(createRuntimeRequestContext(context)));
    return;
  }

  if (pathname === '/api/actions/ensure-infra-readiness') {
    sendJson(response, 200, await ensureInfraReadiness(createRequestContext(context), body));
    return;
  }

  if (pathname === '/api/actions/start-neo4j') {
    sendJson(response, 200, await startInfraService('NEO4J', createRequestContext(context)));
    return;
  }

  if (pathname === '/api/actions/restart-infra-readiness') {
    sendJson(response, 200, await restartInfraReadiness(createRequestContext(context), body));
    return;
  }

  if (pathname === '/api/actions/restart-orchestrator') {
    sendJson(response, 202, getOrchestratorRestartRunbook(context.baseUrl));
    return;
  }

  if (pathname === '/api/actions/recover-neo4j') {
    sendJson(response, 200, await recoverNeo4j(createRequestContext(context)));
    return;
  }

  if (pathname === '/api/actions/repair-runtime-materialization') {
    sendJson(response, 200, await repairRuntimeMaterialization(createRuntimeRequestContext(context)));
    return;
  }

  if (pathname === '/api/actions/cleanup-runtime-ingestion') {
    sendJson(response, 200, await cleanupRuntimeIngestion(createRuntimeRequestContext(context)));
    return;
  }

  if (pathname === '/api/actions/reset-graph-database') {
    if (body.confirm !== 'RESET_GRAPH') {
      sendJson(response, 400, {
        ok: false,
        error: 'reset-graph-database requires body.confirm = "RESET_GRAPH".',
      });
      return;
    }
    sendJson(response, 200, await resetGraphDatabase(context.driver, context.database));
    return;
  }

  if (pathname === '/api/actions/run-extract') {
    sendJson(response, 200, startExtract({
      mode: body.mode || body.extractMode || 'func',
      fnStableId: body.fnStableId || body.stableId,
      catalogOnly: body.catalogOnly === true,
      preserveAnnotations: body.preserveAnnotations,
    }));
    return;
  }

  if (pathname === '/api/actions/stop-extract') {
    sendJson(response, 200, stopExtract());
    return;
  }

  if (pathname === '/api/features/run-repro') {
    const featureRequest = body.feature?.stableId
      ? {
        feature: body.feature,
        jsonPath: normalizeFeatureJsonPathInput(body.jsonPath),
        hints: buildFeatureApiHints({
          jsonPath: normalizeFeatureJsonPathInput(body.jsonPath),
          jsonPayload: readFeatureJsonPayload(normalizeFeatureJsonPathInput(body.jsonPath)),
        }),
      }
      : await resolveFeatureRequest(context.driver, context.database, body);
    const enableLogs = resolveFeatureLogsMode(body);
    const result = await runResolvedFeatureRepro(context.driver, context.database, {
      feature: featureRequest.feature,
      featureStableId: body.featureStableId,
      featureKey: body.featureKey,
      featureJsonPath: featureRequest.jsonPath,
      source: body.source,
      buildDrawAfterRun: body.buildDrawAfterRun,
      runtimeStore: enableLogs || body.buildDrawAfterRun ? context.getRuntimeStore() : undefined,
      orchestratorConfig: context.orchestratorConfig,
      enableLogs,
      reproFilePath: body.reproFilePath,
      gatewayUrl: context.baseUrl,
    });
    sendJson(response, 200, buildFeatureRunReproStatusPayload(result, {
      enableLogs,
      jsonPath: featureRequest.jsonPath,
      hints: featureRequest.hints,
    }));
    return;
  }

  sendJson(response, 404, {
    ok: false,
    error: `Unknown POST route: ${pathname}`,
  });
}

export async function startOrchestrator({
  uri,
  user,
  password,
  database = 'neo4j',
  host = '127.0.0.1',
  port = 8791,
  orchestratorConfig,
}) {
  const driver = neo4j.driver(normalizeNeo4jDriverUri(uri), neo4j.auth.basic(user, password));
  const resolvedOrchestratorConfig = orchestratorConfig || buildOrchestratorConfig();
  let runtimeStoreConfig;
  const getRuntimeStore = () => {
    runtimeStoreConfig ||= buildRuntimeStoreConfig();
    return runtimeStoreConfig;
  };
  let baseUrl;

  const server = http.createServer(async (request, response) => {
    try {
      if (!request.url || !request.method) {
        sendJson(response, 400, { ok: false, error: 'Request url or method is missing.' });
        return;
      }

      const requestUrl = new URL(request.url, baseUrl || `http://${host}:${port}/`);
      const context = {
        driver,
        database,
        uri,
        getRuntimeStore,
        orchestratorConfig: resolvedOrchestratorConfig,
        baseUrl,
      };

      if (request.method === 'GET') {
        await handleGet(requestUrl, response, context);
        return;
      }

      if (request.method === 'POST') {
        await handlePost(requestUrl, request, response, context);
        return;
      }

      sendJson(response, 405, {
        ok: false,
        error: `Unsupported method: ${request.method}`,
      });
    } catch (error) {
      // Client-shape errors used to surface as HTTP 500 with a stack trace.
      // Keep domain handlers simple, but normalize their validation failures at
      // the transport boundary and avoid leaking local paths by default.
      const message = error instanceof Error ? error.message : String(error);
      const clientError = error instanceof SyntaxError
        || /\b(required|must be|must include|invalid request|confirmation)\b/i.test(message);
      const statusCode = clientError ? 400 : 500;
      sendJson(response, statusCode, {
        ok: false,
        code: clientError ? 'INVALID_REQUEST' : 'INTERNAL_ERROR',
        error: message,
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(undefined);
    });
  });

  baseUrl = `http://${host}:${server.address().port}/`;

  return {
    orchestratorConfig: resolvedOrchestratorConfig,
    url: baseUrl,
    async stop() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve(undefined);
        });
      });
      await driver.close();
    },
  };
}
