import {
  isFunctionFlowRenderedRelationship,
  isFunctionFlowVisibleRelationship,
} from './relationshipSemantics.js';

const COLLECTION_EDGE_TYPES = new Set([
  'ITERATES_VALUE',
  'PULLS_VALUE',
  'ITEM_AVAILABLE',
  'EXTRACTS_VALUE',
  'PASSES_VALUE',
  'YIELDS_VALUE',
  'EMITS_VALUE',
  'ACCUMULATES_VALUE',
  'DECIDES_VALUE',
  'PERFORMS_EFFECT',
  'ORDERS_VALUE',
  'REPEATS',
  'EXHAUSTED',
  'SHORT_CIRCUITS',
  'COMPLETES_VALUE',
]);

const CALLBACK_EDGE_TYPES = new Set([
  'ARROW',
  'NEXT',
  'TRUE',
  'FALSE',
  'VALUE',
  'XOR_JOIN',
  'RESULT',
  'ArgJoin',
]);

function hasLabel(node, label) {
  return (node?.labels || []).includes(label);
}

function prop(props, camel, snake = camel) {
  return props?.[camel] ?? props?.[snake];
}

function relativeAccessLabel(accessNode, receiverNode, fallback = 'value', receiverName = '', explicitText = '') {
  const accessText = String(
    explicitText
    || prop(accessNode?.props, 'relativeAccessText', 'relative_access_text')
    || accessNode?.props?.diaName
    || '',
  ).trim();
  const receiverText = String(receiverName || receiverNode?.props?.diaName || '').trim();
  if (receiverText && accessText.startsWith(receiverText)) {
    const relative = accessText.slice(receiverText.length).trim();
    if (relative) return relative;
  }
  const structuralRelative = accessText.replace(
    /^[A-Za-z_$][A-Za-z0-9_$]*(?=(?:\?\.|\[|\.))/u,
    '',
  );
  if (structuralRelative && structuralRelative !== accessText) return structuralRelative;
  return accessText || fallback;
}

function edgeKey(edge) {
  const producerOutcome = edge.props?.producerOutcome || edge.props?.producer_outcome || '';
  const base = `${edge.start}\u0000${edge.type}\u0000${edge.end}`;
  return producerOutcome ? `${base}\u0000${producerOutcome}` : base;
}

export function auditExtractedProjectionContract({
  semanticNodes,
  semanticEdges,
  inputGraph,
  projectedGraph,
}) {
  const extractedNodeIds = new Set(semanticNodes.map((node) => node.key));
  const extractedEdgeKeys = new Set(semanticEdges.map(edgeKey));
  const projectedNodeIds = new Set(projectedGraph.nodes.map((node) => node.id));
  const projectedEdgeKeys = new Set(projectedGraph.edges.map(edgeKey));
  const projectedRenderedEdgeKeys = new Set(projectedGraph.edges
    .filter(isFunctionFlowRenderedRelationship)
    .map(edgeKey));
  const inputNodeIds = new Set((inputGraph?.nodes || []).map((node) => node.id));
  const inputEdges = inputGraph?.edges || [];
  const allInputEdgeKeys = new Set(inputEdges.map(edgeKey));
  const inputEdgeKeys = new Set(inputEdges
    .filter((edge) => isFunctionFlowVisibleRelationship(edge.type))
    .map(edgeKey));
  return {
    projectedNodesMissingFromExtraction: [...projectedNodeIds]
      .filter((id) => !extractedNodeIds.has(id)),
    projectedEdgesMissingFromExtraction: [...projectedEdgeKeys]
      .filter((key) => !extractedEdgeKeys.has(key)),
    projectedNodesMissingFromInput: [...projectedNodeIds]
      .filter((id) => !inputNodeIds.has(id)),
    projectedEdgesMissingFromInput: [...projectedEdgeKeys]
      .filter((key) => !allInputEdgeKeys.has(key)),
    inputNodesDeletedByProjection: [...inputNodeIds]
      .filter((id) => !projectedNodeIds.has(id)),
    inputEdgesDeletedByProjection: [...inputEdgeKeys]
      .filter((key) => !projectedEdgeKeys.has(key)),
    inputEdgesMissingFromExtraction: [...inputEdgeKeys]
      .filter((key) => !extractedEdgeKeys.has(key)),
    inputCompositionEdgesHiddenByPolicy: inputEdges
      .filter((edge) => (
        !isFunctionFlowVisibleRelationship(edge.type)
        && !projectedRenderedEdgeKeys.has(edgeKey(edge))
      ))
      .map(edgeKey),
    extractedHiddenNodes: semanticNodes
      .filter((node) => prop(node.props, 'renderHidden', 'render_hidden') === true)
      .map((node) => node.key),
    extractedHiddenEdges: semanticEdges
      .filter((edge) => prop(edge.props, 'renderHidden', 'render_hidden') === true)
      .map(edgeKey),
  };
}

function nodePosition(node) {
  const x = Number(node?.props?.displayX);
  const y = Number(node?.props?.displayY);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

function semanticNodeAsRendered(node, x, y, extraLabels = [], extraProps = {}) {
  const terminalMarker = extraProps.hybridVisualRole === 'exhausted-marker';
  return {
    id: node.key,
    labels: [...new Set([...(node.labels || []), ...extraLabels])],
    props: {
      ...(node.props || {}),
      ...extraProps,
      ...(terminalMarker ? {
        renderPartsJson: '[]',
        render_parts_json: '[]',
        renderPartsLayout: 'single',
        render_parts_layout: 'single',
        graphMethodVisual: undefined,
        suppressObjectMethodVisual: true,
      } : {}),
      renderHidden: false,
      displayX: x,
      displayY: y,
      layoutTrace: [
        node.props?.layoutTrace,
        'hybrid-flow projection from explicit execution primitive facts',
      ].filter(Boolean).join('; '),
    },
  };
}

function withoutLabels(node, labels) {
  const excluded = new Set(labels);
  return {
    ...node,
    labels: (node.labels || []).filter((label) => !excluded.has(label)),
  };
}

function projectionEdge(type, start, end, props = {}) {
  return {
    id: `hybrid:${type}:${start}->${end}`,
    start,
    end,
    type,
    props: {
      stableId: start,
      targetStableId: end,
      semanticProjection: 'hybrid-flow',
      ...props,
    },
  };
}

function expressionMosaicPartKind(node) {
  return prop(node?.props, 'expressionMosaicPartKind', 'expression_mosaic_part_kind') || '';
}

function compactExpressionMosaicWidth(node) {
  const kind = expressionMosaicPartKind(node);
  const label = String(node?.props?.diaName || node?.props?.dia_name || node?.props?.label || '');
  if (kind === 'punctuation') return 26;
  if (kind === 'operator') return 38;
  return Math.max(34, Math.min(180, 18 + label.length * 7));
}

function projectExpressionMosaic({
  semanticNodes,
  ownerStableId,
  projected,
  startX,
  rowY,
  operatorRole = 'operator',
  receiverRole = 'expression-receiver',
}) {
  const allMembers = semanticNodes.filter((node) => (
    prop(node.props, 'expressionMosaicOwnerStableId', 'expression_mosaic_owner_stable_id') === ownerStableId
  ));
  const backing = allMembers.find((node) => expressionMosaicPartKind(node) === 'receiver');
  const rowMembers = allMembers
    .filter((node) => expressionMosaicPartKind(node) !== 'receiver')
    .sort((left, right) => (
      Number(prop(left.props, 'expressionMosaicOrder', 'expression_mosaic_order') || 0)
      - Number(prop(right.props, 'expressionMosaicOrder', 'expression_mosaic_order') || 0)
    ));
  if (rowMembers.length < 3) return { nodes: [], rowMembers: [], backing: null };

  const widths = rowMembers.map(compactExpressionMosaicWidth);
  const centers = [startX];
  for (let index = 1; index < rowMembers.length; index += 1) {
    centers[index] = centers[index - 1] + (widths[index - 1] + widths[index]) / 520;
  }
  const nodes = rowMembers.map((member, index) => projected(
    member.key === ownerStableId ? operatorRole : `expression-part-${index}`,
    member,
    centers[index],
    rowY,
    ['HybridExpressionPart'],
    {
      displayWidth: widths[index],
      displayHeight: 30,
      hybridVisualRole: 'expression-mosaic-part',
    },
  ));
  if (backing) {
    nodes.push(projected(
      receiverRole,
      backing,
      (centers[0] + centers.at(-1)) / 2,
      rowY - 0.42,
      ['HybridReceiver'],
      {
        displayWidth: Math.max(96, compactExpressionMosaicWidth(backing)),
        displayHeight: 34,
        hybridVisualRole: 'expression-mosaic-backing',
        hybridOverlayOwnerStableId: ownerStableId,
        hybridOverlayKind: 'receiver-above-expression',
      },
    ));
  }
  return { nodes: nodes.filter(Boolean), rowMembers, backing };
}

export function projectHybridCoordinateEdges({ nodes, edges, semanticEdges }) {
  const nodeById = new Map(nodes.map((node) => [node.key, node]));
  const projected = [...edges];
  const visibleKeys = new Set(projected.map((edge) => (
    `${edge.type}\u0000${edge.start}\u0000${edge.end}`
  )));
  for (const semanticEdge of semanticEdges) {
    const source = nodeById.get(semanticEdge.start);
    const target = nodeById.get(semanticEdge.end);
    const isExtractedSubStepTransition = ['NEXT', 'ASYNC', 'CATCH'].includes(semanticEdge.type)
      && source
      && target
      && [source, target].some((node) => (
        hasLabel(node, 'SubStep')
        || hasLabel(node, 'SubStepMember')
        || hasLabel(node, 'SubStepAttachment')
      ));
    if (isExtractedSubStepTransition) {
      const key = `${semanticEdge.type}\u0000${semanticEdge.start}\u0000${semanticEdge.end}`;
      if (!visibleKeys.has(key)) {
        projected.push(projectionEdge(semanticEdge.type, semanticEdge.start, semanticEdge.end, {
          ...(semanticEdge.props || {}),
          renderHidden: false,
          semanticProjection: 'sub-step-transition',
        }));
        visibleKeys.add(key);
      }
      continue;
    }
    const producerRouteRole = prop(
      semanticEdge.props,
      'producerRouteRole',
      'producer_route_role',
    );
    const isProducerReturn = ['ASSIGNS_VALUE', 'YIELDS_VALUE'].includes(semanticEdge.type)
      && ['return-top', 'return-bottom'].includes(producerRouteRole);
    if (isProducerReturn && nodeById.has(semanticEdge.start) && target) {
      const key = `${semanticEdge.type}\u0000${semanticEdge.start}\u0000${semanticEdge.end}`;
      if (!visibleKeys.has(key)) {
        projected.push(projectionEdge(semanticEdge.type, semanticEdge.start, semanticEdge.end, {
          ...(semanticEdge.props || {}),
          renderHidden: false,
        }));
        visibleKeys.add(key);
      }
      continue;
    }
    const isContainerValueReturn = ['PASSES_VALUE', 'YIELDS_VALUE'].includes(semanticEdge.type)
      && hasLabel(target, 'ContainerMethod')
      && (
        hasLabel(target, 'Set')
        || prop(semanticEdge.props, 'protocolRole', 'protocol_role') === 'assignment-return'
      );
    if (isContainerValueReturn && nodeById.has(semanticEdge.start)) {
      const key = `${semanticEdge.type}\u0000${semanticEdge.start}\u0000${semanticEdge.end}`;
      if (!visibleKeys.has(key)) {
        projected.push(projectionEdge(semanticEdge.type, semanticEdge.start, semanticEdge.end, {
          ...(semanticEdge.props || {}),
          renderHidden: false,
          semanticProjection: 'container-value-return',
        }));
        visibleKeys.add(key);
      }
      continue;
    }
    const isCollectionAssignmentReturn = semanticEdge.type === 'TRUE'
      && prop(semanticEdge.props, 'protocolRole', 'protocol_role') === 'assignment-return'
      && hasLabel(target, 'ContainerMethod')
      && hasLabel(target, 'Set');
    if (isCollectionAssignmentReturn && nodeById.has(semanticEdge.start)) {
      const key = `${semanticEdge.type}\u0000${semanticEdge.start}\u0000${semanticEdge.end}`;
      if (!visibleKeys.has(key)) {
        projected.push(projectionEdge(semanticEdge.type, semanticEdge.start, semanticEdge.end, {
          ...(semanticEdge.props || {}),
          renderHidden: false,
          semanticProjection: 'collection-assignment-return',
        }));
        visibleKeys.add(key);
      }
      continue;
    }
    const isCallResultContinuation = semanticEdge.type === 'RESULT'
      && hasLabel(source, 'FnVisualProxy')
      && hasLabel(target, 'Value')
      && hasLabel(target, 'Result');
    if (isCallResultContinuation) {
      const key = `${semanticEdge.type}\u0000${semanticEdge.start}\u0000${semanticEdge.end}`;
      if (!visibleKeys.has(key)) {
        projected.push(projectionEdge(semanticEdge.type, semanticEdge.start, semanticEdge.end, {
          ...(semanticEdge.props || {}),
          renderHidden: false,
          semanticProjection: 'call-result-continuation',
        }));
        visibleKeys.add(key);
      }
      continue;
    }
    if (!hasLabel(target, 'FnVisualProxy')) continue;
    if (!nodeById.has(semanticEdge.start)) continue;
    const isInvocation = semanticEdge.type === 'INVOKES';
    const isCallFamilyClosure = semanticEdge.type === 'ArgJoin'
      || semanticEdge.type === 'FieldJoin';
    if (!isInvocation && !isCallFamilyClosure) continue;
    const key = `${semanticEdge.type}\u0000${semanticEdge.start}\u0000${semanticEdge.end}`;
    if (visibleKeys.has(key)) continue;
    projected.push(projectionEdge(semanticEdge.type, semanticEdge.start, semanticEdge.end, {
      ...(semanticEdge.props || {}),
      displayLabel: '',
      renderHidden: isInvocation,
      semanticProjection: 'call-boundary',
    }));
    visibleKeys.add(key);
  }

  const incomingByTarget = new Map();
  for (const edge of semanticEdges) {
    if (!incomingByTarget.has(edge.end)) incomingByTarget.set(edge.end, []);
    incomingByTarget.get(edge.end).push(edge);
  }
  const producerReturns = semanticEdges.filter((edge) => (
    ['ASSIGNS_VALUE', 'YIELDS_VALUE'].includes(edge.type)
    && ['return-top', 'return-bottom'].includes(prop(
      edge.props,
      'producerRouteRole',
      'producer_route_role',
    ))
  ));
  const upstreamPriority = ['ArgJoin', 'FieldJoin', 'NEXT', 'RESULT'];
  for (const producerReturn of producerReturns) {
    const assignment = nodeById.get(producerReturn.end);
    const producerStartStableId = String(prop(
      assignment?.props,
      'producerStartStableId',
      'producer_start_stable_id',
    ) || '');
    if (!producerStartStableId) continue;
    let cursor = producerReturn.start;
    const visited = new Set();
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const cursorNode = nodeById.get(cursor);
      if (
        cursor === producerStartStableId
        || (
          String(prop(cursorNode?.props, 'sourceCallStableId', 'source_call_stable_id') || '') === producerStartStableId
          && prop(cursorNode?.props, 'callBoundaryRole', 'call_boundary_role') === 'close'
        )
      ) break;
      const incoming = (incomingByTarget.get(cursor) || [])
        .filter((edge) => upstreamPriority.includes(edge.type))
        .sort((left, right) => upstreamPriority.indexOf(left.type) - upstreamPriority.indexOf(right.type))[0];
      if (!incoming || !nodeById.has(incoming.start)) break;
      const key = `${incoming.type}\u0000${incoming.start}\u0000${incoming.end}`;
      if (!visibleKeys.has(key)) {
        projected.push(projectionEdge(incoming.type, incoming.start, incoming.end, {
          ...(incoming.props || {}),
          renderHidden: false,
        }));
        visibleKeys.add(key);
      }
      cursor = incoming.start;
    }
  }
  return projected;
}

function addGraphBackedMethodMetadata(renderedNodes, semanticNodes, semanticEdges) {
  const renderedById = new Map(renderedNodes.map((node) => [node.id, node]));
  const semanticById = new Map(semanticNodes.map((node) => [node.key, node]));
  const outgoingBySource = new Map();
  for (const edge of semanticEdges) {
    if (!outgoingBySource.has(edge.start)) outgoingBySource.set(edge.start, []);
    outgoingBySource.get(edge.start).push(edge);
  }

  for (const invokes of semanticEdges.filter((edge) => edge.type === 'INVOKES')) {
    const call = renderedById.get(invokes.start);
    const method = semanticById.get(invokes.end);
    if (!call || !method) continue;
    const onReceiver = (outgoingBySource.get(invokes.end) || [])
      .find((edge) => edge.type === 'ON_RECEIVER');
    const receiver = onReceiver && semanticById.get(onReceiver.end);
    if (!receiver) continue;
    call.props = {
      ...call.props,
      graphMethodVisual: {
        receiver: receiver.props?.diaName
          || receiver.props?.operation_subject_text
          || receiver.props?.label
          || receiver.key,
        receiverStableId: receiver.key,
        receiverSourceStableId: prop(receiver.props, 'canonicalStableId', 'canonical_stable_id') || '',
        receiverLabels: receiver.labels || [],
        method: method.props?.diaName
          || method.props?.operation_subject_text
          || method.props?.name
          || method.props?.label
          || 'method',
        methodStableId: method.key,
        methodSourceStableId: prop(method.props, 'canonicalStableId', 'canonical_stable_id')
          || prop(method.props, 'calleeStableId', 'callee_stable_id')
          || '',
      },
    };
  }
}

function collectCallbackProjectionIds(callbackId, renderedEdges, renderedById, stepId) {
  const result = new Set();
  const queue = [callbackId];
  while (queue.length && result.size < 200) {
    const current = queue.shift();
    if (!current || result.has(current)) continue;
    const node = renderedById.get(current);
    if (!node) continue;
    const currentStep = String(node.props?.parentStepStableId || '').trim();
    if (stepId && currentStep && currentStep !== stepId) continue;
    result.add(current);
    for (const edge of renderedEdges) {
      if (edge.start !== current || !CALLBACK_EDGE_TYPES.has(edge.type)) continue;
      if (!result.has(edge.end)) queue.push(edge.end);
    }
  }
  return result;
}

function predicateOperandFacts(branch, semanticNodes, semanticEdges) {
  const inputs = semanticEdges
    .filter((edge) => (
      edge.end === branch.key
      && edge.props?.semantic_expansion === 'operand-evaluation'
      && (edge.type === 'READS_VALUE' || edge.type === 'PRODUCES_VALUE')
    ))
    .sort((left, right) => (
      Number(left.props?.sequence_order ?? Number.MAX_SAFE_INTEGER)
      - Number(right.props?.sequence_order ?? Number.MAX_SAFE_INTEGER)
    ));
  const byId = new Map(semanticNodes.map((node) => [node.key, node]));
  return inputs.map((edge) => ({
    edge,
    node: byId.get(edge.start),
  })).filter((entry) => entry.node);
}

function projectPredicateCallback({
  callback,
  callbackIds,
  semanticNodes,
  semanticEdges,
  renderedById,
  axisX,
  headerY,
}) {
  const branches = semanticNodes
    .filter((node) => (
      (
        callbackIds.has(node.key)
        || prop(node.props, 'sequenceOwnerStableId', 'sequence_owner_stable_id') === callback.key
      )
      && hasLabel(node, 'Branch')
      && prop(node.props, 'semanticExpansion', 'semantic_expansion') === 'operand-evaluation'
    ))
    .sort((left, right) => (
      Number(left.props?.operation_index ?? Number.MAX_SAFE_INTEGER)
      - Number(right.props?.operation_index ?? Number.MAX_SAFE_INTEGER)
    ));
  if (!branches.length) return null;

  const projectedNodes = [];
  const projectedEdges = [];
  const projectedEntryIds = [];
  const branchIds = new Set(branches.map((branch) => branch.key));
  let maxX = axisX;
  let maxY = headerY;
  branches.forEach((branch, index) => {
    const directCallMosaic = prop(branch.props, 'callMosaicRole', 'call_mosaic_role') === 'open';
    const directCallArguments = directCallMosaic
      ? semanticNodes.filter((node) => (
          prop(node.props, 'callMosaicOwnerStableId', 'call_mosaic_owner_stable_id') === branch.key
          && prop(node.props, 'callMosaicRole', 'call_mosaic_role') === 'argument'
        ))
      : [];
    const directCallClose = directCallMosaic
      ? semanticNodes.find((node) => (
          prop(node.props, 'callMosaicOwnerStableId', 'call_mosaic_owner_stable_id') === branch.key
          && prop(node.props, 'callMosaicRole', 'call_mosaic_role') === 'close'
        ))
      : null;
    const facts = predicateOperandFacts(branch, semanticNodes, semanticEdges);
    const operationCode = prop(branch.props, 'operationCode', 'operation_code');
    const operator = prop(branch.props, 'operationValueText', 'operation_value_text');
    const callFact = facts.find((entry) => (
      ['Call', 'Request', 'Op'].some((label) => hasLabel(entry.node, label))
    ))?.node;
    const callPeerStableId = prop(callFact?.props, 'callBoundaryPeerStableId', 'call_boundary_peer_stable_id');
    const call = directCallMosaic
      ? branch
      : prop(callFact?.props, 'callBoundaryRole', 'call_boundary_role') === 'close'
      ? semanticNodes.find((node) => node.key === callPeerStableId) || callFact
      : callFact;
    const x = axisX + 1.35 + (index % 2 ? 1.25 : 0);
    const y = headerY + 1.0 + index * 0.62;
    const currentSource = directCallClose || branch;
    const current = renderedById.get(currentSource.key)
      || semanticNodeAsRendered(currentSource, x, y);
    const diaName = operationCode === 'boolean-call'
      ? `${prop(call?.props, 'operationCalleeText', 'operation_callee_text')
        || prop(branch.props, 'operationCalleeText', 'operation_callee_text')
        || branch.props?.diaName
        || 'call'}()`
      : operator
        ? operator
        : branch.props?.diaName;
    const callPredicate = operationCode === 'boolean-call' && call;
    const callArgumentEdges = callPredicate
      ? semanticEdges.filter((edge) => edge.start === call.key && edge.type === 'ARG')
      : [];
    const callArguments = directCallMosaic
      ? directCallArguments
      : callArgumentEdges
          .map((edge) => semanticNodes.find((node) => node.key === edge.end))
          .filter(Boolean);
    const callHasArguments = Boolean(
      prop(call?.props, 'callHasArguments', 'call_has_arguments')
      ?? callArguments.length,
    );
    const closing = {
      ...current,
      labels: [...new Set([
        ...(current.labels || []),
        'HybridPredicateStage',
        ...(operationCode === 'boolean-call' ? ['HybridCallPredicate'] : ['HybridExpressionPredicate']),
      ])],
      props: {
        ...current.props,
        diaName,
        displayX: x,
        displayY: y,
        displayWidth: directCallMosaic ? 64 : operationCode === 'boolean-call' ? 138 : 126,
        displayHeight: 34,
        hybridVisualRole: 'predicate-stage',
        ...(directCallMosaic ? { skipHorizontalCompaction: true } : {}),
        semanticOperandStableIds: facts.map((entry) => entry.node.key),
        ...(callPredicate ? {
          callBoundaryDesign: 'split',
          callBoundaryRole: 'close',
          callBoundaryPeerStableId: call.key,
          callHasArguments,
          callPredicate: true,
          suppressObjectMethodVisual: true,
        } : {}),
      },
    };
    if (callPredicate) {
      const soleMosaicArgument = directCallMosaic && callArguments.length === 1
        ? callArguments[0]
        : null;
      const openingX = soleMosaicArgument ? x - 0.85 : x - (callHasArguments ? 1.04 : 0.52);
      const callName = prop(call.props, 'operationCalleeText', 'operation_callee_text')
        || prop(branch.props, 'operationCalleeText', 'operation_callee_text')
        || call.props?.diaName
        || 'call';
      const opening = semanticNodeAsRendered(call, openingX, y, [
        'Branch',
        'Operand',
        'HybridPredicateStage',
        'HybridCallPredicate',
      ], {
        diaName: String(callName).replace(/\([^]*$/u, '').split('.').at(-1),
        displayWidth: soleMosaicArgument ? 104 : 138,
        displayHeight: 34,
        hybridVisualRole: 'predicate-call-open',
        callBoundaryDesign: 'split',
        callBoundaryRole: 'open',
        callBoundaryPeerStableId: closing.id,
        callHasArguments,
        callPredicate: true,
        suppressObjectMethodVisual: true,
        ...(soleMosaicArgument ? { skipHorizontalCompaction: true } : {}),
        renderHidden: false,
      });
      projectedNodes.push(opening);
      projectedEntryIds.push(opening.id);
      if (soleMosaicArgument) {
        const argumentVisual = semanticNodeAsRendered(soleMosaicArgument, x - 0.385, y, [
          'HybridOperandOccurrence',
          ...(hasLabel(soleMosaicArgument, 'Literal') ? ['Literal'] : []),
        ], {
          displayWidth: 112,
          displayHeight: 34,
          hybridVisualRole: 'predicate-call-argument',
          splitCallBoundary: 'middle',
          callMosaicOwnerStableId: branch.key,
          callMosaicRole: 'argument',
          skipHorizontalCompaction: true,
          renderHidden: false,
        });
        projectedNodes.push(argumentVisual);
      } else if (!callArguments.length) {
        projectedEdges.push(projectionEdge('ArgJoin', opening.id, closing.id, {
          label: '', displayLabel: '', flow_layer: 'data', sourcePort: 'right', targetPort: 'left',
        }));
      } else {
        callArguments.forEach((argument, argumentIndex) => {
          const argumentY = y + (argumentIndex - (callArguments.length - 1) / 2) * 0.34;
          const argumentVisual = semanticNodeAsRendered(argument, x - 0.52, argumentY, ['HybridOperandOccurrence'], {
            displayWidth: 82,
            displayHeight: 28,
            hybridVisualRole: 'operand-occurrence',
            renderHidden: false,
          });
          projectedNodes.push(argumentVisual);
          projectedEdges.push(
            projectionEdge('ARG', opening.id, argumentVisual.id, {
              label: '', displayLabel: '', argumentIndex, flow_layer: 'data', sourcePort: 'right', targetPort: 'left',
            }),
            projectionEdge('ArgJoin', argumentVisual.id, closing.id, {
              label: '', displayLabel: '', argumentIndex, flow_layer: 'data', sourcePort: 'right', targetPort: 'left',
            }),
          );
        });
      }
    } else {
      projectedEntryIds.push(closing.id);
    }
    projectedNodes.push(closing);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  });

  for (const edge of semanticEdges) {
    if (edge.type !== 'TRUE' && edge.type !== 'FALSE') continue;
    const source = semanticNodes.find((node) => node.key === edge.start);
    const sourceOwner = prop(source?.props, 'callMosaicOwnerStableId', 'call_mosaic_owner_stable_id');
    const sourceBranchId = branchIds.has(edge.start)
      ? edge.start
      : branchIds.has(sourceOwner)
        ? sourceOwner
        : null;
    if (!sourceBranchId || !branchIds.has(edge.end)) continue;
    const sourceRole = prop(source?.props, 'callMosaicRole', 'call_mosaic_role');
    projectedEdges.push(projectionEdge(edge.type, edge.start, edge.end, {
      label: edge.props?.label || edge.type.toLowerCase(),
      displayLabel: edge.props?.display_label || edge.type,
      flow_layer: 'control',
      sourcePort: sourceRole === 'close' ? 'right' : sourceRole === 'open' ? 'bottom' : 'right',
      targetPort: sourceRole === 'open' ? 'top' : 'left',
      sourcePortCandidates: [sourceRole === 'close' ? 'right' : sourceRole === 'open' ? 'bottom' : 'right'],
      targetPortCandidates: [sourceRole === 'open' ? 'top' : 'left'],
      lockPortCandidates: true,
      semanticProjection: 'hybrid-flow',
    }));
  }

  const hiddenIds = new Set([callback.key]);
  for (const id of callbackIds) {
    const node = renderedById.get(id);
    if (!node || branchIds.has(id)) continue;
    if (
      hasLabel(node, 'ValueOutcome')
      || hasLabel(node, 'CallbackResult')
      || hasLabel(node, 'OperandJoin')
      || hasLabel(node, 'Arg')
      || hasLabel(node, 'FnVisualProxy')
    ) {
      hiddenIds.add(id);
    }
  }
  projectedNodes
    .filter((node) => node.props?.hybridVisualRole === 'predicate-call-open')
    .forEach((node) => hiddenIds.add(node.id));

  return {
    projectedNodes,
    hiddenIds,
    branchIds,
    maxX,
    maxY,
    projectedEdges,
    firstBranchId: projectedEntryIds[0] || projectedNodes[0]?.id,
  };
}

function protocolEntityByRole(scenario) {
  return new Map((scenario?.entities || []).map((entity) => [entity.role, entity]));
}

function protocolEntityAsSemanticNode(entity) {
  if (!entity?.actualStableId) return null;
  return {
    key: entity.actualStableId,
    labels: [...(entity.labelsAll || [])],
    props: {
      ...(entity.properties || {}),
      protocolSynthetic: true,
      protocolRole: entity.role,
    },
  };
}

function graphBackedMethodVisual(call, semanticById, semanticEdges) {
  const invokes = semanticEdges.find((edge) => (
    edge.start === call?.key && edge.type === 'INVOKES'
  ));
  const method = invokes && semanticById.get(invokes.end);
  const onReceiver = method && semanticEdges.find((edge) => (
    edge.start === method.key && edge.type === 'ON_RECEIVER'
  ));
  const receiver = onReceiver && semanticById.get(onReceiver.end);
  if (!method || !receiver) return null;
  return {
    receiver: receiver.props?.diaName
      || receiver.props?.operation_subject_text
      || receiver.props?.label
      || receiver.key,
    receiverStableId: receiver.key,
    receiverSourceStableId: prop(receiver.props, 'canonicalStableId', 'canonical_stable_id') || '',
    receiverLabels: receiver.labels || [],
    method: method.props?.diaName
      || method.props?.operation_subject_text
      || method.props?.name
      || method.props?.label
      || prop(call.props, 'operationCalleeText', 'operation_callee_text')
      || 'method',
    methodStableId: method.key,
    methodSourceStableId: prop(method.props, 'canonicalStableId', 'canonical_stable_id')
      || prop(method.props, 'calleeStableId', 'callee_stable_id')
      || '',
  };
}

function predicateBranchForNode(node, semanticById, semanticEdges) {
  if (hasLabel(node, 'Branch')) return node;
  const produces = semanticEdges.find((edge) => (
    edge.start === node?.key
    && edge.type === 'PRODUCES_VALUE'
    && hasLabel(semanticById.get(edge.end), 'Branch')
  ));
  return produces && semanticById.get(produces.end);
}

function predicateText(node, semanticNodes, semanticEdges) {
  if (!node) return 'predicate';
  if (!hasLabel(node, 'Branch')) {
    const callee = prop(node.props, 'operationCalleeText', 'operation_callee_text')
      || node.props?.diaName
      || node.props?.label
      || 'predicate';
    const bare = String(callee).replace(/\([^]*$/u, '').split('.').at(-1);
    return `${bare}()`;
  }
  const facts = predicateOperandFacts(node, semanticNodes, semanticEdges);
  const left = facts.find((entry) => entry.edge.props?.label === 'left')?.node
    || facts.find((entry) => entry.edge.props?.label === 'arg0')?.node
    || facts.find((entry) => entry.edge.props?.label === 'result')?.node;
  const right = facts.find((entry) => entry.edge.props?.label === 'right')?.node;
  const operator = prop(node.props, 'operationValueText', 'operation_value_text')
    || node.props?.label
    || '';
  const leftText = left?.props?.diaName
    || left?.props?.operation_subject_text
    || left?.props?.operation_callee_text
    || '';
  const rightText = right?.props?.diaName
    || right?.props?.operation_subject_text
    || right?.props?.operation_value_text
    || '';
  return [leftText, operator, rightText].filter(Boolean).join(' ').trim()
    || node.props?.condition_raw
    || node.props?.diaName
    || 'predicate';
}

function projectCollectionAccumulateProtocol({
  loop,
  scenario,
  semanticNodes,
  renderedNodes,
  renderedEdges,
}) {
  const semanticById = new Map(semanticNodes.map((node) => [node.key, node]));
  const renderedById = new Map(renderedNodes.map((node) => [node.id, node]));
  const entityByRole = protocolEntityByRole(scenario);
  const semanticForRole = (role) => {
    const entity = entityByRole.get(role);
    return semanticById.get(entity?.actualStableId) || protocolEntityAsSemanticNode(entity);
  };
  const renderedForRole = (role) => renderedById.get(
    entityByRole.get(role)?.actualStableId,
  );
  const target = semanticForRole('target');
  const targetRendered = renderedForRole('target');
  const anchorPosition = nodePosition(targetRendered);
  const lane = (scenario.lanes || []).find((candidate) => (
    candidate.owner === 'iterator'
    && candidate.direction === 'vertical'
    && candidate.visualKind === 'functional-column'
  ));
  if (!target || !targetRendered || !anchorPosition || !lane) return null;

  const requiredRoles = [
    'seed',
    'receiver',
    'call',
    'iterator',
    'pull',
    'pulledCandidate',
    'item',
    'predicateSource',
    'contentAccess',
    'coalesce',
    'contribution',
    'accumulate',
    'exhausted',
  ];
  const roleNode = new Map(requiredRoles.map((role) => [role, semanticForRole(role)]));
  if (requiredRoles.some((role) => !roleNode.get(role))) return null;

  const stepId = String(
    target?.props?.parentStepStableId
    || loop.props?.parentStepStableId
    || '',
  ).trim();
  const compositionId = `protocol:${scenario.scenarioId}`;
  const targetX = anchorPosition.x;
  const headerY = anchorPosition.y;
  const seedX = targetX + 0.8;
  const axisX = targetX + 1.62;
  const sourceX = targetX + 2.48;
  const itemX = targetX + 3.25;
  const predicateSourceX = targetX + 4.48;
  const candidateY = headerY + 0.62;
  const expressionY = headerY + 1.28;
  const contributionY = headerY + 1.92;
  const axisTopY = headerY + 0.12;
  const axisBottomY = expressionY + 0.2;
  const axisCenterY = (axisTopY + axisBottomY) / 2;
  const axisHeight = Math.max(126, Math.round((axisBottomY - axisTopY) * 130));
  const columnRightPortAt = (stageY) => {
    const span = Math.max(0.01, axisBottomY - axisTopY);
    const ratio = Math.max(0.04, Math.min(0.96, (stageY - axisTopY) / span));
    return `right-${Math.round(ratio * 100)}`;
  };

  function projected(role, node, x, y, extraLabels = [], extraProps = {}) {
    if (!node) return null;
    const existing = renderedById.get(node.key);
    const base = existing || semanticNodeAsRendered(node, x, y);
    const entity = entityByRole.get(role);
    const visualOccurrenceId = extraProps.hybridVisualOccurrenceId || base.id;
    return {
      ...base,
      id: visualOccurrenceId,
      label: extraProps.diaName || base.label,
      labels: [...new Set([
        ...(base.labels || []),
        ...(entity?.labelsAll || []),
        ...extraLabels,
      ])],
      props: {
        ...(base.props || {}),
        ...(entity?.properties || {}),
        ...extraProps,
        parentStepStableId: stepId,
        displayX: x,
        displayY: y,
        hybridCompositionId: compositionId,
        protocolScenarioId: scenario.scenarioId,
        protocolKind: scenario.protocol,
        protocolRole: role,
        renderHidden: extraProps.renderHidden ?? false,
        skipHorizontalCompaction: true,
        layoutTrace: [
          base.props?.layoutTrace,
          `execution protocol composition ${scenario.scenarioId}:${role}`,
        ].filter(Boolean).join('; '),
      },
    };
  }

  const seed = roleNode.get('seed');
  const receiver = roleNode.get('receiver');
  const header = roleNode.get('call');
  const iterator = roleNode.get('iterator');
  const pull = roleNode.get('pull');
  const pulledCandidate = roleNode.get('pulledCandidate');
  const item = roleNode.get('item');
  const predicateSource = roleNode.get('predicateSource');
  const contentAccess = roleNode.get('contentAccess');
  const coalesce = roleNode.get('coalesce');
  const contribution = roleNode.get('contribution');
  const accumulate = roleNode.get('accumulate');
  const exhausted = roleNode.get('exhausted');
  const predicateSourceName = entityByRole.get('predicateSource')?.properties?.diaName
    || predicateSource.props?.diaName
    || 'pastedContents';
  const contentAccessLabel = relativeAccessLabel(
    contentAccess,
    predicateSource,
    'value',
    predicateSourceName,
    prop(contentAccess.props, 'relativeAccessText', 'relative_access_text')
      || entityByRole.get('contentAccess')?.properties?.relativeAccessText,
  );
  const expressionMosaic = projectExpressionMosaic({
    semanticNodes,
    ownerStableId: coalesce.key,
    projected,
    startX: predicateSourceX,
    rowY: expressionY,
    operatorRole: 'coalesce',
    receiverRole: 'predicateSource',
  });
  const hasExpressionMosaic = expressionMosaic.nodes.length > 0;

  const projectedNodes = [
    projected('target', target, targetX, headerY, ['HybridTarget'], {
      diaName: target.props?.diaName || 'pastedTextBytes',
      displayWidth: 210,
      displayHeight: 84,
      hybridVisualRole: 'result-target',
    }),
    projected('accumulate', accumulate, targetX + 0.08, headerY + 0.22, ['HybridAssignment'], {
      diaName: 'add',
      displayWidth: 72,
      displayHeight: 30,
      hybridVisualRole: 'assignment',
      hybridOverlayOwnerStableId: target.key,
      hybridOverlayKind: 'contained-action',
    }),
    projected('contribution', contribution, targetX + 0.08, contributionY, ['HybridSelectedValue'], {
      diaName: contribution.props?.diaName || 'value',
      displayWidth: 58,
      displayHeight: 24,
      hybridVisualRole: 'selected-value',
    }),
    projected('seed', seed, seedX, headerY, ['HybridOperandOccurrence'], {
      diaName: '0',
      displayWidth: 36,
      displayHeight: 24,
      hybridVisualRole: 'operand-occurrence',
    }),
    projected('call', header, axisX, headerY, ['Method', 'HybridMethodAxis'], {
      diaName: scenario.method || 'reduce',
      displayWidth: 80,
      displayHeight: 32,
      hybridVisualRole: 'method-axis-header',
      hybridColumnStableId: iterator.key,
      graphMethodVisual: undefined,
      splitCallBoundary: undefined,
      suppressObjectMethodVisual: true,
    }),
    projected('iterator', iterator, axisX, axisCenterY, ['HybridFunctionalColumn'], {
      diaName: '',
      displayWidth: 10,
      displayHeight: axisHeight,
      hybridVisualRole: 'functional-column',
      hybridAttachmentOwnerStableId: header.key,
      hybridColumnHeaderStableId: header.key,
      hybridHiddenRoleStableIds: lane.hideInternalChain
        ? lane.orderedRoles
            .map((role) => semanticForRole(role)?.key)
            .filter((stableId) => stableId && stableId !== header.key)
        : [],
    }),
    projected('receiver', receiver, sourceX, headerY, ['HybridReceiver'], {
      diaName: receiver.props?.diaName || 'pastedTextRefs',
      displayWidth: 158,
      displayHeight: 72,
      hybridVisualRole: 'collection-receiver',
    }),
    projected('pull', pull, sourceX + 0.08, headerY + 0.28, ['HybridEmbeddedOperation'], {
      diaName: pull.props?.diaName || pull.props?.containerMethodKind || pull.props?.container_method_kind || '',
      displayWidth: 108,
      displayHeight: 26,
      hybridVisualRole: 'embedded-operation',
      hybridOverlayOwnerStableId: receiver.key,
      hybridOverlayKind: 'operation-in-value',
    }),
    projected('exhausted', exhausted, sourceX + 0.43, headerY + 0.28, ['HybridExhausted'], {
      diaName: 'x',
      displayWidth: 22,
      displayHeight: 22,
      hybridVisualRole: 'exhausted-marker',
      hybridCompositionOwnerStableId: pull.key,
      hybridCompositionKind: 'outcome-of-value',
    }),
    projected('pulledCandidate', pulledCandidate, axisX, candidateY, ['HybridCandidateValue'], {
      diaName: pulledCandidate.props?.diaName || item.props?.diaName || 'item',
      displayWidth: 48,
      displayHeight: 24,
      hybridVisualRole: 'axis-value',
    }),
    !hasExpressionMosaic && projected('item', item, itemX, expressionY, ['HybridOperandOccurrence'], {
      diaName: item.props?.diaName || pulledCandidate.props?.diaName || 'item',
      displayWidth: 48,
      displayHeight: 24,
      hybridVisualRole: 'operand-occurrence',
    }),
    !hasExpressionMosaic && projected('predicateSource', predicateSource, predicateSourceX, expressionY, ['HybridReceiver'], {
      diaName: predicateSourceName,
      displayWidth: 186,
      displayHeight: 72,
      hybridVisualRole: 'collection-receiver',
    }),
    !hasExpressionMosaic && projected('contentAccess', contentAccess, predicateSourceX + 0.08, expressionY + 0.18, ['HybridPredicateAccess'], {
      diaName: contentAccessLabel,
      label: contentAccessLabel,
      actionTextRaw: contentAccessLabel,
      action_text_raw: contentAccessLabel,
      operationSubjectText: contentAccessLabel,
      operation_subject_text: contentAccessLabel,
      displayWidth: 176,
      displayHeight: 30,
      hybridVisualRole: 'producer-call',
      hybridOverlayOwnerStableId: predicateSource.key,
      hybridOverlayKind: 'operation-in-value',
    }),
    !hasExpressionMosaic && projected('coalesce', coalesce, predicateSourceX + 0.34, expressionY + 0.32, ['HybridPredicateStage', 'HybridExpressionPredicate'], {
      diaName: coalesce.props?.diaName || '?? 0',
      displayWidth: 86,
      displayHeight: 28,
      hybridVisualRole: 'predicate-expression',
      hybridOverlayOwnerStableId: contentAccess.key,
      hybridOverlayKind: 'expression-on-operation',
    }),
    ...expressionMosaic.nodes,
  ].filter(Boolean);

  const projectedEdges = [];
  const addProjectedEdge = (type, start, end, props = {}) => {
    if (!start || !end) return;
    projectedEdges.push(projectionEdge(type, start, end, {
      ownerStepStableId: stepId,
      owner_step_stable_id: stepId,
      hybridCompositionId: compositionId,
      protocolScenarioId: scenario.scenarioId,
      protocolKind: scenario.protocol,
      ...props,
    }));
  };
  addProjectedEdge('EVAL', target.key, header.key, {
    label: 'EVAL',
    displayLabel: 'EVAL',
    flow_layer: 'control',
    oneWay: true,
    strokeColor: '#9a5d00',
    sourcePort: 'right',
    targetPort: 'left',
  });
  addProjectedEdge('PASSES_VALUE', seed.key, header.key, {
    label: '',
    displayLabel: '',
    flow_layer: 'data',
    sourcePort: 'right',
    targetPort: 'left',
  });
  addProjectedEdge('ITERATES_VALUE', receiver.key, header.key, {
    label: '',
    displayLabel: '',
    flow_layer: 'control',
    strokeColor: '#9a5d00',
    sourcePort: 'left',
    targetPort: 'right',
  });
  addProjectedEdge('PULLS_VALUE', iterator.key, pull.key, {
    label: '',
    displayLabel: '',
    flow_layer: 'control',
    sourceSemanticStableId: iterator.key,
    sourcePort: columnRightPortAt(headerY + 0.2),
    targetPort: 'left',
  });
  addProjectedEdge('YIELDS_VALUE', pull.key, pulledCandidate.key, {
    label: '',
    displayLabel: '',
    flow_layer: 'data',
    sourcePort: 'left',
    targetPort: 'right',
  });
  if (!hasExpressionMosaic) addProjectedEdge('ITEM_AVAILABLE', pulledCandidate.key, iterator.key, {
    label: '',
    displayLabel: '',
    flow_layer: 'data',
    sourceSemanticStableId: pulledCandidate.key,
    targetSemanticStableId: item.key,
    sourcePort: 'left',
    targetPort: columnRightPortAt(candidateY),
  });
  addProjectedEdge('EXHAUSTED', pull.key, exhausted.key, {
    label: 'undefined',
    displayLabel: 'undefined',
    flow_layer: 'control',
    sourcePort: 'right',
    targetPort: 'left',
  });
  if (!hasExpressionMosaic) addProjectedEdge('EXTRACTS_VALUE', iterator.key, item.key, {
    label: '',
    displayLabel: '',
    flow_layer: 'control',
    sourceSemanticStableId: item.key,
    sourcePort: columnRightPortAt(expressionY),
    targetPort: 'left',
  });
  if (!hasExpressionMosaic) addProjectedEdge('PASSES_VALUE', item.key, contentAccess.key, {
    label: '',
    displayLabel: '',
    flow_layer: 'data',
    sourcePort: 'right',
    targetPort: 'left',
  });
  addProjectedEdge('PRODUCES_VALUE', coalesce.key, contribution.key, {
    label: '',
    displayLabel: '',
    flow_layer: 'data',
    sourcePort: 'bottom',
    targetPort: 'bottom',
  });
  addProjectedEdge('PASSES_VALUE', contribution.key, accumulate.key, {
    label: '',
    displayLabel: '',
    flow_layer: 'data',
    sourcePort: 'top',
    targetPort: 'bottom',
  });
  addProjectedEdge('REPEATS', accumulate.key, header.key, {
    label: 'repeat',
    displayLabel: 'repeat',
    flow_layer: 'control',
    strokeColor: '#9a5d00',
    sourcePort: 'top',
    targetPort: 'top',
  });

  const projectedIds = new Set(projectedNodes.map((node) => node.id));
  const stepRenderedIds = new Set(renderedNodes
    .filter((node) => String(node.props?.parentStepStableId || '').trim() === stepId)
    .map((node) => node.id));
  const removalIds = new Set([
    ...projectedIds,
    ...stepRenderedIds,
    ...renderedNodes
      .filter((node) => stepRenderedIds.has(String(node.props?.sourceCallStableId || '')))
      .map((node) => node.id),
  ]);
  const nextNodes = renderedNodes.filter((node) => !removalIds.has(node.id));
  nextNodes.push(...projectedNodes);

  const nextEdges = [];
  for (const edge of renderedEdges) {
    const startInside = removalIds.has(edge.start);
    const endInside = removalIds.has(edge.end);
    if (startInside && endInside) continue;
    const start = startInside && !projectedIds.has(edge.start) ? target.key : edge.start;
    const end = endInside && !projectedIds.has(edge.end) ? target.key : edge.end;
    if (start === end) continue;
    nextEdges.push({
      ...edge,
      start,
      end,
      props: {
        ...edge.props,
        stableId: start,
        targetStableId: end,
      },
    });
  }
  const existingKeys = new Set(nextEdges.map(edgeKey));
  for (const edge of projectedEdges) {
    if (existingKeys.has(edgeKey(edge))) continue;
    existingKeys.add(edgeKey(edge));
    nextEdges.push(edge);
  }

  return {
    nodes: nextNodes,
    edges: nextEdges,
    projectedNodeIds: [...projectedIds],
    projectedEdgeIds: projectedEdges.map((edge) => edge.id),
    protocolStableId: loop.key,
    protocolScenarioId: scenario.scenarioId,
  };
}

function projectCollectionSelectProtocol({
  loop,
  scenario,
  semanticNodes,
  renderedNodes,
  renderedEdges,
}) {
  const semanticById = new Map(semanticNodes.map((node) => [node.key, node]));
  const renderedById = new Map(renderedNodes.map((node) => [node.id, node]));
  const entityByRole = protocolEntityByRole(scenario);
  const semanticForRole = (role) => {
    const entity = entityByRole.get(role);
    return semanticById.get(entity?.actualStableId) || protocolEntityAsSemanticNode(entity);
  };
  const renderedForRole = (role) => renderedById.get(
    entityByRole.get(role)?.actualStableId,
  );
  const target = semanticForRole('target');
  const targetRendered = renderedForRole('target');
  const anchorPosition = nodePosition(targetRendered);
  const lane = (scenario.lanes || []).find((candidate) => (
    candidate.owner === 'iterator'
    && candidate.direction === 'vertical'
    && candidate.visualKind === 'functional-column'
  ));
  if (!target || !targetRendered || !anchorPosition || !lane) return null;

  const requiredRoles = [
    'source',
    'call',
    'iterator',
    'pull',
    'pulledCandidate',
    'item',
    'predicateSource',
    'predicateAccess',
    'predicate',
    'acceptedItem',
    'emit',
    'exhausted',
  ];
  const optionalRoles = [
    'inputArgument',
    'producerCall',
    'producerFunction',
    'callback',
    'truthy',
    'falsy',
  ];
  const roleNode = new Map(
    [...requiredRoles, ...optionalRoles].map((role) => [role, semanticForRole(role)]),
  );
  if (requiredRoles.some((role) => !roleNode.get(role))) return null;

  const stepId = String(
    target.props?.parentStepStableId
    || loop.props?.parentStepStableId
    || '',
  ).trim();
  const compositionId = `protocol:${scenario.scenarioId}`;
  const targetX = anchorPosition.x;
  const headerY = anchorPosition.y;
  const hasProducer = Boolean(
    semanticForRole('inputArgument')
    && semanticForRole('producerCall'),
  );
  const producerCallForLayout = semanticForRole('producerCall');
  const producerClose = producerCallForLayout
    ? semanticNodes.find((node) => (
        prop(node.props, 'callMosaicOwnerStableId', 'call_mosaic_owner_stable_id') === producerCallForLayout.key
        && prop(node.props, 'callMosaicRole', 'call_mosaic_role') === 'close'
      ))
    : null;
  const producerWidth = 138;
  const inputName = String(semanticForRole('inputArgument')?.props?.diaName || 'input');
  const inputWidth = Math.max(28, Math.min(220, 14 + inputName.length * 7));
  const closeWidth = 44;
  const mosaicGap = 2;
  const producerX = targetX + 0.8;
  const inputX = producerX + (producerWidth + inputWidth + mosaicGap * 2) / 520;
  const producerCloseX = inputX + (inputWidth + closeWidth + mosaicGap * 2) / 520;
  const sourceX = hasProducer ? producerCloseX + 0.72 : targetX + 1.7;
  const axisX = hasProducer ? sourceX + 0.9 : targetX + 0.86;
  const predicateSourceX = hasProducer ? axisX + 2.17 : targetX + 3.04;
  const candidateY = headerY + 0.62;
  const predicateY = headerY + 1.25;
  const acceptedY = headerY + 1.86;
  const axisTopY = headerY + 0.12;
  const axisBottomY = predicateY + 0.18;
  const axisCenterY = (axisTopY + axisBottomY) / 2;
  const axisHeight = Math.max(120, Math.round((axisBottomY - axisTopY) * 130));
  const columnRightPortAt = (stageY) => {
    const span = Math.max(0.01, axisBottomY - axisTopY);
    const ratio = Math.max(0.04, Math.min(0.96, (stageY - axisTopY) / span));
    return `right-${Math.round(ratio * 100)}`;
  };

  function projected(role, node, x, y, extraLabels = [], extraProps = {}) {
    if (!node) return null;
    const existing = renderedById.get(node.key);
    const base = existing || semanticNodeAsRendered(node, x, y);
    const entity = entityByRole.get(role);
    const visualOccurrenceId = extraProps.hybridVisualOccurrenceId || base.id;
    return {
      ...base,
      id: visualOccurrenceId,
      label: extraProps.diaName || base.label,
      labels: [...new Set([
        ...(base.labels || []),
        ...(entity?.labelsAll || []),
        ...extraLabels,
      ])],
      props: {
        ...(base.props || {}),
        ...(entity?.properties || {}),
        ...extraProps,
        parentStepStableId: stepId,
        displayX: x,
        displayY: y,
        hybridCompositionId: compositionId,
        protocolScenarioId: scenario.scenarioId,
        protocolKind: scenario.protocol,
        protocolRole: role,
        renderHidden: false,
        skipHorizontalCompaction: true,
        layoutTrace: [
          base.props?.layoutTrace,
          `execution protocol composition ${scenario.scenarioId}:${role}`,
        ].filter(Boolean).join('; '),
      },
    };
  }

  const inputArgument = roleNode.get('inputArgument');
  const producerCall = roleNode.get('producerCall');
  const source = roleNode.get('source');
  const header = roleNode.get('call');
  const iterator = roleNode.get('iterator');
  const pull = roleNode.get('pull');
  const pulledCandidate = roleNode.get('pulledCandidate');
  const item = roleNode.get('item');
  const predicateSource = roleNode.get('predicateSource');
  const predicateAccess = roleNode.get('predicateAccess');
  const predicate = roleNode.get('predicate');
  const acceptedItem = roleNode.get('acceptedItem');
  const emit = roleNode.get('emit');
  const exhausted = roleNode.get('exhausted');
  const predicateSourceName = entityByRole.get('predicateSource')?.properties?.diaName
    || predicateSource.props?.diaName
    || 'pastedContents';
  const predicateAccessLabel = relativeAccessLabel(
    predicateAccess,
    predicateSource,
    'value',
    predicateSourceName,
    prop(predicateAccess.props, 'relativeAccessText', 'relative_access_text')
      || entityByRole.get('predicateAccess')?.properties?.relativeAccessText,
  );
  const acceptedVisualId = acceptedItem.key === item.key
    ? `${acceptedItem.key}:visual-accepted:${loop.key}`
    : acceptedItem.key;
  const expressionMosaic = projectExpressionMosaic({
    semanticNodes,
    ownerStableId: predicate.key,
    projected,
    startX: predicateSourceX,
    rowY: predicateY,
    operatorRole: 'predicate',
    receiverRole: 'predicateSource',
  });
  const hasExpressionMosaic = expressionMosaic.nodes.length > 0;

  const projectedNodes = [
    projected('target', target, targetX, headerY, ['HybridTarget'], {
      diaName: entityByRole.get('target')?.properties?.diaName
        || target.props?.diaName
        || 'pastedTextRefs',
      displayWidth: 210,
      displayHeight: 84,
      hybridVisualRole: 'result-target',
    }),
    projected('emit', emit, targetX + 0.08, headerY + 0.22, ['HybridAssignment'], {
      diaName: 'push',
      displayWidth: 72,
      displayHeight: 30,
      hybridVisualRole: 'assignment',
      hybridOverlayOwnerStableId: target.key,
      hybridOverlayKind: 'contained-action',
    }),
    projected('acceptedItem', acceptedItem, targetX + 0.08, acceptedY, ['HybridSelectedValue'], {
      diaName: acceptedItem.props?.diaName || item.props?.diaName || 'item',
      hybridVisualOccurrenceId: acceptedVisualId,
      displayWidth: 52,
      displayHeight: 24,
      hybridVisualRole: 'selected-value',
    }),
    projected('inputArgument', inputArgument, inputX, headerY, ['HybridOperandOccurrence'], {
      diaName: inputArgument?.props?.diaName || 'input',
      displayWidth: inputWidth,
      displayHeight: 34,
      hybridVisualRole: 'operand-occurrence',
      splitCallBoundary: 'middle',
      callHasArguments: true,
      compactCallMosaic: true,
    }),
    projected('producerCall', producerCall, producerX, headerY, ['HybridProducerCall'], {
      diaName: entityByRole.get('producerCall')?.properties?.diaName || 'parseReferences(',
      displayWidth: producerWidth,
      displayHeight: 38,
      hybridVisualRole: 'producer-call',
      splitCallBoundary: 'start',
      compactCallMosaic: true,
      suppressObjectMethodVisual: true,
    }),
    projected('producerClose', producerClose, producerCloseX, headerY, ['HybridProducerClose'], {
      diaName: ')',
      displayWidth: closeWidth,
      displayHeight: 38,
      hybridVisualRole: 'producer-close',
      splitCallBoundary: 'end',
      callHasArguments: true,
      compactCallMosaic: true,
      suppressObjectMethodVisual: true,
    }),
    projected('call', header, axisX, headerY, ['Method', 'HybridMethodAxis'], {
      diaName: scenario.method || header.props?.diaName || 'filter',
      displayWidth: 80,
      displayHeight: 32,
      hybridVisualRole: 'method-axis-header',
      hybridColumnStableId: iterator.key,
      graphMethodVisual: undefined,
      suppressObjectMethodVisual: true,
    }),
    projected('iterator', iterator, axisX, axisCenterY, ['HybridFunctionalColumn'], {
      diaName: '',
      displayWidth: 10,
      displayHeight: axisHeight,
      hybridVisualRole: 'functional-column',
      hybridAttachmentOwnerStableId: header.key,
      hybridColumnHeaderStableId: header.key,
      hybridHiddenRoleStableIds: lane.hideInternalChain
        ? lane.orderedRoles
            .map((role) => semanticForRole(role)?.key)
            .filter((stableId) => stableId && stableId !== header.key)
        : [],
    }),
    projected('source', source, sourceX, headerY, ['HybridReceiver'], {
      diaName: entityByRole.get('source')?.properties?.diaName || 'parseReferences result',
      displayWidth: 150,
      displayHeight: 72,
      hybridVisualRole: 'collection-receiver',
    }),
    projected('pull', pull, sourceX + 0.08, headerY + 0.28, ['HybridEmbeddedOperation'], {
      diaName: pull.props?.diaName || pull.props?.containerMethodKind || pull.props?.container_method_kind || '',
      displayWidth: 108,
      displayHeight: 26,
      hybridVisualRole: 'embedded-operation',
      hybridOverlayOwnerStableId: source.key,
      hybridOverlayKind: 'operation-in-value',
    }),
    projected('exhausted', exhausted, sourceX + 0.43, headerY + 0.28, ['HybridExhausted'], {
      diaName: 'x',
      displayWidth: 22,
      displayHeight: 22,
      hybridVisualRole: 'exhausted-marker',
      hybridCompositionOwnerStableId: pull.key,
      hybridCompositionKind: 'outcome-of-value',
    }),
    projected('pulledCandidate', pulledCandidate, axisX, candidateY, ['HybridCandidateValue'], {
      diaName: pulledCandidate.props?.diaName || item.props?.diaName || 'item',
      displayWidth: 48,
      displayHeight: 24,
      hybridVisualRole: 'axis-value',
    }),
    !hasExpressionMosaic && projected('item', item, axisX + 0.68, predicateY, ['HybridOperandOccurrence'], {
      diaName: item.props?.diaName || pulledCandidate.props?.diaName || 'item',
      displayWidth: 48,
      displayHeight: 24,
      hybridVisualRole: 'operand-occurrence',
    }),
    !hasExpressionMosaic && projected('predicateSource', predicateSource, predicateSourceX, predicateY, ['HybridReceiver'], {
      diaName: predicateSourceName,
      displayWidth: 156,
      displayHeight: 72,
      hybridVisualRole: 'collection-receiver',
    }),
    !hasExpressionMosaic && projected('predicateAccess', predicateAccess, predicateSourceX + 0.08, predicateY + 0.18, ['HybridPredicateAccess'], {
      diaName: predicateAccessLabel,
      label: predicateAccessLabel,
      actionTextRaw: predicateAccessLabel,
      action_text_raw: predicateAccessLabel,
      operationSubjectText: predicateAccessLabel,
      operation_subject_text: predicateAccessLabel,
      displayWidth: 124,
      displayHeight: 30,
      hybridVisualRole: 'producer-call',
      hybridOverlayOwnerStableId: predicateSource.key,
      hybridOverlayKind: 'operation-in-value',
    }),
    !hasExpressionMosaic && projected('predicate', predicate, predicateSourceX + 0.25, predicateY + 0.32, ['HybridPredicateStage', 'HybridExpressionPredicate'], {
      diaName: entityByRole.get('predicate')?.properties?.expressionSuffix
        || entityByRole.get('predicate')?.properties?.diaName
        || 'predicate',
      displayWidth: 108,
      displayHeight: 28,
      hybridVisualRole: 'predicate-expression',
      hybridOverlayOwnerStableId: predicateAccess.key,
      hybridOverlayKind: 'expression-on-operation',
    }),
    ...expressionMosaic.nodes,
  ].filter(Boolean);

  const projectedEdges = [];
  const addProjectedEdge = (type, start, end, props = {}) => {
    if (!start || !end) return;
    projectedEdges.push(projectionEdge(type, start, end, {
      ownerStepStableId: stepId,
      owner_step_stable_id: stepId,
      hybridCompositionId: compositionId,
      protocolScenarioId: scenario.scenarioId,
      protocolKind: scenario.protocol,
      ...props,
    }));
  };
  const evaluationTarget = producerCall || header;
  addProjectedEdge('EVAL', target.key, evaluationTarget.key, {
    label: 'EVAL',
    displayLabel: 'EVAL',
    flow_layer: 'control',
    oneWay: true,
    strokeColor: '#9a5d00',
    sourcePort: 'right',
    targetPort: 'left',
  });
  addProjectedEdge('PRODUCES_VALUE', producerClose?.key || producerCall?.key, source.key, {
    label: '',
    displayLabel: '',
    flow_layer: 'data',
    sourcePort: 'right',
    targetPort: 'left-25',
  });
  addProjectedEdge('ITERATES_VALUE', source.key, header.key, {
    label: '',
    displayLabel: '',
    flow_layer: 'control',
    strokeColor: '#9a5d00',
    sourcePort: 'left',
    targetPort: 'right',
  });
  addProjectedEdge('PULLS_VALUE', iterator.key, pull.key, {
    label: '',
    displayLabel: '',
    flow_layer: 'control',
    sourceSemanticStableId: iterator.key,
    sourcePort: columnRightPortAt(headerY + 0.2),
    targetPort: 'left',
  });
  addProjectedEdge('YIELDS_VALUE', pull.key, pulledCandidate.key, {
    label: '',
    displayLabel: '',
    flow_layer: 'data',
    sourcePort: 'left',
    targetPort: 'right',
  });
  if (!hasExpressionMosaic) addProjectedEdge('ITEM_AVAILABLE', pulledCandidate.key, iterator.key, {
    label: '',
    displayLabel: '',
    flow_layer: 'data',
    sourceSemanticStableId: pulledCandidate.key,
    targetSemanticStableId: item.key,
    sourcePort: 'left',
    targetPort: columnRightPortAt(candidateY),
  });
  addProjectedEdge('EXHAUSTED', pull.key, exhausted.key, {
    label: 'undefined',
    displayLabel: 'undefined',
    flow_layer: 'control',
    sourcePort: 'right',
    targetPort: 'left',
  });
  if (!hasExpressionMosaic) addProjectedEdge('EXTRACTS_VALUE', iterator.key, item.key, {
    label: '',
    displayLabel: '',
    flow_layer: 'control',
    sourceSemanticStableId: item.key,
    sourcePort: columnRightPortAt(predicateY),
    targetPort: 'left',
  });
  if (!hasExpressionMosaic) addProjectedEdge('PASSES_VALUE', item.key, predicateAccess.key, {
    label: '',
    displayLabel: '',
    flow_layer: 'data',
    sourcePort: 'right',
    targetPort: 'left',
  });
  addProjectedEdge('TRUE', predicate.key, acceptedVisualId, {
    label: 'true',
    displayLabel: 'true',
    flow_layer: 'control',
    sourcePort: 'bottom',
    targetPort: 'bottom',
  });
  addProjectedEdge('PASSES_VALUE', acceptedVisualId, emit.key, {
    label: '',
    displayLabel: '',
    flow_layer: 'data',
    sourcePort: 'top',
    targetPort: 'bottom',
  });
  addProjectedEdge('FALSE', predicate.key, header.key, {
    label: 'false',
    displayLabel: 'false',
    flow_layer: 'control',
    sourcePort: 'top',
    targetPort: 'top',
  });
  addProjectedEdge('REPEATS', emit.key, header.key, {
    label: 'repeat',
    displayLabel: 'repeat',
    flow_layer: 'control',
    strokeColor: '#9a5d00',
    sourcePort: 'top',
    targetPort: 'top',
  });

  const projectedIds = new Set(projectedNodes.map((node) => node.id));
  const stepRenderedIds = new Set(renderedNodes
    .filter((node) => String(node.props?.parentStepStableId || '').trim() === stepId)
    .map((node) => node.id));
  const removalIds = new Set([
    ...projectedIds,
    ...stepRenderedIds,
    ...renderedNodes
      .filter((node) => stepRenderedIds.has(String(node.props?.sourceCallStableId || '')))
      .map((node) => node.id),
  ]);
  const nextNodes = renderedNodes.filter((node) => !removalIds.has(node.id));
  nextNodes.push(...projectedNodes);

  const nextEdges = [];
  for (const edge of renderedEdges) {
    const startInside = removalIds.has(edge.start);
    const endInside = removalIds.has(edge.end);
    if (startInside && endInside) continue;
    const start = startInside && !projectedIds.has(edge.start) ? target.key : edge.start;
    const end = endInside && !projectedIds.has(edge.end) ? target.key : edge.end;
    if (start === end) continue;
    nextEdges.push({
      ...edge,
      start,
      end,
      props: {
        ...edge.props,
        stableId: start,
        targetStableId: end,
      },
    });
  }
  const existingKeys = new Set(nextEdges.map(edgeKey));
  for (const edge of projectedEdges) {
    if (existingKeys.has(edgeKey(edge))) continue;
    existingKeys.add(edgeKey(edge));
    nextEdges.push(edge);
  }

  return {
    nodes: nextNodes,
    edges: nextEdges,
    projectedNodeIds: [...projectedIds],
    projectedEdgeIds: projectedEdges.map((edge) => edge.id),
    protocolStableId: loop.key,
    protocolScenarioId: scenario.scenarioId,
  };
}

function projectCollectionDispatchProtocol({
  loop,
  scenario,
  semanticNodes,
  renderedNodes,
  renderedEdges,
}) {
  const semanticById = new Map(semanticNodes.map((node) => [node.key, node]));
  const renderedById = new Map(renderedNodes.map((node) => [node.id, node]));
  const entityByRole = protocolEntityByRole(scenario);
  const relationFor = (from, type, to) => (scenario.relations || []).find((relation) => (
    relation.from === from
    && relation.type === type
    && relation.to === to
  ));
  const semanticForRole = (role) => {
    const entity = entityByRole.get(role);
    return semanticById.get(entity?.actualStableId) || protocolEntityAsSemanticNode(entity);
  };
  const loopHeader = semanticForRole('loopHeader');
  const anchorRendered = renderedById.get(loopHeader?.key)
    || ['sourceTarget', 'sourceObjectComplete', 'imageContentObject', 'typePredicate']
      .map((role) => renderedById.get(semanticForRole(role)?.key))
      .find(Boolean);
  const anchor = nodePosition(anchorRendered);
  if (!loopHeader || !anchorRendered || !anchor) return null;

  const stepId = String(
    anchorRendered.props?.parentStepStableId
    || loopHeader.props?.parentStepStableId
    || loop.props?.parentStepStableId
    || '',
  ).trim();
  const compositionId = `protocol:${scenario.scenarioId}`;
  const x0 = anchor.x;
  const y0 = anchor.y;

  function projected(role, x, y, extraLabels = [], extraProps = {}) {
    const node = semanticForRole(role);
    if (!node) return null;
    const existing = renderedById.get(node.key);
    const base = existing || semanticNodeAsRendered(node, x, y);
    const entity = entityByRole.get(role);
    return {
      ...base,
      labels: [...new Set([
        ...(base.labels || []),
        ...(entity?.labelsAll || []),
        ...extraLabels,
      ])].filter((label) => (
        !(role === 'loopHeader' && label === 'Loop')
        && !(role === 'typePredicate' && label === 'Flow')
        && !(role === 'sourceAssign' && (label === 'Primitive' || label === 'Assign'))
        && !(
          role.endsWith('Push')
          && (
            label === 'Primitive'
            || label === 'Append'
            || label === 'VisualProxy'
            || label === 'FnVisualProxy'
          )
        )
        && !(
          role.endsWith('Receiver')
          && ['Call', 'Start', 'Request', 'Op'].includes(label)
        )
      )),
      props: {
        ...(base.props || {}),
        ...(entity?.properties || {}),
        ...extraProps,
        parentStepStableId: stepId,
        displayX: x,
        displayY: y,
        hybridCompositionId: compositionId,
        protocolScenarioId: scenario.scenarioId,
        protocolKind: scenario.protocol,
        protocolRole: role,
        renderHidden: extraProps.renderHidden ?? false,
        skipHorizontalCompaction: true,
        layoutTrace: [
          base.props?.layoutTrace,
          `execution protocol composition ${scenario.scenarioId}:${role}`,
        ].filter(Boolean).join('; '),
      },
    };
  }

  const nodeSpecs = [
    ['loopHeader', x0, y0, ['Method', 'HybridMethodAxis'], {
      diaName: 'for',
      displayWidth: 80,
      displayHeight: 32,
      hybridVisualRole: 'method-axis-header',
      hybridColumnStableId: semanticForRole('iterator')?.key,
    }],
    ['iterator', x0, y0 + 2.5, ['HybridFunctionalColumn'], {
      diaName: '',
      displayWidth: 10,
      displayHeight: 620,
      hybridVisualRole: 'functional-column',
      hybridAttachmentOwnerStableId: loopHeader.key,
      hybridColumnHeaderStableId: loopHeader.key,
    }],
    ['source', x0 + 1.1, y0, ['HybridReceiver'], {
      diaName: 'pastedValues',
      displayWidth: 158,
      displayHeight: 72,
      hybridVisualRole: 'collection-receiver',
    }],
    ['pull', x0 + 1.18, y0 + 0.28, ['HybridEmbeddedOperation'], {
      diaName: semanticForRole('pull')?.props?.diaName
        || semanticForRole('pull')?.props?.containerMethodKind
        || semanticForRole('pull')?.props?.container_method_kind
        || '',
      displayWidth: 108,
      displayHeight: 26,
      hybridVisualRole: 'embedded-operation',
      hybridOverlayOwnerStableId: semanticForRole('source')?.key,
      hybridOverlayKind: 'operation-in-value',
    }],
    ['exhausted', x0 + 1.53, y0 + 0.28, ['HybridExhausted'], {
      diaName: 'x',
      displayWidth: 22,
      displayHeight: 22,
      hybridVisualRole: 'exhausted-marker',
      hybridCompositionOwnerStableId: semanticForRole('pull')?.key,
      hybridCompositionKind: 'outcome-of-value',
    }],
    ['pulledCandidate', x0, y0 + 0.72, ['HybridCandidateValue'], {
      diaName: semanticForRole('pulledCandidate')?.props?.diaName
        || semanticForRole('item')?.props?.diaName
        || 'item',
      displayWidth: 62,
      displayHeight: 24,
      hybridVisualRole: 'axis-value',
      hybridOverlayOwnerStableId: semanticForRole('iterator')?.key,
      hybridOverlayKind: 'value-on-axis',
    }],
    ['typePredicate', x0 + 1.05, y0 + 1.08, ['HybridPredicateStage', 'HybridExpressionPredicate'], {
      diaName: "pasted.type === 'image'",
      displayWidth: 150,
      displayHeight: 36,
      hybridVisualRole: 'predicate-expression',
    }],
    ['imageHeader', x0 + 1.95, y0 + 1.72, ['Method', 'HybridMethodAxis'], {
      diaName: 'if',
      displayWidth: 56,
      displayHeight: 30,
      hybridVisualRole: 'method-axis-header',
      hybridColumnStableId: semanticForRole('imageBranch')?.key,
    }],
    ['imageBranch', x0 + 1.95, y0 + 3.02, ['HybridFunctionalColumn'], {
      diaName: '',
      displayWidth: 10,
      displayHeight: 310,
      hybridVisualRole: 'functional-column',
      hybridAttachmentOwnerStableId: semanticForRole('imageHeader')?.key,
      hybridColumnHeaderStableId: semanticForRole('imageHeader')?.key,
    }],
    ['textHeader', x0 + 1.95, y0 + 4.42, ['Method', 'HybridMethodAxis'], {
      diaName: 'else',
      displayWidth: 64,
      displayHeight: 30,
      hybridVisualRole: 'method-axis-header',
      hybridColumnStableId: semanticForRole('textBranch')?.key,
    }],
    ['textBranch', x0 + 1.95, y0 + 5.23, ['HybridFunctionalColumn'], {
      diaName: '',
      displayWidth: 10,
      displayHeight: 180,
      hybridVisualRole: 'functional-column',
      hybridAttachmentOwnerStableId: semanticForRole('textHeader')?.key,
      hybridColumnHeaderStableId: semanticForRole('textHeader')?.key,
    }],
    ['imageBranchJunction1', x0 + 1.95, y0 + 2.62, ['HybridColumnStage'], {
      diaName: '',
      displayWidth: 2,
      displayHeight: 2,
      hybridVisualRole: 'column-stage-port',
      hybridCompositionOwnerStableId: semanticForRole('imageBranch')?.key,
    }],
    ['imageBranchJunction2', x0 + 1.95, y0 + 3.38, ['HybridColumnStage'], {
      diaName: '',
      displayWidth: 2,
      displayHeight: 2,
      hybridVisualRole: 'column-stage-port',
      hybridCompositionOwnerStableId: semanticForRole('imageBranch')?.key,
    }],
    ['textBranchJunction1', x0 + 1.95, y0 + 4.58, ['HybridColumnStage'], {
      diaName: '',
      displayWidth: 2,
      displayHeight: 2,
      hybridVisualRole: 'column-stage-port',
      hybridCompositionOwnerStableId: semanticForRole('textBranch')?.key,
    }],
    ['textBranchJunction2', x0 + 1.95, y0 + 5.34, ['HybridColumnStage'], {
      diaName: '',
      displayWidth: 2,
      displayHeight: 2,
      hybridVisualRole: 'column-stage-port',
      hybridCompositionOwnerStableId: semanticForRole('textBranch')?.key,
    }],
  ];

  const familyRows = [
    {
      prefix: 'source',
      rowY: y0 + 1.82,
      startRole: 'sourceObject',
      fields: ['sourceTypeField', 'sourceMediaField', 'sourceDataField'],
      completeRole: 'sourceObjectComplete',
      receiverRole: 'sourceTarget',
      actionRole: 'sourceAssign',
      receiverName: 'source',
      actionName: 'set',
      stageRole: null,
    },
    {
      prefix: 'imageContent',
      rowY: y0 + 2.62,
      startRole: 'imageContentObject',
      fields: ['imageContentTypeField', 'imageContentSourceField'],
      completeRole: 'imageContentComplete',
      receiverRole: 'imageContentReceiver',
      actionRole: 'imageContentPush',
      receiverName: 'contentBlocks',
      actionName: 'push',
      stageRole: 'imageBranchJunction1',
    },
    {
      prefix: 'imageRemote',
      rowY: y0 + 3.38,
      startRole: 'imageRemoteObject',
      fields: ['imageRemoteTypeField', 'imageRemoteSourceField'],
      completeRole: 'imageRemoteComplete',
      receiverRole: 'imageRemoteReceiver',
      actionRole: 'imageRemotePush',
      receiverName: 'remoteBlocks',
      actionName: 'push',
      stageRole: 'imageBranchJunction2',
    },
    {
      prefix: 'textContent',
      rowY: y0 + 4.58,
      startRole: 'textContentObject',
      fields: ['textContentTypeField', 'textContentTextField'],
      completeRole: 'textContentComplete',
      receiverRole: 'textContentReceiver',
      actionRole: 'textContentPush',
      receiverName: 'contentBlocks',
      actionName: 'push',
      stageRole: 'textBranchJunction1',
    },
    {
      prefix: 'textRemote',
      rowY: y0 + 5.34,
      startRole: 'textRemoteObject',
      fields: ['textRemoteTypeField', 'textRemoteTextField'],
      completeRole: 'textRemoteComplete',
      receiverRole: 'textRemoteReceiver',
      actionRole: 'textRemotePush',
      receiverName: 'remoteBlocks',
      actionName: 'push',
      stageRole: 'textBranchJunction2',
    },
  ];

  for (const family of familyRows) {
    const objectX = x0 + 2.48;
    const fieldX = x0 + 3.12;
    const completeX = x0 + 4.18;
    const receiverX = family.prefix === 'source' ? x0 + 1.95 : x0 + 5.02;
    nodeSpecs.push(
      [family.startRole, objectX, family.rowY, ['HybridObjectStart'], {
        diaName: '{',
        displayWidth: 54,
        displayHeight: 40,
        hybridVisualRole: 'object-start',
      }],
    );
    family.fields.forEach((role, index) => {
      const field = semanticForRole(role);
      const valueText = entityByRole.get(role)?.properties?.valueText;
      nodeSpecs.push([role, fieldX, family.rowY + (index - (family.fields.length - 1) / 2) * 0.23, ['HybridObjectField'], {
        diaName: valueText
          || field?.props?.valueText
          || field?.props?.diaName
          || entityByRole.get(role)?.properties?.diaName
          || 'value',
        displayWidth: family.fields.length === 3 ? 178 : 150,
        displayHeight: 28,
        hybridVisualRole: 'object-field',
      }]);
    });
    nodeSpecs.push(
      [family.completeRole, completeX, family.rowY, ['HybridObjectComplete'], {
        diaName: '}',
        displayWidth: 54,
        displayHeight: 40,
        hybridVisualRole: 'object-complete',
      }],
      [family.receiverRole, receiverX, family.rowY, ['HybridReceiver'], {
        diaName: family.receiverName,
        displayWidth: 156,
        displayHeight: 72,
        hybridVisualRole: 'collection-receiver',
        splitCallBoundary: null,
        visualExpandedExpression: false,
        graphMethodVisual: undefined,
        suppressObjectMethodVisual: true,
      }],
      [family.actionRole, receiverX + 0.08, family.rowY + 0.28, family.prefix === 'source'
        ? ['HybridAssignment']
        : ['HybridEmbeddedOperation'], {
        diaName: family.actionName,
        displayWidth: 70,
        displayHeight: 26,
        hybridVisualRole: family.prefix === 'source' ? 'assignment' : 'embedded-operation',
        hybridOverlayOwnerStableId: semanticForRole(family.receiverRole)?.key,
        hybridOverlayKind: 'operation-in-value',
        graphMethodVisual: undefined,
        splitCallBoundary: undefined,
        suppressObjectMethodVisual: true,
        sourceCallStableId: '',
        visualProxyStableID: '',
      }],
    );
  }

  const projectedNodes = nodeSpecs
    .map(([role, x, y, labels, props]) => projected(role, x, y, labels, props))
    .filter(Boolean);
  const projectedEdges = [];
  const addEdge = (type, fromRole, toRole, props = {}) => {
    const start = semanticForRole(fromRole);
    const end = semanticForRole(toRole);
    if (!start || !end) return;
    projectedEdges.push(projectionEdge(type, start.key, end.key, {
      ownerStepStableId: stepId,
      owner_step_stable_id: stepId,
      hybridCompositionId: compositionId,
      protocolScenarioId: scenario.scenarioId,
      protocolKind: scenario.protocol,
      ...props,
    }));
  };
  const control = {
    flow_layer: 'control',
    strokeColor: '#9a5d00',
  };
  const data = {
    flow_layer: 'data',
    strokeColor: '#6c8ebf',
  };
  addEdge('PULLS_VALUE', 'loopHeader', 'pull', {
    ...control,
    displayLabel: '',
    sourcePort: 'right',
    targetPort: 'left',
  });
  addEdge('YIELDS_VALUE', 'pull', 'pulledCandidate', {
    ...data,
    displayLabel: '',
    sourcePort: 'left',
    targetPort: 'right',
  });
  addEdge('EXHAUSTED', 'pull', 'exhausted', {
    flow_layer: 'control',
    strokeColor: '#c0504d',
    label: 'undefined',
    displayLabel: 'undefined',
    sourcePort: 'right',
    targetPort: 'left',
  });
  addEdge('DECIDES_VALUE', 'iterator', 'typePredicate', {
    ...data,
    displayLabel: '',
    sourceSemanticStableId: semanticForRole('iteratorJunction1')?.key,
    sourcePort: 'right-28',
    targetPort: 'left',
  });
  addEdge('TRUE', 'typePredicate', 'imageHeader', {
    flow_layer: 'control',
    strokeColor: '#70ad47',
    displayLabel: 'true',
    sourcePort: 'bottom',
    targetPort: 'top',
  });
  addEdge('FALSE', 'typePredicate', 'textHeader', {
    flow_layer: 'control',
    strokeColor: '#c0504d',
    displayLabel: 'false',
    sourcePort: 'bottom',
    targetPort: 'top',
  });
  addEdge('ENTERS', 'imageHeader', 'imageBranch', {
    ...control,
    displayLabel: '',
    sourcePort: 'bottom',
    targetPort: 'top',
  });
  addEdge('ENTERS', 'textHeader', 'textBranch', {
    ...control,
    displayLabel: '',
    sourcePort: 'bottom',
    targetPort: 'top',
  });

  for (const family of familyRows) {
    if (family.stageRole) {
      addEdge('EMITS_EFFECT', family.stageRole, family.startRole, {
        ...control,
        displayLabel: '',
        sourcePort: 'right',
        targetPort: 'left',
      });
    } else {
      addEdge('EVAL', family.receiverRole, family.startRole, {
        ...data,
        displayLabel: '',
        sourcePort: 'right',
        targetPort: 'left',
      });
    }
    for (const fieldRole of family.fields) {
      const fieldRelation = relationFor(family.startRole, 'FIELD', fieldRole);
      addEdge('FIELD', family.startRole, fieldRole, {
        ...data,
        displayLabel: fieldRelation?.name || '',
        sourcePort: 'right',
        targetPort: 'left',
      });
      addEdge('FieldJoin', fieldRole, family.completeRole, {
        ...data,
        displayLabel: '',
        sourcePort: 'right',
        targetPort: 'left',
      });
    }
    const valueRelationType = family.prefix === 'source' ? 'ASSIGNS_VALUE' : 'ARG';
    const valueRelation = relationFor(family.completeRole, valueRelationType, family.actionRole);
    addEdge(
      valueRelationType,
      family.completeRole,
      family.actionRole,
      {
        ...data,
        displayLabel: valueRelation?.name || '',
        sourcePort: 'right',
        targetPort: 'left',
      },
    );
    if (family.prefix !== 'source') {
      addEdge('REPEATS', family.actionRole, 'iterator', {
        ...control,
        displayLabel: 'repeat',
        sourcePort: 'top',
        targetPort: 'top',
      });
    }
  }

  const projectedIds = new Set(projectedNodes.map((node) => node.id));
  const stepRenderedIds = new Set(renderedNodes
    .filter((node) => String(node.props?.parentStepStableId || '').trim() === stepId)
    .map((node) => node.id));
  const removalIds = new Set([
    ...projectedIds,
    ...stepRenderedIds,
    ...renderedNodes
      .filter((node) => stepRenderedIds.has(String(node.props?.sourceCallStableId || '')))
      .map((node) => node.id),
  ]);
  const nextNodes = renderedNodes.filter((node) => !removalIds.has(node.id));
  nextNodes.push(...projectedNodes);
  const nextEdges = [];
  for (const edge of renderedEdges) {
    const startInside = removalIds.has(edge.start);
    const endInside = removalIds.has(edge.end);
    if (startInside && endInside) continue;
    const start = startInside && !projectedIds.has(edge.start) ? loop.key : edge.start;
    const end = endInside && !projectedIds.has(edge.end) ? loop.key : edge.end;
    if (start === end) continue;
    nextEdges.push({
      ...edge,
      start,
      end,
      props: {
        ...(edge.props || {}),
        stableId: start,
        targetStableId: end,
      },
    });
  }
  const existingKeys = new Set(nextEdges.map(edgeKey));
  for (const edge of projectedEdges) {
    if (existingKeys.has(edgeKey(edge))) continue;
    existingKeys.add(edgeKey(edge));
    nextEdges.push(edge);
  }
  return {
    nodes: nextNodes,
    edges: nextEdges,
    projectedNodeIds: [...projectedIds],
    projectedEdgeIds: projectedEdges.map((edge) => edge.id),
    protocolStableId: loop.key,
    protocolScenarioId: scenario.scenarioId,
  };
}

function projectStateUpdateProtocol({
  loop,
  scenario,
  semanticNodes,
  renderedNodes,
  renderedEdges,
}) {
  const semanticById = new Map(semanticNodes.map((node) => [node.key, node]));
  const renderedById = new Map(renderedNodes.map((node) => [node.id, node]));
  const entityByRole = protocolEntityByRole(scenario);
  const semanticForRole = (role) => {
    const entity = entityByRole.get(role);
    return semanticById.get(entity?.actualStableId) || protocolEntityAsSemanticNode(entity);
  };
  const root = semanticForRole('stateUpdateCall');
  const rootRendered = renderedById.get(root?.key);
  const anchor = nodePosition(rootRendered);
  if (!root || !rootRendered || !anchor) return null;

  const stepId = String(
    root.props?.parentStepStableId
    || loop.props?.parentStepStableId
    || '',
  ).trim();
  const compositionId = `protocol:${scenario.scenarioId}`;
  const x0 = anchor.x;
  const y0 = anchor.y;

  function projected(role, x, y, extraLabels = [], extraProps = {}) {
    const node = semanticForRole(role);
    if (!node) return null;
    const existing = renderedById.get(node.key);
    const base = existing || semanticNodeAsRendered(node, x, y);
    const entity = entityByRole.get(role);
    return {
      ...base,
      labels: [...new Set([
        ...(base.labels || []),
        ...(entity?.labelsAll || []),
        ...extraLabels,
      ])],
      props: {
        ...(base.props || {}),
        ...(entity?.properties || {}),
        ...extraProps,
        parentStepStableId: stepId,
        displayX: x,
        displayY: y,
        hybridCompositionId: compositionId,
        protocolScenarioId: scenario.scenarioId,
        protocolKind: scenario.protocol,
        protocolRole: role,
        renderHidden: extraProps.renderHidden ?? false,
        skipHorizontalCompaction: true,
        layoutTrace: [
          base.props?.layoutTrace,
          `execution protocol composition ${scenario.scenarioId}:${role}`,
        ].filter(Boolean).join('; '),
      },
    };
  }

  const roleNode = (role) => semanticForRole(role);
  const stateUpdateCall = roleNode('stateUpdateCall');
  const stateUpdater = roleNode('stateUpdater');
  const incrementCall = roleNode('incrementCall');
  const incrementCallClose = roleNode('incrementCallClose');
  const incrementFunction = roleNode('incrementFunction');
  const recordCall = roleNode('recordCall');
  const recordCallClose = roleNode('recordCallClose');
  const recordFunction = roleNode('recordFunction');
  const logCallClose = roleNode('logCallClose');
  const junctionRole = (preferred, fallback) => (roleNode(preferred) ? preferred : fallback);
  const semanticName = (node, fallback = '') => String(
    prop(node?.props, 'diaName', 'dia_name')
    || prop(node?.props, 'bindingName', 'binding_name')
    || prop(node?.props, 'name')
    || prop(node?.props, 'operationCalleeText', 'operation_callee_text')
    || fallback,
  ).trim();
  const callName = (node, fallback = '') => String(
    prop(node?.props, 'operationCalleeText', 'operation_callee_text')
    || semanticName(node, fallback),
  ).trim().replace(/\s*\(.*$/s, '');
  const openCallName = (node, fallback = '') => `${callName(node, fallback)}(`;
  const compactTextWidth = (name, minimum = 70, maximum = 220) => Math.max(
    minimum,
    Math.min(maximum, 24 + String(name || '').length * 7),
  );
  const compactWidth = (node, minimum = 70, maximum = 220) => (
    compactTextWidth(semanticName(node), minimum, maximum)
  );

  const projectedNodes = [
    projected('stateUpdateCall', x0, y0, ['Method', 'HybridMethodAxis'], {
      diaName: callName(stateUpdateCall),
      displayWidth: compactTextWidth(callName(stateUpdateCall), 96),
      displayHeight: 34,
      hybridVisualRole: 'method-axis-header',
      hybridColumnStableId: stateUpdater.key,
    }),
    projected('stateUpdater', x0, y0 + 2.65, ['HybridFunctionalColumn'], {
      diaName: '',
      displayWidth: 2,
      displayHeight: 690,
      hybridVisualRole: 'functional-column',
      hybridAttachmentOwnerStableId: stateUpdateCall.key,
      hybridColumnHeaderStableId: stateUpdateCall.key,
      renderHidden: true,
    }),
    projected('stateJunction1', x0, y0 + 0.48, ['HybridColumnJunction'], {
      diaName: '', displayWidth: 10, displayHeight: 10,
      hybridVisualRole: 'column-junction',
      hybridCompositionOwnerStableId: stateUpdater.key,
    }),
    projected('stateJunction2', x0, y0 + 5.9, ['HybridColumnJunction'], {
      diaName: '', displayWidth: 10, displayHeight: 10,
      hybridVisualRole: 'column-junction',
      hybridCompositionOwnerStableId: stateUpdater.key,
    }),
    projected('stateJunction3', x0, y0 + 6.75, ['HybridColumnJunction'], {
      diaName: '', displayWidth: 10, displayHeight: 10,
      hybridVisualRole: 'column-junction',
      hybridCompositionOwnerStableId: stateUpdater.key,
    }),
    projected('incrementCall', x0 + 0.78, y0 + 0.76, ['Method', 'HybridMethodAxis'], {
      diaName: openCallName(incrementCall),
      displayWidth: compactTextWidth(openCallName(incrementCall), 110),
      displayHeight: 34,
      hybridVisualRole: 'method-axis-header',
      hybridColumnStableId: incrementFunction.key,
      compactCallMosaic: true,
    }),
    projected('previousAttribution', x0 + 1.37, y0 + 0.76, ['HybridOperandOccurrence'], {
      diaName: semanticName(roleNode('previousAttribution')),
      displayWidth: compactWidth(roleNode('previousAttribution'), 90),
      displayHeight: 34,
      hybridVisualRole: 'operand-occurrence',
      compactCallMosaic: true,
    }),
    projected('incrementCallClose', x0 + 1.69, y0 + 0.76, ['HybridCallClose'], {
      diaName: ')',
      displayWidth: 30,
      displayHeight: 34,
      hybridVisualRole: 'producer-close',
      compactCallMosaic: true,
    }),
    projected('incrementFunction', x0 + 0.78, y0 + 2.25, ['HybridFunctionalColumn'], {
      diaName: '',
      displayWidth: 2,
      displayHeight: 440,
      hybridVisualRole: 'functional-column',
      hybridAttachmentOwnerStableId: incrementCall.key,
      hybridColumnHeaderStableId: incrementCall.key,
      renderHidden: true,
    }),
    projected('incrementJunction1', x0 + 0.78, y0 + 3.18, ['HybridColumnJunction'], {
      diaName: '', displayWidth: 10, displayHeight: 10,
      hybridVisualRole: 'column-junction', hybridCompositionOwnerStableId: incrementFunction.key,
    }),
    projected('newAttribution', x0 + 0.78, y0 + 1.55, ['HybridTarget'], {
      diaName: semanticName(roleNode('newAttribution')),
      displayWidth: compactWidth(roleNode('newAttribution'), 110),
      displayHeight: 70,
      hybridVisualRole: 'result-target',
    }),
    projected('attributionSpread', x0 + 1.72, y0 + 1.42, ['HybridFieldValue'], {
      diaName: semanticName(roleNode('attributionSpread')),
      displayWidth: compactWidth(roleNode('attributionSpread'), 80),
      displayHeight: 28,
      hybridVisualRole: 'field-value',
    }),
    projected('promptCount', x0 + 1.72, y0 + 1.88, ['HybridFieldValue'], {
      diaName: semanticName(roleNode('promptCount')),
      displayWidth: compactWidth(roleNode('promptCount'), 100),
      displayHeight: 32,
      hybridVisualRole: 'field-value',
    }),
    projected('snapshot', x0 + 0.78, y0 + 2.55, ['HybridTarget'], {
      diaName: semanticName(roleNode('snapshot')),
      displayWidth: compactWidth(roleNode('snapshot'), 90),
      displayHeight: 64,
      hybridVisualRole: 'result-target',
    }),
    projected('returnedAttribution', x0 + 0.78, y0 + 3.62, ['HybridOperandOccurrence'], {
      diaName: semanticName(roleNode('returnedAttribution')),
      displayWidth: compactWidth(roleNode('returnedAttribution'), 90),
      displayHeight: 44,
      hybridVisualRole: 'operand-occurrence',
    }),
    projected('recordCall', x0 + 1.85, y0 + 3.18, ['Method', 'HybridMethodAxis'], {
      diaName: openCallName(recordCall),
      displayWidth: compactTextWidth(openCallName(recordCall), 110),
      displayHeight: 34,
      hybridVisualRole: 'method-axis-header',
      hybridColumnStableId: recordFunction.key,
      compactCallMosaic: true,
    }),
    projected('recordSnapshotArgument', x0 + 2.38, y0 + 3.18, ['HybridOperandOccurrence'], {
      diaName: semanticName(roleNode('recordSnapshotArgument')),
      displayWidth: compactWidth(roleNode('recordSnapshotArgument'), 80),
      displayHeight: 34,
      hybridVisualRole: 'operand-occurrence',
      compactCallMosaic: true,
    }),
    projected('recordCallClose', x0 + 2.57, y0 + 3.18, ['HybridCallClose'], {
      diaName: ')',
      displayWidth: 30,
      displayHeight: 34,
      hybridVisualRole: 'producer-close',
      compactCallMosaic: true,
    }),
    projected('recordFunction', x0 + 1.85, y0 + 4.15, ['HybridFunctionalColumn'], {
      diaName: '',
      displayWidth: 2,
      displayHeight: 300,
      hybridVisualRole: 'functional-column',
      hybridAttachmentOwnerStableId: recordCall.key,
      hybridColumnHeaderStableId: recordCall.key,
      renderHidden: true,
    }),
    projected('recordJunction1', x0 + 1.85, y0 + 4.0, ['HybridColumnJunction'], {
      diaName: '', displayWidth: 10, displayHeight: 10,
      hybridVisualRole: 'column-junction', hybridCompositionOwnerStableId: recordFunction.key,
    }),
    projected('recordJunction2', x0 + 1.85, y0 + 5.12, ['HybridColumnJunction'], {
      diaName: '', displayWidth: 10, displayHeight: 10,
      hybridVisualRole: 'column-junction', hybridCompositionOwnerStableId: recordFunction.key,
    }),
    projected('recordJunction3', x0 + 1.85, y0 + 5.55, ['HybridColumnJunction'], {
      diaName: '', displayWidth: 10, displayHeight: 10,
      hybridVisualRole: 'column-junction', hybridCompositionOwnerStableId: recordFunction.key,
    }),
    projected('persistSnapshotArgument', x0 + 3.1, y0 + 4.0, ['HybridOperandOccurrence'], {
      diaName: semanticName(roleNode('persistSnapshotArgument')),
      displayWidth: compactWidth(roleNode('persistSnapshotArgument'), 80),
      displayHeight: 44,
      hybridVisualRole: 'operand-occurrence',
      compactCallMosaic: true,
    }),
    projected('sessionStore', x0 + 2.72, y0 + 3.76, ['HybridStateStore'], {
      diaName: semanticName(roleNode('sessionStore')),
      displayWidth: compactWidth(roleNode('sessionStore'), 120),
      displayHeight: 82,
      hybridVisualRole: 'state-store',
    }),
    roleNode('sessionWrite')?.key !== roleNode('sessionStore')?.key && projected('sessionWrite', x0 + 2.8, y0 + 4.03, ['HybridEmbeddedOperation'], {
      diaName: 'write',
      displayWidth: 70,
      displayHeight: 28,
      hybridVisualRole: 'embedded-operation',
      hybridOverlayOwnerStableId: roleNode('sessionStore').key,
      hybridOverlayKind: 'operation-in-value',
      compactCallMosaic: true,
    }),
    projected('caughtError', x0 + 1.85, y0 + 4.58, ['HybridFailureValue'], {
      diaName: semanticName(roleNode('caughtError')),
      displayWidth: 70,
      displayHeight: 28,
      hybridVisualRole: 'failure-value',
    }),
    projected('logCall', x0 + 3.82, y0 + 5.12, ['HybridEmbeddedOperation'], {
      diaName: openCallName(roleNode('logCall')),
      displayWidth: compactTextWidth(openCallName(roleNode('logCall')), 100),
      displayHeight: 32,
      hybridVisualRole: 'producer-call',
      compactCallMosaic: true,
    }),
    projected('errorArgument', x0 + 4.32, y0 + 5.12, ['HybridFailureArgument'], {
      diaName: semanticName(roleNode('errorArgument')),
      displayWidth: 70,
      displayHeight: 28,
      hybridVisualRole: 'failure-argument',
    }),
    projected('logCallClose', x0 + 4.52, y0 + 5.12, ['HybridCallClose'], {
      diaName: ')',
      displayWidth: 30,
      displayHeight: 32,
      hybridVisualRole: 'producer-close',
      compactCallMosaic: true,
    }),
    projected('appStateStore', x0 + 3.62, y0 + 6.12, ['HybridStateStore'], {
      diaName: semanticName(roleNode('appStateStore')),
      displayWidth: compactWidth(roleNode('appStateStore'), 120),
      displayHeight: 82,
      hybridVisualRole: 'state-store',
    }),
    roleNode('stateWrite')?.key !== roleNode('appStateStore')?.key && projected('stateWrite', x0 + 3.7, y0 + 6.36, ['HybridEmbeddedOperation'], {
      diaName: semanticName(roleNode('stateWrite')),
      displayWidth: 70,
      displayHeight: 28,
      hybridVisualRole: 'embedded-operation',
      hybridOverlayOwnerStableId: roleNode('appStateStore').key,
      hybridOverlayKind: 'operation-in-value',
    }),
    projected('nextState', x0 + 4.32, y0 + 6.36, ['HybridObjectValue'], {
      diaName: semanticName(roleNode('nextState'), '{'),
      displayWidth: 74,
      displayHeight: 48,
      hybridVisualRole: 'object-value',
    }),
    projected('previousStateField', x0 + 5.0, y0 + 6.18, ['HybridOperandOccurrence'], {
      diaName: semanticName(roleNode('previousStateField')),
      displayWidth: compactWidth(roleNode('previousStateField'), 80),
      displayHeight: 30,
      hybridVisualRole: 'operand-occurrence',
    }),
    projected('attributionField', x0 + 5.0, y0 + 6.56, ['HybridOperandOccurrence'], {
      diaName: semanticName(roleNode('returnedAttribution')),
      displayWidth: compactWidth(roleNode('returnedAttribution'), 90),
      displayHeight: 30,
      hybridVisualRole: 'operand-occurrence',
    }),
    projected('nextStateComplete', x0 + 5.62, y0 + 6.36, ['HybridObjectValue'], {
      displayWidth: 74,
      displayHeight: 48,
      hybridVisualRole: 'object-value',
    }),
  ].filter(Boolean);

  const projectedEdges = [];
  const addEdge = (type, fromRole, toRole, props = {}) => {
    const start = roleNode(fromRole);
    const end = roleNode(toRole);
    if (!start || !end) return;
    projectedEdges.push(projectionEdge(type, start.key, end.key, {
      ownerStepStableId: stepId,
      owner_step_stable_id: stepId,
      hybridCompositionId: compositionId,
      protocolScenarioId: scenario.scenarioId,
      protocolKind: scenario.protocol,
      ...props,
    }));
  };
  const control = { flow_layer: 'control', strokeColor: '#9a5d00' };
  const data = { flow_layer: 'data', strokeColor: '#6c8ebf' };
  addEdge('MATERIALIZES_ARGUMENT', junctionRole('stateJunction1', 'stateUpdater'), 'incrementCall', {
    ...control, label: '', displayLabel: '',
    sourcePort: 'right-10', targetPort: 'left',
  });
  addEdge('ARG', 'incrementCall', 'previousAttribution', {
    ...data, label: '', displayLabel: '', renderHidden: true,
  });
  addEdge('ArgJoin', 'previousAttribution', 'incrementCallClose', {
    ...data, label: '', displayLabel: '', renderHidden: true,
  });
  addEdge('FIELD', 'newAttribution', 'attributionSpread', {
    ...data, label: '', displayLabel: '', sourcePort: 'right', targetPort: 'left',
  });
  addEdge('FIELD', 'newAttribution', 'promptCount', {
    ...data, label: 'promptCount', displayLabel: 'promptCount',
    sourcePort: 'right', targetPort: 'left',
  });
  addEdge('MATERIALIZES_ARGUMENT', junctionRole('incrementJunction1', 'incrementFunction'), 'recordCall', {
    ...control, label: '', displayLabel: '',
    sourcePort: 'right-76', targetPort: 'left',
  });
  addEdge('ARG', 'recordCall', 'recordSnapshotArgument', {
    ...data, label: '', displayLabel: '', renderHidden: true,
  });
  addEdge('ArgJoin', 'recordSnapshotArgument', 'recordCallClose', {
    ...data, label: '', displayLabel: '', renderHidden: true,
  });
  addEdge('INVOKES', junctionRole('recordJunction1', 'recordFunction'), 'sessionWrite', {
    ...control, label: '', displayLabel: '',
    sourceSemanticStableId: roleNode('sessionWrite').key,
    sourcePort: 'right-37', targetPort: 'left',
  });
  addEdge('PASSES_VALUE', 'persistSnapshotArgument', 'sessionWrite', {
    ...data, label: '', displayLabel: '', renderHidden: true,
    sourcePort: 'right', targetPort: 'left',
  });
  addEdge('ON_FAILURE', 'sessionWrite', 'caughtError', {
    flow_layer: 'control', strokeColor: '#b85450',
    sourcePort: 'bottom', targetPort: 'top',
    label: '.catch', displayLabel: '.catch',
  });
  addEdge('MATERIALIZES_ARGUMENT', junctionRole('recordJunction2', 'recordFunction'), 'logCall', {
    ...control, label: '', displayLabel: '',
    sourcePort: 'right-94', targetPort: 'left',
  });
  addEdge('ARG', 'logCall', 'errorArgument', {
    ...data, label: '', displayLabel: '', renderHidden: true,
  });
  addEdge('ArgJoin', 'errorArgument', 'logCallClose', {
    ...data, label: '', displayLabel: '', renderHidden: true,
  });
  addEdge('MATERIALIZES_ARGUMENT', junctionRole('stateJunction2', 'stateUpdater'), 'stateWrite', {
    ...control, label: '', displayLabel: '',
    sourcePort: 'right-92', targetPort: 'left',
  });
  addEdge('EVAL', 'stateWrite', 'nextState', {
    ...data, label: '', displayLabel: '',
    sourcePort: 'right', targetPort: 'left',
  });
  addEdge('FIELD', 'nextState', 'previousStateField', {
    ...data, label: '', displayLabel: '', sourcePort: 'right', targetPort: 'left',
  });
  addEdge('FIELD', 'nextState', 'attributionField', {
    ...data, label: 'attribution', displayLabel: 'attribution',
    sourcePort: 'right', targetPort: 'left',
  });
  addEdge('FieldJoin', 'previousStateField', 'nextStateComplete', {
    ...data, label: '', displayLabel: '',
    sourcePort: 'right', targetPort: 'left',
  });
  addEdge('FieldJoin', 'attributionField', 'nextStateComplete', {
    ...data, label: '', displayLabel: '',
    sourcePort: 'right', targetPort: 'left',
  });
  addEdge('PASSES_VALUE', 'nextStateComplete', 'stateWrite', {
    ...data, label: '', displayLabel: '',
    sourcePort: 'left', targetPort: 'right',
  });

  const projectedIds = new Set(projectedNodes.map((node) => node.id));
  const stepRenderedIds = new Set(renderedNodes
    .filter((node) => String(node.props?.parentStepStableId || '').trim() === stepId)
    .map((node) => node.id));
  const removalIds = new Set([
    ...projectedIds,
    ...stepRenderedIds,
    ...renderedNodes
      .filter((node) => stepRenderedIds.has(String(node.props?.sourceCallStableId || '')))
      .map((node) => node.id),
  ]);
  const nextNodes = renderedNodes.filter((node) => !removalIds.has(node.id));
  nextNodes.push(...projectedNodes);

  const nextEdges = [];
  for (const edge of renderedEdges) {
    const startInside = removalIds.has(edge.start);
    const endInside = removalIds.has(edge.end);
    if (startInside && endInside) continue;
    const start = startInside && !projectedIds.has(edge.start) ? root.key : edge.start;
    const end = endInside && !projectedIds.has(edge.end) ? root.key : edge.end;
    if (start === end) continue;
    nextEdges.push({
      ...edge,
      start,
      end,
      props: {
        ...edge.props,
        stableId: start,
        targetStableId: end,
      },
    });
  }
  const existingKeys = new Set(nextEdges.map(edgeKey));
  for (const edge of projectedEdges) {
    if (existingKeys.has(edgeKey(edge))) continue;
    existingKeys.add(edgeKey(edge));
    nextEdges.push(edge);
  }

  return {
    nodes: nextNodes,
    edges: nextEdges,
    projectedNodeIds: [...projectedIds],
    projectedEdgeIds: projectedEdges.map((edge) => edge.id),
    protocolStableId: loop.key,
    protocolScenarioId: scenario.scenarioId,
  };
}

function projectExtractedSubmethods({
  loop,
  scenario,
  renderedNodes,
  renderedEdges,
}) {
  const submethods = Array.isArray(scenario.submethods) ? scenario.submethods : [];
  if (!submethods.length) return null;
  const renderedById = new Map(renderedNodes.map((node) => [node.id, node]));
  const records = submethods
    .map((record) => ({
      ...record,
      stableId: String(record.stableId || record.headerStableId || ''),
      headerStableId: String(record.headerStableId || record.stableId || ''),
      parentStableId: String(record.parentStableId || ''),
      memberStableIds: [...new Set((record.memberStableIds || []).map(String).filter(Boolean))],
      attachments: (Array.isArray(record.attachments) ? record.attachments : [])
        .map((attachment) => ({
          stableId: String(attachment.stableId || ''),
          placement: String(attachment.placement || 'right'),
          anchorStableId: String(attachment.anchorStableId || ''),
        }))
        .filter((attachment) => attachment.stableId),
      order: Number(record.order || 0),
    }))
    .filter((record) => record.stableId && renderedById.has(record.headerStableId));
  if (!records.length) return null;

  const byStableId = new Map(records.map((record) => [record.stableId, record]));
  const childrenByParent = new Map();
  for (const record of records) {
    const children = childrenByParent.get(record.parentStableId) || [];
    children.push(record);
    childrenByParent.set(record.parentStableId, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort((left, right) => left.order - right.order);
  }
  const roots = records
    .filter((record) => !record.parentStableId || !byStableId.has(record.parentStableId))
    .sort((left, right) => left.order - right.order);
  const firstRoot = roots[0];
  const firstHeader = renderedById.get(firstRoot?.headerStableId);
  const externalParent = firstRoot?.parentStableId
    ? renderedById.get(firstRoot.parentStableId)
    : null;
  const anchor = nodePosition(externalParent)
    || nodePosition(firstHeader)
    || nodePosition(renderedById.get(loop.key));
  if (!anchor) return null;

  const memberGap = 0.62;
  const rootGap = 0.9;
  const positions = new Map();
  const place = (record, depth, headerY) => {
    const columnGap = record.kind === 'collection-method' ? 0.78 : 1.55;
    const x = anchor.x + depth * columnGap;
    positions.set(record.headerStableId, { x, y: headerY, role: 'submethod-header', record });
    let cursorY = headerY + memberGap;
    for (const memberStableId of record.memberStableIds) {
      const ownsStorageBackplate = record.attachments.some((attachment) => (
        attachment.placement === 'overlay'
        && attachment.anchorStableId === memberStableId
        && hasLabel(renderedById.get(attachment.stableId), 'Storage')
      ));
      if (ownsStorageBackplate) cursorY += 0.4;
      const child = byStableId.get(memberStableId);
      if (child && child.parentStableId === record.stableId) {
        const childBottom = place(child, depth + 1, cursorY);
        cursorY = Math.max(cursorY + memberGap, childBottom + memberGap * 0.35);
        continue;
      }
      if (renderedById.has(memberStableId)) {
        const memberNode = renderedById.get(memberStableId);
        const relativeColumn = Number(prop(
          memberNode?.props,
          'submethodRelativeColumn',
          'submethod_relative_column',
        ));
        const relativeRow = Number(prop(
          memberNode?.props,
          'submethodRelativeRow',
          'submethod_relative_row',
        ));
        const memberX = Number.isFinite(relativeColumn) ? x + relativeColumn * columnGap : x;
        const memberY = Number.isFinite(relativeRow) ? headerY + relativeRow * memberGap : cursorY;
        positions.set(memberStableId, { x: memberX, y: memberY, role: 'submethod-event', record });
        cursorY = Math.max(cursorY + memberGap, memberY + memberGap);
      }
    }
    for (const child of childrenByParent.get(record.stableId) || []) {
      if (positions.has(child.headerStableId)) continue;
      const childBottom = place(child, depth + 1, cursorY);
      cursorY = Math.max(cursorY + memberGap, childBottom + memberGap * 0.35);
    }
    for (const attachment of record.attachments) {
      if (!renderedById.has(attachment.stableId)) continue;
      const attachmentAnchor = positions.get(attachment.anchorStableId)
        || positions.get(record.headerStableId);
      if (!attachmentAnchor) continue;
      const overlay = attachment.placement === 'overlay';
      const attachmentNode = renderedById.get(attachment.stableId);
      const relativeColumn = Number(prop(
        attachmentNode?.props,
        'submethodRelativeColumn',
        'submethod_relative_column',
      ));
      const relativeRow = Number(prop(
        attachmentNode?.props,
        'submethodRelativeRow',
        'submethod_relative_row',
      ));
      const terminal = hasLabel(attachmentNode, 'Exhausted');
      const storageBackplate = overlay && hasLabel(attachmentNode, 'Storage');
      const wideHorizontalOverlay = overlay
        && prop(attachmentNode?.props, 'renderPartsLayout', 'render_parts_layout') === 'horizontal';
      const siblingAttachments = record.attachments.filter((candidate) => (
        candidate.placement === attachment.placement
        && candidate.anchorStableId === attachment.anchorStableId
      ));
      const siblingIndex = siblingAttachments.findIndex((candidate) => candidate.stableId === attachment.stableId);
      const siblingYOffset = !overlay
        && siblingAttachments.length > 1
        && siblingAttachments.every((candidate) => hasLabel(renderedById.get(candidate.stableId), 'Field'))
        ? (siblingIndex - (siblingAttachments.length - 1) / 2) * 0.36
        : 0;
      positions.set(attachment.stableId, {
        x: overlay
          ? attachmentAnchor.x + (storageBackplate ? -0.03 : 0.28)
          : Number.isFinite(relativeColumn)
          ? x + relativeColumn * columnGap + (overlay ? 0.28 : 0)
          : attachmentAnchor.x + (storageBackplate ? -0.03 : wideHorizontalOverlay ? 0.6 : overlay ? 0.28 : terminal ? 0.48 : 1.15),
        y: Number.isFinite(relativeRow)
          ? headerY + relativeRow * memberGap + (storageBackplate ? -0.4 : overlay ? 0.18 : siblingYOffset)
          : attachmentAnchor.y + (storageBackplate ? -0.4 : overlay ? 0.18 : siblingYOffset),
        role: overlay ? 'submethod-overlay' : 'submethod-attachment',
        record,
        anchorStableId: attachment.anchorStableId,
      });
    }
    return cursorY;
  };
  let rootY = anchor.y;
  for (const root of roots) {
    const rootDepth = root.parentStableId && renderedById.has(root.parentStableId) ? 1 : 0;
    const rootHeader = renderedById.get(root.headerStableId);
    const extractedAnchorStableId = String(prop(
      rootHeader?.props,
      'submethodAnchorStableId',
      'submethod_anchor_stable_id',
    ) || '');
    const extractedAnchor = nodePosition(renderedById.get(extractedAnchorStableId));
    const extractedRowOffset = Number(prop(
      rootHeader?.props,
      'substepRowOffset',
      'substep_row_offset',
    ));
    const headerY = extractedAnchor
      ? extractedAnchor.y + (Number.isFinite(extractedRowOffset) ? extractedRowOffset : 1) * memberGap
      : rootY;
    rootY = place(root, rootDepth, headerY) + rootGap;
  }

  const projectedIds = new Set(positions.keys());
  const stepId = String(prop(firstHeader?.props, 'parentStepStableId', 'parent_step_stable_id') || '');
  const sameStepIds = new Set(renderedNodes
    .filter((node) => String(prop(node.props, 'parentStepStableId', 'parent_step_stable_id') || '') === stepId)
    .map((node) => node.id));
  const ancestors = new Set();
  const ancestorQueue = [...projectedIds];
  while (ancestorQueue.length) {
    const targetId = ancestorQueue.pop();
    for (const edge of renderedEdges) {
      if (edge.end !== targetId || !sameStepIds.has(edge.start) || projectedIds.has(edge.start)) continue;
      if (ancestors.has(edge.start)) continue;
      ancestors.add(edge.start);
      ancestorQueue.push(edge.start);
    }
  }
  const downstreamIds = new Set([...sameStepIds].filter((stableId) => (
    !projectedIds.has(stableId) && !ancestors.has(stableId)
  )));
  if (downstreamIds.size) {
    const controlTypes = new Set(['NEXT', 'TRUE', 'FALSE', 'VALUE', 'RESULT', 'REJOINS']);
    const rankById = new Map([...downstreamIds].map((stableId) => [stableId, 0]));
    for (let pass = 0; pass < downstreamIds.size; pass += 1) {
      let changed = false;
      for (const edge of renderedEdges) {
        if (!downstreamIds.has(edge.end) || !controlTypes.has(String(edge.type || edge.props?.type || ''))) continue;
        const sourceRank = downstreamIds.has(edge.start) ? rankById.get(edge.start) : -1;
        const nextRank = sourceRank + 1;
        if (nextRank <= rankById.get(edge.end)) continue;
        rankById.set(edge.end, nextRank);
        changed = true;
      }
      if (!changed) break;
    }
    const projectedBottom = Math.max(...[...positions.values()].map((position) => position.y));
    const downstreamStartY = projectedBottom + memberGap;
    for (const stableId of downstreamIds) {
      const node = renderedById.get(stableId);
      const current = nodePosition(node);
      if (!current) continue;
      positions.set(stableId, {
        x: current.x,
        y: downstreamStartY + (rankById.get(stableId) || 0) * memberGap,
        role: 'submethod-dependent',
        record: firstRoot,
      });
    }
  }

  const projectedNodeIds = [];
  const nodes = renderedNodes.map((node) => {
    const position = positions.get(node.id);
    if (!position) return node;
    const exhausted = hasLabel(node, 'Exhausted');
    const visualRole = exhausted ? 'exhausted-marker' : position.role;
    const submethodHeader = position.role === 'submethod-header';
    const submethodDependent = position.role === 'submethod-dependent';
    const submethodHeaderName = String(
      prop(node.props, 'operationCalleeText', 'operation_callee_text')
      || node.props?.diaName
      || '',
    ).split('.').at(-1)?.replace(/\([^]*$/u, '').trim();
    projectedNodeIds.push(node.id);
    return {
      ...node,
      labels: [...new Set([
        ...(node.labels || []),
        submethodDependent
          ? undefined
          : exhausted
          ? 'HybridExhausted'
          : position.role === 'submethod-header'
          ? 'HybridSubStepHeader'
          : position.role === 'submethod-event'
            ? 'HybridSubStepEvent'
            : 'HybridSubStepAttachment',
      ].filter(Boolean))],
      props: {
        ...(node.props || {}),
        ...(submethodHeader ? {
          diaName: node.props?.diaName || submethodHeaderName,
          splitCallBoundary: '',
          callMosaicRole: '',
          call_mosaic_role: '',
          graphMethodVisual: undefined,
          suppressObjectMethodVisual: true,
        } : {}),
        displayX: position.x,
        displayY: position.y,
        protocolScenarioId: scenario.scenarioId,
        hybridVisualRole: visualRole,
        ...(!submethodDependent ? {
          submethodStableId: position.record.stableId,
          parentSubmethodStableId: position.record.parentStableId,
          submethodPlacement: exhausted ? 'terminal' : position.role.replace('submethod-', ''),
          submethodAnchorStableId: node.props?.submethodAnchorStableId
            || node.props?.submethod_anchor_stable_id
            || position.anchorStableId
            || '',
        } : {}),
        hybridOverlayOwnerStableId: position.role === 'submethod-overlay'
          ? position.anchorStableId || ''
          : '',
        hybridAttachmentOwnerStableId: position.role === 'submethod-attachment'
          ? position.anchorStableId || ''
          : '',
        skipHorizontalCompaction: true,
        layoutTrace: [
          node.props?.layoutTrace,
          `submethod hierarchy ${position.record.stableId}`,
        ].filter(Boolean).join('; '),
      },
    };
  });
  return {
    nodes,
    edges: renderedEdges,
    projectedNodeIds,
    projectedEdgeIds: [],
    protocolStableId: loop.key,
    protocolScenarioId: scenario.scenarioId,
  };
}

function projectExtractedExecutionProtocol({
  loop,
  scenario,
  semanticNodes,
  semanticEdges,
  renderedNodes,
  renderedEdges,
}) {
  if (scenario.protocol === 'state-update-with-callback-effect') {
    return projectExtractedSubmethods({
      loop,
      scenario,
      renderedNodes,
      renderedEdges,
    });
  }
  if (scenario.protocol === 'collection-dispatch-effects') {
    return projectCollectionDispatchProtocol({
      loop,
      scenario,
      semanticNodes,
      renderedNodes,
      renderedEdges,
    });
  }
  if (scenario.protocol === 'collection-accumulate') {
    return projectCollectionAccumulateProtocol({
      loop,
      scenario,
      semanticNodes,
      renderedNodes,
      renderedEdges,
    });
  }
  if (scenario.protocol === 'collection-select') {
    return projectCollectionSelectProtocol({
      loop,
      scenario,
      semanticNodes,
      renderedNodes,
      renderedEdges,
    });
  }
  const semanticById = new Map(semanticNodes.map((node) => [node.key, node]));
  const renderedById = new Map(renderedNodes.map((node) => [node.id, node]));
  const entityByRole = protocolEntityByRole(scenario);
  const semanticForRole = (role) => semanticById.get(entityByRole.get(role)?.actualStableId);
  const renderedForRole = (role) => renderedById.get(entityByRole.get(role)?.actualStableId);
  const target = semanticForRole('target');
  const targetRendered = renderedForRole('target');
  const call = semanticForRole('call');
  const protocolStableIds = new Set(scenario.entities.map((entity) => entity.actualStableId));
  const externalControlPredecessor = call && semanticEdges
    .filter((edge) => (
      edge.end === call.key
      && ['NEXT', 'TRUE', 'FALSE', 'EVAL'].includes(edge.type)
      && !protocolStableIds.has(edge.start)
    ))
    .map((edge) => renderedById.get(edge.start))
    .find((node) => nodePosition(node));
  const anchorPosition = nodePosition(targetRendered)
    || nodePosition(externalControlPredecessor)
    || nodePosition(renderedForRole('call'));
  const lane = (scenario.lanes || []).find((candidate) => (
    candidate.owner === 'iterator'
    && candidate.direction === 'vertical'
    && ['submethod', 'functional-column', 'predicate-chain', 'quasi-function-column'].includes(candidate.visualKind)
  ));
  if (!anchorPosition || !lane) return null;
  const usesPredicateChain = ['predicate-chain', 'quasi-function-column'].includes(lane.visualKind);
  const usesQuasiFunctionColumn = lane.visualKind === 'quasi-function-column';

  const stepId = String(
    target?.props?.parentStepStableId
    || loop.props?.parentStepStableId
    || '',
  ).trim();
  const compositionId = `protocol:${scenario.scenarioId}`;
  const constraints = scenario.constraints || [];
  const overlayOwnerByRole = new Map(constraints
    .filter((constraint) => constraint.type === 'OVERLAYS')
    .map((constraint) => [constraint.subject, constraint.object]));
  const compositionOwnerByRole = new Map(constraints
    .filter((constraint) => constraint.type === 'COMPOSES')
    .map((constraint) => [constraint.subject, constraint.object]));
  const stepSpacing = {
    functionalColumnX: 0.74,
    sourceX: 1.5,
    firstExternalPredicateX: 3.0,
    externalPredicateGapX: 0.85,
    externalCompoundGapX: 0.3,
    itemY: 0.62,
    firstPredicateY: 0.28,
    predicateRowGapY: 0.68,
  };
  const targetX = anchorPosition.x;
  const headerY = anchorPosition.y;
  const axisX = targetX + (target ? stepSpacing.functionalColumnX : 1);
  const sourceX = targetX + stepSpacing.sourceX;
  const itemY = headerY + stepSpacing.itemY;
  const predicateRoles = [...new Set(
    scenario.entities
      .filter((entity) => entity.semanticKind === 'Predicate')
      .sort((left, right) => (
        Number(semanticForRole(left.role)?.props?.operation_index ?? Number.MAX_SAFE_INTEGER)
        - Number(semanticForRole(right.role)?.props?.operation_index ?? Number.MAX_SAFE_INTEGER)
      ))
      .map((entity) => entity.role),
  )];
  const branchByPredicateRole = new Map(predicateRoles.map((role) => [
    role,
    predicateBranchForNode(semanticForRole(role), semanticById, semanticEdges),
  ]));
  const predicateRoleByBranchId = new Map(
    [...branchByPredicateRole.entries()]
      .filter(([, branch]) => branch)
      .map(([role, branch]) => [branch.key, role]),
  );
  const predicateCallByRole = new Map(predicateRoles.map((role) => {
    const branch = branchByPredicateRole.get(role);
    const directPredicateCall = branch
      && prop(branch.props, 'callMosaicRole', 'call_mosaic_role') === 'open'
      ? branch
      : null;
    const producerCall = branch && semanticEdges
      .filter((edge) => edge.end === branch.key && edge.type === 'PRODUCES_VALUE')
      .map((edge) => semanticById.get(edge.start))
      .find((node) => hasLabel(node, 'Call') || hasLabel(node, 'Request') || hasLabel(node, 'Op'));
    return [role, directPredicateCall || producerCall];
  }));
  const roleOverlaysFunctionalColumn = (role) => (
    overlayOwnerByRole.get(role) === lane.owner
  );
  const predecessorRoles = new Map(predicateRoles.map((role) => [role, []]));
  for (const [sourceRole, branch] of branchByPredicateRole) {
    if (!branch) continue;
    for (const edge of semanticEdges.filter((candidate) => (
      candidate.start === branch.key
      && (candidate.type === 'TRUE' || candidate.type === 'FALSE')
    ))) {
      const targetRole = predicateRoleByBranchId.get(edge.end);
      if (targetRole) predecessorRoles.get(targetRole)?.push(sourceRole);
    }
  }
  const predicateLevelByRole = new Map();
  for (const role of predicateRoles) {
    const predecessors = predecessorRoles.get(role) || [];
    if (!predecessors.length) {
      predicateLevelByRole.set(role, 0);
      continue;
    }
    const roleOverlaysColumn = roleOverlaysFunctionalColumn(role);
    predicateLevelByRole.set(role, Math.max(...predecessors.map((predecessorRole) => {
      const predecessorLevel = predicateLevelByRole.get(predecessorRole) || 0;
      const predecessorOverlaysColumn = roleOverlaysFunctionalColumn(predecessorRole);
      return predecessorLevel + (predecessorOverlaysColumn && !roleOverlaysColumn ? 0 : 1);
    })));
  }
  const hasCallbackPrelude = semanticNodes.some((node) => (
    String(prop(node.props, 'collectionLoopStableId', 'collection_loop_stable_id') || '') === loop.key
    && (
      hasLabel(node, 'LocalBinding')
      || hasLabel(node, 'ContainerMethod')
      || hasLabel(node, 'Set')
      || (prop(node.props, 'flowLabels', 'flow_labels') || []).includes?.('LocalBinding')
    )
  ));
  const firstPredicateY = itemY + (
    hasCallbackPrelude ? 1.05 : stepSpacing.firstPredicateY
  );
  const predicateYByRole = new Map(predicateRoles.map((role) => [
    role,
    firstPredicateY
      + (predicateLevelByRole.get(role) || 0) * stepSpacing.predicateRowGapY,
  ]));
  const lastStageY = Math.max(itemY, ...predicateYByRole.values());
  const axisTopY = headerY + 0.125;
  const axisBottomY = lastStageY + 0.12;
  const axisHeight = Math.max(110, Math.round((axisBottomY - axisTopY) * 130));
  const axisCenterY = (axisTopY + axisBottomY) / 2;
  const columnRightPortAt = (stageY) => {
    const span = Math.max(0.01, axisBottomY - axisTopY);
    const ratio = Math.max(0.04, Math.min(0.96, (stageY - axisTopY) / span));
    return `right-${Math.round(ratio * 100)}`;
  };

  const headerRole = lane.headerRole
    || constraints.find((constraint) => constraint.type === 'HEADS_COLUMN')?.subject
    || 'call';
  const header = semanticForRole(headerRole);
  const iterator = semanticForRole(lane.owner);
  const source = semanticForRole('source');
  const pull = semanticForRole('pull');
  const pulledCandidate = semanticForRole('pulledCandidate');
  const bind = semanticForRole('bind');
  const exhausted = semanticForRole('exhausted');
  const item = semanticForRole('item');
  const assign = semanticForRole('assign');
  const selectedItem = semanticForRole('selectedItem');
  const result = semanticForRole('result');
  if (!header || !iterator || !source || !pull || !pulledCandidate || !item || !result) return null;

  function projected(role, node, x, y, extraLabels = [], extraProps = {}) {
    if (!node) return null;
    const existing = renderedById.get(node.key);
    const base = existing || semanticNodeAsRendered(node, x, y);
    return {
      ...base,
      labels: [...new Set([...(base.labels || []), ...extraLabels])],
      props: {
        ...(base.props || {}),
        ...extraProps,
        parentStepStableId: stepId,
        displayX: x,
        displayY: y,
        hybridCompositionId: compositionId,
        protocolScenarioId: scenario.scenarioId,
        protocolRole: role,
        renderHidden: false,
        skipHorizontalCompaction: true,
        layoutTrace: [
          base.props?.layoutTrace,
          `execution protocol composition ${scenario.scenarioId}:${role}`,
        ].filter(Boolean).join('; '),
      },
    };
  }

  const projectedNodes = [];
  const targetNode = target && projected('target', target, targetX, headerY, ['HybridTarget'], {
    displayWidth: 210,
    displayHeight: 84,
    hybridVisualRole: 'result-target',
  });
  const assignNode = assign && projected('assign', assign, targetX + 0.08, headerY + 0.22, ['HybridAssignment'], {
    diaName: 'set',
    displayWidth: 80,
    displayHeight: 32,
    hybridVisualRole: 'assignment',
    hybridOverlayOwnerStableId: target.key,
    hybridOverlayKind: 'contained-action',
  });
  const selectedNode = selectedItem && projected('selectedItem', selectedItem, targetX + 0.08, itemY, ['HybridSelectedValue'], {
    displayWidth: 52,
    displayHeight: 24,
    hybridVisualRole: 'selected-value',
  });
  const headerNode = projected(headerRole, header, axisX, headerY, ['Method', 'HybridMethodAxis'], {
    diaName: prop(header.props, 'collectionMethod', 'collection_method')
      || scenario.method
      || header.props?.diaName
      || 'iterate',
    displayWidth: 80,
    displayHeight: 32,
    hybridVisualRole: 'method-axis-header',
    hybridColumnStableId: iterator.key,
    graphMethodVisual: undefined,
    suppressObjectMethodVisual: true,
    splitCallBoundary: undefined,
    callBoundaryDesign: 'single',
    callBoundaryRole: 'single',
    callHasArguments: false,
  });
  const axisNode = usesPredicateChain && !usesQuasiFunctionColumn ? null : projected(lane.owner, iterator, axisX, axisCenterY, ['HybridFunctionalColumn'], {
    diaName: '',
    displayWidth: 10,
    displayHeight: axisHeight,
    hybridVisualRole: 'functional-column',
    hybridColumnBodyKind: usesQuasiFunctionColumn ? 'quasi-function' : 'control',
    hybridColumnCarriesControl: !usesQuasiFunctionColumn,
    hybridAttachmentOwnerStableId: header.key,
    hybridColumnHeaderStableId: header.key,
    hybridHiddenRoleStableIds: lane.hideInternalChain
      ? lane.orderedRoles
          .map((role) => semanticForRole(role)?.key)
          .filter((stableId) => stableId && stableId !== header.key)
      : [],
  });
  const sourceNode = projected('source', source, sourceX, headerY, ['HybridReceiver'], {
    hybridVisualRole: 'collection-receiver',
    displayWidth: 90,
    displayHeight: 64,
  });
  const pullNode = projected('pull', pull, sourceX + 0.05, headerY + 0.28, ['HybridEmbeddedOperation'], {
    diaName: pull.props?.diaName || pull.props?.containerMethodKind || pull.props?.container_method_kind || '',
    hybridVisualRole: 'embedded-operation',
    hybridOverlayOwnerStableId: source.key,
    hybridOverlayKind: 'operation-in-value',
    displayWidth: scenario.protocol === 'collection-search' ? 142 : 72,
    displayHeight: 24,
  });
  const exhaustedNode = exhausted && projected('exhausted', exhausted, sourceX + 0.325, headerY + 0.28, ['HybridExhausted'], {
    diaName: 'x',
    hybridVisualRole: 'exhausted-marker',
    hybridCompositionOwnerStableId: semanticForRole(compositionOwnerByRole.get('exhausted'))?.key || '',
    hybridCompositionKind: 'outcome-of-value',
    displayWidth: 22,
    displayHeight: 22,
  });
  const candidateY = headerY + 0.52;
  const candidateNode = projected(
    'pulledCandidate',
    pulledCandidate,
    sourceX + 0.28,
    candidateY,
    ['HybridCandidateValue'],
    {
      diaName: pulledCandidate.props?.diaName || item.props?.diaName || 'item',
      hybridVisualRole: 'candidate-value',
      displayWidth: 46,
      displayHeight: 20,
    },
  );
  projectedNodes.push(
    targetNode,
    assignNode,
    selectedNode,
    headerNode,
    axisNode,
    sourceNode,
    pullNode,
    exhaustedNode,
    candidateNode,
  );
  if (!selectedItem && result.key !== item.key) {
    projectedNodes.push(projected(
      'result',
      result,
      sourceX + 0.28,
      lastStageY + 0.58,
      ['HybridResult'],
      {
        diaName: result.props?.diaName || 'result',
        hybridVisualRole: 'call-result',
        displayWidth: 104,
        displayHeight: 34,
      },
    ));
  }

  const predicateNodeByRole = new Map();
  const predicateOpeningNodeByRole = new Map();
  const predicateMosaicArgumentsByRole = new Map();
  let externalPredicateIndex = 0;
  for (const role of predicateRoles) {
    const predicate = semanticForRole(role);
    if (!predicate) continue;
    const branch = predicateBranchForNode(predicate, semanticById, semanticEdges);
    if (branch) predicateRoleByBranchId.set(branch.key, role);
    const callInput = predicateCallByRole.get(role)
      || (hasLabel(predicate, 'Branch')
        ? predicateOperandFacts(predicate, semanticNodes, semanticEdges)
            .find((entry) => hasLabel(entry.node, 'Call') || hasLabel(entry.node, 'Request'))?.node
        : null);
    const methodVisual = graphBackedMethodVisual(callInput || predicate, semanticById, semanticEdges);
    const operationCode = prop(predicate.props, 'operationCode', 'operation_code') || '';
    const callPredicate = Boolean(callInput && operationCode === 'boolean-call');
    const overlaysColumn = roleOverlaysFunctionalColumn(role);
    const callBackedExpression = Boolean(callInput && !callPredicate);
    const externalPredicateSlot = overlaysColumn ? null : externalPredicateIndex++;
    const x = overlaysColumn
      ? axisX
      : targetX
        + stepSpacing.firstExternalPredicateX
        + externalPredicateSlot * stepSpacing.externalPredicateGapX
        + (externalPredicateSlot > 0 ? stepSpacing.externalCompoundGapX : 0);
    const y = predicateYByRole.get(role) || itemY;
    const labels = [
      'HybridPredicateStage',
      ...(callPredicate ? ['HybridCallPredicate'] : ['HybridExpressionPredicate']),
      ...(methodVisual?.receiverLabels?.includes('Collection') ? ['Collection'] : []),
      ...(methodVisual ? ['Op'] : []),
      ...(callBackedExpression && callInput ? ['Op'] : []),
    ];
    const callBackedVisual = callBackedExpression && callInput
      ? {
          compositionKind: 'producer-expression',
          receiver: callInput.props?.diaName
            || prop(callInput.props, 'operationCalleeText', 'operation_callee_text')
            || 'call',
          receiverStableId: callInput.key,
          receiverSourceStableId: prop(callInput.props, 'canonicalStableId', 'canonical_stable_id')
            || prop(callInput.props, 'calleeStableId', 'callee_stable_id')
            || '',
          receiverLabels: callInput.labels || [],
          method: [
            prop(predicate.props, 'operationValueText', 'operation_value_text'),
            prop(predicate.props, 'operationCalleeText', 'operation_callee_text'),
          ].filter(Boolean).join(' '),
          methodStableId: predicate.key,
          methodSourceStableId: '',
        }
      : null;
    const operandRolesForPredicate = scenario.relations
      .filter((relation) => (
        relation.to === role
        && (relation.type === 'PASSES_VALUE' || relation.type === 'READS_VALUE')
        && entityByRole.get(relation.from)?.semanticKind === 'OperandOccurrence'
      ))
      .map((relation) => relation.from);
    const operandFeedsCall = (operandRole) => {
      const operand = semanticForRole(operandRole);
      return Boolean(callInput && operand && semanticEdges.some((edge) => (
        edge.start === operand.key
        && edge.end === callInput.key
        && edge.type === 'PASSES_VALUE'
      )));
    };
    const hasGraphBackedOperandOverlay = operandRolesForPredicate.some((operandRole) => (
      !operandFeedsCall(operandRole)
    ));
    const predicateLabel = hasGraphBackedOperandOverlay
      ? prop(predicate.props, 'operationValueText', 'operation_value_text')
        || predicate.props?.label
        || ''
      : predicateText(predicate, semanticNodes, semanticEdges);
    const explicitArgumentRole = operandRolesForPredicate.find(operandFeedsCall);
    const splitCallPredicate = Boolean(callPredicate && callInput);
    const directCallClose = splitCallPredicate
      && prop(callInput.props, 'callMosaicRole', 'call_mosaic_role') === 'open'
      ? semanticNodes.find((node) => (
          prop(node.props, 'callMosaicOwnerStableId', 'call_mosaic_owner_stable_id') === callInput.key
          && prop(node.props, 'callMosaicRole', 'call_mosaic_role') === 'close'
        ))
      : null;
    const semanticMosaicArguments = splitCallPredicate
      ? semanticNodes
          .filter((node) => (
            prop(node.props, 'callMosaicOwnerStableId', 'call_mosaic_owner_stable_id') === callInput.key
            && prop(node.props, 'callMosaicRole', 'call_mosaic_role') === 'argument'
          ))
          .sort((left, right) => (
            Number(prop(left.props, 'argumentIndex', 'argument_index') ?? Number.MAX_SAFE_INTEGER)
            - Number(prop(right.props, 'argumentIndex', 'argument_index') ?? Number.MAX_SAFE_INTEGER)
          ))
      : [];
    const soleMosaicArgument = semanticMosaicArguments.length === 1
      ? semanticMosaicArguments[0]
      : null;
    const callHasArguments = Boolean(
      prop(callInput?.props, 'callHasArguments', 'call_has_arguments')
      ?? explicitArgumentRole
      ?? semanticMosaicArguments.length,
    );
    const callName = prop(callInput?.props, 'operationCalleeText', 'operation_callee_text')
      || callInput?.props?.diaName
      || predicateText(predicate, semanticNodes, semanticEdges);
    const callLabel = explicitArgumentRole
      ? `${String(callName).replace(/\([^]*$/u, '').split('.').at(-1)}(`
      : predicateText(predicate, semanticNodes, semanticEdges);
    const visual = projected(role, directCallClose || predicate, x, y, labels, {
      diaName: hasGraphBackedOperandOverlay
        ? predicateLabel
        : callBackedExpression
          ? [
            prop(predicate.props, 'operationValueText', 'operation_value_text'),
            prop(predicate.props, 'operationCalleeText', 'operation_callee_text'),
          ].filter(Boolean).join(' ')
          : callPredicate ? callLabel : predicateText(predicate, semanticNodes, semanticEdges),
      hybridVisualRole: splitCallPredicate
        ? 'predicate-call-close'
        : callPredicate
          ? 'predicate-call'
          : 'predicate-expression',
      hybridOpenCallBoundary: false,
      ...(splitCallPredicate ? {
        callBoundaryDesign: 'split',
        callBoundaryRole: 'close',
        callBoundaryPeerStableId: callInput.key,
        callHasArguments,
        callPredicate: true,
        suppressObjectMethodVisual: true,
      } : {}),
      hybridOverlayOwnerStableId: splitCallPredicate
        ? ''
        : overlaysColumn
          ? iterator.key
          : [callBackedVisual?.receiverStableId, methodVisual?.receiverStableId]
              .find((stableId) => stableId && renderedById.has(stableId))
            || '',
      hybridOverlayKind: overlaysColumn
        ? 'expression-on-column'
        : callBackedVisual || methodVisual
          ? 'operation-on-receiver'
          : '',
      graphMethodVisual: prop(predicate.props, 'expressionMosaicRole', 'expression_mosaic_role') === 'operator'
        ? undefined
        : hasGraphBackedOperandOverlay && callBackedVisual
          ? { ...callBackedVisual, method: predicateLabel }
          : methodVisual || callBackedVisual || undefined,
      displayWidth: hasLabel(predicate, 'Branch') ? 154 : 144,
      displayHeight: 34,
    });
    if (splitCallPredicate) {
      const openingX = soleMosaicArgument ? x - 0.77 : x - (callHasArguments ? 1.04 : 0.52);
      if (soleMosaicArgument) {
        visual.props = {
          ...visual.props,
          displayWidth: 64,
          displayHeight: 34,
        };
      }
      const opening = projected(`${role}:call-open`, callInput, openingX, y, [
        'Branch',
        'Operand',
        'HybridPredicateStage',
        'HybridCallPredicate',
      ], {
        diaName: String(callName).replace(/\([^]*$/u, '').split('.').at(-1),
        hybridVisualRole: 'predicate-call-open',
        callBoundaryDesign: 'split',
        callBoundaryRole: 'open',
        callBoundaryPeerStableId: visual.id,
        callHasArguments,
        callPredicate: true,
        graphMethodVisual: methodVisual || undefined,
        suppressObjectMethodVisual: !methodVisual,
        displayWidth: soleMosaicArgument ? 104 : 154,
        displayHeight: 34,
      });
      predicateOpeningNodeByRole.set(role, opening);
      projectedNodes.push(opening);
      if (soleMosaicArgument) {
        const argumentVisual = projected(`${role}:call-argument`, soleMosaicArgument, x - 0.35, y, [
          'HybridOperandOccurrence',
          ...(hasLabel(soleMosaicArgument, 'Literal') ? ['Literal'] : []),
        ], {
          displayWidth: 112,
          displayHeight: 34,
          hybridVisualRole: 'predicate-call-argument',
          splitCallBoundary: 'middle',
          callMosaicOwnerStableId: callInput.key,
          callMosaicRole: 'argument',
        });
        predicateMosaicArgumentsByRole.set(role, argumentVisual);
        projectedNodes.push(argumentVisual);
      }
    }
    predicateNodeByRole.set(role, visual);
    projectedNodes.push(visual);
  }

  const predicateRoleForSemanticRole = (role) => {
    if (predicateNodeByRole.has(role)) return role;
    const constrainedRole = constraints.find((constraint) => (
      constraint.type === 'OVERLAYS'
      && constraint.object === role
      && predicateNodeByRole.has(constraint.subject)
    ))?.subject;
    if (constrainedRole) return constrainedRole;

    // A value operand may feed a call which then produces the enclosing
    // predicate. Follow that graph path instead of requiring the renderer
    // scenario to name the intermediate call explicitly.
    const visited = new Set([role]);
    const pending = [role];
    while (pending.length) {
      const currentRole = pending.shift();
      for (const relation of scenario.relations.filter((candidate) => (
        candidate.from === currentRole
        && ['PASSES_VALUE', 'READS_VALUE', 'PRODUCES_VALUE'].includes(candidate.type)
      ))) {
        if (predicateNodeByRole.has(relation.to)) return relation.to;
        if (visited.has(relation.to)) continue;
        const targetKind = entityByRole.get(relation.to)?.semanticKind;
        if (targetKind !== 'ValueProducer' && targetKind !== 'ProtocolStage') continue;
        visited.add(relation.to);
        pending.push(relation.to);
      }
    }
    return undefined;
  };
  const operandNodes = new Map();
  const predicateMosaicArgumentIds = new Set(
    [...predicateMosaicArgumentsByRole.values()].map((node) => node.id),
  );
  for (const entity of scenario.entities.filter((candidate) => (
    candidate.semanticKind === 'OperandOccurrence'
  ))) {
    const operand = semanticForRole(entity.role);
    if (!operand) continue;
    if (predicateMosaicArgumentIds.has(operand.key)) continue;
    const semanticTargetRole = scenario.relations.find((relation) => (
      relation.from === entity.role
      && (relation.type === 'PASSES_VALUE' || relation.type === 'READS_VALUE')
    ))?.to;
    const ownerConstraint = constraints.find((constraint) => (
      constraint.type === 'OVERLAYS' && constraint.subject === entity.role
    ));
    const predicateRole = predicateRoleForSemanticRole(
      ownerConstraint?.object || semanticTargetRole,
    );
    const predicateNode = predicateNodeByRole.get(predicateRole);
    if (!predicateNode) continue;
    const samePredicateOperands = scenario.entities.filter((candidate) => (
      candidate.semanticKind === 'OperandOccurrence'
      && (
        constraints.some((constraint) => (
          constraint.type === 'OVERLAYS'
          && constraint.subject === candidate.role
          && constraint.object === predicateRole
        ))
        || scenario.relations.some((relation) => (
          relation.from === candidate.role
          && predicateRoleForSemanticRole(relation.to) === predicateRole
        ))
      )
    ));
    const operandIndex = Math.max(0, samePredicateOperands.findIndex((candidate) => (
      candidate.role === entity.role
    )));
    const predicateCall = predicateCallByRole.get(predicateRole);
    const feedsCallBeforePredicate = scenario.relations.some((relation) => (
      relation.from === entity.role
      && relation.type === 'PASSES_VALUE'
      && entityByRole.get(relation.to)?.semanticKind === 'ValueProducer'
    )) || Boolean(predicateCall && semanticEdges.some((edge) => (
      edge.start === operand.key
      && edge.end === predicateCall.key
      && edge.type === 'PASSES_VALUE'
    )));
    const directlyReadByPredicate = scenario.relations.some((relation) => (
      relation.from === entity.role
      && relation.type === 'READS_VALUE'
      && predicateRoleForSemanticRole(relation.to) === predicateRole
    ));
    const overlaysPredicate = ownerConstraint?.object === predicateRole
      || (!ownerConstraint && directlyReadByPredicate && !feedsCallBeforePredicate);
    const operandName = operand.props?.diaName || operand.props?.label || 'value';
    const width = Math.max(46, Math.min(96, 18 + operandName.length * 7));
    const x = overlaysPredicate
      ? Number(predicateNode.props.displayX)
        + (samePredicateOperands.length === 1
          ? 0.1
          : 0.15 + (operandIndex - (samePredicateOperands.length - 1) / 2) * 0.34)
      : Number(predicateNode.props.displayX) - 0.52;
    const y = Number(predicateNode.props.displayY);
    const visual = projected(entity.role, operand, x, y, ['HybridOperandOccurrence'], {
      diaName: operandName,
      hybridVisualRole: 'operand-occurrence',
      hybridOverlayOwnerStableId: overlaysPredicate ? predicateNode.id : '',
      hybridAttachmentOwnerStableId: overlaysPredicate
        && predicateNode.props?.hybridOverlayOwnerStableId === iterator.key
        && operandIndex === 0
        ? iterator.key
        : '',
      hybridOverlayKind: overlaysPredicate ? 'operand-in-expression' : '',
      displayWidth: width,
      displayHeight: 20,
    });
    operandNodes.set(entity.role, visual);
    projectedNodes.push(visual);
  }

  const projectedEdges = [];
  const addProjectedEdge = (type, start, end, props = {}) => {
    if (!start || !end) return;
    projectedEdges.push(projectionEdge(type, start, end, {
      ownerStepStableId: stepId,
      owner_step_stable_id: stepId,
      hybridCompositionId: compositionId,
      protocolScenarioId: scenario.scenarioId,
      ...props,
    }));
  };
  for (const [role, opening] of predicateOpeningNodeByRole) {
    const closing = predicateNodeByRole.get(role);
    if (predicateMosaicArgumentsByRole.has(role)) continue;
    const argumentsForCall = [...operandNodes.entries()]
      .filter(([operandRole]) => {
        const relation = scenario.relations.find((candidate) => (
          candidate.from === operandRole
          && (candidate.type === 'PASSES_VALUE' || candidate.type === 'READS_VALUE')
        ));
        return predicateRoleForSemanticRole(relation?.to) === role;
      })
      .map(([, operand]) => operand)
      .sort((left, right) => Number(left.props.displayX) - Number(right.props.displayX));
    if (!argumentsForCall.length) {
      addProjectedEdge('ArgJoin', opening.id, closing?.id, {
        label: '',
        displayLabel: '',
        flow_layer: 'data',
        sourcePort: 'right',
        targetPort: 'left',
      });
      continue;
    }
    argumentsForCall.forEach((argument, index) => {
      addProjectedEdge('ARG', opening.id, argument.id, {
        label: '',
        displayLabel: '',
        argumentIndex: index,
        flow_layer: 'data',
        sourcePort: 'right',
        targetPort: 'left',
      });
      addProjectedEdge('ArgJoin', argument.id, closing?.id, {
        label: '',
        displayLabel: '',
        argumentIndex: index,
        flow_layer: 'data',
        sourcePort: 'right',
        targetPort: 'left',
      });
    });
  }
  const evalRelation = scenario.relations.find((relation) => relation.type === 'EVAL');
  const evalSource = semanticForRole(evalRelation?.from);
  const evalTarget = semanticForRole(evalRelation?.to);
  if (evalSource && evalTarget) {
    addProjectedEdge('EVAL', evalSource.key, evalTarget.key, {
      label: 'EVAL',
      displayLabel: 'EVAL',
      flow_layer: 'control',
      oneWay: true,
      strokeColor: '#9a5d00',
      sourcePort: 'right',
      targetPort: 'left',
    });
  }
  addProjectedEdge('PULLS_VALUE', usesPredicateChain ? header.key : iterator.key, pull.key, {
    label: '',
    displayLabel: '',
    flow_layer: 'control',
    sourceSemanticStableId: usesPredicateChain ? header.key : iterator.key,
    sourcePort: usesPredicateChain ? 'right' : columnRightPortAt(axisTopY + (axisBottomY - axisTopY) * 0.04),
    targetPort: 'left',
  });
  addProjectedEdge('YIELDS_VALUE', pull.key, pulledCandidate.key, {
    label: '',
    displayLabel: '',
    flow_layer: 'data',
    sourcePort: 'bottom',
    targetPort: 'top',
  });
  if (!usesPredicateChain) {
    addProjectedEdge('ITEM_AVAILABLE', pulledCandidate.key, iterator.key, {
      label: '',
      displayLabel: '',
      flow_layer: 'data',
      sourceSemanticStableId: pulledCandidate.key,
      targetSemanticStableId: (bind || item).key,
      sourcePort: 'left',
      targetPort: columnRightPortAt(candidateY),
    });
  }
  if (exhausted) {
    addProjectedEdge('EXHAUSTED', pull.key, exhausted.key, {
      label: 'undefined',
      displayLabel: 'undefined',
      flow_layer: 'control',
      sourcePort: 'right',
      targetPort: 'left',
    });
  }
  const firstPredicateRole = predicateRoles[0];
  const firstPredicate = predicateNodeByRole.get(firstPredicateRole);
  const firstPredicateOpening = predicateOpeningNodeByRole.get(firstPredicateRole);
  const firstPredicateOperand = [...operandNodes.entries()]
    .find(([role]) => scenario.relations.some((relation) => (
      relation.from === role && relation.to === firstPredicateRole
    )))?.[1];
  if (firstPredicateOperand) {
    addProjectedEdge('EXTRACTS_VALUE', usesPredicateChain ? pulledCandidate.key : iterator.key, firstPredicateOpening?.id || firstPredicateOperand.id, {
      label: '',
      displayLabel: '',
      flow_layer: 'control',
      sourceSemanticStableId: item.key,
      sourcePort: usesPredicateChain ? 'right' : columnRightPortAt(Number(firstPredicateOperand.props.displayY)),
      targetPort: 'left',
    });
  }
  for (const relation of scenario.relations.filter((candidate) => (
    (candidate.type === 'PASSES_VALUE' || candidate.type === 'READS_VALUE')
    && entityByRole.get(candidate.from)?.semanticKind === 'OperandOccurrence'
  ))) {
    const sourceNode = operandNodes.get(relation.from);
    const targetRole = predicateRoleForSemanticRole(relation.to);
    const targetNode = predicateNodeByRole.get(targetRole);
    if (!sourceNode || !targetNode) continue;
    if (predicateOpeningNodeByRole.has(targetRole)) continue;
    if (sourceNode.props?.hybridOverlayOwnerStableId === targetNode.id) continue;
    if (projectedEdges.some((edge) => (
      edge.start === sourceNode.id
      && edge.end === targetNode.id
      && edge.props?.flow_layer === 'data'
    ))) continue;
    addProjectedEdge(relation.type, sourceNode.id, targetNode.id, {
      label: '',
      displayLabel: '',
      flow_layer: 'data',
      sourcePort: 'right',
      targetPort: 'left',
    });
  }

  const truthyTarget = selectedItem?.key || result.key;
  const protocolBranchRelations = scenario.relations.filter((relation) => (
    relation.type === 'TRUE' || relation.type === 'FALSE'
  ));
  if (protocolBranchRelations.length) {
    for (const relation of protocolBranchRelations) {
      const closingSourceNode = predicateNodeByRole.get(relation.from);
      const openingSourceNode = predicateOpeningNodeByRole.get(relation.from);
      const semanticOpening = semanticForRole(relation.from);
      const outcomeStartsAtOpening = Boolean(
        openingSourceNode
        && semanticOpening
        && semanticEdges.some((edge) => (
          edge.start === semanticOpening.key
          && edge.type === relation.type
        )),
      );
      const sourceNode = outcomeStartsAtOpening
        ? openingSourceNode
        : closingSourceNode;
      const targetPredicateRole = predicateRoleForSemanticRole(relation.to);
      const targetPredicateNode = predicateNodeByRole.get(targetPredicateRole);
      const targetPredicateOpening = predicateOpeningNodeByRole.get(targetPredicateRole);
      const targetInputNode = [...operandNodes.entries()]
        .filter(([operandRole, operandNode]) => (
          operandNode.props?.hybridOverlayOwnerStableId !== targetPredicateNode?.id
          && scenario.relations.some((candidate) => (
            candidate.from === operandRole
            && predicateRoleForSemanticRole(candidate.to) === targetPredicateRole
          ))
        ))
        .map(([, operandNode]) => operandNode)
        .sort((left, right) => (
          Number(left.props?.displayX) - Number(right.props?.displayX)
        ))[0];
      const protocolRoleTargetNode = projectedNodes
        .filter(Boolean)
        .find((node) => node.props?.protocolRole === relation.to);
      const targetNode = targetPredicateOpening
        || operandNodes.get(relation.to)
        || targetInputNode
        || targetPredicateNode
        || protocolRoleTargetNode;
      const projectedTarget = targetNode?.id
        || (relation.to === 'selectedItem' ? truthyTarget : null)
        || (relation.to === lane.owner ? (usesPredicateChain ? header.key : iterator.key) : null)
        || (relation.to === headerRole ? header.key : null);
      if (!sourceNode || !projectedTarget) continue;
      const repeatsToColumn = projectedTarget === iterator.key || projectedTarget === header.key;
      const sourceX = Number(sourceNode.props.displayX);
      const sourceY = Number(sourceNode.props.displayY);
      const targetX = Number(targetNode?.props?.displayX);
      const targetY = Number(targetNode?.props?.displayY);
      const targetIsSelectedValue = projectedTarget === truthyTarget;
      const targetIsBelow = Number.isFinite(targetY) && targetY > sourceY + 0.15;
      const targetIsLeft = Number.isFinite(targetX) && targetX < sourceX;
      const sourceOverlaysColumn = sourceNode.props?.hybridOverlayOwnerStableId === iterator.key;
      const sourcePort = repeatsToColumn
        ? 'top'
        : targetIsSelectedValue
          ? sourceOverlaysColumn ? 'left' : 'bottom'
          : targetIsBelow
            ? targetIsLeft ? 'bottom' : 'bottom-right'
            : targetIsLeft ? 'left' : 'right';
      const targetPort = repeatsToColumn
        ? 'top'
        : targetIsSelectedValue
          ? 'bottom'
          : targetIsBelow && targetIsLeft
            ? 'top-65'
            : targetIsLeft ? 'right' : 'left';
      addProjectedEdge(relation.type, sourceNode.id, projectedTarget, {
        label: relation.type.toLowerCase(),
        displayLabel: relation.type.toLowerCase(),
        flow_layer: 'control',
        sourceSemanticStableId: semanticForRole(relation.from)?.key || '',
        targetSemanticStableId: semanticForRole(relation.to)?.key || '',
        sourcePort,
        targetPort,
      });
    }
  } else {
    for (const role of predicateRoles) {
      const predicate = semanticForRole(role);
      const branch = predicateBranchForNode(predicate, semanticById, semanticEdges);
      const visual = predicateNodeByRole.get(role);
      if (!branch || !visual) continue;
      for (const edge of semanticEdges.filter((candidate) => (
        candidate.start === branch.key
        && (candidate.type === 'TRUE' || candidate.type === 'FALSE')
      ))) {
        const targetRole = predicateRoleByBranchId.get(edge.end);
        const targetNode = targetRole && predicateNodeByRole.get(targetRole);
        const targetOpeningNode = targetRole && predicateOpeningNodeByRole.get(targetRole);
        const targetSemantic = semanticById.get(edge.end);
        const projectedTarget = targetOpeningNode?.id || targetNode?.id
          || (hasLabel(targetSemantic, 'TruthyOutcome') ? truthyTarget : iterator.key);
        addProjectedEdge(edge.type, visual.id, projectedTarget, {
          label: edge.type.toLowerCase(),
          displayLabel: edge.type.toLowerCase(),
          flow_layer: 'control',
          sourceSemanticStableId: branch.key,
          targetSemanticStableId: edge.end,
          sourcePort: projectedTarget === iterator.key
            ? 'top'
            : projectedTarget === truthyTarget
              ? 'bottom'
              : targetNode && Number(targetNode.props.displayX) < Number(visual.props.displayX)
                ? 'left'
                : 'right',
          targetPort: projectedTarget === iterator.key
            ? 'top'
            : projectedTarget === truthyTarget
              ? 'right'
              : targetNode && Number(targetNode.props.displayX) < Number(visual.props.displayX)
                ? 'right'
                : 'left',
        });
      }
    }
  }
  if (selectedItem && assign) {
    addProjectedEdge('ASSIGNS_VALUE', selectedItem.key, assign.key, {
      label: '',
      displayLabel: '',
      flow_layer: 'data',
      sourcePort: 'top',
      targetPort: 'bottom',
    });
  }

  const projectedIds = new Set(projectedNodes.filter(Boolean).map((node) => node.id));
  const hiddenProtocolRoles = new Set(['bind', 'callback', 'item', 'result']);
  const hiddenProtocolIds = new Set(scenario.entities
    .filter((entity) => hiddenProtocolRoles.has(entity.role))
    .map((entity) => entity.actualStableId));
  const sourceCallIds = new Set([...projectedIds, ...hiddenProtocolIds]);
  const removalIds = new Set([
    ...projectedIds,
    ...hiddenProtocolIds,
    ...renderedNodes
      .filter((node) => sourceCallIds.has(String(node.props?.sourceCallStableId || '')))
      .map((node) => node.id),
  ]);
  const nextNodes = renderedNodes.filter((node) => !removalIds.has(node.id));
  nextNodes.push(...projectedNodes.filter(Boolean));

  const nextEdges = [];
  for (const edge of renderedEdges) {
    const startInside = removalIds.has(edge.start);
    const endInside = removalIds.has(edge.end);
    if (startInside && endInside) continue;
    const start = startInside && !projectedIds.has(edge.start) ? result.key : edge.start;
    const end = endInside && !projectedIds.has(edge.end) ? header.key : edge.end;
    if (start === end) continue;
    nextEdges.push({
      ...edge,
      start,
      end,
      props: {
        ...edge.props,
        stableId: start,
        targetStableId: end,
      },
    });
  }
  const existingKeys = new Set(nextEdges.map(edgeKey));
  for (const edge of projectedEdges) {
    if (existingKeys.has(edgeKey(edge))) continue;
    existingKeys.add(edgeKey(edge));
    nextEdges.push(edge);
  }

  return {
    nodes: nextNodes,
    edges: nextEdges,
    projectedNodeIds: [...projectedIds],
    projectedEdgeIds: projectedEdges.map((edge) => edge.id),
    protocolStableId: loop.key,
    protocolScenarioId: scenario.scenarioId,
  };
}

function projectCollectionProtocol({
  loop,
  semanticNodes,
  semanticEdges,
  renderedNodes,
  renderedEdges,
}) {
  const semanticById = new Map(semanticNodes.map((node) => [node.key, node]));
  const renderedById = new Map(renderedNodes.map((node) => [node.id, node]));
  const incoming = semanticEdges.filter((edge) => edge.end === loop.key);
  const outgoing = semanticEdges.filter((edge) => edge.start === loop.key);
  const headEdge = incoming.find((edge) => edge.type === 'ITERATES_VALUE')
    || incoming.find((edge) => edge.type === 'READS_VALUE');
  const headStableId = headEdge?.start;
  const renderedHead = headStableId && renderedById.get(headStableId);
  const evaluationSourceEdge = headStableId && semanticEdges.find((edge) => (
    edge.end === headStableId && edge.type === 'EVAL'
  ));
  const evaluationSource = evaluationSourceEdge && renderedById.get(evaluationSourceEdge.start);
  const previousStageStableId = prop(
    loop.props,
    'collectionPreviousStageStableId',
    'collection_previous_stage_stable_id',
  );
  const previousStage = previousStageStableId && semanticById.get(previousStageStableId);
  const previousCallStableId = previousStage?.props?.sourceCallStableId
    || previousStage?.props?.source_call_stable_id;
  const previousCallProxy = previousCallStableId
    && renderedNodes.find((node) => node.props?.sourceCallStableId === previousCallStableId);
  const previousCall = previousCallStableId && renderedById.get(previousCallStableId);
  const invokes = headStableId && semanticEdges.find((edge) => (
    edge.start === headStableId && edge.type === 'INVOKES'
  ));
  const methodProxy = invokes && semanticById.get(invokes.end);
  const renderedMethodProxy = methodProxy && renderedById.get(methodProxy.key);
  const anchor = evaluationSource
    || renderedHead
    || renderedMethodProxy
    || previousCallProxy
    || renderedById.get(previousStageStableId)
    || previousCall;
  const anchorPosition = nodePosition(anchor);
  if (!headStableId || !anchor || !anchorPosition) return null;
  const chainedFromPreviousStage = !renderedHead;

  const pullEdge = outgoing.find((edge) => edge.type === 'PULLS_VALUE');
  const pull = pullEdge && semanticById.get(pullEdge.end);
  const pulledValueEdge = pull && semanticEdges.find((edge) => (
    edge.start === pull.key && edge.type === 'YIELDS_VALUE'
  ));
  const pulledValue = pulledValueEdge && semanticById.get(pulledValueEdge.end);
  const itemAvailableSource = pulledValue || pull;
  const itemAvailable = itemAvailableSource && semanticEdges.find((edge) => (
    edge.start === itemAvailableSource.key && edge.type === 'ITEM_AVAILABLE'
  ));
  const iteration = itemAvailable && semanticById.get(itemAvailable.end);
  const extracts = iteration && semanticEdges.find((edge) => (
    edge.start === iteration.key && edge.type === 'EXTRACTS_VALUE'
  ));
  const item = extracts && semanticById.get(extracts.end);
  const passes = item && (
    semanticEdges.find((edge) => (
      edge.start === item.key
      && edge.type === 'PASSES_VALUE'
      && hasLabel(semanticById.get(edge.end), 'CallbackParams')
    ))
    || semanticEdges.find((edge) => (
      edge.start === item.key && edge.type === 'PASSES_VALUE'
    ))
  );
  const callback = passes && semanticById.get(passes.end);
  if (!pull || !iteration || !item || !callback) return null;

  const onReceiver = methodProxy && semanticEdges.find((edge) => (
    edge.start === methodProxy.key && edge.type === 'ON_RECEIVER'
  ));
  const receiver = onReceiver && semanticById.get(onReceiver.end);
  if (!receiver) return null;

  const resultEdgeTypes = new Set([
    'YIELDS_VALUE',
    'EMITS_VALUE',
    'ACCUMULATES_VALUE',
    'DECIDES_VALUE',
    'PERFORMS_EFFECT',
    'ORDERS_VALUE',
  ]);
  const callbackResultEdge = semanticEdges.find((edge) => (
    resultEdgeTypes.has(edge.type)
    && prop(semanticById.get(edge.end)?.props, 'collectionLoopStableId', 'collection_loop_stable_id') === loop.key
  ));
  const callbackEnd = callbackResultEdge && semanticById.get(callbackResultEdge.start);
  const iterationResult = callbackResultEdge && semanticById.get(callbackResultEdge.end);
  const complete = semanticNodes.find((node) => (
    prop(node.props, 'collectionLoopStableId', 'collection_loop_stable_id') === loop.key
    && prop(node.props, 'primitiveKind', 'primitive_kind') === 'complete'
  ));
  const completedValue = complete && semanticEdges.find((edge) => (
    edge.start === complete.key && edge.type === 'COMPLETES_VALUE'
  ));
  const finalResult = completedValue && semanticById.get(completedValue.end);
  const selectedValue = semanticNodes.find((node) => (
    prop(node.props, 'collectionIterationStableId', 'collection_iteration_stable_id') === iteration.key
    && hasLabel(node, 'ValuePass')
  ));
  const selectedAssignmentEdge = selectedValue && semanticEdges.find((edge) => (
    edge.start === selectedValue.key && edge.type === 'ASSIGNS_VALUE'
  ));
  const directAssignment = selectedAssignmentEdge && semanticById.get(selectedAssignmentEdge.end);
  const directTargetEdge = directAssignment && semanticEdges.find((edge) => (
    edge.start === directAssignment.key && edge.type === 'TARGETS_VALUE'
  ));
  const directAssignmentTarget = directTargetEdge && renderedById.get(directTargetEdge.end);
  const directConsumerOperation = semanticNodes.find((node) => (
    prop(node.props, 'collectionIterationStableId', 'collection_iteration_stable_id') === iteration.key
    && ['emit', 'accumulate'].includes(prop(node.props, 'primitiveKind', 'primitive_kind'))
  ));
  const directConsumerTargetEdge = directConsumerOperation && semanticEdges.find((edge) => (
    edge.start === directConsumerOperation.key
    && ['EMITS_VALUE', 'ACCUMULATES_VALUE'].includes(edge.type)
  ));
  const directConsumerTarget = directConsumerTargetEdge
    && renderedById.get(directConsumerTargetEdge.end);
  const directConsumerInputEdge = directConsumerOperation && semanticEdges.find((edge) => (
    edge.end === directConsumerOperation.key
    && edge.type === 'PASSES_VALUE'
    && edge.props?.label !== 'seed'
  ));
  const directConsumerInput = directConsumerInputEdge
    && semanticById.get(directConsumerInputEdge.start);

  const stepId = String(loop.props?.parentStepStableId || '').trim();
  const axisX = anchorPosition.x + (chainedFromPreviousStage ? 1.05 : 1.65);
  const headerY = anchorPosition.y;
  const callbackIds = collectCallbackProjectionIds(
    callback.key,
    renderedEdges,
    renderedById,
    stepId,
  );
  const predicateProjection = projectPredicateCallback({
    callback,
    callbackIds,
    semanticNodes,
    semanticEdges,
    renderedById,
    axisX,
    headerY,
  });
  const callbackRendered = renderedById.get(callback.key);
  const callbackPosition = nodePosition(callbackRendered);
  const callbackTarget = { x: axisX + 1.45, y: headerY + 0.82 };
  const callbackShift = callbackPosition
    ? {
        x: callbackTarget.x - callbackPosition.x,
        y: callbackTarget.y - callbackPosition.y,
      }
    : { x: 0, y: 0 };

  const repositionedCallbackNodes = [];
  let callbackMaxX = callbackTarget.x;
  let callbackMaxY = callbackTarget.y;
  for (const id of callbackIds) {
    if (predicateProjection?.hiddenIds.has(id)) continue;
    if (directAssignment && hasLabel(renderedById.get(id), 'ValueOutcome')) continue;
    const predicateNode = predicateProjection?.projectedNodes.find((node) => node.id === id);
    if (predicateNode) {
      callbackMaxX = Math.max(callbackMaxX, predicateNode.props.displayX);
      callbackMaxY = Math.max(callbackMaxY, predicateNode.props.displayY);
      repositionedCallbackNodes.push(predicateNode);
      continue;
    }
    const node = renderedById.get(id);
    const position = nodePosition(node);
    if (!node || !position) continue;
    const projected = {
      ...node,
      props: {
        ...node.props,
        displayX: position.x + callbackShift.x,
        displayY: position.y + callbackShift.y,
        hybridProjection: 'collection-callback',
      },
    };
    callbackMaxX = Math.max(callbackMaxX, projected.props.displayX);
    callbackMaxY = Math.max(callbackMaxY, projected.props.displayY);
    repositionedCallbackNodes.push(projected);
  }
  for (const predicateNode of predicateProjection?.projectedNodes || []) {
    if (repositionedCallbackNodes.some((node) => node.id === predicateNode.id)) continue;
    callbackMaxX = Math.max(callbackMaxX, predicateNode.props.displayX);
    callbackMaxY = Math.max(callbackMaxY, predicateNode.props.displayY);
    repositionedCallbackNodes.push(predicateNode);
  }

  const receiverX = axisX + 0.82;
  const receiverY = headerY + 0.08;
  const itemY = headerY + 0.82;
  const completionY = Math.max(callbackMaxY + 0.7, headerY + 1.8);
  const axisHeight = Math.max(
    100,
    Math.round((completionY - headerY) * 130 - 61),
  );
  const resultX = Math.max(callbackMaxX + 0.62, receiverX + 1.15);
  const assignmentX = anchorPosition.x + 0.62;
  const assignmentY = headerY + 0.12;
  const selectedValueY = headerY + 0.7;

  const projectedNodes = [
    semanticNodeAsRendered(withoutLabels(loop, ['Loop']), axisX, headerY, ['Method', 'HybridMethodAxis'], {
      diaName: prop(loop.props, 'collectionMethod', 'collection_method')
        || loop.props?.diaName
        || 'iterate',
      hybridVisualRole: 'method-axis-header',
      displayWidth: 86,
      displayHeight: 34,
    }),
    semanticNodeAsRendered(
      iteration,
      axisX,
      headerY + ((34 / 2) + (axisHeight / 2) + 8) / 130,
      ['HybridSequenceAxis'],
      {
      diaName: '',
      hybridVisualRole: 'sequence-axis',
      displayWidth: 2,
      displayHeight: axisHeight,
      },
    ),
    semanticNodeAsRendered(receiver, receiverX, receiverY, ['HybridReceiver'], {
      diaName: hasLabel(receiver, 'Call')
        ? `${receiver.props?.callee_name || receiver.props?.diaName || 'call'} result`
        : receiver.props?.diaName,
      hybridVisualRole: 'collection-receiver',
      displayWidth: 150,
      displayHeight: 64,
    }),
    semanticNodeAsRendered(item, receiverX, itemY, ['HybridItem'], {
      diaName: item.props?.diaName || item.props?.label || 'item',
      hybridVisualRole: 'iteration-item',
      displayWidth: 64,
      displayHeight: 30,
    }),
    ...repositionedCallbackNodes,
  ];

  if (selectedValue && directAssignment) {
    projectedNodes.push(
      semanticNodeAsRendered(directAssignment, assignmentX, assignmentY, ['HybridAssignment'], {
        diaName: 'set',
        hybridVisualRole: 'assignment',
        displayWidth: 80,
        displayHeight: 32,
      }),
      semanticNodeAsRendered(selectedValue, assignmentX, selectedValueY, ['HybridSelectedValue'], {
        hybridVisualRole: 'selected-value',
        displayWidth: 52,
        displayHeight: 24,
      }),
    );
  }
  if (directConsumerOperation) {
    projectedNodes.push(semanticNodeAsRendered(
      directConsumerOperation,
      assignmentX,
      selectedValueY,
      ['HybridAssignment'],
      {
        diaName: prop(directConsumerOperation.props, 'primitiveKind', 'primitive_kind') === 'emit'
          ? 'push'
          : 'add',
        hybridVisualRole: 'assignment',
        displayWidth: 72,
        displayHeight: 30,
      },
    ));
  }

  if (iterationResult) {
    projectedNodes.push(semanticNodeAsRendered(
      iterationResult,
      resultX,
      callbackTarget.y,
      ['HybridIterationResult'],
      {
        hybridVisualRole: 'iteration-result',
        displayWidth: 110,
        displayHeight: 34,
      },
    ));
  }
  if (complete) {
    projectedNodes.push(semanticNodeAsRendered(
      complete,
      axisX,
      completionY,
      ['HybridComplete'],
      {
        diaName: 'complete',
        hybridVisualRole: 'sequence-complete',
        displayWidth: 82,
        displayHeight: 32,
      },
    ));
  }
  if (finalResult) {
    projectedNodes.push(semanticNodeAsRendered(
      finalResult,
      resultX + 0.25,
      completionY,
      ['HybridResult'],
      {
        hybridVisualRole: 'call-result',
        displayWidth: 120,
        displayHeight: 52,
      },
    ));
  }

  const projectedEdges = [
    ...(predicateProjection?.projectedEdges || []),
    projectionEdge('PULLS_VALUE', iteration.key, receiver.key, {
      label: 'pull',
      displayLabel: 'pull',
      flow_layer: 'mixed',
      sourcePort: 'right',
      targetPort: 'left',
      sourceSemanticStableId: pull.key,
      targetSemanticStableId: receiver.key,
    }),
    projectionEdge('EXTRACTS_VALUE', receiver.key, item.key, {
      label: 'item',
      displayLabel: '',
      flow_layer: 'data',
      sourcePort: 'bottom',
      targetPort: 'top',
    }),
    projectionEdge('PASSES_VALUE', item.key, predicateProjection?.firstBranchId || callback.key, {
      label: '=>',
      displayLabel: '=>',
      flow_layer: 'data',
      sourcePort: 'right',
      targetPort: 'left',
    }),
  ];
  if (chainedFromPreviousStage) {
    projectedEdges.unshift(projectionEdge('PASSES_VALUE', anchor.id, loop.key, {
      label: 'result',
      displayLabel: '',
      flow_layer: 'data',
      sourcePort: 'right',
      targetPort: 'left',
      sourceSemanticStableId: previousStageStableId || previousCallStableId,
      targetSemanticStableId: loop.key,
    }));
  }

  if (
    predicateProjection
    && (
      (selectedValue && directAssignment)
      || directConsumerOperation
    )
  ) {
    const outcomeNodes = semanticNodes.filter((node) => (
      (
        node.key.startsWith(`${callback.key}:outcome:`)
        || prop(node.props, 'sequenceOwnerStableId', 'sequence_owner_stable_id') === callback.key
      )
      && hasLabel(node, 'ValueOutcome')
    ));
    for (const outcome of outcomeNodes) {
      const truthy = hasLabel(outcome, 'TruthyOutcome');
      const routedEdge = semanticEdges.find((edge) => (
        edge.start === outcome.key
        && (
          truthy
            ? (
                directConsumerOperation
                  ? edge.end === directConsumerOperation.key && edge.type === 'TRUE'
                  : edge.end === directAssignment.key && edge.type === 'TRUE'
              )
            : edge.type === 'REPEATS'
        )
      ));
      if (!routedEdge) continue;
      const incomingOutcomeEdges = semanticEdges.filter((edge) => (
        edge.end === outcome.key && (edge.type === 'TRUE' || edge.type === 'FALSE')
      ));
      for (const outcomeEdge of incomingOutcomeEdges) {
        const outcomeSource = semanticById.get(outcomeEdge.start);
        const outcomeSourceRole = prop(outcomeSource?.props, 'callMosaicRole', 'call_mosaic_role');
        projectedEdges.push(projectionEdge(
          truthy ? 'TRUE' : 'FALSE',
          outcomeEdge.start,
          truthy
            ? (directConsumerOperation?.key || selectedValue.key)
            : iteration.key,
          {
            label: truthy ? 'true' : 'false',
            displayLabel: truthy ? 'true' : 'false',
            flow_layer: 'control',
            sourcePort: outcomeSourceRole === 'close'
              ? 'right'
              : outcomeSourceRole === 'open'
                ? 'bottom'
                : truthy ? 'bottom' : 'left',
            sourcePortCandidates: [outcomeSourceRole === 'close'
              ? 'right'
              : outcomeSourceRole === 'open'
                ? 'bottom'
                : truthy ? 'bottom' : 'left'],
            lockPortCandidates: Boolean(outcomeSourceRole === 'close' || outcomeSourceRole === 'open'),
            targetPort: truthy ? 'right' : 'left',
            sourceSemanticStableId: outcome.key,
            targetSemanticStableId: routedEdge.end,
            semanticProjection: 'hybrid-flow',
          },
        ));
      }
    }
    if (selectedValue && directAssignment) {
      projectedEdges.push(
        projectionEdge('VALUE', selectedValue.key, directAssignment.key, {
          label: 'set',
          displayLabel: '',
          flow_layer: 'data',
          sourcePort: 'top',
          targetPort: 'bottom',
        }),
      );
      if (directAssignmentTarget) {
        projectedEdges.push(projectionEdge('VALUE', directAssignment.key, directAssignmentTarget.id, {
          label: 'set',
          displayLabel: '',
          flow_layer: 'data',
          sourcePort: 'left',
          targetPort: 'right',
        }));
      }
    }
  } else if (predicateProjection && iterationResult) {
    const outcomeNodes = semanticNodes.filter((node) => (
      callbackIds.has(node.key) && hasLabel(node, 'ValueOutcome')
    ));
    for (const outcome of outcomeNodes) {
      const truthy = hasLabel(outcome, 'TruthyOutcome');
      const incomingOutcomeEdges = semanticEdges.filter((edge) => (
        edge.end === outcome.key && (edge.type === 'TRUE' || edge.type === 'FALSE')
      ));
      for (const outcomeEdge of incomingOutcomeEdges) {
        const outcomeSource = semanticById.get(outcomeEdge.start);
        const outcomeSourceRole = prop(outcomeSource?.props, 'callMosaicRole', 'call_mosaic_role');
        projectedEdges.push(projectionEdge(
          truthy ? 'TRUE' : 'FALSE',
          outcomeEdge.start,
          truthy ? iterationResult.key : iteration.key,
          {
            label: truthy ? 'true' : 'false',
            displayLabel: truthy ? 'true' : 'false',
            flow_layer: 'control',
            sourcePort: outcomeSourceRole === 'close'
              ? 'right'
              : outcomeSourceRole === 'open'
                ? 'bottom'
                : truthy ? 'bottom' : 'left',
            sourcePortCandidates: [outcomeSourceRole === 'close'
              ? 'right'
              : outcomeSourceRole === 'open'
                ? 'bottom'
                : truthy ? 'bottom' : 'left'],
            lockPortCandidates: Boolean(outcomeSourceRole === 'close' || outcomeSourceRole === 'open'),
            targetPort: truthy ? 'left' : 'left',
            semanticProjection: 'hybrid-flow',
          },
        ));
      }
    }
    const shortCircuit = complete && semanticEdges.find((edge) => (
      edge.start === iterationResult.key
      && edge.end === complete.key
      && edge.type === 'SHORT_CIRCUITS'
    ));
    if (shortCircuit) {
      projectedEdges.push(projectionEdge('SHORT_CIRCUITS', iterationResult.key, complete.key, {
        label: 'complete',
        displayLabel: 'complete',
        flow_layer: 'control',
        sourcePort: 'bottom',
        targetPort: 'right',
      }));
    }
  } else if (callbackEnd && iterationResult) {
    projectedEdges.push(projectionEdge(
      callbackResultEdge.type,
      callbackEnd.key,
      iterationResult.key,
      {
        label: callbackResultEdge.props?.label || 'result',
        displayLabel: callbackResultEdge.props?.label || '',
        flow_layer: 'data',
        sourcePort: 'right',
        targetPort: 'left',
      },
    ));
    const repeats = semanticEdges.find((edge) => (
      edge.start === iterationResult.key && edge.type === 'REPEATS'
    ));
    if (repeats) {
      projectedEdges.push(projectionEdge('REPEATS', iterationResult.key, iteration.key, {
        label: repeats.props?.label || 'repeat',
        displayLabel: 'repeat',
        flow_layer: 'control',
        sourcePort: 'bottom',
        targetPort: 'left',
      }));
    }
    const shortCircuit = complete && semanticEdges.find((edge) => (
      edge.start === iterationResult.key
      && edge.end === complete.key
      && edge.type === 'SHORT_CIRCUITS'
    ));
    if (shortCircuit) {
      projectedEdges.push(projectionEdge('SHORT_CIRCUITS', iterationResult.key, complete.key, {
        label: shortCircuit.props?.label || 'complete',
        displayLabel: shortCircuit.props?.label || 'complete',
        flow_layer: 'control',
        sourcePort: 'bottom',
        targetPort: 'right',
      }));
    }
  }
  if (directConsumerOperation) {
    if (!predicateProjection && directConsumerInput) {
      projectedEdges.push(projectionEdge(
        directConsumerInputEdge.type,
        directConsumerInput.key,
        directConsumerOperation.key,
        {
          label: directConsumerInputEdge.props?.label || '',
          displayLabel: '',
          flow_layer: 'data',
          sourcePort: 'right',
          targetPort: 'left',
        },
      ));
    }
    if (directConsumerTarget) {
      projectedEdges.push(projectionEdge(
        directConsumerTargetEdge.type,
        directConsumerOperation.key,
        directConsumerTarget.id,
        {
          label: directConsumerOperation.props?.diaName || '',
          displayLabel: directConsumerOperation.props?.diaName || '',
          flow_layer: 'data',
          sourcePort: 'left',
          targetPort: 'right',
        },
      ));
    }
    projectedEdges.push(projectionEdge('REPEATS', directConsumerOperation.key, iteration.key, {
      label: 'repeat',
      displayLabel: 'repeat',
      flow_layer: 'control',
      sourcePort: 'bottom',
      targetPort: 'left',
    }));
  }

  if (complete) {
    projectedEdges.push(projectionEdge('EXHAUSTED', iteration.key, complete.key, {
      label: 'exhausted',
      displayLabel: 'exhausted',
      flow_layer: 'control',
      sourcePort: 'bottom',
      targetPort: 'top',
    }));
  }
  if (complete && finalResult) {
    projectedEdges.push(projectionEdge('COMPLETES_VALUE', complete.key, finalResult.key, {
      label: completedValue?.props?.label || 'result',
      displayLabel: completedValue?.props?.label || 'result',
      flow_layer: 'data',
      sourcePort: 'right',
      targetPort: 'left',
    }));
  }

  const assignmentEdge = finalResult && semanticEdges.find((edge) => (
    edge.start === finalResult.key && edge.type === 'ASSIGNS_VALUE'
  ));
  const assignment = assignmentEdge && semanticById.get(assignmentEdge.end);
  const targetEdge = assignment && semanticEdges.find((edge) => (
    edge.start === assignment.key && edge.type === 'TARGETS_VALUE'
  ));
  const assignmentTarget = targetEdge && renderedById.get(targetEdge.end);
  if (finalResult && assignmentTarget) {
    projectedEdges.push(projectionEdge('RESULT', finalResult.key, assignmentTarget.id, {
      label: 'set',
      displayLabel: 'set',
      flow_layer: 'data',
      sourcePort: 'bottom',
      targetPort: 'bottom',
      assignmentPrimitiveStableId: assignment.key,
    }));
  }
  for (const edge of projectedEdges) {
    edge.props.ownerStepStableId = stepId;
    edge.props.owner_step_stable_id = stepId;
  }

  const removalIds = new Set();
  if (renderedHead) removalIds.add(renderedHead.id);
  if (methodProxy) removalIds.add(methodProxy.key);
  for (const node of renderedNodes) {
    if (
      hasLabel(node, 'FnVisualProxy')
      && String(prop(node.props, 'sourceCallStableId', 'source_call_stable_id') || '') === headStableId
    ) {
      removalIds.add(node.id);
    }
  }
  for (const id of predicateProjection?.hiddenIds || []) removalIds.add(id);
  if (directAssignment || directConsumerOperation) {
    for (const node of renderedNodes) {
      if (
        hasLabel(node, 'ValueOutcome')
        && node.id.startsWith(`${callback.key}:outcome:`)
      ) {
        removalIds.add(node.id);
      }
    }
  }
  for (const node of renderedNodes) {
    if (
      node.id.includes(':arg0:horizontal-owner-')
      && String(node.props?.parentStepStableId || '').trim() === stepId
    ) {
      removalIds.add(node.id);
    }
  }

  const callbackReplacementById = new Map(
    repositionedCallbackNodes.map((node) => [node.id, node]),
  );
  const nextNodes = renderedNodes
    .filter((node) => !removalIds.has(node.id))
    .map((node) => callbackReplacementById.get(node.id) || node)
    .filter((node) => !projectedNodes.some((projected) => projected.id === node.id));
  nextNodes.push(...projectedNodes);

  const nextEdges = renderedEdges
    .map((edge) => renderedHead && edge.end === renderedHead.id
      ? {
          ...edge,
          end: loop.key,
          props: {
            ...edge.props,
            targetStableId: loop.key,
            semanticProjection: 'hybrid-flow',
          },
        }
      : edge)
    .filter((edge) => !removalIds.has(edge.start) && !removalIds.has(edge.end))
    .filter((edge) => (
      edge.props?.semanticProjection === 'hybrid-flow'
      || !COLLECTION_EDGE_TYPES.has(edge.type)
    ))
    .filter((edge) => edge.end !== callback.key || edge.type !== 'ARG');
  const projectedLoopPosition = nodePosition(projectedNodes.find((node) => node.id === loop.key));
  for (const edge of nextEdges) {
    if (edge.end !== loop.key || !projectedLoopPosition) continue;
    const sourcePosition = nodePosition(renderedById.get(edge.start));
    if (!sourcePosition || projectedLoopPosition.x <= sourcePosition.x + 0.4) continue;
    edge.props = {
      ...(edge.props || {}),
      sourcePort: 'right',
      targetPort: 'left',
    };
  }
  const existingIndexByKey = new Map(nextEdges.map((edge, index) => [edgeKey(edge), index]));
  for (const edge of projectedEdges) {
    const key = edgeKey(edge);
    const existingIndex = existingIndexByKey.get(key);
    if (existingIndex !== undefined) {
      if (edge.props?.semanticProjection === 'hybrid-flow') nextEdges[existingIndex] = edge;
      continue;
    }
    existingIndexByKey.set(key, nextEdges.length);
    nextEdges.push(edge);
  }

  return {
    nodes: nextNodes,
    edges: nextEdges,
    projectedNodeIds: projectedNodes.map((node) => node.id),
    projectedEdgeIds: projectedEdges.map((edge) => edge.id),
    protocolStableId: loop.key,
  };
}

function inferredEntity(role, node) {
  if (!node) return null;
  const labels = new Set(node.labels || []);
  let semanticKind = 'ProtocolStage';
  if (labels.has('CallbackParams')) semanticKind = 'Callback';
  else if (labels.has('OperandValue') || labels.has('ArgumentOccurrence')) semanticKind = 'OperandOccurrence';
  else if (labels.has('Predicate') || labels.has('Branch')) semanticKind = 'Predicate';
  else if (labels.has('ValueSlot') || labels.has('LocalBinding')) semanticKind = 'Binding';
  else if (labels.has('Assign')) semanticKind = 'Assign';
  else if (labels.has('Iterator')) semanticKind = 'Iterator';
  else if (labels.has('Pull')) semanticKind = 'Pull';
  else if (labels.has('CandidateValue')) semanticKind = 'CandidateValue';
  else if (labels.has('Element')) semanticKind = 'IterationVariable';
  else if (labels.has('ValuePass')) semanticKind = 'ValueOccurrence';
  else if (labels.has('Collection') && labels.has('Receiver')) semanticKind = 'CollectionOccurrence';
  else if (labels.has('Collection')) semanticKind = 'Collection';
  else if (labels.has('Call') || labels.has('Request') || labels.has('Op')) semanticKind = 'ValueProducer';
  else if (labels.has('Value') || labels.has('Occurrence')) semanticKind = 'ValueOccurrence';
  return {
    role,
    semanticKind,
    actualStableId: node.key,
    labelsAll: [...(node.labels || [])],
    properties: {
      diaName: node.props?.diaName || node.props?.label || '',
      collectionMethod: prop(node.props, 'collectionMethod', 'collection_method') || '',
      relativeAccessText: prop(node.props, 'relativeAccessText', 'relative_access_text') || '',
      expressionSuffix: [
        prop(node.props, 'operationValueText', 'operation_value_text'),
        prop(node.props, 'operationCalleeText', 'operation_callee_text'),
      ].filter(Boolean).join(' '),
    },
  };
}

function extractedExecutionProtocolScenario(root, semanticNodes, semanticEdges) {
  let extractedSubmethods = [];
  try {
    const parsed = JSON.parse(String(prop(
      root.props,
      'submethodsJson',
      'submethods_json',
    ) || '[]'));
    if (Array.isArray(parsed)) extractedSubmethods = parsed;
  } catch {
    extractedSubmethods = [];
  }
  const protocol = String(prop(
    root.props,
    'executionProtocolKind',
    'execution_protocol_kind',
  ) || (extractedSubmethods.length ? 'submethod-hierarchy' : '')).trim();
  if (!protocol) return null;
  const byId = new Map(semanticNodes.map((node) => [node.key, node]));
  const entities = [];
  const roleByStableId = new Map();
  const entityKeys = new Set();
  const add = (role, node) => {
    if (!role || !node) return;
    const entityKey = `${role}\u0000${node.key}`;
    if (entityKeys.has(entityKey)) return;
    entityKeys.add(entityKey);
    entities.push(inferredEntity(role, node));
    const roles = roleByStableId.get(node.key) || [];
    roles.push(role);
    roleByStableId.set(node.key, roles);
  };
  for (const role of prop(root.props, 'executionRoles', 'execution_roles') || []) {
    add(String(role), root);
  }
  semanticNodes
    .filter((node) => String(prop(
      node.props,
      'executionProtocolStableId',
      'execution_protocol_stable_id',
    ) || '') === root.key)
    .sort((left, right) => (
      Number(prop(left.props, 'executionRoleOrder', 'execution_role_order') ?? Number.MAX_SAFE_INTEGER)
      - Number(prop(right.props, 'executionRoleOrder', 'execution_role_order') ?? Number.MAX_SAFE_INTEGER)
    ))
    .forEach((node) => {
      for (const role of prop(node.props, 'executionRoles', 'execution_roles') || []) {
        add(String(role), node);
      }
    });
  try {
    const bindings = JSON.parse(String(prop(
      root.props,
      'executionRoleBindingsJson',
      'execution_role_bindings_json',
    ) || '{}'));
    for (const [role, stableId] of Object.entries(bindings || {})) {
      add(String(role), byId.get(String(stableId)));
    }
  } catch {
    // Invalid extracted metadata makes the protocol unavailable; it never
    // justifies manufacturing projection-only graph entities.
  }
  if (!entities.length) return null;

  // A split predicate call keeps the protocol role on its opening node, while
  // the response-dependent outcome originates at the graph-backed closing
  // proxy. Share the role only for scenario relation inference; the entities
  // and Neo4j topology remain unchanged.
  for (const entity of entities) {
    const opening = byId.get(entity.actualStableId);
    if (prop(opening?.props, 'callMosaicRole', 'call_mosaic_role') !== 'open') continue;
    const closing = semanticNodes.find((node) => (
      prop(node.props, 'callMosaicOwnerStableId', 'call_mosaic_owner_stable_id') === opening.key
      && prop(node.props, 'callMosaicRole', 'call_mosaic_role') === 'close'
    ));
    if (!closing) continue;
    const roles = roleByStableId.get(closing.key) || [];
    if (!roles.includes(entity.role)) roles.push(entity.role);
    roleByStableId.set(closing.key, roles);
  }

  const relations = [];
  for (const edge of semanticEdges) {
    const fromRoles = roleByStableId.get(edge.start) || [];
    const toRoles = roleByStableId.get(edge.end) || [];
    for (const fromRole of fromRoles) {
      for (const toRole of toRoles) {
        relations.push({
          from: fromRole,
          type: edge.type,
          to: toRole,
          name: edge.props?.label || '',
        });
      }
    }
  }
  if (protocol === 'collection-search' && entities.some((entity) => entity.role === 'selectedItem')) {
    for (const entity of entities) {
      const opening = byId.get(entity.actualStableId);
      if (prop(opening?.props, 'callMosaicRole', 'call_mosaic_role') !== 'open') continue;
      const closing = semanticNodes.find((node) => (
        prop(node.props, 'callMosaicOwnerStableId', 'call_mosaic_owner_stable_id') === opening.key
        && prop(node.props, 'callMosaicRole', 'call_mosaic_role') === 'close'
      ));
      if (!closing) continue;
      const acceptedOutcome = semanticEdges.find((edge) => (
        edge.start === closing.key
        && edge.type === 'TRUE'
        && hasLabel(byId.get(edge.end), 'TruthyOutcome')
      ));
      if (!acceptedOutcome) continue;
      if (!relations.some((relation) => (
        relation.from === entity.role
        && relation.type === 'TRUE'
        && relation.to === 'selectedItem'
      ))) {
        relations.push({
          from: entity.role,
          type: 'TRUE',
          to: 'selectedItem',
          name: 'accepted',
        });
      }
    }
  }
  const roleNames = new Set(entities.map((entity) => entity.role));
  const requiredByProtocol = {
    'collection-search': [
      'call', 'iterator', 'source', 'pull',
      'pulledCandidate', 'bind', 'item', 'exhausted', 'result',
    ],
    'collection-select': [
      'target', 'source', 'call', 'iterator',
      'pull', 'pulledCandidate', 'item', 'predicateSource', 'predicateAccess',
      'predicate', 'acceptedItem', 'emit', 'exhausted',
    ],
    'collection-accumulate': [
      'target', 'seed', 'receiver', 'call', 'iterator', 'pull',
      'pulledCandidate', 'item', 'predicateSource', 'contentAccess',
      'coalesce', 'contribution', 'accumulate', 'exhausted',
    ],
    'collection-dispatch-effects': [
      'loopHeader', 'iterator', 'source', 'pull', 'pulledCandidate', 'bind',
      'item', 'exhausted', 'typePredicate', 'imageHeader', 'imageBranch',
      'textHeader', 'textBranch', 'sourceCreateStage', 'imageContentStage',
      'imageRemoteStage', 'textContentStage', 'textRemoteStage',
      'sourceObject', 'sourceTypeField', 'sourceMediaField', 'sourceDataField',
      'sourceObjectComplete', 'sourceAssign', 'sourceTarget',
      'imageContentObject', 'imageContentTypeField', 'imageContentSourceField',
      'imageContentComplete', 'imageContentPush', 'imageContentReceiver',
      'imageRemoteObject', 'imageRemoteTypeField', 'imageRemoteSourceField',
      'imageRemoteComplete', 'imageRemotePush', 'imageRemoteReceiver',
      'textContentObject', 'textContentTypeField', 'textContentTextField',
      'textContentComplete', 'textContentPush', 'textContentReceiver',
      'textRemoteObject', 'textRemoteTypeField', 'textRemoteTextField',
      'textRemoteComplete', 'textRemotePush', 'textRemoteReceiver',
    ],
    'state-update-with-callback-effect': [
      'stateUpdateCall', 'stateUpdater', 'previousAttribution',
      'incrementCall', 'incrementFunction', 'newAttribution',
      'attributionSpread', 'promptCount', 'snapshot', 'returnedAttribution',
      'recordSnapshotArgument', 'persistSnapshotArgument', 'recordCall',
      'recordFunction', 'sessionWrite', 'sessionStore', 'caughtError',
      'errorArgument', 'logCall', 'nextState', 'previousStateField',
      'attributionField', 'nextStateComplete', 'stateWrite', 'appStateStore',
    ],
  };
  const required = requiredByProtocol[protocol];
  if (extractedSubmethods.length === 0 && (!required || required.some((role) => !roleNames.has(role)))) return null;
  const roleForStableId = (stableId) => (roleByStableId.get(String(stableId || '')) || [])[0];
  const extractedLanes = extractedSubmethods.map((submethod) => ({
    owner: roleForStableId(submethod.ownerStableId) || roleForStableId(submethod.headerStableId),
    direction: 'vertical',
    visualKind: 'submethod',
    bodyFlow: 'control',
    headerRole: roleForStableId(submethod.headerStableId),
    parentHeaderRole: roleForStableId(submethod.parentStableId),
    submethodKind: submethod.kind || 'collection-method',
    order: Number(submethod.order || 0),
    hideInternalChain: false,
    orderedRoles: (submethod.memberStableIds || []).map(roleForStableId).filter(Boolean),
  })).filter((lane) => lane.owner && lane.headerRole);
  const lanes = extractedLanes.length
    ? extractedLanes
    : protocol === 'collection-dispatch-effects'
    ? [
        {
          owner: 'iterator',
          direction: 'vertical',
          visualKind: 'functional-column',
          headerRole: 'loopHeader',
          hideInternalChain: true,
          orderedRoles: ['loopHeader', 'iterator', 'bind', 'typePredicate'],
        },
        {
          owner: 'imageBranch',
          direction: 'vertical',
          visualKind: 'functional-column',
          headerRole: 'imageHeader',
          hideInternalChain: true,
          orderedRoles: ['imageHeader', 'sourceCreateStage', 'imageContentStage', 'imageRemoteStage'],
        },
        {
          owner: 'textBranch',
          direction: 'vertical',
          visualKind: 'functional-column',
          headerRole: 'textHeader',
          hideInternalChain: true,
          orderedRoles: ['textHeader', 'textContentStage', 'textRemoteStage'],
        },
      ]
    : protocol === 'state-update-with-callback-effect'
      ? [
          {
            owner: 'stateUpdater',
            direction: 'vertical',
            visualKind: 'functional-column',
            headerRole: 'stateUpdateCall',
            hideInternalChain: true,
            orderedRoles: ['stateUpdateCall', 'stateUpdater', 'nextState'],
          },
          {
            owner: 'incrementFunction',
            direction: 'vertical',
            visualKind: 'functional-column',
            headerRole: 'incrementCall',
            hideInternalChain: true,
            orderedRoles: ['incrementCall', 'incrementFunction', 'newAttribution', 'snapshot', 'returnedAttribution', 'recordSnapshotArgument'],
          },
          {
            owner: 'recordFunction',
            direction: 'vertical',
            visualKind: 'functional-column',
            headerRole: 'recordCall',
            hideInternalChain: true,
            orderedRoles: ['recordCall', 'recordFunction', 'persistSnapshotArgument', 'sessionWrite', 'caughtError', 'errorArgument'],
          },
        ]
      : [{
          owner: 'iterator',
          direction: 'vertical',
          visualKind: 'functional-column',
          headerRole: 'call',
          hideInternalChain: true,
          orderedRoles: entities.map((entity) => entity.role),
        }];
  return {
    id: `extracted:${protocol}:${root.key}`,
    scenarioId: `extracted:${protocol}:${root.key}`,
    protocol,
    method: prop(root.props, 'collectionMethod', 'collection_method') || '',
    sourceSpan: root.key,
    entities,
    relations,
    lanes,
    submethods: extractedSubmethods,
    constraints: [],
    extractedProtocol: true,
  };
}

function expectedVisibleProtocolRoles(scenario) {
  const hiddenRolesByProtocol = {
    'collection-search': new Set([
      'bind',
      'callback',
      'item',
      'result',
      'resultConsumer',
    ]),
    'collection-select': new Set([
      'assign',
      'bind',
      'callback',
      'falsy',
      'producerFunction',
      'truthy',
    ]),
    'collection-accumulate': new Set([
      'accumulatorState',
      'assign',
      'bind',
      'callback',
      'fallback',
    ]),
    'collection-dispatch-effects': new Set([
      'bind',
      'item',
      'sourceCreateStage',
      'imageContentStage',
      'imageRemoteStage',
      'textContentStage',
      'textRemoteStage',
    ]),
    'state-update-with-callback-effect': new Set(['stateUpdateCallClose']),
  };
  const hiddenRoles = hiddenRolesByProtocol[scenario?.protocol];
  if (!hiddenRoles) return [];
  if (scenario?.lanes?.some((lane) => lane.visualKind === 'predicate-chain')) {
    hiddenRoles.add('iterator');
  }
  return [...new Set(
    (scenario.entities || [])
      .map((entity) => entity.role)
      .filter((role) => role && !hiddenRoles.has(role) && !/Receiver$/u.test(role)),
  )];
}

function inferLocalForOfScenario(iterator, semanticNodes, semanticEdges) {
  const byId = new Map(semanticNodes.map((node) => [node.key, node]));
  const outgoing = (id, type) => semanticEdges.filter((edge) => (
    edge.start === id && (!type || edge.type === type)
  ));
  const incoming = (id, type) => semanticEdges.filter((edge) => (
    edge.end === id && (!type || edge.type === type)
  ));
  const through = (id, type) => byId.get(outgoing(id, type)[0]?.end);
  const from = (id, type) => byId.get(incoming(id, type)[0]?.start);
  const sortNodes = (items) => items.filter(Boolean).sort((left, right) => (
    Number(left.props?.operation_index ?? Number.MAX_SAFE_INTEGER)
    - Number(right.props?.operation_index ?? Number.MAX_SAFE_INTEGER)
  ));
  const loopHeader = from(iterator.key, 'ITERATES_VALUE');
  const source = from(iterator.key, 'READS_VALUE');
  const pull = through(iterator.key, 'PULLS_VALUE');
  const pulledCandidate = pull && through(pull.key, 'YIELDS_VALUE');
  const bind = pulledCandidate && through(pulledCandidate.key, 'ITEM_AVAILABLE');
  const item = bind && through(bind.key, 'EXTRACTS_VALUE');
  const exhausted = pull && through(pull.key, 'EXHAUSTED');
  const typePredicate = item && through(item.key, 'PASSES_VALUE');
  const imageHeader = typePredicate && outgoing(typePredicate.key, 'TRUE')
    .map((edge) => byId.get(edge.end))
    .find((node) => (
      hasLabel(node, 'Alternative')
      && prop(node?.props, 'semanticExpansion', 'semantic_expansion') === 'collection-iteration'
    ));
  const textHeader = typePredicate && outgoing(typePredicate.key, 'FALSE')
    .map((edge) => byId.get(edge.end))
    .find((node) => (
      hasLabel(node, 'Alternative')
      && prop(node?.props, 'semanticExpansion', 'semantic_expansion') === 'collection-iteration'
    ));
  const imageBranch = imageHeader && through(imageHeader.key, 'ENTERS');
  const textBranch = textHeader && through(textHeader.key, 'ENTERS');
  if (
    !loopHeader || !source || !pull || !pulledCandidate || !bind || !item
    || !exhausted || !typePredicate || !imageHeader || !imageBranch
    || !textHeader || !textBranch
  ) {
    console.warn(JSON.stringify({
      event: 'hybrid-flow-inference-skipped',
      protocol: 'collection-dispatch-effects',
      iteratorStableId: iterator.key,
      reason: 'core roles',
      missingRoles: Object.entries({
        loopHeader,
        source,
        pull,
        pulledCandidate,
        bind,
        item,
        exhausted,
        typePredicate,
        imageHeader,
        imageBranch,
        textHeader,
        textBranch,
      }).filter(([, node]) => !node).map(([role]) => role),
    }));
    return null;
  }

  const stageChain = (body) => {
    const stages = [];
    let current = through(body.key, 'NEXT');
    while (current && hasLabel(current, 'SequenceStage') && stages.length < 20) {
      stages.push(current);
      current = through(current.key, 'NEXT');
    }
    return stages;
  };
  const imageStages = stageChain(imageBranch);
  const textStages = stageChain(textBranch);
  if (imageStages.length < 3 || textStages.length < 2) {
    console.warn(JSON.stringify({
      event: 'hybrid-flow-inference-skipped',
      protocol: 'collection-dispatch-effects',
      iteratorStableId: iterator.key,
      reason: 'branch stages',
      imageStageCount: imageStages.length,
      textStageCount: textStages.length,
    }));
    return null;
  }

  const entities = [];
  const relations = [];
  const add = (role, node) => {
    const entity = inferredEntity(role, node);
    if (entity) entities.push(entity);
    return node;
  };
  add('loopHeader', loopHeader);
  add('iterator', iterator);
  add('source', source);
  add('pull', pull);
  add('pulledCandidate', pulledCandidate);
  add('bind', bind);
  add('item', item);
  add('exhausted', exhausted);
  add('typePredicate', typePredicate);
  add('imageHeader', imageHeader);
  add('imageBranch', imageBranch);
  add('textHeader', textHeader);
  add('textBranch', textBranch);
  add('sourceCreateStage', imageStages[0]);
  add('imageContentStage', imageStages[1]);
  add('imageRemoteStage', imageStages[2]);
  add('textContentStage', textStages[0]);
  add('textRemoteStage', textStages[1]);

  const addFamily = ({
    prefix,
    stage,
    fieldRoles,
    assignment = false,
  }) => {
    const object = through(stage.key, 'EMITS_EFFECT');
    const fields = object
      ? sortNodes(outgoing(object.key, 'FIELD').map((edge) => byId.get(edge.end)))
      : [];
    const complete = fields[0] && through(fields[0].key, 'FieldJoin');
    if (!object || fields.length < fieldRoles.length || !complete) return false;
    add(`${prefix}Object`, object);
    fieldRoles.forEach((role, index) => {
      add(`${prefix}${role}`, fields[index]);
      const fieldEdge = outgoing(object.key, 'FIELD')
        .find((edge) => edge.end === fields[index].key);
      relations.push({
        from: `${prefix}Object`,
        type: 'FIELD',
        to: `${prefix}${role}`,
        name: fieldEdge?.props?.label || '',
      });
    });
    add(prefix === 'source' ? 'sourceObjectComplete' : `${prefix}Complete`, complete);
    if (assignment) {
      const assign = through(object.key, 'ASSIGNS_VALUE');
      const target = assign && through(assign.key, 'TARGETS_VALUE');
      if (!assign || !target) return false;
      add('sourceAssign', assign);
      add('sourceTarget', target);
      return true;
    }
    const action = through(complete.key, 'ArgJoin') || through(complete.key, 'ARG');
    const receiver = action && through(action.key, 'ON_RECEIVER');
    if (!action || !receiver) return false;
    add(`${prefix}Push`, action);
    add(`${prefix}Receiver`, receiver);
    return true;
  };

  const familiesComplete = [
    addFamily({
      prefix: 'source',
      stage: imageStages[0],
      fieldRoles: ['TypeField', 'MediaField', 'DataField'],
      assignment: true,
    }),
    addFamily({
      prefix: 'imageContent',
      stage: imageStages[1],
      fieldRoles: ['TypeField', 'SourceField'],
    }),
    addFamily({
      prefix: 'imageRemote',
      stage: imageStages[2],
      fieldRoles: ['TypeField', 'SourceField'],
    }),
    addFamily({
      prefix: 'textContent',
      stage: textStages[0],
      fieldRoles: ['TypeField', 'TextField'],
    }),
    addFamily({
      prefix: 'textRemote',
      stage: textStages[1],
      fieldRoles: ['TypeField', 'TextField'],
    }),
  ].every(Boolean);
  if (!familiesComplete) {
    console.warn(JSON.stringify({
      event: 'hybrid-flow-inference-skipped',
      protocol: 'collection-dispatch-effects',
      iteratorStableId: iterator.key,
      reason: 'effect families',
    }));
    return null;
  }

  const scenarioId = `local:collection-dispatch-effects:${iterator.key}`;
  return {
    id: scenarioId,
    scenarioId,
    protocol: 'collection-dispatch-effects',
    method: 'for-of',
    sourceSpan: loopHeader.key,
    entities,
    relations,
    lanes: [
      {
        owner: 'iterator',
        direction: 'vertical',
        visualKind: 'functional-column',
        headerRole: 'loopHeader',
        hideInternalChain: true,
        orderedRoles: ['loopHeader', 'iterator', 'bind', 'typePredicate'],
      },
      {
        owner: 'imageBranch',
        direction: 'vertical',
        visualKind: 'functional-column',
        headerRole: 'imageHeader',
        hideInternalChain: true,
        orderedRoles: ['imageHeader', 'sourceCreateStage', 'imageContentStage', 'imageRemoteStage'],
      },
      {
        owner: 'textBranch',
        direction: 'vertical',
        visualKind: 'functional-column',
        headerRole: 'textHeader',
        hideInternalChain: true,
        orderedRoles: ['textHeader', 'textContentStage', 'textRemoteStage'],
      },
    ],
    constraints: [],
  };
}

function inferLocalCollectionScenario(loop, semanticNodes, semanticEdges) {
  const byId = new Map(semanticNodes.map((node) => [node.key, node]));
  const outgoing = (id, type) => semanticEdges.filter((edge) => (
    edge.start === id && (!type || edge.type === type)
  ));
  const incoming = (id, type) => semanticEdges.filter((edge) => (
    edge.end === id && (!type || edge.type === type)
  ));
  const through = (id, type) => byId.get(outgoing(id, type)[0]?.end);
  const from = (id, type) => byId.get(incoming(id, type)[0]?.start);
  const stepId = String(prop(loop.props, 'parentStepStableId', 'parent_step_stable_id') || '').trim();
  const stepNodes = semanticNodes
    .filter((node) => String(prop(node.props, 'parentStepStableId', 'parent_step_stable_id') || '').trim() === stepId)
    .sort((left, right) => (
      Number(left.props?.operation_index ?? Number.MAX_SAFE_INTEGER)
      - Number(right.props?.operation_index ?? Number.MAX_SAFE_INTEGER)
    ));
  const method = prop(loop.props, 'collectionMethod', 'collection_method') || '';
  const iterationMode = prop(loop.props, 'collectionIterationMode', 'collection_iteration_mode') || '';
  const resultMode = prop(loop.props, 'collectionResultMode', 'collection_result_mode') || '';
  if (method === 'for-of') {
    return inferLocalForOfScenario(loop, semanticNodes, semanticEdges);
  }

  const call = from(loop.key, 'ITERATES_VALUE') || from(loop.key, 'READS_VALUE');
  const pull = through(loop.key, 'PULLS_VALUE');
  const pulledCandidate = pull && through(pull.key, 'YIELDS_VALUE');
  const bind = pulledCandidate && through(pulledCandidate.key, 'ITEM_AVAILABLE');
  const item = bind && through(bind.key, 'EXTRACTS_VALUE');
  const exhausted = pull && through(pull.key, 'EXHAUSTED');
  if (!call || !pull || !pulledCandidate || !bind || !item || !exhausted) return null;
  const invokes = through(call.key, 'INVOKES');
  const methodReceiver = invokes && through(invokes.key, 'ON_RECEIVER');
  const previousStage = incoming(loop.key, 'READS_VALUE')
    .map((edge) => byId.get(edge.start))
    .find((node) => node && node.key !== call.key);
  const source = previousStage || methodReceiver;
  if (!source) return null;

  const target = stepNodes.find((node) => hasLabel(node, 'ValueSlot') && hasLabel(node, 'LocalBinding'));
  const assign = target && from(target.key, 'TARGETS_VALUE');
  if (!target) return null;

  const callback = stepNodes.find((node) => (
    hasLabel(node, 'CallbackParams')
    && prop(node.props, 'collectionLoopStableId', 'collection_loop_stable_id') === loop.key
  ));
  const callbackOwner = callback?.key;
  const callbackNodes = callbackOwner
    ? stepNodes.filter((node) => (
        node.key === callbackOwner
        || prop(node.props, 'sequenceOwnerStableId', 'sequence_owner_stable_id') === callbackOwner
      ))
    : [];
  const branches = callbackNodes
    .filter((node) => hasLabel(node, 'Branch') && hasLabel(node, 'Operand'))
    .sort((left, right) => (
      Number(left.props?.operation_index ?? Number.MAX_SAFE_INTEGER)
      - Number(right.props?.operation_index ?? Number.MAX_SAFE_INTEGER)
    ));

  const entities = [];
  const add = (role, node) => {
    const entity = inferredEntity(role, node);
    if (entity) entities.push(entity);
    return node;
  };
  add('target', target);
  add('assign', assign);
  add('call', call);
  add('iterator', loop);
  add('source', source);
  add('pull', pull);
  add('pulledCandidate', pulledCandidate);
  add('bind', bind);
  add('item', item);
  add('exhausted', exhausted);

  let protocol;
  let orderedRoles = ['call', 'bind'];
  if (iterationMode === 'search' && resultMode === 'element') {
    protocol = 'collection-search';
    const selectedItem = stepNodes.find((node) => (
      hasLabel(node, 'ValuePass')
      && prop(node.props, 'collectionIterationStableId', 'collection_iteration_stable_id') === bind.key
    ));
    add('selectedItem', selectedItem);
    const branchRoles = ['enabledPredicate', 'namePredicate', 'aliasPredicate', 'derivedNamePredicate'];
    branches.forEach((branch, index) => {
      const role = branchRoles[index] || `predicate${index + 1}`;
      const callInput = incoming(branch.key, 'PRODUCES_VALUE')
        .map((edge) => byId.get(edge.start))
        .find(Boolean);
      const predicateNode = callInput || branch;
      add(role, predicateNode);
      const operands = incoming(branch.key, 'READS_VALUE')
        .map((edge) => byId.get(edge.start))
        .filter(Boolean)
        .sort((left, right) => (
          Number(left.props?.operation_index ?? Number.MAX_SAFE_INTEGER)
          - Number(right.props?.operation_index ?? Number.MAX_SAFE_INTEGER)
        ));
      if (index === 0) {
        const argument = callInput && incoming(callInput.key, 'PASSES_VALUE')
          .map((edge) => byId.get(edge.start))
          .find(Boolean);
        add('enabledArgument', argument);
      } else if (index === 1) {
        add('nameLeftOperand', operands[0]);
        add('nameRightOperand', operands[1]);
      } else if (index === 2) {
        const receiver = callInput && through(callInput.key, 'INVOKES');
        add('aliasPredicate', callInput || branch);
        add('aliasReceiver', receiver && through(receiver.key, 'ON_RECEIVER'));
        add('aliasArgument', callInput && incoming(callInput.key, 'PASSES_VALUE')
          .map((edge) => byId.get(edge.start))
          .find(Boolean));
      } else if (index === 3) {
        add('derivedNameCall', callInput);
        add('derivedArgument', callInput && incoming(callInput.key, 'PASSES_VALUE')
          .map((edge) => byId.get(edge.start))
          .find(Boolean));
        add('derivedRightOperand', operands.at(-1));
      }
      orderedRoles.push(role);
    });
    const rightOperand = entities.find((entity) => (
      entity.role === 'nameRightOperand' || entity.role === 'derivedRightOperand'
    ));
    const bindingStableId = rightOperand
      && prop(byId.get(rightOperand.actualStableId)?.props, 'canonicalStableId', 'canonical_stable_id');
    add('commandNameBinding', bindingStableId && byId.get(bindingStableId));
  } else if (iterationMode === 'select' && resultMode === 'collection') {
    protocol = 'collection-select';
    const producerProxy = incoming(source.key)
      .filter((edge) => edge.type === 'PRODUCES_VALUE' || edge.type === 'RESULT')
      .map((edge) => byId.get(edge.start))
      .find((node) => hasLabel(node, 'FnVisualProxy'));
    const producerCall = producerProxy && incoming(producerProxy.key, 'INVOKES')
      .map((edge) => byId.get(edge.start))
      .find(Boolean);
    const inputArgument = producerCall && outgoing(producerCall.key)
      .filter((edge) => edge.type === 'MATERIALIZES_ARGUMENT' || edge.type === 'ARG')
      .map((edge) => byId.get(edge.end))
      .find((node) => hasLabel(node, 'ArgumentOccurrence') || hasLabel(node, 'Arg'));
    const predicate = branches[0];
    const predicateAccess = predicate && incoming(predicate.key, 'READS_VALUE')
      .map((edge) => byId.get(edge.start))
      .find(Boolean);
    const predicateSource = predicateAccess && incoming(predicateAccess.key, 'ON_RECEIVER')
      .map((edge) => byId.get(edge.start))
      .find(Boolean);
    const emit = stepNodes.find((node) => (
      prop(node.props, 'primitiveKind', 'primitive_kind') === 'emit'
      && prop(node.props, 'collectionIterationStableId', 'collection_iteration_stable_id') === bind.key
    ));
    const acceptedItem = emit && incoming(emit.key, 'PASSES_VALUE')
      .map((edge) => byId.get(edge.start))
      .find(Boolean);
    add('inputArgument', inputArgument);
    add('producerCall', producerCall);
    add('producerFunction', producerProxy && outgoing(producerProxy.key)
      .filter((edge) => ['REQUEST', 'CALL', 'READ', 'WRITE'].includes(edge.type))
      .map((edge) => byId.get(edge.end))
      .find((node) => hasLabel(node, 'Fn')));
    add('callback', callback);
    add('predicateSource', predicateSource || predicateAccess);
    add('predicateAccess', predicateAccess);
    add('predicateLiteral', predicate && incoming(predicate.key, 'READS_VALUE')
      .map((edge) => byId.get(edge.start))
      .filter(Boolean)
      .at(-1));
    add('predicate', predicate);
    add('acceptedItem', acceptedItem || item);
    add('emit', emit);
    orderedRoles.push('callback', 'predicate');
  } else if (iterationMode === 'accumulate' && resultMode === 'accumulator') {
    protocol = 'collection-accumulate';
    const seed = stepNodes.find((node) => (
      hasLabel(node, 'Arg')
      && String(node.props?.diaName || node.props?.action_text_raw || '').trim() !== ''
      && node.key !== callback?.key
      && Number(node.props?.operation_index) > Number(call.props?.operation_index)
    ));
    const coalesce = branches[0];
    const contentAccess = coalesce && outgoing(coalesce.key, 'TRUE')
      .map((edge) => byId.get(edge.end))
      .find(Boolean);
    const predicateSource = contentAccess && incoming(contentAccess.key, 'ON_RECEIVER')
      .map((edge) => byId.get(edge.start))
      .find(Boolean);
    const fallback = coalesce && outgoing(coalesce.key, 'FALSE')
      .map((edge) => byId.get(edge.end))
      .find(Boolean);
    const contribution = [contentAccess, fallback]
      .filter(Boolean)
      .flatMap((node) => outgoing(node.key, 'XOR_JOIN'))
      .map((edge) => byId.get(edge.end))
      .find((node) => hasLabel(node, 'Join'));
    const accumulate = stepNodes.find((node) => (
      prop(node.props, 'primitiveKind', 'primitive_kind') === 'accumulate'
      && prop(node.props, 'collectionIterationStableId', 'collection_iteration_stable_id') === bind.key
    ));
    add('receiver', source);
    add('callback', callback);
    add('seed', seed);
    add('accumulatorState', callback);
    add('predicateSource', predicateSource || contentAccess);
    add('contentAccess', contentAccess);
    add('fallback', fallback);
    add('coalesce', coalesce);
    add('contribution', contribution || contentAccess);
    add('accumulate', accumulate);
    orderedRoles.push('callback', 'coalesce');
  } else {
    return null;
  }

  const required = protocol === 'collection-search'
    ? ['target', 'assign', 'call', 'iterator', 'source', 'pull', 'pulledCandidate', 'bind', 'item', 'selectedItem', 'exhausted']
    : protocol === 'collection-select'
      ? ['target', 'inputArgument', 'producerCall', 'source', 'call', 'iterator', 'pull', 'pulledCandidate', 'item', 'predicateSource', 'predicateAccess', 'predicate', 'acceptedItem', 'emit', 'exhausted']
      : ['target', 'seed', 'receiver', 'call', 'iterator', 'pull', 'pulledCandidate', 'item', 'predicateSource', 'contentAccess', 'coalesce', 'contribution', 'accumulate', 'exhausted'];
  const byRole = new Set(entities.map((entity) => entity.role));
  if (required.some((role) => !byRole.has(role))) return null;
  const scenarioId = `local:${protocol}:${loop.key}`;
  const evalTargetRole = protocol === 'collection-search'
    ? 'call'
    : protocol === 'collection-select'
      ? 'producerCall'
      : 'seed';
  return {
    id: scenarioId,
    scenarioId,
    protocol,
    method,
    sourceSpan: loop.key,
    entities,
    relations: [{
      from: 'target',
      type: 'EVAL',
      to: evalTargetRole,
    }],
    lanes: [{
      owner: 'iterator',
      direction: 'vertical',
      visualKind: 'functional-column',
      headerRole: 'call',
      hideInternalChain: true,
      orderedRoles,
    }],
    constraints: [],
  };
}

function inferLocalStateUpdateScenario(root, semanticNodes, semanticEdges) {
  const byId = new Map(semanticNodes.map((node) => [node.key, node]));
  const outgoing = (id, type) => semanticEdges.filter((edge) => (
    edge.start === id && (!type || edge.type === type)
  ));
  const incoming = (id, type) => semanticEdges.filter((edge) => (
    edge.end === id && (!type || edge.type === type)
  ));
  const nodeAtEnd = (edge) => edge && byId.get(edge.end);
  const nodeAtStart = (edge) => edge && byId.get(edge.start);
  const updater = outgoing(root.key, 'INVOKES')
    .map(nodeAtEnd)
    .find((node) => hasLabel(node, 'StateUpdater'));
  if (!updater) return null;
  const stepId = String(prop(root.props, 'parentStepStableId', 'parent_step_stable_id') || '').trim();
  const stepNodes = semanticNodes
    .filter((node) => String(prop(node.props, 'parentStepStableId', 'parent_step_stable_id') || '').trim() === stepId)
    .sort((left, right) => (
      Number(left.props?.operation_index ?? Number.MAX_SAFE_INTEGER)
      - Number(right.props?.operation_index ?? Number.MAX_SAFE_INTEGER)
    ));
  const argumentOccurrences = stepNodes.filter((node) => hasLabel(node, 'ArgumentOccurrence'));
  const callOwningArgument = (argument) => {
    if (!argument) return undefined;
    const isCallStart = (node) => (
      hasLabel(node, 'Start') || hasLabel(node, 'Call') || hasLabel(node, 'Request')
    );
    const direct = [
      ...incoming(argument.key, 'ARG').map(nodeAtStart),
      ...outgoing(argument.key, 'ARG').map(nodeAtEnd),
    ].find(isCallStart);
    if (direct) return direct;
    const proxy = outgoing(argument.key, 'ArgJoin')
      .map(nodeAtEnd)
      .find((node) => hasLabel(node, 'FnVisualProxy'));
    const sourceCallStableId = prop(proxy?.props, 'sourceCallStableId', 'source_call_stable_id');
    return sourceCallStableId ? byId.get(sourceCallStableId) : undefined;
  };
  const previousAttribution = outgoing(updater.key, 'MATERIALIZES_ARGUMENT')
    .map(nodeAtEnd)
    .find((node) => argumentOccurrences.includes(node));
  const incrementCall = callOwningArgument(previousAttribution);
  const functionTargetForCall = (call) => {
    if (!call) return undefined;
    const direct = outgoing(call.key)
      .map((edge) => ({ edge, node: nodeAtEnd(edge) }))
      .find(({ node, edge }) => (
        hasLabel(node, 'Fn')
        && !hasLabel(node, 'FnVisualProxy')
        && ['CALL', 'REQUEST', 'READ', 'WRITE'].includes(edge.type)
      ));
    if (direct) return direct.node;
    const proxy = outgoing(call.key)
      .map(nodeAtEnd)
      .find((node) => hasLabel(node, 'FnVisualProxy'))
      || stepNodes.find((node) => (
      hasLabel(node, 'FnVisualProxy')
      && prop(node.props, 'sourceCallStableId', 'source_call_stable_id') === call.key
      ));
    return proxy && outgoing(proxy.key)
      .map((edge) => ({ edge, node: nodeAtEnd(edge) }))
      .find(({ node, edge }) => (
        hasLabel(node, 'Fn')
        && !hasLabel(node, 'FnVisualProxy')
        && ['CALL', 'REQUEST', 'READ', 'WRITE'].includes(edge.type)
      ))
      ?.node;
  };
  const incrementFunction = functionTargetForCall(incrementCall);
  if (!previousAttribution || !incrementCall || !incrementFunction) return null;
  const incrementEvalValues = outgoing(incrementFunction.key, 'EVAL')
    .map(nodeAtEnd)
    .filter((node) => (
      node
      && prop(node.props, 'semanticExpansion', 'semantic_expansion') === 'call-execution'
      && hasLabel(node, 'ValueSlot')
    ))
    .sort((left, right) => (
      Number(left.props?.operation_index ?? Number.MAX_SAFE_INTEGER)
      - Number(right.props?.operation_index ?? Number.MAX_SAFE_INTEGER)
    ));
  const [newAttribution, snapshot] = incrementEvalValues;
  const returnedAttribution = outgoing(incrementFunction.key, 'MATERIALIZES_RETURN')
    .map(nodeAtEnd)
    .find(Boolean);
  const snapshotBinding = snapshot && prop(snapshot.props, 'bindingStableId', 'binding_stable_id');
  const snapshotTransfer = outgoing(incrementFunction.key, 'MATERIALIZES_ARGUMENT')
    .map(nodeAtEnd)
    .filter((node) => prop(node?.props, 'bindingStableId', 'binding_stable_id') === snapshotBinding)
    .find((node) => outgoing(node.key, 'ARG').some((edge) => hasLabel(nodeAtEnd(edge), 'CallbackFn')));
  const snapshotCallback = snapshotTransfer && outgoing(snapshotTransfer.key, 'ARG')
    .map(nodeAtEnd)
    .find((node) => hasLabel(node, 'CallbackFn'));
  const recordSnapshotArgument = snapshotCallback && outgoing(snapshotCallback.key, 'MATERIALIZES_ARGUMENT')
    .map(nodeAtEnd)
    .find((node) => (
      prop(node?.props, 'bindingStableId', 'binding_stable_id') === snapshotBinding
      && Boolean(callOwningArgument(node))
    ));
  const recordCall = callOwningArgument(recordSnapshotArgument);
  const recordFunction = functionTargetForCall(recordCall);
  const persistSnapshotArgument = recordFunction && outgoing(recordFunction.key, 'MATERIALIZES_ARGUMENT')
    .map(nodeAtEnd)
    .find((node) => outgoing(node.key, 'PASSES_VALUE').length);
  const sessionWrite = persistSnapshotArgument && outgoing(persistSnapshotArgument.key, 'PASSES_VALUE')
    .map(nodeAtEnd)
    .find(Boolean);
  const sessionStore = sessionWrite && hasLabel(sessionWrite, 'Storage')
    ? sessionWrite
    : sessionWrite && outgoing(sessionWrite.key, 'WRITES')
        .map(nodeAtEnd)
        .find(Boolean);
  const caughtError = sessionWrite && outgoing(sessionWrite.key, 'ON_FAILURE')
    .map(nodeAtEnd)
    .find(Boolean)
    || (recordFunction && outgoing(recordFunction.key, 'ON_FAILURE').map(nodeAtEnd).find(Boolean));
  const errorBinding = caughtError && prop(caughtError.props, 'bindingStableId', 'binding_stable_id');
  const errorArgument = errorBinding && stepNodes.find((node) => (
    hasLabel(node, 'ArgumentOccurrence')
    && hasLabel(node, 'Failure')
    && prop(node.props, 'bindingStableId', 'binding_stable_id') === errorBinding
  ));
  const logCall = callOwningArgument(errorArgument);
  const nextState = outgoing(updater.key, 'PASSES_VALUE')
    .map(nodeAtEnd)
    .find((node) => hasLabel(node, 'StateValue') && hasLabel(node, 'Object'));
  const fields = nextState && outgoing(nextState.key, 'FIELD')
    .map(nodeAtEnd)
    .filter(Boolean);
  const nextStateComplete = fields?.[0] && outgoing(fields[0].key, 'FieldJoin')
    .map(nodeAtEnd)
    .find(Boolean);
  const stateWrite = nextStateComplete && outgoing(nextStateComplete.key, 'PASSES_VALUE')
    .map(nodeAtEnd)
    .find((node) => hasLabel(node, 'Write'));
  const appStateStore = stateWrite && hasLabel(stateWrite, 'Storage')
    ? stateWrite
    : stateWrite && outgoing(stateWrite.key, 'WRITES')
        .map(nodeAtEnd)
        .find(Boolean);
  const newAttributionFields = newAttribution && outgoing(newAttribution.key, 'FIELD')
    .map(nodeAtEnd)
    .filter(Boolean);

  const roleNodes = {
    stateUpdateCall: root,
    stateUpdater: updater,
    previousAttribution,
    incrementCall,
    incrementFunction,
    newAttribution,
    attributionSpread: newAttributionFields?.[0],
    promptCount: newAttributionFields?.[1],
    snapshot,
    returnedAttribution,
    recordSnapshotArgument,
    persistSnapshotArgument,
    recordCall,
    recordFunction,
    sessionWrite,
    sessionStore,
    caughtError,
    errorArgument,
    logCall,
    nextState,
    previousStateField: fields?.[0],
    attributionField: fields?.[1],
    nextStateComplete,
    stateWrite,
    appStateStore,
  };
  const requiredRoles = Object.keys(roleNodes);
  const missingRoles = requiredRoles.filter((role) => !roleNodes[role]);
  if (missingRoles.length) {
    console.warn(JSON.stringify({
      event: 'hybrid-flow-inference-skipped',
      protocol: 'state-update-with-callback-effect',
      rootStableId: root.key,
      missingRoles,
    }));
    return null;
  }
  const scenarioId = `local:state-update:${root.key}`;
  return {
    id: scenarioId,
    scenarioId,
    protocol: 'state-update-with-callback-effect',
    sourceSpan: root.key,
    entities: requiredRoles.map((role) => inferredEntity(role, roleNodes[role])),
    relations: [],
    lanes: [
      {
        owner: 'stateUpdater',
        direction: 'vertical',
        visualKind: 'functional-column',
        headerRole: 'stateUpdateCall',
        hideInternalChain: true,
        orderedRoles: ['stateUpdateCall', 'stateUpdater', 'nextState'],
      },
      {
        owner: 'incrementFunction',
        direction: 'vertical',
        visualKind: 'functional-column',
        headerRole: 'incrementCall',
        hideInternalChain: true,
        orderedRoles: ['incrementCall', 'incrementFunction', 'newAttribution', 'snapshot', 'returnedAttribution', 'recordSnapshotArgument'],
      },
      {
        owner: 'recordFunction',
        direction: 'vertical',
        visualKind: 'functional-column',
        headerRole: 'recordCall',
        hideInternalChain: true,
        orderedRoles: ['recordCall', 'recordFunction', 'persistSnapshotArgument', 'sessionWrite', 'caughtError', 'errorArgument'],
      },
    ],
    constraints: [],
  };
}

function projectContainerSetMethods({
  semanticNodes,
  semanticEdges,
  renderedNodes,
  renderedEdges,
}) {
  const semanticById = new Map(semanticNodes.map((node) => [node.key, node]));
  const renderedById = new Map(renderedNodes.map((node) => [node.id, node]));
  const incomingByTarget = new Map();
  const outgoingBySource = new Map();
  for (const edge of semanticEdges) {
    if (!incomingByTarget.has(edge.end)) incomingByTarget.set(edge.end, []);
    incomingByTarget.get(edge.end).push(edge);
    if (!outgoingBySource.has(edge.start)) outgoingBySource.set(edge.start, []);
    outgoingBySource.get(edge.start).push(edge);
  }

  const projectedNodes = [...renderedNodes];
  let projectedEdges = [...renderedEdges];
  const projections = [];

  const producerVisualNode = (sourceId, incomingEdge, visited = new Set()) => {
    if (!sourceId || visited.has(sourceId)) return undefined;
    visited.add(sourceId);
    const direct = renderedById.get(sourceId);
    const source = semanticById.get(sourceId);
    if (hasLabel(source, 'Result')) {
      const producerEdge = (incomingByTarget.get(sourceId) || []).find((edge) => (
        edge.type === 'PRODUCES_VALUE'
      )) || (incomingByTarget.get(sourceId) || []).find((edge) => edge.type === 'RESULT');
      const producer = producerEdge && renderedById.get(producerEdge.start);
      if (producer) return producer;
    }
    if (direct) return direct;

    const upstreamResultEdges = (incomingByTarget.get(sourceId) || [])
      .filter((edge) => ['ArgJoin', 'FieldJoin', 'NEXT', 'PRODUCES_VALUE', 'RESULT', 'RESPONSE'].includes(edge.type))
      .sort((left, right) => (
        ['PRODUCES_VALUE', 'RESULT', 'RESPONSE', 'NEXT', 'ArgJoin', 'FieldJoin'].indexOf(left.type)
        - ['PRODUCES_VALUE', 'RESULT', 'RESPONSE', 'NEXT', 'ArgJoin', 'FieldJoin'].indexOf(right.type)
      ));
    for (const edge of upstreamResultEdges) {
      const producer = producerVisualNode(edge.start, edge, visited);
      if (producer) return producer;
    }

    const callSiteStableId = String(prop(
      incomingEdge?.props,
      'callSiteStableId',
      'call_site_stable_id',
    ) || '').trim();
    if (callSiteStableId) {
      const proxy = projectedNodes.find((node) => (
        String(prop(node.props, 'sourceCallStableId', 'source_call_stable_id') || '') === callSiteStableId
      ));
      if (proxy) return proxy;
      return renderedById.get(callSiteStableId);
    }
    return undefined;
  };

  const assignments = semanticNodes.filter((node) => (
    hasLabel(node, 'ContainerMethod')
    && hasLabel(node, 'Set')
  ));
  for (const assignment of assignments) {
    const alreadyProjected = renderedById.get(assignment.key);
    if (alreadyProjected?.props?.hybridVisualRole === 'assignment') continue;

    const mergedContainer = prop(
      assignment.props,
      'renderPartsLayout',
      'render_parts_layout',
    ) === 'container-overlay';
    if (mergedContainer) {
      const producerEdges = (incomingByTarget.get(assignment.key) || []).filter((edge) => (
        ['ASSIGNS_VALUE', 'YIELDS_VALUE'].includes(edge.type)
        && ['return-top', 'return-bottom'].includes(prop(
          edge.props,
          'producerRouteRole',
          'producer_route_role',
        ))
      ));
      for (const producerEdge of producerEdges) {
        if (!renderedById.has(producerEdge.start)) {
          const semanticProducer = semanticById.get(producerEdge.start);
          const anchor = producerVisualNode(producerEdge.start, producerEdge);
          const anchorPosition = nodePosition(anchor);
          if (semanticProducer && anchorPosition) {
            const restoredProducer = semanticNodeAsRendered(
              semanticProducer,
              anchorPosition.x + 0.45,
              anchorPosition.y,
              [],
              {
                displayWidth: Math.max(58, Number(prop(semanticProducer.props, 'displayWidth', 'display_width')) || 0),
                displayHeight: Math.max(50, Number(prop(semanticProducer.props, 'displayHeight', 'display_height')) || 0),
                skipHorizontalCompaction: true,
              },
            );
            projectedNodes.push(restoredProducer);
            renderedById.set(restoredProducer.id, restoredProducer);
          }
        }
        if (renderedById.has(producerEdge.start) && !projectedEdges.some((edge) => (
          edge.type === producerEdge.type
          && edge.start === producerEdge.start
          && edge.end === producerEdge.end
        ))) {
          projectedEdges.push(projectionEdge(
            producerEdge.type,
            producerEdge.start,
            producerEdge.end,
            { ...(producerEdge.props || {}), renderHidden: false },
          ));
        }
      }
      continue;
    }
    const targetEdge = (outgoingBySource.get(assignment.key) || []).find((edge) => (
      edge.type === 'TARGETS_VALUE'
    ));
    const target = targetEdge && renderedById.get(targetEdge.end);
    const targetSemantic = targetEdge && semanticById.get(targetEdge.end);
    const targetPosition = nodePosition(target);
    if (!target || !targetSemantic || !targetPosition) continue;
    const existingContainedAction = projectedNodes.find((node) => (
      node.props?.hybridVisualRole === 'assignment'
      && node.props?.hybridOverlayOwnerStableId === target.id
    ));
    if (existingContainedAction) continue;

    const rawProducerEndStableIds = prop(
      assignment.props,
      'producerEndStableIds',
      'producer_end_stable_ids',
    );
    const declaredProducerEndStableIds = new Set(
      (Array.isArray(rawProducerEndStableIds)
        ? rawProducerEndStableIds
        : [rawProducerEndStableIds])
        .map((stableId) => String(stableId || '').trim())
        .filter(Boolean),
    );
    const producerStartStableId = String(prop(
      assignment.props,
      'producerStartStableId',
      'producer_start_stable_id',
    ) || '').trim();
    const producerChainKind = String(prop(
      assignment.props,
      'producerChainKind',
      'producer_chain_kind',
    ) || 'simple');
    const producerEdges = (incomingByTarget.get(assignment.key) || []).filter((edge) => (
      ['ASSIGNS_VALUE', 'PASSES_VALUE', 'YIELDS_VALUE', 'RESPONSE', 'EXHAUSTED'].includes(edge.type)
      && (
        !declaredProducerEndStableIds.size
        || declaredProducerEndStableIds.has(edge.start)
      )
    ));
    let producerEndpoints = producerEdges
      .map((edge) => ({ edge, node: producerVisualNode(edge.start, edge) }))
      .filter(({ node }) => node);
    const producerChainCollapsed = (
      producerEndpoints.length === 0
      && producerChainKind === 'compound'
      && Boolean(producerStartStableId)
    );
    if (producerChainCollapsed) {
      const closingProducer = projectedNodes.find((node) => (
        String(prop(node.props, 'sourceCallStableId', 'source_call_stable_id') || '') === producerStartStableId
        && prop(node.props, 'callBoundaryRole', 'call_boundary_role') === 'close'
      ));
      const collapsedProducer = closingProducer || renderedById.get(producerStartStableId);
      if (collapsedProducer) {
        producerEndpoints = [{
          edge: producerEdges[0],
          node: collapsedProducer,
        }];
      }
    }
    if (!producerEndpoints.length) continue;
    const usesProducerEntryRoute = producerChainKind === 'compound' && !producerChainCollapsed;

    const verticalAssignment = prop(
      assignment.props,
      'renderPartsLayout',
      'render_parts_layout',
    ) === 'vertical';
    const setNode = alreadyProjected
      ? {
        ...alreadyProjected,
        labels: [...new Set([...(alreadyProjected.labels || []), 'HybridAssignment'])],
        props: {
          ...(alreadyProjected.props || {}),
          displayX: targetPosition.x + 0.1,
          displayY: targetPosition.y + 0.18,
          diaName: assignment.props?.diaName || 'set',
          hybridVisualRole: 'assignment',
          hybridOverlayOwnerStableId: target.id,
          hybridOverlayKind: 'contained-action',
          displayWidth: verticalAssignment ? 64 : 48,
          displayHeight: verticalAssignment ? 52 : 24,
          skipHorizontalCompaction: true,
        },
      }
      : semanticNodeAsRendered(
        assignment,
        targetPosition.x + 0.1,
        targetPosition.y + 0.18,
        ['HybridAssignment'],
        {
        diaName: assignment.props?.diaName || 'set',
        hybridVisualRole: 'assignment',
        hybridOverlayOwnerStableId: target.id,
        hybridOverlayKind: 'contained-action',
        displayWidth: verticalAssignment ? 64 : 48,
        displayHeight: verticalAssignment ? 52 : 24,
        skipHorizontalCompaction: true,
        },
      );
    const targetIndex = projectedNodes.findIndex((node) => node.id === target.id);
    projectedNodes[targetIndex] = {
      ...target,
      props: {
        ...target.props,
        hybridVisualRole: 'result-target',
        displayWidth: Math.max(150, Number(target.props?.displayWidth) || 0),
        displayHeight: Math.max(64, Number(target.props?.displayHeight) || 0),
        skipHorizontalCompaction: true,
      },
    };
    const setIndex = projectedNodes.findIndex((node) => node.id === setNode.id);
    if (setIndex >= 0) projectedNodes[setIndex] = setNode;
    else projectedNodes.push(setNode);
    renderedById.set(setNode.id, setNode);

    if (verticalAssignment) {
      for (const valueEdge of projectedEdges.filter((edge) => (
        ['PASSES_VALUE', 'YIELDS_VALUE'].includes(edge.type) && edge.end === setNode.id
      ))) {
        valueEdge.props = {
          ...(valueEdge.props || {}),
          renderHidden: false,
          label: '',
          displayLabel: '',
          flow_layer: 'data',
          sourcePort: 'left',
          targetPort: 'right',
          lockPortCandidates: true,
        };
      }
    }

    for (const { edge: semanticProducerEdge, node: producer } of producerEndpoints) {
      const producerRouteRole = prop(
        semanticProducerEdge?.props,
        'producerRouteRole',
        'producer_route_role',
      ) || (producerEndpoints.length > 1 && producer === producerEndpoints[0].node
        ? 'return-top'
        : 'return-bottom');
      const returnPort = producerRouteRole === 'return-top' ? 'top' : 'bottom';
      const directReturn = !usesProducerEntryRoute;
      const producerEdgeType = semanticProducerEdge?.type || 'ASSIGNS_VALUE';
      const extractedReturn = projectedEdges.find((edge) => (
        edge.type === producerEdgeType
        && edge.start === producer.id
        && edge.end === setNode.id
      ));
      if (!extractedReturn) continue;
      extractedReturn.props = {
        ...(extractedReturn.props || {}),
        label: '',
        displayLabel: '',
        flow_layer: 'data',
        producerRouteRole,
        oneWay: true,
        sourcePort: directReturn ? 'left' : returnPort,
        targetPort: directReturn ? 'right' : returnPort,
        lockPortCandidates: true,
        semanticProducerStableId: semanticProducerEdge?.start || '',
        effectiveProducerStableId: producer.id,
        ownerStepStableId: prop(
          assignment.props,
          'parentStepStableId',
          'parent_step_stable_id',
        ),
      };
    }

    const existingProducerEntry = projectedEdges.find((edge) => (
      edge.type === 'EVAL'
      && edge.start === target.id
      && edge.end === producerStartStableId
    ));
    if (usesProducerEntryRoute && existingProducerEntry) {
      existingProducerEntry.props = {
        ...(existingProducerEntry.props || {}),
        renderHidden: false,
        producerRouteRole: 'entry',
        oneWay: true,
        sourcePort: 'right',
        targetPort: 'left',
        lockPortCandidates: true,
      };
    }
    projections.push({
      assignmentStableId: assignment.key,
      containerStableId: target.id,
      producerStableIds: producerEndpoints.map(({ node }) => node.id),
      producerStartStableId,
      producerChainKind,
      producerChainCollapsed,
    });
  }

  return {
    nodes: projectedNodes,
    edges: projectedEdges,
    projections,
  };
}

function projectExpressionOperandOverlays({
  semanticNodes,
  semanticEdges,
  renderedNodes,
  renderedEdges,
}) {
  const semanticById = new Map(semanticNodes.map((node) => [node.key, node]));
  const renderedById = new Map(renderedNodes.map((node) => [node.id, node]));
  const candidatesByOwner = new Map();

  for (const operand of semanticNodes) {
    if (
      !hasLabel(operand, 'Occurrence')
      || !hasLabel(operand, 'OperandValue')
      || !hasLabel(operand, 'Variable')
    ) continue;
    const ownerId = String(prop(
      operand.props,
      'sequenceOwnerStableId',
      'sequence_owner_stable_id',
    ) || '').trim();
    const owner = semanticById.get(ownerId);
    const renderedOwner = renderedById.get(ownerId);
    if (
      !owner
      || !renderedOwner
      || !hasLabel(owner, 'Branch')
      || !hasLabel(owner, 'Operand')
      || !semanticEdges.some((edge) => (
        edge.start === operand.key
        && edge.end === ownerId
        && edge.type === 'READS_VALUE'
      ))
    ) continue;
    if (!candidatesByOwner.has(ownerId)) candidatesByOwner.set(ownerId, []);
    candidatesByOwner.get(ownerId).push(operand);
  }

  const projectedNodes = [...renderedNodes];
  const projections = [];
  for (const [ownerId, operands] of candidatesByOwner) {
    const owner = renderedById.get(ownerId);
    const ownerPosition = nodePosition(owner);
    if (!ownerPosition) continue;
    operands.sort((left, right) => (
      Number(prop(left.props, 'sequenceOrder', 'sequence_order') || 0)
      - Number(prop(right.props, 'sequenceOrder', 'sequence_order') || 0)
    ) || left.key.localeCompare(right.key));

    operands.forEach((operand, index) => {
      if (renderedById.has(operand.key)) return;
      const name = String(operand.props?.diaName || operand.props?.label || 'value');
      const width = Math.max(46, Math.min(96, 18 + name.length * 7));
      const x = ownerPosition.x + (
        operands.length === 1
          ? 0.1
          : 0.08 + index * 0.34
      );
      const visual = semanticNodeAsRendered(
        operand,
        x,
        ownerPosition.y,
        ['HybridOperandOccurrence'],
        {
          diaName: name,
          hybridVisualRole: 'operand-occurrence',
          hybridOverlayOwnerStableId: ownerId,
          hybridOverlayKind: 'operand-in-expression',
          displayWidth: width,
          displayHeight: 20,
        },
      );
      projectedNodes.push(visual);
      renderedById.set(visual.id, visual);
      projections.push({
        operandStableId: visual.id,
        ownerStableId: ownerId,
      });
    });
  }

  return {
    nodes: projectedNodes,
    edges: renderedEdges,
    projections,
  };
}

function positionDirectForOfRegions({
  semanticNodes,
  semanticEdges,
  renderedNodes,
}) {
  const semanticById = new Map(semanticNodes.map((node) => [node.key, node]));
  const renderedById = new Map(renderedNodes.map((node) => [node.id, node]));
  const outgoing = (stableId, type) => semanticEdges.find((edge) => (
    edge.start === stableId && edge.type === type
  ));
  const stepIdFor = (node) => String(prop(
    node?.props,
    'parentStepStableId',
    'parent_step_stable_id',
  ) || '').trim();
  const placements = new Map();
  const familyEdgeTypes = new Set([
    'ARG', 'ArgJoin', 'FIELD', 'FieldJoin', 'INVOKES', 'ON_RECEIVER',
    'EVAL', 'ASSIGNS_VALUE',
  ]);

  const placeFamily = (root, x, y, role) => {
    const renderedRoot = renderedById.get(root?.key);
    const current = nodePosition(renderedRoot);
    if (!root || !current) return;
    const deltaX = x - current.x;
    const deltaY = y - current.y;
    const stepId = stepIdFor(root);
    const memberIds = new Set([root.key]);
    const queue = [root.key];
    while (queue.length) {
      const currentId = queue.shift();
      for (const edge of semanticEdges) {
        if (!familyEdgeTypes.has(edge.type)) continue;
        const neighborId = edge.start === currentId
          ? edge.end
          : edge.end === currentId
            ? edge.start
            : undefined;
        if (!neighborId || memberIds.has(neighborId)) continue;
        const neighbor = semanticById.get(neighborId);
        if (!neighbor || stepIdFor(neighbor) !== stepId) continue;
        memberIds.add(neighborId);
        queue.push(neighborId);
      }
    }
    for (const memberId of memberIds) {
      const rendered = renderedById.get(memberId);
      const position = nodePosition(rendered);
      if (!rendered || !position) continue;
      placements.set(memberId, {
        x: position.x + deltaX,
        y: position.y + deltaY,
        role: memberId === root.key ? role : `${role}-family`,
      });
    }
  };

  for (const loop of semanticNodes.filter((node) => (
    hasLabel(node, 'Loop')
    && prop(node.props, 'collectionMethod', 'collection_method') === 'for-of'
  ))) {
    const loopRendered = renderedById.get(loop.key);
    const anchor = nodePosition(loopRendered);
    if (!loopRendered || !anchor) continue;
    const iterator = semanticById.get(outgoing(loop.key, 'NEXT')?.end);
    const source = iterator && semanticById.get(outgoing(iterator.key, 'EVAL')?.end);
    const status = iterator && semanticById.get(outgoing(iterator.key, 'NEXT')?.end);
    const predicate = status && semanticById.get(outgoing(status.key, 'TRUE')?.end);
    if (!source || !iterator || !status) continue;

    placements.set(loop.key, { x: anchor.x, y: anchor.y, role: 'loop-head' });
    placements.set(iterator.key, { x: anchor.x, y: anchor.y + 0.46, role: 'loop-iterator-value' });
    placements.set(source.key, { x: anchor.x + 0.72, y: anchor.y + 0.34, role: 'loop-source' });
    placements.set(status.key, { x: anchor.x, y: anchor.y + 0.92, role: 'loop-iterator-status' });
    if (predicate) {
      placements.set(predicate.key, { x: anchor.x + 0.72, y: anchor.y + 1.54, role: 'loop-body-predicate' });
      const imageSource = semanticById.get(outgoing(predicate.key, 'TRUE')?.end);
      const imageContent = imageSource && semanticById.get(outgoing(imageSource.key, 'NEXT')?.end);
      const imageRemote = imageContent && semanticById.get(outgoing(imageContent.key, 'NEXT')?.end);
      const textContent = semanticById.get(outgoing(predicate.key, 'FALSE')?.end);
      const textRemote = textContent && semanticById.get(outgoing(textContent.key, 'NEXT')?.end);
      if (imageSource) placeFamily(imageSource, anchor.x + 1.42, anchor.y + 2.12, 'loop-image-source');
      if (imageContent) placeFamily(imageContent, anchor.x + 1.42, anchor.y + 3.2, 'loop-image-content');
      if (imageRemote) placeFamily(imageRemote, anchor.x + 1.42, anchor.y + 4.0, 'loop-image-remote');
      if (textContent) placeFamily(textContent, anchor.x + 1.42, anchor.y + 4.85, 'loop-text-content');
      if (textRemote) placeFamily(textRemote, anchor.x + 1.42, anchor.y + 5.65, 'loop-text-remote');
    }
  }

  if (!placements.size) return renderedNodes;
  return renderedNodes.map((node) => {
    const placement = placements.get(node.id);
    if (!placement) return node;
    return {
      ...node,
      props: {
        ...(node.props || {}),
        displayY: placement.y,
        structuralPlacementRole: placement.role,
        layoutTrace: [
          node.props?.layoutTrace,
          `extractor-backed for-of role ${placement.role}; horizontal coordinate preserved from the coordinator`,
        ].filter(Boolean).join('; '),
      },
    };
  });
}

export function projectHybridFlowGraph({
  drawioGraph,
  semanticNodes,
  semanticEdges,
}) {
  let nodes = drawioGraph.nodes.map((node) => ({
    ...node,
    labels: [...(node.labels || [])],
    props: { ...(node.props || {}) },
  }));
  let edges = drawioGraph.edges.map((edge) => ({
    ...edge,
    props: { ...(edge.props || {}) },
  }));

  addGraphBackedMethodMetadata(nodes, semanticNodes, semanticEdges);

  const loops = semanticNodes
    .filter((node) => (
      hasLabel(node, 'Primitive')
      && prop(node.props, 'primitiveKind', 'primitive_kind') === 'iterate'
      && prop(node.props, 'executionScopeKind', 'execution_scope_kind') === 'collection-iterator'
    ))
    .sort((left, right) => (
      Number(left.props?.operation_index ?? Number.MAX_SAFE_INTEGER)
      - Number(right.props?.operation_index ?? Number.MAX_SAFE_INTEGER)
    ) || String(left.key).localeCompare(String(right.key)));
  const semanticNodeById = new Map(semanticNodes.map((node) => [node.key, node]));
  const stateUpdateRoots = semanticEdges
    .filter((edge) => (
      edge.type === 'INVOKES'
      && hasLabel(semanticNodeById.get(edge.end), 'StateUpdater')
    ))
    .map((edge) => semanticNodeById.get(edge.start))
    .filter(Boolean);
  const genericSubmethodRoots = semanticNodes.filter((node) => (
    Boolean(String(prop(node.props, 'submethodsJson', 'submethods_json') || '').trim())
  ));
  const candidatesByStableId = new Map([
    ...loops.map((node) => ({ kind: 'collection', node })),
    ...stateUpdateRoots.map((node) => ({ kind: 'state-update', node })),
    ...genericSubmethodRoots.map((node) => ({ kind: 'submethod', node })),
  ].map((candidate) => [candidate.node.key, candidate]));
  const candidates = [...candidatesByStableId.values()].sort((left, right) => (
    Number(left.node.props?.operation_index ?? Number.MAX_SAFE_INTEGER)
    - Number(right.node.props?.operation_index ?? Number.MAX_SAFE_INTEGER)
  ) || String(left.node.key).localeCompare(String(right.node.key)));

  const protocols = [];
  const skippedProtocolStableIds = [];
  for (const candidate of candidates) {
    const hasExtractedProtocol = Boolean(String(prop(
      candidate.node.props,
      'executionProtocolKind',
      'execution_protocol_kind',
    ) || '').trim());
    const extractedScenario = extractedExecutionProtocolScenario(
      candidate.node,
      semanticNodes,
      semanticEdges,
    );
    const scenario = extractedScenario;
    const projected = scenario?.submethods?.length
      ? projectExtractedSubmethods({
          loop: candidate.node,
          scenario,
          renderedNodes: nodes,
          renderedEdges: edges,
        })
      : null;
    if (!projected) {
      skippedProtocolStableIds.push(candidate.node.key);
      continue;
    }
    nodes = projected.nodes;
    edges = projected.edges;
    protocols.push({
      stableId: projected.protocolStableId,
      projectedNodeCount: projected.projectedNodeIds.length,
      projectedNodeIds: projected.projectedNodeIds,
      projectedEdgeIds: projected.projectedEdgeIds,
      protocolScenarioId: projected.protocolScenarioId || null,
      protocolKind: extractedScenario?.protocol || '',
      executionLayoutKinds: [...new Set(
        (extractedScenario?.lanes || []).map((lane) => lane.visualKind).filter(Boolean),
      )],
      expectedVisibleRoles: expectedVisibleProtocolRoles(extractedScenario),
      expectedVisibleRoleStableIds: Object.fromEntries(
        (extractedScenario?.entities || [])
          .filter((entity) => entity.role && entity.actualStableId)
          .map((entity) => [entity.role, entity.actualStableId]),
      ),
      ambiguousRoleOwners: Object.fromEntries(
        [...(extractedScenario?.entities || []).reduce((ownersByRole, entity) => {
          if (!entity.role || !entity.actualStableId) return ownersByRole;
          const owners = ownersByRole.get(entity.role) || new Set();
          owners.add(entity.actualStableId);
          ownersByRole.set(entity.role, owners);
          return ownersByRole;
        }, new Map())]
          .filter(([, owners]) => owners.size > 1)
          .map(([role, owners]) => [role, [...owners]]),
      ),
      inferenceKind: candidate.kind,
      protocolSource: extractedScenario
        ? 'extractor'
        : hasExtractedProtocol
          ? 'extractor-incomplete'
          : 'renderer-fallback',
    });
  }

  nodes = positionDirectForOfRegions({
    semanticNodes,
    semanticEdges,
    renderedNodes: nodes,
  });

  const containerSets = projectContainerSetMethods({
    semanticNodes,
    semanticEdges,
    renderedNodes: nodes,
    renderedEdges: edges,
  });
  nodes = containerSets.nodes;
  edges = containerSets.edges;

  const expressionOperandOverlays = projectExpressionOperandOverlays({
    semanticNodes,
    semanticEdges,
    renderedNodes: nodes,
    renderedEdges: edges,
  });
  nodes = expressionOperandOverlays.nodes;
  edges = expressionOperandOverlays.edges;

  const finalNodeById = new Map(nodes.map((node) => [node.id, node]));
  const positionedSemanticNeighbor = (semanticNode) => {
    const stepStableId = prop(
      semanticNode?.props,
      'parentStepStableId',
      'owner_step_stable_id',
    );
    const candidates = semanticEdges
      .filter((edge) => (
        edge.start === semanticNode.key || edge.end === semanticNode.key
      ))
      .map((edge) => finalNodeById.get(
        edge.start === semanticNode.key ? edge.end : edge.start,
      ))
      .filter((node) => {
        if (!nodePosition(node)) return false;
        const neighborStepStableId = prop(
          node.props,
          'parentStepStableId',
          'owner_step_stable_id',
        );
        return !stepStableId || !neighborStepStableId || neighborStepStableId === stepStableId;
      });
    return candidates[0] || null;
  };
  const semanticExpressionOperators = semanticNodes.filter((node) => (
    prop(node.props, 'expressionMosaicRole', 'expression_mosaic_role') === 'operator'
  ));
  for (const semanticOperator of semanticExpressionOperators) {
    let operator = finalNodeById.get(semanticOperator.key);
    if (!operator) {
      const anchor = positionedSemanticNeighbor(semanticOperator);
      // A semantic expression inside an untraversed local function has no
      // coordinate owner. Restoring it at (0, 0) creates a detached Step at
      // the top of the diagram, so only restore mosaics anchored to an
      // already positioned node in the same flow.
      if (!anchor) continue;
      const anchorPosition = nodePosition(anchor) || { x: 0, y: 0 };
      operator = semanticNodeAsRendered(
        semanticOperator,
        anchorPosition.x,
        anchorPosition.y,
        ['ExpressionMosaic'],
        {
          renderHidden: false,
          layoutTrace: [
            semanticOperator.props?.layoutTrace,
            `restored expression mosaic at positioned semantic neighbor ${anchor.id}`,
          ].filter(Boolean).join('; '),
        },
      );
      nodes.push(operator);
      finalNodeById.set(operator.id, operator);
    }
    const ownerStableId = prop(operator.props, 'expressionMosaicOwnerStableId', 'expression_mosaic_owner_stable_id');
    if (!ownerStableId) continue;
    for (const semanticMember of semanticNodes.filter((node) => (
      prop(node.props, 'expressionMosaicOwnerStableId', 'expression_mosaic_owner_stable_id') === ownerStableId
      && prop(node.props, 'expressionMosaicRole', 'expression_mosaic_role') !== 'operator'
    ))) {
      if (finalNodeById.has(semanticMember.key)) continue;
      const member = semanticNodeAsRendered(
        semanticMember,
        Number(operator.props?.displayX || 0),
        Number(operator.props?.displayY || 0),
        ['ExpressionMosaic'],
        { renderHidden: false },
      );
      nodes.push(member);
      finalNodeById.set(member.id, member);
    }
  }

  const expressionMosaicNodeIds = new Set(nodes
    .filter((node) => prop(node.props, 'expressionMosaicRole', 'expression_mosaic_role'))
    .map((node) => node.id));
  const expressionClosureNodeIds = new Set();
  for (const semanticEdge of semanticEdges.filter((edge) => (
    edge.type === 'ArgJoin'
    && expressionMosaicNodeIds.has(edge.start)
    && finalNodeById.has(edge.start)
  ))) {
    const expressionCall = finalNodeById.get(semanticEdge.start);
    if (
      expressionMosaicPartKind(expressionCall)
      && prop(expressionCall?.props, 'suppressObjectMethodVisual', 'suppress_object_method_visual') === true
    ) continue;
    expressionClosureNodeIds.add(semanticEdge.end);
    if (finalNodeById.has(semanticEdge.end)) continue;
    const semanticClosure = semanticNodeById.get(semanticEdge.end);
    if (!semanticClosure || !(hasLabel(semanticClosure, 'VisualProxy') || hasLabel(semanticClosure, 'FnVisualProxy'))) continue;
    const source = finalNodeById.get(semanticEdge.start);
    const closure = semanticNodeAsRendered(
      semanticClosure,
      Number(source?.props?.displayX || 0),
      Number(source?.props?.displayY || 0),
      [],
      { renderHidden: false },
    );
    nodes.push(closure);
    finalNodeById.set(closure.id, closure);
  }
  const expressionProjectionNodeIds = new Set([
    ...expressionMosaicNodeIds,
    ...expressionClosureNodeIds,
  ]);
  for (const semanticEdge of semanticEdges.filter((edge) => (
    ['NEXT', 'ArgJoin', 'FieldJoin'].includes(edge.type)
    && (expressionProjectionNodeIds.has(edge.start) || expressionProjectionNodeIds.has(edge.end))
    && finalNodeById.has(edge.start)
    && finalNodeById.has(edge.end)
  ))) {
    if (edges.some((edge) => (
      edge.type === semanticEdge.type
      && edge.start === semanticEdge.start
      && edge.end === semanticEdge.end
    ))) continue;
    edges.push(projectionEdge(
      semanticEdge.type,
      semanticEdge.start,
      semanticEdge.end,
      {
        ...(semanticEdge.props || {}),
        ...(semanticEdge.type === 'ArgJoin' ? {
          displayLabel: '',
          renderHidden: true,
          semanticProjection: 'expression-call-closure-layout',
        } : {}),
      },
    ));
  }

  nodes = nodes.map((node) => {
    const expressionRole = prop(node.props, 'expressionMosaicRole', 'expression_mosaic_role');
    if (!expressionRole) return node;
    if (expressionMosaicPartKind(node)) return node;
    const overlayOwnerStableId = prop(
      node.props,
      'hybridOverlayOwnerStableId',
      'hybrid_overlay_owner_stable_id',
    );
    const overlayOwner = finalNodeById.get(overlayOwnerStableId);
    const keepProtocolOverlay = Boolean(
      node.props?.protocolRole
      && overlayOwnerStableId
      && overlayOwner?.labels?.includes('HybridFunctionalColumn'),
    );
    if (expressionRole === 'operator' && keepProtocolOverlay) {
      const props = { ...(node.props || {}) };
      const operatorText = prop(props, 'operationValueText', 'operation_value_text');
      if (operatorText) props.diaName = operatorText;
      return { ...node, props };
    }
    const {
      hybridVisualRole: _hybridVisualRole,
      hybrid_visual_role: _hybridVisualRoleSnake,
      hybridOverlayOwnerStableId: _hybridOverlayOwnerStableId,
      hybridAttachmentOwnerStableId: _hybridAttachmentOwnerStableId,
      hybridCompositionOwnerStableId: _hybridCompositionOwnerStableId,
      ...props
    } = node.props || {};
    const operatorText = prop(props, 'operationValueText', 'operation_value_text');
    if (expressionRole === 'operator' && operatorText) props.diaName = operatorText;
    return { ...node, props };
  });

  const projectedNodeById = new Map(nodes.map((node) => [node.id, node]));
  const projectedOutcomeKeys = new Set(edges.map((edge) => `${edge.type}\u0000${edge.start}\u0000${edge.end}`));
  for (const semanticEdge of semanticEdges) {
    if (semanticEdge.type !== 'TRUE' && semanticEdge.type !== 'FALSE') continue;
    const source = projectedNodeById.get(semanticEdge.start);
    if (!source || !projectedNodeById.has(semanticEdge.end)) continue;
    const role = prop(source.props, 'callMosaicRole', 'call_mosaic_role');
    if (role !== 'open' && role !== 'close') continue;
    const key = `${semanticEdge.type}\u0000${semanticEdge.start}\u0000${semanticEdge.end}`;
    if (projectedOutcomeKeys.has(key)) continue;
    const sourcePort = role === 'open' ? 'bottom' : 'right';
    edges.push(projectionEdge(semanticEdge.type, semanticEdge.start, semanticEdge.end, {
      ...semanticEdge.props,
      sourcePort,
      sourcePortCandidates: [sourcePort],
      lockPortCandidates: true,
      semanticProjection: 'predicate-call-mosaic',
    }));
    projectedOutcomeKeys.add(key);
  }
  edges = edges.map((edge) => {
    if (edge.type !== 'TRUE' && edge.type !== 'FALSE') return edge;
    const role = prop(projectedNodeById.get(edge.start)?.props, 'callMosaicRole', 'call_mosaic_role');
    if (role !== 'open' && role !== 'close') return edge;
    const sourcePort = role === 'open' ? 'bottom' : 'right';
    return {
      ...edge,
      props: {
        ...edge.props,
        sourcePort,
        sourcePortCandidates: [sourcePort],
        lockPortCandidates: true,
        layoutRouteReason: role === 'open'
          ? 'predicate call main flow exits below the opening boundary'
          : 'predicate call side flow exits right from the closing boundary',
      },
    };
  });

  nodes = nodes.map((node) => {
    if (prop(node.props, 'callMosaicRole', 'call_mosaic_role') !== 'argument') return node;
    const label = String(node.props?.diaName || node.props?.dia_name || node.props?.label || '');
    return {
      ...node,
      props: {
        ...node.props,
        displayWidth: Math.max(28, Math.min(220, 14 + label.length * 7)),
        splitCallBoundary: 'middle',
        callHasArguments: true,
        skipHorizontalCompaction: true,
      },
    };
  });
  const mosaicNodeIndex = new Map(nodes.map((node, index) => [node.id, index]));
  const mosaicSemanticEdges = semanticEdges.filter((edge) => edge.type === 'ARG' || edge.type === 'ArgJoin');
  for (const opening of nodes.filter((node) => (
    prop(node.props, 'callMosaicRole', 'call_mosaic_role') === 'open'
    && prop(node.props, 'callMosaicOwnerStableId', 'call_mosaic_owner_stable_id') === node.id
  ))) {
    const members = nodes.filter((node) => (
      prop(node.props, 'callMosaicOwnerStableId', 'call_mosaic_owner_stable_id') === opening.id
    ));
    const argument = members.find((node) => prop(node.props, 'callMosaicRole', 'call_mosaic_role') === 'argument');
    const argumentClosing = members.find((node) => prop(node.props, 'callMosaicRole', 'call_mosaic_role') === 'argument-close');
    const closing = members.find((node) => prop(node.props, 'callMosaicRole', 'call_mosaic_role') === 'close');
    if (!argument || !closing) continue;
    const directArgument = mosaicSemanticEdges.some((edge) => (
      edge.type === 'ARG' && edge.start === opening.id && edge.end === argument.id
    ));
    const closureSource = argumentClosing || argument;
    const directClosure = mosaicSemanticEdges.some((edge) => (
      edge.type === 'ArgJoin' && edge.start === closureSource.id && edge.end === closing.id
    ));
    if (!directArgument || !directClosure) continue;
    const openingX = Number(opening.props?.displayX);
    const openingY = Number(opening.props?.displayY);
    if (!Number.isFinite(openingX) || !Number.isFinite(openingY)) continue;
    const openingWidth = Math.max(28, Number(opening.props?.displayWidth) || 138);
    const argumentWidth = Math.max(28, Number(argument.props?.displayWidth) || 28);
    const closingWidth = argumentClosing
      ? 44
      : Math.max(28, Number(closing.props?.displayWidth) || 44);
    const expressionMembers = nodes
      .filter((node) => (
        prop(node.props, 'expressionMosaicOwnerStableId', 'expression_mosaic_owner_stable_id') === argument.id
        && expressionMosaicPartKind(node) !== 'receiver'
      ))
      .sort((left, right) => (
        Number(prop(left.props, 'expressionMosaicOrder', 'expression_mosaic_order') || 0)
        - Number(prop(right.props, 'expressionMosaicOrder', 'expression_mosaic_order') || 0)
      ));
    const argumentExpressionIndex = expressionMembers.findIndex((node) => node.id === argument.id);
    const expressionWidths = expressionMembers.map((node) => (
      Math.max(28, Number(node.props?.displayWidth) || compactExpressionMosaicWidth(node))
    ));
    const expressionFirstX = openingX + (openingWidth + expressionWidths[0]) / 520;
    const expressionCenters = expressionMembers.length ? [expressionFirstX] : [];
    for (let index = 1; index < expressionMembers.length; index += 1) {
      expressionCenters[index] = expressionCenters[index - 1]
        + (expressionWidths[index - 1] + expressionWidths[index]) / 520;
    }
    const argumentX = expressionMembers.length
      ? expressionCenters[Math.max(0, argumentExpressionIndex)]
      : openingX + (openingWidth + argumentWidth) / 520;
    const argumentClosingX = Number(argumentClosing?.props?.displayX);
    const argumentClosingWidth = Math.max(28, Number(argumentClosing?.props?.displayWidth) || 44);
    const closingX = argumentClosing && Number.isFinite(argumentClosingX)
      ? argumentClosingX + (argumentClosingWidth + closingWidth) / 520
      : expressionMembers.length
        ? expressionCenters.at(-1) + (expressionWidths.at(-1) + closingWidth) / 520
        : argumentX + (argumentWidth + closingWidth) / 520;
    const replaceNode = (node, displayX, displayWidth, extraProps = {}, displayY = openingY) => {
      const index = mosaicNodeIndex.get(node.id);
      if (index === undefined) return;
      nodes[index] = {
        ...node,
        props: {
          ...node.props,
          ...extraProps,
          displayX,
          displayY,
          displayWidth,
          skipHorizontalCompaction: true,
        },
      };
    };
    replaceNode(opening, openingX, openingWidth, { compactCallMosaic: true });
    replaceNode(argument, argumentX, argumentWidth, { splitCallBoundary: 'middle', compactCallMosaic: true });
    replaceNode(
      closing,
      closingX,
      closingWidth,
      { compactCallMosaic: true },
      argumentClosing ? Number(argumentClosing.props?.displayY) || openingY : openingY,
    );
  }
  const mosaicNodeById = new Map(nodes.map((node) => [node.id, node]));
  const projectedMosaicEdgeKeys = new Set(edges.map((edge) => `${edge.type}\u0000${edge.start}\u0000${edge.end}`));
  for (const semanticEdge of semanticEdges) {
    if (semanticEdge.type !== 'ARG' && semanticEdge.type !== 'ArgJoin') continue;
    const source = mosaicNodeById.get(semanticEdge.start);
    const target = mosaicNodeById.get(semanticEdge.end);
    const sourceOwner = prop(source?.props, 'callMosaicOwnerStableId', 'call_mosaic_owner_stable_id');
    const targetOwner = prop(target?.props, 'callMosaicOwnerStableId', 'call_mosaic_owner_stable_id');
    if (!sourceOwner || sourceOwner !== targetOwner) continue;
    const key = `${semanticEdge.type}\u0000${semanticEdge.start}\u0000${semanticEdge.end}`;
    if (projectedMosaicEdgeKeys.has(key)) continue;
    edges.push(projectionEdge(semanticEdge.type, semanticEdge.start, semanticEdge.end, {
      ...(semanticEdge.props || {}),
      displayLabel: '',
      renderHidden: false,
      flowFamilyConnector: true,
      semanticProjection: 'call-mosaic-layout',
    }));
    projectedMosaicEdgeKeys.add(key);
  }
  edges = edges.map((edge) => {
    if (!['ARG', 'ArgJoin', 'INVOKES'].includes(edge.type)) return edge;
    const source = mosaicNodeById.get(edge.start);
    const target = mosaicNodeById.get(edge.end);
    const sourceOwner = prop(source?.props, 'callMosaicOwnerStableId', 'call_mosaic_owner_stable_id');
    const targetOwner = prop(target?.props, 'callMosaicOwnerStableId', 'call_mosaic_owner_stable_id');
    if (!sourceOwner || sourceOwner !== targetOwner) return edge;
    return {
      ...edge,
      props: {
        ...(edge.props || {}),
        displayLabel: '',
        renderHidden: false,
        flowFamilyConnector: true,
        semanticProjection: 'call-mosaic-layout',
      },
    };
  });

  edges = edges.map((edge) => {
    if (edge.type !== 'ARG' && edge.type !== 'FIELD') return edge;
    const source = mosaicNodeById.get(edge.start);
    const target = mosaicNodeById.get(edge.end);
    const sourceCallOwner = prop(source?.props, 'callMosaicOwnerStableId', 'call_mosaic_owner_stable_id');
    const targetCallOwner = prop(target?.props, 'callMosaicOwnerStableId', 'call_mosaic_owner_stable_id');
    const insideCallMosaic = Boolean(sourceCallOwner && sourceCallOwner === targetCallOwner);
    const callArgumentConnector = edge.type === 'ARG'
      && (hasLabel(source, 'Call') || hasLabel(source, 'Request') || hasLabel(source, 'Op'))
      && (hasLabel(target, 'Arg') || hasLabel(target, 'ObjectBrace') || hasLabel(target, 'CallbackFn'));
    const insideObjectMosaic = edge.type === 'ARG'
      ? hasLabel(target, 'ObjectBrace') && hasLabel(target, 'Open')
      : (hasLabel(source, 'ObjectBrace') && hasLabel(source, 'Open'))
        || prop(source?.props, 'callMosaicRole', 'call_mosaic_role') === 'open';
    if (!insideCallMosaic && !callArgumentConnector && !insideObjectMosaic) return edge;
    return {
      ...edge,
      props: {
        ...(edge.props || {}),
        displayLabel: '',
        renderHidden: false,
        flowFamilyConnector: true,
      },
    };
  });

  const expressionGroups = new Map();
  for (const node of nodes) {
    const ownerId = prop(node.props, 'expressionMosaicOwnerStableId', 'expression_mosaic_owner_stable_id');
    if (!ownerId || expressionMosaicPartKind(node) === 'receiver') continue;
    expressionGroups.set(ownerId, [...(expressionGroups.get(ownerId) || []), node]);
  }
  const expressionBoundaryById = new Map();
  for (const [ownerId, members] of expressionGroups) {
    members.sort((left, right) => (
      Number(prop(left.props, 'expressionMosaicOrder', 'expression_mosaic_order') || 0)
      - Number(prop(right.props, 'expressionMosaicOrder', 'expression_mosaic_order') || 0)
    ));
    const owner = semanticNodeById.get(ownerId) || members.find((node) => node.id === ownerId);
    const predicate = members.some((node) => (
      prop(node.props, 'expressionMosaicPredicate', 'expression_mosaic_predicate') === true
    )) || hasLabel(owner, 'Branch');
    members.forEach((member, index) => expressionBoundaryById.set(member.id, {
      boundary: index === 0 ? 'start' : index === members.length - 1 ? 'end' : 'middle',
      predicate,
    }));
  }
  nodes = nodes.map((node) => {
    const expressionBoundary = expressionBoundaryById.get(node.id);
    if (!expressionBoundary) return node;
    return {
      ...node,
      props: {
        ...node.props,
        horizontalMosaicBoundary: expressionBoundary.boundary,
        expressionMosaicPredicate: expressionBoundary.predicate,
      },
    };
  });

  // A projection may assign coordinates and visual properties, but it cannot
  // manufacture graph facts. Conversely, every element selected into the
  // incoming view must survive projection with the same identity.
  const extractedEdgeKeys = new Set(semanticEdges.map(edgeKey));
  edges = edges.filter((edge) => extractedEdgeKeys.has(edgeKey(edge)));
  const projectedNodeIdsBeforeRestore = new Set(nodes.map((node) => node.id));
  for (const inputNode of drawioGraph.nodes) {
    if (projectedNodeIdsBeforeRestore.has(inputNode.id)) continue;
    nodes.push({
      ...inputNode,
      labels: [...(inputNode.labels || [])],
      props: { ...(inputNode.props || {}) },
    });
    projectedNodeIdsBeforeRestore.add(inputNode.id);
  }
  const projectedEdgeKeysBeforeRestore = new Set(edges.map(edgeKey));
  for (const inputEdge of drawioGraph.edges) {
    const key = edgeKey(inputEdge);
    if (!extractedEdgeKeys.has(key) || projectedEdgeKeysBeforeRestore.has(key)) continue;
    edges.push({ ...inputEdge, props: { ...(inputEdge.props || {}) } });
    projectedEdgeKeysBeforeRestore.add(key);
  }

  // Multiple layout passes may reposition the same extracted entity. Keep the
  // last projection of that identity instead of serializing duplicate cells.
  nodes = [...new Map(nodes.map((node) => [node.id, node])).values()];
  edges = [...new Map(edges.map((edge) => [edgeKey(edge), edge])).values()];

  const projectedNodeIds = new Set(nodes.map((node) => node.id));
  const projectedEdgeKeys = new Set(edges.map(edgeKey));
  for (const edge of drawioGraph.edges) {
    const effectiveSource = prop(edge.props, 'layoutEffectiveSourceStableId', 'layout_effective_source_stable_id');
    if (!effectiveSource || !projectedNodeIds.has(edge.start) || !projectedNodeIds.has(edge.end)) continue;
    const key = edgeKey(edge);
    if (projectedEdgeKeys.has(key)) continue;
    projectedEdgeKeys.add(key);
    edges.push({ ...edge, props: { ...(edge.props || {}) } });
  }

  // Each protocol projection may intentionally hide internal execution
  // primitives. Later projections must not retain an earlier semantic edge
  // after either endpoint has been replaced by a visual composition.
  const renderedNodeIds = new Set(nodes.map((node) => node.id));
  edges = edges.filter((edge) => (
    renderedNodeIds.has(edge.start) && renderedNodeIds.has(edge.end)
  ));
  const renderedEdgeIds = new Set(edges.map((edge) => edge.id));
  for (const protocol of protocols) {
    protocol.projectedNodeIds = protocol.projectedNodeIds.filter((id) => renderedNodeIds.has(id));
    protocol.projectedEdgeIds = protocol.projectedEdgeIds.filter((id) => renderedEdgeIds.has(id));
    protocol.projectedNodeCount = protocol.projectedNodeIds.length;
  }

  return {
    ...drawioGraph,
    nodes,
    edges,
    hybridProjection: {
      candidateProtocolCount: candidates.length,
      protocolCount: protocols.length,
      skippedProtocolStableIds,
      protocols,
      containerSetProjections: containerSets.projections,
      expressionOperandOverlays: expressionOperandOverlays.projections,
    },
  };
}
