import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {DuckDBInstance} from '@duckdb/node-api';
import {getExtendedStableId} from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';

const [snapshot, baseline, sourceRoot] = process.argv.slice(2);
if (!snapshot || !baseline || !sourceRoot) throw new Error('Usage: <snapshot> <baseline> <source-root>');
const instance = await DuckDBInstance.create(':memory:', {memory_limit: '1GB', threads: '1'});
const db = await instance.connect();
const key = (from: string, kind: string, to: string) => JSON.stringify([from, kind, to]);
const isContainer = (node: ts.Node) => ts.isThrowStatement(node)
  || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken);
try {
  async function load(root: string) {
    const nodes = new Map((await db.runAndReadAll('SELECT stable_id,labels,props_json FROM read_parquet(?)',
      [path.join(root, 'parquet/nodes.parquet')])).getRowsJS().map(([id, labels, raw]) =>
      [String(id), {labels: labels as string[], props: JSON.parse(String(raw))}]));
    const edges = new Map((await db.runAndReadAll('SELECT from_id,rel_type,to_id,props_json FROM read_parquet(?)',
      [path.join(root, 'parquet/relationships.parquet')])).getRowsJS().map(([from, kind, to, raw]) =>
      [key(String(from), String(kind), String(to)), JSON.parse(String(raw))]));
    return {nodes, edges};
  }
  const current = await load(snapshot), old = await load(baseline);
  for (const [id, node] of old.nodes) {
    assert.ok(current.nodes.has(id), id);
    for (const label of node.labels) assert.ok(current.nodes.get(id)!.labels.includes(label), `${id}:${label}`);
  }
  const ast = new Map<string, ts.Node>();
  const files = new Set([...current.nodes.values()].filter(node => node.props.syntaxKind === 'ThrowStatement'
    || node.props.syntaxKind === 'BinaryExpression').map(node => node.props.repoRelativePath as string));
  const counts = {sequences: 0, throws: 0, operandLinks: 0};
  for (const relative of files) {
    const filename = path.resolve(sourceRoot, relative);
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      const id = getExtendedStableId(source, node);
      ast.set(id, node);
      if (isContainer(node)) {
        assert.equal(current.nodes.get(id)?.props.syntaxKind, ts.SyntaxKind[node.kind], id);
        assert.ok(current.nodes.get(id)?.labels.includes('SyntaxContainer'), id);
        if (ts.isThrowStatement(node)) counts.throws++; else counts.sequences++;
        const operands = ts.isThrowStatement(node) ? [['expression', node.expression] as const]
          : [['left', (node as ts.BinaryExpression).left] as const, ['right', (node as ts.BinaryExpression).right] as const];
        const orders: number[] = [];
        for (const [field, operand] of operands) {
          const childId = getExtendedStableId(source, operand);
          if (!current.nodes.has(childId)) continue;
          const edge = current.edges.get(key(id, 'AST_CHILD', childId));
          assert.equal(edge?.field, field, childId);
          orders.push(edge.order);
          counts.operandLinks++;
        }
        if (orders.length === 2) assert.ok(orders[0] < orders[1], id);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.ok(counts.sequences && counts.throws && counts.operandLinks);
  let retargeted = 0;
  for (const [edgeKey, props] of old.edges) {
    if (current.edges.has(edgeKey)) continue;
    const [from, kind] = JSON.parse(edgeKey) as string[];
    assert.equal(kind, 'ENCLOSED_BY', edgeKey);
    assert.equal(props.resolution, 'nearest-materialized-ast-owner', edgeKey);
    let ancestor = ast.get(from)?.parent;
    while (ancestor && !current.nodes.has(getExtendedStableId(ancestor.getSourceFile(), ancestor))) ancestor = ancestor.parent;
    assert.ok(ancestor && isContainer(ancestor), edgeKey);
    assert.equal(current.edges.get(key(from, kind, getExtendedStableId(ancestor.getSourceFile(), ancestor)))?.resolution,
      props.resolution, edgeKey);
    retargeted++;
  }
  const plan = new Map((await db.runAndReadAll('SELECT stable_id,decision,context_targets FROM read_parquet(?)',
    [path.join(snapshot, 'inventory/annotation-plan.parquet')])).getRowsJS().map(([id, decision, targets]) =>
    [String(id), {decision: String(decision), targets: targets as string[]}]));
  let fixed = 0;
  for (const [rawId] of (await db.runAndReadAll("SELECT stable_id FROM read_parquet(?) WHERE decision='review-owner'",
    [path.join(baseline, 'inventory/annotation-plan.parquet')])).getRowsJS()) {
    const id = String(rawId), node = ast.get(id);
    assert.ok(node && isContainer(node.parent), id);
    assert.equal(plan.get(id)?.decision, 'compose-in-owner', id);
    assert.deepEqual(plan.get(id)?.targets, [getExtendedStableId(node.getSourceFile(), node.parent)], id);
    fixed++;
  }
  assert.ok(fixed);
  console.log(JSON.stringify({ok: true, ...counts, fixedOwnerReviews: fixed, retargetedAstOwners: retargeted,
    oldNodesRetained: true, writesNeo4j: false}));
} finally {
  db.closeSync();
  instance.closeSync();
}
