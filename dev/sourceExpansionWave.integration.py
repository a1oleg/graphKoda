"""Verify bounded source expansion against real extraction artifacts."""
import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

import duckdb

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--comparison', type=Path, required=True)
args = parser.parse_args()
report = json.loads(args.comparison.read_text(encoding='utf-8'))
db = duckdb.connect(config={'memory_limit': '1GB', 'threads': 1})


def load(path):
    path = Path(path)
    nodes = {key: {**json.loads(props), '_labels': labels} for key, labels, props in db.read_parquet(
        str(path / 'parquet/nodes.parquet')).project('stable_id,labels,props_json').fetchall()}
    edges = {(a, kind, b): json.loads(props) for a, kind, b, props in db.read_parquet(
        str(path / 'parquet/relationships.parquet')).project('from_id,rel_type,to_id,props_json').fetchall()}
    plan = dict(db.read_parquet(str(path / 'inventory/annotation-plan.parquet'))
                .project('stable_id,decision').fetchall())
    return nodes, edges, plan


old, old_edges, old_plan = load(report['snapshot'])
new, edges, plan = load(report['comparison']['expandedSnapshot'])
# A presentation ID includes the resolved callee. Scope expansion can replace
# its former system fallback; never apply that exception to code entities.
remapped = {}
for key in old.keys() - new.keys():
    props = old[key]
    assert 'FnVisualProxy' in props['_labels'] and props.get('synthetic'), key
    prefix, target = key.split('->', 1)
    assert target.startswith('system-'), key
    replacements = [candidate for candidate, candidate_props in new.items()
                    if candidate.startswith(prefix + '->')
                    and 'FnVisualProxy' in candidate_props['_labels']]
    assert len(replacements) == 1, (key, replacements)
    replacement = replacements[0]
    for field in ('label', 'call_boundary_role', 'render_composition_source_stable_id'):
        assert props.get(field) == new[replacement].get(field), (key, field)
    remapped[key] = replacement
parents = defaultdict(set)
for (a, kind, b), props in edges.items():
    if kind == 'AST_CHILD' and props.get('field') and not props.get('projection'):
        parents[b].add(a)
    elif kind == 'ENCLOSED_BY':
        parents[a].add(b)
for a, kind, b in old_edges:
    a, b = remapped.get(a, a), remapped.get(b, b)
    if (a, kind, b) in edges:
        continue
    assert kind == 'ENCLOSED_BY', (a, kind, b)
    pending, seen = [a], {a}
    while pending and b not in seen:
        for parent in parents[pending.pop()] - seen:
            seen.add(parent)
            pending.append(parent)
    assert b in seen, (a, b)
pending_files = Counter(old[key]['repoRelativePath'].replace('\\', '/')
                        for key, decision in old_plan.items()
                        if decision == 'deferred-source-expansion')
expected = sorted(pending_files, key=lambda file: (-pending_files[file], file))
if report['maxFiles'] is not None:
    expected = expected[:report['maxFiles']]
assert report['sourceRootsArgument'].split(';') == expected
selected = [key for key, decision in old_plan.items()
            if decision == 'deferred-source-expansion'
            and old[key]['repoRelativePath'].replace('\\', '/') in expected]
assert len(selected) == report['selectedDeclarations']
assert {row['stableId'] for row in report['pending']} == set(selected)
for key in selected:
    assert new[key].get('sourceCoverage') == 'syntax-extracted', key
    assert plan[key] != 'deferred-source-expansion', key
assert not any(value in ('blocked-unresolved', 'review-owner') for value in plan.values())
assert report['comparison']['statuses'] == {'source-expanded': len(selected)}
print(json.dumps({'ok': True, 'selectedFiles': len(expected),
                  'expandedDeclarations': len(selected), 'codeNodesRetained': True,
                  'presentationTargetsRefined': len(remapped),
                  'executionEdgesRetainedAfterRemap': True, 'ancestorPathsRetained': True,
                  'writesGraph': False}))
