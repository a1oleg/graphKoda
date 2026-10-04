"""Validate ancestor elimination using completed real extraction plans."""
import argparse
import json
from pathlib import Path
from tempfile import TemporaryDirectory

import duckdb

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--baseline', type=Path, required=True)
parser.add_argument('--report', type=Path, required=True)
args = parser.parse_args()
summary = json.loads((args.report/'summary.json').read_text(encoding='utf-8'))
assert json.loads((args.report/'annotation-plan.json').read_text(encoding='utf-8'))['version'] == 15
with TemporaryDirectory(prefix='composition-owner-test-') as spill:
    db = duckdb.connect(config={'temp_directory': spill, 'memory_limit': '1GB', 'threads': 1})
    for name, file in [('old', args.baseline/'annotation-plan.parquet'),
                       ('new', args.report/'annotation-plan.parquet'),
                       ('rels', Path(summary['input'])/'relationships.parquet')]:
        db.read_parquet(str(file)).create_view(name)
    assert db.execute('''SELECT count(*) FROM old FULL JOIN new USING(stable_id)
        WHERE old.stable_id IS NULL OR new.stable_id IS NULL''').fetchone()[0] == 0
    db.execute('''CREATE TABLE changed AS SELECT n.stable_id,n.decision,n.context_targets,
        o.decision AS previous_decision,o.context_targets AS previous_targets
        FROM new n JOIN old o USING(stable_id) WHERE n.decision IS DISTINCT FROM o.decision''')
    count = db.execute('SELECT count(*) FROM changed').fetchone()[0]
    assert count > 0
    assert db.execute('''SELECT count(*) FROM changed WHERE previous_decision<>'review-owner'
        OR decision<>'compose-in-owner' OR len(context_targets)<>1
        OR NOT list_contains(previous_targets,context_targets[1])''').fetchone()[0] == 0
    db.execute('''CREATE TABLE removed AS SELECT c.stable_id,old_owner AS ancestor,
        c.context_targets[1] AS descendant FROM changed c,unnest(previous_targets) t(old_owner)
        WHERE old_owner<>c.context_targets[1]''')
    assert db.execute('''SELECT count(*) FROM removed x WHERE NOT EXISTS (
        SELECT 1 FROM rels r WHERE r.from_id=x.ancestor AND r.to_id=x.descendant AND (
          (r.rel_type='AST_CHILD' AND json_extract_string(r.props_json,'$.field') IS NOT NULL
            AND json_extract_string(r.props_json,'$.projection') IS NULL)
          OR (r.rel_type='HAS_OPERATION' AND json_extract_string(r.props_json,'$.ownership')='immediate-step')
          OR (r.rel_type IN ('HAS_MEMBER','HAS_PROPERTY') AND json_extract_string(r.props_json,'$.ownership')='direct')))
        ''').fetchone()[0] == 0
    assert db.execute('''SELECT count(*) FROM old o JOIN new n USING(stable_id)
        WHERE o.owner_status='unique-direct-owner' AND (
          o.context_targets IS DISTINCT FROM n.context_targets
          OR o.immediate_owner_evidence IS DISTINCT FROM n.immediate_owner_evidence)''').fetchone()[0] == 0
    assert db.execute('''SELECT count(*) FROM old o JOIN new n USING(stable_id)
        WHERE o.required_body_context IS DISTINCT FROM n.required_body_context
          OR o.capture_path IS DISTINCT FROM n.capture_path
          OR o.capture_original IS DISTINCT FROM n.capture_original OR n.scheduled''').fetchone()[0] == 0
    token = 'src/api/gramjs/ChatAbortController.ts:10:6:10:10'
    assert db.execute('SELECT decision,context_targets FROM new WHERE stable_id=?', [token]).fetchone() == (
        'compose-in-owner', ['src/api/gramjs/ChatAbortController.ts:10:6:10:44'])
    remaining = db.execute("SELECT count(*) FROM new WHERE owner_status='conflicting-direct-owners'").fetchone()[0]
    assert remaining > 0
    db.close()
print(json.dumps({'ok': True, 'resolvedCompositionParts': count,
    'remainingConflicts': remaining, 'strongerOwnersUnchanged': True,
    'bodyAndCaptureContextRetained': True, 'scheduledTasks': 0, 'writesNeo4j': False}))
