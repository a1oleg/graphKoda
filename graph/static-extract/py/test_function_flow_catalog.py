import sys
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
            pq.write_table(pa.Table.from_pylist([{
                'stable_id': 'a',
                'labels': ['Fn'],
                'props_json': '{"name":"a"}',
            }]), parquet_dir / 'nodes.parquet')
            pq.write_table(pa.Table.from_pylist([{
                'signature': 'a\u0000NEXT\u0000a',
                'from_id': 'a',
                'to_id': 'a',
                'rel_type': 'NEXT',
                'props_json': '{"source":"test"}',
            }]), parquet_dir / 'relationships.parquet')
            database_path = root / 'facts.duckdb'
            connection = duckdb.connect(str(database_path))
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
                    'props': {'name': 'a'},
                })
                self.assertEqual(next(catalog.iter_relationships(10))[0], {
                    'fromId': 'a',
                    'toId': 'a',
                    'type': 'NEXT',
                    'props': {'source': 'test'},
                })
            finally:
                catalog.close()

    def test_rejects_missing_catalog(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            with self.assertRaisesRegex(RuntimeError, 'catalog is missing'):
                FunctionFlowCatalog(root / 'missing.duckdb', root / 'parquet')


if __name__ == '__main__':
    unittest.main()
