import assert from 'node:assert/strict';
import path from 'node:path';
import ts from 'typescript';
import {DuckDBInstance} from '@duckdb/node-api';
import {getExtendedStableId} from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';
import {findGuardedBrowserGlobal} from '../graph/static-extract/ts/functionFlowGraph.runtimeIntrinsics.ts';

const [snapshot, baseline, sourceRoot] = process.argv.slice(2);
if (!snapshot || !baseline || !sourceRoot) throw new Error('Usage: <snapshot> <baseline> <source-root>');
const configFile = path.join(sourceRoot, 'tsconfig.json');
const config = ts.readConfigFile(configFile, ts.sys.readFile);
assert.ok(!config.error);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, sourceRoot, undefined, configFile);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const source = program.getSourceFile(path.join(sourceRoot, 'src/hooks/useStreaming.ts'))!;
const ast = new Map<string, ts.Node>();
const accepted: string[] = [];
const visit = (node: ts.Node) => {
  const id = getExtendedStableId(source, node);
  ast.set(id, node);
  if (ts.isIdentifier(node) && findGuardedBrowserGlobal(program, node)) accepted.push(id);
  ts.forEachChild(node, visit);
};
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
  assert.equal(accepted.length, 1);
  const id = accepted[0], syntax = ast.get(id)!;
  assert.ok(ts.isIdentifier(syntax));
  const found = findGuardedBrowserGlobal(program, syntax)!;
  assert.ok(ts.isStringLiteral(found.guard.left));
  assert.equal(found.guard.left.text, syntax.text);
  assert.equal(found.guard.operatorToken.kind, ts.SyntaxKind.InKeyword);
  assert.equal(found.guard.right, found.receiver);
  assert.ok(program.getTypeChecker().getSymbolAtLocation(found.receiver)!.declarations!.every(declaration =>
    program.isSourceFileDefaultLibrary(declaration.getSourceFile())));
  const target = current.nodes.get(id)!;
  assert.ok(target.labels.includes('GuardedGlobalAccess'));
  assert.ok(!target.labels.includes('System') && !target.labels.includes('ExternalBoundary'));
  assert.equal(target.props.declarationResolution, 'no-source-declaration');
  for (const [nodeId, previous] of old.nodes) {
    if (nodeId !== id) assert.deepEqual(current.nodes.get(nodeId), previous);
    else {
      for (const label of previous.labels) assert.ok(target.labels.includes(label));
      for (const [name, value] of Object.entries(previous.props)) {
        assert.deepEqual(name === 'roles' ? target.props[name].filter((role: string) => role !== 'GuardedGlobalAccess')
          : target.props[name], value);
      }
    }
  }
  for (const [key, props] of old.edges) assert.deepEqual(current.edges.get(key), props, `Existing edge changed: ${key}`);
  const added = [...current.edges].filter(([key]) => !old.edges.has(key));
  assert.equal(added.length, 2);
  const receiverId = getExtendedStableId(source, found.receiver), guardId = getExtendedStableId(source, found.guard);
  assert.equal(current.edges.get(edgeKey(id, 'READS_FROM', receiverId))?.resolution, 'ast-guarded-global-receiver');
  assert.equal(current.edges.get(edgeKey(id, 'GUARDED_BY', guardId))?.resolution, 'ast-positive-in-guard');
  assert.equal(current.edges.get(edgeKey(id, 'GUARDED_BY', guardId))?.branch, 'true');
  assert.ok(![...current.edges.keys()].some(key => {
    const [from, kind] = JSON.parse(key);
    return from === id && kind === 'RESOLVES_TO';
  }));
  for (const [nodeId, previous] of old.plan) {
    const plan = current.plan.get(nodeId)!;
    if (nodeId !== id) assert.deepEqual(plan, previous);
    else {
      assert.equal(previous.decision, 'blocked-unresolved');
      assert.equal(plan.decision, 'compose-in-owner');
      assert.deepEqual(plan.owners, [getExtendedStableId(source, syntax.parent)]);
      if (previous.owners.length) assert.deepEqual(plan.owners, previous.owners);
      assert.deepEqual(plan.values, [guardId, receiverId].sort());
    }
  }
  console.log(JSON.stringify({ok: true, confirmedStableIds: [id], astVerified: true,
    oldGraphRetained: true, unresolvedDeclarationRetained: true, guardAndReceiverInPlan: true, writesNeo4j: false}));
} finally { db.closeSync(); instance.closeSync(); }
