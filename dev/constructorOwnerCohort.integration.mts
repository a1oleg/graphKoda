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
  const nodes = new Map((await db.runAndReadAll('SELECT stable_id,props_json FROM read_parquet(?)',
    [path.join(snapshot, 'parquet/nodes.parquet')])).getRowsJS().map(([id, props]) =>
    [String(id), JSON.parse(String(props))]));
  const edges = new Map((await db.runAndReadAll('SELECT from_id,rel_type,to_id,props_json FROM read_parquet(?)',
    [path.join(snapshot, 'parquet/relationships.parquet')])).getRowsJS().map(([from, kind, to, props]) =>
    [key(String(from), String(kind), String(to)), JSON.parse(String(props))]));
  const plan = new Map((await db.runAndReadAll('SELECT stable_id,decision,context_targets FROM read_parquet(?)',
    [path.join(snapshot, 'inventory/annotation-plan.parquet')])).getRowsJS().map(([id, decision, targets]) =>
    [String(id), {decision: String(decision), targets: targets as string[]}]));
  const cohort = new Set((await db.runAndReadAll("SELECT stable_id FROM read_parquet(?) WHERE decision='review-owner'",
    [path.join(baseline, 'inventory/annotation-plan.parquet')])).getRowsJS().map(([id]) => String(id)));
  const files = new Set([...nodes.values()].filter(node => node.syntaxKind === 'NewExpression'
    && node.repoRelativePath?.startsWith('src/')).map(node => node.repoRelativePath));
  const confirmed = new Set<string>();
  let constructors = 0, argumentsChecked = 0, fallbackOwners = 0;
  for (const relative of files) {
    const filename = path.resolve(sourceRoot, relative);
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      const id = getExtendedStableId(source, node);
      if (ts.isNewExpression(node)) {
        constructors++;
        node.arguments?.forEach((argument, index) => {
          const argumentId = getExtendedStableId(source, argument);
          assert.ok(nodes.has(argumentId), argumentId);
          const ast = edges.get(key(id, 'AST_CHILD', argumentId));
          assert.equal(ast?.field, 'arguments', argumentId);
          assert.equal(ast?.index, index, argumentId);
          argumentsChecked++;
        });
      }
      if (cohort.has(id)) {
        const parent = node.parent;
        const constructorArgument = ts.isNewExpression(parent) && parent.arguments?.includes(node as ts.Expression);
        const fallback = ts.isBinaryExpression(parent)
          && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(parent.operatorToken.kind)
          && ts.isNewExpression(parent.parent) && parent.parent.arguments?.includes(parent);
        if (constructorArgument || fallback) {
          const owner = getExtendedStableId(source, parent);
          const relation = edges.get(key(owner, 'AST_CHILD', id));
          assert.equal(relation?.field, constructorArgument ? 'arguments' : parent.right === node ? 'right' : 'left', id);
          assert.deepEqual(plan.get(id), {decision: 'compose-in-owner', targets: [owner]}, id);
          confirmed.add(id);
          if (fallback) fallbackOwners++;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.ok(constructors && argumentsChecked && confirmed.size && fallbackOwners);
  console.log(JSON.stringify({ok: true, constructors, argumentsChecked, fallbackOwners,
    confirmedStableIds: [...confirmed].sort(), writesNeo4j: false}));
} finally {
  db.closeSync();
  instance.closeSync();
}
