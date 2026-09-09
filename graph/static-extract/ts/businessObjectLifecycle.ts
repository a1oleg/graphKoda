import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

type LifecycleModel = {
  key: string;
  ownerTypeKey: string;
  ownerName: string;
  ownerKind: 'interface' | 'typeAlias' | 'enum' | 'class';
  ownerFilePath: string;
  ownerRepoRelativePath: string;
  fieldPath: string;
  lifecycleFieldName: string;
  rootFieldName: string;
  rootFieldKey: string;
  lifecycleKind: 'status' | 'state' | 'progress' | 'stage' | 'step' | 'phase';
  stageSourceKind: 'string-union' | 'enum';
  stageSourceTypeKey?: string;
  fieldTypeText?: string;
  stageCount: number;
};

type LifecycleStage = {
  key: string;
  modelKey: string;
  name: string;
  value: string;
  normalizedName: string;
  orderIndex: number;
  stageKind: 'string-literal' | 'enum-member';
  sourceTypeKey?: string;
};

type LifecycleTransition = {
  fromStageKey: string;
  toStageKey: string;
  modelKey: string;
  orderIndex: number;
  transitionKind: 'declared-order';
};

type LifecycleFunctionEvidence = {
  key: string;
  modelKey: string;
  filePath: string;
  repoRelativePath: string;
  functionName: string;
  functionStartLine: number;
  functionStartColumn: number;
  evidenceKind: 'read' | 'write';
  sourceKind: 'condition' | 'update-call' | 'helper-call';
  line: number;
  column: number;
  stageKey?: string;
  stageValue?: string;
  sequenceScope: string;
};

type LifecycleFunctionTransition = {
  key: string;
  modelKey: string;
  filePath: string;
  repoRelativePath: string;
  functionName: string;
  functionStartLine: number;
  functionStartColumn: number;
  fromStageKey: string;
  toStageKey: string;
  evidenceKind: 'read-then-write' | 'write-sequence';
};

type ExtractedPayload = {
  models: LifecycleModel[];
  stages: LifecycleStage[];
  transitions: LifecycleTransition[];
  functionEvidence: LifecycleFunctionEvidence[];
  functionTransitions: LifecycleFunctionTransition[];
};

type OwnerDeclaration = {
  typeKey: string;
  name: string;
  kind: 'interface' | 'typeAlias' | 'enum' | 'class';
  filePath: string;
  repoRelativePath: string;
  declaration: ts.DeclarationStatement;
  sourceFile: ts.SourceFile;
};

type StageCandidate = {
  sourceKind: 'string-union' | 'enum';
  sourceTypeKey?: string;
  values: Array<{
    name: string;
    value: string;
    kind: 'string-literal' | 'enum-member';
  }>;
};

type ModelIndexEntry = {
  model: LifecycleModel;
  stages: LifecycleStage[];
  stagesByLookup: Map<string, LifecycleStage>;
};

type AliasBinding = {
  ownerTypeKey: string;
  pathSegments: string[];
};

type FunctionContext = {
  sourceFile: ts.SourceFile;
  filePath: string;
  repoRelativePath: string;
  functionName: string;
  functionStartLine: number;
  functionStartColumn: number;
  aliasBindings: Map<string, AliasBinding>;
  evidence: LifecycleFunctionEvidence[];
};

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = projectPaths.sourceRoot;
const tsconfigPath = path.join(workspaceRoot, 'tsconfig.json');

const TRACKED_OWNER_DIRS = [
  'src/api/types/',
  'src/global/types/',
  'src/types/',
];

const SKIP_PATH_FRAGMENTS = [
  '/node_modules/',
  '/dist/',
  '/build/',
  '/src/lib/gramjs/tl/',
];

