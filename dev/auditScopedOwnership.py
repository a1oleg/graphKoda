"""Read-only ownership audit on an actual scoped extraction and live Neo4j."""
import sys
import json
from collections import Counter
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'graph/static-extract/py'))
from fromPreGraphToNeo4j import run_scoped_extractor, load_neo4j_settings
from neo4j import GraphDatabase

fn = sys.argv[1]
payload = run_scoped_extractor(fn)
incoming = {row['stableId'] for key in ('functions','nodes','resources','semanticEntities') for row in payload.get(key,[])}
file,sl,sc,el,ec = fn.rsplit(':',4)
s = load_neo4j_settings()
with GraphDatabase.driver(s['uri'],auth=(s['username'],s['password'])) as driver:
    with driver.session(database=s['database']) as session:
        rows = [dict(r) for r in session.run('''MATCH (n {source:'semantic/functionFlowGraph'})
            WHERE n.parentFnStableId=$fn OR n.parent_fn_stable_id=$fn OR (
              n.repoRelativePath=$file AND [n.startLine,n.startColumn] >= $start
              AND [n.endLine,n.endColumn] <= $end)
            RETURN n.stableId AS id, coalesce(n.parentFnStableId,n.parent_fn_stable_id) AS owner''',
            fn=fn,file=file,start=[int(sl),int(sc)],end=[int(el),int(ec)])]
missing = [r for r in rows if r['id'] not in incoming]
print(json.dumps({'function':fn,'oldCleanupNodes':len(rows),'absentFromReplacement':len(missing),
    'missingByOwner':dict(Counter(r['owner'] or '<none>' for r in missing)),
    'samples':missing[:12]},indent=2))
