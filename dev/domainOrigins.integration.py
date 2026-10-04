"""Verify finite-domain origins and normalized mosaic identities on real artifacts."""
import argparse
import json
import re
from pathlib import Path

import duckdb

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--baseline', type=Path, required=True)
parser.add_argument('--baseline-plan', type=Path, required=True)
parser.add_argument('--snapshot', type=Path, required=True)
parser.add_argument('--source-root', type=Path, required=True)
args = parser.parse_args()
db = duckdb.connect(config={'memory_limit': '1GB', 'threads': 1})


def load(path):
    nodes = {key: (labels, json.loads(props)) for key, labels, props in db.read_parquet(
        str(path/'parquet/nodes.parquet')).project('stable_id,labels,props_json').fetchall()}
    edges = {(a, k, b) for a, k, b in db.read_parquet(
        str(path/'parquet/relationships.parquet')).project('from_id,rel_type,to_id').fetchall()}
    return nodes, edges


def plan(path):
    return {key: (decision, targets) for key, decision, targets in db.read_parquet(
        str(path/'annotation-plan.parquet')).project('stable_id,decision,context_targets').fetchall()}


old_nodes, old_edges = load(args.baseline)
nodes, edges = load(args.snapshot)
old_plan, new_plan = plan(args.baseline_plan), plan(args.snapshot/'inventory')
domains = 0
for key, (labels, props) in nodes.items():
    if 'LiteralDomain' not in labels:
        continue
    target = props['declaration_stable_id']
    assert target in nodes and 'Declaration' in nodes[target][0], key
    assert (key, 'PROXY_OF', target) in edges, key
    assert new_plan[key] == ('follow-original', [target]), key
    if nodes[target][1]['sourceCoverage'] == 'declaration-only':
        assert new_plan[target][0] == 'deferred-source-expansion', target
    domains += 1
assert domains
removed = old_nodes.keys() - nodes.keys()
assert removed
for key in removed:
    match = re.fullmatch(r'flow:(?:call|object-field):(.*):(\d+):(\d+):(\d+):(\d+)', key)
    assert match, key
    file = Path(match[1]).relative_to(args.source_root).as_posix()
    target = ':'.join([file, *match.groups()[1:]])
    assert 'SyntaxComposition' in nodes[target][0], target
    for source, kind, child in old_edges:
        if source == key and kind == 'COMPOSES_SYNTAX' and child != target:
            assert (target, kind, child) in edges, (target, child)
assert not any(a == b for a, kind, b in edges if kind in {'COMPOSES_SYNTAX', 'PROXY_OF'})
for key, (decision, _) in old_plan.items():
    if decision == 'external-boundary':
        assert new_plan[key][0] == decision, key
db.close()
print(json.dumps({'ok': True, 'domainOrigins': domains, 'normalizedMosaicDuplicates': len(removed),
    'systemBoundariesRetained': True, 'writesGraph': False}))
