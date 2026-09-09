import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

type ExportedTypeKind = 'interface' | 'typeAlias' | 'enum' | 'class';

type ExtractedType = {
  key: string;
  name: string;
  kind: ExportedTypeKind;
  filePath: string;
  repoRelativePath: string;
  folderPath: string;
  folderRelativePath: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  fieldCount: number;
  utilityKind?: string;
  contextCount: number;
  hasApiUsage: boolean;
  hasStateUsage: boolean;
  hasUiUsage: boolean;
};

type ExtractedField = {
  key: string;
  typeKey: string;
  ownerTypeKey: string;
  ownerName: string;
  ownerKind: ExportedTypeKind;
  ownerFilePath: string;
  ownerRepoRelativePath: string;
  name: string;
  fieldKind: string;
  orderIndex: number;
  isOptional: boolean;
  typeText?: string;
  containerKind: string;
  containerPath: string;
  isCollectionContainer: boolean;
  isUnionContainer: boolean;
  unionBranchCount: number;
  referencedTypeCount: number;
};

type FieldTypeRef = {
  fieldKey: string;
  targetTypeKey: string;
  relationKind: 'type' | 'array' | 'union' | 'intersection';
  referenceRole: string;
  containerKind: string;
  containerPath: string;
  variantRoles: string[];
  unionBranchCount: number;
};

type UnionMetadata = {
  memberCount: number;
  exportedTypeBranchCount: number;
  hasUndefined: boolean;
  hasNull: boolean;
  hasPrimitiveOrLiteral: boolean;
};

type FieldTypeAnalysis = {
  refs: FieldTypeRef[];
  containerKind: string;
  containerPath: string;
  isCollectionContainer: boolean;
  isUnionContainer: boolean;
  unionBranchCount: number;
  referencedTypeCount: number;
};

type UsageEdge = {
  typeKey: string;
  filePath: string;
  repoRelativePath: string;
  contextKey: string;
  useCount: number;
};

type UsageContext = {
  key: string;
  label: string;
  domain: 'api' | 'state' | 'ui' | 'other';
};

type ExtractedPayload = {
  types: ExtractedType[];
  fields: ExtractedField[];
  fieldTypeRefs: FieldTypeRef[];
  usageEdges: UsageEdge[];
  usageContexts: UsageContext[];
};

function dedupeFields(rows: ExtractedField[]) {
  const uniqueRows = new Map<string, ExtractedField>();

  for (const row of rows) {
    uniqueRows.set(row.key, row);
  }

  return [...uniqueRows.values()];
}

function dedupeFieldTypeRefs(rows: FieldTypeRef[]) {
  const uniqueRows = new Map<string, FieldTypeRef>();

  for (const row of rows) {
    const key = `${row.fieldKey}::${row.targetTypeKey}::${row.relationKind}::${row.referenceRole}`;
    const existing = uniqueRows.get(key);
    if (!existing) {
      uniqueRows.set(key, row);
      continue;
    }

    uniqueRows.set(key, {
      ...existing,
      variantRoles: [...new Set([...existing.variantRoles, ...row.variantRoles])].sort(),
    });
  }

  return [...uniqueRows.values()];
}

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = projectPaths.sourceRoot;
const tsconfigPath = path.join(workspaceRoot, 'tsconfig.json');

