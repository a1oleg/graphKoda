from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from neo4j import GraphDatabase
from extraction_provenance import register_provenance, check_scoped_provenance

SCRIPT_DIR = Path(__file__).resolve().parent
WORKSPACE_DIR = SCRIPT_DIR.parents[2]
GRAPH_ENV_PATH = WORKSPACE_DIR / 'graph' / '.env'


SOURCE = 'semantic/functionFlowGraph'
TS_EXTRACTOR_PATH = WORKSPACE_DIR / 'graph' / 'static-extract' / 'ts' / 'fromASTtoPreGraphFlow.ts'
DEFAULT_NEO4J_BATCH_SIZE = 100_000
DEFAULT_NEO4J_CLEAR_TIMING = 'after-extract'
IMPORT_LABEL = '_GraphImportNode'
IMPORT_CONSTRAINT = 'graph_import_node_stable_id'
PROJECT_CONFIG_PATH = Path(os.getenv('graphKoda_PROJECT_CONFIG', str(WORKSPACE_DIR / 'graphKoda.local.json')))
PROJECT_CONFIG = json.loads(PROJECT_CONFIG_PATH.read_text(encoding='utf-8')) if PROJECT_CONFIG_PATH.is_file() else {}
DATA_ROOT = (WORKSPACE_DIR / os.getenv('graphKoda_DATA_ROOT', PROJECT_CONFIG.get('dataRoot', '.graphKoda-data'))).resolve()
DEFAULT_STAGE_PATH = DATA_ROOT / 'cache' / 'function-flow.duckdb'
DEFAULT_PARQUET_DIR = DATA_ROOT / 'cache' / 'function-flow-parquet'
SCOPED_EXTRACTOR_PROTOCOL_VERSION = 1
SCOPED_EXTRACTOR_PORT = int(os.getenv('GRAPH_SCOPED_EXTRACTOR_PORT', '8794'))
SCOPED_EXTRACTOR_BASE_URL = f'http://127.0.0.1:{SCOPED_EXTRACTOR_PORT}'

def load_neo4j_settings() -> dict[str, str]:
    load_dotenv(GRAPH_ENV_PATH)
    uri = os.getenv('NEO4J_URI')
    username = os.getenv('NEO4J_USER') or os.getenv('NEO4J_USERNAME')
    password = os.getenv('NEO4J_PASSWORD')
    database = os.getenv('NEO4J_DATABASE') or os.getenv('NEO4J_DB') or 'neo4j'
    missing = [
        name for name, value in {
            'NEO4J_URI': uri,
            'NEO4J_USER/NEO4J_USERNAME': username,
            'NEO4J_PASSWORD': password,
        }.items() if not value
    ]
    if missing:
        raise RuntimeError(f"Missing required Neo4j settings: {', '.join(missing)}")
    assert uri and username and password
    if uri.startswith('neo4j://localhost'):
        uri = uri.replace('neo4j://localhost', 'bolt://localhost', 1)
    elif uri.startswith('neo4j://127.0.0.1'):
        uri = uri.replace('neo4j://127.0.0.1', 'bolt://127.0.0.1', 1)
    return {'uri': uri, 'username': username, 'password': password, 'database': database}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Write TS/CodeQL function-flow facts to Neo4j.')
    parser.add_argument('mode', nargs='?', choices=['func'], default='func')
    parser.add_argument(
        '--batch-size',
        type=int,
        default=DEFAULT_NEO4J_BATCH_SIZE,
        help='Rows per Neo4j transaction; unrelated to DuckDB appender flush size.',
    )
    parser.add_argument('--append', action='store_true')
    parser.add_argument('--fn-stable-id', dest='fn_stable_id')
    annotation_group = parser.add_mutually_exclusive_group()
    annotation_group.add_argument(
        '--preserve-annotations',
        dest='preserve_annotations',
        action='store_true',
        default=True,
        help='Preserve and reattach Annotation nodes after full or scoped import (default).',
    )
    annotation_group.add_argument(
        '--no-preserve-annotations',
        dest='preserve_annotations',
        action='store_false',
        help='Delete annotations when replacing the full graph or scoped nodes.',
    )
    parser.add_argument('--catalog-only', action='store_true')
    parser.add_argument(
        '--neo4j-clear-timing',
        choices=('parallel', 'after-extract'),
        default=DEFAULT_NEO4J_CLEAR_TIMING,
        help='Clear Neo4j after successful extraction (default), or explicitly overlap cleanup with extraction.',
    )
    parser.add_argument('--staging-path', default=str(DEFAULT_STAGE_PATH))
    parser.add_argument('--parquet-dir', default=str(DEFAULT_PARQUET_DIR))
    args = parser.parse_args(argv)
    if args.batch_size < 1:
        parser.error('--batch-size must be positive.')
    if args.append and not args.fn_stable_id:
        parser.error('--append is supported only for a scoped function import.')
    if args.catalog_only and args.fn_stable_id:
        parser.error('--catalog-only cannot be combined with --fn-stable-id.')
    return args


