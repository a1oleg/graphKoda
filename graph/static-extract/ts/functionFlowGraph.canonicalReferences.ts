import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { classifyCallOrigin } from './functionFlowGraph.callOrigins.js';
import { classifyRuntimeIntrinsic } from './functionFlowGraph.runtimeIntrinsics.js';
import { declaredMemberEvidence } from './declaredMemberEvidence.js';
import { callbackContributesToResult } from './callbackResultFlow.js';
import { awaitedTypeArgumentIndex } from './awaitedTypeContract.mjs';

import {
  getExtendedStableId,
  getRepoRelativePath,
  isTrackedSourceFile,
} from './functionFlowGraph.infrastructure.js';
import type {
  CanonicalEntity,
  CanonicalRelationship,
} from './functionFlowDuckdbStage.js';

type CanonicalReferenceGraph = {
  entities: CanonicalEntity[];
  relationships: CanonicalRelationship[];
};

type DeclarationCategory = 'TypeDeclaration' | 'ValueDeclaration' | 'MemberDeclaration';

type CodeqlReferenceFact = {
  relation: string;
  referencePath: string;
  referenceStartLine: number;
  referenceName: string;
  targetPath: string;
  targetStartLine: number;
  targetName: string;
};

const DECLARATION_SUFFIX: Record<DeclarationCategory, string> = {
  TypeDeclaration: 'type-declaration',
  ValueDeclaration: 'value-declaration',
  MemberDeclaration: 'member-declaration',
};

function normalizePath(value: string) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function codeqlFactKey(fact: CodeqlReferenceFact) {
  return [
    fact.relation,
    normalizePath(fact.referencePath),
    fact.referenceStartLine,
    fact.referenceName,
    normalizePath(fact.targetPath),
    fact.targetStartLine,
    fact.targetName,
  ].join('\u0000');
}

function loadCodeqlReferenceFacts() {
  const factsPath = path.join(projectPaths.dataRoot, 'codeql', 'results', 'canonical-reference-links.facts.json');
  try {
    const payload = JSON.parse(fs.readFileSync(factsPath, 'utf8')) as { rows?: CodeqlReferenceFact[] };
    return new Set((payload.rows || []).map(codeqlFactKey));
  } catch {
    return new Set<string>();
  }
}

function sourceProps(node: ts.Node) {
  const sourceFile = node.getSourceFile();
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    repoRelativePath: getRepoRelativePath(sourceFile.fileName),
    startLine: start.line + 1,
    startColumn: start.character,
    endLine: end.line + 1,
    endColumn: end.character,
    syntax: node.getText(sourceFile),
  };
}

function stableId(node: ts.Node, _role?: string) {
  return getExtendedStableId(node.getSourceFile(), node);
}

function relationshipFacets(type: string) {
  switch (type) {
    case 'HAS_ARGUMENT': return { fromFacet: 'call', toFacet: 'argument' };
    case 'HAS_PROPERTY': return { fromFacet: 'object', toFacet: 'property' };
    case 'CALLS_VALUE': return { fromFacet: 'call', toFacet: 'callee' };
    case 'CALLS': return { fromFacet: 'call', toFacet: 'declaration' };
    case 'RESOLVES_TO': return { fromFacet: 'reference', toFacet: 'declaration' };
    case 'BINDS_TO_PARAMETER': return { fromFacet: 'providedValue', toFacet: 'parameter' };
    case 'HAS_OPERATION': return { fromFacet: 'callableBody', toFacet: 'operation' };
    case 'VALUE_FROM': return { fromFacet: 'valueRole', toFacet: 'valueOrigin' };
    case 'READS_FROM': return { fromFacet: 'consumer', toFacet: 'valueSource' };
    case 'WRITES_TO': return { fromFacet: 'write', toFacet: 'writeTarget' };
    case 'AST_CHILD': return { fromFacet: 'syntaxContainer', toFacet: 'syntaxPart' };
    default: return {};
  }
}

function syntaxChildDescriptor(parent: ts.Node, child: ts.Node, order: number) {
  for (const [field, value] of Object.entries(parent as unknown as Record<string, unknown>)) {
    if (field === 'parent' || field.startsWith('_')) continue;
    if (value === child) return { field, order };
    if (!Array.isArray(value)) continue;
    const index = value.indexOf(child);
    if (index >= 0) return { field, index, order };
  }
  return { field: 'child', order };
}

function declarationName(node: ts.Node) {
  if ('name' in node) {
    const name = (node as ts.NamedDeclaration).name;
    if (name) return name.getText(node.getSourceFile());
  }
  if (ts.isExportAssignment(node)) return node.isExportEquals ? 'export=' : 'default';
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  return ts.SyntaxKind[node.kind];
}

function declarationCategory(node: ts.Declaration): DeclarationCategory {
  if (ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node)) return 'TypeDeclaration';
  if (
    ts.isPropertyDeclaration(node)
    || ts.isPropertySignature(node)
    || ts.isMethodDeclaration(node)
    || ts.isMethodSignature(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
    || ts.isEnumMember(node)
  ) return 'MemberDeclaration';
  if (
    ts.isTypeAliasDeclaration(node)
    || ts.isInterfaceDeclaration(node)
    || ts.isTypeParameterDeclaration(node)
    || ts.isClassDeclaration(node)
    || ts.isClassExpression(node)
    || ts.isEnumDeclaration(node)
  ) return 'TypeDeclaration';
  return 'ValueDeclaration';
}

function declarationLabels(node: ts.Declaration, category: DeclarationCategory) {
  const labels = ['Declaration', category];
  if (ts.isTypeAliasDeclaration(node)) labels.push('TypeAliasDeclaration', 'AliasDeclaration');
  if (ts.isInterfaceDeclaration(node)) labels.push('InterfaceDeclaration');
  if (ts.isTypeParameterDeclaration(node)) labels.push('TypeParameterDeclaration');
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) labels.push('Class', 'TypeDeclaration', 'ValueDeclaration');
  if (ts.isEnumDeclaration(node)) labels.push('EnumDeclaration', 'TypeDeclaration', 'ValueDeclaration');
  if (ts.isParameter(node)) labels.push('Parameter', 'ValueSlot');
  if (ts.isFunctionLike(node) && !ts.isFunctionTypeNode(node) && !ts.isConstructorTypeNode(node)) labels.push('CallableDeclaration');
  if ('typeParameters' in node && (node as ts.SignatureDeclaration).typeParameters?.length) labels.push('GenericDeclaration');
  const ambient = node.getSourceFile().isDeclarationFile
    || (ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)));
  if (ambient) labels.push('ExternalDeclaration', 'ExternalBoundary', 'System');
  else labels.push('DeveloperDefined');
  return [...new Set(labels)];
}

function isDeclarationName(node: ts.Node) {
  const parent = node.parent;
  if (parent && ts.isShorthandPropertyAssignment(parent) && parent.name === node) return false;
  return Boolean(parent && 'name' in parent && (parent as ts.NamedDeclaration).name === node);
}

function resolveSymbol(checker: ts.TypeChecker, node: ts.Node) {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) {
    try {
      const target = checker.getAliasedSymbol(symbol);
      // An unavailable alias target must not erase its concrete local binding.
      if (target.declarations?.length || target.valueDeclaration) symbol = target;
    } catch {
      // An unresolved alias is still represented by its AliasDeclaration node.
    }
  }
  return symbol;
}

function symbolDeclarations(checker: ts.TypeChecker, node: ts.Node) {
  if (ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node) {
    const valueSymbol = checker.getShorthandAssignmentValueSymbol(node.parent);
    if (valueSymbol) {
      return [...new Set(valueSymbol.declarations || (valueSymbol.valueDeclaration ? [valueSymbol.valueDeclaration] : []))];
    }
  }
  const symbol = resolveSymbol(checker, node);
  return [...new Set(symbol?.declarations || (symbol?.valueDeclaration ? [symbol.valueDeclaration] : []))];
}

function expressionTargetNode(expression: ts.Expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current)
  ) current = current.expression;
  if (ts.isPropertyAccessExpression(current)) return current.name;
  return current;
}

function typeReferenceTargetNode(node: ts.TypeNode) {
  if (ts.isTypeReferenceNode(node)) return node.typeName;
  if (ts.isExpressionWithTypeArguments(node)) return node.expression;
  if (ts.isTypeQueryNode(node)) return node.exprName;
  return node;
}

function isDerivedTypeNode(node: ts.Node): node is ts.TypeNode {
  return ts.isUnionTypeNode(node)
    || ts.isTypeLiteralNode(node)
    || ts.isParenthesizedTypeNode(node)
    || ts.isIntersectionTypeNode(node)
    || ts.isConditionalTypeNode(node)
    || ts.isMappedTypeNode(node)
    || ts.isIndexedAccessTypeNode(node)
    || ts.isTypeOperatorNode(node)
    || ts.isTypeQueryNode(node)
    || ts.isImportTypeNode(node)
    || ts.isArrayTypeNode(node)
    || ts.isTupleTypeNode(node)
    || ts.isFunctionTypeNode(node)
    || ts.isConstructorTypeNode(node)
    || ts.isTypePredicateNode(node)
    || ts.isTemplateLiteralTypeNode(node);
}

function isOwnershipSyntaxContainer(node: ts.Node) {
  return ts.isVariableDeclarationList(node) || ts.isVariableStatement(node) || ts.isCatchClause(node)
    || ts.isExportAssignment(node) || ts.isExpressionStatement(node) || ts.isReturnStatement(node) || ts.isThrowStatement(node)
    || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)
    || ts.isNamedTupleMember(node) || ts.isOptionalTypeNode(node) || ts.isRestTypeNode(node)
    || ts.isTemplateLiteralTypeSpan(node) || ts.isIfStatement(node) || ts.isSwitchStatement(node) || ts.isCaseBlock(node)
    || ts.isCaseClause(node) || ts.isDefaultClause(node) || ts.isPropertyAccessExpression(node)
    || ts.isParenthesizedExpression(node) || ts.isTemplateExpression(node)
    || ts.isArrayLiteralExpression(node) || ts.isSpreadElement(node)
    || ts.isTemplateSpan(node) || ts.isNewExpression(node) || ts.isAwaitExpression(node)
    || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isForStatement(node)
    || ts.isForInStatement(node) || ts.isForOfStatement(node)
    || ts.isConditionalExpression(node) || ts.isNonNullExpression(node)
    || ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)
    || ts.isJsxElement(node) || ts.isJsxFragment(node) || ts.isJsxExpression(node)
    || ts.isJsxAttributes(node) || ts.isJsxAttribute(node) || ts.isJsxSpreadAttribute(node)
    || (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.CommaToken].includes(node.operatorToken.kind));
}

function directMemberOwner(node: ts.Declaration): ts.Declaration | undefined {
  const parent = node.parent;
  if (
    ts.isInterfaceDeclaration(parent)
    || ts.isClassDeclaration(parent)
    || ts.isClassExpression(parent)
    || ts.isEnumDeclaration(parent)
  ) return parent;
  return undefined;
}

function isReactWrapperName(name: string) {
  return name === 'memo' || name === 'forwardRef' || name === 'lazy';
}

function callName(checker: ts.TypeChecker, expression: ts.LeftHandSideExpression) {
  const target = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
  const symbol = resolveSymbol(checker, target);
  return symbol?.getName() || (ts.isIdentifier(target) ? target.text : '');
}

