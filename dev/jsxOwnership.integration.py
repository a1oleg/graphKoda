"""Verify JSX ownership repair using actual extraction snapshots."""
import argparse
import json
from collections import Counter
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
added_nodes = nodes.keys() - old_nodes.keys()
assert added_nodes
for key in added_nodes:
    assert 'SyntaxContainer' in nodes[key][0], key
    assert nodes[key][1]['syntaxKind'].startswith('Jsx'), key
direct = {}
containment = {}
for a, kind, b in edges:
    if kind == 'AST_CHILD':
        direct.setdefault(b, set()).add(a)
    if kind == 'ENCLOSED_BY':
        containment.setdefault(a, set()).add(b)
for child, kind, owner in old_edges - edges:
    assert kind == 'ENCLOSED_BY', (child, kind, owner)
    assert any(nodes[target][1].get('syntaxKind', '').startswith('Jsx')
               for target in containment.get(child, set())), child
repaired = Counter()
for key, decision in old_plan.items():
    if plan[key] == decision:
        continue
    assert decision in {'review-owner', 'blocked-unresolved'}, (key, decision)
    assert plan[key] == 'compose-in-owner', (key, plan[key])
    assert any(nodes[parent][1].get('syntaxKind', '').startswith('Jsx')
               for parent in direct.get(key, set())), key
    repaired[decision] += 1
assert repaired == {'review-owner': 32, 'blocked-unresolved': 4}, repaired
print(json.dumps({'ok': True, 'repaired': dict(repaired), 'newJsxContainers': len(added_nodes),
                  'executionEdgesRetained': True, 'directAstOwnersVerified': True,
                  'writesGraph': False}))
