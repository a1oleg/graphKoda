"""Check borrowed type-member source coordinates against actual source files."""
import argparse
import json
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
    plan = dict(db.read_parquet(str(path / 'inventory/annotation-plan.parquet'))
                .project('stable_id,decision').fetchall())
    return nodes, plan


old_nodes, old_plan = load(args.baseline)
nodes, plan = load(args.snapshot)
changed_parts = 0
for key in old_nodes.keys() & nodes.keys():
    old_parts = json.loads(old_nodes[key][1].get('render_parts_json', '[]'))
    parts = json.loads(nodes[key][1].get('render_parts_json', '[]'))
    assert len(old_parts) == len(parts), key
    for old, part in zip(old_parts, parts):
        if old.get('sourceStableId') == part.get('sourceStableId'):
            continue
        assert old['stableId'] == part['stableId'], key
        file, sl, sc, el, ec = part['sourceStableId'].rsplit(':', 4)
        sl, sc, el, ec = map(int, (sl, sc, el, ec))
        lines = (args.source_root / file).resolve().read_text(encoding='utf-8').splitlines()
        assert 1 <= sl <= el <= len(lines), part['sourceStableId']
        assert 0 <= sc <= len(lines[sl - 1]), part['sourceStableId']
        assert 0 <= ec <= len(lines[el - 1]), part['sourceStableId']
        selected = lines[sl - 1:el]
        if sl == el:
            text = selected[0][sc:ec]
        else:
            selected[0], selected[-1] = selected[0][sc:], selected[-1][:ec]
            text = '\n'.join(selected)
        assert part['text'].rstrip('?') in text, (key, part['text'], text)
        changed_parts += 1
assert changed_parts
removed = old_nodes.keys() - nodes.keys()
assert len(removed) == 10
assert sum(old_plan[key] == 'review-owner' for key in removed) == 5
# Two malformed member ranges coincide with valid AST nodes; keep those nodes
# but stop attaching foreign type-member labels to them.
for key in ('src/components/payment/PaymentModal.tsx:176:2:176:14',
            'src/components/payment/PaymentModal.tsx:189:24:189:40'):
    assert key in nodes and old_plan[key] == 'review-owner'
    assert plan[key] == 'compose-in-owner', (key, plan[key])
print(json.dumps({'ok': True, 'verifiedParts': changed_parts, 'removedFalseNodes': len(removed),
                  'validCollidingAstNodesRetained': True, 'writesGraph': False}))
