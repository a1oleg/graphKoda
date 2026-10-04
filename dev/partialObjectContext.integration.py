"""Check real returned-object context discovered outside the extraction scope."""
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
    edges = {(a, kind, b): json.loads(props) for a, kind, b, props in db.read_parquet(
        str(path / 'parquet/relationships.parquet')).project('from_id,rel_type,to_id,props_json').fetchall()}
    plan = dict(db.read_parquet(str(path / 'inventory/annotation-plan.parquet'))
                .project('stable_id,decision').fetchall())
    return nodes, edges, plan


old, old_edges, old_plan = load(args.baseline)
nodes, edges, plan = load(args.snapshot)
assert not old.keys() - nodes.keys()
assert not old_edges.keys() - edges.keys()
root = 'src/hooks/useAppLayout.ts:'
object_id = root + '79:9:85:3'
property_id = root + '83:4:83:37'
expression_id = root + '83:15:83:37'
assert edges[object_id, 'HAS_PROPERTY', property_id]['ownership'] == 'direct'
assert edges[property_id, 'AST_CHILD', expression_id]['field'] == 'initializer'
assert 'LiteralValue' not in nodes[expression_id][0]
assert nodes[expression_id][1]['syntaxKind'] == 'BinaryExpression'
for role, operand, reference in [('left', root + '83:15:83:24', root + '83:16:83:24'),
                                 ('right', root + '83:28:83:37', root + '83:29:83:37')]:
    assert edges[expression_id, 'AST_CHILD', operand]['field'] == role
    assert edges[expression_id, 'CONSUMES_VALUE', operand]['role'] == role
    if role == 'right':
        assert edges[expression_id, 'CONSUMES_VALUE', operand]['evaluation'] == 'short-circuit-conditional'
    assert nodes[operand][1]['syntaxKind'] == 'PrefixUnaryExpression'
    assert edges[operand, 'AST_CHILD', reference]['field'] == 'operand'
    assert any(a == reference and kind == 'RESOLVES_TO' and target in nodes
               for a, kind, target in edges)
changes = {key: (before, plan[key]) for key, before in old_plan.items() if before != plan[key]}
assert changes == {property_id: ('review-owner', 'compose-in-owner'),
                   expression_id: ('blocked-unresolved', 'compose-in-owner')}, changes
assert not any(value in ('blocked-unresolved', 'review-owner') for value in plan.values())
print(json.dumps({'ok': True, 'repaired': 2, 'oldNodesAndEdgesRetained': True,
                  'objectExpressionBindingsVerified': True, 'writesGraph': False}))
