export type CollectionResultMode =
  | 'collection'
  | 'element'
  | 'index'
  | 'boolean'
  | 'accumulator'
  | 'void'
  | 'receiver'
  | 'unknown';

export type CollectionIterationMode =
  | 'select'
  | 'transform'
  | 'search'
  | 'quantify'
  | 'accumulate'
  | 'consume'
  | 'compare'
  | 'generic';

export type CollectionMethodSemantics = {
  methodName: string;
  iterationMode: CollectionIterationMode;
  resultMode: CollectionResultMode;
  shortCircuit: boolean;
  reverse: boolean;
  mutatesReceiver: boolean;
  itemParameterIndex: number;
  callbackResultAction: 'accept' | 'emit' | 'match' | 'decide' | 'accumulate' | 'effect' | 'order' | 'yield';
};

export type DirectCollectionAssignmentPlan =
  | {
      kind: 'select-one';
      truthy: { action: 'assign'; value: 'bound-item' };
      falsy: { action: 'repeat' };
      exhausted: { action: 'assign'; value: 'undefined' };
    }
  | {
      kind: 'collect-accepted';
      truthy: { action: 'emit'; value: 'bound-item' };
      falsy: { action: 'repeat' };
      exhausted: { action: 'finish' };
    }
  | {
      kind: 'accumulate';
      callback: { action: 'accumulate'; value: 'callback-result' };
      exhausted: { action: 'finish' };
    };

const STANDARD_COLLECTION_METHODS: Record<string, Omit<CollectionMethodSemantics, 'methodName'>> = {
  filter: {
    iterationMode: 'select',
    resultMode: 'collection',
    shortCircuit: false,
    reverse: false,
    mutatesReceiver: false,
    itemParameterIndex: 0,
    callbackResultAction: 'accept',
  },
  map: {
    iterationMode: 'transform',
    resultMode: 'collection',
    shortCircuit: false,
    reverse: false,
    mutatesReceiver: false,
    itemParameterIndex: 0,
    callbackResultAction: 'emit',
  },
  flatMap: {
    iterationMode: 'transform',
    resultMode: 'collection',
    shortCircuit: false,
    reverse: false,
    mutatesReceiver: false,
    itemParameterIndex: 0,
    callbackResultAction: 'emit',
  },
  find: {
    iterationMode: 'search',
    resultMode: 'element',
    shortCircuit: true,
    reverse: false,
    mutatesReceiver: false,
    itemParameterIndex: 0,
    callbackResultAction: 'match',
  },
  findLast: {
    iterationMode: 'search',
    resultMode: 'element',
    shortCircuit: true,
    reverse: true,
    mutatesReceiver: false,
    itemParameterIndex: 0,
    callbackResultAction: 'match',
  },
  findIndex: {
    iterationMode: 'search',
    resultMode: 'index',
    shortCircuit: true,
    reverse: false,
    mutatesReceiver: false,
    itemParameterIndex: 0,
    callbackResultAction: 'match',
  },
  findLastIndex: {
    iterationMode: 'search',
    resultMode: 'index',
    shortCircuit: true,
    reverse: true,
    mutatesReceiver: false,
    itemParameterIndex: 0,
    callbackResultAction: 'match',
  },
  some: {
    iterationMode: 'quantify',
    resultMode: 'boolean',
    shortCircuit: true,
    reverse: false,
    mutatesReceiver: false,
    itemParameterIndex: 0,
    callbackResultAction: 'decide',
  },
  every: {
    iterationMode: 'quantify',
    resultMode: 'boolean',
    shortCircuit: true,
    reverse: false,
    mutatesReceiver: false,
    itemParameterIndex: 0,
    callbackResultAction: 'decide',
  },
  reduce: {
    iterationMode: 'accumulate',
    resultMode: 'accumulator',
    shortCircuit: false,
    reverse: false,
    mutatesReceiver: false,
    itemParameterIndex: 1,
    callbackResultAction: 'accumulate',
  },
  reduceRight: {
    iterationMode: 'accumulate',
    resultMode: 'accumulator',
    shortCircuit: false,
    reverse: true,
    mutatesReceiver: false,
    itemParameterIndex: 1,
    callbackResultAction: 'accumulate',
  },
  forEach: {
    iterationMode: 'consume',
    resultMode: 'void',
    shortCircuit: false,
    reverse: false,
    mutatesReceiver: false,
    itemParameterIndex: 0,
    callbackResultAction: 'effect',
  },
  sort: {
    iterationMode: 'compare',
    resultMode: 'receiver',
    shortCircuit: false,
    reverse: false,
    mutatesReceiver: true,
    itemParameterIndex: 0,
    callbackResultAction: 'order',
  },
  toSorted: {
    iterationMode: 'compare',
    resultMode: 'collection',
    shortCircuit: false,
    reverse: false,
    mutatesReceiver: false,
    itemParameterIndex: 0,
    callbackResultAction: 'order',
  },
};

export function collectionMethodSemantics(methodName: string): CollectionMethodSemantics {
  const known = STANDARD_COLLECTION_METHODS[methodName];
  return {
    methodName,
    ...(known || {
      iterationMode: 'generic' as const,
      resultMode: 'unknown' as const,
      shortCircuit: false,
      reverse: false,
      mutatesReceiver: false,
      itemParameterIndex: 0,
      callbackResultAction: 'yield' as const,
    }),
  };
}

export function isKnownCollectionMethod(methodName: string) {
  return Object.prototype.hasOwnProperty.call(STANDARD_COLLECTION_METHODS, methodName);
}

export function collectionVirtualResultMethod(
  semantics: CollectionMethodSemantics,
): 'set' | 'push' | 'add' | 'effect' {
  if (semantics.resultMode === 'collection') return 'push';
  if (semantics.resultMode === 'accumulator') return 'add';
  if (semantics.resultMode === 'void') return 'effect';
  return 'set';
}

export function directCollectionAssignmentPlan(
  semantics: CollectionMethodSemantics,
): DirectCollectionAssignmentPlan | undefined {
  if (
    semantics.iterationMode === 'search'
    && semantics.resultMode === 'element'
    && semantics.shortCircuit
  ) {
    return {
      kind: 'select-one',
      truthy: { action: 'assign', value: 'bound-item' },
      falsy: { action: 'repeat' },
      exhausted: { action: 'assign', value: 'undefined' },
    };
  }
  if (
    semantics.iterationMode === 'select'
    && semantics.resultMode === 'collection'
    && semantics.callbackResultAction === 'accept'
  ) {
    return {
      kind: 'collect-accepted',
      truthy: { action: 'emit', value: 'bound-item' },
      falsy: { action: 'repeat' },
      exhausted: { action: 'finish' },
    };
  }
  if (
    semantics.iterationMode === 'accumulate'
    && semantics.resultMode === 'accumulator'
    && semantics.callbackResultAction === 'accumulate'
  ) {
    return {
      kind: 'accumulate',
      callback: { action: 'accumulate', value: 'callback-result' },
      exhausted: { action: 'finish' },
    };
  }
  return undefined;
}
