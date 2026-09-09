import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { buildStableIdFromCoordinates } from '../../packages/runtime-core/src/stableId.js';
import { buildBabelStableIdByDeclaration } from './babelStableIdByDeclaration.js';

type GuardEffect = 'allows' | 'blocks' | 'short-circuits';

type GuardedOperationRow = {
  operationKey: string;
  parentFnStableId: string;
  parentFnName: string;
  predicateId: string;
  decisionId: string;
  branchId?: string;
  branchScopeKey: string;
  branchKind: 'then' | 'else' | 'fallthrough';
  guardEffect: GuardEffect;
  filePath: string;
  repoRelativePath: string;
  line: number;
  column: number;
  operationName: string;
  operationKind: 'action-dispatch' | 'static-call';
  targetStableId?: string;
  targetName?: string;
  actionName?: string;
};

type ExtractedPayload = {
  guardedOperations: GuardedOperationRow[];
};

type ActionBindings = {
  destructuredActions: Map<string, string>;
  actionObjectAliases: Set<string>;
};

type OperationTarget = {
  key: string;
  operationName: string;
  operationKind: 'action-dispatch' | 'static-call';
  targetStableId?: string;
  targetName?: string;
  actionName?: string;
  line: number;
  column: number;
};

type StaticTarget = {
  stableId: string;
  targetName?: string;
};

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = projectPaths.sourceRoot;
const tsconfigPath = path.join(workspaceRoot, 'tsconfig.json');
const SRC_ROOT = toPosix(path.join(workspaceRoot, 'src'));
const COMPONENTS_ROOT = `${SRC_ROOT}/components`;
const GLOBAL_ROOT = `${SRC_ROOT}/global`;

const SKIP_PATH_FRAGMENTS = [
  '/node_modules/',
  '/dist/',
  '/build/',
  '/src/lib/gramjs/tl/',
  '/src/components/test/',
  '/src/components/demo/',
  '/src/components/mock/',
];

const formatHost: ts.FormatDiagnosticsHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => workspaceRoot,
  getNewLine: () => '\n',
};

function toPosix(filePath: string) {
  return filePath.replace(/\\/g, '/');
}

function getRepoRelativePath(filePath: string) {
  return toPosix(path.relative(workspaceRoot, filePath));
}

function createProgram() {
  const configText = fs.readFileSync(tsconfigPath, 'utf8');
  const parsedConfig = ts.parseConfigFileTextToJson(tsconfigPath, configText);
  if (parsedConfig.error) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext([parsedConfig.error], formatHost));
  }

  const config = ts.parseJsonConfigFileContent(parsedConfig.config, ts.sys, workspaceRoot);
  if (config.errors.length) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(config.errors, formatHost));
  }

  return ts.createProgram({
    rootNames: config.fileNames,
    options: config.options,
  });
}

