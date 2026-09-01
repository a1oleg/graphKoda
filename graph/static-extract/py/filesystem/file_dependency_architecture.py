from __future__ import annotations

import argparse
import sys
from typing import Any

from neo4j import GraphDatabase

from common import DEFAULT_FILE_DEPENDENCY_ARCHITECTURE_QUERY_ID
from common import DEFAULT_FILE_DEPENDENCY_ARCHITECTURE_SOURCE
from common import WORKSPACE_DIR
from common import get_head_commit_short
from common import load_settings
from neo4j_io import create_constraints as create_base_constraints
from neo4j_io import record_import_run


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Import folder dependency edges derived from IMPORTS_FILE into Neo4j.')
    parser.add_argument('--batch-size', type=int, default=500, help='Number of rows per Neo4j batch.')
    parser.add_argument('--append', action='store_true', help='Do not delete previously imported data from this source.')
    return parser.parse_args(argv)


def create_constraints(session: Any) -> None:
    create_base_constraints(session)


def clear_previous_import(session: Any) -> None:
    session.run(
        'MATCH ()-[rel:DEPENDS_ON_FOLDER]->() DELETE rel',
    ).consume()


def write_folder_dependency_batch(session: Any, rows: list[dict[str, Any]], commit_short: str) -> None:
    session.run(
        '''
        UNWIND $rows AS row
        MATCH (from_folder:Folder {path: row.from_folder_path})
        MATCH (to_folder:Folder {path: row.to_folder_path})
        MERGE (from_folder)-[rel:DEPENDS_ON_FOLDER]->(to_folder)
        SET rel.graph_recorded_commit_short = $commit
        ''',
        {
            'rows': rows,
            'commit': commit_short,
        },
    ).consume()


def load_folder_dependency_rows(session: Any) -> list[dict[str, Any]]:
    result = session.run(
        '''
        MATCH (source:File)-[rel:IMPORTS_FILE]->(target:File)
        WHERE source.parent_folder_path <> target.parent_folder_path
        RETURN source.parent_folder_path AS from_folder_path,
               target.parent_folder_path AS to_folder_path,
               count(rel) AS import_count,
               count(DISTINCT source) AS source_file_count,
               count(DISTINCT target) AS target_file_count,
               sum(CASE WHEN rel.import_kind = 'export-from' THEN 1 ELSE 0 END) AS reexport_count,
               sum(CASE WHEN rel.import_kind <> 'export-from' THEN 1 ELSE 0 END) AS runtime_import_count
        ORDER BY from_folder_path, to_folder_path
        '''
    )
    return [dict(record) for record in result]


def write_to_neo4j(batch_size: int, replace_existing: bool, commit_short: str) -> int:
    settings = load_settings()
    driver = GraphDatabase.driver(settings['uri'], auth=(settings['username'], settings['password']))
    try:
        with driver.session(database=settings['database']) as session:
            create_constraints(session)
            if replace_existing:
                clear_previous_import(session)

            folder_dependency_rows = load_folder_dependency_rows(session)

            for start in range(0, len(folder_dependency_rows), batch_size):
                write_folder_dependency_batch(session, folder_dependency_rows[start:start + batch_size], commit_short)

            record_import_run(
                session,
                source=DEFAULT_FILE_DEPENDENCY_ARCHITECTURE_SOURCE,
                graph_recorded_commit_short=commit_short,
                query_id=DEFAULT_FILE_DEPENDENCY_ARCHITECTURE_QUERY_ID,
                rows_written=len(folder_dependency_rows),
            )
            return len(folder_dependency_rows)
    finally:
        driver.close()


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    commit_short = get_head_commit_short(WORKSPACE_DIR)
    folder_dependencies_written = write_to_neo4j(args.batch_size, not args.append, commit_short)
    print(
        'Imported '
        f'{folder_dependencies_written} DEPENDS_ON_FOLDER edges into Neo4j '
        f'at commit {commit_short}.'
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))