def resolve_node_path() -> str:
    node_path = shutil.which('node.exe') or shutil.which('node')
    if not node_path:
        raise RuntimeError('node was not found in PATH.')
    return node_path


def extractor_command(extra_args: list[str] | None = None) -> list[str]:
    relative_path = Path(os.path.relpath(TS_EXTRACTOR_PATH, WORKSPACE_DIR)).as_posix()
    return [resolve_node_path(), '--import', 'tsx', relative_path, *(extra_args or [])]


def run_scoped_extractor_cli(fn_stable_id: str) -> dict[str, Any]:
    completed = subprocess.run(
        extractor_command(['--fn-stable-id', fn_stable_id, '--include-parameter-origins']),
        cwd=WORKSPACE_DIR,
        check=True,
        capture_output=True,
        text=True,
        encoding='utf-8',
    )
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f'TS extractor returned invalid JSON: {completed.stdout[:1000]}') from error


def scoped_extractor_request(
    endpoint: str,
    payload: dict[str, Any] | None = None,
    *,
    timeout: float,
) -> tuple[dict[str, Any], Any]:
    body = None if payload is None else json.dumps(payload).encode('utf-8')
    request = urllib.request.Request(
        f'{SCOPED_EXTRACTOR_BASE_URL}{endpoint}',
        data=body,
        method='POST' if body is not None else 'GET',
        headers={'Content-Type': 'application/json'},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode('utf-8')), response.headers
    except urllib.error.HTTPError as error:
        detail = error.read().decode('utf-8', errors='replace')
        raise RuntimeError(f'Scoped extractor server failed ({error.code}): {detail[:2000]}') from error


def start_scoped_extractor_server() -> None:
    server_path = WORKSPACE_DIR / 'dev' / 'scopedFunctionExtractorServer.mts'
    command = [resolve_node_path(), '--import', 'tsx', str(server_path)]
    kwargs: dict[str, Any] = {
        'cwd': WORKSPACE_DIR,
        'stdin': subprocess.DEVNULL,
        'stdout': subprocess.DEVNULL,
        'stderr': subprocess.DEVNULL,
    }
    if os.name == 'nt':
        kwargs['creationflags'] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    else:
        kwargs['start_new_session'] = True
    subprocess.Popen(command, **kwargs)


def compatible_scoped_extractor(health: dict[str, Any]) -> bool:
    return (health.get('protocolVersion') == SCOPED_EXTRACTOR_PROTOCOL_VERSION
            and health.get('provenanceSupported') is True
            and health.get('extractorCurrent') is True
            and Path(health.get('toolRoot', '')).resolve() == WORKSPACE_DIR.resolve())


def ensure_scoped_extractor_server() -> dict[str, Any]:
    try:
        health, _ = scoped_extractor_request('/health', timeout=0.5)
        if compatible_scoped_extractor(health):
            return health
        try:
            scoped_extractor_request('/shutdown', {}, timeout=1.0)
        except Exception:
            pass
        time.sleep(0.1)
    except (urllib.error.URLError, TimeoutError):
        pass

    start_scoped_extractor_server()
    deadline = time.monotonic() + 15.0
    while time.monotonic() < deadline:
        try:
            health, _ = scoped_extractor_request('/health', timeout=0.5)
            if compatible_scoped_extractor(health):
                return health
        except (urllib.error.URLError, TimeoutError):
            time.sleep(0.1)
        else:
            time.sleep(0.1)
    raise RuntimeError('Scoped extractor server did not become ready within 15 seconds.')


def run_scoped_extractor(fn_stable_id: str) -> dict[str, Any]:
    if os.getenv('GRAPH_SCOPED_EXTRACTOR_DAEMON', '1').lower() in {'0', 'false', 'no'}:
        return run_scoped_extractor_cli(fn_stable_id)
    try:
        health = ensure_scoped_extractor_server()
        payload, headers = scoped_extractor_request(
            '/extract',
            {'fnStableId': fn_stable_id, 'includeParameterOrigins': True},
            timeout=600.0,
        )
        elapsed_ms = headers.get('X-Graph-Extractor-Elapsed-Ms', '?')
        reused_context = headers.get('X-Graph-Extractor-Reused-Context', 'false')
        print(
            f'[graph:func:scope] extractor=daemon pid={health.get("pid")} '
            f'elapsedMs={elapsed_ms} reusedContext={reused_context}',
            file=sys.stderr,
        )
        return payload
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        print(
            f'[graph:func:scope] daemon unavailable ({error}); falling back to one-shot extractor',
            file=sys.stderr,
        )
        return run_scoped_extractor_cli(fn_stable_id)