function isTrackedSourceFile(sourceFile: ts.SourceFile) {
  if (sourceFile.isDeclarationFile) {
    return false;
  }

  const normalized = toPosix(sourceFile.fileName);
  if (!normalized.startsWith(COMPONENTS_ROOT) && !normalized.startsWith(GLOBAL_ROOT)) {
    return false;
  }
  if (!normalized.endsWith('.ts') && !normalized.endsWith('.tsx') && !normalized.endsWith('.jsx')) {
    return false;
  }

  return !SKIP_PATH_FRAGMENTS.some((fragment) => normalized.includes(fragment));
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

function getFunctionName(node: ts.FunctionLikeDeclaration) {
  if ('name' in node && node.name) {
    return getPropertyNameText(node.name);
  }

  const parent = node.parent;
  if (parent && ts.isCallExpression(parent) && parent.arguments.length >= 2) {
    const expression = unwrapExpression(parent.expression);
    const actionNameArg = parent.arguments[0];
    if (ts.isIdentifier(expression) && expression.text === 'addActionHandler' && ts.isStringLiteralLike(actionNameArg)) {
      return actionNameArg.text;
    }
  }
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (parent && ts.isPropertyAssignment(parent)) {
    return getPropertyNameText(parent.name);
  }

  return '<anonymous>';
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isSatisfiesExpression(current)
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

function getStableId(sourceFile: ts.SourceFile, node: ts.Node) {
  const start = getLineAndColumn(sourceFile, node.getStart(sourceFile));
  return buildStableIdFromCoordinates({
    filePath: toPosix(path.resolve(sourceFile.fileName)),
    startLine: start.line,
    startColumn: start.column,
  });
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

function resolveStableIdForDeclaration(sourceFile: ts.SourceFile, declaration: ts.Node) {
  if (isFunctionLikeNode(declaration)) {
    return getStableId(sourceFile, declaration);
  }

  if (ts.isVariableDeclaration(declaration)) {
    const wrapped = getWrappedFunctionLike(declaration.initializer);
    if (wrapped) {
      return getStableId(sourceFile, wrapped);
    }
  }

  if (ts.isPropertyAssignment(declaration)) {
    const wrapped = getWrappedFunctionLike(declaration.initializer);
    if (wrapped) {
      return getStableId(sourceFile, wrapped);
    }
  }

  return undefined;
}

function buildStableIdByDeclaration(program: ts.Program) {
  return buildBabelStableIdByDeclaration(program, isTrackedSourceFile, resolveStableIdForDeclaration);
}

function resolveReferencedDeclaration(node: ts.Node, checker: ts.TypeChecker) {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) {
    return undefined;
  }

  const resolvedSymbol = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  return resolvedSymbol.declarations?.[0];
}

function resolveStaticStringLiterals(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  visitedNodes = new Set<ts.Node>(),
): string[] {
  const current = unwrapExpression(expression);
  if (visitedNodes.has(current)) {
    return [];
  }
  visitedNodes.add(current);

  if (ts.isStringLiteralLike(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
    return [current.text];
  }

  if (ts.isConditionalExpression(current)) {
    return [...new Set([
      ...resolveStaticStringLiterals(current.whenTrue, checker, visitedNodes),
      ...resolveStaticStringLiterals(current.whenFalse, checker, visitedNodes),
    ])];
  }

  if (ts.isIdentifier(current) || ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    const declaration = resolveReferencedDeclaration(current, checker);
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isExpression(declaration.initializer)) {
      return resolveStaticStringLiterals(declaration.initializer, checker, visitedNodes);
    }
  }

  const type = checker.getTypeAtLocation(current);
  const literalValues = new Set<string>();
  const queue = [type];
  while (queue.length) {
    const currentType = queue.shift()!;
    if (currentType.isUnion()) {
      queue.push(...currentType.types);
      continue;
    }

    if (currentType.isStringLiteral()) {
      literalValues.add(currentType.value);
    }
  }

  return [...literalValues];
}

function getDeclarationDisplayName(declaration: ts.Declaration, fallbackName?: string) {
  if ('name' in declaration && declaration.name) {
    const name = declaration.name;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
      return name.text;
    }
    if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
      return name.text;
    }
  }

  if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
    return declaration.name.text;
  }

  if (ts.isPropertyAssignment(declaration)) {
    return getPropertyNameText(declaration.name);
  }

  return fallbackName;
}