const TRACKED_TYPE_DIRS = [
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

const UTILITY_SUFFIXES: Array<[string, string]> = [
  ['StateProps', 'state-props'],
  ['Props', 'props'],
  ['Options', 'options'],
  ['Option', 'options'],
  ['Config', 'config'],
  ['Args', 'args'],
  ['Params', 'params'],
  ['Payload', 'payload'],
  ['Result', 'result'],
  ['Results', 'result'],
  ['Error', 'error'],
  ['Errors', 'error'],
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

function getTypeKind(node: ts.Node): ExportedTypeKind | undefined {
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

function getContextKey(repoRelativePath: string): UsageContext {
  if (repoRelativePath.startsWith('src/api/gramjs/apiBuilders/')) {
    return { key: 'builder', label: 'builder', domain: 'api' };
  }
  if (repoRelativePath.startsWith('src/api/gramjs/methods/')) {
    return { key: 'api-method', label: 'api-method', domain: 'api' };
  }
  if (repoRelativePath.startsWith('src/api/gramjs/updates/')) {
    return { key: 'updater', label: 'updater', domain: 'api' };
  }
  if (repoRelativePath.startsWith('src/api/types/')) {
    return { key: 'api-model', label: 'api-model', domain: 'api' };
  }
  if (repoRelativePath.startsWith('src/global/selectors/')) {
    return { key: 'selector', label: 'selector', domain: 'state' };
  }
  if (repoRelativePath.startsWith('src/global/reducers/')) {
    return { key: 'reducer', label: 'reducer', domain: 'state' };
  }
  if (repoRelativePath.startsWith('src/global/actions/')) {
    return { key: 'action', label: 'action', domain: 'state' };
  }
  if (repoRelativePath.startsWith('src/global/types/') || repoRelativePath.startsWith('src/global/helpers/') || repoRelativePath === 'src/global/cache.ts') {
    return { key: 'state', label: 'state', domain: 'state' };
  }
  if (repoRelativePath.startsWith('src/components/')) {
    return { key: 'ui', label: 'ui', domain: 'ui' };
  }
  if (repoRelativePath.startsWith('src/hooks/')) {
    return { key: 'hook', label: 'hook', domain: 'ui' };
  }
  if (repoRelativePath.startsWith('src/types/')) {
    return { key: 'shared-type', label: 'shared-type', domain: 'other' };
  }
  if (repoRelativePath.startsWith('src/util/')) {
    return { key: 'util', label: 'util', domain: 'other' };
  }

  return { key: 'other', label: 'other', domain: 'other' };
}

function getUtilityKind(name: string) {
  for (const [suffix, kind] of UTILITY_SUFFIXES) {
    if (name.endsWith(suffix)) {
      return kind;
    }
  }

  return undefined;
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

function getMemberNodes(node: ts.Node) {
  if (ts.isInterfaceDeclaration(node)) {
    return node.members;
  }
  if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
    return node.type.members;
  }
  if (ts.isClassDeclaration(node)) {
    return node.members.filter((member): member is ts.PropertyDeclaration => ts.isPropertyDeclaration(member));
  }

  return [];
}

function isNullishTypeNode(node: ts.TypeNode) {
  if (node.kind === ts.SyntaxKind.UndefinedKeyword) {
    return { hasUndefined: true, hasNull: false };
  }

  if (ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword) {
    return { hasUndefined: false, hasNull: true };
  }

  if (node.kind === ts.SyntaxKind.NullKeyword) {
    return { hasUndefined: false, hasNull: true };
  }

  return { hasUndefined: false, hasNull: false };
}

function isPrimitiveOrLiteralTypeNode(node: ts.TypeNode): boolean {
  if (ts.isLiteralTypeNode(node)) {
    return true;
  }

  switch (node.kind) {
    case ts.SyntaxKind.StringKeyword:
    case ts.SyntaxKind.NumberKeyword:
    case ts.SyntaxKind.BooleanKeyword:
    case ts.SyntaxKind.UnknownKeyword:
    case ts.SyntaxKind.AnyKeyword:
    case ts.SyntaxKind.NeverKeyword:
    case ts.SyntaxKind.VoidKeyword:
    case ts.SyntaxKind.ObjectKeyword:
    case ts.SyntaxKind.SymbolKeyword:
    case ts.SyntaxKind.BigIntKeyword:
        return true;
    default:
        return false;
  }
}

function getTypeReferenceBaseName(typeName: ts.EntityName): string {
  if (ts.isIdentifier(typeName)) {
    return typeName.text;
  }

  return typeName.right.text;
}

function hasExportedTypeReference(
  checker: ts.TypeChecker,
  declarationByNode: Map<ts.Node, string>,
  rootNode: ts.Node,
) {
  let found = false;

  function visit(node: ts.Node): void {
    if (found) {
      return;
    }

    if (ts.isTypeReferenceNode(node)) {
      const symbol = checker.getSymbolAtLocation(node.typeName);
      const resolved = symbol && ((symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol);
      for (const declaration of resolved?.declarations ?? []) {
        if (declarationByNode.get(declaration)) {
          found = true;
          return;
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(rootNode);
  return found;
}

function getUnionMetadata(
  checker: ts.TypeChecker,
  declarationByNode: Map<ts.Node, string>,
  node: ts.UnionTypeNode,
): UnionMetadata {
  let exportedTypeBranchCount = 0;
  let hasUndefined = false;
  let hasNull = false;
  let hasPrimitiveOrLiteral = false;

  for (const child of node.types) {
    const nullish = isNullishTypeNode(child);
    hasUndefined ||= nullish.hasUndefined;
    hasNull ||= nullish.hasNull;
    if (isPrimitiveOrLiteralTypeNode(child)) {
      hasPrimitiveOrLiteral = true;
    }
    if (hasExportedTypeReference(checker, declarationByNode, child)) {
      exportedTypeBranchCount += 1;
    }
  }

  return {
    memberCount: node.types.length,
    exportedTypeBranchCount,
    hasUndefined,
    hasNull,
    hasPrimitiveOrLiteral,
  };
}

function getTypeReferenceContainerSpec(node: ts.TypeReferenceNode) {
  const typeName = getTypeReferenceBaseName(node.typeName);
  const args = node.typeArguments ?? [];

  if ((typeName === 'Array' || typeName === 'ReadonlyArray') && args[0]) {
    return [{
      child: args[0],
      containerKind: typeName === 'ReadonlyArray' ? 'readonly-array' : 'array',
      referenceRole: typeName === 'ReadonlyArray' ? 'readonly-array-element' : 'array-element',
      relationKind: 'array' as const,
    }];
  }

  if ((typeName === 'Set' || typeName === 'ReadonlySet') && args[0]) {
    return [{
      child: args[0],
      containerKind: typeName === 'ReadonlySet' ? 'readonly-set' : 'set',
      referenceRole: 'set-element',
      relationKind: 'type' as const,
    }];
  }

  if (typeName === 'Promise' && args[0]) {
    return [{
      child: args[0],
      containerKind: 'promise',
      referenceRole: 'promise-value',
      relationKind: 'type' as const,
    }];
  }

  if (typeName === 'Record' && args[0] && args[1]) {
    return [
      {
        child: args[0],
        containerKind: 'record',
        referenceRole: 'record-key',
        relationKind: 'type' as const,
      },
      {
        child: args[1],
        containerKind: 'record',
        referenceRole: 'record-value',
        relationKind: 'type' as const,
      },
    ];
  }

  if (typeName === 'Map' && args[0] && args[1]) {
    return [
      {
        child: args[0],
        containerKind: 'map',
        referenceRole: 'map-key',
        relationKind: 'type' as const,
      },
      {
        child: args[1],
        containerKind: 'map',
        referenceRole: 'map-value',
        relationKind: 'type' as const,
      },
    ];
  }

  return undefined;
}

function buildFieldTypeAnalysis(
  checker: ts.TypeChecker,
  declarationByNode: Map<ts.Node, string>,
  rootNode: ts.TypeNode,
) {
  const refs: FieldTypeRef[] = [];
  const referencedTypeKeys = new Set<string>();
  let isCollectionContainer = false;
  let isUnionContainer = false;
  let unionBranchCount = 0;

  function pushRef(targetTypeKey: string, relationKind: FieldTypeRef['relationKind'], containerStack: string[], referenceRole: string, unionMetadata?: UnionMetadata) {
    const variantRoles: string[] = [];
    if (unionMetadata) {
      variantRoles.push('union-member');
      if (unionMetadata.exportedTypeBranchCount > 1) {
        variantRoles.push('polymorphic-variant');
      }
      if (unionMetadata.hasUndefined) {
        variantRoles.push('optional');
      }
      if (unionMetadata.hasNull) {
        variantRoles.push('nullable');
      }
      if (unionMetadata.hasPrimitiveOrLiteral) {
        variantRoles.push('mixed-with-primitive');
      }
    }

    const containerKind = containerStack[0] ?? 'direct';
    const containerPath = containerStack.length ? containerStack.join('>') : 'direct';
    refs.push({
      fieldKey: '',
      targetTypeKey,
      relationKind,
      referenceRole,
      containerKind,
      containerPath,
      variantRoles,
      unionBranchCount: unionMetadata?.memberCount ?? 0,
    });
    referencedTypeKeys.add(targetTypeKey);
  }

  function visit(node: ts.Node, state: { relationKind: FieldTypeRef['relationKind']; containerStack: string[]; referenceRole: string; unionMetadata?: UnionMetadata }) {
    if (ts.isParenthesizedTypeNode(node)) {
      visit(node.type, state);
      return;
    }
    if (ts.isArrayTypeNode(node)) {
      isCollectionContainer = true;
      visit(node.elementType, {
        ...state,
        relationKind: 'array',
        containerStack: [...state.containerStack, 'array'],
        referenceRole: 'array-element',
      });
      return;
    }
    if (ts.isTupleTypeNode(node)) {
      isCollectionContainer = true;
      for (const element of node.elements) {
        visit(ts.isNamedTupleMember(element) ? element.type : element, {
          ...state,
          relationKind: 'array',
          containerStack: [...state.containerStack, 'tuple'],
          referenceRole: 'tuple-element',
        });
      }
      return;
    }
    if (ts.isUnionTypeNode(node)) {
      isUnionContainer = true;
      unionBranchCount = Math.max(unionBranchCount, node.types.length);
      const unionMetadata = getUnionMetadata(checker, declarationByNode, node);
      for (const child of node.types) {
        visit(child, {
          ...state,
          relationKind: 'union',
          containerStack: [...state.containerStack, 'union'],
          referenceRole: state.referenceRole === 'direct' ? 'union-variant' : state.referenceRole,
          unionMetadata,
        });
      }
      return;
    }
    if (ts.isIntersectionTypeNode(node)) {
      for (const child of node.types) {
        visit(child, {
          ...state,
          relationKind: 'intersection',
          containerStack: [...state.containerStack, 'intersection'],
          referenceRole: state.referenceRole === 'direct' ? 'intersection-member' : state.referenceRole,
        });
      }
      return;
    }
    if (ts.isTypeReferenceNode(node)) {
      const containerSpec = getTypeReferenceContainerSpec(node);
      if (containerSpec?.length) {
        if (containerSpec.some((entry) => ['array', 'readonly-array', 'set', 'readonly-set', 'record', 'map'].includes(entry.containerKind))) {
          isCollectionContainer = true;
        }
        for (const entry of containerSpec) {
          visit(entry.child, {
            ...state,
            relationKind: entry.relationKind,
            containerStack: [...state.containerStack, entry.containerKind],
            referenceRole: entry.referenceRole,
          });
        }
        return;
      }

      const symbol = checker.getSymbolAtLocation(node.typeName);
      const resolved = symbol && ((symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol);
      for (const declaration of resolved?.declarations ?? []) {
        const targetTypeKey = declarationByNode.get(declaration);
        if (targetTypeKey) {
          pushRef(targetTypeKey, state.relationKind, state.containerStack, state.referenceRole, state.unionMetadata);
        }
      }

      ts.forEachChild(node, (child) => visit(child, state));
      return;
    }

    if (ts.isIndexedAccessTypeNode(node)) {
      visit(node.objectType, {
        ...state,
        containerStack: [...state.containerStack, 'indexed-access'],
        referenceRole: state.referenceRole === 'direct' ? 'indexed-access-target' : state.referenceRole,
      });
      visit(node.indexType, {
        ...state,
        containerStack: [...state.containerStack, 'indexed-access'],
        referenceRole: 'indexed-access-key',
      });
      return;
    }

    ts.forEachChild(node, (child) => visit(child, state));
  }

  visit(rootNode, { relationKind: 'type', containerStack: [], referenceRole: 'direct' });

  const primaryContainerPath = refs[0]?.containerPath ?? 'direct';
  const primaryContainerKind = refs[0]?.containerKind ?? (primaryContainerPath === 'direct' ? 'direct' : primaryContainerPath.split('>')[0]);

  return {
    refs,
    containerKind: primaryContainerKind,
    containerPath: primaryContainerPath,
    isCollectionContainer,
    isUnionContainer,
    unionBranchCount,
    referencedTypeCount: referencedTypeKeys.size,
  } satisfies FieldTypeAnalysis;
}

function main() {
  const program = createProgram();
  const checker = program.getTypeChecker();
  const declarationByNode = new Map<ts.Node, string>();
  const typeRows = new Map<string, ExtractedType>();
  const fieldRows: ExtractedField[] = [];
  const fieldRefRows: FieldTypeRef[] = [];
  const usageContexts = new Map<string, UsageContext>();
  const usageCounter = new Map<string, UsageEdge>();

  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile)) {
      continue;
    }

    const filePath = path.resolve(sourceFile.fileName);
    const repoRelativePath = getRepoRelativePath(filePath);
    const folderPath = toPosix(path.dirname(filePath));
    const folderRelativePath = path.dirname(repoRelativePath).replace(/\\/g, '/');

    for (const statement of sourceFile.statements) {
      const typeKind = getTypeKind(statement);
      const name = getNameText(statement);
      if (!typeKind || !name || !hasExportModifier(statement)) {
        continue;
      }

      if (typeKind !== 'class' && !TRACKED_TYPE_DIRS.some((prefix) => repoRelativePath.startsWith(prefix))) {
        continue;
      }

      const key = `${repoRelativePath}::${name}`;
      declarationByNode.set(statement, key);
      const start = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile));
      const end = sourceFile.getLineAndCharacterOfPosition(statement.getEnd());

      typeRows.set(key, {
        key,
        name,
        kind: typeKind,
        filePath: toPosix(filePath),
        repoRelativePath,
        folderPath,
        folderRelativePath,
        startLine: start.line + 1,
        startColumn: start.character,
        endLine: end.line + 1,
        endColumn: end.character,
        fieldCount: 0,
        utilityKind: getUtilityKind(name),
        contextCount: 0,
        hasApiUsage: false,
        hasStateUsage: false,
        hasUiUsage: false,
      });
    }
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile)) {
      continue;
    }

    const filePath = toPosix(path.resolve(sourceFile.fileName));
    const repoRelativePath = getRepoRelativePath(filePath);
    const usageContext = getContextKey(repoRelativePath);
    usageContexts.set(usageContext.key, usageContext);

    function walk(node: ts.Node) {
      if (ts.isTypeReferenceNode(node)) {
        const symbol = checker.getSymbolAtLocation(node.typeName);
        const resolved = symbol && ((symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol);
        for (const declaration of resolved?.declarations ?? []) {
          const typeKey = declarationByNode.get(declaration);
          if (!typeKey) {
            continue;
          }

          const edgeKey = `${typeKey}::${filePath}::${usageContext.key}`;
          const existing = usageCounter.get(edgeKey);
          if (existing) {
            existing.useCount += 1;
          } else {
            usageCounter.set(edgeKey, {
              typeKey,
              filePath,
              repoRelativePath,
              contextKey: usageContext.key,
              useCount: 1,
            });
          }
        }
      }

      ts.forEachChild(node, walk);
    }

    walk(sourceFile);
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile)) {
      continue;
    }

    for (const statement of sourceFile.statements) {
      const typeKey = declarationByNode.get(statement);
      if (!typeKey) {
        continue;
      }

      let orderIndex = 0;
      for (const member of getMemberNodes(statement)) {
        const memberName = 'name' in member && member.name && ts.isIdentifier(member.name) ? member.name.text : undefined;
        if (!memberName) {
          continue;
        }

        const typeNode = 'type' in member ? member.type : undefined;
        const fieldKey = `${typeKey}::${memberName}`;
        const ownerType = typeRows.get(typeKey);
        const analysis = typeNode ? buildFieldTypeAnalysis(checker, declarationByNode, typeNode) : undefined;
        fieldRows.push({
          key: fieldKey,
          typeKey,
          ownerTypeKey: typeKey,
          ownerName: ownerType?.name ?? getNameText(statement) ?? typeKey,
          ownerKind: ownerType?.kind ?? 'interface',
          ownerFilePath: ownerType?.filePath ?? toPosix(path.resolve(sourceFile.fileName)),
          ownerRepoRelativePath: ownerType?.repoRelativePath ?? getRepoRelativePath(path.resolve(sourceFile.fileName)),
          name: memberName,
          fieldKind: ts.SyntaxKind[member.kind],
          orderIndex,
          isOptional: 'questionToken' in member && Boolean(member.questionToken),
          typeText: typeNode?.getText(sourceFile),
          containerKind: analysis?.containerKind ?? 'direct',
          containerPath: analysis?.containerPath ?? 'direct',
          isCollectionContainer: analysis?.isCollectionContainer ?? false,
          isUnionContainer: analysis?.isUnionContainer ?? false,
          unionBranchCount: analysis?.unionBranchCount ?? 0,
          referencedTypeCount: analysis?.referencedTypeCount ?? 0,
        });

        if (analysis) {
          for (const ref of analysis.refs) {
            fieldRefRows.push({
              fieldKey,
              targetTypeKey: ref.targetTypeKey,
              relationKind: ref.relationKind,
              referenceRole: ref.referenceRole,
              containerKind: ref.containerKind,
              containerPath: ref.containerPath,
              variantRoles: ref.variantRoles,
              unionBranchCount: ref.unionBranchCount,
            });
          }
        }

        orderIndex += 1;
      }
    }
  }

  const fieldsByTypeKey = new Map<string, number>();
  for (const field of fieldRows) {
    fieldsByTypeKey.set(field.typeKey, (fieldsByTypeKey.get(field.typeKey) ?? 0) + 1);
  }

  const contextByTypeKey = new Map<string, Set<string>>();
  for (const usageEdge of usageCounter.values()) {
    if (!contextByTypeKey.has(usageEdge.typeKey)) {
      contextByTypeKey.set(usageEdge.typeKey, new Set());
    }
    contextByTypeKey.get(usageEdge.typeKey)!.add(usageEdge.contextKey);
  }

  for (const typeRow of typeRows.values()) {
    const fieldCount = fieldsByTypeKey.get(typeRow.key) ?? 0;
    const contexts = contextByTypeKey.get(typeRow.key) ?? new Set<string>();
    const hasApiUsage = ['api-method', 'builder', 'updater', 'api-model'].some((key) => contexts.has(key));
    const hasStateUsage = ['state', 'selector', 'reducer', 'action'].some((key) => contexts.has(key));
    const hasUiUsage = ['ui', 'hook'].some((key) => contexts.has(key));

    typeRow.fieldCount = fieldCount;
    typeRow.contextCount = contexts.size;
    typeRow.hasApiUsage = hasApiUsage;
    typeRow.hasStateUsage = hasStateUsage;
    typeRow.hasUiUsage = hasUiUsage;
  }

  const uniqueFieldRows = dedupeFields(fieldRows);
  const uniqueFieldRefRows = dedupeFieldTypeRefs(fieldRefRows);

  const payload: ExtractedPayload = {
    types: [...typeRows.values()].sort((left, right) => left.key.localeCompare(right.key)),
    fields: uniqueFieldRows.sort((left, right) => left.key.localeCompare(right.key)),
    fieldTypeRefs: uniqueFieldRefRows.sort((left, right) => `${left.fieldKey}::${left.targetTypeKey}::${left.relationKind}::${left.referenceRole}`.localeCompare(`${right.fieldKey}::${right.targetTypeKey}::${right.relationKind}::${right.referenceRole}`)),
    usageEdges: [...usageCounter.values()].sort((left, right) => `${left.typeKey}::${left.filePath}::${left.contextKey}`.localeCompare(`${right.typeKey}::${right.filePath}::${right.contextKey}`)),
    usageContexts: [...usageContexts.values()].sort((left, right) => left.key.localeCompare(right.key)),
  };

  process.stdout.write(JSON.stringify(payload));
}

main();
import projectPaths from '../../../dev/projectPaths.cjs';
