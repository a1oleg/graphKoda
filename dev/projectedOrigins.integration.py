"""Verify projected operations and typed-array declaration origins on real snapshots."""
import argparse
import json
from collections import Counter
from pathlib import Path

import duckdb

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--baseline', type=Path, required=True)
parser.add_argument('--snapshot', type=Path, required=True)
parser.add_argument('--source-root', type=Path, required=True)
args = parser.parse_args()
db = duckdb.connect(config={'memory_limit': '1GB', 'threads': 1})


def load(path):
    nodes = {key: (labels, json.loads(props)) for key, labels, props in db.read_parquet(
        str(path / 'parquet/nodes.parquet')).project('stable_id,labels,props_json').fetchall()}
    edges = {(a, kind, b): json.loads(props) for a, kind, b, props in db.read_parquet(
        str(path / 'parquet/relationships.parquet'))
        .project('from_id,rel_type,to_id,props_json').fetchall()}
    plan = dict(db.read_parquet(str(path / 'inventory/annotation-plan.parquet'))
                .project('stable_id,decision').fetchall())
    return nodes, edges, plan


old_nodes, old_edges, old_plan = load(args.baseline)
nodes, edges, plan = load(args.snapshot)
assert old_nodes.keys() == nodes.keys()
assert not old_edges.keys() - edges.keys()
added = edges.keys() - old_edges.keys()
assert added
for a, kind, b in added:
    assert kind == 'PROXY_OF' and a != b, (a, kind, b)
    assert edges[a, kind, b]['resolution'] == 'explicit-source-node'
    assert nodes[a][1]['originalStableId'] == b, a
    assert 'ExecutionOccurrence' in nodes[a][0] or 'AliasDeclaration' in nodes[a][0], a
    labels, props = nodes[b]
    file, start_line, start_column, end_line, end_column = b.rsplit(':', 4)
    assert props['repoRelativePath'] == file, b
    lines = (args.source_root / file).read_text(encoding='utf-8').splitlines()
    start_line, start_column, end_line, end_column = map(int,
        (start_line, start_column, end_line, end_column))
    selected = lines[start_line - 1:end_line]
    if len(selected) == 1:
        source = selected[0][start_column:end_column]
    else:
        selected[0] = selected[0][start_column:]
        selected[-1] = selected[-1][:end_column]
        source = '\n'.join(selected)
    assert source == props['syntax'], b

repaired = Counter()
for key, decision in old_plan.items():
    if decision == 'blocked-unresolved':
        assert plan[key] == 'follow-original', (key, plan[key])
        original = nodes[key][1]['originalStableId']
        assert (key, 'PROXY_OF', original) in edges, key
        assert ('Operation' in nodes[original][0]
                or nodes[original][1].get('canonical') is True), original
        repaired['declaration' if 'AliasDeclaration' in nodes[key][0] else 'operation'] += 1
    else:
        assert plan[key] == decision, (key, decision, plan[key])
assert repaired == {'declaration': 6, 'operation': 10}, repaired
assert not any(decision in {'blocked-unresolved', 'review-owner'} for decision in plan.values())
print(json.dumps({'ok': True, 'repaired': dict(repaired), 'explicitOriginalLinks': len(added),
                  'realSourceRangesVerified': True, 'otherDecisionsRetained': True,
                  'allExistingEdgesRetained': True, 'writesGraph': False}))
