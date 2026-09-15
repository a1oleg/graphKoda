import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import ts from 'typescript';

const revision = process.argv[2];
assert(revision, 'Provide the source revision used to generate the diagram');
const sourcePath = 'examples/fisher-yates/src/shuffle.ts';
const diagramPath = 'graph/draw/generated/Fisher-Yates.drawio';
const parse = text => ts.createSourceFile(sourcePath, text, ts.ScriptTarget.Latest, true);
const oldSource = parse(execFileSync('git', ['show', `${revision}:${sourcePath}`], { encoding: 'utf8' }));
const newSource = parse(fs.readFileSync(sourcePath, 'utf8'));
const aliases = new Map();
function span(source, start, end) {
  const a = source.getLineAndCharacterOfPosition(start);
  const b = source.getLineAndCharacterOfPosition(end);
  return `${sourcePath}:${a.line + 1}:${a.character}:${b.line + 1}:${b.character}`;
}
function pair(oldNode, newNode) {
  assert.equal(oldNode.kind, newNode.kind, 'AST structure changed; diagram needs regeneration');
  if (ts.isIdentifier(oldNode)) assert.equal(oldNode.text, newNode.text);
  aliases.set(span(oldSource, oldNode.getStart(oldSource), oldNode.end),
    span(newSource, newNode.getStart(newSource), newNode.end));
  if (ts.isFunctionDeclaration(oldNode)) {
    const keyword = (node, source) => node.getChildren(source).find(child => child.kind === ts.SyntaxKind.FunctionKeyword);
    aliases.set(span(oldSource, keyword(oldNode, oldSource).getStart(oldSource), oldNode.end),
      span(newSource, keyword(newNode, newSource).getStart(newSource), newNode.end));
  }
  const oldChildren = oldNode.getChildren(oldSource);
  const newChildren = newNode.getChildren(newSource);
  assert.equal(oldChildren.length, newChildren.length, 'AST structure changed; diagram needs regeneration');
  oldChildren.forEach((child, index) => pair(child, newChildren[index]));
}
pair(oldSource, newSource);
const xml = fs.readFileSync(diagramPath, 'utf8');
let changes = 0;
const replace = value => {
  const next = aliases.get(value);
  if (next && next !== value) { changes++; return next; }
  return value;
};
// Change only source IDs, including URL-encoded context links; retain geometry and labels verbatim.
const updated = xml.replace(/examples\/fisher-yates\/src\/shuffle\.ts:\d+:\d+:\d+:\d+/g, replace)
  .replace(/examples%2Ffisher-yates%2Fsrc%2Fshuffle\.ts%3A\d+%3A\d+%3A\d+%3A\d+/gi,
    value => encodeURIComponent(replace(decodeURIComponent(value))));
assert(changes > 0, 'No diagram source IDs changed');
fs.copyFileSync(diagramPath, 'tmp/fisher-yates/before-source-rebind.drawio');
fs.writeFileSync(diagramPath, updated);
console.log(JSON.stringify({ changes, diagramPath }));
