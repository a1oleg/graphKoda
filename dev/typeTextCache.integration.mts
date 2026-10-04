import assert from 'node:assert/strict';
import ts from 'typescript';
import { createProgram, isTrackedSourceFile } from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';
import { getNodeTypeTextForChecker } from '../graph/static-extract/ts/functionFlowGraph.operands.ts';

const program = createProgram();
const checker = program.getTypeChecker();
const nodes: ts.Node[] = [];
for (const source of program.getSourceFiles()) {
  if (!isTrackedSourceFile(source)) continue;
  function visit(node: ts.Node) {
    if (ts.isExpression(node) || ts.isTypeNode(node)) nodes.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
}
assert.ok(nodes.length, 'Actual source expressions required');
for (const node of nodes) {
  const expected = checker.typeToString(checker.getTypeAtLocation(node));
  assert.equal(getNodeTypeTextForChecker(checker, node), expected);
  assert.equal(getNodeTypeTextForChecker(checker, node), expected);
}
assert.equal(getNodeTypeTextForChecker(undefined, nodes[0]), undefined);
assert.equal(getNodeTypeTextForChecker(checker, undefined), undefined);
function benchmark(run: (node: ts.Node) => string | undefined) {
  const started = performance.now();
  let characters = 0;
  for (let pass = 0; pass < 3; pass++) for (const node of nodes) characters += run(node)?.length || 0;
  return { seconds: (performance.now() - started) / 1000, characters };
}
const uncached = benchmark(node => checker.typeToString(checker.getTypeAtLocation(node)));
const cached = benchmark(node => getNodeTypeTextForChecker(checker, node));
assert.equal(cached.characters, uncached.characters);
const rebuilt = createProgram(program);
const nextChecker = rebuilt.getTypeChecker();
assert.notEqual(nextChecker, checker);
let rebuiltNodes = 0;
for (const source of rebuilt.getSourceFiles()) {
  if (!isTrackedSourceFile(source)) continue;
  function visit(node: ts.Node) {
    if (ts.isExpression(node) || ts.isTypeNode(node)) {
      assert.equal(getNodeTypeTextForChecker(nextChecker, node), nextChecker.typeToString(nextChecker.getTypeAtLocation(node)));
      rebuiltNodes++;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
assert.equal(rebuiltNodes, nodes.length);
console.log(JSON.stringify({ ok: true, nodes: nodes.length, rebuiltNodes, uncached, cached,
  limitation: 'Repeated type-string lookups only, not end-to-end import timing.' }));
