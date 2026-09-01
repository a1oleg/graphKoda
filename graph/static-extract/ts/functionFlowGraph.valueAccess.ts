import ts from 'typescript';

import {
  getExtendedStableId,
  getExtendedStableIdDescriptor,
  getStableIdDescriptor,
  type StableIdDescriptor,
} from './functionFlowGraph.infrastructure.js';
import { getStableIdValue } from '../../packages/runtime-core/src/stableId.js';
import { classifyFlowEdge, type FlowRole } from './functionFlowGraph.edgeSemantics.js';

type ValueAction = 'create' | 'receive' | 'read' | 'write' | 'pass' | 'clear' | 'delete';

type ValueScope = 'local' | 'parameter' | 'captured' | 'module' | 'memory';

type ValueAccess = {
  slotStableId: string;
  name: string;
  scope: ValueScope;
  action: ValueAction;
  syntax?: string;
};

type FlowNode = {
  stableId: StableIdDescriptor;
  parentFnStableId: StableIdDescriptor;
  labels: string[];
  label: string;
  diaName?: string;
  repoRelativePath: string;
  operationIndex?: number;
  operationSubjectText?: string;
  operationValueText?: string;
  actionTextRaw?: string;
  asyncSchedulerKind?: string;
  stateResourceStableId?: string;
  stateResourceParentFnStableId?: string;
  stateResourceRepoRelativePath?: string;
  stateResourceName?: string;
  stateUpdateAction?: 'create' | 'write' | 'clear';
  parentStepStableId?: string;
  parentFlowBlockStableId?: string;
  sourceCallStableId?: string;
  canonicalStableId?: string;
  originalStableId?: string;
  proxyPredecessorStableIds?: string[];
  bindingStableId?: string;
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
  primitiveKind?: string;
  executionScopeKind?: string;
  collectionMethod?: string;
  renderPartsJson?: string;
  renderPartsLayout?: 'single' | 'horizontal' | 'vertical' | 'diagonal' | 'container-overlay' | 'container-overlay-side';
  renderPrimaryPartIndex?: number;
  flowLayer?: 'control' | 'data' | 'mixed' | 'structure';
  dataFlowRole?: 'input' | 'storage' | 'result' | 'access' | 'expression' | 'operation';
};

type FlowEdge = {
  fromKind: 'Fn' | undefined;
  fromId: string;
  toKind: 'Fn' | undefined;
  toId: string;
  type: string;
  label?: string;
  flowLayer?: 'control' | 'data' | 'mixed' | 'structure';
  displayLabel?: string;
  flowRoles?: FlowRole[];
  controlKind?: string;
  dataKind?: string;
  structureKind?: string;
  effectKind?: string;
  renderHidden?: boolean;
  contextOnly?: boolean;
};

type FlowPayload = {
  nodes: FlowNode[];
  edges: FlowEdge[];
  semanticRelationships?: Array<{
    fromId: string;
    toId: string;
    type: string;
    props: Record<string, unknown>;
  }>;
};

export type ValueProxyMaterializationRegistry = {
  proxyNodeIds: Set<string>;
  provenanceEdgeKeys: Set<string>;
};

export function createValueProxyMaterializationRegistry(): ValueProxyMaterializationRegistry {
  return {
    proxyNodeIds: new Set<string>(),
    provenanceEdgeKeys: new Set<string>(),
  };
}

export type FunctionValueAccessContext = {
  sourceFile: ts.SourceFile;
  fnNode: ts.FunctionLikeDeclaration;
  fnStableId: string;
  fnStableIdDescriptor: StableIdDescriptor;
};

type Binding = {
  symbol: ts.Symbol;
  nameNode: ts.Identifier;
  name: string;
  scope: ValueScope;
  declarationKind?: string;
  declaringFunction?: ts.FunctionLikeDeclaration;
  slotStableId: string;
  slotDescriptor: StableIdDescriptor;
  materializedStableId: string;
  materializedDescriptor: StableIdDescriptor;
  proxyPredecessorStableIds: string[];
  parentFnStableIdDescriptor: StableIdDescriptor;
};

const LEGACY_VALUE_LABELS = new Set(['Const', 'LocalValue', 'LocalMutation', 'StateUpdate']);

const ACTION_LABELS: Record<ValueAction, string> = {
  create: 'ValueCreate',
  receive: 'ValueReceive',
  read: 'ValueRead',
  write: 'ValueWrite',
  pass: 'ValuePass',
  clear: 'ValueClear',
  delete: 'ValueDelete',
};

