import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {DuckDBInstance} from '@duckdb/node-api';

const [snapshot, baseline, sourceRoot] = process.argv.slice(2);
if (!snapshot || !baseline || !sourceRoot) throw new Error('Usage: <snapshot> <baseline> <source-root>');
const instance = await DuckDBInstance.create(':memory:');
const db = await instance.connect();
async function load(root: string) {
  const nodes = new Map((await db.runAndReadAll('SELECT stable_id,labels,props_json FROM read_parquet(?)',
    [path.join(root, 'parquet/nodes.parquet')])).getRowsJS().map(([id, labels, props]) =>
    [String(id), {labels: labels as string[], props: JSON.parse(String(props))}]));
  const edges = new Map((await db.runAndReadAll('SELECT from_id,rel_type,to_id,props_json FROM read_parquet(?)',
    [path.join(root, 'parquet/relationships.parquet')])).getRowsJS().map(([from, kind, to, props]) =>
    [JSON.stringify([from, kind, to]), JSON.parse(String(props))]));
  const plan = new Map((await db.runAndReadAll('SELECT stable_id,decision,context_targets FROM read_parquet(?)',
    [path.join(root, 'inventory/annotation-plan.parquet')])).getRowsJS().map(([id, decision, targets]) =>
    [String(id), {decision: String(decision), targets}]));
  return {nodes, edges, plan};
}
try {
  const current = await load(snapshot), old = await load(baseline);
  assert.equal(current.nodes.size, old.nodes.size);
  const confirmedStableIds: string[] = [];
  for (const [id, previous] of old.nodes) {
    const node = current.nodes.get(id)!;
    assert.ok(node, `Node removed: ${id}`);
    if (JSON.stringify(node) === JSON.stringify(previous)) continue;
    assert.deepEqual(previous.labels, ['Reference', 'TypeReference']);
    assert.deepEqual(node.labels, ['CodeEntity', 'SyntaxPart', 'SyntaxContainer', 'System']);
    assert.equal(node.props.syntaxKind, 'InferType');
    for (const field of ['repoRelativePath', 'startLine', 'startColumn', 'endLine', 'endColumn', 'syntax']) {
      assert.equal(node.props[field], previous.props[field], `${id}: ${field}`);
    }
    const file = node.props.repoRelativePath;
    const source = ts.createSourceFile(file, fs.readFileSync(path.join(sourceRoot, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const stableId = (ast: ts.Node) => {
      const start = source.getLineAndCharacterOfPosition(ast.getStart(source));
      const end = source.getLineAndCharacterOfPosition(ast.getEnd());
      return `${file}:${start.line + 1}:${start.character}:${end.line + 1}:${end.character}`;
    };
    let matched: ts.InferTypeNode | undefined;
    const visit = (ast: ts.Node) => {
      if (ts.isInferTypeNode(ast) && stableId(ast) === id) matched = ast;
      ts.forEachChild(ast, visit);
    };
    visit(source);
    assert.ok(matched, `Not an AST infer type: ${id}`);
    const parameterId = stableId(matched.typeParameter);
    assert.ok(current.nodes.get(parameterId)?.labels.includes('TypeParameterDeclaration'));
    const child = current.edges.get(JSON.stringify([id, 'AST_CHILD', parameterId]));
    assert.equal(child?.field, 'typeParameter');
    const parentId = stableId(matched.parent);
    assert.ok(current.edges.has(JSON.stringify([id, 'ENCLOSED_BY', parentId])));
    assert.equal(old.plan.get(id)?.decision, 'blocked-unresolved');
    assert.equal(current.plan.get(id)?.decision, 'compose-in-owner');
    assert.deepEqual(current.plan.get(id)?.targets, [parentId]);
    confirmedStableIds.push(id);
  }
  assert.equal(confirmedStableIds.length, 2);
  for (const [id, plan] of old.plan) {
    if (!confirmedStableIds.includes(id)) assert.deepEqual(current.plan.get(id), plan, `Unrelated plan changed: ${id}`);
  }
  for (const [key, props] of old.edges) assert.deepEqual(current.edges.get(key), props, `Existing edge changed: ${key}`);
  const added = [...current.edges].filter(([key]) => !old.edges.has(key));
  assert.equal(added.length, 2);
  for (const [key, props] of added) {
    const [from, kind] = JSON.parse(key);
    assert.ok(confirmedStableIds.includes(from));
    assert.equal(kind, 'ENCLOSED_BY');
    assert.equal(props.resolution, 'nearest-materialized-ast-owner');
  }
  console.log(JSON.stringify({ok: true, confirmedStableIds, astVerified: true,
    unrelatedPlanUnchanged: true, oldEdgesRetained: true, writesNeo4j: false}));
} finally { db.closeSync(); instance.closeSync(); }
