import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

type TypeNodeRow = {
  key: string;
  name: string;
  kind: 'interface' | 'typeAlias' | 'class';
  filePath: string;
  repoRelativePath: string;
};

type TypeEdgeRow = {
  parentTypeKey: string;
  childTypeKey: string;
  fieldPath: string;
  fieldName: string;
  relationKind: 'CONTAINS_TYPE';
  containerKind: 'single' | 'array' | 'map' | 'set' | 'record';
};

type ExtractedPayload = {
  nodes: TypeNodeRow[];
  edges: TypeEdgeRow[];
};

type OwnerDeclaration = {
  typeKey: string;
  name: string;
  kind: 'interface' | 'typeAlias' | 'class';
  filePath: string;
  repoRelativePath: string;
  declaration: ts.DeclarationStatement;
};

type ChildReference = {
  typeKey: string;
  containerKind: TypeEdgeRow['containerKind'];
};

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
const WRAPPER_TYPE_NAMES = new Set([
  'Array',
  'ReadonlyArray',
  'Set',
  'Map',
  'Record',
  'Partial',
  'Required',
  'Pick',
  'Omit',
  'Exclude',
  'Extract',
  'Promise',
  'NonNullable',
]);
const PRIMITIVE_TYPE_NAMES = new Set([
  'any', 'bigint', 'boolean', 'never', 'null', 'number', 'object', 'string', 'symbol', 'undefined', 'unknown', 'void',
]);

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

function createProgram() {
  const configText = fs.readFileSync(tsconfigPath, 'utf8');
  const parsedConfig = ts.parseConfigFileTextToJson(tsconfigPath, configText);
  const config = ts.parseJsonConfigFileContent(parsedConfig.config, ts.sys, workspaceRoot);
  return ts.createProgram({ rootNames: config.fileNames, options: config.options });
}

function hasExportModifier(node: ts.Node) {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
}

function getOwnerKind(node: ts.Node): OwnerDeclaration['kind'] | undefined {
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'typeAlias';
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

function buildTrackedOwners(program: ts.Program) {
  const owners: OwnerDeclaration[] = [];
  const declarationByNode = new Map<ts.Declaration, OwnerDeclaration>();

  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile)) {
      continue;
    }

    const filePath = toPosix(path.resolve(sourceFile.fileName));
    const repoRelativePath = getRepoRelativePath(filePath);
    if (!TRACKED_OWNER_DIRS.some((prefix) => repoRelativePath.startsWith(prefix))) {
      continue;
    }

    for (const statement of sourceFile.statements) {
      const kind = getOwnerKind(statement);
      const name = getNameText(statement);
      if (!kind || !name || !hasExportModifier(statement)) {
        continue;
      }

      const owner = {
        typeKey: `${repoRelativePath}::${name}`,
        name,
        kind,
        filePath,
        repoRelativePath,
        declaration: statement,
      } satisfies OwnerDeclaration;
      owners.push(owner);
      declarationByNode.set(statement, owner);
    }
  }

  return { owners, declarationByNode };
}

function mergeContainerKind(left: TypeEdgeRow['containerKind'], right: TypeEdgeRow['containerKind']): TypeEdgeRow['containerKind'] {
  if (left === right) {
    return left;
  }

  const rank = { single: 0, set: 1, array: 2, map: 3, record: 4 };
  return rank[left] >= rank[right] ? left : right;
}

