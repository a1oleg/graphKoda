import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { resolveProjectGitRevision } from '../../../dev/load-env.mjs';
import { buildStableIdDescriptor, buildStableIdFromCoordinates } from '../../packages/runtime-core/src/stableId.js';
import { buildBabelStableIdByDeclaration } from './babelStableIdByDeclaration.js';

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(scriptPath), '..', '..', '..');
const tsconfigPath = path.join(workspaceRoot, 'tsconfig.json');

function runGitText(args: string[]) {
  return execFileSync('git', args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function resolveSourceStateId() {
  try {
    const headRevision = runGitText(['rev-parse', '--short=12', 'HEAD']);
    const dirtyStatus = runGitText(['status', '--short', '--untracked-files=all', '--', '.']);

    if (!dirtyStatus) {
      return headRevision;
    }

    const dirtyDiff = runGitText(['diff', '--no-ext-diff', '--binary', 'HEAD', '--', '.']);
    const dirtyFingerprint = createHash('sha1')
      .update(`${dirtyStatus}\n${dirtyDiff}`)
      .digest('hex')
      .slice(0, 12);

    return `${headRevision}+dirty.${dirtyFingerprint}`;
  } catch {
    return resolveProjectGitRevision();
  }
}

let sourceStateId = resolveSourceStateId();

/** Refreshes provenance after a long-lived extractor rebuilds its Program. */
export function refreshSourceStateId() {
  sourceStateId = resolveSourceStateId();
  return sourceStateId;
}

export type StableIdDescriptor = {
  value: string;
  sourceStateId?: string;
  filePath?: string;
  repoRelativePath?: string;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
  suffix?: string;
};

const SKIP_PATH_FRAGMENTS = [
  '/node_modules/',
  '/dist/',
  '/build/',
  '/.venv/',
  '/site-packages/',
  '/graph/',
  '/src/lib/gramjs/tl/',
];

function resolveTrackedSourceRoots() {
  const rawSourceRoots = process.env.GRAPH_EXTRACT_SOURCE_ROOTS;
  if (rawSourceRoots?.trim()) {
    return rawSourceRoots
      .split(/[;,]/g)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => toPosix(path.resolve(workspaceRoot, entry)));
  }

  const srcRoot = path.join(workspaceRoot, 'src');
  return [toPosix(fs.existsSync(srcRoot) ? srcRoot : workspaceRoot)];
}

const TRACKED_SOURCE_ROOTS = resolveTrackedSourceRoots();

const formatHost: ts.FormatDiagnosticsHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => workspaceRoot,
  getNewLine: () => '\n',
};

function isFunctionLikeNode(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node);
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
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

function getStableIdStartPosition(sourceFile: ts.SourceFile, node: ts.Node) {
  let position = node.getStart(sourceFile);

  if (!isFunctionLikeNode(node) || !node.modifiers?.length) {
    return position;
  }

  let skippedModifierEnd: number | undefined;
  for (const modifier of node.modifiers) {
    if (modifier.kind !== ts.SyntaxKind.ExportKeyword && modifier.kind !== ts.SyntaxKind.DefaultKeyword) {
      break;
    }

    skippedModifierEnd = modifier.getEnd();
  }

  if (skippedModifierEnd === undefined) {
    return position;
  }

  position = skippedModifierEnd;
  while (position < sourceFile.text.length && /\s/.test(sourceFile.text[position])) {
    position += 1;
  }

  return position;
}

function getWrappedFunctionLike(expression: ts.Expression | undefined): ts.FunctionLikeDeclaration | undefined {
  if (!expression) {
    return undefined;
  }

  const current = unwrapExpression(expression);
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

function resolveStableIdForDeclaration(sourceFile: ts.SourceFile, declaration: ts.Node) {
  if (isFunctionLikeNode(declaration)) {
    return getStableId(sourceFile, declaration);
  }
  if (ts.isVariableDeclaration(declaration)) {
    const wrapped = getWrappedFunctionLike(declaration.initializer);
    if (wrapped) {
      return getStableId(sourceFile, wrapped);
    }
  }
  if (ts.isPropertyAssignment(declaration)) {
    const wrapped = getWrappedFunctionLike(declaration.initializer);
    if (wrapped) {
      return getStableId(sourceFile, wrapped);
    }
  }

  return undefined;
}

export function toPosix(filePath: string) {
  return filePath.replace(/\\/g, '/');
}

export function getRepoRelativePath(filePath: string) {
  return toPosix(path.relative(workspaceRoot, filePath));
}

export function createProgram(oldProgram?: ts.Program) {
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
    oldProgram,
  });
}

