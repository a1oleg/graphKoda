import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { buildStableIdFromCoordinates } from '../../packages/runtime-core/src/stableId.js';
import { buildBabelStableIdByDeclaration } from './babelStableIdByDeclaration.js';

type SyntheticDispatchRow = {
  handlerStableId: string;
  handlerName: string;
  componentStableId: string;
  componentName: string;
  actionName: string;
  dispatchKind: 'destructured-get-actions' | 'aliased-get-actions' | 'direct-get-actions' | 'computed-get-actions' | 'notification-action-source' | 'notification-dismiss-action-source' | 'proxied-local-handler';
  line: number;
  column: number;
};

const MAX_STATIC_COMPUTED_ACTION_UNION_SIZE = 8;

type ActionEntrypointRow = {
  actionName: string;
  entrypointStableId: string;
  entrypointName: string;
  filePath: string;
  repoRelativePath: string;
  line: number;
  column: number;
};

type ActionForwardRow = {
  sourceActionName: string;
  targetActionName: string;
  entrypointStableId: string;
  entrypointName: string;
  dispatchKind: 'actions-method-call' | 'request-master-action';
  filePath: string;
  repoRelativePath: string;
  line: number;
  column: number;
};

type ExtractedPayload = {
  syntheticDispatches: SyntheticDispatchRow[];
  actionEntrypoints: ActionEntrypointRow[];
  actionForwards: ActionForwardRow[];
};

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(scriptPath), '..', '..', '..');
const tsconfigPath = path.join(workspaceRoot, 'tsconfig.json');

const COMPONENT_SKIP_PATH_FRAGMENTS = [
  '/node_modules/',
  '/dist/',
  '/build/',
  '/src/lib/gramjs/tl/',
  '/src/components/test/',
  '/src/components/demo/',
  '/src/components/mock/',
];

const GLOBAL_ACTIONS_ROOT = toPosix(path.join(workspaceRoot, 'src/global'));
const COMPONENTS_ROOT = toPosix(path.join(workspaceRoot, 'src/components'));
const SRC_ROOT = toPosix(path.join(workspaceRoot, 'src'));
const NOTIFICATION_COMPONENT_PATH = `${COMPONENTS_ROOT}/ui/Notification.tsx`;

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
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (parent && ts.isPropertyAssignment(parent)) {
    return getPropertyNameText(parent.name);
  }

  return '<anonymous>';
}

function resolveReferencedDeclaration(node: ts.Node, checker: ts.TypeChecker) {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) {
    return undefined;
  }

  const resolvedSymbol = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

  return resolvedSymbol.declarations?.[0];
}

function resolveStaticStringLiteralsFromType(type: ts.Type) {
  const literalValues = new Set<string>();
  const queue = [type];

  while (queue.length) {
    const current = queue.shift()!;
    if (current.isUnion()) {
      queue.push(...current.types);
      continue;
    }

    if (current.isStringLiteral()) {
      literalValues.add(current.value);
    }
  }

  if (!literalValues.size || literalValues.size > MAX_STATIC_COMPUTED_ACTION_UNION_SIZE) {
    return [];
  }

  return [...literalValues];
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

  if (ts.isPropertyAccessExpression(current)) {
    const target = unwrapExpression(current.expression);
    if (ts.isObjectLiteralExpression(target)) {
      const property = target.properties.find((candidate) => {
        if (!ts.isPropertyAssignment(candidate) && !ts.isShorthandPropertyAssignment(candidate)) {
          return false;
        }

        const name = ts.isShorthandPropertyAssignment(candidate)
          ? candidate.name.text
          : getPropertyNameText(candidate.name);
        return name === current.name.text;
      });

      if (property && ts.isPropertyAssignment(property) && ts.isExpression(property.initializer)) {
        return resolveStaticStringLiterals(property.initializer, checker, visitedNodes);
      }
      if (property && ts.isShorthandPropertyAssignment(property)) {
        return resolveStaticStringLiterals(property.name, checker, visitedNodes);
      }
    }
  }

  if (ts.isIdentifier(current) || ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    const declaration = resolveReferencedDeclaration(current, checker);
    if (declaration) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isExpression(declaration.initializer)) {
        const fromInitializer = resolveStaticStringLiterals(declaration.initializer, checker, visitedNodes);
        if (fromInitializer.length) {
          return fromInitializer;
        }
      }

      if (ts.isBindingElement(declaration) && declaration.propertyName && ts.isIdentifier(declaration.name)) {
        const parent = declaration.parent.parent;
        if (ts.isVariableDeclaration(parent) && parent.initializer && ts.isExpression(parent.initializer)) {
          const source = unwrapExpression(parent.initializer);
          if (ts.isObjectLiteralExpression(source)) {
            const propertyName = getPropertyNameText(declaration.propertyName);
            const property = source.properties.find((candidate) => {
              if (!ts.isPropertyAssignment(candidate) && !ts.isShorthandPropertyAssignment(candidate)) {
                return false;
              }
              const candidateName = ts.isShorthandPropertyAssignment(candidate)
                ? candidate.name.text
                : getPropertyNameText(candidate.name);
              return candidateName === propertyName;
            });
            if (property && ts.isPropertyAssignment(property) && ts.isExpression(property.initializer)) {
              const fromProperty = resolveStaticStringLiterals(property.initializer, checker, visitedNodes);
              if (fromProperty.length) {
                return fromProperty;
              }
            }
          }
        }
      }
    }
  }

  const fromType = resolveStaticStringLiteralsFromType(checker.getTypeAtLocation(current));
  if (fromType.length) {
    return fromType;
  }

  return [];
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

