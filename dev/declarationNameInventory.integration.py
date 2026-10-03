"""Verify annotation policy on real snapshots before/after declaration names."""
import argparse
import json
from pathlib import Path

import duckdb

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--baseline', type=Path, required=True)
parser.add_argument('--report', type=Path, required=True)
args = parser.parse_args()
summary = json.loads((args.report / 'summary.json').read_text(encoding='utf-8-sig'))
assert summary['version'] == 5
db = duckdb.connect()
db.execute("SET memory_limit='1GB'")
db.execute('SET threads=1')
db.execute('SET preserve_insertion_order=false')
for name, file in [('old', args.baseline / 'annotation-plan.parquet'),
                   ('new', args.report / 'annotation-plan.parquet'),
                   ('subjects', args.report / 'subjects.parquet'),
                   ('nodes', Path(summary['input']) / 'nodes.parquet'),
                   ('rels', Path(summary['input']) / 'relationships.parquet')]:
    db.read_parquet(str(file)).create_view(name)
assert db.execute('SELECT count(*) FROM old ANTI JOIN new USING(stable_id)').fetchone()[0] == 0
assert db.execute('''SELECT count(*) FROM old o JOIN new n USING(stable_id)
    WHERE o.decision<>n.decision AND NOT (
      o.decision='review-owner' AND n.decision='compose-in-owner')''').fetchone()[0] == 0
assert db.execute('''SELECT count(*) FROM new n LEFT JOIN old o USING(stable_id)
    WHERE n.decision='generation-candidate' AND o.decision IS DISTINCT FROM n.decision''').fetchone()[0] == 0
assert db.execute('''SELECT count(*) FROM old o JOIN new n USING(stable_id)
    WHERE o.required_body_context IS DISTINCT FROM n.required_body_context
      OR o.capture_path IS DISTINCT FROM n.capture_path OR n.scheduled''').fetchone()[0] == 0
db.execute('''CREATE TABLE names AS SELECT stable_id FROM nodes
    WHERE list_contains(labels,'DeclarationName')''')
names = db.execute('SELECT count(*) FROM names').fetchone()[0]
assert names > 0
assert db.execute('''SELECT count(*) FROM names n WHERE NOT EXISTS (
    SELECT 1 FROM rels r WHERE r.to_id=n.stable_id AND r.from_id<>r.to_id
      AND r.rel_type='AST_CHILD' AND json_extract_string(r.props_json,'$.field')='name')''').fetchone()[0] == 0
assert db.execute('''SELECT count(*) FROM subjects s WHERE s.ast_count IS DISTINCT FROM (
    SELECT count(*) FROM rels r WHERE r.from_id=s.stable_id AND r.rel_type='AST_CHILD'
      AND coalesce(json_extract_string(r.props_json,'$.field'),'')<>'name')''').fetchone()[0] == 0
resolved = db.execute('''SELECT count(*) FROM old o JOIN new n USING(stable_id)
    WHERE o.decision='review-owner' AND n.decision='compose-in-owner' ''').fetchone()[0]
assert resolved > 0
result = {'ok': True, 'declarationNames': names, 'resolvedExistingOwners': resolved,
          'existingStableIdsPreserved': True, 'generationCandidatesUnchanged': True,
          'bodyAndCaptureContextPreserved': True, 'scheduledTasks': 0}
(args.report / 'declaration-name-regression.json').write_text(
    json.dumps(result, indent=2), encoding='utf-8')
print(json.dumps(result))
