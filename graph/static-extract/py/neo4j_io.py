from __future__ import annotations

import os
from typing import Any, Iterable

from neo4j import GraphDatabase
from neo4j.exceptions import ClientError

from common import DEFAULT_ARCHITECTURAL_SURFACE_GRAPH_SOURCE, DEFAULT_ASYNC_STALE_RESULT_SUPPRESSION_SOURCE, DEFAULT_ASYNC_TOPOLOGY_SOURCE, DEFAULT_BOUNDARY_CROSSING_SOURCE, DEFAULT_BRANCH_SOURCE, DEFAULT_BUSINESS_OBJECT_LIFECYCLE_SOURCE, DEFAULT_CANONICAL_CONFIG_KEY_GRAPH_SOURCE, DEFAULT_CANONICAL_ENDPOINT_GRAPH_SOURCE, DEFAULT_CANONICAL_FEATURE_FLAG_GRAPH_SOURCE, DEFAULT_COLLECTION_TOPOLOGY_SOURCE, DEFAULT_CONFIG_LAYER_ORCHESTRATION_SOURCE, DEFAULT_CONFIG_TOPOLOGY_STATIC_SCAFFOLDS_SOURCE, DEFAULT_CONTROL_FLOW_GUARD_SOURCE, DEFAULT_DECISION_SOURCE, DEFAULT_DOM_PHASE_SURFACES_SOURCE, DEFAULT_ENVIRONMENT_GATING_SOURCE, DEFAULT_EXCEPTION_HANDLING_WRAPPER_SOURCE, DEFAULT_EXPLAINABILITY_SLICE_CATALOG_SOURCE, DEFAULT_EXPORTED_TYPE_SOURCE, DEFAULT_EXTERNAL_EVENT_LISTENER_SOURCE, DEFAULT_FILE_DEPENDENCY_ARCHITECTURE_SOURCE, DEFAULT_FILE_IMPORT_SOURCE, DEFAULT_FILE_PACKAGE_IMPORT_SOURCE, DEFAULT_FILESYSTEM_SOURCE, DEFAULT_FN_SOURCE, DEFAULT_FOLDER_DEPENDENCY_FLAVORS_SOURCE, DEFAULT_FOLDER_DEPENDENCY_HOTSPOTS_SOURCE, DEFAULT_FOLDER_DOMAIN_NORMALIZATION_SOURCE, DEFAULT_GUARDED_OPERATION_SOURCE, DEFAULT_ITERATION_RECURSION_EXECUTION_SHAPE_SOURCE, DEFAULT_LIFECYCLE_OWNERSHIP_SOURCE, DEFAULT_LIFECYCLE_VISIBILITY_BOUNDARY_SIGNAL_SOURCE, DEFAULT_MERGE_PRECEDENCE_SOURCE, DEFAULT_NOTIFICATION_SURFACE_DOMAIN_PROJECTION_SOURCE, DEFAULT_NOTIFICATION_SURFACE_SUPPORT_SOURCE, DEFAULT_OBSERVABLE_SIDE_EFFECT_SOURCE, DEFAULT_OPERATIONAL_PROOF_ROUTE_SOURCE, DEFAULT_PATTERN_CATALOG_SOURCE, DEFAULT_PREDICATE_COMPOSITION_SOURCE, DEFAULT_PREDICATE_SOURCE, DEFAULT_PRODUCT_FACT_LAYER_SOURCE, DEFAULT_REPRESENTATION_NORMALIZATION_SOURCE, DEFAULT_REPRESENTATION_NORMALIZATION_SUBSTRATE_SOURCE, DEFAULT_RETRY_TRANSPORT_FALLBACK_SOURCE, DEFAULT_RUNTIME_BOOTSTRAP_SOURCE, DEFAULT_RUNTIME_INTEGRATION_BOUNDARY_SOURCE, DEFAULT_RUNTIME_MODE_SCENARIO_BOOTSTRAP_SOURCE, DEFAULT_SEMANTIC_HANDOFF_BLOCKED_REASONS_SOURCE, DEFAULT_SEMANTIC_NAVIGATION_HUBS_SOURCE, DEFAULT_SET_MEMBERSHIP_SOURCE, DEFAULT_STORE_ACCESS_SOURCE, DEFAULT_STORE_NODES_OPERATIONS_SOURCE, DEFAULT_SYNTHETIC_DOUBLES_PLACEHOLDERS_STUBS_SOURCE, DEFAULT_TECHNICAL_ROLE_SURFACES_SOURCE, DEFAULT_TERMINAL_BOUNDARIES_SOURCE, DEFAULT_TYPE_NARROWING_SOURCE, DEFAULT_UI_INTENT_ENTRY_SOURCE, DEFAULT_UI_INTERACTION_SURFACES_SOURCE, DEFAULT_UI_VIEW_STRUCTURE_DOMAIN_PROJECTION_SOURCE, DEFAULT_UI_VIEW_STRUCTURE_SOURCE, DEFAULT_VALUE_RESOLUTION_SOURCE, log_progress, resolve_call_source


