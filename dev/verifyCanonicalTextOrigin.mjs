import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const { sourceRoot, items } = JSON.parse(fs.readFileSync(0, 'utf8'));
const files = new Map();
const proven = [];
for (const item of items) {
  const match = /^(.*):(\d+):(\d+):(\d+):(\d+)$/.exec(item.id);
  if (!match) continue;
  const [, relative, sl, sc, el, ec] = match;
  const file = path.resolve(sourceRoot, relative);
  if (!file.startsWith(path.resolve(sourceRoot) + path.sep)) continue;
  if (!files.has(file)) files.set(file, ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true));
  const source = files.get(file);
  const start = source.getPositionOfLineAndCharacter(Number(sl) - 1, Number(sc));
  const end = source.getPositionOfLineAndCharacter(Number(el) - 1, Number(ec));
  let verified = false;
  function visit(node) {
    if (node.getStart(source) === start && node.end === end) {
      // Older flow rows stored the enclosing declaration on a binding element.
      if (ts.isBindingElement(node) && Object.keys(item.before).every(k => k === 'syntax') && item.after.syntax === node.getText(source)) {
        let parent = node.parent;
        while (parent && !ts.isVariableDeclaration(parent)) parent = parent.parent;
        verified ||= !!parent && item.before.syntax === parent.getText(source);
      }
      if (ts.isParameter(node) && node.dotDotDotToken && Object.keys(item.before).every(k => k === 'name')) {
        verified ||= item.after.name === node.name.getText(source) && item.before.name === `...${item.after.name}`;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (verified) proven.push(item.id);
}
process.stdout.write(JSON.stringify(proven));
