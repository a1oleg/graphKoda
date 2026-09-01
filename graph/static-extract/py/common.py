from __future__ import annotations

import os
import subprocess
from pathlib import Path

from dotenv import load_dotenv


SCRIPT_DIR = Path(__file__).resolve().parent
GRAPH_DIR = SCRIPT_DIR.parent
WORKSPACE_DIR = GRAPH_DIR.parent.parent
ENV_PATH = GRAPH_DIR.parent / '.env'

DEFAULT_FN_SOURCE = 'static/functionImport/fn'
DEFAULT_FILESYSTEM_SOURCE = 'static/functionImport/filesystem'
DEFAULT_REPO_FILESYSTEM_SOURCE = 'static/repoFilesystem'
DEFAULT_CALL_SOURCE = 'static/calls'
DEFAULT_DECISION_SOURCE = 'static/decisionImport/decision'
DEFAULT_PREDICATE_SOURCE = 'static/predicateImport/predicate'
DEFAULT_BRANCH_SOURCE = 'static/branchImport/branch'
DEFAULT_STORE_ACCESS_SOURCE = 'static/storeAccessImport/store'
DEFAULT_CONTROL_FLOW_SOURCE = 'static/controlFlowImport/cfg'
DEFAULT_FILE_IMPORT_SOURCE = 'static/fileImportGraph'
DEFAULT_FILE_PACKAGE_IMPORT_SOURCE = 'static/filePackageImportGraph'
DEFAULT_FILE_DEPENDENCY_ARCHITECTURE_SOURCE = 'fileDependencyArchitecture'
DEFAULT_FOLDER_DEPENDENCY_FLAVORS_SOURCE = 'folderDependencyFlavors'
DEFAULT_FOLDER_DEPENDENCY_HOTSPOTS_SOURCE = 'folderDependencyHotspots'
DEFAULT_FOLDER_DOMAIN_NORMALIZATION_SOURCE = 'folderDomainNormalization'
DEFAULT_REPRESENTATION_NORMALIZATION_SOURCE = 'representationNormalization'
DEFAULT_REPRESENTATION_NORMALIZATION_SUBSTRATE_SOURCE = 'representationNormalizationSubstrate'
DEFAULT_NOTIFICATION_SURFACE_SUPPORT_SOURCE = 'notificationSurfaceSupport'
DEFAULT_NOTIFICATION_SURFACE_DOMAIN_PROJECTION_SOURCE = 'notificationSurfaceDomainProjection'
DEFAULT_UI_VIEW_STRUCTURE_SOURCE = 'uiViewStructure'
DEFAULT_UI_VIEW_STRUCTURE_DOMAIN_PROJECTION_SOURCE = 'uiViewStructureDomainProjection'
DEFAULT_UI_INTERACTION_SURFACES_SOURCE = 'uiInteractionSurfaces'
DEFAULT_UI_INTENT_ENTRY_SOURCE = 'uiIntentEntry'
DEFAULT_GUARDED_OPERATION_SOURCE = 'guardedOperation'
DEFAULT_BOUNDARY_CROSSING_SOURCE = 'boundaryCrossing'
DEFAULT_OBSERVABLE_SIDE_EFFECT_SOURCE = 'observableSideEffect'
DEFAULT_SEMANTIC_HANDOFF_BLOCKED_REASONS_SOURCE = 'semanticHandoffBlockedReasons'
DEFAULT_TERMINAL_BOUNDARIES_SOURCE = 'terminalBoundaries'
DEFAULT_ASYNC_TOPOLOGY_SOURCE = 'asyncTopology'
DEFAULT_RUNTIME_BOOTSTRAP_SOURCE = 'runtimeBootstrap'
DEFAULT_CONFIG_LAYER_ORCHESTRATION_SOURCE = 'configLayerOrchestration'
DEFAULT_CANONICAL_CONFIG_KEY_GRAPH_SOURCE = 'canonicalConfigKeyGraph'
DEFAULT_CANONICAL_ENDPOINT_GRAPH_SOURCE = 'canonicalEndpointGraph'
DEFAULT_RUNTIME_MODE_SCENARIO_BOOTSTRAP_SOURCE = 'runtimeModeScenarioBootstrap'
DEFAULT_OPERATIONAL_PROOF_ROUTE_SOURCE = 'operationalProofRoute'
DEFAULT_EXTERNAL_EVENT_LISTENER_SOURCE = 'externalEventListeners'
DEFAULT_LIFECYCLE_VISIBILITY_BOUNDARY_SIGNAL_SOURCE = 'lifecycleVisibilityBoundarySignals'
DEFAULT_PATTERN_CATALOG_SOURCE = 'patternCatalog'
DEFAULT_CONTROL_FLOW_GUARD_SOURCE = 'controlFlowGuards'
DEFAULT_EXCEPTION_HANDLING_WRAPPER_SOURCE = 'exceptionHandlingWrappers'
DEFAULT_VALUE_RESOLUTION_SOURCE = 'valueResolution'
DEFAULT_SET_MEMBERSHIP_SOURCE = 'setMembership'
DEFAULT_COLLECTION_TOPOLOGY_SOURCE = 'collectionTopology'
DEFAULT_TYPE_NARROWING_SOURCE = 'typeNarrowing'
DEFAULT_MERGE_PRECEDENCE_SOURCE = 'mergePrecedence'
DEFAULT_PREDICATE_COMPOSITION_SOURCE = 'predicateComposition'
DEFAULT_ENVIRONMENT_GATING_SOURCE = 'environmentGating'
DEFAULT_ASYNC_STALE_RESULT_SUPPRESSION_SOURCE = 'asyncStaleResultSuppression'
DEFAULT_LIFECYCLE_OWNERSHIP_SOURCE = 'lifecycleOwnership'
DEFAULT_RETRY_TRANSPORT_FALLBACK_SOURCE = 'retryTransportFallback'
DEFAULT_EXPLAINABILITY_SLICE_CATALOG_SOURCE = 'explainabilitySliceCatalog'
DEFAULT_STORE_NODES_OPERATIONS_SOURCE = 'storeNodesOperations'
DEFAULT_ITERATION_RECURSION_EXECUTION_SHAPE_SOURCE = 'iterationRecursionExecutionShape'
DEFAULT_CANONICAL_FEATURE_FLAG_GRAPH_SOURCE = 'canonicalFeatureFlagGraph'
DEFAULT_SYNTHETIC_DOUBLES_PLACEHOLDERS_STUBS_SOURCE = 'syntheticDoublesPlaceholdersStubs'
DEFAULT_CONFIG_TOPOLOGY_STATIC_SCAFFOLDS_SOURCE = 'configTopologyStaticScaffolds'
DEFAULT_RUNTIME_INTEGRATION_BOUNDARY_SOURCE = 'runtimeIntegrationBoundary'
DEFAULT_PRODUCT_FACT_LAYER_SOURCE = 'productFactLayer'
DEFAULT_TECHNICAL_ROLE_SURFACES_SOURCE = 'technicalRoleSurfaces'
DEFAULT_DOM_PHASE_SURFACES_SOURCE = 'domPhaseSurfaces'
DEFAULT_SEMANTIC_NAVIGATION_HUBS_SOURCE = 'semanticNavigationHubs'
DEFAULT_ARCHITECTURAL_SURFACE_GRAPH_SOURCE = 'architecturalSurfaceGraph'
DEFAULT_EXPORTED_TYPE_SOURCE = 'static/exportedTypeTopology'
DEFAULT_BUSINESS_OBJECT_LIFECYCLE_SOURCE = 'static/businessObjectLifecycle'
DEFAULT_REPO_FILESYSTEM_QUERY_ID = 'telegraph/graph/repo-filesystem'
DEFAULT_CALL_QUERY_ID = 'telegraph/graph/static-calls'
DEFAULT_DECISION_QUERY_ID = 'telegraph/graph/static-decision-import'
DEFAULT_PREDICATE_QUERY_ID = 'telegraph/graph/static-predicate-import'
DEFAULT_BRANCH_QUERY_ID = 'telegraph/graph/static-branch-import'
DEFAULT_STORE_ACCESS_QUERY_ID = 'telegraph/graph/static-store-access-import'
DEFAULT_CONTROL_FLOW_QUERY_ID = 'telegraph/graph/static-control-flow-import'
DEFAULT_FILE_IMPORT_QUERY_ID = 'telegraph/graph/static-file-import-graph'
DEFAULT_FILE_PACKAGE_IMPORT_QUERY_ID = 'telegraph/graph/static-file-package-import-graph'
DEFAULT_FILE_DEPENDENCY_ARCHITECTURE_QUERY_ID = 'telegraph/graph/file-dependency-architecture'
DEFAULT_FOLDER_DEPENDENCY_FLAVORS_QUERY_ID = 'telegraph/graph/folder-dependency-flavors'
DEFAULT_FOLDER_DEPENDENCY_HOTSPOTS_QUERY_ID = 'telegraph/graph/folder-dependency-hotspots'
DEFAULT_FOLDER_DOMAIN_NORMALIZATION_QUERY_ID = 'telegraph/graph/folder-domain-normalization'
DEFAULT_REPRESENTATION_NORMALIZATION_QUERY_ID = 'telegraph/graph/representation-normalization'
DEFAULT_REPRESENTATION_NORMALIZATION_SUBSTRATE_QUERY_ID = 'telegraph/graph/representation-normalization-substrate'
DEFAULT_NOTIFICATION_SURFACE_SUPPORT_QUERY_ID = 'telegraph/graph/notification-surface-support'
DEFAULT_NOTIFICATION_SURFACE_DOMAIN_PROJECTION_QUERY_ID = 'telegraph/graph/notification-surface-domain-projection'
DEFAULT_UI_VIEW_STRUCTURE_QUERY_ID = 'telegraph/graph/ui-view-structure'
DEFAULT_UI_VIEW_STRUCTURE_DOMAIN_PROJECTION_QUERY_ID = 'telegraph/graph/ui-view-structure-domain-projection'
DEFAULT_UI_INTERACTION_SURFACES_QUERY_ID = 'telegraph/graph/ui-interaction-surfaces'
DEFAULT_UI_INTENT_ENTRY_QUERY_ID = 'telegraph/graph/ui-intent-entry'
DEFAULT_GUARDED_OPERATION_QUERY_ID = 'telegraph/graph/guarded-operation'
DEFAULT_BOUNDARY_CROSSING_QUERY_ID = 'telegraph/graph/boundary-crossing'
DEFAULT_OBSERVABLE_SIDE_EFFECT_QUERY_ID = 'telegraph/graph/observable-side-effect'
DEFAULT_SEMANTIC_HANDOFF_BLOCKED_REASONS_QUERY_ID = 'telegraph/graph/semantic-handoff-blocked-reasons'
DEFAULT_TERMINAL_BOUNDARIES_QUERY_ID = 'telegraph/graph/terminal-boundaries'
DEFAULT_ASYNC_TOPOLOGY_QUERY_ID = 'telegraph/graph/async-topology'
DEFAULT_RUNTIME_BOOTSTRAP_QUERY_ID = 'telegraph/graph/runtime-bootstrap'
DEFAULT_CONFIG_LAYER_ORCHESTRATION_QUERY_ID = 'telegraph/graph/config-layer-orchestration'
DEFAULT_CANONICAL_CONFIG_KEY_GRAPH_QUERY_ID = 'telegraph/graph/canonical-config-key-graph'
DEFAULT_CANONICAL_ENDPOINT_GRAPH_QUERY_ID = 'telegraph/graph/canonical-endpoint-graph'
DEFAULT_RUNTIME_MODE_SCENARIO_BOOTSTRAP_QUERY_ID = 'telegraph/graph/runtime-mode-scenario-bootstrap'
DEFAULT_OPERATIONAL_PROOF_ROUTE_QUERY_ID = 'telegraph/graph/operational-proof-route'
DEFAULT_EXTERNAL_EVENT_LISTENER_QUERY_ID = 'telegraph/graph/external-event-listeners'
DEFAULT_LIFECYCLE_VISIBILITY_BOUNDARY_SIGNAL_QUERY_ID = 'telegraph/graph/lifecycle-visibility-boundary-signals'
DEFAULT_PATTERN_CATALOG_QUERY_ID = 'telegraph/graph/pattern-catalog'
DEFAULT_CONTROL_FLOW_GUARD_QUERY_ID = 'telegraph/graph/control-flow-guards'
DEFAULT_EXCEPTION_HANDLING_WRAPPER_QUERY_ID = 'telegraph/graph/exception-handling-wrappers'
DEFAULT_VALUE_RESOLUTION_QUERY_ID = 'telegraph/graph/value-resolution'
DEFAULT_SET_MEMBERSHIP_QUERY_ID = 'telegraph/graph/set-membership'
DEFAULT_COLLECTION_TOPOLOGY_QUERY_ID = 'telegraph/graph/collection-topology'
DEFAULT_TYPE_NARROWING_QUERY_ID = 'telegraph/graph/type-narrowing'
DEFAULT_MERGE_PRECEDENCE_QUERY_ID = 'telegraph/graph/merge-precedence'
DEFAULT_PREDICATE_COMPOSITION_QUERY_ID = 'telegraph/graph/predicate-composition'
DEFAULT_ENVIRONMENT_GATING_QUERY_ID = 'telegraph/graph/environment-gating'
DEFAULT_ASYNC_STALE_RESULT_SUPPRESSION_QUERY_ID = 'telegraph/graph/async-stale-result-suppression'
DEFAULT_LIFECYCLE_OWNERSHIP_QUERY_ID = 'telegraph/graph/lifecycle-ownership'
DEFAULT_RETRY_TRANSPORT_FALLBACK_QUERY_ID = 'telegraph/graph/retry-transport-fallback'
DEFAULT_EXPLAINABILITY_SLICE_CATALOG_QUERY_ID = 'telegraph/graph/explainability-slice-catalog'
DEFAULT_STORE_NODES_OPERATIONS_QUERY_ID = 'telegraph/graph/store-nodes-operations'
DEFAULT_ITERATION_RECURSION_EXECUTION_SHAPE_QUERY_ID = 'telegraph/graph/iteration-recursion-execution-shape'
DEFAULT_CANONICAL_FEATURE_FLAG_GRAPH_QUERY_ID = 'telegraph/graph/canonical-feature-flag-graph'
DEFAULT_SYNTHETIC_DOUBLES_PLACEHOLDERS_STUBS_QUERY_ID = 'telegraph/graph/synthetic-doubles-placeholders-stubs'
DEFAULT_CONFIG_TOPOLOGY_STATIC_SCAFFOLDS_QUERY_ID = 'telegraph/graph/config-topology-static-scaffolds'
DEFAULT_RUNTIME_INTEGRATION_BOUNDARY_QUERY_ID = 'telegraph/graph/runtime-integration-boundary'
DEFAULT_PRODUCT_FACT_LAYER_QUERY_ID = 'telegraph/graph/product-fact-layer'
DEFAULT_TECHNICAL_ROLE_SURFACES_QUERY_ID = 'telegraph/graph/technical-role-surfaces'
DEFAULT_DOM_PHASE_SURFACES_QUERY_ID = 'telegraph/graph/dom-phase-surfaces'
DEFAULT_SEMANTIC_NAVIGATION_HUBS_QUERY_ID = 'telegraph/graph/semantic-navigation-hubs'
DEFAULT_ARCHITECTURAL_SURFACE_GRAPH_QUERY_ID = 'telegraph/graph/architectural-surface-graph'
DEFAULT_BUSINESS_OBJECT_LIFECYCLE_QUERY_ID = 'telegraph/graph/business-object-lifecycle'


