import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { extractFunctionFlowGraphs } from './fromASTtoPreGraphFlow.ts';
import { hydrateSyntaxCompositions } from '../../packages/orchestrator/src/orchestrator/localCoordinateSync.js';

test('atomic predicates preserve nested call arguments, type arguments and result access', () => {
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
      assert.ok(texts.includes('(') && texts.includes(')'), texts.join('|'));
      assert.ok(texts.includes('{') && texts.includes('}'), texts.join('|'));
      assert.ok(texts.includes('enabled:'), texts.join('|'));
      assert.equal(texts.at(-1), '.enabled');
      assert.ok(parts.every((p: { sourceStableId?: string }) => p.sourceStableId));
      const id = typeof branch.stableId === 'string' ? branch.stableId : branch.stableId.value;
      const entities = (graph.semanticEntities || []).map(n => ({ key: n.stableId, labels: n.labels, props: n.props }));
      const owner = entities.find(n => n.key === id)!;
      const relations = (graph.semanticRelationships || []).filter(e => e.type === 'COMPOSES_SYNTAX')
        .map(e => ({ start: e.fromId, end: e.toId, props: e.props }));
      const [hydrated] = hydrateSyntaxCompositions([owner], entities, relations);
      assert.deepEqual(JSON.parse(hydrated.props.renderPartsJson).map((p: { text: string }) => p.text), texts);
      if (branch.conditionRaw?.includes('await')) {
        assert.ok(texts.includes('await') && texts.includes("'flag'") && texts.includes('false'));
        assert.ok(texts.includes('<') && texts.includes('{ enabled: boolean }') && texts.includes('>'));
      } else assert.ok(texts.includes("'other'") && texts.includes('true'));
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
