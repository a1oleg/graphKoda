import ts from 'typescript';

import {
  getDeclarationSourceFileInfo,
  getNodeTypeTextForChecker,
} from './functionFlowGraph.operands.js';
import { mergeOperationDetailJson } from './functionFlowGraph.operationFields.js';

type FlowNodeKind = 'Eval' | 'Branch' | 'ArgBranch' | 'FieldBranch' | 'OperandBranch' | 'Loop' | 'Iteration' | 'Switch' | 'Case' | 'Action' | 'Read' | 'Call' | 'Op' | 'Value' | 'DataJoin' | 'Arg' | 'ArgJoin' | 'Object' | 'ObjectBrace' | 'Field' | 'FieldJoin' | 'FlowJoin' | 'BreakStop' | 'ThrowStop' | 'Return' | 'FunctionEnd';

type SemanticOperationDependencies = {
  checker: ts.TypeChecker;
  sourceFile: ts.SourceFile;
  unwrapExpression: (expression: ts.Expression) => ts.Expression;
  getPropertyNameText: (name: ts.PropertyName | ts.MemberName) => string;
  isSimpleAssignmentExpression: (expression: ts.Expression) => expression is ts.BinaryExpression;
  buildAsyncDeclarationSemantic: (statement: ts.VariableStatement) => unknown;
  buildAsyncAssignmentSemantic: (expression: ts.BinaryExpression) => unknown;
  buildAsyncCallSemantic: (expression: ts.CallExpression | ts.NewExpression) => unknown;
  buildAsyncExpressionSemantic: (expression: ts.Expression) => unknown;
};

type OperationFieldSubset = {
  operationDetailJson?: string;
};

function getNodeTypeText(checker: ts.TypeChecker, node: ts.Node | undefined) {
  return getNodeTypeTextForChecker(checker, node);
}

function buildSymbolSemantic(
  checker: ts.TypeChecker,
  node: ts.Node | undefined,
) {
  if (!node) {
    return undefined;
  }

  const symbol = checker.getSymbolAtLocation(node);
  const declaration = symbol?.valueDeclaration || symbol?.declarations?.[0];
  const declarationSource = getDeclarationSourceFileInfo(declaration);

  return {
    symbolName: symbol?.getName(),
    typeText: getNodeTypeText(checker, node),
    declarationFilePath: declarationSource?.filePath,
    declarationRepoRelativePath: declarationSource?.repoRelativePath,
    declarationIsTypeLib: declarationSource?.isTypeLib,
  };
}

function buildCallSemantic(
  deps: SemanticOperationDependencies,
  expression: ts.CallExpression | ts.NewExpression,
) {
  const { checker, sourceFile, getPropertyNameText } = deps;
  const calleeNode = expression.expression;
  const signature = checker.getResolvedSignature(expression as ts.CallLikeExpression);
  const signatureDeclaration = signature?.declaration;
  const signatureSource = getDeclarationSourceFileInfo(signatureDeclaration);
  const receiverNode = ts.isPropertyAccessExpression(calleeNode) || ts.isElementAccessExpression(calleeNode)
    ? calleeNode.expression
    : undefined;
  const methodName = ts.isPropertyAccessExpression(calleeNode)
    ? getPropertyNameText(calleeNode.name)
    : ts.isElementAccessExpression(calleeNode)
      ? calleeNode.argumentExpression?.getText(sourceFile)
      : ts.isIdentifier(calleeNode)
        ? calleeNode.text
        : undefined;
  const signatureName = signatureDeclaration && 'name' in signatureDeclaration && signatureDeclaration.name
    ? getPropertyNameText(signatureDeclaration.name as ts.PropertyName)
    : undefined;
  const calleeText = calleeNode.getText(sourceFile);

  return {
    callKind: ts.isNewExpression(expression) ? 'new' : 'call',
    calleeText,
    calleeTypeText: getNodeTypeText(checker, calleeNode),
    methodName,
    receiverText: receiverNode?.getText(sourceFile),
    receiverKind: receiverNode ? ts.SyntaxKind[receiverNode.kind] : undefined,
    receiverTypeText: getNodeTypeText(checker, receiverNode),
    receiverSymbol: receiverNode ? buildSymbolSemantic(checker, receiverNode) : undefined,
    signatureDeclarationFilePath: signatureSource?.filePath,
    signatureDeclarationRepoRelativePath: signatureSource?.repoRelativePath,
    signatureDeclarationIsTypeLib: signatureSource?.isTypeLib,
    signatureName,
    returnTypeText: getNodeTypeText(checker, expression),
  };
}

