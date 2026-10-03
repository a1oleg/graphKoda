"""Read and verify actual extraction artifacts without writing Neo4j."""
import argparse
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import time

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'graph/static-extract/py'))
from function_flow_catalog import FunctionFlowCatalog

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--run', type=Path, required=True)
parser.add_argument('--baseline', type=Path, required=True)
args = parser.parse_args()
started = time.perf_counter()
catalog = FunctionFlowCatalog(args.run/'stage.duckdb', args.run/'parquet')
timings = {}
try:
    counts = catalog.counts()
    for kind, iterator, expected in [
        ('entities', catalog.iter_entities(100000), counts['canonicalEntities']),
        ('relationships', catalog.iter_relationships(100000), counts['canonicalRelationships']),
    ]:
        wall, cpu = time.perf_counter(), time.process_time()
        total = batches = 0
        for batch in iterator:
            total += len(batch)
            batches += 1
        assert total == expected
        timings[kind] = {'rows': total, 'batches': batches,
                         'seconds': time.perf_counter()-wall,
                         'cpuSeconds': time.process_time()-cpu}
finally:
    catalog.close()

with TemporaryDirectory(prefix='catalog-profile-') as spill:
    db = duckdb.connect(config={'temp_directory': spill})
    db.execute("SET memory_limit='1GB'")
    db.execute('SET threads=1')
    db.execute('SET preserve_insertion_order=false')
    for name, file in [('nodes', args.run/'parquet/nodes.parquet'),
                       ('rels', args.run/'parquet/relationships.parquet'),
                       ('old_nodes', args.baseline/'nodes.parquet'),
                       ('old_rels', args.baseline/'relationships.parquet')]:
        db.read_parquet(str(file)).create_view(name)
    missing_nodes = db.execute('SELECT count(*) FROM old_nodes ANTI JOIN nodes USING(stable_id)').fetchone()[0]
    missing_edges = db.execute('SELECT count(*) FROM old_rels ANTI JOIN rels USING(signature)').fetchone()[0]
    duplicates = db.execute('SELECT count(*)-count(DISTINCT stable_id) FROM nodes').fetchone()[0]
    missing_ends = db.execute('''SELECT count(*) FROM rels r LEFT JOIN nodes a ON a.stable_id=r.from_id
        LEFT JOIN nodes b ON b.stable_id=r.to_id WHERE a.stable_id IS NULL OR b.stable_id IS NULL''').fetchone()[0]
    assert missing_nodes == missing_edges == duplicates == missing_ends == 0
    added_nodes = db.execute('''SELECT labels,count(*) FROM nodes ANTI JOIN old_nodes USING(stable_id)
        GROUP BY labels''').fetchall()
    added_edges = db.execute('''SELECT rel_type,count(*) FROM rels ANTI JOIN old_rels USING(signature)
        GROUP BY rel_type''').fetchall()
    report = {'ok': True, 'run': str(args.run), 'baseline': str(args.baseline),
              'catalogRead': timings, 'missingPreviousNodes': missing_nodes,
              'missingPreviousRelationships': missing_edges, 'duplicateStableIds': duplicates,
              'missingEndpoints': missing_ends, 'addedNodes': added_nodes, 'addedRelationships': added_edges,
              'writesNeo4j': False, 'generatesAnnotations': False,
              'elapsedSeconds': time.perf_counter()-started,
              'limitations': ['Read timings exclude Bolt serialization and Neo4j writes.',
                              'Identity preservation is not a full semantic equivalence proof.']}
    db.close()
(args.run/'catalog-profile.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(report, ensure_ascii=False))
