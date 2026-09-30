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
    'src/api/gramjs/ChatAbortController.ts:15:2:18:3': ('standalone', 'callable-with-body'),
    'src/api/gramjs/ChatAbortController.ts:20:2:24:3': ('standalone', 'callable-with-body'),
    'src/api/gramjs/ChatAbortController.ts:15:50:15:56': ('inline', 'owned-system-syntax'),
    'src/api/gramjs/ChatAbortController.ts:1:14:1:22': ('reference', 'resolved-alias'),
}
for stable_id, classification in expected.items():
    actual = db.execute('SELECT mode,reason FROM subjects WHERE stable_id=?', [stable_id]).fetchone()
    assert actual == classification, (stable_id, actual, classification)
assert db.execute("SELECT count(*) FROM subjects WHERE mode='standalone' AND declaration_kind IN ('UnionType','ArrayType','IntersectionType')").fetchone()[0] == 0
assert db.execute("SELECT count(*) FROM subjects WHERE mode='inline' AND len(owners)=0").fetchone()[0] == 0
assert summary['version'] == 4
assert db.execute('SELECT count(*) FROM subjects WHERE body_count<>len(body_targets)').fetchone()[0] == 0
body = db.execute('SELECT body_targets,body_evidence FROM subjects WHERE stable_id=?',
    ['src/api/gramjs/ChatAbortController.ts:15:2:18:3']).fetchone()
assert 'src/api/gramjs/ChatAbortController.ts:17:4:17:33' in body[0]
assert 'ENCLOSED_BY:lexical-function-owner' in body[1]
audit = json.loads((args.report/'body-audit.json').read_text(encoding='utf-8'))
assert sum(audit['counts'].values()) == audit['nodes']
by_id = {row['stable_id']:row for row in audit['subjects']}
assert len(by_id) == audit['nodes']
assert by_id['src/components/calls/phone/PhoneCallButton.tsx:24:6:47:1']['auditCategory'] == 'binding-to-confirmed-implementation'
assert by_id['src/api/gramjs/apiBuilders/messages.ts:97:7:99:1']['auditCategory'] == 'body-confirmed-through-entry'
assert by_id['src/api/gramjs/updates/UpdatePts.ts:2:2:2:61']['auditCategory'] == 'empty-body-with-parameter-properties'
missing = by_id['src/lib/gramjs/Utils.ts:10:0:12:1']
assert missing['auditCategory'] == 'body-confirmed-through-entry'
assert any(not step['entryExists'] for step in missing['ownedSteps'])
assert by_id['src/util/forceReflow.ts:2:15:5:1']['auditCategory'] == 'body-confirmed-through-entry'
print('Verified actual Telegram class, methods, alias, system type, global totals and inline ownership.')
