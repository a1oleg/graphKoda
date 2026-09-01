import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_FEATURE_BABEL_CONFIG_PATH = path.resolve(process.cwd(), 'graph', 'toolSelectionFeature.functions.babel.json');
const RUNTIME_HELPER_MODULE_PATH = path.resolve(
  process.cwd(),
  'graph',
  'packages',
  'runtime-core',
  'src',
  'autoInstrumentFeatureCall',
);
const CONNECTOR_BINDINGS_MODULE_PATH = path.resolve(
  process.cwd(),
  'graph',
  'packages',
  'runtime-core',
  'src',
  'installConnectorRuntimeBindings',
);
const WORKER_BINDINGS_MODULE_PATH = path.resolve(
  process.cwd(),
  'graph',
  'packages',
  'runtime-core',
  'src',
  'installWorkerRuntimeBindings',
);
const CONNECTOR_FILE_PATH = 'src/api/gramjs/worker/connector.ts';
const WORKER_FILE_PATH = 'src/api/gramjs/worker/worker.ts';
const AUTO_INSTRUMENTATION_DEBUG_PATH = path.resolve(process.cwd(), 'tmp', 'auto-instrumentation-debug.jsonl');

function normalizePath(value = '') {
  return value.replace(/\\/g, '/');
}

function appendDebugProbe(payload) {
  try {
    fs.mkdirSync(path.dirname(AUTO_INSTRUMENTATION_DEBUG_PATH), { recursive: true });
    fs.appendFileSync(AUTO_INSTRUMENTATION_DEBUG_PATH, `${JSON.stringify(payload)}\n`);
  } catch {
    // Swallow probe write failures to keep the build path unchanged.
  }
}

function resolveFeatureBabelConfigPath() {
  const configuredPath = process.env.GRAPH_FEATURE_BABEL_CONFIG_PATH?.trim();
  if (!configuredPath) {
    return DEFAULT_FEATURE_BABEL_CONFIG_PATH;
  }

  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(process.cwd(), configuredPath);
}

function loadFeatureBabelConfig() {
  const configPath = resolveFeatureBabelConfigPath();

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const functionMetadataByLocation = parsed?.functionMetadataByLocation
      && typeof parsed.functionMetadataByLocation === 'object'
      ? parsed.functionMetadataByLocation
      : undefined;
    const functionStableIdsByLocation = Object.fromEntries(
      Object.entries(functionMetadataByLocation || parsed?.functionStableIdsByLocation || {})
        .map(([locationKey, metadata]) => {
          const normalizedLocationKey = normalizePath(String(locationKey || '').trim());
          const stableId = typeof metadata === 'string'
            ? String(metadata || '').trim()
            : String(metadata?.stableId || '').trim();

          return [normalizedLocationKey, stableId];
        })
        .filter(([locationKey, stableId]) => locationKey && stableId),
    );
    const instrumentableLocationKeysByFile = new Map();

    Object.keys(functionStableIdsByLocation).forEach((locationKey) => {
      const match = locationKey.match(/^(.*):(\d+):(\d+):(\d+):(\d+)$/);
      if (!match) {
        return;
      }

      const repoRelativePath = normalizePath(match[1]);
      const locationKeys = instrumentableLocationKeysByFile.get(repoRelativePath) || new Set();
      locationKeys.add(locationKey);
      instrumentableLocationKeysByFile.set(repoRelativePath, locationKeys);
    });

    return {
      functionStableIdsByLocation,
      instrumentableLocationKeysByFile,
    };
  } catch {
    return {
      functionStableIdsByLocation: {},
      instrumentableLocationKeysByFile: new Map(),
    };
  }
}

function buildFunctionLocationKey(repoRelativePath, loc) {
  const start = loc?.start;
  const end = loc?.end;

  if (!repoRelativePath || !start || !end) {
    return null;
  }

  return [
    normalizePath(repoRelativePath),
    start.line,
    start.column,
    end.line,
    end.column,
  ].join(':');
}

function resolveRuntimeHelperImportPath(filename) {
  let relativePath = normalizePath(path.relative(path.dirname(filename), RUNTIME_HELPER_MODULE_PATH));

  if (!relativePath.startsWith('.')) {
    relativePath = `./${relativePath}`;
  }

  return relativePath;
}