const LIFECYCLE_FIELD_PATTERNS: Array<[RegExp, LifecycleModel['lifecycleKind']]> = [
  [/(^|[A-Z_])status$/i, 'status'],
  [/(^|[A-Z_])state$/i, 'state'],
  [/(^|[A-Z_])progress$/i, 'progress'],
  [/(^|[A-Z_])stage$/i, 'stage'],
  [/(^|[A-Z_])step$/i, 'step'],
  [/(^|[A-Z_])phase$/i, 'phase'],
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

function isTrackedSourceFile(sourceFile: ts.SourceFile) {
  if (sourceFile.isDeclarationFile) {
    return false;
  }

  const normalized = toPosix(sourceFile.fileName);
  if (!normalized.startsWith(toPosix(path.join(workspaceRoot, 'src')))) {
    return false;
  }

  return !SKIP_PATH_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function hasExportModifier(node: ts.Node) {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
}

function getOwnerKind(node: ts.Node): OwnerDeclaration['kind'] | undefined {
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'typeAlias';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (ts.isClassDeclaration(node)) return 'class';
  return undefined;
}

function getNameText(node: ts.Node) {
  if ('name' in node && node.name && ts.isIdentifier(node.name)) {
    return node.name.text;
  }

  return undefined;
}

function getPropertyName(member: ts.TypeElement | ts.ClassElement) {
  if (!('name' in member) || !member.name) {
    return undefined;
  }

  if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name)) {
    return member.name.text;
  }

  return undefined;
}

function getPropertyTypeNode(member: ts.TypeElement | ts.ClassElement) {
  return 'type' in member ? member.type : undefined;
}

function getTypeMembers(node: ts.Node): readonly (ts.TypeElement | ts.ClassElement)[] {
  if (ts.isInterfaceDeclaration(node)) {
    return node.members;
  }
  if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
    return node.type.members;
  }
  if (ts.isClassDeclaration(node)) {
    return node.members.filter((member): member is ts.PropertyDeclaration => ts.isPropertyDeclaration(member));
  }
  if (ts.isTypeLiteralNode(node)) {
    return node.members;
  }

  return [];
}

function classifyLifecycleField(name: string) {
  for (const [pattern, kind] of LIFECYCLE_FIELD_PATTERNS) {
    if (pattern.test(name)) {
      return kind;
    }
  }

  return undefined;
}

