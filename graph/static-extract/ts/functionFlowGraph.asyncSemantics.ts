import ts from 'typescript';

type PromiseResourceSubkind = 'promise' | 'promise-collection';

type AsyncSemanticPayload = Record<string, unknown>[] | undefined;

export type AsyncSemanticDependencies = {
  checker: ts.TypeChecker;
  sourceFile: ts.SourceFile;
  unwrapExpression: (expression: ts.Expression) => ts.Expression;
  getPropertyNameText: (name: ts.PropertyName | ts.MemberName) => string;
  collectCallExpressions: (node: ts.Node) => ts.CallExpression[];
  isAbortControllerTypeText: (typeText: string | undefined) => boolean;
  isAbortSignalTypeText: (typeText: string | undefined) => boolean;
  collectPromiseResourceDescriptors: (
    checker: ts.TypeChecker | undefined,
    sourceFile: ts.SourceFile,
    candidate: ts.Expression,
  ) => Record<string, unknown>[] | undefined;
  buildPromiseResourceDescriptor: (
    resourceName: string,
    resourceSubkind: PromiseResourceSubkind,
  ) => Record<string, unknown>;
  deriveTimeoutResourceSemanticId: (resourceName: string | undefined) => string | undefined;
  deriveAbortResourceSemanticIdFromText: (text: string | undefined) => string | undefined;
  getPromiseCombinatorKind: (expression: ts.CallExpression) => string | undefined;
};

function getNodeTypeText(deps: AsyncSemanticDependencies, node: ts.Node | undefined) {
  if (!node) {
    return undefined;
  }

  return deps.checker.typeToString(deps.checker.getTypeAtLocation(node));
}

function isDeferredTypeText(typeText: string | undefined) {
  return Boolean(typeText && /(^|\W)Deferred(?:<|\b)/.test(typeText));
}

function isPromiseTypeText(typeText: string | undefined) {
  return Boolean(typeText && /(^|\W)(?:Promise(?:Like)?|EnsurePromise)(?:<|\b)/.test(typeText));
}

function buildAsyncFlowAccess({
  accessType,
  asyncKind,
  asyncPhase,
  resourceSubkind,
  resourceName,
  resourceSemanticId,
  resourceSemanticDetailId,
}: {
  accessType: string;
  asyncKind: string;
  asyncPhase: string;
  resourceSubkind: string;
  resourceName: string;
  resourceSemanticId?: string;
  resourceSemanticDetailId?: string;
}) {
  return {
    accessType,
    asyncKind,
    asyncPhase,
    resourceKind: 'async-flow',
    resourceSubkind,
    resourceName,
    resourceSemanticId,
    resourceSemanticDetailId,
  };
}

function isDeferredLikeExpression(deps: AsyncSemanticDependencies, node: ts.Node | undefined) {
  return isDeferredTypeText(getNodeTypeText(deps, node));
}

function isPromiseLikeExpression(deps: AsyncSemanticDependencies, node: ts.Node | undefined) {
  return isPromiseTypeText(getNodeTypeText(deps, node));
}

function buildAsyncDeferredSignalAccess(
  deps: AsyncSemanticDependencies,
  deferredExpression: ts.Expression,
  methodName: 'resolve' | 'reject',
  triggerResourceName?: string,
  triggerKind?: string,
) {
  return {
    ...buildAsyncFlowAccess({
      accessType: 'signal',
      asyncKind: 'deferred',
      asyncPhase: methodName,
      resourceSubkind: 'deferred',
      resourceName: deferredExpression.getText(deps.sourceFile),
      resourceSemanticId: 'deferred',
      resourceSemanticDetailId: `deferred:${methodName}`,
    }),
    signalKind: methodName,
    triggerResourceName,
    triggerKind,
  };
}