function collectReturnedJsxRoots(node: ts.FunctionLikeDeclaration) {
  const roots: ts.Expression[] = [];

  function pushIfJsx(expression: ts.Expression | undefined) {
    if (!expression) {
      return;
    }

    const current = unwrapExpression(expression);
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current) || ts.isJsxFragment(current)) {
      roots.push(current);
    }
  }

  if (node.body && ts.isBlock(node.body)) {
    function visit(current: ts.Node): void {
      if (current !== node.body && isFunctionLikeNode(current)) {
        return;
      }
      if (ts.isReturnStatement(current)) {
        pushIfJsx(current.expression);
        return;
      }
      ts.forEachChild(current, visit);
    }
    visit(node.body);
  } else if (node.body && ts.isExpression(node.body)) {
    pushIfJsx(node.body);
  }

  return roots;
}

function isLikelyComponentName(name: string) {
  return /^[A-Z]/u.test(name);
}

function isRenderHelperName(name: string) {
  return /^render[A-Z_]/u.test(name) || name === 'renderTextWithEntities';
}

function isTrackedComponentSourceFile(sourceFile: ts.SourceFile) {
  if (sourceFile.isDeclarationFile) {
    return false;
  }

  const normalized = toPosix(sourceFile.fileName);
  if (!normalized.startsWith(COMPONENTS_ROOT)) {
    return false;
  }
  if (!normalized.endsWith('.tsx') && !normalized.endsWith('.jsx')) {
    return false;
  }

  return !COMPONENT_SKIP_PATH_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function isTrackedGlobalSourceFile(sourceFile: ts.SourceFile) {
  if (sourceFile.isDeclarationFile) {
    return false;
  }

  const normalized = toPosix(sourceFile.fileName);
  return normalized.startsWith(GLOBAL_ACTIONS_ROOT) && (normalized.endsWith('.ts') || normalized.endsWith('.tsx'));
}

function isTrackedSourceFile(sourceFile: ts.SourceFile) {
  if (sourceFile.isDeclarationFile) {
    return false;
  }

  const normalized = toPosix(sourceFile.fileName);
  if (!normalized.startsWith(SRC_ROOT)) {
    return false;
  }
  if (!normalized.endsWith('.ts') && !normalized.endsWith('.tsx') && !normalized.endsWith('.jsx')) {
    return false;
  }
  if (normalized.includes('/serviceWorker/')) {
    return false;
  }

  return !COMPONENT_SKIP_PATH_FRAGMENTS.some((fragment) => normalized.includes(fragment));
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
  return buildBabelStableIdByDeclaration(
    program,
    (sourceFile) => isTrackedComponentSourceFile(sourceFile) || isTrackedGlobalSourceFile(sourceFile),
    resolveStableIdForDeclaration,
  );
}

function getLocalDeclarationNode(current: ts.Node) {
  if (isFunctionLikeNode(current)) {
    return current;
  }
  if (ts.isVariableDeclaration(current)) {
    return current;
  }
  return undefined;
}

function getDeclarationName(current: ts.Node) {
  if (isFunctionLikeNode(current)) {
    return getFunctionName(current);
  }
  if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
    return current.name.text;
  }

  return '<anonymous>';
}

