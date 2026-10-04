import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DuckDBInstance} from '@duckdb/node-api';
import {captureExtractionProvenance, verifyExtractionInputs} from './extractionProvenance.mjs';
import {FunctionFlowDuckdbStage} from '../graph/static-extract/ts/functionFlowDuckdbStage.ts';

const input = process.argv[2];
if (!input) throw new Error('Usage: node --import tsx dev/provenanceCompletion.integration.mts <actual-parquet-directory>');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-completion-'));
const instance = await DuckDBInstance.create(':memory:');
const connection = await instance.connect();
let stage: FunctionFlowDuckdbStage | undefined;
try {
  const provenance = captureExtractionProvenance();
  await connection.run('CREATE TABLE selected_edges AS SELECT * FROM read_parquet(?) LIMIT 20',
    [path.join(input, 'relationships.parquet')]);
  const nodes = (await connection.runAndReadAll(`SELECT stable_id,labels,props_json FROM read_parquet(?)
    WHERE stable_id IN (SELECT from_id FROM selected_edges UNION SELECT to_id FROM selected_edges)`,
    [path.join(input, 'nodes.parquet')])).getRows();
  const edges = (await connection.runAndReadAll('SELECT from_id,to_id,rel_type,props_json FROM selected_edges')).getRows();
  assert.ok(nodes.length && edges.length, 'Actual extraction must contain nodes and edges');
  const output = path.join(temporary, 'parquet');
  stage = await FunctionFlowDuckdbStage.create(path.join(temporary, 'stage.duckdb'), output, undefined, provenance);
  for (const [stableId, labels, props] of nodes) {
    stage.addEntity('semanticEntity', {stableId: String(stableId), labels: labels as string[], props: JSON.parse(String(props))});
  }
  for (const [fromId, toId, type, props] of edges) {
    stage.addRelationship('semanticRelationship', {fromId: String(fromId), toId: String(toId), type: String(type), props: JSON.parse(String(props))});
  }
  const completion = verifyExtractionInputs(provenance);
  await stage.finalize();
  stage = undefined;
  const rows = (await connection.runAndReadAll('SELECT id,metadata_json FROM read_parquet(?)',
    [path.join(output, 'provenance.parquet')])).getRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0], provenance.id);
  assert.deepEqual(JSON.parse(String(rows[0][1])).completion_check, completion);
  console.log(JSON.stringify({ok: true, actualNodes: nodes.length, actualEdges: edges.length, completionPersisted: true, writesNeo4j: false}));
} finally {
  stage?.close();
  connection.closeSync();
  instance.closeSync();
  fs.rmSync(temporary, {recursive: true, force: true});
}