def load_settings() -> dict[str, str]:
    load_dotenv(ENV_PATH)

    uri = os.getenv('NEO4J_URI')
    username = os.getenv('NEO4J_USER') or os.getenv('NEO4J_USERNAME')
    password = os.getenv('NEO4J_PASSWORD')
    database = os.getenv('NEO4J_DATABASE') or os.getenv('NEO4J_DB') or 'neo4j'

    missing = [
        name
        for name, value in {
            'NEO4J_URI': uri,
            'NEO4J_USER/NEO4J_USERNAME': username,
            'NEO4J_PASSWORD': password,
        }.items()
        if not value
    ]
    if missing:
        raise RuntimeError(f"Missing required Neo4j settings: {', '.join(missing)}")

    # Local single-node instances often expose Bolt on 7687 while routing listens elsewhere.
    # Use bolt:// for localhost to avoid requiring routing discovery from neo4j://.
    if uri and uri.startswith('neo4j://'):
        normalized_local_uri = uri.replace('neo4j://localhost', 'bolt://localhost', 1)
        normalized_local_uri = normalized_local_uri.replace('neo4j://127.0.0.1', 'bolt://127.0.0.1', 1)
        uri = normalized_local_uri

    return {
        'uri': uri,
        'username': username,
        'password': password,
        'database': database,
    }


def run_command(args: list[str], cwd: Path | None = None) -> None:
    subprocess.run(args, cwd=str(cwd) if cwd else None, check=True)


def run_command_capture(args: list[str], cwd: Path | None = None) -> str:
    completed = subprocess.run(
        args,
        cwd=str(cwd) if cwd else None,
        check=True,
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
    )
    return completed.stdout


def get_head_commit_short(workspace_dir: Path) -> str:
    return run_command_capture(
        ['git', '-C', str(workspace_dir), 'rev-parse', '--short', 'HEAD'],
    ).strip()


def log_progress(message: str) -> None:
    print(message, flush=True)


def resolve_call_precisions(precision_filter: str) -> list[str]:
    if precision_filter == 'all':
        return ['direct', 'imprecise']

    return [precision_filter]


def resolve_call_source(precision_filter: str) -> str:
    if precision_filter == 'all':
        return DEFAULT_CALL_SOURCE

    return f'{DEFAULT_CALL_SOURCE}/{precision_filter}'