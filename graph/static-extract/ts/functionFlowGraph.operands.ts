import path from 'node:path';

import ts from 'typescript';

import { getRepoRelativePath, toPosix } from './functionFlowGraph.infrastructure.js';

type OperandBuildDependencies = {
  unwrapExpression: (expression: ts.Expression) => ts.Expression;
  getPropertyNameText: (name: ts.PropertyName | ts.MemberName) => string;
  collectCallExpressions: (node: ts.Node) => ts.CallExpression[];
  shortenLabel: (text: string, maxLength?: number) => string;
  buildAsyncCallSemanticPayload: (
    checker: ts.TypeChecker | undefined,
    sourceFile: ts.SourceFile,
    expression: ts.CallExpression | ts.NewExpression,
  ) => Record<string, unknown>[] | undefined;
};

export function getDeclarationSourceFileInfo(declaration: ts.Declaration | undefined) {
  if (!declaration) {
    return undefined;
  }

  const sourceFile = declaration.getSourceFile();
  const filePath = toPosix(path.resolve(sourceFile.fileName));
  const isTypeLib = /(?:^|\/)node_modules\/typescript\/lib\//.test(filePath)
    || /(?:^|\/)typescript\/lib\//.test(filePath)
    || /\/lib\.(?:dom|webworker|es\d+|scripthost)\.d\.ts$/.test(filePath);

  return {
    filePath,
    repoRelativePath: getRepoRelativePath(sourceFile.fileName),
    isTypeLib,
  };
}

export function getNodeTypeTextForChecker(checker: ts.TypeChecker | undefined, node: ts.Node | undefined) {
  if (!checker || !node) {
    return undefined;
  }

  return checker.typeToString(checker.getTypeAtLocation(node));
}

function buildSymbolSemanticForChecker(checker: ts.TypeChecker | undefined, node: ts.Node | undefined) {
  if (!checker || !node) {
    return undefined;
  }

  const symbol = checker.getSymbolAtLocation(node);
  const declaration = symbol?.valueDeclaration || symbol?.declarations?.[0];
  const declarationSource = getDeclarationSourceFileInfo(declaration);

  return {
    symbolName: symbol?.getName(),
    typeText: getNodeTypeTextForChecker(checker, node),
    declarationFilePath: declarationSource?.filePath,
    declarationRepoRelativePath: declarationSource?.repoRelativePath,
    declarationIsTypeLib: declarationSource?.isTypeLib,
  };
}

function buildCallSemanticPayload(
  checker: ts.TypeChecker | undefined,
  sourceFile: ts.SourceFile,
  expression: ts.CallExpression | ts.NewExpression,
  deps: OperandBuildDependencies,
) {
  if (!checker) {
    return undefined;
  }

  const calleeNode = expression.expression;
  const signature = checker.getResolvedSignature(expression as ts.CallLikeExpression);
  const signatureDeclaration = signature?.declaration;
  const signatureSource = getDeclarationSourceFileInfo(signatureDeclaration);
  const receiverNode = ts.isPropertyAccessExpression(calleeNode) || ts.isElementAccessExpression(calleeNode)
    ? calleeNode.expression
    : undefined;
  const methodName = ts.isPropertyAccessExpression(calleeNode)
    ? deps.getPropertyNameText(calleeNode.name)
    : ts.isElementAccessExpression(calleeNode)
      ? calleeNode.argumentExpression?.getText(sourceFile)
      : ts.isIdentifier(calleeNode)
        ? calleeNode.text
        : undefined;
  const signatureName = signatureDeclaration && 'name' in signatureDeclaration && signatureDeclaration.name
    ? deps.getPropertyNameText(signatureDeclaration.name as ts.PropertyName)
    : undefined;
  const receiverBaseNode = receiverNode ? deps.unwrapExpression(receiverNode) : undefined;

  return {
    callKind: ts.isNewExpression(expression) ? 'new' : 'call',
    calleeText: calleeNode.getText(sourceFile),
    calleeTypeText: getNodeTypeTextForChecker(checker, calleeNode),
    methodName,
    receiverText: receiverNode?.getText(sourceFile),
    receiverBaseText: receiverBaseNode?.getText(sourceFile),
    receiverKind: receiverNode ? ts.SyntaxKind[receiverNode.kind] : undefined,
    receiverTypeText: getNodeTypeTextForChecker(checker, receiverNode),
    receiverSymbol: receiverNode ? buildSymbolSemanticForChecker(checker, receiverNode) : undefined,
    signatureDeclarationFilePath: signatureSource?.filePath,
    signatureDeclarationRepoRelativePath: signatureSource?.repoRelativePath,
    signatureDeclarationIsTypeLib: signatureSource?.isTypeLib,
    signatureName,
    returnTypeText: getNodeTypeTextForChecker(checker, expression),
  };
}

