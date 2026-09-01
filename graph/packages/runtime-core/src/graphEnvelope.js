export const GRAPH_ENVELOPE_SCHEMA_VERSION = 1;

function deriveAsyncResourceSemanticId(event, fallbackAsyncProps) {
  if (event.options?.resourceSemanticId || fallbackAsyncProps?.resourceSemanticId) {
    return event.options?.resourceSemanticId || fallbackAsyncProps.resourceSemanticId;
  }

  if (event.options?.asyncKind === 'deferred') {
    return 'deferred';
  }

  return undefined;
}

function deriveAsyncResourceSemanticDetailId(event) {
  if (event.options?.resourceSemanticDetailId) {
    return event.options.resourceSemanticDetailId;
  }

  if (event.options?.asyncKind === 'deferred' && event.options?.asyncPhase) {
    return `deferred:${event.options.asyncPhase}`;
  }

  return undefined;
}

function cleanProps(raw = {}) {
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined));
}

function buildFallbackResourceId(scope, id) {
  if (scope === undefined && id === undefined) {
    return undefined;
  }

  if (id === undefined) {
    return String(scope);
  }

  return `${String(scope)}:${String(id)}`;
}

function deriveFallbackAsyncProps(event) {
  if (event.kind !== 'retry-transport-fallback-event') {
    return {};
  }

  if (event.options?.fallbackKind === 'abort-request-fallback') {
    return cleanProps({
      asyncKind: 'abort',
      asyncPhase: event.options?.fallbackPhase || 'abort',
      resourceKind: 'async-control',
      resourceId: buildFallbackResourceId(event.options?.abortScope || 'request', event.options?.timeoutId),
      resourceSemanticId: `abort:${event.options?.abortScope || 'request'}`,
    });
  }

  if (event.options?.fallbackKind === 'timeout-fire-fallback' || event.options?.fallbackKind === 'timeout-clear-fallback') {
    const asyncPhase = event.options?.fallbackPhase || (event.options?.fallbackKind === 'timeout-clear-fallback' ? 'clear' : 'fire');

    return cleanProps({
      asyncKind: 'timeout',
      asyncPhase,
      resourceKind: asyncPhase === 'clear' ? 'async-control' : 'async-event',
      resourceId: buildFallbackResourceId(event.options?.timeoutScope || 'timeout', event.options?.timeoutId),
      resourceSemanticId: `timeout:${event.options?.timeoutScope || 'timeout'}`,
    });
  }

  return {};
}

function buildEnvelopeMeta({ nodeid, parentNodeid, edgeType, nodeProps, updateOnly }) {
  return cleanProps({
    nodeid,
    parentNodeid: parentNodeid || '',
    edgeType: edgeType || 'CALLS_AT_RUNTIME',
    sessionId: nodeProps?.sessionId,
    configId: nodeProps?.configId,
    kind: nodeProps?.kind,
    fnName: nodeProps?.fnName,
    gitRevision: nodeProps?.gitRevision,
    tsMs: nodeProps?.tsMs,
    updateOnly,
  });
}

