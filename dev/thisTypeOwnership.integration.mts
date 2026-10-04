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
  assert.deepEqual(new Set(current.nodes.keys()), new Set(old.nodes.keys()), 'Node identities changed');
  const types = new Map<string, string>();
  const thisValues = new Set<string>();
  const files = new Set([...current.nodes.values()]
    .filter(node => node.props.repoRelativePath?.startsWith('src/') && node.props.syntaxKind === 'ThisType')
    .map(node => node.props.repoRelativePath as string));
  for (const relative of files) {
    const filename = path.resolve(sourceRoot, relative);
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if (node.kind === ts.SyntaxKind.ThisKeyword) {
        const id = getExtendedStableId(source, node);
        if (old.nodes.has(id)) thisValues.add(id);
      }
      if (ts.isThisTypeNode(node)) {
        const id = getExtendedStableId(source, node), owner = getExtendedStableId(source, node.parent);
        if (current.nodes.has(id)) {
          types.set(id, owner);
          assert.ok(current.nodes.get(id)!.labels.includes('System'), id);
          assert.equal(current.edges.get(key(owner, 'AST_CHILD', id))?.field, 'type', id);
          assert.deepEqual(current.plan.get(id), {decision: 'compose-in-owner', targets: [owner]}, id);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.ok(types.size, 'No real ThisType nodes tested');
  for (const edge of old.edges.keys()) assert.ok(current.edges.has(edge), edge);
  for (const edge of current.edges.keys()) {
    if (old.edges.has(edge)) continue;
    const [owner, kind, type] = JSON.parse(edge);
    assert.equal(kind, 'AST_CHILD', edge);
    assert.equal(types.get(type), owner, edge);
  }
  let fixed = 0;
  for (const [id, previous] of old.plan) {
    if (types.has(id) && previous.decision === 'review-owner') fixed++;
    else assert.deepEqual(current.plan.get(id), previous, `Unrelated plan changed: ${id}`);
  }
  let thisValuesRetained = 0;
  for (const [id, node] of old.nodes) {
    for (const label of node.labels) assert.ok(current.nodes.get(id)!.labels.includes(label), `${id}:${label}`);
    if (thisValues.has(id)) {
      const clean = (props: Record<string, unknown>) => Object.fromEntries(
        Object.entries(props).filter(([name]) => name !== 'provenance_id'));
      assert.deepEqual(clean(current.nodes.get(id)!.props), clean(node.props), id);
      thisValuesRetained++;
    }
  }
  assert.ok(fixed, 'Missing ThisType ownership was not reproduced');
  assert.ok(thisValuesRetained, 'Real value-level this occurrences required');
  console.log(JSON.stringify({ok: true, thisTypes: types.size, ownerReviewsResolved: fixed,
    thisValuesRetained, oldNodesAndEdgesRetained: true, unrelatedPlanUnchanged: true, writesNeo4j: false}));
} finally {
  db.closeSync();
  instance.closeSync();
}