function collectAsyncHandlerSignalAccesses(
  deps: AsyncSemanticDependencies,
  handler: ts.Expression,
  triggerResourceName?: string,
  triggerKind?: string,
) {
  const accesses: Record<string, unknown>[] = [];

  if (ts.isPropertyAccessExpression(handler)) {
    const methodName = deps.getPropertyNameText(handler.name);
    if ((methodName === 'resolve' || methodName === 'reject') && isDeferredLikeExpression(deps, handler.expression)) {
      accesses.push(buildAsyncDeferredSignalAccess(deps, handler.expression, methodName, triggerResourceName, triggerKind));
    }

    return accesses;
  }

  if (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler)) {
    return accesses;
  }

  for (const callExpression of deps.collectCallExpressions(handler.body)) {
    const callee = callExpression.expression;
    if (!ts.isPropertyAccessExpression(callee)) {
      continue;
    }

    const methodName = deps.getPropertyNameText(callee.name);
    if (methodName !== 'resolve' && methodName !== 'reject') {
      continue;
    }

    if (!isDeferredLikeExpression(deps, callee.expression)) {
      continue;
    }

    accesses.push(buildAsyncDeferredSignalAccess(deps, callee.expression, methodName, triggerResourceName, triggerKind));
  }

  return accesses;
}

function buildPromiseCombinatorAsyncAccessPayload(
  deps: AsyncSemanticDependencies,
  expression: ts.CallExpression,
  combinatorKind: string,
) {
  return [{
    ...buildAsyncFlowAccess({
      accessType: 'subscribe',
      asyncKind: 'promise-combinator',
      asyncPhase: combinatorKind,
      resourceSubkind: 'promise-combinator',
      resourceName: expression.getText(deps.sourceFile),
    }),
    combinatorKind,
    inputResources: collectPromiseCombinatorInputResources(deps, expression),
  }];
}

function collectPromiseCombinatorInputResources(
  deps: AsyncSemanticDependencies,
  expression: ts.CallExpression,
) {
  const [inputArg] = expression.arguments;
  if (!inputArg) {
    return undefined;
  }

  const normalizedInputArg = deps.unwrapExpression(inputArg);
  return deps.collectPromiseResourceDescriptors(deps.checker, deps.sourceFile, normalizedInputArg);
}

function buildPromiseTriggerResourceNames(
  deps: AsyncSemanticDependencies,
  promiseExpression: ts.Expression,
) {
  const promiseResourceName = promiseExpression.getText(deps.sourceFile);
  const promiseResources = deps.collectPromiseResourceDescriptors(deps.checker, deps.sourceFile, promiseExpression);
  const triggerResourceNames = (promiseResources?.map((resource) => resource.resourceName)
    .filter((resourceName): resourceName is string => typeof resourceName === 'string' && Boolean(resourceName))
    ?? []);

  if (!triggerResourceNames.length && promiseResourceName) {
    triggerResourceNames.push(promiseResourceName);
  }

  return {
    promiseResourceName,
    promiseResources,
    triggerResourceNames: Array.from(new Set(triggerResourceNames)),
  };
}

function collectAbortAsyncAccessesForExpression(
  deps: AsyncSemanticDependencies,
  expression: ts.Expression,
): AsyncSemanticPayload {
  const normalized = deps.unwrapExpression(expression);

  if (ts.isConditionalExpression(normalized)) {
    const whenTrue = collectAbortAsyncAccessesForExpression(deps, normalized.whenTrue);
    const whenFalse = collectAbortAsyncAccessesForExpression(deps, normalized.whenFalse);
    const accesses = [...(whenTrue || []), ...(whenFalse || [])];
    return accesses.length ? accesses : undefined;
  }

  if (ts.isNewExpression(normalized)) {
    const calleeText = normalized.expression.getText(deps.sourceFile);
    if (calleeText === 'AbortController' || calleeText === 'ChatAbortController'
      || deps.isAbortControllerTypeText(getNodeTypeText(deps, normalized))) {
      return [{
        ...buildAsyncFlowAccess({
          accessType: 'create',
          asyncKind: 'abort',
          asyncPhase: 'create',
          resourceSubkind: 'abort-controller',
          resourceName: normalized.getText(deps.sourceFile),
        }),
      }];
    }

    return undefined;
  }

  if (ts.isPropertyAccessExpression(normalized)) {
    const propertyName = deps.getPropertyNameText(normalized.name);
    if (propertyName === 'signal' && deps.isAbortControllerTypeText(getNodeTypeText(deps, normalized.expression))) {
      const sourceResourceName = normalized.expression.getText(deps.sourceFile);
      return [{
        ...buildAsyncFlowAccess({
          accessType: 'derive',
          asyncKind: 'abort',
          asyncPhase: 'derive',
          resourceSubkind: 'abort-signal',
          resourceName: normalized.getText(deps.sourceFile),
          resourceSemanticId: deps.deriveAbortResourceSemanticIdFromText(sourceResourceName),
        }),
        sourceResourceName,
        sourceResourceSubkind: 'abort-controller',
      }];
    }

    return undefined;
  }

  if (ts.isCallExpression(normalized) && ts.isPropertyAccessExpression(normalized.expression)) {
    const methodName = deps.getPropertyNameText(normalized.expression.name);
    if (methodName === 'getThreadSignal'
      && deps.isAbortControllerTypeText(getNodeTypeText(deps, normalized.expression.expression))) {
      const sourceResourceName = normalized.expression.expression.getText(deps.sourceFile);
    return [{
      ...buildAsyncFlowAccess({
        accessType: 'derive',
        asyncKind: 'abort',
        asyncPhase: 'derive',
        resourceSubkind: 'abort-signal',
        resourceName: normalized.getText(deps.sourceFile),
        resourceSemanticId: 'abort:thread',
      }),
      sourceResourceName,
      sourceResourceSubkind: 'abort-controller',
    }];
    }
  }

  return undefined;
}

