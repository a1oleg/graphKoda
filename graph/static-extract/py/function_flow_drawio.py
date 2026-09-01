from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Any
from xml.etree.ElementTree import Element
from xml.etree.ElementTree import SubElement
from xml.etree.ElementTree import tostring
from urllib.parse import urlencode

from neo4j import GraphDatabase

from common import load_settings
from common import WORKSPACE_DIR


SOURCE = 'semantic/functionFlowGraph'
EDGE_TYPES = ['NEXT', 'TRUE', 'FALSE', 'ITERATES', 'REPEATS', 'EXITS', 'OPTION_CASE', 'OPTION_DEFAULT', 'MERGES_TO']
CALL_EDGE_TYPES = ['CALL', 'SUBSCRIBE']
SEMANTIC_EDGE_TYPES = ['CALLBACK', 'EXPECT_UPDATE', 'APPLY_UPDATE', 'PRODUCE', 'RETURN', 'SEMANTIC']
RESOURCE_EDGE_TYPES = ['READ', 'TEST', 'CREATE', 'UPDATE', 'DELETE', 'CLEAR', 'EMIT', 'WAIT', 'SUBSCRIBE', 'SIGNAL', 'START', 'CANCEL', 'DERIVE', 'FEED', 'PART']
FLOW_X_GAP = 240
FLOW_Y_GAP = 112
FLOW_ORIGIN_X = 340
FLOW_ORIGIN_Y = 80
FN_ROOT_Y = 100
FN_TARGET_X_GAP = 130
UI_TARGET_X = 30
RESOURCE_X_GAP = 170
UI_RESOURCE_KINDS = {'ui-state', 'input-state', 'ui-effect'}
BRANCH_SIDE_LANE_OFFSET = 60
FLOW_NODE_LABELS = ('Step', 'Branch', 'Join', 'Loop', 'Switch', 'Case', 'FunctionEnd', 'BreakStop', 'ThrowStop')
FLOW_NODE_PREDICATE = ' OR '.join(f'flow:{label}' for label in FLOW_NODE_LABELS)
TARGET_FLOW_NODE_PREDICATE = ' OR '.join(f'target:{label}' for label in FLOW_NODE_LABELS)


def normalize_resource_kind(resource_or_kind: dict[str, Any] | str | None) -> str:
    if isinstance(resource_or_kind, dict):
        value = resource_or_kind.get('resource_kind') or resource_or_kind.get('resourceKind') or ''
    else:
        value = resource_or_kind or ''
    return str(value).strip().lower()


def is_ui_resource(resource_or_kind: dict[str, Any] | str | None) -> bool:
    return normalize_resource_kind(resource_or_kind) in UI_RESOURCE_KINDS


def parse_stableId(stableId: str) -> dict[str, Any]:
    parts = str(stableId or '').split(':')
    if len(parts) < 5:
        return {'file_path': stableId}
    try:
        return {
            'file_path': ':'.join(parts[:-4]),
            'start_line': int(parts[-4]),
            'start_column': int(parts[-3]),
            'end_line': int(parts[-2]),
            'end_column': int(parts[-1]),
        }
    except ValueError:
        return {'file_path': ':'.join(parts[:-4])}


def stableId_start_line(stableId: str) -> int | None:
    parsed = parse_stableId(stableId)
    return parsed.get('start_line')


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Export one function-flow subgraph from Neo4j into a draw.io file.')
    parser.add_argument('--fn-stable-id', dest='fn_stableId', required=True, help='Root Fn stableId to export.')
    parser.add_argument('--input', help='Existing .drawio file to redraw in place.')
    parser.add_argument('--output', help='Output .drawio path. Defaults to graph/<generated-name>.drawio')
    parser.add_argument('--source', default=SOURCE, help='Function-flow source to export.')
    parser.add_argument('--range-start', type=int, help='Only render Step nodes whose start line is >= this line.')
    parser.add_argument('--range-end', type=int, help='Only render Step nodes whose start line is <= this line.')
    parser.add_argument('--stage-label', help='Stage label to show as the diagram head instead of the owner function.')
    return parser.parse_args(argv)


def resolve_output_path(args: argparse.Namespace) -> Path:
    if args.input:
        input_path = Path(args.input).resolve()
        if not input_path.exists():
            raise FileNotFoundError(f'Input draw.io file not found: {input_path}')
        return input_path

    if args.output:
        return Path(args.output).resolve()

    return make_default_output_path(args.fn_stableId)


def sanitize_file_name(text: str) -> str:
    sanitized = re.sub(r'[^A-Za-z0-9._-]+', '-', text).strip('-')
    return sanitized or 'function-flow'


def make_default_output_path(fn_stableId: str) -> Path:
    path_part = fn_stableId.split(':', 1)[0]
    file_name = Path(path_part).stem
    suffix = sanitize_file_name(fn_stableId.removeprefix(f'{path_part}:'))
    return WORKSPACE_DIR / 'graph' / f'{file_name}-{suffix}.drawio'


def query_graph(session: Any, fn_stableId: str, source: str, range_start: int | None = None, range_end: int | None = None) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], dict[str, dict[str, Any]]]:
    control_edge_types = ['NEXT', 'TRUE', 'FALSE', 'OPTION_CASE', 'OPTION_DEFAULT', 'MERGES_TO']
    function_edge_types = [*control_edge_types, 'CALL', 'SUBSCRIBE', 'CALLBACK', 'EXPECT_UPDATE', 'APPLY_UPDATE', 'PRODUCE', 'RETURN', 'SEMANTIC']
    resource_edge_types = ['READ', 'TEST', 'CREATE', 'UPDATE', 'DELETE', 'CLEAR', 'EMIT', 'WAIT', 'SUBSCRIBE', 'SIGNAL', 'START', 'CANCEL', 'DERIVE']
    resource_link_edge_types = ['FEED']

    flow_query = '''
        MATCH (root:Fn {{stableId: $fn_stableId}})
        OPTIONAL MATCH (flow {{source: $source, parentFnStableId: $fn_stableId}})
        WHERE __FLOW_NODE_PREDICATE__
        WITH root, collect(DISTINCT flow) AS raw_flow_nodes
        WITH root, [node IN raw_flow_nodes WHERE node IS NOT NULL] AS flow_nodes
        RETURN
                    root {
                      .stableId,
                      .name,
                      graph_annotation_text: properties(root)['graph_annotation_text'],
                      graph_annotation_updated_at: properties(root)['graph_annotation_updated_at']
                    } AS root,
                    [node IN flow_nodes | node { .*, labels: labels(node) }] AS flow_nodes
        '''.replace('{{', '{').replace('}}', '}').replace('__FLOW_NODE_PREDICATE__', FLOW_NODE_PREDICATE)
    flow_result = session.run(
        flow_query,
        {'fn_stableId': fn_stableId, 'source': source},
    ).single()

    if not flow_result:
        raise RuntimeError(f'Root Fn was not found: {fn_stableId}')

    root = dict(flow_result['root'])
    flow_nodes = [dict(node) for node in flow_result['flow_nodes']]
    if range_start is not None or range_end is not None:
        filtered_flow_nodes = []
        for node in flow_nodes:
            line = stableId_start_line(node.get('stableId') or '')
            if line is None:
                continue
            if range_start is not None and line < range_start:
                continue
            if range_end is not None and line > range_end:
                continue
            filtered_flow_nodes.append(node)
        flow_nodes = filtered_flow_nodes
    flow_ids = [node['stableId'] for node in flow_nodes]

    resource_result = session.run(
        '''
        MATCH (resource {source: $source, parentFnStableId: $fn_stableId})
        WHERE resource.resource_kind IS NOT NULL
        RETURN resource {
          .stableId,
          .resource_kind,
          .resource_subkind,
          .resource_name,
          .resource_cell_name,
          .resource_cell_kind,
          graph_annotation_text: properties(resource)['graph_annotation_text'],
          graph_annotation_updated_at: properties(resource)['graph_annotation_updated_at'],
          labels: labels(resource)
        } AS resource
        ORDER BY resource.resource_kind, resource.resource_name, resource.stableId
        ''',
        {'fn_stableId': fn_stableId, 'source': source},
    )
    resource_nodes = [dict(record['resource']) for record in resource_result]

    edge_result = session.run(
        '''
        MATCH (root:Fn {stableId: $fn_stableId})-[rel:NEXT {source: $source}]->(target {source: $source})
        WHERE target.stableId IN $flow_ids
        RETURN DISTINCT
          startNode(rel).stableId AS from_id,
          CASE WHEN startNode(rel):Fn THEN 'Fn' ELSE 'Step' END AS from_kind,
          endNode(rel).stableId AS to_id,
          CASE WHEN endNode(rel):Fn THEN 'Fn' ELSE 'Step' END AS to_kind,
          type(rel) AS edge_type,
          'control' AS edge_role,
          rel.label AS label,
          rel.call_text_raw AS call_text_raw,
          properties(rel)['graph_annotation_text'] AS graph_annotation_text,
          properties(rel)['graph_annotation_updated_at'] AS graph_annotation_updated_at
        UNION
        MATCH (sourceNode {source: $source})-[rel {source: $source}]->(target)
        WHERE sourceNode.stableId IN $flow_ids
          AND type(rel) IN $function_edge_types
          AND (target.stableId IN $flow_ids OR target:Fn)
        RETURN DISTINCT
          startNode(rel).stableId AS from_id,
          CASE WHEN startNode(rel):Fn THEN 'Fn' ELSE 'Step' END AS from_kind,
          endNode(rel).stableId AS to_id,
          CASE WHEN endNode(rel):Fn THEN 'Fn' ELSE 'Step' END AS to_kind,
          type(rel) AS edge_type,
          CASE
            WHEN type(rel) = 'CALL' THEN 'call'
            WHEN type(rel) = 'SUBSCRIBE' AND target:Fn THEN 'subscribe'
            WHEN type(rel) IN ['CALLBACK','EXPECT_UPDATE','APPLY_UPDATE','PRODUCE','RETURN','SEMANTIC'] THEN 'semantic'
            ELSE 'control'
          END AS edge_role,
          rel.label AS label,
          rel.call_text_raw AS call_text_raw,
          properties(rel)['graph_annotation_text'] AS graph_annotation_text,
          properties(rel)['graph_annotation_updated_at'] AS graph_annotation_updated_at
                UNION
                MATCH (sourceNode {source: $source})-[rel {source: $source}]->(target {source: $source, parentFnStableId: $fn_stableId})
                WHERE sourceNode.stableId IN $flow_ids
                  AND target.resource_kind IS NOT NULL
                  AND type(rel) IN $resource_edge_types
                RETURN DISTINCT
                    startNode(rel).stableId AS from_id,
                    'Step' AS from_kind,
                    endNode(rel).stableId AS to_id,
                    'Resource' AS to_kind,
                    type(rel) AS edge_type,
                    'resource' AS edge_role,
                    coalesce(rel.access_type, type(rel)) AS label,
                    rel.callee_text AS call_text_raw,
                    properties(rel)['graph_annotation_text'] AS graph_annotation_text,
                    properties(rel)['graph_annotation_updated_at'] AS graph_annotation_updated_at
                UNION
                MATCH (sourceResource {source: $source, parentFnStableId: $fn_stableId})-[rel {source: $source}]->(targetResource {source: $source, parentFnStableId: $fn_stableId})
                WHERE sourceResource.resource_kind IS NOT NULL
                  AND targetResource.resource_kind IS NOT NULL
                  AND type(rel) IN $resource_link_edge_types
                RETURN DISTINCT
                    sourceResource.stableId AS from_id,
                    'Resource' AS from_kind,
                    targetResource.stableId AS to_id,
                    'Resource' AS to_kind,
                    type(rel) AS edge_type,
                    'resource' AS edge_role,
                    coalesce(rel.label, type(rel)) AS label,
                    rel.callee_text AS call_text_raw,
                    properties(rel)['graph_annotation_text'] AS graph_annotation_text,
                    properties(rel)['graph_annotation_updated_at'] AS graph_annotation_updated_at
        ''',
        {
            'fn_stableId': fn_stableId,
            'source': source,
            'flow_ids': flow_ids,
            'function_edge_types': function_edge_types,
            'resource_edge_types': resource_edge_types,
            'resource_link_edge_types': resource_link_edge_types,
        },
    )
    edges = [dict(record) for record in edge_result]
    if flow_ids and range_end is not None:
        boundary_result = session.run(
            '''
            MATCH (sourceNode {source: $source})-[rel {source: $source}]->(target {source: $source, parentFnStableId: $fn_stableId})
            WHERE sourceNode.stableId IN $flow_ids
              AND type(rel) IN $control_edge_types
              AND NOT target.stableId IN $flow_ids
              AND (target:Step OR target:Branch OR target:Join OR target:Switch OR target:Case OR target:FunctionEnd OR target:BreakStop OR target:ThrowStop)
            RETURN DISTINCT
              startNode(rel).stableId AS from_id,
              'Step' AS from_kind,
              target.stableId AS to_id,
              'Step' AS to_kind,
              type(rel) AS edge_type,
              'control' AS edge_role,
              rel.label AS label,
              rel.call_text_raw AS call_text_raw,
              properties(rel)['graph_annotation_text'] AS graph_annotation_text,
              properties(rel)['graph_annotation_updated_at'] AS graph_annotation_updated_at,
              target { .*, labels: labels(target), boundary: true } AS target_node
            ''',
            {
                'fn_stableId': fn_stableId,
                'source': source,
                'flow_ids': flow_ids,
                'control_edge_types': control_edge_types,
            },
        )
        known_flow_ids = set(flow_ids)
        for record in boundary_result:
            edges.append({
                'from_id': record['from_id'],
                'from_kind': record['from_kind'],
                'to_id': record['to_id'],
                'to_kind': record['to_kind'],
                'edge_type': record['edge_type'],
                'edge_role': record['edge_role'],
                'label': record['label'],
                'call_text_raw': record['call_text_raw'],
                'graph_annotation_text': record['graph_annotation_text'],
                'graph_annotation_updated_at': record['graph_annotation_updated_at'],
                'boundary': True,
            })
            target_node = dict(record['target_node'])
            if target_node.get('stableId') not in known_flow_ids:
                known_flow_ids.add(target_node['stableId'])
                flow_ids.append(target_node['stableId'])
                flow_nodes.append(target_node)

    control_incoming_ids = {
        edge['to_id']
        for edge in edges
        if edge.get('edge_role') == 'control' and edge.get('to_kind') == 'Step'
    }
    if flow_ids and not any(edge.get('from_kind') == 'Fn' and edge.get('to_kind') == 'Step' for edge in edges):
        for node in flow_nodes:
            if node.get('stableId') not in control_incoming_ids and not node.get('boundary'):
                edges.append({
                    'from_id': fn_stableId,
                    'from_kind': 'Fn',
                    'to_id': node['stableId'],
                    'to_kind': 'Step',
                    'edge_type': 'NEXT',
                    'edge_role': 'control',
                    'label': '',
                    'call_text_raw': '',
                    'synthetic': True,
                })
    edges = drop_aggregate_branch_resource_edges(flow_nodes, edges)
    rewire_step_resource_edges_through_called_fns(edges)

    used_resource_ids = {edge['to_id'] for edge in edges if edge.get('to_kind') == 'Resource'}
    used_resource_ids.update(edge['from_id'] for edge in edges if edge.get('from_kind') == 'Resource')
    if used_resource_ids:
        resource_nodes = [resource for resource in resource_nodes if resource.get('stableId') in used_resource_ids]
    else:
        resource_nodes = []

    target_fn_ids = sorted({edge['to_id'] for edge in edges if edge['to_kind'] == 'Fn' and edge['to_id'] != fn_stableId})
    target_fns: list[dict[str, Any]] = []
    if target_fn_ids:
        target_result = session.run(
            '''
            MATCH (fn:Fn)
            WHERE fn.stableId IN $target_ids
            RETURN fn {
              .stableId,
              .name,
              graph_annotation_text: properties(fn)['graph_annotation_text'],
              graph_annotation_updated_at: properties(fn)['graph_annotation_updated_at']
            } AS fn
            ORDER BY fn.stableId
            ''',
            {'target_ids': target_fn_ids},
        )
        target_fns = [dict(record['fn']) for record in target_result]
        footprint_result = session.run(
            '''
            MATCH (step:Step {source: $source})-[rel {source: $source}]->(resource {source: $source})
            WHERE step.parentFnStableId IN $target_ids
              AND resource.resource_kind IS NOT NULL
              AND type(rel) IN $resource_edge_types
            RETURN step.parentFnStableId AS target_id,
                   collect(DISTINCT resource.resource_kind) AS resource_kinds
            ''',
            {'target_ids': target_fn_ids, 'source': source, 'resource_edge_types': resource_edge_types},
        )
        resource_kinds_by_target = {
            record['target_id']: [item for item in (record['resource_kinds'] or []) if item]
            for record in footprint_result
        }
        for fn in target_fns:
            resource_kinds = resource_kinds_by_target.get(fn.get('stableId'), [])
            fn['resource_kinds'] = resource_kinds
            fn['ui_side'] = bool(resource_kinds) and all(is_ui_resource(kind) for kind in resource_kinds)

    annotations = collect_annotations(root, flow_nodes, resource_nodes, target_fns, edges)
    return root, flow_nodes, resource_nodes, edges, target_fns, annotations


def is_branch_like_step(node: dict[str, Any] | None) -> bool:
    labels = set((node or {}).get('labels') or [])
    return 'Branch' in labels or 'Switch' in labels


