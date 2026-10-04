"""Verify operator-token ownership using real before/after extraction snapshots."""
import argparse
import json
from pathlib import Path

import duckdb

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--baseline', type=Path, required=True)
parser.add_argument('--snapshot', type=Path, required=True)
parser.add_argument('--baseline-plan', type=Path, required=True)
args = parser.parse_args()
db = duckdb.connect(config={'memory_limit': '1GB', 'threads': 1})


def load(path):
    nodes = {key: (labels, json.loads(props)) for key, labels, props in db.read_parquet(
        str(path/'parquet/nodes.parquet')).project('stable_id,labels,props_json').fetchall()}
    edges = {(a, k, b): json.loads(props) for a, k, b, props in db.read_parquet(
        str(path/'parquet/relationships.parquet')).project('from_id,rel_type,to_id,props_json').fetchall()}
    return nodes, edges


def plan(path):
    return {key: (decision, targets) for key, decision, targets in db.read_parquet(
        str(path/'annotation-plan.parquet')).project('stable_id,decision,context_targets').fetchall()}


old_nodes, old_edges = load(args.baseline)
nodes, edges = load(args.snapshot)
old_plan, new_plan = plan(args.baseline_plan), plan(args.snapshot/'inventory')
assert old_nodes.keys() <= nodes.keys()
assert old_edges.keys() <= edges.keys()
added_edges = edges.keys() - old_edges.keys()
assert added_edges
for a, kind, b in added_edges:
    assert kind == 'AST_CHILD' and edges[a, kind, b]['field'] == 'operatorToken', (a, kind, b)
    assert a in old_nodes and {'System', 'SyntaxPart', 'Op', 'Operand'} <= set(nodes[b][0]), b
    assert new_plan[b] == ('compose-in-owner', [a]), b
added_nodes = nodes.keys() - old_nodes.keys()
assert added_nodes <= {b for _, _, b in added_edges}
changes = {key for key in old_plan if old_plan[key] != new_plan[key]}
assert changes
for key in changes:
    assert old_plan[key][0] in {'review-owner', 'compose-in-owner'}, key
    assert new_plan[key][0] == 'compose-in-owner', key
    assert (new_plan[key][1][0], 'AST_CHILD', key) in added_edges, key
db.close()
print(json.dumps({'ok': True, 'addedOperatorTokens': len(added_nodes),
    'addedDirectAstEdges': len(added_edges),
    'resolvedOwnerReviews': sum(old_plan[key][0] == 'review-owner' for key in changes),
    'refinedDirectOwners': sum(old_plan[key][0] == 'compose-in-owner' for key in changes),
    'oldNodesAndEdgesRetained': True, 'writesGraph': False}))