SKIP_BASE_SCHEMA_SETUP_ENV = 'TELEGRAPH_STATIC_IMPORT_SKIP_BASE_SCHEMA_SETUP'


def run_schema_statement(session: Any, statement: str) -> None:
    try:
        session.run(statement).consume()
    except ClientError as error:
        if error.code in {
            'Neo.ClientError.Schema.IndexWithNameAlreadyExists',
            'Neo.ClientError.Schema.IndexAlreadyExists',
            'Neo.ClientError.Schema.ConstraintWithNameAlreadyExists',
            'Neo.ClientError.Schema.EquivalentSchemaRuleAlreadyExists',
        }:
            return
        raise


def should_skip_base_schema_setup() -> bool:
    return os.environ.get(SKIP_BASE_SCHEMA_SETUP_ENV) == '1'


def create_constraints(session: Any) -> None:
    if should_skip_base_schema_setup():
        return

    run_schema_statement(session, 'CREATE CONSTRAINT runtime_nodeid IF NOT EXISTS FOR (n:RunTime) REQUIRE n.nodeid IS UNIQUE')
    run_schema_statement(session, 'CREATE CONSTRAINT static_fn_stableId IF NOT EXISTS FOR (n:Fn) REQUIRE n.stableId IS UNIQUE')
    run_schema_statement(session, 'CREATE CONSTRAINT step_id_unique IF NOT EXISTS FOR (n:Step) REQUIRE n.stepId IS UNIQUE')
    run_schema_statement(session, 'CREATE INDEX step_parent_fn IF NOT EXISTS FOR (n:Step) ON (n.parentFnStableId)')
    run_schema_statement(session, 'CREATE CONSTRAINT static_decision_id IF NOT EXISTS FOR (n:Decision) REQUIRE n.decisionId IS UNIQUE')
    run_schema_statement(session, 'CREATE CONSTRAINT static_predicate_id IF NOT EXISTS FOR (n:Predicate) REQUIRE n.predicateId IS UNIQUE')
    run_schema_statement(session, 'CREATE CONSTRAINT static_branch_id IF NOT EXISTS FOR (n:Branch) REQUIRE n.branchId IS UNIQUE')
    run_schema_statement(session, 'CREATE CONSTRAINT static_store_key IF NOT EXISTS FOR (n:Store) REQUIRE n.storeKey IS UNIQUE')
    run_schema_statement(session, 'CREATE CONSTRAINT package_name_unique IF NOT EXISTS FOR (n:Package) REQUIRE n.name IS UNIQUE')
    run_schema_statement(session, 'CREATE CONSTRAINT domain_key_unique IF NOT EXISTS FOR (n:Domain) REQUIRE n.key IS UNIQUE')
    run_schema_statement(session, 'CREATE CONSTRAINT graph_import_run_unique IF NOT EXISTS FOR (n:GraphImportRun) REQUIRE (n.source, n.commit, n.scope) IS UNIQUE')


def ensure_base_schema(settings: dict[str, str]) -> None:
    driver = GraphDatabase.driver(settings['uri'], auth=(settings['username'], settings['password']))
    try:
        with driver.session(database=settings['database']) as session:
            create_constraints(session)
    finally:
        driver.close()


def record_import_run(
    session: Any,
    *,
    source: str,
    graph_recorded_commit_short: str,
    query_id: str,
    scope: str = 'default',
    rows_written: int | None = None,
) -> None:
    session.run(
        '''
        MERGE (run:GraphImportRun {source: $source, commit: $commit, scope: $scope})
        SET run.query_id = $query_id,
            run.rows_written = $rows_written
        ''',
        {
            'source': source,
            'commit': graph_recorded_commit_short,
            'scope': scope,
            'query_id': query_id,
            'rows_written': rows_written,
        },
    ).consume()


def clear_previous_fn_import(session: Any, source: str) -> None:
    session.run('MATCH (n:Fn) DETACH DELETE n').consume()


def clear_previous_filesystem_import(session: Any, source: str) -> None:
    session.run('MATCH (n) WHERE n:File OR n:Folder DETACH DELETE n').consume()


def clear_previous_store_access_import(session: Any, source: str) -> None:
    session.run('MATCH (n:Store) DETACH DELETE n').consume()


