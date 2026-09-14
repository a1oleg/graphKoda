from __future__ import annotations

import argparse
import json
import sys
import uuid
from pathlib import Path
from typing import Any
from neo4j import Query

GRAPH_DIR = Path(__file__).resolve().parent.parent
WORKSPACE_DIR = GRAPH_DIR.parent
if str(WORKSPACE_DIR) not in sys.path:
    sys.path.insert(0, str(WORKSPACE_DIR))

from mcp.server.fastmcp import FastMCP
from graph.mcp.neo4j_profiles import create_driver
from graph.mcp.neo4j_profiles import load_connection_settings
from graph.mcp.neo4j_profiles import SUPPORTED_PROFILES


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Run the Neo4j MCP server for a selected connection profile.')
    parser.add_argument('--profile', default='local', choices=SUPPORTED_PROFILES, help='Connection profile to use.')
    parser.add_argument('--check', action='store_true', help='Verify connectivity and print a JSON summary.')
    return parser.parse_args(argv)

SETTINGS: dict[str, str]
DRIVER: Any

DEFAULT_QUERY_TIMEOUT_SECONDS = 30.0
MAX_RECORD_LIMIT = 500

app = FastMCP(
    name='neo4j-mcp',
    instructions='Run read-only Neo4j inspection queries and basic health checks.',
)


