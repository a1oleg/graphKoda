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
try {
  const nodes = new Map((await db.runAndReadAll('SELECT stable_id,labels,props_json FROM read_parquet(?)',
    [path.join(snapshot, 'parquet/nodes.parquet')])).getRowsJS().map(([id, labels, props]) =>
    [String(id), {labels: labels as string[], props: JSON.parse(String(props))}]));
  const edges = new Map((await db.runAndReadAll('SELECT from_id,rel_type,to_id,props_json FROM read_parquet(?)',
    [path.join(snapshot, 'parquet/relationships.parquet')])).getRowsJS().map(([from, kind, to, props]) =>
    [key(String(from), String(kind), String(to)), JSON.parse(String(props))]));
  const plan = new Map((await db.runAndReadAll('SELECT stable_id,decision,context_targets FROM read_parquet(?)',
    [path.join(snapshot, 'inventory/annotation-plan.parquet')])).getRowsJS().map(([id, decision, targets]) =>
    [String(id), {decision: String(decision), targets: targets as string[]}]));
  const cohort = new Set((await db.runAndReadAll("SELECT stable_id FROM read_parquet(?) WHERE decision='review-owner'",
    [path.join(baseline, 'inventory/annotation-plan.parquet')])).getRowsJS().map(([id]) => String(id)));
  const files = new Set([...nodes.values()].filter(node => node.labels.includes('ExternalDeclaration'))
    .map(node => node.props.repoRelativePath));
  const confirmed = new Set<string>();
  let externalTypeOwners = 0;
  for (const relative of files) {
    const filename = path.resolve(sourceRoot, relative);
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node)
        || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) && node.type) {
        const owner = getExtendedStableId(source, node), type = getExtendedStableId(source, node.type);
        if (nodes.get(owner)?.labels.includes('ExternalDeclaration') && cohort.has(type) && nodes.has(type)) {
          assert.equal(nodes.get(type)?.props.syntaxKind, ts.SyntaxKind[node.type.kind], type);
          assert.equal(edges.get(key(owner, 'AST_CHILD', type))?.field, 'type', type);
          assert.deepEqual(plan.get(type), {decision: 'compose-in-owner', targets: [owner]}, type);
          externalTypeOwners++;
          confirmed.add(type);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.ok(confirmed.size, 'No real baseline external type conflicts tested');
  assert.equal(confirmed.size, externalTypeOwners, 'More than one AST owner claimed for a type');
  console.log(JSON.stringify({ok: true, externalTypeOwners,
    confirmedStableIds: [...confirmed].sort(), writesNeo4j: false}));
} finally {
  db.closeSync();
  instance.closeSync();
}
