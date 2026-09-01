import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '@babel/parser';
import ts from 'typescript';

import { buildStableIdFromCoordinates } from '../../packages/runtime-core/src/stableId.js';

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(scriptPath), '..', '..', '..');

type BabelFunctionRecord = {
  endColumn: number;
  endLine: number;
  name: string;
  stableId: string;
  startColumn: number;
  startLine: number;
};

type ResolvedDeclarationTarget = {
  functionNode: ts.FunctionLikeDeclaration;
  name: string;
};

function toPosix(filePath: string) {
  return filePath.replace(/\\/g, '/');
}

function getRepoRelativePath(filePath: string) {
  return toPosix(path.relative(workspaceRoot, filePath));
}

function isSupportedCodeFile(filePath: string) {
  return /\.(cts|cjs|js|jsx|mts|mjs|ts|tsx)$/i.test(filePath);
}

function isBabelNode(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string';
}

function isBabelFunctionNode(node: Record<string, unknown>) {
  return node.type === 'ArrowFunctionExpression'
    || node.type === 'ClassMethod'
    || node.type === 'ClassPrivateMethod'
    || node.type === 'FunctionDeclaration'
    || node.type === 'FunctionExpression'
    || node.type === 'ObjectMethod';
}

function getBabelKeyName(key: unknown) {
  if (!isBabelNode(key)) {
    return undefined;
  }

  if (key.type === 'Identifier' || key.type === 'PrivateName') {
    const keyId = key as { id?: { name?: string }; name?: string };
    return keyId.name || keyId.id?.name;
  }

  if (key.type === 'StringLiteral' || key.type === 'NumericLiteral') {
    return String((key as { value?: unknown }).value ?? '');
  }

  return undefined;
}

function resolveBabelFunctionName(node: Record<string, unknown>, parent: Record<string, unknown> | undefined) {
  const nodeId = node.id;
  if (isBabelNode(nodeId) && nodeId.type === 'Identifier') {
    return String((nodeId as { name?: string }).name || 'anonymous');
  }

  if (!parent) {
    return 'anonymous';
  }

  if (parent.type === 'VariableDeclarator') {
    const parentId = parent.id;
    if (isBabelNode(parentId) && parentId.type === 'Identifier') {
      return String((parentId as { name?: string }).name || 'anonymous');
    }
  }

  if (parent.type === 'ObjectProperty' || parent.type === 'ObjectMethod' || parent.type === 'ClassMethod' || parent.type === 'ClassPrivateMethod') {
    return getBabelKeyName(parent.key) || 'anonymous';
  }

  if (parent.type === 'AssignmentExpression') {
    const left = parent.left;
    if (isBabelNode(left) && left.type === 'Identifier') {
      return String((left as { name?: string }).name || 'anonymous');
    }
  }

  return 'anonymous';
}

function collectBabelFunctionRecords(sourceFile: ts.SourceFile) {
  const absoluteFilePath = path.resolve(sourceFile.fileName);
  const code = fs.readFileSync(absoluteFilePath, 'utf8');
  const ast = parse(code, {
    sourceType: 'module',
    plugins: [
      'typescript',
      'jsx',
      'classProperties',
      'classPrivateProperties',
      'classPrivateMethods',
      'dynamicImport',
      'optionalChaining',
      'nullishCoalescingOperator',
    ],
  });
  const records: BabelFunctionRecord[] = [];

  function visit(current: unknown, parent?: Record<string, unknown>): void {
    if (!isBabelNode(current)) {
      return;
    }

    if (isBabelFunctionNode(current)) {
      const loc = current.loc as { end?: { column?: number; line?: number }; start?: { column?: number; line?: number } } | undefined;
      const startLine = Number(loc?.start?.line);
      const startColumn = Number(loc?.start?.column);
      const endLine = Number(loc?.end?.line);
      const endColumn = Number(loc?.end?.column);

      if (Number.isInteger(startLine)
        && Number.isInteger(startColumn)
        && Number.isInteger(endLine)
        && Number.isInteger(endColumn)) {
        records.push({
          name: resolveBabelFunctionName(current, parent),
          stableId: buildStableIdFromCoordinates({
            filePath: toPosix(absoluteFilePath),
            startLine,
            startColumn,
            endLine,
            endColumn,
          }),
          startLine,
          startColumn,
          endLine,
          endColumn,
        });
      }
    }

    for (const value of Object.values(current)) {
      if (Array.isArray(value)) {
        value.forEach((entry) => visit(entry, current));
        continue;
      }

      if (isBabelNode(value)) {
        visit(value, current);
      }
    }
  }

  visit(ast.program as unknown as Record<string, unknown>);

  return records;
}

function getLineAndColumn(sourceFile: ts.SourceFile, position: number) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(position);
  return {
    line: line + 1,
    column: character,
  };
}

function getPropertyNameText(name: ts.PropertyName | ts.MemberName) {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }

  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  if (ts.isComputedPropertyName(name)) {
    return 'anonymous';
  }

  return 'anonymous';
}