type RenderPartDescriptor = {
  stableId: string;
  text: string;
  kind: string;
  labels: string[];
  order: number;
  fillState?: string;
  sourceStableId?: string;
  canonicalStableId?: string;
  bindingStableId?: string;
};

const ACTION_RELATIONSHIPS: Record<ValueAction, string> = {
  create: 'CREATES_VALUE',
  receive: 'RECEIVES_VALUE',
  read: 'READS_VALUE',
  write: 'WRITES_VALUE',
  pass: 'PASSES_VALUE',
  clear: 'CLEARS_VALUE',
  delete: 'DELETES_VALUE',
};

function unique(values: Array<string | undefined>) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function isCollectionMethodReceiverIdentifier(node: ts.Identifier, owner: FlowNode) {
  const isIteratorRoot = owner.primitiveKind === 'iterate' && owner.executionScopeKind === 'collection-iterator';
  const isExtractedShift = owner.labels.includes('Shift') && owner.labels.includes('Pull');
  const isCompositeCollectionMethod = owner.labels.includes('Collection') && owner.labels.includes('Method');
  if (!isIteratorRoot && !isExtractedShift && !isCompositeCollectionMethod) return false;
  const property = node.parent;
  return Boolean(
    ts.isPropertyAccessExpression(property)
    && property.expression === node
    && ts.isCallExpression(property.parent)
    && property.parent.expression === property,
  );
}

function isDirectAssignmentValueIdentifier(node: ts.Identifier) {
  const assignment = node.parent;
  return ts.isBinaryExpression(assignment)
    && assignment.right === node
    && assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken;
}

function isShorthandObjectFieldIdentifier(node: ts.Identifier) {
  return ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node;
}

function stableIdOf(node: FlowNode) {
  return getStableIdValue(node.stableId) || '';
}

function declarationKind(declaration: ts.VariableDeclaration) {
  const list = declaration.parent;
  if (!ts.isVariableDeclarationList(list)) return undefined;
  if (list.flags & ts.NodeFlags.Const) return 'const';
  if (list.flags & ts.NodeFlags.Let) return 'let';
  return 'var';
}

function containingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  let current: ts.Node | undefined = node;
  while (current) {
    if (
      ts.isFunctionDeclaration(current)
      || ts.isFunctionExpression(current)
      || ts.isArrowFunction(current)
      || ts.isMethodDeclaration(current)
      || ts.isGetAccessorDeclaration(current)
      || ts.isSetAccessorDeclaration(current)
      || ts.isConstructorDeclaration(current)
    ) return current;
    current = current.parent;
  }
  return undefined;
}

function collectBindingIdentifiers(name: ts.BindingName, result: ts.Identifier[] = []) {
  if (ts.isIdentifier(name)) {
    result.push(name);
    return result;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) collectBindingIdentifiers(element.name, result);
  }
  return result;
}

function isDeclarationIdentifier(node: ts.Identifier) {
  const parent = node.parent;
  return (
    (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent))
      && parent.name === node
  ) || (
    (ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent))
      && parent.name === node
  );
}

function isNonValueIdentifier(node: ts.Identifier) {
  if (node.text === 'undefined') return true;
  const parent = node.parent;
  // The callable position of a direct invocation is execution structure, not
  // application data. Its origin is already represented by the call target.
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node) return true;
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return true;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return true;
  if (ts.isTypeReferenceNode(parent) || ts.isQualifiedName(parent) || ts.isTypeQueryNode(parent)) return true;
  return false;
}

function descriptorContainsPosition(descriptor: StableIdDescriptor, line: number, column: number) {
  const startLine = descriptor.startLine || 0;
  const startColumn = descriptor.startColumn || 0;
  const endLine = descriptor.endLine || startLine;
  const endColumn = descriptor.endColumn || startColumn;
  const afterStart = line > startLine || (line === startLine && column >= startColumn);
  const beforeEnd = line < endLine || (line === endLine && column <= endColumn);
  return afterStart && beforeEnd;
}

function descriptorSpan(descriptor: StableIdDescriptor) {
  return ((descriptor.endLine || descriptor.startLine || 0) - (descriptor.startLine || 0)) * 100_000
    + Math.max(0, (descriptor.endColumn || descriptor.startColumn || 0) - (descriptor.startColumn || 0));
}