function buildFunctionLikeOperand(
  node: ts.FunctionLikeDeclaration,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker | undefined,
  deps: OperandBuildDependencies,
): Record<string, unknown> {
  const parameters = node.parameters.map((parameter) => ({
    text: parameter.getText(sourceFile),
    nameText: parameter.name.getText(sourceFile),
    isRest: Boolean(parameter.dotDotDotToken),
    isOptional: Boolean(parameter.questionToken),
    initializer: buildOperationOperand(parameter.initializer, sourceFile, checker, deps),
  }));
  const nestedCalls = node.body
    ? deps.collectCallExpressions(node.body)
      .map((callExpression) => buildOperationOperand(callExpression, sourceFile, checker, deps))
      .filter(Boolean)
    : undefined;

  return {
    kind: 'function-like',
    text: node.getText(sourceFile),
    functionKind: ts.isArrowFunction(node)
      ? 'arrow-function'
      : ts.isFunctionExpression(node)
        ? 'function-expression'
        : ts.isMethodDeclaration(node)
          ? 'method'
          : ts.isGetAccessorDeclaration(node)
            ? 'get-accessor'
            : ts.isSetAccessorDeclaration(node)
              ? 'set-accessor'
              : ts.isFunctionDeclaration(node)
                ? 'function-declaration'
                : ts.isConstructorDeclaration(node)
                  ? 'constructor'
                  : 'function-like',
    name: 'name' in node && node.name ? deps.getPropertyNameText(node.name) : undefined,
    isAsync: Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)),
    isGenerator: 'asteriskToken' in node ? Boolean(node.asteriskToken) : undefined,
    parameters,
    bodyKind: !node.body ? undefined : ts.isBlock(node.body) ? 'block' : 'expression',
    bodyText: node.body && ts.isBlock(node.body) ? deps.shortenLabel(node.body.getText(sourceFile), 160) : undefined,
    expressionBody: node.body && ts.isExpression(node.body) ? buildOperationOperand(node.body, sourceFile, checker, deps) : undefined,
    nestedCalls,
  };
}

function buildObjectLiteralPropertyOperand(
  property: ts.ObjectLiteralElementLike,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker | undefined,
  deps: OperandBuildDependencies,
): Record<string, unknown> {
  if (ts.isPropertyAssignment(property)) {
    return {
      kind: 'object-property',
      text: property.getText(sourceFile),
      propertyName: deps.getPropertyNameText(property.name),
      value: buildOperationOperand(property.initializer, sourceFile, checker, deps),
    };
  }

  if (ts.isShorthandPropertyAssignment(property)) {
    return {
      kind: 'object-property',
      text: property.getText(sourceFile),
      propertyName: property.name.text,
      value: buildOperationOperand(property.name, sourceFile, checker, deps),
      isShorthand: true,
    };
  }

  if (ts.isSpreadAssignment(property)) {
    return {
      kind: 'object-spread',
      text: property.getText(sourceFile),
      value: buildOperationOperand(property.expression, sourceFile, checker, deps),
    };
  }

  if (ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
    return {
      kind: 'object-member',
      text: property.getText(sourceFile),
      propertyName: deps.getPropertyNameText(property.name),
      memberKind: ts.SyntaxKind[property.kind],
      value: buildFunctionLikeOperand(property, sourceFile, checker, deps),
    };
  }

  return {
    kind: 'object-member',
    text: property.getText(sourceFile),
    syntaxKind: ts.SyntaxKind[property.kind],
  };
}

