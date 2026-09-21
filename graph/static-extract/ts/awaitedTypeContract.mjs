/** Explicit Promise<T> result contract. Not every generic argument is a result. */
export function awaitedTypeArgumentIndex(ts, call, declaration) {
  if (!ts.isCallExpression(call) || !call.typeArguments?.length) return -1;
  let parent = call.parent;
  while (parent && ts.isParenthesizedExpression(parent)) parent = parent.parent;
  if (!parent || !ts.isAwaitExpression(parent)) return -1;
  const result = declaration?.type;
  if (!result || !ts.isTypeReferenceNode(result)
    || !['Promise', 'PromiseLike'].includes(result.typeName.getText())
    || result.typeArguments?.length !== 1) return -1;
  const value = result.typeArguments[0];
  if (!ts.isTypeReferenceNode(value) || value.typeArguments?.length) return -1;
  return declaration.typeParameters?.findIndex(p => p.name.text === value.typeName.getText()) ?? -1;
}
