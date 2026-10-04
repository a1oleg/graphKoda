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
  assert.deepEqual(current.nodes, old.nodes, 'Extraction nodes changed');
  assert.deepEqual(current.edges, old.edges, 'Extraction relationships changed');
  const ast = new Map<string, ts.Node>();
  const files = new Set([...old.plan].filter(([id, previous]) =>
    previous.decision !== current.plan.get(id)?.decision)
    .map(([id]) => current.nodes.get(id)!.props.repoRelativePath));
  for (const relative of files) {
    const filename = path.resolve(sourceRoot, relative);
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true,
      relative.endsWith('.js') ? ts.ScriptKind.JS : relative.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node) => { ast.set(getExtendedStableId(source, node), node); ts.forEachChild(node, visit); };
    visit(source);
  }
  const receiverEdges = new Map<string, string[]>();
  for (const [edge, props] of current.edges) {
    const [from, kind, to] = JSON.parse(edge);
    if (kind === 'READS_FROM' && props.role === 'receiver') {
      receiverEdges.set(from, [...(receiverEdges.get(from) ?? []), to]);
    }
  }
  const confirmedStableIds: string[] = [];
  for (const [id, previous] of old.plan) {
    const plan = current.plan.get(id)!;
    if (previous.decision === plan.decision) {
      assert.deepEqual(plan, previous, `Unrelated context changed: ${id}`);
      continue;
    }
    assert.equal(previous.decision, 'blocked-unresolved', id);
    assert.equal(plan.decision, 'compose-in-owner', id);
    assert.deepEqual(current.subjects.get(id), {reason: 'member-access-needs-receiver', mode: 'inline'}, id);
    const node = current.nodes.get(id)!;
    assert.ok(node.labels.includes('MemberReference'), id);
    assert.equal(node.props.declarationResolution, 'no-source-declaration', id);
    assert.equal(node.props.memberResolution, 'unresolved-member', id);
    const syntax = ast.get(id)!;
    assert.ok(syntax && ts.isIdentifier(syntax) && ts.isPropertyAccessExpression(syntax.parent), id);
    const access = syntax.parent as ts.PropertyAccessExpression;
    assert.equal(access.name, syntax, id);
    const accessId = getExtendedStableId(access.getSourceFile(), access);
    assert.deepEqual(plan.owners, [accessId], id);
    assert.equal(current.edges.get(key(accessId, 'AST_CHILD', id))?.field, 'name', id);
    assert.deepEqual(plan.evidence, previous.evidence, 'Owner evidence changed');
    const receivers = receiverEdges.get(id)!;
    assert.ok(receivers?.length, id);
    assert.deepEqual(new Set(plan.values), new Set(receivers), 'Receiver dependency lost');
    assert.deepEqual(plan.values, previous.values, 'Receiver context was fabricated');
    for (const receiver of receivers) {
      assert.ok(current.nodes.has(receiver), id);
      let expression = access.expression;
      while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
        || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression)
        || ts.isNonNullExpression(expression)) expression = expression.expression;
      const receiverSyntax = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
      assert.equal(receiver, getExtendedStableId(access.getSourceFile(), receiverSyntax), id);
      assert.equal(current.edges.get(key(id, 'READS_FROM', receiver))?.resolution, 'ast-member-receiver', id);
    }
    confirmedStableIds.push(id);
  }
  assert.equal(confirmedStableIds.length, 56);
  console.log(JSON.stringify({ok: true, confirmedStableIds, unresolvedMemberDefinitionsRetained: confirmedStableIds.length,
    receiverDependenciesRetained: true, oldNodesAndEdgesRetained: true, unrelatedPlanUnchanged: true, writesNeo4j: false}));
} finally { db.closeSync(); instance.closeSync(); }
