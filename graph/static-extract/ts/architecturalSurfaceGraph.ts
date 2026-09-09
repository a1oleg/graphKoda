import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import {
  createProgram,
  getRepoRelativePath,
  getStableId,
  isTrackedSourceFile,
  toPosix,
} from './functionFlowGraph.infrastructure.js';

type ArchitecturalLayerKind = 'ui' | 'hooks' | 'state' | 'api' | 'shared' | 'other';

type ArchitecturalSurfaceRow = {
  key: string;
  label: string;
  surfaceKind: 'architectural-layer' | 'architectural-module-surface';
  layerKind: ArchitecturalLayerKind;
  parentSurfaceKey?: string;
  repoRelativePath?: string;
  folderRelativePath?: string;
  sourceFileCount: number;
  functionCount: number;
  importOutCount: number;
  importInCount: number;
};

type ArchitecturalSurfaceContainmentEdgeRow = {
  parentSurfaceKey: string;
  childSurfaceKey: string;
};

type ArchitecturalSurfaceFunctionMemberRow = {
  surfaceKey: string;
  ownerStableId: string;
  ownerName: string;
  ownerFilePath: string;
  ownerRepoRelativePath: string;
};

type ArchitecturalSurfaceDependencyEdgeRow = {
  fromSurfaceKey: string;
  toSurfaceKey: string;
  dependencyKind: 'imports';
  importCount: number;
};

type ExtractedPayload = {
  surfaces: ArchitecturalSurfaceRow[];
  surfaceContainmentEdges: ArchitecturalSurfaceContainmentEdgeRow[];
  surfaceFunctionMembers: ArchitecturalSurfaceFunctionMemberRow[];
  surfaceDependencyEdges: ArchitecturalSurfaceDependencyEdgeRow[];
};

type ModuleSurfaceStat = {
  key: string;
  label: string;
  layerKind: ArchitecturalLayerKind;
  parentSurfaceKey: string;
  repoRelativePath: string;
  folderRelativePath: string;
  sourceFiles: Set<string>;
  functionStableIds: Set<string>;
};

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = projectPaths.sourceRoot;

const SKIP_PATH_FRAGMENTS = [
  '/node_modules/',
  '/dist/',
  '/build/',
  '/src/lib/gramjs/tl/',
];

function getPropertyNameText(name: ts.PropertyName | ts.BindingName | undefined) {
  if (!name) {
    return undefined;
  }

  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  return undefined;
}

function getFunctionName(node: ts.FunctionLikeDeclaration) {
  if ('name' in node && node.name) {
    const directName = getPropertyNameText(node.name);
    if (directName) {
      return directName;
    }
  }

  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent)) {
    return getPropertyNameText(parent.name);
  }
  if (parent && ts.isPropertyAssignment(parent)) {
    return getPropertyNameText(parent.name);
  }
  if (parent && ts.isBinaryExpression(parent) && ts.isIdentifier(parent.left)) {
    return parent.left.text;
  }

  return undefined;
}

function detectLayerKind(repoRelativePath: string): ArchitecturalLayerKind {
  if (
    repoRelativePath === 'src/index.tsx'
    || repoRelativePath === 'src/index.html'
    || repoRelativePath.startsWith('src/components/')
    || repoRelativePath.startsWith('src/bundles/')
  ) {
    return 'ui';
  }

  if (repoRelativePath.startsWith('src/hooks/')) {
    return 'hooks';
  }

  if (repoRelativePath.startsWith('src/global/')) {
    return 'state';
  }

  if (repoRelativePath.startsWith('src/api/')) {
    return 'api';
  }

  if (
    repoRelativePath.startsWith('src/lib/')
    || repoRelativePath.startsWith('src/util/')
    || repoRelativePath.startsWith('src/assets/')
    || repoRelativePath === 'src/config.ts'
    || repoRelativePath === 'src/limits.ts'
  ) {
    return 'shared';
  }

  return 'other';
}

function sliceFolderSegments(repoRelativePath: string) {
  const segments = repoRelativePath.split('/').filter(Boolean);
  if (segments.length <= 1) {
    return segments;
  }

  const folderSegments = segments.slice(0, -1);
  if (folderSegments[0] !== 'src') {
    return folderSegments.slice(0, Math.min(folderSegments.length, 3));
  }

  if (folderSegments[1] === 'components') {
    return folderSegments.slice(0, Math.min(folderSegments.length, 3));
  }

  if (folderSegments[1] === 'global') {
    return folderSegments.slice(0, Math.min(folderSegments.length, 4));
  }

  if (folderSegments[1] === 'api') {
    return folderSegments.slice(0, Math.min(folderSegments.length, 4));
  }

  if (folderSegments[1] === 'hooks') {
    return folderSegments.slice(0, 2);
  }

  if (folderSegments[1] === 'lib' || folderSegments[1] === 'util' || folderSegments[1] === 'assets') {
    return folderSegments.slice(0, Math.min(folderSegments.length, 3));
  }

  return folderSegments.slice(0, Math.min(folderSegments.length, 3));
}