function normalizeStageName(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function buildStageLookupKeys(stage: LifecycleStage) {
  return new Set([
    stage.value,
    stage.name,
    stage.normalizedName,
    normalizeStageName(stage.value),
    normalizeStageName(stage.name),
  ]);
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

function extractEnumStages(enumDeclaration: ts.EnumDeclaration, declarationByNode: Map<ts.Node, string>): StageCandidate | undefined {
  const values = enumDeclaration.members
    .map((member) => {
      const name = getPropertyName(member);
      if (!name) {
        return undefined;
      }

      let value = name;
      if (member.initializer && ts.isStringLiteral(member.initializer)) {
        value = member.initializer.text;
      } else if (member.initializer && ts.isNumericLiteral(member.initializer)) {
        value = member.initializer.text;
      }

      return {
        name,
        value,
        kind: 'enum-member' as const,
      };
    })
    .filter(Boolean) as StageCandidate['values'];

  if (values.length < 2) {
    return undefined;
  }

  return {
    sourceKind: 'enum',
    sourceTypeKey: declarationByNode.get(enumDeclaration),
    values,
  };
}

function extractStagesFromTypeNode(
  checker: ts.TypeChecker,
  declarationByNode: Map<ts.Node, string>,
  node: ts.TypeNode,
  visitedDeclarations = new Set<ts.Declaration>(),
): StageCandidate | undefined {
  if (ts.isParenthesizedTypeNode(node)) {
    return extractStagesFromTypeNode(checker, declarationByNode, node.type, visitedDeclarations);
  }

  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) {
    return {
      sourceKind: 'string-union',
      values: [{ name: node.literal.text, value: node.literal.text, kind: 'string-literal' }],
    };
  }

  if (ts.isUnionTypeNode(node)) {
    const values: StageCandidate['values'] = [];
    for (const child of node.types) {
      const childCandidate = extractStagesFromTypeNode(checker, declarationByNode, child, visitedDeclarations);
      if (!childCandidate) {
        return undefined;
      }

      values.push(...childCandidate.values);
    }

    if (values.length < 2) {
      return undefined;
    }

    return {
      sourceKind: 'string-union',
      values,
    };
  }

  if (ts.isTypeReferenceNode(node)) {
    const symbol = checker.getSymbolAtLocation(node.typeName);
    const resolved = symbol && ((symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol);
    for (const declaration of resolved?.declarations ?? []) {
      if (visitedDeclarations.has(declaration)) {
        continue;
      }

      visitedDeclarations.add(declaration);

      if (ts.isEnumDeclaration(declaration)) {
        return extractEnumStages(declaration, declarationByNode);
      }

      if (ts.isTypeAliasDeclaration(declaration)) {
        const candidate = extractStagesFromTypeNode(checker, declarationByNode, declaration.type, visitedDeclarations);
        if (!candidate) {
          continue;
        }

        return {
          ...candidate,
          sourceTypeKey: candidate.sourceTypeKey ?? declarationByNode.get(declaration),
        };
      }
    }
  }

  return undefined;
}

function walkLifecycleMembers(
  owner: OwnerDeclaration,
  checker: ts.TypeChecker,
  declarationByNode: Map<ts.Node, string>,
  container: ts.Node,
  pathSegments: string[],
  models: LifecycleModel[],
  stages: LifecycleStage[],
  transitions: LifecycleTransition[],
) {
  for (const member of getTypeMembers(container)) {
    const fieldName = getPropertyName(member);
    if (!fieldName) {
      continue;
    }

    const nextPathSegments = [...pathSegments, fieldName];
    const typeNode = getPropertyTypeNode(member);
    if (!typeNode) {
      continue;
    }

    const lifecycleKind = classifyLifecycleField(fieldName);
    if (lifecycleKind) {
      const stageCandidate = extractStagesFromTypeNode(checker, declarationByNode, typeNode);
      if (stageCandidate && stageCandidate.values.length >= 2) {
        const modelKey = `${owner.typeKey}::${nextPathSegments.join('.')}`;
        const rootFieldName = nextPathSegments[0];
        const rootFieldKey = `${owner.typeKey}::${rootFieldName}`;

        models.push({
          key: modelKey,
          ownerTypeKey: owner.typeKey,
          ownerName: owner.name,
          ownerKind: owner.kind,
          ownerFilePath: owner.filePath,
          ownerRepoRelativePath: owner.repoRelativePath,
          fieldPath: nextPathSegments.join('.'),
          lifecycleFieldName: fieldName,
          rootFieldName,
          rootFieldKey,
          lifecycleKind,
          stageSourceKind: stageCandidate.sourceKind,
          stageSourceTypeKey: stageCandidate.sourceTypeKey,
          fieldTypeText: typeNode.getText(owner.sourceFile),
          stageCount: stageCandidate.values.length,
        });

        const modelStageRows = stageCandidate.values.map((value, index) => ({
          key: `${modelKey}::${index}::${normalizeStageName(value.value)}`,
          modelKey,
          name: value.name,
          value: value.value,
          normalizedName: normalizeStageName(value.value),
          orderIndex: index,
          stageKind: value.kind,
          sourceTypeKey: stageCandidate.sourceTypeKey,
        }));

        stages.push(...modelStageRows);

        for (let index = 0; index < modelStageRows.length - 1; index += 1) {
          transitions.push({
            fromStageKey: modelStageRows[index].key,
            toStageKey: modelStageRows[index + 1].key,
            modelKey,
            orderIndex: index,
            transitionKind: 'declared-order',
          });
        }
      }
    }

    if (ts.isTypeLiteralNode(typeNode)) {
      walkLifecycleMembers(owner, checker, declarationByNode, typeNode, nextPathSegments, models, stages, transitions);
    }
  }
}

function buildModelIndex(models: LifecycleModel[], stages: LifecycleStage[]) {
  const modelIndex = new Map<string, ModelIndexEntry>();

  for (const model of models) {
    modelIndex.set(model.key, {
      model,
      stages: [],
      stagesByLookup: new Map(),
    });
  }

  for (const stage of stages) {
    const entry = modelIndex.get(stage.modelKey);
    if (!entry) {
      continue;
    }

    entry.stages.push(stage);
    for (const lookupKey of buildStageLookupKeys(stage)) {
      entry.stagesByLookup.set(lookupKey, stage);
    }
  }

  return modelIndex;
}

function getNodeLocation(sourceFile: ts.SourceFile, node: ts.Node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    line: position.line + 1,
    column: position.character,
  };
}

function getFunctionName(node: ts.FunctionLikeDeclarationBase) {
  if ('name' in node && node.name && ts.isIdentifier(node.name)) {
    return node.name.text;
  }

  if (node.parent && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text;
  }

  if (node.parent && ts.isCallExpression(node.parent)) {
    const call = node.parent;
    if (ts.isIdentifier(call.expression) && call.expression.text === 'addActionHandler') {
      const actionName = call.arguments[0];
      if (actionName && ts.isStringLiteralLike(actionName)) {
        return `addActionHandler:${actionName.text}`;
      }
    }
  }

  return 'anonymous';
}

function getPropertyAccessSegments(node: ts.Node): { base: string; segments: string[] } | undefined {
  if (ts.isIdentifier(node)) {
    return { base: node.text, segments: [] };
  }

  if (ts.isPropertyAccessExpression(node)) {
    const parent = getPropertyAccessSegments(node.expression);
    if (!parent) {
      return undefined;
    }

    return {
      base: parent.base,
      segments: [...parent.segments, node.name.text],
    };
  }

  return undefined;
}

function resolveAliasBindingFromExpression(expression: ts.Expression, aliasBindings: Map<string, AliasBinding>): AliasBinding | undefined {
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'selectTabState') {
    return { ownerTypeKey: 'src/global/types/tabState.ts::TabState', pathSegments: [] };
  }

  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'selectStarsPayment') {
    return { ownerTypeKey: 'src/global/types/tabState.ts::TabState', pathSegments: ['starsPayment'] };
  }

  const segments = getPropertyAccessSegments(expression);
  if (!segments) {
    return undefined;
  }

  if (segments.base === 'global' && segments.segments.length > 0) {
    return { ownerTypeKey: 'src/global/types/globalState.ts::GlobalState', pathSegments: segments.segments };
  }

  if (segments.base === 'tabState') {
    return { ownerTypeKey: 'src/global/types/tabState.ts::TabState', pathSegments: segments.segments };
  }

  const alias = aliasBindings.get(segments.base);
  if (!alias) {
    return undefined;
  }

  return {
    ownerTypeKey: alias.ownerTypeKey,
    pathSegments: [...alias.pathSegments, ...segments.segments],
  };
}

