import assert from 'node:assert/strict';
import path from 'node:path';
import ts from 'typescript';
import {DuckDBInstance} from '@duckdb/node-api';
import {getExtendedStableId} from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';
import {findNodeRuntimeGuard} from '../graph/static-extract/ts/functionFlowGraph.runtimeIntrinsics.ts';

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
    && current.plan.get(id)?.decision === 'external-boundary').map(([id]) => id);
  assert.equal(confirmedStableIds.length, 2);
  const changed = new Set(confirmedStableIds), expectedEdges = new Set<string>(), methods: string[] = [];
  for (const id of confirmedStableIds) {
    const syntax = ast.get(id)!;
    assert.ok(ts.isIdentifier(syntax) && syntax.text === 'Buffer');
    assert.ok(ts.isPropertyAccessExpression(syntax.parent)); methods.push(syntax.parent.name.text);
    assert.ok(!checker.getSymbolAtLocation(syntax)?.declarations?.length);
    const result = findNodeRuntimeGuard(program, syntax)!;
    assert.ok(result); assert.equal(result.callbacks.length, 0); assert.equal(result.aliases.length, 1);
    const alias = result.aliases[0];
    assert.equal(alias.initializer, result.guard);
    assert.ok(ts.isIdentifier(alias.name));
    const symbol = checker.getSymbolAtLocation(alias.name)!;
    assert.deepEqual(symbol.declarations, [alias]);
    const checks: string[] = [];
    const check = (node: ts.Expression) => {
      assert.ok(ts.isBinaryExpression(node));
      if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) { check(node.left); check(node.right); return; }
      assert.equal(node.operatorToken.kind, ts.SyntaxKind.EqualsEqualsToken);
      assert.ok(ts.isTypeOfExpression(node.left) && ts.isStringLiteralLike(node.right));
      checks.push(node.left.expression.getText() + ':' + node.right.text);
    };
    check(result.guard);
    assert.deepEqual(checks, ['process:object', 'process.versions:object', 'process.versions.node:string']);
    let insideBranch = false;
    for (let child: ts.Node = syntax, parent = syntax.parent; parent; child = parent, parent = parent.parent) {
      assert.ok(!ts.isFunctionLike(parent), 'Host guard crossed a callable');
      if (!ts.isIfStatement(parent) || child !== parent.thenStatement) continue;
      const mentionsAlias = (node: ts.Node): boolean => ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol
        || Boolean(ts.forEachChild(node, mentionsAlias));
      if (mentionsAlias(parent.expression)) { insideBranch = true; break; }
    }
    assert.ok(insideBranch);
    const node = current.nodes.get(id)!;
    for (const label of ['NodeRuntimeAccess', 'ExternalBoundary', 'System']) assert.ok(node.labels.includes(label));
    assert.equal(node.props.declarationResolution, 'no-source-declaration');
    assert.equal(node.props.runtimeExecution, 'not-observed');
    assert.equal(node.props.runtimeScope, 'Node.js');
    assert.equal(node.props.runtimeContractUrl, 'https://nodejs.org/api/globals.html#class-buffer');
    for (const [kind, target, resolution] of [
      ['RUNTIME_GUARDED_BY', idFor(result.guard), 'ast-positive-node-version-guard'],
      ['GUARD_VIA', idFor(alias), 'ast-unwritten-condition-binding']
    ]) {
      const key = edgeKey(id, kind, target); expectedEdges.add(key);
      assert.equal(current.edges.get(key)?.resolution, resolution);
    }
    assert.deepEqual(current.plan.get(id)!.values, [idFor(alias), idFor(result.guard)].sort());
  }
  assert.deepEqual(methods.sort(), ['alloc', 'from']);
  const addedLabels = ['NodeRuntimeAccess', 'ExternalBoundary', 'System'];
  const normalize = (entry: {labels: string[]; props: Record<string, any>}) => ({labels: [...entry.labels].sort(),
    props: Object.fromEntries(Object.entries(entry.props).map(([key, value]) => [key,
      (key === 'roles' || key === 'roleNames') && Array.isArray(value) ? [...value].sort() : value]))});
  for (const [id, previous] of old.nodes) {
    const node = current.nodes.get(id)!;
    assert.equal(node.labels.length, new Set(node.labels).size);
    if (!changed.has(id)) assert.deepEqual(normalize(node), normalize(previous));
    else {
      assert.deepEqual(node.labels.filter(label => !addedLabels.includes(label)).sort(), [...previous.labels].sort());
      const normalized = normalize({...node, props: {...node.props,
        roles: node.props.roles.filter((role: string) => !addedLabels.includes(role))}});
      for (const [name, value] of Object.entries(normalize(previous).props)) assert.deepEqual(normalized.props[name], value);
    }
  }
  for (const [key, props] of old.edges) assert.deepEqual(current.edges.get(key), props);
  assert.deepEqual(new Set([...current.edges.keys()].filter(key => !old.edges.has(key))), expectedEdges);
  for (const [id, plan] of old.plan) if (!changed.has(id)) assert.deepEqual(current.plan.get(id), plan);
  const unresolved = [...current.plan].filter(([, plan]) => plan.decision === 'blocked-unresolved').map(([id]) => id);
  assert.deepEqual(unresolved.map(id => ast.get(id)!.getText()).sort(), ['Browser', 'NODEFS', '__dirname']);
  console.log(JSON.stringify({ok: true, confirmedStableIds, astVerified: true, oldGraphRetained: true,
    unresolvedEnvironmentReferencesRetained: unresolved, runtimeExecutionNotClaimed: true, writesNeo4j: false}));
} finally { db.closeSync(); instance.closeSync(); }