def clear_previous_static_calls(session: Any, precision_filter: str) -> None:
    if precision_filter == 'all':
        session.run('MATCH ()-[rel:STATIC_CALLS]->() DELETE rel').consume()
        session.run('MATCH (n:Step:Call) DETACH DELETE n').consume()
        return
    session.run(
        'MATCH ()-[rel:STATIC_CALLS]->() WHERE rel.precision = $precision DELETE rel',
        {'precision': precision_filter},
    ).consume()
    session.run(
        'MATCH (n:Step:Call) WHERE n.precision = $precision DETACH DELETE n',
        {'precision': precision_filter},
    ).consume()




def load_existing_fn_stableIds(settings: dict[str, str]) -> set[str]:
    driver = GraphDatabase.driver(settings['uri'], auth=(settings['username'], settings['password']))
    try:
        with driver.session(database=settings['database']) as session:
            result = session.run('MATCH (fn:Fn) RETURN fn.stableId AS stableId')
            return {record['stableId'] for record in result if record['stableId']}
    finally:
        driver.close()


def load_layer_readiness(
    settings: dict[str, str],
    graph_recorded_commit_short: str,
    call_precisions: list[str],
) -> dict[str, bool]:
    driver = GraphDatabase.driver(settings['uri'], auth=(settings['username'], settings['password']))
    try:
        with driver.session(database=settings['database']) as session:
            readiness_runs = session.run(
                '''
                MATCH (run:GraphImportRun)
                WHERE run.commit = $commit
                  AND run.source IN $sources
                RETURN run.source AS source, collect(DISTINCT run.scope) AS scopes
                ''',
                {
                    'commit': graph_recorded_commit_short,
                    'sources': [
                        DEFAULT_FN_SOURCE,
                        DEFAULT_FILESYSTEM_SOURCE,
                        DEFAULT_FILE_IMPORT_SOURCE,
                        DEFAULT_FILE_PACKAGE_IMPORT_SOURCE,
                        DEFAULT_FILE_DEPENDENCY_ARCHITECTURE_SOURCE,
                        DEFAULT_FOLDER_DEPENDENCY_FLAVORS_SOURCE,
                        DEFAULT_FOLDER_DEPENDENCY_HOTSPOTS_SOURCE,
                        DEFAULT_FOLDER_DOMAIN_NORMALIZATION_SOURCE,
                        DEFAULT_REPRESENTATION_NORMALIZATION_SOURCE,
                        DEFAULT_REPRESENTATION_NORMALIZATION_SUBSTRATE_SOURCE,
                        DEFAULT_NOTIFICATION_SURFACE_SUPPORT_SOURCE,
                        DEFAULT_NOTIFICATION_SURFACE_DOMAIN_PROJECTION_SOURCE,
                        DEFAULT_UI_VIEW_STRUCTURE_SOURCE,
                        DEFAULT_UI_VIEW_STRUCTURE_DOMAIN_PROJECTION_SOURCE,
                        DEFAULT_UI_INTERACTION_SURFACES_SOURCE,
                        DEFAULT_UI_INTENT_ENTRY_SOURCE,
                        DEFAULT_GUARDED_OPERATION_SOURCE,
                        DEFAULT_BOUNDARY_CROSSING_SOURCE,
                        DEFAULT_OBSERVABLE_SIDE_EFFECT_SOURCE,
                        DEFAULT_SEMANTIC_HANDOFF_BLOCKED_REASONS_SOURCE,
                        DEFAULT_TERMINAL_BOUNDARIES_SOURCE,
                        DEFAULT_ASYNC_TOPOLOGY_SOURCE,
                        DEFAULT_RUNTIME_BOOTSTRAP_SOURCE,
                        DEFAULT_RUNTIME_MODE_SCENARIO_BOOTSTRAP_SOURCE,
                        DEFAULT_OPERATIONAL_PROOF_ROUTE_SOURCE,
                        DEFAULT_EXTERNAL_EVENT_LISTENER_SOURCE,
                        DEFAULT_LIFECYCLE_VISIBILITY_BOUNDARY_SIGNAL_SOURCE,
                        DEFAULT_PATTERN_CATALOG_SOURCE,
                        DEFAULT_CONTROL_FLOW_GUARD_SOURCE,
                        DEFAULT_EXCEPTION_HANDLING_WRAPPER_SOURCE,
                        DEFAULT_VALUE_RESOLUTION_SOURCE,
                        DEFAULT_SET_MEMBERSHIP_SOURCE,
                        DEFAULT_COLLECTION_TOPOLOGY_SOURCE,
                        DEFAULT_TYPE_NARROWING_SOURCE,
                        DEFAULT_MERGE_PRECEDENCE_SOURCE,
                        DEFAULT_PREDICATE_COMPOSITION_SOURCE,
                        DEFAULT_ENVIRONMENT_GATING_SOURCE,
                        DEFAULT_ASYNC_STALE_RESULT_SUPPRESSION_SOURCE,
                        DEFAULT_LIFECYCLE_OWNERSHIP_SOURCE,
                        DEFAULT_RETRY_TRANSPORT_FALLBACK_SOURCE,
                        DEFAULT_EXPLAINABILITY_SLICE_CATALOG_SOURCE,
                        DEFAULT_STORE_NODES_OPERATIONS_SOURCE,
                        DEFAULT_ITERATION_RECURSION_EXECUTION_SHAPE_SOURCE,
                        DEFAULT_CANONICAL_FEATURE_FLAG_GRAPH_SOURCE,
                        DEFAULT_SYNTHETIC_DOUBLES_PLACEHOLDERS_STUBS_SOURCE,
                        DEFAULT_CONFIG_TOPOLOGY_STATIC_SCAFFOLDS_SOURCE,
                        DEFAULT_RUNTIME_INTEGRATION_BOUNDARY_SOURCE,
                        DEFAULT_PRODUCT_FACT_LAYER_SOURCE,
                        DEFAULT_TECHNICAL_ROLE_SURFACES_SOURCE,
                        DEFAULT_DOM_PHASE_SURFACES_SOURCE,
                        DEFAULT_SEMANTIC_NAVIGATION_HUBS_SOURCE,
                        DEFAULT_ARCHITECTURAL_SURFACE_GRAPH_SOURCE,
                        DEFAULT_CONFIG_LAYER_ORCHESTRATION_SOURCE,
                        DEFAULT_CANONICAL_CONFIG_KEY_GRAPH_SOURCE,
                        DEFAULT_CANONICAL_ENDPOINT_GRAPH_SOURCE,
                        DEFAULT_DECISION_SOURCE,
                        DEFAULT_PREDICATE_SOURCE,
                        DEFAULT_BRANCH_SOURCE,
                        DEFAULT_STORE_ACCESS_SOURCE,
                        DEFAULT_EXPORTED_TYPE_SOURCE,
                        DEFAULT_BUSINESS_OBJECT_LIFECYCLE_SOURCE,
                        *[resolve_call_source(precision) for precision in call_precisions],
                    ],
                },
            )
            scopes_by_source = {
                record['source']: set(record['scopes'])
                for record in readiness_runs
            }

            calls_ready = True
            for precision in call_precisions:
                if 'default' not in scopes_by_source.get(resolve_call_source(precision), set()):
                    calls_ready = False
                    break

            exported_type_ready = 'default' in scopes_by_source.get(DEFAULT_EXPORTED_TYPE_SOURCE, set())
            business_object_lifecycle_ready = (
                exported_type_ready
                and 'default' in scopes_by_source.get(DEFAULT_BUSINESS_OBJECT_LIFECYCLE_SOURCE, set())
            )

            return {
                'fn': 'default' in scopes_by_source.get(DEFAULT_FN_SOURCE, set()),
                'filesystem': 'default' in scopes_by_source.get(DEFAULT_FILESYSTEM_SOURCE, set()),
                'file_import': 'default' in scopes_by_source.get(DEFAULT_FILE_IMPORT_SOURCE, set()),
                'file_package_import': 'default' in scopes_by_source.get(DEFAULT_FILE_PACKAGE_IMPORT_SOURCE, set()),
                'file_dependency_architecture': 'default' in scopes_by_source.get(DEFAULT_FILE_DEPENDENCY_ARCHITECTURE_SOURCE, set()),
                'folder_dependency_flavors': 'default' in scopes_by_source.get(DEFAULT_FOLDER_DEPENDENCY_FLAVORS_SOURCE, set()),
                'folder_dependency_hotspots': 'default' in scopes_by_source.get(DEFAULT_FOLDER_DEPENDENCY_HOTSPOTS_SOURCE, set()),
                'folder_domain_normalization': 'default' in scopes_by_source.get(DEFAULT_FOLDER_DOMAIN_NORMALIZATION_SOURCE, set()),
                'representation_normalization': 'default' in scopes_by_source.get(DEFAULT_REPRESENTATION_NORMALIZATION_SOURCE, set()),
                'representation_normalization_substrate': 'default' in scopes_by_source.get(DEFAULT_REPRESENTATION_NORMALIZATION_SUBSTRATE_SOURCE, set()),
                'notification_surface_support': 'default' in scopes_by_source.get(DEFAULT_NOTIFICATION_SURFACE_SUPPORT_SOURCE, set()),
                'notification_surface_domain_projection': 'default' in scopes_by_source.get(DEFAULT_NOTIFICATION_SURFACE_DOMAIN_PROJECTION_SOURCE, set()),
                'ui_view_structure': 'default' in scopes_by_source.get(DEFAULT_UI_VIEW_STRUCTURE_SOURCE, set()),
                'ui_view_structure_domain_projection': 'default' in scopes_by_source.get(DEFAULT_UI_VIEW_STRUCTURE_DOMAIN_PROJECTION_SOURCE, set()),
                'ui_interaction_surfaces': 'default' in scopes_by_source.get(DEFAULT_UI_INTERACTION_SURFACES_SOURCE, set()),
                'ui_intent_entry': 'default' in scopes_by_source.get(DEFAULT_UI_INTENT_ENTRY_SOURCE, set()),
                'guarded_operation': 'default' in scopes_by_source.get(DEFAULT_GUARDED_OPERATION_SOURCE, set()),
                'boundary_crossing': 'default' in scopes_by_source.get(DEFAULT_BOUNDARY_CROSSING_SOURCE, set()),
                'observable_side_effect': 'default' in scopes_by_source.get(DEFAULT_OBSERVABLE_SIDE_EFFECT_SOURCE, set()),
                'semantic_handoff_blocked_reasons': 'default' in scopes_by_source.get(DEFAULT_SEMANTIC_HANDOFF_BLOCKED_REASONS_SOURCE, set()),
                'terminal_boundaries': 'default' in scopes_by_source.get(DEFAULT_TERMINAL_BOUNDARIES_SOURCE, set()),
                'async_topology': 'default' in scopes_by_source.get(DEFAULT_ASYNC_TOPOLOGY_SOURCE, set()),
                'runtime_bootstrap': 'default' in scopes_by_source.get(DEFAULT_RUNTIME_BOOTSTRAP_SOURCE, set()),
                'runtime_mode_scenario_bootstrap': 'default' in scopes_by_source.get(DEFAULT_RUNTIME_MODE_SCENARIO_BOOTSTRAP_SOURCE, set()),
                'operational_proof_route': 'default' in scopes_by_source.get(DEFAULT_OPERATIONAL_PROOF_ROUTE_SOURCE, set()),
                'external_event_listeners': 'default' in scopes_by_source.get(DEFAULT_EXTERNAL_EVENT_LISTENER_SOURCE, set()),
                'lifecycle_visibility_boundary_signals': 'default' in scopes_by_source.get(DEFAULT_LIFECYCLE_VISIBILITY_BOUNDARY_SIGNAL_SOURCE, set()),
                'pattern_catalog': 'default' in scopes_by_source.get(DEFAULT_PATTERN_CATALOG_SOURCE, set()),
                'control_flow_guards': 'default' in scopes_by_source.get(DEFAULT_CONTROL_FLOW_GUARD_SOURCE, set()),
                'exception_handling_wrappers': 'default' in scopes_by_source.get(DEFAULT_EXCEPTION_HANDLING_WRAPPER_SOURCE, set()),
                'value_resolution': 'default' in scopes_by_source.get(DEFAULT_VALUE_RESOLUTION_SOURCE, set()),
                'set_membership': 'default' in scopes_by_source.get(DEFAULT_SET_MEMBERSHIP_SOURCE, set()),
                'collection_topology': 'default' in scopes_by_source.get(DEFAULT_COLLECTION_TOPOLOGY_SOURCE, set()),
                'type_narrowing': 'default' in scopes_by_source.get(DEFAULT_TYPE_NARROWING_SOURCE, set()),
                'merge_precedence': 'default' in scopes_by_source.get(DEFAULT_MERGE_PRECEDENCE_SOURCE, set()),
                'predicate_composition': 'default' in scopes_by_source.get(DEFAULT_PREDICATE_COMPOSITION_SOURCE, set()),
                'environment_gating': 'default' in scopes_by_source.get(DEFAULT_ENVIRONMENT_GATING_SOURCE, set()),
                'async_stale_result_suppression': 'default' in scopes_by_source.get(DEFAULT_ASYNC_STALE_RESULT_SUPPRESSION_SOURCE, set()),
                'lifecycle_ownership': 'default' in scopes_by_source.get(DEFAULT_LIFECYCLE_OWNERSHIP_SOURCE, set()),
                'retry_transport_fallback': 'default' in scopes_by_source.get(DEFAULT_RETRY_TRANSPORT_FALLBACK_SOURCE, set()),
                'explainability_slice_catalog': 'default' in scopes_by_source.get(DEFAULT_EXPLAINABILITY_SLICE_CATALOG_SOURCE, set()),
                'store_nodes_operations': 'default' in scopes_by_source.get(DEFAULT_STORE_NODES_OPERATIONS_SOURCE, set()),
                'iteration_recursion_execution_shape': 'default' in scopes_by_source.get(DEFAULT_ITERATION_RECURSION_EXECUTION_SHAPE_SOURCE, set()),
                'canonical_feature_flag_graph': 'default' in scopes_by_source.get(DEFAULT_CANONICAL_FEATURE_FLAG_GRAPH_SOURCE, set()),
                'synthetic_doubles_placeholders_stubs': 'default' in scopes_by_source.get(DEFAULT_SYNTHETIC_DOUBLES_PLACEHOLDERS_STUBS_SOURCE, set()),
                'config_topology_static_scaffolds': 'default' in scopes_by_source.get(DEFAULT_CONFIG_TOPOLOGY_STATIC_SCAFFOLDS_SOURCE, set()),
                'runtime_integration_boundary': 'default' in scopes_by_source.get(DEFAULT_RUNTIME_INTEGRATION_BOUNDARY_SOURCE, set()),
                'product_fact_layer': 'default' in scopes_by_source.get(DEFAULT_PRODUCT_FACT_LAYER_SOURCE, set()),
                'technical_role_surfaces': 'default' in scopes_by_source.get(DEFAULT_TECHNICAL_ROLE_SURFACES_SOURCE, set()),
                'dom_phase_surfaces': 'default' in scopes_by_source.get(DEFAULT_DOM_PHASE_SURFACES_SOURCE, set()),
                'semantic_navigation_hubs': 'default' in scopes_by_source.get(DEFAULT_SEMANTIC_NAVIGATION_HUBS_SOURCE, set()),
                'architectural_surface_graph': 'default' in scopes_by_source.get(DEFAULT_ARCHITECTURAL_SURFACE_GRAPH_SOURCE, set()),
                'config_layer_orchestration': 'default' in scopes_by_source.get(DEFAULT_CONFIG_LAYER_ORCHESTRATION_SOURCE, set()),
                'canonical_config_key_graph': 'default' in scopes_by_source.get(DEFAULT_CANONICAL_CONFIG_KEY_GRAPH_SOURCE, set()),
                'canonical_endpoint_graph': 'default' in scopes_by_source.get(DEFAULT_CANONICAL_ENDPOINT_GRAPH_SOURCE, set()),
                'calls': calls_ready,
                'decision': 'default' in scopes_by_source.get(DEFAULT_DECISION_SOURCE, set()),
                'predicate': 'default' in scopes_by_source.get(DEFAULT_PREDICATE_SOURCE, set()),
                'branch': 'default' in scopes_by_source.get(DEFAULT_BRANCH_SOURCE, set()),
                'store': 'default' in scopes_by_source.get(DEFAULT_STORE_ACCESS_SOURCE, set()),
                'exported_type': exported_type_ready,
                'business_object_lifecycle': business_object_lifecycle_ready,
            }
    finally:
        driver.close()


