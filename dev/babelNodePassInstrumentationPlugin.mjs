import path from 'node:path';

import { normalizeStableId } from '../graph/packages/runtime-core/src/stableId.js';

const TARGET_STABLE_ID_KEYS = new Set([
  'stableId',
  'ownerFnStableId',
  'pullStableId',
  'iterationValueStableId',
  'iterationGuardStableId',
  'callbackStableId',
  'accumulatorStableId',
  'resultStableId',
  'trueTargetStableId',
  'falseTargetStableId',
  'iterationOutcomeStableId',
]);

function targetStringValue(target, key) {
  const value = target[key];
  if (typeof value !== 'string' || !TARGET_STABLE_ID_KEYS.has(key)) return value;
  return normalizeStableId(value, { sourceFilePath: target.filePath });
}

function normalizePath(value = '') {
  return String(value).replace(/\\/g, '/');
}

function locationMatches(node, target) {
  return Boolean(
    node.loc
      && node.loc.start.line === target.startLine
      && node.loc.start.column === target.startColumn
      && node.loc.end.line === target.endLine
      && node.loc.end.column === target.endColumn,
  );
}

function buildTargetDetails(t, target) {
  const properties = [
    t.objectProperty(t.identifier('stableId'), t.stringLiteral(targetStringValue(target, 'stableId'))),
    t.objectProperty(t.identifier('ownerFnStableId'), t.stringLiteral(targetStringValue(target, 'ownerFnStableId'))),
    t.objectProperty(t.identifier('filePath'), t.stringLiteral(target.filePath)),
    t.objectProperty(t.identifier('startLine'), t.numericLiteral(target.startLine)),
    t.objectProperty(t.identifier('startColumn'), t.numericLiteral(target.startColumn)),
    t.objectProperty(t.identifier('endLine'), t.numericLiteral(target.endLine)),
    t.objectProperty(t.identifier('endColumn'), t.numericLiteral(target.endColumn)),
    t.objectProperty(t.identifier('role'), t.stringLiteral(target.role || 'node')),
    t.objectProperty(t.identifier('startsChain'), t.booleanLiteral(Boolean(target.startsChain))),
  ];
  for (const key of [
    'instrumentationKind',
    'methodName',
    'pullStableId',
    'iterationValueStableId',
    'iterationGuardStableId',
    'callbackStableId',
    'accumulatorStableId',
    'accumulatorName',
    'resultStableId',
    'stageName',
    'trueTargetStableId',
    'falseTargetStableId',
    'iterationOutcomeStableId',
    'predicateOutcomeMode',
    'ownerStepStableId',
    'variableName',
    'valuePath',
  ]) {
    if (typeof target[key] === 'string') {
      properties.push(t.objectProperty(t.identifier(key), t.stringLiteral(targetStringValue(target, key))));
    }
  }
  if (typeof target.continuesAfterResult === 'boolean') {
    properties.push(t.objectProperty(
      t.identifier('continuesAfterResult'),
      t.booleanLiteral(target.continuesAfterResult),
    ));
  }
  return t.objectExpression(properties);
}

function buildEvaluatedExpression(t, target, originalExpression) {
  const awaited = t.isAwaitExpression(originalExpression);
  const evaluator = t.memberExpression(
    t.identifier('globalThis'),
    t.identifier(awaited ? '__coldKodeEvaluateAsyncNode' : '__coldKodeEvaluateNode'),
  );
  const evaluatedExpression = awaited
    ? originalExpression.argument
    : originalExpression;
  const call = t.callExpression(evaluator, [
    buildTargetDetails(t, target),
    t.arrowFunctionExpression([], evaluatedExpression),
    ...(target.valueBinding ? [t.arrowFunctionExpression([], t.identifier(target.valueBinding))] : []),
  ]);
  if (awaited) return t.awaitExpression(call);
  return call;
}