function isReactApiCall(checker: ts.TypeChecker, node: ts.CallExpression, names: string[]) {
  if (!names.includes(callName(checker, node.expression))) return false;
  if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) {
    const namespace = checker.getSymbolAtLocation(node.expression.expression);
    if ((namespace?.declarations || []).some((declaration) => {
      if (!ts.isNamespaceImport(declaration)) return false;
      const importDeclaration = declaration.parent.parent;
      return ts.isImportDeclaration(importDeclaration)
        && ts.isStringLiteral(importDeclaration.moduleSpecifier)
        && importDeclaration.moduleSpecifier.text === 'react';
    })) return true;
  }
  const expression = expressionTargetNode(node.expression);
  const symbol = checker.getSymbolAtLocation(expression);
  const declarations = [
    ...(symbol?.declarations || []),
    ...(resolveSymbol(checker, expression)?.declarations || []),
  ];
  return declarations.some((declaration) => {
    if (ts.isImportSpecifier(declaration)) {
      const importDeclaration = declaration.parent.parent.parent;
      return ts.isImportDeclaration(importDeclaration)
        && ts.isStringLiteral(importDeclaration.moduleSpecifier)
        && importDeclaration.moduleSpecifier.text === 'react';
    }
    if (ts.isNamespaceImport(declaration)) {
      const importDeclaration = declaration.parent.parent;
      return ts.isImportDeclaration(importDeclaration)
        && ts.isStringLiteral(importDeclaration.moduleSpecifier)
        && importDeclaration.moduleSpecifier.text === 'react';
    }
    return false;
  });
}

function isReactStateHookCall(checker: ts.TypeChecker, node: ts.CallExpression) {
  return isReactApiCall(checker, node, ['useState', 'useReducer']);
}

export function resolveCanonicalDeclarationStableId(checker: ts.TypeChecker, node: ts.Node) {
  const declaration = symbolDeclarations(checker, node)[0];
  if (!declaration) return undefined;
  return stableId(declaration, DECLARATION_SUFFIX[declarationCategory(declaration)]);
}