def import_batch(session: Any, rows: list[dict[str, Any]], source: str, query_id: str) -> None:
    session.run(
        '''
        UNWIND $rows AS row
        MERGE (fn:Fn {stableId: row.stableId})
        REMOVE fn:Accessor
        REMOVE fn:Constructor
        REMOVE fn:Wrapper
        REMOVE fn:Anonymous
        REMOVE fn.is_accessor
        REMOVE fn.is_wrapper
        REMOVE fn.is_anonymous
        REMOVE fn.identity_role
        REMOVE fn.graph_recorded_commit_short
        REMOVE fn.action_entry_point_name
        REMOVE fn.adapter_entry_point_name
        REMOVE fn.callable_name
        SET fn.name = row.name,
            fn.function_kind = row.function_kind,
            fn.static_role = row.static_role,
            fn.identity_roles = row.identity_roles,
            fn.import_decision = row.import_decision,
            fn.action_entry_point = row.action_entry_point,
            fn.action_entry_point_status = row.action_entry_point_status,
            fn.action_entry_point_source = row.action_entry_point_source,
            fn.adapter_entry_point = row.adapter_entry_point,
            fn.adapter_entry_point_status = row.adapter_entry_point_status,
            fn.adapter_entry_point_source = row.adapter_entry_point_source,
            fn.callable_kind = row.callable_kind,
            fn.callable_tier = row.callable_tier,
            fn.call_surface = row.call_surface,
            fn.callable_reason = row.callable_reason,
            fn.graph_sort_index = row.sort_index
        FOREACH (_ IN CASE WHEN row.static_role = 'constructor' THEN [1] ELSE [] END | SET fn:Constructor)
        ''',
        {'rows': rows},
    ).consume()


