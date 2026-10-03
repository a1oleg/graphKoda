"""Verify declaration ownership in the actual graph; never mutate it."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'graph/static-extract/py'))
from fromPreGraphToNeo4j import load_neo4j_settings
from neo4j import GraphDatabase

declaration = 'src/api/gramjs/ChatAbortController.ts:7:8:7:47'
function = 'src/api/gramjs/ChatAbortController.ts:6:2:13:3'
settings = load_neo4j_settings()
with GraphDatabase.driver(settings['uri'], auth=(settings['username'], settings['password'])) as driver:
    with driver.session(database=settings['database']) as session:
        with session.begin_transaction() as tx:
            rows = tx.run('''MATCH (d {stableId:$id})<-[r:AST_CHILD]-(owner)
                WHERE r.field='declarations'
                RETURN owner.stableId AS id, labels(owner) AS labels''', id=declaration).data()
            assert len(rows) == 1 and 'DeclarationContainer' in rows[0]['labels'], rows
            current = rows[0]['id']
            path = [declaration, current]
            while current != function:
                rows = tx.run('''MATCH (n {stableId:$id})-[r:ENCLOSED_BY]->(owner)
                    WHERE r.resolution='nearest-materialized-ast-owner'
                    RETURN owner.stableId AS id''', id=current).data()
                assert len(rows) == 1, (current, rows)
                current = rows[0]['id']
                assert current not in path, path
                path.append(current)
            origins = tx.run('''MATCH (d {stableId:$id})-[:VALUE_FROM]->(v)
                RETURN DISTINCT v.stableId AS id''', id=declaration).value()
            assert origins == ['src/api/gramjs/ChatAbortController.ts:7:21:7:47'], origins
            missing = tx.run('''UNWIND $ids AS id MATCH (n {stableId:id})
                RETURN count(DISTINCT n.stableId) AS total''', ids=path).single()['total']
            assert missing == len(path)
            tx.rollback()
print(json.dumps({'ok': True, 'source': 'live-neo4j', 'writesGraph': False,
                  'path': path, 'valueOrigins': origins}))