def drop_aggregate_branch_resource_edges(
    flow_nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    node_by_id = {node.get('stableId'): node for node in flow_nodes}
    control_source_ids = {
        edge.get('from_id')
        for edge in edges
        if edge.get('edge_role') == 'control' and edge.get('from_kind') == 'Step' and edge.get('to_kind') == 'Step'
    }
    return [
        edge for edge in edges
        if not (
            edge.get('edge_role') == 'resource'
            and edge.get('from_kind') == 'Step'
            and edge.get('to_kind') == 'Resource'
            and edge.get('from_id') in control_source_ids
            and is_branch_like_step(node_by_id.get(edge.get('from_id')))
        )
    ]


def rewire_step_resource_edges_through_called_fns(edges: list[dict[str, Any]]) -> None:
    call_target_by_step: dict[str, str] = {}
    for edge in edges:
        if (
            edge.get('from_kind') == 'Step'
            and edge.get('to_kind') == 'Fn'
            and edge.get('to_id')
            and edge.get('from_id') not in call_target_by_step
        ):
            call_target_by_step[edge['from_id']] = edge['to_id']

    for edge in edges:
        if edge.get('from_kind') != 'Step' or edge.get('to_kind') != 'Resource':
            continue
        call_target = call_target_by_step.get(edge.get('from_id'))
        if not call_target:
            continue
        source_step_id = edge['from_id']
        edge['from_id'] = call_target
        edge['from_kind'] = 'Fn'
        edge['visual_source_step_id'] = edge.get('visual_source_step_id') or source_step_id


def is_flow_control_point(node: dict[str, Any]) -> bool:
    labels = set(node.get('labels') or [])
    return bool(
        node.get('boundary')
        or labels.intersection({'Branch', 'Switch', 'Case', 'Merge', 'FunctionEnd', 'ThrowStop', 'BreakStop'})
    )


def get_node_display_text(node: dict[str, Any] | None) -> str:
    if not node:
        return ''
    return str(node.get('action_text_raw') or node.get('condition_raw') or node.get('label') or '').strip()


def build_corridor_steps(
    root: dict[str, Any],
    flow_nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, str]]:
    node_by_id = {node['stableId']: node for node in flow_nodes}
    anchor_ids = {
        node_id
        for node_id, node in node_by_id.items()
        if is_flow_control_point(node)
    }
    anchor_ids.add(root['stableId'])

    control_edges = [
        edge for edge in edges
        if edge.get('edge_role') == 'control'
        and edge.get('from_kind') in {'Fn', 'Step'}
        and edge.get('to_kind') == 'Step'
    ]
    outgoing_control: dict[str, list[dict[str, Any]]] = {}
    incoming_control: dict[str, list[dict[str, Any]]] = {}
    for edge in control_edges:
        outgoing_control.setdefault(edge['from_id'], []).append(edge)
        incoming_control.setdefault(edge['to_id'], []).append(edge)

    visited: set[str] = set()
    step_by_member_id: dict[str, str] = {}
    steps: list[dict[str, Any]] = []

    def make_step_id(members: list[str]) -> str:
        first = members[0]
        last = members[-1]
        return f'corridor-step::{first}::{last}'

    def collect_run(start_id: str) -> list[str]:
        run: list[str] = []
        current_id = start_id
        while current_id in node_by_id and current_id not in anchor_ids and current_id not in visited:
            run.append(current_id)
            visited.add(current_id)
            next_edges = [
                edge for edge in outgoing_control.get(current_id, [])
                if edge.get('to_kind') == 'Step'
            ]
            if len(next_edges) != 1:
                break
            next_id = next_edges[0]['to_id']
            if next_id in anchor_ids:
                break
            if len(incoming_control.get(next_id, [])) != 1:
                break
            current_id = next_id
        return run

    for edge in control_edges:
        source_id = edge['from_id']
        target_id = edge['to_id']
        if source_id not in anchor_ids or target_id in anchor_ids or target_id in visited:
            continue
        run = collect_run(target_id)
        if len(run) <= 1:
            continue
        step_id = make_step_id(run)
        for member_id in run:
            step_by_member_id[member_id] = step_id
        first_node = node_by_id.get(run[0])
        last_node = node_by_id.get(run[-1])
        step_outgoing_count = len([
            item for item in edges
            if item.get('from_id') in set(run)
            and not (item.get('to_id') in set(run) and item.get('edge_role') == 'control')
            and item.get('edge_role') != 'control'
        ])
        steps.append({
            'stableId': step_id,
            'labels': ['Step', 'Action', 'CorridorStep'],
            'label': 'linear step',
            'source': first_node.get('source') if first_node else root.get('source'),
            'parentFnStableId': root['stableId'],
            'start_line': first_node.get('start_line') if first_node else None,
            'start_column': first_node.get('start_column') if first_node else None,
            'end_line': last_node.get('end_line') if last_node else None,
            'end_column': last_node.get('end_column') if last_node else None,
            'step_member_count': len(run),
            'step_member_stableIds': run,
            'step_first_text': get_node_display_text(first_node),
            'step_last_text': get_node_display_text(last_node),
            'step_visual_outgoing_count': step_outgoing_count,
        })

    if not step_by_member_id:
        return flow_nodes, edges, {}

    projected_nodes = [
        node for node in flow_nodes
        if node['stableId'] not in step_by_member_id
    ]
    projected_nodes.extend(steps)

    dedup: set[tuple[str, str, str, str, str]] = set()
    projected_edges: list[dict[str, Any]] = []
    for edge in edges:
        from_id = step_by_member_id.get(edge.get('from_id'), edge.get('from_id'))
        to_id = step_by_member_id.get(edge.get('to_id'), edge.get('to_id'))
        if from_id == to_id and edge.get('edge_role') == 'control':
            continue
        next_edge = dict(edge)
        if from_id != edge.get('from_id'):
            next_edge['visual_source_step_id'] = edge.get('visual_source_step_id') or edge.get('from_id')
            next_edge['from_id'] = from_id
            next_edge['from_kind'] = 'Step'
        if to_id != edge.get('to_id'):
            next_edge['visual_target_step_id'] = edge.get('visual_target_step_id') or edge.get('to_id')
            next_edge['to_id'] = to_id
            next_edge['to_kind'] = 'Step'
        key = (
            str(next_edge.get('from_id')),
            str(next_edge.get('from_kind')),
            str(next_edge.get('to_id')),
            str(next_edge.get('to_kind')),
            str(next_edge.get('edge_type')),
        )
        if next_edge.get('edge_role') == 'control':
            if key in dedup:
                continue
            dedup.add(key)
        projected_edges.append(next_edge)

    return projected_nodes, projected_edges, step_by_member_id


def shorten(text: str | None, max_length: int = 60) -> str:
    if not text:
        return ''
    normalized = ' '.join(text.split())
    return normalized if len(normalized) <= max_length else f'{normalized[:max_length - 3]}...'


def get_short_stable_suffix(stableId: str) -> str:
    parts = stableId.split(':')
    return ':'.join(parts[-4:]) if len(parts) >= 5 else stableId


def build_root_label(root: dict[str, Any], stage_label: str | None = None) -> str:
    if stage_label:
        return f'Stage&#xa;{shorten(stage_label, 56)}'
    name = root.get('name') or Path(str(parse_stableId(root['stableId'])['file_path'])).stem
    return f'Fn&#xa;{name}()'


def build_flow_label(node: dict[str, Any]) -> str:
    if node.get('visual_label'):
        return str(node['visual_label'])
    labels = set(node.get('labels') or [])
    if 'CorridorStep' in labels:
        count = int(node.get('step_member_count') or len(node.get('step_member_stableIds') or []) or 0)
        first = shorten(node.get('step_first_text') or node.get('label'), 44)
        last = shorten(node.get('step_last_text') or '', 44)
        if first and last and first != last:
            return f'{count} steps&#xa;{first} ...&#xa;{last}'
        return f'{count} steps&#xa;{first or "linear step"}'
    if 'FunctionEnd' in labels:
        return 'End'
    if node.get('boundary'):
        stage_index = node.get('stage_index')
        if stage_index is not None:
            core = f'Stage {stage_index}'
        else:
            core = shorten(node.get('stage_label') or node.get('action_text_raw') or node.get('condition_raw') or node.get('label'), 56)
        return f'NEXT STAGE:&#xa;{core}'
    if 'Switch' in labels:
        core = shorten(node.get('condition_raw') or node.get('label'), 56)
        return f'Switch&#xa;{core}'
    if 'Case' in labels:
        core = shorten(node.get('condition_raw') or node.get('label'), 56)
        return f'Case&#xa;{core}'
    if 'Branch' in labels:
        core = shorten(node.get('condition_raw') or node.get('label'), 56)
        return f'{core}'
    if 'ThrowStop' in labels:
        core = shorten(node.get('action_text_raw') or node.get('label'), 56)
        return f'ThrowStop&#xa;{core}'
    if 'BreakStop' in labels:
        return 'BreakStop'
    if 'Merge' in labels:
        return 'merge'
    core = shorten(node.get('action_text_raw') or node.get('label'), 56)
    return f'{core}'


def get_branch_operator(node: dict[str, Any] | None) -> str | None:
    if not node or 'Branch' not in set(node.get('labels') or []):
        return None
    text = str(node.get('condition_raw') or node.get('label') or '')
    if '||' in text:
        return '||'
    if '&&' in text:
        return '&&'
    return None


def trim_branch_operator(text: str, operator: str) -> str:
    normalized = ' '.join(str(text or '').split())
    if normalized.endswith(operator):
        normalized = normalized[:-len(operator)].strip()
    return normalized


def split_branch_operands(text: str, operator: str) -> list[str]:
    normalized = trim_branch_operator(text, operator)
    return [part.strip() for part in normalized.split(operator) if part.strip()]


def first_branch_operand(text: str, operator: str) -> str:
    operands = split_branch_operands(text, operator)
    return operands[0] if operands else ''


def last_branch_operand(text: str, operator: str) -> str:
    operands = split_branch_operands(text, operator)
    return operands[-1] if operands else ''


def stable_range_tuple(stableId: str | None) -> tuple[str, int, int, int, int] | None:
    parsed = parse_stableId(stableId or '')
    try:
        return (
            str(parsed['file_path']),
            int(parsed['start_line']),
            int(parsed['start_column']),
            int(parsed['end_line']),
            int(parsed['end_column']),
        )
    except KeyError:
        return None


def stable_ranges_overlap_on_same_start_line(left_id: str | None, right_id: str | None) -> bool:
    left = stable_range_tuple(left_id)
    right = stable_range_tuple(right_id)
    if not left or not right:
        return False
    left_file, left_start_line, left_start_column, left_end_line, left_end_column = left
    right_file, right_start_line, right_start_column, right_end_line, right_end_column = right
    if left_file != right_file or left_start_line != right_start_line:
        return False
    left_start = (left_start_line, left_start_column)
    left_end = (left_end_line, left_end_column)
    right_start = (right_start_line, right_start_column)
    right_end = (right_end_line, right_end_column)
    return left_start <= right_end and right_start <= left_end


def apply_serial_branch_labels(flow_nodes: list[dict[str, Any]], edges: list[dict[str, Any]]) -> None:
    branch_by_id = {
        node.get('stableId'): node
        for node in flow_nodes
        if 'Branch' in set(node.get('labels') or [])
    }
    if not branch_by_id:
        return

    incoming_branch_ids_by_id: dict[str, set[str]] = {}
    outgoing_branch_ids_by_id: dict[str, set[str]] = {}
    for edge in edges:
        if edge.get('edge_role') != 'control':
            continue
        from_id = edge.get('from_id')
        to_id = edge.get('to_id')
        if from_id in branch_by_id and to_id in branch_by_id:
            outgoing_branch_ids_by_id.setdefault(from_id, set()).add(to_id)
            incoming_branch_ids_by_id.setdefault(to_id, set()).add(from_id)

    for node_id, node in branch_by_id.items():
        operator = get_branch_operator(node)
        if not operator:
            continue
        raw_text = str(node.get('condition_raw') or node.get('label') or '')
        same_operator_incoming = any(
            get_branch_operator(branch_by_id.get(source_id)) == operator
            and stable_ranges_overlap_on_same_start_line(source_id, node_id)
            for source_id in incoming_branch_ids_by_id.get(node_id, set())
        )
        same_operator_outgoing = any(
            get_branch_operator(branch_by_id.get(target_id)) == operator
            and stable_ranges_overlap_on_same_start_line(node_id, target_id)
            for target_id in outgoing_branch_ids_by_id.get(node_id, set())
        )
        text_has_open_right_side = ' '.join(raw_text.split()).endswith(operator)
        has_left_series = same_operator_incoming
        has_right_series = same_operator_outgoing or text_has_open_right_side

        if has_left_series and has_right_series:
            core = last_branch_operand(raw_text, operator)
            node['visual_label'] = shorten(f'... {operator} {core} {operator} ...' if core else f'... {operator} ...', 56)
        elif has_left_series:
            core = last_branch_operand(raw_text, operator)
            node['visual_label'] = shorten(f'... {operator} {core}' if core else f'... {operator}', 56)
        elif has_right_series:
            core = first_branch_operand(raw_text, operator)
            node['visual_label'] = shorten(f'{core} {operator} ...' if core else f'{operator} ...', 56)


def build_target_fn_label(fn: dict[str, Any]) -> str:
    name = fn.get('name') or Path(str(parse_stableId(fn['stableId'])['file_path'])).stem
    return f'Fn&#xa;{name}()'


def build_resource_label(resource: dict[str, Any]) -> str:
    resource_kind = normalize_resource_kind(resource) or 'resource'
    resource_name = shorten(resource.get('resource_cell_name') or resource.get('resource_name'), 56)
    title = 'Resource'
    if is_ui_resource(resource):
        title = 'UI'
    elif resource_kind == 'external-source':
        title = 'Source'
    elif resource_kind == 'external-sink':
        title = 'Sink'
    elif resource_kind == 'browser-storage':
        title = 'BrowserStorage'
    elif resource_kind == 'storage':
        title = 'Store'
    elif resource_kind == 'async-control':
        title = 'Async'
    elif resource_kind == 'async-event':
        title = 'Event'
    return f'{title}&#xa;{resource_name}'


