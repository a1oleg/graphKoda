import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

process.env.COLDKODE_SOURCE_ROOT = process.cwd();
const { extractFunctionFlowGraphs, payloadForTransport } = await import('../graph/static-extract/ts/fromASTtoPreGraphFlow.ts');
const extract = files => payloadForTransport(extractFunctionFlowGraphs(ts.createProgram(files.map(f => path.resolve(f)), {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: [], strict: true,
})));

test('for initializes once, branches, and updates after the body before retesting', () => {
  const p = extract(['examples/fisher-yates/src/shuffle.ts']);
  const id = suffix => `examples/fisher-yates/src/shuffle.ts:${suffix}`;
  const initial = p.nodes.find(n => n.stableId === id('5:11:5:18'));
  const condition = p.nodes.find(n => n.stableId === id('5:42:5:53'));
  const update = p.nodes.find(n => n.stableId === id('5:55:5:64'));
  assert(initial?.labels.includes('ValueCreate'));
  assert(p.edges.some(e => e.fromId === initial.stableId && e.type === 'EVAL'));
  assert(condition?.labels.includes('Branch'));
  assert.deepEqual(JSON.parse(update.renderPartsJson).map(part => part.text), ['current', '--']);
  assert(JSON.parse(update.renderPartsJson)[1].labels.includes('System'));
  const edge = (from, to, type) => p.edges.some(e => e.fromId === from && e.toId === to && e.type === type);
  assert(edge(initial.stableId, condition.stableId, 'NEXT'));
  assert(edge(condition.stableId, id('6:10:6:16'), 'TRUE'));
  assert(edge(condition.stableId, id('10:2:10:18:return'), 'FALSE'));
  assert(edge(id('7:4:7:35'), update.stableId, 'NEXT'));
  assert(edge(update.stableId, initial.stableId, 'REPEATS'));
  assert(p.edges.some(e => e.type === 'REPEATS' && e.toId === initial.stableId
    && e.executionOutcome === 'resume-without-initialization'));
  assert(p.edges.some(e => e.fromId === initial.stableId && e.type === 'EVAL'
    && e.executionOutcome === 'initialization-only'));
  const entry = p.nodes.find(n => n.labels.includes('For'));
  assert(entry.labels.includes('System'));
  assert(entry.labels.includes('Method'));
  assert.notEqual(entry.parentStepStableId, condition.parentStepStableId);
  assert.equal(entry.parentFlowBlockStableId, undefined);
  assert.equal(initial.parentFlowBlockStableId, condition.parentFlowBlockStableId);
  assert.equal(initial.parentFlowBlockStableId, update.parentFlowBlockStableId);
  assert(initial.flowStepOrder < condition.flowStepOrder);
  assert(condition.flowStepOrder < update.flowStepOrder);
  assert(edge(id('2:8:2:16'), entry.stableId, 'NEXT'));
  assert(edge(entry.stableId, initial.stableId, 'NEXT'));
  const returned = p.nodes.find(n => n.stableId === id('10:2:10:18:return'));
  assert.deepEqual(JSON.parse(returned.renderPartsJson).map(part => part.text), ['return(', 'alphabet', ')']);
});