function ownerRank(node: FlowNode) {
  const labels = new Set(node.labels || []);
  if (labels.has('Parameter') && !labels.has('Field') && !labels.has('Join')) return -1;
  if (labels.has('Arg') || labels.has('Field') || labels.has('Operand')) return 0;
  if (labels.has('Branch')) return 1;
  if (labels.has('Call') || labels.has('Request') || labels.has('Op')) return 2;
  if (labels.has('FunctionEnd') || labels.has('Join')) return 9;
  return 3;
}

function findOwnerNode(nodes: FlowNode[], sourceFile: ts.SourceFile, identifier: ts.Identifier) {
  const position = sourceFile.getLineAndCharacterOfPosition(identifier.getStart(sourceFile));
  const line = position.line + 1;
  const column = position.character + 1;
  return nodes
    .filter((node) => !node.labels.every((label) => label === 'ValueSlot' || label === 'LocalBinding' || label === 'ParameterBinding'))
    .filter((node) => !node.labels.includes('Step') && !node.labels.includes('Block'))
    .filter((node) => (
      !node.labels.includes('TypeMember')
      && !node.labels.includes('ObjectTypeField')
      && !node.labels.includes('TypeFamilyClose')
    ))
    .filter((node) => descriptorContainsPosition(node.stableId, line, column))
    .sort((left, right) => descriptorSpan(left.stableId) - descriptorSpan(right.stableId)
      || ownerRank(left) - ownerRank(right)
      || (left.operationIndex ?? Number.MAX_SAFE_INTEGER) - (right.operationIndex ?? Number.MAX_SAFE_INTEGER))[0];
}

function nodeContains(root: ts.Node, target: ts.Node) {
  return target.getStart() >= root.getStart() && target.getEnd() <= root.getEnd();
}

function assignmentForIdentifier(identifier: ts.Identifier) {
  let current: ts.Node | undefined = identifier;
  while (current && !ts.isStatement(current) && !ts.isFunctionLike(current)) {
    if (ts.isBinaryExpression(current) && nodeContains(current.left, identifier)) {
      const token = current.operatorToken.kind;
      if (token >= ts.SyntaxKind.FirstAssignment && token <= ts.SyntaxKind.LastAssignment) return current;
    }
    current = current.parent;
  }
  return undefined;
}

function unaryMutationForIdentifier(identifier: ts.Identifier) {
  const parent = identifier.parent;
  if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
    && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) {
    return parent;
  }
  return undefined;
}

function isNullishExpression(expression: ts.Expression) {
  return expression.kind === ts.SyntaxKind.NullKeyword
    || ts.isIdentifier(expression) && expression.text === 'undefined'
    || ts.isVoidExpression(expression);
}

function isPassedValue(identifier: ts.Identifier, owner: FlowNode) {
  if (owner.labels.includes('Arg') || owner.labels.includes('Field')) return true;
  let current: ts.Node | undefined = identifier;
  while (current && !ts.isStatement(current) && !ts.isFunctionLike(current)) {
    const parent: ts.Node = current.parent;
    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.arguments?.some((argument) => nodeContains(argument, identifier))) return true;
    if (ts.isReturnStatement(parent) && parent.expression && nodeContains(parent.expression, identifier)) return true;
    if (ts.isPropertyAssignment(parent) && nodeContains(parent.initializer, identifier)) return true;
    if (ts.isArrayLiteralExpression(parent)) return true;
    current = parent;
  }
  return false;
}

function actionsForIdentifier(identifier: ts.Identifier, owner: FlowNode, binding: Binding): Array<{ action: ValueAction; syntax?: string }> {
  const sourceFile = identifier.getSourceFile();
  const assignment = assignmentForIdentifier(identifier);
  const unaryMutation = unaryMutationForIdentifier(identifier);
  const result: Array<{ action: ValueAction; syntax?: string }> = [];

  if (assignment) {
    const syntax = assignment.getText(sourceFile);
    if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) result.push({ action: 'read', syntax });
    result.push({ action: isNullishExpression(assignment.right) ? 'clear' : 'write', syntax });
  } else if (unaryMutation) {
    const syntax = unaryMutation.getText(sourceFile);
    result.push({ action: 'read', syntax }, { action: 'write', syntax });
  } else if (ts.isDeleteExpression(identifier.parent)) {
    result.push({ action: 'delete', syntax: identifier.parent.getText(sourceFile) });
  } else {
    result.push({ action: 'read' });
  }

  if (isPassedValue(identifier, owner)) result.push({ action: 'pass' });
  return result.filter((entry, index, entries) => entries.findIndex((candidate) => candidate.action === entry.action && candidate.syntax === entry.syntax) === index);
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  return containingFunction(node.parent);
}

