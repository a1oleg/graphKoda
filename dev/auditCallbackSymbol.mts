import ts from 'typescript';
import path from 'node:path';

// Local symbol-use audit. Cross-file forwarding is deliberately reported as
// an escape to inspect, not guessed from a matching identifier spelling.
const [file, name, lineText] = process.argv.slice(2);
if (!file || !name || !Number.isInteger(Number(lineText))) {
  throw new Error('Usage: node --import tsx dev/auditCallbackSymbol.mts FILE NAME DECLARATION_LINE');
}
const absolute = path.resolve(file);
const program = ts.createProgram([absolute], { noResolve: true, noLib: true,
  target: ts.ScriptTarget.Latest, jsx: ts.JsxEmit.Preserve });
const checker = program.getTypeChecker();
const source = program.getSourceFile(absolute);
if (!source) throw new Error('Source file not found');
const symbolFor = (node: ts.Identifier) => ts.isShorthandPropertyAssignment(node.parent)
  ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
let selected: ts.Symbol | undefined;
function locate(node: ts.Node) {
  if (ts.isIdentifier(node) && node.text === name
    && source!.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 === Number(lineText)) {
    const symbol = symbolFor(node);
    if (symbol && selected && symbol !== selected) throw new Error('Ambiguous symbol on declaration line');
    selected ||= symbol;
  }
  ts.forEachChild(node, locate);
}
locate(source);
if (!selected) throw new Error('Symbol not found');
const uses: object[] = [];
function visit(node: ts.Node) {
  if (ts.isIdentifier(node) && symbolFor(node) === selected) {
    const parent = node.parent;
    let site: ts.Node = parent;
    while (site.parent && !ts.isStatement(site) && !ts.isJsxAttribute(site)
      && !ts.isCallExpression(site) && !ts.isVariableDeclaration(site)) site = site.parent;
    const pos = source!.getLineAndCharacterOfPosition(node.getStart(source));
    uses.push({ line: pos.line + 1, column: pos.character, parentKind: ts.SyntaxKind[parent.kind],
      directCall: ts.isCallExpression(parent) && parent.expression === node,
      syntax: site.getText(source).slice(0, 260) });
  }
  ts.forEachChild(node, visit);
}
visit(source);
console.log(JSON.stringify({ file, name, declarationLine: Number(lineText),
  scope: 'same-file-symbol-references; forwarding requires separate audit', uses }, null, 2));
