import fs from 'node:fs';
import path from 'node:path';
import {captureExtractionProvenance} from '../../../dev/extractionProvenance.mjs';

import {
  DuckDBAppender,
  DuckDBConnection,
  DuckDBInstance,
} from '@duckdb/node-api';

export type CanonicalEntity = {
  stableId: string;
  labels: string[];
  props: Record<string, unknown>;
};

export type CanonicalRelationship = {
  fromId: string;
  toId: string;
  type: string;
  props: Record<string, unknown>;
};

export type StageCounts = {
  rawEntities: number;
  rawRelationships: number;
  canonicalEntities: number;
  canonicalRelationships: number;
};

export type StageProgress = {
  phase: 'extract' | 'validate' | 'canonicalize' | 'complete';
  rawEntities: number;
  rawRelationships: number;
};

export type StageMetric = { operation: string; seconds: number; cpuSeconds: number; rssBytes: number };

// This only controls DuckDB appender flushing. Neo4j transaction batching is
// configured independently by fromPreGraphToNeo4j.py.
const DUCKDB_APPENDER_FLUSH_ROWS = 50_000;

function sqlPath(filePath: string) {
  return filePath.replaceAll("'", "''");
}

function compactJson(value: Record<string, unknown>) {
  return JSON.stringify(value);
}

export class FunctionFlowDuckdbStage {
  readonly metrics: StageMetric[] = [];
  private ordinal = 0n;
  private pendingEntities = 0;
  private pendingRelationships = 0;
  private rawEntities = 0;
  private rawRelationships = 0;

  private constructor(
    readonly databasePath: string,
    readonly parquetDir: string,
    private readonly instance: DuckDBInstance,
    private readonly connection: DuckDBConnection,
    private readonly entityAppender: DuckDBAppender,
    private readonly relationshipAppender: DuckDBAppender,
    private readonly onProgress?: (progress: StageProgress) => void,
    readonly provenance = captureExtractionProvenance(),
  ) {}

  static async create(
    databasePath: string,
    parquetDir: string,
    onProgress?: (progress: StageProgress) => void,
    provenance = captureExtractionProvenance(),
  ) {
    const resolvedDatabasePath = path.resolve(databasePath);
    const resolvedParquetDir = path.resolve(parquetDir);
    fs.mkdirSync(path.dirname(resolvedDatabasePath), { recursive: true });
    fs.mkdirSync(resolvedParquetDir, { recursive: true });
    for (const filePath of [
      resolvedDatabasePath,
      `${resolvedDatabasePath}.wal`,
      path.join(resolvedParquetDir, 'nodes.parquet'),
      path.join(resolvedParquetDir, 'relationships.parquet'),
      path.join(resolvedParquetDir, 'provenance.parquet'),
    ]) {
      if (fs.existsSync(filePath)) fs.rmSync(filePath);
    }

    const instance = await DuckDBInstance.create(resolvedDatabasePath, {
      preserve_insertion_order: 'false',
    });
    const connection = await instance.connect();
    await connection.run(`CREATE TABLE extraction_provenance (id VARCHAR PRIMARY KEY, metadata_json VARCHAR)`);
    const metadata = await connection.createAppender('extraction_provenance');
    metadata.appendVarchar(provenance.id);
    metadata.appendVarchar(JSON.stringify(provenance));
    metadata.endRow();metadata.closeSync();
    await connection.run(`
      CREATE TABLE raw_entities (
        ordinal BIGINT,
        stable_id VARCHAR,
        labels VARCHAR[],
        props_json VARCHAR,
        source_kind VARCHAR
      );
      CREATE TABLE raw_relationships (
        ordinal BIGINT,
        signature VARCHAR,
        from_id VARCHAR,
        to_id VARCHAR,
        rel_type VARCHAR,
        props_json VARCHAR,
        source_kind VARCHAR
      );
    `);
    const entityAppender = await connection.createAppender('raw_entities');
    const relationshipAppender = await connection.createAppender('raw_relationships');
    return new FunctionFlowDuckdbStage(
      resolvedDatabasePath,
      resolvedParquetDir,
      instance,
      connection,
      entityAppender,
      relationshipAppender,
      onProgress,
      provenance,
    );
  }