function buildArrayLiteralElementOperand(
  element: ts.Expression | ts.SpreadElement,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker | undefined,
  deps: OperandBuildDependencies,
): Record<string, unknown> {
  if (ts.isSpreadElement(element)) {
    return {
      kind: 'array-spread',
      text: element.getText(sourceFile),
      value: buildOperationOperand(element.expression, sourceFile, checker, deps),
    };
  }

  return buildOperationOperand(element, sourceFile, checker, deps) || {
    kind: 'expression',
    text: element.getText(sourceFile),
    syntaxKind: ts.SyntaxKind[element.kind],
  };
}

export function buildOperationOperand(
  node: ts.Node | undefined,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker | undefined,
  deps: OperandBuildDependencies,
): Record<string, unknown> | undefined {
  if (!node) {
    return undefined;
  }

  if (!ts.isExpression(node)) {
    return {
      kind: 'node',
      text: node.getText(sourceFile),
      syntaxKind: ts.SyntaxKind[node.kind],
    };
  }

  if (ts.isSatisfiesExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    const operand = buildOperationOperand(node.expression, sourceFile, checker, deps);
    const semantic = operand?.semantic && typeof operand.semantic === 'object'
      ? { ...(operand.semantic as Record<string, unknown>) }
      : {};
    semantic.assertedTypeText = node.type.getText(sourceFile);
    if (checker) {
      semantic.assertedResolvedTypeText = getNodeTypeTextForChecker(checker, node.type);
    }

    return {
      ...(operand || {
        kind: 'expression',
        text: node.expression.getText(sourceFile),
        syntaxKind: ts.SyntaxKind[node.expression.kind],
      }),
      text: node.getText(sourceFile),
      semantic,
    };
  }

  const expression = deps.unwrapExpression(node);
  const text = expression.getText(sourceFile);

  if (ts.isIdentifier(expression)) {
    return {
      kind: expression.text === 'undefined' ? 'undefined' : 'identifier',
      text,
      name: expression.text,
      semantic: checker ? {
        symbol: buildSymbolSemanticForChecker(checker, expression),
      } : undefined,
    };
  }

  if (expression.kind === ts.SyntaxKind.ThisKeyword) {
    return {
      kind: 'this',
      text,
    };
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return {
      kind: 'property-access',
      text,
      object: buildOperationOperand(expression.expression, sourceFile, checker, deps),
      propertyName: deps.getPropertyNameText(expression.name),
      semantic: checker ? {
        symbol: buildSymbolSemanticForChecker(checker, expression),
      } : undefined,
    };
  }

  if (ts.isElementAccessExpression(expression)) {
    return {
      kind: 'element-access',
      text,
      object: buildOperationOperand(expression.expression, sourceFile, checker, deps),
      index: buildOperationOperand(expression.argumentExpression, sourceFile, checker, deps),
      semantic: checker ? {
        symbol: buildSymbolSemanticForChecker(checker, expression),
      } : undefined,
    };
  }

  if (ts.isCallExpression(expression)) {
    const asyncSemantic = deps.buildAsyncCallSemanticPayload(checker, sourceFile, expression);
    return {
      kind: 'call',
      text,
      callee: buildOperationOperand(expression.expression, sourceFile, checker, deps),
      arguments: expression.arguments.map((argument) => buildOperationOperand(argument, sourceFile, checker, deps)),
      semantic: checker ? {
        call: buildCallSemanticPayload(checker, sourceFile, expression, deps),
        async: asyncSemantic,
      } : undefined,
    };
  }

  if (ts.isNewExpression(expression)) {
    const asyncSemantic = deps.buildAsyncCallSemanticPayload(checker, sourceFile, expression);
    return {
      kind: 'new',
      text,
      callee: buildOperationOperand(expression.expression, sourceFile, checker, deps),
      arguments: (expression.arguments || []).map((argument) => buildOperationOperand(argument, sourceFile, checker, deps)),
      semantic: checker ? {
        call: buildCallSemanticPayload(checker, sourceFile, expression, deps),
        async: asyncSemantic,
      } : undefined,
    };
  }

  if (ts.isTaggedTemplateExpression(expression)) {
    return {
      kind: 'tagged-template',
      text,
      tag: buildOperationOperand(expression.tag, sourceFile, checker, deps),
      template: buildOperationOperand(expression.template, sourceFile, checker, deps),
    };
  }

  if (ts.isTemplateExpression(expression)) {
    return {
      kind: 'template-literal',
      text,
      headText: expression.head.text,
      spans: expression.templateSpans.map((span) => ({
        expression: buildOperationOperand(span.expression, sourceFile, checker, deps),
        literalText: span.literal.text,
      })),
    };
  }

  if (ts.isFunctionExpression(expression) || ts.isArrowFunction(expression)) {
    return buildFunctionLikeOperand(expression, sourceFile, checker, deps);
  }

  if (ts.isObjectLiteralExpression(expression)) {
    return {
      kind: 'object-literal',
      text,
      propertyCount: expression.properties.length,
      properties: expression.properties.map((property) => buildObjectLiteralPropertyOperand(property, sourceFile, checker, deps)),
    };
  }

  if (ts.isArrayLiteralExpression(expression)) {
    return {
      kind: 'array-literal',
      text,
      elementCount: expression.elements.length,
      elements: expression.elements.map((element) => buildArrayLiteralElementOperand(element, sourceFile, checker, deps)),
    };
  }

  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return {
      kind: 'literal',
      text,
      literalKind: 'string',
    };
  }

  if (ts.isNumericLiteral(expression)) {
    return {
      kind: 'literal',
      text,
      literalKind: 'number',
    };
  }

  if (ts.isBigIntLiteral(expression)) {
    return {
      kind: 'literal',
      text,
      literalKind: 'bigint',
    };
  }

  if (expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword) {
    return {
      kind: 'literal',
      text,
      literalKind: 'boolean',
    };
  }

  if (expression.kind === ts.SyntaxKind.NullKeyword) {
    return {
      kind: 'literal',
      text,
      literalKind: 'null',
    };
  }

  if (ts.isBinaryExpression(expression)) {
    return {
      kind: 'binary-expression',
      text,
      operator: ts.tokenToString(expression.operatorToken.kind) || ts.SyntaxKind[expression.operatorToken.kind],
      left: buildOperationOperand(expression.left, sourceFile, checker, deps),
      right: buildOperationOperand(expression.right, sourceFile, checker, deps),
    };
  }

  if (ts.isConditionalExpression(expression)) {
    return {
      kind: 'conditional-expression',
      text,
      condition: buildOperationOperand(expression.condition, sourceFile, checker, deps),
      whenTrue: buildOperationOperand(expression.whenTrue, sourceFile, checker, deps),
      whenFalse: buildOperationOperand(expression.whenFalse, sourceFile, checker, deps),
    };
  }

  if (ts.isPrefixUnaryExpression(expression) || ts.isPostfixUnaryExpression(expression)) {
    return {
      kind: 'unary-expression',
      text,
      operator: ts.tokenToString(expression.operator) || ts.SyntaxKind[expression.operator],
      operand: buildOperationOperand(expression.operand, sourceFile, checker, deps),
    };
  }

  if (ts.isAwaitExpression(expression)) {
    return {
      kind: 'await-expression',
      text,
      value: buildOperationOperand(expression.expression, sourceFile, checker, deps),
    };
  }

  return {
    kind: 'expression',
    text,
    syntaxKind: ts.SyntaxKind[expression.kind],
  };
}

export function buildStatementValueOperand(
  node: ts.Node | undefined,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker | undefined,
  deps: OperandBuildDependencies,
) {
  const operand = buildOperationOperand(node, sourceFile, checker, deps);
  if (!operand) {
    return undefined;
  }

  const stripRootCallSemantic = (value: Record<string, unknown>): Record<string, unknown> => {
    if (value.kind === 'call' || value.kind === 'new') {
      if (!value.semantic || typeof value.semantic !== 'object') {
        return value;
      }

      const nextSemantic = { ...(value.semantic as Record<string, unknown>) };
      delete nextSemantic.call;

      return {
        ...value,
        semantic: Object.keys(nextSemantic).length ? nextSemantic : undefined,
      };
    }

    if (value.kind === 'await-expression' && value.value && typeof value.value === 'object') {
      return {
        ...value,
        value: stripRootCallSemantic(value.value as Record<string, unknown>),
      };
    }

    return value;
  };

  return stripRootCallSemantic(operand);
}
