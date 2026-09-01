function runtimeProps(record) {
  return record?.raw?.nodeProps || {};
}

function projectEvent(record) {
  const props = runtimeProps(record);
  return {
    eventId: record.nodeId,
    predecessorEventId: record.parentNodeId || null,
    stableId: record.functionStableId || null,
    role: props.role || null,
    stageName: props.stageName || null,
    outcome: props.outcome,
    completion: props.completion || 'return',
    iterationIndex: Number.isInteger(props.iterationIndex) ? props.iterationIndex : null,
    itemPreview: props.itemPreview || null,
    valuePreview: props.valuePreview || null,
    matched: props.matched === true,
    accumulatorState: props.accumulatorState || props.accumulatorPreview || null,
    accumulatorBefore: props.accumulatorBefore || null,
    continuesAfterResult: props.continuesAfterResult === true,
    score: Number(record.score || props.tsMs || 0),
  };
}

function buildInvocationChain(records, root) {
  const childrenByParent = new Map();
  for (const record of records) {
    if (!record.parentNodeId) continue;
    const children = childrenByParent.get(record.parentNodeId) || [];
    children.push(record);
    childrenByParent.set(record.parentNodeId, children);
  }
  childrenByParent.forEach((children) => children.sort((left, right) => left.score - right.score));

  const chain = [];
  const seen = new Set();
  let current = root;
  while (current && !seen.has(current.nodeId)) {
    chain.push(current);
    seen.add(current.nodeId);
    if (
      runtimeProps(current).role === 'collection-result'
      && runtimeProps(current).continuesAfterResult !== true
    ) break;
    const children = childrenByParent.get(current.nodeId) || [];
    current = children.find((candidate) => !seen.has(candidate.nodeId)) || null;
  }
  return chain;
}

