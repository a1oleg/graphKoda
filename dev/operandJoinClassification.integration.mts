import assert from 'node:assert/strict';
import path from 'node:path';
import {DuckDBInstance} from '@duckdb/node-api';

const [snapshot, baseline] = process.argv.slice(2);
if (!snapshot || !baseline) throw new Error('Usage: <snapshot> <baseline> <source-root>');
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
  assert.deepEqual(current.edges, old.edges, 'Edges or their properties changed');
  const confirmedStableIds: string[] = [];
  let operandJoins = 0;
  for (const [id, previous] of old.nodes) {
    const node = current.nodes.get(id)!;
    assert.deepEqual(node.labels, previous.labels, id);
    const operandJoin = node.labels.includes('Operand') && node.labels.includes('Join');
    if (operandJoin) {
      operandJoins++;
      assert.equal(previous.props.operation_code, 'ACTION', id);
      assert.equal(node.props.operation_code, 'OPERAND_JOIN', id);
      assert.equal(node.props.synthetic, true, id);
    }
    const clean = (props: Record<string, unknown>) => Object.fromEntries(Object.entries(props)
      .filter(([field]) => !operandJoin || field !== 'operation_code'));
    assert.deepEqual(clean(node.props), clean(previous.props), `Unrelated node data changed: ${id}`);
    if (old.plan.get(id)?.decision === 'review-owner' && operandJoin) {
      const ownerId = node.props.parentLocalFunctionStableId;
      const owner = current.nodes.get(ownerId);
      assert.ok(owner?.labels.some(label => ['Fn', 'FnDeclaration', 'CallableDeclaration'].includes(label)), id);
      const incoming = [...current.edges.keys()].map(edge => JSON.parse(edge))
        .filter(([, kind, target]) => kind === 'NEXT' && target === id).map(([source]) => current.nodes.get(source));
      assert.ok(incoming.length > 1, id);
      for (const source of incoming) assert.equal(source?.props.parentLocalFunctionStableId, ownerId, id);
      assert.deepEqual(current.plan.get(id), {decision: 'compose-in-owner', targets: [ownerId]}, id);
      confirmedStableIds.push(id);
    } else assert.deepEqual(current.plan.get(id), old.plan.get(id), `Unrelated plan changed: ${id}`);
  }
  assert.ok(operandJoins && confirmedStableIds.length);
  console.log(JSON.stringify({ok: true, operandJoins, confirmedStableIds,
    oldNodesAndEdgesRetained: true, unrelatedPlanUnchanged: true, writesNeo4j: false}));
} finally { db.closeSync(); instance.closeSync(); }