function buildEnvelopeFlat({ nodeid, parentNodeid, edgeType, nodeProps, labels, updateOnly }) {
  return cleanProps({
    nodeid,
    parentNodeid: parentNodeid || '',
    edgeType: edgeType || 'CALLS_AT_RUNTIME',
    sessionId: nodeProps?.sessionId,
    configId: nodeProps?.configId,
    kind: nodeProps?.kind,
    fnName: nodeProps?.fnName,
    gitRevision: nodeProps?.gitRevision,
    tsMs: nodeProps?.tsMs,
    filePath: nodeProps?.filePath,
    staticFilePath: nodeProps?.staticFilePath,
    ownerFnStableId: nodeProps?.ownerFnStableId,
    stableId: nodeProps?.stableId,
    fnStartLine: nodeProps?.fnStartLine,
    staticFnStartLine: nodeProps?.staticFnStartLine,
    decisionId: nodeProps?.decisionId,
    predicateId: nodeProps?.predicateId,
    branchId: nodeProps?.branchId,
    storeKey: nodeProps?.storeKey,
    asyncKind: nodeProps?.asyncKind,
    asyncPhase: nodeProps?.asyncPhase,
    boundaryKind: nodeProps?.boundaryKind,
    boundaryDirection: nodeProps?.boundaryDirection,
    boundaryTransport: nodeProps?.boundaryTransport,
    boundaryPairId: nodeProps?.boundaryPairId,
    resourceKind: nodeProps?.resourceKind,
    resourceId: nodeProps?.resourceId,
    resourceSemanticId: nodeProps?.resourceSemanticId,
    resourceSemanticDetailId: nodeProps?.resourceSemanticDetailId,
    correlationId: nodeProps?.correlationId,
    completionKind: nodeProps?.completionKind,
    guardDecisionId: nodeProps?.guardDecisionId,
    guardPredicateId: nodeProps?.guardPredicateId,
    guardBranchId: nodeProps?.guardBranchId,
    retryAttempt: nodeProps?.retryAttempt,
    retryMaxAttempts: nodeProps?.retryMaxAttempts,
    loopId: nodeProps?.loopId,
    loopRole: nodeProps?.loopRole,
    updateOnly,
    labels,
  });
}

function buildNodeProps(event) {
  const fallbackAsyncProps = deriveFallbackAsyncProps(event);
  const inheritedCallApiCorrelationId = event.context?.metadata?.callApiCorrelationId;

  return cleanProps({
    fnName: event.context?.fnName || event.fnName || event.storeName,
    name: event.storeName,
    storeKey: event.storeName,
    affectType: event.affect,
    depth: event.context?.depth || 0,
    tsMs: event.tsMs || event.context?.tsMs || Date.now(),
    sessionId: event.context?.sessionId,
    configId: event.context?.configId,
    gitRevision: event.context?.gitRevision,
    buildGitRevision: event.context?.gitRevision,
    thread: event.context?.thread,
    lane: event.context?.lane,
    kind: event.kind,
    value: event.value,
    fileName: event.options?.fileName,
    filePath: event.options?.filePath,
    ownerFnStableId: event.options?.ownerFnStableId || event.options?.fnStableId,
    stableId: event.options?.stableId,
    fnStartLine: event.options?.fnStartLine,
    fnEndLine: event.options?.fnEndLine,
    staticFnName: event.options?.staticFnName,
    staticFilePath: event.options?.staticFilePath,
    staticFnStartLine: event.options?.staticFnStartLine,
    staticFnEndLine: event.options?.staticFnEndLine,
    decisionId: event.options?.decisionId,
    decisionKind: event.options?.decisionKind,
    predicateId: event.options?.predicateId,
    predicateKind: event.options?.predicateKind,
    branchId: event.options?.branchId,
    branchKind: event.options?.branchKind,
    asyncKind: event.options?.asyncKind || fallbackAsyncProps.asyncKind,
    asyncPhase: event.options?.asyncPhase || fallbackAsyncProps.asyncPhase,
    resourceKind: event.options?.resourceKind || fallbackAsyncProps.resourceKind,
    resourceId: event.options?.resourceId || fallbackAsyncProps.resourceId,
    resourceSemanticId: deriveAsyncResourceSemanticId(event, fallbackAsyncProps),
    resourceSemanticDetailId: deriveAsyncResourceSemanticDetailId(event),
    correlationId: event.options?.correlationId || inheritedCallApiCorrelationId,
    timeoutMs: event.options?.timeoutMs,
    boundaryKind: event.options?.boundaryKind,
    boundaryDirection: event.options?.boundaryDirection,
    boundaryTransport: event.options?.boundaryTransport,
    boundaryMessageType: event.options?.boundaryMessageType,
    boundaryChannel: event.options?.boundaryChannel,
    boundaryPairId: event.options?.boundaryPairId,
    completionKind: event.options?.completionKind,
    boundaryUrl: event.options?.boundaryUrl,
    payloadCount: event.options?.payloadCount,
    exceptionWrapperId: event.options?.exceptionWrapperId,
    exceptionClauseKind: event.options?.exceptionClauseKind,
    exceptionCatchBinding: event.options?.exceptionCatchBinding,
    guardDecisionId: event.options?.guardDecisionId,
    guardPredicateId: event.options?.guardPredicateId,
    guardBranchId: event.options?.guardBranchId,
    guardBranchKind: event.options?.guardBranchKind,
    guardExitKind: event.options?.guardExitKind,
    fallbackKind: event.options?.fallbackKind,
    triggerKind: event.options?.triggerKind,
    fallbackPhase: event.options?.fallbackPhase,
    retryAttempt: event.options?.retryAttempt,
    retryMaxAttempts: event.options?.retryMaxAttempts,
    retryDelayMs: event.options?.retryDelayMs,
    retryTarget: event.options?.retryTarget,
    requestName: event.options?.requestName,
    abortScope: event.options?.abortScope,
    abortReason: event.options?.abortReason,
    timeoutScope: event.options?.timeoutScope,
    timeoutId: event.options?.timeoutId,
    loopId: event.options?.loopId,
    loopKind: event.options?.loopKind,
    loopRole: event.options?.loopRole,
    loopPhase: event.options?.loopPhase,
    iterationIndex: event.options?.iterationIndex,
    auto: event.options?.auto,
    layerGroup: event.options?.layerGroup,
    layerTags: event.options?.layerTags,
    ...(fallbackAsyncProps || {}),
    ...(event.nodeProps || {}),
  });
}

