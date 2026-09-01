import assert from 'node:assert/strict';
import test from 'node:test';

import {
  auditExtractedProjectionContract,
  projectHybridCoordinateEdges,
  projectHybridFlowGraph,
} from './hybridFlowProjection.js';

test('projection contract reports invented, deleted, and hidden graph elements', () => {
  const audit = auditExtractedProjectionContract({
    semanticNodes: [{ key: 'a', labels: [], props: { renderHidden: true } }],
    semanticEdges: [{ start: 'a', type: 'NEXT', end: 'b', props: { render_hidden: true } }],
    inputGraph: {
      nodes: [{ id: 'a' }],
      edges: [{ start: 'a', type: 'NEXT', end: 'b' }],
    },
    projectedGraph: {
      nodes: [{ id: 'invented' }],
      edges: [{ start: 'invented', type: 'NEXT', end: 'b' }],
    },
  });
  assert.deepEqual(audit.projectedNodesMissingFromExtraction, ['invented']);
  assert.deepEqual(audit.projectedEdgesMissingFromExtraction, ['invented\u0000NEXT\u0000b']);
  assert.deepEqual(audit.projectedNodesMissingFromInput, ['invented']);
  assert.deepEqual(audit.projectedEdgesMissingFromInput, ['invented\u0000NEXT\u0000b']);
  assert.deepEqual(audit.inputNodesDeletedByProjection, ['a']);
  assert.deepEqual(audit.inputEdgesDeletedByProjection, ['a\u0000NEXT\u0000b']);
  assert.deepEqual(audit.inputEdgesMissingFromExtraction, []);
  assert.deepEqual(audit.extractedHiddenNodes, ['a']);
  assert.deepEqual(audit.extractedHiddenEdges, ['a\u0000NEXT\u0000b']);
});

test('projection contract excludes composition-only edges from deletion findings', () => {
  const audit = auditExtractedProjectionContract({
    semanticNodes: [{ key: 'call' }, { key: 'argument' }],
    semanticEdges: [{ start: 'call', type: 'ARG', end: 'argument', props: {} }],
    inputGraph: {
      nodes: [{ id: 'call' }, { id: 'argument' }],
      edges: [{ start: 'call', type: 'ARG', end: 'argument', props: {} }],
    },
    projectedGraph: {
      nodes: [{ id: 'call' }, { id: 'argument' }],
      edges: [],
    },
  });
  assert.deepEqual(audit.inputEdgesDeletedByProjection, []);
  assert.deepEqual(audit.inputCompositionEdgesHiddenByPolicy, ['call\u0000ARG\u0000argument']);
});

function renderedNode(id, x, y, labels = []) {
  return {
    id,
    labels,
    props: {
      diaName: id,
      displayX: x,
      displayY: y,
    },
  };
}

function semanticNode(key, labels, props = {}) {
  return { key, labels, props };
}

function semanticEdge(type, start, end, props = {}) {
  return { type, start, end, props };
}

function containerSetNode(producerStartStableId, producerEndStableIds, producerChainKind) {
  return semanticNode('set', [
    'Method',
    'Assignment',
    'ContainerMethod',
    'Set',
  ], {
    diaName: 'set',
    producerStartStableId,
    producerEndStableIds,
    producerChainKind,
  });
}

test('a restored expression mosaic inherits the row of its positioned flow neighbor', () => {
  const ownerProps = {
    parentStepStableId: 'step',
    expressionMosaicOwnerStableId: 'operator',
    expressionMosaicPredicate: true,
  };
  const graph = projectHybridFlowGraph({
    drawioGraph: {
      nodes: [{
        ...renderedNode('continuation', 3, 42, ['Branch', 'Flow']),
        props: {
          ...renderedNode('continuation', 3, 42).props,
          parentStepStableId: 'step',
        },
      }],
      edges: [],
    },
    semanticNodes: [
      semanticNode('operator', ['Branch', 'Flow', 'ExpressionMosaic'], {
        ...ownerProps,
        expressionMosaicRole: 'operator',
        operationValueText: '===',
      }),
      semanticNode('left', ['Value', 'ExpressionMosaic'], {
        ...ownerProps,
        expressionMosaicRole: 'left',
        expressionMosaicOrder: 0,
      }),
      semanticNode('right', ['Value', 'Literal', 'ExpressionMosaic'], {
        ...ownerProps,
        expressionMosaicRole: 'right',
        expressionMosaicOrder: 2,
      }),
      semanticNode('continuation', ['Branch', 'Flow'], { parentStepStableId: 'step' }),
    ],
    semanticEdges: [
      semanticEdge('READS_VALUE', 'left', 'operator'),
      semanticEdge('READS_VALUE', 'right', 'operator'),
      semanticEdge('TRUE', 'operator', 'continuation'),
      semanticEdge('FALSE', 'operator', 'continuation'),
    ],
  });

  for (const stableId of ['operator', 'left', 'right']) {
    assert.equal(graph.nodes.find((node) => node.id === stableId)?.props.displayY, 42);
  }
});

