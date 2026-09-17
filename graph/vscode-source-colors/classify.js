// Parse actual syntax; classify standard-library symbols with the TS checker, not names.
function classify(ts, file, text) {
  const options = {target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.Preserve, allowJs: true, noResolve: true, skipLibCheck: true};
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile;
  host.getSourceFile = (name, ...args) => name === file ? ts.createSourceFile(name, text, options.target, true) : original(name, ...args);
  const program = ts.createProgram([file], options, host);
  const source = program.getSourceFile(file), checker = program.getTypeChecker(), marks = [];
  function system(node) {
    const symbol = checker.getSymbolAtLocation(node);
    return !!symbol?.declarations?.length && symbol.declarations.every(d => program.isSourceFileDefaultLibrary(d.getSourceFile()));
  }
  function add(node, role) { marks.push({start: node.getStart(source), end: node.end, role, text: node.getText(source)}); }
  function visit(node) {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const target = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
      const role = system(target) ? 'system' : 'call';
      for (const child of node.getChildren(source)) {
        if (child.kind === ts.SyntaxKind.OpenParenToken || child.kind === ts.SyntaxKind.CloseParenToken) add(child, role);
      }
    }
    if (ts.isElementAccessExpression(node)) {
      for (const child of node.getChildren(source)) {
        if (child.kind === ts.SyntaxKind.OpenBracketToken || child.kind === ts.SyntaxKind.CloseBracketToken) add(child, 'system');
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const builtin = system(node.name);
      const called = (ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent)) && node.parent.expression === node;
      add(node.name, builtin ? 'systemMember' : called ? 'call' : 'valueMember');
      if (ts.isIdentifier(node.expression)) add(node.expression, system(node.expression) ? 'systemRoot' : 'valueRoot');
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return marks;
}
module.exports = {classify};
