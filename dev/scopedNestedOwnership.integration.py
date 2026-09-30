"""Actual Telegram scoped replacement: preserve omitted nested nodes, then rollback."""
import sys
import json
import time
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'graph/static-extract/py'))
from fromPreGraphToNeo4j import run_scoped_extractor, load_neo4j_settings, replace_scoped_payload
from neo4j import GraphDatabase

fn = 'src/components/modals/gift/craft/GiftCraftModal.tsx:269:23:1636:1'
payload = run_scoped_extractor(fn)
incoming = {r['stableId'] for k in ('functions','nodes','resources','semanticEntities') for r in payload.get(k,[])}
args = SimpleNamespace(fn_stable_id=fn,append=False,preserve_annotations=True,batch_size=20000)
s = load_neo4j_settings()
with GraphDatabase.driver(s['uri'],auth=(s['username'],s['password'])) as driver:
    with driver.session(database=s['database']) as session:
        with session.begin_transaction() as tx:
            rows = [dict(r) for r in tx.run('''MATCH (n {source:'semantic/functionFlowGraph'})
                WHERE n.repoRelativePath=$file AND [n.startLine,n.startColumn] >= [269,23]
                  AND [n.endLine,n.endColumn] <= [1636,1]
                RETURN n.stableId AS id,properties(n) AS props''',
                file='src/components/modals/gift/craft/GiftCraftModal.tsx')]
            preserved = {r['id']:r['props'] for r in rows if r['id'] not in incoming
                and r['props'].get('parentFnStableId') != fn and r['props'].get('parent_fn_stable_id') != fn}
            def edges():
                return {(r['a'],r['type'],r['b']) for r in tx.run('''MATCH (a)-[r]->(b)
                    WHERE a.stableId IN $ids OR b.stableId IN $ids
                    RETURN a.stableId AS a,type(r) AS type,b.stableId AS b''',ids=list(preserved))}
            before_edges = edges()
            result = replace_scoped_payload(tx,payload,args,time.perf_counter())
            after = {r['id']:dict(r['props']) for r in tx.run('''MATCH (n) WHERE n.stableId IN $ids
                RETURN n.stableId AS id,properties(n) AS props''',ids=list(preserved))}
            assert after == preserved, 'Omitted nested nodes changed or disappeared'
            missing_edges = before_edges - edges()
            assert not missing_edges, sorted(missing_edges)
            assert result['annotationsDeleted']==0
            tx.rollback()
            print(json.dumps({'ok':True,'rolledBack':True,'preservedNodes':len(preserved),
                'preservedIncidentEdges':len(before_edges),'boundaryRestored':result['boundaryRelationshipsRestored']}))
