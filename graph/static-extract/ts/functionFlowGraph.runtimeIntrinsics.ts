import ts from 'typescript';

export function findCommonJsModuleRequest(program: ts.Program, node: ts.Identifier) {
  const call = node.parent;
  if (node.text !== 'require' || !ts.isCallExpression(call) || call.expression !== node
    || call.questionDotToken || call.arguments.length !== 1 || !ts.isStringLiteralLike(call.arguments[0])
    || program.getTypeChecker().getSymbolAtLocation(node)?.declarations?.length) return;
  return call.arguments[0];
}

export function findGuardedBrowserGlobal(program: ts.Program, node: ts.Identifier) {
  const checker = program.getTypeChecker();
  if (checker.getSymbolAtLocation(node)?.declarations?.length) return;
  function probe(expression: ts.Expression): {guard: ts.BinaryExpression; receiver: ts.Identifier} | undefined {
    if (ts.isParenthesizedExpression(expression)) return probe(expression.expression);
    if (!ts.isBinaryExpression(expression)) return;
    if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return probe(expression.left) || probe(expression.right);
    }
    if (expression.operatorToken.kind !== ts.SyntaxKind.InKeyword
      || !ts.isStringLiteralLike(expression.left) || expression.left.text !== node.text
      || !ts.isIdentifier(expression.right) || expression.right.text !== 'window') return;
    const declarations = checker.getSymbolAtLocation(expression.right)?.declarations || [];
    if (!declarations.length || !declarations.every(declaration =>
      program.isSourceFileDefaultLibrary(declaration.getSourceFile()))) return;
    return {guard: expression, receiver: expression.right};
  }
  // Do not carry a branch guard into callbacks whose execution may outlive it.
  for (let child: ts.Node = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return;
    if (ts.isIfStatement(parent) && child === parent.thenStatement) {
      const result = probe(parent.expression);
      if (result) return result;
    }
  }
}

const runtimeWrites = new WeakMap<ts.Program, WeakMap<ts.SourceFile, Set<ts.Symbol>>>();

function writtenBindings(program: ts.Program, source: ts.SourceFile) {
  let files = runtimeWrites.get(program);
  if (!files) runtimeWrites.set(program, files = new WeakMap());
  const cached = files.get(source);
  if (cached) return cached;
  const checker = program.getTypeChecker(), writes = new Set<ts.Symbol>();
  let dynamicScope = false;
  const collect = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) writes.add(symbol);
    }
    ts.forEachChild(node, collect);
  };
  const visit = (node: ts.Node) => {
    if (ts.isWithStatement(node) || ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === 'eval') dynamicScope = true;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) collect(node.left);
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) collect(node.operand);
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) collect(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (dynamicScope) {
    const rejectBindings = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node)) collect(node.name);
      ts.forEachChild(node, rejectBindings);
    };
    rejectBindings(source);
  }
  files.set(source, writes);
  return writes;
}

type RuntimePresenceGuard = {guard: ts.BinaryExpression; aliases: ts.VariableDeclaration[]};

