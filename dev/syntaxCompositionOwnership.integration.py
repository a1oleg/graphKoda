"""Compare composition fallback against a completed real extraction inventory."""
import argparse
import json
from pathlib import Path

import duckdb


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--baseline', type=Path, required=True)
parser.add_argument('--report', type=Path, required=True)
args = parser.parse_args()
summary = json.loads((args.report / 'summary.json').read_text(encoding='utf-8-sig'))
plan = json.loads((args.report / 'annotation-plan.json').read_text(encoding='utf-8'))
assert plan['version'] == 13
db = duckdb.connect()
db.execute("SET memory_limit='1GB'")
db.execute('SET threads=1')
db.execute('SET preserve_insertion_order=false')
for name, file in [('old', args.baseline / 'annotation-plan.parquet'),
                   ('new', args.report / 'annotation-plan.parquet'),
                   ('subjects', args.report / 'subjects.parquet'),
                   ('rels', Path(summary['input']) / 'relationships.parquet')]:
    db.read_parquet(str(file)).create_view(name)
assert db.execute('SELECT count(*) FROM old FULL JOIN new USING(stable_id) '
                  'WHERE old.stable_id IS NULL OR new.stable_id IS NULL').fetchone()[0] == 0
db.execute('''CREATE TABLE resolved AS SELECT n.* FROM new n JOIN old o USING(stable_id)
    WHERE n.decision IS DISTINCT FROM o.decision''')
resolved = db.execute('SELECT count(*) FROM resolved').fetchone()[0]
assert resolved > 0
assert db.execute('''SELECT count(*) FROM resolved n JOIN old o USING(stable_id)
    JOIN subjects s USING(stable_id)
    WHERE o.decision<>'review-owner' OR n.decision<>'compose-in-owner'
      OR NOT list_contains(s.labels,'SyntaxPart') OR len(n.context_targets)<>1
      OR list_has_any(s.labels,['Declaration','FunctionImplementation','CallableDeclaration',
        'Fn','FnDeclaration','TypeDeclaration','ValueDeclaration','Parameter',
        'MemberDeclaration','TypeMember','ValueSlot','Reference','ValueReference',
        'MemberReference','TypeReference','ResourceProxy']) OR s.declaration_kind IS NOT NULL
      OR n.scheduled OR NOT n.retain_context''').fetchone()[0] == 0
assert db.execute('''SELECT count(*) FROM resolved n WHERE NOT EXISTS (
    SELECT 1 FROM rels r WHERE r.to_id=n.stable_id AND r.from_id=n.context_targets[1]
      AND r.rel_type='COMPOSES_SYNTAX'
      AND json_extract_string(r.props_json,'$.layer')='syntax-composition'
      AND json_extract_string(r.props_json,'$.field')='renderedExpression')''').fetchone()[0] == 0
assert db.execute('''SELECT count(*) FROM resolved n JOIN rels r
    ON r.from_id=n.stable_id AND r.to_id=n.context_targets[1]
    WHERE r.rel_type='AST_CHILD' AND json_extract_string(r.props_json,'$.field') IS NOT NULL
      AND json_extract_string(r.props_json,'$.projection') IS NULL''').fetchone()[0] == 0
assert db.execute('''SELECT count(*) FROM resolved n JOIN rels r
    ON r.from_id=n.stable_id AND r.to_id=n.context_targets[1]
    WHERE r.rel_type='COMPOSES_SYNTAX'
      AND json_extract_string(r.props_json,'$.layer')='syntax-composition'
      AND json_extract_string(r.props_json,'$.field')='renderedExpression' ''').fetchone()[0] == 0
assert db.execute('''SELECT count(*) FROM old o JOIN new n USING(stable_id)
    WHERE o.required_body_context IS DISTINCT FROM n.required_body_context
      OR o.capture_path IS DISTINCT FROM n.capture_path
      OR o.capture_original IS DISTINCT FROM n.capture_original
      OR n.scheduled''').fetchone()[0] == 0
assert db.execute('''SELECT count(*) FROM old o JOIN new n USING(stable_id)
    WHERE o.owner_status='unique-direct-owner'
      AND (o.context_targets IS DISTINCT FROM n.context_targets
        OR o.immediate_owner_evidence IS DISTINCT FROM n.immediate_owner_evidence)''').fetchone()[0] == 0

# Actual source tokens: the negation has one composition owner, whereas the
# assignment token is shared by a statement and its Step. Never pick one.
negation = 'src/api/gramjs/ChatAbortController.ts:8:8:8:19'
assignment = 'src/api/gramjs/ChatAbortController.ts:9:17:9:18'
assert db.execute('SELECT decision,context_targets FROM new WHERE stable_id=?',
                  [negation]).fetchone() == ('compose-in-owner', ['flow-step:condition:' + negation])
row = db.execute('SELECT decision,owner_status,context_targets FROM new WHERE stable_id=?',
                 [assignment]).fetchone()
assert row[0] == 'review-owner' and row[1] == 'conflicting-direct-owners' and len(row[2]) == 2, row
await_expression = 'src/api/gramjs/methods/messages.ts:544:12:544:76'
await_call = 'src/api/gramjs/methods/messages.ts:544:18:544:76'
assert db.execute('SELECT decision FROM new WHERE stable_id=?',
                  [await_expression]).fetchone()[0] == 'review-owner'
assert db.execute('SELECT context_targets FROM new WHERE stable_id=?',
                  [await_call]).fetchone()[0] == [await_expression]
reciprocal = ['src/global/actions/api/bots.ts:1586:12:1590:6',
              'src/global/actions/api/bots.ts:1586:6:1590:6']
for stable_id in reciprocal:
    assert db.execute('SELECT decision,owner_status FROM new WHERE stable_id=?',
                      [stable_id]).fetchone() == ('review-owner', 'invalid-direct-owner-target')
print(json.dumps({'ok': True, 'resolvedSyntaxParts': resolved,
                  'strongerOwnersUnchanged': True, 'ambiguousCompositionPreserved': True,
                  'bodyAndCaptureContextRetained': True, 'astDirectionPreserved': True,
                  'scheduledTasks': 0}))
