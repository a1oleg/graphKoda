"""Regression checks against the actual Telegram inventory, not synthetic nodes."""
import argparse
import json
from pathlib import Path

import duckdb

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--report', type=Path, required=True)
args = parser.parse_args()
summary = json.loads((args.report / 'summary.json').read_text(encoding='utf-8'))
db = duckdb.connect()
db.read_parquet(str(args.report / 'subjects.parquet')).create_view('subjects')
assert db.execute('SELECT count(*),count(DISTINCT stable_id) FROM subjects').fetchone() == (summary['nodes'], summary['nodes'])
assert dict(db.execute('SELECT mode,count(*) FROM subjects GROUP BY mode').fetchall()) == summary['counts']
expected = {
    'src/api/gramjs/ChatAbortController.ts:3:0:25:1': ('standalone', 'declared-contract-with-structure'),
    'src/api/gramjs/ChatAbortController.ts:6:2:13:3': ('standalone', 'callable-with-body'),
    'src/api/gramjs/ChatAbortController.ts:15:2:18:3': ('unresolved', 'callable-body-not-confirmed'),
    'src/api/gramjs/ChatAbortController.ts:20:2:24:3': ('unresolved', 'callable-body-not-confirmed'),
    'src/api/gramjs/ChatAbortController.ts:15:50:15:56': ('inline', 'owned-system-syntax'),
    'src/api/gramjs/ChatAbortController.ts:1:14:1:22': ('reference', 'resolved-alias'),
}
for stable_id, classification in expected.items():
    actual = db.execute('SELECT mode,reason FROM subjects WHERE stable_id=?', [stable_id]).fetchone()
    assert actual == classification, (stable_id, actual, classification)
assert db.execute("SELECT count(*) FROM subjects WHERE mode='standalone' AND declaration_kind IN ('UnionType','ArrayType','IntersectionType')").fetchone()[0] == 0
assert db.execute("SELECT count(*) FROM subjects WHERE mode='inline' AND len(owners)=0").fetchone()[0] == 0
print('Verified actual Telegram class, methods, alias, system type, global totals and inline ownership.')
