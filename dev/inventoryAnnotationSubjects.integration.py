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
db.read_parquet(str(args.report/'annotation-plan.parquet')).create_view('plan')
assert db.execute('SELECT count(*),count(DISTINCT stable_id) FROM plan').fetchone() == (summary['nodes'],summary['nodes'])
assert db.execute("SELECT count(*) FROM plan WHERE scheduled OR NOT retain_context").fetchone()[0] == 0
assert db.execute("SELECT decision FROM plan WHERE stable_id='src/components/calls/phone/PhoneCallButton.tsx:24:6:47:1'").fetchone()[0] == 'follow-original'
callback = db.execute("SELECT decision,context_targets,required_body_context FROM plan WHERE stable_id='src/api/gramjs/ChatAbortController.ts:22:25:22:65'").fetchone()
assert callback == ('compose-in-owner', ['src/api/gramjs/ChatAbortController.ts:22:4:22:66'],
    ['src/api/gramjs/ChatAbortController.ts:22:41:22:65']), callback
assert db.execute("SELECT decision FROM plan WHERE stable_id='src/api/gramjs/apiBuilders/chats.ts:404:28:409:4'").fetchone()[0] == 'review-callback'
assert db.execute("SELECT count(*) FROM plan WHERE decision='compose-in-owner' AND len(context_targets)<>1").fetchone()[0] == 0
assert db.execute("SELECT count(*) FROM plan WHERE decision='compose-in-owner' AND immediate_owner_evidence IS NULL").fetchone()[0] == 0
assert db.execute("SELECT decision FROM plan WHERE stable_id='src/lib/gramjs/Utils.ts:10:0:12:1'").fetchone()[0] == 'blocked-missing-step-target'
for stable_id, owner in [
    ('C:/GitHub/telegram-tt/src/api/gramjs/ChatAbortController.ts:10:23:10:31:arg0:horizontal-owner-src/api/gramjs/ChatAbortController.ts-6-2-13-3',
     'flow-step:execution:src/api/gramjs/ChatAbortController.ts:10:6:10:45'),
    ('src/components/common/helpers/gifts.ts:19:2:19:36', 'src/components/common/helpers/gifts.ts:18:0:23:2'),
    ('src/api/gramjs/apiBuilders/appConfig.ts:152:26:165:8', 'src/api/gramjs/apiBuilders/appConfig.ts:152:9:165:13'),
    ('flow-step:statement:src/util/notifications.tsx:335:2:335:45', 'src/util/notifications.tsx:333:0:369:1'),
    ('flow-block:alternative:false:src/api/gramjs/apiBuilders/pathBytesToSvg.ts:19:11:26:5',
     'flow-block:side:next:src/api/gramjs/apiBuilders/pathBytesToSvg.ts:15:2:27:3'),
    ('flow-block:alternative:false:src/lib/vibecalls/sdp/buildSdp.ts:140:11:151:5',
     'src/lib/vibecalls/sdp/buildSdp.ts:110:8:110:20'),
    ('flow-step:condition:src/components/left/main/Chat.tsx:321:10:321:26',
     'src/components/left/main/Chat.tsx:291:40:337:3'),
]:
    actual = db.execute('SELECT decision,context_targets FROM plan WHERE stable_id=?', [stable_id]).fetchone()
    assert actual == ('compose-in-owner', [owner]), (stable_id, actual)
assert db.execute("SELECT count(*) FROM plan WHERE owner_status='invalid-direct-owner-target' AND decision='compose-in-owner'").fetchone()[0] == 0
for stable_id in [
    'flow-step:execution:src/components/left/LeftColumn.tsx:377:10:377:16',
    'flow-step:execution:src/util/deeplink.ts:125:8:125:14',
]:
    assert db.execute('SELECT decision,owner_status FROM plan WHERE stable_id=?', [stable_id]).fetchone() == (
        'review-owner', 'invalid-direct-owner-target')
assert db.execute("SELECT owner_status FROM plan WHERE stable_id='flow-block:alternative:false:src/components/modals/gift/craft/GiftCraftModal.tsx:790:15:793:9'").fetchone()[0] == 'conflicting-direct-owners'
assert db.execute("SELECT count(*) FROM plan WHERE decision='compose-in-owner' AND owner_status<>'unique-direct-owner'").fetchone()[0] == 0
plan_summary = json.loads((args.report/'annotation-plan.json').read_text(encoding='utf-8'))
assert sum(group['count'] for group in plan_summary['ownerReview']) == plan_summary['counts']['review-owner']
print('Verified actual Telegram class, methods, alias, system type, global totals and inline ownership.')
