from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterator

import duckdb
import pyarrow.parquet as pq


class FunctionFlowCatalog:
    def __init__(self, database_path: Path, parquet_dir: Path):
        self.database_path = database_path.resolve()
        self.parquet_dir = parquet_dir.resolve()
        if not self.database_path.is_file():
            raise RuntimeError(f'DuckDB function-flow catalog is missing: {self.database_path}')
        for parquet_path in (self.entities_parquet_path, self.relationships_parquet_path):
            if not parquet_path.is_file():
                raise RuntimeError(f'Function-flow Parquet file is missing: {parquet_path}')
        self.connection = duckdb.connect(str(self.database_path), read_only=True)

    @property
    def entities_parquet_path(self) -> Path:
        return self.parquet_dir / 'nodes.parquet'

    @property
    def relationships_parquet_path(self) -> Path:
        return self.parquet_dir / 'relationships.parquet'

    def counts(self) -> dict[str, int]:
        return {
            str(name): int(value)
            for name, value in self.connection.execute(
                'SELECT name, value FROM staging_stats ORDER BY name'
            ).fetchall()
        }

    def iter_entities(self, batch_size: int) -> Iterator[list[dict[str, Any]]]:
        parquet = pq.ParquetFile(self.entities_parquet_path)
        for batch in parquet.iter_batches(batch_size=batch_size):
            yield [{
                'stableId': row['stable_id'],
                'labels': row['labels'],
                'props': json.loads(row['props_json']),
            } for row in batch.to_pylist()]

    def iter_relationships(self, batch_size: int) -> Iterator[list[dict[str, Any]]]:
        parquet = pq.ParquetFile(self.relationships_parquet_path)
        for batch in parquet.iter_batches(batch_size=batch_size):
            yield [{
                'fromId': row['from_id'],
                'toId': row['to_id'],
                'type': row['rel_type'],
                'props': json.loads(row['props_json']),
            } for row in batch.to_pylist()]

    def close(self) -> None:
        self.connection.close()
