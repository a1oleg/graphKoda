"""Check unary/return containment and local join ownership on real snapshots."""
import argparse
import json
from collections import defaultdict
from pathlib import Path

import duckdb

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--baseline', type=Path, required=True)
parser.add_argument('--snapshot', type=Path, required=True)
args = parser.parse_args()
db = duckdb.connect(config={'memory_limit': '1GB', 'threads': 1})


def load(path):
    nodes = {key: (labels, json.loads(props)) for key, labels, props in db.read_parquet(
        str(path / 'parquet/nodes.parquet')).project('stable_id,labels,props_json').fetchall()}
    edges = {(a, kind, b): json.loads(props) for a, kind, b, props in db.read_parquet(
        str(path / 'parquet/relationships.parquet')).project('from_id,rel_type,to_id,props_json').fetchall()}
    plan = dict(db.read_parquet(str(path / 'inventory/annotation-plan.parquet'))
                .project('stable_id,decision').fetchall())
    return nodes, edges, plan


old, old_edges, old_plan = load(args.baseline)
nodes, edges, plan = load(args.snapshot)
assert not old.keys() - nodes.keys()
parents = defaultdict(set)
for (a, kind, b), props in edges.items():
    if kind == 'AST_CHILD' and props.get('field') and not props.get('projection'):
        parents[b].add(a)
    elif kind == 'ENCLOSED_BY':
        parents[a].add(b)
for a, kind, b in old_edges.keys() - edges.keys():
    assert kind == 'ENCLOSED_BY', (a, kind, b)
    seen = {a}
    pending = [a]
    while pending and b not in seen:
        for parent in parents[pending.pop()] - seen:
            seen.add(parent)
            pending.append(parent)
    assert b in seen, (a, b)
repaired = defaultdict(int)
for key, before in old_plan.items():
    if before == plan[key]:
        continue
    assert (before, plan[key]) == ('review-owner', 'compose-in-owner'), key
    labels, props = nodes[key]
    if 'Join' in labels:
        assert props['synthetic'] and props['parentLocalFunctionStableId'] in nodes
        repaired['localJoin'] += 1
    else:
        direct = [a for (a, kind, b), edge in edges.items()
                  if kind == 'AST_CHILD' and b == key and edge.get('field')
                  and not edge.get('projection')]
        kinds = {nodes[a][1].get('syntaxKind') for a in direct}
        if 'PrefixUnaryExpression' in kinds:
            repaired['unaryOperand'] += 1
        else:
            assert 'ReturnStatement' in kinds, (key, kinds)
            repaired['returnedObject'] += 1
assert dict(repaired) == {'localJoin': 1, 'unaryOperand': 2, 'returnedObject': 1}, repaired
assert not any(value in ('review-owner', 'blocked-unresolved') for value in plan.values())
print(json.dumps({'ok': True, 'repaired': dict(repaired),
                  'executionEdgesRetained': True, 'ancestorPathsRetained': True,
                  'writesGraph': False}))
