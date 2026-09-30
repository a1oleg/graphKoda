"""Verify previously missing Step targets against live Neo4j, separately from snapshot reports."""
import argparse
import json
from pathlib import Path
import sys
from datetime import datetime, timezone
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'graph/static-extract/py'))
from fromPreGraphToNeo4j import load_neo4j_settings
from neo4j import GraphDatabase

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--report', type=Path, required=True)
args = parser.parse_args()
audit = json.loads((args.report/'body-audit.json').read_text(encoding='utf-8'))
items = [{'function':row['stable_id'],'step':step['step'],'target':step['syntaxEntry']}
    for row in audit['subjects'] if row['syntaxAudit']['status']=='nonempty-body'
    for step in row['ownedSteps'] if not step['entryExists']]
settings = load_neo4j_settings()
with GraphDatabase.driver(settings['uri'],auth=(settings['username'],settings['password'])) as driver:
    with driver.session(database=settings['database']) as session:
        rows = [dict(row) for row in session.run('''UNWIND $items AS item
            OPTIONAL MATCH (step {stableId:item.step})
            OPTIONAL MATCH (target {stableId:item.target})
            RETURN item.function AS function,item.step AS step,item.target AS target,
              step IS NOT NULL AS stepExists,target IS NOT NULL AS targetExists,
              step.syntaxEntryStableId AS currentStepTarget,target.provenance_id AS provenance,
              labels(target) AS labels''',items=items)]
result = {'source':'live-neo4j','checkedAt':datetime.now(timezone.utc).isoformat(),
    'snapshotProvenanceIds':audit['provenanceIds'],'checked':len(rows),
    'resolvedTargets':sum(row['stepExists'] and row['targetExists'] for row in rows),
    'rows':rows}
(args.report/'live-body-repairs.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=False))
