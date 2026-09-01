/**
 * Cross-file canonical reference facts used to validate and enrich the
 * TypeScript extractor's declaration graph.
 */
import javascript

private AstNode declarationOf(LexicalName name) {
  result = name.(Variable).getADeclaration()
  or
  result = name.(LocalTypeName).getADeclaration()
}

private predicate canonicalLink(
  string relation,
  string referenceKind,
  AstNode reference,
  string referenceName,
  AstNode target,
  string targetName
) {
  exists(LocalTypeAccess access, TypeDecl declaration |
    access.getLocalTypeName().getADeclaration() = declaration and
    relation = "RESOLVES_TO" and
    referenceKind = "TypeReference" and
    reference = access and
    referenceName = access.getName() and
    target = declaration and
    targetName = declaration.getName()
  )
  or
  exists(ImportDeclaration imprt, ImportSpecifier specifier, ES2015Module imported, LexicalName exported |
    imprt = specifier.getImportDeclaration() and
    imported = imprt.getImportedModule() and
    imported.exportsAs(exported, specifier.getImportedName()) and
    relation = "ALIASES" and
    referenceKind = "AliasDeclaration" and
    reference = specifier and
    referenceName = specifier.getLocal().getName() and
    target = declarationOf(exported) and
    targetName = exported.getName()
  )
  or
  exists(ReExportDeclaration reexport, LexicalName exported, string exportedName |
    reexport.reExportsAs(exported, exportedName) and
    relation = "REEXPORTS" and
    referenceKind = "ReExport" and
    reference = reexport and
    referenceName = exportedName and
    target = declarationOf(exported) and
    targetName = exported.getName()
  )
}

from
  string relation, string referenceKind, AstNode reference, string referenceName,
  AstNode target, string targetName
where
  canonicalLink(relation, referenceKind, reference, referenceName, target, targetName) and
  not reference.getFile().getRelativePath().matches("graph/%") and
  not reference.getFile().getRelativePath().matches("node_modules/%")
select
  relation,
  referenceKind,
  reference.getFile().getRelativePath(),
  reference.getLocation().getStartLine(),
  reference.getLocation().getStartColumn(),
  reference.getLocation().getEndLine(),
  reference.getLocation().getEndColumn(),
  referenceName,
  target.getFile().getRelativePath(),
  target.getLocation().getStartLine(),
  target.getLocation().getStartColumn(),
  target.getLocation().getEndLine(),
  target.getLocation().getEndColumn(),
  targetName
