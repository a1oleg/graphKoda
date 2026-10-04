"""Verify complete declaration-reference traversal on a real extraction snapshot."""
import argparse
import json
from collections import Counter
from pathlib import Path

import duckdb

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--parquet', type=Path, required=True)
parser.add_argument('--baseline', type=Path, required=True)
parser.add_argument('--plan', type=Path, required=True)
args = parser.parse_args()
db = duckdb.connect(config={'memory_limit': '1GB', 'threads': 1})
nodes = dict(db.read_parquet(str(args.parquet/'nodes.parquet')).project('stable_id,labels').fetchall())
edges = db.read_parquet(str(args.parquet/'relationships.parquet')).project('from_id,rel_type,to_id').fetchall()


def plan(path):
    return {key: (decision, targets) for key, decision, targets in db.read_parquet(
        str(path/'annotation-plan.parquet')).project('stable_id,decision,context_targets').fetchall()}


old, new = plan(args.baseline), plan(args.plan)
assert old.keys() == new.keys() == nodes.keys()
targets = {}
kinds = {}
for source, relation, target in edges:
    kind = ('ReExport' if relation == 'REEXPORTS' and 'ReExport' in nodes[source]
            else 'MergedSymbol' if relation == 'HAS_DECLARATION_PART' and 'MergedSymbol' in nodes[source]
            else None)
    if not kind:
        continue
    assert source != target and target in nodes
    targets.setdefault(source, set()).add(target)
    kinds[source] = kind
checked = Counter()
for source, expected in targets.items():
    if old[source][0] == 'external-boundary':
        assert new[source][0] == 'external-boundary', source
        continue
    assert new[source][0] == 'follow-original', source
    assert set(new[source][1]) == expected, source
    checked[kinds[source]] += 1
assert checked['ReExport'] > 0 and checked['MergedSymbol'] > 0
changed = {key for key in old if old[key][0] != new[key][0]}
assert changed and changed <= targets.keys()
assert all(old[key][0] == 'blocked-unresolved' and new[key][0] == 'follow-original' for key in changed)
assert not any(row[0] for row in db.read_parquet(
    str(args.plan/'annotation-plan.parquet')).project('scheduled').fetchall())
db.close()
print(json.dumps({'ok': True, 'checked': dict(checked), 'resolvedBlockers': len(changed),
    'allTargetsRetained': True, 'otherDecisionsUnchanged': True, 'writesGraph': False}))
