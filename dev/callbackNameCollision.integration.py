"""Check a real callback does not resolve to an unrelated same-named function."""
import argparse
import json
from pathlib import Path

import duckdb

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--baseline', type=Path, required=True)
parser.add_argument('--expanded', type=Path, required=True)
args = parser.parse_args()
db = duckdb.connect(config={'memory_limit': '1GB', 'threads': 1})
call = 'src/components/ui/Transition.tsx:399:8:399:72'
signature = 'src/components/ui/Transition.tsx:25:25:25:119'
unrelated = 'src/lib/teact/teact-dom.ts:70:0:90:1'
sets = []
for snapshot in (args.baseline, args.expanded):
    nodes = {key: (labels, json.loads(props)) for key, labels, props in db.read_parquet(
        str(snapshot / 'parquet/nodes.parquet')).project('stable_id,labels,props_json').fetchall()}
    proxies = {key for key, (labels, props) in nodes.items()
               if 'FnVisualProxy' in labels and str(props.get('sourceCallStableId', '')).startswith(call)}
    assert len(proxies) == 2, proxies
    call_sites = {nodes[key][1]['sourceCallStableId'] for key in proxies}
    for key in proxies:
        assert nodes[key][1]['call_origin_declaration_stable_id'] == signature
        assert not nodes[key][1].get('calleeStableId'), key
        assert nodes[key][1].get('call_origin') == 'project'
    for a, kind, b in db.read_parquet(str(snapshot / 'parquet/relationships.parquet'))\
            .project('from_id,rel_type,to_id').fetchall():
        assert not (a in call_sites | proxies and b == unrelated
                    and kind in ('CALL', 'REQUEST', 'CALLS', 'PROXY_OF')), (a, kind, b)
    sets.append(proxies)
assert sets[0] == sets[1]
print(json.dumps({'ok': True, 'callbackProxiesStable': len(sets[0]),
                  'unrelatedSameNameTargetRejected': True, 'writesGraph': False}))
