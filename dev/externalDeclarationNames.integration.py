"""Validate names of referenced out-of-scope declarations on real extraction snapshots."""
import argparse
import json
from pathlib import Path

import duckdb

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--parquet', type=Path, required=True)
parser.add_argument('--baseline', type=Path, required=True)
parser.add_argument('--plan', type=Path, required=True)
parser.add_argument('--source-root', type=Path, required=True)
args = parser.parse_args()
db = duckdb.connect(config={'memory_limit': '1GB', 'threads': 1})

def load(root):
    nodes = {key: (set(labels), json.loads(props)) for key, labels, props in db.read_parquet(
        str(root/'nodes.parquet')).project('stable_id,labels,props_json').fetchall()}
    edges = {(source, kind, target): json.loads(props) for source, kind, target, props in db.read_parquet(
        str(root/'relationships.parquet')).project('from_id,rel_type,to_id,props_json').fetchall()}
    return nodes, edges

nodes, edges = load(args.parquet)
old_nodes, old_edges = load(args.baseline)
assert old_nodes.keys() <= nodes.keys(), 'Old node lost'
assert old_edges.keys() <= edges.keys(), 'Old edge lost'
for relation in old_edges:
    before = {key: value for key, value in old_edges[relation].items() if key != 'provenance_id'}
    after = {key: value for key, value in edges[relation].items() if key != 'provenance_id'}
    assert before == after, ('Old edge changed', relation)
for key, (labels, _) in old_nodes.items():
    assert labels <= nodes[key][0], ('Old label lost', key)
new_edges = edges.keys() - old_edges.keys()
assert new_edges, 'Referenced external names required'
files = {}
named_nodes = set()
external_names = 0
for owner, kind, name in new_edges:
    props = edges[owner, kind, name]
    assert kind == 'AST_CHILD' and props.get('field') == 'name', (owner, kind, name, props)
    assert owner in old_nodes and 'Declaration' in nodes[owner][0], owner
    assert nodes[owner][1].get('sourceCoverage') == 'declaration-only', owner
    assert 'DeclarationName' in nodes[name][0], name
    named_nodes.add(name)
    external_names += 'ExternalDeclaration' in nodes[owner][0]
    coordinates = nodes[name][1]
    path = (args.source_root/coordinates['repoRelativePath']).resolve()
    if path not in files:
        files[path] = path.read_text(encoding='utf-8').splitlines()
    assert coordinates['startLine'] == coordinates['endLine'], name
    line = files[path][coordinates['startLine'] - 1]
    text = line[coordinates['startColumn']:coordinates['endColumn']]
    assert text == coordinates['syntax'], (name, text, coordinates['syntax'])
assert external_names, 'Library declarations required'
assert nodes.keys() - old_nodes.keys() <= named_nodes, 'Unrelated new nodes'
plan = {key: (decision, targets) for key, decision, targets in db.read_parquet(
    str(args.plan/'annotation-plan.parquet')).project('stable_id,decision,context_targets').fetchall()}
for owner, _, name in new_edges:
    assert plan[name] == ('compose-in-owner', [owner]), (name, plan[name])
old_plan = {key: (decision, targets) for key, decision, targets in db.read_parquet(
    str(args.baseline.parent/'inventory'/'annotation-plan.parquet')).project(
        'stable_id,decision,context_targets').fetchall()}
fixed = [key for key, (decision, _) in old_plan.items() if decision == 'review-owner' and key in named_nodes]
assert fixed, 'No missing declaration-name owner reproduced'
for key, previous in old_plan.items():
    if key not in named_nodes:
        assert plan[key] == previous, ('Unrelated decision changed', key, previous, plan[key])
print(json.dumps({'ok': True, 'directNameOwners': len(new_edges), 'externalDeclarationNames': external_names,
                  'ownerReviewsResolved': len(fixed), 'oldNodesAndEdgesRetained': True, 'writesNeo4j': False}))
