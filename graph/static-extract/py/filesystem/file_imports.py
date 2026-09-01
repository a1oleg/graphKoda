from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from neo4j import GraphDatabase

from common import DEFAULT_FILE_IMPORT_QUERY_ID
from common import DEFAULT_FILE_IMPORT_SOURCE
from common import WORKSPACE_DIR
from common import get_head_commit_short
from common import load_settings
from neo4j_io import create_constraints as create_base_constraints
from neo4j_io import record_import_run


SCRIPT_DIR = Path(__file__).resolve().parent
TS_EXTRACTOR_PATH = SCRIPT_DIR.parent / 'ts' / 'fileImportGraph.ts'


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Import internal file-to-file module dependencies into Neo4j.')
    parser.add_argument('--batch-size', type=int, default=500, help='Number of rows per Neo4j batch.')
    parser.add_argument('--append', action='store_true', help='Do not delete previously imported data from this source.')
    return parser.parse_args(argv)


def run_extractor() -> dict[str, list[dict[str, Any]]]:
    npx_path = shutil.which('npx.cmd') or shutil.which('npx')
    if not npx_path:
        raise RuntimeError('npx was not found in PATH. Install Node.js/npm or run from a shell that exposes npx.')

    completed = subprocess.run(
        [npx_path, '--no-install', 'tsx', str(TS_EXTRACTOR_PATH)],
        cwd=str(WORKSPACE_DIR),
        check=True,
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
    )
    return json.loads(completed.stdout)


def create_constraints(session: Any) -> None:
    create_base_constraints(session)


def normalize_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized_rows: list[dict[str, Any]] = []
    workspace_root = WORKSPACE_DIR.resolve()

    for row in rows:
        from_file_path = row['fromFilePath']
        to_file_path = row['toFilePath']
        from_parent_folder_path = Path(from_file_path).parent.resolve()
        to_parent_folder_path = Path(to_file_path).parent.resolve()
        normalized_rows.append({
            **row,
            'fromFileName': Path(from_file_path).name,
            'toFileName': Path(to_file_path).name,
            'fromParentFolderPath': str(from_parent_folder_path).replace('\\', '/'),
            'toParentFolderPath': str(to_parent_folder_path).replace('\\', '/'),
            'fromParentFolderRelativePath': '.'
            if from_parent_folder_path == workspace_root
            else from_parent_folder_path.relative_to(workspace_root).as_posix(),
            'toParentFolderRelativePath': '.'
            if to_parent_folder_path == workspace_root
            else to_parent_folder_path.relative_to(workspace_root).as_posix(),
            'fromParentFolderName': WORKSPACE_DIR.name if from_parent_folder_path == workspace_root else from_parent_folder_path.name,
            'toParentFolderName': WORKSPACE_DIR.name if to_parent_folder_path == workspace_root else to_parent_folder_path.name,
            'fromParentFolderDepth': 0
            if from_parent_folder_path == workspace_root
            else len(from_parent_folder_path.relative_to(workspace_root).as_posix().split('/')),
            'toParentFolderDepth': 0
            if to_parent_folder_path == workspace_root
            else len(to_parent_folder_path.relative_to(workspace_root).as_posix().split('/')),
            'fromParentFolderIsWorkspaceRoot': from_parent_folder_path == workspace_root,
            'toParentFolderIsWorkspaceRoot': to_parent_folder_path == workspace_root,
        })

    return normalized_rows


def clear_previous_import(session: Any) -> None:
    session.run('MATCH ()-[rel:IMPORTS_FILE]->() DELETE rel').consume()


def write_batch(session: Any, rows: list[dict[str, Any]], commit_short: str) -> None:
    session.run(
        '''
        UNWIND $rows AS row
        MERGE (from_folder:Folder {path: row.fromParentFolderPath})
        SET from_folder.relative_path = row.fromParentFolderRelativePath,
            from_folder.name = row.fromParentFolderName,
            from_folder.depth = row.fromParentFolderDepth,
            from_folder.is_workspace_root = row.fromParentFolderIsWorkspaceRoot,
            from_folder.graph_recorded_commit_short = coalesce(from_folder.graph_recorded_commit_short, $commit)
        MERGE (to_folder:Folder {path: row.toParentFolderPath})
        SET to_folder.relative_path = row.toParentFolderRelativePath,
            to_folder.name = row.toParentFolderName,
            to_folder.depth = row.toParentFolderDepth,
            to_folder.is_workspace_root = row.toParentFolderIsWorkspaceRoot,
            to_folder.graph_recorded_commit_short = coalesce(to_folder.graph_recorded_commit_short, $commit)
        MERGE (from_file:File {path: row.fromFilePath})
        SET from_file.stableId = 'file:' + row.fromRepoRelativePath,
            from_file.relative_path = row.fromRepoRelativePath,
            from_file.name = row.fromFileName,
            from_file.parent_folder_path = row.fromParentFolderPath,
            from_file.graph_recorded_commit_short = coalesce(from_file.graph_recorded_commit_short, $commit)
        MERGE (from_file)-[:IN_FOLDER]->(from_folder)
        MERGE (to_file:File {path: row.toFilePath})
        SET to_file.stableId = 'file:' + row.toRepoRelativePath,
            to_file.relative_path = row.toRepoRelativePath,
            to_file.name = row.toFileName,
            to_file.parent_folder_path = row.toParentFolderPath,
            to_file.graph_recorded_commit_short = coalesce(to_file.graph_recorded_commit_short, $commit)
        MERGE (to_file)-[:IN_FOLDER]->(to_folder)
        MERGE (from_file)-[rel:IMPORTS_FILE {import_key: row.key}]->(to_file)
        SET rel.module_specifier = row.moduleSpecifier,
            rel.import_kind = row.importKind,
            rel.clause_kind = row.clauseKind,
            rel.is_type_only = row.isTypeOnly,
            rel.line = row.line,
            rel.column = row.column,
            rel.graph_recorded_commit_short = $commit
        ''',
        {
            'rows': rows,
            'commit': commit_short,
        },
    ).consume()


def write_to_neo4j(rows: list[dict[str, Any]], replace_existing: bool, commit_short: str, batch_size: int) -> None:
    settings = load_settings()
    driver = GraphDatabase.driver(settings['uri'], auth=(settings['username'], settings['password']))
    try:
        with driver.session(database=settings['database']) as session:
            create_constraints(session)
            if replace_existing:
                clear_previous_import(session)
            for start in range(0, len(rows), batch_size):
                write_batch(session, rows[start:start + batch_size], commit_short)
            record_import_run(
                session,
                source=DEFAULT_FILE_IMPORT_SOURCE,
                graph_recorded_commit_short=commit_short,
                query_id=DEFAULT_FILE_IMPORT_QUERY_ID,
                rows_written=len(rows),
            )
    finally:
        driver.close()


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    payload = run_extractor()
    rows = normalize_rows(payload.get('fileImports', []))
    commit_short = get_head_commit_short(WORKSPACE_DIR)
    write_to_neo4j(rows, not args.append, commit_short, args.batch_size)
    print(f'Imported {len(rows)} IMPORTS_FILE edges into Neo4j at commit {commit_short}.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