function resolveTargetsFromSymbol(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
  stableIdByDeclaration: Map<ts.Node, string>,
) {
  if (!symbol) {
    return [] as StaticTarget[];
  }

  const resolved = (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol;
  const targets: StaticTarget[] = [];
  const seenStableIds = new Set<string>();

  for (const declaration of resolved.declarations ?? []) {
    const stableId = stableIdByDeclaration.get(declaration) || stableIdByDeclaration.get(declaration.parent);
    if (!stableId || seenStableIds.has(stableId)) {
      continue;
    }

    targets.push({
      stableId,
      targetName: getDeclarationDisplayName(declaration, resolved.getName()),
    });
    seenStableIds.add(stableId);
  }

  return targets;
}

function isGetActionsCall(expression: ts.Expression) {
  const current = unwrapExpression(expression);
  return ts.isCallExpression(current)
    && ts.isIdentifier(unwrapExpression(current.expression))
    && unwrapExpression(current.expression).text === 'getActions';
}

function getActionBindings(functionNode: ts.FunctionLikeDeclaration): ActionBindings {
  const destructuredActions = new Map<string, string>();
  const actionObjectAliases = new Set<string>();

  for (const parameter of functionNode.parameters) {
    if (ts.isIdentifier(parameter.name) && parameter.name.text === 'actions') {
      actionObjectAliases.add(parameter.name.text);
    }
  }

  if (!functionNode.body || !ts.isBlock(functionNode.body)) {
    return { destructuredActions, actionObjectAliases };
  }

  function visit(current: ts.Node): void {
    if (current !== functionNode.body && isFunctionLikeNode(current)) {
      return;
    }

    if (ts.isVariableDeclaration(current) && current.initializer && ts.isCallExpression(unwrapExpression(current.initializer))) {
      const initializer = unwrapExpression(current.initializer) as ts.CallExpression;
      if (!isGetActionsCall(initializer)) {
        ts.forEachChild(current, visit);
        return;
      }

      if (ts.isObjectBindingPattern(current.name)) {
        for (const element of current.name.elements) {
          if (!ts.isIdentifier(element.name)) {
            continue;
          }

          const actionName = element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.name.text;
          destructuredActions.set(element.name.text, actionName);
        }
      } else if (ts.isIdentifier(current.name)) {
        actionObjectAliases.add(current.name.text);
      }
    }

    ts.forEachChild(current, visit);
  }

  visit(functionNode.body);
  return { destructuredActions, actionObjectAliases };
}

function extractActionNamesFromCall(
  callee: ts.Expression,
  bindings: ActionBindings,
  checker: ts.TypeChecker,
) {
  const current = unwrapExpression(callee);

  if (ts.isIdentifier(current)) {
    const actionName = bindings.destructuredActions.get(current.text);
    return actionName ? [actionName] : [];
  }

  if (ts.isPropertyAccessExpression(current)) {
    const base = unwrapExpression(current.expression);
    if (ts.isIdentifier(base) && bindings.actionObjectAliases.has(base.text)) {
      return [current.name.text];
    }
    if (isGetActionsCall(base)) {
      return [current.name.text];
    }
    return [];
  }

  if (ts.isElementAccessExpression(current) && current.argumentExpression) {
    const base = unwrapExpression(current.expression);
    if ((ts.isIdentifier(base) && bindings.actionObjectAliases.has(base.text)) || isGetActionsCall(base)) {
      return resolveStaticStringLiterals(current.argumentExpression, checker);
    }
  }

  return [];
}

function collectOperationTargets(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  stableIdByDeclaration: Map<ts.Node, string>,
  actionBindings: ActionBindings,
) {
  const targets: OperationTarget[] = [];
  const seenKeys = new Set<string>();

  function pushTarget(target: OperationTarget) {
    if (seenKeys.has(target.key)) {
      return;
    }

    targets.push(target);
    seenKeys.add(target.key);
  }

  function visit(current: ts.Node): void {
    if (current !== node && isFunctionLikeNode(current)) {
      return;
    }

    if (ts.isCallExpression(current)) {
      const expression = unwrapExpression(current.expression);
      const position = getLineAndColumn(sourceFile, current.getStart(sourceFile));
      const actionNames = extractActionNamesFromCall(expression, actionBindings, checker);

      if (actionNames.length) {
        for (const actionName of actionNames) {
          pushTarget({
            key: `action:${actionName}:${position.line}:${position.column}`,
            operationName: actionName,
            operationKind: 'action-dispatch',
            actionName,
            line: position.line,
            column: position.column,
          });
        }
      } else {
        const staticTargets = resolveTargetsFromSymbol(checker.getSymbolAtLocation(expression), checker, stableIdByDeclaration);
        for (const target of staticTargets) {
          pushTarget({
            key: `fn:${target.stableId}:${position.line}:${position.column}`,
            operationName: target.targetName || expression.getText(sourceFile),
            operationKind: 'static-call',
            targetStableId: target.stableId,
            targetName: target.targetName,
            line: position.line,
            column: position.column,
          });
        }
      }
    }

    ts.forEachChild(current, visit);
  }

  visit(node);
  return targets;
}

function branchEndsWithTerminator(statement: ts.Statement | undefined): boolean {
  if (!statement) {
    return false;
  }

  const current = ts.isBlock(statement)
    ? statement.statements[statement.statements.length - 1]
    : statement;

  if (!current) {
    return false;
  }

  return ts.isReturnStatement(current)
    || ts.isThrowStatement(current)
    || ts.isBreakStatement(current)
    || ts.isContinueStatement(current);
}

function collectFirstFollowingOperations(
  ifStatement: ts.IfStatement,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  stableIdByDeclaration: Map<ts.Node, string>,
  actionBindings: ActionBindings,
) {
  const parent = ifStatement.parent;
  if (!ts.isBlock(parent)) {
    return [] as OperationTarget[];
  }

  const index = parent.statements.findIndex((statement) => statement === ifStatement);
  if (index < 0) {
    return [] as OperationTarget[];
  }

  for (let nextIndex = index + 1; nextIndex < parent.statements.length && nextIndex <= index + 4; nextIndex += 1) {
    const statement = parent.statements[nextIndex];
    const operations = collectOperationTargets(statement, sourceFile, checker, stableIdByDeclaration, actionBindings);
    if (operations.length) {
      return operations;
    }
  }

  return [];
}

function getDecisionId(sourceFile: ts.SourceFile, node: ts.IfStatement) {
  const start = getLineAndColumn(sourceFile, node.getStart(sourceFile));
  return `${toPosix(sourceFile.fileName)}:${start.line}:${start.column}:if`;
}

function getPredicateId(sourceFile: ts.SourceFile, node: ts.IfStatement) {
  const start = getLineAndColumn(sourceFile, node.getStart(sourceFile));
  return `${toPosix(sourceFile.fileName)}:${start.line}:${start.column}:if#condition`;
}

function getBranchId(sourceFile: ts.SourceFile, node: ts.IfStatement, branchKind: 'then' | 'else') {
  return `${getDecisionId(sourceFile, node)}#${branchKind}`;
}

function extractGuardedOperations(program: ts.Program, stableIdByDeclaration: Map<ts.Node, string>) {
  const rows: GuardedOperationRow[] = [];
  const seenKeys = new Set<string>();
  const checker = program.getTypeChecker();

  function recordRow(
    sourceFile: ts.SourceFile,
    parentFnStableId: string,
    parentFnName: string,
    predicateId: string,
    decisionId: string,
    branchId: string | undefined,
    branchKind: 'then' | 'else' | 'fallthrough',
    guardEffect: GuardEffect,
    target: OperationTarget,
  ) {
    const targetKey = target.actionName || target.targetStableId || target.operationName;
    const operationKey = `${parentFnStableId}:${target.line}:${target.column}:${target.operationKind}:${targetKey}`;
    const branchScopeKey = branchId || `${decisionId}#fallthrough`;
    const rowKey = `${predicateId}:${operationKey}:${guardEffect}:${branchScopeKey}`;
    if (seenKeys.has(rowKey)) {
      return;
    }

    rows.push({
      operationKey,
      parentFnStableId,
      parentFnName,
      predicateId,
      decisionId,
      branchId,
      branchScopeKey,
      branchKind,
      guardEffect,
      filePath: toPosix(sourceFile.fileName),
      repoRelativePath: getRepoRelativePath(sourceFile.fileName),
      line: target.line,
      column: target.column,
      operationName: target.operationName,
      operationKind: target.operationKind,
      targetStableId: target.targetStableId,
      targetName: target.targetName,
      actionName: target.actionName,
    });
    seenKeys.add(rowKey);
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile)) {
      continue;
    }

    function visit(current: ts.Node): void {
      if (ts.isIfStatement(current)) {
        let parentFunction: ts.FunctionLikeDeclaration | undefined;
        for (let cursor: ts.Node | undefined = current; cursor; cursor = cursor.parent) {
          if (isFunctionLikeNode(cursor)) {
            parentFunction = cursor;
            break;
          }
        }

        if (parentFunction) {
          const parentFnStableId = stableIdByDeclaration.get(parentFunction) || stableIdByDeclaration.get(parentFunction.parent);
          if (parentFnStableId) {
            const parentFnName = getFunctionName(parentFunction);
            const predicateId = getPredicateId(sourceFile, current);
            const decisionId = getDecisionId(sourceFile, current);
            const actionBindings = getActionBindings(parentFunction);
            const thenTerminating = branchEndsWithTerminator(current.thenStatement);
            const elseTerminating = branchEndsWithTerminator(current.elseStatement);

            if (thenTerminating) {
              const shortCircuitTargets = collectOperationTargets(
                current.thenStatement,
                sourceFile,
                checker,
                stableIdByDeclaration,
                actionBindings,
              );
              for (const target of shortCircuitTargets) {
                recordRow(sourceFile, parentFnStableId, parentFnName, predicateId, decisionId, getBranchId(sourceFile, current, 'then'), 'then', 'short-circuits', target);
              }

              const allowedTargets = current.elseStatement
                ? collectOperationTargets(current.elseStatement, sourceFile, checker, stableIdByDeclaration, actionBindings)
                : collectFirstFollowingOperations(current, sourceFile, checker, stableIdByDeclaration, actionBindings);
              for (const target of allowedTargets) {
                const allowBranchId = current.elseStatement ? getBranchId(sourceFile, current, 'else') : undefined;
                const allowBranchKind = current.elseStatement ? 'else' as const : 'fallthrough' as const;
                recordRow(sourceFile, parentFnStableId, parentFnName, predicateId, decisionId, allowBranchId, allowBranchKind, 'allows', target);
                recordRow(sourceFile, parentFnStableId, parentFnName, predicateId, decisionId, getBranchId(sourceFile, current, 'then'), 'then', 'blocks', target);
              }
            }

            if (elseTerminating && current.elseStatement) {
              const shortCircuitTargets = collectOperationTargets(
                current.elseStatement,
                sourceFile,
                checker,
                stableIdByDeclaration,
                actionBindings,
              );
              for (const target of shortCircuitTargets) {
                recordRow(sourceFile, parentFnStableId, parentFnName, predicateId, decisionId, getBranchId(sourceFile, current, 'else'), 'else', 'short-circuits', target);
              }

              const allowedTargets = collectOperationTargets(
                current.thenStatement,
                sourceFile,
                checker,
                stableIdByDeclaration,
                actionBindings,
              ).length
                ? collectOperationTargets(current.thenStatement, sourceFile, checker, stableIdByDeclaration, actionBindings)
                : collectFirstFollowingOperations(current, sourceFile, checker, stableIdByDeclaration, actionBindings);
              for (const target of allowedTargets) {
                const allowBranchTargets = collectOperationTargets(current.thenStatement, sourceFile, checker, stableIdByDeclaration, actionBindings);
                const allowBranchId = allowBranchTargets.length ? getBranchId(sourceFile, current, 'then') : undefined;
                const allowBranchKind = allowBranchTargets.length ? 'then' as const : 'fallthrough' as const;
                recordRow(sourceFile, parentFnStableId, parentFnName, predicateId, decisionId, allowBranchId, allowBranchKind, 'allows', target);
                recordRow(sourceFile, parentFnStableId, parentFnName, predicateId, decisionId, getBranchId(sourceFile, current, 'else'), 'else', 'blocks', target);
              }
            }
          }
        }
      }

      ts.forEachChild(current, visit);
    }

    visit(sourceFile);
  }

  rows.sort((left, right) => (
    left.filePath.localeCompare(right.filePath)
    || left.line - right.line
    || left.column - right.column
    || left.operationKey.localeCompare(right.operationKey)
  ));

  return rows;
}

function main() {
  const program = createProgram();
  const stableIdByDeclaration = buildStableIdByDeclaration(program);
  const guardedOperations = extractGuardedOperations(program, stableIdByDeclaration);
  const payload: ExtractedPayload = { guardedOperations };
  process.stdout.write(JSON.stringify(payload));
}

main();
import projectPaths from '../../../dev/projectPaths.cjs';
