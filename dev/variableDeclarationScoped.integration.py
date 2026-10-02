"""Verify declaration containers survive actual scoped extraction transport."""
import json
import sys
import subprocess
import tempfile
import duckdb
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'graph/static-extract/py'))
from fromPreGraphToNeo4j import run_scoped_extractor

payload = run_scoped_extractor('src/api/gramjs/ChatAbortController.ts:6:2:13:3')
entities = {e['stableId']: e for e in payload['semanticEntities']}
declaration = 'src/api/gramjs/ChatAbortController.ts:7:8:7:47'
parents = [e for e in payload['semanticRelationships']
           if e['type'] == 'AST_CHILD' and e['toId'] == declaration
           and e['props'].get('field') == 'declarations']
assert len(parents) == 1, parents
owner = parents[0]['fromId']
assert 'DeclarationContainer' in entities[owner]['labels'], entities[owner]
parents_by_child = {e['fromId']: e['toId'] for e in payload['semanticRelationships']
                    if e['type'] == 'ENCLOSED_BY'
                    and e['props'].get('resolution') == 'nearest-materialized-ast-owner'}
current = owner
path = [declaration, owner]
while current in parents_by_child:
    current = parents_by_child[current]
    assert current not in path, path
    assert current in entities, current
    path.append(current)
assert current == 'src/api/gramjs/ChatAbortController.ts:6:2:13:3', path
assert any(e['type'] == 'VALUE_FROM' and e['fromId'] == declaration
           for e in payload['semanticRelationships'])
with tempfile.TemporaryDirectory(prefix='declaration-ownership-') as temporary:
    snapshot = Path(temporary)/'snapshot'
    report = Path(temporary)/'report'
    snapshot.mkdir()
    db = duckdb.connect()
    db.execute('CREATE TABLE nodes(stable_id VARCHAR,labels VARCHAR[],props_json VARCHAR,provenance_id VARCHAR)')
    db.executemany('INSERT INTO nodes VALUES (?,?,?,?)', [
        (e['stableId'], e['labels'], json.dumps(e.get('props', {})), 'actual-scoped-extraction')
        for e in payload['semanticEntities']])
    db.execute('CREATE TABLE relationships(from_id VARCHAR,to_id VARCHAR,rel_type VARCHAR,props_json VARCHAR)')
    db.executemany('INSERT INTO relationships VALUES (?,?,?,?)', [
        (e['fromId'], e['toId'], e['type'], json.dumps(e.get('props', {})))
        for e in payload['semanticRelationships']])
    for table in ('nodes', 'relationships'):
        db.execute(f"COPY {table} TO '{(snapshot/(table+'.parquet')).as_posix()}' (FORMAT PARQUET)")
    subprocess.run([sys.executable, str(Path(__file__).with_name('inventoryAnnotationSubjects.py')),
                    '--parquet', str(snapshot), '--output', str(report)], check=True, stdout=subprocess.PIPE)
    db.read_parquet(str(report/'annotation-plan.parquet')).create_view('plan')
    for child, parent in zip(path, path[1:]):
        actual = db.execute('SELECT decision,context_targets FROM plan WHERE stable_id=?', [child]).fetchone()
        assert actual == ('compose-in-owner', [parent]), (child, actual, parent)
    db.close()
print(json.dumps({'ok': True, 'declaration': declaration, 'owner': owner, 'path': path}))