function collectAbortSignalArgumentAccesses(
  deps: AsyncSemanticDependencies,
  expression: ts.CallExpression,
): AsyncSemanticPayload {
  const accesses: Record<string, unknown>[] = [];

  expression.arguments.forEach((argument, argumentIndex) => {
    const normalized = deps.unwrapExpression(argument);
    if (!deps.isAbortSignalTypeText(getNodeTypeText(deps, normalized))) {
      return;
    }

    accesses.push({
      ...buildAsyncFlowAccess({
        accessType: 'subscribe',
        asyncKind: 'abort',
        asyncPhase: 'listen',
        resourceSubkind: 'abort-signal',
        resourceName: normalized.getText(deps.sourceFile),
      }),
      argumentIndex,
    });
  });

  return accesses.length ? accesses : undefined;
}

function collectAbortTriggerCallAccesses(
  deps: AsyncSemanticDependencies,
  expression: ts.CallExpression,
): AsyncSemanticPayload {
  const callee = expression.expression;
  if (!ts.isPropertyAccessExpression(callee)) {
    return undefined;
  }

  const methodName = deps.getPropertyNameText(callee.name);
  const receiver = callee.expression;
  const receiverTypeText = getNodeTypeText(deps, receiver);
  const receiverText = receiver.getText(deps.sourceFile);
  const reasonText = expression.arguments[0]?.getText(deps.sourceFile);

  if (methodName === 'abort' && deps.isAbortControllerTypeText(receiverTypeText)) {
    const resourceSemanticId = deps.deriveAbortResourceSemanticIdFromText(receiverText);
    return [{
      ...buildAsyncFlowAccess({
        accessType: 'signal',
        asyncKind: 'abort',
        asyncPhase: 'abort',
        resourceSubkind: 'abort-controller',
        resourceName: receiverText,
        resourceSemanticId,
      }),
      signalKind: 'abort',
      reasonText,
    }, {
      ...buildAsyncFlowAccess({
        accessType: 'signal',
        asyncKind: 'abort',
        asyncPhase: 'abort',
        resourceSubkind: 'abort-signal',
        resourceName: `${receiverText}.signal`,
        resourceSemanticId,
      }),
      signalKind: 'abort',
      sourceResourceName: receiverText,
      sourceResourceSubkind: 'abort-controller',
      reasonText,
    }];
  }

  if (methodName === 'abortThread' && /(^|\W)ChatAbortController(?:<|\b)/.test(receiverTypeText || '')) {
    const threadIdText = expression.arguments[0]?.getText(deps.sourceFile);
    if (!threadIdText) {
      return undefined;
    }

    return [{
      ...buildAsyncFlowAccess({
        accessType: 'signal',
        asyncKind: 'abort',
        asyncPhase: 'abort',
        resourceSubkind: 'abort-signal',
        resourceName: `${receiverText}.getThreadSignal(${threadIdText})`,
        resourceSemanticId: 'abort:thread',
      }),
      signalKind: 'abort',
      sourceResourceName: receiverText,
      sourceResourceSubkind: 'abort-controller',
      abortScope: 'thread',
      reasonText: expression.arguments[1]?.getText(deps.sourceFile),
    }];
  }

  return undefined;
}

