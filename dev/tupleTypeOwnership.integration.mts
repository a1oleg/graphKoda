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
  for (const [id, node] of old.nodes) assert.deepEqual(current.nodes.get(id), node, `Existing node changed: ${id}`);
  for (const [edge, props] of old.edges) assert.deepEqual(current.edges.get(edge), props, `Existing edge changed: ${edge}`);
  const ast = new Map<string, ts.Node>();
  const files = new Set([...current.nodes.values()].filter(node =>
    ['NamedTupleMember', 'OptionalType', 'RestType'].includes(node.props.syntaxKind))
    .map(node => node.props.repoRelativePath ?? node.props.repo_relative_path));
  for (const relative of files) {
    const filename = path.resolve(sourceRoot, relative);
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true,
      relative.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      const id = getExtendedStableId(source, node);
      if (!ast.has(id)) ast.set(id, node);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const wrappers = new Set<string>();
  for (const [id, node] of current.nodes) {
    if (old.nodes.has(id)) continue;
    const syntax = ast.get(id);
    assert.ok(syntax && (ts.isNamedTupleMember(syntax) || ts.isOptionalTypeNode(syntax) || ts.isRestTypeNode(syntax)), id);
    assert.ok(node.labels.includes('SyntaxContainer'), id);
    assert.equal(node.props.syntaxKind, ts.SyntaxKind[syntax.kind], id);
    wrappers.add(id);
    const typeId = getExtendedStableId(syntax.getSourceFile(), syntax.type);
    assert.equal(current.edges.get(key(id, 'AST_CHILD', typeId))?.field, 'type', id);
    let owner = syntax.parent;
    while (owner && !current.nodes.has(getExtendedStableId(owner.getSourceFile(), owner))) owner = owner.parent;
    assert.ok(owner, id);
    const ownerId = getExtendedStableId(owner.getSourceFile(), owner);
    assert.equal(current.edges.get(key(id, 'ENCLOSED_BY', ownerId))?.resolution, 'nearest-materialized-ast-owner', id);
    assert.deepEqual(current.plan.get(id), {decision: 'compose-in-owner', targets: [ownerId]}, id);
  }
  for (const edge of current.edges.keys()) {
    if (old.edges.has(edge)) continue;
    const [from, kind, to] = JSON.parse(edge);
    assert.ok(wrappers.has(from) || wrappers.has(to), edge);
    if (kind === 'AST_CHILD') {
      const child = ast.get(to)!;
      assert.ok(child, edge);
      assert.equal(getExtendedStableId(child.getSourceFile(), child.parent), from, edge);
    } else assert.equal(kind, 'ENCLOSED_BY', edge);
  }
  const confirmedStableIds: string[] = [];
  for (const [id, previous] of old.plan) {
    const plan = current.plan.get(id)!;
    if (previous.decision === 'blocked-unresolved' && plan.decision === 'compose-in-owner') {
      assert.equal(plan.targets.length, 1, id);
      assert.ok(wrappers.has(plan.targets[0]), id);
      const syntax = ast.get(id)!;
      assert.ok(syntax, id);
      assert.equal(getExtendedStableId(syntax.getSourceFile(), syntax.parent), plan.targets[0], id);
      confirmedStableIds.push(id);
    } else assert.deepEqual(plan, previous, `Unrelated plan changed: ${id}`);
  }
  assert.equal(confirmedStableIds.length, 9);
  console.log(JSON.stringify({ok: true, confirmedStableIds, astContainers: wrappers.size,
    oldNodesAndEdgesRetained: true, unrelatedPlanUnchanged: true, writesNeo4j: false}));
} finally { db.closeSync(); instance.closeSync(); }
