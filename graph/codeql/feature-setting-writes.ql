import javascript
import StorageSeedsGenerated

predicate relevantFile(File f) {
  configuredStructuralSeedFile(f)
}

predicate configuredOrSeededStoreName(string name) {
  configuredStorageSymbolName(name)
}

predicate featureStoreReceiver(Expr receiver, string storeName) {
  exists(VariableAccess access |
    access = receiver.getUnderlyingValue() and
    configuredOrSeededStoreName(access.getVariable().getName()) and
    storeName = access.getVariable().getName()
  )
}

predicate featureStoreMutation(MethodCallExpr call, string storeName, string accessKind, Expr keyExpr) {
  relevantFile(call.getFile()) and
  featureStoreReceiver(call.getReceiver(), storeName) and
  (
    call.getMethodName() = "set" and accessKind = "update" and keyExpr = call.getArgument(0)
    or
    call.getMethodName() = "add" and accessKind = "update" and keyExpr = call.getArgument(0)
    or
    call.getMethodName() = "delete" and accessKind = "delete" and keyExpr = call.getArgument(0)
    or
    call.getMethodName() = "clear" and accessKind = "clear" and keyExpr = call.getReceiver()
  )
}

predicate saveGlobalConfigCall(CallExpr call, string accessKind, Expr payloadExpr) {
  relevantFile(call.getFile()) and
  call.getCallee().toString() = "saveGlobalConfig" and
  accessKind = "update" and
  payloadExpr = call.getArgument(0)
}

from string sourceKind, string storeName, string accessKind, Expr evidence, Function fn, string featureName
where
  (
    exists(MethodCallExpr call, Expr keyExpr |
      featureStoreMutation(call, storeName, accessKind, keyExpr) and
      evidence = call and
      sourceKind = "feature-store-mutation" and
      featureName = keyExpr.getStringValue()
    )
    or
    exists(CallExpr call, Expr payloadExpr |
      saveGlobalConfigCall(call, accessKind, payloadExpr) and
      evidence = call and
      sourceKind = "global-config-write" and
      storeName = "global-config" and
      featureName = ""
    )
  ) and
  fn = evidence.getEnclosingFunction()
select
  evidence,
  sourceKind,
  storeName,
  accessKind,
  featureName,
  fn.getName(),
  fn.getFile().getRelativePath(),
  fn.getLocation().getStartLine(),
  fn.getLocation().getStartColumn(),
  evidence.getLocation().getStartLine(),
  evidence.getLocation().getStartColumn(),
  evidence.toString()
