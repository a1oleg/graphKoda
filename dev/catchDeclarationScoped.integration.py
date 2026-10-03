"""Verify catch ownership through actual scoped extraction transport."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'graph/static-extract/py'))
from fromPreGraphToNeo4j import run_scoped_extractor

function = 'src/api/gramjs/methods/bots.ts:480:7:497:1'
binding = 'src/api/gramjs/methods/bots.ts:491:11:491:14'
payload = run_scoped_extractor(function)
entities = {e['stableId']: e for e in payload['semanticEntities']}
parents = [e for e in payload['semanticRelationships'] if e['type'] == 'AST_CHILD'
           and e['toId'] == binding and e['props'].get('field') == 'variableDeclaration']
assert len(parents) == 1, parents
parent = parents[0]['fromId']
assert entities[parent]['props']['syntaxKind'] == 'CatchClause', entities[parent]
assert 'DeclarationContainer' in entities[parent]['labels'], entities[parent]
owners = {e['fromId']: e['toId'] for e in payload['semanticRelationships']
          if e['type'] == 'ENCLOSED_BY'
          and e['props'].get('resolution') == 'nearest-materialized-ast-owner'}
path = [binding, parent]
while parent in owners:
    parent = owners[parent]
    assert parent in entities and parent not in path, (parent, path)
    path.append(parent)
assert parent == function, path
print(json.dumps({'ok': True, 'path': path}))
