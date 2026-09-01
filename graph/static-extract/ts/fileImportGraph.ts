import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

type FileImportRow = {
  key: string;
  fromFilePath: string;
  fromRepoRelativePath: string;
  toFilePath: string;
  toRepoRelativePath: string;
  moduleSpecifier: string;
  importKind: 'import' | 'export-from' | 'dynamic-import' | 'require';
  clauseKind: 'default' | 'named' | 'namespace' | 'side-effect' | 're-export' | 'expression';
  isTypeOnly: boolean;
  line: number;
  column: number;
};

type PackageImportRow = {
  key: string;
  fromFilePath: string;
  fromRepoRelativePath: string;
  packageName: string;
  moduleSpecifier: string;
  importKind: 'import' | 'export-from' | 'dynamic-import' | 'require';
  clauseKind: 'default' | 'named' | 'namespace' | 'side-effect' | 're-export' | 'expression';
  isTypeOnly: boolean;
  line: number;
  column: number;
};

type ExtractedPayload = {
  fileImports: FileImportRow[];
  packageImports: PackageImportRow[];
};

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(scriptPath), '..', '..', '..');
const tsconfigPath = path.join(workspaceRoot, 'tsconfig.json');

const SKIP_PATH_FRAGMENTS = [
  '/node_modules/',
  '/dist/',
  '/build/',
  '/src/lib/gramjs/tl/',
];

const MODULE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mts',
  '.cts',
  '.mjs',
  '.cjs',
];

const NODE_BUILTIN_PREFIX = 'node:';
const NODE_BUILTIN_MODULES = new Set(
  builtinModules.flatMap((moduleName) => [moduleName, moduleName.replace(/^node:/, '')]),
);

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

function isTrackedPath(filePath: string) {
  const normalized = toPosix(path.resolve(filePath));
  if (!normalized.startsWith(toPosix(path.join(workspaceRoot, 'src')))) {
    return false;
  }

  return !SKIP_PATH_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function isTrackedSourceFile(sourceFile: ts.SourceFile) {
  if (sourceFile.isDeclarationFile) {
    return false;
  }

  return isTrackedPath(sourceFile.fileName);
}

function getLineAndColumn(sourceFile: ts.SourceFile, position: number) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(position);
  return {
    line: line + 1,
    column: character,
  };
}

function normalizeResolvedPath(fileName: string) {
  const normalized = toPosix(path.resolve(fileName));

  if (normalized.endsWith('.d.ts')) {
    return undefined;
  }

  return normalized;
}

function resolveCandidatePath(candidatePath: string) {
  const normalizedCandidate = toPosix(path.resolve(candidatePath));
  if (fs.existsSync(normalizedCandidate) && fs.statSync(normalizedCandidate).isFile()) {
    return normalizedCandidate;
  }

  for (const extension of MODULE_EXTENSIONS) {
    const withExtension = `${normalizedCandidate}${extension}`;
    if (fs.existsSync(withExtension) && fs.statSync(withExtension).isFile()) {
      return withExtension;
    }
  }

  for (const extension of MODULE_EXTENSIONS) {
    const asIndex = path.join(normalizedCandidate, `index${extension}`);
    if (fs.existsSync(asIndex) && fs.statSync(asIndex).isFile()) {
      return toPosix(asIndex);
    }
  }

  return undefined;
}

function resolveInternalModule(
  moduleSpecifier: string,
  sourceFile: ts.SourceFile,
  program: ts.Program,
  compilerOptions: ts.CompilerOptions,
) {
  const host = ts.createCompilerHost(compilerOptions, true);
  const resolved = ts.resolveModuleName(moduleSpecifier, sourceFile.fileName, compilerOptions, host).resolvedModule;
  const resolvedPath = resolved?.resolvedFileName ? normalizeResolvedPath(resolved.resolvedFileName) : undefined;
  if (resolvedPath && isTrackedPath(resolvedPath)) {
    return resolvedPath;
  }

  const sourceDir = path.dirname(sourceFile.fileName);
  if (moduleSpecifier.startsWith('.')) {
    const fallbackPath = resolveCandidatePath(path.resolve(sourceDir, moduleSpecifier));
    if (fallbackPath && isTrackedPath(fallbackPath)) {
      return fallbackPath;
    }
    return undefined;
  }

  const match = program.getSourceFiles().find((candidate) => {
    if (!isTrackedSourceFile(candidate)) {
      return false;
    }

    const candidatePath = normalizeResolvedPath(candidate.fileName);
    if (!candidatePath) {
      return false;
    }

    const repoRelativePath = getRepoRelativePath(candidatePath);
    const withoutExtension = repoRelativePath.replace(/\.[^.]+$/, '');
    return moduleSpecifier === withoutExtension || moduleSpecifier === repoRelativePath;
  });

  return match ? normalizeResolvedPath(match.fileName) : undefined;
}