function capturedProxyStableId(originalStableId: string, fnStableId: string) {
  return `${originalStableId}:captured-in:${fnStableId}`;
}

function capturedProxyLineage(
  context: FunctionValueAccessContext,
  declaringFunction: ts.FunctionLikeDeclaration,
  originalStableId: string,
) {
  const predecessors: string[] = [];
  let current = enclosingFunction(context.fnNode);
  while (current && current !== declaringFunction) {
    const fnStableId = getStableIdValue(getStableIdDescriptor(current.getSourceFile(), current)) || '';
    if (fnStableId) predecessors.push(capturedProxyStableId(originalStableId, fnStableId));
    current = enclosingFunction(current);
  }
  return predecessors;
}

function applyAccess(node: FlowNode, access: ValueAccess) {
  const current = (() => {
    try {
      return JSON.parse(node.valueAccessesJson || '[]') as ValueAccess[];
    } catch {
      return [];
    }
  })();
  if (!current.some((item) => item.slotStableId === access.slotStableId && item.action === access.action && item.syntax === access.syntax)) {
    current.push(access);
  }
  current.sort((left, right) => left.slotStableId.localeCompare(right.slotStableId) || left.action.localeCompare(right.action));

  node.labels = unique([...node.labels.filter((label) => !LEGACY_VALUE_LABELS.has(label)), 'ValueAccess', ...current.map((item) => ACTION_LABELS[item.action])]);
  node.valueAccessesJson = JSON.stringify(current);
  node.valueSlotStableIds = unique(current.map((item) => item.slotStableId));
  node.valueNames = unique(current.map((item) => item.name));
  node.valueScopes = unique(current.map((item) => item.scope));
  node.valueActions = unique(current.map((item) => item.action));
  node.valueOperationSyntaxes = unique(current.map((item) => item.syntax));
  node.valueSlotStableId = node.valueSlotStableIds.length === 1 ? node.valueSlotStableIds[0] : undefined;
  node.valueName = node.valueNames.length === 1 ? node.valueNames[0] : undefined;
  node.valueScope = node.valueScopes.length === 1 ? node.valueScopes[0] : undefined;
  node.valueAction = node.valueActions.length === 1 ? node.valueActions[0] : undefined;
  node.valueOperationSyntax = node.valueOperationSyntaxes.length === 1 ? node.valueOperationSyntaxes[0] : undefined;
}

function addAccessEdge(
  edges: FlowEdge[],
  fromId: string,
  binding: Binding,
  action: ValueAction,
  fromKind: FlowEdge['fromKind'] = undefined,
) {
  if (fromId === binding.materializedStableId) return;
  const type = ACTION_RELATIONSHIPS[action];
  if (edges.some((edge) => edge.fromId === fromId && edge.toId === binding.materializedStableId && edge.type === type)) return;
  const semanticInput = { label: binding.name, flowLayer: 'data' as const };
  edges.push({
    fromKind,
    fromId,
    toKind: undefined,
    toId: binding.materializedStableId,
    type,
    ...semanticInput,
    ...classifyFlowEdge(type, semanticInput),
  });
}

function addSemanticReferenceEdge(
  payload: FlowPayload,
  fromId: string,
  toId: string,
  type: string,
  props: Record<string, unknown> = {},
) {
  payload.semanticRelationships ||= [];
  const existing = payload.semanticRelationships.find((relationship) => (
    relationship.fromId === fromId
    && relationship.toId === toId
    && relationship.type === type
  ));
  if (existing) {
    const actions = unique([
      ...((existing.props.actions as string[] | undefined) || []),
      ...((props.actions as string[] | undefined) || []),
    ]);
    existing.props = { ...existing.props, ...props, ...(actions.length ? { actions } : {}) };
    return;
  }
  payload.semanticRelationships.push({ fromId, toId, type, props });
}

