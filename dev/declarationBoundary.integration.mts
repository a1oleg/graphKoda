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
  assert.deepEqual(current.edges, old.edges, 'Graph relationships changed');
  assert.equal(current.nodes.size, old.nodes.size);
  const confirmedStableIds: string[] = [];
  for (const [id, previous] of old.nodes) {
    const node = current.nodes.get(id)!;
    assert.ok(node, `Node deleted: ${id}`);
    if (JSON.stringify(node) === JSON.stringify(previous)) continue;
    assert.deepEqual(node.props, previous.props, `Node properties changed: ${id}`);
    assert.ok(previous.labels.includes('Declaration') && previous.labels.includes('TypeFamilyClose'));
    assert.ok(node.labels.includes('CallBoundary') && !node.labels.includes('Declaration'));
    assert.deepEqual(new Set(node.labels), new Set(previous.labels.map(label => label === 'Declaration' ? 'CallBoundary' : label)));
    assert.equal(node.props.container_method_kind, 'declare');
    const parts = JSON.parse(node.props.render_parts_json);
    assert.equal(parts.at(-1).text, ')');
    const file = node.props.repo_relative_path;
    const source = ts.createSourceFile(path.resolve(sourceRoot, file), fs.readFileSync(path.join(sourceRoot, file), 'utf8'),
      ts.ScriptTarget.Latest, true);
    let declaration: ts.VariableDeclaration | undefined;
    const visit = (ast: ts.Node) => {
      if (ts.isVariableDeclaration(ast) && getExtendedStableId(source, ast) === parts.at(-1).sourceStableId) declaration = ast;
      ts.forEachChild(ast, visit);
    };
    visit(source);
    assert.ok(declaration && ts.isIdentifier(declaration.name) && declaration.type && declaration.initializer);
    assert.ok(ts.isArrayLiteralExpression(declaration.initializer) && declaration.initializer.elements.length === 0);
    assert.ok(ts.isTypeReferenceNode(declaration.type) && declaration.type.typeArguments?.length === 1);
    assert.ok(ts.isTypeLiteralNode(declaration.type.typeArguments[0]) && declaration.type.typeArguments[0].members.length > 1);
    assert.equal(getExtendedStableId(source, declaration.name), node.props.container_stable_id);
    const stepId = node.props.parentStepStableId;
    assert.ok(current.nodes.get(stepId)?.labels.includes('Step'));
    assert.ok(ts.isVariableDeclarationList(declaration.parent) && ts.isVariableStatement(declaration.parent.parent));
    assert.equal(stepId, `flow-step:statement:${getExtendedStableId(source, declaration.parent.parent)}`);
    assert.equal(old.plan.get(id)?.decision, 'blocked-unresolved');
    assert.equal(current.plan.get(id)?.decision, 'compose-in-owner');
    assert.deepEqual(current.plan.get(id)?.targets, [stepId]);
    confirmedStableIds.push(id);
  }
  assert.equal(confirmedStableIds.length, 2);
  for (const [id, plan] of old.plan) {
    if (!confirmedStableIds.includes(id)) assert.deepEqual(current.plan.get(id), plan, `Unrelated plan changed: ${id}`);
  }
  console.log(JSON.stringify({ok: true, confirmedStableIds, astVerified: true,
    realDeclarationsUnchanged: true, renderPartsUnchanged: true,
    graphRelationshipsUnchanged: true, unrelatedPlanUnchanged: true, writesNeo4j: false}));
} finally { db.closeSync(); instance.closeSync(); }
