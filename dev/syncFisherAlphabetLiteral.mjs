import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { auraConnection } from './fisherYatesConfig.mjs';

const path = 'examples/fisher-yates/src/shuffle.ts';
const source = ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
const declarations = [];
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'alphabet') declarations.push(node);
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(declarations.length, 1);
const literal = declarations[0].initializer;
assert(literal && ts.isArrayLiteralExpression(literal));
assert(literal.elements.every(ts.isStringLiteral));
const syntax = literal.getText(source);
const start = source.getLineAndCharacterOfPosition(literal.getStart(source));
const end = source.getLineAndCharacterOfPosition(literal.getEnd());
const id = `${path}:${start.line + 1}:${start.character}:${end.line + 1}:${end.character}`;
const aura = auraConnection();
try {
  const result = await aura.session.executeWrite(async tx => {
    const found = await tx.run('MATCH (n:LiteralValue:MosaicPart {stableId:$id}) RETURN properties(n) AS props', { id });
    assert.equal(found.records.length, 1, `Expected existing literal ${id}; use scoped extraction if its coordinates changed`);
    const props = found.records[0].get('props');
    const descriptor = JSON.parse(props.descriptorJson);
    descriptor.text = syntax;
    const roleNames = (props.roleNames || []).map(name => name === props.syntax || name === props.name ? syntax : name);
    await tx.run(`MATCH (n {stableId:$id}) SET n.name=$syntax, n.syntax=$syntax,
      n.roleNames=$roleNames, n.descriptorJson=$descriptor`,
    { id, syntax, roleNames, descriptor: JSON.stringify(descriptor) });
    const check = await tx.run('MATCH (n {stableId:$id}) RETURN properties(n) AS props', { id });
    const updated = check.records[0].get('props');
    assert.equal(updated.name, syntax);
    assert.equal(updated.syntax, syntax);
    assert.equal(JSON.parse(updated.descriptorJson).text, syntax);
    assert(updated.roleNames.includes(syntax));
    return { stableId: id, syntax, updatedFields: ['name', 'syntax', 'roleNames', 'descriptorJson.text'] };
  });
  console.log(JSON.stringify(result));
} finally { await aura.session.close(); await aura.driver.close(); }
