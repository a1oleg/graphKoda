"""Compare actual extracted graph identities, labels and properties, excluding provenance only."""
import argparse
import json
from pathlib import Path
from tempfile import TemporaryDirectory

import duckdb

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--baseline', type=Path, required=True)
parser.add_argument('--candidate', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
report = {'baseline': str(args.baseline), 'candidate': str(args.candidate),
          'excludedColumns': ['provenance_id'], 'tables': {}}
with TemporaryDirectory(prefix='artifact-compare-') as spill:
    db = duckdb.connect(config={'temp_directory': spill, 'memory_limit': '1GB', 'threads': '1'})
    for name, filename, key, columns in [
        ('entities', 'nodes.parquet', 'stable_id', ['labels']),
        ('relationships', 'relationships.parquet', 'signature', ['from_id', 'to_id', 'rel_type']),
    ]:
        for view, directory in [('baseline', args.baseline), ('candidate', args.candidate)]:
            db.read_parquet(str(directory / filename)).create_view(view, replace=True)
        duplicates = [db.execute(f'SELECT count(*)-count(DISTINCT {key}) FROM {view}').fetchone()[0]
                      for view in ['baseline', 'candidate']]
        missing = db.execute(f'SELECT count(*) FROM baseline ANTI JOIN candidate USING({key})').fetchone()[0]
        added = db.execute(f'SELECT count(*) FROM candidate ANTI JOIN baseline USING({key})').fetchone()[0]
        fields = ','.join(f'b.{column},c.{column}' for column in columns)
        cursor = db.execute(f'SELECT b.{key},{fields},b.props_json,c.props_json '
                            f'FROM baseline b JOIN candidate c USING({key})')
        changed = compared = 0
        examples = []
        while batch := cursor.fetchmany(10000):
            for row in batch:
                compared += 1
                same = json.loads(row[-2]) == json.loads(row[-1])
                for index, column in enumerate(columns):
                    left, right = row[1 + index * 2:3 + index * 2]
                    same = same and (sorted(left) == sorted(right) if column == 'labels' else left == right)
                if not same:
                    changed += 1
                    if len(examples) < 10:
                        examples.append(row[0])
        report['tables'][name] = {'compared': compared, 'missing': missing, 'added': added,
                                 'duplicates': duplicates, 'changed': changed, 'examples': examples}
    db.close()
report['ok'] = all(not row['missing'] and not row['added'] and not row['changed']
                   and not any(row['duplicates']) for row in report['tables'].values())
with args.output.open('x', encoding='utf-8') as output:
    json.dump(report, output, ensure_ascii=False, indent=2)
print(json.dumps(report, ensure_ascii=False))
if not report['ok']:
    raise SystemExit(1)
