"""Check generic prerequisites and source expansion using real extracted snapshots."""
import argparse
import json
from pathlib import Path

import duckdb

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--scoped', type=Path, required=True)
parser.add_argument('--expanded', type=Path, required=True)
parser.add_argument('--readiness', type=Path, required=True)
args = parser.parse_args()
db = duckdb.connect(config={'memory_limit': '1GB', 'threads': 1})


def snapshot(path):
    nodes = {key: (labels, json.loads(props)) for key, labels, props in db.read_parquet(
        str(path/'parquet/nodes.parquet')).project('stable_id,labels,props_json').fetchall()}
    edges = db.read_parquet(str(path/'parquet/relationships.parquet')).project(
        'from_id,rel_type,to_id').fetchall()
    relation = db.read_parquet(str(path/'inventory/annotation-plan.parquet'))
    columns = relation.columns
    records = [dict(zip(columns, row)) for row in relation.fetchall()]
    plan = {row['stable_id']: row for row in records}
    return nodes, edges, plan


scoped, expanded = snapshot(args.scoped), snapshot(args.expanded)
checked = 0
expanded_targets = set()
for key, (labels, _) in scoped[0].items():
    if 'GenericUse' not in labels:
        continue
    targets = {target for source, kind, target in scoped[1]
               if source == key and kind in {'INSTANTIATES', 'TYPE_ARGUMENT'}}
    if not targets or scoped[2][key]['decision'] != 'compose-in-owner':
        continue
    assert set(scoped[2][key]['required_type_context']) == targets, key
    assert set(expanded[2][key]['required_type_context']) == targets, key
    for target in targets:
        assert target in scoped[0] and target in expanded[0], target
        if scoped[2][target]['decision'] != 'deferred-source-expansion':
            continue
        assert scoped[2][target]['expansion_required'], target
        assert scoped[0][target][1]['sourceCoverage'] == 'declaration-only', target
        assert 'ExternalBoundary' not in scoped[0][target][0], target
        assert expanded[0][target][1]['sourceCoverage'] == 'syntax-extracted', target
        assert not expanded[2][target]['expansion_required'], target
        assert expanded[2][target]['decision'] == 'generation-candidate', target
        children = [child for source, kind, child in expanded[1]
                    if source == target and kind == 'AST_CHILD']
        assert any(expanded[0][child][1].get('syntax') == 'string | number'
                   for child in children), target
        expanded_targets.add(target)
    checked += 1
assert checked > 0 and expanded_targets
report = json.loads(args.readiness.read_text(encoding='utf-8'))
bottom = report['bottomUp']
pending = bottom['unconfirmedReadiness']
assert bottom['missingEndpoints'] == 0
assert pending['directNodes'] == sum(item['count'] for item in pending['directReasons'])
assert pending['inheritedOnlyNodes'] > 0
assert any(item['decision'] == 'deferred-source-expansion'
           for item in pending['directReasons'])
assert expanded_targets <= {item['stableId'] for item in pending['directExamples']}
assert not report['generatesAnnotations'] and not report['writesGraph']
for _, _, plan in [scoped, expanded]:
    assert not any(row['scheduled'] for row in plan.values())
db.close()
print(json.dumps({'ok': True, 'genericUsesChecked': checked,
    'expandedTargets': sorted(expanded_targets),
    'inheritedPendingNodes': pending['inheritedOnlyNodes'], 'writesGraph': False}))
