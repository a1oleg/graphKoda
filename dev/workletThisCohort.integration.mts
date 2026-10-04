import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {DuckDBInstance} from '@duckdb/node-api';
import {getExtendedStableId} from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';

const [snapshot, baseline, sourceRoot] = process.argv.slice(2);
if (!snapshot || !baseline || !sourceRoot) throw new Error('Usage: <snapshot> <baseline> <source-root>');
const relative = 'src/util/voiceRecording/recorderWorklet.js';
const source = ts.createSourceFile(path.join(sourceRoot, relative), fs.readFileSync(path.join(sourceRoot, relative), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const ast = new Map<string, ts.Node>();
const visit = (node: ts.Node) => { ast.set(getExtendedStableId(source, node), node); ts.forEachChild(node, visit); };
visit(source);
const instance = await DuckDBInstance.create(':memory:');
const db = await instance.connect();
try {
  const transitions = (await db.runAndReadAll(`
    SELECT a.stable_id,a.context_targets,a.required_value_context
    FROM read_parquet(?) a JOIN read_parquet(?) b USING(stable_id)
    WHERE b.decision='blocked-unresolved' AND a.decision='compose-in-owner'`,
    [path.join(snapshot, 'inventory/annotation-plan.parquet'), path.join(baseline, 'inventory/annotation-plan.parquet')])).getRowsJS();
  assert.equal(transitions.length, 2);
  const ids = JSON.stringify(transitions.map(([id]) => id));
  const oldNodes = new Map((await db.runAndReadAll(`SELECT stable_id,props_json FROM read_parquet(?)
    WHERE stable_id IN (SELECT json_extract_string(value,'$') FROM json_each(?))`,
    [path.join(baseline, 'parquet/nodes.parquet'), ids])).getRowsJS().map(([id, props]) => [String(id), JSON.parse(String(props))]));
  const nodes = new Map((await db.runAndReadAll('SELECT stable_id,labels,props_json FROM read_parquet(?)',
    [path.join(snapshot, 'parquet/nodes.parquet')])).getRowsJS().map(([id, labels, props]) =>
    [String(id), {labels: labels as string[], props: JSON.parse(String(props))}]));
  const edges = (await db.runAndReadAll('SELECT from_id,rel_type,to_id,props_json FROM read_parquet(?)',
    [path.join(snapshot, 'parquet/relationships.parquet')])).getRowsJS();
  const confirmedStableIds: string[] = [];
  let inheritedThroughArrow = 0;
  for (const [rawId, owners, values] of transitions) {
    const id = String(rawId), syntax = ast.get(id)!;
    assert.ok(syntax && ts.isIdentifier(syntax) && ts.isPropertyAccessExpression(syntax.parent));
    const access = syntax.parent as ts.PropertyAccessExpression;
    assert.equal(access.name, syntax);
    assert.equal(syntax.text, 'port');
    assert.equal(access.expression.kind, ts.SyntaxKind.ThisKeyword);
    const receiverId = getExtendedStableId(source, access.expression);
    let owner = access.parent;
    let crossedArrow = false;
    while (!ts.isConstructorDeclaration(owner) && !ts.isMethodDeclaration(owner)) {
      if (ts.isArrowFunction(owner)) crossedArrow = true;
      assert.ok(!ts.isFunctionExpression(owner) && !ts.isFunctionDeclaration(owner) && !ts.isSourceFile(owner));
      owner = owner.parent;
    }
    if (crossedArrow) inheritedThroughArrow++;
    const ownerId = getExtendedStableId(source, owner);
    const field = nodes.get(id)!;
    assert.ok(field.labels.includes('MemberReference'));
    assert.equal(field.props.memberResolution, 'unresolved-member');
    assert.deepEqual(field.props, oldNodes.get(id));
    const node = nodes.get(receiverId)!;
    assert.ok(node.labels.includes('RuntimeThisBinding') && !node.labels.includes('LiteralValue'));
    assert.equal(node.props.thisOwnerStableId, ownerId);
    assert.equal(node.props.thisBindingMode, 'own-callable-receiver');
    assert.deepEqual(values, [receiverId]);
    assert.deepEqual(owners, [getExtendedStableId(source, syntax.parent)]);
    assert.ok(nodes.has(ownerId));
    const receiverEdges = edges.filter(([from, kind]) => from === id && kind === 'READS_FROM');
    assert.ok(receiverEdges.some(([, , to, props]) => to === receiverId
      && JSON.parse(String(props)).role === 'receiver'));
    const binding = edges.filter(([from, kind]) => from === receiverId && kind === 'BOUND_TO_CONTEXT');
    assert.equal(binding.length, 1);
    assert.equal(binding[0][2], ownerId);
    assert.equal(JSON.parse(String(binding[0][3])).resolution, 'ast-this-binding');
    confirmedStableIds.push(id);
  }
  assert.equal(inheritedThroughArrow, 0);
  const blocked = (await db.runAndReadAll("SELECT stable_id FROM read_parquet(?) WHERE decision='blocked-unresolved'",
    [path.join(snapshot, 'inventory/annotation-plan.parquet')])).getRowsJS().map(([id]) => String(id));
  assert.equal(blocked.length, 2);
  const names = blocked.map(id => ast.get(id)!.getText(source)).sort();
  assert.deepEqual(names, ['AudioWorkletProcessor', 'registerProcessor']);
  console.log(JSON.stringify({ok: true, confirmedStableIds, astVerified: true, inheritedThroughArrow,
    unresolvedEnvironmentGlobalsRetained: names, writesNeo4j: false}));
} finally { db.closeSync(); instance.closeSync(); }