function buildCollectionIterationExpression(t, target, originalCall) {
  const callbackIndex = Number.isInteger(target.callbackArgumentIndex)
    ? target.callbackArgumentIndex
    : 0;
  const callback = originalCall.arguments[callbackIndex];
  if (!callback || !t.isExpression(callback)) return null;

  const wrapCallback = t.memberExpression(
    t.identifier('globalThis'),
    t.identifier('__coldKodeWrapCollectionCallback'),
  );
  originalCall.arguments[callbackIndex] = t.callExpression(wrapCallback, [
    buildTargetDetails(t, target),
    callback,
  ]);

  const evaluateCollection = t.memberExpression(
    t.identifier('globalThis'),
    t.identifier('__coldKodeEvaluateCollectionCall'),
  );
  return t.callExpression(evaluateCollection, [
    buildTargetDetails(t, target),
    t.arrowFunctionExpression([], originalCall),
  ]);
}

function buildForOfIterableExpression(t, target, originalIterable) {
  const wrapIterable = t.memberExpression(
    t.identifier('globalThis'),
    t.identifier('__coldKodeWrapForOfIterable'),
  );
  return t.callExpression(wrapIterable, [
    buildTargetDetails(t, target),
    originalIterable,
  ]);
}

function buildFunctionEntryStatement(t, target) {
  const logger = t.memberExpression(t.identifier('globalThis'), t.identifier('__coldKodeLogNodePass'));
  return t.expressionStatement(t.unaryExpression(
    'void',
    t.callExpression(logger, [buildTargetDetails(t, target)]),
  ));
}

function buildParameterValueStatement(t, target, parameter) {
  return t.expressionStatement(t.unaryExpression(
    'void',
    buildEvaluatedExpression(t, target, t.identifier(parameter.name)),
  ));
}

