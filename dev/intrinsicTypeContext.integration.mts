import assert from 'node:assert/strict';
import ts from 'typescript';
import { createProgram, getExtendedStableId, isTrackedSourceFile } from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';
import { collectCanonicalReferenceGraph } from '../graph/static-extract/ts/functionFlowGraph.canonicalReferences.ts';

const program = createProgram();
const graph = collectCanonicalReferenceGraph(program);
const nodes = new Map(graph.entities.map(node => [node.stableId, node]));
const edges = new Set(graph.relationships.map(edge => `${edge.fromId}\0${edge.type}\0${edge.toId}`));
let literalTypes = 0;
let assertions = 0;
let templateSpans = 0;
for (const source of program.getSourceFiles()) {
  if (!isTrackedSourceFile(source)) continue;
  const id = (node: ts.Node) => getExtendedStableId(source, node);
  function visit(node: ts.Node) {
    const constAssertion = ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)
      && node.typeName.text === 'const'
      && (ts.isAsExpression(node.parent) || ts.isTypeAssertionExpression(node.parent));
    if (ts.isLiteralTypeNode(node) || constAssertion) {
      const entity = nodes.get(id(node));
      assert.ok(entity?.labels.includes('System'), id(node));
      assert.ok(entity?.labels.includes('SyntaxPart'), id(node));
      assert.ok(!entity?.labels.includes('Reference'), id(node));
      if (nodes.has(id(node.parent)) && id(node.parent) !== id(node)) {
        assert.ok(edges.has(`${id(node.parent)}\0AST_CHILD\0${id(node)}`), id(node));
      }
      if (ts.isLiteralTypeNode(node)) literalTypes++;
      else assertions++;
    }
    if (ts.isTemplateLiteralTypeSpan(node) || ts.isAsExpression(node)
      || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) {
      assert.ok(nodes.get(id(node))?.labels.includes('SyntaxContainer'), id(node));
      ts.forEachChild(node, child => {
        if (nodes.has(id(child)) && id(child) !== id(node)) {
          assert.ok(edges.has(`${id(node)}\0AST_CHILD\0${id(child)}`), id(child));
        }
      });
      if (ts.isTemplateLiteralTypeSpan(node)) templateSpans++;
    }
    if ((ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)
      || ts.isParameter(node) || ts.isVariableDeclaration(node))
      && node.type && ts.isLiteralTypeNode(node.type)) {
      assert.ok(edges.has(`${id(node)}\0TYPED_AS\0${id(node.type)}`), id(node));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
assert.ok(literalTypes > 0, 'Real source must include literal types');
console.log(JSON.stringify({ ok: true, literalTypes, assertions, templateSpans, writesNeo4j: false }));
