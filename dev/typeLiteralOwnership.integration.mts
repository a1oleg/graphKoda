import assert from 'node:assert/strict';
import ts from 'typescript';
import { createProgram, getExtendedStableId, isTrackedSourceFile } from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';
import { collectCanonicalReferenceGraph } from '../graph/static-extract/ts/functionFlowGraph.canonicalReferences.ts';

const program = createProgram();
const graph = collectCanonicalReferenceGraph(program);
const nodes = new Map(graph.entities.map(node => [node.stableId, node]));
const edges = new Map(graph.relationships.map(edge => [`${edge.fromId}\0${edge.type}\0${edge.toId}`, edge]));
let literals = 0;
let members = 0;
let nestedLiterals = 0;
let parentheses = 0;
for (const source of program.getSourceFiles()) {
  if (!isTrackedSourceFile(source)) continue;
  const id = (node: ts.Node) => getExtendedStableId(source, node);
  function visit(node: ts.Node) {
    if (ts.isTypeLiteralNode(node) || ts.isParenthesizedTypeNode(node)) {
      assert.ok(nodes.get(id(node))?.labels.includes('DerivedType'), id(node));
      if (ts.isTypeLiteralNode(node)) {
        literals++;
        nestedLiterals += Number(!ts.isTypeAliasDeclaration(node.parent));
        for (const member of node.members) {
          if (!ts.isPropertySignature(member) && !ts.isMethodSignature(member)) continue;
          assert.equal(edges.get(`${id(node)}\0HAS_MEMBER\0${id(member)}`)?.props.ownership, 'direct', id(member));
          assert.equal(edges.get(`${id(node)}\0AST_CHILD\0${id(member)}`)?.props.field, 'members', id(member));
          if (ts.isTypeAliasDeclaration(node.parent)) {
            assert.ok(!edges.has(`${id(node.parent)}\0HAS_MEMBER\0${id(member)}`), id(member));
          }
          members++;
        }
      } else parentheses++;
      // Composite types must retain their actual parent, not jump to an alias.
      if (ts.isUnionTypeNode(node.parent) || ts.isIntersectionTypeNode(node.parent)
        || ts.isParenthesizedTypeNode(node.parent) || ts.isTypeAliasDeclaration(node.parent)
        || ts.isPropertySignature(node.parent)) {
        assert.ok(edges.has(`${id(node.parent)}\0AST_CHILD\0${id(node)}`), id(node));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
assert.ok(literals > 0 && members > 0 && nestedLiterals > 0, 'Actual nested type members required');
console.log(JSON.stringify({ ok: true, literals, members, nestedLiterals, parentheses, writesNeo4j: false }));
