import { randomUUID } from 'node:crypto';

import { buildRuntimeEnvelopeFromLegacyRow } from '../graph/packages/runtime-core/src/graphEnvelope.js';
import { normalizeStableId } from '../graph/packages/runtime-core/src/stableId.js';

const DEFAULT_RELAY_URL = 'http://127.0.0.1:8787/graph-relay';
const BATCH_DELAY_MS = Number(process.env.GRAPH_NODE_LOGGING_BATCH_MS || 25);
const BATCH_MAX_EVENTS = Number(process.env.GRAPH_NODE_LOGGING_BATCH_SIZE || 128);
const pendingRequests = new Set();
const pendingBatch = [];
let batchTimer;
const sessionId = process.env.GRAPH_RUNTIME_SESSION_ID || `node-pass-${randomUUID()}`;
const latestEventIdByOwner = new Map();
const collectionIterationStack = [];
let eventSequence = 0;

function canonicalRuntimeTarget(target) {
  return {
    ...target,
    stableId: normalizeStableId(target.stableId, { sourceFilePath: target.filePath }),
    ownerFnStableId: normalizeStableId(target.ownerFnStableId, { sourceFilePath: target.filePath }),
  };
}

export function createNodePassPayload(target, now = Date.now(), options = {}) {
  target = canonicalRuntimeTarget(target);
  const nodeid = options.eventId || `${target.stableId}:runtime:${now}:${randomUUID()}`;
  const predecessorEventIds = options.predecessorEventIds || [];
  const row = {
    nodeid,
    parentNodeid: predecessorEventIds[0] || '',
    edgeType: predecessorEventIds.length ? 'PRECEDES_AT_RUNTIME' : 'STARTS_AT_RUNTIME',
    labels: ['RunTime', 'NodeVisit'],
    nodeProps: {
      eventId: nodeid,
      predecessorEventIds,
      stableId: target.stableId,
      ownerFnStableId: target.ownerFnStableId,
      kind: 'node-visit',
      role: target.role || 'node',
      outcome: options.outcome,
      completion: options.completion || 'return',
      resultType: options.resultType,
      errorName: options.errorName,
      fnName: target.fnName || target.ownerFnStableId,
      sessionId,
      tsMs: now,
      staticFilePath: target.filePath,
      staticFnStartLine: target.startLine,
      startColumn: target.startColumn,
      endLine: target.endLine,
      endColumn: target.endColumn,
      instrumentation: 'babel',
      instrumentationKind: target.instrumentationKind,
      eventSequence: options.eventSequence,
      methodName: options.methodName,
      iterationGuardStableId: target.iterationGuardStableId,
      accumulatorName: options.accumulatorName,
      iterationIndex: options.iterationIndex,
      itemPreview: options.itemPreview,
      valuePreview: options.valuePreview,
      matched: options.matched,
      accumulatorBefore: options.accumulatorBefore,
      accumulatorState: options.accumulatorState,
      stageName: options.stageName,
      ownerStepStableId: target.ownerStepStableId,
      variableName: target.variableName,
      continuesAfterResult: options.continuesAfterResult === true,
    },
  };

  return [buildRuntimeEnvelopeFromLegacyRow(row)];
}

export function logNodePass(target, result = {}) {
  target = canonicalRuntimeTarget(target);
  const ownerKey = target.ownerFnStableId || target.filePath || 'global';
  if (target.startsChain) latestEventIdByOwner.delete(ownerKey);
  const predecessorEventId = latestEventIdByOwner.get(ownerKey);
  const eventId = `${target.stableId}:runtime:${Date.now()}:${randomUUID()}`;
  latestEventIdByOwner.set(ownerKey, eventId);
  const payload = createNodePassPayload(target, Date.now(), {
    ...result,
    eventSequence: ++eventSequence,
    eventId,
    predecessorEventIds: predecessorEventId ? [predecessorEventId] : [],
  });
  return new Promise((resolve) => {
    pendingBatch.push({ payload, resolve });
    if (pendingBatch.length >= BATCH_MAX_EVENTS) {
      void flushNodePassBatch();
    } else if (!batchTimer) {
      batchTimer = setTimeout(() => {
        batchTimer = undefined;
        void flushNodePassBatch();
      }, BATCH_DELAY_MS);
    }
  });
}

