"""Read-only preflight regression against actual Telegram payloads and Neo4j."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'graph/static-extract/py'))
from fromPreGraphToNeo4j import run_scoped_extractor, load_neo4j_settings
from extraction_provenance import check_scoped_provenance
from neo4j import GraphDatabase

settings = load_neo4j_settings()
cases = [
    ('src/components/left/LeftColumn.tsx:146:38:388:3', True),
    ('src/util/deeplink.ts:13:31:276:1', True),
    ('src/components/modals/gift/craft/GiftCraftModal.tsx:269:23:1636:1', True),
]
with GraphDatabase.driver(settings['uri'], auth=(settings['username'], settings['password'])) as driver:
    for fn, allowed in cases:
        payload = run_scoped_extractor(fn)
        with driver.session(database=settings['database']) as session:
            with session.begin_transaction() as transaction:
                try:
                    check_scoped_provenance(transaction, payload, fn_stable_id=fn)
                except ValueError as error:
                    assert not allowed, (fn, str(error))
                    assert 'Shared dependency changed outside scope' in str(error), str(error)
                    print(fn, 'blocked:', str(error))
                else:
                    assert allowed, 'Semantic shared-node conflict was incorrectly accepted'
                    print(fn, 'preflight passed; no writes')
                transaction.rollback()
