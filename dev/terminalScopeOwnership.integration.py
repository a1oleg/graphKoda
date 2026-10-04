"""Check terminal scopes and module identity on real extraction snapshots."""
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
    plan = dict(db.read_parquet(str(path / 'inventory/annotation-plan.parquet'))
                .project('stable_id,decision').fetchall())
    return nodes, edges, plan


old_nodes, old_edges, old_plan = load(args.baseline)
nodes, edges, plan = load(args.snapshot)
old_module = 'src/lib/fasterdom/stricterdom.ts:1:0:215:0'
module = 'source-file:src/lib/fasterdom/stricterdom.ts'
assert old_nodes.keys() - nodes.keys() == {old_module}
assert 'SourceFile' in nodes[module][0]
assert 'ValueDeclaration' not in nodes[module][0]


def remap(key):
    return module if key == old_module else key


assert not {(remap(a), kind, remap(b)) for a, kind, b in old_edges} - edges
terminals = 0
for key, (labels, props) in nodes.items():
    if 'SharedTerminal' not in labels:
        continue
    scope = props['shared_terminal_scope_stable_id']
    assert scope in nodes, (key, scope)
    assert (scope, 'HAS_TERMINAL', key) in edges, key
    assert key in old_nodes, key
    terminals += 1
assert terminals == 5, terminals
repaired = 0
for key, decision in old_plan.items():
    if key == old_module:
        assert decision == 'blocked-unresolved'
        continue
    if decision == plan[key]:
        continue
    assert (decision, plan[key]) == ('review-owner', 'compose-in-owner'), key
    assert 'SharedTerminal' in nodes[key][0], key
    repaired += 1
assert repaired == 4, repaired
assert not any(value in ('review-owner', 'blocked-unresolved') for value in plan.values())
print(json.dumps({'ok': True, 'terminalScopes': terminals, 'repairedOwners': repaired,
                  'moduleIdentityCorrected': True, 'oldEdgesRetainedAfterRemap': True,
                  'writesGraph': False}))
