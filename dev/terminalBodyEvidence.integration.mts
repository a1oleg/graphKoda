import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {DuckDBInstance} from '@duckdb/node-api';
import {getExtendedStableId} from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';

const [snapshot, report, baseline, sourceRoot] = process.argv.slice(2);
if (!snapshot || !report || !baseline || !sourceRoot) throw new Error('Usage: <snapshot> <report> <baseline-report> <source-root>');
const instance = await DuckDBInstance.create(':memory:');
const db = await instance.connect();
try {
  async function subjects(root: string) {
    return new Map((await db.runAndReadAll('SELECT stable_id,body_targets,body_evidence FROM read_parquet(?)',
      [path.join(root, 'subjects.parquet')])).getRowsJS().map(([id, targets, evidence]) =>
      [String(id), {targets: targets as string[], evidence: evidence as string[]}]));
  }
  async function plan(root: string) {
    return new Map((await db.runAndReadAll('SELECT stable_id,decision FROM read_parquet(?)',
      [path.join(root, 'annotation-plan.parquet')])).getRowsJS().map(([id, decision]) => [String(id), String(decision)]));
  }
  const old = await subjects(baseline), current = await subjects(report);
  const oldPlan = await plan(baseline), newPlan = await plan(report);
  const terminals = new Map<string, Set<string>>();
  for (const [from, to] of (await db.runAndReadAll("SELECT from_id,to_id FROM read_parquet(?) WHERE rel_type='HAS_TERMINAL' AND json_extract_string(props_json,'$.ownership')='direct-terminal-scope'",
    [path.join(snapshot, 'parquet/relationships.parquet')])).getRowsJS()) {
    const id = String(from);
    if (!terminals.has(id)) terminals.set(id, new Set());
    terminals.get(id)!.add(String(to));
  }
  const ast = new Map<string, ts.Node>();
  for (const [relative] of (await db.runAndReadAll("SELECT DISTINCT json_extract_string(props_json,'$.repoRelativePath') FROM read_parquet(?) WHERE list_contains(labels,'CallbackImplementation')",
    [path.join(snapshot, 'parquet/nodes.parquet')])).getRowsJS()) {
    const filename = path.resolve(sourceRoot, String(relative));
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) { ast.set(getExtendedStableId(source, node), node); ts.forEachChild(node, visit); }
    visit(source);
  }
  let added = 0, fixed = 0;
  for (const [id, previous] of old) {
    const next = current.get(id)!;
    for (const target of previous.targets) assert.ok(next.targets.includes(target), id);
    for (const target of next.targets.filter(target => !previous.targets.includes(target))) {
      assert.ok(terminals.get(id)?.has(target), `${id}:${target}`);
      assert.ok(next.evidence.includes('HAS_TERMINAL'), id);
      added++;
    }
    if (oldPlan.get(id) !== newPlan.get(id)) {
      assert.equal(oldPlan.get(id), 'review-callback', id);
      assert.equal(newPlan.get(id), 'generation-candidate', id);
      const node = ast.get(id);
      assert.ok(node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node)), id);
      assert.ok(ts.isBlock(node.body) && node.body.statements.some(statement => ts.isThrowStatement(statement)), id);
      assert.ok(next.targets.some(target => terminals.get(id)?.has(target)), id);
      fixed++;
    }
  }
  assert.ok(added && fixed);
  console.log(JSON.stringify({ok: true, addedTerminalBodyTargets: added, fixedCallbacks: fixed,
    unrelatedPlanDecisionsUnchanged: true, writesNeo4j: false}));
} finally { db.closeSync(); instance.closeSync(); }
