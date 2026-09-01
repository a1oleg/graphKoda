import javascript

predicate reactStatePair(
  Variable stateVariable,
  Variable setterVariable,
  CallExpr hookCall,
  VariableDeclarator declaration
) {
  exists(ArrayPattern pattern, BindingPattern stateBinding, BindingPattern setterBinding |
    declaration.getInit() = hookCall and
    hookCall.getCalleeName() in ["useState", "useReducer"] and
    declaration.getBindingPattern() = pattern and
    stateBinding = pattern.getElement(0) and
    setterBinding = pattern.getElement(1) and
    stateBinding.getAVariable() = stateVariable and
    setterBinding.getAVariable() = setterVariable
  )
}

predicate setterUse(Variable setterVariable, Expr use, string useKind) {
  exists(CallExpr call |
    call.getCallee() = setterVariable.getAnAccess() and
    use = call and
    useKind = "invoke"
  )
  or
  exists(CallExpr call, int argumentIndex |
    call.getArgument(argumentIndex) = setterVariable.getAnAccess() and
    use = call.getArgument(argumentIndex) and
    useKind = "pass-argument"
  )
  or
  exists(JsxAttribute attribute |
    attribute.getValue() = setterVariable.getAnAccess() and
    use = attribute.getValue() and
    useKind = "pass-jsx-prop"
  )
}

from
  Variable stateVariable, Variable setterVariable, CallExpr hookCall,
  VariableDeclarator declaration, Expr use, string useKind
where
  reactStatePair(stateVariable, setterVariable, hookCall, declaration) and
  setterUse(setterVariable, use, useKind)
select
  declaration,
  stateVariable.getName(),
  setterVariable.getName(),
  hookCall.getCalleeName(),
  useKind,
  use.getFile().getRelativePath(),
  use.getLocation().getStartLine(),
  use.getLocation().getStartColumn()