export function buildAsyncCallSemanticPayload(
  deps: AsyncSemanticDependencies,
  expression: ts.CallExpression | ts.NewExpression,
) {
  const abortExpressionAccesses = collectAbortAsyncAccessesForExpression(deps, expression);
  if (!ts.isCallExpression(expression)) {
    return abortExpressionAccesses;
  }

  const callee = expression.expression;
  const identifierCalleeName = ts.isIdentifier(callee) ? callee.text : undefined;
  if (!ts.isPropertyAccessExpression(callee) && !identifierCalleeName) {
    return abortExpressionAccesses;
  }

  const methodName = ts.isPropertyAccessExpression(callee)
    ? deps.getPropertyNameText(callee.name)
    : identifierCalleeName;
  if (!methodName) {
    return abortExpressionAccesses;
  }

  if (
    ts.isPropertyAccessExpression(callee)
    && (methodName === 'resolve' || methodName === 'reject')
    && isDeferredLikeExpression(deps, callee.expression)
  ) {
    return [
      ...(abortExpressionAccesses || []),
      buildAsyncDeferredSignalAccess(deps, callee.expression, methodName),
    ];
  }

  const abortTriggerAccesses = collectAbortTriggerCallAccesses(deps, expression);
  if (abortTriggerAccesses?.length) {
    return [...(abortExpressionAccesses || []), ...abortTriggerAccesses];
  }

  const abortSignalArgumentAccesses = collectAbortSignalArgumentAccesses(deps, expression);

  if (methodName === 'setTimeout' || methodName === 'setInterval') {
    const [handlerArg] = expression.arguments;
    const resourceName = expression.getText(deps.sourceFile);
    const asyncKind = methodName === 'setTimeout' ? 'timeout' : 'interval';
    const accesses: Record<string, unknown>[] = [{
      accessType: 'schedule',
      asyncKind,
      asyncPhase: 'schedule',
      resourceKind: 'async-flow',
      resourceSubkind: asyncKind,
      resourceName,
      resourceSemanticId: deps.deriveTimeoutResourceSemanticId(resourceName),
    }];

    if (handlerArg) {
      accesses.push(...collectAsyncHandlerSignalAccesses(deps, handlerArg, resourceName, asyncKind));
    }

    return accesses;
  }

  if (methodName === 'clearTimeout' || methodName === 'clearInterval') {
    const [timerArg] = expression.arguments;
    if (!timerArg) {
      return undefined;
    }

    const resourceName = timerArg.getText(deps.sourceFile);

    return [{
      ...buildAsyncFlowAccess({
        accessType: 'cancel',
        asyncKind: methodName === 'clearTimeout' ? 'timeout' : 'interval',
        asyncPhase: 'cancel',
        resourceSubkind: methodName === 'clearTimeout' ? 'timeout-handle' : 'interval-handle',
        resourceName,
        resourceSemanticId: deps.deriveTimeoutResourceSemanticId(resourceName),
      }),
    }];
  }

  const promiseCombinatorKind = deps.getPromiseCombinatorKind(expression);
  if (promiseCombinatorKind) {
    return buildPromiseCombinatorAsyncAccessPayload(deps, expression, promiseCombinatorKind);
  }

  if (methodName === 'addEventListener') {
    const [eventArg, handlerArg] = expression.arguments;
    const receiverText = ts.isPropertyAccessExpression(callee)
      ? callee.expression.getText(deps.sourceFile)
      : undefined;
    const eventName = eventArg && ts.isStringLiteralLike(eventArg)
      ? eventArg.text
      : eventArg?.getText(deps.sourceFile);
    if (!receiverText || !eventName) {
      return undefined;
    }

    const eventResourceName = `${receiverText}.${eventName}`;
    const accesses: Record<string, unknown>[] = [{
      accessType: 'subscribe',
      asyncKind: 'event',
      asyncPhase: 'subscribe',
      eventName,
      resourceKind: 'async-flow',
      resourceSubkind: 'dom-event',
      resourceName: eventResourceName,
    }];

    if (handlerArg) {
      accesses.push(...collectAsyncHandlerSignalAccesses(deps, handlerArg, eventResourceName, 'event'));
    }

    return accesses;
  }

  if (abortSignalArgumentAccesses?.length) {
    return [...(abortExpressionAccesses || []), ...abortSignalArgumentAccesses];
  }

  if (methodName !== 'then' && methodName !== 'catch' && methodName !== 'finally') {
    return abortExpressionAccesses;
  }

  const promiseExpression = ts.isPropertyAccessExpression(callee) ? callee.expression : undefined;
  if (!promiseExpression || !isPromiseLikeExpression(deps, promiseExpression)) {
    return undefined;
  }

  const { promiseResourceName, promiseResources, triggerResourceNames } = buildPromiseTriggerResourceNames(deps, promiseExpression);
  if (!promiseResourceName && !promiseResources?.length) {
    return undefined;
  }

  const accesses: Record<string, unknown>[] = (promiseResources?.length ? promiseResources : [deps.buildPromiseResourceDescriptor(
    promiseResourceName,
    'promise',
  )]).map((resource) => ({
    accessType: 'subscribe',
    asyncKind: 'promise',
    asyncPhase: methodName,
    ...resource,
    continuationKind: methodName,
  }));
  const handlerArguments = methodName === 'then'
    ? expression.arguments.slice(0, 2)
    : expression.arguments.slice(0, 1);

  for (const handlerArg of handlerArguments) {
    if (!handlerArg) {
      continue;
    }

    for (const triggerResourceName of triggerResourceNames) {
      accesses.push(...collectAsyncHandlerSignalAccesses(deps, handlerArg, triggerResourceName, 'promise'));
    }
  }

  return accesses.length ? accesses : undefined;
}