test('an expression mosaic without a positioned flow neighbor is not restored at the origin', () => {
  const ownerProps = {
    parentStepStableId: 'detached-step',
    expressionMosaicOwnerStableId: 'operator',
    expressionMosaicPredicate: true,
  };
  const graph = projectHybridFlowGraph({
    drawioGraph: { nodes: [], edges: [] },
    semanticNodes: [
      semanticNode('operator', ['Branch', 'Flow', 'ExpressionMosaic'], {
        ...ownerProps,
        expressionMosaicRole: 'operator',
        operationValueText: '===',
      }),
      semanticNode('left', ['Value', 'ExpressionMosaic'], {
        ...ownerProps,
        expressionMosaicRole: 'left',
        expressionMosaicOrder: 0,
      }),
    ],
    semanticEdges: [semanticEdge('READS_VALUE', 'left', 'operator')],
  });

  assert.equal(graph.nodes.some((node) => ['operator', 'left'].includes(node.id)), false);
});

test('call boundary edges are restored before coordinate traversal', () => {
  const nodes = [
    semanticNode('call', ['Write']),
    semanticNode('argument', ['Arg', 'Object']),
    semanticNode('proxy', ['Fn', 'VisualProxy', 'FnVisualProxy', 'Write']),
    semanticNode('implementation', ['Fn']),
  ];
  const edges = [];
  const projected = projectHybridCoordinateEdges({
    nodes,
    edges,
    semanticEdges: [
      semanticEdge('INVOKES', 'call', 'proxy', { invocation_type: 'WRITE' }),
      semanticEdge('ArgJoin', 'argument', 'proxy', { semantic_expansion: 'call-execution' }),
      semanticEdge('INVOKES', 'call', 'implementation', { invocation_type: 'WRITE' }),
    ],
  });

  assert.deepEqual(projected.map((edge) => [edge.type, edge.start, edge.end]), [
    ['INVOKES', 'call', 'proxy'],
    ['ArgJoin', 'argument', 'proxy'],
  ]);
  assert.equal(projected[0].props.invocation_type, 'WRITE');
  assert.equal(projected[0].props.displayLabel, '');
  assert.equal(projected[0].props.renderHidden, true);
  assert.equal(projected[1].props.displayLabel, '');
  assert.equal(projected[1].props.renderHidden, false);
});

test('a materialized call result remains reachable after its visual proxy', () => {
  const nodes = [
    semanticNode('proxy', ['Fn', 'VisualProxy', 'FnVisualProxy']),
    semanticNode('result', ['Value', 'Result']),
  ];
  const projected = projectHybridCoordinateEdges({
    nodes,
    edges: [],
    semanticEdges: [semanticEdge('RESULT', 'proxy', 'result')],
  });

  assert.equal(projected.length, 1);
  assert.equal(projected[0].type, 'RESULT');
  assert.equal(projected[0].start, 'proxy');
  assert.equal(projected[0].end, 'result');
  assert.equal(projected[0].props.semanticProjection, 'call-result-continuation');
  assert.equal(projected[0].props.renderHidden, false);
});

test('an extracted assignment return remains visible for non-set container methods', () => {
  const nodes = [
    semanticNode('contribution', ['BinaryResult']),
    semanticNode('accumulator', ['Value', 'ContainerMethod', 'Accumulator']),
  ];
  const returnedValue = semanticEdge('PASSES_VALUE', 'contribution', 'accumulator', {
    protocol_role: 'assignment-return',
    producer_route_role: 'return-bottom',
  });

  const projected = projectHybridCoordinateEdges({
    nodes,
    edges: [],
    semanticEdges: [returnedValue],
  });

  assert.equal(projected.length, 1);
  assert.equal(projected[0].type, 'PASSES_VALUE');
  assert.equal(projected[0].start, 'contribution');
  assert.equal(projected[0].end, 'accumulator');
  assert.equal(projected[0].props.semanticProjection, 'container-value-return');
  assert.equal(projected[0].props.renderHidden, false);
});

