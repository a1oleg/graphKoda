import assert from 'node:assert/strict';
import ts from 'typescript';
import { createProgram, getExtendedStableId, getRepoRelativePath, isTrackedSourceFile } from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';
import { collectCanonicalReferenceGraph } from '../graph/static-extract/ts/functionFlowGraph.canonicalReferences.ts';

const program = createProgram();
const graph = collectCanonicalReferenceGraph(program);
const entities = new Map(graph.entities.map(e => [e.stableId, e]));
const edges = new Map(graph.relationships.filter(e => e.type === 'AST_CHILD')
  .map(e => [`${e.fromId}\0${e.toId}`, e]));
const owners = new Map(graph.relationships.filter(e => e.type === 'ENCLOSED_BY'
  && e.props.resolution === 'nearest-materialized-ast-owner').map(e => [e.fromId, e]));
function id(node: ts.Node) {
  return getExtendedStableId(node.getSourceFile(), node);
}
let declarations = 0, lists = 0, statements = 0, loopLists = 0, multipleLists = 0, sharedRanges = 0;
for (const source of program.getSourceFiles()) {
  if (!isTrackedSourceFile(source)) continue;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclarationList(node) || ts.isVariableStatement(node)) {
      let ancestor = node.parent;
      while (ancestor) {
        const target = ts.isSourceFile(ancestor)
          ? `source-file:${getRepoRelativePath(ancestor.fileName)}` : id(ancestor);
        if (target !== id(node) && entities.has(target)) {
          assert.equal(owners.get(id(node))?.toId, target, id(node));
          break;
        }
        ancestor = ancestor.parent;
      }
      assert.ok(ancestor, `Missing AST boundary for ${id(node)}`);
    }
    if (ts.isVariableDeclarationList(node)) {
      const listId = id(node);
      assert.ok(entities.get(listId)?.labels.includes('DeclarationContainer'), listId);
      for (const declaration of node.declarations) {
        assert.equal(edges.get(`${listId}\0${id(declaration)}`)?.props.field, 'declarations', id(declaration));
        declarations++;
      }
      if (ts.isVariableStatement(node.parent)) {
        if (id(node.parent) === listId) sharedRanges++;
        else assert.equal(edges.get(`${id(node.parent)}\0${listId}`)?.props.field, 'declarationList', listId);
        statements++;
      } else if (ts.isForStatement(node.parent) || ts.isForInStatement(node.parent) || ts.isForOfStatement(node.parent)) {
        loopLists++;
      }
      if (node.declarations.length > 1) multipleLists++;
      lists++;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
assert.ok(declarations > 0 && statements > 0, 'No actual source declarations checked');
for (const start of owners.keys()) {
  const seen = new Set<string>();
  let current = start;
  while (owners.has(current)) {
    assert.ok(!seen.has(current), `Containment cycle at ${current}`);
    seen.add(current);
    current = owners.get(current)!.toId;
  }
  assert.ok(entities.has(current), current);
}
console.log(JSON.stringify({ ok: true, declarations, lists, statements, loopLists, multipleLists, sharedRanges }));
