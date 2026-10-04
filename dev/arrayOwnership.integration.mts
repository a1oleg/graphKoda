import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {DuckDBInstance} from '@duckdb/node-api';
import {getExtendedStableId} from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';

const [snapshot, baseline, sourceRoot] = process.argv.slice(2);
if (!snapshot || !baseline || !sourceRoot) throw new Error('Usage: node --import tsx dev/arrayOwnership.integration.mts <snapshot> <baseline> <source-root>');
const instance = await DuckDBInstance.create(':memory:', {memory_limit: '1GB', threads: '1'});
const db = await instance.connect();
const edgeKey = (from: string, kind: string, to: string) => JSON.stringify([from, kind, to]);
const kinds = new Set(['ArrayLiteralExpression', 'SpreadElement']);
try {
  async function load(root: string) {
    const nodes = new Map((await db.runAndReadAll('SELECT stable_id,labels,props_json FROM read_parquet(?)',
      [path.join(root, 'parquet', 'nodes.parquet')])).getRowsJS().map(([id, labels, raw]) =>
      [String(id), {labels: labels as string[], props: JSON.parse(String(raw))}]));
    const edges = new Map((await db.runAndReadAll('SELECT from_id,rel_type,to_id,props_json FROM read_parquet(?)',
      [path.join(root, 'parquet', 'relationships.parquet')])).getRowsJS().map(([from, kind, to, raw]) =>
      [edgeKey(String(from), String(kind), String(to)), JSON.parse(String(raw))]));
    return {nodes, edges};
  }
  const current = await load(snapshot), old = await load(baseline);
  for (const [id, node] of old.nodes) {
    assert.ok(current.nodes.has(id), id);
    for (const label of node.labels) assert.ok(current.nodes.get(id)!.labels.includes(label), `${id}:${label}`);
  }
  const ast = new Map<string, ts.Node>();
  const files = new Set([...current.nodes.values()].filter(node => kinds.has(node.props.syntaxKind))
    .map(node => node.props.repoRelativePath as string));
  const counts = {arrays: 0, spreads: 0, materializedElementLinks: 0, spreadOperandLinks: 0};
  for (const relative of files) {
    const filename = path.resolve(sourceRoot, relative);
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      const id = getExtendedStableId(source, node);
      ast.set(id, node);
      if (ts.isArrayLiteralExpression(node) || ts.isSpreadElement(node)) {
        const record = current.nodes.get(id);
        assert.equal(record?.props.syntaxKind, ts.SyntaxKind[node.kind], id);
        assert.ok(record?.labels.includes('SyntaxContainer'), id);
        if (ts.isArrayLiteralExpression(node)) {
          counts.arrays++;
          node.elements.forEach((element, index) => {
            const childId = getExtendedStableId(source, element);
            if (!current.nodes.has(childId)) return;
            const relation = current.edges.get(edgeKey(id, 'AST_CHILD', childId));
            assert.equal(relation?.field, 'elements', childId);
            assert.equal(relation?.index, index, childId);
            counts.materializedElementLinks++;
          });
        } else {
          counts.spreads++;
          const childId = getExtendedStableId(source, node.expression);
          if (current.nodes.has(childId)) {
            assert.equal(current.edges.get(edgeKey(id, 'AST_CHILD', childId))?.field, 'expression', id);
            counts.spreadOperandLinks++;
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.ok(counts.arrays && counts.spreads && counts.materializedElementLinks && counts.spreadOperandLinks);
  let retargeted = 0;
  for (const [key, props] of old.edges) {
    if (current.edges.has(key)) continue;
    const [from, kind] = JSON.parse(key) as string[];
    assert.equal(kind, 'ENCLOSED_BY', key);
    assert.equal(props.resolution, 'nearest-materialized-ast-owner', key);
    let ancestor = ast.get(from)?.parent;
    while (ancestor && !current.nodes.has(getExtendedStableId(ancestor.getSourceFile(), ancestor))) ancestor = ancestor.parent;
    assert.ok(ancestor && kinds.has(ts.SyntaxKind[ancestor.kind]), key);
    const ownerId = getExtendedStableId(ancestor.getSourceFile(), ancestor);
    assert.equal(current.edges.get(edgeKey(from, kind, ownerId))?.resolution, props.resolution, key);
    retargeted++;
  }
  const plan = new Map((await db.runAndReadAll('SELECT stable_id,decision,context_targets FROM read_parquet(?)',
    [path.join(snapshot, 'inventory', 'annotation-plan.parquet')])).getRowsJS().map(([id, decision, targets]) =>
    [String(id), {decision: String(decision), targets: targets as string[]}]));
  const fixed = {'review-owner': 0, 'blocked-unresolved': 0};
  for (const [id, decision] of (await db.runAndReadAll('SELECT stable_id,decision FROM read_parquet(?)',
    [path.join(baseline, 'inventory', 'annotation-plan.parquet')])).getRows()) {
    if (!(String(decision) in fixed)) continue;
    const resolved = plan.get(String(id))!;
    assert.equal(resolved.decision, 'compose-in-owner', String(id));
    assert.equal(resolved.targets.length, 1);
    const expression = ast.get(String(id));
    const owner = ast.get(resolved.targets[0]);
    assert.ok(expression && owner && kinds.has(ts.SyntaxKind[owner.kind]), String(id));
    assert.equal(expression.parent, owner, String(id));
    fixed[String(decision) as keyof typeof fixed]++;
  }
  assert.ok(fixed['review-owner'] && fixed['blocked-unresolved']);
  console.log(JSON.stringify({ok: true, ...counts, fixed, retargetedAstOwners: retargeted,
    oldNodesRetained: true, writesNeo4j: false}));
} finally {
  db.closeSync();
  instance.closeSync();
}