function collectComponentLocalFunctions(
  componentNode: ts.FunctionLikeDeclaration,
  stableIdByDeclaration: Map<ts.Node, string>,
) {
  const declarationsByStableId = new Map<string, ts.Node>();
  const functionNodeByStableId = new Map<string, ts.FunctionLikeDeclaration>();
  const functionNameByStableId = new Map<string, string>();

  if (!componentNode.body || !ts.isBlock(componentNode.body)) {
    return { declarationsByStableId, functionNodeByStableId, functionNameByStableId };
  }

  function visit(current: ts.Node): void {
    if (current !== componentNode.body && isFunctionLikeNode(current)) {
      const stableId = stableIdByDeclaration.get(current);
      if (stableId) {
        declarationsByStableId.set(stableId, current);
        functionNodeByStableId.set(stableId, current);
        functionNameByStableId.set(stableId, getDeclarationName(current));
      }
      return;
    }

    if (ts.isVariableDeclaration(current)) {
      const wrapped = getWrappedFunctionLike(current.initializer);
      const stableId = stableIdByDeclaration.get(current);
      if (stableId) {
        declarationsByStableId.set(stableId, current);
        if (wrapped) {
          functionNodeByStableId.set(stableId, wrapped);
        }
        functionNameByStableId.set(stableId, getDeclarationName(current));
      }
    }

    ts.forEachChild(current, visit);
  }

  visit(componentNode.body);

  const componentStableId = stableIdByDeclaration.get(componentNode);
  if (componentStableId) {
    declarationsByStableId.set(componentStableId, componentNode);
    functionNodeByStableId.set(componentStableId, componentNode);
    functionNameByStableId.set(componentStableId, getDeclarationName(componentNode));
  }

  return { declarationsByStableId, functionNodeByStableId, functionNameByStableId };
}

function getComponentActionBindings(componentNode: ts.FunctionLikeDeclaration) {
  const destructuredActions = new Map<string, string>();
  const aliasedActionObjects = new Set<string>();

  if (!componentNode.body || !ts.isBlock(componentNode.body)) {
    return { destructuredActions, aliasedActionObjects };
  }

  function visit(current: ts.Node): void {
    if (current !== componentNode.body && isFunctionLikeNode(current)) {
      return;
    }

    if (ts.isVariableDeclaration(current) && current.initializer && ts.isCallExpression(unwrapExpression(current.initializer))) {
      const initializer = unwrapExpression(current.initializer) as ts.CallExpression;
      const expression = unwrapExpression(initializer.expression);

      if (ts.isIdentifier(expression) && expression.text === 'getActions') {
        if (ts.isObjectBindingPattern(current.name)) {
          for (const element of current.name.elements) {
            if (ts.isIdentifier(element.name)) {
              const actionName = element.propertyName && ts.isIdentifier(element.propertyName)
                ? element.propertyName.text
                : element.name.text;
              destructuredActions.set(element.name.text, actionName);
            }
          }
        } else if (ts.isIdentifier(current.name)) {
          aliasedActionObjects.add(current.name.text);
        }
      }
    }

    ts.forEachChild(current, visit);
  }

  visit(componentNode.body);
  return { destructuredActions, aliasedActionObjects };
}

function resolvePropertyValueExpressions(
  expression: ts.Expression,
  propertyName: string,
  checker: ts.TypeChecker,
  visitedNodes = new Set<ts.Node>(),
): ts.Expression[] {
  const current = unwrapExpression(expression);
  if (visitedNodes.has(current)) {
    return [];
  }
  visitedNodes.add(current);

  if (ts.isObjectLiteralExpression(current)) {
    const result: ts.Expression[] = [];
    for (const property of current.properties) {
      if (ts.isPropertyAssignment(property) && getPropertyNameText(property.name) === propertyName) {
        result.push(property.initializer);
      } else if (ts.isShorthandPropertyAssignment(property) && property.name.text === propertyName) {
        result.push(property.name);
      }
    }
    return result;
  }

  if (ts.isConditionalExpression(current)) {
    return [
      ...resolvePropertyValueExpressions(current.whenTrue, propertyName, checker, visitedNodes),
      ...resolvePropertyValueExpressions(current.whenFalse, propertyName, checker, visitedNodes),
    ];
  }

  if (ts.isIdentifier(current) || ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    const declaration = resolveReferencedDeclaration(current, checker);
    if (!declaration) {
      return [];
    }

    if (ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isExpression(declaration.initializer)) {
      return resolvePropertyValueExpressions(declaration.initializer, propertyName, checker, visitedNodes);
    }

    if (ts.isBindingElement(declaration) && declaration.propertyName && ts.isIdentifier(declaration.name)) {
      const parent = declaration.parent.parent;
      if (ts.isVariableDeclaration(parent) && parent.initializer && ts.isExpression(parent.initializer)) {
        const source = unwrapExpression(parent.initializer);
        if (ts.isObjectLiteralExpression(source)) {
          const sourcePropertyName = getPropertyNameText(declaration.propertyName);
          const property = source.properties.find((candidate) => {
            if (!ts.isPropertyAssignment(candidate) && !ts.isShorthandPropertyAssignment(candidate)) {
              return false;
            }
            const candidateName = ts.isShorthandPropertyAssignment(candidate)
              ? candidate.name.text
              : getPropertyNameText(candidate.name);
            return candidateName === sourcePropertyName;
          });

          if (property && ts.isPropertyAssignment(property) && ts.isExpression(property.initializer)) {
            return resolvePropertyValueExpressions(property.initializer, propertyName, checker, visitedNodes);
          }
          if (property && ts.isShorthandPropertyAssignment(property)) {
            return resolvePropertyValueExpressions(property.name, propertyName, checker, visitedNodes);
          }
        }
      }
    }
  }

  return [];
}

