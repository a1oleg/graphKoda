import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { buildStableIdByDeclaration, createProgram, getRepoRelativePath, getStableId, isTrackedSourceFile, toPosix } from './functionFlowGraph.infrastructure.js';

type ResolverNodeRow = {
  stableId: string;
  name: string;
  filePath: string;
  repoRelativePath: string;
  line: number;
  column: number;
  returnTypeKeys: string[];
  returnTypeNames: string[];
};

type ResolverEntityEdgeRow = {
  resolverStableId: string;
  targetTypeKey: string;
  targetTypeName: string;
  evidenceKind: 'indexed-access-return' | 'property-access-return';
  accessPath: string;
  containerKind?: 'record' | 'array' | 'unknown';
  slotKind: 'parameter' | 'property-access' | 'other';
  slotName?: string;
  line: number;
  column: number;
};

type ResolverDelegationEdgeRow = {
  fromResolverStableId: string;
  toResolverStableId: string;
  delegationKind: 'return-call' | 'return-union-call';
  passedParameterNames: string[];
  argumentBindings: string[];
  line: number;
  column: number;
};

type ExtractedPayload = {
  resolvers: ResolverNodeRow[];
  resolvesEdges: ResolverEntityEdgeRow[];
  delegationEdges: ResolverDelegationEdgeRow[];
};

type LocalBinding = {
  expression?: ts.Expression;
  accessPath?: string;
};

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(scriptPath), '..', '..', '..');

const TRACKED_TYPE_DIRS = [
  'src/api/types/',
  'src/global/types/',
  'src/types/',
];

const SOURCE_ROOT = 'src/';

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

function getLineAndColumn(sourceFile: ts.SourceFile, position: number) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(position);
  return {
    line: line + 1,
    column: character,
  };
}

function getPropertyNameText(name: ts.PropertyName | ts.BindingName | ts.MemberName | undefined) {
  if (!name) {
    return undefined;
  }

  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  if (ts.isComputedPropertyName(name)) {
    return name.expression.getText();
  }

  return undefined;
}

function isResolverSourceFile(sourceFile: ts.SourceFile) {
  if (!isTrackedSourceFile(sourceFile)) {
    return false;
  }

  return getRepoRelativePath(sourceFile.fileName).startsWith(SOURCE_ROOT);
}

function hasExportModifier(node: ts.Node) {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
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

function getEnclosingFunctionLike(node: ts.Node) {
  let current = node.parent;

  while (current) {
    if (isFunctionLikeNode(current)) {
      return current;
    }

    current = current.parent;
  }

  return undefined;
}

function getFunctionName(node: ts.FunctionLikeDeclaration) {
  if ('name' in node && node.name) {
    const directName = getPropertyNameText(node.name);
    if (directName) {
      return directName;
    }
  }

  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent)) {
    return getPropertyNameText(parent.name);
  }
  if (parent && ts.isPropertyAssignment(parent)) {
    return getPropertyNameText(parent.name);
  }
  if (parent && ts.isBinaryExpression(parent) && ts.isIdentifier(parent.left)) {
    return parent.left.text;
  }

  return undefined;
}

function getFunctionDisplayName(node: ts.FunctionLikeDeclaration, stableId: string) {
  return getFunctionName(node) || stableId;
}

function resolveReferencedDeclaration(node: ts.Node, checker: ts.TypeChecker) {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) {
    return undefined;
  }

  const resolvedSymbol = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  return resolvedSymbol.declarations?.[0];
}

function isTrackedTypeDeclaration(declaration: ts.Declaration | undefined) {
  if (!declaration) {
    return false;
  }

  const sourceFile = declaration.getSourceFile();
  const repoRelativePath = getRepoRelativePath(sourceFile.fileName);
  return TRACKED_TYPE_DIRS.some((prefix) => repoRelativePath.startsWith(prefix));
}

function buildTypeKeyForDeclaration(declaration: ts.Declaration) {
  const sourceFile = declaration.getSourceFile();
  const name = ('name' in declaration && declaration.name && ts.isIdentifier(declaration.name))
    ? declaration.name.text
    : undefined;
  if (!name) {
    return undefined;
  }

  return `${getRepoRelativePath(sourceFile.fileName)}::${name}`;
}

