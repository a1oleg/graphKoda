import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {DuckDBInstance} from '@duckdb/node-api';

const [snapshot, baseline, sourceRoot] = process.argv.slice(2);
if (!snapshot || !baseline || !sourceRoot) throw new Error('Usage: <snapshot> <baseline> <source-root>');
const instance = await DuckDBInstance.create(':memory:');
const db = await instance.connect();
const key = (from: string, kind: string, to: string) => JSON.stringify([from, kind, to]);
function normalized(value: any): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(normalized).sort());
  if (value && typeof value === 'object') return JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, normalized(v)])));
  return JSON.stringify(value);
}
async function load(root: string) {
  const nodes = new Map((await db.runAndReadAll('SELECT stable_id,labels,props_json FROM read_parquet(?)',
    [path.join(root, 'parquet/nodes.parquet')])).getRowsJS().map(([id, labels, props]) =>
    [String(id), {labels: labels as string[], props: JSON.parse(String(props))}]));
  const edges = new Map((await db.runAndReadAll('SELECT from_id,rel_type,to_id,props_json FROM read_parquet(?)',
    [path.join(root, 'parquet/relationships.parquet')])).getRowsJS().map(([from, kind, to, props]) =>
    [key(String(from), String(kind), String(to)), JSON.parse(String(props))]));
  const plan = new Map((await db.runAndReadAll('SELECT stable_id,decision,context_targets,immediate_owner_evidence FROM read_parquet(?)',
    [path.join(root, 'inventory/annotation-plan.parquet')])).getRowsJS().map(([id, decision, owners, evidence]) =>
    [String(id), {decision: String(decision), owners: owners as string[], evidence}]));
  return {nodes, edges, plan};
}
const files = new Map<string, Map<string, ts.Node>>();
function astNode(id: string) {
  const match = /^(.*):(\d+):(\d+):(\d+):(\d+)$/.exec(id);
  assert.ok(match, `Expected source coordinates: ${id}`);
  const file = match[1];
  let nodes = files.get(file);
  if (!nodes) {
    const source = ts.createSourceFile(file, fs.readFileSync(path.join(sourceRoot, file), 'utf8'),
      ts.ScriptTarget.Latest, true, file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    nodes = new Map();
    const visit = (node: ts.Node) => {
      const start = source.getLineAndCharacterOfPosition(node.getStart(source));
      const end = source.getLineAndCharacterOfPosition(node.getEnd());
      nodes!.set(`${file}:${start.line + 1}:${start.character}:${end.line + 1}:${end.character}`, node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    files.set(file, nodes);
  }
  const node = nodes.get(id);
  assert.ok(node, `AST anchor missing: ${id}`);
  return node;
}
try {
  const current = await load(snapshot), old = await load(baseline);
  assert.deepEqual(current.nodes, old.nodes, 'Node identities or data changed');
  for (const [edge, props] of old.edges) assert.deepEqual(current.edges.get(edge), props, `Existing edge changed: ${edge}`);
  const nesting = new Map<string, Set<string>>();
  let addedEdges = 0;
  for (const [edge, props] of current.edges) {
    if (old.edges.has(edge)) continue;
    const [stepId, kind, functionId] = JSON.parse(edge);
    assert.equal(kind, 'CONTAINS_CALLABLE', edge);
    assert.equal(props.ownership, 'lexical-step-context', edge);
    assert.equal(props.resolution, 'ast-step-anchor', edge);
    assert.equal(props.layer, 'structural', edge);
    assert.ok(current.nodes.get(stepId)?.labels.includes('Step'), edge);
    assert.ok(current.nodes.get(functionId)?.labels.includes('FunctionImplementation'), edge);
    const anchor = astNode(props.sourceAnchorStableId), callable = astNode(functionId);
    assert.ok(ts.isFunctionLike(callable) && 'body' in callable && callable.body, edge);
    let found = false;
    const visit = (node: ts.Node) => {
      if (ts.isFunctionLike(node) && 'body' in node && node.body) {
        if (node === callable) found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(anchor);
    assert.ok(found, `Callable not directly nested in Step anchor: ${edge}`);
    const stepAnchor = stepId.replace(/^flow-step:[^:]+:/, '');
    assert.ok(stepAnchor === props.sourceAnchorStableId || stepAnchor.startsWith(`${props.sourceAnchorStableId}:`));
    const children = nesting.get(stepId) ?? new Set<string>();
    for (const [id, node] of current.nodes) {
      if (node.labels.includes('Step') && node.props.parentFnStableId === functionId) children.add(id);
    }
    nesting.set(stepId, children);
    addedEdges++;
  }
  function reaches(from: string, to: string) {
    const seen = new Set<string>(), queue = [from];
    while (queue.length) {
      const id = queue.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const child of nesting.get(id) ?? []) {
        if (child === to) return true;
        queue.push(child);
      }
    }
    return false;
  }
  const confirmedStableIds: string[] = [];
  for (const [id, previous] of old.plan) {
    const plan = current.plan.get(id)!;
    if (normalized(plan) === normalized(previous)) continue;
    assert.equal(previous.decision, 'review-owner', `Unrelated plan changed: ${id}`);
    assert.equal(plan.decision, 'compose-in-owner', id);
    assert.equal(plan.owners.length, 1, id);
    const owner = plan.owners[0];
    assert.ok(previous.owners.includes(owner), id);
    for (const outer of previous.owners.filter(candidate => candidate !== owner)) {
      assert.ok(reaches(outer, owner), `No lexical proof for discarded owner: ${id}: ${outer}`);
      assert.ok(!reaches(owner, outer), `Cycle must stay ambiguous: ${id}`);
      assert.ok(current.edges.has(key(outer, 'HAS_OPERATION', id)), 'Outer context removed from graph');
    }
    confirmedStableIds.push(id);
  }
  assert.equal(confirmedStableIds.length, 5);
  assert.equal(addedEdges, 199);
  console.log(JSON.stringify({ok: true, confirmedStableIds, addedLexicalEdges: addedEdges,
    astVerified: true, oldNodesAndEdgesRetained: true, unrelatedPlanUnchanged: true, writesNeo4j: false}));
} finally { db.closeSync(); instance.closeSync(); }
