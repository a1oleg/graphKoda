import ts from 'typescript';

type FlowNodeKind = 'Eval' | 'Branch' | 'ArgBranch' | 'FieldBranch' | 'OperandBranch' | 'Loop' | 'Iteration' | 'Switch' | 'Case' | 'Action' | 'Read' | 'Call' | 'Op' | 'Value' | 'DataJoin' | 'Arg' | 'ArgJoin' | 'Object' | 'ObjectBrace' | 'Field' | 'FieldJoin' | 'FlowJoin' | 'BreakStop' | 'ThrowStop' | 'Return' | 'FunctionEnd';

type FlowNodeRowSubset = {
  stableId?: string;
  label?: string;
  conditionRaw?: string;
  actionTextRaw?: string;
  operationCode?: string;
  operationSubjectText?: string;
  operationValueText?: string;
  operationCalleeText?: string;
  operationDetailJson?: string;
};

type OperationFieldDependencies = {
  unwrapExpression: (expression: ts.Expression) => ts.Expression;
  buildOperationOperand: (node: ts.Node | undefined, sourceFile: ts.SourceFile, checker?: ts.TypeChecker) => Record<string, unknown> | undefined;
  buildStatementValueOperand: (node: ts.Node | undefined, sourceFile: ts.SourceFile, checker?: ts.TypeChecker) => Record<string, unknown> | undefined;
};

function isSimpleAssignmentExpression(expression: ts.Expression): expression is ts.BinaryExpression {
  return ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken;
}

export function buildOperationDetail(payload: Record<string, unknown>) {
  const filteredEntries = Object.entries(payload).filter(([, value]) => value !== undefined);
  if (!filteredEntries.length) {
    return undefined;
  }

  return JSON.stringify(Object.fromEntries(filteredEntries));
}

export function mergeOperationDetailJson(existingJson: string | undefined, extraPayload: Record<string, unknown> | undefined) {
  if (!extraPayload) {
    return existingJson;
  }

  const filteredExtraEntries = Object.entries(extraPayload).filter(([, value]) => value !== undefined);
  if (!filteredExtraEntries.length) {
    return existingJson;
  }

  const basePayload = existingJson ? JSON.parse(existingJson) as Record<string, unknown> : {};
  const existingSemantic = typeof basePayload.semantic === 'object' && basePayload.semantic
    ? basePayload.semantic as Record<string, unknown>
    : {};

  return buildOperationDetail({
    ...basePayload,
    semantic: {
      ...existingSemantic,
      ...Object.fromEntries(filteredExtraEntries),
    },
  });
}

