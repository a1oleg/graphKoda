"""Check mosaic source anchors against two real extraction snapshots."""
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
    return nodes, edges


old_nodes, old_edges = load(args.baseline)
nodes, edges = load(args.snapshot)
prefix = 'src/lib/teact/teact.ts:'
redirects = {prefix + a: prefix + b for a, b in [
    ('748:8:748:91', '748:8:748:90'),
    ('962:7:962:93', '962:7:962:92'),
    ('1037:70:1037:70', '1037:43:1037:70'),
]}
assert old_nodes.keys() - nodes.keys() == redirects.keys()
assert not nodes.keys() - old_nodes.keys()
expected = set()
redirected = 0
for a, kind, b in old_edges:
    if a in redirects:
        assert kind == 'COMPOSES_SYNTAX', (a, kind, b)
        a = redirects[a]
        redirected += 1
        if a == b:
            continue
    expected.add((a, kind, b))
assert edges == expected, {'missing': list(expected - edges)[:10], 'extra': list(edges - expected)[:10]}
for original in redirects.values():
    assert 'SyntaxComposition' in nodes[original][0], original
    assert original in old_nodes, original
assert not any(a == b for a, kind, b in edges if kind == 'COMPOSES_SYNTAX')
print(json.dumps({'ok': True, 'normalizedMosaics': len(redirects),
                  'redirectedCompositionLinks': redirected, 'allOtherEdgesRetained': True,
                  'writesGraph': False}))
