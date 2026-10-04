import assert from 'node:assert/strict';
import path from 'node:path';
import ts from 'typescript';
import {DuckDBInstance} from '@duckdb/node-api';
import {getExtendedStableId} from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';
import {findConditionalRuntimeCapture, resolveRuntimePresenceGuard} from '../graph/static-extract/ts/functionFlowGraph.runtimeIntrinsics.ts';

const [snapshot, baseline, sourceRoot] = process.argv.slice(2);
if (!snapshot || !baseline || !sourceRoot) throw new Error('Usage: <snapshot> <baseline> <source-root>');
const file = path.join(sourceRoot, 'tsconfig.json');
const config = ts.readConfigFile(file, ts.sys.readFile);
assert.ok(!config.error);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, sourceRoot, undefined, file);
const program = ts.createProgram(parsed.fileNames, parsed.options), checker = program.getTypeChecker();
const source = program.getSourceFile(path.join(sourceRoot, 'src/lib/fasttextweb/fasttext-wasm.js'))!;
const idFor = (node: ts.Node) => getExtendedStableId(source, node);
const ast = new Map<string, ts.Node>();
const visit = (node: ts.Node) => { ast.set(idFor(node), node); ts.forEachChild(node, visit); };
visit(source);
const instance = await DuckDBInstance.create(':memory:');
const db = await instance.connect();
const edgeKey = (from: string, kind: string, to: string) => JSON.stringify([from, kind, to]);
async function load(root: string) {
  const nodes = new Map((await db.runAndReadAll('SELECT stable_id,labels,props_json FROM read_parquet(?)',
    [path.join(root, 'parquet/nodes.parquet')])).getRowsJS().map(([id, labels, props]) =>
    [String(id), {labels: labels as string[], props: JSON.parse(String(props))}]));
  const edges = new Map((await db.runAndReadAll('SELECT from_id,rel_type,to_id,props_json FROM read_parquet(?)',
    [path.join(root, 'parquet/relationships.parquet')])).getRowsJS().map(([from, kind, to, props]) =>
    [edgeKey(String(from), String(kind), String(to)), JSON.parse(String(props))]));
  const plan = new Map((await db.runAndReadAll('SELECT stable_id,decision,context_targets,required_value_context FROM read_parquet(?)',
    [path.join(root, 'inventory/annotation-plan.parquet')])).getRowsJS().map(([id, decision, owners, values]) =>
    [String(id), {decision: String(decision), owners: owners as string[], values: values as string[]}]));
  return {nodes, edges, plan};
}
try {
  const current = await load(snapshot), old = await load(baseline);
  assert.equal(current.nodes.size, old.nodes.size);
  const confirmedStableIds = [...old.plan].filter(([id, plan]) => plan.decision === 'blocked-unresolved'
    && current.plan.get(id)?.decision === 'compose-in-owner').map(([id]) => id);
  assert.equal(confirmedStableIds.length, 2);
  const changed = new Set(confirmedStableIds), expectedEdges = new Set<string>();
  for (const id of confirmedStableIds) {
    const syntax = ast.get(id)!;
    assert.ok(ts.isIdentifier(syntax));
    assert.ok(!checker.getSymbolAtLocation(syntax)?.declarations?.length);
    assert.equal(resolveRuntimePresenceGuard(program, syntax), undefined, 'Must not claim a call-time presence guard');
    const capture = findConditionalRuntimeCapture(program, syntax)!;
    assert.ok(capture); assert.equal(capture.callbacks.length, 1); assert.equal(capture.aliases.length, 1);
    const callback = capture.callbacks[0], alias = capture.aliases[0], guard = capture.guard;
    assert.ok(ts.isArrowFunction(callback));
    assert.ok(ts.isIdentifier(alias.name) && alias.initializer);
    const aliasSymbol = checker.getSymbolAtLocation(alias.name)!;
    assert.deepEqual(aliasSymbol.declarations, [alias]);
    assert.ok(ts.isTypeOfExpression(guard.left) && ts.isIdentifier(guard.left.expression));
    assert.equal(guard.left.expression.text, syntax.text);
    assert.ok(ts.isStringLiteralLike(guard.right) && guard.right.text === 'object');
    assert.equal(guard.operatorToken.kind, ts.SyntaxKind.EqualsEqualsToken);
    let insideCallback = false, insideInitializer = false, creationBranch = false;
    for (let node: ts.Node | undefined = syntax; node; node = node.parent) if (node === callback) insideCallback = true;
    for (let node: ts.Node | undefined = guard; node; node = node.parent) if (node === alias.initializer) insideInitializer = true;
    for (let child: ts.Node = callback, parent = callback.parent; parent; child = parent, parent = parent.parent) {
      if (ts.isFunctionLike(parent)) break;
      if (ts.isIfStatement(parent) && child === parent.thenStatement && ts.isIdentifier(parent.expression)
        && checker.getSymbolAtLocation(parent.expression) === aliasSymbol) {
        assert.ok(alias.end < parent.expression.getStart()); creationBranch = true; break;
      }
    }
    assert.ok(insideCallback && insideInitializer && creationBranch);
    const node = current.nodes.get(id)!;
    assert.ok(node.labels.includes('ConditionalRuntimeCapture'));
    for (const label of ['System', 'ExternalBoundary', 'GuardedRuntimeAccess']) assert.ok(!node.labels.includes(label));
    assert.equal(node.props.declarationResolution, 'no-source-declaration');
    assert.equal(node.props.callTimePresence, 'not-proven');
    for (const [kind, target, resolution] of [
      ['CREATED_UNDER', idFor(guard), 'ast-callback-creation-guard'],
      ['CAPTURE_CONTEXT', idFor(callback), 'ast-inline-callback-context'],
      ['GUARD_VIA', idFor(alias), 'ast-unwritten-condition-binding']
    ]) {
      const key = edgeKey(id, kind, target); expectedEdges.add(key);
      assert.equal(current.edges.get(key)?.resolution, resolution);
    }
    const plan = current.plan.get(id)!;
    assert.deepEqual(plan.owners, [idFor(syntax.parent)]);
    assert.deepEqual(plan.values, [idFor(alias), idFor(callback), idFor(guard)].sort());
  }
  for (const [id, previous] of old.nodes) {
    const node = current.nodes.get(id)!;
    assert.equal(node.labels.length, new Set(node.labels).size);
    const normalize = (entry: typeof node) => ({labels: [...entry.labels].sort(),
      props: Object.fromEntries(Object.entries(entry.props).map(([key, value]) => [key,
        (key === 'roles' || key === 'roleNames') && Array.isArray(value) ? [...value].sort() : value]))});
    if (!changed.has(id)) assert.deepEqual(normalize(node), normalize(previous));
    else {
      assert.deepEqual(node.labels.filter(label => label !== 'ConditionalRuntimeCapture').sort(), [...previous.labels].sort());
      const normalized = normalize({...node, props: {...node.props,
        roles: node.props.roles.filter((role: string) => role !== 'ConditionalRuntimeCapture')}});
      for (const [name, value] of Object.entries(normalize(previous).props)) assert.deepEqual(normalized.props[name], value);
    }
  }
  for (const [key, props] of old.edges) assert.deepEqual(current.edges.get(key), props);
  assert.deepEqual(new Set([...current.edges.keys()].filter(key => !old.edges.has(key))), expectedEdges);
  for (const [id, plan] of old.plan) if (!changed.has(id)) assert.deepEqual(current.plan.get(id), plan);
  console.log(JSON.stringify({ok: true, confirmedStableIds, astVerified: true, oldGraphRetained: true,
    callTimePresenceNotClaimed: true, loaderDeclarationsStillUnresolved: true, writesNeo4j: false}));
} finally { db.closeSync(); instance.closeSync(); }