function resolveCallbackActionNames(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  visitedNodes = new Set<ts.Node>(),
): string[] {
  const current = unwrapExpression(expression);
  if (visitedNodes.has(current)) {
    return [];
  }
  visitedNodes.add(current);

  if (ts.isArrayLiteralExpression(current)) {
    return [...new Set(current.elements.flatMap((element) => ts.isExpression(element)
      ? resolveCallbackActionNames(element, checker, visitedNodes)
      : []))];
  }

  if (ts.isConditionalExpression(current)) {
    return [...new Set([
      ...resolveCallbackActionNames(current.whenTrue, checker, visitedNodes),
      ...resolveCallbackActionNames(current.whenFalse, checker, visitedNodes),
    ])];
  }

  const propertyVisitedNodes = new Set(visitedNodes);
  propertyVisitedNodes.delete(current);
  const directActionExpressions = resolvePropertyValueExpressions(current, 'action', checker, propertyVisitedNodes);
  if (directActionExpressions.length) {
    return [...new Set(directActionExpressions.flatMap((actionExpression) => resolveStaticStringLiterals(actionExpression, checker)))];
  }

  if (ts.isIdentifier(current) || ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    const declaration = resolveReferencedDeclaration(current, checker);
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isExpression(declaration.initializer)) {
      return resolveCallbackActionNames(declaration.initializer, checker, visitedNodes);
    }
  }

  return [];
}

function collectNotificationHandlerStableIds(program: ts.Program, stableIdByDeclaration: Map<ts.Node, string>) {
  const handlerStableIds = new Map<string, string>();
  let componentStableId: string | undefined;

  for (const sourceFile of program.getSourceFiles()) {
    if (toPosix(sourceFile.fileName) !== NOTIFICATION_COMPONENT_PATH) {
      continue;
    }

    function visit(current: ts.Node): void {
      if (!isFunctionLikeNode(current)) {
        ts.forEachChild(current, visit);
        return;
      }

      if (getFunctionName(current) !== 'Notification' || !collectReturnedJsxRoots(current).length) {
        ts.forEachChild(current, visit);
        return;
      }

      componentStableId = getStableId(sourceFile, current);
      function collectHandlers(node: ts.Node): void {
        if (node !== current.body && isFunctionLikeNode(node)) {
          return;
        }

        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
          const functionName = node.name.text;
          if (functionName === 'handleClick' || functionName === 'handleActionClick' || functionName === 'closeAndDismiss') {
            const stableId = stableIdByDeclaration.get(node);
            if (stableId) {
              handlerStableIds.set(functionName, stableId);
            }
          }
        }

        ts.forEachChild(node, collectHandlers);
      }

      if (current.body) {
        collectHandlers(current.body);
      }
    }

    visit(sourceFile);
  }

  return { handlerStableIds, componentStableId };
}

function extractNotificationSourceDispatches(
  program: ts.Program,
  stableIdByDeclaration: Map<ts.Node, string>,
  checker: ts.TypeChecker,
) {
  const rows: SyntheticDispatchRow[] = [];
  const seenKeys = new Set<string>();
  const { handlerStableIds, componentStableId } = collectNotificationHandlerStableIds(program, stableIdByDeclaration);

  if (!componentStableId || !handlerStableIds.size) {
    return rows;
  }

  function record(
    handlerName: 'handleClick' | 'handleActionClick' | 'closeAndDismiss',
    actionName: string,
    dispatchKind: 'notification-action-source' | 'notification-dismiss-action-source',
    sourceFile: ts.SourceFile,
    node: ts.Node,
  ) {
    const handlerStableId = handlerStableIds.get(handlerName);
    if (!handlerStableId) {
      return;
    }

    const position = getLineAndColumn(sourceFile, node.getStart(sourceFile));
    const key = `${handlerStableId}::${actionName}::${dispatchKind}::${position.line}:${position.column}`;
    if (seenKeys.has(key)) {
      return;
    }

    rows.push({
      handlerStableId,
      handlerName,
      componentStableId,
      componentName: 'Notification',
      actionName,
      dispatchKind,
      line: position.line,
      column: position.column,
    });
    seenKeys.add(key);
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile) || toPosix(sourceFile.fileName) === NOTIFICATION_COMPONENT_PATH) {
      continue;
    }

    function visit(current: ts.Node): void {
      if (!ts.isCallExpression(current) || !current.arguments.length) {
        ts.forEachChild(current, visit);
        return;
      }

      const callee = unwrapExpression(current.expression);
      let isNotificationCall = false;

      if (ts.isIdentifier(callee)) {
        isNotificationCall = callee.text === 'showNotification';
      } else if (ts.isPropertyAccessExpression(callee)) {
        const base = unwrapExpression(callee.expression);
        isNotificationCall = callee.name.text === 'showNotification'
          && ((ts.isIdentifier(base) && base.text === 'actions')
            || (ts.isCallExpression(base)
              && ts.isIdentifier(unwrapExpression(base.expression))
              && unwrapExpression(base.expression).text === 'getActions'));
      }

      if (!isNotificationCall || !ts.isExpression(current.arguments[0])) {
        ts.forEachChild(current, visit);
        return;
      }

      const notificationExpression = current.arguments[0];
      const actionExpressions = resolvePropertyValueExpressions(notificationExpression, 'action', checker);
      const dismissActionExpressions = resolvePropertyValueExpressions(notificationExpression, 'dismissAction', checker);

      for (const actionExpression of actionExpressions) {
        for (const actionName of resolveCallbackActionNames(actionExpression, checker)) {
          record('handleClick', actionName, 'notification-action-source', sourceFile, actionExpression);
          record('handleActionClick', actionName, 'notification-action-source', sourceFile, actionExpression);
        }
      }

      for (const dismissActionExpression of dismissActionExpressions) {
        for (const actionName of resolveCallbackActionNames(dismissActionExpression, checker)) {
          record('closeAndDismiss', actionName, 'notification-dismiss-action-source', sourceFile, dismissActionExpression);
        }
      }

      ts.forEachChild(current, visit);
    }

    visit(sourceFile);
  }

  return rows;
}