def run_full_extractor(staging_path: Path, parquet_dir: Path) -> dict[str, Any]:
    completed = subprocess.run(
        extractor_command([
            '--output-format', 'duckdb',
            '--staging-path', str(staging_path),
            '--parquet-dir', str(parquet_dir),
        ]),
        cwd=WORKSPACE_DIR,
        check=False,
        stdout=subprocess.PIPE,
        stderr=None,
        text=True,
        encoding='utf-8',
    )
    if completed.returncode:
        detail = (completed.stderr or completed.stdout or '').strip()
        raise RuntimeError(
            f'TS extractor failed with exit code {completed.returncode}: {detail[-4000:]}'
        )
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f'TS extractor returned invalid completion JSON: {completed.stdout[:1000]}') from error
    if not payload.get('ok'):
        raise RuntimeError(f'TS extractor did not complete successfully: {payload!r}')
    return payload


def require_flat_id(row: dict[str, Any], key: str, row_kind: str) -> str:
    value = row.get(key)
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError(f'{row_kind}.{key} must be a non-empty string prepared by the TS extractor.')
    return value


def require_labels(value: Any, row_kind: str) -> list[str]:
    if not isinstance(value, list) or not value:
        raise RuntimeError(f'{row_kind}.labels must be a non-empty list prepared by the TS extractor.')
    for label in value:
        if not isinstance(label, str) or not label.strip():
            raise RuntimeError(f'{row_kind}.labels must contain non-empty strings.')
    if len(set(value)) != len(value):
        raise RuntimeError(f'{row_kind}.labels must not contain duplicates.')
    return list(value)


def require_props(row: dict[str, Any], row_kind: str) -> dict[str, Any]:
    props = row.get('props')
    if not isinstance(props, dict):
        raise RuntimeError(f'{row_kind}.props must be an object prepared by the TS extractor.')
    try:
        json.dumps(props)
    except (TypeError, ValueError) as error:
        raise RuntimeError(f'{row_kind}.props must be JSON-serializable.') from error
    return dict(props)


def normalize_entity(row: dict[str, Any], row_kind: str) -> dict[str, Any]:
    stable_id = require_flat_id(row, 'stableId', row_kind)
    labels = require_labels(row.get('labels'), row_kind)
    props = require_props(row, row_kind)
    if 'stableId' in props:
        raise RuntimeError(f'{row_kind}.props must not duplicate {row_kind}.stableId.')
    is_proxy = bool(props.get('canonicalStableId')) or 'VisualProxy' in labels
    if is_proxy and 'AnnotationProxy' not in labels:
        labels.append('AnnotationProxy')
    if props.get('annotationKind') and not is_proxy and 'Annotatable' not in labels:
        labels.append('Annotatable')
    return {'stableId': stable_id, 'labels': labels, 'props': props}


def normalize_function(row: dict[str, Any]) -> dict[str, Any]:
    return normalize_entity(row, 'function')


def normalize_node(row: dict[str, Any]) -> dict[str, Any]:
    return normalize_entity(row, 'node')


def normalize_resource(row: dict[str, Any]) -> dict[str, Any]:
    return normalize_entity(row, 'resource')


def normalize_relationship(
    row: dict[str, Any],
    row_kind: str,
    from_key: str,
    to_key: str,
    type_key: str,
) -> dict[str, Any]:
    return {
        'fromId': require_flat_id(row, from_key, row_kind),
        'toId': require_flat_id(row, to_key, row_kind),
        'type': require_flat_id(row, type_key, row_kind),
        'props': require_props(row, row_kind),
    }


def normalize_edge(row: dict[str, Any]) -> dict[str, Any]:
    return normalize_relationship(row, 'edge', 'fromId', 'toId', 'type')


def normalize_resource_edge(row: dict[str, Any]) -> dict[str, Any]:
    return normalize_relationship(
        row,
        'resourceEdge',
        'flowNodeStableId',
        'stableId',
        'relType',
    )


def normalize_resource_link(row: dict[str, Any]) -> dict[str, Any]:
    return normalize_relationship(
        row,
        'resourceLink',
        'sourceStableId',
        'targetStableId',
        'relType',
    )


def clear_database(session: Any, preserve_annotations: bool = True) -> None:
    while True:
        deleted = session.run(
            'MATCH (n) WHERE NOT ($preserveAnnotations AND n:Annotation) '
            'WITH n LIMIT 10000 DETACH DELETE n RETURN count(*) AS deleted',
            preserveAnnotations=preserve_annotations,
        ).single()['deleted']
        if not deleted:
            return


def clear_full_database(settings: dict[str, str], started: float, preserve_annotations: bool = True) -> None:
    print('[graph:func:pipeline] phase=neo4j-clear-start', file=sys.stderr, flush=True)
    driver = GraphDatabase.driver(settings['uri'], auth=(settings['username'], settings['password']))
    try:
        with driver.session(database=settings['database']) as session:
            clear_database(session, preserve_annotations)
    finally:
        driver.close()
    print(
        f'[graph:func:pipeline] phase=neo4j-clear-done elapsedSeconds={time.perf_counter() - started:.3f}',
        file=sys.stderr,
        flush=True,
    )


