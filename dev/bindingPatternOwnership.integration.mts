import assert from 'node:assert/strict';
import ts from 'typescript';
import { createProgram, getRepoRelativePath, isTrackedSourceFile } from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';
import { collectCanonicalReferenceGraph } from '../graph/static-extract/ts/functionFlowGraph.canonicalReferences.ts';

const program = createProgram();
const graph = collectCanonicalReferenceGraph(program);
const entities = new Map(graph.entities.map(e => [e.stableId,e]));
const edges = new Map(graph.relationships.filter(e => e.type==='AST_CHILD')
  .map(e => [`${e.fromId}\0${e.toId}`,e]));
function id(node: ts.Node) {
  const file = node.getSourceFile();
  const start = file.getLineAndCharacterOfPosition(node.getStart(file));
  const end = file.getLineAndCharacterOfPosition(node.getEnd());
  return `${getRepoRelativePath(file.fileName)}:${start.line+1}:${start.character}:${end.line+1}:${end.character}`;
}
let patterns = 0, elements = 0, nested = 0, sharedRanges = 0;
const examples: string[] = [];
for (const source of program.getSourceFiles()) {
  if (!isTrackedSourceFile(source)) continue;
  function visit(node: ts.Node) {
    if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
      const parent = id(node.parent), pattern = id(node);
      assert.ok(entities.has(parent), `Missing declaration ${parent}`);
      assert.ok(entities.has(pattern), `Missing pattern ${pattern}`);
      if (parent!==pattern) {
        assert.equal(edges.get(`${parent}\0${pattern}`)?.props.field,'name', pattern);
      } else {
        assert.ok(!entities.get(pattern)!.labels.includes('System'), `Declaration marked system: ${pattern}`);
        sharedRanges++;
      }
      for (const element of node.elements) {
        if (!ts.isBindingElement(element)) continue;
        assert.equal(edges.get(`${pattern}\0${id(element)}`)?.props.field,'elements', id(element));
        elements++;
      }
      if (ts.isBindingElement(node.parent)) nested++;
      patterns++;
      if (examples.length<3) examples.push(pattern);
    }
    ts.forEachChild(node,visit);
  }
  visit(source);
}
assert.ok(patterns>0 && nested>0 && sharedRanges>0);
console.log(JSON.stringify({ok:true,patterns,elements,nested,sharedRanges,examples}));