export function buildAsyncDeclarationSemantic(
  deps: AsyncSemanticDependencies,
  statement: ts.VariableStatement,
) {
  if (statement.declarationList.declarations.length !== 1) {
    return undefined;
  }

  const declaration = statement.declarationList.declarations[0];
  if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
    return undefined;
  }

  const initializer = deps.unwrapExpression(declaration.initializer);
  const expressionSemantic = (ts.isCallExpression(initializer) || ts.isNewExpression(initializer))
    ? buildAsyncCallSemantic(deps, initializer)
    : buildAsyncExpressionSemantic(deps, initializer);
  const abortExpressionSemantic = (!ts.isCallExpression(initializer) && !ts.isNewExpression(initializer))
    ? collectAbortAsyncAccessesForExpression(deps, initializer)
    : undefined;
  const combinedExpressionSemantic = [
    ...(expressionSemantic || []),
    ...(abortExpressionSemantic || []),
  ];
  if (!ts.isNewExpression(initializer)) {
    if ((ts.isCallExpression(initializer) || ts.isNewExpression(initializer)) && isPromiseTypeText(getNodeTypeText(deps, initializer))) {
      return [
        buildAsyncFlowAccess({
          accessType: 'create',
          asyncKind: 'promise',
          asyncPhase: 'create',
          resourceSubkind: 'promise',
          resourceName: declaration.name.text,
          resourceSemanticId: `promise:${declaration.name.text}`,
          resourceSemanticDetailId: 'result',
        }),
        ...combinedExpressionSemantic,
      ];
    }

    return combinedExpressionSemantic.length ? combinedExpressionSemantic : undefined;
  }

  const isDeferredConstructor = (ts.isIdentifier(initializer.expression) && initializer.expression.text === 'Deferred')
    || isDeferredLikeExpression(deps, initializer);
  if (!isDeferredConstructor) {
    return combinedExpressionSemantic.length ? combinedExpressionSemantic : undefined;
  }

  return [{
    ...buildAsyncFlowAccess({
      accessType: 'create',
      asyncKind: 'deferred',
      asyncPhase: 'create',
      resourceSubkind: 'deferred',
      resourceName: declaration.name.text,
      resourceSemanticId: 'deferred',
      resourceSemanticDetailId: 'deferred:create',
    }),
  }, ...combinedExpressionSemantic];
}

