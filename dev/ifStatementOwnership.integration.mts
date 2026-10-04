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
  const plan = new Map((await db.runAndReadAll('SELECT stable_id,decision,context_targets FROM read_parquet(?)',
    [path.join(root, 'inventory/annotation-plan.parquet')])).getRowsJS().map(([id, decision, targets]) =>
    [String(id), {decision: String(decision), targets: targets as string[]}]));
  return {nodes, edges, plan};
}
try {
  const current = await load(snapshot), old = await load(baseline);
  const summary = JSON.parse(fs.readFileSync(path.join(snapshot, 'summary.json'), 'utf8'));
  const files = JSON.parse(summary.provenance.extraction_options).GRAPH_EXTRACT_SOURCE_ROOTS.split(';');
  const ast = new Map<string, ts.Node>();
  const idOf = (node: ts.Node) => ts.isSourceFile(node)
    ? `source-file:${path.relative(sourceRoot, node.fileName).replaceAll('\\', '/')}`
    : getExtendedStableId(node.getSourceFile(), node);
  for (const relative of files) {
    const filename = path.resolve(sourceRoot, relative);
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      const id = idOf(node);
      if (!ast.has(id)) ast.set(id, node);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const nearest = (node: ts.Node) => {
    let parent: ts.Node | undefined = node.parent;
    while (parent && !current.nodes.has(idOf(parent))) parent = parent.parent;
    assert.ok(parent, idOf(node));
    return idOf(parent);
  };
  const addedIfs = new Set<string>();
  for (const [id, node] of old.nodes) assert.deepEqual(current.nodes.get(id), node, `Existing node changed: ${id}`);
  for (const [id, node] of current.nodes) if (!old.nodes.has(id)) {
    assert.ok(ast.has(id) && ts.isIfStatement(ast.get(id)!), id);
    assert.ok(node.labels.includes('SyntaxContainer'), id);
    assert.equal(node.props.syntaxKind, 'IfStatement', id);
    addedIfs.add(id);
    const condition = idOf((ast.get(id) as ts.IfStatement).expression);
    assert.equal(current.edges.get(key(id, 'AST_CHILD', condition))?.field, 'expression', id);
    assert.deepEqual(current.plan.get(id), {decision: 'compose-in-owner', targets: [nearest(ast.get(id)!)]}, id);
  }
  let redirectedOwners = 0;
  for (const [edge, props] of old.edges) {
    if (current.edges.has(edge)) { assert.deepEqual(current.edges.get(edge), props, edge); continue; }
    const [from, kind, to] = JSON.parse(edge);
    assert.equal(kind, 'ENCLOSED_BY', edge);
    const syntax = ast.get(from)!;
    assert.ok(syntax, edge);
    const owner = nearest(syntax);
    assert.ok(addedIfs.has(owner) && owner !== to, edge);
    assert.ok(current.edges.has(key(from, 'ENCLOSED_BY', owner)), edge);
    let ancestor: ts.Node | undefined = syntax.parent;
    while (ancestor && idOf(ancestor) !== to) ancestor = ancestor.parent;
    assert.ok(ancestor, `Old owner was not an ancestor: ${edge}`);
    redirectedOwners++;
  }
  let addedEdges = 0;
  for (const edge of current.edges.keys()) if (!old.edges.has(edge)) {
    const [from, kind, to] = JSON.parse(edge);
    assert.ok(addedIfs.has(from) || addedIfs.has(to), edge);
    if (kind === 'AST_CHILD') {
      const syntax = ast.get(to)!;
      assert.ok(syntax && syntax.parent, edge);
      assert.equal(idOf(syntax.parent), from, edge);
    } else {
      assert.equal(kind, 'ENCLOSED_BY', edge);
      assert.equal(nearest(ast.get(from)!), to, edge);
    }
    addedEdges++;
  }
  const confirmedStableIds: string[] = [];
  for (const [id, previous] of old.plan) {
    const plan = current.plan.get(id)!;
    if (JSON.stringify(plan) === JSON.stringify(previous)) continue;
    assert.equal(plan.decision, 'compose-in-owner', id);
    assert.equal(plan.targets.length, 1, id);
    assert.ok(addedIfs.has(plan.targets[0]), id);
    const syntax = ast.get(id)!;
    assert.ok(syntax, id);
    assert.equal(nearest(syntax), plan.targets[0], id);
    if (previous.decision === 'blocked-unresolved') confirmedStableIds.push(id);
    else assert.equal(previous.decision, 'compose-in-owner', `Unrelated decision changed: ${id}`);
  }
  assert.equal(confirmedStableIds.length, 4);
  console.log(JSON.stringify({ok: true, confirmedStableIds, astIfStatements: addedIfs.size, addedEdges,
    redirectedOwners, oldNodesRetained: true, structuralChangesAstVerified: true, writesNeo4j: false}));
} finally { db.closeSync(); instance.closeSync(); }
