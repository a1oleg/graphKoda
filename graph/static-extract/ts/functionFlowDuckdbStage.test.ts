import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DuckDBInstance } from '@duckdb/node-api';

import { FunctionFlowDuckdbStage } from './functionFlowDuckdbStage.ts';

test('canonical flow layer is preserved from extractor entity properties', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coldkode-flow-layer-'));
  const databasePath = path.join(root, 'stage.duckdb');
  const parquetDir = path.join(root, 'parquet');
  try {
    const stage = await FunctionFlowDuckdbStage.create(databasePath, parquetDir);
    stage.addEntity('node', { stableId: 'value', labels: ['Value'], props: { flow_layer: 'data' } });
    stage.addEntity('node', { stableId: 'next', labels: ['Action'], props: { flow_layer: 'control' } });
    stage.addEntity('node', { stableId: 'expression', labels: ['Value'], props: { flow_layer: 'data' } });
    stage.addRelationship('edge', {
      fromId: 'value',
      toId: 'next',
      type: 'NEXT',
      props: { flow_layer: 'control' },
    });
    stage.addRelationship('edge', {
      fromId: 'value',
      toId: 'expression',
      type: 'EVAL',
      props: { flow_layer: 'data' },
    });
    await stage.finalize();

    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    const result = await connection.runAndReadAll(`
      SELECT json_extract_string(props_json::JSON, '$.flow_layer')
      FROM read_parquet('${path.join(parquetDir, 'nodes.parquet').replaceAll("'", "''")}')
      WHERE stable_id = 'value'
    `);
    assert.equal(result.getRows()[0]?.[0], 'data');
    connection.closeSync();
    instance.closeSync();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('canonicalization merges only duplicate entity and relationship records', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coldkode-canonical-duplicates-'));
  const databasePath = path.join(root, 'stage.duckdb');
  const parquetDir = path.join(root, 'parquet');
  try {
    const stage = await FunctionFlowDuckdbStage.create(databasePath, parquetDir);
    stage.addEntity('node', { stableId: 'left', labels: ['Value'], props: { first: 1 } });
    stage.addEntity('node', { stableId: 'left', labels: ['Read'], props: { second: 2 } });
    stage.addEntity('node', { stableId: 'right', labels: ['Value'], props: { only: true } });
    stage.addRelationship('edge', {
      fromId: 'left', toId: 'right', type: 'NEXT', props: { first: 1 },
    });
    stage.addRelationship('edge', {
      fromId: 'left', toId: 'right', type: 'NEXT', props: { second: 2 },
    });
    await stage.finalize();

    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    const escapedDir = parquetDir.replaceAll("'", "''");
    const entities = await connection.runAndReadAll(`
      SELECT stable_id, list_sort(labels), props_json::JSON
      FROM read_parquet('${path.join(escapedDir, 'nodes.parquet')}')
      ORDER BY stable_id
    `);
    const relationships = await connection.runAndReadAll(`
      SELECT props_json::JSON
      FROM read_parquet('${path.join(escapedDir, 'relationships.parquet')}')
    `);
    const entityRows = entities.getRows().map(([stableId, labels, props]) => [
      stableId,
      (labels as { items: string[] }).items,
      props,
    ]);
    assert.deepEqual(entityRows, [
      ['left', ['Read', 'Value'], '{"first":1,"second":2}'],
      ['right', ['Value'], '{"only":true}'],
    ]);
    assert.deepEqual(relationships.getRows(), [['{"first":1,"second":2}']]);
    connection.closeSync();
    instance.closeSync();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('canonicalization preserves alternative value returns between the same nodes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coldkode-alternative-returns-'));
  const databasePath = path.join(root, 'stage.duckdb');
  const parquetDir = path.join(root, 'parquet');
  try {
    const stage = await FunctionFlowDuckdbStage.create(databasePath, parquetDir);
    stage.addEntity('node', { stableId: 'branch', labels: ['Branch'], props: {} });
    stage.addEntity('node', { stableId: 'set', labels: ['Value'], props: {} });
    for (const producerOutcome of ['true', 'false']) {
      stage.addRelationship('edge', {
        fromId: 'branch',
        toId: 'set',
        type: 'ASSIGNS_VALUE',
        props: {
          producer_outcome: producerOutcome,
          source_render_part_stable_id: `branch:${producerOutcome}`,
        },
      });
    }
    await stage.finalize();

    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    const relationships = await connection.runAndReadAll(`
      SELECT json_extract_string(props_json::JSON, '$.producer_outcome')
      FROM read_parquet('${path.join(parquetDir, 'relationships.parquet').replaceAll("'", "''")}')
      ORDER BY 1
    `);
    assert.deepEqual(relationships.getRows(), [['false'], ['true']]);
    connection.closeSync();
    instance.closeSync();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
