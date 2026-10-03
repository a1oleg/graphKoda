"""Regression checks against the actual Telegram inventory, not synthetic nodes."""
import argparse
import json
from pathlib import Path

import duckdb

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--report', type=Path, required=True)
parser.add_argument('--previous-report', type=Path)
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
assert summary['version'] == 5
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
assert db.execute("SELECT decision FROM plan WHERE stable_id='src/api/gramjs/apiBuilders/chats.ts:404:28:409:4'").fetchone()[0] == 'generation-candidate'
assert db.execute("SELECT count(*) FROM plan WHERE decision='compose-in-owner' AND len(context_targets)<>1").fetchone()[0] == 0
assert db.execute("SELECT count(*) FROM plan WHERE decision='compose-in-owner' AND immediate_owner_evidence IS NULL").fetchone()[0] == 0
assert db.execute("SELECT decision FROM plan WHERE stable_id='src/lib/gramjs/Utils.ts:10:0:12:1'").fetchone()[0] == 'blocked-missing-step-target'
for stable_id, owner in [
    ('C:/GitHub/telegram-tt/src/api/gramjs/ChatAbortController.ts:11:5:11:5',
     'src/api/gramjs/ChatAbortController.ts:6:2:13:3'),
    ('C:/GitHub/telegram-tt/src/lib/vibecalls/sdp/buildSdp.ts:150:7:150:12:horizontal-owner-src/lib/vibecalls/sdp/buildSdp.ts-28-15-188-1',
     'flow-block:alternative:false:src/lib/vibecalls/sdp/buildSdp.ts:140:11:151:5'),
    ('src/components/App.tsx:258:14:258:25','src/components/App.tsx:258:4:258:46:jsx-props'),
    ('src/components/App.tsx:258:4:258:46:jsx-props','src/components/App.tsx:258:4:258:46'),
    ('src/components/right/management/ManageChatRemovedUsers.tsx:86:9:86:31',
     'src/components/right/management/ManageChatRemovedUsers.tsx:86:4:86:32:jsx-props'),
    ('C:/GitHub/telegram-tt/src/api/gramjs/ChatAbortController.ts:18:3:18:4:end',
     'src/api/gramjs/ChatAbortController.ts:15:2:18:3'),
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
assert plan_summary['version'] == 14
for captured, predecessor, original in [
    ('src/api/gramjs/ChatAbortController.ts:20:15:20:30:captured-in:src/api/gramjs/ChatAbortController.ts:22:25:22:65',
     'src/api/gramjs/ChatAbortController.ts:20:15:20:30', 'src/api/gramjs/ChatAbortController.ts:20:15:20:30'),
    ('src/lib/vibecalls/group/groupCall.ts:254:8:254:17:captured-in:src/lib/vibecalls/group/groupCall.ts:272:27:287:5',
     'src/lib/vibecalls/group/groupCall.ts:254:8:254:17:captured-in:src/lib/vibecalls/group/groupCall.ts:260:38:294:3',
     'src/lib/vibecalls/group/groupCall.ts:254:8:254:17'),
]:
    actual = db.execute('SELECT decision,context_targets,capture_original FROM plan WHERE stable_id=?',[captured]).fetchone()
    assert actual == ('follow-original',[predecessor],original),actual
db.read_parquet(str(Path(summary['input'])/'nodes.parquet')).create_view('raw_nodes')
db.read_parquet(str(Path(summary['input'])/'relationships.parquet')).create_view('raw_rels')
if args.previous_report:
    previous_summary = json.loads((args.previous_report/'annotation-plan.json').read_text(encoding='utf-8'))
    assert previous_summary['version'] == 9
    assert previous_summary['provenanceIds'] == plan_summary['provenanceIds']
    db.read_parquet(str(args.previous_report/'annotation-plan.parquet')).create_view('previous_plan')
    assert db.execute('''SELECT count(*) FROM previous_plan old FULL JOIN plan p USING(stable_id)
        WHERE old.stable_id IS NULL OR p.stable_id IS NULL''').fetchone()[0] == 0
    assert db.execute('''SELECT count(*) FROM previous_plan old JOIN plan p USING(stable_id)
        JOIN raw_nodes n USING(stable_id) JOIN subjects s USING(stable_id)
        WHERE (old.decision IS DISTINCT FROM p.decision
          OR old.context_targets IS DISTINCT FROM p.context_targets)
        AND NOT coalesce(list_contains(n.labels,'Join')
          AND json_extract_string(n.props_json,'$.operation_code')='FLOW_JOIN'
          AND json_extract_string(n.props_json,'$.join_kind')='flow'
          AND json_extract_string(n.props_json,'$.synthetic')='true',false)
        AND NOT (old.decision='review-callback' AND p.decision='generation-candidate'
          AND list_contains(s.labels,'CallbackImplementation') AND s.body_count>0
          AND old.context_targets=p.context_targets)''').fetchone()[0] == 0
    print('Verified baseline comparison: only technical joins and confirmed callback decisions changed.')
assert db.execute('''SELECT count(*) FROM plan p, unnest(p.immediate_owner_evidence) e(item)
    WHERE item.field='argument-object-property' AND NOT EXISTS (
      SELECT 1 FROM raw_rels direct JOIN raw_rels argument ON argument.to_id=direct.from_id
        AND argument.rel_type='HAS_ARGUMENT'
      JOIN raw_rels ancestor ON ancestor.from_id=argument.from_id AND ancestor.to_id=direct.to_id
        AND ancestor.rel_type='HAS_PROPERTY'
      WHERE direct.rel_type='HAS_PROPERTY' AND direct.from_id=item.target AND direct.to_id=p.stable_id
    )''').fetchone()[0] == 0
capture_edges = set(db.execute("SELECT to_id,from_id FROM raw_rels WHERE rel_type='CAPTURES_VALUE'").fetchall())
for stable_id, targets, original, path in db.execute('''SELECT stable_id,context_targets,capture_original,capture_path
    FROM plan WHERE evidence_reason='explicit-capture-chain' ''').fetchall():
    assert path[0]==stable_id and len(path)==len(set(path)) and original not in path
    chain = path + [original]
    assert targets==[chain[1]]
    assert all((a,b) in capture_edges for a,b in zip(chain,chain[1:]))
assert db.execute('''SELECT count(*) FROM plan p JOIN raw_nodes n USING(stable_id)
    JOIN subjects owner ON owner.stable_id=p.context_targets[1]
    WHERE p.decision='compose-in-owner' AND list_has_any(n.labels,['FunctionStart','FunctionEnd'])
      AND EXISTS (SELECT 1 FROM unnest(p.immediate_owner_evidence) e(item) WHERE item.tier>=3)
      AND (NOT list_has_any(owner.labels,['Fn','FnDeclaration','CallableDeclaration'])
        OR owner.stable_id<>coalesce(nullif(json_extract_string(n.props_json,'$.parentLocalFunctionStableId'),''),
          json_extract_string(n.props_json,'$.parentFnStableId')))''').fetchone()[0] == 0
assert sum(group['count'] for group in plan_summary['ownerReview']) == plan_summary['counts']['review-owner']
print('Verified actual Telegram class, methods, alias, system type, global totals and inline ownership.')
