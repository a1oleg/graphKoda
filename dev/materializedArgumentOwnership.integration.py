"""Check argument ownership against two plans from the same actual snapshot."""
import argparse
import json
from pathlib import Path

import duckdb

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--baseline', type=Path, required=True)
parser.add_argument('--report', type=Path, required=True)
args = parser.parse_args()
summary = json.loads((args.report/'summary.json').read_text(encoding='utf-8'))
baseline = json.loads((args.baseline/'summary.json').read_text(encoding='utf-8'))
assert summary['input'] == baseline['input'], 'Compare the same extracted graph'
assert json.loads((args.report/'annotation-plan.json').read_text(encoding='utf-8'))['version'] == 14
db = duckdb.connect()
db.execute("SET memory_limit='1GB'")
db.execute('SET threads=1')
db.execute('SET preserve_insertion_order=false')
for name, file in [('old', args.baseline/'annotation-plan.parquet'),
                   ('new', args.report/'annotation-plan.parquet'),
                   ('nodes', Path(summary['input'])/'nodes.parquet'),
                   ('rels', Path(summary['input'])/'relationships.parquet')]:
    db.read_parquet(str(file)).create_view(name)
assert db.execute('SELECT count(*) FROM old FULL JOIN new USING(stable_id) WHERE old.stable_id IS NULL OR new.stable_id IS NULL').fetchone()[0] == 0
db.execute('''CREATE TABLE changed AS SELECT n.* FROM new n JOIN old o USING(stable_id)
    WHERE n.decision<>o.decision OR n.context_targets IS DISTINCT FROM o.context_targets
      OR n.owner_status IS DISTINCT FROM o.owner_status''')
assert db.execute('''SELECT count(*) FROM changed n WHERE NOT EXISTS (
    SELECT 1 FROM unnest(n.immediate_owner_evidence) e(proof)
    JOIN rels r ON r.to_id=n.stable_id AND r.from_id=proof.target
    JOIN nodes child ON child.stable_id=n.stable_id
    JOIN nodes caller ON caller.stable_id=r.from_id
    WHERE proof.relation='MATERIALIZES_ARGUMENT' AND r.rel_type=proof.relation
      AND list_contains(caller.labels,'Call') AND r.from_id<>r.to_id
      AND json_extract_string(r.props_json,'$.semantic_expansion')='call-execution'
      AND json_extract_string(r.props_json,'$.protocol_role')='actual argument'
      AND json_extract_string(child.props_json,'$.sourceCallStableId')=r.from_id
)''').fetchone()[0] == 0
assert db.execute('''SELECT count(*) FROM new n JOIN old o USING(stable_id)
    WHERE (n.decision='generation-candidate')<>(o.decision='generation-candidate')
      OR n.required_body_context IS DISTINCT FROM o.required_body_context
      OR n.capture_path IS DISTINCT FROM o.capture_path OR n.scheduled''').fetchone()[0] == 0
assert db.execute('''SELECT count(*) FROM changed n JOIN old o USING(stable_id)
    WHERE o.owner_status='unique-direct-owner' AND NOT EXISTS (
      SELECT 1 FROM unnest(o.immediate_owner_evidence) e(proof) WHERE proof.tier>0)
      AND NOT list_has_all(n.context_targets,o.context_targets)''').fetchone()[0] == 0
example = 'src/api/gramjs/apiBuilders/appConfig.ts:212:46:212:68:arg1'
assert db.execute('SELECT decision,context_targets FROM new WHERE stable_id=?', [example]).fetchone() == (
    'compose-in-owner', ['src/api/gramjs/apiBuilders/appConfig.ts:212:26:212:91'])
result = {'ok': True, 'changedNodes': db.execute('SELECT count(*) FROM changed').fetchone()[0],
          'transitions': db.execute('''SELECT o.decision,n.decision,count(*) FROM changed n
              JOIN old o USING(stable_id) GROUP BY ALL ORDER BY count(*) DESC''').fetchall(),
          'generationCandidatesUnchanged': True, 'bodyAndCaptureContextPreserved': True,
          'scheduledTasks': 0}
(args.report/'materialized-argument-regression.json').write_text(
    json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False))
