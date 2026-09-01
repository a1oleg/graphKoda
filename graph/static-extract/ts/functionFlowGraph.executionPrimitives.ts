import type {
  CollectionMethodSemantics,
} from './functionFlowGraph.collectionSemantics.js';

export type ExecutionPrimitiveKind =
  | 'iterate'
  | 'pull'
  | 'bind'
  | 'evaluate'
  | 'branch'
  | 'emit'
  | 'accumulate'
  | 'effect'
  | 'order'
  | 'repeat'
  | 'complete'
  | 'declare'
  | 'assign'
  | 'read'
  | 'write'
  | 'invoke';

export type ExecutionOutcomeKind =
  | 'item-available'
  | 'exhausted'
  | 'accepted'
  | 'rejected'
  | 'short-circuit'
  | 'completed';

export type InstrumentationStrategy =
  | 'call-wrapper'
  | 'callback-wrapper'
  | 'expression-wrapper'
  | 'assignment-wrapper'
  | 'branch-wrapper'
  | 'structural-only';

export type InstrumentationPhase =
  | 'before'
  | 'after'
  | 'around'
  | 'callback-enter'
  | 'callback-exit'
  | 'branch-outcome';

export type ExecutionPrimitiveSpec = {
  kind: ExecutionPrimitiveKind;
  label: string;
  runtimeEventKind: string;
  instrumentationStrategy: InstrumentationStrategy;
  flowLayer: 'control' | 'data' | 'mixed';
};

export type CollectionExecutionProtocol = {
  iterate: ExecutionPrimitiveSpec;
  pull: ExecutionPrimitiveSpec;
  callback: ExecutionPrimitiveSpec;
  callbackResult: ExecutionPrimitiveSpec;
  repeat: ExecutionPrimitiveSpec;
  complete: ExecutionPrimitiveSpec;
  itemOutcome: ExecutionOutcomeKind;
  exhaustedOutcome: ExecutionOutcomeKind;
  shortCircuitOutcome?: ExecutionOutcomeKind;
};

const PRIMITIVES: Record<ExecutionPrimitiveKind, ExecutionPrimitiveSpec> = {
  iterate: {
    kind: 'iterate',
    label: 'iterate',
    runtimeEventKind: 'iteration.enter',
    instrumentationStrategy: 'call-wrapper',
    flowLayer: 'mixed',
  },
  pull: {
    kind: 'pull',
    label: 'pull',
    runtimeEventKind: 'iteration.pull',
    instrumentationStrategy: 'callback-wrapper',
    flowLayer: 'mixed',
  },
  bind: {
    kind: 'bind',
    label: 'bind',
    runtimeEventKind: 'value.bind',
    instrumentationStrategy: 'callback-wrapper',
    flowLayer: 'data',
  },
  evaluate: {
    kind: 'evaluate',
    label: 'evaluate',
    runtimeEventKind: 'expression.evaluate',
    instrumentationStrategy: 'expression-wrapper',
    flowLayer: 'mixed',
  },
  branch: {
    kind: 'branch',
    label: 'branch',
    runtimeEventKind: 'control.branch',
    instrumentationStrategy: 'branch-wrapper',
    flowLayer: 'control',
  },
  emit: {
    kind: 'emit',
    label: 'emit',
    runtimeEventKind: 'iteration.emit',
    instrumentationStrategy: 'callback-wrapper',
    flowLayer: 'data',
  },
  accumulate: {
    kind: 'accumulate',
    label: 'accumulate',
    runtimeEventKind: 'iteration.accumulate',
    instrumentationStrategy: 'callback-wrapper',
    flowLayer: 'data',
  },
  effect: {
    kind: 'effect',
    label: 'effect',
    runtimeEventKind: 'iteration.effect',
    instrumentationStrategy: 'callback-wrapper',
    flowLayer: 'mixed',
  },
  order: {
    kind: 'order',
    label: 'order',
    runtimeEventKind: 'iteration.compare',
    instrumentationStrategy: 'callback-wrapper',
    flowLayer: 'mixed',
  },
  repeat: {
    kind: 'repeat',
    label: 'repeat',
    runtimeEventKind: 'iteration.repeat',
    instrumentationStrategy: 'callback-wrapper',
    flowLayer: 'control',
  },
  complete: {
    kind: 'complete',
    label: 'complete',
    runtimeEventKind: 'iteration.complete',
    instrumentationStrategy: 'call-wrapper',
    flowLayer: 'mixed',
  },
  declare: {
    kind: 'declare',
    label: 'declare',
    runtimeEventKind: 'value.declare',
    instrumentationStrategy: 'assignment-wrapper',
    flowLayer: 'data',
  },
  assign: {
    kind: 'assign',
    label: 'assign',
    runtimeEventKind: 'value.assign',
    instrumentationStrategy: 'assignment-wrapper',
    flowLayer: 'data',
  },
  read: {
    kind: 'read',
    label: 'read',
    runtimeEventKind: 'storage.read',
    instrumentationStrategy: 'call-wrapper',
    flowLayer: 'data',
  },
  write: {
    kind: 'write',
    label: 'write',
    runtimeEventKind: 'storage.write',
    instrumentationStrategy: 'call-wrapper',
    flowLayer: 'mixed',
  },
  invoke: {
    kind: 'invoke',
    label: 'invoke',
    runtimeEventKind: 'call.invoke',
    instrumentationStrategy: 'call-wrapper',
    flowLayer: 'control',
  },
};

export function executionPrimitive(kind: ExecutionPrimitiveKind): ExecutionPrimitiveSpec {
  return PRIMITIVES[kind];
}

function collectionResultPrimitive(semantics: CollectionMethodSemantics): ExecutionPrimitiveKind {
  switch (semantics.callbackResultAction) {
    case 'accept':
    case 'emit':
    case 'yield':
      return 'emit';
    case 'accumulate':
      return 'accumulate';
    case 'effect':
      return 'effect';
    case 'order':
      return 'order';
    case 'match':
    case 'decide':
      return 'branch';
    default:
      return 'evaluate';
  }
}

export function collectionExecutionProtocol(
  semantics: CollectionMethodSemantics,
): CollectionExecutionProtocol {
  return {
    iterate: executionPrimitive('iterate'),
    pull: executionPrimitive('pull'),
    callback: executionPrimitive('evaluate'),
    callbackResult: executionPrimitive(collectionResultPrimitive(semantics)),
    repeat: executionPrimitive('repeat'),
    complete: executionPrimitive('complete'),
    itemOutcome: 'item-available',
    exhaustedOutcome: 'exhausted',
    shortCircuitOutcome: semantics.shortCircuit ? 'short-circuit' : undefined,
  };
}
