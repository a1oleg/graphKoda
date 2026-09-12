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
  assert.deepEqual(parts.map(p => p.text), ['items', 'setAt(', 'index', ',', 'read', ')']);
  assert(parts[1].labels.includes('Virtual'));
  assert(parts.every(p => p.sourceStableId));
});

test('Fisher extracts both writes and preserves source identity of nested calls', () => {
  const p = extract(['examples/fisher-yates/src/main.ts', 'examples/fisher-yates/src/shuffle.ts']);
  assert.equal(p.functions.length, 4);
  assert.equal(p.nodes.filter(n => n.labels.includes('Action') && n.renderPartsJson?.includes('setAt(')).length, 2);
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
