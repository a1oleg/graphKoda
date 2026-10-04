import assert from 'node:assert/strict';
import path from 'node:path';
import ts from 'typescript';
import {DuckDBInstance} from '@duckdb/node-api';
import {createProgram, getExtendedStableId} from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';
import projectPaths from './projectPaths.cjs';
import {gitIdentity} from './extractionProvenance.mjs';

const [snapshot, baseline] = process.argv.slice(2);
if (!snapshot || !baseline) throw new Error('Usage: <snapshot> <baseline>');
const instance = await DuckDBInstance.create(':memory:');
const db = await instance.connect();
try {
  const metadata = JSON.parse(String((await db.runAndReadAll('SELECT metadata_json FROM read_parquet(?)',
    [path.join(snapshot, 'parquet/provenance.parquet')])).getRows()[0][0]));
  const identity = gitIdentity(projectPaths.sourceRoot);
  assert.equal(identity.commit, metadata.source_revision);
  assert.equal(identity.dirtyFingerprint, metadata.source_dirty_fingerprint);
  const program = createProgram();
  program.getTypeChecker();
  const nodes = new Map((await db.runAndReadAll('SELECT stable_id,labels,props_json FROM read_parquet(?)',
    [path.join(snapshot, 'parquet/nodes.parquet')])).getRowsJS().map(([id, labels, raw]) =>
    [String(id), {labels: labels as string[], props: JSON.parse(String(raw))}]));
  const plan = new Map((await db.runAndReadAll('SELECT stable_id,decision,required_value_context FROM read_parquet(?)',
    [path.join(snapshot, 'inventory/annotation-plan.parquet')])).getRowsJS().map(([id, decision, targets]) =>
    [String(id), {decision: String(decision), targets: targets as string[]}]));
  const requested = new Set((await db.runAndReadAll("SELECT n.stable_id FROM read_parquet(?) n JOIN read_parquet(?) p USING(stable_id) WHERE p.decision='blocked-unresolved' AND list_contains(n.labels,'MemberReference')",
    [path.join(baseline, 'parquet/nodes.parquet'), path.join(baseline, 'inventory/annotation-plan.parquet')])).getRows().map(([id]) => String(id)));
  const links = new Map((await db.runAndReadAll("SELECT from_id,to_id,props_json FROM read_parquet(?) WHERE rel_type='READS_FROM' AND json_extract_string(props_json,'$.role')='receiver'",
    [path.join(snapshot, 'parquet/relationships.parquet')])).getRows().map(([from, to, raw]) =>
    [String(from), {to: String(to), props: JSON.parse(String(raw))}]));
  const resolved = new Set((await db.runAndReadAll("SELECT from_id FROM read_parquet(?) WHERE rel_type IN ('RESOLVES_TO','RESOLVES_TO_MEMBER')",
    [path.join(snapshot, 'parquet/relationships.parquet')])).getRows().map(([id]) => String(id)));
  let checked = 0;
  for (const relative of new Set([...requested].map(id => nodes.get(id)!.props.repoRelativePath))) {
    const source = program.getSourceFile(path.resolve(projectPaths.sourceRoot, relative));
    assert.ok(source, relative);
    function visit(node: ts.Node) {
      const id = getExtendedStableId(source!, node);
      if (requested.has(id)) {
        assert.ok(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node, id);
        const receiverId = getExtendedStableId(source!, node.parent.expression);
        assert.equal(links.get(id)?.to, receiverId, id);
        assert.equal(links.get(id)?.props.resolution, 'ast-member-receiver', id);
        assert.equal(nodes.get(id)?.props.memberResolution, 'unresolved-member', id);
        assert.ok(!nodes.get(id)?.labels.includes('DynamicMemberAccess'), id);
        assert.ok(!resolved.has(id), id);
        assert.equal(plan.get(id)?.decision, 'blocked-unresolved', id);
        assert.ok(plan.get(id)?.targets.includes(receiverId), id);
        checked++;
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.ok(checked);
  assert.equal(checked, requested.size);
  for (const [id, labels] of (await db.runAndReadAll('SELECT stable_id,labels FROM read_parquet(?)',
    [path.join(baseline, 'parquet/nodes.parquet')])).getRowsJS()) {
    assert.ok(nodes.has(String(id)), String(id));
    for (const label of labels as string[]) assert.ok(nodes.get(String(id))!.labels.includes(label), `${id}:${label}`);
  }
  console.log(JSON.stringify({ok: true, unresolvedMembersWithAstReceiver: checked,
    requiredReceiverContexts: checked, oldNodesRetained: true, noInventedResolutions: true, writesNeo4j: false}));
} finally { db.closeSync(); instance.closeSync(); }