function collectBindings(context: FunctionValueAccessContext, checker: ts.TypeChecker) {
  const bindings: Binding[] = [];
  const bySymbol = new Map<ts.Symbol, Binding>();

  const register = (
    identifier: ts.Identifier,
    scope: Binding['scope'],
    declarationKindValue?: string,
    parameter?: ts.ParameterDeclaration,
  ) => {
    const symbol = checker.getSymbolAtLocation(identifier);
    const declaringFunction = containingFunction(identifier);
    if (!symbol || !declaringFunction || bySymbol.has(symbol)) return;
    const identifierDescriptor = getExtendedStableIdDescriptor(context.sourceFile, identifier);
    const parameterDescriptor = parameter && ts.isIdentifier(parameter.name)
      ? getExtendedStableIdDescriptor(context.sourceFile, parameter)
      : undefined;
    const parameterStableId = parameterDescriptor
      ? getStableIdValue(parameterDescriptor)
      : undefined;
    const slotDescriptor: StableIdDescriptor = parameterDescriptor && parameterStableId
      ? { ...parameterDescriptor, value: parameterStableId, suffix: undefined }
      : identifierDescriptor;
    const binding: Binding = {
      symbol,
      nameNode: identifier,
      name: identifier.text,
      scope,
      declarationKind: declarationKindValue,
      declaringFunction,
      slotStableId: getStableIdValue(slotDescriptor) || '',
      slotDescriptor,
      materializedStableId: getStableIdValue(slotDescriptor) || '',
      materializedDescriptor: slotDescriptor,
      proxyPredecessorStableIds: [],
      parentFnStableIdDescriptor: context.fnStableIdDescriptor,
    };
    if (!binding.slotStableId) return;
    bindings.push(binding);
    bySymbol.set(symbol, binding);
  };

  const visit = (node: ts.Node): void => {
    if (node !== context.fnNode && ts.isFunctionLike(node)) return;
    if (ts.isParameter(node)) {
      collectBindingIdentifiers(node.name).forEach((identifier) => register(identifier, 'parameter', undefined, node));
    } else if (ts.isVariableDeclaration(node)) {
      collectBindingIdentifiers(node.name).forEach((identifier) => register(identifier, 'local', declarationKind(node)));
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      collectBindingIdentifiers(node.variableDeclaration.name).forEach((identifier) => register(identifier, 'local', 'catch'));
    }
    ts.forEachChild(node, visit);
  };
  visit(context.fnNode);
  return { bindings, bySymbol };
}

function bindingLabel(scope: ValueScope) {
  if (scope === 'parameter') return 'ParameterBinding';
  if (scope === 'captured') return 'CapturedBinding';
  if (scope === 'module') return 'ModuleBinding';
  if (scope === 'memory') return 'MemoryCell';
  return 'LocalBinding';
}

function createSlotNode(binding: Binding, context: FunctionValueAccessContext, operationIndex: number): FlowNode {
  const renderPartStableId = binding.materializedStableId;
  return {
    stableId: binding.materializedDescriptor,
    parentFnStableId: binding.parentFnStableIdDescriptor,
    labels: ['ValueSlot', bindingLabel(binding.scope), ...(binding.scope === 'captured' ? ['ValueCapture'] : [])],
    label: binding.name,
    diaName: binding.name,
    repoRelativePath: binding.slotDescriptor.repoRelativePath || context.fnStableIdDescriptor.repoRelativePath || '',
    operationIndex,
    operationSubjectText: binding.name,
    variableDeclarationKind: binding.declarationKind,
    valueSlotStableId: binding.slotStableId,
    valueSlotStableIds: [binding.slotStableId],
    valueName: binding.name,
    valueNames: [binding.name],
    valueScope: binding.scope,
    valueScopes: [binding.scope],
    flowLayer: 'data',
    dataFlowRole: 'storage',
    canonicalStableId: binding.slotStableId,
    originalStableId: binding.slotStableId,
    bindingStableId: binding.slotStableId,
    proxyPredecessorStableIds: binding.proxyPredecessorStableIds,
    renderPartsJson: JSON.stringify([{
      stableId: renderPartStableId,
      text: binding.name,
      kind: 'value',
      labels: ['ValueSlot', bindingLabel(binding.scope)],
      order: 0,
      sourceStableId: binding.slotStableId,
      canonicalStableId: binding.slotStableId,
      bindingStableId: binding.slotStableId,
    }]),
    renderPartsLayout: 'single',
    renderPrimaryPartIndex: 0,
  };
}

