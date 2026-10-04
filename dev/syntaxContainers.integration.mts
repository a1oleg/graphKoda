import assert from 'node:assert/strict';
import ts from 'typescript';
import { createProgram, getExtendedStableId, getRepoRelativePath, isTrackedSourceFile } from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';
import { collectCanonicalReferenceGraph } from '../graph/static-extract/ts/functionFlowGraph.canonicalReferences.ts';

const program = createProgram();
const graph = collectCanonicalReferenceGraph(program);
const nodes = new Map(graph.entities.map(node => [node.stableId, node]));
const edges = new Map(graph.relationships.map(edge => [`${edge.fromId}\0${edge.type}\0${edge.toId}`, edge]));
const counts: Record<string, number> = {};
let directChildren = 0;
for (const source of program.getSourceFiles()) {
  if (!isTrackedSourceFile(source)) continue;
  const id = (node: ts.Node) => getExtendedStableId(source, node);
  function visit(node: ts.Node) {
    if (ts.isSourceFile(node)) {
      const sourceId = `source-file:${getRepoRelativePath(node.fileName)}`;
      if (nodes.has(sourceId)) {
        assert.ok(nodes.get(sourceId)?.labels.includes('SourceFile'), sourceId);
        assert.ok(!nodes.get(sourceId)?.labels.includes('ValueDeclaration'), sourceId);
        ts.forEachChild(node, child => {
          if (!nodes.has(id(child))) return;
          assert.ok(edges.has(`${sourceId}\0AST_CHILD\0${id(child)}`), id(child));
          directChildren++;
        });
      }
    }
    if (ts.isReturnStatement(node) && node.expression) {
      const edge = edges.get(`${id(node)}\0AST_CHILD\0${id(node.expression)}`);
      assert.equal(edge?.props.field, 'expression', id(node));
      counts.ReturnStatement = (counts.ReturnStatement || 0) + 1;
      directChildren++;
    }
    if (ts.isSwitchStatement(node) || ts.isCaseBlock(node) || ts.isCaseClause(node)
      || ts.isDefaultClause(node) || ts.isPropertyAccessExpression(node) || ts.isParenthesizedExpression(node)
      || ts.isTemplateExpression(node) || ts.isTemplateSpan(node) || ts.isNewExpression(node)
      || ts.isConditionalExpression(node) || ts.isNonNullExpression(node) || ts.isPrefixUnaryExpression(node)
      || ts.isJsxElement(node) || ts.isJsxFragment(node) || ts.isJsxExpression(node)
      || ts.isJsxAttributes(node) || ts.isJsxAttribute(node) || ts.isJsxSpreadAttribute(node)
      || (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind))) {
      assert.ok(nodes.get(id(node))?.labels.includes('SyntaxContainer'), id(node));
      const kind = ts.SyntaxKind[node.kind];
      counts[kind] = (counts[kind] || 0) + 1;
      ts.forEachChild(node, child => {
        if (id(child) === id(node) || !nodes.has(id(child))) return;
        const edge = edges.get(`${id(node)}\0AST_CHILD\0${id(child)}`);
        assert.ok(edge?.props.field, id(child));
        assert.equal(edge?.props.projection, undefined, id(child));
        directChildren++;
      });
      if (ts.isCaseBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
        assert.ok(edges.has(`${id(node.parent)}\0AST_CHILD\0${id(node)}`), id(node));
      }
      if (ts.isSwitchStatement(node)) {
        assert.ok(edges.has(`${id(node)}\0AST_CHILD\0${id(node.caseBlock)}`), id(node));
        assert.ok(edges.has(`${id(node)}\0AST_CHILD\0${id(node.expression)}`), id(node.expression));
      }
      if (ts.isNewExpression(node)) {
        const token = node.getChildren(source).find(child => child.kind === ts.SyntaxKind.NewKeyword);
        assert.ok(token, id(node));
        assert.ok(nodes.get(id(token))?.labels.includes('System'), id(token));
        assert.equal(edges.get(`${id(node)}\0AST_CHILD\0${id(token)}`)?.props.field, 'newKeyword');
      }
    }
    if (ts.isTypePredicateNode(node)) {
      assert.ok(nodes.get(id(node))?.labels.includes('DerivedType'), id(node));
      assert.ok(edges.has(`${id(node.parent)}\0AST_CHILD\0${id(node)}`), id(node));
      counts.TypePredicate = (counts.TypePredicate || 0) + 1;
    }
    if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      assert.ok(nodes.get(id(node))?.labels.includes('System'), id(node));
      assert.ok(edges.has(`${id(node.parent)}\0AST_CHILD\0${id(node)}`), id(node));
      counts.TemplateSegments = (counts.TemplateSegments || 0) + 1;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
assert.ok(directChildren > 0);
console.log(JSON.stringify({ ok: true, counts, directChildren, writesGraph: false }));
