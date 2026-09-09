import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { collectCanonicalReferenceGraph } from './functionFlowGraph.canonicalReferences.ts';

test('JSX props preserve ordered spreads and context provenance without inventing provider dispatch', () => {
  const fixture = path.resolve('tmp', 'jsx-context-provenance.fixture.tsx');
  fs.mkdirSync(path.dirname(fixture), { recursive: true });
  fs.writeFileSync(fixture, `
import { createContext, useContext as readContext } from 'react';
const Context = createContext<(value: number) => void>(() => {});
const Other = createContext<(value: number) => void>(() => {});
export function Child(props: { offset: number }) {
  const send = readContext(Context);
  send(props.offset);
  const selected = [1, 2][props.offset];
  const inside = props.offset < 5;
  return null;
}
function Owner() {
  const first = { offset: 1 };
  const last = { offset: 3 };
  const write = (value: number) => value;
  return <Context.Provider value={write}><Child {...first} offset={2} {...last} /></Context.Provider>;
}
function useContext(value: unknown) { return value; }
const fake = useContext(Other);
const single = <Child {...{ offset: 4 }} />;
const composed = { ...{ offset: 1 }, offset: 2 };
async function DynamicMount() {
  const [, { Child: DynamicChild }] = await Promise.all([
    Promise.resolve(1), import('./jsx-context-provenance.fixture.js')]);
  return <DynamicChild offset={1} />;
}
function renderValue(element: unknown) { return <section>{element}</section>; }
function RenderSite() { return renderValue(<Child offset={9} />); }
`, 'utf8');
  try {
    const graph = collectCanonicalReferenceGraph(ts.createProgram([fixture], {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, jsx: ts.JsxEmit.Preserve, skipLibCheck: true,
    }));
    const entity = (syntax: string, label?: string) => {
      const found = graph.entities.find(e => e.props.syntax === syntax && (!label || e.labels.includes(label)));
      assert.ok(found, `${label || ''}: ${syntax}`);
      return found;
    };
    const child = entity('<Child {...first} offset={2} {...last} />', 'ComponentConstruction');
    const argument = graph.relationships.find(r => r.fromId === child.stableId && r.type === 'HAS_ARGUMENT');
    assert.ok(argument);
    const binding = graph.relationships.find(r => r.fromId === argument.toId && r.type === 'BINDS_TO_PARAMETER');
    assert.ok(binding);
    const fields = graph.relationships.filter(r => r.fromId === argument.toId && ['HAS_PROPERTY', 'SPREADS_FROM'].includes(r.type));
    assert.deepEqual(fields.map(r => [r.type, r.props.index]).sort((a, b) => Number(a[1]) - Number(b[1])),
      [['SPREADS_FROM', 0], ['HAS_PROPERTY', 1], ['SPREADS_FROM', 2]]);
    const reads = graph.relationships.filter(r => r.type === 'READS_CONTEXT');
    const single = entity('<Child {...{ offset: 4 }} />', 'ComponentConstruction');
    const singleProps = graph.relationships.find(r => r.fromId === single.stableId && r.type === 'HAS_ARGUMENT');
    assert.ok(singleProps);
    const singleSpread = graph.relationships.find(r => r.fromId === singleProps.toId && r.type === 'SPREADS_FROM');
    assert.ok(singleSpread, 'a single spread must not collapse into its props container');
    assert.notEqual(singleSpread.fromId, singleSpread.toId);
    const composed = entity('{ ...{ offset: 1 }, offset: 2 }', 'ObjectConstruction');
    assert.deepEqual(graph.relationships.filter(r => r.fromId === composed.stableId
      && ['SPREADS_FROM', 'HAS_PROPERTY'].includes(r.type)).sort((a, b) => Number(a.props.index) - Number(b.props.index))
      .map(r => [r.type, r.props.index]),
    [['SPREADS_FROM', 0], ['HAS_PROPERTY', 1]]);
    assert.equal(reads.length, 1, 'a local same-name function is not a React context reader');
    assert.equal(reads[0].fromId, entity('readContext(Context)', 'Call').stableId);
    assert.equal(graph.relationships.filter(r => r.type === 'PROVIDES_CONTEXT').length, 1);
    const send = entity('send(props.offset)', 'Call');
    assert.ok(graph.relationships.some(r => r.fromId === send.stableId && r.type === 'ENCLOSED_BY'
      && graph.entities.some(e => e.stableId === r.toId && e.labels.includes('FunctionImplementation'))),
    'context-dependent calls retain their lexical function owner');
    assert.ok(graph.relationships.some(r => r.type === 'JSX_CHILD' && r.toId === child.stableId));
    assert.ok(graph.relationships.some(r => r.type === 'DECLARES_JSX'));
    for (const syntax of ['[1, 2][props.offset]', 'props.offset < 5']) {
      const use = entity(syntax, 'ValueConsumption');
      assert.ok(!use.labels.includes('LiteralValue'));
      assert.equal(graph.relationships.filter(r => r.fromId === use.stableId && r.type === 'CONSUMES_VALUE').length, 2);
      assert.ok(graph.relationships.some(r => r.fromId === use.stableId && r.type === 'ENCLOSED_BY'));
    }
    assert.ok(!send.labels.includes('ValueConsumption'), 'forwarding a value alone is not purpose evidence');
    const dynamic = entity('<DynamicChild offset={1} />', 'ComponentConstruction');
    const implementation = graph.entities.find(e => e.labels.includes('FunctionImplementation') && e.props.name === 'Child');
    assert.ok(implementation);
    assert.ok(graph.relationships.some(r => r.fromId === dynamic.stableId && r.type === 'CALLS'
      && r.toId === implementation.stableId), 'dynamic import destructuring retains the concrete JSX implementation');
    const suppliedJsx = entity('<Child offset={9} />', 'ComponentConstruction');
    assert.ok(!suppliedJsx.labels.includes('LiteralValue'), 'JSX arguments are element values, not literals');
    assert.ok(graph.relationships.some(r => r.fromId === suppliedJsx.stableId && r.type === 'BINDS_TO_PARAMETER'));
    assert.ok(graph.relationships.some(r => r.type === 'RENDERS_VALUE'
      && graph.entities.some(e => e.stableId === r.toId && e.props.name === 'element')));
    const write = entity('(value: number) => value');
    assert.ok(!graph.relationships.some(r => r.fromId === send.stableId && r.toId === write.stableId && r.type === 'CALLS'),
      'matching context types alone do not prove provider dispatch');
  } finally { fs.rmSync(fixture, { force: true }); }
});
