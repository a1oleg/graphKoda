import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {DuckDBInstance} from '@duckdb/node-api';

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
  const plan = new Map((await db.runAndReadAll('SELECT stable_id,decision,context_targets,required_body_context FROM read_parquet(?)',
    [path.join(root, 'inventory/annotation-plan.parquet')])).getRowsJS().map(([id, decision, owners, body]) =>
    [String(id), {decision: String(decision), owners: owners as string[], body: body as string[]}]));
  const subjects = new Map((await db.runAndReadAll('SELECT stable_id,body_count,body_targets FROM read_parquet(?)',
    [path.join(root, 'inventory/subjects.parquet')])).getRowsJS().map(([id, count, targets]) =>
    [String(id), {count: Number(count), targets: targets as string[]}]));
  return {nodes, edges, plan, subjects};
}
try {
  const current = await load(snapshot), old = await load(baseline);
  assert.deepEqual(current.nodes, old.nodes, 'Extraction nodes changed');
  assert.deepEqual(current.edges, old.edges, 'Extraction relationships changed');
  const outgoing = new Map<string, {kind: string; to: string; props: any}[]>();
  for (const [edge, props] of current.edges) {
    const [from, kind, to] = JSON.parse(edge);
    outgoing.set(from, [...(outgoing.get(from) ?? []), {kind, to, props}]);
  }
  const sources = new Map<string, ts.SourceFile>();
  const confirmedStableIds: string[] = [];
  for (const [id, previous] of old.subjects) {
    const subject = current.subjects.get(id)!;
    const added = subject.targets.filter(target => !previous.targets.includes(target));
    if (!added.length) {
      assert.deepEqual(subject, previous, id);
      assert.deepEqual(current.plan.get(id), old.plan.get(id), `Unrelated plan changed: ${id}`);
      continue;
    }
    const entries = (outgoing.get(id) ?? []).filter(edge => edge.kind === 'NEXT' && edge.props.semantic_expansion === 'function-entry');
    assert.equal(entries.length, 1, id);
    const pending = [entries[0].to], seen = new Set<string>(), targets = new Set<string>();
    while (pending.length) {
      const at = pending.pop()!;
      if (seen.has(at)) continue;
      seen.add(at);
      for (const edge of outgoing.get(at) ?? []) {
        if (edge.kind === 'SIGNATURE_PARAMETER' || edge.kind === 'SIGNATURE_RETURN') pending.push(edge.to);
        if (edge.kind === 'BODY_ENTRY') { assert.ok(current.nodes.has(edge.to), id); targets.add(edge.to); }
      }
    }
    assert.deepEqual(new Set(subject.targets), new Set([...previous.targets, ...targets]), id);
    assert.equal(subject.count, subject.targets.length, id);
    const plan = current.plan.get(id)!;
    assert.deepEqual(new Set(plan.body), new Set(subject.targets), 'Body context was not retained');
    assert.deepEqual(plan.owners, old.plan.get(id)!.owners, 'Ownership changed');
    if (old.plan.get(id)?.decision !== 'review-callback') {
      assert.equal(plan.decision, old.plan.get(id)!.decision, `Unrelated decision changed: ${id}`);
      continue;
    }
    assert.equal(previous.count, 0, id);
    const node = current.nodes.get(id)!;
    const relative = node.props.repo_relative_path;
    let source = sources.get(relative);
    if (!source) {
      source = ts.createSourceFile(relative, fs.readFileSync(path.join(sourceRoot, relative), 'utf8'), ts.ScriptTarget.Latest, true);
      sources.set(relative, source);
    }
    let implementation: ts.ArrowFunction | ts.FunctionExpression | undefined;
    const visit = (ast: ts.Node) => {
      const start = source!.getLineAndCharacterOfPosition(ast.getStart(source));
      const end = source!.getLineAndCharacterOfPosition(ast.end);
      if ((ts.isArrowFunction(ast) || ts.isFunctionExpression(ast))
        && start.line + 1 === node.props.start_line && start.character === node.props.start_column
        && end.line + 1 === node.props.end_line && end.character === node.props.end_column) implementation = ast;
      ts.forEachChild(ast, visit);
    };
    visit(source);
    assert.ok(implementation && ts.isBlock(implementation.body) && implementation.body.statements.length, id);
    let expression: ts.Node = implementation;
    while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
    assert.ok(ts.isCallExpression(expression.parent) && expression.parent.expression === expression, `Not an IIFE: ${id}`);
    assert.deepEqual(new Set(added), targets, id);
    assert.equal(plan.decision, 'generation-candidate', id);
    confirmedStableIds.push(id);
  }
  assert.equal(confirmedStableIds.length, 2);
  console.log(JSON.stringify({ok: true, confirmedStableIds, actualIifeBodies: 2,
    oldNodesAndEdgesRetained: true, unrelatedDecisionsUnchanged: true, writesNeo4j: false}));
} finally { db.closeSync(); instance.closeSync(); }
