import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {DuckDBInstance} from '@duckdb/node-api';
import {getExtendedStableId} from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';

const [snapshot, baseline, sourceRoot] = process.argv.slice(2);
if (!snapshot || !baseline || !sourceRoot) throw new Error('Usage: <snapshot> <baseline> <source-root>');
const instance = await DuckDBInstance.create(':memory:');
const db = await instance.connect();
const key = (from: string, kind: string, to: string) => JSON.stringify([from, kind, to]);
async function load(root: string) {
  const nodes = new Map((await db.runAndReadAll('SELECT stable_id,labels,props_json FROM read_parquet(?)',
    [path.join(root, 'parquet/nodes.parquet')])).getRowsJS().map(([id, labels, props]) =>
    [String(id), {labels: labels as string[], props: JSON.parse(String(props))}]));
  const edges = new Map((await db.runAndReadAll('SELECT from_id,rel_type,to_id,props_json FROM read_parquet(?)',
    [path.join(root, 'parquet/relationships.parquet')])).getRowsJS().map(([from, kind, to, props]) =>
    [key(String(from), String(kind), String(to)), JSON.parse(String(props))]));
  const plan = new Map((await db.runAndReadAll('SELECT stable_id,decision,context_targets,required_value_context FROM read_parquet(?)',
    [path.join(root, 'inventory/annotation-plan.parquet')])).getRowsJS().map(([id, decision, owners, values]) =>
    [String(id), {decision: String(decision), owners: owners as string[], values: values as string[]}]));
  return {nodes, edges, plan};
}
try {
  const current = await load(snapshot), old = await load(baseline);
  for (const [id, node] of old.nodes) assert.deepEqual(current.nodes.get(id), node, `Existing node changed: ${id}`);
  for (const [edge, props] of old.edges) assert.deepEqual(current.edges.get(edge), props, `Existing edge changed: ${edge}`);
  const addedNodes = [...current.nodes].filter(([id]) => !old.nodes.has(id));
  assert.equal(addedNodes.length, 3);
  const ast = new Map<string, ts.Node>();
  const sourceIds = new Map<ts.SourceFile, string>();
  for (const relative of new Set(addedNodes.map(([, node]) => node.props.repoRelativePath))) {
    const source = ts.createSourceFile(path.resolve(sourceRoot, relative), fs.readFileSync(path.join(sourceRoot, relative), 'utf8'),
      ts.ScriptTarget.Latest, true);
    ast.set(`source-file:${relative}`, source);
    sourceIds.set(source, `source-file:${relative}`);
    const visit = (node: ts.Node) => { ast.set(getExtendedStableId(source, node), node); ts.forEachChild(node, visit); };
    visit(source);
  }
  const idFor = (node: ts.Node) => ts.isSourceFile(node)
    ? sourceIds.get(node)!
    : getExtendedStableId(node.getSourceFile(), node);
  for (const [id, node] of addedNodes) {
    const syntax = ast.get(id);
    assert.ok(syntax, `New node absent from AST: ${id}`);
    const plan = current.plan.get(id)!;
    if (ts.isSourceFile(syntax)) {
      assert.deepEqual(node.labels, ['CodeEntity', 'SourceFile']);
      assert.equal(plan.decision, 'syntax-summary');
      continue;
    }
    assert.ok(ts.isVoidExpression(syntax));
    assert.equal(node.props.syntaxKind, 'VoidExpression');
    assert.ok(node.labels.includes('SyntaxContainer') && node.labels.includes('System'));
    const childId = getExtendedStableId(syntax.getSourceFile(), syntax.expression);
    const parentId = getExtendedStableId(syntax.getSourceFile(), syntax.parent);
    assert.equal(plan.decision, 'compose-in-owner');
    assert.deepEqual(plan.owners, [parentId]);
    assert.deepEqual(plan.values, [childId]);
  }
  const addedEdges = [...current.edges].filter(([edge]) => !old.edges.has(edge));
  assert.equal(addedEdges.length, 9);
  for (const [edge, props] of addedEdges) {
    const [from, kind, to] = JSON.parse(edge), parent = ast.get(from), child = ast.get(to);
    assert.ok(parent && child, `Edge endpoints absent from AST: ${edge}`);
    if (kind === 'AST_CHILD') {
      const children: ts.Node[] = [];
      ts.forEachChild(parent, node => { children.push(node); });
      assert.ok(children.includes(child), `Not an immediate AST child: ${edge}`);
      assert.equal(props.field, ts.isSourceFile(parent) ? 'statements' : 'expression');
    } else if (kind === 'CONSUMES_VALUE') {
      assert.ok(ts.isVoidExpression(parent) && parent.expression === child);
      assert.equal(props.role, 'discarded');
      assert.equal(props.resolution, 'ast-operand');
    } else {
      assert.equal(kind, 'ENCLOSED_BY');
      assert.equal(parent.parent, child);
      assert.equal(props.resolution, 'nearest-materialized-ast-owner');
    }
  }
  const confirmedStableIds: string[] = [];
  let refinedOwners = 0;
  for (const [id, previous] of old.plan) {
    const plan = current.plan.get(id)!;
    if (JSON.stringify(plan) === JSON.stringify(previous)) continue;
    const syntax = ast.get(id)!;
    if (previous.decision === 'blocked-unresolved') {
      assert.ok(ts.isClassDeclaration(syntax) || ts.isCallExpression(syntax));
      assert.equal(plan.decision, 'compose-in-owner');
      assert.deepEqual(plan.owners, [idFor(syntax.parent)]);
      assert.ok(current.edges.has(key(plan.owners[0], 'AST_CHILD', id)));
      confirmedStableIds.push(id);
    } else {
      assert.equal(previous.decision, 'compose-in-owner');
      assert.equal(plan.decision, previous.decision);
      assert.deepEqual(plan.values, previous.values);
      assert.ok(ts.isCallExpression(syntax) && ts.isVoidExpression(syntax.parent));
      assert.deepEqual(plan.owners, [idFor(syntax.parent)]);
      assert.ok(current.nodes.get(previous.owners[0])?.labels.includes('Step'));
      refinedOwners++;
    }
  }
  assert.equal(confirmedStableIds.length, 2);
  assert.equal(refinedOwners, 1);
  console.log(JSON.stringify({ok: true, confirmedStableIds, astVerified: true,
    oldNodesAndEdgesRetained: true, discardedCallDependenciesRetained: true,
    refinedImmediateOwners: refinedOwners, writesNeo4j: false}));
} finally { db.closeSync(); instance.closeSync(); }