export function isTrackedSourceFile(sourceFile: ts.SourceFile) {
  if (sourceFile.isDeclarationFile) {
    return false;
  }

  const normalized = toPosix(sourceFile.fileName);
  if (!TRACKED_SOURCE_ROOTS.some((sourceRoot) => normalized === sourceRoot || normalized.startsWith(`${sourceRoot}/`))) {
    return false;
  }

  if (normalized.endsWith('.cjs')) {
    return false;
  }

  return !SKIP_PATH_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

export function getLineAndColumn(sourceFile: ts.SourceFile, position: number) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(position);
  return {
    line: line + 1,
    column: character,
  };
}

export function getRange(sourceFile: ts.SourceFile, node: ts.Node) {
  const start = getLineAndColumn(sourceFile, node.getStart(sourceFile));
  const end = getLineAndColumn(sourceFile, node.getEnd());
  return {
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
}

export function getStableId(sourceFile: ts.SourceFile, node: ts.Node) {
  const start = getLineAndColumn(sourceFile, getStableIdStartPosition(sourceFile, node));
  const endPosition = Math.max(getStableIdStartPosition(sourceFile, node), node.getEnd());
  const end = getLineAndColumn(sourceFile, endPosition);
  return buildStableIdFromCoordinates({
    filePath: toPosix(path.resolve(sourceFile.fileName)),
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  });
}

export function buildStableIdDescriptorFromValue(
  stableId: string,
  options: Omit<StableIdDescriptor, 'value' | 'sourceStateId'> = {},
) {
  return buildStableIdDescriptor(stableId, {
    sourceStateId,
    ...options,
  }) as StableIdDescriptor;
}

export function buildOpaqueStableIdDescriptor(stableId: string, repoRelativePath?: string, filePath?: string) {
  return buildStableIdDescriptorFromValue(stableId, {
    repoRelativePath,
    filePath,
  });
}

export function getStableIdDescriptor(sourceFile: ts.SourceFile, node: ts.Node) {
  const start = getLineAndColumn(sourceFile, getStableIdStartPosition(sourceFile, node));
  const endPosition = Math.max(getStableIdStartPosition(sourceFile, node), node.getEnd());
  const end = getLineAndColumn(sourceFile, endPosition);
  const absoluteFilePath = path.resolve(sourceFile.fileName);

  return buildStableIdDescriptorFromValue(getStableId(sourceFile, node), {
    filePath: toPosix(absoluteFilePath),
    repoRelativePath: getRepoRelativePath(absoluteFilePath),
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  });
}

export function getExtendedStableId(sourceFile: ts.SourceFile, node: ts.Node, endLine?: number, endColumn?: number) {
  const start = getLineAndColumn(sourceFile, getStableIdStartPosition(sourceFile, node));
  const end = endLine !== undefined && endColumn !== undefined
    ? { line: endLine, column: endColumn }
    : getLineAndColumn(sourceFile, node.getEnd());
  return buildStableIdFromCoordinates({
    filePath: toPosix(path.resolve(sourceFile.fileName)),
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  });
}

export function getExtendedStableIdDescriptor(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  endLine?: number,
  endColumn?: number,
) {
  const start = getLineAndColumn(sourceFile, getStableIdStartPosition(sourceFile, node));
  const end = endLine !== undefined && endColumn !== undefined
    ? { line: endLine, column: endColumn }
    : getLineAndColumn(sourceFile, node.getEnd());
  const absoluteFilePath = path.resolve(sourceFile.fileName);

  return buildStableIdDescriptorFromValue(getExtendedStableId(sourceFile, node, endLine, endColumn), {
    filePath: toPosix(absoluteFilePath),
    repoRelativePath: getRepoRelativePath(absoluteFilePath),
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  });
}

export function buildStableIdByDeclaration(program: ts.Program) {
  return buildBabelStableIdByDeclaration(program, isTrackedSourceFile, resolveStableIdForDeclaration);
}

export function parseFnStableIdArgs(args = process.argv.slice(2)) {
  const result: {
    fnStableId?: string;
    fnName?: string;
    metadataOnly?: boolean;
    outputPath?: string;
    outputFormat?: string;
    auditIdentities?: boolean;
    stagingPath?: string;
    parquetDir?: string;
  } = {};

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--fn-stable-id') {
      result.fnStableId = args[index + 1];
      index += 1;
      continue;
    }

    if (args[index] === '--fn-name') {
      result.fnName = args[index + 1];
      index += 1;
      continue;
    }

    if (args[index] === '--metadata-only') {
      result.metadataOnly = true;
      continue;
    }

    if (args[index] === '--output-path') {
      result.outputPath = args[index + 1];
      index += 1;
      continue;
    }

    if (args[index] === '--output-format') {
      result.outputFormat = args[index + 1];
      index += 1;
      continue;
    }

    if (args[index] === '--staging-path') {
      result.stagingPath = args[index + 1];
      index += 1;
      continue;
    }

    if (args[index] === '--parquet-dir') {
      result.parquetDir = args[index + 1];
      index += 1;
      continue;
    }

    if (args[index] === '--audit-identities') {
      result.auditIdentities = true;
    }
  }

  return result;
}
