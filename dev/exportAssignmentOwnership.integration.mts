import assert from 'node:assert/strict';
import ts from 'typescript';
import { createProgram, getExtendedStableId, getRepoRelativePath, isTrackedSourceFile } from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';
import { collectCanonicalReferenceGraph } from '../graph/static-extract/ts/functionFlowGraph.canonicalReferences.ts';

const program = createProgram();
const graph = collectCanonicalReferenceGraph(program);
const nodes = new Map(graph.entities.map(node => [node.stableId, node]));
const edges = new Map(graph.relationships.map(edge => [`${edge.fromId}\0${edge.type}\0${edge.toId}`, edge]));
const values = new Map(graph.relationships.filter(edge => edge.type === 'VALUE_FROM'
  && edge.props.exportAssignment === true).map(edge => [edge.fromId, edge]));
let exports = 0;
let wrapped = 0;
let equals = 0;
for (const source of program.getSourceFiles()) {
  if (!isTrackedSourceFile(source)) continue;
  function visit(node: ts.Node) {
    if (ts.isExportAssignment(node)) {
      const id = getExtendedStableId(source, node);
      const expression = getExtendedStableId(source, node.expression);
      const file = `source-file:${getRepoRelativePath(source.fileName)}`;
      assert.ok(nodes.get(id)?.labels.includes('DeclarationContainer'), id);
      assert.ok(nodes.get(id)?.labels.includes('ValueDeclaration'), id);
      assert.equal(nodes.get(id)?.props.declarationKind, 'ExportAssignment', id);
      assert.ok(nodes.get(file)?.labels.includes('SourceFile'), file);
      assert.equal(edges.get(`${id}\0ENCLOSED_BY\0${file}`)?.props.resolution,
        'nearest-materialized-ast-owner', id);
      if (nodes.has(expression)) {
        assert.equal(edges.get(`${id}\0AST_CHILD\0${expression}`)?.props.field, 'expression', id);
      }
      const value = values.get(id);
      assert.ok(value && nodes.has(value.toId), `Missing export value for ${id}`);
      assert.notEqual(value.toId, id);
      if (ts.isCallExpression(node.expression)) {
        assert.equal(value.toId, expression, `Export wrapper was bypassed: ${id}`);
      }
      assert.notEqual(id, expression);
      exports++;
      wrapped += Number(ts.isCallExpression(node.expression));
      equals += Number(Boolean(node.isExportEquals));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
assert.ok(exports > 0, 'No actual export assignments checked');
console.log(JSON.stringify({ ok: true, exports, wrapped, equals }));
