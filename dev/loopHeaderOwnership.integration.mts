import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {DuckDBInstance} from '@duckdb/node-api';
import {getExtendedStableId} from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';

const [snapshot, baseline, sourceRoot] = process.argv.slice(2);
if (!snapshot || !baseline || !sourceRoot) throw new Error('Usage: node --import tsx dev/loopHeaderOwnership.integration.mts <snapshot> <baseline> <source-root>');
const instance = await DuckDBInstance.create(':memory:', {memory_limit: '1GB', threads: '1'});
const db = await instance.connect();
const key = (from: string, kind: string, to: string) => JSON.stringify([from, kind, to]);
const loopKinds = new Set(['WhileStatement', 'DoStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement']);
try {
  async function load(root: string) {
    const nodes = new Map((await db.runAndReadAll('SELECT stable_id,labels,props_json FROM read_parquet(?)',
      [path.join(root, 'parquet', 'nodes.parquet')])).getRowsJS().map(([id, labels, raw]) =>
      [String(id), {labels: labels as string[], props: JSON.parse(String(raw))}]));
    const edges = new Map((await db.runAndReadAll('SELECT from_id,rel_type,to_id,props_json FROM read_parquet(?)',
      [path.join(root, 'parquet', 'relationships.parquet')])).getRowsJS().map(([from, kind, to, raw]) =>
      [key(String(from), String(kind), String(to)), JSON.parse(String(raw))]));
    return {nodes, edges};
  }
  const current = await load(snapshot), old = await load(baseline);
  for (const [id, node] of old.nodes) {
    assert.ok(current.nodes.has(id), id);
    for (const label of node.labels) assert.ok(current.nodes.get(id)!.labels.includes(label), `${id}:${label}`);
  }
  const ast = new Map<string, ts.Node>();
  const files = new Set([...current.nodes.values()].filter(node => loopKinds.has(node.props.syntaxKind))
    .map(node => node.props.repoRelativePath as string));
  for (const relative of files) {
    const filename = path.resolve(sourceRoot, relative);
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      ast.set(getExtendedStableId(source, node), node);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  function nearestOwner(id: string) {
    let ancestor = ast.get(id)?.parent;
    while (ancestor) {
      const ancestorId = getExtendedStableId(ancestor.getSourceFile(), ancestor);
      if (current.nodes.has(ancestorId)) return ancestorId;
      ancestor = ancestor.parent;
    }
    return undefined;
  }
  const counts: Record<string, number> = {};
  let headerLinks = 0;
  for (const [id, record] of current.nodes) {
    if (!loopKinds.has(record.props.syntaxKind)) continue;
    const loop = ast.get(id);
    assert.ok(loop && ts.SyntaxKind[loop.kind] === record.props.syntaxKind, id);
    assert.ok(record.labels.includes('SyntaxContainer'), id);
    counts[record.props.syntaxKind] = (counts[record.props.syntaxKind] || 0) + 1;
    for (const field of ['expression', 'initializer', 'condition', 'incrementor']) {
      const child = (loop as unknown as Record<string, ts.Node | undefined>)[field];
      if (!child) continue;
      const childId = getExtendedStableId(child.getSourceFile(), child);
      if (!current.nodes.has(childId)) continue;
      const edge = current.edges.get(key(id, 'AST_CHILD', childId));
      assert.equal(edge?.field, field, `${id}:${field}`);
      assert.equal(child.parent, loop);
      headerLinks++;
    }
  }
  assert.ok(headerLinks && Object.keys(counts).length, 'Actual loop headers required');
  let retargeted = 0;
  for (const [edgeKey, props] of old.edges) {
    if (current.edges.has(edgeKey)) continue;
    const [from, kind] = JSON.parse(edgeKey) as string[];
    assert.equal(kind, 'ENCLOSED_BY', edgeKey);
    assert.equal(props.resolution, 'nearest-materialized-ast-owner', edgeKey);
    const owner = nearestOwner(from);
    assert.ok(owner && loopKinds.has(current.nodes.get(owner)?.props.syntaxKind), edgeKey);
    assert.equal(current.edges.get(key(from, kind, owner))?.resolution, props.resolution, edgeKey);
    retargeted++;
  }
  const plan = new Map((await db.runAndReadAll('SELECT stable_id,decision,context_targets FROM read_parquet(?)',
    [path.join(snapshot, 'inventory', 'annotation-plan.parquet')])).getRowsJS().map(([id, decision, targets]) =>
    [String(id), {decision: String(decision), targets: targets as string[]}]));
  let fixed = 0;
  for (const [id, decision] of (await db.runAndReadAll('SELECT stable_id,decision FROM read_parquet(?)',
    [path.join(baseline, 'inventory', 'annotation-plan.parquet')])).getRows()) {
    if (decision !== 'review-owner') continue;
    const currentPlan = plan.get(String(id))!;
    assert.equal(currentPlan.decision, 'compose-in-owner', String(id));
    assert.equal(currentPlan.targets.length, 1);
    assert.ok(loopKinds.has(current.nodes.get(currentPlan.targets[0])?.props.syntaxKind), String(id));
    const expression = ast.get(String(id));
    assert.ok(expression && expression.parent === ast.get(currentPlan.targets[0]), String(id));
    fixed++;
  }
  assert.ok(fixed, 'Missing loop-header ownership must be reproduced');
  console.log(JSON.stringify({ok: true, loops: counts, headerLinks, fixed, retargetedAstOwners: retargeted,
    oldNodesRetained: true, writesNeo4j: false}));
} finally {
  db.closeSync();
  instance.closeSync();
}
