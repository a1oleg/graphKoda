import { getRepoRelativePath, type StableIdDescriptor } from './functionFlowGraph.infrastructure.js';

type FlowNodeKind = 'Step' | 'Eval' | 'Branch' | 'ArgBranch' | 'FieldBranch' | 'OperandBranch' | 'OperandJoin' | 'FlowBlock' | 'Loop' | 'Iteration' | 'Switch' | 'Case' | 'Action' | 'Read' | 'Write' | 'Call' | 'Op' | 'Value' | 'DataJoin' | 'Parameter' | 'Arg' | 'ArgJoin' | 'Object' | 'ObjectBrace' | 'Field' | 'FieldJoin' | 'LocalFunctionDeclaration' | 'LocalFunctionProxy' | 'FnVisualProxy' | 'DetachedAsyncCall' | 'AwaitedAsyncCall' | 'UiSurface' | 'FlowJoin' | 'BreakStop' | 'ThrowStop' | 'Return' | 'FunctionStart' | 'FunctionEnd';

const SEMANTIC_FLOW_LABELS = new Set([
  'Branch',
  'Step',
  'Flow',
  'Block',
  'Eval',
  'Loop',
  'Switch',
  'Case',
  'Read',
  'ValueSlot',
  'LocalBinding',
  'ParameterBinding',
  'Parameter',
  'CapturedBinding',
  'ModuleBinding',
  'MemoryCell',
  'ValueAccess',
  'OperationProvider',
  'ModuleFacade',
  'CapabilityBundle',
  'ValueCreate',
  'ValueReceive',
  'ValueRead',
  'ValueWrite',
  'ValuePass',
  'ValueClear',
  'ValueDelete',
  'ValueCapture',
  'ComputedValue',
  'BooleanFlag',
  'ValueOutcome',
  'TruthyOutcome',
  'FalsyOutcome',
  'UndefinedOutcome',
  'NullOutcome',
  'Async',
  'Boundary',
  'UpdaterFn',
  'CallbackFn',
  'StateUpdater',
  'Predicate',
  'Mapper',
  'Reducer',
  'Consumer',
  'Comparator',
  'Factory',
  'Callback',
  'CallbackResult',
  'CallbackEnd',
  'ExecutionOccurrence',
  'Junction',
  'ArgumentOccurrence',
  'ReturnOccurrence',
  'Failure',
  'FailureBinding',
  'Primitive',
  'Outcome',
  'Iterate',
  'Pull',
  'Bind',
  'Evaluate',
  'Emit',
  'Accumulate',
  'Effect',
  'Order',
  'Repeat',
  'Complete',
  'Assign',
  'Exhausted',
  'FnDeclaration',
  'LocalFunctionProxy',
  'FunctionProxy',
  'Fn',
  'DetachedAsyncCall',
  'AwaitedAsyncCall',
  'FireAndForget',
  'UiSurface',
  'UiInjection',
  'VirtualView',
  'VisualProxy',
  'FnVisualProxy',
  'Result',
  'System',
  'Missing',
  'MissingComponent',
  'Method',
  'Call',
  'Request',
  'Op',
  'Start',
  'Finish',
  'ArgJoin',
  'Value',
  'Data',
  'DataJoin',
  'Arg',
  'Field',
  'Operand',
  'Alternative',
  'Exclusive',
  'Obj',
  'Object',
  'ObjectBrace',
  'Join',
  'BreakStop',
  'ThrowStop',
  'Return',
  'FunctionEnd',
]);

