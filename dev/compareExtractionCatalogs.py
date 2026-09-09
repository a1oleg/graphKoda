"""Compare complete code catalogs without reading or modifying Neo4j."""
import argparse
import json
from pathlib import Path

import duckdb

parser = argparse.ArgumentParser()
parser.add_argument('before', type=Path)
parser.add_argument('after', type=Path)
parser.add_argument('--ignore-source-state', action='store_true',
                    help='Ignore only source_state_id, which identifies the changed tool worktree.')
args = parser.parse_args()
connection = duckdb.connect()
connection.execute("SET memory_limit='2GB'")
connection.execute('SET threads=2')
report = {}
try:
    for filename, columns in (
        ('nodes.parquet', 'stable_id, list_sort(labels) AS labels, props_json'),
        ('relationships.parquet', 'signature, from_id, to_id, rel_type, props_json'),
    ):
        for name, directory in (('before_catalog', args.before), ('after_catalog', args.after)):
            projection = columns
            if args.ignore_source_state:
                projection = projection.replace('props_json',
                    '''json_merge_patch(props_json::JSON, '{"source_state_id":null}')::VARCHAR AS props_json''')
            connection.read_parquet(str(directory / filename)).project(projection).create_view(name, replace=True)
        row = {}
        for left, right in (('before_catalog', 'after_catalog'), ('after_catalog', 'before_catalog')):
            row[left] = connection.execute(f'SELECT count(*) FROM {left}').fetchone()[0]
            row[f'{left}_only'] = connection.execute(
                f'SELECT count(*) FROM (SELECT * FROM {left} EXCEPT ALL SELECT * FROM {right})'
            ).fetchone()[0]
        report[filename] = row
    print(json.dumps(report, indent=2))
    if any(row['before_catalog_only'] or row['after_catalog_only'] for row in report.values()):
        raise SystemExit(1)
finally:
    connection.close()