function resolveRelativeImportPath(filename, targetModulePath) {
  let relativePath = normalizePath(path.relative(path.dirname(filename), targetModulePath));

  if (!relativePath.startsWith('.')) {
    relativePath = `./${relativePath}`;
  }

  return relativePath;
}

function resolveFunctionName(functionPath) {
  const { node, parentPath } = functionPath;

  if (node.id?.name) {
    return node.id.name;
  }

  if (parentPath?.isVariableDeclarator() && parentPath.node.id.type === 'Identifier') {
    return parentPath.node.id.name;
  }

  if (parentPath?.isObjectProperty()) {
    const key = parentPath.node.key;
    if (key.type === 'Identifier') {
      return key.name;
    }
    if (key.type === 'StringLiteral') {
      return key.value;
    }
  }

  if (parentPath?.isAssignmentExpression()) {
    const left = parentPath.node.left;
    if (left.type === 'Identifier') {
      return left.name;
    }
  }

  if (parentPath?.isCallExpression() && functionPath.listKey === 'arguments') {
    const [firstArgument] = parentPath.node.arguments;
    if (firstArgument?.type === 'StringLiteral' && firstArgument.value) {
      return firstArgument.value;
    }
  }

  return 'anonymous';
}

function shouldSkipFunction(functionName) {
  if (!functionName || functionName === 'anonymous') {
    return true;
  }

  return /^[A-Z]/.test(functionName) || /^use[A-Z0-9_]/.test(functionName);
}

function buildCallbackBody(t, originalBody) {
  if (t.isBlockStatement(originalBody)) {
    return originalBody;
  }

  return t.blockStatement([
    t.returnStatement(originalBody),
  ]);
}

function buildFunctionArgsArrayExpression(t, params) {
  const items = params.map((param) => {
    if (t.isIdentifier(param)) {
      return t.identifier(param.name);
    }

    if (t.isAssignmentPattern(param) && t.isIdentifier(param.left)) {
      return t.identifier(param.left.name);
    }

    if (t.isRestElement(param) && t.isIdentifier(param.argument)) {
      return t.identifier(param.argument.name);
    }

    return t.identifier('undefined');
  });

  return t.arrayExpression(items);
}

function hasImport(programPath, importPath) {
  return programPath.node.body.some((node) => node.type === 'ImportDeclaration' && node.source.value === importPath);
}

function injectConnectorRuntimeBridge(programPath, state, t) {
  if (state.didInjectConnectorBridge) {
    return;
  }

  let didInject = false;

  programPath.traverse({
    AssignmentExpression(assignmentPath) {
      if (didInject) {
        return;
      }

      const { node, parentPath } = assignmentPath;
      if (!t.isIdentifier(node.left, { name: 'worker' })) {
        return;
      }

      if (!t.isNewExpression(node.right) || !t.isIdentifier(node.right.callee, { name: 'Worker' })) {
        return;
      }

      if (!parentPath.isExpressionStatement()) {
        return;
      }

      parentPath.insertAfter(
        t.expressionStatement(
          t.callExpression(
            t.optionalMemberExpression(
              t.memberExpression(t.identifier('globalThis'), t.identifier('__telegraphRuntimeConnectorBindings')),
              t.identifier('bindRuntimeWorkerChannel'),
              false,
              true,
            ),
            [
              t.arrowFunctionExpression(
                [t.identifier('events')],
                t.blockStatement([
                  t.ifStatement(
                    t.unaryExpression('!', t.identifier('worker')),
                    t.blockStatement([
                      t.returnStatement(t.booleanLiteral(false)),
                    ]),
                  ),
                  t.expressionStatement(
                    t.callExpression(t.identifier('postMessageOnTickEnd'), [
                      t.objectExpression([
                        t.objectProperty(t.identifier('type'), t.stringLiteral('runtimeEventsBatch')),
                        t.objectProperty(t.identifier('events'), t.identifier('events')),
                      ]),
                    ]),
                  ),
                  t.returnStatement(t.booleanLiteral(true)),
                ]),
              ),
            ],
          ),
        ),
      );

      didInject = true;
      assignmentPath.stop();
    },
  });

  if (didInject) {
    state.didInjectConnectorBridge = true;
  }
}