test('one-argument split calls render unlabeled family connectors in a compact mosaic before their result', () => {
  const mosaicProps = (role) => ({
    callMosaicOwnerStableId: 'call',
    callMosaicRole: role,
  });
  const graph = projectHybridFlowGraph({
    drawioGraph: {
      nodes: [
        { ...renderedNode('call', 1, 2, ['Request']), props: { ...renderedNode('call', 1, 2).props, ...mosaicProps('open'), diaName: 'parseReferences(...', displayWidth: 138 } },
        { ...renderedNode('argument', 2, 2, ['Arg']), props: { ...renderedNode('argument', 2, 2).props, ...mosaicProps('argument'), diaName: 'input' } },
        { ...renderedNode('close', 3, 2, ['FnVisualProxy']), props: { ...renderedNode('close', 3, 2).props, ...mosaicProps('close'), diaName: '...)', displayWidth: 44 } },
        renderedNode('result', 4, 2, ['Result']),
      ],
      edges: [semanticEdge('RESULT', 'close', 'result')],
    },
    semanticNodes: [
      semanticNode('call', ['Request'], mosaicProps('open')),
      semanticNode('argument', ['Arg'], { ...mosaicProps('argument'), diaName: 'input' }),
      semanticNode('close', ['FnVisualProxy'], mosaicProps('close')),
      semanticNode('result', ['Result']),
    ],
    semanticEdges: [
      semanticEdge('ARG', 'call', 'argument'),
      semanticEdge('ArgJoin', 'argument', 'close'),
      semanticEdge('RESULT', 'close', 'result'),
    ],
  });

  const call = graph.nodes.find((node) => node.id === 'call');
  const argument = graph.nodes.find((node) => node.id === 'argument');
  const close = graph.nodes.find((node) => node.id === 'close');
  assert.equal(call?.props.compactCallMosaic, true);
  assert.equal(argument?.props.compactCallMosaic, true);
  assert.equal(argument?.props.displayWidth, 49);
  assert.equal(close?.props.compactCallMosaic, true);
  const internalEdges = graph.edges.filter((edge) => edge.type === 'ARG' || edge.type === 'ArgJoin');
  assert.deepEqual(internalEdges.map((edge) => [edge.type, edge.props?.renderHidden, edge.props?.flowFamilyConnector]), [
    ['ARG', false, true],
    ['ArgJoin', false, true],
  ]);
  assert(graph.edges.some((edge) => (
    edge.type === 'RESULT' && edge.start === 'close' && edge.end === 'result'
  )));
});

test('ordinary call arguments render as unlabeled family connectors without changing global ARG visibility', () => {
  const graph = projectHybridFlowGraph({
    drawioGraph: {
      nodes: [
        renderedNode('call', 1, 2, ['Call']),
        renderedNode('argument', 2, 2, ['Arg']),
      ],
      edges: [semanticEdge('ARG', 'call', 'argument')],
    },
    semanticNodes: [
      semanticNode('call', ['Call']),
      semanticNode('argument', ['Arg']),
    ],
    semanticEdges: [semanticEdge('ARG', 'call', 'argument')],
  });

  const connector = graph.edges.find((edge) => edge.type === 'ARG');
  assert.equal(connector?.props?.renderHidden, false);
  assert.equal(connector?.props?.flowFamilyConnector, true);
  assert.equal(connector?.props?.displayLabel, '');
});

test('a sole expanded object argument folds its opening into the call mosaic', () => {
  const mosaicProps = (role) => ({
    callMosaicOwnerStableId: 'call',
    callMosaicRole: role,
  });
  const graph = projectHybridFlowGraph({
    drawioGraph: {
      nodes: [
        { ...renderedNode('call', 1, 2, ['Request']), props: { ...renderedNode('call', 1, 2).props, ...mosaicProps('open'), displayWidth: 138, renderPartsJson: JSON.stringify([{ text: 'call(' }, { text: '{' }]) } },
        renderedNode('field', 3, 2, ['Field']),
        { ...renderedNode('close', 4, 2, ['Field', 'Join', 'FnVisualProxy']), props: { ...renderedNode('close', 4, 2).props, ...mosaicProps('close'), diaName: '})', renderPartsJson: JSON.stringify([{ text: '}' }, { text: ')' }]), displayWidth: 60 } },
      ],
      edges: [
        semanticEdge('FIELD', 'call', 'field'),
        semanticEdge('FieldJoin', 'field', 'close'),
      ],
    },
    semanticNodes: [
      semanticNode('call', ['Request'], mosaicProps('open')),
      semanticNode('field', ['Field']),
      semanticNode('close', ['Field', 'Join', 'FnVisualProxy'], mosaicProps('close')),
    ],
    semanticEdges: [
      semanticEdge('FIELD', 'call', 'field'),
      semanticEdge('FieldJoin', 'field', 'close'),
    ],
  });

  const call = graph.nodes.find((node) => node.id === 'call');
  const callClose = graph.nodes.find((node) => node.id === 'close');
  assert.ok(call);
  assert.ok(callClose);
  assert.equal(graph.nodes.some((node) => node.id === 'object'), false);
  assert.ok(graph.edges.some((edge) => edge.type === 'FIELD' && edge.start === 'call' && edge.end === 'field'));
  assert.equal(
    graph.edges.find((edge) => edge.type === 'FIELD' && edge.start === 'call')?.props?.flowFamilyConnector,
    true,
  );
  assert.deepEqual(
    graph.edges
      .filter((edge) => edge.type === 'ARG' || edge.type === 'ArgJoin')
      .map((edge) => [edge.type, edge.start, edge.end, edge.props?.renderHidden]),
    [],
  );
});

