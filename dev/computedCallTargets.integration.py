"""Check keyword and computed-callee context on actual extraction snapshots."""
import argparse
import json
from collections import Counter
from pathlib import Path

import duckdb

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--snapshot', type=Path, required=True)
parser.add_argument('--baseline', type=Path, required=True)
args = parser.parse_args()
db = duckdb.connect(config={'memory_limit': '1GB', 'threads': 1})
nodes = {key: (labels, json.loads(props)) for key, labels, props in db.read_parquet(
    str(args.snapshot/'parquet/nodes.parquet')).project('stable_id,labels,props_json').fetchall()}
old_nodes = {key for key, in db.read_parquet(str(args.baseline/'parquet/nodes.parquet')).project('stable_id').fetchall()}
assert nodes.keys() == old_nodes
edges = [(a, kind, b, json.loads(props)) for a, kind, b, props in db.read_parquet(
    str(args.snapshot/'parquet/relationships.parquet')).project('from_id,rel_type,to_id,props_json').fetchall()]
old_edges = set(db.read_parquet(str(args.baseline/'parquet/relationships.parquet')).project('from_id,rel_type,to_id').fetchall())
assert old_edges <= {(a, kind, b) for a, kind, b, _ in edges}
plan = {key: (decision, callable_context, value_context) for key, decision, callable_context, value_context
        in db.read_parquet(str(args.snapshot/'inventory/annotation-plan.parquet')).project(
            'stable_id,decision,required_callable_context,required_value_context').fetchall()}
old_plan = dict(db.read_parquet(str(args.baseline/'inventory/annotation-plan.parquet')).project('stable_id,decision').fetchall())
counts = Counter()
for call, kind, target, props in edges:
    if kind != 'CALLS_VALUE':
        continue
    labels, node = nodes[target]
    if props.get('resolution') == 'ast-computed-callee':
        assert props['role'] == 'callee'
        assert 'ValueReference' not in labels and 'Reference' not in labels, target
        assert target in plan[call][1], call
        if 'CallResult' in labels:
            counts['returned-callable'] += 1
        elif node.get('consumptionKind') == 'index-access':
            operands = {b for a, relation, b, ep in edges if a == target
                        and relation == 'CONSUMES_VALUE' and ep.get('role') in {'receiver', 'index'}}
            assert len(operands) == 2 and operands <= set(plan[target][2]), target
            counts['indexed-callable'] += 1
    elif node.get('resolution') == 'typescript-keyword':
        assert 'System' in labels and 'Reference' not in labels, target
        assert node['syntaxKind'].endswith('Keyword'), target
        counts[node['syntaxKind']] += 1
changed = {key for key, (decision, _, _) in plan.items() if old_plan[key] != decision}
assert changed
for key in changed:
    assert old_plan[key] == 'blocked-unresolved' and plan[key][0] == 'compose-in-owner', key
    labels, props = nodes[key]
    assert props.get('resolution') == 'typescript-keyword' or 'CallResult' in labels or props.get('consumptionKind') == 'index-access', key
assert counts['ImportKeyword'] and counts['returned-callable'] and counts['indexed-callable'], counts
print(json.dumps({'ok': True, 'cases': dict(counts), 'resolvedFalseBlockers': len(changed),
    'oldNodesAndEdgesRetained': True, 'requiredCalleeAndOperandContextsRetained': True, 'writesNeo4j': False}))
db.close()
