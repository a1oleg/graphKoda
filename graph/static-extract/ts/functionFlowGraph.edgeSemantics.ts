export type FlowRole = 'Control' | 'Data' | 'Structure' | 'Effect';

export type EdgeSemanticsInput = {
  label?: string;
  displayLabel?: string;
  flowLayer?: 'control' | 'data' | 'mixed' | 'structure';
  argumentName?: string;
  fieldName?: string;
};

export type EdgeSemantics = {
  displayLabel: string;
  flowRoles: FlowRole[];
  controlKind?: string;
  dataKind?: string;
  structureKind?: string;
  effectKind?: string;
};

const CONTROL_KINDS: Record<string, string> = {
  NEXT: 'sequence',
  TRUE: 'decision-outcome',
  FALSE: 'decision-outcome',
  EVAL: 'initiate',
  OPTION_CASE: 'decision-outcome',
  OPTION_DEFAULT: 'decision-outcome',
  MERGES_TO: 'merge',
  REJOINS: 'merge',
  XOR_JOIN: 'merge',
  REPEATS: 'loop',
  EXHAUSTED: 'completion',
  SHORT_CIRCUITS: 'completion',
  CALL: 'invoke',
  REQUEST: 'invoke',
  DECLARES_FUNCTION: 'declare',
  DETACHES_ASYNC: 'spawn',
  AWAITS_ASYNC: 'await',
  SUBSCRIBE: 'subscribe',
  INVOKES: 'invoke',
  ENTERS: 'enter',
};

const DATA_KINDS: Record<string, string> = {
  PARAM: 'bind',
  ARG: 'transfer',
  FIELD: 'transfer',
  EVAL: 'demand',
  RESULT: 'result',
  RESPONSE: 'result',
  REQUEST: 'demand',
  VALUE: 'value',
  CREATES_VALUE: 'create',
  RECEIVES_VALUE: 'receive',
  READS_VALUE: 'read',
  WRITES_VALUE: 'write',
  TARGETS_VALUE: 'target',
  ASSIGNS_VALUE: 'assign',
  PASSES_VALUE: 'transfer',
  MATERIALIZES_ARGUMENT: 'materialize',
  MATERIALIZES_RETURN: 'materialize',
  RETURNS_VALUE: 'return',
  CLEARS_VALUE: 'clear',
  DELETES_VALUE: 'delete',
  CAPTURES_VALUE: 'capture',
  ITERATES_VALUE: 'iterate',
  PULLS_VALUE: 'pull',
  ITEM_AVAILABLE: 'availability',
  EXTRACTS_VALUE: 'extract',
  YIELDS_VALUE: 'yield',
  EMITS_VALUE: 'emit',
  ACCUMULATES_VALUE: 'accumulate',
  DECIDES_VALUE: 'decide',
  ORDERS_VALUE: 'order',
  COMPLETES_VALUE: 'complete',
  ON_RECEIVER: 'receiver',
  PRODUCES_VALUE: 'produce',
  OF: 'source',
  ITERATOR: 'iterator',
};

const HIDDEN_TECHNICAL_LABEL_TYPES = new Set([
  'NEXT',
  'MERGES_TO',
  'REJOINS',
  'XOR_JOIN',
  'ArgJoin',
  'FieldJoin',
]);

const STRUCTURE_KINDS: Record<string, string> = {
  ArgJoin: 'argument-boundary',
  FieldJoin: 'field-boundary',
  HAS_FLOW_BLOCK: 'containment',
  NESTED_IN: 'containment',
  HAS_METHOD: 'containment',
  PROXY_OF: 'projection',
};

const EFFECT_KINDS: Record<string, string> = {
  CALL: 'call',
  REQUEST: 'request',
  READ: 'read',
  WRITE: 'write',
  WRITES: 'write',
  SUBSCRIBE: 'subscribe',
  DETACHES_ASYNC: 'spawn',
  AWAITS_ASYNC: 'await',
  ON_FAILURE: 'failure',
  PERFORMS_EFFECT: 'perform',
  EMITS_EFFECT: 'emit',
};

function inferredDisplayLabel(type: string, input: EdgeSemanticsInput) {
  if (HIDDEN_TECHNICAL_LABEL_TYPES.has(type)) return '';
  if (input.displayLabel !== undefined) return input.displayLabel;
  if (type === 'TRUE') return 'TRUE';
  if (type === 'FALSE') return input.label === 'else' ? 'else' : 'FALSE';
  if (type === 'ARG') return input.argumentName || input.label || '';
  if (type === 'FIELD') return input.fieldName || input.label || '';
  if (type === 'ARROW') return '=>';
  return input.label || '';
}

export function classifyFlowEdge(type: string, input: EdgeSemanticsInput = {}): EdgeSemantics {
  const roles: FlowRole[] = [];
  const controlKind = CONTROL_KINDS[type];
  const dataKind = DATA_KINDS[type];
  const structureKind = STRUCTURE_KINDS[type];
  const effectKind = EFFECT_KINDS[type];

  if (controlKind) roles.push('Control');
  if (dataKind) roles.push('Data');
  if (structureKind) roles.push('Structure');
  if (effectKind) roles.push('Effect');
  if (!roles.length) {
    if (input.flowLayer === 'control') roles.push('Control');
    if (input.flowLayer === 'data') roles.push('Data');
    if (input.flowLayer === 'mixed') roles.push('Control', 'Data');
    if (input.flowLayer === 'structure') roles.push('Structure');
  }
  if (!roles.length) roles.push('Data');

  return {
    displayLabel: inferredDisplayLabel(type, input),
    flowRoles: roles,
    ...(controlKind ? { controlKind } : {}),
    ...(dataKind ? { dataKind } : {}),
    ...(structureKind ? { structureKind } : {}),
    ...(effectKind ? { effectKind } : {}),
  };
}