function unwrapTsExpression(expression: ts.Expression): ts.Expression {
  let current = expression;

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

function isFunctionLikeNode(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isArrowFunction(node)
    || ts.isConstructorDeclaration(node)
    || ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isMethodDeclaration(node)
    || ts.isSetAccessorDeclaration(node);
}

function getWrappedFunctionLike(expression: ts.Expression | undefined): ts.FunctionLikeDeclaration | undefined {
  if (!expression) {
    return undefined;
  }

  const current = unwrapTsExpression(expression);
  if (isFunctionLikeNode(current)) {
    return current;
  }

  if (ts.isCallExpression(current)) {
    for (const argument of current.arguments) {
      if (!ts.isExpression(argument)) {
        continue;
      }

      const wrapped = getWrappedFunctionLike(argument);
      if (wrapped) {
        return wrapped;
      }
    }
  }

  return undefined;
}

function getTsFunctionName(node: ts.FunctionLikeDeclaration) {
  if ('name' in node && node.name) {
    return getPropertyNameText(node.name);
  }

  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }

  if (parent && ts.isPropertyAssignment(parent)) {
    return getPropertyNameText(parent.name);
  }

  if (parent && ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    if (ts.isIdentifier(parent.left)) {
      return parent.left.text;
    }

    if (ts.isPropertyAccessExpression(parent.left)) {
      return parent.left.name.text;
    }
  }

  return 'anonymous';
}

function resolveDeclarationTarget(declaration: ts.Node): ResolvedDeclarationTarget | undefined {
  if (isFunctionLikeNode(declaration)) {
    return {
      functionNode: declaration,
      name: getTsFunctionName(declaration),
    };
  }

  if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
    const wrapped = getWrappedFunctionLike(declaration.initializer);
    if (wrapped) {
      return {
        functionNode: wrapped,
        name: declaration.name.text,
      };
    }
  }

  if (ts.isPropertyAssignment(declaration)) {
    const wrapped = getWrappedFunctionLike(declaration.initializer);
    if (wrapped) {
      return {
        functionNode: wrapped,
        name: getPropertyNameText(declaration.name),
      };
    }
  }

  return undefined;
}

function resolveStableIdFromBabelRecord(sourceFile: ts.SourceFile, declaration: ts.Node, records: BabelFunctionRecord[]) {
  const target = resolveDeclarationTarget(declaration);
  if (!target) {
    return undefined;
  }

  const start = getLineAndColumn(sourceFile, target.functionNode.getStart(sourceFile));
  const end = getLineAndColumn(sourceFile, target.functionNode.getEnd());
  const matchingByEnd = records.filter((record) => record.endLine === end.line && record.endColumn === end.column);
  const matchingByName = matchingByEnd.filter((record) => record.name === target.name);
  const candidatePool = matchingByName.length ? matchingByName : matchingByEnd;
  const matchingByStartLine = candidatePool.filter((record) => record.startLine === start.line);

  if (matchingByStartLine.length === 1) {
    return matchingByStartLine[0].stableId;
  }

  if (candidatePool.length === 1) {
    return candidatePool[0].stableId;
  }

  if (!candidatePool.length) {
    return undefined;
  }

  const closestByStartColumn = [...candidatePool].sort((left, right) => {
    const leftDistance = Math.abs(left.startColumn - start.column);
    const rightDistance = Math.abs(right.startColumn - start.column);
    if (leftDistance !== rightDistance) {
      return leftDistance - rightDistance;
    }

    return left.startColumn - right.startColumn;
  });

  return closestByStartColumn[0]?.stableId;
}

export function buildBabelStableIdByDeclaration(
  program: ts.Program,
  shouldTrackSourceFile: (sourceFile: ts.SourceFile) => boolean,
  fallbackResolver?: (sourceFile: ts.SourceFile, declaration: ts.Node) => string | undefined,
) {
  const stableIdByDeclaration = new Map<ts.Node, string>();
  const checker = program.getTypeChecker();

  for (const sourceFile of program.getSourceFiles()) {
    if (!shouldTrackSourceFile(sourceFile)) {
      continue;
    }

    if (!isSupportedCodeFile(sourceFile.fileName)) {
      continue;
    }

    const records = collectBabelFunctionRecords(sourceFile);

    function register(current: ts.Node): void {
      const stableId = resolveStableIdFromBabelRecord(sourceFile, current, records)
        || fallbackResolver?.(sourceFile, current);

      if (stableId) {
        stableIdByDeclaration.set(current, stableId);
      }

      ts.forEachChild(current, register);
    }

    register(sourceFile);
  }

  // Resolved call signatures often point at an overload declaration without a
  // body. All declarations of that symbol must identify the executable
  // implementation, otherwise edges target nodes that cannot exist.
  for (const sourceFile of program.getSourceFiles()) {
    if (!shouldTrackSourceFile(sourceFile)) continue;

    function bindOverloadToImplementation(current: ts.Node): void {
      if (
        (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current))
        && !current.body
        && current.name
      ) {
        const symbol = checker.getSymbolAtLocation(current.name);
        const implementation = symbol?.declarations?.find((declaration) => (
          (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration))
          && Boolean(declaration.body)
        ));
        const implementationStableId = implementation
          ? stableIdByDeclaration.get(implementation)
          : undefined;
        if (implementationStableId) {
          stableIdByDeclaration.set(current, implementationStableId);
        }
      }

      ts.forEachChild(current, bindOverloadToImplementation);
    }

    bindOverloadToImplementation(sourceFile);
  }

  return stableIdByDeclaration;
}
