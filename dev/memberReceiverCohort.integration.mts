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
  const transitions = (await db.runAndReadAll(`
    SELECT a.stable_id,b.decision,a.context_targets,a.required_value_context,s.reason,s.mode,
      b.context_targets,b.required_value_context
    FROM read_parquet(?) a JOIN read_parquet(?) b USING(stable_id)
    JOIN read_parquet(?) s USING(stable_id)
    WHERE b.decision='blocked-unresolved' AND a.decision='compose-in-owner'`,
    [path.join(snapshot, 'inventory/annotation-plan.parquet'),
      path.join(baseline, 'inventory/annotation-plan.parquet'),
      path.join(snapshot, 'inventory/subjects.parquet')])).getRowsJS();
  assert.equal(transitions.length, 14);
  const ids = JSON.stringify(transitions.map(([id]) => id));
  const oldNodes = new Map((await db.runAndReadAll(`SELECT stable_id,labels,props_json FROM read_parquet(?)
    WHERE stable_id IN (SELECT json_extract_string(value,'$') FROM json_each(?))`,
    [path.join(baseline, 'parquet/nodes.parquet'), ids])).getRowsJS().map(([id, labels, props]) =>
    [String(id), {labels: labels as string[], props: JSON.parse(String(props))}]));
  const oldEdges = new Map((await db.runAndReadAll(`SELECT from_id,rel_type,to_id,props_json FROM read_parquet(?)
    WHERE from_id IN (SELECT json_extract_string(value,'$') FROM json_each(?))
      OR to_id IN (SELECT json_extract_string(value,'$') FROM json_each(?))`,
    [path.join(baseline, 'parquet/relationships.parquet'), ids, ids])).getRowsJS().map(([from, kind, to, props]) =>
    [key(String(from), String(kind), String(to)), JSON.parse(String(props))]));
  const ast = new Map<string, ts.Node>();
  for (const file of new Set(transitions.map(([id]) => nodes.get(String(id))!.props.repoRelativePath))) {
    const source = ts.createSourceFile(path.resolve(sourceRoot, file), fs.readFileSync(path.join(sourceRoot, file), 'utf8'),
      ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node) => { ast.set(getExtendedStableId(source, node), node); ts.forEachChild(node, visit); };
    visit(source);
  }
  const confirmedStableIds: string[] = [];
  for (const [rawId, , owners, values, reason, mode, oldOwners, oldValues] of transitions) {
    const id = String(rawId), node = nodes.get(id)!;
    assert.deepEqual(node, oldNodes.get(id), `Source occurrence changed: ${id}`);
    assert.ok(node.labels.includes('MemberReference'));
    assert.equal(node.props.memberResolution, 'unresolved-member');
    assert.equal(node.props.declarationResolution, 'no-source-declaration');
    assert.equal(reason, 'member-access-needs-receiver');
    assert.equal(mode, 'inline');
    if ((oldOwners as string[]).length) assert.deepEqual(owners, oldOwners, 'Existing owner context changed');
    if ((oldValues as string[]).length) assert.deepEqual(values, oldValues, 'Existing receiver dependency changed');
    const syntax = ast.get(id);
    assert.ok(syntax && ts.isIdentifier(syntax) && ts.isPropertyAccessExpression(syntax.parent));
    const access = syntax.parent as ts.PropertyAccessExpression;
    assert.equal(access.name, syntax);
    const ownerId = getExtendedStableId(access.getSourceFile(), access);
    assert.deepEqual(owners, [ownerId]);
    const childKey = key(ownerId, 'AST_CHILD', id);
    assert.equal(edges.get(childKey)?.field, 'name');
    assert.deepEqual(edges.get(childKey), oldEdges.get(childKey));
    let receiverSyntax = access.expression;
    while (ts.isParenthesizedExpression(receiverSyntax) || ts.isAsExpression(receiverSyntax)
      || ts.isTypeAssertionExpression(receiverSyntax) || ts.isNonNullExpression(receiverSyntax)
      || ts.isSatisfiesExpression(receiverSyntax)) receiverSyntax = receiverSyntax.expression;
    const receiverId = getExtendedStableId(access.getSourceFile(),
      ts.isPropertyAccessExpression(receiverSyntax) ? receiverSyntax.name : receiverSyntax);
    assert.deepEqual(values, [receiverId]);
    assert.ok(nodes.has(receiverId));
    const receiverKey = key(id, 'READS_FROM', receiverId);
    assert.equal(edges.get(receiverKey)?.role, 'receiver');
    assert.equal(edges.get(receiverKey)?.resolution, 'ast-member-receiver');
    assert.deepEqual(edges.get(receiverKey), oldEdges.get(receiverKey));
    assert.ok(![...edges.keys()].some(edge => {
      const [from, kind] = JSON.parse(edge);
      return from === id && kind === 'REFERS_TO';
    }), 'An unresolved definition was incorrectly claimed resolved');
    confirmedStableIds.push(id);
  }
  console.log(JSON.stringify({ok: true, confirmedStableIds, astVerified: true,
    sourceOccurrencesUnchanged: true, receiverDependenciesRetained: true,
    unresolvedMemberDefinitionsRetained: true, writesNeo4j: false}));
} finally { db.closeSync(); instance.closeSync(); }