function deriveModuleSurfacePath(repoRelativePath: string) {
  const segments = sliceFolderSegments(repoRelativePath);
  return segments.join('/');
}

function buildLayerSurfaceKey(layerKind: ArchitecturalLayerKind) {
  return `architectural-layer:${layerKind}`;
}

function buildModuleSurfaceKey(surfacePath: string) {
  return `architectural-surface:${surfacePath}`;
}

function buildSurfaceLabel(surfacePath: string, surfaceKind: ArchitecturalSurfaceRow['surfaceKind']) {
  if (surfaceKind === 'architectural-layer') {
    return surfacePath.toUpperCase();
  }

  return surfacePath.replace(/^src\//, '');
}

function collectImportSpecifiers(sourceFile: ts.SourceFile) {
  const specifiers: string[] = [];

  for (const statement of sourceFile.statements) {
    if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      specifiers.push(statement.moduleSpecifier.text);
      continue;
    }

    if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference) && ts.isStringLiteral(statement.moduleReference.expression)) {
      specifiers.push(statement.moduleReference.expression.text);
    }
  }

  return specifiers;
}

function resolveInternalImport(sourceFile: ts.SourceFile, importText: string, compilerOptions: ts.CompilerOptions) {
  const resolved = ts.resolveModuleName(importText, sourceFile.fileName, compilerOptions, ts.sys).resolvedModule;
  if (!resolved?.resolvedFileName) {
    return undefined;
  }

  return path.resolve(resolved.resolvedFileName);
}

function ensureModuleSurface(
  statsBySurfaceKey: Map<string, ModuleSurfaceStat>,
  repoRelativePath: string,
) {
  const folderRelativePath = deriveModuleSurfacePath(repoRelativePath);
  const layerKind = detectLayerKind(repoRelativePath);
  const surfaceKey = buildModuleSurfaceKey(folderRelativePath);
  const existing = statsBySurfaceKey.get(surfaceKey);
  if (existing) {
    return existing;
  }

  const created: ModuleSurfaceStat = {
    key: surfaceKey,
    label: buildSurfaceLabel(folderRelativePath, 'architectural-module-surface'),
    layerKind,
    parentSurfaceKey: buildLayerSurfaceKey(layerKind),
    repoRelativePath: folderRelativePath,
    folderRelativePath,
    sourceFiles: new Set<string>(),
    functionStableIds: new Set<string>(),
  };
  statsBySurfaceKey.set(surfaceKey, created);
  return created;
}

