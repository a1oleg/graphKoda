import sys
import json
import tempfile
from pathlib import Path
import unittest

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq


sys.path.insert(0, str(Path(__file__).resolve().parent))

from function_flow_catalog import FunctionFlowCatalog


class FunctionFlowCatalogTest(unittest.TestCase):
    def test_reads_catalog_counts_and_batches(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            parquet_dir = root / 'parquet'
            parquet_dir.mkdir()
            provenance = dict(id='a'*64, extractor_commit='b'*40, source_revision='c'*40,
                              extractor_dirty_fingerprint=None, source_dirty_fingerprint=None,
                              extracted_at='2026-09-09T00:00:00Z')
            metadata = json.dumps(provenance)
            pq.write_table(pa.Table.from_pylist([{'id':provenance['id'],'metadata_json':metadata}]), parquet_dir / 'provenance.parquet')
            pq.write_table(pa.Table.from_pylist([{
                'stable_id': 'a',
                'labels': ['Fn'],
                'props_json': '{"name":"a"}',
                'provenance_id': provenance['id'],
            }]), parquet_dir / 'nodes.parquet')
            pq.write_table(pa.Table.from_pylist([{
                'signature': 'a\u0000NEXT\u0000a',
                'from_id': 'a',
                'to_id': 'a',
                'rel_type': 'NEXT',
                'props_json': '{"source":"test"}',
                'provenance_id': provenance['id'],
            }]), parquet_dir / 'relationships.parquet')
            database_path = root / 'facts.duckdb'
            connection = duckdb.connect(str(database_path))
            connection.execute('CREATE TABLE extraction_provenance (id VARCHAR, metadata_json VARCHAR)')
            connection.execute('INSERT INTO extraction_provenance VALUES (?, ?)', [provenance['id'],metadata])
            connection.execute('CREATE TABLE staging_stats (name VARCHAR PRIMARY KEY, value BIGINT)')
            connection.execute("INSERT INTO staging_stats VALUES ('canonicalEntities', 1), ('canonicalRelationships', 1)")
            connection.close()

            catalog = FunctionFlowCatalog(database_path, parquet_dir)
            try:
                self.assertEqual(catalog.counts(), {
                    'canonicalEntities': 1,
                    'canonicalRelationships': 1,
                })
                self.assertEqual(next(catalog.iter_entities(10))[0], {
                    'stableId': 'a',
                    'labels': ['Fn'],
                    'props': {'name': 'a', 'provenance_id': provenance['id']},
                })
                self.assertEqual(next(catalog.iter_relationships(10))[0], {
                    'fromId': 'a',
                    'toId': 'a',
                    'type': 'NEXT',
                    'props': {'source': 'test', 'provenance_id': provenance['id']},
                })
            finally:
                catalog.close()
            connection = duckdb.connect(str(database_path))
            connection.execute('DROP TABLE extraction_provenance')
            connection.close()
            with self.assertRaisesRegex(RuntimeError, 're-extract legacy'):
                FunctionFlowCatalog(database_path, parquet_dir)

    def test_rejects_missing_catalog(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            with self.assertRaisesRegex(RuntimeError, 'catalog is missing'):
                FunctionFlowCatalog(root / 'missing.duckdb', root / 'parquet')


if __name__ == '__main__':
    unittest.main()
