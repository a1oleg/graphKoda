"""Materialize extractor Step headers as two Bloom presentation axes."""
import argparse
import json
import subprocess
from pathlib import Path

from dotenv import dotenv_values
from neo4j import GraphDatabase

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
DEMO = 'speculation-accept'
FUNCTIONS = [('primary', 'REPL.onSubmit', 'screens/REPL.tsx:3142:31:3533:3'),
             ('secondary', 'PromptInput.onSubmit', 'components/PromptInput/PromptInput.tsx:984:31:1105:3')]


def code_properties(node):
    """A small, flat subset of the extractor contract, suitable for Bloom cards."""
    fields = ('annotationKind', 'data_flow_role', 'flow_layer', 'argument_name',
              'argument_index', 'callee_name', 'invocation_mode', 'response_mode',
              'repo_relative_path', 'start_line', 'start_column', 'end_line', 'end_column')
    props = {k: node['props'][k] for k in fields if k in node.get('props', {})}
    content = node.get('actionTextRaw') or node.get('callTextRaw') or node.get('conditionRaw')
    if not content:
        lines = Path(node['filePath']).read_text(encoding='utf-8').splitlines(keepends=True)
        start, end = node['startLine'] - 1, node['endLine'] - 1
        # Extractor columns are zero-based TypeScript UTF-16 offsets.
        def part(line, a=0, b=None):
            return line.encode('utf-16-le')[a*2:None if b is None else b*2].decode('utf-16-le')
        content = (part(lines[start], node['startColumn'], node['endColumn']) if start == end else
                   part(lines[start], node['startColumn']) + ''.join(lines[start+1:end]) +
                   part(lines[end], 0, node['endColumn']))
    # Keep readable code excerpts, not a complete enclosing function body.
    excerpt = '\n'.join(content.splitlines()[:24])[:3000]
    props.update(content=excerpt, contentTruncated=excerpt != content.replace('\r\n', '\n'),
                 labels=node.get('labels', []))
    return props


def project(payloads):
    lanes = []
    for stage, (payload, (key, title, owner)) in enumerate(zip(payloads, FUNCTIONS), 1):
        index = {n['stableId']: n for n in payload['nodes']}
        steps = sorted((n for n in payload['nodes'] if 'Step' in n.get('labels', [])
                        and n.get('parentFnStableId') == owner),
                       key=lambda n: (n['startLine'], n['startColumn'], n['flowStepOrder'], n['stableId']))
        assert steps, owner
        fn = next(n for n in payload['functions'] if n['stableId'] == owner)
        lane = [dict(**code_properties(fn), key=key, name=title, sourceStableId=owner, visualKind='call',
                     line=fn['startLine'], nodeKind='function')]
        for step in steps:
            head = index[step['syntaxEntryStableId']]
            labels = set(head.get('labels', []))
            value = bool(labels & {'Parameter', 'ValueSlot', 'Variable', 'LocalBinding', 'ValueCreate', 'ValueWrite'})
            heading = head.get('diaName') or head.get('operationSubjectText') or head.get('label') or step['label']
            heading = ' '.join(heading.split())
            step_key = step['stableId']
            if stage == 1 and 'Parameter' in labels:
                step_key = {'input': 'input', 'helpers': 'helpers', 'speculationAccept': 'specAcc'}.get(head.get('label'), step_key)
            # Keep the one origin anchor required by the demo, on the axis;
            # no argument fields, expression mosaic or side-call graph is expanded.
            if stage == 2 and step['startLine'] == 1021:
                objects = [n for n in payload['nodes'] if n.get('parentStepStableId') == step['stableId']
                           and n.get('startLine') == 1025 and {'ObjectBrace', 'Open'} <= set(n.get('labels', []))]
                assert len(objects) == 1
                lane.append(dict(**code_properties(objects[0]), key='object', name='{ state, speculationSessionTimeSavedMs, setAppState }',
                                 sourceStableId=objects[0]['stableId'], sourceStepStableId=step['stableId'],
                                 visualKind='value', nodeKind='origin', line=1025))
            lane.append(dict(**code_properties(head), key=step_key, name=heading, sourceStableId=head['stableId'],
                             sourceStepStableId=step['stableId'], flowStepKind=step['flowStepKind'],
                             visualKind='value' if value else 'call', nodeKind='step', line=step['startLine']))
        for ordinal, node in enumerate(lane):
            node.update(stage=stage, ordinal=ordinal, x=(stage-1)*1000, y=-180*ordinal,
                        axis=title, file=fn['repoRelativePath'], revealTag=f'0{stage}_' + key,
                        sourceRevision=payload['provenance']['source_revision'],
                        provenance_id=payload['provenance']['id'], authored=True,
                        scope='All extracted Step headers; source order, no horizontal expansion')
        lanes.append(lane)
    parameter = next(n for n in lanes[0] if n['key'] == 'specAcc')
    origin = next(n for n in lanes[1] if n['key'] == 'object')
    delta = parameter['y'] - origin['y']
    for n in lanes[1]:
        n['y'] += delta
    nodes = lanes[0] + lanes[1]
    edges = [dict(a=a['key'], b=b['key'], stage=a['stage']) for lane in lanes for a,b in zip(lane, lane[1:])]
    assert len({n['key'] for n in nodes}) == len(nodes)
    assert parameter['y'] == origin['y']
    return dict(nodes=nodes, edges=edges, counts=[len(lanes[0])*2-1, len(nodes)*2-2, len(nodes)*2-1],
                provenance=[p['provenance'] for p in payloads])


