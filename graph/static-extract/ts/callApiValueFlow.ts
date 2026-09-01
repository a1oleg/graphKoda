/// <reference types="node" />

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import ts from 'typescript';
import { buildStableIdFromCoordinates } from '../../packages/runtime-core/src/stableId.js';
import { buildBabelStableIdByDeclaration } from './babelStableIdByDeclaration.js';

type ValueFlowNodeLabel = 'ValueRef' | 'ValueVersion';
type ValueFlowEdgeKind = 'BINDS_VALUE' | 'OF_REF' | 'READS_VALUE' | 'FORWARDS_VALUE' | 'WRITES_VALUE';
type ValueFlowEdgeRole =
  | 'call-arg'
  | 'version-of'
  | 'forward-read'
  | 'public-call-api-param'
  | 'worker-call-api-param'
  | 'worker-request-envelope-param'
  | 'master-request-envelope-param'
  | 'resolved-method-param'
  | 'request-envelope-read'
  | 'request-id-bind'
  | 'request-id-envelope-slot'
  | 'request-id-read'
  | 'request-state-entry'
  | 'request-state-write'
  | 'request-state-read'
  | 'request-callback-store'
  | 'request-callback-entry'
  | 'request-callback-write'
  | 'request-callback-read'
  | 'worker-callback-recreate'
  | 'worker-callback-write'
  | 'worker-callback-read'
  | 'worker-callback-param'
  | 'multitab-callback-recreate'
  | 'multitab-callback-read'
  | 'multitab-callback-param'
  | 'response-payload-correlation'
  | 'response-payload-read'
  | 'error-payload-correlation'
  | 'error-payload-read'
  | 'callback-payload-correlation'
  | 'callback-payload-read';

type ValueFlowNodeRow = {
  stableId: string;
  labels: ValueFlowNodeLabel[];
  label: string;
  kind: ValueFlowNodeLabel;
  parentFnStableId: string;
  repoRelativePath: string;
  callStepStableId: string;
  argIndex: number;
  apiMethodName?: string;
  argTextRaw: string;
  argKind: string;
  valueRefStableId?: string;
};

type ValueFlowEdgeRow = {
  fromKind: 'Step' | 'ValueVersion';
  fromId: string;
  toKind: 'ValueVersion' | 'ValueRef';
  toId: string;
  type: ValueFlowEdgeKind;
  role: ValueFlowEdgeRole;
  stepStableIds?: string[];
  argIndex?: number;
  apiMethodName?: string;
};

type ExtractedPayload = {
  nodes: ValueFlowNodeRow[];
  edges: ValueFlowEdgeRow[];
};

type ResolvedCallTarget = {
  stableId: string;
  name?: string;
  repoRelativePath: string;
  paramNames?: string[];
};

type DeclarationWithOptionalName = ts.SignatureDeclaration | ts.JSDocSignature | ts.NamedDeclaration;

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(scriptPath), '..', '..', '..');
const tsconfigPath = path.join(workspaceRoot, 'tsconfig.json');
const SRC_ROOT = toPosix(path.join(workspaceRoot, 'src'));
const PUBLIC_CALL_API_REPO_PATH = 'src/api/gramjs/worker/connector.ts';
const WORKER_CALL_API_REPO_PATH = 'src/api/gramjs/methods/init.ts';
const METHODS_IMPL_REPO_PREFIX = 'src/api/gramjs/methods/';
const WORKER_RUNTIME_REPO_PATH = 'src/api/gramjs/worker/worker.ts';
const MULTITAB_RUNTIME_REPO_PATH = 'src/util/browser/multitab.ts';
const EXCLUDED_SOURCE_PREFIXES = [
  'src/api/gramjs/worker/',
  'src/api/gramjs/methods/',
];
const EXCLUDED_METHOD_IMPL_REPO_PATHS = new Set([
  WORKER_CALL_API_REPO_PATH,
  'src/api/gramjs/methods/index.ts',
  'src/api/gramjs/methods/types.ts',
]);

const SKIP_PATH_FRAGMENTS = [
  '/node_modules/',
  '/dist/',
  '/build/',
  '/.venv/',
  '/site-packages/',
  '/src/lib/gramjs/tl/',
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
  if (!normalized.startsWith(SRC_ROOT)) {
    return false;
  }

  if (normalized.endsWith('.cjs')) {
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

function getStableIdStartPosition(sourceFile: ts.SourceFile, node: ts.Node) {
  let position = node.getStart(sourceFile);

  if (!isFunctionLikeNode(node) || !node.modifiers?.length) {
    return position;
  }

  let skippedModifierEnd: number | undefined;
  for (const modifier of node.modifiers) {
    if (modifier.kind !== ts.SyntaxKind.ExportKeyword && modifier.kind !== ts.SyntaxKind.DefaultKeyword) {
      break;
    }

    skippedModifierEnd = modifier.getEnd();
  }

  if (skippedModifierEnd === undefined) {
    return position;
  }

  position = skippedModifierEnd;
  while (position < sourceFile.text.length && /\s/.test(sourceFile.text[position])) {
    position += 1;
  }

  return position;
}

function getStableId(sourceFile: ts.SourceFile, node: ts.Node) {
  const start = getLineAndColumn(sourceFile, getStableIdStartPosition(sourceFile, node));
  const endPosition = Math.max(getStableIdStartPosition(sourceFile, node), node.getEnd());
  const end = getLineAndColumn(sourceFile, endPosition);
  return buildStableIdFromCoordinates({
    filePath: toPosix(path.resolve(sourceFile.fileName)),
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  });
}

function getCombinedStableId(sourceFile: ts.SourceFile, firstNode: ts.Node, lastNode: ts.Node) {
  const start = getLineAndColumn(sourceFile, getStableIdStartPosition(sourceFile, firstNode));
  const end = getLineAndColumn(sourceFile, lastNode.getEnd());
  return buildStableIdFromCoordinates({
    filePath: toPosix(path.resolve(sourceFile.fileName)),
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  });
}

function getExtendedStableId(sourceFile: ts.SourceFile, node: ts.Node) {
  const start = getLineAndColumn(sourceFile, getStableIdStartPosition(sourceFile, node));
  const end = getLineAndColumn(sourceFile, node.getEnd());
  return buildStableIdFromCoordinates({
    filePath: toPosix(path.resolve(sourceFile.fileName)),
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  });
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

function parseArgs() {
  const args = process.argv.slice(2);
  const result: { fnStableId?: string } = {};

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--fn-stable-id') {
      result.fnStableId = args[index + 1];
      index += 1;
    }
  }

  return result;
}

function getDeclarationName(declaration: DeclarationWithOptionalName) {
  if (!('name' in declaration) || !declaration.name) {
    return undefined;
  }

  return ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
}

function findParentFunctionStableId(node: ts.Node, stableIdByDeclaration: Map<ts.Node, string>) {
  let current: ts.Node | undefined = node;
  while (current) {
    const stableId = stableIdByDeclaration.get(current);
    if (stableId) {
      return stableId;
    }
    current = current.parent;
  }

  return undefined;
}

function findEnclosingStatement(node: ts.Node) {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isStatement(current)) {
      return current;
    }
    current = current.parent;
  }

  return undefined;
}

function buildStepStableIdCandidates(sourceFile: ts.SourceFile, node: ts.Node) {
  const primaryStableId = getExtendedStableId(sourceFile, node);
  const enclosingStatement = findEnclosingStatement(node);
  const fallbackStableId = enclosingStatement ? getExtendedStableId(sourceFile, enclosingStatement) : undefined;

  return fallbackStableId && fallbackStableId !== primaryStableId
    ? [primaryStableId, fallbackStableId]
    : [primaryStableId];
}

function resolveCallTarget(
  checker: ts.TypeChecker,
  stableIdByDeclaration: Map<ts.Node, string>,
  callExpression: ts.CallExpression,
): ResolvedCallTarget | undefined {
  const signature = checker.getResolvedSignature(callExpression);
  const declaration = signature?.declaration;
  if (!declaration) {
    return undefined;
  }

  const sourceFile = declaration.getSourceFile();
  const stableId = stableIdByDeclaration.get(declaration) || resolveStableIdForDeclaration(sourceFile, declaration);
  if (!stableId) {
    return undefined;
  }

  return {
    stableId,
    name: getDeclarationName(declaration),
    repoRelativePath: getRepoRelativePath(sourceFile.fileName),
  };
}

function isPublicCallApiTarget(target: ResolvedCallTarget | undefined) {
  return target?.name === 'callApi' && target.repoRelativePath === PUBLIC_CALL_API_REPO_PATH;
}

function isExcludedCallSiteSource(repoRelativePath: string) {
  return EXCLUDED_SOURCE_PREFIXES.some((prefix) => repoRelativePath.startsWith(prefix));
}

function getIdentifierText(expression: ts.Expression) {
  const current = unwrapExpression(expression);
  return ts.isIdentifier(current) ? current.text : undefined;
}

function isNamedCallExpression(callExpression: ts.CallExpression, calleeName: string) {
  return getIdentifierText(callExpression.expression) === calleeName;
}

function isCallExpressionText(callExpression: ts.CallExpression, expressionTexts: string[]) {
  const expressionText = unwrapExpression(callExpression.expression).getText();
  return expressionTexts.includes(expressionText);
}

function isMethodsForwardCallExpression(callExpression: ts.CallExpression) {
  const expression = unwrapExpression(callExpression.expression);
  if (!ts.isElementAccessExpression(expression)) {
    return false;
  }

  return getIdentifierText(expression.expression) === 'methods'
    && getIdentifierText(expression.argumentExpression) === 'fnName';
}

function findNamedFunctionNode(program: ts.Program, repoPath: string, functionName: string) {
  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile) || getRepoRelativePath(sourceFile.fileName) != repoPath) {
      continue;
    }

    let result: ts.FunctionLikeDeclaration | undefined;
    function visit(node: ts.Node): void {
      if (result) {
        return;
      }

      if (isFunctionLikeNode(node) && getDeclarationName(node) === functionName) {
        result = node;
        return;
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    if (result) {
      return result;
    }
  }

  return undefined;
}

function buildUniqueMethodFunctionTargets(program: ts.Program, stableIdByDeclaration: Map<ts.Node, string>) {
  const targetsByName = new Map<string, ResolvedCallTarget[]>();

  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile)) {
      continue;
    }

    const repoRelativePath = getRepoRelativePath(sourceFile.fileName);
    if (!repoRelativePath.startsWith(METHODS_IMPL_REPO_PREFIX) || EXCLUDED_METHOD_IMPL_REPO_PATHS.has(repoRelativePath)) {
      continue;
    }

    function visit(node: ts.Node): void {
      const declarationName = isFunctionLikeNode(node) ? getDeclarationName(node) : undefined;
      if (declarationName) {
        const stableId = stableIdByDeclaration.get(node) || resolveStableIdForDeclaration(sourceFile, node);
        if (stableId) {
          const existing = targetsByName.get(declarationName) || [];
          const paramNames = node.parameters.map((parameter, index) => {
            if (ts.isIdentifier(parameter.name)) {
              return parameter.name.text;
            }

            const parameterPatternText = parameter.name.getText(sourceFile).trim();
            return parameterPatternText || `arg${index + 1}`;
          });
          existing.push({
            stableId,
            name: declarationName,
            repoRelativePath,
            paramNames,
          });
          targetsByName.set(declarationName, existing);
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

function collectMatchingCallExpressions(functionNode: ts.FunctionLikeDeclaration, predicate: (callExpression: ts.CallExpression) => boolean) {
  const callExpressions: ts.CallExpression[] = [];

  function visit(node: ts.Node): void {
    if (node !== functionNode && isFunctionLikeNode(node)) {
      return;
    }

    if (ts.isCallExpression(node) && predicate(node)) {
      callExpressions.push(node);
    }

    ts.forEachChild(node, visit);
  }

  visit(functionNode);
  return callExpressions;
}

function collectMatchingExpressions(functionNode: ts.FunctionLikeDeclaration, predicate: (expression: ts.Expression) => boolean) {
  const expressions: ts.Expression[] = [];

  function visit(node: ts.Node): void {
    if (node !== functionNode && isFunctionLikeNode(node)) {
      return;
    }

    if (ts.isExpression(node) && predicate(node)) {
      expressions.push(node);
    }

    ts.forEachChild(node, visit);
  }

  visit(functionNode);
  return expressions;
}

function collectMatchingCallExpressionsInSubtree(root: ts.Node, predicate: (callExpression: ts.CallExpression) => boolean) {
  const callExpressions: ts.CallExpression[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && predicate(node)) {
      callExpressions.push(node);
    }

    ts.forEachChild(node, visit);
  }

  visit(root);
  return callExpressions;
}

function collectVariableStatementsByName(functionNode: ts.FunctionLikeDeclaration, variableName: string) {
  if (!functionNode.body || !ts.isBlock(functionNode.body)) {
    return [] as ts.VariableStatement[];
  }

  return functionNode.body.statements.filter((statement): statement is ts.VariableStatement => {
    if (!ts.isVariableStatement(statement)) {
      return false;
    }

    return statement.declarationList.declarations.some((declaration) => (
      ts.isIdentifier(declaration.name) && declaration.name.text === variableName
    ));
  });
}

function collectRequestEnvelopeBuildSteps(functionNode: ts.FunctionLikeDeclaration) {
  if (!functionNode.body || !ts.isBlock(functionNode.body)) {
    return [] as string[][];
  }

  const statements = functionNode.body.statements;
  const payloadIndex = statements.findIndex((statement) => (
    ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'payload')
  ));
  const promiseIndex = statements.findIndex((statement) => (
    ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'promise')
  ));

  if (payloadIndex < 0 || promiseIndex < payloadIndex) {
    return [];
  }

  return [[getCombinedStableId(functionNode.getSourceFile(), statements[payloadIndex], statements[promiseIndex])]];
}