function extractSyntheticDispatches(
  sourceFile: ts.SourceFile,
  componentNode: ts.FunctionLikeDeclaration,
  componentName: string,
  stableIdByDeclaration: Map<ts.Node, string>,
  checker: ts.TypeChecker,
  ownerOverride?: { stableId: string; name: string },
) {
  const componentStableId = ownerOverride?.stableId || getStableId(sourceFile, componentNode);
  const resolvedComponentName = ownerOverride?.name || componentName;
  const { destructuredActions, aliasedActionObjects } = getComponentActionBindings(componentNode);
  const { declarationsByStableId, functionNodeByStableId, functionNameByStableId } = collectComponentLocalFunctions(componentNode, stableIdByDeclaration);
  const rows: SyntheticDispatchRow[] = [];
  const seenKeys = new Set<string>();
  const directRowsByHandlerStableId = new Map<string, SyntheticDispatchRow[]>();
  const localCallEdgesByCallerStableId = new Map<string, Array<{ calleeStableId: string; node: ts.Node }>>();

  function record(handlerNode: ts.FunctionLikeDeclaration, actionName: string, dispatchKind: SyntheticDispatchRow['dispatchKind'], node: ts.Node) {
    const handlerStableId = stableIdByDeclaration.get(handlerNode);
    if (!handlerStableId) {
      return;
    }

    const position = getLineAndColumn(sourceFile, node.getStart(sourceFile));
    const key = `${handlerStableId}::${actionName}::${position.line}:${position.column}`;
    if (seenKeys.has(key)) {
      return;
    }

    rows.push({
      handlerStableId,
      handlerName: functionNameByStableId.get(handlerStableId) || getFunctionName(handlerNode),
      componentStableId,
      componentName: resolvedComponentName,
      actionName,
      dispatchKind,
      line: position.line,
      column: position.column,
    });
    seenKeys.add(key);

    if (dispatchKind !== 'proxied-local-handler') {
      const directRows = directRowsByHandlerStableId.get(handlerStableId) || [];
      directRows.push(rows[rows.length - 1]);
      directRowsByHandlerStableId.set(handlerStableId, directRows);
    }
  }

  function recordProxiedDispatch(
    callerStableId: string,
    actionName: string,
    node: ts.Node,
  ) {
    const handlerNode = functionNodeByStableId.get(callerStableId);
    if (!handlerNode) {
      return;
    }

    const position = getLineAndColumn(sourceFile, node.getStart(sourceFile));
    const key = `${callerStableId}::${actionName}::${position.line}:${position.column}`;
    if (seenKeys.has(key)) {
      return;
    }

    rows.push({
      handlerStableId: callerStableId,
      handlerName: functionNameByStableId.get(callerStableId) || getFunctionName(handlerNode),
      componentStableId,
      componentName: resolvedComponentName,
      actionName,
      dispatchKind: 'proxied-local-handler',
      line: position.line,
      column: position.column,
    });
    seenKeys.add(key);
  }

  function addLocalCallEdge(callerStableId: string, calleeStableId: string, node: ts.Node) {
    const edges = localCallEdgesByCallerStableId.get(callerStableId) || [];
    edges.push({ calleeStableId, node });
    localCallEdgesByCallerStableId.set(callerStableId, edges);
  }

  function visitFunction(currentFunction: ts.FunctionLikeDeclaration): void {
    const currentStableId = stableIdByDeclaration.get(currentFunction);
    if (!currentStableId) {
      return;
    }

    function visit(node: ts.Node): void {
      if (node !== currentFunction.body && isFunctionLikeNode(node)) {
        return;
      }

      if (ts.isCallExpression(node)) {
        const expression = unwrapExpression(node.expression);

          if (ts.isIdentifier(expression)) {
            const actionName = destructuredActions.get(expression.text);
            if (actionName) {
              record(currentFunction, actionName, 'destructured-get-actions', expression);
            } else {
            const declaration = resolveReferencedDeclaration(expression, checker);
            const declarationNode = declaration && getLocalDeclarationNode(declaration);
            const calleeStableId = declarationNode && stableIdByDeclaration.get(declarationNode);
            if (calleeStableId && declarationsByStableId.has(calleeStableId)) {
              addLocalCallEdge(currentStableId, calleeStableId, expression);
            }
          }
        } else if (ts.isPropertyAccessExpression(expression)) {
          const base = unwrapExpression(expression.expression);

          if (ts.isIdentifier(base) && aliasedActionObjects.has(base.text)) {
            record(currentFunction, expression.name.text, 'aliased-get-actions', expression.name);
          } else if (ts.isCallExpression(base)) {
            const callee = unwrapExpression(base.expression);
            if (ts.isIdentifier(callee) && callee.text == 'getActions') {
              record(currentFunction, expression.name.text, 'direct-get-actions', expression.name);
            }
          }
        } else if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
          const base = unwrapExpression(expression.expression);
          const actionNames = resolveStaticStringLiterals(expression.argumentExpression, checker);
          if (!actionNames.length) {
            ts.forEachChild(node, visit);
            return;
          }

          const isAliasedActions = ts.isIdentifier(base) && aliasedActionObjects.has(base.text);
          const isDirectGetActions = ts.isCallExpression(base)
            && ts.isIdentifier(unwrapExpression(base.expression))
            && unwrapExpression(base.expression).text === 'getActions';

          if (isAliasedActions || isDirectGetActions) {
            for (const actionName of actionNames) {
              record(currentFunction, actionName, 'computed-get-actions', expression.argumentExpression);
            }
          }
        }

        for (const argument of node.arguments) {
          const argumentExpression = ts.isExpression(argument) ? unwrapExpression(argument) : undefined;
          if (!argumentExpression || !ts.isIdentifier(argumentExpression)) {
            continue;
          }

          const declaration = resolveReferencedDeclaration(argumentExpression, checker);
          const declarationNode = declaration && getLocalDeclarationNode(declaration);
          const argumentStableId = declarationNode && stableIdByDeclaration.get(declarationNode);
          if (argumentStableId && declarationsByStableId.has(argumentStableId)) {
            addLocalCallEdge(currentStableId, argumentStableId, argumentExpression);
          }
        }

        const callee = unwrapExpression(node.expression);
        let isNotificationCall = false;
        if (ts.isIdentifier(callee)) {
          isNotificationCall = callee.text === 'showNotification';
        } else if (ts.isPropertyAccessExpression(callee)) {
          const base = unwrapExpression(callee.expression);
          isNotificationCall = callee.name.text === 'showNotification'
            && ((ts.isIdentifier(base) && aliasedActionObjects.has(base.text))
              || (ts.isCallExpression(base)
                && ts.isIdentifier(unwrapExpression(base.expression))
                && unwrapExpression(base.expression).text === 'getActions'));
        }

        if (isNotificationCall && node.arguments.length && ts.isExpression(node.arguments[0])) {
          const notificationExpression = node.arguments[0];
          const actionExpressions = resolvePropertyValueExpressions(notificationExpression, 'action', checker);
          const dismissActionExpressions = resolvePropertyValueExpressions(notificationExpression, 'dismissAction', checker);
          for (const actionExpression of actionExpressions) {
            for (const actionName of resolveCallbackActionNames(actionExpression, checker)) {
              record(currentFunction, actionName, 'notification-action-source', actionExpression);
            }
          }
          for (const dismissActionExpression of dismissActionExpressions) {
            for (const actionName of resolveCallbackActionNames(dismissActionExpression, checker)) {
              record(currentFunction, actionName, 'notification-dismiss-action-source', dismissActionExpression);
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    if (currentFunction.body) {
      visit(currentFunction.body);
    }
  }

  function walk(current: ts.Node): void {
    if (current !== componentNode && isFunctionLikeNode(current)) {
      visitFunction(current);
    }

    ts.forEachChild(current, walk);
  }

  visitFunction(componentNode);
  walk(componentNode.body ?? componentNode);

  for (const callerStableId of functionNodeByStableId.keys()) {
    const queue = (localCallEdgesByCallerStableId.get(callerStableId) || []).map((edge) => ({
      currentStableId: edge.calleeStableId,
      firstNode: edge.node,
    }));
    const visited = new Set<string>();

    while (queue.length) {
      const current = queue.shift()!;
      const visitKey = `${callerStableId}::${current.currentStableId}`;
      if (visited.has(visitKey)) {
        continue;
      }
      visited.add(visitKey);

      const directRows = directRowsByHandlerStableId.get(current.currentStableId) || [];
      for (const directRow of directRows) {
        recordProxiedDispatch(callerStableId, directRow.actionName, current.firstNode);
      }

      for (const nextEdge of localCallEdgesByCallerStableId.get(current.currentStableId) || []) {
        queue.push({
          currentStableId: nextEdge.calleeStableId,
          firstNode: current.firstNode,
        });
      }
    }
  }

  return rows;
}

function isAddActionHandlerCall(node: ts.CallExpression) {
  const expression = unwrapExpression(node.expression);
  return ts.isIdentifier(expression) && expression.text === 'addActionHandler';
}

function extractActionEntrypoints(program: ts.Program, stableIdByDeclaration: Map<ts.Node, string>) {
  const rows: ActionEntrypointRow[] = [];
  const seenKeys = new Set<string>();

  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedGlobalSourceFile(sourceFile)) {
      continue;
    }

    function visit(current: ts.Node): void {
      if (ts.isCallExpression(current) && isAddActionHandlerCall(current) && current.arguments.length >= 2) {
        const [actionNameArg, handlerArg] = current.arguments;
        if (!ts.isStringLiteralLike(actionNameArg) || !ts.isExpression(handlerArg)) {
          ts.forEachChild(current, visit);
          return;
        }

        const wrappedHandler = getWrappedFunctionLike(handlerArg);
        if (!wrappedHandler) {
          ts.forEachChild(current, visit);
          return;
        }

        const stableId = stableIdByDeclaration.get(wrappedHandler);
        if (!stableId) {
          ts.forEachChild(current, visit);
          return;
        }

        const position = getLineAndColumn(sourceFile, wrappedHandler.getStart(sourceFile));
        const key = `${actionNameArg.text}::${stableId}`;
        if (!seenKeys.has(key)) {
          rows.push({
            actionName: actionNameArg.text,
            entrypointStableId: stableId,
            entrypointName: getFunctionName(wrappedHandler),
            filePath: toPosix(path.resolve(sourceFile.fileName)),
            repoRelativePath: getRepoRelativePath(sourceFile.fileName),
            line: position.line,
            column: position.column,
          });
          seenKeys.add(key);
        }
      }

      ts.forEachChild(current, visit);
    }

    visit(sourceFile);
  }

  return rows;
}

function getObjectLiteralPropertyExpression(objectLiteral: ts.ObjectLiteralExpression, propertyName: string) {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    if (getPropertyNameText(property.name) !== propertyName) {
      continue;
    }
    return ts.isExpression(property.initializer) ? property.initializer : undefined;
  }

  return undefined;
}

function getForwardedActionNamesFromCall(node: ts.CallExpression, checker: ts.TypeChecker) {
  const expression = unwrapExpression(node.expression);
  const actionNames: Array<{ actionName: string; dispatchKind: ActionForwardRow['dispatchKind'] }> = [];

  if (ts.isPropertyAccessExpression(expression) && expression.name.text !== 'requestMasterAndCallAction') {
    const target = unwrapExpression(expression.expression);
    if (ts.isIdentifier(target) && target.text === 'actions') {
      actionNames.push({
        actionName: expression.name.text,
        dispatchKind: 'actions-method-call',
      });
    }
  }

  if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'requestMasterAndCallAction') {
    const target = unwrapExpression(expression.expression);
    const [payloadArg] = node.arguments;
    if (ts.isIdentifier(target) && target.text === 'actions' && payloadArg && ts.isObjectLiteralExpression(unwrapExpression(payloadArg))) {
      const actionExpression = getObjectLiteralPropertyExpression(unwrapExpression(payloadArg) as ts.ObjectLiteralExpression, 'action');
      if (actionExpression) {
        for (const actionName of resolveStaticStringLiterals(actionExpression, checker)) {
          actionNames.push({
            actionName,
            dispatchKind: 'request-master-action',
          });
        }
      }
    }
  }

  return actionNames;
}

