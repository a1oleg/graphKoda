"""Check callback policy changes against actual whole-project inventories."""
import argparse
import json
from pathlib import Path
import duckdb

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--report', type=Path, required=True)
parser.add_argument('--baseline', type=Path, required=True)
args = parser.parse_args()
db = duckdb.connect()
for name, file in [('new', args.report/'annotation-plan.parquet'),
                   ('old', args.baseline/'annotation-plan.parquet'),
                   ('subjects', args.report/'subjects.parquet')]:
    db.read_parquet(str(file)).create_view(name)
assert json.loads((args.report/'annotation-plan.json').read_text(encoding='utf-8'))['version'] == 12
assert db.execute('''SELECT count(*) FROM old FULL JOIN new USING(stable_id)
    WHERE old.stable_id IS NULL OR new.stable_id IS NULL''').fetchone()[0] == 0
assert db.execute('''SELECT count(*) FROM old JOIN new USING(stable_id) JOIN subjects s USING(stable_id)
    WHERE old.decision<>new.decision AND NOT (
      old.decision='review-callback' AND new.decision='generation-candidate'
      AND list_contains(s.labels,'CallbackImplementation') AND s.body_count>0)''').fetchone()[0] == 0
assert db.execute('''SELECT count(*) FROM old JOIN new USING(stable_id)
    WHERE old.context_targets IS DISTINCT FROM new.context_targets
      OR old.required_body_context IS DISTINCT FROM new.required_body_context
      OR new.scheduled OR NOT new.retain_context''').fetchone()[0] == 0
assert db.execute('''SELECT count(*) FROM new JOIN subjects s USING(stable_id)
    WHERE new.decision='generation-candidate' AND list_contains(s.labels,'CallbackImplementation')
      AND s.body_count=0''').fetchone()[0] == 0
changed = db.execute('SELECT count(*) FROM old JOIN new USING(stable_id) WHERE old.decision<>new.decision').fetchone()[0]
assert changed > 0
assert db.execute("SELECT decision FROM new WHERE stable_id='src/components/common/Composer.tsx:383:17:3307:1'").fetchone()[0] == 'generation-candidate'
assert db.execute("SELECT decision FROM new WHERE stable_id='src/api/gramjs/ChatAbortController.ts:22:25:22:65'").fetchone()[0] == 'compose-in-owner'
print(json.dumps({'ok': True, 'changedCallbacks': changed,
                  'preservedBodyAndOwnerEvidence': True, 'scheduled': False}))