def import_file_batch(session: Any, rows: list[dict[str, Any]], source: str, query_id: str) -> None:
    session.run(
        '''
        UNWIND $rows AS row
        MERGE (file:File {path: row.path})
        SET file.stableId = 'file:' + row.relative_path,
            file.relative_path = row.relative_path,
            file.name = row.name,
            file.parent_folder_path = row.parent_folder_path,
            file.parent_folder_relative_path = row.parent_folder_relative_path,
            file.graph_recorded_commit_short = row.graph_recorded_commit_short
        ''',
        {'rows': rows},
    ).consume()


def import_folder_batch(session: Any, rows: list[dict[str, Any]], source: str, query_id: str) -> None:
    session.run(
        '''
        UNWIND $rows AS row
        MERGE (folder:Folder {path: row.path})
        SET folder.relative_path = row.relative_path,
            folder.name = row.name,
            folder.depth = row.depth,
            folder.is_workspace_root = row.is_workspace_root,
            folder.graph_recorded_commit_short = row.graph_recorded_commit_short
        ''',
        {'rows': rows},
    ).consume()


def import_declared_in_batch(session: Any, rows: list[dict[str, Any]]) -> None:
    session.run(
        '''
        UNWIND $rows AS row
        MATCH (fn:Fn {stableId: row.stableId})
        MATCH (file:File {path: row.file_path})
        MERGE (fn)-[:DECLARED_IN]->(file)
        ''',
        {'rows': rows},
    ).consume()


