import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { composeExpandedFunctions } from './expandedFunctionDrawio.mjs';

process.env.COLDKODE_SOURCE_ROOT = process.cwd();
const { extractFunctionFlowGraphs, payloadForTransport } = await import('../graph/static-extract/ts/fromASTtoPreGraphFlow.ts');
const extract = files => payloadForTransport(extractFunctionFlowGraphs(ts.createProgram(files.map(f => path.resolve(f)), {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: [], strict: true,
})));

test('indexed array writes use virtual setAt, reads and object assignments do not', () => {
  const p = extract(['dev/fixtures/indexedWrites.ts']);
  const actions = p.nodes.filter(n => n.labels.includes('Action'));
  const writes = actions.filter(n => n.renderPartsJson?.includes('setAt('));
  assert.equal(writes.length, 1);
  const parts = JSON.parse(writes[0].renderPartsJson);
  assert.deepEqual(parts.map(p => p.text), ['items', 'setAt(']);
  assert.equal(p.edges.filter(e => e.fromId === writes[0].stableId && e.type === 'ARG').length, 2);
  assert.equal(parts[0].kind, 'collection-container');
  assert(parts[1].labels.includes('Virtual'));
  assert(parts.every(p => p.sourceStableId));
});

test('Fisher extracts both writes and preserves source identity of nested calls', () => {
  const p = extract(['examples/fisher-yates/src/main.ts', 'examples/fisher-yates/src/shuffle.ts']);
  assert.equal(p.functions.length, 4);
  assert.equal(p.nodes.filter(n => n.labels.includes('Action') && n.renderPartsJson?.includes('setAt(')).length, 2);
  const write = p.nodes.find(n => n.stableId === 'examples/fisher-yates/src/shuffle.ts:19:2:19:31');
  const reads = p.nodes.filter(n => n.stableId === 'examples/fisher-yates/src/shuffle.ts:19:17:19:30');
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
  const savedRead = p.nodes.find(n => n.stableId.startsWith('examples/fisher-yates/src/shuffle.ts:18:16:18:28'));
  assert(savedRead);
  assert.equal(JSON.parse(savedRead.renderPartsJson)[0].kind, 'collection-container');
  assert(!JSON.parse(write.renderPartsJson).some(p => p.text === 'second'));
  const last = 'examples/fisher-yates/src/shuffle.ts:20:2:20:24';
  const args = p.edges.filter(e => e.fromId === last && e.type === 'ARG');
  assert.equal(args.length, 2);
  const saved = args.find(e => e.argumentIndex === 1).toId;
  assert.equal(p.nodes.find(n => n.stableId === saved).diaName, 'saved');
  assert(!p.edges.some(e => [last, saved].includes(e.fromId) && e.type === 'EVAL'));
  const calls = p.nodes.filter(n => n.calleeName === 'randomIndex' && !n.labels.includes('Parameter'));
  assert(calls.length);
  assert(calls.every(n => n.sourceCallStableId === 'examples/fisher-yates/src/shuffle.ts:6:21:6:42'));
});

const xml = id => `<mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="start" vertex="1" parent="1" stableId="${id}:start" graphLabels="FunctionStart"><mxGeometry x="20" y="20" width="40" height="40" as="geometry"/></mxCell><mxCell id="call" vertex="1" parent="1" stableId="${id}:call"><mxGeometry x="20" y="100" width="90" height="40" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>`;
test('expanded functions retain unique cells and form nested offset blocks', () => {
  const result = composeExpandedFunctions('a', new Map([['a', { name: 'a' }], ['b', { name: 'b' }]]),
    [{ id: 'a:call', owner: 'a', callee: 'b' }], new Map([['a', xml('a')], ['b', xml('b')]]));
  assert.equal(result.boxes.length, 2);
  assert(result.boxes.find(b => b.id === 'a').width > result.boxes.find(b => b.id === 'b').width);
  assert.match(result.xml, /edgeType="CALLS"/);
});

test('extension tree replaces old actions with Fisher drawing from Aura', () => {
  const source = fs.readFileSync('graph/vscode-extension/extension.js', 'utf8');
  const tree = source.slice(source.indexOf('async getChildren('), source.indexOf('async function activate('));
  assert(!tree.includes('Annotation: speculationAccept'));
  assert(!tree.includes('Draw helpers'));
  assert(tree.includes('coldKodeGraphExplorer.openFisherYates'));
  assert(source.includes('dev/exportFisherYatesDrawio.mjs'));
});
