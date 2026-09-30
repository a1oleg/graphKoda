"""Check actual scoped transport for object and array binding ownership."""
import sys
import json
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'graph/static-extract/py'))
from fromPreGraphToNeo4j import run_scoped_extractor

for fn, binding in [
    ('src/api/gramjs/apiBuilders/bots.ts:160:7:176:1','src/api/gramjs/apiBuilders/bots.ts:162:14:162:19'),
    ('src/api/gramjs/apiBuilders/statistics.ts:160:7:208:1','src/api/gramjs/apiBuilders/statistics.ts:180:9:180:10'),
]:
    payload = run_scoped_extractor(fn)
    entities = {e['stableId']:e for e in payload['semanticEntities']}
    ast = [e for e in payload['semanticRelationships'] if e['type']=='AST_CHILD']
    owners = {e['fromId'] for e in ast if e['toId']==binding and e['props'].get('field')=='elements'}
    assert len(owners)==1,(binding,owners)
    pattern = next(iter(owners))
    assert 'BindingPattern' in entities[pattern]['labels'],entities[pattern]
    declarations = {e['fromId'] for e in ast if e['toId']==pattern and e['props'].get('field')=='name'}
    assert len(declarations)==1,(pattern,declarations)
    assert all(i in entities for i in declarations)
    assert any(e['fromId']==binding and e['type']=='READS_FROM' for e in payload['semanticRelationships'])
    print(json.dumps({'function':fn,'binding':binding,'pattern':pattern,'declaration':next(iter(declarations)),'ok':True}))
