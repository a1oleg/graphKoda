import { buildStableIdFromCoordinates } from './stableId.js';

function createId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeTracePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function normalizeRepoRelativeTracePath(filePath) {
  const normalizedPath = normalizeTracePath(filePath);
  const srcIndex = normalizedPath.lastIndexOf('/src/');

  if (srcIndex >= 0) {
    return normalizedPath.slice(srcIndex + 1);
  }

  return normalizedPath.replace(/^[A-Za-z]:\//, '');
}

function resolveSessionId(config = {}) {
  return config.sessionId || undefined;
}

function resolveGitRevision(config = {}) {
  if (config.gitRevision) {
    return config.gitRevision;
  }

  if (typeof process !== 'undefined') {
    const envGitRevision = process.env?.PROBE_GIT_REVISION
      || process.env?.APP_REVISION
      || process.env?.GITHUB_SHA
      || process.env?.GIT_COMMIT
      || process.env?.SOURCE_VERSION;

    if (envGitRevision) {
      return envGitRevision.trim().slice(0, 7);
    }
  }

  if (typeof APP_REVISION !== 'undefined') {
    return APP_REVISION;
  }

  return 'unknown';
}

function parseCallerFile(callerFile) {
  const normalized = normalizeRepoRelativeTracePath(callerFile);
  const parts = normalized.split('/');
  const fileName = parts[parts.length - 1].replace(/\.(ts|tsx|js|mjs|cjs)$/, '');

  return {
    fileName,
    filePath: normalized,
  };
}

function buildStaticFnProps(callerFile, fnName, fnStartLine, fnStartColumn, fnEndLine, fnEndColumn) {
  const callerInfo = callerFile ? parseCallerFile(callerFile) : undefined;
  const stableId = callerInfo && fnStartLine && fnStartColumn
    ? buildStableIdFromCoordinates({
      filePath: callerInfo.filePath,
      startLine: fnStartLine,
      startColumn: fnStartColumn,
      endLine: fnEndLine,
      endColumn: fnEndColumn,
    })
    : undefined;

  return {
    fileName: callerInfo ? callerInfo.fileName : undefined,
    filePath: callerInfo ? callerInfo.filePath : undefined,
    fnStartLine,
    fnStartColumn,
    fnEndLine,
    fnEndColumn,
    staticFnName: fnName,
    staticFilePath: callerInfo ? callerInfo.filePath : undefined,
    staticFnStartLine: fnStartLine,
    staticFnEndLine: fnEndLine,
    ownerFnStableId: stableId,
    stableId,
  };
}

function withoutAutoDerivedStableIds(staticFnProps, options = {}) {
  if (!options.disableAutoStableIdDerivation) {
    return staticFnProps;
  }

  return {
    ...staticFnProps,
    ownerFnStableId: undefined,
    stableId: undefined,
  };
}

const THREAD_LANE_BASES = {
  Window: '1',
  DedicatedWorkerGlobalScope: '2',
  SharedWorkerGlobalScope: '3',
  ServiceWorkerGlobalScope: '4',
  NodeProcess: '5',
};

function resolveThreadName() {
  const selfConstructorName = globalThis.self?.constructor?.name;

  if (selfConstructorName) {
    return selfConstructorName;
  }

  if (typeof window !== 'undefined') {
    return 'Window';
  }

  if (typeof process !== 'undefined') {
    return 'NodeProcess';
  }

  return 'unknown';
}

function resolveLaneBase(threadName) {
  return THREAD_LANE_BASES[threadName] || '9';
}

function getMonotonicNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function isNullishValue(value) {
  return value === undefined || (typeof value === 'object' && !value);
}

function shouldSuppressRuntimeParentEdges(parentContext, overrides = {}) {
  if (parentContext?.nodeid) {
    return false;
  }

  if (overrides.parentNodeid) {
    return false;
  }

  if (parentContext?.metadata?.callApiCorrelationId) {
    return false;
  }

  const userActionRootId = overrides.userActionRootId
    || parentContext?.metadata?.userActionRootId;

  return !userActionRootId;
}

function createTraceContext(fnName, parentContext, edgeType, overrides = {}) {
  const thread = resolveThreadName();
  const inheritedCallApiCorrelationId = parentContext?.metadata?.callApiCorrelationId;
  const inheritedUserActionRootId = overrides.userActionRootId || parentContext?.metadata?.userActionRootId;
  const inheritedFeatureTraceToken = overrides.featureTraceToken || parentContext?.metadata?.featureTraceToken;
  const inheritedFeatureTraceKey = overrides.featureTraceKey || parentContext?.metadata?.featureTraceKey;
  const inheritedFeatureTraceRootStableId = overrides.featureTraceRootStableId || parentContext?.metadata?.featureTraceRootStableId;
  const shouldSuppressParentNodeid = shouldSuppressRuntimeParentEdges(parentContext, overrides);

  const context = {
    nodeid: createId(),
    parentNodeid: shouldSuppressParentNodeid ? undefined : (overrides.parentNodeid || parentContext?.nodeid),
    fnName,
    depth: shouldSuppressParentNodeid ? 0 : (parentContext ? parentContext.depth + 1 : 0),
    sessionId: overrides.sessionId || parentContext?.sessionId || RuntimeReporter.sessionId,
    gitRevision: RuntimeReporter.gitRevision,
    configId: RuntimeReporter.configId,
    tsMs: Date.now(),
    edgeType,
    thread,
    lane: RuntimeReporter.nextLane(parentContext?.nodeid, thread),
    metadata: {
      startMonotonicMs: getMonotonicNow(),
      callApiCorrelationId: inheritedCallApiCorrelationId,
      ownerFnStableId: overrides.ownerFnStableId || overrides.fnStableId,
      storeAffects: [],
      userActionRootId: inheritedUserActionRootId,
      featureTraceToken: inheritedFeatureTraceToken,
      featureTraceKey: inheritedFeatureTraceKey,
      featureTraceRootStableId: inheritedFeatureTraceRootStableId,
      featureTraceBridgeFile: Boolean(overrides.featureTraceBridgeFile || parentContext?.metadata?.featureTraceBridgeFile),
      isUserActionRoot: Boolean(overrides.isUserActionRoot),
    },
  };

  if (overrides.isUserActionRoot && !context.metadata.userActionRootId) {
    context.metadata.userActionRootId = context.nodeid;
  }

  return context;
}

function buildTraceIdLogProps(context) {
  if (!context?.nodeid) {
    return {};
  }

  return {
    callId: context.nodeid,
    parentCallId: context.parentNodeid,
  };
}

function buildCompletedNodeProps(context, outcome) {
  const finishedAt = getMonotonicNow();
  const startedAt = typeof context?.metadata?.startMonotonicMs === 'number'
    ? context.metadata.startMonotonicMs
    : finishedAt;

  return {
    durationMs: Math.max(0, Math.round((finishedAt - startedAt) * 1000) / 1000),
    outcome,
  };
}

function appendStoreAffect(context, storeName, affectType, props) {
  if (!context) {
    return;
  }

  const existingStoreAffects = Array.isArray(context.metadata?.storeAffects)
    ? context.metadata.storeAffects
    : [];

  context.metadata = {
    ...(context.metadata || {}),
    storeAffects: [...existingStoreAffects, {
      storeName,
      affectType,
      props,
    }],
  };
}

const DECISION_EDGE_TYPE = 'EVALUATED_DECISION';
const PREDICATE_EDGE_TYPE = 'EVALUATED_PREDICATE';
const BRANCH_EDGE_TYPE = 'TOOK_BRANCH';
const ASYNC_EVENT_EDGE_TYPE = 'OBSERVED_ASYNC_EVENT';
const BOUNDARY_EVENT_EDGE_TYPE = 'CROSSED_RUNTIME_BOUNDARY';
const INSTRUMENTATION_GAP_EDGE_TYPE = 'CROSSED_INSTRUMENTATION_GAP';
const EXCEPTION_HANDLING_EDGE_TYPE = 'ENTERED_EXCEPTION_HANDLING_CLAUSE';
const CONTROL_FLOW_GUARD_EDGE_TYPE = 'EVALUATED_CONTROL_FLOW_GUARD';
const RETRY_TRANSPORT_FALLBACK_EDGE_TYPE = 'OBSERVED_RETRY_TRANSPORT_FALLBACK';
const LOOP_CONTROL_EDGE_TYPE = 'OBSERVED_LOOP_CONTROL';
const PATH_CHECKPOINT_EDGE_TYPE = 'TOOK_RUNTIME_PATH_CHECKPOINT';
const CALL_COMPLETION_EDGE_TYPES = {
  ok: 'RETURNED_RUNTIME',
  error: 'THREW_RUNTIME',
};

export class RuntimeReporter {
  static _instance;
  static _stack = [];
  static _contexts = new Map();
  static _pendingCallSite;
  static _laneCounters = new Map();
  static _buffer = [];
  static _sessionId = resolveSessionId();
  static _hasExplicitSession = false;
  static _gitRevision = resolveGitRevision();
  static _configId = 'glc_unknown';
  static _buffering = false;

  static emitExplicitSessionBootstrapProbe(config = {}) {
    if (!config.enabled || !config.requireExplicitSession || !config.sessionId) {
      return;
    }

    RuntimeReporter.ensureInstance().logBoundaryEvent(
      'BootstrapProbe',
      {
        bootstrapProbe: 'explicitRuntimeSession',
      },
      RuntimeReporter.stackTop(),
      {
        boundaryKind: 'bootstrap-probe',
        boundaryDirection: 'receive',
        boundaryTransport: 'runtime-session',
        boundaryMessageType: 'bootstrap-probe',
        bootstrapPhase: 'runtime-session-init',
        auto: true,
      },
    );
  }

  static init(config = {}) {
    const previousInstance = RuntimeReporter._instance;
    const pendingEvents = previousInstance?.takeEvents() || [];
    const previousConfig = previousInstance?.config || {};

    RuntimeReporter._stack = [];
    RuntimeReporter._contexts = new Map();
    RuntimeReporter._pendingCallSite = undefined;
    RuntimeReporter._laneCounters = new Map();

    if (config.sessionId) {
      RuntimeReporter._sessionId = resolveSessionId(config);
      RuntimeReporter._hasExplicitSession = true;
    }

    const resolvedConfig = {
      ...previousConfig,
      ...config,
      gitRevision: resolveGitRevision({
        ...previousConfig,
        ...config,
      }),
    };

    RuntimeReporter._gitRevision = resolvedConfig.gitRevision;
    RuntimeReporter._configId = resolvedConfig.configId || RuntimeReporter._configId;
    RuntimeReporter._instance = new RuntimeReporter(resolvedConfig);

    if (pendingEvents.length) {
      RuntimeReporter._instance.events.push(...pendingEvents);
    }

    if (config.sessionId && !previousConfig.sessionId) {
      RuntimeReporter.emitExplicitSessionBootstrapProbe(resolvedConfig);
    }

    return RuntimeReporter._instance;
  }

  static get instance() {
    return RuntimeReporter._instance;
  }

  static get sessionId() {
    return RuntimeReporter._sessionId;
  }

  static get gitRevision() {
    if (RuntimeReporter._gitRevision === 'unknown') {
      RuntimeReporter._gitRevision = resolveGitRevision();
    }

    return RuntimeReporter._gitRevision;
  }

  static get configId() {
    return RuntimeReporter._configId;
  }

  static get hasExplicitSession() {
    return RuntimeReporter._hasExplicitSession;
  }

  static ensureExplicitSession(sessionId) {
    RuntimeReporter._sessionId = sessionId || RuntimeReporter._sessionId;
    RuntimeReporter._hasExplicitSession = true;
    return RuntimeReporter._sessionId;
  }

  static rebindActiveSession(sessionId) {
    const resolvedSessionId = RuntimeReporter.ensureExplicitSession(sessionId);

    RuntimeReporter._stack.forEach((context) => {
      if (context) {
        context.sessionId = resolvedSessionId;
      }
    });

    RuntimeReporter._contexts.forEach((context) => {
      if (context) {
        context.sessionId = resolvedSessionId;
      }
    });

    return resolvedSessionId;
  }

  static ensureInstance() {
    if (!RuntimeReporter._instance) {
      RuntimeReporter._instance = new RuntimeReporter();
    }

    return RuntimeReporter._instance;
  }

  static stackTop() {
    return RuntimeReporter._stack.at(-1);
  }

  static pushContext(context) {
    if (context) {
      RuntimeReporter._stack.push(context);
    }
  }

  static popContext() {
    RuntimeReporter._stack.pop();
  }

  static noteCallSite(line, callee) {
    RuntimeReporter._pendingCallSite = { line, callee };
  }

  static takeCallSite() {
    const callSite = RuntimeReporter._pendingCallSite;
    RuntimeReporter._pendingCallSite = undefined;
    return callSite;
  }

  static storeContext(key, context) {
    RuntimeReporter._contexts.set(key, context);
  }

  static retrieveContext(key) {
    return RuntimeReporter._contexts.get(key);
  }

  static deleteContext(key) {
    RuntimeReporter._contexts.delete(key);
  }

  static nextLane(parentNodeid, threadName = resolveThreadName()) {
    const laneBase = resolveLaneBase(threadName);
    const key = laneBase;
    const index = (RuntimeReporter._laneCounters.get(key) ?? 0) + 1;

    RuntimeReporter._laneCounters.set(key, index);

    return `${laneBase}.${index}`;
  }

  static async withContext(context, fn) {
    if (context) {
      RuntimeReporter.pushContext(context);
    }

    try {
      return await fn();
    } finally {
      if (context) {
        RuntimeReporter.popContext();
      }
    }
  }

  static logCall(fnName, args = {}, parentContext, options = {}) {
    return RuntimeReporter.ensureInstance().logCall(
      fnName,
      args,
      parentContext || RuntimeReporter.stackTop(),
      options,
    );
  }

  static logResponse(fnName, context, result = {}) {
    RuntimeReporter.ensureInstance().logResponse(fnName, context, result);
  }

  static logError(fnName, context, error) {
    RuntimeReporter.ensureInstance().logError(fnName, context, error);
  }

  static logStoreAffect(storeName, affect, context, props = {}) {
    RuntimeReporter.ensureInstance().logStoreAffect(storeName, affect, context, props);
  }

  static logDecision(decisionName, props = {}, parentContext, options = {}) {
    return RuntimeReporter.ensureInstance().logDecision(decisionName, props, parentContext, options);
  }

  static logPredicateEval(predicateName, value, decisionContext, props = {}, options = {}) {
    return RuntimeReporter.ensureInstance().logPredicateEval(predicateName, value, decisionContext, props, options);
  }

  static logBranchHit(branchName, decisionContext, props = {}, options = {}) {
    return RuntimeReporter.ensureInstance().logBranchHit(branchName, decisionContext, props, options);
  }

  static logAsyncEvent(eventName, props = {}, parentContext, options = {}) {
    return RuntimeReporter.ensureInstance().logAsyncEvent(eventName, props, parentContext, options);
  }

  static logBoundaryEvent(eventName, props = {}, parentContext, options = {}) {
    return RuntimeReporter.ensureInstance().logBoundaryEvent(eventName, props, parentContext, options);
  }

  static logExceptionHandlingEvent(eventName, props = {}, parentContext, options = {}) {
    return RuntimeReporter.ensureInstance().logExceptionHandlingEvent(eventName, props, parentContext, options);
  }

  static logControlFlowGuardEvent(eventName, props = {}, parentContext, options = {}) {
    return RuntimeReporter.ensureInstance().logControlFlowGuardEvent(eventName, props, parentContext, options);
  }

  static logRetryTransportFallbackEvent(eventName, props = {}, parentContext, options = {}) {
    return RuntimeReporter.ensureInstance().logRetryTransportFallbackEvent(eventName, props, parentContext, options);
  }

  static logLoopControlEvent(eventName, props = {}, parentContext, options = {}) {
    return RuntimeReporter.ensureInstance().logLoopControlEvent(eventName, props, parentContext, options);
  }

  static logPathCheckpoint(checkpointName, props = {}, parentContext, options = {}) {
    return RuntimeReporter.ensureInstance().logPathCheckpoint(checkpointName, props, parentContext, options);
  }

  static async flush() {
    await RuntimeReporter.ensureInstance().flush();
  }

  static get isBuffering() {
    return RuntimeReporter._buffering;
  }

  static startBuffering() {
    RuntimeReporter._buffer = [];
    RuntimeReporter._buffering = true;
  }

  static flushBuffer() {
    const instance = RuntimeReporter.ensureInstance();
    const buffered = RuntimeReporter._buffer.splice(0);
    RuntimeReporter._buffering = false;
    if (instance.config.transport && buffered.length) {
      const task = Promise.resolve(instance.config.transport(buffered)).catch(() => undefined);
      instance.pendingTransports.add(task);
      task.finally(() => instance.pendingTransports.delete(task));
    }
  }

  static serializeProps(raw = {}) {
    const result = {};

    for (const [key, value] of Object.entries(raw)) {
      if (value === undefined) {
        continue;
      }

      if (
        (typeof value === 'object' && !value)
        || typeof value === 'string'
        || typeof value === 'number'
        || typeof value === 'boolean'
      ) {
        result[key] = value;
        continue;
      }

      if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
        result[key] = value;
        continue;
      }

      try {
        const serialized = JSON.stringify(value);
        result[key] = serialized === undefined ? String(value).slice(0, 500) : serialized.slice(0, 500);
      } catch {
        result[key] = String(value).slice(0, 500);
      }
    }

    return result;
  }

  constructor(config) {
    this.config = {
      enabled: true,
      transport: undefined,
      requireExplicitSession: false,
      retainEvents: true,
      eventBufferLimit: Infinity,
      transportBatchSize: 100,
      transportFlushIntervalMs: 50,
      transportPendingLimit: 2000,
      ...config,
    };
    this.events = [];
    this.pendingTransports = new Set();
    this.pendingTransportEvents = [];
    this.transportFlushTimer = undefined;
    this.transportFlushInFlight = Promise.resolve();
  }

  trimPendingTransportEvents() {
    if (!Number.isFinite(this.config.transportPendingLimit)) {
      return;
    }

    if (this.pendingTransportEvents.length > this.config.transportPendingLimit) {
      this.pendingTransportEvents.splice(0, this.pendingTransportEvents.length - this.config.transportPendingLimit);
    }
  }

  scheduleTransportFlush(delayMs = this.config.transportFlushIntervalMs) {
    if (this.transportFlushTimer) {
      return;
    }

    this.transportFlushTimer = setTimeout(() => {
      this.transportFlushTimer = undefined;
      void this.flushPendingTransportEvents();
    }, delayMs);
  }

  async flushPendingTransportEvents() {
    if (!this.config.transport || !this.pendingTransportEvents.length) {
      return;
    }

    const events = this.pendingTransportEvents.splice(0, this.config.transportBatchSize);
    const task = this.transportFlushInFlight
      .catch(() => undefined)
      .then(() => Promise.resolve(this.config.transport(events)).catch(() => undefined));

    this.transportFlushInFlight = task;
    this.pendingTransports.add(task);
    task.finally(() => {
      this.pendingTransports.delete(task);
    });

    await task;

    if (this.pendingTransportEvents.length) {
      void this.flushPendingTransportEvents();
    }
  }

  shouldEnqueue(event) {
    if (!this.config.enabled) {
      return false;
    }

    if (this.config.requireExplicitSession && !RuntimeReporter.hasExplicitSession) {
      return false;
    }

    return true;
  }

  enqueue(event) {
    if (!this.shouldEnqueue(event)) {
      return undefined;
    }

    const isBuffering = RuntimeReporter._buffering;

    if (isBuffering) {
      RuntimeReporter._buffer.push(event);
    }

    if (this.config.retainEvents || isBuffering) {
      this.events.push(event);

      if (Number.isFinite(this.config.eventBufferLimit) && this.events.length > this.config.eventBufferLimit) {
        this.events.splice(0, this.events.length - this.config.eventBufferLimit);
      }
    }

    if (this.config.transport && !isBuffering) {
      this.pendingTransportEvents.push(event);
      this.trimPendingTransportEvents();

      if (this.pendingTransportEvents.length >= this.config.transportBatchSize) {
        if (this.transportFlushTimer) {
          clearTimeout(this.transportFlushTimer);
          this.transportFlushTimer = undefined;
        }

        void this.flushPendingTransportEvents();
      } else {
        this.scheduleTransportFlush();
      }
    }

    return event;
  }

  async flush() {
    while (this.pendingTransportEvents.length || this.pendingTransports.size) {
      if (this.pendingTransportEvents.length) {
        if (this.transportFlushTimer) {
          clearTimeout(this.transportFlushTimer);
          this.transportFlushTimer = undefined;
        }

        await this.flushPendingTransportEvents();
        continue;
      }

      await Promise.allSettled([...this.pendingTransports]);
    }
  }

  logCall(fnName, args = {}, parentContext, options = {}) {
    if (this.config.requireExplicitSession && options.isUserActionRoot && !RuntimeReporter.hasExplicitSession) {
      RuntimeReporter.ensureExplicitSession(options.sessionId);
    }

    const callSite = RuntimeReporter.takeCallSite();
    const staticFnProps = withoutAutoDerivedStableIds(buildStaticFnProps(
      options.callerFile,
      fnName,
      options.fnStartLine,
      options.fnStartColumn,
      options.fnEndLine,
      options.fnEndColumn,
    ), options);
    const shouldSkipInstrumentationGap = options.emitCall === false
      && shouldSuppressRuntimeParentEdges(parentContext, options);
    const resolvedParentContext = parentContext || (shouldSkipInstrumentationGap
      ? undefined
      : this.logInstrumentationGap(fnName, callSite, {
        ...staticFnProps,
        ...options,
      }));
    const originRuntimeTrace = options.originRuntimeTrace || extractOriginRuntimeTrace(args);

    if (options.emitCall === false && shouldSuppressRuntimeParentEdges(parentContext, options)) {
      return resolvedParentContext;
    }

    const context = createTraceContext(
      fnName,
      resolvedParentContext,
      options.edgeType || 'CALLS_AT_RUNTIME',
      {
        ...staticFnProps,
        ...options,
        parentNodeid: options.parentNodeid || originRuntimeTrace?.nodeid || originRuntimeTrace?.parentNodeid,
        sessionId: options.sessionId || originRuntimeTrace?.sessionId,
        userActionRootId: options.userActionRootId || originRuntimeTrace?.userActionRootId,
        featureTraceToken: options.featureTraceToken || originRuntimeTrace?.featureTraceToken,
        featureTraceKey: options.featureTraceKey || originRuntimeTrace?.featureTraceKey,
        featureTraceRootStableId: options.featureTraceRootStableId || originRuntimeTrace?.featureTraceRootStableId,
      },
    );

    if (originRuntimeTrace?.correlationId) {
      context.metadata = {
        ...(context.metadata || {}),
        callApiCorrelationId: context.metadata?.callApiCorrelationId || originRuntimeTrace.correlationId,
      };
    }

    if (options.emitCall === false) {
      return context;
    }

    const serializedArgs = RuntimeReporter.serializeProps(args);

    this.enqueue({
      kind: 'call',
      context,
      args: {
        ...serializedArgs,
        ...buildTraceIdLogProps(context),
      },
      options: {
        ...staticFnProps,
        ...options,
        callSiteLine: callSite?.line,
        callSiteCallee: callSite?.callee,
      },
    });

    return context;
  }

  logInstrumentationGap(fnName, callSite, options = {}) {
    if (!callSite) {
      return undefined;
    }

    const context = createTraceContext(
      `instrumentation-gap:${callSite.callee || fnName}`,
      undefined,
      INSTRUMENTATION_GAP_EDGE_TYPE,
      {},
    );

    this.enqueue({
      kind: 'boundary-event',
      context,
      props: RuntimeReporter.serializeProps({
        gapReason: 'missing-parent-context',
        callee: callSite.callee || fnName,
      }),
      options: {
        ...options,
        boundaryKind: 'instrumentation-gap',
        boundaryDirection: 'receive',
        boundaryTransport: 'callsite',
        boundaryMessageType: 'call-entry',
        callSiteLine: callSite.line,
        callSiteCallee: callSite.callee,
        auto: true,
      },
      tsMs: context.tsMs,
    });

    return context;
  }

  logCallCompletion(fnName, parentContext, payload = {}, outcome = 'ok') {
    if (!parentContext) {
      return undefined;
    }

    const context = createTraceContext(
      `${fnName}:${outcome}`,
      parentContext,
      CALL_COMPLETION_EDGE_TYPES[outcome] || CALL_COMPLETION_EDGE_TYPES.ok,
      {
        sessionId: parentContext.sessionId,
      },
    );

    this.enqueue({
      kind: 'call-completion',
      context,
      props: RuntimeReporter.serializeProps(payload),
      options: {
        completionKind: outcome,
        parentFnName: fnName,
        auto: true,
      },
      nodeProps: buildCompletedNodeProps(parentContext, outcome === 'ok' ? 'ok' : String(payload?.error || outcome)),
      tsMs: Date.now(),
    });

    return context;
  }

  logResponse(fnName, context, result = {}) {
    if (!context) {
      return;
    }

    this.logCallCompletion(fnName, context, result, 'ok');

    if (shouldSuppressRuntimeParentEdges(context)) {
      return;
    }

    this.enqueue({
      kind: 'response',
      fnName,
      context,
      result: RuntimeReporter.serializeProps(result),
      tsMs: Date.now(),
      nodeProps: buildCompletedNodeProps(context, 'ok'),
      updateOnly: true,
    });
  }

  logError(fnName, context, error) {
    if (!context) {
      return;
    }

    this.logCallCompletion(fnName, context, { error: String(error) }, 'error');

    if (shouldSuppressRuntimeParentEdges(context)) {
      return;
    }

    this.enqueue({
      kind: 'error',
      fnName,
      context,
      error: String(error),
      tsMs: Date.now(),
      nodeProps: buildCompletedNodeProps(context, String(error)),
      updateOnly: true,
    });
  }

  logStoreAffect(storeName, affect, context, props = {}) {
    const serializedProps = RuntimeReporter.serializeProps(props);
    appendStoreAffect(context, storeName, affect, serializedProps);

    this.enqueue({
      kind: 'store-affect',
      storeName,
      affect,
      context,
      props: serializedProps,
      tsMs: Date.now(),
    });
  }

  logDecision(decisionName, props = {}, parentContext, options = {}) {
    const staticFnProps = buildStaticFnProps(
      options.callerFile,
      options.staticFnName || decisionName,
      options.fnStartLine,
      options.fnStartColumn,
      options.fnEndLine,
      options.fnEndColumn,
    );
    const context = createTraceContext(decisionName, parentContext, options.edgeType || DECISION_EDGE_TYPE, {
      ...options,
      ...staticFnProps,
    });

    this.enqueue({
      kind: 'decision',
      context,
      props: RuntimeReporter.serializeProps(props),
      options,
      tsMs: context.tsMs,
    });

    return context;
  }

  logPredicateEval(predicateName, value, decisionContext, props = {}, options = {}) {
    const staticFnProps = buildStaticFnProps(
      options.callerFile,
      options.staticFnName || predicateName,
      options.fnStartLine,
      options.fnStartColumn,
      options.fnEndLine,
      options.fnEndColumn,
    );
    const context = createTraceContext(
      predicateName,
      decisionContext,
      options.edgeType || PREDICATE_EDGE_TYPE,
      {
        ...options,
        ...staticFnProps,
      },
    );

    this.enqueue({
      kind: 'predicate-eval',
      context,
      props: RuntimeReporter.serializeProps(props),
      value,
      options,
      tsMs: context.tsMs,
    });

    return context;
  }

  logBranchHit(branchName, decisionContext, props = {}, options = {}) {
    const staticFnProps = buildStaticFnProps(
      options.callerFile,
      options.staticFnName || branchName,
      options.fnStartLine,
      options.fnStartColumn,
      options.fnEndLine,
      options.fnEndColumn,
    );
    const context = createTraceContext(
      branchName,
      decisionContext,
      options.edgeType || BRANCH_EDGE_TYPE,
      {
        ...options,
        ...staticFnProps,
      },
    );

    this.enqueue({
      kind: 'branch-hit',
      context,
      props: RuntimeReporter.serializeProps(props),
      options,
      tsMs: context.tsMs,
    });

    return context;
  }

  logAsyncEvent(eventName, props = {}, parentContext, options = {}) {
    const staticFnProps = buildStaticFnProps(
      options.callerFile,
      options.staticFnName || eventName,
      options.fnStartLine,
      options.fnStartColumn,
      options.fnEndLine,
      options.fnEndColumn,
    );
    const context = createTraceContext(
      eventName,
      parentContext,
      options.edgeType || ASYNC_EVENT_EDGE_TYPE,
      {
        originRuntimeTrace: options.originRuntimeTrace,
        sessionId: options.sessionId,
        parentNodeid: options.parentNodeid,
        userActionRootId: options.userActionRootId,
        isUserActionRoot: options.isUserActionRoot,
        ...staticFnProps,
      },
    );

    this.enqueue({
      kind: 'async-event',
      context,
      props: RuntimeReporter.serializeProps(props),
      options: {
        ...options,
        ...staticFnProps,
      },
      tsMs: context.tsMs,
    });

    return context;
  }

  logBoundaryEvent(eventName, props = {}, parentContext, options = {}) {
    const staticFnProps = buildStaticFnProps(
      options.callerFile,
      options.staticFnName || eventName,
      options.fnStartLine,
      options.fnStartColumn,
      options.fnEndLine,
      options.fnEndColumn,
    );
    const context = createTraceContext(
      eventName,
      parentContext,
      options.edgeType || BOUNDARY_EVENT_EDGE_TYPE,
      {
        ...options,
        ...staticFnProps,
      },
    );

    this.enqueue({
      kind: 'boundary-event',
      context,
      props: RuntimeReporter.serializeProps(props),
      options,
      tsMs: context.tsMs,
    });

    return context;
  }

  logExceptionHandlingEvent(eventName, props = {}, parentContext, options = {}) {
    const staticFnProps = buildStaticFnProps(
      options.callerFile,
      options.staticFnName || eventName,
      options.fnStartLine,
      options.fnStartColumn,
      options.fnEndLine,
      options.fnEndColumn,
    );
    const context = createTraceContext(
      eventName,
      parentContext,
      options.edgeType || EXCEPTION_HANDLING_EDGE_TYPE,
      {
        ...options,
        ...staticFnProps,
      },
    );

    this.enqueue({
      kind: 'exception-handling-event',
      context,
      props: RuntimeReporter.serializeProps(props),
      options,
      tsMs: context.tsMs,
    });

    return context;
  }

  logControlFlowGuardEvent(eventName, props = {}, parentContext, options = {}) {
    const staticFnProps = buildStaticFnProps(
      options.callerFile,
      options.staticFnName || eventName,
      options.fnStartLine,
      options.fnStartColumn,
      options.fnEndLine,
      options.fnEndColumn,
    );
    const context = createTraceContext(
      eventName,
      parentContext,
      options.edgeType || CONTROL_FLOW_GUARD_EDGE_TYPE,
      {
        ...options,
        ...staticFnProps,
      },
    );

    this.enqueue({
      kind: 'control-flow-guard-event',
      context,
      props: RuntimeReporter.serializeProps(props),
      options,
      tsMs: context.tsMs,
    });

    return context;
  }

  logRetryTransportFallbackEvent(eventName, props = {}, parentContext, options = {}) {
    const staticFnProps = buildStaticFnProps(
      options.callerFile,
      options.staticFnName || eventName,
      options.fnStartLine,
      options.fnStartColumn,
      options.fnEndLine,
      options.fnEndColumn,
    );
    const context = createTraceContext(
      eventName,
      parentContext,
      options.edgeType || RETRY_TRANSPORT_FALLBACK_EDGE_TYPE,
      {
        ...options,
        ...staticFnProps,
      },
    );

    this.enqueue({
      kind: 'retry-transport-fallback-event',
      context,
      props: RuntimeReporter.serializeProps(props),
      options,
      tsMs: context.tsMs,
    });

    return context;
  }

  logLoopControlEvent(eventName, props = {}, parentContext, options = {}) {
    if (shouldSuppressRuntimeParentEdges(parentContext, options)) {
      return this.logPathCheckpoint(
        eventName,
        props,
        parentContext,
        {
          ...options,
          checkpointKind: options.checkpointKind || 'loop-control',
        },
      );
    }

    const context = createTraceContext(
      eventName,
      parentContext,
      options.edgeType || LOOP_CONTROL_EDGE_TYPE,
      options,
    );

    this.enqueue({
      kind: 'loop-control-event',
      context,
      props: RuntimeReporter.serializeProps(props),
      options,
      tsMs: context.tsMs,
    });

    return context;
  }

  logPathCheckpoint(checkpointName, props = {}, parentContext, options = {}) {
    const context = createTraceContext(
      checkpointName,
      parentContext,
      options.edgeType || PATH_CHECKPOINT_EDGE_TYPE,
      options,
    );

    this.enqueue({
      kind: 'path-checkpoint',
      context,
      props: RuntimeReporter.serializeProps(props),
      options,
      tsMs: context.tsMs,
    });

    return context;
  }

  takeEvents() {
    const events = [...this.events];
    this.events.length = 0;
    return events;
  }
}