def install(data):
    settings = dotenv_values(ROOT / 'graph/.env')
    source_root = Path(json.loads((ROOT/'coldkode.local.json').read_text(encoding='utf-8'))['sourceRoot'])
    revision = subprocess.check_output(['git','-C',str(source_root),'rev-parse','HEAD'],text=True).strip()
    assert all(p['source_revision'] == revision for p in data['provenance']), 'Re-extract changed source revision'
    with GraphDatabase.driver(settings['NEO4J_URI'], auth=(settings['NEO4J_USERNAME'], settings['NEO4J_PASSWORD'])) as driver:
        with driver.session(database=settings['NEO4J_DATABASE']) as session, session.begin_transaction() as tx:
            backup = tx.run('MATCH (n {demoId:$demo}) RETURN properties(n) AS properties, labels(n) AS labels', demo=DEMO).data()
            if not (HERE / 'before-compact-properties.json').exists():
                (HERE / 'before-compact-properties.json').write_text(json.dumps(backup, ensure_ascii=False, indent=2), encoding='utf-8')
            # Replace only this demo's presentation chain; extractor facts are never modified.
            tx.run('MATCH (a {demoId:$demo})-[r]->(b {demoId:$demo}) DELETE r', demo=DEMO).consume()
            tx.run('MATCH (n {demoId:$demo}) WHERE NOT n.key IN $keys DETACH DELETE n', demo=DEMO, keys=[n['key'] for n in data['nodes']]).consume()
            old_labels = sorted({label for row in backup for label in row['labels']})
            for label in old_labels:
                escaped = label.replace('`', '``')
                tx.run(f'MATCH (n {{demoId:$demo}}) REMOVE n:`{escaped}`', demo=DEMO).consume()
            tx.run('''UNWIND $nodes AS item MERGE (n {demoId:$demo, key:item.key})
                SET n = item, n.demoId=$demo
                FOREACH (_ IN CASE WHEN item.stage=1 THEN [1] ELSE [] END | SET n:DemoStage1)
                FOREACH (_ IN CASE WHEN item.stage=2 THEN [1] ELSE [] END | SET n:DemoStage2)
            ''', nodes=data['nodes'], demo=DEMO).consume()
            tx.run('''UNWIND $edges AS e MATCH (a {demoId:$demo,key:e.a}), (b {demoId:$demo,key:e.b})
                MERGE (a)-[r:NEXT]->(b) SET r.stage=e.stage, r.authored=true, r.meaning='Extractor header source order; not a runtime trace'
            ''', demo=DEMO, edges=data['edges']).consume()
            tx.run('''MATCH (a {demoId:$demo,key:'specAcc'}), (b {demoId:$demo,key:'object'})
                MERGE (a)-[r:VALUE_FROM]->(b) SET r.stage=3, r.authored=true, r.derived=true,
                r.meaning='Argument object construction at PromptInput.tsx:1025', r.argumentIndex=2
            ''', demo=DEMO).consume()
            rows=tx.run('MATCH (n {demoId:$demo}) RETURN n.key AS key,n.x AS x,n.y AS y',demo=DEMO).data()
            assert len(rows)==len(data['nodes'])
            assert len({(n['x'],n['y']) for n in rows})==len(rows)
            bykey={n['key']:n for n in rows}
            assert bykey['specAcc']['y']==bykey['object']['y']
            count=tx.run('MATCH ( {demoId:$demo})-[r]->( {demoId:$demo}) RETURN count(r) AS n',demo=DEMO).single()['n']
            assert count==len(data['edges'])+1
            tx.commit()
    print(json.dumps(dict(nodes=len(data['nodes']), next=len(data['edges']), totals=data['counts'], alignedY=bykey['specAcc']['y'])))


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('primary'); parser.add_argument('secondary'); parser.add_argument('--install', action='store_true')
    args=parser.parse_args()
    data=project([json.loads(Path(p).read_text(encoding='utf-8')) for p in [args.primary,args.secondary]])
    (HERE/'steps-projection.json').write_text(json.dumps(data, ensure_ascii=False, indent=2),encoding='utf-8')
    if args.install: install(data)
    else: print(data['counts'])