def collect_annotations(
    root: dict[str, Any],
    flow_nodes: list[dict[str, Any]],
    resource_nodes: list[dict[str, Any]],
    target_fns: list[dict[str, Any]],
    edges: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    annotations: dict[str, dict[str, Any]] = {}
    for item in [root, *flow_nodes, *resource_nodes, *target_fns]:
        key = item.get('stableId') or item.get('stableId')
        text = item.get('graph_annotation_text')
        if key and text:
            annotations[key] = {
                'text': text,
                'updated_at': item.get('graph_annotation_updated_at'),
                'kind': 'node',
            }
    for edge in edges:
        text = edge.get('graph_annotation_text')
        if not text:
            continue
        key = edge_annotation_key(edge)
        annotations[key] = {
            'text': text,
            'updated_at': edge.get('graph_annotation_updated_at'),
            'kind': 'edge',
        }
    return annotations


def edge_annotation_key(edge: dict[str, Any]) -> str:
    if edge.get('to_kind') == 'Fn':
        return f'{edge.get("from_id")}->{edge.get("to_id")}'
    return f'{edge.get("from_id")}->{edge.get("to_id")}:{edge.get("edge_type")}'


def get_flow_style(node: dict[str, Any]) -> str:
    labels = set(node.get('labels') or [])
    if 'CorridorStep' in labels:
        return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;fontColor=#000000;align=center;verticalAlign=middle;'
    if 'FunctionEnd' in labels:
        return 'ellipse;shape=doubleEllipse;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;fontColor=#000000;fontStyle=1;'
    if node.get('boundary'):
        return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#9fbe99;strokeColor=#5f874f;fontStyle=1;fontColor=#000000;'
    if 'Switch' in labels:
        return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#cf9750;strokeColor=#8e5d22;fontColor=#000000;'
    if 'Case' in labels:
        return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#e0bb74;strokeColor=#9f7b2b;fontColor=#000000;'
    if 'Branch' in labels:
        return 'rhombus;whiteSpace=wrap;html=1;fillColor=#d9a066;strokeColor=#9a5d00;fontColor=#000000;'
    if 'ThrowStop' in labels:
        return 'shape=hexagon;whiteSpace=wrap;html=1;fillColor=#d98f8b;strokeColor=#8f3b37;fontColor=#000000;'
    if 'BreakStop' in labels:
        return 'shape=hexagon;whiteSpace=wrap;html=1;fillColor=#d98f8b;strokeColor=#8f3b37;fontColor=#000000;'
    if 'Merge' in labels:
        return 'ellipse;whiteSpace=wrap;html=1;fillColor=none;strokeColor=#6f4f86;fontColor=#000000;'
    if node.get('visual_side_call_kind') == 'ui':
        return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#b7d6e8;strokeColor=#4f86a4;fontColor=#000000;'
    if node.get('visual_side_call_kind') == 'resource':
        return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;fontColor=#000000;'
    return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#8fb3d9;strokeColor=#456c96;fontColor=#000000;'


def get_flow_graph_kind(node: dict[str, Any]) -> str:
    labels = set(node.get('labels') or [])
    for kind in ('Branch', 'Switch', 'Case', 'Join', 'FunctionEnd', 'ThrowStop', 'BreakStop'):
        if kind in labels:
            return kind
    return 'Step'


def flow_text_width(text: str | None, max_width: int, min_width: int = 120) -> int:
    normalized = re.sub(r'&#xa;|\s+', ' ', str(text or '')).strip()
    visible = min(len(normalized), 56) if normalized else 8
    return max(min_width, min(max_width, int(round(34 + visible * 6.2))))


def compact_box_height(height: int) -> int:
    return max(1, int(round(height * 2 / 3)))


def get_flow_size(node: dict[str, Any]) -> tuple[int, int]:
    labels = set(node.get('labels') or [])
    label = build_flow_label(node)
    if 'CorridorStep' in labels:
        outgoing_count = int(node.get('step_visual_outgoing_count') or 0)
        member_count = int(node.get('step_member_count') or len(node.get('step_member_stableIds') or []) or 0)
        raw_height = max(78, 58 + (max(outgoing_count, min(member_count, 5)) * 18))
        return flow_text_width(label, 260, 170), compact_box_height(raw_height)
    if 'Switch' in labels:
        return flow_text_width(label, 250), compact_box_height(80)
    if 'Case' in labels:
        return flow_text_width(label, 240), compact_box_height(80)
    if 'Branch' in labels:
        return flow_text_width(label, 240), 90
    if 'ThrowStop' in labels or 'BreakStop' in labels:
        return flow_text_width(label, 180), 70
    if 'Merge' in labels:
        return 126, 72
    if 'FunctionEnd' in labels:
        return 72, 72
    return flow_text_width(label, 220), compact_box_height(70)


def get_resource_style(resource: dict[str, Any]) -> str:
    resource_kind = normalize_resource_kind(resource)
    if is_ui_resource(resource):
        return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#b7d6e8;strokeColor=#4f86a4;fontColor=#000000;'
    if resource_kind == 'external-source':
        return 'shape=parallelogram;perimeter=parallelogramPerimeter;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontColor=#000000;'
    if resource_kind == 'external-sink':
        return 'shape=parallelogram;perimeter=parallelogramPerimeter;flipH=1;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;fontColor=#000000;'
    if resource_kind == 'browser-storage':
        return 'shape=mxgraph.basic.cylinder;whiteSpace=wrap;html=1;boundedLbl=1;fillColor=#fff2cc;strokeColor=#d6b656;fontColor=#000000;'
    if resource_kind == 'async-control':
        return 'shape=hexagon;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;fontColor=#000000;'
    if resource_kind == 'async-event':
        return 'ellipse;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#d79b00;fontColor=#000000;'
    return 'shape=mxgraph.basic.cylinder;whiteSpace=wrap;html=1;boundedLbl=1;fillColor=#fff2cc;strokeColor=#d6b656;fontColor=#000000;'


def get_resource_size(resource: dict[str, Any]) -> tuple[int, int]:
    resource_kind = normalize_resource_kind(resource)
    if is_ui_resource(resource):
        return 220, compact_box_height(70)
    if resource_kind in ('external-source', 'external-sink', 'async-event'):
        return 240, 80
    if resource_kind == 'async-control':
        return 220, 80
    return 250, 90


def get_edge_style(edge: dict[str, Any]) -> str:
    parts = ['edgeStyle=orthogonalEdgeStyle', 'rounded=0', 'orthogonalLoop=1', 'jettySize=auto', 'html=1', 'endArrow=block']
    if edge.get('edge_role') == 'resource':
        parts.append('dashed=1')
        parts.append('endArrow=open')
        color_by_edge_type = {
            'READ': '#7f8c8d',
            'TEST': '#c79a2e',
            'CREATE': '#82b366',
            'UPDATE': '#6c8ebf',
            'DELETE': '#b85450',
            'CLEAR': '#8f3b37',
            'EMIT': '#9673a6',
            'WAIT': '#4a86e8',
            'SUBSCRIBE': '#d79b00',
            'SIGNAL': '#82b366',
            'START': '#4a86e8',
            'CANCEL': '#b85450',
            'DERIVE': '#6c8ebf',
            'FEED': '#3d85c6',
        }
        stroke_color = color_by_edge_type.get(edge['edge_type'])
        if stroke_color:
            parts.append(f'strokeColor={stroke_color}')
        return ';'.join(parts) + ';'

    if edge['edge_type'] == 'TRUE':
        parts.append('strokeColor=#82b366')
        parts.append('fontColor=#2e7d32')
    elif edge['edge_type'] == 'FALSE':
        parts.append('strokeColor=#b85450')
        parts.append('fontColor=#b85450')
    if edge.get('edge_type') in {'CALL', 'SUBSCRIBE'}:
        parts.append('dashed=1')
    return ';'.join(parts) + ';'


def collapse_merge_nodes_for_render(
    flow_nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], set[str]]:
    """Hide Merge nodes, but keep their routing information on rewired edges."""
    merge_node_ids = {
        node['stableId']
        for node in flow_nodes
        if 'Merge' in set(node.get('labels') or [])
    }
    if not merge_node_ids:
        return flow_nodes, edges, set()

    next_edges_by_merge: dict[str, list[dict[str, Any]]] = {}
    incoming_edges_by_merge: dict[str, list[dict[str, Any]]] = {}
    for edge in edges:
        edge_type = edge.get('edge_type') or edge.get('label')
        if edge.get('from_id') in merge_node_ids and edge_type == 'NEXT' and edge.get('to_id') not in merge_node_ids:
            next_edges_by_merge.setdefault(edge['from_id'], []).append(edge)
        if edge.get('to_id') in merge_node_ids and edge.get('from_id') not in merge_node_ids:
            incoming_edges_by_merge.setdefault(edge['to_id'], []).append(edge)

    rewired_merge_ids = {
        merge_id
        for merge_id in merge_node_ids
        if next_edges_by_merge.get(merge_id) and incoming_edges_by_merge.get(merge_id)
    }

    collapsed_edges: list[dict[str, Any]] = []
    seen_edge_keys: set[tuple[str, str, str, str]] = set()
    for edge in edges:
        if edge.get('from_id') in merge_node_ids or edge.get('to_id') in merge_node_ids:
            continue
        collapsed_edges.append(edge)
        seen_edge_keys.add((
            str(edge.get('from_id') or ''),
            str(edge.get('to_id') or ''),
            str(edge.get('edge_type') or edge.get('label') or ''),
            str(edge.get('edge_role') or ''),
        ))

    for merge_id in sorted(rewired_merge_ids):
        next_edge = sorted(
            next_edges_by_merge.get(merge_id) or [],
            key=lambda item: (str(item.get('to_id') or ''), str(item.get('edge_type') or '')),
        )[0]
        target_id = next_edge.get('to_id')
        target_kind = next_edge.get('to_kind') or 'Step'
        for incoming_edge in sorted(
            incoming_edges_by_merge.get(merge_id) or [],
            key=lambda item: (
                str(item.get('from_id') or ''),
                str(item.get('edge_type') or item.get('label') or ''),
                str(item.get('to_id') or ''),
            ),
        ):
            edge_type = incoming_edge.get('edge_type') or incoming_edge.get('label') or 'NEXT'
            edge_key = (
                str(incoming_edge.get('from_id') or ''),
                str(target_id or ''),
                str(edge_type),
                str(incoming_edge.get('edge_role') or 'control'),
            )
            if edge_key in seen_edge_keys:
                continue
            rewired_edge = dict(incoming_edge)
            rewired_edge['to_id'] = target_id
            rewired_edge['to_kind'] = target_kind
            rewired_edge['via_merge_id'] = merge_id
            rewired_edge['merge_next_target_id'] = target_id
            rewired_edge['merge_next_edge_type'] = next_edge.get('edge_type') or next_edge.get('label') or 'NEXT'
            rewired_edge['synthetic'] = True
            rewired_edge['collapsed_merge'] = True
            collapsed_edges.append(rewired_edge)
            seen_edge_keys.add(edge_key)

    visible_flow_nodes = [
        node
        for node in flow_nodes
        if node.get('stableId') not in merge_node_ids
    ]
    return visible_flow_nodes, collapsed_edges, merge_node_ids


def build_flow_layout(
    root_stableId: str,
    flow_nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    side_call_step_kinds: dict[str, str] | None = None,
    layout_events: dict[str, list[str]] | None = None,
) -> dict[str, tuple[int, int]]:
    side_call_step_kinds = side_call_step_kinds or {}
    main_flow_node_ids = {root_stableId, *(node['stableId'] for node in flow_nodes)}
    merge_node_ids = {
        node['stableId']
        for node in flow_nodes
        if 'Merge' in set(node.get('labels') or [])
    }
    child_ids_by_source: dict[str, list[dict[str, str]]] = {}
    for edge in edges:
        if edge.get('edge_role') != 'control':
            continue
        if edge['to_kind'] != 'Step':
            continue

        children = child_ids_by_source.setdefault(edge['from_id'], [])
        if not any(child['id'] == edge['to_id'] for child in children):
            children.append({'id': edge['to_id'], 'rel_type': edge.get('edge_type') or edge.get('label') or ''})

    child_scores = build_flow_child_scores(root_stableId, child_ids_by_source)
    for source_id, children in list(child_ids_by_source.items()):
        child_ids_by_source[source_id] = order_flow_children_for_left_tree(children, side_call_step_kinds, child_scores)

    positions: dict[str, tuple[int, int]] = {root_stableId: (0, 0)}
    occupied_columns_by_row: dict[int, dict[int, str]] = {0: {0: root_stableId}}

    def record_layout_event(node_id: str, message: str) -> None:
        if layout_events is None:
            return
        layout_events.setdefault(node_id, []).append(message)

    def position_text(position: tuple[int, int] | None) -> str:
        if position is None:
            return '<unset>'
        column, row = position
        return f'column={column}, row={row}'

    def record_layout_diffs(
        pass_name: str,
        before: dict[str, tuple[int, int]],
        reason: str,
    ) -> bool:
        changed = False
        for node_id, after_position in positions.items():
            before_position = before.get(node_id)
            if before_position == after_position:
                continue
            changed = True
            record_layout_event(
                node_id,
                f'{pass_name}: {position_text(before_position)} -> {position_text(after_position)}; {reason}',
            )
        return changed

    record_layout_event(root_stableId, 'seed: <unset> -> column=0, row=0; root function/stage')

    def reachable_distances(start_id: str) -> dict[str, int]:
        distances: dict[str, int] = {start_id: 0}
        queue: list[str] = [start_id]
        while queue:
            current_id = queue.pop(0)
            next_distance = distances[current_id] + 1
            for child in child_ids_by_source.get(current_id, []):
                child_id = child['id']
                if child_id == root_stableId or child_id in distances:
                    continue
                distances[child_id] = next_distance
                queue.append(child_id)
        return distances

    def branch_distance_scores(children: list[dict[str, str]]) -> dict[str, int]:
        branch_children = [
            child
            for child in children
            if child.get('rel_type') in {'TRUE', 'FALSE', 'OPTION_CASE', 'OPTION_DEFAULT'}
        ]
        if len(branch_children) < 2:
            return {child['id']: child_scores.get(child['id'], (0, 0))[1] for child in children}

        distances_by_child = {child['id']: reachable_distances(child['id']) for child in branch_children}
        common_ids: set[str] | None = None
        for distances in distances_by_child.values():
            ids = set(distances)
            common_ids = ids if common_ids is None else common_ids & ids

        if not common_ids:
            return {child['id']: child_scores.get(child['id'], (0, 0))[1] for child in children}

        merge_id = min(
            common_ids,
            key=lambda node_id: (
                max(distances.get(node_id, 1_000_000) for distances in distances_by_child.values()),
                sum(distances.get(node_id, 1_000_000) for distances in distances_by_child.values()),
                node_id,
            ),
        )
        return {
            child['id']: distances_by_child.get(child['id'], {}).get(merge_id, child_scores.get(child['id'], (0, 0))[1])
            for child in children
        }

    def occupy(node_id: str, column: int, row: int) -> tuple[int, int]:
        existing_position = positions.get(node_id)
        if existing_position is not None:
            existing_column, existing_row = existing_position
            if existing_row <= row:
                return existing_position
            row_occupancy = occupied_columns_by_row.get(existing_row)
            if row_occupancy and row_occupancy.get(existing_column) == node_id:
                del row_occupancy[existing_column]

        target_row = occupied_columns_by_row.setdefault(row, {})
        while target_row.get(column) not in (None, node_id):
            column += 1
        positions[node_id] = (column, row)
        target_row[column] = node_id
        record_layout_event(
            node_id,
            f'initial control layout: {position_text(existing_position)} -> column={column}, row={row}; parent row + 1, sibling/free-column placement',
        )
        return column, row

    expanded_node_ids: set[str] = set()

    def layout_from(source_id: str, path: set[str]) -> None:
        if source_id in path or source_id in expanded_node_ids:
            return
        source_position = positions.get(source_id)
        if not source_position:
            return
        source_column, source_row = source_position
        children = child_ids_by_source.get(source_id, [])
        if not children:
            expanded_node_ids.add(source_id)
            return
        expanded_node_ids.add(source_id)

        branch_children = [
            child
            for child in children
            if child.get('rel_type') in {'TRUE', 'FALSE', 'OPTION_CASE', 'OPTION_DEFAULT'}
        ]
        next_path = {*path, source_id}
        if len(branch_children) >= 2:
            distance_scores = branch_distance_scores(branch_children)
            ordered_children = sorted(
                branch_children,
                key=lambda child: (
                    distance_scores.get(child['id'], 0),
                    relation_trunk_rank(child.get('rel_type')),
                    child['id'],
                ),
            )
            for index, child in enumerate(ordered_children):
                child_column = source_column if index == 0 else source_column + index
                child_row = source_row + 1 if index == 0 else source_row
                occupy(child['id'], child_column, child_row)
                layout_from(child['id'], next_path)

            non_branch_children = [
                child
                for child in children
                if child.get('rel_type') not in {'TRUE', 'FALSE', 'OPTION_CASE', 'OPTION_DEFAULT'}
            ]
            for index, child in enumerate(non_branch_children, start=len(ordered_children)):
                child_column = source_column if child.get('rel_type') == 'NEXT' else source_column + index
                occupy(child['id'], child_column, source_row + 1)
                layout_from(child['id'], next_path)
            return

        for index, child in enumerate(children):
            child_column = source_column if child.get('rel_type') == 'NEXT' else source_column + index
            child_row = source_row + 1
            occupy(child['id'], child_column, child_row)
            layout_from(child['id'], next_path)

    layout_from(root_stableId, set())

    for index, node in enumerate(sorted(flow_nodes, key=lambda item: item['stableId'])):
        if node['stableId'] not in positions:
            positions[node['stableId']] = (0, index + 1)
            record_layout_event(
                node['stableId'],
                f'fallback placement: <unset> -> column=0, row={index + 1}; node was not reached from root control traversal',
            )

    before = dict(positions)
    move_boundary_rows_below_flow(positions, flow_nodes)
    record_layout_diffs(
        'move_boundary_rows_below_flow',
        before,
        'boundary/next-stage nodes are moved below non-boundary flow rows',
    )

    before = dict(positions)
    merge_changed = move_merge_rows_closer_to_next(positions, flow_nodes, edges)
    record_layout_diffs(
        'move_merge_rows_closer_to_next',
        before,
        'merge nodes are moved nearer to their following NEXT target',
    )

    before = dict(positions)
    next_changed = align_next_targets_below_sources(positions, edges, root_stableId)
    record_layout_diffs(
        'align_next_targets_below_sources',
        before,
        'NEXT targets are placed directly below their source column',
    )
    if next_changed:
        before = dict(positions)
        resolve_flow_position_collisions(positions, root_stableId)
        record_layout_diffs(
            'resolve_flow_position_collisions_after_next_alignment',
            before,
            'same-row column collisions are shifted right after NEXT alignment',
        )

    before = dict(positions)
    lower_incoming_changed = align_targets_with_lower_incoming_sources(positions, edges, root_stableId)
    record_layout_diffs(
        'align_targets_with_lower_incoming_sources',
        before,
        'targets are pushed down when a forward incoming control edge comes from a lower/equal source row',
    )
    if lower_incoming_changed:
        before = dict(positions)
        resolve_flow_position_collisions(positions, root_stableId)
        record_layout_diffs(
            'resolve_flow_position_collisions_after_lower_incoming',
            before,
            'same-row column collisions are shifted right',
        )
        before = dict(positions)
        next_changed_after_lower_incoming = align_next_targets_below_sources(positions, edges, root_stableId)
        record_layout_diffs(
            'align_next_targets_below_sources_after_lower_incoming',
            before,
            'NEXT targets are re-placed below sources after branch incoming rows changed',
        )
        if next_changed_after_lower_incoming:
            before = dict(positions)
            resolve_flow_position_collisions(positions, root_stableId)
            record_layout_diffs(
                'resolve_flow_position_collisions_after_next_realignment',
                before,
                'same-row column collisions are shifted right after NEXT realignment',
            )
            before = dict(positions)
            lower_incoming_changed_after_next = align_targets_with_lower_incoming_sources(positions, edges, root_stableId)
            record_layout_diffs(
                'align_targets_with_lower_incoming_sources_after_next_realignment',
                before,
                'branch targets are pushed down after their source was moved by NEXT realignment',
            )
            if lower_incoming_changed_after_next:
                before = dict(positions)
                resolve_flow_position_collisions(positions, root_stableId)
                record_layout_diffs(
                    'resolve_flow_position_collisions_after_second_lower_incoming',
                    before,
                    'same-row column collisions are shifted right after second lower-incoming alignment',
                )

    before = dict(positions)
    forward_order_changed = enforce_forward_control_order(positions, edges, root_stableId)
    record_layout_diffs(
        'enforce_forward_control_order',
        before,
        'forward control targets are placed below their sources',
    )
    if forward_order_changed:
        before = dict(positions)
        resolve_flow_position_collisions(positions, root_stableId)
        record_layout_diffs(
            'resolve_flow_position_collisions_after_forward_order',
            before,
            'same-row column collisions are shifted right after forward-order enforcement',
        )

    before = dict(positions)
    compact_flow_rows(positions)
    record_layout_diffs(
        'compact_flow_rows',
        before,
        'empty flow rows are removed while preserving vertical order',
    )

    before = dict(positions)
    right_pack_changed = pack_right_branch_targets_to_lane_columns(positions, edges, merge_node_ids)
    record_layout_diffs(
        'pack_right_branch_targets_to_lane_columns',
        before,
        'right-side branch targets are moved to lane columns that leave routing space',
    )
    if right_pack_changed:
        before = dict(positions)
        resolve_flow_position_collisions(positions, root_stableId)
        record_layout_diffs(
            'resolve_flow_position_collisions_after_right_branch_pack',
            before,
            'same-row column collisions are shifted right after right-branch packing',
        )

    before = dict(positions)
    reclaim_single_incoming_branch_targets(positions, edges, root_stableId, merge_node_ids)
    record_layout_diffs(
        'reclaim_single_incoming_branch_targets',
        before,
        'single-incoming branch targets are moved back to the nearest free column beside their source',
    )

    before = dict(positions)
    branch_merge_changed = align_branch_merge_targets_below_sources(positions, edges, merge_node_ids, root_stableId)
    record_layout_diffs(
        'align_branch_merge_targets_below_sources',
        before,
        'merge nodes reached directly from branch exits are kept below the source branch when the slot is free',
    )
    if branch_merge_changed:
        before = dict(positions)
        resolve_flow_position_collisions(positions, root_stableId)
        record_layout_diffs(
            'resolve_flow_position_collisions_after_branch_merge_alignment',
            before,
            'same-row column collisions are shifted right after branch-merge alignment',
        )

    before = dict(positions)
    final_next_changed = align_next_targets_below_sources(positions, edges, root_stableId)
    record_layout_diffs(
        'final_align_next_targets_below_sources',
        before,
        'final pass keeps NEXT targets directly below their source after branch packing/reclaim',
    )
    if final_next_changed:
        before = dict(positions)
        resolve_flow_position_collisions(positions, root_stableId)
        record_layout_diffs(
            'resolve_flow_position_collisions_after_final_next_alignment',
            before,
            'same-row column collisions are shifted right after final NEXT alignment',
        )

    before = dict(positions)
    collapsed_merge_parent_changed = align_collapsed_merge_targets_below_layout_parent(positions, edges, root_stableId)
    record_layout_diffs(
        'align_collapsed_merge_targets_below_layout_parent',
        before,
        'targets reached through hidden merge nodes are placed directly below their chosen layout-parent source when the slot is free',
    )
    if collapsed_merge_parent_changed:
        before = dict(positions)
        resolve_flow_position_collisions(positions, root_stableId)
        record_layout_diffs(
            'resolve_flow_position_collisions_after_collapsed_merge_parent_alignment',
            before,
            'same-row column collisions are shifted right after hidden-merge parent alignment',
        )

    before = dict(positions)
    final_control_order_changed = enforce_final_control_target_order(positions, edges, root_stableId)
    record_layout_diffs(
        'enforce_final_control_target_order',
        before,
        'final control pass prevents a target from staying above its selected incoming source',
    )
    if final_control_order_changed:
        before = dict(positions)
        resolve_flow_position_collisions(positions, root_stableId)
        record_layout_diffs(
            'resolve_flow_position_collisions_after_final_control_order',
            before,
            'same-row column collisions are shifted right after final control-order enforcement',
        )

    record_collapsed_merge_layout_events(positions, edges, layout_events)
    return positions