function resolveModelFromExpression(expression: ts.Expression, modelIndex: Map<string, ModelIndexEntry>, aliasBindings: Map<string, AliasBinding>) {
  const binding = resolveAliasBindingFromExpression(expression, aliasBindings);
  if (!binding || !binding.pathSegments.length) {
    return undefined;
  }

  return modelIndex.get(`${binding.ownerTypeKey}::${binding.pathSegments.join('.')}`)?.model;
}

function resolveStageFromExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  modelEntry: ModelIndexEntry,
): LifecycleStage | undefined {
  if (ts.isStringLiteralLike(expression)) {
    return modelEntry.stagesByLookup.get(expression.text);
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return modelEntry.stagesByLookup.get(expression.name.text)
      || modelEntry.stagesByLookup.get(`${expression.expression.getText()}.${expression.name.text}`)
      || modelEntry.stagesByLookup.get(normalizeStageName(expression.name.text));
  }

  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    if (symbol?.valueDeclaration && ts.isEnumMember(symbol.valueDeclaration)) {
      const enumMemberName = getPropertyName(symbol.valueDeclaration);
      if (enumMemberName) {
        return modelEntry.stagesByLookup.get(enumMemberName) || modelEntry.stagesByLookup.get(normalizeStageName(enumMemberName));
      }
    }
  }

  return undefined;
}