function buildParamValueRefStableId(fnStableId: string, argIndex: number) {
  return `value-ref:${fnStableId}:param:args:${argIndex}`;
}

function buildParamValueVersionStableId(fnStableId: string, argIndex: number) {
  return `${buildParamValueRefStableId(fnStableId, argIndex)}:v0`;
}

function buildEnvelopeValueRefStableId(fnStableId: string, argIndex: number) {
  return `value-ref:${fnStableId}:payload:args:${argIndex}`;
}

function buildEnvelopeValueVersionStableId(fnStableId: string, argIndex: number) {
  return `${buildEnvelopeValueRefStableId(fnStableId, argIndex)}:v0`;
}

function buildMethodScopedParamValueRefStableId(fnStableId: string, apiMethodName: string, argIndex: number) {
  return `value-ref:${fnStableId}:api-method:${apiMethodName}:param:args:${argIndex}`;
}

function buildMethodScopedParamValueVersionStableId(fnStableId: string, apiMethodName: string, argIndex: number) {
  return `${buildMethodScopedParamValueRefStableId(fnStableId, apiMethodName, argIndex)}:v0`;
}

function buildMethodScopedEnvelopeValueRefStableId(fnStableId: string, apiMethodName: string, argIndex: number) {
  return `value-ref:${fnStableId}:api-method:${apiMethodName}:payload:args:${argIndex}`;
}

function buildMethodScopedEnvelopeValueVersionStableId(fnStableId: string, apiMethodName: string, argIndex: number) {
  return `${buildMethodScopedEnvelopeValueRefStableId(fnStableId, apiMethodName, argIndex)}:v0`;
}

function buildResolvedMethodParamValueRefStableId(fnStableId: string, argIndex: number) {
  return `value-ref:${fnStableId}:param:${argIndex}`;
}

function buildResolvedMethodParamValueVersionStableId(fnStableId: string, argIndex: number) {
  return `${buildResolvedMethodParamValueRefStableId(fnStableId, argIndex)}:v0`;
}

function buildRequestIdValueRefStableId(fnStableId: string) {
  return `value-ref:${fnStableId}:message-id`;
}

function buildRequestIdValueVersionStableId(fnStableId: string) {
  return `${buildRequestIdValueRefStableId(fnStableId)}:v0`;
}

function buildEnvelopeRequestIdValueRefStableId(fnStableId: string) {
  return `value-ref:${fnStableId}:payload:message-id`;
}

function buildEnvelopeRequestIdValueVersionStableId(fnStableId: string) {
  return `${buildEnvelopeRequestIdValueRefStableId(fnStableId)}:v0`;
}

function buildRequestStateEntrySharedValueRefStableId() {
  return 'value-ref:src/api/gramjs/worker/connector.ts:requestStates:message-id';
}

function buildRequestStateEntryValueVersionStableId(fnStableId: string) {
  return `value-version:${fnStableId}:requestStates:message-id:v0`;
}

function buildResponsePayloadValueRefStableId(fnStableId: string, payloadKind: 'response' | 'error' | 'callbackArgs') {
  return `value-ref:${fnStableId}:payload:${payloadKind}`;
}

function buildResponsePayloadValueVersionStableId(fnStableId: string, payloadKind: 'response' | 'error' | 'callbackArgs') {
  return `${buildResponsePayloadValueRefStableId(fnStableId, payloadKind)}:v0`;
}

function buildRequestCallbackValueRefStableId() {
  return 'value-ref:src/api/gramjs/worker/connector.ts:requestState:callback';
}

function buildRequestCallbackValueVersionStableId(fnStableId: string) {
  return `value-version:${fnStableId}:requestState:callback:v0`;
}

function buildWorkerTransportCallbackValueRefStableId(fnStableId: string) {
  return `value-ref:${fnStableId}:transport:callback`;
}

function buildWorkerTransportCallbackValueVersionStableId(fnStableId: string) {
  return `${buildWorkerTransportCallbackValueRefStableId(fnStableId)}:v0`;
}

function buildMultitabTransportCallbackValueRefStableId(fnStableId: string) {
  return `value-ref:${fnStableId}:multitab:callback`;
}

function buildMultitabTransportCallbackValueVersionStableId(fnStableId: string) {
  return `${buildMultitabTransportCallbackValueRefStableId(fnStableId)}:v0`;
}

function classifyTrackedArgument(expression: ts.Expression) {
  const current = unwrapExpression(expression);

  if (ts.isObjectLiteralExpression(current)) {
    return { argKind: 'object-literal' };
  }

  if (ts.isArrayLiteralExpression(current)) {
    return { argKind: 'array-literal' };
  }

  if (ts.isIdentifier(current)) {
    return { argKind: 'identifier' };
  }

  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    return { argKind: 'member-access' };
  }

  return undefined;
}

