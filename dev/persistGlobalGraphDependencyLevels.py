"""Persist a verified global-level snapshot to local Neo4j without reimport."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import time
from urllib.parse import urlparse
import uuid

import duckdb
from dotenv import load_dotenv
from neo4j import GraphDatabase
import pyarrow as pa


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--env', type=Path, default=Path(__file__).resolve().parents[1] / 'graph/.env')
    parser.add_argument('--batch-size', type=int, default=5000)
    args = parser.parse_args()
    if args.batch_size <= 0:
        raise ValueError('Positive batch size required')
    summary = json.loads((args.report / 'summary.json').read_text(encoding='utf-8'))
    if summary.get('version') != 3 or summary.get('mode') != 'global-materialized-dependency-inventory':
        raise ValueError('Expected dependency inventory version 3')
    policy_hash = hashlib.sha256(json.dumps(summary['policy'], sort_keys=True).encode()).hexdigest()
    if policy_hash != summary['policyHash']:
        raise ValueError('Dependency policy checksum mismatch')
    levels_path = args.report / 'levels.parquet'
    with levels_path.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    load_dotenv(args.env)
    uri = os.environ['NEO4J_URI']
    if urlparse(uri).hostname not in {'localhost', '127.0.0.1', '::1'}:
        raise ValueError('This command only supports local Neo4j')
    database = os.getenv('NEO4J_DATABASE') or os.getenv('NEO4J_DB') or 'neo4j'
    driver = GraphDatabase.driver(uri, auth=(os.getenv('NEO4J_USER') or os.environ['NEO4J_USERNAME'], os.environ['NEO4J_PASSWORD']))
    db = duckdb.connect()
    db.execute("SET memory_limit='1GB'")
    db.execute('SET threads=2')
    db.execute('SET preserve_insertion_order=false')
    db.read_parquet(str(levels_path)).create_view('levels')
    stats = db.execute('''SELECT count(*), count(DISTINCT stable_id),
        count(*) FILTER(WHERE structural_level>=0), count(*) FILTER(WHERE in_cycle),
        count(*) FILTER(WHERE unknown_dependency_semantics), max(structural_level)
        FROM levels''').fetchone()
    expected = (summary['nodes'], summary['nodes'], summary['structurallyLeveled'],
                summary['nodesInCycles'], summary['unknownIncludingConsumers'], max(map(int, summary['levels'])))
    if stats != expected:
        raise ValueError(f'Parquet does not match summary: {stats} != {expected}')
    invalid = db.execute('''SELECT count(*) FROM levels WHERE stable_id IS NULL
        OR component IS NULL OR structural_level IS NULL OR in_cycle IS NULL
        OR component_level IS NULL OR component_level<0
        OR (structural_level>=0 AND structural_level<>component_level)
        OR dependency_status IS NULL OR code_recursion_confirmed IS DISTINCT FROM false
        OR (in_cycle AND structural_level>=0)
        OR dependency_status <> CASE WHEN in_cycle THEN 'cyclic-dependency'
            WHEN structural_level<0 THEN 'depends-on-cycle' ELSE 'acyclic' END''').fetchone()[0]
    if invalid:
        raise ValueError(f'Invalid level records: {invalid}')
    groups = db.execute('''SELECT component, min(component_level), max(component_level)
        FROM levels GROUP BY component''').fetchall()
    if len(groups) != summary['components'] or any(low != high for _, low, high in groups):
        raise ValueError('Component level consistency failed')
    expected_groups = {component: low for component, low, _ in groups}
    if max(expected_groups.values(), default=0) != summary['maxComponentLevel']:
        raise ValueError('Component maximum differs from summary')
    run_id = str(uuid.uuid4())
    created = False
    started = time.perf_counter()
    try:
        with driver.session(database=database, fetch_size=10000) as session:
            # One scan; subsequent writes address element IDs, avoiding repeated
            # full scans on stableId across heterogeneous node labels.
            columns = {key: [] for key in ('stable_id', 'element_id', 'provenance_id')}
            for row in session.run('''MATCH (n) WHERE n.stableId IS NOT NULL
                RETURN n.stableId AS stable_id, elementId(n) AS element_id,
                       n.provenance_id AS provenance_id'''):
                for key in columns:
                    columns[key].append(row[key])
            db.register('snapshot_arrow', pa.table(columns))
            db.execute('CREATE TABLE snapshot AS SELECT * FROM snapshot_arrow')
            db.unregister('snapshot_arrow')
            del columns
            counts = db.execute('SELECT count(*), count(DISTINCT stable_id) FROM snapshot').fetchone()
            if counts != (summary['nodes'], summary['nodes']):
                raise ValueError(f'Neo4j node count/identity mismatch: {counts}')
            provenances = [r[0] for r in db.execute('SELECT DISTINCT provenance_id FROM snapshot').fetchall()]
            if set(provenances) != set(summary['provenanceIds']):
                raise ValueError('Neo4j extraction provenance differs from report')
            if db.execute('SELECT count(*) FROM levels ANTI JOIN snapshot USING(stable_id)').fetchone()[0]:
                raise ValueError('Report contains missing Neo4j stable IDs')
            relationships = session.run('''MATCH ()-[r]->()
                WHERE r.provenance_id IN $ids RETURN count(*) AS count''', ids=provenances).single()['count']
            if relationships != summary['relationships']:
                raise ValueError(f'Neo4j relationship count mismatch: {relationships}')
            print(json.dumps({'phase': 'preflight-ok', 'nodes': counts[0], 'relationships': relationships}), flush=True)
            session.run('''CREATE (r:DependencyLevelRun {runId: $id})
                SET r.status='writing', r.createdAt=datetime(), r.version=$version,
                    r.policyHash=$policyHash, r.policyJson=$policyJson,
                    r.provenanceIds=$provenances, r.levelsSha256=$digest,
                    r.annotationProfilesCertified=false, r.expectedNodes=$count,
                    r.componentLevelRule=$componentRule,
                    r.sourceReport=$source''', id=run_id, version=summary['version'],
                policyHash=policy_hash, policyJson=json.dumps(summary['policy']),
                provenances=provenances, digest=digest, count=counts[0], source=str(args.report.resolve()),
                componentRule=summary['componentLevelRule']).consume()
            created = True
            cursor = db.execute('''SELECT element_id, stable_id, provenance_id,
                structural_level, component, dependency_status, unknown_dependency_semantics, component_level
                FROM levels JOIN snapshot USING(stable_id)''')
            written = 0
            while batch := cursor.fetchmany(args.batch_size):
                rows = [dict(zip(('elementId','stableId','provenance','level','component','status','unknown','componentLevel'), row)) for row in batch]
                def write(tx):
                    result = tx.run('''UNWIND $rows AS row
                        MATCH (n) WHERE elementId(n)=row.elementId
                            AND n.stableId=row.stableId AND n.provenance_id=row.provenance
                        SET n.dependencyStructuralLevel=CASE WHEN row.level>=0 THEN row.level ELSE null END,
                            n.dependencyComponent=row.component,
                            n.dependencyComponentLevel=row.componentLevel,
                            n.dependencyStatus=row.status,
                            n.dependencySemanticsUnknown=row.unknown,
                            n.dependencyLevelRunId=$id
                        RETURN count(n) AS count''', rows=rows, id=run_id).single()['count']
                    if result != len(rows):
                        raise ValueError('Graph changed during write; rolling back batch')
                    return result
                written += session.execute_write(write)
                if written % 100000 == 0 or written == summary['nodes']:
                    print(json.dumps({'phase': 'write', 'written': written, 'total': summary['nodes']}), flush=True)
            actual = session.run('''MATCH (n) WHERE n.dependencyLevelRunId=$id
                RETURN count(n) AS nodes, count(n.dependencyStructuralLevel) AS leveled,
                    count(CASE WHEN n.dependencyStatus='cyclic-dependency' THEN 1 END) AS cyclic,
                    count(CASE WHEN n.dependencySemanticsUnknown THEN 1 END) AS unknown,
                    max(n.dependencyStructuralLevel) AS maximum''', id=run_id).single().data()
            if tuple(actual[key] for key in ('nodes','leveled','cyclic','unknown','maximum')) != (expected[0], expected[2], expected[3], expected[4], expected[5]):
                raise ValueError(f'Post-write verification failed: {actual}')
            verified_groups = 0
            for row in session.run('''MATCH (n) WHERE n.dependencyLevelRunId=$id
                RETURN n.dependencyComponent AS component,
                    min(n.dependencyComponentLevel) AS low, max(n.dependencyComponentLevel) AS high,
                    count(n) AS nodes, count(n.dependencyComponentLevel) AS leveled''', id=run_id):
                if (row['component'] not in expected_groups or row['nodes'] != row['leveled']
                    or row['low'] != expected_groups[row['component']] or row['high'] != row['low']):
                    raise ValueError('Stored component levels differ from report')
                verified_groups += 1
            if verified_groups != len(expected_groups):
                raise ValueError('Stored component count differs from report')
            actual['verifiedComponents'] = verified_groups
            actual['maxComponentLevel'] = summary['maxComponentLevel']
            session.run('''MATCH (r:DependencyLevelRun {runId:$id})
                SET r.status='complete', r.completedAt=datetime(), r.writtenNodes=$written,
                    r.elapsedSeconds=$elapsed''', id=run_id, written=written,
                elapsed=time.perf_counter()-started).consume()
            print(json.dumps({'phase': 'verified', 'runId': run_id, **actual,
                              'elapsedSeconds': round(time.perf_counter()-started, 2)}), flush=True)
    except Exception as error:
        if created:
            with driver.session(database=database) as session:
                session.run('''MATCH (r:DependencyLevelRun {runId:$id})
                    SET r.status='failed', r.error=$error''', id=run_id, error=str(error)).consume()
        raise
    finally:
        driver.close()
        db.close()


if __name__ == '__main__':
    main()
