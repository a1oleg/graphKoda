import ts from 'typescript';

export type RuntimeIntrinsic = {
  kind: 'arguments' | 'global-this' | 'this';
  symbolFlags: number;
  owner?: ts.Declaration;
  bindingMode?: string;
  typeDeclarations?: ts.Declaration[];
};

export function classifyRuntimeIntrinsic(program: ts.Program, node: ts.Node): RuntimeIntrinsic | undefined {
  if (node.kind === ts.SyntaxKind.ThisKeyword) {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isArrowFunction(parent)) continue;
      if ((ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isMethodDeclaration(parent)
        || ts.isConstructorDeclaration(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent))
        && parent.body) {
        const parameter = parent.parameters.find(parameter => ts.isIdentifier(parameter.name) && parameter.name.text === 'this');
        return {kind: 'this', symbolFlags: 0, owner: parameter || parent,
          bindingMode: parameter ? 'explicit-this-parameter' : 'own-callable-receiver'};
      }
      if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) {
        return {kind: 'this', symbolFlags: 0, owner: parent, bindingMode: 'class-initializer-context'};
      }
      if (ts.isSourceFile(parent)) {
        return {kind: 'this', symbolFlags: 0, owner: parent,
          bindingMode: ts.isExternalModule(parent) ? 'module-undefined' : 'script-runtime-context'};
      }
    }
    return;
  }
  if (!ts.isIdentifier(node)) return;
  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol || !(symbol.flags & ts.SymbolFlags.Transient)
    || symbol.valueDeclaration || symbol.declarations?.length) return;
  const type = checker.getTypeAtLocation(node);
  if (symbol.name === 'globalThis' && type.symbol === symbol
    && (symbol.flags & (ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule))) {
    return {kind: 'global-this', symbolFlags: symbol.flags};
  }
  if (symbol.name !== 'arguments' || type.symbol?.name !== 'IArguments') return;
  const typeDeclarations = type.symbol.declarations?.filter(declaration =>
    program.isSourceFileDefaultLibrary(declaration.getSourceFile())) || [];
  if (!typeDeclarations.length) return;
  // Arrow functions inherit arguments; only a function with its own runtime
  // arguments binding can own this value.
  for (let parent = node.parent; parent; parent = parent.parent) {
    if ((ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isMethodDeclaration(parent)
      || ts.isConstructorDeclaration(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent))
      && parent.body) return {kind: 'arguments', symbolFlags: symbol.flags, owner: parent, typeDeclarations};
  }
}
