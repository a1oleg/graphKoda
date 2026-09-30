"""Bounded, parameterized reads of annotation eligibility evidence."""
import argparse
import json
from pathlib import Path
import duckdb

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--report', type=Path, required=True)
parser.add_argument('--stable-id')
parser.add_argument('--mode', choices=['standalone', 'inline', 'reference', 'unresolved'])
parser.add_argument('--limit', type=int, default=50)
parser.add_argument('--offset', type=int, default=0)
args = parser.parse_args()
if not 1 <= args.limit <= 200 or args.offset < 0:
    parser.error('limit must be 1..200; offset must be nonnegative')
db = duckdb.connect()
db.execute("SET memory_limit='512MB'")
db.execute('SET threads=1')
db.read_parquet(str(args.report / 'subjects.parquet')).create_view('subjects')
where, params = [], []
for column, value in [('stable_id', args.stable_id), ('mode', args.mode)]:
    if value is not None:
        where.append(f'{column}=?')
        params.append(value)
condition = ' WHERE ' + ' AND '.join(where) if where else ''
total = db.execute('SELECT count(*) FROM subjects' + condition, params).fetchone()[0]
result = db.execute('SELECT * FROM subjects' + condition + ' ORDER BY stable_id LIMIT ? OFFSET ?',
                    params + [args.limit, args.offset])
columns = [item[0] for item in result.description]
subjects = [dict(zip(columns, row)) for row in result.fetchall()]
audit_path = args.report / 'body-audit.json'
if audit_path.exists():
    audit = json.loads(audit_path.read_text(encoding='utf-8'))
    details = {row['stable_id']: row for row in audit['subjects']}
    for subject in subjects:
        if subject['stable_id'] in details:
            subject['bodyAudit'] = details[subject['stable_id']]
print(json.dumps({'total': total, 'limit': args.limit, 'offset': args.offset,
    'subjects': subjects}, ensure_ascii=False))
db.close()