function injectWorkerRuntimeBridge(programPath, state, t) {
  if (state.didInjectWorkerBridge) {
    return;
  }

  let didInject = false;

  programPath.traverse({
    SwitchStatement(switchPath) {
      if (didInject) {
        return;
      }

      const discriminant = switchPath.node.discriminant;
      if (!t.isMemberExpression(discriminant)) {
        return;
      }

      if (!t.isIdentifier(discriminant.object, { name: 'payload' }) || !t.isIdentifier(discriminant.property, { name: 'type' })) {
        return;
      }

      const hasRuntimeCase = switchPath.node.cases.some((caseNode) => t.isStringLiteral(caseNode.test, { value: 'runtimeEventsBatch' }));
      if (hasRuntimeCase) {
        didInject = true;
        state.didInjectWorkerBridge = true;
        return;
      }

      const runtimeCase = t.switchCase(t.stringLiteral('runtimeEventsBatch'), [
        t.expressionStatement(
          t.awaitExpression(
            t.callExpression(
              t.optionalMemberExpression(
                t.memberExpression(t.identifier('globalThis'), t.identifier('__telegraphRuntimeWorkerBindings')),
                t.identifier('forwardWorkerRuntimeEvents'),
                false,
                true,
              ),
              [t.memberExpression(t.identifier('payload'), t.identifier('events'))],
            ),
          ),
        ),
        t.breakStatement(),
      ]);

      const toggleDebugModeIndex = switchPath.node.cases.findIndex((caseNode) => t.isStringLiteral(caseNode.test, { value: 'toggleDebugMode' }));
      if (toggleDebugModeIndex >= 0) {
        switchPath.node.cases.splice(toggleDebugModeIndex, 0, runtimeCase);
      } else {
        switchPath.node.cases.push(runtimeCase);
      }

      didInject = true;
      state.didInjectWorkerBridge = true;
      switchPath.stop();
    },
  });
}

