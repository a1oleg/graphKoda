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
  const nearest = new Map<string, string>();
  for (const relative of files) {
    const filename = path.resolve(sourceRoot, relative);
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if (ts.isReturnStatement(node)) {
        const id = getExtendedStableId(source, node);
        if (current.nodes.has(id)) {
          let parent: ts.Node | undefined = node.parent;
          while (parent) {
            const parentId = getExtendedStableId(source, parent);
            if (current.nodes.has(parentId)) { nearest.set(id, parentId); break; }
            parent = parent.parent;
          }
          assert.ok(nearest.has(id), id);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.ok(nearest.size, 'No real tracked return statements tested');
  for (const [id, owner] of nearest) {
    const owners = [...current.edges.keys()].map(edge => JSON.parse(edge))
      .filter(([from, kind]) => from === id && kind === 'ENCLOSED_BY').map(([, , to]) => to);
    assert.deepEqual(owners, [owner], id);
  }
  let staleEdgesRemoved = 0;
  for (const edge of old.edges.keys()) if (!current.edges.has(edge)) {
    const [from, kind, to] = JSON.parse(edge);
    assert.equal(kind, 'ENCLOSED_BY', edge);
    assert.ok(nearest.has(from) && nearest.get(from) !== to, edge);
    assert.ok(current.edges.has(key(from, kind, nearest.get(from)!)), edge);
    staleEdgesRemoved++;
  }
  for (const edge of current.edges.keys()) assert.ok(old.edges.has(edge), `Unexpected edge added: ${edge}`);
  assert.deepEqual(new Set(current.nodes.keys()), new Set(old.nodes.keys()), 'Node identities changed');
  for (const [id, node] of old.nodes) for (const label of node.labels) assert.ok(current.nodes.get(id)!.labels.includes(label), id);
  const confirmedStableIds: string[] = [];
  for (const [id, previous] of old.plan) {
    if (previous.decision === 'review-owner' && nearest.has(id)) {
      assert.deepEqual(current.plan.get(id), {decision: 'compose-in-owner', targets: [nearest.get(id)]}, id);
      confirmedStableIds.push(id);
    } else assert.deepEqual(current.plan.get(id), previous, `Unrelated plan changed: ${id}`);
  }
  assert.ok(staleEdgesRemoved && confirmedStableIds.length);
  console.log(JSON.stringify({ok: true, trackedReturns: nearest.size, staleEdgesRemoved,
    confirmedStableIds, oldNodesRetained: true, unrelatedPlanUnchanged: true, writesNeo4j: false}));
} finally { db.closeSync(); instance.closeSync(); }