function buildAssignmentSemantic(
  deps: SemanticOperationDependencies,
  expression: ts.BinaryExpression,
) {
  const { checker, unwrapExpression } = deps;
  const right = unwrapExpression(expression.right);

  return {
    targetTypeText: getNodeTypeText(checker, expression.left),
    targetSymbol: buildSymbolSemantic(checker, expression.left),
    valueTypeText: getNodeTypeText(checker, right),
  };
}

function buildDeclarationSemantic(
  deps: SemanticOperationDependencies,
  statement: ts.VariableStatement,
) {
  if (statement.declarationList.declarations.length !== 1) {
    return undefined;
  }

  const { checker, unwrapExpression } = deps;
  const declaration = statement.declarationList.declarations[0];
  const initializer = declaration.initializer ? unwrapExpression(declaration.initializer) : undefined;

  return {
    targetTypeText: getNodeTypeText(checker, declaration.name),
    targetSymbol: buildSymbolSemantic(checker, declaration.name),
    valueTypeText: getNodeTypeText(checker, initializer),
  };
}

function mergeAsyncSemantics(
  primary: unknown,
  secondary: unknown,
) {
  const merged = [
    ...(Array.isArray(primary) ? primary : []),
    ...(Array.isArray(secondary) ? secondary : []),
  ];

  return merged.length ? merged : undefined;
}

export function buildSemanticOperationDetail(
  deps: SemanticOperationDependencies,
  kind: FlowNodeKind,
  node: ts.Node,
) {
  if (ts.isVariableStatement(node)) {
    const asyncSemantic = deps.buildAsyncDeclarationSemantic(node);
    return {
      declaration: buildDeclarationSemantic(deps, node),
      async: asyncSemantic,
    };
  }

  const rawExpression = ts.isExpressionStatement(node)
    ? node.expression
    : ts.isExpression(node)
      ? node
      : undefined;
  const expression = rawExpression
    ? deps.unwrapExpression(rawExpression)
      : undefined;
  if (!expression) {
    return undefined;
  }

  const expressionAsyncSemantic = rawExpression
    ? deps.buildAsyncExpressionSemantic(rawExpression)
    : undefined;

  if (ts.isCallExpression(expression) || ts.isNewExpression(expression)) {
    const asyncSemantic = mergeAsyncSemantics(
      deps.buildAsyncCallSemantic(expression),
      expressionAsyncSemantic,
    );
    return {
      call: buildCallSemantic(deps, expression),
      async: asyncSemantic,
    };
  }

  if (deps.isSimpleAssignmentExpression(expression)) {
    const asyncSemantic = deps.buildAsyncAssignmentSemantic(expression);
    return {
      assignment: buildAssignmentSemantic(deps, expression),
      async: asyncSemantic,
    };
  }

  const asyncSemantic = expressionAsyncSemantic;
  if (asyncSemantic) {
    return {
      async: asyncSemantic,
    };
  }

  if (kind === 'Branch' || kind === 'ArgBranch' || kind === 'FieldBranch' || kind === 'OperandBranch' || kind === 'Loop' || kind === 'Switch' || kind === 'Case') {
    return {
      condition: {
        typeText: getNodeTypeText(deps.checker, expression),
      },
    };
  }

  return undefined;
}

export function mergeSemanticOperationDetail(
  operationFields: OperationFieldSubset,
  deps: SemanticOperationDependencies,
  kind: FlowNodeKind,
  node: ts.Node,
) {
  return {
    ...operationFields,
    operationDetailJson: mergeOperationDetailJson(
      operationFields.operationDetailJson,
      buildSemanticOperationDetail(deps, kind, node),
    ),
  };
}