export function resolveGraphParentContext(parentContext, parentContextKey) {
  if (parentContext) {
    return parentContext;
  }

  if (parentContextKey) {
    return RuntimeReporter.retrieveContext(parentContextKey);
  }

  return RuntimeReporter.stackTop();
}

function findNearestCallApiTraceContext() {
  for (let index = RuntimeReporter._stack.length - 1; index >= 0; index -= 1) {
    const context = RuntimeReporter._stack[index];
    if (context?.metadata?.callApiCorrelationId) {
      return context;
    }
  }

  return undefined;
}

export async function runTracedGraphStep(taskName, traceContext, fn, options = {}) {
  if (traceContext && options.storeContextKey) {
    RuntimeReporter.storeContext(options.storeContextKey, traceContext);
  }

  try {
    const result = await RuntimeReporter.withContext(traceContext, fn);
    RuntimeReporter.instance?.logResponse(
      taskName,
      traceContext,
      result && typeof result === 'object' ? result : { result },
    );
    return result;
  } catch (error) {
    RuntimeReporter.instance?.logError(taskName, traceContext, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    if (options.clearContextKey) {
      RuntimeReporter.deleteContext(options.clearContextKey);
    }
  }
}

function summarizeRuntimeValue(value) {
  if (
    isNullishValue(value)
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'function') {
    return {
      kind: 'function',
      name: value.name || 'anonymous',
    };
  }

  if (Array.isArray(value)) {
    return {
      kind: 'array',
      size: value.length,
      itemKinds: value.slice(0, 5).map((item) => summarizeRuntimeValue(item)?.kind || typeof item),
    };
  }

  if (typeof value === 'object') {
    const constructorName = value.constructor?.name;

    return {
      kind: constructorName || 'object',
      keys: Object.keys(value).slice(0, 5),
    };
  }

  return String(value);
}

function extractOriginRuntimeTrace(value, depth = 0, seen = new Set()) {
  if (!value || depth > 3 || typeof value !== 'object') {
    return undefined;
  }

  if (seen.has(value)) {
    return undefined;
  }

  seen.add(value);

  const directTrace = value.__runtimeTrace;
  if (directTrace && typeof directTrace === 'object') {
    return directTrace;
  }

  const entries = Array.isArray(value)
    ? value.map((item, index) => [index, item])
    : Object.entries(value);

  for (const [, nestedValue] of entries) {
    const nestedTrace = extractOriginRuntimeTrace(nestedValue, depth + 1, seen);
    if (nestedTrace) {
      return nestedTrace;
    }
  }

  return undefined;
}

function normalizeCallApiRuntimeProps(props = {}) {
  const {
    args,
    callbackArgs,
    response,
    error,
    tracePayload,
    originRuntimeTrace,
    ...rest
  } = props;

  return {
    ...rest,
    ...(Array.isArray(args) ? {
      argCount: args.length,
      argsSummary: args.map((arg) => summarizeRuntimeValue(arg)),
    } : {}),
    ...(Array.isArray(callbackArgs) ? {
      callbackArgCount: callbackArgs.length,
      callbackArgsSummary: callbackArgs.map((arg) => summarizeRuntimeValue(arg)),
    } : {}),
    ...(response !== undefined ? {
      responseSummary: summarizeRuntimeValue(response),
    } : {}),
    ...(error !== undefined ? {
      errorMessage: error?.message || String(error),
    } : {}),
  };
}

export function traceCallApiRuntimeInvoke(invoke, eventName, props = {}, parentContext, options = {}) {
  const runtimeTrace = props.originRuntimeTrace;
  const resolvedParentContext = findNearestCallApiTraceContext()
    || resolveGraphParentContext(parentContext, options.parentContextKey);
  const resolvedParentNodeid = options.parentNodeid
    || runtimeTrace?.nodeid
    || runtimeTrace?.parentNodeid;
  const resolvedUserActionRootId = options.userActionRootId
    || runtimeTrace?.userActionRootId
    || resolvedParentContext?.metadata?.userActionRootId;
  const resolvedCorrelationId = options.correlationId
    || props.correlationId
    || runtimeTrace?.correlationId
    || resolvedParentContext?.metadata?.callApiCorrelationId
    || createId();
  const resolvedResourceId = options.resourceId || props.messageId;
  const traceContext = RuntimeReporter.logAsyncEvent(
    eventName,
    normalizeCallApiRuntimeProps(props),
    resolvedParentContext,
    {
      asyncKind: 'call-api',
      asyncPhase: options.asyncPhase || eventName,
      resourceKind: options.resourceKind || 'call-api',
      resourceId: resolvedResourceId,
      correlationId: resolvedCorrelationId,
      parentNodeid: resolvedParentNodeid,
      userActionRootId: resolvedUserActionRootId,
      sessionId: runtimeTrace?.sessionId,
      originRuntimeTrace: runtimeTrace,
      ...options,
    },
  );

  traceContext.metadata = {
    ...(traceContext.metadata || {}),
    callApiCorrelationId: resolvedCorrelationId,
  };

  if (props.tracePayload && typeof props.tracePayload === 'object') {
    props.tracePayload.__runtimeTrace = {
      nodeid: traceContext.nodeid,
      parentNodeid: traceContext.parentNodeid,
      correlationId: resolvedCorrelationId,
      sessionId: traceContext.sessionId,
      userActionRootId: traceContext?.metadata?.userActionRootId,
      featureTraceToken: traceContext?.metadata?.featureTraceToken,
      featureTraceKey: traceContext?.metadata?.featureTraceKey,
      featureTraceRootStableId: traceContext?.metadata?.featureTraceRootStableId,
    };
  }

  RuntimeReporter.pushContext(traceContext);

  try {
    const result = invoke();

    if (result && typeof result.then === 'function') {
      return Promise.resolve(result).finally(() => {
        RuntimeReporter.popContext();
      });
    }

    RuntimeReporter.popContext();
    return result;
  } catch (error) {
    RuntimeReporter.popContext();
    throw error;
  }
}