export function buildOperationFields(
  kind: FlowNodeKind,
  node: ts.Node,
  sourceFile: ts.SourceFile,
  extra: Partial<FlowNodeRowSubset>,
  checker: ts.TypeChecker | undefined,
  deps: OperationFieldDependencies,
): Partial<FlowNodeRowSubset> {
  if (kind === 'Eval') {
    return {
      operationCode: 'EVAL',
      operationSubjectText: extra.conditionRaw,
      operationDetailJson: buildOperationDetail({
        conditionRaw: extra.conditionRaw,
      }),
    };
  }

  if (kind === 'Branch' || kind === 'ArgBranch' || kind === 'FieldBranch' || kind === 'OperandBranch') {
    return {
      operationCode: 'BRANCH',
      operationSubjectText: extra.conditionRaw,
      operationDetailJson: buildOperationDetail({
        branchLabel: extra.label,
        conditionRaw: extra.conditionRaw,
        condition: ts.isExpression(node) ? deps.buildOperationOperand(node, sourceFile, checker) : undefined,
      }),
    };
  }

  if (kind === 'Switch') {
    return {
      operationCode: 'SWITCH',
      operationSubjectText: extra.conditionRaw,
      operationDetailJson: buildOperationDetail({
        switchLabel: extra.label,
        conditionRaw: extra.conditionRaw,
        condition: ts.isExpression(node) ? deps.buildOperationOperand(node, sourceFile, checker) : undefined,
      }),
    };
  }

  if (kind === 'Case') {
    return {
      operationCode: 'CASE',
      operationSubjectText: extra.conditionRaw || extra.label,
      operationDetailJson: buildOperationDetail({
        caseLabel: extra.label,
        conditionRaw: extra.conditionRaw,
        condition: ts.isExpression(node) ? deps.buildOperationOperand(node, sourceFile, checker) : undefined,
      }),
    };
  }

  if (kind === 'FlowJoin') {
    return {
      operationCode: 'FLOW_JOIN',
      operationSubjectText: extra.label,
    };
  }

  if (kind === 'Loop') {
    return {
      operationCode: 'LOOP',
      operationSubjectText: extra.conditionRaw,
      operationDetailJson: buildOperationDetail({
        loopLabel: extra.label,
        conditionRaw: extra.conditionRaw,
        condition: ts.isExpression(node) ? deps.buildOperationOperand(node, sourceFile, checker) : undefined,
      }),
    };
  }

  if (kind === 'FunctionEnd') {
    return {
      operationCode: 'END',
    };
  }

  if (kind === 'Arg') {
    return {
      operationCode: 'ARG',
      operationValueText: extra.actionTextRaw,
      operationDetailJson: buildOperationDetail({
        argLabel: extra.label,
        valueText: extra.actionTextRaw,
        value: ts.isExpression(node) ? deps.buildOperationOperand(node, sourceFile, checker) : undefined,
      }),
    };
  }

  if (kind === 'ArgJoin') {
    return {
      operationCode: 'ARG_JOIN',
      operationValueText: extra.actionTextRaw,
    };
  }

  if (kind === 'Object') {
    return {
      operationCode: 'OBJECT',
      operationValueText: extra.actionTextRaw,
      operationDetailJson: buildOperationDetail({
        objectLabel: extra.label,
        valueText: extra.actionTextRaw,
      }),
    };
  }

  if (kind === 'Field') {
    return {
      operationCode: 'OBJECT_FIELD',
      operationSubjectText: extra.operationSubjectText || extra.label,
      operationValueText: extra.actionTextRaw,
      operationDetailJson: buildOperationDetail({
        fieldName: extra.operationSubjectText || extra.label,
        valueText: extra.actionTextRaw,
        value: ts.isExpression(node) ? deps.buildOperationOperand(node, sourceFile, checker) : undefined,
      }),
    };
  }

  if (kind === 'FieldJoin') {
    return {
      operationCode: 'FIELD_JOIN',
      operationValueText: extra.actionTextRaw,
    };
  }

  if (kind === 'ThrowStop') {
    return {
      operationCode: 'THROW',
      operationValueText: extra.actionTextRaw,
    };
  }

  if (kind === 'BreakStop') {
    return {
      operationCode: 'ACTION',
      operationSubjectText: extra.label || 'break',
    };
  }

  if (ts.isReturnStatement(node)) {
    const valueText = node.expression?.getText(sourceFile);
    return {
      operationCode: 'RETURN',
      operationValueText: valueText,
      operationDetailJson: buildOperationDetail({ valueText, value: deps.buildOperationOperand(node.expression, sourceFile, checker) }),
    };
  }

  if (ts.isThrowStatement(node)) {
    const valueText = node.expression?.getText(sourceFile);
    return {
      operationCode: 'THROW',
      operationValueText: valueText,
      operationDetailJson: buildOperationDetail({ valueText, value: deps.buildOperationOperand(node.expression, sourceFile, checker) }),
    };
  }

  if (ts.isVariableStatement(node)) {
    const declaration = node.declarationList.declarations.length === 1 ? node.declarationList.declarations[0] : undefined;
    const targetText = declaration?.name.getText(sourceFile);
    const valueText = declaration?.initializer?.getText(sourceFile);
    return {
      operationCode: declaration ? 'DECLARE' : 'ACTION',
      operationSubjectText: targetText,
      operationValueText: valueText,
      operationDetailJson: buildOperationDetail({
        declarationCount: node.declarationList.declarations.length,
        targetText,
        valueText,
        target: declaration ? deps.buildOperationOperand(declaration.name, sourceFile, checker) : undefined,
        value: declaration ? deps.buildStatementValueOperand(declaration.initializer, sourceFile, checker) : undefined,
      }),
    };
  }

  const expression = ts.isExpressionStatement(node)
    ? deps.unwrapExpression(node.expression)
    : ts.isExpression(node)
      ? deps.unwrapExpression(node)
      : undefined;

  if (!expression) {
    return {
      operationCode: 'ACTION',
      operationSubjectText: extra.actionTextRaw,
      operationDetailJson: buildOperationDetail({ subjectText: extra.actionTextRaw }),
    };
  }

  if (isSimpleAssignmentExpression(expression)) {
    const targetText = expression.left.getText(sourceFile);
    const valueText = expression.right.getText(sourceFile);
    return {
      operationCode: 'ASSIGN',
      operationSubjectText: targetText,
      operationValueText: valueText,
      operationDetailJson: buildOperationDetail({
        targetText,
        valueText,
        target: deps.buildOperationOperand(expression.left, sourceFile, checker),
        value: deps.buildStatementValueOperand(expression.right, sourceFile, checker),
      }),
    };
  }

  if (ts.isCallExpression(expression)) {
    const calleeText = expression.expression.getText(sourceFile);
    const argTexts = expression.arguments.map((argument) => argument.getText(sourceFile));
    return {
      operationCode: 'CALL',
      operationCalleeText: calleeText,
      operationValueText: argTexts.join(', '),
      operationDetailJson: buildOperationDetail({
        calleeText,
        argTexts,
        callee: deps.buildOperationOperand(expression.expression, sourceFile, checker),
        arguments: expression.arguments.map((argument) => deps.buildOperationOperand(argument, sourceFile, checker)),
      }),
    };
  }

  if (ts.isNewExpression(expression)) {
    const calleeText = expression.expression.getText(sourceFile);
    const argTexts = (expression.arguments || []).map((argument) => argument.getText(sourceFile));
    return {
      operationCode: 'NEW',
      operationCalleeText: calleeText,
      operationValueText: argTexts.join(', '),
      operationDetailJson: buildOperationDetail({
        calleeText,
        argTexts,
        callee: deps.buildOperationOperand(expression.expression, sourceFile, checker),
        arguments: (expression.arguments || []).map((argument) => deps.buildOperationOperand(argument, sourceFile, checker)),
      }),
    };
  }

  if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return {
      operationCode: 'READ',
      operationSubjectText: expression.getText(sourceFile),
      operationDetailJson: buildOperationDetail({ subject: deps.buildOperationOperand(expression, sourceFile, checker) }),
    };
  }

  return {
    operationCode: 'ACTION',
    operationSubjectText: expression.getText(sourceFile),
    operationDetailJson: buildOperationDetail({ subject: deps.buildOperationOperand(expression, sourceFile, checker) }),
  };
}