test('simple container producer keeps its extracted EVAL and returns into the overlaid set method', () => {
  const graph = projectHybridFlowGraph({
    drawioGraph: {
      nodes: [
        renderedNode('container', 1, 2, ['Value', 'ValueSlot', 'ValueCreate']),
        renderedNode('producer', 2, 2, ['Request']),
        renderedNode('nested-request', 3, 3, ['Request']),
        renderedNode('set', 1, 2, ['Method', 'Assignment', 'ContainerMethod', 'Set']),
      ],
      edges: [
        semanticEdge('EVAL', 'container', 'producer'),
        semanticEdge('ASSIGNS_VALUE', 'producer', 'set'),
      ],
    },
    semanticNodes: [
      semanticNode('container', ['Value', 'ValueSlot', 'ValueCreate']),
      containerSetNode('producer', ['producer'], 'simple'),
      semanticNode('producer', ['Request']),
      semanticNode('nested-request', ['Request']),
      semanticNode('result', ['Value', 'Result']),
    ],
    semanticEdges: [
      semanticEdge('TARGETS_VALUE', 'set', 'container'),
      semanticEdge('EVAL', 'container', 'producer'),
      semanticEdge('ASSIGNS_VALUE', 'producer', 'set'),
      semanticEdge('RESPONSE', 'nested-request', 'set'),
    ],
  });

  const set = graph.nodes.find((node) => node.id === 'set');
  assert.equal(set?.props.hybridOverlayOwnerStableId, 'container');
  assert.equal(set?.props.hybridOverlayKind, 'contained-action');
  assert.equal(set?.props.diaName, 'set');
  assert.equal(set?.props.displayX, 1.1);
  assert.equal(set?.props.displayY, 2.18);
  assert(graph.edges.some((edge) => (
    edge.type === 'ASSIGNS_VALUE'
    && edge.start === 'producer'
    && edge.end === 'set'
  )));
  assert(graph.edges.some((edge) => (
    edge.type === 'EVAL'
    && edge.start === 'container'
    && edge.end === 'producer'
  )));
  assert(!graph.edges.some((edge) => (
    edge.type === 'ASSIGNS_VALUE'
    && edge.start === 'nested-request'
    && edge.end === 'set'
  )));
});

test('compound container producer runs from the container and returns from every chain end into set', () => {
  const graph = projectHybridFlowGraph({
    drawioGraph: {
      nodes: [
        renderedNode('container', 1, 2, ['Value', 'ValueSlot', 'ValueCreate']),
        renderedNode('producer-start', 2, 2, ['Branch']),
        renderedNode('producer-end-left', 3, 1, ['Value']),
        renderedNode('producer-end-right', 3, 3, ['Value']),
        renderedNode('set', 1, 2, ['Method', 'Assignment', 'ContainerMethod', 'Set']),
      ],
      edges: [
        semanticEdge('EVAL', 'container', 'producer-start'),
        semanticEdge('ASSIGNS_VALUE', 'producer-end-left', 'set'),
        semanticEdge('ASSIGNS_VALUE', 'producer-end-right', 'set'),
      ],
    },
    semanticNodes: [
      semanticNode('container', ['Value', 'ValueSlot', 'ValueCreate']),
      containerSetNode(
        'producer-start',
        ['producer-end-left', 'producer-end-right'],
        'compound',
      ),
      semanticNode('producer-start', ['Branch']),
      semanticNode('producer-end-left', ['Value']),
      semanticNode('producer-end-right', ['Value']),
    ],
    semanticEdges: [
      semanticEdge('TARGETS_VALUE', 'set', 'container'),
      semanticEdge('EVAL', 'container', 'producer-start'),
      semanticEdge('ASSIGNS_VALUE', 'producer-end-left', 'set'),
      semanticEdge('ASSIGNS_VALUE', 'producer-end-right', 'set'),
    ],
  });

  assert(graph.edges.some((edge) => (
    edge.type === 'EVAL'
    && edge.start === 'container'
    && edge.end === 'producer-start'
  )));
  for (const producerEnd of ['producer-end-left', 'producer-end-right']) {
    assert(graph.edges.some((edge) => (
      edge.type === 'ASSIGNS_VALUE'
      && edge.start === producerEnd
      && edge.end === 'set'
    )));
  }
});