  private report(phase: StageProgress['phase']) {
    this.onProgress?.({
      phase,
      rawEntities: this.rawEntities,
      rawRelationships: this.rawRelationships,
    });
  }

  private async measured<T>(operation: string, run: () => Promise<T>): Promise<T> {
    const started = performance.now();
    const cpu = process.cpuUsage();
    try { return await run(); } finally {
      const used = process.cpuUsage(cpu);
      const metric = { operation, seconds: (performance.now() - started) / 1000,
        cpuSeconds: (used.user + used.system) / 1e6, rssBytes: process.memoryUsage().rss };
      this.metrics.push(metric);
      process.stderr.write(`[graph:func:stage-metric] ${JSON.stringify(metric)}\n`);
    }
  }

  static async resume(databasePath: string, parquetDir: string, confirmedProvenanceId: string) {
    if (!fs.existsSync(databasePath)) throw new Error('Staging database does not exist.');
    const instance = await DuckDBInstance.create(path.resolve(databasePath), {
      memory_limit: '4GB', threads: '2', preserve_insertion_order: 'false',
    });
    const connection = await instance.connect();
    try {
      const rows = (await connection.runAndReadAll('SELECT metadata_json FROM extraction_provenance')).getRows();
      if (rows.length !== 1) throw new Error('Expected one extraction provenance record.');
      const provenance = JSON.parse(String(rows[0][0]));
      if (provenance.id !== confirmedProvenanceId) throw new Error('Confirmed provenance ID does not match staging.');
      const current = captureExtractionProvenance();
      if (current.source_revision !== provenance.source_revision || current.source_dirty_fingerprint !== provenance.source_dirty_fingerprint) {
        throw new Error('Source changed since extraction.');
      }
      fs.mkdirSync(parquetDir, { recursive: true });
      const counts = (await connection.runAndReadAll('SELECT (SELECT count(*) FROM raw_entities), (SELECT count(*) FROM raw_relationships)')).getRows()[0];
      await connection.run('CREATE TABLE IF NOT EXISTS extraction_resumptions (metadata_json VARCHAR)');
      const audit = await connection.createAppender('extraction_resumptions');
      audit.appendVarchar(JSON.stringify({ confirmedProvenanceId, resumedAt: new Date().toISOString(), current, contentEquivalence: 'user-confirmed-commit-only' }));
      audit.endRow(); audit.closeSync();
      const stage = new FunctionFlowDuckdbStage(path.resolve(databasePath), path.resolve(parquetDir), instance, connection,
        await connection.createAppender('raw_entities'), await connection.createAppender('raw_relationships'),
        progress => process.stderr.write(`${JSON.stringify(progress)}\n`), provenance);
      stage.rawEntities = Number(counts[0]);
      stage.rawRelationships = Number(counts[1]);
      return stage;
    } catch (error) {
      connection.closeSync(); instance.closeSync(); throw error;
    }
  }

  addEntity(sourceKind: string, row: CanonicalEntity) {
    this.ordinal += 1n;
    this.entityAppender.appendBigInt(this.ordinal);
    this.entityAppender.appendVarchar(row.stableId);
    this.entityAppender.appendList(row.labels);
    this.entityAppender.appendVarchar(compactJson(row.props));
    this.entityAppender.appendVarchar(sourceKind);
    this.entityAppender.endRow();
    this.pendingEntities += 1;
    this.rawEntities += 1;
    if (this.pendingEntities >= DUCKDB_APPENDER_FLUSH_ROWS) {
      this.entityAppender.flushSync();
      this.pendingEntities = 0;
      this.report('extract');
    }
  }

