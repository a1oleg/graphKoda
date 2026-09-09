import os
import unittest
import uuid
from dotenv import load_dotenv
from neo4j import GraphDatabase
from extraction_provenance import check_scoped_provenance, register_provenance
from fromPreGraphToNeo4j import write_labeled_nodes, write_edges


@unittest.skipUnless(os.getenv('TEST_NEO4J_PROVENANCE') == '1', 'requires local Neo4j; transaction is rolled back')
class Neo4jProvenanceTests(unittest.TestCase):
    def test_import_metadata_and_conflict_detection_in_rolled_back_transaction(self):
        load_dotenv('graph/.env')
        record=dict(id=uuid.uuid4().hex*2,extractor_commit='b'*40,source_revision='c'*40,
                    extractor_dirty_fingerprint=None,source_dirty_fingerprint=None,extracted_at='2026-09-09T00:00:00Z')
        prefix='provenance-test:'+uuid.uuid4().hex
        driver=GraphDatabase.driver(os.environ['NEO4J_URI'],auth=(os.getenv('NEO4J_USER') or os.environ['NEO4J_USERNAME'],os.environ['NEO4J_PASSWORD']))
        try:
            with driver.session(database=os.getenv('NEO4J_DATABASE','neo4j')) as session:
                tx=session.begin_transaction()
                try:
                    register_provenance(tx,[record])
                    props={'provenance_id':record['id'],'source':'semantic/functionFlowGraph'}
                    nodes=[dict(stableId=prefix+str(index),labels=['CodeEntity'],props=props) for index in range(2)]
                    write_labeled_nodes(tx,nodes,bulk=False)
                    write_edges(tx,[dict(fromId=nodes[0]['stableId'],toId=nodes[1]['stableId'],type='VALUE_FROM',props=props)],bulk=False)
                    row=tx.run('MATCH (a {stableId:$id})-[r:VALUE_FROM]->() RETURN a.provenance_id AS node, r.provenance_id AS edge',id=nodes[0]['stableId']).single()
                    self.assertEqual(row['node'],record['id']);self.assertEqual(row['edge'],record['id'])
                    check_scoped_provenance(tx,{'provenance':record,'semanticEntities':nodes})
                    tx.run('MATCH (n {stableId:$id}) REMOVE n.provenance_id',id=nodes[0]['stableId']).consume()
                    with self.assertRaises(ValueError):check_scoped_provenance(tx,{'provenance':record,'semanticEntities':nodes})
                finally:tx.rollback()
        finally:driver.close()


if __name__=='__main__': unittest.main()