test('iterator return enters one combined value/set projection', () => {
  const set = semanticNode('set', [
    'Value',
    'ValuePass',
    'Iteration',
    'Method',
    'Assignment',
    'ContainerMethod',
    'Set',
  ], {
    diaName: 'cmd',
    renderPartsLayout: 'vertical',
    renderPartsJson: JSON.stringify([
      { text: 'cmd', kind: 'value', order: 0 },
      { text: 'set', kind: 'method', order: 1 },
    ]),
    producerStartStableId: 'find',
    producerEndStableIds: ['return-junction'],
    producerChainKind: 'compound',
  });
  const semanticNodes = [
    semanticNode('container', ['Value', 'ValueSlot', 'ValueCreate']),
    semanticNode('find', ['Collection', 'Method']),
    semanticNode('return-junction', ['ExecutionJunction']),
    set,
  ];
  const semanticEdges = [
    semanticEdge('EVAL', 'container', 'find'),
    semanticEdge('YIELDS_VALUE', 'return-junction', 'set'),
    semanticEdge('TARGETS_VALUE', 'set', 'container'),
  ];
  const coordinateEdges = projectHybridCoordinateEdges({
    nodes: semanticNodes,
    edges: [],
    semanticEdges,
  });
  assert.ok(coordinateEdges.some((edge) => (
    edge.type === 'YIELDS_VALUE'
    && edge.start === 'return-junction'
    && edge.end === 'set'
  )));

  const graph = projectHybridFlowGraph({
    drawioGraph: {
      nodes: [
        renderedNode('container', 1, 2, ['Value', 'ValueSlot', 'ValueCreate']),
        renderedNode('find', 2, 2, ['Collection', 'Method']),
        renderedNode('return-junction', 3, 2, ['ExecutionJunction']),
        { ...renderedNode('set', 1, 2, set.labels), props: { ...set.props, displayX: 1, displayY: 2 } },
      ],
      edges: semanticEdges,
    },
    semanticNodes,
    semanticEdges,
  });
  assert.equal(graph.nodes.filter((node) => node.id === 'set').length, 1);
  assert.equal(graph.nodes.find((node) => node.id === 'set')?.props.renderPartsLayout, 'vertical');
  assert.ok(graph.edges.some((edge) => (
    edge.type === 'YIELDS_VALUE'
    && edge.start === 'return-junction'
    && edge.end === 'set'
    && edge.props?.renderHidden === false
  )));
});

test('an unselected compound tail keeps the extracted entry and returns through its visible request', () => {
  const graph = projectHybridFlowGraph({
    drawioGraph: {
      nodes: [
        renderedNode('container', 1, 2, ['Value', 'ValueSlot', 'ValueCreate']),
        renderedNode('request', 2, 2, ['Request']),
        renderedNode('set', 1, 2, ['Method', 'Assignment', 'ContainerMethod', 'Set']),
      ],
      edges: [
        semanticEdge('EVAL', 'container', 'request'),
        semanticEdge('ASSIGNS_VALUE', 'request', 'set'),
      ],
    },
    semanticNodes: [
      semanticNode('container', ['Value', 'ValueSlot', 'ValueCreate']),
      containerSetNode('request', ['hidden-method'], 'compound'),
      semanticNode('request', ['Request']),
      semanticNode('hidden-method', ['Method', 'Op']),
    ],
    semanticEdges: [
      semanticEdge('TARGETS_VALUE', 'set', 'container'),
      semanticEdge('EVAL', 'container', 'request'),
      semanticEdge('ASSIGNS_VALUE', 'request', 'set'),
    ],
  });

  assert(graph.edges.some((edge) => (
    edge.type === 'ASSIGNS_VALUE'
    && edge.start === 'request'
    && edge.end === 'set'
    && edge.props?.sourcePort === 'left'
    && edge.props?.targetPort === 'right'
  )));
  assert(graph.edges.some((edge) => (
    edge.type === 'EVAL'
    && edge.start === 'container'
    && edge.end === 'request'
  )));
  assert(!graph.nodes.some((node) => node.id === 'hidden-method'));
  assert.equal(
    graph.hybridProjection.containerSetProjections[0]?.producerChainCollapsed,
    true,
  );
});

test('operand branch overlays its graph-backed variable occurrences without visible semantic edges', () => {
  const graph = projectHybridFlowGraph({
    drawioGraph: {
      nodes: [
        renderedNode('expression', 2, 3, ['Branch', 'Operand']),
      ],
      edges: [],
    },
    semanticNodes: [
      semanticNode('expression', ['Branch', 'Operand']),
      semanticNode('space-index-occurrence', [
        'Value',
        'Occurrence',
        'OperandValue',
        'Variable',
      ], {
        diaName: 'spaceIndex',
        sequenceOwnerStableId: 'expression',
        sequenceOrder: 0,
        renderHidden: true,
      }),
    ],
    semanticEdges: [
      semanticEdge('READS_VALUE', 'space-index-occurrence', 'expression'),
    ],
  });

  const occurrence = graph.nodes.find((node) => node.id === 'space-index-occurrence');
  assert.equal(occurrence?.props.hybridVisualRole, 'operand-occurrence');
  assert.equal(occurrence?.props.hybridOverlayOwnerStableId, 'expression');
  assert.equal(occurrence?.props.hybridOverlayKind, 'operand-in-expression');
  assert.equal(occurrence?.props.displayX, 2.1);
  assert.equal(occurrence?.props.displayY, 3);
  assert(!graph.edges.some((edge) => (
    edge.start === 'space-index-occurrence' || edge.end === 'space-index-occurrence'
  )));
});