export function extractValueAccessFacts(
  payload: FlowPayload,
  contexts: FunctionValueAccessContext[],
  checker: ts.TypeChecker,
  sharedRegistry?: ValueProxyMaterializationRegistry,
) {
  const registry = sharedRegistry || createValueProxyMaterializationRegistry();
  for (const node of payload.nodes) {
    node.labels = unique((node.labels || []).filter((label) => !LEGACY_VALUE_LABELS.has(label)));
  }

  for (const context of contexts) {
    const functionNodes = payload.nodes.filter((node) => getStableIdValue(node.parentFnStableId) === context.fnStableId);
    const { bindings, bySymbol } = collectBindings(context, checker);
    const collectExternalBindings = (node: ts.Node): void => {
      if (node !== context.fnNode && ts.isFunctionLike(node)) return;
      if (ts.isIdentifier(node) && !isDeclarationIdentifier(node) && !isNonValueIdentifier(node)) {
        let symbol = checker.getSymbolAtLocation(node);
        if (ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node) {
          symbol = checker.getShorthandAssignmentValueSymbol(node.parent) || symbol;
        }
        if (symbol && !bySymbol.has(symbol)) {
          const declarationCandidates = [symbol.valueDeclaration, ...(symbol.declarations || [])]
            .filter((candidate): candidate is ts.Declaration => Boolean(candidate));
          const declaration = declarationCandidates.find((candidate): candidate is (
            ts.VariableDeclaration | ts.ParameterDeclaration | ts.BindingElement
          ) => (
            ts.isVariableDeclaration(candidate) || ts.isParameter(candidate) || ts.isBindingElement(candidate)
          ));
          const rawName = declaration?.name;
          const identifier = rawName && ts.isIdentifier(rawName) ? rawName : undefined;
          if (identifier && !identifier.getSourceFile().isDeclarationFile) {
            const declaringFunction = containingFunction(identifier);
            // Parameters are one source entity (name + declared type). Captures must
            // point to that canonical entity instead of inventing a second node for
            // the identifier token inside the parameter.
            const slotDescriptor = ts.isParameter(declaration)
              ? getExtendedStableIdDescriptor(declaration.getSourceFile(), declaration)
              : getExtendedStableIdDescriptor(identifier.getSourceFile(), identifier);
            const slotStableId = getStableIdValue(slotDescriptor) || '';
            if (slotStableId) {
              const scope: ValueScope = declaringFunction ? 'captured' : 'module';
              const materializedStableId = scope === 'captured'
                ? capturedProxyStableId(slotStableId, context.fnStableId)
                : slotStableId;
              const materializedDescriptor: StableIdDescriptor = {
                ...slotDescriptor,
                value: materializedStableId,
              };
              const binding: Binding = {
                symbol,
                nameNode: identifier,
                name: identifier.text,
                scope,
                declarationKind: ts.isVariableDeclaration(declaration) ? declarationKind(declaration) : undefined,
                declaringFunction,
                slotStableId,
                slotDescriptor,
                materializedStableId,
                materializedDescriptor,
                proxyPredecessorStableIds: declaringFunction
                  ? capturedProxyLineage(context, declaringFunction, slotStableId)
                  : [],
                parentFnStableIdDescriptor: context.fnStableIdDescriptor,
              };
              bindings.push(binding);
              bySymbol.set(symbol, binding);
            }
          }
        }
      }
      ts.forEachChild(node, collectExternalBindings);
    };
    collectExternalBindings(context.fnNode);
    let operationIndex = Math.max(-1, ...functionNodes.map((node) => node.operationIndex ?? -1)) + 1;

    for (const binding of bindings) {
      const provenanceSourceStableId = binding.scope === 'captured'
        ? binding.proxyPredecessorStableIds.find((candidate) => registry.proxyNodeIds.has(candidate)) || binding.slotStableId
        : undefined;
      let slot = functionNodes.find((node) => stableIdOf(node) === binding.materializedStableId);
      if (!slot) {
        slot = createSlotNode(binding, context, operationIndex);
        operationIndex += 1;
        payload.nodes.push(slot);
        functionNodes.push(slot);
      } else {
        const bindingRole = binding.scope === 'parameter' && slot.labels.includes('Parameter')
          ? undefined
          : bindingLabel(binding.scope);
        slot.labels = unique([...slot.labels, 'ValueSlot', bindingRole]);
        slot.originalStableId ||= binding.slotStableId;
        slot.valueSlotStableId = binding.slotStableId;
        slot.valueSlotStableIds = [binding.slotStableId];
        slot.valueName = binding.name;
        slot.valueNames = [binding.name];
        slot.valueScope = binding.scope;
        slot.valueScopes = [binding.scope];
      }

      if (binding.scope === 'captured') {
        registry.proxyNodeIds.add(binding.materializedStableId);
        const edgeKey = `${provenanceSourceStableId}\u0000CAPTURES_VALUE\u0000${binding.materializedStableId}`;
        if (provenanceSourceStableId && !registry.provenanceEdgeKeys.has(edgeKey)) {
          registry.provenanceEdgeKeys.add(edgeKey);
          const semanticInput = { label: binding.name, flowLayer: 'data' as const };
          payload.edges.push({
            fromKind: undefined,
            fromId: provenanceSourceStableId,
            toKind: undefined,
            toId: binding.materializedStableId,
            type: 'CAPTURES_VALUE',
            contextOnly: true,
            ...semanticInput,
            ...classifyFlowEdge('CAPTURES_VALUE', semanticInput),
          });
        }
      }

      if (binding.scope === 'local' || binding.scope === 'parameter') {
        const action: ValueAction = binding.scope === 'parameter' ? 'receive' : 'create';
        if (binding.scope === 'parameter') {
          addAccessEdge(payload.edges, context.fnStableId, binding, action, 'Fn');
          continue;
        }
        const declarationOwner = findOwnerNode(functionNodes, context.sourceFile, binding.nameNode) || slot;
        applyAccess(declarationOwner, {
          slotStableId: binding.slotStableId,
          name: binding.name,
          scope: binding.scope,
          action,
          syntax: binding.nameNode.parent.getText(binding.nameNode.getSourceFile()),
        });
        addAccessEdge(payload.edges, stableIdOf(declarationOwner), binding, action);
      }
    }

    const visitReference = (node: ts.Node): void => {
      if (node !== context.fnNode && ts.isFunctionLike(node)) {
        const inlineCallback = ts.isArrowFunction(node) || ts.isFunctionExpression(node)
          ? ts.isCallExpression(node.parent) && node.parent.arguments.some((argument) => argument === node)
          : false;
        if (!inlineCallback) return;
      }
      if (ts.isIdentifier(node) && !isDeclarationIdentifier(node) && !isNonValueIdentifier(node)) {
        let symbol = checker.getSymbolAtLocation(node);
        if (ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node) {
          symbol = checker.getShorthandAssignmentValueSymbol(node.parent) || symbol;
        }
        const binding = symbol ? bySymbol.get(symbol) : undefined;
        if (binding) {
          const owner = findOwnerNode(functionNodes, context.sourceFile, node);
          if (owner && !owner.labels.includes('IterationGuard')) {
            const actions = actionsForIdentifier(node, owner, binding);
            for (const entry of actions) {
              if (
                entry.action === 'read'
                && (
                  isCollectionMethodReceiverIdentifier(node, owner)
                  || isDirectAssignmentValueIdentifier(node)
                )
              ) {
                continue;
              }
              applyAccess(owner, {
                slotStableId: binding.slotStableId,
                name: binding.name,
                scope: binding.scope,
                action: entry.action,
                syntax: entry.syntax,
              });
              if (entry.action === 'read' && isShorthandObjectFieldIdentifier(node)) {
                continue;
              }
            }
            const valueReferenceStableId = getExtendedStableId(context.sourceFile, node);
            addSemanticReferenceEdge(
              payload,
              stableIdOf(owner),
              valueReferenceStableId,
              'USES_REFERENCE',
              {
                flow_layer: 'data',
                context_only: true,
                actions: actions.map((entry) => entry.action),
              },
            );
            const propertyAccess = node.parent && ts.isPropertyAccessExpression(node.parent)
              && node.parent.expression === node
              ? node.parent
              : undefined;
            if (propertyAccess) {
              const memberReferenceStableId = getExtendedStableId(context.sourceFile, propertyAccess.name);
              addSemanticReferenceEdge(
                payload,
                stableIdOf(owner),
                memberReferenceStableId,
                'USES_MEMBER_REFERENCE',
                { flow_layer: 'data', context_only: true },
              );
              addSemanticReferenceEdge(
                payload,
                memberReferenceStableId,
                valueReferenceStableId,
                'ON_VALUE',
                { flow_layer: 'structure', context_only: true },
              );
            }
          }
        }
      }
      ts.forEachChild(node, visitReference);
    };
    visitReference(context.fnNode);

    for (const node of functionNodes) {
      if (node.asyncSchedulerKind !== 'react-state' || !node.stateResourceStableId || !node.stateResourceName) continue;
      if (!payload.nodes.some((candidate) => stableIdOf(candidate) === node.stateResourceStableId)) {
        const slotDescriptor: StableIdDescriptor = {
          value: node.stateResourceStableId,
          repoRelativePath: node.stateResourceRepoRelativePath || context.fnStableIdDescriptor.repoRelativePath,
        };
        const parentFnStableId: StableIdDescriptor = {
          value: node.stateResourceParentFnStableId || context.fnStableId,
          repoRelativePath: node.stateResourceRepoRelativePath || context.fnStableIdDescriptor.repoRelativePath,
        };
        payload.nodes.push({
          stableId: slotDescriptor,
          parentFnStableId,
          labels: ['ValueSlot', 'UiState'],
          label: node.stateResourceName,
          diaName: node.stateResourceName,
          repoRelativePath: slotDescriptor.repoRelativePath || '',
          operationIndex,
          operationSubjectText: node.stateResourceName,
          valueSlotStableId: node.stateResourceStableId,
          valueSlotStableIds: [node.stateResourceStableId],
          valueName: node.stateResourceName,
          valueNames: [node.stateResourceName],
          valueScope: 'memory',
          valueScopes: ['memory'],
          flowLayer: 'data',
          dataFlowRole: 'storage',
          renderPartsJson: JSON.stringify([{
            stableId: node.stateResourceStableId,
            text: node.stateResourceName,
            kind: 'value',
            labels: ['ValueSlot', 'UiState'],
            order: 0,
            sourceStableId: node.stateResourceStableId,
            canonicalStableId: node.stateResourceStableId,
            bindingStableId: node.stateResourceStableId,
          }]),
          renderPartsLayout: 'single',
          renderPrimaryPartIndex: 0,
        });
        operationIndex += 1;
      }
      const existingAccesses = (() => {
        try {
          return JSON.parse(node.valueAccessesJson || '[]') as ValueAccess[];
        } catch {
          return [];
        }
      })();
      if (existingAccesses.some((access) => access.scope === 'memory' && (access.action === 'write' || access.action === 'clear'))) continue;
      const action: ValueAction = node.stateUpdateAction === 'create' ? 'create' : node.stateUpdateAction === 'clear' ? 'clear' : 'write';
      applyAccess(node, {
        slotStableId: node.stateResourceStableId,
        name: node.stateResourceName,
        scope: 'memory',
        action,
        syntax: node.actionTextRaw,
      });
      const nodeStableId = stableIdOf(node);
      const existingParts = (() => {
        try {
          return JSON.parse(node.renderPartsJson || '[]') as RenderPartDescriptor[];
        } catch {
          return [];
        }
      })();
      const statePartStableId = `${nodeStableId}:state`;
      const callParts = existingParts.filter((part) => part.stableId !== statePartStableId);
      node.labels = [...new Set([...node.labels, 'UiState', 'ValueSlot'])];
      node.canonicalStableId = node.stateResourceStableId;
      node.valueSlotStableId = node.stateResourceStableId;
      node.valueSlotStableIds = [node.stateResourceStableId];
      node.valueName = node.stateResourceName;
      node.valueNames = [node.stateResourceName];
      node.valueScope = 'memory';
      node.valueScopes = ['memory'];
      node.flowLayer = 'mixed';
      node.dataFlowRole = 'operation';
      node.renderPartsLayout = 'container-overlay-side';
      node.renderPrimaryPartIndex = 0;
      node.renderPartsJson = JSON.stringify([
        {
          stableId: statePartStableId,
          text: node.stateResourceName,
          kind: 'value-container',
          labels: ['Value', 'ValueSlot', 'UiState'],
          order: 0,
          fillState: 'filled',
          sourceStableId: node.stateResourceStableId,
          canonicalStableId: node.stateResourceStableId,
          bindingStableId: node.stateResourceStableId,
        },
        ...callParts.map((part, index) => ({ ...part, order: index + 1 })),
      ] satisfies RenderPartDescriptor[]);
    }
  }

  payload.nodes.sort((left, right) => stableIdOf(left).localeCompare(stableIdOf(right)));
  payload.edges.sort((left, right) => left.fromId.localeCompare(right.fromId) || left.type.localeCompare(right.type) || left.toId.localeCompare(right.toId));
  return payload;
}