function extractActionForwards(
  program: ts.Program,
  stableIdByDeclaration: Map<ts.Node, string>,
  checker: ts.TypeChecker,
) {
  const rows: ActionForwardRow[] = [];
  const seenKeys = new Set<string>();

  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedGlobalSourceFile(sourceFile)) {
      continue;
    }

    function visit(current: ts.Node): void {
      if (ts.isCallExpression(current) && isAddActionHandlerCall(current) && current.arguments.length >= 2) {
        const [actionNameArg, handlerArg] = current.arguments;
        if (!ts.isStringLiteralLike(actionNameArg) || !ts.isExpression(handlerArg)) {
          ts.forEachChild(current, visit);
          return;
        }

        const wrappedHandler = getWrappedFunctionLike(handlerArg);
        if (!wrappedHandler) {
          ts.forEachChild(current, visit);
          return;
        }

        const stableId = stableIdByDeclaration.get(wrappedHandler);
        if (!stableId) {
          ts.forEachChild(current, visit);
          return;
        }

        function visitHandlerBody(node: ts.Node): void {
          if (ts.isCallExpression(node)) {
            for (const forwarded of getForwardedActionNamesFromCall(node, checker)) {
              if (forwarded.actionName === actionNameArg.text) {
                continue;
              }
              const position = getLineAndColumn(sourceFile, node.getStart(sourceFile));
              const key = `${actionNameArg.text}::${stableId}::${forwarded.actionName}::${position.line}:${position.column}`;
              if (!seenKeys.has(key)) {
                rows.push({
                  sourceActionName: actionNameArg.text,
                  targetActionName: forwarded.actionName,
                  entrypointStableId: stableId,
                  entrypointName: getFunctionName(wrappedHandler),
                  dispatchKind: forwarded.dispatchKind,
                  filePath: toPosix(path.resolve(sourceFile.fileName)),
                  repoRelativePath: getRepoRelativePath(sourceFile.fileName),
                  line: position.line,
                  column: position.column,
                });
                seenKeys.add(key);
              }
            }
          }

          ts.forEachChild(node, visitHandlerBody);
        }

        visitHandlerBody(wrappedHandler);
      }

      ts.forEachChild(current, visit);
    }

    visit(sourceFile);
  }

  return rows;
}