def import_file_folder_batch(session: Any, rows: list[dict[str, Any]]) -> None:
    session.run(
        '''
        UNWIND $rows AS row
        MATCH (file:File {path: row.path})
        MATCH (folder:Folder {path: row.parent_folder_path})
        MERGE (file)-[:IN_FOLDER]->(folder)
        ''',
        {'rows': rows},
    ).consume()


def import_folder_parent_batch(session: Any, rows: list[dict[str, str]]) -> None:
    session.run(
        '''
        UNWIND $rows AS row
        MATCH (child:Folder {path: row.child_path})
        MATCH (parent:Folder {path: row.parent_path})
        MERGE (child)-[:PARENT_FOLDER]->(parent)
        ''',
        {'rows': rows},
    ).consume()


def import_static_calls_batch(
    session: Any,
    rows: list[dict[str, Any]],
    source: str,
    query_id: str,
    graph_recorded_commit_short: str,
) -> None:
    session.run(
        '''
        UNWIND $rows AS row
        MATCH (fn:Fn {stableId: row.parentFnStableId})
        MATCH (callee:Fn {stableId: row.calleeStableId})
        MERGE (fn)-[rel:STATIC_CALLS {
            call_site: row.call_site,
            calleeStableId: row.calleeStableId,
            precision: row.precision
        }]->(callee)
        SET rel.precision = row.precision,
            rel.imprecision_level = row.imprecision_level,
            rel.is_direct = row.is_direct,
            rel.call_site = row.call_site,
            rel.stableId = row.stableId,
            rel.callee_name = row.callee_name,
            rel.graph_recorded_commit_short = $graph_recorded_commit_short
        ''',
        {
            'rows': rows,
            'graph_recorded_commit_short': graph_recorded_commit_short,
        },
    ).consume()


