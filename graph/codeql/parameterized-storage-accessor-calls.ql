import StorageAccessors

predicate localStorageAccessorCallRow(
  CallExpr callExpr,
  string callerName,
  string callerRepoRelativePath,
  int callerLine,
  int callerColumn,
  string accessorName,
  string accessorRepoRelativePath,
  int accessorLine,
  int accessorColumn,
  string keyParameterName,
  int keyArgIndex,
  string accessorMode,
  string accessorStorage,
  Expr keyExpr,
  string provider,
  string importPath
) {
  exists(DataFlow::CallNode call, Function caller, Function accessor, Variable keyParam, Expr storageExpr |
    call.asExpr() = callExpr and
    localFunction(caller) and
    localFunction(accessor) and
    callExpr.getEnclosingFunction() = caller and
    call.getACallee() = accessor and
    parameterOf(accessor, keyParam, keyArgIndex) and
    storageAccessor(accessor, keyParam, accessorMode, _, storageExpr) and
    keyExpr = call.getArgument(keyArgIndex).asExpr() and
    callerName = caller.getName() and
    callerRepoRelativePath = caller.getFile().getRelativePath() and
    callerLine = caller.getLocation().getStartLine() and
    callerColumn = caller.getLocation().getStartColumn() and
    accessorName = accessor.getName() and
    accessorRepoRelativePath = accessor.getFile().getRelativePath() and
    accessorLine = accessor.getLocation().getStartLine() and
    accessorColumn = accessor.getLocation().getStartColumn() and
    keyParameterName = keyParam.getName() and
    accessorStorage = storageExpr.toString() and
    (
      functionHasKnownSettingsSdkEvidence(accessor, provider, importPath)
      or
      not exists(string p, string i | functionHasKnownSettingsSdkEvidence(accessor, p, i)) and
      provider = "" and
      importPath = ""
    )
  )
}

predicate externalSettingsSdkAccessorCallRow(
  CallExpr callExpr,
  string callerName,
  string callerRepoRelativePath,
  int callerLine,
  int callerColumn,
  string accessorName,
  string accessorRepoRelativePath,
  int accessorLine,
  int accessorColumn,
  string keyParameterName,
  int keyArgIndex,
  string accessorMode,
  string accessorStorage,
  Expr keyExpr,
  string provider,
  string importPath
) {
  keyExpr = callExpr.getArgument(keyArgIndex) and
  exists(Import imprt |
    knownExternalSettingsSdkCall(imprt, provider, accessorName, keyArgIndex, accessorMode) and
    imprt.getFile() = callExpr.getFile() and
    importPath = imprt.getImportedPathString()
  ) and
  callExpr.getCallee().toString() = accessorName and
  callerName = "external-sdk-call" and
  callerRepoRelativePath = callExpr.getFile().getRelativePath() and
  callerLine = callExpr.getLocation().getStartLine() and
  callerColumn = callExpr.getLocation().getStartColumn() and
  accessorRepoRelativePath = importPath and
  accessorLine = 0 and
  accessorColumn = 0 and
  keyParameterName = "arg0" and
  accessorStorage = importPath + "." + accessorName
}

predicate storageAccessorCallRow(
  CallExpr callExpr,
  string callerName,
  string callerRepoRelativePath,
  int callerLine,
  int callerColumn,
  string accessorName,
  string accessorRepoRelativePath,
  int accessorLine,
  int accessorColumn,
  string keyParameterName,
  int keyArgIndex,
  string accessorMode,
  string accessorStorage,
  Expr keyExpr,
  string provider,
  string importPath
) {
  localStorageAccessorCallRow(
    callExpr,
    callerName,
    callerRepoRelativePath,
    callerLine,
    callerColumn,
    accessorName,
    accessorRepoRelativePath,
    accessorLine,
    accessorColumn,
    keyParameterName,
    keyArgIndex,
    accessorMode,
    accessorStorage,
    keyExpr,
    provider,
    importPath
  )
  or
  externalSettingsSdkAccessorCallRow(
    callExpr,
    callerName,
    callerRepoRelativePath,
    callerLine,
    callerColumn,
    accessorName,
    accessorRepoRelativePath,
    accessorLine,
    accessorColumn,
    keyParameterName,
    keyArgIndex,
    accessorMode,
    accessorStorage,
    keyExpr,
    provider,
    importPath
  )
}

from
  CallExpr callExpr, string callerName, string callerRepoRelativePath, int callerLine, int callerColumn,
  string accessorName, string accessorRepoRelativePath, int accessorLine, int accessorColumn,
  string keyParameterName, int keyArgIndex, string accessorMode, string accessorStorage,
  Expr keyExpr, string provider, string importPath
where
  storageAccessorCallRow(
    callExpr,
    callerName,
    callerRepoRelativePath,
    callerLine,
    callerColumn,
    accessorName,
    accessorRepoRelativePath,
    accessorLine,
    accessorColumn,
    keyParameterName,
    keyArgIndex,
    accessorMode,
    accessorStorage,
    keyExpr,
    provider,
    importPath
  )
select
  callExpr,
  callerName,
  callerRepoRelativePath,
  callerLine,
  callerColumn,
  accessorName,
  accessorRepoRelativePath,
  accessorLine,
  accessorColumn,
  keyParameterName,
  keyArgIndex,
  keyExpr.toString(),
  keyExpr.getStringValue(),
  callExpr.getLocation().getStartLine(),
  callExpr.getLocation().getStartColumn(),
  accessorMode,
  accessorStorage,
  provider,
  importPath
