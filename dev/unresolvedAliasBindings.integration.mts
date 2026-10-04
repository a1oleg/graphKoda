import assert from 'node:assert/strict';
import path from 'node:path';
import ts from 'typescript';
import {DuckDBInstance} from '@duckdb/node-api';
import {createProgram, getExtendedStableId} from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';
import projectPaths from './projectPaths.cjs';
import {gitIdentity} from './extractionProvenance.mjs';

const [snapshot, baseline, baselineReport] = process.argv.slice(2);
if (!snapshot || !baseline || !baselineReport) throw new Error('Usage: <snapshot> <baseline-snapshot> <baseline-report>');
const instance = await DuckDBInstance.create(':memory:', {memory_limit: '1GB', threads: '1'});
const db = await instance.connect();
try {
  const metadata = JSON.parse(String((await db.runAndReadAll('SELECT metadata_json FROM read_parquet(?)',
    [path.join(snapshot, 'parquet/provenance.parquet')])).getRows()[0][0]));
  const identity = gitIdentity(projectPaths.sourceRoot);
  assert.equal(identity.commit, metadata.source_revision);
  assert.equal(identity.dirtyFingerprint, metadata.source_dirty_fingerprint);
  const program = createProgram(), checker = program.getTypeChecker();
  const requested = new Map((await db.runAndReadAll("SELECT n.stable_id,n.props_json FROM read_parquet(?) n JOIN read_parquet(?) p USING(stable_id) WHERE p.decision='blocked-unresolved'",
    [path.join(baseline, 'parquet/nodes.parquet'), path.join(baselineReport, 'annotation-plan.parquet')])).getRows()
    .map(([id, raw]) => [String(id), JSON.parse(String(raw))]));
  const plan = new Map((await db.runAndReadAll('SELECT stable_id,decision,context_targets FROM read_parquet(?)',
    [path.join(snapshot, 'inventory/annotation-plan.parquet')])).getRowsJS().map(([id, decision, targets]) =>
    [String(id), {decision: String(decision), targets: targets as string[]}]));
  const links = new Map((await db.runAndReadAll("SELECT from_id,list(to_id) FROM read_parquet(?) WHERE rel_type='RESOLVES_TO' GROUP BY from_id",
    [path.join(snapshot, 'parquet/relationships.parquet')])).getRowsJS().map(([id, targets]) => [String(id), targets as string[]]));
  let fixed = 0, unchanged = 0;
  const visited = new Set<string>();
  for (const relative of new Set([...requested.values()].map(props => props.repoRelativePath))) {
    const source = program.getSourceFile(path.resolve(projectPaths.sourceRoot, relative));
    assert.ok(source, relative);
    function visit(node: ts.Node) {
      const id = getExtendedStableId(source!, node);
      if (requested.has(id)) {
        visited.add(id);
        const symbol = checker.getSymbolAtLocation(node);
        const target = symbol && (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : undefined;
        const declarations = symbol?.declarations || (symbol?.valueDeclaration ? [symbol.valueDeclaration] : []);
        if (target && !target.declarations?.length && !target.valueDeclaration && declarations.length) {
          const originalIds = declarations.map(declaration => getExtendedStableId(declaration.getSourceFile(), declaration));
          assert.ok(originalIds.some(original => links.get(id)?.includes(original)), id);
          assert.equal(plan.get(id)?.decision, 'follow-original', id);
          assert.ok(plan.get(id)?.targets.some(original => originalIds.includes(original)), id);
          fixed++;
        } else {
          assert.equal(plan.get(id)?.decision, 'blocked-unresolved', id);
          unchanged++;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.equal(visited.size, requested.size);
  assert.ok(fixed && unchanged);
  console.log(JSON.stringify({ok: true, fixedLocalAliasOccurrences: fixed, unchangedUnresolvedReferences: unchanged,
    sourceIdentityConfirmed: true, writesNeo4j: false}));
} finally { db.closeSync(); instance.closeSync(); }