type FlowNodeRowSubset = {
  stableId: StableIdDescriptor;
  labels: string[];
  label: string;
  diaName?: string;
  parentFnStableId: StableIdDescriptor;
  repoRelativePath: string;
  operationIndex: number;
  operationCode?: string;
  operationSubjectText?: string;
  operationValueText?: string;
  operationCalleeText?: string;
  operationDetailJson?: string;
  conditionRaw?: string;
  conditionStableId?: StableIdDescriptor;
  actionTextRaw?: string;
  callTextRaw?: string;
  calleeStableId?: StableIdDescriptor;
  calleeName?: string;
  joinKind?: string;
  mergeLabel?: string;
  incomingEdgeTypes?: string;
  synthetic?: boolean;
  callbackKind?: string;
  callbackDeferred?: boolean;
  callbackParameterNames?: string[];
  asyncSchedulerKind?: string;
  asyncContract?: string;
  stateResourceStableId?: string;
  stateResourceParentFnStableId?: string;
  stateResourceRepoRelativePath?: string;
  stateResourceName?: string;
  stateSetterName?: string;
  stateUpdateAction?: 'create' | 'write' | 'clear';
  sourceDocumentation?: string;
  uiSlotName?: string;
  virtualViewKind?: string;
  variableDeclarationKind?: string;
  valueSlotStableId?: string;
  valueSlotStableIds?: string[];
  valueName?: string;
  valueNames?: string[];
  valueScope?: string;
  valueScopes?: string[];
  valueAction?: string;
  valueActions?: string[];
  valueOperationSyntax?: string;
  valueOperationSyntaxes?: string[];
  valueAccessesJson?: string;
  foldStepOwnerStableId?: string;
  parentStepStableId?: string;
  flowStepKind?: 'statement' | 'condition' | 'execution';
  flowStepOrder?: number;
  headStableIds?: string[];
  tailStableIds?: string[];
  parentFlowBlockStableId?: string;
  ownerBranchStableIds?: string[];
  flowBlockRole?: string;
  flowBlockOutcome?: string;
  flowBlockOrder?: number;
  combinedStepFlowBlock?: boolean;
  combinedFlowBlockSourceStableId?: string;
  moduleSpecifier?: string;
  resolvedModulePath?: string;
  missingReason?: string;
  missingComponentStableId?: string;
  missingMethodName?: string;
  gatedByFeatureNames?: string[];
  collectionMethod?: string;
  collectionHeadStableId?: string;
  collectionPreviousStageStableId?: string;
  sequenceOwnerStableId?: string;
  executionProtocolStableId?: string;
  executionProtocolKind?: string;
  executionRoles?: string[];
  executionJunctionKind?: 'entry' | 'stage' | 'fork' | 'merge' | 'exit';
  executionJunctionOrder?: number;
  primitiveKind?: string;
  executionOutcome?: string;
  runtimeEventKind?: string;
  instrumentationStrategy?: string;
  instrumentationPhase?: string;
  instrumentationTargetStableId?: string;
  renderHidden?: boolean;
  sourceCallStableId?: string;
  canonicalStableId?: string;
  originalStableId?: string;
  proxyPredecessorStableIds?: string[];
  bindingStableId?: string;
  resultOfCallStableId?: string;
  resultTypeText?: string;
  parameterName?: string;
  parameterTypeText?: string;
  objectFamilyStableId?: string;
  objectBraceSide?: 'left' | 'right';
  objectBracePairIndex?: number;
  objectBracePairCount?: number;
  objectBraceFieldIndicesJson?: string;
  opensObjectFieldFamily?: boolean;
  annotationKind?: string;
};

type BuildFlowNodeRowArgs = {
  kind: FlowNodeKind;
  stableId: StableIdDescriptor;
  label: string;
  parentFnStableId: StableIdDescriptor;
  sourceFilePath: string;
  operationIndex: number;
  operationFields: Partial<FlowNodeRowSubset>;
  extra: Partial<FlowNodeRowSubset>;
};

