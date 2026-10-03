import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import paths from './projectPaths.cjs';

const requested = new Set<string>(JSON.parse(fs.readFileSync(0, 'utf8')));
const files = new Set([...requested].map(id => id.replace(/:\d+:\d+:\d+:\d+$/, '')));
const parents: Record<string, number> = {};
const found = new Set<string>();
for (const relative of files) {
  const absolute = path.resolve(paths.sourceRoot, relative);
  const source = ts.createSourceFile(absolute, fs.readFileSync(absolute, 'utf8'), ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node)) {
      const start = source.getLineAndCharacterOfPosition(node.getStart(source));
      const end = source.getLineAndCharacterOfPosition(node.getEnd());
      const id = `${relative}:${start.line+1}:${start.character}:${end.line+1}:${end.character}`;
      if (requested.has(id)) {
        found.add(id);
        const kind = ts.SyntaxKind[node.parent.kind];
        parents[kind] = (parents[kind] || 0)+1;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
if (found.size !== requested.size) throw new Error(`AST lookup missing ${requested.size-found.size} requested declarations`);
console.log(JSON.stringify({ requested: requested.size, found: found.size, parents }));
