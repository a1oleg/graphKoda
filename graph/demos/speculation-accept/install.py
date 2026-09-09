"""Atomically install and verify the authored Bloom demo without APOC."""

import json
from pathlib import Path
import subprocess

from dotenv import dotenv_values
from neo4j import GraphDatabase


def verify(tx, directory):
    for filename, expected in [
        ('bloom-stage-1.cypher', (4, 3)),
        ('bloom-stage-2.cypher', (16, 14)),
        ('run.cypher', (16, 15)),
        ('reset.cypher', (4, 3)),
    ]:
        rows = list(tx.run((directory / filename).read_text(encoding='utf-8')))
        nodes = {n.element_id for row in rows for n in (row['n'], row['m']) if n is not None}
        edges = {row['r'].element_id for row in rows if row['r'] is not None}
        assert (len(nodes), len(edges)) == expected, (filename, len(nodes), len(edges))
        print(f'{filename}: {len(nodes)} nodes, {len(edges)} relationships; passed')
    rows = list(tx.run("MATCH (n:ColdKodeDemoNode {demoId: 'speculation-accept'}) RETURN n"))
    assert len(rows) == 16
    assert len({(row['n']['x'], row['n']['y']) for row in rows}) == 16
    for row in rows:
        n = row['n']
        assert n['x'] == (n['stage'] - 1) * 1000
        assert n['y'] == n['ordinal'] * -180
        assert n['revealTag'] == ('01_primary' if n['stage'] == 1 else '02_secondary')
        assert ('DemoStage1' in n.labels) == (n['stage'] == 1)
        assert ('DemoStage2' in n.labels) == (n['stage'] == 2)
    primary = list(tx.run('MATCH (n:DemoStage1) RETURN n.key AS key'))
    assert {row['key'] for row in primary} == {'primary', 'input', 'helpers', 'specAcc'}
    assert len(primary) == 4
    assert tx.run('MATCH (n:DemoStage2) RETURN count(n) AS total').single()['total'] == 12
    edges = list(tx.run(
        "MATCH (a:ColdKodeDemoNode {demoId: 'speculation-accept'})-[r]->"
        "(b:ColdKodeDemoNode {demoId: 'speculation-accept'}) RETURN a, r, b"
    ))
    assert len(edges) == 15
    for row in edges:
        a, r, b = row['a'], row['r'], row['b']
        if r.type == 'NEXT':
            assert a['x'] == b['x'] and b['ordinal'] == a['ordinal'] + 1
            assert r['revealTag'] == a['revealTag']
        else:
            assert r.type == 'VALUE_FROM'
            assert (a['key'], b['key'], r['revealTag']) == ('specAcc', 'object', '03_origin')
            assert r['derived'] and r['authored']


def main():
    directory = Path(__file__).resolve().parent
    root = directory.parents[2]
    settings = dotenv_values(root / 'graph' / '.env')
    roots = json.loads(subprocess.check_output(
        ['node', '-p', 'JSON.stringify(require("./dev/projectPaths.cjs"))'],
        cwd=root, text=True,
    ))
    revision = subprocess.check_output(
        ['git', '-C', roots['sourceRoot'], 'rev-parse', 'HEAD'], text=True
    ).strip()
    if revision != 'af272b9e82955330836f9354229c0a8453c3a3da':
        raise RuntimeError('Review authored demo locations for this source revision')
    query = (directory / 'bake.cypher').read_text(encoding='utf-8')
    with GraphDatabase.driver(
        settings['NEO4J_URI'],
        auth=(settings['NEO4J_USERNAME'], settings['NEO4J_PASSWORD']),
    ) as driver:
        with driver.session(database=settings['NEO4J_DATABASE']) as session:
            with session.begin_transaction() as tx:
                tx.run(
                    "MERGE (d:ColdKodeDemo {id: 'speculation-accept'}) "
                    "SET d.sourceRevision = $revision, d.authored = true, "
                    "d.name = 'speculationAccept demo'", revision=revision,
                ).consume()
                tx.run(query).consume()
                verify(tx, directory)
                before = {row['id'] for row in tx.run(
                    "MATCH (n:ColdKodeDemoNode {demoId: 'speculation-accept'}) RETURN elementId(n) AS id"
                )}
                # Reinstall preserves node IDs used by saved Bloom Scenes.
                tx.run(query).consume()
                verify(tx, directory)
                after = {row['id'] for row in tx.run(
                    "MATCH (n:ColdKodeDemoNode {demoId: 'speculation-accept'}) RETURN elementId(n) AS id"
                )}
                assert before == after
                tx.commit()
            print('Installed: 16 nodes, 14 NEXT, 1 VALUE_FROM; no APOC required.')


if __name__ == '__main__':
    main()
