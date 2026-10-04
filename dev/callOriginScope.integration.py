"""Check call origin and visual identity independently of body coverage."""
import argparse
import json
from pathlib import Path

import duckdb

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--narrow', type=Path, required=True)
parser.add_argument('--expanded', type=Path, required=True)
parser.add_argument('--audit', type=Path, help='Additional real snapshot to audit call labels.')
args = parser.parse_args()
db = duckdb.connect(config={'memory_limit': '1GB', 'threads': 1})


def nodes(path):
    return {key: (labels, json.loads(props)) for key, labels, props in db.read_parquet(
        str(path / 'parquet/nodes.parquet')).project('stable_id,labels,props_json').fetchall()}


narrow, expanded = nodes(args.narrow), nodes(args.expanded)
checked = 0
proxies = 0
for key, (labels, props) in narrow.items():
    origin = props.get('call_origin')
    if not origin:
        continue
    assert key in expanded, key
    for field in ('call_origin', 'call_origin_declaration_stable_id', 'call_origin_declaration_path', 'call_origin_package'):
        assert props.get(field) == expanded[key][1].get(field), (key, field)
    if origin in ('project', 'unknown'):
        assert 'System' not in labels, (key, labels)
    checked += 1
    if 'FnVisualProxy' in labels and props.get('label') == 'formatCurrency':
        assert origin == 'project'
        assert props['call_origin_declaration_path'] == 'src/util/formatCurrency.tsx'
        assert '->system-' not in key
        proxies += 1
assert proxies == 6, proxies
assert checked > proxies
audited = 0
if args.audit:
    for key, (labels, props) in nodes(args.audit).items():
        origin = props.get('call_origin')
        if not origin or 'Call' not in labels:
            continue
        if origin in ('project', 'unknown'):
            assert 'System' not in labels, (key, labels)
        if origin == 'unknown':
            assert not props.get('call_origin_declaration_stable_id') or props.get('call_origin_declaration_path')
        audited += 1
    assert audited > 0
print(json.dumps({'ok': True, 'callsWithStableOrigins': checked,
                  'formatCurrencyProxiesStable': proxies, 'auditedCalls': audited, 'writesGraph': False}))
