"""Read-only live verification of the real Telegram ownership regressions."""
import json
import sys
from pathlib import Path
from datetime import datetime, timezone
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'graph/static-extract/py'))
from fromPreGraphToNeo4j import load_neo4j_settings
from neo4j import GraphDatabase

steps = [
    'flow-step:execution:src/components/left/LeftColumn.tsx:377:10:377:16',
    'flow-step:execution:src/util/deeplink.ts:125:8:125:14',
]
prefixes = [
    'flow-block:alternative:false:src/components/modals/gift/craft/GiftCraftModal.tsx:790:15:793:9',
    'flow-block:side:true:src/components/modals/gift/craft/GiftCraftModal.tsx:786:34:790:9',
]
s = load_neo4j_settings()
with GraphDatabase.driver(s['uri'], auth=(s['username'], s['password'])) as driver:
    with driver.session(database=s['database']) as session:
        self_edges = [dict(r) for r in session.run('MATCH (n)-[:NESTED_IN]->(n) RETURN n.stableId AS id')]
        found = [dict(r) for r in session.run('''MATCH (n) WHERE n.stableId IN $ids
            RETURN n.stableId AS id,n.provenance_id AS provenance,n.parentFnStableId AS owner''', ids=steps)]
        blocks = [dict(r) for r in session.run('''MATCH (n) WHERE any(prefix IN $prefixes WHERE
            n.stableId=prefix OR n.stableId STARTS WITH prefix + ':local-function-')
            OPTIONAL MATCH (n)-[:NESTED_IN]->(p)
            RETURN n.stableId AS id,n.parentFlowBlockStableId AS owner,
              collect(DISTINCT p.stableId) AS parents''', prefixes=prefixes)]
        shared = session.run('''MATCH (n {stableId:$id}) RETURN n.name AS name''',
            id='src/global/actions/ui/settings.ts:180:42:189:1').single()
assert len(found)==2 and all(row['provenance'] for row in found), found
assert not any(row['id'] in steps for row in self_edges), self_edges
assert shared and shared['name']=='ArrowFunction', 'Shared canonical name was overwritten'
assert len(blocks)==6 and all(row['parents']==[row['owner']] for row in blocks), blocks
print(json.dumps({'source':'live-neo4j','checkedAt':datetime.now(timezone.utc).isoformat(),
    'steps':found,'selfContainment':self_edges,'giftBlocks':blocks,
    'giftComplete':len(blocks)==6 and all(row['parents']==[row['owner']] for row in blocks),
    'sharedCanonicalNamePreserved':True},ensure_ascii=False,indent=2))
