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
    [path.join(snapshot, 'parquet/nodes.parquet')])).getRowsJS().map(([id, labels, raw]) =>
    [String(id), {labels: labels as string[], props: JSON.parse(String(raw))}]));
  const edges = new Map((await db.runAndReadAll('SELECT from_id,rel_type,to_id,props_json FROM read_parquet(?)',
    [path.join(snapshot, 'parquet/relationships.parquet')])).getRows().map(([from, kind, to, raw]) =>
    [key(String(from), String(kind), String(to)), JSON.parse(String(raw))]));
  const files = new Set([...nodes.values()].filter(node => node.props.syntaxKind === 'NewExpression')
    .map(node => node.props.repoRelativePath));
  const directArguments = new Map<string, string>();
  const callbacks = new Set<string>();
  let constructors = 0, argumentsChecked = 0, thisArguments = 0;
  for (const relative of files) {
    const filename = path.resolve(sourceRoot, relative);
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if (ts.isNewExpression(node)) {
        constructors++;
        const id = getExtendedStableId(source, node);
        node.arguments?.forEach((argument, index) => {
          const rawId = getExtendedStableId(source, argument);
          directArguments.set(rawId, id);
          if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) callbacks.add(rawId);
          assert.ok(nodes.has(rawId), rawId);
          const ast = edges.get(key(id, 'AST_CHILD', rawId));
          assert.equal(ast?.field, 'arguments', rawId);
          assert.equal(ast?.index, index, rawId);
          const value = ts.isPropertyAccessExpression(argument) ? argument.name : argument;
          const valueId = getExtendedStableId(source, value);
          const functional = edges.get(key(id, 'HAS_ARGUMENT', valueId));
          assert.equal(functional?.resolution, 'ast-constructor-argument', rawId);
          assert.equal(functional?.index, index, rawId);
          if (argument.kind === ts.SyntaxKind.ThisKeyword) {
            assert.ok(nodes.get(rawId)?.labels.includes('System'), rawId);
            assert.equal(nodes.get(rawId)?.props.syntaxKind, 'ThisKeyword', rawId);
            thisArguments++;
          }
          argumentsChecked++;
        });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  const plan = new Map((await db.runAndReadAll('SELECT stable_id,decision,context_targets,required_body_context FROM read_parquet(?)',
    [path.join(snapshot, 'inventory/annotation-plan.parquet')])).getRowsJS().map(([id, decision, targets, body]) =>
    [String(id), {decision: String(decision), targets: targets as string[], body: body as string[]}]));
  let callbackBodiesRetained = 0;
  for (const [rawId, body] of (await db.runAndReadAll('SELECT stable_id,required_body_context FROM read_parquet(?)',
    [path.join(baseline, 'inventory/annotation-plan.parquet')])).getRowsJS()) {
    const id = String(rawId);
    if (!callbacks.has(id)) continue;
    assert.ok((body as string[]).length, id);
    for (const target of body as string[]) assert.ok(plan.get(id)?.body.includes(target), `${id}:${target}`);
    callbackBodiesRetained++;
  }
  let fixed = 0;
  for (const [rawId] of (await db.runAndReadAll("SELECT stable_id FROM read_parquet(?) WHERE decision='review-owner'",
    [path.join(baseline, 'inventory/annotation-plan.parquet')])).getRows()) {
    const id = String(rawId), owner = directArguments.get(id);
    if (!owner) continue;
    assert.equal(plan.get(id)?.decision, 'compose-in-owner', id);
    assert.deepEqual(plan.get(id)?.targets, [owner], id);
    fixed++;
  }
  for (const [id] of (await db.runAndReadAll('SELECT stable_id FROM read_parquet(?)',
    [path.join(baseline, 'parquet/nodes.parquet')])).getRows()) assert.ok(nodes.has(String(id)), String(id));
  assert.ok(constructors && argumentsChecked && thisArguments && fixed);
  console.log(JSON.stringify({ok: true, constructors, argumentsChecked, thisArguments,
    fixedOwnerReviews: fixed, callbackBodiesRetained, oldNodesRetained: true, writesNeo4j: false}));
} finally { db.closeSync(); instance.closeSync(); }
