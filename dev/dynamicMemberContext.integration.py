"""Check explicit dynamic-member limitations and receiver prerequisites on real artifacts."""
import argparse
import json
from collections import Counter
from pathlib import Path

import duckdb

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--snapshot', type=Path, required=True)
parser.add_argument('--baseline', type=Path, required=True)
parser.add_argument('--require-structural', action='store_true')
args = parser.parse_args()
db = duckdb.connect(config={'memory_limit': '1GB', 'threads': 1})
nodes = {key: (labels, json.loads(props)) for key, labels, props in db.read_parquet(
    str(args.snapshot/'parquet/nodes.parquet')).project('stable_id,labels,props_json').fetchall()}
edges = db.read_parquet(str(args.snapshot/'parquet/relationships.parquet')).project(
    'from_id,rel_type,to_id,props_json').fetchall()
plan = {key: (decision, required) for key, decision, required in db.read_parquet(
    str(args.snapshot/'inventory/annotation-plan.parquet')).project(
    'stable_id,decision,required_value_context').fetchall()}
old = dict(db.read_parquet(str(args.baseline/'inventory/annotation-plan.parquet')).project(
    'stable_id,decision').fetchall())
old_edges = set(db.read_parquet(str(args.baseline/'parquet/relationships.parquet')).project(
    'from_id,rel_type,to_id').fetchall())
assert old_edges <= {(source, kind, target) for source, kind, target, _ in edges}
assert old.keys() == nodes.keys() == plan.keys()
kinds = Counter()
resolved = 0
for key, (labels, props) in nodes.items():
    if 'DynamicMemberAccess' not in labels:
        continue
    assert props['staticMemberKnown'] is False, key
    assert props['memberResolution'] in {'receiver-any', 'string-index-signature', 'structural-type-member'}, key
    if props['memberResolution'] == 'structural-type-member':
        assert props['typeMemberKnown'] is True, key
        assert props['declarationResolution'] == 'no-source-declaration', key
    assert props['receiverTypeText'] and props['memberName'], key
    assert 'ExternalBoundary' not in labels and 'SystemProvider' not in labels, key
    outgoing = [(kind, target, json.loads(raw)) for source, kind, target, raw in edges if source == key]
    assert not any(kind == 'RESOLVES_TO' for kind, _, _ in outgoing), key
    receivers = {target for kind, target, edge_props in outgoing
                 if kind == 'READS_FROM' and edge_props.get('role') == 'receiver'}
    assert receivers and receivers <= nodes.keys(), key
    assert set(plan[key][1]) == receivers and plan[key][0] == 'compose-in-owner', key
    kinds[props['memberResolution']] += 1
    resolved += old[key] == 'blocked-unresolved'
if args.require_structural:
    assert kinds['structural-type-member'] and resolved > 0
else:
    assert kinds['receiver-any'] and kinds['string-index-signature'] and resolved > 0
for key in plan:
    if old[key] != plan[key][0]:
        assert 'DynamicMemberAccess' in nodes[key][0], key
db.close()
print(json.dumps({'ok': True, 'dynamicMembers': dict(kinds), 'resolvedFalseBlockers': resolved,
    'unknownMemberLimitationsRetained': True, 'receiverPrerequisitesRetained': True, 'writesGraph': False}))
