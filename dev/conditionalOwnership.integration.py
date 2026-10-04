"""Verify ownership repair on real source-expansion artifacts."""
import argparse
import json
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
    edges = {(a, kind, b) for a, kind, b in db.read_parquet(
        str(path / 'parquet/relationships.parquet')).project('from_id,rel_type,to_id').fetchall()}
    plan = dict(db.read_parquet(str(path / 'inventory/annotation-plan.parquet'))
                .project('stable_id,decision').fetchall())
    return nodes, edges, plan


old_nodes, old_edges, old_plan = load(args.baseline)
nodes, edges, plan = load(args.snapshot)
reviews = {key for key, decision in old_plan.items() if decision == 'review-owner'}
assert len(reviews) == 10
for key in reviews:
    assert plan[key] == 'compose-in-owner', (key, plan[key])
    owners = [parent for parent, kind, child in edges if kind == 'AST_CHILD' and child == key]
    assert owners, key
    assert any(nodes[parent][1].get('syntaxKind') in {
        'ConditionalExpression', 'NonNullExpression'} for parent in owners), (key, owners)
synthetic = 'flow:object:C:/GitHub/telegram-tt/src/util/schedulers.ts:199:7:199:32'
original = 'src/util/schedulers.ts:199:7:199:32'
assert old_nodes.keys() - nodes.keys() == {synthetic}
assert original in old_nodes and 'SyntaxComposition' in nodes[original][0]
for a, kind, b in old_edges:
    if a == synthetic:
        assert kind == 'COMPOSES_SYNTAX'
        if b != original:
            assert (original, kind, b) in edges, (original, kind, b)
old_blocked = {key for key, decision in old_plan.items() if decision == 'blocked-unresolved'}
new_blocked = {key for key, decision in plan.items() if decision == 'blocked-unresolved'}
assert new_blocked == old_blocked - {synthetic}
for key, decision in old_plan.items():
    if decision == 'external-boundary':
        assert plan[key] == decision, key
assert not any(a == b for a, kind, b in edges if kind == 'COMPOSES_SYNTAX')
print(json.dumps({'ok': True, 'repairedOwners': len(reviews), 'normalizedObjectMosaics': 1,
                  'noNewUnresolvedNodes': True, 'systemBoundariesRetained': True,
                  'writesGraph': False}))