function extractArchitecturalSurfaceGraph(program: ts.Program, compilerOptions: ts.CompilerOptions): ExtractedPayload {
  const moduleStatsBySurfaceKey = new Map<string, ModuleSurfaceStat>();
  const surfaceFunctionMembersByKey = new Map<string, ArchitecturalSurfaceFunctionMemberRow>();
  const surfaceDependencyCounts = new Map<string, number>();
  const incomingCounts = new Map<string, number>();
  const outgoingCounts = new Map<string, number>();

  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile)) {
      continue;
    }

    const ownerFilePath = toPosix(path.resolve(sourceFile.fileName));
    const ownerRepoRelativePath = getRepoRelativePath(ownerFilePath);
    const sourceSurface = ensureModuleSurface(moduleStatsBySurfaceKey, ownerRepoRelativePath);
    sourceSurface.sourceFiles.add(ownerRepoRelativePath);

    function visit(current: ts.Node): void {
      if (ts.isFunctionLike(current)) {
        const ownerName = getFunctionName(current);
        if (ownerName) {
          const ownerStableId = getStableId(sourceFile, current);
          sourceSurface.functionStableIds.add(ownerStableId);
          surfaceFunctionMembersByKey.set(`${sourceSurface.key}::${ownerStableId}`, {
            surfaceKey: sourceSurface.key,
            ownerStableId,
            ownerName,
            ownerFilePath,
            ownerRepoRelativePath,
          });
        }
      }

      ts.forEachChild(current, visit);
    }

    visit(sourceFile);

    for (const importText of collectImportSpecifiers(sourceFile)) {
      const resolvedFileName = resolveInternalImport(sourceFile, importText, compilerOptions);
      if (!resolvedFileName) {
        continue;
      }

      const targetSourceFile = program.getSourceFile(resolvedFileName);
      if (!targetSourceFile || !isTrackedSourceFile(targetSourceFile)) {
        continue;
      }

      const targetRepoRelativePath = getRepoRelativePath(toPosix(path.resolve(resolvedFileName)));
      const targetSurface = ensureModuleSurface(moduleStatsBySurfaceKey, targetRepoRelativePath);
      targetSurface.sourceFiles.add(targetRepoRelativePath);

      if (targetSurface.key === sourceSurface.key) {
        continue;
      }

      const dependencyKey = `${sourceSurface.key}::${targetSurface.key}`;
      surfaceDependencyCounts.set(dependencyKey, (surfaceDependencyCounts.get(dependencyKey) || 0) + 1);
      outgoingCounts.set(sourceSurface.key, (outgoingCounts.get(sourceSurface.key) || 0) + 1);
      incomingCounts.set(targetSurface.key, (incomingCounts.get(targetSurface.key) || 0) + 1);
    }
  }

  const layerKinds = [...new Set([...moduleStatsBySurfaceKey.values()].map((stat) => stat.layerKind))].sort();
  const layerRows: ArchitecturalSurfaceRow[] = layerKinds.map((layerKind) => {
    const moduleStats = [...moduleStatsBySurfaceKey.values()].filter((stat) => stat.layerKind === layerKind);
    const fileCount = moduleStats.reduce((sum, stat) => sum + stat.sourceFiles.size, 0);
    const functionCount = moduleStats.reduce((sum, stat) => sum + stat.functionStableIds.size, 0);

    return {
      key: buildLayerSurfaceKey(layerKind),
      label: buildSurfaceLabel(layerKind, 'architectural-layer'),
      surfaceKind: 'architectural-layer',
      layerKind,
      folderRelativePath: layerKind,
      sourceFileCount: fileCount,
      functionCount,
      importOutCount: 0,
      importInCount: 0,
    };
  });

  const moduleRows: ArchitecturalSurfaceRow[] = [...moduleStatsBySurfaceKey.values()]
    .map((stat) => ({
      key: stat.key,
      label: stat.label,
      surfaceKind: 'architectural-module-surface' as const,
      layerKind: stat.layerKind,
      parentSurfaceKey: stat.parentSurfaceKey,
      repoRelativePath: stat.repoRelativePath,
      folderRelativePath: stat.folderRelativePath,
      sourceFileCount: stat.sourceFiles.size,
      functionCount: stat.functionStableIds.size,
      importOutCount: outgoingCounts.get(stat.key) || 0,
      importInCount: incomingCounts.get(stat.key) || 0,
    }))
    .sort((left, right) => left.key.localeCompare(right.key));

  const containmentRows: ArchitecturalSurfaceContainmentEdgeRow[] = moduleRows.map((row) => ({
    parentSurfaceKey: row.parentSurfaceKey!,
    childSurfaceKey: row.key,
  }));

  const dependencyRows: ArchitecturalSurfaceDependencyEdgeRow[] = [...surfaceDependencyCounts.entries()]
    .map(([key, importCount]) => {
      const [fromSurfaceKey, toSurfaceKey] = key.split('::');
      return {
        fromSurfaceKey,
        toSurfaceKey,
        dependencyKind: 'imports' as const,
        importCount,
      };
    })
    .sort((left, right) => {
      const bySource = left.fromSurfaceKey.localeCompare(right.fromSurfaceKey);
      if (bySource !== 0) {
        return bySource;
      }
      return left.toSurfaceKey.localeCompare(right.toSurfaceKey);
    });

  return {
    surfaces: [...layerRows, ...moduleRows],
    surfaceContainmentEdges: containmentRows,
    surfaceFunctionMembers: [...surfaceFunctionMembersByKey.values()].sort((left, right) => {
      const bySurface = left.surfaceKey.localeCompare(right.surfaceKey);
      if (bySurface !== 0) {
        return bySurface;
      }
      return left.ownerStableId.localeCompare(right.ownerStableId);
    }),
    surfaceDependencyEdges: dependencyRows,
  };
}

function main() {
  const program = createProgram();
  const compilerOptions = program.getCompilerOptions();
  const payload = extractArchitecturalSurfaceGraph(program, compilerOptions);
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

main();
import projectPaths from '../../../dev/projectPaths.cjs';
