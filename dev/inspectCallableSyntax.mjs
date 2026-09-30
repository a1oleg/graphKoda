import ts from 'typescript';
import fs from 'node:fs';

// Parse only the actual declaration text preserved in the extraction snapshot.
const rows = JSON.parse(fs.readFileSync(0, 'utf8'));
const results = rows.map(row => {
  const kind = row.declaration_kind;
  if (!row.syntax || !kind) return { stable_id: row.stable_id, status: 'syntax-unavailable' };
  const member = ['MethodDeclaration', 'Constructor', 'GetAccessor', 'SetAccessor'].includes(kind);
  const text = member ? `abstract class Container { ${row.syntax} }`
    : kind === 'CallSignature' ? `interface Container { ${row.syntax} }`
      : kind === 'VariableDeclaration' ? `const ${row.syntax};`
        : ['ArrowFunction', 'FunctionExpression'].includes(kind) ? `const holder = ${row.syntax};` : row.syntax;
  const file = ts.createSourceFile('declaration.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  function visit(node) {
    if (!declaration && ts.SyntaxKind[node.kind] === kind) declaration = node;
    if (!declaration) ts.forEachChild(node, visit);
  }
  visit(file);
  if (file.parseDiagnostics.length || !declaration) {
    return { stable_id: row.stable_id, status: 'parse-unconfirmed',
      diagnostics: file.parseDiagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, ' ')) };
  }
  const body = declaration.body;
  const parameterProperties = (declaration.parameters || []).filter(p =>
    p.modifiers?.some(m => [ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.PrivateKeyword,
      ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.ReadonlyKeyword].includes(m.kind))).length;
  return { stable_id: row.stable_id,
    status: ts.isVariableDeclaration(declaration) ? 'variable-binding'
      : !body ? 'signature-without-body'
        : ts.isBlock(body) && body.statements.length === 0
          ? parameterProperties ? 'empty-body-with-parameter-properties' : 'empty-body'
          : 'nonempty-body',
    parameterProperties, initializerKind: declaration.initializer ? ts.SyntaxKind[declaration.initializer.kind] : null,
    statementKinds: body && ts.isBlock(body) ? body.statements.map(n => ts.SyntaxKind[n.kind]) : [],
  };
});
process.stdout.write(JSON.stringify(results));
