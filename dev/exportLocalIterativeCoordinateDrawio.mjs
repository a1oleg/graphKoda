import fs from 'node:fs';
import path from 'node:path';
import neo4j from 'neo4j-driver';

import {
  makeDrawio,
  structuredHorizontalSize,
} from './localCoordinateDrawio.mjs';
import {
  DEFAULT_FN_STABLE_ID,
  loadFunctionDiagramSubgraph,
} from '../graph/packages/orchestrator/src/orchestrator/localCoordinateSync.js';
import {
  auditExtractedProjectionContract,
  projectHybridCoordinateEdges,
  projectHybridFlowGraph,
} from '../graph/packages/orchestrator/src/orchestrator/hybridFlowProjection.js';
import {
  isFunctionFlowRenderedRelationship,
  isFunctionFlowTraversalRelationship,
} from '../graph/packages/orchestrator/src/orchestrator/relationshipSemantics.js';

const OUTPUT_DEFAULT = 'tmp/graph-vscode-cache/local-onsubmit-steps.drawio';
const DRAWIO_GRID_X = 260;
const DRAWIO_GRID_Y = 130;
const SLOT_BRANCH_HEIGHT = 60;
const SLOT_BRANCH_VERTEX_Y_OFFSET = (SLOT_BRANCH_HEIGHT * 0.5) / DRAWIO_GRID_Y;
const COMPACT_FN_PROXY_X_OFFSET = 0.15;
const INLINE_FN_PROXY_X_OFFSET = 0.52;
const PREDICATE_MOSAIC_OPEN_WIDTH = 104;
const PREDICATE_MOSAIC_ARGUMENT_WIDTH = 112;
const PREDICATE_MOSAIC_CLOSE_WIDTH = 64;
const PREDICATE_MOSAIC_GAP = 2;
const CALL_MOSAIC_CLOSE_WIDTH = 28;
const CALL_MOSAIC_GAP = 0;
const CALL_CLOSING_JOIN_GAP = 46;
// Expanded families start at the 30px overlay row, not at the center of the
// complete 87px diagonal composition.
const CONTAINER_OVERLAY_ARGUMENT_AXIS_Y_OFFSET = (57 + 15 - 87 / 2) / DRAWIO_GRID_Y;
// A container-overlay row is centered on the complete 57px composition, while
// horizontal EVAL leaves from the 40px container body. Place the expression on
// that body axis up front so draw.io does not need an automatic vertical elbow.
const CONTAINER_BODY_AXIS_Y_OFFSET = (40 / 2 - 57 / 2) / DRAWIO_GRID_Y;
const EXPRESSION_MOSAIC_LEFT_WIDTH = 112;
const EXPRESSION_MOSAIC_RIGHT_WIDTH = 78;
const EXPRESSION_MOSAIC_GAP = 2;
const METHOD_CHAIN_TILE_WIDTH = 72;
const METHOD_CHAIN_GAP = 2;
const COMPACT_CALL_STUB_DISPLAY_OFFSET_X = -99;
const COMPACT_CALL_STUB_WIDTH = 44;
const ACCESSOR_FN_PROXY_X_OFFSET = INLINE_FN_PROXY_X_OFFSET;
const ACCESSOR_STORAGE_PROXY_X_OFFSET = 1.3;
const COMPACT_CALL_RETURN_PORT_GAP = 23;
const DEFAULT_NODE_WIDTH = 170;
const DEFAULT_OBJECT_NODE_WIDTH = 160;
const BRACKET_NODE_WIDTH = COMPACT_CALL_STUB_WIDTH;
const FLAG_OUTCOME_WIDTH = 85;
const LOCAL_VALUE_OUTCOME_X_OFFSET = ((FLAG_OUTCOME_WIDTH / 2) + COMPACT_CALL_RETURN_PORT_GAP) / DRAWIO_GRID_X;
const OUTCOME_DIRECT_ENTRY_Y_OFFSET = ((SLOT_BRANCH_HEIGHT / 2) + COMPACT_CALL_RETURN_PORT_GAP) / DRAWIO_GRID_Y;
const FLOW_OUTCOME_Y_STEP = 0.38;
const FLAG_OUTCOME_Y_STEP = 0.48;
const RESOURCE_EDGE_TYPES = new Set([
  'READ',
  'WRITE',
  'TEST',
  'CREATE',
  'UPDATE',
  'DELETE',
  'CLEAR',
  'EMIT',
  'WAIT',
  'SUBSCRIBE',
  'SIGNAL',
  'START',
  'CANCEL',
  'DERIVE',
  'DECLARES_FUNCTION',
  'DETACHES_ASYNC',
  'AWAITS_ASYNC',
]);
const CONDITION_SEMANTIC_EDGE_TYPES = new Set([
  ...RESOURCE_EDGE_TYPES,
  'CALL',
  'REQUEST',
  'RESPONSE',
  'XOR_JOIN',
]);
function defaultChecksOutputPath(outputPath) {
  const parsed = path.parse(outputPath);
  return path.join(parsed.dir || '.', `${parsed.name}.auto-checks.json`);
}

function outputGenerationPath(outputPath) {
  return `${outputPath}.render-generation`;
}

function claimOutputGeneration(outputPath) {
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputGenerationPath(outputPath), token, 'utf8');
  return token;
}

function ownsOutputGeneration(outputPath, token) {
  try {
    return fs.readFileSync(outputGenerationPath(outputPath), 'utf8') === token;
  } catch {
    return false;
  }
}

function releaseOutputGeneration(outputPath, token) {
  if (!ownsOutputGeneration(outputPath, token)) return;
  fs.rmSync(outputGenerationPath(outputPath), { force: true });
}

function writeTextAtomically(outputPath, text) {
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(temporaryPath, text, 'utf8');
  fs.renameSync(temporaryPath, outputPath);
}

function readExistingAnnotationCells(outputPath) {
  if (!fs.existsSync(outputPath)) return [];
  const xml = fs.readFileSync(outputPath, 'utf8');
  return [...xml.matchAll(/<mxCell\b[^>]*\bid="annotation-[^"]+"[^>]*(?:\/>|>[\s\S]*?<\/mxCell>)/g)]
    .map((match) => match[0]);
}

function mergeAnnotationCells(drawio, annotationCells) {
  if (!annotationCells.length) return drawio;
  const missing = annotationCells.filter((cell) => {
    const id = cell.match(/\bid="([^"]+)"/)?.[1];
    return id && !drawio.includes(`id="${id}"`);
  });
  if (!missing.length) return drawio;
  const rootCloseIndex = drawio.indexOf('</root>');
  if (rootCloseIndex < 0) return drawio;
  return `${drawio.slice(0, rootCloseIndex)}${missing.join('\n')}\n${drawio.slice(rootCloseIndex)}`;
}

function readEnvFile(envPath) {
  const env = {};
  if (!fs.existsSync(envPath)) return env;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (!/^\s*[^#][^=]*=/.test(line)) continue;
    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    if (Object.prototype.hasOwnProperty.call(env, key)) continue;
    env[key] = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return env;
}

function localNeo4jConfig(aura = false) {
  const env = readEnvFile(path.resolve(process.cwd(), 'graph', '.env'));
  if (aura) {
    if (!env.AURA_NEO4J_URI || !env.AURA_NEO4J_PASSWORD) throw new Error('Configure AURA_NEO4J_* in graph/.env');
    return { uri: env.AURA_NEO4J_URI, user: env.AURA_NEO4J_USERNAME || 'neo4j', password: env.AURA_NEO4J_PASSWORD, database: env.AURA_NEO4J_DATABASE || 'neo4j' };
  }
  const uri = env.NEO4J_URI || env.GRAPH_NEO4J_URI || 'neo4j://127.0.0.1:7687';
  const user = env.NEO4J_USERNAME || env.NEO4J_USER || 'neo4j';
  const password = env.NEO4J_PASSWORD;
  const database = env.NEO4J_DATABASE || env.NEO4J_DB || 'neo4j';
  if (!password) {
    throw new Error('Local Neo4j config is incomplete. Expected NEO4J_PASSWORD in graph/.env.');
  }
  return { uri, user, password, database };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeNeo4jConnectionError(error) {
  const messages = [];
  let current = error;
  while (current) {
    if (current.message) messages.push(current.message);
    current = current.cause;
  }
  const joined = messages.join(' | ');
  if (/ECONNREFUSED|No routing servers available|Could not perform discovery/i.test(joined)) {
    return 'Local Neo4j is not reachable on graph/.env NEO4J_URI. Start the Neo4j Desktop database and wait until Bolt is listening, then retry.';
  }
  return joined || String(error);
}

async function verifyLocalNeo4jConnectivity(driver, config, { attempts = 8, delayMs = 1500 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await driver.verifyConnectivity();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  throw new Error([
    summarizeNeo4jConnectionError(lastError),
    `uri=${config.uri}`,
    `database=${config.database}`,
    `attempts=${attempts}`,
  ].join('\n'));
}

function parseArgs(argv) {
  const result = {
    outputPath: OUTPUT_DEFAULT,
    fnStableId: DEFAULT_FN_STABLE_ID,
    stepStableId: undefined,
    localFunctionStableId: undefined,
    checksOutputPath: undefined,
    projection: 'hybrid',
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--aura') result.aura = true;
    else if (arg === '--output') result.outputPath = argv[++index] || result.outputPath;
    else if (arg === '--fn-stable-id') result.fnStableId = argv[++index] || result.fnStableId;
    else if (arg === '--step-stable-id') result.stepStableId = argv[++index] || result.stepStableId;
    else if (arg === '--local-function-stable-id') result.localFunctionStableId = argv[++index] || result.localFunctionStableId;
    else if (arg === '--checks-output') result.checksOutputPath = argv[++index] || result.checksOutputPath;
    else if (arg === '--projection') result.projection = argv[++index] || result.projection;
    else if (arg === '--legacy-projection') result.projection = 'legacy';
    else if (!arg.startsWith('--')) result.outputPath = arg;
    else throw new Error(`Unknown option: ${arg}`);
  }
  result.checksOutputPath ||= defaultChecksOutputPath(result.outputPath);
  if (!['hybrid', 'legacy'].includes(result.projection)) {
    throw new Error(`Invalid --projection: ${result.projection}`);
  }
  return result;
}

async function resolveStepScope(driver, database, stepStableId) {
  const session = driver.session({ database });
  try {
    const result = await session.run(`
      MATCH (step:Step {stableId: $stepStableId})
      RETURN
        step.parentFnStableId AS fnStableId,
        step.headStableIds AS headStableIds,
        step.tailStableIds AS tailStableIds
    `, { stepStableId });
    const record = result.records[0];
    if (!record) throw new Error(`Step not found: ${stepStableId}`);
    const fnStableId = String(record.get('fnStableId') || '').trim();
    const headStableIds = record.get('headStableIds') || [];
    const tailStableIds = record.get('tailStableIds') || [];
    if (!fnStableId) throw new Error(`Step has no parentFnStableId: ${stepStableId}`);
    if (!headStableIds.length) throw new Error(`Step has no headStableIds: ${stepStableId}`);
    return {
      fnStableId,
      headStableIds: headStableIds.map(String),
      tailStableIds: tailStableIds.map(String),
    };
  } finally {
    await session.close();
  }
}

function filterGraphToStep(nodes, edges, stepStableId) {
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  const localKeys = new Set(nodes
    .filter((node) => String(node.props?.parentStepStableId || '').trim() === stepStableId)
    .map((node) => node.key));
  const selectedKeys = new Set(localKeys);

  // Preserve direct semantic targets (Fn, Method, storage, and already
  // materialized storage targets) needed to render the selected Step exactly
  // as it appears inside the complete function diagram. This is deliberately
  // one hop from local members: traversing through a shared system Method
  // would pull proxies belonging to unrelated call sites into this Step.
  for (const edge of edges) {
    const sourceLocal = localKeys.has(edge.start);
    const targetLocal = localKeys.has(edge.end);
    if (sourceLocal === targetLocal) continue;
    const outsideKey = sourceLocal ? edge.end : edge.start;
    const outside = nodeByKey.get(outsideKey);
    const semanticCompanion = outside?.labels?.some((label) => [
      'Fn',
      'Method',
      'Cell',
      'Resource',
      'ExternalTarget',
    ].includes(label));
    if (semanticCompanion) selectedKeys.add(outsideKey);
  }

  const scopedNodes = nodes.filter((node) => selectedKeys.has(node.key));
  const scopedEdges = edges.filter((edge) => selectedKeys.has(edge.start) && selectedKeys.has(edge.end));
  const boundaryNodeByKey = new Map();
  for (const edge of edges) {
    if (!localKeys.has(edge.start) || selectedKeys.has(edge.end)) continue;
    if (!['TRUE', 'FALSE'].includes(edge.type)) continue;
    const boundaryKey = `step-boundary:${stepStableId}:${edge.type}:${edge.end}`;
    if (!boundaryNodeByKey.has(boundaryKey)) {
      boundaryNodeByKey.set(boundaryKey, {
        key: boundaryKey,
        labels: ['FlowBoundary', 'Outcome', edge.type === 'TRUE' ? 'TruthyOutcome' : 'FalsyOutcome'],
        props: {
          parentStepStableId: stepStableId,
          ownerStepStableId: stepStableId,
          diaName: edge.type,
          label: edge.type,
          flow_layer: 'control',
          flowLayer: 'control',
          synthetic: true,
          stepBoundaryTargetStableId: edge.end,
        },
      });
    }
    scopedEdges.push({
      ...edge,
      end: boundaryKey,
      props: {
        ...(edge.props || {}),
        stepBoundaryTargetStableId: edge.end,
      },
    });
  }

  return {
    nodes: [...scopedNodes, ...boundaryNodeByKey.values()],
    edges: scopedEdges,
  };
}

function propValue(props, ...names) {
  for (const name of names) {
    if (props?.[name] !== undefined && props?.[name] !== null) return props[name];
  }
  return undefined;
}

function nodeHasLabel(node, label) {
  return Boolean(node && (node.labels || []).includes(label));
}

function isSemanticCompanionNode(node) {
  return nodeHasLabel(node, 'Fn')
    || nodeHasLabel(node, 'Method')
    || nodeHasLabel(node, 'Cell')
    || nodeHasLabel(node, 'Resource')
    || nodeHasLabel(node, 'UiSurface')
    || nodeHasLabel(node, 'ExternalTarget');
}

function localFunctionProxyStableId(localFunctionStableId) {
  return `${localFunctionStableId}:local-function-proxy:declaration`;
}

function filterGraphToLocalFunction(
  nodes,
  edges,
  localFunctionStableId,
  requestedRootProxyStableId = localFunctionProxyStableId(localFunctionStableId),
) {
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  const selectedKeys = new Set();
  const rootProxyStableId = nodes.find((node) => (
    node.key.startsWith(`${localFunctionStableId}:local-function-body:start`)
    && (nodeHasLabel(node, 'Fn') || nodeHasLabel(node, 'FunctionStart'))
  ))?.key
    || nodes.find((node) => (
    nodeHasLabel(node, 'LocalFunctionProxy')
    && node.key.startsWith(`${localFunctionStableId}:`)
    && node.key.endsWith(':local-function-proxy:declaration')
  ))?.key
    || nodes.find((node) => node.key === localFunctionStableId)?.key
    || requestedRootProxyStableId;
  selectedKeys.add(rootProxyStableId);

  for (const node of nodes) {
    const parentLocalFunctionStableId = String(propValue(
      node.props,
      'parentLocalFunctionStableId',
      'parent_local_function_stable_id',
    ) || '');
    if (parentLocalFunctionStableId !== localFunctionStableId) continue;
    selectedKeys.add(node.key);
  }

  let selectedLayoutMember = true;
  while (selectedLayoutMember) {
    selectedLayoutMember = false;
    for (const node of nodes) {
      if (selectedKeys.has(node.key)) continue;
      const layoutOwnerStableIds = [
        expressionMosaicOwnerStableId(node),
        callMosaicOwnerStableId(node),
        methodChainOwnerStableId(node),
      ].filter(Boolean);
      if (!layoutOwnerStableIds.some((ownerStableId) => selectedKeys.has(ownerStableId))) continue;
      selectedKeys.add(node.key);
      selectedLayoutMember = true;
    }
  }

  for (const edge of edges) {
    const sourceSelected = selectedKeys.has(edge.start);
    const targetSelected = selectedKeys.has(edge.end);
    if (sourceSelected === targetSelected) continue;
    if (edge.type === 'DECLARES_FUNCTION') continue;
    const companionKey = sourceSelected ? edge.end : edge.start;
    if (isSemanticCompanionNode(nodeByKey.get(companionKey))) {
      selectedKeys.add(companionKey);
    }
  }

  const scopedNodes = nodes
    .filter((node) => selectedKeys.has(node.key))
    .map((node) => {
      if (node.key !== rootProxyStableId) return node;
      const {
        parentStepStableId,
        parent_step_stable_id,
        ownerStepStableId,
        owner_step_stable_id,
        flowStepKind,
        flow_step_kind,
        flowStepOrder,
        flow_step_order,
        ownerStepOrder,
        owner_step_order,
        parentFlowBlockStableId,
        parent_flow_block_stable_id,
        ownerStepKind,
        owner_step_kind,
        ...props
      } = node.props || {};
      return { ...node, props };
    });
  const scopedEdges = edges
    .filter((edge) => selectedKeys.has(edge.start) && selectedKeys.has(edge.end))
    .map((edge) => {
      if (edge.start !== rootProxyStableId && edge.end !== rootProxyStableId) return edge;
      const {
        parentStepStableId,
        parent_step_stable_id,
        ownerStepStableId,
        owner_step_stable_id,
        flowStepKind,
        flow_step_kind,
        flowStepOrder,
        flow_step_order,
        ownerStepOrder,
        owner_step_order,
        parentFlowBlockStableId,
        parent_flow_block_stable_id,
        ownerStepKind,
        owner_step_kind,
        ...props
      } = edge.props || {};
      return { ...edge, props };
    });
  if (!selectedKeys.has(rootProxyStableId)) {
    throw new Error(`Local function proxy is missing from loaded graph: ${localFunctionStableId}`);
  }
  return {
    nodes: scopedNodes,
    edges: scopedEdges,
    rootProxyStableId,
  };
}

function hasLabel(node, label) {
  return Boolean(node && (node.labels || []).includes(label));
}

function hasLabels(node, ...labels) {
  return labels.every((label) => hasLabel(node, label));
}

function isComputedBooleanValueNode(node) {
  return hasLabel(node, 'ComputedValue') && hasLabel(node, 'BooleanFlag');
}

function isFlowEvalNode(node) {
  return hasLabel(node, 'Eval');
}

function isLocalValueDeclarationNode(node) {
  return hasLabels(node, 'ValueSlot', 'LocalBinding', 'ValueCreate') && !hasLabel(node, 'FnDeclaration');
}

function isValueOutcomeNode(node) {
  return hasLabel(node, 'ValueOutcome');
}

function isCallResultNode(node) {
  return hasLabels(node, 'Value', 'Result');
}

function isFnVisualProxyNode(node) {
  return hasLabel(node, 'FnVisualProxy');
}

function isArgJoinNode(node) {
  return hasLabels(node, 'Arg', 'Join');
}

function callBoundaryDesign(node) {
  return node?.props?.call_boundary_design || node?.props?.callBoundaryDesign || '';
}

function callBoundaryRole(node) {
  return node?.props?.call_boundary_role || node?.props?.callBoundaryRole || '';
}

function callMosaicRole(node) {
  return node?.props?.call_mosaic_role || node?.props?.callMosaicRole || '';
}

function callMosaicOwnerStableId(node) {
  return node?.props?.call_mosaic_owner_stable_id || node?.props?.callMosaicOwnerStableId || '';
}

function isPredicateCallMosaicOpen(node) {
  return callMosaicRole(node) === 'open'
    && callMosaicOwnerStableId(node) === node?.key
    && (hasLabel(node, 'PredicateCall') || node?.props?.callPredicate === true || node?.props?.call_predicate === true);
}

function isSingleArgumentCallMosaicOpen(node) {
  return callMosaicRole(node) === 'open'
    && callMosaicOwnerStableId(node) === node?.key
    && !isPredicateCallMosaicOpen(node);
}

function compactCallMosaicWidth(node, { min = 28, padding = 14 } = {}) {
  const structuredWidth = structuredHorizontalSize(node)?.width;
  if (Number.isFinite(structuredWidth) && structuredWidth > 0) {
    return Math.max(min, structuredWidth);
  }
  const label = String(node?.props?.diaName || node?.props?.dia_name || node?.props?.label || '');
  return Math.max(min, padding + label.length * 7);
}

function expressionMosaicRole(node) {
  return node?.props?.expression_mosaic_role || node?.props?.expressionMosaicRole || '';
}

function expressionMosaicOrder(node) {
  const value = Number(node?.props?.expression_mosaic_order ?? node?.props?.expressionMosaicOrder);
  return Number.isFinite(value) ? value : expressionMosaicRole(node) === 'left' ? 0 : expressionMosaicRole(node) === 'operator' ? 1 : 2;
}

function expressionMosaicWidth(node) {
  const label = String(node?.props?.diaName || node?.props?.dia_name || node?.props?.label || '');
  return Math.max(22, Math.min(220, 14 + label.length * 7));
}

function isExpressionMosaicBacking(node) {
  return (node?.props?.expression_mosaic_part_kind || node?.props?.expressionMosaicPartKind) === 'receiver'
    || node?.props?.expression_mosaic_receiver_backing === true
    || node?.props?.expressionMosaicReceiverBacking === true;
}

function expressionMosaicOwnerStableId(node) {
  return node?.props?.expression_mosaic_owner_stable_id || node?.props?.expressionMosaicOwnerStableId || '';
}

function methodChainOwnerStableId(node) {
  return node?.props?.method_chain_owner_stable_id || node?.props?.methodChainOwnerStableId || '';
}

function isMethodChainContinuation(node, ownerStableId = '') {
  const role = node?.props?.method_chain_role || node?.props?.methodChainRole || '';
  const owner = methodChainOwnerStableId(node);
  return role === 'continuation' && Boolean(owner) && (!ownerStableId || owner === ownerStableId);
}

function isExpressionMosaicOperator(node) {
  return expressionMosaicRole(node) === 'operator'
    && expressionMosaicOwnerStableId(node) === node?.key;
}

function isSplitCallNode(node) {
  return callBoundaryDesign(node) === 'split';
}

async function resolveImplicitLocalFunctionScope(driver, database, fnStableId) {
  const session = driver.session({ database });
  try {
    const declarationResult = await session.run(`
      MATCH (declaration)
      WHERE declaration:LocalFunctionProxy OR declaration:FnDeclaration
      WITH declaration
      WHERE declaration.calleeStableId = $fnStableId
         OR declaration.stableId = $fnStableId
         OR declaration.originalStableId = $fnStableId
      RETURN DISTINCT
        coalesce(declaration.originalStableId, declaration.stableId) AS declarationStableId
    `, { fnStableId });
    const coordinates = new Set(declarationResult.records
      .map((record) => String(record.get('declarationStableId') || '').trim())
      .map((stableId) => stableId.match(/^(.*?:\d+:\d+:\d+:\d+)/)?.[1] || '')
      .filter(Boolean));
    if (coordinates.size !== 1) {
      console.error(`[flow-render] implicit local-function declaration lookup returned ${coordinates.size} coordinates for ${fnStableId}`);
      return null;
    }
    const [coordinate] = coordinates;
    const ownerResult = await session.run(`
      MATCH (member)
      WHERE coalesce(member.parentLocalFunctionStableId, member.parent_local_function_stable_id)
          = $localFunctionStableId
      WITH DISTINCT coalesce(member.parentFnStableId, member.parent_fn_stable_id) AS parentFnStableId
      MATCH (parent:Fn {stableId: parentFnStableId})
      RETURN parentFnStableId,
        coalesce(parent.startLine, parent.start_line, 0) AS startLine,
        coalesce(parent.endLine, parent.end_line, 0) AS endLine
      ORDER BY (endLine - startLine) ASC, startLine DESC
      LIMIT 1
    `, { localFunctionStableId: coordinate });
    const parentFnStableId = String(ownerResult.records[0]?.get('parentFnStableId') || '').trim();
    if (!parentFnStableId) {
      console.error(`[flow-render] implicit local-function owner is missing for ${fnStableId}: declaration=${coordinate}`);
      return null;
    }
    console.error(`[flow-render] resolved nested function ${fnStableId} through ${parentFnStableId} local=${coordinate}`);
    if (parentFnStableId === fnStableId) {
      return {
        parentFnStableId,
        directDeclarationStableId: coordinate,
      };
    }
    return {
      parentFnStableId,
      proxyStableId: localFunctionProxyStableId(coordinate),
      localFunctionStableId: coordinate,
    };
  } finally {
    await session.close();
  }
}

function opensObjectFamilyFromMosaic(node) {
  if (node?.props?.opensObjectFieldFamily || node?.props?.opens_object_field_family) return true;
  const raw = node?.props?.render_parts_json || node?.props?.renderPartsJson;
  if (!raw) return false;
  try {
    const parts = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parts) && parts.some((part) => part?.text === '{');
  } catch {
    return false;
  }
}

function isContainerOverlayNode(node) {
  const layout = node?.props?.render_parts_layout || node?.props?.renderPartsLayout || '';
  return layout === 'container-overlay' || layout === 'container-overlay-side';
}

function horizontalEvalTargetY(sourceNode, targetNode, edge, sourceY, nestedEvaluation = false) {
  const protocolRole = String(edge?.props?.protocolRole || edge?.props?.protocol_role || '');
  if (
    nestedEvaluation
    || !isContainerOverlayNode(sourceNode)
    || hasLabel(targetNode, 'Iterator')
    || hasLabel(targetNode, 'Iterate')
    || protocolRole === 'collection-shift-eval'
  ) return sourceY;
  return sourceY + CONTAINER_BODY_AXIS_Y_OFFSET;
}

function resolvedArgumentFamilyAxisY(node, baseY, argumentCount) {
  const layout = node?.props?.render_parts_layout || node?.props?.renderPartsLayout || '';
  const splitOpening = node?.props?.splitCallBoundary === 'start'
    || node?.props?.split_call_boundary === 'start'
    || (callBoundaryDesign(node) === 'split' && callBoundaryRole(node) === 'open');
  if (
    argumentCount > 0
    && (
      (
        layout === 'container-overlay'
        && hasLabel(node, 'Collection')
        && hasLabel(node, 'Set')
      )
      || (layout === 'container-overlay-side' && splitOpening)
    )
  ) {
    return baseY + CONTAINER_OVERLAY_ARGUMENT_AXIS_Y_OFFSET;
  }
  return baseY;
}

function isSingleNodeNoArgumentCall(node) {
  return callBoundaryDesign(node) === 'column'
    && (node?.props?.call_has_arguments ?? node?.props?.callHasArguments) === false;
}

function splitCallRenderProps(node) {
  const mosaicRole = callMosaicRole(node);
  if (mosaicRole === 'argument') {
    return {
      splitCallBoundary: 'middle',
      callHasArguments: true,
      callPredicate: false,
    };
  }
  const role = callBoundaryRole(node);
  if (!isSplitCallNode(node) || (role !== 'open' && role !== 'close')) return {};
  return {
    splitCallBoundary: role === 'open' ? 'start' : 'end',
    callHasArguments: node.props?.call_has_arguments ?? node.props?.callHasArguments ?? false,
    callPredicate: node.props?.call_predicate ?? node.props?.callPredicate ?? false,
  };
}

function isCollectionArgumentClosureNode(node) {
  return isArgJoinNode(node)
    && hasLabel(node, 'Collection')
    && (node.props?.mergeLabel || node.props?.merge_label) === 'collection-args-join'
    && Boolean(node.props?.sourceCallStableId)
    && callBoundaryDesign(node) !== 'column';
}

function isExclusiveJoinNode(node) {
  return hasLabels(node, 'Join', 'Exclusive');
}

function isDataJoinNode(node) {
  return hasLabel(node, 'DataJoin');
}

function isObjectBraceNode(node) {
  return hasLabel(node, 'ObjectBrace');
}

function objectBraceFamilyStableId(node) {
  return String(
    node?.props?.objectFamilyStableId
    || node?.props?.object_family_stable_id
    || '',
  );
}

function objectBraceSide(node) {
  return String(node?.props?.objectBraceSide || node?.props?.object_brace_side || '');
}

function isFieldJoinNode(node) {
  return hasLabels(node, 'Field', 'Join');
}

function isTerminalFieldJoinNode(node, outgoingBySource) {
  if (!isFieldJoinNode(node)) return false;
  return !(outgoingBySource.get(node.key) || []).some((edge) => !isResourceEdge(edge));
}

function isObjectStartNode(node) {
  return hasLabel(node, 'Object');
}

function isObjectFieldNode(node) {
  return hasLabel(node, 'Field') && !hasLabel(node, 'Join') && !hasLabel(node, 'Branch');
}

function isObjectFinishNode(node) {
  return hasLabels(node, 'Field', 'Join');
}

function isCallFinishNode(node) {
  return hasLabel(node, 'Finish') && !hasLabel(node, 'Start');
}

function isBracketLayoutNode(node) {
  return isCallFinishNode(node)
    || (isObjectStartNode(node) && !hasLabel(node, 'Parameter'))
    || isObjectFinishNode(node)
    || (isArgJoinNode(node) && !isExclusiveJoinNode(node))
    || isFieldJoinNode(node);
}

function bracketReferenceWidth(node) {
  return isObjectStartNode(node) || isObjectFinishNode(node) || isFieldJoinNode(node)
    ? DEFAULT_OBJECT_NODE_WIDTH
    : DEFAULT_NODE_WIDTH;
}

function horizontalStepForNode(node) {
  if (!isBracketLayoutNode(node)) return 1;
  return 1 - (bracketReferenceWidth(node) - BRACKET_NODE_WIDTH) / DRAWIO_GRID_X;
}

function bracketDisplayOffsetX(node) {
  return isBracketLayoutNode(node)
    ? -(bracketReferenceWidth(node) - BRACKET_NODE_WIDTH) / 2
    : undefined;
}

function isFlowJoinNode(node) {
  return hasLabels(node, 'Flow', 'Join');
}

function isLogicalOutcomeJoinNode(node) {
  return hasLabel(node, 'LogicalOutcomeJoin');
}

function shouldExpandLocalFunctionProxy(options = {}) {
  return options.expandLocalFunctionProxy === true;
}

function isCurrentNodeLinear(node, options = {}) {
  if (hasLabel(node, 'FunctionProxy') && !(hasLabel(node, 'LocalFunctionProxy') && shouldExpandLocalFunctionProxy(options))) return false;
  return hasLabel(node, 'ExecutionJunction')
    || hasLabel(node, 'FunctionStart')
    || hasLabel(node, 'Fn')
    || hasLabel(node, 'Step')
    || hasLabel(node, 'Action')
    || hasLabel(node, 'ValueAccess')
    || hasLabel(node, 'Alternative')
    || hasLabels(node, 'Async', 'Boundary')
    || hasLabel(node, 'FnDeclaration')
    || hasLabel(node, 'DetachedAsyncCall')
    || hasLabel(node, 'AwaitedAsyncCall')
    || hasLabel(node, 'UiInjection')
    || hasLabel(node, 'VirtualView')
    || hasLabel(node, 'UpdaterFn')
    || hasLabel(node, 'CallbackFn')
    || hasLabel(node, 'Parameter')
    || hasLabel(node, 'ValueSlot')
    || isLocalValueDeclarationNode(node)
    || hasLabel(node, 'Eval')
    || hasLabels(node, 'Primitive', 'Evaluate')
    || hasLabel(node, 'Value')
    || hasLabel(node, 'Return')
    || hasLabel(node, 'FunctionEnd')
    || (hasLabel(node, 'Arg') && !hasLabel(node, 'Object'))
    || isObjectFieldNode(node)
    || isOperandJoinNode(node)
    || isDataJoinNode(node)
    || isFieldJoinNode(node)
    || isFlowJoinNode(node);
}

function isCurrentNodeCall(node) {
  if (hasLabel(node, 'Shift') && hasLabel(node, 'Pull')) return false;
  return hasLabel(node, 'Call') || hasLabel(node, 'Request') || hasLabel(node, 'Read') || hasLabel(node, 'Write') || hasLabel(node, 'Op') || isArgJoinNode(node);
}

function isCurrentNodeRead(node, outgoing = []) {
  if (isCurrentNodeBranch(node) || isSlotBranchNode(node)) return false;
  if (outgoing.some((edge) => edge.type === 'ARG')) return false;
  if (
    hasLabel(node, 'Call')
    || hasLabel(node, 'Request')
    || hasLabel(node, 'Op')
    || isArgJoinNode(node)
  ) return false;
  return hasLabel(node, 'Read') || hasLabel(node, 'Write') || outgoing.some((edge) => edge.type === 'READ' || edge.type === 'WRITE');
}

function isResourceEdge(edge) {
  if (edge?.type === 'DECLARES_FUNCTION') return false;
  return RESOURCE_EDGE_TYPES.has(edge?.type);
}

const CALL_TARGET_EDGE_TYPES = new Set(['CALL', 'REQUEST', 'READ', 'WRITE', 'INVOKES']);
const STATE_RESOURCE_VALUE_EDGE_TYPES = new Set(['READS_VALUE', 'WRITES_VALUE', 'CLEARS_VALUE']);

function isStateResourceValueEdge(edge, nodeByKey) {
  if (!STATE_RESOURCE_VALUE_EDGE_TYPES.has(edge?.type)) return false;
  const source = nodeByKey.get(edge.start);
  const target = nodeByKey.get(edge.end);
  return hasLabel(source, 'Start')
    && hasLabel(source, 'Write')
    && source?.props?.call_boundary_design !== 'split'
    && hasLabel(target, 'UiState')
    && (hasLabel(target, 'Storage') || hasLabel(target, 'Cell'));
}

function resourceEdgesFromTypes(byType, nodeByKey) {
  return [...byType.entries()]
    .flatMap(([type, edges]) => RESOURCE_EDGE_TYPES.has(type)
      ? edges
      : edges.filter((edge) => isStateResourceValueEdge(edge, nodeByKey)));
}

function isRenderedCallTargetEdge(edge, nodeByKey) {
  // Direct invocation targets belong to the semantic graph, but they are not
  // extra Flow-diagram nodes. Atomic calls render as one node; expanded calls
  // end at their graph-backed argument closing boundary.
  if (CALL_TARGET_EDGE_TYPES.has(edge.type)) return false;
  return true;
}

function isDeveloperVisualCallTarget(node) {
  return hasLabel(node, 'Fn') || hasLabel(node, 'Method');
}

function callInvocationType(edge) {
  return edge?.props?.invocation_type || edge?.props?.invocationType || edge?.type;
}

function callSiteStableIdForEdge(edge) {
  return edge?.props?.call_site_stable_id || edge?.props?.callSiteStableId || edge?.start;
}

function isArgumentFunctionJoinEdge(edge, nodeByKey) {
  const target = nodeByKey.get(edge?.end);
  const returnsToInlineColumnCall = callBoundaryDesign(target) === 'column'
    && callSiteStableIdForEdge(edge) === edge?.end;
  return !returnsToInlineColumnCall
    && edge?.type === 'ArgJoin'
    && CALL_TARGET_EDGE_TYPES.has(callInvocationType(edge))
    && (isFnVisualProxyNode(target) || isDeveloperVisualCallTarget(target));
}

function isDeveloperVisualCallTargetEdge(edge, nodeByKey) {
  if (!isArgumentFunctionJoinEdge(edge, nodeByKey)) return false;
  if (isFnVisualProxyNode(nodeByKey.get(edge.start))) return false;
  return isDeveloperVisualCallTarget(nodeByKey.get(edge.end));
}

function filterLocalFunctionBodiesFromParent(
  nodes,
  edges,
  currentFunctionStableId,
  directDeclarationStableId = '',
) {
  const currentFunctionOwners = new Set([
    currentFunctionStableId,
    directDeclarationStableId,
  ].filter(Boolean));
  const retainedNodes = nodes.filter((node) => {
    const localFunctionOwner = String(propValue(
      node.props,
      'parentLocalFunctionStableId',
      'parent_local_function_stable_id',
    ) || '').trim();
    return !localFunctionOwner || currentFunctionOwners.has(localFunctionOwner);
  });
  const retainedIds = new Set(retainedNodes.map((node) => node.key));
  return {
    nodes: retainedNodes,
    edges: edges.filter((edge) => retainedIds.has(edge.start) && retainedIds.has(edge.end)),
  };
}

function isCallTargetProxySource(node) {
  return hasLabel(node, 'Call')
    || hasLabel(node, 'Request')
    || hasLabel(node, 'Read')
    || hasLabel(node, 'Write')
    || hasLabel(node, 'Arg')
    || hasLabel(node, 'Value')
    || isObjectFieldNode(node)
    || hasLabel(node, 'Object')
    || isArgJoinNode(node)
    || isFieldJoinNode(node)
    || isDataJoinNode(node);
}

function isCompactCallSnippetSource(node, { argEdges = [], fieldEdges = [] } = {}) {
  if (!node) return false;
  if (isCallFinishNode(node)) return false;
  if (hasLabel(node, 'Call') || hasLabel(node, 'Request')) return !argEdges.length;
  if (hasLabel(node, 'Arg') || isObjectFieldNode(node)) return !argEdges.length && !fieldEdges.length;
  return false;
}

function slotEdgesFromTypes(byType, preferredTypes = ['FIELD', 'ARG', 'VALUE']) {
  for (const type of preferredTypes) {
    const edges = byType.get(type) || [];
    if (edges.length) return { type, edges };
  }
  return { type: '<none>', edges: [] };
}

function isCurrentNodeObjectSlot(node) {
  if (hasLabel(node, 'IndexedWrite')) return false;
  if (isArgJoinNode(node) || isFieldJoinNode(node)) return false;
  return hasLabel(node, 'Object')
    || hasLabel(node, 'ObjectConstruction')
    || isObjectStartNode(node)
    || isObjectFinishNode(node)
    || isObjectFieldNode(node)
    || hasLabels(node, 'Collection', 'ContainerMethod', 'Set');
}

function isCurrentNodeBranch(node) {
  return hasLabel(node, 'Branch');
}

function isFlowBranchNode(node) {
  return hasLabels(node, 'Flow', 'Branch');
}

function isDataBranchNode(node) {
  return hasLabels(node, 'Data', 'Branch');
}

function isSameFlowConditionStep(source, target) {
  if (!isFlowBranchNode(source) || !isFlowBranchNode(target)) return false;
  const sourceStep = String(source.props?.parentStepStableId || '').trim();
  const targetStep = String(target.props?.parentStepStableId || '').trim();
  return sourceStep && targetStep ? sourceStep === targetStep : true;
}

function isSlotBranchNode(node) {
  return hasLabel(node, 'Branch') && (hasLabel(node, 'Arg') || hasLabel(node, 'Field'));
}

function isOperandBranchNode(node) {
  return hasLabel(node, 'Branch') && hasLabel(node, 'Operand');
}

function isOperandJoinNode(node) {
  return hasLabels(node, 'Operand', 'Join');
}

function isCurrentNodeLoop(node) {
  return hasLabel(node, 'Loop');
}

const STEP_STRUCTURE_EDGE_TYPES = new Set();

function isCoordinateEdge(edge) {
  return !STEP_STRUCTURE_EDGE_TYPES.has(edge.type);
}

function originalOutgoing(edges, key) {
  return edges
    .filter((edge) => edge.start === key && isCoordinateEdge(edge))
    .sort((left, right) => {
      const leftOrder = Number(left.props?.operationIndex ?? left.props?.operation_index ?? 0);
      const rightOrder = Number(right.props?.operationIndex ?? right.props?.operation_index ?? 0);
      return (leftOrder - rightOrder) || String(left.type).localeCompare(String(right.type)) || String(left.end).localeCompare(String(right.end));
    });
}

function makeTraceStep(operation, details = {}) {
  return {
    operation,
    ...Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined && value !== null && value !== '')),
  };
}

function formatTraceStep(step, index) {
  const details = Object.entries(step)
    .filter(([key]) => key !== 'operation')
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('|') : String(value)}`)
    .join('; ');
  return `${index + 1}. ${step.operation}${details ? `: ${details}` : ''}`;
}

function traceToText(trace) {
  return (trace || []).map(formatTraceStep).join('\n');
}

function normalizeTrace(traceOrReason, fallbackOperation = 'placeNode') {
  if (Array.isArray(traceOrReason)) return traceOrReason;
  return [makeTraceStep(fallbackOperation, { reason: traceOrReason })];
}

function placeNode(positions, node, x, y, reason, operation = 'placeNode', trace = undefined) {
  const nextTrace = trace ? normalizeTrace(trace) : normalizeTrace(reason, operation);
  positions.set(node.key, {
    x,
    y,
    reason,
    trace: nextTrace,
    horizontalStep: horizontalStepForNode(node),
  });
}

function appendNodeTrace(positions, key, operation, details = {}) {
  const pos = positions.get(key);
  if (!pos) return;
  const step = makeTraceStep(operation, details);
  positions.set(key, {
    ...pos,
    reason: details.reason ? `${pos.reason}; ${details.reason}` : pos.reason,
    trace: [...(pos.trace || []), step],
  });
}

function setNodePositionMeta(positions, key, meta = {}) {
  const pos = positions.get(key);
  if (!pos) return;
  positions.set(key, {
    ...pos,
    ...meta,
  });
}

function logCoordinatorStep(positions, node, operation, details = {}) {
  appendNodeTrace(positions, node.key, operation, details);
}

function coordinateExpressionMosaicOwner(nodes, positions, current, currentPos) {
  const expressionMosaicMembers = isExpressionMosaicOperator(current)
    ? nodes.filter((candidate) => expressionMosaicOwnerStableId(candidate) === current.key)
    : [];
  const expressionMosaicBacking = expressionMosaicMembers.find(isExpressionMosaicBacking);
  const orderedExpressionMosaic = expressionMosaicMembers
    .filter((candidate) => !isExpressionMosaicBacking(candidate))
    .slice()
    .sort((left, right) => expressionMosaicOrder(left) - expressionMosaicOrder(right));
  const expressionOperatorIndex = orderedExpressionMosaic.findIndex((candidate) => candidate.key === current.key);
  if (expressionOperatorIndex < 0 || orderedExpressionMosaic.length < 2) return false;

  const widths = orderedExpressionMosaic.map(expressionMosaicWidth);
  const centers = new Array(orderedExpressionMosaic.length);
  centers[expressionOperatorIndex] = currentPos.x;
  for (let index = expressionOperatorIndex - 1; index >= 0; index -= 1) {
    centers[index] = centers[index + 1]
      - (widths[index] + widths[index + 1] + EXPRESSION_MOSAIC_GAP * 2) / (2 * DRAWIO_GRID_X);
  }
  for (let index = expressionOperatorIndex + 1; index < orderedExpressionMosaic.length; index += 1) {
    centers[index] = centers[index - 1]
      + (widths[index - 1] + widths[index] + EXPRESSION_MOSAIC_GAP * 2) / (2 * DRAWIO_GRID_X);
  }
  orderedExpressionMosaic.forEach((member, index) => {
    if (member.key !== current.key) {
      placeNode(
        positions,
        member,
        centers[index],
        currentPos.y,
        `newStraightDrawio: expression mosaic member ${index + 1}/${orderedExpressionMosaic.length} of ${current.key}`,
        'placeExpressionMosaicMember',
      );
    }
    setNodePositionMeta(positions, member.key, {
      props: {
        ...(positions.get(member.key)?.props || {}),
        displayWidth: widths[index],
      },
    });
  });
  if (expressionMosaicBacking) {
    const firstCenter = centers[0];
    const lastCenter = centers.at(-1);
    const backingWidth = expressionMosaicWidth(expressionMosaicBacking);
    placeNode(
      positions,
      expressionMosaicBacking,
      (firstCenter + lastCenter) / 2,
      currentPos.y - 0.46,
      `newStraightDrawio: expression receiver above mosaic ${current.key}`,
      'placeExpressionMosaicBacking',
    );
    setNodePositionMeta(positions, expressionMosaicBacking.key, {
      props: {
        ...(positions.get(expressionMosaicBacking.key)?.props || {}),
        displayWidth: backingWidth,
      },
    });
  }
  logCoordinatorStep(positions, current, 'coordinateExpressionMosaic', {
    members: orderedExpressionMosaic.map((member) => member.key),
    reason: 'ordered graph-backed expression parts form one horizontal mosaic',
  });
  return true;
}

function recordObjectSlotCoordinateStep(positions, node, { fieldEdges, argEdges, callEdges }) {
  logCoordinatorStep(positions, node, 'coordinateObjectSlot', {
    fieldCount: fieldEdges.length,
    argCount: argEdges.length,
    callCount: callEdges.length,
    slotType: fieldEdges.length ? 'FIELD' : argEdges.length ? 'ARG' : '<none>',
  });
}

function recordCallCoordinateStep(positions, node, { nextEdges, callEdges, argEdges, resourceEdges = [] }) {
  logCoordinatorStep(positions, node, 'coordinateCall', {
    nextCount: nextEdges.length,
    callCount: callEdges.length,
    argCount: argEdges.length,
    resourceCount: resourceEdges.length,
  });
}

function recordReadCoordinateStep(positions, node, { nextEdges, readEdges }) {
  logCoordinatorStep(positions, node, 'coordinateRead', {
    nextCount: nextEdges.length,
    readCount: readEdges.length,
  });
}

function recordBranchCoordinateStep(positions, node, { trueEdge, falseEdge, rightLane, downLane, rightFootprintRows, downYStart, reason }) {
  logCoordinatorStep(positions, node, 'coordinateBranch', {
    trueTarget: trueEdge.end,
    falseTarget: falseEdge.end,
    rightTarget: rightLane.end,
    downTarget: downLane.end,
    rightFootprintRows,
    downYStart,
    reason,
  });
}

function recordLinearCoordinateStep(positions, node, { edge, sideEdges }) {
  logCoordinatorStep(positions, node, 'coordinateLinear', {
    continuationType: edge.type,
    continuationTarget: edge.end,
    sideEdgeCount: sideEdges.length,
    sideEdgeTypes: sideEdges.map((sideEdge) => sideEdge.type),
  });
}

function compactTrace(traceText, limit = 8_000) {
  const text = String(traceText || '');
  return text.length <= limit ? text : `${text.slice(0, limit)}\n... <trace truncated>`;
}

function buildPositionIndex(nodes) {
  return new Map(nodes.map((node) => [node.id, {
    id: node.id,
    labels: node.labels || [],
    label: node.props?.label || node.props?.name || node.id,
    x: Number(node.props?.displayX),
    y: Number(node.props?.displayY),
    layoutTrace: compactTrace(node.props?.layoutTrace),
  }]));
}

function simpleCallStubLabel(node) {
  const props = node?.props || {};
  const text = String(
    props.call_text_raw
    || props.action_text_raw
    || props.diaName
    || props.label
    || '',
  ).trim();
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return '()';
  const argument = text.slice(open + 1, close).trim();
  return argument || '()';
}

function simpleCallStubWidth(label) {
  return Math.max(COMPACT_CALL_STUB_WIDTH, Math.min(DEFAULT_NODE_WIDTH, label.length * 7 + 18));
}

function runStepEmptyRowsCheck({ nodes = [] }) {
  const maximumEmptyRows = 4;
  const nodesByStep = new Map();
  for (const node of nodes) {
    if (
      hasLabel(node, 'HybridSequenceAxis')
      || node.props?.hybridVisualRole === 'functional-column'
    ) continue;
    const stepStableId = node.props?.parentStepStableId
      || node.props?.ownerStepStableId
      || node.props?.owner_step_stable_id;
    const y = Number(node.props?.displayY);
    if (!stepStableId || !Number.isFinite(y)) continue;
    nodesByStep.set(stepStableId, [
      ...(nodesByStep.get(stepStableId) || []),
      { stableId: node.id, y },
    ]);
  }

  const findings = [];
  for (const [stepStableId, stepNodes] of nodesByStep) {
    const ordered = stepNodes.sort((left, right) => left.y - right.y);
    for (let index = 1; index < ordered.length; index += 1) {
      const upper = ordered[index - 1];
      const lower = ordered[index];
      const emptyRows = Math.max(0, Math.floor(lower.y - upper.y) - 1);
      if (emptyRows <= maximumEmptyRows) continue;
      findings.push({
        type: 'large-empty-step-row-span',
        stepStableId,
        emptyRows,
        maximumEmptyRows,
        upper,
        lower,
        investigation: [
          'A Step contains a large range of coordinate rows without rendered nodes.',
          'Check for a semantic node restored at default coordinates after projection.',
        ],
      });
    }
  }
  return findings;
}

const AUTO_CHECK_REGISTRY = [
  {
    id: 'step-has-no-large-empty-row-spans',
    description: 'A Step has no unexplained range of empty coordinate rows between rendered node groups.',
    run: runStepEmptyRowsCheck,
  },
];

function runAutoChecks(context) {
  return AUTO_CHECK_REGISTRY.map((check) => {
    const findings = check.run(context);
    return {
      id: check.id,
      description: check.description,
      status: findings.length ? 'fail' : 'pass',
      findingCount: findings.length,
      findings,
    };
  });
}

function runSerializedFoldingGeometryCheck(drawio) {
  const cells = new Map();
  const cellPattern = /<mxCell\s+([^>]+)>\s*<mxGeometry\s+([^>]+)/g;
  const attributes = (text) => Object.fromEntries(
    [...text.matchAll(/([\w-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]),
  );
  for (const match of drawio.matchAll(cellPattern)) {
    const cell = attributes(match[1]);
    const geometry = attributes(match[2]);
    if (!cell.id) continue;
    cells.set(cell.id, {
      ...cell,
      x: Number(geometry.x || 0),
      y: Number(geometry.y || 0),
      width: Number(geometry.width || 0),
      height: Number(geometry.height || 0),
    });
  }

  const absoluteRect = (cell, pending = new Set()) => {
    if (cell.absoluteRect) return cell.absoluteRect;
    if (pending.has(cell.id)) throw new Error(`Serialized draw.io parent cycle at ${cell.id}`);
    pending.add(cell.id);
    const parent = cells.get(cell.parent);
    const parentRect = parent ? absoluteRect(parent, pending) : { left: 0, top: 0 };
    cell.absoluteRect = {
      left: parentRect.left + cell.x,
      top: parentRect.top + cell.y,
      right: parentRect.left + cell.x + cell.width,
      bottom: parentRect.top + cell.y + cell.height,
    };
    pending.delete(cell.id);
    return cell.absoluteRect;
  };
  cells.forEach((cell) => absoluteRect(cell));

  const containers = [...cells.values()]
    .filter((cell) => (cell.id.startsWith('flow-block-') || cell.id.startsWith('fold-row-'))
      && !cell.id.endsWith('-border'));
  const visualContainers = containers.filter((cell) => cell.id.startsWith('flow-block-'));
  const containerById = new Map(containers.map((cell) => [cell.id, cell]));
  const graphNodes = [...cells.values()].filter((cell) => (
    /^n\d+$/.test(cell.id)
    && !String(cell.graphLabels || '').split(',').includes('HybridSequenceAxis')
  ));
  const cellsByStableId = new Map();
  for (const cell of cells.values()) {
    if (!cell.stableId || cell.vertex !== '1') continue;
    cellsByStableId.set(cell.stableId, [
      ...(cellsByStableId.get(cell.stableId) || []),
      cell,
    ]);
  }
  const strictlyContains = (outer, inner, inset = 0) => (
    inner.left - outer.left >= inset
    && inner.top - outer.top >= inset
    && outer.right - inner.right >= inset
    && outer.bottom - inner.bottom >= inset
  );
  const overlapsOrTouches = (left, right) => (
    Math.max(left.left, right.left) <= Math.min(left.right, right.right)
    && Math.max(left.top, right.top) <= Math.min(left.bottom, right.bottom)
  );
  const overlapsWithArea = (left, right) => (
    Math.max(left.left, right.left) < Math.min(left.right, right.right)
    && Math.max(left.top, right.top) < Math.min(left.bottom, right.bottom)
  );
  const isAncestor = (candidate, cell) => {
    let parentId = cell.parent;
    while (parentId) {
      if (parentId === candidate.id) return true;
      parentId = cells.get(parentId)?.parent || null;
    }
    return false;
  };
  const styleNumber = (cell, name, fallback) => {
    const match = String(cell.style || '').match(new RegExp(`(?:^|;)${name}=([^;]+)`));
    const value = match ? Number(match[1]) : Number.NaN;
    return Number.isFinite(value) ? value : fallback;
  };
  const controlRect = (cell) => {
    const rect = cell.absoluteRect;
    const size = styleNumber(cell, 'foldingIconSize', 24);
    const inset = styleNumber(cell, 'foldingIconInset', 10);
    const topInset = styleNumber(cell, 'foldingIconTopInset', inset);
    return {
      left: rect.left + inset,
      top: rect.top + topInset,
      right: rect.left + inset + size,
      bottom: rect.top + topInset + size,
    };
  };
  const findings = [];
  const serializedRejoins = [...cells.values()].filter((cell) => cell.edgeType === 'REJOINS');
  const rejoinsGroups = new Map();
  for (const edge of serializedRejoins) {
    const key = `${edge.stableId || ''}\u0000${edge.targetStableId || ''}`;
    rejoinsGroups.set(key, [...(rejoinsGroups.get(key) || []), edge]);
  }
  for (const [key, segments] of rejoinsGroups) {
    const [stableId, targetStableId] = key.split('\u0000');
    const segment = segments[0];
    const targetCell = segment && cells.get(segment.target);
    const targetsJoinNode = segments.length === 1
      && targetCell
      && targetCell.stableId === targetStableId
      && /^n\d+$/.test(targetCell.id);
    if (targetsJoinNode) continue;
    findings.push({
      type: 'serialized-rejoins-segment-count',
      stableId,
      targetStableId,
      segmentCount: segments.length,
      segmentIds: segments.map((segment) => segment.id),
      renderedTargetId: segment?.target,
      renderedTargetStableId: targetCell?.stableId,
      investigation: [
        'REJOINS is one visual edge from the side-flow source directly to its FlowJoin node.',
        'Boundary ports and split source/boundary/target tails are forbidden.',
      ],
    });
  }

  for (const container of containers) {
    const border = cells.get(`${container.id}-border`);
    if (border) {
      findings.push({
        type: 'serialized-legacy-border-cell',
        container: {
          id: container.id,
          x: container.x,
          y: container.y,
          width: container.width,
          height: container.height,
        },
        border: {
          id: border.id,
          x: border.x,
          y: border.y,
          width: border.width,
          height: border.height,
        },
      });
    }
    const parent = containerById.get(container.parent);
    const requiredInset = container.id.startsWith('fold-row-') ? 0 : 24;
    if (!parent || strictlyContains(parent.absoluteRect, container.absoluteRect, requiredInset)) continue;
    findings.push({
      type: 'serialized-invalid-nesting',
      parent: { id: parent.id, ...parent.absoluteRect },
      child: { id: container.id, ...container.absoluteRect },
    });
  }
  for (let leftIndex = 0; leftIndex < visualContainers.length; leftIndex += 1) {
    const left = visualContainers[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < visualContainers.length; rightIndex += 1) {
      const right = visualContainers[rightIndex];
      const leftControl = controlRect(left);
      const rightControl = controlRect(right);
      if (overlapsOrTouches(leftControl, rightControl)) {
        findings.push({
          type: 'serialized-control-intersection',
          left: { id: left.id, ...leftControl },
          right: { id: right.id, ...rightControl },
        });
      }
      if (isAncestor(left, right) || isAncestor(right, left)) continue;
      if (strictlyContains(left.absoluteRect, right.absoluteRect)
        || strictlyContains(right.absoluteRect, left.absoluteRect)) continue;
      if (!overlapsOrTouches(left.absoluteRect, right.absoluteRect)) continue;
      findings.push({
        type: 'serialized-container-intersection',
        left: { id: left.id, ...left.absoluteRect },
        right: { id: right.id, ...right.absoluteRect },
      });
    }
  }
  const graphNodeByStableId = new Map(graphNodes.map((node) => [node.stableId, node]));
  const isCompositionAncestor = (node, possibleAncestorStableId) => {
    const visited = new Set();
    let current = node;
    while (current && !visited.has(current.stableId)) {
      visited.add(current.stableId);
      const ownerStableId = current.overlayOwnerStableId
        || current.attachmentOwnerStableId
        || current.compositionOwnerStableId;
      if (!ownerStableId) return false;
      if (ownerStableId === possibleAncestorStableId) return true;
      current = graphNodeByStableId.get(ownerStableId);
    }
    return false;
  };
  for (let leftIndex = 0; leftIndex < graphNodes.length; leftIndex += 1) {
    const left = graphNodes[leftIndex];
    for (const [relation, ownerStableId] of [
      ['overlay', left.overlayOwnerStableId],
      ['attachment', left.attachmentOwnerStableId],
      ['composition', left.compositionOwnerStableId],
    ]) {
      if (!ownerStableId) continue;
      const owners = (cellsByStableId.get(ownerStableId) || [])
        .filter((candidate) => candidate.id !== left.id);
      if (!owners.length) {
        findings.push({
          type: `serialized-${relation}-owner-missing`,
          node: { id: left.id, stableId: left.stableId, ...left.absoluteRect },
          ownerStableId,
        });
        continue;
      }
      if (relation === 'composition' || relation === 'attachment') continue;
      if (owners.some((owner) => overlapsOrTouches(left.absoluteRect, owner.absoluteRect))) continue;
      findings.push({
        type: `serialized-${relation}-detached`,
        node: { id: left.id, stableId: left.stableId, ...left.absoluteRect },
        owners: owners.map((owner) => ({
          id: owner.id,
          stableId: owner.stableId,
          ...owner.absoluteRect,
        })),
      });
    }
    const owner = containerById.get(left.parent);
    if (owner && !strictlyContains(owner.absoluteRect, left.absoluteRect, 0)) {
      findings.push({
        type: 'serialized-node-outside-step',
        node: { id: left.id, stableId: left.stableId, ...left.absoluteRect },
        step: { id: owner.id, ...owner.absoluteRect },
      });
    }
    for (let rightIndex = leftIndex + 1; rightIndex < graphNodes.length; rightIndex += 1) {
      const right = graphNodes[rightIndex];
      if (!overlapsOrTouches(left.absoluteRect, right.absoluteRect)) continue;
      const sameSideNestedObjectBraces = String(left.graphLabels || '').split(',').includes('ObjectBrace')
        && String(right.graphLabels || '').split(',').includes('ObjectBrace')
        && left.objectFamilyStableId
        && left.objectFamilyStableId === right.objectFamilyStableId
        && left.objectBraceSide === right.objectBraceSide;
      if (sameSideNestedObjectBraces) continue;
      const objectBraceMosaicSeam = (
        (
          String(left.graphLabels || '').split(',').includes('ObjectBrace')
          && left.objectBraceMosaicNeighborStableId === right.stableId
        )
        || (
          String(right.graphLabels || '').split(',').includes('ObjectBrace')
          && right.objectBraceMosaicNeighborStableId === left.stableId
        )
      ) && !overlapsWithArea(left.absoluteRect, right.absoluteRect);
      if (objectBraceMosaicSeam) continue;
      const leftMosaicOwners = String(left.mosaicOwnerStableIds || '').split(',').filter(Boolean);
      const rightMosaicOwners = String(right.mosaicOwnerStableIds || '').split(',').filter(Boolean);
      if (
        leftMosaicOwners.some((ownerId) => rightMosaicOwners.includes(ownerId))
        && !overlapsWithArea(left.absoluteRect, right.absoluteRect)
      ) continue;
      const isExplicitOverlay = (
        isCompositionAncestor(left, right.stableId)
        || isCompositionAncestor(right, left.stableId)
      );
      if (isExplicitOverlay) continue;
      findings.push({
        type: 'serialized-node-intersection',
        left: { id: left.id, stableId: left.stableId, ...left.absoluteRect },
        right: { id: right.id, stableId: right.stableId, ...right.absoluteRect },
      });
    }
  }
  return {
    id: 'serialized-drawio-element-boundaries',
    description: 'Serialized mxCell containers, folding controls, and graph nodes do not cross or touch element boundaries.',
    status: findings.length ? 'fail' : 'pass',
    findingCount: findings.length,
    findings,
  };
}

function writeAutoCheckReport(outputPath, payload) {
  writeTextAtomically(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
}

function firstFreeHorizontal(positions, preferredY, x = 0) {
  let y = preferredY;
  const occupied = new Set([...positions.values()].filter((pos) => pos.x === x).map((pos) => pos.y));
  while (occupied.has(y)) y += 1;
  return y;
}

function firstFreeHorizontalIgnoring(positions, preferredY, x = 0, ignoredKey = null) {
  let y = preferredY;
  const occupied = new Set([...positions.entries()]
    .filter(([key, pos]) => key !== ignoredKey && pos.x === x)
    .map(([, pos]) => pos.y));
  while (occupied.has(y)) y += 1;
  return y;
}

function firstRowAfterRightFootprint(positions, preferredY, x, width = Number.POSITIVE_INFINITY) {
  let y = preferredY;
  const finiteWidth = Number.isFinite(width) ? Math.max(0, width) : Number.POSITIVE_INFINITY;
  while ([...positions.values()].some((pos) => (
    Number.isFinite(pos.x)
    && Number.isFinite(pos.y)
    && positionOccupiesHorizontalBand(pos, y, x)
    && pos.x >= x
    && pos.x <= x + finiteWidth
  ))) {
    y += 1;
  }
  return y;
}

function positionOccupiesHorizontalBand(pos, candidateY, candidateX) {
  const useFamilyBand = Number.isFinite(candidateX) && Number.isFinite(pos.x) && pos.x > candidateX;
  const minY = useFamilyBand && Number.isFinite(pos.fanoutFamilyMinY)
    ? Math.min(pos.y, pos.fanoutFamilyMinY) - 0.5
    : pos.y;
  const maxY = useFamilyBand && Number.isFinite(pos.fanoutFamilyMaxY)
    ? Math.max(pos.y, pos.fanoutFamilyMaxY) + 0.5
    : pos.y;
  return candidateY >= minY && candidateY <= maxY;
}

function firstFreeSlot(positions, preferredX, preferredY) {
  let y = preferredY;
  while ([...positions.values()].some((pos) => pos.x === preferredX && sameGridRow(pos.y, y))) y += 1;
  return { x: preferredX, y };
}

function occupiedSlotKeys(positions, preferredX, preferredY) {
  return [...positions.entries()]
    .filter(([, pos]) => pos.x === preferredX && sameGridRow(pos.y, preferredY))
    .map(([key]) => key);
}

function firstFreeVertical(positions, preferredX, y) {
  let x = preferredX;
  const occupied = new Set([...positions.values()]
    .filter((pos) => pos.y === y)
    .map((pos) => pos.x));
  while (occupied.has(x)) x += 1;
  return x;
}

function nodeHeightForFanout(node) {
  if (!node) return 52;
  if (isBracketLayoutNode(node)) return 50;
  if (hasLabel(node, 'Loop')) return 40;
  if (isObjectBraceNode(node)) return 30;
  if (isCurrentNodeBranch(node) || hasLabel(node, 'Switch') || hasLabel(node, 'Case')) return 60;
  if (isFlowJoinNode(node) || isDataJoinNode(node)) return 31;
  if (hasLabel(node, 'EndProxy') || hasLabel(node, 'FunctionEnd')) return 74;
  if (hasLabel(node, 'Return')) return 50;
  if (isValueOutcomeNode(node)) return 42;
  if (
    hasLabel(node, 'Call')
    || hasLabel(node, 'Method')
    || hasLabel(node, 'Fn')
    || hasLabel(node, 'Request')
    || hasLabel(node, 'VisualProxy')
  ) return 30;
  return 52;
}

const FANOUT_SIBLING_GAP = 26 / DRAWIO_GRID_Y;

function sortSlotEdgesBySourceOrder(edges, nodeByKey) {
  return [...edges].sort((left, right) => {
    const leftNode = nodeByKey.get(left.end);
    const rightNode = nodeByKey.get(right.end);
    const declaredOrder = (edge, target) => Number(
      propValue(
        edge?.props,
        'argumentIndex',
        'argument_index',
        'fieldIndex',
        'field_index',
        'sequenceOrder',
        'sequence_order',
      ) ?? propValue(
        target?.props,
        'argumentIndex',
        'argument_index',
        'fieldIndex',
        'field_index',
        'sequenceOrder',
        'sequence_order',
      ),
    );
    const leftDeclaredOrder = declaredOrder(left, leftNode);
    const rightDeclaredOrder = declaredOrder(right, rightNode);
    return (Number.isFinite(leftDeclaredOrder) ? leftDeclaredOrder : Number.MAX_SAFE_INTEGER)
        - (Number.isFinite(rightDeclaredOrder) ? rightDeclaredOrder : Number.MAX_SAFE_INTEGER)
      || nodeOperationIndex(leftNode) - nodeOperationIndex(rightNode)
      || Number(leftNode?.props?.start_line ?? leftNode?.props?.startLine ?? Number.MAX_SAFE_INTEGER)
        - Number(rightNode?.props?.start_line ?? rightNode?.props?.startLine ?? Number.MAX_SAFE_INTEGER)
      || Number(leftNode?.props?.start_column ?? leftNode?.props?.startColumn ?? Number.MAX_SAFE_INTEGER)
        - Number(rightNode?.props?.start_column ?? rightNode?.props?.startColumn ?? Number.MAX_SAFE_INTEGER)
      || String(left.end).localeCompare(String(right.end));
  });
}

function nestedFanoutSlotEdges(node, nodeByKey, outgoingBySource) {
  const outgoing = outgoingBySource.get(node?.key) || [];
  const byType = new Map();
  for (const edge of outgoing) byType.set(edge.type, [...(byType.get(edge.type) || []), edge]);
  let slotEdges = [];
  if (isCurrentNodeCall(node)) {
    slotEdges = (byType.get('ARG') || []).length ? byType.get('ARG') : (byType.get('VALUE') || []);
  } else if (isCurrentNodeObjectSlot(node)) {
    slotEdges = (byType.get('FIELD') || []).length ? byType.get('FIELD') : (byType.get('ARG') || []);
  }
  return sortSlotEdgesBySourceOrder(
    slotEdges.map((edge) => visualSlotEdge(edge, nodeByKey, outgoingBySource)),
    nodeByKey,
  );
}

function fanoutVerticalFootprint(node, nodeByKey, outgoingBySource, seen = new Set(), options = {}) {
  const ownHalfHeight = nodeHeightForFanout(node) / 2 / DRAWIO_GRID_Y;
  const outgoing = outgoingBySource.get(node?.key) || [];
  const compactCallReturnMax = node
    && (hasLabel(node, 'Arg') || isObjectFieldNode(node))
    && (hasLabel(node, 'Call') || hasLabel(node, 'Request'))
    && !outgoing.some((edge) => edge.type === 'ARG' || edge.type === 'FIELD')
    && outgoing.some((edge) => CALL_TARGET_EDGE_TYPES.has(edge.type))
    ? ownHalfHeight + COMPACT_CALL_RETURN_PORT_GAP / DRAWIO_GRID_Y
    : ownHalfHeight;
  if (!node || seen.has(node.key)) return { min: -ownHalfHeight, max: compactCallReturnMax };
  const nextSeen = new Set(seen);
  nextSeen.add(node.key);
  const objectBraceFamilyId = options.includeObjectBraceFamily
    && isObjectBraceNode(node) && objectBraceSide(node) === 'left'
    ? objectBraceFamilyStableId(node)
    : '';
  const familyOpeningNodes = objectBraceFamilyId
    ? [...nodeByKey.values()].filter((candidate) => (
        isObjectBraceNode(candidate)
        && objectBraceSide(candidate) === 'left'
        && objectBraceFamilyStableId(candidate) === objectBraceFamilyId
      ))
    : [node];
  const slotChildIds = familyOpeningNodes.flatMap((opening) => (
    nestedFanoutSlotEdges(opening, nodeByKey, outgoingBySource).map((edge) => edge.end)
  ));
  const outcomeChildIds = isSlotBranchNode(node) || isOperandBranchNode(node)
    ? outgoing
      .filter((edge) => edge.type === 'TRUE' || edge.type === 'FALSE')
      .map((edge) => edge.end)
    : [];
  const children = [...new Set([...slotChildIds, ...outcomeChildIds])]
    .map((childId) => nodeByKey.get(childId))
    .filter(Boolean);
  let footprint = { min: -ownHalfHeight, max: compactCallReturnMax };
  if (children.length) {
    const childFootprints = children.map((child) => fanoutVerticalFootprint(
      child,
      nodeByKey,
      outgoingBySource,
      nextSeen,
      options,
    ));
    const childOffsets = [0];
    for (let index = 1; index < childFootprints.length; index += 1) {
      childOffsets.push(
        childOffsets[index - 1]
        + childFootprints[index - 1].max
        + FANOUT_SIBLING_GAP
        - childFootprints[index].min,
      );
    }
    const childMin = Math.min(...childFootprints.map((childFootprint, index) => childOffsets[index] + childFootprint.min));
    const childMax = Math.max(...childFootprints.map((childFootprint, index) => childOffsets[index] + childFootprint.max));
    const childCenter = (childMin + childMax) / 2;
    footprint = {
      min: Math.min(footprint.min, childMin - childCenter),
      max: Math.max(footprint.max, childMax - childCenter),
    };
  }

  const nestedDownEval = String(
    node.props?.nestedEvaluationDirection
    || node.props?.nested_evaluation_direction
    || '',
  ) === 'down'
    ? outgoing.find((edge) => edge.type === 'EVAL')
    : undefined;
  if (nestedDownEval) {
    const evalChild = nodeByKey.get(nestedDownEval.end);
    if (evalChild) {
      const evalFootprint = fanoutVerticalFootprint(
        evalChild,
        nodeByKey,
        outgoingBySource,
        nextSeen,
        options,
      );
      footprint.max = Math.max(footprint.max, 1 + evalFootprint.max);
      footprint.min = Math.min(footprint.min, 1 + evalFootprint.min);
    }
  }
  return {
    min: footprint.min,
    max: footprint.max,
  };
}

function fanoutOwnerStepStableId(node) {
  return String(
    node?.props?.owner_step_stable_id
    || node?.props?.ownerStepStableId
    || node?.props?.parentStepStableId
    || node?.props?.parent_step_stable_id
    || node?.props?.foldStepOwnerStableId
    || node?.props?.fold_step_owner_stable_id
    || '',
  ).trim();
}

function fanoutFamilyYs(
  positions,
  x,
  parentY,
  children,
  nodeByKey,
  outgoingBySource,
  rightFootprintWidths = [],
  options = {},
) {
  if (!children.length) return [];
  const minY = options.minY ?? Number.NEGATIVE_INFINITY;
  const ownerStepStableId = String(options.ownerStepStableId || '').trim();
  const footprints = children.map((child) => fanoutVerticalFootprint(
    child,
    nodeByKey,
    outgoingBySource,
    new Set(),
    options,
  ));
  const offsets = Array(children.length).fill(0);
  const lowerMiddleIndex = Math.floor(children.length / 2);
  const upperAnchorIndex = children.length % 2 === 0
    ? lowerMiddleIndex - 1
    : lowerMiddleIndex;
  if (children.length % 2 === 0) {
    offsets[upperAnchorIndex] = -FANOUT_SIBLING_GAP / 2 - footprints[upperAnchorIndex].max;
    offsets[lowerMiddleIndex] = FANOUT_SIBLING_GAP / 2 - footprints[lowerMiddleIndex].min;
  }
  for (let index = upperAnchorIndex - 1; index >= 0; index -= 1) {
    offsets[index] = offsets[index + 1]
      + footprints[index + 1].min
      - FANOUT_SIBLING_GAP
      - footprints[index].max;
  }
  for (let index = lowerMiddleIndex + 1; index < children.length; index += 1) {
    offsets[index] = offsets[index - 1]
      + footprints[index - 1].max
      + FANOUT_SIBLING_GAP
      - footprints[index].min;
  }
  const familyMinOffset = Math.min(...footprints.map((footprint, index) => offsets[index] + footprint.min));
  let startY = Math.max(parentY, minY - familyMinOffset);
  const initialStartY = startY;
  const occupied = [...positions.entries()]
    .filter(([key]) => {
      if (!ownerStepStableId) return true;
      const occupiedOwnerStepStableId = fanoutOwnerStepStableId(nodeByKey.get(key));
      return occupiedOwnerStepStableId === ownerStepStableId;
    })
    .map(([key, pos]) => ({
      key,
      x: pos.x,
      y: pos.y,
      footprint: fanoutVerticalFootprint(nodeByKey.get(key), nodeByKey, outgoingBySource),
    }));

  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    let requiredShift = 0;
    offsets.forEach((offset, index) => {
      const candidateY = startY + offset;
      const candidateFootprint = footprints[index];
      const candidateRightX = x + Math.max(0, rightFootprintWidths[index] || 0);
      occupied.forEach((item) => {
        if (item.x < x || item.x > candidateRightX) return;
        const candidateMin = candidateY + candidateFootprint.min;
        const candidateMax = candidateY + candidateFootprint.max;
        const occupiedMin = item.y + item.footprint.min;
        const occupiedMax = item.y + item.footprint.max;
        if (candidateMax + FANOUT_SIBLING_GAP <= occupiedMin || candidateMin - FANOUT_SIBLING_GAP >= occupiedMax) return;
        requiredShift = Math.max(requiredShift, occupiedMax + FANOUT_SIBLING_GAP - candidateMin);
      });
    });
    if (requiredShift <= 0) {
      if (process.env.DEBUG_FANOUT_FAMILY === '1' && startY !== initialStartY) {
        console.error(`[fanout:shift] x=${x} parentY=${parentY} initialY=${initialStartY} placedY=${startY} children=${children.map((child) => child?.key || '<missing>').join(',')} occupied=${occupied.map((item) => `${item.key}@${item.y}`).join(',')}`);
      }
      return offsets.map((offset) => startY + offset);
    }
    startY += requiredShift;
  }
  throw new Error(`newStraightDrawio could not place fanout family at x=${x}`);
}

function sameGridRow(left, right) {
  return Math.abs(left - right) < 1;
}

function assertLinearOutgoing(node, outgoing, options = {}) {
  if (!isCurrentNodeLinear(node, options)) return;
  const allowedContinuationTypes = hasLabel(node, 'Value')
    ? ['NEXT', 'VALUE', 'YIELDS_VALUE', 'ARROW', 'RESULT', 'ArgJoin', 'XOR_JOIN', 'DECLARES_FUNCTION']
    : isFieldJoinNode(node)
      ? ['NEXT', 'ARG', 'ArgJoin', 'XOR_JOIN', 'FIELD', 'FieldJoin', 'VALUE']
    : isLogicalOutcomeJoinNode(node)
      ? ['TRUE', 'FALSE']
    : hasLabel(node, 'Arg')
      ? ['NEXT', 'ARG', 'ArgJoin', 'XOR_JOIN', 'ARROW', 'RESULT']
      : ['NEXT', 'PARAM', 'ARG', 'ArgJoin', 'XOR_JOIN', 'ARROW', 'RESULT', 'FIELD', 'FieldJoin', 'VALUE', 'DECLARES_FUNCTION'];
  const structuralOutgoing = outgoing.filter((edge) => !isResourceEdge(edge));
  const continuationEdges = structuralOutgoing.filter((edge) => allowedContinuationTypes.includes(edge.type));
  const nextEdges = continuationEdges.filter((edge) => edge.type === 'NEXT');
  let effectiveContinuationEdges = nextEdges.length
    ? continuationEdges.filter((edge) => edge.type !== 'DECLARES_FUNCTION')
    : continuationEdges;
  if (hasLabel(node, 'CallbackFn') && effectiveContinuationEdges.some((edge) => edge.type === 'ArgJoin')) {
    effectiveContinuationEdges = effectiveContinuationEdges.filter((edge) => edge.type !== 'ARROW');
  }
  const effectiveNextEdges = effectiveContinuationEdges.filter((edge) => edge.type === 'NEXT');
  const effectiveNonNextEdges = effectiveContinuationEdges.filter((edge) => edge.type !== 'NEXT');
  if (effectiveContinuationEdges.length !== 1 || (effectiveNextEdges.length && effectiveNonNextEdges.length)) {
    const signature = outgoing.map((edge) => edge.type).join(',') || '<none>';
    throw new Error(`newStraightDrawio invariant failed for ${node.key}: ${node.labels.join(',')} must have exactly one ${allowedContinuationTypes.join('/')} continuation edge, got ${signature}`);
  }
}

function getLinearContinuationEdge(outgoing) {
  return outgoing.find((item) => !isResourceEdge(item) && item.type === 'PARAM')
    || outgoing.find((item) => !isResourceEdge(item) && item.type === 'NEXT')
    || outgoing.find((item) => !isResourceEdge(item) && item.type === 'TRUE')
    || outgoing.find((item) => !isResourceEdge(item) && item.type === 'FALSE')
    || outgoing.find((item) => !isResourceEdge(item) && item.type === 'ARG')
    || outgoing.find((item) => !isResourceEdge(item) && item.type === 'ArgJoin')
    || outgoing.find((item) => !isResourceEdge(item) && item.type === 'XOR_JOIN')
    || outgoing.find((item) => !isResourceEdge(item) && item.type === 'ARROW')
    || outgoing.find((item) => !isResourceEdge(item) && item.type === 'RESULT')
    || outgoing.find((item) => !isResourceEdge(item) && item.type === 'VALUE')
    || outgoing.find((item) => !isResourceEdge(item) && item.type === 'YIELDS_VALUE')
    || outgoing.find((item) => !isResourceEdge(item) && item.type === 'DECLARES_FUNCTION')
    || outgoing.find((item) => !isResourceEdge(item) && item.type === 'FieldJoin')
    || outgoing.find((item) => !isResourceEdge(item) && item.type === 'FIELD');
}

function routeExistingConnection(edge, positions) {
  const head = positions.get(edge.start);
  const tail = positions.get(edge.end);
  if (!head || !tail) {
    throw new Error(`newStraightDrawio cannot route ${edge.type}: missing endpoint coordinates ${edge.start} -> ${edge.end}`);
  }
  return {
    start: edge.start,
    end: edge.end,
    type: edge.type,
    props: {
      ...edge.props,
      stableId: edge.props?.stableId || edge.start,
      targetStableId: edge.props?.targetStableId || edge.end,
      layoutRouteReason: `newStraightDrawio direct route from ${head.x},${head.y} to ${tail.x},${tail.y}`,
    },
  };
}

function placeEdgeTargetIfNeeded({ edge, child, positions, x, y, reason, avoidRightFootprintWidth = 0, rightFootprintRowPicker = firstRowAfterRightFootprint, keepRequestedRow = false }) {
  if (!positions.has(child.key)) {
    const requestedSlotBlockers = occupiedSlotKeys(positions, x, y);
    const placedY = keepRequestedRow
      ? y
      : avoidRightFootprintWidth > 0
        ? rightFootprintRowPicker(positions, y, x, avoidRightFootprintWidth)
        : firstFreeSlot(positions, x, y).y;
    placeNode(
      positions,
      child,
      x,
      placedY,
      reason,
      'placeEdgeTargetIfNeeded',
      [
        makeTraceStep('placeEdgeTargetIfNeeded', {
          edgeType: edge.type,
          from: edge.start,
          requestedX: x,
          requestedY: y,
          placedX: x,
          placedY,
          requestedSlotBlockers,
          avoidRightFootprintWidth,
          keepRequestedRow,
          reason,
        }),
      ],
    );
  }
  return routeExistingConnection(edge, positions);
}

function nodeOperationIndex(node) {
  const value = node?.props?.operation_index ?? node?.props?.operationIndex;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number.MAX_SAFE_INTEGER;
}

function stableIdStartLine(stableId) {
  const parts = String(stableId || '').split(':');
  const line = Number(parts[parts.length - 4]);
  return Number.isFinite(line) ? line : undefined;
}

function firstSameLineBranchContinuation(startKey, line, nodeByKey, outgoingBySource, limit = 20) {
  let key = startKey;
  const seen = new Set();
  for (let index = 0; key && index < limit && !seen.has(key); index += 1) {
    seen.add(key);
    const node = nodeByKey.get(key);
    if (!node) return null;
    const nodeLine = stableIdStartLine(node.key);
    if (Number.isFinite(nodeLine) && nodeLine !== line) return null;
    if (isCurrentNodeBranch(node)) return node;
    const nextEdges = (outgoingBySource.get(node.key) || []).filter((edge) => edge.type === 'NEXT');
    if (nextEdges.length !== 1) return null;
    key = nextEdges[0].end;
  }
  return null;
}

function isSameLineBooleanBranchChain(branch, rightChild, rightLane, downLane, nodeByKey, outgoingBySource) {
  if (!branch || !rightChild) return false;
  const branchLine = stableIdStartLine(branch.key);
  if (!Number.isFinite(branchLine)) return false;
  const chainBranch = isCurrentNodeBranch(rightChild)
    ? rightChild
    : firstSameLineBranchContinuation(rightChild.key, branchLine, nodeByKey, outgoingBySource);
  if (!chainBranch) return false;

  const branchJoin = chooseBranchLanes(branch, rightLane.type === 'TRUE' ? rightLane : downLane, rightLane.type === 'FALSE' ? rightLane : downLane, nodeByKey, outgoingBySource).joinKey;
  if (!branchJoin) return false;
  const rightOutgoing = outgoingBySource.get(chainBranch.key) || [];
  const rightTrue = rightOutgoing.find((edge) => edge.type === 'TRUE');
  const rightFalse = rightOutgoing.find((edge) => edge.type === 'FALSE');
  if (!rightTrue || !rightFalse) return false;
  const rightJoin = chooseBranchLanes(chainBranch, rightTrue, rightFalse, nodeByKey, outgoingBySource).joinKey;
  return rightJoin === branchJoin || canReachStop(chainBranch.key, branchJoin, outgoingBySource, nodeByKey);
}

function buildOutgoingBySource(edges) {
  const result = new Map();
  for (const edge of edges) {
    if (!isCoordinateEdge(edge)) continue;
    result.set(edge.start, [...(result.get(edge.start) || []), edge]);
  }
  for (const list of result.values()) {
    list.sort((left, right) => {
      const typeRank = { NEXT: 0, REPEATS: 1, REJOINS: 2, TRUE: 3, FALSE: 4, MERGES_TO: 5 };
      return ((typeRank[left.type] ?? 99) - (typeRank[right.type] ?? 99))
        || String(left.end).localeCompare(String(right.end));
    });
  }
  return result;
}

function annotateCallCopyCounts(nodes, edges) {
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  const callEdgesByTarget = new Map();
  for (const edge of edges) {
    const invocationType = callInvocationType(edge);
    if (invocationType !== 'CALL' && invocationType !== 'REQUEST') continue;
    const callSiteStableId = callSiteStableIdForEdge(edge);
    const source = nodeByKey.get(callSiteStableId);
    const target = nodeByKey.get(edge.end);
    if (!source || !target?.labels?.includes('Fn')) continue;
    if (!(source.labels?.some((label) => label === 'Call' || label === 'Request' || label === 'Op') || isArgJoinNode(source))) continue;
    if (!callEdgesByTarget.has(edge.end)) callEdgesByTarget.set(edge.end, []);
    if (!callEdgesByTarget.get(edge.end).some((candidate) => callSiteStableIdForEdge(candidate) === callSiteStableId)) {
      callEdgesByTarget.get(edge.end).push(edge);
    }
  }

  const copyMetaBySource = new Map();
  for (const targetEdges of callEdgesByTarget.values()) {
    const sortedEdges = [...targetEdges].sort((left, right) => {
      const leftSource = nodeByKey.get(callSiteStableIdForEdge(left));
      const rightSource = nodeByKey.get(callSiteStableIdForEdge(right));
      return nodeOperationIndex(leftSource) - nodeOperationIndex(rightSource)
        || String(callSiteStableIdForEdge(left)).localeCompare(String(callSiteStableIdForEdge(right)));
    });
    if (sortedEdges.length < 2) continue;
    sortedEdges.forEach((edge, index) => {
      copyMetaBySource.set(callSiteStableIdForEdge(edge), {
        visualCopyIndex: index + 1,
        visualCopyCount: sortedEdges.length,
      });
    });
  }

  return nodes.map((node) => {
    const meta = copyMetaBySource.get(node.key);
    return meta ? { ...node, props: { ...node.props, ...meta } } : node;
  });
}

function edgeCopyKey(edge) {
  return `${edge.type}:${edge.start}->${edge.end}:${edge.id || ''}`;
}

function buildResourceCopyMetaByEdge(edges, nodeByKey) {
  const edgesByTarget = new Map();
  for (const edge of edges) {
    if (!RESOURCE_EDGE_TYPES.has(edge.type) && !isStateResourceValueEdge(edge, nodeByKey)) continue;
    if (!nodeByKey.has(edge.start) || !nodeByKey.has(edge.end)) continue;
    const target = nodeByKey.get(edge.end);
    if (hasLabel(target, 'Fn') || hasLabel(target, 'Method')) continue;
    if (!edgesByTarget.has(edge.end)) edgesByTarget.set(edge.end, []);
    edgesByTarget.get(edge.end).push(edge);
  }
  const result = new Map();
  for (const targetEdges of edgesByTarget.values()) {
    const sortedEdges = [...targetEdges].sort((left, right) => {
      const leftSource = nodeByKey.get(left.start);
      const rightSource = nodeByKey.get(right.start);
      return nodeOperationIndex(leftSource) - nodeOperationIndex(rightSource)
        || String(left.start).localeCompare(String(right.start))
        || String(left.type).localeCompare(String(right.type));
    });
    if (sortedEdges.length < 2) continue;
    sortedEdges.forEach((edge, index) => {
      result.set(edgeCopyKey(edge), {
        visualCopyIndex: index + 1,
        visualCopyCount: sortedEdges.length,
      });
    });
  }
  return result;
}

function buildAccessorStorageCopyMetaByUse(edges, nodeByKey) {
  const usesByStorage = new Map();
  for (const edge of edges) {
    if (edge.type !== 'READ' && edge.type !== 'WRITE') continue;
    const target = nodeByKey.get(edge.end);
    if (!hasLabel(target, 'Fn') || !(hasLabel(target, 'Getter') || hasLabel(target, 'Setter'))) continue;
    for (const storageId of edge.props?.storage_stable_ids || []) {
      if (!usesByStorage.has(storageId)) usesByStorage.set(storageId, []);
      usesByStorage.get(storageId).push({ edge, storageId });
    }
  }

  const result = new Map();
  for (const uses of usesByStorage.values()) {
    const sortedUses = [...uses].sort((left, right) => {
      const leftSource = nodeByKey.get(left.edge.start);
      const rightSource = nodeByKey.get(right.edge.start);
      return nodeOperationIndex(leftSource) - nodeOperationIndex(rightSource)
        || String(left.edge.start).localeCompare(String(right.edge.start));
    });
    sortedUses.forEach(({ edge, storageId }, index) => {
      result.set(`${edgeCopyKey(edge)}:${storageId}`, {
        visualCopyIndex: index + 1,
        visualCopyCount: sortedUses.length,
      });
    });
  }
  return result;
}

const mergePassthroughEdgeTypes = ['NEXT', 'REJOINS', 'MERGES_TO', 'TRUE', 'FALSE'];

function isMergeNode(node) {
  return isFlowJoinNode(node);
}

function isFanoutMergeNode(node) {
  return isArgJoinNode(node)
    || isOperandJoinNode(node)
    || isDataJoinNode(node)
    || isFieldJoinNode(node);
}

function isFanoutContextMergeNode(node) {
  return isFanoutMergeNode(node)
    || isMergeNode(node);
}

function isArgumentClosureTarget(edge, node) {
  return edge?.type === 'ArgJoin' && isCallFinishNode(node);
}

function isObjectFieldClosingMerge(node, outgoing, nodeByKey) {
  if (!isObjectFieldNode(node) || outgoing.length !== 1) return false;
  const edge = outgoing[0];
  if (edge.type !== 'FieldJoin' && edge.type !== 'FIELD' && edge.type !== 'NEXT') return false;
  return isFanoutMergeNode(nodeByKey.get(edge.end));
}

function nestedFanoutDepthFrom(nodeKey, nodeByKey, outgoingBySource, seen = new Set()) {
  if (!nodeKey || seen.has(nodeKey)) return 0;
  seen.add(nodeKey);
  const node = nodeByKey.get(nodeKey);
  if (!node) return 0;
  if (isFnVisualProxyNode(node)) return 0;
  const outgoing = outgoingBySource.get(nodeKey) || [];
  if (isFanoutMergeNode(node)) {
    const nestedContinuation = isOperandJoinNode(node)
      ? outgoing.find((edge) => edge.type === 'NEXT')
      : undefined;
    return nestedContinuation
      ? 1 + nestedFanoutDepthFrom(nestedContinuation.end, nodeByKey, outgoingBySource, seen)
      : 0;
  }
  const argOrFieldEdges = outgoing.filter((edge) => edge.type === 'ARG' || edge.type === 'ArgJoin' || edge.type === 'FIELD' || edge.type === 'FieldJoin' || edge.type === 'VALUE');
  if ((isCurrentNodeCall(node) || isCurrentNodeObjectSlot(node) || isLocalValueDeclarationNode(node)) && argOrFieldEdges.length) {
    return 1 + Math.max(0, ...argOrFieldEdges.map((edge) => nestedFanoutDepthFrom(edge.end, nodeByKey, outgoingBySource, new Set(seen))));
  }
  if (isSlotBranchNode(node) || isOperandBranchNode(node)) {
    const branchEdges = outgoing.filter((edge) => edge.type === 'TRUE' || edge.type === 'FALSE');
    if (branchEdges.length) {
      return 1 + Math.max(0, ...branchEdges.map((edge) => nestedFanoutDepthFrom(edge.end, nodeByKey, outgoingBySource, new Set(seen))));
    }
  }
  const evaluationEdges = outgoing.filter((edge) => edge.type === 'EVAL');
  const evaluationDepth = evaluationEdges.length
    ? Math.max(0, ...evaluationEdges.map((edge) => (
        nestedFanoutDepthFrom(edge.end, nodeByKey, outgoingBySource, new Set(seen))
      )))
    : 0;
  const continuation = outgoing.find((edge) => edge.type === 'NEXT' || edge.type === 'ARROW' || edge.type === 'ArgJoin' || edge.type === 'XOR_JOIN' || edge.type === 'FIELD' || edge.type === 'FieldJoin' || edge.type === 'VALUE');
  if (!continuation) return evaluationDepth;
  const child = nodeByKey.get(continuation.end);
  const continuationDepth = isFanoutMergeNode(child)
    ? 1
    : nestedFanoutDepthFrom(continuation.end, nodeByKey, outgoingBySource, seen);
  return Math.max(evaluationDepth, continuationDepth);
}

function nestedFanoutSpanFrom(nodeKey, nodeByKey, outgoingBySource, seen = new Set()) {
  if (!nodeKey || seen.has(nodeKey)) return 0;
  seen.add(nodeKey);
  const node = nodeByKey.get(nodeKey);
  if (!node) return 0;
  if (isFnVisualProxyNode(node)) return 0;
  const outgoing = outgoingBySource.get(nodeKey) || [];
  if (isFanoutMergeNode(node)) {
    const nestedContinuation = isOperandJoinNode(node)
      ? outgoing.find((edge) => edge.type === 'NEXT')
      : undefined;
    return nestedContinuation
      ? horizontalStepForNode(node) + nestedFanoutSpanFrom(nestedContinuation.end, nodeByKey, outgoingBySource, seen)
      : 0;
  }
  const argOrFieldEdges = outgoing.filter((edge) => edge.type === 'ARG' || edge.type === 'ArgJoin' || edge.type === 'FIELD' || edge.type === 'FieldJoin' || edge.type === 'VALUE');
  if ((isCurrentNodeCall(node) || isCurrentNodeObjectSlot(node) || isLocalValueDeclarationNode(node)) && argOrFieldEdges.length) {
    const childSpans = argOrFieldEdges.map((edge) => (
      isFanoutMergeNode(nodeByKey.get(edge.end))
        ? horizontalStepForNode(nodeByKey.get(edge.end))
        : nestedFanoutSpanFrom(edge.end, nodeByKey, outgoingBySource, new Set(seen))
    ));
    const hasNestedChild = argOrFieldEdges.some((edge) => !isFanoutMergeNode(nodeByKey.get(edge.end)));
    return (hasNestedChild ? horizontalStepForNode(node) : 0) + Math.max(0, ...childSpans);
  }
  if (isSlotBranchNode(node) || isOperandBranchNode(node)) {
    const branchEdges = outgoing.filter((edge) => edge.type === 'TRUE' || edge.type === 'FALSE');
    if (branchEdges.length) {
      return 1 + Math.max(0, ...branchEdges.map((edge) => (
        nestedFanoutSpanFrom(edge.end, nodeByKey, outgoingBySource, new Set(seen))
      )));
    }
  }
  const evaluationEdges = outgoing.filter((edge) => edge.type === 'EVAL');
  const evaluationSpan = evaluationEdges.length
    ? Math.max(0, ...evaluationEdges.map((edge) => (
        nestedFanoutSpanFrom(edge.end, nodeByKey, outgoingBySource, new Set(seen))
      )))
    : 0;
  const continuation = outgoing.find((edge) => edge.type === 'NEXT' || edge.type === 'ARROW' || edge.type === 'ArgJoin' || edge.type === 'XOR_JOIN' || edge.type === 'FIELD' || edge.type === 'FieldJoin' || edge.type === 'VALUE');
  if (!continuation) return evaluationSpan;
  const child = nodeByKey.get(continuation.end);
  if (isFanoutMergeNode(child)) return Math.max(evaluationSpan, horizontalStepForNode(child));
  const childSpan = nestedFanoutSpanFrom(continuation.end, nodeByKey, outgoingBySource, seen);
  const continuationSpan = continuation.type === 'ARROW' || continuation.type === 'ArgJoin' || continuation.type === 'XOR_JOIN'
    ? horizontalStepForNode(node) + childSpan
    : childSpan;
  return Math.max(evaluationSpan, continuationSpan);
}

function visualSlotEdge(edge, nodeByKey, outgoingBySource) {
  const target = nodeByKey.get(edge.end);
  if (edge.type !== 'ARG' || !target || !hasLabel(target, 'Arg')) return edge;
  if (hasLabel(target, 'Object')) {
    return {
      ...edge,
      props: {
        ...edge.props,
        sourcePort: edge.props?.sourcePort || 'right',
        targetPort: edge.props?.targetPort || 'left',
        layoutRouteReason: edge.props?.layoutRouteReason
          || `newStraightDrawio horizontal object argument ${target.key}`,
      },
    };
  }
  const outgoing = outgoingBySource.get(target.key) || [];
  if (outgoing.length !== 1 || outgoing[0].type !== 'ARG') return edge;
  const objectTarget = nodeByKey.get(outgoing[0].end);
  if (!objectTarget || !hasLabel(objectTarget, 'Object')) return edge;
  return {
    ...edge,
    end: objectTarget.key,
    props: {
      ...edge.props,
      collapsedArgStableId: target.key,
      originalTargetStableId: edge.end,
      layoutRouteReason: `newStraightDrawio collapsed object argument wrapper ${target.key} -> ${objectTarget.key}`,
    },
  };
}

function primaryFanoutIndex(slotEdges, nodeByKey, outgoingBySource) {
  if (slotEdges.length <= 1) return 0;
  return slotEdges
    .map((edge, index) => ({
      index,
      depth: nestedFanoutDepthFrom(edge.end, nodeByKey, outgoingBySource),
    }))
    .sort((left, right) => (right.depth - left.depth) || (right.index - left.index))[0].index;
}

function requiredFanoutMergeX(ownerX, slotEdges, nodeByKey, outgoingBySource) {
  if (!slotEdges.length) return undefined;
  const maxSpan = Math.max(0, ...slotEdges.map((edge) => nestedFanoutSpanFrom(edge.end, nodeByKey, outgoingBySource)));
  if (maxSpan <= 1) return undefined;
  return ownerX + 1 + maxSpan;
}

function mergePassthroughEdgeFor(node, outgoingBySource) {
  if (!isMergeNode(node)) return null;
  return (outgoingBySource.get(node.key) || [])
    .filter((edge) => mergePassthroughEdgeTypes.includes(edge.type))
    .sort((left, right) => {
      const typeRank = { NEXT: 0, REPEATS: 1, REJOINS: 2, MERGES_TO: 3, TRUE: 4, FALSE: 5 };
      return ((typeRank[left.type] ?? 99) - (typeRank[right.type] ?? 99))
        || String(left.end).localeCompare(String(right.end));
    })[0] || null;
}

function effectiveTargetForEdge(edge, nodeByKey, outgoingBySource) {
  const mergePath = [];
  let effectiveEnd = edge.end;
  const seen = new Set([edge.start]);

  while (effectiveEnd && !seen.has(effectiveEnd)) {
    seen.add(effectiveEnd);
    const target = nodeByKey.get(effectiveEnd);
    if (!target || !isMergeNode(target)) break;
    mergePath.push(effectiveEnd);
    const nextEdge = mergePassthroughEdgeFor(target, outgoingBySource);
    if (!nextEdge) break;
    effectiveEnd = nextEdge.end;
  }

  if (!mergePath.length || effectiveEnd === edge.end) {
    return { edge, mergePath };
  }

  return {
    mergePath,
    edge: {
      ...edge,
      end: effectiveEnd,
      props: {
        ...edge.props,
        collapsedMergePath: mergePath,
        originalTargetStableId: edge.end,
        layoutRouteReason: `newStraightDrawio collapsed merge target ${edge.end} -> ${effectiveEnd}`,
      },
    },
  };
}

function reachableDistances(startKey, outgoingBySource, nodeByKey, limit = 500) {
  const distances = new Map([[startKey, 0]]);
  const queue = [startKey];
  for (let index = 0; index < queue.length && index < limit; index += 1) {
    const key = queue[index];
    const node = nodeByKey.get(key);
    const distance = distances.get(key) || 0;
    for (const edge of outgoingBySource.get(key) || []) {
      if (!mergePassthroughEdgeTypes.includes(edge.type)) continue;
      const target = nodeByKey.get(edge.end);
      if (!target) continue;
      if (distances.has(edge.end)) continue;
      const edgeCost = isMergeNode(node) ? 0 : 1;
      distances.set(edge.end, distance + edgeCost);
      if (edgeCost === 0) queue.splice(index + 1, 0, edge.end);
      else queue.push(edge.end);
    }
  }
  return distances;
}

function canReachStop(startKey, stopKey, outgoingBySource, nodeByKey, memo = new Map(), visiting = new Set(), limit = 500) {
  if (!startKey || !stopKey) return false;
  if (startKey === stopKey) return true;
  if (memo.has(startKey)) return memo.get(startKey);
  if (visiting.has(startKey) || visiting.size > limit) return false;
  visiting.add(startKey);

  let result = false;
  for (const edge of outgoingBySource.get(startKey) || []) {
    if (!mergePassthroughEdgeTypes.includes(edge.type)) continue;
    const effective = effectiveTargetForEdge(edge, nodeByKey, outgoingBySource).edge;
    if (!nodeByKey.has(effective.end) && effective.end !== stopKey) continue;
    if (canReachStop(effective.end, stopKey, outgoingBySource, nodeByKey, memo, visiting, limit)) {
      result = true;
      break;
    }
  }

  visiting.delete(startKey);
  memo.set(startKey, result);
  return result;
}

function rightSubtreeFootprintRows(startKey, stopKey, outgoingBySource, nodeByKey, limit = 500) {
  if (!startKey || !stopKey || startKey === stopKey) return 1;

  const reachMemo = new Map();
  if (!canReachStop(startKey, stopKey, outgoingBySource, nodeByKey, reachMemo)) return 1;

  const seen = new Set();
  const queue = [startKey];
  let foundStop = false;
  let rows = 0;

  for (let index = 0; index < queue.length && index < limit; index += 1) {
    const key = queue[index];
    if (seen.has(key)) continue;
    seen.add(key);

    const node = nodeByKey.get(key);
    if (!node) continue;
    if (!isMergeNode(node)) rows += 1;

    for (const edge of outgoingBySource.get(key) || []) {
      if (!mergePassthroughEdgeTypes.includes(edge.type)) continue;
      const effective = effectiveTargetForEdge(edge, nodeByKey, outgoingBySource).edge;
      if (effective.end === stopKey) {
        foundStop = true;
        continue;
      }
      if (!canReachStop(effective.end, stopKey, outgoingBySource, nodeByKey, reachMemo)) continue;
      if (!seen.has(effective.end)) queue.push(effective.end);
    }
  }

  return foundStop ? Math.max(1, rows) : 1;
}

function chooseBranchLanes(branch, firstEdge, secondEdge, nodeByKey, outgoingBySource) {
  const outcomes = [firstEdge, secondEdge].map((edge) => ({
    edge,
    target: nodeByKey.get(effectiveTargetForEdge(edge, nodeByKey, outgoingBySource).edge.end),
    distances: reachableDistances(edge.end, outgoingBySource, nodeByKey),
  }));
  const common = [...outcomes[0].distances.keys()]
    .filter((key) => outcomes[1].distances.has(key))
    .map((key) => ({
      key,
      distances: outcomes.map((outcome) => outcome.distances.get(key)),
      totalDistance: outcomes.reduce((sum, outcome) => sum + (outcome.distances.get(key) || 0), 0),
      op: nodeOperationIndex(nodeByKey.get(key)),
      isJoin: isMergeNode(nodeByKey.get(key)),
    }))
    .sort((left, right) => (left.totalDistance - right.totalDistance)
      || (left.op - right.op)
      || left.key.localeCompare(right.key));

  const join = common.find((candidate) => candidate.isJoin) || common[0];
  if (join) {
    if (join.distances[0] !== join.distances[1]) {
      const shorterIndex = join.distances[0] < join.distances[1] ? 0 : 1;
      const longerIndex = 1 - shorterIndex;
      return {
        down: outcomes[shorterIndex].edge,
        right: outcomes[longerIndex].edge,
        joinKey: join.key,
        reason: `longer sequential path moves right before join ${join.key}: ${join.distances[longerIndex]}>${join.distances[shorterIndex]}`,
      };
    }

    const branchStepStableId = String(branch?.props?.parentStepStableId || '').trim();
    const conditionContinuations = outcomes.filter((outcome) => (
      isFlowBranchNode(outcome.target)
      && branchStepStableId
      && String(outcome.target?.props?.parentStepStableId || '').trim() === branchStepStableId
    ));
    if (conditionContinuations.length === 1) {
      const downOutcome = conditionContinuations[0];
      const rightOutcome = outcomes.find((outcome) => outcome !== downOutcome);
      return {
        down: downOutcome.edge,
        right: rightOutcome.edge,
        joinKey: join.key,
        reason: 'equal path lengths keep the sequential condition continuation in-column and move the separate optional region right',
      };
    }

    const footprints = outcomes.map((outcome) => (
      rightSubtreeFootprintRows(outcome.edge.end, join.key, outgoingBySource, nodeByKey)
    ));
    if (footprints[0] !== footprints[1]) {
      const shorterIndex = footprints[0] < footprints[1] ? 0 : 1;
      const longerIndex = 1 - shorterIndex;
      return {
        down: outcomes[shorterIndex].edge,
        right: outcomes[longerIndex].edge,
        joinKey: join.key,
        reason: `larger optional path moves right before join ${join.key}: ${footprints[longerIndex]}>${footprints[shorterIndex]} nodes`,
      };
    }
  }

  const reachableSizes = outcomes.map((outcome) => Math.max(1, outcome.distances.size));
  if (reachableSizes[0] !== reachableSizes[1]) {
    const shorterIndex = reachableSizes[0] < reachableSizes[1] ? 0 : 1;
    const longerIndex = 1 - shorterIndex;
    return {
      down: outcomes[shorterIndex].edge,
      right: outcomes[longerIndex].edge,
      joinKey: join?.key,
      reason: `fallback without a measurable join path: larger reachable subgraph moves right ${reachableSizes[longerIndex]}>${reachableSizes[shorterIndex]}`,
    };
  }

  const [down, right] = outcomes.map((outcome) => outcome.edge).sort((left, rightEdge) => {
    const leftTarget = effectiveTargetForEdge(left, nodeByKey, outgoingBySource).edge.end;
    const rightTarget = effectiveTargetForEdge(rightEdge, nodeByKey, outgoingBySource).edge.end;
    return nodeOperationIndex(nodeByKey.get(leftTarget)) - nodeOperationIndex(nodeByKey.get(rightTarget))
      || leftTarget.localeCompare(rightTarget);
  });
  return {
    down,
    right,
    joinKey: join?.key,
    reason: 'equal branch sizes use stable target order without outcome-type semantics',
  };
}

function splitOperandBranchEdges(edges, nodeByKey, outgoingBySource) {
  const effectiveEdges = edges.map((edge) => (
    (edge.props?.protocolRole || edge.props?.protocol_role) === 'assignment-return'
      ? edge
      : effectiveTargetForEdge(edge, nodeByKey, outgoingBySource).edge
  ));
  const joinEdges = effectiveEdges.filter((edge) => isOperandJoinNode(nodeByKey.get(edge.end)));
  const continuation = effectiveEdges.find((edge) => isOperandBranchNode(nodeByKey.get(edge.end))) || null;
  const terminalEdges = effectiveEdges.filter((edge) => edge !== continuation && !joinEdges.includes(edge));
  return { continuation, joinEdges, terminalEdges };
}

function operandChainLengthFrom(branchKey, nodeByKey, outgoingBySource, seen = new Set()) {
  if (!branchKey || seen.has(branchKey)) return 0;
  seen.add(branchKey);
  const branch = nodeByKey.get(branchKey);
  if (!isOperandBranchNode(branch)) return 0;
  const branchEdges = (outgoingBySource.get(branchKey) || [])
    .filter((edge) => edge.type === 'TRUE' || edge.type === 'FALSE');
  const { continuation } = splitOperandBranchEdges(branchEdges, nodeByKey, outgoingBySource);
  return 1 + (continuation ? operandChainLengthFrom(continuation.end, nodeByKey, outgoingBySource, seen) : 0);
}

function measureFlowConditionOperandGraph(rootEdges, nodeByKey, outgoingBySource) {
  const depthByKey = new Map();
  const terminalBySignature = new Map();
  const queue = rootEdges.map((edge) => ({
    edge: effectiveTargetForEdge(edge, nodeByKey, outgoingBySource).edge,
    depth: 1,
  }));
  let iterations = 0;
  while (queue.length) {
    if (iterations++ > 10_000) throw new Error('newStraightDrawio operand condition graph is cyclic');
    const { edge, depth } = queue.shift();
    const target = nodeByKey.get(edge.end);
    if (!isOperandBranchNode(target)) {
      terminalBySignature.set(`${edge.type}:${edge.start}->${edge.end}`, edge);
      continue;
    }
    const previousDepth = depthByKey.get(target.key) || 0;
    if (depth <= previousDepth) continue;
    depthByKey.set(target.key, depth);
    for (const outgoing of outgoingBySource.get(target.key) || []) {
      if (outgoing.type !== 'TRUE' && outgoing.type !== 'FALSE') continue;
      queue.push({
        edge: effectiveTargetForEdge(outgoing, nodeByKey, outgoingBySource).edge,
        depth: depth + 1,
      });
    }
  }
  return {
    depthByKey,
    terminalEdges: [...terminalBySignature.values()],
  };
}

function newStraightDrawio(nodes, edges, fnStableId, options = {}) {
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  const head = nodeByKey.get(fnStableId);
  if (!head) throw new Error(`newStraightDrawio head not found: ${fnStableId}`);

  const extractedEdges = edges;
  const objectBraceCompositionEdges = nodes.flatMap((node) => {
    if (!isObjectBraceNode(node)) return [];
    const neighborStableId = node.props?.objectBraceMosaicNeighborStableId
      || node.props?.object_brace_mosaic_neighbor_stable_id;
    if (!neighborStableId || !nodeByKey.has(neighborStableId)) return [];
    const side = node.props?.objectBraceSide || node.props?.object_brace_side;
    const left = side === 'left';
    return [{
      id: `layout:object-brace-mosaic:${node.key}`,
      type: left ? 'FIELD' : 'FieldJoin',
      start: left ? neighborStableId : node.key,
      end: left ? node.key : neighborStableId,
      props: {
        renderHidden: true,
        layoutComposition: 'object-brace-mosaic',
        fieldIndex: 0,
      },
    }];
  });
  edges = [...edges, ...objectBraceCompositionEdges];

  const positions = new Map();
  const renderEdges = [];
  const deferredValueOutcomeEdges = [];
  const deferredConnectionEdges = [];
  const visualNodes = [];
  const callbackOutcomePlacementByKey = new Map();
  const callbackResultPlacementByKey = new Map();
  const renderedEdgeKeys = new Set();
  const visualCallTargetByEdgeKey = new Map();
  const visualResourceProxyByEdgeKey = new Map();
  const flowBranchRouteReservationsByRoot = new Map();
  const resourceCopyMetaByEdge = buildResourceCopyMetaByEdge(edges, nodeByKey);
  const accessorStorageCopyMetaByUse = buildAccessorStorageCopyMetaByUse(edges, nodeByKey);
  const outgoingBySource = buildOutgoingBySource(edges);
  const materializedFnProxyByCallTarget = new Map(
    nodes
      .filter((node) => isFnVisualProxyNode(node))
      .flatMap((node) => {
        const callSiteStableId = node.props?.sourceCallStableId || node.props?.source_call_stable_id;
        const canonicalStableId = node.props?.canonicalStableId || node.props?.canonical_stable_id || node.props?.calleeStableId;
        return [
          [`${callSiteStableId}->${node.key}`, node],
          ...(canonicalStableId ? [[`${callSiteStableId}->${canonicalStableId}`, node]] : []),
        ];
      })
      .filter(([key]) => !key.startsWith('undefined->') && !key.endsWith('->undefined')),
  );

  function flowBranchLaneForEdge(edge, rootX, rightX, lanes) {
    if (edge === lanes?.right) return rightX;
    if (edge === lanes?.down) return rootX;
    throw new Error(`Flow Branch edge has no calculated lane: ${edge?.start} -> ${edge?.end}`);
  }

  function flowBranchPortToward(sourceX, targetX) {
    if (targetX > sourceX) return 'right';
    if (targetX < sourceX) return 'left';
    return 'bottom';
  }

  function flowBranchLaneRoot(current, currentPos) {
    const inheritedRootKey = currentPos.props?.flowBranchRootKey
      || current.props?.flowBranchRootKey
      || current.key;
    const inheritedRoot = nodeByKey.get(inheritedRootKey);
    const currentFlowLane = String(current.props?.flowLaneStableId || '').trim();
    const inheritedFlowLane = String(inheritedRoot?.props?.flowLaneStableId || '').trim();
    const startsNestedFlow = Boolean(
      currentFlowLane
      && inheritedFlowLane
      && currentFlowLane !== inheritedFlowLane,
    );
    const rootKey = startsNestedFlow ? current.key : inheritedRootKey;
    const rootX = startsNestedFlow
      ? currentPos.x
      : Number.isFinite(currentPos.props?.flowBranchRootX)
        ? currentPos.props.flowBranchRootX
        : Number.isFinite(current.props?.flowBranchRootX)
          ? current.props.flowBranchRootX
          : currentPos.x;
    const rightX = startsNestedFlow
      ? rootX + 1
      : Number.isFinite(currentPos.props?.flowBranchRightX)
        ? currentPos.props.flowBranchRightX
        : Number.isFinite(current.props?.flowBranchRightX)
          ? current.props.flowBranchRightX
          : rootX + 1;
    return { rootKey, rootX, rightX, startsNestedFlow };
  }

  function positionedFlowLaneX(flowLaneStableId) {
    if (!flowLaneStableId) return undefined;
    const positionedMembers = nodes
      .filter((candidate) => String(candidate.props?.flowLaneStableId || '').trim() === flowLaneStableId)
      .map((candidate) => ({
        candidate,
        position: positions.get(candidate.key),
      }))
      .filter(({ position }) => Number.isFinite(position?.x))
      .sort((left, right) => (
        Number(left.candidate.props?.operationIndex ?? Number.MAX_SAFE_INTEGER)
        - Number(right.candidate.props?.operationIndex ?? Number.MAX_SAFE_INTEGER)
      ));
    return positionedMembers[0]?.position?.x;
  }

  function flowJoinReturnLaneX(source, target, fallbackX) {
    if (!isFlowJoinNode(target)) return fallbackX;
    const sourceLane = String(source.props?.flowLaneStableId || '').trim();
    const targetLane = String(target.props?.flowLaneStableId || '').trim();
    if (!sourceLane || !targetLane || sourceLane === targetLane) return fallbackX;
    const targetLaneX = positionedFlowLaneX(targetLane);
    return Number.isFinite(targetLaneX) ? targetLaneX : fallbackX;
  }

  function flowBranchRoutePoints(source, targetX, targetY) {
    const points = [{ x: source.x, y: source.y }];
    if (targetX !== source.x) points.push({ x: targetX, y: source.y });
    points.push({ x: targetX, y: targetY });
    return points;
  }

  function flowBranchRouteSegments(points) {
    return points.slice(1).map((point, index) => ({ start: points[index], end: point }));
  }

  function flowBranchSegmentConflict(left, right, sharedSource) {
    const leftHorizontal = left.start.y === left.end.y;
    const rightHorizontal = right.start.y === right.end.y;
    const between = (value, start, end) => value >= Math.min(start, end) && value <= Math.max(start, end);
    if (leftHorizontal === rightHorizontal) {
      const sameAxis = leftHorizontal
        ? left.start.y === right.start.y
        : left.start.x === right.start.x;
      if (!sameAxis) return 0;
      const leftStart = leftHorizontal ? left.start.x : left.start.y;
      const leftEnd = leftHorizontal ? left.end.x : left.end.y;
      const rightStart = rightHorizontal ? right.start.x : right.start.y;
      const rightEnd = rightHorizontal ? right.end.x : right.end.y;
      const overlap = Math.min(Math.max(leftStart, leftEnd), Math.max(rightStart, rightEnd))
        - Math.max(Math.min(leftStart, leftEnd), Math.min(rightStart, rightEnd));
      return overlap > 1e-9 ? 4 : 0;
    }
    const horizontal = leftHorizontal ? left : right;
    const vertical = leftHorizontal ? right : left;
    const intersection = { x: vertical.start.x, y: horizontal.start.y };
    if (!between(intersection.x, horizontal.start.x, horizontal.end.x)
      || !between(intersection.y, vertical.start.y, vertical.end.y)) return 0;
    if (sharedSource && intersection.x === sharedSource.x && intersection.y === sharedSource.y) return 0;
    return 1;
  }

  function flowBranchRouteConflict(points, reservations, sharedSource) {
    const segments = flowBranchRouteSegments(points);
    return reservations.reduce((score, reserved) => score + segments.reduce(
      (segmentScore, segment) => segmentScore + flowBranchRouteSegments(reserved).reduce(
        (reservedScore, reservedSegment) => reservedScore
          + flowBranchSegmentConflict(segment, reservedSegment, sharedSource),
        0,
      ),
      0,
    ), 0);
  }

  function chooseFlowBranchContinuationPlacement(currentPos, rootKey, rootX, rightX, parallelEdge, continuationEdge, continuationChild, lanes) {
    const reservations = flowBranchRouteReservationsByRoot.get(rootKey) || [];
    const parallelX = flowBranchLaneForEdge(parallelEdge, rootX, rightX, lanes);
    const parallelY = currentPos.y + 1;
    const parallelRoute = flowBranchRoutePoints(currentPos, parallelX, parallelY);
    const keepMosaicContinuationAttached = hasLabel(continuationChild, 'ExpressionMosaic');
    const continuationStepStableId = fanoutOwnerStepStableId(continuationChild);
    const stepPositions = continuationStepStableId
      ? new Map([...positions.entries()].filter(([key]) => (
          fanoutOwnerStepStableId(nodeByKey.get(key)) === continuationStepStableId
        )))
      : positions;
    const continuationX = flowBranchLaneForEdge(continuationEdge, rootX, rightX, lanes);
    const candidates = [continuationX].map((candidateX) => {
      const candidateY = firstFreeSlot(
        stepPositions,
        candidateX,
        currentPos.y + 1,
      ).y;
      const continuationRoute = flowBranchRoutePoints(currentPos, candidateX, candidateY);
      const pairConflict = flowBranchRouteConflict(continuationRoute, [parallelRoute], currentPos);
      const existingConflict = flowBranchRouteConflict(continuationRoute, reservations, currentPos)
        + flowBranchRouteConflict(parallelRoute, reservations, currentPos);
      const sameDestinationLane = candidateX === parallelX && !keepMosaicContinuationAttached ? 1 : 0;
      return {
        x: candidateX,
        y: candidateY,
        continuationRoute,
        parallelRoute,
        score: sameDestinationLane * 1000
          + pairConflict * 100
          + existingConflict * 10
          + (candidateY - currentPos.y)
          + (candidateX === currentPos.x ? 0 : 0.01),
      };
    }).sort((left, right) => left.score - right.score || left.x - right.x);
    const selected = candidates[0];
    flowBranchRouteReservationsByRoot.set(rootKey, [
      ...reservations,
      selected.continuationRoute,
      selected.parallelRoute,
    ]);
    return { ...selected, parallelX };
  }

  function flowBranchReachesBranch(startKey, targetKey) {
    const startNode = nodeByKey.get(startKey);
    const queue = [startKey];
    const seen = new Set();
    while (queue.length) {
      const key = queue.shift();
      if (key === targetKey) return true;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const edge of outgoingBySource.get(key) || []) {
        if (edge.type !== 'TRUE' && edge.type !== 'FALSE') continue;
        if (isSameFlowConditionStep(startNode, nodeByKey.get(edge.end))) queue.push(edge.end);
      }
    }
    return false;
  }

  function nearestFlowBranchContinuation(currentNode, flowEdges) {
    const candidates = flowEdges.filter((edge) => isSameFlowConditionStep(currentNode, nodeByKey.get(edge.end)));
    return candidates.find((candidate) => candidates.some((other) => (
      other !== candidate && flowBranchReachesBranch(candidate.end, other.end)
    ))) || candidates[0];
  }
  placeNode(
    positions,
    head,
    0,
    0,
    'newStraightDrawio: named Fn starts at top-left 0,0',
    'placeHead',
    [
      makeTraceStep('placeHead', {
        x: 0,
        y: 0,
        reason: 'named Fn starts at top-left',
      }),
    ],
  );

  let current = head;
  let currentStopAt = null;
  let currentStopStack = [];
  let currentCanPlaceRejoinTarget = true;
  const pendingCurrents = [];
  const pendingByKey = new Map();
  const visited = new Set();
  const debug = process.env.DEBUG_NEW_STRAIGHT === '1';
  const fanoutMaxXByOwner = new Map();
  const fanoutRequiredMergeXByOwner = new Map();

  function firstRowAfterRightFootprintWithEdges(
    positionsMap,
    preferredY,
    x,
    width = Number.POSITIVE_INFINITY,
    ownerStepStableId = '',
    candidateNode,
  ) {
    const finiteWidth = Number.isFinite(width) ? Math.max(0, width) : Number.POSITIVE_INFINITY;
    const rightBoundary = x + finiteWidth;
    const overlappingEntries = [...positionsMap.entries()]
      .filter(([key, pos]) => (
        Number.isFinite(pos.x)
        && Number.isFinite(pos.y)
        && pos.x >= x
        && pos.x <= rightBoundary
        && (!ownerStepStableId || fanoutOwnerStepStableId(nodeByKey.get(key)) === ownerStepStableId)
      ));
    const overlappingPositions = overlappingEntries.map(([, pos]) => pos);
    const overlappingPositionSet = new Set(overlappingPositions);
    const overlappingOwnerKeys = new Set(overlappingPositions.flatMap((pos) => fanoutOwnerKeysFrom(pos)));
    const occupiedNodeMaxYs = [...positionsMap.entries()]
      .filter(([key, pos]) => (
        (!ownerStepStableId || fanoutOwnerStepStableId(nodeByKey.get(key)) === ownerStepStableId)
        && (overlappingPositionSet.has(pos)
          || fanoutOwnerKeysFrom(pos).some((ownerKey) => overlappingOwnerKeys.has(ownerKey)))
      ))
      .map(([key, pos]) => (
        pos.y + nodeHeightForFanout(nodeByKey.get(key)) / 2 / DRAWIO_GRID_Y
      ));
    const occupiedEdgeMaxYs = renderEdges
      .map((edge) => {
        const head = positionsMap.get(edge.start);
        const tail = positionsMap.get(edge.end);
        if (!head || !tail) return undefined;
        if (ownerStepStableId) {
          const headStep = fanoutOwnerStepStableId(nodeByKey.get(edge.start));
          const tailStep = fanoutOwnerStepStableId(nodeByKey.get(edge.end));
          if (headStep !== ownerStepStableId || tailStep !== ownerStepStableId) return undefined;
        }
        const minX = Math.min(head.x, tail.x);
        const maxX = Math.max(head.x, tail.x);
        if (maxX < x || minX > rightBoundary) return undefined;
        return Math.max(head.y, tail.y);
      })
      .filter(Number.isFinite);
    const occupiedMaxY = Math.max(
      Number.NEGATIVE_INFINITY,
      ...occupiedNodeMaxYs,
      ...occupiedEdgeMaxYs,
    );
    const candidateHalfHeight = nodeHeightForFanout(candidateNode) / 2 / DRAWIO_GRID_Y;
    return Number.isFinite(occupiedMaxY) && occupiedMaxY >= preferredY - candidateHalfHeight
      ? occupiedMaxY + FANOUT_SIBLING_GAP + candidateHalfHeight
      : preferredY;
  }

  function fanoutOwnerKeysFrom(pos) {
    return Array.isArray(pos?.fanoutOwnerKeys) ? pos.fanoutOwnerKeys.filter(Boolean) : [];
  }

  function fanoutParentYsFrom(pos) {
    return Array.isArray(pos?.fanoutParentYs) ? pos.fanoutParentYs.filter(Number.isFinite) : [];
  }

  function fanoutTopY(pos) {
    const ys = fanoutParentYsFrom(pos);
    return ys.length ? ys[ys.length - 1] : pos?.fanoutParentY;
  }

  function fanoutOwnerY(pos, predicate) {
    const ownerKeys = fanoutOwnerKeysFrom(pos);
    const parentYs = fanoutParentYsFrom(pos);
    for (let index = ownerKeys.length - 1; index >= 0; index -= 1) {
      if (predicate(nodeByKey.get(ownerKeys[index])) && Number.isFinite(parentYs[index])) {
        return parentYs[index];
      }
    }
    return undefined;
  }

  function pushFanoutContext(pos, { ownerKey, parentY, familyMinY = parentY, familyMaxY = parentY }) {
    const ownerKeys = [...fanoutOwnerKeysFrom(pos), ownerKey].filter(Boolean);
    const parentYs = [...fanoutParentYsFrom(pos), parentY].filter(Number.isFinite);
    const parentMinYs = Array.isArray(pos?.fanoutMinYs) ? pos.fanoutMinYs.filter(Number.isFinite) : [];
    const nextMinY = Number.isFinite(pos?.fanoutMinY) ? Math.min(pos.fanoutMinY, parentY) : parentY;
    const inheritedFamilyMinY = Number.isFinite(pos?.fanoutFamilyMinY) ? pos.fanoutFamilyMinY : parentY;
    const inheritedFamilyMaxY = Number.isFinite(pos?.fanoutFamilyMaxY) ? pos.fanoutFamilyMaxY : parentY;
    return {
      fanoutOwnerKeys: ownerKeys,
      fanoutParentYs: parentYs,
      fanoutParentY: parentYs[parentYs.length - 1],
      fanoutMinYs: [...parentMinYs, nextMinY],
      fanoutMinY: nextMinY,
      fanoutFamilyMinY: Math.min(inheritedFamilyMinY, familyMinY, parentY),
      fanoutFamilyMaxY: Math.max(inheritedFamilyMaxY, familyMaxY, parentY),
    };
  }

  function popFanoutContext(pos) {
    const ownerKeys = fanoutOwnerKeysFrom(pos).slice(0, -1);
    const parentYs = fanoutParentYsFrom(pos).slice(0, -1);
    const parentMinYs = Array.isArray(pos?.fanoutMinYs) ? pos.fanoutMinYs.filter(Number.isFinite).slice(0, -1) : [];
    return {
      fanoutOwnerKeys: ownerKeys,
      fanoutParentYs: parentYs,
      fanoutParentY: parentYs[parentYs.length - 1],
      fanoutMinYs: parentMinYs,
      fanoutMinY: parentMinYs[parentMinYs.length - 1],
    };
  }

  function noteFanoutFootprint(key) {
    const pos = positions.get(key);
    if (!pos) return;
    for (const ownerKey of fanoutOwnerKeysFrom(pos)) {
      const rightBoundaryX = pos.x + (Number.isFinite(pos.horizontalStep) ? pos.horizontalStep : 1);
      fanoutMaxXByOwner.set(ownerKey, Math.max(fanoutMaxXByOwner.get(ownerKey) ?? Number.NEGATIVE_INFINITY, rightBoundaryX));
    }
  }

  function setFanoutMeta(key, meta = {}) {
    setNodePositionMeta(positions, key, meta);
    noteFanoutFootprint(key);
  }

  function inheritFanoutMeta(pos) {
    if (!pos) return {};
    const meta = {};
    if (Number.isFinite(pos.fanoutParentY)) meta.fanoutParentY = pos.fanoutParentY;
    if (Number.isFinite(pos.fanoutMinY)) meta.fanoutMinY = pos.fanoutMinY;
    if (Number.isFinite(pos.fanoutFamilyMinY)) meta.fanoutFamilyMinY = pos.fanoutFamilyMinY;
    if (Number.isFinite(pos.fanoutFamilyMaxY)) meta.fanoutFamilyMaxY = pos.fanoutFamilyMaxY;
    if (Array.isArray(pos.fanoutOwnerKeys)) meta.fanoutOwnerKeys = [...pos.fanoutOwnerKeys];
    if (Array.isArray(pos.fanoutParentYs)) meta.fanoutParentYs = [...pos.fanoutParentYs];
    if (Array.isArray(pos.fanoutMinYs)) meta.fanoutMinYs = [...pos.fanoutMinYs];
    if (Number.isFinite(pos.operandFlowRootX)) meta.operandFlowRootX = pos.operandFlowRootX;
    if (Number.isFinite(pos.operandFlowRootY)) meta.operandFlowRootY = pos.operandFlowRootY;
    if (typeof pos.operandFlowDownTarget === 'string') meta.operandFlowDownTarget = pos.operandFlowDownTarget;
    return meta;
  }

  function fanoutMergeOwnerKey(pos) {
    const owners = fanoutOwnerKeysFrom(pos);
    return owners.length ? owners[owners.length - 1] : undefined;
  }

  function preferredFanoutMergeX(pos) {
    const ownerKey = fanoutMergeOwnerKey(pos);
    const maxX = ownerKey ? fanoutMaxXByOwner.get(ownerKey) : undefined;
    const requiredX = ownerKey ? fanoutRequiredMergeXByOwner.get(ownerKey) : undefined;
    const nextX = pos.x + (Number.isFinite(pos.horizontalStep) ? pos.horizontalStep : 1);
    return Math.max(
      nextX,
      Number.isFinite(maxX) ? maxX : nextX,
      Number.isFinite(requiredX) ? requiredX : nextX,
    );
  }

  function noteRequiredFanoutMergeX(ownerKey, requiredX) {
    if (!ownerKey || !Number.isFinite(requiredX)) return;
    fanoutRequiredMergeXByOwner.set(ownerKey, Math.max(
      fanoutRequiredMergeXByOwner.get(ownerKey) ?? Number.NEGATIVE_INFINITY,
      requiredX,
    ));
  }

  function ownRightFootprintWidth(node, x, seen = new Set()) {
    if (!node) return 0;
    if (seen.has(node.key)) return 0;
    seen.add(node.key);
    const mosaicClose = isPredicateCallMosaicOpen(node)
      ? nodes.find((candidate) => (
          callMosaicOwnerStableId(candidate) === node.key
          && callMosaicRole(candidate) === 'close'
        ))
      : undefined;
    const outgoing = [
      ...originalOutgoing(edges, node.key),
      ...(mosaicClose ? originalOutgoing(edges, mosaicClose.key) : []),
    ];
    const byType = new Map();
    for (const edge of outgoing) byType.set(edge.type, [...(byType.get(edge.type) || []), edge]);
    if (isObjectFieldNode(node)) {
      const producerWidths = edges
        .filter((edge) => (
          edge.end === node.key
          && ['ASSIGNS_VALUE', 'YIELDS_VALUE'].includes(edge.type)
          && (edge.props?.protocolRole || edge.props?.protocol_role) === 'assignment-return'
        ))
        .map((edge) => nodeByKey.get(edge.start))
        .filter(Boolean)
        .map((producer) => Math.max(
          horizontalStepForNode(producer),
          ownRightFootprintWidth(producer, x, new Set(seen)),
        ));
      if (producerWidths.length) return Math.max(...producerWidths);
    }
    if (isFlowBranchNode(node)) {
      const trueEdges = byType.get('TRUE') || [];
      const falseEdges = byType.get('FALSE') || [];
      if (trueEdges.length === 1 && falseEdges.length === 1) {
        const lanes = chooseBranchLanes(node, trueEdges[0], falseEdges[0], nodeByKey, outgoingBySource);
        const rightLane = effectiveTargetForEdge(lanes.right, nodeByKey, outgoingBySource).edge;
        const rightChild = nodeByKey.get(rightLane.end);
        const rightChildWidth = rightChild
          ? ownRightFootprintWidth(rightChild, x + 1, new Set(seen))
          : 0;
        return Math.max(
          1,
          1 + nestedFanoutDepthFrom(rightLane.end, nodeByKey, outgoingBySource),
          1 + rightChildWidth,
        );
      }
    }
    const argEdges = byType.get('ARG') || [];
    const valueEdges = byType.get('VALUE') || [];
    const fieldEdges = byType.get('FIELD') || [];
    if ((isCurrentNodeCall(node) || hasLabel(node, 'Method')) && (argEdges.length || valueEdges.length)) {
      const visualArgEdges = (argEdges.length ? argEdges : valueEdges).map((edge) => visualSlotEdge(edge, nodeByKey, outgoingBySource));
      const requiredX = requiredFanoutMergeX(x, visualArgEdges, nodeByKey, outgoingBySource);
      return Number.isFinite(requiredX) ? Math.max(1, requiredX - x) : Math.max(1, visualArgEdges.length);
    }
    if ((isLocalValueDeclarationNode(node) || isFlowEvalNode(node)) && valueEdges.length) {
      const visualValueEdges = valueEdges.map((edge) => visualSlotEdge(edge, nodeByKey, outgoingBySource));
      const requiredX = requiredFanoutMergeX(x, visualValueEdges, nodeByKey, outgoingBySource);
      return Number.isFinite(requiredX) ? Math.max(1, requiredX - x) : Math.max(1, valueEdges.length);
    }
    if (isCurrentNodeObjectSlot(node)) {
      const slotEdges = sortSlotEdgesBySourceOrder(
        (fieldEdges.length ? fieldEdges : argEdges)
          .map((edge) => visualSlotEdge(edge, nodeByKey, outgoingBySource)),
        nodeByKey,
      );
      const requiredX = requiredFanoutMergeX(x, slotEdges, nodeByKey, outgoingBySource);
      return Number.isFinite(requiredX) ? Math.max(1, requiredX - x) : Math.max(0, slotEdges.length ? 1 : 0);
    }
    if (isSlotBranchNode(node)) {
      const slotEdges = (byType.get('TRUE') || []).concat(byType.get('FALSE') || []);
      const requiredX = requiredFanoutMergeX(x, slotEdges, nodeByKey, outgoingBySource);
      return Number.isFinite(requiredX) ? Math.max(1, requiredX - x) : Math.max(1, slotEdges.length);
    }
    return 0;
  }

  function centeredFanoutChildXs(familyX, children) {
    const widths = children.map((child) => ownRightFootprintWidth(child, familyX));
    const maxWidth = Math.max(0, ...widths);
    return {
      widths,
      maxWidth,
      childXs: widths.map((width) => familyX + (maxWidth - width) / 2),
    };
  }

  function pendingRightFootprintWidth(pending) {
    if (!pending?.avoidRightFootprint) return 0;
    const ownWidth = ownRightFootprintWidth(pending.node, pending.x);
    const requestedWidth = Number(pending.avoidRightFootprintWidth);
    return Math.max(
      Number.isFinite(ownWidth) ? Math.max(0, ownWidth) : 0,
      Number.isFinite(requestedWidth) ? Math.max(0, requestedWidth) : 0,
    );
  }

  function extractedSubstepColumnOffset(node) {
    const value = Number(
      node?.props?.substepColumnOffset
      ?? node?.props?.substep_column_offset
      ?? 0,
    );
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  }

  function extractedSubstepRowOffset(node) {
    const value = Number(
      node?.props?.substepRowOffset
      ?? node?.props?.substep_row_offset
      ?? 1,
    );
    return Number.isFinite(value) ? Math.max(0, value) : 1;
  }

  function measureComputedEvalGroup(node, evalChild, headPos) {
    if ((!isComputedBooleanValueNode(node) && !isFlowEvalNode(node)) || !evalChild) return null;
    const evalX = headPos.x + 1;
    const evalWidth = Math.max(1, ownRightFootprintWidth(evalChild, evalX));
    return {
      minX: headPos.x - 0.5,
      maxX: evalX + evalWidth - 0.5,
      minYOffset: -0.5,
      maxYOffset: 0.5,
      evalWidth,
    };
  }

  function rectanglesOverlap(left, right) {
    return left.minX <= right.maxX
      && left.maxX >= right.minX
      && left.minY <= right.maxY
      && left.maxY >= right.minY;
  }

  function positionedNodeRect(key, pos) {
    const node = nodeByKey.get(key);
    const displayWidth = Number(pos.props?.displayWidth || node?.props?.displayWidth || DEFAULT_NODE_WIDTH);
    const halfWidth = Math.max(0.25, displayWidth / DRAWIO_GRID_X / 2);
    const halfHeight = (node && isCurrentNodeBranch(node) ? SLOT_BRANCH_HEIGHT : 52) / DRAWIO_GRID_Y / 2;
    return {
      minX: pos.x - halfWidth,
      maxX: pos.x + halfWidth,
      minY: pos.y - halfHeight,
      maxY: pos.y + halfHeight,
    };
  }

  function positionedEdgeRect(edge) {
    const source = positions.get(edge.start);
    const target = positions.get(edge.end);
    if (!source || !target) return null;
    return {
      minX: Math.min(source.x, target.x),
      maxX: Math.max(source.x, target.x),
      minY: Math.min(source.y, target.y),
      maxY: Math.max(source.y, target.y),
    };
  }

  function findComputedEvalGroupY(node, headPos, footprint) {
    if (!footprint) return headPos.y;
    let candidateY = headPos.y;
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      const candidateRect = {
        minX: footprint.minX,
        maxX: footprint.maxX,
        minY: candidateY + footprint.minYOffset,
        maxY: candidateY + footprint.maxYOffset,
      };
      const nodeConflict = [...positions.entries()].some(([key, pos]) => (
        key !== node.key && rectanglesOverlap(candidateRect, positionedNodeRect(key, pos))
      ));
      const edgeConflict = renderEdges.some((edge) => (
        edge.start !== node.key
        && edge.end !== node.key
        && rectanglesOverlap(candidateRect, positionedEdgeRect(edge) || {
          minX: Number.POSITIVE_INFINITY,
          maxX: Number.POSITIVE_INFINITY,
          minY: Number.POSITIVE_INFINITY,
          maxY: Number.POSITIVE_INFINITY,
        })
      ));
      if (!nodeConflict && !edgeConflict) return candidateY;
      candidateY += 1;
    }
    throw new Error(`newStraightDrawio could not place ComputedValue EVAL group for ${node.key}`);
  }

  function shiftComputedEvalGroupHead(node, headPos, footprint) {
    const placedY = findComputedEvalGroupY(node, headPos, footprint);
    if (placedY === headPos.y) return headPos;
    const shifted = {
      ...headPos,
      y: placedY,
      reason: `${headPos.reason}; shifted as one ComputedValue EVAL group`,
      trace: [
        ...(headPos.trace || []),
        makeTraceStep('shiftComputedEvalGroupHead', {
          previousY: headPos.y,
          placedY,
          minX: footprint.minX,
          maxX: footprint.maxX,
          evalWidth: footprint.evalWidth,
          reason: 'whole horizontal EVAL group moved below occupied nodes and foreign edge corridors before child placement',
        }),
      ],
    };
    positions.set(node.key, shifted);
    return shifted;
  }

  function leftmostPositionedIncomingSourceX(targetKey) {
    const xs = edges
      .filter((edge) => edge.end === targetKey)
      .map((edge) => positions.get(edge.start)?.x)
      .filter((value) => Number.isFinite(value));
    return xs.length ? Math.min(...xs) : undefined;
  }

  function flowJoinBackboneX(node, seen = new Set()) {
    if (!isFlowJoinNode(node) || seen.has(node.key)) return undefined;
    seen.add(node.key);
    const backboneSourceId = String(node.props?.flowJoinBackboneSourceStableId || '').trim();
    if (!backboneSourceId) return undefined;
    const positionedBackboneX = positions.get(backboneSourceId)?.x;
    if (Number.isFinite(positionedBackboneX)) return positionedBackboneX;
    const backboneNode = nodeByKey.get(backboneSourceId);
    if (isFlowJoinNode(backboneNode)) return flowJoinBackboneX(backboneNode, seen);
    if (Number.isFinite(backboneNode?.props?.flowBranchReturnX)) {
      return backboneNode.props.flowBranchReturnX;
    }
    return leftmostPositionedIncomingSourceX(backboneSourceId);
  }

  function flowJoinPlacementX(node, fallbackX) {
    if (!isFlowJoinNode(node)) return fallbackX;
    const incomingTypes = String(node.props?.incoming_edge_types || node.props?.incomingEdgeTypes || '')
      .split(',')
      .map((type) => type.trim())
      .filter(Boolean);
    if (incomingTypes.length && incomingTypes.every((type) => type === incomingTypes[0])
      && (incomingTypes[0] === 'TRUE' || incomingTypes[0] === 'FALSE')) {
      return fallbackX;
    }
    if (Number.isFinite(node.props?.flowBranchReturnX)) return node.props.flowBranchReturnX;
    const backboneX = flowJoinBackboneX(node);
    if (Number.isFinite(backboneX)) return backboneX;
    const leftmostIncomingX = leftmostPositionedIncomingSourceX(node.key);
    return Number.isFinite(leftmostIncomingX) ? leftmostIncomingX : fallbackX;
  }

  function effectivePositionY(position) {
    if (!Number.isFinite(position?.y)) return undefined;
    const displayOffsetY = Number(position.props?.displayOffsetY || 0);
    return position.y + (Number.isFinite(displayOffsetY) ? displayOffsetY / DRAWIO_GRID_Y : 0);
  }

  function closingProxyX(edge, currentPos) {
    const proxyGapAfter = (source) => {
      const sourceWidth = isFanoutMergeNode(source) ? BRACKET_NODE_WIDTH : DEFAULT_NODE_WIDTH;
      return ((sourceWidth + DEFAULT_NODE_WIDTH) / 2 + COMPACT_CALL_RETURN_PORT_GAP) / DRAWIO_GRID_X;
    };
    const positionedClosures = edges
      .filter((incoming) => incoming.end === edge.end)
      .filter((incoming) => incoming.type === 'ArgJoin' || incoming.type === 'FieldJoin')
      .map((incoming) => {
        const source = nodeByKey.get(incoming.start);
        const sourcePos = positions.get(incoming.start);
        if (!source || !sourcePos) return undefined;
        return sourcePos.x + proxyGapAfter(source);
      })
      .filter(Number.isFinite);
    const ownerKey = fanoutMergeOwnerKey(currentPos);
    const owner = ownerKey ? nodeByKey.get(ownerKey) : undefined;
    const ownerPos = ownerKey ? positions.get(ownerKey) : undefined;
    const ownerSlotEdges = owner
      ? originalOutgoing(edges, owner.key)
        .filter((outgoing) => outgoing.type === 'ARG' || outgoing.type === 'FIELD')
        .map((outgoing) => visualSlotEdge(outgoing, nodeByKey, outgoingBySource))
      : [];
    const requiredMergeX = owner && ownerPos
      ? requiredFanoutMergeX(ownerPos.x, ownerSlotEdges, nodeByKey, outgoingBySource)
      : undefined;
    const predictedClosure = Number.isFinite(requiredMergeX)
      ? requiredMergeX + proxyGapAfter({ labels: ['Join', 'Arg'] })
      : undefined;
    const currentSource = nodeByKey.get(edge.start);
    const candidates = [
      currentPos.x + proxyGapAfter(currentSource),
      ...(Number.isFinite(predictedClosure) ? [predictedClosure] : []),
      ...positionedClosures,
    ];
    return Math.max(...candidates);
  }

  function lowestPositionedIncomingSourceY(targetKey) {
    const ys = edges
      .filter((edge) => edge.end === targetKey)
      .map((edge) => effectivePositionY(positions.get(edge.start)))
      .filter((value) => Number.isFinite(value));
    return ys.length ? Math.max(...ys) : undefined;
  }

  function lowestPositionedRightIncoming(node, joinX) {
    if (!isFlowJoinNode(node) || !Number.isFinite(joinX)) return undefined;
    const incoming = edges
      .filter((edge) => edge.end === node.key)
      .map((edge) => {
        const position = positions.get(edge.start);
        return { edge, position, effectiveY: effectivePositionY(position) };
      })
      .filter(({ position }) => Number.isFinite(position?.x)
        && Number.isFinite(effectivePositionY(position))
        && position.x > joinX)
      .sort((left, right) => right.effectiveY - left.effectiveY);
    return incoming[0];
  }

  function flowJoinPlacementY(node, joinX, fallbackY) {
    if (node.props?.inlineStepTerminalJoin && node.props?.parentStepStableId) {
      const stepNodeYs = nodes
        .filter((candidate) => (
          candidate.key !== node.key
          && candidate.props?.parentStepStableId === node.props.parentStepStableId
        ))
        .map((candidate) => effectivePositionY(positions.get(candidate.key)))
        .filter(Number.isFinite);
      const terminalY = stepNodeYs.length ? Math.max(...stepNodeYs) + 1 : fallbackY;
      return {
        y: Math.max(fallbackY, terminalY),
        alignedToRightIncoming: false,
        sourceKey: null,
        edgeType: null,
      };
    }
    const inlinePlacementSourceId = node.props?.parentStepStableId
      ? String(node.props?.flowJoinPlacementSourceStableId || '').trim()
      : '';
    const inlinePlacementSource = inlinePlacementSourceId
      ? positions.get(inlinePlacementSourceId)
      : undefined;
    const inlinePlacementY = effectivePositionY(inlinePlacementSource);
    if (Number.isFinite(inlinePlacementY)) {
      return {
        y: inlinePlacementY,
        alignedToRightIncoming: true,
        sourceKey: inlinePlacementSourceId,
        edgeType: 'FALSE',
      };
    }
    const rightIncoming = lowestPositionedRightIncoming(node, joinX);
    if (rightIncoming) {
      return {
        y: rightIncoming.effectiveY,
        alignedToRightIncoming: true,
        sourceKey: rightIncoming.edge.start,
        edgeType: rightIncoming.edge.type,
      };
    }
    const lowestRejoinY = isFlowJoinNode(node) ? lowestPositionedRejoinSourceY(node.key) : undefined;
    return {
      y: Number.isFinite(lowestRejoinY) ? Math.max(fallbackY, lowestRejoinY) : fallbackY,
      alignedToRightIncoming: false,
      sourceKey: null,
      edgeType: null,
    };
  }

  function materializePendingNode(node) {
    const pending = pendingByKey.get(node.key);
    if (!pending) return false;
    const extractedStateResultFamilyY = pending.edge?.type === 'ArgJoin'
      && hasLabels(node, 'Collection', 'ResultTarget')
      && (
        node.props?.semanticExpansion
        || node.props?.semantic_expansion
      ) === 'state-update'
      && Number.isFinite(pending.fanoutMeta?.fanoutParentY)
      ? pending.fanoutMeta.fanoutParentY
      : undefined;
    if (positions.has(node.key)) {
      if (pending.fanoutMeta) setFanoutMeta(node.key, pending.fanoutMeta);
      if (isFlowJoinNode(node) && pending.edge?.type !== 'REJOINS') {
        const pos = positions.get(node.key);
        const placedX = flowJoinPlacementX(node, pending.x);
        const joinY = flowJoinPlacementY(node, placedX, pending.yStart);
        const incomingY = lowestPositionedIncomingSourceY(node.key);
        const requestedYStart = Math.max(joinY.y, Number.isFinite(incomingY) ? incomingY : pending.yStart);
        const placedY = joinY.alignedToRightIncoming && requestedYStart === joinY.y
          ? joinY.y
          : firstFreeHorizontalIgnoring(positions, requestedYStart, placedX, node.key);
        placeNode(
          positions,
          node,
          placedX,
          placedY,
          `newStraightDrawio: pending ${pending.edge?.type || 'continuation'} continuation claims FlowJoin ${node.key}`,
          'materializePendingFlowJoin',
          [
            ...(pos?.trace || []),
            ...(pending.trace || []),
            makeTraceStep('materializePendingFlowJoin', {
              previousX: pos?.x,
              previousY: pos?.y,
              requestedX: pending.x,
              requestedYStart,
              originalRequestedYStart: pending.yStart,
              alignedRightIncomingSource: joinY.sourceKey,
              alignedRightIncomingEdgeType: joinY.edgeType,
              leftmostIncomingSourceX: leftmostPositionedIncomingSourceX(node.key),
              placedX,
              placedY,
              edgeType: pending.edge?.type,
              from: pending.edge?.start,
              reason: 'Pending executable continuation owns FlowJoin lane over earlier REJOINS pre-placement',
            }),
          ],
        );
      }
      return false;
    }
    const footprintWidth = pendingRightFootprintWidth(pending);
    const fanoutBoundaryX = pending.afterFanoutOwnerKey
      ? fanoutMaxXByOwner.get(pending.afterFanoutOwnerKey)
      : undefined;
    const requestedX = Number.isFinite(fanoutBoundaryX)
      ? Math.max(pending.x, fanoutBoundaryX)
      : pending.x;
    const placedX = flowJoinPlacementX(node, requestedX);
    const joinY = flowJoinPlacementY(node, placedX, pending.yStart);
    const incomingY = lowestPositionedIncomingSourceY(node.key);
    const yStart = Number.isFinite(extractedStateResultFamilyY)
      ? extractedStateResultFamilyY
      : Math.max(joinY.y, Number.isFinite(incomingY) ? incomingY : pending.yStart);
    const y = joinY.alignedToRightIncoming && yStart === joinY.y
      ? joinY.y
      : pending.keepRequestedRow
        ? yStart
        : pending.avoidRightFootprint
          ? firstRowAfterRightFootprintWithEdges(
            positions,
            yStart,
            placedX,
            footprintWidth,
            fanoutOwnerStepStableId(node),
            node,
          )
          : firstFreeHorizontal(positions, yStart, placedX);
    if (debug) console.error(`materialize pending ${node.key} at ${placedX},${y}: ${pending.reason}`);
    placeNode(
      positions,
      node,
      placedX,
      y,
      `${pending.reason}; materialized from reserved continuation`,
      'materializePendingNode',
      [
        ...(pending.trace || []),
        makeTraceStep('materializePendingNode', {
          requestedX: pending.x,
          fanoutBoundaryX,
          requestedYStart: yStart,
          originalRequestedYStart: pending.yStart,
          alignedRightIncomingSource: joinY.sourceKey,
          alignedRightIncomingEdgeType: joinY.edgeType,
          leftmostIncomingSourceX: leftmostPositionedIncomingSourceX(node.key),
          placedX,
          placedY: y,
          avoidRightFootprint: pending.avoidRightFootprint,
          ownRightFootprintWidth: footprintWidth,
          keepRequestedRow: pending.keepRequestedRow,
          reason: pending.reason,
        }),
      ],
    );
    if (pending.fanoutMeta) setFanoutMeta(node.key, pending.fanoutMeta);
    return true;
  }

  function rejoinPortProps(edge) {
    if (edge.props?.sourcePort || edge.props?.targetPort) {
      return {
        sourcePort: edge.props?.sourcePort || 'left',
        targetPort: edge.props?.targetPort || 'right',
      };
    }

    const sourcePos = positions.get(edge.start);
    const sourceLeftPortOccupied = renderEdges.some((incoming) => {
      if (incoming.end !== edge.start) return false;
      const incomingSourcePos = positions.get(incoming.start);
      if (incoming.props?.targetPort === 'left') return true;
      return incomingSourcePos
        && sourcePos
        && incomingSourcePos.x < sourcePos.x
        && sameGridRow(incomingSourcePos.y, sourcePos.y);
    });
    const targetPos = positions.get(edge.end);
    const targetPort = sourcePos
      && targetPos
      && targetPos.y > sourcePos.y
      && Math.abs(targetPos.x - sourcePos.x) <= 1
      ? 'top'
      : 'right';
    const targetIsBelowOnSameJoinAxis = sourcePos
      && targetPos
      && targetPos.y > sourcePos.y
      && sameGridRow(targetPos.x, sourcePos.x);
    const sourcePortCandidates = targetIsBelowOnSameJoinAxis || sourceLeftPortOccupied
      ? ['bottom', 'left']
      : ['left', 'bottom'];
    const targetPortCandidates = targetPort === 'top'
      ? ['top', 'right']
      : ['right', 'top'];
    return {
      sourcePortCandidates,
      targetPortCandidates,
    };
  }

  function isHiddenRenderEdge(edge) {
    if (
      edge.props?.render_hidden === true
      || edge.props?.renderHidden === true
      || edge.props?.context_only === true
      || edge.props?.contextOnly === true
    ) return true;
    if (
      edge.props?.flowFamilyConnector === true
      || edge.props?.flow_family_connector === true
    ) return false;
    const source = nodeByKey.get(edge.start);
    const target = nodeByKey.get(edge.end);
    const sourceBraceNeighbor = source?.props?.objectBraceMosaicNeighborStableId
      || source?.props?.object_brace_mosaic_neighbor_stable_id;
    const targetBraceNeighbor = target?.props?.objectBraceMosaicNeighborStableId
      || target?.props?.object_brace_mosaic_neighbor_stable_id;
    const sourceBraceSide = source?.props?.objectBraceSide || source?.props?.object_brace_side;
    const targetBraceSide = target?.props?.objectBraceSide || target?.props?.object_brace_side;
    if (
      edge.type === 'MATERIALIZES_ARGUMENT'
      && isObjectBraceNode(target)
      && targetBraceSide === 'left'
    ) return true;
    if (
      (edge.type === 'ARG' || edge.type === 'EVAL')
      && isObjectBraceNode(target)
      && targetBraceSide === 'left'
      && targetBraceNeighbor === edge.start
    ) return true;
    if (
      edge.type === 'ArgJoin'
      && isObjectBraceNode(source)
      && sourceBraceSide === 'right'
      && sourceBraceNeighbor === edge.end
    ) return true;
    if (edge.type === 'ARG' || edge.type === 'ArgJoin' || edge.type === 'INVOKES') {
      const sourceOwner = callMosaicOwnerStableId(nodeByKey.get(edge.start));
      const targetOwner = callMosaicOwnerStableId(nodeByKey.get(edge.end));
      if (sourceOwner && sourceOwner === targetOwner) return true;
    }
    return false;
  }

  function explicitSourcePartPosition(edge) {
    const id = edge.props?.sourceRenderPartStableId || edge.props?.source_render_part_stable_id;
    if (!id) return null;
    const owner = [...nodeByKey.values()].find(node => {
      const raw = node.props?.render_parts_json || node.props?.renderPartsJson;
      return raw && (typeof raw === 'string' ? JSON.parse(raw) : raw).some(part => part.stableId === id);
    });
    return owner ? positions.get(owner.key) : null;
  }

  function pushRenderEdge(edge) {
    if (isHiddenRenderEdge(edge)) return;
    if (edge.type === 'RESPONSE' && edge.props?.renderCompactResponse !== true) return;
    const key = `${edge.type}:${edge.start}->${edge.end}:${edge.id || ''}`;
    if (renderedEdgeKeys.has(key)) return;
    renderedEdgeKeys.add(key);
    let routedEdge = edge.type === 'REJOINS'
      ? {
          ...edge,
          props: {
            ...edge.props,
            ...rejoinPortProps(edge),
          },
        }
      : edge;
    const fanoutJoin = nodeByKey.get(edge.end);
    const fanoutJoinPosition = positions.get(edge.end);
    if (
      (edge.type === 'ArgJoin' || edge.type === 'FieldJoin')
      && isFanoutMergeNode(fanoutJoin)
      && Number.isFinite(fanoutJoinPosition?.x)
    ) {
      const sourcePosition = positions.get(edge.start);
      const compactCallStubJoin = edge.type === 'FieldJoin'
        && sourcePosition?.props?.visualCallStub === true;
      routedEdge = {
        ...routedEdge,
        props: {
          ...routedEdge.props,
          fanoutTurnGraphX: fanoutJoinPosition.x - horizontalStepForNode(fanoutJoin),
          ...(compactCallStubJoin
            ? {
                sourcePort: 'bottom',
                targetPort: 'left',
                compactCallStubJoin: true,
              }
            : {}),
          layoutRouteReason: [
            routedEdge.props?.layoutRouteReason,
            `${edge.type} turns on the common boundary determined by the widest sibling branch`,
            compactCallStubJoin ? 'compact call stub exits downward and passes below its function proxy' : '',
          ].filter(Boolean).join('; '),
        },
      };
    }
    renderEdges.push(routeExistingConnection(routedEdge, positions));
  }

  function deferValueOutcomeEdge(edge) {
    const key = `${edge.type}:${edge.start}->${edge.end}:${edge.id || ''}`;
    if (deferredValueOutcomeEdges.some((item) => `${item.type}:${item.start}->${item.end}:${item.id || ''}` === key)) return;
    deferredValueOutcomeEdges.push(edge);
  }

  function deferConnectionEdge(edge) {
    const key = `${edge.type}:${edge.start}->${edge.end}:${edge.id || ''}`;
    if (deferredConnectionEdges.some((item) => `${item.type}:${item.start}->${item.end}:${item.id || ''}` === key)) return;
    deferredConnectionEdges.push(edge);
  }

  function visualCallTargetKey(edge) {
    return `visual:call-target:${callInvocationType(edge)}:${callSiteStableIdForEdge(edge)}->${edge.end}`;
  }

  function edgeRenderKey(edge) {
    return `${edge.type}:${edge.start}->${edge.end}:${edge.id || ''}`;
  }

  function callTargetLabelName(targetNode) {
    return targetNode?.props?.missing_method_name
      || targetNode?.props?.missingMethodName
      || targetNode?.props?.name
      || targetNode?.props?.diaName
      || targetNode?.props?.label
      || 'function';
  }

  function copyMetaForSource(sourceNode) {
    const index = sourceNode?.props?.visualCopyIndex;
    const count = sourceNode?.props?.visualCopyCount;
    return index && count ? { visualCopyIndex: index, visualCopyCount: count } : {};
  }

  function shouldUseVisualProxy(copyMeta = {}) {
    return Number(copyMeta.visualCopyCount) > 1;
  }

  function copyMetaForCallTargetEdge(edge) {
    const sourceNode = nodeByKey.get(callSiteStableIdForEdge(edge));
    return copyMetaForSource(sourceNode);
  }

  function copyMetaForResourceEdge(edge) {
    return resourceCopyMetaByEdge.get(edgeCopyKey(edge)) || {};
  }

  function materializeCallVisualTarget(edge, x, y, reason, proxyProps = {}) {
    const target = nodeByKey.get(edge.end);
    const sourceNode = nodeByKey.get(edge.start);
    const callSiteNode = nodeByKey.get(callSiteStableIdForEdge(edge));
    const effectiveProxyProps = {
      ...(hasLabel(callSiteNode, 'Collection') ? { collectionCallBoundary: true } : {}),
      ...proxyProps,
    };
    // The visual target belongs to the call site's Step. For accessor and
    // result edges, edge.start may be an intermediate node owned by another
    // Step, while sourceCallStableId still identifies the actual invocation.
    const stepOwner = callSiteNode || sourceNode;
    if (!target) throw new Error(`newStraightDrawio missing call visual target: ${edge.end}`);
    if (!isCallTargetProxySource(sourceNode)) return null;
    const copyMeta = copyMetaForCallTargetEdge(edge);
    const proxyKey = visualCallTargetKey(edge);
    const materializedProxy = materializedFnProxyByCallTarget.get(`${callSiteStableIdForEdge(edge)}->${edge.end}`);
    if (materializedProxy) {
      visualCallTargetByEdgeKey.set(proxyKey, materializedProxy);
      materializedProxy.props = {
        ...materializedProxy.props,
        ...copyMeta,
        ...effectiveProxyProps,
        parentStepStableId: stepOwner?.props?.parentStepStableId,
        flowStepKind: stepOwner?.props?.flowStepKind,
        flowStepOrder: stepOwner?.props?.flowStepOrder,
        foldStepOwnerStableId: callSiteStableIdForEdge(edge),
        flow_layer: edge.props?.flow_layer || stepOwner?.props?.flow_layer || 'mixed',
      };
      if (!positions.has(materializedProxy.key)) {
        placeNode(
          positions,
          materializedProxy,
          x,
          y,
          reason,
          'placeMaterializedFnVisualProxy',
          [makeTraceStep('placeMaterializedFnVisualProxy', {
            edgeType: edge.type,
            from: edge.start,
            target: edge.end,
            placedX: x,
            placedY: y,
            reason: 'extractor-provided per-call FnVisualProxy represents the original function in this flow',
          })],
        );
      }
      return materializedProxy;
    }
    if (!visualCallTargetByEdgeKey.has(proxyKey)) {
      const proxy = {
        key: proxyKey,
        labels: ['VisualProxy', ...target.labels.filter((label) => ['Fn', 'Method', 'Missing', 'Getter', 'Setter'].includes(label))],
        props: {
          ...copyMeta,
          canonicalStableId: target.key,
          sourceCallStableId: callSiteStableIdForEdge(edge),
          foldStepOwnerStableId: callSiteStableIdForEdge(edge),
          name: callTargetLabelName(target),
          label: callTargetLabelName(target),
          parentStepStableId: stepOwner?.props?.parentStepStableId,
          flowStepKind: stepOwner?.props?.flowStepKind,
          flowStepOrder: stepOwner?.props?.flowStepOrder,
          flow_layer: edge.props?.flow_layer || stepOwner?.props?.flow_layer || 'mixed',
          ...effectiveProxyProps,
        },
      };
      visualCallTargetByEdgeKey.set(proxyKey, proxy);
      visualNodes.push(proxy);
    }
    const proxy = visualCallTargetByEdgeKey.get(proxyKey);
    nodeByKey.set(proxy.key, proxy);
    if (!positions.has(proxy.key)) {
      placeNode(
        positions,
        proxy,
        x,
        y,
        reason,
        'placeCallVisualProxy',
        [
          makeTraceStep('placeCallVisualProxy', {
            edgeType: edge.type,
            from: edge.start,
            target: edge.end,
            placedX: x,
            placedY: y,
            reason,
          }),
        ],
      );
    }
    if (Object.keys(effectiveProxyProps).length) {
      proxy.props = {
        ...proxy.props,
        ...effectiveProxyProps,
      };
    }
    return proxy;
  }

  function renderCallEdgeToVisualTarget(edge, proxy, options = {}) {
    const visualEdge = {
      ...edge,
      end: proxy.key,
      props: {
        ...edge.props,
        displayLabel: '',
        targetStableId: edge.end,
        canonicalTargetStableId: edge.end,
        layoutEffectiveTargetStableId: edge.end,
        sourcePort: edge.props?.sourcePort || options.sourcePort || 'right',
        targetPort: edge.props?.targetPort || options.targetPort || 'left',
      },
    };
    const key = edgeRenderKey(visualEdge);
    const renderInvocationEdge = edge.props?.render_hidden !== true && edge.props?.renderHidden !== true;
    if (renderInvocationEdge && !renderedEdgeKeys.has(key)) {
      renderedEdgeKeys.add(key);
      renderEdges.push(routeExistingConnection(visualEdge, positions));
    }
    const invocationType = callInvocationType(edge);
    const completionType = invocationType === 'REQUEST' ? 'RESPONSE' : 'RESULT';
    const callSiteStableId = callSiteStableIdForEdge(edge);
    const completionEdges = (outgoingBySource.get(edge.end) || [])
      .filter((candidate) => (
        candidate.type === completionType
        && callSiteStableIdForEdge(candidate) === callSiteStableId
      ));
    completionEdges.forEach((completionEdge) => {
      const rendersAssignmentCompletion = completionEdge.end !== callSiteStableId;
      if (completionType === 'RESPONSE' && !rendersAssignmentCompletion && proxy.props?.renderCompactResponse !== true) return;
      const completionTarget = nodeByKey.get(completionEdge.end);
      const continuesCollection = hasLabel(completionTarget, 'Collection');
      if (continuesCollection && !positions.has(completionTarget.key)) {
        const proxyPos = positions.get(proxy.key);
        placeNode(
          positions,
          completionTarget,
          proxyPos.x,
          proxyPos.y + 0.5,
          `newStraightDrawio: collection stage starts half a row below function proxy ${proxy.key}`,
          'placeCollectionAfterFnProxy',
          [makeTraceStep('placeCollectionAfterFnProxy', {
            from: proxy.key,
            edgeType: completionEdge.type,
            placedX: proxyPos.x,
            placedY: proxyPos.y + 0.5,
            reason: 'dot-call starts under the function result and keeps its callback expansion to the right',
          })],
        );
        pushContinuation({
          node: completionTarget,
          x: proxyPos.x,
          yStart: proxyPos.y + 0.5,
          reason: `collection stage after ${proxy.key}`,
          canPlaceRejoinTarget: false,
          keepRequestedRow: true,
        });
      }
      if (!positions.has(proxy.key) || !positions.has(completionEdge.end)) return;
      pushRenderEdge({
        ...completionEdge,
        start: proxy.key,
        props: {
          ...completionEdge.props,
          ...(completionType === 'RESPONSE' ? { renderCompactResponse: true } : {}),
          displayLabel: '',
          stableId: completionEdge.props?.stableId || completionEdge.start,
          targetStableId: completionEdge.end,
          canonicalTargetStableId: completionEdge.end,
          sourcePort: completionEdge.props?.sourcePort || (continuesCollection ? 'bottom' : rendersAssignmentCompletion ? 'bottom' : 'left-75'),
          targetPort: completionEdge.props?.targetPort || (continuesCollection ? 'top' : rendersAssignmentCompletion ? 'bottom' : 'right-75'),
          layoutRouteReason: rendersAssignmentCompletion
            ? `explicit ${completionType} from original Fn to value owner; rendered from proxy below the complete invocation snippet`
            : 'explicit compact RESPONSE from original Fn to request site',
        },
      });
    });
  }

  function visualResourceProxyKey(edge) {
    return `visual:resource:${edge.type}:${edge.start}->${edge.end}:${edge.id || ''}`;
  }

  function resourceProxyCellName(target) {
    const props = target?.props || {};
    const explicitName = props.setting_cell_name
      || props.resource_cell_name
      || props.settingName
      || props.resourceName
      || props.name
      || props.diaName
      || props.label;
    if (explicitName) return String(explicitName);
    const stableId = String(target?.key || props.stableId || '');
    const parts = stableId.split(':').map((part) => part.trim()).filter(Boolean);
    return parts.at(-1) || 'resource';
  }

  function materializeResourceVisualTarget(edge, x, y, reason, options = {}) {
    const target = nodeByKey.get(edge.end);
    if (!target) throw new Error(`newStraightDrawio missing resource proxy target: ${edge.end}`);
    const source = nodeByKey.get(edge.start);
    const ownerStepStableId = edge.props?.owner_step_stable_id
      || edge.props?.ownerStepStableId
      || source?.props?.parentStepStableId
      || '';
    const copyMeta = {
      ...copyMetaForResourceEdge(edge),
      ...(options.copyMeta || {}),
    };
    if (!shouldUseVisualProxy(copyMeta)) {
      if (!positions.has(target.key)) {
        target.props = {
          ...(target.props || {}),
          foldStepOwnerStableId: edge.start,
          flow_layer: 'data',
          ownerStepStableId,
        };
        placeNode(
          positions,
          target,
          x,
          y,
          reason,
          'placeResourceSingleUseTarget',
          [
            makeTraceStep('placeResourceSingleUseTarget', {
              edgeType: edge.type,
              from: edge.start,
              target: edge.end,
              placedX: x,
              placedY: y,
              reason: 'Resource/setting cell is used once in this diagram, so the canonical node is placed directly instead of a visual proxy',
            }),
          ],
        );
      }
      return target;
    }
    const proxyKey = visualResourceProxyKey(edge);
    if (!visualResourceProxyByEdgeKey.has(proxyKey)) {
      const cellName = resourceProxyCellName(target);
      const proxy = {
        key: proxyKey,
        labels: ['ResourceProxy', ...(target.labels || []).filter((label) => label !== 'ResourceProxy')],
        props: {
          ...(target.props || {}),
          ...copyMeta,
          diaName: cellName,
          label: cellName,
          setting_cell_name: cellName,
          resource_cell_name: cellName,
          canonicalStableId: target.key,
          sourceCallStableId: edge.start,
          foldStepOwnerStableId: edge.start,
          flow_layer: 'data',
          ownerStepStableId,
        },
      };
      visualResourceProxyByEdgeKey.set(proxyKey, proxy);
      visualNodes.push(proxy);
    }
    const proxy = visualResourceProxyByEdgeKey.get(proxyKey);
    nodeByKey.set(proxy.key, proxy);
    if (!positions.has(proxy.key)) {
      placeNode(
        positions,
        proxy,
        x,
        y,
        reason,
        'placeResourceVisualProxy',
        [
          makeTraceStep('placeResourceVisualProxy', {
            edgeType: edge.type,
            from: edge.start,
            target: edge.end,
            placedX: x,
            placedY: y,
            reason,
          }),
        ],
      );
    }
    return proxy;
  }

  function renderResourceEdgeToVisualTarget(edge, proxy, options = {}) {
    const visualEdge = {
      ...edge,
      end: proxy.key,
      props: {
        ...edge.props,
        targetStableId: edge.end,
        canonicalTargetStableId: edge.end,
        layoutEffectiveTargetStableId: edge.end,
        sourcePort: edge.props?.sourcePort || options.sourcePort,
        targetPort: edge.props?.targetPort || options.targetPort,
      },
    };
    const key = edgeRenderKey(visualEdge);
    if (!renderedEdgeKeys.has(key)) {
      renderedEdgeKeys.add(key);
      renderEdges.push(routeExistingConnection(visualEdge, positions));
    }
  }

  function placeCallLikeEdgeTarget(edge, child, x, y, reason) {
    if (edge.type === 'REQUEST' && positions.has(edge.start) && isCallFinishNode(nodeByKey.get(edge.start))) {
      edge.props = {
        ...edge.props,
        sourcePort: edge.props?.sourcePort || 'right-25',
        targetPort: edge.props?.targetPort || 'left-25',
      };
    }
    const routed = placeEdgeTarget(edge, child, x, y, reason);
    const key = `${routed.type}:${routed.start}->${routed.end}:${routed.id || ''}`;
    if (!renderedEdgeKeys.has(key)) {
      renderedEdgeKeys.add(key);
      renderEdges.push(routed);
    }
  }

  function placeEdgeTarget(edge, child, x, y, reason, options = {}) {
    materializePendingNode(child);
    return placeEdgeTargetIfNeeded({
      edge,
      child,
      positions,
      x,
      y,
      reason,
      avoidRightFootprintWidth: options.avoidRightFootprintWidth || 0,
      rightFootprintRowPicker: (positionsMap, preferredY, rowX, width) => (
        firstRowAfterRightFootprintWithEdges(
          positionsMap,
          preferredY,
          rowX,
          width,
          fanoutOwnerStepStableId(child),
          child,
        )
      ),
      keepRequestedRow: options.keepRequestedRow || false,
    });
  }

  function lowestPositionedRejoinSourceY(targetKey) {
    const ys = edges
      .filter((edge) => edge.type === 'REJOINS' && edge.end === targetKey)
      .map((edge) => positions.get(edge.start)?.y)
      .filter((value) => Number.isFinite(value));
    return ys.length ? Math.max(...ys) : undefined;
  }

  function unpositionedRejoinSourceIds(targetKey) {
    return edges
      .filter((edge) => edge.type === 'REJOINS' && edge.end === targetKey)
      .map((edge) => edge.start)
      .filter((sourceKey) => !positions.has(sourceKey));
  }

  function deferFlowJoinUntilRejoins(node, edge, x, yStart, reason, fanoutMeta = null) {
    const existing = pendingByKey.get(node.key);
    const pending = existing || {
      node,
      edge,
      x,
      yStart,
      reason,
      extraEdges: [],
      avoidRightFootprint: false,
      avoidRightFootprintWidth: 0,
      afterFanoutOwnerKey: null,
      fanoutMeta,
      stopAt: null,
      stopStack: [],
      canPlaceRejoinTarget: true,
      keepRequestedRow: false,
      trace: [],
    };
    pending.x = Math.min(pending.x, x);
    pending.yStart = Math.max(pending.yStart, yStart);
    pending.fanoutMeta ||= fanoutMeta;
    pending.trace.push(makeTraceStep('deferFlowJoinUntilRejoins', {
      edgeType: edge.type,
      from: edge.start,
      x: pending.x,
      yStart: pending.yStart,
      waitingFor: unpositionedRejoinSourceIds(node.key),
      reason,
    }));
    pendingByKey.set(node.key, pending);
  }

  function alignFlowJoinToRejoinSource(child, source, sourcePos, edge, reason) {
    if (!isFlowJoinNode(child) || !Number.isFinite(sourcePos?.y)) return;
    const pending = pendingByKey.get(child.key);
    if (pending) {
      const nextYStart = Math.max(pending.yStart, sourcePos.y);
      pendingByKey.set(child.key, {
        ...pending,
        yStart: nextYStart,
        trace: [
          ...(pending.trace || []),
          makeTraceStep('alignPendingFlowJoinToRejoinSource', {
            from: source.key,
            edgeType: edge.type,
            previousYStart: pending.yStart,
            rejoinSourceY: sourcePos.y,
            nextYStart,
            reason,
          }),
        ],
      });
      appendNodeTrace(positions, source.key, 'alignPendingFlowJoinToRejoinSource', {
        target: child.key,
        edgeType: edge.type,
        previousYStart: pending.yStart,
        nextYStart,
        reason,
      });
      return;
    }

    const pos = positions.get(child.key);
    if (!pos || sourcePos.y <= pos.y) return;
    const placedX = flowJoinPlacementX(child, pos.x);
    const joinY = flowJoinPlacementY(child, placedX, sourcePos.y);
    const requestedY = Math.max(pos.y, sourcePos.y, joinY.y);
    const placedY = joinY.alignedToRightIncoming && requestedY === joinY.y
      ? joinY.y
      : firstFreeHorizontalIgnoring(positions, requestedY, placedX, child.key);
    placeNode(
      positions,
      child,
      placedX,
      placedY,
      `newStraightDrawio: FlowJoin ${child.key} aligned down to lowest REJOINS source ${source.key}`,
      'alignPlacedFlowJoinToRejoinSource',
      [
        ...(pos.trace || []),
        makeTraceStep('alignPlacedFlowJoinToRejoinSource', {
          from: source.key,
          edgeType: edge.type,
          previousX: pos.x,
          previousY: pos.y,
          rejoinSourceY: sourcePos.y,
          alignedRightIncomingSource: joinY.sourceKey,
          alignedRightIncomingEdgeType: joinY.edgeType,
          leftmostIncomingSourceX: leftmostPositionedIncomingSourceX(child.key),
          placedX,
          placedY,
          reason,
        }),
      ],
    );
  }

  function positionRejoinTargets(source, sourcePos, rejoinEdges, stopAtKey = null) {
    let continuation = null;
    rejoinEdges.forEach((edge) => {
      const child = nodeByKey.get(edge.end);
      if (!child) throw new Error(`newStraightDrawio missing REJOINS target node: ${edge.end}`);
      if (!isFlowJoinNode(child)) {
        throw new Error(`newStraightDrawio REJOINS target must be FlowJoin: ${edge.start} -> ${edge.end}`);
      }
      const waitingForSiblingSources = unpositionedRejoinSourceIds(child.key)
        .filter((sourceKey) => sourceKey !== source.key);
      const backboneSourceId = String(child.props?.flowJoinBackboneSourceStableId || '').trim();
      if (
        backboneSourceId
        && backboneSourceId !== source.key
        && !positions.has(backboneSourceId)
        && !waitingForSiblingSources.includes(backboneSourceId)
      ) {
        waitingForSiblingSources.push(backboneSourceId);
      }
      if (waitingForSiblingSources.length && !pendingByKey.has(child.key)) {
        deferFlowJoinUntilRejoins(
          child,
          edge,
          flowJoinPlacementX(child, sourcePos.x),
          sourcePos.y,
          `newStraightDrawio: FlowJoin ${child.key} waits for sibling REJOINS sources before placement`,
          inheritFanoutMeta(sourcePos),
        );
        appendNodeTrace(positions, source.key, 'deferRejoinUntilSiblingSources', {
          target: child.key,
          waitingFor: waitingForSiblingSources,
          reason: 'A join is positioned only after its backbone and every side endpoint have acquired coordinates',
        });
        return;
      }
      if (child.key === stopAtKey) {
        alignFlowJoinToRejoinSource(child, source, sourcePos, edge, 'REJOINS reaches the current branch boundary');
        appendNodeTrace(positions, source.key, 'rejoinBoundaryRegistered', {
          target: child.key,
          edgeType: edge.type,
          sourceX: sourcePos?.x,
          sourceY: sourcePos?.y,
          stopAt: stopAtKey,
          reason: 'REJOINS reaches the current branch boundary; FlowJoin is left for the deferred senior/down lane',
        });
        if (positions.has(child.key) && hasUntraversedContinuation(child) && !continuation) {
          continuation = child;
        }
        return;
      }
      if (pendingByKey.has(child.key)) {
        const pending = pendingByKey.get(child.key);
        if (!pending.extraEdges.some((candidate) => (
          candidate.start === edge.start
          && candidate.end === edge.end
          && candidate.type === edge.type
        ))) {
          pending.extraEdges.push(edge);
        }
        alignFlowJoinToRejoinSource(child, source, sourcePos, edge, 'REJOINS target is already scheduled by the senior/down lane');
        appendNodeTrace(positions, source.key, 'rejoinBoundaryRegistered', {
          target: child.key,
          edgeType: edge.type,
          sourceX: sourcePos?.x,
          sourceY: sourcePos?.y,
          reason: 'REJOINS target is already scheduled by the senior/down lane; keep it pending and draw this edge after placement',
        });
        if (!unpositionedRejoinSourceIds(child.key).length) {
          materializePendingNode(child);
          pendingByKey.delete(child.key);
          if (pending?.edge) pushRenderEdge(pending.edge);
          for (const extraEdge of pending?.extraEdges || []) pushRenderEdge(extraEdge);
          pushRenderEdge(edge);
          if (!continuation) continuation = child;
        }
        return;
      }
      if (positions.has(child.key)) {
        alignFlowJoinToRejoinSource(child, source, sourcePos, edge, 'REJOINS reached an already positioned FlowJoin');
        appendNodeTrace(positions, child.key, 'rejoinTargetAlreadyPlaced', {
          from: source.key,
          edgeType: edge.type,
          reason: 'REJOINS reached an already positioned FlowJoin',
        });
        if (!continuation) continuation = child;
        return;
      }
      const placedX = flowJoinPlacementX(child, sourcePos.x);
      const joinY = flowJoinPlacementY(child, placedX, sourcePos.y);
      const requestedYStart = joinY.y;
      const y = joinY.alignedToRightIncoming
        ? joinY.y
        : firstFreeHorizontal(positions, requestedYStart, placedX);
      placeNode(
        positions,
        child,
        placedX,
        y,
        `newStraightDrawio: REJOINS target FlowJoin from ${source.key}; local join continuation`,
        'positionRejoinTarget',
        [
          makeTraceStep('positionRejoinTarget', {
            from: source.key,
            edgeType: edge.type,
            requestedX: sourcePos.x,
            requestedYStart,
            alignedRightIncomingSource: joinY.sourceKey,
            alignedRightIncomingEdgeType: joinY.edgeType,
            leftmostIncomingSourceX: leftmostPositionedIncomingSourceX(child.key),
            placedX,
            placedY: y,
            stopAt: stopAtKey,
            reason: 'REJOINS materializes a local FlowJoin only when it is not the active branch boundary',
          }),
        ],
      );
      if (!continuation) continuation = child;
    });
    return continuation;
  }

  function hasUntraversedContinuation(node) {
    return originalOutgoing(edges, node.key)
      .filter((edge) => !['RESPONSE', 'RESULT', 'REJOINS', 'REPEATS'].includes(edge.type))
      .some((edge) => !positions.has(edge.end) || !renderEdges.some((renderEdge) => (
        renderEdge.start === edge.start
        && renderEdge.end === edge.end
        && renderEdge.type === edge.type
      )));
  }

  function placeSlotBranchTarget(edge, child, x, y, sourcePort, reason, fanoutMeta = undefined) {
    const locksHorizontalFieldAlternative = isSlotBranchNode(nodeByKey.get(edge.start))
      && edge.type === 'FALSE';
    const routedEdge = {
      ...edge,
      props: {
        ...edge.props,
        sourcePort,
        targetPort: edge.props?.targetPort || 'left',
        ...(locksHorizontalFieldAlternative ? {
          sourcePortCandidates: [sourcePort],
          targetPortCandidates: ['left'],
          lockPortCandidates: true,
        } : {}),
      },
    };
    if (!positions.has(child.key)) {
      placeNode(
        positions,
        child,
        x,
        y,
        reason,
        'placeSlotBranchTarget',
        [
          makeTraceStep('placeSlotBranchTarget', {
            edgeType: edge.type,
            from: edge.start,
            requestedX: x,
            requestedY: y,
            placedX: x,
            placedY: y,
            sourcePort,
            targetPort: 'left',
            reason,
          }),
        ],
      );
    }
    if (fanoutMeta) setFanoutMeta(child.key, fanoutMeta);
    pushRenderEdge(routedEdge);
    return routedEdge;
  }

  function nextPendingCurrent() {
    while (pendingCurrents.length) {
      const pending = pendingCurrents.pop();
      materializePendingNode(pending.node);
      pendingByKey.delete(pending.node.key);
      if (!positions.has(pending.node.key)) {
        const footprintWidth = pendingRightFootprintWidth(pending);
        const y = pending.keepRequestedRow
          ? pending.yStart
          : pending.avoidRightFootprint
            ? firstRowAfterRightFootprintWithEdges(
              positions,
              pending.yStart,
              pending.x,
              footprintWidth,
              fanoutOwnerStepStableId(pending.node),
              pending.node,
            )
            : firstFreeHorizontal(positions, pending.yStart, pending.x);
        placeNode(
          positions,
          pending.node,
          pending.x,
          y,
          pending.reason,
          'popPendingCurrent',
          [
            ...(pending.trace || []),
            makeTraceStep('popPendingCurrent', {
              requestedX: pending.x,
              requestedYStart: pending.yStart,
              placedX: pending.x,
              placedY: y,
              avoidRightFootprint: pending.avoidRightFootprint,
              ownRightFootprintWidth: footprintWidth,
              keepRequestedRow: pending.keepRequestedRow,
              reason: pending.reason,
            }),
          ],
        );
      }
      if (pending.edge) {
        pushRenderEdge(pending.edge);
      }
      for (const extraEdge of pending.extraEdges || []) {
        pushRenderEdge(extraEdge);
      }
      if (visited.has(pending.node.key)) continue;
      currentStopStack = pending.stopStack || (pending.stopAt ? [pending.stopAt] : []);
      currentStopAt = currentStopStack[currentStopStack.length - 1] || null;
      currentCanPlaceRejoinTarget = pending.canPlaceRejoinTarget !== false;
      return pending.node;
    }
    return null;
  }

  function pushContinuation({
    node,
    edge = null,
    x,
    yStart,
    reason,
    avoidRightFootprint = false,
    avoidRightFootprintWidth = Number.POSITIVE_INFINITY,
    reservePosition = false,
    afterFanoutOwnerKey = null,
    fanoutMeta = null,
    stopAt = null,
    stopStack = null,
    canPlaceRejoinTarget = true,
    keepRequestedRow = false,
  }) {
    const pendingStopStack = stopStack || (stopAt ? [stopAt] : currentStopStack);
    if (!node) return;
    if (visited.has(node.key)) {
      if (edge && positions.has(edge.start) && positions.has(node.key)) pushRenderEdge(edge);
      return;
    }
    const traceStep = makeTraceStep('pushContinuation', {
      x,
      yStart,
      edgeType: edge?.type,
      from: edge?.start,
      avoidRightFootprint,
      avoidRightFootprintWidth: Number.isFinite(avoidRightFootprintWidth) ? avoidRightFootprintWidth : undefined,
      reservePosition,
      keepRequestedRow,
      afterFanoutOwnerKey,
      stopAt: pendingStopStack[pendingStopStack.length - 1],
      reason,
    });
    const pending = {
      node,
      edge,
      x,
      yStart,
      reason,
      extraEdges: [],
      avoidRightFootprint,
      avoidRightFootprintWidth,
      afterFanoutOwnerKey,
      fanoutMeta,
      stopAt: pendingStopStack[pendingStopStack.length - 1] || null,
      stopStack: pendingStopStack,
      canPlaceRejoinTarget,
      keepRequestedRow,
      trace: [traceStep],
    };
    const existing = pendingByKey.get(node.key);
    if (existing) {
      const keepExisting = existing.x < x || (existing.x === x && existing.yStart <= yStart);
      if (keepExisting) {
        if (edge) existing.extraEdges.push(edge);
        existing.trace.push(makeTraceStep('keepExistingContinuation', {
          ignoredX: x,
          ignoredYStart: yStart,
          keptX: existing.x,
          keptYStart: existing.yStart,
          edgeType: edge?.type,
          reason,
        }));
        if (debug) console.error(`keep pending ${node.key} at ${existing.x},>=${existing.yStart}; ignore ${x},>=${yStart}: ${reason}`);
        return;
      }
      if (existing.edge) pending.extraEdges.push(existing.edge);
      pending.extraEdges.push(...(existing.extraEdges || []));
      pending.trace = [
        ...(existing.trace || []),
        makeTraceStep('replacePendingContinuation', {
          previousX: existing.x,
          previousYStart: existing.yStart,
          nextX: x,
          nextYStart: yStart,
          reason,
        }),
        traceStep,
      ];
      if (debug) console.error(`replace pending ${node.key} ${existing.x},>=${existing.yStart} -> ${x},>=${yStart}: ${reason}`);
    }
    if (debug) console.error(`push pending ${node.key} at ${x},>=${yStart}: ${reason}`);
    pendingCurrents.push(pending);
    pendingByKey.set(node.key, pending);
    const pos = positions.get(node.key);
    if (pos) {
      if (reservePosition && !visited.has(node.key) && (pos.x > x || pos.y < yStart)) {
        const footprintWidth = pendingRightFootprintWidth(pending);
        const reservedY = keepRequestedRow
          ? yStart
          : avoidRightFootprint
            ? firstRowAfterRightFootprintWithEdges(
              positions,
              yStart,
              x,
              footprintWidth,
              fanoutOwnerStepStableId(node),
              node,
            )
            : firstFreeHorizontal(positions, yStart, x);
        positions.set(node.key, {
          ...pos,
          x,
          y: reservedY,
          reason: `${pos.reason}; reserved continuation overrides previous position: ${reason}`,
          trace: [
            ...(pos.trace || []),
            traceStep,
            makeTraceStep('reservePendingPositionOverride', {
              previousX: pos.x,
              previousY: pos.y,
              requestedX: x,
              requestedYStart: yStart,
              placedX: x,
              placedY: reservedY,
              avoidRightFootprint,
              ownRightFootprintWidth: footprintWidth,
              keepRequestedRow,
              reason,
            }),
          ],
        });
        return;
      }
      appendNodeTrace(positions, node.key, 'scheduleContinuationForPlacedNode', {
        x,
        yStart,
        edgeType: edge?.type,
        reason: `scheduled continuation: ${reason}`,
      });
    } else if (reservePosition) {
      const footprintWidth = pendingRightFootprintWidth(pending);
      const reservedY = keepRequestedRow
        ? yStart
        : avoidRightFootprint
          ? firstRowAfterRightFootprintWithEdges(
            positions,
            yStart,
            x,
            footprintWidth,
            fanoutOwnerStepStableId(node),
            node,
          )
          : firstFreeHorizontal(positions, yStart, x);
      placeNode(
        positions,
        node,
        x,
        reservedY,
        `${reason}; reserved before sibling traversal`,
        'reservePendingPosition',
        [
          traceStep,
          makeTraceStep('reservePendingPosition', {
            requestedX: x,
            requestedYStart: yStart,
            placedX: x,
            placedY: reservedY,
            avoidRightFootprint,
            ownRightFootprintWidth: footprintWidth,
            keepRequestedRow,
            reason,
          }),
        ],
      );
    }
  }

  while (current) {
    if (currentStopAt && current.key === currentStopAt) {
      appendNodeTrace(positions, current.key, 'stopAtJoinBoundary', {
        stopAt: currentStopAt,
        reason: 'side branch reached join boundary; shared continuation is left for vertical/down lane',
      });
      if (!visited.has(current.key) && pendingByKey.has(current.key)) {
        const pos = positions.get(current.key);
        positions.delete(current.key);
        const pending = pendingByKey.get(current.key);
        pending.trace = [
          ...(pos?.trace || []),
          ...(pending.trace || []),
          makeTraceStep('releaseSideJoinPosition', {
            previousX: pos?.x,
            previousY: pos?.y,
            stopAt: currentStopAt,
            reason: 'side branch endpoint reached a shared join before the vertical/down lane materialized it',
          }),
        ];
        currentStopStack = currentStopStack.slice(0, -1);
        currentStopAt = currentStopStack[currentStopStack.length - 1] || null;
        current = nextPendingCurrent();
        continue;
      }
      currentStopStack = currentStopStack.slice(0, -1);
      currentStopAt = currentStopStack[currentStopStack.length - 1] || null;
    }
    if (visited.has(current.key)) {
      current = nextPendingCurrent();
      continue;
    }
    visited.add(current.key);

    let currentPos = positions.get(current.key);
    const outgoingAll = originalOutgoing(edges, current.key)
      .filter((edge) => edge.type !== 'RESPONSE')
      .filter((edge) => edge.type !== 'RESULT' || isCallResultNode(nodeByKey.get(edge.end)))
      .filter((edge) => !(
        isFnVisualProxyNode(current)
        && CALL_TARGET_EDGE_TYPES.has(edge.type)
      ));
    const rejoinEdges = outgoingAll.filter((edge) => edge.type === 'REJOINS');
    const repeatEdges = outgoingAll.filter((edge) => edge.type === 'REPEATS');
    const producerReturnEdges = outgoingAll.filter((edge) => (
      ['ASSIGNS_VALUE', 'YIELDS_VALUE'].includes(edge.type)
      && ['return-top', 'return-bottom'].includes(
        edge.props?.producerRouteRole || edge.props?.producer_route_role || '',
      )
    ));
    producerReturnEdges.forEach(deferConnectionEdge);
    const rejoinContinuation = rejoinEdges.length
      ? positionRejoinTargets(current, currentPos, rejoinEdges, currentStopAt)
      : null;
    repeatEdges.forEach((edge) => {
      if (positions.has(edge.end)) pushRenderEdge(edge);
    });
    if (rejoinContinuation && (!visited.has(rejoinContinuation.key) || hasUntraversedContinuation(rejoinContinuation))) {
      const continuationPos = positions.get(rejoinContinuation.key) || currentPos;
      visited.delete(rejoinContinuation.key);
      pushContinuation({
        node: rejoinContinuation,
        x: continuationPos.x,
        yStart: continuationPos.y,
        reason: `newStraightDrawio: resume untraversed continuation after REJOINS from ${current.key}`,
        stopStack: [],
        canPlaceRejoinTarget: true,
        keepRequestedRow: true,
      });
    }
    const outgoing = outgoingAll.filter((edge) => (
      edge.type !== 'REJOINS'
      && edge.type !== 'REPEATS'
      && !producerReturnEdges.includes(edge)
    ));
    coordinateExpressionMosaicOwner(nodes, positions, current, currentPos);
    if (!outgoing.length) {
      current = nextPendingCurrent();
      continue;
    }

    const hybridVisualRole = String(
      current.props?.hybridVisualRole
      || current.props?.hybrid_visual_role
      || '',
    );
    if (hybridVisualRole === 'submethod-event' || hasLabel(current, 'SubStepMember')) {
      outgoing.forEach((edge) => {
        if ((edge.props?.protocolRole || edge.props?.protocol_role) === 'assignment-return') {
          deferConnectionEdge(edge);
        } else if (positions.has(edge.end)) {
          pushRenderEdge(edge);
        }
      });
      current = nextPendingCurrent();
      continue;
    }

    if (hasLabel(current, 'FunctionProxy') && !(hasLabel(current, 'LocalFunctionProxy') && shouldExpandLocalFunctionProxy(options))) {
      current = nextPendingCurrent();
      continue;
    }

    if (isFnVisualProxyNode(current)) {
      const resultEdge = outgoing.find((edge) => edge.type === 'RESULT' && isCallResultNode(nodeByKey.get(edge.end)));
      const continuationEdge = outgoing.find((edge) => edge.type === 'NEXT');
      const nextEdge = resultEdge || continuationEdge;
      if (!nextEdge) {
        current = nextPendingCurrent();
        continue;
      }
      const child = nodeByKey.get(nextEdge.end);
      if (!child) throw new Error(`newStraightDrawio missing proxy continuation node: ${nextEdge.end}`);
      if (!positions.has(child.key)) {
        placeNode(
          positions,
          child,
          resultEdge ? currentPos.x + horizontalStepForNode(current) : (explicitSourcePartPosition(nextEdge)?.x ?? currentPos.x),
          resultEdge ? currentPos.y : currentPos.y + 1,
          resultEdge
            ? `newStraightDrawio: materialized call result follows closing proxy ${current.key}`
            : `newStraightDrawio: flow continues below closing proxy ${current.key}`,
          resultEdge ? 'placeCallResultAfterProxy' : 'placeAfterCallProxy',
        );
      }
      pushRenderEdge(nextEdge);
      current = child;
      continue;
    }

    if (hasLabel(current, 'UiSurface')) {
      outgoing.forEach((sideEdge, index) => {
        const sideChild = nodeByKey.get(sideEdge.end);
        if (!sideChild) {
          throw new Error(`newStraightDrawio missing side-only child node: ${sideEdge.end}`);
        }
        renderEdges.push(placeEdgeTarget(
          sideEdge,
          sideChild,
          currentPos.x + horizontalStepForNode(current),
          currentPos.y + index,
          `newStraightDrawio: ${sideEdge.type} side-only edge of ${current.key}`,
        ));
        if (hasLabel(sideChild, 'UiSurface')) {
          pushContinuation({
            node: sideChild,
            x: currentPos.x + horizontalStepForNode(current),
            yStart: currentPos.y + index,
            reason: `newStraightDrawio: pending ${sideEdge.type} side-only edge of ${current.key}`,
            canPlaceRejoinTarget: false,
          });
        }
      });
      current = nextPendingCurrent();
      continue;
    }

    if (
      (isLocalValueDeclarationNode(current) || isComputedBooleanValueNode(current) || isFlowEvalNode(current))
      && !opensObjectFamilyFromMosaic(current)
      && !outgoing.some((edge) => edge.type === 'FIELD' && isObjectBraceNode(nodeByKey.get(edge.end)))
    ) {
      const byType = new Map();
      for (const edge of outgoing) byType.set(edge.type, [...(byType.get(edge.type) || []), edge]);
      const nextEdges = [
        ...(byType.get('NEXT') || []),
        ...(byType.get('ArgJoin') || []),
        ...(byType.get('FieldJoin') || []),
        ...(byType.get('XOR_JOIN') || []),
      ];
      const evalEdges = [
        ...(byType.get('EVAL') || []),
        ...(hasLabel(current, 'CallbackFn') ? (byType.get('ARROW') || []) : []),
      ];
      const valueEdges = (byType.get('VALUE') || []).filter((edge) => isValueOutcomeNode(nodeByKey.get(edge.end)));
      const valueOutcomeTargets = new Set(valueEdges.map((edge) => edge.end));
      const conditionOutcomeTypes = new Set(['TRUE', 'FALSE']);
      const otherTypes = [...byType.keys()].filter((type) => {
        if (type === 'NEXT' || type === 'ArgJoin' || type === 'FieldJoin' || type === 'XOR_JOIN' || type === 'EVAL' || type === 'VALUE') return false;
        if (type === 'ARROW' && hasLabel(current, 'CallbackFn')) return false;
        if (conditionOutcomeTypes.has(type)) {
          return (byType.get(type) || []).some((edge) => !valueOutcomeTargets.has(edge.end));
        }
        return true;
      });
      const ownsBooleanOutcomes = isComputedBooleanValueNode(current) || isFlowEvalNode(current);
      if (nextEdges.length > 1 || evalEdges.length > 1 || otherTypes.length || (!ownsBooleanOutcomes && valueEdges.length)) {
        throw new Error(`newStraightDrawio local value invariant failed for ${current.key}: ${outgoing.map((edge) => edge.type).join(',')}`);
      }

      const evalEdge = evalEdges[0];
      const evalChild = evalEdge ? nodeByKey.get(evalEdge.end) : null;
      if (evalEdge && !evalChild) throw new Error(`newStraightDrawio missing EVAL child node: ${evalEdge.end}`);
      const evalGroupFootprint = measureComputedEvalGroup(current, evalChild, currentPos);
      currentPos = shiftComputedEvalGroupHead(current, currentPos, evalGroupFootprint);
      const nestedDataBranchEvaluation = String(
        current.props?.nestedEvaluationDirection
        || current.props?.nested_evaluation_direction
        || '',
      ) === 'down';
      const evalTargetY = horizontalEvalTargetY(
        current,
        evalChild,
        evalEdge,
        currentPos.y,
        nestedDataBranchEvaluation,
      );
      if (evalEdge && evalChild) {
        renderEdges.push(placeEdgeTarget(
          evalEdge,
          evalChild,
          nestedDataBranchEvaluation ? currentPos.x : currentPos.x + 1,
          nestedDataBranchEvaluation ? currentPos.y + 1 : evalTargetY,
          `newStraightDrawio: EVAL from local value ${current.key} to the expression entry`,
          nestedDataBranchEvaluation
            ? { keepRequestedRow: true }
            : ownsBooleanOutcomes
            ? { keepRequestedRow: true }
            : { avoidRightFootprintWidth: ownRightFootprintWidth(evalChild, currentPos.x + 1), keepRequestedRow: true },
        ));
        setFanoutMeta(evalChild.key, pushFanoutContext(currentPos, {
          ownerKey: current.key,
          parentY: evalTargetY,
          familyMinY: Math.min(currentPos.y, evalTargetY),
          familyMaxY: Math.max(currentPos.y, evalTargetY),
        }));
      }

      if (ownsBooleanOutcomes && valueEdges.length) {
        const flowOutcomeNodes = [];
        const laysOutCallbackPredicate = hasLabel(current, 'CallbackFn') && isOperandBranchNode(evalChild);
        const callbackOutcomeX = laysOutCallbackPredicate
          ? currentPos.x + 1 + Math.max(1, operandChainLengthFrom(evalChild.key, nodeByKey, outgoingBySource))
          : undefined;
        valueEdges.forEach((valueEdge, index) => {
          const outcome = nodeByKey.get(valueEdge.end);
          if (!outcome) throw new Error(`newStraightDrawio missing ValueOutcome child node: ${valueEdge.end}`);
          const isFalsyFlowOutcome = isFlowEvalNode(current) && hasLabel(outcome, 'FalsyOutcome');
          const isTruthyFlowOutcome = isFlowEvalNode(current) && hasLabel(outcome, 'TruthyOutcome');
          const outcomeX = laysOutCallbackPredicate
            ? callbackOutcomeX
            : isFalsyFlowOutcome
              ? currentPos.x
              : isTruthyFlowOutcome
                ? currentPos.x + 1
                : currentPos.x + LOCAL_VALUE_OUTCOME_X_OFFSET;
          const outcomeY = laysOutCallbackPredicate
            ? currentPos.y + (hasLabel(outcome, 'TruthyOutcome') ? -SLOT_BRANCH_VERTEX_Y_OFFSET : SLOT_BRANCH_VERTEX_Y_OFFSET)
            : isFlowEvalNode(current)
              ? currentPos.y + OUTCOME_DIRECT_ENTRY_Y_OFFSET + (isTruthyFlowOutcome ? FLOW_OUTCOME_Y_STEP : 0)
              : currentPos.y + OUTCOME_DIRECT_ENTRY_Y_OFFSET + index * FLAG_OUTCOME_Y_STEP;
          placeNode(
            positions,
            outcome,
            outcomeX,
            outcomeY,
            isFlowEvalNode(current)
              ? `newStraightDrawio: Flow outcome ${valueEdge.label || index + 1} under Eval ${current.key}`
              : `newStraightDrawio: ValueOutcome ${valueEdge.label || index + 1} under ComputedValue ${current.key}`,
          );
          setNodePositionMeta(positions, outcome.key, {
            props: {
              displayWidth: FLAG_OUTCOME_WIDTH,
              foldStepOwnerStableId: current.key,
            },
          });
          edges
            .filter((edge) => (edge.type === 'TRUE' || edge.type === 'FALSE') && edge.end === outcome.key)
            .forEach((edge) => deferValueOutcomeEdge(edge));
          if (isFlowEvalNode(current)) flowOutcomeNodes.push(outcome);
          if (hasLabel(current, 'CallbackFn')) {
            callbackOutcomePlacementByKey.set(outcome.key, { x: outcomeX, y: outcomeY });
            for (const callbackResultEdge of outgoingBySource.get(outcome.key) || []) {
              const callbackResult = nodeByKey.get(callbackResultEdge.end);
              if (callbackResultEdge.type !== 'XOR_JOIN' || !hasLabel(callbackResult, 'CallbackResult')) continue;
              callbackResultPlacementByKey.set(callbackResult.key, {
                x: outcomeX + 1,
                y: currentPos.y,
              });
            }
            const outcomePos = positions.get(outcome.key);
            pushContinuation({
              node: outcome,
              x: outcomePos?.x ?? outcomeX,
              yStart: outcomePos?.y ?? outcomeY,
              reason: `newStraightDrawio: callback outcome continues to its exclusive result ${current.key}`,
              keepRequestedRow: true,
              canPlaceRejoinTarget: false,
            });
          }
        });
        if (isFlowEvalNode(current)) {
          const falsyOutcome = flowOutcomeNodes.find((outcome) => hasLabel(outcome, 'FalsyOutcome'));
          const truthyOutcome = flowOutcomeNodes.find((outcome) => hasLabel(outcome, 'TruthyOutcome'));
          if (!falsyOutcome || !truthyOutcome) {
            throw new Error(`newStraightDrawio Eval has no true/false outcomes: ${current.key}`);
          }
          pushContinuation({
            node: falsyOutcome,
            x: currentPos.x,
            yStart: currentPos.y + 1,
            reason: `newStraightDrawio: false outcome resumes the main vertical flow of ${current.key}`,
            keepRequestedRow: true,
            canPlaceRejoinTarget: true,
          });
          pushContinuation({
            node: truthyOutcome,
            x: currentPos.x + 1,
            yStart: currentPos.y + 1,
            reason: `newStraightDrawio: true outcome starts nested execution of ${current.key}`,
            keepRequestedRow: true,
            canPlaceRejoinTarget: false,
          });
        }
      }

      if (nextEdges.length) {
        const nextEdge = nextEdges[0];
        const nextChild = nodeByKey.get(nextEdge.end);
        if (!nextChild) throw new Error(`newStraightDrawio missing ${nextEdge.type} child node: ${nextEdge.end}`);
        const closesFamily = nextEdge.type === 'ArgJoin' || nextEdge.type === 'FieldJoin';
        const evalStartX = nestedDataBranchEvaluation ? currentPos.x : currentPos.x + 1;
        const evalWidth = evalChild ? ownRightFootprintWidth(evalChild, evalStartX) : 0;
        pushContinuation({
          node: nextChild,
          edge: nextEdge,
          x: closesFamily ? evalStartX + Math.max(1, evalWidth) : currentPos.x,
          yStart: closesFamily ? currentPos.y : currentPos.y + 1,
          reason: `newStraightDrawio: ${nextEdge.type} child of ComputedValue ${current.key}; delayed until EVAL side expression finishes`,
          avoidRightFootprint: !closesFamily,
          afterFanoutOwnerKey: closesFamily ? current.key : null,
          avoidRightFootprintWidth: Math.max(1, evalChild ? ownRightFootprintWidth(evalChild, currentPos.x + 1) + 1 : 1, valueEdges.length ? 2 : 0),
          canPlaceRejoinTarget: true,
        });
      }

      currentCanPlaceRejoinTarget = false;
      current = evalChild || nextPendingCurrent();
      continue;
    }

    const terminalValueOutcomeEdges = outgoing.filter((edge) => (
      (edge.type === 'TRUE' || edge.type === 'FALSE')
      && isValueOutcomeNode(nodeByKey.get(edge.end))
    ));
    if (terminalValueOutcomeEdges.length === outgoing.length) {
      terminalValueOutcomeEdges.forEach((edge) => deferValueOutcomeEdge(edge));
      current = nextPendingCurrent();
      continue;
    }

    if (isObjectFieldNode(current)) {
      const byType = new Map();
      for (const edge of outgoing) byType.set(edge.type, [...(byType.get(edge.type) || []), edge]);
      const fieldEdges = [...(byType.get('FieldJoin') || []), ...(byType.get('FIELD') || [])];
      const callTargetEdges = [...CALL_TARGET_EDGE_TYPES]
        .flatMap((type) => byType.get(type) || []);
      const renderCallTarget = !isSingleNodeNoArgumentCall(current);
      const callEdges = (renderCallTarget ? callTargetEdges : [])
        .filter((edge) => isRenderedCallTargetEdge(edge, nodeByKey));
      const visualCallTargetEdges = (renderCallTarget ? callTargetEdges : [])
        .filter((edge) => isDeveloperVisualCallTargetEdge(edge, nodeByKey));
      const ignorableObjectFieldNext = isObjectFieldNode(current)
        && fieldEdges.length === 1
        && (byType.get('NEXT') || []).length > 0;
      const otherTypes = [...byType.keys()].filter((type) => !['FIELD', 'FieldJoin'].includes(type) && !CALL_TARGET_EDGE_TYPES.has(type) && !(ignorableObjectFieldNext && type === 'NEXT'));
      const closesObject = fieldEdges.length === 1 && (() => {
        const mergeTarget = nodeByKey.get(fieldEdges[0].end);
        return isFanoutMergeNode(mergeTarget)
          || (isObjectBraceNode(mergeTarget) && hasLabel(mergeTarget, 'Close'));
      })();
      if (closesObject && !otherTypes.length) {
        recordObjectSlotCoordinateStep(positions, current, { fieldEdges, argEdges: [], callEdges });
        callEdges.forEach((edge, index) => {
          const skipRequestTarget = edge.type === 'REQUEST'
            && isObjectFieldNode(current)
            && !isArgJoinNode(current);
          if (skipRequestTarget) return;
          const child = nodeByKey.get(edge.end);
          if (!child) throw new Error(`newStraightDrawio missing object-field CALL child node: ${edge.end}`);
          placeCallLikeEdgeTarget(
            edge,
            child,
            currentPos.x + 1,
            currentPos.y + index + 1,
            `newStraightDrawio: nested CALL below object field ${current.key}`,
          );
        });
        visualCallTargetEdges.forEach((edge, index) => {
          const isCompactSnippet = isCompactCallSnippetSource(current, { argEdges: [], fieldEdges });
          const splitCompactSnippet = isCompactSnippet && isSplitCallNode(current);
          if (isCompactSnippet && !splitCompactSnippet) {
            setNodePositionMeta(positions, current.key, {
              props: {
                visualCallStub: true,
                displayWidth: COMPACT_CALL_STUB_WIDTH,
                displayOffsetX: COMPACT_CALL_STUB_DISPLAY_OFFSET_X,
              },
            });
          }
          const proxy = materializeCallVisualTarget(
            edge,
            currentPos.x + (isCompactSnippet ? COMPACT_FN_PROXY_X_OFFSET : 1),
            currentPos.y + (isCompactSnippet ? 0 : callEdges.length + index + 1),
            isCompactSnippet
              ? `newStraightDrawio: compact object field ${edge.type} call target next to ${current.key}`
              : `newStraightDrawio: nested call target below object field ${current.key}`,
            isCompactSnippet
              ? splitCompactSnippet
                ? { ...splitCallRenderProps(nodeByKey.get(edge.end)), renderCompactResponse: true }
                : { compactCallSnippet: true, renderCompactResponse: true }
              : {},
          );
          if (proxy) {
            renderCallEdgeToVisualTarget(edge, proxy, {
              sourcePort: edge.type === 'REQUEST' ? 'right-25' : 'right',
              targetPort: edge.type === 'REQUEST' ? 'left-25' : 'left',
            });
          }
        });

        const fieldEdge = fieldEdges[0];
        const mergeChild = nodeByKey.get(fieldEdge.end);
        if (!mergeChild) throw new Error(`newStraightDrawio missing object-field merge child node: ${fieldEdge.end}`);
        if (
          isTerminalFieldJoinNode(mergeChild, outgoingBySource)
          && !hasLabel(mergeChild, 'Parameter')
          && callMosaicRole(mergeChild) !== 'close'
        ) {
          current = nextPendingCurrent();
          continue;
        }
        const objectOpenerY = fanoutOwnerY(currentPos, isObjectStartNode);
        const preferredY = Number.isFinite(objectOpenerY)
          ? objectOpenerY
          : Number.isFinite(fanoutTopY(currentPos))
            ? fanoutTopY(currentPos)
            : currentPos.y;
        const preferredX = preferredFanoutMergeX(currentPos);
        if (!positions.has(mergeChild.key)) {
          placeNode(
            positions,
            mergeChild,
            firstFreeVertical(positions, preferredX, preferredY),
            preferredY,
            `newStraightDrawio: ${fieldEdge.type} closes object family from ${current.key}; aligned to object opener y=${preferredY}`,
          );
          setFanoutMeta(mergeChild.key, popFanoutContext(currentPos));
        }
        pushRenderEdge(fieldEdge);
        current = mergeChild;
        continue;
      }
    }

    const opensFoldedObjectArgument = outgoing.some((edge) => edge.type === 'FIELD')
      && (
        isSplitCallNode(current)
        || opensObjectFamilyFromMosaic(current)
        || outgoing.some((edge) => isObjectBraceNode(nodeByKey.get(edge.end)))
      );
    if (
      (isCurrentNodeObjectSlot(current) || opensFoldedObjectArgument)
      && !isObjectFieldClosingMerge(current, outgoing, nodeByKey)
    ) {
      const byType = new Map();
      for (const edge of outgoing) byType.set(edge.type, [...(byType.get(edge.type) || []), edge]);
      let fieldEdges = byType.get('FIELD') || [];
      let argEdges = byType.get('ARG') || [];
      if (fieldEdges.length && argEdges.length) {
        const fieldTargets = new Set(fieldEdges.map((edge) => edge.end));
        // The extracted ARG preserves the whole-object role. The hidden FIELD
        // is a renderer-only mosaic seam derived from brace-neighbor metadata.
        // Use that seam once for layout and never draw a duplicate branch.
        argEdges = argEdges.filter((edge) => !(
          fieldTargets.has(edge.end)
          && isObjectBraceNode(nodeByKey.get(edge.end))
          && objectBraceSide(nodeByKey.get(edge.end)) === 'left'
        ));
      }
      const objectBraceFamilyId = isObjectBraceNode(current)
        ? objectBraceFamilyStableId(current)
        : '';
      if (objectBraceFamilyId && objectBraceSide(current) === 'left') {
        const familyOpenings = nodes.filter((node) => (
          isObjectBraceNode(node)
          && objectBraceSide(node) === 'left'
          && objectBraceFamilyStableId(node) === objectBraceFamilyId
        ));
        if (familyOpenings.length > 1) {
          for (const opening of familyOpenings) {
            if (!positions.has(opening.key)) {
              placeNode(
                positions,
                opening,
                currentPos.x,
                currentPos.y,
                `newStraightDrawio: object brace ${opening.key} shares the extracted family axis ${objectBraceFamilyId}`,
              );
              setFanoutMeta(opening.key, inheritFanoutMeta(currentPos));
            }
          }
          fieldEdges = sortSlotEdgesBySourceOrder(
            familyOpenings.flatMap((opening) => (
              (outgoingBySource.get(opening.key) || []).filter((edge) => edge.type === 'FIELD')
            )),
            nodeByKey,
          );
        }
      }
      const dataJoinEdges = (byType.get('XOR_JOIN') || [])
        .filter((edge) => isDataJoinNode(nodeByKey.get(edge.end)));
      const catchEdges = byType.get('CATCH') || [];
      const closesExtractedStateUpdate = hasLabels(current, 'Collection', 'ResultTarget')
        && (
          current.props?.semanticExpansion
          || current.props?.semantic_expansion
        ) === 'state-update';
      const directNextEdges = hasLabel(current, 'Parameter')
        || opensFoldedObjectArgument
        || closesExtractedStateUpdate
        ? (byType.get('NEXT') || [])
        : [];
      const callTargetEdges = [...CALL_TARGET_EDGE_TYPES]
        .flatMap((type) => byType.get(type) || []);
      const renderCallTarget = !isSingleNodeNoArgumentCall(current);
      const callEdges = (renderCallTarget ? callTargetEdges : [])
        .filter((edge) => isRenderedCallTargetEdge(edge, nodeByKey));
      const visualCallTargetEdges = (renderCallTarget ? callTargetEdges : [])
        .filter((edge) => isDeveloperVisualCallTargetEdge(edge, nodeByKey));
      const allowedTypes = new Set(['FIELD', 'FieldJoin', 'ARG', 'ArgJoin', 'PASSES_VALUE', ...CALL_TARGET_EDGE_TYPES]);
      if (catchEdges.length) allowedTypes.add('CATCH');
      if (dataJoinEdges.length) allowedTypes.add('XOR_JOIN');
      if (hasLabel(current, 'Parameter') || opensFoldedObjectArgument || closesExtractedStateUpdate) {
        allowedTypes.add('NEXT');
      }
      const ignorableObjectFieldNext = isObjectFieldNode(current)
        && fieldEdges.length > 0
        && (byType.get('NEXT') || []).length > 0;
      const otherTypes = [...byType.keys()].filter((type) => !allowedTypes.has(type) && !(ignorableObjectFieldNext && type === 'NEXT'));
      if (otherTypes.length || catchEdges.length > 1 || (fieldEdges.length && argEdges.length)) {
        throw new Error(`newStraightDrawio Object slot invariant failed for ${current.key}: ${outgoing.map((edge) => edge.type).join(',')}`);
      }
      recordObjectSlotCoordinateStep(positions, current, { fieldEdges, argEdges, callEdges });

      const directCallClosureEdges = [
        ...(byType.get('ArgJoin') || []),
        ...(byType.get('FieldJoin') || []),
      ]
        .filter((edge) => hasLabel(nodeByKey.get(edge.end), 'FnVisualProxy'))
        .filter((edge, index, edges) => (
          edges.findIndex((candidate) => candidate.end === edge.end) === index
        ));
      if (!fieldEdges.length && !argEdges.length && directCallClosureEdges.length) {
        if (directCallClosureEdges.length > 1) {
          throw new Error(`newStraightDrawio Object slot has multiple direct call closures: ${current.key}`);
        }
        const closureEdge = directCallClosureEdges[0];
        const closure = nodeByKey.get(closureEdge.end);
        const closesSingleObjectArgumentMosaic = callMosaicRole(current) === 'argument-close'
          && callMosaicOwnerStableId(current)
          && callMosaicOwnerStableId(current) === callMosaicOwnerStableId(closure);
        const closureX = closesSingleObjectArgumentMosaic
          ? currentPos.x + (
              compactCallMosaicWidth(current) + compactCallMosaicWidth(closure) + CALL_MOSAIC_GAP * 2
            ) / (2 * DRAWIO_GRID_X)
          : currentPos.x + horizontalStepForNode(current);
        const routedClosure = placeEdgeTarget(
          {
            ...closureEdge,
            props: {
              ...closureEdge.props,
              displayLabel: '',
              sourcePort: closureEdge.props?.sourcePort || 'right',
              targetPort: closureEdge.props?.targetPort || 'left',
              layoutRouteReason: `empty object argument closes horizontally into ${closure.key}`,
            },
          },
          closure,
          closureX,
          currentPos.y,
          `newStraightDrawio: empty object argument ${current.key} closes the call on the same row`,
          { keepRequestedRow: true },
        );
        if (!isHiddenRenderEdge(closureEdge)) renderEdges.push(routedClosure);
        if (closesSingleObjectArgumentMosaic) {
          setNodePositionMeta(positions, current.key, {
            props: {
              ...(positions.get(current.key)?.props || {}),
              compactCallMosaic: true,
              skipHorizontalCompaction: true,
            },
          });
          setNodePositionMeta(positions, closure.key, {
            x: closureX,
            y: currentPos.y,
            props: {
              ...(positions.get(closure.key)?.props || {}),
              compactCallMosaic: true,
              skipHorizontalCompaction: true,
            },
          });
        }
        setFanoutMeta(closure.key, popFanoutContext(currentPos));
        current = closure;
        continue;
      }

      callEdges.forEach((edge) => {
        const child = nodeByKey.get(edge.end);
        if (!child) throw new Error(`newStraightDrawio missing object-slot CALL child node: ${edge.end}`);
        placeCallLikeEdgeTarget(
          edge,
          child,
          currentPos.x + horizontalStepForNode(current),
          currentPos.y,
          `newStraightDrawio: object-slot CALL side target of ${current.key}`,
        );
        const childContinuation = isFnVisualProxyNode(child)
          ? (outgoingBySource.get(child.key) || []).find((candidate) => (
              candidate.type === 'NEXT'
              || (candidate.type === 'RESULT' && isCallResultNode(nodeByKey.get(candidate.end)))
            ))
          : undefined;
        if (childContinuation) {
          const childPos = positions.get(child.key);
          pushContinuation({
            node: child,
            x: childPos.x,
            yStart: childPos.y,
            reason: `newStraightDrawio: graph-backed container call boundary ${child.key} continues after its slot family`,
            canPlaceRejoinTarget: false,
            keepRequestedRow: true,
          });
        }
      });
      visualCallTargetEdges.forEach((edge, index) => {
        const isCompactSnippet = isCompactCallSnippetSource(current, { argEdges, fieldEdges });
        const splitCompactSnippet = isCompactSnippet && isSplitCallNode(current);
        if (isCompactSnippet && !splitCompactSnippet) {
          setNodePositionMeta(positions, current.key, {
            props: {
              visualCallStub: true,
              displayWidth: COMPACT_CALL_STUB_WIDTH,
              displayOffsetX: COMPACT_CALL_STUB_DISPLAY_OFFSET_X,
            },
          });
        }
        const proxy = materializeCallVisualTarget(
          edge,
          currentPos.x + (isCompactSnippet ? COMPACT_FN_PROXY_X_OFFSET : horizontalStepForNode(current)),
          currentPos.y + (isCompactSnippet ? 0 : index),
          isCompactSnippet
            ? `newStraightDrawio: compact object/arg slot ${edge.type} call target next to ${current.key}`
            : `newStraightDrawio: object-slot call target side target of ${current.key}`,
          isCompactSnippet
            ? splitCompactSnippet
              ? {
                  ...splitCallRenderProps(nodeByKey.get(edge.end)),
                  renderCompactResponse: hasLabel(current, 'Arg') || isObjectFieldNode(current),
                }
              : {
                compactCallSnippet: true,
                renderCompactResponse: hasLabel(current, 'Arg') || isObjectFieldNode(current),
              }
            : {},
        );
        if (proxy) {
          renderCallEdgeToVisualTarget(edge, proxy, {
            sourcePort: edge.type === 'REQUEST' ? 'right-25' : 'right',
            targetPort: edge.type === 'REQUEST' ? 'left-25' : 'left',
          });
        }
      });

      const slotEdges = sortSlotEdgesBySourceOrder(
        (fieldEdges.length ? fieldEdges : argEdges.length ? argEdges : dataJoinEdges)
          .map((edge) => visualSlotEdge(edge, nodeByKey, outgoingBySource)),
        nodeByKey,
      );
      const terminalFieldJoin = fieldEdges.length && !argEdges.length
        ? (() => {
            const joins = fieldEdges
              .map((edge) => nodeByKey.get(edge.end))
              .map((field) => (outgoingBySource.get(field?.key) || [])
                .find((edge) => edge.type === 'FieldJoin'))
              .filter(Boolean);
            if (joins.length !== fieldEdges.length) return undefined;
            const joinIds = new Set(joins.map((edge) => edge.end));
            if (joinIds.size !== 1) return undefined;
            const join = nodeByKey.get(joins[0].end);
            return isTerminalFieldJoinNode(join, outgoingBySource) ? join : undefined;
          })()
        : undefined;
      const slotChildren = [];
      const closesInheritedDataBranch = !fieldEdges.length
        && !argEdges.length
        && dataJoinEdges.length > 0
        && fanoutOwnerKeysFrom(currentPos).length > 0;
      const slotFamilyX = closesInheritedDataBranch
        ? preferredFanoutMergeX(currentPos)
        : currentPos.x + horizontalStepForNode(current);
      const slotFamilyAxisY = resolvedArgumentFamilyAxisY(current, currentPos.y, argEdges.length);
      const slotChildrenForLayout = slotEdges.map((edge) => nodeByKey.get(edge.end));
      const slotChildVerticalFootprints = slotChildrenForLayout
        .map((child) => fanoutVerticalFootprint(child, nodeByKey, outgoingBySource));
      const slotHorizontalLayout = centeredFanoutChildXs(slotFamilyX, slotChildrenForLayout);
      const slotChildFootprintWidths = slotHorizontalLayout.widths.map(
        (width, index) => (slotHorizontalLayout.childXs[index] - slotFamilyX) + width,
      );
      const slotFamilyYs = hasLabel(current, 'Parameter') && slotChildrenForLayout.length === 1
        ? [slotFamilyAxisY]
        : fanoutFamilyYs(
          positions,
          slotFamilyX,
          slotFamilyAxisY,
          slotChildrenForLayout,
          nodeByKey,
          outgoingBySource,
          slotChildFootprintWidths,
          { ownerStepStableId: fanoutOwnerStepStableId(current) },
        );
      const slotFamilyMinY = Math.min(
        slotFamilyAxisY,
        ...slotFamilyYs.map((y, index) => y + slotChildVerticalFootprints[index].min),
      );
      const slotFamilyMaxY = Math.max(
        slotFamilyAxisY,
        ...slotFamilyYs.map((y, index) => y + slotChildVerticalFootprints[index].max),
      );
      logCoordinatorStep(positions, current, 'measureObjectSlotFamily', {
        familyMinY: slotFamilyMinY,
        familyMaxY: slotFamilyMaxY,
        children: slotChildrenForLayout.map((child, index) => (
          `${child?.key || '<missing>'}@${slotFamilyYs[index]}[${slotChildVerticalFootprints[index].min},${slotChildVerticalFootprints[index].max}]`
        )),
        reason: 'the object continuation starts after the measured field family',
      });
      if (!terminalFieldJoin || callMosaicRole(terminalFieldJoin) === 'close') {
        noteRequiredFanoutMergeX(current.key, requiredFanoutMergeX(currentPos.x, slotEdges, nodeByKey, outgoingBySource));
      }
      slotEdges.forEach((edge, index) => {
        const child = nodeByKey.get(edge.end);
        if (!child) throw new Error(`newStraightDrawio missing ${edge.type} child node: ${edge.end}`);
        const childY = slotFamilyYs[index] ?? slotFamilyAxisY + index;
        const placedEdge = placeEdgeTarget(
          edge,
          child,
          slotHorizontalLayout.childXs[index] ?? slotFamilyX,
          childY,
          `newStraightDrawio: ${edge.type} ${index + 1} of ${current.key}; vertically centered on parent y=${currentPos.y}; horizontally centered in max branch width=${slotHorizontalLayout.maxWidth}`,
          {
            keepRequestedRow: true,
          },
        );
        renderEdges.push(placedEdge);
        setFanoutMeta(child.key, pushFanoutContext(currentPos, {
          ownerKey: current.key,
          parentY: slotFamilyAxisY,
          familyMinY: slotFamilyMinY,
          familyMaxY: slotFamilyMaxY,
        }));
        slotChildren.push(child);
      });

      catchEdges.forEach((catchEdge) => {
        const catchChild = nodeByKey.get(catchEdge.end);
        if (!catchChild) throw new Error(`newStraightDrawio missing object-slot CATCH child node: ${catchEdge.end}`);
        const catchY = Math.max(currentPos.y + 1, slotFamilyMaxY + FANOUT_SIBLING_GAP);
        const placedCatch = placeEdgeTarget(
          catchEdge,
          catchChild,
          currentPos.x + 1,
          catchY,
          `newStraightDrawio: CATCH branch of object-slot Call ${current.key} starts after its field family`,
          { keepRequestedRow: true },
        );
        if (!isHiddenRenderEdge(catchEdge)) renderEdges.push(placedCatch);
        pushContinuation({
          node: catchChild,
          x: currentPos.x + 1,
          yStart: catchY,
          reason: `newStraightDrawio: exceptional continuation of object-slot Call ${current.key}`,
          canPlaceRejoinTarget: true,
          keepRequestedRow: true,
        });
      });

      callTargetEdges.forEach((edge) => {
        const closure = nodeByKey.get(edge.end);
        if (!isFnVisualProxyNode(closure)) return;
        const closureContinuation = (outgoingBySource.get(closure.key) || []).find((candidate) => (
          candidate.type === 'NEXT'
          || (candidate.type === 'RESULT' && isCallResultNode(nodeByKey.get(candidate.end)))
        ));
        if (!closureContinuation) return;
        if (!positions.has(closure.key)) {
          const mergeX = requiredFanoutMergeX(currentPos.x, slotEdges, nodeByKey, outgoingBySource);
          placeNode(
            positions,
            closure,
            Number.isFinite(mergeX) ? mergeX : currentPos.x + horizontalStepForNode(current),
            slotFamilyAxisY,
            `newStraightDrawio: container call boundary ${closure.key} closes its slot family`,
            'placeContainerCallBoundary',
          );
        }
        const closurePos = positions.get(closure.key);
        pushContinuation({
          node: closure,
          x: closurePos.x,
          yStart: closurePos.y,
          reason: `newStraightDrawio: container call boundary ${closure.key} continues after its slot family`,
          canPlaceRejoinTarget: false,
          keepRequestedRow: true,
        });
      });

      const primaryIndex = primaryFanoutIndex(slotEdges, nodeByKey, outgoingBySource);
      if (directNextEdges.length > 1) {
        throw new Error(`newStraightDrawio Object opener has multiple NEXT continuations: ${current.key}`);
      }
      if (directNextEdges.length === 1) {
        const nextEdge = directNextEdges[0];
        const nextChild = nodeByKey.get(nextEdge.end);
        if (!nextChild) throw new Error(`newStraightDrawio missing Parameter Object NEXT child: ${nextEdge.end}`);
        pushContinuation({
          node: nextChild,
          edge: nextEdge,
          x: closesExtractedStateUpdate
            ? currentPos.x + horizontalStepForNode(current)
            : currentPos.x,
          yStart: currentPos.y,
          reason: closesExtractedStateUpdate
            ? 'newStraightDrawio: extracted state result continues into the enclosing call closure after its effective width'
            : 'newStraightDrawio: Object opener NEXT resumes its control lane beside the field subgraph',
          avoidRightFootprint: !closesExtractedStateUpdate,
          avoidRightFootprintWidth: ownRightFootprintWidth(nextChild, currentPos.x),
          canPlaceRejoinTarget: true,
        });
      }
      for (let index = slotChildren.length - 1; index >= 0; index -= 1) {
        if (index === primaryIndex) continue;
        const child = slotChildren[index];
        const pos = positions.get(child.key);
        pushContinuation({
          node: child,
          x: pos?.x ?? currentPos.x + horizontalStepForNode(current),
          yStart: pos?.y ?? slotFamilyYs[index] ?? slotFamilyAxisY + index,
          reason: `remaining object slot child of ${current.key}`,
          canPlaceRejoinTarget: false,
        });
      }
      currentCanPlaceRejoinTarget = false;
      current = slotChildren[primaryIndex] || nextPendingCurrent();
      continue;
    }

    if (isCurrentNodeRead(current, outgoing)) {
      const byType = new Map();
      for (const edge of outgoing) byType.set(edge.type, [...(byType.get(edge.type) || []), edge]);
      const continuationEdges = [...(byType.get('NEXT') || []), ...(byType.get('VALUE') || []), ...(byType.get('ArgJoin') || []), ...(byType.get('XOR_JOIN') || [])];
      const accessEdges = resourceEdgesFromTypes(byType, nodeByKey);
      const accessorEdges = accessEdges.filter((edge) => {
        const target = nodeByKey.get(edge.end);
        return hasLabel(target, 'Fn') && (hasLabel(target, 'Getter') || hasLabel(target, 'Setter'));
      });
      const readEdges = accessEdges.filter((edge) => !accessorEdges.includes(edge));
      const otherEdges = outgoing.filter((edge) => (
        edge.type !== 'NEXT'
        && edge.type !== 'VALUE'
        && edge.type !== 'ArgJoin'
        && edge.type !== 'XOR_JOIN'
        && edge.type !== 'PASSES_VALUE'
        && !RESOURCE_EDGE_TYPES.has(edge.type)
        && !CALL_TARGET_EDGE_TYPES.has(edge.type)
        && !isStateResourceValueEdge(edge, nodeByKey)
      ));
      if (continuationEdges.length > 1 || otherEdges.length) {
        throw new Error(`newStraightDrawio Read invariant failed for ${current.key}: ${outgoing.map((edge) => edge.type).join(',')}`);
      }
      recordReadCoordinateStep(positions, current, { nextEdges: continuationEdges, readEdges });

      if (accessorEdges.length === 1) {
        const stubLabel = simpleCallStubLabel(current);
        if (!isSplitCallNode(current)) {
          setNodePositionMeta(positions, current.key, {
            props: {
              visualCallStub: true,
              visualCallStubLabel: stubLabel,
              displayWidth: simpleCallStubWidth(stubLabel),
              displayOffsetX: 0,
            },
          });
        }
      }

      accessorEdges.forEach((accessorEdge, index) => {
        const accessorProxy = materializeCallVisualTarget(
          accessorEdge,
          currentPos.x + ACCESSOR_FN_PROXY_X_OFFSET,
          currentPos.y + index,
          `newStraightDrawio: ${accessorEdge.type} accessor proxy of ${current.key}`,
          { compactCallSnippet: true },
        );
        if (!accessorProxy) return;
        renderCallEdgeToVisualTarget(accessorEdge, accessorProxy);
        const expectedType = accessorEdge.type;
        const boundStorageIds = new Set(accessorEdge.props?.storage_stable_ids || []);
        const storageTargets = [...boundStorageIds]
          .map((storageId) => ({
            id: `visual-storage:${accessorEdge.id || edgeCopyKey(accessorEdge)}:${storageId}`,
            type: expectedType,
            start: accessorEdge.end,
            end: storageId,
            props: {
              source: 'graph.display',
              canonicalTargetStableId: storageId,
            },
          }))
          .filter((edge) => {
            const target = nodeByKey.get(edge.end);
            return hasLabel(target, 'Storage') || hasLabel(target, 'Cell');
        });
        storageTargets.forEach((storageEdge, storageIndex) => {
          const visualStorageEdge = { ...storageEdge, start: accessorProxy.key };
          const copyMeta = accessorStorageCopyMetaByUse.get(`${edgeCopyKey(accessorEdge)}:${storageEdge.end}`) || {};
          const storageProxy = materializeResourceVisualTarget(
            visualStorageEdge,
            currentPos.x + ACCESSOR_STORAGE_PROXY_X_OFFSET,
            currentPos.y + index + storageIndex,
            `newStraightDrawio: ${storageEdge.type} storage target of accessor ${accessorEdge.end}`,
            { copyMeta },
          );
          renderResourceEdgeToVisualTarget(visualStorageEdge, storageProxy);
        });
      });

      readEdges.forEach((readEdge, index) => {
        const readChild = nodeByKey.get(readEdge.end);
        if (!readChild) throw new Error(`newStraightDrawio missing READ child node: ${readEdge.end}`);
        const proxy = materializeResourceVisualTarget(
          readEdge,
          currentPos.x + 1,
          currentPos.y + index,
          `newStraightDrawio: ${readEdge.type} resource side target of ${current.key}`,
        );
        renderResourceEdgeToVisualTarget(readEdge, proxy);
      });

      if (continuationEdges.length) {
        const nextEdge = continuationEdges[0];
        const nextChild = nodeByKey.get(nextEdge.end);
        if (!nextChild) throw new Error(`newStraightDrawio missing ${nextEdge.type} child node: ${nextEdge.end}`);
        if (positions.has(nextChild.key)) {
          pushRenderEdge(nextEdge);
          current = nextPendingCurrent();
          continue;
        }
        const fanoutMerge = isFanoutContextMergeNode(nextChild) && Number.isFinite(fanoutTopY(currentPos));
        if (fanoutMerge) {
          const preferredY = fanoutTopY(currentPos);
          const preferredX = preferredFanoutMergeX(currentPos);
          const x = firstFreeVertical(positions, preferredX, preferredY);
          placeNode(
            positions,
            nextChild,
            x,
            preferredY,
            `newStraightDrawio: NEXT closes fanout from Read ${current.key}; aligned to fanout parent y=${preferredY}`,
            'placeReadFanoutMerge',
            [
              makeTraceStep('placeReadFanoutMerge', {
                edgeType: nextEdge.type,
                from: current.key,
                requestedX: preferredX,
                requestedY: preferredY,
                placedX: x,
                placedY: preferredY,
                reason: 'Read continuation targets a Slot/Flow/Fanout join, so it continues horizontally instead of dropping below the Read node',
              }),
            ],
          );
          setFanoutMeta(nextChild.key, popFanoutContext(currentPos));
          pushRenderEdge(nextEdge);
          current = nextChild;
          continue;
        }
        pushContinuation({
          node: nextChild,
          edge: nextEdge,
          x: currentPos.x,
          yStart: currentPos.y + 1,
          reason: `newStraightDrawio: ${nextEdge.type} child of Read ${current.key}`,
          canPlaceRejoinTarget: currentCanPlaceRejoinTarget,
        });
      }
      current = nextPendingCurrent();
      continue;
    }

    if (isCurrentNodeCall(current) && !isCurrentNodeBranch(current)) {
      const byType = new Map();
      for (const edge of outgoing) byType.set(edge.type, [...(byType.get(edge.type) || []), edge]);
      const submethodStableId = String(
        current.props?.submethodStableId
        || current.props?.submethod_stable_id
        || '',
      );
      const nextEdges = (byType.get('NEXT') || []).filter((edge) => {
        if (!submethodStableId) return true;
        const target = nodeByKey.get(edge.end);
        const targetSubmethodStableId = String(
          target?.props?.memberOfSubmethodStableId
          || target?.props?.member_of_submethod_stable_id
          || '',
        );
        return targetSubmethodStableId !== submethodStableId;
      });
      const resultEdges = (byType.get('RESULT') || [])
        .filter((edge) => isCallResultNode(nodeByKey.get(edge.end)));
      const callTargetEdges = [...CALL_TARGET_EDGE_TYPES]
        .flatMap((type) => byType.get(type) || []);
      const renderCallTarget = !isSingleNodeNoArgumentCall(current);
      const callEdges = (resultEdges.length || !renderCallTarget ? [] : callTargetEdges)
        .filter((edge) => isRenderedCallTargetEdge(edge, nodeByKey));
      const rawArgJoinEdges = byType.get('ArgJoin') || [];
      const nestedArgumentFunctionJoinEdges = (byType.get('ARG') || [])
        .flatMap((edge) => outgoingBySource.get(edge.end) || [])
        .filter((edge) => isArgumentFunctionJoinEdge(edge, nodeByKey));
      const argumentFunctionJoinEdges = [...new Map(
        [...rawArgJoinEdges, ...nestedArgumentFunctionJoinEdges]
          .filter((edge) => isArgumentFunctionJoinEdge(edge, nodeByKey))
          .map((edge) => [`${callInvocationType(edge)}\u0000${edge.end}`, edge]),
      ).values()];
      const visualCallTargetEdges = [
        ...(resultEdges.length || !renderCallTarget ? [] : callTargetEdges.filter((edge) => isDeveloperVisualCallTargetEdge(edge, nodeByKey))),
        ...argumentFunctionJoinEdges,
      ];
      const extractedArgumentEvalEdges = (byType.get('EVAL') || []).filter((edge) => {
        const target = nodeByKey.get(edge.end);
        return hasLabel(target, 'SubStep')
          && (
            hasLabel(target, 'Collection')
            || String(target?.props?.executionScopeKind || target?.props?.execution_scope_kind || '') === 'collection-iterator'
          );
      });
      const argEdges = [
        ...(byType.get('ARG') || []),
        ...extractedArgumentEvalEdges,
      ];
      const argJoinEdges = rawArgJoinEdges.filter((edge) => !argumentFunctionJoinEdges.includes(edge));
      const xorJoinEdges = byType.get('XOR_JOIN') || [];
      const valueEdges = byType.get('VALUE') || [];
      const catchEdges = byType.get('CATCH') || [];
      const resourceEdges = resourceEdgesFromTypes(byType, nodeByKey);
      const totalCallTargets = callEdges.length + visualCallTargetEdges.length;
      const continuationEdges = resultEdges.length
        ? resultEdges
        : nextEdges.length
        ? nextEdges
        : valueEdges.length
          ? valueEdges
          : argJoinEdges.length
            ? argJoinEdges
            : xorJoinEdges;
      const otherTypes = outgoing.filter((edge) => (
        !['NEXT', 'VALUE', 'RESULT', 'ARG', 'ArgJoin', 'XOR_JOIN', 'CATCH', 'ON_RECEIVER', 'PASSES_VALUE'].includes(edge.type)
        && !(edge.type === 'EVAL' && extractedArgumentEvalEdges.includes(edge))
        && !CALL_TARGET_EDGE_TYPES.has(edge.type)
        && !RESOURCE_EDGE_TYPES.has(edge.type)
        && !isStateResourceValueEdge(edge, nodeByKey)
        && !(
          edge.type === 'YIELDS_VALUE'
          && String(edge.props?.protocolRole || edge.props?.protocol_role || '') === 'assignment-return'
        )
      ));
      if (nextEdges.length > 1 || valueEdges.length > 1 || argJoinEdges.length > 1 || xorJoinEdges.length > 1 || catchEdges.length > 1 || (nextEdges.length && (valueEdges.length || argJoinEdges.length || xorJoinEdges.length)) || (valueEdges.length && (argJoinEdges.length || xorJoinEdges.length)) || (argJoinEdges.length && xorJoinEdges.length) || totalCallTargets > 1 || otherTypes.length) {
        throw new Error(`newStraightDrawio Call invariant failed for ${current.key}: ${outgoing.map((edge) => edge.type).join(',')}`);
      }
      recordCallCoordinateStep(positions, current, { nextEdges, callEdges: [...callEdges, ...visualCallTargetEdges], argEdges, resourceEdges });
      const visualArgEdges = sortSlotEdgesBySourceOrder(
        argEdges.map((edge) => visualSlotEdge(edge, nodeByKey, outgoingBySource)),
        nodeByKey,
      );
      const mosaicArgumentCandidate = visualArgEdges.length === 1
        ? nodeByKey.get(visualArgEdges[0].end)
        : undefined;
      const mosaicArgumentOutgoing = mosaicArgumentCandidate
        ? outgoingBySource.get(mosaicArgumentCandidate.key) || []
        : [];
      const singleObjectArgumentMosaic = isSingleArgumentCallMosaicOpen(current)
        && visualArgEdges.length === 1
        && hasLabel(mosaicArgumentCandidate, 'Object')
        && mosaicArgumentOutgoing.some((edge) => edge.type === 'FIELD');
      const singleArgumentMosaic = isSingleArgumentCallMosaicOpen(current)
        && visualArgEdges.length === 1
        && mosaicArgumentOutgoing.some((edge) => (
          edge.type === 'ArgJoin'
          && callMosaicRole(nodeByKey.get(edge.end)) === 'close'
          && callMosaicOwnerStableId(nodeByKey.get(edge.end)) === current.key
        ))
          && !mosaicArgumentOutgoing.some((edge) => edge.type === 'ARG' || edge.type === 'FIELD');
      const anySingleArgumentMosaic = singleArgumentMosaic || singleObjectArgumentMosaic;
      const mosaicArgument = singleArgumentMosaic
        || singleObjectArgumentMosaic
        ? mosaicArgumentCandidate
        : undefined;
      const mosaicOpeningWidth = anySingleArgumentMosaic
        ? compactCallMosaicWidth(current)
        : undefined;
      const mosaicArgumentWidth = mosaicArgument
        ? compactCallMosaicWidth(mosaicArgument)
        : undefined;
      const mosaicArgumentX = anySingleArgumentMosaic
        ? currentPos.x + (
            mosaicOpeningWidth + mosaicArgumentWidth + CALL_MOSAIC_GAP * 2
          ) / (2 * DRAWIO_GRID_X)
        : undefined;
      const mosaicCloseX = singleArgumentMosaic
        ? mosaicArgumentX + (
            mosaicArgumentWidth + CALL_MOSAIC_CLOSE_WIDTH + CALL_MOSAIC_GAP * 2
          ) / (2 * DRAWIO_GRID_X)
        : undefined;
      if (anySingleArgumentMosaic) {
        setNodePositionMeta(positions, current.key, {
          props: {
            ...(positions.get(current.key)?.props || {}),
            displayWidth: mosaicOpeningWidth,
            skipHorizontalCompaction: true,
            compactCallMosaic: true,
          },
        });
      }
      const requiredArgumentTargetX = requiredFanoutMergeX(
        currentPos.x,
        visualArgEdges,
        nodeByKey,
        outgoingBySource,
      );
      const callTargetX = singleArgumentMosaic
        ? mosaicCloseX
        : visualArgEdges.length
        ? Math.max(currentPos.x + 2, requiredArgumentTargetX ?? Number.NEGATIVE_INFINITY)
        : currentPos.x + horizontalStepForNode(current);

      callEdges.forEach((edge) => {
        if (singleObjectArgumentMosaic && callMosaicRole(nodeByKey.get(edge.end)) === 'close') return;
        const skipRequestTarget = edge.type === 'REQUEST'
          && !argEdges.length
          && !isCallFinishNode(current);
        if (skipRequestTarget) return;
        const child = nodeByKey.get(edge.end);
        if (!child) throw new Error(`newStraightDrawio missing CALL child node: ${edge.end}`);
        placeCallLikeEdgeTarget(
          edge,
          child,
          callTargetX,
          currentPos.y,
          `newStraightDrawio: CALL side target of ${current.key}`,
        );
        const childContinuation = isFnVisualProxyNode(child)
          ? (outgoingBySource.get(child.key) || []).find((candidate) => (
              candidate.type === 'NEXT'
              || (candidate.type === 'RESULT' && isCallResultNode(nodeByKey.get(candidate.end)))
            ))
          : undefined;
        if (childContinuation) {
          const childPos = positions.get(child.key);
          pushContinuation({
            node: child,
            x: childPos.x,
            yStart: childPos.y,
            reason: `newStraightDrawio: graph-backed call boundary ${child.key} continues after its argument family`,
            canPlaceRejoinTarget: false,
            keepRequestedRow: true,
          });
        }
      });
      visualCallTargetEdges.forEach((edge) => {
        if (singleObjectArgumentMosaic && callMosaicRole(nodeByKey.get(edge.end)) === 'close') return;
        const closesExclusiveArgument = isArgumentFunctionJoinEdge(edge, nodeByKey);
        const isNoArgCallNode = !argEdges.length
          && !isCallFinishNode(current)
          && (hasLabel(current, 'Call') || hasLabel(current, 'Request'));
        const shiftCompactStubInsideSlot = isNoArgCallNode
          && (hasLabel(current, 'Arg') || isObjectFieldNode(current));
        if (isNoArgCallNode && !isSplitCallNode(current)) {
          const stubLabel = simpleCallStubLabel(current);
          setNodePositionMeta(positions, current.key, {
            props: {
              visualCallStub: true,
              visualCallStubLabel: stubLabel,
              displayWidth: simpleCallStubWidth(stubLabel),
              displayOffsetX: shiftCompactStubInsideSlot
                ? COMPACT_CALL_STUB_DISPLAY_OFFSET_X
                : 0,
            },
          });
        }
        if (edge.type === 'REQUEST' && isCallFinishNode(current)) {
          edge.props = {
            ...edge.props,
            sourcePort: edge.props?.sourcePort || 'right-25',
          };
        }
        const splitNoArgCall = isNoArgCallNode && isSplitCallNode(current);
        const proxy = materializeCallVisualTarget(
          edge,
          currentPos.x + (isNoArgCallNode
            ? shiftCompactStubInsideSlot
              ? COMPACT_FN_PROXY_X_OFFSET
              : INLINE_FN_PROXY_X_OFFSET
            : callTargetX - currentPos.x),
          currentPos.y,
          isNoArgCallNode
            ? `newStraightDrawio: compact no-arg ${edge.type} call target next to ${current.key}`
            : `newStraightDrawio: ${edge.type} call target after argument family ${current.key}`,
          splitNoArgCall
            ? {
                ...splitCallRenderProps(nodeByKey.get(edge.end)),
                renderCompactResponse: shiftCompactStubInsideSlot,
              }
            : isNoArgCallNode
            ? {
                compactCallSnippet: true,
                renderCompactResponse: shiftCompactStubInsideSlot,
              }
            : singleArgumentMosaic
              ? {
                  ...splitCallRenderProps(nodeByKey.get(edge.end)),
                  displayWidth: CALL_MOSAIC_CLOSE_WIDTH,
                  skipHorizontalCompaction: true,
                  compactCallMosaic: true,
                }
            : closesExclusiveArgument
              ? { splitCallBoundary: 'end' }
              : {},
        );
        if (proxy && !argEdges.length) {
          renderCallEdgeToVisualTarget(edge, proxy, {
            sourcePort: edge.type === 'REQUEST' ? 'right-25' : 'right',
            targetPort: edge.type === 'REQUEST' ? 'left-25' : 'left',
          });
        }
        const proxyContinuation = proxy
          ? (outgoingBySource.get(proxy.key) || []).find((candidate) => (
              candidate.type === 'NEXT'
              || (candidate.type === 'RESULT' && isCallResultNode(nodeByKey.get(candidate.end)))
            ))
          : undefined;
        if (proxyContinuation) {
          const proxyPos = positions.get(proxy.key);
          pushContinuation({
            node: proxy,
            x: proxyPos.x,
            yStart: proxyPos.y,
            reason: `newStraightDrawio: call boundary ${proxy.key} continues after its argument family`,
            canPlaceRejoinTarget: false,
            keepRequestedRow: true,
          });
        }
      });

      resourceEdges.forEach((edge, index) => {
        const child = nodeByKey.get(edge.end);
        if (!child) throw new Error(`newStraightDrawio missing ${edge.type} resource child node: ${edge.end}`);
        const proxy = materializeResourceVisualTarget(
          edge,
          currentPos.x + horizontalStepForNode(current),
          currentPos.y + callEdges.length + visualCallTargetEdges.length + index,
          `newStraightDrawio: ${edge.type} resource side target of ${current.key}`,
        );
        renderResourceEdgeToVisualTarget(edge, proxy);
      });

      const argChildren = [];
      const argFamilyX = anySingleArgumentMosaic
        ? mosaicArgumentX
        : currentPos.x + horizontalStepForNode(current);
      const argFamilyAxisY = resolvedArgumentFamilyAxisY(current, currentPos.y, visualArgEdges.length);
      const argChildrenForLayout = visualArgEdges.map((edge) => nodeByKey.get(edge.end));
      const includeObjectBraceFamily = visualArgEdges.length > 1;
      const argChildVerticalFootprints = argChildrenForLayout
        .map((child) => fanoutVerticalFootprint(
          child,
          nodeByKey,
          outgoingBySource,
          new Set(),
          { includeObjectBraceFamily },
        ));
      const argHorizontalLayout = centeredFanoutChildXs(argFamilyX, argChildrenForLayout);
      const argChildFootprintWidths = argHorizontalLayout.widths.map(
        (width, index) => (argHorizontalLayout.childXs[index] - argFamilyX) + width,
      );
      const argFamilyYs = visualArgEdges.length === 1
        ? [argFamilyAxisY]
        : fanoutFamilyYs(
          positions,
          argFamilyX,
          argFamilyAxisY,
          argChildrenForLayout,
          nodeByKey,
          outgoingBySource,
          argChildFootprintWidths,
          {
            ownerStepStableId: fanoutOwnerStepStableId(current),
            includeObjectBraceFamily,
          },
        );
      const argFamilyMinY = Math.min(
        argFamilyAxisY,
        ...argFamilyYs.map((y, index) => y + argChildVerticalFootprints[index].min),
      );
      const argFamilyMaxY = Math.max(
        argFamilyAxisY,
        ...argFamilyYs.map((y, index) => y + argChildVerticalFootprints[index].max),
      );
      noteRequiredFanoutMergeX(current.key, requiredFanoutMergeX(currentPos.x, visualArgEdges, nodeByKey, outgoingBySource));
      visualArgEdges.forEach((edge, index) => {
        const child = nodeByKey.get(edge.end);
        if (!child) throw new Error(`newStraightDrawio missing ARG child node: ${edge.end}`);
        const childY = argFamilyYs[index] ?? currentPos.y + index;
        const placedArgumentEdge = placeEdgeTarget(
          edge,
          child,
          argHorizontalLayout.childXs[index] ?? argFamilyX,
          childY,
          `newStraightDrawio: ARG ${index + 1} of ${current.key}; vertically centered on parent y=${currentPos.y}; horizontally centered in max branch width=${argHorizontalLayout.maxWidth}`,
          {
            keepRequestedRow: true,
          },
        );
        if (!isHiddenRenderEdge(edge)) renderEdges.push(placedArgumentEdge);
        setFanoutMeta(child.key, pushFanoutContext(currentPos, {
          ownerKey: current.key,
          parentY: argFamilyAxisY,
          familyMinY: argFamilyMinY,
          familyMaxY: argFamilyMaxY,
        }));
        if (anySingleArgumentMosaic) {
          setNodePositionMeta(positions, child.key, {
            props: {
              ...(positions.get(child.key)?.props || {}),
              displayWidth: mosaicArgumentWidth,
              splitCallBoundary: 'middle',
              callHasArguments: true,
              skipHorizontalCompaction: true,
              compactCallMosaic: true,
            },
          });
        }
        argChildren.push(child);
      });

      catchEdges.forEach((catchEdge) => {
        const catchChild = nodeByKey.get(catchEdge.end);
        if (!catchChild) throw new Error(`newStraightDrawio missing CATCH child node: ${catchEdge.end}`);
        const catchY = Math.max(currentPos.y + 1, argFamilyMaxY + FANOUT_SIBLING_GAP);
        const placedCatch = placeEdgeTarget(
          catchEdge,
          catchChild,
          currentPos.x + 1,
          catchY,
          `newStraightDrawio: CATCH branch of Call ${current.key} starts after its argument family`,
          { keepRequestedRow: true },
        );
        if (!isHiddenRenderEdge(catchEdge)) renderEdges.push(placedCatch);
        pushContinuation({
          node: catchChild,
          x: currentPos.x + 1,
          yStart: catchY,
          reason: `newStraightDrawio: exceptional continuation of Call ${current.key}`,
          canPlaceRejoinTarget: true,
          keepRequestedRow: true,
        });
      });

      if (continuationEdges.length) {
        const nextEdge = continuationEdges[0];
        const nextChild = nodeByKey.get(nextEdge.end);
        if (!nextChild) throw new Error(`newStraightDrawio missing ${nextEdge.type} child node: ${nextEdge.end}`);
        const closesExclusiveOperand = nextEdge.type === 'XOR_JOIN'
          && isOperandJoinNode(nextChild)
          && isExclusiveJoinNode(nextChild);
        if (closesExclusiveOperand) {
          if (!positions.has(nextChild.key)) {
            const preferredY = fanoutTopY(currentPos);
            const preferredX = preferredFanoutMergeX(currentPos);
            placeNode(
              positions,
              nextChild,
              preferredX,
              Number.isFinite(preferredY) ? preferredY : currentPos.y,
              `newStraightDrawio: exclusive Operand join closes alternatives from ${current.key}`,
              'placeExclusiveOperandJoin',
              [makeTraceStep('placeExclusiveOperandJoin', {
                from: current.key,
                edgeType: nextEdge.type,
                placedX: preferredX,
                placedY: Number.isFinite(preferredY) ? preferredY : currentPos.y,
                reason: 'all value alternatives converge at one exclusive Operand join before returning to the variable',
              })],
            );
            setFanoutMeta(nextChild.key, popFanoutContext(currentPos));
          }
          pushRenderEdge({
            ...nextEdge,
            props: {
              ...nextEdge.props,
              sourcePort: nextEdge.props?.sourcePort || 'right',
              targetPort: nextEdge.props?.targetPort || 'left',
              layoutRouteReason: 'exclusive value alternative converges horizontally into Operand join',
            },
          });
        } else if (positions.has(nextChild.key)) {
          pushRenderEdge(nextEdge);
        } else {
          const fanoutWidth = requiredFanoutMergeX(currentPos.x, visualArgEdges, nodeByKey, outgoingBySource);
          const closesArgumentFamily = nextEdge.type === 'ArgJoin';
          const collectionHeadPos = positions.get(
            nextChild.props?.collectionPreviousStageStableId
              || nextChild.props?.collection_previous_stage_stable_id
              || nextChild.props?.collectionHeadStableId,
          );
          const startsCollectionStage = hasLabel(nextChild, 'Collection')
            && Number.isFinite(collectionHeadPos?.x)
            && Number.isFinite(collectionHeadPos?.y);
          const entersCallResult = nextEdge.type === 'RESULT' && isCallResultNode(nextChild);
          const continuationY = entersCallResult
            ? currentPos.y
            : startsCollectionStage
            ? collectionHeadPos.y + 0.5
            : nextEdge.type === 'VALUE' || closesArgumentFamily
            ? currentPos.y
            : visualArgEdges.length
              ? Math.max(
                  currentPos.y + 1,
                  argFamilyMaxY
                    + FANOUT_SIBLING_GAP
                    - fanoutVerticalFootprint(nextChild, nodeByKey, outgoingBySource).min,
                )
              : currentPos.y + 1;
          pushContinuation({
            node: nextChild,
            edge: nextEdge,
            x: startsCollectionStage
              ? collectionHeadPos.x
              : entersCallResult
                ? currentPos.x + horizontalStepForNode(current)
              : nextEdge.type === 'VALUE'
                ? currentPos.x + 1
                : currentPos.x,
            yStart: continuationY,
            avoidRightFootprint: !entersCallResult && !startsCollectionStage && nextEdge.type !== 'VALUE' && !closesArgumentFamily && visualArgEdges.length > 0,
            keepRequestedRow: entersCallResult,
            avoidRightFootprintWidth: Number.isFinite(fanoutWidth) ? Math.max(1, fanoutWidth - currentPos.x) : 3,
            reason: startsCollectionStage
              ? `newStraightDrawio: collection stage ${nextChild.key} wraps below receiver call head ${nextChild.props.collectionHeadStableId}`
              : `newStraightDrawio: ${nextEdge.type} child of Call ${current.key}; delayed until side slots finish`,
            canPlaceRejoinTarget: true,
            fanoutMeta: inheritFanoutMeta(currentPos),
            keepRequestedRow: startsCollectionStage || closesArgumentFamily,
          });
        }
      }

      const primaryIndex = primaryFanoutIndex(visualArgEdges, nodeByKey, outgoingBySource);
      for (let index = argChildren.length - 1; index >= 0; index -= 1) {
        if (index === primaryIndex) continue;
        const child = argChildren[index];
        const pos = positions.get(child.key);
        pushContinuation({
          node: child,
          x: pos?.x ?? currentPos.x + horizontalStepForNode(current),
          yStart: pos?.y ?? argFamilyYs[index] ?? currentPos.y + index,
          reason: `remaining ARG side slot of ${current.key}`,
          canPlaceRejoinTarget: false,
        });
      }
      currentCanPlaceRejoinTarget = false;
      current = argChildren[primaryIndex] || nextPendingCurrent();
      continue;
    }

    if (isSlotBranchNode(current)) {
      const trueEdges = outgoing.filter((edge) => edge.type === 'TRUE');
      const falseEdges = outgoing.filter((edge) => edge.type === 'FALSE');
      const otherTypes = outgoing.filter((edge) => edge.type !== 'TRUE' && edge.type !== 'FALSE');
      if (trueEdges.length !== 1 || falseEdges.length !== 1 || otherTypes.length) {
        throw new Error(`newStraightDrawio slot Branch invariant failed for ${current.key}: ${outgoing.map((edge) => edge.type).join(',')}`);
      }

      const directDataJoin = trueEdges[0].end === falseEdges[0].end
        ? nodeByKey.get(trueEdges[0].end)
        : undefined;
      if (directDataJoin && isDataJoinNode(directDataJoin)) {
        const trueEdge = trueEdges[0];
        const falseEdge = falseEdges[0];
        recordBranchCoordinateStep(positions, current, {
          trueEdge,
          falseEdge,
          rightLane: trueEdge,
          downLane: falseEdge,
          rightFootprintRows: 0,
          downYStart: currentPos.y,
          reason: 'Slot Branch alternatives are render parts of one node and converge directly',
        });
        if (!positions.has(directDataJoin.key)) {
          placeNode(
            positions,
            directDataJoin,
            currentPos.x + 1,
            currentPos.y,
            `newStraightDrawio: direct DataJoin of mosaic alternatives from ${current.key}`,
            'placeDirectSlotDataJoin',
            [makeTraceStep('placeDirectSlotDataJoin', {
              from: current.key,
              requestedX: currentPos.x + 1,
              requestedY: currentPos.y,
              placedX: currentPos.x + 1,
              placedY: currentPos.y,
              reason: 'TRUE and FALSE originate in one predicate mosaic and share one DataJoin',
            })],
          );
        }
        pushRenderEdge(trueEdge);
        pushRenderEdge(falseEdge);
        currentCanPlaceRejoinTarget = false;
        current = directDataJoin;
        continue;
      }

      const trueEdge = effectiveTargetForEdge(trueEdges[0], nodeByKey, outgoingBySource).edge;
      const falseEdge = effectiveTargetForEdge(falseEdges[0], nodeByKey, outgoingBySource).edge;
      const trueChild = nodeByKey.get(trueEdge.end);
      const falseChild = nodeByKey.get(falseEdge.end);
      if (!trueChild) throw new Error(`newStraightDrawio missing slot Branch TRUE child node: ${trueEdge.end}`);
      if (!falseChild) throw new Error(`newStraightDrawio missing slot Branch FALSE child node: ${falseEdge.end}`);
      const horizontalBranchFanoutEdges = [trueEdge, falseEdge];
      const requiredHorizontalBranchJoinX = requiredFanoutMergeX(currentPos.x, horizontalBranchFanoutEdges, nodeByKey, outgoingBySource);
      noteRequiredFanoutMergeX(current.key, requiredHorizontalBranchJoinX);
      fanoutOwnerKeysFrom(currentPos).forEach((ownerKey) => {
        noteRequiredFanoutMergeX(ownerKey, requiredHorizontalBranchJoinX);
      });

      recordBranchCoordinateStep(positions, current, {
        trueEdge,
        falseEdge,
        rightLane: trueEdge,
        downLane: falseEdge,
        rightFootprintRows: 0,
        downYStart: currentPos.y + SLOT_BRANCH_VERTEX_Y_OFFSET,
        reason: `Slot Branch fanout: TRUE upper-right, FALSE lower-right; requiredJoinX=${requiredHorizontalBranchJoinX ?? '<none>'}`,
      });

      const upperLaneY = currentPos.y - SLOT_BRANCH_VERTEX_Y_OFFSET;
      const lowerLaneY = currentPos.y + SLOT_BRANCH_VERTEX_Y_OFFSET;
      const slotFanoutMeta = pushFanoutContext(currentPos, {
        ownerKey: current.key,
        parentY: currentPos.y,
        familyMinY: upperLaneY,
        familyMaxY: lowerLaneY,
      });
      placeSlotBranchTarget(
        trueEdge,
        trueChild,
        currentPos.x + 1,
        upperLaneY,
        'hex-right-top',
        `newStraightDrawio: slot Branch TRUE upper lane from ${current.key}`,
        slotFanoutMeta,
      );
      placeSlotBranchTarget(
        falseEdge,
        falseChild,
        currentPos.x + 1,
        lowerLaneY,
        'bottom',
        `newStraightDrawio: slot Branch FALSE lower lane from ${current.key}`,
        slotFanoutMeta,
      );

      pushContinuation({
        node: falseChild,
        x: currentPos.x + 1,
        yStart: lowerLaneY,
        reason: `newStraightDrawio: pending slot Branch FALSE lane of ${current.key}`,
        canPlaceRejoinTarget: false,
      });
      currentCanPlaceRejoinTarget = false;
      current = trueChild;
      continue;
    }

    if (isCurrentNodeLoop(current)) {
      const nextEdges = outgoing.filter((edge) => edge.type === 'NEXT');
      const iteratorEdges = outgoing.filter((edge) => edge.type === 'ITERATOR');
      const otherTypes = outgoing.filter((edge) => !['NEXT', 'ITERATOR'].includes(edge.type));
      const extractedForOfEntry = nextEdges.find((edge) => {
        const target = nodeByKey.get(edge.end);
        return hasLabel(target, 'Iterator')
          && String(target?.props?.collectionMethod || target?.props?.collection_method || '') === 'for-of';
      });
      const bodyEdges = extractedForOfEntry ? [extractedForOfEntry] : nextEdges;
      const loopContinuationEdges = extractedForOfEntry
        ? nextEdges.filter((edge) => edge !== extractedForOfEntry)
        : [];
      if (bodyEdges.length !== 1 || loopContinuationEdges.length > 1 || iteratorEdges.length > 1 || otherTypes.length) {
        throw new Error(`newStraightDrawio Loop invariant failed for ${current.key}: ${outgoing.map((edge) => edge.type).join(',')}`);
      }

      const bodyEdge = bodyEdges[0];
      const bodyChild = nodeByKey.get(bodyEdge.end);
      if (!bodyChild) throw new Error(`newStraightDrawio missing Loop NEXT body node: ${bodyEdge.end}`);

      if (extractedForOfEntry) {
        const loopStepStableId = fanoutOwnerStepStableId(current) || fanoutOwnerStepStableId(bodyChild);
        for (const candidate of loopStepStableId ? nodes : []) {
          if (
            candidate.key === current.key
            || fanoutOwnerStepStableId(candidate) !== loopStepStableId
          ) continue;
          const candidatePosition = positions.get(candidate.key);
          if (!candidatePosition) continue;
          positions.set(candidate.key, {
            ...candidatePosition,
            x: candidatePosition.x + 1,
            trace: [
              ...(candidatePosition.trace || []),
              makeTraceStep('offsetForOfIterationColumn', {
                loop: current.key,
                previousX: candidatePosition.x,
                placedX: candidatePosition.x + 1,
                reason: 'the iterator and the remainder of a for-of Step start in the next column after the for keyword',
              }),
            ],
          });
        }
      }

      logCoordinatorStep(positions, current, 'coordinateLoop', {
        bodyTarget: bodyEdge.end,
        continuationTarget: loopContinuationEdges[0]?.end,
        reason: extractedForOfEntry
          ? 'the NEXT to the extracted Iterator enters the loop; the other NEXT remains the ordinary continuation after the loop'
          : 'for/iterator/collection form the horizontal header; one ordinary NEXT enters the body below',
      });

      const loopContinuationEdge = loopContinuationEdges[0];
      if (loopContinuationEdge) {
        const continuation = nodeByKey.get(loopContinuationEdge.end);
        if (!continuation) throw new Error(`newStraightDrawio missing Loop continuation node: ${loopContinuationEdge.end}`);
        pushContinuation({
          node: continuation,
          edge: loopContinuationEdge,
          x: currentPos.x,
          yStart: currentPos.y + 1,
          reason: `newStraightDrawio: ordinary NEXT continuation after extracted for-of ${current.key}`,
          stopStack: currentStopStack,
          canPlaceRejoinTarget: true,
        });
      }

      const iteratorEdge = iteratorEdges[0];
      if (iteratorEdge) {
        const iteratorNode = nodeByKey.get(iteratorEdge.end);
        const ofEdge = (outgoingBySource.get(iteratorEdge.end) || []).find((edge) => edge.type === 'OF');
        const collectionNode = ofEdge && nodeByKey.get(ofEdge.end);
        if (!iteratorNode || !ofEdge || !collectionNode) {
          throw new Error(`newStraightDrawio incomplete for-of header at ${current.key}`);
        }
        renderEdges.push(placeEdgeTarget(
          {
            ...iteratorEdge,
            props: {
              ...iteratorEdge.props,
              displayLabel: '',
              sourcePort: 'right',
              targetPort: 'left',
            },
          },
          iteratorNode,
          currentPos.x + 1,
          currentPos.y,
          `newStraightDrawio: for-of iterator to the right of ${current.key}`,
        ));
        renderEdges.push(placeEdgeTarget(
          {
            ...ofEdge,
            props: {
              ...ofEdge.props,
              displayLabel: 'of',
              sourcePort: 'right',
              targetPort: 'left',
            },
          },
          collectionNode,
          currentPos.x + 2,
          currentPos.y,
          `newStraightDrawio: for-of collection to the right of ${iteratorNode.key}`,
        ));
      }

      const routedBodyEdge = {
        ...bodyEdge,
        props: {
          ...bodyEdge.props,
          displayLabel: '',
          sourcePort: bodyEdge.props?.sourcePort || 'bottom',
          targetPort: bodyEdge.props?.targetPort || 'top',
        },
      };
      renderEdges.push(placeEdgeTarget(
        routedBodyEdge,
        bodyChild,
        extractedForOfEntry ? currentPos.x + 1 : currentPos.x,
        extractedForOfEntry ? currentPos.y : currentPos.y + 1,
        extractedForOfEntry
          ? `newStraightDrawio: extracted for-of iterator starts in the column after ${current.key}`
          : `newStraightDrawio: Loop NEXT body below ${current.key}`,
        { avoidRightFootprintWidth: Math.max(1, ownRightFootprintWidth(bodyChild, currentPos.x)) },
      ));
      currentCanPlaceRejoinTarget = false;
      current = bodyChild;
      continue;
    }

    if (isCurrentNodeBranch(current)) {
      const predicateMosaicMembers = isPredicateCallMosaicOpen(current)
        ? nodes.filter((candidate) => callMosaicOwnerStableId(candidate) === current.key)
        : [];
      const predicateMosaicArgument = predicateMosaicMembers.find((candidate) => callMosaicRole(candidate) === 'argument');
      const predicateMosaicClose = predicateMosaicMembers.find((candidate) => callMosaicRole(candidate) === 'close');
      if (predicateMosaicArgument && predicateMosaicClose) {
        const openToArgumentOffset = (PREDICATE_MOSAIC_OPEN_WIDTH + PREDICATE_MOSAIC_ARGUMENT_WIDTH + PREDICATE_MOSAIC_GAP * 2) / (2 * DRAWIO_GRID_X);
        const argumentToCloseOffset = (PREDICATE_MOSAIC_ARGUMENT_WIDTH + PREDICATE_MOSAIC_CLOSE_WIDTH + PREDICATE_MOSAIC_GAP * 2) / (2 * DRAWIO_GRID_X);
        setNodePositionMeta(positions, current.key, {
          props: {
            ...(positions.get(current.key)?.props || {}),
            displayWidth: PREDICATE_MOSAIC_OPEN_WIDTH,
          },
        });
        placeNode(
          positions,
          predicateMosaicArgument,
          currentPos.x + openToArgumentOffset,
          currentPos.y,
          `newStraightDrawio: sole predicate argument forms the middle tile of ${current.key}`,
          'placePredicateCallMosaicArgument',
        );
        setNodePositionMeta(positions, predicateMosaicArgument.key, {
          props: {
            ...(positions.get(predicateMosaicArgument.key)?.props || {}),
            displayWidth: PREDICATE_MOSAIC_ARGUMENT_WIDTH,
          },
        });
        placeNode(
          positions,
          predicateMosaicClose,
          currentPos.x + openToArgumentOffset + argumentToCloseOffset,
          currentPos.y,
          `newStraightDrawio: predicate call closure forms the right tile of ${current.key}`,
          'placePredicateCallMosaicClose',
        );
        setNodePositionMeta(positions, predicateMosaicClose.key, {
          props: {
            ...(positions.get(predicateMosaicClose.key)?.props || {}),
            displayWidth: PREDICATE_MOSAIC_CLOSE_WIDTH,
          },
        });
        logCoordinatorStep(positions, current, 'coordinatePredicateCallMosaic', {
          argument: predicateMosaicArgument.key,
          closing: predicateMosaicClose.key,
          reason: 'opening, sole argument, and closing call boundaries share one row without rendered internal edges',
        });
      }
      const distributedFlowOutgoing = predicateMosaicClose
        ? [...outgoing, ...originalOutgoing(edges, predicateMosaicClose.key)]
        : outgoing;
      const valueOutcomeEdges = distributedFlowOutgoing
        .filter((edge) => (edge.type === 'TRUE' || edge.type === 'FALSE') && isValueOutcomeNode(nodeByKey.get(edge.end)));
      valueOutcomeEdges.forEach((edge) => {
        const outcome = nodeByKey.get(edge.end);
        if (!outcome) return;
        const outcomeX = currentPos.x;
        const outcomeY = currentPos.y + OUTCOME_DIRECT_ENTRY_Y_OFFSET
          + (hasLabel(outcome, 'FalsyOutcome') ? FLOW_OUTCOME_Y_STEP : 0);
        if (!positions.has(outcome.key)) {
          placeNode(
            positions,
            outcome,
            outcomeX,
            outcomeY,
            `newStraightDrawio: Flow Branch ${edge.type} value outcome under ${current.key}`,
            'placeFlowBranchValueOutcome',
          );
          pushContinuation({
            node: outcome,
            x: outcomeX,
            yStart: outcomeY,
            reason: `newStraightDrawio: pending ${edge.type} value outcome of ${current.key}`,
            canPlaceRejoinTarget: false,
            keepRequestedRow: true,
          });
        }
        deferValueOutcomeEdge({
          ...edge,
          props: {
            ...edge.props,
            sourcePort: hasLabel(outcome, 'TruthyOutcome') ? 'bottom' : 'bottom',
            targetPort: 'top',
          },
        });
      });
      const trueEdges = distributedFlowOutgoing.filter((edge) => edge.type === 'TRUE' && !isValueOutcomeNode(nodeByKey.get(edge.end)));
      const falseEdges = distributedFlowOutgoing.filter((edge) => edge.type === 'FALSE' && !isValueOutcomeNode(nodeByKey.get(edge.end)));
      const exclusiveJoinEdges = distributedFlowOutgoing.filter((edge) => edge.type === 'XOR_JOIN');
      if (exclusiveJoinEdges.length === 1 && trueEdges.length === 1 && falseEdges.length === 0) {
        falseEdges.push({
          ...exclusiveJoinEdges[0],
          props: {
            ...exclusiveJoinEdges[0].props,
            displayLabel: 'FALSE',
            layoutRouteReason: 'exclusive predicate alternative is the false control outcome',
          },
        });
      } else if (exclusiveJoinEdges.length === 1 && falseEdges.length === 1 && trueEdges.length === 0) {
        trueEdges.push({
          ...exclusiveJoinEdges[0],
          props: {
            ...exclusiveJoinEdges[0].props,
            displayLabel: 'TRUE',
            layoutRouteReason: 'exclusive predicate alternative is the true control outcome',
          },
        });
      }
      // Predicate dependencies remain in Neo4j but are intentionally absent from the
      // current Flow view. The sequence/dependency views can consume them directly.
      const storageAccessEdges = [];
      const otherTypes = outgoing.filter((edge) => (
        edge.props?.render_hidden !== true
        && edge.props?.renderHidden !== true
        &&
        edge.type !== 'TRUE'
        && edge.type !== 'FALSE'
        && edge.type !== 'VALUE'
        && !CALL_TARGET_EDGE_TYPES.has(edge.type)
        && !CONDITION_SEMANTIC_EDGE_TYPES.has(edge.type)
        && !(predicateMosaicClose && (edge.props?.render_hidden === true || edge.props?.renderHidden === true))
      ));
      storageAccessEdges.forEach((accessorEdge, index) => {
        const accessor = nodeByKey.get(accessorEdge.end);
        if (hasLabel(accessor, 'Fn') && (hasLabel(accessor, 'Getter') || hasLabel(accessor, 'Setter'))) {
          const accessorProxy = materializeCallVisualTarget(
            accessorEdge,
            currentPos.x + COMPACT_FN_PROXY_X_OFFSET,
            currentPos.y + index,
            `newStraightDrawio: ${accessorEdge.type} accessor proxy of Branch ${current.key}`,
            { compactCallSnippet: true },
          );
          if (!accessorProxy) return;
          renderCallEdgeToVisualTarget(accessorEdge, accessorProxy);
          const boundStorageIds = new Set(accessorEdge.props?.storage_stable_ids || []);
          for (const storageEdge of outgoingBySource.get(accessorEdge.end) || []) {
            const storage = nodeByKey.get(storageEdge.end);
            if (storageEdge.type !== accessorEdge.type
              || !boundStorageIds.has(storageEdge.end)
              || (!hasLabel(storage, 'Storage') && !hasLabel(storage, 'Cell'))) continue;
            const visualStorageEdge = { ...storageEdge, start: accessorProxy.key };
            const storageProxy = materializeResourceVisualTarget(
              visualStorageEdge,
              currentPos.x + 1,
              currentPos.y + index,
              `newStraightDrawio: ${storageEdge.type} storage target of Branch accessor ${accessorEdge.end}`,
            );
            renderResourceEdgeToVisualTarget(visualStorageEdge, storageProxy);
          }
          return;
        }
        const storageProxy = materializeResourceVisualTarget(
          accessorEdge,
          currentPos.x + 1,
          currentPos.y + index,
          `newStraightDrawio: ${accessorEdge.type} storage target of Branch ${current.key}`,
        );
        renderResourceEdgeToVisualTarget(accessorEdge, storageProxy);
      });
      if (!trueEdges.length && !falseEdges.length && valueOutcomeEdges.length && !otherTypes.length) {
        current = nextPendingCurrent();
        continue;
      }
      const hasMissingBranchClosedByOutcome = valueOutcomeEdges.length > 0 && (trueEdges.length + falseEdges.length) >= 1;
      if (trueEdges.length > 1 || falseEdges.length > 1 || otherTypes.length || (trueEdges.length + falseEdges.length !== 2 && !hasMissingBranchClosedByOutcome)) {
        throw new Error(`newStraightDrawio Branch invariant failed for ${current.key}: ${outgoing.map((edge) => edge.type).join(',')}`);
      }

      if (hasMissingBranchClosedByOutcome && trueEdges.length + falseEdges.length === 1) {
        const flowEdge = [...trueEdges, ...falseEdges][0];
        const child = nodeByKey.get(flowEdge.end);
        if (!child) throw new Error(`newStraightDrawio missing Flow Branch continuation target: ${flowEdge.end}`);
        renderEdges.push(placeEdgeTarget(
          {
            ...flowEdge,
            props: {
              ...flowEdge.props,
              sourcePort: flowBranchPortToward(currentPos.x, currentPos.x + 1),
              targetPort: isOperandBranchNode(child) ? 'left' : 'top',
              layoutRouteReason: 'Flow Branch continues through its non-outcome predicate lane while value outcomes feed invariant joins',
            },
          },
          child,
          currentPos.x + 1,
          currentPos.y,
          `newStraightDrawio: Flow Branch continues to predicate carrier from ${current.key}`,
          { keepRequestedRow: true },
        ));
        pushContinuation({
          node: child,
          x: currentPos.x + 1,
          yStart: currentPos.y,
          reason: `newStraightDrawio: continue through non-outcome lane of ${current.key}`,
          canPlaceRejoinTarget: true,
          keepRequestedRow: true,
        });
        currentCanPlaceRejoinTarget = false;
        current = nextPendingCurrent();
        continue;
      }

      if (isDataBranchNode(current) && isOperandBranchNode(current)) {
        const operandEdges = [...trueEdges, ...falseEdges];
        const split = splitOperandBranchEdges(operandEdges, nodeByKey, outgoingBySource);
        const isFlowConditionOperand = typeof currentPos.operandFlowDownTarget === 'string';
        const continuation = split.continuation
          || (!isFlowConditionOperand && split.terminalEdges.length === 1 ? split.terminalEdges[0] : null);
        const joinEdges = split.joinEdges;
        const terminalEdges = isFlowConditionOperand
          ? split.terminalEdges
          : split.terminalEdges.filter((edge) => {
              const target = nodeByKey.get(edge.end);
              return hasLabel(target, 'ContainerMethod') && hasLabel(target, 'Set');
            });
        const standaloneAlternativeEdges = !isFlowConditionOperand && !continuation && !joinEdges.length
          ? split.terminalEdges
          : [];
        if (standaloneAlternativeEdges.length === 2) {
          const trueAlternativeEdge = standaloneAlternativeEdges.find((edge) => edge.type === 'TRUE');
          const falseAlternativeEdge = standaloneAlternativeEdges.find((edge) => edge.type === 'FALSE');
          if (!trueAlternativeEdge || !falseAlternativeEdge) {
            throw new Error(`newStraightDrawio Operand alternatives require TRUE/FALSE from ${current.key}`);
          }
          const trueAlternative = nodeByKey.get(trueAlternativeEdge.end);
          const falseAlternative = nodeByKey.get(falseAlternativeEdge.end);
          if (!trueAlternative || !falseAlternative) {
            throw new Error(`newStraightDrawio missing Operand alternative child from ${current.key}`);
          }
          const trueRequestsDown = trueAlternative.props?.conditionalAlternativePlacement === 'down'
            || trueAlternative.props?.conditional_alternative_placement === 'down';
          const falseRequestsDown = falseAlternative.props?.conditionalAlternativePlacement === 'down'
            || falseAlternative.props?.conditional_alternative_placement === 'down';
          const trueGoesDown = trueRequestsDown && !falseRequestsDown;
          const falseGoesDown = falseRequestsDown;
          const rightLaneY = currentPos.y;
          const lowerLaneY = currentPos.y + 1;
          const trueX = trueGoesDown ? currentPos.x : currentPos.x + 1;
          const trueY = trueGoesDown ? lowerLaneY : rightLaneY;
          const falseX = falseGoesDown ? currentPos.x : currentPos.x + 1;
          const falseY = falseGoesDown ? lowerLaneY : rightLaneY;
          const alternativeFanoutMeta = pushFanoutContext(currentPos, {
            ownerKey: current.key,
            parentY: currentPos.y,
            familyMinY: rightLaneY,
            familyMaxY: lowerLaneY,
          });
          renderEdges.push(placeEdgeTarget(
            {
              ...trueAlternativeEdge,
              props: {
                ...trueAlternativeEdge.props,
                displayLabel: trueAlternativeEdge.props?.displayLabel || trueAlternativeEdge.props?.display_label || 'TRUE',
                sourcePort: trueGoesDown ? 'bottom' : 'right',
                sourcePortCandidates: [trueGoesDown ? 'bottom' : 'right'],
                targetPort: trueGoesDown ? 'top' : 'left',
                targetPortCandidates: [trueGoesDown ? 'top' : 'left'],
                lockPortCandidates: true,
              },
            },
            trueAlternative,
            trueX,
            trueY,
            `newStraightDrawio: standalone Operand TRUE alternative continues ${trueGoesDown ? 'down on the control axis' : 'right'} from ${current.key}`,
            { fanoutMeta: alternativeFanoutMeta, keepRequestedRow: true },
          ));
          renderEdges.push(placeEdgeTarget(
            {
              ...falseAlternativeEdge,
              props: {
                ...falseAlternativeEdge.props,
                displayLabel: falseAlternativeEdge.props?.displayLabel || falseAlternativeEdge.props?.display_label || 'FALSE',
                sourcePort: falseGoesDown ? 'bottom' : 'right',
                sourcePortCandidates: [falseGoesDown ? 'bottom' : 'right'],
                targetPort: falseGoesDown ? 'top' : 'left',
                targetPortCandidates: [falseGoesDown ? 'top' : 'left'],
                lockPortCandidates: true,
              },
            },
            falseAlternative,
            falseX,
            falseY,
            `newStraightDrawio: standalone Operand FALSE alternative continues ${falseGoesDown ? 'down on the control axis' : 'right'} from ${current.key}`,
            { fanoutMeta: alternativeFanoutMeta, keepRequestedRow: true },
          ));
          pushContinuation({
            node: falseAlternative,
            x: falseX,
            yStart: falseY,
            reason: `newStraightDrawio: pending downward Operand alternative of ${current.key}`,
            canPlaceRejoinTarget: false,
          });
          logCoordinatorStep(positions, current, 'coordinateOperandAlternatives', {
            trueTarget: trueAlternative.key,
            falseTarget: falseAlternative.key,
            joinTarget: '<none>',
            reason: 'Data Branch alternatives use separate rows in the next subColumn',
          });
          currentCanPlaceRejoinTarget = false;
          current = trueAlternative;
          continue;
        }
        if (continuation) {
          const continuationChild = nodeByKey.get(continuation.end);
          if (!continuationChild) throw new Error(`newStraightDrawio missing Operand continuation child node: ${continuation.end}`);
          const routedContinuation = {
            ...continuation,
            props: {
              ...continuation.props,
              sourcePort: continuation.props?.sourcePort || 'right',
              targetPort: continuation.props?.targetPort || 'left',
              layoutRouteReason: `operand chain continuation exits right-center from ${current.key}`,
            },
          };
          renderEdges.push(placeEdgeTarget(
            routedContinuation,
            continuationChild,
            currentPos.x + 1,
            currentPos.y,
            `newStraightDrawio: Operand Branch horizontal continuation from ${current.key}`,
            { keepRequestedRow: true },
          ));
          setFanoutMeta(continuationChild.key, inheritFanoutMeta(currentPos));
        }

        let rightJoinChild = null;
        joinEdges.forEach((joinEdge, index) => {
          const joinChild = nodeByKey.get(joinEdge.end);
          if (!joinChild) throw new Error(`newStraightDrawio missing OperandJoin child node: ${joinEdge.end}`);
          rightJoinChild ||= joinChild;
          const sourcePort = continuation || index > 0 ? 'bottom' : 'right';
          const desiredJoinX = currentPos.x + operandChainLengthFrom(current.key, nodeByKey, outgoingBySource);
          const existingJoinPos = positions.get(joinChild.key);
          if (!existingJoinPos || !Number.isFinite(existingJoinPos.x) || existingJoinPos.x < desiredJoinX) {
            placeNode(
              positions,
              joinChild,
              desiredJoinX,
              currentPos.y,
              `newStraightDrawio: OperandJoin moved to the right edge of operand snippet from ${current.key}`,
              'placeOperandJoin',
              [
                ...(existingJoinPos?.trace || []),
                makeTraceStep('placeOperandJoin', {
                  from: current.key,
                  edgeType: joinEdge.type,
                  previousX: existingJoinPos?.x,
                  previousY: existingJoinPos?.y,
                  placedX: desiredJoinX,
                  placedY: currentPos.y,
                  sourcePort,
                  targetPort: 'left',
                  reason: 'OperandJoin stays at the far right edge of the horizontal operand snippet',
                }),
              ],
            );
          }
          const routedJoinEdge = {
            ...joinEdge,
            props: {
              ...joinEdge.props,
              sourcePort: joinEdge.props?.sourcePort || sourcePort,
              targetPort: joinEdge.props?.targetPort || 'left',
              layoutRouteReason: sourcePort === 'bottom'
                ? `operand alternative exits bottom-center from ${current.key} and turns into OperandJoin`
                : `final operand continuation exits right-center from ${current.key} into OperandJoin`,
            },
          };
          pushRenderEdge(routedJoinEdge);
        });

        let sideExecutionChild = null;
        for (const terminalEdge of terminalEdges) {
          const terminalChild = nodeByKey.get(terminalEdge.end);
          if (!terminalChild) throw new Error(`newStraightDrawio missing Operand terminal child node: ${terminalEdge.end}`);
          const returnsToDownLane = terminalEdge.end === currentPos.operandFlowDownTarget;
          const terminalTargetAlreadyCoordinated = positions.has(terminalChild.key)
            || pendingByKey.has(terminalChild.key);
          const callbackOutcomePlacement = callbackOutcomePlacementByKey.get(terminalChild.key);
          const callbackOutcomeSourcePort = callbackOutcomePlacement
            ? (hasLabel(terminalChild, 'TruthyOutcome') ? 'top' : 'bottom')
            : undefined;
          const routedTerminalEdge = {
            ...terminalEdge,
            props: {
              ...terminalEdge.props,
              sourcePort: callbackOutcomeSourcePort
                || terminalEdge.props?.sourcePort
                || (returnsToDownLane ? 'bottom' : terminalTargetAlreadyCoordinated ? undefined : 'right'),
              targetPort: callbackOutcomePlacement
                ? 'left'
                : terminalEdge.props?.targetPort
                  || (returnsToDownLane ? 'top' : terminalTargetAlreadyCoordinated ? undefined : 'left'),
              sourcePortCandidates: callbackOutcomePlacement
                ? [callbackOutcomeSourcePort]
                : terminalEdge.props?.sourcePortCandidates,
              targetPortCandidates: callbackOutcomePlacement
                ? ['left']
                : terminalEdge.props?.targetPortCandidates,
              lockPortCandidates: Boolean(callbackOutcomePlacement),
              layoutRouteReason: callbackOutcomePlacement
                ? `${terminalEdge.type} callback outcome exits ${callbackOutcomeSourcePort}-center and reaches the common outcome column`
                : returnsToDownLane
                ? `operand result returns to the Flow Branch vertical lane at x=${currentPos.operandFlowRootX}`
                : 'operand result continues into the side execution lane',
            },
          };
          if (returnsToDownLane) {
            deferConnectionEdge(routedTerminalEdge);
            continue;
          }
          if (positions.has(terminalChild.key)) {
            pushRenderEdge(routedTerminalEdge);
            continue;
          }
          renderEdges.push(placeEdgeTarget(
            routedTerminalEdge,
            terminalChild,
            callbackOutcomePlacement?.x ?? currentPos.x + 1,
            callbackOutcomePlacement?.y ?? currentPos.y,
            `newStraightDrawio: side execution after Operand Branch ${current.key}`,
            { avoidRightFootprintWidth: ownRightFootprintWidth(terminalChild, callbackOutcomePlacement?.x ?? currentPos.x + 1), keepRequestedRow: Boolean(callbackOutcomePlacement) },
          ));
          setFanoutMeta(terminalChild.key, inheritFanoutMeta(currentPos));
          sideExecutionChild ||= terminalChild;
        }

        logCoordinatorStep(positions, current, 'coordinateOperandBranch', {
          continuationTarget: continuation?.end,
          joinTargets: joinEdges.map((edge) => edge.end),
          terminalTargets: terminalEdges.map((edge) => edge.end),
          reason: 'Operand Branch chain is horizontal; terminal results return to the root vertical lane or continue into side execution',
        });

        currentCanPlaceRejoinTarget = false;
        current = continuation ? nodeByKey.get(continuation.end) : (sideExecutionChild || rightJoinChild || nextPendingCurrent());
        continue;
      }

      if (isFlowBranchNode(current)) {
        const flowEdges = [...trueEdges, ...falseEdges];
        const branchContinuation = nearestFlowBranchContinuation(current, flowEdges);

        if (branchContinuation) {
          const continuationChild = nodeByKey.get(branchContinuation.end);
          if (!continuationChild) {
            throw new Error(`newStraightDrawio missing Flow Branch continuation: ${branchContinuation.end}`);
          }
          const parallelEdge = flowEdges.find((edge) => edge !== branchContinuation);
          const { rootKey, rootX, rightX, startsNestedFlow } = flowBranchLaneRoot(current, currentPos);
          const calculatedLanes = chooseBranchLanes(
            current,
            trueEdges[0],
            falseEdges[0],
            nodeByKey,
            outgoingBySource,
          );
          const parallelChildForPlacement = parallelEdge ? nodeByKey.get(parallelEdge.end) : undefined;
          const currentStepStableId = String(current.props?.parentStepStableId || '').trim();
          const inlineConditionChain = Boolean(
            currentStepStableId
            && isFlowJoinNode(parallelChildForPlacement)
            && parallelChildForPlacement.props?.parentStepStableId === currentStepStableId
            && continuationChild.props?.parentStepStableId === currentStepStableId,
          );
          const placement = inlineConditionChain
            ? {
                x: flowBranchLaneForEdge(branchContinuation, rootX, rightX, calculatedLanes),
                y: currentPos.y + 1,
                parallelX: flowBranchLaneForEdge(parallelEdge, rootX, rightX, calculatedLanes),
                score: 0,
              }
            : chooseFlowBranchContinuationPlacement(
                currentPos,
                rootKey,
                rootX,
                rightX,
                parallelEdge,
                branchContinuation,
                continuationChild,
                calculatedLanes,
              );
          const predicateAxisRootKey = String(
            currentPos.props?.flowPredicateAxisRootKey
            || currentPos.props?.flowBranchRootKey
            || current.key,
          );
          const predicateAxisLane = String(
            nodeByKey.get(predicateAxisRootKey)?.props?.flowLaneStableId
            || current.props?.flowLaneStableId
            || '',
          );
          const continuationJoinExits = (outgoingBySource.get(continuationChild.key) || []).filter((edge) => {
            if (edge.type !== 'TRUE' && edge.type !== 'FALSE') return false;
            const target = nodeByKey.get(edge.end);
            return isFlowJoinNode(target);
          });
          const continuationMainExit = continuationJoinExits.find((edge) => (
            edge.props?.main_flow === true || edge.props?.mainFlow === true
          )) || continuationJoinExits.find((edge) => {
            const targetLane = String(nodeByKey.get(edge.end)?.props?.flowLaneStableId || '');
            return predicateAxisLane && targetLane === predicateAxisLane;
          });
          const predicateAlreadyShifted = currentPos.props?.flowPredicateShifted === true;
          const continuesFlowPredicateColumn = Boolean(
            isFlowBranchNode(continuationChild)
            && !(extractedSubstepColumnOffset(continuationChild) > 0)
            && (
              predicateAlreadyShifted
              || continuationMainExit?.type === branchContinuation.type
            ),
          );
          if (continuesFlowPredicateColumn) {
            placement.x = currentPos.x;
            placement.y = currentPos.y + 1;
          } else if (
            isFlowBranchNode(continuationChild)
            && !(extractedSubstepColumnOffset(continuationChild) > 0)
          ) {
            placement.x = Math.max(rightX, currentPos.x + 1);
            placement.y = currentPos.y + 1;
          }
          if (debug) {
            console.error(
              `flow predicate continuation ${current.key} -> ${continuationChild.key}: `
              + `inline=${inlineConditionChain} reuseFlowColumn=${continuesFlowPredicateColumn} `
              + `mainExit=${continuationMainExit?.type || 'none'} shifted=${predicateAlreadyShifted} `
              + `x=${placement.x} currentX=${currentPos.x}`,
            );
          }
          const substepColumnOffset = extractedSubstepColumnOffset(continuationChild);
          if (substepColumnOffset > 0 && !continuesFlowPredicateColumn) {
            placement.x = Math.max(placement.x, currentPos.x + substepColumnOffset);
            placement.y = currentPos.y + extractedSubstepRowOffset(continuationChild);
          }
          const routedContinuation = {
            ...branchContinuation,
            props: {
              ...branchContinuation.props,
              layoutBranchContinuationSelected: true,
              sourcePort: predicateMosaicClose && branchContinuation.start === current.key
                ? 'bottom'
                : predicateMosaicClose && branchContinuation.start === predicateMosaicClose.key
                  ? 'right'
                  : flowBranchPortToward(currentPos.x, placement.x),
              targetPort: 'top',
              layoutRouteReason: 'Flow Branch continuation lane is selected together with the parallel outgoing route',
            },
          };
          renderEdges.push(placeEdgeTarget(
            routedContinuation,
            continuationChild,
            placement.x,
            placement.y,
            `newStraightDrawio: next Flow Branch uses the least-conflicting main/right lane below ${current.key}`,
            // The candidate was already selected against nodes owned by this Step.
            // Nodes from a completed sibling Step must not stretch this condition.
            { keepRequestedRow: true },
          ));
          setNodePositionMeta(positions, continuationChild.key, {
            props: {
              ...(positions.get(continuationChild.key)?.props || {}),
              flowBranchRootKey: rootKey,
              flowBranchRootX: rootX,
              flowBranchRightX: rightX,
              flowPredicateAxisRootKey: predicateAxisRootKey,
              flowPredicateShifted: predicateAlreadyShifted || placement.x !== currentPos.x,
            },
          });
          setFanoutMeta(continuationChild.key, inheritFanoutMeta(currentPos));

          flowEdges
            .filter((edge) => edge !== branchContinuation)
            .forEach((edge) => {
              const parallelChild = nodeByKey.get(edge.end);
              if (!parallelChild) {
                throw new Error(`newStraightDrawio missing Flow Branch parallel target: ${edge.end}`);
              }
              const calculatedParallelX = continuesFlowPredicateColumn
                ? Math.max(rightX, currentPos.x + 1)
                : flowBranchLaneForEdge(edge, rootX, rightX, calculatedLanes);
              const parallelX = flowJoinReturnLaneX(current, parallelChild, calculatedParallelX);
              if (isFlowJoinNode(parallelChild) && parallelX === rootX) {
                parallelChild.props = {
                  ...(parallelChild.props || {}),
                  flowBranchReturnX: rootX,
                };
              }
              const routedParallelEdge = {
                ...edge,
                props: {
                  ...edge.props,
                  sourcePort: predicateMosaicClose && edge.start === current.key
                    ? 'bottom'
                    : predicateMosaicClose && edge.start === predicateMosaicClose.key
                      ? 'right'
                      : flowBranchPortToward(currentPos.x, parallelX),
                  ...(!isFlowJoinNode(parallelChild) ? { targetPortCandidates: ['top', 'left'] } : {}),
                  layoutRouteReason: 'Flow Branch parallel edge is scheduled together with condition continuation',
                },
              };
              const reachedThroughContinuation = isFlowBranchNode(parallelChild)
                && flowBranchReachesBranch(continuationChild.key, parallelChild.key);
              if (reachedThroughContinuation) {
                deferConnectionEdge(routedParallelEdge);
                return;
              }
              if (isFlowBranchNode(parallelChild)) {
                parallelChild.props = {
                  ...(parallelChild.props || {}),
                  flowBranchRootKey: rootKey,
                  flowBranchRootX: rootX,
                  flowBranchRightX: rightX,
                };
              }
              if (positions.has(parallelChild.key)) {
                deferConnectionEdge(routedParallelEdge);
                return;
              }
              pushContinuation({
                node: parallelChild,
                edge: routedParallelEdge,
                x: parallelX,
                yStart: currentPos.y + 1,
                reason: `newStraightDrawio: scheduled parallel Flow Branch outcome from ${current.key}`,
                avoidRightFootprint: parallelX === rootX,
                stopStack: currentStopStack,
                canPlaceRejoinTarget: true,
              });
            });
          logCoordinatorStep(positions, current, 'coordinateFlowBranchContinuation', {
            continuationTarget: continuationChild.key,
            deferredTargets: flowEdges.filter((edge) => edge !== branchContinuation).map((edge) => edge.end),
            rootX,
            rightX,
            parallelX: placement.parallelX,
            placedX: placement.x,
            placedY: placement.y,
            routeScore: placement.score,
            reason: inlineConditionChain
              ? continuesFlowPredicateColumn
                ? `${calculatedLanes.reason}; the next short-circuit predicate stays on the active flow column`
                : calculatedLanes.reason
              : continuesFlowPredicateColumn
                ? `${calculatedLanes.reason}; the next predicate stays on the active flow column`
                : `both outgoing routes use the calculated short/down and long/right lanes${startsNestedFlow ? ' from the nested flow root' : ''}: ${calculatedLanes.reason}`,
          });
          currentCanPlaceRejoinTarget = false;
          current = continuationChild;
          continue;
        }

        const branchInsideLoop = String(current.props?.parentStepStableId || '').startsWith('flow-step:loop:');
        let mainLane = flowEdges.find((edge) => edge.props?.main_flow === true || edge.props?.mainFlow === true);
        let sideLane = flowEdges.find((edge) => edge !== mainLane);
        if (trueEdges.length === 1 && falseEdges.length === 1) {
          const fallbackLanes = chooseBranchLanes(current, trueEdges[0], falseEdges[0], nodeByKey, outgoingBySource);
          mainLane = fallbackLanes.down;
          sideLane = fallbackLanes.right;
        }
        if (!mainLane || !sideLane) {
          throw new Error(`newStraightDrawio terminal Flow Branch requires one main_flow and one side target: ${current.key}`);
        }
        const mainChild = nodeByKey.get(mainLane.end);
        const sideChild = nodeByKey.get(sideLane.end);
        if (!mainChild || !sideChild) {
          throw new Error(`newStraightDrawio missing Flow Branch terminal target from ${current.key}`);
        }
        const terminalJoinOwnsCurrentLane = isFlowJoinNode(mainChild)
          && mainChild.props?.inlineStepTerminalJoin === true
          && mainChild.props?.parentStepStableId === current.props?.parentStepStableId;
        const laneRoot = flowBranchLaneRoot(current, currentPos);
        const branchRootX = terminalJoinOwnsCurrentLane ? currentPos.x : laneRoot.rootX;
        const rootX = flowJoinReturnLaneX(current, mainChild, branchRootX);
        let rightX = terminalJoinOwnsCurrentLane ? branchRootX + 1 : laneRoot.rightX;
        if (branchInsideLoop) {
          const shortBranchWidth = Math.max(1, ownRightFootprintWidth(mainChild, rootX));
          rightX = Math.max(rightX, rootX + Math.ceil(shortBranchWidth));
          current.props = {
            ...(current.props || {}),
            flowBranchRootX: rootX,
            flowBranchRightX: rightX,
          };
        }
        if (isFlowJoinNode(mainChild)) {
          mainChild.props = {
            ...(mainChild.props || {}),
            flowBranchReturnX: rootX,
          };
        }
        const routedMainLane = {
          ...mainLane,
          props: {
            ...mainLane.props,
            sourcePort: undefined,
            sourcePortCandidates: currentPos.x > rootX
              ? ['left', 'bottom', 'right', 'top']
              : ['bottom', 'left', 'right', 'top'],
            lockPortCandidates: true,
            ...(!isFlowJoinNode(mainChild) ? { targetPortCandidates: ['top', 'right'] } : {}),
            layoutRouteReason: 'Flow Branch main continuation returns to the original lane',
          },
        };

        if (mainLane.end === sideLane.end) {
          deferConnectionEdge({
            ...sideLane,
            props: {
              ...sideLane.props,
              sourcePortCandidates: ['right', 'bottom'],
              targetPortCandidates: ['top', 'left'],
            },
          });
          pushContinuation({
            node: mainChild,
            edge: routedMainLane,
            x: rootX,
            yStart: currentPos.y + 1,
            reason: `newStraightDrawio: empty Flow Branch converges below ${current.key}`,
            canPlaceRejoinTarget: true,
          });
          currentCanPlaceRejoinTarget = false;
          current = nextPendingCurrent();
          continue;
        }

        const sideSubstepColumnOffset = extractedSubstepColumnOffset(sideChild);
        const sideX = sideSubstepColumnOffset > 0
          ? Math.max(rightX, currentPos.x + sideSubstepColumnOffset)
          : rightX;
        const routedSideLane = {
          ...sideLane,
          props: {
            ...sideLane.props,
            sourcePort: undefined,
            sourcePortCandidates: sideX > currentPos.x
              ? ['right', 'bottom', 'top', 'left']
              : ['bottom', 'left', 'right', 'top'],
            lockPortCandidates: true,
            targetPort: 'top',
            layoutRouteReason: 'Flow Branch side execution uses the right lane',
          },
        };
        const sideFootprintRows = Math.max(
          1,
          rightSubtreeFootprintRows(sideLane.end, mainLane.end, outgoingBySource, nodeByKey),
        );
        const sideFootprintWidth = Math.max(
          1,
          sideX - rootX + ownRightFootprintWidth(sideChild, sideX),
        );
        renderEdges.push(placeEdgeTarget(
          routedSideLane,
          sideChild,
          sideX,
          currentPos.y + (sideSubstepColumnOffset > 0 ? extractedSubstepRowOffset(sideChild) : 1),
          `newStraightDrawio: Flow Branch side execution right and below ${current.key}`,
          {
            avoidRightFootprintWidth: ownRightFootprintWidth(sideChild, sideX),
            keepRequestedRow: sideSubstepColumnOffset > 0,
          },
        ));
        setFanoutMeta(sideChild.key, inheritFanoutMeta(currentPos));
        pushContinuation({
          node: mainChild,
          edge: routedMainLane,
          x: rootX,
          yStart: currentPos.y + 1,
          reason: `newStraightDrawio: Flow Branch main continuation uses the first free row after the already positioned side branch of ${current.key}`,
          avoidRightFootprint: true,
          avoidRightFootprintWidth: sideFootprintWidth,
          keepRequestedRow: false,
          stopStack: currentStopStack,
          canPlaceRejoinTarget: true,
        });
        logCoordinatorStep(positions, current, 'coordinateFlowBranchTerminal', {
          mainTarget: mainChild.key,
          sideTarget: sideChild.key,
          rootX,
          rightX,
          sideFootprintRows,
          sideFootprintWidth,
          reason: 'main_flow goes down; side execution goes right to the next column and then down',
        });
        currentCanPlaceRejoinTarget = false;
        current = sideChild;
        continue;
      }

      const trueEffectiveTarget = nodeByKey.get(effectiveTargetForEdge(trueEdges[0], nodeByKey, outgoingBySource).edge.end);
      const falseEffectiveTarget = nodeByKey.get(effectiveTargetForEdge(falseEdges[0], nodeByKey, outgoingBySource).edge.end);
      if (isFlowBranchNode(current) && isOperandBranchNode(trueEffectiveTarget) && isOperandBranchNode(falseEffectiveTarget)) {
        const operandGraph = measureFlowConditionOperandGraph([trueEdges[0], falseEdges[0]], nodeByKey, outgoingBySource);
        const terminalTrue = operandGraph.terminalEdges.find((edge) => edge.type === 'TRUE');
        const terminalFalse = operandGraph.terminalEdges.find((edge) => edge.type === 'FALSE');
        if (!terminalTrue || !terminalFalse) {
          throw new Error(`newStraightDrawio Flow condition has no terminal TRUE/FALSE pair: ${current.key}`);
        }
        const terminalLanes = chooseBranchLanes(current, terminalTrue, terminalFalse, nodeByKey, outgoingBySource);
        const downTarget = effectiveTargetForEdge(terminalLanes.down, nodeByKey, outgoingBySource).edge.end;
        const downChild = nodeByKey.get(downTarget);
        if (!downChild) throw new Error(`newStraightDrawio missing Flow condition down target: ${downTarget}`);
        const maxOperandDepth = Math.max(1, ...operandGraph.depthByKey.values());
        pushContinuation({
          node: downChild,
          x: currentPos.x,
          yStart: currentPos.y + maxOperandDepth,
          reason: `newStraightDrawio: execution resumes below horizontal operand graph of ${current.key}`,
          avoidRightFootprint: true,
          canPlaceRejoinTarget: true,
        });

        const directOperandEdges = [trueEdges[0], falseEdges[0]]
          .map((edge) => effectiveTargetForEdge(edge, nodeByKey, outgoingBySource).edge)
          .sort((left, right) => (operandGraph.depthByKey.get(left.end) || 1) - (operandGraph.depthByKey.get(right.end) || 1));
        const directChildren = [];
        for (const edge of directOperandEdges) {
          const child = nodeByKey.get(edge.end);
          if (!child) throw new Error(`newStraightDrawio missing direct operand child: ${edge.end}`);
          const depth = operandGraph.depthByKey.get(child.key) || 1;
          const routedEdge = {
            ...edge,
            props: {
              ...edge.props,
              sourcePort: edge.props?.sourcePort || 'right',
              targetPort: edge.props?.targetPort || 'left',
              layoutRouteReason: `Flow condition operand depth ${depth} is placed horizontally`,
            },
          };
          renderEdges.push(placeEdgeTarget(
            routedEdge,
            child,
            currentPos.x + depth,
            currentPos.y,
            `newStraightDrawio: horizontal operand depth ${depth} of Flow Branch ${current.key}`,
          ));
          setFanoutMeta(child.key, {
            ...inheritFanoutMeta(currentPos),
            operandFlowRootX: currentPos.x,
            operandFlowRootY: currentPos.y,
            operandFlowDownTarget: downTarget,
          });
          directChildren.push({ child, edge: routedEdge, depth });
        }
        directChildren.sort((left, right) => left.depth - right.depth);
        const deepest = directChildren.pop();
        for (const pendingOperand of directChildren) {
          pushContinuation({
            node: pendingOperand.child,
            x: positions.get(pendingOperand.child.key)?.x ?? currentPos.x + pendingOperand.depth,
            yStart: positions.get(pendingOperand.child.key)?.y ?? currentPos.y,
            reason: `newStraightDrawio: deferred horizontal operand of ${current.key}`,
            keepRequestedRow: true,
            fanoutMeta: inheritFanoutMeta(positions.get(pendingOperand.child.key)),
            canPlaceRejoinTarget: false,
          });
        }
        logCoordinatorStep(positions, current, 'coordinateFlowOperandGraph', {
          operandCount: operandGraph.depthByKey.size,
          maxOperandDepth,
          downTarget,
          reason: 'all condition operands are positioned first; executable lanes start only at terminal outcomes',
        });
        currentCanPlaceRejoinTarget = false;
        current = deepest?.child || nextPendingCurrent();
        continue;
      }

      const lanes = chooseBranchLanes(current, trueEdges[0], falseEdges[0], nodeByKey, outgoingBySource);
      const effectiveDownLane = effectiveTargetForEdge(lanes.down, nodeByKey, outgoingBySource).edge;
      const rightLane = effectiveTargetForEdge(lanes.right, nodeByKey, outgoingBySource).edge;
      const downLane = lanes.down;
      const downChild = nodeByKey.get(downLane.end);
      const rightChild = nodeByKey.get(rightLane.end);
      if (!downChild) throw new Error(`newStraightDrawio missing Branch down child node: ${lanes.down.end}`);
      if (!rightChild) throw new Error(`newStraightDrawio missing Branch right child node: ${lanes.right.end}`);
      const branchInsideLoop = String(current.props?.parentStepStableId || '').startsWith('flow-step:loop:');
      const rawRightFootprintRows = rightSubtreeFootprintRows(rightLane.end, effectiveDownLane.end, outgoingBySource, nodeByKey);
      const booleanChainRightLane = isSameLineBooleanBranchChain(current, rightChild, lanes.right, lanes.down, nodeByKey, outgoingBySource);
      const rightFootprintRows = booleanChainRightLane
        ? Math.min(rawRightFootprintRows, 2)
        : rawRightFootprintRows;
      const downYStart = branchInsideLoop ? currentPos.y + 1 : currentPos.y + rightFootprintRows;
      recordBranchCoordinateStep(positions, current, {
        trueEdge: trueEdges[0],
        falseEdge: falseEdges[0],
        rightLane,
        downLane,
        rightFootprintRows,
        downYStart,
        reason: booleanChainRightLane
          ? `${lanes.reason}; boolean-chain down lane uses local footprint ${rightFootprintRows} instead of raw right footprint ${rawRightFootprintRows}`
          : lanes.reason,
      });

      const rightChildPos = positions.get(rightChild.key);
      const rightLaneSourcePort = Number.isFinite(rightChildPos?.x) && rightChildPos.x < currentPos.x
        ? 'left'
        : 'right';
      const routedRightLane = {
        ...rightLane,
        props: {
          ...rightLane.props,
          sourcePort: rightLane.props?.sourcePort || rightLaneSourcePort,
          layoutRouteReason: [
            rightLane.props?.layoutRouteReason,
            rightLaneSourcePort === 'left'
              ? 'Branch right lane target was already placed to the left, so it exits from the nearest free left side'
              : 'Branch right lane exits from right side',
          ].filter(Boolean).join('; '),
        },
      };
      const routedDownLane = {
        ...downLane,
        props: {
          ...downLane.props,
          sourcePort: downLane.props?.sourcePort || 'bottom',
          layoutRouteReason: [
            downLane.props?.layoutRouteReason,
            'Branch down lane exits from bottom-center',
          ].filter(Boolean).join('; '),
        },
      };

      renderEdges.push(placeEdgeTarget(
        routedRightLane,
        rightChild,
        currentPos.x + 1,
        branchInsideLoop ? currentPos.y + 1 : currentPos.y,
        `newStraightDrawio: Branch right lane from ${current.key}; placed by target footprint instead of source-row alignment; ${lanes.reason}`,
        {
          avoidRightFootprintWidth: Math.max(
            ownRightFootprintWidth(rightChild, currentPos.x + 1),
            rawRightFootprintRows,
          ),
          keepRequestedRow: branchInsideLoop,
        },
      ));
      setFanoutMeta(rightChild.key, {
        ...inheritFanoutMeta(currentPos),
        ...(isOperandBranchNode(rightChild) ? {
          operandFlowRootX: currentPos.x,
          operandFlowRootY: currentPos.y,
          operandFlowDownTarget: effectiveDownLane.end,
        } : {}),
      });

      pushContinuation({
        node: downChild,
        edge: routedDownLane,
        x: currentPos.x,
        yStart: downYStart,
        reason: branchInsideLoop
          ? `newStraightDrawio: loop Branch short lane starts below ${current.key} in parallel with the right lane; ${lanes.reason}`
          : `newStraightDrawio: Branch down lane after right subtree footprint (${rightFootprintRows} rows) of ${current.key}; ${booleanChainRightLane ? `boolean-chain local footprint instead of raw ${rawRightFootprintRows}; ` : ''}${lanes.reason}`,
        avoidRightFootprint: !branchInsideLoop,
        keepRequestedRow: branchInsideLoop,
        stopStack: currentStopStack,
        canPlaceRejoinTarget: true,
      });
      if (positions.has(downChild.key) && visited.has(downChild.key)) {
        pushRenderEdge(routedDownLane);
      }
      currentStopStack = lanes.joinKey ? [...currentStopStack, lanes.joinKey] : currentStopStack;
      currentStopAt = currentStopStack[currentStopStack.length - 1] || null;
      currentCanPlaceRejoinTarget = false;
      current = rightChild;
      continue;
    }

    if (isCallResultNode(current) && hasLabel(current, 'Collection')) {
      const collectionContinuation = outgoing.find((edge) => {
        if (edge.type !== 'NEXT') return false;
        const target = nodeByKey.get(edge.end);
        return hasLabel(target, 'Collection') && (hasLabel(target, 'Op') || hasLabel(target, 'Call') || hasLabel(target, 'Request'));
      });
      if (collectionContinuation) {
        const child = nodeByKey.get(collectionContinuation.end);
        if (!positions.has(child.key)) {
          placeNode(
            positions,
            child,
            currentPos.x,
            currentPos.y + 0.5,
            `newStraightDrawio: collection method is visually inserted into result ${current.key}`,
            'placeCollectionMethodInResult',
          );
        }
        current = child;
        continue;
      }
    }

    if (
      isFieldJoinNode(current)
      && hasLabel(current, 'Parameter')
      && outgoing.filter((edge) => !isResourceEdge(edge)).length === 0
    ) {
      current = nextPendingCurrent();
      continue;
    }

    const valueOutcomeFanoutEdges = isValueOutcomeNode(current)
      ? outgoing.filter((edge) => !isResourceEdge(edge) && edge.type === 'VALUE')
      : [];
    if (valueOutcomeFanoutEdges.length > 1) {
      valueOutcomeFanoutEdges.forEach((fanoutEdge, index) => {
        const child = nodeByKey.get(fanoutEdge.end);
        if (!child) throw new Error(`newStraightDrawio missing ValueOutcome fanout target: ${fanoutEdge.end}`);
        renderEdges.push(placeEdgeTarget(
          {
            ...fanoutEdge,
            props: {
              ...fanoutEdge.props,
              sourcePort: 'right',
              targetPort: 'left',
              layoutRouteReason: 'ValueOutcome fans out to De Morgan invariant intersections',
            },
          },
          child,
          currentPos.x + 1,
          currentPos.y + index * 0.5,
          `newStraightDrawio: ValueOutcome invariant fanout from ${current.key}`,
          { keepRequestedRow: index === 0 },
        ));
        pushContinuation({
          node: child,
          x: currentPos.x + 1,
          yStart: currentPos.y + index * 0.5,
          reason: `newStraightDrawio: pending De Morgan invariant join from ${current.key}`,
          canPlaceRejoinTarget: true,
          keepRequestedRow: index === 0,
        });
      });
      current = nextPendingCurrent();
      continue;
    }

    if (hasLabel(current, 'ExecutionJunction')) {
      const axisEdges = outgoing.filter((edge) => edge.type === 'NEXT');
      const communicationEdges = outgoing.filter((edge) => edge.type !== 'NEXT' && !isResourceEdge(edge));
      if (axisEdges.length > 1 || communicationEdges.length === 0) {
        throw new Error(`newStraightDrawio ExecutionJunction invariant failed for ${current.key}: ${outgoing.map((edge) => edge.type).join(',')}`);
      }
      communicationEdges.forEach((communicationEdge, index) => {
        const target = nodeByKey.get(communicationEdge.end);
        if (!target) throw new Error(`newStraightDrawio missing ExecutionJunction target: ${communicationEdge.end}`);
        renderEdges.push(placeEdgeTarget(
          communicationEdge,
          target,
          currentPos.x + 1,
          currentPos.y + index,
          `newStraightDrawio: ${communicationEdge.type} communication from junction ${current.key}`,
          { keepRequestedRow: index === 0 },
        ));
        pushContinuation({
          node: target,
          x: currentPos.x + 1,
          yStart: currentPos.y + index,
          reason: `newStraightDrawio: communication from junction ${current.key}`,
          canPlaceRejoinTarget: false,
          keepRequestedRow: index === 0,
        });
      });
      if (axisEdges.length === 1) {
        const axisEdge = axisEdges[0];
        const axisTarget = nodeByKey.get(axisEdge.end);
        if (!axisTarget) throw new Error(`newStraightDrawio missing ExecutionJunction axis target: ${axisEdge.end}`);
        renderEdges.push(placeEdgeTarget(
          axisEdge,
          axisTarget,
          currentPos.x,
          currentPos.y + 1,
          `newStraightDrawio: axis segment after junction ${current.key}`,
        ));
        current = axisTarget;
      } else {
        current = nextPendingCurrent();
      }
      continue;
    }

    if (hasLabel(current, 'Primitive') && hasLabel(current, 'Pull')) {
      const outcomeEdges = outgoing.filter((edge) => (
        edge.type === 'YIELDS_VALUE' || edge.type === 'EXHAUSTED' || edge.type === 'EXITS'
      ));
      if (outcomeEdges.length !== outgoing.length || outcomeEdges.length === 0) {
        throw new Error(`newStraightDrawio Pull invariant failed for ${current.key}: ${outgoing.map((edge) => edge.type).join(',')}`);
      }
      outcomeEdges.forEach((outcomeEdge, index) => {
        const target = nodeByKey.get(outcomeEdge.end);
        if (!target) throw new Error(`newStraightDrawio missing Pull outcome target: ${outcomeEdge.end}`);
        renderEdges.push(placeEdgeTarget(
          outcomeEdge,
          target,
          currentPos.x + 1,
          currentPos.y + index * 0.5,
          `newStraightDrawio: ${outcomeEdge.type} outcome from Pull ${current.key}`,
          { keepRequestedRow: index === 0 },
        ));
        pushContinuation({
          node: target,
          x: currentPos.x + 1,
          yStart: currentPos.y + index * 0.5,
          reason: `newStraightDrawio: ${outcomeEdge.type} outcome from Pull ${current.key}`,
          canPlaceRejoinTarget: false,
          keepRequestedRow: index === 0,
        });
      });
      current = nextPendingCurrent();
      continue;
    }

    const terminalProducerResourceEdges = producerReturnEdges.length > 0
      && outgoing.length > 0
      && outgoing.every((edge) => isResourceEdge(edge))
      ? outgoing
      : [];
    if (terminalProducerResourceEdges.length) {
      terminalProducerResourceEdges.forEach((resourceEdge, index) => {
        const resourceTarget = nodeByKey.get(resourceEdge.end);
        if (!resourceTarget) {
          throw new Error(`newStraightDrawio missing terminal producer resource target: ${resourceEdge.end}`);
        }
        renderEdges.push(placeEdgeTarget(
          resourceEdge,
          resourceTarget,
          currentPos.x + horizontalStepForNode(current),
          currentPos.y + index,
          `newStraightDrawio: ${resourceEdge.type} side effect of terminal producer ${current.key}`,
          { keepRequestedRow: index === 0 },
        ));
        pushContinuation({
          node: resourceTarget,
          x: currentPos.x + horizontalStepForNode(current),
          yStart: currentPos.y + index,
          reason: `newStraightDrawio: terminal producer resource ${resourceEdge.type} from ${current.key}`,
          canPlaceRejoinTarget: false,
          keepRequestedRow: index === 0,
        });
      });
      current = nextPendingCurrent();
      continue;
    }

    assertLinearOutgoing(current, outgoing, options);

    if (!isCurrentNodeLinear(current, options)) {
      throw new Error(`newStraightDrawio switch case is not implemented for ${current.key}: ${current.labels.join(',')}`);
    }

    const edge = getLinearContinuationEdge(outgoing);
    const sideEdges = outgoing.filter((item) => item !== edge);
    recordLinearCoordinateStep(positions, current, { edge, sideEdges });
    sideEdges.forEach((sideEdge, index) => {
      const sideChild = nodeByKey.get(sideEdge.end);
      if (!sideChild) {
        throw new Error(`newStraightDrawio missing side child node: ${sideEdge.end}`);
      }
      const inlineLocalFunctionProxy = sideEdge.type === 'DECLARES_FUNCTION'
        && hasLabel(sideChild, 'LocalFunctionProxy')
        && !shouldExpandLocalFunctionProxy(options);
      const sideY = inlineLocalFunctionProxy ? currentPos.y : currentPos.y + index;
      renderEdges.push(placeEdgeTarget(
        sideEdge,
        sideChild,
        currentPos.x + horizontalStepForNode(current),
        sideY,
        inlineLocalFunctionProxy
          ? `newStraightDrawio: unexpanded local function proxy stays beside its declaration ${current.key}`
          : `newStraightDrawio: ${sideEdge.type} side edge of ${current.key}`,
        inlineLocalFunctionProxy ? { keepRequestedRow: true } : {},
      ));
      if (inlineLocalFunctionProxy) return;
      pushContinuation({
        node: sideChild,
        x: currentPos.x + horizontalStepForNode(current),
        yStart: currentPos.y + index,
        reason: `newStraightDrawio: pending ${sideEdge.type} side edge of ${current.key}`,
        canPlaceRejoinTarget: false,
      });
    });

    const child = nodeByKey.get(edge.end);
    if (!child) {
      throw new Error(`newStraightDrawio missing child node: ${edge.end}`);
    }

    if (isArgumentFunctionJoinEdge(edge, nodeByKey)) {
      const proxyY = hasLabel(current, 'CallbackResult')
        ? currentPos.y
        : Number.isFinite(fanoutTopY(currentPos)) ? fanoutTopY(currentPos) : currentPos.y;
      const proxyX = closingProxyX(edge, currentPos);
      const proxy = materializeCallVisualTarget(
        edge,
        proxyX,
        proxyY,
        `newStraightDrawio: ${edge.type} closes argument branches directly at ${callInvocationType(edge)} function proxy`,
        { splitCallBoundary: 'end' },
      );
      if (proxy) {
        renderCallEdgeToVisualTarget(edge, proxy, {
          sourcePort: 'right',
          targetPort: callInvocationType(edge) === 'REQUEST' ? 'left-25' : 'left',
        });
        setFanoutMeta(proxy.key, popFanoutContext(currentPos));
        const proxyPosition = positions.get(proxy.key);
        const proxyRejoinEdges = (outgoingBySource.get(proxy.key) || []).filter((item) => item.type === 'REJOINS');
        const proxyRejoinContinuation = proxyRejoinEdges.length
          ? positionRejoinTargets(proxy, proxyPosition, proxyRejoinEdges, currentStopAt)
          : null;
        if (proxyRejoinContinuation && (!visited.has(proxyRejoinContinuation.key) || hasUntraversedContinuation(proxyRejoinContinuation))) {
          const continuationPosition = positions.get(proxyRejoinContinuation.key) || proxyPosition;
          visited.delete(proxyRejoinContinuation.key);
          pushContinuation({
            node: proxyRejoinContinuation,
            x: continuationPosition.x,
            yStart: continuationPosition.y,
            reason: `newStraightDrawio: resume continuation after call proxy REJOINS from ${proxy.key}`,
            stopStack: [],
            canPlaceRejoinTarget: true,
            keepRequestedRow: true,
          });
        }
      }
      current = nextPendingCurrent();
      continue;
    }

    const waitingRejoinSources = isFlowJoinNode(child) && edge.type !== 'REJOINS'
      ? unpositionedRejoinSourceIds(child.key)
      : [];
    if (waitingRejoinSources.length) {
      deferFlowJoinUntilRejoins(
        child,
        edge,
        currentPos.x,
        currentPos.y + 1,
        `newStraightDrawio: defer FlowJoin ${child.key} until incoming REJOINS sources are positioned`,
        inheritFanoutMeta(currentPos),
      );
      current = nextPendingCurrent();
      continue;
    }

    if (materializePendingNode(child)) {
      pushRenderEdge(edge);
      current = child;
      continue;
    }

    if (positions.has(child.key)) {
      const childPos = positions.get(child.key);
      if (isFanoutContextMergeNode(child) && Number.isFinite(fanoutTopY(currentPos))) {
        noteFanoutFootprint(child.key);
      }
      pushRenderEdge(edge);
      current = nextPendingCurrent();
      continue;
    }

    const fanoutMerge = isFanoutContextMergeNode(child) && Number.isFinite(fanoutTopY(currentPos));
    const argumentClosure = isArgumentClosureTarget(edge, child);
    const arrowContinuation = edge.type === 'ARROW';
    const startsFunctionParameter = hasLabel(child, 'Parameter')
      && !hasLabel(child, 'Field');
    const callbackResultPlacement = callbackResultPlacementByKey.get(child.key);
    const collectionPreviousPos = hasLabel(child, 'Collection')
      ? positions.get(
          child.props?.collectionPreviousStageStableId
            || child.props?.collection_previous_stage_stable_id
            || child.props?.collectionHeadStableId,
        )
      : undefined;
    const startsCollectionStage = Number.isFinite(collectionPreviousPos?.x) && Number.isFinite(collectionPreviousPos?.y);
    const basePreferredY = callbackResultPlacement
      ? callbackResultPlacement.y
      : fanoutMerge
      ? fanoutTopY(currentPos)
      : argumentClosure
        ? currentPos.y
        : arrowContinuation
          ? currentPos.y
          : startsCollectionStage
            ? collectionPreviousPos.y + 0.5
            : currentPos.y + 1;
    const terminalSourceX = hasLabel(child, 'FunctionEnd') ? explicitSourcePartPosition(edge)?.x : undefined;
    const requestedX = Number.isFinite(terminalSourceX) ? terminalSourceX : callbackResultPlacement
      ? callbackResultPlacement.x
      : startsFunctionParameter
      ? 0
      : fanoutMerge
      ? firstFreeVertical(positions, preferredFanoutMergeX(currentPos), basePreferredY)
      : argumentClosure
        ? currentPos.x + horizontalStepForNode(current)
        : arrowContinuation
          ? currentPos.x + 1
          : startsCollectionStage
            ? collectionPreviousPos.x
            : currentPos.x;
    const x = flowJoinPlacementX(child, requestedX);
    const joinY = flowJoinPlacementY(child, x, basePreferredY);
    const preferredY = joinY.y;
    const y = callbackResultPlacement
      ? callbackResultPlacement.y
      : joinY.alignedToRightIncoming
      ? joinY.y
      : fanoutMerge || argumentClosure
        ? preferredY
        : firstFreeHorizontal(positions, preferredY, x);
    placeNode(
      positions,
      child,
      x,
      y,
      callbackResultPlacement
        ? `newStraightDrawio: callback result join follows the common truthy/falsy outcome column`
        : startsFunctionParameter
        ? `newStraightDrawio: function parameter starts a separate step on the function entry lane`
        : fanoutMerge
        ? `newStraightDrawio: ${edge.type} fanout merge child of ${current.key}; aligned to fanout parent y=${currentPos.fanoutParentY}`
        : argumentClosure
          ? `newStraightDrawio: closing ARG child of ${current.key}; FnVisualProxy placed right on y=${preferredY}`
          : arrowContinuation
            ? `newStraightDrawio: callback parameters point right through ARROW to the callback expression`
            : startsCollectionStage
              ? `newStraightDrawio: next dot-call starts half a row below collection stage ${child.props?.collectionPreviousStageStableId}`
        : isFlowJoinNode(child)
          ? `newStraightDrawio: ${edge.type} FlowJoin child of ${current.key}; leftmost positioned incoming source owns its vertical lane`
          : `newStraightDrawio: ${edge.type} child of ${current.key}; first free horizontal under parent`,
      isFlowJoinNode(child) ? 'placeFlowJoinFromControlEdge' : 'placeNode',
      isFlowJoinNode(child)
        ? [makeTraceStep('placeFlowJoinFromControlEdge', {
          edgeType: edge.type,
          from: edge.start,
          requestedX,
          basePreferredY,
          alignedRightIncomingSource: joinY.sourceKey,
          alignedRightIncomingEdgeType: joinY.edgeType,
          leftmostIncomingSourceX: leftmostPositionedIncomingSourceX(child.key),
          placedX: x,
          placedY: y,
          reason: 'FlowJoin uses the leftmost positioned incoming lane regardless of incoming edge type',
        })]
        : undefined,
    );
    if (fanoutMerge) {
      setFanoutMeta(child.key, popFanoutContext(currentPos));
    } else if (argumentClosure && !isArgJoinNode(current)) {
      setFanoutMeta(child.key, popFanoutContext(currentPos));
    } else {
      setFanoutMeta(child.key, inheritFanoutMeta(currentPos));
    }
    pushRenderEdge(edge);
    current = child;
  }

  const collapsedControlPredecessor = (startKey) => {
    const incomingByTarget = new Map();
    for (const candidate of edges) {
      if (!['NEXT', 'TRUE', 'FALSE', 'REJOINS', 'REPEATS', 'YIELDS_VALUE'].includes(candidate.type)) continue;
      incomingByTarget.set(candidate.end, [...(incomingByTarget.get(candidate.end) || []), candidate]);
    }
    let frontier = [startKey];
    const seen = new Set(frontier);
    while (frontier.length) {
      const next = [];
      const positioned = [];
      for (const key of frontier) {
        for (const incoming of incomingByTarget.get(key) || []) {
          if (seen.has(incoming.start)) continue;
          seen.add(incoming.start);
          if (positions.has(incoming.start)) positioned.push(incoming.start);
          else next.push(incoming.start);
        }
      }
      if (positioned.length) {
        return positioned
          .map((key) => nodeByKey.get(key))
          .filter(Boolean)
          .sort((left, right) => nodeOperationIndex(right) - nodeOperationIndex(left))[0]?.key;
      }
      frontier = next;
    }
    const source = nodeByKey.get(startKey);
    const sourceBlock = String(source?.props?.parentFlowBlockStableId || '').trim();
    const sourceOrder = nodeOperationIndex(source);
    return [...nodeByKey.values()]
      .filter((candidate) => (
        positions.has(candidate.key)
        && sourceBlock
        && String(candidate.props?.parentFlowBlockStableId || '').trim() === sourceBlock
        && nodeOperationIndex(candidate) <= sourceOrder
      ))
      .sort((left, right) => nodeOperationIndex(right) - nodeOperationIndex(left))[0]?.key;
  };

  for (const edge of edges.filter((item) => item.type === 'REJOINS' || item.type === 'REPEATS')) {
    if (positions.has(edge.start) && positions.has(edge.end)) {
      pushRenderEdge(edge);
      continue;
    }
    if (edge.type !== 'REJOINS' || !positions.has(edge.end)) continue;
    const effectiveSource = collapsedControlPredecessor(edge.start);
    if (!effectiveSource || effectiveSource === edge.end) continue;
    const join = nodeByKey.get(edge.end);
    if (isFlowJoinNode(join) && !join.props?.parentStepStableId) {
      join.props = {
        ...join.props,
        flowJoinPlacementSourceStableId: effectiveSource,
      };
    }
    pushRenderEdge({
      ...edge,
      start: effectiveSource,
      props: {
        ...edge.props,
        stableId: edge.props?.stableId || edge.start,
        canonicalSourceStableId: edge.start,
        layoutEffectiveSourceStableId: effectiveSource,
      },
    });
  }

  for (const edge of deferredValueOutcomeEdges) {
    if (positions.has(edge.start) && positions.has(edge.end)) {
      pushRenderEdge(edge);
    }
  }


  // Split calls can be nested inside argument branches. Coordinate the
  // extracted closing proxies from the innermost positioned argument outward;
  // otherwise an outer multi-argument closure can be positioned by one branch
  // while another branch's closing proxy (and therefore its ArgJoin) vanishes.
  const pendingArgumentClosures = edges.filter((edge) => (
    edge.type === 'ArgJoin'
    && isFnVisualProxyNode(nodeByKey.get(edge.end))
  ));
  const argumentClosureEdgesByTarget = new Map();
  for (const edge of pendingArgumentClosures) {
    argumentClosureEdgesByTarget.set(edge.end, [
      ...(argumentClosureEdgesByTarget.get(edge.end) || []),
      edge,
    ]);
  }
  let coordinatedArgumentClosure = true;
  let argumentClosurePass = 0;
  while (
    coordinatedArgumentClosure
    && argumentClosurePass <= argumentClosureEdgesByTarget.size
  ) {
    coordinatedArgumentClosure = false;
    argumentClosurePass += 1;
    for (const [closureKey, incomingEdges] of argumentClosureEdgesByTarget) {
      const positionedInputs = incomingEdges
        .map((edge) => ({
          edge,
          source: nodeByKey.get(edge.start),
          position: positions.get(edge.start),
        }))
        .filter(({ source, position }) => source && position)
        .sort((left, right) => (
          right.position.x + horizontalStepForNode(right.source)
          - left.position.x - horizontalStepForNode(left.source)
        ));
      if (!positionedInputs.length) continue;
      const { edge, source, position: sourcePosition } = positionedInputs[0];
      const closure = nodeByKey.get(closureKey);
      if (!closure) continue;
      const requestedX = sourcePosition.x + horizontalStepForNode(source);
      const closurePosition = positions.get(closureKey);
      if (closurePosition) {
        if (closurePosition.x >= requestedX) continue;
        closurePosition.x = requestedX;
        closurePosition.trace = [
          ...(closurePosition.trace || []),
          makeTraceStep('expandExtractedArgumentClosure', {
            from: edge.start,
            closing: closureKey,
            placedX: requestedX,
            reason: 'call closure follows the widest positioned argument branch',
          }),
        ];
        coordinatedArgumentClosure = true;
        continue;
      }
      placeNode(
        positions,
        closure,
        requestedX,
        sourcePosition.y,
        `newStraightDrawio: extracted argument branch closes into ${closure.key}`,
        'placeExtractedArgumentClosure',
        [makeTraceStep('placeExtractedArgumentClosure', {
          from: edge.start,
          closing: edge.end,
          reason: 'nested split-call closures are coordinated from argument tails outward',
        })],
      );
      coordinatedArgumentClosure = true;
    }
  }

  for (const edge of deferredConnectionEdges) {
    if (positions.has(edge.start) && positions.has(edge.end)) {
      pushRenderEdge(edge);
    }
  }

  // Every extracted argument return converges on the same call closure. The
  // coordinate traversal is allowed to use only one of them for placement.
  for (const edge of edges.filter((candidate) => candidate.type === 'ArgJoin')) {
    if (positions.has(edge.start) && positions.has(edge.end)) {
      pushRenderEdge(edge);
    }
  }

  // Conditional initializer alternatives can reach an already positioned
  // container method. Preserve every extracted control return in that case.
  for (const edge of edges.filter((candidate) => (
    candidate.type === 'NEXT'
    && (
      candidate.props?.semanticExpansion
      || candidate.props?.semantic_expansion
    ) === 'conditional-assignment'
  ))) {
    if (
      positions.has(edge.start)
      && positions.has(edge.end)
      && !renderEdges.some((rendered) => (
        rendered.type === edge.type
        && rendered.start === edge.start
        && rendered.end === edge.end
      ))
    ) {
      pushRenderEdge(edge);
    }
  }

  for (const edge of edges.filter((candidate) => (
    ['PASSES_VALUE', 'YIELDS_VALUE'].includes(candidate.type)
    && hasLabel(nodeByKey.get(candidate.end), 'ContainerMethod')
    && hasLabel(nodeByKey.get(candidate.end), 'Set')
  ))) {
    if (positions.has(edge.start) && positions.has(edge.end)) {
      pushRenderEdge(edge);
    }
  }

  for (const edge of edges.filter((candidate) => (
    ['ASSIGNS_VALUE', 'YIELDS_VALUE'].includes(candidate.type)
    && (
      ['return-top', 'return-bottom'].includes(
        candidate.props?.producerRouteRole || candidate.props?.producer_route_role || '',
      )
      || Boolean(
        candidate.props?.optionalReturnGroupStableId
        || candidate.props?.optional_return_group_stable_id,
      )
    )
  ))) {
    if (positions.has(edge.start) && positions.has(edge.end)) {
      pushRenderEdge(edge);
    }
  }

  for (const completionEdge of edges.filter((edge) => edge.type === 'RESPONSE' || edge.type === 'RESULT')) {
    const invocationType = completionEdge.props?.invocation_type
      || completionEdge.props?.invocationType
      || (completionEdge.type === 'RESPONSE' ? 'REQUEST' : 'CALL');
    const callSiteStableId = callSiteStableIdForEdge(completionEdge);
    const proxyKey = `visual:call-target:${invocationType}:${callSiteStableId}->${completionEdge.start}`;
    const proxy = visualCallTargetByEdgeKey.get(proxyKey);
    if (!proxy || !positions.has(proxy.key) || !positions.has(completionEdge.end)) continue;
    const assignmentCompletion = completionEdge.end !== callSiteStableId;
    if (completionEdge.type === 'RESPONSE' && !assignmentCompletion && proxy.props?.renderCompactResponse !== true) continue;
    pushRenderEdge({
      ...completionEdge,
      start: proxy.key,
      props: {
        ...completionEdge.props,
        ...(completionEdge.type === 'RESPONSE' ? { renderCompactResponse: true } : {}),
        displayLabel: '',
        targetStableId: completionEdge.end,
        canonicalTargetStableId: completionEdge.end,
        sourcePort: completionEdge.props?.sourcePort || (assignmentCompletion ? 'bottom' : 'left-75'),
        targetPort: completionEdge.props?.targetPort || (assignmentCompletion ? 'bottom' : 'right-75'),
        layoutRouteReason: assignmentCompletion
          ? `explicit ${completionEdge.type} from original Fn to value owner; rendered from proxy below the complete invocation snippet`
          : 'explicit compact RESPONSE from original Fn to request site',
      },
    });
  }

  const resultEdgesByTarget = new Map();
  edges.filter((edge) => edge.type === 'RESULT').forEach((edge) => {
    resultEdgesByTarget.set(edge.end, [...(resultEdgesByTarget.get(edge.end) || []), edge]);
  });
  resultEdgesByTarget.forEach((resultEdges) => {
    const positioned = resultEdges
      .filter((edge) => positions.has(edge.start) && positions.has(edge.end))
      .sort((left, right) => positions.get(left.start).y - positions.get(right.start).y);
    positioned.forEach((edge, index) => {
      const exclusiveJoinResult = isExclusiveJoinNode(nodeByKey.get(edge.start));
      const useUpperRoute = !exclusiveJoinResult && positioned.length > 1 && index === 0;
      pushRenderEdge({
        ...edge,
        props: {
          ...edge.props,
          displayLabel: '',
          sourcePort: edge.props?.sourcePort || (useUpperRoute ? 'top' : 'bottom'),
          targetPort: edge.props?.targetPort || (useUpperRoute ? 'top' : 'bottom'),
          layoutRouteReason: useUpperRoute
            ? 'first exclusive value alternative returns to its owner above the expression snippet'
            : exclusiveJoinResult
              ? 'exclusive value join returns once to its owner below the complete expression snippet'
              : 'value alternative returns to its owner below the expression snippet',
        },
      });
    });
  });

  // A sole expanded argument has two visual seams around its real subgraph:
  // call-open + argument-open, then argument-close + call-close. The graph
  // retains ARG/ArgJoin; the touching mosaic tiles replace those edges visually.
  const positionedCallMosaicNodes = [...nodes, ...visualNodes];
  for (const opening of positionedCallMosaicNodes.filter((node) => isSingleArgumentCallMosaicOpen(node))) {
    const members = positionedCallMosaicNodes.filter((node) => callMosaicOwnerStableId(node) === opening.key);
    const argument = members.find((node) => callMosaicRole(node) === 'argument');
    const argumentClosing = members.find((node) => callMosaicRole(node) === 'argument-close');
    const closing = members.find((node) => callMosaicRole(node) === 'close');
    const nestedSplitCall = callBoundaryDesign(argument) === 'split';
    if ((!hasLabel(argument, 'Object') && !nestedSplitCall) || !argumentClosing || !closing) continue;
    const openingPosition = positions.get(opening.key);
    const argumentPosition = positions.get(argument.key);
    const argumentClosingPosition = positions.get(argumentClosing.key);
    const closingPosition = positions.get(closing.key);
    if (!openingPosition || !argumentPosition || !argumentClosingPosition || !closingPosition) continue;
    const argumentWidth = compactCallMosaicWidth(argument);
    const openingWidth = nestedSplitCall
      ? Math.max(
          compactCallMosaicWidth(opening),
          argumentWidth + 16,
        )
      : compactCallMosaicWidth(opening);
    const argumentClosingWidth = nestedSplitCall
      ? CALL_MOSAIC_CLOSE_WIDTH
      : compactCallMosaicWidth(argumentClosing);
    const closingWidth = CALL_MOSAIC_CLOSE_WIDTH;
    argumentPosition.x = openingPosition.x + (
      openingWidth + argumentWidth + CALL_MOSAIC_GAP * 2
    ) / (2 * DRAWIO_GRID_X);
    argumentPosition.y = openingPosition.y;
    closingPosition.x = argumentClosingPosition.x + (
      argumentClosingWidth + closingWidth + CALL_MOSAIC_GAP * 2
    ) / (2 * DRAWIO_GRID_X);
    closingPosition.y = argumentClosingPosition.y;
    for (const [node, position, width] of [
      [opening, openingPosition, openingWidth],
      [argument, argumentPosition, argumentWidth],
      [argumentClosing, argumentClosingPosition, argumentClosingWidth],
      [closing, closingPosition, closingWidth],
    ]) {
      position.props = {
        ...(position.props || {}),
        displayWidth: width,
        compactCallMosaic: true,
        skipHorizontalCompaction: true,
      };
      position.trace = [
        ...(position.trace || []),
        makeTraceStep('alignSingleExpandedArgumentMosaic', {
          owner: opening.key,
          role: callMosaicRole(node),
          placedX: position.x,
          placedY: position.y,
          reason: 'sole expanded argument uses two seams while preserving its nested subgraph',
        }),
      ];
    }
  }

  const splitCallClosureNodes = [...nodes, ...visualNodes]
    .filter((node) => (
      callBoundaryRole(node) === 'close'
      || node.props?.splitCallBoundary === 'end'
      || isCollectionArgumentClosureNode(node)
    ));
  const argumentCountByOpening = new Map();
  for (const edge of edges.filter((candidate) => candidate.type === 'ARG')) {
    argumentCountByOpening.set(edge.start, (argumentCountByOpening.get(edge.start) || 0) + 1);
  }
  for (const closure of splitCallClosureNodes) {
    const openingKey = String(closure.props?.sourceCallStableId || '');
    const opening = nodeByKey.get(openingKey);
    const openingPosition = positions.get(openingKey);
    const closurePosition = positions.get(closure.key);
    if (!openingPosition || !closurePosition) continue;
    const mountedToObjectBrace = nodes.some((node) => (
      isObjectBraceNode(node)
      && objectBraceSide(node) === 'right'
      && (
        node.props?.objectBraceMosaicNeighborStableId
        || node.props?.object_brace_mosaic_neighbor_stable_id
      ) === closure.key
    ));
    closurePosition.y = resolvedArgumentFamilyAxisY(
      opening,
      openingPosition.y,
      argumentCountByOpening.get(openingKey) || 0,
    );
    closurePosition.props = {
      ...(closurePosition.props || {}),
      displayOffsetX: mountedToObjectBrace
        ? 0
        : Number(closurePosition.props?.displayOffsetX || 0) + CALL_CLOSING_JOIN_GAP,
    };
    closurePosition.trace = [
      ...(Array.isArray(closurePosition.trace) ? closurePosition.trace : []),
      makeTraceStep('alignSplitCallClosure', {
        opening: openingKey,
        closing: closure.key,
        alignedY: closurePosition.y,
        reason: 'expanded call closure inherits the active opening tile horizontal axis',
      }),
    ];
  }

  // Method-chain continuations are adjacent mosaic tiles. Their owner is the
  // expanded call closure, positioned after the shared incoming junction.
  for (const continuation of [...nodes, ...visualNodes].filter((node) => isMethodChainContinuation(node))) {
    const ownerKey = methodChainOwnerStableId(continuation);
    const owner = nodeByKey.get(ownerKey);
    const ownerPosition = positions.get(ownerKey);
    const continuationPosition = positions.get(continuation.key);
    if (!owner || !ownerPosition || !continuationPosition) continue;
    const ownerWidth = compactCallMosaicWidth(owner);
    const continuationWidth = compactCallMosaicWidth(continuation);
    continuationPosition.x = ownerPosition.x + (
      CALL_CLOSING_JOIN_GAP
      + ownerWidth / 2
      + continuationWidth / 2
    ) / DRAWIO_GRID_X;
    continuationPosition.y = ownerPosition.y;
    continuationPosition.props = {
      ...(continuationPosition.props || {}),
      displayWidth: continuationWidth,
      skipHorizontalCompaction: true,
    };
    continuationPosition.trace = [
      ...(Array.isArray(continuationPosition.trace) ? continuationPosition.trace : []),
      makeTraceStep('alignMethodChainContinuation', {
        owner: ownerKey,
        continuation: continuation.key,
        placedX: continuationPosition.x,
        placedY: continuationPosition.y,
        reason: 'method-chain continuation touches the effective right edge of the expanded call closure',
      }),
    ];
  }

  const splitCallStartIds = new Set(
    splitCallClosureNodes
      .map((node) => node.props?.sourceCallStableId)
      .filter(Boolean),
  );
  const expandedExpressionIds = new Set(
    edges
      .filter((edge) => ['ARG', 'FIELD', 'EVAL'].includes(edge.type))
      .map((edge) => edge.start),
  );
  const positionedNodes = [...nodes, ...visualNodes]
    .filter((node) => positions.has(node.key))
    .map((node) => {
      const pos = positions.get(node.key);
      return {
        id: node.key,
        labels: node.labels || [],
        props: {
          ...node.props,
          ...(pos.props || {}),
          ...splitCallRenderProps(node),
          ...(isCollectionArgumentClosureNode(node) ? { splitCallBoundary: 'end' } : {}),
          ...(splitCallStartIds.has(node.key) && callBoundaryDesign(node) !== 'column'
            ? { splitCallBoundary: 'start' }
            : {}),
          ...(expandedExpressionIds.has(node.key) ? { visualExpandedExpression: true } : {}),
          ...(isBracketLayoutNode(node) ? { displayOffsetX: bracketDisplayOffsetX(node) } : {}),
          ...(Array.isArray(pos.fanoutOwnerKeys) && pos.fanoutOwnerKeys.length
            ? { layoutFamilyOwnerKeys: [...pos.fanoutOwnerKeys] }
            : {}),
          ...(Number.isFinite(pos.fanoutFamilyMinY) ? { layoutFamilyMinY: pos.fanoutFamilyMinY } : {}),
          ...(Number.isFinite(pos.fanoutFamilyMaxY) ? { layoutFamilyMaxY: pos.fanoutFamilyMaxY } : {}),
          displayX: pos.x,
          displayY: pos.y,
          layoutTrace: traceToText(pos.trace) || pos.reason,
        },
      };
    });

  // Operand edges can be discovered before their enclosing callback is
  // coordinated. Apply the completed callback contract before pathfinding so
  // every predicate outcome uses the same horizontal-frame ports.
  for (const edge of renderEdges) {
    const outcomePlacement = callbackOutcomePlacementByKey.get(edge.end);
    if (!outcomePlacement || !['TRUE', 'FALSE'].includes(edge.type)) continue;
    const outcome = nodeByKey.get(edge.end);
    const sourcePort = hasLabel(outcome, 'TruthyOutcome') ? 'top' : 'bottom';
    edge.props = {
      ...edge.props,
      sourcePort,
      targetPort: 'left',
      sourcePortCandidates: [sourcePort],
      targetPortCandidates: ['left'],
      lockPortCandidates: true,
    };
  }

  const positionedNodeIds = new Set(positionedNodes.map((node) => node.id));
  const visiblePositionedEdges = renderEdges.filter((edge) => (
    !isHiddenRenderEdge(edge)
    && edge.type !== 'INVOKES'
    && positionedNodeIds.has(edge.start)
    && positionedNodeIds.has(edge.end)
  ));
  const visiblePositionedEdgeKeys = new Set(visiblePositionedEdges.map(edgeRenderKey));
  const hiddenPositionedEdges = extractedEdges
    .filter((edge) => (
      isHiddenRenderEdge(edge)
      && positionedNodeIds.has(edge.start)
      && positionedNodeIds.has(edge.end)
      && !visiblePositionedEdgeKeys.has(edgeRenderKey(edge))
    ))
    .map((edge) => ({
      ...edge,
      props: {
        ...(edge.props || {}),
        renderHidden: true,
      },
    }));
  return {
    nodes: positionedNodes,
    // Mosaic seams hide graph relations visually; they do not delete them
    // from the coordinate model or ask projection to recreate them.
    edges: [...visiblePositionedEdges, ...hiddenPositionedEdges],
    positioned: positions.size,
  };
}

function includeExtractedSubmethodGraph({
  coordinateGraph,
  semanticNodes,
  semanticEdges,
  visibleEdges,
  graphRootStableId,
}) {
  const semanticById = new Map(semanticNodes.map((node) => [node.key, node]));
  coordinateGraph.nodes = coordinateGraph.nodes.map((rendered) => {
    const semantic = semanticById.get(rendered.id);
    if (!semantic) return rendered;
    return {
      ...rendered,
      labels: [...new Set([...(semantic.labels || []), ...(rendered.labels || [])])],
      props: {
        ...(semantic.props || {}),
        ...splitCallRenderProps(semantic),
        ...(rendered.props || {}),
      },
    };
  });
  const includedIds = new Set(coordinateGraph.nodes.map((node) => node.id));
  const requiredIds = new Set();
  const includedObjectFamilyIds = new Set(semanticNodes
    .filter((node) => isObjectBraceNode(node) && includedIds.has(node.key))
    .map((node) => objectBraceFamilyStableId(node))
    .filter(Boolean));
  for (const brace of semanticNodes) {
    const familyStableId = objectBraceFamilyStableId(brace);
    if (familyStableId && includedObjectFamilyIds.has(familyStableId)) {
      requiredIds.add(brace.key);
    }
    if (!isObjectBraceNode(brace) || !includedObjectFamilyIds.has(familyStableId)) continue;
    const neighborStableId = brace.props?.objectBraceMosaicNeighborStableId
      || brace.props?.object_brace_mosaic_neighbor_stable_id;
    if (neighborStableId && semanticById.has(String(neighborStableId))) {
      requiredIds.add(String(neighborStableId));
    }
  }
  for (const root of semanticNodes) {
    let submethods = [];
    try {
      submethods = JSON.parse(String(root.props?.submethodsJson || root.props?.submethods_json || '[]'));
    } catch {
      submethods = [];
    }
    if (!Array.isArray(submethods) || !submethods.length) continue;
    requiredIds.add(root.key);
    for (const submethod of submethods) {
      for (const stableId of [
        submethod.stableId,
        submethod.headerStableId,
        ...(Array.isArray(submethod.memberStableIds) ? submethod.memberStableIds : []),
        ...(Array.isArray(submethod.attachments)
          ? submethod.attachments.map((attachment) => attachment?.stableId)
          : []),
      ]) {
        if (stableId && semanticById.has(String(stableId))) requiredIds.add(String(stableId));
      }
    }
  }
  for (const edge of semanticEdges) {
    if (edge.type !== 'ASSIGNS_VALUE' || !includedIds.has(edge.end)) continue;
    const source = semanticById.get(edge.start);
    if (source && (source.labels || []).includes('FnVisualProxy')) requiredIds.add(source.key);
  }
  const positionedByStep = new Map();
  for (const rendered of coordinateGraph.nodes) {
    const semantic = semanticById.get(rendered.id);
    const stepStableId = semantic?.props?.parentStepStableId
      || semantic?.props?.parent_step_stable_id
      || rendered.props?.parentStepStableId
      || rendered.props?.parent_step_stable_id;
    if (stepStableId && !positionedByStep.has(stepStableId)) positionedByStep.set(stepStableId, rendered);
  }
  const rootAnchor = coordinateGraph.nodes.find((node) => node.id === graphRootStableId)
    || coordinateGraph.nodes[0];
  const augmentedIds = new Set();
  for (const stableId of requiredIds) {
    if (includedIds.has(stableId)) continue;
    const semantic = semanticById.get(stableId);
    if (!semantic) continue;
    const stepStableId = semantic.props?.parentStepStableId || semantic.props?.parent_step_stable_id;
    const anchor = positionedByStep.get(stepStableId) || rootAnchor;
    coordinateGraph.nodes.push({
      id: semantic.key,
      labels: [...(semantic.labels || [])],
      props: {
        ...(semantic.props || {}),
        ...splitCallRenderProps(semantic),
        displayX: Number(anchor?.props?.displayX || 0),
        displayY: Number(anchor?.props?.displayY || 0),
        layoutTrace: 'extracted submethod member admitted before hierarchy positioning',
      },
    });
    includedIds.add(stableId);
    augmentedIds.add(stableId);
  }

  const edgeKeys = new Set(coordinateGraph.edges.map((edge) => (
    `${edge.start}\u0000${edge.type}\u0000${edge.end}\u0000${edge.props?.producerOutcome || edge.props?.producer_outcome || ''}`
  )));
  const edgeCandidates = [
    ...visibleEdges,
    ...semanticEdges.filter((edge) => (
      edge.type === 'ARG'
      || Boolean(
        edge.props?.optionalReturnGroupStableId
        || edge.props?.optional_return_group_stable_id,
      )
      || (edge.type === 'ASSIGNS_VALUE' && augmentedIds.has(edge.start))
      || requiredIds.has(edge.start)
      || requiredIds.has(edge.end)
    )),
  ];
  for (const edge of edgeCandidates) {
    if (!includedIds.has(edge.start) || !includedIds.has(edge.end)) continue;
    const source = semanticById.get(edge.start);
    const target = semanticById.get(edge.end);
    const sourceBraceNeighbor = source?.props?.objectBraceMosaicNeighborStableId
      || source?.props?.object_brace_mosaic_neighbor_stable_id;
    const targetBraceNeighbor = target?.props?.objectBraceMosaicNeighborStableId
      || target?.props?.object_brace_mosaic_neighbor_stable_id;
    const sourceBraceSide = source?.props?.objectBraceSide || source?.props?.object_brace_side;
    const targetBraceSide = target?.props?.objectBraceSide || target?.props?.object_brace_side;
    const objectBraceMosaicSeam = (
      (
        edge.type === 'MATERIALIZES_ARGUMENT'
        && isObjectBraceNode(target)
        && targetBraceSide === 'left'
      )
    ) || (
      (edge.type === 'ARG' || edge.type === 'EVAL')
      && isObjectBraceNode(target)
      && targetBraceSide === 'left'
      && targetBraceNeighbor === edge.start
    ) || (
      edge.type === 'ArgJoin'
      && isObjectBraceNode(source)
      && sourceBraceSide === 'right'
      && sourceBraceNeighbor === edge.end
    );
    if (objectBraceMosaicSeam) continue;
    const extractedOptionalReturn = Boolean(
      edge.props?.optionalReturnGroupStableId
      || edge.props?.optional_return_group_stable_id,
    );
    if (
      edge.type !== 'ARG'
      && !extractedOptionalReturn
      && !augmentedIds.has(edge.start)
      && !augmentedIds.has(edge.end)
      && !requiredIds.has(edge.start)
      && !requiredIds.has(edge.end)
    ) continue;
    if (edge.type === 'INVOKES') continue;
    if (
      edge.props?.renderHidden === true
      || edge.props?.render_hidden === true
      || edge.props?.contextOnly === true
      || edge.props?.context_only === true
    ) continue;
    const key = `${edge.start}\u0000${edge.type}\u0000${edge.end}\u0000${edge.props?.producerOutcome || edge.props?.producer_outcome || ''}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    coordinateGraph.edges.push({ ...edge, props: { ...(edge.props || {}) } });
  }
  for (const edge of semanticEdges) {
    if (!['NEXT', 'ASYNC', 'CATCH'].includes(edge.type)) continue;
    if (!includedIds.has(edge.start) || !includedIds.has(edge.end)) continue;
    const source = semanticById.get(edge.start);
    const target = semanticById.get(edge.end);
    const belongsToSubStep = [source, target].some((node) => (
      (node?.labels || []).some((label) => [
        'SubStep',
        'SubStepMember',
        'SubStepAttachment',
      ].includes(label))
    ));
    if (!belongsToSubStep) continue;
    if (
      edge.props?.renderHidden === true
      || edge.props?.render_hidden === true
      || edge.props?.contextOnly === true
      || edge.props?.context_only === true
    ) continue;
    const key = `${edge.start}\u0000${edge.type}\u0000${edge.end}\u0000${edge.props?.producerOutcome || edge.props?.producer_outcome || ''}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    coordinateGraph.edges.push({ ...edge, props: { ...(edge.props || {}) } });
  }
  return coordinateGraph;
}

async function main() {
  const args = parseArgs(process.argv);
  const existingAnnotationCells = readExistingAnnotationCells(args.outputPath);
  const outputGeneration = claimOutputGeneration(args.outputPath);
  const config = localNeo4jConfig(args.aura);
  const driver = neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password));
  const startedAt = Date.now();
  try {
    await verifyLocalNeo4jConnectivity(driver, config);
    const stepScope = args.stepStableId
      ? await resolveStepScope(driver, config.database, args.stepStableId)
      : null;
    if (args.stepStableId && args.localFunctionStableId) {
      throw new Error('--step-stable-id and --local-function-stable-id cannot be used together.');
    }
    const implicitLocalFunctionScope = !args.stepStableId && !args.localFunctionStableId
      ? await resolveImplicitLocalFunctionScope(driver, config.database, args.fnStableId)
      : null;
    const localFunctionStableId = args.localFunctionStableId
      || implicitLocalFunctionScope?.localFunctionStableId;
    const localFunctionRootProxyStableId = implicitLocalFunctionScope?.proxyStableId
      || (localFunctionStableId ? localFunctionProxyStableId(localFunctionStableId) : null);
    const fnStableId = stepScope?.fnStableId
      || implicitLocalFunctionScope?.parentFnStableId
      || args.fnStableId;
    let graphRootStableId = localFunctionStableId
      ? localFunctionRootProxyStableId
      : stepScope?.headStableIds[0] || fnStableId;
    const loadedGraph = await loadFunctionDiagramSubgraph(
      driver,
      config.database,
      fnStableId,
    );
    let nodes = loadedGraph.nodes.map((node) => {
      const ownerStepStableId = node.props?.ownerStepStableId
        || node.props?.owner_step_stable_id
        || node.props?.parentStepStableId
        || node.props?.parent_step_stable_id;
      if (!ownerStepStableId) return node;
      return {
        ...node,
        props: {
          ...(node.props || {}),
          ownerStepStableId,
        },
      };
    });
    let edges = loadedGraph.edges;
    let semanticEdges = loadedGraph.semanticEdges || loadedGraph.edges;
    if (!nodes.length) throw new Error(`No local nodes found for ${fnStableId}`);
    if (!args.stepStableId && !localFunctionStableId) {
      const parentScope = filterLocalFunctionBodiesFromParent(
        nodes,
        semanticEdges,
        fnStableId,
        implicitLocalFunctionScope?.directDeclarationStableId,
      );
      nodes = parentScope.nodes;
      semanticEdges = parentScope.edges;
      const retainedIds = new Set(nodes.map((node) => node.key));
      edges = edges.filter((edge) => retainedIds.has(edge.start) && retainedIds.has(edge.end));
    }
    if (!args.stepStableId && !localFunctionStableId) {
      const functionStart = nodes.find((node) => (
        node.labels.includes('FunctionStart')
        && String(node.props?.parentFnStableId || node.props?.parent_fn_stable_id || '') === fnStableId
        && !node.props?.parentLocalFunctionStableId
        && !node.props?.parent_local_function_stable_id
      ));
      if (functionStart) {
        graphRootStableId = functionStart.key;
        nodes = nodes.filter((node) => node.key !== fnStableId);
        const retainedIds = new Set(nodes.map((node) => node.key));
        edges = edges.filter((edge) => retainedIds.has(edge.start) && retainedIds.has(edge.end));
        semanticEdges = semanticEdges.filter((edge) => (
          retainedIds.has(edge.start) && retainedIds.has(edge.end)
        ));
      }
    }
    if (args.stepStableId || localFunctionStableId) {
      const scoped = localFunctionStableId
        ? filterGraphToLocalFunction(
            nodes,
            semanticEdges,
            localFunctionStableId,
            localFunctionRootProxyStableId,
          )
        : filterGraphToStep(nodes, semanticEdges, args.stepStableId);
      nodes = scoped.nodes;
      semanticEdges = scoped.edges;
      if (localFunctionStableId) graphRootStableId = scoped.rootProxyStableId;
      const scopedNodeIds = new Set(nodes.map((node) => node.key));
      const scopedCoordinateEdges = edges.filter((edge) => (
        scopedNodeIds.has(edge.start) && scopedNodeIds.has(edge.end)
      ));
      const boundaryEdges = args.stepStableId
        ? scoped.edges.filter((edge) => edge.props?.stepBoundaryTargetStableId)
        : [];
      edges = [...scopedCoordinateEdges, ...boundaryEdges];
      if (!nodes.some((node) => node.key === graphRootStableId)) {
        throw new Error(`Graph head is missing from its rendered scope: ${graphRootStableId}`);
      }
    }

    nodes = annotateCallCopyCounts(nodes, edges);

    const loadFinishedAt = Date.now();
    const semanticNodes = nodes.map((node) => ({ ...node, labels: [...(node.labels || [])], props: { ...(node.props || {}) } }));
    const semanticEdgeSnapshot = semanticEdges
      .map((edge) => ({ ...edge, props: { ...(edge.props || {}) } }));
    console.error(`[flow-render] loaded nodes=${nodes.length} edges=${edges.length} ms=${loadFinishedAt - startedAt}`);
    const coordinateNodes = nodes;
    const coordinateNodeIds = new Set(coordinateNodes.map((node) => node.key));
    const projectedVisibleEdges = args.projection === 'hybrid'
      ? projectHybridCoordinateEdges({
          nodes,
          edges,
          semanticEdges: semanticEdgeSnapshot,
        })
      : edges;
    const rendererTraversalEdges = projectedVisibleEdges.filter((edge) => (
      isFunctionFlowTraversalRelationship(edge.type)
    ));
    const coordinateEdges = rendererTraversalEdges.filter((edge) => (
      coordinateNodeIds.has(edge.start)
      && coordinateNodeIds.has(edge.end)
      && edge.props?.contextOnly !== true
      && edge.props?.context_only !== true
      && edge.props?.renderHidden !== true
      && edge.props?.render_hidden !== true
    ));
    const coordinateGraph = newStraightDrawio(coordinateNodes, coordinateEdges, graphRootStableId, {
      expandLocalFunctionProxy: Boolean(localFunctionStableId),
    });
    if (args.projection === 'hybrid') {
      includeExtractedSubmethodGraph({
        coordinateGraph,
        semanticNodes,
        semanticEdges: semanticEdgeSnapshot,
        visibleEdges: rendererTraversalEdges,
        graphRootStableId,
      });
    }
    console.error(`[flow-render] coordinated nodes=${coordinateGraph.nodes.length} edges=${coordinateGraph.edges.length} ms=${Date.now() - loadFinishedAt}`);
    const projectedDrawioGraph = args.projection === 'hybrid'
      ? projectHybridFlowGraph({
          drawioGraph: coordinateGraph,
          semanticNodes,
          semanticEdges: semanticEdgeSnapshot,
        })
      : coordinateGraph;
    const drawioGraph = {
      ...projectedDrawioGraph,
      edges: projectedDrawioGraph.edges.filter((edge) => (
        isFunctionFlowRenderedRelationship(edge)
      )),
    };
    const projectionContractAudit = args.projection === 'hybrid'
      ? auditExtractedProjectionContract({
          semanticNodes,
          semanticEdges: semanticEdgeSnapshot,
          inputGraph: coordinateGraph,
          projectedGraph: drawioGraph,
        })
      : null;
    let projectionContractReport = null;
    if (projectionContractAudit) {
      const informationalProjectionKeys = new Set(['inputCompositionEdgesHiddenByPolicy']);
      const findingCount = Object.entries(projectionContractAudit)
        .filter(([key]) => !informationalProjectionKeys.has(key))
        .map(([, findings]) => findings)
        .reduce((sum, findings) => sum + findings.length, 0);
      const projectionContractOutputPath = args.outputPath.replace(/\.drawio$/iu, '.projection-contract.json');
      projectionContractReport = {
        outputPath: projectionContractOutputPath,
        text: `${JSON.stringify({
        generatedAt: new Date().toISOString(),
        fnStableId,
        ...projectionContractAudit,
        }, null, 2)}\n`,
      };
      console.error(`[flow-render] extraction-contract findings=${findingCount} ${JSON.stringify(Object.fromEntries(
        Object.entries(projectionContractAudit).map(([key, findings]) => [key, findings.length]),
      ))} report=${projectionContractOutputPath}`);
    }
    console.error(`[flow-render] projected nodes=${drawioGraph.nodes.length} edges=${drawioGraph.edges.length} protocols=${drawioGraph.hybridProjection?.protocolCount || 0}`);
    const coordinateFinishedAt = Date.now();
    let autoChecks = runAutoChecks({
      nodes: drawioGraph.nodes,
      edges: drawioGraph.edges,
      semanticNodes,
      semanticEdges: semanticEdgeSnapshot,
      fnStableId,
    });
    console.error(`[flow-render] checked checks=${autoChecks.length} findings=${autoChecks.reduce((sum, check) => sum + check.findingCount, 0)}`);
    const suppressFoldingContainers = Boolean(
      args.projection === 'hybrid'
      && args.stepStableId
      && drawioGraph.hybridProjection?.protocolCount,
    );
    const disableFoldingMechanics = true;
    const serializeUnifiedEdges = true;
    const diagramName = path.basename(args.outputPath, path.extname(args.outputPath));
    const diagramId = diagramName.replace(/[^A-Za-z0-9_.-]+/g, '-').toLowerCase();
    let drawio = makeDrawio(drawioGraph.nodes, drawioGraph.edges, {
      autoChecks,
      semanticNodes,
      semanticEdges: semanticEdgeSnapshot,
      suppressFoldingContainers,
      disableFoldingMechanics,
      serializeUnifiedEdges,
      diagramId,
      diagramName,
    });
    drawio = mergeAnnotationCells(drawio, existingAnnotationCells);
    console.error(`[flow-render] serialized bytes=${Buffer.byteLength(drawio, 'utf8')}`);
    if (!suppressFoldingContainers && !serializeUnifiedEdges) {
      autoChecks.push(runSerializedFoldingGeometryCheck(drawio));
    }
    const autoCheckSummary = {
      total: autoChecks.length,
      failed: autoChecks.filter((check) => check.status === 'fail').length,
      findings: autoChecks.reduce((sum, check) => sum + check.findingCount, 0),
    };
    if (!ownsOutputGeneration(args.outputPath, outputGeneration)) {
      console.log(JSON.stringify({
        ok: true,
        superseded: true,
        outputPath: args.outputPath,
        fnStableId,
        elapsedMs: Date.now() - startedAt,
      }, null, 2));
      return;
    }
    if (projectionContractReport) {
      writeTextAtomically(projectionContractReport.outputPath, projectionContractReport.text);
    }
    writeAutoCheckReport(args.checksOutputPath, {
      generatedAt: new Date().toISOString(),
      fnStableId,
      localFunctionStableId: localFunctionStableId || null,
      stepStableId: args.stepStableId || null,
      outputPath: args.outputPath,
      checks: autoChecks,
    });
    const routeFinishedAt = Date.now();

    if (!ownsOutputGeneration(args.outputPath, outputGeneration)) return;
    writeTextAtomically(args.outputPath, drawio);
    console.log(JSON.stringify({
      ok: true,
      outputPath: args.outputPath,
      fnStableId,
      stepStableId: args.stepStableId || null,
      graphRootStableId,
      loadedNodes: nodes.length,
      loadedEdges: edges.length,
      drawioNodes: drawioGraph.nodes.length,
      drawioEdges: drawioGraph.edges.length,
      visualProxies: drawioGraph.nodes.filter((node) => node.labels?.includes('VisualProxy') || node.labels?.includes('ResourceProxy')).length,
      positioned: drawioGraph.positioned,
      renderer: 'newStraightDrawio',
      projection: args.projection,
      hybridProtocols: drawioGraph.hybridProjection?.protocolCount || 0,
      foldingContainers: suppressFoldingContainers ? 'suppressed' : 'rendered',
      foldingMechanics: disableFoldingMechanics ? 'disabled' : 'enabled',
      edgeSerialization: serializeUnifiedEdges ? 'unified' : 'fold-boundary-segments',
      autoChecks: autoCheckSummary,
      autoChecksOutputPath: args.checksOutputPath,
      loadMs: loadFinishedAt - startedAt,
      coordinateMs: coordinateFinishedAt - loadFinishedAt,
      routeMs: routeFinishedAt - coordinateFinishedAt,
      elapsedMs: Date.now() - startedAt,
    }, null, 2));
  } finally {
    await driver.close();
    releaseOutputGeneration(args.outputPath, outputGeneration);
  }
}

await main();