function collectTrackedTypeRefsFromType(checker: ts.TypeChecker, type: ts.Type, seen = new Set<string>()) {
  const rows: Array<{ typeKey: string; typeName: string }> = [];

  function visit(currentType: ts.Type) {
    const typeId = String((currentType as { id?: number }).id ?? checker.typeToString(currentType));
    if (seen.has(typeId)) {
      return;
    }
    seen.add(typeId);

    const symbol = currentType.aliasSymbol || currentType.getSymbol();
    const resolved = symbol && ((symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol);
    let matched = false;
    for (const declaration of resolved?.declarations ?? []) {
      if (!isTrackedTypeDeclaration(declaration)) {
        continue;
      }
      const typeKey = buildTypeKeyForDeclaration(declaration);
      if (!typeKey) {
        continue;
      }
      matched = true;
      rows.push({
        typeKey,
        typeName: resolved?.getName() || checker.typeToString(currentType),
      });
    }
    if (matched) {
      return;
    }

    if (currentType.isUnionOrIntersection()) {
      currentType.types.forEach(visit);
      return;
    }

    for (const typeArgument of checker.getTypeArguments(currentType as ts.TypeReference)) {
      visit(typeArgument);
    }
  }

  visit(type);

  const deduped = new Map<string, { typeKey: string; typeName: string }>();
  rows.forEach((row) => {
    if (!deduped.has(row.typeKey)) {
      deduped.set(row.typeKey, row);
    }
  });

  return [...deduped.values()];
}

function collectReturnStatements(node: ts.FunctionLikeDeclaration) {
  const rows: ts.ReturnStatement[] = [];

  function visit(current: ts.Node): void {
    if (current !== node && isFunctionLikeNode(current)) {
      return;
    }

    if (ts.isReturnStatement(current)) {
      rows.push(current);
    }

    ts.forEachChild(current, visit);
  }

  if (node.body) {
    visit(node.body);
  }

  return rows;
}

function buildBindingAccessPath(baseAccessPath: string | undefined, segment: string) {
  if (!baseAccessPath) {
    return undefined;
  }

  return segment === '[]' ? `${baseAccessPath}[]` : `${baseAccessPath}.${segment}`;
}

function canonicalizeIndexedBaseAccessPath(baseAccessPath: string) {
  if (baseAccessPath === 'global.byTabId') {
    return 'selectTabState()';
  }

  return `${baseAccessPath}[]`;
}

function isEmptyObjectFallbackExpression(expression: ts.Expression) {
  const current = unwrapExpression(expression);
  return ts.isObjectLiteralExpression(current) && current.properties.length === 0;
}

function getBindingPropertySegment(element: ts.BindingElement) {
  if (element.propertyName && ts.isComputedPropertyName(element.propertyName)) {
    return '[]';
  }

  return getPropertyNameText(element.propertyName) || getPropertyNameText(element.name);
}

function getObjectLiteralPropertyExpression(objectLiteral: ts.ObjectLiteralExpression, propertyName: string) {
  for (const property of objectLiteral.properties) {
    if (ts.isPropertyAssignment(property) && getPropertyNameText(property.name) === propertyName) {
      return property.initializer;
    }

    if (ts.isShorthandPropertyAssignment(property) && property.name.text === propertyName) {
      return property.name;
    }
  }

  return undefined;
}

function getReturnedAccessPathFromFunction(
  node: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
  seenFunctions = new Set<ts.Node>(),
): string | undefined {
  if (getFunctionName(node) === 'selectTabState') {
    return 'selectTabState()';
  }

  if (!node.body || seenFunctions.has(node)) {
    return undefined;
  }

  seenFunctions.add(node);
  const localBindings = collectScopeBindings(node, checker, new Set(seenFunctions));
  for (const returnStatement of collectReturnStatements(node)) {
    if (!returnStatement.expression) {
      continue;
    }

    const accessPath = getReturnedAccessPathFromExpression(
      returnStatement.expression,
      localBindings,
      checker,
      new Set(seenFunctions),
    );
    if (accessPath) {
      return accessPath;
    }
  }

  return undefined;
}

function getReturnedAccessPathFromExpression(
  expression: ts.Expression,
  localBindings: Map<string, LocalBinding>,
  checker: ts.TypeChecker,
  seenFunctions = new Set<ts.Node>(),
): string | undefined {
  const current = unwrapExpression(expression);

  if (ts.isIdentifier(current)) {
    const binding = localBindings.get(current.text);
    if (binding?.accessPath) {
      return binding.accessPath;
    }

    if (binding?.expression) {
      return getReturnedAccessPathFromExpression(binding.expression, localBindings, checker, seenFunctions);
    }

    return undefined;
  }

  if (ts.isCallExpression(current)) {
    const declaration = resolveReferencedDeclaration(unwrapExpression(current.expression), checker);
    return declaration && isFunctionLikeNode(declaration)
      ? getReturnedAccessPathFromFunction(declaration, checker, seenFunctions)
      : undefined;
  }

  if (
    ts.isPropertyAccessExpression(current)
    || ts.isPropertyAccessChain(current)
    || ts.isElementAccessExpression(current)
    || ts.isElementAccessChain(current)
  ) {
    const accessPath = getAccessPath(current, localBindings, new Set(), checker);
    return isSupportedStateAccessExpression(current, localBindings, checker) ? accessPath : undefined;
  }

  if (ts.isBinaryExpression(current) && (current.operatorToken.kind === ts.SyntaxKind.BarBarToken || current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
    return getReturnedAccessPathFromExpression(current.left, localBindings, checker, new Set(seenFunctions))
      || getReturnedAccessPathFromExpression(current.right, localBindings, checker, seenFunctions);
  }

  if (ts.isConditionalExpression(current)) {
    return getReturnedAccessPathFromExpression(current.whenTrue, localBindings, checker, new Set(seenFunctions))
      || getReturnedAccessPathFromExpression(current.whenFalse, localBindings, checker, seenFunctions);
  }

  return undefined;
}

function getReturnedPropertyAccessPathFromFunction(
  node: ts.FunctionLikeDeclaration,
  propertyName: string,
  checker: ts.TypeChecker,
  seenFunctions = new Set<ts.Node>(),
): string | undefined {
  if (getFunctionName(node) === 'selectTabState') {
    return buildBindingAccessPath('selectTabState()', propertyName);
  }

  if (!node.body || seenFunctions.has(node)) {
    return undefined;
  }

  seenFunctions.add(node);
  const localBindings = collectScopeBindings(node, checker, new Set(seenFunctions));
  for (const returnStatement of collectReturnStatements(node)) {
    if (!returnStatement.expression) {
      continue;
    }

    const accessPath = getReturnedPropertyAccessPathFromExpression(
      returnStatement.expression,
      propertyName,
      localBindings,
      checker,
      new Set(seenFunctions),
    );
    if (accessPath) {
      return accessPath;
    }

    const baseAccessPath = getReturnedAccessPathFromExpression(
      returnStatement.expression,
      localBindings,
      checker,
      new Set(seenFunctions),
    );
    if (baseAccessPath) {
      return buildBindingAccessPath(baseAccessPath, propertyName);
    }
  }

  return undefined;
}

function getReturnedPropertyAccessPathFromExpression(
  expression: ts.Expression,
  propertyName: string,
  localBindings: Map<string, LocalBinding>,
  checker: ts.TypeChecker,
  seenFunctions = new Set<ts.Node>(),
): string | undefined {
  const current = unwrapExpression(expression);

  if (ts.isObjectLiteralExpression(current)) {
    const propertyExpression = getObjectLiteralPropertyExpression(current, propertyName);
    if (!propertyExpression) {
      return undefined;
    }

    return getAccessPath(propertyExpression, localBindings, new Set(), checker);
  }

  if (ts.isCallExpression(current)) {
    const declaration = resolveReferencedDeclaration(unwrapExpression(current.expression), checker);
    return declaration && isFunctionLikeNode(declaration)
      ? getReturnedPropertyAccessPathFromFunction(declaration, propertyName, checker, seenFunctions)
      : undefined;
  }

  if (ts.isIdentifier(current)) {
    const binding = localBindings.get(current.text);
    if (binding?.accessPath) {
      return buildBindingAccessPath(binding.accessPath, propertyName);
    }

    if (binding?.expression) {
      return getReturnedPropertyAccessPathFromExpression(binding.expression, propertyName, localBindings, checker, seenFunctions);
    }

    return undefined;
  }

  if (
    ts.isPropertyAccessExpression(current)
    || ts.isPropertyAccessChain(current)
    || ts.isElementAccessExpression(current)
    || ts.isElementAccessChain(current)
  ) {
    const accessPath = getAccessPath(current, localBindings, new Set(), checker);
    return isSupportedStateAccessExpression(current, localBindings, checker)
      ? buildBindingAccessPath(accessPath, propertyName)
      : undefined;
  }

  if (ts.isBinaryExpression(current) && (current.operatorToken.kind === ts.SyntaxKind.BarBarToken || current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
    return getReturnedPropertyAccessPathFromExpression(current.left, propertyName, localBindings, checker, new Set(seenFunctions))
      || getReturnedPropertyAccessPathFromExpression(current.right, propertyName, localBindings, checker, seenFunctions);
  }

  if (ts.isConditionalExpression(current)) {
    return getReturnedPropertyAccessPathFromExpression(current.whenTrue, propertyName, localBindings, checker, new Set(seenFunctions))
      || getReturnedPropertyAccessPathFromExpression(current.whenFalse, propertyName, localBindings, checker, seenFunctions);
  }

  return undefined;
}

function collectLocalBindings(
  node: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
  inheritedBindings = new Map<string, LocalBinding>(),
) {
  const bindings = new Map<string, LocalBinding>(inheritedBindings);

  function registerBindingName(name: ts.BindingName, binding: LocalBinding): void {
    if (ts.isIdentifier(name)) {
      bindings.set(name.text, binding);
      return;
    }

    if (ts.isObjectBindingPattern(name)) {
      for (const element of name.elements) {
        if (element.dotDotDotToken) {
          registerBindingName(element.name, {
            accessPath: binding.accessPath,
          });
          continue;
        }

        const propertyName = getBindingPropertySegment(element);
        if (!propertyName) {
          continue;
        }

        const propertyAccessPath = binding.expression
          ? getReturnedPropertyAccessPathFromExpression(binding.expression, propertyName, bindings, checker)
          : undefined;

        registerBindingName(element.name, {
          accessPath: propertyAccessPath ?? buildBindingAccessPath(binding.accessPath, propertyName),
        });
      }

      return;
    }

    if (ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (!ts.isBindingElement(element)) {
          continue;
        }

        if (element.dotDotDotToken) {
          registerBindingName(element.name, {
            accessPath: binding.accessPath,
          });
          continue;
        }

        registerBindingName(element.name, {
          accessPath: buildBindingAccessPath(binding.accessPath, '[]'),
        });
      }
    }
  }

  function visit(current: ts.Node): void {
    if (current !== node && isFunctionLikeNode(current)) {
      return;
    }

    if (ts.isVariableDeclaration(current) && current.initializer && ts.isExpression(current.initializer)) {
      if (ts.isIdentifier(current.name)) {
        bindings.set(current.name.text, { expression: current.initializer });
      } else {
        registerBindingName(current.name, {
          accessPath: getAccessPath(current.initializer, bindings, new Set(), checker),
          expression: current.initializer,
        });
      }
    }

    ts.forEachChild(current, visit);
  }

  if (node.body) {
    visit(node.body);
  }

  return bindings;
}

function collectScopeBindings(
  node: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
  seenFunctions = new Set<ts.Node>(),
) {
  if (seenFunctions.has(node)) {
    return new Map<string, LocalBinding>();
  }

  seenFunctions.add(node);
  const parentFunction = getEnclosingFunctionLike(node);
  const inheritedBindings = parentFunction
    ? collectScopeBindings(parentFunction, checker, seenFunctions)
    : new Map<string, LocalBinding>();

  return collectLocalBindings(node, checker, inheritedBindings);
}

function getAccessPath(
  expression: ts.Expression,
  localBindings?: Map<string, LocalBinding>,
  seenBindings = new Set<string>(),
  checker?: ts.TypeChecker,
): string {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current) || ts.isPropertyAccessChain(current)) {
    const resolvedPropertyPath = checker && localBindings
      ? getReturnedPropertyAccessPathFromExpression(current.expression, current.name.text, localBindings, checker)
      : undefined;
    if (resolvedPropertyPath) {
      return resolvedPropertyPath;
    }

    return `${getAccessPath(current.expression, localBindings, seenBindings, checker)}.${current.name.text}`;
  }
  if (ts.isElementAccessExpression(current) || ts.isElementAccessChain(current)) {
    const resolvedBasePath = checker && localBindings
      ? getReturnedAccessPathFromExpression(current.expression, localBindings, checker)
      : undefined;
    if (resolvedBasePath) {
      return canonicalizeIndexedBaseAccessPath(resolvedBasePath);
    }

    return canonicalizeIndexedBaseAccessPath(getAccessPath(current.expression, localBindings, seenBindings, checker));
  }
  if (ts.isIdentifier(current)) {
    if (localBindings && !seenBindings.has(current.text)) {
      seenBindings.add(current.text);
      const binding = localBindings.get(current.text);
      if (binding?.accessPath) {
        return binding.accessPath;
      }
      if (binding?.expression) {
        return getAccessPath(binding.expression, localBindings, seenBindings, checker);
      }
    }

    return current.text;
  }
  if (ts.isCallExpression(current)) {
    const callee = unwrapExpression(current.expression);
    if (ts.isIdentifier(callee) && callee.text === 'selectTabState') {
      return 'selectTabState()';
    }

    if (checker) {
      const declaration = resolveReferencedDeclaration(callee, checker);
      if (declaration && isFunctionLikeNode(declaration)) {
        const returnedAccessPath = getReturnedAccessPathFromFunction(declaration, checker);
        if (returnedAccessPath) {
          return returnedAccessPath;
        }
      }
    }
  }
  if (ts.isBinaryExpression(current) && (current.operatorToken.kind === ts.SyntaxKind.BarBarToken || current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
    const leftPath = getAccessPath(current.left, localBindings, new Set(seenBindings), checker);
    if (leftPath !== current.left.getText()) {
      return leftPath;
    }

    if (isEmptyObjectFallbackExpression(current.right)) {
      return leftPath;
    }

    return getAccessPath(current.right, localBindings, seenBindings, checker);
  }
  if (ts.isConditionalExpression(current)) {
    const truePath = getAccessPath(current.whenTrue, localBindings, new Set(seenBindings), checker);
    if (truePath !== current.whenTrue.getText()) {
      return truePath;
    }

    if (isEmptyObjectFallbackExpression(current.whenFalse)) {
      return truePath;
    }

    return getAccessPath(current.whenFalse, localBindings, seenBindings, checker);
  }

  return current.getText();
}

function getAccessRootExpression(expression: ts.Expression, localBindings?: Map<string, LocalBinding>, seenBindings = new Set<string>()): ts.Expression {
  let current = unwrapExpression(expression);
  if (ts.isIdentifier(current) && localBindings && !seenBindings.has(current.text)) {
    seenBindings.add(current.text);
    const binding = localBindings.get(current.text);
    if (binding?.expression) {
      return getAccessRootExpression(binding.expression, localBindings, seenBindings);
    }
  }

  while (
    ts.isPropertyAccessExpression(current)
    || ts.isPropertyAccessChain(current)
    || ts.isElementAccessExpression(current)
    || ts.isElementAccessChain(current)
  ) {
    current = unwrapExpression(current.expression);
    if (ts.isIdentifier(current) && localBindings && !seenBindings.has(current.text)) {
      seenBindings.add(current.text);
      const binding = localBindings.get(current.text);
      if (binding?.expression) {
        current = unwrapExpression(binding.expression);
      }
    }
  }

  return current;
}

function isSupportedStateAccessExpression(
  expression: ts.Expression,
  localBindings: Map<string, LocalBinding>,
  checker?: ts.TypeChecker,
) {
  const accessPath = getAccessPath(expression, localBindings, new Set(), checker);
  const rootExpression = getAccessRootExpression(expression, localBindings);

  if (accessPath.startsWith('global.')) {
    return true;
  }

  if (accessPath.startsWith('selectTabState(')) {
    return true;
  }

  if (ts.isCallExpression(rootExpression)) {
    const callee = unwrapExpression(rootExpression.expression);
    return ts.isIdentifier(callee) && callee.text === 'selectTabState';
  }

  return false;
}

function classifySlot(argumentExpression: ts.Expression, parameterNames: Set<string>) {
  const current = unwrapExpression(argumentExpression);
  if (ts.isIdentifier(current) && parameterNames.has(current.text)) {
    return {
      slotKind: 'parameter' as const,
      slotName: current.text,
    };
  }
  if (ts.isPropertyAccessExpression(current) || ts.isPropertyAccessChain(current)) {
    return {
      slotKind: 'property-access' as const,
      slotName: current.getText(),
    };
  }

  return {
    slotKind: 'other' as const,
    slotName: current.getText(),
  };
}

function classifyIndexedContainerKind(expression: ts.ElementAccessExpression | ts.ElementAccessChain, checker: ts.TypeChecker) {
  const containerType = checker.getTypeAtLocation(unwrapExpression(expression.expression));

  if (checker.isArrayType(containerType) || checker.isTupleType(containerType)) {
    return 'array' as const;
  }

  const stringIndexType = checker.getIndexTypeOfType(containerType, ts.IndexKind.String);
  const numberIndexType = checker.getIndexTypeOfType(containerType, ts.IndexKind.Number);
  if (stringIndexType || numberIndexType) {
    return 'record' as const;
  }

  return 'unknown' as const;
}

function collectDelegatedCalls(expression: ts.Expression): Array<{ call: ts.CallExpression; delegationKind: 'return-call' | 'return-union-call' }> {
  const current = unwrapExpression(expression);
  if (ts.isCallExpression(current)) {
    return [{ call: current, delegationKind: 'return-call' }];
  }
  if (ts.isBinaryExpression(current) && (current.operatorToken.kind === ts.SyntaxKind.BarBarToken || current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
    return [
      ...collectDelegatedCalls(current.left).map((row) => ({ ...row, delegationKind: 'return-union-call' as const })),
      ...collectDelegatedCalls(current.right).map((row) => ({ ...row, delegationKind: 'return-union-call' as const })),
    ];
  }
  if (ts.isConditionalExpression(current)) {
    return [
      ...collectDelegatedCalls(current.whenTrue).map((row) => ({ ...row, delegationKind: 'return-union-call' as const })),
      ...collectDelegatedCalls(current.whenFalse).map((row) => ({ ...row, delegationKind: 'return-union-call' as const })),
    ];
  }

  return [];
}

function collectArgumentBindings(
  expression: ts.Expression,
  parameterNames: Set<string>,
  localBindings: Map<string, LocalBinding>,
  checker: ts.TypeChecker,
  stableIdByDeclaration: Map<ts.Node, string>,
  seenNodes = new Set<ts.Node>(),
): string[] {
  const current = unwrapExpression(expression);
  if (seenNodes.has(current)) {
    return [];
  }
  seenNodes.add(current);

  if (ts.isIdentifier(current)) {
    if (parameterNames.has(current.text)) {
      return [`parameter:${current.text}`];
    }

    const binding = localBindings.get(current.text);
    if (!binding) {
      return [`identifier:${current.text}`];
    }

    if (binding.accessPath) {
      return [
        `local:${current.text}`,
        `resolved-access:${binding.accessPath}`,
      ];
    }

    const initializer = binding.expression;
    if (!initializer) {
      return [`identifier:${current.text}`];
    }

    return [
      `local:${current.text}`,
      ...collectArgumentBindings(initializer, parameterNames, localBindings, checker, stableIdByDeclaration, seenNodes),
    ];
  }

  if (ts.isPropertyAccessExpression(current) || ts.isPropertyAccessChain(current)) {
    return [
      `property-access:${current.getText()}`,
      ...collectArgumentBindings(current.expression, parameterNames, localBindings, checker, stableIdByDeclaration, seenNodes),
    ];
  }

  if (ts.isElementAccessExpression(current) || ts.isElementAccessChain(current)) {
    return [
      `indexed-access:${getAccessPath(current)}`,
      ...collectArgumentBindings(current.expression, parameterNames, localBindings, checker, stableIdByDeclaration, seenNodes),
      ...collectArgumentBindings(current.argumentExpression, parameterNames, localBindings, checker, stableIdByDeclaration, seenNodes),
    ];
  }

  if (ts.isCallExpression(current)) {
    const targetDeclaration = resolveReferencedDeclaration(unwrapExpression(current.expression), checker);
    const targetStableId = targetDeclaration
      ? (stableIdByDeclaration.get(targetDeclaration)
        || (isFunctionLikeNode(targetDeclaration) ? getStableId(targetDeclaration.getSourceFile(), targetDeclaration) : undefined))
      : undefined;

    const result = [targetStableId ? `resolver-call:${targetStableId}` : `call:${current.expression.getText()}`];
    for (const argument of current.arguments) {
      result.push(...collectArgumentBindings(argument, parameterNames, localBindings, checker, stableIdByDeclaration, seenNodes));
    }
    return result;
  }

  if (ts.isConditionalExpression(current)) {
    return [
      ...collectArgumentBindings(current.whenTrue, parameterNames, localBindings, checker, stableIdByDeclaration, seenNodes),
      ...collectArgumentBindings(current.whenFalse, parameterNames, localBindings, checker, stableIdByDeclaration, seenNodes),
    ];
  }

  return [`expression:${current.getText()}`];
}

function collectFunctionLikeDeclarations(root: ts.Node) {
  const rows: ts.FunctionLikeDeclaration[] = [];

  function visit(current: ts.Node): void {
    if (isFunctionLikeNode(current) && current.body) {
      rows.push(current);
    }

    ts.forEachChild(current, visit);
  }

  visit(root);
  return rows;
}

function collectStateAccessExpressions(
  node: ts.FunctionLikeDeclaration,
  localBindings: Map<string, LocalBinding>,
  checker: ts.TypeChecker,
) {
  const rows: ts.Expression[] = [];

  function visit(current: ts.Node): void {
    if (current !== node && isFunctionLikeNode(current)) {
      return;
    }

    if (
      (ts.isPropertyAccessExpression(current)
        || ts.isPropertyAccessChain(current)
        || ts.isElementAccessExpression(current)
        || ts.isElementAccessChain(current)
        || ts.isIdentifier(current))
      && isSupportedStateAccessExpression(current, localBindings, checker)
    ) {
      rows.push(current);
    }

    ts.forEachChild(current, visit);
  }

  if (node.body) {
    visit(node.body);
  }

  return rows;
}

function main() {
  const program = createProgram();
  const checker = program.getTypeChecker();
  const stableIdByDeclaration = buildStableIdByDeclaration(program);
  const resolvers: ResolverNodeRow[] = [];
  const resolvesEdges: ResolverEntityEdgeRow[] = [];
  const delegationEdges: ResolverDelegationEdgeRow[] = [];
  const seenResolvers = new Set<string>();
  const seenResolveEdges = new Set<string>();
  const seenDelegationEdges = new Set<string>();
  const resolverStableIds = new Set<string>();

  for (const sourceFile of program.getSourceFiles()) {
    if (!isResolverSourceFile(sourceFile)) {
      continue;
    }

    for (const fnNode of collectFunctionLikeDeclarations(sourceFile)) {
      const stableId = stableIdByDeclaration.get(fnNode) || getStableId(sourceFile, fnNode);
      resolverStableIds.add(stableId);
    }
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (!isResolverSourceFile(sourceFile)) {
      continue;
    }

    for (const fnNode of collectFunctionLikeDeclarations(sourceFile)) {
      const stableId = stableIdByDeclaration.get(fnNode) || getStableId(sourceFile, fnNode);
      const position = getLineAndColumn(sourceFile, fnNode.getStart(sourceFile));
      const filePath = toPosix(path.resolve(sourceFile.fileName));
      const repoRelativePath = getRepoRelativePath(sourceFile.fileName);
      const returnTypeRefs = collectTrackedTypeRefsFromType(checker, checker.getTypeAtLocation(fnNode));
      const parameterNames = new Set(fnNode.parameters.flatMap((parameter) => ts.isIdentifier(parameter.name) ? [parameter.name.text] : []));
      const localBindings = collectScopeBindings(fnNode, checker);
      const returnStatements = collectReturnStatements(fnNode);

      function ensureResolverNode() {
        if (seenResolvers.has(stableId)) {
          return;
        }
        resolvers.push({
          stableId,
          name: getFunctionDisplayName(fnNode, stableId),
          filePath,
          repoRelativePath,
          line: position.line,
          column: position.column,
          returnTypeKeys: returnTypeRefs.map((row) => row.typeKey),
          returnTypeNames: returnTypeRefs.map((row) => row.typeName),
        });
        seenResolvers.add(stableId);
      }

      for (const expression of collectStateAccessExpressions(fnNode, localBindings, checker)) {
        const current = unwrapExpression(expression);
        const edgePosition = getLineAndColumn(sourceFile, current.getStart(sourceFile));
        const accessPath = getAccessPath(current, localBindings, new Set(), checker);
        if (ts.isElementAccessExpression(current) || ts.isElementAccessChain(current)) {
          const expressionTypeRefs = collectTrackedTypeRefsFromType(checker, checker.getTypeAtLocation(current));
          const containerKind = classifyIndexedContainerKind(current, checker);
          const slot = classifySlot(current.argumentExpression, parameterNames);

          for (const targetType of expressionTypeRefs) {
            const key = `${stableId}::${targetType.typeKey}::${current.getText()}`;
            if (seenResolveEdges.has(key)) {
              continue;
            }
            ensureResolverNode();
            resolvesEdges.push({
              resolverStableId: stableId,
              targetTypeKey: targetType.typeKey,
              targetTypeName: targetType.typeName,
              evidenceKind: 'indexed-access-return',
              accessPath,
              containerKind,
              slotKind: slot.slotKind,
              slotName: slot.slotName,
              line: edgePosition.line,
              column: edgePosition.column,
            });
            seenResolveEdges.add(key);
          }
        } else if (ts.isPropertyAccessExpression(current) || ts.isPropertyAccessChain(current)) {
          const expressionTypeRefs = collectTrackedTypeRefsFromType(checker, checker.getTypeAtLocation(current));
          for (const targetType of expressionTypeRefs) {
            const key = `${stableId}::${targetType.typeKey}::${current.getText()}`;
            if (seenResolveEdges.has(key)) {
              continue;
            }
            ensureResolverNode();
            resolvesEdges.push({
              resolverStableId: stableId,
              targetTypeKey: targetType.typeKey,
              targetTypeName: targetType.typeName,
              evidenceKind: 'property-access-return',
              accessPath,
              slotKind: 'other',
              slotName: current.getText(),
              line: edgePosition.line,
              column: edgePosition.column,
            });
            seenResolveEdges.add(key);
          }
        } else if (ts.isIdentifier(current)) {
          const expressionTypeRefs = collectTrackedTypeRefsFromType(checker, checker.getTypeAtLocation(current));
          for (const targetType of expressionTypeRefs) {
            const key = `${stableId}::${targetType.typeKey}::${accessPath}`;
            if (seenResolveEdges.has(key)) {
              continue;
            }

            ensureResolverNode();
            resolvesEdges.push({
              resolverStableId: stableId,
              targetTypeKey: targetType.typeKey,
              targetTypeName: targetType.typeName,
              evidenceKind: 'property-access-return',
              accessPath,
              slotKind: 'other',
              slotName: current.getText(),
              line: edgePosition.line,
              column: edgePosition.column,
            });
            seenResolveEdges.add(key);
          }
        }
      }

      for (const returnStatement of returnStatements) {
        if (!returnStatement.expression) {
          continue;
        }

        const returnExpression = unwrapExpression(returnStatement.expression);
        const delegatedCalls = collectDelegatedCalls(returnExpression);
        for (const { call, delegationKind } of delegatedCalls) {
          const callee = unwrapExpression(call.expression);
          const calleeDeclaration = resolveReferencedDeclaration(callee, checker);
          if (!calleeDeclaration) {
            continue;
          }

          const targetSourceFile = calleeDeclaration.getSourceFile();
          if (!isResolverSourceFile(targetSourceFile)) {
            continue;
          }

          const targetStableId = stableIdByDeclaration.get(calleeDeclaration)
            || (isFunctionLikeNode(calleeDeclaration) ? getStableId(targetSourceFile, calleeDeclaration) : undefined);
          if (!targetStableId || !resolverStableIds.has(targetStableId)) {
            continue;
          }

          const edgePosition = getLineAndColumn(sourceFile, call.getStart(sourceFile));
          const passedParameterNames = call.arguments.flatMap((argument) => {
            const current = unwrapExpression(argument);
            return ts.isIdentifier(current) && parameterNames.has(current.text) ? [current.text] : [];
          });
          const argumentBindings = call.arguments.flatMap((argument, index) => {
            return collectArgumentBindings(argument, parameterNames, localBindings, checker, stableIdByDeclaration)
              .map((binding) => `arg${index}:${binding}`);
          });
          const edgeKey = `${stableId}::${targetStableId}::${call.getText()}`;
          if (seenDelegationEdges.has(edgeKey)) {
            continue;
          }
          ensureResolverNode();
          delegationEdges.push({
            fromResolverStableId: stableId,
            toResolverStableId: targetStableId,
            delegationKind,
            passedParameterNames,
            argumentBindings: [...new Set(argumentBindings)],
            line: edgePosition.line,
            column: edgePosition.column,
          });
          seenDelegationEdges.add(edgeKey);
        }
      }
    }
  }

  const payload: ExtractedPayload = {
    resolvers,
    resolvesEdges,
    delegationEdges,
  };

  const outputArgIndex = process.argv.indexOf('--output-path');
  const outputPath = outputArgIndex >= 0 ? process.argv[outputArgIndex + 1] : undefined;
  const content = `${JSON.stringify(payload, undefined, 2)}\n`;
  if (outputPath) {
    fs.writeFileSync(outputPath, content, 'utf8');
    return;
  }

  process.stdout.write(content);
}

main();