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
  const plan = new Map((await db.runAndReadAll('SELECT stable_id,decision,context_targets,required_value_context FROM read_parquet(?)',
    [path.join(root, 'inventory/annotation-plan.parquet')])).getRowsJS().map(([id, decision, owners, values]) =>
    [String(id), {decision: String(decision), owners: owners as string[], values: values as string[]}]));
  return {nodes, edges, plan};
}
try {
  const current = await load(snapshot), old = await load(baseline);
  assert.equal(current.nodes.size, old.nodes.size);
  const bindings = [...current.nodes].filter(([, node]) => node.labels.includes('RuntimeThisBinding'));
  const ast = new Map<string, ts.Node>();
  for (const relative of new Set(bindings.map(([, node]) => node.props.repoRelativePath))) {
    const source = ts.createSourceFile(path.resolve(sourceRoot, relative), fs.readFileSync(path.join(sourceRoot, relative), 'utf8'),
      ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => { ast.set(getExtendedStableId(source, node), node); ts.forEachChild(node, visit); };
    visit(source);
  }
  const owners = new Map<string, string>();
  let inheritedThroughArrows = 0, classInitializers = 0;
  for (const [id, node] of bindings) {
    const syntax = ast.get(id);
    assert.equal(syntax?.kind, ts.SyntaxKind.ThisKeyword, id);
    const ownerId = node.props.thisOwnerStableId, owner = ast.get(ownerId);
    assert.ok(owner, `Binding owner missing in AST: ${id}`);
    let cursor = syntax!.parent, passedArrow = false;
    while (cursor && cursor !== owner) {
      if (ts.isArrowFunction(cursor)) passedArrow = true;
      else assert.ok(!ts.isFunctionLike(cursor) && !ts.isClassDeclaration(cursor) && !ts.isClassExpression(cursor),
        `This crosses an independent binding boundary: ${id}`);
      cursor = cursor.parent;
    }
    assert.equal(cursor, owner);
    if (passedArrow) inheritedThroughArrows++;
    if (ts.isClassDeclaration(owner) || ts.isClassExpression(owner)) {
      assert.equal(node.props.thisBindingMode, 'class-initializer-context');
      classInitializers++;
    } else {
      assert.ok(ts.isFunctionLike(owner) && !ts.isArrowFunction(owner) && 'body' in owner && owner.body);
      assert.equal(node.props.thisBindingMode, 'own-callable-receiver');
    }
    const props = current.edges.get(key(id, 'BOUND_TO_CONTEXT', ownerId));
    assert.equal(props?.resolution, 'ast-this-binding');
    assert.equal(props?.bindingMode, node.props.thisBindingMode);
    assert.equal(node.props.runtimeIntrinsic, 'this');
    assert.ok(!node.labels.includes('LiteralValue'), 'This is not a literal');
    assert.deepEqual(current.plan.get(id)?.values, [ownerId]);
    owners.set(id, ownerId);
  }
  assert.equal(bindings.length, 236);
  assert.ok(inheritedThroughArrows > 0 && classInitializers > 0);
  for (const [id, previous] of old.nodes) {
    const node = current.nodes.get(id)!;
    assert.ok(node, `Node removed: ${id}`);
    if (!owners.has(id)) assert.deepEqual(node, previous, `Unrelated node changed: ${id}`);
    else for (const [field, value] of Object.entries(previous.props)) {
      if (!['roles', 'roleNames'].includes(field)) assert.deepEqual(node.props[field], value, `${id}: ${field}`);
    }
  }
  for (const [edge, props] of old.edges) assert.deepEqual(current.edges.get(edge), props, `Old edge changed: ${edge}`);
  const added = [...current.edges].filter(([edge]) => !old.edges.has(edge));
  assert.equal(added.length, bindings.length);
  for (const [edge] of added) {
    const [from, kind, to] = JSON.parse(edge);
    assert.equal(kind, 'BOUND_TO_CONTEXT');
    assert.equal(owners.get(from), to);
  }
  const confirmedStableIds: string[] = [];
  for (const [id, previous] of old.plan) {
    const plan = current.plan.get(id)!;
    if (!owners.has(id)) { assert.deepEqual(plan, previous, `Unrelated plan changed: ${id}`); continue; }
    if (previous.decision === 'blocked-unresolved') {
      assert.equal(plan.decision, 'compose-in-owner');
      assert.equal(plan.owners.length, 1);
      assert.ok(current.edges.has(key(plan.owners[0], 'AST_CHILD', id)));
      confirmedStableIds.push(id);
    } else {
      assert.equal(plan.decision, previous.decision);
      assert.deepEqual(plan.owners, previous.owners);
    }
  }
  assert.equal(confirmedStableIds.length, 1);
  console.log(JSON.stringify({ok: true, confirmedStableIds, astVerified: true,
    bindingsVerified: bindings.length, inheritedThroughArrows, classInitializers,
    oldRelationshipsRetained: true, unrelatedPlanUnchanged: true, writesNeo4j: false}));
} finally { db.closeSync(); instance.closeSync(); }