test('container set is not duplicated when a collection method already fills the container', () => {
  const graph = projectHybridFlowGraph({
    drawioGraph: {
      nodes: [
        renderedNode('container', 1, 2, ['Value', 'ValueSlot', 'ValueCreate']),
        {
          ...renderedNode('emit', 1.1, 2.18, ['Collection', 'HybridAssignment']),
          props: {
            ...renderedNode('emit', 1.1, 2.18).props,
            diaName: 'push',
            hybridVisualRole: 'assignment',
            hybridOverlayOwnerStableId: 'container',
            hybridOverlayKind: 'contained-action',
          },
        },
        renderedNode('producer-start', 2, 2, ['Collection']),
        renderedNode('producer-end', 3, 2, ['Value']),
      ],
      edges: [],
    },
    semanticNodes: [
      semanticNode('container', ['Value', 'ValueSlot', 'ValueCreate']),
      containerSetNode('producer-start', ['producer-end'], 'compound'),
      semanticNode('producer-start', ['Collection']),
      semanticNode('producer-end', ['Value']),
    ],
    semanticEdges: [
      semanticEdge('TARGETS_VALUE', 'set', 'container'),
      semanticEdge('EXHAUSTED', 'producer-end', 'set'),
    ],
  });

  assert(!graph.nodes.some((node) => node.id === 'set'));
  assert.equal(graph.nodes.filter((node) => (
    node.props?.hybridVisualRole === 'assignment'
    && node.props?.hybridOverlayOwnerStableId === 'container'
  )).length, 1);
});

test('collection submethod positions real members without junction nodes or invented edges', () => {
  const step = 'step:collection-search';
  const roles = {
    target: ['Value'],
    assign: ['Set'],
    call: ['Method'],
    iterator: ['Primitive'],
    source: ['Collection'],
    pull: ['Method'],
    pulledCandidate: ['Value'],
    bind: ['Value'],
    item: ['Value'],
    selectedItem: ['Value'],
    exhausted: ['Value', 'Exhausted'],
    namePredicate: ['Branch', 'Predicate'],
  };
  const semanticNodes = Object.entries(roles).map(([role, labels]) => semanticNode(role, labels, {
    diaName: role,
    parentStepStableId: step,
    executionProtocolStableId: 'iterator',
    executionRoles: role === 'selectedItem' ? ['selectedItem', 'result'] : [role],
    ...(role === 'source' ? {
      submethodRelativeColumn: 1,
      submethodRelativeRow: 0,
    } : {}),
    ...(role === 'pull' ? {
      submethodRelativeColumn: 1,
      submethodRelativeRow: 1,
    } : {}),
    ...(role === 'call' ? {
      primitiveKind: 'iterate',
      executionScopeKind: 'collection-iterator',
      executionProtocolKind: 'collection-search',
      executionRoles: ['call', 'iterator'],
      submethodsJson: JSON.stringify([{
        stableId: 'call',
        parentStableId: 'target',
        kind: 'collection-method',
        headerStableId: 'call',
        ownerStableId: 'call',
        memberStableIds: ['item', 'namePredicate'],
        attachments: [
          { stableId: 'source', placement: 'right', anchorStableId: 'call' },
          { stableId: 'pull', placement: 'overlay', anchorStableId: 'source' },
          { stableId: 'exhausted', placement: 'right', anchorStableId: 'pull' },
        ],
      }]),
    } : {}),
  }));
  const semanticEdges = [];
  semanticEdges.push(
    semanticEdge('YIELDS_VALUE', 'pull', 'item'),
    semanticEdge('NEXT', 'call', 'item'),
    semanticEdge('NEXT', 'item', 'namePredicate'),
  );

  const graph = projectHybridFlowGraph({
    drawioGraph: {
      nodes: semanticNodes.map((node, index) => ({
        ...renderedNode(node.key, 1 + index, 2, node.labels),
        props: {
          ...renderedNode(node.key, 1 + index, 2, node.labels).props,
          parentStepStableId: step,
        },
      })),
      edges: [],
    },
    semanticNodes,
    semanticEdges,
  });

  const header = graph.nodes.find((node) => node.id === 'call');
  const item = graph.nodes.find((node) => node.id === 'item');
  const predicate = graph.nodes.find((node) => node.id === 'namePredicate');
  const source = graph.nodes.find((node) => node.id === 'source');
  const pull = graph.nodes.find((node) => node.id === 'pull');
  const exhausted = graph.nodes.find((node) => node.id === 'exhausted');
  const target = graph.nodes.find((node) => node.id === 'target');
  assert(Number(header?.props?.displayX) > Number(target?.props?.displayX));
  assert.equal(item?.props?.displayX, header?.props?.displayX);
  assert.equal(predicate?.props?.displayX, header?.props?.displayX);
  assert(Number(item?.props?.displayY) > Number(header?.props?.displayY));
  assert(Number(predicate?.props?.displayY) > Number(item?.props?.displayY));
  assert(Number(source?.props?.displayX) > Number(item?.props?.displayX));
  assert.equal(source?.props?.displayY, header?.props?.displayY);
  assert(Number(pull?.props?.displayX) > Number(source?.props?.displayX));
  assert(
    Number(pull?.props?.displayX) - Number(source?.props?.displayX) < 0.5,
    'an overlay with relative coordinates must stay attached to its actual owner',
  );
  assert.equal(header?.props?.diaName, 'call');
  assert.equal(header?.props?.suppressObjectMethodVisual, true);
  assert.equal(pull?.props?.hybridOverlayOwnerStableId, 'source');
  assert.equal(exhausted?.props?.hybridVisualRole, 'exhausted-marker');
  assert(exhausted?.labels?.includes('HybridExhausted'));
  assert.equal(graph.nodes.length, semanticNodes.length);
  assert.equal(graph.edges.length, 0, 'projection must not manufacture edges missing from the rendered graph');
});

