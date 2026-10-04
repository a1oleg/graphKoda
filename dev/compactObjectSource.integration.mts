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
async function load(root: string, cohortOnly = false) {
  const nodesPath = path.join(root, 'parquet/nodes.parquet');
  const edgesPath = path.join(root, 'parquet/relationships.parquet');
  const planPath = path.join(root, 'inventory/annotation-plan.parquet');
  const scopedNodesPath = path.join(snapshot, 'parquet/nodes.parquet');
  const badIds = "SELECT stable_id FROM read_parquet(?) WHERE starts_with(decision,'review-')";
  const nodes = new Map((await db.runAndReadAll(`SELECT stable_id,props_json FROM read_parquet(?)
    ${cohortOnly ? `WHERE stable_id IN (SELECT stable_id FROM read_parquet(?)) OR stable_id IN (${badIds})` : ''}`,
    cohortOnly ? [nodesPath, scopedNodesPath, planPath] : [nodesPath])).getRowsJS().map(([id, props]) => [String(id), JSON.parse(String(props))]));
  const edges = new Map((await db.runAndReadAll(`SELECT from_id,rel_type,to_id,props_json FROM read_parquet(?)
    ${cohortOnly ? `WHERE rel_type='COMPOSES_SYNTAX' AND from_id IN (SELECT stable_id FROM read_parquet(?)) AND to_id IN (${badIds})` : ''}`,
    cohortOnly ? [edgesPath, scopedNodesPath, planPath] : [edgesPath])).getRowsJS().map(([from, kind, to, props]) =>
    [key(String(from), String(kind), String(to)), JSON.parse(String(props))]));
  const plan = new Map((await db.runAndReadAll(`SELECT stable_id,decision FROM read_parquet(?)
    ${cohortOnly ? "WHERE starts_with(decision,'review-')" : ''}`,
    [planPath])).getRowsJS().map(([id, decision]) => [String(id), String(decision)]));
  return {nodes, edges, plan};
}
try {
  const options = (root: string) => JSON.parse(JSON.parse(fs.readFileSync(path.join(root, 'summary.json'), 'utf8')).provenance.extraction_options);
  // A full baseline is queried only for cohort findings used by scoped owners.
  // Do not load its entire graph or claim unrelated full-graph preservation.
  const cohortOnly = !options(baseline).GRAPH_EXTRACT_SOURCE_ROOTS && Boolean(options(snapshot).GRAPH_EXTRACT_SOURCE_ROOTS);
  const current = await load(snapshot), old = await load(baseline, cohortOnly);
  const sources = new Map<string, ts.SourceFile>();
  const ast = new Map<string, ts.Node>();
  function source(relative: string) {
    let file = sources.get(relative);
    if (!file) {
      const filename = path.resolve(sourceRoot, relative);
      file = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
      sources.set(relative, file);
      const visit = (node: ts.Node) => { ast.set(getExtendedStableId(file!, node), node); ts.forEachChild(node, visit); };
      visit(file);
    }
    return file;
  }
  const replacements = new Map<string, string>();
  let correctedBraceOccurrences = 0;
  for (const [edge, props] of old.edges) {
    const [owner, kind, target] = JSON.parse(edge);
    if (kind !== 'COMPOSES_SYNTAX' || current.edges.has(edge)) continue;
    const occurrences = JSON.parse(props.renderOccurrencesJson);
    assert.ok(occurrences.length, edge);
    for (const part of occurrences) {
      assert.ok(['{', '}'].includes(part.text) && part.labels.includes('Object'), edge);
      const candidates = [...current.edges].filter(([nextKey, nextProps]) => {
        const [nextOwner, nextKind] = JSON.parse(nextKey);
        return nextOwner === owner && nextKind === kind && JSON.parse(nextProps.renderOccurrencesJson)
          .some((next: {stableId: string}) => next.stableId === part.stableId);
      });
      assert.equal(candidates.length, 1, part.stableId);
      const [nextKey, nextProps] = candidates[0];
      const replacement = JSON.parse(nextKey)[2];
      const newPart = JSON.parse(nextProps.renderOccurrencesJson).find((next: {stableId: string}) => next.stableId === part.stableId);
      const coordinates = current.nodes.get(replacement);
      assert.ok(coordinates?.repoRelativePath, replacement);
      source(coordinates.repoRelativePath);
      const member = ast.get(replacement);
      assert.ok(member && ts.isTypeElement(member), replacement);
      const ownerFile = source(old.nodes.get(owner).repoRelativePath);
      assert.notEqual(ownerFile.fileName, member.getSourceFile().fileName);
      assert.equal(getExtendedStableId(ownerFile, member), target, 'Old ID must reproduce the wrong source-file calculation');
      assert.equal(getExtendedStableId(member.getSourceFile(), member), replacement);
      assert.equal(newPart.sourceStableId, replacement);
      assert.deepEqual({...newPart, sourceStableId: part.sourceStableId}, part, 'Presentation changed');
      assert.ok(!old.nodes.has(target) || !current.nodes.has(target), 'Malformed source node retained');
      assert.ok(!ast.has(target), 'Removed coordinates unexpectedly belong to real AST');
      if (replacements.has(target)) assert.equal(replacements.get(target), replacement);
      replacements.set(target, replacement);
      correctedBraceOccurrences++;
    }
  }
  assert.ok(correctedBraceOccurrences && replacements.size);
  if (!cohortOnly) for (const id of old.nodes.keys()) if (!current.nodes.has(id)) assert.ok(replacements.has(id), `Unrelated node removed: ${id}`);
  if (!cohortOnly) for (const [edge, props] of old.edges) {
    const [from, kind, to] = JSON.parse(edge);
    if (replacements.has(from) || replacements.has(to) || kind === 'COMPOSES_SYNTAX') continue;
    assert.deepEqual(current.edges.get(edge), props, `Unrelated edge changed: ${edge}`);
  }
  const replacedStableIds = [...replacements].filter(([id]) => old.plan.get(id)?.startsWith('review-'))
    .map(([stableId, replacementStableId]) => ({stableId, replacementStableId}));
  assert.ok(replacedStableIds.length, 'No ownership findings reproduced');
  console.log(JSON.stringify({ok: true, cohortOnly, correctedBraceOccurrences, replacedStableIds,
    confirmedStableIds: [], writesNeo4j: false}));
} finally { db.closeSync(); instance.closeSync(); }
