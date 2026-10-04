import assert from 'node:assert/strict';
import path from 'node:path';
import ts from 'typescript';
import {DuckDBInstance} from '@duckdb/node-api';
import {classifyRuntimeIntrinsic} from '../graph/static-extract/ts/functionFlowGraph.runtimeIntrinsics.ts';
import {createProgram, getExtendedStableId, isTrackedSourceFile} from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';

const snapshot = process.argv[2], baseline = process.argv[3];
if (!snapshot || !baseline) throw new Error('Usage: node --import tsx dev/runtimeIntrinsics.integration.mts <actual-snapshot> <baseline>');
const instance = await DuckDBInstance.create(':memory:', {memory_limit: '1GB', threads: '1'});
const db = await instance.connect();
try {
  const nodes = new Map((await db.runAndReadAll('SELECT stable_id,labels,props_json FROM read_parquet(?)',
    [path.join(snapshot, 'parquet', 'nodes.parquet')])).getRowsJS().map(([id, labels, raw]) =>
    [String(id), {labels: labels as string[], props: JSON.parse(String(raw))}]));
  const edges = (await db.runAndReadAll('SELECT from_id,rel_type,to_id FROM read_parquet(?)',
    [path.join(snapshot, 'parquet', 'relationships.parquet')])).getRows().map(row => row.map(String));
  const edgeKeys = new Set(edges.map(row => JSON.stringify(row)));
  for (const [id] of (await db.runAndReadAll('SELECT stable_id FROM read_parquet(?)',
    [path.join(baseline, 'parquet', 'nodes.parquet')])).getRows()) assert.ok(nodes.has(String(id)));
  for (const row of (await db.runAndReadAll('SELECT from_id,rel_type,to_id FROM read_parquet(?)',
    [path.join(baseline, 'parquet', 'relationships.parquet')])).getRows()) assert.ok(edgeKeys.has(JSON.stringify(row.map(String))));
  const old = new Map((await db.runAndReadAll('SELECT stable_id,decision FROM read_parquet(?)',
    [path.join(baseline, 'inventory', 'annotation-plan.parquet')])).getRows().map(([id, decision]) => [String(id), String(decision)]));
  let corrected = 0;
  for (const [id, decision] of (await db.runAndReadAll('SELECT stable_id,decision FROM read_parquet(?)',
    [path.join(snapshot, 'inventory', 'annotation-plan.parquet')])).getRows()) {
    const previous = old.get(String(id));
    if (previous && previous !== decision) {
      assert.equal(previous, 'blocked-unresolved');
      assert.equal(decision, 'compose-in-owner');
      assert.ok(nodes.get(String(id))?.props.runtimeIntrinsic);
      corrected++;
    }
  }
  const program = createProgram();
  const checker = program.getTypeChecker();
  const counts = {arguments: 0, globalThis: 0, declaredReferencesRetained: 0};
  for (const source of program.getSourceFiles()) {
    if (!isTrackedSourceFile(source)) continue;
    function visit(node: ts.Node) {
      if (ts.isIdentifier(node) && ['arguments', 'globalThis'].includes(node.text)) {
        const id = getExtendedStableId(source, node);
        const recorded = nodes.get(id);
        const intrinsic = classifyRuntimeIntrinsic(program, node);
        if (intrinsic) {
          assert.ok(recorded, id);
          assert.equal(recorded.props.runtimeIntrinsic, intrinsic.kind, id);
          assert.ok(recorded.labels.includes('System') && !recorded.labels.includes('Reference'), id);
          if (intrinsic.owner) {
            let lexicalOwner: ts.Node | undefined = node.parent;
            while (lexicalOwner && !(ts.isFunctionLike(lexicalOwner) && !ts.isArrowFunction(lexicalOwner)
              && 'body' in lexicalOwner && lexicalOwner.body)) lexicalOwner = lexicalOwner.parent;
            assert.equal(intrinsic.owner, lexicalOwner, id);
            const ownerId = getExtendedStableId(source, intrinsic.owner);
            assert.equal(recorded.props.argumentsOwnerStableId, ownerId);
            assert.ok(edgeKeys.has(JSON.stringify([id, 'READS_ARGUMENTS_OF', ownerId])));
            assert.ok(!ts.isArrowFunction(intrinsic.owner));
            assert.ok(edges.some(([a, relation, b]) => a === id && relation === 'HAS_TYPE'
              && nodes.get(b)?.props.name === 'IArguments'));
            counts.arguments++;
          } else counts.globalThis++;
        } else if (recorded?.labels.includes('Reference') && checker.getSymbolAtLocation(node)?.declarations?.length) {
          assert.equal(recorded.props.runtimeIntrinsic, undefined);
          assert.ok(edges.some(([a, relation]) => a === id && relation === 'RESOLVES_TO'));
          counts.declaredReferencesRetained++;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.ok(counts.arguments && counts.globalThis && counts.declaredReferencesRetained && corrected);
  console.log(JSON.stringify({ok: true, ...counts, corrected, oldNodesAndEdgesRetained: true, writesNeo4j: false}));
} finally {
  db.closeSync();
  instance.closeSync();
}