function recordEvidence(
  functionContext: FunctionContext,
  modelEntry: ModelIndexEntry,
  node: ts.Node,
  evidenceKind: 'read' | 'write',
  sourceKind: LifecycleFunctionEvidence['sourceKind'],
  sequenceScope: string,
  stage?: LifecycleStage,
) {
  const { line, column } = getNodeLocation(functionContext.sourceFile, node);
  functionContext.evidence.push({
    key: `${functionContext.repoRelativePath}::${functionContext.functionStartLine}::${evidenceKind}::${sourceKind}::${modelEntry.model.key}::${line}:${column}::${stage?.key || 'model'}`,
    modelKey: modelEntry.model.key,
    filePath: functionContext.filePath,
    repoRelativePath: functionContext.repoRelativePath,
    functionName: functionContext.functionName,
    functionStartLine: functionContext.functionStartLine,
    functionStartColumn: functionContext.functionStartColumn,
    evidenceKind,
    sourceKind,
    line,
    column,
    stageKey: stage?.key,
    stageValue: stage?.value,
    sequenceScope,
  });
}

function collectObjectLiteralWrites(
  objectLiteral: ts.ObjectLiteralExpression,
  baseSegments: string[],
  ownerTypeKey: string,
  functionContext: FunctionContext,
  checker: ts.TypeChecker,
  modelIndex: Map<string, ModelIndexEntry>,
  sourceKind: LifecycleFunctionEvidence['sourceKind'],
  sequenceScope: string,
) {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }

    const name = property.name.getText(functionContext.sourceFile).replace(/^['"]|['"]$/g, '');
    const fullPath = [...baseSegments, name];

    if (ts.isObjectLiteralExpression(property.initializer)) {
      collectObjectLiteralWrites(property.initializer, fullPath, ownerTypeKey, functionContext, checker, modelIndex, sourceKind, sequenceScope);
      continue;
    }

    const entry = modelIndex.get(`${ownerTypeKey}::${fullPath.join('.')}`);
    if (!entry) {
      continue;
    }

    const stage = resolveStageFromExpression(property.initializer, checker, entry);
    recordEvidence(functionContext, entry, property, 'write', sourceKind, sequenceScope, stage);
  }
}

function buildScopedPath(parentScope: string, label: string) {
  return `${parentScope}>${label}`;
}

function isSameOrAncestorScope(scope: string, nestedScope: string) {
  return scope === nestedScope || nestedScope.startsWith(`${scope}>`);
}

