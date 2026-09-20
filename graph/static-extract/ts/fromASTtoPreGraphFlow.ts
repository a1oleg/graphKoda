import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import {constructorSemantics} from '../../vscode-source-colors/constructorSemantics.cjs';

import {
  buildAsyncAssignmentSemantic as buildAsyncAssignmentSemanticForBuilder,
  buildAsyncCallSemanticPayload as buildAsyncCallSemanticPayloadForBuilder,
  buildAsyncCallSemantic as buildAsyncCallSemanticForBuilder,
  buildAsyncDeclarationSemantic as buildAsyncDeclarationSemanticForBuilder,
  buildAsyncExpressionSemantic as buildAsyncExpressionSemanticForBuilder,
  type AsyncSemanticDependencies,
} from './functionFlowGraph.asyncSemantics.js';
import {
  buildOpaqueStableIdDescriptor,
  buildStableIdByDeclaration,
  buildStableIdDescriptorFromValue,
  createProgram,
  getExtendedStableId,
  getExtendedStableIdDescriptor,
  getRange,
  getRepoRelativePath,
  getStableIdDescriptor,
  getStableId,
  getLineAndColumn,
  isTrackedSourceFile,
  parseFnStableIdArgs,
  type StableIdDescriptor,
  toPosix,
} from './functionFlowGraph.infrastructure.js';
import { buildStableIdFromCoordinates, getStableIdValue } from '../../packages/runtime-core/src/stableId.js';
import {
  buildOperationOperand as buildOperationOperandForExtractor,
  buildStatementValueOperand as buildStatementValueOperandForExtractor,
  getDeclarationSourceFileInfo,
  getNodeTypeTextForChecker,
} from './functionFlowGraph.operands.js';
import {
  buildOperationDetail as buildOperationDetailForExtractor,
  buildOperationFields as buildOperationFieldsForExtractor,
} from './functionFlowGraph.operationFields.js';
import {
  buildSemanticOperationDetail as buildSemanticOperationDetailForBuilder,
  mergeSemanticOperationDetail as mergeSemanticOperationDetailForBuilder,
} from './functionFlowGraph.semanticDetails.js';
import {
  buildFlowNodeRow,
} from './functionFlowGraph.nodeRows.js';
import {
  createValueProxyMaterializationRegistry,
  extractValueAccessFacts,
  type ValueProxyMaterializationRegistry,
} from './functionFlowGraph.valueAccess.js';
import {
  buildStorageGraph,
  type StorageEdge,
  type StorageLink,
  type StorageNode,
} from './functionFlowGraph.storage.js';
import { buildAccessorIndex, type AccessorIndex, type AccessorRole } from './functionFlowGraph.accessors.js';
import {
  FunctionFlowDuckdbStage,
  type CanonicalEntity,
  type CanonicalRelationship,
} from './functionFlowDuckdbStage.js';
import {
  collectFiniteLiteralDomainGraph,
  type FiniteLiteralDomainGraph,
  type FiniteLiteralOccurrence,
} from './functionFlowGraph.literalDomains.js';
import {
  collectionMethodSemantics,
  collectionVirtualResultMethod,
  directCollectionAssignmentPlan,
  isKnownCollectionMethod,
  type DirectCollectionAssignmentPlan,
  type CollectionMethodSemantics,
} from './functionFlowGraph.collectionSemantics.js';
import {
  collectionExecutionProtocol,
  executionPrimitive,
  type ExecutionOutcomeKind,
  type ExecutionPrimitiveKind,
  type ExecutionPrimitiveSpec,
  type InstrumentationPhase,
  type InstrumentationStrategy,
} from './functionFlowGraph.executionPrimitives.js';
import { classifyFlowEdge, type FlowRole } from './functionFlowGraph.edgeSemantics.js';
import {
  collectParameterOriginFacts,
  type ParameterOriginFact,
} from './functionFlowGraph.parameterOrigins.js';
import {
  collectCanonicalReferenceGraph,
  resolveCanonicalDeclarationStableId,
} from './functionFlowGraph.canonicalReferences.js';

type FlowNodeKind = 'Step' | 'Eval' | 'Branch' | 'ArgBranch' | 'FieldBranch' | 'OperandBranch' | 'OperandJoin' | 'FlowBlock' | 'Loop' | 'Iteration' | 'Switch' | 'Case' | 'Action' | 'Read' | 'Write' | 'Call' | 'Op' | 'Value' | 'DataJoin' | 'Parameter' | 'Arg' | 'ArgJoin' | 'Object' | 'ObjectBrace' | 'Field' | 'FieldJoin' | 'LocalFunctionDeclaration' | 'LocalFunctionProxy' | 'FnVisualProxy' | 'DetachedAsyncCall' | 'AwaitedAsyncCall' | 'UiSurface' | 'FlowJoin' | 'BreakStop' | 'ThrowStop' | 'Return' | 'FunctionStart' | 'FunctionEnd';
type SemanticFlowNodeKind = Exclude<FlowNodeKind, 'Step'>;
type FlowEdgeKind =
  | 'NEXT'
  | 'SIGNATURE_PARAMETER'
  | 'SIGNATURE_RETURN'
  | 'BODY_ENTRY'
  | 'RETURN_TYPE_ARGUMENT'
  | 'AST_CHILD'
  | 'PARAM'
  | 'TRUE'
  | 'FALSE'
  | 'OPTION_CASE'
  | 'OPTION_DEFAULT'
  | 'MERGES_TO'
  | 'REJOINS'
  | 'ITERATOR'
  | 'OF'
  | 'REPEATS'
  | 'ARG'
  | 'ArgJoin'
  | 'XOR_JOIN'
  | 'ARROW'
  | 'VALUE'
  | 'EVAL'
  | 'RESULT'
  | 'FIELD'
  | 'FieldJoin'
  | 'RESPONSE'
  | 'REQUEST'
  | 'CALL'
  | 'READ'
  | 'WRITE'
  | 'SUBSCRIBE'
  | 'HAS_METHOD'
  | 'DECLARES_FUNCTION'
  | 'DETACHES_ASYNC'
  | 'AWAITS_ASYNC'
  | 'ASYNC'
  | 'CATCH'
  | 'CREATES_VALUE'
  | 'RECEIVES_VALUE'
  | 'READS_VALUE'
  | 'WRITES_VALUE'
  | 'TARGETS_VALUE'
  | 'ASSIGNS_VALUE'
  | 'PASSES_VALUE'
  | 'MATERIALIZES_ARGUMENT'
  | 'MATERIALIZES_RETURN'
  | 'RETURNS_VALUE'
  | 'ON_FAILURE'
  | 'WRITES'
  | 'CLEARS_VALUE'
  | 'DELETES_VALUE'
  | 'CAPTURES_VALUE'
  | 'ITERATES_VALUE'
  | 'PULLS_VALUE'
  | 'ITEM_AVAILABLE'
  | 'EXHAUSTED'
  | 'EXTRACTS_VALUE'
  | 'YIELDS_VALUE'
  | 'EMITS_VALUE'
  | 'ACCUMULATES_VALUE'
  | 'DECIDES_VALUE'
  | 'PERFORMS_EFFECT'
  | 'ENTERS'
  | 'EMITS_EFFECT'
  | 'ORDERS_VALUE'
  | 'COMPLETES_VALUE'
  | 'SHORT_CIRCUITS'
  | 'PROXY_OF'
  | 'INVOKES'
  | 'ON_RECEIVER'
  | 'PRODUCES_VALUE'
  | 'HAS_FLOW_BLOCK'
  | 'NESTED_IN';

type FlowLayer = 'control' | 'data' | 'mixed' | 'structure';
type DataFlowRole = 'input' | 'expression' | 'access' | 'result' | 'storage' | 'operation';

type SyntaxRegionPlan = {
  depth: number;
  relativeColumn: number;
  relativeRow: number;
};

type AstRepresentationMode = 'atomic' | 'inline-mosaic' | 'expanded-family' | 'column-subgraph';

type AstRepresentationPlan = SyntaxRegionPlan & {
  mode: AstRepresentationMode;
  requiresVerticalExpansion: boolean;
  estimatedColumns: number;
  estimatedRows: number;
  callBoundaryDesign?: 'mosaic' | 'split' | 'column';
  mosaicArgumentIndexes?: number[];
  foldSoleObjectBoundary?: boolean;
};

type FlowStepContext = {
  stableId: string;
  kind: 'statement' | 'condition' | 'execution';
  order: number;
  syntaxEntryStableId?: string;
  syntaxExitStableIds?: string[];
  structureDepth: number;
  structureRelativeColumn: number;
  structureRelativeRow: number;
};

type FlowLaneContext = {
  stableId: string;
  parentStableId?: string;
  depth: number;
  role: 'main' | 'optional';
};

type FlowFunctionRow = {
  stableId: StableIdDescriptor;
  name: string;
  label: string;
  repoRelativePath: string;
  labels?: string[];
  annotationKind?: 'Callable';
  flowLayer?: 'control';
  isExternal?: boolean;
};

type FlowFunctionTransportRow = Omit<FlowFunctionRow, 'stableId' | 'labels'> & {
  stableId: string;
  labels: string[];
  sourceStateId?: string;
  filePath?: string;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
  stableIdSuffix?: string;
};

type FlowNodeRow = {
  stableId: StableIdDescriptor;
  labels: string[];
  label: string;
  diaName?: string;
  parentFnStableId: StableIdDescriptor;
  repoRelativePath: string;
  operationIndex?: number;
  operationCode?: string;
  operationSubjectText?: string;
  relativeAccessText?: string;
  operationValueText?: string;
  operationCalleeText?: string;
  operationDetailJson?: string;
  operationDetailPresent?: boolean;
  operationDetailSize?: number;
  conditionRaw?: string;
  conditionStableId?: StableIdDescriptor;
  actionTextRaw?: string;
  callTextRaw?: string;
  calleeStableId?: StableIdDescriptor;
  calleeName?: string;
  joinKind?: string;
  mergeLabel?: string;
  incomingEdgeTypes?: string;
  flowJoinEntrySourceStableId?: string;
  flowJoinBackboneSourceStableId?: string;
  flowJoinPlacementSourceStableId?: string;
  flowLaneStableId?: string;
  parentFlowLaneStableId?: string;
  flowLaneDepth?: number;
  flowLaneRole?: 'main' | 'optional';
  flowJoinEntryIndex?: number;
  flowJoinEntryCount?: number;
  inlineStepTerminalJoin?: boolean;
  synthetic?: boolean;
  callbackKind?: string;
  callbackDeferred?: boolean;
  callbackParameterNames?: string[];
  asyncSchedulerKind?: string;
  asyncContract?: string;
  invocationMode?: 'synchronous' | 'asynchronous';
  responseMode?: 'return' | 'awaited' | 'none';
  stateResourceStableId?: string;
  stateResourceParentFnStableId?: string;
  stateResourceRepoRelativePath?: string;
  stateResourceName?: string;
  stateSetterName?: string;
  stateUpdateAction?: 'create' | 'write' | 'clear';
  sourceDocumentation?: string;
  storageName?: string;
  storageFormat?: string;
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
  syntaxEntryStableId?: string;
  syntaxExitStableIds?: string[];
  structureDepth?: number;
  structureRelativeColumn?: number;
  structureRelativeRow?: number;
  representationMode?: AstRepresentationMode;
  representationEstimatedColumns?: number;
  representationEstimatedRows?: number;
  parentLocalFunctionStableId?: string;
  localFunctionName?: string;
  localFunctionDepth?: number;
  declaredByStableId?: string;
  containsUiInjection?: boolean;
  proxyRole?: string;
  proxyReason?: string;
  headStableIds?: string[];
  tailStableIds?: string[];
  parentFlowBlockStableId?: string;
  ownerBranchStableIds?: string[];
  flowBlockRole?: 'side' | 'alternative' | 'switch-case';
  flowBlockOutcome?: 'TRUE' | 'FALSE' | 'CASE' | 'DEFAULT';
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
  collectionIterationMode?: string;
  collectionResultMode?: string;
  collectionShortCircuit?: boolean;
  collectionReverse?: boolean;
  collectionMutatesReceiver?: boolean;
  collectionLoopStableId?: string;
  collectionIterationStableId?: string;
  collectionCallbackStableId?: string;
  semanticExpansion?: string;
  sequenceAxisKind?: string;
  sequenceOwnerStableId?: string;
  executionScopeKind?: string;
  executionProtocolStableId?: string;
  executionProtocolKind?: string;
  executionRoles?: string[];
  executionRoleOrder?: number;
  executionRoleBindingsJson?: string;
  submethodsJson?: string;
  submethodStableId?: string;
  parentSubmethodStableId?: string;
  memberOfSubmethodStableId?: string;
  submethodPlacement?: 'axis' | 'right' | 'overlay';
  submethodAnchorStableId?: string;
  submethodKind?: 'collection-method' | 'function-callback' | 'catch';
  submethodOrder?: number;
  submethodMemberOrder?: number;
  submethodRelativeColumn?: number;
  submethodRelativeRow?: number;
  dataBranchOwnerStableId?: string;
  dataBranchFamilyRole?: 'alternative-result' | 'nested-call';
  nestedEvaluationDirection?: 'down';
  conditionalAlternativePlacement?: 'down';
  substepColumnOffset?: number;
  substepRowOffset?: number;
  primitiveKind?: ExecutionPrimitiveKind;
  executionOutcome?: ExecutionOutcomeKind;
  runtimeEventKind?: string;
  instrumentationStrategy?: InstrumentationStrategy;
  instrumentationPhase?: InstrumentationPhase;
  instrumentationTargetStableId?: string;
  renderHidden?: boolean;
  snippetEntryStableId?: string;
  snippetExitStableId?: string;
  sourceCallStableId?: string;
  canonicalStableId?: string;
  originalStableId?: string;
  proxyPredecessorStableIds?: string[];
  bindingStableId?: string;
  resultOfCallStableId?: string;
  resultTypeText?: string;
  containerStableId?: string;
  containerMethodKind?: string;
  containerState?: 'awaiting-assignment' | 'assigned';
  implementationCallStableId?: string;
  implementationCalleeName?: string;
  callBoundaryDesign?: 'mosaic' | 'split' | 'column';
  callBoundaryRole?: 'open' | 'close';
  callHasArguments?: boolean;
  callPredicate?: boolean;
  callBoundaryPeerStableId?: string;
  callMosaicOwnerStableId?: string;
  callMosaicRole?: 'open' | 'argument' | 'argument-close' | 'close';
  renderPartsJson?: string;
  renderPartsLayout?: 'single' | 'horizontal' | 'vertical' | 'diagonal' | 'container-overlay' | 'container-overlay-side';
  renderPrimaryPartIndex?: number;
  logicalNotPrefix?: boolean;
  methodChainOwnerStableId?: string;
  methodChainRole?: 'continuation';
  producerStartStableId?: string;
  producerEndStableIds?: string[];
  producerChainKind?: 'simple' | 'compound';
  parameterName?: string;
  parameterTypeText?: string;
  argumentName?: string;
  argumentIndex?: number;
  argumentTextRaw?: string;
  parameterOriginTargetFnStableId?: string;
  fieldName?: string;
  fieldIndex?: number;
  objectFamilyStableId?: string;
  objectBraceSide?: 'left' | 'right';
  objectBracePairIndex?: number;
  objectBracePairCount?: number;
  objectBraceFieldIndicesJson?: string;
  objectBraceMosaicNeighborStableId?: string;
  opensObjectFieldFamily?: boolean;
  annotationKind?: 'Callable' | 'Step' | 'FlowBlock' | 'ExecutionPrimitive' | 'Binding' | 'CallSite' | 'AsyncFlow' | 'UiSurface';
  flowLayer?: FlowLayer;
  dataFlowRole?: DataFlowRole;
  ownerStepStableId?: string;
};

type FlowNodeExtra = Partial<FlowNodeRow>;

type RenderPartDescriptor = {
  stableId: string;
  text: string;
  plainText?: string;
  kind: 'value' | 'virtual-value' | 'value-container' | 'collection-container' | 'operation-provider-container' | 'function-container' | 'storage-container' | 'literal' | 'operator' | 'method' | 'punctuation' | 'boolean-outcome';
  labels: string[];
  order: number;
  fillState?: 'empty' | 'filled';
  sourceStableId?: string;
  canonicalStableId?: string;
  bindingStableId?: string;
};

function materializeAttachedMethodArgumentMosaic(
  parts: RenderPartDescriptor[],
  ownerStableId: string,
  sourceStableId?: string,
) {
  const methodIndex = parts.findIndex((part) => part.kind === 'method');
  if (methodIndex < 0) return parts;
  const argumentIndex = parts.findIndex((part, index) => (
    index > methodIndex
    && (part.kind === 'virtual-value' || part.kind === 'value')
  ));
  if (argumentIndex < 0) return parts;

  const method = parts[methodIndex];
  if (!method.text.endsWith('(')) method.text = `${method.text}(`;
  const hasClosing = parts.some((part, index) => index > argumentIndex && part.text === ')');
  if (!hasClosing) {
    parts.splice(argumentIndex + 1, 0, {
      stableId: `${ownerStableId}:close`,
      text: ')',
      kind: 'punctuation',
      labels: ['Op', 'CallBoundary'],
      order: argumentIndex + 1,
      sourceStableId,
    });
  }
  return parts.map((part, order) => ({ ...part, order }));
}

type FlowNodeTransportRow = Omit<FlowNodeRow, 'stableId' | 'parentFnStableId' | 'calleeStableId' | 'conditionStableId' | 'operationDetailJson'> & {
  stableId: string;
  sourceStateId?: string;
  filePath?: string;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
  stableIdSuffix?: string;
  parentFnStableId: string;
  calleeStableId?: string;
  conditionStableId?: string;
  primaryLabel: string;
};

type FlowEdgeRow = {
  fromKind: 'Fn' | undefined;
  fromId: string;
  toKind: 'Fn' | undefined;
  toId: string;
  type: FlowEdgeKind;
  label?: string;
  diaName?: string;
  callTextRaw?: string;
  invocationMode?: 'synchronous' | 'asynchronous';
  responseMode?: 'return' | 'awaited' | 'none';
  storageStableIds?: string[];
  mainFlow?: boolean;
  callSiteStableId?: string;
  invocationType?: 'CALL' | 'REQUEST' | 'READ' | 'WRITE';
  flowLayer?: FlowLayer;
  ownerStepStableId?: string;
  semanticExpansion?: string;
  sequenceOrder?: number;
  executionOutcome?: ExecutionOutcomeKind;
  protocolRole?: string;
  protocolRoles?: string[];
  argumentName?: string;
  argumentIndex?: number;
  layoutFrame?: 'horizontal' | 'vertical';
  fieldName?: string;
  fieldIndex?: number;
  displayLabel?: string;
  flowRoles?: FlowRole[];
  controlKind?: string;
  dataKind?: string;
  structureKind?: string;
  effectKind?: string;
  renderHidden?: boolean;
  contextOnly?: boolean;
  producerRouteRole?: 'entry' | 'return-top' | 'return-bottom';
  producerOutcome?: 'true' | 'false';
  optionalReturnGroupStableId?: string;
  producerScopeStartOrder?: number;
  producerScopeEndOrder?: number;
  producerScopeStableIds?: string[];
  repeatOrigin?: 'binary-expression' | 'sequence';
  oneWay?: boolean;
  sourcePort?: string;
  targetPort?: string;
  sourcePortCandidates?: string[];
  targetPortCandidates?: string[];
  lockPortCandidates?: boolean;
  sourceRenderPartStableId?: string;
  targetRenderPartStableId?: string;
  elseIfChainBypass?: boolean;
};

type GraphExtractedPayload = {
  functions: FlowFunctionRow[];
  nodes: FlowNodeRow[];
  edges: FlowEdgeRow[];
  resources?: StorageNode[];
  resourceEdges?: StorageEdge[];
  resourceLinks?: StorageLink[];
  semanticEntities?: CanonicalEntity[];
  semanticRelationships?: CanonicalRelationship[];
};

function flowNodeSourceSpan(node: FlowNodeRow) {
  const stableId = node.stableId;
  if (
    stableId.startLine === undefined
    || stableId.startColumn === undefined
    || stableId.endLine === undefined
    || stableId.endColumn === undefined
  ) return Number.MAX_SAFE_INTEGER;
  return ((stableId.endLine - stableId.startLine) * 1_000_000)
    + stableId.endColumn - stableId.startColumn;
}

function stableIdSourceRange(stableId: string) {
  const match = /^(.*):(\d+):(\d+):(\d+):(\d+)(?::.*)?$/.exec(stableId);
  if (!match) return undefined;
  return {
    path: match[1],
    start: (Number(match[2]) * 1_000_000) + Number(match[3]),
    end: (Number(match[4]) * 1_000_000) + Number(match[5]),
  };
}

function sourceCoordinatesFromStableId(stableId: string) {
  const match = /^(.*):(\d+):(\d+):(\d+):(\d+)(?::.*)?$/.exec(stableId);
  if (!match) return undefined;
  return {
    canonicalStableId: `${match[1]}:${match[2]}:${match[3]}:${match[4]}:${match[5]}`,
    repoRelativePath: match[1],
    startLine: Number(match[2]),
    startColumn: Number(match[3]),
    endLine: Number(match[4]),
    endColumn: Number(match[5]),
  };
}

function compositionTargetFacet(kind: RenderPartDescriptor['kind']) {
  if (kind === 'method') return 'call';
  if (kind === 'operator') return 'operator';
  if (kind === 'punctuation') return 'syntax';
  if (kind === 'literal' || kind === 'boolean-outcome') return 'literal';
  if (kind.endsWith('container')) return 'valueSlot';
  return 'value';
}

function attachSyntaxCompositionGraph(payload: GraphExtractedPayload) {
  const entityById = new Map((payload.semanticEntities || []).map((entity) => [entity.stableId, entity]));
  const relationshipByKey = new Map((payload.semanticRelationships || []).map((relationship) => [
    `${relationship.fromId}\u0000${relationship.type}\u0000${relationship.toId}`,
    relationship,
  ]));

  for (const owner of payload.nodes) {
    if (!owner.renderPartsJson) continue;
    let parts: RenderPartDescriptor[];
    try {
      parts = JSON.parse(owner.renderPartsJson) as RenderPartDescriptor[];
    } catch {
      continue;
    }
    if (parts.length < 2) continue;
    const rawOwnerStableId = getStableIdKey(owner.stableId);
    const ownerCoordinates = sourceCoordinatesFromStableId(rawOwnerStableId);
    const ownerStableId = ownerCoordinates?.canonicalStableId || rawOwnerStableId;
    const existingOwner = entityById.get(ownerStableId);
    const ownerLabels = uniqueStrings([
      ...(existingOwner?.labels || []),
      'SyntaxComposition',
      ...(ownerCoordinates ? ['CodeEntity'] : []),
    ]);
    entityById.set(ownerStableId, {
      stableId: ownerStableId,
      labels: ownerLabels,
      props: {
        ...(existingOwner?.props || {}),
        ...(ownerCoordinates || {}),
        name: existingOwner?.props.name || owner.diaName || owner.label,
        syntax: existingOwner?.props.syntax || owner.actionTextRaw,
        roles: ownerLabels,
        compositionLayout: owner.renderPartsLayout || 'single',
        compositionPrimaryOrder: owner.renderPrimaryPartIndex ?? 0,
        compositionBackdrop: owner.renderPartsLayout === 'diagonal'
          || owner.renderPartsLayout === 'container-overlay'
          || owner.renderPartsLayout === 'container-overlay-side'
          ? 'diagonal'
          : 'none',
      },
    });
    const occurrencesByRelationship = new Map<string, RenderPartDescriptor[]>();
    parts.forEach((part, order) => {
      const partCoordinates = part.sourceStableId
        ? sourceCoordinatesFromStableId(part.sourceStableId)
        : undefined;
      const partStableId = partCoordinates?.canonicalStableId;
      if (!partStableId || partStableId === ownerStableId) return;
      const existing = entityById.get(partStableId);
      const labels = uniqueStrings([
        ...(existing?.labels || []),
        'CodeEntity',
        'SyntaxPart',
        ...(part.labels || []),
      ]);
      entityById.set(partStableId, {
        stableId: partStableId,
        labels,
        props: {
          ...(existing?.props || {}),
          ...partCoordinates,
          name: existing?.props.name || part.plainText || part.text,
          syntax: existing?.props.syntax || part.text,
          sourceBacked: true,
          roles: labels,
        },
      });
      const key = `${ownerStableId}\u0000COMPOSES_SYNTAX\u0000${partStableId}`;
      const occurrences = occurrencesByRelationship.get(key) || [];
      occurrences.push({ ...part, order: part.order ?? order });
      occurrencesByRelationship.set(key, occurrences);
      if (!relationshipByKey.has(key)) relationshipByKey.set(key, {
        fromId: ownerStableId,
        toId: partStableId,
        type: 'COMPOSES_SYNTAX',
        props: {
          layer: 'syntax-composition',
          renderHidden: true,
          field: 'renderedExpression',
          order: part.order ?? order,
          layout: owner.renderPartsLayout || 'single',
          primary: (part.order ?? order) === owner.renderPrimaryPartIndex,
          partKind: part.kind,
          backdrop: owner.renderPartsLayout === 'diagonal'
            || owner.renderPartsLayout === 'container-overlay'
            || owner.renderPartsLayout === 'container-overlay-side'
            ? 'diagonal'
            : 'none',
          fromFacet: 'mosaicOwner',
          toFacet: compositionTargetFacet(part.kind),
          sourcePortRole: 'composition',
          targetPortRole: compositionTargetFacet(part.kind),
        },
      });
    });
    for (const [key, occurrences] of occurrencesByRelationship) {
      const relationship = relationshipByKey.get(key)!;
      relationship.props.renderOccurrencesJson = JSON.stringify(occurrences);
    }
  }

  payload.semanticEntities = [...entityById.values()];
  payload.semanticRelationships = [...relationshipByKey.values()];
}

export function attachImmediateStepOperationGraph(
  payload: GraphExtractedPayload,
  operationIds: ReadonlySet<string> = collectOperationIds(payload.semanticEntities || []),
) {
  if (!operationIds.size) return;

  const relationshipByKey = new Map((payload.semanticRelationships || []).map((relationship) => [
    `${relationship.fromId}\u0000${relationship.type}\u0000${relationship.toId}`,
    relationship,
  ]));
  for (const node of payload.nodes) {
    const operationId = getStableIdKey(node.stableId);
    const stepId = String(node.parentStepStableId || '').trim();
    if (!stepId || !operationIds.has(operationId)) continue;
    const key = `${stepId}\u0000HAS_OPERATION\u0000${operationId}`;
    relationshipByKey.set(key, {
      fromId: stepId,
      toId: operationId,
      type: 'HAS_OPERATION',
      props: {
        layer: 'functional',
        ownership: 'immediate-step',
        fromFacet: 'step',
        toFacet: 'operation',
      },
    });
  }
  payload.semanticRelationships = [...relationshipByKey.values()];
}

export function collectOperationIds(entities: readonly CanonicalEntity[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const entity of entities) {
    if (entity.labels.includes('Operation')) ids.add(entity.stableId);
  }
  return ids;
}

function sourceRangeContains(containerStableId: string, nestedStableId: string) {
  const container = stableIdSourceRange(containerStableId);
  const nested = stableIdSourceRange(nestedStableId);
  return Boolean(
    container
    && nested
    && container.path === nested.path
    && container.start <= nested.start
    && container.end >= nested.end,
  );
}

function renderPartsForLiteral(node: FlowNodeRow, occurrence: FiniteLiteralOccurrence) {
  if (!node.renderPartsJson) return [];
  try {
    return (JSON.parse(node.renderPartsJson) as RenderPartDescriptor[])
      .filter((part) => (
        part.sourceStableId === occurrence.sourceStableId
        || (part.sourceStableId && sourceRangeContains(occurrence.sourceStableId, part.sourceStableId))
      ));
  } catch {
    return [];
  }
}

export function scopeCanonicalReferenceGraph(
  graph: { entities: CanonicalEntity[]; relationships: CanonicalRelationship[] },
  fnStableId: string,
) {
  const ranges = [fnStableId].flatMap((stableId) => {
    const match = /^(.*):(\d+):(\d+):(\d+):(\d+)$/.exec(stableId);
    if (!match) return [];
    const [, repoRelativePath, startLineText, startColumnText, endLineText, endColumnText] = match;
    return [{
      repoRelativePath,
      startLine: Number(startLineText),
      startColumn: Number(startColumnText),
      endLine: Number(endLineText),
      endColumn: Number(endColumnText),
    }];
  });
  if (!ranges.length) return { entities: [], relationships: [] };
  const positionAtOrAfter = (line: number, column: number, boundaryLine: number, boundaryColumn: number) => (
    line > boundaryLine || (line === boundaryLine && column >= boundaryColumn)
  );
  const positionAtOrBefore = (line: number, column: number, boundaryLine: number, boundaryColumn: number) => (
    line < boundaryLine || (line === boundaryLine && column <= boundaryColumn)
  );
  const included = new Set(graph.entities
    .filter((entity) => {
      // The canonical ID omits export/default modifiers; sourceProps includes them.
      if (entity.stableId === fnStableId) return true;
      const props = entity.props;
      return typeof props.startLine === 'number'
        && typeof props.startColumn === 'number'
        && typeof props.endLine === 'number'
        && typeof props.endColumn === 'number'
        && ranges.some((range) => (
          props.repoRelativePath === range.repoRelativePath
          && positionAtOrAfter(props.startLine as number, props.startColumn as number, range.startLine, range.startColumn)
          && positionAtOrBefore(props.endLine as number, props.endColumn as number, range.endLine, range.endColumn)
        ));
    })
    .map((entity) => entity.stableId));
  const entityById = new Map(graph.entities.map((entity) => [entity.stableId, entity]));
  const outgoing = new Map<string, CanonicalRelationship[]>();
  const incoming = new Map<string, CanonicalRelationship[]>();
  for (const relationship of graph.relationships) {
    const rows = outgoing.get(relationship.fromId) || [];
    rows.push(relationship);
    outgoing.set(relationship.fromId, rows);
    const reverseRows = incoming.get(relationship.toId) || [];
    reverseRows.push(relationship);
    incoming.set(relationship.toId, reverseRows);
  }

  const owned = new Set(included);
  const selectedRelationships = new Set<CanonicalRelationship>();
  const includeRelationship = (relationship: CanonicalRelationship) => {
    selectedRelationships.add(relationship);
    included.add(relationship.fromId);
    included.add(relationship.toId);
  };

  // The lexical body is the only recursively owned part of a scoped import.
  // References outside it are boundary nodes: preserve the exact edge crossing
  // the boundary, but never expand the referenced declaration/component body.
  for (const relationship of graph.relationships) {
    if (owned.has(relationship.fromId) && owned.has(relationship.toId)) {
      includeRelationship(relationship);
    } else if (owned.has(relationship.fromId)) {
      includeRelationship(relationship);
    } else if (owned.has(relationship.toId)
      && ['ALIASES', 'REEXPORTS', 'BINDS_TO_PARAMETER'].includes(relationship.type)) {
      includeRelationship(relationship);
    }
  }

  // A scoped function may mutate state declared outside its lexical range.
  // Keep the other writes to that same canonical state slot as one-hop
  // boundaries, so state provenance remains complete without importing the
  // enclosing bodies of those writers.
  const selectedReactStateTargets = [...included].filter((stableId) => (
    !owned.has(stableId) && entityById.get(stableId)?.labels.includes('ReactState')
  ));
  for (const targetId of selectedReactStateTargets) {
    for (const relationship of incoming.get(targetId) || []) {
      if (relationship.type === 'WRITES_TO') includeRelationship(relationship);
    }
  }

  // Follow a selected callback out through a JSX prop only far enough to retain
  // its receiving component boundary. Do not import that component's body.
  const rootRange = ranges[0];
  const rootImplementations = graph.entities.filter((entity) => (
    included.has(entity.stableId)
    && entity.labels.includes('FunctionImplementation')
    && (entity.stableId === fnStableId || (entity.props.repoRelativePath === rootRange.repoRelativePath
    && entity.props.startLine === rootRange.startLine
    && entity.props.startColumn === rootRange.startColumn
    && entity.props.endLine === rootRange.endLine
    && entity.props.endColumn === rootRange.endColumn))
  ));
  const rootBindings = new Set(rootImplementations.map((entity) => entity.stableId));
  let bindingFrontier = [...rootBindings];
  for (let depth = 0; depth < 4 && bindingFrontier.length; depth += 1) {
    const nextFrontier: string[] = [];
    for (const current of bindingFrontier) {
      for (const relationship of incoming.get(current) || []) {
        if (relationship.type !== 'VALUE_FROM' || rootBindings.has(relationship.fromId)) continue;
        includeRelationship(relationship);
        rootBindings.add(relationship.fromId);
        nextFrontier.push(relationship.fromId);
      }
    }
    bindingFrontier = nextFrontier;
  }
  const callbackReferences = new Set<string>();
  for (const bindingId of rootBindings) {
    included.add(bindingId);
    for (const relationship of incoming.get(bindingId) || []) {
      if (relationship.type !== 'RESOLVES_TO') continue;
      includeRelationship(relationship);
      callbackReferences.add(relationship.fromId);
    }
  }
  const callbackProperties = new Set<string>();
  for (const referenceId of callbackReferences) {
    for (const relationship of incoming.get(referenceId) || []) {
      if (relationship.type === 'VALUE_FROM' && entityById.get(relationship.fromId)?.labels.includes('JsxPropertyValue')) {
        includeRelationship(relationship);
        callbackProperties.add(relationship.fromId);
      }
    }
  }
  for (const propertyId of callbackProperties) {
    included.add(propertyId);
    for (const relationship of incoming.get(propertyId) || []) {
      if (relationship.type !== 'HAS_PROPERTY') continue;
      includeRelationship(relationship);
      for (const callRelationship of outgoing.get(relationship.fromId) || []) {
        if (callRelationship.type !== 'CALLS') continue;
        includeRelationship(callRelationship);
      }
    }
  }

  // Materialize a bounded value frame for arguments bound to local parameters.
  // This keeps helpers -> supplied object -> fields -> declarations stepwise,
  // while the declarations themselves remain unexpanded boundaries.
  const boundArgumentRoots = graph.relationships.filter((relationship) => (
    relationship.type === 'BINDS_TO_PARAMETER'
    && owned.has(relationship.toId)
  ));
  const argumentFrameEdges = new Set([
    'HAS_ARGUMENT',
    'HAS_PROPERTY',
    'SPREADS_FROM',
    'VALUE_FROM',
    'RESOLVES_TO',
    'READS_FROM',
  ]);
  let argumentFrontier: string[] = [];
  for (const relationship of boundArgumentRoots) {
    includeRelationship(relationship);
    argumentFrontier.push(relationship.fromId);
    for (const ownerRelationship of incoming.get(relationship.fromId) || []) {
      if (ownerRelationship.type === 'HAS_ARGUMENT') includeRelationship(ownerRelationship);
    }
  }
  const argumentVisited = new Set(argumentFrontier);
  for (let depth = 0; depth < 3 && argumentFrontier.length; depth += 1) {
    const nextFrontier: string[] = [];
    for (const current of argumentFrontier) {
      for (const relationship of outgoing.get(current) || []) {
        if (!argumentFrameEdges.has(relationship.type)) continue;
        includeRelationship(relationship);
        if (!argumentVisited.has(relationship.toId)) {
          argumentVisited.add(relationship.toId);
          nextFrontier.push(relationship.toId);
        }
      }
    }
    argumentFrontier = nextFrontier;
  }

  // Import the provenance slice for selected fields, not the bodies of callers.
  // Destructuring prepends a segment; selecting an object property consumes it.
  // The key path is part of the visited state, so the same object can serve
  // several independent selections without expanding all of its properties.
  type SelectionState = { id: string; keys: string[]; depth: number };
  const selections: SelectionState[] = [];
  for (const id of owned) {
    for (const edge of outgoing.get(id) || []) {
      if (edge.type === 'READS_FROM' && typeof edge.props.propertyName === 'string') {
        selections.push({ id: edge.toId, keys: [edge.props.propertyName], depth: 0 });
      }
    }
  }
  const selectionVisited = new Set<string>();
  for (let cursor = 0; cursor < selections.length; cursor++) {
    const state = selections[cursor]!;
    const visitKey = JSON.stringify([state.id, state.keys]);
    if (selectionVisited.has(visitKey) || state.depth >= 64) continue;
    selectionVisited.add(visitKey);
    const entity = entityById.get(state.id);
    const edges = outgoing.get(state.id) || [];
    const selected = edges.filter(edge => edge.type === 'HAS_PROPERTY' && edge.props.propertyName === state.keys[0]);
    const follow = (edge: CanonicalRelationship, keys: string[], reverse = false) => {
      includeRelationship(edge);
      if (keys.length) selections.push({ id: reverse ? edge.fromId : edge.toId, keys, depth: state.depth + 1 });
    };
    const lastExplicitIndex = Math.max(-1, ...selected.map(edge => Number(edge.props.index ?? -1)));
    for (const edge of selected) {
      if (Number(edge.props.index ?? -1) < lastExplicitIndex) continue;
      follow(edge, state.keys.slice(1));
      // Keep the selected value's immediate origin even at the terminal field.
      for (const value of outgoing.get(edge.toId) || []) {
        if (['VALUE_FROM', 'RESOLVES_TO'].includes(value.type)) includeRelationship(value);
      }
    }
    for (const edge of edges) {
      if (edge.type === 'SPREADS_FROM' && Number(edge.props.index ?? -1) > lastExplicitIndex) {
        follow(edge, state.keys);
      } else if (!selected.length && ['VALUE_FROM', 'RESOLVES_TO'].includes(edge.type)) {
        follow(edge, state.keys);
      } else if (!selected.length && edge.type === 'READS_FROM'
        && typeof edge.props.propertyName === 'string'
        && entity?.labels.some(label => ['PropertyProjection', 'MemberReference'].includes(label))) {
        follow(edge, [edge.props.propertyName, ...state.keys]);
      }
    }
    if (!selected.length && entity?.labels.includes('Parameter')) {
      for (const edge of incoming.get(state.id) || []) {
        if (edge.type === 'BINDS_TO_PARAMETER') follow(edge, state.keys, true);
      }
    }
  }

  return {
    entities: graph.entities.filter((entity) => included.has(entity.stableId)),
    relationships: graph.relationships.filter((relationship) => selectedRelationships.has(relationship)),
  };
}

function attachFiniteLiteralDomainsFromGraph(graph: FiniteLiteralDomainGraph, payload: GraphExtractedPayload) {
  const includedFunctionIds = new Set(payload.functions.map((row) => getStableIdKey(row.stableId)));
  const occurrences = graph.occurrences.filter((occurrence) => (
    occurrence.parentFnStableId && includedFunctionIds.has(occurrence.parentFnStableId)
  ));
  const occurrenceIds = new Set(occurrences.map((occurrence) => occurrence.stableId));
  const domainIds = new Set(occurrences.map((occurrence) => occurrence.domainStableId));
  const memberIds = new Set<string>();
  for (const relationship of graph.relationships) {
    if (relationship.type === 'HAS_MEMBER' && domainIds.has(relationship.fromId)) memberIds.add(relationship.toId);
  }

  payload.semanticEntities = [
    ...(payload.semanticEntities || []),
    ...graph.entities.filter((entity) => (
      occurrenceIds.has(entity.stableId)
      || domainIds.has(entity.stableId)
      || memberIds.has(entity.stableId)
    )),
  ];
  payload.semanticRelationships = [
    ...(payload.semanticRelationships || []),
    ...graph.relationships.filter((relationship) => (
      (relationship.type === 'HAS_MEMBER' && domainIds.has(relationship.fromId))
      || (relationship.type === 'RESOLVES_TO' && occurrenceIds.has(relationship.fromId))
    )),
  ];

  for (const occurrence of occurrences) {
    const candidates = payload.nodes
      .filter((node) => getStableIdKey(node.parentFnStableId) === occurrence.parentFnStableId)
      .map((node) => ({
        node,
        parts: renderPartsForLiteral(node, occurrence),
        exact: getStableIdKey(node.stableId) === occurrence.sourceStableId,
      }))
      .filter((candidate) => candidate.parts.length || candidate.exact)
      .sort((left, right) => {
        const leftStructural = left.node.labels.includes('Step') || left.node.labels.includes('Block');
        const rightStructural = right.node.labels.includes('Step') || right.node.labels.includes('Block');
        if (leftStructural !== rightStructural) return leftStructural ? 1 : -1;
        if (left.exact !== right.exact) return left.exact ? -1 : 1;
        return flowNodeSourceSpan(left.node) - flowNodeSourceSpan(right.node);
      });
    const owner = candidates[0];
    if (!owner) continue;
    payload.semanticRelationships.push({
      fromId: getStableIdKey(owner.node.stableId),
      toId: occurrence.stableId,
      type: 'USES_LITERAL',
      props: {
        flow_layer: 'data',
        context_only: true,
        render_hidden: true,
        render_part_stable_ids: owner.parts.map((part) => part.stableId),
        source_stable_id: occurrence.sourceStableId,
      },
    });
  }
}

function attachFiniteLiteralDomains(program: ts.Program, payload: GraphExtractedPayload) {
  attachFiniteLiteralDomainsFromGraph(collectFiniteLiteralDomainGraph(program), payload);
}

function annotationKindForNode(labels: string[]): FlowNodeRow['annotationKind'] {
  const labelSet = new Set(labels);
  if (labelSet.has('VisualProxy') || labelSet.has('PresentationOnly')) return undefined;
  if (labelSet.has('FnDeclaration')) return 'Callable';
  if (labelSet.has('Step')) return 'Step';
  if (labelSet.has('Flow') && labelSet.has('Block')) return 'FlowBlock';
  if (labelSet.has('Primitive')) return 'ExecutionPrimitive';
  if (labelSet.has('ValueSlot')) return 'Binding';
  if (labelSet.has('UiSurface')) return 'UiSurface';
  if (labelSet.has('DetachedAsyncCall') || labelSet.has('AwaitedAsyncCall')) return 'AsyncFlow';
  if (labelSet.has('Call') || labelSet.has('Request') || labelSet.has('Op')) return 'CallSite';
  return undefined;
}

const STEP_INTERNAL_EDGE_TYPES = new Set<FlowEdgeKind>([
  'NEXT', 'AST_CHILD', 'PARAM', 'TRUE', 'FALSE', 'OPTION_CASE', 'OPTION_DEFAULT', 'MERGES_TO',
  'ITERATOR', 'OF', 'ARG', 'ArgJoin', 'XOR_JOIN', 'ARROW', 'VALUE', 'EVAL',
  'RESULT', 'REPEATS',
  'FIELD', 'FieldJoin', 'CREATES_VALUE', 'RECEIVES_VALUE', 'READS_VALUE',
  'WRITES_VALUE', 'TARGETS_VALUE', 'ASSIGNS_VALUE', 'PASSES_VALUE',
  'CLEARS_VALUE', 'DELETES_VALUE', 'CAPTURES_VALUE',
  'ITERATES_VALUE', 'PULLS_VALUE', 'ITEM_AVAILABLE', 'EXHAUSTED', 'EXTRACTS_VALUE',
  'YIELDS_VALUE', 'EMITS_VALUE', 'ACCUMULATES_VALUE', 'DECIDES_VALUE',
  'PERFORMS_EFFECT', 'ORDERS_VALUE', 'COMPLETES_VALUE', 'SHORT_CIRCUITS',
  'INVOKES', 'ON_RECEIVER', 'PRODUCES_VALUE',
]);

const CONTROL_FLOW_EDGE_TYPES = new Set<FlowEdgeKind>([
  'NEXT', 'TRUE', 'FALSE', 'OPTION_CASE', 'OPTION_DEFAULT', 'MERGES_TO',
  'REJOINS', 'REPEATS', 'CALL', 'DECLARES_FUNCTION', 'DETACHES_ASYNC',
  'AWAITS_ASYNC', 'ASYNC', 'CATCH', 'SUBSCRIBE', 'EXHAUSTED', 'INVOKES',
]);

const MIXED_FLOW_EDGE_TYPES = new Set<FlowEdgeKind>([
  'REQUEST', 'PULLS_VALUE', 'ITEM_AVAILABLE', 'DECIDES_VALUE',
  'PERFORMS_EFFECT', 'ORDERS_VALUE',
]);
const STRUCTURAL_EDGE_TYPES = new Set<FlowEdgeKind>([
  'HAS_FLOW_BLOCK', 'NESTED_IN',
]);

function flowLayerForEdge(type: FlowEdgeKind): FlowLayer {
  if (STRUCTURAL_EDGE_TYPES.has(type)) return 'structure';
  if (MIXED_FLOW_EDGE_TYPES.has(type)) return 'mixed';
  if (CONTROL_FLOW_EDGE_TYPES.has(type)) return 'control';
  return 'data';
}

function dataFlowRoleForNode(node: FlowNodeRow): DataFlowRole {
  const labels = new Set(node.labels);
  if (labels.has('Parameter') || labels.has('Arg') || labels.has('Field')) return 'input';
  if (labels.has('Storage') || labels.has('ValueSlot') || labels.has('Cell')) return 'storage';
  if (labels.has('Result') || labels.has('ValueOutcome') || labels.has('Join')) return 'result';
  if (labels.has('Read') || labels.has('Write') || labels.has('ValueAccess')) return 'access';
  if (labels.has('Value') || labels.has('Operand') || labels.has('Object') || labels.has('Eval')) return 'expression';
  return 'operation';
}

function mergeFlowLayers(layers: Iterable<FlowLayer>): FlowLayer {
  let control = false;
  let data = false;
  let structure = false;
  for (const layer of layers) {
    control ||= layer === 'control' || layer === 'mixed';
    data ||= layer === 'data' || layer === 'mixed';
    structure ||= layer === 'structure';
  }
  if (control && data) return 'mixed';
  if (data) return 'data';
  if (control) return 'control';
  return structure ? 'structure' : 'control';
}

function executionStepBoundaries(
  members: FlowNodeRow[],
  edges: FlowEdgeRow[],
  scopeMembers: FlowNodeRow[] = members,
) {
  const orderedIds = members.map((member) => getStableIdKey(member.stableId));
  if (orderedIds.length === 1) return { headStableIds: orderedIds, tailStableIds: orderedIds };

  const memberIds = new Set(orderedIds);
  const scopeMemberIds = new Set(scopeMembers.map((member) => getStableIdKey(member.stableId)));
  const internalIncoming = new Set<string>();
  const internalOutgoing = new Set<string>();
  const externalControlOutgoing = new Set<string>();
  for (const edge of edges) {
    if (
      memberIds.has(edge.fromId)
      && !scopeMemberIds.has(edge.toId)
      && (CONTROL_FLOW_EDGE_TYPES.has(edge.type) || MIXED_FLOW_EDGE_TYPES.has(edge.type))
    ) {
      externalControlOutgoing.add(edge.fromId);
    }
    if (!STEP_INTERNAL_EDGE_TYPES.has(edge.type)) continue;
    if (scopeMemberIds.has(edge.fromId) && memberIds.has(edge.toId)) internalIncoming.add(edge.toId);
    if (memberIds.has(edge.fromId) && scopeMemberIds.has(edge.toId)) internalOutgoing.add(edge.fromId);
  }
  const headStableIds = orderedIds.filter((stableId) => !internalIncoming.has(stableId));
  const tailStableIds = externalControlOutgoing.size
    ? orderedIds.filter((stableId) => externalControlOutgoing.has(stableId))
    : orderedIds.filter((stableId) => !internalOutgoing.has(stableId));
  return {
    headStableIds: headStableIds.length ? headStableIds : [orderedIds[0]],
    tailStableIds: tailStableIds.length ? tailStableIds : [orderedIds[orderedIds.length - 1]],
  };
}

function attachStorageBindings(edges: FlowEdgeRow[], storageBindings: Array<{
  flowNodeStableId: string;
  accessorStableId: string;
  storageStableId: string;
  relType: 'READ' | 'WRITE';
}>) {
  const storageIdsByInvocation = new Map<string, Set<string>>();
  for (const binding of storageBindings) {
    const key = `${binding.flowNodeStableId}:${binding.relType}:${binding.accessorStableId}`;
    const ids = storageIdsByInvocation.get(key) || new Set<string>();
    ids.add(binding.storageStableId);
    storageIdsByInvocation.set(key, ids);
  }
  for (const edge of edges) {
    const ids = storageIdsByInvocation.get(`${edge.fromId}:${edge.type}:${edge.toId}`);
    if (ids?.size) edge.storageStableIds = [...ids].sort();
  }
}

type ResolvedCallTarget = {
  stableId: string;
  name?: string;
  repoRelativePath?: string;
  targetKind?: 'fn' | 'synthetic-external' | 'missing-module-method';
  moduleStableId?: string;
  moduleSpecifier?: string;
  resolvedModulePath?: string;
  missingReason?: string;
  missingMethodName?: string;
  gatedByFeatureNames?: string[];
};

type ReactStateResourceIdentity = {
  stableId: string;
  parentFnStableId: string;
  repoRelativePath: string;
  name: string;
  setterName: string;
  setterStableId: string;
  setterStableIdDescriptor: StableIdDescriptor;
};

type ReactStateProvenance = {
  resourcesBySetterSymbol: Map<ts.Symbol, Map<string, ReactStateResourceIdentity>>;
  resourceByCreationCall: Map<ts.CallExpression, ReactStateResourceIdentity>;
};

function isDeveloperCallTarget(target: ResolvedCallTarget | undefined): target is ResolvedCallTarget {
  return Boolean(target?.stableId && !String(target.stableId).startsWith('external:') && target.targetKind !== 'missing-module-method');
}

function isCallableGraphTarget(target: ResolvedCallTarget | undefined): target is ResolvedCallTarget {
  return isDeveloperCallTarget(target) || target?.targetKind === 'missing-module-method';
}

function declarationIsTracked(declaration: ts.Declaration | undefined) {
  return Boolean(declaration && isTrackedSourceFile(declaration.getSourceFile()));
}

type ImmediateCallbackMaterializationTarget = {
  callback: ts.FunctionLikeDeclaration;
  callbackStableId?: string;
  allowLocalReturn: boolean;
  callbackKind?: CallbackKind;
};

type CallbackKind = 'updater' | 'predicate' | 'mapper' | 'reducer' | 'consumer' | 'comparator' | 'factory' | 'callback';

const CALL_API_WRAPPER_REPO_PATHS = new Set([
  'src/api/gramjs/worker/connector.ts',
  'src/api/gramjs/methods/init.ts',
]);

const API_METHODS_REPO_PREFIX = 'src/api/gramjs/methods/';
const GLOBAL_ACTIONS_REPO_PREFIX = 'src/global/actions/';
const ACTION_ALIAS_WRAPPER_REPO_PATH = 'src/lib/teact/teactn.tsx';
const EXTERNAL_BROWSER_MEDIA_REPO_PATH = 'external/browser-media';
const EXTERNAL_WEBRTC_REPO_PATH = 'external/webrtc-runtime';
const EXTERNAL_TELEGRAM_NETWORK_REPO_PATH = 'external/telegram-backend';
const EXTERNAL_LLM_REPO_PATH = 'external/llm';
const EXTERNAL_LOCAL_DATA_REPO_PATH = 'external/local-data';
const EXTERNAL_DYNAMIC_TOOL_REPO_PATH = 'external/dynamic-tool';
const EXTERNAL_MODULE_REPO_PATH = 'external/module';
const EXTERNAL_RUNTIME_REPO_PATH = 'external/runtime';
const EXTERNAL_BUN_BUNDLE_REPO_PATH = 'external/bun-bundle';
const SYNTHETIC_EXTERNAL_TARGETS_BY_KEY = new Map<string, ResolvedCallTarget>([
  ['bun-bundle:feature', {
    stableId: 'external:bun-bundle:feature',
    name: 'feature',
    repoRelativePath: EXTERNAL_BUN_BUNDLE_REPO_PATH,
  }],
  ['browser-media:getDisplayMedia', {
    stableId: 'external:browser-media:getDisplayMedia',
    name: 'getDisplayMedia',
    repoRelativePath: EXTERNAL_BROWSER_MEDIA_REPO_PATH,
  }],
  ['browser-media:getUserMedia', {
    stableId: 'external:browser-media:getUserMedia',
    name: 'getUserMedia',
    repoRelativePath: EXTERNAL_BROWSER_MEDIA_REPO_PATH,
  }],
  ['webrtc:createDataChannel', {
    stableId: 'external:webrtc-runtime:RTCPeerConnection.createDataChannel',
    name: 'createDataChannel',
    repoRelativePath: EXTERNAL_WEBRTC_REPO_PATH,
  }],
  ['webrtc:setRemoteDescription', {
    stableId: 'external:webrtc-runtime:RTCPeerConnection.setRemoteDescription',
    name: 'setRemoteDescription',
    repoRelativePath: EXTERNAL_WEBRTC_REPO_PATH,
  }],
  ['webrtc:setLocalDescription', {
    stableId: 'external:webrtc-runtime:RTCPeerConnection.setLocalDescription',
    name: 'setLocalDescription',
    repoRelativePath: EXTERNAL_WEBRTC_REPO_PATH,
  }],
  ['webrtc:createAnswer', {
    stableId: 'external:webrtc-runtime:RTCPeerConnection.createAnswer',
    name: 'createAnswer',
    repoRelativePath: EXTERNAL_WEBRTC_REPO_PATH,
  }],
  ['telegram-network:invokeRequest', {
    stableId: 'external:telegram-backend:invokeRequest',
    name: 'invokeRequest',
    repoRelativePath: EXTERNAL_TELEGRAM_NETWORK_REPO_PATH,
  }],
  ['llm:anthropicMessagesCreate', {
    stableId: 'external:llm:anthropic.beta.messages.create',
    name: 'anthropic.beta.messages.create',
    repoRelativePath: EXTERNAL_LLM_REPO_PATH,
  }],
  ['llm:anthropicMessagesStream', {
    stableId: 'external:llm:anthropic.beta.messages.stream',
    name: 'anthropic.beta.messages.stream',
    repoRelativePath: EXTERNAL_LLM_REPO_PATH,
  }],
  ['local-data:readFile', {
    stableId: 'external:local-data:fs.readFile',
    name: 'readFile',
    repoRelativePath: EXTERNAL_LOCAL_DATA_REPO_PATH,
  }],
  ['local-data:writeFile', {
    stableId: 'external:local-data:fs.writeFile',
    name: 'writeFile',
    repoRelativePath: EXTERNAL_LOCAL_DATA_REPO_PATH,
  }],
  ['local-data:appendFile', {
    stableId: 'external:local-data:fs.appendFile',
    name: 'appendFile',
    repoRelativePath: EXTERNAL_LOCAL_DATA_REPO_PATH,
  }],
  ['local-data:mkdir', {
    stableId: 'external:local-data:fs.mkdir',
    name: 'mkdir',
    repoRelativePath: EXTERNAL_LOCAL_DATA_REPO_PATH,
  }],
  ['local-data:readdir', {
    stableId: 'external:local-data:fs.readdir',
    name: 'readdir',
    repoRelativePath: EXTERNAL_LOCAL_DATA_REPO_PATH,
  }],
  ['local-data:unlink', {
    stableId: 'external:local-data:fs.unlink',
    name: 'unlink',
    repoRelativePath: EXTERNAL_LOCAL_DATA_REPO_PATH,
  }],
  ['dynamic-tool:tool.call', {
    stableId: 'external:dynamic-tool:tool.call',
    name: 'selected tool boundary',
    repoRelativePath: EXTERNAL_DYNAMIC_TOOL_REPO_PATH,
  }],
]);

type FlowOperationCode =
  | 'ACTION'
  | 'ASSIGN'
  | 'BRANCH'
  | 'CALL'
  | 'CASE'
  | 'DECLARE'
  | 'END'
  | 'EVAL'
  | 'MERGE'
  | 'NEW'
  | 'READ'
  | 'RETURN'
  | 'SWITCH'
  | 'THROW';

type PendingExit = {
  fromKind: 'Fn' | undefined;
  fromId: string;
  edgeType: FlowEdgeKind;
  label?: string;
  mainFlow?: boolean;
  argumentName?: string;
  argumentIndex?: number;
  fieldName?: string;
  fieldIndex?: number;
  sourceRenderPartStableId?: string;
  targetRenderPartStableId?: string;
};

type PendingThrowExit = PendingExit & {
  actionTextRaw?: string;
};

type ConditionFlowResult = {
  firstNodeId?: string;
  trueExits: PendingExit[];
  falseExits: PendingExit[];
};

type BuildResult = {
  firstNodeId?: string;
  openExits: PendingExit[];
  pendingBreaks: PendingExit[];
  pendingContinues: PendingExit[];
  pendingThrows: PendingThrowExit[];
};

type BuildEnvironment = {
  hasLocalCatch: boolean;
  deferIfMerge?: boolean;
  flowBodyExecution?: boolean;
};

function normalizeWhitespace(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

function shortenLabel(text: string, maxLength = 120) {
  const normalized = normalizeWhitespace(text);
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function uniqueStrings(values: Array<string | undefined>) {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function containsAwaitExpression(node: ts.Node) {
  let hasAwait = false;

  function visit(current: ts.Node): void {
    if (hasAwait || (current !== node && isFunctionLikeNode(current))) {
      return;
    }

    if (ts.isAwaitExpression(current) || ts.isForOfStatement(current) && current.awaitModifier) {
      hasAwait = true;
      return;
    }

    ts.forEachChild(current, visit);
  }

  visit(node);
  return hasAwait;
}

function getCallLikeExpressionFromNode(node: ts.Node) {
  if (ts.isReturnStatement(node) && node.expression) {
    const valueExpression = unwrapAwaitedExpression(node.expression);
    return ts.isCallExpression(valueExpression) || ts.isNewExpression(valueExpression)
      ? valueExpression
      : undefined;
  }

  if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1) {
    const initializer = node.declarationList.declarations[0].initializer;
    if (!initializer) {
      return undefined;
    }

    const valueExpression = unwrapAwaitedExpression(initializer);
    return ts.isCallExpression(valueExpression) || ts.isNewExpression(valueExpression)
      ? valueExpression
      : undefined;
  }

  if (ts.isExpressionStatement(node)) {
    const statementExpression = unwrapExpression(node.expression);
    if (isSimpleAssignmentExpression(statementExpression)) {
      const valueExpression = unwrapAwaitedExpression(statementExpression.right);
      return ts.isCallExpression(valueExpression) || ts.isNewExpression(valueExpression)
        ? valueExpression
        : undefined;
    }

    const valueExpression = unwrapAwaitedExpression(statementExpression);
    return ts.isCallExpression(valueExpression) || ts.isNewExpression(valueExpression)
      ? valueExpression
      : undefined;
  }

  if (ts.isExpression(node)) {
    const valueExpression = unwrapAwaitedExpression(node);
    return ts.isCallExpression(valueExpression) || ts.isNewExpression(valueExpression)
      ? valueExpression
      : undefined;
  }

  return undefined;
}

function isFunctionLikeNode(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node);
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }

  return current;
}

function unwrapAwaitedExpression(expression: ts.Expression) {
  let current = unwrapExpression(expression);
  while (ts.isAwaitExpression(current) || (ts.isYieldExpression(current) && current.expression)) {
    current = unwrapExpression(current.expression);
  }

  return current;
}

function isJsxLikeExpression(node: ts.Expression) {
  return ts.isJsxElement(node)
    || ts.isJsxFragment(node)
    || ts.isJsxSelfClosingElement(node);
}

function getStandaloneCallExpression(statement: ts.Statement) {
  if (!ts.isExpressionStatement(statement)) {
    return undefined;
  }

  const rawExpression = unwrapExpression(statement.expression);
  if (ts.isAwaitExpression(rawExpression)) {
    return undefined;
  }

  let current = rawExpression;
  while (ts.isAwaitExpression(current)) {
    current = unwrapExpression(current.expression);
  }

  return ts.isCallExpression(current) ? current : undefined;
}

function isBareReturnStatement(statement: ts.Statement): statement is ts.ReturnStatement {
  return ts.isReturnStatement(statement) && !statement.expression;
}

function getPropertyNameText(name: ts.PropertyName | ts.MemberName) {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    return name.expression.getText();
  }

  return name.getText();
}

function getCallLikeName(expression: ts.LeftHandSideExpression) {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }

  return undefined;
}

function normalizeInlineText(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

function referenceNamesFromText(text: string) {
  const normalized = normalizeInlineText(text)
    .replace(/\s*\?\.\s*/g, '.')
    .replace(/\s*\.\s*/g, '.')
    .replace(/^\.{1,3}/, '')
    .replace(/[?!]+$/, '');
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(normalized)) return [];
  const parts = normalized.split('.');
  return parts.length === 1 ? parts : [parts[0], parts.at(-1)!];
}

function referenceNamesForFlowNode(node?: FlowNodeRow) {
  if (!node) return new Set<string>();
  const names = new Set<string>();
  if (node.renderPartsJson) {
    try {
      const parts = JSON.parse(node.renderPartsJson) as Array<Partial<RenderPartDescriptor> & { kind?: string }>;
      for (const part of parts) {
        if (part.labels?.includes('FieldName')) continue;
        if (!['value', 'virtual-value', 'value-container', 'field'].includes(String(part.kind || ''))
          && !part.labels?.some((label) => ['Value', 'ValueAccess'].includes(label))) continue;
        for (const name of referenceNamesFromText(part.plainText || part.text || '')) names.add(name);
      }
    } catch {
      // A malformed visual descriptor must not affect graph extraction.
    }
  }
  if (!names.size) {
    for (const text of [node.diaName, node.operationSubjectText]) {
      for (const name of referenceNamesFromText(String(text || ''))) names.add(name);
    }
  }
  return names;
}

function getCallDisplayBase(expression: ts.LeftHandSideExpression, sourceFile: ts.SourceFile) {
  const current = unwrapExpression(expression) as ts.LeftHandSideExpression;
  if (ts.isIdentifier(current)) {
    return current.text;
  }

  if (ts.isPropertyAccessExpression(current)) {
    const receiver = normalizeInlineText(current.expression.getText(sourceFile));
    return receiver ? `${receiver}.\n${current.name.text}` : current.name.text;
  }

  if (ts.isElementAccessExpression(current)) {
    const receiver = normalizeInlineText(current.expression.getText(sourceFile));
    const key = current.argumentExpression
      ? normalizeInlineText(current.argumentExpression.getText(sourceFile))
      : '';
    return receiver ? `${receiver}.\n[${key}]` : undefined;
  }

  return undefined;
}

function formatCallDiaName(callExpression: ts.CallExpression, sourceFile: ts.SourceFile) {
  const base = getCallDisplayBase(callExpression.expression, sourceFile)
    || getCallLikeName(callExpression.expression)
    || 'call';
  const args = [...callExpression.arguments];
  if (!args.length) {
    return `${base}()`;
  }
  return `${base}(`;
}

function formatObjectMethodDiaName(objectName: string, methodName: string, hasExpandedArgs = false) {
  const base = `${normalizeInlineText(objectName)}.\n${methodName}`;
  return hasExpandedArgs ? `${base}(` : `${base}()`;
}

function getAssignmentTargetName(expression: ts.Expression) {
  const current = unwrapExpression(expression);

  if (ts.isIdentifier(current)) {
    return current.text;
  }

  if (ts.isPropertyAccessExpression(current)) {
    return current.name.text;
  }

  if (ts.isElementAccessExpression(current)) {
    const argumentExpression = current.argumentExpression ? unwrapExpression(current.argumentExpression) : undefined;
    if (!argumentExpression) {
      return undefined;
    }

    if (ts.isStringLiteralLike(argumentExpression) || ts.isNumericLiteral(argumentExpression)) {
      return argumentExpression.text;
    }

    if (ts.isIdentifier(argumentExpression)) {
      return argumentExpression.text;
    }
  }

  return undefined;
}

function getFunctionNameFromRegistrationCall(node: ts.FunctionLikeDeclaration) {
  let current: ts.Node | undefined = node.parent;

  while (current && !ts.isSourceFile(current)) {
    if (ts.isCallExpression(current)) {
      const functionArgumentIndex = current.arguments.findIndex((argument) => argument === node || containsNode(argument, node));
      const calleeName = getCallLikeName(current.expression);

      if (functionArgumentIndex > 0 && calleeName) {
        const nameArgument = current.arguments[functionArgumentIndex - 1];
        if (ts.isStringLiteralLike(nameArgument) || ts.isNoSubstitutionTemplateLiteral(nameArgument)) {
          return nameArgument.text;
        }
      }
    }

    current = current.parent;
  }

  return undefined;
}

function getFunctionNameFromAncestor(node: ts.FunctionLikeDeclaration) {
  let current: ts.Node | undefined = node.parent;

  while (current && !ts.isSourceFile(current)) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      return current.name.text;
    }

    if (ts.isPropertyAssignment(current)) {
      return getPropertyNameText(current.name);
    }

    if (ts.isBinaryExpression(current) && isSimpleAssignmentExpression(current)) {
      const assignmentTargetName = getAssignmentTargetName(current.left);
      if (assignmentTargetName) {
        return assignmentTargetName;
      }
    }

    if (ts.isExportAssignment(current) && !current.isExportEquals) {
      return path.parse(node.getSourceFile().fileName).name;
    }

    const registrationName = ts.isCallExpression(current)
      ? getFunctionNameFromRegistrationCall(node)
      : undefined;
    if (registrationName) {
      return registrationName;
    }

    current = current.parent;
  }

  return undefined;
}

function containsNode(root: ts.Node, target: ts.Node) {
  if (root === target) {
    return true;
  }

  let found = false;
  root.forEachChild((child) => {
    if (found) {
      return;
    }

    if (containsNode(child, target)) {
      found = true;
    }
  });

  return found;
}

function getFunctionName(node: ts.FunctionLikeDeclaration) {
  if ('name' in node && node.name) {
    return getPropertyNameText(node.name);
  }

  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (parent && ts.isPropertyAssignment(parent)) {
    return getPropertyNameText(parent.name);
  }
  if (parent && ts.isBinaryExpression(parent) && isSimpleAssignmentExpression(parent)) {
    const assignmentTargetName = getAssignmentTargetName(parent.left);
    if (assignmentTargetName) {
      return assignmentTargetName;
    }
  }
  if (parent && ts.isExportAssignment(parent) && !parent.isExportEquals) {
    return path.parse(node.getSourceFile().fileName).name;
  }

  const ancestorName = getFunctionNameFromAncestor(node);
  if (ancestorName) {
    return ancestorName;
  }

  return '<anonymous>';
}

function getFunctionMethodOwner(node: ts.FunctionLikeDeclaration): ts.Node | undefined {
  let current: ts.Node | undefined = node.parent;
  if (current && (ts.isPropertyAssignment(current) || ts.isPropertyDeclaration(current))) {
    current = current.parent;
  }
  if (
    current
    && (
      ts.isClassDeclaration(current)
      || ts.isClassExpression(current)
      || ts.isInterfaceDeclaration(current)
      || ts.isTypeLiteralNode(current)
      || ts.isObjectLiteralExpression(current)
    )
  ) {
    return current;
  }
  return undefined;
}

function getMethodOwnerName(owner: ts.Node) {
  if (
    (ts.isClassDeclaration(owner) || ts.isClassExpression(owner) || ts.isInterfaceDeclaration(owner))
    && owner.name
  ) {
    return owner.name.text;
  }
  if (ts.isObjectLiteralExpression(owner)) {
    const parent = owner.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (ts.isPropertyAssignment(parent)) return getPropertyNameText(parent.name);
  }
  return 'object';
}

function functionSemanticLabels(node: ts.FunctionLikeDeclaration, accessorRole?: AccessorRole) {
  return uniqueStrings([
    ...(accessorRole ? [accessorRole] : []),
    ...(getFunctionMethodOwner(node) ? ['Method'] : []),
  ]);
}

function getApiMethodNameFromCall(callExpression: ts.CallExpression) {
  const methodNameArgument = callExpression.arguments[0];
  if (!methodNameArgument) {
    return undefined;
  }

  const current = unwrapExpression(methodNameArgument);
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
    return current.text;
  }

  return undefined;
}

function getStableIdKey(stableId: string | StableIdDescriptor | undefined) {
  return getStableIdValue(stableId) || '';
}

function isSyntheticMissingStableId(stableId: string | undefined) {
  return Boolean(stableId && stableId.startsWith('missing:'));
}

function buildSyntheticExternalFunctionRows(payload: GraphExtractedPayload) {
  const referencedStableIds = new Set<string>([
    ...payload.nodes
      .map((row) => getStableIdValue(row.calleeStableId))
      .filter((stableId): stableId is string => Boolean(stableId) && !isSyntheticMissingStableId(stableId)),
    ...payload.edges
      .flatMap((row) => [row.fromId, row.toId])
      .filter((stableId): stableId is string => Boolean(stableId) && !isSyntheticMissingStableId(stableId)),
  ]);
  const accessorRoleByStableId = new Map<string, AccessorRole>();
  for (const node of payload.nodes) {
    const calleeStableId = getStableIdValue(node.calleeStableId);
    if (!calleeStableId) continue;
    if (node.labels?.includes('Read')) accessorRoleByStableId.set(calleeStableId, 'Getter');
    if (node.labels?.includes('Write')) accessorRoleByStableId.set(calleeStableId, 'Setter');
  }

  return [...SYNTHETIC_EXTERNAL_TARGETS_BY_KEY.values()]
    .filter((target) => referencedStableIds.has(target.stableId))
    .map((target): FlowFunctionRow => ({
      stableId: buildOpaqueStableIdDescriptor(target.stableId, target.repoRelativePath || EXTERNAL_BROWSER_MEDIA_REPO_PATH),
      name: target.name || '<anonymous>',
      label: target.name || '<anonymous>',
      repoRelativePath: target.repoRelativePath || EXTERNAL_BROWSER_MEDIA_REPO_PATH,
      labels: ['External', ...(accessorRoleByStableId.has(target.stableId) ? [accessorRoleByStableId.get(target.stableId)!] : [])],
      isExternal: true,
    }));
}

function normalizeCalleeChainText(text: string) {
  return text.replace(/\s+/g, '');
}

function getExternalTargetByCalleeText(calleeText: string) {
  const normalized = normalizeCalleeChainText(calleeText);
  if (normalized === 'tool.call') {
    return SYNTHETIC_EXTERNAL_TARGETS_BY_KEY.get('dynamic-tool:tool.call');
  }

  if (/(^|\.)(beta\.)?messages\.create$/.test(normalized)) {
    return SYNTHETIC_EXTERNAL_TARGETS_BY_KEY.get('llm:anthropicMessagesCreate');
  }

  if (/(^|\.)(beta\.)?messages\.stream$/.test(normalized)) {
    return SYNTHETIC_EXTERNAL_TARGETS_BY_KEY.get('llm:anthropicMessagesStream');
  }

  return undefined;
}

function getExternalTargetByMethodName(methodName: string) {
  switch (methodName) {
    case 'feature':
      return SYNTHETIC_EXTERNAL_TARGETS_BY_KEY.get('bun-bundle:feature');
    case 'getDisplayMedia':
      return SYNTHETIC_EXTERNAL_TARGETS_BY_KEY.get('browser-media:getDisplayMedia');
    case 'getUserMedia':
      return SYNTHETIC_EXTERNAL_TARGETS_BY_KEY.get('browser-media:getUserMedia');
    case 'createDataChannel':
      return SYNTHETIC_EXTERNAL_TARGETS_BY_KEY.get('webrtc:createDataChannel');
    case 'setRemoteDescription':
      return SYNTHETIC_EXTERNAL_TARGETS_BY_KEY.get('webrtc:setRemoteDescription');
    case 'setLocalDescription':
      return SYNTHETIC_EXTERNAL_TARGETS_BY_KEY.get('webrtc:setLocalDescription');
    case 'createAnswer':
      return SYNTHETIC_EXTERNAL_TARGETS_BY_KEY.get('webrtc:createAnswer');
    case 'invokeRequest':
      return SYNTHETIC_EXTERNAL_TARGETS_BY_KEY.get('telegram-network:invokeRequest');
    case 'readFile':
      return SYNTHETIC_EXTERNAL_TARGETS_BY_KEY.get('local-data:readFile');
    case 'writeFile':
      return SYNTHETIC_EXTERNAL_TARGETS_BY_KEY.get('local-data:writeFile');
    case 'appendFile':
      return SYNTHETIC_EXTERNAL_TARGETS_BY_KEY.get('local-data:appendFile');
    case 'mkdir':
      return SYNTHETIC_EXTERNAL_TARGETS_BY_KEY.get('local-data:mkdir');
    case 'readdir':
      return SYNTHETIC_EXTERNAL_TARGETS_BY_KEY.get('local-data:readdir');
    case 'unlink':
      return SYNTHETIC_EXTERNAL_TARGETS_BY_KEY.get('local-data:unlink');
    default:
      return undefined;
  }
}

function isWebRtcRuntimeType(typeText: string | undefined) {
  const normalizedTypeText = String(typeText || '');
  return /\bRTCPeerConnection\b/.test(normalizedTypeText)
    || /\bRTCDataChannel\b/.test(normalizedTypeText)
    || /\bRTCSessionDescriptionInit\b/.test(normalizedTypeText);
}

function buildUniqueApiMethodTargets(program: ts.Program, stableIdByDeclaration: Map<ts.Node, string>) {
  const targetsByName = new Map<string, ResolvedCallTarget[]>();

  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile)) {
      continue;
    }

    const repoRelativePath = getRepoRelativePath(sourceFile.fileName);
    if (!repoRelativePath.startsWith(API_METHODS_REPO_PREFIX) || CALL_API_WRAPPER_REPO_PATHS.has(repoRelativePath)) {
      continue;
    }

    function visit(node: ts.Node): void {
      if (isFunctionLikeNode(node)) {
        const name = getFunctionName(node);
        if (name !== '<anonymous>') {
          const stableId = stableIdByDeclaration.get(node) || getStableId(sourceFile, node);
          if (stableId) {
            const existing = targetsByName.get(name) || [];
            existing.push({
              stableId,
              name,
              repoRelativePath,
            });
            targetsByName.set(name, existing);
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  const uniqueTargets = new Map<string, ResolvedCallTarget>();
  for (const [name, targets] of targetsByName) {
    if (targets.length === 1) {
      uniqueTargets.set(name, targets[0]);
    }
  }

  return uniqueTargets;
}

function buildUniqueFunctionTargets(program: ts.Program, stableIdByDeclaration: Map<ts.Node, string>) {
  const targetsByName = new Map<string, ResolvedCallTarget[]>();

  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile)) {
      continue;
    }

    const repoRelativePath = getRepoRelativePath(sourceFile.fileName);

    function visit(node: ts.Node): void {
      if (isFunctionLikeNode(node) && node.body) {
        const name = getFunctionName(node);
        if (name !== '<anonymous>') {
          const stableId = stableIdByDeclaration.get(node) || getStableId(sourceFile, node);
          if (stableId) {
            const existing = targetsByName.get(name) || [];
            existing.push({
              stableId,
              name,
              repoRelativePath,
            });
            targetsByName.set(name, existing);
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  const uniqueTargets = new Map<string, ResolvedCallTarget>();
  for (const [name, targets] of targetsByName) {
    if (targets.length === 1) {
      uniqueTargets.set(name, targets[0]);
    }
  }

  return uniqueTargets;
}

function buildUniqueActionTargets(program: ts.Program, stableIdByDeclaration: Map<ts.Node, string>) {
  const targetsByName = new Map<string, ResolvedCallTarget[]>();

  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile)) {
      continue;
    }

    const repoRelativePath = getRepoRelativePath(sourceFile.fileName);
    if (!repoRelativePath.startsWith(GLOBAL_ACTIONS_REPO_PREFIX)) {
      continue;
    }

    function visit(node: ts.Node): void {
      if (isFunctionLikeNode(node) && node.body) {
        const name = getFunctionName(node);
        if (name !== '<anonymous>') {
          const stableId = stableIdByDeclaration.get(node) || getStableId(sourceFile, node);
          if (stableId) {
            const existing = targetsByName.get(name) || [];
            existing.push({
              stableId,
              name,
              repoRelativePath,
            });
            targetsByName.set(name, existing);
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  const uniqueTargets = new Map<string, ResolvedCallTarget>();
  for (const [name, targets] of targetsByName) {
    if (targets.length === 1) {
      uniqueTargets.set(name, targets[0]);
    }
  }

  return uniqueTargets;
}

function isGetActionsBindingDeclaration(node: ts.Node) {
  if (!ts.isBindingElement(node)) {
    return false;
  }

  const bindingPattern = node.parent;
  if (!bindingPattern || !ts.isObjectBindingPattern(bindingPattern)) {
    return false;
  }

  const variableDeclaration = bindingPattern.parent;
  if (!variableDeclaration || !ts.isVariableDeclaration(variableDeclaration) || !variableDeclaration.initializer) {
    return false;
  }

  const initializer = unwrapExpression(variableDeclaration.initializer);
  return ts.isCallExpression(initializer) && getCallLikeName(initializer.expression) === 'getActions';
}

function getWrappedFunctionLike(expression: ts.Expression | undefined): ts.FunctionLikeDeclaration | undefined {
  if (!expression) {
    return undefined;
  }

  const current = unwrapExpression(expression);
  if (isFunctionLikeNode(current)) {
    return current;
  }
  if (ts.isCallExpression(current)) {
    for (const argument of current.arguments) {
      if (!ts.isExpression(argument)) {
        continue;
      }
      const wrapped = getWrappedFunctionLike(argument);
      if (wrapped) {
        return wrapped;
      }
    }
  }

  return undefined;
}

function buildEmptyResult(): BuildResult {
  return {
    openExits: [],
    pendingBreaks: [],
    pendingContinues: [],
    pendingThrows: [],
  };
}

function mergeResults(left: BuildResult, right: BuildResult): BuildResult {
  return {
    firstNodeId: left.firstNodeId || right.firstNodeId,
    openExits: right.openExits,
    pendingBreaks: [...left.pendingBreaks, ...right.pendingBreaks],
    pendingContinues: [...left.pendingContinues, ...right.pendingContinues],
    pendingThrows: [...left.pendingThrows, ...right.pendingThrows],
  };
}

function isLoopStatement(node: ts.Statement): node is ts.IterationStatement {
  return ts.isWhileStatement(node) || ts.isForStatement(node) || ts.isDoStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node);
}

function isControlStatement(node: ts.Statement) {
  return ts.isIfStatement(node)
    || ts.isSwitchStatement(node)
    || isLoopStatement(node)
    || ts.isTryStatement(node)
    || ts.isReturnStatement(node)
    || ts.isBreakStatement(node)
    || ts.isContinueStatement(node)
    || ts.isThrowStatement(node);
}

function collectCallExpressions(node: ts.Node) {
  const calls: ts.CallExpression[] = [];

  function visit(current: ts.Node): void {
    if (current !== node && isFunctionLikeNode(current)) {
      return;
    }
    if (ts.isCallExpression(current)) {
      calls.push(current);
    }
    ts.forEachChild(current, visit);
  }

  visit(node);
  calls.sort((left, right) => left.getStart() - right.getStart());
  return calls;
}

function collectCallExpressionsIncludingNestedFunctions(node: ts.Node) {
  const calls: ts.CallExpression[] = [];

  function visit(current: ts.Node): void {
    if (ts.isCallExpression(current)) {
      calls.push(current);
    }
    ts.forEachChild(current, visit);
  }

  visit(node);
  calls.sort((left, right) => left.getStart() - right.getStart());
  return calls;
}

function isFunctionArgumentExpression(node: ts.Expression): node is ts.ArrowFunction | ts.FunctionExpression {
  const current = unwrapExpression(node);
  return ts.isArrowFunction(current) || ts.isFunctionExpression(current);
}

function containsJsxNode(node: ts.Node | undefined) {
  if (!node) {
    return false;
  }
  let found = false;
  function visit(current: ts.Node) {
    if (found) {
      return;
    }
    if (
      ts.isJsxElement(current)
      || ts.isJsxSelfClosingElement(current)
      || ts.isJsxFragment(current)
    ) {
      found = true;
      return;
    }
    if (current !== node && (ts.isArrowFunction(current) || ts.isFunctionExpression(current) || ts.isFunctionDeclaration(current))) {
      return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function objectLiteralHasProperty(node: ts.Node | undefined, propertyName: string) {
  if (!node) {
    return false;
  }

  const current = ts.isExpression(node) ? unwrapExpression(node) : node;
  if (!ts.isObjectLiteralExpression(current)) {
    return false;
  }

  return current.properties.some((property) => {
    if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) || ts.isMethodDeclaration(property)) {
      return getPropertyNameText(property.name) === propertyName;
    }
    return false;
  });
}

function nodeHasModifier(node: ts.Node, kind: ts.SyntaxKind) {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind));
}

function jsxRootName(node: ts.Node | undefined) {
  if (!node) {
    return undefined;
  }
  const expression = ts.isExpression(node) ? unwrapExpression(node) : node;
  if (ts.isJsxSelfClosingElement(expression)) {
    return expression.tagName.getText(expression.getSourceFile());
  }
  if (ts.isJsxElement(expression)) {
    return expression.openingElement.tagName.getText(expression.getSourceFile());
  }
  if (ts.isJsxFragment(expression)) {
    return 'fragment';
  }
  let found: string | undefined;
  function visit(current: ts.Node) {
    if (found) {
      return;
    }
    if (ts.isJsxSelfClosingElement(current)) {
      found = current.tagName.getText(current.getSourceFile());
      return;
    }
    if (ts.isJsxElement(current)) {
      found = current.openingElement.tagName.getText(current.getSourceFile());
      return;
    }
    if (ts.isJsxFragment(current)) {
      found = 'fragment';
      return;
    }
    if (current !== node && (ts.isArrowFunction(current) || ts.isFunctionExpression(current) || ts.isFunctionDeclaration(current))) {
      return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function isMemberAccessExpression(node: ts.Node): node is ts.PropertyAccessExpression | ts.ElementAccessExpression {
  return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
}

function isPropertyAccessLikeExpression(node: ts.Node): node is ts.PropertyAccessExpression {
  return ts.isPropertyAccessExpression(node);
}

function sanitizeSyntheticExternalPart(value: string) {
  return value
    .replace(/\\/g, '/')
    .replace(/[^A-Za-z0-9_.@/-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^-+|-+$/g, '')
    || 'unknown';
}

function collectRequireSpecifiers(node: ts.Node | undefined) {
  const specifiers: string[] = [];
  if (!node) return specifiers;

  function visit(current: ts.Node): void {
    if (
      ts.isCallExpression(current)
      && ts.isIdentifier(current.expression)
      && current.expression.text === 'require'
      && current.arguments.length === 1
      && ts.isStringLiteralLike(current.arguments[0])
    ) {
      specifiers.push(current.arguments[0].text);
      return;
    }
    ts.forEachChild(current, visit);
  }

  visit(node);
  return [...new Set(specifiers)];
}

function collectFeatureGateNames(node: ts.Node | undefined) {
  const names: string[] = [];
  if (!node) return names;

  function visit(current: ts.Node): void {
    if (
      ts.isCallExpression(current)
      && ts.isIdentifier(current.expression)
      && current.expression.text === 'feature'
      && current.arguments.length >= 1
      && ts.isStringLiteralLike(current.arguments[0])
    ) {
      names.push(current.arguments[0].text);
      return;
    }
    ts.forEachChild(current, visit);
  }

  visit(node);
  return uniqueStrings(names);
}

function moduleCandidatePaths(basePath: string) {
  const parsed = path.parse(basePath);
  const hasExtension = Boolean(parsed.ext);
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
  const candidates = hasExtension
    ? [
        basePath,
        ...extensions.map((extension) => path.join(parsed.dir, `${parsed.name}${extension}`)),
      ]
    : [
        basePath,
        ...extensions.map((extension) => `${basePath}${extension}`),
        ...extensions.map((extension) => path.join(basePath, `index${extension}`)),
      ];
  return uniqueStrings(candidates.map((candidate) => path.normalize(candidate)));
}

function resolveRelativeModulePath(sourceFile: ts.SourceFile, moduleSpecifier: string) {
  if (!moduleSpecifier.startsWith('.')) {
    return undefined;
  }

  const basePath = path.resolve(path.dirname(sourceFile.fileName), moduleSpecifier);
  return moduleCandidatePaths(basePath).find((candidate) => fs.existsSync(candidate));
}

function isTopmostMaterializableMemberAccess(expression: ts.PropertyAccessExpression | ts.ElementAccessExpression) {
  const parent = expression.parent;
  if (ts.isBinaryExpression(parent) && isSimpleAssignmentExpression(parent) && parent.left === expression) {
    return false;
  }
  if (isMemberAccessExpression(parent) && parent.expression === expression) {
    return false;
  }
  if (ts.isCallExpression(parent) && parent.expression === expression) {
    return false;
  }

  return true;
}

function isMaterializableCallArgumentIdentifier(expression: ts.Identifier) {
  if (expression.text === 'undefined') {
    return false;
  }

  const parent = expression.parent;
  if (!ts.isCallExpression(parent)) {
    return false;
  }

  return parent.arguments.some((argument) => argument === expression);
}

function isShortCircuitBinaryOperator(kind: ts.SyntaxKind) {
  return kind === ts.SyntaxKind.BarBarToken
    || kind === ts.SyntaxKind.AmpersandAmpersandToken
    || kind === ts.SyntaxKind.QuestionQuestionToken;
}

function isShortCircuitBinaryExpression(expression: ts.Expression): expression is ts.BinaryExpression {
  return ts.isBinaryExpression(expression) && isShortCircuitBinaryOperator(expression.operatorToken.kind);
}

function isBooleanShortCircuitBinaryExpression(expression: ts.Expression): expression is ts.BinaryExpression {
  return ts.isBinaryExpression(expression)
    && (
      expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      || expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
    );
}

function isStructuredControlExpression(expression: ts.Expression) {
  const current = unwrapExpression(expression);
  return ts.isConditionalExpression(current) || isShortCircuitBinaryExpression(current);
}

function isSimpleAssignmentExpression(expression: ts.Expression): expression is ts.BinaryExpression {
  return ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken;
}

function isSystemValueExpression(expression: ts.Expression) {
  const current = unwrapExpression(expression);
  return ts.isIdentifier(current) && current.text === 'undefined';
}

function isLiteralValueExpression(expression: ts.Expression) {
  const current = unwrapExpression(expression);
  return ts.isLiteralExpression(current)
    || current.kind === ts.SyntaxKind.TrueKeyword
    || current.kind === ts.SyntaxKind.FalseKeyword
    || current.kind === ts.SyntaxKind.NullKeyword
    || isSystemValueExpression(current);
}

function literalValueLabels(expression: ts.Expression, extra: string[] = []) {
  return uniqueStrings([
    'Value',
    'Literal',
    ...(isSystemValueExpression(expression) ? ['System', 'SystemValue'] : []),
    ...extra,
  ]);
}

function isTrivialLiteralExpression(expression: ts.Expression) {
  const current = unwrapExpression(expression);

  return ts.isObjectLiteralExpression(current)
    || ts.isArrayLiteralExpression(current)
    || current.kind === ts.SyntaxKind.TrueKeyword
    || current.kind === ts.SyntaxKind.FalseKeyword
    || current.kind === ts.SyntaxKind.NullKeyword
    || (ts.isIdentifier(current) && current.text === 'undefined');
}

function isBooleanLikeVariableName(name: string) {
  return /^(is|has|can|should|use|allow|enable|disable|skip|show|hide|was|did|does|needs?)[A-Z_]/.test(name)
    || /(Enabled|Disabled|Active|Immediate|Visible|Hidden|Pending|Ready|Valid|Invalid|Allowed|Available|Present|Empty|Matched|Found)$/.test(name);
}

function isBooleanLikeExpression(expression: ts.Expression) {
  const current = unwrapExpression(expression);
  if (isBooleanShortCircuitBinaryExpression(current)) {
    return true;
  }
  if (current.kind === ts.SyntaxKind.TrueKeyword || current.kind === ts.SyntaxKind.FalseKeyword) {
    return true;
  }
  if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.ExclamationToken) {
    return true;
  }
  if (ts.isBinaryExpression(current)) {
    return [
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
      ts.SyntaxKind.LessThanToken,
      ts.SyntaxKind.LessThanEqualsToken,
      ts.SyntaxKind.GreaterThanToken,
      ts.SyntaxKind.GreaterThanEqualsToken,
      ts.SyntaxKind.InstanceOfKeyword,
      ts.SyntaxKind.InKeyword,
    ].includes(current.operatorToken.kind);
  }
  return false;
}

function containsOptionalChain(node: ts.Node) {
  let found = false;
  function visit(current: ts.Node): void {
    if (found) {
      return;
    }
    if ('questionDotToken' in current && Boolean((current as { questionDotToken?: ts.QuestionDotToken }).questionDotToken)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function containsNullLiteral(node: ts.Node) {
  let found = false;
  function visit(current: ts.Node): void {
    if (found) {
      return;
    }
    if (current.kind === ts.SyntaxKind.NullKeyword) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function valueOutcomeSpecsForExpression(expression: ts.Expression) {
  const current = unwrapExpression(expression);
  const falsyParts = ['falsy'];
  const falsyLabels = ['ValueOutcome', 'FalsyOutcome'];
  if (containsOptionalChain(current) || (ts.isIdentifier(current) && current.text === 'undefined')) {
    falsyParts.push('undefined');
    falsyLabels.push('UndefinedOutcome');
  }
  if (containsNullLiteral(current) || current.kind === ts.SyntaxKind.NullKeyword) {
    falsyParts.push('null');
    falsyLabels.push('NullOutcome');
  }
  const outcomes = [
    { key: 'truthy', label: 'truthy', labels: ['ValueOutcome', 'TruthyOutcome'] },
    { key: 'falsy', label: falsyParts.join(' / '), labels: uniqueStrings(falsyLabels) },
  ];
  return outcomes;
}

function isLiteralInlineCallArgument(expression: ts.Expression): boolean {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) {
    return current.text === 'undefined';
  }
  if (ts.isStringLiteralLike(current) || ts.isNumericLiteral(current) || ts.isBigIntLiteral(current)) {
    return true;
  }
  if (ts.isObjectLiteralExpression(current)) {
    return current.properties.every((property) => (
      ts.isPropertyAssignment(property)
      && isLiteralInlineCallArgument(property.initializer)
    ));
  }
  if (ts.isArrayLiteralExpression(current)) {
    return current.elements.every((element) => (
      !ts.isSpreadElement(element)
      && isLiteralInlineCallArgument(element)
    ));
  }
  if (
    ts.isPrefixUnaryExpression(current)
    && (current.operator === ts.SyntaxKind.PlusToken || current.operator === ts.SyntaxKind.MinusToken)
  ) {
    return ts.isNumericLiteral(unwrapExpression(current.operand));
  }
  return current.kind === ts.SyntaxKind.TrueKeyword
    || current.kind === ts.SyntaxKind.FalseKeyword
    || current.kind === ts.SyntaxKind.NullKeyword;
}

function resolvedSymbolAt(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return undefined;
  if (!(symbol.flags & ts.SymbolFlags.Alias)) return symbol;
  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return symbol;
  }
}

function isReactStateHookCall(callExpression: ts.CallExpression, checker: ts.TypeChecker) {
  const hook = unwrapExpression(callExpression.expression);
  if (ts.isPropertyAccessExpression(hook) && ts.isIdentifier(hook.expression)) {
    if (hook.name.text !== 'useState' && hook.name.text !== 'useReducer') return false;
    const namespaceSymbol = checker.getSymbolAtLocation(hook.expression);
    return (namespaceSymbol?.declarations || []).some((declaration) => {
      if (!ts.isNamespaceImport(declaration)) return false;
      const importDeclaration = declaration.parent.parent;
      return ts.isImportDeclaration(importDeclaration)
        && ts.isStringLiteral(importDeclaration.moduleSpecifier)
        && importDeclaration.moduleSpecifier.text === 'react';
    });
  }
  if (!ts.isIdentifier(hook)) return false;
  const symbol = checker.getSymbolAtLocation(hook);
  const resolved = resolvedSymbolAt(checker, hook);
  const declarations = [
    ...(symbol?.declarations || []),
    ...(resolved?.declarations || []),
  ];
  return declarations.some((declaration) => {
    if (!ts.isImportSpecifier(declaration)) return false;
    const importDeclaration = declaration.parent.parent.parent;
    if (!ts.isImportDeclaration(importDeclaration) || !ts.isStringLiteral(importDeclaration.moduleSpecifier)) return false;
    const importedName = (declaration.propertyName || declaration.name).text;
    return importDeclaration.moduleSpecifier.text === 'react'
      && (importedName === 'useState' || importedName === 'useReducer');
  });
}

function leadingSourceDocumentation(node: ts.Node, sourceFile: ts.SourceFile) {
  let documentedNode = node;
  while (documentedNode.parent && !ts.isStatement(documentedNode)) {
    documentedNode = documentedNode.parent;
  }
  const ranges = ts.getLeadingCommentRanges(sourceFile.text, documentedNode.getFullStart()) || [];
  const lines = ranges.flatMap((range) => {
    const raw = sourceFile.text.slice(range.pos, range.end);
    if (raw.startsWith('//')) return [raw.replace(/^\/\/\s?/u, '').trim()];
    return raw
      .replace(/^\/\*+|\*+\/$/gu, '')
      .split(/\r?\n/u)
      .map((line) => line.replace(/^\s*\*\s?/u, '').trim());
  }).filter(Boolean);
  return lines.length ? lines.join('\n') : undefined;
}

function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name));
}

function buildReactStateProvenance(program: ts.Program, checker: ts.TypeChecker): ReactStateProvenance {
  const resourcesBySetterSymbol = new Map<ts.Symbol, Map<string, ReactStateResourceIdentity>>();
  const resourceByCreationCall = new Map<ts.CallExpression, ReactStateResourceIdentity>();
  const trackedFiles = program.getSourceFiles().filter(isTrackedSourceFile);

  const add = (symbol: ts.Symbol | undefined, resources: Iterable<ReactStateResourceIdentity>) => {
    if (!symbol) return false;
    let target = resourcesBySetterSymbol.get(symbol);
    if (!target) {
      target = new Map();
      resourcesBySetterSymbol.set(symbol, target);
    }
    let changed = false;
    for (const resource of resources) {
      if (target.has(resource.stableId)) continue;
      target.set(resource.stableId, resource);
      changed = true;
    }
    return changed;
  };

  const resourcesForExpression = (expression: ts.Expression | undefined) => {
    if (!expression) return [];
    const current = unwrapExpression(expression);
    if (ts.isIdentifier(current) || ts.isPropertyAccessExpression(current)) {
      const symbol = resolvedSymbolAt(checker, ts.isPropertyAccessExpression(current) ? current.name : current);
      return [...(symbol && resourcesBySetterSymbol.get(symbol)?.values() || [])];
    }
    return [];
  };

  const ownerStableId = (identifier: ts.Identifier) => {
    let owner: ts.Node | undefined = identifier.parent;
    while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
    return owner
      ? getStableId(identifier.getSourceFile(), owner)
      : getStableId(identifier.getSourceFile(), identifier);
  };

  for (const sourceFile of trackedFiles) {
    const seed = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node)
        && ts.isArrayBindingPattern(node.name)
        && node.initializer
        && ts.isCallExpression(unwrapExpression(node.initializer))
        && isReactStateHookCall(unwrapExpression(node.initializer) as ts.CallExpression, checker)) {
        const stateElement = node.name.elements[0];
        const setterElement = node.name.elements[1];
        if (stateElement && setterElement
          && !ts.isOmittedExpression(stateElement)
          && !ts.isOmittedExpression(setterElement)
          && ts.isIdentifier(stateElement.name)
          && ts.isIdentifier(setterElement.name)) {
          const creationCall = unwrapExpression(node.initializer) as ts.CallExpression;
          const setterBindingStableId = getStableId(sourceFile, setterElement.name);
          const setterBindingDescriptor = getStableIdDescriptor(sourceFile, setterElement.name);
          const setterStableId = `flow-accessor:setter:${setterBindingStableId}`;
          const identity: ReactStateResourceIdentity = {
            stableId: getStableId(sourceFile, stateElement.name),
            parentFnStableId: ownerStableId(stateElement.name),
            repoRelativePath: getRepoRelativePath(sourceFile.fileName),
            name: stateElement.name.text,
            setterName: setterElement.name.text,
            setterStableId,
            setterStableIdDescriptor: {
              ...setterBindingDescriptor,
              value: setterStableId,
              suffix: 'react-state-setter',
            },
          };
          resourceByCreationCall.set(creationCall, identity);
          add(resolvedSymbolAt(checker, setterElement.name), [identity]);
        }
      }
      ts.forEachChild(node, seed);
    };
    seed(sourceFile);
  }

  const callableDeclarations = (expression: ts.Expression, visited = new Set<ts.Symbol>()): ts.FunctionLikeDeclaration[] => {
    const current = unwrapExpression(expression);
    const symbolNode = ts.isPropertyAccessExpression(current) ? current.name : current;
    const symbol = resolvedSymbolAt(checker, symbolNode);
    if (!symbol || visited.has(symbol)) return [];
    visited.add(symbol);
    const result: ts.FunctionLikeDeclaration[] = [];
    for (const declaration of symbol.declarations || []) {
      if (isFunctionLikeNode(declaration)) {
        result.push(declaration);
        continue;
      }
      if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) continue;
      const initializer = unwrapExpression(declaration.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        result.push(initializer);
      } else if (ts.isIdentifier(initializer) || ts.isPropertyAccessExpression(initializer)) {
        result.push(...callableDeclarations(initializer, visited));
      } else if (ts.isCallExpression(initializer) && initializer.arguments[0]) {
        const wrapperName = ts.isPropertyAccessExpression(initializer.expression)
          ? initializer.expression.name.text
          : ts.isIdentifier(initializer.expression) ? initializer.expression.text : '';
        if (wrapperName === 'memo' || wrapperName === 'forwardRef') {
          const wrapped = unwrapExpression(initializer.arguments[0]);
          if (ts.isArrowFunction(wrapped) || ts.isFunctionExpression(wrapped)) result.push(wrapped);
          else if (ts.isIdentifier(wrapped) || ts.isPropertyAccessExpression(wrapped)) result.push(...callableDeclarations(wrapped, visited));
        }
      }
    }
    return result;
  };

  const addToBindingName = (name: ts.BindingName, resources: ReactStateResourceIdentity[]) => {
    let changed = false;
    for (const identifier of bindingIdentifiers(name)) {
      changed = add(resolvedSymbolAt(checker, identifier), resources) || changed;
    }
    return changed;
  };

  const propagateObjectArgument = (argument: ts.ObjectLiteralExpression, parameter: ts.ObjectBindingPattern) => {
    let changed = false;
    for (const element of parameter.elements) {
      const propertyName = element.propertyName && ts.isIdentifier(element.propertyName)
        ? element.propertyName.text
        : ts.isIdentifier(element.name) ? element.name.text : undefined;
      if (!propertyName) continue;
      const property = argument.properties.find((candidate) => {
        return (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate))
          && getPropertyNameText(candidate.name) === propertyName;
      });
      if (!property) continue;
      const value = ts.isPropertyAssignment(property) ? property.initializer : property.name;
      changed = addToBindingName(element.name, resourcesForExpression(value)) || changed;
    }
    return changed;
  };

  for (let pass = 0; pass < 12; pass += 1) {
    let changed = false;
    for (const sourceFile of trackedFiles) {
      const propagate = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && node.initializer) {
          changed = addToBindingName(node.name, resourcesForExpression(node.initializer)) || changed;
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const left = unwrapExpression(node.left);
          if (ts.isIdentifier(left)) changed = add(resolvedSymbolAt(checker, left), resourcesForExpression(node.right)) || changed;
        }
        if (ts.isCallExpression(node)) {
          for (const declaration of callableDeclarations(node.expression)) {
            declaration.parameters.forEach((parameter, index) => {
              const argument = node.arguments[index];
              if (!argument) return;
              const normalized = unwrapExpression(argument);
              if (ts.isObjectBindingPattern(parameter.name) && ts.isObjectLiteralExpression(normalized)) {
                changed = propagateObjectArgument(normalized, parameter.name) || changed;
              } else {
                changed = addToBindingName(parameter.name, resourcesForExpression(argument)) || changed;
              }
            });
          }
        }
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          for (const declaration of callableDeclarations(node.tagName as ts.Expression)) {
            const props = declaration.parameters[0]?.name;
            if (!props || !ts.isObjectBindingPattern(props)) continue;
            for (const attribute of node.attributes.properties) {
              if (!ts.isJsxAttribute(attribute) || !attribute.initializer || !ts.isJsxExpression(attribute.initializer)) continue;
              const expression = attribute.initializer.expression;
              if (!expression) continue;
              const attributeName = attribute.name.getText(sourceFile);
              const element = props.elements.find((candidate) => {
                const declarationSourceFile = candidate.getSourceFile();
                const name = candidate.propertyName?.getText(declarationSourceFile) || candidate.name.getText(declarationSourceFile);
                return name === attributeName;
              });
              if (element) changed = addToBindingName(element.name, resourcesForExpression(expression)) || changed;
            }
          }
        }
        ts.forEachChild(node, propagate);
      };
      propagate(sourceFile);
    }
    if (!changed) break;
  }

  return { resourcesBySetterSymbol, resourceByCreationCall };
}

export function extractReactStateProvenanceFacts(program: ts.Program) {
  const checker = program.getTypeChecker();
  const provenance = buildReactStateProvenance(program, checker);
  return [...provenance.resourcesBySetterSymbol.entries()].map(([symbol, resources]) => ({
    symbolName: symbol.getName(),
    declarations: (symbol.declarations || []).map((declaration) => ({
      repoRelativePath: getRepoRelativePath(declaration.getSourceFile().fileName),
      stableId: getStableId(declaration.getSourceFile(), declaration),
      syntax: declaration.getText(declaration.getSourceFile()),
    })),
    resources: [...resources.values()],
  }));
}

function collectMaterializedExpressions(node: ts.Node) {
  const expressions: ts.Expression[] = [];
  const seen = new Set<string>();

  function push(expression: ts.Expression) {
    const key = `${expression.getStart()}-${expression.getEnd()}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    expressions.push(expression);
  }

  function visit(current: ts.Node): void {
    if (current !== node && isFunctionLikeNode(current)) {
      return;
    }
    if (ts.isExpression(current) && isStructuredControlExpression(current)) {
      push(current);
    } else if (ts.isCallExpression(current)) {
      push(current);
    } else if (isMemberAccessExpression(current) && isTopmostMaterializableMemberAccess(current)) {
      push(current);
    } else if (ts.isIdentifier(current) && isMaterializableCallArgumentIdentifier(current)) {
      push(current);
    }
    ts.forEachChild(current, visit);
  }

  visit(node);

  if (ts.isVariableStatement(node)) {
    for (const declaration of node.declarationList.declarations) {
      const initializer = declaration.initializer ? unwrapExpression(declaration.initializer) : undefined;
      if (initializer && ts.isIdentifier(initializer) && initializer.text !== 'undefined') {
        push(initializer);
      }
    }
  }

  expressions.sort((left, right) => {
    const leftStart = left.getStart();
    const rightStart = right.getStart();
    const leftEnd = left.getEnd();
    const rightEnd = right.getEnd();

    const leftContainsRight = leftStart <= rightStart && leftEnd >= rightEnd
      && (leftStart !== rightStart || leftEnd !== rightEnd);
    const rightContainsLeft = rightStart <= leftStart && rightEnd >= leftEnd
      && (leftStart !== rightStart || leftEnd !== rightEnd);

    if (leftContainsRight) {
      return 1;
    }
    if (rightContainsLeft) {
      return -1;
    }

    if (leftStart !== rightStart) {
      return leftStart - rightStart;
    }

    return leftEnd - rightEnd;
  });
  return expressions;
}

function hasCalls(node: ts.Node) {
  return collectCallExpressions(node).length > 0;
}

function hasImpureExpression(node: ts.Node) {
  let found = false;

  function visit(current: ts.Node): void {
    if (found) {
      return;
    }
    if (current !== node && isFunctionLikeNode(current)) {
      return;
    }

    if (
      ts.isCallExpression(current)
      || ts.isNewExpression(current)
      || ts.isAwaitExpression(current)
      || ts.isYieldExpression(current)
      || ts.isDeleteExpression(current)
      || ts.isPostfixUnaryExpression(current)
      || (ts.isPrefixUnaryExpression(current) && (
        current.operator === ts.SyntaxKind.PlusPlusToken
        || current.operator === ts.SyntaxKind.MinusMinusToken
      ))
      || (ts.isBinaryExpression(current) && [
        ts.SyntaxKind.EqualsToken,
        ts.SyntaxKind.PlusEqualsToken,
        ts.SyntaxKind.MinusEqualsToken,
        ts.SyntaxKind.AsteriskEqualsToken,
        ts.SyntaxKind.AsteriskAsteriskEqualsToken,
        ts.SyntaxKind.SlashEqualsToken,
        ts.SyntaxKind.PercentEqualsToken,
        ts.SyntaxKind.AmpersandEqualsToken,
        ts.SyntaxKind.BarEqualsToken,
        ts.SyntaxKind.CaretEqualsToken,
        ts.SyntaxKind.LessThanLessThanEqualsToken,
        ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
        ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
        ts.SyntaxKind.QuestionQuestionEqualsToken,
        ts.SyntaxKind.AmpersandAmpersandEqualsToken,
        ts.SyntaxKind.BarBarEqualsToken,
      ].includes(current.operatorToken.kind))
    ) {
      found = true;
      return;
    }

    ts.forEachChild(current, visit);
  }

  visit(node);
  return found;
}

function hasMaterializedExpressions(node: ts.Node) {
  return collectMaterializedExpressions(node).length > 0;
}

function filterExpressionsCoveredByStructuredExpressions(expressions: ts.Expression[]) {
  return expressions.filter((expression) => {
    return !expressions.some((candidate) => {
      if (candidate === expression || !isStructuredControlExpression(candidate)) {
        return false;
      }

      const candidateStart = candidate.getStart();
      const candidateEnd = candidate.getEnd();
      const expressionStart = expression.getStart();
      const expressionEnd = expression.getEnd();

      return candidateStart <= expressionStart
        && candidateEnd >= expressionEnd
        && (candidateStart !== expressionStart || candidateEnd !== expressionEnd);
    });
  });
}

function getExpressionText(sourceFile: ts.SourceFile, expression: ts.Expression | undefined) {
  return expression ? expression.getText(sourceFile) : '';
}

function isBufferableLinearStatement(statement: ts.Statement) {
  if (ts.isBlock(statement)) {
    return false;
  }
  return !isControlStatement(statement) && !hasMaterializedExpressions(statement);
}

function isDeferredTypeText(typeText: string | undefined) {
  return Boolean(typeText && /(^|\W)Deferred(?:<|\b)/.test(typeText));
}

function isPromiseTypeText(typeText: string | undefined) {
  return Boolean(typeText && /(^|\W)(?:Promise(?:Like)?|EnsurePromise)(?:<|\b)/.test(typeText));
}

function isAbortSignalTypeText(typeText: string | undefined) {
  return Boolean(typeText && /(^|\W)AbortSignal(?:<|\b)/.test(typeText));
}

function isAbortControllerTypeText(typeText: string | undefined) {
  return Boolean(typeText && /(^|\W)(?:AbortController|ChatAbortController)(?:<|\b)/.test(typeText));
}

function isPromiseCollectionTypeText(typeText: string | undefined) {
  return Boolean(typeText && (
    /(?:^|\W)(?:Array|ReadonlyArray|Iterable)<[^>]*Promise(?:Like)?/i.test(typeText)
    || /Promise(?:Like)?(?:<[^>]+>)?\[\]/.test(typeText)
  ));
}

function getPromiseCombinatorKind(expression: ts.CallExpression) {
  const callee = expression.expression;
  if (!ts.isPropertyAccessExpression(callee)) {
    return undefined;
  }

  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== 'Promise') {
    return undefined;
  }

  const methodName = getPropertyNameText(callee.name);
  if (methodName !== 'all' && methodName !== 'allSettled' && methodName !== 'any' && methodName !== 'race') {
    return undefined;
  }

  return methodName;
}

function buildPromiseResourceDescriptor(resourceName: string, resourceSubkind: 'promise' | 'promise-collection') {
  return {
    resourceKind: 'async-flow',
    resourceSubkind,
    resourceName,
  };
}

function deriveTimeoutResourceSemanticId(resourceName: string | undefined) {
  if (!resourceName) {
    return undefined;
  }

  if (resourceName === 'seqTimeout') {
    return 'timeout:seq-difference';
  }

  if (/^PTS_TIMEOUTS\.get\(/.test(resourceName)) {
    return 'timeout:channel-difference';
  }

  if (/^callbacks\.get\(/.test(resourceName)) {
    return 'timeout:action-timeout';
  }

  return undefined;
}

function deriveAbortResourceSemanticIdFromText(text: string | undefined) {
  if (!text) {
    return undefined;
  }

  if (/\bABORT_CONTROLLERS\.get\(/.test(text)) {
    return 'abort:group';
  }

  if (/\bCHAT_ABORT_CONTROLLERS\.get\(/.test(text)) {
    return 'abort:chat';
  }

  if (/\.getThreadSignal\(/.test(text)) {
    return 'abort:thread';
  }

  return undefined;
}

function findAncestorNode<T extends ts.Node>(node: ts.Node | undefined, predicate: (candidate: ts.Node) => candidate is T): T | undefined {
  let current = node?.parent;
  while (current) {
    if (predicate(current)) {
      return current;
    }
    current = current.parent;
  }

  return undefined;
}

function collectReturnedExpressionsFromFunctionLike(functionLike: ts.ArrowFunction | ts.FunctionExpression) {
  const { body } = functionLike;
  if (ts.isExpression(body)) {
    return [body];
  }

  const expressions: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (node !== functionLike && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))) {
      return;
    }

    if (ts.isReturnStatement(node) && node.expression) {
      expressions.push(node.expression);
      return;
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(body, visit);
  return expressions;
}

function collectAwaitedExpressionsFromFunctionLike(functionLike: ts.ArrowFunction | ts.FunctionExpression) {
  const { body } = functionLike;
  if (ts.isExpression(body)) {
    return [];
  }

  const expressions: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (node !== functionLike && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))) {
      return;
    }

    if (ts.isAwaitExpression(node)) {
      expressions.push(node.expression);
      return;
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(body, visit);
  return expressions;
}

function hasUnsupportedImmediateCallbackControlFlow(node: ts.Node, options: { allowReturn?: boolean } = {}) {
  let hasUnsupportedControlFlow = false;

  function visit(current: ts.Node): void {
    if (hasUnsupportedControlFlow) {
      return;
    }

    if (current !== node && isFunctionLikeNode(current)) {
      return;
    }

    if (
      (!options.allowReturn && ts.isReturnStatement(current))
      || ts.isBreakStatement(current)
      || ts.isContinueStatement(current)
      || ts.isThrowStatement(current)
    ) {
      hasUnsupportedControlFlow = true;
      return;
    }

    ts.forEachChild(current, visit);
  }

  visit(node);
  return hasUnsupportedControlFlow;
}

function collectLocalPromiseAliasResources(
  checker: ts.TypeChecker | undefined,
  sourceFile: ts.SourceFile,
  identifier: ts.Identifier,
  pushResource: (resourceName: string, resourceSubkind: 'promise' | 'promise-collection') => void,
) {
  if (!checker) {
    return false;
  }

  const block = findAncestorNode(identifier, ts.isBlock);
  if (!block) {
    return false;
  }

  let currentStatement: ts.Statement | undefined;
  let current: ts.Node | undefined = identifier;
  while (current && current.parent !== block) {
    current = current.parent;
  }
  if (current && ts.isStatement(current)) {
    currentStatement = current;
  }
  if (!currentStatement) {
    return false;
  }

  const currentStatementIndex = block.statements.findIndex((statement) => statement === currentStatement);
  if (currentStatementIndex < 0) {
    return false;
  }

  const targetSymbol = checker.getSymbolAtLocation(identifier);
  if (!targetSymbol) {
    return false;
  }

  const isInsideCurrentSelfAssignmentRightHandSide = (() => {
    let currentNode: ts.Node | undefined = identifier;
    while (currentNode && currentNode !== currentStatement) {
      if (ts.isBinaryExpression(currentNode)
        && [
          ts.SyntaxKind.EqualsToken,
          ts.SyntaxKind.BarBarEqualsToken,
          ts.SyntaxKind.QuestionQuestionEqualsToken,
        ].includes(currentNode.operatorToken.kind)
        && ts.isIdentifier(currentNode.left)
        && currentNode.right.getStart(sourceFile) <= identifier.getStart(sourceFile)
        && identifier.getEnd() <= currentNode.right.getEnd()) {
        const assignmentSymbol = checker.getSymbolAtLocation(currentNode.left);
        if (assignmentSymbol === targetSymbol) {
          return true;
        }
      }

      currentNode = currentNode.parent;
    }

    return false;
  })();

  let hasCollected = false;
  const pushTrackedResource = (resourceName: string, resourceSubkind: 'promise' | 'promise-collection') => {
    hasCollected = true;
    pushResource(resourceName, resourceSubkind);
  };

  const isAmbiguousBranchAliasExpression = (expression: ts.Expression) => {
    const normalizedExpression = unwrapExpression(expression);
    return ts.isConditionalExpression(normalizedExpression);
  };

  const collectAssignmentValue = (expression: ts.Expression) => {
    const normalizedExpression = unwrapExpression(expression);
    if (!ts.isBinaryExpression(normalizedExpression)
      || ![
        ts.SyntaxKind.EqualsToken,
        ts.SyntaxKind.BarBarEqualsToken,
        ts.SyntaxKind.QuestionQuestionEqualsToken,
      ].includes(normalizedExpression.operatorToken.kind)
      || !ts.isIdentifier(normalizedExpression.left)
      || normalizedExpression.left.text !== identifier.text) {
      return false;
    }

    const assignmentSymbol = checker.getSymbolAtLocation(normalizedExpression.left);
    if (assignmentSymbol !== targetSymbol) {
      return false;
    }

    if (isAmbiguousBranchAliasExpression(normalizedExpression.right)) {
      return false;
    }

    collectPromiseResourcesFromExpression(checker, sourceFile, normalizedExpression.right, pushTrackedResource);
    return true;
  };

  const doesStatementTerminate = (statement: ts.Statement): boolean => {
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
      return true;
    }

    if (ts.isBlock(statement)) {
      const lastStatement = statement.statements.at(-1);
      return lastStatement ? doesStatementTerminate(lastStatement) : false;
    }

    if (ts.isIfStatement(statement) && statement.elseStatement) {
      return doesStatementTerminate(statement.thenStatement) && doesStatementTerminate(statement.elseStatement);
    }

    return false;
  };

  const collectAssignmentValueFromStatement = (statement: ts.Statement) => {
    if (ts.isExpressionStatement(statement)) {
      return collectAssignmentValue(statement.expression);
    }

    if (!ts.isIfStatement(statement)) {
      return false;
    }

    const consequent = ts.isBlock(statement.thenStatement)
      ? statement.thenStatement.statements
      : [statement.thenStatement];

    const alternate = statement.elseStatement
      ? (ts.isBlock(statement.elseStatement)
        ? statement.elseStatement.statements
        : [statement.elseStatement])
      : undefined;

    if (alternate) {
      let hasCollectedConsequent = false;
      let hasCollectedAlternate = false;

      for (const consequentStatement of consequent) {
        if (collectAssignmentValueFromStatement(consequentStatement)) {
          hasCollectedConsequent = true;
        }
      }

      for (const alternateStatement of alternate) {
        if (collectAssignmentValueFromStatement(alternateStatement)) {
          hasCollectedAlternate = true;
        }
      }

      const doesConsequentTerminate = consequent.some((consequentStatement) => doesStatementTerminate(consequentStatement));
      const doesAlternateTerminate = alternate.some((alternateStatement) => doesStatementTerminate(alternateStatement));

      return (hasCollectedConsequent && doesAlternateTerminate)
        || (hasCollectedAlternate && doesConsequentTerminate);
    }

    const condition = unwrapExpression(statement.expression);
    if (!ts.isPrefixUnaryExpression(condition)
      || condition.operator !== ts.SyntaxKind.ExclamationToken
      || !ts.isIdentifier(condition.operand)
      || condition.operand.text !== identifier.text) {
      return false;
    }

    const conditionSymbol = checker.getSymbolAtLocation(condition.operand);
    if (conditionSymbol !== targetSymbol) {
      return false;
    }

    for (const consequentStatement of consequent) {
      if (collectAssignmentValueFromStatement(consequentStatement)) {
        return true;
      }
    }

    return false;
  };

  for (let index = currentStatementIndex; index >= 0; index -= 1) {
    const statement = block.statements[index];
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer || declaration.name.text !== identifier.text) {
          continue;
        }

        const declarationSymbol = checker.getSymbolAtLocation(declaration.name);
        if (declarationSymbol !== targetSymbol) {
          continue;
        }

        if (isAmbiguousBranchAliasExpression(declaration.initializer)) {
          return false;
        }

        collectPromiseResourcesFromExpression(checker, sourceFile, declaration.initializer, pushTrackedResource);
        return hasCollected;
      }
    }

    if (index === currentStatementIndex && isInsideCurrentSelfAssignmentRightHandSide) {
      continue;
    }

    if (collectAssignmentValueFromStatement(statement)) {
      return hasCollected;
    }
  }

  return false;
}

function collectPromiseResourcesFromExpression(
  checker: ts.TypeChecker | undefined,
  sourceFile: ts.SourceFile,
  candidate: ts.Expression,
  pushResource: (resourceName: string, resourceSubkind: 'promise' | 'promise-collection') => void,
) {
  const normalized = unwrapExpression(candidate);

  if (ts.isConditionalExpression(normalized)) {
    collectPromiseResourcesFromExpression(checker, sourceFile, normalized.whenTrue, pushResource);
    collectPromiseResourcesFromExpression(checker, sourceFile, normalized.whenFalse, pushResource);
    return;
  }

  if (ts.isBinaryExpression(normalized)
    && [
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ].includes(normalized.operatorToken.kind)) {
    let hasCollected = false;
    const pushTrackedResource = (resourceName: string, resourceSubkind: 'promise' | 'promise-collection') => {
      hasCollected = true;
      pushResource(resourceName, resourceSubkind);
    };

    collectPromiseResourcesFromExpression(checker, sourceFile, normalized.left, pushTrackedResource);
    collectPromiseResourcesFromExpression(checker, sourceFile, normalized.right, pushTrackedResource);
    if (hasCollected) {
      return;
    }
  }

  if (ts.isIdentifier(normalized)) {
    const hasExpandedLocalAlias = collectLocalPromiseAliasResources(checker, sourceFile, normalized, pushResource);
    if (hasExpandedLocalAlias) {
      return;
    }
  }

  if (ts.isCallExpression(normalized)) {
    const callee = normalized.expression;
    const methodName = ts.isPropertyAccessExpression(callee) ? getPropertyNameText(callee.name) : undefined;
    const receiver = ts.isPropertyAccessExpression(callee) ? unwrapExpression(callee.expression) : undefined;

    if (methodName === 'then' || methodName === 'catch' || methodName === 'finally') {
      let hasCollected = false;
      const pushTrackedResource = (resourceName: string, resourceSubkind: 'promise' | 'promise-collection') => {
        hasCollected = true;
        pushResource(resourceName, resourceSubkind);
      };

      const handlerArguments = methodName === 'then'
        ? normalized.arguments.slice(0, 2)
        : normalized.arguments.slice(0, 1);

      for (const handlerArg of handlerArguments) {
        if (!handlerArg || (!ts.isArrowFunction(handlerArg) && !ts.isFunctionExpression(handlerArg))) {
          continue;
        }

        for (const returnExpression of collectReturnedExpressionsFromFunctionLike(handlerArg)) {
          collectPromiseResourcesFromExpression(checker, sourceFile, returnExpression, pushTrackedResource);
        }

        const isAsyncHandler = Boolean(handlerArg.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword));
        if (isAsyncHandler) {
          for (const awaitedExpression of collectAwaitedExpressionsFromFunctionLike(handlerArg)) {
            collectPromiseResourcesFromExpression(checker, sourceFile, awaitedExpression, pushTrackedResource);
          }
        }
      }

      if (hasCollected) {
        return;
      }

      if (receiver) {
        collectPromiseResourcesFromExpression(checker, sourceFile, receiver, pushTrackedResource);
        if (hasCollected) {
          return;
        }
      }
    }

    const [mapper] = normalized.arguments;
    if ((methodName === 'map' || methodName === 'flatMap') && mapper
      && (ts.isArrowFunction(mapper) || ts.isFunctionExpression(mapper))) {
      const firstParameter = mapper.parameters[0] && ts.isIdentifier(mapper.parameters[0].name)
        ? mapper.parameters[0].name
        : undefined;

      let hasCollected = false;
      const pushTrackedResource = (resourceName: string, resourceSubkind: 'promise' | 'promise-collection') => {
        hasCollected = true;
        pushResource(resourceName, resourceSubkind);
      };

      const collectMapperCandidateResource = (candidate: ts.Expression) => {
        const normalizedCandidate = unwrapExpression(candidate);
        if (firstParameter
          && receiver
          && ts.isIdentifier(normalizedCandidate)
          && normalizedCandidate.text === firstParameter.text) {
          if (ts.isIdentifier(receiver)) {
            const hasExpandedLocalCollection = collectLocalPromiseCollectionResources(
              checker,
              sourceFile,
              normalized,
              receiver,
              pushTrackedResource,
            );
            if (hasExpandedLocalCollection) {
              return;
            }
          }

          collectPromiseResourcesFromExpression(checker, sourceFile, receiver, pushTrackedResource);
          return;
        }

        collectPromiseResourcesFromExpression(checker, sourceFile, normalizedCandidate, pushTrackedResource);
      };

      for (const returnExpression of collectReturnedExpressionsFromFunctionLike(mapper)) {
        collectMapperCandidateResource(returnExpression);
      }

      const isAsyncMapper = Boolean(mapper.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword));
      if (!hasCollected && isAsyncMapper) {
        for (const awaitedExpression of collectAwaitedExpressionsFromFunctionLike(mapper)) {
          collectMapperCandidateResource(awaitedExpression);
        }
      }

      if (hasCollected) {
        return;
      }
    }
  }

  const typeText = getNodeTypeTextForChecker(checker, normalized);
  const resourceName = normalized.getText(sourceFile);
  if (!resourceName) {
    return;
  }

  if (isPromiseTypeText(typeText)) {
    pushResource(resourceName, 'promise');
    return;
  }

  if (isPromiseCollectionTypeText(typeText)) {
    pushResource(resourceName, 'promise-collection');
  }
}

function collectLocalPromiseCollectionResources(
  checker: ts.TypeChecker | undefined,
  sourceFile: ts.SourceFile,
  expression: ts.CallExpression,
  identifier: ts.Identifier,
  pushResource: (resourceName: string, resourceSubkind: 'promise' | 'promise-collection') => void,
) {
  if (!checker) {
    return false;
  }

  const block = findAncestorNode(expression, ts.isBlock);
  if (!block) {
    return false;
  }

  let currentStatement: ts.Statement | undefined;
  let current: ts.Node | undefined = expression;
  while (current && current.parent !== block) {
    current = current.parent;
  }
  if (current && ts.isStatement(current)) {
    currentStatement = current;
  }
  if (!currentStatement) {
    return false;
  }

  const currentStatementIndex = block.statements.findIndex((statement) => statement === currentStatement);
  if (currentStatementIndex < 0) {
    return false;
  }

  const targetSymbol = checker.getSymbolAtLocation(identifier);
  if (!targetSymbol) {
    return false;
  }

  let hasCollected = false;
  const pushTrackedResource = (resourceName: string, resourceSubkind: 'promise' | 'promise-collection') => {
    hasCollected = true;
    pushResource(resourceName, resourceSubkind);
  };

  let declarationIndex = -1;
  for (let index = 0; index <= currentStatementIndex; index++) {
    const statement = block.statements[index];
    if (!ts.isVariableStatement(statement)) {
      continue;
    }

    const declaration = statement.declarationList.declarations.find((item) => ts.isIdentifier(item.name) && item.name.text === identifier.text);
    if (!declaration || !ts.isIdentifier(declaration.name)) {
      continue;
    }

    const declarationSymbol = checker.getSymbolAtLocation(declaration.name);
    if (declarationSymbol !== targetSymbol) {
      continue;
    }

    declarationIndex = index;
    const initializer = declaration.initializer ? unwrapExpression(declaration.initializer) : undefined;
    if (initializer && ts.isArrayLiteralExpression(initializer)) {
      for (const element of initializer.elements) {
        if (ts.isSpreadElement(element)) {
          collectPromiseResourcesFromExpression(checker, sourceFile, element.expression, pushTrackedResource);
          continue;
        }

        collectPromiseResourcesFromExpression(checker, sourceFile, element, pushTrackedResource);
      }
    } else if (initializer) {
      collectPromiseResourcesFromExpression(checker, sourceFile, initializer, pushTrackedResource);
    }
    break;
  }

  if (declarationIndex < 0) {
    return false;
  }

  for (let index = declarationIndex + 1; index < currentStatementIndex; index++) {
    const statement = block.statements[index];
    for (const callExpression of collectCallExpressions(statement)) {
      const callee = callExpression.expression;
      if (!ts.isPropertyAccessExpression(callee) || getPropertyNameText(callee.name) !== 'push') {
        continue;
      }

      const receiver = unwrapExpression(callee.expression);
      if (!ts.isIdentifier(receiver) || receiver.text !== identifier.text) {
        continue;
      }

      const receiverSymbol = checker.getSymbolAtLocation(receiver);
      if (receiverSymbol !== targetSymbol) {
        continue;
      }

      for (const argument of callExpression.arguments) {
        collectPromiseResourcesFromExpression(checker, sourceFile, argument, pushTrackedResource);
      }
    }
  }

  return hasCollected;
}

function collectPromiseCombinatorResourcesFromExpression(
  checker: ts.TypeChecker | undefined,
  sourceFile: ts.SourceFile,
  candidate: ts.Expression,
  pushResource: (resourceName: string, resourceSubkind: 'promise' | 'promise-collection') => void,
) {
  const normalized = unwrapExpression(candidate);

  if (ts.isCallExpression(normalized)) {
    const callee = normalized.expression;
    const methodName = ts.isPropertyAccessExpression(callee) ? getPropertyNameText(callee.name) : undefined;
    const receiver = ts.isPropertyAccessExpression(callee) ? unwrapExpression(callee.expression) : undefined;

    if ((methodName === 'then' || methodName === 'catch' || methodName === 'finally') && receiver) {
      let hasCollected = false;
      const pushTrackedResource = (resourceName: string, resourceSubkind: 'promise' | 'promise-collection') => {
        hasCollected = true;
        pushResource(resourceName, resourceSubkind);
      };

      collectPromiseResourcesFromExpression(checker, sourceFile, receiver, pushTrackedResource);

      const handlerArguments = methodName === 'then'
        ? normalized.arguments.slice(0, 2)
        : normalized.arguments.slice(0, 1);

      for (const handlerArg of handlerArguments) {
        if (!handlerArg || (!ts.isArrowFunction(handlerArg) && !ts.isFunctionExpression(handlerArg))) {
          continue;
        }

        for (const returnExpression of collectReturnedExpressionsFromFunctionLike(handlerArg)) {
          collectPromiseResourcesFromExpression(checker, sourceFile, returnExpression, pushTrackedResource);
        }

        const isAsyncHandler = Boolean(handlerArg.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword));
        if (isAsyncHandler) {
          for (const awaitedExpression of collectAwaitedExpressionsFromFunctionLike(handlerArg)) {
            collectPromiseResourcesFromExpression(checker, sourceFile, awaitedExpression, pushTrackedResource);
          }
        }
      }

      if (hasCollected) {
        return;
      }
    }
  }

  collectPromiseResourcesFromExpression(checker, sourceFile, normalized, pushResource);
}

function unwrapPromiseCombinatorInputCollection(
  checker: ts.TypeChecker | undefined,
  candidate: ts.Expression,
) {
  const normalized = unwrapExpression(candidate);
  if (ts.isArrayLiteralExpression(normalized)) {
    return normalized;
  }

  if (!checker || !ts.isCallExpression(normalized) || normalized.arguments.length !== 1) {
    return undefined;
  }

  const [inputArg] = normalized.arguments;
  const normalizedInputArg = unwrapExpression(inputArg);
  if (!ts.isArrayLiteralExpression(normalizedInputArg)) {
    return undefined;
  }

  const wrapperTypeText = getNodeTypeTextForChecker(checker, normalized);
  if (!isPromiseCollectionTypeText(wrapperTypeText)) {
    return undefined;
  }

  return normalizedInputArg;
}

function collectPromiseCombinatorInputResources(
  checker: ts.TypeChecker | undefined,
  sourceFile: ts.SourceFile,
  expression: ts.CallExpression,
) {
  const [inputArg] = expression.arguments;
  if (!checker || !inputArg) {
    return undefined;
  }

  const resources: Record<string, unknown>[] = [];
  const pushResource = (resourceName: string, resourceSubkind: 'promise' | 'promise-collection') => {
    if (!resourceName || resources.some((item) => item.resourceName === resourceName)) {
      return;
    }

    resources.push(buildPromiseResourceDescriptor(resourceName, resourceSubkind));
  };

  const addExpressionResource = (candidate: ts.Expression) => {
    const normalized = unwrapExpression(candidate);
    if (ts.isIdentifier(normalized)) {
      const hasExpandedLocalCollection = collectLocalPromiseCollectionResources(
        checker,
        sourceFile,
        expression,
        normalized,
        pushResource,
      );
      if (hasExpandedLocalCollection) {
        return;
      }
    }

    collectPromiseCombinatorResourcesFromExpression(checker, sourceFile, normalized, pushResource);
  };

  const inputCollection = unwrapPromiseCombinatorInputCollection(checker, inputArg);
  if (inputCollection) {
    for (const element of inputCollection.elements) {
      if (ts.isSpreadElement(element)) {
        addExpressionResource(element.expression);
        continue;
      }

      addExpressionResource(element);
    }
  } else {
    addExpressionResource(unwrapExpression(inputArg));
  }

  return resources.length ? resources : undefined;
}

function collectPromiseResourceDescriptors(
  checker: ts.TypeChecker | undefined,
  sourceFile: ts.SourceFile,
  candidate: ts.Expression,
) {
  const resources: Record<string, unknown>[] = [];
  const pushResource = (resourceName: string, resourceSubkind: 'promise' | 'promise-collection') => {
    if (!resourceName || resources.some((item) => item.resourceName === resourceName)) {
      return;
    }

    resources.push(buildPromiseResourceDescriptor(resourceName, resourceSubkind));
  };

  collectPromiseResourcesFromExpression(checker, sourceFile, candidate, pushResource);
  return resources.length ? resources : undefined;
}

function getOperandBuildDependencies() {
  return {
    unwrapExpression,
    getPropertyNameText,
    collectCallExpressions,
    shortenLabel,
    buildAsyncCallSemanticPayload: buildAsyncCallSemanticPayload,
  };
}

function buildAsyncCallSemanticPayload(
  checker: ts.TypeChecker | undefined,
  sourceFile: ts.SourceFile,
  expression: ts.CallExpression | ts.NewExpression,
) {
  if (!checker) {
    return undefined;
  }

  return buildAsyncCallSemanticPayloadForBuilder({
    checker,
    sourceFile,
    unwrapExpression,
    getPropertyNameText,
    collectCallExpressions,
    isAbortControllerTypeText,
    isAbortSignalTypeText,
    collectPromiseResourceDescriptors,
    buildPromiseResourceDescriptor,
    deriveTimeoutResourceSemanticId,
    deriveAbortResourceSemanticIdFromText,
    getPromiseCombinatorKind,
  }, expression);
}

function buildOperationOperand(
  node: ts.Node | undefined,
  sourceFile: ts.SourceFile,
  checker?: ts.TypeChecker,
) {
  return buildOperationOperandForExtractor(node, sourceFile, checker, getOperandBuildDependencies());
}

function buildStatementValueOperand(
  node: ts.Node | undefined,
  sourceFile: ts.SourceFile,
  checker?: ts.TypeChecker,
) {
  return buildStatementValueOperandForExtractor(node, sourceFile, checker, getOperandBuildDependencies());
}

function buildOperationDetail(payload: Record<string, unknown>) {
  return buildOperationDetailForExtractor(payload);
}

function buildOperationFields(
  kind: SemanticFlowNodeKind,
  node: ts.Node,
  sourceFile: ts.SourceFile,
  extra: Partial<FlowNodeRow>,
  checker?: ts.TypeChecker,
): Partial<FlowNodeRow> {
  return buildOperationFieldsForExtractor(
    kind,
    node,
    sourceFile,
    extra,
    checker,
    {
      unwrapExpression,
      buildOperationOperand,
      buildStatementValueOperand,
    },
  );
}

class FunctionFlowGraphBuilder {
  private readonly nodes: FlowNodeRow[] = [];

  private readonly edges: FlowEdgeRow[] = [];

  private readonly semanticRelationships: CanonicalRelationship[] = [];

  private readonly seenNodeStableIds = new Set<string>();

  private readonly seenStructuralEdgeKeys = new Set<string>();

  private readonly seenCallExecutionExpansionStableIds = new Set<string>();

  private readonly localAsyncContinuationsByName = new Map<string, {
    declarationId: string;
    name: string;
    declaration: ts.VariableDeclaration;
    initializer: ts.ArrowFunction | ts.FunctionExpression;
  }>();

  private firstNodeStableId?: string;

  private functionStartStableId?: string;

  private mergeOrdinal = 0;

  private operationOrdinal = 0;

  private readonly horizontalFlowContexts: Array<'Arg' | 'Field' | 'Operand'> = [];

  private readonly contextualNodeLabelSets: string[][] = [];

  private nestedFunctionFlowDepth = 0;
  private callbackReturnExitCollectors: PendingExit[][] = [];

  private suppressCallbackArgumentNodeDepth = 0;

  private readonly persistentStoreIdentityByDeclarationStableId = new Map<string, {
    stableId: string;
    diaName: string;
    sourceStableId: string;
    storageName: string;
    storageFormat: string | undefined;
  } | null>();

  private suppressHorizontalJoinDepth = 0;

  private readonly requestResponseTargetContexts: Array<{
    stableId: string;
    callSiteStableId?: string;
    responseCount: number;
  }> = [];

  private readonly flowStepContexts: FlowStepContext[] = [];

  private readonly enclosingLoopStepContexts: FlowStepContext[] = [];

  private readonly syntaxRegionPlanByNode = new Map<ts.Node, SyntaxRegionPlan>();

  private readonly astRepresentationPlanByNode = new Map<ts.Node, AstRepresentationPlan>();

  private aggregateFlowStepDepth = 0;

  private flowStepOrdinal = 0;

  private readonly flowBlockContexts: Array<{
    stableId: string;
    role: 'side' | 'alternative' | 'switch-case';
    outcome: 'TRUE' | 'FALSE' | 'CASE' | 'DEFAULT' | 'NEXT';
    order: number;
  }> = [];

  private flowBlockOrdinal = 0;

  private readonly flowBlockStableIdAliases = new Map<string, string>();

  private resolveFlowBlockStableId(stableId: string | undefined) {
    let current = stableId;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const next = this.flowBlockStableIdAliases.get(current);
      if (!next) break;
      current = next;
    }
    return current;
  }

  private readonly localFunctionContexts: Array<{
    stableId: string;
    name: string;
    depth: number;
  }> = [];

  private readonly submethodSourceRegions: Array<{
    anchor: ts.Node;
    stableId: string;
    nextMemberOrder: number;
  }> = [];

  constructor(
    private readonly sourceFile: ts.SourceFile,
    private readonly fnNode: ts.FunctionLikeDeclaration,
    private readonly fnStableId: string,
    private readonly fnStableIdDescriptor: StableIdDescriptor,
    private readonly fnName: string,
    private readonly checker: ts.TypeChecker,
    private readonly stableIdByDeclaration: Map<ts.Node, string>,
    private readonly uniqueApiMethodTargetsByName: Map<string, ResolvedCallTarget>,
    private readonly uniqueActionTargetsByName: Map<string, ResolvedCallTarget>,
    private readonly uniqueFunctionTargetsByName: Map<string, ResolvedCallTarget>,
    private readonly reactStateProvenance: ReactStateProvenance,
    private readonly accessorIndex: AccessorIndex,
    private readonly valueProxyRegistry: ValueProxyMaterializationRegistry,
  ) {
    this.planSyntaxRegions();
    this.planAstRepresentations();
  }

  private planSyntaxRegions() {
    const functionStartLine = getRange(this.sourceFile, this.fnNode).startLine;
    const visit = (node: ts.Node, depth: number, relativeColumn: number) => {
      const { startLine } = getRange(this.sourceFile, node);
      this.syntaxRegionPlanByNode.set(node, {
        depth,
        relativeColumn,
        relativeRow: Math.max(0, startLine - functionStartLine),
      });
      const opensRegion = ts.isBlock(node)
        || ts.isIfStatement(node)
        || ts.isSwitchStatement(node)
        || isLoopStatement(node)
        || ts.isTryStatement(node)
        || (isFunctionLikeNode(node) && node !== this.fnNode);
      ts.forEachChild(node, (child) => visit(
        child,
        depth + (opensRegion ? 1 : 0),
        relativeColumn + (opensRegion ? 1 : 0),
      ));
    };
    visit(this.fnNode, 0, 0);
  }

  private planAstRepresentations() {
    const plan = (node: ts.Node): AstRepresentationPlan => {
      // forEachChild stops on a truthy callback result, so keep this callback void.
      ts.forEachChild(node, (child) => {
        plan(child);
      });
      const syntaxPlan = this.syntaxRegionPlanByNode.get(node) || {
        depth: 0,
        relativeColumn: 0,
        relativeRow: 0,
      };
      const expressionChildren: AstRepresentationPlan[] = [];
      ts.forEachChild(node, (child) => {
        if (!ts.isExpression(child)) return;
        const childPlan = this.astRepresentationPlanByNode.get(child);
        if (childPlan) expressionChildren.push(childPlan);
      });
      let result: AstRepresentationPlan = {
        ...syntaxPlan,
        mode: 'atomic',
        requiresVerticalExpansion: expressionChildren.some((child) => child.requiresVerticalExpansion),
        estimatedColumns: Math.max(1, ...expressionChildren.map((child) => child.estimatedColumns)),
        estimatedRows: Math.max(1, ...expressionChildren.map((child) => child.estimatedRows)),
      };

      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        result = {
          ...result,
          mode: 'column-subgraph',
          requiresVerticalExpansion: true,
          estimatedColumns: Math.max(2, result.estimatedColumns + 1),
          estimatedRows: Math.max(2, result.estimatedRows + 1),
        };
      } else if (
        ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        result = {
          ...result,
          mode: 'expanded-family',
          requiresVerticalExpansion: true,
          estimatedColumns: Math.max(2, result.estimatedColumns),
          estimatedRows: Math.max(2, result.estimatedRows),
        };
      } else if (ts.isObjectLiteralExpression(node)) {
        const propertyPlans = node.properties
          .map((property) => this.astRepresentationPlanByNode.get(property))
          .filter((value): value is AstRepresentationPlan => Boolean(value));
        const requiresVerticalExpansion = node.properties.length > 1
          || propertyPlans.some((property) => property.requiresVerticalExpansion);
        result = {
          ...result,
          mode: requiresVerticalExpansion ? 'expanded-family' : 'inline-mosaic',
          requiresVerticalExpansion,
          estimatedColumns: requiresVerticalExpansion
            ? 1 + Math.max(1, ...propertyPlans.map((property) => property.estimatedColumns))
            : 1,
          estimatedRows: requiresVerticalExpansion
            ? Math.max(2, node.properties.length, ...propertyPlans.map((property) => property.estimatedRows))
            : 1,
        };
      } else if (ts.isCallExpression(node)) {
        const mosaicArguments = [...node.arguments]
          .map((argument, index) => ({ argument, index }))
          .filter(({ argument, index }) => !this.callArgumentIsExtractedAsSubmethod(node, argument, index));
        const callee = unwrapExpression(node.expression);
        const argumentPlans = mosaicArguments.map(({ argument }) => (
          this.astRepresentationPlanByNode.get(unwrapExpression(argument))
          || this.astRepresentationPlanByNode.get(argument)
        ));
        const zeroArgumentContinuation = mosaicArguments.length === 0
          && isPropertyAccessLikeExpression(callee)
          && !this.isColumnCollectionMethodCall(node)
          && !this.isSyntheticColumnMethodCall(node);
        const receiverPlan = isPropertyAccessLikeExpression(callee)
          ? this.astRepresentationPlanByNode.get(unwrapExpression(callee.expression))
          : undefined;
        const requiresVerticalExpansion = mosaicArguments.length > 1
          || argumentPlans.some((argumentPlan) => argumentPlan?.requiresVerticalExpansion)
          || (!zeroArgumentContinuation && receiverPlan?.requiresVerticalExpansion === true);
        const callBoundaryDesign = zeroArgumentContinuation
          ? 'mosaic'
          : requiresVerticalExpansion
            ? 'split'
            : this.isColumnCollectionMethodCall(node) || this.isSyntheticColumnMethodCall(node)
              ? 'column'
              : 'mosaic';
        const soleArgument = mosaicArguments.length === 1
          ? unwrapExpression(mosaicArguments[0].argument)
          : undefined;
        result = {
          ...result,
          mode: callBoundaryDesign === 'split'
            ? 'expanded-family'
            : callBoundaryDesign === 'column'
              ? 'column-subgraph'
              : 'inline-mosaic',
          requiresVerticalExpansion,
          estimatedColumns: callBoundaryDesign === 'split'
            ? 2 + Math.max(1, ...argumentPlans.map((argumentPlan) => argumentPlan?.estimatedColumns || 1))
            : callBoundaryDesign === 'column'
              ? Math.max(2, result.estimatedColumns)
              : 1,
          estimatedRows: callBoundaryDesign === 'split'
            ? Math.max(2, mosaicArguments.length, ...argumentPlans.map((argumentPlan) => argumentPlan?.estimatedRows || 1))
            : callBoundaryDesign === 'column'
              ? Math.max(2, result.estimatedRows)
              : 1,
          callBoundaryDesign,
          mosaicArgumentIndexes: mosaicArguments.map(({ index }) => index),
          foldSoleObjectBoundary: callBoundaryDesign === 'split'
            && Boolean(soleArgument && ts.isObjectLiteralExpression(soleArgument)),
        };
      }

      this.astRepresentationPlanByNode.set(node, result);
      return result;
    };
    plan(this.fnNode);
  }

  private runInHorizontalFlow<T>(context: 'Arg' | 'Field' | 'Operand', callback: () => T): T {
    this.horizontalFlowContexts.push(context);
    try {
      return callback();
    } finally {
      this.horizontalFlowContexts.pop();
    }
  }

  private runSuppressingHorizontalJoins<T>(callback: () => T): T {
    this.suppressHorizontalJoinDepth += 1;
    try {
      return callback();
    } finally {
      this.suppressHorizontalJoinDepth -= 1;
    }
  }

  private currentHorizontalFlowContext() {
    return this.horizontalFlowContexts.at(-1);
  }

  private registerSubmethodSourceRegion(anchor: ts.Node, stableId: string) {
    const existing = this.submethodSourceRegions.find((region) => (
      region.anchor === anchor && region.stableId === stableId
    ));
    const region = existing || { anchor, stableId, nextMemberOrder: 10 };
    if (!existing) this.submethodSourceRegions.push(region);
    const anchorDescriptor = getStableIdDescriptor(this.sourceFile, anchor);
    const sourceStableIds = new Set<string>();
    const collectSourceStableIds = (node: ts.Node) => {
      sourceStableIds.add(getExtendedStableId(this.sourceFile, node));
      ts.forEachChild(node, collectSourceStableIds);
    };
    collectSourceStableIds(anchor);
    const containsInclusive = (node: FlowNodeRow) => {
      const descriptor = node.stableId;
      const startsInside = descriptor.startLine > anchorDescriptor.startLine
        || (
          descriptor.startLine === anchorDescriptor.startLine
          && descriptor.startColumn >= anchorDescriptor.startColumn
        );
      const endsInside = descriptor.endLine < anchorDescriptor.endLine
        || (
          descriptor.endLine === anchorDescriptor.endLine
          && descriptor.endColumn <= anchorDescriptor.endColumn
        );
      const stableIdKey = getStableIdKey(node.stableId);
      const matchesSourceNode = [...sourceStableIds].some((sourceStableId) => (
        stableIdKey === sourceStableId || stableIdKey.startsWith(`${sourceStableId}:`)
      ));
      return matchesSourceNode || (startsInside && endsInside);
    };
    for (const member of this.nodes.filter(containsInclusive)) {
      if (member.labels.includes('Step') || member.labels.includes('FlowBlock')) continue;
      member.labels = uniqueStrings([...member.labels, 'SubStepAttachment']);
      member.memberOfSubmethodStableId ||= stableId;
      member.submethodPlacement ||= 'right';
      member.submethodAnchorStableId ||= stableId;
      member.submethodMemberOrder ??= region.nextMemberOrder++;
      member.submethodRelativeColumn ??= 1;
      member.submethodRelativeRow ??= 2 + region.nextMemberOrder * 0.35;
    }
  }

  private runWithRequestResponseTarget<T>(
    stableId: string,
    callSiteStableId: string | undefined,
    callback: () => T,
  ) {
    const context = { stableId, callSiteStableId, responseCount: 0 };
    this.requestResponseTargetContexts.push(context);
    try {
      return {
        value: callback(),
        responseCount: context.responseCount,
      };
    } finally {
      this.requestResponseTargetContexts.pop();
    }
  }

  private requestResponseTarget(callSiteStableId: string) {
    const context = this.requestResponseTargetContexts.at(-1);
    if (!context || (context.callSiteStableId && context.callSiteStableId !== callSiteStableId)) {
      return callSiteStableId;
    }
    context.responseCount += 1;
    return context.stableId;
  }

  private callResultTarget(callSiteStableId: string) {
    const context = this.requestResponseTargetContexts.at(-1);
    if (!context || (context.callSiteStableId && context.callSiteStableId !== callSiteStableId)) {
      return undefined;
    }
    context.responseCount += 1;
    return context.stableId;
  }

  private hasContextualCallResultTarget(callSiteStableId: string) {
    const context = this.requestResponseTargetContexts.at(-1);
    return Boolean(
      context
      && (!context.callSiteStableId || context.callSiteStableId === callSiteStableId)
      && this.nodeByStableId(context.stableId)?.labels.includes('Assignment')
    );
  }

  private runWithNodeLabels<T>(labels: string[], callback: () => T): T {
    this.contextualNodeLabelSets.push(labels);
    try {
      return callback();
    } finally {
      this.contextualNodeLabelSets.pop();
    }
  }

  private runInNestedFunctionFlow<T>(callback: () => T): T {
    this.nestedFunctionFlowDepth += 1;
    try {
      return callback();
    } finally {
      this.nestedFunctionFlowDepth -= 1;
    }
  }

  private runInLocalFunctionContext<T>(stableId: string, name: string, callback: () => T): T {
    this.localFunctionContexts.push({
      stableId,
      name,
      depth: this.localFunctionContexts.length + 1,
    });
    const previousFlowStepContexts = this.flowStepContexts.splice(0);
    const previousEnclosingLoopStepContexts = this.enclosingLoopStepContexts.splice(0);
    const previousFlowBlockContexts = this.flowBlockContexts.splice(0);
    const previousFlowStepOrdinal = this.flowStepOrdinal;
    const previousFlowBlockOrdinal = this.flowBlockOrdinal;
    this.flowStepOrdinal = 0;
    this.flowBlockOrdinal = 0;
    try {
      return this.runInNestedFunctionFlow(callback);
    } finally {
      this.flowBlockOrdinal = previousFlowBlockOrdinal;
      this.flowStepOrdinal = previousFlowStepOrdinal;
      this.flowBlockContexts.splice(0, this.flowBlockContexts.length, ...previousFlowBlockContexts);
      this.enclosingLoopStepContexts.splice(0, this.enclosingLoopStepContexts.length, ...previousEnclosingLoopStepContexts);
      this.flowStepContexts.splice(0, this.flowStepContexts.length, ...previousFlowStepContexts);
      this.localFunctionContexts.pop();
    }
  }

  private contextualizeHorizontalStableId(stableId: string, node?: ts.Node) {
    const isHorizontalContext = this.horizontalFlowContexts.length > 0
      || this.nestedFunctionFlowDepth > 0
      || Boolean(node && (this.isNodeInsideHorizontalExpression(node) || this.isNodeInsideNestedFunction(node)));
    if (!isHorizontalContext || stableId.includes(':horizontal-owner-')) {
      return stableId;
    }
    return this.withHorizontalOwnerStableId(stableId);
  }

  private withHorizontalOwnerStableId(stableId: string) {
    if (stableId.includes(':horizontal-owner-')) {
      return stableId;
    }
    return `${stableId}:horizontal-owner-${sanitizeSyntheticExternalPart(this.fnStableId)}`;
  }

  private incomingHasHorizontalOwner(incomingExits: PendingExit[]) {
    return incomingExits.some((exit) => exit.fromId.includes(':horizontal-owner-'));
  }

  private isNodeInsideNestedFunction(node: ts.Node) {
    let current: ts.Node | undefined = node;
    while (current && current !== this.fnNode) {
      if (current !== node && isFunctionLikeNode(current)) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  private isNodeInsideHorizontalExpression(node: ts.Node) {
    let current: ts.Node | undefined = node;
    while (current && current !== this.fnNode) {
      const parent = current.parent;
      if (!parent) break;

      if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.arguments) {
        for (const argument of parent.arguments) {
          if (
            argument === current
            || (node.getStart(this.sourceFile) >= argument.getStart(this.sourceFile) && node.getEnd() <= argument.getEnd())
          ) {
            return true;
          }
        }
      }

      if (
        ts.isPropertyAssignment(parent)
        && (
          parent.initializer === current
          || (node.getStart(this.sourceFile) >= parent.initializer.getStart(this.sourceFile) && node.getEnd() <= parent.initializer.getEnd())
        )
      ) {
        return true;
      }

      if (ts.isSpreadAssignment(parent) && parent.expression === current) {
        return true;
      }

      current = parent;
    }
    return false;
  }

  private expressionBranchKind(node: ts.Node): Extract<FlowNodeKind, 'Branch' | 'ArgBranch' | 'FieldBranch' | 'OperandBranch'> {
    const context = this.currentHorizontalFlowContext();
    if (context === 'Arg') return 'ArgBranch';
    if (context === 'Field') return 'FieldBranch';
    if (context === 'Operand' || this.isNodeInsideHorizontalExpression(node)) return 'OperandBranch';
    return 'Branch';
  }

  private isHorizontalOperandExpression(node: ts.Node) {
    return this.horizontalFlowContexts.length > 0 || this.isNodeInsideHorizontalExpression(node);
  }

  private isNodeInsideConditionExpression(node: ts.Node) {
    let current: ts.Node | undefined = node;
    while (current && current !== this.fnNode) {
      const parent = current.parent;
      if (!parent) break;

      if (ts.isIfStatement(parent) && parent.expression
        && node.getStart(this.sourceFile) >= parent.expression.getStart(this.sourceFile)
        && node.getEnd() <= parent.expression.getEnd()) {
        return true;
      }
      if ((ts.isWhileStatement(parent) || ts.isDoStatement(parent)) && parent.expression
        && node.getStart(this.sourceFile) >= parent.expression.getStart(this.sourceFile)
        && node.getEnd() <= parent.expression.getEnd()) {
        return true;
      }
      if (ts.isForStatement(parent) && parent.condition
        && node.getStart(this.sourceFile) >= parent.condition.getStart(this.sourceFile)
        && node.getEnd() <= parent.condition.getEnd()) {
        return true;
      }
      if (ts.isConditionalExpression(parent)
        && node.getStart(this.sourceFile) >= parent.condition.getStart(this.sourceFile)
        && node.getEnd() <= parent.condition.getEnd()) {
        return true;
      }

      current = parent;
    }
    return false;
  }

  private isOperandExpressionContext(node: ts.Node) {
    return this.isHorizontalOperandExpression(node) || this.isNodeInsideConditionExpression(node);
  }

  private normalizeFlowBlockReferences() {
    for (const node of this.nodes) {
      node.parentFlowBlockStableId = this.resolveFlowBlockStableId(node.parentFlowBlockStableId);
    }
    for (const edge of this.edges) {
      if (edge.fromKind === undefined) {
        edge.fromId = this.resolveFlowBlockStableId(edge.fromId) || edge.fromId;
      }
      if (edge.toKind === undefined) {
        edge.toId = this.resolveFlowBlockStableId(edge.toId) || edge.toId;
      }
    }
  }

  build(): GraphExtractedPayload {
    const bodyStatements = this.getFunctionBodyStatements();
    this.materializeFunctionStart();
    const parameterExits = this.materializeFunctionParameters();
    const result = this.buildBlock(bodyStatements, parameterExits, { hasLocalCatch: false });
    if (!this.firstNodeStableId && result.firstNodeId) {
      this.firstNodeStableId = result.firstNodeId;
    }

    if (result.openExits.length) {
      const functionEndId = this.createSharedTerminalNode('FunctionEnd', this.fnNode);
      this.connectPendingToNode(result.openExits, functionEndId);
      if (!this.firstNodeStableId) {
        this.firstNodeStableId = functionEndId;
      }
    }

    if (result.pendingThrows.length) {
      this.materializePendingThrows(result.pendingThrows);
    }

    this.materializeExecutionProtocolFacts();

    extractValueAccessFacts({
      nodes: this.nodes,
      edges: this.edges,
      semanticRelationships: this.semanticRelationships,
    }, [{
      sourceFile: this.sourceFile,
      fnNode: this.fnNode,
      fnStableId: this.fnStableId,
      fnStableIdDescriptor: this.fnStableIdDescriptor,
    }], this.checker, this.valueProxyRegistry);
    this.propagateBindingSemanticsToRenderParts();
    this.finalizeExtractedFlowSteps();
    this.normalizeFlowBlockReferences();
    this.assertSubmethodStepOwnership();
    this.materializeSignatureContract();

    return {
      nodes: this.nodes,
      edges: this.edges,
      semanticRelationships: this.semanticRelationships,
    };
  }

  private materializeSignatureContract() {
    const parameterIds=this.fnNode.parameters.map(p=>getExtendedStableId(this.sourceFile,p));
    const parameters=new Set(parameterIds);
    for(const edge of this.edges) {
      if(edge.type==='NEXT' && parameters.has(edge.toId) && (parameters.has(edge.fromId)||edge.fromId===this.functionStartStableId)) {
        edge.type='SIGNATURE_PARAMETER';edge.flowLayer='data';edge.semanticExpansion='function-signature';
      }
    }
    const previous=parameterIds.at(-1)||this.functionStartStableId;
    if(!previous)return;
    const bodyEdges=this.edges.filter(e=>e.fromId===previous && e.type==='NEXT');
    if(!this.fnNode.type){for(const edge of bodyEdges)edge.type='BODY_ENTRY';return;}
    const type=this.fnNode.type;
    const name=ts.isTypeReferenceNode(type)?type.typeName.getText(this.sourceFile):type.getText(this.sourceFile);
    const symbol=ts.isTypeReferenceNode(type)?this.checker.getSymbolAtLocation(type.typeName):undefined;
    const system=!!symbol?.declarations?.length && symbol.declarations.every(d=>/[/\\]typescript[/\\]lib[/\\]lib\..*\.d\.ts$/.test(d.getSourceFile().fileName));
    const returnId=this.createNode('Op',name,type,{
      labels:['ReturnType','Signature',system?'System':'DeveloperDefined'],diaName:name,
      actionTextRaw:type.getText(this.sourceFile),synthetic:false,
    },getExtendedStableId(this.sourceFile,type),false);
    this.addEdge(undefined,previous,undefined,returnId,'SIGNATURE_RETURN',{flowLayer:'data',semanticExpansion:'function-signature'});
    for(const edge of bodyEdges){edge.fromId=returnId;edge.type='BODY_ENTRY';edge.semanticExpansion='function-signature';}
    if(ts.isTypeReferenceNode(type))type.typeArguments?.forEach((argument,index)=>{
      const argumentId=this.createNode('Value',argument.getText(this.sourceFile),argument,{
        labels:['ReturnTypeArgument','Signature','Type'],diaName:argument.getText(this.sourceFile),synthetic:false,
      },getExtendedStableId(this.sourceFile,argument),false);
      this.addEdge(undefined,returnId,undefined,argumentId,'RETURN_TYPE_ARGUMENT',{flowLayer:'data',argumentIndex:index,semanticExpansion:'function-signature'});
    });
  }

  private propagateBindingSemanticsToRenderParts() {
    const bindingLabels = new Map<string, string[]>();
    const failureBindingStableIds = new Set<string>();
    for (const node of this.nodes) {
      if (!node.bindingStableId) continue;
      bindingLabels.set(node.bindingStableId, uniqueStrings([
        ...(bindingLabels.get(node.bindingStableId) || []),
        ...node.labels,
      ]));
      if (node.labels.includes('FailureBinding')) failureBindingStableIds.add(node.bindingStableId);
    }
    const visitFailureCallbacks = (candidate: ts.Node) => {
      if (ts.isCallExpression(candidate)) {
        const callee = unwrapExpression(candidate.expression);
        if (isPropertyAccessLikeExpression(callee) && callee.name.text === 'catch') {
          for (const argument of candidate.arguments.map(unwrapExpression)) {
            if (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument)) continue;
            for (const parameter of argument.parameters) {
              if (ts.isIdentifier(parameter.name)) {
                failureBindingStableIds.add(getExtendedStableId(this.sourceFile, parameter));
              }
            }
          }
        }
      }
      ts.forEachChild(candidate, visitFailureCallbacks);
    };
    visitFailureCallbacks(this.sourceFile);
    for (const node of this.nodes) {
      if (!node.renderPartsJson) continue;
      let parts: RenderPartDescriptor[];
      try {
        parts = JSON.parse(node.renderPartsJson) as RenderPartDescriptor[];
      } catch {
        continue;
      }
      let changed = false;
      const nextParts = parts.map((part) => {
        const labels = part.bindingStableId ? bindingLabels.get(part.bindingStableId) : undefined;
        const failureBinding = Boolean(
          part.bindingStableId
          && (failureBindingStableIds.has(part.bindingStableId) || labels?.includes('FailureBinding'))
        );
        if (!failureBinding) return part;
        changed = true;
        return {
          ...part,
          labels: uniqueStrings([...(part.labels || []), 'Failure', 'FailureBinding']),
        };
      });
      if (changed) node.renderPartsJson = JSON.stringify(nextParts);
    }
  }

  private assertSubmethodStepOwnership() {
    const nodeByStableId = new Map(this.nodes.map((node) => [getStableIdKey(node.stableId), node]));
    for (const owner of this.nodes) {
      if (!owner.submethodsJson) continue;
      const ownerStableId = getStableIdKey(owner.stableId);
      const records = JSON.parse(owner.submethodsJson) as Array<{
        stableId?: string;
        headerStableId?: string;
        memberStableIds?: string[];
        attachments?: Array<{ stableId?: string }>;
      }>;
      for (const record of records) {
        const recordStableId = record.stableId || record.headerStableId;
        const recordHeader = record.headerStableId ? nodeByStableId.get(record.headerStableId) : undefined;
        if (
          recordStableId
          && recordHeader?.submethodStableId
          && recordHeader.submethodStableId !== recordStableId
        ) {
          throw new Error([
            `Submethod ${recordStableId} has a foreign header`,
            `owner=${ownerStableId}`,
            `header=${record.headerStableId}`,
            `headerSubmethod=${recordHeader.submethodStableId}`,
          ].join('; '));
        }
        const referencedStableIds = uniqueStrings([
          ...(record.memberStableIds || []),
          ...(record.attachments || []).map((attachment) => attachment.stableId || ''),
        ].filter(Boolean));
        for (const referencedStableId of referencedStableIds) {
          const referenced = nodeByStableId.get(referencedStableId);
          if (!referenced) continue;
          if (referenced.parentStepStableId) continue;
          throw new Error([
            `Submethod ${recordStableId || ownerStableId} member has no Step ownership`,
            `owner=${ownerStableId}`,
            `member=${referencedStableId}`,
          ].join('; '));
        }
      }
    }
  }

  private getFunctionBodyStatements() {
    if (this.fnNode.body && ts.isBlock(this.fnNode.body)) {
      return [...this.fnNode.body.statements];
    }

    if (this.fnNode.body && ts.isExpression(this.fnNode.body)) {
      const returnStatement = ts.factory.createReturnStatement(this.fnNode.body);
      ts.setTextRange(returnStatement, this.fnNode.body);
      return [returnStatement];
    }

    return [] as ts.Statement[];
  }

  private registerFirstNode(nodeStableId: string, incomingExits: PendingExit[]) {
    const hasOnlyFunctionEntry = incomingExits.every((exit) => exit.fromKind === 'Fn' && exit.fromId === this.fnStableId);
    if (!this.firstNodeStableId && (incomingExits.length === 0 || hasOnlyFunctionEntry)) {
      this.firstNodeStableId = nodeStableId;
    }
  }

  private buildInitialPendingExits(): PendingExit[] {
    return [this.createPendingExit(
      this.functionStartStableId ? undefined : 'Fn',
      this.functionStartStableId || this.fnStableId,
      'NEXT',
    )];
  }

  private materializeFunctionStart() {
    const stableId = `${this.fnStableId}:flow-start`;
    this.functionStartStableId = this.createNode('FunctionStart', 'function start', this.fnNode, {
      labels: ['FunctionStart', 'ExecutionBoundary', 'Start'],
      diaName: 'Start',
      declaredReturnType: this.fnNode.type?.getText(this.sourceFile).replace(/\s+/gu, ' ').trim(),
      actionTextRaw: '',
      synthetic: true,
    }, stableId, false);
    this.firstNodeStableId = this.functionStartStableId;
    this.addEdge('Fn', this.fnStableId, undefined, this.functionStartStableId, 'NEXT', {
      semanticExpansion: 'function-entry',
      contextOnly: true,
    });
  }

  private parameterTypeText(parameter: ts.ParameterDeclaration) {
    return parameter.type?.getText(this.sourceFile)
      || this.checker.typeToString(this.checker.getTypeAtLocation(parameter), parameter, ts.TypeFormatFlags.NoTruncation);
  }

  private parameterTypeDiaText(parameter: ts.ParameterDeclaration, typeText: string) {
    if (parameter.type && ts.isTypeLiteralNode(parameter.type)) return '';
    return typeText.replace(/\s+/gu, ' ').trim();
  }

  private propertyTypeText(declaration: ts.Declaration, resolvedTypeText: string) {
    if (
      (ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration) || ts.isParameter(declaration))
      && declaration.type
    ) {
      return declaration.type.getText(declaration.getSourceFile()).replace(/\s+/gu, ' ').trim();
    }
    return resolvedTypeText.replace(/\s+/gu, ' ').trim();
  }

  private parameterDisplayName(parameter: ts.ParameterDeclaration) {
    const rest = parameter.dotDotDotToken ? '...' : '';
    return `${rest}${parameter.name.getText(this.sourceFile)}`;
  }

  private objectParameterType(parameter: ts.ParameterDeclaration) {
    const declaredType = this.checker.getTypeAtLocation(parameter);
    const type = this.checker.getNonNullableType(declaredType);
    if (!(type.flags & ts.TypeFlags.Object)) return undefined;
    if (type.getCallSignatures().length || type.getConstructSignatures().length) return undefined;
    if (this.checker.isArrayType(type) || this.checker.isTupleType(type)) return undefined;
    return type;
  }

  private materializeExplicitObjectParameterType(
    parameter: ts.ParameterDeclaration,
    parameterStableId: string,
    baseStableId: string,
    objectType: ts.Type,
    typeText: string,
  ) {
    const properties = this.objectParameterProperties(parameter, objectType);
    if (!properties.length) return undefined;

    const familyStableId = `${baseStableId}:type:object-family`;
    const pairCount = Math.max(1, Math.floor(properties.length / 2));
    const leftBraceStableIds: string[] = [];
    const rightBraceStableIds: string[] = [];
    const indicesForPair = (pairIndex: number) => {
      if (properties.length === 1) return [0];
      const indices = [pairIndex, properties.length - 1 - pairIndex];
      if (properties.length % 2 === 1 && pairIndex === pairCount - 1) {
        indices.splice(1, 0, Math.floor(properties.length / 2));
      }
      return [...new Set(indices)];
    };

    for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
      const fieldIndices = indicesForPair(pairIndex);
      const common = {
        labels: ['ObjectBrace', 'Object', 'ParameterType', 'Type'],
        diaName: '',
        actionTextRaw: parameter.type?.getText(this.sourceFile) || typeText,
        parameterName: parameter.name.getText(this.sourceFile),
        parameterTypeText: typeText,
        objectFamilyStableId: familyStableId,
        objectBracePairIndex: pairIndex,
        objectBracePairCount: pairCount,
        objectBraceFieldIndicesJson: JSON.stringify(fieldIndices),
        synthetic: true,
      };
      leftBraceStableIds.push(this.createNode('ObjectBrace', 'parameter object type brace', parameter, {
        ...common,
        labels: [...common.labels, 'Open'],
        objectBraceSide: 'left',
        objectBraceMosaicNeighborStableId: pairIndex === 0 ? parameterStableId : undefined,
      }, `${familyStableId}:left:${pairIndex}`));
      rightBraceStableIds.push(this.createNode('ObjectBrace', 'parameter object type brace', parameter, {
        ...common,
        labels: [...common.labels, 'Close'],
        objectBraceSide: 'right',
      }, `${familyStableId}:right:${pairIndex}`));
    }

    const pairIndexForField = (fieldIndex: number) => Math.min(
      fieldIndex,
      properties.length - 1 - fieldIndex,
      pairCount - 1,
    );
    properties.forEach((property, fieldIndex) => {
      const fieldName = property.getName();
      const declaration = property.valueDeclaration || property.declarations?.[0] || parameter;
      const fieldType = this.checker.getTypeOfSymbolAtLocation(property, declaration);
      const resolvedFieldTypeText = this.checker.typeToString(fieldType, declaration, ts.TypeFormatFlags.NoTruncation);
      const fieldTypeText = this.propertyTypeText(declaration, resolvedFieldTypeText);
      const optional = (property.flags & ts.SymbolFlags.Optional) !== 0 ? '?' : '';
      const pairIndex = pairIndexForField(fieldIndex);
      const renderParts = ts.isTypeElement(declaration)
        ? this.typeMemberRenderParts(declaration, `${familyStableId}:field:${fieldIndex}`)
          .filter((part) => !part.labels.includes('FieldName'))
          .map((part, order) => ({ ...part, order }))
        : undefined;
      const fieldStableId = this.createNode('Field', fieldName, parameter, {
        labels: ['ParameterType', 'Field', 'TypeMember'],
        diaName: `: ${fieldTypeText}`,
        actionTextRaw: `${fieldName}${optional}: ${fieldTypeText}`,
        fieldName,
        fieldIndex,
        parameterName: fieldName,
        parameterTypeText: fieldTypeText,
        objectFamilyStableId: familyStableId,
        renderPartsLayout: renderParts ? 'horizontal' : undefined,
        renderPrimaryPartIndex: renderParts ? 0 : undefined,
        renderPartsJson: renderParts ? JSON.stringify(renderParts) : undefined,
        synthetic: true,
      }, `${familyStableId}:field:${fieldIndex}:${sanitizeSyntheticExternalPart(fieldName)}`);
      this.addEdge(undefined, leftBraceStableIds[pairIndex], undefined, fieldStableId, 'FIELD', {
        label: fieldName,
        displayLabel: fieldName,
        fieldName,
        fieldIndex,
        layoutFrame: 'horizontal',
      });
      this.addEdge(undefined, fieldStableId, undefined, rightBraceStableIds[pairIndex], 'FieldJoin', {
        label: fieldName,
        displayLabel: '',
        fieldName,
        fieldIndex,
        layoutFrame: 'horizontal',
      });
    });

    const typedAsCloseStableId = this.createNode('FieldJoin', 'typed-as close', parameter, {
      labels: ['Finish', 'Method', 'ContainerMethod', 'Virtual', 'TypeAnnotation', 'Close'],
      diaName: ')',
      actionTextRaw: ')',
      containerMethodKind: 'typed-as',
      callBoundaryDesign: 'split',
      callBoundaryRole: 'close',
      callHasArguments: true,
      renderPartsLayout: 'single',
      renderPrimaryPartIndex: 0,
      renderPartsJson: JSON.stringify([{
        stableId: `${baseStableId}:typed-as-close`,
        text: ')',
        kind: 'method',
        labels: ['Finish', 'Method', 'ContainerMethod', 'Virtual', 'TypeAnnotation', 'Close'],
        order: 0,
        sourceStableId: getExtendedStableId(this.sourceFile, parameter),
      }] satisfies RenderPartDescriptor[]),
      synthetic: true,
    }, `${baseStableId}:typed-as-close`);
    const outerRightBrace = this.nodeByStableId(rightBraceStableIds[0]);
    if (outerRightBrace) {
      outerRightBrace.objectBraceMosaicNeighborStableId = typedAsCloseStableId;
    }
    this.addEdge(
      undefined,
      rightBraceStableIds[0],
      undefined,
      typedAsCloseStableId,
      'AST_CHILD',
      {
        semanticExpansion: 'expanded-parameter-type-close',
        contextOnly: true,
      },
    );
    return leftBraceStableIds[0];
  }

  private objectParameterProperties(parameter: ts.ParameterDeclaration, objectType: ts.Type) {
    const boundFieldNames = ts.isObjectBindingPattern(parameter.name)
      ? new Set(parameter.name.elements.map((element) => (
          (element.propertyName || element.name).getText(this.sourceFile)
        )))
      : undefined;
    return objectType.getProperties().filter((property) => (
      !boundFieldNames || boundFieldNames.has(property.getName())
    ));
  }

  private materializeFunctionParameters() {
    let pending = this.buildInitialPendingExits();

    this.fnNode.parameters.forEach((parameter) => {
      const step = this.createFlowStepContext(parameter, 'statement');
      pending = this.runInFlowStepContext(step, () => {
        const name = this.parameterDisplayName(parameter);
        const typeText = this.parameterTypeText(parameter);
        const typeDiaText = this.parameterTypeDiaText(parameter, typeText);
        const baseStableId = getExtendedStableId(this.sourceFile, parameter);
        const objectType = this.objectParameterType(parameter);
        const explicitObject = Boolean(objectType && (
          (parameter.type && ts.isTypeLiteralNode(parameter.type))
          || ts.isObjectBindingPattern(parameter.name)
        ));
        const explicitObjectProperties = explicitObject && objectType
          ? this.objectParameterProperties(parameter, objectType)
          : [];
        const compactExplicitObjectDeclaration = explicitObjectProperties.length === 1
          ? explicitObjectProperties[0].valueDeclaration || explicitObjectProperties[0].declarations?.[0]
          : undefined;
        const compactExplicitObjectMember = compactExplicitObjectDeclaration
          && ts.isTypeElement(compactExplicitObjectDeclaration)
          ? compactExplicitObjectDeclaration
          : undefined;
        const expandedExplicitObject = explicitObject && !compactExplicitObjectMember;
        const simpleParameterBinding = ts.isIdentifier(parameter.name);
        const parameterType = this.checker.getTypeAtLocation(parameter);
        const collectionParameter = this.checker.isArrayType(parameterType) || this.checker.isTupleType(parameterType);
        const operationProviderParameter = Boolean(
          simpleParameterBinding
          && parameter.type
          && this.isOperationProviderTypeAtLocation(parameter.type),
        );
        const containerKind: RenderPartDescriptor['kind'] = operationProviderParameter
          ? 'operation-provider-container'
          : collectionParameter ? 'collection-container' : 'value-container';
        const containerLabels = uniqueStrings([
          'Value',
          'Parameter',
          simpleParameterBinding ? 'ValueSlot' : 'BindingPattern',
          ...(operationProviderParameter ? ['OperationProvider', 'CapabilityBundle'] : []),
          ...(collectionParameter ? ['Collection'] : []),
        ]);
        const typeLabels = parameter.type
          ? this.declaredTypeRenderLabels(parameter.type)
          : ['Type', 'System'];
        const compactObjectParts: RenderPartDescriptor[] = compactExplicitObjectMember ? [
          {
            stableId: `${baseStableId}:object-open`,
            text: '{',
            kind: 'punctuation',
            labels: ['Object', 'Open', 'Punctuation'],
            order: 2,
            sourceStableId: getExtendedStableId(this.sourceFile, compactExplicitObjectMember),
          },
          ...this.typeMemberRenderParts(compactExplicitObjectMember, `${baseStableId}:object-field`)
            .map((part, index) => ({ ...part, order: index + 3 })),
          {
            stableId: `${baseStableId}:object-close`,
            text: '}',
            kind: 'punctuation',
            labels: ['Object', 'Close', 'Punctuation'],
            order: 6,
            sourceStableId: getExtendedStableId(this.sourceFile, compactExplicitObjectMember),
          },
          {
            stableId: `${baseStableId}:typed-as-close`,
            text: ')',
            kind: 'method',
            labels: ['Method', 'ContainerMethod', 'Virtual', 'TypeAnnotation', 'Close'],
            order: 7,
            sourceStableId: getExtendedStableId(this.sourceFile, parameter),
          },
        ] : [];
        const simpleTypeParts: RenderPartDescriptor[] = expandedExplicitObject ? [] : compactExplicitObjectMember
          ? compactObjectParts
          : [
          {
            stableId: `${baseStableId}:type`,
            text: typeDiaText || typeText,
            kind: 'value',
            labels: typeLabels,
            order: 2,
            sourceStableId: parameter.type
              ? getExtendedStableId(this.sourceFile, parameter.type)
              : getExtendedStableId(this.sourceFile, parameter),
            canonicalStableId: parameter.type
              ? this.canonicalTypeDeclarationStableId(parameter.type)
              : undefined,
          },
          {
            stableId: `${baseStableId}:typed-as-close`,
            text: ')',
            kind: 'method',
            labels: ['Method', 'ContainerMethod', 'Virtual', 'TypeAnnotation', 'Close'],
            order: 3,
            sourceStableId: getExtendedStableId(this.sourceFile, parameter),
          },
        ];
        const parameterStableId = this.createNode('Parameter', name, parameter, {
          labels: uniqueStrings([
            'Parameter',
            simpleParameterBinding ? 'ValueSlot' : 'BindingPattern',
            ...(collectionParameter ? ['Collection'] : []),
            ...(explicitObject ? ['Object', 'ObjectConstruction'] : []),
          ]),
          diaName: name,
          actionTextRaw: parameter.getText(this.sourceFile),
          parameterName: name,
          parameterTypeText: typeText,
          parameterOptional: Boolean(parameter.questionToken || parameter.initializer),
          containerMethodKind: 'typed-as',
          containerState: 'awaiting-assignment',
          renderPartsLayout: 'container-overlay-side',
          renderPrimaryPartIndex: 0,
          renderPartsJson: JSON.stringify([
            {
              stableId: `${baseStableId}:container`,
              text: name,
              kind: containerKind,
              labels: containerLabels,
              order: 0,
              fillState: 'empty',
              sourceStableId: getExtendedStableId(this.sourceFile, parameter.name),
            },
            {
              stableId: baseStableId,
              text: 'TYPED_AS(',
              kind: 'method',
              labels: ['Method', 'ContainerMethod', 'Virtual', 'TypeAnnotation', 'Open'],
              order: 1,
              sourceStableId: getExtendedStableId(this.sourceFile, parameter),
            },
            ...simpleTypeParts,
          ] satisfies RenderPartDescriptor[]),
          ...(expandedExplicitObject ? {
            opensObjectFieldFamily: true,
            callBoundaryDesign: 'split' as const,
            callBoundaryRole: 'open' as const,
            callHasArguments: true,
          } : {}),
        }, baseStableId);
        this.connectPendingToNode(pending, parameterStableId);
        if (!this.firstNodeStableId) this.firstNodeStableId = parameterStableId;

        if (objectType && expandedExplicitObject) {
          const objectTypeOpeningStableId = this.materializeExplicitObjectParameterType(
            parameter,
            parameterStableId,
            baseStableId,
            objectType,
            typeText,
          );
          if (objectTypeOpeningStableId) {
            this.addEdge(
              undefined,
              parameterStableId,
              undefined,
              objectTypeOpeningStableId,
              'AST_CHILD',
              {
                semanticExpansion: 'expanded-parameter-type',
                contextOnly: true,
              },
            );
          }
        }

        return [this.createPendingExit(undefined, parameterStableId, 'NEXT')];
      });
    });

    return pending;
  }

  private createPendingExit(
    fromKind: 'Fn' | undefined,
    fromId: string,
    edgeType: FlowEdgeKind,
    label?: string,
    mainFlow = false,
  ): PendingExit {
    return {
      fromKind,
      fromId,
      edgeType,
      label,
      mainFlow,
    };
  }

  private buildAsyncDeclarationSemantic(statement: ts.VariableStatement) {
    return buildAsyncDeclarationSemanticForBuilder(this.getAsyncSemanticDependencies(), statement);
  }

  private getAsyncSemanticDependencies(): AsyncSemanticDependencies {
    return {
      checker: this.checker,
      sourceFile: this.sourceFile,
      unwrapExpression,
      getPropertyNameText,
      collectCallExpressions,
      isAbortControllerTypeText,
      isAbortSignalTypeText,
      collectPromiseResourceDescriptors,
      buildPromiseResourceDescriptor,
      deriveTimeoutResourceSemanticId,
      deriveAbortResourceSemanticIdFromText,
      getPromiseCombinatorKind,
    };
  }

  private buildAsyncAssignmentSemantic(expression: ts.BinaryExpression) {
    return buildAsyncAssignmentSemanticForBuilder(this.getAsyncSemanticDependencies(), expression);
  }

  private buildAsyncCallSemantic(expression: ts.CallExpression | ts.NewExpression) {
    return buildAsyncCallSemanticForBuilder(this.getAsyncSemanticDependencies(), expression);
  }

  private buildAsyncExpressionSemantic(expression: ts.Expression) {
    return buildAsyncExpressionSemanticForBuilder(this.getAsyncSemanticDependencies(), expression);
  }

  private buildSemanticOperationDetail(kind: SemanticFlowNodeKind, node: ts.Node) {
    return buildSemanticOperationDetailForBuilder({
      checker: this.checker,
      sourceFile: this.sourceFile,
      unwrapExpression,
      getPropertyNameText,
      isSimpleAssignmentExpression,
      buildAsyncDeclarationSemantic: this.buildAsyncDeclarationSemantic.bind(this),
      buildAsyncAssignmentSemantic: this.buildAsyncAssignmentSemantic.bind(this),
      buildAsyncCallSemantic: this.buildAsyncCallSemantic.bind(this),
      buildAsyncExpressionSemantic: this.buildAsyncExpressionSemantic.bind(this),
    }, kind, node);
  }

  private mergeSemanticOperationDetail(operationFields: Partial<FlowNodeRow>, kind: SemanticFlowNodeKind, node: ts.Node) {
    return mergeSemanticOperationDetailForBuilder(operationFields, {
      checker: this.checker,
      sourceFile: this.sourceFile,
      unwrapExpression,
      getPropertyNameText,
      isSimpleAssignmentExpression,
      buildAsyncDeclarationSemantic: this.buildAsyncDeclarationSemantic.bind(this),
      buildAsyncAssignmentSemantic: this.buildAsyncAssignmentSemantic.bind(this),
      buildAsyncCallSemantic: this.buildAsyncCallSemantic.bind(this),
      buildAsyncExpressionSemantic: this.buildAsyncExpressionSemantic.bind(this),
    }, kind, node);
  }

  private buildRenderParts(node: ts.Node, ownerStableId: string, completeCalls = false): {
    json: string;
    layout: FlowNodeRow['renderPartsLayout'];
    primaryIndex: number;
  } | undefined {
    const expression = ts.isExpression(node)
      ? node
      : ts.isExpressionStatement(node)
        ? node.expression
        : ts.isReturnStatement(node)
          ? node.expression
          : undefined;
    if (!expression) return undefined;

    const crossesBooleanControlBoundary = (candidate: ts.Expression): boolean => {
      const current = unwrapExpression(candidate);
      if (isBooleanShortCircuitBinaryExpression(current)) return true;
      if (ts.isBinaryExpression(current)) {
        return crossesBooleanControlBoundary(current.left)
          || crossesBooleanControlBoundary(current.right);
      }
      if (ts.isPrefixUnaryExpression(current)) {
        return crossesBooleanControlBoundary(current.operand);
      }
      if (ts.isConditionalExpression(current)) {
        return crossesBooleanControlBoundary(current.condition)
          || crossesBooleanControlBoundary(current.whenTrue)
          || crossesBooleanControlBoundary(current.whenFalse);
      }
      if (isPropertyAccessLikeExpression(current) || ts.isElementAccessExpression(current)) {
        return crossesBooleanControlBoundary(current.expression);
      }
      return false;
    };
    if (crossesBooleanControlBoundary(expression)) return undefined;

    type SourcePart = Omit<RenderPartDescriptor, 'stableId' | 'order'> & { primary?: boolean };
    const typeParts = (type: ts.TypeNode): SourcePart[] => {
      const part=(anchor:ts.Node,text:string,kind:SourcePart['kind'],labels:string[]):SourcePart=>({
        text,kind,labels:['TypeArgument',...labels],sourceStableId:getExtendedStableId(this.sourceFile,anchor),
      });
      if(ts.isTypeLiteralNode(type)) return [
        part(type,'{','punctuation',['TypeObjectBoundary']),
        ...type.members.flatMap((member,index)=>[
          ...(index?[part(member,';','punctuation',['TypeObjectBoundary'])]:[]),
          ...(ts.isPropertySignature(member) && member.type
            ? [part(member.name,`${member.name.getText(this.sourceFile)}${member.questionToken?'?':''}:`,'value',['FieldName','TypeMember']),...typeParts(member.type)]
            : [part(member,member.getText(this.sourceFile),'value',['TypeMember'])]),
        ]),
        part(type,'}','punctuation',['TypeObjectBoundary']),
      ];
      const primitive=[ts.SyntaxKind.BooleanKeyword,ts.SyntaxKind.StringKeyword,ts.SyntaxKind.NumberKeyword,ts.SyntaxKind.BigIntKeyword,ts.SyntaxKind.SymbolKeyword,ts.SyntaxKind.VoidKeyword,ts.SyntaxKind.UnknownKeyword,ts.SyntaxKind.AnyKeyword,ts.SyntaxKind.NeverKeyword,ts.SyntaxKind.UndefinedKeyword].includes(type.kind);
      return [part(type,type.getText(this.sourceFile),'value',primitive?['Type','System','PrimitiveType']:['Type'])];
    };
    const valuePart = (expression: ts.Expression, text = expression.getText(this.sourceFile)): SourcePart => {
      const literal = isLiteralValueExpression(expression);
      const systemValue = isSystemValueExpression(expression);
      return {
        text,
        kind: literal ? 'literal' : 'value',
        labels: literal ? literalValueLabels(expression) : ['Value', 'ValueAccess', ...(this.isCollectionExpression(expression) ? ['Collection'] : [])],
        sourceStableId: getExtendedStableId(this.sourceFile, expression),
        canonicalStableId: systemValue ? undefined : this.canonicalStableIdForExpression(expression),
        bindingStableId: systemValue ? undefined : this.bindingNodeStableIdForExpression(expression),
      };
    };
    const containsElementAccess = (expression: ts.Expression): boolean => {
      const current = unwrapExpression(expression);
      if (ts.isElementAccessExpression(current)) return true;
      return isPropertyAccessLikeExpression(current)
        ? containsElementAccess(current.expression)
        : false;
    };
    const isArithmeticBinaryExpression = (expression: ts.Expression): expression is ts.BinaryExpression => {
      if (!ts.isBinaryExpression(expression)) return false;
      return expression.operatorToken.kind === ts.SyntaxKind.PlusToken
        || expression.operatorToken.kind === ts.SyntaxKind.MinusToken
        || expression.operatorToken.kind === ts.SyntaxKind.AsteriskToken
        || expression.operatorToken.kind === ts.SyntaxKind.SlashToken
        || expression.operatorToken.kind === ts.SyntaxKind.PercentToken
        || expression.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken;
    };
    const visit = (expression: ts.Expression, preserveCollectionBacking = false): SourcePart[] => {
      if (
        ts.isParenthesizedExpression(expression)
        && isArithmeticBinaryExpression(unwrapExpression(expression.expression))
      ) {
        const boundary = (text: '(' | ')'): SourcePart => ({
          text,
          kind: 'punctuation',
          labels: ['Op', 'Operand', 'ArithmeticBoundary'],
          sourceStableId: getExtendedStableId(this.sourceFile, expression),
        });
        return [boundary('('), ...visit(expression.expression), boundary(')')];
      }
      const current = unwrapExpression(expression);
      if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const target = unwrapExpression(current.left);
        if (ts.isElementAccessExpression(target) && target.argumentExpression) {
          const type = this.checker.getTypeAtLocation(target.expression);
          if (this.checker.isArrayType(type) || this.checker.isTupleType(type)) {
            const sourceStableId = getExtendedStableId(this.sourceFile, target);
            return [
              ...visit(target.expression),
              { text: 'setAt(', kind: 'method', labels: ['Method', 'Virtual', 'Set', 'IndexedWrite'], primary: true, sourceStableId },
              ...visit(target.argumentExpression),
              { text: ',', kind: 'punctuation', labels: ['ArgumentSeparator'], sourceStableId },
              ...visit(current.right),
              { text: ')', kind: 'method', labels: ['Method', 'Virtual', 'Set', 'CallBoundary'], sourceStableId },
            ];
          }
        }
      }
      if (ts.isAwaitExpression(current)) {
        return [{
          text: 'await',
          kind: 'method',
          labels: ['Op', 'System', 'Keyword', 'Await'],
          sourceStableId: getExtendedStableId(this.sourceFile, current),
        }, ...visit(current.expression)];
      }
      if (completeCalls && ts.isObjectLiteralExpression(current)) {
        const punctuation = (text: string): SourcePart => ({ text, kind: 'punctuation',
          labels: ['System', 'ObjectBoundary'], sourceStableId: getExtendedStableId(this.sourceFile, current) });
        return [punctuation('{'), ...current.properties.flatMap((property, index) => [
          ...(index ? [punctuation(',')] : []),
          ...(ts.isPropertyAssignment(property)
            ? [{ text: `${property.name.getText(this.sourceFile)}:`, kind: 'value' as const,
                labels: ['Field','FieldName'], sourceStableId: getExtendedStableId(this.sourceFile, property.name) }, ...visit(property.initializer)]
            : [{ text: property.getText(this.sourceFile), kind: 'value' as const,
                labels: ['ValueAccess'], sourceStableId: getExtendedStableId(this.sourceFile, property) }]),
        ]), punctuation('}')];
      }
      if (ts.isTemplateExpression(current)) {
        const parts: SourcePart[] = [];
        const pushPart = (
          text: string,
          anchor: ts.Node,
          kind: SourcePart['kind'] = 'punctuation',
          labels: string[] = ['Op', 'TemplateBoundary'],
        ) => {
          if (!text) return;
          parts.push({
            text,
            kind,
            labels,
            sourceStableId: getExtendedStableId(this.sourceFile, anchor),
          });
        };
        pushPart('`', current.head);
        let staticText = current.head.text;
        for (const span of current.templateSpans) {
          const nextStaticText = span.literal.text;
          pushPart(staticText, span.expression, 'literal', ['Value', 'Literal']);
          pushPart('${', span.expression);
          parts.push(...visit(span.expression));
          pushPart('}', span.expression);
          staticText = nextStaticText;
        }
        pushPart(staticText, current.templateSpans.at(-1)?.literal || current.head, 'literal', ['Value', 'Literal']);
        pushPart('`', current.templateSpans.at(-1)?.literal || current.head);
        return parts;
      }
      if (ts.isPropertyAccessExpression(current) || ts.isPropertyAccessChain(current)) {
        if (this.isCollectionExpression(current) && preserveCollectionBacking) {
          return [{
            text: current.getText(this.sourceFile),
            kind: 'collection-container',
            labels: ['Value', 'ValueAccess', 'Collection'],
            fillState: 'filled',
            sourceStableId: getExtendedStableId(this.sourceFile, current),
            canonicalStableId: this.canonicalStableIdForExpression(current),
            bindingStableId: this.bindingNodeStableIdForExpression(current),
          }];
        }
        if (this.isCollectionExpression(current)) {
          const receiverParts = visit(current.expression);
          if (receiverParts.length) {
            receiverParts[0] = {
              ...receiverParts[0],
              kind: 'collection-container',
              labels: uniqueStrings([...(receiverParts[0].labels || []), 'Collection']),
              fillState: 'filled',
            };
          }
          return [...receiverParts, {
            text: `.${current.name.getText(this.sourceFile)}`,
            kind: 'value',
            labels: ['Value', 'ValueAccess', 'FieldAccess'],
            sourceStableId: getExtendedStableId(this.sourceFile, current.name),
            canonicalStableId: this.canonicalStableIdForExpression(current),
            bindingStableId: this.bindingNodeStableIdForExpression(current),
          }];
        }
        const receiverParts = visit(current.expression);
        if (current.questionDotToken && receiverParts.length) {
          const receiverIndex = receiverParts.length - 1;
          const receiverPart = receiverParts[receiverIndex];
          receiverParts[receiverIndex] = {
            ...receiverPart,
            text: `${receiverPart.text}?`,
            plainText: receiverPart.plainText ? `${receiverPart.plainText}?` : undefined,
            labels: uniqueStrings([...(receiverPart.labels || []), 'OptionalCheck']),
          };
        }
        const fieldPart: SourcePart = {
          text: `.${current.name.getText(this.sourceFile)}`,
          kind: 'value',
          labels: ['Value', 'ValueAccess', 'FieldAccess'],
          sourceStableId: getExtendedStableId(this.sourceFile, current.name),
          canonicalStableId: this.canonicalStableIdForExpression(current),
          bindingStableId: this.bindingNodeStableIdForExpression(current),
        };
        if (containsElementAccess(current)) {
          return [...receiverParts, fieldPart];
        }
        if (this.isCollectionExpression(current.expression)) {
          if (receiverParts.length) {
            receiverParts[0] = {
              ...receiverParts[0],
              kind: 'collection-container',
              labels: uniqueStrings([...(receiverParts[0].labels || []), 'Collection']),
              fillState: 'filled',
            };
          }
          return [
            ...receiverParts,
            {
              text: current.name.getText(this.sourceFile),
              kind: 'method',
              labels: ['Op', 'Method', 'ValueAccess', 'System'],
              primary: true,
              sourceStableId: getExtendedStableId(this.sourceFile, current.name),
              canonicalStableId: this.canonicalStableIdForExpression(current),
              bindingStableId: this.bindingNodeStableIdForExpression(current),
            },
          ];
        }
        return [...receiverParts, fieldPart];
      }
      if (ts.isElementAccessExpression(current)) {
        const receiverParts = visit(current.expression);
        const receiverType = this.checker.getTypeAtLocation(current.expression);
        const arrayRead = receiverParts.length === 1
          && (this.checker.isArrayType(receiverType) || this.checker.isTupleType(receiverType));
        if (arrayRead) receiverParts[0] = {
          ...receiverParts[0], kind: 'collection-container',
          labels: uniqueStrings([...(receiverParts[0].labels || []), 'Collection']), fillState: 'filled',
        };
        return [
          ...receiverParts,
          {
            text: '[',
            kind: arrayRead ? 'method' : 'punctuation',
            labels: arrayRead ? ['Method', 'System', 'IndexedRead'] : ['Op', 'Operand'],
            sourceStableId: getExtendedStableId(this.sourceFile, current),
          },
          ...(current.argumentExpression ? visit(current.argumentExpression) : []),
          {
            text: ']',
            kind: arrayRead ? 'method' : 'punctuation',
            labels: arrayRead ? ['Method', 'System', 'IndexedRead', 'CallBoundary'] : ['Op', 'Operand'],
            sourceStableId: getExtendedStableId(this.sourceFile, current),
            canonicalStableId: this.canonicalStableIdForExpression(current),
            bindingStableId: this.bindingNodeStableIdForExpression(current),
          },
        ];
      }
      if (ts.isNewExpression(current)) {
        const origin=constructorSemantics(ts,this.checker,current.expression);
        const sourceStableId=getExtendedStableId(this.sourceFile,current);
        const labels=['Op','Call','Constructor',origin.system?'System':'DeveloperDefined',...(origin.error?['SystemError']:[])];
        const keyword=current.getChildren(this.sourceFile).find(child=>child.kind===ts.SyntaxKind.NewKeyword)!;
        return [
          {text:'new',kind:'method',labels:['Op','System','Keyword','New'],sourceStableId:getExtendedStableId(this.sourceFile,keyword)},
          {text:`${current.expression.getText(this.sourceFile)}(`,kind:'method',labels,primary:true,sourceStableId},
          ...(current.arguments || []).flatMap((argument,index)=>[
            ...(index?[{text:',',kind:'punctuation' as const,labels:['ArgumentSeparator'],sourceStableId}]:[]),
            ...visit(argument),
          ]),
          {text:')',kind:'method',labels:[...labels,'CallBoundary'],sourceStableId},
        ];
      }
      if (ts.isCallExpression(current)) {
        const callee = unwrapExpression(current.expression);
        const operationProviderLabels = this.operationProviderLabels(current);
        const providerReceiverParts = (expression: ts.Expression) => visit(expression, true).map((part) => ({
          ...part,
          labels: uniqueStrings([...(part.labels || []), ...operationProviderLabels]),
        }));
        const callOriginLabels = !this.isDeveloperSideCallExpression(
          current,
          this.resolveRenderableCallTarget(current),
        ) ? ['System'] : [];
        const boundaryDesign = this.callBoundaryDesign(current);
        const argumentsForMosaic = this.callMosaicArguments(current);
        // Atomic expressions have no separate argument family to complete an opener.
        // Preserve the entire nested call here, including its type arguments.
        if (completeCalls && boundaryDesign === 'split') {
          const sourceStableId = getExtendedStableId(this.sourceFile, current);
          const punctuation = (text: string): SourcePart => ({ text, kind: 'punctuation',
            labels: text==='(' || text===')' ? ['Op','CallBoundary','CallDelimiter',...callOriginLabels] : ['Op', 'System', 'CallBoundary'], sourceStableId });
          return [
            ...(isPropertyAccessLikeExpression(callee) ? visit(callee.expression) : []),
            { text: isPropertyAccessLikeExpression(callee) ? `.${callee.name.getText(this.sourceFile)}` : current.expression.getText(this.sourceFile),
              kind: 'method', labels: ['Op', 'Call', ...callOriginLabels], primary: true, sourceStableId },
            ...(current.typeArguments?.length ? [punctuation('<'), ...current.typeArguments.flatMap((type, index) => [
              ...(index ? [punctuation(',')] : []),
              ...typeParts(type),
            ]), punctuation('>')] : []),
            punctuation('('),
            ...current.arguments.flatMap((argument, index) => [...(index ? [punctuation(',')] : []), ...visit(argument)]),
            punctuation(')'),
          ];
        }
        const chainedReceiver = isPropertyAccessLikeExpression(callee)
          && ts.isCallExpression(unwrapExpression(callee.expression))
          && this.expressionRequiresVerticalExpansion(callee.expression);
        if (boundaryDesign === 'mosaic' && argumentsForMosaic.length === 1) {
          const argumentParts = visit(argumentsForMosaic[0].argument);
          const closingPart: SourcePart = {
            text: ')',
            kind: 'punctuation',
            labels: ['Op', 'CallBoundary', ...callOriginLabels],
            sourceStableId: getExtendedStableId(this.sourceFile, current),
          };
          if (isPropertyAccessLikeExpression(callee)) {
            return [
              ...(chainedReceiver ? [] : providerReceiverParts(callee.expression)),
              {
                text: `${callee.name.getText(this.sourceFile)}(`,
                kind: 'method',
                labels: ['Op', 'Method', 'Call', ...callOriginLabels, ...operationProviderLabels],
                primary: true,
                sourceStableId: getExtendedStableId(this.sourceFile, current),
              },
              ...argumentParts,
              closingPart,
            ];
          }
          return [
            {
              text: `${current.expression.getText(this.sourceFile)}(`,
              kind: 'method',
              labels: ['Op', 'Call', ...callOriginLabels],
              primary: true,
              sourceStableId: getExtendedStableId(this.sourceFile, current),
            },
            ...argumentParts,
            closingPart,
          ];
        }
        if (boundaryDesign === 'mosaic' && argumentsForMosaic.length === 0) {
          if (isPropertyAccessLikeExpression(callee)) {
            return [
              ...(chainedReceiver ? [] : providerReceiverParts(callee.expression)),
              {
                text: `${callee.name.getText(this.sourceFile)}()`,
                kind: 'method',
                labels: ['Op', 'Method', 'Call', ...callOriginLabels, ...operationProviderLabels],
                primary: true,
                sourceStableId: getExtendedStableId(this.sourceFile, current),
              },
            ];
          }
          return [{
            text: `${current.expression.getText(this.sourceFile)}()`,
            kind: 'method',
            labels: ['Op', 'Call', ...callOriginLabels],
            primary: true,
            sourceStableId: getExtendedStableId(this.sourceFile, current),
          }];
        }
        if (isPropertyAccessLikeExpression(callee)) {
          const receiverParts = chainedReceiver ? [] : providerReceiverParts(callee.expression);
          const methodName = callee.name.getText(this.sourceFile);
          if (boundaryDesign === 'split') {
            return [...receiverParts, {
              text: `${methodName}(`,
              kind: 'method',
              labels: ['Op', 'Method', 'Call', ...callOriginLabels, ...operationProviderLabels],
              primary: true,
              sourceStableId: getExtendedStableId(this.sourceFile, current),
            }];
          }
          const argumentText = current.arguments.map((argument) => argument.getText(this.sourceFile)).join(', ');
          return [...receiverParts, {
            text: `${methodName}(${argumentText})`,
            kind: 'method',
            labels: ['Op', 'Method', 'Call', ...callOriginLabels, ...operationProviderLabels],
            primary: true,
            sourceStableId: getExtendedStableId(this.sourceFile, current),
          }];
        }
        return [{
          text: boundaryDesign === 'split'
            ? `${current.expression.getText(this.sourceFile)}(`
            : current.getText(this.sourceFile),
          kind: 'method',
          labels: ['Op', 'Call', ...callOriginLabels],
          primary: true,
          sourceStableId: getExtendedStableId(this.sourceFile, current),
        }];
      }
      if (ts.isBinaryExpression(current)) {
        return [
          ...visit(current.left),
          {
            text: current.operatorToken.getText(this.sourceFile),
            kind: 'operator',
            labels: ['Op', 'Operand'],
            primary: true,
            sourceStableId: getExtendedStableId(this.sourceFile, current.operatorToken),
          },
          ...visit(current.right),
        ];
      }
      if (ts.isPrefixUnaryExpression(current)) {
        if (
          (current.operator === ts.SyntaxKind.PlusToken || current.operator === ts.SyntaxKind.MinusToken)
          && ts.isNumericLiteral(unwrapExpression(current.operand))
        ) {
          return [{
            ...valuePart(current, current.getText(this.sourceFile)),
            kind: 'literal',
            labels: ['Value', 'Literal', 'NumericLiteral'],
          }];
        }
        return [{
          text: ts.tokenToString(current.operator) || current.getText(this.sourceFile).slice(0, 1),
          kind: 'operator',
          labels: ['Op', 'Operand'],
          primary: true,
          sourceStableId: getExtendedStableId(this.sourceFile, current),
        }, ...visit(current.operand)];
      }
      if (ts.isNonNullExpression(current)) {
        const parts = visit(current.expression);
        if (parts.length) parts[parts.length - 1] = { ...parts[parts.length - 1], text: `${parts.at(-1)?.text || ''}!` };
        return parts;
      }
      if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
        return visit(current.expression);
      }
      return [valuePart(current)];
    };

    const renderedExpression = unwrapAwaitedExpression(expression);
    const sourceParts = visit(expression);
    if (
      ts.isCallExpression(renderedExpression)
      && this.callInvocationContract(renderedExpression).responseMode === 'awaited'
    ) {
      if (!sourceParts.some((part) => part.labels?.includes('Await'))) sourceParts.unshift({
        text: 'await',
        kind: 'method',
        labels: ['Op', 'System', 'Keyword', 'Await'],
        sourceStableId: getExtendedStableId(
          this.sourceFile,
          renderedExpression.parent && ts.isAwaitExpression(renderedExpression.parent)
            ? renderedExpression.parent
            : renderedExpression,
        ),
      });
    }
    if (!sourceParts.length) return undefined;
    const explicitPrimary = sourceParts.findIndex((part) => part.primary);
    const primaryIndex = explicitPrimary >= 0 ? explicitPrimary : sourceParts.length - 1;
    const parts: RenderPartDescriptor[] = sourceParts.map(({ primary: _primary, ...part }, order) => ({
      ...part,
      stableId: order === primaryIndex ? ownerStableId : `${ownerStableId}:render-part:${order}`,
      order,
    }));
    parts.forEach((part, index) => {
      if (
        index < parts.length - 1
        && part.kind !== 'method'
        && part.labels?.includes('OperationProvider')
        && !part.labels?.includes('SystemProvider')
      ) {
        parts[index] = {
          ...part,
          kind: 'operation-provider-container',
        };
      }
    });
    const operationProviderContainerIndex = parts.findIndex(
      (part) => part.kind === 'operation-provider-container',
    );
    if (operationProviderContainerIndex > 0) {
      const [providerContainer] = parts.splice(operationProviderContainerIndex, 1);
      parts.unshift(providerContainer);
      parts.forEach((part, order) => {
        part.order = order;
      });
    }
    return {
      json: JSON.stringify(parts),
      layout: parts.some((part) => part.kind === 'operation-provider-container')
        ? 'container-overlay-side'
        : parts.some((part) => part.kind === 'collection-container')
        ? 'container-overlay-side'
        : parts.length > 1 ? 'horizontal' : 'single',
      primaryIndex,
    };
  }

  private createNode(
    kind: FlowNodeKind,
    label: string,
    node: ts.Node,
    extra: FlowNodeExtra = {},
    stableIdOverride?: string,
    inferCallContract = true,
  ) {
    if (extra.synthetic && extra.labels?.includes('Result')) {
      extra = {
        ...extra,
        labels: uniqueStrings([...extra.labels, 'Virtual']),
      };
    }
    if (kind === 'FnVisualProxy' || extra.labels?.includes('VisualProxy')) {
      extra = {
        ...extra,
        labels: uniqueStrings([...(extra.labels || []), 'VisualProxy', 'PresentationOnly']),
        annotationKind: undefined,
      };
    }
    const rawStableId = stableIdOverride || getStableIdKey(extra.stableId) || getExtendedStableId(this.sourceFile, node);
    const stableId = kind === 'Step' || kind === 'FlowBlock'
      ? rawStableId
      : this.contextualizeHorizontalStableId(rawStableId, node);
    if (this.seenNodeStableIds.has(stableId)) {
      return stableId;
    }

    const stableIdDescriptor = stableId !== rawStableId || stableIdOverride || extra.stableId
      ? buildStableIdDescriptorFromValue(stableId, {
        repoRelativePath: getRepoRelativePath(this.sourceFile.fileName),
        filePath: toPosix(path.resolve(this.sourceFile.fileName)),
      })
      : getExtendedStableIdDescriptor(this.sourceFile, node);

    const contextualLabels = this.contextualNodeLabelSets.flat();
    const submethodRegion = kind === 'Step' || kind === 'FlowBlock'
      ? undefined
      : [...this.submethodSourceRegions].reverse().find((region) => (
          node.getSourceFile() === region.anchor.getSourceFile()
          && node.getStart(this.sourceFile) >= region.anchor.getStart(this.sourceFile)
          && node.getEnd() <= region.anchor.getEnd()
        ));
    const effectiveExtraWithLabels: FlowNodeExtra = submethodRegion
      ? {
          ...extra,
          labels: uniqueStrings([...(extra.labels || []), ...contextualLabels, 'SubStepAttachment']),
          memberOfSubmethodStableId: extra.memberOfSubmethodStableId || submethodRegion.stableId,
          submethodPlacement: extra.submethodPlacement || 'right',
          submethodAnchorStableId: extra.submethodAnchorStableId || submethodRegion.stableId,
          submethodMemberOrder: extra.submethodMemberOrder ?? submethodRegion.nextMemberOrder++,
          submethodRelativeColumn: extra.submethodRelativeColumn ?? 1,
          submethodRelativeRow: extra.submethodRelativeRow ?? 2 + submethodRegion.nextMemberOrder * 0.35,
        }
      : contextualLabels.length
        ? { ...extra, labels: uniqueStrings([...(extra.labels || []), ...contextualLabels]) }
        : extra;
    const enclosingFlowBlock = this.flowBlockContexts.at(-1);
    const parentFlowBlockStableId = this.resolveFlowBlockStableId(
      effectiveExtraWithLabels.parentFlowBlockStableId || enclosingFlowBlock?.stableId,
    );
    const effectiveExtraWithFlowBlock: FlowNodeExtra = parentFlowBlockStableId
      ? {
          ...effectiveExtraWithLabels,
          parentFlowBlockStableId,
        }
      : effectiveExtraWithLabels;
    // A Flow:Join belongs to the step of its last incoming path, which is
    // only known after both branches have been materialized. Do not capture
    // the ambient context of the builder call that creates the synthetic join.
    const localFunctionContext = this.localFunctionContexts.at(-1);
    const effectiveExtraWithLocalFunction: FlowNodeExtra = localFunctionContext
      ? {
          ...effectiveExtraWithFlowBlock,
          parentLocalFunctionStableId: effectiveExtraWithFlowBlock.parentLocalFunctionStableId
            || localFunctionContext.stableId,
          localFunctionName: effectiveExtraWithFlowBlock.localFunctionName
            || localFunctionContext.name,
          localFunctionDepth: effectiveExtraWithFlowBlock.localFunctionDepth
            ?? localFunctionContext.depth,
        }
      : effectiveExtraWithFlowBlock;
    const enclosingLoopStep = this.enclosingLoopStepContexts.at(-1);
    const flowStep = kind === 'FlowJoin' || kind === 'Step'
      ? undefined
      : this.flowStepContexts.at(-1) || enclosingLoopStep;
    const syntaxPlan = this.syntaxRegionPlanByNode.get(node);
    const representationPlan = this.astRepresentationPlanByNode.get(node);
    const effectiveExtra: FlowNodeExtra = flowStep
      ? {
          ...effectiveExtraWithLocalFunction,
          parentStepStableId: effectiveExtraWithLocalFunction.parentStepStableId || flowStep.stableId,
          flowStepKind: effectiveExtraWithLocalFunction.flowStepKind || flowStep.kind,
          flowStepOrder: effectiveExtraWithLocalFunction.flowStepOrder ?? flowStep.order,
          structureDepth: effectiveExtraWithLocalFunction.structureDepth ?? syntaxPlan?.depth,
          structureRelativeColumn: effectiveExtraWithLocalFunction.structureRelativeColumn ?? syntaxPlan?.relativeColumn,
          structureRelativeRow: effectiveExtraWithLocalFunction.structureRelativeRow ?? syntaxPlan?.relativeRow,
          representationMode: effectiveExtraWithLocalFunction.representationMode ?? representationPlan?.mode,
          representationEstimatedColumns: effectiveExtraWithLocalFunction.representationEstimatedColumns
            ?? representationPlan?.estimatedColumns,
          representationEstimatedRows: effectiveExtraWithLocalFunction.representationEstimatedRows
            ?? representationPlan?.estimatedRows,
        }
      : {
          ...effectiveExtraWithLocalFunction,
          structureDepth: effectiveExtraWithLocalFunction.structureDepth ?? syntaxPlan?.depth,
          structureRelativeColumn: effectiveExtraWithLocalFunction.structureRelativeColumn ?? syntaxPlan?.relativeColumn,
          structureRelativeRow: effectiveExtraWithLocalFunction.structureRelativeRow ?? syntaxPlan?.relativeRow,
          representationMode: effectiveExtraWithLocalFunction.representationMode ?? representationPlan?.mode,
          representationEstimatedColumns: effectiveExtraWithLocalFunction.representationEstimatedColumns
            ?? representationPlan?.estimatedColumns,
          representationEstimatedRows: effectiveExtraWithLocalFunction.representationEstimatedRows
            ?? representationPlan?.estimatedRows,
        };
    const operationFields = kind === 'Step'
      ? {}
      : this.mergeSemanticOperationDetail(
          buildOperationFields(kind, node, this.sourceFile, { ...effectiveExtra, label }, this.checker),
          kind,
          node,
        );
    const callExpression = inferCallContract ? getCallLikeExpressionFromNode(node) : undefined;
    const invocationContract = callExpression
      ? this.callInvocationContract(callExpression)
      : undefined;
    const callSemanticLabels = callExpression
      ? [
          ...(isPropertyAccessLikeExpression(unwrapExpression(callExpression.expression)) ? ['Method'] : []),
          ...(!this.isDeveloperSideCallExpression(
            callExpression,
            this.resolveRenderableCallTarget(callExpression),
          ) ? ['System'] : []),
          ...this.operationProviderLabels(callExpression),
        ]
      : [];
    const asyncLabels = invocationContract?.invocationMode === 'asynchronous'
      ? [
          'Async',
          invocationContract.responseMode === 'awaited' ? 'Awaited' : 'FireAndForget',
        ]
      : [];
    const enrichedExtra: FlowNodeExtra = {
      ...(inferCallContract ? this.buildCallTargetExtra(node) || {} : {}),
      ...(invocationContract || {}),
      ...(asyncLabels.length || callSemanticLabels.length ? {
        labels: uniqueStrings([
          ...(effectiveExtra.labels || []),
          ...callSemanticLabels,
          ...asyncLabels,
        ]),
      } : {}),
      ...(asyncLabels.length ? {
        asyncContract: invocationContract?.responseMode === 'awaited' ? 'awaited' : 'fire-and-forget',
        annotationKind: 'AsyncFlow',
      } : {}),
    };
    const renderParts = this.buildRenderParts(node, stableId);
    const operationIndex = this.operationOrdinal;
    this.operationOrdinal += 1;

    const row = buildFlowNodeRow({
      kind,
      stableId: stableIdDescriptor,
      label,
      parentFnStableId: this.fnStableIdDescriptor,
      sourceFilePath: this.sourceFile.fileName,
      operationIndex,
      operationFields,
      extra: {
        ...(renderParts ? {
          renderPartsJson: renderParts.json,
          renderPartsLayout: renderParts.layout,
          renderPrimaryPartIndex: renderParts.primaryIndex,
        } : {}),
        ...effectiveExtra,
        ...enrichedExtra,
      },
    }) as FlowNodeRow;
    const controlNode = row.labels.includes('Step')
      || row.labels.includes('Flow')
      || row.labels.includes('Branch')
      || row.labels.includes('Loop')
      || row.labels.includes('Switch')
      || row.labels.includes('Case')
      || row.labels.includes('Return')
      || row.labels.includes('FunctionEnd')
      || row.labels.includes('BreakStop')
      || row.labels.includes('ThrowStop');
    row.flowLayer ||= controlNode || dataFlowRoleForNode(row) === 'operation' ? 'control' : 'data';
    if (row.flowLayer === 'data' || row.flowLayer === 'mixed') {
      row.dataFlowRole ||= dataFlowRoleForNode(row);
    }
    if (!row.renderPartsJson) {
      row.renderPartsJson = JSON.stringify([{
        stableId,
        text: String(row.diaName || row.label || ''),
        kind: row.labels.includes('Literal') ? 'literal' : row.labels.includes('Op') ? 'operator' : 'value',
        labels: row.labels,
        order: 0,
        sourceStableId: stableId,
      } satisfies RenderPartDescriptor]);
      row.renderPartsLayout = 'single';
      row.renderPrimaryPartIndex = 0;
    } else {
      const parts = JSON.parse(row.renderPartsJson) as RenderPartDescriptor[];
      const methodPartIndex = parts.findIndex((part) => part.kind === 'method');
      if (
        row.labels.includes('Collection')
        && row.renderPartsLayout === 'horizontal'
        && methodPartIndex > 0
      ) {
        parts[0] = {
          ...parts[0],
          kind: 'collection-container',
          labels: uniqueStrings([...(parts[0].labels || []), 'Collection']),
        };
        row.renderPartsJson = JSON.stringify(parts);
        row.renderPartsLayout = 'container-overlay-side';
        row.renderPrimaryPartIndex = methodPartIndex;
      }
      if (
        parts.length > 1
        && row.callBoundaryDesign !== 'mosaic'
        && !['container-overlay', 'container-overlay-side', 'horizontal', 'vertical'].includes(
          row.renderPartsLayout || '',
        )
        && row.labels.some((entry) => ['Collection', 'Call', 'Request'].includes(entry))
      ) {
        row.renderPartsLayout = 'diagonal';
      }
    }
    this.nodes.push(row);
    this.seenNodeStableIds.add(stableId);
    return stableId;
  }

  private createSharedTerminalNode(kind: Extract<FlowNodeKind, 'BreakStop' | 'FunctionEnd'>, anchor: ts.Node) {
    if (kind === 'FunctionEnd') {
      const { endLine, endColumn } = getRange(this.sourceFile, anchor);
      const stableId = `${buildStableIdFromCoordinates({
        filePath: toPosix(path.resolve(this.sourceFile.fileName)),
        startLine: endLine,
        startColumn: endColumn,
        endLine,
        endColumn: endColumn + 1,
      })}:end`;
      return this.createNode('FunctionEnd', 'end', anchor, {}, stableId);
    }

    const { endLine, endColumn } = getRange(this.sourceFile, anchor);
    const stableId = `${buildStableIdFromCoordinates({
      filePath: toPosix(path.resolve(this.sourceFile.fileName)),
      startLine: endLine,
      startColumn: endColumn,
      endLine,
      endColumn: endColumn + this.mergeOrdinal,
    })}:break`;
    this.mergeOrdinal += 1;
    return this.createNode('BreakStop', 'break', anchor, {}, stableId);
  }

  private createReturnNode(statement: ts.ReturnStatement, valueMaterialized = false) {
    const { startLine, startColumn, endLine, endColumn } = getRange(this.sourceFile, statement);
    const sourceStableId = `${buildStableIdFromCoordinates({
      filePath: toPosix(path.resolve(this.sourceFile.fileName)),
      startLine,
      startColumn,
      endLine,
      endColumn,
    })}:return`;
    const stableId = this.contextualizeHorizontalStableId(sourceStableId, statement);
    return this.createNode('Return', 'return', statement, {
      diaName: 'Return',
      actionTextRaw: statement.getText(this.sourceFile),
      ...(statement.expression ? {
        renderPartsLayout: 'horizontal' as const, renderPrimaryPartIndex: 0,
        renderPartsJson: JSON.stringify([
          { stableId, text: 'return(', kind: 'method',
            labels: ['System', 'Keyword', 'Return', 'CallBoundary'], order: 0, sourceStableId },
          { stableId: getExtendedStableId(this.sourceFile, statement.expression),
            text: statement.expression.getText(this.sourceFile), kind: 'value',
            labels: ['Value', 'ValueRead', ...(this.isCollectionExpression(statement.expression) ? ['Collection'] : [])], order: 1,
            sourceStableId: getExtendedStableId(this.sourceFile, statement.expression) },
          { stableId: `${stableId}:close`, text: ')', kind: 'punctuation',
            labels: ['System', 'Return', 'CallBoundary'], order: 2, sourceStableId },
        ]),
      } : valueMaterialized ? {
        renderPartsLayout: 'single' as const, renderPrimaryPartIndex: 0,
        renderPartsJson: JSON.stringify([{ stableId, text: 'Return', kind: 'value',
          labels: ['Return', 'System', 'Keyword'], order: 0, sourceStableId }]),
      } : {}),
    }, stableId);
  }

  private createSharedThrowStopNode(actionTextRaw: string) {
    const stableSuffix = Buffer.from(actionTextRaw || 'throw', 'utf8').toString('base64url').slice(0, 24) || 'throw';
    const stableId = `${this.fnStableId}:throw:${stableSuffix}`;
    return this.createNode('ThrowStop', 'throw', this.fnNode, {
      actionTextRaw,
    }, stableId);
  }

  private materializePendingThrows(pendingThrows: PendingThrowExit[]) {
    const groupedByText = new Map<string, PendingThrowExit[]>();

    for (const exit of pendingThrows) {
      const key = exit.actionTextRaw || 'throw';
      const current = groupedByText.get(key);
      if (current) {
        current.push(exit);
      } else {
        groupedByText.set(key, [exit]);
      }
    }

    for (const [actionTextRaw, exits] of groupedByText) {
      const throwStopId = this.createSharedThrowStopNode(actionTextRaw);
      this.connectPendingToNode(exits, throwStopId);
    }
  }

  private addEdge(
    fromKind: 'Fn' | undefined,
    fromId: string,
    toKind: 'Fn' | undefined,
    toId: string,
    type: FlowEdgeKind,
    extra: Partial<Pick<FlowEdgeRow, 'label' | 'diaName' | 'callTextRaw' | 'invocationMode' | 'responseMode' | 'storageStableIds' | 'mainFlow' | 'callSiteStableId' | 'invocationType' | 'flowLayer' | 'ownerStepStableId' | 'semanticExpansion' | 'sequenceOrder' | 'executionOutcome' | 'protocolRole' | 'protocolRoles' | 'argumentName' | 'argumentIndex' | 'layoutFrame' | 'fieldName' | 'fieldIndex' | 'displayLabel' | 'renderHidden' | 'contextOnly' | 'producerRouteRole' | 'producerOutcome' | 'optionalReturnGroupStableId' | 'producerScopeStartOrder' | 'producerScopeEndOrder' | 'producerScopeStableIds' | 'repeatOrigin' | 'oneWay' | 'sourcePort' | 'targetPort' | 'sourcePortCandidates' | 'targetPortCandidates' | 'lockPortCandidates' | 'sourceRenderPartStableId' | 'targetRenderPartStableId' | 'elseIfChainBypass'>> = {},
  ) {
    if (fromKind === undefined) fromId = this.resolveFlowBlockStableId(fromId) || fromId;
    if (toKind === undefined) toId = this.resolveFlowBlockStableId(toId) || toId;
    if (fromKind === undefined && toKind === undefined && fromId === toId) return;
    const source = fromKind === undefined ? this.nodeByStableId(fromId) : undefined;
    const target = toKind === undefined ? this.nodeByStableId(toId) : undefined;
    if (type === 'FIELD' && target?.labels.includes('Field') && !target.labels.includes('Join')) {
      target.fieldName ||= extra.fieldName;
      target.fieldIndex ??= extra.fieldIndex ?? extra.sequenceOrder;
    }
    if (type === 'ARG' && target?.labels.includes('Arg') && !target.labels.includes('Join')) {
      target.argumentName ||= extra.argumentName;
      target.argumentIndex ??= extra.argumentIndex ?? extra.sequenceOrder;
    }
    const argumentName = type === 'ARG' || type === 'ArgJoin'
      ? extra.argumentName || target?.argumentName || source?.argumentName
      : undefined;
    const argumentValueNode = type === 'ARG' ? target : type === 'ArgJoin' ? source : undefined;
    const redundantArgumentLabel = Boolean(
      argumentName
      && !(type === 'ARG' && source?.labels.includes('IndexedWrite'))
      && referenceNamesForFlowNode(argumentValueNode).has(argumentName),
    );
    const fieldName = type === 'FIELD' || type === 'FieldJoin'
      ? extra.fieldName || target?.fieldName || source?.fieldName
      : undefined;
    const fieldValueNode = type === 'FIELD' ? target : type === 'FieldJoin' ? source : undefined;
    const redundantFieldLabel = Boolean(
      fieldName
      && referenceNamesForFlowNode(fieldValueNode).has(fieldName),
    );
    const slotExtra = type === 'ARG' || type === 'ArgJoin'
      ? {
          argumentName,
          argumentIndex: extra.argumentIndex ?? target?.argumentIndex ?? source?.argumentIndex,
          layoutFrame: extra.layoutFrame || 'horizontal' as const,
          displayLabel: redundantArgumentLabel ? '' : (extra.displayLabel ?? argumentName),
        }
      : type === 'FIELD' || type === 'FieldJoin'
        ? {
          fieldName,
          fieldIndex: extra.fieldIndex ?? target?.fieldIndex ?? source?.fieldIndex,
          layoutFrame: extra.layoutFrame || 'horizontal' as const,
          displayLabel: redundantFieldLabel ? '' : (extra.displayLabel ?? fieldName),
        }
        : {};
    const assignmentReturn = type === 'TRUE'
      && extra.semanticExpansion === 'execution-protocol'
      && target?.labels.includes('ContainerMethod')
      && target.labels.includes('Set');
    const iterationRepeat = ['NEXT', 'TRUE', 'FALSE'].includes(type)
      && extra.semanticExpansion === 'collection-iteration'
      && Boolean(target?.labels.includes('Pull'));
    const semanticExtra = {
      ...extra,
      ...slotExtra,
      flowLayer: extra.flowLayer || flowLayerForEdge(type),
      ...(['TRUE', 'FALSE'].includes(type) ? {
        diaName: extra.diaName ?? type.toLowerCase(),
        displayLabel: extra.displayLabel ?? type.toLowerCase(),
      } : {}),
      ...(type === 'EVAL' ? { oneWay: true } : {}),
      ...(type === 'REPEATS' ? {
        label: 'repeat',
        displayLabel: 'repeat',
        protocolRole: extra.protocolRole || 'iteration-repeat',
        repeatOrigin: extra.repeatOrigin || (
          source?.labels.some((label) => ['Branch', 'Predicate', 'PredicateOperator'].includes(label))
            ? 'binary-expression'
            : 'sequence'
        ),
      } : {}),
      ...(iterationRepeat ? {
        diaName: 'repeat',
        protocolRole: 'iteration-repeat',
      } : {}),
      ...(assignmentReturn ? {
        protocolRole: 'assignment-return',
        sourcePort: 'left',
        sourcePortCandidates: ['left'],
        lockPortCandidates: true,
      } : {}),
    };
    const ownerStepStableId = semanticExtra.ownerStepStableId
      || source?.ownerStepStableId
      || source?.parentStepStableId
      || target?.ownerStepStableId
      || target?.parentStepStableId;
    this.edges.push({
      fromKind,
      fromId,
      toKind,
      toId,
      type,
      ...semanticExtra,
      ...(ownerStepStableId ? { ownerStepStableId } : {}),
      ...classifyFlowEdge(type, semanticExtra),
    });
  }

  private materializeExecutionProtocolFacts() {
    const nodeById = new Map(this.nodes.map((node) => [getStableIdKey(node.stableId), node]));
    const outgoing = (stableId: string, type?: FlowEdgeKind) => this.edges.filter((edge) => (
      edge.fromId === stableId && (!type || edge.type === type)
    ));
    const incoming = (stableId: string, type?: FlowEdgeKind) => this.edges.filter((edge) => (
      edge.toId === stableId && (!type || edge.type === type)
    ));
    const through = (stableId: string, type: FlowEdgeKind) => (
      nodeById.get(outgoing(stableId, type)[0]?.toId)
    );
    const from = (stableId: string, type: FlowEdgeKind) => (
      nodeById.get(incoming(stableId, type)[0]?.fromId)
    );
    const stableIdOf = (node: FlowNodeRow | undefined) => (
      node ? getStableIdKey(node.stableId) : undefined
    );
    const hasLabel = (node: FlowNodeRow | undefined, label: string) => Boolean(node?.labels.includes(label));
    const relate = (
      fromNode: FlowNodeRow | undefined,
      type: FlowEdgeKind,
      toNode: FlowNodeRow | undefined,
      label: string,
      flowLayer: FlowLayer = 'data',
    ): FlowEdgeRow | undefined => {
      if (!fromNode || !toNode) return undefined;
      const fromStableId = getStableIdKey(fromNode.stableId);
      const toStableId = getStableIdKey(toNode.stableId);
      if (fromStableId === toStableId) return undefined;
      const existing = outgoing(fromStableId, type).find((edge) => edge.toId === toStableId);
      if (existing) return existing;
      const edgeCount = this.edges.length;
      this.addEdge(undefined, fromStableId, undefined, toStableId, type, {
        label,
        flowLayer,
        semanticExpansion: 'execution-protocol',
      });
      return this.edges.length > edgeCount ? this.edges.at(-1) : undefined;
    };
    const byOperation = (left: FlowNodeRow, right: FlowNodeRow) => (
      (left.operationIndex ?? Number.MAX_SAFE_INTEGER)
      - (right.operationIndex ?? Number.MAX_SAFE_INTEGER)
    );
    const register = (
      rootStableId: string,
      protocolKind: string,
      role: string,
      node: FlowNodeRow | undefined,
      sequenceOrder: number,
    ) => {
      if (!node) return;
      const stageStableId = getStableIdKey(node.stableId);
      const root = nodeById.get(rootStableId);
      if (!root) return;
      root.executionProtocolStableId = rootStableId;
      root.executionProtocolKind = protocolKind;
      root.executionRoles = uniqueStrings([...(root.executionRoles || []), ...(stageStableId === rootStableId ? [role] : [])]);
      root.executionRoleOrder = Math.min(root.executionRoleOrder ?? sequenceOrder, sequenceOrder);
      node.executionProtocolStableId = rootStableId;
      node.executionProtocolKind = protocolKind;
      node.executionRoles = uniqueStrings([...(node.executionRoles || []), role]);
      node.executionRoleOrder = Math.min(node.executionRoleOrder ?? sequenceOrder, sequenceOrder);
    };
    const registerStableId = (
      rootStableId: string,
      protocolKind: string,
      role: string,
      stageStableId: string | undefined,
      sequenceOrder: number,
      toKind: 'Fn' | undefined = undefined,
    ) => {
      if (!stageStableId) return;
      const stage = nodeById.get(stageStableId);
      if (stage) {
        register(rootStableId, protocolKind, role, stage, sequenceOrder);
        return;
      }
      const root = nodeById.get(rootStableId);
      if (!root || toKind !== 'Fn') return;
      root.executionProtocolStableId = rootStableId;
      root.executionProtocolKind = protocolKind;
      const bindings = (() => {
        try {
          return JSON.parse(root.executionRoleBindingsJson || '{}') as Record<string, string>;
        } catch {
          return {};
        }
      })();
      bindings[role] = stageStableId;
      root.executionRoleBindingsJson = JSON.stringify(bindings);
    };
    const removeRelations = (predicate: (edge: FlowEdgeRow) => boolean) => {
      for (let index = this.edges.length - 1; index >= 0; index -= 1) {
        if (predicate(this.edges[index])) this.edges.splice(index, 1);
      }
    };
    type SubmethodMemberSpec = {
      role: string;
      member?: FlowNodeRow;
      target?: FlowNodeRow;
      targetEdgeType?: FlowEdgeKind;
      targetLabel?: string;
      targetFlowLayer?: FlowLayer;
    };
    type SubmethodAttachmentSpec = {
      node?: FlowNodeRow;
      placement: 'right' | 'overlay';
      anchor?: FlowNodeRow;
    };
    const materializeSubmethod = ({
      rootStableId,
      protocolKind,
      columnRole,
      header,
      ownerStableId,
      members,
      axisOrder,
      attachments = [],
      sequenceOrder,
      parentSubmethodStableId,
      submethodKind = 'collection-method',
      connectAxis = true,
    }: {
      rootStableId: string;
      protocolKind: string;
      columnRole: string;
      header: FlowNodeRow | undefined;
      ownerStableId: string | undefined;
      members: SubmethodMemberSpec[];
      axisOrder?: Array<number | FlowNodeRow | undefined>;
      attachments?: SubmethodAttachmentSpec[];
      sequenceOrder: number;
      parentSubmethodStableId?: string;
      submethodKind?: 'collection-method' | 'function-callback' | 'catch';
      connectAxis?: boolean;
    }) => {
      const root = nodeById.get(rootStableId);
      if (!root || !header || !ownerStableId) return [];
      const headerStableId = getStableIdKey(header.stableId);
      header.labels = uniqueStrings([...header.labels, 'SubStep']);
      header.submethodStableId = headerStableId;
      header.parentSubmethodStableId = parentSubmethodStableId;
      header.submethodKind = submethodKind;
      header.submethodOrder = sequenceOrder;
      header.submethodRelativeColumn = 0;
      header.submethodRelativeRow = 0;
      const created = members.map((spec, index) => {
        const node = spec.member || spec.target;
        if (!node) return undefined;
        const role = `${columnRole}Event${index + 1}`;
        node.executionProtocolStableId = rootStableId;
        node.executionProtocolKind = protocolKind;
        node.executionRoles = uniqueStrings([...(node.executionRoles || []), role]);
        node.executionRoleOrder = Math.min(node.executionRoleOrder ?? sequenceOrder + index, sequenceOrder + index);
        if (spec.target && spec.targetEdgeType && stableIdOf(node) !== stableIdOf(spec.target)) {
          relate(
            node,
            spec.targetEdgeType,
            spec.target,
            spec.targetLabel || spec.role,
            spec.targetFlowLayer || 'control',
          );
        }
        return node;
      }).filter((node): node is FlowNodeRow => Boolean(node));
      const axisNodes = (axisOrder
        ? axisOrder.map((entry) => typeof entry === 'number' ? created[entry] : entry)
        : created
      ).filter((node): node is FlowNodeRow => Boolean(
        node && stableIdOf(node) !== headerStableId
      ));
      axisNodes.forEach((node, index) => {
        node.labels = uniqueStrings([...node.labels, 'SubStepMember']);
        node.memberOfSubmethodStableId = headerStableId;
        node.submethodPlacement = 'axis';
        node.submethodMemberOrder = index;
        node.submethodRelativeColumn = 0;
        node.submethodRelativeRow = index + 1;
        node.executionProtocolStableId = rootStableId;
        node.executionProtocolKind = protocolKind;
      });
      const attachedNodes = attachments
        .map((attachment, index) => {
          const node = attachment.node;
          if (!node) return undefined;
          node.labels = uniqueStrings([...node.labels, 'SubStepAttachment']);
          node.memberOfSubmethodStableId = headerStableId;
          node.submethodPlacement = attachment.placement;
          node.submethodAnchorStableId = stableIdOf(attachment.anchor);
          node.submethodMemberOrder = axisNodes.length + index;
          node.submethodRelativeColumn = 1;
          node.submethodRelativeRow = Math.max(
            1,
            (attachment.anchor?.submethodRelativeRow ?? 0),
          );
          node.executionProtocolStableId = rootStableId;
          node.executionProtocolKind = protocolKind;
          return node;
        })
        .filter((node): node is FlowNodeRow => Boolean(node));
      if (connectAxis) {
        axisNodes.forEach((node, index) => {
          const previous = index === 0 ? header : axisNodes[index - 1];
          const previousStableId = stableIdOf(previous);
          const nodeStableId = stableIdOf(node);
          const alreadyConnected = Boolean(
            previousStableId
            && nodeStableId
            && outgoing(previousStableId).some((edge) => edge.toId === nodeStableId),
          );
          const previousBranches = Boolean(
            previousStableId
            && outgoing(previousStableId).some((edge) => edge.type === 'TRUE' || edge.type === 'FALSE'),
          );
          if (!alreadyConnected && !previousBranches) relate(previous, 'NEXT', node, '', 'control');
        });
      }
      const submethod = {
        stableId: headerStableId,
        parentStableId: parentSubmethodStableId || '',
        kind: submethodKind,
        role: columnRole,
        ownerStableId,
        headerStableId,
        memberStableIds: uniqueStrings(axisNodes.map(stableIdOf).filter((value): value is string => Boolean(value))),
        attachments: attachments
          .map((attachment) => ({
            stableId: stableIdOf(attachment.node),
            placement: attachment.placement,
            anchorStableId: stableIdOf(attachment.anchor),
          }))
          .filter((attachment) => attachment.stableId),
        order: sequenceOrder,
      };
      const existingSubmethods = (() => {
        try {
          return JSON.parse(root.submethodsJson || '[]') as typeof submethod[];
        } catch {
          return [];
        }
      })();
      root.submethodsJson = JSON.stringify([
        ...existingSubmethods.filter((candidate) => candidate.stableId !== headerStableId),
        submethod,
      ]);
      return { members: created, axisNodes, attachedNodes };
    };

    const forOfIterators = this.nodes.filter((node) => (
      node.primitiveKind === 'iterate'
      && node.executionScopeKind === 'collection-iterator'
      && node.collectionMethod === 'for-of'
    ));
    for (const iterator of forOfIterators) {
      const rootStableId = getStableIdKey(iterator.stableId);
      const protocolKind = 'collection-dispatch-effects';
      const loopHeader = from(rootStableId, 'ITERATES_VALUE');
      const source = from(rootStableId, 'READS_VALUE');
      const pull = this.nodes.find((node) => (
        hasLabel(node, 'Pull') && node.collectionLoopStableId === rootStableId
      ));
      const pulledCandidate = pull && through(getStableIdKey(pull.stableId), 'YIELDS_VALUE');
      const bind = pulledCandidate && through(getStableIdKey(pulledCandidate.stableId), 'ITEM_AVAILABLE');
      const item = bind && through(getStableIdKey(bind.stableId), 'EXTRACTS_VALUE');
      const exhausted = pull && through(getStableIdKey(pull.stableId), 'EXHAUSTED');
      const typePredicate = item && through(getStableIdKey(item.stableId), 'PASSES_VALUE');
      const alternativeHeader = (edgeType: Extract<FlowEdgeKind, 'TRUE' | 'FALSE'>) => (
        typePredicate
          ? outgoing(getStableIdKey(typePredicate.stableId), edgeType)
              .map((edge) => nodeById.get(edge.toId))
              .find((node) => hasLabel(node, 'Alternative') && node?.semanticExpansion === 'collection-iteration')
          : undefined
      );
      const imageHeader = alternativeHeader('TRUE');
      const textHeader = alternativeHeader('FALSE');
      const imageBranch = imageHeader && through(getStableIdKey(imageHeader.stableId), 'ENTERS');
      const textBranch = textHeader && through(getStableIdKey(textHeader.stableId), 'ENTERS');
      const stageChain = (body: FlowNodeRow | undefined) => {
        const stages: FlowNodeRow[] = [];
        let current = body && through(getStableIdKey(body.stableId), 'NEXT');
        while (current && hasLabel(current, 'SequenceStage') && stages.length < 20) {
          stages.push(current);
          current = through(getStableIdKey(current.stableId), 'NEXT');
        }
        return stages;
      };
      const imageStages = stageChain(imageBranch);
      const textStages = stageChain(textBranch);
      const resolveFamily = (
        prefix: string,
        stage: FlowNodeRow | undefined,
        fieldRoles: string[],
        assignment = false,
      ) => {
        if (!stage) return undefined;
        const object = through(getStableIdKey(stage.stableId), 'EMITS_EFFECT');
        if (!object) return undefined;
        const fields = outgoing(getStableIdKey(object.stableId), 'FIELD')
          .map((edge) => nodeById.get(edge.toId))
          .filter((node): node is FlowNodeRow => Boolean(node))
          .sort(byOperation);
        const complete = fields[0] && through(getStableIdKey(fields[0].stableId), 'FieldJoin');
        const assign = assignment && object
          ? through(getStableIdKey(object.stableId), 'ASSIGNS_VALUE')
          : undefined;
        const action = !assignment && complete
          ? through(getStableIdKey(complete.stableId), 'ArgJoin')
            || through(getStableIdKey(complete.stableId), 'ARG')
          : undefined;
        const actionProxy = action && through(getStableIdKey(action.stableId), 'INVOKES');
        const receiver = assignment
          ? assign
          : action && (
              (actionProxy && through(getStableIdKey(actionProxy.stableId), 'ON_RECEIVER'))
              || through(getStableIdKey(action.stableId), 'ON_RECEIVER')
              || through(getStableIdKey(action.stableId), 'READS_VALUE')
              || (action.valueSlotStableId
                ? nodeById.get(getStableIdKey(action.valueSlotStableId))
                : undefined)
            );
        register(rootStableId, protocolKind, `${prefix}Object`, object, 40);
        fieldRoles.forEach((role, index) => register(
          rootStableId,
          protocolKind,
          `${prefix}${role}`,
          fields[index],
          41 + index,
        ));
        register(
          rootStableId,
          protocolKind,
          prefix === 'source' ? 'sourceObjectComplete' : `${prefix}Complete`,
          complete,
          50,
        );
        register(rootStableId, protocolKind, assignment ? 'sourceAssign' : `${prefix}Push`, assignment ? assign : action, 51);
        register(rootStableId, protocolKind, assignment ? 'sourceTarget' : `${prefix}Receiver`, receiver, 52);
        return { stage, object, fields, complete, action: assignment ? assign : action, receiver };
      };
      const sourceFamily = resolveFamily('source', imageStages[0], ['TypeField', 'MediaField', 'DataField'], true);
      const imageContentFamily = resolveFamily('imageContent', imageStages[1], ['TypeField', 'SourceField']);
      const imageRemoteFamily = resolveFamily('imageRemote', imageStages[2], ['TypeField', 'SourceField']);
      const textContentFamily = resolveFamily('textContent', textStages[0], ['TypeField', 'TextField']);
      const textRemoteFamily = resolveFamily('textRemote', textStages[1], ['TypeField', 'TextField']);
      [
        ['loopHeader', loopHeader],
        ['iterator', iterator],
        ['source', source],
        ['pull', pull],
        ['pulledCandidate', pulledCandidate],
        ['bind', bind],
        ['item', item],
        ['exhausted', exhausted],
        ['typePredicate', typePredicate],
        ['imageHeader', imageHeader],
        ['imageBranch', imageBranch],
        ['textHeader', textHeader],
        ['textBranch', textBranch],
        ['sourceCreateStage', imageStages[0]],
        ['imageContentStage', imageStages[1]],
        ['imageRemoteStage', imageStages[2]],
        ['textContentStage', textStages[0]],
        ['textRemoteStage', textStages[1]],
      ].forEach(([role, node], index) => register(
        rootStableId,
        protocolKind,
        String(role),
        node as FlowNodeRow | undefined,
        index,
      ));

      removeRelations((edge) => (
        ['NEXT', 'PASSES_VALUE'].includes(edge.type)
        && edge.toId === stableIdOf(typePredicate)
        && [stableIdOf(loopHeader), stableIdOf(item)].includes(edge.fromId)
      ));
      relate(item || pulledCandidate, 'EVAL', pull, 'eval', 'control');
      materializeSubmethod({
        rootStableId,
        protocolKind,
        columnRole: 'iterator',
        header: loopHeader,
        ownerStableId: rootStableId,
        sequenceOrder: 70,
        members: [
          {
            role: 'pull next item',
            member: pull,
          },
          {
            role: 'receive next item',
            member: pulledCandidate,
          },
          {
            role: 'dispatch item',
            target: typePredicate,
            targetEdgeType: typePredicate ? 'DECIDES_VALUE' : undefined,
            targetLabel: 'dispatch',
          },
        ],
        axisOrder: [pull, pulledCandidate, typePredicate],
      });
      materializeSubmethod({
        rootStableId,
        protocolKind,
        columnRole: 'imageBranch',
        header: imageHeader,
        ownerStableId: stableIdOf(imageBranch),
        sequenceOrder: 80,
        parentSubmethodStableId: stableIdOf(loopHeader),
        members: [imageContentFamily, imageRemoteFamily].map((family, index) => ({
          role: `image action ${index + 1}`,
          target: family?.object,
          targetEdgeType: 'EMITS_EFFECT',
          targetLabel: 'effect',
        })),
        axisOrder: [sourceFamily?.receiver, 0, 1],
      });
      materializeSubmethod({
        rootStableId,
        protocolKind,
        columnRole: 'textBranch',
        header: textHeader,
        ownerStableId: stableIdOf(textBranch),
        sequenceOrder: 90,
        parentSubmethodStableId: stableIdOf(loopHeader),
        members: [textContentFamily, textRemoteFamily].map((family, index) => ({
          role: `text action ${index + 1}`,
          target: family?.object,
          targetEdgeType: 'EMITS_EFFECT',
          targetLabel: 'effect',
        })),
      });
      relate(sourceFamily?.receiver, 'EVAL', sourceFamily?.object, 'define source');
      [sourceFamily, imageContentFamily, imageRemoteFamily, textContentFamily, textRemoteFamily]
        .forEach((family) => {
          if (!family) return;
          const stageStableId = stableIdOf(family.stage);
          const objectStableId = stableIdOf(family.object);
          removeRelations((edge) => (
            edge.type === 'EMITS_EFFECT'
            && edge.fromId === stageStableId
            && edge.toId === objectStableId
          ));
        });
    }

    const stateUpdateRoots = this.nodes.filter((node) => hasLabel(node, 'StateUpdateRoot'));
    const functionTargetStableId = (call: FlowNodeRow | undefined) => {
      if (!call) return undefined;
      if (call.calleeStableId) return getStableIdKey(call.calleeStableId);
      const callStableId = getStableIdKey(call.stableId);
      const direct = outgoing(callStableId).find((edge) => (
        edge.toKind === 'Fn' && ['CALL', 'REQUEST', 'READ', 'WRITE'].includes(edge.type)
      ));
      if (direct) return direct.toId;
      const proxy = outgoing(callStableId, 'INVOKES')
        .map((edge) => nodeById.get(edge.toId))
        .find((node) => hasLabel(node, 'FnVisualProxy'));
      return proxy && outgoing(getStableIdKey(proxy.stableId))
        .find((edge) => edge.toKind === 'Fn' && ['CALL', 'REQUEST', 'READ', 'WRITE'].includes(edge.type))
        ?.toId;
    };
    const callOwningArgument = (argument: FlowNodeRow | undefined) => {
      if (!argument) return undefined;
      const argumentStableId = getStableIdKey(argument.stableId);
      const isCallStart = (node: FlowNodeRow | undefined) => Boolean(
        node
        && (hasLabel(node, 'Start') || hasLabel(node, 'Call') || hasLabel(node, 'Request')),
      );
      const direct = [
        ...incoming(argumentStableId, 'ARG').map((edge) => nodeById.get(edge.fromId)),
        ...outgoing(argumentStableId, 'ARG').map((edge) => nodeById.get(edge.toId)),
      ].find(isCallStart);
      if (direct) return direct;
      const proxy = outgoing(argumentStableId, 'ArgJoin')
        .map((edge) => nodeById.get(edge.toId))
        .find((node) => hasLabel(node, 'FnVisualProxy'));
      return proxy?.sourceCallStableId
        ? nodeById.get(getStableIdKey(proxy.sourceCallStableId))
        : undefined;
    };
    const callClosingProxy = (
      argument: FlowNodeRow | undefined,
      call: FlowNodeRow | undefined,
    ) => (argument
      ? outgoing(getStableIdKey(argument.stableId), 'ArgJoin')
          .map((edge) => nodeById.get(edge.toId))
          .find((node) => hasLabel(node, 'FnVisualProxy'))
      : undefined)
      || (call
        ? this.nodes.find((node) => (
            hasLabel(node, 'FnVisualProxy')
            && node.sourceCallStableId === getStableIdKey(call.stableId)
          ))
        : undefined);
    for (const root of stateUpdateRoots) {
      if (hasLabel(root, 'InlineArgumentFamily')) continue;
      const rootStableId = getStableIdKey(root.stableId);
      const protocolKind = 'state-update-with-callback-effect';
      const updater = root;
      const stepNodes = root.parentStepStableId
        ? this.nodes.filter((node) => node.parentStepStableId === root.parentStepStableId)
        : this.nodes.filter((node) => isContainedRange(node.stableId, root.stableId));
      const incrementCall = stepNodes
        .filter((node) => (
          node !== root
          && hasLabel(node, 'Start')
          && node.invocationMode !== 'asynchronous'
          && outgoing(getStableIdKey(node.stableId), 'ASYNC').length > 0
        ))
        .sort(byOperation)[0];
      const previousAttribution = incrementCall
        ? outgoing(getStableIdKey(incrementCall.stableId), 'ARG')
            .map((edge) => nodeById.get(edge.toId))
            .find(Boolean)
        : undefined;
      const incrementCallClose = callClosingProxy(previousAttribution, incrementCall);
      const incrementFunctionStableId = functionTargetStableId(incrementCall);
      const incrementValues = incrementFunctionStableId
        ? stepNodes
            .filter((node) => (
              node.sequenceOwnerStableId === incrementFunctionStableId
              && node.semanticExpansion === 'call-execution'
              && hasLabel(node, 'ValueSlot')
            ))
            .sort(byOperation)
        : [];
      const assignedStateField = stepNodes.find((node) => (
        node.semanticExpansion === 'state-update'
        && hasLabel(node, 'Field')
        && hasLabel(node, 'ValueSlot')
        && node.containerMethodKind === 'set'
      ));
      const newAttribution = assignedStateField || incrementValues[0];
      const snapshot = incrementValues.find((node) => node.diaName === 'snapshot')
        || incrementValues[1];
      const returnedAttribution = incrementValues.find((node) => hasLabel(node, 'Return'));
      const recordCall = incrementCall && outgoing(getStableIdKey(incrementCall.stableId), 'ASYNC')
        .map((edge) => nodeById.get(edge.toId))
        .find((node) => hasLabel(node, 'Start'));
      const recordSnapshotArgument = snapshot;
      const recordCallClose = callClosingProxy(recordSnapshotArgument, recordCall);
      const recordFunctionStableId = functionTargetStableId(recordCall);
      const sessionWrite = stepNodes
        .filter((node) => (
          hasLabel(node, 'EffectCall')
          && hasLabel(node, 'Write')
          && (!recordFunctionStableId || node.sequenceOwnerStableId === recordFunctionStableId)
        ))
        .sort(byOperation)[0];
      const persistSnapshotArgument = sessionWrite
        ? stepNodes.find((node) => (
            hasLabel(node, 'ArgumentOccurrence')
            && node.sequenceOwnerStableId === recordFunctionStableId
            && (node.bindingStableId === snapshot?.bindingStableId || node.diaName === 'snapshot')
          ))
        : undefined;
      const sessionStore = sessionWrite && hasLabel(sessionWrite, 'Storage')
        ? sessionWrite
        : sessionWrite && outgoing(getStableIdKey(sessionWrite.stableId), 'WRITES')
            .map((edge) => nodeById.get(edge.toId))
            .find(Boolean);
      const catchTarget = recordCall
        ? outgoing(getStableIdKey(recordCall.stableId), 'CATCH')
            .map((edge) => nodeById.get(edge.toId))
            .find(Boolean)
        : undefined;
      const caughtError = catchTarget && hasLabel(catchTarget, 'FailureBinding')
        ? catchTarget
        : undefined;
      const errorArgument = undefined;
      const directCatchHandler = catchTarget && (
        hasLabel(catchTarget, 'Start')
        || hasLabel(catchTarget, 'Call')
        || hasLabel(catchTarget, 'Request')
        || hasLabel(catchTarget, 'Op')
      ) ? catchTarget : undefined;
      const logCall = directCatchHandler || (caughtError ? (
        outgoing(getStableIdKey(caughtError.stableId), 'NEXT')
          .map((edge) => nodeById.get(edge.toId))
          .find((node) => hasLabel(node, 'Start'))
        || stepNodes
          .filter((node) => (
            (hasLabel(node, 'Start') || hasLabel(node, 'Call') || hasLabel(node, 'Request') || hasLabel(node, 'Op'))
            && (
              isContainedRange(node.stableId, caughtError.stableId)
              || (
                caughtError.sequenceOwnerStableId
                && node.sequenceOwnerStableId === caughtError.sequenceOwnerStableId
              )
            )
          ))
          .sort(byOperation)[0]
      ) : undefined);
      const logCallClose = callClosingProxy(errorArgument, logCall);
      const stateUpdateCallClose = callClosingProxy(updater, root);
      const nextState = this.nodes.find((node) => (
        node.sequenceOwnerStableId === rootStableId
        && hasLabel(node, 'StateValue')
        && hasLabel(node, 'Object')
      )) || stepNodes.find((node) => (
        node.sequenceOwnerStableId === rootStableId
        && hasLabel(node, 'StateValue')
        && hasLabel(node, 'Storage')
        && hasLabel(node, 'Write')
      )) || root;
      const stateObjectOpening = stepNodes.find((node) => (
        hasLabel(node, 'ObjectBrace')
        && hasLabel(node, 'Open')
        && node.objectBraceMosaicNeighborStableId === stableIdOf(nextState)
      ));
      if (
        stateObjectOpening
        && !outgoing(rootStableId).some((edge) => edge.toId === stableIdOf(stateObjectOpening))
      ) {
        const updaterBody = relate(root, 'EVAL', stateObjectOpening, 'updater result', 'control');
        if (updaterBody) updaterBody.semanticExpansion = 'state-update';
      }
      const fieldsOwner = stateObjectOpening || nextState;
      const fields = fieldsOwner
        ? outgoing(getStableIdKey(fieldsOwner.stableId), 'FIELD')
            .map((edge) => nodeById.get(edge.toId) || this.nodeByStableId(edge.toId))
            .filter((node): node is FlowNodeRow => Boolean(node))
            .sort(byOperation)
        : [];
      const nextStateComplete = fields[0]
        ? outgoing(getStableIdKey(fields[0].stableId), 'FieldJoin')
            .map((edge) => nodeById.get(edge.toId) || this.nodeByStableId(edge.toId))
            .find(Boolean)
        : undefined;
      const stateWrite = stepNodes.find((node) => (
        hasLabel(node, 'Write')
        && hasLabel(node, 'SemanticExpansion')
        && node.sequenceOwnerStableId === rootStableId
      )) || root;
      const stateWriteClose = stateWrite
        ? stepNodes.find((node) => (
            node.callMosaicOwnerStableId === stableIdOf(stateWrite)
            && node.callMosaicRole === 'close'
          ))
        : undefined;
      if (root.callBoundaryDesign === 'split' && stateWriteClose) {
        stateWriteClose.callBoundaryDesign = 'split';
        stateWriteClose.callBoundaryRole = 'close';
      }
      const appStateStore = stateWrite && hasLabel(stateWrite, 'Storage')
        ? stateWrite
        : stateWrite && outgoing(getStableIdKey(stateWrite.stableId), 'WRITES')
            .map((edge) => nodeById.get(edge.toId))
            .find(Boolean);
      const newAttributionFields = newAttribution
        ? outgoing(getStableIdKey(newAttribution.stableId), 'FIELD')
            .map((edge) => nodeById.get(edge.toId) || this.nodeByStableId(edge.toId))
            .filter((node): node is FlowNodeRow => Boolean(node))
            .sort(byOperation)
        : [];
      if (sessionWrite) {
        const sessionWriteStableId = stableIdOf(sessionWrite) || rootStableId;
        const snapshotSourceStableId = snapshot?.sourceStableId
          || persistSnapshotArgument?.sourceStableId
          || recordSnapshotArgument?.sourceStableId
          || sessionWrite.sourceStableId
          || sessionWriteStableId;
        sessionWrite.diaName = sessionStore?.diaName || sessionWrite.diaName || 'Session JSONL';
        sessionWrite.renderPartsLayout = 'container-overlay-side';
        sessionWrite.renderPrimaryPartIndex = 0;
        sessionWrite.renderPartsJson = JSON.stringify([
          {
            stableId: sessionWriteStableId,
            text: sessionStore?.diaName || sessionWrite.diaName || 'Session JSONL',
            kind: 'storage-container',
            labels: ['Store', 'Storage', 'ResourceProxy', 'External'],
            order: 0,
            sourceStableId: sessionStore?.sourceStableId || sessionWrite.sourceStableId || sessionWriteStableId,
          },
          {
            stableId: sessionWriteStableId,
            text: 'write(',
            kind: 'method',
            labels: ['Method', 'Write', 'ContainerMethod'],
            order: 1,
            sourceStableId: sessionWrite.sourceStableId || sessionWriteStableId,
          },
          {
            stableId: sessionWriteStableId,
            text: 'snapshot',
            kind: 'value',
            labels: ['Value', 'Arg'],
            order: 2,
            sourceStableId: snapshotSourceStableId,
          },
          {
            stableId: sessionWriteStableId,
            text: ')',
            kind: 'punctuation',
            labels: ['Arg'],
            order: 3,
            sourceStableId: sessionWrite.sourceStableId || sessionWriteStableId,
          },
        ] satisfies RenderPartDescriptor[]);
      }
      if (newAttribution) {
        const newAttributionStableId = stableIdOf(newAttribution) || rootStableId;
        if (newAttribution.fieldName) newAttribution.diaName = newAttribution.fieldName;
        newAttribution.labels = uniqueStrings([...newAttribution.labels, 'Virtual']);
        newAttribution.containerState = 'awaiting-assignment';
        newAttribution.containerMethodKind = 'set';
        newAttribution.renderPartsLayout = 'container-overlay';
        newAttribution.renderPartsJson = JSON.stringify([
          {
            stableId: newAttributionStableId,
            text: newAttribution.diaName || 'newAttribution',
            kind: 'value-container',
            labels: ['Value', 'ValueSlot', 'Virtual'],
            order: 0,
            fillState: 'empty',
            sourceStableId: newAttributionStableId,
          },
          {
            stableId: newAttributionStableId,
            text: 'set',
            kind: 'method',
            labels: ['Method', 'Assignment', 'ContainerMethod', 'Virtual'],
            order: 1,
            sourceStableId: newAttributionStableId,
          },
        ] satisfies RenderPartDescriptor[]);
      }
      removeRelations((edge) => (
        (edge.fromId === stableIdOf(newAttribution) && edge.toId === stableIdOf(incrementCall))
        || (edge.fromId === rootStableId && edge.toId === stableIdOf(newAttribution))
        || (edge.fromId === stableIdOf(incrementCall) && edge.toId === stableIdOf(newAttribution))
      ));
      relate(newAttribution, 'NEXT', incrementCall, '', 'control');
      const incrementReturn = relate(incrementCall, 'YIELDS_VALUE', newAttribution, 'value', 'data');
      if (incrementReturn) {
        incrementReturn.protocolRole = 'assignment-return';
      }
      if (sessionWrite && stableIdOf(recordCall) !== stableIdOf(sessionWrite)) {
        relate(recordCall, 'NEXT', sessionWrite, '', 'control');
      }
      relate(caughtError, 'NEXT', logCall, '', 'control');
      if (stableIdOf(newAttribution) !== stableIdOf(stateWrite)) {
        const closesThroughFieldFamily = Boolean(
          newAttribution
          && outgoing(stableIdOf(newAttribution), 'FieldJoin').length > 0
        );
        if (!closesThroughFieldFamily) relate(newAttribution, 'NEXT', stateWrite, '', 'control');
      }
      const nodeRoles: Array<[string, FlowNodeRow | undefined]> = [
        ['stateUpdateCall', root],
        ['stateUpdateCallClose', stateUpdateCallClose],
        ['stateUpdater', updater],
        ['previousAttribution', previousAttribution],
        ['incrementCall', incrementCall],
        ['incrementCallClose', incrementCallClose],
        ['newAttribution', newAttribution],
        ['attributionSpread', newAttributionFields[0]],
        ['promptCount', newAttributionFields[1]],
        ['returnedAttribution', returnedAttribution],
        ['recordCall', recordCall],
        ['recordCallClose', recordCallClose],
        ['sessionWrite', sessionWrite],
        ['sessionStore', sessionStore],
        ['caughtError', caughtError],
        ['errorArgument', errorArgument],
        ['logCall', logCall],
        ['logCallClose', logCallClose],
        ['nextState', nextState],
        ['previousStateField', fields[0]],
        ['attributionField', fields[1]],
        ['nextStateComplete', nextStateComplete],
        ['stateWrite', stateWrite],
        ['stateWriteClose', stateWriteClose],
        ['appStateStore', appStateStore],
      ];
      nodeRoles.forEach(([role, node], index) => register(
        rootStableId,
        protocolKind,
        role,
        node,
        index,
      ));
      registerStableId(rootStableId, protocolKind, 'incrementFunction', incrementFunctionStableId, 50, 'Fn');
      registerStableId(rootStableId, protocolKind, 'recordFunction', recordFunctionStableId, 51, 'Fn');
      materializeSubmethod({
        rootStableId,
        protocolKind,
        columnRole: 'state',
        header: root,
        ownerStableId: stableIdOf(updater),
        sequenceOrder: 60,
        submethodKind: 'function-callback',
        members: [
          {
            role: 'invoke updater callback',
            target: incrementCall,
            targetEdgeType: incrementCall ? 'MATERIALIZES_ARGUMENT' : undefined,
            targetLabel: 'callback',
          },
          {
            role: 'accept updater result',
            target: stateWrite,
            targetEdgeType: stateWrite ? 'MATERIALIZES_ARGUMENT' : undefined,
            targetLabel: 'state',
          },
        ],
        axisOrder: stableIdOf(stateWrite) === rootStableId
          ? [newAttribution]
          : [newAttribution, stateWrite],
        attachments: [
          ...(stableIdOf(nextState) !== stableIdOf(stateWrite)
            ? [{ node: nextState, placement: 'right' as const, anchor: stateWrite }]
            : []),
          ...(appStateStore && stableIdOf(appStateStore) !== stableIdOf(stateWrite)
            ? [{ node: appStateStore, placement: 'overlay' as const, anchor: stateWrite }]
            : []),
        ],
        connectAxis: false,
      });
      materializeSubmethod({
        rootStableId,
        protocolKind,
        columnRole: 'increment',
        header: incrementCall,
        ownerStableId: incrementFunctionStableId,
        sequenceOrder: 70,
        parentSubmethodStableId: rootStableId,
        submethodKind: 'function-callback',
        members: [
          {
            role: 'dispatch snapshot callback',
            target: recordCall,
            targetEdgeType: recordCall ? 'MATERIALIZES_ARGUMENT' : undefined,
            targetLabel: 'callback',
          },
        ],
        axisOrder: [],
        attachments: [
          { node: previousAttribution, placement: 'right', anchor: incrementCall },
          { node: incrementCallClose, placement: 'right', anchor: incrementCall },
        ],
      });
      materializeSubmethod({
        rootStableId,
        protocolKind,
        columnRole: 'record',
        header: recordCall,
        ownerStableId: recordFunctionStableId,
        sequenceOrder: 80,
        parentSubmethodStableId: stableIdOf(incrementCall),
        submethodKind: 'function-callback',
        members: [],
        axisOrder: [logCall],
        attachments: [
          { node: recordCallClose, placement: 'right', anchor: recordCall },
          { node: logCallClose, placement: 'right', anchor: logCall },
          ...(sessionStore && stableIdOf(sessionStore) !== stableIdOf(sessionWrite)
            ? [{ node: sessionStore, placement: 'overlay' as const, anchor: sessionWrite }]
            : []),
        ],
      });
      materializeSubmethod({
        rootStableId,
        protocolKind,
        columnRole: 'catch',
        header: caughtError,
        ownerStableId: stableIdOf(caughtError),
        sequenceOrder: 90,
        parentSubmethodStableId: stableIdOf(recordCall),
        submethodKind: 'catch',
        members: [{
          role: 'handle persistence failure',
          target: logCall,
          targetEdgeType: logCall ? 'MATERIALIZES_ARGUMENT' : undefined,
          targetLabel: 'error',
        }],
        axisOrder: [logCall],
        attachments: [
          { node: errorArgument, placement: 'right', anchor: logCall },
          { node: logCallClose, placement: 'right', anchor: logCall },
        ],
      });
    }

    const callbackArguments = this.nodes.filter((node) => hasLabel(node, 'CallbackFn'));
    const callbackOwnerByArgument = new Map<string, FlowNodeRow>();
    for (const callback of callbackArguments) {
      const callbackStableId = stableIdOf(callback);
      if (!callbackStableId) continue;
      const owner = incoming(callbackStableId)
        .filter((edge) => edge.type === 'ARG' || edge.type === 'MATERIALIZES_ARGUMENT')
        .map((edge) => nodeById.get(edge.fromId))
        .find((node) => node && (
          hasLabel(node, 'Call')
          || hasLabel(node, 'Request')
          || hasLabel(node, 'Op')
          || hasLabel(node, 'Method')
        ));
      if (owner) callbackOwnerByArgument.set(callbackStableId, owner);
    }
    const sourceContains = (container: FlowNodeRow, child: FlowNodeRow) => (
      isContainedRange(child.stableId, container.stableId)
    );
    const parentCallFor = (call: FlowNodeRow) => {
      const sequenceOwner = call.sequenceOwnerStableId;
      const explicitParent = sequenceOwner ? callbackOwnerByArgument.get(sequenceOwner) : undefined;
      const callParentFnStableId = call.parentFnStableId
        ? getStableIdKey(call.parentFnStableId)
        : undefined;
      const explicitCallback = sequenceOwner ? nodeById.get(sequenceOwner) : undefined;
      if (
        explicitParent
        && explicitCallback
        && stableIdOf(explicitParent) !== stableIdOf(call)
        && sourceContains(explicitCallback, call)
        && sourceContains(explicitParent, call)
        && (!callParentFnStableId || !explicitParent.parentFnStableId
          || getStableIdKey(explicitParent.parentFnStableId) === callParentFnStableId)
      ) return explicitParent;
      const containing = callbackArguments
        .map((callback) => ({
          callback,
          parent: callbackOwnerByArgument.get(stableIdOf(callback) || ''),
        }))
        .filter(({ callback, parent }) => (
          Boolean(parent)
          && sourceContains(callback, call)
          && sourceContains(parent as FlowNodeRow, call)
          && stableIdOf(parent) !== stableIdOf(call)
          && (!callParentFnStableId || !callback.parentFnStableId
            || getStableIdKey(callback.parentFnStableId) === callParentFnStableId)
        ))
        .sort((left, right) => {
          return rangeSpan(left.callback) - rangeSpan(right.callback)
            || byOperation(left.callback, right.callback);
        })[0];
      return containing?.parent;
    };
    const rootCallFor = (call: FlowNodeRow) => {
      let current = call;
      const visited = new Set<string>();
      while (true) {
        const currentStableId = stableIdOf(current);
        if (!currentStableId || visited.has(currentStableId)) return current;
        visited.add(currentStableId);
        const parent = parentCallFor(current);
        if (!parent) return current;
        current = parent;
      }
    };
    const receiverCallForCatch = (call: FlowNodeRow) => {
      const calleeText = String(call.operationCalleeText || call.diaName || '');
      const catchIndex = calleeText.lastIndexOf('.catch');
      if (catchIndex < 0) return undefined;
      const receiverName = calleeText.slice(0, catchIndex).replace(/\s*\(.*$/su, '').trim();
      return this.nodes
        .filter((candidate) => (
          candidate !== call
          && candidate.parentStepStableId === call.parentStepStableId
          && candidate.stableId.startLine === call.stableId.startLine
          && candidate.stableId.startColumn === call.stableId.startColumn
          && String(candidate.operationCalleeText || '').trim() === receiverName
          && (hasLabel(candidate, 'Call') || hasLabel(candidate, 'Request') || hasLabel(candidate, 'Op'))
        ))
        .sort((left, right) => (
          (right.stableId.endLine ?? 0) - (left.stableId.endLine ?? 0)
          || (right.stableId.endColumn ?? 0) - (left.stableId.endColumn ?? 0)
        ))[0];
    };
    const closestContainingSubmethod = (call: FlowNodeRow) => {
      const callParentFnStableId = call.parentFnStableId
        ? getStableIdKey(call.parentFnStableId)
        : undefined;
      return this.nodes
        .filter((candidate) => (
          candidate !== call
          && hasLabel(candidate, 'SubStep')
          && sourceContains(candidate, call)
          && stableIdOf(candidate) !== stableIdOf(call)
          && (!callParentFnStableId || !candidate.parentFnStableId
            || getStableIdKey(candidate.parentFnStableId) === callParentFnStableId)
        ))
        .sort((left, right) => rangeSpan(left) - rangeSpan(right) || byOperation(left, right))[0];
    };
    const hierarchyRootFor = (node: FlowNodeRow) => {
      let current = node;
      const visited = new Set<string>();
      while (current.parentSubmethodStableId) {
        const currentStableId = stableIdOf(current);
        if (!currentStableId || visited.has(currentStableId)) break;
        visited.add(currentStableId);
        const parent = nodeById.get(current.parentSubmethodStableId);
        if (!parent) break;
        current = parent;
      }
      return current;
    };
    for (const callback of callbackArguments.sort(byOperation)) {
      const callbackStableId = stableIdOf(callback);
      const owner = callbackStableId ? callbackOwnerByArgument.get(callbackStableId) : undefined;
      if (
        !callbackStableId
        || !owner
        || callback.collectionLoopStableId
        || hasLabel(owner, 'InlineArgumentFamily')
      ) continue;
      const ownerStableId = stableIdOf(owner);
      if (!ownerStableId || owner.submethodStableId) continue;
      const reachableMemberIds = new Set<string>();
      const pendingMemberIds = [callbackStableId];
      while (pendingMemberIds.length) {
        const currentStableId = pendingMemberIds.shift();
        if (!currentStableId) continue;
        for (const edge of outgoing(currentStableId).filter((candidate) => (
          ['ARROW', 'NEXT', 'TRUE', 'FALSE', 'RESULT'].includes(candidate.type)
        ))) {
          const member = nodeById.get(edge.toId);
          if (!member || member.parentStepStableId !== owner.parentStepStableId) continue;
          if (reachableMemberIds.has(edge.toId)) continue;
          reachableMemberIds.add(edge.toId);
          pendingMemberIds.push(edge.toId);
        }
      }
      const callbackMembers = this.nodes
        .filter((node) => (
          node.sequenceOwnerStableId === callbackStableId
          || reachableMemberIds.has(getStableIdKey(node.stableId))
        ))
        .sort(byOperation);
      const calleeText = String(owner.operationCalleeText || owner.diaName || '');
      const memberNames = [...calleeText.matchAll(/\.([A-Za-z_$][\w$]*)\s*(?=\(|$)/gu)];
      const methodName = memberNames.at(-1)?.[1]
        || calleeText.match(/^\s*([A-Za-z_$][\w$]*)/u)?.[1]
        || '';
      const catchReceiver = methodName === 'catch' ? receiverCallForCatch(owner) : undefined;
      const parentCall = catchReceiver
        ? (closestContainingSubmethod(catchReceiver) || parentCallFor(catchReceiver))
        : parentCallFor(owner);
      const rootCall = hierarchyRootFor(parentCall || rootCallFor(owner));
      const rootStableId = stableIdOf(rootCall);
      if (!rootStableId) continue;
      if (catchReceiver && !catchReceiver.submethodStableId) {
        const catchReceiverStableId = getStableIdKey(catchReceiver.stableId);
        const receiverMembers = this.nodes
          .filter((node) => (
            getStableIdKey(node.stableId).startsWith(`${catchReceiverStableId}:execution:`)
            && node.parentStepStableId === catchReceiver.parentStepStableId
          ))
          .sort(byOperation);
        materializeSubmethod({
          rootStableId,
          protocolKind: 'function-callback',
          columnRole: 'function',
          header: catchReceiver,
          ownerStableId: catchReceiver.calleeStableId
            ? getStableIdKey(catchReceiver.calleeStableId)
            : catchReceiverStableId,
          parentSubmethodStableId: stableIdOf(parentCall),
          submethodKind: 'function-callback',
          sequenceOrder: catchReceiver.operationIndex ?? owner.operationIndex ?? 100,
          members: receiverMembers.map((member, index) => ({
            role: `function event ${index + 1}`,
            member,
          })),
          axisOrder: receiverMembers,
          connectAxis: false,
        });
      }
      materializeSubmethod({
        rootStableId,
        protocolKind: 'function-callback',
        columnRole: methodName === 'catch' ? 'catch' : 'callback',
        header: owner,
        ownerStableId: owner.calleeStableId ? getStableIdKey(owner.calleeStableId) : ownerStableId,
        parentSubmethodStableId: stableIdOf(catchReceiver || parentCall),
        submethodKind: methodName === 'catch' ? 'catch' : 'function-callback',
        sequenceOrder: owner.operationIndex ?? 100,
        members: [
          { role: 'callback parameter', member: callback },
          ...callbackMembers.map((member, index) => ({
            role: `callback event ${index + 1}`,
            member,
          })),
        ],
        axisOrder: [callback, ...callbackMembers],
        connectAxis: false,
      });
    }

    for (const failure of this.nodes.filter((node) => node.labels.includes('FailureBinding'))) {
      const failureStableId = getStableIdKey(failure.stableId);
      const handler = this.nodes
        .filter((node) => node.memberOfSubmethodStableId === failureStableId)
        .sort((left, right) => (
          (left.submethodMemberOrder ?? Number.MAX_SAFE_INTEGER)
          - (right.submethodMemberOrder ?? Number.MAX_SAFE_INTEGER)
          || (left.operationIndex ?? Number.MAX_SAFE_INTEGER)
          - (right.operationIndex ?? Number.MAX_SAFE_INTEGER)
        ))[0];
      if (!handler) continue;
      const handlerStableId = getStableIdKey(handler.stableId);
      if (this.edges.some((edge) => (
        edge.fromId === failureStableId
        && edge.type === 'NEXT'
        && edge.toId === handlerStableId
      ))) continue;
      this.addEdge(undefined, failureStableId, undefined, handlerStableId, 'NEXT', {
        label: '',
        flowLayer: 'control',
        semanticExpansion: 'execution-protocol',
      });
    }
  }

  private connectPendingToNode(pending: PendingExit[], targetNodeId: string) {
    for (const exit of pending) {
      this.addEdge(exit.fromKind, exit.fromId, undefined, targetNodeId, exit.edgeType, {
        label: exit.label,
        mainFlow: exit.mainFlow,
        argumentName: exit.argumentName,
        argumentIndex: exit.argumentIndex,
        fieldName: exit.fieldName,
        fieldIndex: exit.fieldIndex,
        sourceRenderPartStableId: exit.sourceRenderPartStableId,
        targetRenderPartStableId: exit.targetRenderPartStableId,
        elseIfChainBypass: exit.elseIfChainBypass,
      });
    }
  }

  private connectPendingToJoin(pending: PendingExit[], targetNodeId: string, joinKind: 'FlowJoin' | 'ArgJoin' | 'FieldJoin' | 'OperandJoin') {
    for (const exit of pending) {
      const edgeType = joinKind === 'FlowJoin' && exit.edgeType === 'NEXT' && !exit.mainFlow
        ? 'REJOINS'
        : exit.edgeType;
      this.addEdge(exit.fromKind, exit.fromId, undefined, targetNodeId, edgeType, {
        label: exit.label,
        mainFlow: exit.mainFlow,
        argumentName: exit.argumentName,
        argumentIndex: exit.argumentIndex,
        fieldName: exit.fieldName,
        fieldIndex: exit.fieldIndex,
        sourceRenderPartStableId: exit.sourceRenderPartStableId,
        targetRenderPartStableId: exit.targetRenderPartStableId,
        elseIfChainBypass: exit.elseIfChainBypass,
      });
    }
  }

  private connectPendingToFn(pending: PendingExit[]) {
    for (const exit of pending) {
      this.addEdge(exit.fromKind, exit.fromId, 'Fn', this.fnStableId, exit.edgeType, {
        label: exit.label,
        sourceRenderPartStableId: exit.sourceRenderPartStableId,
        targetRenderPartStableId: exit.targetRenderPartStableId,
      });
    }
  }

  private hasBranchingIncomingExits(incomingExits: PendingExit[]) {
    return incomingExits.some((exit) => exit.edgeType !== 'NEXT');
  }

  private createActionNodeFromStatements(
    statements: ts.Statement[],
    incomingExits: PendingExit[],
    overrideLabel?: string,
    extra: FlowNodeExtra = {},
  ) {
    const firstStatement = statements[0];
    const lastStatement = statements[statements.length - 1];
    const actionAnchor = ts.isExpressionStatement(firstStatement)
      && ts.isAwaitExpression(firstStatement.expression)
      ? firstStatement.expression
      : firstStatement;
    let rawText = this.sourceFile.text.slice(actionAnchor.getStart(this.sourceFile), lastStatement.getEnd());
    if (
      overrideLabel === 'return'
      && statements.length === 1
      && ts.isReturnStatement(firstStatement)
      && firstStatement.expression
      && !rawText.trimStart().startsWith('return')
    ) {
      rawText = `return ${firstStatement.expression.getText(this.sourceFile)};`;
    }
    const label = overrideLabel || 'action';
    const rawStableId = getExtendedStableId(
      this.sourceFile,
      actionAnchor,
      getRange(this.sourceFile, lastStatement).endLine,
      getRange(this.sourceFile, lastStatement).endColumn,
    );
    const stableId = this.incomingHasHorizontalOwner(incomingExits) ? this.withHorizontalOwnerStableId(rawStableId) : rawStableId;
    const semanticLabels = statements.length === 1
      ? this.semanticStatementLabels(firstStatement, extra.labels || [])
      : extra.labels;
    const createdStableId = this.createNode('Action', label, firstStatement, {
      actionTextRaw: rawText,
      ...extra,
      labels: semanticLabels,
      uiSlotName: semanticLabels?.includes('UiInjection') ? 'jsx' : extra.uiSlotName,
    }, stableId);
    this.registerFirstNode(createdStableId, incomingExits);
    this.connectPendingToNode(incomingExits, createdStableId);
    return {
      stableId: createdStableId,
    };
  }

  private createActionNodeFromExpression(expression: ts.Expression, incomingExits: PendingExit[], overrideLabel?: string, extra: FlowNodeExtra = {}) {
    const label = overrideLabel || 'action';
    const rawStableId = getExtendedStableId(this.sourceFile, expression);
    const stableId = this.incomingHasHorizontalOwner(incomingExits) ? this.withHorizontalOwnerStableId(rawStableId) : rawStableId;
    const literalExpression = isLiteralInlineCallArgument(unwrapExpression(expression));
    const effectiveExtra = literalExpression
      ? { ...extra, labels: uniqueStrings([...(extra.labels || []), 'Value', 'Literal']) }
      : extra;
    const kind: FlowNodeKind = effectiveExtra.labels?.includes('Literal')
      ? 'Value'
      : effectiveExtra.labels?.includes('Read')
      ? 'Read'
      : effectiveExtra.labels?.includes('Write')
        ? 'Write'
      : effectiveExtra.labels?.includes('Op') && !effectiveExtra.labels?.includes('Request')
        ? 'Op'
        : 'Action';
    const createdStableId = this.createNode(kind, label, expression, {
      ...effectiveExtra,
      actionTextRaw: expression.getText(this.sourceFile),
    }, stableId);
    this.registerFirstNode(createdStableId, incomingExits);
    this.connectPendingToNode(incomingExits, createdStableId);
    return {
      stableId: createdStableId,
    };
  }

  private hasStructuredMemberAccess(expression: ts.Expression) {
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (isPropertyAccessLikeExpression(node as ts.Expression) || ts.isElementAccessExpression(node)) {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(unwrapExpression(expression));
    return found;
  }

  private materializeStructuredExpressionNode(expression: ts.Expression, incomingExits: PendingExit[]) {
    const current = unwrapExpression(expression);
    const calls = collectCallExpressions(current);
    const rootCallHasStructuredArgument = ts.isCallExpression(current)
      && current.arguments.some((argument) => isStructuredControlExpression(argument));
    const ownsExtractedSubmethod = calls.some((call) => call.arguments.some((argument, index) => (
      isFunctionArgumentExpression(argument)
      || this.callArgumentIsExtractedAsSubmethod(call, argument, index)
    )));
    if (
      !this.hasStructuredMemberAccess(current)
      || rootCallHasStructuredArgument
      || ownsExtractedSubmethod
      || calls.some((call) => this.callBoundaryDesign(call) === 'split')
    ) {
      return undefined;
    }
    const created = this.createActionNodeFromExpression(current, incomingExits, 'expression', {
      labels: uniqueStrings([
        'Op',
        'ValueAccess',
        ...(calls.length ? ['Call'] : []),
        ...(calls.some((call) => this.getCallRole(call, this.resolveRenderableCallTarget(call)) === 'Request') ? ['Request'] : []),
      ]),
      diaName: current.getText(this.sourceFile),
      operationCode: calls.length ? 'member-call-expression' : 'member-access-expression',
      operationSubjectText: current.getText(this.sourceFile),
      flowLayer: calls.length ? 'mixed' : 'data',
      dataFlowRole: calls.length ? 'operation' : 'input',
    });
    for (const call of calls) {
      const target = this.resolveRenderableCallTarget(call);
      this.addCallEdges(created.stableId, call, target);
    }
    return {
      firstNodeId: created.stableId,
      pending: [this.createPendingExit(undefined, created.stableId, 'NEXT')],
    };
  }

  private materializeExpressionCallSteps(callExpressions: ts.CallExpression[], incomingExits: PendingExit[]) {
    let firstNodeId: string | undefined;
    let pending = [...incomingExits];

    for (const callExpression of callExpressions) {
      const target = this.resolveCallTarget(callExpression);
      const callRoleLabel = this.getCallRole(callExpression, target);
      const callNode = this.createActionNodeFromExpression(callExpression, pending, undefined, {
        labels: this.semanticCallSiteLabels(callExpression, [callRoleLabel]),
        uiSlotName: this.isUiInjectionCall(callExpression) ? (getCallLikeName(callExpression.expression) || 'ui') : undefined,
        ...this.buildReactStateUpdateExtra(callExpression),
      });
      const callId = callNode.stableId;
      if (!firstNodeId) {
        firstNodeId = callId;
      }

      if (isCallableGraphTarget(target)) {
        this.addCallEdges(callId, callExpression, target, { edgeType: 'REQUEST' });
      }

      const callbackResult = this.materializeImmediateCallbackBodies(
        callExpression,
        [this.createPendingExit(undefined, callId, 'NEXT')],
      );
      pending = callbackResult.firstNodeId
        ? callbackResult.pending
        : [this.createPendingExit(undefined, callId, 'NEXT')];
    }

    return {
      firstNodeId,
      pending,
    };
  }

  private materializeExpressionSteps(expressions: ts.Expression[], incomingExits: PendingExit[]) {
    let firstNodeId: string | undefined;
    let pending = [...incomingExits];
    const callableArgumentRanges = expressions
      .filter((expression): expression is ts.CallExpression => {
        if (!ts.isCallExpression(expression) || !expression.arguments.length) {
          return false;
        }
        return this.shouldMaterializeCallArguments(expression, this.resolveCallTarget(expression));
      })
      .flatMap((callExpression) => callExpression.arguments.map((argument) => ({
        start: argument.getStart(this.sourceFile),
        end: argument.getEnd(),
        callStart: callExpression.getStart(this.sourceFile),
        callEnd: callExpression.getEnd(),
      })));
    const materializedExpressions = callableArgumentRanges.length
      ? expressions.filter((expression) => {
          const start = expression.getStart(this.sourceFile);
          const end = expression.getEnd();
          return !callableArgumentRanges.some((range) => {
            const isOwningCall = start === range.callStart && end === range.callEnd;
            return !isOwningCall
              && start >= range.start
              && end <= range.end;
          });
        })
      : expressions;

    for (const expression of materializedExpressions) {
      if (isStructuredControlExpression(expression)) {
        const structuredResult = this.materializeExpressionValue(expression, pending, true);
        if (!firstNodeId && structuredResult.firstNodeId) {
          firstNodeId = structuredResult.firstNodeId;
        }
        pending = structuredResult.pending;
        continue;
      }

      if (ts.isCallExpression(expression)) {
        const callResult = this.materializeCallExpressionWithArgumentChain(expression, pending);
        if (!firstNodeId && callResult.firstNodeId) {
          firstNodeId = callResult.firstNodeId;
        }
        pending = callResult.pending;
        continue;
      }

      const expressionNode = this.createActionNodeFromExpression(
        expression,
        pending,
        undefined,
        ts.isCallExpression(expression)
          ? {
              labels: this.semanticCallSiteLabels(expression, [this.getCallRole(expression, this.resolveCallTarget(expression))]),
              uiSlotName: this.isUiInjectionCall(expression) ? (getCallLikeName(expression.expression) || 'ui') : undefined,
              ...this.buildReactStateUpdateExtra(expression),
            }
          : {},
      );
      const expressionId = expressionNode.stableId;
      if (!firstNodeId) {
        firstNodeId = expressionId;
      }

      if (ts.isCallExpression(expression)) {
        const target = this.resolveCallTarget(expression);
        if (isCallableGraphTarget(target)) {
          this.addCallEdges(expressionId, expression, target, { edgeType: 'REQUEST' });
        }

        const callbackResult = this.materializeImmediateCallbackBodies(
          expression,
          [this.createPendingExit(undefined, expressionId, 'NEXT')],
        );
        pending = callbackResult.firstNodeId
          ? callbackResult.pending
          : [this.createPendingExit(undefined, expressionId, 'NEXT')];
        continue;
      }

      pending = [this.createPendingExit(undefined, expressionId, 'NEXT')];
    }

    return {
      firstNodeId,
      pending,
    };
  }

  private createFallbackActionNode(labelText: string, anchor: ts.Node, incomingExits: PendingExit[]) {
    return this.createActionNodeFromStatements([anchor as ts.Statement], incomingExits, labelText);
  }

  private getImmediateCallbackCarrierExpression(node: ts.Node) {
    if (ts.isReturnStatement(node)) {
      return node.expression;
    }

    if (ts.isExpressionStatement(node)) {
      return node.expression;
    }

    if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1) {
      return node.declarationList.declarations[0].initializer;
    }

    return undefined;
  }

  private getImmediatePromiseExecutor(expression: ts.Expression | undefined) {
    if (!expression) {
      return undefined;
    }

    let current = unwrapExpression(expression);
    while (ts.isAwaitExpression(current)) {
      current = unwrapExpression(current.expression);
    }

    if (!ts.isNewExpression(current) || !ts.isIdentifier(current.expression) || current.expression.text !== 'Promise') {
      return undefined;
    }

    const [executor] = current.arguments || [];
    if (!executor || (!ts.isArrowFunction(executor) && !ts.isFunctionExpression(executor))) {
      return undefined;
    }

    return executor;
  }

  private collectImmediateCallbackFunctions(expression: ts.Expression | undefined) {
    const callbacks: ImmediateCallbackMaterializationTarget[] = [];

    const executor = this.getImmediatePromiseExecutor(expression);
    if (executor) {
      callbacks.push({
        callback: executor,
        callbackStableId: this.stableIdByDeclaration.get(executor),
        allowLocalReturn: false,
      });
    }

    if (!expression) {
      return callbacks;
    }

    const current = unwrapAwaitedExpression(expression);
    if (!ts.isCallExpression(current)) {
      return callbacks;
    }

    const target = this.resolveCallTarget(current);
    if (!this.shouldMaterializeInlineCallbackArguments(current, target)) {
      return callbacks;
    }

    for (const argument of current.arguments) {
      const unwrappedArgument = ts.isExpression(argument)
        ? unwrapExpression(argument)
        : undefined;
      if (
        unwrappedArgument
        && (ts.isArrowFunction(unwrappedArgument) || ts.isFunctionExpression(unwrappedArgument))
        && !callbacks.some((entry) => entry.callback === unwrappedArgument)
      ) {
        callbacks.push({
          callback: unwrappedArgument,
          callbackStableId: this.stableIdByDeclaration.get(unwrappedArgument),
          allowLocalReturn: true,
        });
      }
    }

    return callbacks;
  }

  private shouldMaterializeInlineCallbackArguments(
    callExpression: ts.CallExpression,
    target: ResolvedCallTarget | undefined,
  ) {
    const calleeName = target?.name || getCallLikeName(unwrapExpression(callExpression.expression) as ts.LeftHandSideExpression);
    if (!calleeName) {
      return false;
    }

    return calleeName === 'withStreamingVCR'
      || calleeName === 'withVCR'
      || calleeName === 'withRetry'
      || calleeName.startsWith('with');
  }

  private materializeImmediateCallbackBlock(
    statements: readonly ts.Statement[],
    incomingExits: PendingExit[],
  ) {
    let firstNodeId: string | undefined;
    let pending = [...incomingExits];

    for (const statement of statements) {
      if (ts.isReturnStatement(statement)) {
        if (statement.expression) {
          const result = this.materializeExpressionValue(statement.expression, pending, true);
          if (!firstNodeId && result.firstNodeId) {
            firstNodeId = result.firstNodeId;
          }
          pending = result.pending;
        }
        break;
      }

      const result = this.buildStatement(statement, pending, { hasLocalCatch: false });
      if (!firstNodeId && result.firstNodeId) {
        firstNodeId = result.firstNodeId;
      }
      pending = result.openExits;
    }

    return {
      firstNodeId,
      pending,
    };
  }

  private materializeImmediateCallbackBody(target: ImmediateCallbackMaterializationTarget, incomingExits: PendingExit[]) {
    return this.runInNestedFunctionFlow(() => {
      const callbackReturns: PendingExit[] = [];
      this.callbackReturnExitCollectors.push(callbackReturns);
      try {
        const result = this.materializeImmediateCallbackBodyCore(target, incomingExits);
        const pendingBySource = new Map<string, PendingExit>();
        [...result.pending, ...callbackReturns].forEach((exit) => {
          pendingBySource.set(`${exit.fromKind || ''}:${exit.fromId}`, exit);
        });
        return {
          ...result,
          pending: [...pendingBySource.values()],
        };
      } finally {
        this.callbackReturnExitCollectors.pop();
      }
    });
  }

  private captureCallbackReturn(returnNodeId: string) {
    this.callbackReturnExitCollectors.at(-1)?.push(this.createPendingExit(undefined, returnNodeId, 'RESULT', 'result'));
  }

  private materializeImmediateCallbackBodyCore(target: ImmediateCallbackMaterializationTarget, incomingExits: PendingExit[]) {
    const { callback, allowLocalReturn } = target;

    if (ts.isBlock(callback.body)) {
      if (hasUnsupportedImmediateCallbackControlFlow(callback.body, { allowReturn: allowLocalReturn })) {
        return {
          firstNodeId: undefined,
          pending: incomingExits,
        };
      }

      const nestedResult = allowLocalReturn
        ? this.materializeImmediateCallbackBlock([...callback.body.statements], incomingExits)
        : this.buildBlock([...callback.body.statements], incomingExits, { hasLocalCatch: false });
      return {
        firstNodeId: nestedResult.firstNodeId,
        pending: 'openExits' in nestedResult ? nestedResult.openExits : nestedResult.pending,
      };
    }

    if (!callback.body || !ts.isExpression(callback.body)) {
      return {
        firstNodeId: undefined,
        pending: incomingExits,
      };
    }

    const callbackExpression = unwrapExpression(callback.body);
    if (target.callbackKind === 'updater' && ts.isArrayLiteralExpression(callbackExpression)) {
      return {
        firstNodeId: undefined,
        pending: incomingExits,
      };
    }
    if (target.callbackKind === 'updater' && ts.isObjectLiteralExpression(callbackExpression)) {
      let firstNodeId: string | undefined;
      let pending = [...incomingExits];
      for (const property of callbackExpression.properties) {
        const value = ts.isPropertyAssignment(property)
          ? property.initializer
          : ts.isSpreadAssignment(property)
            ? property.expression
            : undefined;
        if (!value || collectCallExpressions(value).length === 0) continue;
        const result = this.materializeExpressionValue(value, pending, true);
        if (!firstNodeId) firstNodeId = result.firstNodeId;
        pending = result.pending;
      }
      return { firstNodeId, pending };
    }

    const nestedResult = this.materializeExpressionValue(callback.body, incomingExits, true);
    return {
      firstNodeId: nestedResult.firstNodeId,
      pending: nestedResult.pending,
    };
  }

  private materializeImmediateCallbackBodies(expression: ts.Expression | undefined, incomingExits: PendingExit[]) {
    const callbacks = this.collectImmediateCallbackFunctions(expression);
    if (!callbacks.length) {
      return {
        firstNodeId: undefined,
        pending: incomingExits,
      };
    }

    let firstNodeId: string | undefined;
    let pending = [...incomingExits];
    for (const callback of callbacks) {
      const callbackResult = this.materializeImmediateCallbackBody(callback, pending);
      if (!firstNodeId && callbackResult.firstNodeId) {
        firstNodeId = callbackResult.firstNodeId;
      }
      pending = callbackResult.pending;
    }

    return {
      firstNodeId,
      pending,
    };
  }

  private materializeBranchBodyExpression(
    expression: ts.Expression,
    incomingExits: PendingExit[],
    options: { suppressTerminalCallResult?: boolean } = {},
  ) {
    if (!this.hasBranchBodyBoundaryTarget(expression)) {
      const expressionNode = this.createActionNodeFromExpression(expression, incomingExits);
      return {
        firstNodeId: expressionNode.stableId,
        pending: [this.createPendingExit(undefined, expressionNode.stableId, 'NEXT')],
      };
    }

    const result = this.materializeExpressionValue(
      expression,
      incomingExits,
      true,
      options,
    );
    if (result.firstNodeId) {
      return result;
    }

    const expressionNode = this.createActionNodeFromExpression(expression, incomingExits);
    return {
      firstNodeId: expressionNode.stableId,
      pending: [this.createPendingExit(undefined, expressionNode.stableId, 'NEXT')],
    };
  }

  private hasBranchBodyBoundaryTarget(expression: ts.Expression) {
    return collectCallExpressions(expression).some((callExpression) => (
      this.callBoundaryDesign(callExpression) === 'split'
    ));
  }

  private materializeShortCircuitOperandExpression(expression: ts.Expression, incomingExits: PendingExit[]) {
    const current = unwrapExpression(expression);
    if (isStructuredControlExpression(current) || hasImpureExpression(current)) {
      return this.materializeExpressionValue(current, incomingExits, false);
    }

    return {
      firstNodeId: undefined,
      pending: [...incomingExits],
    };
  }

  private materializeSimpleExpression(
    expression: ts.Expression,
    incomingExits: PendingExit[],
    includeRootAction = false,
    options: { suppressTerminalCallResult?: boolean } = {},
  ) {
    const unwrapped = unwrapExpression(expression);
    const current = ts.isVoidExpression(unwrapped) && this.isInsideUpdaterCallback(unwrapped)
      ? unwrapExpression(unwrapped.expression)
      : unwrapped;

    const currentCallee = ts.isCallExpression(current) ? unwrapExpression(current.expression) : undefined;
    const suppressedCatchChain = Boolean(
      currentCallee
      && isPropertyAccessLikeExpression(currentCallee)
      && currentCallee.name.text === 'catch'
      && this.isInsideUpdaterCallback(current),
    );
    const structured = suppressedCatchChain
      ? undefined
      : this.materializeStructuredExpressionNode(current, incomingExits);
    if (structured) return structured;

    if (this.horizontalFlowContexts.length > 0 && ts.isCallExpression(current)) {
      return this.materializeHorizontalCallExpression(
        current,
        incomingExits,
        Boolean(options.suppressTerminalCallResult),
      );
    }

    if (
      this.horizontalFlowContexts.length > 0
      && ts.isElementAccessExpression(current)
      && ts.isCallExpression(unwrapExpression(current.expression))
    ) {
      const receiverResult = this.materializeHorizontalCallExpression(
        unwrapExpression(current.expression) as ts.CallExpression,
        incomingExits,
      );
      const argumentText = current.argumentExpression?.getText(this.sourceFile) || '';
      const accessStableId = this.contextualizeHorizontalStableId(
        getExtendedStableId(this.sourceFile, current),
      );
      const createdAccessStableId = this.createNode('Op', 'element access', current, {
        labels: ['Operand', 'ValueAccess', 'MethodChainContinuation'],
        diaName: `[${argumentText}]`,
        actionTextRaw: current.getText(this.sourceFile),
        operationCode: 'element-access',
        operationSubjectText: argumentText,
        semanticExpansion: 'method-chain',
        flowLayer: 'data',
        dataFlowRole: 'operation',
        methodChainOwnerStableId: receiverResult.proxyStableId,
        methodChainRole: 'continuation',
        suppressObjectMethodVisual: true,
      }, accessStableId);
      this.connectPendingToNode(receiverResult.pending, createdAccessStableId);
      for (const edge of this.edges) {
        if (
          edge.toId === createdAccessStableId
          && receiverResult.pending.some((exit) => exit.fromId === edge.fromId)
          && edge.type === 'NEXT'
        ) {
          edge.renderHidden = true;
          edge.semanticExpansion = 'method-chain';
        }
      }
      return {
        firstNodeId: receiverResult.firstNodeId,
        pending: [this.createPendingExit(undefined, createdAccessStableId, 'NEXT')],
      };
    }

    const expressions = filterExpressionsCoveredByStructuredExpressions(collectMaterializedExpressions(current));
    const shouldMaterializeRoot = includeRootAction
      && !isJsxLikeExpression(current)
      && !isTrivialLiteralExpression(current)
      && !expressions.some(
      (candidate) => candidate.getStart(this.sourceFile) === current.getStart(this.sourceFile)
        && candidate.getEnd() === current.getEnd(),
    );
    const orderedExpressions = shouldMaterializeRoot ? [...expressions, current] : expressions;

    if (!orderedExpressions.length) {
      return {
        firstNodeId: undefined,
        pending: [...incomingExits],
      };
    }

    return this.materializeExpressionSteps(orderedExpressions, incomingExits);
  }

  private materializeHorizontalCallExpression(
    callExpression: ts.CallExpression,
    incomingExits: PendingExit[],
    suppressResultNode = false,
  ) {
    const dataBranchOwnerStableId = incomingExits.length === 1
      && (incomingExits[0].edgeType === 'TRUE' || incomingExits[0].edgeType === 'FALSE')
      && this.nodeByStableId(incomingExits[0].fromId)?.labels.includes('Branch')
      && this.nodeByStableId(incomingExits[0].fromId)?.labels.includes('Data')
      ? incomingExits[0].fromId
      : undefined;
    const callee = unwrapExpression(callExpression.expression);
    const receiver = isPropertyAccessLikeExpression(callee)
      ? unwrapExpression(callee.expression)
      : undefined;
    if (
      (this.suppressCallbackArgumentNodeDepth > 0 || this.isInsideUpdaterCallback(callExpression))
      && isPropertyAccessLikeExpression(callee)
      && callee.name.text === 'catch'
      && receiver
      && ts.isCallExpression(receiver)
    ) {
      const receiverResult = this.materializeHorizontalCallExpression(receiver, incomingExits);
      callExpression.arguments.forEach((argument, index) => {
        if (isFunctionArgumentExpression(argument)) {
          this.createArgumentNode(callExpression, argument, index);
        }
      });
      this.materializeFailureCallbackProtocol(
        callExpression,
        receiverResult.proxyStableId,
        this.resolveRenderableCallTarget(receiver)?.stableId,
      );
      return receiverResult;
    }
    const receiverResult = receiver && ts.isCallExpression(receiver)
      ? this.materializeHorizontalCallExpression(receiver, incomingExits)
      : undefined;
    const effectiveIncomingExits = receiverResult?.pending || incomingExits;
    const args = [...callExpression.arguments];
    const target = this.resolveStructuredRuntimeCallTarget(callExpression)
      || this.resolveCollectionMethodTarget(callExpression);
    const callRoleLabel = this.getCallRole(callExpression, target);
    const callStableId = this.createNode(this.callNodeKind(callExpression, callRoleLabel), 'call', callExpression, {
      labels: uniqueStrings([
        ...this.callSiteLabels(callExpression, callRoleLabel),
        ...this.callBoundaryLabels(args),
      ]),
      diaName: formatCallDiaName(callExpression, this.sourceFile),
      actionTextRaw: callExpression.getText(this.sourceFile),
      ...this.buildCallTargetExtra(callExpression),
      ...this.callStartEffectExtra(callExpression),
      ...this.callBoundaryExtra(callExpression, 'open'),
      ...(dataBranchOwnerStableId ? {
        dataBranchOwnerStableId,
        dataBranchFamilyRole: 'nested-call' as const,
      } : {}),
    });
    const callResult = this.materializeCallArgumentsToProxy(
      callExpression,
      callStableId,
      target,
      callRoleLabel,
      { suppressResultNode, dataBranchOwnerStableId },
    );
    if (dataBranchOwnerStableId && callResult.resultStableId) {
      this.registerFirstNode(callResult.resultStableId, effectiveIncomingExits);
      this.connectPendingToNode(effectiveIncomingExits, callResult.resultStableId);
      this.addEdge(undefined, callResult.resultStableId, undefined, callStableId, 'EVAL', {
        label: 'eval',
        flowLayer: 'control',
      });
    } else {
      this.registerFirstNode(callStableId, effectiveIncomingExits);
      this.connectPendingToNode(effectiveIncomingExits, callStableId);
    }
    if (receiverResult?.proxyStableId && isPropertyAccessLikeExpression(callee)) {
      const callNode = this.nodeByStableId(callStableId);
      if (callNode) {
        callNode.diaName = `${callee.name.getText(this.sourceFile)}${args.length ? '(' : '()'}`;
        callNode.methodChainOwnerStableId = receiverResult.proxyStableId;
        callNode.methodChainRole = 'continuation';
        callNode.suppressObjectMethodVisual = true;
      }
      for (const edge of this.edges) {
        if (
          edge.fromId === receiverResult.proxyStableId
          && edge.toId === callStableId
          && edge.type === 'NEXT'
        ) {
          edge.renderHidden = true;
          edge.semanticExpansion = 'method-chain';
        }
      }
      this.addEdge(undefined, callStableId, undefined, receiverResult.proxyStableId, 'ON_RECEIVER', {
        label: '',
        flowLayer: 'data',
        semanticExpansion: 'method-chain',
        renderHidden: true,
      });
    }
    return {
      firstNodeId: receiverResult?.firstNodeId || callResult.resultStableId || callStableId,
      pending: callResult.pending,
      proxyStableId: callResult.proxyStableId,
    };
  }

  private materializeExpressionBranches(
    anchor: ts.Node,
    firstNodeId: string | undefined,
    exits: PendingExit[],
    mergeLabel: string,
  ) {
    if (exits.length > 1) {
      const anchorExpression = ts.isExpression(anchor) ? unwrapExpression(anchor) : anchor;
      const horizontalContext = this.currentHorizontalFlowContext();
      const exclusiveArgumentJoin = horizontalContext === 'Arg'
        && isStructuredControlExpression(anchorExpression);
      const hasBoundaryCall = ts.isExpression(anchorExpression)
        && this.hasBranchBodyBoundaryTarget(anchorExpression);
      const exclusiveOperandJoin = horizontalContext === 'Operand'
        && isStructuredControlExpression(anchorExpression)
        && !hasBoundaryCall;
      const exclusiveExpressionJoin = exclusiveArgumentJoin || exclusiveOperandJoin;
      if (
        !exclusiveExpressionJoin
        && this.horizontalFlowContexts.length > 0
        && this.suppressHorizontalJoinDepth > 0
        && isStructuredControlExpression(anchorExpression)
      ) {
        return {
          firstNodeId,
          pending: exits,
        };
      }
      const joinId = this.createJoinNode(anchor, mergeLabel, exits, {
        exclusive: exclusiveExpressionJoin,
      });
      if (exclusiveExpressionJoin) {
        const optionalReturnGroupStableId = `${joinId.stableId}:optional-returns`;
        exits.forEach((exit) => {
          const edgeType = exit.edgeType === 'TRUE' || exit.edgeType === 'FALSE'
            ? exit.edgeType
            : 'XOR_JOIN';
          this.addEdge(exit.fromKind, exit.fromId, undefined, joinId.stableId, edgeType, {
            label: 'exclusive alternative',
            ...(edgeType === 'TRUE' || edgeType === 'FALSE' ? {
              producerRouteRole: edgeType === 'TRUE' ? 'return-top' : 'return-bottom',
              producerOutcome: edgeType === 'TRUE' ? 'true' : 'false',
              optionalReturnGroupStableId,
              oneWay: true,
            } : {}),
            sourceRenderPartStableId: exit.sourceRenderPartStableId,
            targetRenderPartStableId: exit.targetRenderPartStableId,
          });
        });
      } else {
        this.connectPendingToJoin(exits, joinId.stableId, joinId.kind);
      }
      return {
        firstNodeId,
        pending: [this.createPendingExit(undefined, joinId.stableId, 'NEXT')],
      };
    }

    return {
      firstNodeId,
      pending: exits,
    };
  }

  private createJoinNode(
    anchor: ts.Node,
    label = 'join',
    incomingExits: PendingExit[] = [],
    options: {
      exclusive?: boolean;
      extra?: FlowNodeExtra;
      joinKind?: Extract<FlowNodeKind, 'FlowJoin' | 'ArgJoin' | 'FieldJoin' | 'OperandJoin'>;
    } = {},
  ) {
    const { endLine, endColumn } = getRange(this.sourceFile, anchor);
    const joinStableId = buildStableIdFromCoordinates({
      filePath: toPosix(path.resolve(this.sourceFile.fileName)),
      startLine: endLine,
      startColumn: endColumn,
      endLine,
      endColumn: endColumn + this.mergeOrdinal,
    });
    this.mergeOrdinal += 1;
    const context = this.currentHorizontalFlowContext();
    const contextualJoinKind: Extract<FlowNodeKind, 'FlowJoin' | 'ArgJoin' | 'FieldJoin' | 'OperandJoin'> = context === 'Arg'
      ? 'ArgJoin'
      : context === 'Field'
        ? 'FieldJoin'
        : context === 'Operand'
          ? 'OperandJoin'
          : 'FlowJoin';
    const joinKind = options.joinKind || contextualJoinKind;
    const createdJoinStableId = this.createNode(joinKind, 'join', anchor, {
      ...options.extra,
      labels: uniqueStrings([
        ...(options.exclusive ? ['Exclusive'] : []),
        ...(options.extra?.labels || []),
      ]),
      joinKind: context?.toLowerCase() || 'flow',
      mergeLabel: label,
      incomingEdgeTypes: incomingExits.map((exit) => exit.edgeType).join(','),
      synthetic: true,
    } as FlowNodeExtra, joinStableId);
    return {
      stableId: createdJoinStableId,
      kind: joinKind,
    };
  }

  private createMergeNode(
    anchor: ts.Node,
    label = 'join',
    incomingExits: PendingExit[] = [],
    options: { exclusive?: boolean } = {},
  ) {
    return this.createJoinNode(anchor, label, incomingExits, options);
  }

  private materializeFlowReentryJoins(
    anchor: ts.Node,
    label: string,
    incomingExits: PendingExit[],
    options: {
      exclusive?: boolean;
      inlineStepContext?: boolean;
      singleJoin?: boolean;
      inlineStepTerminalJoin?: boolean;
    } = {},
  ): PendingExit[] {
    const flowLaneByStableId = new Map<string, FlowLaneContext>();
    for (const node of this.nodes) {
      if (!node.flowLaneStableId || flowLaneByStableId.has(node.flowLaneStableId)) continue;
      flowLaneByStableId.set(node.flowLaneStableId, {
        stableId: node.flowLaneStableId,
        parentStableId: node.parentFlowLaneStableId,
        depth: node.flowLaneDepth ?? 0,
        role: node.flowLaneRole || 'main',
      });
    }
    const flowLaneChainForSource = (sourceStableId: string) => {
      const source = this.nodeByStableId(sourceStableId);
      const chain: FlowLaneContext[] = [];
      let lane = source?.flowLaneStableId
        ? flowLaneByStableId.get(source.flowLaneStableId)
        : undefined;
      const seen = new Set<string>();
      while (lane && !seen.has(lane.stableId)) {
        seen.add(lane.stableId);
        chain.push(lane);
        lane = lane.parentStableId ? flowLaneByStableId.get(lane.parentStableId) : undefined;
      }
      return chain;
    };
    const commonFlowLaneExtra = (exits: PendingExit[]): Partial<FlowNodeRow> => {
      const chains = exits.map((exit) => flowLaneChainForSource(exit.fromId));
      if (!chains.length || chains.some((chain) => !chain.length)) return {};
      const commonLane = chains[0].find((candidate) => (
        chains.slice(1).every((chain) => chain.some((lane) => lane.stableId === candidate.stableId))
      ));
      return commonLane ? {
        flowLaneStableId: commonLane.stableId,
        parentFlowLaneStableId: commonLane.parentStableId,
        flowLaneDepth: commonLane.depth,
        flowLaneRole: commonLane.role,
      } : {};
    };
    const flowBlockDepthForSource = (sourceStableId: string) => {
      let flowBlockStableId = this.nodeByStableId(sourceStableId)?.parentFlowBlockStableId;
      let depth = 0;
      const seen = new Set<string>();
      while (flowBlockStableId && !seen.has(flowBlockStableId)) {
        seen.add(flowBlockStableId);
        depth += 1;
        flowBlockStableId = this.nodeByStableId(flowBlockStableId)?.parentFlowBlockStableId;
      }
      return depth;
    };
    const backboneIndex = incomingExits.reduce((selectedIndex, candidate, candidateIndex) => {
      const selected = incomingExits[selectedIndex];
      const selectedDepth = flowBlockDepthForSource(selected.fromId);
      const candidateDepth = flowBlockDepthForSource(candidate.fromId);
      if (candidateDepth < selectedDepth) return candidateIndex;
      if (candidateDepth === selectedDepth && candidate.mainFlow === true && selected.mainFlow !== true) {
        return candidateIndex;
      }
      return selectedIndex;
    }, 0);
    let accumulated = [incomingExits[backboneIndex]];
    const reentries = incomingExits
      .filter((_, index) => index !== backboneIndex)
      .sort((left, right) => {
        const leftOrder = this.nodeByStableId(left.fromId)?.operationIndex ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = this.nodeByStableId(right.fromId)?.operationIndex ?? Number.MAX_SAFE_INTEGER;
        return leftOrder - rightOrder || left.fromId.localeCompare(right.fromId);
      });
    if (options.singleJoin) {
      const inlineFlowStep = options.inlineStepContext ? this.flowStepContexts.at(-1) : undefined;
      const placementSource = incomingExits.reduce((selected, candidate) => {
        const selectedOrder = this.nodeByStableId(selected.fromId)?.operationIndex ?? Number.MIN_SAFE_INTEGER;
        const candidateOrder = this.nodeByStableId(candidate.fromId)?.operationIndex ?? Number.MIN_SAFE_INTEGER;
        return candidateOrder >= selectedOrder ? candidate : selected;
      });
      const join = this.createJoinNode(anchor, label, incomingExits, {
        exclusive: options.exclusive,
        extra: {
          flowJoinEntrySourceStableId: reentries.at(-1)?.fromId || incomingExits.at(-1)?.fromId,
          flowJoinBackboneSourceStableId: incomingExits[backboneIndex].fromId,
          flowJoinPlacementSourceStableId: placementSource.fromId,
          ...commonFlowLaneExtra(incomingExits),
          ...(inlineFlowStep ? {
            parentStepStableId: inlineFlowStep.stableId,
            flowStepKind: inlineFlowStep.kind,
            flowStepOrder: inlineFlowStep.order,
            ...(options.inlineStepTerminalJoin ? { inlineStepTerminalJoin: true } : {}),
          } : {}),
          flowJoinEntryIndex: 1,
          flowJoinEntryCount: incomingExits.length,
        },
      });
      this.connectPendingToJoin(incomingExits, join.stableId, join.kind);
      return [this.createPendingExit(undefined, join.stableId, 'NEXT', undefined, true)];
    }
    reentries.forEach((entry, index) => {
      const joinInputs = [...accumulated, entry];
      const inlineFlowStep = options.inlineStepContext ? this.flowStepContexts.at(-1) : undefined;
      const placementSource = joinInputs.reduce((selected, candidate) => {
        const selectedOrder = this.nodeByStableId(selected.fromId)?.operationIndex ?? Number.MIN_SAFE_INTEGER;
        const candidateOrder = this.nodeByStableId(candidate.fromId)?.operationIndex ?? Number.MIN_SAFE_INTEGER;
        if (candidateOrder > selectedOrder) return candidate;
        if (candidateOrder < selectedOrder) return selected;
        return flowBlockDepthForSource(candidate.fromId) >= flowBlockDepthForSource(selected.fromId)
          ? candidate
          : selected;
      });
      const join = this.createJoinNode(anchor, label, joinInputs, {
        ...options,
        extra: {
          flowJoinEntrySourceStableId: entry.fromId,
          flowJoinBackboneSourceStableId: accumulated[0].fromId,
          flowJoinPlacementSourceStableId: placementSource.fromId,
          ...commonFlowLaneExtra(joinInputs),
          ...(inlineFlowStep ? {
            parentStepStableId: inlineFlowStep.stableId,
            flowStepKind: inlineFlowStep.kind,
            flowStepOrder: inlineFlowStep.order,
          } : {}),
          flowJoinEntryIndex: index + 1,
          flowJoinEntryCount: reentries.length,
        },
      });
      this.connectPendingToJoin(joinInputs, join.stableId, join.kind);
      accumulated = [this.createPendingExit(undefined, join.stableId, 'NEXT', undefined, true)];
    });
    return accumulated;
  }

  private materializeConditionalExpression(expression: ts.ConditionalExpression, incomingExits: PendingExit[]) {
    const branchKind = this.expressionBranchKind(expression);
    const conditionSteps = this.materializeExpressionValue(
      expression.condition,
      incomingExits,
      branchKind === 'Branch',
    );
    let branchStableId = this.contextualizeHorizontalStableId(getExtendedStableId(this.sourceFile, expression));
    const conditionRaw = expression.condition.getText(this.sourceFile);
    const whenTrueRaw = expression.whenTrue.getText(this.sourceFile);
    const whenFalseRaw = expression.whenFalse.getText(this.sourceFile);
    const binaryCondition = ts.isBinaryExpression(unwrapExpression(expression.condition))
      ? unwrapExpression(expression.condition) as ts.BinaryExpression
      : undefined;

    branchStableId = this.createNode(branchKind, 'ternary', expression, {
      conditionRaw,
      conditionStableId: getExtendedStableIdDescriptor(this.sourceFile, expression.condition),
      operationValueText: `${conditionRaw} ? ${whenTrueRaw} : ${whenFalseRaw}`,
      ...(binaryCondition ? {
        ...this.booleanOperandSemanticExtra(binaryCondition),
        diaName: binaryCondition.operatorToken.getText(this.sourceFile),
        labels: ['PredicateOperator'],
      } : {}),
    }, branchStableId);
    this.materializeBooleanOperandSemantics(expression.condition, branchStableId);

    if (!conditionSteps.firstNodeId) {
      this.registerFirstNode(branchStableId, incomingExits);
    }
    this.connectPendingToNode(conditionSteps.pending, branchStableId);

    const horizontalContext = this.currentHorizontalFlowContext();
    const alternativeLabels = uniqueStrings([
      'Operand',
      'Alternative',
      ...(horizontalContext === 'Arg' || horizontalContext === 'Field' ? [horizontalContext] : []),
    ]);
    const trueResult = this.runWithNodeLabels(alternativeLabels, () => this.materializeBranchBodyExpression(
      expression.whenTrue,
      [this.createPendingExit(undefined, branchStableId, 'TRUE')],
    ));
    const falseResult = this.runWithNodeLabels(alternativeLabels, () => this.materializeBranchBodyExpression(
      expression.whenFalse,
      [this.createPendingExit(undefined, branchStableId, 'FALSE')],
    ));

    return this.materializeExpressionBranches(
      expression,
      conditionSteps.firstNodeId || branchStableId,
      [...trueResult.pending, ...falseResult.pending],
      'ternary-merge',
    );
  }

  private materializeShortCircuitExpression(expression: ts.BinaryExpression, incomingExits: PendingExit[]) {
    if (
      expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      && this.currentHorizontalFlowContext()
    ) {
      let branchStableId = this.contextualizeHorizontalStableId(getExtendedStableId(this.sourceFile, expression));
      const branchKind = this.expressionBranchKind(expression);
      branchStableId = this.createNode(branchKind, 'nullish-coalesce', expression, {
        labels: ['PredicateOperator'],
        conditionRaw: expression.left.getText(this.sourceFile),
        conditionStableId: getExtendedStableIdDescriptor(this.sourceFile, expression.left),
        diaName: '??',
        ...this.booleanOperandSemanticExtra(expression),
      }, branchStableId);
      this.materializeBooleanOperandSemantics(expression, branchStableId);
      this.registerFirstNode(branchStableId, incomingExits);
      this.connectPendingToNode(incomingExits, branchStableId);

      const branch = this.nodeByStableId(branchStableId);
      const renderParts = JSON.parse(branch?.renderPartsJson || '[]') as RenderPartDescriptor[];
      const operatorIndex = renderParts.findIndex((part) => part.text === '??');
      const leftOutcomePart = operatorIndex > 0 ? renderParts[operatorIndex - 1] : undefined;
      const rightOutcomePart = operatorIndex >= 0 ? renderParts[operatorIndex + 1] : undefined;
      const createOutcome = (
        edgeType: 'TRUE' | 'FALSE',
        part: RenderPartDescriptor | undefined,
      ): PendingExit => ({
        ...this.createPendingExit(undefined, branchStableId, edgeType),
        sourceRenderPartStableId: part?.stableId,
      });

      return this.materializeExpressionBranches(
        expression,
        branchStableId,
        [
          createOutcome('TRUE', leftOutcomePart),
          createOutcome('FALSE', rightOutcomePart),
        ],
        'nullish-coalesce-join',
      );
    }

    const leftResult = this.materializeShortCircuitOperandExpression(expression.left, incomingExits);
    let branchStableId = this.contextualizeHorizontalStableId(getExtendedStableId(this.sourceFile, expression));
    const operatorKind = expression.operatorToken.kind;
    const operatorText = expression.operatorToken.getText(this.sourceFile);
    const leftText = expression.left.getText(this.sourceFile);
    const label = operatorKind === ts.SyntaxKind.BarBarToken
      ? 'logical-or'
      : operatorKind === ts.SyntaxKind.AmpersandAmpersandToken
        ? 'logical-and'
        : 'nullish-coalesce';
    const conditionRaw = operatorKind === ts.SyntaxKind.QuestionQuestionToken
      ? `${leftText} != null`
      : `${leftText} ${operatorText}`;

    branchStableId = this.createNode(this.expressionBranchKind(expression), label, expression, {
      conditionRaw,
      conditionStableId: getExtendedStableIdDescriptor(this.sourceFile, expression),
    }, branchStableId);

    if (!leftResult.firstNodeId) {
      this.registerFirstNode(branchStableId, incomingExits);
    }
    this.connectPendingToNode(leftResult.pending, branchStableId);

    const rightIncoming = [this.createPendingExit(
      undefined,
      branchStableId,
      operatorKind === ts.SyntaxKind.AmpersandAmpersandToken ? 'TRUE' : 'FALSE',
      undefined,
    )];
    const shortCircuitExit = [this.createPendingExit(
      undefined,
      branchStableId,
      operatorKind === ts.SyntaxKind.AmpersandAmpersandToken ? 'FALSE' : 'TRUE',
      undefined,
    )];
    const rightResult = this.materializeShortCircuitOperandExpression(expression.right, rightIncoming);

    return this.materializeExpressionBranches(
      expression,
      leftResult.firstNodeId || branchStableId,
      [...shortCircuitExit, ...rightResult.pending],
      `${label}-merge`,
    );
  }

  private materializeExpressionValue(
    expression: ts.Expression,
    incomingExits: PendingExit[],
    includeRootAction = false,
    options: { suppressTerminalCallResult?: boolean } = {},
  ) {
    const current = unwrapExpression(expression);

    if (ts.isConditionalExpression(current)) {
      return this.materializeConditionalExpression(current, incomingExits);
    }

    if (isBooleanShortCircuitBinaryExpression(current)) {
      const conditionFlow = this.materializeBooleanConditionFlow(current, incomingExits);
      return this.materializeExpressionBranches(
        current,
        conditionFlow.firstNodeId,
        [...conditionFlow.trueExits, ...conditionFlow.falseExits],
        'short-circuit-merge',
      );
    }

    if (isShortCircuitBinaryExpression(current)) {
      return this.materializeShortCircuitExpression(current, incomingExits);
    }

    return this.materializeSimpleExpression(current, incomingExits, includeRootAction, options);
  }

  private collectStructuredExpressionRoots(statement: ts.Statement) {
    const roots: ts.Expression[] = [];

    if (ts.isExpressionStatement(statement)) {
      if (isStructuredControlExpression(statement.expression)) {
        roots.push(statement.expression);
      }

      const expression = unwrapExpression(statement.expression);
      if (isSimpleAssignmentExpression(expression) && isStructuredControlExpression(expression.right)) {
        roots.push(expression.right);
      }
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer && isStructuredControlExpression(declaration.initializer)) {
          roots.push(declaration.initializer);
        }
      }
    }

    roots.sort((left, right) => left.getStart(this.sourceFile) - right.getStart(this.sourceFile));
    return roots;
  }

  private materializeConditionExpression(expression: ts.Expression, incomingExits: PendingExit[]) {
    return this.materializeExpressionValue(expression, incomingExits);
  }

  private getConditionBranchStableId(expression: ts.Expression, hasMaterializedPrefix: boolean) {
    if (!hasMaterializedPrefix) {
      return getExtendedStableId(this.sourceFile, expression);
    }

    const { startLine, startColumn, endLine, endColumn } = getRange(this.sourceFile, expression);
    return buildStableIdFromCoordinates({
      filePath: toPosix(path.resolve(this.sourceFile.fileName)),
      startLine,
      startColumn,
      endLine,
      endColumn: endColumn + 1,
    });
  }

  private booleanOperandSemanticExtra(expression: ts.Expression): FlowNodeExtra {
    const current = unwrapExpression(expression);
    if (ts.isBinaryExpression(current)) {
      return {
        operationCode: 'boolean-expression',
        operationSubjectText: current.left.getText(this.sourceFile),
        operationValueText: current.operatorToken.getText(this.sourceFile),
        operationCalleeText: current.right.getText(this.sourceFile),
        semanticExpansion: 'operand-evaluation',
      };
    }
    if (ts.isCallExpression(current)) {
      return {
        operationCode: 'boolean-call',
        operationSubjectText: current.expression.getText(this.sourceFile),
        operationCalleeText: getCallLikeName(current.expression),
        semanticExpansion: 'operand-evaluation',
      };
    }
    return {
      operationCode: 'boolean-value',
      operationSubjectText: current.getText(this.sourceFile),
      semanticExpansion: 'operand-evaluation',
    };
  }

  private materializeOperandValueOccurrence(
    expression: ts.Expression,
    ownerBranchStableId: string,
    role: string,
    sequenceOrder: number,
  ) {
    const current = unwrapExpression(expression);
    const occurrenceStableId = `${ownerBranchStableId}:operand:${sequenceOrder}:${sanitizeSyntheticExternalPart(role)}`;
    const type = this.checker.getTypeAtLocation(current);
    let accessCursor: ts.Expression = current;
    let hasIndexedAccess = false;
    while (isPropertyAccessLikeExpression(accessCursor) || ts.isElementAccessExpression(accessCursor)) {
      hasIndexedAccess ||= ts.isElementAccessExpression(accessCursor);
      accessCursor = unwrapExpression(accessCursor.expression);
    }
    const accessText = current.getText(this.sourceFile);
    const accessRootText = accessCursor.getText(this.sourceFile);
    const relativeAccessText = accessText.startsWith(accessRootText)
      ? accessText.slice(accessRootText.length)
      : accessText;
    const labels = uniqueStrings([
      'Occurrence',
      'OperandValue',
      ...(ts.isIdentifier(current) ? ['Variable'] : []),
      ...(isLiteralInlineCallArgument(current) ? ['Literal'] : []),
      ...(isPropertyAccessLikeExpression(current) ? ['ValueAccess'] : []),
      ...(hasIndexedAccess || this.isCollectionType(type) ? ['Collection'] : []),
    ]);
    const createdStableId = this.createNode('Value', role, current, {
      labels,
      diaName: current.getText(this.sourceFile),
      actionTextRaw: current.getText(this.sourceFile),
      operationCode: 'operand-value',
      operationSubjectText: current.getText(this.sourceFile),
      relativeAccessText,
      canonicalStableId: this.canonicalStableIdForExpression(current),
      bindingStableId: this.bindingNodeStableIdForExpression(current),
      semanticExpansion: 'operand-evaluation',
      sequenceAxisKind: 'operand-value',
      sequenceOwnerStableId: ownerBranchStableId,
      flowLayer: 'data',
      dataFlowRole: 'input',
      renderHidden: false,
      synthetic: false,
    }, occurrenceStableId);
    this.addEdge(undefined, createdStableId, undefined, ownerBranchStableId, 'READS_VALUE', {
      label: role,
      flowLayer: 'data',
      semanticExpansion: 'operand-evaluation',
      sequenceOrder,
    });
    if (isPropertyAccessLikeExpression(current) || ts.isElementAccessExpression(current)) {
      let receiver = unwrapExpression(current.expression);
      while (
        isPropertyAccessLikeExpression(receiver)
        || ts.isElementAccessExpression(receiver)
      ) {
        receiver = unwrapExpression(receiver.expression);
      }
      const receiverType = this.checker.getTypeAtLocation(receiver);
      const receiverStableId = this.createNode('Value', `${role} receiver`, receiver, {
        labels: uniqueStrings([
          'Occurrence',
          'Receiver',
          ...(hasIndexedAccess || this.isCollectionType(receiverType) ? ['Collection'] : ['Object']),
        ]),
        diaName: receiver.getText(this.sourceFile),
        actionTextRaw: receiver.getText(this.sourceFile),
        operationCode: 'operand-receiver',
        operationSubjectText: receiver.getText(this.sourceFile),
        canonicalStableId: this.canonicalStableIdForExpression(receiver),
        bindingStableId: this.bindingStableIdForExpression(receiver),
        semanticExpansion: 'operand-evaluation',
        sequenceAxisKind: 'operand-receiver',
        sequenceOwnerStableId: ownerBranchStableId,
        flowLayer: 'data',
        dataFlowRole: 'input',
        renderHidden: true,
        synthetic: true,
      }, `${occurrenceStableId}:receiver`);
      this.addEdge(undefined, receiverStableId, undefined, createdStableId, 'ON_RECEIVER', {
        label: '',
        flowLayer: 'data',
        semanticExpansion: 'operand-evaluation',
        sequenceOrder,
      });
    }
    return createdStableId;
  }

  private materializeOperandCallEvaluation(
    callExpression: ts.CallExpression,
    ownerBranchStableId: string,
    role: string,
    sequenceOrder: number,
    callPredicate = false,
  ) {
    const target = this.resolveRenderableCallTarget(callExpression);
    const callRole = this.getCallRole(callExpression, target);
    const callStableId = `${ownerBranchStableId}:call:${sequenceOrder}:${callExpression.getStart(this.sourceFile)}`;
    const createdCallStableId = this.createNode('Op', role, callExpression, {
      labels: uniqueStrings([
        'OperandEvaluation',
        'Call',
        ...(callRole === 'Request' ? ['Request'] : []),
        ...(isPropertyAccessLikeExpression(unwrapExpression(callExpression.expression)) ? ['Method'] : []),
      ]),
      diaName: formatCallDiaName(callExpression, this.sourceFile),
      actionTextRaw: callExpression.getText(this.sourceFile),
      operationCode: 'operand-call',
      operationSubjectText: callExpression.expression.getText(this.sourceFile),
      operationCalleeText: getCallLikeName(callExpression.expression),
      semanticExpansion: 'operand-evaluation',
      sequenceAxisKind: 'operand-call',
      sequenceOwnerStableId: ownerBranchStableId,
      flowLayer: 'mixed',
      dataFlowRole: 'operation',
      renderHidden: true,
      synthetic: true,
      ...this.callBoundaryExtra(callExpression, 'open', callPredicate),
    }, callStableId);

    const callResult = this.materializeCallArgumentsToProxy(
      callExpression,
      createdCallStableId,
      target,
      callRole,
      { suppressResultNode: true },
    );
    const proxyStableId = callResult.proxyStableId;
    const proxyNode = this.nodes.find((node) => getStableIdKey(node.stableId) === proxyStableId);
    if (proxyNode) {
      proxyNode.renderHidden = true;
      proxyNode.semanticExpansion = 'operand-evaluation';
      proxyNode.sequenceAxisKind = 'operand-call-target';
      proxyNode.sequenceOwnerStableId = ownerBranchStableId;
      proxyNode.flowLayer = 'mixed';
      proxyNode.dataFlowRole = 'operation';
    }
    this.addEdge(undefined, proxyStableId, undefined, ownerBranchStableId, 'PRODUCES_VALUE', {
      label: role,
      flowLayer: 'data',
      semanticExpansion: 'operand-evaluation',
      sequenceOrder,
    });
    return createdCallStableId;
  }

  private materializeOperandEvaluation(
    expression: ts.Expression,
    ownerBranchStableId: string,
    role: string,
    sequenceOrder: number,
    callPredicate = false,
  ): string {
    const current = unwrapExpression(expression);
    if (ts.isCallExpression(current)) {
      return this.materializeOperandCallEvaluation(
        current,
        ownerBranchStableId,
        role,
        sequenceOrder,
        callPredicate,
      );
    }
    return this.materializeOperandValueOccurrence(
      current,
      ownerBranchStableId,
      role,
      sequenceOrder,
    );
  }

  private materializeBooleanOperandSemantics(expression: ts.Expression, branchStableId: string) {
    const branch = this.nodeByStableId(branchStableId);
    const current = unwrapExpression(expression);
    if (branch && ts.isPropertyAccessExpression(current)) {
      const receiver = unwrapExpression(current.expression);
      const call = unwrapAwaitedExpression(receiver);
      if (ts.isCallExpression(call) && this.callBoundaryDesign(call) === 'split') {
        this.materializeComputedPredicateField(current, receiver, branchStableId);
        return;
      }
    }
    const parts = this.buildRenderParts(unwrapExpression(expression), branchStableId, true);
    if (!branch || !parts) return;
    const renderParts = JSON.parse(parts.json) as RenderPartDescriptor[];
    this.normalizePredicateCallOpeningParts(branch, expression, renderParts);
    const indexedReceiver = (() => {
      let receiver: ts.Expression | undefined;
      const visit = (node: ts.Node): void => {
        if (receiver) return;
        if (ts.isElementAccessExpression(node)) {
          receiver = unwrapExpression(node.expression);
          return;
        }
        ts.forEachChild(node, visit);
      };
      visit(unwrapExpression(expression));
      return receiver;
    })();
    if (indexedReceiver) {
      const receiverStableId = getExtendedStableId(this.sourceFile, indexedReceiver);
      const receiverPart = renderParts.find((part) => part.sourceStableId === receiverStableId)
        || renderParts[0];
      if (receiverPart) receiverPart.kind = 'collection-container';
      branch.labels = [...new Set([...(branch.labels || []), 'Collection'])];
      parts.layout = 'container-overlay-side';
      parts.primaryIndex = Math.max(1, parts.primaryIndex);
    }
    branch.renderPartsJson = JSON.stringify(renderParts);
    branch.renderPartsLayout = parts.layout;
    branch.renderPrimaryPartIndex = parts.primaryIndex;
  }

  private materializeComputedPredicateField(
    expression: ts.PropertyAccessExpression,
    receiver: ts.Expression,
    branchStableId: string,
  ) {
    const branch = this.nodeByStableId(branchStableId)!;
    branch.labels = uniqueStrings([
      ...branch.labels.filter(label => !['Request', 'Call', 'PredicateCall'].includes(label)),
      'Virtual', 'Result', 'ComputedValue', 'BooleanFlag', 'ContainerMethod', 'Method', 'Set',
    ]);
    branch.diaName = '';
    branch.containerStableId = branchStableId;
    branch.containerMethodKind = 'set';
    branch.containerState = 'awaiting-assignment';
    branch.renderPartsLayout = 'container-overlay';
    branch.renderPrimaryPartIndex = 0;
    branch.renderPartsJson = JSON.stringify([
      { stableId: branchStableId, text: '', kind: 'value-container',
        labels: ['Value', 'BooleanFlag', 'Virtual', 'Result'], order: 0, fillState: 'empty',
        sourceStableId: getExtendedStableId(this.sourceFile, expression) },
      { stableId: `${branchStableId}:set`, text: 'set', kind: 'method',
        labels: ['Assignment', 'ContainerMethod', 'Method', 'Set', 'Virtual'], order: 1,
        sourceStableId: getExtendedStableId(this.sourceFile, expression) },
    ] satisfies RenderPartDescriptor[]);
    const result = this.runSuppressingHorizontalJoins(() => this.runInHorizontalFlow('Operand', () => {
      const call = unwrapAwaitedExpression(receiver) as ts.CallExpression;
      const target = this.resolveRenderableCallTarget(call);
      const role = this.getCallRole(call, target);
      const created = this.createActionNodeFromExpression(call,
        [this.createPendingExit(undefined, branchStableId, 'EVAL', 'eval')], undefined, {
          labels: this.callSiteLabels(call, role),
          ...this.callBoundaryExtra(call, 'open'),
        });
      this.addCallEdges(created.stableId, call, target);
      const family = this.materializeCallArgumentsToProxy(call, created.stableId, target, role,
        { suppressResultNode: true, suppressReceiver: true });
      return { firstNodeId: created.stableId,
        pending: [this.createPendingExit(undefined, family.proxyStableId, 'NEXT')] };
    }));
    const opening = result.firstNodeId && this.nodeByStableId(result.firstNodeId);
    const complete = this.buildRenderParts(receiver, result.firstNodeId!, true);
    if (opening && complete) {
      const parts = JSON.parse(complete.json) as RenderPartDescriptor[];
      const boundary = parts.findIndex(part => part.text === '(');
      if (boundary >= 0) {
        opening.renderPartsJson = JSON.stringify(parts.slice(0, boundary + 1));
        opening.renderPartsLayout = 'horizontal';
        opening.renderPrimaryPartIndex = Math.max(0, parts.findIndex(part => part.kind === 'method'));
      }
    }
    const completionIds = uniqueStrings(result.pending.map(exit => {
      const node = this.nodeByStableId(exit.fromId);
      return node?.callBoundaryRole === 'open' && node.callBoundaryPeerStableId
        ? node.callBoundaryPeerStableId : exit.fromId;
    }));
    for (const completionId of completionIds) {
      const terminal = this.nodeByStableId(completionId)!;
      const parts: RenderPartDescriptor[] = [{ stableId: completionId, text: ')',
        kind: 'punctuation', labels: ['CallBoundary', 'Op'], order: 0,
        sourceStableId: getExtendedStableId(this.sourceFile, unwrapAwaitedExpression(receiver)) }];
      const fieldPartId = `${completionId}:result-field`;
      parts.push({ stableId: fieldPartId, text: `.${expression.name.text}`, kind: 'value',
        labels: ['Value', 'ValueAccess', 'FieldAccess'], order: parts.length,
        sourceStableId: getExtendedStableId(this.sourceFile, expression.name) });
      terminal.renderPartsJson = JSON.stringify(parts);
      terminal.renderPartsLayout = 'horizontal';
      this.connectAssignmentResult(completionId, branchStableId);
      const edge = this.edges.at(-1)!;
      edge.sourceRenderPartStableId = fieldPartId;
    }
    this.describeAssignmentProducer(branchStableId, result.firstNodeId!, completionIds);
  }

  private normalizePredicateCallOpeningParts(
    branch: FlowNodeRow,
    expression: ts.Expression,
    renderParts: RenderPartDescriptor[],
  ) {
    const current = unwrapExpression(expression);
    if (
      branch.callMosaicRole === 'open'
      && ts.isCallExpression(current)
      && current.arguments.length === 1
    ) {
      const callee = unwrapExpression(current.expression);
      const methodName = isPropertyAccessLikeExpression(callee)
        ? callee.name.getText(this.sourceFile)
        : getCallLikeName(current.expression);
      const callSourceStableId = getExtendedStableId(this.sourceFile, current);
      const callPart = renderParts.find((part) => part.sourceStableId === callSourceStableId)
        || renderParts.at(-1);
      if (callPart) callPart.text = `${methodName}(`;
    }
  }

  private collectDirectCollectionTransformExpressions(expression: ts.Expression) {
    const transforms: ts.Expression[] = [];
    const seen = new Set<string>();
    const visit = (candidate: ts.Expression): void => {
      const current = unwrapExpression(candidate);
      const transform = this.standardCollectionTransform(current);
      if (transform) {
        const key = `${current.getStart(this.sourceFile)}:${current.getEnd()}`;
        if (!seen.has(key)) {
          seen.add(key);
          transforms.push(current);
        }
        return;
      }

      if (ts.isPrefixUnaryExpression(current)) {
        visit(current.operand);
        return;
      }
      if (ts.isBinaryExpression(current)) {
        visit(current.left);
        visit(current.right);
        return;
      }
      if (ts.isConditionalExpression(current)) {
        visit(current.condition);
        visit(current.whenTrue);
        visit(current.whenFalse);
        return;
      }
      if (isPropertyAccessLikeExpression(current) || ts.isElementAccessExpression(current)) {
        visit(current.expression);
        if (ts.isElementAccessExpression(current) && current.argumentExpression) {
          visit(current.argumentExpression);
        }
        return;
      }
      if (ts.isCallExpression(current)) {
        const callee = unwrapExpression(current.expression);
        if (isPropertyAccessLikeExpression(callee) || ts.isElementAccessExpression(callee)) {
          visit(callee.expression);
        }
        for (const argument of current.arguments) {
          const unwrappedArgument = unwrapExpression(argument);
          if (!ts.isArrowFunction(unwrappedArgument) && !ts.isFunctionExpression(unwrappedArgument)) {
            visit(unwrappedArgument);
          }
        }
      }
    };

    visit(expression);
    return transforms.sort((left, right) => left.getStart(this.sourceFile) - right.getStart(this.sourceFile));
  }

  private materializeBooleanOperandPrefix(
    expression: ts.Expression,
    incomingExits: PendingExit[],
  ) {
    const collectionTransforms = this.collectDirectCollectionTransformExpressions(expression);
    const collectionResults: Array<{
      expression: ts.Expression;
      resultNodeId: string;
      selectedItemName?: string;
    }> = [];
    let firstNodeId: string | undefined;
    let pending = [...incomingExits];

    for (const transformExpression of collectionTransforms) {
      const result = this.materializeCollectionTransformInitializer(
        '',
        transformExpression,
        '',
        {
          incomingExits: pending,
          allowDirectAssignment: false,
        },
      );
      if (!result) continue;
      firstNodeId ||= result.firstNodeId;
      const transform = this.standardCollectionTransform(transformExpression);
      const finalStage = transform?.stages.at(-1);
      const finalStageStableId = finalStage
        ? this.contextualizeHorizontalStableId(getExtendedStableId(this.sourceFile, finalStage.callExpression))
        : undefined;
      pending = result.controlResultExits?.length
        ? result.controlResultExits
        : [this.createPendingExit(
            undefined,
            result.controlResultNodeId || finalStageStableId || result.resultNodeId,
            'NEXT',
          )];
      const finalSemantics = finalStage
        ? collectionMethodSemantics(finalStage.methodName)
        : undefined;
      collectionResults.push({
        expression: transformExpression,
        resultNodeId: result.resultNodeId,
        selectedItemName: finalStage && finalSemantics?.resultMode === 'element'
          ? finalStage.callback.parameters[finalSemantics.itemParameterIndex]?.name.getText(this.sourceFile)
          : undefined,
      });
    }

    return { firstNodeId, pending, collectionResults };
  }

  private attachCollectionResultsToBooleanOperands(
    expression: ts.Expression,
    branchStableId: string,
    collectionResults: Array<{
      expression: ts.Expression;
      resultNodeId: string;
      selectedItemName?: string;
    }>,
  ) {
    const current = unwrapExpression(expression);
    if (!ts.isBinaryExpression(current) || !collectionResults.length) return;

    const operands: Array<{ expression: ts.Expression; role: 'left' | 'right' }> = [
      { expression: current.left, role: 'left' },
      { expression: current.right, role: 'right' },
    ];
    for (const operand of operands) {
      const operandStart = operand.expression.getStart(this.sourceFile);
      const operandEnd = operand.expression.getEnd();
      const result = collectionResults.find((candidate) => (
        candidate.expression.getStart(this.sourceFile) >= operandStart
        && candidate.expression.getEnd() <= operandEnd
      ));
      if (!result) continue;

      const operandText = operand.expression.getText(this.sourceFile);
      const transformText = result.expression.getText(this.sourceFile);
      const suffix = operandText.startsWith(transformText)
        ? operandText.slice(transformText.length)
        : '';
      if (result.selectedItemName && suffix) {
        const branch = this.nodeByStableId(branchStableId);
        if (branch) {
          const selectedOperandText = `${result.selectedItemName}${suffix}`;
          const otherOperand = operand.role === 'left' ? current.right : current.left;
          const selectedParts: RenderPartDescriptor[] = [{
            stableId: `${branchStableId}:render-part:selected-item`,
            text: result.selectedItemName,
            kind: 'value',
            labels: ['Value', 'ValueAccess'],
            order: 0,
            sourceStableId: getExtendedStableId(this.sourceFile, result.expression),
          }];
          const memberSegments: ts.PropertyAccessExpression[] = [];
          let memberCursor = unwrapExpression(operand.expression);
          while (isPropertyAccessLikeExpression(memberCursor)) {
            memberSegments.unshift(memberCursor);
            memberCursor = unwrapExpression(memberCursor.expression);
          }
          if (
            memberCursor.getStart(this.sourceFile) === result.expression.getStart(this.sourceFile)
            && memberCursor.getEnd() === result.expression.getEnd()
          ) {
            for (const segment of memberSegments) {
              if (segment.questionDotToken) {
                const receiverIndex = selectedParts.length - 1;
                selectedParts[receiverIndex] = {
                  ...selectedParts[receiverIndex],
                  text: `${selectedParts[receiverIndex].text}?`,
                  labels: uniqueStrings([...(selectedParts[receiverIndex].labels || []), 'OptionalCheck']),
                };
              }
              selectedParts.push({
                stableId: `${branchStableId}:render-part:selected-field:${selectedParts.length}`,
                text: `.${segment.name.getText(this.sourceFile)}`,
                kind: 'value',
                labels: ['Value', 'ValueAccess', 'FieldAccess'],
                order: selectedParts.length,
                sourceStableId: getExtendedStableId(this.sourceFile, segment.name),
                canonicalStableId: this.canonicalStableIdForExpression(segment),
                bindingStableId: this.bindingNodeStableIdForExpression(segment),
              });
            }
          }
          const operatorPart: RenderPartDescriptor = {
            stableId: branchStableId,
            text: current.operatorToken.getText(this.sourceFile),
            kind: 'operator',
            labels: ['Op', 'Operand'],
            order: selectedParts.length,
            sourceStableId: getExtendedStableId(this.sourceFile, current.operatorToken),
          };
          const otherPart: RenderPartDescriptor = {
            stableId: `${branchStableId}:render-part:other-operand`,
            text: otherOperand.getText(this.sourceFile),
            kind: ts.isLiteralExpression(unwrapExpression(otherOperand)) ? 'literal' : 'value',
            labels: ts.isLiteralExpression(unwrapExpression(otherOperand))
              ? ['Value', 'Literal']
              : ['Value'],
            order: operand.role === 'left' ? selectedParts.length + 1 : 0,
            sourceStableId: getExtendedStableId(this.sourceFile, otherOperand),
          };
          const parts = operand.role === 'left'
            ? [...selectedParts, operatorPart, otherPart]
            : [otherPart, operatorPart, ...selectedParts];
          branch.renderPartsJson = JSON.stringify(parts.map((part, order) => ({ ...part, order })));
          branch.renderPartsLayout = 'horizontal';
          branch.renderPrimaryPartIndex = operand.role === 'left' ? selectedParts.length : 1;
          branch.labels = branch.labels.filter((label) => label !== 'Collection');
          branch.diaName = operatorPart.text;
          branch.conditionRaw = `${selectedOperandText} ${operatorPart.text} ${otherPart.text}`;
        }
      }
      const branch = this.nodeByStableId(branchStableId) as (FlowNodeRow & { collectionResultStableId?: string }) | undefined;
      if (branch) {
        branch.collectionResultStableId = result.resultNodeId;
        const resultNode = this.nodeByStableId(result.resultNodeId);
        const submethodStableId = resultNode?.memberOfSubmethodStableId
          || resultNode?.executionProtocolStableId;
        if (submethodStableId) {
          const existingMembers = this.nodes.filter((node) => (
            node.memberOfSubmethodStableId === submethodStableId
          ));
          const lastRelativeRow = Math.max(0, ...existingMembers.map((node) => (
            Number(node.submethodRelativeRow) || 0
          )));
          branch.labels = uniqueStrings([...branch.labels, 'SubStepMember']);
          branch.memberOfSubmethodStableId = submethodStableId;
          branch.submethodPlacement = 'axis';
          branch.submethodAnchorStableId = result.resultNodeId;
          branch.submethodRelativeColumn = 0;
          branch.submethodRelativeRow = lastRelativeRow + 1;
          branch.submethodMemberOrder = Math.max(0, ...existingMembers.map((node) => (
            Number(node.submethodMemberOrder) || 0
          ))) + 1;
          branch.executionProtocolStableId = resultNode?.executionProtocolStableId || submethodStableId;
          branch.executionProtocolKind = resultNode?.executionProtocolKind;

          const header = this.nodeByStableId(submethodStableId);
          if (header?.submethodsJson) {
            const submethods = JSON.parse(header.submethodsJson) as Array<{
              memberStableIds?: string[];
            }>;
            const submethod = submethods.find((candidate) => (
              candidate.memberStableIds?.includes(result.resultNodeId)
            )) || submethods[0];
            if (submethod) {
              submethod.memberStableIds = uniqueStrings([
                ...(submethod.memberStableIds || []),
                branchStableId,
              ]);
              header.submethodsJson = JSON.stringify(submethods);
            }
          }
        }
      }
      if (!result.selectedItemName) {
        this.addEdge(undefined, result.resultNodeId, undefined, branchStableId, 'PASSES_VALUE', {
          label: 'collection result',
          displayLabel: 'collection result',
          flowLayer: 'data',
          semanticExpansion: 'collection-iteration',
        });
      }
    }
  }

  private withNegatedConditionExit(exit: PendingExit, edgeType: 'TRUE' | 'FALSE'): PendingExit {
    return {
      ...exit,
      edgeType,
    };
  }

  private applyLogicalNotPrefixToPredicate(
    result: ConditionFlowResult,
    operandExpression: ts.Expression,
  ) {
    const exitNodeIds = new Set([
      ...result.trueExits.map((exit) => exit.fromId),
      ...result.falseExits.map((exit) => exit.fromId),
    ]);
    for (const nodeId of exitNodeIds) {
      const node = this.nodeByStableId(nodeId);
      if (
        !node
        || !node.labels.includes('Branch')
        || node.callMosaicRole === 'close'
      ) {
        continue;
      }
      const diaName = String(node.diaName || node.conditionRaw || node.operationSubjectText || '').trim();
      if (diaName && !diaName.startsWith('!')) {
        node.diaName = `!${diaName}`;
      }
      node.logicalNotPrefix = true;
      node.operationCode ||= 'logical-not';
      node.operationValueText = '!';
      if (node.renderPartsJson) {
        const parts = JSON.parse(node.renderPartsJson) as RenderPartDescriptor[];
        if (!parts.some((part) => part.labels.includes('LogicalNot'))) {
          const logicalNotPart: RenderPartDescriptor = {
            stableId: `${nodeId}:render-part:logical-not`,
            text: '!',
            kind: 'operator',
            labels: ['Operator', 'System', 'LogicalNot'],
            order: 0,
          };
          node.renderPartsJson = JSON.stringify([
            logicalNotPart,
            ...parts.map((part, index) => ({ ...part, order: index + 1 })),
          ]);
          node.renderPartsLayout = 'horizontal';
          if (Number.isInteger(node.renderPrimaryPartIndex)) {
            node.renderPrimaryPartIndex = Number(node.renderPrimaryPartIndex) + 1;
          }
        }
      }
    }
  }

  private materializeBooleanConditionOperand(
    expression: ts.Expression,
    incomingExits: PendingExit[],
    branchKindOverride?: Extract<FlowNodeKind, 'Branch' | 'OperandBranch'>,
    flowControlDomain = branchKindOverride === 'Branch',
    flowLane?: FlowLaneContext,
  ): ConditionFlowResult {
    const current = unwrapExpression(expression);
    const prefixNodeStartIndex = this.nodes.length;
    const prefix = this.materializeBooleanOperandPrefix(current, incomingExits);
    const currentFlowStepStableId = this.flowStepContexts.at(-1)?.stableId;
    if (flowLane && currentFlowStepStableId) {
      for (const prefixNode of this.nodes.slice(prefixNodeStartIndex)) {
        if (prefixNode.parentStepStableId !== currentFlowStepStableId || prefixNode.flowLaneStableId) continue;
        prefixNode.flowLaneStableId = flowLane.stableId;
        prefixNode.parentFlowLaneStableId = flowLane.parentStableId;
        prefixNode.flowLaneDepth = flowLane.depth;
        prefixNode.flowLaneRole = flowLane.role;
      }
    }
    const operandContinuation = branchKindOverride === 'OperandBranch';
    const flowOperandContinuation = operandContinuation && flowControlDomain;
    const branchStableId = this.contextualizeHorizontalStableId(this.getConditionBranchStableId(current, Boolean(prefix.firstNodeId)));
    const directPredicateCall = ts.isCallExpression(current) ? current : undefined;
    const directPredicateTarget = directPredicateCall
      ? this.resolveRenderableCallTarget(directPredicateCall)
      : undefined;
    const directPredicateRole = directPredicateCall
      ? this.getCallRole(directPredicateCall, directPredicateTarget)
      : undefined;
    const embeddedPredicateCalls = directPredicateCall ? [] : collectCallExpressions(current);
    const embeddedPredicateCall = embeddedPredicateCalls.length === 1
      ? embeddedPredicateCalls[0]
      : undefined;
    const embeddedPredicateRole = embeddedPredicateCall
      ? this.getCallRole(embeddedPredicateCall, this.resolveRenderableCallTarget(embeddedPredicateCall))
      : undefined;
    const createdBranchStableId = this.createNode(
      flowOperandContinuation ? 'Branch' : branchKindOverride || this.expressionBranchKind(current),
      'condition',
      current,
      {
      ...(!directPredicateCall && embeddedPredicateCall && embeddedPredicateRole ? {
        labels: uniqueStrings([
          ...(flowOperandContinuation ? ['Operand'] : []),
          ...this.callSiteLabels(embeddedPredicateCall, embeddedPredicateRole),
          'PredicateCall',
        ]),
        annotationKind: 'CallSite' as const,
      } : !directPredicateCall && flowOperandContinuation ? { labels: ['Operand'] } : {}),
      ...(directPredicateCall && directPredicateRole ? {
        labels: uniqueStrings([
          ...this.callSiteLabels(directPredicateCall, directPredicateRole)
            .filter((label) => label !== 'Operand'),
          ...this.callBoundaryLabels([...directPredicateCall.arguments]),
          'Flow',
          ...(flowOperandContinuation ? ['Operand'] : []),
          'PredicateCall',
        ]),
        diaName: formatCallDiaName(directPredicateCall, this.sourceFile),
        actionTextRaw: directPredicateCall.getText(this.sourceFile),
        ...this.callBoundaryExtra(directPredicateCall, 'open', true),
        ...(this.callBoundaryDesign(directPredicateCall) === 'split' ? {
          callMosaicOwnerStableId: branchStableId,
          callMosaicRole: 'open' as const,
        } : {}),
      } : {}),
      conditionRaw: current.getText(this.sourceFile),
      conditionStableId: getExtendedStableIdDescriptor(this.sourceFile, current),
      ...(flowLane ? {
        flowLaneStableId: flowLane.stableId,
        parentFlowLaneStableId: flowLane.parentStableId,
        flowLaneDepth: flowLane.depth,
        flowLaneRole: flowLane.role,
      } : {}),
      ...this.booleanOperandSemanticExtra(current),
    }, branchStableId);

    let trueExitStableId = createdBranchStableId;
    if (directPredicateCall && directPredicateRole) {
      const openingNode = this.nodeByStableId(createdBranchStableId);
      if (openingNode?.renderPartsJson) {
        const renderParts = JSON.parse(openingNode.renderPartsJson) as RenderPartDescriptor[];
        this.normalizePredicateCallOpeningParts(openingNode, directPredicateCall, renderParts);
        openingNode.renderPartsJson = JSON.stringify(renderParts);
      }
      const callResult = this.materializeCallArgumentsToProxy(
        directPredicateCall,
        createdBranchStableId,
        directPredicateTarget,
        directPredicateRole,
        {
          suppressResultNode: true,
          // The receiver is already a render part of the predicate node. A
          // second receiver occurrence would be an orphan beside the mosaic.
          suppressReceiver: true,
        },
      );
      trueExitStableId = callResult.proxyStableId;
      const splitPredicateCall = this.callBoundaryDesign(directPredicateCall) === 'split';
      const proxyNode = this.nodeByStableId(callResult.proxyStableId);
      if (proxyNode) {
        proxyNode.renderHidden = false;
        proxyNode.labels = uniqueStrings([...proxyNode.labels, 'PredicateCall']);
        if (splitPredicateCall) {
          proxyNode.callMosaicOwnerStableId = createdBranchStableId;
          proxyNode.callMosaicRole = 'close';
        }
        if (flowLane) {
          proxyNode.flowLaneStableId = flowLane.stableId;
          proxyNode.parentFlowLaneStableId = flowLane.parentStableId;
          proxyNode.flowLaneDepth = flowLane.depth;
          proxyNode.flowLaneRole = flowLane.role;
        }
      }

      const argumentEdges = this.edges.filter((edge) => (
        edge.fromId === createdBranchStableId
        && edge.type === 'ARG'
      ));
      for (const argumentEdge of argumentEdges) {
        const argumentNode = this.nodeByStableId(argumentEdge.toId);
        if (!argumentNode) continue;
        argumentNode.labels = uniqueStrings([
          ...argumentNode.labels,
          'PredicateCall',
          ...(directPredicateCall.arguments.length === 1
            && isLiteralInlineCallArgument(directPredicateCall.arguments[0]) ? ['Literal'] : []),
        ]);
        if (splitPredicateCall) {
          argumentNode.callMosaicOwnerStableId = createdBranchStableId;
          argumentNode.callMosaicRole = 'argument';
        }
      }

      const mosaicNodeIds = new Set([
        createdBranchStableId,
        callResult.proxyStableId,
        ...argumentEdges.map((edge) => edge.toId),
      ]);
      for (const edge of this.edges) {
        if (!mosaicNodeIds.has(edge.fromId) || !mosaicNodeIds.has(edge.toId)) continue;
        if (['ARG', 'ArgJoin', 'INVOKES', 'MATERIALIZES_ARGUMENT'].includes(edge.type)) {
          edge.renderHidden = true;
        }
      }
    } else {
      if (ts.isBinaryExpression(current)) {
        const operatorNode = this.nodeByStableId(createdBranchStableId);
        if (operatorNode) {
          operatorNode.labels = uniqueStrings([
            ...operatorNode.labels.filter((label) => label !== 'ValueAccess' && label !== 'ValueRead'),
            'PredicateOperator',
          ]);
          operatorNode.diaName = current.operatorToken.getText(this.sourceFile);
        }
      }
      this.materializeBooleanOperandSemantics(current, createdBranchStableId);
      this.attachCollectionResultsToBooleanOperands(
        current,
        createdBranchStableId,
        prefix.collectionResults,
      );
      for (const callExpression of collectCallExpressions(current)) {
        this.addCallEdges(createdBranchStableId, callExpression, this.resolveCallTarget(callExpression));
      }
    }

    if (!prefix.firstNodeId) {
      this.registerFirstNode(createdBranchStableId, incomingExits);
    }
    this.connectPendingToNode(prefix.pending, createdBranchStableId);

    const trueExit = this.createPendingExit(undefined, trueExitStableId, 'TRUE');
    const falseExit = this.createPendingExit(undefined, createdBranchStableId, 'FALSE');
    return {
      firstNodeId: prefix.firstNodeId || createdBranchStableId,
      trueExits: [trueExit],
      falseExits: [falseExit],
    };
  }

  private materializeBooleanConditionFlow(
    expression: ts.Expression,
    incomingExits: PendingExit[],
    firstBranchKind?: Extract<FlowNodeKind, 'Branch' | 'OperandBranch'>,
    flowControlDomain = firstBranchKind === 'Branch',
    inheritedFlowLane?: FlowLaneContext,
  ): ConditionFlowResult {
    const current = unwrapExpression(expression);
    const currentStepStableId = this.flowStepContexts.at(-1)?.stableId;
    const flowLane = inheritedFlowLane || {
      stableId: `flow-lane:main:${currentStepStableId || getExtendedStableId(this.sourceFile, current)}`,
      depth: 0,
      role: 'main' as const,
    };
    if (
      ts.isPrefixUnaryExpression(current)
      && current.operator === ts.SyntaxKind.ExclamationToken
    ) {
      const compoundOperand = isBooleanShortCircuitBinaryExpression(unwrapExpression(current.operand));
      const operandFlow = this.materializeBooleanConditionFlow(
        current.operand,
        incomingExits,
        firstBranchKind,
        flowControlDomain,
        flowLane,
      );
      if (!compoundOperand) {
        this.applyLogicalNotPrefixToPredicate(operandFlow, current.operand);
        return {
          firstNodeId: operandFlow.firstNodeId,
          trueExits: operandFlow.falseExits.map((exit) => this.withNegatedConditionExit(exit, 'TRUE')),
          falseExits: operandFlow.trueExits.map((exit) => this.withNegatedConditionExit(exit, 'FALSE')),
        };
      }
      return {
        firstNodeId: operandFlow.firstNodeId,
        trueExits: operandFlow.falseExits,
        falseExits: operandFlow.trueExits,
      };
    }
    if (!isBooleanShortCircuitBinaryExpression(current)) {
      return this.materializeBooleanConditionOperand(
        current,
        incomingExits,
        firstBranchKind,
        flowControlDomain,
        flowLane,
      );
    }

    const leftResult = this.materializeBooleanConditionFlow(
      current.left,
      incomingExits,
      firstBranchKind,
      flowControlDomain,
      flowLane,
    );
    // The first predicate belongs to the surrounding flow column. Every
    // short-circuit continuation is an operand of that predicate and starts a
    // neighbouring sub-column, irrespective of the first predicate's kind.
    const continuationKind: Extract<FlowNodeKind, 'Branch' | 'OperandBranch'> = 'OperandBranch';
    const optionalFlowLane: FlowLaneContext = {
      stableId: `flow-lane:optional:${getExtendedStableId(this.sourceFile, current.right)}`,
      parentStableId: flowLane.stableId,
      depth: flowLane.depth + 1,
      role: 'optional',
    };
    if (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      const rightIncoming = leftResult.trueExits;
      const rightResult = this.materializeBooleanConditionFlow(
        current.right,
        rightIncoming,
        continuationKind,
        flowControlDomain,
        optionalFlowLane,
      );
      return {
        firstNodeId: leftResult.firstNodeId || rightResult.firstNodeId,
        trueExits: rightResult.trueExits,
        falseExits: [...leftResult.falseExits, ...rightResult.falseExits],
      };
    }

    const rightIncoming = leftResult.falseExits;
    const rightResult = this.materializeBooleanConditionFlow(
      current.right,
      rightIncoming,
      continuationKind,
      flowControlDomain,
      optionalFlowLane,
    );
    return {
      firstNodeId: leftResult.firstNodeId || rightResult.firstNodeId,
      trueExits: [...leftResult.trueExits, ...rightResult.trueExits],
      falseExits: rightResult.falseExits,
    };
  }

  private resolveCallTarget(callExpression: ts.CallExpression | ts.NewExpression) {
    if (ts.isCallExpression(callExpression)) {
      const stateResource = this.resolveReactStateResource(callExpression.expression);
      if (stateResource) {
        return {
          stableId: stateResource.setterStableId,
          name: stateResource.setterName,
          repoRelativePath: stateResource.repoRelativePath,
          targetKind: 'fn' as const,
        };
      }
    }
    const signature = this.checker.getResolvedSignature(callExpression);
    const declaration = signature?.declaration;
    const repoRelativePath = declaration
      ? getRepoRelativePath(declaration.getSourceFile().fileName)
      : undefined;
    const stableId = declaration
      ? this.stableIdByDeclaration.get(declaration)
      : undefined;
    const resolvedDeclarationName = declaration
      ? (isFunctionLikeNode(declaration)
        ? (() => {
          const inferredName = getFunctionName(declaration);
          return inferredName !== '<anonymous>' ? inferredName : path.parse(declaration.getSourceFile().fileName).name;
        })()
        : declaration.name && ts.isIdentifier(declaration.name)
          ? declaration.name.text
          : undefined)
      : undefined;
    const directTarget = stableId ? {
      stableId,
      name: resolvedDeclarationName,
      repoRelativePath,
    } : undefined;

    if (ts.isCallExpression(callExpression) && directTarget?.name === 'callApi' && CALL_API_WRAPPER_REPO_PATHS.has(repoRelativePath)) {
      const apiMethodName = getApiMethodNameFromCall(callExpression);
      if (apiMethodName) {
        return this.uniqueApiMethodTargetsByName.get(apiMethodName) || directTarget;
      }
    }

    const directTargetName = directTarget?.name || resolvedDeclarationName;
    const directExternalTarget = directTargetName ? getExternalTargetByMethodName(directTargetName) : undefined;
    if (directExternalTarget && directTargetName === 'invokeRequest') {
      return directExternalTarget;
    }

    const callee = unwrapExpression(callExpression.expression);
    const calleeSymbol = ts.isIdentifier(callee)
      ? this.checker.getSymbolAtLocation(callee)
      : undefined;
    const calleeDeclaration = calleeSymbol?.valueDeclaration || calleeSymbol?.declarations?.[0];
    const namedFunctionTarget = ts.isIdentifier(callee)
      ? this.uniqueFunctionTargetsByName.get(callee.text)
      : undefined;

    if (ts.isIdentifier(callee) && calleeDeclaration && isGetActionsBindingDeclaration(calleeDeclaration)) {
      return this.uniqueActionTargetsByName.get(callee.text)
        || this.uniqueFunctionTargetsByName.get(callee.text)
        || directTarget;
    }

    if (
      repoRelativePath === ACTION_ALIAS_WRAPPER_REPO_PATH
      && ts.isIdentifier(callee)
    ) {
      return this.uniqueActionTargetsByName.get(callee.text)
        || this.uniqueFunctionTargetsByName.get(callee.text)
        || directTarget;
    }

    if (namedFunctionTarget && (!directTarget?.name || directTarget.name === '<anonymous>')) {
      return {
        stableId: directTarget?.stableId || namedFunctionTarget.stableId,
        name: namedFunctionTarget.name,
        repoRelativePath: directTarget?.repoRelativePath || namedFunctionTarget.repoRelativePath,
      };
    }

    if (ts.isCallExpression(callExpression)) {
      const calleeTextExternalTarget = getExternalTargetByCalleeText(callee.getText(this.sourceFile));
      if (calleeTextExternalTarget) {
        return calleeTextExternalTarget;
      }

      if (ts.isIdentifier(callee) && callee.text === 'invokeRequest') {
        return getExternalTargetByMethodName('invokeRequest') || directTarget;
      }

      if (ts.isIdentifier(callee)) {
        const externalTarget = getExternalTargetByMethodName(callee.text);
        if (externalTarget?.stableId === 'external:bun-bundle:feature') {
          return externalTarget;
        }
        if (externalTarget?.repoRelativePath === EXTERNAL_LOCAL_DATA_REPO_PATH) {
          return externalTarget;
        }
      }

      const methodName = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : undefined;

      if (methodName) {
        const localMethodTarget = this.uniqueFunctionTargetsByName.get(methodName);
        if (
          localMethodTarget
          && (
            declarationIsTracked(declaration)
            || (ts.isPropertyAccessExpression(callee) && this.memberAccessRootTypeDeclaresMethod(callee.expression, methodName))
          )
        ) {
          return localMethodTarget;
        }

        const externalTarget = getExternalTargetByMethodName(methodName);
        if (externalTarget) {
          if (externalTarget.repoRelativePath === EXTERNAL_BROWSER_MEDIA_REPO_PATH) {
            return externalTarget;
          }

          const receiverTypeText = ts.isPropertyAccessExpression(callee)
            ? this.checker.typeToString(this.checker.getTypeAtLocation(callee.expression))
            : undefined;
          if (isWebRtcRuntimeType(receiverTypeText)) {
            return externalTarget;
          }

          if (externalTarget.repoRelativePath === EXTERNAL_LOCAL_DATA_REPO_PATH) {
            return externalTarget;
          }
        }
      }

      const requiredModuleTarget = this.resolveRequireModuleMemberTarget(callee, methodName);
      if (requiredModuleTarget) {
        return requiredModuleTarget;
      }
    }

    return directTarget;
  }

  private resolveStructuredRuntimeCallTarget(callExpression: ts.CallExpression | ts.NewExpression) {
    const existing = this.resolveCallTarget(callExpression);
    if (existing) return existing;
    if (!callExpression.arguments?.some((argument) => isStructuredControlExpression(unwrapExpression(argument)))) {
      return undefined;
    }

    const declaration = this.checker.getResolvedSignature(callExpression)?.declaration;
    if (!declaration || declarationIsTracked(declaration)) return undefined;
    const callee = unwrapExpression(callExpression.expression);
    const callableName = ts.isIdentifier(callee)
      ? callee.text
      : isPropertyAccessLikeExpression(callee)
        ? callee.name.text
        : undefined;
    if (!callableName) return undefined;

    const declarationSource = getRepoRelativePath(declaration.getSourceFile().fileName);
    const stableId = `external:runtime:${sanitizeSyntheticExternalPart(declarationSource)}:${sanitizeSyntheticExternalPart(callableName)}`;
    const target: ResolvedCallTarget = {
      stableId,
      name: callableName,
      repoRelativePath: EXTERNAL_RUNTIME_REPO_PATH,
      targetKind: 'synthetic-external',
    };
    SYNTHETIC_EXTERNAL_TARGETS_BY_KEY.set(stableId, target);
    return target;
  }

  private resolveRequireModuleMemberTarget(callee: ts.Expression, methodName: string | undefined): ResolvedCallTarget | undefined {
    if (!methodName || !isPropertyAccessLikeExpression(callee)) {
      return undefined;
    }

    const receiver = unwrapExpression(callee.expression);
    if (!ts.isIdentifier(receiver)) {
      return undefined;
    }

    const symbol = this.checker.getSymbolAtLocation(receiver);
    const declaration = symbol?.valueDeclaration || symbol?.declarations?.[0];
    if (!declaration || !ts.isVariableDeclaration(declaration)) {
      return undefined;
    }

    const moduleSpecifiers = collectRequireSpecifiers(declaration.initializer);
    if (moduleSpecifiers.length !== 1) {
      return undefined;
    }

    const moduleSpecifier = moduleSpecifiers[0];
    const missingTarget = this.resolveMissingRequireModuleMemberTarget(declaration, moduleSpecifier, methodName);
    if (missingTarget) {
      return missingTarget;
    }

    const stableModule = sanitizeSyntheticExternalPart(moduleSpecifier);
    const stableMethod = sanitizeSyntheticExternalPart(methodName);
    const target: ResolvedCallTarget = {
      stableId: `external:module:${stableModule}:${stableMethod}`,
      name: `${moduleSpecifier}.${methodName}`,
      repoRelativePath: EXTERNAL_MODULE_REPO_PATH,
      targetKind: 'synthetic-external',
    };
    SYNTHETIC_EXTERNAL_TARGETS_BY_KEY.set(target.stableId, target);
    return target;
  }

  private materializeCallExpressionWithArgumentChain(callExpression: ts.CallExpression, incomingExits: PendingExit[]) {
    const expression = unwrapExpression(callExpression.expression);
    const receiver = isPropertyAccessLikeExpression(expression)
      ? unwrapExpression(expression.expression)
      : undefined;
    if (
      isPropertyAccessLikeExpression(expression)
      && expression.name.text === 'catch'
      && receiver
      && ts.isCallExpression(receiver)
      && this.isInsideUpdaterCallback(callExpression)
    ) {
      const receiverResult = this.materializeCallExpressionWithArgumentChain(receiver, incomingExits);
      callExpression.arguments.forEach((argument, index) => {
        if (isFunctionArgumentExpression(argument)) this.createArgumentNode(callExpression, argument, index);
      });
      const receiverStableId = this.contextualizeHorizontalStableId(
        getExtendedStableId(this.sourceFile, receiver),
        receiver,
      );
      const receiverNode = this.nodeByStableId(receiverStableId);
      this.materializeFailureCallbackProtocol(
        callExpression,
        receiverNode?.callBoundaryPeerStableId || receiverStableId,
        this.resolveRenderableCallTarget(receiver)?.stableId,
      );
      return receiverResult;
    }
    const args = [...callExpression.arguments].map((argument, index) => ({
      argument,
      index,
    }));
    const target = this.resolveStructuredRuntimeCallTarget(callExpression)
      || this.resolveCollectionMethodTarget(callExpression);
    const callRoleLabel = this.getCallRole(callExpression, target);
    const callStableId = this.createNode(this.callNodeKind(callExpression, callRoleLabel), 'call', callExpression, {
      labels: uniqueStrings([
        ...this.callSiteLabels(callExpression, callRoleLabel),
        ...this.callBoundaryLabels(args.map(({ argument }) => argument)),
      ]),
      diaName: formatCallDiaName(callExpression, this.sourceFile),
      actionTextRaw: callExpression.getText(this.sourceFile),
      ...this.buildCallTargetExtra(callExpression),
      ...this.callStartEffectExtra(callExpression),
      ...this.callBoundaryExtra(callExpression, 'open'),
      uiSlotName: this.isUiInjectionCall(callExpression) ? (getCallLikeName(callExpression.expression) || 'ui') : undefined,
    });
    const callee = unwrapExpression(callExpression.expression);
    const receiverCall = isPropertyAccessLikeExpression(callee)
      ? unwrapExpression(callee.expression)
      : undefined;
    if (
      receiverCall
      && ts.isCallExpression(receiverCall)
      && this.callBoundaryDesign(callExpression) === 'mosaic'
      && this.expressionRequiresVerticalExpansion(receiverCall)
    ) {
      const receiverCallStableId = this.contextualizeHorizontalStableId(
        getExtendedStableId(this.sourceFile, receiverCall),
        receiverCall,
      );
      const receiverNode = this.nodeByStableId(receiverCallStableId);
      const callNode = this.nodeByStableId(callStableId);
      if (receiverNode && callNode) {
        callNode.diaName = `${callee.name.getText(this.sourceFile)}${callExpression.arguments.length ? '(' : '()'}`;
        callNode.methodChainOwnerStableId = receiverNode.callBoundaryPeerStableId || receiverCallStableId;
        callNode.methodChainRole = 'continuation';
        callNode.suppressObjectMethodVisual = true;
      }
    }
    this.registerFirstNode(callStableId, incomingExits);
    this.connectPendingToNode(incomingExits, callStableId);

    const callResult = this.materializeCallArgumentsToProxy(callExpression, callStableId, target, callRoleLabel);
    return {
      firstNodeId: callStableId,
      pending: callResult.pending,
    };
  }

  private variableDeclarationKind(statement: ts.VariableStatement) {
    const flags = statement.declarationList.flags;
    if (flags & ts.NodeFlags.Const) return 'const';
    if (flags & ts.NodeFlags.Let) return 'let';
    return 'var';
  }

  private materializedConstVariableBinding(statement: ts.Statement) {
    if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) {
      return undefined;
    }
    const declaration = statement.declarationList.declarations[0];
    if (!declaration.initializer) {
      return undefined;
    }
    const binding = ts.isIdentifier(declaration.name)
      ? declaration.name
      : ts.isObjectBindingPattern(declaration.name)
        && declaration.name.elements.length === 1
        && !declaration.name.elements[0].dotDotDotToken
        && ts.isIdentifier(declaration.name.elements[0].name)
        ? declaration.name.elements[0].name
        : undefined;
    if (!binding) return undefined;
    const initializer = unwrapExpression(declaration.initializer);
    if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer) || ts.isClassExpression(initializer)) {
      return undefined;
    }
    return { declaration, binding, initializer: declaration.initializer };
  }

  private shouldMaterializeConstVariableStatement(statement: ts.Statement): statement is ts.VariableStatement {
    return Boolean(this.materializedConstVariableBinding(statement));
  }

  private typedEmptyArrayDeclaration(
    declaration: ts.VariableDeclaration,
    initializer: ts.Expression,
  ) {
    const current = unwrapExpression(initializer);
    if (!declaration.type || !ts.isArrayLiteralExpression(current) || current.elements.length !== 0) {
      return undefined;
    }
    const suffixArray = ts.isArrayTypeNode(declaration.type);
    const genericArray = ts.isTypeReferenceNode(declaration.type)
      && ts.isIdentifier(declaration.type.typeName)
      && declaration.type.typeName.text === 'Array'
      && declaration.type.typeArguments?.length === 1;
    if (!suffixArray && !genericArray) return undefined;
    const elementType = suffixArray
      ? declaration.type.elementType
      : (declaration.type as ts.TypeReferenceNode).typeArguments![0];
    return {
      elementType,
      arrayType: declaration.type,
      initializer: current,
      syntax: suffixArray ? 'suffix' as const : 'generic' as const,
    };
  }

  private isDeveloperDefinedTypeNode(typeNode: ts.TypeNode) {
    if (ts.isFunctionTypeNode(typeNode) || ts.isConstructorTypeNode(typeNode)) {
      return !typeNode.getSourceFile().isDeclarationFile;
    }
    const symbolLocation = ts.isTypeReferenceNode(typeNode) ? typeNode.typeName : typeNode;
    let symbol = this.checker.getSymbolAtLocation(symbolLocation);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) {
      symbol = this.checker.getAliasedSymbol(symbol);
    }
    const declarations = symbol?.declarations || (symbol?.valueDeclaration ? [symbol.valueDeclaration] : []);
    return declarations.some((declaration) => {
      const declarationPath = declaration.getSourceFile().fileName.replace(/\\/g, '/').toLowerCase();
      return !/\/node_modules\/typescript\/lib\/lib\.[^/]+\.d\.ts$/u.test(declarationPath);
    });
  }

  private declaredTypeRenderLabels(typeNode: ts.TypeNode) {
    return [
      'Type',
      ...(this.isDeveloperDefinedTypeNode(typeNode) ? ['DeveloperDefined'] : ['System']),
    ];
  }

  private isOperationProviderTypeAtLocation(node: ts.Node) {
    const type = this.checker.getNonNullableType(this.checker.getTypeAtLocation(node));
    if (!(type.flags & ts.TypeFlags.Object)) return false;
    const members = type.getProperties().filter((member) => !member.name.startsWith('__'));
    return members.length > 0 && members.every((member) => {
      const declaration = member.valueDeclaration || member.declarations?.[0] || node;
      const memberType = this.checker.getNonNullableType(
        this.checker.getTypeOfSymbolAtLocation(member, declaration),
      );
      return memberType.getCallSignatures().length > 0;
    });
  }

  private canonicalTypeDeclarationStableId(typeNode: ts.TypeNode) {
    const symbolLocation = ts.isTypeReferenceNode(typeNode) ? typeNode.typeName : typeNode;
    return resolveCanonicalDeclarationStableId(this.checker, symbolLocation);
  }

  private typeMemberRenderParts(member: ts.TypeElement, ownerStableId: string): RenderPartDescriptor[] {
    if (ts.isPropertySignature(member)) {
      const name = `${member.name?.getText(this.sourceFile) || 'field'}${member.questionToken ? '?' : ''}`;
      const typeNode = member.type;
      return [
        {
          stableId: `${ownerStableId}:name`,
          text: name,
          kind: 'value',
          labels: ['Field', 'FieldName', 'TypeMember'],
          order: 0,
          sourceStableId: member.name ? getExtendedStableId(this.sourceFile, member.name) : getExtendedStableId(this.sourceFile, member),
        },
        {
          stableId: `${ownerStableId}:colon`,
          text: ':',
          kind: 'punctuation',
          labels: ['Punctuation', 'TypeMember', 'TypeSeparator'],
          order: 1,
          sourceStableId: getExtendedStableId(this.sourceFile, member),
        },
        {
          stableId: `${ownerStableId}:type`,
          text: typeNode?.getText(this.sourceFile) || 'unknown',
          kind: 'value',
          labels: typeNode ? this.declaredTypeRenderLabels(typeNode) : ['Type', 'System'],
          order: 2,
          sourceStableId: typeNode ? getExtendedStableId(this.sourceFile, typeNode) : getExtendedStableId(this.sourceFile, member),
          canonicalStableId: typeNode ? this.canonicalTypeDeclarationStableId(typeNode) : undefined,
        },
      ];
    }

    if (ts.isIndexSignatureDeclaration(member)) {
      const parameter = member.parameters[0];
      const parameterName = parameter?.name.getText(this.sourceFile) || 'key';
      const keyType = parameter?.type;
      const valueType = member.type;
      return [
        { stableId: `${ownerStableId}:open`, text: '[', kind: 'punctuation', labels: ['IndexSignature', 'Open', 'Punctuation'], order: 0, sourceStableId: getExtendedStableId(this.sourceFile, member) },
        { stableId: `${ownerStableId}:key`, text: parameterName, kind: 'value', labels: ['ArgumentName', 'IndexKey', 'IndexSignature'], order: 1, sourceStableId: parameter ? getExtendedStableId(this.sourceFile, parameter.name) : getExtendedStableId(this.sourceFile, member) },
        { stableId: `${ownerStableId}:key-colon`, text: ':', kind: 'punctuation', labels: ['IndexSignature', 'Punctuation'], order: 2, sourceStableId: getExtendedStableId(this.sourceFile, member) },
        { stableId: `${ownerStableId}:key-type`, text: keyType?.getText(this.sourceFile) || 'string', kind: 'value', labels: keyType ? this.declaredTypeRenderLabels(keyType) : ['Type', 'System'], order: 3, sourceStableId: keyType ? getExtendedStableId(this.sourceFile, keyType) : getExtendedStableId(this.sourceFile, member), canonicalStableId: keyType ? this.canonicalTypeDeclarationStableId(keyType) : undefined },
        { stableId: `${ownerStableId}:close`, text: ']', kind: 'punctuation', labels: ['Close', 'IndexSignature', 'Punctuation'], order: 4, sourceStableId: getExtendedStableId(this.sourceFile, member) },
        { stableId: `${ownerStableId}:value-colon`, text: ':', kind: 'punctuation', labels: ['IndexSignature', 'Punctuation'], order: 5, sourceStableId: getExtendedStableId(this.sourceFile, member) },
        { stableId: `${ownerStableId}:value-type`, text: valueType.getText(this.sourceFile), kind: 'value', labels: this.declaredTypeRenderLabels(valueType), order: 6, sourceStableId: getExtendedStableId(this.sourceFile, valueType), canonicalStableId: this.canonicalTypeDeclarationStableId(valueType) },
      ];
    }

    return [{
      stableId: ownerStableId,
      text: member.getText(this.sourceFile),
      kind: 'value',
      labels: ['Type', 'TypeMember'],
      order: 0,
      sourceStableId: getExtendedStableId(this.sourceFile, member),
    }];
  }

  private materializeDeclaredArrayObjectTypeFamily(
    declaration: ts.VariableDeclaration,
    targetStableId: string,
    typeLiteral: ts.TypeLiteralNode,
    initializer: ts.ArrayLiteralExpression,
  ) {
    const members = [...typeLiteral.members];
    if (members.length < 2) return undefined;
    const rawFamilyStableId = `${targetStableId}:declared-element-type`;
    const pairCount = Math.floor(members.length / 2);
    const pairedIndices = (pairIndex: number) => {
      const indices = [pairIndex, members.length - 1 - pairIndex];
      if (members.length % 2 === 1 && pairIndex === pairCount - 1) {
        indices.splice(1, 0, Math.floor(members.length / 2));
      }
      return indices;
    };
    const leftBraceIds: string[] = [];
    const rightBraceIds: string[] = [];
    for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
      const indices = pairedIndices(pairIndex);
      leftBraceIds.push(this.createNode('ObjectBrace', 'declared object field brace', typeLiteral, {
        labels: ['ObjectBrace', 'ObjectType', 'Open', 'Type'],
        diaName: '',
        actionTextRaw: typeLiteral.getText(this.sourceFile),
        objectBraceSide: 'left',
        objectBracePairIndex: pairIndex,
        objectBracePairCount: pairCount,
        objectBraceFieldIndicesJson: JSON.stringify(indices),
        objectBraceMosaicNeighborStableId: pairIndex === 0 ? targetStableId : undefined,
      }, `${rawFamilyStableId}:brace:left:${pairIndex}`));
      rightBraceIds.push(this.createNode('ObjectBrace', 'declared object field brace', typeLiteral, {
        labels: ['ObjectBrace', 'ObjectType', 'Close', 'Type'],
        diaName: '',
        actionTextRaw: typeLiteral.getText(this.sourceFile),
        objectBraceSide: 'right',
        objectBracePairIndex: pairIndex,
        objectBracePairCount: pairCount,
        objectBraceFieldIndicesJson: JSON.stringify(indices),
      }, `${rawFamilyStableId}:brace:right:${pairIndex}`));
    }
    const familyStableId = leftBraceIds[0];
    [...leftBraceIds, ...rightBraceIds].forEach((stableId) => {
      const brace = this.nodeByStableId(stableId);
      if (brace) brace.objectFamilyStableId = familyStableId;
    });

    const pairIndexForField = (fieldIndex: number) => Math.min(
      fieldIndex,
      members.length - 1 - fieldIndex,
      Math.max(0, pairCount - 1),
    );
    members.forEach((member, fieldIndex) => {
      const fixedName = ts.isPropertySignature(member) ? member.name?.getText(this.sourceFile) : undefined;
      const fieldStableId = this.createNode('Field', fixedName || 'index signature', member, {
        labels: uniqueStrings(['Field', 'ObjectTypeField', 'TypeMember', ...(ts.isIndexSignatureDeclaration(member) ? ['IndexSignature'] : [])]),
        diaName: member.getText(this.sourceFile),
        actionTextRaw: member.getText(this.sourceFile),
        fieldName: fixedName,
        fieldIndex,
        objectFamilyStableId: familyStableId,
        renderPartsLayout: 'horizontal',
        renderPrimaryPartIndex: 0,
        renderPartsJson: JSON.stringify(this.typeMemberRenderParts(member, `${rawFamilyStableId}:field:${fieldIndex}`)),
      }, `${rawFamilyStableId}:field:${fieldIndex}`);
      const pairIndex = pairIndexForField(fieldIndex);
      this.addEdge(undefined, leftBraceIds[pairIndex], undefined, fieldStableId, 'FIELD', {
        label: fixedName || '',
        displayLabel: '',
        fieldName: fixedName,
        fieldIndex,
        layoutFrame: 'horizontal',
      });
      this.addEdge(undefined, fieldStableId, undefined, rightBraceIds[pairIndex], 'FieldJoin', {
        label: fixedName || '',
        displayLabel: '',
        fieldName: fixedName,
        fieldIndex,
        layoutFrame: 'horizontal',
      });
    });

    const closeStableId = this.createNode('FieldJoin', 'declare close', declaration, {
      labels: ['ContainerMethod', 'Declaration', 'Method', 'ObjectType', 'SemanticExpansion', 'Primitive', 'Type', 'TypeFamilyClose'],
      diaName: '>',
      actionTextRaw: declaration.getText(this.sourceFile),
      containerMethodKind: 'declare',
      containerStableId: targetStableId,
      renderPartsLayout: 'horizontal',
      renderPrimaryPartIndex: 0,
      renderPartsJson: JSON.stringify([
        { stableId: `${targetStableId}:generic-close`, text: '>', kind: 'punctuation', labels: ['GenericType', 'System', 'Type'], order: 0, sourceStableId: getExtendedStableId(this.sourceFile, declaration.type!) },
        { stableId: `${targetStableId}:equals`, text: '=', kind: 'operator', labels: ['AssignmentOperator', 'Operator'], order: 1, sourceStableId: getExtendedStableId(this.sourceFile, declaration) },
        { stableId: `${targetStableId}:empty-array`, text: '[]', kind: 'literal', labels: ['ArrayLiteral', 'Literal', 'Value'], order: 2, sourceStableId: getExtendedStableId(this.sourceFile, initializer) },
        { stableId: `${targetStableId}:declare-close`, text: ')', kind: 'punctuation', labels: ['CallBoundary', 'ContainerMethod', 'Declaration', 'Method', 'Virtual'], order: 3, sourceStableId: getExtendedStableId(this.sourceFile, declaration) },
      ] satisfies RenderPartDescriptor[]),
    }, `${targetStableId}:declare-close`);
    const outerRightBrace = this.nodeByStableId(rightBraceIds[0]);
    if (outerRightBrace) outerRightBrace.objectBraceMosaicNeighborStableId = closeStableId;
    return closeStableId;
  }

  private materializeConstInitializerValue(
    declaration: ts.VariableDeclaration,
    constStableId: string,
    initializer: ts.Expression,
    assignmentStableId: string,
  ) {
    if (this.typedEmptyArrayDeclaration(declaration, initializer)) {
      return { firstNodeId: assignmentStableId };
    }

    const nullishCall = (() => {
      const current = unwrapExpression(initializer);
      if (!ts.isCallExpression(current) || current.arguments.length !== 1) return undefined;
      const argument = unwrapExpression(current.arguments[0]);
      return ts.isBinaryExpression(argument)
        && argument.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        ? { call: current, expression: argument }
        : undefined;
    })();
    if (nullishCall) {
      const { call, expression } = nullishCall;
      let branchStableId = this.contextualizeHorizontalStableId(
        getExtendedStableId(this.sourceFile, expression),
      );
      branchStableId = this.createNode(this.expressionBranchKind(expression), 'nullish-coalesce', expression, {
        labels: ['PredicateOperator', 'Call', 'Op', 'System'],
        conditionRaw: expression.left.getText(this.sourceFile),
        conditionStableId: getExtendedStableIdDescriptor(this.sourceFile, expression.left),
        diaName: '??',
        ...this.booleanOperandSemanticExtra(expression),
      }, branchStableId);
      this.materializeBooleanOperandSemantics(expression, branchStableId);
      const branch = this.nodeByStableId(branchStableId);
      const parts = JSON.parse(branch?.renderPartsJson || '[]') as RenderPartDescriptor[];
      const openingText = `${call.expression.getText(this.sourceFile)}(`;
      const callParts = [
        {
          stableId: `${branchStableId}:call-open`,
          text: openingText,
          kind: 'method',
          labels: ['Op', 'CallBoundary', 'System'],
          sourceStableId: getExtendedStableId(this.sourceFile, call.expression),
          order: 0,
        },
        ...parts,
        {
          stableId: `${branchStableId}:call-close`,
          text: ')',
          kind: 'punctuation',
          labels: ['Op', 'CallBoundary', 'System'],
          sourceStableId: getExtendedStableId(this.sourceFile, call),
          order: parts.length + 1,
        },
      ].map((part, order) => ({ ...part, order })) satisfies RenderPartDescriptor[];
      if (branch) {
        branch.renderPartsJson = JSON.stringify(callParts);
        branch.renderPartsLayout = 'horizontal';
        branch.renderPrimaryPartIndex = Math.max(0, callParts.findIndex((part) => part.text === '??'));
        branch.callMosaicOwnerStableId = branchStableId;
      }
      this.registerFirstNode(branchStableId, [
        this.createPendingExit(undefined, constStableId, 'EVAL', 'eval'),
      ]);
      this.addEdge(undefined, constStableId, undefined, branchStableId, 'EVAL', {
        label: 'eval',
        producerRouteRole: 'entry',
        oneWay: true,
      });
      this.addCallEdges(branchStableId, call, this.resolveRenderableCallTarget(call));
      const operatorIndex = callParts.findIndex((part) => part.text === '??');
      const groupStableId = `${assignmentStableId}:optional-returns`;
      const scopeStableIds = [assignmentStableId, branchStableId];
      const addReturn = (
        producerOutcome: 'true' | 'false',
        sourceRenderPartStableId: string | undefined,
      ) => this.addEdge(undefined, branchStableId, undefined, assignmentStableId, 'ASSIGNS_VALUE', {
        label: 'value',
        diaName: 'value',
        displayLabel: 'value',
        producerRouteRole: producerOutcome === 'true' ? 'return-top' : 'return-bottom',
        producerOutcome,
        optionalReturnGroupStableId: groupStableId,
        producerScopeStartOrder: Math.min(branch?.operationIndex ?? 0, this.nodeByStableId(assignmentStableId)?.operationIndex ?? 0),
        producerScopeEndOrder: Math.max(branch?.operationIndex ?? 0, this.nodeByStableId(assignmentStableId)?.operationIndex ?? 0),
        producerScopeStableIds: scopeStableIds,
        sourceRenderPartStableId,
        oneWay: true,
      });
      addReturn('true', callParts[operatorIndex - 1]?.stableId);
      addReturn('false', callParts[operatorIndex + 1]?.stableId);
      return { firstNodeId: branchStableId };
    }

    if (ts.isObjectLiteralExpression(unwrapExpression(initializer))) {
      const objectExpression = unwrapExpression(initializer) as ts.ObjectLiteralExpression;
      const assignment = this.nodeByStableId(assignmentStableId);
      const foldObjectBoundary = Boolean(assignment && objectExpression.properties.length > 0);
      if (foldObjectBoundary && assignment) {
        const assignmentParts = JSON.parse(assignment.renderPartsJson || '[]') as RenderPartDescriptor[];
        const methodIndex = assignmentParts.findIndex((part) => part.kind === 'method');
        if (methodIndex >= 0) assignmentParts[methodIndex].text = 'set(';
        if (objectExpression.properties.length <= 1) {
          assignmentParts.push({
            stableId: assignmentStableId,
            text: '{',
            kind: 'punctuation',
            labels: ['Object'],
            order: assignmentParts.length,
            sourceStableId: getExtendedStableId(this.sourceFile, objectExpression),
          });
        }
        assignment.renderPartsLayout = 'container-overlay-side';
        assignment.renderPrimaryPartIndex = methodIndex >= 0 ? methodIndex : 0;
        assignment.callBoundaryDesign = 'split';
        assignment.callBoundaryRole = 'open';
        assignment.callHasArguments = true;
        assignment.callMosaicOwnerStableId = assignmentStableId;
        assignment.callMosaicRole = 'open';
        assignment.renderPartsJson = JSON.stringify(
          assignmentParts.map((part, order) => ({ ...part, order })),
        );
      }
      const objectEntry = this.createObjectNodes(
        objectExpression,
        0,
        this.buildObjectValueStableId(objectExpression, constStableId),
        [],
        [],
        undefined,
        foldObjectBoundary
          ? {
              openingOwnerStableId: assignmentStableId,
              foldedAssignmentBoundary: { assignmentStableId, declaration },
            }
          : {},
      );
      const objectCompletionStableIds = uniqueStrings(
        objectEntry.exitsToArg.map((exit) => exit.fromId),
      );
      if (!foldObjectBoundary) {
        this.addEdge(undefined, constStableId, undefined, objectEntry.objectStableId, 'EVAL', {
          label: 'eval',
        });
      }
      objectCompletionStableIds.forEach((completionStableId) => {
        this.connectAssignmentResult(completionStableId, assignmentStableId);
      });
      this.describeAssignmentProducer(
        assignmentStableId,
        foldObjectBoundary ? assignmentStableId : objectEntry.objectStableId,
        objectCompletionStableIds,
      );
      return {
        firstNodeId: foldObjectBoundary ? assignmentStableId : objectEntry.objectStableId,
      };
    }

    if (ts.isConditionalExpression(unwrapExpression(initializer))) {
      const conditional = unwrapExpression(initializer) as ts.ConditionalExpression;
      const materializesCollectionResult = collectCallExpressions(conditional)
        .some((callExpression) => this.isCollectionMethodCall(callExpression));
      const conditionFlow = this.runSuppressingHorizontalJoins(() => (
        this.runInHorizontalFlow('Operand', () => this.materializeBooleanConditionFlow(
          conditional.condition,
          [this.createPendingExit(undefined, constStableId, 'EVAL', 'eval')],
        ))
      ));
      const producerEndStableIds: string[] = [];
      const producerOutcomeByEndStableId = new Map<string, 'true' | 'false'>();

      const materializeAlternative = (
        alternative: ts.Expression,
        incomingExits: PendingExit[],
        producerOutcome: 'true' | 'false',
      ) => {
        const collectionTransform = this.runInHorizontalFlow('Operand', () => (
          this.materializeCollectionTransformInitializer(
            '',
            alternative,
            '',
            {
              incomingExits,
              allowDirectAssignment: false,
            },
          )
        ));
        if (collectionTransform) {
          this.connectConditionalCollectionCompletion(
            collectionTransform.controlResultNodeId,
            assignmentStableId,
          );
          producerEndStableIds.push(collectionTransform.resultNodeId);
          producerOutcomeByEndStableId.set(collectionTransform.resultNodeId, producerOutcome);
          return;
        }

        const result = this.runInHorizontalFlow('Operand', () => (
          this.materializeBranchBodyExpression(alternative, incomingExits, {
            suppressTerminalCallResult: true,
          })
        ));
        if (!result.firstNodeId) {
          const literalAlternative = isLiteralInlineCallArgument(unwrapExpression(alternative));
          const alternativeNode = this.createActionNodeFromExpression(alternative, incomingExits, undefined, {
            labels: literalAlternative
              ? ['Value', 'Literal', 'Operand', 'Alternative']
              : ['Operand', 'Alternative'],
            diaName: alternative.getText(this.sourceFile),
          });
          if (materializesCollectionResult) {
            this.configureConditionalAlternativeResult(alternative, alternativeNode.stableId);
            this.connectConditionalAlternative(alternativeNode.stableId, assignmentStableId);
          } else {
            this.connectAssignmentResult(alternativeNode.stableId, assignmentStableId);
          }
          producerEndStableIds.push(alternativeNode.stableId);
          producerOutcomeByEndStableId.set(alternativeNode.stableId, producerOutcome);
          return;
        }
        result.pending.forEach((exit) => {
          const alternativeNode = this.nodeByStableId(exit.fromId);
          if (alternativeNode) {
            alternativeNode.labels = uniqueStrings([...alternativeNode.labels, 'Operand', 'Alternative']);
            alternativeNode.diaName ||= alternative.getText(this.sourceFile);
            alternativeNode.actionTextRaw ||= alternative.getText(this.sourceFile);
          }
          if (materializesCollectionResult) {
            this.configureConditionalAlternativeResult(alternative, exit.fromId);
            this.connectConditionalAlternative(exit.fromId, assignmentStableId, exit.fromKind);
          } else {
            this.connectAssignmentResult(exit.fromId, assignmentStableId, exit.fromKind);
          }
          producerEndStableIds.push(exit.fromId);
          producerOutcomeByEndStableId.set(exit.fromId, producerOutcome);
        });
      };

      materializeAlternative(conditional.whenTrue, conditionFlow.trueExits, 'true');
      materializeAlternative(conditional.whenFalse, conditionFlow.falseExits, 'false');
      this.describeAssignmentProducer(
        assignmentStableId,
        conditionFlow.firstNodeId,
        producerEndStableIds,
        new Map(),
        producerOutcomeByEndStableId,
      );
      return {
        firstNodeId: conditionFlow.firstNodeId,
      };
    }

    const collectionTransformResult = this.runInHorizontalFlow('Operand', () => (
      this.materializeCollectionTransformInitializer(
        constStableId,
        initializer,
        assignmentStableId,
      )
    ));
    if (collectionTransformResult) {
      if (!collectionTransformResult.assignmentConnected) {
        this.connectAssignmentResult(
          collectionTransformResult.resultNodeId,
          assignmentStableId,
        );
      }
      this.describeAssignmentProducer(
        assignmentStableId,
        collectionTransformResult.firstNodeId,
        collectionTransformResult.producerEndStableIds,
      );
      return {
        firstNodeId: collectionTransformResult.firstNodeId,
        controlResultNodeId: collectionTransformResult.controlResultNodeId,
      };
    }

    const currentInitializer = unwrapExpression(initializer);
    const directInitializerExpression = unwrapAwaitedExpression(currentInitializer);
    const initializerCallSiteStableId = (
      ts.isCallExpression(directInitializerExpression) || ts.isNewExpression(directInitializerExpression)
    )
      ? this.withHorizontalOwnerStableId(getExtendedStableId(this.sourceFile, directInitializerExpression))
      : undefined;
    const responseAwareResult = this.runWithRequestResponseTarget(
      assignmentStableId,
      initializerCallSiteStableId,
      () => this.runSuppressingHorizontalJoins(() => this.runInHorizontalFlow('Operand', () => {
        const current = currentInitializer;
        if (!isStructuredControlExpression(current)) {
          const structured = this.materializeStructuredExpressionNode(
            current,
            [this.createPendingExit(undefined, constStableId, 'EVAL', 'eval')],
          );
          if (structured) {
            return structured;
          }
          const expressions = filterExpressionsCoveredByStructuredExpressions(collectMaterializedExpressions(current));
          if (expressions.length) {
            return this.materializeExpressionSteps(
              expressions,
              [this.createPendingExit(undefined, constStableId, 'EVAL', 'eval')],
            );
          }
        }
        return this.materializeExpressionValue(
          initializer,
          [this.createPendingExit(undefined, constStableId, 'EVAL', 'eval')],
          true,
        );
      })),
    );
    const initializerResult = responseAwareResult.value;
    if (initializerResult.firstNodeId) {
      const directInitializerCall = unwrapAwaitedExpression(initializer);
      const directCallStableId = ts.isCallExpression(directInitializerCall)
        ? this.withHorizontalOwnerStableId(getExtendedStableId(this.sourceFile, directInitializerCall))
        : undefined;
      const directCallNode = directCallStableId
        ? this.nodeByStableId(directCallStableId)
        : undefined;
      const directCallTerminalIds = new Set([
        directCallStableId,
        directCallNode?.callBoundaryPeerStableId,
      ].filter((stableId): stableId is string => Boolean(stableId)));
      const directCallResultExits = directCallTerminalIds.size
        ? initializerResult.pending.filter((exit: PendingExit) => directCallTerminalIds.has(exit.fromId))
        : [];
      const assignmentResultExits = directCallResultExits.length
        ? directCallResultExits
        : initializerResult.pending;
      if (responseAwareResult.responseCount === 0) {
        assignmentResultExits.forEach((exit: PendingExit) => {
          this.connectAssignmentResult(
            exit.fromId,
            assignmentStableId,
            exit.fromKind,
          );
        });
      }
      this.describeAssignmentProducer(
        assignmentStableId,
        initializerResult.firstNodeId,
        assignmentResultExits.map((exit: PendingExit) => exit.fromId),
      );
      return {
        firstNodeId: initializerResult.firstNodeId,
      };
    }

    const evaluationStableId = this.createNode('Action', 'evaluate', initializer, {
      ...this.executionPrimitiveExtra(executionPrimitive('evaluate'), [
        'Expression',
        'SemanticExpansion',
      ]),
      diaName: initializer.getText(this.sourceFile),
      actionTextRaw: initializer.getText(this.sourceFile),
      semanticExpansion: 'primitive-execution',
      instrumentationPhase: 'around',
      instrumentationTargetStableId: getExtendedStableId(this.sourceFile, initializer),
      synthetic: true,
    }, `${assignmentStableId}:evaluate`);
    this.connectAssignmentResult(evaluationStableId, assignmentStableId);
    this.describeAssignmentProducer(
      assignmentStableId,
      evaluationStableId,
      [evaluationStableId],
    );
    return { firstNodeId: evaluationStableId };
  }

  private createAssignmentPrimitive(
    declaration: ts.VariableDeclaration,
    targetStableId: string,
    initializer: ts.Expression,
    binding: ts.Identifier,
  ) {
    const container = this.nodeByStableId(targetStableId);
    if (!container) {
      throw new Error(`Assignment container node not found: ${targetStableId}`);
    }
    const containerName = binding.text;
    const emptyArrayDeclaration = this.typedEmptyArrayDeclaration(declaration, initializer);
    if (emptyArrayDeclaration) {
      const developerDefinedElementType = this.isDeveloperDefinedTypeNode(emptyArrayDeclaration.elementType);
      const { labels: primitiveLabels = [], ...primitive } = this.executionPrimitiveExtra(
        executionPrimitive('declare'),
        ['Collection', 'ContainerMethod', 'Declaration', 'LocalBinding', 'Method', 'SemanticExpansion', 'ValueCreate', 'ValueSlot'],
      );
      container.labels = uniqueStrings([...(container.labels || []), ...primitiveLabels]);
      Object.assign(container, primitive);
      container.containerStableId = targetStableId;
      container.containerMethodKind = 'declare';
      container.containerState = 'assigned';
      container.operationSubjectText = containerName;
      container.operationValueText = `${emptyArrayDeclaration.arrayType.getText(this.sourceFile)} = ${initializer.getText(this.sourceFile)}`;
      container.actionTextRaw = declaration.getText(this.sourceFile);
      container.semanticExpansion = 'primitive-execution';
      container.instrumentationPhase = 'after';
      container.instrumentationTargetStableId = getExtendedStableId(this.sourceFile, declaration);
      container.renderPartsLayout = 'container-overlay-side';
      container.renderPrimaryPartIndex = 1;
      const expandedObjectType = emptyArrayDeclaration.syntax === 'generic'
        && ts.isTypeLiteralNode(emptyArrayDeclaration.elementType)
        && emptyArrayDeclaration.elementType.members.length > 1;
      container.renderPartsJson = JSON.stringify([
        {
          stableId: targetStableId,
          text: containerName,
          kind: 'collection-container',
          labels: uniqueStrings((container.labels || []).filter((label) => label !== 'Method')),
          order: 0,
          fillState: 'empty',
          sourceStableId: getExtendedStableId(this.sourceFile, binding),
        },
        {
          stableId: `${targetStableId}:declare`,
          text: 'declare(',
          kind: 'method',
          labels: ['ContainerMethod', 'Declaration', 'Method', 'Virtual'],
          order: 1,
          sourceStableId: getExtendedStableId(this.sourceFile, declaration),
        },
        ...(!expandedObjectType ? [{
          stableId: `${targetStableId}:element-type`,
          text: emptyArrayDeclaration.elementType.getText(this.sourceFile),
          kind: 'value',
          labels: developerDefinedElementType
            ? ['Type', 'DeveloperDefined']
            : ['Type', 'System'],
          order: 2,
          sourceStableId: getExtendedStableId(this.sourceFile, emptyArrayDeclaration.elementType),
        }, {
          stableId: `${targetStableId}:array-type`,
          text: emptyArrayDeclaration.syntax === 'suffix' ? '[]' : '>',
          kind: 'punctuation',
          labels: emptyArrayDeclaration.syntax === 'suffix'
            ? ['ArrayType', 'Punctuation', 'Type']
            : ['GenericType', 'System', 'Type'],
          order: 3,
          sourceStableId: getExtendedStableId(this.sourceFile, emptyArrayDeclaration.arrayType),
        }, {
          stableId: `${targetStableId}:equals`,
          text: '=',
          kind: 'operator',
          labels: ['AssignmentOperator', 'Operator'],
          order: 4,
          sourceStableId: getExtendedStableId(this.sourceFile, declaration),
        },
        {
          stableId: `${targetStableId}:empty-array`,
          text: '[]',
          kind: 'literal',
          labels: ['ArrayLiteral', 'Literal', 'Value'],
          order: 5,
          sourceStableId: getExtendedStableId(this.sourceFile, emptyArrayDeclaration.initializer),
        },
        {
          stableId: `${targetStableId}:declare-close`,
          text: ')',
          kind: 'punctuation',
          labels: ['CallBoundary', 'ContainerMethod', 'Declaration', 'Method', 'Virtual'],
          order: 6,
          sourceStableId: getExtendedStableId(this.sourceFile, declaration),
        }] : [{
          stableId: `${targetStableId}:generic-open`,
          text: 'Array<',
          kind: 'punctuation' as const,
          labels: ['GenericType', 'Open', 'System', 'Type'],
          order: 2,
          sourceStableId: getExtendedStableId(this.sourceFile, emptyArrayDeclaration.arrayType),
        }]),
      ] satisfies RenderPartDescriptor[]);
      if (expandedObjectType) {
        container.opensObjectFieldFamily = true;
        this.materializeDeclaredArrayObjectTypeFamily(
          declaration,
          targetStableId,
          emptyArrayDeclaration.elementType as ts.TypeLiteralNode,
          emptyArrayDeclaration.initializer,
        );
      }
      return targetStableId;
    }

    const { labels: primitiveLabels = [], ...primitive } = this.executionPrimitiveExtra(executionPrimitive('assign'), [
      'Assignment',
      'ContainerMethod',
      'Method',
      'SemanticExpansion',
      'Set',
    ]);
    container.labels = uniqueStrings([...(container.labels || []), ...primitiveLabels]);
    Object.assign(container, primitive);
    container.containerStableId = targetStableId;
    container.containerMethodKind = 'set';
    container.containerState = 'awaiting-assignment';
    container.operationSubjectText = containerName;
    container.operationValueText = initializer.getText(this.sourceFile);
    container.actionTextRaw = declaration.getText(this.sourceFile);
    container.semanticExpansion = 'primitive-execution';
    container.instrumentationPhase = 'after';
    container.instrumentationTargetStableId = getExtendedStableId(this.sourceFile, declaration);
    const inlineLiteralInitializer = isLiteralInlineCallArgument(unwrapExpression(initializer));
    container.renderPartsLayout = ts.isConditionalExpression(unwrapExpression(initializer))
      || inlineLiteralInitializer
      ? 'container-overlay-side'
      : 'container-overlay';
    container.renderPrimaryPartIndex = 0;
    const assignmentParts = [
      {
        stableId: targetStableId,
        text: containerName,
        kind: container.labels?.includes('Collection') ? 'collection-container' : 'value-container',
        labels: uniqueStrings((container.labels || []).filter((label) => label !== 'Method')),
        order: 0,
        fillState: 'empty',
        sourceStableId: getExtendedStableId(this.sourceFile, binding),
      },
      {
        stableId: `${targetStableId}:set`,
        text: inlineLiteralInitializer ? 'set(' : 'set',
        kind: 'method',
        labels: ['Assignment', 'ContainerMethod', 'Method', 'Set'],
        order: 1,
        sourceStableId: getExtendedStableId(this.sourceFile, declaration),
      },
      ...(inlineLiteralInitializer ? [{
        stableId: `${targetStableId}:set-value`,
        text: unwrapExpression(initializer).getText(this.sourceFile),
        kind: 'literal' as const,
        labels: literalValueLabels(unwrapExpression(initializer)),
        order: 2,
        fillState: 'filled' as const,
        sourceStableId: getExtendedStableId(this.sourceFile, unwrapExpression(initializer)),
      }, {
        stableId: `${targetStableId}:set-close`,
        text: ')',
        kind: 'punctuation' as const,
        labels: ['Op', 'CallBoundary', 'Virtual'],
        order: 3,
        fillState: 'filled' as const,
        sourceStableId: getExtendedStableId(this.sourceFile, declaration),
      }] : []),
      ...(ts.isConditionalExpression(unwrapExpression(initializer))
        && collectCallExpressions(unwrapExpression(initializer))
          .some((callExpression) => this.isCollectionMethodCall(callExpression)) ? [{
        stableId: `${targetStableId}:result`,
        text: 'result',
        kind: 'virtual-value' as const,
        labels: ['Value', 'Variable', 'Virtual', 'Result', 'ComputedValue', 'SemanticExpansion', 'Primitive'],
        order: 2,
        fillState: 'filled' as const,
        sourceStableId: getExtendedStableId(this.sourceFile, initializer),
      }] : []),
    ] satisfies RenderPartDescriptor[];
    container.renderPartsJson = JSON.stringify(materializeAttachedMethodArgumentMosaic(
      assignmentParts,
      targetStableId,
      getExtendedStableId(this.sourceFile, declaration),
    ));
    return targetStableId;
  }

  private configureConditionalAlternativeResult(
    alternative: ts.Expression,
    alternativeStableId: string,
  ) {
    const current = unwrapExpression(alternative);
    if (!isLiteralInlineCallArgument(current)) return;
    const node = this.nodeByStableId(alternativeStableId);
    if (!node) return;
    const valueText = current.getText(this.sourceFile);
    node.labels = uniqueStrings([
      ...(node.labels || []),
      'Method',
      'Value',
      'Variable',
      'Virtual',
      'SemanticExpansion',
      'Primitive',
      'ContainerMethod',
      'Set',
      'Alternative',
      'Assignment',
      'ComputedValue',
      'Result',
    ]);
    node.diaName = 'result';
    node.operationSubjectText = 'result';
    node.operationValueText = valueText;
    node.semanticExpansion = 'primitive-execution';
    node.containerMethodKind = 'set';
    node.containerState = 'awaiting-assignment';
    node.dataFlowRole = 'result';
    node.conditionalAlternativePlacement = 'down';
    node.renderPartsLayout = 'container-overlay-side';
    node.renderPrimaryPartIndex = 0;
    node.renderPartsJson = JSON.stringify([
      {
        stableId: `${alternativeStableId}:result`,
        text: 'result',
        kind: 'value-container',
        labels: ['Value', 'Variable', 'Virtual', 'Result', 'ComputedValue', 'SemanticExpansion', 'Primitive'],
        order: 0,
        fillState: 'empty',
      },
      {
        stableId: alternativeStableId,
        text: 'set(',
        kind: 'method',
        labels: ['Method', 'Assignment', 'ContainerMethod', 'Set', 'SemanticExpansion', 'Primitive'],
        order: 1,
      },
      {
        stableId: `${alternativeStableId}:value`,
        text: valueText,
        kind: 'literal',
        labels: literalValueLabels(current, ['Alternative']),
        order: 2,
        sourceStableId: getExtendedStableId(this.sourceFile, current),
      },
      {
        stableId: `${alternativeStableId}:close`,
        text: ')',
        kind: 'punctuation',
        labels: ['Op', 'CallBoundary'],
        order: 3,
        sourceStableId: getExtendedStableId(this.sourceFile, current),
      },
    ] satisfies RenderPartDescriptor[]);
  }

  private describeAssignmentProducer(
    assignmentStableId: string,
    firstNodeId: string,
    endStableIds: string[],
    producerRouteRoleByEndStableId: ReadonlyMap<string, 'return-top' | 'return-bottom'> = new Map(),
    producerOutcomeByEndStableId: ReadonlyMap<string, 'true' | 'false'> = new Map(),
  ) {
    const assignment = this.nodeByStableId(assignmentStableId);
    if (!assignment) return;
    const uniqueEndStableIds = uniqueStrings(endStableIds);
    const directEnd = uniqueEndStableIds.length === 1
      ? this.nodeByStableId(uniqueEndStableIds[0])
      : undefined;
    const directCallResult = directEnd?.resultOfCallStableId === firstNodeId;
    assignment.producerStartStableId = firstNodeId;
    assignment.producerEndStableIds = uniqueEndStableIds;
    assignment.producerChainKind = (
      uniqueEndStableIds.length === 1
      && (uniqueEndStableIds[0] === firstNodeId || directCallResult)
    ) ? 'simple' : 'compound';
    const producerRoot = this.nodeByStableId(firstNodeId);
    const producerRootRange = producerRoot?.stableId;
    const producerFamilyNodes = producerRootRange
      ? this.nodes.filter((node) => {
          const range = node.stableId;
          const startsInside = range.startLine > producerRootRange.startLine
            || (
              range.startLine === producerRootRange.startLine
              && range.startColumn >= producerRootRange.startColumn
            );
          const endsInside = range.endLine < producerRootRange.endLine
            || (
              range.endLine === producerRootRange.endLine
              && range.endColumn <= producerRootRange.endColumn
            );
          return startsInside && endsInside;
        })
      : [];
    const producerScopeStableIds = uniqueStrings([
      assignmentStableId,
      firstNodeId,
      ...uniqueEndStableIds,
      ...producerFamilyNodes.map((node) => getStableIdKey(node.stableId)),
    ]);
    const producerScopeOrders = [
      assignment.operationIndex,
      this.nodeByStableId(firstNodeId)?.operationIndex,
      ...uniqueEndStableIds.map((stableId) => this.nodeByStableId(stableId)?.operationIndex),
      ...producerFamilyNodes.map((node) => node.operationIndex),
    ].filter((value): value is number => Number.isFinite(value));
    const producerScopeStartOrder = producerScopeOrders.length
      ? Math.min(...producerScopeOrders)
      : undefined;
    const producerScopeEndOrder = producerScopeOrders.length
      ? Math.max(...producerScopeOrders)
      : undefined;
    const containerStableId = assignment.containerStableId;
    for (const edge of this.edges) {
      if (edge.type === 'EVAL' && edge.fromId === containerStableId && edge.toId === firstNodeId) {
        edge.producerRouteRole = 'entry';
        edge.oneWay = true;
      }
      const producerIndex = uniqueEndStableIds.indexOf(edge.fromId);
      if (
        (edge.type === 'ASSIGNS_VALUE' || edge.type === 'YIELDS_VALUE')
        && edge.toId === assignmentStableId
        && producerIndex >= 0
      ) {
        const producerOutcome = producerOutcomeByEndStableId.get(edge.fromId);
        if (producerOutcome) {
          edge.producerOutcome = producerOutcome;
          edge.optionalReturnGroupStableId = `${assignmentStableId}:optional-returns`;
        } else {
          edge.producerRouteRole = producerRouteRoleByEndStableId.get(edge.fromId)
            || (uniqueEndStableIds.length > 1 && producerIndex === 0
              ? 'return-top'
              : 'return-bottom');
        }
        edge.oneWay = true;
        edge.producerScopeStartOrder = producerScopeStartOrder;
        edge.producerScopeEndOrder = producerScopeEndOrder;
        edge.producerScopeStableIds = producerScopeStableIds;
      }
    }
  }

  private connectAssignmentResult(
    sourceId: string,
    assignmentStableId: string,
    sourceKind: 'Fn' | undefined = undefined,
  ) {
    this.addEdge(sourceKind, sourceId, undefined, assignmentStableId, 'ASSIGNS_VALUE', {
      label: 'value',
      semanticExpansion: 'primitive-execution',
      ...(this.nodeByStableId(sourceId)?.labels?.includes('Field')
        && this.nodeByStableId(sourceId)?.labels?.includes('Join') ? {
          producerRouteRole: 'return-bottom' as const, protocolRole: 'assignment-return',
          sourcePort: 'bottom', targetPort: 'bottom',
          sourcePortCandidates: ['bottom'], targetPortCandidates: ['bottom'], lockPortCandidates: true,
        } : {}),
    });
    if (this.nodeByStableId(sourceId)?.labels?.includes('Field')
      && this.nodeByStableId(sourceId)?.labels?.includes('Join')) {
      this.describeAssignmentProducer(assignmentStableId, sourceId, [sourceId]);
    }
  }

  private connectConditionalAlternative(
    sourceId: string,
    assignmentStableId: string,
    sourceKind: 'Fn' | undefined = undefined,
  ) {
    this.addEdge(sourceKind, sourceId, undefined, assignmentStableId, 'YIELDS_VALUE', {
      label: 'value',
      displayLabel: 'value',
      flowLayer: 'data',
      semanticExpansion: 'conditional-assignment',
      protocolRole: 'assignment-return',
    });
  }

  private connectConditionalCollectionCompletion(
    completionStableId: string,
    assignmentStableId: string,
  ) {
    const completionKey = getStableIdKey(completionStableId);
    const exhaustionEdges = this.edges.filter((edge) => (
      getStableIdKey(edge.toId) === completionKey
      && edge.type === 'FALSE'
    ));
    for (const edge of exhaustionEdges) {
      edge.toId = assignmentStableId;
      edge.semanticExpansion = 'conditional-assignment';
      edge.protocolRole = 'assignment-return';
    }
  }

  private standardCollectionTransform(expression: ts.Expression) {
    let receiver = unwrapExpression(expression);
    const stages: Array<{
      callExpression: ts.CallExpression;
      methodName: string;
      callback: ts.ArrowFunction | ts.FunctionExpression;
      callbackIndex: number;
    }> = [];

    while (ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression)) {
      const callbackIndex = receiver.arguments.findIndex((argument) => {
        const current = unwrapExpression(argument);
        return ts.isArrowFunction(current) || ts.isFunctionExpression(current);
      });
      const callback = callbackIndex >= 0
        ? unwrapExpression(receiver.arguments[callbackIndex])
        : undefined;
      const methodName = receiver.expression.name.text;
      const methodReceiver = unwrapExpression(receiver.expression.expression);
      if (
        callbackIndex < 0
        || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))
        || !isKnownCollectionMethod(methodName)
        || !this.isCollectionExpression(methodReceiver)
      ) break;
      stages.unshift({
        callExpression: receiver,
        methodName,
        callback,
        callbackIndex,
      });
      receiver = unwrapExpression(receiver.expression.expression);
    }

    return stages.length ? { receiver, stages } : undefined;
  }

  private buildFnVisualProxyStableId(callStableId: string, targetStableId: string) {
    return `visual:fn:${sanitizeSyntheticExternalPart(callStableId)}->${sanitizeSyntheticExternalPart(targetStableId)}`;
  }

  private canonicalStableIdForExpression(expression: ts.Expression) {
    let symbol = this.checker.getSymbolAtLocation(expression);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      symbol = this.checker.getAliasedSymbol(symbol);
    }
    const declaration = symbol?.valueDeclaration || symbol?.declarations?.[0];
    if (!declaration || declaration.getSourceFile().isDeclarationFile) return undefined;
    return getExtendedStableId(declaration.getSourceFile(), declaration);
  }

  private bindingStableIdForExpression(expression: ts.Expression) {
    let current = unwrapExpression(expression);
    while (
      isPropertyAccessLikeExpression(current)
      || ts.isElementAccessExpression(current)
    ) {
      current = unwrapExpression(current.expression);
    }
    let symbol = this.checker.getSymbolAtLocation(current);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      symbol = this.checker.getAliasedSymbol(symbol);
    }
    const declaration = symbol?.valueDeclaration || symbol?.declarations?.[0];
    if (!declaration || declaration.getSourceFile().isDeclarationFile) return undefined;
    return getExtendedStableId(declaration.getSourceFile(), declaration);
  }

  private bindingNodeStableIdForExpression(expression: ts.Expression) {
    let current = unwrapExpression(expression);
    while (
      isPropertyAccessLikeExpression(current)
      || ts.isElementAccessExpression(current)
    ) {
      current = unwrapExpression(current.expression);
    }
    let symbol = this.checker.getSymbolAtLocation(current);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      symbol = this.checker.getAliasedSymbol(symbol);
    }
    const declaration = symbol?.valueDeclaration || symbol?.declarations?.[0];
    if (!declaration || declaration.getSourceFile().isDeclarationFile) return undefined;
    if (
      (ts.isVariableDeclaration(declaration)
        || ts.isParameter(declaration)
        || ts.isBindingElement(declaration))
      && declaration.name
    ) {
      return getExtendedStableId(declaration.getSourceFile(), declaration.name);
    }
    return getExtendedStableId(declaration.getSourceFile(), declaration);
  }

  private materializeExpressionReceiverOccurrences(
    expression: ts.Expression,
    sequenceOwnerStableId: string,
  ) {
    const materialized = new Set<string>();
    const visit = (node: ts.Node) => {
      if (isPropertyAccessLikeExpression(node) || ts.isElementAccessExpression(node)) {
        const parent = node.parent;
        const isNestedReceiver = (
          (isPropertyAccessLikeExpression(parent) || ts.isElementAccessExpression(parent))
          && unwrapExpression(parent.expression) === node
        );
        if (!isNestedReceiver) {
          let receiver = unwrapExpression(node.expression);
          let hasElementAccess = ts.isElementAccessExpression(node);
          while (
            isPropertyAccessLikeExpression(receiver)
            || ts.isElementAccessExpression(receiver)
          ) {
            hasElementAccess ||= ts.isElementAccessExpression(receiver);
            receiver = unwrapExpression(receiver.expression);
          }
          const accessStableId = this.contextualizeHorizontalStableId(
            getExtendedStableId(this.sourceFile, node),
          );
          const accessExists = this.nodes.some(
            (candidate) => getStableIdKey(candidate.stableId) === accessStableId,
          );
          if (accessExists && !materialized.has(accessStableId)) {
            materialized.add(accessStableId);
            const receiverType = this.checker.getTypeAtLocation(receiver);
            const receiverText = receiver.getText(this.sourceFile);
            const receiverStableId = this.createNode('Read', receiverText, receiver, {
              labels: uniqueStrings([
                'Receiver',
                'Occurrence',
                ...(hasElementAccess || this.isCollectionType(receiverType)
                  ? ['Collection']
                  : ['Object']),
              ]),
              diaName: receiverText,
              actionTextRaw: receiverText,
              operationCode: 'value-access-receiver',
              operationSubjectText: receiverText,
              canonicalStableId: this.canonicalStableIdForExpression(receiver),
              bindingStableId: this.bindingStableIdForExpression(receiver),
              semanticExpansion: 'value-access',
              sequenceAxisKind: 'value-access-receiver',
              sequenceOwnerStableId,
              flowLayer: 'data',
              dataFlowRole: 'input',
              renderHidden: true,
              synthetic: true,
            }, `${accessStableId}:receiver`);
            this.addEdge(undefined, receiverStableId, undefined, accessStableId, 'ON_RECEIVER', {
              label: '',
              flowLayer: 'data',
              semanticExpansion: 'value-access',
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(unwrapExpression(expression));
  }

  private materializeMethodReceiver(callExpression: ts.CallExpression, callStableId: string) {
    const callee = unwrapExpression(callExpression.expression);
    if (!isPropertyAccessLikeExpression(callee)) return undefined;
    const receiver = unwrapExpression(callee.expression);
    const receiverType = this.checker.getTypeAtLocation(receiver);
    const receiverText = receiver.getText(this.sourceFile);
    const receiverStableId = `${callStableId}:receiver`;
    const receiverLabels = this.isCollectionType(receiverType)
      ? ['Receiver', 'Occurrence', 'Collection']
      : (receiverType.flags & ts.TypeFlags.Object) !== 0
        ? ['Receiver', 'Occurrence', 'Object']
        : ['Receiver', 'Occurrence', 'Value'];
    return this.createNode('Read', receiverText, receiver, {
      labels: uniqueStrings([...receiverLabels, ...this.operationProviderLabels(callExpression)]),
      diaName: receiverText,
      operationSubjectText: receiverText,
      actionTextRaw: receiverText,
      canonicalStableId: this.canonicalStableIdForExpression(receiver),
      sourceCallStableId: callStableId,
      flowLayer: 'data',
      dataFlowRole: 'input',
      renderHidden: true,
      synthetic: true,
    }, receiverStableId);
  }

  private materializeCallReceiver(callExpression: ts.CallExpression, callStableId: string) {
    return this.materializeMethodReceiver(callExpression, callStableId);
  }

  private createFnVisualProxy(
    callExpression: ts.CallExpression,
    callStableId: string,
    target: ResolvedCallTarget | undefined,
    callRoleLabel: 'Read' | 'Write' | 'Request' | 'Call' | 'Op',
    options: {
      materializeReceiver?: boolean;
      stableIdOverride?: string;
      foldedObjectArgument?: ts.ObjectLiteralExpression;
    } = {},
  ) {
    const callee = unwrapExpression(callExpression.expression);
    const methodName = isPropertyAccessLikeExpression(callee)
      ? callee.name.text
      : getCallLikeName(callExpression.expression);
    const hasOriginal = Boolean(target && target.targetKind !== 'synthetic-external');
    const developerSide = hasOriginal || this.isDeveloperSideCallExpression(callExpression, target);
    const targetIdentity = hasOriginal ? target!.stableId : `system:${methodName || 'call'}`;
    const proxyName = target?.name || methodName || formatCallDiaName(callExpression, this.sourceFile);
    const openingNode = this.nodeByStableId(callStableId);
    const splitClosure = openingNode?.callBoundaryRole === 'open';
    const visualProxyStableId = options.stableIdOverride
      || this.buildFnVisualProxyStableId(callStableId, targetIdentity);
    const foldedObjectArgument = options.foldedObjectArgument;
    const expandedFoldedObject = Boolean(foldedObjectArgument && foldedObjectArgument.properties.length > 1);
    const proxyStableId = this.createNode('FnVisualProxy', proxyName, callExpression, {
      labels: uniqueStrings([
        'VisualProxy',
        'FnVisualProxy',
        'PresentationOnly',
        ...(foldedObjectArgument ? ['Field', 'Join', 'Object', 'Arg'] : []),
        callRoleLabel,
        ...(isPropertyAccessLikeExpression(callee) ? ['Method'] : []),
        ...(!developerSide ? ['System'] : ['Fn']),
        ...(!foldedObjectArgument && this.isCollectionMethodCall(callExpression) ? ['Collection'] : []),
      ]),
      diaName: foldedObjectArgument ? (expandedFoldedObject ? ')' : '})') : splitClosure ? ')' : proxyName,
      operationSubjectText: target?.name || methodName,
      actionTextRaw: callExpression.getText(this.sourceFile),
      calleeStableId: hasOriginal
        ? buildOpaqueStableIdDescriptor(target!.stableId, target!.repoRelativePath)
        : undefined,
      sourceCallStableId: callStableId,
      canonicalStableId: hasOriginal ? target!.stableId : undefined,
      synthetic: true,
      ...this.callBoundaryExtra(callExpression, 'close', openingNode?.callPredicate === true),
      callBoundaryPeerStableId: callStableId,
      callMosaicOwnerStableId: foldedObjectArgument ? callStableId : undefined,
      callMosaicRole: foldedObjectArgument ? 'close' : undefined,
      renderPartsJson: JSON.stringify(foldedObjectArgument
        ? expandedFoldedObject
          ? [{
              stableId: visualProxyStableId,
              text: ')',
              kind: 'method',
              labels: ['Op', 'Method', 'Call', 'VisualProxy'],
              order: 0,
              sourceStableId: getExtendedStableId(this.sourceFile, callExpression),
            } satisfies RenderPartDescriptor]
          : [
            {
              stableId: visualProxyStableId,
              text: '}',
              kind: 'punctuation',
              labels: ['Field', 'Join'],
              order: 0,
              sourceStableId: getExtendedStableId(this.sourceFile, foldedObjectArgument),
            },
            {
              stableId: visualProxyStableId,
              text: ')',
              kind: 'method',
              labels: ['Op', 'Method', 'Call', 'VisualProxy'],
              order: 1,
              sourceStableId: getExtendedStableId(this.sourceFile, callExpression),
            },
          ] satisfies RenderPartDescriptor[]
        : [{
            stableId: visualProxyStableId,
            text: splitClosure ? ')' : proxyName,
            kind: 'method',
            labels: ['VisualProxy', 'FnVisualProxy'],
            order: 0,
            sourceStableId: callStableId,
          } satisfies RenderPartDescriptor]),
      renderPartsLayout: foldedObjectArgument ? 'horizontal' : 'single',
      renderPrimaryPartIndex: 0,
    }, visualProxyStableId);
    if (openingNode?.callBoundaryRole === 'open') {
      openingNode.callBoundaryPeerStableId = proxyStableId;
    }
    this.addEdge(undefined, callStableId, undefined, proxyStableId, 'INVOKES', {
      label: proxyName,
      invocationType: callRoleLabel === 'Op' ? 'CALL' : callRoleLabel.toUpperCase(),
      semanticExpansion: 'receiver-method',
    });
    const receiverStableId = options.materializeReceiver === false
      ? undefined
      : this.materializeMethodReceiver(callExpression, callStableId);
    if (receiverStableId) {
      this.addEdge(undefined, proxyStableId, undefined, receiverStableId, 'ON_RECEIVER', {
        label: 'receiver',
        semanticExpansion: 'receiver-method',
      });
    }
    return proxyStableId;
  }

  private executionPrimitiveExtra(
    primitive: ExecutionPrimitiveSpec,
    labels: string[] = [],
  ): FlowNodeExtra {
    const primitiveLabel = primitive.kind
      .split('-')
      .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : '')
      .join('');
    return {
      labels: uniqueStrings(['Primitive', primitiveLabel, ...labels]),
      primitiveKind: primitive.kind,
      runtimeEventKind: primitive.runtimeEventKind,
      instrumentationStrategy: primitive.instrumentationStrategy,
      flowLayer: primitive.flowLayer,
      dataFlowRole: primitive.flowLayer === 'control' ? undefined : 'operation',
    };
  }

  private collectionResultEdgeType(
    primitive: ExecutionPrimitiveSpec,
  ): Extract<
    FlowEdgeKind,
    'YIELDS_VALUE' | 'EMITS_VALUE' | 'ACCUMULATES_VALUE' | 'DECIDES_VALUE' | 'PERFORMS_EFFECT' | 'ORDERS_VALUE'
  > {
    switch (primitive.kind) {
      case 'emit':
        return 'EMITS_VALUE';
      case 'accumulate':
        return 'ACCUMULATES_VALUE';
      case 'branch':
        return 'DECIDES_VALUE';
      case 'effect':
        return 'PERFORMS_EFFECT';
      case 'order':
        return 'ORDERS_VALUE';
      default:
        return 'YIELDS_VALUE';
    }
  }

  private materializeCollectionIterationEntry(
    stage: {
      callExpression: ts.CallExpression;
      methodName: string;
      callback: ts.ArrowFunction | ts.FunctionExpression;
    },
    stageStableId: string,
    previousStageStableId: string,
    semantics: CollectionMethodSemantics,
    options: {
      directConsumer?: boolean;
      reuseStageAsRoot?: boolean;
      materializeExhaustedMarker?: boolean;
      mergePullIntoSource?: boolean;
      mergeCompletionIntoResult?: boolean;
      exhaustedTargetStableId?: string;
    } = {},
  ) {
    const execution = collectionExecutionProtocol(semantics);
    const itemParameter = stage.callback.parameters[semantics.itemParameterIndex];
    const loopStableId = options.reuseStageAsRoot
      ? stageStableId
      : this.contextualizeHorizontalStableId(
          `${stageStableId}:collection-loop`,
          stage.callExpression,
        );
    const pullStableId = options.mergePullIntoSource
      ? previousStageStableId
      : this.contextualizeHorizontalStableId(
          `${loopStableId}:pull`,
          stage.callExpression,
        );
    const iterationStableId = this.contextualizeHorizontalStableId(
      `${stageStableId}:iteration`,
      stage.callback,
    );
    const pulledValueStableId = iterationStableId;
    const iterationValueStableId = iterationStableId;
    const iterationResultStableId = this.contextualizeHorizontalStableId(
      `${iterationStableId}:result`,
      stage.callback,
    );
    const materializeExhaustedMarker = options.materializeExhaustedMarker === true;
    const exhaustedStableId = materializeExhaustedMarker
      ? this.contextualizeHorizontalStableId(
          `${loopStableId}:outcome:exhausted`,
          stage.callExpression,
        )
      : pullStableId;
    const completionStableId = options.mergeCompletionIntoResult
      ? semantics.resultMode === 'element'
        ? iterationStableId
        : iterationResultStableId
      : this.contextualizeHorizontalStableId(
          `${loopStableId}:complete`,
          stage.callExpression,
        );
    const common = {
      collectionMethod: stage.methodName,
      collectionIterationMode: semantics.iterationMode,
      collectionResultMode: semantics.resultMode,
      collectionShortCircuit: semantics.shortCircuit,
      collectionReverse: semantics.reverse,
      collectionMutatesReceiver: semantics.mutatesReceiver,
      collectionLoopStableId: loopStableId,
      collectionIterationStableId: iterationStableId,
      semanticExpansion: 'collection-iteration',
    };

    if (!options.reuseStageAsRoot) {
      this.createNode('Loop', `${stage.methodName} loop`, stage.callExpression, {
        ...this.executionPrimitiveExtra(execution.iterate, [
          'Collection',
          'Iterator',
          'Loop',
          'SemanticExpansion',
        ]),
        diaName: `${stage.methodName} loop`,
        actionTextRaw: stage.callExpression.getText(this.sourceFile),
        ...common,
        collectionPreviousStageStableId: previousStageStableId,
        executionScopeKind: 'collection-iterator',
        sequenceOwnerStableId: loopStableId,
        instrumentationPhase: 'before',
        instrumentationTargetStableId: getExtendedStableId(this.sourceFile, stage.callExpression),
        synthetic: true,
      }, loopStableId);
    }
    if (options.mergePullIntoSource) {
      const source = this.nodeByStableId(previousStageStableId);
      if (!source) throw new Error(`Collection source is missing: ${previousStageStableId}`);
      const sourceText = String(
        source.labels.includes('Result')
          ? source.diaName
          : source.actionTextRaw || source.operationSubjectText || source.diaName || 'collection',
      );
      const sourceName = String(source.operationSubjectText || '').startsWith('...')
        && !sourceText.startsWith('...')
        ? `...${sourceText}`
        : sourceText;
      source.labels = uniqueStrings([
        'Op',
        ...source.labels.filter((label) => (
          label !== 'Read'
          && label !== 'ValueRead'
        )),
        'Collection',
        'Receiver',
        'Occurrence',
        'Primitive',
        'Pull',
        'Shift',
        'Method',
        'ContainerMethod',
        'SemanticExpansion',
      ]);
      source.label = 'shift';
      source.diaName = 'shift';
      source.operationCode = 'collection-shift';
      source.operationSubjectText = sourceName;
      delete source.valueAction;
      delete source.valueActions;
      delete source.valueOperationSyntax;
      source.renderPartsLayout = 'container-overlay';
      source.renderPartsJson = JSON.stringify([
        {
          stableId: previousStageStableId,
          text: sourceName,
          kind: 'collection-container',
          labels: ['Value', 'Collection', 'Receiver', 'Occurrence'],
          sourceStableId: getExtendedStableId(this.sourceFile, stage.callExpression.expression),
          order: 0,
          fillState: 'filled',
        },
        {
          stableId: previousStageStableId,
          text: 'shift',
          kind: 'method',
          labels: ['Primitive', 'Pull', 'Shift', 'Method'],
          sourceStableId: getExtendedStableId(this.sourceFile, stage.callExpression),
          order: 1,
        },
      ] satisfies RenderPartDescriptor[]);
      source.renderPrimaryPartIndex = 0;
      source.collectionMethod = stage.methodName;
      source.collectionLoopStableId = loopStableId;
      source.collectionIterationStableId = iterationStableId;
      source.semanticExpansion = 'collection-iteration';
      source.containerMethodKind = 'shift';
    } else {
      this.createNode('Op', 'shift', stage.callExpression, {
        ...this.executionPrimitiveExtra(execution.pull, [
          'Method',
          'Shift',
          'SequenceStage',
          'SemanticExpansion',
        ]),
        diaName: 'shift',
        actionTextRaw: stage.callExpression.getText(this.sourceFile),
        renderPartsLayout: 'single',
        renderPartsJson: JSON.stringify([{
          stableId: pullStableId,
          text: 'shift',
          kind: 'method',
          labels: ['Primitive', 'Pull', 'Shift', 'Method'],
          sourceStableId: getExtendedStableId(this.sourceFile, stage.callExpression),
          order: 0,
        } satisfies RenderPartDescriptor]),
        renderPrimaryPartIndex: 0,
        ...common,
        sequenceOwnerStableId: pullStableId,
        instrumentationPhase: 'callback-enter',
        instrumentationTargetStableId: getExtendedStableId(this.sourceFile, stage.callback),
        synthetic: true,
      }, pullStableId);
    }
    const itemName = itemParameter?.name.getText(this.sourceFile) || 'item';
    this.createNode('Value', 'iteration variable', itemParameter || stage.callback, {
      ...this.executionPrimitiveExtra(executionPrimitive('bind'), [
        'Iteration',
        'Value',
        'Element',
        'Variable',
        'ValueSlot',
        'Set',
        'ContainerMethod',
        'SemanticExpansion',
      ]),
      diaName: itemName,
      actionTextRaw: itemParameter?.getText(this.sourceFile) || itemName,
      ...common,
      flowLayer: 'data',
      dataFlowRole: 'input',
      sequenceOwnerStableId: iterationStableId,
      callbackParameterNames: stage.callback.parameters.map((parameter) => parameter.name.getText(this.sourceFile)),
      collectionCallbackStableId: getExtendedStableId(this.sourceFile, stage.callback),
      containerMethodKind: 'set',
      containerState: 'awaiting-assignment',
      renderPartsLayout: 'container-overlay',
      renderPartsJson: JSON.stringify([
        {
          stableId: iterationStableId,
          text: itemName,
          kind: 'value-container',
          labels: ['Iteration', 'Value', 'Element', 'Variable', 'ValueSlot'],
          order: 0,
          fillState: 'empty',
        },
        {
          stableId: iterationStableId,
          text: 'set',
          kind: 'method',
          labels: ['Assignment', 'ContainerMethod', 'Method', 'Set'],
          order: 1,
        },
      ]),
      renderPrimaryPartIndex: 0,
      synthetic: true,
    }, iterationStableId);
    if (materializeExhaustedMarker) {
      this.createNode('Action', 'exhausted', stage.callExpression, {
        labels: ['Primitive', 'Outcome', 'Exhausted', 'SemanticExpansion'],
        diaName: '×',
        actionTextRaw: stage.callExpression.getText(this.sourceFile),
        renderPartsLayout: 'single',
        renderPartsJson: JSON.stringify([{
          stableId: exhaustedStableId,
          text: '×',
          kind: 'punctuation',
          labels: ['Primitive', 'Outcome', 'Exhausted'],
          sourceStableId: getExtendedStableId(this.sourceFile, stage.callExpression),
          order: 0,
        } satisfies RenderPartDescriptor]),
        renderPrimaryPartIndex: 0,
        ...common,
        executionOutcome: execution.exhaustedOutcome,
        sequenceOwnerStableId: pullStableId,
        runtimeEventKind: 'iteration.exhausted',
        instrumentationStrategy: 'call-wrapper',
        instrumentationPhase: 'after',
        instrumentationTargetStableId: getExtendedStableId(this.sourceFile, stage.callExpression),
        flowLayer: 'control',
        synthetic: true,
      }, exhaustedStableId);
    }
    if (!options.directConsumer && !options.mergeCompletionIntoResult) {
      this.createNode('Action', 'complete', stage.callExpression, {
        ...this.executionPrimitiveExtra(execution.complete, [
          'Collection',
          'SequenceStage',
          'SemanticExpansion',
        ]),
        diaName: 'complete',
        actionTextRaw: stage.callExpression.getText(this.sourceFile),
        ...common,
        sequenceOwnerStableId: completionStableId,
        instrumentationPhase: 'after',
        instrumentationTargetStableId: getExtendedStableId(this.sourceFile, stage.callExpression),
        synthetic: true,
      }, completionStableId);
    }

    if (!options.reuseStageAsRoot && !options.mergePullIntoSource) {
      this.addEdge(undefined, previousStageStableId, undefined, loopStableId, 'READS_VALUE', {
        label: 'collection',
        semanticExpansion: 'collection-iteration',
        sequenceOrder: 0,
      });
      this.addEdge(undefined, stageStableId, undefined, loopStableId, 'ITERATES_VALUE', {
        label: semantics.reverse ? 'iterate reverse' : 'iterate',
        semanticExpansion: 'collection-iteration',
        sequenceOrder: 1,
      });
    }
    this.addEdge(undefined, pullStableId, undefined, pulledValueStableId, 'YIELDS_VALUE', {
      label: 'value',
      displayLabel: 'value',
      semanticExpansion: 'collection-iteration',
      sequenceOrder: 3,
      executionOutcome: execution.itemOutcome,
      protocolRole: 'iteration-pass',
    });
    if (materializeExhaustedMarker) {
      this.addEdge(undefined, pullStableId, undefined, exhaustedStableId, 'EXHAUSTED', {
        label: 'undefined',
        displayLabel: 'undefined',
        semanticExpansion: 'collection-iteration',
        sequenceOrder: 8,
        executionOutcome: execution.exhaustedOutcome,
      });
    }
    if (!options.directConsumer && !options.mergeCompletionIntoResult) {
      this.addEdge(undefined, exhaustedStableId, undefined, completionStableId, 'NEXT', {
        label: 'complete',
        semanticExpansion: 'collection-iteration',
        sequenceOrder: 9,
      });
    }
    if (options.reuseStageAsRoot) {
      this.addEdge(undefined, iterationStableId, undefined, pullStableId, 'EVAL', {
        label: 'eval',
        displayLabel: 'eval',
        flowLayer: 'control',
        semanticExpansion: 'collection-iteration',
        protocolRole: 'collection-shift-eval',
        oneWay: true,
        producerRouteRole: 'entry',
      });
    }

    return {
      loopStableId,
      pullStableId,
      pulledValueStableId,
      iterationStableId,
      iterationValueStableId,
      iterationResultStableId,
      exhaustedStableId,
      completionStableId,
      execution,
    };
  }

  private materializeCollectionIterationCompletion(
    stage: {
      callExpression: ts.CallExpression;
      methodName: string;
      callback: ts.ArrowFunction | ts.FunctionExpression;
    },
    semantics: CollectionMethodSemantics,
    protocol: {
      loopStableId: string;
      pullStableId: string;
      iterationStableId: string;
      iterationResultStableId: string;
      completionStableId: string;
      execution: ReturnType<typeof collectionExecutionProtocol>;
    },
    callbackCompletionStableId: string,
    stageResultStableId?: string,
    options: { compactResult?: boolean; foldCallbackIntoResult?: boolean } = {},
  ) {
    const virtualResultMethod = collectionVirtualResultMethod(semantics);
    const compactClosingStableId = options.compactResult
      && semantics.resultMode === 'collection'
      && !options.foldCallbackIntoResult
      ? `${protocol.iterationResultStableId}:close`
      : undefined;
    const collectionResultParts = semantics.resultMode === 'collection'
      ? (() => {
          const body = stage.callback.body;
          const valueParts = ts.isExpression(body)
            && (!options.compactResult || options.foldCallbackIntoResult)
            ? JSON.parse(this.buildRenderParts(body, protocol.iterationResultStableId)?.json || '[]') as RenderPartDescriptor[]
            : [];
          return [
            {
              stableId: `${protocol.iterationResultStableId}:container`,
              text: 'result',
              kind: 'collection-container',
              labels: ['Value', 'Collection', 'Result', 'Accumulator'],
              order: 0,
              fillState: 'empty',
            },
            {
              stableId: `${protocol.iterationResultStableId}:${virtualResultMethod}`,
              text: `${virtualResultMethod}(`,
              kind: 'method',
              labels: ['Primitive', 'Method', 'ContainerMethod'],
              order: 1,
              sourceStableId: getExtendedStableId(this.sourceFile, stage.callback),
            },
            ...valueParts.map((part, index) => ({
              ...part,
              stableId: `${protocol.iterationResultStableId}:value:${index}`,
              order: index + 2,
            })),
            ...((!options.compactResult || options.foldCallbackIntoResult) ? [{
              stableId: `${protocol.iterationResultStableId}:close`,
              text: ')',
              kind: 'punctuation',
              labels: ['Op', 'CallBoundary'],
              order: valueParts.length + 2,
              sourceStableId: getExtendedStableId(this.sourceFile, stage.callback),
            } satisfies RenderPartDescriptor] : []),
          ] satisfies RenderPartDescriptor[];
        })()
      : undefined;
    this.createNode('Value', `${semantics.callbackResultAction} result`, stage.callback, {
      labels: uniqueStrings([
        'Primitive',
        protocol.execution.callbackResult.kind[0].toUpperCase()
          + protocol.execution.callbackResult.kind.slice(1),
        'Iteration',
        'Result',
        'CallbackResult',
        'Method',
        'ContainerMethod',
        'SemanticExpansion',
        ...(semantics.resultMode === 'collection' ? ['Collection'] : []),
        ...(semantics.resultMode === 'boolean' ? ['BooleanFlag'] : []),
        ...(semantics.resultMode === 'accumulator' ? ['Accumulator'] : []),
      ]),
      diaName: semantics.resultMode === 'collection' ? 'result' : virtualResultMethod,
      actionTextRaw: stage.callback.getText(this.sourceFile),
      collectionMethod: stage.methodName,
      collectionIterationMode: semantics.iterationMode,
      collectionResultMode: semantics.resultMode,
      collectionLoopStableId: protocol.loopStableId,
      collectionIterationStableId: protocol.iterationStableId,
      semanticExpansion: 'collection-iteration',
      sequenceOwnerStableId: protocol.iterationStableId,
      primitiveKind: protocol.execution.callbackResult.kind,
      containerMethodKind: virtualResultMethod,
      runtimeEventKind: protocol.execution.callbackResult.runtimeEventKind,
      instrumentationStrategy: protocol.execution.callbackResult.instrumentationStrategy,
      instrumentationPhase: 'callback-exit',
      instrumentationTargetStableId: getExtendedStableId(this.sourceFile, stage.callback),
      flowLayer: protocol.execution.callbackResult.flowLayer,
      dataFlowRole: protocol.execution.callbackResult.flowLayer === 'control' ? undefined : 'result',
      ...(collectionResultParts ? {
        renderPartsLayout: 'container-overlay-side' as const,
        renderPartsJson: JSON.stringify(collectionResultParts),
        renderPrimaryPartIndex: 0,
        operationSubjectText: 'result',
        operationValueText: stage.callback.body.getText(this.sourceFile),
        containerState: 'materialized',
      } : {}),
      synthetic: true,
    }, protocol.iterationResultStableId);
    if (compactClosingStableId) {
      this.createNode('Op', 'close collection result', stage.callback, {
        labels: ['Op', 'CallBoundary', 'SubStepAttachment'],
        diaName: ')',
        semanticExpansion: 'collection-iteration',
        sequenceOwnerStableId: protocol.iterationStableId,
        callMosaicOwnerStableId: protocol.iterationResultStableId,
        callMosaicRole: 'close',
        compactCallMosaic: true,
        synthetic: true,
      }, compactClosingStableId);
    }
    const compactInlineCallResult = options.compactResult
      && ts.isExpression(stage.callback.body)
      && ts.isCallExpression(unwrapExpression(stage.callback.body));
    if (options.foldCallbackIntoResult) {
      this.addEdge(
        undefined,
        callbackCompletionStableId,
        undefined,
        protocol.iterationResultStableId,
        'NEXT',
        {
          label: '',
          displayLabel: '',
          flowLayer: 'control',
          semanticExpansion: 'collection-iteration',
          sequenceOrder: 6,
          protocolRole: 'iteration-result',
        },
      );
    } else if (!compactInlineCallResult) {
      this.addEdge(
        undefined,
        callbackCompletionStableId,
        undefined,
        protocol.iterationResultStableId,
        this.collectionResultEdgeType(protocol.execution.callbackResult),
        {
          label: options.compactResult ? 'value' : virtualResultMethod,
          displayLabel: options.compactResult ? 'value' : virtualResultMethod,
          flowLayer: protocol.execution.callbackResult.flowLayer,
          semanticExpansion: 'collection-iteration',
          sequenceOrder: 6,
          protocolRole: 'iteration-result-value',
        },
      );
    }
    this.addEdge(undefined, protocol.iterationResultStableId, undefined, protocol.pullStableId, 'REPEATS', {
      flowLayer: 'mixed',
      semanticExpansion: 'collection-iteration',
      sequenceOrder: 7,
      sourceRenderPartStableId: `${protocol.iterationResultStableId}:${virtualResultMethod}`,
    });
    if (stageResultStableId && protocol.completionStableId !== stageResultStableId) {
      this.addEdge(undefined, protocol.completionStableId, undefined, stageResultStableId, 'COMPLETES_VALUE', {
        label: semantics.resultMode,
        semanticExpansion: 'collection-iteration',
        sequenceOrder: 10,
        executionOutcome: 'completed',
      });
    }
    if (semantics.shortCircuit) {
      this.addEdge(undefined, protocol.iterationResultStableId, undefined, protocol.completionStableId, 'SHORT_CIRCUITS', {
        label: 'complete early',
        semanticExpansion: 'collection-iteration',
        sequenceOrder: 8,
        executionOutcome: protocol.execution.shortCircuitOutcome,
      });
    }
  }

  private materializeDirectCollectionAssignment(
    stage: {
      callExpression: ts.CallExpression;
      callback: ts.ArrowFunction | ts.FunctionExpression;
    },
    protocol: {
      loopStableId: string;
      pullStableId: string;
      iterationStableId: string;
      iterationValueStableId: string;
      exhaustedStableId: string;
    },
    outcomes: {
      truthySourceStableIds: string[];
      falsySourceStableIds: string[];
    },
    assignmentStableId: string,
    producerStableId: string,
    plan: DirectCollectionAssignmentPlan,
  ) {
    if (
      plan.kind !== 'select-one'
      ||
      plan.truthy.action !== 'assign'
      || plan.truthy.value !== 'bound-item'
      || plan.falsy.action !== 'repeat'
      || plan.exhausted.action !== 'assign'
      || plan.exhausted.value !== 'undefined'
    ) {
      throw new Error('Unsupported direct collection assignment plan');
    }
    const assignment = this.nodeByStableId(assignmentStableId);
    if (!assignment) {
      throw new Error(`Direct collection assignment node not found: ${assignmentStableId}`);
    }
    assignment.labels = uniqueStrings([
      ...(assignment.labels || []),
      'ValuePass',
      'Iteration',
    ]);
    assignment.collectionLoopStableId = protocol.loopStableId;
    assignment.collectionIterationStableId = protocol.iterationStableId;
    assignment.sequenceOwnerStableId = protocol.iterationStableId;
    assignment.flowLayer = 'data';
    assignment.dataFlowRole = 'input';
    assignment.containerState = 'awaiting-assignment';
    const selectedValueName = stage.callback.parameters[0]?.name.getText(this.sourceFile) || 'item';
    const parts = JSON.parse(assignment.renderPartsJson || '[]') as RenderPartDescriptor[];
    if (parts[0]) parts[0].fillState = 'empty';
    const methodPartIndex = parts.findIndex((part) => part.kind === 'method');
    const methodPart = methodPartIndex >= 0 ? parts.splice(methodPartIndex, 1)[0] : undefined;
    if (methodPart) methodPart.stableId = `${assignmentStableId}:set`;
    parts.push(...[methodPart, {
      stableId: assignmentStableId,
      text: selectedValueName,
      kind: 'value',
      labels: ['Value', 'Occurrence', 'ValuePass', 'Iteration'],
      order: 2,
      fillState: 'filled' as const,
      sourceStableId: getExtendedStableId(
        this.sourceFile,
        stage.callback.parameters[0] || stage.callback,
      ),
    }].filter((part): part is RenderPartDescriptor => Boolean(part)));
    assignment.renderPartsLayout = 'container-overlay-side';
    assignment.renderPartsJson = JSON.stringify(materializeAttachedMethodArgumentMosaic(
      parts,
      assignmentStableId,
      getExtendedStableId(this.sourceFile, stage.callExpression),
    ));

    const producerEntry = this.edges.find((edge) => (
      edge.type === 'EVAL'
      && edge.fromId === assignmentStableId
      && edge.toId === producerStableId
    ));
    if (producerEntry) {
      producerEntry.oneWay = true;
      producerEntry.producerRouteRole = 'entry';
      producerEntry.semanticExpansion = 'execution-protocol';
    } else {
      this.addEdge(undefined, assignmentStableId, undefined, producerStableId, 'EVAL', {
        label: 'eval',
        displayLabel: 'eval',
        flowLayer: 'mixed',
        semanticExpansion: 'execution-protocol',
        oneWay: true,
        producerRouteRole: 'entry',
      });
    }
    outcomes.falsySourceStableIds.forEach((sourceStableId) => {
      this.addEdge(undefined, sourceStableId, undefined, protocol.pullStableId, 'FALSE', {
        label: 'false',
        flowLayer: 'control',
        semanticExpansion: 'collection-iteration',
        sequenceOrder: 7,
        executionOutcome: 'rejected',
      });
    });
    outcomes.truthySourceStableIds.forEach((sourceStableId) => {
      this.addEdge(undefined, sourceStableId, undefined, assignmentStableId, 'TRUE', {
        label: 'true',
        flowLayer: 'control',
        semanticExpansion: 'collection-iteration',
        sequenceOrder: 7,
        executionOutcome: 'accepted',
        protocolRole: 'assignment-return',
        targetRenderPartStableId: `${assignmentStableId}:set`,
      });
    });
    return [assignmentStableId];
  }

  private materializeDirectCollectionEmission(
    stage: {
      callExpression: ts.CallExpression;
      callback: ts.ArrowFunction | ts.FunctionExpression;
    },
    protocol: {
      loopStableId: string;
      pullStableId: string;
      iterationStableId: string;
      iterationValueStableId: string;
      exhaustedStableId: string;
    },
    outcomes: {
      truthySourceStableIds: string[];
      falsySourceStableIds: string[];
    },
    assignmentStableId: string,
    producerStableId: string,
    plan: DirectCollectionAssignmentPlan,
  ) {
    if (plan.kind !== 'collect-accepted') {
      throw new Error('Unsupported direct collection emission plan');
    }
    this.configureDirectCollectionResultContainer(
      stage,
      protocol,
      assignmentStableId,
      producerStableId,
      'push',
      stage.callback.parameters[0]?.name.getText(this.sourceFile) || 'item',
      ['Collection', 'CollectionMutation'],
    );
    outcomes.truthySourceStableIds.forEach((sourceStableId) => {
      this.addEdge(undefined, sourceStableId, undefined, assignmentStableId, 'TRUE', {
        label: 'true',
        flowLayer: 'control',
        semanticExpansion: 'collection-iteration',
        executionOutcome: 'accepted',
        protocolRole: 'assignment-return',
        targetRenderPartStableId: `${assignmentStableId}:push`,
      });
    });
    outcomes.falsySourceStableIds.forEach((sourceStableId) => {
      this.addEdge(undefined, sourceStableId, undefined, protocol.pullStableId, 'FALSE', {
        label: 'false',
        flowLayer: 'control',
        semanticExpansion: 'collection-iteration',
        executionOutcome: 'rejected',
      });
    });
    return [assignmentStableId];
  }

  private materializeDirectCollectionAccumulation(
    stage: {
      callExpression: ts.CallExpression;
      callback: ts.ArrowFunction | ts.FunctionExpression;
    },
    protocol: {
      loopStableId: string;
      pullStableId: string;
      iterationStableId: string;
      exhaustedStableId: string;
    },
    callbackValueStableId: string,
    assignmentStableId: string,
    producerStableId: string,
    plan: DirectCollectionAssignmentPlan,
    accumulatorReceiver?: {
      receiverName: string;
      receiverStableId: string;
      materialized: boolean;
      embeddedCollection?: boolean;
      receiverExpression?: ts.Expression;
    },
  ) {
    if (plan.kind !== 'accumulate') {
      throw new Error('Unsupported direct collection accumulation plan');
    }
    this.configureDirectAccumulatorContribution(
      stage,
      protocol,
      callbackValueStableId,
      accumulatorReceiver,
    );
    this.configureDirectCollectionResultContainer(
      stage,
      protocol,
      assignmentStableId,
      producerStableId,
      'add',
      undefined,
      ['Accumulator'],
    );
    this.addEdge(undefined, callbackValueStableId, undefined, assignmentStableId, 'PASSES_VALUE', {
      label: 'value',
      displayLabel: 'value',
      flowLayer: 'data',
      semanticExpansion: 'collection-iteration',
      protocolRole: 'assignment-return',
      producerRouteRole: 'return-bottom',
      sourcePort: 'left',
      sourcePortCandidates: ['left'],
      targetPort: 'right',
      targetPortCandidates: ['right'],
      lockPortCandidates: true,
    });
    return [assignmentStableId];
  }

  private directAccumulatorContributionExpression(
    callback: ts.ArrowFunction | ts.FunctionExpression,
  ) {
    const callbackResult = this.callbackTerminalExpression(callback);
    if (!callbackResult) return undefined;
    const body = unwrapExpression(callbackResult);
    const accumulatorName = callback.parameters[0]?.name.getText(this.sourceFile);
    if (
      accumulatorName
      && ts.isBinaryExpression(body)
      && body.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = unwrapExpression(body.left);
      if (ts.isIdentifier(left) && left.text === accumulatorName) {
        return unwrapExpression(body.right);
      }
    }
    return body;
  }

  private callbackTerminalExpression(
    callback: ts.ArrowFunction | ts.FunctionExpression,
  ) {
    if (!callback.body) return undefined;
    if (ts.isExpression(callback.body)) return unwrapExpression(callback.body);
    const finalStatement = callback.body.statements.at(-1);
    return finalStatement && ts.isReturnStatement(finalStatement) && finalStatement.expression
      ? unwrapExpression(finalStatement.expression)
      : undefined;
  }

  private materializeCallbackPrelude(
    callback: ts.ArrowFunction | ts.FunctionExpression,
    incomingExits: PendingExit[],
  ) {
    if (!callback.body || !ts.isBlock(callback.body)) {
      return { firstNodeId: undefined, pending: incomingExits };
    }
    const statements = [...callback.body.statements];
    const finalStatement = statements.at(-1);
    const prelude = finalStatement && ts.isReturnStatement(finalStatement)
      ? statements.slice(0, -1)
      : statements;
    let firstNodeId: string | undefined;
    let pending = [...incomingExits];
    for (const statement of prelude) {
      const result = this.buildStatement(statement, pending, { hasLocalCatch: false });
      firstNodeId ||= result.firstNodeId;
      pending = result.openExits;
    }
    return { firstNodeId, pending };
  }

  private relativeExpressionRenderParts(
    expression: ts.Expression,
    ownerStableId: string,
    omittedReceiverName: string,
  ) {
    type SourcePart = Omit<RenderPartDescriptor, 'stableId' | 'order'> & { primary?: boolean };
    const parts: SourcePart[] = [];
    const push = (
      node: ts.Node,
      text: string,
      kind: RenderPartDescriptor['kind'],
      labels: string[],
      primary = false,
    ) => parts.push({
      text,
      kind,
      labels,
      sourceStableId: getExtendedStableId(this.sourceFile, node),
      primary,
    });
    const visit = (candidate: ts.Expression): void => {
      const current = unwrapExpression(candidate);
      if (ts.isBinaryExpression(current)) {
        visit(current.left);
        push(
          current.operatorToken,
          current.operatorToken.getText(this.sourceFile),
          'operator',
          ['Op', 'Operand'],
          true,
        );
        visit(current.right);
        return;
      }
      if (ts.isElementAccessExpression(current)) {
        visit(current.expression);
        push(current, '[', 'punctuation', ['Op', 'Operand']);
        if (current.argumentExpression) visit(current.argumentExpression);
        push(current, ']', 'punctuation', ['Op', 'Operand']);
        return;
      }
      if (isPropertyAccessLikeExpression(current)) {
        visit(current.expression);
        if (current.questionDotToken && parts.length) {
          const receiverIndex = parts.length - 1;
          parts[receiverIndex] = {
            ...parts[receiverIndex],
            text: `${parts[receiverIndex].text}?`,
            labels: uniqueStrings([...(parts[receiverIndex].labels || []), 'OptionalCheck']),
          };
        }
        push(current.name, `.${current.name.getText(this.sourceFile)}`, 'value', ['Value', 'ValueAccess', 'FieldAccess']);
        return;
      }
      if (ts.isIdentifier(current) && current.text === omittedReceiverName) return;
      const literal = isLiteralValueExpression(current);
      push(
        current,
        current.getText(this.sourceFile),
        literal ? 'literal' : 'value',
        literal ? literalValueLabels(current) : ['Value', 'ValueAccess'],
      );
    };
    visit(expression);
    const primaryIndex = Math.max(0, parts.findIndex((part) => part.primary));
    return {
      json: JSON.stringify(parts.map(({ primary: _primary, ...part }, order) => ({
        ...part,
        stableId: order === primaryIndex ? ownerStableId : `${ownerStableId}:render-part:${order}`,
        order,
      }))),
      primaryIndex,
    };
  }

  private configureDirectAccumulatorContribution(
    stage: {
      callExpression: ts.CallExpression;
      callback: ts.ArrowFunction | ts.FunctionExpression;
    },
    protocol: {
      loopStableId: string;
      iterationStableId: string;
    },
    callbackValueStableId: string,
    accumulatorReceiver?: {
      receiverName: string;
      receiverStableId: string;
      materialized: boolean;
      embeddedCollection?: boolean;
      receiverExpression?: ts.Expression;
    },
  ) {
    const contributionExpression = this.directAccumulatorContributionExpression(stage.callback);
    const contribution = this.nodeByStableId(callbackValueStableId);
    if (!contributionExpression || !contribution) return;
    const receiverInfo = accumulatorReceiver
      || this.materializeDirectAccumulatorReceiver(stage, protocol);
    const receiverName = receiverInfo.receiverName;
    const collectionMethod = isPropertyAccessLikeExpression(stage.callExpression.expression)
      ? stage.callExpression.expression.name.getText(this.sourceFile)
      : getCallLikeName(stage.callExpression.expression);

    const relativeRenderParts = this.relativeExpressionRenderParts(
      contributionExpression,
      callbackValueStableId,
      receiverName,
    );
    const relativeParts = JSON.parse(relativeRenderParts.json) as RenderPartDescriptor[];
    const renderPrimaryPartIndex = relativeRenderParts.primaryIndex
      + (receiverInfo.embeddedCollection ? 1 : 0);
    const renderParts = receiverInfo.embeddedCollection && receiverInfo.receiverExpression
      ? [{
          stableId: `${callbackValueStableId}:render-part:receiver`,
          text: receiverName,
          kind: 'collection-container' as const,
          labels: ['Value', 'ValueAccess', 'Collection'],
          order: 0,
          fillState: 'filled' as const,
          sourceStableId: getExtendedStableId(this.sourceFile, receiverInfo.receiverExpression),
          canonicalStableId: this.canonicalStableIdForExpression(receiverInfo.receiverExpression),
          bindingStableId: this.bindingStableIdForExpression(receiverInfo.receiverExpression),
        }, ...relativeParts].map((part, order) => ({
          ...part,
          stableId: order === renderPrimaryPartIndex
            ? callbackValueStableId
            : `${callbackValueStableId}:render-part:${order}`,
          order,
        }))
      : relativeParts;
    const binaryResult = ts.isBinaryExpression(contributionExpression);
    const booleanResult = isBooleanLikeExpression(contributionExpression);
    contribution.labels = uniqueStrings([
      ...(contribution.labels || []).filter((label) => label !== 'Branch'),
      'Operand',
      ...(binaryResult ? ['BinaryExpression', 'BinaryResult'] : []),
      ...(booleanResult ? ['Branch'] : ['SignificantExpression']),
      ...(receiverInfo.embeddedCollection ? ['Collection'] : []),
    ]);
    contribution.diaName = contributionExpression.getText(this.sourceFile);
    contribution.actionTextRaw = contributionExpression.getText(this.sourceFile);
    contribution.operationCode = booleanResult ? 'boolean-expression' : 'value-expression';
    contribution.operationSubjectText = contributionExpression.getText(this.sourceFile);
    contribution.renderPartsJson = JSON.stringify(renderParts);
    contribution.renderPartsLayout = receiverInfo.embeddedCollection
      ? 'container-overlay-side'
      : 'horizontal';
    contribution.renderPrimaryPartIndex = renderPrimaryPartIndex;
    contribution.collectionLoopStableId = protocol.loopStableId;
    contribution.collectionIterationStableId = protocol.iterationStableId;
    contribution.collectionMethod = collectionMethod;

  }

  private materializeDirectAccumulatorReceiver(
    stage: {
      callExpression: ts.CallExpression;
      callback: ts.ArrowFunction | ts.FunctionExpression;
    },
    protocol: {
      loopStableId: string;
      iterationStableId: string;
    },
  ) {
    const contributionExpression = this.directAccumulatorContributionExpression(stage.callback);
    if (!contributionExpression) {
      throw new Error('Direct accumulator contribution expression is missing');
    }
    let receiver = contributionExpression;
    if (ts.isBinaryExpression(receiver)) receiver = unwrapExpression(receiver.left);
    while (isPropertyAccessLikeExpression(receiver) || ts.isElementAccessExpression(receiver)) {
      receiver = unwrapExpression(receiver.expression);
    }
    const receiverName = receiver.getText(this.sourceFile);
    const callbackParameterNames = stage.callback.parameters.map((parameter) => (
      parameter.name.getText(this.sourceFile)
    ));
    if (callbackParameterNames.includes(receiverName)) {
      return {
        receiverName,
        receiverStableId: protocol.iterationStableId,
        materialized: false,
        embeddedCollection: false,
        receiverExpression: receiver,
      };
    }
    const receiverStableId = this.contextualizeHorizontalStableId(
      `${getExtendedStableId(this.sourceFile, receiver)}:receiver`,
      receiver,
    );
    return {
      receiverName,
      receiverStableId,
      materialized: false,
      embeddedCollection: true,
      receiverExpression: receiver,
    };
  }

  private configureDirectCollectionResultContainer(
    stage: {
      callExpression: ts.CallExpression;
      callback: ts.ArrowFunction | ts.FunctionExpression;
    },
    protocol: {
      loopStableId: string;
      iterationStableId: string;
    },
    assignmentStableId: string,
    producerStableId: string,
    methodName: 'push' | 'add',
    passedValueName: string | undefined,
    semanticLabels: string[],
  ) {
    const assignment = this.nodeByStableId(assignmentStableId);
    if (!assignment) {
      throw new Error(`Direct collection result container not found: ${assignmentStableId}`);
    }
    assignment.labels = uniqueStrings([
      ...(assignment.labels || []).filter((label) => label !== 'Set'),
      'ValuePass',
      'Iteration',
      ...semanticLabels,
    ]);
    assignment.collectionLoopStableId = protocol.loopStableId;
    assignment.collectionIterationStableId = protocol.iterationStableId;
    assignment.sequenceOwnerStableId = protocol.iterationStableId;
    assignment.flowLayer = 'data';
    assignment.dataFlowRole = 'input';
    assignment.containerState = 'awaiting-assignment';
    assignment.containerMethodKind = methodName;
    const parts = JSON.parse(assignment.renderPartsJson || '[]') as RenderPartDescriptor[];
    if (parts[0]) {
      parts[0].fillState = 'empty';
      if (semanticLabels.includes('Collection')) parts[0].kind = 'collection-container';
    }
    const methodPartIndex = parts.findIndex((part) => part.kind === 'method');
    const methodPart = methodPartIndex >= 0
      ? parts.splice(methodPartIndex, 1)[0]
      : ({ stableId: assignmentStableId, kind: 'method' } as RenderPartDescriptor);
    methodPart.stableId = `${assignmentStableId}:${methodName}`;
    methodPart.text = methodName;
    methodPart.labels = uniqueStrings([
      'Assignment',
      'ContainerMethod',
      'Method',
      ...semanticLabels,
    ]);
    parts.push(methodPart);
    if (passedValueName) {
      parts.push({
        stableId: assignmentStableId,
        text: passedValueName,
        kind: 'value',
        labels: ['Value', 'Occurrence', 'ValuePass', 'Iteration', 'Variable'],
        order: 2,
        fillState: 'filled',
        sourceStableId: getExtendedStableId(this.sourceFile, stage.callback),
      });
    }
    assignment.renderPartsLayout = 'container-overlay-side';
    assignment.renderPartsJson = JSON.stringify(materializeAttachedMethodArgumentMosaic(
      parts,
      assignmentStableId,
      getExtendedStableId(this.sourceFile, stage.callExpression),
    ));

    const producerEntry = this.edges.find((edge) => (
      edge.type === 'EVAL'
      && edge.fromId === assignmentStableId
      && edge.toId === producerStableId
    ));
    if (producerEntry) {
      producerEntry.oneWay = true;
      producerEntry.producerRouteRole = 'entry';
      producerEntry.semanticExpansion = 'execution-protocol';
    } else {
      this.addEdge(undefined, assignmentStableId, undefined, producerStableId, 'EVAL', {
        label: 'eval',
        displayLabel: 'eval',
        flowLayer: 'mixed',
        semanticExpansion: 'execution-protocol',
        oneWay: true,
        producerRouteRole: 'entry',
      });
    }
  }

  private finalizeDirectCollectionSubmethod(
    stage: {
      callExpression: ts.CallExpression;
      methodName: string;
      callback: ts.ArrowFunction | ts.FunctionExpression;
    },
    protocol: {
      loopStableId: string;
      pullStableId: string;
      iterationStableId: string;
      exhaustedStableId: string;
    },
    assignmentStableId: string,
    callbackCompletionStableId: string | undefined,
    plan: DirectCollectionAssignmentPlan,
  ) {
    const headerStableId = protocol.loopStableId;
    const header = this.nodeByStableId(headerStableId);
    const item = this.nodeByStableId(protocol.iterationStableId);
    const sourceStableId = String(header.collectionPreviousStageStableId || '');
    const source = this.nodeByStableId(sourceStableId);
    const pull = this.nodeByStableId(protocol.pullStableId);
    const exhausted = this.nodeByStableId(protocol.exhaustedStableId);
    if (!header || !item) {
      throw new Error(`Direct collection submethod is incomplete: ${headerStableId}`);
    }
    const protocolKind = plan.kind === 'select-one'
      ? 'collection-search'
      : plan.kind === 'collect-accepted'
        ? 'collection-select'
        : 'collection-accumulate';
    const callbackNodes = this.nodes
      .filter((node) => (
        node.collectionLoopStableId === headerStableId
        && getStableIdKey(node.stableId) !== headerStableId
      ))
      .sort((left, right) => (left.operationIndex ?? 0) - (right.operationIndex ?? 0));
    const predicates = callbackNodes.filter((node) => (
      node.labels.includes('Branch') && node.labels.includes('Operand')
    )).sort((left, right) => (left.operationIndex ?? 0) - (right.operationIndex ?? 0));
    const localAssignments = callbackNodes.filter((node) => (
      node.labels.includes('Set')
      && node.labels.includes('Assignment')
      && getStableIdKey(node.stableId) !== getStableIdKey(item.stableId)
      && getStableIdKey(node.stableId) !== assignmentStableId
    ));
    const localAssignmentProducers = localAssignments
      .map((assignment) => {
        const assignmentStableId = getStableIdKey(assignment.stableId);
        const producerEdge = this.edges.find((edge) => (
          edge.toId === assignmentStableId
          && edge.type === 'ASSIGNS_VALUE'
        ));
        return {
          assignment,
          producer: producerEdge ? this.nodeByStableId(producerEdge.fromId) : undefined,
        };
      })
      .filter((entry): entry is { assignment: FlowNodeRow; producer: FlowNodeRow } => Boolean(entry.producer));
    const contribution = plan.kind === 'accumulate' && callbackCompletionStableId
      ? this.nodeByStableId(callbackCompletionStableId)
      : undefined;
    const axisNodes = plan.kind === 'accumulate'
      ? [item, contribution].filter((node): node is FlowNodeRow => Boolean(node))
      : [...localAssignments, item, ...predicates];
    const attachments = [
      { node: source, placement: 'right', anchor: header },
      ...(pull && pull !== source ? [{ node: pull, placement: 'overlay', anchor: source }] : []),
      ...localAssignmentProducers.map(({ assignment, producer }) => ({
        node: producer,
        placement: 'right',
        anchor: assignment,
      })),
      ...(exhausted && exhausted !== pull && exhausted !== source
        ? [{ node: exhausted, placement: 'right', anchor: pull || source }]
        : []),
    ].filter((entry): entry is {
      node: FlowNodeRow;
      placement: string;
      anchor: FlowNodeRow;
    } => Boolean(entry.node && entry.anchor));

    header.labels = uniqueStrings([
      ...header.labels,
      'Method',
      'Primitive',
      'Iterator',
      'Iterate',
      'SubStep',
    ]);
    header.primitiveKind = 'iterate';
    header.executionScopeKind = 'collection-iterator';
    header.executionProtocolStableId = headerStableId;
    header.executionProtocolKind = protocolKind;
    header.submethodStableId = headerStableId;
    header.parentSubmethodStableId = assignmentStableId;
    header.submethodKind = 'collection-method';
    header.submethodOrder = 70;
    header.submethodRelativeColumn = 0;
    header.submethodRelativeRow = 0;
    header.executionRoles = uniqueStrings([...(header.executionRoles || []), 'call', 'iterator']);
    header.executionRoleOrder = 0;
    if (plan.kind !== 'accumulate') {
      const parts = (() => {
        try {
          return JSON.parse(header.renderPartsJson || '[]') as RenderPartDescriptor[];
        } catch {
          return [];
        }
      })();
      const methodPart = parts.find((part) => part.kind === 'method');
      if (methodPart) {
        header.renderPartsJson = JSON.stringify([{ ...methodPart, order: 0 }]);
        header.renderPartsLayout = 'single';
        header.renderPrimaryPartIndex = 0;
      }
    }

    axisNodes.forEach((node, index) => {
      node.labels = uniqueStrings([...node.labels, 'SubStepMember']);
      node.memberOfSubmethodStableId = headerStableId;
      node.submethodPlacement = 'axis';
      node.submethodMemberOrder = index;
      node.submethodRelativeColumn = 0;
      node.submethodRelativeRow = index + 1;
      node.executionProtocolStableId = headerStableId;
      node.executionProtocolKind = protocolKind;
      node.executionRoles = uniqueStrings([
        ...(node.executionRoles || []),
        ...(node === item
          ? ['item']
          : plan.kind === 'accumulate'
            ? ['predicateSource', 'contentAccess']
            : [`predicate${index}`]),
      ]);
      node.executionRoleOrder = 10 + index;
      const previous = index === 0 ? header : axisNodes[index - 1];
      const previousStableId = getStableIdKey(previous.stableId);
      const nodeStableId = getStableIdKey(node.stableId);
      if (!this.edges.some((edge) => edge.fromId === previousStableId && edge.toId === nodeStableId)) {
        this.addEdge(undefined, previousStableId, undefined, nodeStableId, 'NEXT', {
          label: '',
          flowLayer: 'control',
          semanticExpansion: 'collection-iteration',
        });
      }
    });
    attachments.forEach(({ node, placement, anchor }, index) => {
      node.labels = uniqueStrings([...node.labels, 'SubStepAttachment']);
      node.memberOfSubmethodStableId = headerStableId;
      node.submethodPlacement = placement;
      node.submethodAnchorStableId = node === source
        ? protocol.iterationStableId
        : getStableIdKey(anchor.stableId);
      node.submethodMemberOrder = axisNodes.length + index;
      node.submethodRelativeColumn = 1;
      node.submethodRelativeRow = node === source
        ? 0
        : Math.max(1, anchor.submethodRelativeRow ?? 0);
      node.executionProtocolStableId = headerStableId;
      node.executionProtocolKind = protocolKind;
      node.executionRoles = uniqueStrings([
        ...(node.executionRoles || []),
        ...(node === source ? ['source', 'receiver'] : []),
        ...(node === pull ? ['pull'] : []),
        ...(node === exhausted ? ['exhausted'] : []),
        ...(node === contribution ? ['coalesce', 'contribution'] : []),
      ]);
      node.executionRoleOrder = 30 + index;
    });
    const assignment = this.nodeByStableId(assignmentStableId);
    if (assignment) {
      assignment.executionProtocolStableId = headerStableId;
      assignment.executionProtocolKind = protocolKind;
      assignment.executionRoles = uniqueStrings([
        ...(assignment.executionRoles || []),
        'target',
        'result',
        ...(plan.kind === 'accumulate' ? ['accumulate'] : []),
      ]);
      assignment.executionRoleOrder = 60;
    }
    header.submethodsJson = JSON.stringify([{
      stableId: headerStableId,
      parentStableId: assignmentStableId,
      kind: 'collection-method',
      role: 'iterator',
      ownerStableId: headerStableId,
      headerStableId,
      memberStableIds: axisNodes.map((node) => getStableIdKey(node.stableId)),
      attachments: attachments.map(({ node, placement, anchor }) => ({
        stableId: getStableIdKey(node.stableId),
        placement,
        anchorStableId: getStableIdKey(anchor.stableId),
      })),
      order: 70,
    }]);

  }

  private materializeCollectionTransformInitializer(
    constStableId: string,
    initializer: ts.Expression,
    assignmentStableId: string,
    options: {
      incomingExits?: PendingExit[];
      allowDirectAssignment?: boolean;
      compactProtocol?: boolean;
      compactConsumerStableId?: string;
    } = {},
  ) {
    const transform = this.standardCollectionTransform(initializer);
    if (!transform) {
      return undefined;
    }

    const stageStableIds = transform.stages.map((stage) => (
      this.contextualizeHorizontalStableId(getExtendedStableId(this.sourceFile, stage.callExpression))
    ));
    const firstStageStableId = stageStableIds[0];
    const incomingExits = options.incomingExits
      || [this.createPendingExit(undefined, constStableId, 'EVAL', 'eval')];
    const allowDirectAssignment = options.allowDirectAssignment !== false;
    // Collection methods are emitted in their final graph shape. The method
    // call is the iterator root, the source owns shift, and the callback result
    // is the completion. Do not create loop/callback/complete placeholders for
    // a later normalization pass.
    const compactProtocol = options.compactProtocol !== false;

    let firstNodeId = firstStageStableId;
    let collectionHeadStableId = firstStageStableId;
    let receiverCallStableId = '';
    if (ts.isCallExpression(transform.receiver)) {
      const receiverTarget = this.resolveRenderableCallTarget(transform.receiver);
      const receiverRole = this.getCallRole(transform.receiver, receiverTarget);
      const receiverStableId = this.createNode(this.callNodeKind(transform.receiver, receiverRole), 'call', transform.receiver, {
        labels: uniqueStrings([
          ...this.callSiteLabels(transform.receiver, receiverRole),
          ...this.callBoundaryLabels([...transform.receiver.arguments]),
        ]),
        diaName: formatCallDiaName(transform.receiver, this.sourceFile),
        actionTextRaw: transform.receiver.getText(this.sourceFile),
        ...this.buildCallTargetExtra(transform.receiver),
        ...this.callStartEffectExtra(transform.receiver),
        ...this.callBoundaryExtra(transform.receiver, 'open'),
      });
      receiverCallStableId = receiverStableId;
      this.connectPendingToNode(incomingExits, receiverStableId);
      const responseAwareReceiver = this.runWithRequestResponseTarget(firstStageStableId, receiverStableId, () => (
        this.materializeCallArgumentsToProxy(
          transform.receiver as ts.CallExpression,
          receiverStableId,
          receiverTarget,
          receiverRole,
          {
            suppressReceiver: true,
            suppressTrackedExecution: true,
            resultEdgeMode: 'value',
          },
        )
      ));
      collectionHeadStableId = responseAwareReceiver.value.resultStableId
        || responseAwareReceiver.value.proxyStableId
        || receiverStableId;
      this.addEdge(undefined, receiverStableId, undefined, firstStageStableId, 'NEXT', {
        label: '',
        flowLayer: 'control',
        semanticExpansion: 'collection-iteration',
      });
      firstNodeId = receiverStableId;
    } else {
      this.connectPendingToNode(incomingExits, firstStageStableId);
    }

    let resultExits: PendingExit[] = [];
    let finalDataResultStableId = '';
    let assignmentConnected = false;
    let directProducerEndStableIds: string[] = [];
    let controlResultExits: PendingExit[] | undefined;
    transform.stages.forEach((stage, index) => {
      const stageStableId = stageStableIds[index];
      let previousStageStableId = index === 0
        ? collectionHeadStableId
        : finalDataResultStableId;
      const semantics = collectionMethodSemantics(stage.methodName);
      const candidateDirectAssignmentPlan = index === transform.stages.length - 1
        && allowDirectAssignment
        && Boolean(this.callbackTerminalExpression(stage.callback))
        ? directCollectionAssignmentPlan(semantics)
        : undefined;
      // find/filter define predicate callbacks by their method contract. A
      // property access such as `entry.enabled` is still a predicate even
      // though its syntax alone does not prove a boolean result.
      const directAssignmentPlan = candidateDirectAssignmentPlan;
      const directAssignment = Boolean(directAssignmentPlan);
      if (index === 0 && !ts.isCallExpression(transform.receiver)) {
        const sourceStableId = this.contextualizeHorizontalStableId(
          `${stageStableId}:receiver`,
          transform.receiver,
        );
        const sourceName = transform.receiver.getText(this.sourceFile);
        const sourceValueSlotStableId = this.bindingNodeStableIdForExpression(transform.receiver);
        this.createNode('Value', sourceName, transform.receiver, {
          labels: ['Value', 'Collection', 'Read', 'Receiver', 'Occurrence'],
          diaName: sourceName,
          operationSubjectText: sourceName,
          actionTextRaw: sourceName,
          canonicalStableId: getExtendedStableId(this.sourceFile, transform.receiver),
          valueSlotStableId: sourceValueSlotStableId,
          valueSlotStableIds: sourceValueSlotStableId ? [sourceValueSlotStableId] : undefined,
          collectionHeadStableId: sourceStableId,
          semanticExpansion: 'collection-iteration',
          flowLayer: 'data',
          dataFlowRole: 'source',
        }, sourceStableId);
        previousStageStableId = sourceStableId;
        collectionHeadStableId = sourceStableId;
      }
      const foldedAccumulatorArguments = directAssignmentPlan?.kind === 'accumulate'
        ? stage.callExpression.arguments.filter((_, argumentIndex) => argumentIndex !== stage.callbackIndex)
        : [];
      const accumulatorHeaderParts: RenderPartDescriptor[] = foldedAccumulatorArguments.length
        ? [
            {
              stableId: stageStableId,
              text: `${stage.methodName}(`,
              kind: 'method',
              labels: ['Op', 'Method', 'Call'],
              order: 0,
              sourceStableId: getExtendedStableId(this.sourceFile, stage.callExpression),
            },
            ...foldedAccumulatorArguments.flatMap((argument, argumentIndex) => {
              const built = this.buildRenderParts(argument, stageStableId);
              const parts = built
                ? JSON.parse(built.json) as RenderPartDescriptor[]
                : [];
              return parts.map((part, partIndex) => ({
                ...part,
                stableId: `${stageStableId}:initial-value:${argumentIndex}:${partIndex}`,
                order: argumentIndex + partIndex + 1,
              }));
            }),
            {
              stableId: `${stageStableId}:initial-value:close`,
              text: ')',
              kind: 'punctuation',
              labels: ['Op', 'CallBoundary'],
              order: foldedAccumulatorArguments.length + 1,
              sourceStableId: getExtendedStableId(this.sourceFile, stage.callExpression),
            },
        ]
        : [];
      const protocolRootStableId = directAssignment
        ? stageStableId
        : this.contextualizeHorizontalStableId(
            `${stageStableId}:collection-loop`,
            stage.callExpression,
          );
      const protocolIterationStableId = this.contextualizeHorizontalStableId(
        `${stageStableId}:iteration`,
        stage.callback,
      );
      this.createNode('Op', stage.methodName, stage.callExpression, {
        labels: uniqueStrings([
          ...(!(directAssignment || compactProtocol) ? ['Collection'] : []),
          ...(stage.callExpression.arguments.length > 1 ? ['Start'] : []),
          ...(directAssignment || compactProtocol ? ['Method', 'Primitive', 'Iterator', 'Iterate', 'SubStep'] : []),
        ]),
        diaName: stage.methodName,
        actionTextRaw: stage.callExpression.getText(this.sourceFile),
        collectionMethod: stage.methodName,
        collectionHeadStableId,
        collectionPreviousStageStableId: previousStageStableId,
        valueSlotStableId: index === 0
          ? this.bindingNodeStableIdForExpression(transform.receiver)
          : undefined,
        collectionIterationMode: semantics.iterationMode,
        collectionResultMode: semantics.resultMode,
        collectionShortCircuit: semantics.shortCircuit,
        collectionReverse: semantics.reverse,
        collectionMutatesReceiver: semantics.mutatesReceiver,
        collectionLoopStableId: protocolRootStableId,
        collectionIterationStableId: protocolIterationStableId,
        semanticExpansion: 'collection-iteration',
        executionScopeKind: directAssignment || compactProtocol ? 'collection-iterator' : 'collection-call',
        ...(directAssignment || compactProtocol ? {
          primitiveKind: 'iterate',
          executionProtocolStableId: stageStableId,
          executionProtocolKind: semantics.iterationMode === 'search' && semantics.resultMode === 'element'
            ? 'collection-search'
            : semantics.iterationMode === 'select' && semantics.resultMode === 'collection'
              ? 'collection-select'
              : 'collection-accumulate',
        } : {}),
        snippetEntryStableId: stageStableId,
        ...(accumulatorHeaderParts.length || directAssignment ? {
          renderPartsJson: JSON.stringify((accumulatorHeaderParts.length
            ? accumulatorHeaderParts
            : [{
                stableId: stageStableId,
                text: stage.methodName,
                kind: 'method',
                labels: ['Op', 'Method', 'Call'],
                order: 0,
                sourceStableId: getExtendedStableId(this.sourceFile, stage.callExpression),
              } satisfies RenderPartDescriptor]
          ).map((part, order) => ({ ...part, order }))),
          renderPartsLayout: 'horizontal' as const,
          renderPrimaryPartIndex: 0,
        } : {}),
      }, stageStableId);
      const protocol = this.materializeCollectionIterationEntry(
        stage,
        stageStableId,
        previousStageStableId,
        semantics,
        {
          directConsumer: directAssignment,
          reuseStageAsRoot: directAssignment || compactProtocol,
          materializeExhaustedMarker: false,
          mergePullIntoSource: directAssignment || compactProtocol,
          mergeCompletionIntoResult: compactProtocol,
          exhaustedTargetStableId: compactProtocol
            ? options.compactConsumerStableId
              || (directAssignment ? assignmentStableId : undefined)
            : undefined,
        },
      );
      if (compactProtocol) {
        const header = this.nodeByStableId(stageStableId);
        const item = this.nodeByStableId(protocol.iterationStableId);
        const source = this.nodeByStableId(protocol.pullStableId);
        if (header) {
          header.submethodStableId = stageStableId;
          header.submethodKind = 'collection-method';
          header.submethodRelativeColumn = 0;
          header.submethodRelativeRow = 0;
          header.substepColumnOffset = directAssignment ? 0 : 1;
          header.substepRowOffset = index === 0 && receiverCallStableId
            ? 1
            : directAssignment ? 0 : 0.5;
          if (index === 0 && receiverCallStableId) {
            header.submethodAnchorStableId = receiverCallStableId;
          }
          header.diaName = stage.methodName;
          if (!accumulatorHeaderParts.length) {
            header.renderPartsJson = JSON.stringify([{
              stableId: stageStableId,
              text: stage.methodName,
              kind: 'method',
              labels: ['Op', 'Method', 'Call'],
              order: 0,
              sourceStableId: getExtendedStableId(this.sourceFile, stage.callExpression),
            } satisfies RenderPartDescriptor]);
            header.renderPartsLayout = 'single';
            header.renderPrimaryPartIndex = 0;
          }
        }
        if (item) {
          item.labels = uniqueStrings([...item.labels, 'SubStepMember']);
          item.memberOfSubmethodStableId = stageStableId;
          item.submethodPlacement = 'axis';
          item.submethodMemberOrder = 0;
          item.submethodRelativeColumn = 0;
          item.submethodRelativeRow = 1;
        }
        if (source) {
          source.labels = uniqueStrings([...source.labels, 'SubStepAttachment']);
          source.memberOfSubmethodStableId = stageStableId;
          source.submethodPlacement = 'right';
          source.submethodAnchorStableId = protocol.iterationStableId;
          source.submethodMemberOrder = 1;
          source.submethodRelativeColumn = 1;
          source.submethodRelativeRow = 1;
        }
        if (!this.edges.some((edge) => (
          edge.fromId === stageStableId
          && edge.toId === protocol.iterationStableId
          && edge.type === 'NEXT'
        ))) {
          this.addEdge(undefined, stageStableId, undefined, protocol.iterationStableId, 'NEXT', {
            label: '',
            flowLayer: 'control',
            semanticExpansion: 'collection-iteration',
          });
        }
      }

      const parameterNames = stage.callback.parameters.map((parameter) => parameter.name.getText(this.sourceFile));
      const callbackKind = this.callbackKindForCollectionSemantics(
        semantics,
        this.callbackKindForArgument(stage.callExpression, stage.callbackIndex),
      );
      const callbackContract = this.callbackExecutionContract(callbackKind);
      const callbackStableId = this.contextualizeHorizontalStableId(getExtendedStableId(this.sourceFile, stage.callback));
      if (compactProtocol) this.registerSubmethodSourceRegion(stage.callback.body, stageStableId);
      const parametersStableId = directAssignment || compactProtocol
        ? protocol.iterationStableId
        : this.createNode('Value', 'callback parameters', stage.callback, {
            labels: uniqueStrings([
              'Arg',
              'Operand',
              'CallbackParams',
              ...this.callbackRoleLabels(callbackKind, stage.callback),
              ...(callbackKind === 'predicate' ? ['ComputedValue', 'BooleanFlag'] : []),
            ]),
            diaName: this.callbackHeadDiaName(stage.callback, `(${parameterNames.join(', ')})`),
            callbackKind,
            callbackDeferred: callbackContract.callbackDeferred,
            callbackParameterNames: parameterNames,
            argumentName: this.getParameterName(stage.callExpression, stage.callbackIndex),
            argumentIndex: stage.callbackIndex,
            asyncContract: callbackContract.asyncContract,
            collectionMethod: stage.methodName,
            collectionHeadStableId,
            collectionLoopStableId: protocol.loopStableId,
            collectionIterationStableId: protocol.iterationStableId,
            collectionCallbackStableId: callbackStableId,
            semanticExpansion: 'collection-iteration',
            executionScopeKind: 'callback',
            sequenceOwnerStableId: `${callbackStableId}:parameters`,
          }, `${callbackStableId}:parameters`);
      if (!directAssignment && !compactProtocol) {
        this.addEdge(undefined, stageStableId, undefined, parametersStableId, 'ARG', {
          label: `arg ${stage.callbackIndex + 1}`,
          argumentName: this.getParameterName(stage.callExpression, stage.callbackIndex),
          argumentIndex: stage.callbackIndex,
        });
        this.addEdge(undefined, protocol.iterationValueStableId, undefined, parametersStableId, 'PASSES_VALUE', {
          label: parameterNames.join(', ') || 'callback value',
          semanticExpansion: 'collection-iteration',
          sequenceOrder: 4,
        });
      }

      const callbackBody = stage.callback.body;
      const foldCompactCallbackIntoResult = !directAssignment
        && compactProtocol
        && semantics.resultMode === 'collection'
        && ts.isExpression(callbackBody)
        && !ts.isCallExpression(unwrapExpression(callbackBody));
      const callbackMemberStartIndex = this.nodes.length;
      const accumulatorReceiver = directAssignmentPlan?.kind === 'accumulate'
        ? this.materializeDirectAccumulatorReceiver(stage, protocol)
        : undefined;
      const directSearchWithoutAssignment = !directAssignment
        && compactProtocol
        && semantics.iterationMode === 'search'
        && semantics.resultMode === 'element';
      const directPredicateOutcomes = (directAssignment || directSearchWithoutAssignment)
        && directAssignmentPlan?.kind !== 'accumulate'
        && callbackKind === 'predicate'
        ? this.materializeComputedArgumentPredicateExits(
            parametersStableId,
            stage.callback,
            'NEXT',
          )
        : undefined;
      const computedResultStableId = !directAssignment && callbackKind === 'predicate'
        ? this.materializeComputedArgumentValue(
            parametersStableId,
            stage.callback,
            parameterNames.join(', ') || `arg ${stage.callbackIndex + 1}`,
            'ARROW',
          )
        : undefined;
      let callbackCompletionStableId = computedResultStableId;
      let callbackFirstNodeStableId: string | undefined;
      if (foldCompactCallbackIntoResult) {
        callbackFirstNodeStableId = parametersStableId;
        callbackCompletionStableId = parametersStableId;
      } else if (!callbackCompletionStableId && !directPredicateOutcomes) {
        const callbackEvaluationBody = directAssignmentPlan?.kind === 'accumulate'
          ? this.directAccumulatorContributionExpression(stage.callback) || callbackBody
          : callbackBody;
        const callbackStartsAtIterationSet = directAssignment || compactProtocol;
        const callbackIncomingBase = [this.createPendingExit(
          undefined,
          parametersStableId,
          callbackStartsAtIterationSet ? 'NEXT' : 'ARROW',
          callbackStartsAtIterationSet ? '' : 'arrow',
        )];
        const callbackIncoming = accumulatorReceiver?.materialized
          ? (() => {
              this.connectPendingToNode(
                callbackIncomingBase,
                accumulatorReceiver.receiverStableId,
              );
              return [this.createPendingExit(
                undefined,
                accumulatorReceiver.receiverStableId,
                'NEXT',
                '',
              )];
            })()
          : callbackIncomingBase;
        const callbackResult = directAssignmentPlan?.kind === 'accumulate'
          ? (() => {
              const prelude = this.materializeCallbackPrelude(stage.callback, callbackIncoming);
              const result = this.runInHorizontalFlow('Operand', () => this.materializeExpressionValue(
                callbackEvaluationBody as ts.Expression,
                prelude.pending,
                true,
                { suppressTerminalCallResult: compactProtocol },
              ));
              return {
                firstNodeId: prelude.firstNodeId || result.firstNodeId,
                pending: result.pending,
              };
            })()
          : ts.isExpression(callbackBody)
            ? this.runInHorizontalFlow('Operand', () => this.materializeExpressionValue(
                callbackEvaluationBody as ts.Expression,
                callbackIncoming,
                true,
                { suppressTerminalCallResult: compactProtocol },
              ))
          : this.runInHorizontalFlow('Operand', () => this.materializeImmediateCallbackBody(
              { callback: stage.callback, allowLocalReturn: true },
              callbackIncoming,
            ));
        callbackFirstNodeStableId = callbackResult.firstNodeId;
        callbackCompletionStableId = (compactProtocol || directAssignmentPlan?.kind === 'accumulate')
          && callbackResult.pending.length === 1
          ? callbackResult.pending[0].fromId
          : this.createCallbackCompletionNode(
              stage.callback,
              callbackKind,
              parametersStableId,
              callbackResult.pending,
            );
      }
      if (directAssignmentPlan?.kind === 'accumulate' && callbackCompletionStableId) {
        const callbackValueNode = this.nodes.find(
          (node) => getStableIdKey(node.stableId) === callbackCompletionStableId,
        );
        if (callbackValueNode) {
          const evaluate = executionPrimitive('evaluate');
          callbackValueNode.labels = uniqueStrings([
            ...(callbackValueNode.labels || []),
            'Primitive',
            'Evaluate',
            'SemanticExpansion',
          ]);
          callbackValueNode.primitiveKind = evaluate.kind;
          callbackValueNode.runtimeEventKind = evaluate.runtimeEventKind;
          callbackValueNode.instrumentationStrategy = evaluate.instrumentationStrategy;
          callbackValueNode.instrumentationPhase = 'callback-exit';
          callbackValueNode.instrumentationTargetStableId = getExtendedStableId(this.sourceFile, callbackBody);
          callbackValueNode.semanticExpansion = 'collection-iteration';
          callbackValueNode.flowLayer = 'data';
          callbackValueNode.dataFlowRole = 'result';
        }
      }
      const callbackRange = getStableIdDescriptor(this.sourceFile, callbackBody);
      const startsInsideCallback = (node: FlowNodeRow) => (
        Number.isFinite(node.stableId.startLine)
        && Number.isFinite(node.stableId.startColumn)
        && (
          Number(node.stableId.startLine) > callbackRange.startLine
          || (
            Number(node.stableId.startLine) === callbackRange.startLine
            && Number(node.stableId.startColumn) >= callbackRange.startColumn
          )
        )
        && (
          Number(node.stableId.endLine) < callbackRange.endLine
          || (
            Number(node.stableId.endLine) === callbackRange.endLine
            && Number(node.stableId.endColumn) <= callbackRange.endColumn
          )
        )
      );
      const callbackMembers = [...new Map([
        ...this.nodes.slice(callbackMemberStartIndex),
        ...this.nodes.filter(startsInsideCallback),
      ].map((node) => [getStableIdKey(node.stableId), node])).values()]
        .filter((node) => !node.labels.includes('Step') && !node.labels.includes('FlowBlock'));
      for (const callbackMember of callbackMembers) {
        callbackMember.collectionHeadStableId ||= collectionHeadStableId;
        callbackMember.collectionLoopStableId ||= protocol.loopStableId;
        callbackMember.collectionIterationStableId ||= protocol.iterationStableId;
        callbackMember.collectionCallbackStableId ||= callbackStableId;
        callbackMember.sequenceOwnerStableId ||= parametersStableId;
      }
      if (compactProtocol && !directAssignment) {
        const callbackAnchorStableId = protocol.iterationStableId;
        callbackMembers.forEach((callbackMember, memberIndex) => {
          const isField = callbackMember.labels.includes('Field');
          const isFamilyClose = callbackMember.labels.includes('FieldJoin')
            || callbackMember.labels.includes('ArgJoin')
            || callbackMember.labels.includes('Join');
          const isCallResult = callbackMember.labels.includes('CallResult');
          callbackMember.labels = uniqueStrings([...callbackMember.labels, 'SubStepAttachment']);
          callbackMember.memberOfSubmethodStableId = stageStableId;
          callbackMember.submethodPlacement = 'right';
          callbackMember.submethodAnchorStableId = callbackAnchorStableId;
          callbackMember.submethodMemberOrder = 10 + memberIndex;
          callbackMember.submethodRelativeColumn = isCallResult
            ? 3
            : isFamilyClose
              ? 2.6
              : isField
                ? 1.75
                : 1;
          callbackMember.submethodRelativeRow = isField && !isFamilyClose
            ? 3 + memberIndex * 0.22
            : 3;
        });
      }

      const callbackArgumentName = this.getParameterName(stage.callExpression, stage.callbackIndex);
      const argumentExits: PendingExit[] = callbackCompletionStableId && !compactProtocol
        ? [{
            ...this.createPendingExit(
              undefined,
              callbackCompletionStableId,
              'ArgJoin',
              `arg ${stage.callbackIndex + 1}`,
            ),
            argumentName: callbackArgumentName,
            argumentIndex: stage.callbackIndex,
          }]
        : [];
      stage.callExpression.arguments.forEach((argument, argumentIndex) => {
        if (argumentIndex === stage.callbackIndex) return;
        if (directAssignmentPlan?.kind === 'accumulate') return;
        const argEntry = this.createArgumentNode(stage.callExpression, argument, argumentIndex, {
          preferExpressionDiaName: true,
        });
        this.addEdge(undefined, stageStableId, undefined, argEntry.argStableId, 'ARG', {
          label: `arg ${argumentIndex + 1}`,
          argumentName: this.getParameterName(stage.callExpression, argumentIndex),
          argumentIndex,
        });
        argumentExits.push(...argEntry.exitsToArgs);
      });

      const stageTarget = this.resolveCollectionMethodTarget(stage.callExpression);
      const stageProxyStableId = compactProtocol && !directAssignment
        ? stageStableId
        : this.createFnVisualProxy(
            stage.callExpression,
            stageStableId,
            stageTarget,
            this.getCallRole(stage.callExpression, stageTarget),
            { materializeReceiver: !directAssignment && !compactProtocol },
          );
      if (directAssignmentPlan?.kind === 'accumulate') {
        this.addEdge(undefined, parametersStableId, undefined, stageProxyStableId, 'PASSES_VALUE', {
          label: `arg ${stage.callbackIndex + 1}`,
          flowLayer: 'data',
          semanticExpansion: 'collection-iteration',
        });
      }
      argumentExits.forEach((exit) => {
        this.addEdge(exit.fromKind, exit.fromId, undefined, stageProxyStableId, exit.edgeType, {
          label: exit.label,
          argumentName: exit.argumentName,
          argumentIndex: exit.argumentIndex,
          callTextRaw: stage.callExpression.getText(this.sourceFile),
          callSiteStableId: stageStableId,
          invocationType: 'REQUEST',
        });
      });
      const stageNode = this.nodes.find((node) => getStableIdKey(node.stableId) === stageStableId);
      if (stageNode) stageNode.snippetExitStableId = stageProxyStableId;
      let stageResultExits: PendingExit[];
      if (directSearchWithoutAssignment && directPredicateOutcomes) {
        this.addCallEdges(stageProxyStableId, stage.callExpression, stageTarget, {
          edgeType: 'REQUEST',
          callSiteStableId: stageStableId,
        });
        const selectedResult = this.nodeByStableId(protocol.iterationStableId);
        if (selectedResult) {
          selectedResult.labels = uniqueStrings([...selectedResult.labels, 'SelectedValue', 'Result']);
          selectedResult.dataFlowRole = 'result';
          selectedResult.sourceCallStableId = stageStableId;
        }
        controlResultExits = directPredicateOutcomes.truthySourceStableIds.map((sourceStableId) => (
          this.createPendingExit(undefined, sourceStableId, 'TRUE', 'true')
        ));
        directPredicateOutcomes.falsySourceStableIds.forEach((sourceStableId) => {
          this.addEdge(undefined, sourceStableId, undefined, protocol.pullStableId, 'FALSE', {
            label: 'false',
            flowLayer: 'control',
            semanticExpansion: 'collection-iteration',
            executionOutcome: 'rejected',
          });
        });
        finalDataResultStableId = protocol.iterationStableId;
        stageResultExits = [this.createPendingExit(undefined, protocol.iterationStableId, 'NEXT')];
      } else if (directPredicateOutcomes || directAssignmentPlan?.kind === 'accumulate') {
        this.addCallEdges(stageProxyStableId, stage.callExpression, stageTarget, {
          edgeType: 'REQUEST',
          callSiteStableId: stageStableId,
        });
        if (directAssignmentPlan?.kind === 'select-one') {
          directProducerEndStableIds = this.materializeDirectCollectionAssignment(
            stage,
            protocol,
            directPredicateOutcomes!,
            assignmentStableId,
            stageStableId,
            directAssignmentPlan,
          );
        } else if (directAssignmentPlan?.kind === 'collect-accepted') {
          directProducerEndStableIds = this.materializeDirectCollectionEmission(
            stage,
            protocol,
            directPredicateOutcomes!,
            assignmentStableId,
            firstNodeId,
            directAssignmentPlan,
          );
        } else if (directAssignmentPlan?.kind === 'accumulate') {
          directProducerEndStableIds = this.materializeDirectCollectionAccumulation(
            stage,
            protocol,
            callbackCompletionStableId!,
            assignmentStableId,
            firstNodeId,
            directAssignmentPlan,
            accumulatorReceiver,
          );
        }
        this.finalizeDirectCollectionSubmethod(
          stage,
          protocol,
          assignmentStableId,
          callbackCompletionStableId,
          directAssignmentPlan!,
        );
        assignmentConnected = true;
        finalDataResultStableId = assignmentStableId;
        stageResultExits = [this.createPendingExit(
          undefined,
          directProducerEndStableIds[0] || assignmentStableId,
          'NEXT',
        )];
      } else {
        const reusesSelectedElement = semantics.resultMode === 'element';
        const reusesCollectionAccumulator = semantics.resultMode === 'collection';
        const reusesProtocolResult = reusesSelectedElement || reusesCollectionAccumulator;
        const stageResultStableId = reusesSelectedElement
          ? protocol.iterationValueStableId
          : reusesCollectionAccumulator
            ? protocol.iterationResultStableId
            : this.createCallResultNode(stage.callExpression, stageStableId);
        if (reusesSelectedElement) {
          const selectedElement = this.nodes.find((node) => (
            getStableIdKey(node.stableId) === protocol.iterationValueStableId
          ));
          if (selectedElement) {
            selectedElement.labels = uniqueStrings([
              ...(selectedElement.labels || []),
              'SelectedValue',
              'Result',
            ]);
            selectedElement.dataFlowRole = 'result';
            selectedElement.sourceCallStableId = stageStableId;
          }
        }
        this.addCallEdges(stageProxyStableId, stage.callExpression, stageTarget, {
          edgeType: 'REQUEST',
          resultStableId: compactProtocol ? undefined : stageResultStableId,
          callSiteStableId: stageStableId,
        });
        if (!(compactProtocol && reusesSelectedElement)) {
          this.materializeCollectionIterationCompletion(
            stage,
            semantics,
            protocol,
            callbackCompletionStableId!,
            reusesSelectedElement ? undefined : stageResultStableId,
            {
              compactResult: compactProtocol,
              foldCallbackIntoResult: foldCompactCallbackIntoResult,
            },
          );
        }
        if (compactProtocol && !foldCompactCallbackIntoResult) {
          const result = this.nodeByStableId(protocol.iterationResultStableId);
          const callbackOpening = callbackFirstNodeStableId
            ? this.nodeByStableId(callbackFirstNodeStableId)
            : undefined;
          const callbackClosing = callbackCompletionStableId
            ? this.nodeByStableId(callbackCompletionStableId)
            : undefined;
          const resultClosing = this.nodeByStableId(`${protocol.iterationResultStableId}:close`);
          if (result) {
            result.callMosaicOwnerStableId = protocol.iterationResultStableId;
            result.callMosaicRole = 'open';
            result.compactCallMosaic = true;
          }
          if (callbackOpening) {
            callbackOpening.callMosaicOwnerStableId = protocol.iterationResultStableId;
            callbackOpening.callMosaicRole = 'argument';
          }
          if (callbackClosing && callbackClosing !== callbackOpening) {
            callbackClosing.callMosaicOwnerStableId = protocol.iterationResultStableId;
            callbackClosing.callMosaicRole = 'argument-close';
          }
          if (resultClosing) {
            resultClosing.callMosaicOwnerStableId = protocol.iterationResultStableId;
            resultClosing.callMosaicRole = 'close';
            resultClosing.compactCallMosaic = true;
          }
        }
        finalDataResultStableId = stageResultStableId;
        stageResultExits = [this.createPendingExit(
          undefined,
          compactProtocol && reusesSelectedElement
            ? stageResultStableId
            : reusesProtocolResult
              ? protocol.completionStableId
              : stageResultStableId,
          'NEXT',
        )];
      }

      if (compactProtocol && !directAssignment) {
        const header = this.nodeByStableId(stageStableId);
        const localAssignmentStableIds = callbackMembers
          .filter((node) => node.labels.includes('Set') && node.labels.includes('Assignment'))
          .sort((left, right) => (left.operationIndex ?? 0) - (right.operationIndex ?? 0))
          .map((node) => getStableIdKey(node.stableId));
        const predicateStableIds = callbackMembers
          .filter((node) => node.labels.includes('Branch') && node.labels.includes('Operand'))
          .sort((left, right) => (left.operationIndex ?? 0) - (right.operationIndex ?? 0))
          .map((node) => getStableIdKey(node.stableId));
        const primaryAxisStableIds = uniqueStrings([
          protocol.iterationStableId,
          ...localAssignmentStableIds,
        ].filter((stableId): stableId is string => Boolean(stableId)));
        const memberStableIds = uniqueStrings([
          ...primaryAxisStableIds,
          ...predicateStableIds,
        ]);
        if (header) {
          header.executionProtocolStableId = stageStableId;
          header.executionRoles = uniqueStrings([...(header.executionRoles || []), 'call', 'iterator']);
          header.executionRoleOrder = 0;
        }
        const source = this.nodeByStableId(protocol.pullStableId);
        if (source) {
          source.executionProtocolStableId = stageStableId;
          source.executionProtocolKind = header?.executionProtocolKind;
          source.executionRoles = uniqueStrings([
            ...(source.executionRoles || []),
            'source',
            'receiver',
            'pull',
          ]);
          source.executionRoleOrder = 20;
        }
        const compactResultStableId = semantics.resultMode === 'element'
          ? protocol.iterationStableId
          : protocol.iterationResultStableId;
        const result = this.nodeByStableId(compactResultStableId);
        if (result) {
          result.executionProtocolStableId = stageStableId;
          result.executionProtocolKind = header?.executionProtocolKind;
          result.executionRoles = uniqueStrings([...(result.executionRoles || []), 'result']);
          result.executionRoleOrder = 60;
        }
        primaryAxisStableIds.forEach((stableId, axisIndex) => {
          const member = this.nodeByStableId(stableId);
          if (!member) return;
          member.labels = uniqueStrings([...member.labels, 'SubStepMember']);
          member.memberOfSubmethodStableId = stageStableId;
          member.submethodPlacement = 'axis';
          member.submethodMemberOrder = axisIndex;
          member.submethodRelativeColumn = 0;
          member.submethodRelativeRow = axisIndex + 1;
          member.executionProtocolStableId = stageStableId;
          member.executionProtocolKind = header?.executionProtocolKind;
          if (stableId === protocol.iterationStableId) {
            member.executionRoles = uniqueStrings([...(member.executionRoles || []), 'item']);
          }
          member.executionRoleOrder = 10 + axisIndex;
        });
        let predicateRow = primaryAxisStableIds.length + 1;
        let predicateColumn = 0;
        predicateStableIds.forEach((stableId, predicateIndex) => {
          const member = this.nodeByStableId(stableId);
          if (!member) return;
          const previousStableId = predicateStableIds[predicateIndex - 1];
          const continuation = previousStableId
            ? this.edges.find((edge) => (
                edge.fromId === previousStableId
                && edge.toId === stableId
                && (edge.type === 'TRUE' || edge.type === 'FALSE')
              ))
            : undefined;
          if (predicateIndex > 0) {
            if (continuation?.type === 'FALSE') {
              predicateColumn += 1;
            } else {
              predicateRow += 1;
              predicateColumn = 0;
            }
          }
          member.labels = uniqueStrings([
            ...member.labels,
            predicateColumn > 0 ? 'SubStepAttachment' : 'SubStepMember',
          ]);
          member.memberOfSubmethodStableId = stageStableId;
          member.submethodPlacement = predicateColumn > 0 ? 'right' : 'axis';
          member.submethodAnchorStableId = predicateColumn > 0
            ? previousStableId
            : protocol.iterationStableId;
          member.submethodMemberOrder = primaryAxisStableIds.length + predicateIndex;
          member.submethodRelativeColumn = predicateColumn;
          member.submethodRelativeRow = predicateRow;
          member.executionProtocolStableId = stageStableId;
          member.executionProtocolKind = header?.executionProtocolKind;
          member.executionRoles = uniqueStrings([
            ...(member.executionRoles || []),
            `predicate${predicateIndex + 1}`,
          ]);
          member.executionRoleOrder = 10 + primaryAxisStableIds.length + predicateIndex;
        });

        for (const callbackMember of callbackMembers) {
          const callbackMemberStableId = getStableIdKey(callbackMember.stableId);
          if (memberStableIds.includes(callbackMemberStableId)) continue;
          const assignmentEdge = this.edges.find((edge) => (
            edge.fromId === callbackMemberStableId
            && edge.type === 'ASSIGNS_VALUE'
            && localAssignmentStableIds.includes(edge.toId)
          ));
          if (!assignmentEdge) continue;
          const assignment = this.nodeByStableId(assignmentEdge.toId);
          callbackMember.memberOfSubmethodStableId = stageStableId;
          callbackMember.submethodPlacement = 'right';
          callbackMember.submethodAnchorStableId = assignmentEdge.toId;
          callbackMember.submethodRelativeColumn = 1;
          callbackMember.submethodRelativeRow = assignment?.submethodRelativeRow ?? 1;
        }
        const callbackEntryStableIds = this.edges
          .filter((edge) => (
            edge.fromId === protocol.iterationStableId
            && edge.type === 'NEXT'
          ))
          .map((edge) => edge.toId);
        const stageParentStepStableId = header?.parentStepStableId;
        const belongsToStageStep = (stableId: string) => {
          const node = this.nodeByStableId(stableId);
          return Boolean(
            node
            && (!stageParentStepStableId || node.parentStepStableId === stageParentStepStableId)
          );
        };
        const callbackReachableStableIds = new Set<string>();
        const callbackQueue = callbackEntryStableIds.filter(belongsToStageStep);
        while (callbackQueue.length) {
          const stableId = callbackQueue.shift()!;
          if (callbackReachableStableIds.has(stableId)) continue;
          callbackReachableStableIds.add(stableId);
          if (stableId === callbackCompletionStableId) continue;
          for (const edge of this.edges.filter((candidate) => candidate.fromId === stableId)) {
            if (['FALSE', 'REPEATS'].includes(edge.type)) continue;
            if (!belongsToStageStep(edge.toId)) continue;
            callbackQueue.push(edge.toId);
          }
        }
        callbackReachableStableIds.add(compactResultStableId);
        if (semantics.resultMode === 'collection') {
          callbackReachableStableIds.add(`${protocol.iterationResultStableId}:close`);
        }
        [...callbackReachableStableIds].forEach((stableId, memberIndex) => {
          const member = this.nodeByStableId(stableId);
          if (!member || memberStableIds.includes(stableId)) return;
          member.labels = uniqueStrings([...member.labels, 'SubStepAttachment']);
          member.memberOfSubmethodStableId = stageStableId;
          member.submethodPlacement = 'right';
          member.submethodAnchorStableId ||= protocol.iterationStableId;
          member.submethodMemberOrder ??= 20 + memberIndex;
          if (stableId === compactResultStableId) {
            member.submethodRelativeColumn = 0;
            member.submethodRelativeRow = 3;
          } else {
            member.submethodRelativeColumn ??= 1;
            member.submethodRelativeRow ??= 3 + memberIndex * 0.22;
          }
        });
        if (header) {
          header.labels = header.labels.filter((label) => label !== 'SubStepAttachment');
          delete header.memberOfSubmethodStableId;
          delete header.submethodPlacement;
          delete header.submethodAnchorStableId;
          delete header.submethodMemberOrder;
        }
        const attachmentNodes = this.nodes.filter((node) => (
          node.memberOfSubmethodStableId === stageStableId
          && getStableIdKey(node.stableId) !== stageStableId
          && (!stageParentStepStableId || node.parentStepStableId === stageParentStepStableId)
          && !memberStableIds.includes(getStableIdKey(node.stableId))
        ));
        attachmentNodes.forEach((node) => {
          node.submethodRelativeColumn ??= getStableIdKey(node.stableId) === compactResultStableId ? 0 : 1;
          node.submethodRelativeRow = Math.max(1, Number(node.submethodRelativeRow) || 1);
        });
        if (header) {
          header.submethodRelativeColumn = 0;
          header.submethodRelativeRow = 0;
          header.submethodsJson = JSON.stringify([{
            stableId: stageStableId,
            parentStableId: assignmentStableId,
            kind: 'collection-method',
            role: 'iterator',
            ownerStableId: stageStableId,
            headerStableId: stageStableId,
            memberStableIds,
            attachments: [
              ...attachmentNodes.map((node) => ({
                stableId: getStableIdKey(node.stableId),
                placement: node.submethodPlacement || 'right',
                anchorStableId: node.submethodAnchorStableId || protocol.iterationStableId,
              })),
              ...(
                protocol.pullStableId !== protocol.iterationStableId
                && !attachmentNodes.some((node) => (
                  getStableIdKey(node.stableId) === protocol.pullStableId
                ))
                  ? [{
                      stableId: protocol.pullStableId,
                      placement: 'overlay',
                      anchorStableId: protocol.iterationStableId,
                    }]
                  : []
              ),
            ],
            order: index,
          }]);
        }
      }

      const nextStageStableId = stageStableIds[index + 1];
      if (nextStageStableId) {
        this.connectPendingToNode(stageResultExits, nextStageStableId);
      } else {
        resultExits = stageResultExits;
      }
    });

    if (resultExits.length !== 1) {
      const join = this.createJoinNode(initializer, 'collection-result-join', resultExits, { exclusive: false });
      this.connectPendingToJoin(resultExits, join.stableId, join.kind);
      resultExits = [this.createPendingExit(undefined, join.stableId, 'NEXT')];
    }

    return {
      firstNodeId,
      resultNodeId: finalDataResultStableId || resultExits[0]?.fromId || stageStableIds.at(-1)!,
      controlResultNodeId: resultExits[0]?.fromId || finalDataResultStableId || stageStableIds.at(-1)!,
      producerEndStableIds: directProducerEndStableIds.length
        ? uniqueStrings(directProducerEndStableIds)
        : [resultExits[0]?.fromId || stageStableIds.at(-1)!],
      controlResultExits,
      assignmentConnected,
    };
  }

  private buildValueOutcomeStableId(valueStableId: string, outcomeKey: string) {
    return `${valueStableId}:outcome:${sanitizeSyntheticExternalPart(outcomeKey)}`;
  }

  private createValueOutcomeNodes(
    anchor: ts.Node,
    valueStableId: string,
    valueName: string,
    expression: ts.Expression,
    options: { flowControl?: boolean } = {},
  ) {
    return valueOutcomeSpecsForExpression(expression).map((outcome, index) => {
      const outcomeLabel = options.flowControl
        ? (outcome.key === 'truthy' ? 'true' : 'false')
        : outcome.label;
      const stableId = this.buildValueOutcomeStableId(valueStableId, outcome.key);
      const outcomeStableId = this.createNode('Value', outcomeLabel, anchor, {
        labels: uniqueStrings([...(options.flowControl ? ['Flow'] : []), ...outcome.labels]),
        diaName: outcomeLabel,
        operationSubjectText: valueName,
        operationValueText: outcomeLabel,
        actionTextRaw: `${valueName} => ${outcomeLabel}`,
        foldStepOwnerStableId: valueStableId,
        synthetic: true,
        ...(options.flowControl ? {
          renderPartsLayout: 'single' as const,
          renderPrimaryPartIndex: 0,
          renderPartsJson: JSON.stringify([{
            stableId,
            text: outcomeLabel,
            kind: 'value',
            labels: ['Value', 'ValueOutcome', 'Flow'],
            order: 0,
            fillState: 'filled',
          }] satisfies RenderPartDescriptor[]),
        } : {}),
      }, stableId);
      this.addEdge(undefined, valueStableId, undefined, outcomeStableId, 'VALUE', {
        label: outcomeLabel,
        ...(options.flowControl ? { renderHidden: true } : {}),
      });
      return {
        ...outcome,
        stableId: outcomeStableId,
        index,
      };
    });
  }

  private connectValueResultExits(exits: PendingExit[], outcomeStableId: string, label: string, edgeType: Extract<FlowEdgeKind, 'TRUE' | 'FALSE'>) {
    exits.forEach((exit) => {
      this.addEdge(exit.fromKind, exit.fromId, undefined, outcomeStableId, edgeType, {
        label,
      });
    });
  }

  private configureBooleanAssignmentResult(flagStableId: string) {
    const container = this.nodeByStableId(flagStableId);
    if (!container) {
      throw new Error(`Boolean assignment container node not found: ${flagStableId}`);
    }
    const parts = JSON.parse(String(container.renderPartsJson || '[]')) as RenderPartDescriptor[];
    container.renderPartsLayout = 'container-overlay-side';
    const openingParts = parts.map((part) => (
      part.kind === 'method' && part.text === 'set'
        ? {
            ...part,
            text: 'set(',
            labels: uniqueStrings([...(part.labels || []), 'CallBoundary', 'Virtual']),
          }
        : part
    ));
    const assignmentParts = [
      ...openingParts,
      {
        stableId: `${flagStableId}:boolean-outcome`,
        text: '<font color="#CC0000">falsy</font><font color="#000000">/</font><font color="#006600">truthy</font>',
        plainText: 'falsy/truthy',
        kind: 'virtual-value',
        labels: ['Value', 'BooleanFlag', 'ValueOutcome', 'Virtual'],
        order: openingParts.length,
        fillState: 'filled',
      },
      {
        stableId: `${flagStableId}:set-close`,
        text: ')',
        kind: 'punctuation',
        labels: ['Op', 'CallBoundary', 'Virtual'],
        order: openingParts.length + 1,
        fillState: 'filled',
      },
    ] satisfies RenderPartDescriptor[];
    container.renderPartsJson = JSON.stringify(
      assignmentParts.map((part, order) => ({ ...part, order })),
    );
  }

  private connectBooleanAssignmentExits(
    exits: PendingExit[],
    assignmentStableId: string,
    edgeType: Extract<FlowEdgeKind, 'TRUE' | 'FALSE'>,
  ) {
    exits.forEach((exit) => {
      this.addEdge(exit.fromKind, exit.fromId, undefined, assignmentStableId, edgeType, {
        label: edgeType.toLowerCase(),
        producerRouteRole: edgeType === 'TRUE' ? 'return-top' : 'return-bottom',
        oneWay: true,
      });
    });
  }

  private materializeComputedLocalValueInitializerValue(
    flagStableId: string,
    initializer: ts.Expression,
  ) {
    this.configureBooleanAssignmentResult(flagStableId);
    const current = unwrapExpression(initializer);
    const incoming = [this.createPendingExit(undefined, flagStableId, 'EVAL', 'eval')];

    if (isBooleanShortCircuitBinaryExpression(current)) {
      const conditionFlow = this.runSuppressingHorizontalJoins(() => this.runInHorizontalFlow('Operand', () => this.materializeBooleanConditionFlow(current, incoming)));
      this.connectBooleanAssignmentExits(conditionFlow.trueExits, flagStableId, 'TRUE');
      this.connectBooleanAssignmentExits(conditionFlow.falseExits, flagStableId, 'FALSE');
      return {
        firstNodeId: conditionFlow.firstNodeId,
        resultStableIds: uniqueStrings([
          ...conditionFlow.trueExits.map((exit) => exit.fromId),
          ...conditionFlow.falseExits.map((exit) => exit.fromId),
        ]),
      };
    }

    const initializerResult = this.runSuppressingHorizontalJoins(() => this.runInHorizontalFlow('Operand', () => this.materializeExpressionValue(
      initializer,
      incoming,
      true,
    )));
    this.connectBooleanAssignmentExits(initializerResult.pending, flagStableId, 'TRUE');
    this.connectBooleanAssignmentExits(initializerResult.pending, flagStableId, 'FALSE');
    return {
      firstNodeId: initializerResult.firstNodeId,
      resultStableIds: uniqueStrings(initializerResult.pending.map((exit) => exit.fromId)),
    };
  }

  private materializeConstVariableStatement(statement: ts.VariableStatement, incomingExits: PendingExit[]): BuildResult {
    const bindingPlan = this.materializedConstVariableBinding(statement);
    if (!bindingPlan) {
      throw new Error(`Unsupported computed const binding: ${statement.getText(this.sourceFile)}`);
    }
    const { declaration, binding, initializer } = bindingPlan;
    const variableName = binding.text;
    const declarationKind = this.variableDeclarationKind(statement);
    const computedFlag = isBooleanLikeVariableName(variableName) || isBooleanLikeExpression(initializer);
    const hasComputedOutcomeBranches = computedFlag && isStructuredControlExpression(initializer);
    const inlineComputedAssignment = computedFlag
      && !hasComputedOutcomeBranches
      && collectMaterializedExpressions(unwrapExpression(initializer)).length === 0;
    const collectionValue = this.isCollectionExpression(initializer);
    const constStableId = this.createNode('Value', declarationKind, declaration, {
      labels: uniqueStrings([
        ...(computedFlag ? ['ComputedValue', 'BooleanFlag'] : ['Value']),
        ...(collectionValue ? ['Collection'] : []),
      ]),
      diaName: inlineComputedAssignment
        ? `${variableName} = ${initializer.getText(this.sourceFile)}`
        : variableName,
      operationSubjectText: variableName,
      operationValueText: initializer.getText(this.sourceFile),
      actionTextRaw: statement.getText(this.sourceFile),
      variableDeclarationKind: declarationKind,
    }, getExtendedStableId(this.sourceFile, binding));
    this.registerFirstNode(constStableId, incomingExits);
    this.connectPendingToNode(incomingExits, constStableId);
    const assignmentStableId = this.createAssignmentPrimitive(
      declaration,
      constStableId,
      initializer,
      binding,
    );

    let initializerControlResultNodeId: string | undefined;
    if (hasComputedOutcomeBranches) {
      const computed = this.materializeComputedLocalValueInitializerValue(
        constStableId,
        initializer,
      );
      if (computed.firstNodeId) {
        this.describeAssignmentProducer(
          assignmentStableId,
          computed.firstNodeId,
          computed.resultStableIds,
        );
      }
    } else {
      const initializerResult = this.materializeConstInitializerValue(
        declaration,
        constStableId,
        initializer,
        assignmentStableId,
      );
      initializerControlResultNodeId = 'controlResultNodeId' in initializerResult
        ? initializerResult.controlResultNodeId
        : undefined;
    }

    if (ts.isAwaitExpression(unwrapExpression(initializer))) {
      const evaluationEdge = this.edges.find((edge) => (
        edge.type === 'EVAL'
        && edge.fromId === constStableId
        && edge.producerRouteRole === 'entry'
      ));
      if (evaluationEdge) {
        evaluationEdge.invocationMode = 'asynchronous';
        evaluationEdge.responseMode = 'awaited';
      }
    }

    return {
      firstNodeId: constStableId,
      openExits: [this.createPendingExit(
        undefined,
        initializerControlResultNodeId || constStableId,
        'NEXT',
      )],
      pendingBreaks: [],
      pendingContinues: [],
      pendingThrows: [],
    };
  }

  private materializeLocalFunctionBody(
    continuation: {
      declaration: ts.VariableDeclaration;
      name: string;
      initializer: ts.ArrowFunction | ts.FunctionExpression;
    },
    declarationStableId: string,
    proxyStableId: string,
  ) {
    const bodyStatements = continuation.initializer.body && ts.isBlock(continuation.initializer.body)
      ? [...continuation.initializer.body.statements]
      : continuation.initializer.body && ts.isExpression(continuation.initializer.body)
        ? (() => {
            const returnStatement = ts.factory.createReturnStatement(continuation.initializer.body as ts.Expression);
            ts.setTextRange(returnStatement, continuation.initializer.body);
            return [returnStatement];
          })()
        : [];
    if (!bodyStatements.length) {
      return;
    }

    this.runInLocalFunctionContext(declarationStableId, continuation.name, () => {
      const functionStartId = this.createNode(
        'FunctionStart',
        'local function start',
        continuation.initializer,
        {
          parentLocalFunctionStableId: declarationStableId,
          localFunctionName: continuation.name,
          synthetic: true,
        },
        `${declarationStableId}:local-function-body:start`,
        false,
      );
      this.addStructuralEdgeOnce(
        declarationStableId,
        functionStartId,
        'DECLARES_FUNCTION',
        'declares function',
      );
      const bodyResult = this.buildBlock(
        bodyStatements,
        [this.createPendingExit(undefined, functionStartId, 'NEXT')],
        { hasLocalCatch: false },
      );
      if (bodyResult.pendingThrows.length) {
        this.materializePendingThrows(bodyResult.pendingThrows);
      }
      if (bodyResult.openExits.length) {
        const functionEndId = this.createNode('FunctionEnd', 'local function end', continuation.initializer, {
          labels: ['FunctionEnd', 'LocalFunctionBody'],
          parentLocalFunctionStableId: declarationStableId,
          localFunctionName: continuation.name,
          synthetic: true,
        }, `${declarationStableId}:local-function-body:end`);
        this.connectPendingToNode(bodyResult.openExits, functionEndId);
      }
    });
  }

  private materializeLocalFunctionDeclaration(statement: ts.VariableStatement, incomingExits: PendingExit[]): BuildResult | undefined {
    const continuation = this.getLocalFunctionDeclaration(statement);
    if (!continuation) {
      return undefined;
    }
    const isAsync = nodeHasModifier(continuation.initializer, ts.SyntaxKind.AsyncKeyword);

    const declarationStableId = this.createNode('LocalFunctionDeclaration', 'local function declaration', continuation.declaration.name, {
      labels: uniqueStrings([
        'FnDeclaration',
        isAsync ? 'Async' : undefined,
      ]),
      annotationKind: 'Callable',
      diaName: continuation.name,
      actionTextRaw: statement.getText(this.sourceFile),
      operationSubjectText: continuation.name,
      operationValueText: continuation.initializer.getText(this.sourceFile),
      calleeStableId: this.stableIdByDeclaration.get(continuation.initializer),
      asyncDeclarationKind: 'local-function',
      containerMethodKind: 'declares',
      renderPartsLayout: 'container-overlay-side',
      renderPrimaryPartIndex: 1,
      renderPartsJson: JSON.stringify([
        {
          stableId: `${getExtendedStableId(this.sourceFile, continuation.declaration.name)}:container`,
          text: continuation.name,
          kind: 'function-container',
          labels: ['FnDeclaration', 'FunctionContainer'],
          order: 0,
          sourceStableId: getExtendedStableId(this.sourceFile, continuation.declaration.name),
        },
        {
          stableId: getExtendedStableId(this.sourceFile, continuation.declaration.name),
          text: 'declares',
          kind: 'method',
          labels: ['Method', 'ContainerMethod', 'Virtual', 'Declaration'],
          order: 1,
          sourceStableId: getExtendedStableId(this.sourceFile, continuation.declaration.name),
        },
      ] satisfies RenderPartDescriptor[]),
    }, getExtendedStableId(this.sourceFile, continuation.declaration.name));
    if (isAsync) {
      this.localAsyncContinuationsByName.set(continuation.name, {
        declarationId: declarationStableId,
        name: continuation.name,
        declaration: continuation.declaration,
        initializer: continuation.initializer,
      });
    }
    this.registerFirstNode(declarationStableId, incomingExits);
    this.connectPendingToNode(incomingExits, declarationStableId);
    this.materializeLocalFunctionBody(continuation, declarationStableId, declarationStableId);

    return {
      firstNodeId: declarationStableId,
      openExits: [this.createPendingExit(undefined, declarationStableId, 'NEXT')],
      pendingBreaks: [],
      pendingContinues: [],
      pendingThrows: [],
    };
  }

  private materializeContinuationRunStatement(statement: ts.Statement, incomingExits: PendingExit[]): BuildResult | undefined {
    const run = this.getContinuationRunExpression(statement);
    if (!run) {
      return undefined;
    }

    const runStableId = this.createNode('Call', 'detached async call', run.callExpression, {
      labels: uniqueStrings(['Call', 'Async', 'FireAndForget']),
      diaName: `${run.name}()`,
      actionTextRaw: statement.getText(this.sourceFile),
      operationSubjectText: run.name,
      asyncSchedulerKind: 'local-async-continuation',
      asyncContract: 'fire-and-forget',
      renderPartsLayout: 'horizontal',
      renderPrimaryPartIndex: 1,
      renderPartsJson: JSON.stringify([
        {
          stableId: `${getExtendedStableId(this.sourceFile, run.callExpression)}:void`,
          text: 'void',
          kind: 'method',
          labels: ['Keyword', 'System'],
          order: 0,
          sourceStableId: getExtendedStableId(this.sourceFile, run.callExpression.parent),
        },
        {
          stableId: getExtendedStableId(this.sourceFile, run.callExpression),
          text: `${run.name}()`,
          kind: 'method',
          labels: ['Op', 'Call'],
          order: 1,
          sourceStableId: getExtendedStableId(this.sourceFile, run.callExpression),
        },
      ] satisfies RenderPartDescriptor[]),
      ...this.callBoundaryExtra(run.callExpression, 'open'),
    }, getExtendedStableId(this.sourceFile, run.callExpression));
    this.registerFirstNode(runStableId, incomingExits);
    this.connectPendingToNode(incomingExits, runStableId);
    if (run.callExpression.arguments.length === 0) {
      return {
        firstNodeId: runStableId,
        openExits: [this.createPendingExit(undefined, runStableId, 'NEXT')],
        pendingBreaks: [],
        pendingContinues: [],
        pendingThrows: [],
      };
    }
    const runProxyStableId = this.createLocalFunctionProxy(
      {
        declaration: run.declaration,
        name: run.name,
        initializer: run.initializer,
      },
      run.initializer,
      run.declarationId,
      `run:${getExtendedStableId(this.sourceFile, run.callExpression)}`,
      'detached async call target',
      {
        ...this.callBoundaryExtra(run.callExpression, 'close'),
        callBoundaryPeerStableId: runStableId,
      },
    );
    const runNode = this.nodeByStableId(runStableId);
    if (runNode) runNode.callBoundaryPeerStableId = runProxyStableId;

    const argumentExits: PendingExit[] = [];
    [...run.callExpression.arguments].forEach((argument, index) => {
      const argEntry = this.createArgumentNode(run.callExpression, argument, index);
      if (argEntry.omitFromCall) return;
      const argumentName = this.getParameterName(run.callExpression, index);
      this.addEdge(undefined, runStableId, undefined, argEntry.argStableId, 'ARG', {
        label: `arg ${index + 1}`,
        argumentName,
        argumentIndex: index,
      });
      argumentExits.push(...argEntry.exitsToArgs);
    });
    if (!argumentExits.length) {
      this.addEdge(undefined, runStableId, undefined, runProxyStableId, 'ArgJoin', {
        label: '',
        callTextRaw: run.callExpression.getText(this.sourceFile),
        callSiteStableId: runStableId,
        invocationType: 'CALL',
        flowLayer: 'data',
      });
    } else {
      argumentExits.forEach((exit) => {
        this.addEdge(exit.fromKind, exit.fromId, undefined, runProxyStableId, exit.edgeType, {
          label: exit.label,
          argumentName: exit.argumentName,
          argumentIndex: exit.argumentIndex,
          callTextRaw: run.callExpression.getText(this.sourceFile),
          callSiteStableId: runStableId,
          invocationType: 'CALL',
        });
      });
    }
    return {
      firstNodeId: runStableId,
      openExits: [this.createPendingExit(undefined, runStableId, 'NEXT')],
      pendingBreaks: [],
      pendingContinues: [],
      pendingThrows: [],
    };
  }

  private resolveMissingRequireModuleMemberTarget(
    declaration: ts.VariableDeclaration,
    moduleSpecifier: string,
    methodName: string,
  ): ResolvedCallTarget | undefined {
    if (!moduleSpecifier.startsWith('.')) {
      return undefined;
    }

    const resolvedPath = resolveRelativeModulePath(this.sourceFile, moduleSpecifier);
    if (resolvedPath) {
      return undefined;
    }

    const stableModule = sanitizeSyntheticExternalPart(moduleSpecifier);
    const stableMethod = sanitizeSyntheticExternalPart(methodName);
    const moduleStableId = `missing:module:${stableModule}`;
    const methodStableId = `${moduleStableId}:method:${stableMethod}`;
    const displayModule = moduleSpecifier.replace(/\\/g, '/');
    const gatedByFeatureNames = collectFeatureGateNames(declaration.initializer);
    const expectedPath = toPosix(path.resolve(path.dirname(this.sourceFile.fileName), moduleSpecifier));
    const componentId = this.createNode('Object', displayModule, declaration, {
      labels: ['Missing', 'MissingComponent'],
      parentFnStableId: buildOpaqueStableIdDescriptor(moduleStableId, EXTERNAL_MODULE_REPO_PATH),
      diaName: displayModule,
      actionTextRaw: declaration.getText(this.sourceFile),
      moduleSpecifier,
      resolvedModulePath: expectedPath,
      missingReason: 'relative require target not found in checkout',
      gatedByFeatureNames,
    }, moduleStableId);
    const methodId = this.createNode('Call', methodName, declaration, {
      labels: ['Missing', 'Method', 'Request'],
      parentFnStableId: buildOpaqueStableIdDescriptor(moduleStableId, EXTERNAL_MODULE_REPO_PATH),
      diaName: formatObjectMethodDiaName(displayModule, methodName),
      actionTextRaw: `${displayModule}.${methodName}`,
      moduleSpecifier,
      resolvedModulePath: expectedPath,
      missingReason: 'relative require target not found in checkout',
      missingComponentStableId: componentId,
      missingMethodName: methodName,
      gatedByFeatureNames,
    }, methodStableId);
    this.addStructuralEdgeOnce(componentId, methodId, 'HAS_METHOD', methodName);

    return {
      stableId: methodId,
      name: `${displayModule}.${methodName}`,
      repoRelativePath: EXTERNAL_MODULE_REPO_PATH,
      targetKind: 'missing-module-method',
      moduleStableId: componentId,
      moduleSpecifier,
      resolvedModulePath: expectedPath,
      missingReason: 'relative require target not found in checkout',
      missingMethodName: methodName,
      gatedByFeatureNames,
    };
  }

  private addStructuralEdgeOnce(fromId: string, toId: string, type: FlowEdgeKind, label?: string) {
    const key = `${fromId}\u0000${type}\u0000${toId}\u0000${label || ''}`;
    if (this.seenStructuralEdgeKeys.has(key)) {
      return;
    }
    this.seenStructuralEdgeKeys.add(key);
    this.addEdge(undefined, fromId, undefined, toId, type, { label });
  }

  private isDeveloperSideCallExpression(callExpression: ts.CallExpression | ts.NewExpression, target: ResolvedCallTarget | undefined) {
    if (isCallableGraphTarget(target)) {
      return true;
    }

    const signatureDeclaration = this.checker.getResolvedSignature(callExpression)?.declaration;
    if (signatureDeclaration && declarationIsTracked(signatureDeclaration)) {
      return true;
    }

    const callee = unwrapExpression(callExpression.expression);
    if (ts.isIdentifier(callee)) {
      return this.nodeHasTrackedDeclaration(callee);
    }

    if (ts.isPropertyAccessExpression(callee)) {
      return this.nodeHasTrackedDeclaration(callee.name)
        || this.memberAccessRootTypeDeclaresMethod(callee.expression, callee.name.text);
    }

    return false;
  }

  private nodeHasTrackedDeclaration(node: ts.Node) {
    const symbol = this.checker.getSymbolAtLocation(node);
    const declarations = symbol?.declarations || (symbol?.valueDeclaration ? [symbol.valueDeclaration] : []);
    return declarations.some((declaration) => declarationIsTracked(declaration));
  }

  private memberAccessRootTypeDeclaresMethod(node: ts.Expression, methodName: string) {
    let root = unwrapExpression(node);
    while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) {
      root = unwrapExpression(root.expression);
    }
    if (!ts.isIdentifier(root)) return false;

    const symbol = this.checker.getSymbolAtLocation(root);
    const declarations = symbol?.declarations || (symbol?.valueDeclaration ? [symbol.valueDeclaration] : []);
    const typeNodes: ts.TypeNode[] = [];
    const addTypeNode = (typeNode: ts.TypeNode | undefined) => {
      if (!typeNode) return;
      typeNodes.push(typeNode);
      if (ts.isTypeReferenceNode(typeNode)) {
        typeNode.typeArguments?.forEach(addTypeNode);
      } else if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
        typeNode.types.forEach(addTypeNode);
      }
    };

    declarations.forEach((declaration) => {
      if (ts.isVariableDeclaration(declaration)) {
        addTypeNode(declaration.type);
        const initializer = declaration.initializer && unwrapExpression(declaration.initializer);
        if (initializer && (ts.isCallExpression(initializer) || ts.isNewExpression(initializer))) {
          initializer.typeArguments?.forEach(addTypeNode);
        }
      } else if (
        ts.isParameter(declaration)
        || ts.isPropertyDeclaration(declaration)
        || ts.isPropertySignature(declaration)
      ) {
        addTypeNode(declaration.type);
      }
    });

    return typeNodes.some((typeNode) => {
      const member = this.checker.getTypeFromTypeNode(typeNode).getProperty(methodName);
      const memberDeclarations = member?.declarations || (member?.valueDeclaration ? [member.valueDeclaration] : []);
      return memberDeclarations.some((memberDeclaration) => declarationIsTracked(memberDeclaration));
    });
  }

  private getCallRole(callExpression: ts.CallExpression | ts.NewExpression, target: ResolvedCallTarget | undefined): 'Read' | 'Write' | 'Request' | 'Call' | 'Op' {
    if (ts.isCallExpression(callExpression) && this.isStateUpdateCall(callExpression)) return 'Write';
    const accessorRole: AccessorRole | undefined = (
      target?.stableId ? this.accessorIndex.roleByFunctionStableId.get(target.stableId) : undefined
    ) || this.accessorIndex.roleForCall(this.sourceFile, callExpression);
    if (accessorRole === 'Getter') return 'Read';
    if (accessorRole === 'Setter') return 'Write';
    if (ts.isCallExpression(callExpression) && this.isOperandExpressionContext(callExpression)) {
      return this.isDeveloperSideCallExpression(callExpression, target) ? 'Request' : 'Op';
    }
    return this.isDeveloperSideCallExpression(callExpression, target) ? 'Call' : 'Op';
  }

  private shouldMaterializeCallArguments(callExpression: ts.CallExpression, target: ResolvedCallTarget | undefined) {
    void target;
    return callExpression.arguments.length > 0;
  }

  private callbackReturnType(callback: ts.ArrowFunction | ts.FunctionExpression) {
    const signature = this.checker.getSignatureFromDeclaration(callback);
    return signature ? this.checker.getReturnTypeOfSignature(signature) : undefined;
  }

  private callbackReturnsVoid(callback: ts.ArrowFunction | ts.FunctionExpression) {
    const returnType = this.callbackReturnType(callback);
    if (!returnType) return false;
    if ((returnType.flags & (ts.TypeFlags.Void | ts.TypeFlags.Never)) !== 0) return true;
    const awaitedType = this.checker.getAwaitedType(returnType);
    return Boolean(awaitedType && (awaitedType.flags & (ts.TypeFlags.Void | ts.TypeFlags.Never)) !== 0);
  }

  private callbackReturnsBoolean(callback: ts.ArrowFunction | ts.FunctionExpression) {
    if (callback.body && ts.isExpression(callback.body) && isBooleanLikeExpression(unwrapExpression(callback.body))) {
      return true;
    }
    const returnType = this.callbackReturnType(callback);
    return Boolean(returnType && (returnType.flags & ts.TypeFlags.BooleanLike) !== 0);
  }

  private callbackReturnsNumber(callback: ts.ArrowFunction | ts.FunctionExpression) {
    const returnType = this.callbackReturnType(callback);
    return Boolean(returnType && (returnType.flags & ts.TypeFlags.NumberLike) !== 0);
  }

  private callbackTransformsItsOnlyParameter(callback: ts.ArrowFunction | ts.FunctionExpression) {
    if (callback.parameters.length !== 1) return false;
    const parameter = callback.parameters[0];
    const parameterName = ts.isIdentifier(parameter.name) ? parameter.name.text : undefined;
    const body = callback.body && ts.isExpression(callback.body) ? unwrapExpression(callback.body) : undefined;
    if (
      parameterName
      && body
      && ts.isObjectLiteralExpression(body)
      && body.properties.some((property) => (
        ts.isSpreadAssignment(property)
        && ts.isIdentifier(unwrapExpression(property.expression))
        && (unwrapExpression(property.expression) as ts.Identifier).text === parameterName
      ))
    ) {
      return true;
    }
    const returnType = this.callbackReturnType(callback);
    const parameterType = this.checker.getTypeAtLocation(parameter);
    return Boolean(
      returnType
      && !(returnType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Void | ts.TypeFlags.Never))
      && !(parameterType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
      && this.checker.isTypeAssignableTo(returnType, parameterType),
    );
  }

  private callbackRoleLabels(callbackKind: CallbackKind, callback: ts.ArrowFunction | ts.FunctionExpression) {
    const roleLabelByKind: Record<CallbackKind, string> = {
      updater: 'StateUpdater',
      predicate: 'Predicate',
      mapper: 'Mapper',
      reducer: 'Reducer',
      consumer: 'Consumer',
      comparator: 'Comparator',
      factory: 'Factory',
      callback: 'Callback',
    };
    const isAsync = callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) || false;
    return uniqueStrings([
      'CallbackFn',
      roleLabelByKind[callbackKind],
      ...(callbackKind === 'updater' ? ['UpdaterFn'] : []),
      ...(isAsync ? ['Async'] : []),
    ]);
  }

  private callbackHeadDiaName(callback: ts.ArrowFunction | ts.FunctionExpression, fallback: string) {
    if (ts.isArrowFunction(callback)) {
      const relativeArrowEnd = callback.equalsGreaterThanToken.end - callback.getStart(this.sourceFile);
      return callback.getText(this.sourceFile).slice(0, relativeArrowEnd).replace(/\s+/gu, ' ').trim();
    }
    return fallback;
  }

  private callbackKindForArgument(callExpression: ts.CallExpression, index: number): CallbackKind {
    if (index === 0 && this.isStateUpdateCall(callExpression)) {
      return 'updater';
    }
    const argument = callExpression.arguments[index] && unwrapExpression(callExpression.arguments[index]);
    if (!argument || (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument))) {
      return 'callback';
    }
    const enclosingCallType = this.checker.getTypeAtLocation(callExpression);
    const receiver = ts.isPropertyAccessExpression(callExpression.expression)
      ? callExpression.expression.expression
      : undefined;
    if (
      index === 0
      && (!receiver || (enclosingCallType.flags & (ts.TypeFlags.Void | ts.TypeFlags.Never)) !== 0)
      && this.callbackTransformsItsOnlyParameter(argument)
    ) {
      return 'updater';
    }
    if (this.callbackReturnsBoolean(argument)) return 'predicate';
    if (this.callbackReturnsVoid(argument)) return 'consumer';

    const callType = this.checker.getTypeAtLocation(callExpression);
    const receiverType = receiver ? this.checker.getTypeAtLocation(receiver) : undefined;
    const returnsReceiver = Boolean(
      receiverType
      && this.checker.isTypeAssignableTo(callType, receiverType)
      && this.checker.isTypeAssignableTo(receiverType, callType),
    );
    if (argument.parameters.length >= 2) {
      if (this.callbackReturnsNumber(argument) && returnsReceiver) return 'comparator';
      return 'reducer';
    }
    if (receiverType) return 'mapper';

    const calleeName = (getCallLikeName(callExpression.expression) || '').split('.').pop() || '';
    if (index === 0 && ['find', 'filter', 'some', 'every'].includes(calleeName)) return 'predicate';
    if (index === 0 && ['map', 'flatMap'].includes(calleeName)) return 'mapper';
    if (index === 0 && ['reduce', 'reduceRight'].includes(calleeName)) return 'reducer';
    if (index === 0 && calleeName === 'forEach') return 'consumer';
    if (index === 0 && calleeName === 'sort') return 'comparator';
    return this.callbackReturnType(argument) ? 'factory' : 'callback';
  }

  private isInsideUpdaterCallback(node: ts.Node) {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
        const owner = current.parent;
        if (owner && ts.isCallExpression(owner)) {
          const index = owner.arguments.findIndex((argument) => unwrapExpression(argument) === current);
          if (index >= 0 && this.callbackKindForArgument(owner, index) === 'updater') return true;
        }
      }
      current = current.parent;
    }
    return false;
  }

  private shouldMaterializeTrackedCallExecution(
    callExpression: ts.CallExpression,
    explicitlySuppressed = false,
  ) {
    if (explicitlySuppressed) return false;
    if (callExpression.arguments.some((argument, index) => {
      const current = unwrapExpression(argument);
      return (ts.isArrowFunction(current) || ts.isFunctionExpression(current))
        && this.callbackKindForArgument(callExpression, index) === 'updater';
    })) return false;
    if (!this.isInsideUpdaterCallback(callExpression)) return true;
    return callExpression.arguments.some(isFunctionArgumentExpression);
  }

  private callbackKindForCollectionSemantics(
    semantics: CollectionMethodSemantics,
    fallback: CallbackKind,
  ): CallbackKind {
    switch (semantics.iterationMode) {
      case 'select':
      case 'search':
      case 'quantify':
        return 'predicate';
      case 'transform':
        return 'mapper';
      case 'accumulate':
        return 'reducer';
      case 'consume':
        return 'consumer';
      case 'compare':
        return 'comparator';
      default:
        return fallback;
    }
  }

  private callbackExecutionContract(
    callbackKind: CallbackKind,
    ownerCall?: ts.CallExpression,
  ) {
    const ownerMethod = ownerCall
      ? (getCallLikeName(ownerCall.expression) || '').split('.').pop()
      : undefined;
    if (ownerMethod && ['then', 'catch', 'finally'].includes(ownerMethod)) {
      return { callbackDeferred: true, asyncContract: `promise-${ownerMethod}-callback` };
    }
    if (callbackKind === 'updater') {
      return { callbackDeferred: true, asyncContract: 'deferred-callback' };
    }
    if (['predicate', 'mapper', 'reducer', 'consumer', 'comparator'].includes(callbackKind)) {
      return { callbackDeferred: false, asyncContract: 'synchronous-callback' };
    }
    return { callbackDeferred: undefined, asyncContract: 'unknown-callback' };
  }

  private resolveFunctionReferenceTarget(expression: ts.Expression): ResolvedCallTarget | undefined {
    const current = unwrapExpression(expression);

    if (isFunctionLikeNode(current)) {
      const stableId = this.stableIdByDeclaration.get(current);
      if (!stableId) {
        return undefined;
      }

      return {
        stableId,
        name: getFunctionName(current),
        repoRelativePath: getRepoRelativePath(current.getSourceFile().fileName),
      };
    }

    if (!ts.isIdentifier(current)) {
      return undefined;
    }

    const symbol = this.checker.getSymbolAtLocation(current);
    const declaration = symbol?.valueDeclaration || symbol?.declarations?.[0];
    const stableId = declaration ? this.stableIdByDeclaration.get(declaration) : undefined;
    if (declaration && stableId) {
      return {
        stableId,
        name: 'name' in declaration && declaration.name && ts.isIdentifier(declaration.name)
          ? declaration.name.text
          : current.text,
        repoRelativePath: getRepoRelativePath(declaration.getSourceFile().fileName),
      };
    }

    return this.uniqueFunctionTargetsByName.get(current.text);
  }

  private buildAssignedFunctionTarget(statement: ts.Statement) {
    if (!ts.isExpressionStatement(statement)) {
      return undefined;
    }

    const expression = unwrapExpression(statement.expression);
    if (!isSimpleAssignmentExpression(expression)) {
      return undefined;
    }

    if (!isMemberAccessExpression(expression.left)) {
      return undefined;
    }

    return this.resolveFunctionReferenceTarget(expression.right);
  }

  private buildCallTargetExtra(node: ts.Node): FlowNodeExtra | undefined {
    const callExpression = getCallLikeExpressionFromNode(node);

    if (!callExpression) {
      return undefined;
    }

    const target = this.resolveCallTarget(callExpression);
    if (!target?.stableId) {
      return undefined;
    }
    return {
      callTextRaw: callExpression.getText(this.sourceFile),
      calleeStableId: target.stableId,
      sourceCallStableId: getExtendedStableId(this.sourceFile, callExpression),
      calleeName: target.name,
      moduleSpecifier: target.moduleSpecifier,
      resolvedModulePath: target.resolvedModulePath,
      missingReason: target.missingReason,
      missingComponentStableId: target.moduleStableId,
      missingMethodName: target.missingMethodName,
      gatedByFeatureNames: target.gatedByFeatureNames,
    };
  }

  private callInvocationContract(callExpression: ts.CallExpression | ts.NewExpression) {
    const signatureDeclaration = this.checker.getResolvedSignature(callExpression)?.declaration;
    const declarationIsAsync = Boolean(
      signatureDeclaration
      && ts.canHaveModifiers(signatureDeclaration)
      && ts.getModifiers(signatureDeclaration)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword),
    );
    const resultType = this.checker.getTypeAtLocation(callExpression);
    const resultTypeText = this.checker.typeToString(resultType);
    const isAsynchronous = declarationIsAsync
      || Boolean(resultType.getProperty('then'))
      || /(^|\W)(?:Promise(?:Like)?|EnsurePromise)(?:<|\b)/u.test(resultTypeText);

    let current: ts.Node = callExpression;
    while (
      current.parent
      && (
        ts.isParenthesizedExpression(current.parent)
        || ts.isAsExpression(current.parent)
        || ts.isTypeAssertionExpression(current.parent)
        || ts.isNonNullExpression(current.parent)
        || ts.isSatisfiesExpression(current.parent)
      )
    ) {
      current = current.parent;
    }
    const isAwaited = Boolean(current.parent && ts.isAwaitExpression(current.parent));

    return {
      invocationMode: isAsynchronous ? 'asynchronous' as const : 'synchronous' as const,
      responseMode: isAsynchronous
        ? (isAwaited ? 'awaited' as const : 'none' as const)
        : 'return' as const,
    };
  }

  private isCallResultConsumed(callExpression: ts.CallExpression | ts.NewExpression) {
    let current: ts.Node = callExpression;
    while (
      current.parent
      && (
        ts.isParenthesizedExpression(current.parent)
        || ts.isAsExpression(current.parent)
        || ts.isTypeAssertionExpression(current.parent)
        || ts.isNonNullExpression(current.parent)
        || ts.isSatisfiesExpression(current.parent)
      )
    ) {
      current = current.parent;
    }
    if (!current.parent) return false;
    return !ts.isExpressionStatement(current.parent) && !ts.isVoidExpression(current.parent);
  }

  private callReturnsValue(callExpression: ts.CallExpression | ts.NewExpression, callRole: string) {
    if (callRole === 'Call' || callRole === 'Write') return false;
    const resultType = this.checker.getTypeAtLocation(callExpression);
    const resultTypeText = this.checker.typeToString(resultType);
    if ((resultType.flags & (ts.TypeFlags.Void | ts.TypeFlags.Never)) !== 0 || resultTypeText === 'void') {
      return false;
    }
    return callRole === 'Request'
      || callRole === 'Read'
      || this.isCallResultConsumed(callExpression);
  }

  private buildCallResultStableId(callStableId: string) {
    return `${callStableId}:result`;
  }

  private buildCallResultPartStableId(callStableId: string, part: 'container' | 'set') {
    return `${this.buildCallResultStableId(callStableId)}:${part}`;
  }

  private createCallResultNode(
    callExpression: ts.CallExpression,
    callStableId: string,
    options: { dataBranchOwnerStableId?: string } = {},
  ) {
    const rawResultType = this.checker.getTypeAtLocation(callExpression);
    const awaitedResultType = this.checker.getAwaitedType(rawResultType) || rawResultType;
    const resultTypeText = this.checker.typeToString(awaitedResultType);
    const producerName = getCallLikeName(callExpression.expression) || 'call';
    const resultName = `${producerName}\nresult`;
    const nestedDataBranchResult = Boolean(options.dataBranchOwnerStableId);
    return this.createNode('Value', 'call result', callExpression, {
      labels: uniqueStrings([
        'Result',
        ...(nestedDataBranchResult
          ? ['Virtual', 'ResultTarget', 'ValueSlot', 'LocalBinding', 'ValueCreate', 'Assignment', 'ContainerMethod', 'Set']
          : []),
        ...(this.isCollectionType(awaitedResultType) ? ['Collection'] : []),
      ]),
      diaName: resultName,
      actionTextRaw: callExpression.getText(this.sourceFile),
      sourceCallStableId: callStableId,
      resultOfCallStableId: callStableId,
      resultTypeText,
      synthetic: true,
      ...(nestedDataBranchResult ? {
        dataBranchOwnerStableId: options.dataBranchOwnerStableId,
        dataBranchFamilyRole: 'alternative-result' as const,
        nestedEvaluationDirection: 'down' as const,
        containerState: 'awaiting-assignment',
        containerMethodKind: 'set',
        renderPartsLayout: 'container-overlay-side' as const,
        renderPrimaryPartIndex: 0,
        renderPartsJson: JSON.stringify([
          {
            stableId: this.buildCallResultPartStableId(callStableId, 'container'),
            text: resultName,
            kind: 'value-container',
            labels: ['Value', 'Result', 'Virtual', 'ResultTarget', 'ValueSlot'],
            order: 0,
            fillState: 'empty',
            sourceStableId: getExtendedStableId(this.sourceFile, callExpression),
          },
          {
            stableId: this.buildCallResultPartStableId(callStableId, 'set'),
            text: 'set',
            kind: 'method',
            labels: ['Method', 'Assignment', 'ContainerMethod', 'Set', 'Virtual'],
            order: 1,
            sourceStableId: getExtendedStableId(this.sourceFile, callExpression),
          },
        ] satisfies RenderPartDescriptor[]),
      } : {}),
    }, this.buildCallResultStableId(callStableId));
  }

  private hasOriginalCallTarget(target: ResolvedCallTarget | undefined) {
    return Boolean(target && target.targetKind !== 'synthetic-external');
  }

  private addCallEdges(
    stepStableId: string,
    callExpression: ts.CallExpression | ts.NewExpression,
    target: ResolvedCallTarget | undefined,
    options: {
      edgeType?: 'CALL' | 'REQUEST' | 'READ' | 'WRITE';
      resultStableId?: string;
      callSiteStableId?: string;
      resultEdgeMode?: 'default' | 'value';
      resultDisplayLabel?: string;
      resultTargetRenderPartStableId?: string;
    } = {},
  ) {
    const callRole = this.getCallRole(callExpression, target);
    const invocationContract = this.callInvocationContract(callExpression);
    const edgeType = callRole === 'Read'
      ? 'READ'
      : callRole === 'Write'
        ? 'WRITE'
        : options.edgeType || (callRole === 'Request' ? 'REQUEST' : 'CALL');
    const callSiteStableId = options.callSiteStableId || stepStableId;
    const hasOriginal = this.hasOriginalCallTarget(target);
    const targetKind = target?.targetKind === 'missing-module-method' ? undefined : 'Fn';

    if (hasOriginal && target?.stableId) {
      this.addEdge(
        undefined,
        stepStableId,
        targetKind,
        target.stableId,
        edgeType,
        {
          label: target.name || shortenLabel(callExpression.getText(this.sourceFile)),
          callTextRaw: callExpression.getText(this.sourceFile),
          callSiteStableId,
          invocationType: edgeType,
          ...invocationContract,
        },
      );

      if (options.resultStableId && options.resultEdgeMode !== 'value') {
        this.addEdge(
          targetKind,
          target.stableId,
          undefined,
          options.resultStableId,
          edgeType === 'REQUEST' ? 'RESPONSE' : 'RESULT',
          {
            label: 'result',
            ...(options.resultDisplayLabel ? {
              diaName: options.resultDisplayLabel,
              displayLabel: options.resultDisplayLabel,
            } : {}),
            targetRenderPartStableId: options.resultTargetRenderPartStableId,
            callTextRaw: callExpression.getText(this.sourceFile),
            callSiteStableId,
            invocationType: edgeType,
            ...invocationContract,
          },
        );
      } else if (edgeType === 'REQUEST') {
        const responseTargetStableId = this.requestResponseTarget(stepStableId);
        const responseTargetsAssignment = responseTargetStableId !== stepStableId
          && this.nodeByStableId(responseTargetStableId)?.labels.includes('Assignment');
        this.addEdge(
          targetKind,
          target.stableId,
          undefined,
          responseTargetsAssignment ? stepStableId : responseTargetStableId,
          'RESPONSE',
          {
            label: target.name || shortenLabel(callExpression.getText(this.sourceFile)),
            callTextRaw: callExpression.getText(this.sourceFile),
            callSiteStableId,
            invocationType: edgeType,
            ...invocationContract,
          },
        );
        if (responseTargetsAssignment) {
          this.connectAssignmentResult(stepStableId, responseTargetStableId);
        }
      } else if (edgeType === 'CALL' && invocationContract.responseMode === 'return') {
        const resultTargetStableId = this.callResultTarget(callSiteStableId);
        if (resultTargetStableId) {
          this.addEdge(targetKind, target.stableId, undefined, resultTargetStableId, 'RESULT', {
            label: 'result',
            callTextRaw: callExpression.getText(this.sourceFile),
            callSiteStableId,
            invocationType: edgeType,
            ...invocationContract,
          });
        }
      }
    }

    if (options.resultStableId && options.resultEdgeMode === 'value') {
      this.addEdge(undefined, stepStableId, undefined, options.resultStableId, 'YIELDS_VALUE', {
        label: 'value',
        displayLabel: 'value',
        callTextRaw: callExpression.getText(this.sourceFile),
        callSiteStableId,
        invocationType: edgeType,
        flowLayer: 'data',
        semanticExpansion: 'receiver-method',
        protocolRole: 'collection-source-value',
        ...invocationContract,
      });
    } else if (options.resultStableId) {
      this.addEdge(undefined, stepStableId, undefined, options.resultStableId, 'RESULT', {
        label: 'result',
        ...(options.resultDisplayLabel ? {
          diaName: options.resultDisplayLabel,
          displayLabel: options.resultDisplayLabel,
        } : {}),
        targetRenderPartStableId: options.resultTargetRenderPartStableId,
        callTextRaw: callExpression.getText(this.sourceFile),
        callSiteStableId,
        invocationType: edgeType,
        ...invocationContract,
      });
      this.addEdge(undefined, stepStableId, undefined, options.resultStableId, 'PRODUCES_VALUE', {
        label: 'result',
        callTextRaw: callExpression.getText(this.sourceFile),
        callSiteStableId,
        invocationType: edgeType,
        semanticExpansion: 'receiver-method',
        ...invocationContract,
      });
    }
  }

  private buildArgumentStableId(expression: ts.Expression, index: number) {
    const { startLine, startColumn, endLine, endColumn } = getRange(this.sourceFile, expression);
    return `${buildStableIdFromCoordinates({
      filePath: toPosix(path.resolve(this.sourceFile.fileName)),
      startLine,
      startColumn,
      endLine,
      endColumn,
    })}:arg${index}`;
  }

  private runInFlowStep<T>(
    anchor: ts.Node,
    kind: 'statement' | 'condition' | 'execution',
    callback: () => T,
  ): T {
    const context = this.createFlowStepContext(anchor, kind);
    return this.runInFlowStepContext(context, callback);
  }

  private runInFlowBlock(
    anchor: ts.Node,
    role: 'side' | 'alternative' | 'switch-case',
    outcome: 'TRUE' | 'FALSE' | 'CASE' | 'DEFAULT' | 'NEXT',
    ownerBranchStableIds: string[],
    incomingExits: PendingExit[],
    callback: () => BuildResult,
  ): BuildResult {
    const parentFlowBlockStableId = this.resolveFlowBlockStableId(
      this.flowBlockContexts.at(-1)?.stableId,
    );
    const stableId = `flow-block:${role}:${outcome.toLowerCase()}:${getExtendedStableId(this.sourceFile, anchor)}`;
    const flowBlockOrder = this.flowBlockOrdinal;
    this.flowBlockOrdinal += 1;

    this.flowBlockContexts.push({
      stableId,
      role,
      outcome,
      order: flowBlockOrder,
    });
    let result: BuildResult;
    try {
      result = callback();
    } finally {
      this.flowBlockContexts.pop();
    }

    const directSteps = this.nodes.filter((node) => (
      node.parentFlowBlockStableId === stableId
      && node.labels.includes('Step')
    ));
    if (directSteps.length === 1) {
      const step = directSteps[0];
      const stepStableId = getStableIdKey(step.stableId);
      this.flowBlockStableIdAliases.set(stableId, stepStableId);
      step.labels = uniqueStrings([...step.labels, 'Block']);
      step.parentFlowBlockStableId = parentFlowBlockStableId;
      step.ownerBranchStableIds = uniqueStrings(ownerBranchStableIds);
      step.flowBlockRole = role;
      step.flowBlockOutcome = outcome;
      step.flowBlockOrder = flowBlockOrder;
      step.combinedStepFlowBlock = true;
      step.combinedFlowBlockSourceStableId = stableId;

      for (const node of this.nodes) {
        if (node !== step && node.parentFlowBlockStableId === stableId) {
          node.parentFlowBlockStableId = stepStableId;
        }
      }
      for (const edge of this.edges) {
        if (edge.fromId === stableId) edge.fromId = stepStableId;
        if (edge.toId === stableId) edge.toId = stepStableId;
      }
      this.addEdge('Fn', this.fnStableId, undefined, stepStableId, 'HAS_FLOW_BLOCK', {
        label: outcome.toLowerCase(),
        flowLayer: 'structure',
      });
      if (parentFlowBlockStableId) {
        this.addEdge(undefined, stepStableId, undefined, parentFlowBlockStableId, 'NESTED_IN', {
          label: 'nested in',
          flowLayer: 'structure',
        });
      }
      return result;
    }

    const flowBlockStableId = this.createNode('FlowBlock', `${outcome.toLowerCase()} flow`, anchor, {
      labels: ['Block'],
      diaName: `${outcome.toLowerCase()} flow`,
      parentFlowBlockStableId,
      ownerBranchStableIds: uniqueStrings(ownerBranchStableIds),
      flowBlockRole: role,
      flowBlockOutcome: outcome,
      flowBlockOrder,
      flowLayer: 'structure',
      annotationKind: 'FlowBlock',
      synthetic: true,
    }, stableId);
    this.addEdge('Fn', this.fnStableId, undefined, flowBlockStableId, 'HAS_FLOW_BLOCK', {
      label: outcome.toLowerCase(),
      flowLayer: 'structure',
    });
    if (parentFlowBlockStableId) {
      this.addEdge(undefined, flowBlockStableId, undefined, parentFlowBlockStableId, 'NESTED_IN', {
        label: 'nested in',
        flowLayer: 'structure',
      });
    }

    const flowBlock = this.nodes.find((node) => getStableIdKey(node.stableId) === flowBlockStableId);
    if (flowBlock) {
      const directMembers = this.nodes
        .filter((node) => (
          node.parentFlowBlockStableId === flowBlockStableId
          && getStableIdKey(node.stableId) !== flowBlockStableId
        ))
        .sort((left, right) => (
          (left.operationIndex ?? Number.MAX_SAFE_INTEGER)
          - (right.operationIndex ?? Number.MAX_SAFE_INTEGER)
        ));
      flowBlock.headStableIds = result.firstNodeId
        ? [result.firstNodeId]
        : directMembers.length
          ? [getStableIdKey(directMembers[0].stableId)]
          : uniqueStrings(incomingExits.map((exit) => exit.fromId));
      const resultTailStableIds = uniqueStrings([
        ...result.openExits.map((exit) => exit.fromId),
        ...result.pendingBreaks.map((exit) => exit.fromId),
        ...result.pendingContinues.map((exit) => exit.fromId),
        ...result.pendingThrows.map((exit) => exit.fromId),
      ]);
      flowBlock.tailStableIds = resultTailStableIds.length
        ? resultTailStableIds
        : directMembers.length
          ? [getStableIdKey(directMembers.at(-1)!.stableId)]
          : [...flowBlock.headStableIds];
    }
    return result;
  }

  private createFlowStepContext<Kind extends 'statement' | 'condition' | 'execution'>(
    anchor: ts.Node,
    kind: Kind,
    stableRole: Kind | 'loop' = kind,
  ): FlowStepContext & { kind: Kind } {
    const localFunctionStableId = this.localFunctionContexts.at(-1)?.stableId;
    const baseStableId = `flow-step:${stableRole}:${getExtendedStableId(this.sourceFile, anchor)}`;
    const syntaxPlan = this.syntaxRegionPlanByNode.get(anchor) || {
      depth: 0,
      relativeColumn: 0,
      relativeRow: 0,
    };
    const syntaxBoundary = this.syntaxBoundaryForAnchor(anchor);
    const context: FlowStepContext & { kind: Kind } = {
      stableId: localFunctionStableId
        ? `${baseStableId}:local-function-${sanitizeSyntheticExternalPart(localFunctionStableId)}`
        : baseStableId,
      kind,
      order: this.flowStepOrdinal,
      syntaxEntryStableId: syntaxBoundary.entryStableId,
      syntaxExitStableIds: syntaxBoundary.exitStableIds,
      structureDepth: syntaxPlan.depth,
      structureRelativeColumn: syntaxPlan.relativeColumn,
      structureRelativeRow: syntaxPlan.relativeRow,
    };
    this.flowStepOrdinal += 1;
    this.createNode('Step', kind, anchor, {
      labels: ['Step'],
      diaName: kind,
      synthetic: true,
      flowStepKind: kind,
      flowStepOrder: context.order,
      syntaxEntryStableId: context.syntaxEntryStableId,
      syntaxExitStableIds: context.syntaxExitStableIds,
      structureDepth: context.structureDepth,
      structureRelativeColumn: context.structureRelativeColumn,
      structureRelativeRow: context.structureRelativeRow,
      annotationKind: 'Step',
      flowLayer: 'control',
    }, context.stableId, false);
    return context;
  }

  private syntaxBoundaryForAnchor(anchor: ts.Node): {
    entryStableId?: string;
    exitStableIds?: string[];
  } {
    if (ts.isVariableStatement(anchor)) {
      const declaration = anchor.declarationList.declarations[0];
      const binding = declaration && (
        ts.isIdentifier(declaration.name)
          ? declaration.name
          : ts.isObjectBindingPattern(declaration.name)
            ? declaration.name.elements
                .map((element) => element.name)
                .find(ts.isIdentifier)
            : undefined
      );
      const stableId = binding
        ? this.contextualizeHorizontalStableId(getExtendedStableId(this.sourceFile, binding), binding)
        : undefined;
      return stableId ? { entryStableId: stableId, exitStableIds: [stableId] } : {};
    }
    if (ts.isExpressionStatement(anchor)) {
      const expression = unwrapExpression(anchor.expression);
      if (isSimpleAssignmentExpression(expression)) {
        const stableId = this.contextualizeHorizontalStableId(
          getExtendedStableId(this.sourceFile, expression.left),
          expression.left,
        );
        return { entryStableId: stableId, exitStableIds: [stableId] };
      }
      return {
        entryStableId: this.contextualizeHorizontalStableId(
          getExtendedStableId(this.sourceFile, expression),
          expression,
        ),
      };
    }
    return { entryStableId: getExtendedStableId(this.sourceFile, anchor) };
  }

  private finalizeFlowStepContext(context: FlowStepContext) {
    const step = this.nodeByStableId(context.stableId);
    if (!step) throw new Error(`Extracted Step is missing: ${context.stableId}`);
    const members = this.nodes
      .filter((node) => (
        node.parentStepStableId === context.stableId
        && getStableIdKey(node.stableId) !== context.stableId
      ))
      .sort((left, right) => (
        (left.operationIndex ?? Number.MAX_SAFE_INTEGER)
        - (right.operationIndex ?? Number.MAX_SAFE_INTEGER)
        || getStableIdKey(left.stableId).localeCompare(getStableIdKey(right.stableId))
      ));
    if (!members.length) return;

    const boundaryMembers = members.filter((member) => (
      !member.renderHidden
      && (!member.semanticExpansion || member.labels.includes('Flow') && member.labels.includes('Branch'))
    ));
    const boundaries = executionStepBoundaries(
      boundaryMembers.length ? boundaryMembers : members,
      this.edges,
      members,
    );
    const syntaxEntryStableId = context.syntaxEntryStableId || step.syntaxEntryStableId;
    const syntaxEntryIsMember = syntaxEntryStableId
      ? members.some((member) => getStableIdKey(member.stableId) === syntaxEntryStableId)
      : false;
    step.syntaxEntryStableId = syntaxEntryIsMember ? syntaxEntryStableId : boundaries.headStableIds[0];
    step.headStableIds = step.syntaxEntryStableId
      ? [step.syntaxEntryStableId]
      : boundaries.headStableIds;
    const syntaxExitStableIds = (context.syntaxExitStableIds || step.syntaxExitStableIds || [])
      .filter((stableId) => members.some((member) => getStableIdKey(member.stableId) === stableId));
    step.syntaxExitStableIds = syntaxExitStableIds.length ? syntaxExitStableIds : undefined;
    step.tailStableIds = syntaxExitStableIds.length ? syntaxExitStableIds : boundaries.tailStableIds;
    step.operationIndex = Math.min(...members.map((member) => member.operationIndex ?? Number.MAX_SAFE_INTEGER));

    for (const member of members) {
      const memberStableId = getStableIdKey(member.stableId);
      const incidentLayers = this.edges
        .filter((edge) => edge.fromId === memberStableId || edge.toId === memberStableId)
        .map((edge) => edge.flowLayer || flowLayerForEdge(edge.type));
      member.flowLayer = mergeFlowLayers([
        ...(member.flowLayer ? [member.flowLayer] : []),
        ...incidentLayers,
      ]);
      if (member.flowLayer === 'data' || member.flowLayer === 'mixed') {
        member.dataFlowRole ||= dataFlowRoleForNode(member);
        member.ownerStepStableId ||= context.stableId;
      }
    }
  }

  private finalizeExtractedFlowSteps() {
    const steps = this.nodes
      .filter((node) => node.labels.includes('Step'))
      .sort((left, right) => (
        (right.structureDepth ?? 0) - (left.structureDepth ?? 0)
        || (right.flowStepOrder ?? 0) - (left.flowStepOrder ?? 0)
      ));
    for (const step of steps) {
      const kind = step.flowStepKind;
      if (kind !== 'statement' && kind !== 'condition' && kind !== 'execution') continue;
      this.finalizeFlowStepContext({
        stableId: getStableIdKey(step.stableId),
        kind,
        order: step.flowStepOrder ?? 0,
        syntaxEntryStableId: step.syntaxEntryStableId,
        syntaxExitStableIds: step.syntaxExitStableIds,
        structureDepth: step.structureDepth ?? 0,
        structureRelativeColumn: step.structureRelativeColumn ?? 0,
        structureRelativeRow: step.structureRelativeRow ?? 0,
      });
    }
  }

  private runInFlowStepContext<T>(
    context: FlowStepContext,
    callback: () => T,
  ): T {
    this.flowStepContexts.push(context);
    try {
      const result = callback();
      if (!context.syntaxEntryStableId && result && typeof result === 'object' && 'firstNodeId' in result) {
        const firstNodeId = (result as { firstNodeId?: unknown }).firstNodeId;
        if (typeof firstNodeId === 'string' && firstNodeId) {
          context.syntaxEntryStableId = firstNodeId;
          const step = this.nodeByStableId(context.stableId);
          if (step) step.syntaxEntryStableId = firstNodeId;
        }
      }
      if (result && typeof result === 'object' && 'openExits' in result) {
        const openExits = (result as { openExits?: unknown }).openExits;
        if (Array.isArray(openExits)) {
          const syntaxExitStableIds = uniqueStrings(openExits
            .map((exit) => (
              exit && typeof exit === 'object' && 'fromId' in exit
                ? (exit as { fromId?: unknown }).fromId
                : undefined
            ))
            .filter((stableId): stableId is string => typeof stableId === 'string' && stableId.length > 0));
          if (syntaxExitStableIds.length) {
            context.syntaxExitStableIds = syntaxExitStableIds;
            const step = this.nodeByStableId(context.stableId);
            if (step) step.syntaxExitStableIds = syntaxExitStableIds;
          }
        }
      }
      return result;
    } finally {
      this.flowStepContexts.pop();
      this.finalizeFlowStepContext(context);
    }
  }

  private runInStatementFlowStep<T>(
    statement: ts.Statement,
    callback: () => T,
    executionSegmentState?: {
      context?: FlowStepContext;
      forceExecution?: boolean;
    },
  ): T {
    const current = this.flowStepContexts.at(-1);
    const opensOwnControlSteps = ts.isIfStatement(statement)
      || ts.isSwitchStatement(statement)
      || isLoopStatement(statement)
      || ts.isTryStatement(statement);
    const expression = ts.isExpressionStatement(statement)
      ? unwrapExpression(statement.expression)
      : undefined;
    const startsAssignmentStep = ts.isVariableStatement(statement)
      || Boolean(expression && isSimpleAssignmentExpression(expression));
    const startsHorizontalCallStep = ts.isExpressionStatement(statement)
      && collectCallExpressions(statement.expression).some((callExpression) => (
        !this.inlineCallUsesCallNodeAsProxy(callExpression)
      ));
    const startsTerminalStep = ts.isReturnStatement(statement)
      || ts.isThrowStatement(statement)
      || ts.isBreakStatement(statement)
      || ts.isContinueStatement(statement);
    if (opensOwnControlSteps) {
      if (executionSegmentState) executionSegmentState.context = undefined;
      return callback();
    }
    if (this.aggregateFlowStepDepth > 0 && current?.kind === 'execution') {
      return callback();
    }
    const belongsToExecutionFlow = current?.kind === 'execution'
      || (!current && executionSegmentState?.forceExecution === true);
    if (belongsToExecutionFlow && startsTerminalStep) {
      if (executionSegmentState) executionSegmentState.context = undefined;
      return this.runInFlowStep(statement, 'execution', callback);
    }
    if (belongsToExecutionFlow && !startsAssignmentStep) {
      if (!executionSegmentState) return callback();
      if (startsHorizontalCallStep) executionSegmentState.context = undefined;
      const segmentContext = executionSegmentState.context
        ?? this.createFlowStepContext(statement, 'execution');
      executionSegmentState.context = segmentContext;
      return this.runInFlowStepContext(segmentContext, callback);
    }
    if (executionSegmentState) executionSegmentState.context = undefined;
    return this.runInFlowStep(statement, 'statement', callback);
  }

  private callSiteLabels(callExpression: ts.CallExpression, callRoleLabel: string) {
    const target = this.resolveRenderableCallTarget(callExpression);
    const labels = this.semanticCallSiteLabels(callExpression, [
      callRoleLabel,
      ...(!this.isDeveloperSideCallExpression(callExpression, target) ? ['System'] : []),
      ...this.operationProviderLabels(callExpression),
    ]);
    if (isPropertyAccessLikeExpression(unwrapExpression(callExpression.expression))) {
      labels.push('Method');
    }
    if (this.isCollectionMethodCall(callExpression)) {
      labels.push('Collection');
    }
    if (this.isOperandExpressionContext(callExpression)) {
      labels.push('Operand');
    }
    return uniqueStrings(labels);
  }

  private isCollectionType(type: ts.Type): boolean {
    if (type.isUnionOrIntersection()) {
      return type.types.some((member) => this.isCollectionType(member));
    }
    return this.checker.isArrayType(type) || this.checker.isTupleType(type);
  }

  private isReactUseMemoCall(callExpression: ts.CallExpression) {
    const callee = unwrapExpression(callExpression.expression);
    if (!ts.isIdentifier(callee)) return false;

    const symbol = this.checker.getSymbolAtLocation(callee);
    return Boolean(symbol?.declarations?.some((declaration) => {
      if (!ts.isImportSpecifier(declaration)) return false;
      const importDeclaration = declaration.parent.parent.parent;
      return ts.isImportDeclaration(importDeclaration)
        && ts.isStringLiteral(importDeclaration.moduleSpecifier)
        && importDeclaration.moduleSpecifier.text === 'react'
        && (declaration.propertyName?.text || declaration.name.text) === 'useMemo';
    }));
  }

  private isCollectionExpression(expression: ts.Expression, visited = new Set<ts.Symbol>()): boolean {
    const current = unwrapExpression(expression);
    if (this.isCollectionType(this.checker.getTypeAtLocation(current))) return true;

    if (ts.isCallExpression(current) && this.isReactUseMemoCall(current)) {
      const callback = current.arguments[0] && unwrapExpression(current.arguments[0]);
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        const returnsCollection = this.checker.getTypeAtLocation(callback)
          .getCallSignatures()
          .some((signature) => this.isCollectionType(this.checker.getReturnTypeOfSignature(signature)));
        if (returnsCollection) return true;
      }
    }

    if (!ts.isIdentifier(current)) return false;
    const symbol = this.checker.getSymbolAtLocation(current);
    if (!symbol || visited.has(symbol)) return false;
    visited.add(symbol);
    return Boolean(symbol.declarations?.some((declaration) => (
      ts.isVariableDeclaration(declaration)
      && declaration.initializer
      && this.isCollectionExpression(declaration.initializer, visited)
    )));
  }

  private isCollectionMethodCall(callExpression: ts.CallExpression) {
    const callee = unwrapExpression(callExpression.expression);
    return ts.isPropertyAccessExpression(callee)
      && this.isCollectionExpression(callee.expression);
  }

  private resolveCollectionMethodTarget(callExpression: ts.CallExpression): ResolvedCallTarget | undefined {
    if (!this.isCollectionMethodCall(callExpression)) return undefined;
    const callee = unwrapExpression(callExpression.expression);
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    const methodName = callee.name.text;
    const stableId = `external:collection-method:${sanitizeSyntheticExternalPart(methodName)}`;
    const target: ResolvedCallTarget = {
      stableId,
      name: methodName,
      repoRelativePath: EXTERNAL_RUNTIME_REPO_PATH,
      targetKind: 'synthetic-external',
    };
    SYNTHETIC_EXTERNAL_TARGETS_BY_KEY.set(stableId, target);
    return target;
  }

  private resolveRenderableCallTarget(callExpression: ts.CallExpression) {
    return this.resolveCallTarget(callExpression) || this.resolveCollectionMethodTarget(callExpression);
  }

  private callNodeKind(callExpression: ts.CallExpression, callRoleLabel: string): Extract<FlowNodeKind, 'Read' | 'Write' | 'Call' | 'Op' | 'Value'> {
    if (callRoleLabel === 'Read') return 'Read';
    if (callRoleLabel === 'Write') return 'Write';
    if (callRoleLabel === 'Request') return this.isOperandExpressionContext(callExpression) ? 'Value' : 'Call';
    return callRoleLabel === 'Call' ? 'Call' : 'Op';
  }

  private isColumnCollectionMethodCall(callExpression: ts.CallExpression) {
    const callee = unwrapExpression(callExpression.expression);
    return isPropertyAccessLikeExpression(callee)
      && isKnownCollectionMethod(callee.name.text)
      && this.isCollectionExpression(callee.expression);
  }

  private isSyntheticColumnMethodCall(callExpression: ts.CallExpression) {
    const callee = unwrapExpression(callExpression.expression);
    const name = ts.isIdentifier(callee)
      ? callee.text
      : isPropertyAccessLikeExpression(callee)
        ? callee.name.text
        : undefined;
    return name === 'set' || name === 'push' || name === 'add' || name === 'pop' || name === 'shift';
  }

  private callArgumentIsExtractedAsSubmethod(
    callExpression: ts.CallExpression,
    argument: ts.Expression,
    index: number,
  ) {
    if (!isFunctionArgumentExpression(argument)) return false;
    return this.isInsideUpdaterCallback(callExpression)
      || this.callbackKindForArgument(callExpression, index) === 'updater';
  }

  private callMosaicArguments(callExpression: ts.CallExpression) {
    const plannedIndexes = this.astRepresentationPlanByNode.get(callExpression)?.mosaicArgumentIndexes;
    return [...callExpression.arguments]
      .map((argument, index) => ({ argument, index }))
      .filter(({ argument, index }) => plannedIndexes
        ? plannedIndexes.includes(index)
        : !this.callArgumentIsExtractedAsSubmethod(callExpression, argument, index));
  }

  private callableMemberNames(expression: ts.Expression, fallbackDeclaration: ts.Declaration) {
    const type = this.checker.getNonNullableType(this.checker.getTypeAtLocation(expression));
    return new Set(type.getProperties()
      .filter((member) => !member.name.startsWith('__'))
      .filter((member) => {
        const declaration = member.valueDeclaration || member.declarations?.[0] || fallbackDeclaration;
        const memberType = this.checker.getNonNullableType(
          this.checker.getTypeOfSymbolAtLocation(member, declaration),
        );
        return memberType.getCallSignatures().length > 0;
      })
      .map((member) => member.name));
  }

  private conditionalProviderLeaves(expression: ts.Expression): ts.Identifier[] | undefined {
    const current = unwrapExpression(expression);
    if (ts.isIdentifier(current)) return [current];
    if (!ts.isConditionalExpression(current)) return undefined;
    const truthy = this.conditionalProviderLeaves(current.whenTrue);
    const falsy = this.conditionalProviderLeaves(current.whenFalse);
    return truthy && falsy ? [...truthy, ...falsy] : undefined;
  }

  private isConditionalCapabilityFacade(declaration: ts.VariableDeclaration) {
    if (!declaration.initializer) return false;
    const leaves = this.conditionalProviderLeaves(declaration.initializer);
    if (!leaves || leaves.length < 2) return false;

    const implementations = leaves.map((leaf) => {
      const symbol = resolvedSymbolAt(this.checker, leaf);
      const leafDeclaration = symbol?.valueDeclaration || symbol?.declarations?.[0];
      if (!leafDeclaration || !ts.isVariableDeclaration(leafDeclaration) || !leafDeclaration.initializer) return undefined;
      if (!ts.isCallExpression(unwrapExpression(leafDeclaration.initializer))) return undefined;
      return this.callableMemberNames(leaf, leafDeclaration);
    });
    if (implementations.some((members) => !members || members.size < 2)) return false;

    const [first, ...rest] = implementations as Set<string>[];
    const commonOperations = [...first].filter((name) => rest.every((members) => members.has(name)));
    return commonOperations.length >= 2;
  }

  private operationProviderLabels(callExpression: ts.CallExpression) {
    const callee = unwrapExpression(callExpression.expression);
    if (!isPropertyAccessLikeExpression(callee)) return [];
    const receiver = unwrapExpression(callee.expression);
    if (!ts.isIdentifier(receiver)) return [];

    const symbol = resolvedSymbolAt(this.checker, receiver);
    const declaration = symbol?.valueDeclaration || symbol?.declarations?.[0];
    if (!declaration) return [];

    if (
      ts.isNamespaceImport(declaration)
      || ts.isImportEqualsDeclaration(declaration)
      || (ts.isVariableDeclaration(declaration)
        && collectRequireSpecifiers(declaration.initializer).length > 0)
    ) {
      return ['OperationProvider', 'ModuleFacade'];
    }

    const declarationSource = declaration.getSourceFile();
    const standardLibraryDeclaration = declarationSource.isDeclarationFile
      && /(?:^|[\\/])lib(?:\.[^\\/]+)?\.d\.ts$/i.test(declarationSource.fileName);
    if (standardLibraryDeclaration) {
      const receiverType = this.checker.getNonNullableType(this.checker.getTypeAtLocation(receiver));
      const hasCallableMember = receiverType.getProperties().some((member) => {
        const memberDeclaration = member.valueDeclaration || member.declarations?.[0] || declaration;
        const memberType = this.checker.getNonNullableType(
          this.checker.getTypeOfSymbolAtLocation(member, memberDeclaration),
        );
        return memberType.getCallSignatures().length > 0;
      });
      return hasCallableMember
        ? ['OperationProvider', 'SystemProvider', 'System']
        : [];
    }

    if (this.isOperationProviderTypeAtLocation(receiver)) {
      return ['OperationProvider', 'CapabilityBundle'];
    }

    if (ts.isVariableDeclaration(declaration) && this.isConditionalCapabilityFacade(declaration)) {
      return ['OperationProvider', 'CapabilityBundle'];
    }

    // References remain linked to their canonical declarations. This method
    // only classifies the actual member call, not the receiver reference.
    return [];
  }

  private expressionRequiresVerticalExpansion(expression: ts.Expression): boolean {
    const current = unwrapExpression(expression);
    return this.astRepresentationPlanByNode.get(current)?.requiresVerticalExpansion
      ?? this.astRepresentationPlanByNode.get(expression)?.requiresVerticalExpansion
      ?? false;
  }

  private callBoundaryDesign(callExpression: ts.CallExpression): 'mosaic' | 'split' | 'column' {
    const design = this.astRepresentationPlanByNode.get(callExpression)?.callBoundaryDesign;
    if (!design) {
      throw new Error(`Missing AST representation plan for call: ${callExpression.getText(this.sourceFile)}`);
    }
    return design;
  }

  private inlineCallUsesCallNodeAsProxy(callExpression: ts.CallExpression) {
    return this.callBoundaryDesign(callExpression) !== 'split';
  }

  private callBoundaryExtra(
    callExpression: ts.CallExpression,
    role: 'open' | 'close',
    callPredicate = false,
  ): FlowNodeExtra {
    const callBoundaryDesign = this.callBoundaryDesign(callExpression);
    return {
      callBoundaryDesign,
      callBoundaryRole: callBoundaryDesign === 'split' ? role : undefined,
      callHasArguments: this.callMosaicArguments(callExpression).length > 0,
      callPredicate,
    };
  }

  private callBoundaryLabels(args: ts.Expression[]) {
    return ['Start'];
  }

  private callStartEffectExtra(callExpression: ts.CallExpression): FlowNodeExtra {
    return this.buildReactStateUpdateExtra(callExpression);
  }

  private enclosingCallbackStableId(node: ts.Node) {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
        const parent = current.parent;
        if (parent && ts.isCallExpression(parent)) {
          if (this.suppressCallbackArgumentNodeDepth > 0) {
            return this.contextualizeHorizontalStableId(
              getExtendedStableId(this.sourceFile, parent),
              parent,
            );
          }
          const index = parent.arguments.findIndex((argument) => unwrapExpression(argument) === current);
          if (index >= 0) {
            return this.materializedArgumentTargetStableId(current, index);
          }
        }
        return undefined;
      }
      if (ts.isFunctionLike(current)) return undefined;
      current = current.parent;
    }
    return undefined;
  }

  private nodeByStableId(stableId: string) {
    return this.nodes.find((node) => getStableIdKey(node.stableId) === stableId);
  }

  private materializedArgumentTargetStableId(argument: ts.Expression, index: number) {
    const expectedArgumentStableId = this.contextualizeHorizontalStableId(
      this.buildArgumentStableId(argument, index),
      argument,
    );
    const sourceStableId = getExtendedStableId(argument.getSourceFile(), argument);
    const argumentNode = this.nodeByStableId(expectedArgumentStableId)
      || this.nodes.find((node) => (
        node.labels.includes('Arg')
        && getStableIdKey(node.stableId).startsWith(`${sourceStableId}:arg${index}`)
      ));
    if (argumentNode) return getStableIdKey(argumentNode.stableId);

    const callExpression = argument.parent && ts.isCallExpression(argument.parent)
      ? argument.parent
      : undefined;
    if (!callExpression) return undefined;
    const callStableId = this.contextualizeHorizontalStableId(
      getExtendedStableId(callExpression.getSourceFile(), callExpression),
      callExpression,
    );
    return this.nodeByStableId(callStableId) ? callStableId : undefined;
  }

  private resolvedTrackedFunctionDeclaration(callExpression: ts.CallExpression) {
    const declaration = this.checker.getResolvedSignature(callExpression)?.declaration;
    if (
      !declaration
      || !isFunctionLikeNode(declaration)
      || !declaration.body
      || !declarationIsTracked(declaration)
    ) {
      return undefined;
    }
    return declaration;
  }

  private functionBodyStatements(declaration: ts.FunctionLikeDeclaration) {
    if (!declaration.body || !ts.isBlock(declaration.body)) return [];
    return [...declaration.body.statements];
  }

  private projectedExecutionStableId(
    callStableId: string,
    sourceNode: ts.Node,
    role: string,
  ) {
    const sourceStableId = getExtendedStableId(sourceNode.getSourceFile(), sourceNode);
    return `${callStableId}:execution:${sanitizeSyntheticExternalPart(role)}:${sanitizeSyntheticExternalPart(sourceStableId)}`;
  }

  private createProjectedExecutionNode(
    callExpression: ts.CallExpression,
    callStableId: string,
    sourceNode: ts.Node,
    role: string,
    diaName: string,
    labels: string[],
    extra: FlowNodeExtra = {},
    stableIdOverride?: string,
  ) {
    const sourceStableId = getExtendedStableId(sourceNode.getSourceFile(), sourceNode);
    const projectedStableId = stableIdOverride
      || this.projectedExecutionStableId(callStableId, sourceNode, role);
    const stableId = this.createNode('Value', role, callExpression, {
      labels: uniqueStrings([
        'ExecutionOccurrence',
        ...labels,
      ]),
      diaName,
      actionTextRaw: sourceNode.getText(sourceNode.getSourceFile()),
      canonicalStableId: sourceStableId,
      semanticExpansion: 'call-execution',
      renderHidden: true,
      synthetic: true,
      renderPartsLayout: 'single',
      renderPrimaryPartIndex: 0,
      renderPartsJson: JSON.stringify([{
        stableId: projectedStableId,
        text: diaName,
        kind: labels.includes('Method') ? 'method' : 'value',
        labels,
        order: 0,
        sourceStableId,
      }]),
      ...extra,
    }, projectedStableId, false);
    const projectedNode = this.nodes.find((candidate) => getStableIdKey(candidate.stableId) === stableId);
    if (projectedNode) {
      projectedNode.labels = projectedNode.labels.filter((labelName) => (
        labelName !== 'Async' && labelName !== 'Awaited' && labelName !== 'FireAndForget'
      ));
      if (extra.invocationMode === 'asynchronous') {
        projectedNode.labels = uniqueStrings([
          ...projectedNode.labels,
          'Async',
          extra.responseMode === 'awaited' ? 'Awaited' : 'FireAndForget',
        ]);
      }
      projectedNode.invocationMode = extra.invocationMode;
      projectedNode.responseMode = extra.responseMode;
      projectedNode.asyncContract = extra.asyncContract;
    }
    return stableId;
  }

  private collectReferencedBindingExpressions(expression: ts.Expression) {
    const direct = unwrapExpression(expression);
    if (
      ts.isIdentifier(direct)
      || isPropertyAccessLikeExpression(direct)
      || ts.isElementAccessExpression(direct)
    ) {
      return [direct];
    }
    const references: ts.Expression[] = [];
    const seenBindings = new Set<string>();
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node)) {
        const bindingStableId = this.bindingStableIdForExpression(node);
        if (bindingStableId && !seenBindings.has(bindingStableId)) {
          seenBindings.add(bindingStableId);
          references.push(node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(direct);
    return references;
  }

  private retargetArgumentBinding(
    argument: ts.Expression,
    index: number,
    bindingStableId: string,
    ownerStableId: string,
  ) {
    const argumentStableId = this.materializedArgumentTargetStableId(argument, index);
    const argumentNode = argumentStableId ? this.nodeByStableId(argumentStableId) : undefined;
    if (argumentNode) {
      argumentNode.bindingStableId = bindingStableId;
      argumentNode.canonicalStableId = bindingStableId;
      argumentNode.labels = uniqueStrings([
        ...argumentNode.labels,
        'ExecutionOccurrence',
        'ArgumentOccurrence',
        'ValueRead',
        'ValuePass',
      ]);
      argumentNode.diaName = argument.getText(this.sourceFile);
    }
    if (argumentStableId && argumentStableId !== ownerStableId) {
      this.addEdge(undefined, ownerStableId, undefined, argumentStableId, 'MATERIALIZES_ARGUMENT', {
        label: argument.getText(this.sourceFile),
        flowLayer: 'control',
        semanticExpansion: 'call-execution',
        sequenceOrder: index,
      });
    }
    return argumentStableId || ownerStableId;
  }

  private materializeFailureCallbackProtocol(
    callExpression: ts.CallExpression,
    callStableId: string,
    targetFnStableId: string | undefined,
  ) {
    const callee = unwrapExpression(callExpression.expression);
    if (!isPropertyAccessLikeExpression(callee) || callee.name.text !== 'catch') return;
    // An updater callback is already extracted as a compact execution chain. Its catch
    // callback is connected directly from the rejected call while the callback body is
    // materialized; a separate failure-binding node would duplicate that source value.
    if (this.isInsideUpdaterCallback(callExpression)) return;
    const receiver = unwrapExpression(callee.expression);
    const receiverCall = ts.isCallExpression(receiver) ? receiver : undefined;
    const receiverCallStableId = receiverCall
      ? this.contextualizeHorizontalStableId(
          getExtendedStableId(this.sourceFile, receiverCall),
          receiverCall,
        )
      : undefined;
    if (receiverCall && receiverCallStableId) {
      this.materializeTrackedCallExecution(receiverCall, receiverCallStableId);
    }
    const receiverTargetStableId = receiverCall
      ? this.resolveRenderableCallTarget(receiverCall)?.stableId
      : undefined;
    const terminalEffect = receiverTargetStableId
      ? [...this.nodes].reverse().find((node) => (
          node.labels.includes('EffectCall')
          && node.sequenceOwnerStableId === receiverTargetStableId
        ))
      : undefined;
    const failureSourceStableId = terminalEffect
      ? getStableIdKey(terminalEffect.stableId)
      : receiverTargetStableId || targetFnStableId || callStableId;
    const failureSourceKind = terminalEffect
      ? undefined
      : (receiverTargetStableId || targetFnStableId ? 'Fn' : undefined);
    const callback = callExpression.arguments
      .map(unwrapExpression)
      .find((argument): argument is ts.ArrowFunction | ts.FunctionExpression => (
        ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)
      ));
    const parameter = callback?.parameters[0];
    if (!callback || !parameter || !ts.isIdentifier(parameter.name)) return;
    const callbackIndex = callExpression.arguments.findIndex((argument) => unwrapExpression(argument) === callback);
    const callbackStableId = this.contextualizeHorizontalStableId(
      this.buildArgumentStableId(callback, callbackIndex),
      callback,
    );
    const bindingStableId = getExtendedStableId(this.sourceFile, parameter);
    const existingFailure = this.nodes.find((node) => (
      node.bindingStableId === bindingStableId && node.labels.includes('Parameter')
    ));
    const failureStableId = existingFailure
      ? getStableIdKey(existingFailure.stableId)
      : this.createNode('Value', 'failure binding', parameter, {
          labels: ['ExecutionOccurrence', 'Failure', 'FailureBinding', 'Parameter'],
          diaName: parameter.name.text,
          actionTextRaw: parameter.getText(this.sourceFile),
          canonicalStableId: bindingStableId,
          bindingStableId,
          semanticExpansion: 'call-execution',
          sequenceOwnerStableId: callbackStableId,
          flowLayer: 'data',
          dataFlowRole: 'input',
          renderHidden: false,
          synthetic: false,
        }, `${callbackStableId}:failure-parameter`);
    if (existingFailure) {
      existingFailure.labels = uniqueStrings([
        ...existingFailure.labels,
        'ExecutionOccurrence',
        'Failure',
        'FailureBinding',
      ]);
      existingFailure.sequenceOwnerStableId = callbackStableId;
      existingFailure.renderHidden = false;
    }
    this.addEdge(
      failureSourceKind,
      failureSourceStableId,
      undefined,
      failureStableId,
      'CATCH',
      {
        label: 'catch',
        flowLayer: 'control',
        semanticExpansion: 'call-execution',
      },
    );
  }

  private resolvePersistentStoreIdentity(callExpression: ts.CallExpression) {
    const rootDeclaration = this.resolvedTrackedFunctionDeclaration(callExpression);
    if (!rootDeclaration) return undefined;
    const rootDeclarationStableId = getExtendedStableId(rootDeclaration.getSourceFile(), rootDeclaration);
    const cached = this.persistentStoreIdentityByDeclarationStableId.get(rootDeclarationStableId);
    if (cached !== undefined) return cached || undefined;

    const candidateScores = new Map<string, number>();
    const sourceFiles = new Set<ts.SourceFile>();
    const seenDeclarations = new Set<string>();
    const scoreCandidate = (name: string, score: number) => {
      if (!/(?:file|path|store|storage|database|db|cache)$/iu.test(name)) return;
      candidateScores.set(name, (candidateScores.get(name) || 0) + score);
    };
    const visitDeclaration = (declaration: ts.FunctionLikeDeclaration, depth: number) => {
      if (depth > 5) return;
      const declarationStableId = getExtendedStableId(declaration.getSourceFile(), declaration);
      if (seenDeclarations.has(declarationStableId)) return;
      seenDeclarations.add(declarationStableId);
      sourceFiles.add(declaration.getSourceFile());
      const visit = (node: ts.Node) => {
        if (ts.isPropertyAccessExpression(node)) {
          const receiver = unwrapExpression(node.expression);
          if (receiver.kind === ts.SyntaxKind.ThisKeyword) scoreCandidate(node.name.text, 8 - depth);
        } else if (ts.isIdentifier(node)) {
          scoreCandidate(node.text, 2);
        }
        if (ts.isCallExpression(node)) {
          const nestedDeclaration = this.resolvedTrackedFunctionDeclaration(node);
          if (nestedDeclaration) visitDeclaration(nestedDeclaration, depth + 1);
        }
        ts.forEachChild(node, visit);
      };
      if (declaration.body) visit(declaration.body);
    };
    visitDeclaration(rootDeclaration, 0);

    const candidate = [...candidateScores.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
    if (!candidate) {
      this.persistentStoreIdentityByDeclarationStableId.set(rootDeclarationStableId, null);
      return undefined;
    }

    const extensionScores = new Map<string, number>();
    const candidateStem = candidate
      .replace(/(?:file|path|store|storage|database|db|cache)$/iu, '')
      .toLowerCase();
    const persistentExtensions = new Set([
      'JSONL', 'JSON', 'CSV', 'TSV', 'LOG', 'TXT', 'DB', 'SQLITE', 'SQLITE3', 'PARQUET', 'DUCKDB',
    ]);
    for (const sourceFile of sourceFiles) {
      const visit = (node: ts.Node) => {
        if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          for (const match of node.text.matchAll(/\.([a-z0-9]{2,8})\b/giu)) {
            const extension = match[1].toUpperCase();
            if (!persistentExtensions.has(extension)) continue;
            const lexicalWeight = candidateStem && node.getText(node.getSourceFile()).toLowerCase().includes(candidateStem)
              ? 20
              : 1;
            extensionScores.set(extension, (extensionScores.get(extension) || 0) + lexicalWeight);
          }
        } else if (ts.isTemplateExpression(node)) {
          const text = node.getText(node.getSourceFile());
          for (const match of text.matchAll(/\.([a-z0-9]{2,8})\b/giu)) {
            const extension = match[1].toUpperCase();
            if (!persistentExtensions.has(extension)) continue;
            const lexicalWeight = candidateStem && text.toLowerCase().includes(candidateStem) ? 20 : 1;
            extensionScores.set(extension, (extensionScores.get(extension) || 0) + lexicalWeight);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    const extension = [...extensionScores.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
    const baseName = candidate
      .replace(/(?:file|path|store|storage|database|db|cache)$/iu, '')
      .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
      .trim();
    const displayBase = baseName
      ? `${baseName[0].toUpperCase()}${baseName.slice(1)}`
      : candidate;
    const sourceFile = rootDeclaration.getSourceFile();
    const identity = {
      stableId: `store:${getRepoRelativePath(sourceFile.fileName)}:${candidate}`,
      diaName: extension ? `${displayBase} ${extension}` : `${displayBase} store`,
      sourceStableId: getExtendedStableId(sourceFile, rootDeclaration),
      storageName: candidate,
      storageFormat: extension,
    };
    this.persistentStoreIdentityByDeclarationStableId.set(rootDeclarationStableId, identity);
    return identity;
  }

  private materializeTrackedCallExecution(
    callExpression: ts.CallExpression,
    callStableId: string,
    returnTargetStableId?: string,
  ) {
    if (this.seenCallExecutionExpansionStableIds.has(callStableId)) return;
    const axisFlowOnly = this.isInsideUpdaterCallback(callExpression);
    const declaration = this.resolvedTrackedFunctionDeclaration(callExpression);
    const callbackArguments = callExpression.arguments
      .map((argument, index) => ({ argument: unwrapExpression(argument), index }))
      .filter((entry): entry is { argument: ts.ArrowFunction | ts.FunctionExpression; index: number } => (
        ts.isArrowFunction(entry.argument) || ts.isFunctionExpression(entry.argument)
      ));
    const statements = declaration ? this.functionBodyStatements(declaration) : [];
    const shouldExpand = Boolean(
      declaration
      && (
        callbackArguments.length
        || (this.isInsideUpdaterCallback(callExpression) && statements.length <= 6)
      ),
    );
    if (!shouldExpand || !declaration) {
      const target = this.resolveRenderableCallTarget(callExpression);
      this.materializeFailureCallbackProtocol(callExpression, callStableId, target?.stableId);
      return;
    }
    this.seenCallExecutionExpansionStableIds.add(callStableId);
    const target = this.resolveRenderableCallTarget(callExpression);
    const targetFnStableId = target?.stableId;
    if (!targetFnStableId) return;
    const occurrenceExecutionOwner = targetFnStableId === callStableId
      || targetFnStableId.startsWith(`${callStableId}:horizontal-owner-`);
    const inlineExecutionOwner = occurrenceExecutionOwner || ((
      ts.isArrowFunction(declaration)
      || ts.isFunctionExpression(declaration)
    ) && ts.isCallExpression(declaration.parent));
    const executionOwnerStableId = inlineExecutionOwner ? callStableId : targetFnStableId;
    const executionOwnerKind = inlineExecutionOwner ? undefined : 'Fn' as const;

    const localBindingProxyBySourceStableId = new Map<string, string>();
    const callbackFormalSymbols = new Set(
      callbackArguments
        .map((entry) => declaration.parameters[entry.index])
        .filter((parameter): parameter is ts.ParameterDeclaration => Boolean(parameter))
        .map((parameter) => ts.isIdentifier(parameter.name)
          ? this.checker.getSymbolAtLocation(parameter.name)
          : undefined)
        .filter((symbol): symbol is ts.Symbol => Boolean(symbol)),
    );
    const inlineTransportBindingStableIds = new Set<string>();
    const isCallbackOnlyTransport = (declarationNode: ts.VariableDeclaration) => {
      if (!ts.isIdentifier(declarationNode.name)) return false;
      const symbol = this.checker.getSymbolAtLocation(declarationNode.name);
      if (!symbol || callbackFormalSymbols.size === 0) return false;
      const references: ts.Identifier[] = [];
      const visit = (node: ts.Node) => {
        if (
          ts.isIdentifier(node)
          && node !== declarationNode.name
          && this.checker.getSymbolAtLocation(node) === symbol
        ) {
          references.push(node);
        }
        ts.forEachChild(node, visit);
      };
      if (declaration.body) visit(declaration.body);
      return references.length > 0 && references.every((reference) => {
        const parent = reference.parent;
        if (!ts.isCallExpression(parent) || !parent.arguments.includes(reference)) return false;
        const callee = unwrapExpression(parent.expression);
        return ts.isIdentifier(callee)
          && callbackFormalSymbols.has(this.checker.getSymbolAtLocation(callee)!);
      });
    };
    const knownBindingStableIds = new Set<string>(
      declaration.parameters
        .filter((parameter) => ts.isIdentifier(parameter.name))
        .map((parameter) => getExtendedStableId(parameter.getSourceFile(), parameter)),
    );
    for (const statement of statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declarationNode of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declarationNode.name)) continue;
        const sourceStableId = getExtendedStableId(declarationNode.getSourceFile(), declarationNode);
        if (isCallbackOnlyTransport(declarationNode)) {
          inlineTransportBindingStableIds.add(sourceStableId);
          knownBindingStableIds.add(sourceStableId);
          continue;
        }
        const projectedStableId = this.createProjectedExecutionNode(
          callExpression,
          callStableId,
          declarationNode,
          'binding',
          declarationNode.name.text,
          ['Value', 'ValueSlot', 'LocalBinding'],
          {
            bindingStableId: sourceStableId,
            sequenceOwnerStableId: executionOwnerStableId,
            flowLayer: 'data',
            dataFlowRole: 'result',
          },
        );
        localBindingProxyBySourceStableId.set(sourceStableId, projectedStableId);
        knownBindingStableIds.add(sourceStableId);
        if (!axisFlowOnly) {
          this.addEdge(executionOwnerKind, executionOwnerStableId, undefined, projectedStableId, 'EVAL', {
            label: declarationNode.name.text,
            flowLayer: 'control',
            semanticExpansion: 'call-execution',
          });
        }

        const initializer = declarationNode.initializer && unwrapExpression(declarationNode.initializer);
        if (initializer && ts.isObjectLiteralExpression(initializer)) {
          initializer.properties.forEach((property, index) => {
            const propertyName = ts.isSpreadAssignment(property)
              ? property.expression.getText(property.getSourceFile())
              : getPropertyNameText(property.name) || `field ${index + 1}`;
            const propertyValue = ts.isSpreadAssignment(property)
              ? property.expression
              : ts.isPropertyAssignment(property)
                ? property.initializer
                : undefined;
            const fieldStableId = this.createProjectedExecutionNode(
              callExpression,
              callStableId,
              property,
              `field-${index}`,
              propertyValue?.getText(property.getSourceFile()) || propertyName,
              ['Field', ...(propertyValue ? ['ValueRead'] : [])],
              {
                bindingStableId: propertyValue
                  ? this.bindingStableIdForExpression(propertyValue)
                  : undefined,
                sequenceOwnerStableId: projectedStableId,
                flowLayer: 'data',
                dataFlowRole: 'input',
              },
            );
            this.addEdge(undefined, projectedStableId, undefined, fieldStableId, 'FIELD', {
              label: ts.isSpreadAssignment(property) ? '...' : propertyName,
              flowLayer: 'data',
              semanticExpansion: 'call-execution',
              sequenceOrder: index,
            });
          });
        }
      }
    }

    for (const statement of statements) {
      if (!ts.isReturnStatement(statement) || !statement.expression) continue;
      const expression = unwrapExpression(statement.expression);
      const bindingStableId = this.bindingStableIdForExpression(expression);
      const existingBindingStableId = bindingStableId
        ? localBindingProxyBySourceStableId.get(bindingStableId)
        : undefined;
      const returnedStableId = existingBindingStableId || this.createProjectedExecutionNode(
          callExpression,
          callStableId,
          statement.expression,
          'return',
          statement.expression.getText(statement.getSourceFile()),
          ['Value', 'ValueRead', 'ValuePass', 'Return', 'ReturnOccurrence'],
          {
            bindingStableId,
            sequenceOwnerStableId: executionOwnerStableId,
            flowLayer: 'data',
            dataFlowRole: 'result',
          },
        );
      const returnedNode = this.nodeByStableId(returnedStableId);
      if (returnedNode) {
        returnedNode.labels = uniqueStrings([
          ...returnedNode.labels,
          'ValuePass',
          'Return',
        ]);
      }
      if (!axisFlowOnly) {
        this.addEdge(executionOwnerKind, executionOwnerStableId, undefined, returnedStableId, 'MATERIALIZES_RETURN', {
          label: 'return',
          flowLayer: 'control',
          semanticExpansion: 'call-execution',
        });
      }
      if (returnTargetStableId && !axisFlowOnly) {
        this.addEdge(undefined, returnedStableId, undefined, returnTargetStableId, 'RETURNS_VALUE', {
          label: 'return',
          flowLayer: 'data',
          semanticExpansion: 'call-execution',
        });
      }
    }

    const formalParameters = declaration.parameters;
    for (const callbackEntry of callbackArguments) {
      if (axisFlowOnly) continue;
      const formal = formalParameters[callbackEntry.index];
      if (!formal || !ts.isIdentifier(formal.name)) continue;
      const formalSymbol = this.checker.getSymbolAtLocation(formal.name);
      const materializedCallbackStableId = this.materializedArgumentTargetStableId(
        callbackEntry.argument,
        callbackEntry.index,
      );
      const callbackStableId = materializedCallbackStableId && this.nodeByStableId(materializedCallbackStableId)
        ? materializedCallbackStableId
        : undefined;
      const callbackParameter = callbackEntry.argument.parameters[0];
      for (const nestedCall of collectCallExpressions(declaration.body!)) {
        const callee = unwrapExpression(nestedCall.expression);
        if (!ts.isIdentifier(callee)) continue;
        if (this.checker.getSymbolAtLocation(callee) !== formalSymbol) continue;
        const suppliedValue = nestedCall.arguments[0];
        if (!suppliedValue) continue;
        const suppliedBindingStableId = this.bindingStableIdForExpression(suppliedValue)
          || getExtendedStableId(suppliedValue.getSourceFile(), suppliedValue);
        if (callbackParameter && ts.isIdentifier(callbackParameter.name)) {
          const callbackParameterBinding = getExtendedStableId(this.sourceFile, callbackParameter);
          const callbackParameterSymbol = this.checker.getSymbolAtLocation(callbackParameter.name);
          for (const callbackCall of collectCallExpressions(callbackEntry.argument.body)) {
            callbackCall.arguments.forEach((argument, index) => {
              const referencesParameter = this.collectReferencedBindingExpressions(argument)
                .some((reference) => {
                  let referenced = unwrapExpression(reference);
                  while (
                    isPropertyAccessLikeExpression(referenced)
                    || ts.isElementAccessExpression(referenced)
                  ) {
                    referenced = unwrapExpression(referenced.expression);
                  }
                  return this.bindingStableIdForExpression(reference) === callbackParameterBinding
                    || (
                      callbackParameterSymbol
                      && this.checker.getSymbolAtLocation(referenced) === callbackParameterSymbol
                    );
                });
              if (!referencesParameter) return;
              this.retargetArgumentBinding(
                argument,
                index,
                suppliedBindingStableId,
                executionOwnerStableId,
              );
            });
          }
        }
        if (inlineTransportBindingStableIds.has(suppliedBindingStableId)) continue;
        const transferStableId = localBindingProxyBySourceStableId.get(suppliedBindingStableId)
          || this.createProjectedExecutionNode(
            callExpression,
            callStableId,
            suppliedValue,
            `callback-argument-${callbackEntry.index}`,
            suppliedValue.getText(suppliedValue.getSourceFile()),
            ['Arg', 'ArgumentOccurrence', 'ValueRead', 'ValuePass'],
            {
              bindingStableId: suppliedBindingStableId,
              sequenceOwnerStableId: executionOwnerStableId,
              flowLayer: 'data',
              dataFlowRole: 'input',
            },
          );
        const transferNode = this.nodeByStableId(transferStableId);
        if (transferNode) {
          transferNode.labels = uniqueStrings([...transferNode.labels, 'Arg', 'ValuePass']);
        }
        this.addEdge(executionOwnerKind, executionOwnerStableId, undefined, transferStableId, 'MATERIALIZES_ARGUMENT', {
          label: suppliedValue.getText(suppliedValue.getSourceFile()),
          flowLayer: 'control',
          semanticExpansion: 'call-execution',
        });
        if (callbackStableId) {
          this.addEdge(undefined, transferStableId, undefined, callbackStableId, 'ARG', {
            label: suppliedValue.getText(suppliedValue.getSourceFile()),
            flowLayer: 'data',
            semanticExpansion: 'call-execution',
          });
        }
      }
    }

    for (const statement of statements) {
      const calls = collectCallExpressions(statement);
      for (const nestedCall of calls) {
        if (nestedCall === callExpression) continue;
        const consumesLocalBinding = nestedCall.arguments.some((argument) => {
          const bindingStableId = this.bindingStableIdForExpression(argument);
          return Boolean(bindingStableId && knownBindingStableIds.has(bindingStableId));
        });
        if (!consumesLocalBinding) continue;
        const nestedTarget = this.resolveCallTarget(nestedCall);
        const accessorRole = nestedTarget?.stableId
          ? this.accessorIndex.roleByFunctionStableId.get(nestedTarget.stableId)
          : undefined;
        let resultOwner: ts.Node = nestedCall;
        while (
          ts.isAwaitExpression(resultOwner.parent)
          || ts.isParenthesizedExpression(resultOwner.parent)
          || ts.isAsExpression(resultOwner.parent)
          || ts.isTypeAssertionExpression(resultOwner.parent)
          || ts.isNonNullExpression(resultOwner.parent)
        ) {
          resultOwner = resultOwner.parent;
        }
        const isTerminalEffect = ts.isExpressionStatement(resultOwner.parent);
        const nestedName = getCallLikeName(nestedCall.expression) || 'call';
        const calleeExpression = unwrapExpression(nestedCall.expression);
        const isContainerMethod = (
          isPropertyAccessLikeExpression(calleeExpression)
          || ts.isElementAccessExpression(calleeExpression)
        );
        const isStatefulOperation = Boolean(accessorRole)
          || (isTerminalEffect && isContainerMethod);
        const virtualOperationName = accessorRole === 'Setter'
          || (isTerminalEffect && isContainerMethod)
          ? 'write'
          : accessorRole === 'Getter'
            ? 'read'
            : nestedName.split('.').pop() || nestedName;
        const nestedInvocationContract = this.callInvocationContract(nestedCall);
        const nestedAsyncLabels = nestedInvocationContract.invocationMode === 'asynchronous'
          ? [
              'Async',
              nestedInvocationContract.responseMode === 'awaited' ? 'Awaited' : 'FireAndForget',
            ]
          : [];
        const receiver = isPropertyAccessLikeExpression(calleeExpression)
          ? unwrapExpression(calleeExpression.expression)
          : undefined;
        const storeIdentity = isStatefulOperation
          ? this.resolvePersistentStoreIdentity(nestedCall)
          : undefined;
        const projectedOperationStableId = this.projectedExecutionStableId(
          callStableId,
          nestedCall,
          'effect-call',
        );
        const storeStableId = isStatefulOperation
          ? projectedOperationStableId
          : undefined;
        const storeDiaName = isStatefulOperation
          ? storeIdentity?.diaName
            || receiver?.getText(receiver.getSourceFile())
            || 'storage'
          : undefined;
        const sourceCallStableId = getExtendedStableId(nestedCall.getSourceFile(), nestedCall);
        const nestedStableId = this.createProjectedExecutionNode(
          callExpression,
          callStableId,
          nestedCall,
          'effect-call',
          storeDiaName || virtualOperationName,
          [
            'Call',
            'Method',
            'EffectCall',
            'Primitive',
            ...(isContainerMethod ? ['ContainerMethod'] : []),
            ...(isStatefulOperation ? ['StatefulOperation'] : []),
            ...(isStatefulOperation ? ['Store', 'Storage', 'ResourceProxy', 'External'] : []),
            ...(nestedTarget ? ['Request'] : ['Op']),
            ...(accessorRole === 'Setter' || (isTerminalEffect && isContainerMethod) ? ['Write'] : []),
            ...(accessorRole === 'Getter' ? ['Read'] : []),
            ...nestedAsyncLabels,
          ],
          {
            calleeStableId: nestedTarget?.stableId,
            implementationCallStableId: getExtendedStableId(nestedCall.getSourceFile(), nestedCall),
            implementationCalleeName: nestedName,
            containerMethodKind: virtualOperationName,
            sequenceOwnerStableId: executionOwnerStableId,
            flowLayer: 'mixed',
            dataFlowRole: 'operation',
            ...nestedInvocationContract,
            asyncContract: nestedInvocationContract.invocationMode === 'asynchronous'
              ? (nestedInvocationContract.responseMode === 'awaited' ? 'awaited' : 'fire-and-forget')
              : undefined,
            annotationKind: nestedInvocationContract.invocationMode === 'asynchronous'
              ? 'AsyncFlow'
              : undefined,
            ...(isStatefulOperation ? {
              canonicalStableId: storeIdentity?.stableId,
              storageName: storeIdentity?.storageName,
              storageFormat: storeIdentity?.storageFormat,
              renderHidden: false,
              renderPartsLayout: 'container-overlay-side' as const,
              renderPrimaryPartIndex: 0,
              renderPartsJson: JSON.stringify([
                {
                  stableId: storeStableId,
                  text: storeDiaName,
                  kind: 'storage-container',
                  labels: ['Store', 'Storage', 'ResourceProxy', 'External'],
                  order: 0,
                  sourceStableId: storeIdentity?.sourceStableId
                    || (receiver ? getExtendedStableId(receiver.getSourceFile(), receiver) : sourceCallStableId),
                },
                {
                  stableId: storeStableId,
                  text: `${virtualOperationName}(`,
                  kind: 'method',
                  labels: ['Method', 'Write', 'StatefulOperation'],
                  order: 1,
                  sourceStableId: sourceCallStableId,
                },
              ] satisfies RenderPartDescriptor[]),
              flowLayer: 'mixed' as const,
              dataFlowRole: 'storage',
            } : {}),
          },
          storeStableId,
        );
        const inlineStatefulArgument = isStatefulOperation
          && nestedCall.arguments.length === 1
          && !isFunctionArgumentExpression(nestedCall.arguments[0])
          && !(
            ts.isObjectLiteralExpression(unwrapExpression(nestedCall.arguments[0]))
            && (unwrapExpression(nestedCall.arguments[0]) as ts.ObjectLiteralExpression).properties.length > 1
          );
        if (inlineStatefulArgument) {
          const argument = nestedCall.arguments[0];
          const nestedNode = this.nodeByStableId(nestedStableId);
          if (nestedNode) {
            nestedNode.diaName = storeDiaName || `${virtualOperationName}(`;
            nestedNode.renderPartsLayout = isStatefulOperation ? 'container-overlay-side' : 'horizontal';
            nestedNode.renderPrimaryPartIndex = 0;
            nestedNode.renderPartsJson = JSON.stringify([
              ...(isStatefulOperation ? [{
                stableId: nestedStableId,
                text: storeDiaName,
                kind: 'storage-container',
                labels: ['Store', 'Storage', 'ResourceProxy', 'External'],
                order: 0,
                sourceStableId: storeIdentity?.sourceStableId
                  || (receiver ? getExtendedStableId(receiver.getSourceFile(), receiver) : sourceCallStableId),
              }] satisfies RenderPartDescriptor[] : []),
              {
                stableId: nestedStableId,
                text: `${virtualOperationName}(`,
                kind: 'method',
                labels: ['Method', ...(isStatefulOperation ? ['Write'] : [])],
                order: isStatefulOperation ? 1 : 0,
                sourceStableId: sourceCallStableId,
              },
              {
                stableId: nestedStableId,
                text: argument.getText(argument.getSourceFile()),
                kind: 'value',
                labels: ['Value', 'Arg'],
                order: isStatefulOperation ? 2 : 1,
                sourceStableId: getExtendedStableId(argument.getSourceFile(), argument),
              },
              {
                stableId: nestedStableId,
                text: ')',
                kind: 'punctuation',
                labels: ['Arg'],
                order: isStatefulOperation ? 3 : 2,
                sourceStableId: sourceCallStableId,
              },
            ] satisfies RenderPartDescriptor[]);
          }
        }
        for (const [index, argument] of nestedCall.arguments.entries()) {
          if (inlineStatefulArgument) continue;
          const bindingStableId = this.bindingStableIdForExpression(argument);
          if (!bindingStableId) continue;
          const argumentStableId = this.createProjectedExecutionNode(
            callExpression,
            callStableId,
            argument,
            `effect-argument-${index}`,
            argument.getText(argument.getSourceFile()),
            ['Arg', 'ArgumentOccurrence', 'ValueRead', 'ValuePass'],
            {
              bindingStableId,
              sequenceOwnerStableId: executionOwnerStableId,
              flowLayer: 'data',
              dataFlowRole: 'input',
            },
          );
          if (!axisFlowOnly) {
            this.addEdge(executionOwnerKind, executionOwnerStableId, undefined, argumentStableId, 'MATERIALIZES_ARGUMENT', {
              label: argument.getText(argument.getSourceFile()),
              flowLayer: 'control',
              semanticExpansion: 'call-execution',
            });
            this.addEdge(undefined, argumentStableId, undefined, nestedStableId, 'PASSES_VALUE', {
              label: argument.getText(argument.getSourceFile()),
              flowLayer: 'data',
              semanticExpansion: 'call-execution',
              sequenceOrder: index,
            });
          }
        }
      }
    }

    this.materializeFailureCallbackProtocol(
      callExpression,
      callStableId,
      inlineExecutionOwner ? undefined : targetFnStableId,
    );
  }

  private materializeUpdaterStateProtocol(
    callExpression: ts.CallExpression,
    callback: ts.ArrowFunction | ts.FunctionExpression,
    callbackStableId: string,
  ) {
    // The caller already classified this callback structurally as an updater.
    // Do not require the callee to match a React-specific setter identity here.
    if (!callback.body || !ts.isExpression(callback.body)) {
      return;
    }
    const body = unwrapExpression(callback.body);
    if (ts.isArrayLiteralExpression(body)) {
      this.materializeArrayUpdaterStateProtocol(
        callExpression,
        body,
        callbackStableId,
      );
      return;
    }
    if (!ts.isObjectLiteralExpression(body)) return;
    const callStableId = this.contextualizeHorizontalStableId(
      getExtendedStableId(this.sourceFile, callExpression),
      callExpression,
    );
    const writeStableId = callStableId;
    const callNode = this.nodeByStableId(callStableId);
    if (callNode) {
      callNode.labels = uniqueStrings([...callNode.labels, 'StateUpdateRoot']);
      callNode.semanticExpansion = 'state-update';
      callNode.opensObjectFieldFamily = body.properties.length > 1;
      const callName = getCallLikeName(callExpression.expression) || callNode.diaName || 'update';
      callNode.diaName = `${callName}(`;
      callNode.callBoundaryDesign = 'split';
      callNode.callBoundaryRole = 'open';
      callNode.callHasArguments = true;
      callNode.compactCallMosaic = true;
      callNode.renderPartsLayout = 'single';
      callNode.renderPrimaryPartIndex = 0;
      callNode.renderPartsJson = JSON.stringify([{
        stableId: callStableId,
        text: `${callName}(`,
        kind: 'method',
        labels: ['Call', 'Method', 'StateUpdate'],
        order: 0,
        sourceStableId: getExtendedStableId(this.sourceFile, callExpression),
      }] satisfies RenderPartDescriptor[]);
    }

    const expandedFieldFamily = body.properties.length > 1;
    const bracePairCount = expandedFieldFamily ? Math.floor(body.properties.length / 2) : 0;
    const objectFamilyStableId = `${callbackStableId}:next-state:object-family`;
    const leftBraceStableIds: string[] = [];
    const rightBraceStableIds: string[] = [];
    if (expandedFieldFamily) {
      for (let pairIndex = 0; pairIndex < bracePairCount; pairIndex += 1) {
        const pairedFieldIndices = [pairIndex, body.properties.length - 1 - pairIndex];
        if (body.properties.length % 2 === 1 && pairIndex === bracePairCount - 1) {
          pairedFieldIndices.splice(1, 0, Math.floor(body.properties.length / 2));
        }
        const common = {
          labels: ['ObjectBrace', 'Object', 'StateUpdate', 'SemanticExpansion'],
          diaName: '',
          actionTextRaw: body.getText(this.sourceFile),
          objectFamilyStableId,
          objectBracePairIndex: pairIndex,
          objectBracePairCount: bracePairCount,
          objectBraceFieldIndicesJson: JSON.stringify(pairedFieldIndices),
          semanticExpansion: 'state-update',
          sequenceOwnerStableId: writeStableId,
          synthetic: true,
        };
        leftBraceStableIds.push(this.createNode('ObjectBrace', 'object field brace', body, {
          ...common,
          labels: [...common.labels, 'Open'],
          objectBraceSide: 'left',
          objectBraceMosaicNeighborStableId: pairIndex === 0 ? writeStableId : undefined,
        }, `${objectFamilyStableId}:left:${pairIndex}`));
        rightBraceStableIds.push(this.createNode('ObjectBrace', 'object field brace', body, {
          ...common,
          labels: [...common.labels, 'Close'],
          objectBraceSide: 'right',
        }, `${objectFamilyStableId}:right:${pairIndex}`));
      }
    }

    const fieldStableIds: string[] = [];
    body.properties.forEach((property, index) => {
      const propertyName = ts.isSpreadAssignment(property)
        ? undefined
        : getPropertyNameText(property.name) || `field ${index + 1}`;
      const semanticPropertyName = this.getObjectFieldSemanticName(property);
      const propertyValue = ts.isSpreadAssignment(property)
        ? property.expression
        : ts.isPropertyAssignment(property)
          ? property.initializer
          : undefined;
      const displayPropertyName = this.getObjectFieldDisplayName(property, propertyValue || property);
      const directValueCall = propertyValue && ts.isCallExpression(unwrapExpression(propertyValue));
      const fieldDiaName = propertyName && directValueCall
        ? propertyName
        : propertyValue?.getText(this.sourceFile) || propertyName || 'spread';
      const fieldStableId = this.createNode('Field', propertyName || 'spread', property, {
        labels: [
          'Field',
          'ExecutionOccurrence',
          ...(propertyValue ? ['ValueRead'] : []),
          ...(ts.isSpreadAssignment(property) ? ['Spread', 'Op'] : []),
          ...(directValueCall ? ['Value', 'ValueSlot', 'ValueCreate', 'LocalBinding', 'Virtual'] : []),
        ],
        diaName: fieldDiaName,
        actionTextRaw: property.getText(this.sourceFile),
        fieldName: semanticPropertyName,
        fieldIndex: index,
        bindingStableId: propertyValue
          ? this.bindingStableIdForExpression(propertyValue)
          : undefined,
        semanticExpansion: 'state-update',
        sequenceOwnerStableId: writeStableId,
        flowLayer: 'data',
        dataFlowRole: 'input',
        renderHidden: false,
        synthetic: true,
        ...(directValueCall ? {
          containerState: 'awaiting-assignment' as const,
          containerMethodKind: 'set',
          renderPartsLayout: 'container-overlay' as const,
          renderPrimaryPartIndex: 0,
          renderPartsJson: JSON.stringify([
            {
              stableId: `${callbackStableId}:next-state:field:${index}`,
              text: fieldDiaName,
              kind: 'value-container',
              labels: ['Value', 'ValueSlot', 'Virtual'],
              order: 0,
              fillState: 'empty',
              sourceStableId: getExtendedStableId(this.sourceFile, property),
            },
            {
              stableId: `${callbackStableId}:next-state:field:${index}`,
              text: 'set',
              kind: 'method',
              labels: ['Method', 'Assignment', 'ContainerMethod', 'Set', 'Virtual'],
              order: 1,
              sourceStableId: getExtendedStableId(this.sourceFile, property),
            },
          ] satisfies RenderPartDescriptor[]),
        } : {}),
        ...(ts.isSpreadAssignment(property) ? {
          renderPartsLayout: 'horizontal' as const,
          renderPrimaryPartIndex: 1,
          renderPartsJson: JSON.stringify([
            {
              stableId: `${callbackStableId}:next-state:field:${index}`,
              text: '...',
              kind: 'operator',
              labels: ['Op', 'Spread'],
              order: 0,
              sourceStableId: getExtendedStableId(this.sourceFile, property),
            },
            {
              stableId: `${callbackStableId}:next-state:field:${index}`,
              text: property.expression.getText(this.sourceFile),
              kind: 'value',
              labels: ['Value', 'ValueRead'],
              order: 1,
              sourceStableId: getExtendedStableId(this.sourceFile, property.expression),
            },
          ] satisfies RenderPartDescriptor[]),
        } : {}),
      }, `${callbackStableId}:next-state:field:${index}`);
      fieldStableIds.push(fieldStableId);
      const pairIndex = expandedFieldFamily
        ? Math.min(index, body.properties.length - 1 - index, Math.max(0, bracePairCount - 1))
        : -1;
      const fieldOpeningStableId = expandedFieldFamily ? leftBraceStableIds[pairIndex] : writeStableId;
      this.addEdge(undefined, fieldOpeningStableId, undefined, fieldStableId, 'FIELD', {
        label: propertyName || '',
        displayLabel: displayPropertyName || '',
        fieldName: semanticPropertyName,
        fieldIndex: index,
        flowLayer: 'data',
        semanticExpansion: 'state-update',
        sequenceOrder: index,
      });
    });
    const completeStableIdValue = `${callbackStableId}:next-state:complete`;
    const completeStableId = this.createNode('FnVisualProxy', 'state write complete', body, {
      labels: [
        'Field',
        'Join',
        'ExecutionOccurrence',
        'Op',
        'VisualProxy',
        'StateUpdate',
        'SemanticExpansion',
      ],
      diaName: expandedFieldFamily ? ')' : '})',
      semanticExpansion: 'state-update',
      sequenceOwnerStableId: writeStableId,
      flowLayer: 'data',
      dataFlowRole: 'result',
      renderHidden: false,
      synthetic: true,
      callMosaicOwnerStableId: writeStableId,
      callMosaicRole: 'close',
      renderPartsLayout: 'horizontal',
      renderPrimaryPartIndex: 0,
      renderPartsJson: JSON.stringify([
        ...(!expandedFieldFamily ? [{
          stableId: completeStableIdValue,
          text: '}',
          kind: 'punctuation',
          labels: ['Field', 'Join'],
          order: 0,
          sourceStableId: getExtendedStableId(this.sourceFile, body),
        }] satisfies RenderPartDescriptor[] : []),
        {
          stableId: completeStableIdValue,
          text: ')',
          kind: 'method',
          labels: ['Op', 'Method', 'Call', 'VisualProxy'],
          order: expandedFieldFamily ? 0 : 1,
          sourceStableId: getExtendedStableId(this.sourceFile, callExpression),
        },
      ] satisfies RenderPartDescriptor[]),
    }, completeStableIdValue);
    fieldStableIds.forEach((fieldStableId, index) => {
      const fieldNode = this.nodes.find((node) => getStableIdKey(node.stableId) === fieldStableId);
      const pairIndex = expandedFieldFamily
        ? Math.min(index, body.properties.length - 1 - index, Math.max(0, bracePairCount - 1))
        : -1;
      const fieldClosingStableId = expandedFieldFamily ? rightBraceStableIds[pairIndex] : completeStableId;
      this.addEdge(undefined, fieldStableId, undefined, fieldClosingStableId, 'FieldJoin', {
        label: '',
        fieldName: fieldNode?.fieldName,
        fieldIndex: index,
        flowLayer: 'data',
        semanticExpansion: 'state-update',
        sequenceOrder: index,
      });
    });
    if (expandedFieldFamily) {
      const closingBrace = this.nodeByStableId(rightBraceStableIds[0]);
      if (closingBrace) closingBrace.objectBraceMosaicNeighborStableId = completeStableId;
      this.addEdge(undefined, rightBraceStableIds[0], undefined, completeStableId, 'ArgJoin', {
        label: '',
        flowLayer: 'data',
        semanticExpansion: 'state-update',
      });
    }

  }

  private materializeArrayUpdaterStateProtocol(
    callExpression: ts.CallExpression,
    body: ts.ArrayLiteralExpression,
    callbackStableId: string,
  ) {
    const callStableId = this.contextualizeHorizontalStableId(
      getExtendedStableId(this.sourceFile, callExpression),
      callExpression,
    );
    const callNode = this.nodeByStableId(callStableId);
    const callName = getCallLikeName(callExpression.expression) || callNode?.diaName || 'update';
    if (callNode) {
      callNode.labels = uniqueStrings([
        ...callNode.labels,
        'StateUpdateRoot',
        'InlineArgumentFamily',
      ]);
      callNode.semanticExpansion = 'state-update';
      callNode.diaName = `${callName}(`;
      callNode.callBoundaryDesign = 'split';
      callNode.callBoundaryRole = 'open';
      callNode.callHasArguments = true;
      callNode.compactCallMosaic = true;
      callNode.renderPartsLayout = 'single';
      callNode.renderPrimaryPartIndex = 0;
      callNode.renderPartsJson = JSON.stringify([{
        stableId: callStableId,
        text: `${callName}(`,
        kind: 'method',
        labels: ['Call', 'Method', 'StateUpdate'],
        order: 0,
        sourceStableId: getExtendedStableId(this.sourceFile, callExpression),
      }] satisfies RenderPartDescriptor[]);
    }

    const collectionStableId = `${callbackStableId}:next-state:collection`;
    this.createNode('Value', 'updated collection', body, {
      labels: [
        'Value',
        'Collection',
        'Virtual',
        'ResultTarget',
        'ValueSlot',
        'ValueCreate',
        'Assignment',
        'ContainerMethod',
        'Set',
        'StateValue',
        'StateUpdate',
        'SemanticExpansion',
      ],
      diaName: 'result',
      actionTextRaw: body.getText(this.sourceFile),
      semanticExpansion: 'state-update',
      sequenceOwnerStableId: callStableId,
      flowLayer: 'mixed',
      dataFlowRole: 'result',
      containerState: 'awaiting-assignment',
      containerMethodKind: 'set',
      synthetic: true,
      renderPartsLayout: 'container-overlay',
      renderPrimaryPartIndex: 0,
      renderPartsJson: JSON.stringify([
        {
          stableId: collectionStableId,
          text: 'result',
          kind: 'collection-container',
          labels: ['Collection', 'Virtual', 'ResultTarget', 'ValueSlot'],
          order: 0,
          fillState: 'empty',
          sourceStableId: getExtendedStableId(this.sourceFile, body),
        },
        {
          stableId: `${collectionStableId}:set`,
          text: 'set',
          kind: 'method',
          labels: ['Method', 'Assignment', 'ContainerMethod', 'Set', 'Virtual'],
          order: 1,
          sourceStableId: getExtendedStableId(this.sourceFile, body),
        },
      ] satisfies RenderPartDescriptor[]),
    }, collectionStableId);

    const argumentStableIds = body.elements.map((element, index) => {
      const elementStableId = `${callbackStableId}:next-state:argument:${index}`;
      const current = unwrapExpression(element);
      const spread = ts.isSpreadElement(current);
      const value = spread ? unwrapExpression(current.expression) : current;
      const valueText = value.getText(this.sourceFile);
      this.createNode(spread ? 'Arg' : 'Value', spread ? 'spread argument' : 'value argument', element, {
        labels: uniqueStrings([
          'Arg',
          'ExecutionOccurrence',
          'Value',
          'ValueRead',
          ...(spread ? ['Collection', 'Spread', 'Op'] : ['Variable']),
          'StateUpdate',
          'SemanticExpansion',
        ]),
        diaName: spread ? valueText : valueText,
        actionTextRaw: element.getText(this.sourceFile),
        bindingStableId: this.bindingStableIdForExpression(value),
        argumentIndex: index,
        semanticExpansion: 'state-update',
        sequenceOwnerStableId: callStableId,
        flowLayer: 'data',
        dataFlowRole: 'input',
        synthetic: true,
        ...(spread ? {
          renderPartsLayout: 'container-overlay-side' as const,
          renderPrimaryPartIndex: 0,
          renderPartsJson: JSON.stringify([
            {
              stableId: elementStableId,
              text: valueText,
              kind: 'collection-container',
              labels: ['Collection', 'Value', 'ValueRead'],
              order: 0,
              fillState: 'filled',
              sourceStableId: getExtendedStableId(this.sourceFile, value),
            },
            {
              stableId: elementStableId,
              text: '...',
              kind: 'operator',
              labels: ['Op', 'Spread', 'SystemSpread'],
              order: 1,
              sourceStableId: getExtendedStableId(this.sourceFile, current),
            },
          ] satisfies RenderPartDescriptor[]),
        } : {}),
      }, elementStableId);
      this.addEdge(undefined, callStableId, undefined, elementStableId, 'ARG', {
        label: '',
        argumentIndex: index,
        flowLayer: 'data',
        semanticExpansion: 'state-update',
        sequenceOrder: index,
      });
      return elementStableId;
    });

    argumentStableIds.forEach((argumentStableId, index) => {
      this.addEdge(undefined, argumentStableId, undefined, collectionStableId, 'ArgJoin', {
        label: '',
        argumentIndex: index,
        flowLayer: 'data',
        semanticExpansion: 'state-update',
        sequenceOrder: index,
        targetRenderPartStableId: `${collectionStableId}:set`,
      });
    });

    const callCloseStableId = `${callbackStableId}:state-update:complete`;
    this.createNode('FnVisualProxy', 'state update complete', callExpression, {
      labels: ['VisualProxy', 'FnVisualProxy', 'Arg', 'Join', 'Call', 'Method', 'StateUpdate'],
      diaName: ')',
      actionTextRaw: callExpression.getText(this.sourceFile),
      sourceCallStableId: callStableId,
      semanticExpansion: 'state-update',
      sequenceOwnerStableId: callStableId,
      flowLayer: 'control',
      synthetic: true,
      callBoundaryDesign: 'split',
      callBoundaryRole: 'close',
      callBoundaryPeerStableId: callStableId,
      callMosaicOwnerStableId: callStableId,
      callMosaicRole: 'close',
      renderPartsLayout: 'single',
      renderPrimaryPartIndex: 0,
      renderPartsJson: JSON.stringify([{
        stableId: callCloseStableId,
        text: ')',
        kind: 'method',
        labels: ['Call', 'Method', 'VisualProxy', 'StateUpdate'],
        order: 0,
        sourceStableId: getExtendedStableId(this.sourceFile, callExpression),
      }] satisfies RenderPartDescriptor[]),
    }, callCloseStableId);
    if (callNode) callNode.callBoundaryPeerStableId = callCloseStableId;
    this.addEdge(undefined, collectionStableId, undefined, callCloseStableId, 'NEXT', {
      label: '',
      flowLayer: 'control',
      semanticExpansion: 'state-update',
      sequenceOrder: body.elements.length,
      sourceRenderPartStableId: collectionStableId,
    });
  }

  private shouldAddRequestResponseEdges(target: ResolvedCallTarget | undefined) {
    return isCallableGraphTarget(target) || target?.stableId === 'external:bun-bundle:feature';
  }

  private materializeCallArgumentsToProxy(
    callExpression: ts.CallExpression,
    callStableId: string,
    target: ResolvedCallTarget | undefined,
    callRoleLabel: string,
    options: {
      suppressResultNode?: boolean;
      suppressReceiver?: boolean;
      suppressTrackedExecution?: boolean;
      resultEdgeMode?: 'default' | 'value';
      dataBranchOwnerStableId?: string;
    } = {},
  ) {
    if (!options.suppressReceiver) {
      this.materializeCallReceiver(callExpression, callStableId);
    }
    const args = [...callExpression.arguments].map((argument, index) => ({ argument, index }));
    const mosaicArgs = this.callMosaicArguments(callExpression);
    const submethodArgs = args.filter(({ argument, index }) => (
      this.callArgumentIsExtractedAsSubmethod(callExpression, argument, index)
    ));
    const callEdgeType = callRoleLabel === 'Request' ? 'REQUEST' : callRoleLabel === 'Read' ? 'READ' : callRoleLabel === 'Write' ? 'WRITE' : 'CALL';
    const resultStableId = !options.suppressResultNode
      && this.callReturnsValue(callExpression, callRoleLabel)
      && !this.hasContextualCallResultTarget(callStableId)
      && (
        !callExpression.arguments.some((argument) => isFunctionArgumentExpression(argument))
        || this.isColumnCollectionMethodCall(callExpression)
      )
      && !(
        options.resultEdgeMode !== 'value'
        && isPropertyAccessLikeExpression(callExpression.parent)
        && callExpression.parent.expression === callExpression
        && ts.isCallExpression(callExpression.parent.parent)
      )
      ? this.createCallResultNode(callExpression, callStableId, {
          dataBranchOwnerStableId: options.dataBranchOwnerStableId,
        })
      : undefined;
    if (this.inlineCallUsesCallNodeAsProxy(callExpression)) {
      // A promoted callback is executable submethod content, not a tile of
      // the enclosing call boundary.
      for (const { argument, index } of submethodArgs) {
        this.createArgumentNode(callExpression, argument, index);
      }
      // A mosaic call owns its complete 0/1-argument expression in one node.
      // Column protocols still materialize arguments because their callback or
      // iteration chains are independently traversable graph structures.
      if (this.callBoundaryDesign(callExpression) === 'column') {
        for (const { argument, index } of mosaicArgs) {
          const argEntry = this.createArgumentNode(callExpression, argument, index);
          if (argEntry.omitFromCall) continue;
          const argumentName = this.getParameterName(callExpression, index);
          this.addEdge(undefined, callStableId, undefined, argEntry.argStableId, 'ARG', {
            label: `arg ${index + 1}`,
            argumentName,
            argumentIndex: index,
          });
          for (const exit of argEntry.exitsToArgs) {
            this.addEdge(exit.fromKind, exit.fromId, undefined, callStableId, exit.edgeType, {
              label: exit.label,
              argumentName: exit.argumentName ?? argumentName,
              argumentIndex: exit.argumentIndex ?? index,
              callTextRaw: callExpression.getText(this.sourceFile),
              callSiteStableId: callStableId,
              invocationType: callEdgeType,
            });
          }
        }
      }
      const stateResource = this.resolveReactStateResource(callExpression.expression);
      const accessorProxyStableId = !stateResource && (callRoleLabel === 'Read' || callRoleLabel === 'Write')
        ? this.createFnVisualProxy(callExpression, callStableId, target, callRoleLabel, {
            materializeReceiver: !options.suppressReceiver,
          })
        : undefined;
      if (accessorProxyStableId) {
        this.addEdge(undefined, callStableId, undefined, accessorProxyStableId, callEdgeType, {
          label: '',
          callTextRaw: callExpression.getText(this.sourceFile),
          callSiteStableId: callStableId,
          invocationType: callEdgeType,
          flowLayer: callRoleLabel === 'Read' ? 'data' : 'mixed',
        });
      }
      this.addCallEdges(accessorProxyStableId || callStableId, callExpression, target, {
        edgeType: callEdgeType,
        resultStableId,
        callSiteStableId: callStableId,
        resultEdgeMode: options.resultEdgeMode,
        resultDisplayLabel: options.dataBranchOwnerStableId ? 'value' : undefined,
        resultTargetRenderPartStableId: options.dataBranchOwnerStableId && resultStableId
          ? this.buildCallResultPartStableId(callStableId, 'set')
          : undefined,
      });
      if (this.shouldMaterializeTrackedCallExecution(
        callExpression,
        options.suppressTrackedExecution,
      )) {
        this.materializeTrackedCallExecution(
          callExpression,
          callStableId,
          this.enclosingCallbackStableId(callExpression),
        );
      }
      return {
        proxyStableId: callStableId,
        resultStableId,
        pending: [this.createPendingExit(undefined, resultStableId || callStableId, 'NEXT')],
      };
    }

    const argumentExits: PendingExit[] = [];
    const argumentRootStableIds: string[] = [];
    const argumentTerminalStableIds: string[][] = [];
    const representationPlan = this.astRepresentationPlanByNode.get(callExpression);
    const foldedSoleObjectOpening = representationPlan?.foldSoleObjectBoundary === true;
    for (const { argument, index } of submethodArgs) {
      this.createArgumentNode(callExpression, argument, index);
    }
    const singleArgumentMosaic = mosaicArgs.length === 1;
    if (foldedSoleObjectOpening) {
      const openingNode = this.nodeByStableId(callStableId);
      const objectArgument = mosaicArgs[0] && unwrapExpression(mosaicArgs[0].argument);
      if (openingNode && objectArgument && ts.isObjectLiteralExpression(objectArgument)) {
        openingNode.callBoundaryDesign = 'split';
        openingNode.callBoundaryRole = 'open';
        openingNode.callHasArguments = true;
        const renderParts = JSON.parse(openingNode.renderPartsJson || '[]') as RenderPartDescriptor[];
        if (objectArgument.properties.length <= 1) {
          renderParts.push({
            stableId: callStableId,
            text: '{',
            kind: 'punctuation',
            labels: ['Object', 'Arg'],
            order: renderParts.length,
            sourceStableId: getExtendedStableId(this.sourceFile, objectArgument),
          });
        }
        if (openingNode.labels.includes('Collection') && renderParts[0]) {
          renderParts[0] = {
            ...renderParts[0],
            kind: 'collection-container',
            labels: uniqueStrings([...(renderParts[0].labels || []), 'Collection']),
          };
          openingNode.renderPartsLayout = 'container-overlay-side';
          openingNode.renderPrimaryPartIndex = renderParts.findIndex((part) => part.kind === 'method');
        } else {
          openingNode.renderPartsLayout = 'horizontal';
          openingNode.renderPrimaryPartIndex = 0;
        }
        openingNode.renderPartsJson = JSON.stringify(renderParts);
      }
    }
    mosaicArgs.forEach(({ argument, index }) => {
      const foldObjectOpening = foldedSoleObjectOpening
        && ts.isObjectLiteralExpression(unwrapExpression(argument));
      const expandedFoldedObjectOpening = foldObjectOpening
        && ts.isObjectLiteralExpression(unwrapExpression(argument))
        && (unwrapExpression(argument) as ts.ObjectLiteralExpression).properties.length > 1;
      const argEntry = this.createArgumentNode(callExpression, argument, index, {
        ownerCallStableId: callStableId,
        foldObjectOpeningIntoOwner: foldObjectOpening,
        foldedCallBoundary: foldObjectOpening
          ? {
              target,
              callRoleLabel: callRoleLabel as 'Read' | 'Write' | 'Request' | 'Call' | 'Op',
              materializeReceiver: !options.suppressReceiver,
            }
          : undefined,
      });
      if (argEntry.omitFromCall) return;
      const terminalStableIds = [
        ...new Set(argEntry.exitsToArgs.map((exit) => getStableIdKey(exit.fromId))),
      ];
      if (!foldObjectOpening) {
        argumentRootStableIds.push(argEntry.argStableId);
      }
      argumentTerminalStableIds.push(terminalStableIds);
      const argumentName = this.getParameterName(callExpression, index);
      if (!foldObjectOpening && !argEntry.rootEdgeAlreadyMaterialized) {
        this.addEdge(undefined, callStableId, undefined, argEntry.argStableId, 'ARG', {
          label: `arg ${index + 1}`,
          argumentName,
          argumentIndex: index,
          renderHidden: singleArgumentMosaic,
        });
      }
      if (expandedFoldedObjectOpening && !argEntry.rootEdgeAlreadyMaterialized) {
        this.addEdge(undefined, callStableId, undefined, argEntry.argStableId, 'ARG', {
          label: `arg ${index + 1}`,
          argumentName,
          argumentIndex: index,
          flowLayer: 'data',
          semanticExpansion: 'call-object',
        });
      }
      if (
        !foldObjectOpening
        && !argEntry.rootEdgeAlreadyMaterialized
        && !isFunctionArgumentExpression(argument)
      ) {
        this.addEdge(
          undefined,
          callStableId,
          undefined,
          argEntry.argStableId,
          'MATERIALIZES_ARGUMENT',
          {
            label: argument.getText(this.sourceFile),
            flowLayer: 'control',
            semanticExpansion: 'call-execution',
            sequenceOrder: index,
          },
        );
      }
      argumentExits.push(...argEntry.exitsToArgs);
    });

    const foldedSoleObjectClosing = foldedSoleObjectOpening;
    const foldedTerminalStableId = argumentTerminalStableIds[0]?.[0];
    const proxyStableId = foldedSoleObjectClosing && foldedTerminalStableId
      ? foldedTerminalStableId
      : this.createFnVisualProxy(callExpression, callStableId, target, callRoleLabel, {
          materializeReceiver: !options.suppressReceiver,
        });
    if (singleArgumentMosaic) {
      const openingNode = this.nodeByStableId(callStableId);
      const argumentNode = this.nodeByStableId(argumentRootStableIds[0]);
      const closingNode = this.nodeByStableId(proxyStableId);
      if (openingNode) {
        openingNode.callMosaicOwnerStableId = callStableId;
        openingNode.callMosaicRole = 'open';
      }
      if (argumentNode && !foldedSoleObjectOpening) {
        argumentNode.callMosaicOwnerStableId = callStableId;
        argumentNode.callMosaicRole = 'argument';
      }
      const argumentTerminalStableIdsForCall = argumentTerminalStableIds[0] || [];
      if (
        !foldedSoleObjectOpening
        && argumentNode?.labels.includes('Object')
        && argumentTerminalStableIdsForCall.length === 1
        && argumentTerminalStableIdsForCall[0] !== (argumentRootStableIds[0] || callStableId)
      ) {
        const argumentClosingNode = this.nodeByStableId(argumentTerminalStableIdsForCall[0]);
        if (argumentClosingNode) {
          argumentClosingNode.callMosaicOwnerStableId = callStableId;
          argumentClosingNode.callMosaicRole = 'argument-close';
        }
      } else if (
        argumentNode?.callBoundaryDesign === 'split'
        && argumentTerminalStableIdsForCall.length === 1
        && argumentTerminalStableIdsForCall[0] !== argumentRootStableIds[0]
      ) {
        // A sole nested expanded call is one family inside its parent call.
        // Keep both calls as graph nodes, but identify the symmetric seams so
        // the renderer can mosaic open+open and close+close around the nested
        // argument family.
        const argumentClosingNode = this.nodeByStableId(argumentTerminalStableIdsForCall[0]);
        if (argumentClosingNode) {
          argumentClosingNode.callMosaicOwnerStableId = callStableId;
          argumentClosingNode.callMosaicRole = 'argument-close';
        }
      }
      if (closingNode) {
        closingNode.callMosaicOwnerStableId = callStableId;
        closingNode.callMosaicRole = 'close';
      }
    }
    if (mosaicArgs.length === 0) {
      this.addEdge(undefined, callStableId, undefined, proxyStableId, 'ArgJoin', {
        label: '',
        callTextRaw: callExpression.getText(this.sourceFile),
        callSiteStableId: callStableId,
        invocationType: callEdgeType,
        flowLayer: 'data',
      });
    }
    for (const exit of argumentExits) {
      if (foldedSoleObjectClosing && getStableIdKey(exit.fromId) === proxyStableId) continue;
      this.addEdge(exit.fromKind, exit.fromId, undefined, proxyStableId, exit.edgeType, {
        label: exit.label,
        argumentName: exit.argumentName,
        argumentIndex: exit.argumentIndex,
        callTextRaw: callExpression.getText(this.sourceFile),
        callSiteStableId: callStableId,
        invocationType: callEdgeType,
        renderHidden: singleArgumentMosaic,
      });
    }
    this.addCallEdges(proxyStableId, callExpression, target, {
      edgeType: callEdgeType,
      resultStableId,
      callSiteStableId: callStableId,
      resultEdgeMode: options.resultEdgeMode,
      resultDisplayLabel: options.dataBranchOwnerStableId ? 'value' : undefined,
      resultTargetRenderPartStableId: options.dataBranchOwnerStableId && resultStableId
        ? this.buildCallResultPartStableId(callStableId, 'set')
        : undefined,
    });
    if (this.shouldMaterializeTrackedCallExecution(
      callExpression,
      options.suppressTrackedExecution,
    )) {
      this.materializeTrackedCallExecution(
        callExpression,
        callStableId,
        this.enclosingCallbackStableId(callExpression),
      );
    }

    return {
      proxyStableId,
      resultStableId,
      pending: [this.createPendingExit(
        undefined,
        resultStableId || (
          !options.suppressResultNode && (callRoleLabel === 'Call' || callRoleLabel === 'Write')
            ? callStableId
            : proxyStableId
        ),
        'NEXT',
      )],
    };
  }

  private buildObjectValueStableId(expression: ts.ObjectLiteralExpression, constStableId: string) {
    const { startLine, startColumn, endLine, endColumn } = getRange(this.sourceFile, expression);
    const base = buildStableIdFromCoordinates({
      filePath: toPosix(path.resolve(this.sourceFile.fileName)),
      startLine,
      startColumn,
      endLine,
      endColumn,
    });
    return `flow:object-value:${base}:${sanitizeSyntheticExternalPart(constStableId)}`;
  }

  private buildNestedCallStableId(callExpression: ts.CallExpression, argumentIndex: number, nestedIndex: number) {
    const { startLine, startColumn, endLine, endColumn } = getRange(this.sourceFile, callExpression);
    const base = buildStableIdFromCoordinates({
      filePath: toPosix(path.resolve(this.sourceFile.fileName)),
      startLine,
      startColumn,
      endLine,
      endColumn,
    });
    return `flow:call:${base}:arg${argumentIndex}:call${nestedIndex}`;
  }

  private buildObjectStableId(argument: ts.ObjectLiteralExpression, argumentIndex: number) {
    const { startLine, startColumn, endLine, endColumn } = getRange(this.sourceFile, argument);
    const base = buildStableIdFromCoordinates({
      filePath: toPosix(path.resolve(this.sourceFile.fileName)),
      startLine,
      startColumn,
      endLine,
      endColumn,
    });
    return `flow:object:${base}:arg${argumentIndex}`;
  }

  private buildObjectFieldStableId(property: ts.ObjectLiteralElementLike, argumentIndex: number, fieldIndex: number) {
    const { startLine, startColumn, endLine, endColumn } = getRange(this.sourceFile, property);
    const base = buildStableIdFromCoordinates({
      filePath: toPosix(path.resolve(this.sourceFile.fileName)),
      startLine,
      startColumn,
      endLine,
      endColumn,
    });
    return `flow:object-field:${base}`;
  }

  private buildMergeFieldsStableId(argument: ts.ObjectLiteralExpression, argumentIndex: number) {
    const { startLine, startColumn, endLine, endColumn } = getRange(this.sourceFile, argument);
    const base = buildStableIdFromCoordinates({
      filePath: toPosix(path.resolve(this.sourceFile.fileName)),
      startLine,
      startColumn,
      endLine,
      endColumn,
    });
    return `flow:field-join:${base}`;
  }

  private getObjectFieldName(property: ts.ObjectLiteralElementLike, index: number) {
    if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) || ts.isMethodDeclaration(property)) {
      return getPropertyNameText(property.name);
    }
    if (ts.isSpreadAssignment(property)) {
      return `spread ${index + 1}`;
    }
    return `field ${index + 1}`;
  }

  private getObjectFieldSemanticName(property: ts.ObjectLiteralElementLike) {
    if (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) {
      return getPropertyNameText(property.name);
    }
    return undefined;
  }

  private getObjectFieldDisplayName(
    property: ts.ObjectLiteralElementLike,
    valueNode: ts.Expression | ts.ObjectLiteralElementLike,
  ) {
    if (!ts.isPropertyAssignment(property)) return undefined;
    const fieldName = getPropertyNameText(property.name);
    if (!fieldName || !ts.isExpression(valueNode)) return fieldName;
    const valueExpression = unwrapExpression(valueNode);
    const valueName = ts.isIdentifier(valueExpression) ? valueExpression.text : undefined;
    return valueName === fieldName ? undefined : fieldName;
  }

  private getObjectFieldValueNode(property: ts.ObjectLiteralElementLike): ts.Expression | ts.ObjectLiteralElementLike {
    if (ts.isPropertyAssignment(property)) {
      return property.initializer;
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      return property.name;
    }
    if (ts.isSpreadAssignment(property)) {
      return property.expression;
    }
    return property;
  }

  private getParameterName(callExpression: ts.CallExpression, index: number) {
    const signature = this.checker.getResolvedSignature(callExpression);
    const parameters = signature?.parameters || [];
    const directParameter = parameters[index];
    const lastParameter = parameters.at(-1);
    const lastDeclaration = lastParameter?.valueDeclaration || lastParameter?.declarations?.[0];
    const parameter = directParameter || (
      lastDeclaration && ts.isParameter(lastDeclaration) && lastDeclaration.dotDotDotToken
        ? lastParameter
        : undefined
    );
    const name = parameter?.getName();
    return name && name !== '__0' ? name : undefined;
  }

  private isStateUpdateCall(callExpression: ts.CallExpression) {
    return Boolean(this.resolveReactStateResource(callExpression.expression));
  }

  private resolveReactStateResource(expression: ts.Expression): ReactStateResourceIdentity | undefined {
    const callee = unwrapExpression(expression);
    if (!ts.isIdentifier(callee) && !ts.isPropertyAccessExpression(callee)) return undefined;
    const symbol = resolvedSymbolAt(this.checker, ts.isPropertyAccessExpression(callee) ? callee.name : callee);
    const resources = symbol && this.reactStateProvenance.resourcesBySetterSymbol.get(symbol);
    return resources?.size === 1 ? resources.values().next().value : undefined;
  }

  private buildReactStateUpdateExtra(callExpression: ts.CallExpression): FlowNodeExtra {
    const creation = this.reactStateProvenance.resourceByCreationCall.get(callExpression);
    const binding = creation || this.resolveReactStateResource(callExpression.expression);
    if (!binding) return {};
    const value = callExpression.arguments[0] && unwrapExpression(callExpression.arguments[0]);
    const stateUpdateAction = creation ? 'create' : value
      && (value.kind === ts.SyntaxKind.NullKeyword || ts.isIdentifier(value) && value.text === 'undefined')
      ? 'clear'
      : 'write';
    return {
      asyncSchedulerKind: 'react-state',
      stateResourceStableId: binding.stableId,
      stateResourceParentFnStableId: binding.parentFnStableId,
      stateResourceRepoRelativePath: binding.repoRelativePath,
      stateResourceName: binding.name,
      stateSetterName: creation ? getCallLikeName(callExpression.expression) || 'useState' : binding.setterName,
      stateUpdateAction,
      sourceDocumentation: creation
        ? leadingSourceDocumentation(callExpression, this.sourceFile)
        : undefined,
    };
  }

  private isUiInjectionCall(callExpression: ts.CallExpression) {
    const calleeName = getCallLikeName(callExpression.expression) || '';
    const hasVirtualViewPayload = callExpression.arguments.some((argument) => {
      return containsJsxNode(argument) || objectLiteralHasProperty(argument, 'jsx');
    });
    return hasVirtualViewPayload && /(?:JSX|View|Element)$/u.test(calleeName);
  }

  private semanticCallSiteLabels(callExpression: ts.CallExpression, baseLabels: string[] = []) {
    const labels = [...baseLabels, ...this.operationProviderLabels(callExpression)];
    if (this.isUiInjectionCall(callExpression)) {
      labels.push('UiInjection');
    }
    return uniqueStrings(labels);
  }

  private getAsyncContinuationDeclaration(statement: ts.Statement) {
    const declaration = this.getLocalFunctionDeclaration(statement);
    if (!declaration || !nodeHasModifier(declaration.initializer, ts.SyntaxKind.AsyncKeyword)) {
      return undefined;
    }
    return declaration;
  }

  private getLocalFunctionDeclaration(statement: ts.Statement) {
    if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) {
      return undefined;
    }

    const declaration = statement.declarationList.declarations[0];
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
      return undefined;
    }

    const initializer = unwrapExpression(declaration.initializer);
    if (!(ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
      return undefined;
    }

    return {
      declaration,
      name: declaration.name.text,
      initializer,
    };
  }

  private getContinuationRunExpression(statement: ts.Statement) {
    if (!ts.isExpressionStatement(statement)) {
      return undefined;
    }

    const expression = unwrapExpression(statement.expression);
    const callExpression = ts.isVoidExpression(expression)
      ? unwrapExpression(expression.expression)
      : expression;
    if (!ts.isCallExpression(callExpression) || !ts.isIdentifier(callExpression.expression)) {
      return undefined;
    }

    const continuation = this.localAsyncContinuationsByName.get(callExpression.expression.text);
    if (!continuation) {
      return undefined;
    }

    return {
      callExpression,
      name: callExpression.expression.text,
      declarationId: continuation.declarationId,
      declaration: continuation.declaration,
      initializer: continuation.initializer,
    };
  }

  private buildLocalFunctionProxyStableId(declarationStableId: string, proxyRole: string) {
    return `${declarationStableId}:local-function-proxy:${sanitizeSyntheticExternalPart(proxyRole)}`;
  }

  private createLocalFunctionProxy(
    continuation: {
      declaration: ts.VariableDeclaration;
      name: string;
      initializer: ts.ArrowFunction | ts.FunctionExpression;
    },
    ownerNode: ts.Node,
    declarationStableId: string,
    proxyRole: string,
    proxyReason: string,
    extra: FlowNodeExtra = {},
  ) {
    const hasUiInjection = this.nodeContainsUiInjection(ownerNode);
    const isAsync = nodeHasModifier(continuation.initializer, ts.SyntaxKind.AsyncKeyword);
    return this.createNode('LocalFunctionProxy', 'local function proxy', continuation.initializer, {
      labels: uniqueStrings([
        'LocalFunctionProxy',
        'FunctionProxy',
        isAsync ? 'Async' : undefined,
        'Fn',
      ]),
      diaName: continuation.name,
      actionTextRaw: continuation.initializer.getText(this.sourceFile),
      operationSubjectText: continuation.name,
      operationValueText: continuation.initializer.getText(this.sourceFile),
      asyncSchedulerKind: isAsync ? 'local-async-function' : undefined,
      asyncContract: isAsync ? 'fire-and-forget' : undefined,
      calleeStableId: this.stableIdByDeclaration.get(continuation.initializer),
      declaredByStableId: declarationStableId,
      containsUiInjection: hasUiInjection,
      uiSlotName: hasUiInjection ? 'jsx' : undefined,
      callbackDeferred: true,
      proxyRole,
      proxyReason,
      synthetic: true,
      ...extra,
    }, this.buildLocalFunctionProxyStableId(declarationStableId, proxyRole));
  }

  private statementContainsUiInjection(statement: ts.Statement) {
    return this.nodeContainsUiInjection(statement);
  }

  private nodeContainsUiInjection(node: ts.Node) {
    return collectCallExpressionsIncludingNestedFunctions(node).some((callExpression) => this.isUiInjectionCall(callExpression));
  }

  private semanticStatementLabels(statement: ts.Statement, baseLabels: string[] = []) {
    const labels = [...baseLabels];
    if (containsAwaitExpression(statement)) {
      labels.push('Async', 'Boundary');
    }
    if (this.statementContainsUiInjection(statement)) {
      labels.push('UiInjection');
    }
    return uniqueStrings(labels);
  }

  private createObjectNodes(
    argument: ts.ObjectLiteralExpression,
    argumentIndex: number,
    objectStableIdOverride?: string,
    enclosingLabels: string[] = [],
    objectLabels: string[] = [],
    argumentName?: string,
    options: {
      openingOwnerStableId?: string;
      foldedCallBoundary?: {
        callExpression: ts.CallExpression;
        callStableId: string;
        target: ResolvedCallTarget | undefined;
        callRoleLabel: 'Read' | 'Write' | 'Request' | 'Call' | 'Op';
        materializeReceiver: boolean;
      };
      foldedAssignmentBoundary?: {
        assignmentStableId: string;
        declaration: ts.VariableDeclaration;
      };
    } = {},
  ) {
    const emptyObject = argument.properties.length === 0;
    const expandedFieldFamily = argument.properties.length > 1;
    const singleProperty = argument.properties.length === 1 ? argument.properties[0] : undefined;
    const singleValueNode = singleProperty ? this.getObjectFieldValueNode(singleProperty) : undefined;
    const compactSingleFieldObject = Boolean(
      singleProperty
      && singleValueNode
      && ts.isExpression(singleValueNode)
      && !isStructuredControlExpression(singleValueNode)
      && !isFunctionArgumentExpression(singleValueNode)
      && !containsJsxNode(singleValueNode)
      && collectCallExpressions(singleValueNode).length === 0
      && !ts.isObjectLiteralExpression(unwrapExpression(singleValueNode)),
    );
    const rawObjectStableId = objectStableIdOverride || this.buildObjectStableId(argument, argumentIndex);
    let objectStableId = options.openingOwnerStableId || (!expandedFieldFamily
      ? this.createNode(
          'Object',
          'object',
          argument,
          {
            labels: uniqueStrings(['Object', ...objectLabels, ...enclosingLabels]),
            diaName: emptyObject ? '{}' : '{',
            actionTextRaw: argument.getText(this.sourceFile),
            argumentName,
            argumentIndex,
          },
          rawObjectStableId,
        )
      : undefined);

    if (compactSingleFieldObject && singleProperty && singleValueNode && ts.isExpression(singleValueNode)) {
      const objectNode = objectStableId ? this.nodeByStableId(objectStableId) : undefined;
      if (objectNode) {
        const existingParts = options.openingOwnerStableId
          ? JSON.parse(objectNode.renderPartsJson || '[]') as RenderPartDescriptor[]
          : [];
        const valueExpression = unwrapExpression(singleValueNode);
        const fieldName = this.getObjectFieldName(singleProperty, 0);
        const semanticFieldName = this.getObjectFieldSemanticName(singleProperty);
        const bindingStableId = this.bindingStableIdForExpression(singleValueNode);
        const literal = isLiteralInlineCallArgument(singleValueNode);
        const hasOpening = existingParts.some((part) => part.text === '{');
        const compactParts: RenderPartDescriptor[] = [
          ...existingParts,
          ...(!hasOpening ? [{
            stableId: objectStableId,
            text: '{',
            kind: 'punctuation' as const,
            labels: ['Object', 'Open'],
            order: existingParts.length,
            sourceStableId: getExtendedStableId(this.sourceFile, argument),
          }] : []),
          ...(ts.isPropertyAssignment(singleProperty) ? [{
            stableId: objectStableId,
            text: `${fieldName}:`,
            kind: 'punctuation' as const,
            labels: ['Object', 'Field', 'FieldName'],
            order: 0,
            sourceStableId: getExtendedStableId(this.sourceFile, singleProperty.name),
          }] : []),
          {
            stableId: objectStableId,
            text: valueExpression.getText(this.sourceFile),
            kind: literal ? 'literal' : 'value',
            labels: uniqueStrings([
              'Object',
              'Field',
              literal ? 'Literal' : undefined,
              bindingStableId ? 'ValueAccess' : undefined,
              bindingStableId ? 'ValueRead' : undefined,
            ].filter(Boolean) as string[]),
            order: 0,
            sourceStableId: bindingStableId || getExtendedStableId(this.sourceFile, singleValueNode),
            canonicalStableId: bindingStableId,
            bindingStableId,
          },
          {
            stableId: objectStableId,
            text: '}',
            kind: 'punctuation',
            labels: ['Object', 'Close'],
            order: 0,
            sourceStableId: getExtendedStableId(this.sourceFile, argument),
          },
        ];
        objectNode.labels = uniqueStrings([...objectNode.labels, 'CompactObject', 'Field']);
        objectNode.diaName = argument.getText(this.sourceFile);
        objectNode.actionTextRaw = argument.getText(this.sourceFile);
        objectNode.fieldName = semanticFieldName;
        objectNode.fieldIndex = 0;
        objectNode.renderPartsLayout = objectNode.renderPartsLayout === 'container-overlay-side'
          ? 'container-overlay-side'
          : 'horizontal';
        objectNode.renderPrimaryPartIndex = compactParts.findIndex((part) => part.kind === 'value' || part.kind === 'literal');
        objectNode.renderPartsJson = JSON.stringify(
          compactParts.map((part, order) => ({ ...part, order })),
        );
      }
    }

    if (emptyObject) {
      return {
        objectStableId,
        exitsToArg: [this.createPendingExit(undefined, objectStableId, 'NEXT', 'object')],
      };
    }

    if (expandedFieldFamily && options.openingOwnerStableId) {
      const opening = this.nodeByStableId(objectStableId);
      if (opening) opening.opensObjectFieldFamily = true;
    }

    const bracePairCount = expandedFieldFamily ? Math.floor(argument.properties.length / 2) : 0;
    const mergeFieldsStableIdValue = this.buildMergeFieldsStableId(argument, argumentIndex);
    const leftBraceStableIds: string[] = [];
    const rightBraceStableIds: string[] = [];
    const fieldBracePairIndex = (fieldIndex: number) => Math.min(
      fieldIndex,
      argument.properties.length - 1 - fieldIndex,
      Math.max(0, bracePairCount - 1),
    );
    if (expandedFieldFamily) {
      for (let pairIndex = 0; pairIndex < bracePairCount; pairIndex += 1) {
        const pairedFieldIndices = [pairIndex, argument.properties.length - 1 - pairIndex];
        if (argument.properties.length % 2 === 1 && pairIndex === bracePairCount - 1) {
          pairedFieldIndices.splice(1, 0, Math.floor(argument.properties.length / 2));
        }
        const leftBraceStableId = this.createNode('ObjectBrace', 'object field brace', argument, {
              labels: uniqueStrings(['ObjectBrace', 'Object', 'Open', ...objectLabels, ...enclosingLabels]),
              diaName: '',
              actionTextRaw: argument.getText(this.sourceFile),
              objectBraceSide: 'left',
              objectBracePairIndex: pairIndex,
              objectBracePairCount: bracePairCount,
              objectBraceFieldIndicesJson: JSON.stringify(pairedFieldIndices),
              objectBraceMosaicNeighborStableId: pairIndex === 0 ? options.openingOwnerStableId : undefined,
            }, `${rawObjectStableId}:brace:left:${pairIndex}`);
        const rightBraceStableId = this.createNode('ObjectBrace', 'object field brace', argument, {
              labels: uniqueStrings(['ObjectBrace', 'Object', 'Close', ...objectLabels, ...enclosingLabels]),
              diaName: '',
              actionTextRaw: argument.getText(this.sourceFile),
              objectBraceSide: 'right',
              objectBracePairIndex: pairIndex,
              objectBracePairCount: bracePairCount,
              objectBraceFieldIndicesJson: JSON.stringify(pairedFieldIndices),
            }, `${rawObjectStableId}:brace:right:${pairIndex}`);
        const leftBrace = this.nodeByStableId(leftBraceStableId);
        if (leftBrace) {
          leftBrace.objectBraceFieldIndicesJson = JSON.stringify(pairedFieldIndices);
          leftBrace.objectBracePairCount = bracePairCount;
          leftBrace.objectBracePairIndex = pairIndex;
          leftBrace.objectBraceSide = 'left';
        }
        leftBraceStableIds.push(leftBraceStableId);
        rightBraceStableIds.push(rightBraceStableId);
      }
      const familyStableId = leftBraceStableIds[0];
      [...leftBraceStableIds, ...rightBraceStableIds].forEach((stableId) => {
        const brace = this.nodeByStableId(stableId);
        if (brace) brace.objectFamilyStableId = familyStableId;
      });
      objectStableId = options.foldedCallBoundary
        ? leftBraceStableIds[0]
        : objectStableId || leftBraceStableIds[0];
    }

    const mergeFieldsStableId = compactSingleFieldObject
      && !options.foldedCallBoundary
      && !options.foldedAssignmentBoundary
      ? objectStableId
      : expandedFieldFamily && !options.foldedCallBoundary && !options.foldedAssignmentBoundary
      ? rightBraceStableIds[0]
      : options.foldedCallBoundary
      ? this.createFnVisualProxy(
          options.foldedCallBoundary.callExpression,
          options.foldedCallBoundary.callStableId,
          options.foldedCallBoundary.target,
          options.foldedCallBoundary.callRoleLabel,
          {
            materializeReceiver: options.foldedCallBoundary.materializeReceiver,
            stableIdOverride: mergeFieldsStableIdValue,
            foldedObjectArgument: argument,
          },
        )
      : options.foldedAssignmentBoundary
        ? this.createNode('FnVisualProxy', 'set', argument, {
            labels: uniqueStrings(['Field', 'Join', 'Object', 'Method', 'Call', 'VisualProxy', 'Virtual', ...enclosingLabels]),
            diaName: ')',
            actionTextRaw: argument.properties.map((property) => property.getText(this.sourceFile)).join(', '),
            callBoundaryDesign: 'split',
            callBoundaryRole: 'close',
            callHasArguments: true,
            callBoundaryPeerStableId: options.foldedAssignmentBoundary.assignmentStableId,
            callMosaicOwnerStableId: options.foldedAssignmentBoundary.assignmentStableId,
            callMosaicRole: 'close',
            renderPartsLayout: 'horizontal',
            renderPrimaryPartIndex: 0,
            renderPartsJson: JSON.stringify([
              {
                stableId: mergeFieldsStableIdValue,
                text: ')',
                kind: 'method',
                labels: ['Op', 'Method', 'Call', 'VisualProxy', 'Virtual'],
                order: 0,
                sourceStableId: getExtendedStableId(
                  this.sourceFile,
                  options.foldedAssignmentBoundary.declaration,
                ),
              },
            ] satisfies RenderPartDescriptor[]),
          }, mergeFieldsStableIdValue)
      : this.createNode('FieldJoin', 'field join', argument, {
          labels: uniqueStrings(['Field', 'Join', ...enclosingLabels]),
          diaName: '}',
          actionTextRaw: argument.properties.map((property) => property.getText(this.sourceFile)).join(', '),
        }, mergeFieldsStableIdValue);
    if (expandedFieldFamily) {
      const familyStableId = leftBraceStableIds[0];
      const opening = this.nodeByStableId(leftBraceStableIds[0]);
      if (opening) {
        opening.objectFamilyStableId = familyStableId;
        opening.objectBraceSide = 'left';
        opening.objectBracePairIndex = 0;
        opening.objectBracePairCount = bracePairCount;
      }
      const closing = this.nodeByStableId(rightBraceStableIds[0]);
      if (closing) {
        closing.objectFamilyStableId = familyStableId;
        closing.objectBraceSide = 'right';
        closing.objectBracePairIndex = 0;
        closing.objectBracePairCount = bracePairCount;
      }
      rightBraceStableIds.forEach((rightBraceStableId, pairIndex) => {
        if (pairIndex !== 0) return;
        const rightBrace = this.nodeByStableId(rightBraceStableId);
        if (rightBrace) rightBrace.objectBraceMosaicNeighborStableId = mergeFieldsStableId;
      });
    }
    const exitsToArg: PendingExit[] = [];

    if (compactSingleFieldObject) {
      return {
        objectStableId,
        exitsToArg: [this.createPendingExit(undefined, mergeFieldsStableId, 'ArgJoin', 'object')],
      };
    }

    argument.properties.forEach((property, fieldIndex) => {
      const fieldName = this.getObjectFieldName(property, fieldIndex);
      const semanticFieldName = this.getObjectFieldSemanticName(property);
      const valueNode = this.getObjectFieldValueNode(property);
      const displayFieldName = this.getObjectFieldDisplayName(property, valueNode);
      const directFieldCall = ts.isExpression(valueNode) && ts.isCallExpression(unwrapExpression(valueNode))
        ? unwrapExpression(valueNode) as ts.CallExpression
        : undefined;
      const directFieldTarget = directFieldCall ? this.resolveRenderableCallTarget(directFieldCall) : undefined;
      const directFieldCallRole = directFieldCall ? this.getCallRole(directFieldCall, directFieldTarget) : undefined;
      const directFieldInvocation = directFieldCall
        ? this.callInvocationContract(directFieldCall)
        : undefined;
      const materializedFieldProducer = Boolean(
        directFieldCall
        && directFieldCallRole
        && this.callReturnsValue(directFieldCall, directFieldCallRole)
        && (
          this.isDeveloperSideCallExpression(directFieldCall, directFieldTarget)
          || directFieldInvocation?.invocationMode === 'asynchronous'
          || directFieldInvocation?.responseMode === 'awaited'
        )
      );
      const fieldHasJsx = containsJsxNode(valueNode);
      const displayValueNode = ts.isExpression(valueNode) ? unwrapExpression(valueNode) : valueNode;
      const fieldValueName = semanticFieldName || `${fieldName}Value`;
      const fieldDiaName = materializedFieldProducer
        ? fieldValueName
        : ts.isExpression(valueNode) && isFunctionArgumentExpression(valueNode)
        ? 'callback'
        : directFieldCall && directFieldTarget?.name
        ? `${directFieldTarget.name}()`
        : fieldHasJsx
        ? (jsxRootName(valueNode) || 'jsx')
        : displayValueNode.getText(this.sourceFile);
      const isStructuredFieldValue = ts.isExpression(valueNode) && isStructuredControlExpression(valueNode);
      const fieldPairIndex = expandedFieldFamily ? fieldBracePairIndex(fieldIndex) : -1;
      const fieldOpeningStableId = expandedFieldFamily ? leftBraceStableIds[fieldPairIndex] : objectStableId;
      const fieldClosingStableId = expandedFieldFamily ? rightBraceStableIds[fieldPairIndex] : mergeFieldsStableId;
      if (isStructuredFieldValue) {
        const result = this.runSuppressingHorizontalJoins(() => this.runInHorizontalFlow('Field', () => this.materializeExpressionValue(
          valueNode,
          [{
            fromKind: undefined,
            fromId: fieldOpeningStableId,
            edgeType: 'FIELD',
            label: fieldName,
            displayLabel: displayFieldName || '',
            mainFlow: false,
            fieldName: semanticFieldName,
            fieldIndex,
          }],
        )));
        if (result.pending.length > 1) {
          const rawDataJoinStableId = `${this.buildObjectFieldStableId(property, argumentIndex, fieldIndex)}:data-join`;
          const dataJoinStableId = this.createNode('DataJoin', 'data join', valueNode, {
            diaName: 'DataJoin',
            actionTextRaw: valueNode.getText(this.sourceFile),
            fieldName: semanticFieldName,
            fieldIndex,
            renderPartsJson: JSON.stringify([{
              stableId: rawDataJoinStableId,
              text: 'DataJoin',
              kind: 'operator',
              labels: ['DataJoin'],
              order: 0,
              sourceStableId: getExtendedStableId(this.sourceFile, valueNode),
            }] satisfies RenderPartDescriptor[]),
            renderPartsLayout: 'single',
          }, rawDataJoinStableId);
          result.pending.forEach((exit) => {
            const edgeType = exit.edgeType === 'TRUE' || exit.edgeType === 'FALSE'
              ? exit.edgeType
              : 'XOR_JOIN';
            this.addEdge(exit.fromKind, exit.fromId, undefined, dataJoinStableId, edgeType, {
              label: '',
              fieldName: semanticFieldName,
              fieldIndex,
              layoutFrame: 'horizontal',
              sourceRenderPartStableId: exit.sourceRenderPartStableId,
              targetRenderPartStableId: exit.targetRenderPartStableId,
            });
          });
          exitsToArg.push({
            fromKind: undefined,
            fromId: dataJoinStableId,
            edgeType: 'FieldJoin',
            label: fieldName,
            fieldName: semanticFieldName,
            fieldIndex,
          });
        } else {
          exitsToArg.push(...result.pending.map((exit) => ({
            ...exit,
            edgeType: 'FieldJoin' as FlowEdgeKind,
            label: fieldName,
            fieldName: semanticFieldName,
            fieldIndex,
          })));
        }
        this.connectPendingToNode(exitsToArg.splice(0), fieldClosingStableId);
        return;
      }
      const literalField = ts.isExpression(valueNode) && isLiteralInlineCallArgument(valueNode);
      const fieldStableId = this.createNode('Field', fieldName, valueNode, {
        labels: uniqueStrings([
          'Field',
          literalField ? 'Literal' : undefined,
          ...(materializedFieldProducer
            ? [
                'Value',
                'ValueSlot',
                'ValueCreate',
                'LocalBinding',
                'Assignment',
                'ContainerMethod',
                'Set',
                'Virtual',
              ]
            : directFieldCall && directFieldCallRole
            ? [
                ...this.callSiteLabels(directFieldCall, directFieldCallRole),
                ...this.callBoundaryLabels([...directFieldCall.arguments]),
              ]
            : []),
          fieldHasJsx ? 'VirtualView' : undefined,
          ...enclosingLabels,
        ].filter(Boolean) as string[]),
        diaName: fieldDiaName,
        operationSubjectText: fieldName,
        actionTextRaw: valueNode.getText(this.sourceFile),
        fieldName: semanticFieldName,
        fieldIndex,
        virtualViewKind: fieldHasJsx ? (jsxRootName(valueNode) || 'jsx') : undefined,
        ...(directFieldCall && !materializedFieldProducer ? this.callBoundaryExtra(directFieldCall, 'open') : {}),
        ...(materializedFieldProducer ? {
          containerState: 'awaiting-assignment' as const,
          containerMethodKind: 'set',
          nestedEvaluationDirection: 'down' as const,
          renderPartsLayout: 'container-overlay' as const,
          renderPrimaryPartIndex: 0,
          synthetic: true,
          renderPartsJson: JSON.stringify([
            {
              stableId: `${this.buildObjectFieldStableId(property, argumentIndex, fieldIndex)}:container`,
              text: fieldValueName,
              kind: 'value-container',
              labels: ['Value', 'ValueSlot', 'Virtual'],
              order: 0,
              fillState: 'empty',
              sourceStableId: getExtendedStableId(this.sourceFile, property),
            },
            {
              stableId: `${this.buildObjectFieldStableId(property, argumentIndex, fieldIndex)}:set`,
              text: 'set',
              kind: 'method',
              labels: ['Method', 'Assignment', 'ContainerMethod', 'Set', 'Virtual'],
              order: 1,
              sourceStableId: getExtendedStableId(this.sourceFile, property),
            },
          ] satisfies RenderPartDescriptor[]),
        } : {}),
      }, this.buildObjectFieldStableId(property, argumentIndex, fieldIndex));
      this.addEdge(undefined, fieldOpeningStableId, undefined, fieldStableId, 'FIELD', {
        label: fieldName,
        displayLabel: displayFieldName || '',
        fieldName: semanticFieldName,
        fieldIndex,
      });

      if (ts.isExpression(valueNode) && isFunctionArgumentExpression(valueNode)) {
        this.addEdge(undefined, fieldStableId, undefined, fieldClosingStableId, 'FieldJoin', {
          label: fieldName,
          fieldName: semanticFieldName,
          fieldIndex,
        });
        return;
      }

      if (directFieldCall) {
        if (materializedFieldProducer) {
          const callResult = this.materializeHorizontalCallExpression(
            directFieldCall,
            [this.createPendingExit(undefined, fieldStableId, 'EVAL', 'eval')],
            true,
          );
          const producerStableId = callResult.firstNodeId;
          const producer = producerStableId ? this.nodeByStableId(producerStableId) : undefined;
          if (producer && producerStableId) {
            producer.labels = uniqueStrings([...producer.labels, 'SubStep']);
            producer.submethodStableId = producerStableId;
            producer.submethodPlacement = 'axis';
            producer.submethodRelativeColumn = 0;
            producer.submethodRelativeRow = 0;
            producer.nestedEvaluationDirection = 'down';
            const invocation = this.callInvocationContract(directFieldCall);
            const evalEdge = this.edges.find((edge) => (
              edge.fromId === fieldStableId
              && edge.toId === producerStableId
              && edge.type === 'EVAL'
            ));
            if (evalEdge) {
              evalEdge.invocationMode = invocation.invocationMode;
              evalEdge.responseMode = invocation.responseMode;
            }
          }
          callResult.pending.forEach((exit) => {
            this.addEdge(exit.fromKind, exit.fromId, undefined, fieldStableId, 'YIELDS_VALUE', {
              label: 'value',
              displayLabel: 'value',
              diaName: 'value',
              semanticExpansion: 'primitive-execution',
              protocolRole: 'assignment-return',
              targetRenderPartStableId: `${fieldStableId}:set`,
            });
          });
          this.addEdge(undefined, fieldStableId, undefined, fieldClosingStableId, 'FieldJoin', {
            label: fieldName,
            fieldName: semanticFieldName,
            fieldIndex,
          });
        } else {
          this.addEdge(undefined, fieldStableId, undefined, fieldClosingStableId, 'FieldJoin', {
            label: fieldName,
            fieldName: semanticFieldName,
            fieldIndex,
          });
        }
        return;
      }

      collectCallExpressions(valueNode).forEach((nestedCall, nestedIndex) => {
        const nestedTarget = this.resolveRenderableCallTarget(nestedCall);
        const nestedDeveloperTarget = isCallableGraphTarget(nestedTarget);
        const nestedCallRole = this.getCallRole(nestedCall, nestedTarget);
        const nestedCallStableId = this.createNode(nestedCallRole === 'Request' ? 'Call' : 'Op', 'call', nestedCall, {
          labels: [nestedCallRole],
          diaName: formatCallDiaName(nestedCall, this.sourceFile),
          actionTextRaw: nestedCall.getText(this.sourceFile),
        }, this.buildNestedCallStableId(nestedCall, argumentIndex, (fieldIndex + 1) * 1000 + nestedIndex));
        this.addEdge(undefined, fieldStableId, undefined, nestedCallStableId, 'FIELD', {
          label: `${fieldName} call`,
          displayLabel: displayFieldName || '',
          fieldName: semanticFieldName,
          fieldIndex,
        });
        if (nestedDeveloperTarget) {
          this.addCallEdges(nestedCallStableId, nestedCall, nestedTarget, { edgeType: 'REQUEST' });
        }
      });

      this.addEdge(undefined, fieldStableId, undefined, fieldClosingStableId, 'FieldJoin', {
        label: fieldName,
        fieldName: semanticFieldName,
        fieldIndex,
      });
    });

    if (expandedFieldFamily && options.foldedCallBoundary) {
      this.addEdge(undefined, rightBraceStableIds[0], undefined, mergeFieldsStableId, 'ArgJoin', {
        label: argumentName || 'object',
        argumentName,
        argumentIndex,
        flowLayer: 'data',
      });
    }
    return {
      objectStableId,
      exitsToArg: [this.createPendingExit(undefined, mergeFieldsStableId, 'ArgJoin', 'object')],
    };
  }

  private materializeComputedArgumentValue(
    argumentStableId: string,
    callbackArgument: ts.ArrowFunction | ts.FunctionExpression,
    argumentName: string,
    incomingEdgeType: Extract<FlowEdgeKind, 'EVAL' | 'ARROW'> = 'EVAL',
  ) {
    const outcomes = this.materializeComputedArgumentOutcomes(
      argumentStableId,
      callbackArgument,
      argumentName,
      incomingEdgeType,
    );
    if (!outcomes) return undefined;

    const callbackResultStableId = this.createNode('OperandJoin', 'callback result', callbackArgument.body, {
      labels: ['Arg', 'Exclusive', 'CallbackResult', 'Result', 'FunctionEnd', 'Predicate'],
      diaName: 'x',
      callbackKind: 'predicate',
      joinKind: 'arg',
      mergeLabel: 'callback result',
      incomingEdgeTypes: 'TRUE,FALSE',
      synthetic: true,
    }, `${argumentStableId}:callback-result`);
    [outcomes.truthyStableId, outcomes.falsyStableId].forEach((outcomeStableId) => {
      this.addEdge(undefined, outcomeStableId, undefined, callbackResultStableId, 'XOR_JOIN', {
        label: 'callback result',
      });
    });
    return callbackResultStableId;
  }

  private materializeComputedArgumentOutcomes(
    argumentStableId: string,
    callbackArgument: ts.ArrowFunction | ts.FunctionExpression,
    argumentName: string,
    incomingEdgeType: Extract<FlowEdgeKind, 'EVAL' | 'ARROW'> = 'EVAL',
  ) {
    if (!callbackArgument.body || !ts.isExpression(callbackArgument.body)) return undefined;
    const expression = unwrapExpression(callbackArgument.body);
    if (!isBooleanLikeExpression(expression)) return undefined;

    const outcomes = this.createValueOutcomeNodes(callbackArgument.body, argumentStableId, argumentName, expression);
    const outcomeByKey = new Map(outcomes.map((outcome) => [outcome.key, outcome]));
    const incoming = [this.createPendingExit(
      undefined,
      argumentStableId,
      incomingEdgeType,
      incomingEdgeType === 'ARROW' ? 'arrow' : 'eval',
    )];

    if (isBooleanShortCircuitBinaryExpression(expression)) {
      const conditionFlow = this.runSuppressingHorizontalJoins(() => this.runInHorizontalFlow('Operand', () => this.materializeBooleanConditionFlow(expression, incoming)));
      const truthy = outcomeByKey.get('truthy');
      const falsy = outcomeByKey.get('falsy');
      if (truthy) this.connectValueResultExits(conditionFlow.trueExits, truthy.stableId, 'truthy', 'TRUE');
      if (falsy) this.connectValueResultExits(conditionFlow.falseExits, falsy.stableId, 'falsy', 'FALSE');
    } else {
      const result = this.runSuppressingHorizontalJoins(() => this.runInHorizontalFlow('Operand', () => this.materializeBooleanConditionOperand(
        expression,
        incoming,
      )));
      const truthy = outcomeByKey.get('truthy');
      const falsy = outcomeByKey.get('falsy');
      if (truthy) this.connectValueResultExits(result.trueExits, truthy.stableId, 'truthy', 'TRUE');
      if (falsy) this.connectValueResultExits(result.falseExits, falsy.stableId, 'falsy', 'FALSE');
    }

    const truthy = outcomeByKey.get('truthy');
    const falsy = outcomeByKey.get('falsy');
    if (!truthy || !falsy) return undefined;
    return {
      truthyStableId: truthy.stableId,
      falsyStableId: falsy.stableId,
    };
  }

  private materializeComputedArgumentPredicateExits(
    argumentStableId: string,
    callbackArgument: ts.ArrowFunction | ts.FunctionExpression,
    incomingEdgeType: Extract<FlowEdgeKind, 'EVAL' | 'ARROW' | 'NEXT' | 'TRUE'> = 'EVAL',
  ) {
    if (!callbackArgument.body) return undefined;
    let expression: ts.Expression;
    let incoming = [this.createPendingExit(
      undefined,
      argumentStableId,
      incomingEdgeType,
      incomingEdgeType === 'ARROW'
        ? 'arrow'
        : incomingEdgeType === 'EVAL'
          ? 'eval'
          : incomingEdgeType === 'TRUE'
            ? 'true'
            : '',
    )];
    if (ts.isBlock(callbackArgument.body)) {
      const statements = [...callbackArgument.body.statements];
      const finalStatement = statements.at(-1);
      if (
        !finalStatement
        || !ts.isReturnStatement(finalStatement)
        || !finalStatement.expression
      ) return undefined;
      expression = unwrapExpression(finalStatement.expression);
      for (const statement of statements.slice(0, -1)) {
        const result = this.buildStatement(statement, incoming, { hasLocalCatch: false });
        incoming = result.openExits;
      }
    } else {
      expression = unwrapExpression(callbackArgument.body);
    }
    const conditionFlow = isBooleanShortCircuitBinaryExpression(expression)
      ? this.runSuppressingHorizontalJoins(() => this.runInHorizontalFlow('Operand', () => (
          this.materializeBooleanConditionFlow(expression, incoming)
        )))
      : this.runSuppressingHorizontalJoins(() => this.runInHorizontalFlow('Operand', () => (
          this.materializeBooleanConditionOperand(expression, incoming)
        )));
    return {
      truthySourceStableIds: uniqueStrings(conditionFlow.trueExits.map((exit) => exit.fromId)),
      falsySourceStableIds: uniqueStrings(conditionFlow.falseExits.map((exit) => exit.fromId)),
    };
  }

  private createCallbackCompletionNode(
    callbackArgument: ts.ArrowFunction | ts.FunctionExpression,
    callbackKind: CallbackKind,
    callbackRootStableId: string,
    exits: PendingExit[],
  ) {
    const returnsValue = callbackKind !== 'consumer' && !this.callbackReturnsVoid(callbackArgument);
    const completionStableId = `${callbackRootStableId}:${returnsValue ? 'callback-result' : 'callback-end'}`;
    const createdStableId = this.createNode(returnsValue ? 'Value' : 'FunctionEnd', returnsValue ? 'callback result' : 'callback end', callbackArgument.body, {
      labels: uniqueStrings([
        ...this.callbackRoleLabels(callbackKind, callbackArgument).filter((label) => label !== 'CallbackFn' && label !== 'UpdaterFn'),
        returnsValue ? 'CallbackResult' : 'CallbackEnd',
        ...(returnsValue ? ['Result'] : []),
        'FunctionEnd',
      ]),
      diaName: returnsValue ? 'result' : 'end',
      callbackKind,
      actionTextRaw: callbackArgument.body.getText(this.sourceFile),
      synthetic: true,
    }, completionStableId);
    exits.forEach((exit) => {
      this.addEdge(
        exit.fromKind,
        exit.fromId,
        undefined,
        createdStableId,
        returnsValue ? 'RESULT' : 'NEXT',
        { label: returnsValue ? 'result' : undefined },
      );
    });
    return createdStableId;
  }

  private createArgumentNode(
    callExpression: ts.CallExpression,
    argument: ts.Expression,
    index: number,
    options: {
      preferExpressionDiaName?: boolean;
      ownerCallStableId?: string;
      foldObjectOpeningIntoOwner?: boolean;
      foldedCallBoundary?: {
        target: ResolvedCallTarget | undefined;
        callRoleLabel: 'Read' | 'Write' | 'Request' | 'Call' | 'Op';
        materializeReceiver: boolean;
      };
    } = {},
  ): {
    argStableId: string;
    exitsToArgs: PendingExit[];
    closesSingleArgumentCall?: boolean;
    omitFromCall?: boolean;
    rootEdgeAlreadyMaterialized?: boolean;
  } {
    const argStableId = this.buildArgumentStableId(argument, index);
    const parameterName = this.getParameterName(callExpression, index);
    const label = parameterName ? `arg ${index + 1}: ${parameterName}` : `arg ${index + 1}`;
    const callbackArgument = isFunctionArgumentExpression(argument) ? unwrapExpression(argument) as ts.ArrowFunction | ts.FunctionExpression : undefined;
    if (callbackArgument) {
      const callbackKind = this.callbackKindForArgument(callExpression, index);
      const callbackContract = this.callbackExecutionContract(callbackKind, callExpression);
      const suppressCallbackNode = this.suppressCallbackArgumentNodeDepth > 0
        || this.isInsideUpdaterCallback(callExpression)
        || callbackKind === 'updater';
      if (suppressCallbackNode) {
        const ownerStableId = this.contextualizeHorizontalStableId(
          getExtendedStableId(this.sourceFile, callExpression),
          callExpression,
        );
        const ownerMethod = (getCallLikeName(callExpression.expression) || '').split('.').pop();
        const firstBodyExpression = (() => {
          if (ts.isExpression(callbackArgument.body)) return callbackArgument.body;
          const firstStatement = callbackArgument.body.statements[0];
          return firstStatement && ts.isExpressionStatement(firstStatement)
            ? firstStatement.expression
            : undefined;
        })();
        const detachedAsyncBody = Boolean(
          firstBodyExpression
          && ts.isVoidExpression(firstBodyExpression),
        );
        const callbackIdentityStableId = this.contextualizeHorizontalStableId(argStableId, callbackArgument);
        const catchReceiver = ownerMethod === 'catch'
          && isPropertyAccessLikeExpression(unwrapExpression(callExpression.expression))
          ? unwrapExpression((unwrapExpression(callExpression.expression) as ts.PropertyAccessExpression).expression)
          : undefined;
        const catchReceiverCall = catchReceiver && ts.isCallExpression(catchReceiver)
          ? catchReceiver
          : undefined;
        const incomingStableId = catchReceiverCall
          ? this.contextualizeHorizontalStableId(
              getExtendedStableId(this.sourceFile, catchReceiverCall),
              catchReceiverCall,
            )
          : ownerStableId;
        const incomingEdgeType: FlowEdgeKind = ownerMethod === 'catch'
          ? 'CATCH'
          : detachedAsyncBody
            ? 'ASYNC'
            : 'NEXT';
        const callbackIncoming = callbackKind === 'updater'
          ? []
          : [this.createPendingExit(
              undefined,
              incomingStableId,
              incomingEdgeType,
              incomingEdgeType.toLowerCase(),
            )];
        this.suppressCallbackArgumentNodeDepth += 1;
        let callbackBody: ReturnType<FunctionFlowGraphBuilder['materializeImmediateCallbackBody']>;
        try {
          callbackBody = this.runInHorizontalFlow('Arg', () => this.materializeImmediateCallbackBody(
            {
              callback: callbackArgument,
              allowLocalReturn: true,
              callbackKind,
            },
            callbackIncoming,
          ));
        } finally {
          this.suppressCallbackArgumentNodeDepth -= 1;
        }
        if (callbackKind === 'updater') {
          this.materializeUpdaterStateProtocol(
            callExpression,
            callbackArgument,
            callbackIdentityStableId,
          );
        }
        return {
          argStableId: callbackBody.firstNodeId || ownerStableId,
          exitsToArgs: [],
          omitFromCall: true,
        };
      }
      const computedHere = callbackKind === 'predicate'
        && callbackArgument.body
        && ts.isExpression(callbackArgument.body)
        && isBooleanLikeExpression(unwrapExpression(callbackArgument.body));
      const createdArgStableId = this.createNode('Arg', label, argument, {
        labels: uniqueStrings([
          'Arg',
          ...this.callbackRoleLabels(callbackKind, callbackArgument),
          ...(callbackContract.asyncContract.startsWith('promise-') ? ['Async', 'Deferred'] : []),
          ...(computedHere ? ['ComputedValue', 'BooleanFlag'] : []),
        ]),
        diaName: this.callbackHeadDiaName(
          callbackArgument,
          computedHere ? `arg ${index + 1}` : (parameterName || callbackKind),
        ),
        operationSubjectText: parameterName,
        argumentName: parameterName,
        argumentIndex: index,
        actionTextRaw: argument.getText(this.sourceFile),
        callbackKind,
        callbackDeferred: callbackContract.callbackDeferred,
        callbackParameterNames: callbackArgument.parameters.map((parameter) => parameter.name.getText(this.sourceFile)),
        asyncSchedulerKind: callbackKind === 'updater' ? 'state-updater' : 'callback-argument',
        asyncContract: callbackContract.asyncContract,
        renderPartsJson: JSON.stringify([{
          stableId: argStableId,
          text: this.callbackHeadDiaName(callbackArgument, parameterName || callbackKind),
          kind: 'method',
          labels: ['Arg', 'CallbackFn'],
          order: 0,
          sourceStableId: getExtendedStableId(this.sourceFile, callbackArgument),
        } satisfies RenderPartDescriptor]),
        renderPartsLayout: 'single',
        renderPrimaryPartIndex: 0,
      }, argStableId);
      if (computedHere) this.materializeComputedArgumentValue(
        createdArgStableId,
        callbackArgument,
        parameterName || `arg ${index + 1}`,
        'ARROW',
      );
      const callbackBody = this.runInHorizontalFlow('Arg', () => this.materializeImmediateCallbackBody(
        {
          callback: callbackArgument,
          allowLocalReturn: true,
        },
        [this.createPendingExit(undefined, createdArgStableId, 'ARROW', 'arrow')],
      ));
      void callbackBody;
      if (callbackKind === 'updater') {
        this.materializeUpdaterStateProtocol(
          callExpression,
          callbackArgument,
          createdArgStableId,
        );
      }
      return {
        argStableId: createdArgStableId,
        exitsToArgs: [{
          ...this.createPendingExit(undefined, createdArgStableId, 'ArgJoin', `arg ${index + 1}`),
          argumentName: parameterName,
          argumentIndex: index,
        }],
      };
    }

    const argumentRoot = unwrapExpression(argument);
    const argumentValue = ts.isSpreadElement(argumentRoot)
      ? unwrapExpression(argumentRoot.expression)
      : argumentRoot;
    const nestedCalls = ts.isTemplateExpression(argumentRoot)
      ? []
      : collectCallExpressions(argument)
        .filter((nestedCallExpression) => nestedCallExpression !== argument);
    if (ts.isObjectLiteralExpression(argument)) {
      const objectEntry = this.createObjectNodes(
        argument,
        index,
        undefined,
        [],
        ['Arg'],
        parameterName,
        {
          openingOwnerStableId: options.foldObjectOpeningIntoOwner
            ? options.ownerCallStableId
            : undefined,
          foldedCallBoundary: options.foldedCallBoundary && options.ownerCallStableId
            ? {
                callExpression,
                callStableId: options.ownerCallStableId,
                ...options.foldedCallBoundary,
              }
            : undefined,
        },
      );
      return {
        argStableId: objectEntry.objectStableId,
        exitsToArgs: objectEntry.exitsToArg.map((exit) => ({
          ...exit,
          edgeType: 'ArgJoin' as FlowEdgeKind,
          label: `arg ${index + 1}`,
          argumentName: parameterName,
          argumentIndex: index,
        })),
      };
    }

    const structuredArgument = isStructuredControlExpression(argument);
    if (structuredArgument) {
      const result = this.runSuppressingHorizontalJoins(() => this.runInHorizontalFlow('Arg', () => this.materializeExpressionValue(
        argument,
        [],
      )));
      if (!result.firstNodeId) {
        throw new Error(`Structured argument did not produce a root node: ${argument.getText(this.sourceFile)}`);
      }
      return {
        argStableId: result.firstNodeId,
        exitsToArgs: result.pending.map((exit) => ({
          ...exit,
          edgeType: 'ArgJoin' as FlowEdgeKind,
          label: `arg ${index + 1}`,
          argumentName: parameterName,
          argumentIndex: index,
        })),
        closesSingleArgumentCall: true,
      };
    }

    if (ts.isCallExpression(argumentValue) && this.standardCollectionTransform(argumentValue)) {
      const transformResult = this.runInHorizontalFlow('Arg', () => (
        this.materializeCollectionTransformInitializer('', argumentValue, '', {
          incomingExits: [this.createPendingExit(
            undefined,
            options.ownerCallStableId || this.contextualizeHorizontalStableId(
              getExtendedStableId(this.sourceFile, callExpression),
              callExpression,
            ),
            'EVAL',
            'eval',
          )],
          allowDirectAssignment: false,
          compactProtocol: true,
          compactConsumerStableId: options.ownerCallStableId,
        })
      ));
      if (!transformResult) {
        throw new Error(`Collection argument did not produce a transform: ${argument.getText(this.sourceFile)}`);
      }
      if (ts.isSpreadElement(argumentRoot)) {
        const transform = this.standardCollectionTransform(argumentValue);
        const firstStage = transform?.stages[0];
        const sourceStableId = firstStage
          ? this.contextualizeHorizontalStableId(
              `${this.contextualizeHorizontalStableId(
                getExtendedStableId(this.sourceFile, firstStage.callExpression),
                firstStage.callExpression,
              )}:receiver`,
              transform.receiver,
            )
          : undefined;
        const sourceNode = sourceStableId ? this.nodeByStableId(sourceStableId) : undefined;
        if (sourceNode) {
          const parts = JSON.parse(sourceNode.renderPartsJson || '[]') as RenderPartDescriptor[];
          const sourceText = String(
            parts[0]?.text
            || sourceNode.operationSubjectText
            || sourceNode.actionTextRaw
            || 'collection',
          );
          const spreadSourceText = sourceText.startsWith('...') ? sourceText : `...${sourceText}`;
          sourceNode.operationSubjectText = spreadSourceText;
          if (parts[0]) parts[0].text = spreadSourceText;
          sourceNode.renderPartsJson = JSON.stringify(parts);
        }
      }
      return {
        argStableId: transformResult.firstNodeId,
        exitsToArgs: [{
          ...this.createPendingExit(undefined, transformResult.resultNodeId, 'ArgJoin', `arg ${index + 1}`),
          argumentName: parameterName,
          argumentIndex: index,
        }],
        closesSingleArgumentCall: true,
        rootEdgeAlreadyMaterialized: true,
      };
    }

    if (ts.isCallExpression(argumentValue)) {
      const nestedTarget = this.resolveRenderableCallTarget(argumentValue);
      const nestedCallRole = this.getCallRole(argumentValue, nestedTarget);
      const nestedCallStableId = this.createNode(this.callNodeKind(argumentValue, nestedCallRole), 'call', argumentValue, {
        labels: uniqueStrings([
          'Arg',
          ...this.callSiteLabels(argumentValue, nestedCallRole),
          ...this.callBoundaryLabels([...argumentValue.arguments]),
        ]),
        diaName: formatCallDiaName(argumentValue, this.sourceFile),
        actionTextRaw: argumentValue.getText(this.sourceFile),
        argumentName: parameterName,
        argumentIndex: index,
        ...this.callBoundaryExtra(argumentValue, 'open'),
      }, this.buildNestedCallStableId(argumentValue, index, 0));
      const nestedCallResult = this.materializeCallArgumentsToProxy(
        argumentValue,
        nestedCallStableId,
        nestedTarget,
        nestedCallRole,
        { suppressResultNode: true },
      );
      return {
        argStableId: nestedCallStableId,
        exitsToArgs: nestedCallResult.pending.map((exit) => ({
          ...exit,
          edgeType: 'ArgJoin' as FlowEdgeKind,
          label: `arg ${index + 1}`,
          argumentName: parameterName,
          argumentIndex: index,
        })),
      };
    }

    const argumentHasJsx = containsJsxNode(argument);
    const bindingStableId = this.bindingStableIdForExpression(argument);
    const createdArgStableId = this.createNode('Arg', label, argument, {
      labels: uniqueStrings([
        'Arg',
        'ArgumentOccurrence',
        'ExecutionOccurrence',
        ...(isLiteralInlineCallArgument(argumentValue) ? ['Literal'] : []),
        ...(bindingStableId ? ['ValueRead', 'ValuePass'] : []),
        ...(argumentHasJsx ? ['VirtualView'] : []),
        ...(this.isCollectionExpression(argumentValue) ? ['Collection'] : []),
      ]),
      diaName: unwrapExpression(argument).getText(this.sourceFile),
      operationSubjectText: parameterName,
      argumentName: parameterName,
      argumentIndex: index,
      actionTextRaw: argument.getText(this.sourceFile),
      bindingStableId,
      canonicalStableId: bindingStableId,
      flowLayer: 'data',
      dataFlowRole: 'input',
      virtualViewKind: argumentHasJsx ? (jsxRootName(argument) || 'jsx') : undefined,
    }, argStableId);

    let lastArgumentFlowStableId = createdArgStableId;
    const nestedCallStableIds = new Map<ts.CallExpression, string>();
    nestedCalls.forEach((nestedCall, nestedIndex) => {
      const nestedTarget = this.resolveRenderableCallTarget(nestedCall);
      const nestedCallRole = this.getCallRole(nestedCall, nestedTarget);
      const nestedCallStableId = this.createNode(this.callNodeKind(nestedCall, nestedCallRole), 'call', nestedCall, {
        labels: uniqueStrings([
          'Arg',
          ...this.callSiteLabels(nestedCall, nestedCallRole),
          ...this.callBoundaryLabels([...nestedCall.arguments]),
        ]),
        diaName: formatCallDiaName(nestedCall, this.sourceFile),
        actionTextRaw: nestedCall.getText(this.sourceFile),
        ...this.callBoundaryExtra(nestedCall, 'open'),
      }, this.buildNestedCallStableId(nestedCall, index, nestedIndex));
      nestedCallStableIds.set(nestedCall, nestedCallStableId);
      this.addEdge(undefined, lastArgumentFlowStableId, undefined, nestedCallStableId, 'NEXT', {
        label: `arg ${index + 1} call`,
        renderHidden: ts.isTemplateExpression(argumentRoot),
        semanticExpansion: ts.isTemplateExpression(argumentRoot) ? 'expression-mosaic' : undefined,
      });
      const nestedCallResult = this.materializeCallArgumentsToProxy(
        nestedCall,
        nestedCallStableId,
        nestedTarget,
        nestedCallRole,
        { suppressResultNode: true },
      );
      lastArgumentFlowStableId = nestedCallResult.pending[0]?.fromId || nestedCallStableId;
    });
    if (nestedCalls.length) {
      return {
        argStableId: createdArgStableId,
        exitsToArgs: [{
          ...this.createPendingExit(undefined, lastArgumentFlowStableId, 'ArgJoin', `arg ${index + 1}`),
          argumentName: parameterName,
          argumentIndex: index,
        }],
      };
    }

    return {
      argStableId: createdArgStableId,
      exitsToArgs: [{
        ...this.createPendingExit(undefined, createdArgStableId, 'ArgJoin', `arg ${index + 1}`),
        argumentName: parameterName,
        argumentIndex: index,
      }],
    };
  }

  private buildStandaloneCallWithArgumentChain(
    statement: ts.Statement,
    incomingExits: PendingExit[],
    shouldMaterializeStep = false,
  ): BuildResult | undefined {
    const callExpression = getStandaloneCallExpression(statement);
    if (!callExpression) {
      return undefined;
    }

    const args = [...callExpression.arguments].map((argument, index) => ({
      argument,
      index,
      hasNestedCalls: collectCallExpressions(argument).some((nestedCall) => nestedCall !== argument),
    }));
    if (!args.length) {
      return undefined;
    }

    const target = this.resolveRenderableCallTarget(callExpression);
    const callRoleLabel = this.getCallRole(callExpression, target);
    const callStableId = this.createNode(this.callNodeKind(callExpression, callRoleLabel), 'call', callExpression, {
      labels: uniqueStrings([
        ...this.callSiteLabels(callExpression, callRoleLabel),
        ...this.callBoundaryLabels(args.map(({ argument }) => argument)),
      ]),
      diaName: formatCallDiaName(callExpression, this.sourceFile),
      actionTextRaw: callExpression.getText(this.sourceFile),
      ...this.callStartEffectExtra(callExpression),
      ...this.callBoundaryExtra(callExpression, 'open'),
      uiSlotName: this.isUiInjectionCall(callExpression) ? (getCallLikeName(callExpression.expression) || 'ui') : undefined,
    });
    this.registerFirstNode(callStableId, incomingExits);
    this.connectPendingToNode(incomingExits, callStableId);

    this.materializeCallArgumentsToProxy(
      callExpression,
      callStableId,
      target,
      callRoleLabel,
      { suppressResultNode: true },
    );

    return {
      firstNodeId: callStableId,
      openExits: shouldMaterializeStep
        ? []
        : [this.createPendingExit(undefined, callStableId, 'NEXT')],
      pendingBreaks: [],
      pendingContinues: [],
      pendingThrows: [],
    };
  }

  private buildStandaloneCallStatement(
    statement: ts.Statement,
    incomingExits: PendingExit[],
    shouldMaterializeStep = false,
  ): BuildResult | undefined {
    const callWithArgs = this.buildStandaloneCallWithArgumentChain(statement, incomingExits, shouldMaterializeStep);
    if (callWithArgs) {
      return callWithArgs;
    }

    const callExpression = getStandaloneCallExpression(statement);
    if (!callExpression) {
      return undefined;
    }

    const target = this.resolveRenderableCallTarget(callExpression);
    const callRoleLabel = this.getCallRole(callExpression, target);
    const callStableId = this.createNode(this.callNodeKind(callExpression, callRoleLabel), 'call', callExpression, {
      labels: uniqueStrings([
        ...this.callSiteLabels(callExpression, callRoleLabel),
        'Start',
      ]),
      diaName: formatCallDiaName(callExpression, this.sourceFile),
      actionTextRaw: callExpression.getText(this.sourceFile),
      ...this.callStartEffectExtra(callExpression),
      ...this.callBoundaryExtra(callExpression, 'open'),
      uiSlotName: this.isUiInjectionCall(callExpression) ? (getCallLikeName(callExpression.expression) || 'ui') : undefined,
      ...this.buildReactStateUpdateExtra(callExpression),
    });
    this.registerFirstNode(callStableId, incomingExits);
    this.connectPendingToNode(incomingExits, callStableId);
    const callResult = this.materializeCallArgumentsToProxy(
      callExpression,
      callStableId,
      target,
      callRoleLabel,
      { suppressResultNode: true },
    );

    return {
      firstNodeId: callStableId,
      openExits: shouldMaterializeStep
        ? []
        : callRoleLabel === 'Call'
          ? [this.createPendingExit(undefined, callStableId, 'NEXT')]
          : callResult.pending,
      pendingBreaks: [],
      pendingContinues: [],
      pendingThrows: [],
    };
  }

  private buildTerminalStandaloneCallStatement(statement: ts.Statement, incomingExits: PendingExit[]): BuildResult | undefined {
    const standaloneCallResult = this.buildStandaloneCallStatement(statement, incomingExits, true);
    if (!standaloneCallResult) {
      return undefined;
    }

    return {
      openExits: [],
      pendingBreaks: [],
      pendingContinues: [],
      pendingThrows: [],
    };
  }

  private materializeIndexedArrayAssignment(statement: ts.Statement, incomingExits: PendingExit[]): BuildResult | undefined {
    if (!ts.isExpressionStatement(statement)) return undefined;
    const expression = unwrapExpression(statement.expression);
    if (!isSimpleAssignmentExpression(expression)) return undefined;
    const target = unwrapExpression(expression.left);
    if (!ts.isElementAccessExpression(target) || !target.argumentExpression) return undefined;
    const isArray = (value: ts.Expression) => {
      const type = this.checker.getTypeAtLocation(value);
      return this.checker.isArrayType(type) || this.checker.isTupleType(type);
    };
    const simple = (value: ts.Expression) => ts.isIdentifier(unwrapExpression(value))
      || ts.isPropertyAccessExpression(unwrapExpression(value))
        && ts.isIdentifier((unwrapExpression(value) as ts.PropertyAccessExpression).expression)
      || isLiteralInlineCallArgument(unwrapExpression(value));
    // Complex receivers/indices keep their existing evaluation-order expansion.
    if (!isArray(target.expression) || !simple(target.expression) || !simple(target.argumentExpression)) return undefined;
    const value = unwrapExpression(expression.right);
    const indexedRead = ts.isElementAccessExpression(value) && value.argumentExpression
      && isArray(value.expression) && simple(value.expression) && simple(value.argumentExpression) ? value : undefined;
    if (!indexedRead && !simple(value)) return undefined;
    const assignmentId = getExtendedStableId(this.sourceFile, statement);
    const valueId = getExtendedStableId(this.sourceFile, value);
    const partsForAccess = (access: ts.ElementAccessExpression, owner: string, write: boolean): RenderPartDescriptor[] => [
      { stableId: `${owner}:container`, text: access.expression.getText(this.sourceFile), kind: 'collection-container',
        labels: ['Value', 'Variable', 'Collection'], order: 0, fillState: 'filled', sourceStableId: getExtendedStableId(this.sourceFile, access.expression) },
      { stableId: `${owner}:${write ? 'set' : 'get'}`, text: write ? 'setAt(' : '[', kind: 'method',
        labels: ['Method', write ? 'Virtual' : 'System', write ? 'Set' : 'IndexedRead'], order: 1, sourceStableId: getExtendedStableId(this.sourceFile, access) },
      { stableId: `${owner}:index`, text: access.argumentExpression!.getText(this.sourceFile), kind: 'value',
        labels: ['Value', 'ValueAccess'], order: 2, sourceStableId: getExtendedStableId(this.sourceFile, access.argumentExpression!) },
      { stableId: `${owner}:close`, text: write ? ')' : ']', kind: 'method',
        labels: write ? ['Method', 'Virtual', 'CallBoundary'] : ['Method', 'System', 'IndexedRead', 'CallBoundary'], order: 3, sourceStableId: getExtendedStableId(this.sourceFile, access) },
    ];
    const assignment = this.createActionNodeFromStatements([statement], incomingExits, undefined, {
      labels: ['Value', 'Collection', 'Assignment', 'ContainerMethod', 'Set', 'IndexedWrite', 'Call'],
      diaName: target.expression.getText(this.sourceFile), containerState: 'filled', containerMethodKind: 'set',
      callBoundaryDesign: 'split', callBoundaryRole: 'open', callHasArguments: true,
      renderPartsLayout: 'container-overlay-side', renderPrimaryPartIndex: 0,
      renderPartsJson: JSON.stringify(partsForAccess(target, assignmentId, true).slice(0, 2)),
    });
    const closeId = `${assignmentId}:complete`;
    this.createNode('FnVisualProxy', 'indexed write complete', statement, {
      labels: ['VisualProxy', 'FnVisualProxy', 'Arg', 'Join', 'Call', 'Method', 'Virtual'],
      diaName: ')', synthetic: true, sourceCallStableId: assignmentId,
      callBoundaryDesign: 'split', callBoundaryRole: 'close', callBoundaryPeerStableId: assignmentId,
      renderPartsLayout: 'single', renderPrimaryPartIndex: 0,
      renderPartsJson: JSON.stringify([{ stableId: closeId, text: ')', kind: 'method',
        labels: ['Method', 'Virtual', 'CallBoundary'], order: 0 }]),
    }, closeId);
    assignment.callBoundaryPeerStableId = closeId;
    const indexId = this.createNode('Arg', 'index argument', target.argumentExpression, {
      labels: ['Value', 'ValueAccess'], diaName: target.argumentExpression.getText(this.sourceFile), argumentIndex: 0,
    });
    const slotId = indexedRead ? `${assignmentId}:value-slot` : valueId;
    this.createNode('Arg', 'value argument', value, {
      labels: indexedRead ? ['Value', 'Variable', 'Virtual', 'ResultTarget', 'ContainerMethod', 'Set'] : ['Value', 'ValueAccess'],
      diaName: indexedRead ? '' : value.getText(this.sourceFile), argumentIndex: 1,
      ...(indexedRead ? { synthetic: true, containerState: 'empty' as const,
        renderPartsLayout: 'container-overlay-side' as const, renderPrimaryPartIndex: 0,
        renderPartsJson: JSON.stringify([
          { stableId: slotId, text: '', kind: 'value-container', labels: ['Value', 'Variable', 'Virtual'], fillState: 'empty', order: 0 },
          { stableId: `${slotId}:set`, text: 'set', kind: 'method', labels: ['Method', 'Virtual', 'Set'], order: 1 },
        ]) } : {}),
    }, slotId);
    [indexId, slotId].forEach((id, argumentIndex) => {
      const argumentName = argumentIndex === 0 ? 'index' : 'value';
      this.addEdge(undefined, assignmentId, undefined, id, 'ARG', {
        label: argumentName, displayLabel: argumentName, argumentName, argumentIndex,
        flowLayer: 'data', sourceRenderPartStableId: `${assignmentId}:set`,
      });
      this.addEdge(undefined, id, undefined, closeId, 'ArgJoin', {
        label: '', argumentIndex, flowLayer: 'data', callSiteStableId: assignmentId,
      });
    });
    if (indexedRead) {
      const producer = this.createNode('Op', 'indexed assignment value', value, {
        labels: ['Value', 'Collection', 'IndexedRead', 'ContainerMethod'],
        diaName: indexedRead.expression.getText(this.sourceFile), containerState: 'filled',
        renderPartsLayout: 'container-overlay-side', renderPrimaryPartIndex: 0,
        renderPartsJson: JSON.stringify(partsForAccess(indexedRead, valueId, false)),
      });
      this.addEdge(undefined, slotId, undefined, producer, 'EVAL', {
        label: 'eval', displayLabel: 'eval', flowLayer: 'mixed', oneWay: true,
        sourceRenderPartStableId: `${assignmentId}:container`,
        targetRenderPartStableId: `${valueId}:container`,
        sourcePort: 'right', targetPort: 'left',
        sourcePortCandidates: ['right'], targetPortCandidates: ['left'], lockPortCandidates: true,
      });
      this.addEdge(undefined, producer, undefined, slotId, 'ASSIGNS_VALUE', {
        label: 'value', displayLabel: 'value', flowLayer: 'data',
        producerRouteRole: 'return-bottom', protocolRole: 'assignment-return',
        sourcePort: 'bottom', targetPort: 'bottom',
        sourcePortCandidates: ['bottom'], targetPortCandidates: ['bottom'], lockPortCandidates: true,
        targetRenderPartStableId: `${slotId}:set`, sourceRenderPartStableId: `${valueId}:close`,
      });
    }
    return { firstNodeId: assignment.stableId, openExits: [{
      ...this.createPendingExit(undefined, closeId, 'NEXT'),
      sourceRenderPartStableId: `${assignmentId}:container`,
    }],
      pendingBreaks: [], pendingContinues: [], pendingThrows: [] };
  }

  private materializeLinearStatement(statement: ts.Statement, incomingExits: PendingExit[]): BuildResult {
    if (ts.isExpressionStatement(statement) && isSimpleAssignmentExpression(statement.expression)
      && ts.isPropertyAccessExpression(statement.expression.left) && ts.isIdentifier(statement.expression.left.expression)
      && ts.isElementAccessExpression(statement.expression.right)) {
      const { left, right } = statement.expression;
      const index = right.argumentExpression;
      const arrayType = this.checker.getTypeAtLocation(right.expression);
      if (ts.isIdentifier(right.expression) && index
        && (ts.isIdentifier(index) || ts.isPropertyAccessExpression(index) && ts.isIdentifier(index.expression))
        && (this.checker.isArrayType(arrayType) || this.checker.isTupleType(arrayType))) {
        const id = getExtendedStableId(this.sourceFile, statement.expression);
        const producer = getExtendedStableId(this.sourceFile, right);
        this.createNode('Value', 'assign field', statement.expression, {
          labels: ['Value', 'Variable', 'ValueWrite', 'FieldWrite', 'Assignment', 'ContainerMethod', 'Set'],
          diaName: left.getText(this.sourceFile), containerState: 'filled', containerMethodKind: 'set',
          operationSubjectText: left.getText(this.sourceFile), operationValueText: right.getText(this.sourceFile),
          renderPartsLayout: 'container-overlay', renderPrimaryPartIndex: 0,
          renderPartsJson: JSON.stringify([
            { stableId: `${id}:container`, text: left.getText(this.sourceFile), kind: 'value-container', labels: ['Value', 'Variable', 'ValueWrite'], fillState: 'filled', order: 0 },
            { stableId: `${id}:set`, text: 'set', kind: 'method', labels: ['Method', 'Virtual', 'Set'], order: 1 },
          ]),
        }, id);
        this.createNode('Op', 'indexed field value', right, {
          labels: ['Value', 'Collection', 'IndexedRead', 'ContainerMethod'], diaName: right.expression.text,
          containerState: 'filled', renderPartsLayout: 'container-overlay-side', renderPrimaryPartIndex: 0,
          renderPartsJson: JSON.stringify([
            { stableId: `${producer}:container`, text: right.expression.text, kind: 'collection-container', labels: ['Value', 'Collection'], fillState: 'filled', order: 0 },
            { stableId: `${producer}:get`, text: '[', kind: 'method', labels: ['Method', 'System', 'IndexedRead'], order: 1 },
            ...JSON.parse(this.buildRenderParts(index, `${producer}:index`)?.json || JSON.stringify([
              { stableId: `${producer}:index`, text: index.getText(this.sourceFile), kind: 'value', labels: ['Value', 'ValueRead'] },
            ])),
            { stableId: `${producer}:close`, text: ']', kind: 'method', labels: ['Method', 'System', 'IndexedRead', 'CallBoundary'] },
          ].map((part, order) => ({ ...part, order }))),
        }, producer);
        this.connectPendingToNode(incomingExits, id);
        this.addEdge(undefined, id, undefined, producer, 'EVAL', {
          label: 'eval', displayLabel: 'eval', flowLayer: 'mixed', oneWay: true,
          sourceRenderPartStableId: `${id}:container`, targetRenderPartStableId: `${producer}:container`,
          sourcePort: 'right', targetPort: 'left', sourcePortCandidates: ['right'], targetPortCandidates: ['left'], lockPortCandidates: true,
        });
        this.addEdge(undefined, producer, undefined, id, 'ASSIGNS_VALUE', {
          label: 'value', displayLabel: 'value', flowLayer: 'data', protocolRole: 'assignment-return',
          producerRouteRole: 'return-bottom', sourceRenderPartStableId: `${producer}:close`, targetRenderPartStableId: `${id}:set`,
          sourcePort: 'bottom', targetPort: 'bottom', sourcePortCandidates: ['bottom'], targetPortCandidates: ['bottom'], lockPortCandidates: true,
        });
        return { ...buildEmptyResult(), firstNodeId: id, openExits: [this.createPendingExit(undefined, id, 'NEXT')] };
      }
    }
    if (ts.isExpressionStatement(statement) && isSimpleAssignmentExpression(statement.expression)
      && ts.isIdentifier(statement.expression.left) && ts.isObjectLiteralExpression(statement.expression.right)) {
      const { left, right } = statement.expression;
      const declaration = this.checker.getSymbolAtLocation(left)?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration)) {
        const id = getExtendedStableId(this.sourceFile, statement.expression);
        this.createNode('Value', 'assign object', statement.expression, {
          labels: ['Value', 'Variable', 'ValueWrite'], diaName: left.text,
          operationSubjectText: left.text, operationValueText: right.getText(this.sourceFile),
        }, id);
        this.connectPendingToNode(incomingExits, id);
        const assignment = this.createAssignmentPrimitive(declaration, id, right, left);
        this.materializeConstInitializerValue(declaration, id, right, assignment);
        const container = this.nodeByStableId(id)!;
        container.labels = uniqueStrings([...(container.labels || []).filter(label => label !== 'ValueCreate'), 'ValueWrite']);
        return { ...buildEmptyResult(), firstNodeId: id, openExits: [this.createPendingExit(undefined, id, 'NEXT')] };
      }
    }
    const indexedAssignment = this.materializeIndexedArrayAssignment(statement, incomingExits);
    if (indexedAssignment) return indexedAssignment;
    if (ts.isVariableStatement(statement)) {
      const localFunctionResult = this.materializeLocalFunctionDeclaration(statement, incomingExits);
      if (localFunctionResult) {
        return localFunctionResult;
      }
    }

    const continuationRunResult = this.materializeContinuationRunStatement(statement, incomingExits);
    if (continuationRunResult) {
      return continuationRunResult;
    }

    const standaloneCallResult = this.buildStandaloneCallStatement(
      statement,
      incomingExits,
      false,
    );
    if (standaloneCallResult) {
      return standaloneCallResult;
    }

    if (this.shouldMaterializeConstVariableStatement(statement)) {
      return this.materializeConstVariableStatement(statement, incomingExits);
    }

    let firstNodeId: string | undefined;
    let pending = [...incomingExits];

    const structuredRoots = this.collectStructuredExpressionRoots(statement);
    for (const rootExpression of structuredRoots) {
      const structuredResult = this.materializeExpressionValue(rootExpression, pending, true);
      if (!firstNodeId && structuredResult.firstNodeId) {
        firstNodeId = structuredResult.firstNodeId;
      }
      pending = structuredResult.pending;
    }

    const expressions = filterExpressionsCoveredByStructuredExpressions(collectMaterializedExpressions(statement)).filter((expression) => {
      return !structuredRoots.some((rootExpression) => {
        const root = unwrapExpression(rootExpression);
        return expression.getStart(this.sourceFile) >= root.getStart(this.sourceFile)
          && expression.getEnd() <= root.getEnd();
      });
    });

    if (expressions.length) {
      const expressionSteps = this.materializeExpressionSteps(expressions, pending);
      firstNodeId = expressionSteps.firstNodeId;
      pending = expressionSteps.pending;
    }

    const assignedFunctionTarget = this.buildAssignedFunctionTarget(statement);
    const rawExpressionStatement = ts.isExpressionStatement(statement)
      ? statement.expression
      : undefined;
    const expressionStatement = rawExpressionStatement
      ? unwrapExpression(rawExpressionStatement)
      : undefined;
    const isStructuredVariableContainer = ts.isVariableStatement(statement)
      && !assignedFunctionTarget
      && Boolean(structuredRoots.length || expressions.length);
    const shouldSkipStatementNode = Boolean(
      (structuredRoots.length || expressions.length)
      && (
        isStructuredVariableContainer
        || (
          expressionStatement
          && !isSimpleAssignmentExpression(expressionStatement)
        )
      ),
    );

    const existingVariableAssignment = expressionStatement
      && isSimpleAssignmentExpression(expressionStatement)
      && ts.isIdentifier(unwrapExpression(expressionStatement.left))
      && (
        ts.isIdentifier(unwrapExpression(expressionStatement.right))
        || isLiteralInlineCallArgument(unwrapExpression(expressionStatement.right))
      )
      ? expressionStatement
      : undefined;

    if (shouldSkipStatementNode) {
      return {
        firstNodeId,
        openExits: pending,
        pendingBreaks: [],
        pendingContinues: [],
        pendingThrows: [],
      };
    }

    const actionNode = this.createActionNodeFromStatements(
      [statement],
      pending,
      undefined,
      {
        ...(assignedFunctionTarget?.stableId ? {
          calleeStableId: assignedFunctionTarget.stableId,
          calleeName: assignedFunctionTarget.name,
        } : {}),
        ...(existingVariableAssignment ? (() => {
          const target = unwrapExpression(existingVariableAssignment.left) as ts.Identifier;
          const value = unwrapExpression(existingVariableAssignment.right);
          const literalValue = isLiteralInlineCallArgument(value);
          const valueText = value.getText(this.sourceFile);
          const assignmentStableId = getExtendedStableId(this.sourceFile, existingVariableAssignment);
          return {
            labels: ['Value', 'Variable', 'Assignment', 'ContainerMethod', 'Set'],
            diaName: target.text,
            operationSubjectText: target.text,
            operationValueText: valueText,
            containerState: literalValue ? 'awaiting-assignment' as const : 'filled' as const,
            containerMethodKind: 'set',
            renderPartsLayout: 'container-overlay-side' as const,
            renderPrimaryPartIndex: 0,
            renderPartsJson: JSON.stringify([
              {
                stableId: `${assignmentStableId}:target`,
                text: target.text,
                kind: 'value-container',
                labels: ['Value', 'Variable', 'ValueSlot'],
                order: 0,
                fillState: literalValue ? 'empty' : 'filled',
                sourceStableId: getExtendedStableId(this.sourceFile, target),
              },
              {
                stableId: `${assignmentStableId}:set`,
                text: 'set(',
                kind: 'method',
                labels: ['Assignment', 'ContainerMethod', 'Method', 'Set', 'Virtual'],
                order: 1,
                sourceStableId: getExtendedStableId(this.sourceFile, existingVariableAssignment.operatorToken),
              },
              {
                stableId: `${assignmentStableId}:value`,
                text: valueText,
                kind: literalValue ? 'literal' : 'value',
                labels: literalValue ? ['Value', 'Literal'] : ['Value', 'Variable', 'ValueRead'],
                order: 2,
                fillState: 'filled',
                sourceStableId: getExtendedStableId(this.sourceFile, value),
              },
              {
                stableId: `${assignmentStableId}:set-close`,
                text: ')',
                kind: 'punctuation',
                labels: ['Assignment', 'CallBoundary', 'ContainerMethod', 'Method', 'Set', 'Virtual'],
                order: 3,
                sourceStableId: getExtendedStableId(this.sourceFile, existingVariableAssignment),
              },
            ] satisfies RenderPartDescriptor[]),
          };
        })() : {}),
      },
    );
    if (assignedFunctionTarget?.stableId) {
      this.addEdge(
        undefined,
        actionNode.stableId,
        'Fn',
        assignedFunctionTarget.stableId,
        'SUBSCRIBE',
        {
          label: shortenLabel(statement.getText(this.sourceFile)),
        },
      );
    }
    const nestedCallbackResult = this.materializeImmediateCallbackBodies(
      this.getImmediateCallbackCarrierExpression(statement),
      [this.createPendingExit(undefined, actionNode.stableId, 'NEXT')],
    );

    return {
      firstNodeId: firstNodeId || actionNode.stableId,
      openExits: nestedCallbackResult.firstNodeId
        ? nestedCallbackResult.pending
        : [this.createPendingExit(undefined, actionNode.stableId, 'NEXT')],
      pendingBreaks: [],
      pendingContinues: [],
      pendingThrows: [],
    };
  }

  private materializeBufferedStatements(
    statements: ts.Statement[],
    incomingExits: PendingExit[],
    executionSegmentState?: {
      context?: FlowStepContext;
      forceExecution?: boolean;
    },
  ): BuildResult {
    if (!statements.length) {
      return buildEmptyResult();
    }

    let firstNodeId: string | undefined;
    let pending = [...incomingExits];

    for (const statement of statements) {
      if (!this.collectStructuredExpressionRoots(statement).length) {
        const statementResult = this.runInStatementFlowStep(
          statement,
          () => this.materializeLinearStatement(statement, pending),
          executionSegmentState,
        );
        if (!firstNodeId && statementResult.firstNodeId) {
          firstNodeId = statementResult.firstNodeId;
        }
        pending = statementResult.openExits;
        continue;
      }

      const statementResult = this.runInStatementFlowStep(
        statement,
        () => this.materializeLinearStatement(statement, pending),
        executionSegmentState,
      );
      if (!firstNodeId && statementResult.firstNodeId) {
        firstNodeId = statementResult.firstNodeId;
      }
      pending = statementResult.openExits;
    }

    return {
      firstNodeId,
      openExits: pending,
      pendingBreaks: [],
      pendingContinues: [],
      pendingThrows: [],
    };
  }

  private buildReturnStatement(statement: ts.ReturnStatement, incomingExits: PendingExit[]): BuildResult {
    if (statement.expression && ts.isIdentifier(unwrapExpression(statement.expression))) {
      const id = this.createReturnNode(statement, true);
      this.connectPendingToNode(incomingExits, id);
      this.captureCallbackReturn(id);
      return { ...buildEmptyResult(), firstNodeId: id };
    }
    if (statement.expression) {
      const rootExpression = unwrapExpression(statement.expression);
      let firstNodeId: string | undefined;
      let pending = [...incomingExits];
      const shouldMaterializeReturnValueStep = !ts.isCallExpression(rootExpression)
        && !isJsxLikeExpression(rootExpression)
        && !ts.isConditionalExpression(rootExpression)
        && !isShortCircuitBinaryExpression(rootExpression);
      const shouldMaterializeNonTrivialReturnValueStep = shouldMaterializeReturnValueStep
        && !isTrivialLiteralExpression(rootExpression);

      if (shouldMaterializeNonTrivialReturnValueStep) {
        const expressionNode = this.createActionNodeFromExpression(statement.expression, incomingExits);
        firstNodeId = expressionNode.stableId;
        const nestedCallbackResult = this.materializeImmediateCallbackBodies(
          statement.expression,
          [this.createPendingExit(undefined, expressionNode.stableId, 'NEXT')],
        );
        pending = nestedCallbackResult.firstNodeId
          ? nestedCallbackResult.pending
          : [this.createPendingExit(undefined, expressionNode.stableId, 'NEXT')];
      }

      const expressionSteps = shouldMaterializeNonTrivialReturnValueStep
        ? { firstNodeId: undefined, pending }
        : this.materializeExpressionValue(statement.expression, pending);
      if (!firstNodeId && expressionSteps.firstNodeId) {
        firstNodeId = expressionSteps.firstNodeId;
      }
      pending = expressionSteps.pending;

      if (firstNodeId) {
        const returnNodeId = this.createReturnNode(statement, true);
        this.connectPendingToNode(pending, returnNodeId);
        this.captureCallbackReturn(returnNodeId);

        return {
          firstNodeId,
          openExits: [],
          pendingBreaks: [],
          pendingContinues: [],
          pendingThrows: [],
        };
      }

      const returnNodeId = this.createReturnNode(statement);
      this.connectPendingToNode(pending, returnNodeId);
      this.captureCallbackReturn(returnNodeId);

      return {
        firstNodeId: firstNodeId || returnNodeId,
        openExits: [],
        pendingBreaks: [],
        pendingContinues: [],
        pendingThrows: [],
      };
    }

    const returnNodeId = this.createReturnNode(statement);
    this.connectPendingToNode(incomingExits, returnNodeId);
    this.captureCallbackReturn(returnNodeId);

    return {
      firstNodeId: returnNodeId,
      openExits: [],
      pendingBreaks: [],
      pendingContinues: [],
      pendingThrows: [],
    };
  }

  private buildContinueStatement(statement: ts.ContinueStatement, incomingExits: PendingExit[]): BuildResult {
    const continueSources = incomingExits.length
      ? incomingExits
      : this.buildInitialPendingExits();

    return {
      openExits: [],
      pendingBreaks: [],
      pendingContinues: [...continueSources],
      pendingThrows: [],
    };
  }

  private buildBreakStatement(statement: ts.BreakStatement, incomingExits: PendingExit[]): BuildResult {
    const breakSources = incomingExits.length
      ? incomingExits
      : this.buildInitialPendingExits();

    return {
      firstNodeId: undefined,
      openExits: [],
      pendingBreaks: [...breakSources],
      pendingContinues: [],
      pendingThrows: [],
    };
  }

  private buildThrowStatement(statement: ts.ThrowStatement, incomingExits: PendingExit[], environment: BuildEnvironment): BuildResult {
    const throwTextRaw = statement.getText(this.sourceFile);
    const throwSources: PendingThrowExit[] = (incomingExits.length
      ? incomingExits
      : this.buildInitialPendingExits())
      .map((exit) => ({ ...exit, actionTextRaw: throwTextRaw }));

    if (environment.hasLocalCatch) {
      return {
        openExits: [],
        pendingBreaks: [],
        pendingContinues: [],
        pendingThrows: [...throwSources],
      };
    }

    return {
      firstNodeId: undefined,
      openExits: [],
      pendingBreaks: [],
      pendingContinues: [],
      pendingThrows: throwSources,
    };
  }

  private buildFlowBranchBody(
    statement: ts.Statement,
    incomingExits: PendingExit[],
    environment: BuildEnvironment,
  ): BuildResult {
    if (!this.enclosingLoopStepContexts.length) {
      return this.buildStatementOrBlock(
        statement,
        incomingExits,
        { ...environment, flowBodyExecution: true },
      );
    }

    return this.buildStatementOrBlock(
      statement,
      incomingExits,
      { ...environment, flowBodyExecution: false },
    );
  }

  private buildIfStatement(statement: ts.IfStatement, incomingExits: PendingExit[], environment: BuildEnvironment): BuildResult {
    const childEnvironment = environment.deferIfMerge
      ? { ...environment, deferIfMerge: false }
      : environment;
    const normalizedCondition = unwrapExpression(statement.expression);
    const materializeCondition = () => {
      const materialized = this.materializeBooleanConditionFlow(normalizedCondition, incomingExits, 'Branch');
      const trueExits = materialized.trueExits.length > 1
        ? this.materializeFlowReentryJoins(
            statement.expression,
            'condition-true-merge',
            materialized.trueExits,
            { exclusive: true, inlineStepContext: true, singleJoin: true },
          )
        : materialized.trueExits;
      const falseExits = materialized.falseExits.length > 1
        ? this.materializeFlowReentryJoins(
            statement.expression,
            'condition-false-merge',
            materialized.falseExits,
            { exclusive: true, inlineStepContext: true, singleJoin: true },
          )
        : materialized.falseExits;
      return { ...materialized, trueExits, falseExits };
    };
    const conditionFlow = this.enclosingLoopStepContexts.length
      ? materializeCondition()
      : this.runInFlowStep(statement.expression, 'condition', materializeCondition);
    const mainFlowFalseExits = conditionFlow.falseExits.map((exit) => ({
      ...exit,
      ...(statement.elseStatement && this.enclosingLoopStepContexts.length ? { label: 'else' } : {}),
      mainFlow: true,
    }));

    const trueResult = this.enclosingLoopStepContexts.length
      ? this.buildFlowBranchBody(
          statement.thenStatement,
          conditionFlow.trueExits,
          childEnvironment,
        )
      : this.runInFlowBlock(
        statement.thenStatement,
        'side',
        'TRUE',
        conditionFlow.trueExits.map((exit) => exit.fromId),
        conditionFlow.trueExits,
        () => this.buildFlowBranchBody(
          statement.thenStatement,
          conditionFlow.trueExits,
          childEnvironment,
        ),
      );
    const falseResult = statement.elseStatement
      ? ts.isIfStatement(statement.elseStatement)
        ? this.buildIfStatement(
            statement.elseStatement,
            mainFlowFalseExits,
            { ...childEnvironment, deferIfMerge: true },
          )
        : this.enclosingLoopStepContexts.length
          ? this.buildFlowBranchBody(
            statement.elseStatement!,
            mainFlowFalseExits,
            childEnvironment,
          )
          : this.runInFlowBlock(
            statement.elseStatement,
            'alternative',
            'FALSE',
            mainFlowFalseExits.map((exit) => exit.fromId),
            mainFlowFalseExits,
            () => this.buildFlowBranchBody(
              statement.elseStatement!,
              mainFlowFalseExits,
              childEnvironment,
            ),
          )
      : {
          ...buildEmptyResult(),
          openExits: mainFlowFalseExits,
        };

    const elseIfChain = Boolean(statement.elseStatement && ts.isIfStatement(statement.elseStatement));
    const combinedOpenExits = [
      ...trueResult.openExits.map((exit) => (
        elseIfChain ? { ...exit, elseIfChainBypass: true } : exit
      )),
      ...falseResult.openExits,
    ];
    let openExits = combinedOpenExits;
    if (!environment.deferIfMerge && combinedOpenExits.length > 1) {
      openExits = this.materializeFlowReentryJoins(statement, 'if-merge', combinedOpenExits, {
        exclusive: true,
        singleJoin: elseIfChain,
      });
    }

    return {
      firstNodeId: conditionFlow.firstNodeId,
      openExits,
      pendingBreaks: [...trueResult.pendingBreaks, ...falseResult.pendingBreaks],
      pendingContinues: [...trueResult.pendingContinues, ...falseResult.pendingContinues],
      pendingThrows: [...trueResult.pendingThrows, ...falseResult.pendingThrows],
    };
  }

  private getLoopConditionText(statement: ts.IterationStatement) {
    if (ts.isWhileStatement(statement) || ts.isDoStatement(statement)) {
      return statement.expression.getText(this.sourceFile);
    }
    if (ts.isForStatement(statement)) {
      if (statement.condition) {
        return statement.condition.getText(this.sourceFile);
      }
      return 'true';
    }
    if (ts.isForInStatement(statement)) {
      return `${statement.initializer.getText(this.sourceFile)} in ${statement.expression.getText(this.sourceFile)}`;
    }
    if (ts.isForOfStatement(statement)) {
      return `${statement.initializer.getText(this.sourceFile)} of ${statement.expression.getText(this.sourceFile)}`;
    }
    return shortenLabel(statement.getText(this.sourceFile), 80);
  }

  private buildLoopStatement(statement: ts.IterationStatement, incomingExits: PendingExit[], environment: BuildEnvironment): BuildResult {
    if (ts.isForStatement(statement)) {
      return this.buildForStatement(statement, incomingExits, environment);
    }
    const loopStepContext = this.createFlowStepContext(statement, 'execution', 'loop');
    this.enclosingLoopStepContexts.push(loopStepContext);
    this.aggregateFlowStepDepth += 1;
    try {
      return this.runInFlowStepContext(
        loopStepContext,
        () => this.buildLoopStatementInStep(statement, incomingExits, environment),
      );
    } finally {
      this.aggregateFlowStepDepth -= 1;
      this.enclosingLoopStepContexts.pop();
    }
  }

  private buildForStatement(statement: ts.ForStatement, incomingExits: PendingExit[], environment: BuildEnvironment): BuildResult {
    const entry = this.runInFlowStep(statement, 'execution', () => {
      const id = `${getExtendedStableId(this.sourceFile, statement)}:for`;
      this.createNode('Action', 'for', statement, {
        labels: ['System', 'Keyword', 'For', 'Method'], diaName: 'for',
        renderPartsLayout: 'single', renderPrimaryPartIndex: 0,
        renderPartsJson: JSON.stringify([{ stableId: id, text: 'for', kind: 'method',
          labels: ['System', 'Keyword', 'Method'], sourceStableId: getExtendedStableId(this.sourceFile, statement), order: 0 }]),
      }, id);
      this.registerFirstNode(id, incomingExits);
      this.connectPendingToNode(incomingExits, id);
      return id;
    });
    const entries = [this.createPendingExit(undefined, entry, 'NEXT')];
    const result = this.runInFlowBlock(statement, 'side', 'NEXT', [entry], entries,
      () => this.buildForBody(statement, entries, environment));
    return { ...result, firstNodeId: entry };
  }

  private buildForBody(statement: ts.ForStatement, incomingExits: PendingExit[], environment: BuildEnvironment): BuildResult {
    let pending = incomingExits;
    let firstNodeId: string | undefined;
    const buildHeaderStatement = (header: ts.Statement) => {
      const result = this.runInStatementFlowStep(header, () => this.materializeLinearStatement(header, pending));
      firstNodeId ||= result.firstNodeId;
      pending = result.openExits;
    };
    if (statement.initializer) {
      if (ts.isVariableDeclarationList(statement.initializer)) {
        for (const declaration of statement.initializer.declarations) {
          const list = ts.factory.createVariableDeclarationList([declaration], statement.initializer.flags);
          ts.setTextRange(list, declaration);
          const header = ts.factory.createVariableStatement(undefined, list);
          ts.setTextRange(header, declaration);
          buildHeaderStatement(header);
        }
      } else {
        const header = ts.factory.createExpressionStatement(statement.initializer);
        ts.setTextRange(header, statement.initializer);
        buildHeaderStatement(header);
      }
    }
    const conditionContext = this.createFlowStepContext(statement.condition || statement, 'condition');
    const condition = this.runInFlowStepContext(conditionContext, () => {
      if (statement.condition) return this.materializeBooleanConditionFlow(statement.condition, pending, 'Branch');
      const id = this.createNode('Branch', 'for', statement, { diaName: 'true', conditionRaw: 'true' },
        `${getExtendedStableId(this.sourceFile, statement)}:condition`);
      this.registerFirstNode(id, pending);
      this.connectPendingToNode(pending, id);
      return { firstNodeId: id, trueExits: [this.createPendingExit(undefined, id, 'TRUE')], falseExits: [] };
    });
    firstNodeId ||= condition.firstNodeId;
    const repeatEntry = statement.initializer && ts.isVariableDeclarationList(statement.initializer)
      && statement.initializer.declarations.length === 1 && firstNodeId !== condition.firstNodeId
      ? firstNodeId : condition.firstNodeId;
    if (repeatEntry !== condition.firstNodeId) {
      for (const edge of this.edges) {
        if (edge.fromId === repeatEntry && edge.type === 'EVAL') edge.executionOutcome = 'initialization-only';
      }
    }
    const body = (() => {
        const result = this.buildFlowBranchBody(statement.statement, condition.trueExits, environment);
        // Both normal completion and continue execute the update before retesting.
        const updateIncoming = [...result.openExits, ...result.pendingContinues];
        let repeatExits = updateIncoming;
        if (statement.incrementor && updateIncoming.length) {
          const update = statement.incrementor;
          const header = ts.factory.createExpressionStatement(update);
          ts.setTextRange(header, update);
          const updated = this.runInStatementFlowStep(header, () => {
            if ((ts.isPostfixUnaryExpression(update) || ts.isPrefixUnaryExpression(update))
              && (update.operator === ts.SyntaxKind.PlusPlusToken || update.operator === ts.SyntaxKind.MinusMinusToken)) {
              const operator = ts.tokenToString(update.operator)!;
              const id = getExtendedStableId(this.sourceFile, update);
              const sourceStableId = getExtendedStableId(this.sourceFile, update.operand);
              const valueSlotStableId = this.bindingNodeStableIdForExpression(update.operand);
              this.createNode('Action', 'update', update, {
                labels: ['ValueWrite', 'Assignment'], diaName: update.operand.getText(this.sourceFile),
                valueSlotStableId, operationSubjectText: update.operand.getText(this.sourceFile),
                containerMethodKind: operator, renderPartsLayout: 'container-overlay', renderPrimaryPartIndex: 0,
                renderPartsJson: JSON.stringify([
                  { stableId: `${id}:container`, text: update.operand.getText(this.sourceFile), kind: 'value-container',
                    labels: ['ValueSlot', 'ValueWrite'], sourceStableId, order: 0, fillState: 'filled' },
                  { stableId: `${id}:update`, text: operator, kind: 'method',
                    labels: ['System', 'Method', 'ContainerMethod'], sourceStableId: id, order: 1 },
                ] satisfies RenderPartDescriptor[]),
              }, id);
              this.connectPendingToNode(updateIncoming, id);
              return { ...buildEmptyResult(), firstNodeId: id, openExits: [this.createPendingExit(undefined, id, 'NEXT')] };
            }
            return this.materializeLinearStatement(header, updateIncoming);
          });
          repeatExits = updated.openExits;
        }
        for (const exit of repeatExits) {
          const repeatSourceId = this.nodeByStableId(getStableIdKey(exit.fromId))?.callBoundaryPeerStableId || exit.fromId;
          this.addEdge(exit.fromKind, repeatSourceId, undefined, repeatEntry!, 'REPEATS', {
            executionOutcome: repeatEntry !== condition.firstNodeId ? 'resume-without-initialization' : undefined,
            sourcePort: 'right', targetPort: 'top-80', lockPortCandidates: true,
          });
        }
        return result;
      })();
    return { firstNodeId, openExits: [...condition.falseExits, ...body.pendingBreaks],
      pendingBreaks: [], pendingContinues: [], pendingThrows: body.pendingThrows };
  }

  private materializeForOfDispatchStages(
    statement: ts.ForOfStatement,
    iteratorAxisStableId: string,
    itemStableId: string,
  ) {
    const bodyStatements = ts.isBlock(statement.statement)
      ? [...statement.statement.statements]
      : [statement.statement];
    const branch = bodyStatements.find(ts.isIfStatement);
    if (!branch) return;
    const predicateStableId = getExtendedStableId(this.sourceFile, branch.expression);
    const alternatives = [
      {
        edgeType: 'TRUE' as const,
        label: 'if',
        statement: branch.thenStatement,
        suffix: 'true',
      },
      ...(branch.elseStatement ? [{
        edgeType: 'FALSE' as const,
        label: 'else',
        statement: branch.elseStatement,
        suffix: 'false',
      }] : []),
    ];
    this.addEdge(undefined, itemStableId, undefined, predicateStableId, 'PASSES_VALUE', {
      label: '',
      flowLayer: 'data',
      semanticExpansion: 'collection-iteration',
    });

    for (const alternative of alternatives) {
      const branchSourceStableId = getExtendedStableId(this.sourceFile, alternative.statement);
      const headerStableId = `${branchSourceStableId}:branch:${alternative.suffix}:header`;
      const bodyStableId = `${branchSourceStableId}:branch:${alternative.suffix}`;
      this.createNode('Action', `${alternative.label} entry`, alternative.statement, {
        labels: ['Branch', 'Alternative', 'SemanticExpansion'],
        diaName: alternative.label,
        collectionMethod: 'for-of',
        collectionLoopStableId: iteratorAxisStableId,
        semanticExpansion: 'collection-iteration',
        sequenceOwnerStableId: iteratorAxisStableId,
        flowLayer: 'control',
        renderHidden: true,
        synthetic: true,
      }, headerStableId);
      this.createNode('Action', `${alternative.label} body`, alternative.statement, {
        ...this.executionPrimitiveExtra(executionPrimitive('branch'), [
          'BranchBody',
          'Alternative',
          'SemanticExpansion',
        ]),
        diaName: '',
        collectionMethod: 'for-of',
        collectionLoopStableId: iteratorAxisStableId,
        semanticExpansion: 'collection-iteration',
        sequenceOwnerStableId: iteratorAxisStableId,
        flowLayer: 'control',
        renderHidden: true,
        synthetic: true,
      }, bodyStableId);
      this.addEdge(undefined, predicateStableId, undefined, headerStableId, alternative.edgeType, {
        label: alternative.edgeType.toLowerCase(),
        flowLayer: 'control',
        semanticExpansion: 'collection-iteration',
      });
      this.addEdge(undefined, headerStableId, undefined, bodyStableId, 'ENTERS', {
        label: '',
        flowLayer: 'control',
        semanticExpansion: 'collection-iteration',
      });

      const statements = ts.isBlock(alternative.statement)
        ? [...alternative.statement.statements]
        : [alternative.statement];
      let previousStageStableId = bodyStableId;
      statements.forEach((bodyStatement, index) => {
        const stageStableId = `${bodyStableId}:stage:${index}`;
        this.createNode('Action', 'effect stage', bodyStatement, {
          ...this.executionPrimitiveExtra(executionPrimitive('effect'), [
            'SequenceStage',
            'EffectStage',
            'SemanticExpansion',
          ]),
          diaName: '',
          collectionMethod: 'for-of',
          collectionLoopStableId: iteratorAxisStableId,
          semanticExpansion: 'collection-iteration',
          sequenceOwnerStableId: bodyStableId,
          flowLayer: 'control',
          renderHidden: true,
          synthetic: true,
        }, stageStableId);
        this.addEdge(undefined, previousStageStableId, undefined, stageStableId, 'NEXT', {
          label: '',
          flowLayer: 'control',
          semanticExpansion: 'collection-iteration',
          sequenceOrder: index,
        });
        previousStageStableId = stageStableId;

        let objectExpression: ts.ObjectLiteralExpression | undefined;
        if (ts.isVariableStatement(bodyStatement)) {
          const declaration = bodyStatement.declarationList.declarations[0];
          const initializer = declaration?.initializer && unwrapExpression(declaration.initializer);
          if (initializer && ts.isObjectLiteralExpression(initializer)) {
            objectExpression = initializer;
          }
        } else if (ts.isExpressionStatement(bodyStatement)) {
          const expression = unwrapExpression(bodyStatement.expression);
          if (ts.isCallExpression(expression)) {
            const argument = expression.arguments[0] && unwrapExpression(expression.arguments[0]);
            if (argument && ts.isObjectLiteralExpression(argument)) {
              objectExpression = argument;
            }
          }
        }
        if (!objectExpression) return;
        const objectSourceStableId = getExtendedStableId(this.sourceFile, objectExpression);
        const objectNode = this.nodes.find((node) => (
          node.labels.includes('Object')
          && getStableIdKey(node.stableId).includes(objectSourceStableId)
        )) || this.nodes.find((node) => (
          node.labels.includes('Object')
          && node.actionTextRaw === objectExpression?.getText(this.sourceFile)
        ));
        if (!objectNode) return;
        this.addEdge(
          undefined,
          stageStableId,
          undefined,
          getStableIdKey(objectNode.stableId),
          'EMITS_EFFECT',
          {
            label: '',
            flowLayer: 'control',
            semanticExpansion: 'collection-iteration',
          },
        );
      });
      this.addEdge(undefined, previousStageStableId, undefined, iteratorAxisStableId, 'REPEATS', {
        label: 'repeat',
        flowLayer: 'control',
        semanticExpansion: 'collection-iteration',
      });
    }
  }

  private buildLoopStatementInStep(statement: ts.IterationStatement, incomingExits: PendingExit[], environment: BuildEnvironment): BuildResult {
    const forOfStatement = ts.isForOfStatement(statement) ? statement : undefined;
    const conditionExpression = ts.isWhileStatement(statement) || ts.isDoStatement(statement)
      ? statement.expression
      : ts.isForStatement(statement)
        ? statement.condition
        : ts.isForInStatement(statement)
          ? statement.expression
          : undefined;
    const conditionSteps = conditionExpression
      ? this.materializeConditionExpression(conditionExpression, incomingExits)
      : { firstNodeId: undefined, pending: [...incomingExits] };
    const rawBranchStableId = getExtendedStableId(this.sourceFile, statement);
    const branchStableId = this.contextualizeHorizontalStableId(rawBranchStableId, statement);
    const iteratorAxisStableId = branchStableId;
    const conditionRaw = this.getLoopConditionText(statement);
    const loopValueSlotStableId = forOfStatement
      ? this.bindingNodeStableIdForExpression(forOfStatement.expression)
      : undefined;
    this.createNode('Loop', 'loop', statement, {
      diaName: forOfStatement ? 'for' : undefined,
      conditionRaw,
      valueSlotStableId: loopValueSlotStableId,
      valueSlotStableIds: loopValueSlotStableId ? [loopValueSlotStableId] : undefined,
      conditionStableId: conditionExpression
        ? getExtendedStableIdDescriptor(this.sourceFile, conditionExpression)
        : getExtendedStableIdDescriptor(this.sourceFile, statement),
      ...(forOfStatement ? {
        collectionMethod: 'for-of',
        collectionIterationMode: 'forward',
        collectionResultMode: 'effects',
        collectionLoopStableId: iteratorAxisStableId,
      } : {}),
    }, branchStableId);
    if (!conditionSteps.firstNodeId) {
      this.registerFirstNode(branchStableId, incomingExits);
    }
    this.connectPendingToNode(conditionSteps.pending, branchStableId);

    let iteratorStableId: string | undefined;
    let collectionStableId: string | undefined;
    if (forOfStatement) {
      const iteratorText = forOfStatement.initializer.getText(this.sourceFile)
        .replace(/^(?:const|let|var)\s+/u, '')
        .trim();
      iteratorStableId = this.createNode('Value', 'iterator', forOfStatement.initializer, {
        labels: ['Iterator', 'Iteration', 'Element', 'ValueSlot', 'ValueCreate', 'Set', 'SemanticExpansion'],
        diaName: iteratorText,
        operationSubjectText: iteratorText,
        containerMethodKind: 'set',
        collectionMethod: 'for-of',
        collectionLoopStableId: iteratorAxisStableId,
        semanticExpansion: 'collection-iteration',
        sequenceOwnerStableId: iteratorAxisStableId,
        flowLayer: 'data',
        dataFlowRole: 'input',
        containerState: 'awaiting-assignment',
        renderPartsLayout: 'container-overlay',
        renderPartsJson: JSON.stringify([{
          stableId: `${getExtendedStableId(this.sourceFile, forOfStatement.initializer)}:iterator`,
          text: iteratorText,
          kind: 'value-container',
          labels: ['Iterator', 'Iteration', 'Element', 'ValueSlot'],
          order: 0,
          fillState: 'empty',
        }, {
          stableId: `${getExtendedStableId(this.sourceFile, forOfStatement.initializer)}:iterator`,
          text: 'set',
          kind: 'method',
          labels: ['Assignment', 'ContainerMethod', 'Method', 'Set'],
          order: 1,
        }] satisfies RenderPartDescriptor[]),
        renderPrimaryPartIndex: 0,
      }, `${getExtendedStableId(this.sourceFile, forOfStatement.initializer)}:iterator`);
      const collectionText = forOfStatement.expression.getText(this.sourceFile);
      collectionStableId = this.createNode('Op', 'shift', forOfStatement.expression, {
        labels: ['Collection', 'Receiver', 'Occurrence', 'Primitive', 'Pull', 'Shift', 'Method', 'SemanticExpansion'],
        diaName: 'shift',
        operationSubjectText: collectionText,
        containerMethodKind: 'shift',
        canonicalStableId: this.canonicalStableIdForExpression(forOfStatement.expression),
        valueSlotStableId: loopValueSlotStableId,
        valueSlotStableIds: loopValueSlotStableId ? [loopValueSlotStableId] : undefined,
        collectionMethod: 'for-of',
        collectionLoopStableId: iteratorAxisStableId,
        semanticExpansion: 'collection-iteration',
        sequenceOwnerStableId: iteratorAxisStableId,
        flowLayer: 'data',
        dataFlowRole: 'input',
        renderPartsLayout: 'container-overlay',
        renderPartsJson: JSON.stringify([{
          stableId: `${getExtendedStableId(this.sourceFile, forOfStatement.expression)}:collection`,
          text: collectionText,
          kind: 'collection-container',
          labels: ['Collection', 'Receiver', 'Occurrence'],
          sourceStableId: getExtendedStableId(this.sourceFile, forOfStatement.expression),
          order: 0,
          fillState: 'filled',
        }, {
          stableId: `${getExtendedStableId(this.sourceFile, forOfStatement.expression)}:collection`,
          text: 'shift',
          kind: 'method',
          labels: ['Primitive', 'Pull', 'Shift', 'Method'],
          sourceStableId: getExtendedStableId(this.sourceFile, forOfStatement.expression),
          order: 1,
        }] satisfies RenderPartDescriptor[]),
        renderPrimaryPartIndex: 0,
      }, `${getExtendedStableId(this.sourceFile, forOfStatement.expression)}:collection`);
      this.addEdge(undefined, branchStableId, undefined, iteratorStableId, 'NEXT', {
        label: '',
        flowLayer: 'control',
        semanticExpansion: 'collection-iteration',
        sequenceOrder: 0,
      });
      this.addEdge(undefined, iteratorStableId, undefined, collectionStableId, 'EVAL', {
        label: 'eval',
        flowLayer: 'control',
        semanticExpansion: 'collection-iteration',
        sequenceOrder: 1,
        protocolRole: 'collection-shift-eval',
      });
      this.addEdge(undefined, collectionStableId, undefined, iteratorStableId, 'YIELDS_VALUE', {
        label: 'value',
        displayLabel: 'value',
        flowLayer: 'data',
        semanticExpansion: 'collection-iteration',
        sequenceOrder: 2,
        executionOutcome: 'item-available',
        protocolRole: 'iteration-pass',
      });
    }

    const bodyStatement = ts.isDoStatement(statement) ? statement.statement : statement.statement;
    const loopBodyIncoming = [this.createPendingExit(
      undefined,
      forOfStatement
        ? iteratorStableId!
        : branchStableId,
      'NEXT',
    )];
    const bodyResult = this.buildStatementOrBlock(
      bodyStatement,
      loopBodyIncoming,
      forOfStatement
        ? { ...environment, deferIfMerge: true }
        : environment,
    );
    bodyResult.openExits.forEach((exit) => {
      const repeatSourceId = this.nodeByStableId(getStableIdKey(exit.fromId))?.callBoundaryPeerStableId
        || exit.fromId;
      if (forOfStatement) {
        this.addEdge(exit.fromKind, repeatSourceId, undefined, collectionStableId!, 'REPEATS', {
          label: 'repeat',
          flowLayer: 'control',
          semanticExpansion: 'collection-iteration',
        });
      } else {
        this.addEdge(exit.fromKind, repeatSourceId, undefined, branchStableId, 'REPEATS');
      }
    });
    bodyResult.pendingContinues.forEach((exit) => {
      const repeatSourceId = this.nodeByStableId(getStableIdKey(exit.fromId))?.callBoundaryPeerStableId
        || exit.fromId;
      if (forOfStatement) {
        this.addEdge(exit.fromKind, repeatSourceId, undefined, collectionStableId!, 'REPEATS', {
          label: 'repeat',
          flowLayer: 'control',
          semanticExpansion: 'collection-iteration',
        });
      } else {
        this.addEdge(exit.fromKind, repeatSourceId, undefined, branchStableId, 'REPEATS');
      }
    });

    const loopOpenExits = forOfStatement
      ? [this.createPendingExit(
          undefined,
          branchStableId,
          'NEXT',
        )]
      : [...bodyResult.openExits];
    let sharedBreakStopId: string | undefined;
    if (bodyResult.pendingBreaks.length) {
      sharedBreakStopId = this.createSharedTerminalNode('BreakStop', statement);
      this.connectPendingToNode(bodyResult.pendingBreaks, sharedBreakStopId);
      loopOpenExits.push(this.createPendingExit(undefined, sharedBreakStopId, 'NEXT'));
    }

    return {
      firstNodeId: conditionSteps.firstNodeId || branchStableId,
      openExits: loopOpenExits,
      pendingBreaks: [],
      pendingContinues: [],
      pendingThrows: bodyResult.pendingThrows,
    };
  }

  private getCaseConditionText(statement: ts.SwitchStatement, clause: ts.CaseOrDefaultClause) {
    const switchExpression = statement.expression.getText(this.sourceFile);
    if (ts.isDefaultClause(clause)) {
      return 'default';
    }
    return `${switchExpression} === ${clause.expression.getText(this.sourceFile)}`;
  }

  private buildSwitchStatement(statement: ts.SwitchStatement, incomingExits: PendingExit[], environment: BuildEnvironment): BuildResult {
    const switchConditionSteps = this.materializeConditionExpression(statement.expression, incomingExits);
    const switchExpression = statement.expression.getText(this.sourceFile);
    const switchStableId = this.createNode('Switch', 'switch', statement, {
      conditionRaw: switchExpression,
    }, getExtendedStableId(this.sourceFile, statement));
    if (!switchConditionSteps.firstNodeId) {
      this.registerFirstNode(switchStableId, incomingExits);
    }
    this.connectPendingToNode(switchConditionSteps.pending, switchStableId);

    let fallthroughIncoming: PendingExit[] = [];
    const pendingBreaks: PendingExit[] = [];
    const pendingContinues: PendingExit[] = [];
    const pendingThrows: PendingExit[] = [];
    const clauseSurvivors: PendingExit[] = [];
    let firstNodeId: string | undefined = switchConditionSteps.firstNodeId || switchStableId;
    let hasDefaultClause = false;

    statement.caseBlock.clauses.forEach((clause) => {
      const kind = ts.isDefaultClause(clause) ? 'default' : 'case';
      if (ts.isDefaultClause(clause)) {
        hasDefaultClause = true;
      }

      const conditionRaw = this.getCaseConditionText(statement, clause);
      const branchStableId = this.createNode('Case', kind, clause, {
        conditionRaw,
      }, getExtendedStableId(this.sourceFile, clause));
      this.addEdge(
        undefined,
        switchStableId,
        undefined,
        branchStableId,
        ts.isDefaultClause(clause) ? 'OPTION_DEFAULT' : 'OPTION_CASE',
        {
          label: ts.isCaseClause(clause) ? shortenLabel(clause.expression.getText(this.sourceFile), 60) : undefined,
        },
      );
      this.connectPendingToNode(fallthroughIncoming, branchStableId);

      const clauseIncoming = [this.createPendingExit(undefined, branchStableId, 'NEXT')];
      const clauseResult = this.runInFlowBlock(
        clause,
        'switch-case',
        ts.isDefaultClause(clause) ? 'DEFAULT' : 'CASE',
        [branchStableId],
        clauseIncoming,
        () => this.buildBlock(
          [...clause.statements],
          clauseIncoming,
          environment,
        ),
      );
      fallthroughIncoming = clauseResult.openExits.length
        ? clauseResult.openExits
        : clause.statements.length === 0
          ? [this.createPendingExit(undefined, branchStableId, 'NEXT')]
          : [];
      pendingBreaks.push(...clauseResult.pendingBreaks);
      pendingContinues.push(...clauseResult.pendingContinues);
      pendingThrows.push(...clauseResult.pendingThrows);
    });

    clauseSurvivors.push(...fallthroughIncoming);
    if (!hasDefaultClause) {
      clauseSurvivors.push(this.createPendingExit(undefined, switchStableId, 'NEXT'));
    }

    const postSwitchMergeId = this.createMergeNode(statement, 'switch-merge', clauseSurvivors);
    for (const exit of clauseSurvivors) {
      this.connectPendingToJoin([exit], postSwitchMergeId.stableId, postSwitchMergeId.kind);
    }
    if (pendingBreaks.length) {
      const sharedBreakStopId = this.createSharedTerminalNode('BreakStop', statement);
      this.connectPendingToNode(pendingBreaks, sharedBreakStopId);
      this.addEdge(undefined, sharedBreakStopId, undefined, postSwitchMergeId.stableId, 'MERGES_TO');
    }

    return {
      firstNodeId,
      openExits: [this.createPendingExit(undefined, postSwitchMergeId.stableId, 'NEXT')],
      pendingBreaks: [],
      pendingContinues,
      pendingThrows,
    };
  }

  private buildTryStatement(statement: ts.TryStatement, incomingExits: PendingExit[], environment: BuildEnvironment): BuildResult {
    const tryNodeStartIndex = this.nodes.length;
    const tryResult = this.buildBlock([...statement.tryBlock.statements], incomingExits, { hasLocalCatch: Boolean(statement.catchClause) });
    const awaitedThrowSources = this.nodes
      .slice(tryNodeStartIndex)
      .filter((node) => node.labels.includes('Awaited'))
      .map((node) => this.createPendingExit(undefined, getStableIdKey(node.stableId), 'CATCH', 'catch'));

    let catchResult = buildEmptyResult();
    if (statement.catchClause) {
      catchResult = this.buildBlock([...statement.catchClause.block.statements], [], environment);
      if (statement.catchClause.block.statements.length === 0) {
        const catchMergeId = this.createMergeNode(statement.catchClause, 'catch-empty');
        catchResult = {
          firstNodeId: catchMergeId.stableId,
          openExits: [this.createPendingExit(undefined, catchMergeId.stableId, 'NEXT')],
          pendingBreaks: [],
          pendingContinues: [],
          pendingThrows: [],
        };
      }
      if (catchResult.firstNodeId) {
        this.connectPendingToNode(tryResult.pendingThrows, catchResult.firstNodeId);
        this.connectPendingToNode(awaitedThrowSources, catchResult.firstNodeId);
      }
    }

    let normalOpenExits = [...tryResult.openExits, ...catchResult.openExits];
    let pendingBreaks = [...tryResult.pendingBreaks, ...catchResult.pendingBreaks];
    let pendingContinues = [...tryResult.pendingContinues, ...catchResult.pendingContinues];
    let pendingThrows = statement.catchClause ? [...catchResult.pendingThrows] : [...tryResult.pendingThrows];

    if (statement.finallyBlock) {
      const finallyIncoming = normalOpenExits.length ? normalOpenExits : [];
      const finallyResult = this.buildBlock([...statement.finallyBlock.statements], finallyIncoming, environment);
      normalOpenExits = finallyResult.openExits;
      pendingBreaks = [...pendingBreaks, ...finallyResult.pendingBreaks];
      pendingContinues = [...pendingContinues, ...finallyResult.pendingContinues];
      pendingThrows = [...pendingThrows, ...finallyResult.pendingThrows];
    }

    if (normalOpenExits.length > 1) {
      const mergeId = this.createMergeNode(statement, 'try-merge', normalOpenExits);
      this.connectPendingToJoin(normalOpenExits, mergeId.stableId, mergeId.kind);
      normalOpenExits = [this.createPendingExit(undefined, mergeId.stableId, 'NEXT')];
    }

    return {
      firstNodeId: tryResult.firstNodeId || catchResult.firstNodeId,
      openExits: normalOpenExits,
      pendingBreaks,
      pendingContinues,
      pendingThrows,
    };
  }

  private buildStatementOrBlock(statement: ts.Statement, incomingExits: PendingExit[], environment: BuildEnvironment): BuildResult {
    if (ts.isBlock(statement)) {
      return this.buildBlock([...statement.statements], incomingExits, environment);
    }

    if (environment.flowBodyExecution) {
      return this.runInStatementFlowStep(
        statement,
        () => this.buildStatement(statement, incomingExits, { ...environment, flowBodyExecution: false }),
        { forceExecution: true },
      );
    }

    return this.buildStatement(statement, incomingExits, environment);
  }

  private buildStatement(statement: ts.Statement, incomingExits: PendingExit[], environment: BuildEnvironment): BuildResult {
    if (ts.isBlock(statement)) {
      return this.buildBlock([...statement.statements], incomingExits, environment);
    }
    if (ts.isIfStatement(statement)) {
      return this.buildIfStatement(statement, incomingExits, environment);
    }
    if (ts.isSwitchStatement(statement)) {
      return this.buildSwitchStatement(statement, incomingExits, environment);
    }
    if (isLoopStatement(statement)) {
      return this.buildLoopStatement(statement, incomingExits, environment);
    }
    if (ts.isTryStatement(statement)) {
      return this.buildTryStatement(statement, incomingExits, environment);
    }
    if (ts.isReturnStatement(statement)) {
      return this.buildReturnStatement(statement, incomingExits);
    }
    if (ts.isContinueStatement(statement)) {
      return this.buildContinueStatement(statement, incomingExits);
    }
    if (ts.isBreakStatement(statement)) {
      return this.buildBreakStatement(statement, incomingExits);
    }
    if (ts.isThrowStatement(statement)) {
      return this.buildThrowStatement(statement, incomingExits, environment);
    }

    return this.materializeLinearStatement(statement, incomingExits);
  }

  private buildBlock(statements: ts.Statement[], incomingExits: PendingExit[], environment: BuildEnvironment): BuildResult {
    let pending = [...incomingExits];
    let result = buildEmptyResult();
    let bufferedStatements: ts.Statement[] = [];
    const executionSegmentState: {
      context?: { stableId: string; kind: 'execution'; order: number };
      forceExecution?: boolean;
    } = { forceExecution: environment.flowBodyExecution === true };

    for (let index = 0; index < statements.length; index += 1) {
      const statement = statements[index];
      if (isBufferableLinearStatement(statement)) {
        bufferedStatements.push(statement);
        continue;
      }

      if (bufferedStatements.length) {
        const bufferedResult = this.materializeBufferedStatements(
          bufferedStatements,
          pending,
          executionSegmentState,
        );
        result = mergeResults(result, bufferedResult);
        if (!result.firstNodeId && bufferedResult.firstNodeId) {
          result.firstNodeId = bufferedResult.firstNodeId;
        }
        pending = bufferedResult.openExits;
        bufferedStatements = [];
      }

      const nextStatement = statements[index + 1];

      if (nextStatement && (ts.isBreakStatement(nextStatement) || ts.isContinueStatement(nextStatement))) {
        const preControlCallResult = this.runInStatementFlowStep(
          statement,
          () => this.buildStandaloneCallStatement(statement, pending, true),
          executionSegmentState,
        );
        if (preControlCallResult) {
          if (!result.firstNodeId && preControlCallResult.firstNodeId) {
            result.firstNodeId = preControlCallResult.firstNodeId;
          }
          result.pendingBreaks.push(...preControlCallResult.pendingBreaks);
          result.pendingContinues.push(...preControlCallResult.pendingContinues);
          result.pendingThrows.push(...preControlCallResult.pendingThrows);
          pending = preControlCallResult.openExits;
          continue;
        }
      }

      const statementResult = this.runInStatementFlowStep(
        statement,
        () => this.buildStatement(statement, pending, environment),
        executionSegmentState,
      );
      if (!result.firstNodeId && statementResult.firstNodeId) {
        result.firstNodeId = statementResult.firstNodeId;
      }
      result.pendingBreaks.push(...statementResult.pendingBreaks);
      result.pendingContinues.push(...statementResult.pendingContinues);
      result.pendingThrows.push(...statementResult.pendingThrows);
      pending = statementResult.openExits;
    }

    if (bufferedStatements.length) {
      const bufferedResult = this.materializeBufferedStatements(
        bufferedStatements,
        pending,
        executionSegmentState,
      );
      if (!result.firstNodeId && bufferedResult.firstNodeId) {
        result.firstNodeId = bufferedResult.firstNodeId;
      }
      result.pendingBreaks.push(...bufferedResult.pendingBreaks);
      result.pendingContinues.push(...bufferedResult.pendingContinues);
      result.pendingThrows.push(...bufferedResult.pendingThrows);
      pending = bufferedResult.openExits;
    }

    result.openExits = pending;
    return result;
  }
}

function isContainedRange(inner: StableIdDescriptor, outer: StableIdDescriptor) {
  const innerStartLine = inner.startLine || 0;
  const innerStartColumn = inner.startColumn || 0;
  const innerEndLine = inner.endLine || innerStartLine;
  const innerEndColumn = inner.endColumn || innerStartColumn;
  const outerStartLine = outer.startLine || 0;
  const outerStartColumn = outer.startColumn || 0;
  const outerEndLine = outer.endLine || outerStartLine;
  const outerEndColumn = outer.endColumn || outerStartColumn;

  const startsAfterOrAt = innerStartLine > outerStartLine
    || (innerStartLine === outerStartLine && innerStartColumn >= outerStartColumn);
  const endsBeforeOrAt = innerEndLine < outerEndLine
    || (innerEndLine === outerEndLine && innerEndColumn <= outerEndColumn);
  const sameStart = innerStartLine === outerStartLine && innerStartColumn === outerStartColumn;
  const sameEnd = innerEndLine === outerEndLine && innerEndColumn === outerEndColumn;

  return startsAfterOrAt && endsBeforeOrAt && !(sameStart && sameEnd);
}

function rangeSpan(node: FlowNodeRow) {
  const stableId = node.stableId;
  const startLine = stableId.startLine || 0;
  const startColumn = stableId.startColumn || 0;
  const endLine = stableId.endLine || startLine;
  const endColumn = stableId.endColumn || startColumn;
  return ((endLine - startLine) * 100_000) + Math.max(0, endColumn - startColumn);
}

function attachReferencedMethodOwners(
  program: ts.Program,
  stableIdByDeclaration: Map<ts.Node, string>,
  payload: GraphExtractedPayload,
  includeAllMethods = false,
) {
  const referencedFunctionIds = new Set(
    payload.edges.flatMap((edge) => [
      ...(edge.fromKind === 'Fn' ? [edge.fromId] : []),
      ...(edge.toKind === 'Fn' ? [edge.toId] : []),
    ]),
  );
  const ownerNodeIds = new Set<string>();
  const edgeKeys = new Set(payload.edges.map((edge) => `${edge.fromId}\u0000${edge.type}\u0000${edge.toId}`));

  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile)) continue;
    const visit = (node: ts.Node): void => {
      if (isFunctionLikeNode(node) && node.body) {
        const methodStableId = stableIdByDeclaration.get(node);
        const owner = getFunctionMethodOwner(node);
        if (methodStableId && owner && (includeAllMethods || referencedFunctionIds.has(methodStableId))) {
          const ownerDescriptor = getStableIdDescriptor(owner.getSourceFile(), owner);
          const ownerStableId = getStableIdKey(ownerDescriptor);
          if (!ownerNodeIds.has(ownerStableId)) {
            const ownerName = getMethodOwnerName(owner);
            payload.nodes.push(buildFlowNodeRow({
              kind: 'Object',
              stableId: ownerDescriptor,
              label: ownerName,
              parentFnStableId: getStableIdDescriptor(sourceFile, node),
              sourceFilePath: owner.getSourceFile().fileName,
              operationIndex: -1,
              operationFields: {},
              extra: {
                labels: ['Object'],
                diaName: ownerName,
                actionTextRaw: owner.getText(owner.getSourceFile()),
                renderPartsJson: JSON.stringify([{
                  stableId: ownerStableId,
                  text: ownerName,
                  kind: 'value-container',
                  labels: ['Object'],
                  order: 0,
                  sourceStableId: ownerStableId,
                } satisfies RenderPartDescriptor]),
                renderPartsLayout: 'single',
                renderPrimaryPartIndex: 0,
                flowLayer: 'structure',
              },
            }) as FlowNodeRow);
            ownerNodeIds.add(ownerStableId);
          }
          const edgeKey = `${ownerStableId}\u0000HAS_METHOD\u0000${methodStableId}`;
          if (!edgeKeys.has(edgeKey)) {
            const semanticInput = {
              label: getFunctionName(node),
              flowLayer: 'structure' as const,
            };
            payload.edges.push({
              fromKind: undefined,
              fromId: ownerStableId,
              toKind: 'Fn',
              toId: methodStableId,
              type: 'HAS_METHOD',
              ...semanticInput,
              ...classifyFlowEdge('HAS_METHOD', semanticInput),
            });
            edgeKeys.add(edgeKey);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
}

function attachParameterOrigins(
  payload: GraphExtractedPayload,
  facts: ParameterOriginFact[],
  accessorIndex: AccessorIndex,
) {
  const targetFunctionIds = new Set(payload.functions.map((row) => getStableIdKey(row.stableId)));
  const functionIds = new Set(targetFunctionIds);
  const nodeById = new Map(payload.nodes.map((node) => [getStableIdKey(node.stableId), node]));
  const edgeKey = (edge: FlowEdgeRow) => (
    `${edge.fromId}\u0000${edge.type}\u0000${edge.toId}\u0000${edge.callSiteStableId || ''}\u0000${edge.argumentIndex ?? ''}`
  );
  const edgeKeys = new Set(payload.edges.map(edgeKey));

  const addEdge = (edge: FlowEdgeRow) => {
    const key = edgeKey(edge);
    if (edgeKeys.has(key)) return;
    const semanticInput = {
      label: edge.label,
      displayLabel: edge.displayLabel,
      flowLayer: edge.flowLayer,
      mainFlow: edge.mainFlow,
    };
    payload.edges.push({
      ...edge,
      ...classifyFlowEdge(edge.type, semanticInput),
    });
    edgeKeys.add(key);
  };

  const ensureArgumentBinding = (fact: ParameterOriginFact) => {
    const binding = fact.argumentBinding;
    if (!binding) return undefined;
    const existing = nodeById.get(binding.stableId);
    if (existing) return existing;
    const declarationSourceFile = binding.declaration.getSourceFile();
    const bindingNode = buildFlowNodeRow({
      kind: 'Value',
      stableId: getExtendedStableIdDescriptor(declarationSourceFile, binding.declaration),
      label: binding.name,
      parentFnStableId: getStableIdDescriptor(fact.callerFn!.getSourceFile(), fact.callerFn!),
      sourceFilePath: declarationSourceFile.fileName,
      operationIndex: -1,
      operationFields: {},
      extra: {
        labels: uniqueStrings([
          'Value',
          'ValueSlot',
          binding.parameter ? 'Parameter' : 'LocalBinding',
        ]),
        diaName: binding.name,
        actionTextRaw: binding.declaration.getText(declarationSourceFile),
        valueName: binding.name,
        parameterName: binding.parameter ? binding.name : undefined,
        annotationKind: 'Binding',
        flowLayer: 'data',
        dataFlowRole: 'storage',
        renderPartsJson: JSON.stringify([{
          stableId: binding.stableId,
          text: binding.name,
          kind: 'value',
          labels: ['Value', 'ValueSlot'],
          order: 0,
          sourceStableId: binding.stableId,
        } satisfies RenderPartDescriptor]),
        renderPartsLayout: 'single',
        renderPrimaryPartIndex: 0,
      },
    }) as FlowNodeRow;
    payload.nodes.push(bindingNode);
    nodeById.set(binding.stableId, bindingNode);
    return bindingNode;
  };

  const ensureArgumentOriginal = (fact: ParameterOriginFact, bindingNode?: FlowNodeRow) => {
    if (bindingNode) return bindingNode;
    const existing = nodeById.get(fact.argumentStableId);
    if (existing) return existing;
    const sourceFile = fact.argument.getSourceFile();
    const sourceDescriptor = getExtendedStableIdDescriptor(sourceFile, fact.argument);
    const objectLiteral = ts.isObjectLiteralExpression(unwrapExpression(fact.argument));
    const originalNode = buildFlowNodeRow({
      kind: objectLiteral ? 'Object' : 'Value',
      stableId: {
        ...sourceDescriptor,
        value: fact.argumentStableId,
        suffix: `arg${fact.parameterIndex}`,
      },
      label: fact.argumentText,
      parentFnStableId: getStableIdDescriptor(fact.callerFn!.getSourceFile(), fact.callerFn!),
      sourceFilePath: sourceFile.fileName,
      operationIndex: -1,
      operationFields: {},
      extra: {
        labels: uniqueStrings([
          objectLiteral ? 'Object' : 'Value',
          objectLiteral ? 'ObjectConstruction' : 'ValueCreate',
          'ValueAccess',
          'ValueCreate',
        ]),
        diaName: fact.argumentText,
        actionTextRaw: fact.argumentText,
        canonicalStableId: fact.targetParameterTypeDeclarationStableId,
        sourceCallStableId: fact.callStableId,
        parameterOriginTargetFnStableId: fact.targetFnStableId,
        flowLayer: 'data',
        dataFlowRole: 'result',
        renderPartsJson: JSON.stringify([{
          stableId: fact.argumentStableId,
          text: fact.argumentText,
          kind: 'value',
          labels: objectLiteral ? ['Object', 'ObjectConstruction'] : ['Value', 'ValueCreate'],
          order: 0,
          sourceStableId: getExtendedStableId(sourceFile, fact.argument),
          canonicalStableId: fact.targetParameterTypeDeclarationStableId,
        } satisfies RenderPartDescriptor]),
        renderPartsLayout: 'single',
        renderPrimaryPartIndex: 0,
      },
    }) as FlowNodeRow;
    payload.nodes.push(originalNode);
    nodeById.set(fact.argumentStableId, originalNode);
    return originalNode;
  };

  const ensureParameterOriginCallSite = (fact: ParameterOriginFact) => {
    const stableId = fact.callStableId;
    const existing = nodeById.get(stableId);
    if (existing) {
      existing.labels = uniqueStrings([
        ...existing.labels,
        'Call',
        'CallSite',
        'ExecutionOccurrence',
      ]);
      existing.sourceCallStableId ||= fact.callStableId;
      existing.parameterOriginTargetFnStableId ||= fact.targetFnStableId;
      existing.annotationKind ||= 'CallSite';
      return existing;
    }
    const sourceFile = fact.callExpression.getSourceFile();
    const sourceDescriptor = getExtendedStableIdDescriptor(sourceFile, fact.callExpression);
    const callSiteNode = buildFlowNodeRow({
      kind: 'Call',
      stableId: {
        ...sourceDescriptor,
        value: stableId,
      },
      label: fact.callExpression.expression.getText(sourceFile),
      parentFnStableId: getStableIdDescriptor(fact.callerFn!.getSourceFile(), fact.callerFn!),
      sourceFilePath: sourceFile.fileName,
      operationIndex: -1,
      operationFields: {},
      extra: {
        labels: ['Call', 'CallSite', 'ExecutionOccurrence'],
        diaName: fact.callExpression.expression.getText(sourceFile),
        actionTextRaw: fact.callExpression.getText(sourceFile),
        sourceCallStableId: fact.callStableId,
        parameterOriginTargetFnStableId: fact.targetFnStableId,
        annotationKind: 'CallSite',
        flowLayer: 'control',
        renderPartsJson: JSON.stringify([{
          stableId,
          text: fact.callExpression.expression.getText(sourceFile),
          kind: 'method',
          labels: ['Call', 'CallSite'],
          order: 0,
          sourceStableId: fact.callStableId,
        } satisfies RenderPartDescriptor]),
        renderPartsLayout: 'single',
        renderPrimaryPartIndex: 0,
      },
    }) as FlowNodeRow;
    payload.nodes.push(callSiteNode);
    nodeById.set(stableId, callSiteNode);
    return callSiteNode;
  };

  for (const fact of facts) {
    if (!targetFunctionIds.has(fact.targetFnStableId) || !fact.callerFn || !fact.callerFnStableId) continue;
    const sourceFile = fact.callExpression.getSourceFile();
    if (!functionIds.has(fact.callerFnStableId)) {
      payload.functions.push({
        stableId: getStableIdDescriptor(fact.callerFn.getSourceFile(), fact.callerFn),
        name: getFunctionName(fact.callerFn),
        label: getFunctionName(fact.callerFn),
        repoRelativePath: getRepoRelativePath(fact.callerFn.getSourceFile().fileName),
        labels: functionSemanticLabels(
          fact.callerFn,
          accessorIndex.roleByFunctionStableId.get(fact.callerFnStableId),
        ),
      });
      functionIds.add(fact.callerFnStableId);
    }

    const parameterOriginCallSite = ensureParameterOriginCallSite(fact);
    const parameterOriginCallSiteStableId = getStableIdKey(parameterOriginCallSite.stableId);

    addEdge({
      fromKind: undefined,
      fromId: parameterOriginCallSiteStableId,
      toKind: 'Fn',
      toId: fact.targetFnStableId,
      type: 'CALL',
      label: '',
      displayLabel: '',
      callTextRaw: fact.callExpression.getText(sourceFile),
      callSiteStableId: parameterOriginCallSiteStableId,
      invocationType: 'CALL',
      flowLayer: 'control',
      mainFlow: false,
      protocolRole: fact.callbackDispatch ? 'callback invocation' : 'direct invocation',
    });

    const argumentBindingNode = ensureArgumentBinding(fact);
    const argumentOriginalNode = ensureArgumentOriginal(fact, argumentBindingNode);
    const argumentOriginalStableId = getStableIdKey(argumentOriginalNode.stableId);

    addEdge({
      fromKind: undefined,
      fromId: parameterOriginCallSiteStableId,
      toKind: undefined,
      toId: argumentOriginalStableId,
      type: 'MATERIALIZES_ARGUMENT',
      label: fact.argumentText,
      displayLabel: fact.argumentText,
      callSiteStableId: parameterOriginCallSiteStableId,
      argumentName: fact.parameterName,
      argumentIndex: fact.parameterIndex,
      flowLayer: 'control',
      semanticExpansion: 'call-execution',
      sequenceOrder: fact.parameterIndex,
      protocolRole: 'actual argument',
    });
  }
}

function validateExtractedGraph(payload: GraphExtractedPayload) {
  const nodeById = new Map(payload.nodes.map((node) => [getStableIdKey(node.stableId), node]));
  const functionIds = new Set(payload.functions.map((fn) => getStableIdKey(fn.stableId)));
  for (const node of payload.nodes) {
    const stableId = getStableIdKey(node.stableId);
    if (!node.labels.length) throw new Error(`Extracted node has no semantic labels: ${stableId}`);
    if (!node.flowLayer) throw new Error(`Extracted node has no flow layer: ${stableId}`);
    const renderParts = JSON.parse(node.renderPartsJson || '[]') as RenderPartDescriptor[];
    if (!renderParts.length) throw new Error(`Extracted node has no render-part structure: ${stableId}`);
    if (node.parentStepStableId) {
      const step = nodeById.get(node.parentStepStableId);
      if (!step?.labels.includes('Step')) {
        throw new Error(`Extracted node references a missing Step: ${stableId} -> ${node.parentStepStableId}`);
      }
    }
    if (node.parentFlowBlockStableId) {
      const block = nodeById.get(node.parentFlowBlockStableId);
      if (!block?.labels.includes('Block')) {
        throw new Error(`Extracted node references a missing FlowBlock: ${stableId} -> ${node.parentFlowBlockStableId}`);
      }
    }
  }
  for (const edge of payload.edges) {
    const externalContextReference = edge.contextOnly && edge.type === 'CAPTURES_VALUE';
    if (!externalContextReference && edge.fromKind !== 'Fn' && !nodeById.has(edge.fromId) && !functionIds.has(edge.fromId)) {
      throw new Error(`Extracted edge has a missing source: ${edge.fromId} -[${edge.type}]-> ${edge.toId}`);
    }
    if (!externalContextReference && edge.toKind !== 'Fn' && !nodeById.has(edge.toId) && !functionIds.has(edge.toId)) {
      throw new Error(`Extracted edge has a missing target: ${edge.fromId} -[${edge.type}]-> ${edge.toId}`);
    }
    if (!edge.flowLayer) {
      throw new Error(`Extracted edge has no flow layer: ${edge.fromId} -[${edge.type}]-> ${edge.toId}`);
    }
    if (!edge.flowRoles?.length || edge.displayLabel === undefined) {
      throw new Error(`Extracted edge has no final semantics: ${edge.fromId} -[${edge.type}]-> ${edge.toId}`);
    }
  }
}

export function createFunctionFlowExtractionContext(program: ts.Program, metadataOnly = false) {
  const checker = program.getTypeChecker();
  const stableIdByDeclaration = buildStableIdByDeclaration(program);
  const uniqueApiMethodTargetsByName = buildUniqueApiMethodTargets(program, stableIdByDeclaration);
  const uniqueActionTargetsByName = buildUniqueActionTargets(program, stableIdByDeclaration);
  const uniqueFunctionTargetsByName = buildUniqueFunctionTargets(program, stableIdByDeclaration);
  const reactStateProvenance = buildReactStateProvenance(program, checker);
  const accessorIndex = buildAccessorIndex(program, stableIdByDeclaration, getRepoRelativePath);
  const parameterOriginFacts = metadataOnly
    ? []
    : collectParameterOriginFacts(program, stableIdByDeclaration);
  const completeCanonicalReferenceGraph = metadataOnly
    ? undefined
    : collectCanonicalReferenceGraph(program);
  return {
    program,
    checker,
    stableIdByDeclaration,
    uniqueApiMethodTargetsByName,
    uniqueActionTargetsByName,
    uniqueFunctionTargetsByName,
    reactStateProvenance,
    accessorIndex,
    parameterOriginFacts,
    completeCanonicalReferenceGraph,
    metadataOnly,
  };
}

export type FunctionFlowExtractionContext = ReturnType<typeof createFunctionFlowExtractionContext>;

function collectFunctionFlowArtifacts(
  program: ts.Program,
  fnStableIdFilter?: string,
  fnNameFilter?: string,
  metadataOnly = false,
  preparedContext?: FunctionFlowExtractionContext,
): GraphExtractedPayload {
  if (preparedContext && preparedContext.program !== program) {
    throw new Error('Function-flow extraction context belongs to a different TypeScript program.');
  }
  if (preparedContext && preparedContext.metadataOnly !== metadataOnly) {
    throw new Error('Function-flow extraction context metadata mode does not match the request.');
  }
  const context = preparedContext || createFunctionFlowExtractionContext(program, metadataOnly);
  const {
    checker,
    stableIdByDeclaration,
    uniqueApiMethodTargetsByName,
    uniqueActionTargetsByName,
    uniqueFunctionTargetsByName,
    reactStateProvenance,
    accessorIndex,
    parameterOriginFacts,
    completeCanonicalReferenceGraph,
  } = context;
  const payload: GraphExtractedPayload = {
    functions: [],
    nodes: [],
    edges: [],
    semanticRelationships: [],
  };
  const valueProxyRegistry = createValueProxyMaterializationRegistry();
  const allFunctionRowsByStableId = new Map<string, FlowFunctionRow>();

  for (const resources of reactStateProvenance.resourcesBySetterSymbol.values()) {
    for (const resource of resources.values()) {
      if (allFunctionRowsByStableId.has(resource.setterStableId)) continue;
      allFunctionRowsByStableId.set(resource.setterStableId, {
        stableId: resource.setterStableIdDescriptor,
        name: resource.setterName,
        label: resource.setterName,
        repoRelativePath: resource.repoRelativePath,
        labels: ['Setter'],
      });
    }
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile)) {
      continue;
    }

    function visit(node: ts.Node): void {
      if (isFunctionLikeNode(node) && node.body) {
        const stableId = getStableId(sourceFile, node);
        const stableIdDescriptor = getStableIdDescriptor(sourceFile, node);
        const functionName = getFunctionName(node);
        const functionRow: FlowFunctionRow = {
          stableId: stableIdDescriptor,
          name: functionName,
          label: functionName,
          repoRelativePath: getRepoRelativePath(sourceFile.fileName),
          labels: functionSemanticLabels(node, accessorIndex.roleByFunctionStableId.get(stableId)),
        };
        allFunctionRowsByStableId.set(stableId, functionRow);
        const matchesStableId = !fnStableIdFilter || stableId === fnStableIdFilter;
        const matchesName = !fnNameFilter || functionName === fnNameFilter;
        if (matchesStableId && matchesName) {
          payload.functions.push(functionRow);

          if (!metadataOnly) {
            const builder = new FunctionFlowGraphBuilder(
              sourceFile,
              node,
              stableId,
              stableIdDescriptor,
              functionName,
              checker,
              stableIdByDeclaration,
              uniqueApiMethodTargetsByName,
              uniqueActionTargetsByName,
              uniqueFunctionTargetsByName,
              reactStateProvenance,
              accessorIndex,
              valueProxyRegistry,
            );
            const result = builder.build();
            payload.nodes.push(...result.nodes);
            payload.edges.push(...result.edges);
            payload.semanticRelationships.push(...(result.semanticRelationships || []));
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  attachParameterOrigins(payload, parameterOriginFacts, accessorIndex);

  const emittedFunctionIds = new Set(payload.functions.map((row) => getStableIdKey(row.stableId)));
  for (const edge of payload.edges) {
    for (const [kind, stableId] of [[edge.fromKind, edge.fromId], [edge.toKind, edge.toId]] as const) {
      if (kind !== 'Fn' || emittedFunctionIds.has(stableId)) continue;
      const referenced = allFunctionRowsByStableId.get(stableId);
      if (!referenced) continue;
      payload.functions.push(referenced);
      emittedFunctionIds.add(stableId);
    }
  }

  attachReferencedMethodOwners(program, stableIdByDeclaration, payload);

  payload.functions.push(...buildSyntheticExternalFunctionRows(payload));

  const finalPayload = payload;
  const combinedFlowBlockAliases = new Map(finalPayload.nodes
    .filter((node) => node.combinedStepFlowBlock && node.combinedFlowBlockSourceStableId)
    .map((node) => [String(node.combinedFlowBlockSourceStableId), getStableIdKey(node.stableId)]));
  const resolveCombinedFlowBlock = (stableId: string | undefined) => {
    let current = stableId;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const next = combinedFlowBlockAliases.get(current);
      if (!next) break;
      current = next;
    }
    return current;
  };
  for (const node of finalPayload.nodes) {
    node.parentFlowBlockStableId = resolveCombinedFlowBlock(node.parentFlowBlockStableId);
  }
  for (const edge of finalPayload.edges) {
    if (edge.fromKind === undefined) edge.fromId = resolveCombinedFlowBlock(edge.fromId) || edge.fromId;
    if (edge.toKind === undefined) edge.toId = resolveCombinedFlowBlock(edge.toId) || edge.toId;
  }

  validateExtractedGraph(finalPayload);

  // Visibility belongs to a requested graph view, never to semantic extraction.
  // Keeping this boundary centralized also prevents legacy builder hints from
  // leaking into Neo4j or into another renderer.
  for (const node of finalPayload.nodes) delete node.renderHidden;
  for (const edge of finalPayload.edges) delete edge.renderHidden;

  finalPayload.nodes.sort((left, right) => {
    return getStableIdKey(left.stableId).localeCompare(getStableIdKey(right.stableId));
  });

  finalPayload.edges.sort((left, right) => {
    if (left.fromId !== right.fromId) {
      return left.fromId.localeCompare(right.fromId);
    }
    if (left.type !== right.type) {
      return left.type.localeCompare(right.type);
    }
    return left.toId.localeCompare(right.toId);
  });
  const storageGraph = buildStorageGraph(finalPayload.nodes);
  attachStorageBindings(finalPayload.edges, storageGraph.storageBindings);
  finalPayload.resources = storageGraph.storages;
  finalPayload.resourceEdges = storageGraph.storageEdges;
  finalPayload.resourceLinks = storageGraph.storageLinks;
  if (!metadataOnly) attachFiniteLiteralDomains(program, finalPayload);
  if (!metadataOnly) {
    if (!completeCanonicalReferenceGraph) {
      throw new Error('Canonical reference graph is missing from the extraction context.');
    }
    const canonicalReferenceGraph = fnStableIdFilter
      ? scopeCanonicalReferenceGraph(completeCanonicalReferenceGraph, fnStableIdFilter)
      : completeCanonicalReferenceGraph;
    finalPayload.semanticEntities = [
      ...(finalPayload.semanticEntities || []),
      ...canonicalReferenceGraph.entities,
    ];
    finalPayload.semanticRelationships = [
      ...(finalPayload.semanticRelationships || []),
      ...canonicalReferenceGraph.relationships,
    ];
    const semanticRelationshipKeys = new Set(finalPayload.semanticRelationships.map((relationship) => (
      `${relationship.fromId}\u0000${relationship.type}\u0000${relationship.toId}`
    )));
    for (const node of finalPayload.nodes) {
      const fromId = getStableIdKey(node.stableId);
      if (node.labels.includes('PresentationOnly') || fromId.includes(':horizontal-owner-')) continue;
      if (!node.stateResourceStableId || !['write', 'clear'].includes(node.stateUpdateAction || '')) continue;
      const toId = String(node.stateResourceStableId);
      if (!fromId || !toId || fromId === toId) continue;
      const key = `${fromId}\u0000WRITES_TO\u0000${toId}`;
      if (semanticRelationshipKeys.has(key)) continue;
      finalPayload.semanticRelationships.push({
        fromId,
        toId,
        type: 'WRITES_TO',
        props: {
          layer: 'functional',
          resolution: 'react-state-provenance',
          stateUpdateAction: node.stateUpdateAction,
        },
      });
      semanticRelationshipKeys.add(key);
    }
    attachImmediateStepOperationGraph(finalPayload);
    attachSyntaxCompositionGraph(finalPayload);
  }
  return finalPayload;
}

export function extractFunctionFlowGraphs(
  program: ts.Program,
  fnStableIdFilter?: string,
  preparedContext?: FunctionFlowExtractionContext,
): GraphExtractedPayload {
  const {
    functions,
    nodes,
    edges,
    resources,
    resourceEdges,
    resourceLinks,
    semanticEntities,
    semanticRelationships,
  } = collectFunctionFlowArtifacts(program, fnStableIdFilter, undefined, false, preparedContext);

  return {
    functions,
    nodes,
    edges,
    resources,
    resourceEdges,
    resourceLinks,
    semanticEntities,
    semanticRelationships,
  };
}

function isEntrypoint() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

function compactFunctionForTransport(row: FlowFunctionRow): FlowFunctionTransportRow {
  const { stableId, ...rest } = row;
  return {
    ...rest,
    stableId: getStableIdKey(stableId),
    labels: ['Fn', ...(row.labels || []).filter((label) => label !== 'Fn')],
    annotationKind: row.annotationKind || 'Callable',
    flowLayer: 'control',
    sourceStateId: stableId.sourceStateId,
    filePath: stableId.filePath,
    repoRelativePath: row.repoRelativePath || stableId.repoRelativePath || '',
    startLine: stableId.startLine,
    startColumn: stableId.startColumn,
    endLine: stableId.endLine,
    endColumn: stableId.endColumn,
    stableIdSuffix: stableId.suffix,
  };
}

function compactNodeForTransport(row: FlowNodeRow): FlowNodeTransportRow {
  const {
    operationDetailJson,
    stableId,
    parentFnStableId,
    calleeStableId,
    conditionStableId,
    ...rest
  } = row;
  if (!row.labels.length) {
    throw new Error(`Flow node ${getStableIdKey(stableId)} has no semantic labels.`);
  }
  return {
    ...rest,
    stableId: getStableIdKey(stableId),
    sourceStateId: stableId.sourceStateId,
    filePath: stableId.filePath,
    repoRelativePath: row.repoRelativePath || stableId.repoRelativePath || '',
    startLine: stableId.startLine,
    startColumn: stableId.startColumn,
    endLine: stableId.endLine,
    endColumn: stableId.endColumn,
    stableIdSuffix: stableId.suffix,
    parentFnStableId: getStableIdKey(parentFnStableId),
    ...(calleeStableId ? { calleeStableId: getStableIdKey(calleeStableId) } : {}),
    ...(conditionStableId ? { conditionStableId: getStableIdKey(conditionStableId) } : {}),
    operationDetailPresent: Boolean(operationDetailJson),
    operationDetailSize: operationDetailJson ? Buffer.byteLength(operationDetailJson) : 0,
    primaryLabel: row.labels[0],
    annotationKind: row.annotationKind || annotationKindForNode(row.labels),
  };
}

function withCanonicalTransportProps<TRow extends ArtifactTransportRow>(
  kind: ArtifactKind,
  row: TRow,
): TRow & { props: Record<string, unknown> } {
  const canonical = toCanonicalArtifact(kind, row);
  return {
    ...row,
    props: canonical.props,
  };
}

export function payloadForTransport(payload: GraphExtractedPayload, provenance = captureExtractionProvenance()) {
  const result = {
    ...payload,
    provenance,
    functions: payload.functions.map((row) => withCanonicalTransportProps(
      'function',
      compactFunctionForTransport(row),
    )),
    nodes: payload.nodes.map((row) => withCanonicalTransportProps(
      'node',
      compactNodeForTransport(row),
    )),
    edges: payload.edges.map((row) => withCanonicalTransportProps('edge', row)),
    resources: (payload.resources || []).map((row) => withCanonicalTransportProps('resource', row)),
    resourceEdges: (payload.resourceEdges || []).map((row) => withCanonicalTransportProps('resourceEdge', row)),
    resourceLinks: (payload.resourceLinks || []).map((row) => withCanonicalTransportProps('resourceLink', row)),
    semanticEntities: (payload.semanticEntities || []).map((row) => withCanonicalTransportProps('semanticEntity', row)),
    semanticRelationships: (payload.semanticRelationships || []).map((row) => withCanonicalTransportProps('semanticRelationship', row)),
  };
  for(const key of ['functions','nodes','edges','resources','resourceEdges','resourceLinks','semanticEntities','semanticRelationships'] as const)
    for(const row of result[key])row.props.provenance_id=provenance.id;
  return result;
}

function writePayloadToFile(outputPath: string, payload: GraphExtractedPayload, provenance = captureExtractionProvenance()) {
  const fileDescriptor = fs.openSync(outputPath, 'w');

  try {
    fs.writeSync(fileDescriptor, `{"provenance":${JSON.stringify(provenance)},"functions":[`);

    payload.functions.map((row) => withCanonicalTransportProps(
      'function',
      compactFunctionForTransport(row),
    )).forEach((row, index) => {
      if (index) {
        fs.writeSync(fileDescriptor, ',');
      }

      fs.writeSync(fileDescriptor, JSON.stringify({...row, props:{...row.props, provenance_id:provenance.id}}));
    });

    fs.writeSync(fileDescriptor, '],"nodes":[');

    payload.nodes.map((row) => withCanonicalTransportProps(
      'node',
      compactNodeForTransport(row),
    )).forEach((row, index) => {
      if (index) {
        fs.writeSync(fileDescriptor, ',');
      }

      fs.writeSync(fileDescriptor, JSON.stringify({...row, props:{...row.props, provenance_id:provenance.id}}));
    });

    fs.writeSync(fileDescriptor, '],"edges":[');

    payload.edges.map((row) => withCanonicalTransportProps('edge', row)).forEach((row, index) => {
      if (index) {
        fs.writeSync(fileDescriptor, ',');
      }

      fs.writeSync(fileDescriptor, JSON.stringify({...row, props:{...row.props, provenance_id:provenance.id}}));
    });

    fs.writeSync(fileDescriptor, '],"resources":[');
    (payload.resources || []).map((row) => withCanonicalTransportProps('resource', row)).forEach((row, index) => {
      if (index) fs.writeSync(fileDescriptor, ',');
      fs.writeSync(fileDescriptor, JSON.stringify({...row, props:{...row.props, provenance_id:provenance.id}}));
    });

    fs.writeSync(fileDescriptor, '],"resourceEdges":[');
    (payload.resourceEdges || []).map((row) => withCanonicalTransportProps('resourceEdge', row)).forEach((row, index) => {
      if (index) fs.writeSync(fileDescriptor, ',');
      fs.writeSync(fileDescriptor, JSON.stringify({...row, props:{...row.props, provenance_id:provenance.id}}));
    });

    fs.writeSync(fileDescriptor, '],"resourceLinks":[');
    (payload.resourceLinks || []).map((row) => withCanonicalTransportProps('resourceLink', row)).forEach((row, index) => {
      if (index) fs.writeSync(fileDescriptor, ',');
      fs.writeSync(fileDescriptor, JSON.stringify({...row, props:{...row.props, provenance_id:provenance.id}}));
    });

    fs.writeSync(fileDescriptor, '],"semanticEntities":[');
    (payload.semanticEntities || []).map((row) => withCanonicalTransportProps('semanticEntity', row)).forEach((row, index) => {
      if (index) fs.writeSync(fileDescriptor, ',');
      fs.writeSync(fileDescriptor, JSON.stringify({...row, props:{...row.props, provenance_id:provenance.id}}));
    });

    fs.writeSync(fileDescriptor, '],"semanticRelationships":[');
    (payload.semanticRelationships || []).map((row) => withCanonicalTransportProps('semanticRelationship', row)).forEach((row, index) => {
      if (index) fs.writeSync(fileDescriptor, ',');
      fs.writeSync(fileDescriptor, JSON.stringify({...row, props:{...row.props, provenance_id:provenance.id}}));
    });

    fs.writeSync(fileDescriptor, ']}\n');
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

type ArtifactKind = 'function' | 'node' | 'edge' | 'resource' | 'resourceEdge' | 'resourceLink' | 'semanticEntity' | 'semanticRelationship';
type ArtifactTransportRow = FlowFunctionTransportRow | FlowNodeTransportRow | FlowEdgeRow | StorageNode | StorageEdge | StorageLink | CanonicalEntity | CanonicalRelationship;
type ArtifactSink = (kind: ArtifactKind, row: ArtifactTransportRow) => void;

type ArtifactWriter = {
  close: () => void;
  writeEdge: (row: FlowEdgeRow) => void;
  writeFunction: (row: FlowFunctionRow) => void;
  writeNode: (row: FlowNodeRow) => void;
  writeResource: (row: StorageNode) => void;
  writeResourceEdge: (row: StorageEdge) => void;
  writeResourceLink: (row: StorageLink) => void;
  writeSemanticEntity: (row: CanonicalEntity) => void;
  writeSemanticRelationship: (row: CanonicalRelationship) => void;
};

function createArtifactWriter(auditIdentities = false, sink?: ArtifactSink): ArtifactWriter {
  const auditCounts = new Map<string, number>();
  const auditOwners = new Map<string, string>();
  const auditDuplicates = new Map<string, number>();
  const auditOwnerConflicts = new Map<string, Set<string>>();
  const auditFunctionNames = new Map<string, string>();
  const auditNodeCountsByOwner = new Map<string, number>();
  const auditEdgeCountsByOwner = new Map<string, number>();
  const auditLabelCounts = new Map<string, number>();
  const auditBytesByKind = new Map<string, number>();

  function writeRecord(
    kind: ArtifactKind,
    row: ArtifactTransportRow,
  ) {
    auditCounts.set(kind, (auditCounts.get(kind) || 0) + 1);
    if (auditIdentities) {
      auditBytesByKind.set(kind, (auditBytesByKind.get(kind) || 0) + Buffer.byteLength(JSON.stringify(row)));
      return;
    }
    if (!sink) throw new Error('Function-flow artifact sink is not configured.');
    sink(kind, row);
  }

  return {
    writeFunction(row) {
      if (auditIdentities) {
        const stableId = getStableIdKey(row.stableId);
        auditIdentity('function', stableId, '');
        auditFunctionNames.set(stableId, row.name);
      }
      writeRecord('function', compactFunctionForTransport(row));
    },
    writeNode(row) {
      if (auditIdentities) {
        const owner = getStableIdKey(row.parentFnStableId);
        auditIdentity('node', getStableIdKey(row.stableId), owner);
        auditNodeCountsByOwner.set(owner, (auditNodeCountsByOwner.get(owner) || 0) + 1);
        for (const label of row.labels) auditLabelCounts.set(label, (auditLabelCounts.get(label) || 0) + 1);
      }
      writeRecord('node', compactNodeForTransport(row));
    },
    writeEdge(row) {
      if (auditIdentities) {
        const fromId = getStableIdKey(row.fromId);
        const owner = row.fromKind === 'Fn' ? fromId : auditOwners.get(`node:${fromId}`) || '';
        auditEdgeCountsByOwner.set(owner, (auditEdgeCountsByOwner.get(owner) || 0) + 1);
        writeRecord('edge', row);
        return;
      }
      writeRecord('edge', row);
    },
    writeResource(row) {
      writeRecord('resource', row);
    },
    writeResourceEdge(row) {
      writeRecord('resourceEdge', row);
    },
    writeResourceLink(row) {
      writeRecord('resourceLink', row);
    },
    writeSemanticEntity(row) {
      writeRecord('semanticEntity', row);
    },
    writeSemanticRelationship(row) {
      writeRecord('semanticRelationship', row);
    },
    close() {
      if (auditIdentities) {
        const duplicateCounts = { function: 0, node: 0 };
        for (const key of auditDuplicates.keys()) duplicateCounts[key.slice(0, key.indexOf(':')) as 'function' | 'node'] += 1;
        process.stdout.write(`${JSON.stringify({
          counts: Object.fromEntries(auditCounts),
          uniqueFunctions: [...auditOwners.keys()].filter((key) => key.startsWith('function:')).length,
          uniqueNodes: [...auditOwners.keys()].filter((key) => key.startsWith('node:')).length,
          duplicateIdentityCounts: duplicateCounts,
          duplicateExtraRecords: [...auditDuplicates.values()].reduce((sum, occurrences) => sum + occurrences - 1, 0),
          ownerConflictCount: auditOwnerConflicts.size,
          ownerConflicts: [...auditOwnerConflicts.entries()].slice(0, 20).map(([key, owners]) => ({ key, owners: [...owners] })),
          topDuplicates: [...auditDuplicates.entries()]
            .sort((left, right) => right[1] - left[1])
            .slice(0, 30)
            .map(([key, occurrences]) => ({ key, occurrences })),
          functionsWithNoNodes: [...auditFunctionNames.keys()].filter((stableId) => !auditNodeCountsByOwner.has(stableId)).length,
          topFunctionsByNodes: topFunctionCounts(auditNodeCountsByOwner),
          topFunctionsByEdges: topFunctionCounts(auditEdgeCountsByOwner),
          topNodeLabels: [...auditLabelCounts.entries()]
            .sort((left, right) => right[1] - left[1])
            .slice(0, 30)
            .map(([label, count]) => ({ label, count })),
          serializedBytesByKind: Object.fromEntries(auditBytesByKind),
          serializedBytesTotal: [...auditBytesByKind.values()].reduce((sum, bytes) => sum + bytes, 0),
        }, null, 2)}\n`);
      }
    },
  };

  function auditIdentity(kind: 'function' | 'node', stableId: string, owner: string) {
    if (!stableId) return;
    const key = `${kind}:${stableId}`;
    if (!auditOwners.has(key)) {
      auditOwners.set(key, owner);
      return;
    }
    auditDuplicates.set(key, (auditDuplicates.get(key) || 1) + 1);
    const previousOwner = auditOwners.get(key) || '';
    if (previousOwner !== owner) {
      const owners = auditOwnerConflicts.get(key) || new Set([previousOwner]);
      owners.add(owner);
      auditOwnerConflicts.set(key, owners);
    }
  }

  function topFunctionCounts(counts: Map<string, number>) {
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 30)
      .map(([stableId, count]) => ({ stableId, name: auditFunctionNames.get(stableId), count }));
  }
}

function writeFunctionFlowArtifacts(program: ts.Program, writer: ArtifactWriter, metadataOnly = false) {
  const checker = program.getTypeChecker();
  const finiteLiteralGraph = metadataOnly ? undefined : collectFiniteLiteralDomainGraph(program);
  const stableIdByDeclaration = buildStableIdByDeclaration(program);
  const uniqueApiMethodTargetsByName = buildUniqueApiMethodTargets(program, stableIdByDeclaration);
  const uniqueActionTargetsByName = buildUniqueActionTargets(program, stableIdByDeclaration);
  const uniqueFunctionTargetsByName = buildUniqueFunctionTargets(program, stableIdByDeclaration);
  const reactStateProvenance = buildReactStateProvenance(program, checker);
  const accessorIndex = buildAccessorIndex(program, stableIdByDeclaration, getRepoRelativePath);
  const parameterOriginFactsByTarget = new Map<string, ParameterOriginFact[]>();
  if (!metadataOnly) {
    for (const fact of collectParameterOriginFacts(program, stableIdByDeclaration)) {
      parameterOriginFactsByTarget.set(
        fact.targetFnStableId,
        [...(parameterOriginFactsByTarget.get(fact.targetFnStableId) || []), fact],
      );
    }
  }
  const functionRows: FlowFunctionRow[] = [];
  const valueProxyRegistry = createValueProxyMaterializationRegistry();

  {
    const emittedReactSetterIds = new Set<string>();
    for (const resources of reactStateProvenance.resourcesBySetterSymbol.values()) {
      for (const resource of resources.values()) {
        if (emittedReactSetterIds.has(resource.setterStableId)) continue;
        emittedReactSetterIds.add(resource.setterStableId);
        writer.writeFunction({
          stableId: resource.setterStableIdDescriptor,
          name: resource.setterName,
          label: resource.setterName,
          repoRelativePath: resource.repoRelativePath,
          labels: ['Setter'],
        });
      }
    }

    for (const sourceFile of program.getSourceFiles()) {
      if (!isTrackedSourceFile(sourceFile)) {
        continue;
      }

      function visit(node: ts.Node): void {
        if (isFunctionLikeNode(node) && node.body) {
          const stableId = getStableId(sourceFile, node);
          const stableIdDescriptor = getStableIdDescriptor(sourceFile, node);
          const functionName = getFunctionName(node);
          functionRows.push({
            stableId: stableIdDescriptor,
            name: functionName,
            label: functionName,
            repoRelativePath: getRepoRelativePath(sourceFile.fileName),
            labels: functionSemanticLabels(node, accessorIndex.roleByFunctionStableId.get(stableId)),
          });
        }

        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
    }

    const functionsPayload: GraphExtractedPayload = {
      functions: functionRows,
      nodes: [],
      edges: [],
    };
    for (const fnRow of functionsPayload.functions) {
      writer.writeFunction(fnRow);
    }
    const methodOwnerPayload: GraphExtractedPayload = { functions: functionRows, nodes: [], edges: [] };
    attachReferencedMethodOwners(program, stableIdByDeclaration, methodOwnerPayload, true);
    for (const nodeRow of methodOwnerPayload.nodes) writer.writeNode(nodeRow);
    for (const edgeRow of methodOwnerPayload.edges) writer.writeEdge(edgeRow);

    for (const target of SYNTHETIC_EXTERNAL_TARGETS_BY_KEY.values()) {
      const accessorRole = accessorIndex.roleForExternalAccessor(target.name);
      writer.writeFunction({
        stableId: buildOpaqueStableIdDescriptor(target.stableId, target.repoRelativePath || EXTERNAL_BROWSER_MEDIA_REPO_PATH),
        name: target.name || '<anonymous>',
        label: target.name || '<anonymous>',
        repoRelativePath: target.repoRelativePath || EXTERNAL_BROWSER_MEDIA_REPO_PATH,
        labels: ['External', ...(accessorRole ? [accessorRole] : [])],
        isExternal: true,
      });
    }

    if (metadataOnly) {
      return;
    }

    const canonicalReferenceGraph = collectCanonicalReferenceGraph(program);
    const operationIds = collectOperationIds(canonicalReferenceGraph.entities);
    for (const entity of canonicalReferenceGraph.entities) writer.writeSemanticEntity(entity);
    for (const relationship of canonicalReferenceGraph.relationships) writer.writeSemanticRelationship(relationship);

    for (const entity of finiteLiteralGraph?.entities || []) writer.writeSemanticEntity(entity);
    for (const relationship of finiteLiteralGraph?.relationships || []) writer.writeSemanticRelationship(relationship);

    for (const sourceFile of program.getSourceFiles()) {
      if (!isTrackedSourceFile(sourceFile)) {
        continue;
      }

      function visit(node: ts.Node): void {
        if (isFunctionLikeNode(node) && node.body) {
          const stableId = getStableId(sourceFile, node);
          const stableIdDescriptor = getStableIdDescriptor(sourceFile, node);
          const functionName = getFunctionName(node);
          const builder = new FunctionFlowGraphBuilder(
            sourceFile,
            node,
            stableId,
            stableIdDescriptor,
            functionName,
            checker,
            stableIdByDeclaration,
            uniqueApiMethodTargetsByName,
            uniqueActionTargetsByName,
            uniqueFunctionTargetsByName,
            reactStateProvenance,
            accessorIndex,
            valueProxyRegistry,
          );
          const result = {
            functions: [stableIdDescriptor].map((descriptor) => ({
              stableId: descriptor,
              name: functionName,
              label: functionName,
              repoRelativePath: getRepoRelativePath(sourceFile.fileName),
            })),
            ...builder.build(),
          } as GraphExtractedPayload;
          attachParameterOrigins(
            result,
            parameterOriginFactsByTarget.get(stableId) || [],
            accessorIndex,
          );
          if (finiteLiteralGraph) attachFiniteLiteralDomainsFromGraph(finiteLiteralGraph, result);
          const storageGraph = buildStorageGraph(result.nodes);
          attachStorageBindings(result.edges, storageGraph.storageBindings);
          attachImmediateStepOperationGraph(result, operationIds);
          attachSyntaxCompositionGraph(result);
          for (const nodeRow of result.nodes) {
            writer.writeNode(nodeRow);
          }
          for (const edgeRow of result.edges) {
            writer.writeEdge(edgeRow);
          }
          for (const storageRow of storageGraph.storages) writer.writeResource(storageRow);
          for (const storageEdgeRow of storageGraph.storageEdges) writer.writeResourceEdge(storageEdgeRow);
          for (const storageLinkRow of storageGraph.storageLinks) writer.writeResourceLink(storageLinkRow);
          for (const entity of result.semanticEntities || []) {
            writer.writeSemanticEntity(entity);
          }
          for (const relationship of result.semanticRelationships || []) {
            writer.writeSemanticRelationship(relationship);
          }
        }

        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
    }

    // External targets are discovered while function bodies are built, so emit
    // the final registry after that traversal as well. DuckDB canonicalization
    // merges any target that was already known during the metadata pass.
    for (const target of SYNTHETIC_EXTERNAL_TARGETS_BY_KEY.values()) {
      const accessorRole = accessorIndex.roleForExternalAccessor(target.name);
      writer.writeFunction({
        stableId: buildOpaqueStableIdDescriptor(target.stableId, target.repoRelativePath || EXTERNAL_BROWSER_MEDIA_REPO_PATH),
        name: target.name || '<anonymous>',
        label: target.name || '<anonymous>',
        repoRelativePath: target.repoRelativePath || EXTERNAL_BROWSER_MEDIA_REPO_PATH,
        labels: ['External', ...(accessorRole ? [accessorRole] : [])],
        isExternal: true,
      });
    }
  }
}

const GRAPH_SOURCE = 'semantic/functionFlowGraph';
const GRAPH_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NODE_PROPERTY_MAP: Record<string, string> = {
  sourceStateId: 'source_state_id', filePath: 'file_path',
  startLine: 'start_line', startColumn: 'start_column', endLine: 'end_line', endColumn: 'end_column',
  stableIdSuffix: 'stableIdSuffix', label: 'label', diaName: 'diaName', parentFnStableId: 'parentFnStableId',
  repoRelativePath: 'repo_relative_path', operationIndex: 'operation_index', operationCode: 'operation_code',
  operationSubjectText: 'operation_subject_text', operationValueText: 'operation_value_text',
  relativeAccessText: 'relative_access_text',
  operationCalleeText: 'operation_callee_text', operationDetailPresent: 'operation_detail_present',
  operationDetailSize: 'operation_detail_size', conditionRaw: 'condition_raw', conditionStableId: 'conditionStableId',
  actionTextRaw: 'action_text_raw', callTextRaw: 'call_text_raw', calleeStableId: 'calleeStableId',
  calleeName: 'callee_name', joinKind: 'join_kind', mergeLabel: 'merge_label', incomingEdgeTypes: 'incoming_edge_types',
  flowJoinEntrySourceStableId: 'flowJoinEntrySourceStableId',
  flowJoinBackboneSourceStableId: 'flowJoinBackboneSourceStableId',
  flowJoinPlacementSourceStableId: 'flowJoinPlacementSourceStableId',
  flowLaneStableId: 'flowLaneStableId', parentFlowLaneStableId: 'parentFlowLaneStableId',
  flowLaneDepth: 'flowLaneDepth', flowLaneRole: 'flowLaneRole',
  flowJoinEntryIndex: 'flowJoinEntryIndex', flowJoinEntryCount: 'flowJoinEntryCount',
  inlineStepTerminalJoin: 'inlineStepTerminalJoin',
  synthetic: 'synthetic', declaredReturnType: 'declaredReturnType', callbackKind: 'callback_kind', callbackDeferred: 'callback_deferred',
  callbackParameterNames: 'callback_parameter_names', asyncSchedulerKind: 'async_scheduler_kind',
  asyncContract: 'async_contract', invocationMode: 'invocation_mode', responseMode: 'response_mode',
  stateResourceStableId: 'state_resource_stableId',
  stateResourceParentFnStableId: 'state_resource_parent_fn_stableId',
  stateResourceRepoRelativePath: 'state_resource_repo_relative_path', stateResourceName: 'state_resource_name',
  stateSetterName: 'state_setter_name', stateUpdateAction: 'state_update_action',
  sourceDocumentation: 'source_documentation', uiSlotName: 'ui_slot_name',
  virtualViewKind: 'virtual_view_kind', variableDeclarationKind: 'variable_declaration_kind',
  valueSlotStableId: 'value_slot_stableId', valueSlotStableIds: 'value_slot_stableIds', valueName: 'value_name',
  valueNames: 'value_names', valueScope: 'value_scope', valueScopes: 'value_scopes', valueAction: 'value_action',
  valueActions: 'value_actions', valueOperationSyntax: 'value_operation_syntax',
  foldStepOwnerStableId: 'foldStepOwnerStableId', parentStepStableId: 'parentStepStableId',
  flowStepKind: 'flowStepKind', flowStepOrder: 'flowStepOrder',
  syntaxEntryStableId: 'syntaxEntryStableId',
  syntaxExitStableIds: 'syntaxExitStableIds',
  structureDepth: 'structureDepth',
  structureRelativeColumn: 'structureRelativeColumn',
  structureRelativeRow: 'structureRelativeRow',
  representationMode: 'representationMode',
  representationEstimatedColumns: 'representationEstimatedColumns',
  representationEstimatedRows: 'representationEstimatedRows',
  parentLocalFunctionStableId: 'parentLocalFunctionStableId',
  localFunctionName: 'localFunctionName',
  localFunctionDepth: 'localFunctionDepth',
  declaredByStableId: 'declaredByStableId',
  containsUiInjection: 'containsUiInjection',
  proxyRole: 'proxyRole',
  proxyReason: 'proxyReason',
  headStableIds: 'headStableIds', tailStableIds: 'tailStableIds',
  parentFlowBlockStableId: 'parentFlowBlockStableId',
  ownerBranchStableIds: 'ownerBranchStableIds',
  flowBlockRole: 'flowBlockRole', flowBlockOutcome: 'flowBlockOutcome',
  flowBlockOrder: 'flowBlockOrder',
  combinedStepFlowBlock: 'combinedStepFlowBlock',
  combinedFlowBlockSourceStableId: 'combinedFlowBlockSourceStableId',
  moduleSpecifier: 'module_specifier', resolvedModulePath: 'resolved_module_path', missingReason: 'missing_reason',
  missingComponentStableId: 'missing_component_stableId', missingMethodName: 'missing_method_name',
  gatedByFeatureNames: 'gated_by_feature_names', collectionMethod: 'collectionMethod',
  collectionHeadStableId: 'collectionHeadStableId', collectionPreviousStageStableId: 'collectionPreviousStageStableId',
  collectionIterationMode: 'collection_iteration_mode', collectionResultMode: 'collection_result_mode',
  collectionShortCircuit: 'collection_short_circuit', collectionReverse: 'collection_reverse',
  collectionMutatesReceiver: 'collection_mutates_receiver', collectionLoopStableId: 'collection_loop_stable_id',
  collectionIterationStableId: 'collection_iteration_stable_id',
  collectionCallbackStableId: 'collection_callback_stable_id', semanticExpansion: 'semantic_expansion',
  sequenceAxisKind: 'sequence_axis_kind', sequenceOwnerStableId: 'sequence_owner_stable_id',
  executionScopeKind: 'execution_scope_kind',
  executionProtocolStableId: 'execution_protocol_stable_id',
  executionProtocolKind: 'execution_protocol_kind',
  executionRoles: 'execution_roles', executionRoleOrder: 'execution_role_order',
  executionRoleBindingsJson: 'execution_role_bindings_json',
  submethodsJson: 'submethods_json', submethodStableId: 'submethod_stable_id',
  parentSubmethodStableId: 'parent_submethod_stable_id',
  memberOfSubmethodStableId: 'member_of_submethod_stable_id',
  dataBranchOwnerStableId: 'data_branch_owner_stable_id',
  dataBranchFamilyRole: 'data_branch_family_role',
  nestedEvaluationDirection: 'nested_evaluation_direction',
  conditionalAlternativePlacement: 'conditional_alternative_placement',
  submethodPlacement: 'submethod_placement',
  submethodAnchorStableId: 'submethod_anchor_stable_id',
  submethodKind: 'submethod_kind', submethodOrder: 'submethod_order',
  submethodMemberOrder: 'submethod_member_order',
  submethodRelativeColumn: 'submethod_relative_column', submethodRelativeRow: 'submethod_relative_row',
  substepColumnOffset: 'substep_column_offset',
  substepRowOffset: 'substep_row_offset',
  snippetEntryStableId: 'snippet_entry_stable_id',
  primitiveKind: 'primitive_kind', executionOutcome: 'execution_outcome',
  runtimeEventKind: 'runtime_event_kind', instrumentationStrategy: 'instrumentation_strategy',
  instrumentationPhase: 'instrumentation_phase',
  instrumentationTargetStableId: 'instrumentation_target_stable_id',
  snippetExitStableId: 'snippet_exit_stable_id',
  sourceCallStableId: 'sourceCallStableId', canonicalStableId: 'canonicalStableId',
  originalStableId: 'originalStableId',
  proxyPredecessorStableIds: 'proxyPredecessorStableIds',
  bindingStableId: 'bindingStableId',
  resultOfCallStableId: 'resultOfCallStableId', resultTypeText: 'resultTypeText',
  parameterName: 'parameterName', parameterTypeText: 'parameterTypeText',
  argumentName: 'argument_name', argumentIndex: 'argument_index',
  parameterOriginTargetFnStableId: 'parameter_origin_target_fn_stable_id',
  fieldName: 'field_name', fieldIndex: 'field_index',
  annotationKind: 'annotationKind',
  flowLayer: 'flow_layer', dataFlowRole: 'data_flow_role',
  callBoundaryDesign: 'call_boundary_design', callBoundaryRole: 'call_boundary_role',
  callHasArguments: 'call_has_arguments', callPredicate: 'call_predicate',
  callBoundaryPeerStableId: 'call_boundary_peer_stable_id',
  callMosaicOwnerStableId: 'call_mosaic_owner_stable_id',
  callMosaicRole: 'call_mosaic_role',
  compactCallMosaic: 'compactCallMosaic',
  renderPartsJson: 'render_parts_json',
  renderPartsLayout: 'render_parts_layout',
  renderPrimaryPartIndex: 'render_primary_part_index',
  objectFamilyStableId: 'object_family_stable_id',
  objectBraceSide: 'object_brace_side',
  objectBracePairIndex: 'object_brace_pair_index',
  objectBracePairCount: 'object_brace_pair_count',
  objectBraceFieldIndicesJson: 'object_brace_field_indices_json',
  objectBraceMosaicNeighborStableId: 'object_brace_mosaic_neighbor_stable_id',
  opensObjectFieldFamily: 'opens_object_field_family',
  logicalNotPrefix: 'logical_not_prefix',
  methodChainOwnerStableId: 'method_chain_owner_stable_id',
  methodChainRole: 'method_chain_role',
  containerStableId: 'container_stable_id',
  containerMethodKind: 'container_method_kind',
  containerState: 'container_state',
  implementationCallStableId: 'implementation_call_stable_id',
  implementationCalleeName: 'implementation_callee_name',
  producerStartStableId: 'producer_start_stable_id',
  producerEndStableIds: 'producer_end_stable_ids',
  producerChainKind: 'producer_chain_kind',
};
const RESOURCE_PROPERTY_MAP: Record<string, string> = {
  parentFnStableId: 'parentFnStableId', repoRelativePath: 'repo_relative_path',
  resourceKind: 'resource_kind', resourceSubkind: 'resource_subkind', resourceName: 'resource_name',
  settingKind: 'setting_kind', settingSubkind: 'setting_subkind', settingName: 'setting_name',
  resourceSemanticId: 'resource_semantic_id', resourceSemanticDetailId: 'resource_semantic_detail_id',
  parentStableId: 'parentStableId', resourceCellName: 'resource_cell_name', resourceCellKind: 'resource_cell_kind',
  settingCellName: 'setting_cell_name', settingCellKind: 'setting_cell_kind',
  annotationKind: 'annotationKind',
  flowLayer: 'flow_layer', dataFlowRole: 'data_flow_role',
};

function requireTransportId(row: Record<string, unknown>, key: string, kind: string) {
  const value = row[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${kind}.${key} must be a non-empty string.`);
  return value.trim();
}

function validateGraphNames(value: unknown, kind: string) {
  if (!Array.isArray(value) || !value.length) throw new Error(`${kind}.labels must be a non-empty list.`);
  const labels = value.map((label) => String(label || ''));
  if (new Set(labels).size !== labels.length) throw new Error(`${kind}.labels must not contain duplicates.`);
  for (const label of labels) {
    if (!GRAPH_NAME_PATTERN.test(label)) throw new Error(`Invalid Neo4j label: ${JSON.stringify(label)}`);
  }
  return labels;
}

function validateRelationshipType(value: unknown) {
  const type = String(value || '');
  if (!GRAPH_NAME_PATTERN.test(type)) throw new Error(`Invalid Neo4j relationship type: ${JSON.stringify(type)}`);
  return type;
}

function mapGraphProperties(row: Record<string, unknown>, mapping: Record<string, string>) {
  const props: Record<string, unknown> = { source: GRAPH_SOURCE };
  for (const [sourceKey, targetKey] of Object.entries(mapping)) {
    if (row[sourceKey] !== undefined && row[sourceKey] !== null) props[targetKey] = row[sourceKey];
  }
  return props;
}

function toCanonicalArtifact(kind: ArtifactKind, value: ArtifactTransportRow): CanonicalEntity | CanonicalRelationship {
  const row = value as unknown as Record<string, unknown>;
  if (kind === 'semanticEntity') {
    const stableId = requireTransportId(row, 'stableId', kind);
    const labels = validateGraphNames(row.labels, kind);
    const props = row.props && typeof row.props === 'object' && !Array.isArray(row.props)
      ? { source: GRAPH_SOURCE, ...(row.props as Record<string, unknown>) }
      : { source: GRAPH_SOURCE };
    return { stableId, labels, props };
  }
  if (kind === 'semanticRelationship') {
    const fromId = requireTransportId(row, 'fromId', kind);
    const toId = requireTransportId(row, 'toId', kind);
    const type = validateRelationshipType(row.type);
    const props = row.props && typeof row.props === 'object' && !Array.isArray(row.props)
      ? { source: GRAPH_SOURCE, ...(row.props as Record<string, unknown>) }
      : { source: GRAPH_SOURCE };
    return { fromId, toId, type, props };
  }
  if (kind === 'function') {
    const stableId = requireTransportId(row, 'stableId', kind);
    const labels = validateGraphNames(row.labels, kind);
    if (labels[0] !== 'Fn') throw new Error(`function.labels[0] must be Fn for ${stableId}.`);
    return {
      stableId,
      labels,
      props: {
        source_state_id: row.sourceStateId,
        repo_relative_path: row.repoRelativePath,
        file_path: row.filePath,
        start_line: row.startLine,
        start_column: row.startColumn,
        end_line: row.endLine,
        end_column: row.endColumn,
        stableIdSuffix: row.stableIdSuffix,
        name: row.name,
        label: row.label || row.name,
        is_external: Boolean(row.isExternal),
        annotationKind: row.annotationKind || 'Callable',
        flow_layer: 'control',
        source: GRAPH_SOURCE,
      },
    };
  }
  if (kind === 'node' || kind === 'resource') {
    const stableId = requireTransportId(row, 'stableId', kind);
    if (kind === 'node') requireTransportId(row, 'parentFnStableId', kind);
    const labels = validateGraphNames(row.labels, kind);
    if (kind === 'node' && String(row.primaryLabel || '') !== labels[0]) {
      throw new Error(`node.primaryLabel must equal labels[0] for ${stableId}.`);
    }
    const props = mapGraphProperties(row, kind === 'node' ? NODE_PROPERTY_MAP : RESOURCE_PROPERTY_MAP);
    if (!props.flow_layer) throw new Error(`${kind}.flowLayer must be assigned by extraction.`);
    if (kind === 'resource' && !props.data_flow_role) props.data_flow_role = 'storage';
    return {
      stableId,
      labels,
      props,
    };
  }

  let fromId: string;
  let toId: string;
  let type: string;
  const props: Record<string, unknown> = { source: GRAPH_SOURCE };
  if (kind === 'edge') {
    fromId = requireTransportId(row, 'fromId', kind);
    toId = requireTransportId(row, 'toId', kind);
    type = validateRelationshipType(row.type);
    for (const [sourceKey, targetKey] of Object.entries({
      label: 'label', diaName: 'diaName', callTextRaw: 'call_text_raw', invocationMode: 'invocation_mode',
      responseMode: 'response_mode', storageStableIds: 'storage_stable_ids',
      mainFlow: 'main_flow', callSiteStableId: 'call_site_stable_id', invocationType: 'invocation_type',
      flowLayer: 'flow_layer',
      semanticExpansion: 'semantic_expansion', sequenceOrder: 'sequence_order',
      executionOutcome: 'execution_outcome', protocolRole: 'protocol_role',
      protocolRoles: 'protocol_roles',
      argumentName: 'argument_name', argumentIndex: 'argument_index',
      layoutFrame: 'layout_frame',
      argumentTextRaw: 'argument_text_raw',
      fieldName: 'field_name', fieldIndex: 'field_index',
      displayLabel: 'display_label', flowRoles: 'flow_roles',
      controlKind: 'control_kind', dataKind: 'data_kind',
      structureKind: 'structure_kind', effectKind: 'effect_kind',
      contextOnly: 'context_only',
      producerRouteRole: 'producer_route_role',
      producerOutcome: 'producer_outcome',
      optionalReturnGroupStableId: 'optional_return_group_stable_id',
      producerScopeStartOrder: 'producer_scope_start_order',
      producerScopeEndOrder: 'producer_scope_end_order',
      producerScopeStableIds: 'producer_scope_stable_ids',
      repeatOrigin: 'repeat_origin',
      oneWay: 'one_way',
      sourcePort: 'source_port', targetPort: 'target_port',
      sourcePortCandidates: 'source_port_candidates', targetPortCandidates: 'target_port_candidates',
      lockPortCandidates: 'lock_port_candidates',
      sourceRenderPartStableId: 'source_render_part_stable_id',
      targetRenderPartStableId: 'target_render_part_stable_id',
      elseIfChainBypass: 'else_if_chain_bypass',
    })) if (row[sourceKey] !== undefined && row[sourceKey] !== null) props[targetKey] = row[sourceKey];
    if (!props.flow_layer) throw new Error(`${kind}.flowLayer must be assigned by extraction.`);
  } else if (kind === 'resourceEdge') {
    fromId = requireTransportId(row, 'flowNodeStableId', kind);
    toId = requireTransportId(row, 'stableId', kind);
    type = validateRelationshipType(row.relType);
    for (const [sourceKey, targetKey] of Object.entries({
      accessType: 'access_type', calleeText: 'callee_text', asyncKind: 'async_kind', asyncPhase: 'async_phase',
      signalKind: 'signal_kind', continuationKind: 'continuation_kind', resourceCellName: 'resource_cell_name',
      parentStableId: 'parentStableId',
      flowLayer: 'flow_layer',
    })) if (row[sourceKey] !== undefined && row[sourceKey] !== null) props[targetKey] = row[sourceKey];
    if (!props.flow_layer) throw new Error(`${kind}.flowLayer must be assigned by the TS extractor.`);
  } else {
    fromId = requireTransportId(row, 'sourceStableId', kind);
    toId = requireTransportId(row, 'targetStableId', kind);
    type = validateRelationshipType(row.relType);
    if (row.label !== undefined && row.label !== null) props.label = row.label;
    if (row.calleeText !== undefined && row.calleeText !== null) props.callee_text = row.calleeText;
    if (row.flowLayer !== undefined && row.flowLayer !== null) props.flow_layer = row.flowLayer;
    if (!props.flow_layer) throw new Error(`${kind}.flowLayer must be assigned by the TS extractor.`);
  }
  return { fromId, toId, type, props };
}

async function writeFunctionFlowArtifactsDuckdb(
  program: ts.Program,
  stagingPath: string,
  parquetDir: string,
  metadataOnly = false,
  provenance = captureExtractionProvenance(),
) {
  const started = performance.now();
  let currentPhase = 'initialize';
  let currentRawEntities = 0;
  let currentRawRelationships = 0;
  const reportProgress = (phase: string, rawEntities = 0, rawRelationships = 0) => {
    currentPhase = phase;
    currentRawEntities = rawEntities;
    currentRawRelationships = rawRelationships;
    process.stderr.write(`[graph:func:stage] phase=${phase} rawEntities=${rawEntities} rawRelationships=${rawRelationships} elapsedSeconds=${((performance.now() - started) / 1000).toFixed(3)}\n`);
  };
  reportProgress('initialize');
  const heartbeat = setInterval(() => {
    process.stderr.write(`[graph:func:stage] phase=${currentPhase} heartbeat=true rawEntities=${currentRawEntities} rawRelationships=${currentRawRelationships} elapsedSeconds=${((performance.now() - started) / 1000).toFixed(3)}\n`);
  }, 10_000);
  heartbeat.unref();
  const stage = await FunctionFlowDuckdbStage.create(stagingPath, parquetDir, (progress) => {
    reportProgress(progress.phase, progress.rawEntities, progress.rawRelationships);
  }, provenance);
  const writer = createArtifactWriter(false, (kind, row) => {
    const normalized = toCanonicalArtifact(kind, row);
    if (kind === 'function' || kind === 'node' || kind === 'resource' || kind === 'semanticEntity') {
      stage.addEntity(kind, normalized as CanonicalEntity);
    } else {
      stage.addRelationship(kind, normalized as CanonicalRelationship);
    }
  });
  try {
    const extractStarted = performance.now();
    reportProgress('extract');
    writeFunctionFlowArtifacts(program, writer, metadataOnly);
    writer.close();
    const extractSeconds = Math.round(performance.now() - extractStarted) / 1000;
    const canonicalizeStarted = performance.now();
    assertExtractionUnchanged(provenance);
    const counts = await stage.finalize();
    const canonicalizeSeconds = Math.round(performance.now() - canonicalizeStarted) / 1000;
    process.stdout.write(`${JSON.stringify({
      ok: true,
      counts,
      stageSeconds: Math.round(performance.now() - started) / 1000,
      extractSeconds,
      canonicalizeSeconds,
      duckdbPath: path.resolve(stagingPath),
      parquetDir: path.resolve(parquetDir),
      parquetBytes: {
        nodes: fs.statSync(path.join(parquetDir, 'nodes.parquet')).size,
        relationships: fs.statSync(path.join(parquetDir, 'relationships.parquet')).size,
      },
    })}\n`);
  } catch (error) {
    stage.close();
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

async function main() {
  const provenance = captureExtractionProvenance();
  const {
    fnStableId,
    fnName,
    metadataOnly,
    outputPath,
    outputFormat,
    auditIdentities,
    stagingPath,
    parquetDir,
  } = parseFnStableIdArgs();
  const program = createProgram();
  if (outputFormat === 'duckdb') {
    if (fnStableId || fnName) {
      throw new Error('--output-format duckdb supports full-program extraction only.');
    }
    if (!stagingPath || !parquetDir) {
      throw new Error('--output-format duckdb requires --staging-path and --parquet-dir.');
    }
    await writeFunctionFlowArtifactsDuckdb(program, stagingPath, parquetDir, metadataOnly, provenance);
    return;
  }
  if (auditIdentities) {
    const writer = createArtifactWriter(true);
    writeFunctionFlowArtifacts(program, writer, metadataOnly);
    writer.close();
    return;
  }

  const payload = collectFunctionFlowArtifacts(program, fnStableId, fnName, metadataOnly);

  if (outputPath) {
    assertExtractionUnchanged(provenance);
    writePayloadToFile(outputPath, payload, provenance);
    return;
  }

  assertExtractionUnchanged(provenance);
  process.stdout.write(`${JSON.stringify(payloadForTransport(payload, provenance))}\n`);
}

if (isEntrypoint()) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
import {captureExtractionProvenance, assertExtractionUnchanged} from '../../../dev/extractionProvenance.mjs';
