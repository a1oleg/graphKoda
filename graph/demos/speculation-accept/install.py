"""Install and transactionally verify the authored Aura Browser demo."""

from pathlib import Path
import subprocess

from dotenv import dotenv_values
from neo4j import GraphDatabase


def main():
    directory = Path(__file__).resolve().parent
    root = directory.parents[2]
    settings = dotenv_values(root / 'graph' / '.env')
    source = root.parent / 'claude-code-source'
    revision = subprocess.check_output(
        ['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True
    ).strip()
    query = (directory / 'step.cypher').read_text(encoding='utf-8')
    runner = (directory / 'run.cypher').read_text(encoding='utf-8')
    reset = (directory / 'reset.cypher').read_text(encoding='utf-8')
    with GraphDatabase.driver(
        settings['NEO4J_URI'],
        auth=(settings['NEO4J_USERNAME'], settings['NEO4J_PASSWORD']),
    ) as driver:
        with driver.session(database=settings['NEO4J_DATABASE']) as session:
            session.run(
                "MERGE (d:ColdKodeDemo {id: 'speculation-accept'}) "
                "ON CREATE SET d.clicks = 0 "
                "SET d.query = $script, d.sourceRevision = $revision, "
                "d.authored = true, d.name = 'speculationAccept demo'",
                script=query, revision=revision,
            ).consume()
            # Exercise writes and reset without advancing the user's demo.
            with session.begin_transaction() as tx:
                tx.run(reset).consume()
                for click, expected in enumerate([(4, 3), (16, 14), (16, 15), (16, 15)], 1):
                    rows = list(tx.run(runner))
                    nodes = {n.element_id for row in rows for n in (row['n'], row['m']) if n is not None}
                    relationships = {row['r'].element_id for row in rows if row['r'] is not None}
                    assert (len(nodes), len(relationships)) == expected, (click, len(nodes), len(relationships))
                    assert {row['step'] for row in rows} == {min(click, 3)}
                    origins = tx.run(
                        "MATCH (:ColdKodeDemoNode {demoId: 'speculation-accept'})-[r]->() "
                        "WHERE r.stage = 3 RETURN count(r) AS total"
                    ).single()['total']
                    assert origins == int(click >= 3)
                    print(f'Click {click}: {len(nodes)} nodes, {len(relationships)} relationships; passed')
                tx.run(reset).consume()
                assert tx.run("MATCH (n:ColdKodeDemoNode {demoId: 'speculation-accept'}) RETURN count(n) AS total").single()['total'] == 0
                tx.rollback()
            print('Installed. Verification rolled back; existing demo progress preserved.')


if __name__ == '__main__':
    main()