function extractPackageName(moduleSpecifier: string) {
  const normalizedSpecifier = moduleSpecifier.trim();
  if (!normalizedSpecifier || normalizedSpecifier.startsWith('.') || normalizedSpecifier.startsWith('/')) {
    return undefined;
  }
  if (normalizedSpecifier.startsWith(NODE_BUILTIN_PREFIX)) {
    return undefined;
  }

  const parts = normalizedSpecifier.split('/').filter(Boolean);
  if (!parts.length) {
    return undefined;
  }

  const builtinCandidate = normalizedSpecifier.startsWith('@') ? normalizedSpecifier : parts[0];
  if (NODE_BUILTIN_MODULES.has(builtinCandidate)) {
    return undefined;
  }

  if (normalizedSpecifier.startsWith('@')) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined;
  }

  return parts[0];
}

function getImportClauseKind(node: ts.ImportDeclaration): FileImportRow['clauseKind'] {
  const clause = node.importClause;
  if (!clause) {
    return 'side-effect';
  }
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
    return 'namespace';
  }
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    return clause.name ? 'default' : 'named';
  }
  if (clause.name) {
    return 'default';
  }

  return 'expression';
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

function extractFileImports(program: ts.Program) {
  const rows: FileImportRow[] = [];
  const packageRows: PackageImportRow[] = [];
  const seenKeys = new Set<string>();
  const seenPackageKeys = new Set<string>();
  const compilerOptions = program.getCompilerOptions();

  function pushRow(row: FileImportRow) {
    if (seenKeys.has(row.key)) {
      return;
    }

    seenKeys.add(row.key);
    rows.push(row);
  }

  function pushPackageRow(row: PackageImportRow) {
    if (seenPackageKeys.has(row.key)) {
      return;
    }

    seenPackageKeys.add(row.key);
    packageRows.push(row);
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile)) {
      continue;
    }

    const fromFilePath = toPosix(path.resolve(sourceFile.fileName));
    const fromRepoRelativePath = getRepoRelativePath(fromFilePath);

    function registerImport(
      moduleSpecifier: string,
      importKind: FileImportRow['importKind'],
      clauseKind: FileImportRow['clauseKind'],
      isTypeOnly: boolean,
      positionNode: ts.Node,
    ) {
      const start = getLineAndColumn(sourceFile, positionNode.getStart(sourceFile));
      const resolvedPath = resolveInternalModule(moduleSpecifier, sourceFile, program, compilerOptions);
      if (resolvedPath && resolvedPath !== fromFilePath) {
        const toRepoRelativePath = getRepoRelativePath(resolvedPath);
        pushRow({
          key: `${fromFilePath}:${start.line}:${start.column}:${importKind}:${moduleSpecifier}:${resolvedPath}`,
          fromFilePath,
          fromRepoRelativePath,
          toFilePath: resolvedPath,
          toRepoRelativePath,
          moduleSpecifier,
          importKind,
          clauseKind,
          isTypeOnly,
          line: start.line,
          column: start.column,
        });
        return;
      }

      const packageName = extractPackageName(moduleSpecifier);
      if (!packageName) {
        return;
      }

      pushPackageRow({
        key: `${fromFilePath}:${start.line}:${start.column}:${importKind}:${moduleSpecifier}:${packageName}`,
        fromFilePath,
        fromRepoRelativePath,
        packageName,
        moduleSpecifier,
        importKind,
        clauseKind,
        isTypeOnly,
        line: start.line,
        column: start.column,
      });
    }

    function visit(node: ts.Node): void {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        registerImport(
          node.moduleSpecifier.text,
          'import',
          getImportClauseKind(node),
          Boolean(node.importClause?.isTypeOnly),
          node.moduleSpecifier,
        );
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        registerImport(
          node.moduleSpecifier.text,
          'export-from',
          're-export',
          Boolean(node.isTypeOnly),
          node.moduleSpecifier,
        );
      } else if (ts.isCallExpression(node)) {
        const [firstArgument] = node.arguments;
        if (!firstArgument || !ts.isStringLiteral(firstArgument)) {
          ts.forEachChild(node, visit);
          return;
        }

        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          registerImport(firstArgument.text, 'dynamic-import', 'expression', false, firstArgument);
        } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
          registerImport(firstArgument.text, 'require', 'expression', false, firstArgument);
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  rows.sort((left, right) => {
    if (left.fromFilePath !== right.fromFilePath) {
      return left.fromFilePath.localeCompare(right.fromFilePath);
    }
    if (left.line !== right.line) {
      return left.line - right.line;
    }
    if (left.column !== right.column) {
      return left.column - right.column;
    }
    return left.key.localeCompare(right.key);
  });

  packageRows.sort((left, right) => {
    if (left.fromFilePath !== right.fromFilePath) {
      return left.fromFilePath.localeCompare(right.fromFilePath);
    }
    if (left.line !== right.line) {
      return left.line - right.line;
    }
    if (left.column !== right.column) {
      return left.column - right.column;
    }
    return left.key.localeCompare(right.key);
  });

  return {
    fileImports: rows,
    packageImports: packageRows,
  };
}

function main() {
  const program = createProgram();
  const payload = extractFileImports(program);

  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

main();