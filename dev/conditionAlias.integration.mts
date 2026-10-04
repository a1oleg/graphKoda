import assert from 'node:assert/strict';
import path from 'node:path';
import ts from 'typescript';
import {DuckDBInstance} from '@duckdb/node-api';
import {getExtendedStableId} from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';
import {resolveRuntimePresenceGuard} from '../graph/static-extract/ts/functionFlowGraph.runtimeIntrinsics.ts';

const [snapshot, baseline, sourceRoot] = process.argv.slice(2);
if (!snapshot || !baseline || !sourceRoot) throw new Error('Usage: <snapshot> <baseline> <source-root>');
const file = path.join(sourceRoot, 'tsconfig.json');
const config = ts.readConfigFile(file, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, sourceRoot, undefined, file);
const program = ts.createProgram(parsed.fileNames, parsed.options), checker = program.getTypeChecker();
const source = program.getSourceFile(path.join(sourceRoot, 'src/lib/fasttextweb/fasttext-wasm.js'))!;
const ast = new Map<string, ts.Node>();
const visit = (node: ts.Node) => { ast.set(getExtendedStableId(source, node), node); ts.forEachChild(node, visit); };
visit(source);
const idFor = (node: ts.Node) => getExtendedStableId(source, node);
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
    && current.plan.get(id)!.decision === 'compose-in-owner').map(([id]) => id);
  assert.equal(confirmedStableIds.length, 7);
  const changed = new Set(confirmedStableIds);
  const aliases = new Set<ts.VariableDeclaration>();
  for (const id of confirmedStableIds) {
    const syntax = ast.get(id)!;
    assert.ok(ts.isIdentifier(syntax));
    const result = resolveRuntimePresenceGuard(program, syntax)!;
    assert.ok(result); assert.equal(result.aliases.length, 1);
    const alias = result.aliases[0]; aliases.add(alias);
    assert.ok(ts.isIdentifier(alias.name) && alias.initializer);
    const guard = result.guard;
    assert.ok(ts.isTypeOfExpression(guard.left) && ts.isIdentifier(guard.left.expression));
    assert.equal(guard.left.expression.text, syntax.text);
    assert.ok(ts.isStringLiteralLike(guard.right) && guard.right.text !== 'undefined');
    assert.ok(guard.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken
      || guard.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken);
    let reachedInitializer = false;
    for (let node: ts.Node | undefined = guard; node; node = node.parent) if (node === alias.initializer) reachedInitializer = true;
    assert.ok(reachedInitializer);
    const aliasSymbol = checker.getSymbolAtLocation(alias.name)!;
    assert.deepEqual(aliasSymbol.declarations, [alias]);
    let branchVerified = false;
    for (let child: ts.Node = syntax, parent = syntax.parent; parent; child = parent, parent = parent.parent) {
      assert.ok(!ts.isFunctionLike(parent), 'Guard crossed a callback');
      if (!ts.isIfStatement(parent) || child !== parent.thenStatement
        || !ts.isIdentifier(parent.expression) || checker.getSymbolAtLocation(parent.expression) !== aliasSymbol) continue;
      assert.ok(alias.end < parent.expression.getStart());
      branchVerified = true; break;
    }
    assert.ok(branchVerified);
    const node = current.nodes.get(id)!;
    assert.ok(node.labels.includes('GuardedRuntimeAccess') && !node.labels.includes('System'));
    assert.equal(node.props.declarationResolution, 'no-source-declaration');
    assert.equal(current.edges.get(edgeKey(id, 'GUARDED_BY', idFor(guard)))?.resolution, 'ast-positive-typeof-guard');
    assert.equal(current.edges.get(edgeKey(id, 'GUARD_VIA', idFor(alias)))?.resolution, 'ast-unwritten-condition-binding');
    const plan = current.plan.get(id)!;
    assert.deepEqual(plan.owners, [idFor(syntax.parent)]);
    assert.deepEqual(plan.values, [idFor(alias), idFor(guard)].sort());
  }
  assert.equal(aliases.size, 1);
  for (const alias of aliases) {
    const symbol = checker.getSymbolAtLocation(alias.name);
    for (const syntax of ast.values()) {
      assert.ok(!ts.isWithStatement(syntax));
      assert.ok(!(ts.isCallExpression(syntax) && ts.isIdentifier(syntax.expression) && syntax.expression.text === 'eval'));
      if (!ts.isIdentifier(syntax) || checker.getSymbolAtLocation(syntax) !== symbol || syntax === alias.name) continue;
      for (let child: ts.Node = syntax, parent = syntax.parent; parent && !ts.isStatement(parent);
        child = parent, parent = parent.parent) {
        assert.ok(!(ts.isBinaryExpression(parent) && parent.left === child
          && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment));
        assert.ok(!((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
          && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)));
      }
    }
  }
  for (const [id, previous] of old.nodes) {
    const node = current.nodes.get(id)!;
    if (!changed.has(id)) assert.deepEqual(node, previous);
    else {
      assert.deepEqual(node.labels.filter(label => label !== 'GuardedRuntimeAccess'), previous.labels);
      for (const [name, value] of Object.entries(previous.props)) assert.deepEqual(name === 'roles'
        ? node.props[name].filter((role: string) => role !== 'GuardedRuntimeAccess') : node.props[name], value);
    }
  }
  for (const [key, props] of old.edges) assert.deepEqual(current.edges.get(key), props);
  const added = [...current.edges.keys()].filter(key => !old.edges.has(key));
  assert.equal(added.length, 14);
  for (const key of added) {
    const [from, kind] = JSON.parse(key);
    assert.ok(changed.has(from)); assert.ok(kind === 'GUARDED_BY' || kind === 'GUARD_VIA');
  }
  for (const [id, plan] of old.plan) if (!changed.has(id)) assert.deepEqual(current.plan.get(id), plan);
  console.log(JSON.stringify({ok: true, confirmedStableIds, astVerified: true,
    unwrittenBindingVerified: true, aliasPreservedInGraph: true, oldGraphRetained: true, writesNeo4j: false}));
} finally { db.closeSync(); instance.closeSync(); }
