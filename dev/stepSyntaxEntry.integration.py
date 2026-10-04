"""Verify explicit Step entry relationships on real extracted source snapshots."""
import argparse
import json
from pathlib import Path

import duckdb

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--parquet', type=Path, required=True)
parser.add_argument('--baseline', type=Path)
parser.add_argument('--plan', type=Path)
args = parser.parse_args()
db = duckdb.connect(config={'memory_limit': '1GB', 'threads': 1})
nodes = {key: (labels, json.loads(props)) for key, labels, props in db.read_parquet(
    str(args.parquet/'nodes.parquet')).project('stable_id,labels,props_json').fetchall()}
edges = {(source, kind, target): json.loads(props) for source, kind, target, props in db.read_parquet(
    str(args.parquet/'relationships.parquet')).project('from_id,rel_type,to_id,props_json').fetchall()}
expected = set()
missing = []
for key, (labels, props) in nodes.items():
    if 'Step' not in labels:
        continue
    entry = props.get('syntaxEntryStableId')
    if not entry or entry == key or entry not in nodes:
        missing.append(key)
        continue
    edge = (key, 'HAS_SYNTAX_ENTRY', entry)
    expected.add(edge)
    assert edge in edges, edge
    assert edges[edge]['ownership'] == 'immediate-step', edge
    assert edges[edge]['layer'] == 'structural', edge
    assert edges[edge]['field'] == 'syntaxEntry', edge
actual = {key for key in edges if key[1] == 'HAS_SYNTAX_ENTRY'}
assert actual == expected and len(expected) > 0
if args.baseline:
    old_nodes = {key: (labels, json.loads(props)) for key, labels, props in db.read_parquet(
        str(args.baseline/'nodes.parquet')).project('stable_id,labels,props_json').fetchall()}
    old_edges = {(source, kind, target): json.loads(props) for source, kind, target, props in db.read_parquet(
        str(args.baseline/'relationships.parquet')).project('from_id,rel_type,to_id,props_json').fetchall()}
    assert nodes.keys() == old_nodes.keys()
    def content(value):
        return {key: item for key, item in value.items() if key != 'provenance_id'}
    for key, (labels, props) in nodes.items():
        assert set(labels) == set(old_nodes[key][0]) and content(props) == content(old_nodes[key][1]), key
    assert edges.keys() - old_edges.keys() == expected
    assert not old_edges.keys() - edges.keys()
    for key, props in old_edges.items():
        assert content(props) == content(edges[key]), key
if args.plan:
    plan = args.plan/'annotation-plan.parquet'
    assignment = 'src/api/gramjs/ChatAbortController.ts:9:6:9:41'
    for token in ['src/api/gramjs/ChatAbortController.ts:9:17:9:18',
                  'src/api/gramjs/ChatAbortController.ts:9:19:9:22']:
        assert db.execute('SELECT decision,context_targets FROM read_parquet(?) WHERE stable_id=?',
            [str(plan), token]).fetchone() == ('compose-in-owner', [assignment]), token
    assert db.execute('SELECT owner_status FROM read_parquet(?) WHERE stable_id=?',
        [str(plan), assignment]).fetchone() == ('unique-direct-owner',)
db.close()
print(json.dumps({'ok': True, 'nodes': len(nodes), 'explicitStepEntries': len(expected),
    'missingEntriesRetained': len(missing), 'onlyEntryEdgesAdded': bool(args.baseline),
    'writesNeo4j': False}))