function collectFunctionEvidence(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  modelIndex: Map<string, ModelIndexEntry>,
) {
  const evidences: LifecycleFunctionEvidence[] = [];
  const functionTransitions: LifecycleFunctionTransition[] = [];

  function visit(node: ts.Node) {
    if (!ts.isFunctionLike(node) || !node.body) {
      ts.forEachChild(node, visit);
      return;
    }

    const filePath = toPosix(path.resolve(sourceFile.fileName));
    const repoRelativePath = getRepoRelativePath(filePath);
    const start = getNodeLocation(sourceFile, node);
    const functionContext: FunctionContext = {
      sourceFile,
      filePath,
      repoRelativePath,
      functionName: getFunctionName(node),
      functionStartLine: start.line,
      functionStartColumn: start.column,
      aliasBindings: new Map(),
      evidence: [],
    };

    function walk(current: ts.Node, sequenceScope = 'root') {
      if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.initializer) {
        const binding = resolveAliasBindingFromExpression(current.initializer, functionContext.aliasBindings);
        if (binding) {
          functionContext.aliasBindings.set(current.name.text, binding);
        }
      }

      if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)) {
        const callee = current.expression.text;
        if (callee === 'updatePayment' && current.arguments[1] && ts.isObjectLiteralExpression(current.arguments[1])) {
          collectObjectLiteralWrites(current.arguments[1], ['payment'], 'src/global/types/tabState.ts::TabState', functionContext, checker, modelIndex, 'update-call', sequenceScope);
        } else if (callee === 'updateStarsPayment' && current.arguments[1] && ts.isObjectLiteralExpression(current.arguments[1])) {
          collectObjectLiteralWrites(current.arguments[1], ['starsPayment'], 'src/global/types/tabState.ts::TabState', functionContext, checker, modelIndex, 'update-call', sequenceScope);
        } else if (callee === 'updateAuth' && current.arguments[1] && ts.isObjectLiteralExpression(current.arguments[1])) {
          collectObjectLiteralWrites(current.arguments[1], ['auth'], 'src/global/types/globalState.ts::GlobalState', functionContext, checker, modelIndex, 'update-call', sequenceScope);
        } else if (callee === 'updateTabState' && current.arguments[1] && ts.isObjectLiteralExpression(current.arguments[1])) {
          collectObjectLiteralWrites(current.arguments[1], [], 'src/global/types/tabState.ts::TabState', functionContext, checker, modelIndex, 'update-call', sequenceScope);
        } else if (callee === 'setPaymentStep' && current.arguments[1]) {
          const entry = modelIndex.get('src/global/types/tabState.ts::TabState::payment.step');
          if (entry) {
            const stage = resolveStageFromExpression(current.arguments[1], checker, entry);
            recordEvidence(functionContext, entry, current, 'write', 'helper-call', sequenceScope, stage);
          }
        }
      }

      if (ts.isBinaryExpression(current)) {
        const operator = current.operatorToken.kind;
        if (
          operator === ts.SyntaxKind.EqualsEqualsEqualsToken
          || operator === ts.SyntaxKind.EqualsEqualsToken
          || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken
          || operator === ts.SyntaxKind.ExclamationEqualsToken
        ) {
          const leftModel = ts.isExpression(current.left) ? resolveModelFromExpression(current.left, modelIndex, functionContext.aliasBindings) : undefined;
          const rightModel = ts.isExpression(current.right) ? resolveModelFromExpression(current.right, modelIndex, functionContext.aliasBindings) : undefined;

          if (leftModel) {
            const leftEntry = modelIndex.get(leftModel.key)!;
            const stage = resolveStageFromExpression(current.right, checker, leftEntry);
            recordEvidence(functionContext, leftEntry, current, 'read', 'condition', sequenceScope, stage);
          } else if (rightModel) {
            const rightEntry = modelIndex.get(rightModel.key)!;
            const stage = resolveStageFromExpression(current.left, checker, rightEntry);
            recordEvidence(functionContext, rightEntry, current, 'read', 'condition', sequenceScope, stage);
          }
        }
      }

      if (ts.isSwitchStatement(current)) {
        const switchedModel = resolveModelFromExpression(current.expression, modelIndex, functionContext.aliasBindings);
        if (switchedModel) {
          const entry = modelIndex.get(switchedModel.key)!;
          for (const clause of current.caseBlock.clauses) {
            if (!ts.isCaseClause(clause)) {
              continue;
            }
            const stage = resolveStageFromExpression(clause.expression, checker, entry);
            recordEvidence(functionContext, entry, clause, 'read', 'condition', buildScopedPath(sequenceScope, `switch:${clause.getStart(sourceFile)}`), stage);
          }
        }
      }

      if (ts.isIfStatement(current)) {
        walk(current.expression, sequenceScope);
        walk(current.thenStatement, buildScopedPath(sequenceScope, `if:${current.thenStatement.getStart(sourceFile)}`));
        if (current.elseStatement) {
          walk(current.elseStatement, buildScopedPath(sequenceScope, `else:${current.elseStatement.getStart(sourceFile)}`));
        }
        return;
      }

      if (ts.isTryStatement(current)) {
        walk(current.tryBlock, buildScopedPath(sequenceScope, `try:${current.tryBlock.getStart(sourceFile)}`));
        if (current.catchClause) {
          walk(current.catchClause, buildScopedPath(sequenceScope, `catch:${current.catchClause.getStart(sourceFile)}`));
        }
        if (current.finallyBlock) {
          walk(current.finallyBlock, buildScopedPath(sequenceScope, `finally:${current.finallyBlock.getStart(sourceFile)}`));
        }
        return;
      }

      if (ts.isSwitchStatement(current)) {
        walk(current.expression, sequenceScope);
        for (const clause of current.caseBlock.clauses) {
          walk(clause, buildScopedPath(sequenceScope, `case:${clause.getStart(sourceFile)}`));
        }
        return;
      }

      ts.forEachChild(current, (child) => walk(child, sequenceScope));
    }

    walk(node.body);
    evidences.push(...functionContext.evidence);

    const readsByModel = new Map<string, LifecycleFunctionEvidence[]>();
    const writesByModel = new Map<string, LifecycleFunctionEvidence[]>();
    for (const evidence of functionContext.evidence) {
      if (!evidence.stageKey) {
        continue;
      }

      const target = evidence.evidenceKind === 'read' ? readsByModel : writesByModel;
      if (!target.has(evidence.modelKey)) {
        target.set(evidence.modelKey, []);
      }
      target.get(evidence.modelKey)!.push(evidence);
    }

    for (const [modelKey, reads] of readsByModel) {
      const writes = writesByModel.get(modelKey);
      if (!writes) {
        continue;
      }

      for (const readEvidence of reads) {
        for (const writeEvidence of writes) {
          if (!readEvidence.stageKey || !writeEvidence.stageKey || readEvidence.stageKey === writeEvidence.stageKey) {
            continue;
          }

          const isCompatibleScope = isSameOrAncestorScope(readEvidence.sequenceScope, writeEvidence.sequenceScope);
          const isOrderedAfter = writeEvidence.line > readEvidence.line
            || (writeEvidence.line === readEvidence.line && writeEvidence.column > readEvidence.column);

          if (!isCompatibleScope || !isOrderedAfter) {
            continue;
          }

          functionTransitions.push({
            key: `${repoRelativePath}::${start.line}::${modelKey}::read-then-write::${readEvidence.sequenceScope}::${readEvidence.stageKey}::${writeEvidence.sequenceScope}::${writeEvidence.stageKey}`,
            modelKey,
            filePath,
            repoRelativePath,
            functionName: functionContext.functionName,
            functionStartLine: functionContext.functionStartLine,
            functionStartColumn: functionContext.functionStartColumn,
            fromStageKey: readEvidence.stageKey,
            toStageKey: writeEvidence.stageKey,
            evidenceKind: 'read-then-write',
          });
        }
      }
    }

    const writesByModelInOrder = new Map<string, LifecycleFunctionEvidence[]>();
    for (const evidence of functionContext.evidence) {
      if (evidence.evidenceKind !== 'write' || !evidence.stageKey) {
        continue;
      }

      const scopedModelKey = `${evidence.modelKey}::${evidence.sequenceScope}`;
      if (!writesByModelInOrder.has(scopedModelKey)) {
        writesByModelInOrder.set(scopedModelKey, []);
      }

      writesByModelInOrder.get(scopedModelKey)!.push(evidence);
    }

    for (const [scopedModelKey, writes] of writesByModelInOrder) {
      writes.sort((left, right) => (left.line - right.line) || (left.column - right.column));
      for (let index = 0; index < writes.length - 1; index += 1) {
        const fromEvidence = writes[index];
        const toEvidence = writes[index + 1];
        if (!fromEvidence.stageKey || !toEvidence.stageKey || fromEvidence.stageKey === toEvidence.stageKey) {
          continue;
        }

        functionTransitions.push({
          key: `${repoRelativePath}::${start.line}::${scopedModelKey}::write-sequence::${fromEvidence.stageKey}::${toEvidence.stageKey}::${index}`,
          modelKey: fromEvidence.modelKey,
          filePath,
          repoRelativePath,
          functionName: functionContext.functionName,
          functionStartLine: functionContext.functionStartLine,
          functionStartColumn: functionContext.functionStartColumn,
          fromStageKey: fromEvidence.stageKey,
          toStageKey: toEvidence.stageKey,
          evidenceKind: 'write-sequence',
        });
      }
    }

    return;
  }

  visit(sourceFile);
  return { evidences, functionTransitions };
}