function flushNodePassBatch() {
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = undefined;
  }
  if (!pendingBatch.length) return Promise.resolve(undefined);

  const entries = pendingBatch.splice(0, BATCH_MAX_EVENTS);
  const relayUrl = process.env.RUNTIME_RELAY_URL || DEFAULT_RELAY_URL;
  const request = fetch(relayUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entries.flatMap((entry) => entry.payload)),
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Runtime relay returned HTTP ${response.status}`);
      }
      return response.json();
    })
    .catch((error) => {
      if (process.env.GRAPH_NODE_LOGGING_DEBUG === '1') {
        console.error(`[node-pass] ${error instanceof Error ? error.message : String(error)}`);
      }
      return undefined;
    })
    .then((result) => {
      entries.forEach((entry) => entry.resolve(result));
      return result;
    })
    .finally(() => {
      pendingRequests.delete(request);
      if (pendingBatch.length) void flushNodePassBatch();
    });

  pendingRequests.add(request);
  return request;
}

export function evaluateNode(target, evaluator, readValue) {
  const iteration = collectionIterationStack.at(-1);
  try {
    const value = evaluator();
    const observedValue = readValue ? readValue() : target.valuePath
      ? target.valuePath.split('.').reduce((current, key) => current?.[key], value)
      : value;
    const predicate = target.role === 'predicate' || target.role === 'predicate-stage';
    const predicateOutcome = target.predicateOutcomeMode === 'non-nullish'
      ? value !== null && value !== undefined
      : Boolean(value);
    void logNodePass(target, {
      outcome: predicate ? predicateOutcome : undefined,
      resultType: observedValue === null ? 'null' : typeof observedValue,
      methodName: iteration?.methodName,
      iterationIndex: iteration?.iterationIndex,
      itemPreview: predicate && readValue ? previewRuntimeValue(observedValue) : iteration?.itemPreview,
      valuePreview: predicate
        ? undefined
        : target.role === 'set-value' || target.role === 'parameter-value'
          ? previewRuntimeValue(observedValue)
          : previewCollectionItem(observedValue),
      stageName: target.stageName,
    });
    if (predicate) {
      const outcome = predicateOutcome;
      if (
        iteration
        && (!iteration.iterationOutcomeStableId || iteration.iterationOutcomeStableId === target.stableId)
      ) {
        iteration.outcome = outcome;
      }
      const targetStableId = outcome ? target.trueTargetStableId : target.falseTargetStableId;
      if (targetStableId) {
        void logNodePass({
          ...target,
          stableId: targetStableId,
          role: 'flow-join',
          startsChain: false,
        }, {
          methodName: iteration?.methodName,
          iterationIndex: iteration?.iterationIndex,
          itemPreview: iteration?.itemPreview,
          stageName: outcome ? 'true destination' : 'false destination',
        });
      }
    }
    return value;
  } catch (error) {
    void logNodePass(target, {
      completion: 'throw',
      errorName: error instanceof Error ? error.name : typeof error,
      methodName: iteration?.methodName,
      iterationIndex: iteration?.iterationIndex,
      itemPreview: iteration?.itemPreview,
      stageName: target.stageName,
    });
    throw error;
  }
}

export async function evaluateAsyncNode(target, evaluator) {
  const iteration = collectionIterationStack.at(-1);
  try {
    const value = await evaluator();
    const observedValue = target.valuePath
      ? target.valuePath.split('.').reduce((current, key) => current?.[key], value)
      : value;
    void logNodePass(target, {
      resultType: observedValue === null ? 'null' : typeof observedValue,
      methodName: iteration?.methodName,
      iterationIndex: iteration?.iterationIndex,
      itemPreview: iteration?.itemPreview,
      valuePreview: target.role === 'set-value' || target.role === 'parameter-value'
        ? previewRuntimeValue(observedValue)
        : previewCollectionItem(observedValue),
      stageName: target.stageName,
    });
    return value;
  } catch (error) {
    void logNodePass(target, {
      completion: 'throw',
      errorName: error instanceof Error ? error.name : typeof error,
      methodName: iteration?.methodName,
      iterationIndex: iteration?.iterationIndex,
      itemPreview: iteration?.itemPreview,
      stageName: target.stageName,
    });
    throw error;
  }
}

function previewRuntimeValue(value, maxLength = 1200) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return value.slice(0, maxLength);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (typeof value !== 'object') return String(value).slice(0, maxLength);

  const seen = new WeakSet();
  try {
    const serialized = JSON.stringify(value, (_key, entry) => {
      if (typeof entry === 'bigint') return `${entry}n`;
      if (typeof entry === 'function') return `[Function ${entry.name || 'anonymous'}]`;
      if (entry && typeof entry === 'object') {
        if (seen.has(entry)) return '[Circular]';
        seen.add(entry);
      }
      return entry;
    });
    return String(serialized ?? value.constructor?.name ?? 'Object').slice(0, maxLength);
  } catch {
    return String(value.constructor?.name || 'Object').slice(0, maxLength);
  }
}

function previewCollectionItem(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value !== 'object') return String(value).slice(0, 120);
  if (typeof value.name === 'string') return value.name.slice(0, 120);
  if (typeof value.id === 'string' || typeof value.id === 'number') {
    return `id:${String(value.id).slice(0, 100)}`;
  }
  return Array.isArray(value) ? `Array(${value.length})` : value.constructor?.name || 'Object';
}

function collectionTarget(target, stableId, role) {
  return {
    ...target,
    stableId,
    role,
    startsChain: false,
  };
}

export function wrapCollectionCallback(target, callback) {
  const acceptedItemPreviews = [];
  return function coldKodeCollectionCallback(...args) {
    const reduce = target.methodName === 'reduce';
    const accumulatorBefore = reduce ? args[0] : null;
    const item = reduce ? args[1] : args[0];
    const index = reduce ? args[2] : args[1];
    const itemPreview = previewCollectionItem(item);
    void logNodePass(collectionTarget(target, target.pullStableId, 'collection-pop'), {
      methodName: target.methodName,
      accumulatorName: target.accumulatorName,
      iterationIndex: index,
      itemPreview,
    });
    void logNodePass(collectionTarget(target, target.iterationValueStableId, 'iteration-value'), {
      methodName: target.methodName,
      accumulatorName: target.accumulatorName,
      iterationIndex: index,
      itemPreview,
    });

    collectionIterationStack.push({
      methodName: target.methodName,
      iterationIndex: index,
      itemPreview,
    });
    try {
      const callbackResult = callback.apply(this, args);
      if (reduce) {
        const accumulatorState = previewCollectionItem(callbackResult);
        void logNodePass(collectionTarget(
          target,
          target.accumulatorStableId || target.callbackStableId,
          'collection-accumulate',
        ), {
          methodName: target.methodName,
          accumulatorName: target.accumulatorName,
          iterationIndex: index,
          itemPreview,
          outcome: true,
          accumulatorBefore: previewCollectionItem(accumulatorBefore),
          accumulatorState,
        });
        return callbackResult;
      }
      const matched = callbackResult;
      if (target.methodName === 'filter' && Boolean(matched)) {
        acceptedItemPreviews.push(itemPreview);
      }
      const accumulatorState = target.methodName === 'filter'
        ? `[${acceptedItemPreviews.join(', ')}]`
        : null;
      void logNodePass(collectionTarget(target, target.callbackStableId, 'collection-predicate'), {
        methodName: target.methodName,
        iterationIndex: index,
        outcome: Boolean(matched),
        matched: Boolean(matched),
        accumulatorState,
      });
      if (target.methodName === 'filter' && Boolean(matched)) {
        void logNodePass(collectionTarget(target, target.resultStableId, 'collection-emit'), {
          methodName: target.methodName,
          iterationIndex: index,
          itemPreview,
          outcome: true,
          accumulatorState,
        });
      }
      return matched;
    } catch (error) {
      void logNodePass(collectionTarget(
        target,
        reduce ? (target.accumulatorStableId || target.callbackStableId) : target.callbackStableId,
        reduce ? 'collection-accumulate' : 'collection-predicate',
      ), {
        methodName: target.methodName,
        iterationIndex: index,
        itemPreview,
        accumulatorBefore: reduce ? previewCollectionItem(accumulatorBefore) : null,
        completion: 'throw',
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    } finally {
      collectionIterationStack.pop();
    }
  };
}

export function evaluateCollectionCall(target, evaluator) {
  if (target.startsChain) {
    latestEventIdByOwner.delete(target.ownerFnStableId || target.filePath || 'global');
  }
  void logNodePass(collectionTarget(target, target.stableId, 'collection-method'), {
    methodName: target.methodName,
    accumulatorName: target.accumulatorName,
  });
  try {
    const value = evaluator();
    void logNodePass(collectionTarget(target, target.resultStableId, 'collection-result'), {
      methodName: target.methodName,
      accumulatorName: target.accumulatorName,
      outcome: value !== undefined,
      resultType: value === null ? 'null' : typeof value,
      itemPreview: previewCollectionItem(value),
      continuesAfterResult: target.continuesAfterResult === true,
    });
    return value;
  } catch (error) {
    void logNodePass(collectionTarget(target, target.stableId, 'collection-method'), {
      methodName: target.methodName,
      completion: 'throw',
      errorName: error instanceof Error ? error.name : typeof error,
    });
    throw error;
  }
}

export function wrapForOfIterable(target, iterable) {
  const ownerKey = target.ownerFnStableId || target.filePath || 'global';
  return (function* coldKodeForOfIterable() {
    if (target.startsChain) latestEventIdByOwner.delete(ownerKey);
    void logNodePass(collectionTarget(target, target.stableId, 'collection-method'), {
      methodName: target.methodName || 'for-of',
    });
    let index = 0;
    try {
      for (const item of iterable) {
        const itemPreview = previewCollectionItem(item);
        void logNodePass(collectionTarget(target, target.pullStableId, 'collection-pop'), {
          methodName: target.methodName || 'for-of',
          iterationIndex: index,
          itemPreview,
        });
        void logNodePass(collectionTarget(target, target.iterationValueStableId, 'iteration-value'), {
          methodName: target.methodName || 'for-of',
          iterationIndex: index,
          itemPreview,
        });
        const iteration = {
          methodName: target.methodName || 'for-of',
          iterationIndex: index,
          itemPreview,
          iterationOutcomeStableId: target.iterationOutcomeStableId,
          outcome: undefined,
        };
        collectionIterationStack.push(iteration);
        try {
          yield item;
        } finally {
          const stackIndex = collectionIterationStack.lastIndexOf(iteration);
          if (stackIndex >= 0) collectionIterationStack.splice(stackIndex, 1);
          void logNodePass(collectionTarget(
            target,
            target.callbackStableId || target.iterationValueStableId,
            'collection-predicate',
          ), {
            methodName: iteration.methodName,
            iterationIndex: index,
            itemPreview,
            outcome: iteration.outcome,
            matched: iteration.outcome === true,
          });
          index += 1;
        }
      }
    } finally {
      void logNodePass(collectionTarget(target, target.stableId, 'collection-result'), {
        methodName: target.methodName || 'for-of',
        outcome: true,
        resultType: 'undefined',
      });
    }
  })();
}

export async function flushPendingNodePassEvents() {
  await flushNodePassBatch();
  while (pendingRequests.size || pendingBatch.length) {
    if (pendingBatch.length) await flushNodePassBatch();
    await Promise.allSettled([...pendingRequests]);
  }
}

function beginFor(target) {
  void logNodePass({ ...target, role: 'collection-method' }, { methodName: 'for' });
  return { target, index: 0, active: null };
}

function beginForIteration(state, bindings) {
  const iteration = { methodName: 'for', iterationIndex: state.index++, itemPreview: previewRuntimeValue(bindings) };
  state.active = iteration;
  collectionIterationStack.push(iteration);
  void logNodePass({ ...state.target, role: 'collection-pop' }, iteration);
}

function endForIteration(state) {
  const iteration = state.active;
  if (!iteration) return;
  void logNodePass({ ...state.target, role: 'collection-predicate' }, {
    ...iteration, outcome: !state.error, matched: !state.error,
    completion: state.error ? 'throw' : 'return', errorName: state.error?.name,
  });
  const index = collectionIterationStack.lastIndexOf(iteration);
  if (index >= 0) collectionIterationStack.splice(index, 1);
  state.active = null;
}

function endFor(state) {
  endForIteration(state);
  void logNodePass({ ...state.target, role: 'collection-result' }, { methodName: 'for', continuesAfterResult: true });
}

export function installRuntimeNodePassReporter() {
  if (process.env.GRAPH_NODE_LOGGING !== '1') return false;
  globalThis.__coldKodeLogNodePass = logNodePass;
  globalThis.__coldKodeEvaluateNode = evaluateNode;
  globalThis.__coldKodeEvaluateAsyncNode = evaluateAsyncNode;
  globalThis.__coldKodeWrapCollectionCallback = wrapCollectionCallback;
  globalThis.__coldKodeEvaluateCollectionCall = evaluateCollectionCall;
  globalThis.__coldKodeWrapForOfIterable = wrapForOfIterable;
  globalThis.__coldKodeBeginFor = beginFor;
  globalThis.__coldKodeBeginForIteration = beginForIteration;
  globalThis.__coldKodeEndForIteration = endForIteration;
  globalThis.__coldKodeEndFor = endFor;
  return true;
}