def delete_scoped_annotations(session: Any, fn_stable_id: str) -> int:
    result = session.run(
        '''
        MATCH (n {source: $source})-[:HAS_ANNOTATION]->(annotation:Annotation)
        WHERE n.parentFnStableId = $fnStableId
           OR n.parent_fn_stable_id = $fnStableId
        WITH DISTINCT annotation
        DETACH DELETE annotation
        RETURN count(*) AS deleted
        ''',
        fnStableId=fn_stable_id,
        source=SOURCE,
    ).single()
    return int(result['deleted']) if result else 0


def clear_scoped_flow(
    session: Any,
    fn_stable_id: str,
    *,
    preserve_annotations: bool = True,
) -> int:
    annotations_deleted = 0
    if not preserve_annotations:
        annotations_deleted = delete_scoped_annotations(session, fn_stable_id)
    scope_path: str | None = None
    scope_start_line = scope_start_column = scope_end_line = scope_end_column = None
    try:
        scope_path, start_line, start_column, end_line, end_column = fn_stable_id.rsplit(':', 4)
        scope_start_line = int(start_line)
        scope_start_column = int(start_column)
        scope_end_line = int(end_line)
        scope_end_column = int(end_column)
    except (TypeError, ValueError):
        scope_path = None
    session.run(
        '''
        MATCH (:Fn {stableId: $fnStableId})-[rel:HAS_OPERATION]->()
        WHERE rel.source = $source
        DELETE rel
        ''',
        fnStableId=fn_stable_id,
        source=SOURCE,
    ).consume()
    session.run(
        '''
        MATCH (n {source: $source})
        WHERE n.parentFnStableId = $fnStableId
           OR n.parent_fn_stable_id = $fnStableId
           OR n.parameter_origin_target_fn_stable_id = $fnStableId
           OR ($scopePath IS NOT NULL
             AND n.repoRelativePath = $scopePath
             AND n.startLine IS NOT NULL
             AND n.startColumn IS NOT NULL
             AND n.endLine IS NOT NULL
             AND n.endColumn IS NOT NULL
             AND (n.startLine > $scopeStartLine
               OR (n.startLine = $scopeStartLine AND n.startColumn >= $scopeStartColumn))
             AND (n.endLine < $scopeEndLine
               OR (n.endLine = $scopeEndLine AND n.endColumn <= $scopeEndColumn)))
        DETACH DELETE n
        ''',
        fnStableId=fn_stable_id,
        source=SOURCE,
        scopePath=scope_path,
        scopeStartLine=scope_start_line,
        scopeStartColumn=scope_start_column,
        scopeEndLine=scope_end_line,
        scopeEndColumn=scope_end_column,
    ).consume()
    return annotations_deleted


def clear_replaced_semantic_relationships(
    session: Any,
    payload: dict[str, Any],
) -> None:
    relationship_types_by_source: dict[str, set[str]] = defaultdict(set)
    for row in payload.get('semanticRelationships', []):
        from_id = row.get('fromId')
        relationship_type = row.get('type')
        if isinstance(from_id, str) and isinstance(relationship_type, str):
            relationship_types_by_source[from_id].add(relationship_type)
    serialized_types = {
        stable_id: sorted(relationship_types)
        for stable_id, relationship_types in relationship_types_by_source.items()
    }
    session.run(
        '''
        MATCH (sourceNode)-[rel]->()
        WITH rel, $typesBySource[sourceNode.stableId] AS replacementTypes
        WHERE replacementTypes IS NOT NULL AND type(rel) IN replacementTypes
        DELETE rel
        ''',
        typesBySource=serialized_types,
    ).consume()
    # Older extractor versions incorrectly materialized shorthand properties as
    # declarations. They are syntax occurrences, never canonical declarations.
    session.run(
        '''
        MATCH (node:Declaration {source: $source, declarationKind: 'ShorthandPropertyAssignment'})
        DETACH DELETE node
        ''',
        source=SOURCE,
    ).consume()


def restore_scoped_annotations(session: Any, fn_stable_id: str | None) -> int:
    result = session.run(
        '''
        MATCH (annotation:Annotation)
        WHERE annotation.headID IS NOT NULL
        MATCH (head {stableId: annotation.headID})
        WHERE $fnStableId IS NULL OR head.stableId = $fnStableId
           OR (head.source = $source AND (
                head.parentFnStableId = $fnStableId
                OR head.parent_fn_stable_id = $fnStableId
           ))
        MERGE (head)-[:HAS_ANNOTATION]->(annotation)
        RETURN count(annotation) AS restored
        ''',
        fnStableId=fn_stable_id,
        source=SOURCE,
    ).single()
    return int(result['restored']) if result else 0


def prepare_bulk_import(session: Any) -> None:
    session.run(
        f'CREATE CONSTRAINT {IMPORT_CONSTRAINT} IF NOT EXISTS '
        f'FOR (node:{IMPORT_LABEL}) REQUIRE node.stableId IS UNIQUE'
    ).consume()


