// Shared by extraction and editor colors; shipped with the standalone extension.
function constructorSemantics(ts, checker, expression) {
  let symbol=checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expression)?expression.name:expression);
  const seen=new Set();
  while(symbol && (symbol.flags & ts.SymbolFlags.Alias) && !seen.has(symbol)) {
    seen.add(symbol); symbol=checker.getAliasedSymbol(symbol);
  }
  const declarations=symbol?.declarations || [];
  const libraryDirectory=ts.getDefaultLibFilePath({}).replace(/\\/g,'/').replace(/\/[^/]+$/,'').toLowerCase();
  const standard=declarations.length>0 && declarations.every(d=> {
    const file=d.getSourceFile();
    const name=file.fileName.replace(/\\/g,'/').toLowerCase();
    return file.isDeclarationFile && name.startsWith(libraryDirectory+'/') && /\/lib\.[^/]+\.d\.ts$/.test(name);
  });
  const system=standard || declarations.length>0 && declarations.every(d=>/[\\/]node_modules[\\/]/.test(d.getSourceFile().fileName));
  const error=standard && /^(?:Error|EvalError|RangeError|ReferenceError|SyntaxError|TypeError|URIError|AggregateError|SuppressedError)$/.test(symbol.getName());
  return {system,error,resolved:declarations.length>0};
}
module.exports={constructorSemantics};
