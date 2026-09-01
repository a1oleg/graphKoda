import fs from 'node:fs';
import path from 'node:path';
import neo4j from 'neo4j-driver';

const DEFAULT_OUTPUT = 'tmp/graph-vscode-cache/local-function-sequence.drawio';
const DEFAULT_FN_STABLE_ID = 'screens/REPL.tsx:3142:31:3533:3';
const MAX_EVENTS = 1500;
const PARTICIPANT_GAP = 230;
const HEADER_Y = 40;
const HEADER_WIDTH = 170;
const HEADER_HEIGHT = 54;
const FIRST_EVENT_Y = 130;
const EVENT_GAP = 52;

const SEQUENCE_EDGE_TYPES = [
  'CALL',
  'REQUEST',
  'READ',
  'WRITE',
  'DECLARES_FUNCTION',
  'DETACHES_ASYNC',
  'AWAITS_ASYNC',
  'INJECTS_UI',
  'CREATE',
  'UPDATE',
  'CLEAR',
  'DELETE',
  'EMIT',
  'WAIT',
  'SUBSCRIBE',
  'SIGNAL',
  'START',
  'CANCEL',
  'ITERATES_VALUE',
  'EXTRACTS_VALUE',
  'PASSES_VALUE',
  'YIELDS_VALUE',
  'ACCUMULATES_VALUE',
  'COMPLETES_VALUE',
  'SHORT_CIRCUITS',
  'REPEATS',
];

const EXECUTION_EDGE_TYPES = new Set(['CALL', 'REQUEST', 'DETACHES_ASYNC', 'AWAITS_ASYNC']);
const RESPONSIBILITY_EDGE_TYPES = new Set(['INJECTS_UI', 'CREATE', 'UPDATE', 'CLEAR', 'DELETE', 'EMIT', 'WAIT', 'SUBSCRIBE', 'SIGNAL', 'START', 'CANCEL']);