function getApiMethodName(callExpression: ts.CallExpression) {
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

function extractCallApiValueFlow(fnStableId?: string): ExtractedPayload {
  const program = createProgram();
  const checker = program.getTypeChecker();
  const stableIdByDeclaration = buildStableIdByDeclaration(program);
  const nodesById = new Map<string, ValueFlowNodeRow>();
  const edgesByKey = new Map<string, ValueFlowEdgeRow>();
  const trackedArgIndexes = new Set<number>();
  const trackedArgIndexesByApiMethod = new Map<string, Set<number>>();
  const uniqueMethodTargetsByName = buildUniqueMethodFunctionTargets(program, stableIdByDeclaration);
  const publicCallApiNode = findNamedFunctionNode(program, PUBLIC_CALL_API_REPO_PATH, 'callApi');
  const workerCallApiNode = findNamedFunctionNode(program, WORKER_CALL_API_REPO_PATH, 'callApi');
  const makeRequestNode = findNamedFunctionNode(program, PUBLIC_CALL_API_REPO_PATH, 'makeRequest');
  const makeRequestToMasterNode = findNamedFunctionNode(program, PUBLIC_CALL_API_REPO_PATH, 'makeRequestToMaster');
  const handleMethodResponseNode = findNamedFunctionNode(program, PUBLIC_CALL_API_REPO_PATH, 'handleMethodResponse');
  const handleMethodCallbackNode = findNamedFunctionNode(program, PUBLIC_CALL_API_REPO_PATH, 'handleMethodCallback');
  const workerRuntimeSourceFile = program.getSourceFiles().find((sourceFile) => getRepoRelativePath(sourceFile.fileName) === WORKER_RUNTIME_REPO_PATH);
  const multitabRuntimeSourceFile = program.getSourceFiles().find((sourceFile) => getRepoRelativePath(sourceFile.fileName) === MULTITAB_RUNTIME_REPO_PATH);
  const publicCallApiFnStableId = publicCallApiNode ? (stableIdByDeclaration.get(publicCallApiNode) || resolveStableIdForDeclaration(publicCallApiNode.getSourceFile(), publicCallApiNode)) : undefined;
  const workerCallApiFnStableId = workerCallApiNode ? (stableIdByDeclaration.get(workerCallApiNode) || resolveStableIdForDeclaration(workerCallApiNode.getSourceFile(), workerCallApiNode)) : undefined;
  const makeRequestFnStableId = makeRequestNode ? (stableIdByDeclaration.get(makeRequestNode) || resolveStableIdForDeclaration(makeRequestNode.getSourceFile(), makeRequestNode)) : undefined;
  const makeRequestToMasterFnStableId = makeRequestToMasterNode ? (stableIdByDeclaration.get(makeRequestToMasterNode) || resolveStableIdForDeclaration(makeRequestToMasterNode.getSourceFile(), makeRequestToMasterNode)) : undefined;
  const handleMethodResponseFnStableId = handleMethodResponseNode ? (stableIdByDeclaration.get(handleMethodResponseNode) || resolveStableIdForDeclaration(handleMethodResponseNode.getSourceFile(), handleMethodResponseNode)) : undefined;
  const handleMethodCallbackFnStableId = handleMethodCallbackNode ? (stableIdByDeclaration.get(handleMethodCallbackNode) || resolveStableIdForDeclaration(handleMethodCallbackNode.getSourceFile(), handleMethodCallbackNode)) : undefined;
  const workerTransportCallbackWriteCalls = workerRuntimeSourceFile
    ? collectMatchingCallExpressionsInSubtree(workerRuntimeSourceFile, (callExpression) => isCallExpressionText(callExpression, ['callbackState.set']))
    : [];
  const workerTransportCallbackReadCalls = workerRuntimeSourceFile
    ? collectMatchingCallExpressionsInSubtree(workerRuntimeSourceFile, (callExpression) => isCallExpressionText(callExpression, ['args.push']))
    : [];
  const workerRuntimeFnStableId = workerTransportCallbackWriteCalls[0]
    ? findParentFunctionStableId(workerTransportCallbackWriteCalls[0], stableIdByDeclaration)
    : workerTransportCallbackReadCalls[0]
      ? findParentFunctionStableId(workerTransportCallbackReadCalls[0], stableIdByDeclaration)
      : undefined;
  const multitabTransportCallbackReadCalls = multitabRuntimeSourceFile
    ? collectMatchingCallExpressionsInSubtree(multitabRuntimeSourceFile, (callExpression) => isCallExpressionText(callExpression, ['callApiLocal']))
    : [];
  const multitabRuntimeFnStableId = multitabTransportCallbackReadCalls[0]
    ? findParentFunctionStableId(multitabTransportCallbackReadCalls[0], stableIdByDeclaration)
    : undefined;

  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile)) {
      continue;
    }

    const repoRelativePath = getRepoRelativePath(sourceFile.fileName);
    if (isExcludedCallSiteSource(repoRelativePath)) {
      continue;
    }

    function visit(node: ts.Node): void {
      if (isFunctionLikeNode(node)) {
        ts.forEachChild(node, visit);
        return;
      }

      if (!ts.isCallExpression(node)) {
        ts.forEachChild(node, visit);
        return;
      }

      const target = resolveCallTarget(checker, stableIdByDeclaration, node);
      if (!isPublicCallApiTarget(target)) {
        ts.forEachChild(node, visit);
        return;
      }

      const parentFnStableId = findParentFunctionStableId(node, stableIdByDeclaration);
      if (!parentFnStableId || (fnStableId && parentFnStableId !== fnStableId)) {
        ts.forEachChild(node, visit);
        return;
      }

      const stepStableIds = buildStepStableIdCandidates(sourceFile, node);
      const callStepStableId = stepStableIds[0];
      const apiMethodName = getApiMethodName(node);

      node.arguments.forEach((argument, index) => {
        if (index === 0) {
          return;
        }

        const tracked = classifyTrackedArgument(argument);
        if (!tracked) {
          return;
        }

        trackedArgIndexes.add(index);
        if (apiMethodName) {
          const methodTrackedIndexes = trackedArgIndexesByApiMethod.get(apiMethodName) || new Set<number>();
          methodTrackedIndexes.add(index);
          trackedArgIndexesByApiMethod.set(apiMethodName, methodTrackedIndexes);
        }

        const valueRefStableId = `value-ref:${callStepStableId}:arg:${index}`;
        const valueVersionStableId = `${valueRefStableId}:v0`;

        nodesById.set(valueRefStableId, {
          stableId: valueRefStableId,
          labels: ['ValueRef'],
          label: `arg:${index}`,
          kind: 'ValueRef',
          parentFnStableId,
          repoRelativePath,
          callStepStableId,
          argIndex: index,
          apiMethodName,
          argTextRaw: argument.getText(sourceFile),
          argKind: tracked.argKind,
        });

        nodesById.set(valueVersionStableId, {
          stableId: valueVersionStableId,
          labels: ['ValueVersion'],
          label: `arg:${index}:v0`,
          kind: 'ValueVersion',
          parentFnStableId,
          repoRelativePath,
          callStepStableId,
          argIndex: index,
          apiMethodName,
          argTextRaw: argument.getText(sourceFile),
          argKind: tracked.argKind,
          valueRefStableId,
        });

        const bindKey = `${callStepStableId}|BINDS_VALUE|${valueVersionStableId}`;
        edgesByKey.set(bindKey, {
          fromKind: 'Step',
          fromId: callStepStableId,
          toKind: 'ValueVersion',
          toId: valueVersionStableId,
          type: 'BINDS_VALUE',
          role: 'call-arg',
          stepStableIds,
          argIndex: index,
          apiMethodName,
        });

        const refKey = `${valueVersionStableId}|OF_REF|${valueRefStableId}`;
        edgesByKey.set(refKey, {
          fromKind: 'ValueVersion',
          fromId: valueVersionStableId,
          toKind: 'ValueRef',
          toId: valueRefStableId,
          type: 'OF_REF',
          role: 'version-of',
          argIndex: index,
          apiMethodName,
        });
      });

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  if (publicCallApiFnStableId && workerCallApiFnStableId && (!fnStableId || [
    publicCallApiFnStableId,
    workerCallApiFnStableId,
    makeRequestFnStableId,
    makeRequestToMasterFnStableId,
    handleMethodResponseFnStableId,
    handleMethodCallbackFnStableId,
  ].includes(fnStableId))) {
    const publicRepoRelativePath = getRepoRelativePath(publicCallApiNode!.getSourceFile().fileName);
    const workerRepoRelativePath = getRepoRelativePath(workerCallApiNode!.getSourceFile().fileName);
    const makeRequestRepoRelativePath = makeRequestNode ? getRepoRelativePath(makeRequestNode.getSourceFile().fileName) : publicRepoRelativePath;
    const makeRequestToMasterRepoRelativePath = makeRequestToMasterNode ? getRepoRelativePath(makeRequestToMasterNode.getSourceFile().fileName) : publicRepoRelativePath;
    const publicForwardSteps = collectMatchingCallExpressions(publicCallApiNode!, (callExpression) => (
      isNamedCallExpression(callExpression, 'makeRequest') || isNamedCallExpression(callExpression, 'makeRequestToMaster')
    )).map((callExpression) => buildStepStableIdCandidates(publicCallApiNode!.getSourceFile(), callExpression));
    const workerForwardSteps = collectMatchingCallExpressions(workerCallApiNode!, isMethodsForwardCallExpression)
      .map((callExpression) => buildStepStableIdCandidates(workerCallApiNode!.getSourceFile(), callExpression));
    const makeRequestPayloadSteps = makeRequestNode
      ? collectRequestEnvelopeBuildSteps(makeRequestNode)
      : [];
    const makeRequestToMasterPayloadSteps = makeRequestToMasterNode
      ? collectRequestEnvelopeBuildSteps(makeRequestToMasterNode)
      : [];
    const makeRequestSendSteps = makeRequestNode
      ? collectMatchingCallExpressions(makeRequestNode, (callExpression) => isNamedCallExpression(callExpression, 'postMessageOnTickEnd'))
        .map((callExpression) => buildStepStableIdCandidates(makeRequestNode.getSourceFile(), callExpression))
      : [];
    const makeRequestToMasterSendSteps = makeRequestToMasterNode
      ? collectMatchingCallExpressions(makeRequestToMasterNode, (callExpression) => isNamedCallExpression(callExpression, 'callApiOnMasterTab'))
        .map((callExpression) => buildStepStableIdCandidates(makeRequestToMasterNode.getSourceFile(), callExpression))
      : [];
    const makeRequestMessageIdBindSteps = makeRequestNode
      ? collectMatchingCallExpressions(makeRequestNode, (callExpression) => isNamedCallExpression(callExpression, 'generateUniqueId'))
        .map((callExpression) => buildStepStableIdCandidates(makeRequestNode.getSourceFile(), callExpression))
      : [];
    const makeRequestToMasterMessageIdBindSteps = makeRequestToMasterNode
      ? collectMatchingCallExpressions(makeRequestToMasterNode, (callExpression) => isNamedCallExpression(callExpression, 'generateUniqueId'))
        .map((callExpression) => buildStepStableIdCandidates(makeRequestToMasterNode.getSourceFile(), callExpression))
      : [];
    const makeRequestStateWriteSteps = makeRequestNode
      ? collectMatchingCallExpressions(makeRequestNode, (callExpression) => isCallExpressionText(callExpression, ['requestStates.set']))
        .map((callExpression) => buildStepStableIdCandidates(makeRequestNode.getSourceFile(), callExpression))
      : [];
    const makeRequestToMasterStateWriteSteps = makeRequestToMasterNode
      ? collectMatchingCallExpressions(makeRequestToMasterNode, (callExpression) => isCallExpressionText(callExpression, ['requestStates.set']))
        .map((callExpression) => buildStepStableIdCandidates(makeRequestToMasterNode.getSourceFile(), callExpression))
      : [];
    const makeRequestCallbackPopSteps = makeRequestNode
      ? collectMatchingCallExpressions(makeRequestNode, (callExpression) => isCallExpressionText(callExpression, ['payload.args.pop']))
        .map((callExpression) => buildStepStableIdCandidates(makeRequestNode.getSourceFile(), callExpression))
      : [];
    const makeRequestToMasterCallbackPopSteps = makeRequestToMasterNode
      ? collectMatchingCallExpressions(makeRequestToMasterNode, (callExpression) => isCallExpressionText(callExpression, ['payload.args.pop']))
        .map((callExpression) => buildStepStableIdCandidates(makeRequestToMasterNode.getSourceFile(), callExpression))
      : [];
    const makeRequestCallbackStoreSteps = makeRequestNode
      ? collectMatchingCallExpressions(makeRequestNode, (callExpression) => isCallExpressionText(callExpression, ['requestStatesByCallback.set']))
        .map((callExpression) => buildStepStableIdCandidates(makeRequestNode.getSourceFile(), callExpression))
      : [];
    const makeRequestToMasterCallbackStoreSteps = makeRequestToMasterNode
      ? collectMatchingCallExpressions(makeRequestToMasterNode, (callExpression) => isCallExpressionText(callExpression, ['requestStatesByCallback.set']))
        .map((callExpression) => buildStepStableIdCandidates(makeRequestToMasterNode.getSourceFile(), callExpression))
      : [];
    const handleMethodResponseLookupSteps = handleMethodResponseNode
      ? collectMatchingCallExpressions(handleMethodResponseNode, (callExpression) => isCallExpressionText(callExpression, ['requestStates.get']))
        .map((callExpression) => buildStepStableIdCandidates(handleMethodResponseNode.getSourceFile(), callExpression))
      : [];
    const handleMethodResponseDeliverySteps = handleMethodResponseNode
      ? collectMatchingCallExpressions(handleMethodResponseNode, (callExpression) => isCallExpressionText(callExpression, ['requestState.resolve', 'requestState.reject']))
        .map((callExpression) => buildStepStableIdCandidates(handleMethodResponseNode.getSourceFile(), callExpression))
      : [];
    const handleMethodCallbackReadSteps = handleMethodCallbackNode
      ? collectMatchingCallExpressions(handleMethodCallbackNode, (callExpression) => isCallExpressionText(callExpression, ['requestStates.get', 'requestStates.get(data.messageId)?.callback']))
        .map((callExpression) => buildStepStableIdCandidates(handleMethodCallbackNode.getSourceFile(), callExpression))
      : [];
    const handleMethodResponseDataResponseSteps = handleMethodResponseNode
      ? collectMatchingExpressions(handleMethodResponseNode, (expression) => expression.getText() === 'data.response')
        .map((expression) => buildStepStableIdCandidates(handleMethodResponseNode.getSourceFile(), expression))
      : [];
    const handleMethodResponseDataErrorSteps = handleMethodResponseNode
      ? collectMatchingExpressions(handleMethodResponseNode, (expression) => expression.getText() === 'data.error')
        .map((expression) => buildStepStableIdCandidates(handleMethodResponseNode.getSourceFile(), expression))
      : [];
    const handleMethodCallbackArgsSteps = handleMethodCallbackNode
      ? collectMatchingExpressions(handleMethodCallbackNode, (expression) => expression.getText() === 'data.callbackArgs')
        .map((expression) => buildStepStableIdCandidates(handleMethodCallbackNode.getSourceFile(), expression))
      : [];
    const handleMethodCallbackStoredCallbackSteps = handleMethodCallbackNode
      ? collectMatchingExpressions(handleMethodCallbackNode, (expression) => expression.getText() === 'requestStates.get(data.messageId)?.callback')
        .map((expression) => buildStepStableIdCandidates(handleMethodCallbackNode.getSourceFile(), expression))
      : [];
    const workerRuntimeRepoRelativePath = workerRuntimeSourceFile ? getRepoRelativePath(workerRuntimeSourceFile.fileName) : undefined;
    const multitabRuntimeRepoRelativePath = multitabRuntimeSourceFile ? getRepoRelativePath(multitabRuntimeSourceFile.fileName) : undefined;
    const workerTransportCallbackWriteSteps = workerRuntimeSourceFile
      ? workerTransportCallbackWriteCalls.map((callExpression) => buildStepStableIdCandidates(workerRuntimeSourceFile, callExpression))
      : [];
    const workerTransportCallbackReadSteps = workerRuntimeSourceFile
      ? workerTransportCallbackReadCalls.map((callExpression) => buildStepStableIdCandidates(workerRuntimeSourceFile, callExpression))
      : [];
    const multitabTransportCallbackReadSteps = multitabRuntimeSourceFile
      ? multitabTransportCallbackReadCalls.map((callExpression) => buildStepStableIdCandidates(multitabRuntimeSourceFile, callExpression))
      : [];

    for (const argIndex of trackedArgIndexes) {
      const publicValueRefStableId = buildParamValueRefStableId(publicCallApiFnStableId, argIndex);
      const publicValueVersionStableId = buildParamValueVersionStableId(publicCallApiFnStableId, argIndex);
      const workerValueRefStableId = buildParamValueRefStableId(workerCallApiFnStableId, argIndex);
      const workerValueVersionStableId = buildParamValueVersionStableId(workerCallApiFnStableId, argIndex);
      const makeRequestEnvelopeValueRefStableId = makeRequestFnStableId ? buildEnvelopeValueRefStableId(makeRequestFnStableId, argIndex) : undefined;
      const makeRequestEnvelopeValueVersionStableId = makeRequestFnStableId ? buildEnvelopeValueVersionStableId(makeRequestFnStableId, argIndex) : undefined;
      const makeRequestToMasterEnvelopeValueRefStableId = makeRequestToMasterFnStableId ? buildEnvelopeValueRefStableId(makeRequestToMasterFnStableId, argIndex) : undefined;
      const makeRequestToMasterEnvelopeValueVersionStableId = makeRequestToMasterFnStableId ? buildEnvelopeValueVersionStableId(makeRequestToMasterFnStableId, argIndex) : undefined;

      nodesById.set(publicValueRefStableId, {
        stableId: publicValueRefStableId,
        labels: ['ValueRef'],
        label: `param:args:${argIndex}`,
        kind: 'ValueRef',
        parentFnStableId: publicCallApiFnStableId,
        repoRelativePath: publicRepoRelativePath,
        callStepStableId: publicCallApiFnStableId,
        argIndex,
        argTextRaw: 'args',
        argKind: 'rest-parameter-slot',
      });

      nodesById.set(publicValueVersionStableId, {
        stableId: publicValueVersionStableId,
        labels: ['ValueVersion'],
        label: `param:args:${argIndex}:v0`,
        kind: 'ValueVersion',
        parentFnStableId: publicCallApiFnStableId,
        repoRelativePath: publicRepoRelativePath,
        callStepStableId: publicCallApiFnStableId,
        argIndex,
        argTextRaw: 'args',
        argKind: 'rest-parameter-slot',
        valueRefStableId: publicValueRefStableId,
      });

      nodesById.set(workerValueRefStableId, {
        stableId: workerValueRefStableId,
        labels: ['ValueRef'],
        label: `param:args:${argIndex}`,
        kind: 'ValueRef',
        parentFnStableId: workerCallApiFnStableId,
        repoRelativePath: workerRepoRelativePath,
        callStepStableId: workerCallApiFnStableId,
        argIndex,
        argTextRaw: 'args',
        argKind: 'rest-parameter-slot',
      });

      nodesById.set(workerValueVersionStableId, {
        stableId: workerValueVersionStableId,
        labels: ['ValueVersion'],
        label: `param:args:${argIndex}:v0`,
        kind: 'ValueVersion',
        parentFnStableId: workerCallApiFnStableId,
        repoRelativePath: workerRepoRelativePath,
        callStepStableId: workerCallApiFnStableId,
        argIndex,
        argTextRaw: 'args',
        argKind: 'rest-parameter-slot',
        valueRefStableId: workerValueRefStableId,
      });

      if (makeRequestEnvelopeValueRefStableId && makeRequestEnvelopeValueVersionStableId && makeRequestFnStableId) {
        nodesById.set(makeRequestEnvelopeValueRefStableId, {
          stableId: makeRequestEnvelopeValueRefStableId,
          labels: ['ValueRef'],
          label: `payload:args:${argIndex}`,
          kind: 'ValueRef',
          parentFnStableId: makeRequestFnStableId,
          repoRelativePath: makeRequestRepoRelativePath,
          callStepStableId: makeRequestFnStableId,
          argIndex,
          argTextRaw: 'payload.args',
          argKind: 'request-envelope-slot',
        });

        nodesById.set(makeRequestEnvelopeValueVersionStableId, {
          stableId: makeRequestEnvelopeValueVersionStableId,
          labels: ['ValueVersion'],
          label: `payload:args:${argIndex}:v0`,
          kind: 'ValueVersion',
          parentFnStableId: makeRequestFnStableId,
          repoRelativePath: makeRequestRepoRelativePath,
          callStepStableId: makeRequestFnStableId,
          argIndex,
          argTextRaw: 'payload.args',
          argKind: 'request-envelope-slot',
          valueRefStableId: makeRequestEnvelopeValueRefStableId,
        });

        edgesByKey.set(`${makeRequestEnvelopeValueVersionStableId}|OF_REF|${makeRequestEnvelopeValueRefStableId}`, {
          fromKind: 'ValueVersion',
          fromId: makeRequestEnvelopeValueVersionStableId,
          toKind: 'ValueRef',
          toId: makeRequestEnvelopeValueRefStableId,
          type: 'OF_REF',
          role: 'version-of',
          argIndex,
        });
      }

      if (makeRequestToMasterEnvelopeValueRefStableId && makeRequestToMasterEnvelopeValueVersionStableId && makeRequestToMasterFnStableId) {
        nodesById.set(makeRequestToMasterEnvelopeValueRefStableId, {
          stableId: makeRequestToMasterEnvelopeValueRefStableId,
          labels: ['ValueRef'],
          label: `payload:args:${argIndex}`,
          kind: 'ValueRef',
          parentFnStableId: makeRequestToMasterFnStableId,
          repoRelativePath: makeRequestToMasterRepoRelativePath,
          callStepStableId: makeRequestToMasterFnStableId,
          argIndex,
          argTextRaw: 'payload.args',
          argKind: 'request-envelope-slot',
        });

        nodesById.set(makeRequestToMasterEnvelopeValueVersionStableId, {
          stableId: makeRequestToMasterEnvelopeValueVersionStableId,
          labels: ['ValueVersion'],
          label: `payload:args:${argIndex}:v0`,
          kind: 'ValueVersion',
          parentFnStableId: makeRequestToMasterFnStableId,
          repoRelativePath: makeRequestToMasterRepoRelativePath,
          callStepStableId: makeRequestToMasterFnStableId,
          argIndex,
          argTextRaw: 'payload.args',
          argKind: 'request-envelope-slot',
          valueRefStableId: makeRequestToMasterEnvelopeValueRefStableId,
        });

        edgesByKey.set(`${makeRequestToMasterEnvelopeValueVersionStableId}|OF_REF|${makeRequestToMasterEnvelopeValueRefStableId}`, {
          fromKind: 'ValueVersion',
          fromId: makeRequestToMasterEnvelopeValueVersionStableId,
          toKind: 'ValueRef',
          toId: makeRequestToMasterEnvelopeValueRefStableId,
          type: 'OF_REF',
          role: 'version-of',
          argIndex,
        });
      }

      edgesByKey.set(`${publicValueVersionStableId}|OF_REF|${publicValueRefStableId}`, {
        fromKind: 'ValueVersion',
        fromId: publicValueVersionStableId,
        toKind: 'ValueRef',
        toId: publicValueRefStableId,
        type: 'OF_REF',
        role: 'version-of',
        argIndex,
      });

      edgesByKey.set(`${workerValueVersionStableId}|OF_REF|${workerValueRefStableId}`, {
        fromKind: 'ValueVersion',
        fromId: workerValueVersionStableId,
        toKind: 'ValueRef',
        toId: workerValueRefStableId,
        type: 'OF_REF',
        role: 'version-of',
        argIndex,
      });

      for (const [edgeKey, edge] of edgesByKey) {
        if (edge.type !== 'BINDS_VALUE' || edge.argIndex !== argIndex) {
          continue;
        }

        edgesByKey.set(`${edge.toId}|FORWARDS_VALUE|${publicValueVersionStableId}`, {
          fromKind: 'ValueVersion',
          fromId: edge.toId,
          toKind: 'ValueVersion',
          toId: publicValueVersionStableId,
          type: 'FORWARDS_VALUE',
          role: 'public-call-api-param',
          argIndex,
          apiMethodName: edge.apiMethodName,
        });
      }

      edgesByKey.set(`${publicValueVersionStableId}|FORWARDS_VALUE|${workerValueVersionStableId}`, {
        fromKind: 'ValueVersion',
        fromId: publicValueVersionStableId,
        toKind: 'ValueVersion',
        toId: workerValueVersionStableId,
        type: 'FORWARDS_VALUE',
        role: 'worker-call-api-param',
        argIndex,
      });

      if (makeRequestEnvelopeValueVersionStableId) {
        edgesByKey.set(`${publicValueVersionStableId}|FORWARDS_VALUE|${makeRequestEnvelopeValueVersionStableId}`, {
          fromKind: 'ValueVersion',
          fromId: publicValueVersionStableId,
          toKind: 'ValueVersion',
          toId: makeRequestEnvelopeValueVersionStableId,
          type: 'FORWARDS_VALUE',
          role: 'worker-request-envelope-param',
          argIndex,
        });
      }

      if (makeRequestToMasterEnvelopeValueVersionStableId) {
        edgesByKey.set(`${publicValueVersionStableId}|FORWARDS_VALUE|${makeRequestToMasterEnvelopeValueVersionStableId}`, {
          fromKind: 'ValueVersion',
          fromId: publicValueVersionStableId,
          toKind: 'ValueVersion',
          toId: makeRequestToMasterEnvelopeValueVersionStableId,
          type: 'FORWARDS_VALUE',
          role: 'master-request-envelope-param',
          argIndex,
        });
      }

      for (const stepStableIds of publicForwardSteps) {
        const stepId = stepStableIds[0];
        edgesByKey.set(`${stepId}|READS_VALUE|${publicValueVersionStableId}`, {
          fromKind: 'Step',
          fromId: stepId,
          toKind: 'ValueVersion',
          toId: publicValueVersionStableId,
          type: 'READS_VALUE',
          role: 'forward-read',
          stepStableIds,
          argIndex,
        });
      }

      for (const stepStableIds of workerForwardSteps) {
        const stepId = stepStableIds[0];
        edgesByKey.set(`${stepId}|READS_VALUE|${workerValueVersionStableId}`, {
          fromKind: 'Step',
          fromId: stepId,
          toKind: 'ValueVersion',
          toId: workerValueVersionStableId,
          type: 'READS_VALUE',
          role: 'forward-read',
          stepStableIds,
          argIndex,
        });
      }

      if (makeRequestEnvelopeValueVersionStableId) {
        for (const stepStableIds of makeRequestPayloadSteps) {
          const stepId = stepStableIds[0];
          edgesByKey.set(`${stepId}|READS_VALUE|${makeRequestEnvelopeValueVersionStableId}`, {
            fromKind: 'Step',
            fromId: stepId,
            toKind: 'ValueVersion',
            toId: makeRequestEnvelopeValueVersionStableId,
            type: 'READS_VALUE',
            role: 'request-envelope-read',
            stepStableIds,
            argIndex,
          });
        }

        for (const stepStableIds of makeRequestSendSteps) {
          const stepId = stepStableIds[0];
          edgesByKey.set(`${stepId}|READS_VALUE|${makeRequestEnvelopeValueVersionStableId}`, {
            fromKind: 'Step',
            fromId: stepId,
            toKind: 'ValueVersion',
            toId: makeRequestEnvelopeValueVersionStableId,
            type: 'READS_VALUE',
            role: 'request-envelope-read',
            stepStableIds,
            argIndex,
          });
        }
      }

      if (makeRequestToMasterEnvelopeValueVersionStableId) {
        for (const stepStableIds of makeRequestToMasterPayloadSteps) {
          const stepId = stepStableIds[0];
          edgesByKey.set(`${stepId}|READS_VALUE|${makeRequestToMasterEnvelopeValueVersionStableId}`, {
            fromKind: 'Step',
            fromId: stepId,
            toKind: 'ValueVersion',
            toId: makeRequestToMasterEnvelopeValueVersionStableId,
            type: 'READS_VALUE',
            role: 'request-envelope-read',
            stepStableIds,
            argIndex,
          });
        }

        for (const stepStableIds of makeRequestToMasterSendSteps) {
          const stepId = stepStableIds[0];
          edgesByKey.set(`${stepId}|READS_VALUE|${makeRequestToMasterEnvelopeValueVersionStableId}`, {
            fromKind: 'Step',
            fromId: stepId,
            toKind: 'ValueVersion',
            toId: makeRequestToMasterEnvelopeValueVersionStableId,
            type: 'READS_VALUE',
            role: 'request-envelope-read',
            stepStableIds,
            argIndex,
          });
        }
      }
    }

    const requestIdTargets = [
      {
        fnStableId: makeRequestFnStableId,
        repoRelativePath: makeRequestRepoRelativePath,
        bindSteps: makeRequestMessageIdBindSteps,
        payloadSteps: makeRequestPayloadSteps,
        sendSteps: makeRequestSendSteps,
      },
      {
        fnStableId: makeRequestToMasterFnStableId,
        repoRelativePath: makeRequestToMasterRepoRelativePath,
        bindSteps: makeRequestToMasterMessageIdBindSteps,
        payloadSteps: makeRequestToMasterPayloadSteps,
        sendSteps: makeRequestToMasterSendSteps,
      },
    ].filter((target): target is {
      fnStableId: string;
      repoRelativePath: string;
      bindSteps: string[][];
      payloadSteps: string[][];
      sendSteps: string[][];
    } => Boolean(target.fnStableId));

    for (const target of requestIdTargets) {
      const requestIdValueRefStableId = buildRequestIdValueRefStableId(target.fnStableId);
      const requestIdValueVersionStableId = buildRequestIdValueVersionStableId(target.fnStableId);
      const envelopeRequestIdValueRefStableId = buildEnvelopeRequestIdValueRefStableId(target.fnStableId);
      const envelopeRequestIdValueVersionStableId = buildEnvelopeRequestIdValueVersionStableId(target.fnStableId);

      nodesById.set(requestIdValueRefStableId, {
        stableId: requestIdValueRefStableId,
        labels: ['ValueRef'],
        label: 'messageId',
        kind: 'ValueRef',
        parentFnStableId: target.fnStableId,
        repoRelativePath: target.repoRelativePath,
        callStepStableId: target.fnStableId,
        argIndex: 0,
        argTextRaw: 'messageId',
        argKind: 'request-id-slot',
      });

      nodesById.set(requestIdValueVersionStableId, {
        stableId: requestIdValueVersionStableId,
        labels: ['ValueVersion'],
        label: 'messageId:v0',
        kind: 'ValueVersion',
        parentFnStableId: target.fnStableId,
        repoRelativePath: target.repoRelativePath,
        callStepStableId: target.fnStableId,
        argIndex: 0,
        argTextRaw: 'messageId',
        argKind: 'request-id-slot',
        valueRefStableId: requestIdValueRefStableId,
      });

      nodesById.set(envelopeRequestIdValueRefStableId, {
        stableId: envelopeRequestIdValueRefStableId,
        labels: ['ValueRef'],
        label: 'payload:messageId',
        kind: 'ValueRef',
        parentFnStableId: target.fnStableId,
        repoRelativePath: target.repoRelativePath,
        callStepStableId: target.fnStableId,
        argIndex: 0,
        argTextRaw: 'payload.messageId',
        argKind: 'request-envelope-id-slot',
      });

      nodesById.set(envelopeRequestIdValueVersionStableId, {
        stableId: envelopeRequestIdValueVersionStableId,
        labels: ['ValueVersion'],
        label: 'payload:messageId:v0',
        kind: 'ValueVersion',
        parentFnStableId: target.fnStableId,
        repoRelativePath: target.repoRelativePath,
        callStepStableId: target.fnStableId,
        argIndex: 0,
        argTextRaw: 'payload.messageId',
        argKind: 'request-envelope-id-slot',
        valueRefStableId: envelopeRequestIdValueRefStableId,
      });

      edgesByKey.set(`${requestIdValueVersionStableId}|OF_REF|${requestIdValueRefStableId}`, {
        fromKind: 'ValueVersion',
        fromId: requestIdValueVersionStableId,
        toKind: 'ValueRef',
        toId: requestIdValueRefStableId,
        type: 'OF_REF',
        role: 'version-of',
        argIndex: 0,
      });

      edgesByKey.set(`${envelopeRequestIdValueVersionStableId}|OF_REF|${envelopeRequestIdValueRefStableId}`, {
        fromKind: 'ValueVersion',
        fromId: envelopeRequestIdValueVersionStableId,
        toKind: 'ValueRef',
        toId: envelopeRequestIdValueRefStableId,
        type: 'OF_REF',
        role: 'version-of',
        argIndex: 0,
      });

      edgesByKey.set(`${requestIdValueVersionStableId}|FORWARDS_VALUE|${envelopeRequestIdValueVersionStableId}`, {
        fromKind: 'ValueVersion',
        fromId: requestIdValueVersionStableId,
        toKind: 'ValueVersion',
        toId: envelopeRequestIdValueVersionStableId,
        type: 'FORWARDS_VALUE',
        role: 'request-id-envelope-slot',
        argIndex: 0,
      });

      for (const stepStableIds of target.bindSteps) {
        const stepId = stepStableIds[0];
        edgesByKey.set(`${stepId}|BINDS_VALUE|${requestIdValueVersionStableId}`, {
          fromKind: 'Step',
          fromId: stepId,
          toKind: 'ValueVersion',
          toId: requestIdValueVersionStableId,
          type: 'BINDS_VALUE',
          role: 'request-id-bind',
          stepStableIds,
          argIndex: 0,
        });
      }

      for (const stepStableIds of [...target.payloadSteps, ...target.sendSteps]) {
        const stepId = stepStableIds[0];
        edgesByKey.set(`${stepId}|READS_VALUE|${envelopeRequestIdValueVersionStableId}`, {
          fromKind: 'Step',
          fromId: stepId,
          toKind: 'ValueVersion',
          toId: envelopeRequestIdValueVersionStableId,
          type: 'READS_VALUE',
          role: 'request-id-read',
          stepStableIds,
          argIndex: 0,
        });
      }
    }

    if (makeRequestFnStableId || makeRequestToMasterFnStableId || handleMethodResponseFnStableId || handleMethodCallbackFnStableId) {
      const sharedRequestStateEntryValueRefStableId = buildRequestStateEntrySharedValueRefStableId();

      nodesById.set(sharedRequestStateEntryValueRefStableId, {
        stableId: sharedRequestStateEntryValueRefStableId,
        labels: ['ValueRef'],
        label: 'requestStates[messageId]',
        kind: 'ValueRef',
        parentFnStableId: makeRequestFnStableId || makeRequestToMasterFnStableId || handleMethodResponseFnStableId || handleMethodCallbackFnStableId!,
        repoRelativePath: PUBLIC_CALL_API_REPO_PATH,
        callStepStableId: makeRequestFnStableId || makeRequestToMasterFnStableId || handleMethodResponseFnStableId || handleMethodCallbackFnStableId!,
        argIndex: 0,
        argTextRaw: 'requestStates[messageId]',
        argKind: 'request-state-entry-slot',
      });

      const requestStateTargets = [
        {
          fnStableId: makeRequestFnStableId,
          repoRelativePath: makeRequestRepoRelativePath,
          requestIdValueVersionStableId: makeRequestFnStableId ? buildRequestIdValueVersionStableId(makeRequestFnStableId) : undefined,
          stepWrites: makeRequestStateWriteSteps,
          stepReads: [] as string[][],
        },
        {
          fnStableId: makeRequestToMasterFnStableId,
          repoRelativePath: makeRequestToMasterRepoRelativePath,
          requestIdValueVersionStableId: makeRequestToMasterFnStableId ? buildRequestIdValueVersionStableId(makeRequestToMasterFnStableId) : undefined,
          stepWrites: makeRequestToMasterStateWriteSteps,
          stepReads: [] as string[][],
        },
        {
          fnStableId: handleMethodResponseFnStableId,
          repoRelativePath: publicRepoRelativePath,
          requestIdValueVersionStableId: undefined,
          stepWrites: [] as string[][],
          stepReads: [...handleMethodResponseLookupSteps, ...handleMethodResponseDeliverySteps],
        },
        {
          fnStableId: handleMethodCallbackFnStableId,
          repoRelativePath: publicRepoRelativePath,
          requestIdValueVersionStableId: undefined,
          stepWrites: [] as string[][],
          stepReads: handleMethodCallbackReadSteps,
        },
      ].filter((target): target is {
        fnStableId: string;
        repoRelativePath: string;
        requestIdValueVersionStableId: string | undefined;
        stepWrites: string[][];
        stepReads: string[][];
      } => Boolean(target.fnStableId));

      for (const target of requestStateTargets) {
        const requestStateEntryValueVersionStableId = buildRequestStateEntryValueVersionStableId(target.fnStableId);

        nodesById.set(requestStateEntryValueVersionStableId, {
          stableId: requestStateEntryValueVersionStableId,
          labels: ['ValueVersion'],
          label: 'requestStates[messageId]:v0',
          kind: 'ValueVersion',
          parentFnStableId: target.fnStableId,
          repoRelativePath: target.repoRelativePath,
          callStepStableId: target.fnStableId,
          argIndex: 0,
          argTextRaw: 'requestStates[messageId]',
          argKind: 'request-state-entry-slot',
          valueRefStableId: sharedRequestStateEntryValueRefStableId,
        });

        edgesByKey.set(`${requestStateEntryValueVersionStableId}|OF_REF|${sharedRequestStateEntryValueRefStableId}`, {
          fromKind: 'ValueVersion',
          fromId: requestStateEntryValueVersionStableId,
          toKind: 'ValueRef',
          toId: sharedRequestStateEntryValueRefStableId,
          type: 'OF_REF',
          role: 'version-of',
          argIndex: 0,
        });

        if (target.requestIdValueVersionStableId) {
          edgesByKey.set(`${target.requestIdValueVersionStableId}|FORWARDS_VALUE|${requestStateEntryValueVersionStableId}`, {
            fromKind: 'ValueVersion',
            fromId: target.requestIdValueVersionStableId,
            toKind: 'ValueVersion',
            toId: requestStateEntryValueVersionStableId,
            type: 'FORWARDS_VALUE',
            role: 'request-state-entry',
            argIndex: 0,
          });
        }

        for (const stepStableIds of target.stepWrites) {
          const stepId = stepStableIds[0];
          edgesByKey.set(`${stepId}|WRITES_VALUE|${requestStateEntryValueVersionStableId}`, {
            fromKind: 'Step',
            fromId: stepId,
            toKind: 'ValueVersion',
            toId: requestStateEntryValueVersionStableId,
            type: 'WRITES_VALUE',
            role: 'request-state-write',
            stepStableIds,
            argIndex: 0,
          });
        }

        for (const stepStableIds of target.stepReads) {
          const stepId = stepStableIds[0];
          edgesByKey.set(`${stepId}|READS_VALUE|${requestStateEntryValueVersionStableId}`, {
            fromKind: 'Step',
            fromId: stepId,
            toKind: 'ValueVersion',
            toId: requestStateEntryValueVersionStableId,
            type: 'READS_VALUE',
            role: 'request-state-read',
            stepStableIds,
            argIndex: 0,
          });
        }
      }

      if (trackedArgIndexes.has(2) && (makeRequestFnStableId || makeRequestToMasterFnStableId || handleMethodCallbackFnStableId)) {
        const sharedRequestCallbackValueRefStableId = buildRequestCallbackValueRefStableId();

        nodesById.set(sharedRequestCallbackValueRefStableId, {
          stableId: sharedRequestCallbackValueRefStableId,
          labels: ['ValueRef'],
          label: 'requestState.callback',
          kind: 'ValueRef',
          parentFnStableId: makeRequestFnStableId || makeRequestToMasterFnStableId || handleMethodCallbackFnStableId!,
          repoRelativePath: publicRepoRelativePath,
          callStepStableId: makeRequestFnStableId || makeRequestToMasterFnStableId || handleMethodCallbackFnStableId!,
          argIndex: 2,
          argTextRaw: 'requestState.callback',
          argKind: 'request-callback-slot',
        });

        const callbackTargets = [
          {
            fnStableId: makeRequestFnStableId,
            repoRelativePath: makeRequestRepoRelativePath,
            sourceValueVersionStableId: makeRequestFnStableId ? buildEnvelopeValueVersionStableId(makeRequestFnStableId, 2) : undefined,
            stepWrites: makeRequestCallbackStoreSteps,
            stepReads: makeRequestCallbackPopSteps,
          },
          {
            fnStableId: makeRequestToMasterFnStableId,
            repoRelativePath: makeRequestToMasterRepoRelativePath,
            sourceValueVersionStableId: makeRequestToMasterFnStableId ? buildEnvelopeValueVersionStableId(makeRequestToMasterFnStableId, 2) : undefined,
            stepWrites: makeRequestToMasterCallbackStoreSteps,
            stepReads: makeRequestToMasterCallbackPopSteps,
          },
          {
            fnStableId: handleMethodCallbackFnStableId,
            repoRelativePath: publicRepoRelativePath,
            sourceValueVersionStableId: undefined,
            stepWrites: [] as string[][],
            stepReads: handleMethodCallbackStoredCallbackSteps,
          },
        ].filter((target): target is {
          fnStableId: string;
          repoRelativePath: string;
          sourceValueVersionStableId: string | undefined;
          stepWrites: string[][];
          stepReads: string[][];
        } => Boolean(target.fnStableId));

        const callbackVersionIds = new Set<string>();

        for (const target of callbackTargets) {
          const requestCallbackValueVersionStableId = buildRequestCallbackValueVersionStableId(target.fnStableId);
          callbackVersionIds.add(requestCallbackValueVersionStableId);

          nodesById.set(requestCallbackValueVersionStableId, {
            stableId: requestCallbackValueVersionStableId,
            labels: ['ValueVersion'],
            label: 'requestState.callback:v0',
            kind: 'ValueVersion',
            parentFnStableId: target.fnStableId,
            repoRelativePath: target.repoRelativePath,
            callStepStableId: target.fnStableId,
            argIndex: 2,
            argTextRaw: 'requestState.callback',
            argKind: 'request-callback-slot',
            valueRefStableId: sharedRequestCallbackValueRefStableId,
          });

          edgesByKey.set(`${requestCallbackValueVersionStableId}|OF_REF|${sharedRequestCallbackValueRefStableId}`, {
            fromKind: 'ValueVersion',
            fromId: requestCallbackValueVersionStableId,
            toKind: 'ValueRef',
            toId: sharedRequestCallbackValueRefStableId,
            type: 'OF_REF',
            role: 'version-of',
            argIndex: 2,
          });

          if (target.sourceValueVersionStableId) {
            edgesByKey.set(`${target.sourceValueVersionStableId}|FORWARDS_VALUE|${requestCallbackValueVersionStableId}`, {
              fromKind: 'ValueVersion',
              fromId: target.sourceValueVersionStableId,
              toKind: 'ValueVersion',
              toId: requestCallbackValueVersionStableId,
              type: 'FORWARDS_VALUE',
              role: 'request-callback-store',
              argIndex: 2,
            });
          }

          for (const stepStableIds of target.stepWrites) {
            const stepId = stepStableIds[0];
            edgesByKey.set(`${stepId}|WRITES_VALUE|${requestCallbackValueVersionStableId}`, {
              fromKind: 'Step',
              fromId: stepId,
              toKind: 'ValueVersion',
              toId: requestCallbackValueVersionStableId,
              type: 'WRITES_VALUE',
              role: 'request-callback-write',
              stepStableIds,
              argIndex: 2,
            });
          }

          for (const stepStableIds of target.stepReads) {
            const stepId = stepStableIds[0];
            edgesByKey.set(`${stepId}|READS_VALUE|${requestCallbackValueVersionStableId}`, {
              fromKind: 'Step',
              fromId: stepId,
              toKind: 'ValueVersion',
              toId: requestCallbackValueVersionStableId,
              type: 'READS_VALUE',
              role: 'request-callback-read',
              stepStableIds,
              argIndex: 2,
            });
          }
        }

        if (handleMethodCallbackFnStableId) {
          const handleMethodCallbackStoredCallbackValueVersionStableId = buildRequestCallbackValueVersionStableId(handleMethodCallbackFnStableId);

          for (const sourceFnStableId of [makeRequestFnStableId, makeRequestToMasterFnStableId]) {
            if (!sourceFnStableId) {
              continue;
            }

            const sourceRequestCallbackValueVersionStableId = buildRequestCallbackValueVersionStableId(sourceFnStableId);
            if (!callbackVersionIds.has(sourceRequestCallbackValueVersionStableId)) {
              continue;
            }

            edgesByKey.set(`${sourceRequestCallbackValueVersionStableId}|FORWARDS_VALUE|${handleMethodCallbackStoredCallbackValueVersionStableId}`, {
              fromKind: 'ValueVersion',
              fromId: sourceRequestCallbackValueVersionStableId,
              toKind: 'ValueVersion',
              toId: handleMethodCallbackStoredCallbackValueVersionStableId,
              type: 'FORWARDS_VALUE',
              role: 'request-callback-entry',
              argIndex: 2,
            });
          }
        }
      }

      if (handleMethodResponseFnStableId) {
        const responsePayloadValueRefStableId = buildResponsePayloadValueRefStableId(handleMethodResponseFnStableId, 'response');
        const responsePayloadValueVersionStableId = buildResponsePayloadValueVersionStableId(handleMethodResponseFnStableId, 'response');
        const errorPayloadValueRefStableId = buildResponsePayloadValueRefStableId(handleMethodResponseFnStableId, 'error');
        const errorPayloadValueVersionStableId = buildResponsePayloadValueVersionStableId(handleMethodResponseFnStableId, 'error');
        const responseRequestStateEntryValueVersionStableId = buildRequestStateEntryValueVersionStableId(handleMethodResponseFnStableId);

        nodesById.set(responsePayloadValueRefStableId, {
          stableId: responsePayloadValueRefStableId,
          labels: ['ValueRef'],
          label: 'data.response',
          kind: 'ValueRef',
          parentFnStableId: handleMethodResponseFnStableId,
          repoRelativePath: publicRepoRelativePath,
          callStepStableId: handleMethodResponseFnStableId,
          argIndex: 0,
          argTextRaw: 'data.response',
          argKind: 'response-payload-slot',
        });
        nodesById.set(responsePayloadValueVersionStableId, {
          stableId: responsePayloadValueVersionStableId,
          labels: ['ValueVersion'],
          label: 'data.response:v0',
          kind: 'ValueVersion',
          parentFnStableId: handleMethodResponseFnStableId,
          repoRelativePath: publicRepoRelativePath,
          callStepStableId: handleMethodResponseFnStableId,
          argIndex: 0,
          argTextRaw: 'data.response',
          argKind: 'response-payload-slot',
          valueRefStableId: responsePayloadValueRefStableId,
        });
        nodesById.set(errorPayloadValueRefStableId, {
          stableId: errorPayloadValueRefStableId,
          labels: ['ValueRef'],
          label: 'data.error',
          kind: 'ValueRef',
          parentFnStableId: handleMethodResponseFnStableId,
          repoRelativePath: publicRepoRelativePath,
          callStepStableId: handleMethodResponseFnStableId,
          argIndex: 0,
          argTextRaw: 'data.error',
          argKind: 'error-payload-slot',
        });
        nodesById.set(errorPayloadValueVersionStableId, {
          stableId: errorPayloadValueVersionStableId,
          labels: ['ValueVersion'],
          label: 'data.error:v0',
          kind: 'ValueVersion',
          parentFnStableId: handleMethodResponseFnStableId,
          repoRelativePath: publicRepoRelativePath,
          callStepStableId: handleMethodResponseFnStableId,
          argIndex: 0,
          argTextRaw: 'data.error',
          argKind: 'error-payload-slot',
          valueRefStableId: errorPayloadValueRefStableId,
        });

        edgesByKey.set(`${responsePayloadValueVersionStableId}|OF_REF|${responsePayloadValueRefStableId}`, {
          fromKind: 'ValueVersion',
          fromId: responsePayloadValueVersionStableId,
          toKind: 'ValueRef',
          toId: responsePayloadValueRefStableId,
          type: 'OF_REF',
          role: 'version-of',
          argIndex: 0,
        });
        edgesByKey.set(`${errorPayloadValueVersionStableId}|OF_REF|${errorPayloadValueRefStableId}`, {
          fromKind: 'ValueVersion',
          fromId: errorPayloadValueVersionStableId,
          toKind: 'ValueRef',
          toId: errorPayloadValueRefStableId,
          type: 'OF_REF',
          role: 'version-of',
          argIndex: 0,
        });
        edgesByKey.set(`${responseRequestStateEntryValueVersionStableId}|FORWARDS_VALUE|${responsePayloadValueVersionStableId}`, {
          fromKind: 'ValueVersion',
          fromId: responseRequestStateEntryValueVersionStableId,
          toKind: 'ValueVersion',
          toId: responsePayloadValueVersionStableId,
          type: 'FORWARDS_VALUE',
          role: 'response-payload-correlation',
          argIndex: 0,
        });
        edgesByKey.set(`${responseRequestStateEntryValueVersionStableId}|FORWARDS_VALUE|${errorPayloadValueVersionStableId}`, {
          fromKind: 'ValueVersion',
          fromId: responseRequestStateEntryValueVersionStableId,
          toKind: 'ValueVersion',
          toId: errorPayloadValueVersionStableId,
          type: 'FORWARDS_VALUE',
          role: 'error-payload-correlation',
          argIndex: 0,
        });

        for (const stepStableIds of [...handleMethodResponseDataResponseSteps, ...handleMethodResponseDeliverySteps.filter((steps) => steps[0].includes(':362:'))]) {
          const stepId = stepStableIds[0];
          edgesByKey.set(`${stepId}|READS_VALUE|${responsePayloadValueVersionStableId}`, {
            fromKind: 'Step',
            fromId: stepId,
            toKind: 'ValueVersion',
            toId: responsePayloadValueVersionStableId,
            type: 'READS_VALUE',
            role: 'response-payload-read',
            stepStableIds,
            argIndex: 0,
          });
        }

        for (const stepStableIds of [...handleMethodResponseDataErrorSteps, ...handleMethodResponseDeliverySteps.filter((steps) => steps[0].includes(':360:'))]) {
          const stepId = stepStableIds[0];
          edgesByKey.set(`${stepId}|READS_VALUE|${errorPayloadValueVersionStableId}`, {
            fromKind: 'Step',
            fromId: stepId,
            toKind: 'ValueVersion',
            toId: errorPayloadValueVersionStableId,
            type: 'READS_VALUE',
            role: 'error-payload-read',
            stepStableIds,
            argIndex: 0,
          });
        }
      }

      if (handleMethodCallbackFnStableId) {
        const callbackPayloadValueRefStableId = buildResponsePayloadValueRefStableId(handleMethodCallbackFnStableId, 'callbackArgs');
        const callbackPayloadValueVersionStableId = buildResponsePayloadValueVersionStableId(handleMethodCallbackFnStableId, 'callbackArgs');
        const callbackRequestStateEntryValueVersionStableId = buildRequestStateEntryValueVersionStableId(handleMethodCallbackFnStableId);

        nodesById.set(callbackPayloadValueRefStableId, {
          stableId: callbackPayloadValueRefStableId,
          labels: ['ValueRef'],
          label: 'data.callbackArgs',
          kind: 'ValueRef',
          parentFnStableId: handleMethodCallbackFnStableId,
          repoRelativePath: publicRepoRelativePath,
          callStepStableId: handleMethodCallbackFnStableId,
          argIndex: 0,
          argTextRaw: 'data.callbackArgs',
          argKind: 'callback-payload-slot',
        });
        nodesById.set(callbackPayloadValueVersionStableId, {
          stableId: callbackPayloadValueVersionStableId,
          labels: ['ValueVersion'],
          label: 'data.callbackArgs:v0',
          kind: 'ValueVersion',
          parentFnStableId: handleMethodCallbackFnStableId,
          repoRelativePath: publicRepoRelativePath,
          callStepStableId: handleMethodCallbackFnStableId,
          argIndex: 0,
          argTextRaw: 'data.callbackArgs',
          argKind: 'callback-payload-slot',
          valueRefStableId: callbackPayloadValueRefStableId,
        });

        edgesByKey.set(`${callbackPayloadValueVersionStableId}|OF_REF|${callbackPayloadValueRefStableId}`, {
          fromKind: 'ValueVersion',
          fromId: callbackPayloadValueVersionStableId,
          toKind: 'ValueRef',
          toId: callbackPayloadValueRefStableId,
          type: 'OF_REF',
          role: 'version-of',
          argIndex: 0,
        });
        edgesByKey.set(`${callbackRequestStateEntryValueVersionStableId}|FORWARDS_VALUE|${callbackPayloadValueVersionStableId}`, {
          fromKind: 'ValueVersion',
          fromId: callbackRequestStateEntryValueVersionStableId,
          toKind: 'ValueVersion',
          toId: callbackPayloadValueVersionStableId,
          type: 'FORWARDS_VALUE',
          role: 'callback-payload-correlation',
          argIndex: 0,
        });

        for (const stepStableIds of [...handleMethodCallbackArgsSteps, ...handleMethodCallbackReadSteps]) {
          const stepId = stepStableIds[0];
          edgesByKey.set(`${stepId}|READS_VALUE|${callbackPayloadValueVersionStableId}`, {
            fromKind: 'Step',
            fromId: stepId,
            toKind: 'ValueVersion',
            toId: callbackPayloadValueVersionStableId,
            type: 'READS_VALUE',
            role: 'callback-payload-read',
            stepStableIds,
            argIndex: 0,
          });
        }
      }

      if (trackedArgIndexes.has(2) && workerRuntimeFnStableId && workerRuntimeRepoRelativePath && makeRequestFnStableId) {
        const workerTransportCallbackValueRefStableId = buildWorkerTransportCallbackValueRefStableId(workerRuntimeFnStableId);
        const workerTransportCallbackValueVersionStableId = buildWorkerTransportCallbackValueVersionStableId(workerRuntimeFnStableId);
        const makeRequestStoredCallbackValueVersionStableId = buildRequestCallbackValueVersionStableId(makeRequestFnStableId);

        nodesById.set(workerTransportCallbackValueRefStableId, {
          stableId: workerTransportCallbackValueRefStableId,
          labels: ['ValueRef'],
          label: 'worker.transport.callback',
          kind: 'ValueRef',
          parentFnStableId: workerRuntimeFnStableId,
          repoRelativePath: workerRuntimeRepoRelativePath,
          callStepStableId: workerRuntimeFnStableId,
          argIndex: 2,
          argTextRaw: 'callback',
          argKind: 'worker-callback-slot',
        });
        nodesById.set(workerTransportCallbackValueVersionStableId, {
          stableId: workerTransportCallbackValueVersionStableId,
          labels: ['ValueVersion'],
          label: 'worker.transport.callback:v0',
          kind: 'ValueVersion',
          parentFnStableId: workerRuntimeFnStableId,
          repoRelativePath: workerRuntimeRepoRelativePath,
          callStepStableId: workerRuntimeFnStableId,
          argIndex: 2,
          argTextRaw: 'callback',
          argKind: 'worker-callback-slot',
          valueRefStableId: workerTransportCallbackValueRefStableId,
        });

        edgesByKey.set(`${workerTransportCallbackValueVersionStableId}|OF_REF|${workerTransportCallbackValueRefStableId}`, {
          fromKind: 'ValueVersion',
          fromId: workerTransportCallbackValueVersionStableId,
          toKind: 'ValueRef',
          toId: workerTransportCallbackValueRefStableId,
          type: 'OF_REF',
          role: 'version-of',
          argIndex: 2,
        });
        edgesByKey.set(`${makeRequestStoredCallbackValueVersionStableId}|FORWARDS_VALUE|${workerTransportCallbackValueVersionStableId}`, {
          fromKind: 'ValueVersion',
          fromId: makeRequestStoredCallbackValueVersionStableId,
          toKind: 'ValueVersion',
          toId: workerTransportCallbackValueVersionStableId,
          type: 'FORWARDS_VALUE',
          role: 'worker-callback-recreate',
          argIndex: 2,
        });

        if (workerCallApiFnStableId) {
          const workerCallApiCallbackValueVersionStableId = buildParamValueVersionStableId(workerCallApiFnStableId, 2);
          edgesByKey.set(`${workerTransportCallbackValueVersionStableId}|FORWARDS_VALUE|${workerCallApiCallbackValueVersionStableId}`, {
            fromKind: 'ValueVersion',
            fromId: workerTransportCallbackValueVersionStableId,
            toKind: 'ValueVersion',
            toId: workerCallApiCallbackValueVersionStableId,
            type: 'FORWARDS_VALUE',
            role: 'worker-callback-param',
            argIndex: 2,
          });
        }

        for (const stepStableIds of workerTransportCallbackWriteSteps) {
          const stepId = stepStableIds[0];
          edgesByKey.set(`${stepId}|WRITES_VALUE|${workerTransportCallbackValueVersionStableId}`, {
            fromKind: 'Step',
            fromId: stepId,
            toKind: 'ValueVersion',
            toId: workerTransportCallbackValueVersionStableId,
            type: 'WRITES_VALUE',
            role: 'worker-callback-write',
            stepStableIds,
            argIndex: 2,
          });
        }

        for (const stepStableIds of workerTransportCallbackReadSteps) {
          const stepId = stepStableIds[0];
          edgesByKey.set(`${stepId}|READS_VALUE|${workerTransportCallbackValueVersionStableId}`, {
            fromKind: 'Step',
            fromId: stepId,
            toKind: 'ValueVersion',
            toId: workerTransportCallbackValueVersionStableId,
            type: 'READS_VALUE',
            role: 'worker-callback-read',
            stepStableIds,
            argIndex: 2,
          });
        }
      }

      if (trackedArgIndexes.has(2) && multitabRuntimeFnStableId && multitabRuntimeRepoRelativePath && makeRequestFnStableId && makeRequestToMasterFnStableId) {
        const multitabTransportCallbackValueRefStableId = buildMultitabTransportCallbackValueRefStableId(multitabRuntimeFnStableId);
        const multitabTransportCallbackValueVersionStableId = buildMultitabTransportCallbackValueVersionStableId(multitabRuntimeFnStableId);
        const makeRequestToMasterStoredCallbackValueVersionStableId = buildRequestCallbackValueVersionStableId(makeRequestToMasterFnStableId);
        const makeRequestEnvelopeCallbackValueVersionStableId = buildEnvelopeValueVersionStableId(makeRequestFnStableId, 2);

        nodesById.set(multitabTransportCallbackValueRefStableId, {
          stableId: multitabTransportCallbackValueRefStableId,
          labels: ['ValueRef'],
          label: 'multitab.transport.callback',
          kind: 'ValueRef',
          parentFnStableId: multitabRuntimeFnStableId,
          repoRelativePath: multitabRuntimeRepoRelativePath,
          callStepStableId: multitabRuntimeFnStableId,
          argIndex: 2,
          argTextRaw: 'argsWithCallback.callback',
          argKind: 'multitab-callback-slot',
        });
        nodesById.set(multitabTransportCallbackValueVersionStableId, {
          stableId: multitabTransportCallbackValueVersionStableId,
          labels: ['ValueVersion'],
          label: 'multitab.transport.callback:v0',
          kind: 'ValueVersion',
          parentFnStableId: multitabRuntimeFnStableId,
          repoRelativePath: multitabRuntimeRepoRelativePath,
          callStepStableId: multitabRuntimeFnStableId,
          argIndex: 2,
          argTextRaw: 'argsWithCallback.callback',
          argKind: 'multitab-callback-slot',
          valueRefStableId: multitabTransportCallbackValueRefStableId,
        });

        edgesByKey.set(`${multitabTransportCallbackValueVersionStableId}|OF_REF|${multitabTransportCallbackValueRefStableId}`, {
          fromKind: 'ValueVersion',
          fromId: multitabTransportCallbackValueVersionStableId,
          toKind: 'ValueRef',
          toId: multitabTransportCallbackValueRefStableId,
          type: 'OF_REF',
          role: 'version-of',
          argIndex: 2,
        });
        edgesByKey.set(`${makeRequestToMasterStoredCallbackValueVersionStableId}|FORWARDS_VALUE|${multitabTransportCallbackValueVersionStableId}`, {
          fromKind: 'ValueVersion',
          fromId: makeRequestToMasterStoredCallbackValueVersionStableId,
          toKind: 'ValueVersion',
          toId: multitabTransportCallbackValueVersionStableId,
          type: 'FORWARDS_VALUE',
          role: 'multitab-callback-recreate',
          argIndex: 2,
        });
        edgesByKey.set(`${multitabTransportCallbackValueVersionStableId}|FORWARDS_VALUE|${makeRequestEnvelopeCallbackValueVersionStableId}`, {
          fromKind: 'ValueVersion',
          fromId: multitabTransportCallbackValueVersionStableId,
          toKind: 'ValueVersion',
          toId: makeRequestEnvelopeCallbackValueVersionStableId,
          type: 'FORWARDS_VALUE',
          role: 'multitab-callback-param',
          argIndex: 2,
        });

        for (const stepStableIds of multitabTransportCallbackReadSteps) {
          const stepId = stepStableIds[0];
          edgesByKey.set(`${stepId}|READS_VALUE|${multitabTransportCallbackValueVersionStableId}`, {
            fromKind: 'Step',
            fromId: stepId,
            toKind: 'ValueVersion',
            toId: multitabTransportCallbackValueVersionStableId,
            type: 'READS_VALUE',
            role: 'multitab-callback-read',
            stepStableIds,
            argIndex: 2,
          });
        }
      }
    }

    for (const [apiMethodName, argIndexes] of trackedArgIndexesByApiMethod) {
      const resolvedMethodTarget = uniqueMethodTargetsByName.get(apiMethodName);
      if (!resolvedMethodTarget) {
        continue;
      }

      for (const argIndex of argIndexes) {
        const publicMethodValueRefStableId = buildMethodScopedParamValueRefStableId(publicCallApiFnStableId, apiMethodName, argIndex);
        const publicMethodValueVersionStableId = buildMethodScopedParamValueVersionStableId(publicCallApiFnStableId, apiMethodName, argIndex);
        const workerMethodValueRefStableId = buildMethodScopedParamValueRefStableId(workerCallApiFnStableId, apiMethodName, argIndex);
        const workerMethodValueVersionStableId = buildMethodScopedParamValueVersionStableId(workerCallApiFnStableId, apiMethodName, argIndex);
        const makeRequestMethodEnvelopeValueRefStableId = makeRequestFnStableId
          ? buildMethodScopedEnvelopeValueRefStableId(makeRequestFnStableId, apiMethodName, argIndex)
          : undefined;
        const makeRequestMethodEnvelopeValueVersionStableId = makeRequestFnStableId
          ? buildMethodScopedEnvelopeValueVersionStableId(makeRequestFnStableId, apiMethodName, argIndex)
          : undefined;
        const makeRequestToMasterMethodEnvelopeValueRefStableId = makeRequestToMasterFnStableId
          ? buildMethodScopedEnvelopeValueRefStableId(makeRequestToMasterFnStableId, apiMethodName, argIndex)
          : undefined;
        const makeRequestToMasterMethodEnvelopeValueVersionStableId = makeRequestToMasterFnStableId
          ? buildMethodScopedEnvelopeValueVersionStableId(makeRequestToMasterFnStableId, apiMethodName, argIndex)
          : undefined;
        const resolvedMethodParamValueRefStableId = buildResolvedMethodParamValueRefStableId(resolvedMethodTarget.stableId, argIndex);
        const resolvedMethodParamValueVersionStableId = buildResolvedMethodParamValueVersionStableId(resolvedMethodTarget.stableId, argIndex);
        const resolvedMethodParamName = resolvedMethodTarget.paramNames?.[argIndex - 1] || `arg${argIndex}`;

        nodesById.set(publicMethodValueRefStableId, {
          stableId: publicMethodValueRefStableId,
          labels: ['ValueRef'],
          label: `api-method:${apiMethodName}:param:args:${argIndex}`,
          kind: 'ValueRef',
          parentFnStableId: publicCallApiFnStableId,
          repoRelativePath: publicRepoRelativePath,
          callStepStableId: publicCallApiFnStableId,
          argIndex,
          apiMethodName,
          argTextRaw: 'args',
          argKind: 'rest-parameter-slot',
        });
        nodesById.set(publicMethodValueVersionStableId, {
          stableId: publicMethodValueVersionStableId,
          labels: ['ValueVersion'],
          label: `api-method:${apiMethodName}:param:args:${argIndex}:v0`,
          kind: 'ValueVersion',
          parentFnStableId: publicCallApiFnStableId,
          repoRelativePath: publicRepoRelativePath,
          callStepStableId: publicCallApiFnStableId,
          argIndex,
          apiMethodName,
          argTextRaw: 'args',
          argKind: 'rest-parameter-slot',
          valueRefStableId: publicMethodValueRefStableId,
        });
        nodesById.set(workerMethodValueRefStableId, {
          stableId: workerMethodValueRefStableId,
          labels: ['ValueRef'],
          label: `api-method:${apiMethodName}:param:args:${argIndex}`,
          kind: 'ValueRef',
          parentFnStableId: workerCallApiFnStableId,
          repoRelativePath: workerRepoRelativePath,
          callStepStableId: workerCallApiFnStableId,
          argIndex,
          apiMethodName,
          argTextRaw: 'args',
          argKind: 'rest-parameter-slot',
        });
        nodesById.set(workerMethodValueVersionStableId, {
          stableId: workerMethodValueVersionStableId,
          labels: ['ValueVersion'],
          label: `api-method:${apiMethodName}:param:args:${argIndex}:v0`,
          kind: 'ValueVersion',
          parentFnStableId: workerCallApiFnStableId,
          repoRelativePath: workerRepoRelativePath,
          callStepStableId: workerCallApiFnStableId,
          argIndex,
          apiMethodName,
          argTextRaw: 'args',
          argKind: 'rest-parameter-slot',
          valueRefStableId: workerMethodValueRefStableId,
        });
        nodesById.set(resolvedMethodParamValueRefStableId, {
          stableId: resolvedMethodParamValueRefStableId,
          labels: ['ValueRef'],
          label: `param:${resolvedMethodParamName}`,
          kind: 'ValueRef',
          parentFnStableId: resolvedMethodTarget.stableId,
          repoRelativePath: resolvedMethodTarget.repoRelativePath,
          callStepStableId: resolvedMethodTarget.stableId,
          argIndex,
          apiMethodName,
          argTextRaw: resolvedMethodParamName,
          argKind: 'resolved-method-param-slot',
        });
        nodesById.set(resolvedMethodParamValueVersionStableId, {
          stableId: resolvedMethodParamValueVersionStableId,
          labels: ['ValueVersion'],
          label: `param:${resolvedMethodParamName}:v0`,
          kind: 'ValueVersion',
          parentFnStableId: resolvedMethodTarget.stableId,
          repoRelativePath: resolvedMethodTarget.repoRelativePath,
          callStepStableId: resolvedMethodTarget.stableId,
          argIndex,
          apiMethodName,
          argTextRaw: resolvedMethodParamName,
          argKind: 'resolved-method-param-slot',
          valueRefStableId: resolvedMethodParamValueRefStableId,
        });

        edgesByKey.set(`${publicMethodValueVersionStableId}|OF_REF|${publicMethodValueRefStableId}`, {
          fromKind: 'ValueVersion',
          fromId: publicMethodValueVersionStableId,
          toKind: 'ValueRef',
          toId: publicMethodValueRefStableId,
          type: 'OF_REF',
          role: 'version-of',
          argIndex,
          apiMethodName,
        });
        edgesByKey.set(`${workerMethodValueVersionStableId}|OF_REF|${workerMethodValueRefStableId}`, {
          fromKind: 'ValueVersion',
          fromId: workerMethodValueVersionStableId,
          toKind: 'ValueRef',
          toId: workerMethodValueRefStableId,
          type: 'OF_REF',
          role: 'version-of',
          argIndex,
          apiMethodName,
        });
        edgesByKey.set(`${resolvedMethodParamValueVersionStableId}|OF_REF|${resolvedMethodParamValueRefStableId}`, {
          fromKind: 'ValueVersion',
          fromId: resolvedMethodParamValueVersionStableId,
          toKind: 'ValueRef',
          toId: resolvedMethodParamValueRefStableId,
          type: 'OF_REF',
          role: 'version-of',
          argIndex,
          apiMethodName,
        });

        if (makeRequestMethodEnvelopeValueRefStableId && makeRequestMethodEnvelopeValueVersionStableId && makeRequestFnStableId) {
          nodesById.set(makeRequestMethodEnvelopeValueRefStableId, {
            stableId: makeRequestMethodEnvelopeValueRefStableId,
            labels: ['ValueRef'],
            label: `api-method:${apiMethodName}:payload:args:${argIndex}`,
            kind: 'ValueRef',
            parentFnStableId: makeRequestFnStableId,
            repoRelativePath: makeRequestRepoRelativePath,
            callStepStableId: makeRequestFnStableId,
            argIndex,
            apiMethodName,
            argTextRaw: 'payload.args',
            argKind: 'request-envelope-slot',
          });
          nodesById.set(makeRequestMethodEnvelopeValueVersionStableId, {
            stableId: makeRequestMethodEnvelopeValueVersionStableId,
            labels: ['ValueVersion'],
            label: `api-method:${apiMethodName}:payload:args:${argIndex}:v0`,
            kind: 'ValueVersion',
            parentFnStableId: makeRequestFnStableId,
            repoRelativePath: makeRequestRepoRelativePath,
            callStepStableId: makeRequestFnStableId,
            argIndex,
            apiMethodName,
            argTextRaw: 'payload.args',
            argKind: 'request-envelope-slot',
            valueRefStableId: makeRequestMethodEnvelopeValueRefStableId,
          });
          edgesByKey.set(`${makeRequestMethodEnvelopeValueVersionStableId}|OF_REF|${makeRequestMethodEnvelopeValueRefStableId}`, {
            fromKind: 'ValueVersion',
            fromId: makeRequestMethodEnvelopeValueVersionStableId,
            toKind: 'ValueRef',
            toId: makeRequestMethodEnvelopeValueRefStableId,
            type: 'OF_REF',
            role: 'version-of',
            argIndex,
            apiMethodName,
          });
        }

        if (makeRequestToMasterMethodEnvelopeValueRefStableId && makeRequestToMasterMethodEnvelopeValueVersionStableId && makeRequestToMasterFnStableId) {
          nodesById.set(makeRequestToMasterMethodEnvelopeValueRefStableId, {
            stableId: makeRequestToMasterMethodEnvelopeValueRefStableId,
            labels: ['ValueRef'],
            label: `api-method:${apiMethodName}:payload:args:${argIndex}`,
            kind: 'ValueRef',
            parentFnStableId: makeRequestToMasterFnStableId,
            repoRelativePath: makeRequestToMasterRepoRelativePath,
            callStepStableId: makeRequestToMasterFnStableId,
            argIndex,
            apiMethodName,
            argTextRaw: 'payload.args',
            argKind: 'request-envelope-slot',
          });
          nodesById.set(makeRequestToMasterMethodEnvelopeValueVersionStableId, {
            stableId: makeRequestToMasterMethodEnvelopeValueVersionStableId,
            labels: ['ValueVersion'],
            label: `api-method:${apiMethodName}:payload:args:${argIndex}:v0`,
            kind: 'ValueVersion',
            parentFnStableId: makeRequestToMasterFnStableId,
            repoRelativePath: makeRequestToMasterRepoRelativePath,
            callStepStableId: makeRequestToMasterFnStableId,
            argIndex,
            apiMethodName,
            argTextRaw: 'payload.args',
            argKind: 'request-envelope-slot',
            valueRefStableId: makeRequestToMasterMethodEnvelopeValueRefStableId,
          });
          edgesByKey.set(`${makeRequestToMasterMethodEnvelopeValueVersionStableId}|OF_REF|${makeRequestToMasterMethodEnvelopeValueRefStableId}`, {
            fromKind: 'ValueVersion',
            fromId: makeRequestToMasterMethodEnvelopeValueVersionStableId,
            toKind: 'ValueRef',
            toId: makeRequestToMasterMethodEnvelopeValueRefStableId,
            type: 'OF_REF',
            role: 'version-of',
            argIndex,
            apiMethodName,
          });
        }

        for (const [edgeKey, edge] of edgesByKey) {
          if (edge.type !== 'BINDS_VALUE' || edge.argIndex !== argIndex || edge.role !== 'call-arg' || edge.apiMethodName !== apiMethodName) {
            continue;
          }

          edgesByKey.set(`${edge.toId}|FORWARDS_VALUE|${publicMethodValueVersionStableId}`, {
            fromKind: 'ValueVersion',
            fromId: edge.toId,
            toKind: 'ValueVersion',
            toId: publicMethodValueVersionStableId,
            type: 'FORWARDS_VALUE',
            role: 'public-call-api-param',
            argIndex,
            apiMethodName,
          });
        }

        edgesByKey.set(`${publicMethodValueVersionStableId}|FORWARDS_VALUE|${workerMethodValueVersionStableId}`, {
          fromKind: 'ValueVersion',
          fromId: publicMethodValueVersionStableId,
          toKind: 'ValueVersion',
          toId: workerMethodValueVersionStableId,
          type: 'FORWARDS_VALUE',
          role: 'worker-call-api-param',
          argIndex,
          apiMethodName,
        });
        edgesByKey.set(`${workerMethodValueVersionStableId}|FORWARDS_VALUE|${resolvedMethodParamValueVersionStableId}`, {
          fromKind: 'ValueVersion',
          fromId: workerMethodValueVersionStableId,
          toKind: 'ValueVersion',
          toId: resolvedMethodParamValueVersionStableId,
          type: 'FORWARDS_VALUE',
          role: 'resolved-method-param',
          argIndex,
          apiMethodName,
        });

        if (makeRequestMethodEnvelopeValueVersionStableId) {
          edgesByKey.set(`${publicMethodValueVersionStableId}|FORWARDS_VALUE|${makeRequestMethodEnvelopeValueVersionStableId}`, {
            fromKind: 'ValueVersion',
            fromId: publicMethodValueVersionStableId,
            toKind: 'ValueVersion',
            toId: makeRequestMethodEnvelopeValueVersionStableId,
            type: 'FORWARDS_VALUE',
            role: 'worker-request-envelope-param',
            argIndex,
            apiMethodName,
          });
        }

        if (makeRequestToMasterMethodEnvelopeValueVersionStableId) {
          edgesByKey.set(`${publicMethodValueVersionStableId}|FORWARDS_VALUE|${makeRequestToMasterMethodEnvelopeValueVersionStableId}`, {
            fromKind: 'ValueVersion',
            fromId: publicMethodValueVersionStableId,
            toKind: 'ValueVersion',
            toId: makeRequestToMasterMethodEnvelopeValueVersionStableId,
            type: 'FORWARDS_VALUE',
            role: 'master-request-envelope-param',
            argIndex,
            apiMethodName,
          });
        }

        for (const stepStableIds of publicForwardSteps) {
          const stepId = stepStableIds[0];
          edgesByKey.set(`${stepId}|READS_VALUE|${publicMethodValueVersionStableId}`, {
            fromKind: 'Step',
            fromId: stepId,
            toKind: 'ValueVersion',
            toId: publicMethodValueVersionStableId,
            type: 'READS_VALUE',
            role: 'forward-read',
            stepStableIds,
            argIndex,
            apiMethodName,
          });
        }

        for (const stepStableIds of workerForwardSteps) {
          const stepId = stepStableIds[0];
          edgesByKey.set(`${stepId}|READS_VALUE|${workerMethodValueVersionStableId}`, {
            fromKind: 'Step',
            fromId: stepId,
            toKind: 'ValueVersion',
            toId: workerMethodValueVersionStableId,
            type: 'READS_VALUE',
            role: 'forward-read',
            stepStableIds,
            argIndex,
            apiMethodName,
          });
        }

        if (makeRequestMethodEnvelopeValueVersionStableId) {
          for (const stepStableIds of [...makeRequestPayloadSteps, ...makeRequestSendSteps]) {
            const stepId = stepStableIds[0];
            edgesByKey.set(`${stepId}|READS_VALUE|${makeRequestMethodEnvelopeValueVersionStableId}`, {
              fromKind: 'Step',
              fromId: stepId,
              toKind: 'ValueVersion',
              toId: makeRequestMethodEnvelopeValueVersionStableId,
              type: 'READS_VALUE',
              role: 'request-envelope-read',
              stepStableIds,
              argIndex,
              apiMethodName,
            });
          }
        }

        if (makeRequestToMasterMethodEnvelopeValueVersionStableId) {
          for (const stepStableIds of [...makeRequestToMasterPayloadSteps, ...makeRequestToMasterSendSteps]) {
            const stepId = stepStableIds[0];
            edgesByKey.set(`${stepId}|READS_VALUE|${makeRequestToMasterMethodEnvelopeValueVersionStableId}`, {
              fromKind: 'Step',
              fromId: stepId,
              toKind: 'ValueVersion',
              toId: makeRequestToMasterMethodEnvelopeValueVersionStableId,
              type: 'READS_VALUE',
              role: 'request-envelope-read',
              stepStableIds,
              argIndex,
              apiMethodName,
            });
          }
        }
      }
    }
  }

  return {
    nodes: [...nodesById.values()],
    edges: [...edgesByKey.values()],
  };
}

const args = parseArgs();
const payload = extractCallApiValueFlow(args.fnStableId);
process.stdout.write(JSON.stringify(payload));