function buildLabels(event) {
  if (event.kind === 'loop-control-event') {
    return [
      'RunTime',
      'LoopControlEvent',
      ...(event.options?.loopRole === 'retry' ? ['RetryLoopControlEvent'] : []),
      ...(event.options?.loopRole === 'poll' ? ['PollLoopControlEvent'] : []),
      ...(event.options?.loopRole === 'drain' ? ['DrainLoopControlEvent'] : []),
    ];
  }

  if (event.kind === 'retry-transport-fallback-event') {
    const fallbackAsyncProps = deriveFallbackAsyncProps(event);

    return [
      'RunTime',
      'RetryTransportFallbackEvent',
      ...(fallbackAsyncProps.asyncKind ? ['AsyncEvent'] : []),
      ...(fallbackAsyncProps.asyncKind === 'abort' ? ['AbortAsyncEvent'] : []),
      ...(fallbackAsyncProps.asyncKind === 'timeout' ? ['TimeoutAsyncEvent'] : []),
      ...(event.options?.fallbackKind === 'retry-on-timeout' ? ['RetryOnTimeoutFallbackEvent'] : []),
      ...(event.options?.fallbackKind === 'reconnect-api-fallback' ? ['ReconnectApiFallbackEvent'] : []),
      ...(event.options?.fallbackKind === 'abort-request-fallback' ? ['AbortRequestFallbackEvent'] : []),
      ...(event.options?.fallbackKind === 'timeout-fire-fallback' ? ['TimeoutFireFallbackEvent'] : []),
      ...(event.options?.fallbackKind === 'timeout-clear-fallback' ? ['TimeoutClearFallbackEvent'] : []),
    ];
  }

  if (event.kind === 'control-flow-guard-event') {
    return [
      'RunTime',
      'ControlFlowGuardEvent',
      ...(event.options?.guardExitKind === 'return' ? ['ReturnGuardEvent'] : []),
      ...(event.options?.guardExitKind === 'return-undefined' ? ['UndefinedReturnGuardEvent'] : []),
    ];
  }

  if (event.kind === 'exception-handling-event') {
    return [
      'RunTime',
      'ExceptionHandlingEvent',
      ...(event.options?.exceptionClauseKind === 'try' ? ['TryBlockExceptionHandlingEvent'] : []),
      ...(event.options?.exceptionClauseKind === 'catch' ? ['CatchClauseExceptionHandlingEvent'] : []),
      ...(event.options?.exceptionClauseKind === 'finally' ? ['FinallyBlockExceptionHandlingEvent'] : []),
    ];
  }

  if (event.kind === 'boundary-event') {
    return [
      'RunTime',
      'BoundaryEvent',
      ...(event.options?.boundaryKind === 'worker' ? ['WorkerBoundaryEvent'] : []),
      ...(event.options?.boundaryKind === 'broadcast-channel' ? ['BroadcastChannelBoundaryEvent'] : []),
      ...(event.options?.boundaryKind === 'relay' ? ['RelayBoundaryEvent'] : []),
      ...(event.options?.boundaryKind === 'beacon' ? ['BeaconBoundaryEvent'] : []),
      ...(event.options?.boundaryKind === 'instrumentation-gap' ? ['InstrumentationGapBoundaryEvent'] : []),
    ];
  }

  if (event.kind === 'async-event') {
    return [
      'RunTime',
      'AsyncEvent',
      ...(event.options?.asyncKind === 'deferred' ? ['DeferredAsyncEvent'] : []),
      ...(event.options?.asyncKind === 'queue' ? ['QueueAsyncEvent'] : []),
      ...(event.options?.asyncKind === 'timeout' ? ['TimeoutAsyncEvent'] : []),
    ];
  }

  if (event.kind === 'store-affect') {
    return ['RunTime', 'StoreAffect'];
  }

  if (event.kind === 'decision') {
    return ['RunTime', 'Decision'];
  }

  if (event.kind === 'predicate-eval') {
    return ['RunTime', 'PredicateEval'];
  }

  if (event.kind === 'branch-hit') {
    return ['RunTime', 'BranchHit'];
  }

  if (event.kind === 'path-checkpoint') {
    return ['RunTime', 'PathCheckpoint'];
  }

  if (event.kind === 'call-completion') {
    return [
      'RunTime',
      'Fn',
      'CallCompletion',
      ...(event.options?.completionKind === 'ok' ? ['CallReturnCompletion'] : []),
      ...(event.options?.completionKind === 'error' ? ['CallErrorCompletion'] : []),
    ];
  }

  return ['RunTime', 'Fn'];
}