function extractChildReferences(
  checker: ts.TypeChecker,
  declarationByNode: Map<ts.Declaration, OwnerDeclaration>,
  node: ts.TypeNode,
  containerKind: TypeEdgeRow['containerKind'] = 'single',
  visited = new Set<ts.Declaration>(),
): ChildReference[] {
  if (ts.isParenthesizedTypeNode(node)) {
    return extractChildReferences(checker, declarationByNode, node.type, containerKind, visited);
  }

  if (ts.isArrayTypeNode(node)) {
    return extractChildReferences(checker, declarationByNode, node.elementType, mergeContainerKind(containerKind, 'array'), visited);
  }

  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    return node.types.flatMap((child) => extractChildReferences(checker, declarationByNode, child, containerKind, visited));
  }

  if (ts.isTypeLiteralNode(node)) {
    return [];
  }

  if (ts.isTypeReferenceNode(node)) {
    const typeNameText = node.typeName.getText();
    if (WRAPPER_TYPE_NAMES.has(typeNameText)) {
      const typeArgs = node.typeArguments || [];
      if (typeNameText === 'Set') {
        return typeArgs.flatMap((child) => extractChildReferences(checker, declarationByNode, child, mergeContainerKind(containerKind, 'set'), visited));
      }
      if (typeNameText === 'Map' || typeNameText === 'Record') {
        return typeArgs.slice(1).flatMap((child) => extractChildReferences(checker, declarationByNode, child, mergeContainerKind(containerKind, typeNameText === 'Map' ? 'map' : 'record'), visited));
      }
      return typeArgs.flatMap((child) => extractChildReferences(checker, declarationByNode, child, containerKind, visited));
    }

    if (PRIMITIVE_TYPE_NAMES.has(typeNameText)) {
      return [];
    }

    const symbol = checker.getSymbolAtLocation(node.typeName);
    const resolved = symbol && ((symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol);
    for (const declaration of resolved?.declarations ?? []) {
      if (visited.has(declaration)) {
        continue;
      }

      const owner = declarationByNode.get(declaration);
      if (owner) {
        return [{ typeKey: owner.typeKey, containerKind }];
      }

      visited.add(declaration);
      if (ts.isTypeAliasDeclaration(declaration)) {
        const references = extractChildReferences(checker, declarationByNode, declaration.type, containerKind, visited);
        if (references.length) {
          return references;
        }
      }
    }
  }

  return [];
}

function extractTypeContainment(program: ts.Program): ExtractedPayload {
  const checker = program.getTypeChecker();
  const { owners, declarationByNode } = buildTrackedOwners(program);
  const nodes = owners.map((owner) => ({
    key: owner.typeKey,
    name: owner.name,
    kind: owner.kind,
    filePath: owner.filePath,
    repoRelativePath: owner.repoRelativePath,
  }));
  const edgeByKey = new Map<string, TypeEdgeRow>();

  for (const owner of owners) {
    function walkMembers(container: ts.Node, pathSegments: string[]) {
      for (const member of getTypeMembers(container)) {
        const fieldName = getPropertyName(member);
        if (!fieldName) {
          continue;
        }

        const typeNode = getPropertyTypeNode(member);
        if (!typeNode) {
          continue;
        }

        const nextPathSegments = [...pathSegments, fieldName];
        const references = extractChildReferences(checker, declarationByNode, typeNode);
        references.forEach((reference) => {
          if (reference.typeKey === owner.typeKey) {
            return;
          }
          const edgeKey = `${owner.typeKey}::${reference.typeKey}::${nextPathSegments.join('.')}`;
          edgeByKey.set(edgeKey, {
            parentTypeKey: owner.typeKey,
            childTypeKey: reference.typeKey,
            fieldPath: nextPathSegments.join('.'),
            fieldName,
            relationKind: 'CONTAINS_TYPE',
            containerKind: reference.containerKind,
          });
        });

        if (ts.isTypeLiteralNode(typeNode)) {
          walkMembers(typeNode, nextPathSegments);
        }
      }
    }

    walkMembers(owner.declaration, []);
  }

  return {
    nodes: nodes.sort((left, right) => left.key.localeCompare(right.key)),
    edges: [...edgeByKey.values()].sort((left, right) => {
      const leftKey = `${left.parentTypeKey}::${left.fieldPath}::${left.childTypeKey}`;
      const rightKey = `${right.parentTypeKey}::${right.fieldPath}::${right.childTypeKey}`;
      return leftKey.localeCompare(rightKey);
    }),
  };
}

function main() {
  const program = createProgram();
  const payload = extractTypeContainment(program);
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

main();
import projectPaths from '../../../dev/projectPaths.cjs';