export default function toolSelectionAutoInstrumentationPlugin({ types: t }) {
  const featureBabelConfig = loadFeatureBabelConfig();

  function instrumentFunction(functionPath, state) {
    if (!state.shouldInstrumentFile || functionPath.node.__autoInstrumentedFeatureCall) {
      return;
    }

    if (!['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(functionPath.node.type)) {
      return;
    }

    if (functionPath.node.generator) {
      return;
    }

    if (!functionPath.node.loc) {
      return;
    }

    const locationKey = buildFunctionLocationKey(state.repoRelativePath, functionPath.node.loc);
    if (!locationKey || !state.instrumentableLocationKeysForFile?.has(locationKey)) {
      return;
    }

    const functionName = resolveFunctionName(functionPath);
    if (shouldSkipFunction(functionName)) {
      return;
    }

    const callbackBody = buildCallbackBody(t, functionPath.node.body);
    const callback = t.arrowFunctionExpression([], callbackBody, functionPath.node.async);
    callback.__autoInstrumentedFeatureCall = true;
    const injectedStableId = featureBabelConfig.functionStableIdsByLocation[
      locationKey
    ];

    const contextId = functionPath.scope.generateUidIdentifier('runtimeCallContext');
    const callOptions = [
      t.objectProperty(t.identifier('fnName'), t.stringLiteral(functionName)),
      t.objectProperty(t.identifier('filePath'), t.stringLiteral(state.filePath)),
      t.objectProperty(t.identifier('fnStartLine'), t.numericLiteral(functionPath.node.loc.start.line)),
      t.objectProperty(t.identifier('fnStartColumn'), t.numericLiteral(functionPath.node.loc.start.column)),
      t.objectProperty(t.identifier('fnEndLine'), t.numericLiteral(functionPath.node.loc.end.line)),
      t.objectProperty(t.identifier('fnEndColumn'), t.numericLiteral(functionPath.node.loc.end.column)),
    ];

    if (injectedStableId) {
      callOptions.push(t.objectProperty(t.identifier('stableId'), t.stringLiteral(injectedStableId)));
    }

    const nextBody = t.blockStatement([
      t.variableDeclaration('const', [
        t.variableDeclarator(
          contextId,
          t.callExpression(state.logCallHelperId, [
            t.objectExpression(callOptions),
            t.identifier('undefined'),
            buildFunctionArgsArrayExpression(t, functionPath.node.params),
          ]),
        ),
      ]),
      t.returnStatement(
        t.callExpression(state.withContextHelperId, [
          contextId,
          callback,
        ]),
      ),
    ]);

    functionPath.node.body = nextBody;
    functionPath.node.expression = false;
    functionPath.node.__autoInstrumentedFeatureCall = true;
    state.didInstrumentFile = true;
    state.instrumentedFunctions.push({
      functionName,
      stableId: injectedStableId || null,
      locationKey,
    });
  }

  return {
    name: 'tool-selection-auto-instrumentation',
    visitor: {
      Program: {
        enter(programPath, state) {
          const filename = normalizePath(state.file.opts.filename || '');
          const repoRelativePath = normalizePath(path.relative(process.cwd(), filename));
          const instrumentableLocationKeysForFile = featureBabelConfig.instrumentableLocationKeysByFile.get(repoRelativePath) || null;

          state.instrumentableLocationKeysForFile = instrumentableLocationKeysForFile;
          state.shouldInstrumentFile = Boolean(instrumentableLocationKeysForFile?.size);
          state.repoRelativePath = repoRelativePath;
          state.isConnectorFile = repoRelativePath === CONNECTOR_FILE_PATH;
          state.isWorkerFile = repoRelativePath === WORKER_FILE_PATH;
          state.filePath = filename;
          state.didInstrumentFile = false;
          state.instrumentedFunctions = [];
          state.didInjectConnectorBridge = false;
          state.didInjectWorkerBridge = false;
          state.helperImportPath = resolveRuntimeHelperImportPath(filename);
          state.connectorBindingsImportPath = resolveRelativeImportPath(filename, CONNECTOR_BINDINGS_MODULE_PATH);
          state.workerBindingsImportPath = resolveRelativeImportPath(filename, WORKER_BINDINGS_MODULE_PATH);
          state.logCallHelperId = programPath.scope.generateUidIdentifier('logAutoInstrumentedFunctionCall');
          state.withContextHelperId = programPath.scope.generateUidIdentifier('withAutoInstrumentedFunctionContext');

          if (state.isConnectorFile) {
            injectConnectorRuntimeBridge(programPath, state, t);
          }

          if (state.isWorkerFile) {
            injectWorkerRuntimeBridge(programPath, state, t);
          }
        },
        exit(programPath, state) {
          appendDebugProbe({
            atIso: new Date().toISOString(),
            filename: state.filePath,
            repoRelativePath: state.repoRelativePath,
            shouldInstrumentFile: state.shouldInstrumentFile,
            didInstrumentFile: state.didInstrumentFile,
            instrumentedFunctions: state.instrumentedFunctions,
            didInjectConnectorBridge: state.didInjectConnectorBridge,
            didInjectWorkerBridge: state.didInjectWorkerBridge,
            autoInstrumentEnv: process.env.GRAPH_FEATURE_BABEL_AUTO_INSTRUMENT || null,
            configPathEnv: process.env.GRAPH_FEATURE_BABEL_CONFIG_PATH || null,
          });

          if (state.didInjectConnectorBridge && !hasImport(programPath, state.connectorBindingsImportPath)) {
            programPath.unshiftContainer('body', t.importDeclaration([], t.stringLiteral(state.connectorBindingsImportPath)));
          }

          if (state.didInjectWorkerBridge && !hasImport(programPath, state.workerBindingsImportPath)) {
            programPath.unshiftContainer('body', t.importDeclaration([], t.stringLiteral(state.workerBindingsImportPath)));
          }

          if (!state.didInstrumentFile) {
            return;
          }

          programPath.unshiftContainer('body', t.importDeclaration([
            t.importSpecifier(state.logCallHelperId, t.identifier('logAutoInstrumentedFunctionCall')),
            t.importSpecifier(state.withContextHelperId, t.identifier('withAutoInstrumentedFunctionContext')),
          ], t.stringLiteral(state.helperImportPath)));
        },
      },
      FunctionDeclaration: instrumentFunction,
      FunctionExpression: instrumentFunction,
      ArrowFunctionExpression: instrumentFunction,
    },
  };
}

