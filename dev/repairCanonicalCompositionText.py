"""Restore canonical text only when stored render occurrences prove its corruption."""
import argparse
import json
import sys
import subprocess
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'graph/static-extract/py'))
from fromPreGraphToNeo4j import run_scoped_extractor, load_neo4j_settings
from extraction_provenance import register_provenance, validate_provenance
from neo4j import GraphDatabase

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--fn-stable-id', required=True)
parser.add_argument('--report', type=Path, required=True)
parser.add_argument('--apply', action='store_true')
parser.add_argument('--source-root', type=Path)
args = parser.parse_args()
payload = run_scoped_extractor(args.fn_stable_id)
provenance = validate_provenance(payload['provenance'])
canonical = {r['stableId']:r['props'] for r in payload['semanticEntities']
    if r['props'].get('canonical') is True or r['props'].get('sourceBacked') is True}
assert all(p.get('provenance_id')==provenance['id'] for p in canonical.values())
settings = load_neo4j_settings()
report = {'function':args.fn_stable_id,'provenance':provenance['id'],'applied':False,'repairs':[],'rejected':[]}
scope_file, *scope_coordinates = args.fn_stable_id.rsplit(':',4)
scope_start = tuple(map(int,scope_coordinates[:2]))
scope_end = tuple(map(int,scope_coordinates[2:]))
report['deferredToScopedImport'] = []
with GraphDatabase.driver(settings['uri'],auth=(settings['username'],settings['password'])) as driver:
    with driver.session(database=settings['database']) as session:
        with session.begin_transaction() as tx:
            rows = list(tx.run('''MATCH (n) WHERE n.stableId IN $ids
                OPTIONAL MATCH ()-[r:COMPOSES_SYNTAX]->(n)
                RETURN n.stableId AS id,elementId(n) AS elementId,properties(n) AS props,
                  collect(r.renderOccurrencesJson) AS occurrences''',ids=list(canonical)))
            records = {r['id']:r['props'] for r in tx.run('''MATCH (p:ExtractionProvenance)
                WHERE p.id IN $ids RETURN p.id AS id,properties(p) AS props''',
                ids=list({r['props'].get('provenance_id') for r in rows}))}
            for row in rows:
                old, new = row['props'], canonical[row['id']]
                changed = [k for k in ('name','syntax') if new.get(k) is not None and old.get(k)!=new[k]]
                if not changed:
                    continue
                record = records.get(old.get('provenance_id'), {})
                same_source = all(record.get(k)==provenance.get(k) for k in
                    ('source_revision','source_dirty_fingerprint','extraction_options')) and bool(record)
                source_backed = (old.get('canonical') is True and new.get('canonical') is True) or (
                    old.get('sourceBacked') is True and new.get('sourceBacked') is True)
                same_identity = source_backed and all(old.get(k)==new.get(k) for k in
                    ('repoRelativePath','startLine','startColumn','endLine','endColumn','declarationKind'))
                rendered = set()
                for raw in row['occurrences']:
                    parts = json.loads(raw)
                    if isinstance(parts,str):
                        parts = json.loads(parts)
                    for part in parts:
                        if part.get('sourceStableId')==row['id']:
                            rendered.update(v for k in ('text','plainText') if isinstance(v:=part.get(k),str))
                proven = same_source and same_identity and all(old.get(k) in rendered for k in changed)
                item = {'id':row['id'],'elementId':row['elementId'],'before':{k:old.get(k) for k in changed},
                    'after':{k:new[k] for k in changed},'previousProvenance':old.get('provenance_id')}
                item['sameSourceAndIdentity'] = same_source and same_identity
                if not proven:
                    report['rejected'].append(item)
                    continue
                report['repairs'].append(item)
            if args.source_root and report['rejected']:
                candidates = [item for item in report['rejected'] if item['sameSourceAndIdentity']]
                result = subprocess.run(['node',str(Path(__file__).with_name('verifyCanonicalTextOrigin.mjs'))],
                    input=json.dumps({'sourceRoot':str(args.source_root),'items':candidates}),
                    text=True,encoding='utf-8',capture_output=True,check=True)
                proven_ids = set(json.loads(result.stdout))
                for item in candidates:
                    if item['id'] in proven_ids:
                        item['proof'] = 'ast-enclosing-declaration-or-rest-parameter'
                        report['repairs'].append(item)
                report['rejected'] = [item for item in report['rejected'] if item['id'] not in proven_ids]
            for item in list(report['rejected']):
                props = canonical[item['id']]
                start = (props.get('startLine'),props.get('startColumn'))
                end = (props.get('endLine'),props.get('endColumn'))
                if (item['sameSourceAndIdentity'] and props.get('repoRelativePath')==scope_file
                        and all(isinstance(v,int) for v in (*start,*end))
                        and scope_start <= start and end <= scope_end):
                    report['deferredToScopedImport'].append(item)
                    report['rejected'].remove(item)
            args.report.parent.mkdir(parents=True,exist_ok=True)
            args.report.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
            if args.apply:
                if report['rejected']:
                    raise RuntimeError('Unproven text differences; no repair committed. Inspect the report.')
                register_provenance(tx,[provenance])
                for repair in report['repairs']:
                    count = tx.run('''MATCH (n) WHERE elementId(n)=$elementId AND n.stableId=$id
                        SET n._canonicalTextRepairLock=true
                        WITH n WHERE n.provenance_id=$previous
                          AND all(k IN keys($before) WHERE n[k]=$before[k])
                        SET n += $after,n.canonicalTextRepairProvenance=$provenance
                        REMOVE n._canonicalTextRepairLock
                        RETURN count(n) AS count''',id=repair['id'],elementId=repair['elementId'],previous=repair['previousProvenance'],
                        before=repair['before'],after=repair['after'],provenance=provenance['id']).single()['count']
                    if count!=1:
                        raise RuntimeError(f"Concurrent change or duplicate identity: {repair['id']}")
                tx.commit()
                report['applied']=True
                args.report.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
            else:
                tx.rollback()
print(json.dumps({'applied':report['applied'],'repairs':len(report['repairs']),
    'rejected':len(report['rejected']),'report':str(args.report)},ensure_ascii=False))