function buildCallRow(event) {
  const labels = buildLabels(event);
  const nodeProps = buildNodeProps(event);
  const parentNodeid = event.context.parentNodeid || '';
  const edgeType = event.context.edgeType || 'CALLS_AT_RUNTIME';

  return {
    schemaVersion: GRAPH_ENVELOPE_SCHEMA_VERSION,
    nodeid: event.context.nodeid,
    labels,
    nodeProps,
    parentNodeid,
    edgeType,
    requestProps: cleanProps({
      ...(event.args || event.props || {}),
      callSiteLine: event.options?.callSiteLine,
      callSiteCallee: event.options?.callSiteCallee,
    }),
    hasResponse: false,
    responseProps: {},
    updateOnly: false,
    meta: buildEnvelopeMeta({
      nodeid: event.context.nodeid,
      parentNodeid,
      edgeType,
      nodeProps,
      updateOnly: false,
    }),
    flat: buildEnvelopeFlat({
      nodeid: event.context.nodeid,
      parentNodeid,
      edgeType,
      nodeProps,
      labels,
      updateOnly: false,
    }),
  };
}

function buildUpdateRow(event) {
  const labels = buildLabels(event);
  const nodeProps = cleanProps({
    ...buildNodeProps(event),
    ...(event.nodeProps || {}),
  });
  const parentNodeid = event.context.parentNodeid || '';
  const edgeType = event.context.edgeType || 'CALLS_AT_RUNTIME';

  return {
    schemaVersion: GRAPH_ENVELOPE_SCHEMA_VERSION,
    nodeid: event.context.nodeid,
    labels,
    nodeProps,
    parentNodeid,
    edgeType,
    requestProps: {},
    hasResponse: true,
    responseProps: cleanProps(event.result || (event.error ? { error: event.error } : {})),
    updateOnly: true,
    meta: buildEnvelopeMeta({
      nodeid: event.context.nodeid,
      parentNodeid,
      edgeType,
      nodeProps,
      updateOnly: true,
    }),
    flat: buildEnvelopeFlat({
      nodeid: event.context.nodeid,
      parentNodeid,
      edgeType,
      nodeProps,
      labels,
      updateOnly: true,
    }),
  };
}