def import_store_access_batch(session: Any, rows: list[dict[str, Any]], source: str, query_id: str) -> None:
    session.run(
        '''
        UNWIND $rows AS row
        MATCH (fn:Fn {stableId: row.parentFnStableId})
        MERGE (store:Store {storeKey: row.store_key})
        SET store.name = row.store_name,
            store.storeKey = row.store_key,
            store.store_kind = row.store_kind,
            store.storeKind = row.store_kind,
            store.graph_recorded_commit_short = row.graph_recorded_commit_short
        FOREACH (_ IN CASE WHEN row.access_type = 'get' THEN [1] ELSE [] END |
            MERGE (fn)-[rel:STATIC_GET]->(store)
            SET rel.graph_recorded_commit_short = row.graph_recorded_commit_short)
        FOREACH (_ IN CASE WHEN row.access_type = 'set' THEN [1] ELSE [] END |
            MERGE (fn)-[rel:STATIC_SET]->(store)
            SET rel.graph_recorded_commit_short = row.graph_recorded_commit_short)
        FOREACH (_ IN CASE WHEN row.access_type = 'del' THEN [1] ELSE [] END |
            MERGE (fn)-[rel:STATIC_DEL]->(store)
            SET rel.graph_recorded_commit_short = row.graph_recorded_commit_short)
        FOREACH (_ IN CASE WHEN row.access_type = 'clear' THEN [1] ELSE [] END |
            MERGE (fn)-[rel:STATIC_CLEAR]->(store)
            SET rel.graph_recorded_commit_short = row.graph_recorded_commit_short)
        ''',
        {'rows': rows},
    ).consume()


