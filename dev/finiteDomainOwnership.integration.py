"""Verify finite-domain allocation against real immutable extraction artifacts."""
import argparse
import json
from pathlib import Path

import duckdb

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--parquet', type=Path, required=True)
parser.add_argument('--baseline', type=Path, required=True)
parser.add_argument('--plan', type=Path, required=True)
args = parser.parse_args()
db = duckdb.connect(config={'memory_limit': '1GB', 'threads': 1})
nodes = {key: (labels, json.loads(props)) for key, labels, props in db.read_parquet(
    str(args.parquet/'nodes.parquet')).project('stable_id,labels,props_json').fetchall()}
edges = db.read_parquet(str(args.parquet/'relationships.parquet')).project(
    'from_id,rel_type,to_id,props_json').fetchall()


def plan(path):
    return {key: (decision, targets) for key, decision, targets in db.read_parquet(
        str(path/'annotation-plan.parquet')).project('stable_id,decision,context_targets').fetchall()}


old, new = plan(args.baseline), plan(args.plan)
assert old.keys() == new.keys() == nodes.keys()
members = {}
for source, kind, target, raw in edges:
    if kind != 'HAS_MEMBER' or 'LiteralDomain' not in nodes[source][0]:
        continue
    props = json.loads(raw)
    labels, member = nodes[target]
    assert 'LiteralDomainValue' in labels, target
    assert member['domain_stable_id'] == source, target
    assert member['ordinal'] == props['ordinal'], target
    assert target not in members or members[target] == source, target
    members[target] = source
assert members
for member, domain in members.items():
    assert new[member] == ('compose-in-owner', [domain]), member
occurrences = set()
for source, kind, target, _ in edges:
    if kind != 'RESOLVES_TO' or 'LiteralOccurrence' not in nodes[source][0]:
        continue
    assert target in members, target
    assert new[source][0] == 'follow-original' and target in new[source][1], source
    occurrences.add(source)
assert occurrences
changes = {key for key in old if old[key] != new[key]}
assert changes <= set(members) | occurrences, changes - set(members) - occurrences
assert not any(row[0] for row in db.read_parquet(
    str(args.plan/'annotation-plan.parquet')).project('scheduled').fetchall())
db.close()
print(json.dumps({'ok': True, 'members': len(members), 'occurrences': len(occurrences),
    'changedAllocations': len(changes), 'otherAllocationsUnchanged': True, 'writesGraph': False}))
