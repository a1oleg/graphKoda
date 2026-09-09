import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { collectCanonicalReferenceGraph } from './functionFlowGraph.canonicalReferences.ts';

test('an untyped gateway forwards a typed receiver to renamed callback members at each call site', () => {
  const directory = fs.mkdtempSync(path.resolve('tmp', 'callback-projection-'));
  const file = path.join(directory, 'fixture.ts');
  fs.writeFileSync(file, `
interface Store { alpha: string; beta: number; nested: { leaf: boolean } }
declare function snapshot(): Store;
function gateway(project) { const value = snapshot(); return project(value); }
const first = gateway(item => item.alpha);
const second = gateway(renamed => { return renamed.beta; });
const third = gateway(item => item.nested.leaf);
`);
  try {
    const program = ts.createProgram([file], { target: ts.ScriptTarget.ES2022, strict: true, skipLibCheck: true });
    const { entities, relationships } = collectCanonicalReferenceGraph(program);
    const byId = new Map(entities.map(e => [e.stableId, e]));
    for (const name of ['alpha', 'beta', 'leaf']) {
      const reference = entities.find(e => e.labels.includes('MemberReference') && e.props.name === name);
      assert.ok(reference);
      const resolves = relationships.find(r => r.fromId === reference.stableId && r.type === 'RESOLVES_TO');
      assert.ok(resolves, `missing receiver specialization for ${name}`);
      assert.equal(byId.get(resolves.toId)?.props.name, name);
      assert.ok(relationships.some(r => r.type === 'RETURNS_VALUE' && r.toId === reference.stableId));
    }
    const bindings = relationships.filter(r => r.props.resolution === 'typescript-checker-callback-forwarding');
    assert.equal(bindings.length, 3);
    assert.equal(new Set(bindings.map(r => r.props.outerCallSiteStableId)).size, 3);
    assert.equal(new Set(bindings.map(r => r.toId)).size, 3);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('recovers explicit intersection members through generic return types without guessing an unknown transform', () => {
  const directory = fs.mkdtempSync(path.resolve('tmp', 'callback-declared-'));
  const file = path.join(directory, 'fixture.ts');
  fs.writeFileSync(file, `
import type { Missing } from './absent.js';
type State = Missing<{ hidden: string }> & { chosen: number };
type Box<T> = { getState: () => T };
declare function source(): Box<State>;
function route(select) { const state = source().getState(); return select(state); }
const one = route(s => s.chosen);
const two = route(s => s.hidden);
function update(set: (f: (previous: State) => State) => void) {
  set(previous => ({ ...previous, chosen: 42 }));
}
`);
  try {
    const program = ts.createProgram([file], { target: ts.ScriptTarget.ES2022, strict: true, skipLibCheck: true });
    const { entities, relationships } = collectCanonicalReferenceGraph(program);
    const selected = entities.find(e => e.labels.includes('MemberReference') && e.props.name === 'chosen');
    const hidden = entities.find(e => e.labels.includes('MemberReference') && e.props.name === 'hidden');
    assert.ok(selected && hidden);
    const resolution = relationships.find(r => r.type === 'RESOLVES_TO' && r.fromId === selected.stableId);
    assert.ok(resolution);
    assert.equal((resolution.props.contextCallSiteStableIds as string[]).length, 1);
    assert.equal(relationships.some(r => r.type === 'RESOLVES_TO' && r.fromId === hidden.stableId), false);
    assert.ok(relationships.some(r => r.type === 'SATISFIES_MEMBER' && r.toId === resolution.toId));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('shared selectors retain call-site member identities and observers do not become result projections', () => {
  const directory = fs.mkdtempSync(path.resolve('tmp', 'callback-contexts-'));
  const file = path.join(directory, 'fixture.ts');
  fs.writeFileSync(file, `
interface First { same: number }
interface Second { same: string }
declare function firstState(): First;
declare function secondState(): Second;
function firstGateway(p) { return p(firstState()); }
function secondGateway(p) { return p(secondState()); }
function observer(p) { p(firstState()); return 7; }
const shared = value => value.same;
const a = firstGateway(shared);
const b = secondGateway(shared);
const ignored = observer(shared);
`);
  try {
    const program = ts.createProgram([file], { target: ts.ScriptTarget.ES2022, strict: true, skipLibCheck: true });
    const { entities, relationships } = collectCanonicalReferenceGraph(program);
    const calls = Object.fromEntries(entities.filter(e => e.labels.includes('Call')).map(e => [e.props.name, e]));
    assert.deepEqual(calls.firstGateway.props.valueProjectionCallbackIndexes, [0]);
    assert.deepEqual(calls.secondGateway.props.valueProjectionCallbackIndexes, [0]);
    assert.equal(calls.observer.props.valueProjectionCallbackIndexes, undefined);
    const reference = entities.find(e => e.labels.includes('MemberReference') && e.props.name === 'same')!;
    const edges = relationships.filter(r => r.fromId === reference.stableId && r.type === 'RESOLVES_TO');
    assert.equal(edges.length, 2);
    const first = edges.find(r => (r.props.contextCallSiteStableIds as string[]).includes(calls.firstGateway.stableId))!;
    const second = edges.find(r => (r.props.contextCallSiteStableIds as string[]).includes(calls.secondGateway.stableId))!;
    assert.notEqual(first.toId, second.toId);
    assert.equal((first.props.contextCallSiteStableIds as string[]).includes(calls.secondGateway.stableId), false);
    assert.equal((second.props.contextCallSiteStableIds as string[]).includes(calls.firstGateway.stableId), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
