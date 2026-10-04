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
  const plan = new Map((await db.runAndReadAll('SELECT stable_id,decision,context_targets,immediate_owner_evidence FROM read_parquet(?)',
    [path.join(root, 'inventory/annotation-plan.parquet')])).getRowsJS().map(([id, decision, owners, evidence]) =>
    [String(id), {decision: String(decision), owners: owners as string[], evidence}]));
  return {nodes, edges, plan};
}
try {
  const current = await load(snapshot), old = await load(baseline);
  assert.deepEqual(current.nodes, old.nodes, 'Node identities or data changed');
  for (const [edge, props] of old.edges) assert.deepEqual(current.edges.get(edge), props, `Existing edge changed: ${edge}`);
  const contexts = new Map<string, Set<string>>();
  let addedEdges = 0;
  for (const [edge, props] of current.edges) {
    if (old.edges.has(edge)) continue;
    const [stepId, kind, compositionId] = JSON.parse(edge);
    assert.equal(kind, 'HAS_OPERATION', edge);
    assert.equal(props.ownership, 'composition-step-context', edge);
    assert.equal(props.resolution, 'flow-syntax-composition', edge);
    assert.equal(props.layer, 'structural', edge);
    const step = current.nodes.get(stepId)!, composition = current.nodes.get(compositionId)!;
    assert.ok(step?.labels.includes('Step'), edge);
    assert.ok(composition?.labels.includes('SyntaxComposition'), edge);
    const sourceFlow = old.nodes.get(props.sourceFlowNodeStableId);
    assert.ok(sourceFlow, `Source flow node missing: ${edge}`);
    assert.equal(sourceFlow.props.parentStepStableId, stepId, 'Ownership was not provided by the flow builder');
    assert.ok(JSON.parse(sourceFlow.props.render_parts_json).length > 1, edge);
    const targets = contexts.get(compositionId) ?? new Set<string>();
    targets.add(stepId);
    contexts.set(compositionId, targets);
    addedEdges++;
  }
  const confirmedStableIds: string[] = [], unresolvedStableIds: string[] = [];
  for (const [id, previous] of old.plan) {
    const plan = current.plan.get(id)!;
    if (JSON.stringify(plan) === JSON.stringify(previous)) continue;
    assert.equal(previous.decision, 'blocked-unresolved', `Unrelated plan changed: ${id}`);
    const owners = contexts.get(id)!;
    assert.ok(owners?.size, id);
    assert.deepEqual(new Set(plan.owners), owners, 'Owner alternatives were discarded');
    for (const evidence of plan.evidence as any[]) {
      assert.equal(evidence.field, 'composition-step-context', id);
      assert.equal(evidence.tier, 5, id);
      assert.ok(owners.has(evidence.target), id);
    }
    if (owners.size === 1) {
      assert.equal(plan.decision, 'compose-in-owner', id);
      confirmedStableIds.push(id);
    } else {
      assert.equal(plan.decision, 'review-owner', 'Ambiguity was hidden');
      unresolvedStableIds.push(id);
    }
  }
  assert.equal(confirmedStableIds.length, 5);
  assert.equal(unresolvedStableIds.length, 5);
  console.log(JSON.stringify({ok: true, confirmedStableIds, unresolvedStableIds, addedContextEdges: addedEdges,
    oldNodesAndEdgesRetained: true, ambiguitiesRetained: true, unrelatedPlanUnchanged: true, writesNeo4j: false}));
} finally { db.closeSync(); instance.closeSync(); }