function getFlowNodeLabels(kind: FlowNodeKind) {
  const labels: string[] = [];
  if (kind === 'Step') {
    labels.push('Step');
  } else if (kind === 'Eval') {
    labels.push('Eval');
  } else if (kind === 'Branch') {
    labels.push('Flow', 'Branch');
  } else if (kind === 'ArgBranch') {
    labels.push('Arg', 'Data', 'Branch');
  } else if (kind === 'FieldBranch') {
    labels.push('Field', 'Data', 'Branch');
  } else if (kind === 'OperandBranch') {
    labels.push('Operand', 'Data', 'Branch');
  } else if (kind === 'OperandJoin') {
    labels.push('Operand', 'Join');
  } else if (kind === 'FlowBlock') {
    labels.push('Flow', 'Block');
  } else if (kind === 'Loop') {
    labels.push('Loop');
  } else if (kind === 'Iteration') {
    labels.push('Iteration');
  } else if (kind === 'Switch') {
    labels.push('Switch');
  } else if (kind === 'Case') {
    labels.push('Case');
  } else if (kind === 'Call') {
    labels.push('Call');
  } else if (kind === 'Action') {
    labels.push('Action');
  } else if (kind === 'Read') {
    labels.push('Read');
  } else if (kind === 'Write') {
    labels.push('Write');
  } else if (kind === 'Op') {
    labels.push('Op');
  } else if (kind === 'Value') {
    labels.push('Value');
  } else if (kind === 'DataJoin') {
    labels.push('DataJoin');
  } else if (kind === 'Parameter') {
    labels.push('Parameter');
  } else if (kind === 'Arg') {
    labels.push('Arg');
  } else if (kind === 'ArgJoin') {
    labels.push('Arg', 'Join');
  } else if (kind === 'Object') {
    labels.push('Object');
  } else if (kind === 'ObjectBrace') {
    labels.push('ObjectBrace', 'Object');
  } else if (kind === 'Field') {
    labels.push('Field');
  } else if (kind === 'FieldJoin') {
    labels.push('Field', 'Join');
  } else if (kind === 'LocalFunctionDeclaration') {
    labels.push('FnDeclaration');
  } else if (kind === 'LocalFunctionProxy') {
    labels.push('LocalFunctionProxy');
  } else if (kind === 'FnVisualProxy') {
    labels.push('VisualProxy', 'FnVisualProxy');
  } else if (kind === 'DetachedAsyncCall') {
    labels.push('DetachedAsyncCall');
  } else if (kind === 'AwaitedAsyncCall') {
    labels.push('AwaitedAsyncCall');
  } else if (kind === 'UiSurface') {
    labels.push('UiSurface');
  } else if (kind === 'FlowJoin') {
    labels.push('Flow', 'Join');
  } else if (kind === 'BreakStop') {
    labels.push('BreakStop');
  } else if (kind === 'ThrowStop') {
    labels.push('ThrowStop');
  } else if (kind === 'Return') {
    labels.push('Return');
  } else if (kind === 'FunctionStart') {
    labels.push('FunctionStart');
  } else if (kind === 'FunctionEnd') {
    labels.push('FunctionEnd');
  }

  return labels;
}

function uniqueLabels(labels: string[]) {
  return [...new Set(labels.filter((label) => typeof label === 'string' && label.trim()).map((label) => label.trim()))];
}

function resolveFlowNodeLabels(kind: FlowNodeKind, extraLabels: string[] | undefined) {
  let labels = uniqueLabels([
    ...getFlowNodeLabels(kind),
    ...(extraLabels || []),
  ]);
  if (labels.includes('Branch') && labels.includes('Data')
    && labels.some((label) => label === 'Arg' || label === 'Field' || label === 'Operand')) {
    labels = labels.filter((label) => label !== 'Flow');
  }
  if (labels.includes('Join') && labels.includes('Data')
    && labels.some((label) => label === 'Arg' || label === 'Field' || label === 'Operand')) {
    labels = labels.filter((label) => label !== 'Flow');
  }
  return labels;
}

function resolveCallLabels(row: FlowNodeRowSubset): FlowNodeRowSubset {
  if (!row.calleeStableId) {
    return row;
  }
  const labels = new Set(row.labels || []);
  if (labels.has('Async') && (labels.has('Call') || labels.has('Request'))
    || labels.has('DetachedAsyncCall')
    || labels.has('AwaitedAsyncCall')) {
    labels.delete('Step');
    return {
      ...row,
      labels: [...labels],
    };
  }
  if (!labels.has('Step') && !labels.has('Call') && !labels.has('Request')) {
    return row;
  }
  labels.delete('Step');
  if (labels.has('Request')) {
    labels.delete('Call');
  } else {
    labels.add('Call');
  }
  return {
    ...row,
    labels: [...labels],
  };
}

export function buildFlowNodeRow(args: BuildFlowNodeRowArgs): FlowNodeRowSubset {
  const {
    kind,
    stableId,
    label,
    parentFnStableId,
    sourceFilePath,
    operationIndex,
    operationFields,
    extra,
  } = args;

  const resolvedLabels = resolveFlowNodeLabels(kind, extra.labels);
  const { labels: _ignoredExtraLabels, ...extraWithoutLabels } = extra;

  return resolveCallLabels({
    stableId,
    labels: resolvedLabels,
    label,
    parentFnStableId,
    repoRelativePath: getRepoRelativePath(sourceFilePath),
    operationIndex,
    ...operationFields,
    ...extraWithoutLabels,
  });
}