def finish_bulk_import(session: Any) -> None:
    session.run(
        f'''
        MATCH (node:{IMPORT_LABEL})
        CALL (node) {{
          REMOVE node:{IMPORT_LABEL}
        }} IN TRANSACTIONS OF 100000 ROWS
        '''
    ).consume()
    session.run(f'DROP CONSTRAINT {IMPORT_CONSTRAINT} IF EXISTS').consume()


def require_written(result: Any, expected: int, kind: str) -> None:
    record = result.single()
    written = int(record['written']) if record and record.get('written') is not None else 0
    if written != expected:
        raise RuntimeError(f'Neo4j wrote {written} of {expected} {kind} rows.')


def resolve_existing_entity_ids(session: Any, rows: list[dict[str, Any]]) -> dict[str, str]:
    stable_ids = [row['stableId'] for row in rows]
    result = session.run(
        '''
        MATCH (node)
        WHERE node.stableId IN $stableIds
        RETURN node.stableId AS stableId, elementId(node) AS elementId
        ''',
        stableIds=stable_ids,
    )
    element_ids: dict[str, str] = {}
    for record in result:
        stable_id = record['stableId']
        if stable_id in element_ids:
            raise RuntimeError(f'Multiple Neo4j nodes have stableId {stable_id!r}.')
        element_ids[stable_id] = record['elementId']
    return element_ids


def write_entities(session: Any, rows: list[dict[str, Any]], *, bulk: bool, kind: str) -> None:
    if not rows:
        return
    if bulk:
        result = session.run(
            f'''
            UNWIND $rows AS row
            CREATE (node:{IMPORT_LABEL} {{stableId: row.stableId}})
            SET node += row.props
            SET node:$(row.labels)
            SET node.flow_labels = row.labels
            SET node.roles = row.labels
            RETURN count(*) AS written
            ''',
            rows=rows,
        )
        require_written(result, len(rows), kind)
        return
    existing_ids = resolve_existing_entity_ids(session, rows)
    existing_rows = [
        {**row, 'elementId': existing_ids[row['stableId']]}
        for row in rows
        if row['stableId'] in existing_ids
    ]
    new_rows = [row for row in rows if row['stableId'] not in existing_ids]
    if existing_rows:
        result = session.run(
            '''
            UNWIND $rows AS row
            MATCH (node) WHERE elementId(node) = row.elementId
            SET node += row.props
            SET node:$(row.labels)
            WITH node, row,
                 reduce(labels = coalesce(node.flow_labels, []), label IN row.labels |
                   CASE WHEN label IN labels THEN labels ELSE labels + label END
                 ) AS mergedLabels
            SET node.flow_labels = mergedLabels
            SET node.roles = mergedLabels
            RETURN count(*) AS written
            ''',
            rows=existing_rows,
        )
        require_written(result, len(existing_rows), kind)
    if new_rows:
        result = session.run(
            '''
            UNWIND $rows AS row
            CREATE (node {stableId: row.stableId})
            SET node += row.props
            SET node:$(row.labels)
            SET node.flow_labels = row.labels
            SET node.roles = row.labels
            RETURN count(*) AS written
            ''',
            rows=new_rows,
        )
        require_written(result, len(new_rows), kind)


def write_functions(session: Any, rows: list[dict[str, Any]], *, bulk: bool) -> None:
    write_entities(session, rows, bulk=bulk, kind='function')


def write_labeled_nodes(session: Any, rows: list[dict[str, Any]], *, bulk: bool) -> None:
    write_entities(session, rows, bulk=bulk, kind='node')


