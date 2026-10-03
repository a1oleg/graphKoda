import assert from 'node:assert/strict';
import ts from 'typescript';
import { createProgram, getExtendedStableId, isTrackedSourceFile } from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';
import { collectCanonicalReferenceGraph } from '../graph/static-extract/ts/functionFlowGraph.canonicalReferences.ts';

const program = createProgram();
const graph = collectCanonicalReferenceGraph(program);
const entities = new Map(graph.entities.map(entity => [entity.stableId, entity]));
const nameEdges = new Map(graph.relationships.filter(edge => edge.type === 'AST_CHILD'
  && edge.props.field === 'name').map(edge => [`${edge.fromId}\0${edge.toId}`, edge]));
let checked = 0;
const kinds = new Map<string, number>();
for (const source of program.getSourceFiles()) {
  if (!isTrackedSourceFile(source)) continue;
  function visit(node: ts.Node) {
    const id = getExtendedStableId(source, node);
    const entity = entities.get(id);
    const name = (node as ts.NamedDeclaration).name;
    if (entity?.props.canonical && entity.props.declarationKind && name && !ts.isPropertyAccessExpression(node)
      && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)
        || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name))) {
      const nameId = getExtendedStableId(source, name);
      if (id !== nameId) {
        assert.ok(entities.get(nameId)?.labels.includes('DeclarationName'), nameId);
        assert.ok(nameEdges.has(`${id}\0${nameId}`), `${id} -> ${nameId}`);
        checked++;
        const kind = ts.SyntaxKind[node.kind];
        kinds.set(kind, (kinds.get(kind) || 0) + 1);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
assert.ok(checked > 0, 'No actual declaration names checked');
assert.ok(!graph.relationships.some(edge => edge.type === 'AST_CHILD'
  && edge.props.field === 'name' && edge.fromId === edge.toId));
console.log(JSON.stringify({ ok: true, checked, kinds: Object.fromEntries(kinds) }));
