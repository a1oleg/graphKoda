"""Audit actual unconfirmed callable bodies using graph evidence and compiler parsing."""
import argparse
from collections import Counter
import json
from pathlib import Path
import subprocess
import duckdb

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--report', type=Path, required=True)
parser.add_argument('--node', default='node')
args = parser.parse_args()
summary = json.loads((args.report / 'summary.json').read_text(encoding='utf-8'))
db = duckdb.connect()
db.execute("SET memory_limit='1GB'")
db.execute('SET threads=1')
db.read_parquet(str(args.report / 'subjects.parquet')).create_view('subjects')
db.read_parquet(str(Path(summary['input']) / 'nodes.parquet')).create_view('nodes')
db.read_parquet(str(Path(summary['input']) / 'relationships.parquet')).create_view('rels')
db.execute("CREATE TABLE candidates AS SELECT * FROM subjects WHERE reason='callable-body-not-confirmed'")
result = db.execute('''SELECT c.*, json_extract_string(n.props_json,'$.syntax') AS syntax
    FROM candidates c JOIN nodes n USING(stable_id) ORDER BY stable_id''')
names = [d[0] for d in result.description]
rows = [dict(zip(names, row)) for row in result.fetchall()]
parsed = subprocess.run([args.node, str(Path(__file__).with_name('inspectCallableSyntax.mjs'))],
    input=json.dumps(rows, ensure_ascii=False), text=True, encoding='utf-8', capture_output=True, check=True)
syntax = {row['stable_id']: row for row in json.loads(parsed.stdout)}
edges = db.execute('''SELECT r.from_id,r.to_id,r.rel_type,r.props_json,s.declaration_kind,s.body_count
    FROM rels r JOIN candidates c ON c.stable_id=r.from_id
    JOIN subjects s ON s.stable_id=r.to_id
    WHERE r.rel_type IN ('VALUE_FROM','AST_CHILD','PROXY_OF','RESOLVES_TO','CALLS','NEXT')''').fetchall()
outgoing = {}
for source, target, relation, props, kind, body_count in edges:
    outgoing.setdefault(source, []).append({'target': target, 'relation': relation,
        'properties': json.loads(props), 'targetKind': kind, 'targetBodyCount': body_count})
proxy_targets = dict(db.execute('''SELECT c.stable_id,target.stable_id FROM candidates c
    JOIN nodes n USING(stable_id)
    JOIN subjects target ON target.stable_id=json_extract_string(n.props_json,'$.calleeStableId')
    WHERE list_has_any(c.labels,['FunctionProxy','LocalFunctionProxy'])''').fetchall())
entries = {}
for owner, start, target in db.execute('''WITH RECURSIVE signature(owner,start,current) AS (
    SELECT a.from_id,a.to_id,a.to_id FROM rels a JOIN candidates c ON c.stable_id=a.from_id
    WHERE a.rel_type='NEXT' AND json_extract_string(a.props_json,'$.semantic_expansion')='function-entry'
    UNION
    SELECT s.owner,s.start,r.to_id FROM signature s JOIN rels r ON r.from_id=s.current
    WHERE r.rel_type IN ('SIGNATURE_PARAMETER','SIGNATURE_RETURN')
    ) SELECT s.owner,s.start,b.to_id FROM signature s
    JOIN rels b ON b.from_id=s.current AND b.rel_type='BODY_ENTRY'
    JOIN nodes n ON n.stable_id=b.to_id
    ''').fetchall():
    entries.setdefault(owner, []).append({'start': start, 'target': target})
steps = {}
for owner, step, entry, exists in db.execute('''SELECT c.stable_id,n.stable_id,
    json_extract_string(n.props_json,'$.syntaxEntryStableId'), target.stable_id IS NOT NULL
    FROM nodes n JOIN candidates c ON json_extract_string(n.props_json,'$.parentFnStableId')=c.stable_id
    LEFT JOIN nodes target ON target.stable_id=json_extract_string(n.props_json,'$.syntaxEntryStableId')
    WHERE list_contains(n.labels,'Step')''').fetchall():
    steps.setdefault(owner, []).append({'step': step, 'syntaxEntry': entry, 'entryExists': exists})
for row in rows:
    row.pop('syntax', None)
    row['syntaxAudit'] = syntax[row['stable_id']]
    row['outgoingEvidence'] = outgoing.get(row['stable_id'], [])
    row['bodyEntryPaths'] = entries.get(row['stable_id'], [])
    row['ownedSteps'] = steps.get(row['stable_id'], [])
    implementations = [edge for edge in row['outgoingEvidence'] if
        (edge['relation'] == 'VALUE_FROM' or (edge['relation'] == 'AST_CHILD' and edge['properties'].get('field') == 'initializer'))
        and edge['targetKind'] in ('ArrowFunction', 'FunctionExpression') and edge['targetBodyCount'] > 0]
    if 'External' in row['labels']:
        category = 'explicit-external-boundary'
    elif row['declaration_kind'] == 'VariableDeclaration' and implementations:
        category = 'binding-to-confirmed-implementation'
    elif 'FunctionProxy' in row['labels'] or 'LocalFunctionProxy' in row['labels']:
        row['proxyTarget'] = proxy_targets.get(row['stable_id'])
        category = 'function-proxy-resolved-by-property' if row['proxyTarget'] else 'function-proxy-needs-resolution'
    else:
        category = row['syntaxAudit']['status']
        if category == 'nonempty-body':
            category = 'body-confirmed-through-entry' if row['bodyEntryPaths'] else 'nonempty-body-without-entry'
    row['auditCategory'] = category
report = {'version': 1, 'inventoryVersion': summary['version'], 'provenanceIds': summary['provenanceIds'],
    'nodes': len(rows), 'counts': dict(Counter(row['auditCategory'] for row in rows)),
    'nonemptyBodiesWithMissingStepTargets': sum(row['syntaxAudit']['status']=='nonempty-body'
        and any(not step['entryExists'] for step in row['ownedSteps']) for row in rows),
    'writesGraph': False, 'note': 'Nonempty body means graph evidence needs investigation, not proven missing extraction.',
    'subjects': rows}
destination = args.report / 'body-audit.json'
destination.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({k: v for k, v in report.items() if k != 'subjects'}, ensure_ascii=False))
