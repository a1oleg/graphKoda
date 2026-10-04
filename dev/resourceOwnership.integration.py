"""Check resource containment on real extraction snapshots, without annotation generation."""
import argparse
import json
from pathlib import Path

import duckdb

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--parquet', type=Path, required=True)
parser.add_argument('--baseline', type=Path)
parser.add_argument('--plan', type=Path)
parser.add_argument('--all-function-contexts', action='store_true')
args = parser.parse_args()
db = duckdb.connect(config={'memory_limit': '1GB', 'threads': 1})
def load(root):
    nodes = {key: (set(labels), json.loads(props)) for key, labels, props in db.read_parquet(
        str(root/'nodes.parquet')).project('stable_id,labels,props_json').fetchall()}
    edges = {(source, kind, target): json.loads(props) for source, kind, target, props in db.read_parquet(
        str(root/'relationships.parquet')).project('from_id,rel_type,to_id,props_json').fetchall()}
    return nodes, edges
nodes, edges = load(args.parquet)
targets = {}
shared = 0
for key, (labels, props) in nodes.items():
    if args.all_function_contexts and props.get('resource_context_scope') == 'shared':
        assert not any(kind == 'HAS_RESOURCE' and target == key for _, kind, target in edges), key
        shared += 1
        continue
    if not (props.get('resource_context_scope') == 'function' if args.all_function_contexts
            else props.get('resource_kind') == 'async-flow'):
        continue
    parent = props.get('parentStableId')
    if 'Cell' in labels:
        assert parent in nodes, key
        relation = (key, 'PART_OF', parent)
        assert edges.get(relation, {}).get('ownership') == 'direct-resource-cell', relation
        targets[key] = parent
    else:
        owner = props.get('parentFnStableId')
        assert owner in nodes, key
        relation = (owner, 'HAS_RESOURCE', key)
        assert edges.get(relation, {}).get('ownership') == 'function-local-resource', relation
        targets[key] = owner
assert targets, 'Actual asynchronous resources required'
if args.baseline:
    old_nodes, old_edges = load(args.baseline)
    def content(props):
        ignored = {'provenance_id'}
        if args.all_function_contexts:
            ignored.add('resource_context_scope')
        return {key: value for key, value in props.items() if key not in ignored}
    assert nodes.keys() == old_nodes.keys()
    for key, (labels, props) in nodes.items():
        assert labels == old_nodes[key][0] and content(props) == content(old_nodes[key][1]), key
    assert not old_edges.keys() - edges.keys()
    for key, props in old_edges.items():
        assert content(props) == content(edges[key]), key
    for source, kind, target in edges.keys() - old_edges.keys():
        assert (kind == 'PART_OF' and targets.get(source) == target
            or kind == 'HAS_RESOURCE' and targets.get(target) == source), (source, kind, target)
if args.plan:
    rows = {key: (decision, context) for key, decision, context in db.read_parquet(
        str(args.plan/'annotation-plan.parquet')).project('stable_id,decision,context_targets').fetchall()}
    for key, owner in targets.items():
        assert rows[key] == ('compose-in-owner', [owner]), (key, rows[key])
db.close()
print(json.dumps({'ok': True, 'resourceContexts': len(targets),
    'cells': sum('Cell' in nodes[key][0] for key in targets),
    'sharedResourcesChecked': shared,
    'oldNodeIdentitiesAndContentRetained': bool(args.baseline), 'writesNeo4j': False}))
