"""Verify actual scoped destructuring repairs in Neo4j without changing data."""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'graph/static-extract/py'))
from fromPreGraphToNeo4j import load_neo4j_settings
from neo4j import GraphDatabase

cases = [
    ('src/api/gramjs/apiBuilders/bots.ts:162:14:162:19','ObjectBindingPattern'),
    ('src/api/gramjs/apiBuilders/statistics.ts:180:9:180:10','ArrayBindingPattern'),
]
s = load_neo4j_settings()
verified = []
with GraphDatabase.driver(s['uri'],auth=(s['username'],s['password'])) as driver:
    with driver.session(database=s['database']) as session:
        with session.begin_transaction() as tx:
            for stable_id, kind in cases:
                rows = [dict(r) for r in tx.run('''MATCH (b {stableId:$id})
                    MATCH (p)-[element:AST_CHILD]->(b) WHERE element.field='elements'
                    MATCH (d)-[name:AST_CHILD]->(p) WHERE name.field='name'
                    RETURN b.stableId AS binding,p.stableId AS pattern,d.stableId AS declaration,
                      p.syntaxKind AS kind,labels(p) AS labels,p.provenance_id AS provenance,
                      b.provenance_id AS bindingProvenance,d.provenance_id AS declarationProvenance''',id=stable_id)]
                assert len(rows)==1,(stable_id,rows)
                row = rows[0]
                assert row['kind']==kind and 'BindingPattern' in row['labels'],row
                assert len({row['binding'],row['pattern'],row['declaration']})==3,row
                assert row['provenance'] and row['provenance']==row['bindingProvenance']==row['declarationProvenance'],row
                origins = [r['id'] for r in tx.run('''MATCH (b {stableId:$id})-[:READS_FROM]->(origin)
                    RETURN DISTINCT origin.stableId AS id''',id=stable_id)]
                assert origins and all(origins),(stable_id,origins)
                row['valueOrigins'] = origins
                verified.append(row)
            tx.rollback()
print(json.dumps({'ok':True,'source':'live-neo4j','checkedAt':datetime.now(timezone.utc).isoformat(),
    'writesGraph':False,'verified':verified},ensure_ascii=False,indent=2))
