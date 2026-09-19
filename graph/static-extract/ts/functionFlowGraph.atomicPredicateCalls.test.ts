import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { extractFunctionFlowGraphs } from './fromASTtoPreGraphFlow.ts';

test('computed field predicates evaluate a call family and return its field into a virtual boolean set', () => {
  const file = path.resolve('tmp/atomic-predicate-calls.fixture.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `
declare function load<T>(key: string, fallback: T): Promise<T>;
declare function lookup(key: string, fallback: { enabled: boolean }): { enabled: boolean };
export async function subject(): Promise<boolean> {
  if ((await load<{ enabled: boolean }>('flag', { enabled: false })).enabled) return true;
  if (lookup('other', { enabled: true }).enabled) return true;
  return false;
}
`);
  try {
    const program = ts.createProgram([file], { target: ts.ScriptTarget.ES2022, strict: true, skipLibCheck: true });
    const graph = extractFunctionFlowGraphs(program);
    const start = graph.nodes.find(n => n.labels.includes('FunctionStart'));
    assert.equal(start?.declaredReturnType, 'Promise<boolean>');
    const branches = graph.nodes.filter(n => n.labels.includes('Branch') && n.conditionRaw?.endsWith('.enabled'));
    assert.equal(branches.length, 2);
    for (const branch of branches) {
      const parts = JSON.parse(branch.renderPartsJson || '[]');
      const texts = parts.map((p: { text: string }) => p.text);
      assert.deepEqual(texts, ['enabled', 'set']);
      assert.ok(branch.labels.includes('Virtual') && branch.labels.includes('BooleanFlag'));
      const id = typeof branch.stableId === 'string' ? branch.stableId : branch.stableId.value;
      const evaluation = graph.edges.find(e => e.fromId === id && e.type === 'EVAL');
      assert.ok(evaluation);
      const opening = graph.nodes.find(n => n.stableId.value === evaluation.toId)!;
      assert.ok(!opening.labels.includes('Branch'));
      const openingTexts = JSON.parse(opening.renderPartsJson!).map((p: {text: string}) => p.text);
      assert.equal(openingTexts.at(-1), '(');
      if (branch.conditionRaw?.includes('await')) {
        assert.equal(openingTexts[0], 'await');
        assert.ok(openingTexts.includes('{ enabled: boolean }'));
      }
      assert.equal(graph.edges.filter(e => e.fromId === evaluation.toId && e.type === 'ARG').length, 2);
      const value = graph.edges.find(e => e.toId === id && e.type === 'ASSIGNS_VALUE');
      assert.ok(value);
      const closing = graph.nodes.find(n => n.stableId.value === value.fromId)!;
      const closingTexts = JSON.parse(closing.renderPartsJson!).map((p: {text: string}) => p.text);
      assert.deepEqual(closingTexts, [')', '.enabled'], JSON.stringify(graph.nodes.filter(n => n.callBoundaryRole || n.callMosaicRole).map(n => ({ id: n.stableId.value, role: n.callBoundaryRole, peer: n.callBoundaryPeerStableId, mosaic: n.callMosaicRole }))));
      assert.ok(value.sourceRenderPartStableId);
    }
  } finally { fs.rmSync(file, { force: true }); }
});

test('switch in a collection callback keeps contextualized edge endpoints', () => {
  const file = path.resolve('tmp/atomic-predicate-switch.fixture.ts');
  fs.writeFileSync(file, `export function subject(items: { kind: string }[]) {
    return items.map(item => { switch (item.kind) {
      case 'first': return 'a';
      case 'second': return 'b';
      default: return 'c';
    } });
  }`);
  try {
    const program = ts.createProgram([file], { target: ts.ScriptTarget.ES2022, strict: true, skipLibCheck: true });
    const graph = extractFunctionFlowGraphs(program);
    assert.ok(graph.nodes.some(n => n.kind === 'Switch' || n.labels.includes('Switch')));
  } finally { fs.rmSync(file, { force: true }); }
});
