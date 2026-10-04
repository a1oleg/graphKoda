import ts from 'typescript';
import { getExtendedStableId, getRepoRelativePath } from './functionFlowGraph.infrastructure.js';

const FRAMEWORK_PACKAGES = new Set(['react', 'react-dom', 'ink', 'vue', 'angular', '@angular/core', 'svelte']);

export type CallOrigin = {
  kind: 'project' | 'standard-library' | 'framework' | 'external-library' | 'unknown';
  declarationStableId?: string;
  declarationPath?: string;
  packageName?: string;
};

export function classifyCallOrigin(checker: ts.TypeChecker, call: ts.CallExpression | ts.NewExpression): CallOrigin {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (!declaration) return { kind: 'unknown' };
  const source = declaration.getSourceFile();
  const declarationPath = getRepoRelativePath(source.fileName);
  const identity = { declarationStableId: getExtendedStableId(source, declaration), declarationPath };
  const normalized = source.fileName.replace(/\\/g, '/');
  const modulePath = normalized.split('/node_modules/').at(-1);
  const packageName = normalized.includes('/node_modules/') && modulePath
    ? modulePath.startsWith('@') ? modulePath.split('/').slice(0, 2).join('/') : modulePath.split('/')[0]
    : undefined;
  if ((packageName === 'typescript' && /\/lib\/lib\.[^/]+\.d\.ts$/.test(normalized))
      || packageName === '@types/node') return { kind: 'standard-library', ...identity, packageName };
  if (packageName) {
    const runtimePackage = packageName.startsWith('@types/') ? packageName.slice(7) : packageName;
    return { kind: FRAMEWORK_PACKAGES.has(runtimePackage) ? 'framework' : 'external-library',
      ...identity, packageName: runtimePackage };
  }
  if (!declarationPath.startsWith('../') && !declarationPath.startsWith('/')
      && !/^[A-Za-z]:/.test(declarationPath)) return { kind: 'project', ...identity };
  return { kind: 'unknown', ...identity };
}