export function buildRuntimeEnvelope(event) {
  if (!event?.context?.nodeid) {
    return undefined;
  }

  if (event.kind === 'call' || event.kind === 'decision' || event.kind === 'predicate-eval' || event.kind === 'branch-hit' || event.kind === 'path-checkpoint' || event.kind === 'store-affect' || event.kind === 'async-event' || event.kind === 'boundary-event' || event.kind === 'exception-handling-event' || event.kind === 'control-flow-guard-event' || event.kind === 'retry-transport-fallback-event' || event.kind === 'loop-control-event' || event.kind === 'call-completion') {
    return buildCallRow(event);
  }

  if (event.kind === 'response' || event.kind === 'error') {
    return buildUpdateRow(event);
  }

  return undefined;
}

export function buildRuntimeEnvelopes(events) {
  return events
    .map(buildRuntimeEnvelope)
    .filter(Boolean);
}

export function isRuntimeEnvelope(entry) {
  return Boolean(
    entry
    && typeof entry === 'object'
    && (entry.nodeid || entry.meta?.nodeid || entry.entities?.[0]?.id)
    && (Array.isArray(entry.entities) || Array.isArray(entry.labels))
  );
}

export function buildRuntimeEnvelopeFromLegacyRow(row) {
  if (!row?.nodeid) {
    return undefined;
  }

  return {
    schemaVersion: GRAPH_ENVELOPE_SCHEMA_VERSION,
    nodeid: row.nodeid,
    labels: row.labels || [],
    nodeProps: cleanProps(row.nodeProps || {}),
    parentNodeid: row.parentNodeid || '',
    edgeType: row.edgeType || 'CALLS_AT_RUNTIME',
    requestProps: cleanProps(row.requestProps || {}),
    hasResponse: Boolean(row.hasResponse),
    responseProps: cleanProps(row.responseProps || {}),
    updateOnly: Boolean(row.updateOnly),
    meta: cleanProps({
      nodeid: row.nodeid,
      parentNodeid: row.parentNodeid || '',
      edgeType: row.edgeType || 'CALLS_AT_RUNTIME',
      sessionId: row.nodeProps?.sessionId,
      configId: row.nodeProps?.configId,
      kind: row.nodeProps?.kind,
      fnName: row.nodeProps?.fnName,
      gitRevision: row.nodeProps?.gitRevision,
      tsMs: row.nodeProps?.tsMs,
      updateOnly: Boolean(row.updateOnly),
    }),
    flat: buildEnvelopeFlat({
      nodeid: row.nodeid,
      parentNodeid: row.parentNodeid || '',
      edgeType: row.edgeType || 'CALLS_AT_RUNTIME',
      nodeProps: cleanProps(row.nodeProps || {}),
      labels: row.labels || [],
      updateOnly: Boolean(row.updateOnly),
    }),
    entities: [{
      id: row.nodeid,
      labels: row.labels || [],
      props: cleanProps(row.nodeProps || {}),
    }],
    relations: [
      ...(!row.updateOnly && row.parentNodeid ? [{
        fromId: row.parentNodeid,
        toId: row.nodeid,
        type: row.edgeType || 'CALLS_AT_RUNTIME',
        props: cleanProps(row.requestProps || {}),
      }] : []),
      ...(row.hasResponse && row.parentNodeid ? [{
        fromId: row.nodeid,
        toId: row.parentNodeid,
        type: 'response',
        props: cleanProps(row.responseProps || {}),
      }] : []),
    ],
    anchors: [
      ...(row.nodeProps?.staticFilePath || row.nodeProps?.filePath ? (
        (row.nodeProps?.staticFnStartLine || row.nodeProps?.fnStartLine)
          ? [{
              fromId: row.nodeid,
              type: 'STATIC_DEF',
              target: {
                labelExpression: 'Static:Fn',
                matchProps: {
                  file_path: row.nodeProps.staticFilePath || row.nodeProps.filePath,
                  start_line: row.nodeProps.staticFnStartLine || row.nodeProps.fnStartLine,
                },
              },
            }]
          : []
      ) : []),
    ],
  };
}