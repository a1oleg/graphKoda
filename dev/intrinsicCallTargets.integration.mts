import assert from 'node:assert/strict';
import ts from 'typescript';
import { createProgram, getExtendedStableId, isTrackedSourceFile } from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';
import { collectCanonicalReferenceGraph } from '../graph/static-extract/ts/functionFlowGraph.canonicalReferences.ts';

const program = createProgram();
const checker = program.getTypeChecker();
const graph = collectCanonicalReferenceGraph(program);
const nodes = new Map(graph.entities.map(node => [node.stableId, node]));
const edges = new Set(graph.relationships.map(edge => `${edge.fromId}\0${edge.type}\0${edge.toId}`));
let intrinsicValues = 0;
let wrappedCalls = 0;
for (const source of program.getSourceFiles()) {
  if (!isTrackedSourceFile(source)) continue;
  const id = (node: ts.Node) => getExtendedStableId(source, node);
  function visit(node: ts.Node) {
    if (ts.isIdentifier(node) && node.text === 'undefined'
      && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
      && (checker.getTypeAtLocation(node).flags & ts.TypeFlags.Undefined)
      && !checker.getSymbolAtLocation(node)?.declarations?.length) {
      const entity = nodes.get(id(node));
      assert.ok(entity?.labels.includes('System'), id(node));
      assert.ok(entity?.labels.includes('LiteralValue'), id(node));
      assert.ok(!entity?.labels.includes('Reference'), id(node));
      assert.equal(entity?.props.value_kind, 'undefined', id(node));
      intrinsicValues++;
    }
    if (ts.isCallExpression(node)) {
      let expression: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
        || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression)
        || ts.isNonNullExpression(expression)) expression = expression.expression;
      if (expression !== node.expression && ts.isPropertyAccessExpression(expression)) {
        assert.ok(edges.has(`${id(node)}\0CALLS_VALUE\0${id(expression.name)}`), id(node));
        assert.ok(edges.has(`${id(expression.name)}\0READS_FROM\0${id(expression.expression)}`), id(node));
        assert.ok(!nodes.get(id(node.expression))?.labels.includes('Reference'), id(node.expression));
        wrappedCalls++;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
assert.ok(intrinsicValues > 0);
console.log(JSON.stringify({ ok: true, intrinsicValues, wrappedCalls, writesGraph: false }));