def write_fn_to_neo4j(
    settings: dict[str, str],
    rows: list[dict[str, Any]],
    source: str,
    query_id: str,
    graph_recorded_commit_short: str,
    batch_size: int,
    replace_existing: bool,
) -> None:
    driver = GraphDatabase.driver(settings['uri'], auth=(settings['username'], settings['password']))
    try:
        with driver.session(database=settings['database']) as session:
            create_constraints(session)
            if replace_existing:
                clear_previous_fn_import(session, source)
            for start in range(0, len(rows), batch_size):
                import_batch(session, rows[start:start + batch_size], source, query_id)
            record_import_run(session, source=source, graph_recorded_commit_short=graph_recorded_commit_short, query_id=query_id, rows_written=len(rows))
    finally:
        driver.close()


def write_store_accesses_to_neo4j(
    settings: dict[str, str],
    rows: list[dict[str, Any]],
    source: str,
    query_id: str,
    graph_recorded_commit_short: str,
    batch_size: int,
    replace_existing: bool,
) -> None:
    driver = GraphDatabase.driver(settings['uri'], auth=(settings['username'], settings['password']))
    try:
        with driver.session(database=settings['database']) as session:
            create_constraints(session)
            if replace_existing:
                clear_previous_store_access_import(session, source)
            for start in range(0, len(rows), batch_size):
                import_store_access_batch(session, rows[start:start + batch_size], source, query_id)
            record_import_run(session, source=source, graph_recorded_commit_short=graph_recorded_commit_short, query_id=query_id, rows_written=len(rows))
    finally:
        driver.close()


def write_filesystem_to_neo4j(
    settings: dict[str, str],
    rows: list[dict[str, Any]],
    file_rows: list[dict[str, Any]],
    folder_rows: list[dict[str, Any]],
    declared_in_edges: list[dict[str, str]],
    folder_parent_edges: list[dict[str, str]],
    source: str,
    query_id: str,
    graph_recorded_commit_short: str,
    batch_size: int,
    replace_existing: bool,
) -> None:
    driver = GraphDatabase.driver(settings['uri'], auth=(settings['username'], settings['password']))
    try:
        with driver.session(database=settings['database']) as session:
            create_constraints(session)
            if replace_existing:
                clear_previous_filesystem_import(session, source)
            for start in range(0, len(folder_rows), batch_size):
                import_folder_batch(session, folder_rows[start:start + batch_size], source, query_id)
            for start in range(0, len(file_rows), batch_size):
                import_file_batch(session, file_rows[start:start + batch_size], source, query_id)
            for start in range(0, len(folder_parent_edges), batch_size):
                import_folder_parent_batch(session, folder_parent_edges[start:start + batch_size])
            for start in range(0, len(file_rows), batch_size):
                import_file_folder_batch(session, file_rows[start:start + batch_size])
            for start in range(0, len(declared_in_edges), batch_size):
                import_declared_in_batch(session, declared_in_edges[start:start + batch_size])
            record_import_run(session, source=source, graph_recorded_commit_short=graph_recorded_commit_short, query_id=query_id, rows_written=len(file_rows) + len(folder_rows))
    finally:
        driver.close()


def write_static_calls_to_neo4j(
    settings: dict[str, str],
    static_call_rows: Iterable[dict[str, Any]],
    source: str,
    query_id: str,
    graph_recorded_commit_short: str,
    batch_size: int,
    replace_existing: bool,
    precision_filter: str,
) -> int:
    driver = GraphDatabase.driver(settings['uri'], auth=(settings['username'], settings['password']))
    processed_rows = 0
    try:
        with driver.session(database=settings['database']) as session:
            create_constraints(session)
            if replace_existing:
                clear_previous_static_calls(session, precision_filter)

            batch: list[dict[str, Any]] = []
            for row in static_call_rows:
                batch.append(row)
                if len(batch) >= batch_size:
                    import_static_calls_batch(session, batch, source, query_id, graph_recorded_commit_short)
                    processed_rows += len(batch)
                    if processed_rows % 10000 == 0:
                        log_progress(f'[neo4j] wrote {processed_rows} STATIC_CALLS[{precision_filter}] rows')
                    batch = []

            if batch:
                import_static_calls_batch(session, batch, source, query_id, graph_recorded_commit_short)
                processed_rows += len(batch)
                log_progress(f'[neo4j] wrote {processed_rows} STATIC_CALLS[{precision_filter}] rows')
            record_import_run(session, source=source, graph_recorded_commit_short=graph_recorded_commit_short, query_id=query_id, rows_written=processed_rows)
    finally:
        driver.close()

    return processed_rows