test('collection submethod follows its extracted producer anchor and keeps the result beside it', () => {
  const step = 'step:call-filter';
  const target = semanticNode('target', ['Value'], { parentStepStableId: step });
  const producer = semanticNode('producer', ['Request', 'Start'], { parentStepStableId: step });
  const filter = semanticNode('filter', ['Method', 'Primitive', 'SubStep'], {
    parentStepStableId: step,
    primitiveKind: 'iterate',
    executionScopeKind: 'collection-iterator',
    executionProtocolKind: 'collection-select',
    executionProtocolStableId: 'filter',
    submethodAnchorStableId: 'producer',
    substepRowOffset: 1,
    submethodsJson: JSON.stringify([{
      stableId: 'filter',
      parentStableId: 'target',
      kind: 'collection-method',
      headerStableId: 'filter',
      memberStableIds: ['item'],
      attachments: [{ stableId: 'result', placement: 'right', anchorStableId: 'item' }],
    }]),
  });
  const item = semanticNode('item', ['Value', 'Iteration', 'Variable', 'SubStepMember'], {
    parentStepStableId: step,
    memberOfSubmethodStableId: 'filter',
    submethodPlacement: 'axis',
    submethodRelativeColumn: 0,
    submethodRelativeRow: 1,
  });
  const result = semanticNode('result', ['Collection', 'SubStepAttachment'], {
    parentStepStableId: step,
    memberOfSubmethodStableId: 'filter',
    submethodPlacement: 'right',
    submethodAnchorStableId: 'item',
    submethodRelativeColumn: 1,
    submethodRelativeRow: 0,
  });
  const semanticNodes = [target, producer, filter, item, result];
  const graph = projectHybridFlowGraph({
    drawioGraph: {
      nodes: [
        renderedNode('target', 1, 2, target.labels),
        renderedNode('producer', 2, 3, producer.labels),
        renderedNode('filter', 2, 4, filter.labels),
        renderedNode('item', 2, 5, item.labels),
        renderedNode('result', 3, 5, result.labels),
      ].map((node) => ({
        ...node,
        props: { ...node.props, parentStepStableId: step },
      })),
      edges: [],
    },
    semanticNodes,
    semanticEdges: [semanticEdge('NEXT', 'producer', 'filter')],
  });

  const projectedProducer = graph.nodes.find((node) => node.id === 'producer');
  const projectedFilter = graph.nodes.find((node) => node.id === 'filter');
  const projectedItem = graph.nodes.find((node) => node.id === 'item');
  const projectedResult = graph.nodes.find((node) => node.id === 'result');
  assert(Number(projectedFilter?.props?.displayY) > Number(projectedProducer?.props?.displayY));
  assert(Number(projectedItem?.props?.displayY) > Number(projectedFilter?.props?.displayY));
  assert.equal(projectedResult?.props?.displayY, projectedItem?.props?.displayY);
  assert(Number(projectedResult?.props?.displayX) > Number(projectedFilter?.props?.displayX));
});

test('coordinate projection restores extracted collection returns into a waiting set container', () => {
  const nodes = [
    { key: 'predicate', labels: ['Branch', 'Operand'], props: {} },
    { key: 'target', labels: ['Value', 'ContainerMethod', 'Set'], props: {} },
  ];
  const semanticEdges = [semanticEdge('TRUE', 'predicate', 'target', {
    protocolRole: 'assignment-return',
    sourcePort: 'left',
    targetPort: 'right',
  })];
  const projected = projectHybridCoordinateEdges({ nodes, edges: [], semanticEdges });
  assert.equal(projected.length, 1);
  assert.equal(projected[0].type, 'TRUE');
  assert.equal(projected[0].start, 'predicate');
  assert.equal(projected[0].end, 'target');
  assert.equal(projected[0].props.sourcePort, 'left');
  assert.equal(projected[0].props.targetPort, 'right');
});