function eventSignature(event) {
  return [
    event.stableId || event.role || 'event',
    event.stageName || '',
    event.outcome === undefined ? '' : String(event.outcome),
    event.completion || '',
  ].join('|');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildEdgePairs(events) {
  const pairs = [];
  for (let index = 1; index < events.length; index += 1) {
    const sourceEvent = events[index - 1];
    const sourceStableId = sourceEvent.stableId;
    const targetStableId = events[index].stableId;
    if (!sourceStableId || !targetStableId || sourceStableId === targetStableId) continue;
    pairs.push({
      sourceStableId,
      targetStableId,
      edgeType: typeof sourceEvent.outcome === 'boolean'
        ? (sourceEvent.outcome ? 'TRUE' : 'FALSE')
        : null,
    });
  }
  return pairs;
}

function uniqueEdgePairs(pairs) {
  const seen = new Set();
  return pairs.filter((pair) => {
    const key = `${pair.sourceStableId}|${pair.targetStableId}|${pair.edgeType || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildNodeHighlights(events) {
  const byStableId = new Map();
  for (const event of events) {
    if (!event.stableId) continue;
    byStableId.set(event.stableId, {
      stableId: event.stableId,
      outcome: typeof event.outcome === 'boolean' ? event.outcome : null,
      role: event.role || null,
    });
  }
  return [...byStableId.values()];
}

function buildBranchPath(events) {
  return events
    .filter((event) => event.role === 'predicate-stage')
    .map((event) => ({
      stableId: event.stableId,
      stageName: event.stageName || 'predicate',
      outcome: event.outcome === true,
    }));
}

function branchDestination(outcome) {
  if (outcome === 'matched') return 'match';
  if (outcome === 'accepted') return 'emit';
  if (outcome === 'accumulated') return 'accumulate';
  if (outcome === 'error') return 'error';
  return 'repeat';
}

function buildBranchSignature(branchPath, destination) {
  return [
    ...branchPath.map((stage) => `${stage.stableId || stage.stageName}:${stage.outcome ? 'true' : 'false'}`),
    `destination:${destination}`,
  ].join('>');
}

function buildBranchLabel(branchPath, destination) {
  const stages = branchPath.map((stage) => `${stage.stageName} ${stage.outcome ? 'true' : 'false'}`);
  return [...stages, destination].join(' -> ');
}

function isGraphPathEvent(event) {
  return event.role !== 'collection-predicate';
}

function buildIterationBoundaryPair(events, nextEvent, resultEvent, outcome, methodName) {
  if (methodName === 'reduce') {
    const accumulate = [...events].reverse().find((event) => event.role === 'collection-accumulate');
    const targetEvent = nextEvent || resultEvent;
    if (!accumulate?.stableId || !targetEvent?.stableId || accumulate.stableId === targetEvent.stableId) return null;
    return {
      sourceStableId: accumulate.stableId,
      targetStableId: targetEvent.stableId,
      edgeType: null,
    };
  }
  const completion = [...events].reverse().find((event) => event.role === 'collection-predicate');
  if (events.some((event) => event.role === 'collection-emit')) return null;
  const targetEvent = methodName === 'filter' && outcome === 'accepted'
    ? resultEvent
    : nextEvent;
  if (methodName === 'for-of' && targetEvent?.role === 'collection-result') return null;
  const repeats = targetEvent?.role === 'collection-pop';
  const sourceEvent = repeats
    ? [...events].reverse().find(isGraphPathEvent)
    : [...events].reverse().find((event) => event.role === 'predicate-stage')
      || [...events].reverse().find(isGraphPathEvent);
  if (!completion || !sourceEvent?.stableId || !targetEvent?.stableId) return null;
  if (sourceEvent.stableId === targetEvent.stableId) return null;
  return {
    sourceStableId: sourceEvent.stableId,
    targetStableId: targetEvent.stableId,
    edgeType: repeats
      ? 'REPEATS'
      : typeof completion.outcome === 'boolean'
      ? (completion.outcome ? 'TRUE' : 'FALSE')
      : null,
  };
}

function buildIterations(chain, methodName) {
  const projectedChain = chain.map(projectEvent);
  const resultEvent = projectedChain.find((event) => event.role === 'collection-result') || null;
  const resultIndex = resultEvent ? projectedChain.indexOf(resultEvent) : -1;
  const resultContinuationEvents = resultIndex >= 0
    ? projectedChain.slice(resultIndex + 1)
    : [];
  const groups = new Map();
  for (const [chainIndex, event] of projectedChain.entries()) {
    if (event.iterationIndex === null) continue;
    const group = groups.get(event.iterationIndex) || [];
    group.push({ ...event, chainIndex });
    groups.set(event.iterationIndex, group);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, events]) => {
      const predicate = [...events].reverse().find((event) => event.role === 'collection-predicate');
      const failed = events.find((event) => event.completion === 'throw');
      const matched = predicate?.matched === true || predicate?.outcome === true;
      const outcome = failed
        ? 'error'
        : methodName === 'reduce'
          ? 'accumulated'
        : matched
          ? (methodName === 'filter' ? 'accepted' : 'matched')
          : 'rejected';
      const continuationEvents = matched ? resultContinuationEvents : [];
      const visibleResultEvent = resultEvent?.continuesAfterResult === true || methodName === 'for-of'
        ? null
        : resultEvent;
      const graphEvents = [
        ...events.filter(isGraphPathEvent),
        ...(matched && visibleResultEvent ? [visibleResultEvent] : []),
        ...continuationEvents.filter(isGraphPathEvent),
      ];
      const nextEvent = projectedChain[(events.at(-1)?.chainIndex ?? projectedChain.length) + 1] || null;
      const boundaryNextEvent = matched && resultEvent?.continuesAfterResult === true
        ? continuationEvents.find(isGraphPathEvent) || null
        : nextEvent;
      const boundaryPair = buildIterationBoundaryPair(
        events,
        boundaryNextEvent,
        visibleResultEvent,
        outcome,
        methodName,
      );
      const boundaryTargetEvent = boundaryPair?.targetStableId === resultEvent?.stableId
        ? visibleResultEvent
        : boundaryNextEvent;
      const highlightedEvents = boundaryPair && boundaryTargetEvent
        ? [...graphEvents, boundaryTargetEvent]
        : graphEvents;
      const branchPath = buildBranchPath([...events, ...continuationEvents]);
      const destination = branchDestination(outcome);
      return {
        index,
        itemPreview: events.find((event) => event.itemPreview)?.itemPreview || null,
        outcome,
        accumulatorState: [...events].reverse().find((event) => event.accumulatorState)?.accumulatorState || null,
        durationMs: Math.max(0, (events.at(-1)?.score || 0) - (events[0]?.score || 0)),
        pathSignature: [
          ...events.map(eventSignature),
          ...(boundaryPair ? [`boundary:${boundaryPair.edgeType || ''}:${boundaryPair.targetStableId}`] : []),
        ].join('>'),
        branchPath,
        destination,
        branchSignature: buildBranchSignature(branchPath, destination),
        staticStableIds: unique(highlightedEvents.map((event) => event.stableId)),
        nodeHighlights: buildNodeHighlights(highlightedEvents),
        edgePairs: uniqueEdgePairs([
          ...buildEdgePairs(graphEvents),
          ...(boundaryPair ? [boundaryPair] : []),
        ]),
        events,
      };
    });
}

function buildSegments(iterations) {
  const groups = new Map();
  for (const iteration of iterations) {
    const segment = groups.get(iteration.branchSignature) || {
      id: `segment-${groups.size + 1}`,
      pathSignature: iteration.pathSignature,
      branchSignature: iteration.branchSignature,
      branchPath: iteration.branchPath,
      destination: iteration.destination,
      label: buildBranchLabel(iteration.branchPath, iteration.destination),
      outcome: iteration.outcome,
      count: 0,
      iterationIndexes: [],
      samples: [],
      staticStableIds: iteration.staticStableIds,
      nodeHighlights: iteration.nodeHighlights,
      edgePairs: iteration.edgePairs.map((pair) => ({ ...pair, weight: 0 })),
    };
    segment.count += 1;
    segment.iterationIndexes.push(iteration.index);
    segment.samples.push({
      index: iteration.index,
      itemPreview: iteration.itemPreview,
      outcome: iteration.outcome,
      accumulatorState: iteration.accumulatorState,
      durationMs: iteration.durationMs,
    });
    segment.edgePairs.forEach((pair) => { pair.weight += 1; });
    groups.set(iteration.branchSignature, segment);
  }
  return [...groups.values()].sort((left, right) => right.count - left.count);
}

export function buildCollectionRuntimeAnalysis(records, {
  stableId,
  sessionId,
  invocationEventId,
} = {}) {
  const sorted = [...records].sort((left, right) => Number(left.score || 0) - Number(right.score || 0));
  const roots = sorted.filter((record) => (
    record.functionStableId === stableId
      && runtimeProps(record).role === 'collection-method'
      && (!sessionId || record.sessionId === sessionId)
  ));
  const selectedRoot = invocationEventId
    ? roots.find((record) => record.nodeId === invocationEventId)
    : roots.at(-1);

  if (!selectedRoot) {
    return {
      stableId: stableId || null,
      sessionId: sessionId || null,
      invocations: [],
      selectedInvocationEventId: null,
      totalIterations: 0,
      matchedIterations: 0,
      rejectedIterations: 0,
      errorIterations: 0,
      iterations: [],
      segments: [],
    };
  }

  const methodName = runtimeProps(selectedRoot).methodName || null;
  const chain = buildInvocationChain(sorted.filter((record) => record.sessionId === selectedRoot.sessionId), selectedRoot);
  const iterations = buildIterations(chain, methodName);
  if (methodName === 'filter') {
    const acceptedItems = [];
    for (const iteration of iterations) {
      if (iteration.outcome === 'accepted') acceptedItems.push(iteration.itemPreview || `#${iteration.index + 1}`);
      if (!iteration.accumulatorState) iteration.accumulatorState = `[${acceptedItems.join(', ')}]`;
    }
  }
  const successfulIterations = iterations.filter((iteration) => (
    iteration.outcome === 'matched' || iteration.outcome === 'accepted' || iteration.outcome === 'accumulated'
  )).length;
  return {
    stableId,
    sessionId: selectedRoot.sessionId,
    methodName,
    accumulatorName: runtimeProps(selectedRoot).accumulatorName || null,
    selectedInvocationEventId: selectedRoot.nodeId,
    invocations: roots.map((root) => ({
      eventId: root.nodeId,
      sessionId: root.sessionId,
      startedAt: new Date(Number(root.score || 0)).toISOString(),
      selected: root.nodeId === selectedRoot.nodeId,
    })),
    totalIterations: iterations.length,
    matchedIterations: successfulIterations,
    acceptedIterations: iterations.filter((iteration) => iteration.outcome === 'accepted').length,
    rejectedIterations: iterations.filter((iteration) => iteration.outcome === 'rejected').length,
    errorIterations: iterations.filter((iteration) => iteration.outcome === 'error').length,
    iterations,
    segments: buildSegments(iterations),
  };
}
