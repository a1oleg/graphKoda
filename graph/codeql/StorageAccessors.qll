import javascript
import StorageSeedsGenerated

predicate localFunction(Function f) {
  not f.getFile().getRelativePath().matches("%/node_modules/%") and
  not f.getFile().getRelativePath().matches("node_modules/%") and
  not f.getFile().getRelativePath().matches("%.d.ts")
}

predicate parameterOf(Function f, Variable param, int index) {
  param = f.getParameter(index).(SimpleParameter).getVariable()
}

predicate parameterIndexRead(Function f, Variable param, IndexExpr access) {
  f.getBody().getAChild*() = access and
  access.getIndex().getUnderlyingValue() = param.getAnAccess()
}

predicate parameterMapRead(Function f, Variable param, MethodCallExpr call) {
  f.getBody().getAChild*() = call and
  call.getArgument(0).getUnderlyingValue() = param.getAnAccess() and
  call.getMethodName() = "get"
}

predicate parameterMapWrite(Function f, Variable param, MethodCallExpr call) {
  f.getBody().getAChild*() = call and
  call.getArgument(0).getUnderlyingValue() = param.getAnAccess() and
  call.getMethodName() = "set"
}

predicate directStorageAccessor(Function f, Variable param, string mode, Expr access, Expr store) {
  exists(IndexExpr idx |
    parameterIndexRead(f, param, idx) and
    access = idx and
    store = idx.getBase() and
    mode = "index-read"
  )
  or
  exists(MethodCallExpr call |
    parameterMapRead(f, param, call) and
    access = call and
    store = call.getReceiver() and
    mode = "map-read"
  )
  or
  exists(MethodCallExpr call |
    parameterMapWrite(f, param, call) and
    access = call and
    store = call.getReceiver() and
    mode = "map-write"
  )
}

predicate delegatedStorageAccessor(Function f, Variable param, string mode, Expr access, Expr store) {
  exists(DataFlow::CallNode call, Function callee, Variable calleeParam, int argIndex, string calleeMode, Expr calleeAccess, Expr calleeStore |
    f.getBody().getAChild*() = call.asExpr() and
    call.getACallee() = callee and
    parameterOf(callee, calleeParam, argIndex) and
    call.getArgument(argIndex).asExpr().getUnderlyingValue() = param.getAnAccess() and
    directStorageAccessor(callee, calleeParam, calleeMode, calleeAccess, calleeStore) and
    access = call.asExpr() and
    store = call.asExpr().(CallExpr).getCallee() and
    mode = "delegates-" + calleeMode
  )
}

predicate storageAccessor(Function f, Variable param, string mode, Expr access, Expr store) {
  directStorageAccessor(f, param, mode, access, store)
  or
  delegatedStorageAccessor(f, param, mode, access, store)
}

predicate knownSettingsSdkImport(Import imprt, string provider) {
  configuredSettingsSdkImport(imprt, provider)
}

predicate knownExternalSettingsSdkCall(Import imprt, string provider, string calleeName, int keyArgIndex, string mode) {
  configuredExternalSettingsSdkCall(imprt, provider, calleeName, keyArgIndex, mode)
}

predicate functionHasKnownSettingsSdkEvidence(Function f, string provider, string importPath) {
  exists(Import imprt |
    knownSettingsSdkImport(imprt, provider) and
    imprt.getFile() = f.getFile() and
    importPath = imprt.getImportedPathString()
  )
}
