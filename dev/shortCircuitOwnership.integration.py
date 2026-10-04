"""Check short-circuit containment on real scoped extraction artifacts."""
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
assert not old_nodes.keys() - nodes.keys()
for a, kind, b in old_edges - edges:
    assert kind == 'ENCLOSED_BY', (a, kind, b)
direct = {}
for parent, kind, child in edges:
    if kind == 'AST_CHILD':
        direct.setdefault(child, set()).add(parent)
repaired = 0
for key, decision in old_plan.items():
    if decision == plan[key]:
        continue
    assert (decision, plan[key]) == ('review-owner', 'compose-in-owner'), key
    assert any(nodes[parent][1].get('syntaxKind') == 'BinaryExpression'
               and 'SyntaxContainer' in nodes[parent][0]
               for parent in direct.get(key, set())), key
    repaired += 1
assert repaired == 7, repaired
print(json.dumps({'ok': True, 'repairedOwners': repaired, 'executionEdgesRetained': True,
                  'directAstOwnersVerified': True, 'writesGraph': False}))