def add_vertex(
    parent: Element,
    cell_id: str,
    value: str,
    style: str,
    x: int,
    y: int,
    width: int,
    height: int,
    metadata: dict[str, Any] | None = None,
) -> None:
    attributes = {'id': cell_id, 'value': value, 'style': style, 'vertex': '1', 'parent': '1'}
    if metadata:
        for key, item in metadata.items():
            if item is not None:
                attributes[key] = str(item)
    cell = SubElement(parent, 'mxCell', **attributes)
    SubElement(cell, 'mxGeometry', attrib={
        'x': str(x),
        'y': str(y),
        'width': str(width),
        'height': str(height),
        'as': 'geometry',
    })


def add_edge(
    parent: Element,
    cell_id: str,
    value: str,
    style: str,
    source: str,
    target: str,
    points: list[tuple[int, int]] | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    attributes = {'id': cell_id, 'value': value, 'style': style, 'edge': '1', 'parent': '1', 'source': source, 'target': target}
    if metadata:
        for key, item in metadata.items():
            if item is not None:
                attributes[key] = str(item)
    cell = SubElement(parent, 'mxCell', **attributes)
    geometry = SubElement(cell, 'mxGeometry', attrib={'relative': '1', 'as': 'geometry'})
    if points:
        points_element = SubElement(geometry, 'Array', attrib={'as': 'points'})
        for x, y in points:
            SubElement(points_element, 'mxPoint', attrib={'x': str(x), 'y': str(y)})


def add_point_edge(
    parent: Element,
    cell_id: str,
    style: str,
    source_point: tuple[int, int],
    target_point: tuple[int, int],
    metadata: dict[str, Any] | None = None,
) -> None:
    attributes = {'id': cell_id, 'value': '', 'style': style, 'edge': '1', 'parent': '1'}
    if metadata:
        for key, item in metadata.items():
            if item is not None:
                attributes[key] = str(item)
    cell = SubElement(parent, 'mxCell', **attributes)
    geometry = SubElement(cell, 'mxGeometry', attrib={'relative': '1', 'as': 'geometry'})
    SubElement(geometry, 'mxPoint', attrib={'x': str(source_point[0]), 'y': str(source_point[1]), 'as': 'sourcePoint'})
    SubElement(geometry, 'mxPoint', attrib={'x': str(target_point[0]), 'y': str(target_point[1]), 'as': 'targetPoint'})


def build_graph_link(
    *,
    kind: str,
    stableId: str | None = None,
    targetStableId: str | None = None,
    label: str | None = None,
    edge_type: str | None = None,
) -> str:
    params = {
        'kind': kind,
        'stableId': stableId or '',
        'targetStableId': targetStableId or '',
        'label': re.sub(r'<[^>]+>', '', str(label or '').replace('&#xa;', ' ')).strip(),
        'edgeType': edge_type or '',
    }
    return f'codex-graph://item?{urlencode(params)}'


def format_bounds(bounds: tuple[int, int, int, int] | None) -> str:
    if not bounds:
        return '<missing>'
    x, y, width, height = bounds
    return f'x={x}, y={y}, width={width}, height={height}'


def format_layout_position(layout: tuple[int, int] | None) -> str:
    if not layout:
        return '<missing>'
    column, row = layout
    return f'column={column}, row={row}'


def format_layout_shift(layout: tuple[int, int] | None) -> str:
    if not layout:
        return 'not placed on the central flow grid'
    column, _row = layout
    if column < 0:
        return 'left of the central axis'
    if column > 0:
        return 'right of the central axis'
    return 'on the central axis'


def edge_brief(edge: dict[str, Any]) -> str:
    label = edge.get('edge_type') or edge.get('label') or edge.get('edge_role') or 'edge'
    return f'{label} {edge.get("from_kind")} -> {edge.get("to_kind")}'


def edge_layout_brief(edge: dict[str, Any], flow_layout: dict[str, tuple[int, int]]) -> str:
    edge_type = edge.get('edge_type') or edge.get('label') or edge.get('edge_role') or 'edge'
    source_id = edge.get('from_id') or ''
    source_layout = format_layout_position(flow_layout.get(source_id))
    source_suffix = get_short_stable_suffix(source_id) if source_id else '<missing>'
    return f'{edge_type} from {source_suffix} at {source_layout}'


def build_node_layout_trace(
    *,
    node_id: str,
    graph_kind: str,
    label: str,
    bounds_by_node_id: dict[str, tuple[int, int, int, int]],
    flow_layout: dict[str, tuple[int, int]],
    edges: list[dict[str, Any]],
    root_stableId: str,
    row_entries: dict[int, list[str]],
    layout_events: dict[str, list[str]] | None = None,
    node: dict[str, Any] | None = None,
    resource: dict[str, Any] | None = None,
    fn: dict[str, Any] | None = None,
) -> str:
    incoming_edges = [edge for edge in edges if edge.get('to_id') == node_id]
    outgoing_edges = [edge for edge in edges if edge.get('from_id') == node_id]
    layout = flow_layout.get(node_id)
    row_peers = row_entries.get(layout[1], []) if layout else []
    lines = [
        'Layout trace:',
        f'kind: {graph_kind}',
        f'label: {label}',
        f'final bounds: {format_bounds(bounds_by_node_id.get(node_id))}',
    ]

    if graph_kind in {'Fn', 'Stage', 'Step', 'Branch', 'Switch', 'Case', 'Merge', 'FunctionEnd', 'ThrowStop', 'BreakStop'}:
        lines.append(f'flow grid: {format_layout_position(layout)}')
        lines.append(f'grid placement: {format_layout_shift(layout)}')
        if row_peers:
            lines.append(f'row peer count: {len(row_peers)}')
        incoming_control_edges = [
            edge for edge in incoming_edges
            if edge.get('edge_role') == 'control' and edge.get('from_id') in flow_layout
        ]
        if incoming_control_edges:
            lines.append(f'control incoming count: {len(incoming_control_edges)}')
            if len(incoming_control_edges) > 1:
                layout_parent_edge = choose_layout_parent_edge_by_target(flow_layout, incoming_control_edges).get(node_id)
                if layout_parent_edge:
                    lines.append(f'layout parent: {edge_layout_brief(layout_parent_edge, flow_layout)}')
                ignored_edges = [edge for edge in incoming_control_edges if edge is not layout_parent_edge]
                if ignored_edges:
                    lines.append('other incoming controls:')
                    lines.extend(f'- {edge_layout_brief(edge, flow_layout)}' for edge in ignored_edges)
        events = (layout_events or {}).get(node_id) or []
        if events:
            lines.append('coordinate operations:')
            lines.extend(f'- {event}' for event in events)
        else:
            lines.append('coordinate operations: <none recorded>')

    if node_id == root_stableId:
        lines.append('placement rules:')
        lines.append('- root function/stage is seeded at flow column 0, row 0')
        lines.append('- bounds are produced from the grid row center and node size')
    elif node:
        labels = sorted(set(node.get('labels') or []))
        side = node.get('visual_side_call_kind') or ''
        lines.append(f'node labels: {", ".join(labels) if labels else "<none>"}')
        lines.append('placement rules:')
        lines.append('- control-layout BFS starts from the owner Fn and follows control edges')
        lines.append('- each child initially gets parent row + 1 and a sibling-based column')
        lines.append('- occupied columns on the same row are shifted right until free')
        if side:
            if len(row_peers) < 2:
                lines.append(f'- side-call ordering classified this step as {side}, but it stays on its row column because it is the only main-flow node on this row')
            else:
                lines.append(f'- side-call ordering classified this step as {side}; rows with multiple main-flow nodes are ordered toward UI/main/resource lanes')
        if node.get('boundary'):
            lines.append('- boundary/next-stage nodes are moved below the local stage body')
        if 'Merge' in labels:
            lines.append('- merge nodes may be moved closer to their following NEXT target')
        if 'Branch' in labels or 'Switch' in labels:
            lines.append('- branch/switch exit ports are chosen from target proximity, then target x may be aligned to the chosen port')
    elif resource:
        resource_kind = normalize_resource_kind(resource)
        side = 'left UI lane' if is_ui_resource(resource) else 'right resource lane'
        anchor_sources = [
            edge.get('from_id')
            for edge in incoming_edges
            if edge.get('from_kind') in {'Step', 'Fn'}
        ]
        lines.append(f'resource kind: {resource_kind or "<none>"}')
        lines.append(f'resource lane: {side}')
        lines.append('placement rules:')
        lines.append('- resource y is anchored to the center of the earliest incoming source node')
        lines.append('- resources in the same lane are vertically separated to avoid overlap')
        lines.append('- UI resources use the left lane; other resources use compacted right lanes')
        if anchor_sources:
            lines.append(f'anchor source count: {len(anchor_sources)}')
    elif fn:
        side = 'left UI lane' if is_ui_side_target_fn(fn) else 'right call lane'
        lines.append(f'target function lane: {side}')
        lines.append('placement rules:')
        lines.append('- target function y is anchored to the center of the earliest caller step')
        lines.append('- target functions on the same side are vertically separated to avoid overlap')
        lines.append('- functions touching only UI resources are moved to the left UI lane')

    return '\n'.join(lines)


def parse_style(style: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for part in style.split(';'):
        if not part:
            continue
        if '=' in part:
            key, value = part.split('=', 1)
            result[key] = value
        else:
            result[part] = ''
    return result


def serialize_style(style_parts: dict[str, str]) -> str:
    serialized: list[str] = []
    for key, value in style_parts.items():
        if value:
            serialized.append(f'{key}={value}')
        else:
            serialized.append(key)
    return ';'.join(serialized) + ';'


def get_node_center(bounds: tuple[int, int, int, int]) -> tuple[float, float]:
    x, y, width, height = bounds
    return x + (width / 2), y + (height / 2)


def get_edge_side(source_bounds: tuple[int, int, int, int], target_bounds: tuple[int, int, int, int], is_source: bool) -> str:
    source_center_x, source_center_y = get_node_center(source_bounds)
    target_center_x, target_center_y = get_node_center(target_bounds)
    dx = target_center_x - source_center_x
    dy = target_center_y - source_center_y

    if abs(dx) > abs(dy):
        if is_source:
            return 'right' if dx >= 0 else 'left'
        return 'left' if dx >= 0 else 'right'

    if is_source:
        return 'bottom' if dy >= 0 else 'top'
    return 'top' if dy >= 0 else 'bottom'


def get_anchor_coordinates(side: str, is_source: bool) -> tuple[float, float]:
    if side == 'top':
        return 0.5, 0.0
    if side == 'right':
        return 1.0, 0.5
    if side == 'bottom':
        return 0.5, 1.0
    return 0.0, 0.5


def get_center_anchor_coordinates(side: str) -> tuple[float, float]:
    if side == 'top':
        return 0.5, 0.0
    if side == 'right':
        return 1.0, 0.5
    if side == 'bottom':
        return 0.5, 1.0
    return 0.0, 0.5


def add_terminal_anchors_to_style(
    style: str,
    source_bounds: tuple[int, int, int, int],
    target_bounds: tuple[int, int, int, int],
) -> str:
    source_side = get_edge_side(source_bounds, target_bounds, is_source=True)
    target_side = get_edge_side(source_bounds, target_bounds, is_source=False)
    exit_x, exit_y = get_center_anchor_coordinates(source_side)
    entry_x, entry_y = get_center_anchor_coordinates(target_side)
    style_parts = parse_style(style)
    style_parts['exitX'] = str(exit_x)
    style_parts['exitY'] = str(exit_y)
    style_parts['exitDx'] = '0'
    style_parts['exitDy'] = '0'
    style_parts['exitPerimeter'] = '0'
    style_parts['entryX'] = str(entry_x)
    style_parts['entryY'] = str(entry_y)
    style_parts['entryDx'] = '0'
    style_parts['entryDy'] = '0'
    style_parts['entryPerimeter'] = '0'
    return serialize_style(style_parts)


def force_next_edge_anchors(style: str) -> str:
    style_parts = parse_style(style)
    style_parts['exitX'] = '0.5'
    style_parts['exitY'] = '1.0'
    style_parts['exitDx'] = '0'
    style_parts['exitDy'] = '0'
    style_parts['exitPerimeter'] = '0'
    style_parts['entryX'] = '0.5'
    style_parts['entryY'] = '0.0'
    style_parts['entryDx'] = '0'
    style_parts['entryDy'] = '0'
    style_parts['entryPerimeter'] = '0'
    return serialize_style(style_parts)


def get_distributed_anchor_coordinates(side: str, index: int, count: int, is_source: bool) -> tuple[float, float]:
    if count <= 1:
        return get_anchor_coordinates(side, is_source=is_source)

    if side in ('top', 'bottom'):
        x_positions = [0.2, 0.8] if count == 2 else [0.2, 0.5, 0.8]
        x = x_positions[min(index, len(x_positions) - 1)]
        y = 0.0 if side == 'top' else 1.0
        return x, y

    y_positions = [0.2, 0.8] if count == 2 else [0.2, 0.5, 0.8]
    x = 1.0 if side == 'right' else 0.0
    y = y_positions[min(index, len(y_positions) - 1)]
    return x, y


def get_branch_exit_coordinates(index: int, count: int, edge_type: str | None) -> tuple[float, float]:
    return get_distributed_anchor_coordinates('bottom', index, count, is_source=True)


def get_shape_side_anchor(side: str) -> tuple[float, float]:
    if side == 'left':
        return 0.0, 0.5
    if side == 'right':
        return 1.0, 0.5
    if side == 'bottom':
        return 0.5, 1.0
    return 0.5, 0.0


def get_target_side_for_source(
    source_bounds: tuple[int, int, int, int],
    target_bounds: tuple[int, int, int, int],
    *,
    allow_top: bool = False,
    prefer_horizontal: bool = False,
) -> str:
    source_center_x, source_center_y = get_node_center(source_bounds)
    target_center_x, target_center_y = get_node_center(target_bounds)
    dx = target_center_x - source_center_x
    dy = target_center_y - source_center_y

    if prefer_horizontal and abs(dx) > max(20, source_bounds[2] * 0.15):
        return 'right' if dx >= 0 else 'left'

    if abs(dx) >= abs(dy):
        return 'right' if dx >= 0 else 'left'
    if dy >= 0:
        return 'bottom'
    return 'top' if allow_top else ('right' if dx >= 0 else 'left')


def build_branch_exit_layout(
    source_id: str,
    outgoing_edges: list[dict[str, Any]],
    bounds_by_node_id: dict[str, tuple[int, int, int, int]],
) -> dict[int, tuple[float, float]]:
    source_bounds = bounds_by_node_id.get(source_id)
    if not source_bounds:
        return {}

    control_edges = [
        edge for edge in outgoing_edges
        if edge.get('edge_role') == 'control'
        and edge.get('from_kind') == 'Step'
        and edge.get('to_kind') == 'Step'
        and edge.get('edge_type') in {'TRUE', 'FALSE', 'OPTION_CASE', 'OPTION_DEFAULT'}
        and bounds_by_node_id.get(edge.get('to_id'))
    ]
    if len(control_edges) < 2:
        return {}

    side_candidates = ['left', 'right', 'bottom']
    layout: dict[int, tuple[float, float]] = {}
    side_counts: dict[str, int] = {side: 0 for side in side_candidates}
    source_center_x, source_center_y = get_node_center(source_bounds)
    left_return_edges: list[tuple[float, str, dict[str, Any]]] = []
    for edge in control_edges:
        target_bounds = bounds_by_node_id[edge['to_id']]
        target_center_x, target_center_y = get_node_center(target_bounds)
        if target_center_x < source_center_x:
            distance = abs(target_center_x - source_center_x) + abs(target_center_y - source_center_y)
            left_return_edges.append((distance, edge['to_id'], edge))

    if len(left_return_edges) >= 2:
        for index, (_distance, _target_id, edge) in enumerate(sorted(left_return_edges, key=lambda item: (item[0], item[1]))):
            layout[id(edge)] = get_shape_side_anchor('left' if index == 0 else 'bottom')
        remaining_edges = [edge for edge in control_edges if id(edge) not in layout]
        for edge in remaining_edges:
            target_bounds = bounds_by_node_id[edge['to_id']]
            side = get_target_side_for_source(source_bounds, target_bounds, allow_top=False, prefer_horizontal=True)
            if side == 'left':
                side = 'bottom'
            layout[id(edge)] = get_shape_side_anchor(side)
        return layout

    if len(control_edges) <= len(side_candidates):
        used_sides: set[str] = set()
        ordered_by_fit: list[tuple[float, str, str, dict[str, Any]]] = []
        for edge in control_edges:
            target_bounds = bounds_by_node_id[edge['to_id']]
            target_center_x, target_center_y = get_node_center(target_bounds)
            preferred_side = get_target_side_for_source(source_bounds, target_bounds, allow_top=False, prefer_horizontal=True)
            side_rank = {'left': 0, 'right': 1, 'bottom': 2}
            distance = abs(target_center_x - source_center_x) + abs(target_center_y - source_center_y)
            ordered_by_fit.append((
                distance,
                f'{side_rank.get(preferred_side, 3)}:{edge["to_id"]}',
                f'{edge.get("edge_type") or ""}:{edge.get("from_id") or ""}:{edge.get("to_id") or ""}',
                edge,
            ))

        for _distance, _rank, _stable_key, edge in sorted(
            ordered_by_fit,
            key=lambda item: (item[0], item[1], item[2]),
            reverse=True,
        ):
            target_bounds = bounds_by_node_id[edge['to_id']]
            preferred = get_target_side_for_source(source_bounds, target_bounds, allow_top=False, prefer_horizontal=True)
            side = preferred if preferred not in used_sides else next(item for item in side_candidates if item not in used_sides)
            used_sides.add(side)
            layout[id(edge)] = get_shape_side_anchor(side)
        return layout

    for edge in sorted(control_edges, key=lambda item: (item.get('edge_type') or '', item.get('to_id') or '')):
        target_bounds = bounds_by_node_id[edge['to_id']]
        side = get_target_side_for_source(source_bounds, target_bounds, allow_top=False, prefer_horizontal=True)
        index = side_counts[side]
        side_counts[side] += 1
        layout[id(edge)] = get_distributed_anchor_coordinates(side, index, side_counts[side], is_source=True)

    return layout


def build_branch_exit_layout_by_edge_id(
    branching_node_ids: set[str],
    edges: list[dict[str, Any]],
    bounds_by_node_id: dict[str, tuple[int, int, int, int]],
) -> dict[int, tuple[float, float]]:
    layout_by_edge_id: dict[int, tuple[float, float]] = {}
    for source_id in branching_node_ids:
        outgoing_branch_edges = [
            edge for edge in edges
            if edge.get('edge_role') == 'control'
            and edge.get('from_kind') == 'Step'
            and edge.get('to_kind') == 'Step'
            and edge['from_id'] == source_id
        ]
        layout_by_edge_id.update(
            build_branch_exit_layout(source_id, outgoing_branch_edges, bounds_by_node_id)
        )
    return layout_by_edge_id


def align_branch_targets_to_exit_ports(
    edges: list[dict[str, Any]],
    branch_exit_layout_by_edge_id: dict[int, tuple[float, float]],
    bounds_by_node_id: dict[str, tuple[int, int, int, int]],
) -> None:
    for edge in edges:
        exit_anchor = branch_exit_layout_by_edge_id.get(id(edge))
        if not exit_anchor:
            continue
        source_bounds = bounds_by_node_id.get(edge.get('from_id'))
        target_bounds = bounds_by_node_id.get(edge.get('to_id'))
        if not source_bounds or not target_bounds:
            continue

        source_x, source_y, source_width, source_height = source_bounds
        target_x, target_y, target_width, target_height = target_bounds
        source_center_y = source_y + (source_height / 2)
        target_center_y = target_y + (target_height / 2)
        if target_center_y <= source_center_y:
            continue

        exit_x, _exit_y = exit_anchor
        absolute_exit_x = source_x + (source_width * exit_x)
        if exit_x <= 0.01:
            absolute_exit_x -= BRANCH_SIDE_LANE_OFFSET
        elif exit_x >= 0.99:
            absolute_exit_x += BRANCH_SIDE_LANE_OFFSET
        next_target_x = int(round(absolute_exit_x - (target_width / 2)))
        if abs(next_target_x - target_x) <= FLOW_X_GAP:
            bounds_by_node_id[edge['to_id']] = (next_target_x, target_y, target_width, target_height)


def get_branch_entry_coordinates(
    source_bounds: tuple[int, int, int, int],
    target_bounds: tuple[int, int, int, int],
) -> tuple[float, float]:
    source_center_x, source_center_y = get_node_center(source_bounds)
    target_center_x, target_center_y = get_node_center(target_bounds)

    if source_center_y < target_center_y:
        return 0.5, 0.0
    if source_center_y > target_center_y:
        return 0.5, 1.0
    if source_center_x < target_center_x:
        return 0.0, 0.5
    return 1.0, 0.5


def get_merge_exit_coordinates(index: int, count: int) -> tuple[float, float]:
    if count <= 1:
        return 0.5, 1.0
    return get_distributed_anchor_coordinates('bottom', index, count, is_source=True)


def get_merge_exit_coordinates_for_target(
    source_bounds: tuple[int, int, int, int],
    target_bounds: tuple[int, int, int, int],
) -> tuple[float, float]:
    _source_center_x, source_center_y = get_node_center(source_bounds)
    _target_center_x, target_center_y = get_node_center(target_bounds)
    if target_center_y > source_center_y:
        return 0.5, 1.0
    side = get_target_side_for_source(source_bounds, target_bounds, allow_top=False)
    if side == 'bottom':
        return 0.5, 1.0
    return get_shape_side_anchor(side)


def get_merge_entry_coordinates(
    source_bounds: tuple[int, int, int, int],
    target_bounds: tuple[int, int, int, int],
    preferred_exit_side: str = 'bottom',
) -> tuple[float, float]:
    source_center_x, source_center_y = get_node_center(source_bounds)
    target_center_x, target_center_y = get_node_center(target_bounds)

    if source_center_y < target_center_y:
        return 0.5, 0.0

    if source_center_y > target_center_y:
        if preferred_exit_side == 'bottom':
            return (1.0, 0.5) if source_center_x >= target_center_x else (0.0, 0.5)
        return 0.5, 1.0

    if source_center_x < target_center_x:
        return 0.0, 0.5
    return 1.0, 0.5


def apply_postcheck_port_separation(
    root_element: Element,
    bounds_by_node_id: dict[str, tuple[int, int, int, int]],
    node_cell_ids: dict[str, str],
    branching_node_ids: set[str],
    merge_node_ids: set[str],
) -> None:
    stableId_by_cell_id = {cell_id: stableId for stableId, cell_id in node_cell_ids.items()}
    edge_cells = [cell for cell in root_element.findall('mxCell') if cell.get('edge') == '1']

    incoming_by_node: dict[str, list[Element]] = {}
    outgoing_by_node: dict[str, list[Element]] = {}

    for edge_cell in edge_cells:
        source_cell_id = edge_cell.get('source')
        target_cell_id = edge_cell.get('target')
        if source_cell_id:
            source_stableId = stableId_by_cell_id.get(source_cell_id)
            if source_stableId:
                outgoing_by_node.setdefault(source_stableId, []).append(edge_cell)
        if target_cell_id:
            targetStableId = stableId_by_cell_id.get(target_cell_id)
            if targetStableId:
                incoming_by_node.setdefault(targetStableId, []).append(edge_cell)

    for stableId, incoming_edges in incoming_by_node.items():
        outgoing_edges = outgoing_by_node.get(stableId)
        node_bounds = bounds_by_node_id.get(stableId)
        if not outgoing_edges or not node_bounds:
            continue

        incoming_side_by_edge: dict[Element, str] = {}
        incoming_source_bounds_by_edge: dict[Element, tuple[int, int, int, int]] = {}
        outgoing_side_by_edge: dict[Element, str] = {}

        for edge_cell in incoming_edges:
            source_cell_id = edge_cell.get('source')
            source_stableId = stableId_by_cell_id.get(source_cell_id or '')
            source_bounds = bounds_by_node_id.get(source_stableId or '')
            if not source_bounds:
                continue

            target_side = get_edge_side(source_bounds, node_bounds, is_source=False)
            incoming_side_by_edge[edge_cell] = target_side
            incoming_source_bounds_by_edge[edge_cell] = source_bounds

        for edge_cell in outgoing_edges:
            target_cell_id = edge_cell.get('target')
            targetStableId = stableId_by_cell_id.get(target_cell_id or '')
            target_bounds = bounds_by_node_id.get(targetStableId or '')
            if not target_bounds:
                continue

            source_side = get_edge_side(node_bounds, target_bounds, is_source=True)
            outgoing_side_by_edge[edge_cell] = source_side

        conflicting_sides = set(incoming_side_by_edge.values()) & set(outgoing_side_by_edge.values())
        if conflicting_sides:
            for edge_cell, target_side in incoming_side_by_edge.items():
                if target_side not in conflicting_sides:
                    continue
                source_cell_id = edge_cell.get('source')
                source_stableId = stableId_by_cell_id.get(source_cell_id or '')
                source_bounds = bounds_by_node_id.get(source_stableId or '')
                if (
                    source_stableId in branching_node_ids
                    and edge_cell.get('edgeType') in {'TRUE', 'FALSE', 'OPTION_CASE', 'OPTION_DEFAULT'}
                    and source_bounds
                    and get_node_center(node_bounds)[1] > get_node_center(source_bounds)[1]
                ):
                    continue

                entry_x, entry_y = get_anchor_coordinates(target_side, is_source=False)
                style_parts = parse_style(edge_cell.get('style') or '')
                style_parts['entryX'] = str(entry_x)
                style_parts['entryY'] = str(entry_y)
                style_parts['entryDx'] = '0'
                style_parts['entryDy'] = '0'
                style_parts['entryPerimeter'] = '0'
                edge_cell.set('style', serialize_style(style_parts))

            for edge_cell, source_side in outgoing_side_by_edge.items():
                if source_side not in conflicting_sides:
                    continue
                if stableId in branching_node_ids and edge_cell.get('edgeType') in {'TRUE', 'FALSE', 'OPTION_CASE', 'OPTION_DEFAULT'}:
                    continue

                exit_x, exit_y = get_anchor_coordinates(source_side, is_source=True)
                style_parts = parse_style(edge_cell.get('style') or '')
                style_parts['exitX'] = str(exit_x)
                style_parts['exitY'] = str(exit_y)
                style_parts['exitDx'] = '0'
                style_parts['exitDy'] = '0'
                style_parts['exitPerimeter'] = '0'
                edge_cell.set('style', serialize_style(style_parts))

        if stableId in branching_node_ids:
            for edge_cell, source_bounds in incoming_source_bounds_by_edge.items():
                style_parts = parse_style(edge_cell.get('style') or '')
                source_center_x, source_center_y = get_node_center(source_bounds)
                target_center_x, target_center_y = get_node_center(node_bounds)
                _source_x, _source_y, _source_width, source_height = source_bounds
                _target_x, _target_y, _target_width, target_height = node_bounds
                same_visual_row = abs(source_center_y - target_center_y) <= max(source_height, target_height) * 0.35
                if same_visual_row and abs(source_center_x - target_center_x) > abs(source_center_y - target_center_y):
                    if source_center_x < target_center_x:
                        style_parts['entryX'] = '0.0'
                        style_parts['entryY'] = '0.5'
                    else:
                        style_parts['entryX'] = '1.0'
                        style_parts['entryY'] = '0.5'
                elif source_center_y > target_center_y:
                    style_parts['entryX'] = '0.5'
                    style_parts['entryY'] = '1.0'
                else:
                    style_parts['entryX'] = '0.5'
                    style_parts['entryY'] = '0'
                style_parts['entryDx'] = '0'
                style_parts['entryDy'] = '0'
                style_parts['entryPerimeter'] = '0'
                edge_cell.set('style', serialize_style(style_parts))

            ordered_outgoing_edges = sorted(
                [
                    edge_cell for edge_cell in outgoing_side_by_edge
                    if edge_cell.get('edgeType') in {'TRUE', 'FALSE', 'OPTION_CASE', 'OPTION_DEFAULT'}
                ],
                key=lambda edge_cell: (
                    {'TRUE': 0, 'FALSE': 1}.get(edge_cell.get('value') or '', 2),
                    edge_cell.get('target') or '',
                ),
            )
            if len(ordered_outgoing_edges) >= 2:
                for index, edge_cell in enumerate(ordered_outgoing_edges):
                    style_parts = parse_style(edge_cell.get('style') or '')
                    if style_parts.get('exitX') is not None and style_parts.get('exitY') is not None:
                        continue
                    exit_x, exit_y = get_branch_exit_coordinates(
                        index,
                        len(ordered_outgoing_edges),
                        edge_cell.get('value'),
                    )
                    style_parts['exitX'] = str(exit_x)
                    style_parts['exitY'] = str(exit_y)
                    style_parts['exitDx'] = '0'
                    style_parts['exitDy'] = '0'
                    style_parts['exitPerimeter'] = '0'
                    edge_cell.set('style', serialize_style(style_parts))

        if stableId not in merge_node_ids:
            continue

        ordered_incoming_edges = sorted(
            incoming_source_bounds_by_edge,
            key=lambda edge_cell: (edge_cell.get('source') or '', edge_cell.get('value') or ''),
        )
        for edge_cell in ordered_incoming_edges:
            source_bounds = incoming_source_bounds_by_edge[edge_cell]
            entry_x, entry_y = get_merge_entry_coordinates(source_bounds, node_bounds)
            style_parts = parse_style(edge_cell.get('style') or '')
            style_parts['entryX'] = str(entry_x)
            style_parts['entryY'] = str(entry_y)
            style_parts['entryDx'] = '0'
            style_parts['entryDy'] = '0'
            style_parts['entryPerimeter'] = '0'
            edge_cell.set('style', serialize_style(style_parts))

        ordered_merge_outgoing_edges = sorted(
            outgoing_side_by_edge,
            key=lambda edge_cell: (edge_cell.get('target') or '', edge_cell.get('value') or ''),
        )
        for index, edge_cell in enumerate(ordered_merge_outgoing_edges):
            targetStableId = stableId_by_cell_id.get(edge_cell.get('target') or '')
            target_bounds = bounds_by_node_id.get(targetStableId or '')
            if target_bounds:
                exit_x, exit_y = get_merge_exit_coordinates_for_target(node_bounds, target_bounds)
            else:
                exit_x, exit_y = get_merge_exit_coordinates(index, len(ordered_merge_outgoing_edges))
            style_parts = parse_style(edge_cell.get('style') or '')
            style_parts['exitX'] = str(exit_x)
            style_parts['exitY'] = str(exit_y)
            style_parts['exitDx'] = '0'
            style_parts['exitDy'] = '0'
            style_parts['exitPerimeter'] = '0'
            edge_cell.set('style', serialize_style(style_parts))


def build_flow_bounds(
    root: dict[str, Any],
    flow_nodes: list[dict[str, Any]],
    flow_layout: dict[str, tuple[int, int]],
) -> dict[str, tuple[int, int, int, int]]:
    size_by_node_id: dict[str, tuple[int, int]] = {root['stableId']: (180, compact_box_height(70))}
    for node in flow_nodes:
        size_by_node_id[node['stableId']] = get_flow_size(node)

    row_entries: dict[int, list[tuple[int, str]]] = {}
    for node_id, (column, row) in flow_layout.items():
        row_entries.setdefault(row, []).append((column, node_id))

    all_columns = [column for entries in row_entries.values() for column, _node_id in entries]
    global_min_column = min(all_columns, default=0)
    row_axis_offsets: dict[int, int] = {
        row: -global_min_column * FLOW_X_GAP
        for row in row_entries
    }

    bounds_by_node_id: dict[str, tuple[int, int, int, int]] = {}
    for row in sorted(row_entries):
        entries = row_entries[row]
        row_axis_offset_x = row_axis_offsets[row]
        for column, node_id in entries:
            width, height = size_by_node_id[node_id]
            x = int(round(FLOW_ORIGIN_X + row_axis_offset_x + (column * FLOW_X_GAP) - (width / 2)))
            row_center_y = (FN_ROOT_Y + 35) if node_id == root['stableId'] else FLOW_ORIGIN_Y + (row * FLOW_Y_GAP) + 45
            y = int(row_center_y - (height / 2))
            bounds_by_node_id[node_id] = (x, y, width, height)

    boundary_ids = {node.get('stableId') for node in flow_nodes if node.get('boundary')}
    if boundary_ids:
        non_boundary_y_values = [
            y
            for node_id, (_x, y, _width, _height) in bounds_by_node_id.items()
            if node_id not in boundary_ids
        ]
        boundary_y = (max(non_boundary_y_values) if non_boundary_y_values else FLOW_ORIGIN_Y) + FLOW_Y_GAP
        for node_id in boundary_ids:
            if node_id in bounds_by_node_id:
                x, _y, width, height = bounds_by_node_id[node_id]
                bounds_by_node_id[node_id] = (x, boundary_y, width, height)

    return bounds_by_node_id


def build_target_fn_positions(target_fns: list[dict[str, Any]], edges: list[dict[str, Any]], flow_layout: dict[str, tuple[int, int]]) -> dict[str, tuple[int, int]]:
    anchor_y_by_fn: dict[str, int] = {}
    target_fn_height = compact_box_height(70)
    for edge in edges:
        if edge['to_kind'] != 'Fn' or edge['from_kind'] != 'Step':
            continue
        source_bounds = bounds_by_node_id.get(edge['from_id'])
        if not source_bounds:
            continue
        _x, y, _width, height = source_bounds
        candidate = y + (height // 2) - (target_fn_height // 2)
        current = anchor_y_by_fn.get(edge['to_id'])
        anchor_y_by_fn[edge['to_id']] = candidate if current is None else min(current, candidate)

    max_flow_x = max((position[0] for position in flow_layout.values()), default=0)
    target_x = FLOW_ORIGIN_X + (max_flow_x * FLOW_X_GAP) + FN_TARGET_X_GAP

    ordered = sorted(target_fns, key=lambda fn: (anchor_y_by_fn.get(fn['stableId'], 0), fn['stableId']))
    positions: dict[str, tuple[int, int]] = {}
    used_y: set[int] = set()
    for index, fn in enumerate(ordered):
        desired_y = anchor_y_by_fn.get(fn['stableId'], FN_ROOT_Y + (index * FLOW_Y_GAP))
        while desired_y in used_y:
            desired_y += 90
        positions[fn['stableId']] = (target_x, desired_y)
        used_y.add(desired_y)

    return positions


def is_ui_side_target_fn(fn: dict[str, Any]) -> bool:
    return bool(fn.get('ui_side'))


def get_target_fn_style(fn: dict[str, Any]) -> str:
    if is_ui_side_target_fn(fn):
        return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#b7d6e8;strokeColor=#4f86a4;fontColor=#000000;'
    if fn.get('resource_kinds'):
        return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;fontColor=#000000;'
    return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#9fbe99;strokeColor=#5f874f;fontColor=#000000;'


def enrich_target_fns_from_visual_resource_edges(
    target_fns: list[dict[str, Any]],
    resource_nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
) -> None:
    fn_by_id = {fn.get('stableId'): fn for fn in target_fns}
    resource_by_key = {resource.get('stableId'): resource for resource in resource_nodes}
    for edge in edges:
        if edge.get('from_kind') != 'Fn' or edge.get('to_kind') != 'Resource':
            continue
        fn = fn_by_id.get(edge.get('from_id'))
        resource = resource_by_key.get(edge.get('to_id'))
        resource_kind = resource.get('resource_kind') if resource else None
        if not fn or not resource_kind:
            continue
        resource_kinds = list(fn.get('resource_kinds') or [])
        if resource_kind not in resource_kinds:
            resource_kinds.append(resource_kind)
        fn['resource_kinds'] = resource_kinds
        fn['ui_side'] = bool(resource_kinds) and all(is_ui_resource(kind) for kind in resource_kinds)


def collect_side_call_step_kinds(
    edges: list[dict[str, Any]],
    resource_nodes: list[dict[str, Any]],
    branching_node_ids: set[str],
) -> dict[str, str]:
    resource_by_key = {resource.get('stableId'): resource for resource in resource_nodes}
    resource_kinds_by_step: dict[str, list[str]] = {}
    for edge in edges:
        if edge.get('to_kind') != 'Resource':
            continue
        step_id = edge.get('visual_source_step_id')
        if not step_id and edge.get('from_kind') == 'Step':
            step_id = edge.get('from_id')
        if not step_id or step_id in branching_node_ids:
            continue
        resource = resource_by_key.get(edge.get('to_id')) or {}
        resource_kinds_by_step.setdefault(step_id, []).append(normalize_resource_kind(resource))

    side_by_step: dict[str, str] = {}
    for step_id, kinds in resource_kinds_by_step.items():
        meaningful_kinds = [kind for kind in kinds if kind != 'async-control']
        effective_kinds = meaningful_kinds or kinds
        if not effective_kinds:
            continue
        side_by_step[step_id] = 'ui' if all(is_ui_resource(kind) for kind in effective_kinds) else 'resource'
    return side_by_step


def build_target_fn_positions_with_bounds(
    target_fns: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    flow_layout: dict[str, tuple[int, int]],
    bounds_by_node_id: dict[str, tuple[int, int, int, int]],
) -> dict[str, tuple[int, int]]:
    anchor_y_by_fn: dict[str, int] = {}
    target_fn_height = compact_box_height(70)
    for edge in edges:
        if edge['to_kind'] != 'Fn' or edge['from_kind'] != 'Step':
            continue
        source_bounds = bounds_by_node_id.get(edge['from_id'])
        if not source_bounds:
            continue
        _x, y, _width, height = source_bounds
        candidate = y + (height // 2) - (target_fn_height // 2)
        current = anchor_y_by_fn.get(edge['to_id'])
        anchor_y_by_fn[edge['to_id']] = candidate if current is None else min(current, candidate)

    max_flow_right = max((x + width for x, _y, width, _height in bounds_by_node_id.values()), default=FLOW_ORIGIN_X)
    right_target_x = max_flow_right + FN_TARGET_X_GAP
    left_target_x = UI_TARGET_X

    ordered = sorted(target_fns, key=lambda fn: (is_ui_side_target_fn(fn), anchor_y_by_fn.get(fn['stableId'], 0), fn['stableId']))
    positions: dict[str, tuple[int, int]] = {}
    used_y_by_side: dict[str, set[int]] = {'left': set(), 'right': set()}
    for index, fn in enumerate(ordered):
        side = 'left' if is_ui_side_target_fn(fn) else 'right'
        desired_y = anchor_y_by_fn.get(fn['stableId'], FN_ROOT_Y + (index * FLOW_Y_GAP))
        used_y = used_y_by_side[side]
        while desired_y in used_y:
            desired_y += 90
        positions[fn['stableId']] = (left_target_x if side == 'left' else right_target_x, desired_y)
        used_y.add(desired_y)

    return positions


def relation_trunk_rank(rel_type: str | None) -> int:
    if rel_type == 'NEXT':
        return 0
    if rel_type == 'TRUE':
        return 1
    if rel_type in {'OPTION_CASE', 'OPTION_DEFAULT'}:
        return 2
    if rel_type == 'FALSE':
        return 3
    return 2


def build_flow_child_scores(root_stableId: str, child_ids_by_source: dict[str, list[dict[str, str]]]) -> dict[str, tuple[int, int]]:
    straight_scores: dict[str, int] = {}
    total_scores: dict[str, int] = {}
    reachable_cache: dict[str, set[str]] = {}

    def reachable_nodes(node_id: str, path: set[str]) -> set[str]:
        if node_id in reachable_cache:
            return reachable_cache[node_id]
        if node_id in path:
            return set()
        children = [
            child
            for child in child_ids_by_source.get(node_id, [])
            if child.get('id') != root_stableId
        ]
        if not children:
            reachable_cache[node_id] = set()
            return reachable_cache[node_id]
        next_path = {*path, node_id}
        reachable: set[str] = set()
        for child in children:
            child_id = child['id']
            reachable.add(child_id)
            reachable.update(reachable_nodes(child_id, next_path))
        reachable_cache[node_id] = reachable
        return reachable

    def straight_score(node_id: str, path: set[str]) -> int:
        if node_id in straight_scores:
            return straight_scores[node_id]
        if node_id in path:
            return 0
        children = [
            child
            for child in child_ids_by_source.get(node_id, [])
            if child.get('id') != root_stableId
        ]
        if len(children) != 1:
            straight_scores[node_id] = 0
            return 0
        straight_scores[node_id] = 1 + straight_score(children[0]['id'], {*path, node_id})
        return straight_scores[node_id]

    for source_id in child_ids_by_source:
        total_scores[source_id] = len(reachable_nodes(source_id, set()))
        straight_score(source_id, set())
    return {
        node_id: (straight_scores.get(node_id, 0), total_scores.get(node_id, 0))
        for node_id in set(straight_scores) | set(total_scores)
    }


def order_flow_children_for_left_tree(
    children: list[dict[str, str]],
    side_call_step_kinds: dict[str, str],
    child_scores: dict[str, tuple[int, int]],
) -> list[dict[str, str]]:
    if not children:
        return children

    has_branch_children = any(child.get('rel_type') in {'TRUE', 'FALSE', 'OPTION_CASE', 'OPTION_DEFAULT'} for child in children)

    def branch_rank(child: dict[str, str]) -> tuple[int, int, int, int, str]:
        straight_score, total_score = child_scores.get(child['id'], (0, 0))
        if child.get('rel_type') == 'NEXT':
            return (
                -1_000_000,
                0,
                0,
                flow_side_rank(side_call_step_kinds.get(child['id'])),
                child['id'],
            )
        if has_branch_children and child.get('rel_type') in {'TRUE', 'FALSE', 'OPTION_CASE', 'OPTION_DEFAULT'}:
            return (
                total_score,
                straight_score,
                relation_trunk_rank(child.get('rel_type')),
                flow_side_rank(side_call_step_kinds.get(child['id'])),
                child['id'],
            )
        return (
            -straight_score,
            relation_trunk_rank(child.get('rel_type')),
            -total_score,
            flow_side_rank(side_call_step_kinds.get(child['id'])),
            child['id'],
        )

    return sorted(children, key=branch_rank)


def order_flow_children(children: list[dict[str, str]], side_call_step_kinds: dict[str, str]) -> list[dict[str, str]]:
    if any(child.get('rel_type') in {'TRUE', 'FALSE', 'OPTION_CASE', 'OPTION_DEFAULT'} for child in children):
        return children

    def side_rank(child: dict[str, str]) -> int:
        side = side_call_step_kinds.get(child['id'])
        if side == 'ui':
            return 0
        elif side == 'resource':
            return 2
        return 1

    return sorted(children, key=side_rank)


def order_flow_rows_by_side_kind(
    positions: dict[str, tuple[int, int]],
    side_call_step_kinds: dict[str, str],
    root_stableId: str,
    main_flow_node_ids: set[str],
) -> None:
    rows: dict[int, list[tuple[str, int]]] = {}
    for node_id, (column, row) in positions.items():
        if node_id == root_stableId:
            continue
        rows.setdefault(row, []).append((node_id, column))

    for entries in rows.values():
        main_entries = [entry for entry in entries if entry[0] in main_flow_node_ids]
        if len(main_entries) < 2:
            continue
        columns = sorted(column for _node_id, column in main_entries)
        ordered = sorted(
            main_entries,
            key=lambda entry: (flow_side_rank(side_call_step_kinds.get(entry[0])), entry[1]),
        )
        for index, (node_id, _column) in enumerate(ordered):
            _old_column, row = positions[node_id]
            positions[node_id] = (columns[index], row)


def flow_side_rank(side: str | None) -> int:
    if side == 'ui':
        return 0
    if side == 'resource':
        return 2
    return 1


def align_targets_with_lower_incoming_sources(
    positions: dict[str, tuple[int, int]],
    edges: list[dict[str, Any]],
    root_stableId: str,
) -> bool:
    changed = False
    control_edge_types = {'TRUE', 'FALSE', 'OPTION_CASE', 'OPTION_DEFAULT', 'MERGES_TO'}
    control_edges = [
        edge
        for edge in edges
        if edge.get('edge_role') == 'control'
        and edge.get('from_id') in positions
        and edge.get('to_id') in positions
        and edge.get('to_id') != root_stableId
        and (edge.get('edge_type') or edge.get('label')) in control_edge_types
    ]

    def stableId_start_key(stableId: str) -> tuple[int, int] | None:
        parsed = parse_stableId(stableId)
        line = parsed.get('start_line')
        column = parsed.get('start_column')
        if line is None or column is None:
            return None
        return int(line), int(column)

    def starts_before_or_at(left_id: str, right_id: str) -> bool:
        left_key = stableId_start_key(left_id)
        right_key = stableId_start_key(right_id)
        if left_key is None or right_key is None:
            return True
        return left_key <= right_key

    forward_control_edges = [
        edge
        for edge in control_edges
        if starts_before_or_at(edge['from_id'], edge['to_id'])
    ]

    snapshot = dict(positions)
    desired_row_by_target: dict[str, int] = {}
    for edge in forward_control_edges:
        source_position = snapshot.get(edge['from_id'])
        target_position = snapshot.get(edge['to_id'])
        if not source_position or not target_position:
            continue
        source_column, source_row = source_position
        target_column, target_row = target_position
        if target_column > source_column and target_row == source_row:
            continue
        desired_target_row = source_row + 1
        if desired_target_row <= target_row:
            continue
        desired_row_by_target[edge['to_id']] = max(
            desired_row_by_target.get(edge['to_id'], target_row),
            desired_target_row,
        )

    for target_id, desired_row in desired_row_by_target.items():
        target_column, target_row = positions[target_id]
        if desired_row <= target_row:
            continue
        positions[target_id] = (target_column, desired_row)
        changed = True

    return changed


def stableId_start_key(stableId: str) -> tuple[int, int] | None:
    parsed = parse_stableId(stableId)
    line = parsed.get('start_line')
    column = parsed.get('start_column')
    if line is None or column is None:
        return None
    return int(line), int(column)


def starts_before_or_at(left_id: str, right_id: str) -> bool:
    left_key = stableId_start_key(left_id)
    right_key = stableId_start_key(right_id)
    if left_key is None or right_key is None:
        return True
    return left_key <= right_key


def enforce_forward_control_order(
    positions: dict[str, tuple[int, int]],
    edges: list[dict[str, Any]],
    root_stableId: str,
) -> bool:
    changed = False
    control_edge_types = {'NEXT', 'TRUE', 'FALSE', 'OPTION_CASE', 'OPTION_DEFAULT', 'MERGES_TO'}
    control_edges = [
        edge
        for edge in edges
        if edge.get('edge_role') == 'control'
        and edge.get('from_id') in positions
        and edge.get('to_id') in positions
        and edge.get('to_id') != root_stableId
        and (edge.get('edge_type') or edge.get('label')) in control_edge_types
        and ((edge.get('edge_type') or edge.get('label')) == 'NEXT' or starts_before_or_at(edge['from_id'], edge['to_id']))
    ]
    layout_parent_edge_by_target = choose_layout_parent_edge_by_target(positions, control_edges)

    for _iteration in range(max(1, len(positions))):
        iteration_changed = False
        for edge in control_edges:
            if layout_parent_edge_by_target.get(edge['to_id']) is not edge:
                continue
            source_column, source_row = positions[edge['from_id']]
            target_column, target_row = positions[edge['to_id']]
            if (
                (edge.get('edge_type') or edge.get('label')) != 'NEXT'
                and target_column > source_column
                and target_row == source_row
            ):
                continue
            desired_row = source_row + 1
            desired_column = source_column if (edge.get('edge_type') or edge.get('label')) == 'NEXT' else target_column
            if target_row > source_row and target_column == desired_column:
                continue
            positions[edge['to_id']] = (desired_column, desired_row)
            iteration_changed = True
            changed = True
        if not iteration_changed:
            break

    return changed


def compact_flow_rows(positions: dict[str, tuple[int, int]]) -> None:
    used_rows = sorted({row for _column, row in positions.values()})
    row_map = {row: index for index, row in enumerate(used_rows)}
    for node_id, (column, row) in list(positions.items()):
        positions[node_id] = (column, row_map[row])


def reclaim_single_incoming_branch_targets(
    positions: dict[str, tuple[int, int]],
    edges: list[dict[str, Any]],
    root_stableId: str,
    merge_node_ids: set[str] | None = None,
) -> bool:
    merge_node_ids = merge_node_ids or set()
    incoming_branch_edges_by_target: dict[str, list[dict[str, Any]]] = {}
    for edge in edges:
        if (
            is_branch_control_edge(edge)
            and edge.get('from_id') in positions
            and edge.get('to_id') in positions
            and edge.get('to_id') != root_stableId
            and edge.get('to_id') not in merge_node_ids
        ):
            incoming_branch_edges_by_target.setdefault(edge['to_id'], []).append(edge)

    changed = False
    for target_id, incoming_edges in incoming_branch_edges_by_target.items():
        if len(incoming_edges) != 1:
            continue
        edge = incoming_edges[0]
        source_column, _source_row = positions[edge['from_id']]
        target_column, target_row = positions[target_id]
        if target_column == source_column:
            continue
        desired_column = source_column + (1 if target_column > source_column else -1)
        if abs(target_column - source_column) <= 1:
            continue
        if any(
            other_id != target_id and other_position == (desired_column, target_row)
            for other_id, other_position in positions.items()
        ):
            continue
        positions[target_id] = (desired_column, target_row)
        changed = True
    return changed


def resolve_flow_position_collisions(
    positions: dict[str, tuple[int, int]],
    root_stableId: str,
) -> None:
    rows: dict[int, list[tuple[int, str]]] = {}
    for node_id, (column, row) in positions.items():
        rows.setdefault(row, []).append((column, node_id))

    for row, entries in rows.items():
        used_columns: set[int] = set()
        for column, node_id in sorted(entries, key=lambda item: (item[0], item[1] != root_stableId, item[1])):
            next_column = column
            while next_column in used_columns:
                next_column += 1
            used_columns.add(next_column)
            if next_column != column:
                positions[node_id] = (next_column, row)


def align_next_targets_below_sources(
    positions: dict[str, tuple[int, int]],
    edges: list[dict[str, Any]],
    root_stableId: str,
) -> bool:
    changed = False
    incoming_next_edges_by_target: dict[str, list[dict[str, Any]]] = {}
    incoming_control_edges_by_target: dict[str, list[dict[str, Any]]] = {}
    for edge in edges:
        if edge.get('edge_role') != 'control':
            continue
        source_id = edge.get('from_id')
        target_id = edge.get('to_id')
        if (
            not source_id
            or not target_id
            or target_id == root_stableId
            or source_id not in positions
            or target_id not in positions
        ):
            continue
        incoming_control_edges_by_target.setdefault(target_id, []).append(edge)
        if (edge.get('edge_type') or edge.get('label')) == 'NEXT':
            incoming_next_edges_by_target.setdefault(target_id, []).append(edge)

    layout_parent_edge_by_target = choose_layout_parent_edge_by_target(positions, [
        edge
        for edges_for_target in incoming_control_edges_by_target.values()
        for edge in edges_for_target
    ])

    for target_id, incoming_edges in incoming_next_edges_by_target.items():
        controlling_edge = layout_parent_edge_by_target.get(target_id)
        if controlling_edge not in incoming_edges:
            continue
        source_column, source_row = positions[controlling_edge['from_id']]
        target_column, target_row = positions[target_id]
        desired_position = (source_column, source_row + 1)
        if target_column == desired_position[0] and target_row >= desired_position[1]:
            continue
        positions[target_id] = desired_position
        changed = True

    return changed


def choose_layout_parent_edge_by_target(
    positions: dict[str, tuple[int, int]],
    control_edges: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    incoming_edges_by_target: dict[str, list[dict[str, Any]]] = {}
    for edge in control_edges:
        source_id = edge.get('from_id')
        target_id = edge.get('to_id')
        if source_id not in positions or not target_id:
            continue
        incoming_edges_by_target.setdefault(target_id, []).append(edge)

    layout_parent_edge_by_target: dict[str, dict[str, Any]] = {}
    for target_id, incoming_edges in incoming_edges_by_target.items():
        layout_parent_edge_by_target[target_id] = min(
            incoming_edges,
            key=lambda edge: (
                positions[edge['from_id']][0],
                positions[edge['from_id']][1],
                relation_trunk_rank(edge.get('edge_type') or edge.get('label')),
                edge['from_id'],
            ),
        )
    return layout_parent_edge_by_target


def record_collapsed_merge_layout_events(
    positions: dict[str, tuple[int, int]],
    edges: list[dict[str, Any]],
    layout_events: dict[str, list[str]] | None,
) -> None:
    if layout_events is None:
        return

    collapsed_edges = [
        edge
        for edge in edges
        if edge.get('collapsed_merge')
        and edge.get('from_id') in positions
        and edge.get('to_id') in positions
    ]
    if not collapsed_edges:
        return

    layout_parent_edge_by_target = choose_layout_parent_edge_by_target(positions, [
        edge
        for edge in collapsed_edges
        if edge.get('edge_role') == 'control'
    ])
    for edge in collapsed_edges:
        target_id = edge.get('to_id')
        if not target_id:
            continue
        edge_type = edge.get('edge_type') or edge.get('label') or 'control'
        source_position = format_layout_position(positions.get(edge.get('from_id')))
        target_position = format_layout_position(positions.get(target_id))
        parent_marker = 'layout-parent' if layout_parent_edge_by_target.get(target_id) is edge else 'secondary'
        layout_events.setdefault(target_id, []).append(
            'merge collapse: '
            f'{parent_marker}; hidden merge {get_short_stable_suffix(edge.get("via_merge_id") or "")}; '
            f'{edge_type} from {get_short_stable_suffix(edge.get("from_id") or "")} at {source_position} '
            f'positions target at {target_position}; merge NEXT target {get_short_stable_suffix(edge.get("merge_next_target_id") or "")}'
        )


def align_collapsed_merge_targets_below_layout_parent(
    positions: dict[str, tuple[int, int]],
    edges: list[dict[str, Any]],
    root_stableId: str,
) -> bool:
    collapsed_control_edges = [
        edge
        for edge in edges
        if edge.get('collapsed_merge')
        and edge.get('edge_role') == 'control'
        and edge.get('from_id') in positions
        and edge.get('to_id') in positions
        and edge.get('to_id') != root_stableId
    ]
    if not collapsed_control_edges:
        return False

    layout_parent_edge_by_target = choose_layout_parent_edge_by_target(positions, collapsed_control_edges)
    changed = False
    for target_id, edge in layout_parent_edge_by_target.items():
        source_column, source_row = positions[edge['from_id']]
        desired_position = (source_column, source_row + 1)
        current_position = positions[target_id]
        if current_position == desired_position:
            continue
        if any(
            other_id != target_id and other_position == desired_position
            for other_id, other_position in positions.items()
        ):
            continue
        positions[target_id] = desired_position
        changed = True
    return changed


def choose_topmost_layout_parent_edge_by_target(
    positions: dict[str, tuple[int, int]],
    control_edges: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    incoming_edges_by_target: dict[str, list[dict[str, Any]]] = {}
    for edge in control_edges:
        source_id = edge.get('from_id')
        target_id = edge.get('to_id')
        if source_id not in positions or not target_id:
            continue
        incoming_edges_by_target.setdefault(target_id, []).append(edge)

    layout_parent_edge_by_target: dict[str, dict[str, Any]] = {}
    for target_id, incoming_edges in incoming_edges_by_target.items():
        layout_parent_edge_by_target[target_id] = min(
            incoming_edges,
            key=lambda edge: (
                positions[edge['from_id']][1],
                positions[edge['from_id']][0],
                relation_trunk_rank(edge.get('edge_type') or edge.get('label')),
                edge['from_id'],
            ),
        )
    return layout_parent_edge_by_target


def enforce_final_control_target_order(
    positions: dict[str, tuple[int, int]],
    edges: list[dict[str, Any]],
    root_stableId: str,
) -> bool:
    control_edge_types = {'NEXT', 'TRUE', 'FALSE', 'OPTION_CASE', 'OPTION_DEFAULT', 'MERGES_TO'}
    control_edges = [
        edge
        for edge in edges
        if edge.get('edge_role') == 'control'
        and edge.get('from_id') in positions
        and edge.get('to_id') in positions
        and edge.get('to_id') != root_stableId
        and (edge.get('edge_type') or edge.get('label')) in control_edge_types
    ]
    layout_parent_edge_by_target = choose_topmost_layout_parent_edge_by_target(positions, control_edges)

    changed = False
    for edge in control_edges:
        if layout_parent_edge_by_target.get(edge['to_id']) is not edge:
            continue

        source_column, source_row = positions[edge['from_id']]
        target_column, target_row = positions[edge['to_id']]
        edge_type = edge.get('edge_type') or edge.get('label')

        desired_position: tuple[int, int] | None = None
        if edge_type == 'NEXT' and target_row <= source_row:
            desired_position = (source_column, source_row + 1)
        elif is_branch_control_edge(edge) and target_column > source_column and target_row < source_row:
            desired_position = (target_column, source_row)
        elif edge_type != 'NEXT' and target_row <= source_row:
            desired_position = (target_column, source_row + 1)

        if desired_position is None or positions[edge['to_id']] == desired_position:
            continue
        if any(
            other_id != edge['to_id'] and other_position == desired_position
            for other_id, other_position in positions.items()
        ):
            continue
        positions[edge['to_id']] = desired_position
        changed = True

    return changed


def align_next_targets_to_source_columns(
    positions: dict[str, tuple[int, int]],
    edges: list[dict[str, Any]],
) -> bool:
    changed = False
    branch_target_ids = {
        edge.get('to_id')
        for edge in edges
        if edge.get('edge_role') == 'control'
        and (edge.get('edge_type') or edge.get('label')) in {'TRUE', 'FALSE', 'OPTION_CASE', 'OPTION_DEFAULT'}
    }

    for _iteration in range(max(1, len(positions))):
        iteration_changed = False
        for edge in edges:
            if edge.get('edge_role') != 'control':
                continue
            if (edge.get('edge_type') or edge.get('label')) != 'NEXT':
                continue
            if edge.get('to_id') in branch_target_ids:
                continue
            source_position = positions.get(edge.get('from_id'))
            target_position = positions.get(edge.get('to_id'))
            if not source_position or not target_position:
                continue
            source_column, _source_row = source_position
            target_column, target_row = target_position
            if target_column == source_column:
                continue
            target_row_occupants = {
                column: node_id
                for node_id, (column, node_row) in positions.items()
                if node_row == target_row and node_id != edge.get('to_id')
            }
            if source_column in target_row_occupants:
                continue
            positions[edge['to_id']] = (source_column, target_row)
            iteration_changed = True
            changed = True
        if not iteration_changed:
            break

    return changed


def align_branch_merge_targets_below_sources(
    positions: dict[str, tuple[int, int]],
    edges: list[dict[str, Any]],
    merge_node_ids: set[str],
    root_stableId: str,
) -> bool:
    changed = False
    branch_edge_types = {'TRUE', 'FALSE', 'OPTION_CASE', 'OPTION_DEFAULT'}
    candidate_edges = [
        edge
        for edge in edges
        if edge.get('edge_role') == 'control'
        and (edge.get('edge_type') or edge.get('label')) in branch_edge_types
        and edge.get('from_id') in positions
        and edge.get('to_id') in positions
        and edge.get('to_id') != root_stableId
        and edge.get('to_id') in merge_node_ids
    ]
    layout_parent_edge_by_target = choose_layout_parent_edge_by_target(positions, candidate_edges)
    for edge in candidate_edges:
        if layout_parent_edge_by_target.get(edge['to_id']) is not edge:
            continue
        source_id = edge['from_id']
        target_id = edge['to_id']

        source_column, source_row = positions[source_id]
        _target_column, target_row = positions[target_id]
        desired_position = (source_column, max(target_row, source_row + 1))
        if positions[target_id] == desired_position:
            continue
        if any(
            other_id != target_id and other_position == desired_position
            for other_id, other_position in positions.items()
        ):
            continue
        positions[target_id] = desired_position
        changed = True
    return changed


def is_step_control_edge(edge: dict[str, Any]) -> bool:
    return (
        edge.get('edge_role') == 'control'
        and edge.get('from_kind') == 'Step'
        and edge.get('to_kind') == 'Step'
    )


def is_branch_control_edge(edge: dict[str, Any]) -> bool:
    return is_step_control_edge(edge) and (edge.get('edge_type') or edge.get('label')) in {
        'TRUE',
        'FALSE',
        'OPTION_CASE',
        'OPTION_DEFAULT',
    }


def compute_right_branch_lane_columns(
    positions: dict[str, tuple[int, int]],
    edges: list[dict[str, Any]],
    merge_node_ids: set[str] | None = None,
) -> dict[tuple[str, str], int]:
    merge_node_ids = merge_node_ids or set()
    right_edges = [
        edge
        for edge in edges
        if is_branch_control_edge(edge)
        and edge.get('from_id') in positions
        and edge.get('to_id') in positions
        and edge.get('to_id') not in merge_node_ids
        and positions[edge['to_id']][0] > positions[edge['from_id']][0]
    ]
    all_lanes: list[tuple[int, int, int, str]] = []
    blocking_lanes: list[tuple[int, int, int, str]] = []
    lane_columns: dict[tuple[str, str], int] = {}

    for edge in sorted(
        right_edges,
        key=lambda item: (
            positions[item['from_id']][1],
            positions[item['from_id']][0],
            item.get('edge_type') or '',
            item.get('from_id') or '',
            item.get('to_id') or '',
        ),
    ):
        source_column, source_row = positions[edge['from_id']]
        target_column, target_row = positions[edge['to_id']]
        lane_column = source_column + 1
        while any(
            occupied_column == lane_column
            and min(start_row, end_row) <= source_row <= max(start_row, end_row)
            and lane_target_id == edge['to_id']
            for occupied_column, start_row, end_row, lane_target_id in all_lanes
        ) or any(
            occupied_column == lane_column
            and min(start_row, end_row) <= source_row <= max(start_row, end_row)
            and lane_target_id != edge['to_id']
            for occupied_column, start_row, end_row, lane_target_id in blocking_lanes
        ):
            lane_column += 1
        lane_columns[(edge['from_id'], edge['to_id'])] = lane_column
        all_lanes.append((lane_column, source_row, target_row, edge['to_id']))
        if not any(lane_target_id == edge['to_id'] for _column, _start, _end, lane_target_id in blocking_lanes):
            blocking_lanes.append((lane_column, source_row, target_row, edge['to_id']))

    return lane_columns


def pack_right_branch_targets_to_lane_columns(
    positions: dict[str, tuple[int, int]],
    edges: list[dict[str, Any]],
    merge_node_ids: set[str] | None = None,
) -> bool:
    merge_node_ids = merge_node_ids or set()
    changed = False
    right_incoming_count_by_target: dict[str, int] = {}
    for edge in edges:
        if (
            is_branch_control_edge(edge)
            and edge.get('from_id') in positions
            and edge.get('to_id') in positions
            and edge.get('to_id') not in merge_node_ids
            and positions[edge['to_id']][0] > positions[edge['from_id']][0]
        ):
            right_incoming_count_by_target[edge['to_id']] = right_incoming_count_by_target.get(edge['to_id'], 0) + 1

    for _iteration in range(max(1, len(positions))):
        lane_columns = compute_right_branch_lane_columns(positions, edges, merge_node_ids)
        iteration_changed = False
        for (_source_id, target_id), lane_column in sorted(lane_columns.items(), key=lambda item: (item[1], item[0][1])):
            if right_incoming_count_by_target.get(target_id, 0) != 1:
                continue
            target_position = positions.get(target_id)
            if not target_position:
                continue
            target_column, target_row = target_position
            if lane_column <= target_column:
                continue
            positions[target_id] = (lane_column, target_row)
            iteration_changed = True
            changed = True
        if not iteration_changed:
            break
    return changed


def move_boundary_rows_below_flow(
    positions: dict[str, tuple[int, int]],
    flow_nodes: list[dict[str, Any]],
) -> None:
    boundary_ids = {
        node.get('stableId')
        for node in flow_nodes
        if node.get('boundary')
    }
    if not boundary_ids:
        return
    non_boundary_rows = [
        row
        for node_id, (_column, row) in positions.items()
        if node_id not in boundary_ids
    ]
    boundary_row = (max(non_boundary_rows) if non_boundary_rows else 0) + 1
    for node_id in boundary_ids:
        if node_id in positions:
            column, _row = positions[node_id]
            positions[node_id] = (column, boundary_row)


def move_merge_rows_closer_to_next(
    positions: dict[str, tuple[int, int]],
    flow_nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
) -> bool:
    merge_ids = {
        node.get('stableId')
        for node in flow_nodes
        if 'Merge' in set(node.get('labels') or [])
    }
    if not merge_ids:
        return False

    changed = False
    for edge in edges:
        if edge.get('from_kind') != 'Step' or edge.get('to_kind') != 'Step':
            continue
        if (edge.get('edge_type') or edge.get('label')) != 'NEXT':
            continue
        if edge.get('from_id') not in merge_ids:
            continue

        merge_position = positions.get(edge['from_id'])
        next_position = positions.get(edge['to_id'])
        if not merge_position or not next_position:
            continue
        merge_column, merge_row = merge_position
        _next_column, next_row = next_position
        desired_row = next_row - 1
        if desired_row <= merge_row:
            continue
        positions[edge['from_id']] = (merge_column, desired_row)
        changed = True
    return changed


def build_resource_positions_with_bounds(
    resource_nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    bounds_by_node_id: dict[str, tuple[int, int, int, int]],
    target_fns: list[dict[str, Any]] | None = None,
) -> dict[str, tuple[int, int]]:
    if not resource_nodes:
        return {}

    anchor_y_by_resource: dict[str, int] = {}
    for edge in edges:
        if edge['from_kind'] not in {'Step', 'Fn'} or edge['to_kind'] != 'Resource':
            if edge['from_kind'] != 'Resource' or edge['to_kind'] != 'Resource':
                continue
            target_anchor_y = anchor_y_by_resource.get(edge['to_id'])
            if target_anchor_y is None:
                continue
            current = anchor_y_by_resource.get(edge['from_id'])
            candidate = max(FN_ROOT_Y, target_anchor_y - 80)
            anchor_y_by_resource[edge['from_id']] = candidate if current is None else min(current, candidate)
            continue
        source_bounds = bounds_by_node_id.get(edge['from_id'])
        if not source_bounds:
            continue
        _x, y, _width, height = source_bounds
        candidate = y + (height // 2)
        current = anchor_y_by_resource.get(edge['to_id'])
        anchor_y_by_resource[edge['to_id']] = candidate if current is None else min(current, candidate)

    right_target_fn_ids = {fn.get('stableId') for fn in (target_fns or []) if not is_ui_side_target_fn(fn)}
    right_target_fn_bounds = [
        bounds_by_node_id[stableId]
        for stableId in right_target_fn_ids
        if stableId in bounds_by_node_id
    ]
    max_flow_right = max(
        (
            x + width
            for stableId, (x, _y, width, _height) in bounds_by_node_id.items()
            if stableId not in right_target_fn_ids
        ),
        default=FLOW_ORIGIN_X,
    )
    if right_target_fn_bounds:
        max_right = max((x + width for x, _y, width, _height in right_target_fn_bounds), default=max_flow_right)
        base_x = max_right + 60
    else:
        base_x = max_flow_right + 60
    left_base_x = UI_TARGET_X
    lane_by_kind = {
        'external-source': 0,
        'async-event': 1,
        'async-control': 2,
        'browser-storage': 3,
        'storage': 3,
        'external-sink': 4,
    }
    used_y_by_lane: dict[int, set[int]] = {}
    used_y_by_ui_lane: dict[int, set[int]] = {}
    positions: dict[str, tuple[int, int]] = {}

    raw_lane_by_stableId = {
        resource['stableId']: lane_by_kind.get(normalize_resource_kind(resource), 1)
        for resource in resource_nodes
        if not is_ui_resource(resource)
    }
    raw_ui_lane_by_stableId = {
        resource['stableId']: 0
        for resource in resource_nodes
        if is_ui_resource(resource)
    }
    compact_lane_by_raw_lane = {
        raw_lane: index
        for index, raw_lane in enumerate(sorted(set(raw_lane_by_stableId.values())))
    }
    compact_ui_lane_by_raw_lane = {
        raw_lane: index
        for index, raw_lane in enumerate(sorted(set(raw_ui_lane_by_stableId.values())))
    }

    ordered_ui_resources = sorted(
        [resource for resource in resource_nodes if is_ui_resource(resource)],
        key=lambda resource: (
            compact_ui_lane_by_raw_lane[raw_ui_lane_by_stableId[resource['stableId']]],
            anchor_y_by_resource.get(resource['stableId'], FN_ROOT_Y),
            resource['stableId'],
        ),
    )
    for resource in ordered_ui_resources:
        lane = compact_ui_lane_by_raw_lane[raw_ui_lane_by_stableId[resource['stableId']]]
        _resource_width, resource_height = get_resource_size(resource)
        desired_center_y = anchor_y_by_resource.get(resource['stableId'], FN_ROOT_Y + (resource_height // 2))
        desired_y = desired_center_y - (resource_height // 2)
        used_y = used_y_by_ui_lane.setdefault(lane, set())
        while any(abs(desired_y - used) < resource_height + 20 for used in used_y):
            desired_y += resource_height + 20
        positions[resource['stableId']] = (left_base_x - (lane * RESOURCE_X_GAP), desired_y)
        used_y.add(desired_y)

    ordered_resources = sorted(
        [resource for resource in resource_nodes if not is_ui_resource(resource)],
        key=lambda resource: (
            compact_lane_by_raw_lane[raw_lane_by_stableId[resource['stableId']]],
            anchor_y_by_resource.get(resource['stableId'], FN_ROOT_Y),
            resource['stableId'],
        ),
    )
    for resource in ordered_resources:
        lane = compact_lane_by_raw_lane[raw_lane_by_stableId[resource['stableId']]]
        _resource_width, resource_height = get_resource_size(resource)
        desired_center_y = anchor_y_by_resource.get(resource['stableId'], FN_ROOT_Y + (resource_height // 2))
        desired_y = desired_center_y - (resource_height // 2)
        used_y = used_y_by_lane.setdefault(lane, set())
        while any(abs(desired_y - used) < resource_height + 20 for used in used_y):
            desired_y += resource_height + 20
        positions[resource['stableId']] = (base_x + (lane * RESOURCE_X_GAP), desired_y)
        used_y.add(desired_y)

    return positions


def get_edge_points(
    edge: dict[str, Any],
    bounds_by_node_id: dict[str, tuple[int, int, int, int]],
    flow_layout: dict[str, tuple[int, int]],
    rightmost_column_by_row: dict[int, int],
    routed_right_edge_targets: dict[str, str],
    routed_right_edge_lane_x: dict[tuple[str, str], int],
    routed_left_edge_modes: dict[tuple[str, str], str],
) -> list[tuple[int, int]] | None:
    if edge.get('edge_role') != 'control' or edge.get('from_kind') != 'Step' or edge.get('to_kind') != 'Step':
        return None

    source_layout = flow_layout.get(edge['from_id'])
    target_layout = flow_layout.get(edge['to_id'])
    source_bounds = bounds_by_node_id.get(edge['from_id'])
    target_bounds = bounds_by_node_id.get(edge['to_id'])
    if not source_layout or not target_layout or not source_bounds or not target_bounds:
        return None

    source_column, source_row = source_layout
    target_column, _target_row = target_layout

    source_x, source_y, source_width, source_height = source_bounds
    target_x, target_y, target_width, _target_height = target_bounds
    left_mode = routed_left_edge_modes.get((edge['from_id'], edge['to_id']))
    if left_mode and target_column < source_column:
        source_center_y = source_y + (source_height // 2)
        source_center_x = source_x + (source_width // 2)
        target_center_x = target_x + (target_width // 2)
        target_top_y = target_y - 24
        if left_mode == 'short':
            points = [
                (target_center_x, source_center_y),
                (target_center_x, target_top_y),
            ]
        else:
            points = [
                (source_center_x, target_top_y),
                (target_center_x, target_top_y),
            ]
        compact_points: list[tuple[int, int]] = []
        for point in points:
            if compact_points and compact_points[-1] == point:
                continue
            compact_points.append(point)
        return compact_points

    if target_column <= source_column:
        return None

    if is_branch_control_edge(edge):
        return None

    source_center_y = source_y + (source_height // 2)
    target_center_x = target_x + (target_width // 2)
    target_top_y = target_y - 20
    lane_x = routed_right_edge_lane_x.get((edge['from_id'], edge['to_id']), target_center_x)

    points = [
        (lane_x, source_center_y),
        (lane_x, target_top_y),
        (target_center_x, target_top_y),
    ]
    compact_points: list[tuple[int, int]] = []
    for point in points:
        if compact_points and compact_points[-1] == point:
            continue
        compact_points.append(point)
    return compact_points


def add_annotation_vertices(
    root_element: Element,
    annotations: dict[str, dict[str, Any]],
    bounds_by_node_id: dict[str, tuple[int, int, int, int]],
) -> None:
    index = 0
    for stableId, annotation in annotations.items():
        bounds = bounds_by_node_id.get(stableId)
        if not bounds:
            continue
        text = str(annotation.get('text') or '').strip()
        if not text:
            continue
        x, y, width, _height = bounds
        index += 1
        add_vertex(
            root_element,
            f'annotation{index}',
            shorten(text.replace('\n', '&#xa;'), 260),
            'rounded=1;whiteSpace=wrap;html=1;fillColor=#1f1f1f;strokeColor=#6c8ebf;fontColor=#d4d4d4;align=left;verticalAlign=top;spacing=8;',
            x + width + 24,
            y,
            260,
            110,
            {
                'stableId': stableId,
                'graphKind': 'annotation',
                'annotationUpdatedAt': annotation.get('updated_at'),
            },
        )


def build_drawio_xml(root: dict[str, Any], flow_nodes: list[dict[str, Any]], resource_nodes: list[dict[str, Any]], edges: list[dict[str, Any]], target_fns: list[dict[str, Any]], annotations: dict[str, dict[str, Any]], source: str, stage_label: str | None = None) -> str:
    flow_nodes, edges, collapsed_merge_node_ids = collapse_merge_nodes_for_render(flow_nodes, edges)
    mxfile = Element('mxfile', host='app.diagrams.net', modified='2026-04-30T00:00:00.000Z', agent='GitHub Copilot', version='24.7.17')
    diagram = SubElement(mxfile, 'diagram', id=sanitize_file_name(root['stableId']), name='Page-1')
    model = SubElement(
        diagram,
        'mxGraphModel',
        dx='1600',
        dy='1200',
        grid='1',
        gridSize='10',
        guides='1',
        tooltips='1',
        connect='1',
        arrows='1',
        fold='1',
        page='1',
        pageScale='1',
        pageWidth='1600',
        pageHeight='1200',
        math='0',
        shadow='0',
    )
    root_element = SubElement(model, 'root')
    SubElement(root_element, 'mxCell', id='0')
    SubElement(root_element, 'mxCell', id='1', parent='0')

    node_cell_ids: dict[str, str] = {root['stableId']: 'fnRoot'}
    branching_node_ids = {
        node['stableId']
        for node in flow_nodes
        if 'Branch' in set(node.get('labels') or []) or 'Switch' in set(node.get('labels') or [])
    }
    merge_node_ids = {
        node['stableId']
        for node in flow_nodes
        if 'Merge' in set(node.get('labels') or [])
    }
    side_call_step_kinds = collect_side_call_step_kinds(edges, resource_nodes, branching_node_ids)
    for node in flow_nodes:
        side = side_call_step_kinds.get(node.get('stableId'))
        if side:
            node['visual_side_call_kind'] = side
    apply_serial_branch_labels(flow_nodes, edges)
    layout_events: dict[str, list[str]] = {}
    flow_layout = build_flow_layout(root['stableId'], flow_nodes, edges, side_call_step_kinds, layout_events)
    bounds_by_node_id = build_flow_bounds(root, flow_nodes, flow_layout)
    row_entries: dict[int, list[str]] = {}
    for stableId, (_column, row) in flow_layout.items():
        row_entries.setdefault(row, []).append(stableId)
    for row in row_entries:
        row_entries[row] = sorted(row_entries[row])
    branch_exit_layout_by_edge_id = build_branch_exit_layout_by_edge_id(branching_node_ids, edges, bounds_by_node_id)
    enrich_target_fns_from_visual_resource_edges(target_fns, resource_nodes, edges)
    target_positions = build_target_fn_positions_with_bounds(target_fns, edges, flow_layout, bounds_by_node_id)

    root_x, root_y, root_width, root_height = bounds_by_node_id[root['stableId']]
    add_vertex(
        root_element,
        'fnRoot',
        build_root_label(root, stage_label),
        'rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontStyle=1;fontColor=#000000;' if stage_label else 'rounded=1;whiteSpace=wrap;html=1;fillColor=#9fbe99;strokeColor=#5f874f;fontStyle=1;fontColor=#000000;',
        root_x,
        root_y,
        root_width,
        root_height,
        {
            'stableId': root['stableId'],
            'graphKind': 'Stage' if stage_label else 'Fn',
            'layoutTrace': build_node_layout_trace(
                node_id=root['stableId'],
                graph_kind='Stage' if stage_label else 'Fn',
                label=stage_label or root.get('name') or 'Fn',
                bounds_by_node_id=bounds_by_node_id,
                flow_layout=flow_layout,
                edges=edges,
                root_stableId=root['stableId'],
                row_entries=row_entries,
                layout_events=layout_events,
            ),
            'collapsedMergeCount': len(collapsed_merge_node_ids),
                'link': build_graph_link(kind='Stage' if stage_label else 'Fn', stableId=root['stableId'], label=stage_label or root.get('name') or 'Fn'),
        },
    )

    for index, node in enumerate(sorted(flow_nodes, key=lambda item: (flow_layout[item['stableId']][1], flow_layout[item['stableId']][0], item['stableId'])), start=1):
        cell_id = f'flow{index}'
        node_cell_ids[node['stableId']] = cell_id
        x, y, width, height = bounds_by_node_id[node['stableId']]
        label = build_flow_label(node)
        graph_kind = get_flow_graph_kind(node)
        add_vertex(
            root_element,
            cell_id,
            label,
            get_flow_style(node),
            x,
            y,
            width,
            height,
            {
                'stableId': node['stableId'],
                'graphKind': graph_kind,
                'boundary': node.get('boundary'),
                'stepMemberStableIds': '\n'.join(node.get('step_member_stableIds') or []),
                'stepMemberCount': node.get('step_member_count'),
                'layoutTrace': build_node_layout_trace(
                    node_id=node['stableId'],
                    graph_kind=graph_kind,
                    label=label,
                    bounds_by_node_id=bounds_by_node_id,
                    flow_layout=flow_layout,
                    edges=edges,
                    root_stableId=root['stableId'],
                    row_entries=row_entries,
                    layout_events=layout_events,
                    node=node,
                ),
                'link': build_graph_link(kind=graph_kind, stableId=node['stableId'], label=label),
            },
        )

    for index, fn in enumerate(target_fns, start=1):
        cell_id = f'targetFn{index}'
        node_cell_ids[fn['stableId']] = cell_id
        x, y = target_positions[fn['stableId']]
        target_fn_height = compact_box_height(70)
        bounds_by_node_id[fn['stableId']] = (x, y, 220, target_fn_height)
        label = build_target_fn_label(fn)
        add_vertex(
            root_element,
            cell_id,
            label,
            get_target_fn_style(fn),
            x,
            y,
            220,
            target_fn_height,
            {
                'stableId': fn['stableId'],
                'graphKind': 'Fn',
                'layoutTrace': build_node_layout_trace(
                    node_id=fn['stableId'],
                    graph_kind='Fn',
                    label=label,
                    bounds_by_node_id=bounds_by_node_id,
                    flow_layout=flow_layout,
                    edges=edges,
                    root_stableId=root['stableId'],
                    row_entries=row_entries,
                    layout_events=layout_events,
                    fn=fn,
                ),
                'link': build_graph_link(kind='Fn', stableId=fn['stableId'], label=fn.get('name') or 'Fn'),
            },
        )

    resource_positions = build_resource_positions_with_bounds(resource_nodes, edges, bounds_by_node_id, target_fns)
    for index, resource in enumerate(resource_nodes, start=1):
        cell_id = f'resource{index}'
        node_cell_ids[resource['stableId']] = cell_id
        x, y = resource_positions.get(resource['stableId'], (FLOW_ORIGIN_X, FN_ROOT_Y + (index * 100)))
        width, height = get_resource_size(resource)
        bounds_by_node_id[resource['stableId']] = (x, y, width, height)
        label = build_resource_label(resource)
        add_vertex(
            root_element,
            cell_id,
            label,
            get_resource_style(resource),
            x,
            y,
            width,
            height,
            {
                'stableId': resource['stableId'],
                'graphKind': 'Resource',
                'layoutTrace': build_node_layout_trace(
                    node_id=resource['stableId'],
                    graph_kind='Resource',
                    label=label,
                    bounds_by_node_id=bounds_by_node_id,
                    flow_layout=flow_layout,
                    edges=edges,
                    root_stableId=root['stableId'],
                    row_entries=row_entries,
                    layout_events=layout_events,
                    resource=resource,
                ),
                'link': build_graph_link(
                    kind='Resource',
                    stableId=resource['stableId'],
                    label=resource.get('resource_cell_name') or resource.get('resource_name') or 'resource',
                ),
            },
        )

    rightmost_column_by_row: dict[int, int] = {}
    for node_id, (column, row) in flow_layout.items():
        current = rightmost_column_by_row.get(row)
        if current is None or column > current:
            rightmost_column_by_row[row] = column

    routed_right_edge_targets: dict[str, str] = {}
    for source_id in {edge['from_id'] for edge in edges if edge.get('edge_role') == 'control' and edge.get('from_kind') == 'Step' and edge.get('to_kind') == 'Step'}:
        source_layout = flow_layout.get(source_id)
        if not source_layout:
            continue

        candidate_edges = [
            edge for edge in edges
            if edge.get('edge_role') == 'control'
            and edge.get('from_kind') == 'Step'
            and edge.get('to_kind') == 'Step'
            and edge['from_id'] == source_id
        ]
        if len(candidate_edges) != 2:
            continue

        right_edge = max(
            candidate_edges,
            key=lambda edge: (flow_layout.get(edge['to_id'], (-1, -1))[0], flow_layout.get(edge['to_id'], (-1, -1))[1], edge['to_id']),
        )
        if flow_layout.get(right_edge['to_id'], (-1, -1))[0] > source_layout[0]:
            routed_right_edge_targets[source_id] = right_edge['to_id']

    routed_right_edge_lane_x: dict[tuple[str, str], int] = {}
    right_branch_lane_columns = compute_right_branch_lane_columns(flow_layout, edges)
    for (source_id, target_id), lane_column in right_branch_lane_columns.items():
        target_bounds = bounds_by_node_id.get(target_id)
        target_layout = flow_layout.get(target_id)
        if not target_bounds or not target_layout:
            continue
        target_x, _target_y, target_width, _target_height = target_bounds
        target_center_x = target_x + (target_width // 2)
        target_column, _target_row = target_layout
        routed_right_edge_lane_x[(source_id, target_id)] = target_center_x - ((target_column - lane_column) * FLOW_X_GAP)

    routed_left_edge_modes: dict[tuple[str, str], str] = {}
    left_edges_by_source: dict[str, list[tuple[int, int, str, dict[str, Any]]]] = {}
    for edge in edges:
        if not is_branch_control_edge(edge):
            continue
        source_layout = flow_layout.get(edge['from_id'])
        target_layout = flow_layout.get(edge['to_id'])
        if not source_layout or not target_layout:
            continue
        source_column, source_row = source_layout
        target_column, target_row = target_layout
        if target_column >= source_column:
            continue
        distance = abs(source_column - target_column) + abs(source_row - target_row)
        left_edges_by_source.setdefault(edge['from_id'], []).append((distance, target_row, edge['to_id'], edge))

    for _source_id, items in left_edges_by_source.items():
        if len(items) < 2:
            continue
        ordered_items = sorted(items, key=lambda item: (item[0], item[1], item[2]))
        for index, (_distance, _target_row, _target_id, edge) in enumerate(ordered_items):
            routed_left_edge_modes[(edge['from_id'], edge['to_id'])] = 'short' if index == 0 else 'long'

    step_outgoing_edges_by_source: dict[str, list[dict[str, Any]]] = {}
    step_node_ids = {
        node['stableId']
        for node in flow_nodes
        if 'CorridorStep' in set(node.get('labels') or [])
    }
    for edge in edges:
        if edge.get('from_id') in step_node_ids and edge.get('edge_role') != 'control':
            step_outgoing_edges_by_source.setdefault(edge['from_id'], []).append(edge)
    for source_id, items in step_outgoing_edges_by_source.items():
        items.sort(key=lambda item: (
            str(item.get('visual_source_step_id') or item.get('from_id')),
            str(item.get('edge_type') or ''),
            str(item.get('to_id') or ''),
        ))

    for index, edge in enumerate(sorted(edges, key=lambda item: (item['from_id'], item['edge_type'], item['to_id'])), start=1):
        source_id = node_cell_ids.get(edge['from_id'])
        target_id = node_cell_ids.get(edge['to_id'])
        if not source_id or not target_id:
            continue
        points = get_edge_points(
            edge,
            bounds_by_node_id,
            flow_layout,
            rightmost_column_by_row,
            routed_right_edge_targets,
            routed_right_edge_lane_x,
            routed_left_edge_modes,
        )
        style = get_edge_style(edge)
        source_bounds = bounds_by_node_id.get(edge['from_id'])
        target_bounds = bounds_by_node_id.get(edge['to_id'])
        if source_bounds and target_bounds:
            style = add_terminal_anchors_to_style(style, source_bounds, target_bounds)
        if edge.get('from_id') in block_outgoing_edges_by_source and edge.get('edge_role') != 'control':
            siblings = block_outgoing_edges_by_source[edge['from_id']]
            sibling_index = siblings.index(edge)
            source_side = get_edge_side(source_bounds, target_bounds, is_source=True) if source_bounds and target_bounds else 'right'
            exit_x, exit_y = get_distributed_anchor_coordinates(source_side, sibling_index, len(siblings), is_source=True)
            style_parts = parse_style(style)
            style_parts['exitX'] = str(exit_x)
            style_parts['exitY'] = str(exit_y)
            style_parts['exitDx'] = '0'
            style_parts['exitDy'] = '0'
            style_parts['exitPerimeter'] = '0'
            style = serialize_style(style_parts)
        branch_exit = branch_exit_layout_by_edge_id.get(id(edge))
        if branch_exit:
            exit_x, exit_y = branch_exit
            style_parts = parse_style(style)
            style_parts['exitX'] = str(exit_x)
            style_parts['exitY'] = str(exit_y)
            style_parts['exitDx'] = '0'
            style_parts['exitDy'] = '0'
            style_parts['exitPerimeter'] = '0'
            source_flow_layout = flow_layout.get(edge.get('from_id'))
            target_flow_layout = flow_layout.get(edge.get('to_id'))
            same_flow_row = bool(
                source_flow_layout
                and target_flow_layout
                and source_flow_layout[1] == target_flow_layout[1]
            )
            if exit_x >= 0.99 and same_flow_row:
                style_parts['entryX'] = '0.0'
                style_parts['entryY'] = '0.5'
                style_parts['entryDx'] = '0'
                style_parts['entryDy'] = '0'
                style_parts['entryPerimeter'] = '0'
            elif exit_x <= 0.01 and same_flow_row:
                style_parts['entryX'] = '1.0'
                style_parts['entryY'] = '0.5'
                style_parts['entryDx'] = '0'
                style_parts['entryDy'] = '0'
                style_parts['entryPerimeter'] = '0'
            elif source_bounds and target_bounds and get_node_center(target_bounds)[1] > get_node_center(source_bounds)[1]:
                style_parts['entryX'] = '0.5'
                style_parts['entryY'] = '0'
                style_parts['entryDx'] = '0'
                style_parts['entryDy'] = '0'
                style_parts['entryPerimeter'] = '0'
            style = serialize_style(style_parts)
        if edge.get('edge_role') == 'control' and (edge.get('edge_type') or edge.get('label')) == 'NEXT':
            style = force_next_edge_anchors(style)
        if edge.get('edge_role') == 'resource':
            edge_value = (edge.get('label') or edge['edge_type']).upper()
        elif edge.get('edge_type') in {'CALL', 'SUBSCRIBE'}:
            edge_value = edge['edge_type']
        else:
            edge_value = edge['edge_type']
        metadata_edge_type = edge.get('edge_type')
        add_edge(
            root_element,
            f'edge{index}',
            edge_value,
            style,
            source_id,
            target_id,
            points,
            {
                'stableId': edge.get('visual_source_step_id') or edge.get('from_id'),
                'targetStableId': edge.get('visual_target_step_id') or edge.get('to_id'),
                'visualSourceStableId': edge.get('from_id'),
                'visualTargetStableId': edge.get('to_id'),
                'graphKind': 'edge',
                'edgeType': metadata_edge_type,
                'synthetic': edge.get('synthetic'),
                'boundary': edge.get('boundary'),
                'link': build_graph_link(
                    kind='call-edge' if edge.get('edge_type') in {'CALL', 'SUBSCRIBE'} else 'resource-edge' if edge.get('edge_role') == 'resource' else 'flow-edge',
                    stableId=edge.get('visual_source_step_id') or edge.get('from_id'),
                    targetStableId=edge.get('visual_target_step_id') or edge.get('to_id'),
                    label=edge_value,
                    edge_type=metadata_edge_type,
                ),
            },
        )

    apply_postcheck_port_separation(root_element, bounds_by_node_id, node_cell_ids, branching_node_ids, merge_node_ids)
    add_annotation_vertices(root_element, annotations, bounds_by_node_id)

    return tostring(mxfile, encoding='unicode', xml_declaration=False)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    output_path = resolve_output_path(args)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    settings = load_settings()
    driver = GraphDatabase.driver(settings['uri'], auth=(settings['username'], settings['password']))
    try:
        with driver.session(database=settings['database']) as session:
            root, flow_nodes, resource_nodes, edges, target_fns, annotations = query_graph(
                session,
                args.fn_stableId,
                args.source,
                args.range_start,
                args.range_end,
            )
    finally:
        driver.close()

    xml_text = build_drawio_xml(root, flow_nodes, resource_nodes, edges, target_fns, annotations, args.source, args.stage_label)
    output_path.write_text(xml_text, encoding='utf-8')
    print(f'Wrote {len(flow_nodes)} flow nodes, {len(resource_nodes)} resources, {len(target_fns)} target Fns and {len(edges)} edges to {output_path}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))