function xml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function readEnvFile(envPath) {
  const env = {};
  if (!fs.existsSync(envPath)) return env;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (!/^\s*[^#][^=]*=/.test(line)) continue;
    const separator = line.indexOf('=');
    const key = line.slice(0, separator).trim();
    env[key] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return env;
}

function localNeo4jConfig() {
  const env = readEnvFile(path.resolve(process.cwd(), 'graph', '.env'));
  let uri = env.NEO4J_URI || env.GRAPH_NEO4J_URI || 'neo4j://127.0.0.1:7687';
  uri = uri.replace(/^neo4j:\/\/(localhost|127\.0\.0\.1)/, 'bolt://$1');
  const user = env.NEO4J_USERNAME || env.NEO4J_USER || 'neo4j';
  const password = env.NEO4J_PASSWORD;
  const database = env.NEO4J_DATABASE || env.NEO4J_DB || 'neo4j';
  if (!password) throw new Error('Expected NEO4J_PASSWORD in graph/.env.');
  return { uri, user, password, database };
}

function parseArgs(argv) {
  const result = { outputPath: DEFAULT_OUTPUT, fnStableId: DEFAULT_FN_STABLE_ID };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output') result.outputPath = argv[++index] || result.outputPath;
    else if (arg === '--fn-stable-id') result.fnStableId = argv[++index] || result.fnStableId;
    else if (!arg.startsWith('--')) result.outputPath = arg;
  }
  return result;
}

function stableIdOf(props) {
  return String(props?.stableId || props?.stable_id || '');
}

function conciseText(value, fallback = '') {
  const text = String(value || fallback || '').replace(/\s+/g, ' ').trim();
  return text.length > 72 ? `${text.slice(0, 69)}...` : text;
}

function participantName(node, fallback = '') {
  const props = node?.props || {};
  const labels = node?.labels || [];
  const base = conciseText(
    props.diaName
    || props.name
    || props.resourceName
    || props.resource_name
    || props.settingName
    || props.setting_name
    || props.operation_subject_text
    || props.label
    || fallback
    || stableIdOf(props),
  );
  if (labels.includes('Method') && props.owner_name && !base.startsWith(`${props.owner_name}.`)) {
    return `${props.owner_name}.${base}`;
  }
  return base || labels[0] || 'participant';
}

function participantKind(node = {}) {
  const labels = node.labels || [];
  const axisKind = node.props?.sequence_axis_kind;
  const scopeKind = node.props?.execution_scope_kind;
  if (scopeKind === 'collection-iterator' || axisKind === 'collection-loop' || labels.includes('Iterator')) return 'CollectionLoop';
  if (axisKind === 'iteration' || labels.includes('Iteration')) return 'Iteration';
  if (scopeKind === 'callback' || axisKind === 'callback' || labels.includes('CallbackParams')) return 'Callback';
  if (labels.includes('Fn')) return 'Fn';
  if (labels.includes('Method')) return 'Method';
  if (labels.includes('CallbackFn') || labels.includes('UpdaterFn')) return 'Callback';
  if (labels.includes('FunctionProxy') || labels.includes('LocalFunctionProxy')) return 'FunctionProxy';
  if (labels.includes('UiSurface') || labels.includes('VirtualView') || labels.includes('UiInjection')) return 'UI';
  if (node.props?.resource_kind || labels.includes('Storage') || labels.includes('Cell')) return 'Storage';
  return labels[0] || 'Abstraction';
}

function semanticParticipantKey(node) {
  const props = node?.props || {};
  const stableId = stableIdOf(props);
  if (props.execution_scope_kind || props.sequence_axis_kind) return stableId;
  if (props.collection_iteration_stable_id) return String(props.collection_iteration_stable_id);
  if (props.collection_loop_stable_id) return String(props.collection_loop_stable_id);
  return stableId;
}

function functionStableIdForTarget(target) {
  const props = target?.props || {};
  const labels = target?.labels || [];
  if (labels.includes('Fn') || labels.includes('Method')) return stableIdOf(props);
  if (labels.includes('FunctionProxy') || labels.includes('LocalFunctionProxy')) return String(props.calleeStableId || '');
  return '';
}

async function loadFunction(session, stableId, cache) {
  if (cache.has(stableId)) return cache.get(stableId);
  const result = await session.run(`
    MATCH (fn)
    WHERE (fn.stableId = $stableId OR fn.stable_id = $stableId)
      AND (fn:Fn OR fn:Method)
    RETURN labels(fn) AS nodeLabels, properties(fn) AS props
    LIMIT 1
  `, { stableId });
  const node = result.records.length
    ? { labels: result.records[0].get('nodeLabels'), props: result.records[0].get('props') }
    : null;
  cache.set(stableId, node);
  return node;
}

async function loadFunctionEvents(session, stableId, cache) {
  if (cache.has(stableId)) return cache.get(stableId);
  const result = await session.run(`
    MATCH (source)-[rel]->(target)
    WHERE source.parentFnStableId = $stableId
      AND type(rel) IN $edgeTypes
    RETURN
      labels(source) AS sourceLabels,
      properties(source) AS sourceProps,
      type(rel) AS relType,
      properties(rel) AS relProps,
      labels(target) AS targetLabels,
      properties(target) AS targetProps
    ORDER BY
      coalesce(source.start_line, source.startLine, 0),
      coalesce(source.start_column, source.startColumn, 0),
      coalesce(source.operation_index, source.operationIndex, 0),
      type(rel),
      coalesce(target.stableId, target.stable_id, '')
  `, { stableId, edgeTypes: SEQUENCE_EDGE_TYPES });

  const callbacks = await session.run(`
    MATCH (source)-[:ARG]->(callback:CallbackFn)
    WHERE source.parentFnStableId = $stableId
    RETURN coalesce(source.stableId, source.stable_id) AS sourceStableId,
      labels(callback) AS callbackLabels,
      properties(callback) AS callbackProps
    ORDER BY coalesce(callback.start_line, callback.startLine, 0), coalesce(callback.start_column, callback.startColumn, 0)
  `, { stableId });
  const accessorEvents = await session.run(`
    MATCH (source)-[invoke:READ|WRITE]->(accessor:Fn)-[access:READ|WRITE]->(cell:Cell)
    WHERE source.parentFnStableId = $stableId
      AND ((accessor:Getter AND type(invoke) = 'READ' AND type(access) = 'READ')
        OR (accessor:Setter AND type(invoke) = 'WRITE' AND type(access) = 'WRITE'))
      AND cell.stableId IN coalesce(invoke.storage_stable_ids, [])
    RETURN
      labels(source) AS sourceLabels,
      properties(source) AS sourceProps,
      type(invoke) AS relType,
      properties(invoke) AS relProps,
      labels(cell) AS targetLabels,
      properties(cell) AS targetProps
    ORDER BY
      coalesce(source.start_line, source.startLine, 0),
      coalesce(source.start_column, source.startColumn, 0),
      type(invoke),
      coalesce(cell.stableId, '')
  `, { stableId });
  const callbacksBySource = new Map();
  for (const record of callbacks.records) {
    const sourceId = String(record.get('sourceStableId') || '');
    if (!sourceId) continue;
    if (!callbacksBySource.has(sourceId)) callbacksBySource.set(sourceId, []);
    callbacksBySource.get(sourceId).push({
      labels: record.get('callbackLabels'),
      props: record.get('callbackProps'),
    });
  }

  const events = result.records
    .map((record) => {
    const source = { labels: record.get('sourceLabels'), props: record.get('sourceProps') };
    return {
      source,
      type: record.get('relType'),
      props: record.get('relProps'),
      target: { labels: record.get('targetLabels'), props: record.get('targetProps') },
      callbacks: callbacksBySource.get(stableIdOf(source.props)) || [],
    };
    })
    .filter((event) => !(
      (event.type === 'READ' && event.target.labels.includes('Getter'))
      || (event.type === 'WRITE' && event.target.labels.includes('Setter'))
    ));
  for (const record of accessorEvents.records) {
    const source = { labels: record.get('sourceLabels'), props: record.get('sourceProps') };
    events.push({
      source,
      type: record.get('relType'),
      props: record.get('relProps'),
      target: { labels: record.get('targetLabels'), props: record.get('targetProps') },
      callbacks: [],
    });
  }
  cache.set(stableId, events);
  return events;
}

async function preloadSequenceGraph(session, rootStableId, functionCache, eventCache) {
  const discovered = new Set();
  let frontier = [rootStableId];
  let loadedEventRows = 0;

  while (frontier.length && discovered.size < MAX_EVENTS && loadedEventRows < MAX_EVENTS) {
    const batch = frontier.filter((stableId) => !discovered.has(stableId));
    frontier = [];
    if (!batch.length) break;
    batch.forEach((stableId) => discovered.add(stableId));

    const functions = await session.run(`
      MATCH (fn)
      WHERE coalesce(fn.stableId, fn.stable_id) IN $stableIds
        AND (fn:Fn OR fn:Method)
      RETURN coalesce(fn.stableId, fn.stable_id) AS stableId,
        labels(fn) AS nodeLabels,
        properties(fn) AS props
    `, { stableIds: batch });
    for (const record of functions.records) {
      functionCache.set(String(record.get('stableId')), {
        labels: record.get('nodeLabels'),
        props: record.get('props'),
      });
    }
    batch.forEach((stableId) => {
      if (!functionCache.has(stableId)) functionCache.set(stableId, null);
      eventCache.set(stableId, []);
    });

    const callbacks = await session.run(`
      MATCH (source)-[:ARG]->(callback:CallbackFn)
      WHERE source.parentFnStableId IN $stableIds
      RETURN source.parentFnStableId AS parentFnStableId,
        coalesce(source.stableId, source.stable_id) AS sourceStableId,
        labels(callback) AS callbackLabels,
        properties(callback) AS callbackProps
      ORDER BY coalesce(callback.start_line, callback.startLine, 0), coalesce(callback.start_column, callback.startColumn, 0)
    `, { stableIds: batch });
    const callbacksBySource = new Map();
    for (const record of callbacks.records) {
      const key = `${record.get('parentFnStableId')}\n${record.get('sourceStableId')}`;
      if (!callbacksBySource.has(key)) callbacksBySource.set(key, []);
      callbacksBySource.get(key).push({
        labels: record.get('callbackLabels'),
        props: record.get('callbackProps'),
      });
    }

    const result = await session.run(`
      MATCH (source)-[rel]->(target)
      WHERE source.parentFnStableId IN $stableIds
        AND type(rel) IN $edgeTypes
      RETURN
        source.parentFnStableId AS parentFnStableId,
        labels(source) AS sourceLabels,
        properties(source) AS sourceProps,
        type(rel) AS relType,
        properties(rel) AS relProps,
        labels(target) AS targetLabels,
        properties(target) AS targetProps
      ORDER BY
        source.parentFnStableId,
        coalesce(source.start_line, source.startLine, 0),
        coalesce(source.start_column, source.startColumn, 0),
        coalesce(source.operation_index, source.operationIndex, 0),
        type(rel),
        coalesce(target.stableId, target.stable_id, '')
    `, { stableIds: batch, edgeTypes: SEQUENCE_EDGE_TYPES });
    loadedEventRows += result.records.length;

    for (const record of result.records) {
      const parentFnStableId = String(record.get('parentFnStableId'));
      const source = { labels: record.get('sourceLabels'), props: record.get('sourceProps') };
      const event = {
        source,
        type: record.get('relType'),
        props: record.get('relProps'),
        target: { labels: record.get('targetLabels'), props: record.get('targetProps') },
        callbacks: callbacksBySource.get(`${parentFnStableId}\n${stableIdOf(source.props)}`) || [],
      };
      if ((event.type === 'READ' && event.target.labels.includes('Getter'))
        || (event.type === 'WRITE' && event.target.labels.includes('Setter'))) continue;
      eventCache.get(parentFnStableId).push(event);
      const targetFunctionStableId = functionStableIdForTarget(event.target);
      if (
        EXECUTION_EDGE_TYPES.has(event.type)
        && targetFunctionStableId
        && !event.target.labels.includes('External')
        && !discovered.has(targetFunctionStableId)
      ) frontier.push(targetFunctionStableId);
    }

    const accessorResult = await session.run(`
      MATCH (source)-[invoke:READ|WRITE]->(accessor:Fn)-[access:READ|WRITE]->(cell:Cell)
      WHERE source.parentFnStableId IN $stableIds
        AND ((accessor:Getter AND type(invoke) = 'READ' AND type(access) = 'READ')
          OR (accessor:Setter AND type(invoke) = 'WRITE' AND type(access) = 'WRITE'))
        AND cell.stableId IN coalesce(invoke.storage_stable_ids, [])
      RETURN source.parentFnStableId AS parentFnStableId,
        labels(source) AS sourceLabels,
        properties(source) AS sourceProps,
        type(invoke) AS relType,
        properties(invoke) AS relProps,
        labels(cell) AS targetLabels,
        properties(cell) AS targetProps
      ORDER BY source.parentFnStableId,
        coalesce(source.start_line, source.startLine, 0),
        coalesce(source.start_column, source.startColumn, 0),
        type(invoke),
        coalesce(cell.stableId, '')
    `, { stableIds: batch });
    loadedEventRows += accessorResult.records.length;
    for (const record of accessorResult.records) {
      const parentFnStableId = String(record.get('parentFnStableId'));
      eventCache.get(parentFnStableId).push({
        source: { labels: record.get('sourceLabels'), props: record.get('sourceProps') },
        type: record.get('relType'),
        props: record.get('relProps'),
        target: { labels: record.get('targetLabels'), props: record.get('targetProps') },
        callbacks: [],
      });
    }
    frontier = [...new Set(frontier)];
  }
}

function buildSequenceModel(session, rootStableId) {
  const participants = new Map();
  const messages = [];
  const functionCache = new Map();
  const eventCache = new Map();
  const expandedFunctions = new Set();

  function addParticipant(key, node, options = {}) {
    const stableId = String(key || stableIdOf(node?.props) || `participant-${participants.size + 1}`);
    if (!participants.has(stableId)) {
      const functionStableId = options.functionStableId ?? functionStableIdForTarget(node);
      participants.set(stableId, {
        key: stableId,
        stableId: options.canonicalStableId || stableIdOf(node?.props) || stableId,
        functionStableId,
        label: options.label || participantName(node, stableId),
        kind: options.kind || participantKind(node),
        labels: node?.labels || [],
      });
    }
    return participants.get(stableId);
  }

  function addMessage(from, to, type, label, sourceStableId = '', targetStableId = '', contract = {}) {
    if (!from || !to || messages.length >= MAX_EVENTS) return;
    messages.push({
      from: from.key,
      to: to.key,
      type,
      label: conciseText(label, type),
      sourceStableId,
      targetStableId,
      invocationMode: contract.invocationMode || '',
      responseMode: contract.responseMode || '',
    });
  }

  async function expandFunction(functionStableId, callerParticipant, stack = []) {
    if (messages.length >= MAX_EVENTS) return;
    const fn = await loadFunction(session, functionStableId, functionCache);
    if (!fn) return;
    const fnParticipant = addParticipant(functionStableId, fn, { functionStableId });
    if (expandedFunctions.has(functionStableId)) return fnParticipant;
    expandedFunctions.add(functionStableId);
    const events = await loadFunctionEvents(session, functionStableId, eventCache);
    const deferredExpansions = [];

    for (const event of events) {
      if (messages.length >= MAX_EVENTS) break;
      const targetFunctionStableId = functionStableIdForTarget(event.target);
      const targetStableId = stableIdOf(event.target.props) || targetFunctionStableId;
      const semanticExpansion = event.props?.semantic_expansion === 'collection-iteration';
      const targetKey = semanticExpansion
        ? semanticParticipantKey(event.target)
        : targetFunctionStableId || targetStableId;
      if (!targetKey) continue;
      const targetParticipant = addParticipant(targetKey, event.target, {
        functionStableId: targetFunctionStableId,
        canonicalStableId: targetStableId,
      });
      const sourceStableId = stableIdOf(event.source.props);
      const sourceKey = semanticExpansion ? semanticParticipantKey(event.source) : '';
      const sourceParticipant = sourceKey
        ? addParticipant(sourceKey, event.source, { canonicalStableId: sourceStableId })
        : fnParticipant;
      const sourceLabel = event.source.props?.diaName || event.source.props?.action_text_raw || event.source.props?.label;
      const messageLabel = semanticExpansion
        ? event.props?.label || event.type.toLowerCase().replaceAll('_', ' ')
        : event.type === 'DECLARES_FUNCTION'
        ? `declare ${targetParticipant.label}`
        : event.type === 'DETACHES_ASYNC'
          ? `detach ${targetParticipant.label}`
          : event.type === 'AWAITS_ASYNC'
            ? `await ${targetParticipant.label}`
            : event.type === 'READ'
              ? `read ${targetParticipant.label}`
              : event.type === 'WRITE'
                ? `write ${targetParticipant.label}`
            : RESPONSIBILITY_EDGE_TYPES.has(event.type)
              ? `${event.type.toLowerCase()}: ${sourceLabel || targetParticipant.label}`
              : sourceLabel || `${event.type.toLowerCase()} ${targetParticipant.label}`;
      const invocationMode = event.props?.invocation_mode
        || (event.type === 'DETACHES_ASYNC' || event.type === 'AWAITS_ASYNC' ? 'asynchronous' : 'synchronous');
      const responseMode = event.props?.response_mode
        || (event.type === 'AWAITS_ASYNC' ? 'awaited' : event.type === 'DETACHES_ASYNC' ? 'none' : 'return');
      addMessage(sourceParticipant, targetParticipant, event.type, messageLabel, sourceStableId, targetStableId, {
        invocationMode,
        responseMode,
      });

      const executes = EXECUTION_EDGE_TYPES.has(event.type) && targetFunctionStableId;
      const recursive = executes && stack.includes(targetFunctionStableId);
      if (recursive) {
        addMessage(targetParticipant, targetParticipant, 'RECURSION', 'recursive call', targetStableId, targetStableId);
      } else if (executes && !event.target.labels.includes('External')) {
        deferredExpansions.push({
          targetFunctionStableId,
          stack: [...stack, functionStableId],
        });
      }

      for (const callback of event.callbacks) {
        const callbackId = stableIdOf(callback.props);
        if (!callbackId) continue;
        const callbackParticipant = addParticipant(callbackId, callback, { kind: 'Callback' });
        const callbackContract = String(callback.props?.async_contract || 'unknown-callback');
        const callbackInvocationMode = callbackContract === 'synchronous-callback' ? 'synchronous' : callbackContract === 'deferred-callback' ? 'asynchronous' : 'unknown';
        addMessage(targetParticipant, callbackParticipant, 'CALLBACK', callback.props?.diaName || 'callback', targetStableId, callbackId, {
          invocationMode: callbackInvocationMode,
          responseMode: 'return',
        });
        addMessage(callbackParticipant, targetParticipant, 'CALLBACK_RETURN', 'callback return', callbackId, targetStableId, {
          invocationMode: callbackInvocationMode,
          responseMode: 'return',
        });
      }

      if (executes && responseMode !== 'none') {
        addMessage(targetParticipant, fnParticipant, 'RESPONSE', responseMode === 'awaited' ? 'async response' : 'return', targetStableId, functionStableId, {
          invocationMode,
          responseMode,
        });
      }
    }
    for (const deferred of deferredExpansions) {
      if (messages.length >= MAX_EVENTS) break;
      await expandFunction(deferred.targetFunctionStableId, fnParticipant, deferred.stack);
    }
    return fnParticipant;
  }

  return (async () => {
    await preloadSequenceGraph(session, rootStableId, functionCache, eventCache);
    const root = await loadFunction(session, rootStableId, functionCache);
    if (!root) throw new Error(`Function not found in local Neo4j: ${rootStableId}`);
    const rootParticipant = addParticipant(rootStableId, root, { functionStableId: rootStableId });
    await expandFunction(rootStableId, rootParticipant, []);
    return {
      root: rootParticipant,
      participants: [...participants.values()],
      messages,
      truncated: messages.length >= MAX_EVENTS,
    };
  })();
}

function participantStyle(participant) {
  if (participant.labels.includes('Missing')) return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;fontStyle=1;';
  if (participant.kind === 'CollectionLoop') return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;fontStyle=1;';
  if (participant.kind === 'Iteration') return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#e1d5e7;strokeColor=#9673a6;fontStyle=1;';
  if (participant.kind === 'Fn' || participant.kind === 'Method' || participant.kind === 'FunctionProxy') return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#9fbe99;strokeColor=#5f874f;fontStyle=1;';
  if (participant.kind === 'Callback') return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;';
  if (participant.kind === 'UI') return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#e1d5e7;strokeColor=#9673a6;fontStyle=1;';
  return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;';
}

function messageStyle(message) {
  if (message.type === 'RESPONSE' || message.type === 'CALLBACK_RETURN') return 'edgeStyle=none;html=1;dashed=1;endArrow=open;endFill=0;strokeColor=#666666;fontColor=#333333;';
  if (RESPONSIBILITY_EDGE_TYPES.has(message.type)) return 'edgeStyle=none;html=1;endArrow=open;endFill=0;strokeColor=#9673a6;fontColor=#6a3d7a;';
  if (message.type === 'RECURSION') return 'edgeStyle=orthogonalEdgeStyle;html=1;dashed=1;endArrow=block;endFill=1;strokeColor=#d79b00;fontColor=#9a6700;';
  if (message.invocationMode === 'asynchronous') return 'edgeStyle=none;html=1;endArrow=open;endFill=0;strokeColor=#5f874f;fontColor=#2e7d32;';
  if (message.invocationMode === 'unknown') return 'edgeStyle=none;html=1;dashed=1;dashPattern=1 4;endArrow=open;endFill=0;strokeColor=#888888;fontColor=#555555;';
  return 'edgeStyle=none;html=1;endArrow=block;endFill=1;strokeColor=#5f874f;fontColor=#2e7d32;';
}

function graphLink(params) {
  return `codex-graph://item?${Object.entries(params).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value || '')}`).join('&')}`;
}

function makeDrawio(model) {
  const indexByParticipant = new Map(model.participants.map((participant, index) => [participant.key, index]));
  const finalY = FIRST_EVENT_Y + Math.max(1, model.messages.length) * EVENT_GAP + 80;
  const pageWidth = Math.max(1200, 120 + model.participants.length * PARTICIPANT_GAP);
  const pageHeight = Math.max(800, finalY + 100);
  const cells = [];

  model.participants.forEach((participant, index) => {
    const centerX = 100 + index * PARTICIPANT_GAP;
    const cellId = `participant-${index + 1}`;
    const link = graphLink({
      kind: participant.kind,
      stableId: participant.stableId,
      functionStableId: participant.functionStableId,
      label: participant.label,
    });
    cells.push(`<mxCell id="${cellId}" value="${xml(participant.label)}" style="${xml(participantStyle(participant))}" vertex="1" parent="1" stableId="${xml(participant.stableId)}" functionStableId="${xml(participant.functionStableId)}" graphKind="${xml(participant.kind)}" graphLabel="${xml(participant.label)}" link="${xml(link)}"><mxGeometry x="${centerX - HEADER_WIDTH / 2}" y="${HEADER_Y}" width="${HEADER_WIDTH}" height="${HEADER_HEIGHT}" as="geometry" /></mxCell>`);
    const lifelineTop = `lifeline-${index + 1}-top`;
    const lifelineBottom = `lifeline-${index + 1}-bottom`;
    cells.push(`<mxCell id="${lifelineTop}" value="" style="ellipse;opacity=0;fillOpacity=0;strokeOpacity=0;" vertex="1" parent="1"><mxGeometry x="${centerX - 1}" y="${HEADER_Y + HEADER_HEIGHT - 1}" width="2" height="2" as="geometry" /></mxCell>`);
    cells.push(`<mxCell id="${lifelineBottom}" value="" style="ellipse;opacity=0;fillOpacity=0;strokeOpacity=0;" vertex="1" parent="1"><mxGeometry x="${centerX - 1}" y="${finalY - 1}" width="2" height="2" as="geometry" /></mxCell>`);
    cells.push(`<mxCell id="lifeline-${index + 1}" value="" style="edgeStyle=none;html=1;strokeWidth=1;dashed=1;endArrow=none;startArrow=none;strokeColor=#888888;" edge="1" parent="1" source="${lifelineTop}" target="${lifelineBottom}"><mxGeometry relative="1" as="geometry" /></mxCell>`);
  });

  model.messages.forEach((message, index) => {
    const sourceIndex = indexByParticipant.get(message.from);
    const targetIndex = indexByParticipant.get(message.to);
    if (sourceIndex == null || targetIndex == null) return;
    const y = FIRST_EVENT_Y + index * EVENT_GAP;
    const sourceX = 100 + sourceIndex * PARTICIPANT_GAP;
    const targetX = 100 + targetIndex * PARTICIPANT_GAP;
    const sourcePoint = `message-${index + 1}-source`;
    const targetPoint = `message-${index + 1}-target`;
    cells.push(`<mxCell id="${sourcePoint}" value="" style="ellipse;opacity=0;fillOpacity=0;strokeOpacity=0;" vertex="1" parent="1"><mxGeometry x="${sourceX - 1}" y="${y - 1}" width="2" height="2" as="geometry" /></mxCell>`);
    cells.push(`<mxCell id="${targetPoint}" value="" style="ellipse;opacity=0;fillOpacity=0;strokeOpacity=0;" vertex="1" parent="1"><mxGeometry x="${targetX - 1}" y="${y - 1}" width="2" height="2" as="geometry" /></mxCell>`);
    const link = graphLink({ kind: 'edge', stableId: message.sourceStableId, targetStableId: message.targetStableId, label: message.label, edgeType: message.type });
    cells.push(`<mxCell id="message-${index + 1}" value="${xml(message.label)}" style="${xml(messageStyle(message))}" edge="1" parent="1" source="${sourcePoint}" target="${targetPoint}" stableId="${xml(message.sourceStableId)}" targetStableId="${xml(message.targetStableId)}" graphKind="edge" graphLabel="${xml(message.label)}" edgeType="${xml(message.type)}" invocationMode="${xml(message.invocationMode)}" responseMode="${xml(message.responseMode)}" link="${xml(link)}"><mxGeometry relative="1" as="geometry" /></mxCell>`);
  });

  if (model.truncated) {
    cells.push(`<mxCell id="truncated" value="Sequence truncated after ${MAX_EVENTS} messages" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;" vertex="1" parent="1"><mxGeometry x="40" y="${finalY}" width="300" height="40" as="geometry" /></mxCell>`);
  }

  return `<mxfile host="app.diagrams.net" modified="2026-07-13T00:00:00.000Z" agent="Codex" version="24.7.17"><diagram id="local-function-sequence" name="Sequence"><mxGraphModel dx="1600" dy="1200" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${pageWidth}" pageHeight="${pageHeight}" math="0" shadow="0"><root><mxCell id="0" /><mxCell id="1" parent="0" />${cells.join('')}</root></mxGraphModel></diagram></mxfile>`;
}

async function main() {
  const args = parseArgs(process.argv);
  const config = localNeo4jConfig();
  const driver = neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password), { disableLosslessIntegers: true });
  const session = driver.session({ database: config.database });
  try {
    await driver.verifyConnectivity();
    const model = await buildSequenceModel(session, args.fnStableId);
    const outputPath = path.resolve(args.outputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, makeDrawio(model), 'utf8');
    console.log(JSON.stringify({
      ok: true,
      outputPath: args.outputPath,
      fnStableId: args.fnStableId,
      participants: model.participants.length,
      messages: model.messages.length,
      truncated: model.truncated,
    }, null, 2));
  } finally {
    await session.close();
    await driver.close();
  }
}

await main();
