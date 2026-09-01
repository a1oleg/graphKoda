import StorageAccessors

from Function f, Variable param, int index, string mode, Expr access, Expr store
where
  localFunction(f) and
  parameterOf(f, param, index) and
  storageAccessor(f, param, mode, access, store)
select
  f,
  f.getName(),
  f.getFile().getRelativePath(),
  f.getLocation().getStartLine(),
  f.getLocation().getStartColumn(),
  param.getName(),
  index,
  mode,
  store.toString(),
  access.getLocation().getStartLine(),
  access.getLocation().getStartColumn()