function main() {
  const program = createProgram();
  const checker = program.getTypeChecker();
  const declarationByNode = new Map<ts.Node, string>();
  const owners: OwnerDeclaration[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile)) {
      continue;
    }

    const filePath = toPosix(path.resolve(sourceFile.fileName));
    const repoRelativePath = getRepoRelativePath(filePath);

    for (const statement of sourceFile.statements) {
      const kind = getOwnerKind(statement);
      const name = getNameText(statement);
      if (!kind || !name || !hasExportModifier(statement)) {
        continue;
      }

      if (!TRACKED_OWNER_DIRS.some((prefix) => repoRelativePath.startsWith(prefix))) {
        continue;
      }

      const typeKey = `${repoRelativePath}::${name}`;
      declarationByNode.set(statement, typeKey);
      owners.push({
        typeKey,
        name,
        kind,
        filePath,
        repoRelativePath,
        declaration: statement,
        sourceFile,
      });
    }
  }

  const models: LifecycleModel[] = [];
  const stages: LifecycleStage[] = [];
  const transitions: LifecycleTransition[] = [];

  for (const owner of owners) {
    walkLifecycleMembers(owner, checker, declarationByNode, owner.declaration, [], models, stages, transitions);
  }

  const modelIndex = buildModelIndex(models, stages);
  const functionEvidence: LifecycleFunctionEvidence[] = [];
  const functionTransitions: LifecycleFunctionTransition[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile)) {
      continue;
    }

    const collected = collectFunctionEvidence(sourceFile, checker, modelIndex);
    functionEvidence.push(...collected.evidences);
    functionTransitions.push(...collected.functionTransitions);
  }

  const payload: ExtractedPayload = {
    models: Array.from(new Map(models.map((model) => [model.key, model])).values()).sort((left, right) => left.key.localeCompare(right.key)),
    stages: Array.from(new Map(stages.map((stage) => [stage.key, stage])).values()).sort((left, right) => left.key.localeCompare(right.key)),
    transitions: Array.from(new Map(transitions.map((transition) => [`${transition.modelKey}::${transition.orderIndex}::${transition.fromStageKey}::${transition.toStageKey}`, transition])).values())
      .sort((left, right) => `${left.modelKey}::${left.orderIndex}`.localeCompare(`${right.modelKey}::${right.orderIndex}`)),
    functionEvidence: Array.from(new Map(functionEvidence.map((evidence) => [evidence.key, evidence])).values()).sort((left, right) => left.key.localeCompare(right.key)),
    functionTransitions: Array.from(new Map(functionTransitions.map((transition) => [transition.key, transition])).values()).sort((left, right) => left.key.localeCompare(right.key)),
  };

  process.stdout.write(JSON.stringify(payload));
}

main();
import projectPaths from '../../../dev/projectPaths.cjs';
