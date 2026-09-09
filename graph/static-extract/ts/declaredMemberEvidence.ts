import ts from 'typescript';

type TypeEvidence = { node: ts.TypeNode; bindings: Map<string, TypeEvidence> };
type MemberEvidence = { member: ts.TypeElement; bindings: Map<string, TypeEvidence> };

// Recover only explicitly declared structure when the checker collapses an
// intersection to any (e.g. one imported utility type is unavailable). Unknown
// generic transforms are never assumed to preserve their argument's fields.
export function declaredMemberEvidence(checker: ts.TypeChecker) {
  function declarations(node: ts.Node): readonly ts.Declaration[] {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.declarations || [];
  }
  const evidence = (node: ts.TypeNode, bindings = new Map<string, TypeEvidence>()): TypeEvidence => ({ node, bindings });
  function substitute(type: TypeEvidence): TypeEvidence {
    const {node, bindings} = type;
    return ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && bindings.has(node.typeName.text)
      ? bindings.get(node.typeName.text)! : type;
  }
  function members(type: TypeEvidence, name: string, seen = new Set<ts.Node>()): MemberEvidence[] {
    type = substitute(type);
    const {node, bindings} = type;
    if (seen.has(node)) return [];
    const next = new Set([...seen, node]);
    if (ts.isParenthesizedTypeNode(node)) return members(evidence(node.type, bindings), name, next);
    if (ts.isIntersectionTypeNode(node) || ts.isUnionTypeNode(node)) return node.types.flatMap(t => members(evidence(t, bindings), name, next));
    if (ts.isTypeLiteralNode(node)) return node.members.filter(m => m.name && m.name.getText().replace(/^['"]|['"]$/g, '') === name).map(member => ({member, bindings}));
    if (!ts.isTypeReferenceNode(node)) return [];
    return declarations(node.typeName).flatMap(declaration => {
      if (!ts.isTypeAliasDeclaration(declaration) && !ts.isInterfaceDeclaration(declaration)) return [];
      const bound = new Map(bindings);
      declaration.typeParameters?.forEach((parameter, index) => {
        const argument = node.typeArguments?.[index] || parameter.default;
        if (argument) bound.set(parameter.name.text, substitute(evidence(argument, bindings)));
      });
      if (ts.isTypeAliasDeclaration(declaration)) return members(evidence(declaration.type, bound), name, next);
      return declaration.members.filter(m => m.name?.getText() === name).map(member => ({member, bindings: bound}));
    });
  }
  function expressionTypes(expression: ts.Expression, seen = new Set<ts.Node>()): TypeEvidence[] {
    if (seen.has(expression)) return [];
    const next = new Set([...seen, expression]);
    if (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)) return expressionTypes(expression.expression, next);
    if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) return [evidence(expression.type)];
    if (ts.isIdentifier(expression)) return declarations(expression).flatMap(declaration => {
      if (!ts.isVariableDeclaration(declaration) && !ts.isParameter(declaration) && !ts.isPropertyDeclaration(declaration)) return [];
      if (declaration.type) return [evidence(declaration.type)];
      return declaration.initializer ? expressionTypes(declaration.initializer, next) : [];
    });
    if (ts.isCallExpression(expression)) {
      if (ts.isPropertyAccessExpression(expression.expression)) {
        const access = expression.expression;
        const resolved = expressionTypes(access.expression, next).flatMap(t => members(t, access.name.text));
        const returns = resolved.flatMap(({member, bindings}) => {
          if (ts.isMethodSignature(member) && member.type) return [substitute(evidence(member.type, bindings))];
          if (ts.isPropertySignature(member) && member.type && ts.isFunctionTypeNode(member.type)) return [substitute(evidence(member.type.type, bindings))];
          return [];
        });
        if (returns.length) return returns;
      }
      const signature = checker.getResolvedSignature(expression)?.declaration;
      if (signature?.type) return [evidence(signature.type)];
    }
    return [];
  }
  function contextualMembers(object: ts.ObjectLiteralExpression, name: string): ts.Declaration[] {
    let current: ts.Node = object;
    while (current.parent && (ts.isParenthesizedExpression(current.parent) || ts.isReturnStatement(current.parent) || ts.isBlock(current.parent))) current = current.parent;
    const owner = current.parent;
    if (!owner || !ts.isFunctionLike(owner)) return [];
    if (owner.type) return members(evidence(owner.type), name).map(row => row.member);
    const call = owner.parent;
    if (!ts.isCallExpression(call)) return [];
    const index = call.arguments.findIndex(arg => arg === owner);
    const parameter = checker.getResolvedSignature(call)?.declaration?.parameters[index];
    if (!parameter?.type || !ts.isFunctionTypeNode(parameter.type)) return [];
    return members(evidence(parameter.type.type), name).map(row => row.member);
  }
  return {
    expressionMembers: (expression: ts.Expression, name: string) => expressionTypes(expression).flatMap(type => members(type, name)).map(row => row.member),
    expressionMemberPath: (expression: ts.Expression, names: string[]) => {
      let types = expressionTypes(expression);
      let found: MemberEvidence[] = [];
      for (const name of names) {
        found = types.flatMap(type => members(type, name));
        types = found.flatMap(({member, bindings}) => 'type' in member && member.type
          ? [substitute(evidence(member.type as ts.TypeNode, bindings))] : []);
      }
      return found.map(row => row.member);
    },
    contextualMembers,
  };
}
