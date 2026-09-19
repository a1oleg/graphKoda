// Parse actual syntax; classify standard-library symbols with the TS checker, not names.
function classify(ts, file, text) {
  const options = {target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve, allowJs: true, skipLibCheck: true};
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile;
  const canonical = name => {
    const normalized = ts.sys.resolvePath(name).replace(/\\/g, '/');
    return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
  };
  const targetPath = canonical(file);
  host.getSourceFile = (name, ...args) => canonical(name) === targetPath ? ts.createSourceFile(name, text, options.target, true) : original(name, ...args);
  const program = ts.createProgram([file], options, host);
  const source = program.getSourceFile(file), checker = program.getTypeChecker(), marks = [];
  function system(node) {
    const symbol = checker.getSymbolAtLocation(node);
    return !!symbol?.declarations?.length && symbol.declarations.every(d => program.isSourceFileDefaultLibrary(d.getSourceFile()) || /[\\/]node_modules[\\/]@types[\\/]node[\\/]/.test(d.getSourceFile().fileName));
  }
  function add(node, role) { marks.push({start: node.getStart(source), end: node.end, role, text: node.getText(source)}); }
  function callable(type) { return checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0; }
  const providers = new Map();
  function provider(node) {
    const type = checker.getNonNullableType(checker.getTypeAtLocation(node));
    if(providers.has(type))return providers.get(type);
    const parts=type.isUnion()?type.types:[type];
    const result=parts.some(t=>!(t.flags&(ts.TypeFlags.Any|ts.TypeFlags.Unknown))&&!checker.isArrayType(t)&&!checker.isTupleType(t)&&!callable(t)&&checker.getPropertiesOfType(t).some(p=> {
      const declarations=p.declarations||[];
      return declarations.length&&declarations.every(d=>!program.isSourceFileDefaultLibrary(d.getSourceFile()))&&callable(checker.getTypeOfSymbolAtLocation(p,node));
    }));
    providers.set(type,result);return result;
  }
  function visit(node) {
    const functionSyntax = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
    const loopSyntax = ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node);
    if (functionSyntax || loopSyntax) {
      const role = functionSyntax ? 'call' : 'system';
      // Only immediate delimiters: never recolor nested object/type literals.
      for (const child of node.getChildren(source)) {
        if (child.kind === ts.SyntaxKind.OpenParenToken || child.kind === ts.SyntaxKind.CloseParenToken) add(child, role);
      }
      const body = functionSyntax ? node.body : node.statement;
      if (body && ts.isBlock(body)) for (const child of body.getChildren(source)) {
        if (child.kind === ts.SyntaxKind.OpenBraceToken || child.kind === ts.SyntaxKind.CloseBraceToken) add(child, role);
      }
    }
    if(node.kind===ts.SyntaxKind.TrueKeyword)add(node,'true');
    if(node.kind===ts.SyntaxKind.FalseKeyword)add(node,'false');
    if(ts.isIdentifier(node)&&system(node)&&!ts.isPropertyAccessExpression(node.parent))add(node,'system');
    for(const child of node.getChildren(source)) {
      if([ts.SyntaxKind.QuestionToken,ts.SyntaxKind.QuestionDotToken,ts.SyntaxKind.QuestionQuestionToken].includes(child.kind))add(child,'system');
      if(ts.isCatchClause(node)&&(child.kind===ts.SyntaxKind.OpenParenToken||child.kind===ts.SyntaxKind.CloseParenToken))add(child,'system');
    }
    if(ts.isPropertyAssignment(node)||ts.isPropertySignature(node))add(node.name,'valueMember');
    if(ts.isIdentifier(node)&&!ts.isPropertyAccessExpression(node.parent)&&!system(node)) {
      const isName=(ts.isPropertyAssignment(node.parent)||ts.isPropertySignature(node.parent))&&node.parent.name===node;
      const isCallee=(ts.isCallExpression(node.parent)||ts.isNewExpression(node.parent))&&node.parent.expression===node;
      const symbol=checker.getSymbolAtLocation(node);
      const binding=symbol?.declarations?.some(d=>ts.isVariableDeclaration(d)||ts.isParameter(d)||ts.isBindingElement(d));
      if(binding&&!isName&&!isCallee) {
        if(provider(node))add(node,'provider');
        else if(callable(checker.getTypeAtLocation(node)))add(node,'callableBinding');
      }
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const target = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
      const role = system(target) || node.expression.kind===ts.SyntaxKind.ImportKeyword ? 'system' : 'call';
      if(system(target))add(target,'systemMember');
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
      if (ts.isIdentifier(node.expression)) add(node.expression, system(node.expression) ? 'systemRoot' : provider(node.expression) ? 'provider' : 'valueRoot');
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...new Map(marks.map(m=>[`${m.start}:${m.end}`,m])).values()];
}
module.exports = {classify};
