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
  for (const [id, node] of old.nodes) {
    assert.ok(current.nodes.has(id), id);
    for (const label of node.labels) assert.ok(current.nodes.get(id)!.labels.includes(label), `${id}:${label}`);
  }
  for (const edge of old.edges.keys()) assert.ok(current.edges.has(edge), edge);
  const expected = new Map<string, string>();
  const files = new Set([...old.nodes.values()]
    .filter(node => node.labels.includes('ExternalDeclaration'))
    .map(node => node.props.repoRelativePath as string));
  for (const relative of files) {
    const filename = path.resolve(sourceRoot, relative);
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node)
        || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) && node.type) {
        const owner = getExtendedStableId(source, node), type = getExtendedStableId(source, node.type);
        if (old.nodes.get(owner)?.labels.includes('ExternalDeclaration')) {
          expected.set(type, owner);
          assert.equal(current.nodes.get(type)?.props.syntaxKind, ts.SyntaxKind[node.type.kind], type);
          assert.equal(current.edges.get(key(owner, 'AST_CHILD', type))?.field, 'type', type);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.ok(expected.size, 'No real external declaration types tested');
  for (const edge of current.edges.keys()) {
    if (old.edges.has(edge)) continue;
    const [owner, kind, type] = JSON.parse(edge);
    assert.equal(kind, 'AST_CHILD', edge);
    assert.equal(expected.get(type), owner, edge);
  }
  for (const id of current.nodes.keys()) {
    if (!old.nodes.has(id)) assert.ok(expected.has(id), `Unrelated node added: ${id}`);
  }
  let fixed = 0, correctedSingleOwners = 0;
  for (const [id, before] of old.plan) {
    const after = current.plan.get(id)!;
    if (expected.has(id) && (before.decision === 'review-owner' || before.decision === 'compose-in-owner')) {
      assert.equal(after.decision, 'compose-in-owner', id);
      assert.deepEqual(after.targets, [expected.get(id)], id);
      if (before.decision === 'review-owner') fixed++;
      else if (JSON.stringify(before.targets) !== JSON.stringify(after.targets)) correctedSingleOwners++;
    } else assert.deepEqual(after, before, `Unrelated plan changed: ${id}`);
  }
  assert.ok(fixed, 'Missing external type ownership was not reproduced');
  console.log(JSON.stringify({ok: true, externalTypeOwners: expected.size, ownerReviewsResolved: fixed, correctedSingleOwners,
    oldNodesAndEdgesRetained: true, unrelatedPlanUnchanged: true, writesNeo4j: false}));
} finally {
  db.closeSync();
  instance.closeSync();
}
