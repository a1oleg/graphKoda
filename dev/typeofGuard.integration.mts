import assert from 'node:assert/strict';
import path from 'node:path';
import ts from 'typescript';
import {DuckDBInstance} from '@duckdb/node-api';
import {getExtendedStableId} from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';
import {findRuntimePresenceGuard} from '../graph/static-extract/ts/functionFlowGraph.runtimeIntrinsics.ts';

const [snapshot, baseline, sourceRoot] = process.argv.slice(2);
if (!snapshot || !baseline || !sourceRoot) throw new Error('Usage: <snapshot> <baseline> <source-root>');
const configFile = path.join(sourceRoot, 'tsconfig.json');
const config = ts.readConfigFile(configFile, ts.sys.readFile);
assert.ok(!config.error);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, sourceRoot, undefined, configFile);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const source = program.getSourceFile(path.join(sourceRoot, 'src/lib/fasttextweb/fasttext-wasm.js'))!;
const ast = new Map<string, ts.Node>();
const visit = (node: ts.Node) => { ast.set(getExtendedStableId(source, node), node); ts.forEachChild(node, visit); };
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
  const changed = [...current.nodes].filter(([, node]) => node.labels.includes('GuardedRuntimeAccess'));
  assert.equal(changed.length, 4);
  const ids = new Set(changed.map(([id]) => id));
  let branchGuards = 0, shortCircuitGuards = 0;
  for (const [id, node] of changed) {
    const syntax = ast.get(id)!;
    assert.ok(syntax && ts.isIdentifier(syntax));
    const guard = findRuntimePresenceGuard(program, syntax)!;
    assert.ok(guard);
    const operand = ts.isTypeOfExpression(guard.left) ? guard.left : guard.right;
    const literal = operand === guard.left ? guard.right : guard.left;
    assert.ok(ts.isTypeOfExpression(operand) && ts.isIdentifier(operand.expression));
    assert.equal(operand.expression.text, syntax.text);
    assert.ok(ts.isStringLiteralLike(literal));
    const operator = guard.operatorToken.kind;
    if (literal.text === 'undefined') {
      assert.ok(operator === ts.SyntaxKind.ExclamationEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken);
    } else {
      assert.ok(['function','object','string','number','boolean','symbol','bigint'].includes(literal.text));
      assert.ok(operator === ts.SyntaxKind.EqualsEqualsToken || operator === ts.SyntaxKind.EqualsEqualsEqualsToken);
    }
    assert.ok(!program.getTypeChecker().getSymbolAtLocation(syntax)?.declarations?.length);
    const isDescendant = (ancestor: ts.Node, child: ts.Node) => {
      for (let node: ts.Node | undefined = child; node; node = node.parent) if (node === ancestor) return true;
      return false;
    };
    let placementVerified = false;
    for (let child: ts.Node = syntax, parent = syntax.parent; parent; child = parent, parent = parent.parent) {
      assert.ok(!ts.isFunctionLike(parent), 'Guard crossed a callable boundary');
      if (ts.isIfStatement(parent) && child === parent.thenStatement && isDescendant(parent.expression, guard)) {
        branchGuards++; placementVerified = true; break;
      }
      if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        && child === parent.right && isDescendant(parent.left, guard)) {
        shortCircuitGuards++; placementVerified = true; break;
      }
    }
    assert.ok(placementVerified);
    assert.ok(!node.labels.includes('System') && !node.labels.includes('ExternalBoundary'));
    assert.equal(node.props.declarationResolution, 'no-source-declaration');
    const guardId = getExtendedStableId(source, guard);
    assert.equal(current.edges.get(edgeKey(id, 'GUARDED_BY', guardId))?.resolution, 'ast-positive-typeof-guard');
    assert.equal(current.edges.get(edgeKey(id, 'GUARDED_BY', guardId))?.branch, 'true');
    assert.equal(old.plan.get(id)!.decision, 'blocked-unresolved');
    assert.equal(current.plan.get(id)!.decision, 'compose-in-owner');
    assert.deepEqual(current.plan.get(id)!.owners, [getExtendedStableId(source, syntax.parent)]);
    assert.deepEqual(current.plan.get(id)!.values, [guardId]);
  }
  assert.equal(branchGuards, 2);
  assert.equal(shortCircuitGuards, 2);
  for (const [id, previous] of old.nodes) {
    const node = current.nodes.get(id)!;
    assert.equal(node.labels.length, new Set(node.labels).size);
    if (!ids.has(id)) assert.deepEqual(node, previous);
    else {
      assert.deepEqual(node.labels.filter(label => label !== 'GuardedRuntimeAccess'), previous.labels);
      for (const [name, value] of Object.entries(previous.props)) {
        assert.deepEqual(name === 'roles' ? node.props[name].filter((role: string) => role !== 'GuardedRuntimeAccess')
          : node.props[name], value);
      }
    }
  }
  for (const [key, props] of old.edges) assert.deepEqual(current.edges.get(key), props, `Existing edge changed: ${key}`);
  const added = [...current.edges.keys()].filter(key => !old.edges.has(key));
  assert.equal(added.length, 4);
  for (const key of added) {
    const [from, kind] = JSON.parse(key);
    assert.ok(ids.has(from)); assert.equal(kind, 'GUARDED_BY');
  }
  for (const [id, previous] of old.plan) {
    if (!ids.has(id)) assert.deepEqual(current.plan.get(id), previous);
  }
  assert.equal([...current.plan.values()].filter(plan => plan.decision === 'blocked-unresolved').length, 17);
  console.log(JSON.stringify({ok: true, confirmedStableIds: [...ids], astVerified: true,
    branchGuards, shortCircuitGuards, oldGraphRetained: true, unresolvedDeclarationsRetained: true, writesNeo4j: false}));
} finally { db.closeSync(); instance.closeSync(); }
