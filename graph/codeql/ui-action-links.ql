import javascript

predicate isGetActionsCall(CallExpr call) {
  call.getCalleeName() = "getActions"
}

predicate actionVariable(Variable actionVar, string actionName, Function outer) {
  exists(VariableDeclarator vd, ObjectPattern pattern, PropertyPattern prop |
    vd.getInit() instanceof CallExpr and
    isGetActionsCall(vd.getInit()) and
    vd.getBindingPattern() = pattern and
    prop = pattern.getAPropertyPattern() and
    actionName = prop.getName() and
    prop.getValuePattern().(BindingPattern).getAVariable() = actionVar and
    outer.getBody().getAChild*() = vd
  )
}

predicate nestedOrSelf(Function f, Function outer) {
  f = outer or
  (
    f != outer and
    outer.getBody().getAChild*() = f
  )
}

predicate callsActionVariable(Function f, Variable actionVar, CallExpr call) {
  f.getBody().getAChild*() = call and
  call.getCallee() = actionVar.getAnAccess()
}

from Function outer, Function f, Variable actionVar, string actionName, CallExpr call
where
  actionVariable(actionVar, actionName, outer) and
  nestedOrSelf(f, outer) and
  callsActionVariable(f, actionVar, call)
select f, f.getName(), actionName, call.getFile().getRelativePath(), call.getLocation().getStartLine(), call.getLocation().getStartColumn()
