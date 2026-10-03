"""Check declaration-name ownership through real scoped extraction transport."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'graph/static-extract/py'))
from fromPreGraphToNeo4j import run_scoped_extractor

function = 'src/api/gramjs/ChatAbortController.ts:15:2:18:3'
declaration = 'src/api/gramjs/ChatAbortController.ts:15:21:15:39'
name = 'src/api/gramjs/ChatAbortController.ts:15:21:15:29'
payload = run_scoped_extractor(function)
entities = {entity['stableId']: entity for entity in payload['semanticEntities']}
edges = payload['semanticRelationships']
assert 'DeclarationName' in entities[name]['labels']
assert any(edge['fromId'] == declaration and edge['toId'] == name
           and edge['type'] == 'AST_CHILD' and edge['props'].get('field') == 'name'
           for edge in edges)
assert any(edge['fromId'] == function and edge['toId'] == declaration
           and edge['type'] == 'AST_CHILD' and edge['props'].get('field') == 'parameters'
           for edge in edges)
print(json.dumps({'ok': True, 'path': [name, declaration, function]}))