test('Fisher extracts both writes and preserves source identity of nested calls', () => {
  const p = extract(['examples/fisher-yates/src/main.ts', 'examples/fisher-yates/src/shuffle.ts']);
  assert.equal(p.functions.length, 3);
  assert.deepEqual(p.functions.map(f => f.name).sort(), ['getRandom', 'shuffle', 'swap']);
  assert(p.functions.every(f => f.stableId.startsWith('examples/fisher-yates/src/shuffle.ts:')));
  const getRandom = p.functions.find(f => f.name === 'getRandom');
  const mathReturn = p.nodes.find(n => n.parentFnStableId === getRandom.stableId && n.labels.includes('Return'));
  assert.deepEqual(JSON.parse(mathReturn.renderPartsJson).map(part => part.text), ['return(', 'index', ')']);
  const index = p.nodes.find(n => n.parentFnStableId === getRandom.stableId && n.labels.includes('ValueCreate') && n.diaName === 'index');
  assert(index);
  assert(p.edges.some(e => e.fromId === index.stableId && e.type === 'EVAL'));
  assert(p.edges.some(e => e.fromId === index.stableId && e.toId === mathReturn.stableId && e.type === 'NEXT'));
  assert.equal(p.nodes.filter(n => !n.labels.includes('Step')
    && n.renderPartsJson?.includes('floor(')).length, 1);
  for (const name of ['length', 'current', 'random']) {
    const parameter = p.nodes.find(n => n.labels.includes('Parameter') && n.diaName === name);
    assert(parameter, name);
    assert(!parameter.labels.includes('OperationProvider'), name);
    assert.equal(JSON.parse(parameter.renderPartsJson)[0].kind, 'value-container');
  }
  assert.equal(p.nodes.filter(n => n.labels.includes('Action') && n.renderPartsJson?.includes('setAt(')).length, 2);
  const write = p.nodes.find(n => n.stableId === 'examples/fisher-yates/src/shuffle.ts:20:2:20:39');
  const reads = p.nodes.filter(n => n.stableId === 'examples/fisher-yates/src/shuffle.ts:20:22:20:38');
  assert.equal(reads.length, 1);
  assert(reads[0].labels.includes('IndexedRead'));
  assert.equal(JSON.parse(reads[0].renderPartsJson)[0].kind, 'collection-container');
  const slotId = `${write.stableId}:value-slot`;
  const slot = p.nodes.find(n => n.stableId === slotId);
  assert.equal(slot.diaName, '');
  assert.equal(slot.containerState, 'empty');
  assert(slot.labels.includes('Virtual'));
  assert(p.edges.some(e => e.fromId === slotId && e.toId === reads[0].stableId && e.type === 'EVAL'
    && e.sourceRenderPartStableId === `${write.stableId}:container`));
  assert(p.edges.some(e => e.fromId === `${write.stableId}:complete` && e.type === 'NEXT'
    && e.sourceRenderPartStableId === `${write.stableId}:container`));
  const returned = p.edges.find(e => e.fromId === reads[0].stableId && e.toId === slotId && e.type === 'ASSIGNS_VALUE');
  assert(returned);
  assert.equal(returned.targetRenderPartStableId, `${slotId}:set`);
  assert.equal(returned.sourceRenderPartStableId, `${reads[0].stableId}:get`);
  assert.equal(returned.producerRouteRole, 'return-bottom');
  const savedRead = p.nodes.find(n => n.stableId.startsWith('examples/fisher-yates/src/shuffle.ts:19:19:19:36'));
  assert(savedRead);
  assert.equal(JSON.parse(savedRead.renderPartsJson)[0].kind, 'collection-container');
  assert(!JSON.parse(write.renderPartsJson).some(p => p.text === 'random'));
  const current = 'examples/fisher-yates/src/shuffle.ts:21:2:21:30';
  const args = p.edges.filter(e => e.fromId === current && e.type === 'ARG');
  assert.equal(args.length, 2);
  for (const writeId of [write.stableId, current]) {
    const argumentsInOrder = p.edges.filter(e => e.fromId === writeId && e.type === 'ARG').sort((a, b) => a.argumentIndex - b.argumentIndex);
    assert.deepEqual(argumentsInOrder.map(e => e.argumentName), ['index', 'value']);
    assert.deepEqual(argumentsInOrder.map(e => e.displayLabel), ['index', 'value']);
  }
  const saved = args.find(e => e.argumentIndex === 1).toId;
  assert.equal(p.nodes.find(n => n.stableId === saved).diaName, 'temporal');
  assert(!p.edges.some(e => [current, saved].includes(e.fromId) && e.type === 'EVAL'));
  const calls = p.nodes.filter(n => n.calleeName === 'getRandom' && !n.labels.includes('Parameter'));
  assert(calls.length);
  assert(calls.every(n => n.sourceCallStableId === 'examples/fisher-yates/src/shuffle.ts:6:19:6:41'));
});


test('extension tree replaces old actions with Fisher drawing from Aura', () => {
  const source = fs.readFileSync('graph/vscode-extension/extension.js', 'utf8');
  const tree = source.slice(source.indexOf('async getChildren('), source.indexOf('async function activate('));
  assert(!tree.includes('Annotation: speculationAccept'));
  assert(!tree.includes('Draw helpers'));
  assert(tree.includes('coldKodeGraphExplorer.openFisherYates'));
  assert(source.includes('dev/exportFisherYatesDrawio.mjs'));
});
