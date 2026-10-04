"""Check explicit contextual source links using real extraction snapshots, without graph writes."""
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

def load(root):
    nodes = {key: (set(labels), json.loads(props)) for key, labels, props in db.read_parquet(
        str(root/'nodes.parquet')).project('stable_id,labels,props_json').fetchall()}
    edges = {(source, kind, target): json.loads(props) for source, kind, target, props in db.read_parquet(
        str(root/'relationships.parquet')).project('from_id,rel_type,to_id,props_json').fetchall()}
    return nodes, edges

nodes, edges = load(args.parquet)
before_nodes, before_edges = load(args.baseline)
assert nodes.keys() == before_nodes.keys(), 'Node identities changed'
assert before_edges.keys() <= edges.keys(), 'Old relationship lost'
for key, (labels, _) in before_nodes.items():
    assert labels <= nodes[key][0], ('Old label lost', key)
for relation in before_edges:
    if relation[1] == 'COMPOSES_SYNTAX':
        continue
    previous = {key: value for key, value in before_edges[relation].items() if key != 'provenance_id'}
    current = {key: value for key, value in edges[relation].items() if key != 'provenance_id'}
    assert previous == current, ('Old relationship changed', relation)
new_relations = edges.keys() - before_edges.keys()
assert new_relations, 'Regression requires newly materialized source links'
plan = {key: (decision, targets) for key, decision, targets in db.read_parquet(
    str(args.plan/'annotation-plan.parquet')).project('stable_id,decision,context_targets').fetchall()}
source_kinds = {}
for source, kind, target in new_relations:
    assert kind == 'PROXY_OF', (source, kind, target)
    labels, props = nodes[source]
    assert 'ExecutionOccurrence' in labels, source
    assert props['originalStableId'] == target and target in nodes and source != target, source
    assert edges[source, kind, target]['resolution'] == 'explicit-source-node', source
    assert plan[source] == ('follow-original', [target]), (source, plan[source])
    # The raw identity was captured during AST extraction, not reconstructed by the planner.
    target_props = nodes[target][1]
    assert props['repo_relative_path'] == target_props.get('repo_relative_path', target_props.get('repoRelativePath')), source
    for field, canonical_field in (('start_line', 'startLine'), ('start_column', 'startColumn'),
                                   ('end_line', 'endLine'), ('end_column', 'endColumn')):
        assert props[field] == target_props.get(field, target_props.get(canonical_field)), (source, field)
    name = nodes[target][1].get('syntaxKind', nodes[target][1].get('operation_code', 'other'))
    source_kinds[name] = source_kinds.get(name, 0) + 1
old_plan = db.read_parquet(str(args.baseline.parent/'inventory'/'annotation-plan.parquet')).project(
    'stable_id,decision').fetchall()
fixed = [key for key, decision in old_plan if decision == 'review-owner' and plan[key][0] == 'follow-original']
assert fixed, 'No old owner reviews resolved'
print(json.dumps({'ok': True, 'sourceLinks': len(new_relations), 'sourceKinds': source_kinds,
                  'ownerReviewsResolved': len(fixed), 'oldNodesAndEdgesRetained': True, 'writesNeo4j': False}))
