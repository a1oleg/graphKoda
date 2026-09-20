const DEFAULT_POLICY = Object.freeze({
  annotationUse: null,
  flowTraversal: true,
  flowVisible: true,
  flowComposition: false,
  functionalTraversal: true,
  functionalVisible: true,
});

const DEFINITIONS = {
  SIGNATURE_PARAMETER: { annotationUse: 'binding', flowTraversal: true },
  SIGNATURE_RETURN: { annotationUse: 'type', flowTraversal: true },
  RETURN_TYPE_ARGUMENT: { annotationUse: 'type', flowTraversal: false },
  BODY_ENTRY: { annotationUse: null, flowTraversal: true },
  AST_CHILD: { flowTraversal: false, flowVisible: false, functionalVisible: false },
  COMPOSES_SYNTAX: {
    annotationUse: 'canonical-bridge',
    flowTraversal: false,
    flowVisible: false,
    flowComposition: true,
    functionalVisible: false,
  },
  HAS_FLOW_BLOCK: { flowTraversal: false, flowVisible: false },
  HAS_OPERATION: { flowTraversal: false, flowVisible: false },
  HAS_PARAMETER: { flowTraversal: false, flowVisible: false },
  RESOLVES_TO: {
    annotationUse: 'resolution',
    flowTraversal: false,
    flowVisible: false,
  },
  USES_REFERENCE: { annotationUse: 'resolution', flowTraversal: false, flowVisible: false },
  RECEIVES_VALUE: { annotationUse: 'binding', flowTraversal: false, flowVisible: false },
  READS_VALUE: { annotationUse: 'binding', flowTraversal: false, flowVisible: false },
  CAPTURES_VALUE: { annotationUse: 'binding', flowTraversal: false, flowVisible: false },
  EVAL: { annotationUse: 'composition' },
  ASSIGNS_VALUE: { annotationUse: 'composition' },
  ARG: { annotationUse: 'composition', flowVisible: false, flowComposition: true },
  FIELD: { annotationUse: 'composition', flowVisible: false, flowComposition: true },
  ON_RECEIVER: { annotationUse: 'composition' },
  // Legacy flow presentation edge. Parameter meaning must be reached through
  // the concrete argument occurrence and BINDS_TO_PARAMETER, never by fanning
  // a formal parameter out to every use site.
  PASSES_VALUE: { annotationUse: null },
  YIELDS_VALUE: { annotationUse: 'composition' },
  RESULT: { annotationUse: 'composition' },
  VALUE: { annotationUse: 'composition' },
  OPERAND: { annotationUse: 'composition' },
  LEFT_OPERAND: { annotationUse: 'composition' },
  RIGHT_OPERAND: { annotationUse: 'composition' },
};

export const RELATIONSHIP_SEMANTICS = Object.freeze(Object.fromEntries(
  Object.entries(DEFINITIONS).map(([type, policy]) => [type, Object.freeze({
    ...DEFAULT_POLICY,
    ...policy,
  })]),
));

export function relationshipPolicy(type) {
  return RELATIONSHIP_SEMANTICS[type] || DEFAULT_POLICY;
}

export function relationshipTypesForAnnotation(use) {
  return Object.freeze(Object.entries(RELATIONSHIP_SEMANTICS)
    .filter(([, policy]) => policy.annotationUse === use)
    .map(([type]) => type));
}

export function isFunctionFlowTraversalRelationship(type) {
  return relationshipPolicy(type).flowTraversal;
}

export function isFunctionFlowVisibleRelationship(type) {
  return relationshipPolicy(type).flowVisible;
}

export function isFunctionFlowRenderedRelationship(edge) {
  return isFunctionFlowVisibleRelationship(edge?.type)
    || edge?.props?.flowFamilyConnector === true
    || edge?.props?.flow_family_connector === true;
}

export function isFunctionFlowCompositionRelationship(type) {
  return relationshipPolicy(type).flowComposition;
}

export function isFunctionalSegmentVisibleRelationship(type) {
  return relationshipPolicy(type).functionalVisible;
}