function resolveRuntimeGuard(program: ts.Program, node: ts.Identifier, includeCreationContext: boolean,
  hostProbe?: (expression: ts.BinaryExpression) => boolean) {
  const checker = program.getTypeChecker();
  if (checker.getSymbolAtLocation(node)?.declarations?.length) return;
  function probe(expression: ts.Expression, visited = new Set<ts.Symbol>()): RuntimePresenceGuard | undefined {
    if (ts.isParenthesizedExpression(expression)) return probe(expression.expression, visited);
    if (ts.isIdentifier(expression)) {
      const symbol = checker.getSymbolAtLocation(expression);
      if (!symbol || visited.has(symbol) || symbol.declarations?.length !== 1) return;
      const declaration = symbol.declarations[0];
      if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name) || !declaration.initializer
        || declaration.getSourceFile() !== node.getSourceFile() || declaration.end > expression.getStart()
        || (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export)
        || writtenBindings(program, declaration.getSourceFile()).has(symbol)) return;
      visited.add(symbol);
      const result = probe(declaration.initializer, visited);
      visited.delete(symbol);
      return result ? {...result, aliases: [declaration, ...result.aliases]} : undefined;
    }
    if (!ts.isBinaryExpression(expression)) return;
    if (hostProbe) {
      if (hostProbe(expression)) return {guard: expression, aliases: []};
      if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        return probe(expression.left, visited) || probe(expression.right, visited);
      }
      return;
    }
    if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return probe(expression.left, visited) || probe(expression.right, visited);
    }
    const [operand, literal] = ts.isTypeOfExpression(expression.left)
      ? [expression.left, expression.right] : [expression.right, expression.left];
    if (!ts.isTypeOfExpression(operand) || !ts.isIdentifier(operand.expression)
      || operand.expression.text !== node.text || !ts.isStringLiteralLike(literal)
      || checker.getSymbolAtLocation(operand.expression)?.declarations?.length) return;
    const operator = expression.operatorToken.kind;
    const equality = operator === ts.SyntaxKind.EqualsEqualsToken || operator === ts.SyntaxKind.EqualsEqualsEqualsToken;
    const inequality = operator === ts.SyntaxKind.ExclamationEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    if (equality && ['function','object','string','number','boolean','symbol','bigint'].includes(literal.text)
      || inequality && literal.text === 'undefined') return {guard: expression, aliases: []};
  }
  const callbacks: (ts.ArrowFunction | ts.FunctionExpression)[] = [];
  for (let child: ts.Node = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isFunctionLike(parent)) {
      // Hoisted declarations and methods do not have the creation semantics of inline callbacks.
      if (!includeCreationContext || !(ts.isArrowFunction(parent) || ts.isFunctionExpression(parent))) return;
      callbacks.push(parent);
    }
    if (ts.isIfStatement(parent) && child === parent.thenStatement) {
      const guard = probe(parent.expression);
      if (guard) return {...guard, callbacks};
    }
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      && child === parent.right) {
      const guard = probe(parent.left);
      if (guard) return {...guard, callbacks};
    }
  }
}

export function resolveRuntimePresenceGuard(program: ts.Program, node: ts.Identifier) {
  return resolveRuntimeGuard(program, node, false);
}

export function findConditionalRuntimeCapture(program: ts.Program, node: ts.Identifier) {
  const result = resolveRuntimeGuard(program, node, true);
  return result?.callbacks.length ? result : undefined;
}

export function findRuntimePresenceGuard(program: ts.Program, node: ts.Identifier) {
  return resolveRuntimePresenceGuard(program, node)?.guard;
}

export function findNodeRuntimeGuard(program: ts.Program, node: ts.Identifier) {
  if (node.text !== 'Buffer') return;
  const checker = program.getTypeChecker();
  const positiveNodeProbe = (expression: ts.BinaryExpression) => {
    const checks = new Set<string>();
    const visit = (part: ts.Expression) => {
      if (ts.isParenthesizedExpression(part)) return visit(part.expression);
      if (!ts.isBinaryExpression(part)) return;
      if (part.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        visit(part.left); visit(part.right); return;
      }
      if (part.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsToken
        && part.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return;
      const [type, literal] = ts.isTypeOfExpression(part.left) ? [part.left, part.right] : [part.right, part.left];
      if (!ts.isTypeOfExpression(type) || !ts.isStringLiteralLike(literal)) return;
      const members: string[] = [];
      let receiver = type.expression;
      while (ts.isPropertyAccessExpression(receiver) && !receiver.questionDotToken) {
        members.unshift(receiver.name.text); receiver = receiver.expression;
      }
      if (!ts.isIdentifier(receiver) || receiver.text !== 'process'
        || checker.getSymbolAtLocation(receiver)?.declarations?.length) return;
      checks.add([receiver.text, ...members].join('.') + ':' + literal.text);
    };
    visit(expression);
    return ['process:object', 'process.versions:object', 'process.versions.node:string'].every(check => checks.has(check));
  };
  return resolveRuntimeGuard(program, node, false, positiveNodeProbe);
}

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