export default function nodePassInstrumentationPlugin({ types: t }) {
  return {
    name: 'coldkode-node-pass-instrumentation',
    pre(file) {
      const filename = normalizePath(file.opts.filename || '');
      const root = normalizePath(process.cwd()).replace(/\/$/, '');
      this.repoRelativePath = filename.startsWith(`${root}/`)
        ? filename.slice(root.length + 1)
        : normalizePath(path.relative(process.cwd(), filename));
      this.instrumentedStableIds = [];
    },
    visitor: {
      Function: {
        enter(functionPath, state) {
          const target = state.opts.targets.find((candidate) => (
            candidate.instrumentationKind === 'function-entry'
              && normalizePath(candidate.filePath) === this.repoRelativePath
              && locationMatches(functionPath.node, candidate)
          ));
          if (!target || !functionPath.get('body').isBlockStatement()) return;
          const parameterStatements = functionPath.node.params.flatMap((parameter) => {
            if (!t.isIdentifier(parameter)) return [];
            const parameterTarget = state.opts.targets.find((candidate) => (
              candidate.instrumentationKind === 'parameter-value'
                && normalizePath(candidate.filePath) === this.repoRelativePath
                && locationMatches(parameter, candidate)
            ));
            if (!parameterTarget) return [];
            this.instrumentedStableIds.push(parameterTarget.stableId);
            return [buildParameterValueStatement(t, parameterTarget, parameter)];
          });
          functionPath.get('body').unshiftContainer('body', [
            buildFunctionEntryStatement(t, target),
            ...parameterStatements,
          ]);
          this.instrumentedStableIds.push(target.stableId);
        },
      },
      ForOfStatement: {
        exit(forOfPath, state) {
          const target = state.opts.targets.find((candidate) => (
            candidate.instrumentationKind === 'for-of-iteration'
              && normalizePath(candidate.filePath) === this.repoRelativePath
              && locationMatches(forOfPath.node, candidate)
          ));
          if (!target) return;
          if (forOfPath.node.await) {
            throw forOfPath.buildCodeFrameError('Async for-await instrumentation is not supported yet');
          }

          forOfPath.node.right = buildForOfIterableExpression(
            t,
            target,
            t.cloneNode(forOfPath.node.right, true),
          );
          this.instrumentedStableIds.push(target.stableId);
        },
      },
      ForStatement: {
        exit(loopPath, state) {
          const target = state.opts.targets.find(candidate => candidate.instrumentationKind === 'for-iteration'
            && normalizePath(candidate.filePath) === this.repoRelativePath && locationMatches(loopPath.node, candidate));
          if (!target) return;
          const stateId = loopPath.scope.generateUidIdentifier('loopTrace');
          if (loopPath.parentPath.isLabeledStatement()) throw loopPath.buildCodeFrameError('Labeled for instrumentation is not supported');
          const errorId = loopPath.scope.generateUidIdentifier('loopError');
          const runtimeCall = (name, args) => t.callExpression(t.memberExpression(t.identifier('globalThis'), t.identifier(name)), args);
          const body = t.isBlockStatement(loopPath.node.body) ? loopPath.node.body : t.blockStatement([loopPath.node.body]);
          const bindings = t.isVariableDeclaration(loopPath.node.init)
            ? loopPath.node.init.declarations.filter(d => t.isIdentifier(d.id)).map(d =>
              t.objectProperty(t.identifier(d.id.name), t.identifier(d.id.name))) : [];
          loopPath.node.body = t.blockStatement([
            t.expressionStatement(runtimeCall('__coldKodeBeginForIteration', [stateId, t.objectExpression(bindings)])),
            t.tryStatement(body, t.catchClause(errorId, t.blockStatement([
              t.expressionStatement(t.assignmentExpression('=', t.memberExpression(stateId, t.identifier('error')), errorId)),
              t.throwStatement(errorId),
            ])), t.blockStatement([
              t.expressionStatement(runtimeCall('__coldKodeEndForIteration', [stateId])),
            ])),
          ]);
          const loop = t.cloneNode(loopPath.node, true);
          loopPath.replaceWith(t.blockStatement([
            t.variableDeclaration('const', [t.variableDeclarator(stateId, runtimeCall('__coldKodeBeginFor', [buildTargetDetails(t, target)]))]),
            t.tryStatement(t.blockStatement([loop]), null, t.blockStatement([
              t.expressionStatement(runtimeCall('__coldKodeEndFor', [stateId])),
            ])),
          ]));
          this.instrumentedStableIds.push(target.stableId);
          loopPath.skip();
        },
      },
      VariableDeclarator: {
        exit(declaratorPath, state) {
          if (!declaratorPath.node.init) return;
          const target = state.opts.targets.find((candidate) => (
            candidate.instrumentationKind === 'binding-value'
              && normalizePath(candidate.filePath) === this.repoRelativePath
              && locationMatches(declaratorPath.node.id, candidate)
          ));
          if (!target) return;

          declaratorPath.node.init = buildEvaluatedExpression(
            t,
            target,
            t.cloneNode(declaratorPath.node.init, true),
          );
          this.instrumentedStableIds.push(target.stableId);
        },
      },
      CallExpression: {
        exit(callPath, state) {
          const target = state.opts.targets.find((candidate) => (
            candidate.instrumentationKind === 'collection-iteration'
              && normalizePath(candidate.filePath) === this.repoRelativePath
              && locationMatches(callPath.node, candidate)
          ));
          if (!target) return;

          const originalCall = t.cloneNode(callPath.node, true);
          const replacement = buildCollectionIterationExpression(t, target, originalCall);
          if (!replacement) {
            throw callPath.buildCodeFrameError(
              `Collection callback argument ${target.callbackArgumentIndex ?? 0} is not an expression`,
            );
          }
          callPath.replaceWith(replacement);
          this.instrumentedStableIds.push(target.stableId);
          callPath.skip();
        },
      },
      Expression: {
        exit(expressionPath, state) {
          const target = state.opts.targets.find((candidate) => (
            candidate.instrumentationKind !== 'collection-iteration'
              && candidate.instrumentationKind !== 'for-of-iteration'
              && candidate.instrumentationKind !== 'binding-value'
              && candidate.instrumentationKind !== 'parameter-value'
              && candidate.instrumentationKind !== 'function-entry'
              &&
            normalizePath(candidate.filePath) === this.repoRelativePath
              && locationMatches(expressionPath.node, candidate)
          ));
          if (!target) return;

          const originalExpression = t.cloneNode(expressionPath.node, true);
          expressionPath.replaceWith(buildEvaluatedExpression(t, target, originalExpression));
          this.instrumentedStableIds.push(target.stableId);
          expressionPath.skip();
        },
      },
    },
    post(file) {
      file.metadata.nodePassInstrumentation = {
        stableIds: this.instrumentedStableIds,
      };
    },
  };
}