export function buildAsyncAssignmentSemantic(
  deps: AsyncSemanticDependencies,
  expression: ts.BinaryExpression,
) {
  const right = deps.unwrapExpression(expression.right);
  const expressionSemantic = (ts.isCallExpression(right) || ts.isNewExpression(right))
    ? buildAsyncCallSemantic(deps, right)
    : buildAsyncExpressionSemantic(deps, right);
  const abortExpressionSemantic = (!ts.isCallExpression(right) && !ts.isNewExpression(right))
    ? collectAbortAsyncAccessesForExpression(deps, right)
    : undefined;
  const combinedExpressionSemantic = [
    ...(expressionSemantic || []),
    ...(abortExpressionSemantic || []),
  ];
  if (!ts.isArrowFunction(right) && !ts.isFunctionExpression(right)) {
    return combinedExpressionSemantic.length ? combinedExpressionSemantic : undefined;
  }

  if (!ts.isPropertyAccessExpression(expression.left)) {
    return combinedExpressionSemantic.length ? combinedExpressionSemantic : undefined;
  }

  const propertyName = deps.getPropertyNameText(expression.left.name);
  if (!propertyName.startsWith('on')) {
    return combinedExpressionSemantic.length ? combinedExpressionSemantic : undefined;
  }

  const eventName = propertyName.slice(2) || propertyName;
  const eventResourceName = expression.left.getText(deps.sourceFile);
  const accesses: Record<string, unknown>[] = [{
    accessType: 'subscribe',
    asyncKind: 'event',
    asyncPhase: 'subscribe',
    eventName,
    resourceKind: 'async-flow',
    resourceSubkind: 'dom-event',
    resourceName: eventResourceName,
  }];

  accesses.push(...collectAsyncHandlerSignalAccesses(deps, right, eventResourceName, 'event'));

  const combinedAccesses = [...accesses, ...combinedExpressionSemantic];
  return combinedAccesses.length ? combinedAccesses : undefined;
}

export function buildAsyncCallSemantic(
  deps: AsyncSemanticDependencies,
  expression: ts.CallExpression | ts.NewExpression,
) {
  return buildAsyncCallSemanticPayload(deps, expression);
}

export function buildAsyncExpressionSemantic(
  deps: AsyncSemanticDependencies,
  expression: ts.Expression,
) {
  if (!ts.isAwaitExpression(expression)) {
    return undefined;
  }

  const awaited = deps.unwrapExpression(expression.expression);
  if (ts.isCallExpression(awaited)) {
    const promiseCombinatorKind = deps.getPromiseCombinatorKind(awaited);
    if (promiseCombinatorKind) {
      return [{
        ...buildAsyncFlowAccess({
          accessType: 'wait',
          asyncKind: 'promise-combinator',
          asyncPhase: 'await',
          resourceSubkind: 'promise-combinator',
          resourceName: awaited.getText(deps.sourceFile),
        }),
        combinatorKind: promiseCombinatorKind,
      }];
    }

    // A direct awaited invocation is already represented by its call node and
    // the surrounding Async:Boundary. Do not materialize the same expression
    // again as a terminal promise resource.
    return undefined;
  }

  if (!ts.isPropertyAccessExpression(awaited)) {
    const promiseResources = deps.collectPromiseResourceDescriptors(deps.checker, deps.sourceFile, awaited);
    if (!promiseResources?.length) {
      return undefined;
    }

    return promiseResources.map((resource) => ({
      accessType: 'wait',
      asyncKind: 'promise',
      asyncPhase: 'await',
      resourceKind: 'async-flow',
      resourceSubkind: resource.resourceSubkind,
      resourceName: resource.resourceName,
    }));
  }

  const propertyName = deps.getPropertyNameText(awaited.name);
  if (propertyName !== 'promise' || !isDeferredLikeExpression(deps, awaited.expression)) {
    return undefined;
  }

  return [{
    ...buildAsyncFlowAccess({
      accessType: 'wait',
      asyncKind: 'deferred',
      asyncPhase: 'await',
      resourceSubkind: 'deferred',
      resourceName: awaited.expression.getText(deps.sourceFile),
      resourceSemanticId: 'deferred',
      resourceSemanticDetailId: 'deferred:await',
    }),
    awaitedMember: propertyName,
  }];
}