def normalize_value(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value

    if isinstance(value, list):
        return [normalize_value(item) for item in value]

    if isinstance(value, dict):
        return {key: normalize_value(item) for key, item in value.items()}

    if hasattr(value, 'items'):
        return {key: normalize_value(item) for key, item in value.items()}

    return str(value)


def get_path_value(payload: dict[str, Any], path_value: str | None) -> Any:
    if not path_value:
        return None

    normalized_path = path_value.removesuffix('[]')
    current: Any = payload
    for segment in normalized_path.split('.'):
        if not isinstance(current, dict):
            return None
        current = current.get(segment)
        if current is None:
            return None
    return current


def choose_seed_candidate(key: str, snapshot: dict[str, Any], candidate: Any) -> Any:
    if isinstance(candidate, list):
        if not candidate:
            return None

        current_user_id = snapshot.get('currentUserId')
        current_peer = snapshot.get('currentPeer')
        if key == 'ApiPeer' and current_peer:
            return current_peer
        if key == 'ApiUser' and current_user_id:
            matching_user = next((item for item in candidate if isinstance(item, dict) and item.get('id') == current_user_id), None)
            if matching_user:
                return matching_user
        if key == 'peerId' and current_user_id:
            return current_user_id
        return candidate[0]

    return candidate


def resolve_seed_value(key: str, snapshot: dict[str, Any], seed_resolvers: dict[str, Any]) -> tuple[Any, dict[str, Any] | None]:
    resolver = seed_resolvers.get(key)
    if not resolver:
        return None, {'key': key, 'reason': 'Seed resolver is not present in invocation metadata.'}

    source = resolver.get('source') or {}
    if source.get('kind') != 'manual':
        return None, {
            'key': key,
            'reason': source.get('note') or f'Unsupported seed source kind: {source.get("kind")}',
        }

    return None, {
        'key': key,
        'reason': source.get('note') or 'Automatic seed resolution is disabled.',
    }


def materialize_runtime_tokens(value: str, invocation_spec: dict[str, Any]) -> str:
    resolved = value
    resolved = resolved.replace('<runId>', uuid.uuid4().hex[:8])
    if invocation_spec.get('actionName'):
        resolved = resolved.replace('<actionName>', invocation_spec['actionName'])
    if invocation_spec.get('adapterName'):
        resolved = resolved.replace('<adapterName>', invocation_spec['adapterName'])
    return resolved


def resolve_leaf_value(schema_node: dict[str, Any], snapshot: dict[str, Any], seed_resolvers: dict[str, Any]) -> tuple[Any, list[dict[str, Any]], list[dict[str, Any]]]:
    seed_keys = schema_node.get('seedResolverKeys') or []
    bindings: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []
    for seed_key in seed_keys:
        resolved_value, issue = resolve_seed_value(seed_key, snapshot, seed_resolvers)
        if issue:
            issues.append(issue)
            continue

        bindings.append({'key': seed_key, 'value': normalize_value(resolved_value)})
        return resolved_value, bindings, []

    template = schema_node.get('template')
    if isinstance(template, str):
        return template, bindings, issues
    return template, bindings, issues


def resolve_schema_node(schema_node: dict[str, Any], snapshot: dict[str, Any], seed_resolvers: dict[str, Any]) -> tuple[Any, list[dict[str, Any]], list[dict[str, Any]]]:
    kind = schema_node.get('kind')

    if kind == 'object':
        resolved: dict[str, Any] = {}
        bindings: list[dict[str, Any]] = []
        issues: list[dict[str, Any]] = []
        for property_node in schema_node.get('properties') or []:
            if not property_node.get('required'):
                continue
            property_value, property_bindings, property_issues = resolve_schema_node(property_node, snapshot, seed_resolvers)
            resolved[property_node['name']] = property_value
            bindings.extend(property_bindings)
            issues.extend(property_issues)
        return resolved, bindings, issues

    if kind == 'array':
        bindings: list[dict[str, Any]] = []
        issues: list[dict[str, Any]] = []
        item_node = schema_node.get('items')
        if isinstance(item_node, dict):
            item_value, item_bindings, item_issues = resolve_schema_node(item_node, snapshot, seed_resolvers)
            bindings.extend(item_bindings)
            issues.extend(item_issues)
            if item_value is None or item_value == []:
                return [], bindings, issues
            return [item_value], bindings, issues
        return [], bindings, issues

    if kind == 'tuple':
        bindings: list[dict[str, Any]] = []
        issues: list[dict[str, Any]] = []
        values = []
        for item_node in schema_node.get('items') or []:
            item_value, item_bindings, item_issues = resolve_schema_node(item_node, snapshot, seed_resolvers)
            values.append(item_value)
            bindings.extend(item_bindings)
            issues.extend(item_issues)
        return values, bindings, issues

    if kind == 'union':
        first_result: tuple[Any, list[dict[str, Any]], list[dict[str, Any]]] | None = None
        for variant_node in schema_node.get('variants') or []:
            candidate = resolve_schema_node(variant_node, snapshot, seed_resolvers)
            if first_result is None:
                first_result = candidate
            if not candidate[2]:
                return candidate
        return first_result or (schema_node.get('template'), [], [])

    return resolve_leaf_value(schema_node, snapshot, seed_resolvers)


def materialize_command_template(invocation_spec: dict[str, Any], snapshot: dict[str, Any], seed_resolvers: dict[str, Any]) -> dict[str, Any]:
    resolved_command = json.loads(json.dumps(invocation_spec.get('commandTemplate')))
    bindings: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []

    if 'payloadSchema' in invocation_spec:
        resolved_payload, payload_bindings, payload_issues = resolve_schema_node(
            invocation_spec['payloadSchema'],
            snapshot,
            seed_resolvers,
        )
        bindings.extend(payload_bindings)
        issues.extend(payload_issues)
        if resolved_payload is None:
            resolved_command.pop('payload', None)
        else:
            resolved_command['payload'] = resolved_payload

    if 'argsSchema' in invocation_spec:
        items = invocation_spec['argsSchema'].get('items') or []
        resolved_args = []
        for item_node in items:
            resolved_arg, arg_bindings, arg_issues = resolve_schema_node(item_node, snapshot, seed_resolvers)
            resolved_args.append(resolved_arg)
            bindings.extend(arg_bindings)
            issues.extend(arg_issues)
        resolved_command['args'] = resolved_args

    for key, value in list(resolved_command.items()):
        if isinstance(value, str):
            resolved_command[key] = materialize_runtime_tokens(value, invocation_spec)

    return {
        'command': resolved_command,
        'bindings': bindings,
        'issues': issues,
        'resolved': not issues,
    }


def select_materialization_candidate(records: list[dict[str, Any]], function_name: str, callable_kind: str | None) -> dict[str, Any] | None:
    exact_matches = [record for record in records if record.get('name') == function_name]
    if callable_kind:
        exact_matches = [record for record in exact_matches if record.get('callableKind') == callable_kind]
    if exact_matches:
        return exact_matches[0]

    normalized_name = function_name.lower()
    partial_matches = [record for record in records if normalized_name in str(record.get('name') or '').lower()]
    if callable_kind:
        partial_matches = [record for record in partial_matches if record.get('callableKind') == callable_kind]
    if partial_matches:
        return partial_matches[0]

    return None


def fetch_records(
    query: str,
    parameters: dict[str, Any] | None = None,
    limit: int = 100,
    timeout_seconds: float = DEFAULT_QUERY_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    safe_limit = max(1, min(limit, MAX_RECORD_LIMIT))
    with DRIVER.session(database=SETTINGS['database']) as session:
        result = session.run(Query(query, timeout=timeout_seconds), parameters or {})
        records: list[dict[str, Any]] = []
        has_more = False
        for index, record in enumerate(result):
            if index >= safe_limit:
                has_more = True
                break
            records.append(normalize_value(record.data()))
        summary = result.consume()

    return {
        'records': records,
        'recordCount': len(records),
        'limited': has_more,
        'database': SETTINGS['database'],
        'queryType': summary.query_type,
        'counters': normalize_value(summary.counters.__dict__),
    }

def build_function_catalog_query() -> str:
        return '''
                MATCH (fn:Fn)
                WHERE coalesce(fn.import_decision, '') <> 'skip'
                WITH fn,
                    split(fn.stableId, ':') AS stableIdParts
                WITH fn,
                    stableIdParts,
                    CASE
                        WHEN size(stableIdParts) >= 2 THEN stableIdParts[0] + ':' + stableIdParts[1]
                        ELSE fn.stableId
                    END AS filePath
                WITH fn,
                    filePath,
                    replace(filePath, 'C:/GitHub/teleGraph/', '') AS relativePath
                WITH fn, filePath, relativePath,
                    coalesce(fn.action_entry_point, false) AS isActionEntryPoint,
                    coalesce(fn.adapter_entry_point, false) AS isAdapterEntryPoint,
                    coalesce(
                        fn.callable_kind,
                        CASE
                        WHEN coalesce(fn.action_entry_point, false) THEN 'direct_action'
                        WHEN coalesce(fn.adapter_entry_point, false) THEN 'api_adapter'
                        ELSE NULL
                        END
                    ) AS callableKind,
                    coalesce(
                        fn.callable_tier,
                        CASE
                        WHEN relativePath STARTS WITH 'src/global/actions/' THEN 'direct'
                        WHEN relativePath STARTS WITH 'src/api/gramjs/methods/' THEN 'adapter'
                        ELSE 'non-callable'
                        END
                    ) AS callableTier,
                    coalesce(
                        fn.call_surface,
                        CASE
                        WHEN relativePath STARTS WITH 'src/global/actions/' THEN 'window.getActions()'
                        WHEN relativePath STARTS WITH 'src/api/gramjs/methods/' THEN 'callApi() or action wrapper'
                        ELSE NULL
                        END
                    ) AS callSurface,
                    coalesce(
                        fn.callable_reason,
                        CASE
                        WHEN relativePath STARTS WITH 'src/global/actions/' THEN 'Function is on the product action surface and can be driven from a live browser session.'
                        WHEN relativePath STARTS WITH 'src/api/gramjs/methods/' THEN 'Function crosses the API boundary and should be invoked through an action or adapter, not called raw from the agent.'
                        ELSE 'Function is not on a stable agent-facing invoke surface yet.'
                        END
                    ) AS callableReason,
                    CASE WHEN fn.name <> '<anonymous>' THEN fn.name ELSE fn.name END AS catalogName
                WHERE ($relativePathPrefix IS NULL OR relativePath STARTS WITH $relativePathPrefix)
                    AND ($query IS NULL OR toLower(catalogName) CONTAINS toLower($query) OR toLower(relativePath) CONTAINS toLower($query))
                    AND ($callableTier IS NULL OR callableTier = $callableTier)
                    AND ($callableKind IS NULL OR callableKind = $callableKind)
                    AND NOT (
                        callableTier = 'direct'
                        AND isActionEntryPoint = false
                        AND coalesce(fn.name, '<anonymous>') = '<anonymous>'
                    )
                RETURN fn.stableId AS stableId,
                             catalogName AS name,
                             fn.function_kind AS functionKind,
                             fn.static_role AS staticRole,
                             relativePath,
                             filePath,
                             isActionEntryPoint,
                             isAdapterEntryPoint,
                             callableKind,
                             fn.action_entry_point_status AS actionEntryPointStatus,
                             fn.action_entry_point_source AS actionEntryPointSource,
                             fn.adapter_entry_point_status AS adapterEntryPointStatus,
                             fn.adapter_entry_point_source AS adapterEntryPointSource,
                             callableTier,
                             callSurface,
                             callableReason,
                             fn.agent_invocation_spec_json AS invocationSpecJson,
                             fn.agent_invocation_readiness AS persistedInvocationReadiness,
                             fn.agent_seed_resolver_keys AS persistedSeedResolverKeys,
                             fn.agent_seed_resolvers_json AS seedResolversJson
                ORDER BY
                    CASE callableTier
                        WHEN 'direct' THEN 0
                        WHEN 'adapter' THEN 1
                        ELSE 2
                    END,
                    CASE WHEN isActionEntryPoint OR isAdapterEntryPoint THEN 0 ELSE 1 END,
                        relativePath,
                    fn.graph_sort_index,
                    catalogName,
                    fn.stableId
        '''


@app.tool(description='Verify that the Neo4j database is reachable and return basic server information.')
def check_connection() -> dict[str, Any]:
    DRIVER.verify_connectivity()

    payload = fetch_records(
        'CALL dbms.components() YIELD name, versions, edition RETURN name, versions, edition',
        limit=10,
    )
    payload['status'] = 'ok'
    payload['uri'] = SETTINGS['uri']
    payload['profile'] = SETTINGS['profile']
    return payload


@app.tool(name='neo4j_check_connection', description='Verify that the Neo4j database is reachable and return basic server information.')
def neo4j_check_connection() -> dict[str, Any]:
    return check_connection()


@app.tool(description='Run a read-only Cypher query and return JSON-safe records.')
def run_read_query(query: str, parameters_json: str = '{}', limit: int = 100) -> dict[str, Any]:
    query_text = query.strip()
    if not query_text:
        raise ValueError('Query must not be empty.')

    lowered = query_text.lower()
    if any(token in lowered for token in [' create ', ' merge ', ' delete ', ' remove ', ' set ', ' drop ', ' detach ', ' call dbms.kill']):
        raise ValueError('Only read-only queries are allowed.')

    parameters = json.loads(parameters_json) if parameters_json else {}
    if not isinstance(parameters, dict):
        raise ValueError('parameters_json must decode to an object.')

    if SETTINGS['profile'] == 'aura':
        with DRIVER.session(database=SETTINGS['database']) as session:
            plan = session.run(Query('EXPLAIN ' + query_text, timeout=DEFAULT_QUERY_TIMEOUT_SECONDS), parameters).consume()
            if plan.query_type != 'r':
                raise ValueError('Only read-only queries are allowed in the Aura MCP profile.')

    return fetch_records(query_text, parameters=parameters, limit=limit)


@app.tool(name='neo4j_run_read_query', description='Run a read-only Cypher query and return JSON-safe records.')
def neo4j_run_read_query(query: str, parameters_json: str = '{}', limit: int = 100) -> dict[str, Any]:
    return run_read_query(query=query, parameters_json=parameters_json, limit=limit)


@app.tool(description='Return a lightweight schema snapshot: labels, relationship types, and property keys.')
def get_schema_overview() -> dict[str, Any]:
    labels = fetch_records('CALL db.labels() YIELD label RETURN label ORDER BY label', limit=500)
    relationship_types = fetch_records(
        'CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType ORDER BY relationshipType',
        limit=500,
    )
    property_keys = fetch_records(
        'CALL db.propertyKeys() YIELD propertyKey RETURN propertyKey ORDER BY propertyKey',
        limit=1000,
    )

    return {
        'labels': labels['records'],
        'relationshipTypes': relationship_types['records'],
        'propertyKeys': property_keys['records'],
        'database': SETTINGS['database'],
        'profile': SETTINGS['profile'],
    }


@app.tool(name='neo4j_get_schema_overview', description='Return a lightweight schema snapshot: labels, relationship types, and property keys.')
def neo4j_get_schema_overview() -> dict[str, Any]:
    return get_schema_overview()


@app.tool(description='Return an agent-facing function catalog with computed callable tiers from the static Neo4j graph.')
def get_function_catalog(
    query: str | None = None,
    relative_path_prefix: str | None = None,
    callable_tier: str | None = None,
    callable_kind: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    allowed_tiers = {'direct', 'adapter', 'non-callable'}
    allowed_kinds = {'direct_action', 'api_adapter'}
    normalized_tier = callable_tier.strip() if callable_tier else None
    normalized_kind = callable_kind.strip() if callable_kind else None
    if normalized_tier and normalized_tier not in allowed_tiers:
        raise ValueError(f'callable_tier must be one of: {", ".join(sorted(allowed_tiers))}')
    if normalized_kind and normalized_kind not in allowed_kinds:
        raise ValueError(f'callable_kind must be one of: {", ".join(sorted(allowed_kinds))}')

    safe_limit = max(1, min(limit, 500))
    payload = fetch_records(
        build_function_catalog_query(),
        parameters={
            'query': query.strip() if query else None,
            'relativePathPrefix': relative_path_prefix.strip() if relative_path_prefix else None,
            'callableTier': normalized_tier,
            'callableKind': normalized_kind,
        },
        limit=safe_limit,
    )
    for record in payload['records']:
        invocation_spec_json = record.pop('invocationSpecJson', None)
        persisted_invocation_readiness = record.pop('persistedInvocationReadiness', None)
        persisted_seed_resolver_keys = record.pop('persistedSeedResolverKeys', None)
        seed_resolvers_json = record.pop('seedResolversJson', None)

        if invocation_spec_json:
            invocation_spec = json.loads(invocation_spec_json)
            record['invocationSpec'] = invocation_spec
            record['invocationReadiness'] = persisted_invocation_readiness or invocation_spec.get('invocationReadiness')
            record['invocationCatalogPath'] = 'neo4j:Fn.agent_invocation_spec_json'
            if persisted_seed_resolver_keys:
                record['seedResolverKeys'] = persisted_seed_resolver_keys
            if seed_resolvers_json:
                seed_resolvers = json.loads(seed_resolvers_json)
                record['seedResolvers'] = seed_resolvers
            continue

    return payload


@app.tool(name='neo4j_get_function_catalog', description='Return an agent-facing function catalog with computed callable tiers from the static Neo4j graph.')
def neo4j_get_function_catalog(
    query: str | None = None,
    relative_path_prefix: str | None = None,
    callable_tier: str | None = None,
    callable_kind: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    return get_function_catalog(
        query=query,
        relative_path_prefix=relative_path_prefix,
        callable_tier=callable_tier,
        callable_kind=callable_kind,
        limit=limit,
    )


@app.tool(description='Return one function record with a live materialized invocation command for the requested callable.')
def materialize_function_invocation(
    function_name: str,
    callable_kind: str | None = None,
) -> dict[str, Any]:
    normalized_name = function_name.strip()
    if not normalized_name:
        raise ValueError('function_name must not be empty.')

    normalized_kind = callable_kind.strip() if callable_kind else None
    if normalized_kind and normalized_kind not in {'direct_action', 'api_adapter'}:
        raise ValueError('callable_kind must be one of: api_adapter, direct_action')

    catalog_payload = get_function_catalog(
        query=normalized_name,
        callable_kind=normalized_kind,
        limit=25,
    )
    record = select_materialization_candidate(catalog_payload['records'], normalized_name, normalized_kind)
    if not record:
        raise ValueError(f'No callable function matched {normalized_name!r}.')

    return {
        'functionName': normalized_name,
        'callableKind': record.get('callableKind'),
        'record': record,
        'materializedInvocation': None,
        'issues': ['Automatic seed materialization was removed with the emulation harness.'],
        'database': catalog_payload.get('database'),
    }


@app.tool(name='neo4j_materialize_function_invocation', description='Return one function record with a live materialized invocation command for the requested callable.')
def neo4j_materialize_function_invocation(
    function_name: str,
    callable_kind: str | None = None,
) -> dict[str, Any]:
    return materialize_function_invocation(function_name=function_name, callable_kind=callable_kind)


@app.tool(description='Materialize one callable and invoke it immediately through the Playwright agent harness when the command transport is supported.')
def invoke_materialized_function(
    function_name: str,
    callable_kind: str | None = None,
) -> dict[str, Any]:
    raise ValueError('Immediate invocation via emulation harness was removed.')


@app.tool(name='neo4j_invoke_materialized_function', description='Materialize one callable and invoke it immediately through the Playwright agent harness when the command transport is supported.')
def neo4j_invoke_materialized_function(
    function_name: str,
    callable_kind: str | None = None,
) -> dict[str, Any]:
    return invoke_materialized_function(function_name=function_name, callable_kind=callable_kind)


def initialize_driver(profile: str) -> None:
    global SETTINGS, DRIVER

    SETTINGS, DRIVER = create_driver(profile)


def main() -> int:
    args = parse_args(sys.argv[1:])
    initialize_driver(args.profile)
    if args.profile == 'aura':
        for name in ('materialize_function_invocation', 'neo4j_materialize_function_invocation',
                     'invoke_materialized_function', 'neo4j_invoke_materialized_function'):
            app.remove_tool(name)

    if args.check:
        print(json.dumps(check_connection(), ensure_ascii=True, indent=2))
        DRIVER.close()
        return 0

    try:
        app.run(transport='stdio')
        return 0
    finally:
        DRIVER.close()


if __name__ == '__main__':
    raise SystemExit(main())
