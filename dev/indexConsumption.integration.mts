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
  const plan = new Map((await db.runAndReadAll('SELECT stable_id,decision,context_targets,required_value_context,immediate_owner_evidence FROM read_parquet(?)',
    [path.join(root, 'inventory/annotation-plan.parquet')])).getRowsJS().map(([id, decision, owners, values, evidence]) =>
    [String(id), {decision: String(decision), owners: owners as string[], values: values as string[], evidence}]));
  const subjects = new Map((await db.runAndReadAll('SELECT stable_id,reason,mode FROM read_parquet(?)',
    [path.join(root, 'inventory/subjects.parquet')])).getRowsJS().map(([id, reason, mode]) =>
    [String(id), {reason: String(reason), mode: String(mode)}]));
  return {nodes, edges, plan, subjects};
}
try {
  const current = await load(snapshot), old = await load(baseline);
  assert.deepEqual(current.nodes, old.nodes);
  assert.deepEqual(current.edges, old.edges);
  const confirmedStableIds: string[] = [];
  for (const [id, previous] of old.plan) {
    const plan = current.plan.get(id)!;
    if (previous.decision === plan.decision) {
      assert.deepEqual(plan, previous, `Unrelated plan changed: ${id}`);
      assert.deepEqual(current.subjects.get(id), old.subjects.get(id));
      continue;
    }
    assert.equal(previous.decision, 'blocked-unresolved');
    assert.equal(plan.decision, 'compose-in-owner');
    assert.deepEqual(current.subjects.get(id), {reason: 'index-access-needs-operands', mode: 'inline'});
    const node = current.nodes.get(id)!;
    assert.ok(node.labels.includes('ValueConsumption'));
    assert.equal(node.props.consumptionKind, 'index-access');
    const file = node.props.repoRelativePath;
    const source = ts.createSourceFile(path.resolve(sourceRoot, file), fs.readFileSync(path.join(sourceRoot, file), 'utf8'),
      ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let access: ts.ElementAccessExpression | undefined;
    const visit = (ast: ts.Node) => {
      if (ts.isElementAccessExpression(ast) && getExtendedStableId(source, ast) === id) access = ast;
      ts.forEachChild(ast, visit);
    };
    visit(source);
    assert.ok(access && ts.isPropertyAccessExpression(access.parent));
    const ownerId = getExtendedStableId(source, access.parent);
    assert.deepEqual(plan.owners, [ownerId]);
    assert.equal(current.edges.get(key(ownerId, 'AST_CHILD', id))?.field, 'expression');
    assert.deepEqual(plan.evidence, previous.evidence);
    const receiver = ts.isPropertyAccessExpression(access.expression) ? access.expression.name : access.expression;
    const receiverId = getExtendedStableId(source, receiver);
    const indexId = getExtendedStableId(source, access.argumentExpression);
    assert.deepEqual(new Set(plan.values), new Set([receiverId, indexId]));
    assert.deepEqual(plan.values, previous.values);
    for (const [target, role] of [[receiverId, 'receiver'], [indexId, 'index']]) {
      assert.ok(current.nodes.has(target));
      const edge = current.edges.get(key(id, 'CONSUMES_VALUE', target));
      assert.equal(edge?.role, role);
      assert.equal(edge?.resolution, 'ast-operand');
    }
    confirmedStableIds.push(id);
  }
  assert.equal(confirmedStableIds.length, 1);
  console.log(JSON.stringify({ok: true, confirmedStableIds, astVerified: true,
    operandDependenciesRetained: true, graphUnchanged: true, unrelatedPlanUnchanged: true, writesNeo4j: false}));
} finally { db.closeSync(); instance.closeSync(); }
