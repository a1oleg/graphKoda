from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from neo4j import GraphDatabase

from common import DEFAULT_FILE_PACKAGE_IMPORT_QUERY_ID
from common import DEFAULT_FILE_PACKAGE_IMPORT_SOURCE
from common import WORKSPACE_DIR
from common import get_head_commit_short
from common import load_settings
from neo4j_io import create_constraints as create_base_constraints
from neo4j_io import record_import_run


SCRIPT_DIR = Path(__file__).resolve().parent
TS_EXTRACTOR_PATH = SCRIPT_DIR.parent / 'ts' / 'fileImportGraph.ts'
PACKAGE_JSON_PATH = WORKSPACE_DIR / 'package.json'


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Import external file-to-package module dependencies into Neo4j.')
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


def load_package_metadata() -> dict[str, dict[str, str]]:
    package_json = json.loads(PACKAGE_JSON_PATH.read_text(encoding='utf-8'))
    metadata: dict[str, dict[str, str]] = {}

    section_to_type = {
        'dependencies': 'dependency',
        'devDependencies': 'devDependency',
        'peerDependencies': 'peerDependency',
        'optionalDependencies': 'optionalDependency',
    }

    for section_name, dependency_type in section_to_type.items():
        for package_name, version_spec in package_json.get(section_name, {}).items():
            metadata[package_name] = {
                'dependencyType': dependency_type,
                'versionSpec': version_spec,
            }

    return metadata


def normalize_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    package_metadata = load_package_metadata()
    normalized_rows: list[dict[str, Any]] = []

    for row in rows:
        package_name = row['packageName']
        dependency_meta = package_metadata.get(package_name, {})
        from_file_path = row['fromFilePath']
        normalized_rows.append({
            **row,
            'fromFileName': Path(from_file_path).name,
            'packageScope': package_name.split('/')[0] if package_name.startswith('@') else '',
            'isScopedPackage': package_name.startswith('@'),
            'packageSubpath': '' if row['moduleSpecifier'] == package_name else row['moduleSpecifier'][len(package_name):].lstrip('/'),
            'dependencyType': dependency_meta.get('dependencyType', 'transitiveOrUnlisted'),
            'versionSpec': dependency_meta.get('versionSpec', ''),
        })

    return normalized_rows


def clear_previous_import(session: Any) -> None:
    session.run('MATCH ()-[rel:IMPORTS_PACKAGE]->() DELETE rel').consume()
    session.run('MATCH (pkg:Package) WHERE NOT ()-[:IMPORTS_PACKAGE]->(pkg) DETACH DELETE pkg').consume()


def write_batch(session: Any, rows: list[dict[str, Any]], commit_short: str) -> None:
    session.run(
        '''
        UNWIND $rows AS row
        MERGE (from_file:File {path: row.fromFilePath})
        SET from_file.stableId = 'file:' + row.fromRepoRelativePath,
            from_file.relative_path = row.fromRepoRelativePath,
            from_file.name = row.fromFileName,
            from_file.graph_recorded_commit_short = coalesce(from_file.graph_recorded_commit_short, $commit)
        MERGE (pkg:Package {name: row.packageName})
        SET pkg.stableId = 'package:' + row.packageName,
            pkg.scope = row.packageScope,
            pkg.is_scoped = row.isScopedPackage,
            pkg.dependency_type = row.dependencyType,
            pkg.version_spec = row.versionSpec,
            pkg.graph_recorded_commit_short = $commit
        MERGE (from_file)-[rel:IMPORTS_PACKAGE {import_key: row.key}]->(pkg)
        SET rel.module_specifier = row.moduleSpecifier,
            rel.package_subpath = row.packageSubpath,
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
                source=DEFAULT_FILE_PACKAGE_IMPORT_SOURCE,
                graph_recorded_commit_short=commit_short,
                query_id=DEFAULT_FILE_PACKAGE_IMPORT_QUERY_ID,
                rows_written=len(rows),
            )
    finally:
        driver.close()


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    payload = run_extractor()
    rows = normalize_rows(payload.get('packageImports', []))
    commit_short = get_head_commit_short(WORKSPACE_DIR)
    write_to_neo4j(rows, not args.append, commit_short, args.batch_size)
    print(f'Imported {len(rows)} IMPORTS_PACKAGE edges into Neo4j at commit {commit_short}.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
