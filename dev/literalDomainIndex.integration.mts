import assert from 'node:assert/strict';
import ts from 'typescript';
import { createProgram, getStableId, isTrackedSourceFile } from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';
import { collectFiniteLiteralDomainGraph, type FiniteLiteralDomainGraph } from '../graph/static-extract/ts/functionFlowGraph.literalDomains.ts';
import { selectFiniteLiteralDomainContext } from '../graph/static-extract/ts/functionFlowGraph.literalDomainIndex.ts';

function reference(graph: FiniteLiteralDomainGraph, ids: Set<string>) {
  const occurrences = graph.occurrences.filter(row => row.parentFnStableId && ids.has(row.parentFnStableId));
  const occurrenceIds = new Set(occurrences.map(row => row.stableId));
  const domainIds = new Set(occurrences.map(row => row.domainStableId));
  const memberIds = new Set<string>();
  for (const row of graph.relationships) {
    if (row.type === 'HAS_MEMBER' && domainIds.has(row.fromId)) memberIds.add(row.toId);
  }
  return {
    occurrences,
    entities: graph.entities.filter(row => occurrenceIds.has(row.stableId) || domainIds.has(row.stableId) || memberIds.has(row.stableId)),
    relationships: graph.relationships.filter(row => (row.type === 'HAS_MEMBER' && domainIds.has(row.fromId))
      || (row.type === 'RESOLVES_TO' && occurrenceIds.has(row.fromId))),
  };
}

const program = createProgram();
const graph = collectFiniteLiteralDomainGraph(program);
const ids = new Set<string>();
for (const source of program.getSourceFiles()) {
  if (!isTrackedSourceFile(source)) continue;
  function visit(node: ts.Node) {
    if (ts.isFunctionLike(node) && 'body' in node && node.body) ids.add(getStableId(source, node));
    ts.forEachChild(node, visit);
  }
  visit(source);
}
assert.ok(ids.size && graph.occurrences.length, 'Actual functions and literal occurrences required');
const selections = [...ids].map(id => new Set([id]));
const indexStarted = performance.now();
selectFiniteLiteralDomainContext(graph, []);
const indexSeconds = (performance.now() - indexStarted) / 1000;
let baselineSeconds = 0;
let indexedSeconds = 0;
let matchedOccurrences = 0;
for (const selection of selections) {
  let started = performance.now();
  const expected = reference(graph, selection);
  baselineSeconds += (performance.now() - started) / 1000;
  started = performance.now();
  const actual = selectFiniteLiteralDomainContext(graph, selection);
  indexedSeconds += (performance.now() - started) / 1000;
  assert.deepEqual(actual, expected);
  matchedOccurrences += actual.occurrences.length;
}
assert.deepEqual(selectFiniteLiteralDomainContext(graph, ids), reference(graph, ids));
assert.deepEqual(selectFiniteLiteralDomainContext(graph, []), reference(graph, new Set()));
console.log(JSON.stringify({ ok: true, functions: ids.size, occurrences: graph.occurrences.length,
  matchedOccurrences, entities: graph.entities.length, relationships: graph.relationships.length,
  indexSeconds, baselineSeconds, indexedSeconds }));
