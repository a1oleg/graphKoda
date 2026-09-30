"""Evidence-based annotation candidates, not a generation queue or graph mutation."""
import argparse
import json
from pathlib import Path
import time
import subprocess
import sys

import duckdb


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--parquet', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    start = time.perf_counter()
    db = duckdb.connect()
    db.execute("SET memory_limit='2GB'")
    db.execute('SET threads=1')
    db.execute('SET preserve_insertion_order=false')
    db.read_parquet(str(args.parquet / 'nodes.parquet')).create_view('raw_nodes')
    db.read_parquet(str(args.parquet / 'relationships.parquet')).create_view('rels')
    db.execute('''CREATE TABLE nodes AS SELECT stable_id, labels, provenance_id,
        coalesce(json_extract_string(props_json,'$.name'),json_extract_string(props_json,'$.label')) AS name,
        coalesce(json_extract_string(props_json,'$.repoRelativePath'),json_extract_string(props_json,'$.repo_relative_path')) AS file,
        json_extract_string(props_json,'$.declarationKind') AS declaration_kind,
        json_extract_string(props_json,'$.annotationKind') AS annotation_kind,
        coalesce(json_extract_string(props_json,'$.parentStepStableId'),
            json_extract_string(props_json,'$.parentFlowBlockStableId'),
            json_extract_string(props_json,'$.parentLocalFunctionStableId'),
            json_extract_string(props_json,'$.parentFnStableId')) AS owner_property,
        json_extract_string(props_json,'$.canonicalStableId') AS original_property,
        json_extract_string(props_json,'$.sourceCallStableId') AS presentation_owner,
        json_extract_string(props_json,'$.canonical')='true' AS canonical,
        substring(coalesce(json_extract_string(props_json,'$.syntax'),json_extract_string(props_json,'$.action_text_raw')),1,500) AS syntax
        FROM raw_nodes''')
    count = db.execute('SELECT count(*) FROM nodes').fetchone()[0]
    assert count == db.execute('SELECT count(DISTINCT stable_id) FROM nodes').fetchone()[0]
    # Only explicit ownership/reference evidence; never guess from names or
    # source-coordinate nesting. Preserve all alternatives, not an arbitrary one.
    db.execute('''CREATE TABLE owner_evidence AS
        SELECT n.stable_id, o.stable_id AS target, 'owner-property' AS evidence
        FROM nodes n JOIN nodes o ON o.stable_id=n.owner_property WHERE n.stable_id<>o.stable_id
        UNION SELECT n.stable_id,o.stable_id,'sourceCallStableId'
        FROM nodes n JOIN nodes o ON o.stable_id=n.presentation_owner WHERE n.stable_id<>o.stable_id
        UNION SELECT r.from_id,r.to_id,r.rel_type FROM rels r
        JOIN nodes a ON a.stable_id=r.from_id JOIN nodes b ON b.stable_id=r.to_id
        WHERE r.rel_type IN ('ENCLOSED_BY','NESTED_IN') AND r.from_id<>r.to_id
        UNION SELECT r.to_id,r.from_id,r.rel_type FROM rels r
        JOIN nodes a ON a.stable_id=r.from_id JOIN nodes b ON b.stable_id=r.to_id
        WHERE r.rel_type IN ('HAS_PARAMETER','HAS_MEMBER','HAS_PROPERTY','COMPOSES_SYNTAX','HAS_OPERATION','HAS_FLOW_BLOCK','AST_CHILD')
          AND r.from_id<>r.to_id''')
    db.execute('''CREATE TABLE reference_evidence AS
        SELECT n.stable_id,o.stable_id AS target,'canonicalStableId' AS evidence
        FROM nodes n JOIN nodes o ON o.stable_id=n.original_property WHERE n.stable_id<>o.stable_id
        UNION SELECT r.from_id,r.to_id,r.rel_type FROM rels r
        JOIN nodes a ON a.stable_id=r.from_id JOIN nodes b ON b.stable_id=r.to_id
        WHERE r.rel_type IN ('RESOLVES_TO','RESOLVES_TO_MEMBER','PROXY_OF','ALIASES') AND r.from_id<>r.to_id''')
    db.execute('''CREATE TABLE body_evidence AS
        SELECT DISTINCT r.from_id AS stable_id,r.to_id AS target,r.rel_type AS evidence
        FROM rels r JOIN nodes a ON a.stable_id=r.from_id JOIN nodes b ON b.stable_id=r.to_id
        WHERE r.from_id<>r.to_id AND (r.rel_type IN ('HAS_OPERATION','HAS_FLOW_BLOCK','RETURNS_VALUE')
          OR (r.rel_type='AST_CHILD' AND (json_extract_string(r.props_json,'$.field')='body'
            OR json_extract_string(r.props_json,'$.projection')='nearest-function-operation')))
        UNION SELECT r.to_id,r.from_id,'ENCLOSED_BY:lexical-function-owner'
        FROM rels r JOIN nodes a ON a.stable_id=r.from_id JOIN nodes b ON b.stable_id=r.to_id
        WHERE r.from_id<>r.to_id AND r.rel_type='ENCLOSED_BY'
          AND json_extract_string(r.props_json,'$.resolution')='lexical-function-owner' ''')
    db.execute('''CREATE TABLE facts AS SELECT n.*,
        coalesce(o.targets,[]::VARCHAR[]) AS owners,
        coalesce(o.evidence,[]::VARCHAR[]) AS owner_evidence,
        coalesce(r.targets,[]::VARCHAR[]) AS originals,
        coalesce(r.evidence,[]::VARCHAR[]) AS original_evidence,
        coalesce(b.body_count,0) AS body_count,
        coalesce(b.targets,[]::VARCHAR[]) AS body_targets,
        coalesce(b.evidence,[]::VARCHAR[]) AS body_evidence,
        coalesce(s.member_count,0) AS member_count,
        coalesce(s.ast_count,0) AS ast_count,
        list_has_any(n.labels,['VisualProxy','PresentationOnly']) AS visual,
        list_has_any(n.labels,['Declaration','FunctionImplementation','TypeDeclaration']) OR
            (list_contains(n.labels,'Fn') AND NOT list_contains(n.labels,'Call')) AS definition,
        list_has_any(n.labels,['Reference','ValueReference','MemberReference','TypeReference','ResourceProxy']) AS reference,
        list_has_any(n.labels,['ExternalBoundary','ExternalDeclaration','SystemProvider']) AS external_boundary
        FROM nodes n LEFT JOIN
        (SELECT stable_id,list(DISTINCT target ORDER BY target) AS targets,
            list(DISTINCT evidence ORDER BY evidence) AS evidence FROM owner_evidence GROUP BY stable_id) o USING(stable_id)
        LEFT JOIN (SELECT stable_id,list(DISTINCT target ORDER BY target) AS targets,
            list(DISTINCT evidence ORDER BY evidence) AS evidence FROM reference_evidence GROUP BY stable_id) r USING(stable_id)
        LEFT JOIN (SELECT stable_id,count(DISTINCT target) AS body_count,
            list(DISTINCT target ORDER BY target) AS targets,
            list(DISTINCT evidence ORDER BY evidence) AS evidence FROM body_evidence GROUP BY stable_id) b USING(stable_id)
        LEFT JOIN (SELECT from_id AS stable_id,
            count(*) FILTER(WHERE rel_type IN ('HAS_MEMBER','HAS_PROPERTY')) AS member_count,
            count(*) FILTER(WHERE rel_type='AST_CHILD') AS ast_count
            FROM rels GROUP BY from_id) s USING(stable_id)''')
    # Rules produce candidates with a reason, not authoritative new labels.
    db.execute('''CREATE TABLE classified AS SELECT *, CASE
        WHEN visual AND len(owners)>0 THEN 'presentation-owned'
        WHEN visual THEN 'presentation-without-owner'
        WHEN external_boundary THEN 'external-boundary-catalog'
        WHEN definition AND (list_has_any(labels,['Fn','FunctionImplementation','Component','CallableDeclaration'])
            OR declaration_kind IN ('FunctionDeclaration','FunctionExpression','ArrowFunction','MethodDeclaration','Constructor','GetAccessor','SetAccessor'))
            AND body_count>0 THEN 'callable-with-body'
        WHEN definition AND (list_has_any(labels,['Fn','FunctionImplementation','Component','CallableDeclaration'])
            OR declaration_kind IN ('FunctionDeclaration','FunctionExpression','ArrowFunction','MethodDeclaration','Constructor','GetAccessor','SetAccessor'))
            THEN 'callable-body-not-confirmed'
        WHEN definition AND list_has_any(labels,['TypeDeclaration','EnumDeclaration','InterfaceDeclaration','TypeAliasDeclaration'])
            AND declaration_kind IN ('TypeAliasDeclaration','ClassDeclaration','InterfaceDeclaration','EnumDeclaration')
            AND name IS NOT NULL AND (member_count>0 OR ast_count>0) THEN 'declared-contract-with-structure'
        WHEN reference AND NOT definition AND len(originals)>0 THEN 'resolved-reference'
        WHEN list_contains(labels,'System') AND NOT definition AND len(owners)>0 THEN 'owned-system-syntax'
        WHEN reference AND NOT definition THEN 'unresolved-reference'
        WHEN definition AND list_contains(labels,'AliasDeclaration') AND len(originals)>0 THEN 'resolved-alias'
        WHEN list_contains(labels,'TypeDeclaration') AND len(owners)>0
            AND declaration_kind NOT IN ('TypeAliasDeclaration','ClassDeclaration','InterfaceDeclaration','EnumDeclaration') THEN 'owned-type-expression'
        WHEN list_has_any(labels,['Step','Block']) AND len(owners)>0 THEN 'owned-step-or-block'
        WHEN definition AND list_has_any(labels,['StateValue','Storage','Cell','Setting','StatefulOperation'])
            THEN 'state-definition-needs-usage-review'
        WHEN list_has_any(labels,['Parameter','MemberDeclaration','TypeMember']) AND len(owners)>0 THEN 'owned-parameter-or-member'
        WHEN list_contains(labels,'ValueDeclaration') AND len(owners)>0 THEN 'owned-value-declaration'
        WHEN list_contains(labels,'ValueDeclaration') THEN 'value-declaration-without-owner'
        WHEN definition THEN 'definition-without-body-or-structure'
        WHEN len(owners)>0 THEN 'owned-operation-or-syntax'
        ELSE 'no-ownership-or-reference-evidence' END AS reason FROM facts''')
    db.execute('''CREATE TABLE candidates AS SELECT *, CASE
        WHEN reason IN ('callable-with-body','declared-contract-with-structure') THEN 'standalone'
        WHEN reason IN ('resolved-reference','resolved-alias','external-boundary-catalog') THEN 'reference'
        WHEN reason IN ('presentation-owned','owned-step-or-block','owned-parameter-or-member',
            'owned-value-declaration','owned-operation-or-syntax','owned-system-syntax','owned-type-expression') THEN 'inline'
        ELSE 'unresolved' END AS mode,
        CASE WHEN external_boundary THEN 'external-catalog'
             WHEN reason='presentation-owned' THEN 'presentation-only'
             ELSE 'developer-context' END AS context_kind FROM classified''')
    dest = str(args.output / 'subjects.parquet').replace("'", "''")
    db.execute(f'''COPY (SELECT stable_id,labels,name,file,declaration_kind,annotation_kind,
        mode,reason,context_kind,owners,owner_evidence,originals,original_evidence,body_count,body_targets,body_evidence,member_count,ast_count
        FROM candidates ORDER BY stable_id) TO '{dest}' (FORMAT PARQUET, COMPRESSION ZSTD)''')
    counts = dict(db.execute('SELECT mode,count(*) FROM candidates GROUP BY mode ORDER BY mode').fetchall())
    assert sum(counts.values()) == count
    assert db.execute("SELECT count(*) FROM candidates WHERE mode='inline' AND len(owners)=0").fetchone()[0] == 0
    assert db.execute("SELECT count(*) FROM candidates WHERE mode='reference' AND NOT external_boundary AND len(originals)=0").fetchone()[0] == 0
    assert db.execute("SELECT count(*) FROM candidates WHERE mode='standalone' AND (visual OR NOT definition)").fetchone()[0] == 0
    reasons = []
    for reason, mode, size in db.execute('SELECT reason,mode,count(*) FROM candidates GROUP BY reason,mode ORDER BY count(*) DESC').fetchall():
        rows = db.execute('''SELECT stable_id,name,file,labels,declaration_kind,owners,originals,
            body_count,body_targets,body_evidence,member_count,ast_count,substring(syntax,1,500) AS syntax
            FROM candidates WHERE reason=? ORDER BY stable_id LIMIT 4''', [reason])
        names = [d[0] for d in rows.description]
        reasons.append({'reason': reason, 'mode': mode, 'count': size,
                        'examples': [dict(zip(names,row)) for row in rows.fetchall()]})
    report = {'version':4,'kind':'annotation-subject-candidate-inventory','generatesAnnotations':False,
        'writesGraph':False,'generationQueueCertified':False,'existingAnnotationFreshnessChecked':False,
        'input':str(args.parquet.resolve()),'provenanceIds':[r[0] for r in db.execute('SELECT DISTINCT provenance_id FROM nodes').fetchall()],
        'nodes':count,'counts':counts,'reasons':reasons,
        'multipleOwnerCandidates':db.execute('SELECT count(*) FROM candidates WHERE len(owners)>1').fetchone()[0],
        'multipleOriginalCandidates':db.execute('SELECT count(*) FROM candidates WHERE len(originals)>1').fetchone()[0],
        'limitations':['Candidate policies require review, especially state, settings and local declarations.',
            'All owner/reference alternatives retained; inline allocation does not choose a unique owner.',
            'External boundary is a catalog candidate, not proof that documentation exists.',
            'Direct originals are not recursively deduplicated; candidate count is not generation cost.',
            'Existing annotation availability and freshness have not been subtracted.'],
        'elapsedSeconds':round(time.perf_counter()-start,3)}
    (args.output/'summary.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    db.close()
    subprocess.run([sys.executable, str(Path(__file__).with_name('auditUnconfirmedCallableBodies.py')),
        '--report', str(args.output)], check=True)
    body_audit = json.loads((args.output/'body-audit.json').read_text(encoding='utf-8'))
    report['bodyAudit'] = {k:v for k,v in body_audit.items() if k!='subjects'}
    report['elapsedSeconds'] = round(time.perf_counter()-start,3)
    (args.output/'summary.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k!='reasons'},ensure_ascii=False),flush=True)


if __name__=='__main__':
    main()
