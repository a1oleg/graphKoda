import assert from 'node:assert/strict';
import path from 'node:path';
import ts from 'typescript';
import { createProgram, getExtendedStableId, isTrackedSourceFile } from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';
import { collectCanonicalReferenceGraph } from '../graph/static-extract/ts/functionFlowGraph.canonicalReferences.ts';
import { extractFunctionFlowGraphs } from '../graph/static-extract/ts/fromASTtoPreGraphFlow.ts';

const program = createProgram();
const graph = collectCanonicalReferenceGraph(program);
const nodes = new Map(graph.entities.map(node => [node.stableId, node]));
const edges = new Map(graph.relationships.map(edge => [`${edge.fromId}\0${edge.type}\0${edge.toId}`, edge]));
let statements = 0;
let returnStatements = 0;
let expressions = 0;
let sameRangeStatements = 0;
let keywordTypes = 0;
const keywordIds = new Set<string>();
for (const source of program.getSourceFiles()) {
  if (!isTrackedSourceFile(source)) continue;
  const id = (node: ts.Node) => getExtendedStableId(source, node);
  function visit(node: ts.Node) {
    if (ts.isExpressionStatement(node) || ts.isReturnStatement(node)) {
      statements++;
      returnStatements += Number(ts.isReturnStatement(node));
      assert.ok(nodes.get(id(node))?.labels.includes('SyntaxContainer'), id(node));
      if (node.expression && id(node) !== id(node.expression) && nodes.has(id(node.expression))) {
        assert.equal(edges.get(`${id(node)}\0AST_CHILD\0${id(node.expression)}`)?.props.field,
          'expression', id(node));
        expressions++;
      } else if (node.expression && id(node) === id(node.expression)) {
        sameRangeStatements++;
        assert.ok(!edges.has(`${id(node)}\u0000AST_CHILD\u0000${id(node)}`), id(node));
      }
      assert.ok(graph.relationships.some(edge => edge.fromId === id(node)
        && edge.type === 'ENCLOSED_BY'
        && edge.props.syntaxOwnerResolution === 'nearest-materialized-ast-owner'), id(node));
    }
    if (ts.isTypeNode(node) && node.kind >= ts.SyntaxKind.FirstKeyword && node.kind <= ts.SyntaxKind.LastKeyword) {
      keywordTypes++;
      keywordIds.add(id(node));
      assert.ok(nodes.get(id(node))?.labels.includes('System'), id(node));
      if (nodes.has(id(node.parent)) && id(node.parent) !== id(node)) {
        assert.ok(edges.has(`${id(node.parent)}\0AST_CHILD\0${id(node)}`), id(node));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
assert.ok(statements > 0 && keywordTypes > 0, 'Actual statements and keyword types required');
const payload = extractFunctionFlowGraphs(program, undefined, undefined, { includeParameterOrigins: false });
for (const entity of payload.semanticEntities || []) {
  if (entity.labels.includes('SyntaxComposition')) assert.ok(!path.isAbsolute(entity.stableId), entity.stableId);
}
let mergedBoundaries = 0;
for (const entity of graph.entities) {
  if (!entity.labels.includes('MergedSymbol')) continue;
  const parts = graph.relationships.filter(edge => edge.fromId === entity.stableId && edge.type === 'HAS_DECLARATION_PART');
  const allExternal = parts.length > 0 && parts.every(edge => nodes.get(edge.toId)?.labels.includes('ExternalBoundary'));
  assert.equal(entity.labels.includes('ExternalBoundary'), allExternal, entity.stableId);
  mergedBoundaries += Number(allExternal);
}
let returnTypes = 0;
for (const node of payload.nodes) {
  if (!node.labels.includes('ReturnType') || !keywordIds.has(node.stableId.value)) continue;
  assert.ok(node.labels.includes('System'), node.stableId.value);
  assert.ok(!node.labels.includes('DeveloperDefined'), node.stableId.value);
  returnTypes++;
}
assert.ok(returnTypes > 0, 'Actual built-in return types required');
console.log(JSON.stringify({ ok: true, statements, returnStatements, expressions, sameRangeStatements, keywordTypes, returnTypes, mergedBoundaries, writesNeo4j: false }));
