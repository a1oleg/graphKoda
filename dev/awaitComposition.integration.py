"""Validate await ownership and render composition on real scoped extraction snapshots."""
import argparse
import json
from pathlib import Path

import duckdb

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--parquet', type=Path, required=True)
parser.add_argument('--baseline', type=Path, required=True)
parser.add_argument('--source-root', type=Path, required=True)
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
old_nodes, old_edges = load(args.baseline)
tokens = {key: props for key, (_, props) in nodes.items() if props.get('syntaxKind') == 'AwaitKeyword'}
awaits = {key for key, (_, props) in nodes.items() if props.get('syntaxKind') == 'AwaitExpression'}
assert tokens and awaits, 'Actual await expressions required'
source_lines = {}
for key, props in tokens.items():
    source = props['repoRelativePath']
    if source not in source_lines:
        source_lines[source] = (args.source_root/source).read_text(encoding='utf-8').splitlines()
    assert props['startLine'] == props['endLine'], key
    text = source_lines[source][props['startLine'] - 1][props['startColumn']:props['endColumn']]
    assert text == 'await', (key, text)
    owners = [(source, p) for (source, kind, target), p in edges.items()
              if kind == 'AST_CHILD' and target == key]
    assert len(owners) == 1 and owners[0][0] in awaits, (key, owners)
    assert owners[0][1].get('field') == 'awaitKeyword', key
for key in awaits:
    assert any(source == key and kind == 'CONSUMES_VALUE' and props.get('role') == 'awaited'
               for (source, kind, _), props in edges.items()), key
composition = {(source, target) for source, kind, target in edges if kind == 'COMPOSES_SYNTAX'}
assert not any((target, source) in composition for source, target in composition), 'Reverse composition'
for (source, kind, target), props in edges.items():
    if kind != 'COMPOSES_SYNTAX' or target not in awaits:
        continue
    occurrences = json.loads(props['renderOccurrencesJson'])
    assert not any('Await' in part.get('labels', []) for part in occurrences), (source, target)
assert old_nodes.keys() <= nodes.keys(), 'Old node lost'
for key in old_nodes.keys() - awaits:
    assert old_nodes[key][0] <= nodes[key][0], ('Old labels lost', key)
for relation in old_edges.keys() & edges.keys():
    if relation[1] == 'COMPOSES_SYNTAX':
        continue
    before = {key: value for key, value in old_edges[relation].items() if key != 'provenance_id'}
    after = {key: value for key, value in edges[relation].items() if key != 'provenance_id'}
    assert before == after, ('Unrelated relation changed', relation)
removed = old_edges.keys() - edges.keys()
assert removed, 'Regression baseline must contain the old await composition'
for source, kind, target in removed:
    assert kind == 'COMPOSES_SYNTAX' and target in awaits, (source, kind, target)
    occurrences = json.loads(old_edges[source, kind, target]['renderOccurrencesJson'])
    assert all('Await' in part.get('labels', []) for part in occurrences), (source, target)
    token_targets = {token for token, props in tokens.items()
                     if (target, 'AST_CHILD', token) in edges}
    assert any((source, token) in composition for token in token_targets), (source, target)
plan = {key: decision for key, decision in db.read_parquet(
    str(args.plan/'annotation-plan.parquet')).project('stable_id,decision').fetchall()}
for key in tokens.keys() | awaits:
    assert plan[key] == 'compose-in-owner', (key, plan[key])
for key, decision in db.read_parquet(str(args.baseline.parent/'inventory'/'annotation-plan.parquet')).project(
        'stable_id,decision').fetchall():
    if decision == 'review-owner':
        assert plan[key] == 'compose-in-owner', (key, plan[key])
print(json.dumps({'ok': True, 'awaitTokens': len(tokens), 'awaitExpressions': len(awaits),
                  'replacedCompositionEdges': len(removed), 'oldNodesRetained': True, 'writesNeo4j': False}))