export function collectCanonicalReferenceGraph(program: ts.Program): CanonicalReferenceGraph {
  const checker = program.getTypeChecker();
  const declaredMembers = declaredMemberEvidence(checker);
  const codeqlFacts = loadCodeqlReferenceFacts();
  const entities = new Map<string, CanonicalEntity>();
  const relationships = new Map<string, CanonicalRelationship>();
  const declarationIds = new Map<ts.Declaration, string>();
  const emittedCalls = new Set<ts.CallExpression>();
  const forwardedParameterTypes = new Map<ts.ParameterDeclaration, { type: ts.Type; expression: ts.Expression; callSiteStableId: string }[]>();
  const memberReferences = new Set<ts.Node>();
  const emittedObjects = new Set<ts.ObjectLiteralExpression>();
  const emittedBindings = new Set<ts.VariableDeclaration | ts.ParameterDeclaration>();
  const emittedReturns = new Set<ts.ReturnStatement>();
  const emittedWrites = new Set<ts.BinaryExpression>();
  const reactStateBySetterSymbol = new Map<ts.Symbol, string>();
  const callbackImplementationsByPropMember = new Map<ts.Declaration, Set<ts.FunctionLikeDeclaration>>();
  const pendingPropCallbackCalls: Array<{
    call: ts.CallExpression;
    member: ts.Declaration;
  }> = [];
  const visitedSourceNodes: ts.Node[] = [];

  function resolutionProps(relation: string, reference: ts.Node, target: ts.Declaration) {
    const referenceSource = sourceProps(reference);
    const targetSource = sourceProps(target);
    const key = codeqlFactKey({
      relation,
      referencePath: referenceSource.repoRelativePath,
      referenceStartLine: referenceSource.startLine,
      referenceName: reference.getText(reference.getSourceFile()),
      targetPath: targetSource.repoRelativePath,
      targetStartLine: targetSource.startLine,
      targetName: declarationName(target),
    });
    return {
      resolution: codeqlFacts.has(key) ? 'typescript-checker+codeql' : 'typescript-checker',
      codeqlValidated: codeqlFacts.has(key),
    };
  }

  function emitEntity(entity: CanonicalEntity) {
    const existing = entities.get(entity.stableId);
    if (!existing) {
      entities.set(entity.stableId, {
        ...entity,
        labels: [...new Set(entity.labels)],
        props: {
          ...entity.props,
          roles: [...new Set(entity.labels)],
          roleNames: entity.props.name == null ? [] : [entity.props.name],
        },
      });
      return entity.stableId;
    }
    existing.labels = [...new Set([...existing.labels, ...entity.labels])];
    const existingCanonical = existing.props.canonical === true;
    const incomingCanonical = entity.props.canonical === true;
    const roleNames = [...new Set([
      ...((existing.props.roleNames as unknown[]) || []),
      ...(entity.props.name == null ? [] : [entity.props.name]),
    ])];
    existing.props = {
      ...existing.props,
      ...entity.props,
      ...((existingCanonical && !incomingCanonical) ? {
        name: existing.props.name,
        canonical: true,
      } : {}),
      roles: existing.labels,
      roleNames,
    };
    return existing.stableId;
  }

  function emitRelationship(fromId: string, toId: string, type: string, props: Record<string, unknown> = {}) {
    if (!fromId || !toId || fromId === toId) return;
    const key = `${fromId}\u0000${type}\u0000${toId}`;
    if (!relationships.has(key)) relationships.set(key, {
      fromId,
      toId,
      type,
      props: { ...relationshipFacets(type), ...props },
    });
  }

  function emitDeclaration(node: ts.Declaration, forcedCategory?: DeclarationCategory) {
    if (ts.isSourceFile(node)) {
      const id = `source-file:${getRepoRelativePath(node.fileName)}`;
      declarationIds.set(node, id);
      emitEntity({ stableId: id, labels: ['CodeEntity', 'SourceFile'],
        props: { ...sourceProps(node), name: getRepoRelativePath(node.fileName), syntaxKind: 'SourceFile' } });
      return id;
    }
    // Resolving a call through a signature does not turn that type into a value.
    if (ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node)) forcedCategory = 'TypeDeclaration';
    const previous = declarationIds.get(node);
    if (previous) {
      if (forcedCategory) {
        const existing = entities.get(previous);
        if (existing) existing.labels = [...new Set([...existing.labels, forcedCategory])];
      }
      return previous;
    }
    const category = declarationCategory(node);
    const id = ts.isParameter(node)
      ? stableId(node, 'parameter')
      : stableId(node, DECLARATION_SUFFIX[category]);
    declarationIds.set(node, id);
    const declaredType = category === 'TypeDeclaration'
      ? checker.getTypeAtLocation(('name' in node && (node as ts.NamedDeclaration).name) || node)
      : undefined;
    const declaredMembers = declaredType?.getProperties().filter((member) => !member.name.startsWith('__')) || [];
    const operationProvider = declaredMembers.length > 0 && declaredMembers.every((member) => {
      const memberDeclaration = member.valueDeclaration || member.declarations?.[0] || node;
      const memberType = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(member, memberDeclaration));
      return memberType.getCallSignatures().length > 0;
    });
    emitEntity({
      stableId: id,
      labels: [...new Set([
        ...declarationLabels(node, category),
        ...(forcedCategory ? [forcedCategory] : []),
        ...(operationProvider ? ['OperationProvider', 'CapabilityBundle'] : []),
      ])],
      props: {
        ...sourceProps(node),
        name: declarationName(node),
        declarationKind: ts.SyntaxKind[node.kind],
        canonical: true,
        sourceCoverage: isTrackedSourceFile(node.getSourceFile()) ? 'syntax-extracted' : 'declaration-only',
      },
    });
    const name = (node as ts.NamedDeclaration).name;
    // Referenced external declarations also own their names. Rendering a field
    // from a library type must not create an unowned, project-local name tile.
    if (name && !ts.isPropertyAccessExpression(node)
      && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)
        || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name))) {
      const nameId = stableId(name);
      if (nameId !== id) {
        emitEntity({ stableId: nameId, labels: ['CodeEntity', 'SyntaxPart', 'DeclarationName'],
          props: { ...sourceProps(name), name: name.getText(), syntaxKind: ts.SyntaxKind[name.kind] } });
        emitRelationship(id, nameId, 'AST_CHILD', {
          ...syntaxChildDescriptor(node, name, 0), layer: 'syntax',
        });
      }
    }
    // Keep ownership of a referenced declaration's written type even when its
    // source file is outside the extraction scope. This is shallow AST evidence,
    // not a request to expand the library or resolve every type dependency.
    if (!isTrackedSourceFile(node.getSourceFile())
      && declarationLabels(node, category).includes('ExternalDeclaration')
      && (ts.isVariableDeclaration(node) || ts.isParameter(node)
        || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node))
      && node.type) {
      const typeId = stableId(node.type);
      emitEntity({ stableId: typeId,
        labels: ['CodeEntity', 'SyntaxPart', ...(isIntrinsicTypeSyntax(node.type) ? ['System'] : [])],
        props: { ...sourceProps(node.type), syntaxKind: ts.SyntaxKind[node.type.kind] } });
      emitRelationship(id, typeId, 'AST_CHILD', {
        ...syntaxChildDescriptor(node, node.type, 0), layer: 'syntax',
      });
    }
    return id;
  }

  function targetDeclarationIds(node: ts.Node, forcedCategory?: DeclarationCategory) {
    return symbolDeclarations(checker, node).map((declaration) => emitDeclaration(declaration, forcedCategory));
  }

  function memberDeclarationsAt(node: ts.Node): ts.Declaration[] {
    const declarations = [...symbolDeclarations(checker, node)];
    const access = node.parent;
    if (!ts.isPropertyAccessExpression(access) || access.name !== node) return [...new Set(declarations)];
    const sourceExpressions: ts.Expression[] = [];
    const visitedDeclarations = new Set<ts.Declaration>();
    function collectSources(expression: ts.Expression, depth = 0): void {
      if (depth > 8) return;
      const current = unwrapExpression(expression);
      sourceExpressions.push(current);
      if (ts.isConditionalExpression(current)) {
        collectSources(current.whenTrue, depth + 1);
        collectSources(current.whenFalse, depth + 1);
        return;
      }
      if (!ts.isIdentifier(current)) return;
      for (const declaration of symbolDeclarations(checker, current)) {
        if (visitedDeclarations.has(declaration)) continue;
        visitedDeclarations.add(declaration);
        if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
          collectSources(declaration.initializer, depth + 1);
        }
      }
    }
    collectSources(access.expression);
    for (const source of sourceExpressions) {
      const receiverType = checker.getNonNullableType(checker.getTypeAtLocation(source));
      const receiverTypes = receiverType.isUnion() ? receiverType.types : [receiverType];
      for (const type of receiverTypes) {
        const member = type.getProperty(access.name.text);
        declarations.push(...(member?.declarations || (member?.valueDeclaration ? [member.valueDeclaration] : [])));
      }
    }
    return [...new Set(declarations)];
  }

  function emitReference(node: ts.Node, kind: 'TypeReference' | 'ValueReference' | 'MemberReference') {
    if (node.kind >= ts.SyntaxKind.FirstKeyword && node.kind <= ts.SyntaxKind.LastKeyword) {
      const id = stableId(node);
      emitEntity({ stableId: id, labels: ['CodeEntity', 'SyntaxPart', 'System'],
        props: { ...sourceProps(node), name: node.getText(node.getSourceFile()),
          syntaxKind: ts.SyntaxKind[node.kind], resolution: 'typescript-keyword' } });
      return id;
    }
    const intrinsic = kind === 'ValueReference' ? classifyRuntimeIntrinsic(program, node) : undefined;
    if (intrinsic) {
      const id = stableId(node);
      const ownerId = intrinsic.owner ? emitDeclaration(intrinsic.owner, 'ValueDeclaration') : undefined;
      emitEntity({ stableId: id, labels: ['CodeEntity', 'SyntaxPart', 'System', 'Value',
        intrinsic.kind === 'arguments' ? 'RuntimeArguments' : 'RuntimeGlobalObject'],
        props: { ...sourceProps(node), name: node.getText(node.getSourceFile()),
          runtimeIntrinsic: intrinsic.kind, resolution: 'typescript-intrinsic-runtime',
          compilerSymbolFlags: intrinsic.symbolFlags, argumentsOwnerStableId: ownerId } });
      if (ownerId) emitRelationship(id, ownerId, 'READS_ARGUMENTS_OF', {
        layer: 'functional', resolution: 'lexical-non-arrow-function', contextRole: 'runtime-binding',
      });
      for (const declaration of intrinsic.typeDeclarations || []) {
        emitRelationship(id, emitDeclaration(declaration, 'TypeDeclaration'), 'HAS_TYPE', {
          layer: 'type', resolution: 'typescript-standard-library',
        });
      }
      return id;
    }
    if (kind === 'ValueReference' && ts.isIdentifier(node) && node.text === 'undefined'
      && (checker.getTypeAtLocation(node).flags & ts.TypeFlags.Undefined)
      && !symbolDeclarations(checker, node).length) {
      const id = stableId(node);
      emitEntity({ stableId: id, labels: ['CodeEntity', 'SyntaxPart', 'System', 'Value', 'LiteralValue'],
        props: { ...sourceProps(node), name: 'undefined', value_kind: 'undefined',
          resolution: 'typescript-intrinsic-value' } });
      return id;
    }
    if (kind === 'MemberReference') memberReferences.add(node);
    const suffix = kind.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
    const id = stableId(node, suffix);
    emitEntity({
      stableId: id,
      labels: ['Reference', kind],
      props: {
        ...sourceProps(node),
        name: node.getText(node.getSourceFile()),
        canonical: false,
      },
    });
    const forcedCategory = kind === 'TypeReference'
      ? 'TypeDeclaration'
      : kind === 'MemberReference'
        ? 'MemberDeclaration'
        : 'ValueDeclaration';
    const declarations = kind === 'MemberReference'
      ? memberDeclarationsAt(node)
      : symbolDeclarations(checker, node);
    if (!declarations.length && kind === 'MemberReference'
      && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
      const receiver = node.parent.expression;
      const type = checker.getNonNullableType(checker.getTypeAtLocation(receiver));
      const index = checker.getIndexInfoOfType(type, ts.IndexKind.String);
      const typeMember = type.getProperty(node.parent.name.text);
      const dynamic = type.flags & ts.TypeFlags.Any ? 'receiver-any'
        : index ? 'string-index-signature'
        : typeMember ? 'structural-type-member' : undefined;
      const entity = entities.get(id)!;
      Object.assign(entity.props, { memberResolution: dynamic || 'unresolved-member', memberName: node.parent.name.text,
        receiverTypeText: checker.typeToString(type), staticMemberKnown: false,
        typeMemberKnown: Boolean(typeMember), declarationResolution: 'no-source-declaration' });
      emitRelationship(id, emitExpressionValue(receiver), 'READS_FROM', {
        role: 'receiver', layer: 'functional', resolution: dynamic ? 'typescript-dynamic-member' : 'ast-member-receiver',
      });
      if (dynamic) {
        entity.labels = [...new Set([...entity.labels, 'DynamicMemberAccess'])];
      }
    }
    for (const declaration of declarations) {
      const targetId = emitDeclaration(declaration, forcedCategory);
      emitRelationship(id, targetId, 'RESOLVES_TO', resolutionProps('RESOLVES_TO', node, declaration));
    }
    return id;
  }

  function emitDerivedType(node: ts.TypeNode) {
    const id = stableId(node, 'derived-type');
    emitEntity({
      stableId: id,
      labels: ['Declaration', 'TypeDeclaration', 'DerivedType'],
      props: {
        ...sourceProps(node),
        name: node.getText(node.getSourceFile()),
        declarationKind: ts.SyntaxKind[node.kind],
        canonical: true,
      },
    });
    function collectPart(current: ts.Node): void {
      if (current !== node && ts.isTypeReferenceNode(current)) {
        for (const targetId of targetDeclarationIds(current.typeName, 'TypeDeclaration')) {
          emitRelationship(id, targetId, 'DERIVES_FROM', { resolution: 'typescript-checker' });
        }
        return;
      }
      if (current !== node && ts.isTypeQueryNode(current)) {
        for (const targetId of targetDeclarationIds(current.exprName, 'TypeDeclaration')) {
          emitRelationship(id, targetId, 'DERIVES_FROM', { resolution: 'typescript-checker', typeQuery: true });
        }
      }
      ts.forEachChild(current, collectPart);
    }
    collectPart(node);
    return id;
  }

  function isIntrinsicTypeSyntax(node: ts.TypeNode) {
    return ts.isLiteralTypeNode(node)
      || ts.isThisTypeNode(node)
      || (node.kind >= ts.SyntaxKind.FirstKeyword && node.kind <= ts.SyntaxKind.LastKeyword)
      || (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === 'const'
        && (ts.isAsExpression(node.parent) || ts.isTypeAssertionExpression(node.parent)));
  }

  function emitTypeContext(node: ts.TypeNode) {
    if (isIntrinsicTypeSyntax(node)) {
      const id = stableId(node);
      emitEntity({ stableId: id, labels: ['CodeEntity', 'SyntaxPart', 'System'],
        props: { ...sourceProps(node), name: node.getText(node.getSourceFile()), syntaxKind: ts.SyntaxKind[node.kind] } });
      return id;
    }
    if (isDerivedTypeNode(node)) return emitDerivedType(node);
    return emitReference(typeReferenceTargetNode(node), 'TypeReference');
  }

  function emitGenericUse(node: ts.TypeReferenceNode | ts.ExpressionWithTypeArguments | ts.CallExpression | ts.NewExpression) {
    const typeArguments = node.typeArguments;
    if (!typeArguments?.length) return;
    const id = stableId(node, 'generic-use');
    emitEntity({
      stableId: id,
      labels: ['Reference', 'GenericUse'],
      props: {
        ...sourceProps(node),
        name: node.getText(node.getSourceFile()),
        typeArgumentCount: typeArguments.length,
      },
    });
    const targetNode = ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node)
      ? typeReferenceTargetNode(node)
      : expressionTargetNode(node.expression);
    const resolvedDeclaration = ts.isCallExpression(node) || ts.isNewExpression(node)
      ? checker.getResolvedSignature(node)?.declaration
      : undefined;
    const targetIds = resolvedDeclaration
      ? [emitDeclaration(resolvedDeclaration)]
      : targetDeclarationIds(targetNode);
    for (const targetId of targetIds) {
      const target = entities.get(targetId);
      if (target) target.labels = [...new Set([...target.labels, 'GenericDeclaration'])];
      emitRelationship(id, targetId, 'INSTANTIATES', { resolution: 'typescript-checker' });
    }
    const awaitedIndex = ts.isCallExpression(node) ? awaitedTypeArgumentIndex(ts, node, resolvedDeclaration) : -1;
    typeArguments.forEach((argument, index) => {
      let targets = targetDeclarationIds(typeReferenceTargetNode(argument), 'TypeDeclaration');
      if (!targets.length) targets = [emitTypeContext(argument)];
      for (const targetId of targets) emitRelationship(id, targetId, index === awaitedIndex ? 'AWAITS_TYPE' : 'TYPE_ARGUMENT', {
        index, layer: 'type', resolution: 'typescript-signature',
        ...(index === awaitedIndex ? { staticOnly: true, runtimeValidation: false } : {}),
      });
    });
  }

  function emitAlias(node: ts.Node, symbolNode: ts.Node, aliasKind: string) {
    const id = stableId(node, 'alias-declaration');
    emitEntity({
      stableId: id,
      labels: ['Declaration', 'AliasDeclaration'],
      props: {
        ...sourceProps(node),
        name: symbolNode.getText(symbolNode.getSourceFile()),
        aliasKind,
      },
    });
    for (const declaration of symbolDeclarations(checker, symbolNode)) {
      emitRelationship(id, emitDeclaration(declaration), 'ALIASES', resolutionProps('ALIASES', symbolNode, declaration));
    }
  }

  function emitReExport(node: ts.ExportDeclaration | ts.ExportSpecifier) {
    const owner = ts.isExportSpecifier(node) ? node.parent.parent : node;
    const id = stableId(node, 're-export');
    emitEntity({
      stableId: id,
      labels: ['Declaration', 'ReExport'],
      props: {
        ...sourceProps(node),
        name: node.getText(node.getSourceFile()),
        moduleSpecifier: owner.moduleSpecifier?.getText(owner.getSourceFile()) || null,
      },
    });
    if (ts.isExportSpecifier(node)) {
      for (const declaration of symbolDeclarations(checker, node.name)) {
        emitRelationship(id, emitDeclaration(declaration), 'REEXPORTS', resolutionProps('REEXPORTS', node.name, declaration));
      }
    } else if (node.moduleSpecifier) {
      for (const declaration of symbolDeclarations(checker, node.moduleSpecifier)) {
        emitRelationship(id, emitDeclaration(declaration), 'REEXPORTS', { resolution: 'typescript-checker', bulk: true });
      }
    }
  }

  function emitReactWrapper(node: ts.CallExpression) {
    const wrapperKind = callName(checker, node.expression);
    if (!isReactWrapperName(wrapperKind)) return;
    const id = stableId(node, 'react-wrapper');
    emitEntity({
      stableId: id,
      labels: ['ValueDeclaration', 'ReactWrapper', 'Component', ...(wrapperKind === 'forwardRef' ? ['Ref'] : [])],
      props: { ...sourceProps(node), name: wrapperKind, wrapperKind },
    });
    const wrapped = node.arguments[0];
    if (wrapped) {
      if (ts.isArrowFunction(wrapped) || ts.isFunctionExpression(wrapped)) {
        const targetId = emitDeclaration(wrapped, 'ValueDeclaration');
        const target = entities.get(targetId);
        if (target) target.labels = [...new Set([...target.labels, 'Component'])];
        emitRelationship(id, targetId, 'WRAPS', { wrapperKind });
      } else {
        for (const targetId of targetDeclarationIds(expressionTargetNode(wrapped), 'ValueDeclaration')) {
          const target = entities.get(targetId);
          if (target) target.labels = [...new Set([...target.labels, 'Component'])];
          emitRelationship(id, targetId, 'WRAPS', { wrapperKind });
        }
      }
    }
    if (wrapperKind === 'forwardRef' && wrapped && (ts.isArrowFunction(wrapped) || ts.isFunctionExpression(wrapped))) {
      const refParameter = wrapped.parameters[1];
      if (refParameter) {
        const targetId = emitDeclaration(refParameter, 'ValueDeclaration');
        const entity = entities.get(targetId);
        if (entity) entity.labels = [...new Set([...entity.labels, 'RefTarget'])];
        emitRelationship(id, targetId, 'FORWARDS_REF_TO', { wrapperKind });
      }
    }
  }

  function emitRuntimeRef(node: ts.Node, expression: ts.Expression) {
    const id = stableId(node, 'ref');
    emitEntity({
      stableId: id,
      labels: ['Reference', 'Ref'],
      props: { ...sourceProps(node), name: expression.getText(expression.getSourceFile()) },
    });
    for (const targetId of targetDeclarationIds(expressionTargetNode(expression), 'ValueDeclaration')) {
      const entity = entities.get(targetId);
      if (entity) entity.labels = [...new Set([...entity.labels, 'RefTarget'])];
      emitRelationship(id, targetId, 'FORWARDS_REF_TO', { resolution: 'typescript-checker' });
    }
  }

  function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
    let current = node.parent;
    while (current) {
      if (ts.isFunctionLike(current)) return current;
      current = current.parent;
    }
    return undefined;
  }

  function markEnclosingFunctionImplementation(node: ts.Node, operationId?: string) {
    const owner = enclosingFunction(node);
    if (!owner) return;
    const ownerId = emitDeclaration(owner, 'ValueDeclaration');
    const ownerEntity = entities.get(ownerId);
    if (operationId && operationId !== ownerId) {
      emitRelationship(operationId, ownerId, 'ENCLOSED_BY', { layer: 'functional', resolution: 'lexical-function-owner' });
    }
    if (ownerEntity?.labels.includes('CallableDeclaration')) {
      ownerEntity.labels = [...new Set([...ownerEntity.labels, 'FunctionImplementation'])];
      if (operationId && operationId !== ownerId) {
        emitRelationship(ownerId, operationId, 'AST_CHILD', {
          layer: 'syntax',
          projection: 'nearest-function-operation',
        });
      }
    }
  }

  function callableTargetNode(expression: ts.LeftHandSideExpression) {
    return expressionTargetNode(expression);
  }

  function isIdentityCallable(node: ts.CallExpression) {
    const target = callableTargetNode(node.expression);
    const symbol = resolveSymbol(checker, target);
    const declaration = symbol?.declarations?.[0] || symbol?.valueDeclaration;
    if (!declaration?.getSourceFile().isDeclarationFile) return false;
    return ['useCallback', 'useMemo', 'memo', 'forwardRef'].includes(symbol?.getName() || '');
  }

  function unwrapExpression(expression: ts.Expression): ts.Expression {
    let current = expression;
    while (
      ts.isParenthesizedExpression(current)
      || ts.isAsExpression(current)
      || ts.isTypeAssertionExpression(current)
      || ts.isSatisfiesExpression(current)
      || ts.isNonNullExpression(current)
    ) current = current.expression;
    return current;
  }

  function callbackImplementations(
    expression: ts.Expression,
    visitedDeclarations = new Set<ts.Declaration>(),
  ): ts.FunctionLikeDeclaration[] {
    const current = unwrapExpression(expression);
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) return [current];
    if (ts.isCallExpression(current) && isIdentityCallable(current) && current.arguments[0]) {
      return callbackImplementations(current.arguments[0], visitedDeclarations);
    }
    if (!ts.isIdentifier(current) && !ts.isPropertyAccessExpression(current)) return [];
    const implementations: ts.FunctionLikeDeclaration[] = [];
    for (const declaration of symbolDeclarations(checker, expressionTargetNode(current))) {
      if (visitedDeclarations.has(declaration)) continue;
      visitedDeclarations.add(declaration);
      if (ts.isFunctionLike(declaration) && declaration.body) implementations.push(declaration);
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        implementations.push(...callbackImplementations(declaration.initializer, visitedDeclarations));
      }
    }
    return [...new Set(implementations)];
  }

  function callableMemberDeclaration(declaration: ts.SignatureDeclaration): ts.Declaration | undefined {
    let current: ts.Node | undefined = declaration;
    while (current) {
      if (
        ts.isPropertySignature(current)
        || ts.isPropertyDeclaration(current)
        || ts.isMethodSignature(current)
        || ts.isMethodDeclaration(current)
      ) return current;
      if (ts.isFunctionLike(current) && current !== declaration) return undefined;
      current = current.parent;
    }
    return undefined;
  }

  function jsxPropMemberDeclarations(
    node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
    propertyName: string,
  ): ts.Declaration[] {
    const componentType = checker.getTypeAtLocation(node.tagName);
    const signatures = checker.getSignaturesOfType(componentType, ts.SignatureKind.Call);
    const declarations: ts.Declaration[] = [];
    for (const signature of signatures) {
      const propsParameter = signature.parameters[0];
      if (!propsParameter) continue;
      const propsType = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(propsParameter, node));
      const member = propsType.getProperty(propertyName);
      declarations.push(...(member?.declarations || (member?.valueDeclaration ? [member.valueDeclaration] : [])));
      const implementation = signature.declaration;
      const parameter = implementation?.parameters[0];
      if (!parameter) continue;
      const collectBindings = (pattern: ts.BindingName) => {
        if (!ts.isObjectBindingPattern(pattern)) return;
        for (const binding of pattern.elements) {
          if (binding.dotDotDotToken) continue;
          const key = binding.propertyName || binding.name;
          if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && key.text === propertyName) {
            declarations.push(binding);
          }
        }
      };
      collectBindings(parameter.name);
      // Compiled components can lose their props type but retain an exact
      // destructuring of the first parameter. Resolve by symbol, not spelling.
      if (implementation && 'body' in implementation && implementation.body) {
        const visitBindings = (child: ts.Node): void => {
          if (ts.isFunctionLike(child)) return;
          if (ts.isVariableDeclaration(child) && child.initializer
            && ts.isIdentifier(unwrapExpression(child.initializer))
            && symbolDeclarations(checker, unwrapExpression(child.initializer)).includes(parameter)) {
            collectBindings(child.name);
          }
          ts.forEachChild(child, visitBindings);
        };
        visitBindings(implementation.body as ts.Node);
      }
    }
    return [...new Set(declarations)];
  }

  function emitLiteralValue(node: ts.Expression) {
    const id = stableId(node, 'literal-value');
    emitEntity({
      stableId: id,
      labels: ['Value', 'LiteralValue'],
      props: { ...sourceProps(node), name: node.getText(node.getSourceFile()) },
    });
    return id;
  }

  function propertyNameText(node: ts.ObjectLiteralElementLike | ts.BindingElement) {
    const name = node.propertyName || node.name;
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
    return name.getText(name.getSourceFile());
  }

  function declaredReturnTypeForWrappedObject(node: ts.ObjectLiteralExpression): ts.Type | undefined {
    let current: ts.Node = node;
    while (current.parent) {
      const parent = current.parent;
      if (ts.isReturnStatement(parent) && parent.expression) {
        const owner = enclosingFunction(parent);
        return owner?.type ? checker.getTypeFromTypeNode(owner.type) : undefined;
      }
      if (ts.isFunctionLike(parent)) {
        if (parent.type) return checker.getTypeFromTypeNode(parent.type);
        const wrapperCall = parent.parent;
        if (
          (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent))
          && ts.isCallExpression(wrapperCall)
          && wrapperCall.arguments[0] === parent
          && (
            isIdentityCallable(wrapperCall)
            || ['useCallback', 'useMemo', 'memo', 'forwardRef'].includes(
              callableTargetNode(wrapperCall.expression).getText(wrapperCall.getSourceFile()),
            )
          )
        ) {
          current = wrapperCall;
          continue;
        }
        return undefined;
      }
      current = parent;
    }
    return undefined;
  }

  function emitObjectConstruction(node: ts.ObjectLiteralExpression): string {
    const id = stableId(node, 'object-construction');
    if (emittedObjects.has(node)) return id;
    emittedObjects.add(node);
    emitEntity({
      stableId: id,
      labels: ['Value', 'Object', 'ObjectConstruction'],
      props: { ...sourceProps(node), name: 'object literal' },
    });
    markEnclosingFunctionImplementation(node, id);
    const contextualTypes = [checker.getContextualType(node), declaredReturnTypeForWrappedObject(node)]
      .filter((type): type is ts.Type => Boolean(type));
    node.properties.forEach((property, index) => {
      if (ts.isSpreadAssignment(property)) {
        const spreadId = stableId(property, 'object-spread');
        emitEntity({ stableId: spreadId, labels: ['Value', 'ValueProjection', 'SpreadValue'],
          props: { ...sourceProps(property), index } });
        emitRelationship(id, spreadId, 'SPREADS_FROM', { index, layer: 'functional', overwriteOrder: 'left-to-right' });
        emitRelationship(spreadId, emitExpressionValue(property.expression), 'VALUE_FROM', { layer: 'functional' });
        return;
      }
      const propertyId = stableId(property, 'property-value');
      const propertyName = propertyNameText(property);
      emitEntity({
        stableId: propertyId,
        labels: ['Value', 'PropertyValue'],
        props: { ...sourceProps(property), name: propertyName, index },
      });
      emitRelationship(id, propertyId, 'HAS_PROPERTY', { index, propertyName, layer: 'functional', ownership: 'direct' });
      const contextualDeclarations = [...new Set([...contextualTypes.flatMap((type) => {
        const member = checker.getNonNullableType(type).getProperty(propertyName);
        return member?.declarations || (member?.valueDeclaration ? [member.valueDeclaration] : []);
      }), ...declaredMembers.contextualMembers(node, propertyName)])];
      for (const declaration of contextualDeclarations) {
        emitRelationship(
          propertyId,
          emitDeclaration(declaration, 'MemberDeclaration'),
          'SATISFIES_MEMBER',
          { resolution: 'typescript-checker', layer: 'functional' },
        );
      }
      let value: ts.Expression | undefined;
      if (ts.isPropertyAssignment(property)) value = property.initializer;
      else if (ts.isShorthandPropertyAssignment(property)) value = property.name;
      else if (ts.isMethodDeclaration(property)) {
        const functionId = emitDeclaration(property, 'ValueDeclaration');
        const functionEntity = entities.get(functionId);
        if (functionEntity) functionEntity.labels = [...new Set([...functionEntity.labels, 'FunctionImplementation'])];
        emitRelationship(propertyId, functionId, 'VALUE_FROM', { layer: 'functional' });
      }
      if (value) {
        const valueId = emitExpressionValue(value);
        emitRelationship(propertyId, valueId, 'VALUE_FROM', { layer: 'functional' });
        if (ts.isPropertyAssignment(property) && valueId === stableId(value)) {
          emitRelationship(propertyId, valueId, 'AST_CHILD', {
            field: 'initializer', order: 1, layer: 'syntax',
          });
        }
        const implementations = callbackImplementations(value);
        for (const declaration of contextualDeclarations) {
          if (!implementations.length) continue;
          const targets = callbackImplementationsByPropMember.get(declaration) || new Set<ts.FunctionLikeDeclaration>();
          implementations.forEach((implementation) => targets.add(implementation));
          callbackImplementationsByPropMember.set(declaration, targets);
        }
      }
    });
    return id;
  }

  function emitJsxConstruction(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement) {
    const id = stableId(node, 'component-construction');
    emitEntity({
      stableId: id,
      labels: ['Operation', 'Call', 'ComponentConstruction'],
      props: { ...sourceProps(node), name: node.tagName.getText(node.getSourceFile()) },
    });
    markEnclosingFunctionImplementation(node, id);
    // A single attribute has the same source range as the attribute list.
    const propsId = `${id}:jsx-props`;
    emitEntity({ stableId: propsId, labels: ['Value', 'Object', 'ObjectConstruction', 'ArgumentValue'],
      props: { ...sourceProps(node.attributes), name: 'props', composition: 'ordered-jsx-attributes' } });
    emitRelationship(id, propsId, 'HAS_ARGUMENT', { index: 0, layer: 'functional' });
    for (const signature of checker.getSignaturesOfType(checker.getTypeAtLocation(node.tagName), ts.SignatureKind.Call)) {
      const parameter = signature.declaration?.parameters[0];
      const declaration = signature.declaration;
      if (declaration && ts.isFunctionLike(declaration) && 'body' in declaration && declaration.body) {
        emitRelationship(id, emitDeclaration(declaration, 'ValueDeclaration'), 'CALLS', {
          resolution: 'typescript-checker-jsx-implementation-signature', layer: 'functional',
        });
      }
      if (parameter) emitRelationship(propsId, emitDeclaration(parameter, 'ValueDeclaration'), 'BINDS_TO_PARAMETER', {
        index: 0, callSiteStableId: id, resolution: 'typescript-checker-jsx-props', layer: 'functional',
      });
    }
    for (const declaration of symbolDeclarations(checker, node.tagName)) {
      emitRelationship(id, emitDeclaration(declaration, 'ValueDeclaration'), 'CALLS', {
        resolution: 'typescript-checker',
        layer: 'functional',
      });
    }
    node.attributes.properties.forEach((attribute, index) => {
      if (ts.isJsxSpreadAttribute(attribute)) {
        const spreadId = stableId(attribute, 'jsx-spread');
        emitEntity({ stableId: spreadId, labels: ['Value', 'ValueProjection', 'SpreadValue'],
          props: { ...sourceProps(attribute), index } });
        emitRelationship(propsId, spreadId, 'SPREADS_FROM', { index, layer: 'functional', overwriteOrder: 'left-to-right' });
        emitRelationship(spreadId, emitExpressionValue(attribute.expression), 'VALUE_FROM', { layer: 'functional' });
        return;
      }
      const propertyId = stableId(attribute, 'jsx-property-value');
      const propertyName = attribute.name.text;
      emitEntity({
        stableId: propertyId,
        labels: ['Value', 'PropertyValue', 'JsxPropertyValue'],
        props: { ...sourceProps(attribute), name: propertyName, index },
      });
      emitRelationship(id, propertyId, 'HAS_PROPERTY', { index, propertyName, layer: 'functional' });
      emitRelationship(propsId, propertyId, 'HAS_PROPERTY', { index, propertyName, layer: 'functional' });
      const propDeclarations = jsxPropMemberDeclarations(node, propertyName);
      for (const declaration of propDeclarations) {
        emitRelationship(propertyId, emitDeclaration(declaration, 'MemberDeclaration'), 'SATISFIES_MEMBER', {
          resolution: 'typescript-checker',
          layer: 'functional',
        });
      }
      const initializer = attribute.initializer;
      if (!initializer) return;
      if (ts.isJsxExpression(initializer) && initializer.expression) {
        emitRelationship(propertyId, emitExpressionValue(initializer.expression), 'VALUE_FROM', { layer: 'functional' });
        if (propertyName === 'value' && ts.isPropertyAccessExpression(node.tagName) && node.tagName.name.text === 'Provider') {
          for (const context of symbolDeclarations(checker, node.tagName.expression)) {
            if (!ts.isVariableDeclaration(context) || !context.initializer) continue;
            const creation = unwrapExpression(context.initializer);
            if (!ts.isCallExpression(creation) || !isReactApiCall(checker, creation, ['createContext'])) continue;
            emitRelationship(propertyId, emitDeclaration(context, 'ValueDeclaration'), 'PROVIDES_CONTEXT', {
              providerStableId: id, resolution: 'react-context-provenance', layer: 'functional',
            });
          }
        }
        const implementations = callbackImplementations(initializer.expression);
        for (const declaration of propDeclarations) {
          if (!implementations.length) continue;
          const targets = callbackImplementationsByPropMember.get(declaration) || new Set<ts.FunctionLikeDeclaration>();
          implementations.forEach((implementation) => targets.add(implementation));
          callbackImplementationsByPropMember.set(declaration, targets);
        }
      } else if (ts.isStringLiteral(initializer)) {
        emitRelationship(propertyId, emitLiteralValue(initializer), 'VALUE_FROM', { layer: 'functional' });
      }
    });
    return id;
  }

  function emitCall(node: ts.CallExpression): string {
    const id = stableId(node, 'call');
    if (emittedCalls.has(node)) return id;
    emittedCalls.add(node);
    const origin = classifyCallOrigin(checker, node);
    emitEntity({
      stableId: id,
      labels: ['Operation', 'Call', 'CallResult'],
      props: { ...sourceProps(node), name: node.expression.getText(node.getSourceFile()),
        call_origin: origin.kind, call_origin_declaration_stable_id: origin.declarationStableId,
        call_origin_declaration_path: origin.declarationPath, call_origin_package: origin.packageName },
    });
    markEnclosingFunctionImplementation(node, id);
    if (node.arguments[0] && isReactApiCall(checker, node, ['useContext'])) {
      emitRelationship(id, emitExpressionValue(node.arguments[0]), 'READS_CONTEXT', {
        resolution: 'react-context-provenance', layer: 'functional',
      });
    }
    const targetNode = callableTargetNode(node.expression);
    const callableExpression = unwrapExpression(node.expression);
    const referenceKind = ts.isPropertyAccessExpression(callableExpression) ? 'MemberReference' : 'ValueReference';
    const namedTarget = ts.isIdentifier(callableExpression) || ts.isPropertyAccessExpression(callableExpression)
      || (callableExpression.kind >= ts.SyntaxKind.FirstKeyword && callableExpression.kind <= ts.SyntaxKind.LastKeyword);
    const referenceId = namedTarget ? emitReference(targetNode, referenceKind) : emitExpressionValue(callableExpression);
    emitRelationship(id, referenceId, 'CALLS_VALUE', { layer: 'functional',
      ...(!namedTarget ? { role: 'callee', resolution: 'ast-computed-callee' } : {}) });
    const setterSymbol = resolveSymbol(checker, targetNode);
    const stateId = setterSymbol && reactStateBySetterSymbol.get(setterSymbol);
    if (stateId) {
      emitRelationship(id, stateId, 'WRITES_TO', {
        layer: 'functional',
        resolution: 'react-state-provenance',
      });
    }
    if (ts.isPropertyAccessExpression(callableExpression)) {
      emitRelationship(referenceId, emitExpressionValue(callableExpression.expression), 'READS_FROM', {
        role: 'receiver',
        layer: 'functional',
      });
    }

    const signature = checker.getResolvedSignature(node);
    const signatureDeclaration = signature?.declaration;
    for (const declaration of symbolDeclarations(checker, targetNode)) {
      if (ts.isBindingElement(declaration)) pendingPropCallbackCalls.push({ call: node, member: declaration });
    }
    if (signatureDeclaration) {
      const members = ts.isPropertyAccessExpression(callableExpression)
        ? memberDeclarationsAt(callableExpression.name)
        : [callableMemberDeclaration(signatureDeclaration)].filter((member): member is ts.Declaration => Boolean(member));
      for (const member of members) pendingPropCallbackCalls.push({ call: node, member });
    }
    if (signatureDeclaration) {
      emitRelationship(id, emitDeclaration(signatureDeclaration, declarationCategory(signatureDeclaration)), 'CALLS', {
        resolution: 'typescript-checker',
        layer: 'functional',
      });
    } else {
      for (const declaration of symbolDeclarations(checker, targetNode)) {
        emitRelationship(id, emitDeclaration(declaration), 'CALLS', {
          resolution: 'typescript-checker',
          layer: 'functional',
        });
      }
    }

    node.arguments.forEach((argument, index) => {
      const argumentId = stableId(argument, `argument-value:${index}`);
      emitEntity({
        stableId: argumentId,
        labels: ['Value', 'ArgumentValue'],
        props: { ...sourceProps(argument), name: `argument ${index}`, index },
      });
      emitRelationship(id, argumentId, 'HAS_ARGUMENT', { index, layer: 'functional' });
      emitRelationship(argumentId, emitExpressionValue(argument), 'VALUE_FROM', { layer: 'functional' });
      const parameters = signatureDeclaration?.parameters || [];
      const lastParameter = parameters.at(-1);
      const parameter = parameters[index] || (lastParameter?.dotDotDotToken ? lastParameter : undefined);
      if (parameter) {
        emitRelationship(argumentId, emitDeclaration(parameter, 'ValueDeclaration'), 'BINDS_TO_PARAMETER', {
          index,
          resolution: 'typescript-checker',
          layer: 'functional',
        });
      }
    });
    const signatureParameters = signatureDeclaration?.parameters || [];
    const forwardedArgumentsIndex = signatureParameters.findIndex((parameter) => Boolean(parameter.dotDotDotToken));
    if (forwardedArgumentsIndex > 0 && node.arguments[0]) {
      const implementations = callbackImplementations(node.arguments[0]);
      for (const implementation of implementations) {
        implementation.parameters.forEach((parameter, callbackParameterIndex) => {
          const callArgumentIndex = forwardedArgumentsIndex + callbackParameterIndex;
          const argument = node.arguments[callArgumentIndex];
          if (!argument) return;
          emitRelationship(
            stableId(argument, `argument-value:${callArgumentIndex}`),
            emitDeclaration(parameter, 'ValueDeclaration'),
            'BINDS_TO_PARAMETER',
            {
              index: callbackParameterIndex,
              callArgumentIndex,
              resolution: 'typescript-checker-rest-callback-forwarding',
              layer: 'functional',
            },
          );
        });
      }
    }
    if (node.arguments[0] && isIdentityCallable(node)) {
      emitRelationship(id, emitExpressionValue(node.arguments[0]), 'VALUE_FROM', {
        transform: 'identity-callback',
        resolution: 'external-api-semantics',
        layer: 'functional',
      });
    }
    return id;
  }

  function emitExpressionValue(expression: ts.Expression): string {
    let node = expression;
    while (
      ts.isParenthesizedExpression(node)
      || ts.isAsExpression(node)
      || ts.isTypeAssertionExpression(node)
      || ts.isSatisfiesExpression(node)
      || ts.isNonNullExpression(node)
    ) node = node.expression;
    if (ts.isObjectLiteralExpression(node)) return emitObjectConstruction(node);
    if (ts.isJsxElement(node)) return emitJsxConstruction(node.openingElement);
    if (ts.isJsxSelfClosingElement(node)) return emitJsxConstruction(node);
    if (ts.isCallExpression(node)) return emitCall(node);
    if (ts.isAwaitExpression(node)) {
      const id = stableId(node);
      emitEntity({ stableId: id, labels: ['CodeEntity', 'SyntaxPart', 'SyntaxContainer', 'System'],
        props: { ...sourceProps(node), syntaxKind: 'AwaitExpression' } });
      emitRelationship(id, emitExpressionValue(node.expression), 'CONSUMES_VALUE', {
        layer: 'functional', role: 'awaited', resolution: 'ast-operand',
      });
      return id;
    }
    const shortCircuit = ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind);
    if (shortCircuit || ts.isPrefixUnaryExpression(node)) {
      const id = stableId(node);
      emitEntity({ stableId: id, labels: ['CodeEntity', 'SyntaxPart', 'SyntaxContainer', 'System'],
        props: { ...sourceProps(node), syntaxKind: ts.SyntaxKind[node.kind] } });
      const operands: [ts.Expression, string][] = ts.isBinaryExpression(node)
        ? [[node.left, 'left'], [node.right, 'right']] : [[(node as ts.PrefixUnaryExpression).operand, 'operand']];
      for (const [operand, role] of operands) {
        const operandId = emitExpressionValue(operand);
        emitRelationship(id, operandId, 'CONSUMES_VALUE', {
          layer: 'functional', role, resolution: 'ast-operand',
          ...(shortCircuit && role === 'right' ? { evaluation: 'short-circuit-conditional' } : {}),
        });
        if (operandId === stableId(operand)) emitRelationship(id, operandId, 'AST_CHILD', {
          field: role, layer: 'syntax',
        });
      }
      return id;
    }
    const binaryUse = ts.isBinaryExpression(node)
      && !(node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
      && ![ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.CommaToken].includes(node.operatorToken.kind);
    if (binaryUse || ts.isElementAccessExpression(node)) {
      const id = stableId(node, 'value-consumption');
      emitEntity({ stableId: id, labels: ['Operation', 'ValueConsumption'],
        props: { ...sourceProps(node), consumptionKind: binaryUse ? 'binary-operation' : 'index-access' } });
      markEnclosingFunctionImplementation(node, id);
      const operands: [ts.Expression, string][] = ts.isBinaryExpression(node)
        ? [[node.left, 'left'], [node.right, 'right']]
        : [[(node as ts.ElementAccessExpression).expression, 'receiver'], [(node as ts.ElementAccessExpression).argumentExpression, 'index']];
      for (const [operand, role] of operands) emitRelationship(id, emitExpressionValue(operand), 'CONSUMES_VALUE', {
        layer: 'functional', role, resolution: 'ast-operand',
      });
      return id;
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const id = emitDeclaration(node, 'ValueDeclaration');
      const entity = entities.get(id);
      if (entity) entity.labels = [...new Set([...entity.labels, 'FunctionImplementation', 'CallbackImplementation'])];
      return id;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const id = emitReference(node.name, 'MemberReference');
      emitRelationship(id, emitExpressionValue(node.expression), 'READS_FROM', {
        role: 'receiver', propertyName: node.name.text, layer: 'functional',
      });
      return id;
    }
    if (ts.isIdentifier(node)) return emitReference(node, 'ValueReference');
    return emitLiteralValue(node);
  }

  function returnedObjectProperties(declaration: ts.SignatureDeclaration, propertyName: string) {
    const matches: string[] = [];
    const body = declaration.body;
    if (!body) return matches;
    function inspect(current: ts.Node): void {
      if (current !== body && ts.isFunctionLike(current)) return;
      if (ts.isReturnStatement(current) && current.expression && ts.isObjectLiteralExpression(current.expression)) {
        for (const property of current.expression.properties) {
          if (ts.isSpreadAssignment(property) || propertyNameText(property) !== propertyName) continue;
          emitObjectConstruction(current.expression);
          const propertyId = stableId(property, 'property-value');
          emitReturn(current);
          matches.push(propertyId);
        }
      }
      ts.forEachChild(current, inspect);
    }
    inspect(body);
    return matches;
  }

  function emitDestructuredBinding(node: ts.VariableDeclaration | ts.ParameterDeclaration) {
    if (emittedBindings.has(node)) return;
    if (!ts.isObjectBindingPattern(node.name) && !ts.isArrayBindingPattern(node.name)) return;
    if (ts.isVariableDeclaration(node) && !node.initializer) return;
    emittedBindings.add(node);
    const sourceId = ts.isVariableDeclaration(node)
      ? emitExpressionValue(node.initializer!)
      : emitDeclaration(node, 'ValueDeclaration');
    const signature = ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)
      ? checker.getResolvedSignature(node.initializer)
      : undefined;
    node.name.elements.forEach((element, index) => {
      if (ts.isOmittedExpression(element)) return;
      const bindingId = emitDeclaration(element, 'ValueDeclaration');
      const projectionId = stableId(element, 'value-projection');
      const propertyName = ts.isObjectBindingPattern(node.name) ? propertyNameText(element) : String(index);
      emitEntity({
        stableId: projectionId,
        labels: ['Value', 'ValueProjection', ts.isObjectBindingPattern(node.name) ? 'PropertyProjection' : 'ElementProjection'],
        props: { ...sourceProps(element), name: propertyName, index },
      });
      emitRelationship(bindingId, projectionId, 'VALUE_FROM', { layer: 'functional' });
      emitRelationship(projectionId, sourceId, 'READS_FROM', { propertyName, index, layer: 'functional' });

      const sourceType = checker.getTypeAtLocation(ts.isVariableDeclaration(node) ? node.initializer! : node);
      const member = ts.isObjectBindingPattern(node.name) ? sourceType.getProperty(propertyName) : undefined;
      for (const declaration of member?.declarations || []) {
        emitRelationship(projectionId, emitDeclaration(declaration, 'MemberDeclaration'), 'RESOLVES_TO_MEMBER', {
          resolution: 'typescript-checker',
          layer: 'functional',
        });
      }
      const targetDeclaration = signature?.declaration;
      if (targetDeclaration && ts.isObjectBindingPattern(node.name)) {
        const targetId = emitDeclaration(targetDeclaration, declarationCategory(targetDeclaration));
        const targetEntity = entities.get(targetId);
        if (targetEntity) targetEntity.labels = [...new Set([...targetEntity.labels, 'ValueOriginProvider'])];
        for (const propertyId of returnedObjectProperties(targetDeclaration, propertyName)) {
          emitRelationship(projectionId, propertyId, 'SELECTS_RETURN_PROPERTY', {
            resolution: 'typescript-checker',
            layer: 'functional',
          });
        }
      }
    });
  }

  function emitReturn(node: ts.ReturnStatement) {
    if (emittedReturns.has(node) || !node.expression) return;
    emittedReturns.add(node);
    const owner = enclosingFunction(node);
    if (!owner) return;
    const ownerId = emitDeclaration(owner, 'ValueDeclaration');
    const returnId = stableId(node);
    const valueId = emitExpressionValue(node.expression);
    const expressionId = stableId(node.expression);
    if (!entities.has(expressionId)) {
      emitEntity({ stableId: expressionId, labels: ['CodeEntity', 'SyntaxPart', 'SyntaxContainer', 'System'],
        props: { ...sourceProps(node.expression), syntaxKind: ts.SyntaxKind[node.expression.kind] } });
      let order = 0;
      ts.forEachChild(node.expression, child => {
        const childId = stableId(child);
        if (entities.has(childId) && childId !== expressionId) {
          emitRelationship(expressionId, childId, 'AST_CHILD', {
            ...syntaxChildDescriptor(node.expression!, child, order), layer: 'syntax',
          });
        }
        order += 1;
      });
    }
    emitEntity({ stableId: returnId, labels: ['CodeEntity', 'SyntaxPart', 'SyntaxContainer', 'System'],
      props: { ...sourceProps(node), syntaxKind: 'ReturnStatement' } });
    emitRelationship(returnId, expressionId, 'AST_CHILD', {
      field: 'expression', order: 0, layer: 'syntax',
    });
    // Return-field resolution also visits bodies outside the requested scope.
    // Only out-of-scope statements need early ownership. Tracked statements get
    // their nearest owner in the final AST pass, after containers are materialized.
    let ancestor = node.parent;
    const skippedSyntaxKinds: string[] = [];
    while (!isTrackedSourceFile(node.getSourceFile()) && ancestor) {
      const ancestorId = ancestor === owner ? ownerId : stableId(ancestor);
      if (entities.has(ancestorId)) {
        emitRelationship(returnId, ancestorId, 'ENCLOSED_BY', {
          layer: 'structural', resolution: 'nearest-materialized-ast-owner',
          skippedSyntaxKinds: JSON.stringify(skippedSyntaxKinds),
        });
        break;
      }
      skippedSyntaxKinds.push(ts.SyntaxKind[ancestor.kind]);
      ancestor = ancestor.parent;
    }
    emitRelationship(
      ownerId,
      valueId,
      'RETURNS_VALUE',
      { layer: 'functional' },
    );
  }

  function emitWrite(node: ts.BinaryExpression) {
    if (emittedWrites.has(node) || node.operatorToken.kind < ts.SyntaxKind.FirstAssignment || node.operatorToken.kind > ts.SyntaxKind.LastAssignment) return;
    emittedWrites.add(node);
    const id = stableId(node, 'value-write');
    const refWrite = ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'current';
    emitEntity({
      stableId: id,
      labels: ['Operation', 'ValueWrite', ...(refWrite ? ['RefWrite'] : ['StateWrite'])],
      props: { ...sourceProps(node), name: node.left.getText(node.getSourceFile()), operator: node.operatorToken.getText(node.getSourceFile()) },
    });
    markEnclosingFunctionImplementation(node, id);
    const targetId = ts.isPropertyAccessExpression(node.left)
      ? refWrite
        ? emitReference(node.left.expression, 'ValueReference')
        : emitReference(node.left.name, 'MemberReference')
      : ts.isIdentifier(node.left)
        ? emitReference(node.left, 'ValueReference')
        : emitLiteralValue(node.left as ts.Expression);
    emitRelationship(id, targetId, 'WRITES_TO', {
      layer: 'functional',
      ...(refWrite ? { memberName: 'current', targetKind: 'ref-object' } : {}),
    });
    emitRelationship(id, emitExpressionValue(node.right), 'VALUE_FROM', { layer: 'functional' });
  }

  function visit(sourceFile: ts.SourceFile, node: ts.Node): void {
    visitedSourceNodes.push(node);
    // Keep declaration containers so the generic AST pass can express ownership
    // without treating a rendered identifier tile as the declaration's parent.
    if (isOwnershipSyntaxContainer(node)) {
      emitEntity({ stableId: stableId(node),
        labels: ['CodeEntity', 'SyntaxPart', 'SyntaxContainer',
          ...(ts.isVariableDeclarationList(node) || ts.isVariableStatement(node)
            || ts.isCatchClause(node) || ts.isExportAssignment(node) ? ['DeclarationContainer'] : []),
          ...(ts.isExportAssignment(node) ? [] : ['System'])],
        props: { ...sourceProps(node), syntaxKind: ts.SyntaxKind[node.kind] } });
    }
    if (ts.isTypeNode(node) && isIntrinsicTypeSyntax(node)) emitTypeContext(node);
    if (ts.isNamedTupleMember(node) || ts.isOptionalTypeNode(node) || ts.isRestTypeNode(node)) {
      emitTypeContext(node.type);
    }
    if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      emitEntity({ stableId: stableId(node), labels: ['CodeEntity', 'SyntaxPart', 'System'],
        props: { ...sourceProps(node), syntaxKind: ts.SyntaxKind[node.kind] } });
    }
    if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeParameterDeclaration(node)) {
      emitDeclaration(node, 'TypeDeclaration');
    } else if (
      ts.isClassDeclaration(node)
      || ts.isEnumDeclaration(node)
      || ts.isFunctionDeclaration(node)
      || ts.isVariableDeclaration(node)
      || ts.isParameter(node)
      || ts.isExportAssignment(node)
    ) {
      emitDeclaration(node, 'ValueDeclaration');
    } else if (
      ts.isPropertyDeclaration(node)
      || ts.isPropertySignature(node)
      || ts.isMethodDeclaration(node)
      || ts.isMethodSignature(node)
      || ts.isGetAccessorDeclaration(node)
      || ts.isSetAccessorDeclaration(node)
      || ts.isEnumMember(node)
    ) {
      emitDeclaration(node, 'MemberDeclaration');
    }

    if (
      ts.isPropertyDeclaration(node)
      || ts.isPropertySignature(node)
      || ts.isMethodDeclaration(node)
      || ts.isMethodSignature(node)
      || ts.isGetAccessorDeclaration(node)
      || ts.isSetAccessorDeclaration(node)
      || ts.isEnumMember(node)
    ) {
      const owner = directMemberOwner(node);
      const ownerId = ts.isTypeLiteralNode(node.parent)
        ? emitDerivedType(node.parent)
        : owner ? emitDeclaration(owner, 'TypeDeclaration') : undefined;
      if (ownerId) {
        emitRelationship(
          ownerId,
          emitDeclaration(node, 'MemberDeclaration'),
          'HAS_MEMBER',
          { ownership: 'direct' },
        );
      }
    }

    if (
      (ts.isVariableDeclaration(node)
        || ts.isParameter(node)
        || ts.isPropertyDeclaration(node)
        || ts.isPropertySignature(node))
      && node.type
    ) {
      const declarationId = emitDeclaration(
        node,
        ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)
          ? 'MemberDeclaration'
          : 'ValueDeclaration',
      );
      const typeReferenceId = emitTypeContext(node.type);
      const typeDeclarationIds = targetDeclarationIds(typeReferenceTargetNode(node.type), 'TypeDeclaration');
      if (typeDeclarationIds.length) {
        for (const typeDeclarationId of typeDeclarationIds) {
          emitRelationship(declarationId, typeDeclarationId, 'TYPED_AS', { resolution: 'typescript-checker' });
        }
      } else {
        emitRelationship(declarationId, typeReferenceId, 'TYPED_AS', { resolution: 'typescript-checker' });
      }
    }

    if (ts.isFunctionLike(node)) {
      const callableId = emitDeclaration(node, declarationCategory(node));
      node.parameters.forEach((parameter, index) => {
        emitRelationship(callableId, emitDeclaration(parameter, 'ValueDeclaration'), 'HAS_PARAMETER', {
          index,
          layer: 'structural',
        });
      });
      // Expression-bodied callbacks have a real return value too. Preserve it
      // so consumers can follow a selector without expanding the whole body.
      if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
        emitRelationship(callableId, emitExpressionValue(node.body), 'RETURNS_VALUE', {
          layer: 'functional', implicit: true,
        });
      }
    }

    if (ts.isTypeAliasDeclaration(node)) {
      const aliasId = emitDeclaration(node, 'TypeDeclaration');
      function linkAliasTarget(current: ts.Node): void {
        if (ts.isTypeReferenceNode(current)) {
          for (const targetId of targetDeclarationIds(current.typeName, 'TypeDeclaration')) {
            emitRelationship(aliasId, targetId, 'ALIASES', { resolution: 'typescript-checker', aliasKind: 'type-alias' });
          }
          return;
        }
        ts.forEachChild(current, linkAliasTarget);
      }
      linkAliasTarget(node.type);
    }

    if (ts.isVariableDeclaration(node) && node.initializer) {
      emitDestructuredBinding(node);
      if (ts.isIdentifier(node.name)) {
        emitRelationship(
          emitDeclaration(node, 'ValueDeclaration'),
          emitExpressionValue(node.initializer),
          'VALUE_FROM',
          { layer: 'functional' },
        );
      }
      const initializer = expressionTargetNode(node.initializer);
      if (ts.isIdentifier(initializer) || ts.isPropertyAccessExpression(node.initializer)) {
        const declarationTargets = targetDeclarationIds(initializer, 'ValueDeclaration')
          .filter((targetId) => targetId !== emitDeclaration(node, 'ValueDeclaration'));
        if (declarationTargets.length) {
          const aliasId = stableId(node, 'alias-declaration');
          emitEntity({
            stableId: aliasId,
            labels: ['Declaration', 'AliasDeclaration', 'ValueAliasDeclaration'],
            props: { ...sourceProps(node), name: declarationName(node), aliasKind: 'value-alias' },
          });
          for (const targetId of declarationTargets) {
            emitRelationship(aliasId, targetId, 'ALIASES', { resolution: 'typescript-checker', aliasKind: 'value-alias' });
          }
        }
      }
    }

    if (ts.isExportAssignment(node)) {
      emitRelationship(
        emitDeclaration(node, 'ValueDeclaration'),
        emitExpressionValue(node.expression),
        'VALUE_FROM',
        { layer: 'functional', exportAssignment: true },
      );
    }

    if (ts.isParameter(node)) emitDestructuredBinding(node);

    if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
      const parentId = emitDeclaration(node.parent as ts.Declaration, 'ValueDeclaration');
      const patternId = stableId(node);
      // Untyped parameters may share their exact range with the pattern.
      // Keep their declaration identity instead of marking it as system syntax.
      if (patternId !== parentId) {
        emitEntity({ stableId: patternId, labels: ['CodeEntity', 'SyntaxPart', 'BindingPattern', 'System'],
          props: { ...sourceProps(node), syntaxKind: ts.SyntaxKind[node.kind] } });
      }
      for (const element of node.elements) {
        if (ts.isBindingElement(element)) emitDeclaration(element, 'ValueDeclaration');
      }
    }

    if (ts.isTypeReferenceNode(node) && !isIntrinsicTypeSyntax(node)) {
      emitReference(node.typeName, 'TypeReference');
      emitGenericUse(node);
    } else if (ts.isExpressionWithTypeArguments(node)) {
      emitReference(node.expression, 'TypeReference');
      emitGenericUse(node);
    } else if (isDerivedTypeNode(node)) {
      emitDerivedType(node);
    }

    if (ts.isClassDeclaration(node) && node.name) {
      const classId = emitDeclaration(node, 'ValueDeclaration');
      for (const clause of node.heritageClauses || []) {
        const relation = clause.token === ts.SyntaxKind.ExtendsKeyword ? 'EXTENDS' : 'IMPLEMENTS';
        for (const heritageType of clause.types) {
          for (const targetId of targetDeclarationIds(heritageType.expression)) {
            emitRelationship(classId, targetId, relation, { resolution: 'typescript-checker' });
          }
        }
      }
    }

    if (ts.isImportSpecifier(node)) emitAlias(node, node.name, node.isTypeOnly ? 'type-import' : 'named-import');
    else if (ts.isImportClause(node) && node.name) emitAlias(node, node.name, node.isTypeOnly ? 'type-default-import' : 'default-import');
    else if (ts.isNamespaceImport(node)) emitAlias(node, node.name, 'namespace-import');
    else if (ts.isImportEqualsDeclaration(node)) emitAlias(node, node.name, 'import-equals');

    if (ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) node.exportClause.elements.forEach(emitReExport);
      else if (node.moduleSpecifier) emitReExport(node);
    }

    if (ts.isCallExpression(node)) {
      emitCall(node);
      emitGenericUse(node);
      emitReactWrapper(node);
      if (callName(checker, node.expression) === 'useImperativeHandle' && node.arguments[0]) {
        emitRuntimeRef(node, node.arguments[0]);
      }
    } else if (ts.isNewExpression(node)) {
      emitGenericUse(node);
      node.arguments?.forEach((argument, index) => {
        const argumentId = argument.kind === ts.SyntaxKind.ThisKeyword
          ? emitReference(argument, 'ValueReference') : emitExpressionValue(argument);
        emitRelationship(stableId(node), argumentId, 'HAS_ARGUMENT', {
          index, layer: 'functional', resolution: 'ast-constructor-argument',
        });
      });
    }

    if (ts.isObjectLiteralExpression(node)) emitObjectConstruction(node);

    if (ts.isReturnStatement(node)) emitReturn(node);
    if (ts.isBinaryExpression(node)) {
      emitWrite(node);
      if (!(node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
        && ![ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.CommaToken].includes(node.operatorToken.kind)) emitExpressionValue(node);
    }
    if (ts.isElementAccessExpression(node)) emitExpressionValue(node);
    if (ts.isAwaitExpression(node)) emitExpressionValue(node);

    if (ts.isJsxAttribute(node) && node.name.text === 'ref' && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
      emitRuntimeRef(node, node.initializer.expression);
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) emitJsxConstruction(node);
    if (ts.isJsxExpression(node) && node.expression
      && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      let owner: ts.Node = node.parent;
      while (ts.isJsxFragment(owner)) owner = owner.parent;
      if (ts.isJsxElement(owner)) {
        const emitRenderedValue = (expression: ts.Expression, conditions: Record<string, unknown>[] = []) => {
          const value = unwrapExpression(expression);
          if (ts.isConditionalExpression(value)) {
            const guard = { stableId: stableId(value.condition), syntax: value.condition.getText() };
            emitRenderedValue(value.whenTrue, [...conditions, { ...guard, outcome: true }]);
            emitRenderedValue(value.whenFalse, [...conditions, { ...guard, outcome: false }]);
          } else if (!ts.isJsxElement(value) && !ts.isJsxSelfClosingElement(value)) {
            emitRelationship(stableId((owner as ts.JsxElement).openingElement), emitExpressionValue(value), 'RENDERS_VALUE', {
              layer: 'functional', resolution: 'jsx-child-expression', conditions: JSON.stringify(conditions),
            });
          }
        };
        emitRenderedValue(node.expression);
      }
    }

    if (ts.isPropertyAccessExpression(node)) {
      emitExpressionValue(node);
    } else if (ts.isIdentifier(node) && !isDeclarationName(node)) {
      const parent = node.parent;
      const inTypeReference = ts.isTypeReferenceNode(parent) || ts.isExpressionWithTypeArguments(parent);
      const propertyName = ts.isPropertyAccessExpression(parent) && parent.name === node;
      const importExportName = ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent);
      const propertyDeclarationName = (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node;
      if (!inTypeReference && !propertyName && !importExportName && !propertyDeclarationName) {
        const declarations = symbolDeclarations(checker, node);
        if (declarations.length || (node.text === 'undefined'
          && (checker.getTypeAtLocation(node).flags & ts.TypeFlags.Undefined))) emitReference(node, 'ValueReference');
      }
    }

    ts.forEachChild(node, (child) => visit(sourceFile, child));
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile)) continue;
    const collectReactStateBindings = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node)
        && ts.isArrayBindingPattern(node.name)
        && node.initializer
        && ts.isCallExpression(node.initializer)
        && isReactStateHookCall(checker, node.initializer)) {
        const state = node.name.elements[0];
        const setter = node.name.elements[1];
        if (state && setter
          && !ts.isOmittedExpression(state)
          && !ts.isOmittedExpression(setter)
          && ts.isIdentifier(state.name)
          && ts.isIdentifier(setter.name)) {
          const stateId = emitDeclaration(state, 'ValueDeclaration');
          const stateEntity = entities.get(stateId);
          if (stateEntity) {
            stateEntity.labels = [...new Set([
              ...stateEntity.labels,
              'ValueSlot',
              'StateVariable',
              'ReactState',
            ])];
          }
          const setterSymbol = resolveSymbol(checker, setter.name);
          if (setterSymbol) reactStateBySetterSymbol.set(setterSymbol, stateId);
          const setterId = emitDeclaration(setter, 'ValueDeclaration');
          emitRelationship(setterId, stateId, 'WRITES_TO', {
            resolution: 'react-state-provenance',
            role: 'state-updater',
          });
          markEnclosingFunctionImplementation(state, stateId);
          markEnclosingFunctionImplementation(setter, setterId);
        }
      }
      ts.forEachChild(node, collectReactStateBindings);
    };
    collectReactStateBindings(sourceFile);
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (isTrackedSourceFile(sourceFile)) visit(sourceFile, sourceFile);
  }

  // Resolve higher-order argument forwarding by symbol identity, including
  // gateways whose callback parameter lost its TS annotation during compilation.
  // The outer call site remains evidence on each binding; do not conflate calls.
  const callbackCallsByParameter = new Map<ts.Declaration, ts.CallExpression[]>();
  const projectionParameters = new Map<ts.ParameterDeclaration, boolean>();
  for (const call of emittedCalls) {
    for (const target of symbolDeclarations(checker, callableTargetNode(call.expression))) {
      if (!ts.isParameter(target)) continue;
      const calls = callbackCallsByParameter.get(target) || [];
      calls.push(call);
      callbackCallsByParameter.set(target, calls);
    }
  }
  for (const outerCall of [...emittedCalls]) {
    const signature = checker.getResolvedSignature(outerCall)?.declaration;
    if (!signature) continue;
    outerCall.arguments.forEach((argument, callbackIndex) => {
      const gatewayParameter = signature.parameters[callbackIndex];
      if (!gatewayParameter) return;
      const implementations = callbackImplementations(argument);
      if (!implementations.length) return;
      if (!projectionParameters.has(gatewayParameter)) {
        projectionParameters.set(gatewayParameter, callbackContributesToResult(checker, signature, gatewayParameter));
      }
      if (projectionParameters.get(gatewayParameter)) {
        const callEntity = entities.get(stableId(outerCall));
        if (callEntity) {
          const indexes = (callEntity.props.valueProjectionCallbackIndexes || []) as number[];
          if (!indexes.includes(callbackIndex)) indexes.push(callbackIndex);
          callEntity.props.valueProjectionCallbackIndexes = indexes;
        }
      }
      for (const innerCall of callbackCallsByParameter.get(gatewayParameter) || []) {
        for (const implementation of implementations) {
          innerCall.arguments.forEach((value, index) => {
            const parameter = implementation.parameters[index];
            if (!parameter) return;
            emitRelationship(stableId(value), emitDeclaration(parameter, 'ValueDeclaration'), 'BINDS_TO_PARAMETER', {
              index, layer: 'functional', resolution: 'typescript-checker-callback-forwarding',
              callSiteStableId: stableId(innerCall), outerCallSiteStableId: stableId(outerCall),
            });
            const types = forwardedParameterTypes.get(parameter) || [];
            const valueType = checker.getTypeAtLocation(value);
            const callSiteStableId = stableId(outerCall);
            if (!types.some(row => row.type === valueType && row.callSiteStableId === callSiteStableId)) {
              types.push({ type: valueType, expression: value, callSiteStableId });
            }
            forwardedParameterTypes.set(parameter, types);
          });
        }
      }
    });
  }
  for (const reference of memberReferences) {
    const access = reference.parent;
    if (!ts.isPropertyAccessExpression(access)) continue;
    const memberPath = [access.name.text];
    let receiver = access.expression;
    while (ts.isPropertyAccessExpression(receiver)) {
      memberPath.unshift(receiver.name.text);
      receiver = receiver.expression;
    }
    if (!ts.isIdentifier(receiver)) continue;
    for (const declaration of symbolDeclarations(checker, receiver)) {
      if (!ts.isParameter(declaration)) continue;
      for (const forwarded of forwardedParameterTypes.get(declaration) || []) {
        let type = forwarded.type;
        let member: ts.Symbol | undefined;
        for (const name of memberPath) {
          member = checker.getNonNullableType(type).getProperty(name);
          if (!member) break;
          type = checker.getTypeOfSymbolAtLocation(member, reference);
        }
        const targets = [...new Set([...(member?.declarations || []),
          ...declaredMembers.expressionMemberPath(forwarded.expression, memberPath)])];
        for (const target of targets) {
          const fromId = stableId(reference);
          const toId = emitDeclaration(target, 'MemberDeclaration');
          const key = `${fromId}\u0000RESOLVES_TO\u0000${toId}`;
          const previous = relationships.get(key);
          if (previous) {
            const contexts = previous.props.contextCallSiteStableIds;
            if (Array.isArray(contexts) && !contexts.includes(forwarded.callSiteStableId)) contexts.push(forwarded.callSiteStableId);
          } else {
            emitRelationship(fromId, toId, 'RESOLVES_TO', {
              resolution: 'typescript-checker-callback-receiver',
              contextCallSiteStableIds: [forwarded.callSiteStableId], layer: 'functional',
            });
          }
        }
      }
    }
  }

  // Render composition runs later; preserve concrete operator tokens now so
  // the direct AST owner does not disappear when a rendered tile is added.
  for (const node of visitedSourceNodes) {
    if (ts.isAwaitExpression(node)) {
      const token = node.getChildren(node.getSourceFile()).find(child => child.kind === ts.SyntaxKind.AwaitKeyword);
      if (token) {
        emitEntity({ stableId: stableId(token), labels: ['CodeEntity', 'SyntaxPart', 'System', 'Keyword', 'Await'],
          props: { ...sourceProps(token), name: 'await', syntaxKind: 'AwaitKeyword' } });
        emitRelationship(stableId(node), stableId(token), 'AST_CHILD', {
          field: 'awaitKeyword', layer: 'syntax', resolution: 'typescript-token',
        });
      }
    }
    if (ts.isNewExpression(node) && entities.has(stableId(node))) {
      const token = node.getChildren(node.getSourceFile()).find(child => child.kind === ts.SyntaxKind.NewKeyword);
      if (token) {
        emitEntity({ stableId: stableId(token), labels: ['CodeEntity', 'SyntaxPart', 'System', 'Keyword', 'New'],
          props: { ...sourceProps(token), name: 'new', syntaxKind: 'NewKeyword' } });
        emitRelationship(stableId(node), stableId(token), 'AST_CHILD', {
          field: 'newKeyword', layer: 'syntax', resolution: 'typescript-token',
        });
      }
    }
    if (!ts.isBinaryExpression(node) || !entities.has(stableId(node))) continue;
    const token = node.operatorToken;
    emitEntity({ stableId: stableId(token), labels: ['CodeEntity', 'SyntaxPart', 'System', 'Op', 'Operand'],
      props: { ...sourceProps(token), name: token.getText(token.getSourceFile()),
        syntaxKind: ts.SyntaxKind[token.kind] } });
  }

  // Project containment only across unmaterialized AST nodes. This is not
  // execution flow or value provenance; keep the skipped syntax explicit.
  for (const node of visitedSourceNodes) {
    if (!isOwnershipSyntaxContainer(node)) continue;
    const childId = stableId(node);
    let ancestor = node.parent;
    const skippedSyntaxKinds: string[] = [];
    while (ancestor) {
      const ancestorId = ts.isSourceFile(ancestor)
        ? `source-file:${getRepoRelativePath(ancestor.fileName)}` : stableId(ancestor);
      if (ts.isSourceFile(ancestor)) {
        emitEntity({ stableId: ancestorId, labels: ['CodeEntity', 'SourceFile'],
          props: { ...sourceProps(ancestor), name: getRepoRelativePath(ancestor.fileName),
            syntaxKind: 'SourceFile' } });
      }
      if (ancestorId !== childId && entities.has(ancestorId)) {
        emitRelationship(childId, ancestorId, 'ENCLOSED_BY', {
          layer: 'structural', resolution: 'nearest-materialized-ast-owner',
          skippedSyntaxKinds: JSON.stringify(skippedSyntaxKinds),
        });
        Object.assign(relationships.get(`${childId}\u0000ENCLOSED_BY\u0000${ancestorId}`)!.props, {
          syntaxOwnerResolution: 'nearest-materialized-ast-owner',
          skippedSyntaxKinds: JSON.stringify(skippedSyntaxKinds),
        });
        break;
      }
      skippedSyntaxKinds.push(ts.SyntaxKind[ancestor.kind]);
      ancestor = ancestor.parent;
    }
  }

  for (const parent of visitedSourceNodes) {
    if (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent)) {
      let ancestor: ts.Node | undefined = ts.isJsxOpeningElement(parent) ? parent.parent.parent : parent.parent;
      const conditions: { stableId: string; syntax: string; outcome: boolean | string }[] = [];
      let child: ts.Node = ts.isJsxOpeningElement(parent) ? parent.parent : parent;
      while (ancestor && !ts.isFunctionLike(ancestor)) {
        // JSX passed as a prop is not a proven child in the rendered tree.
        if (ts.isJsxAttribute(ancestor) || ts.isJsxSpreadAttribute(ancestor)) break;
        if (ts.isConditionalExpression(ancestor)) {
          conditions.push({ stableId: stableId(ancestor.condition), syntax: ancestor.condition.getText(),
            outcome: ancestor.whenTrue === child });
        }
        if (ts.isIfStatement(ancestor)) conditions.push({ stableId: stableId(ancestor.expression),
          syntax: ancestor.expression.getText(), outcome: ancestor.thenStatement === child });
        if (ts.isBinaryExpression(ancestor) && ancestor.right === child
          && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(ancestor.operatorToken.kind)) {
          conditions.push({ stableId: stableId(ancestor.left), syntax: ancestor.left.getText(),
            outcome: ancestor.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ? 'nullish'
              : ancestor.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? 'truthy' : 'falsy' });
        }
        if (ts.isJsxElement(ancestor)) {
          emitRelationship(stableId(ancestor.openingElement), stableId(parent), 'JSX_CHILD', {
            layer: 'functional', conditions: JSON.stringify(conditions), resolution: 'lexical-jsx-child',
          });
          break;
        }
        child = ancestor;
        ancestor = ancestor.parent;
      }
      if (ancestor && ts.isFunctionLike(ancestor)) {
        emitRelationship(emitDeclaration(ancestor, 'ValueDeclaration'), stableId(parent), 'DECLARES_JSX', {
          layer: 'functional', conditions: JSON.stringify(conditions), resolution: 'lexical-jsx-root',
        });
      }
    }
    const parentId = ts.isSourceFile(parent)
      ? `source-file:${getRepoRelativePath(parent.fileName)}` : stableId(parent);
    if (!entities.has(parentId)) continue;
    let order = 0;
    ts.forEachChild(parent, (child) => {
      const childId = stableId(child);
      if (entities.has(childId) && childId !== parentId) {
        emitRelationship(parentId, childId, 'AST_CHILD', {
          ...syntaxChildDescriptor(parent, child, order),
          layer: 'syntax',
        });
      }
      order += 1;
    });
  }

  // A callback passed through a JSX property is invoked through the component's
  // local prop binding. Resolve that prop slot back to each concrete callback
  // implementation, then bind the call arguments to the callback parameters.
  // HAS_PARAMETER remains structural; BINDS_TO_PARAMETER is the value-flow edge.
  for (const { call, member } of pendingPropCallbackCalls) {
    const implementations = callbackImplementationsByPropMember.get(member);
    if (!implementations?.size) continue;
    const callId = emitCall(call);
    for (const implementation of implementations) {
      const implementationId = emitDeclaration(implementation, 'ValueDeclaration');
      const implementationEntity = entities.get(implementationId);
      if (implementationEntity) {
        implementationEntity.labels = [...new Set([...implementationEntity.labels, 'FunctionImplementation'])];
      }
      emitRelationship(callId, implementationId, 'CALLS', {
        resolution: 'typescript-checker-jsx-prop-flow',
        layer: 'functional',
      });
      call.arguments.forEach((argument, index) => {
        const lastParameter = implementation.parameters.at(-1);
        const parameter = implementation.parameters[index]
          || (lastParameter?.dotDotDotToken ? lastParameter : undefined);
        if (!parameter) return;
        emitRelationship(
          stableId(argument, `argument-value:${index}`),
          emitDeclaration(parameter, 'ValueDeclaration'),
          'BINDS_TO_PARAMETER',
          {
            index,
            resolution: 'typescript-checker-jsx-prop-flow',
            layer: 'functional',
          },
        );
      });
    }
  }

  const symbols = new Set<ts.Symbol>();
  for (const declaration of declarationIds.keys()) {
    const name = 'name' in declaration ? (declaration as ts.NamedDeclaration).name : undefined;
    if (!name) continue;
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol) symbols.add(symbol);
  }
  for (const symbol of symbols) {
    const parts = [...new Set(symbol.declarations || [])].filter((declaration) => declarationIds.has(declaration));
    if (parts.length < 2) continue;
    const first = parts[0];
    const externalBoundary = parts.every(part => declarationLabels(part, declarationCategory(part)).includes('ExternalBoundary'));
    const mergedId = `symbol:merged:${getExtendedStableId(first.getSourceFile(), first)}`;
    emitEntity({
      stableId: mergedId,
      labels: ['Declaration', 'MergedSymbol', ...(externalBoundary ? ['ExternalBoundary', 'System'] : [])],
      props: { ...sourceProps(first), name: symbol.getName(), declarationPartCount: parts.length },
    });
    for (const part of parts) emitRelationship(mergedId, emitDeclaration(part), 'HAS_DECLARATION_PART');
  }

  for (const declaration of declarationIds.keys()) {
    if (!ts.isFunctionLike(declaration) || declaration.body) continue;
    const name = declaration.name;
    if (!name) continue;
    const symbol = checker.getSymbolAtLocation(name);
    const implementation = symbol?.declarations?.find((candidate): candidate is ts.FunctionLikeDeclaration => ts.isFunctionLike(candidate) && Boolean(candidate.body));
    if (!implementation) continue;
    const signatureId = emitDeclaration(declaration, declarationCategory(declaration));
    const implementationId = emitDeclaration(implementation, declarationCategory(implementation));
    const signatureEntity = entities.get(signatureId);
    const implementationEntity = entities.get(implementationId);
    if (signatureEntity) signatureEntity.labels = [...new Set([...signatureEntity.labels, 'OverloadSignature'])];
    if (implementationEntity) implementationEntity.labels = [...new Set([...implementationEntity.labels, 'FunctionImplementation'])];
    emitRelationship(
      signatureId,
      implementationId,
      'SIGNATURE_OF',
      { resolution: 'typescript-checker' },
    );
  }

  return {
    entities: [...entities.values()].sort((left, right) => left.stableId.localeCompare(right.stableId)),
    relationships: [...relationships.values()].sort((left, right) => (
      left.fromId.localeCompare(right.fromId)
      || left.type.localeCompare(right.type)
      || left.toId.localeCompare(right.toId)
    )),
  };
}
import projectPaths from '../../../dev/projectPaths.cjs';