function main() {
  const program = createProgram();
  const checker = program.getTypeChecker();
  const stableIdByDeclaration = buildStableIdByDeclaration(program);

  const syntheticDispatches: SyntheticDispatchRow[] = [];
  const processedComponentStableIds = new Set<string>();

  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedComponentSourceFile(sourceFile)) {
      continue;
    }

    function visit(current: ts.Node): void {
      if (isFunctionLikeNode(current)) {
        const componentName = getFunctionName(current);
        const componentStableId = stableIdByDeclaration.get(current);
        if (
          componentName !== '<anonymous>'
          && componentStableId
          && (collectReturnedJsxRoots(current).length || isLikelyComponentName(componentName))
        ) {
          syntheticDispatches.push(...extractSyntheticDispatches(sourceFile, current, componentName, stableIdByDeclaration, checker));
          processedComponentStableIds.add(componentStableId);
        }
      }

      ts.forEachChild(current, visit);
    }

    visit(sourceFile);
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedComponentSourceFile(sourceFile)) {
      continue;
    }

    const topLevelRenderOwners: Array<{ stableId: string; name: string }> = [];
    sourceFile.forEachChild((node) => {
      if (!isFunctionLikeNode(node)) {
        return;
      }
      const name = getFunctionName(node);
      const stableId = stableIdByDeclaration.get(node);
      if (stableId && isRenderHelperName(name)) {
        topLevelRenderOwners.push({ stableId, name });
      }
    });

    if (!topLevelRenderOwners.length) {
      continue;
    }

    const owner = topLevelRenderOwners[0];
    sourceFile.forEachChild((node) => {
      if (!isFunctionLikeNode(node)) {
        return;
      }
      const stableId = stableIdByDeclaration.get(node);
      if (!stableId || processedComponentStableIds.has(stableId) || stableId === owner.stableId) {
        return;
      }
      const rows = extractSyntheticDispatches(sourceFile, node, getFunctionName(node), stableIdByDeclaration, checker, owner);
      if (rows.length) {
        syntheticDispatches.push(...rows);
      }
    });
  }

  const actionEntrypoints = extractActionEntrypoints(program, stableIdByDeclaration);
  const actionForwards = extractActionForwards(program, stableIdByDeclaration, checker);

  const payload: ExtractedPayload = {
    syntheticDispatches: syntheticDispatches.sort((left, right) => `${left.handlerStableId}::${left.actionName}::${left.line}:${left.column}`
      .localeCompare(`${right.handlerStableId}::${right.actionName}::${right.line}:${right.column}`)),
    actionEntrypoints: actionEntrypoints.sort((left, right) => `${left.actionName}::${left.entrypointStableId}`
      .localeCompare(`${right.actionName}::${right.entrypointStableId}`)),
    actionForwards: actionForwards.sort((left, right) => `${left.sourceActionName}::${left.targetActionName}::${left.entrypointStableId}`
      .localeCompare(`${right.sourceActionName}::${right.targetActionName}::${right.entrypointStableId}`)),
  };

  process.stdout.write(JSON.stringify(payload));
}

main();
