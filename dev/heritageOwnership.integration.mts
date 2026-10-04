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
  const plan = new Map((await db.runAndReadAll('SELECT stable_id,decision,context_targets,required_type_context,required_value_context FROM read_parquet(?)',
    [path.join(root, 'inventory/annotation-plan.parquet')])).getRowsJS().map(([id, decision, owners, types, values]) =>
    [String(id), {decision: String(decision), owners: owners as string[], types: types as string[], values: values as string[]}]));
  return {nodes, edges, plan};
}
try {
  const current = await load(snapshot), old = await load(baseline);
  for (const [id, node] of old.nodes) assert.deepEqual(current.nodes.get(id), node, `Existing node changed: ${id}`);
  for (const [edge, props] of old.edges) assert.deepEqual(current.edges.get(edge), props, `Existing edge changed: ${edge}`);
  const added = [...current.nodes].filter(([id]) => !old.nodes.has(id));
  assert.equal(added.length, 2);
  const ast = new Map<string, ts.Node>();
  for (const relative of new Set(added.map(([, node]) => node.props.repoRelativePath))) {
    const source = ts.createSourceFile(path.join(sourceRoot, relative), fs.readFileSync(path.join(sourceRoot, relative), 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => { ast.set(getExtendedStableId(source, node), node); ts.forEachChild(node, visit); };
    visit(source);
  }
  const idFor = (node: ts.Node) => getExtendedStableId(node.getSourceFile(), node);
  for (const [id, node] of added) {
    const syntax = ast.get(id)!;
    assert.ok(syntax && ts.isHeritageClause(syntax));
    assert.equal(node.props.syntaxKind, 'HeritageClause');
    assert.ok(node.labels.includes('SyntaxContainer') && node.labels.includes('System'));
    assert.ok(ts.isClassDeclaration(syntax.parent) || ts.isInterfaceDeclaration(syntax.parent));
    assert.deepEqual(current.plan.get(id)!.owners, [idFor(syntax.parent)]);
    for (const type of syntax.types) assert.ok(current.edges.has(key(id, 'AST_CHILD', idFor(type))));
  }
  const newEdges = [...current.edges].filter(([edge]) => !old.edges.has(edge));
  assert.equal(newEdges.length, 6);
  for (const [edge, props] of newEdges) {
    const [from, kind, to] = JSON.parse(edge), parent = ast.get(from)!, child = ast.get(to)!;
    assert.ok(parent && child);
    if (kind === 'AST_CHILD') {
      const children: ts.Node[] = [];
      ts.forEachChild(parent, node => { children.push(node); });
      assert.ok(children.includes(child));
    } else {
      assert.equal(kind, 'ENCLOSED_BY');
      assert.equal(parent.parent, child);
      assert.equal(props.resolution, 'nearest-materialized-ast-owner');
    }
  }
  const confirmedStableIds: string[] = [];
  for (const [id, previous] of old.plan) {
    const plan = current.plan.get(id)!;
    assert.deepEqual(plan.types, previous.types, `Type dependencies changed: ${id}`);
    assert.deepEqual(plan.values, previous.values, `Value dependencies changed: ${id}`);
    if (JSON.stringify(plan) === JSON.stringify(previous)) continue;
    assert.equal(previous.decision, 'blocked-unresolved');
    assert.equal(plan.decision, 'compose-in-owner');
    const syntax = ast.get(id)!;
    assert.ok(syntax && ts.isExpressionWithTypeArguments(syntax) && ts.isHeritageClause(syntax.parent));
    assert.ok(current.nodes.get(id)!.labels.includes('GenericUse'));
    assert.ok(plan.types.length > 0);
    assert.deepEqual(plan.owners, [idFor(syntax.parent)]);
    confirmedStableIds.push(id);
  }
  assert.equal(confirmedStableIds.length, 2);
  console.log(JSON.stringify({ok: true, confirmedStableIds, astVerified: true,
    oldNodesAndEdgesRetained: true, typeDependenciesRetained: true, writesNeo4j: false}));
} finally { db.closeSync(); instance.closeSync(); }
