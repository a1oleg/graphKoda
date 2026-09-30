"""Exercise actual extracted Telegram payloads in a rollback-only Neo4j transaction."""
import copy
import json
from pathlib import Path
import sys
import time
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'graph/static-extract/py'))
from neo4j import GraphDatabase
from fromPreGraphToNeo4j import load_neo4j_settings, replace_scoped_payload
from extraction_provenance import check_scoped_provenance

payload = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
target = 'src/lib/gramjs/Utils.ts:10:0:12:1'
settings = load_neo4j_settings()
driver = GraphDatabase.driver(settings['uri'], auth=(settings['username'], settings['password']))
args = SimpleNamespace(fn_stable_id=target, append=False, preserve_annotations=True, batch_size=1000)
with driver.session(database=settings['database']) as session:
    original = session.run('MATCH (n {stableId:$id}) RETURN properties(n) AS props', id=target).single()['props']
    with session.begin_transaction() as tx:
        preview = copy.deepcopy(payload)
        check_scoped_provenance(tx, preview, fn_stable_id=target)
        assert preview['_scopedReplacement']['preservedSharedNodes'] > 0
        retained = {row['stableId'] for key in ('functions','nodes','resources','semanticEntities') for row in preview.get(key, [])}
        shared = {row['stableId'] for key in ('functions','nodes','resources','semanticEntities') for row in payload.get(key, [])} - retained
        before = list(tx.run('MATCH (n) WHERE n.stableId IN $ids RETURN n.stableId AS id,properties(n) AS props ORDER BY id', ids=sorted(shared)))
        result = replace_scoped_payload(tx, copy.deepcopy(payload), args, time.perf_counter())
        after = list(tx.run('MATCH (n) WHERE n.stableId IN $ids RETURN n.stableId AS id,properties(n) AS props ORDER BY id', ids=sorted(shared)))
        assert before == after, 'Shared dependencies were modified'
        assert tx.run('MATCH (n:Throw {stableId:$id}) RETURN count(n) AS count', id='src/lib/gramjs/Utils.ts:11:2:11:78').single()['count'] == 1
        assert result['boundaryRelationshipsRestored'] > 0
        tx.rollback()
    assert session.run('MATCH (n {stableId:$id}) RETURN properties(n) AS props', id=target).single()['props'] == original
driver.close()
print(json.dumps({'ok':True, 'rolledBack':True, 'sharedPreserved': len(shared),
    'boundaryRestored':result['boundaryRelationshipsRestored']}))