def resolve_relationship_endpoints(
    session: Any,
    rows: list[dict[str, Any]],
    element_ids: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    stable_ids = sorted({row[key] for row in rows for key in ('fromId', 'toId')})
    resolved_ids = element_ids if element_ids is not None else {}
    unresolved_ids = [stable_id for stable_id in stable_ids if stable_id not in resolved_ids]
    if unresolved_ids:
        result = session.run(
            '''
            MATCH (node)
            WHERE node.stableId IN $stableIds
            RETURN node.stableId AS stableId, elementId(node) AS elementId
            ''',
            stableIds=unresolved_ids,
        )
        for record in result:
            stable_id = record['stableId']
            if stable_id in resolved_ids:
                raise RuntimeError(f'Multiple Neo4j nodes have stableId {stable_id!r}.')
            resolved_ids[stable_id] = record['elementId']
    required_rows = [
        row for row in rows
        if not (
            row.get('type') == 'CAPTURES_VALUE'
            and row.get('props', {}).get('context_only') is True
            and (
                row['fromId'] not in resolved_ids
                or row['toId'] not in resolved_ids
            )
        )
    ]
    missing = sorted({
        row[key]
        for row in required_rows
        for key in ('fromId', 'toId')
        if row[key] not in resolved_ids
    })
    if missing:
        preview = ', '.join(repr(stable_id) for stable_id in missing[:5])
        raise RuntimeError(f'Neo4j relationship endpoints were not written: {preview}')
    return [
        {
            **row,
            'fromElementId': resolved_ids[row['fromId']],
            'toElementId': resolved_ids[row['toId']],
        }
        for row in required_rows
    ]


def write_edges(
    session: Any,
    rows: list[dict[str, Any]],
    *,
    bulk: bool,
    element_ids: dict[str, str] | None = None,
) -> None:
    if not rows:
        return
    if bulk:
        result = session.run(
            f'''
            UNWIND $rows AS row
            MATCH (sourceNode:{IMPORT_LABEL} {{stableId: row.fromId}})
            MATCH (targetNode:{IMPORT_LABEL} {{stableId: row.toId}})
            CREATE (sourceNode)-[rel:$(row.type)]->(targetNode)
            SET rel += row.props
            RETURN count(*) AS written
            ''',
            rows=rows,
        )
        require_written(result, len(rows), 'edge')
        return
    resolved_rows = resolve_relationship_endpoints(session, rows, element_ids)
    outcome_rows = [
        row for row in resolved_rows
        if row.get('props', {}).get('producer_outcome') in ('true', 'false')
    ]
    ordinary_rows = [row for row in resolved_rows if row not in outcome_rows]
    if ordinary_rows:
        result = session.run(
            '''
        UNWIND $rows AS row
        MATCH (sourceNode) WHERE elementId(sourceNode) = row.fromElementId
        MATCH (targetNode) WHERE elementId(targetNode) = row.toElementId
        MERGE (sourceNode)-[rel:$(row.type)]->(targetNode)
        SET rel += row.props
        RETURN count(*) AS written
            ''',
            rows=ordinary_rows,
        )
        require_written(result, len(ordinary_rows), 'edge')
    if outcome_rows:
        result = session.run(
            '''
        UNWIND $rows AS row
        MATCH (sourceNode) WHERE elementId(sourceNode) = row.fromElementId
        MATCH (targetNode) WHERE elementId(targetNode) = row.toElementId
        MERGE (sourceNode)-[rel:$(row.type) {producer_outcome: row.props.producer_outcome}]->(targetNode)
        SET rel += row.props
        RETURN count(*) AS written
            ''',
            rows=outcome_rows,
        )
        require_written(result, len(outcome_rows), 'edge')


def write_resource_edges(
    session: Any,
    rows: list[dict[str, Any]],
    *,
    bulk: bool,
    element_ids: dict[str, str] | None = None,
) -> None:
    write_edges(session, rows, bulk=bulk, element_ids=element_ids)


def write_resource_links(
    session: Any,
    rows: list[dict[str, Any]],
    *,
    bulk: bool,
    element_ids: dict[str, str] | None = None,
) -> None:
    write_edges(session, rows, bulk=bulk, element_ids=element_ids)


class GraphWriter:
    def __init__(self, session: Any, batch_size: int, *, bulk: bool):
        self.session = session
        self.batch_size = batch_size
        self.bulk = bulk
        self.buffers: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self.counts: dict[str, int] = defaultdict(int)
        self.write_seconds: dict[str, float] = defaultdict(float)
        self.write_batches: dict[str, int] = defaultdict(int)
        self.element_ids: dict[str, str] = {}

    def add(self, kind: str, row: dict[str, Any]) -> None:
        if kind == 'function':
            normalized = normalize_function(row)
        elif kind == 'node':
            normalized = normalize_node(row)
        elif kind == 'edge':
            normalized = normalize_edge(row)
        elif kind == 'resource':
            normalized = normalize_resource(row)
        elif kind == 'resourceEdge':
            normalized = normalize_resource_edge(row)
        elif kind == 'resourceLink':
            normalized = normalize_resource_link(row)
        elif kind == 'semanticEntity':
            normalized = normalize_entity(row, 'semanticEntity')
        elif kind == 'semanticRelationship':
            normalized = normalize_relationship(row, 'semanticRelationship', 'fromId', 'toId', 'type')
        else:
            raise RuntimeError(f'Unsupported transport record kind: {kind}')
        self.buffers[kind].append(normalized)
        self.counts[kind] += 1
        if len(self.buffers[kind]) >= self.batch_size:
            self.flush(kind)

    def flush(self, kind: str) -> None:
        rows = self.buffers[kind]
        if not rows:
            return
        if kind in {'edge', 'semanticRelationship'}:
            self.flush('function')
            self.flush('node')
            self.flush('resource')
            self.flush('semanticEntity')
        elif kind == 'resourceEdge':
            self.flush('node')
            self.flush('resource')
        elif kind == 'resourceLink':
            self.flush('function')
            self.flush('node')
            self.flush('resource')
        started = time.perf_counter()
        if kind == 'function':
            write_functions(self.session, rows, bulk=self.bulk)
        elif kind in {'node', 'resource', 'semanticEntity'}:
            write_labeled_nodes(self.session, rows, bulk=self.bulk)
        elif kind in {'edge', 'semanticRelationship'}:
            write_edges(self.session, rows, bulk=self.bulk, element_ids=self.element_ids)
        elif kind == 'resourceEdge':
            write_resource_edges(self.session, rows, bulk=self.bulk, element_ids=self.element_ids)
        elif kind == 'resourceLink':
            write_resource_links(self.session, rows, bulk=self.bulk, element_ids=self.element_ids)
        elapsed = time.perf_counter() - started
        self.write_seconds[kind] += elapsed
        self.write_batches[kind] += 1
        print(
            f'[graph:func:batch] writer={kind} rows={len(rows)} seconds={elapsed:.3f}',
            file=sys.stderr,
            flush=True,
        )
        self.buffers[kind] = []

    def finish(self) -> None:
        for kind in ('function', 'node', 'resource', 'semanticEntity', 'edge', 'resourceEdge', 'resourceLink', 'semanticRelationship'):
            self.flush(kind)


def import_payload(writer: GraphWriter, payload: dict[str, Any]) -> None:
    for payload_key, kind in (
        ('functions', 'function'),
        ('nodes', 'node'),
        ('resources', 'resource'),
        ('edges', 'edge'),
        ('resourceEdges', 'resourceEdge'),
        ('resourceLinks', 'resourceLink'),
        ('semanticEntities', 'semanticEntity'),
        ('semanticRelationships', 'semanticRelationship'),
    ):
        for row in payload.get(payload_key) or []:
            writer.add(kind, row)


def record_import(session: Any, *, fn_stable_id: str | None, counts: dict[str, int], elapsed: float, provenance_ids=()) -> None:
    session.run(
        '''
        CREATE (run:GraphImportRun)
        SET run.source = $source,
            run.provenance_ids = $provenanceIds,
            run.mode = 'func',
            run.scope_fn_stable_id = $fnStableId,
            run.counts_json = $countsJson,
            run.elapsed_seconds = $elapsed,
            run.completed_at = datetime()
        ''',
        source=SOURCE,
        provenanceIds=list(provenance_ids),
        fnStableId=fn_stable_id,
        countsJson=json.dumps(counts, sort_keys=True),
        elapsed=elapsed,
    ).consume()


def run_scoped_import(args: argparse.Namespace, settings: dict[str, str], started: float) -> dict[str, Any]:
    driver = GraphDatabase.driver(settings['uri'], auth=(settings['username'], settings['password']))
    try:
        with driver.session(database=settings['database']) as session:
            payload = run_scoped_extractor(args.fn_stable_id)
            provenance = check_scoped_provenance(session, payload)
            annotations_deleted = 0
            if not args.append:
                annotations_deleted = clear_scoped_flow(
                    session,
                    args.fn_stable_id,
                    preserve_annotations=args.preserve_annotations,
                )
                clear_replaced_semantic_relationships(session, payload)
            writer = GraphWriter(session, args.batch_size, bulk=False)
            register_provenance(session, [provenance])
            import_payload(writer, payload)
            writer.finish()
            annotations_restored = (
                restore_scoped_annotations(session, args.fn_stable_id)
                if args.preserve_annotations
                else 0
            )
            elapsed = time.perf_counter() - started
            record_import(session, fn_stable_id=args.fn_stable_id, counts=dict(writer.counts), elapsed=elapsed, provenance_ids=[provenance['id']])
            return {
                'ok': True,
                'counts': writer.counts,
                'elapsedSeconds': round(elapsed, 3),
                'writeSeconds': {key: round(value, 3) for key, value in writer.write_seconds.items()},
                'writeBatches': writer.write_batches,
                'preserveAnnotations': args.preserve_annotations,
                'annotationsDeleted': annotations_deleted,
                'annotationsRestored': annotations_restored,
            }
    finally:
        driver.close()


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    settings = load_neo4j_settings()
    started = time.perf_counter()
    if args.fn_stable_id:
        print(json.dumps(run_scoped_import(args, settings, started)))
        return 0

    from function_flow_catalog import FunctionFlowCatalog
    staging_path = Path(args.staging_path).resolve()
    parquet_dir = Path(args.parquet_dir).resolve()
    clear_timing_used = 'after-extract' if args.catalog_only else args.neo4j_clear_timing
    if args.catalog_only:
        extract_result = {'stageSeconds': 0.0}
    elif args.neo4j_clear_timing == 'parallel':
        print(
            '[graph:func:pipeline] phase=parallel-start tasks=duckdb-extract,neo4j-clear',
            file=sys.stderr,
            flush=True,
        )
        with concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix='neo4j-clear') as executor:
            clear_future = executor.submit(clear_full_database, settings, started, args.preserve_annotations)
            extract_result = run_full_extractor(staging_path, parquet_dir)
            clear_future.result()
        print(
            f'[graph:func:pipeline] phase=parallel-done elapsedSeconds={time.perf_counter() - started:.3f}',
            file=sys.stderr,
            flush=True,
        )
    else:
        extract_result = run_full_extractor(staging_path, parquet_dir)
    catalog = FunctionFlowCatalog(staging_path, parquet_dir)
    try:
        if args.catalog_only or args.neo4j_clear_timing != 'parallel':
            clear_full_database(settings, started, args.preserve_annotations)
        stage_counts = catalog.counts()
        print(
            '[graph:func:pipeline] '
            f"phase=catalog-ready entities={stage_counts['canonicalEntities']} "
            f"relationships={stage_counts['canonicalRelationships']} "
            f'elapsedSeconds={time.perf_counter() - started:.3f}',
            file=sys.stderr,
            flush=True,
        )
        write_seconds: dict[str, float] = {}
        catalog_read_seconds: dict[str, float] = {}
        phase_seconds: dict[str, float] = {}
        write_batches: dict[str, int] = {}
        driver = GraphDatabase.driver(settings['uri'], auth=(settings['username'], settings['password']))
        try:
            with driver.session(database=settings['database']) as session:
                print('[graph:func:pipeline] phase=neo4j-prepare-start', file=sys.stderr, flush=True)
                prepare_bulk_import(session)
                register_provenance(session, catalog.provenance.values())
                print(
                    f'[graph:func:pipeline] phase=neo4j-prepare-done elapsedSeconds={time.perf_counter() - started:.3f}',
                    file=sys.stderr,
                    flush=True,
                )
                for kind, batches, writer in (
                    ('entity', catalog.iter_entities(args.batch_size), write_labeled_nodes),
                    ('relationship', catalog.iter_relationships(args.batch_size), write_edges),
                ):
                    kind_started = time.perf_counter()
                    batch_count = 0
                    rows_written = 0
                    kind_read_seconds = 0.0
                    kind_write_seconds = 0.0
                    batch_iterator = iter(batches)
                    while True:
                        read_started = time.perf_counter()
                        try:
                            rows = next(batch_iterator)
                        except StopIteration:
                            kind_read_seconds += time.perf_counter() - read_started
                            break
                        kind_read_seconds += time.perf_counter() - read_started
                        batch_started = time.perf_counter()
                        writer(session, rows, bulk=True)
                        batch_seconds = time.perf_counter() - batch_started
                        kind_write_seconds += batch_seconds
                        batch_count += 1
                        rows_written += len(rows)
                        print(
                            '[graph:func:pipeline] '
                            f'phase=neo4j-{kind} batch={batch_count} rows={rows_written} '
                            f'batchRows={len(rows)} batchSeconds={batch_seconds:.3f} '
                            f'batchRowsPerSecond={len(rows) / batch_seconds:.1f} '
                            f'elapsedSeconds={time.perf_counter() - started:.3f}',
                            file=sys.stderr,
                            flush=True,
                        )
                    write_seconds[kind] = kind_write_seconds
                    catalog_read_seconds[kind] = kind_read_seconds
                    phase_seconds[kind] = time.perf_counter() - kind_started
                    write_batches[kind] = batch_count
                print('[graph:func:pipeline] phase=neo4j-finish-start', file=sys.stderr, flush=True)
                finish_bulk_import(session)
                annotations_restored = restore_scoped_annotations(session, None) if args.preserve_annotations else 0
                print(
                    f'[graph:func:pipeline] phase=neo4j-finish-done elapsedSeconds={time.perf_counter() - started:.3f}',
                    file=sys.stderr,
                    flush=True,
                )
                elapsed = time.perf_counter() - started
                counts = stage_counts
                record_import(session, fn_stable_id=None, counts=counts, elapsed=elapsed, provenance_ids=catalog.provenance)
        finally:
            driver.close()

        print(json.dumps({
            'ok': True,
            'counts': counts,
            'elapsedSeconds': round(elapsed, 3),
            'preserveAnnotations': args.preserve_annotations,
            'annotationsRestored': annotations_restored,
            'stageSeconds': extract_result.get('stageSeconds'),
            'extractSeconds': extract_result.get('extractSeconds'),
            'canonicalizeSeconds': extract_result.get('canonicalizeSeconds'),
            'neo4jBatchSize': args.batch_size,
            'neo4jClearTiming': clear_timing_used,
            'writeSeconds': {key: round(value, 3) for key, value in write_seconds.items()},
            'catalogReadSeconds': {
                key: round(value, 3) for key, value in catalog_read_seconds.items()
            },
            'phaseSeconds': {key: round(value, 3) for key, value in phase_seconds.items()},
            'writeBatches': write_batches,
            'duckdbPath': str(catalog.database_path),
            'parquetDir': str(catalog.parquet_dir),
            'parquetBytes': {
                'nodes': catalog.entities_parquet_path.stat().st_size,
                'relationships': catalog.relationships_parquet_path.stat().st_size,
            },
        }))
        return 0
    finally:
        catalog.close()


if __name__ == '__main__':
    raise SystemExit(main())