test('nested function submethods shift right and retain only graph-backed nodes and edges', () => {
  const step = 'step:state-update';
  const roles = [
    'stateUpdateCall', 'stateUpdater', 'previousAttribution',
    'incrementCall', 'incrementFunction', 'newAttribution',
    'attributionSpread', 'promptCount', 'snapshot', 'returnedAttribution',
    'recordSnapshotArgument', 'persistSnapshotArgument', 'recordCall',
    'recordFunction', 'sessionWrite', 'sessionStore', 'caughtError',
    'errorArgument', 'logCall', 'nextState', 'previousStateField',
    'attributionField', 'nextStateComplete', 'stateWrite', 'appStateStore',
  ];
  const semanticNodes = roles.map((role) => semanticNode(role, [
    role.endsWith('Function') ? 'Fn' : 'Value',
    ...(role === 'stateUpdater' ? ['StateUpdater'] : []),
    ...(['sessionStore', 'appStateStore'].includes(role) ? ['Storage'] : []),
  ], {
    diaName: `graph:${role}`,
    parentStepStableId: step,
    executionProtocolStableId: 'stateUpdateCall',
    executionRoles: [role],
    ...(['newAttribution', 'snapshot', 'appStateStore'].includes(role)
      ? { operationCalleeText: 'inherited-call-name' }
      : {}),
    ...(role === 'newAttribution' ? {
      call_mosaic_owner_stable_id: 'stateWrite',
      call_mosaic_role: 'argument',
    } : {}),
    ...(role === 'stateUpdateCall' ? {
      executionProtocolKind: 'state-update-with-callback-effect',
      executionRoles: ['stateUpdateCall'],
      submethodsJson: JSON.stringify([
        { stableId: 'stateUpdateCall', headerStableId: 'stateUpdateCall', ownerStableId: 'stateUpdater', memberStableIds: ['incrementCall', 'returnedAttribution', 'nextState', 'stateWrite'], attachments: [{ stableId: 'appStateStore', placement: 'overlay', anchorStableId: 'stateWrite' }], order: 60 },
        { stableId: 'incrementCall', parentStableId: 'stateUpdateCall', headerStableId: 'incrementCall', ownerStableId: 'incrementFunction', memberStableIds: ['newAttribution', 'snapshot', 'recordCall'], order: 70 },
        { stableId: 'recordCall', parentStableId: 'incrementCall', headerStableId: 'recordCall', ownerStableId: 'recordFunction', memberStableIds: ['sessionWrite', 'caughtError'], attachments: [{ stableId: 'sessionStore', placement: 'overlay', anchorStableId: 'sessionWrite' }], order: 80 },
      ]),
    } : {}),
  }));
  const semanticEdges = [];
  semanticEdges.push(semanticEdge('INVOKES', 'stateUpdateCall', 'stateUpdater'));
  semanticEdges.push(
    semanticEdge('NEXT', 'stateUpdateCall', 'incrementCall'),
    semanticEdge('NEXT', 'incrementCall', 'returnedAttribution'),
    semanticEdge('NEXT', 'returnedAttribution', 'nextState'),
    semanticEdge('NEXT', 'nextState', 'stateWrite'),
    semanticEdge('NEXT', 'incrementCall', 'newAttribution'),
    semanticEdge('NEXT', 'newAttribution', 'snapshot'),
    semanticEdge('NEXT', 'snapshot', 'recordCall'),
    semanticEdge('NEXT', 'recordCall', 'sessionWrite'),
    semanticEdge('NEXT', 'sessionWrite', 'caughtError'),
  );

  const graph = projectHybridFlowGraph({
    drawioGraph: {
      nodes: semanticNodes.map((node, index) => ({
        ...renderedNode(node.key, 1 + index, 2, node.labels),
        props: {
          ...node.props,
          ...renderedNode(node.key, 1 + index, 2, node.labels).props,
          parentStepStableId: step,
        },
      })),
      edges: [],
    },
    semanticNodes,
    semanticEdges,
  });

  assert.equal(graph.hybridProjection.protocolCount, 1, JSON.stringify(graph.hybridProjection));
  const projectedRoot = graph.nodes.find((node) => node.id === 'stateUpdateCall');
  assert.equal(projectedRoot?.props.diaName, 'stateUpdateCall', JSON.stringify(projectedRoot));
  const increment = graph.nodes.find((node) => node.id === 'incrementCall');
  const record = graph.nodes.find((node) => node.id === 'recordCall');
  const newAttribution = graph.nodes.find((node) => node.id === 'newAttribution');
  const stateWrite = graph.nodes.find((node) => node.id === 'stateWrite');
  const appStateStore = graph.nodes.find((node) => node.id === 'appStateStore');
  assert(Number(increment?.props?.displayX) > Number(projectedRoot?.props?.displayX));
  assert(Number(record?.props?.displayX) > Number(increment?.props?.displayX));
  assert.equal(newAttribution?.props?.call_mosaic_owner_stable_id, 'stateWrite');
  assert.equal(newAttribution?.props?.call_mosaic_role, 'argument');
  assert(Number(stateWrite?.props?.displayY) > Number(newAttribution?.props?.displayY));
  assert(Number(appStateStore?.props?.displayY) < Number(stateWrite?.props?.displayY));
  assert(Math.abs(Number(appStateStore?.props?.displayX) - Number(stateWrite?.props?.displayX)) < 0.1);
  assert.equal(
    graph.nodes.filter((node) => node.props?.hybridVisualRole === 'column-junction').length,
    0,
  );
  assert.equal(graph.nodes.length, semanticNodes.length);
  assert.equal(graph.edges.length, 0);
  assert.equal(
    graph.nodes.filter((node) => (
      node.props?.hybridVisualRole === 'functional-column'
      && node.props?.renderHidden !== true
    )).length,
    0,
    'a continuous visual column must not duplicate the graph-backed axis segments',
  );
});