  addRelationship(sourceKind: string, row: CanonicalRelationship) {
    const producerOutcome = row.props.producer_outcome;
    const relationshipVariant = producerOutcome === 'true' || producerOutcome === 'false'
      ? `\u0000producer_outcome=${producerOutcome}`
      : '';
    this.ordinal += 1n;
    this.relationshipAppender.appendBigInt(this.ordinal);
    this.relationshipAppender.appendVarchar(`${row.fromId}\u0000${row.type}\u0000${row.toId}${relationshipVariant}`);
    this.relationshipAppender.appendVarchar(row.fromId);
    this.relationshipAppender.appendVarchar(row.toId);
    this.relationshipAppender.appendVarchar(row.type);
    this.relationshipAppender.appendVarchar(compactJson(row.props));
    this.relationshipAppender.appendVarchar(sourceKind);
    this.relationshipAppender.endRow();
    this.pendingRelationships += 1;
    this.rawRelationships += 1;
    if (this.pendingRelationships >= DUCKDB_APPENDER_FLUSH_ROWS) {
      this.relationshipAppender.flushSync();
      this.pendingRelationships = 0;
      this.report('extract');
    }
  }

  async finalize(): Promise<StageCounts> {
    this.entityAppender.closeSync();
    this.relationshipAppender.closeSync();

    this.report('validate');
    const missing = await this.measured('validate-endpoints', () => this.connection.runAndReadAll(`
      WITH entity_ids AS (
        SELECT DISTINCT stable_id FROM raw_entities
      ), missing AS (
        SELECT signature, from_id AS stable_id, 'from' AS endpoint
        FROM raw_relationships rel
        WHERE NOT EXISTS (SELECT 1 FROM entity_ids entity WHERE entity.stable_id = rel.from_id)
        UNION ALL
        SELECT signature, to_id AS stable_id, 'to' AS endpoint
        FROM raw_relationships rel
        WHERE NOT EXISTS (SELECT 1 FROM entity_ids entity WHERE entity.stable_id = rel.to_id)
      )
      SELECT stable_id, endpoint, count(*) AS reference_count
      FROM missing
      GROUP BY stable_id, endpoint
      ORDER BY reference_count DESC, stable_id
      LIMIT 20
    `));
    const missingRows = missing.getRows();
    if (missingRows.length) {
      const serializedRows = JSON.stringify(
        missingRows,
        (_key, value) => typeof value === 'bigint' ? value.toString() : value,
      );
      throw new Error(`DuckDB staging found missing relationship endpoints: ${serializedRows}`);
    }

    this.report('canonicalize');
    await this.measured('duplicate-entity-ids', () => this.connection.run(`
      CREATE TEMP TABLE duplicate_entity_ids AS
      SELECT stable_id
      FROM raw_entities
      GROUP BY stable_id
      HAVING count(*) > 1;
    `));
    await this.measured('merge-entities', () => this.connection.run(`
      CREATE TEMP TABLE canonical_entities_export AS
      SELECT raw.stable_id, raw.labels, raw.props_json
      FROM raw_entities raw
      ANTI JOIN duplicate_entity_ids duplicates USING (stable_id)
      UNION ALL
      SELECT raw.stable_id,
             list_distinct(flatten(list(raw.labels ORDER BY raw.ordinal))) AS labels,
             list_reduce(
               list(raw.props_json::JSON ORDER BY raw.ordinal),
               (left_props, right_props) -> json_merge_patch(left_props, right_props)
             )::VARCHAR AS props_json
      FROM raw_entities raw
      SEMI JOIN duplicate_entity_ids duplicates USING (stable_id)
      GROUP BY raw.stable_id;
    `));
    await this.measured('duplicate-relationship-signatures', () => this.connection.run(`
      CREATE TEMP TABLE duplicate_relationship_signatures AS
      SELECT signature
      FROM raw_relationships
      GROUP BY signature
      HAVING count(*) > 1;
    `));
    await this.measured('merge-relationships', () => this.connection.run(`
      CREATE TEMP TABLE canonical_relationships_export AS
      SELECT raw.signature, raw.from_id, raw.to_id, raw.rel_type, raw.props_json
      FROM raw_relationships raw
      ANTI JOIN duplicate_relationship_signatures duplicates USING (signature)
      UNION ALL
      SELECT raw.signature,
             first(raw.from_id ORDER BY raw.ordinal) AS from_id,
             first(raw.to_id ORDER BY raw.ordinal) AS to_id,
             first(raw.rel_type ORDER BY raw.ordinal) AS rel_type,
             list_reduce(
               list(raw.props_json::JSON ORDER BY raw.ordinal),
               (left_props, right_props) -> json_merge_patch(left_props, right_props)
             )::VARCHAR AS props_json
      FROM raw_relationships raw
      SEMI JOIN duplicate_relationship_signatures duplicates USING (signature)
      GROUP BY raw.signature;
    `));
    await this.measured('attach-provenance', () => this.connection.run(`
      ALTER TABLE canonical_entities_export ADD COLUMN provenance_id VARCHAR;
      UPDATE canonical_entities_export SET provenance_id = (SELECT id FROM extraction_provenance);
      ALTER TABLE canonical_relationships_export ADD COLUMN provenance_id VARCHAR;
      UPDATE canonical_relationships_export SET provenance_id = (SELECT id FROM extraction_provenance);
    `));
    await this.measured('export-provenance', () => this.connection.run(`
      COPY extraction_provenance
      TO '${sqlPath(path.join(this.parquetDir, 'provenance.parquet'))}'
      (FORMAT PARQUET, COMPRESSION ZSTD);
    `));
    await this.measured('export-entities', () => this.connection.run(`
      COPY canonical_entities_export
      TO '${sqlPath(path.join(this.parquetDir, 'nodes.parquet'))}'
      (FORMAT PARQUET, COMPRESSION ZSTD);
    `));
    await this.measured('export-relationships', () => this.connection.run(`
      COPY canonical_relationships_export
      TO '${sqlPath(path.join(this.parquetDir, 'relationships.parquet'))}'
      (FORMAT PARQUET, COMPRESSION ZSTD);
    `));
    await this.measured('stats-cleanup-checkpoint', () => this.connection.run(`
      CREATE TABLE staging_stats AS
      SELECT * FROM (VALUES
        ('rawEntities', (SELECT count(*) FROM raw_entities)),
        ('rawRelationships', (SELECT count(*) FROM raw_relationships)),
        ('canonicalEntities', (SELECT count(*) FROM canonical_entities_export)),
        ('canonicalRelationships', (SELECT count(*) FROM canonical_relationships_export))
      ) stats(name, value);

      DROP TABLE raw_entities;
      DROP TABLE raw_relationships;
      CREATE VIEW canonical_entities AS
        SELECT * FROM read_parquet('${sqlPath(path.join(this.parquetDir, 'nodes.parquet'))}');
      CREATE VIEW canonical_relationships AS
        SELECT * FROM read_parquet('${sqlPath(path.join(this.parquetDir, 'relationships.parquet'))}');
      CHECKPOINT;
    `));

    const result = await this.connection.runAndReadAll('SELECT name, value FROM staging_stats');
    const counts = Object.fromEntries(result.getRows().map(([name, value]) => [String(name), Number(value)])) as StageCounts;
    this.report('complete');
    this.connection.closeSync();
    this.instance.closeSync();
    return counts;
  }

  close() {
    try { this.entityAppender.closeSync(); } catch {}
    try { this.relationshipAppender.closeSync(); } catch {}
    try { this.connection.closeSync(); } catch {}
    try { this.instance.closeSync(); } catch {}
  }
}
