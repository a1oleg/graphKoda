import ts from 'typescript';

/** Does a call of this parameter contribute to a returned expression? Tracks
 * local initializers/assignments and returned closures, not unrelated effects. */
export function callbackContributesToResult(checker: ts.TypeChecker, gateway: ts.SignatureDeclaration, parameter: ts.ParameterDeclaration): boolean {
  const body = 'body' in gateway ? gateway.body as ts.ConciseBody | undefined : undefined;
  if (!body) return false;
  const symbol = checker.getSymbolAtLocation(parameter.name);
  if (!symbol) return false;
  const values = new Map<ts.Symbol, ts.Node[]>();
  const add = (name: ts.Identifier, value: ts.Node) => {
    const key = checker.getSymbolAtLocation(name);
    if (key) values.set(key, [...(values.get(key) || []), value]);
  };
  const index = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) add(node.name, node.initializer);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) add(node.left, node.right);
    ts.forEachChild(node, index);
  };
  index(body);
  const returns: ts.Node[] = [];
  const findReturns = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) returns.push(node.expression);
    else ts.forEachChild(node, findReturns);
  };
  if (ts.isBlock(body)) findReturns(body); else returns.push(body);
  const visited = new Set<ts.Node>();
  const follows = (node: ts.Node): boolean => {
    if (visited.has(node)) return false;
    visited.add(node);
    if (ts.isCallExpression(node) && checker.getSymbolAtLocation(node.expression) === symbol) return true;
    if (ts.isIdentifier(node)) {
      const key = checker.getSymbolAtLocation(node);
      if (key && (values.get(key) || []).some(follows)) return true;
    }
    return ts.forEachChild(node, child => follows(child) || undefined) === true;
  };
  return returns.some(follows);
}
