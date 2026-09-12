import assert from 'node:assert/strict';
import test from 'node:test';

import {
  alignHorizontalArgumentFamilies,
  alignObjectBraceFamilies,
  assignStepAndFlowBlockColumns,
  buildObjectFamilyRouteObstacles,
  fixedHexGeometry,
  flowBlockLeftBoundary,
  horizontalMosaicImage,
  isLeftStepEntryBarrier,
  isObjectFamilyMemberTraversalEdge,
  makeDrawio,
  methodMosaicImage,
  orderEdgesForRouting,
} from './localCoordinateDrawio.mjs';

test('object-family bounds do not follow declaration-directed binding edges', () => {
  assert.equal(isObjectFamilyMemberTraversalEdge({ type: 'READS_VALUE' }), false);
  assert.equal(isObjectFamilyMemberTraversalEdge({ type: 'PASSES_VALUE' }), false);
  assert.equal(isObjectFamilyMemberTraversalEdge({ type: 'EVAL' }), true);
  assert.equal(isObjectFamilyMemberTraversalEdge({ type: 'YIELDS_VALUE' }), true);
});

const stepId = 'flow-step:statement:fixture.ts:1:1:1:20';
const blockId = 'flow-block:side:true:fixture.ts:1:1:1:20';

function node(id, labels, extra = {}) {
  return {
    id,
    labels,
    props: {
      label: id,
      parentFnStableId: 'fixture.ts:1:1:3:1',
      parentStepStableId: stepId,
      parentFlowBlockStableId: blockId,
      flowStepOrder: 0,
      ...extra,
    },
  };
}

const semanticNodes = [
  {
    key: stepId,
    labels: ['Step'],
    props: {
      headStableIds: ['fixture.ts:1:1:1:5'],
      tailStableIds: ['fixture.ts:1:8:1:20'],
    },
  },
  {
    key: blockId,
    labels: ['Block'],
    props: {
      headStableIds: ['fixture.ts:1:1:1:5'],
      tailStableIds: ['fixture.ts:1:8:1:20'],
    },
  },
];

test('Steps remain layout groups without frames or controls while FlowBlocks stay visible', () => {
  const member = node('fixture.ts:1:1:1:5', ['Call', 'Start'], {
    displayX: 0,
    displayY: 0,
  });
  const xml = makeDrawio([member], [], { semanticNodes });
  const stepGroup = xml.match(/<mxCell id="fold-row-[^"]+"[^>]+>/u)?.[0] || '';

  assert.match(stepGroup, /style="group;html=1;container=1;collapsible=0;"/u);
  assert.doesNotMatch(stepGroup, /coldKodeFoldingFrame|foldingIcon|graphKind="Step"/u);
  assert.match(xml, /flowBlock="1" graphKind="FlowBlock"/u);
});

test('FlowBlock frames keep their composition without folding mechanics or split edges', () => {
  const nextStepId = 'flow-step:statement:fixture.ts:2:1:2:20';
  const first = node('fixture.ts:1:1:1:5', ['Call', 'Start'], {
    displayX: 0,
    displayY: 0,
  });
  const second = node('fixture.ts:2:1:2:5', ['Call'], {
    displayX: 0,
    displayY: 1,
    parentStepStableId: nextStepId,
    flowStepOrder: 1,
  });
  const twoStepSemanticNodes = [
    ...semanticNodes,
    {
      key: nextStepId,
      labels: ['Step'],
      props: {
        headStableIds: [second.id],
        tailStableIds: [second.id],
      },
    },
  ];
  const graphEdges = [{ start: first.id, end: second.id, type: 'NEXT', props: {} }];
  const foldedXml = makeDrawio([first, second], graphEdges, {
    semanticNodes: twoStepSemanticNodes,
  });
  const flatEdgeXml = makeDrawio([first, second], graphEdges, {
    semanticNodes: twoStepSemanticNodes,
    disableFoldingMechanics: true,
    serializeUnifiedEdges: true,
  });
  const nodeGeometry = (xmlText, cellId) => xmlText.match(new RegExp(
    `<mxCell id="${cellId}"[\\s\\S]*?<mxGeometry x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`,
    'u',
  ))?.slice(1);

  assert.match(flatEdgeXml, /flowBlock="1" graphKind="FlowBlock"/u);
  assert.doesNotMatch(flatEdgeXml, /collapsible=1|foldingRow=1|foldingIconSize|alternateBounds/u);
  assert.match(flatEdgeXml, /<mxGraphModel[^>]+fold="0"/u);
  assert.match(flatEdgeXml, /<mxCell id="e1"[^>]+parent="1"[^>]+source="n1" target="n2"/u);
  assert.doesNotMatch(flatEdgeXml, /foldBoundaryPort|id="e1-(?:source|boundary|target)"/u);
  assert.deepEqual(nodeGeometry(flatEdgeXml, 'n1'), nodeGeometry(foldedXml, 'n1'));
  assert.deepEqual(nodeGeometry(flatEdgeXml, 'n2'), nodeGeometry(foldedXml, 'n2'));
});

test('FlowBlock bounds do not apply the former Step inset to diagonal visual overhangs', () => {
  assert.deepEqual(
    flowBlockLeftBoundary(
      [{ x: 235, width: 100 }],
      [{ left: 169, right: 335 }],
      100,
    ),
    { minNodeX: 235, minContentX: 169, x: 153 },
  );
});

test('hexagons keep a fixed 16px side depth at different widths', () => {
  assert.deepEqual(fixedHexGeometry(40), {
    svgWidth: 40,
    leftTip: 1,
    leftShoulder: 17,
    rightShoulder: 23,
    rightTip: 39,
  });
  assert.deepEqual(fixedHexGeometry(200), {
    svgWidth: 200,
    leftTip: 1,
    leftShoulder: 17,
    rightShoulder: 183,
    rightTip: 199,
  });

  const narrowEnd = decodeURIComponent(horizontalMosaicImage('end', '#fff', '#000', true, 40));
  const compactEnd = decodeURIComponent(horizontalMosaicImage('end', '#fff', '#000', true, 22));
  const wideEnd = decodeURIComponent(horizontalMosaicImage('end', '#fff', '#000', true, 200));
  assert.match(compactEnd, /viewBox='0 0 22 50'/u);
  assert.match(compactEnd, /H 5 L 21 25 L 5 49/u);
  assert.match(narrowEnd, /viewBox='0 0 40 50'/u);
  assert.match(narrowEnd, /H 23 L 39 25 L 23 49/u);
  assert.match(wideEnd, /viewBox='0 0 200 50'/u);
  assert.match(wideEnd, /H 183 L 199 25 L 183 49/u);
});

test('method silhouettes use curved outer sides, straight mosaic joins, and inward-curved family boundaries', () => {
  const standalone = decodeURIComponent(methodMosaicImage('single', '#DAE8FC', '#007FFF', { width: 120 }));
  const opening = decodeURIComponent(methodMosaicImage('start', '#DAE8FC', '#007FFF', { width: 80 }));
  const closing = decodeURIComponent(methodMosaicImage('end', '#DAE8FC', '#007FFF', { width: 80 }));
  const tornOpening = decodeURIComponent(methodMosaicImage('start', '#DAE8FC', '#007FFF', { torn: true, width: 80 }));
  const tornClosing = decodeURIComponent(methodMosaicImage('end', '#DAE8FC', '#007FFF', { torn: true, width: 80 }));
  const tornRightTile = decodeURIComponent(methodMosaicImage('torn-right', '#DAE8FC', '#007FFF', { width: 80 }));
  const tornLeftTile = decodeURIComponent(methodMosaicImage('torn-left', '#DAE8FC', '#007FFF', { width: 80 }));

  assert.match(standalone, /M 10 1 H 110 C/u);
  assert.match(standalone, /H 10 C 7\.433 45\.87/u);
  assert.match(opening, /H 80 V 49 H 10 C/u);
  assert.match(closing, /M 0 1 H 70 C/u);
  assert.match(tornOpening, /H 80 C 76\.74 5\.179[^']+70\.765 24\.975[^']+80 49/u);
  assert.match(tornClosing, /H 0 C 2\.567 45\.87[^']+9\.235 24\.975[^']+0 1/u);
  assert.match(tornRightTile, /M 0 1 H 80 C 76\.74 5\.179[^']+80 49 H 0 Z/u);
  assert.match(tornLeftTile, /M 0 1 H 80 V 49 H 0 C 2\.567 45\.87[^']+0 1 Z/u);
  for (const familyBoundary of [tornOpening, tornClosing, tornRightTile, tornLeftTile]) {
    assert.doesNotMatch(familyBoundary, /L 70 14|L 7 29/u);
  }
});

test('a split call closure matches call height, curves inward, and uses regular text', () => {
  const openingId = 'fixture.ts:2:1:4:2:open';
  const closingId = 'fixture.ts:2:1:4:2:close';
  const nodes = [
    node(openingId, ['Call', 'Start'], {
      displayX: 0,
      displayY: 0,
      diaName: 'setState(',
      splitCallBoundary: 'start',
      callBoundaryDesign: 'split',
      callBoundaryRole: 'open',
    }),
    node(closingId, ['Fn', 'Arg', 'Join', 'VisualProxy'], {
      displayX: 1,
      displayY: 0,
      diaName: ')',
      splitCallBoundary: 'end',
      callBoundaryDesign: 'split',
      callBoundaryRole: 'close',
      callMosaicOwnerStableId: openingId,
      callMosaicRole: 'close',
    }),
  ];

  const xml = makeDrawio(nodes, [], { semanticNodes });
  const closingCell = xml.match(/<mxCell id="n2"[\s\S]+?<\/mxCell>/u)?.[0] || '';
  assert.match(closingCell, /width="28" height="30"/u);
  assert.doesNotMatch(closingCell, /fontStyle=1/u);
  assert.match(decodeURIComponent(closingCell), /H 0 C 2\.567 45\.87/u);
  assert.match(decodeURIComponent(closingCell), /M 0 1 H 18 C/u);
  assert.doesNotMatch(decodeURIComponent(closingCell), /M 0 24\.975 H/u);
});

test('virtual split call closures retain hatched fill without ContainerMethod labels', () => {
  const closing = node('fixture:close', ['Fn', 'Arg', 'Join', 'VisualProxy', 'Virtual'], {
    displayX: 0, displayY: 0, diaName: ')',
    splitCallBoundary: 'end', callBoundaryDesign: 'split', callBoundaryRole: 'close',
  });
  const xml = makeDrawio([closing], [], { semanticNodes });
  const cell = xml.match(/<mxCell id="n1"[\s\S]+?<\/mxCell>/u)?.[0] || '';
  assert.match(decodeURIComponent(cell), /clipPath/u);
});

test('value access arguments use ordinary variable tiles', () => {
  const argument = node('fixture:argument', ['Arg', 'Value', 'ValueAccess'], {
    displayX: 0, displayY: 0, diaName: 'first',
  });
  const xml = makeDrawio([argument], [], { semanticNodes });
  const cell = xml.match(/<mxCell id="n1"[\s\S]+?<\/mxCell>/u)?.[0] || '';
  assert.match(cell, /fillColor=#FFE6CC;strokeColor=#BE7000/u);
  assert.doesNotMatch(cell, /shape=image|fontStyle=1/u);
});

test('split call boundaries curve outward at family edges, inward at the gap, and stay flat at mosaic seams', () => {
  const ownerId = 'fixture.ts:2:1:2:90:mosaic';
  const nodes = [
    node(ownerId, ['Call', 'Request'], {
      displayX: 0,
      displayY: 0,
      diaName: 'outer(',
      callBoundaryDesign: 'split',
      callBoundaryRole: 'open',
      callMosaicOwnerStableId: ownerId,
      callMosaicRole: 'open',
    }),
    node(`${ownerId}:argument`, ['Call', 'Request'], {
      displayX: 1,
      displayY: 0,
      diaName: 'inner(',
      callBoundaryDesign: 'split',
      callBoundaryRole: 'open',
      callMosaicOwnerStableId: ownerId,
      callMosaicRole: 'argument',
    }),
    node(`${ownerId}:argument-close`, ['Fn', 'VisualProxy'], {
      displayX: 2,
      displayY: 0,
      diaName: ')',
      callBoundaryDesign: 'split',
      callBoundaryRole: 'close',
      callMosaicOwnerStableId: ownerId,
      callMosaicRole: 'argument-close',
    }),
    node(`${ownerId}:close`, ['Fn', 'VisualProxy'], {
      displayX: 3,
      displayY: 0,
      diaName: ')',
      callBoundaryDesign: 'split',
      callBoundaryRole: 'close',
      callMosaicOwnerStableId: ownerId,
      callMosaicRole: 'close',
    }),
  ];
  const xml = makeDrawio(nodes, [], { semanticNodes, suppressFoldingContainers: true });
  const decodedCell = (cellId) => decodeURIComponent(
    xml.match(new RegExp(`<mxCell id="${cellId}"[\\s\\S]+?</mxCell>`, 'u'))?.[0] || '',
  );
  const opening = decodedCell('n1');
  const argument = decodedCell('n2');
  const argumentClose = decodedCell('n3');
  const close = decodedCell('n4');

  assert.match(opening, /M 10 1 H \d+ C[^']+H 10 C/u);
  assert.match(argument, /M 0 1 H \d+ C[^']+H 0 Z/u);
  assert.match(argumentClose, /M 0 1 H \d+ V 49 H 0 C 2\.567 45\.87[^']+0 1 Z/u);
  assert.match(close, /M 0 1 H \d+ C[^']+H 0 C 2\.567 45\.87/u);
  assert.match(opening, /H \d+ C \d+(?:\.\d+)? 5\.179/u);
  assert.doesNotMatch(argumentClose, /H \d+ C \d+(?:\.\d+)? 5\.179/u);
  assert.match(close, /H 0 C 2\.567 45\.87/u);
});

test('a split call closure leaves a routing junction after its widest argument family', () => {
  const openingId = 'fixture.ts:2:1:2:90:open';
  const firstArgumentId = 'fixture.ts:2:10:2:30:arg0';
  const secondArgumentId = 'fixture.ts:2:32:2:80:arg1';
  const closingId = 'fixture.ts:2:1:2:90:close';
  const nodes = [
    node(openingId, ['Call', 'Start'], {
      displayX: 0,
      displayY: 0,
      diaName: 'push(',
      splitCallBoundary: 'start',
      callBoundaryDesign: 'split',
      callBoundaryRole: 'open',
    }),
    node(firstArgumentId, ['Value', 'Arg'], { displayX: 2, displayY: 0, diaName: 'first' }),
    node(secondArgumentId, ['Value', 'Arg'], {
      displayX: 4,
      displayY: 1,
      diaName: 'theLongerSecondArgument',
    }),
    node(closingId, ['Fn', 'Arg', 'Join', 'VisualProxy'], {
      displayX: 1,
      displayY: 2,
      diaName: ')',
      sourceCallStableId: openingId,
      splitCallBoundary: 'end',
      callBoundaryDesign: 'split',
      callBoundaryRole: 'close',
    }),
  ];
  const edges = [
    { start: firstArgumentId, end: closingId, type: 'ArgJoin', props: {} },
    { start: secondArgumentId, end: closingId, type: 'ArgJoin', props: {} },
  ];
  const xml = makeDrawio(nodes, edges, { semanticNodes, suppressFoldingContainers: true });
  const geometry = (cellId) => {
    const match = xml.match(new RegExp(
      `<mxCell id="${cellId}"[^>]*>[\\s\\S]*?<mxGeometry x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`,
      'u',
    ));
    assert.ok(match, `geometry not found: ${cellId}`);
    return match.slice(1).map(Number);
  };
  const opening = geometry('n1');
  const firstArgument = geometry('n2');
  const secondArgument = geometry('n3');
  const closing = geometry('n4');

  assert.equal(
    closing[0],
    Math.max(firstArgument[0] + firstArgument[2], secondArgument[0] + secondArgument[2]) + 46,
  );
  assert.equal(opening[1], closing[1]);
  for (const edgeId of ['e1', 'e2']) {
    const edgeCell = xml.match(new RegExp(`<mxCell id="${edgeId}"[^>]*>`, 'u'))?.[0] || '';
    assert.match(edgeCell, /entryX=0;entryY=0\.5;entryPerimeter=1/u);
  }
});

test('a split collection method overlay curves inward at its object-family boundary', () => {
  const openingId = 'fixture.ts:5:1:8:2:open';
  const opening = node(openingId, ['Op', 'Method', 'Start', 'Collection', 'System'], {
    displayX: 0,
    displayY: 0,
    callBoundaryDesign: 'split',
    callBoundaryRole: 'open',
    callMosaicOwnerStableId: openingId,
    callMosaicRole: 'open',
    renderPartsLayout: 'container-overlay-side',
    renderPartsJson: JSON.stringify([
      { kind: 'collection-container', text: 'contentBlocks' },
      { kind: 'method', text: 'push(', labels: ['Method', 'System'] },
    ]),
  });

  const xml = makeDrawio([opening], [], { semanticNodes });
  const methodCell = xml.match(/<mxCell id="n1-part-2"[\s\S]+?<\/mxCell>/u)?.[0] || '';
  assert.match(methodCell, /height="30"/u);
  assert.match(decodeURIComponent(methodCell), /H 47 C 43\.74 5\.179[^']+37\.765 24\.975[^']+47 49/u);
  assert.match(decodeURIComponent(methodCell), /H 10 C 7\.433 45\.87/u);
});

test('push collection control links use the stack while value links keep the method endpoint', () => {
  const pushId = 'fixture.ts:5:1:8:2:push';
  const predecessorId = 'fixture.ts:4:1:4:8:before';
  const continuationId = 'fixture.ts:9:1:9:8:after';
  const argumentId = 'fixture.ts:6:1:6:8:argument';
  const push = node(pushId, ['Op', 'Method', 'Start', 'Collection', 'System'], {
    displayX: 1,
    displayY: 0,
    callBoundaryDesign: 'split',
    callBoundaryRole: 'open',
    splitCallBoundary: 'start',
    renderPartsLayout: 'container-overlay-side',
    renderPartsJson: JSON.stringify([
      { kind: 'collection-container', text: 'items', fillState: 'filled' },
      { kind: 'method', text: 'push(', labels: ['Method', 'System'] },
    ]),
  });
  const nodes = [
    push,
    node(predecessorId, ['Branch'], { displayX: 0, displayY: 0 }),
    node(continuationId, ['Value'], { displayX: 2, displayY: 0 }),
    node(argumentId, ['Value', 'Arg'], { displayX: 2, displayY: 1 }),
  ];
  const edges = [
    { start: predecessorId, end: pushId, type: 'NEXT', props: { flowLayer: 'control' } },
    { start: pushId, end: continuationId, type: 'REJOINS', props: { flowLayer: 'control' } },
    { start: pushId, end: argumentId, type: 'ARG', props: { flowLayer: 'data' } },
  ];
  const xml = makeDrawio(nodes, edges, { semanticNodes, suppressFoldingContainers: true });
  const edgeCell = (type) => xml.match(new RegExp(`<mxCell[^>]+edgeType="${type}"[^>]*>`, 'u'))?.[0] || '';

  assert.match(edgeCell('NEXT'), /target="n1-part-1"/u);
  assert.match(edgeCell('REJOINS'), /source="n1-part-1"/u);
  assert.match(edgeCell('ARG'), /source="n1-part-2"/u);
});

test('NEXT keeps its source and enters the stack of a virtual push mosaic owner', () => {
  const contentId = 'fixture.ts:5:10:5:17:content';
  const resultId = 'fixture.ts:5:20:5:40:result';
  const callId = 'fixture.ts:5:30:5:40:call';
  const result = node(resultId, ['Method', 'Value', 'Collection', 'CallbackResult', 'ContainerMethod', 'Virtual'], {
    displayX: 1,
    displayY: 1,
    callMosaicOwnerStableId: resultId,
    callMosaicRole: 'open',
    renderPartsLayout: 'container-overlay-side',
    renderPartsJson: JSON.stringify([
      { kind: 'collection-container', text: 'result', fillState: 'empty' },
      { kind: 'method', text: 'push(', labels: ['Method', 'ContainerMethod', 'Virtual'] },
    ]),
  });
  const call = node(callId, ['Request', 'Value', 'Operand', 'Start'], {
    displayX: 2,
    displayY: 1,
    callMosaicOwnerStableId: resultId,
    callMosaicRole: 'argument',
  });
  const xml = makeDrawio([
    node(contentId, ['Value', 'ValueSlot', 'Iteration'], { displayX: 0, displayY: 0 }),
    result,
    call,
  ], [{
    start: contentId,
    end: callId,
    type: 'NEXT',
    props: { flowLayer: 'control' },
  }], { semanticNodes, suppressFoldingContainers: true });
  const next = xml.match(/<mxCell[^>]+edgeType="NEXT"[^>]*>/u)?.[0] || '';

  assert.match(next, /source="n1"/u);
  assert.match(next, /target="n2-part-1"/u);
  assert.match(next, new RegExp(`targetStableId="${callId}"`, 'u'));
  assert.match(next, new RegExp(`layoutEffectiveTargetStableId="${resultId}"`, 'u'));
});

test('ordinary predicate nodes request fixed-size draw.io hexagons', () => {
  const predicate = node('fixture.ts:1:1:1:5', ['Branch', 'Operand']);
  const xml = makeDrawio([predicate], [], { semanticNodes });
  assert.match(xml, /shape=hexagon;perimeter=hexagonPerimeter2;fixedSize=1;size=16;/u);
});

test('object-field DataBranch values remain hexagons with a generic extractor operation code', () => {
  const predicate = node('fixture.ts:2:10:2:60', ['Branch', 'Field', 'Data', 'ValueAccess', 'ValueRead'], {
    operationCode: 'conditional-value',
    conditionRaw: 'speculationAccept',
    diaName: 'speculationAccept ?',
  });
  const xml = makeDrawio([predicate], [], { semanticNodes });
  assert.match(xml, /shape=hexagon;perimeter=hexagonPerimeter2;fixedSize=1;size=16;/u);
});

test('significant value-expression mosaics stay rectangular instead of becoming predicates', () => {
  const expression = node('fixture.ts:1:1:1:30', [
    'Operand',
    'BinaryExpression',
    'BinaryResult',
    'SignificantExpression',
  ], {
    displayX: 0,
    displayY: 0,
    operationCode: 'value-expression',
    renderPartsLayout: 'horizontal',
    renderPartsJson: JSON.stringify([
      { stableId: 'receiver', text: '[r.id]', kind: 'value', labels: ['Value'], order: 0 },
      { stableId: 'operator', text: '??', kind: 'operator', labels: ['Op'], order: 1 },
      { stableId: 'fallback', text: '0', kind: 'literal', labels: ['Literal'], order: 2 },
    ]),
  });
  const xml = makeDrawio([expression], [], { semanticNodes });
  assert.doesNotMatch(xml, /id="n1-part-[^"]+"[^>]+shape=hexagon/u);
  assert.match(xml, /id="n1"[\s\S]*?<mxGeometry[^>]+height="30"/u);
});

test('a compact one-field object is one 30px horizontal mosaic', () => {
  const compactObject = node('fixture.ts:2:1:2:24:object', ['Object', 'Field', 'CompactObject'], {
    displayX: 0,
    displayY: 0,
    diaName: '{ uuid: user.uuid }',
    renderPartsLayout: 'horizontal',
    renderPartsJson: JSON.stringify([
      { stableId: 'object', text: '{', kind: 'punctuation', labels: ['Object', 'Open'], order: 0 },
      { stableId: 'object', text: 'uuid:', kind: 'punctuation', labels: ['Object', 'FieldName'], order: 1 },
      { stableId: 'object', text: 'user.uuid', kind: 'value', labels: ['Field', 'ValueAccess'], order: 2 },
      { stableId: 'object', text: '}', kind: 'punctuation', labels: ['Object', 'Close'], order: 3 },
    ]),
  });

  const xml = makeDrawio([compactObject], [], { semanticNodes });
  assert.match(xml, /id="n1"[\s\S]*?<mxGeometry[^>]+height="30"/u);
  assert.equal([...xml.matchAll(/id="n1-part-/gu)].length, 4);
});

test('literal nodes and literal mosaic tiles use a white fill with a gray stroke', () => {
  const standalone = node('fixture.ts:1:1:1:7', ['Value', 'Literal'], {
    displayX: 0,
    displayY: 0,
    diaName: "'text'",
  });
  const mosaic = node('fixture.ts:2:1:2:20', ['Action'], {
    displayX: 1,
    displayY: 0,
    renderPartsLayout: 'horizontal',
    renderPartsJson: JSON.stringify([
      { stableId: 'value', text: 'kind', kind: 'value', labels: ['Value'], order: 0 },
      { stableId: 'literal', text: "'image'", kind: 'literal', labels: ['Literal'], order: 1 },
    ]),
  });

  const xml = makeDrawio([standalone, mosaic], [], { semanticNodes });
  assert.match(xml, /id="n1"[^>]+fillColor=#ffffff;strokeColor=#808080;/u);
  assert.match(xml, /id="n1"[\s\S]*?<mxGeometry[^>]+width="42" height="30"/u);
  assert.match(xml, /id="n2-part-2"[^>]+%23ffffff[^>]+%23808080/u);
});

test('predicate mosaic edge tiles reserve fixed room for their hexagonal tips', () => {
  const predicate = node('fixture.ts:2:1:2:12:predicate', ['Branch', 'Data', 'Operand'], {
    displayX: 0,
    displayY: 0,
    renderPartsLayout: 'horizontal',
    renderPartsJson: JSON.stringify([
      { stableId: 'left', text: 'x', kind: 'value', labels: ['Value'], order: 0 },
      { stableId: 'operator', text: '===', kind: 'operator', labels: ['Op'], order: 1 },
      { stableId: 'right', text: "'y'", kind: 'literal', labels: ['Literal'], order: 2 },
    ]),
  });

  const xml = makeDrawio([predicate], [], { semanticNodes });
  assert.match(xml, /id="n1-part-1"[\s\S]*?<mxGeometry x="0" y="0" width="34" height="30"/u);
  assert.match(xml, /id="n1-part-2"[^>]+%23ffffff[^>]+%239673A6[^>]+fontStyle=1/u);
  assert.match(xml, /id="n1-part-2"[\s\S]*?<mxGeometry x="34" y="5" width="26" height="20"/u);
  assert.match(xml, /id="n1-part-3"[\s\S]*?<mxGeometry x="60" y="0" width="40" height="30"/u);
});

test('a variable negation is a separate white system-outlined predicate tile', () => {
  const predicate = node('fixture.ts:2:1:2:24:negated', ['Flow', 'Branch', 'ValueAccess'], {
    displayX: 0,
    displayY: 0,
    logicalNotPrefix: true,
    renderPartsLayout: 'horizontal',
    renderPartsJson: JSON.stringify([
      { stableId: 'not', text: '!', kind: 'operator', labels: ['Operator', 'System', 'LogicalNot'], order: 0 },
      { stableId: 'base', text: 'options?', kind: 'value', labels: ['Value', 'ValueAccess'], order: 1 },
      { stableId: 'field', text: '.fromKeybinding', kind: 'value', labels: ['Value', 'FieldAccess'], order: 2 },
    ]),
  });

  const xml = makeDrawio([predicate], [], { semanticNodes });
  assert.match(xml, /id="n1-part-1"[^>]+%23ffffff[^>]+%239673A6[^>]+align=right[^>]+spacingRight=2[^>]+fontStyle=1/u);
  assert.match(xml, /id="n1-part-1"[\s\S]*?<mxGeometry x="0" y="0" width="34" height="30"/u);
  assert.match(xml, /id="n1-part-2"[^>]+value="options\?"/u);
  assert.match(xml, /id="n1-part-3"[^>]+value="\.fromKeybinding"/u);
});

test('arithmetic mosaic operators use the compact white system-outlined tile', () => {
  const arithmetic = node('fixture.ts:3:1:3:16:arithmetic', ['Op', 'Operand'], {
    displayX: 0,
    displayY: 0,
    renderPartsLayout: 'horizontal',
    renderPartsJson: JSON.stringify([
      { stableId: 'left', text: 'total', kind: 'value', labels: ['Value'], order: 0 },
      { stableId: 'operator', text: '+', kind: 'operator', labels: ['Op'], order: 1 },
      { stableId: 'right', text: 'value', kind: 'value', labels: ['Value'], order: 2 },
    ]),
  });

  const xml = makeDrawio([arithmetic], [], { semanticNodes });
  assert.match(xml, /id="n1-part-2"[^>]+%23ffffff[^>]+%239673A6[^>]+fontStyle=1/u);
  assert.match(xml, /id="n1-part-2"[\s\S]*?<mxGeometry x="36" y="5" width="18" height="20"/u);
});

test('assignment operators are bold, false is red, and boolean results form one virtual set mosaic', () => {
  const directFalse = node('fixture.ts:4:1:4:30:false-assignment', ['Action', 'ValueWrite'], {
    displayX: 0,
    displayY: 0,
    renderPartsLayout: 'horizontal',
    renderPartsJson: JSON.stringify([
      { text: 'idleHintShownRef', kind: 'value', labels: ['Value'] },
      { text: '.current', kind: 'value', labels: ['Value', 'FieldAccess'] },
      { text: '=', kind: 'operator', labels: ['Op', 'Operand'] },
      { text: 'false', kind: 'literal', labels: ['Value', 'Literal'] },
    ]),
  });
  const booleanResult = node('fixture.ts:5:1:5:30:boolean-result', [
    'Method', 'Value', 'BooleanFlag', 'ContainerMethod', 'Set',
  ], {
    displayX: 0,
    displayY: 1,
    renderPartsLayout: 'container-overlay-side',
    renderPartsJson: JSON.stringify([
      { text: 'shouldTreatAsImmediate', kind: 'value-container', labels: ['Value'], fillState: 'empty' },
      { text: 'set(', kind: 'method', labels: ['Op', 'Method', 'CallBoundary', 'Virtual'] },
      {
        text: '<font color="#CC0000">falsy</font><font color="#000000">/</font><font color="#006600">truthy</font>',
        plainText: 'falsy/truthy',
        kind: 'virtual-value',
        labels: ['Value', 'BooleanFlag', 'ValueOutcome', 'Virtual'],
        fillState: 'filled',
      },
      { text: ')', kind: 'punctuation', labels: ['Op', 'CallBoundary', 'Virtual'], fillState: 'filled' },
    ]),
  });

  const xml = makeDrawio([directFalse, booleanResult], [], { semanticNodes });
  const operatorCell = xml.match(/<mxCell[^>]+id="n1-part-3"[^>]*>/u)?.[0] || '';
  const falseCell = xml.match(/<mxCell[^>]+id="n1-part-4"[^>]*>/u)?.[0] || '';
  assert.match(operatorCell, /fontColor=#000000;/u);
  assert.match(operatorCell, /fontStyle=1;/u);
  assert.match(falseCell, /fontColor=#CC0000;/u);
  assert.match(xml, /id="n2-part-2" value="set\("/u);
  assert.match(xml, /id="n2-part-3"[^>]+%23FFE6CC/u);
  assert.match(xml, /id="n2-part-3" value="&lt;font color=&quot;#CC0000&quot;&gt;falsy/u);
  assert.match(xml, /id="n2-part-4" value="\)"/u);
});

test('variable boxes use one compact label and mosaic-anchor formula for short and long names', () => {
  const variable = (id, name, displayY, overlays) => node(id, ['Value', 'ValueSlot'], {
    displayX: 0,
    displayY,
    renderPartsLayout: 'container-overlay-side',
    renderPartsJson: JSON.stringify([
      { text: name, kind: 'value-container', labels: ['Value', 'ValueSlot'], fillState: 'empty' },
      ...overlays,
    ]),
  });
  const short = variable('fixture.ts:1:1:1:6:short', 'input', 0, [
    { text: 'TYPED_AS(', kind: 'method', labels: ['Method', 'Virtual'] },
    { text: 'string', kind: 'value', labels: ['Type'] },
    { text: ')', kind: 'punctuation', labels: ['Method', 'Virtual'] },
  ]);
  const long = variable('fixture.ts:2:1:2:24:long', 'shouldTreatAsImmediate', 1, [
    { text: 'set(', kind: 'method', labels: ['Method', 'Virtual'] },
    { text: 'falsy/truthy', kind: 'value', labels: ['Value'] },
    { text: ')', kind: 'punctuation', labels: ['Method', 'Virtual'] },
  ]);
  const camelCase = variable('fixture.ts:3:1:3:16:camel', 'matchingCommand', 2, [
    { text: 'set(', kind: 'method', labels: ['Method', 'Virtual'] },
    { text: 'cmd', kind: 'value', labels: ['Value'] },
    { text: ')', kind: 'punctuation', labels: ['Method', 'Virtual'] },
  ]);

  const xml = makeDrawio([short, long, camelCase], [], { semanticNodes });
  const shortContainer = xml.match(/<mxCell id="n1-part-1"[^>]+>[\s\S]*?<mxGeometry[^>]+>/u)?.[0] || '';
  const shortOverlay = xml.match(/<mxCell id="n1-part-2"[^>]+>[\s\S]*?<mxGeometry[^>]+>/u)?.[0] || '';
  const longContainer = xml.match(/<mxCell id="n2-part-1"[^>]+>[\s\S]*?<mxGeometry[^>]+>/u)?.[0] || '';
  const longOverlay = xml.match(/<mxCell id="n2-part-2"[^>]+>[\s\S]*?<mxGeometry[^>]+>/u)?.[0] || '';
  const camelContainer = xml.match(/<mxCell id="n3-part-1"[^>]+>[\s\S]*?<mxGeometry[^>]+>/u)?.[0] || '';
  assert.match(shortContainer, /align=left;verticalAlign=bottom;spacingLeft=6;spacingBottom=8;/u);
  assert.match(shortContainer, /width="55" height="40"/u);
  assert.match(shortOverlay, /x="37" y="30"/u);
  assert.match(longContainer, /align=left;verticalAlign=bottom;spacingLeft=6;spacingBottom=10;/u);
  assert.match(longContainer, /width="165" height="50"/u);
  assert.match(longOverlay, /x="92" y="40"/u);
  assert.match(camelContainer, /width="122" height="46"/u);
});

test('closed variable boxes preserve the taller perspective from the legend', () => {
  const closed = node('fixture.ts:1:1:1:16:closed', ['Value', 'ValueSlot'], {
    displayX: 0,
    displayY: 0,
    renderPartsLayout: 'container-overlay-side',
    renderPartsJson: JSON.stringify([
      { text: 'matchingCommand', kind: 'value-container', labels: ['Value', 'ValueSlot'], fillState: 'filled' },
      { text: 'set(', kind: 'method', labels: ['Method', 'Virtual'] },
      { text: 'cmd', kind: 'value', labels: ['Value'] },
      { text: ')', kind: 'punctuation', labels: ['Method', 'Virtual'] },
    ]),
  });

  const xml = makeDrawio([closed], [], { semanticNodes });
  const container = xml.match(/<mxCell id="n1-part-1"[^>]+>[\s\S]*?<mxGeometry[^>]+>/u)?.[0] || '';
  const overlay = xml.match(/<mxCell id="n1-part-2"[^>]+>[\s\S]*?<mxGeometry[^>]+>/u)?.[0] || '';
  assert.match(container, /width="122" height="88"/u);
  assert.match(container, /spacingBottom=18;/u);
  assert.match(overlay, /y="78"/u);
});

test('predicate mosaics over collection backings reserve both hex tip widths', () => {
  const predicate = node('fixture.ts:4:1:4:36:predicate-call', ['Branch', 'Collection', 'PredicateCall'], {
    displayX: 0,
    displayY: 0,
    renderPartsLayout: 'container-overlay-side',
    renderPartsJson: JSON.stringify([
      { stableId: 'collection', text: 'cmd.aliases', kind: 'collection-container', labels: ['Collection'], order: 0 },
      { stableId: 'open', text: 'includes(', kind: 'method', labels: ['Method', 'System'], order: 1 },
      { stableId: 'argument', text: 'commandName', kind: 'value', labels: ['Value'], order: 2 },
      { stableId: 'close', text: ')', kind: 'punctuation', labels: ['CallBoundary'], order: 3 },
    ]),
  });

  const xml = makeDrawio([predicate], [], { semanticNodes });
  assert.match(xml, /id="n1-part-2"[\s\S]*?<mxGeometry x="61" y="57" width="76" height="30"/u);
  assert.match(xml, /id="n1-part-3"[\s\S]*?<mxGeometry x="137" y="57" width="87" height="30"/u);
  assert.match(xml, /id="n1-part-4"[\s\S]*?<mxGeometry x="224" y="57" width="34" height="30"/u);
});

test('field tiles keep full height in mosaics over diagonal collection backings', () => {
  const predicate = node('fixture.ts:4:1:4:44:collection-field-predicate', ['Branch', 'Collection'], {
    displayX: 0,
    displayY: 0,
    renderPartsLayout: 'container-overlay-side',
    renderPartsJson: JSON.stringify([
      { text: 'pastedContents', kind: 'collection-container', labels: ['Collection'] },
      { text: '[', kind: 'punctuation', labels: ['Op'] },
      { text: 'r', kind: 'value', labels: ['Value', 'Variable'] },
      { text: '.id', kind: 'value', labels: ['Value', 'FieldAccess'] },
      { text: ']', kind: 'punctuation', labels: ['Op'] },
    ]),
  });

  const xml = makeDrawio([predicate], [], { semanticNodes });
  const regular = xml.match(/id="n1-part-3"[\s\S]*?<mxGeometry x="[^"]+" y="([\d.]+)" width="[^"]+" height="([\d.]+)"/u);
  const compact = xml.match(/id="n1-part-4"[\s\S]*?<mxGeometry x="[^"]+" y="([\d.]+)" width="[^"]+" height="([\d.]+)"/u);
  assert.ok(regular && compact);
  assert.equal(Number(compact[2]), Number(regular[2]));
  assert.ok(Math.abs(
    Number(compact[1]) + Number(compact[2]) / 2
      - (Number(regular[1]) + Number(regular[2]) / 2),
  ) <= 0.5);
});

test('dot-access field tiles keep full height and preserve the predicate hex edge when terminal', () => {
  const comparison = node('fixture.ts:4:40:4:70:field-comparison', ['Branch', 'Operand'], {
    displayX: 0,
    displayY: 0,
    renderPartsLayout: 'horizontal',
    renderPartsJson: JSON.stringify([
      { text: 'cmd', kind: 'value', labels: ['Value', 'ValueAccess'] },
      { text: 'name', kind: 'value', labels: ['Value', 'ValueAccess', 'FieldAccess'] },
      { text: '===', kind: 'operator', labels: ['Op', 'Operand'] },
      { text: 'commandName', kind: 'value', labels: ['Value', 'ValueAccess'] },
    ]),
  });
  const terminalAccess = node('fixture.ts:4:72:4:96:terminal-field', ['Branch', 'Operand'], {
    displayX: 0,
    displayY: 1,
    renderPartsLayout: 'horizontal',
    renderPartsJson: JSON.stringify([
      { text: 'idleHintShownRef', kind: 'value', labels: ['Value', 'ValueAccess'] },
      { text: 'current', kind: 'value', labels: ['Value', 'ValueAccess', 'FieldAccess'] },
    ]),
  });

  const xml = makeDrawio([comparison, terminalAccess], [], { semanticNodes });
  assert.match(xml, /<mxCell(?=[^>]+id="n1-part-1")(?=[^>]+align=right;)(?=[^>]+spacingRight=3)(?=[^>]+overflow=hidden)[^>]+>/u);
  assert.match(xml, /<mxCell(?=[^>]+id="n1-part-2")(?=[^>]+align=left;)(?=[^>]+spacingLeft=3)(?=[^>]+overflow=hidden)[^>]+>/u);
  assert.match(xml, /id="n1-part-1"[\s\S]*?<mxGeometry x="0" y="0" width="[^"]+" height="30"/u);
  assert.match(xml, /id="n1-part-2"[\s\S]*?<mxGeometry x="[^"]+" y="0" width="[^"]+" height="30"/u);
  const terminalFieldStyle = xml.match(/id="n2-part-2"[^>]+style="([^"]+)"/u)?.[1] || '';
  assert.match(decodeURIComponent(terminalFieldStyle), /L [\d.]+ 25 L/u);
  assert.match(xml, /id="n2-part-2"[\s\S]*?<mxGeometry x="[^"]+" y="0" width="[^"]+" height="30"/u);
});

test('DataJoin is one variable-colored join concept rendered as x', () => {
  const join = node('fixture.ts:3:1:3:20:data-join', ['DataJoin'], {
    displayX: 0,
    displayY: 0,
    diaName: 'DataJoin',
  });
  const xml = makeDrawio([join], [], { semanticNodes });
  assert.match(xml, /value="x"/u);
  assert.match(xml, /id="n1"[^>]+rhombus[^>]+fillColor=#FFE6CC;strokeColor=#BE7000/u);
});

test('horizontal DataJoin shares the vertical center of its owning Branch', () => {
  const branchId = 'fixture.ts:3:1:3:20:branch';
  const trueId = 'fixture.ts:3:21:3:30:true';
  const falseId = 'fixture.ts:3:31:3:40:false';
  const joinId = 'fixture.ts:3:41:3:50:data-join';
  const nodes = [
    node(branchId, ['Branch', 'Field'], { displayX: 0, displayY: 2, diaName: 'value ?? fallback' }),
    node(trueId, ['Action', 'Alternative'], { displayX: 1, displayY: 1, diaName: 'value' }),
    node(falseId, ['Action', 'Alternative'], { displayX: 1, displayY: 3, diaName: 'fallback' }),
    node(joinId, ['DataJoin'], { displayX: 2, displayY: 8, diaName: 'DataJoin' }),
  ];
  const edges = [
    { start: branchId, end: trueId, type: 'TRUE', props: {} },
    { start: branchId, end: falseId, type: 'FALSE', props: {} },
    { start: trueId, end: joinId, type: 'XOR_JOIN', props: {} },
    { start: falseId, end: joinId, type: 'XOR_JOIN', props: {} },
  ];
  const xml = makeDrawio(nodes, edges, { semanticNodes, suppressFoldingContainers: true });
  const geometry = (stableId) => {
    const match = xml.match(new RegExp(`stableId="${stableId}"[\\s\\S]*?<mxGeometry x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`, 'u'));
    assert.ok(match, `missing geometry for ${stableId}`);
    return { y: Number(match[2]), height: Number(match[4]) };
  };
  const branch = geometry(branchId);
  const join = geometry(joinId);
  assert.equal(join.y + join.height / 2, branch.y + branch.height / 2);
});

test('an exclusive argument join shares the vertical center of its owning Branch', () => {
  const branchId = 'fixture.ts:3:1:3:20:nullish-argument';
  const joinId = 'fixture.ts:3:21:3:30:argument-join';
  const nodes = [
    node(branchId, ['Branch', 'Arg', 'Data'], { displayX: 0, displayY: 2, diaName: '??' }),
    node(joinId, ['Arg', 'Join', 'Exclusive'], { displayX: 2, displayY: 8, diaName: 'x' }),
  ];
  const edges = [
    { start: branchId, end: joinId, type: 'TRUE', props: {} },
    { start: branchId, end: joinId, type: 'FALSE', props: {} },
  ];
  const xml = makeDrawio(nodes, edges, { semanticNodes, suppressFoldingContainers: true });
  const geometry = (stableId) => {
    const match = xml.match(new RegExp(`stableId="${stableId}"[\\s\\S]*?<mxGeometry x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`, 'u'));
    assert.ok(match, `missing geometry for ${stableId}`);
    return { x: Number(match[1]), y: Number(match[2]), width: Number(match[3]), height: Number(match[4]) };
  };
  const branch = geometry(branchId);
  const join = geometry(joinId);
  assert.equal(join.y + join.height / 2, branch.y + branch.height / 2);
  assert(join.x > branch.x + branch.width);
});

test('a projected substep header keeps its extracted row below the producer anchor', () => {
  const producerId = 'fixture.ts:3:1:3:10:producer';
  const headerId = 'fixture.ts:3:11:3:20:filter';
  const nodes = [
    node(producerId, ['Request', 'Start'], {
      displayX: 0,
      displayY: 0,
      diaName: 'produce(',
    }),
    node(headerId, ['Method', 'SubStep', 'HybridSubStepHeader'], {
      displayX: 0,
      displayY: 0.62,
      diaName: 'filter',
      submethodAnchorStableId: producerId,
      submethodRelativeRow: 0,
    }),
  ];
  const xml = makeDrawio(nodes, [], { semanticNodes, suppressFoldingContainers: true });
  const centerY = (stableId) => {
    const match = xml.match(new RegExp(`stableId="${stableId}"[\\s\\S]*?<mxGeometry x="[^"]+" y="([^"]+)" width="[^"]+" height="([^"]+)"`, 'u'));
    assert.ok(match, `missing geometry for ${stableId}`);
    return Number(match[1]) + Number(match[2]) / 2;
  };
  assert(centerY(headerId) > centerY(producerId));
});

test('for is rendered as a purple system keyword with curved method sides', () => {
  const loop = node('fixture.ts:4:1:6:2', ['Loop'], {
    displayX: 0,
    displayY: 0,
    diaName: 'for',
  });
  const xml = makeDrawio([loop], [], { semanticNodes });
  assert.match(xml, /id="n1"[^>]+shape=image;[^>]+%23E1D5E7[^>]+%239673A6/u);
  assert.match(xml, /id="n1"[^>]+M%2010%201%20H%2062%20C/u);
});

test('locked horizontal field alternatives keep bottom-to-side ports even when the target is below', () => {
  const branchId = 'fixture.ts:5:1:5:20';
  const alternativeId = 'fixture.ts:5:22:5:30';
  const nodes = [
    node(branchId, ['Branch', 'Field'], { displayX: 0, displayY: 0, diaName: '??' }),
    node(alternativeId, ['Action', 'Field', 'Alternative'], { displayX: 1, displayY: 1, diaName: "'fallback'" }),
  ];
  const edges = [{
    start: branchId,
    end: alternativeId,
    type: 'FALSE',
    props: {
      sourcePort: 'bottom',
      targetPort: 'left',
      sourcePortCandidates: ['bottom'],
      targetPortCandidates: ['left'],
      lockPortCandidates: true,
    },
  }];
  const xml = makeDrawio(nodes, edges, { semanticNodes });
  assert.match(xml, /id="e1"[^>]+exitX=0\.5;exitY=1;[^>]+entryX=0;entryY=0\.5;/u);
});

test('horizontal argument frames enter every following element through its left side', () => {
  const openingId = 'fixture.ts:6:1:6:20:open';
  const inputId = 'fixture.ts:6:21:6:26:input';
  const pastedId = 'fixture.ts:6:28:6:42:pasted';
  const closureId = 'fixture.ts:6:43:6:44:close';
  const nodes = [
    node(openingId, ['Call', 'Method'], { displayX: 0, displayY: 0, diaName: 'expand(' }),
    node(inputId, ['Arg', 'Value'], { displayX: 1, displayY: -1, diaName: 'input' }),
    node(pastedId, ['Arg', 'Value'], { displayX: 1, displayY: 1, diaName: 'pastedContents' }),
    node(closureId, ['Fn', 'VisualProxy'], {
      displayX: 2,
      displayY: 0,
      diaName: ')',
      splitCallBoundary: 'end',
    }),
  ];
  const edges = [
    { start: openingId, end: inputId, type: 'ARG', props: { layoutFrame: 'horizontal' } },
    { start: openingId, end: pastedId, type: 'ARG', props: { layoutFrame: 'horizontal' } },
    { start: inputId, end: closureId, type: 'ArgJoin', props: { layoutFrame: 'horizontal' } },
    { start: pastedId, end: closureId, type: 'ArgJoin', props: { layoutFrame: 'horizontal' } },
  ];
  const xml = makeDrawio(nodes, edges, { semanticNodes });
  for (const edgeId of ['e1', 'e2', 'e3', 'e4']) {
    assert.match(xml, new RegExp(`id="${edgeId}"[^>]+entryX=0;entryY=0\\.5;`, 'u'));
  }
  for (const edgeId of ['e1', 'e2']) {
    assert.match(xml, new RegExp(`id="${edgeId}"[^>]+exitX=1;exitY=0\\.5;`, 'u'));
    assert.match(
      xml,
      new RegExp(`id="${edgeId}"[\\s\\S]*?<Array as="points">`, 'u'),
      'the renderer must preserve its resolved argument-family route instead of delegating it back to draw.io',
    );
  }
});

test('an even horizontal argument family straddles the final call axis', () => {
  const openingId = 'fixture.ts:6:1:6:20:open-even';
  const firstId = 'fixture.ts:6:21:6:22:arg0';
  const secondId = 'fixture.ts:6:24:6:34:arg1';
  const nodes = [
    node(openingId, ['Op', 'Call', 'Method'], {
      displayX: 0,
      displayY: 0,
      diaName: 'slice(',
      renderPartsLayout: 'diagonal',
      renderPrimaryPartIndex: 1,
      renderPartsJson: JSON.stringify([
        { text: 'trimmedInput', kind: 'value', labels: ['Value'] },
        { text: 'slice(', kind: 'method', labels: ['Op', 'Method', 'System'] },
      ]),
    }),
    node(firstId, ['Arg', 'Literal'], {
      displayX: 1, displayY: -2, diaName: '1', argumentIndex: 0, layoutFamilyOwnerKeys: [openingId],
    }),
    node(secondId, ['Arg', 'Value'], {
      displayX: 1, displayY: 0, diaName: 'spaceIndex', argumentIndex: 1, layoutFamilyOwnerKeys: [openingId],
    }),
  ];
  const edges = [
    { start: openingId, end: firstId, type: 'ARG', props: { layoutFrame: 'horizontal', argumentIndex: 0 } },
    { start: openingId, end: secondId, type: 'ARG', props: { layoutFrame: 'horizontal', argumentIndex: 1 } },
  ];
  const nodeBoxes = new Map([
    [openingId, { x: 0, y: 100, width: 140, height: 30 }],
    [firstId, { x: 220, y: 0, width: 30, height: 30 }],
    [secondId, { x: 220, y: 100, width: 86, height: 30 }],
  ]);
  alignHorizontalArgumentFamilies(nodes, edges, nodeBoxes);
  const opening = nodeBoxes.get(openingId);
  const first = nodeBoxes.get(firstId);
  const second = nodeBoxes.get(secondId);
  const familyMiddle = (first.y + first.height + second.y) / 2;

  assert.equal(familyMiddle, opening.y + opening.height / 2);
  assert.ok(first.y + first.height < second.y);
});

test('horizontal argument siblings are centered inside the widest nested argument family', () => {
  const openingId = 'fixture.ts:6:1:10:2:call';
  const literalId = 'fixture.ts:6:10:6:36:arg0';
  const familyId = 'fixture.ts:6:38:10:2:arg1-object';
  const closingId = 'fixture.ts:6:1:10:2:call-close';
  const leftId = `${familyId}:brace:left:0`;
  const rightId = `${familyId}:brace:right:0`;
  const upperId = `${familyId}:field:0`;
  const lowerId = `${familyId}:field:1`;
  const nodes = [
    node(openingId, ['Call', 'Start'], { displayX: 0, displayY: 1, diaName: 'logEvent(' }),
    node(literalId, ['Arg', 'Literal'], { displayX: 3, displayY: 0, diaName: "'event-name'" }),
    node(leftId, ['Object', 'ObjectBrace', 'Open', 'Arg'], {
      displayX: 1,
      displayY: 1,
      objectFamilyStableId: familyId,
      objectBraceSide: 'left',
      objectBracePairIndex: 0,
      objectBraceFieldIndicesJson: JSON.stringify([0, 1]),
    }),
    node(rightId, ['Object', 'ObjectBrace', 'Close', 'Arg'], {
      displayX: 4,
      displayY: 1,
      objectFamilyStableId: familyId,
      objectBraceSide: 'right',
      objectBracePairIndex: 0,
      objectBraceFieldIndicesJson: JSON.stringify([0, 1]),
    }),
    node(upperId, ['Field'], { displayX: 2, displayY: 0.5, fieldIndex: 0, diaName: 'upperField' }),
    node(lowerId, ['Field'], { displayX: 2, displayY: 1.5, fieldIndex: 1, diaName: 'lowerFieldWithLongText' }),
    node(closingId, ['Call', 'Finish'], { displayX: 5, displayY: 1, diaName: ')' }),
  ];
  const edges = [
    { start: openingId, end: literalId, type: 'ARG', props: { layoutFrame: 'horizontal' } },
    {
      start: openingId,
      end: leftId,
      type: 'ARG',
      props: { layoutFrame: 'horizontal', display_label: 'metadata' },
    },
    { start: leftId, end: upperId, type: 'FIELD', props: { fieldIndex: 0 } },
    { start: leftId, end: lowerId, type: 'FIELD', props: { fieldIndex: 1 } },
    { start: upperId, end: rightId, type: 'FieldJoin', props: { fieldIndex: 0 } },
    { start: lowerId, end: rightId, type: 'FieldJoin', props: { fieldIndex: 1 } },
    { start: literalId, end: closingId, type: 'ArgJoin', props: { layoutFrame: 'horizontal' } },
    { start: rightId, end: closingId, type: 'ArgJoin', props: { layoutFrame: 'horizontal' } },
  ];
  const xml = makeDrawio(nodes, edges, { semanticNodes });
  const geometry = (stableId) => {
    const match = xml.match(new RegExp(`<mxCell[^>]+stableId="${stableId}"[^>]*>[\\s\\S]*?<mxGeometry x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`, 'u'));
    assert.ok(match, `missing geometry for ${stableId}`);
    return { x: Number(match[1]), width: Number(match[3]) };
  };
  const literal = geometry(literalId);
  const opening = geometry(openingId);
  const left = geometry(leftId);
  const right = geometry(rightId);
  const closing = geometry(closingId);
  assert.equal(
    literal.x + literal.width / 2,
    (left.x + right.x + right.width) / 2,
    'the narrow first argument must be centered over the complete nested object-family width',
  );
  assert.equal(
    closing.x,
    right.x + right.width + 36,
    'the shared call closure must follow the widest argument family without an extra abstract column',
  );
  assert.ok(
    left.x - (opening.x + opening.width) >= 'metadata'.length * 7 + 28,
    'an object argument name must contribute to the straight segment before its opening brace',
  );
});

test('an object argument keeps its assigned row in a multi-argument family', () => {
  const openingId = 'fixture.ts:12:1:16:2:call';
  const inputId = 'fixture.ts:12:10:12:15:arg0';
  const familyId = 'fixture.ts:12:17:16:2:arg1-object';
  const leftId = `${familyId}:brace:left:0`;
  const rightId = `${familyId}:brace:right:0`;
  const upperId = `${familyId}:field:0`;
  const lowerId = `${familyId}:field:1`;
  const nodes = [
    node(openingId, ['Call', 'Start'], { displayX: 0, displayY: 0, diaName: 'accept(' }),
    node(inputId, ['Arg', 'Value'], { displayX: 1, displayY: 0, diaName: 'input' }),
    node(leftId, ['Object', 'ObjectBrace', 'Open', 'Arg'], {
      displayX: 1,
      displayY: 1,
      objectFamilyStableId: familyId,
      objectBraceSide: 'left',
      objectBracePairIndex: 0,
      objectBraceFieldIndicesJson: JSON.stringify([0, 1]),
    }),
    node(rightId, ['Object', 'ObjectBrace', 'Close', 'Arg'], {
      displayX: 3,
      displayY: 1,
      objectFamilyStableId: familyId,
      objectBraceSide: 'right',
      objectBracePairIndex: 0,
      objectBraceFieldIndicesJson: JSON.stringify([0, 1]),
    }),
    node(upperId, ['Field'], { displayX: 2, displayY: 0.7, fieldIndex: 0, diaName: 'first' }),
    node(lowerId, ['Field'], { displayX: 2, displayY: 1.3, fieldIndex: 1, diaName: 'second' }),
  ];
  const edges = [
    { start: openingId, end: inputId, type: 'ARG', props: { layoutFrame: 'horizontal' } },
    { start: openingId, end: leftId, type: 'ARG', props: { layoutFrame: 'horizontal', display_label: 'deps' } },
    { start: leftId, end: upperId, type: 'FIELD', props: { fieldIndex: 0 } },
    { start: leftId, end: lowerId, type: 'FIELD', props: { fieldIndex: 1 } },
    { start: upperId, end: rightId, type: 'FieldJoin', props: { fieldIndex: 0 } },
    { start: lowerId, end: rightId, type: 'FieldJoin', props: { fieldIndex: 1 } },
  ];
  const xml = makeDrawio(nodes, edges, { semanticNodes });
  const geometry = (stableId) => {
    const match = xml.match(new RegExp(`<mxCell[^>]+stableId="${stableId}"[^>]*>[\\s\\S]*?<mxGeometry x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`, 'u'));
    assert.ok(match, `missing geometry for ${stableId}`);
    return { x: Number(match[1]), y: Number(match[2]), width: Number(match[3]), height: Number(match[4]) };
  };
  const input = geometry(inputId);
  const left = geometry(leftId);
  assert.ok(
    left.y >= input.y + input.height,
    'the nested object family must remain below the preceding argument instead of being recentered onto it',
  );
});

test('horizontal field siblings share their family opening port before splitting vertically', () => {
  const openingId = 'fixture.ts:6:1:9:2:object-open';
  const upperId = 'fixture.ts:7:3:7:10:field';
  const lowerId = 'fixture.ts:8:3:8:10:field';
  const nodes = [
    node(openingId, ['Object', 'ObjectBrace', 'Open'], { displayX: 0, displayY: 0, diaName: '{' }),
    node(upperId, ['Field', 'Value'], { displayX: 1, displayY: -1, diaName: 'upper' }),
    node(lowerId, ['Field', 'Value'], { displayX: 1, displayY: 1, diaName: 'lower' }),
  ];
  const edges = [
    { start: openingId, end: upperId, type: 'FIELD', props: { layoutFrame: 'horizontal' } },
    { start: openingId, end: lowerId, type: 'FIELD', props: { layoutFrame: 'horizontal' } },
  ];
  const xml = makeDrawio(nodes, edges, { semanticNodes });
  for (const edgeId of ['e1', 'e2']) {
    assert.match(xml, new RegExp(`id="${edgeId}"[^>]+exitX=1;exitY=0\\.5;`, 'u'));
    assert.match(
      xml,
      new RegExp(`id="${edgeId}"[\\s\\S]*?<Array as="points">`, 'u'),
      'the renderer must preserve its resolved field-family route instead of delegating it back to draw.io',
    );
  }
});

test('an object-field predicate reserves its upper outcome corridor before sibling placement', () => {
  const familyId = 'fixture.ts:7:1:10:2:object';
  const leftId = `${familyId}:brace:left:0`;
  const rightId = `${familyId}:brace:right:0`;
  const upperId = `${familyId}:field:0`;
  const predicateId = `${familyId}:field:1:predicate`;
  const joinId = `${familyId}:field:1:data-join`;
  const nodes = [
    node(leftId, ['Object', 'ObjectBrace', 'Open'], {
      displayX: 0,
      displayY: 0,
      objectFamilyStableId: familyId,
      objectBraceSide: 'left',
      objectBracePairIndex: 0,
      objectBraceFieldIndicesJson: JSON.stringify([0, 1]),
    }),
    node(rightId, ['Object', 'ObjectBrace', 'Close'], {
      displayX: 4,
      displayY: 0,
      objectFamilyStableId: familyId,
      objectBraceSide: 'right',
      objectBracePairIndex: 0,
      objectBraceFieldIndicesJson: JSON.stringify([0, 1]),
    }),
    node(upperId, ['Field', 'Value'], { displayX: 1, displayY: -1, fieldIndex: 0, diaName: 'upper' }),
    node(predicateId, ['Branch', 'Field', 'PredicateOperator'], {
      displayX: 1,
      displayY: 1,
      fieldIndex: 1,
      renderPartsLayout: 'horizontal',
      renderPartsJson: JSON.stringify([
        { stableId: 'receiver', text: 'options?', kind: 'value', labels: ['Value'] },
        { stableId: 'field', text: '.enabled', kind: 'field', labels: ['Field'] },
        { stableId: 'operator', text: '??', kind: 'operator', labels: ['Op'] },
        { stableId: 'fallback', text: 'false', kind: 'literal', labels: ['Literal'] },
      ]),
    }),
    node(joinId, ['DataJoin'], { displayX: 2, displayY: 1, fieldIndex: 1, diaName: 'DataJoin' }),
  ];
  const edges = [
    { start: leftId, end: upperId, type: 'FIELD', props: { fieldIndex: 0, displayLabel: '' } },
    { start: upperId, end: rightId, type: 'FieldJoin', props: { fieldIndex: 0 } },
    { start: leftId, end: predicateId, type: 'FIELD', props: { fieldIndex: 1, displayLabel: '' } },
    { start: predicateId, end: joinId, type: 'TRUE', props: { sourceRenderPartStableId: 'field' } },
    { start: predicateId, end: joinId, type: 'FALSE', props: { sourceRenderPartStableId: 'fallback' } },
    { start: joinId, end: rightId, type: 'FieldJoin', props: { fieldIndex: 1 } },
  ];
  const familySemanticNodes = [
    {
      key: stepId,
      labels: ['Step'],
      props: { headStableIds: [leftId], tailStableIds: [rightId] },
    },
    {
      key: blockId,
      labels: ['Block'],
      props: { headStableIds: [leftId], tailStableIds: [rightId] },
    },
  ];
  const xml = makeDrawio(nodes, edges, { semanticNodes: familySemanticNodes, suppressFoldingContainers: true });
  const geometry = (stableId) => {
    const match = xml.match(new RegExp(`stableId="${stableId}"[\\s\\S]*?<mxGeometry x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`, 'u'));
    assert.ok(match, `missing geometry for ${stableId}`);
    return {
      x: Number(match[1]),
      y: Number(match[2]),
      width: Number(match[3]),
      height: Number(match[4]),
    };
  };
  const upper = geometry(upperId);
  const predicate = geometry(predicateId);
  const join = geometry(joinId);
  assert.ok(
    predicate.y - 24 >= upper.y + upper.height + 12,
    'the TRUE route above the lower predicate must not enter the upper sibling footprint',
  );
  assert.equal(
    join.x,
    predicate.x + predicate.width + 36,
    'a direct DataJoin must retain its own slot when the containing object family is the Step head',
  );
});

test('local declarations use a function backing with a sketch declares overlay and void calls use a system tile', () => {
  const declaration = node('fixture.ts:2:1:2:24', ['FnDeclaration', 'Async'], {
    displayX: 0,
    displayY: 0,
    calleeStableId: 'fixture.ts:2:27:4:2',
    renderPartsLayout: 'container-overlay-side',
    renderPrimaryPartIndex: 1,
    renderPartsJson: JSON.stringify([
      { stableId: 'declaration:container', text: 'executeImmediateCommand', kind: 'function-container', labels: ['FnDeclaration'], order: 0 },
      { stableId: 'declaration', text: 'declares', kind: 'method', labels: ['Method', 'ContainerMethod', 'Virtual'], order: 1 },
    ]),
  });
  const invocation = node('fixture.ts:5:8:5:33', ['Call', 'Async', 'FireAndForget'], {
    displayX: 0,
    displayY: 1,
    renderPartsLayout: 'horizontal',
    renderPrimaryPartIndex: 1,
    renderPartsJson: JSON.stringify([
      { stableId: 'void', text: 'void', kind: 'method', labels: ['Keyword', 'System'], order: 0 },
      { stableId: 'call', text: 'executeImmediateCommand()', kind: 'method', labels: ['Call'], order: 1 },
    ]),
  });

  const decoded = decodeURIComponent(makeDrawio([declaration, invocation], [], { semanticNodes }));
  assert.match(decoded, /value="executeImmediateCommand"[^>]+shape=image/u);
  assert.match(decoded, /stableId="fixture\.ts:2:1:2:24"[^>]+functionStableId="fixture\.ts:2:27:4:2"/u);
  assert.match(decoded, /value="declares"[\s\S]+?#99CCFF[\s\S]+?<\/mxCell>/u);
  assert.match(decoded, /value="declares"[\s\S]+?clipPath[\s\S]+?<\/mxCell>/u);
  assert.match(decoded, /value="void"[\s\S]+?#E1D5E7[\s\S]+?<\/mxCell>/u);
  assert.match(decoded, /value="executeImmediateCommand\(\)"[\s\S]+?#DAE8FC[\s\S]+?<\/mxCell>/u);
});

test('nested object brace pairs share their side columns and span paired fields from outside in', () => {
  const familyId = 'fixture.ts:7:10:13:2:object';
  const leftOuter = `${familyId}:brace:left:0`;
  const rightOuter = `${familyId}:brace:right:0`;
  const leftInner = `${familyId}:brace:left:1`;
  const rightInner = `${familyId}:brace:right:1`;
  const openerId = `${familyId}:call-open`;
  const closerId = `${familyId}:call-close`;
  const tallFourthMemberId = `${familyId}:field:3:member`;
  const fields = Array.from({ length: 5 }, (_, index) => `${familyId}:field:${index}`);
  const braceNode = (id, side, pairIndex, fieldIndices) => node(id, ['Object', 'ObjectBrace', side === 'left' ? 'Open' : 'Close'], {
    displayX: side === 'left' ? 0 : 4,
    displayY: pairIndex,
    objectFamilyStableId: familyId,
    objectBraceSide: side,
    objectBracePairIndex: pairIndex,
    objectBracePairCount: 2,
    objectBraceFieldIndicesJson: JSON.stringify(fieldIndices),
    objectBraceMosaicNeighborStableId: pairIndex === 0
      ? (side === 'left' ? openerId : closerId)
      : undefined,
  });
  const nodes = [
    braceNode(leftOuter, 'left', 0, [0, 4]),
    braceNode(rightOuter, 'right', 0, [0, 4]),
    braceNode(leftInner, 'left', 1, [1, 2, 3]),
    braceNode(rightInner, 'right', 1, [1, 2, 3]),
    ...fields.map((id, index) => node(id, ['Field'], { displayX: 2, displayY: index, fieldIndex: index, diaName: `field${index}` })),
    node(tallFourthMemberId, ['Op'], { displayX: 3, displayY: 8, diaName: 'nestedProducer' }),
    node(openerId, ['Call'], { displayX: -2, displayY: 2, diaName: 'create(' }),
    node(closerId, ['FnVisualProxy'], { displayX: 6, displayY: 2, diaName: ')' }),
  ];
  const edges = [
    { start: leftOuter, end: fields[0], type: 'FIELD', props: { fieldIndex: 0 } },
    { start: leftOuter, end: fields[4], type: 'FIELD', props: { fieldIndex: 4 } },
    { start: leftInner, end: fields[1], type: 'FIELD', props: { fieldIndex: 1 } },
    {
      start: leftInner,
      end: fields[2],
      type: 'FIELD',
      props: { fieldIndex: 2, display_label: 'centralFieldWithLongLabel' },
    },
    { start: leftInner, end: fields[3], type: 'FIELD', props: { fieldIndex: 3 } },
    { start: fields[0], end: rightOuter, type: 'FieldJoin', props: { fieldIndex: 0 } },
    { start: fields[4], end: rightOuter, type: 'FieldJoin', props: { fieldIndex: 4 } },
    { start: fields[1], end: rightInner, type: 'FieldJoin', props: { fieldIndex: 1 } },
    { start: fields[2], end: rightInner, type: 'FieldJoin', props: { fieldIndex: 2 } },
    { start: fields[3], end: rightInner, type: 'FieldJoin', props: { fieldIndex: 3 } },
    { start: fields[3], end: tallFourthMemberId, type: 'NEXT', props: {} },
    { start: openerId, end: leftOuter, type: 'ARG', props: { layoutFrame: 'horizontal' } },
    { start: rightOuter, end: closerId, type: 'ArgJoin', props: { layoutFrame: 'horizontal' } },
  ];
  const xml = makeDrawio(nodes, edges, { semanticNodes });
  const geometry = (stableId) => {
    const match = xml.match(new RegExp(`<mxCell[^>]+stableId="${stableId}"[^>]*>[\\s\\S]*?<mxGeometry x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`, 'u'));
    assert.ok(match, `missing geometry for ${stableId}`);
    return { x: Number(match[1]), y: Number(match[2]), width: Number(match[3]), height: Number(match[4]) };
  };
  const outerLeft = geometry(leftOuter);
  const outerRight = geometry(rightOuter);
  const innerLeft = geometry(leftInner);
  const innerRight = geometry(rightInner);
  const opener = geometry(openerId);
  const closer = geometry(closerId);
  const fieldGeometries = fields.map(geometry);
  assert.equal(outerLeft.x, innerLeft.x);
  assert.equal(outerRight.x, innerRight.x);
  assert.ok(
    fieldGeometries[2].x - (innerLeft.x + innerLeft.width) >= 'centralFieldWithLongLabel'.length * 7 + 28,
    'a field label must fit between the brace turn and its sibling node',
  );
  const tallFourthMember = geometry(tallFourthMemberId);
  const siblingCenters = fieldGeometries.map((field, index) => {
    if (index !== 3) return field.x + field.width / 2;
    const left = Math.min(field.x, tallFourthMember.x);
    const right = Math.max(field.x + field.width, tallFourthMember.x + tallFourthMember.width);
    return (left + right) / 2;
  });
  assert.ok(
    siblingCenters.every((center) => Math.abs(center - siblingCenters[0]) <= 0.5),
    `field sibling footprints must share one horizontal center: ${siblingCenters.join(', ')}`,
  );
  assert.equal(
    outerRight.x,
    Math.max(
      ...fieldGeometries.map((field) => field.x + field.width),
      tallFourthMember.x + tallFourthMember.width,
    ) + 36,
    'the closing brace needs one normal trailing segment without repeating field-name clearance',
  );
  assert.deepEqual({ y: outerLeft.y, height: outerLeft.height }, { y: outerRight.y, height: outerRight.height });
  assert.deepEqual({ y: innerLeft.y, height: innerLeft.height }, { y: innerRight.y, height: innerRight.height });
  assert.ok(outerLeft.height > innerLeft.height);
  assert.equal(
    fieldGeometries[2].y + fieldGeometries[2].height / 2,
    opener.y + opener.height / 2,
    'an odd field family must anchor its central sibling on the family axis',
  );
  assert.equal(outerLeft.y, fieldGeometries[0].y + fieldGeometries[0].height / 2);
  assert.equal(
    outerLeft.y + outerLeft.height,
    fieldGeometries[4].y + fieldGeometries[4].height / 2,
    'brace ends must stop on their outer FieldLines instead of extending by half a field height',
  );
  assert.equal(outerLeft.x, opener.x + opener.width, 'opening brace must touch its mosaic neighbor');
  assert.equal(closer.x, outerRight.x + outerRight.width, 'closing brace must touch its mosaic neighbor');
  const edgeCells = [...xml.matchAll(/<mxCell\s+([^>]+)>/gu)].map((match) => (
    Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/gu)].map((attribute) => [attribute[1], attribute[2]]))
  )).filter((cell) => cell.edge === '1');
  const edgeStyleBetween = (source, target) => edgeCells.find((edge) => edge.source === source && edge.target === target)?.style || '';
  assert.ok(edgeCells.length, 'object brace fixture must render graph edges');
  assert.match(edgeStyleBetween('n1', 'n5'), /exitX=1;exitY=0;/u);
  assert.match(edgeStyleBetween('n1', 'n9'), /exitX=1;exitY=1;/u);
  assert.match(edgeStyleBetween('n3', 'n7'), /exitX=1;exitY=0\.5;/u);
  assert.match(edgeStyleBetween('n5', 'n2'), /entryX=0;entryY=0;/u);
  assert.match(edgeStyleBetween('n9', 'n2'), /entryX=0;entryY=1;/u);
  assert.match(edgeStyleBetween('n11', 'n1'), /entryX=0;entryY=0\.[0-9]+;/u);
  assert.match(edgeStyleBetween('n2', 'n12'), /exitX=1;exitY=0\.[0-9]+;/u);
  assert.doesNotMatch(edgeStyleBetween('n11', 'n1'), /entryY=0\.5;/u);
  assert.doesNotMatch(edgeStyleBetween('n2', 'n12'), /exitY=0\.5;/u);
  assert.match(xml, /id="e6"[\s\S]*?<Array as="points">/u, 'FieldJoin to a brace must keep the resolved direct route');
  const labelPosition = xml.match(
    /value="centralFieldWithLongLabel"[^>]*>[\s\S]*?<mxGeometry x="([^"]+)" relative="1"/u,
  );
  assert.ok(labelPosition, 'the sibling edge must carry an explicit label position');
  assert.ok(
    Math.abs(Number(labelPosition[1])) <= 0.95 && Number(labelPosition[1]) !== 0.8,
    'a sibling label must use a route-derived position instead of the overlapping fixed 0.8 position',
  );
});

test('an even object family derives its axis from the positioned central pair', () => {
  const familyId = 'fixture.ts:14:10:18:2:object';
  const openerId = `${familyId}:call-open`;
  const closerId = `${familyId}:call-close`;
  const leftId = `${familyId}:brace:left:0`;
  const rightId = `${familyId}:brace:right:0`;
  const upperId = `${familyId}:field:0`;
  const lowerId = `${familyId}:field:1`;
  const upperProducerId = `${familyId}:field:0:producer`;
  const braceProps = (side) => ({
    objectFamilyStableId: familyId,
    objectBraceSide: side,
    objectBracePairIndex: 0,
    objectBraceFieldIndicesJson: JSON.stringify([0, 1]),
    objectBraceMosaicNeighborStableId: side === 'left' ? openerId : closerId,
  });
  const nodes = [
    node(openerId, ['Call'], { diaName: 'consume(' }),
    node(closerId, ['FnVisualProxy'], { diaName: ')' }),
    node(leftId, ['Object', 'ObjectBrace', 'Open'], braceProps('left')),
    node(rightId, ['Object', 'ObjectBrace', 'Close'], braceProps('right')),
    node(upperId, ['Field'], { fieldIndex: 0, diaName: 'upper' }),
    node(lowerId, ['Field'], { fieldIndex: 1, diaName: 'lower' }),
    node(upperProducerId, ['Op'], { diaName: 'deep producer' }),
  ];
  const edges = [
    { start: openerId, end: leftId, type: 'ARG', props: {} },
    { start: leftId, end: upperId, type: 'FIELD', props: { fieldIndex: 0 } },
    { start: leftId, end: lowerId, type: 'FIELD', props: { fieldIndex: 1 } },
    { start: upperId, end: upperProducerId, type: 'EVAL', props: {} },
    { start: upperId, end: rightId, type: 'FieldJoin', props: { fieldIndex: 0 } },
    { start: lowerId, end: rightId, type: 'FieldJoin', props: { fieldIndex: 1 } },
    { start: rightId, end: closerId, type: 'ArgJoin', props: {} },
  ];
  const boxes = new Map([
    [openerId, { x: 0, y: 100, width: 100, height: 30 }],
    [closerId, { x: 500, y: 100, width: 30, height: 30 }],
    [leftId, { x: 100, y: 100, width: 20, height: 30 }],
    [rightId, { x: 450, y: 100, width: 20, height: 30 }],
    [upperId, { x: 160, y: 100, width: 70, height: 30 }],
    [lowerId, { x: 160, y: 142, width: 70, height: 30 }],
    [upperProducerId, { x: 260, y: 220, width: 90, height: 30 }],
  ]);

  alignObjectBraceFamilies(nodes, edges, boxes);

  const upper = boxes.get(upperId);
  const lower = boxes.get(lowerId);
  const opener = boxes.get(openerId);
  const leftBrace = boxes.get(leftId);
  const familyAxis = (
    upper.y + upper.height / 2
    + lower.y + lower.height / 2
  ) / 2;
  assert.equal(opener.y + opener.height / 2, familyAxis);
  assert.equal(
    leftBrace.y + leftBrace.height * nodes.find((candidate) => candidate.id === leftId).props.objectBraceCenterRatio,
    familyAxis,
  );
});

test('object braces and their fields form one solid routing obstacle', () => {
  const familyId = 'fixture.ts:20:10:24:2:object';
  const leftId = `${familyId}:brace:left:0`;
  const rightId = `${familyId}:brace:right:0`;
  const upperFieldId = `${familyId}:field:0`;
  const lowerFieldId = `${familyId}:field:1`;
  const nodes = [
    node(leftId, ['Object', 'ObjectBrace', 'Open'], { objectFamilyStableId: familyId }),
    node(rightId, ['Object', 'ObjectBrace', 'Close'], { objectFamilyStableId: familyId }),
    node(upperFieldId, ['Field']),
    node(lowerFieldId, ['Field']),
  ];
  const edges = [
    { start: leftId, end: upperFieldId, type: 'FIELD', props: {} },
    { start: leftId, end: lowerFieldId, type: 'FIELD', props: {} },
    { start: upperFieldId, end: rightId, type: 'FieldJoin', props: {} },
    { start: lowerFieldId, end: rightId, type: 'FieldJoin', props: {} },
  ];
  const boxes = new Map([
    [leftId, { x: 100, y: 100, width: 20, height: 160 }],
    [rightId, { x: 300, y: 100, width: 20, height: 160 }],
    [upperFieldId, { x: 160, y: 110, width: 100, height: 30 }],
    [lowerFieldId, { x: 160, y: 220, width: 100, height: 30 }],
  ]);

  const [obstacle] = buildObjectFamilyRouteObstacles(nodes, edges, boxes);
  assert.deepEqual(
    { left: obstacle.left, right: obstacle.right, top: obstacle.top, bottom: obstacle.bottom },
    { left: 100, right: 320, top: 100, bottom: 260 },
  );
  assert.deepEqual(
    new Set(obstacle.memberIds),
    new Set([leftId, rightId, upperFieldId, lowerFieldId]),
  );
});

test('system methods use the purple palette in standalone and predicate forms', () => {
  const call = node('fixture.ts:1:30:1:40', ['Call', 'Method', 'System'], {
    displayX: 0,
    displayY: 0,
    diaName: 'includes()',
  });
  const predicate = node('fixture.ts:1:50:1:70', ['Branch', 'Call', 'Method', 'System'], {
    displayX: 1,
    displayY: 0,
    operationCode: 'boolean-call',
    diaName: 'startsWith()',
  });

  const xml = makeDrawio([call, predicate], [], { semanticNodes });
  assert.match(xml, /id="n1"[^>]+%23E1D5E7[^>]+%239673A6/u);
  assert.match(xml, /id="n2"[^>]+shape=hexagon[^>]+fillColor=#E1D5E7;strokeColor=#9673A6/u);
});

test('system method tiles use the purple palette inside an expression mosaic', () => {
  const expression = node('fixture.ts:1:1:1:30', ['Action'], {
    displayX: 0,
    displayY: 0,
    renderPartsLayout: 'horizontal',
    renderPartsJson: JSON.stringify([
      { stableId: 'receiver', text: 'input', kind: 'value', labels: ['Value'], order: 0 },
      { stableId: 'method', text: 'trim()', kind: 'method', labels: ['Call', 'Method', 'System'], order: 1 },
    ]),
  });
  const xml = makeDrawio([expression], [], { semanticNodes });
  assert.match(xml, /id="n1-part-2"[^>]+%23E1D5E7[^>]+%239673A6/u);
});

test('a method-chain continuation mosaics directly to the final call closure', () => {
  const openingId = 'fixture.ts:1:1:1:20';
  const closureId = 'visual:fixture.ts:1:1:1:20:close';
  const continuationId = 'fixture.ts:1:1:1:27';
  const opening = node(openingId, ['Call', 'Start'], { displayX: 0, displayY: 0, diaName: 'expand(' });
  const closure = node(closureId, ['Fn', 'VisualProxy'], {
    displayX: 2,
    displayY: 0,
    diaName: ')',
    sourceCallStableId: openingId,
  });
  const continuation = node(continuationId, ['Op', 'Method', 'System'], {
    displayX: 3,
    displayY: 0,
    diaName: 'trim()',
    methodChainRole: 'continuation',
    methodChainOwnerStableId: openingId,
  });

  const xml = makeDrawio([opening, closure, continuation], [], {
    semanticNodes,
    suppressFoldingContainers: true,
  });
  const geometry = (id) => {
    const match = xml.match(new RegExp(
      `id="${id}"[\\s\\S]*?<mxGeometry x="([^"]+)" y="([^"]+)" width="([^"]+)"`,
      'u',
    ));
    assert.ok(match);
    return match.slice(1).map(Number);
  };
  const close = geometry('n2');
  const trim = geometry('n3');
  assert.equal(trim[0], close[0] + close[2]);
  assert.equal(trim[1], close[1]);
});

test('DataBranch outcomes use standard central ports and prefer bottom for a lower true alternative', () => {
  const branchId = 'fixture.ts:2:1:2:20';
  const falseId = 'fixture.ts:2:21:2:30';
  const trueId = 'fixture.ts:3:21:3:30';
  const nodes = [
    node(branchId, ['Branch', 'Operand', 'Data'], { displayX: 0, displayY: 0 }),
    node(falseId, ['Operand', 'Alternative'], { displayX: 1, displayY: 0 }),
    node(trueId, ['Operand', 'Alternative'], { displayX: 1, displayY: 1 }),
  ];
  const xml = makeDrawio(nodes, [
    { start: branchId, end: falseId, type: 'FALSE', props: {} },
    { start: branchId, end: trueId, type: 'TRUE', props: {} },
  ], { semanticNodes, suppressFoldingContainers: true });
  const falseEdge = xml.match(/<mxCell(?=[^>]+edgeType="FALSE")[^>]+>/u)?.[0] || '';
  const trueEdge = xml.match(/<mxCell(?=[^>]+edgeType="TRUE")[^>]+>/u)?.[0] || '';
  assert.match(falseEdge, /exitX=1;exitY=0\.5/u);
  assert.match(trueEdge, /exitX=0\.5;exitY=1/u);
  assert.doesNotMatch(`${falseEdge}${trueEdge}`, /(?:exit|entry)[XY]=0\.(?:25|75|[0-4][0-9]|[6-9][0-9])/u);
});

test('an Operand FlowBranch can leave from the left when its target is in the preceding column', () => {
  const branchId = 'fixture.ts:2:1:2:20';
  const joinId = 'fixture.ts:3:1:3:2';
  const nodes = [
    node(branchId, ['Branch', 'Operand', 'Flow'], { displayX: 1, displayY: 0 }),
    node(joinId, ['Join', 'Flow'], { displayX: 0, displayY: 1, diaName: 'x' }),
  ];
  const xml = makeDrawio(nodes, [{
    start: branchId,
    end: joinId,
    type: 'FALSE',
    props: { sourcePort: 'right' },
  }], { semanticNodes, suppressFoldingContainers: true });
  const edge = xml.match(/<mxCell(?=[^>]+edgeType="FALSE")[^>]+>/u)?.[0] || '';
  assert.match(edge, /exitX=0;exitY=0\.5/u);
});

test('operation providers render as blue method stacks with the called method overlaid', () => {
  const call = node('fixture.ts:1:30:1:50', ['Call', 'Method', 'System', 'OperationProvider', 'ModuleFacade'], {
    displayX: 0,
    displayY: 0,
    diaName: 'resume()',
  });
  const mosaic = node('fixture.ts:2:1:2:30', ['Action', 'OperationProvider', 'CapabilityBundle'], {
    displayX: 1,
    displayY: 1,
    renderPartsLayout: 'container-overlay-side',
    renderPartsJson: JSON.stringify([
      { stableId: 'receiver', text: 'helpers', kind: 'operation-provider-container', labels: ['Value', 'OperationProvider', 'CapabilityBundle'], order: 0 },
      { stableId: 'method', text: 'clearBuffer()', kind: 'method', labels: ['Call', 'Method', 'OperationProvider'], order: 1 },
    ]),
  });
  const continuation = node('fixture.ts:3:1:3:10', ['Join', 'Flow'], {
    displayX: 0,
    displayY: 1,
    diaName: 'x',
  });

  const xml = makeDrawio([call, mosaic, continuation], [
    {
      start: call.id,
      end: mosaic.id,
      type: 'NEXT',
      props: { flowLayer: 'control' },
    },
    {
      start: mosaic.id,
      end: continuation.id,
      type: 'REJOINS',
      props: { flowLayer: 'control' },
    },
  ], { semanticNodes });
  assert.match(xml, /id="n1"[^>]+%23DAE8FC[^>]+%23007FFF/u);
  const providerStack = xml.match(/id="n2-part-1"[^>]+/u)?.[0] || '';
  assert.equal([...providerStack.matchAll(/%23BFDFFF/gu)].length, 3);
  assert.match(providerStack, /translate\(8%207\)/u);
  assert.match(providerStack, /translate\(17%2015\)/u);
  assert.doesNotMatch(providerStack, /M0%200H26V8H8V26H0Z/u);
  const providerMethod = xml.match(/id="n2-part-2"[^>]+/u)?.[0] || '';
  assert.match(providerMethod, /%23DAE8FC[^>]+%23007FFF/u);
  assert.doesNotMatch(providerMethod, /fontStyle=1/u);
  const incoming = xml.match(/<mxCell id="e1"[^>]+/u)?.[0] || '';
  assert.match(incoming, /target="n2-part-2"/u);
  assert.match(incoming, /entryX=0\.5;entryY=0;/u);
  const rejoin = xml.match(/<mxCell id="e2"[^>]+/u)?.[0] || '';
  assert.match(rejoin, /source="n2-part-2"/u);
  assert.match(rejoin, /target="n3"/u);
  assert.match(rejoin, /exitX=0;exitY=0\.5;/u);
  assert.doesNotMatch(rejoin, /exitY=0\.(?:25|75);/u);
});

test('extracted function start renders as a BPMN start event with a blue NEXT', () => {
  const start = node('fixture.ts:1:1:5:2:flow-start', ['FunctionStart', 'ExecutionBoundary', 'Start'], {
    displayX: 0,
    displayY: 0,
    name: 'subject',
  });
  const input = node('fixture.ts:1:18:1:31:parameter', ['Parameter', 'Variable'], {
    displayX: 0,
    displayY: 1,
    diaName: 'input',
  });
  const xml = makeDrawio([start, input], [{
    start: start.id,
    end: input.id,
    type: 'NEXT',
    props: { flowLayer: 'control' },
  }], { semanticNodes, suppressFoldingContainers: true });

  const startCell = xml.match(/<mxCell id="n1"[^>]+/u)?.[0] || '';
  const nextCell = xml.match(/<mxCell id="e1"[^>]+/u)?.[0] || '';
  assert.match(startCell, /value="Start"/u);
  assert.match(startCell, /ellipse;perimeter=ellipsePerimeter/u);
  assert.match(xml, /<mxCell id="n1"[^>]*>[\s\S]*?<mxGeometry[^>]+width="42" height="42"/u);
  assert.match(nextCell, /edgeType="NEXT"/u);
  assert.match(nextCell, /strokeColor=#007FFF/u);
});

test('expanded TYPED_AS closes with an inward torn virtual method tile', () => {
  const close = node('fixture.ts:1:10:1:40:typed-as-close', [
    'FieldJoin',
    'Finish',
    'Method',
    'ContainerMethod',
    'Virtual',
    'TypeAnnotation',
    'Close',
  ], {
    displayX: 0,
    displayY: 0,
    diaName: ')',
    callBoundaryDesign: 'split',
    callBoundaryRole: 'close',
    callHasArguments: true,
  });
  const xml = makeDrawio([close], [], { semanticNodes, suppressFoldingContainers: true });
  const closeCell = decodeURIComponent(xml.match(/<mxCell id="n1"[\s\S]+?<\/mxCell>/u)?.[0] || '');

  assert.match(closeCell, /value="\)"/u);
  assert.match(closeCell, /clipPath|sketch-fill/u);
  assert.match(closeCell, /M 0 1 H 18 C[\s\S]+H 0 C 2\.567 45\.87/u);
});

test('parameter provider control flow uses the backing stack, not its type mosaic', () => {
  const before = node('fixture.ts:1:1:1:5', ['Fn'], { displayX: 0, displayY: 0 });
  const helpers = node('fixture.ts:1:10:1:40:parameter', ['Parameter', 'ValueSlot'], {
    displayX: 0,
    displayY: 1,
    renderPartsLayout: 'container-overlay-side',
    renderPartsJson: JSON.stringify([
      { stableId: 'helpers-container', text: 'helpers', kind: 'operation-provider-container', labels: ['OperationProvider'] },
      { stableId: 'typed-as', text: 'TYPED_AS(', kind: 'method', labels: ['Virtual', 'Method', 'TypeAnnotation'] },
      { stableId: 'type', text: 'PromptInputHelpers', kind: 'value', labels: ['Type', 'DeveloperDefined'] },
      { stableId: 'close', text: ')', kind: 'method', labels: ['Virtual', 'Method', 'Close'] },
    ]),
  });
  const after = node('fixture.ts:2:1:2:5', ['Value'], { displayX: 0, displayY: 2 });
  const xml = makeDrawio([before, helpers, after], [
    { start: before.id, end: helpers.id, type: 'NEXT', props: { flowLayer: 'control' } },
    { start: helpers.id, end: after.id, type: 'NEXT', props: { flowLayer: 'control' } },
  ], { semanticNodes, suppressFoldingContainers: true });

  const incoming = xml.match(/<mxCell id="e1"[^>]+/u)?.[0] || '';
  const outgoing = xml.match(/<mxCell id="e2"[^>]+/u)?.[0] || '';
  const typedAs = decodeURIComponent(xml.match(/<mxCell id="n2-part-2"[^>]+/u)?.[0] || '');
  const providerType = decodeURIComponent(xml.match(/<mxCell id="n2-part-3"[^>]+/u)?.[0] || '');
  const providerBacking = xml.match(/<mxCell id="n2-part-1"[\s\S]+?<mxGeometry[^>]+\/>[\s\S]+?<\/mxCell>/u)?.[0] || '';
  const providerOverlay = xml.match(/<mxCell id="n2-part-2"[\s\S]+?<mxGeometry[^>]+\/>[\s\S]+?<\/mxCell>/u)?.[0] || '';
  assert.match(incoming, /target="n2-part-1"/u);
  assert.match(outgoing, /source="n2-part-1"/u);
  assert.match(providerBacking, /height="60"/u);
  assert.match(providerOverlay, /y="47"/u);
  assert.match(typedAs, /fontStyle=1;/u);
  assert.match(typedAs, /stroke=&#39;#99CCFF&#39;/u);
  assert.match(providerType, /fill=&#39;#D5E8D4&#39;/u);
  assert.match(providerType, /stroke=&#39;#82B366&#39;/u);
});

test('operation provider control inputs from above use the top while rejoin leaves from the left', () => {
  const first = node('fixture.ts:1:1:1:10', ['Branch', 'Flow'], { displayX: 0, displayY: 0 });
  const second = node('fixture.ts:1:15:1:25', ['Branch', 'Operand', 'Flow'], { displayX: 1, displayY: 0 });
  const provider = node('fixture.ts:2:1:2:30', ['Call', 'OperationProvider'], {
    displayX: 0,
    displayY: 1,
    renderPartsLayout: 'container-overlay-side',
    renderPartsJson: JSON.stringify([
      { stableId: 'provider', text: 'proactiveModule', kind: 'operation-provider-container', labels: ['OperationProvider'] },
      { stableId: 'method', text: 'resumeProactive()', kind: 'method', labels: ['Call', 'Method'] },
    ]),
  });
  const join = node('fixture.ts:3:1:3:2', ['Join', 'Flow'], { displayX: 0, displayY: 2 });
  const xml = makeDrawio([first, second, provider, join], [
    { start: first.id, end: provider.id, type: 'TRUE', props: {} },
    { start: second.id, end: provider.id, type: 'TRUE', props: {} },
    { start: provider.id, end: join.id, type: 'REJOINS', props: { sourceRenderPartStableId: 'method' } },
  ], { semanticNodes, suppressFoldingContainers: true });
  const firstInput = xml.match(/<mxCell id="e1"[^>]+/u)?.[0] || '';
  const secondInput = xml.match(/<mxCell id="e2"[^>]+/u)?.[0] || '';
  const rejoin = xml.match(/<mxCell id="e3"[^>]+/u)?.[0] || '';
  assert.match(firstInput, /target="n3-part-2"/u);
  assert.match(secondInput, /target="n3-part-2"/u);
  assert.match(firstInput, /entryX=0\.\d+;entryY=0;/u);
  assert.match(secondInput, /entryX=0\.\d+;entryY=0;/u);
  assert.match(rejoin, /source="n3-part-2"/u);
  assert.match(rejoin, /exitX=0;exitY=0\.5;/u);
});

test('standard-library providers are simple purple tiles and their methods stay compact', () => {
  const systemProvider = node('fixture.ts:1:1:1:30', ['Op', 'Method', 'System', 'OperationProvider', 'SystemProvider'], {
    displayX: 0,
    displayY: 0,
    renderPartsLayout: 'horizontal',
    renderPartsJson: JSON.stringify([
      { stableId: 'receiver', text: 'Math', kind: 'value', labels: ['Value', 'OperationProvider', 'SystemProvider', 'System'], order: 0 },
      { stableId: 'method', text: 'round(', kind: 'method', labels: ['Op', 'Method', 'System', 'OperationProvider', 'SystemProvider'], order: 1 },
      { stableId: 'arithmetic-open', text: '(', kind: 'punctuation', labels: ['Op', 'Operand', 'ArithmeticBoundary'], order: 2 },
      { stableId: 'nested-provider', text: 'Date', kind: 'value', labels: ['Value', 'OperationProvider', 'SystemProvider', 'System'], order: 3 },
      { stableId: 'nested-method', text: 'now()', kind: 'method', labels: ['Op', 'Method', 'System', 'OperationProvider', 'SystemProvider'], order: 4 },
      { stableId: 'arithmetic-close', text: ')', kind: 'punctuation', labels: ['Op', 'Operand', 'ArithmeticBoundary'], order: 5 },
      { stableId: 'close', text: ')', kind: 'punctuation', labels: ['Op', 'CallBoundary', 'System'], order: 6 },
    ]),
  });

  const xml = makeDrawio([systemProvider], [], { semanticNodes });
  const providerTile = xml.match(/id="n1-part-1"[^>]+/u)?.[0] || '';
  assert.equal([...providerTile.matchAll(/%23E1D5E7/gu)].length, 1);
  assert.equal([...providerTile.matchAll(/%239673A6/gu)].length, 1);
  assert.doesNotMatch(providerTile, /translate\(8%207\)|translate\(17%2015\)/u);
  const providerMethod = xml.match(/id="n1-part-2"[^>]+/u)?.[0] || '';
  assert.match(providerMethod, /%23E1D5E7[^>]+%239673A6/u);
  assert.match(xml, /id="n1-part-2"[^>]*><mxGeometry[^>]+height="30"/u);
  const nestedProvider = xml.match(/id="n1-part-4"[^>]+/u)?.[0] || '';
  assert.match(nestedProvider, /%23E1D5E7[^>]+%239673A6/u);
  assert.equal([...nestedProvider.matchAll(/%23E1D5E7/gu)].length, 1);
  assert.doesNotMatch(nestedProvider, /translate\(8%207\)|translate\(17%2015\)/u);
  assert.match(xml, /id="n1-part-5"[^>]*><mxGeometry[^>]+height="30"/u);
  const arithmeticClose = xml.match(/id="n1-part-6"[^>]+/u)?.[0] || '';
  assert.match(arithmeticClose, /%23ffffff/u);
  assert.doesNotMatch(arithmeticClose, /%23E1D5E7/u);
  const callClose = xml.match(/id="n1-part-7"[^>]+/u)?.[0] || '';
  assert.match(callClose, /%23E1D5E7[^>]+%239673A6/u);
});

test('await is a straight purple keyword tile rather than a torn call boundary', () => {
  const expression = node('fixture.ts:1:1:1:30', ['Call', 'Async', 'Awaited'], {
    displayX: 0,
    displayY: 0,
    callBoundaryDesign: 'split',
    renderPartsLayout: 'horizontal',
    renderPartsJson: JSON.stringify([
      { stableId: 'await', text: 'await', kind: 'method', labels: ['Op', 'System', 'Keyword', 'Await'], order: 0 },
      { stableId: 'call', text: 'run(', kind: 'method', labels: ['Op', 'Call'], order: 1 },
    ]),
  });
  const xml = makeDrawio([expression], [], { semanticNodes });
  const awaitCell = xml.match(/<mxCell id="n1-part-1"[^>]+>/u)?.[0] || '';
  assert.match(awaitCell, /%23E1D5E7[^>]+%239673A6/u);
  assert.match(awaitCell, /M%200%201%20H/u);
  assert.doesNotMatch(awaitCell, /L%20[0-9.]+%2014/u);
});

test('await stays a purple keyword tile inside an operation-provider composition', () => {
  const expression = node('fixture.ts:2:1:2:40', ['Call', 'Method', 'Async', 'Awaited', 'OperationProvider', 'CapabilityBundle'], {
    displayX: 0,
    displayY: 0,
    callBoundaryDesign: 'split',
    callBoundaryRole: 'open',
    callHasArguments: true,
    renderPartsLayout: 'container-overlay-side',
    renderPartsJson: JSON.stringify([
      { stableId: 'provider', text: 'activeRemote', kind: 'operation-provider-container', labels: ['Value', 'OperationProvider', 'CapabilityBundle'], order: 0 },
      { stableId: 'await', text: 'await', kind: 'method', labels: ['Op', 'System', 'Keyword', 'Await'], order: 1 },
      { stableId: 'method', text: 'sendMessage(', kind: 'method', labels: ['Call', 'Method', 'OperationProvider'], order: 2 },
    ]),
  });
  const argument = node('fixture.ts:2:30:2:37', ['Arg', 'Value'], {
    displayX: 1,
    displayY: 0,
    diaName: 'content',
  });
  const optionsArgument = node('fixture.ts:2:39:2:46', ['Arg', 'Value'], {
    displayX: 1,
    displayY: 1,
    diaName: 'opts',
  });
  const closure = node('fixture.ts:2:1:2:40:close', ['Fn', 'Arg', 'Join', 'VisualProxy'], {
    displayX: 2,
    displayY: 0,
    diaName: ')',
    sourceCallStableId: expression.id,
    callBoundaryDesign: 'split',
    callBoundaryRole: 'close',
  });
  const predecessor = node('fixture.ts:1:1:1:8', ['Call'], {
    displayX: 0,
    displayY: -1,
    diaName: 'before()',
  });
  const continuation = node('fixture.ts:3:1:3:8', ['Call'], {
    displayX: 0,
    displayY: 1,
    diaName: 'after()',
  });
  const xml = makeDrawio([expression, argument, optionsArgument, closure, predecessor, continuation], [{
    start: expression.id,
    end: argument.id,
    type: 'ARG',
    props: {},
  }, {
    start: expression.id,
    end: optionsArgument.id,
    type: 'ARG',
    props: {},
  }, {
    start: predecessor.id,
    end: expression.id,
    type: 'NEXT',
    props: { flowLayer: 'control' },
  }, {
    start: expression.id,
    end: continuation.id,
    type: 'NEXT',
    props: { flowLayer: 'control' },
  }], { semanticNodes });
  const provider = xml.match(/<mxCell id="n1-part-1"[^>]+>/u)?.[0] || '';
  const awaitCell = xml.match(/<mxCell id="n1-part-2"[^>]+>/u)?.[0] || '';
  const method = xml.match(/<mxCell id="n1-part-3"[^>]+>/u)?.[0] || '';
  assert.equal([...provider.matchAll(/%23BFDFFF/gu)].length, 3);
  assert.match(awaitCell, /%23E1D5E7[^>]+%239673A6/u);
  assert.match(method, /%23DAE8FC[^>]+%23007FFF/u);
  assert.match(decodeURIComponent(method), /H 95 C 91\.74 5\.179[^']+85\.765 24\.975[^']+95 49/u);
  const argumentEdges = [...xml.matchAll(/<mxCell(?=[^>]+edgeType="ARG")[^>]+/gu)].map((match) => match[0]);
  assert.equal(argumentEdges.length, 2);
  for (const argumentEdge of argumentEdges) {
    assert.match(argumentEdge, /source="n1-part-3"/u);
    assert.match(argumentEdge, /exitX=1;exitY=0\.5;/u);
  }
  const closureCell = xml.match(/<mxCell id="n4"[\s\S]+?<mxGeometry[^>]+/u)?.[0] || '';
  assert.match(closureCell, /y="197"[^>]+height="30"/u);
  const incoming = xml.match(/<mxCell(?=[^>]+source="n5")(?=[^>]+edgeType="NEXT")[^>]+/u)?.[0] || '';
  const outgoing = xml.match(/<mxCell(?=[^>]+target="n6")(?=[^>]+edgeType="NEXT")[^>]+/u)?.[0] || '';
  assert.match(incoming, /target="n1-part-1"/u);
  assert.match(incoming, /entryX=0\.5;entryY=0;/u);
  assert.match(outgoing, /source="n1-part-1"/u);
  assert.match(outgoing, /exitX=0\.5;exitY=1;/u);
});

test('an asynchronous EVAL extracted for await is rendered as a dashed evaluation edge', () => {
  const containerId = 'fixture.ts:8:10:8:23:binding';
  const callId = 'fixture.ts:8:34:8:47:call';
  const nodes = [
    node(containerId, ['Value', 'Assignment'], { displayX: 0, displayY: 0, diaName: 'queryRequired' }),
    node(callId, ['Call', 'Start', 'Async', 'Awaited'], { displayX: 1, displayY: 0, diaName: 'handle(' }),
  ];
  const edges = [{
    start: containerId,
    end: callId,
    type: 'EVAL',
    props: { invocationMode: 'asynchronous', responseMode: 'awaited' },
  }];
  const xml = makeDrawio(nodes, edges, { semanticNodes });
  assert.match(xml, /id="e1"[^>]+dashed=1;/u);
});

test('collection property predicates keep the collection backing and style the system accessor', () => {
  const predicate = node('fixture.ts:1:1:1:30', ['Branch', 'Operand'], {
    displayX: 0,
    displayY: 0,
    renderPartsLayout: 'container-overlay-side',
    renderPartsJson: JSON.stringify([
      { stableId: 'collection', text: 'imageContents', kind: 'collection-container', labels: ['Value', 'Collection'], fillState: 'filled' },
      { stableId: 'length', text: 'length', kind: 'method', labels: ['Op', 'Method', 'System'] },
      { stableId: 'operator', text: '>', kind: 'operator', labels: ['Op'] },
      { stableId: 'literal', text: '0', kind: 'literal', labels: ['Literal'] },
    ]),
  });
  const xml = makeDrawio([predicate], [], { semanticNodes });
  assert.match(xml, /id="n1-part-1"[^>]+viewBox%3D%22-2%20-2%20124%20128%22/u);
  assert.match(xml, /id="n1-part-2"[^>]+%23E1D5E7[^>]+%239673A6/u);
});

test('a UiState setter is one variable box with its call mosaic overlaid', () => {
  const stateCall = node('fixture.ts:1:1:1:25', ['Call', 'Write', 'UiState', 'ValueSlot'], {
    displayX: 0,
    displayY: 0,
    canonicalStableId: 'fixture.ts:0:1:0:15',
    renderPartsLayout: 'container-overlay-side',
    renderPartsJson: JSON.stringify([
      {
        stableId: 'state',
        text: 'contents',
        kind: 'value-container',
        labels: ['Value', 'ValueSlot', 'UiState'],
        fillState: 'filled',
      },
      {
        stableId: 'call',
        text: 'setContents(',
        kind: 'method',
        labels: ['Call', 'Method', 'Write'],
      },
      {
        stableId: 'argument',
        text: 'ready',
        kind: 'literal',
        labels: ['Literal', 'Arg'],
      },
      {
        stableId: 'close',
        text: ')',
        kind: 'method',
        labels: ['Call', 'Method'],
      },
    ]),
  });

  const xml = makeDrawio([stateCall], [], { semanticNodes });
  assert.match(xml, /id="n1"[^>]+style="group;/u);
  assert.match(xml, /id="n1-part-1"[^>]+viewBox%3D%220%200%20120%2090%22/u);
  assert.match(xml, /id="n1-part-2"[^>]+value="setContents\("[^>]+%23DAE8FC[^>]+%23007FFF/u);
  assert.equal((xml.match(/graphLabels="[^"]*UiState[^"]*"/gu) || []).length > 0, true);
});

test('an inline literal assignment is a horizontal mosaic with a hatched empty container', () => {
  const assignment = node('fixture.ts:1:5:1:26', [
    'Method',
    'Value',
    'ComputedValue',
    'Assignment',
    'ContainerMethod',
    'Set',
  ], {
    displayX: 0,
    displayY: 0,
    // Exercise compatibility with graphs extracted before literal assignments
    // began declaring the horizontal layout themselves.
    renderPartsLayout: 'container-overlay',
    renderPartsJson: JSON.stringify([
      { text: 'doneWasCalled', kind: 'value-container', fillState: 'empty' },
      { text: 'set(', kind: 'method', labels: ['Method', 'Set'] },
      { text: 'false', kind: 'literal', labels: ['Literal'] },
      { text: ')', kind: 'punctuation', labels: ['CallBoundary'] },
    ]),
  });

  const xml = makeDrawio([assignment], [], { semanticNodes });
  const partY = [...xml.matchAll(/id="n1-part-[234]"[^>]*>[\s\S]*?<mxGeometry x="[^"]+" y="([^"]+)"/gu)]
    .map((match) => Number(match[1]));
  assert.deepEqual(partY, [34, 34, 34]);
  assert.match(xml, /id="n1-part-1"[^>]+sketch-fill/u);
});

test('a cached literal ValueWrite recovers the horizontal hatched set mosaic', () => {
  const assignment = node('fixture.ts:2:3:2:23', ['ValueAccess', 'ValueCapture', 'ValueWrite'], {
    displayX: 0,
    displayY: 0,
    diaName: 'doneWasCalled = true',
    actionTextRaw: 'doneWasCalled = true;',
  });

  const xml = makeDrawio([assignment], [], { semanticNodes });
  const partY = [...xml.matchAll(/id="n1-part-[234]"[^>]*>[\s\S]*?<mxGeometry x="[^"]+" y="([^"]+)"/gu)]
    .map((match) => Number(match[1]));
  assert.deepEqual(partY, [34, 34, 34]);
  assert.match(xml, /id="n1-part-1"[^>]+value="doneWasCalled"[^>]+sketch-fill/u);
  assert.match(xml, /id="n1-part-3" value="true"/u);
});

test('an explicit display width cannot compress horizontal mosaic text tiles', () => {
  const call = node('fixture.ts:2:3:2:48', ['Call', 'Request'], {
    displayX: 0,
    displayY: 0,
    displayWidth: 90,
    renderPartsLayout: 'horizontal',
    renderPartsJson: JSON.stringify([
      { text: 'getCommandName(', kind: 'method', labels: ['Call', 'Request'] },
      { text: 'matchingCommand', kind: 'value', labels: ['Value', 'Variable'] },
      { text: ')', kind: 'punctuation', labels: ['CallBoundary'] },
    ]),
  });

  const xml = makeDrawio([call], [], { semanticNodes });
  const group = xml.match(/id="n1"[^>]*>[\s\S]*?<mxGeometry[^>]+width="([^"]+)"/u);
  const widths = [...xml.matchAll(/id="n1-part-[123]"[^>]*>[\s\S]*?<mxGeometry[^>]+width="([^"]+)"/gu)]
    .map((match) => Number(match[1]));
  assert.ok(group, 'the horizontal mosaic group was not serialized');
  assert.ok(Number(group[1]) > 90, 'the natural text width must override the undersized display hint');
  assert.ok(widths[0] > 90, 'the opening call tile must fit its text');
  assert.ok(widths[1] > 90, 'the argument tile must fit its text');
});

test('a sole nested call argument and its closing boundaries serialize as one horizontal mosaic', () => {
  const ownerId = 'fixture.ts:2:3:2:80:outer';
  const argumentId = 'fixture.ts:2:29:2:79:inner';
  const nestedTailId = 'fixture.ts:2:52:2:78:tail';
  const argumentCloseId = 'fixture.ts:2:29:2:79:inner-close';
  const closeId = 'fixture.ts:2:3:2:80:outer-close';
  const renderPart = (text, kind = 'method') => JSON.stringify([{ text, kind, labels: ['Call'] }]);
  const nodes = [
    node(ownerId, ['Call', 'Request'], {
      displayX: 0,
      displayY: 0,
      diaName: 'createCommandInputMessage(',
      callBoundaryDesign: 'split',
      callMosaicOwnerStableId: ownerId,
      callMosaicRole: 'open',
      renderPartsLayout: 'horizontal',
      renderPartsJson: renderPart('createCommandInputMessage('),
    }),
    node(argumentId, ['Call', 'Request'], {
      displayX: 3,
      displayY: 1,
      diaName: 'formatCommandInputTags(',
      callBoundaryDesign: 'split',
      callMosaicOwnerStableId: ownerId,
      callMosaicRole: 'argument',
      renderPartsLayout: 'horizontal',
      renderPartsJson: renderPart('formatCommandInputTags('),
    }),
    node(nestedTailId, ['Value'], { displayX: 6, displayY: 0, diaName: 'commandArgs' }),
    node(argumentCloseId, ['VisualProxy', 'FnVisualProxy'], {
      displayX: 9,
      displayY: 1,
      displayWidth: 44,
      diaName: ')',
      callBoundaryDesign: 'split',
      callBoundaryRole: 'close',
      callMosaicOwnerStableId: ownerId,
      callMosaicRole: 'argument-close',
      renderPartsLayout: 'horizontal',
      renderPartsJson: renderPart(')'),
    }),
    node(closeId, ['VisualProxy', 'FnVisualProxy'], {
      displayX: 10,
      displayY: 2,
      displayWidth: 44,
      diaName: ')',
      callBoundaryDesign: 'split',
      callBoundaryRole: 'close',
      callMosaicOwnerStableId: ownerId,
      callMosaicRole: 'close',
      renderPartsLayout: 'horizontal',
      renderPartsJson: renderPart(')'),
    }),
  ];
  const edges = [{ start: nestedTailId, end: argumentCloseId, type: 'ArgJoin', props: {} }];
  const xml = makeDrawio(nodes, edges, { semanticNodes, suppressFoldingContainers: true });
  const geometry = (cellId) => {
    const match = xml.match(new RegExp(
      `<mxCell id="${cellId}"[^>]*>[\\s\\S]*?<mxGeometry x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`,
      'u',
    ));
    assert.ok(match, `geometry not found: ${cellId}`);
    return match.slice(1).map(Number);
  };
  const opening = geometry('n1');
  const argument = geometry('n2');
  const nestedTail = geometry('n3');
  const argumentClose = geometry('n4');
  const close = geometry('n5');

  assert.equal(opening[0] + opening[2], argument[0]);
  assert.equal(argumentClose[0], nestedTail[0] + nestedTail[2]);
  assert.equal(argumentClose[0] + argumentClose[2], close[0]);
  assert.equal(opening[1], argument[1]);
  assert.equal(opening[1], argumentClose[1]);
  assert.equal(opening[1], close[1]);
  assert.equal(argumentClose[2], 28, 'the closing tile uses its own text width');
  assert.equal(close[2], 28);
});

test('a value return starts at the final collection accessor and enters set from below without forcing a blocked source side', () => {
  const sourceId = 'fixture.ts:2:20:2:44:length';
  const targetId = 'fixture.ts:2:1:2:18:count';
  const source = node(sourceId, ['Op', 'ValueAccess', 'ValueRead'], {
    displayX: 2,
    displayY: 1,
    renderPartsLayout: 'container-overlay',
    renderPartsJson: JSON.stringify([
      { text: 'items', kind: 'collection-container', labels: ['Value', 'Collection'] },
      { text: 'length', kind: 'method', labels: ['Op', 'Method', 'System'] },
    ]),
  });
  const target = node(targetId, ['Method', 'Value', 'ValueSlot', 'ValueCreate', 'Assignment', 'ContainerMethod', 'Set'], {
    displayX: 0,
    displayY: 0,
    renderPartsLayout: 'container-overlay',
    renderPartsJson: JSON.stringify([
      { text: 'count', kind: 'value-container', labels: ['Value'], fillState: 'empty' },
      { text: 'set', kind: 'method', labels: ['Method', 'Set'] },
    ]),
  });
  const edges = [{
    start: sourceId,
    end: targetId,
    type: 'ASSIGNS_VALUE',
    props: { flowLayer: 'data', producerRouteRole: 'return-bottom' },
  }];

  const xml = makeDrawio([source, target], edges, { semanticNodes, suppressFoldingContainers: true });
  const edgeCell = xml.match(/<mxCell(?=[^>]+edgeType="ASSIGNS_VALUE")[^>]+>/u)?.[0] || '';
  assert.match(edgeCell, /source="n1-part-2"/u);
  assert.match(edgeCell, /target="n2-part-2"/u);
  assert.match(edgeCell, /entryX=0\.5;entryY=1/u);
});

test('optional DataBranch returns coordinate complementary routes while retaining branch colors', () => {
  const upperId = 'fixture.ts:2:20:2:30:false-result';
  const lowerId = 'fixture.ts:2:40:2:50:true-result';
  const targetId = 'fixture.ts:2:1:2:18:result';
  const groupId = `${targetId}:optional-returns`;
  const nodes = [
    node(upperId, ['Call', 'Method'], { displayX: 2, displayY: 0, diaName: 'upper' }),
    node(lowerId, ['Call', 'Method'], { displayX: 2, displayY: 2, diaName: 'lower' }),
    node(targetId, ['Method', 'Value', 'ValueSlot', 'ValueCreate', 'Assignment', 'ContainerMethod', 'Set'], {
      displayX: 0,
      displayY: 1,
      renderPartsLayout: 'container-overlay',
      renderPartsJson: JSON.stringify([
        { text: 'result', kind: 'value-container', labels: ['Value'], fillState: 'empty' },
        { text: 'set', kind: 'method', labels: ['Method', 'Set'] },
      ]),
    }),
  ];
  const edges = [
    {
      start: upperId,
      end: targetId,
      type: 'ASSIGNS_VALUE',
      props: {
        diaName: 'value',
        flowLayer: 'data',
        producerOutcome: 'false',
        optionalReturnGroupStableId: groupId,
      },
    },
    {
      start: lowerId,
      end: targetId,
      type: 'ASSIGNS_VALUE',
      props: {
        diaName: 'value',
        flowLayer: 'data',
        producerOutcome: 'true',
        optionalReturnGroupStableId: groupId,
      },
    },
  ];

  const xml = makeDrawio(nodes, edges, { semanticNodes, suppressFoldingContainers: true });
  const upperEdge = xml.match(/<mxCell(?=[^>]+edgeType="ASSIGNS_VALUE")(?=[^>]+source="n1")[^>]+>/u)?.[0] || '';
  const lowerEdge = xml.match(/<mxCell(?=[^>]+edgeType="ASSIGNS_VALUE")(?=[^>]+source="n2")[^>]+>/u)?.[0] || '';
  const upperRoute = xml.match(/<mxCell(?=[^>]+edgeType="ASSIGNS_VALUE")(?=[^>]+source="n1")[\s\S]*?<\/mxCell>/u)?.[0] || '';
  const lowerRoute = xml.match(/<mxCell(?=[^>]+edgeType="ASSIGNS_VALUE")(?=[^>]+source="n2")[\s\S]*?<\/mxCell>/u)?.[0] || '';

  assert.match(upperEdge, /strokeColor=#CC0000/u);
  assert.match(upperEdge, /entryX=0\.5;entryY=0/u);
  assert.match(lowerEdge, /strokeColor=#006600/u);
  assert.match(lowerEdge, /entryX=0\.5;entryY=1/u);
  assert.match(upperRoute, /<Array as="points">/u);
  assert.match(lowerRoute, /<Array as="points">/u);
});

test('iteration repeats approach an overlaid shift outside its collection backing', () => {
  const sourceId = 'fixture.ts:3:1:3:24:predicate';
  const targetId = 'fixture.ts:2:20:2:44:result';
  const source = node(sourceId, ['Branch', 'Operand'], { displayX: 0, displayY: 2 });
  const target = node(targetId, ['Collection', 'Result', 'ContainerMethod', 'Shift', 'Virtual'], {
    displayX: 2,
    displayY: 0,
    renderPartsLayout: 'container-overlay',
    renderPartsJson: JSON.stringify([
      { text: 'producer\nresult', kind: 'collection-container', labels: ['Value', 'Collection'] },
      { text: 'shift', kind: 'method', labels: ['Method', 'Shift'] },
    ]),
  });
  const edges = [{
    start: sourceId,
    end: targetId,
    type: 'FALSE',
    props: { flowLayer: 'control', protocolRole: 'iteration-repeat' },
  }];

  const xml = makeDrawio([source, target], edges, { semanticNodes, suppressFoldingContainers: true });
  const targetGeometry = xml.match(/id="n2"[\s\S]*?<mxGeometry x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/u);
  const edgeXml = xml.match(/<mxCell(?=[^>]+edgeType="FALSE")[\s\S]*?<\/mxCell>/u)?.[0] || '';
  const routeXs = [...edgeXml.matchAll(/<mxPoint x="([\d.]+)"/gu)].map((match) => Number(match[1]));
  assert.match(edgeXml, /protocolRole="iteration-repeat"/u);
  assert.ok(targetGeometry && routeXs.length);
  assert.ok(routeXs.at(-1) > Number(targetGeometry[1]) + Number(targetGeometry[2]));
});

test('only an external vertical left of both repeat endpoints becomes a Step entry barrier', () => {
  const sourceBox = { x: 1279, y: 19886, width: 40, height: 30 };
  const targetBox = { x: 1461, y: 19215, width: 46, height: 30 };

  assert.equal(isLeftStepEntryBarrier({ axis: 'v', x: 1140 }, sourceBox, targetBox), true);
  assert.equal(isLeftStepEntryBarrier({ axis: 'v', x: 1432 }, sourceBox, targetBox), false);
  assert.equal(isLeftStepEntryBarrier({ axis: 'h', x: 1140 }, sourceBox, targetBox), false);
});

test('compact collection result arguments align with the embedded push method row', () => {
  const resultId = 'fixture.ts:1:1:1:30:result';
  const argumentId = 'fixture.ts:1:20:1:24';
  const closeId = `${resultId}:close`;
  const result = node(resultId, ['Value', 'Collection', 'Result', 'Virtual', 'ContainerMethod'], {
    displayX: 0,
    displayY: 0,
    compactCallMosaic: true,
    callMosaicOwnerStableId: resultId,
    callMosaicRole: 'open',
    renderPartsLayout: 'container-overlay-side',
    renderPartsJson: JSON.stringify([
      { stableId: `${resultId}:container`, text: 'result', kind: 'collection-container', fillState: 'empty' },
      { stableId: resultId, text: 'push(', kind: 'method', labels: ['Method', 'ContainerMethod'] },
    ]),
  });
  const argument = node(argumentId, ['Value', 'ValueAccess'], {
    displayX: 1,
    displayY: 1,
    callMosaicOwnerStableId: resultId,
    callMosaicRole: 'argument',
  });
  const close = node(closeId, ['Op', 'CallBoundary'], {
    displayX: 2,
    displayY: 1,
    callMosaicOwnerStableId: resultId,
    callMosaicRole: 'close',
  });
  const xml = makeDrawio([result, argument, close], [], { semanticNodes });
  const resultY = Number(xml.match(/id="n1"[^>]*>[\s\S]*?<mxGeometry[^>]+y="([^"]+)"/u)?.[1]);
  const methodOffsetY = Number(xml.match(/id="n1-part-2"[^>]*>[\s\S]*?<mxGeometry[^>]+y="([^"]+)"/u)?.[1]);
  const argumentY = Number(xml.match(/id="n2"[^>]*>[\s\S]*?<mxGeometry[^>]+y="([^"]+)"/u)?.[1]);
  const closeY = Number(xml.match(/id="n3"[^>]*>[\s\S]*?<mxGeometry[^>]+y="([^"]+)"/u)?.[1]);
  assert.equal(argumentY, resultY + methodOffsetY);
  assert.equal(closeY, resultY + methodOffsetY);
  const methodCell = decodeURIComponent(xml.match(/<mxCell id="n1-part-2"[\s\S]+?<\/mxCell>/u)?.[0] || '');
  const closeCell = decodeURIComponent(xml.match(/<mxCell id="n3"[\s\S]+?<\/mxCell>/u)?.[0] || '');
  assert.match(methodCell, /M 0 1 H [\d.]+ V 49 H 0 C/u);
  assert.match(closeCell, /sketch-fill|clipPath/u);
});

test('typed empty arrays render as an open collection with a virtual declare mosaic', () => {
  const declaration = node('fixture.ts:1:1:1:45', [
    'Value',
    'Collection',
    'ContainerMethod',
    'Declaration',
    'Method',
    'SemanticExpansion',
    'Primitive',
  ], {
    displayX: 0,
    displayY: 0,
    renderPartsLayout: 'container-overlay-side',
    renderPartsJson: JSON.stringify([
      { text: 'contentBlocks', kind: 'collection-container', fillState: 'empty' },
      { text: 'declare(', kind: 'method', labels: ['ContainerMethod', 'Method', 'Virtual'] },
      { text: 'ContentBlockParam', kind: 'value', labels: ['Type', 'DeveloperDefined'] },
      { text: '[]', kind: 'punctuation', labels: ['ArrayType', 'Punctuation', 'Type'] },
      { text: '=', kind: 'operator', labels: ['AssignmentOperator', 'Operator'] },
      { text: '[]', kind: 'literal', labels: ['ArrayLiteral', 'Literal'] },
      { text: ')', kind: 'punctuation', labels: ['CallBoundary', 'ContainerMethod', 'Method', 'Virtual'] },
    ]),
  });

  const xml = makeDrawio([declaration], [], { semanticNodes });
  const collectionCell = decodeURIComponent(xml.match(/<mxCell id="n1-part-1"[^>]+>/u)?.[0] || '');
  const typeCell = xml.match(/<mxCell id="n1-part-3"[^>]+>/u)?.[0] || '';
  const closeCell = xml.match(/<mxCell id="n1-part-7"[^>]+>/u)?.[0] || '';
  assert.match(collectionCell, /M27 17 L115 25 L120 8 L32 0 Z/u);
  assert.doesNotMatch(collectionCell, /M27 17 L115 25 L108 8 L20 0 Z/u);
  assert.match(collectionCell, /M5 32 L93 40 L88 23 L0 15 Z/u);
  assert.match(collectionCell, /M93 40 L115 25 L120 11 L98 26 Z/u);
  assert.match(collectionCell, /viewBox="-2 -2 124 128"/u);
  assert.match(collectionCell, /M5 32 L93 40 L93 68 L5 60 Z/u);
  assert.match(typeCell, /%23D5E8D4/u);
  assert.match(typeCell, /%2382B366/u);
  assert.match(closeCell, /%2399CCFF/u);
  assert.match(closeCell, /%23007FFF/u);
});

test('collection declarations keep their container centers on the same subcolumn axis', () => {
  const firstId = 'fixture.ts:1:1:1:1';
  const secondId = 'fixture.ts:2:1:2:1';
  const firstStepId = 'flow-step:statement:fixture.ts:1:1:1:45';
  const secondStepId = 'flow-step:statement:fixture.ts:2:1:2:45';
  const declaration = (id, name, type, parentStepStableId, flowStepOrder) => node(id, [
    'Value',
    'Collection',
    'ContainerMethod',
    'Declaration',
    'Method',
  ], {
    displayX: 0,
    displayY: name === 'contentBlocks' ? 0 : 1,
    parentStepStableId,
    parentFlowBlockStableId: '',
    flowStepOrder,
    renderPartsLayout: 'container-overlay-side',
    renderPartsJson: JSON.stringify([
      { text: name, kind: 'collection-container', fillState: 'empty' },
      { text: 'declare(', kind: 'method', labels: ['ContainerMethod', 'Method', 'Virtual'] },
      { text: type, kind: 'value', labels: ['Type', 'System'] },
    ]),
  });
  const xml = makeDrawio([
    declaration(firstId, 'contentBlocks', 'ContentBlockParam[] = []', firstStepId, 0),
    declaration(secondId, 'remoteBlocks', 'Array<', secondStepId, 1),
  ], [{ start: firstId, end: secondId, type: 'NEXT', props: { flowLayer: 'control' } }], {
    semanticNodes: [
      { key: firstStepId, labels: ['Step'], props: { headStableIds: [firstId], tailStableIds: [firstId] } },
      { key: secondStepId, labels: ['Step'], props: { headStableIds: [secondId], tailStableIds: [secondId] } },
    ],
    suppressFoldingContainers: true,
  });
  const partGeometry = (id) => {
    const cell = xml.match(new RegExp(`<mxCell id="${id}"[^>]*>[\\s\\S]*?<mxGeometry[^>]+`, 'u'))?.[0] || '';
    const geometry = cell.match(/<mxGeometry[^>]+/u)?.[0] || '';
    const x = Number(geometry.match(/\bx="([^"]+)"/u)?.[1] || 0);
    const width = Number(geometry.match(/\bwidth="([^"]+)"/u)?.[1]);
    return { x, width };
  };
  const groupX = (id) => {
    const cell = xml.match(new RegExp(`<mxCell id="${id}"[^>]*>[\\s\\S]*?<mxGeometry[^>]+`, 'u'))?.[0] || '';
    const geometry = cell.match(/<mxGeometry[^>]+/u)?.[0] || '';
    return Number(geometry.match(/\bx="([^"]+)"/u)?.[1] || 0);
  };
  const first = partGeometry('n1-part-1');
  const second = partGeometry('n2-part-1');
  assert.ok(Math.abs(
    groupX('n1') + first.x + first.width / 2
      - (groupX('n2') + second.x + second.width / 2),
  ) <= 0.5);
});

test('iterator variables use a normal fill while their virtual set methods use sketch fills', () => {
  const cmd = node('fixture.ts:1:80:1:100:iteration', [
    'Value',
    'ValueSlot',
    'Iteration',
    'SemanticExpansion',
    'Element',
    'Primitive',
    'Bind',
    'Variable',
    'ContainerMethod',
    'Set',
  ], {
    displayX: 0,
    displayY: 0,
    render_parts_layout: 'container-overlay',
    render_parts_json: JSON.stringify([
      { kind: 'container', text: 'cmd', fillState: 'empty' },
      { kind: 'method', text: 'set' },
    ]),
  });

  const xml = makeDrawio([cmd], [], { semanticNodes });
  assert.doesNotMatch(xml.match(/<mxCell id="n1-part-1"[^>]+>/u)?.[0] || '', /sketch-fill/u);
  assert.match(xml, /id="n1-part-2"[^>]+clipPath[^>]+%2399CCFF[^>]+%23007FFF/u);
});

test('NEXT enters and leaves a newly created collection through its container body', () => {
  const previousId = 'fixture.ts:8:1:8:10';
  const collectionId = 'fixture.ts:8:20:8:40';
  const nextId = 'fixture.ts:9:1:9:10';
  const nodes = [
    node(previousId, ['Call', 'Method'], { displayX: 0, displayY: 0 }),
    node(collectionId, ['Collection', 'ValueSlot', 'ContainerMethod', 'Set'], {
      displayX: 1,
      displayY: 0,
      render_parts_layout: 'container-overlay',
      render_parts_json: JSON.stringify([
        { kind: 'collection-container', text: 'items', fillState: 'empty' },
        { kind: 'method', text: 'set' },
      ]),
    }),
    node(nextId, ['Call', 'Method'], { displayX: 2, displayY: 0 }),
  ];
  const xml = makeDrawio(nodes, [
    { start: previousId, end: collectionId, type: 'NEXT', props: { flowLayer: 'control' } },
    { start: collectionId, end: nextId, type: 'NEXT', props: { flowLayer: 'control' } },
  ], { semanticNodes });
  const nextEdges = [...xml.matchAll(/<mxCell(?=[^>]+edgeType="NEXT")[^>]+>/gu)].map((match) => match[0]);
  assert.equal(nextEdges.length, 2);
  assert.match(nextEdges[0], /target="n2-part-1"/u);
  assert.match(nextEdges[1], /source="n2-part-1"/u);
});

test('TRUE and FALSE arrows and labels use the dark green and red palettes', () => {
  const source = node('fixture.ts:1:110:1:120', ['Branch', 'Operand'], { displayX: 0, displayY: 0 });
  const truthy = node('fixture.ts:1:130:1:140', ['Action'], { displayX: 1, displayY: 0 });
  const falsy = node('fixture.ts:1:150:1:160', ['Action'], { displayX: 1, displayY: 1 });
  const edges = [
    { start: source.id, end: truthy.id, type: 'TRUE', props: { displayLabel: 'TRUE' } },
    { start: source.id, end: falsy.id, type: 'FALSE', props: { displayLabel: 'FALSE' } },
  ];

  const xml = makeDrawio([source, truthy, falsy], edges, { semanticNodes });
  assert.match(xml, /strokeColor=#006600;fontColor=#006600;[^>]+edgeType="TRUE"/u);
  assert.match(xml, /strokeColor=#CC0000;fontColor=#CC0000;[^>]+edgeType="FALSE"/u);
  assert.match(xml, /value="true"[^>]+edgeType="TRUE"/u);
  assert.match(xml, /value="false"[^>]+edgeType="FALSE"/u);
  for (const type of ['TRUE', 'FALSE']) {
    const labelX = Number(xml.match(new RegExp(`edgeType="${type}"[^>]*><mxGeometry x="([^"]+)" relative="1"`, 'u'))?.[1]);
    assert.ok(labelX >= -0.9 && labelX <= 0, `${type} label must remain near its source without touching it`);
  }
});

test('composite variable routes use the variable body and set method as distinct endpoints', () => {
  const variableId = 'fixture.ts:1:1:1:10';
  const producerId = 'fixture.ts:1:20:1:30';
  const predicateId = 'fixture.ts:2:20:2:40';
  const nextId = 'fixture.ts:3:1:3:10';
  const nodes = [
    node(variableId, ['Method', 'Value', 'ValueSlot', 'Assignment', 'ContainerMethod', 'Set'], {
      displayX: 0,
      displayY: 0,
      render_parts_layout: 'container-overlay',
      render_parts_json: JSON.stringify([
        { kind: 'container', text: 'result', fillState: 'empty' },
        { kind: 'method', text: 'set' },
      ]),
    }),
    node(producerId, ['Op', 'Method'], { displayX: 1, displayY: 0 }),
    node(predicateId, ['Branch', 'Operand', 'Predicate'], {
      displayX: 1,
      displayY: 1,
      render_parts_layout: 'horizontal',
      render_parts_json: JSON.stringify([
        { kind: 'value', text: 'candidate' },
        { kind: 'operator', text: '===' },
        { kind: 'literal', text: 'value' },
      ]),
    }),
    node(nextId, ['Call', 'Start'], { displayX: 0, displayY: 2 }),
  ];
  const edges = [
    { start: variableId, end: producerId, type: 'EVAL', props: { displayLabel: 'eval', flowLayer: 'data' } },
    { start: predicateId, end: variableId, type: 'TRUE', props: { displayLabel: 'TRUE', flowLayer: 'control' } },
    { start: variableId, end: nextId, type: 'NEXT', props: { flowLayer: 'control' } },
  ];

  const xml = makeDrawio(nodes, edges, { semanticNodes });
  const evalEdge = xml.match(/<mxCell(?=[^>]+edgeType="EVAL")(?=[^>]+source="([^"]+)")(?=[^>]+target="([^"]+)")[^>]+>/u);
  const trueEdge = xml.match(/<mxCell(?=[^>]+edgeType="TRUE")(?=[^>]+source="([^"]+)")(?=[^>]+target="([^"]+)")[^>]+>/u);
  const nextEdge = xml.match(/<mxCell(?=[^>]+edgeType="NEXT")(?=[^>]+source="([^"]+)")(?=[^>]+target="([^"]+)")[^>]+>/u);
  assert.ok(evalEdge && trueEdge && nextEdge);
  assert.match(evalEdge[0], /strokeColor=#007FFF/u);
  assert.match(evalEdge[1], /-part-1$/u);
  assert.equal(trueEdge[1], 'n3');
  assert.match(trueEdge[2], /-part-1$/u);
  assert.match(nextEdge[1], /-part-1$/u);
  assert.match(xml, /id="n1-part-2"[^>]+clipPath[^>]+%2399CCFF[^>]+%23007FFF/u);
});

test('a NEXT continuation preserves the subcolumn of an expanded object family', () => {
  const sourceId = 'fixture.ts:4:1:6:2';
  const sourceFieldId = 'fixture.ts:5:3:5:14';
  const targetId = 'fixture.ts:7:1:9:2';
  const targetFieldId = 'fixture.ts:8:3:8:14';
  const followingId = 'fixture.ts:10:1:12:2';
  const followingFieldId = 'fixture.ts:11:3:11:14';
  const nodes = [
    node(sourceId, ['Value', 'Assignment', 'ContainerMethod', 'Set'], {
      displayX: 2,
      displayY: 0,
      displayOffsetX: -100,
      container_state: 'awaiting-assignment',
      opens_object_field_family: true,
      render_parts_layout: 'container-overlay-side',
      render_parts_json: JSON.stringify([
        { kind: 'value-container', text: 'source', fillState: 'empty' },
        { kind: 'method', text: 'set(' },
      ]),
    }),
    node(sourceFieldId, ['Field', 'Value'], { displayX: 3, displayY: 1 }),
    node(targetId, ['Collection', 'Start', 'Method'], {
      displayX: 2,
      displayY: 0.5,
      opens_object_field_family: true,
      render_parts_layout: 'container-overlay-side',
      render_parts_json: JSON.stringify([
        { kind: 'collection-container', text: 'contentBlocks' },
        { kind: 'method', text: 'push(' },
      ]),
    }),
    node(targetFieldId, ['Field', 'Value'], { displayX: 3, displayY: 0.5 }),
    node(followingId, ['Collection', 'Start', 'Method'], {
      displayX: 2,
      displayY: 2,
      opens_object_field_family: true,
      render_parts_layout: 'container-overlay-side',
      render_parts_json: JSON.stringify([
        { kind: 'collection-container', text: 'remoteBlocks' },
        { kind: 'method', text: 'push(' },
      ]),
    }),
    node(followingFieldId, ['Field', 'Value'], { displayX: 3, displayY: 2 }),
  ];
  const edges = [
    { start: sourceId, end: sourceFieldId, type: 'FIELD', props: {} },
    { start: sourceId, end: targetId, type: 'NEXT', props: {} },
    { start: targetId, end: targetFieldId, type: 'FIELD', props: {} },
    { start: targetId, end: followingId, type: 'NEXT', props: {} },
    { start: followingId, end: followingFieldId, type: 'FIELD', props: {} },
  ];

  const xml = makeDrawio(nodes, edges, { semanticNodes, suppressFoldingContainers: true });
  const geometry = (cellId) => {
    const match = xml.match(new RegExp(
      `<mxCell id="${cellId}"[^>]*>[\\s\\S]*?<mxGeometry x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`,
      'u',
    ));
    assert.ok(match, `geometry not found: ${cellId}`);
    return match.slice(1).map(Number);
  };
  const source = geometry('n1');
  const sourceField = geometry('n2');
  const target = geometry('n3');
  const following = geometry('n5');
  assert.equal(
    source[0] + source[2] / 2,
    target[0] + target[2] / 2,
  );
  assert.ok(
    Math.abs((target[0] + target[2] / 2) - (following[0] + following[2] / 2)) <= 0.5,
    'integer geometry may round a shared subcolumn center by half a pixel',
  );
  assert.ok(
    target[1] >= sourceField[1] + sourceField[3] + 8,
    'the continuation must start below the complete source family',
  );
});

test('collection shift reserves the EVAL input and shares a different port between repeat inputs', () => {
  const popId = 'fixture.ts:5:20:5:40';
  const evalId = 'fixture.ts:5:1:5:10';
  const repeatAId = 'fixture.ts:6:40:6:60';
  const repeatBId = 'fixture.ts:7:40:7:60';
  const nodes = [
    node(evalId, ['Value', 'Variable'], { displayX: 0, displayY: 0 }),
    node(popId, ['Collection', 'Method'], {
      displayX: 1,
      displayY: 0,
      render_parts_layout: 'container-overlay',
      render_parts_json: JSON.stringify([
        { kind: 'collection-container', text: 'items' },
        { kind: 'method', text: 'shift', labels: ['Shift'] },
      ]),
    }),
    node(repeatAId, ['Branch', 'Operand'], { displayX: 2, displayY: 1 }),
    node(repeatBId, ['Branch', 'Operand'], { displayX: 2, displayY: 2 }),
  ];
  const edges = [
    { start: evalId, end: popId, type: 'EVAL', props: { displayLabel: 'eval' } },
    { start: repeatAId, end: popId, type: 'FALSE', props: { diaName: 'repeat', flowLayer: 'control', protocolRole: 'iteration-repeat' } },
    { start: repeatBId, end: popId, type: 'FALSE', props: { diaName: 'repeat', flowLayer: 'control', protocolRole: 'iteration-repeat' } },
  ];

  const xml = makeDrawio(nodes, edges, { semanticNodes });
  const edgeTag = (type, start) => xml.match(new RegExp(
    `<mxCell(?=[^>]+edgeType="${type}")(?=[^>]+stableId="${start.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}")(?=[^>]+target="([^"]+)")[^>]+>`,
    'u',
  ))?.[0] || '';
  const evalEdge = edgeTag('EVAL', evalId);
  const repeatAEdge = edgeTag('FALSE', repeatAId);
  const repeatBEdge = edgeTag('FALSE', repeatBId);
  const entry = (tag) => tag.match(/entryX=([^;]+);entryY=([^;]+)/u)?.slice(1).join(':');
  assert.match(evalEdge, /target="[^"]+-part-2"/u);
  assert.match(repeatAEdge, /target="[^"]+-part-2"/u);
  assert.match(repeatBEdge, /target="[^"]+-part-2"/u);
  assert.notEqual(entry(evalEdge), entry(repeatAEdge));
  assert.equal(entry(repeatAEdge), entry(repeatBEdge));
  assert.equal(entry(repeatAEdge), '1:0.5');
  assert.match(repeatAEdge, /value="repeat"/u);
});

test('collection shift emits iteration value from its bottom method port', () => {
  const popId = 'fixture.ts:5:20:5:40';
  const itemId = 'fixture.ts:5:1:5:10';
  const nodes = [
    node(popId, ['Collection', 'Method'], {
      displayX: 1,
      displayY: 0,
      render_parts_layout: 'container-overlay',
      render_parts_json: JSON.stringify([
        { kind: 'collection-container', text: 'items' },
        { kind: 'method', text: 'shift', labels: ['Shift'] },
      ]),
    }),
    node(itemId, ['Value', 'Variable', 'Assignment', 'Set'], {
      displayX: 0,
      displayY: 1,
      render_parts_layout: 'container-overlay',
      render_parts_json: JSON.stringify([
        { kind: 'value-container', text: 'item' },
        { kind: 'method', text: 'set', labels: ['Set'] },
      ]),
    }),
  ];
  const edges = [{
    start: popId,
    end: itemId,
    type: 'YIELDS_VALUE',
    props: { diaName: 'value', protocolRole: 'iteration-pass', flowLayer: 'data' },
  }];

  const xml = makeDrawio(nodes, edges, { semanticNodes });
  const valueEdge = xml.match(/<mxCell(?=[^>]+edgeType="YIELDS_VALUE")[^>]+>/u)?.[0] || '';
  assert.match(valueEdge, /source="[^"]+-part-2"/u);
  assert.match(valueEdge, /exitX=0\.5;exitY=1/u);
  assert.match(valueEdge, /value="value"/u);
});

test('collection push control targets distinguish internal loop flow from external flow', () => {
  const predicateId = 'fixture.ts:6:10:6:28:predicate';
  const externalId = 'fixture.ts:5:1:5:8:external';
  const resultId = 'fixture.ts:6:1:6:8:result';
  const repeatResultId = 'fixture.ts:7:1:7:8:result';
  const shiftId = 'fixture.ts:6:30:6:44:shift';
  const pushPartId = `${resultId}:push`;
  const repeatPushPartId = `${repeatResultId}:push`;
  const nodes = [
    node(predicateId, ['Branch', 'Operand', 'Data'], { displayX: 2, displayY: 2, diaName: 'accepted' }),
    node(externalId, ['Action'], { displayX: 0, displayY: -1, diaName: 'before loop' }),
    node(resultId, ['Method', 'Value', 'Collection', 'Assignment', 'ContainerMethod'], {
      displayX: 0,
      displayY: 0,
      renderPartsLayout: 'container-overlay-side',
      renderPartsJson: JSON.stringify([
        { stableId: `${resultId}:container`, kind: 'collection-container', text: 'result', fillState: 'empty' },
        { stableId: pushPartId, kind: 'method', text: 'push(' },
        { stableId: `${resultId}:value`, kind: 'value', text: 'item' },
        { stableId: `${resultId}:close`, kind: 'punctuation', text: ')', labels: ['CallBoundary'] },
      ]),
    }),
    node(repeatResultId, ['Method', 'Value', 'Collection', 'CallbackResult', 'ContainerMethod'], {
      displayX: 2,
      displayY: 3,
      renderPartsLayout: 'container-overlay-side',
      renderPartsJson: JSON.stringify([
        { stableId: `${repeatResultId}:container`, kind: 'collection-container', text: 'result', fillState: 'empty' },
        { stableId: repeatPushPartId, kind: 'method', text: 'push(' },
        { stableId: `${repeatResultId}:value`, kind: 'value', text: 'item' },
        { stableId: `${repeatResultId}:close`, kind: 'punctuation', text: ')', labels: ['CallBoundary'] },
      ]),
    }),
    node(shiftId, ['Collection', 'Method', 'Shift'], {
      displayX: 3,
      displayY: 0,
      renderPartsLayout: 'container-overlay',
      renderPartsJson: JSON.stringify([
        { stableId: `${shiftId}:container`, kind: 'collection-container', text: 'items' },
        { stableId: `${shiftId}:shift`, kind: 'method', text: 'shift' },
      ]),
    }),
  ];
  const edges = [
    {
      start: externalId,
      end: resultId,
      type: 'NEXT',
      props: { flowLayer: 'control' },
    },
    {
      start: predicateId,
      end: resultId,
      type: 'TRUE',
      props: {
        protocolRole: 'assignment-return',
        targetRenderPartStableId: pushPartId,
      },
    },
    {
      start: repeatResultId,
      end: shiftId,
      type: 'REPEATS',
      props: {
        protocolRole: 'iteration-repeat',
        sourceRenderPartStableId: repeatPushPartId,
      },
    },
  ];

  const xml = makeDrawio(nodes, edges, { semanticNodes, suppressFoldingContainers: true });
  const trueEdge = xml.match(/<mxCell(?=[^>]+edgeType="TRUE")[^>]+>/u)?.[0] || '';
  const nextEdge = xml.match(/<mxCell(?=[^>]+edgeType="NEXT")[^>]+>/u)?.[0] || '';
  const repeatEdge = xml.match(/<mxCell(?=[^>]+edgeType="REPEATS")[^>]+>/u)?.[0] || '';
  assert.match(trueEdge, /target="n3-part-2"/u);
  assert.match(nextEdge, /target="n3-part-1"/u);
  assert.match(repeatEdge, /source="n4-part-2"/u);
});

test('predicate mosaic control exits use the whole mosaic instead of an embedded method tile', () => {
  const predicateId = 'fixture.ts:5:1:5:40';
  const targetId = 'fixture.ts:6:1:6:20';
  const predecessorId = 'fixture.ts:4:1:4:20';
  const nodes = [
    node(predicateId, ['Branch', 'Collection', 'Method'], {
      displayX: 0,
      displayY: 0,
      render_parts_layout: 'container-overlay-side',
      render_parts_json: JSON.stringify([
        { kind: 'collection-container', text: 'item.aliases' },
        { kind: 'method', text: 'includes(' },
        { kind: 'value', text: 'name' },
        { kind: 'punctuation', text: ')' },
      ]),
    }),
    node(targetId, ['Branch', 'Operand'], { displayX: 1, displayY: 1 }),
    node(predecessorId, ['Branch', 'Operand'], { displayX: 0, displayY: -1 }),
  ];
  const edges = [
    { start: predecessorId, end: predicateId, type: 'FALSE', props: { flowLayer: 'control' } },
    { start: predicateId, end: targetId, type: 'TRUE', props: { flowLayer: 'control' } },
  ];

  const xml = makeDrawio(nodes, edges, { semanticNodes });
  const incomingFalse = xml.match(/<mxCell(?=[^>]+edgeType="FALSE")[^>]+>/u)?.[0] || '';
  const outgoingTrue = xml.match(/<mxCell(?=[^>]+edgeType="TRUE")[^>]+>/u)?.[0] || '';
  assert.match(incomingFalse, /target="n1-predicate-overlay"/u);
  assert.match(outgoingTrue, /source="n1-predicate-overlay"/u);
  assert.match(xml, /id="n1-predicate-overlay"[^>]+shape=hexagon/u);
  const containerGeometry = xml.match(/id="n1-part-1"[^>]*><mxGeometry x="([\d.]+)"[^>]+width="([\d.]+)"/u);
  const overlayGeometry = xml.match(/id="n1-part-2"[^>]*><mxGeometry x="([\d.]+)"/u);
  assert.ok(containerGeometry && overlayGeometry);
  assert.ok(
    Number(overlayGeometry[1]) > Number(containerGeometry[1]) + Number(containerGeometry[2]) / 2,
    'a diagonal overlay must start to the right of the backing bottom-center port',
  );
});

test('horizontal predicate mosaics route control from the complete hexagonal group', () => {
  const predicateId = 'fixture.ts:7:1:7:40';
  const targetId = 'fixture.ts:8:1:8:20';
  const nodes = [
    node(predicateId, ['Branch', 'Operand'], {
      displayX: 0,
      displayY: 0,
      render_parts_layout: 'horizontal',
      render_parts_json: JSON.stringify([
        { kind: 'value', text: 'left' },
        { kind: 'operator', text: '===' },
        { kind: 'literal', text: 'right' },
      ]),
    }),
    node(targetId, ['Value'], { displayX: 1, displayY: 0 }),
  ];
  const edges = [{ start: predicateId, end: targetId, type: 'TRUE', props: { flowLayer: 'control' } }];

  const xml = makeDrawio(nodes, edges, { semanticNodes });
  const outgoingTrue = xml.match(/<mxCell(?=[^>]+edgeType="TRUE")[^>]+>/u)?.[0] || '';
  assert.match(outgoingTrue, /source="n1"/u);
  assert.doesNotMatch(outgoingTrue, /source="n1-part-/u);
  assert.match(outgoingTrue, /exitX=1;exitY=0\.5/u);
});

test('horizontal predicate frames reserve final mosaic widths before placing the next predicate', () => {
  const firstId = 'fixture.ts:9:1:9:30';
  const secondId = 'fixture.ts:9:34:9:70';
  const nodes = [
    node(firstId, ['Branch', 'Operand', 'PredicateCall', 'SubStepAttachment'], {
      displayX: 0,
      displayY: 0,
      displayWidth: 199,
      skipHorizontalCompaction: true,
      operationIndex: 1,
    }),
    node(secondId, ['Branch', 'Operand', 'PredicateOperator', 'SubStepAttachment'], {
      displayX: 0.78,
      displayY: 0,
      displayWidth: 241,
      skipHorizontalCompaction: true,
      operationIndex: 2,
    }),
  ];
  const edges = [{ start: firstId, end: secondId, type: 'FALSE', props: { flowLayer: 'control' } }];
  const xml = makeDrawio(nodes, edges, { semanticNodes, suppressFoldingContainers: true });
  const geometry = (cellId) => {
    const match = xml.match(new RegExp(
      `<mxCell id="${cellId}"[^>]*>[\\s\\S]*?<mxGeometry x="([^"]+)" y="([^"]+)" width="([^"]+)"`,
      'u',
    ));
    assert.ok(match, `geometry not found: ${cellId}`);
    return { x: Number(match[1]), width: Number(match[3]) };
  };
  const first = geometry('n1');
  const second = geometry('n2');

  assert.ok(second.x >= first.x + first.width + 56);
});

test('predicate alternatives route from their extracted mosaic parts without duplicate nodes', () => {
  const predicateId = 'fixture.ts:2:10:2:48:predicate';
  const joinId = 'fixture.ts:2:10:2:48:data-join';
  const predicate = node(predicateId, ['Branch', 'Field', 'PredicateOperator'], {
    displayX: 0,
    displayY: 0,
    renderPartsLayout: 'horizontal',
    renderPartsJson: JSON.stringify([
      { stableId: 'options', text: 'options?', kind: 'value', labels: ['Value'] },
      { stableId: 'field', text: '.fromKeybinding', kind: 'field', labels: ['Field'] },
      { stableId: 'operator', text: '??', kind: 'operator', labels: ['Op'] },
      { stableId: 'fallback', text: 'false', kind: 'literal', labels: ['Literal'] },
    ]),
  });
  const join = node(joinId, ['DataJoin'], { displayX: 2, displayY: 8, diaName: 'DataJoin' });
  const edges = [
    {
      start: predicateId,
      end: joinId,
      type: 'TRUE',
      props: { flowLayer: 'control', sourceRenderPartStableId: 'field' },
    },
    {
      start: predicateId,
      end: joinId,
      type: 'FALSE',
      props: { flowLayer: 'control', sourceRenderPartStableId: 'fallback' },
    },
  ];

  const xml = makeDrawio([predicate, join], edges, { semanticNodes, suppressFoldingContainers: true });
  const trueEdge = xml.match(/<mxCell(?=[^>]+edgeType="TRUE")[^>]+>/u)?.[0] || '';
  const falseEdge = xml.match(/<mxCell(?=[^>]+edgeType="FALSE")[^>]+>/u)?.[0] || '';
  assert.match(trueEdge, /source="n1-part-2"/u);
  assert.match(falseEdge, /source="n1-part-4"/u);
  assert.match(trueEdge, /exitX=0\.5;exitY=0/u);
  assert.match(trueEdge, /entryX=0\.5;entryY=0/u);
  assert.match(falseEdge, /entryX=0;entryY=0\.5/u);
  const trueEdgeCell = xml.match(/<mxCell(?=[^>]+edgeType="TRUE")[\s\S]*?<\/mxCell>/u)?.[0] || '';
  assert.match(
    trueEdgeCell,
    /<Array as="points">/u,
    'a mosaic outcome must keep its obstacle-aware route instead of delegating it to draw.io',
  );
  const geometry = (stableId) => {
    const match = xml.match(new RegExp(`stableId="${stableId}"[\\s\\S]*?<mxGeometry x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`, 'u'));
    assert.ok(match, `missing geometry for ${stableId}`);
    return {
      x: Number(match[1]),
      y: Number(match[2]),
      width: Number(match[3]),
      height: Number(match[4]),
    };
  };
  const predicateGeometry = geometry(predicateId);
  const joinGeometry = geometry(joinId);
  assert.equal(
    joinGeometry.y + joinGeometry.height / 2,
    predicateGeometry.y + predicateGeometry.height / 2,
  );
  assert.equal(
    joinGeometry.x,
    predicateGeometry.x + predicateGeometry.width + 36,
    'a direct DataJoin must use the local predicate width, not a globally expanded abstract column',
  );
});

test('collection call mosaics use compact text widths, blue call tiles, and box-stack backings', () => {
  const collectionId = 'fixture.ts:5:1:5:40';
  const nodes = [node(collectionId, ['Collection', 'Method', 'Assignment'], {
    displayX: 0,
    displayY: 0,
    render_parts_layout: 'container-overlay-side',
    render_parts_json: JSON.stringify([
      { kind: 'collection-container', text: 'items' },
      { kind: 'method', text: 'push(', labels: ['Call', 'Method'] },
      { kind: 'value', text: 'r' },
      { kind: 'punctuation', text: ')', labels: ['Op', 'CallBoundary'] },
    ]),
  })];

  const xml = makeDrawio(nodes, [], { semanticNodes });
  const geometryWidth = (part) => Number(xml.match(new RegExp(
    `id="n1-part-${part}"[^>]*><mxGeometry[^>]+width="([^"]+)"`,
    'u',
  ))?.[1]);
  assert.equal(geometryWidth(2), 37);
  assert.equal(geometryWidth(3), 18);
  assert.equal(geometryWidth(4), 18);
  assert.match(xml, /id="n1-part-1"[^>]+viewBox%3D%22-2%20-2%20124%20128%22/u);
  assert.match(xml, /id="n1-part-1"[^>]+verticalAlign=middle;spacingTop=9/u);
  assert.doesNotMatch(xml, /id="n1-part-1-layer-/u);
  assert.match(xml, /id="n1-part-4"[^>]+%23DAE8FC[^>]+%23007FFF/u);
});

test('long node and mosaic labels grow past former width caps', () => {
  const requestLabel = 'getFeatureValue_CACHED_MAY_BE_STALE(';
  const environmentField = '.CLAUDE_CODE_IDLE_THRESHOLD_MINUTES';
  const nodes = [
    node('fixture.ts:5:1:5:40', ['Request', 'Value', 'Start'], {
      displayX: 0,
      displayY: 0,
      diaName: requestLabel,
    }),
    node('fixture.ts:6:1:6:60', ['Call', 'Op', 'System'], {
      displayX: 0,
      displayY: 1,
      render_parts_layout: 'horizontal',
      render_parts_json: JSON.stringify([
        { kind: 'method', text: 'Number(', labels: ['Call', 'System'] },
        { kind: 'field', text: environmentField },
        { kind: 'punctuation', text: ')' },
      ]),
    }),
  ];

  const xml = makeDrawio(nodes, [], { semanticNodes });
  const requestWidth = Number(xml.match(/id="n1"[^>]*><mxGeometry[^>]+width="([^"]+)"/u)?.[1]);
  const fieldWidth = Number(xml.match(/id="n2-part-2"[^>]*><mxGeometry[^>]+width="([^"]+)"/u)?.[1]);
  assert.ok(requestWidth > 170, `request width must exceed the former 170px cap, got ${requestWidth}`);
  assert.ok(fieldWidth > 220, `field width must exceed the former 220px cap, got ${fieldWidth}`);
  assert.match(xml, /id="n1"[^>]*><mxGeometry[^>]+height="30"/u);
});

test('an object-field vertical evaluation contributes its full SubStep footprint', () => {
  const familyId = 'fixture.ts:30:1:34:2:object';
  const leftId = `${familyId}:brace:left:0`;
  const rightId = `${familyId}:brace:right:0`;
  const computedId = `${familyId}:field:0`;
  const requestId = `${familyId}:field:0:request`;
  const followingId = `${familyId}:field:1`;
  const nodes = [
    node(leftId, ['Object', 'ObjectBrace', 'Open'], {
      displayX: 0, displayY: 0, objectFamilyStableId: familyId,
      objectBraceSide: 'left', objectBracePairIndex: 0,
    }),
    node(rightId, ['Object', 'ObjectBrace', 'Close'], {
      displayX: 3, displayY: 0, objectFamilyStableId: familyId,
      objectBraceSide: 'right', objectBracePairIndex: 0,
    }),
    node(computedId, ['Field', 'Value', 'ValueSlot', 'Assignment', 'Virtual'], {
      displayX: 1, displayY: 0, fieldIndex: 0,
      nestedEvaluationDirection: 'down', diaName: 'querySourceValue',
      render_parts_layout: 'container-overlay',
      render_parts_json: JSON.stringify([
        { kind: 'value-container', text: 'querySourceValue', fillState: 'empty' },
        { kind: 'method', text: 'set', labels: ['Virtual', 'ContainerMethod', 'Set'] },
      ]),
    }),
    node(requestId, ['Request', 'SubStep'], {
      displayX: 1, displayY: 1, diaName: 'getQuerySourceForREPL()',
    }),
    node(followingId, ['Field', 'Value'], {
      displayX: 1, displayY: 2, fieldIndex: 1, diaName: 'onBeforeQuery',
    }),
  ];
  const edges = [
    { start: leftId, end: computedId, type: 'FIELD', props: { fieldIndex: 0 } },
    { start: computedId, end: rightId, type: 'FieldJoin', props: { fieldIndex: 0 } },
    { start: leftId, end: followingId, type: 'FIELD', props: { fieldIndex: 1 } },
    { start: followingId, end: rightId, type: 'FieldJoin', props: { fieldIndex: 1 } },
    { start: computedId, end: requestId, type: 'EVAL', props: {} },
    { start: requestId, end: computedId, type: 'YIELDS_VALUE', props: { protocolRole: 'assignment-return' } },
  ];
  const xml = makeDrawio(nodes, edges, { semanticNodes, suppressFoldingContainers: true });
  const geometry = (stableId) => {
    const match = xml.match(new RegExp(
      `stableId="${stableId}"[\\s\\S]*?<mxGeometry x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`,
      'u',
    ));
    assert.ok(match, `missing geometry for ${stableId}`);
    return { x: Number(match[1]), y: Number(match[2]), width: Number(match[3]), height: Number(match[4]) };
  };
  const request = geometry(requestId);
  const following = geometry(followingId);
  assert.equal(request.height, 30);
  assert.match(xml, /id="n3-part-1"[^>]+sketch-fill/u);
  assert.equal(
    following.y,
    request.y + request.height + 12,
    'the following sibling must reserve the final nested SubStep once, without a stale second gap',
  );
});

test('a wide EVAL target remains on its source row after horizontal sizing', () => {
  const sourceId = 'fixture.ts:7:1:7:20';
  const targetId = 'fixture.ts:7:23:7:90';
  const nodes = [
    node(sourceId, ['Value', 'ValueSlot', 'ValueCreate', 'LocalBinding'], {
      displayX: 0,
      displayY: 0,
      diaName: 'idleThresholdMinutes',
    }),
    node(targetId, ['Call', 'Op', 'System'], {
      displayX: 1,
      displayY: 0,
      render_parts_layout: 'horizontal',
      render_parts_json: JSON.stringify([
        { kind: 'method', text: 'Number(', labels: ['Call', 'System'] },
        { kind: 'value', text: 'process' },
        { kind: 'field', text: '.env' },
        { kind: 'field', text: '.CLAUDE_CODE_IDLE_THRESHOLD_MINUTES' },
        { kind: 'operator', text: '??' },
        { kind: 'literal', text: '75' },
        { kind: 'punctuation', text: ')' },
      ]),
    }),
  ];
  const edges = [{ start: sourceId, end: targetId, type: 'EVAL', props: { stableId: sourceId } }];

  const xml = makeDrawio(nodes, edges, { semanticNodes });
  const geometry = (id) => {
    const match = xml.match(new RegExp(
      `id="${id}"[^>]*><mxGeometry[^>]+x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`,
      'u',
    ));
    return match && { x: Number(match[1]), y: Number(match[2]), width: Number(match[3]), height: Number(match[4]) };
  };
  const source = geometry('n1');
  const target = geometry('n2');
  assert.ok(source && target);
  assert.equal(source.y + source.height / 2, target.y + target.height / 2);
  assert.ok(target.x > source.x + source.width);
});

test('an awaiting collection opens its top box and result labels preserve line breaks', () => {
  const nodes = [node('fixture.ts:5:1:5:30', ['Collection', 'Result', 'Virtual'], {
    displayX: 0,
    displayY: 0,
    diaName: 'parseReferences\nresult',
    render_parts_layout: 'container-overlay-side',
    render_parts_json: JSON.stringify([
      { kind: 'collection-container', text: 'pastedTextRefs', fillState: 'empty' },
      { kind: 'method', text: 'set' },
    ]),
  })];

  const xml = makeDrawio(nodes, [], { semanticNodes });
  const containerCell = decodeURIComponent(xml.match(/<mxCell id="n1-part-1"[^>]+>/u)?.[0] || '');
  assert.match(xml, /id="n1-part-1"[^>]+%23d9aa78/u);
  assert.match(containerCell, /fill="#ffffff" stroke="none"[^>]*><path[^>]+fill="url\(#sketch-fill\)"/u);
  assert.match(containerCell, /M27 17 L115 25 L120 8 L32 0 Z" fill="url\(#sketch-fill\)"\/><path d="M27 17 L115 25 L120 8 L32 0 Z" transform="translate\(0\.45 -0\.3\)"/u);
  assert.match(xml, /id="n1-part-1"[^>]+verticalAlign=middle;spacingTop=9/u);
  assert.match(xml, /sourceSymbol="parseReferences&#xa;result"/u);
});

test('a multiline awaiting result fits its longest line and leaves EVAL from the free bottom port', () => {
  const resultId = 'fixture.ts:5:1:5:40:result';
  const callId = 'fixture.ts:5:1:5:40';
  const nodes = [
    node(resultId, ['Value', 'Result', 'Assignment', 'ContainerMethod', 'Set', 'Virtual'], {
      displayX: 0,
      displayY: 0,
      nested_evaluation_direction: 'down',
      render_parts_layout: 'container-overlay-side',
      render_parts_json: JSON.stringify([
        { stableId: `${resultId}:container`, kind: 'value-container', text: 'prependModeCharacterToInput\nresult', fillState: 'empty' },
        { stableId: `${resultId}:set`, kind: 'method', text: 'set' },
      ]),
    }),
    node(callId, ['Call', 'Start'], { displayX: 0, displayY: 1 }),
  ];
  const edges = [
    { start: resultId, end: callId, type: 'EVAL', props: { displayLabel: 'eval' } },
    {
      start: callId,
      end: resultId,
      type: 'RESULT',
      props: { displayLabel: 'value', targetRenderPartStableId: `${resultId}:set` },
    },
  ];

  const xml = makeDrawio(nodes, edges, { semanticNodes });
  assert.match(xml, /id="n1-part-1"[\s\S]*?<mxGeometry x="0" y="0" width="201" height="50"/u);
  assert.match(xml, /<mxCell(?=[^>]+edgeType="EVAL")(?=[^>]+exitX=0\.5;exitY=1;)[^>]+>/u);
  assert.match(xml, /<mxCell(?=[^>]+edgeType="RESULT")(?=[^>]+target="n1-part-2")[^>]+>/u);
});

test('a DataBranch awaiting result occupies the next visual grade below its predicate', () => {
  const resultId = 'fixture.ts:5:1:5:40:result';
  const callId = 'fixture.ts:5:1:5:40';
  const closureId = 'fixture.ts:5:39:5:40';
  const branchId = 'fixture.ts:4:1:4:20';
  const nodes = [
    node(resultId, ['Value', 'Result', 'ResultTarget', 'Assignment', 'ContainerMethod', 'Set', 'Virtual'], {
      displayX: 0,
      displayY: 0,
      sourceCallStableId: callId,
      render_parts_layout: 'container-overlay-side',
      render_parts_json: JSON.stringify([
        { stableId: `${resultId}:container`, kind: 'value-container', text: 'computed\nresult', fillState: 'empty' },
        { stableId: `${resultId}:set`, kind: 'method', text: 'set' },
      ]),
    }),
    node(branchId, ['Branch', 'Field', 'Data'], { displayX: 0, displayY: 0 }),
    node(callId, ['Call', 'Start'], { displayX: 2, displayY: 3 }),
    node(closureId, ['Call', 'End'], {
      displayX: 4,
      displayY: 3,
      sourceCallStableId: callId,
      diaName: ')',
    }),
  ];
  const edges = [
    { start: branchId, end: resultId, type: 'FALSE', props: {} },
    { start: resultId, end: callId, type: 'EVAL', props: {} },
    {
      start: closureId,
      end: resultId,
      type: 'RESULT',
      props: { targetRenderPartStableId: `${resultId}:set` },
    },
  ];

  const xml = makeDrawio(nodes, edges, { semanticNodes, suppressFoldingContainers: true });
  const geometry = (id) => {
    const cell = xml.match(new RegExp(`<mxCell id="${id}"[\\s\\S]*?<\\/mxCell>`, 'u'))?.[0] || '';
    const match = cell.match(/<mxGeometry(?: x="([^"]+)")?(?: y="([^"]+)")? width="([^"]+)" height="([^"]+)"/u);
    assert.ok(match, `geometry not found: ${id}`);
    return {
      x: Number(match[1] || 0),
      y: Number(match[2] || 0),
      width: Number(match[3]),
      height: Number(match[4]),
    };
  };
  const result = geometry('n1');
  const branch = geometry('n2');
  assert.equal(result.y, branch.y + 60);
});

test('a closing parenthesis is a blue call tile even without generated call labels', () => {
  const nodes = [node('fixture.ts:6:1:6:20', ['Op'], {
    displayX: 0,
    displayY: 0,
    render_parts_layout: 'horizontal',
    render_parts_json: JSON.stringify([
      { kind: 'value', text: 'value' },
      { kind: 'punctuation', text: ')' },
    ]),
  })];

  const xml = makeDrawio(nodes, [], { semanticNodes });
  assert.match(xml, /id="n1-part-2"[^>]+%23DAE8FC[^>]+%23007FFF/u);
});

test('FlowJoin nodes use the blue control palette', () => {
  const nodes = [node('fixture.ts:6:30:6:31', ['Flow', 'Join'], {
    displayX: 0,
    displayY: 0,
  })];

  const xml = makeDrawio(nodes, [], { semanticNodes });
  assert.match(xml, /id="n1"[^>]+rhombus;[^>]+fillColor=#DAE8FC;strokeColor=#007FFF/u);
});

test('FunctionEnd stays below a detached terminal FlowJoin after folding', () => {
  const localStepId = 'flow-step:statement:fixture.ts:7:1:7:20';
  const sourceId = 'fixture.ts:7:1:7:20';
  const joinId = 'fixture.ts:8:1:8:2';
  const endId = 'fixture.ts:9:1:9:2:end';
  const nodes = [
    node(sourceId, ['Call', 'Method'], {
      parentStepStableId: localStepId,
      parentFlowBlockStableId: '',
      displayX: 0,
      displayY: 0,
    }),
    node(joinId, ['Join', 'Flow', 'Exclusive'], {
      parentStepStableId: '',
      parentFlowBlockStableId: '',
      displayX: 0,
      displayY: 1,
      flowJoinBackboneSourceStableId: sourceId,
      flowJoinPlacementSourceStableId: sourceId,
    }),
    node(endId, ['FunctionEnd'], {
      parentStepStableId: '',
      parentFlowBlockStableId: '',
      displayX: 0,
      displayY: 2,
    }),
  ];
  const xml = makeDrawio(nodes, [
    { start: sourceId, end: joinId, type: 'REJOINS', props: {} },
    { start: joinId, end: endId, type: 'NEXT', props: {} },
  ], {
    semanticNodes: [{
      key: localStepId,
      labels: ['Step'],
      props: { headStableIds: [sourceId], tailStableIds: [sourceId] },
    }],
  });
  const detachedGeometry = (cellId) => {
    const match = xml.match(new RegExp(
      `<mxCell id="${cellId}"[^>]+parent="fold-layout-root"[^>]*>[\\s\\S]*?<mxGeometry x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`,
      'u',
    ));
    assert.ok(match, `detached geometry not found: ${cellId}`);
    const [, x, y, width, height] = match.map(Number);
    return { x, y, width, height };
  };
  const join = detachedGeometry('n2');
  const end = detachedGeometry('n3');
  assert.ok(end.y >= join.y + join.height);
  assert.equal(end.x + end.width / 2, join.x + join.width / 2);
});

test('an earlier else-if body bypasses the remaining alternatives on the left', () => {
  const sourceId = 'fixture.ts:10:3:10:18';
  const joinId = 'fixture.ts:20:1:20:2';
  const source = node(sourceId, ['Call', 'Method'], { displayX: 1, displayY: 0 });
  const join = node(joinId, ['Join', 'Flow', 'Exclusive'], { displayX: 0, displayY: 4 });
  const xml = makeDrawio([source, join], [{
    start: sourceId,
    end: joinId,
    type: 'REJOINS',
    props: { flowLayer: 'control', elseIfChainBypass: true },
  }], { semanticNodes, suppressFoldingContainers: true });
  const sourceGeometry = xml.match(/id="n1"[\s\S]*?<mxGeometry x="([\d.]+)"/u);
  const joinGeometry = xml.match(/id="n2"[\s\S]*?<mxGeometry x="([\d.]+)"/u);
  const edgeXml = xml.match(/<mxCell(?=[^>]+edgeType="REJOINS")[\s\S]*?<\/mxCell>/u)?.[0] || '';
  const routeXs = [...edgeXml.matchAll(/<mxPoint x="([\d.]+)"/gu)].map((match) => Number(match[1]));
  assert.match(edgeXml, /exitX=0;exitY=0\.5/u);
  assert.match(edgeXml, /entryX=0;entryY=0\.5/u);
  assert.equal(routeXs.length, 2);
  assert.ok(sourceGeometry && joinGeometry);
  assert.ok(routeXs.every((x) => x < Number(sourceGeometry[1]) && x < Number(joinGeometry[1])));
});

test('an optional-flow join keeps its naturally calculated lane while same-flow convergence follows its backbone', () => {
  const localStepId = 'flow-step:condition:fixture.ts:10:1:14:1';
  const remoteId = 'fixture.ts:10:1:10:20';
  const commandId = 'fixture.ts:11:1:11:20';
  const terminalPredicateId = 'fixture.ts:12:1:12:20';
  const sideJoinId = 'fixture.ts:13:1:13:2';
  const terminalJoinId = 'fixture.ts:14:1:14:2';
  const localNode = (id, labels, displayX, displayY, extra = {}) => ({
    id,
    labels,
    props: {
      label: id,
      parentFnStableId: 'fixture.ts:1:1:20:1',
      parentStepStableId: localStepId,
      flowStepOrder: 0,
      displayX,
      displayY,
      ...extra,
    },
  });
  const nodes = [
    localNode(remoteId, ['Branch', 'Flow'], 0, 0, { flowLaneStableId: 'flow:main' }),
    localNode(commandId, ['Branch', 'Flow'], 1, 1, { flowLaneStableId: 'flow:optional' }),
    localNode(terminalPredicateId, ['Branch', 'Flow'], 1, 4, { flowLaneStableId: 'flow:optional' }),
    localNode(sideJoinId, ['Join', 'Flow', 'Exclusive'], 1, 5, {
      incoming_edge_types: 'FALSE,FALSE',
      flowJoinBackboneSourceStableId: remoteId,
      flowJoinPlacementSourceStableId: terminalPredicateId,
      flowLaneStableId: 'flow:optional',
    }),
    localNode(terminalJoinId, ['Join', 'Flow', 'Exclusive'], 0, 5, {
      flowJoinBackboneSourceStableId: commandId,
      flowJoinPlacementSourceStableId: terminalPredicateId,
      inlineStepTerminalJoin: true,
    }),
  ];
  const xml = makeDrawio(nodes, [], {
    semanticNodes: [{
      key: localStepId,
      labels: ['Step'],
      props: { headStableIds: [remoteId], tailStableIds: [sideJoinId, terminalJoinId] },
    }],
    suppressFoldingContainers: true,
  });
  const geometry = (cellId) => {
    const match = xml.match(new RegExp(
      `<mxCell id="${cellId}"[^>]*>[\\s\\S]*?<mxGeometry x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`,
      'u',
    ));
    assert.ok(match, `geometry not found: ${cellId}`);
    const [, x, y, width, height] = match.map(Number);
    return { x, y, width, height };
  };
  const centerX = (box) => box.x + box.width / 2;
  const centerY = (box) => box.y + box.height / 2;
  const remote = geometry('n1');
  const command = geometry('n2');
  const terminalPredicate = geometry('n3');
  const sideJoin = geometry('n4');
  const terminalJoin = geometry('n5');
  assert.equal(centerX(sideJoin), centerX(terminalPredicate));
  assert.equal(centerY(sideJoin), centerY(terminalPredicate));
  assert.equal(centerX(terminalJoin), centerX(command));
  assert.ok(centerY(terminalJoin) > centerY(terminalPredicate));
});

test('a FlowJoin moves onto an incoming backbone axis instead of shifting its top port', () => {
  const stepId = 'flow-step:condition:fixture.ts:20:1:22:1';
  const predicateId = 'fixture.ts:20:1:20:20';
  const terminalPredicateId = 'fixture.ts:21:1:21:20';
  const trueJoinId = 'fixture.ts:21:20:21:21';
  const continuationId = 'fixture.ts:22:1:22:20';
  const nodes = [
    node(predicateId, ['Branch', 'Flow'], { displayX: 0, displayY: 0, parentStepStableId: stepId, parentFlowBlockStableId: '' }),
    node(terminalPredicateId, ['Branch', 'Flow'], { displayX: 0, displayY: 1, parentStepStableId: stepId, parentFlowBlockStableId: '' }),
    node(trueJoinId, ['Join', 'Flow', 'Exclusive'], {
      displayX: 1,
      displayY: 2,
      parentStepStableId: stepId,
      parentFlowBlockStableId: '',
      incoming_edge_types: 'TRUE,TRUE',
      flowJoinBackboneSourceStableId: predicateId,
      flowJoinPlacementSourceStableId: terminalPredicateId,
      inlineStepTerminalJoin: true,
      hybridVisualRole: 'submethod-dependent',
    }),
    node(continuationId, ['Call'], { displayX: 2, displayY: 3, parentStepStableId: stepId, parentFlowBlockStableId: '' }),
  ];
  const xml = makeDrawio(nodes, [{ start: trueJoinId, end: continuationId, type: 'NEXT', props: {} }], {
    semanticNodes: [{
      key: stepId,
      labels: ['Step'],
      props: { headStableIds: [predicateId], tailStableIds: [trueJoinId] },
    }],
    suppressFoldingContainers: true,
  });
  const centerX = (cellId) => {
    const match = xml.match(new RegExp(
      `<mxCell id="${cellId}"[^>]*>[\\s\\S]*?<mxGeometry x="([^"]+)"[^>]+width="([^"]+)"`,
      'u',
    ));
    return Number(match?.[1]) + Number(match?.[2]) / 2;
  };
  assert.equal(centerX('n3'), centerX('n1'));
  assert.equal(centerX('n3'), centerX('n2'));
  const joinGeometry = xml.match(/id="n3"[\s\S]*?<mxGeometry x="[^"]+" y="[^"]+" width="([^"]+)" height="([^"]+)"/u);
  assert.deepEqual(joinGeometry?.slice(1).map(Number), [42, 42]);
});

test('a FlowJoin entering another visual column moves onto the active destination axis', () => {
  const joinId = 'fixture.ts:30:1:30:2';
  const backboneId = 'fixture.ts:29:1:29:10';
  const providerId = 'fixture.ts:31:1:31:30';
  const remoteJoinId = 'fixture.ts:32:1:32:2';
  const nodes = [
    node(backboneId, ['Branch', 'Flow'], { displayX: 0, displayY: 0 }),
    node(joinId, ['Join', 'Flow', 'Exclusive'], {
      displayX: 0,
      displayY: 1,
      flowJoinBackboneSourceStableId: backboneId,
      flowJoinPlacementSourceStableId: backboneId,
    }),
    node(providerId, ['Call', 'OperationProvider'], {
      displayX: 2,
      displayY: 2,
      renderPartsLayout: 'container-overlay-side',
      renderPartsJson: JSON.stringify([
        { stableId: 'provider', text: 'proactiveModule', kind: 'operation-provider-container', labels: ['OperationProvider'] },
        { stableId: 'method', text: 'resumeProactive()', kind: 'method', labels: ['Call', 'Method'] },
      ]),
    }),
    node(remoteJoinId, ['Join', 'Flow', 'Exclusive'], { displayX: 0, displayY: 3 }),
  ];
  const edges = [
    { start: joinId, end: providerId, type: 'NEXT', props: { targetRenderPartStableId: 'method' } },
    { start: providerId, end: remoteJoinId, type: 'REJOINS', props: { sourceRenderPartStableId: 'method' } },
  ];
  const xml = makeDrawio(nodes, edges, { semanticNodes, suppressFoldingContainers: true });
  const geometry = (cellId) => {
    const match = xml.match(new RegExp(`<mxCell id="${cellId}"[^>]*>[\\s\\S]*?<mxGeometry x="([^"]+)"[^>]+width="([^"]+)"`, 'u'));
    assert.ok(match, `geometry not found: ${cellId}`);
    return { x: Number(match[1]), width: Number(match[2]) };
  };
  const join = geometry('n2');
  const provider = geometry('n3');
  const method = geometry('n3-part-2');
  assert.equal(join.x + join.width / 2, provider.x + method.x + method.width / 2);
});

test('Flow predicate mosaics route their downward false outcome from the whole hexagon bottom', () => {
  const predicateId = 'fixture.ts:40:1:40:30';
  const rightJoinId = 'fixture.ts:40:31:40:32';
  const lowerJoinId = 'fixture.ts:41:1:41:2';
  const predicate = node(predicateId, ['Branch', 'Flow', 'PredicateOperator'], {
    displayX: 0,
    displayY: 0,
    renderPartsLayout: 'horizontal',
    renderPartsJson: JSON.stringify([
      { stableId: 'receiver', text: 'feature(', kind: 'method', labels: ['Call', 'Method'] },
      { stableId: 'argument', text: "'KAIROS'", kind: 'literal', labels: ['Literal'] },
      { stableId: 'close', text: ')', kind: 'method-close', labels: ['CallBoundary'] },
    ]),
  });
  const xml = makeDrawio([
    predicate,
    node(rightJoinId, ['Join', 'Flow'], { displayX: 1, displayY: 0 }),
    node(lowerJoinId, ['Join', 'Flow'], { displayX: 0, displayY: 2 }),
  ], [
    { start: predicateId, end: rightJoinId, type: 'TRUE', props: { flowLayer: 'control', sourceRenderPartStableId: 'close' } },
    { start: predicateId, end: lowerJoinId, type: 'FALSE', props: { flowLayer: 'control', sourceRenderPartStableId: 'close' } },
  ], { semanticNodes, suppressFoldingContainers: true });
  const falseEdge = xml.match(/<mxCell(?=[^>]+edgeType="FALSE")[^>]+>/u)?.[0] || '';
  assert.match(falseEdge, /source="n1"/u);
  assert.match(falseEdge, /exitX=0\.5;exitY=1/u);
});

test('Flow Branch outcomes use distinct standard source ports selected by route distance', () => {
  const predicateId = 'fixture.ts:42:20:42:50';
  const leftJoinId = 'fixture.ts:43:1:43:2';
  const lowerBodyId = 'fixture.ts:44:20:44:40';
  const predicate = node(predicateId, ['Branch', 'Flow', 'PredicateOperator'], {
    displayX: 1,
    displayY: 0,
    renderPartsLayout: 'horizontal',
    renderPartsJson: JSON.stringify([
      { stableId: 'receiver', text: 'startsWith(', kind: 'method', labels: ['Call', 'Method'] },
      { stableId: 'argument', text: "'/'", kind: 'literal', labels: ['Literal'] },
      { stableId: 'close', text: ')', kind: 'method-close', labels: ['CallBoundary'] },
    ]),
  });
  const xml = makeDrawio([
    predicate,
    node(leftJoinId, ['Join', 'Flow'], { displayX: 0, displayY: 1 }),
    node(lowerBodyId, ['Call', 'Method'], { displayX: 1, displayY: 2 }),
  ], [
    { start: predicateId, end: leftJoinId, type: 'FALSE', props: { flowLayer: 'control' } },
    { start: predicateId, end: lowerBodyId, type: 'TRUE', props: { flowLayer: 'control' } },
  ], { semanticNodes, suppressFoldingContainers: true });
  const falseEdge = xml.match(/<mxCell(?=[^>]+edgeType="FALSE")[^>]+>/u)?.[0] || '';
  const trueEdge = xml.match(/<mxCell(?=[^>]+edgeType="TRUE")[^>]+>/u)?.[0] || '';

  assert.match(falseEdge, /exitX=0;exitY=0\.5/u);
  assert.match(trueEdge, /exitX=1;exitY=0\.5/u);
  assert.doesNotMatch(`${falseEdge}${trueEdge}`, /exitX=0\.(?!5(?:;|"))\d+/u);
});

test('FlowJoins align with the routed levels of shared lateral entries', () => {
  const stepId = 'flow-step:condition:fixture.ts:30:1:35:1';
  const outerBackboneId = 'fixture.ts:30:1:30:20';
  const innerBackboneId = 'fixture.ts:31:1:31:20';
  const lateralId = 'fixture.ts:34:1:34:20';
  const outerJoinId = 'fixture.ts:35:1:35:2';
  const innerJoinId = 'fixture.ts:35:3:35:4';
  const nodes = [
    node(outerBackboneId, ['Branch', 'Flow'], { displayX: 0, displayY: 0, parentStepStableId: stepId, parentFlowBlockStableId: '' }),
    node(innerBackboneId, ['Branch', 'Flow'], { displayX: 1, displayY: 1, parentStepStableId: stepId, parentFlowBlockStableId: '' }),
    node(lateralId, ['Branch', 'Flow'], { displayX: 2, displayY: 4, parentStepStableId: stepId, parentFlowBlockStableId: '' }),
    node(outerJoinId, ['Join', 'Flow', 'Exclusive'], {
      displayX: 0,
      displayY: 6,
      parentStepStableId: stepId,
      parentFlowBlockStableId: '',
      incoming_edge_types: 'FALSE,TRUE',
      flowJoinBackboneSourceStableId: outerBackboneId,
      flowJoinPlacementSourceStableId: lateralId,
      inlineStepTerminalJoin: true,
    }),
    node(innerJoinId, ['Join', 'Flow', 'Exclusive'], {
      displayX: 1,
      displayY: 6,
      parentStepStableId: stepId,
      parentFlowBlockStableId: '',
      incoming_edge_types: 'FALSE,FALSE',
      flowJoinBackboneSourceStableId: innerBackboneId,
      flowJoinPlacementSourceStableId: lateralId,
      inlineStepTerminalJoin: true,
    }),
  ];
  const edges = [
    { start: outerBackboneId, end: outerJoinId, type: 'FALSE', props: {} },
    { start: innerBackboneId, end: innerJoinId, type: 'FALSE', props: {} },
    { start: lateralId, end: outerJoinId, type: 'TRUE', props: {} },
    { start: lateralId, end: innerJoinId, type: 'FALSE', props: {} },
  ];
  const xml = makeDrawio(nodes, edges, {
    semanticNodes: [{
      key: stepId,
      labels: ['Step'],
      props: { headStableIds: [outerBackboneId], tailStableIds: [outerJoinId, innerJoinId] },
    }],
    suppressFoldingContainers: true,
  });
  const geometry = (cellId) => {
    const match = xml.match(new RegExp(
      `<mxCell id="${cellId}"[^>]*>[\\s\\S]*?<mxGeometry x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`,
      'u',
    ));
    assert.ok(match, `geometry not found: ${cellId}`);
    const [, x, y, width, height] = match.map(Number);
    return { x, y, width, height };
  };
  const centerY = (box) => box.y + box.height / 2;
  const lateral = geometry('n3');
  assert.equal(centerY(geometry('n4')), centerY(lateral));
  assert.equal(centerY(geometry('n5')), lateral.y + lateral.height + 23);
  const outerEntry = xml.match(/<mxCell id="e\d+"[^>]+source="n3" target="n4"[^>]+>/u)?.[0] || '';
  const innerEntry = xml.match(/<mxCell id="e\d+"[^>]+source="n3" target="n5"[^>]+>/u)?.[0] || '';
  assert.match(outerEntry, /exitX=0;exitY=0\.5/u);
  assert.match(outerEntry, /entryX=1;entryY=0\.5/u);
  assert.match(innerEntry, /exitX=0\.5;exitY=1/u);
  assert.match(innerEntry, /entryX=1;entryY=0\.5/u);
});

test('a lateral FlowJoin entry reaches the Join vertical before descending to its row', () => {
  const sourceId = 'fixture.ts:50:1:50:20';
  const lowerSourceId = 'fixture.ts:54:1:54:20';
  const backboneId = 'fixture.ts:49:1:49:20';
  const joinId = 'fixture.ts:55:1:55:2';
  const nodes = [
    node(backboneId, ['Branch', 'Flow'], { displayX: 0, displayY: 0 }),
    node(sourceId, ['Branch', 'Flow'], { displayX: 2, displayY: 1 }),
    node(lowerSourceId, ['Branch', 'Flow'], { displayX: 2, displayY: 5 }),
    node(joinId, ['Join', 'Flow', 'Exclusive'], {
      displayX: 0,
      displayY: 5,
      flowJoinBackboneSourceStableId: backboneId,
    }),
  ];
  const xml = makeDrawio(nodes, [
    { start: sourceId, end: joinId, type: 'FALSE', props: {} },
    { start: lowerSourceId, end: joinId, type: 'FALSE', props: {} },
  ], { semanticNodes, suppressFoldingContainers: true });
  const edge = xml.match(/<mxCell(?=[^>]+edgeType="FALSE")[\s\S]*?<\/mxCell>/u)?.[0] || '';
  const points = [...edge.matchAll(/<mxPoint x="([^"]+)" y="([^"]+)"/gu)]
    .map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));

  assert.ok(points.length >= 3, `the lateral Join route must keep its coordinated bends: ${edge}`);
  assert.match(edge, /entryX=0\.5;entryY=0/u);
  assert.equal(points[0].y, points[1].y, 'the route must leave its source horizontally');
  assert.equal(points[1].x, points[2].x, 'the route must then descend on the Join entry vertical');
});

test('virtual collection methods and their result collections use sketch SVGs', () => {
  const nodes = [node('fixture.ts:6:40:6:70:result', [
    'Op',
    'Method',
    'Value',
    'Collection',
    'Result',
    'Virtual',
    'SemanticExpansion',
    'Primitive',
    'ContainerMethod',
    'Shift',
  ], {
    displayX: 0,
    displayY: 0,
    render_parts_layout: 'container-overlay-side',
    render_parts_json: JSON.stringify([
      { kind: 'collection-container', text: 'result' },
      { kind: 'method', text: 'shift(', labels: ['Method'] },
      { kind: 'punctuation', text: ')', labels: ['CallBoundary'] },
    ]),
  })];

  const xml = makeDrawio(nodes, [], { semanticNodes });
  const collectionCell = xml.match(/<mxCell id="n1-part-1"[^>]+>/u)?.[0] || '';
  assert.match(collectionCell, /sketch-fill/u);
  const encodedCollectionSvg = collectionCell.match(/image=data:image\/svg\+xml,([^;]+);/u)?.[1] || '';
  const collectionSvg = decodeURIComponent(encodedCollectionSvg.replace(/&#39;/gu, "'"));
  assert.equal(
    [...collectionSvg.matchAll(/opacity="0\.45"/gu)].length,
    3,
    'each closed collection layer roughens before the following opaque layer hides its rear edges',
  );
  assert.match(xml, /id="n1-part-2"[^>]+clipPath/u);
  assert.match(xml, /id="n1-part-2"[^>]+%2399CCFF[^>]+%23007FFF/u);
  assert.match(xml, /id="n1-part-3"[^>]+clipPath/u);
});

test('a spread collection uses a solid stack with a purple diagonal spread tile', () => {
  const nodes = [node('fixture.ts:6:71:6:79', [
    'Arg',
    'Collection',
    'Spread',
    'Value',
    'ValueRead',
  ], {
    displayX: 0,
    displayY: 0,
    render_parts_layout: 'container-overlay-side',
    render_parts_json: JSON.stringify([
      { kind: 'collection-container', text: 'prev', fillState: 'filled' },
      { kind: 'operator', text: '...', labels: ['Op', 'Spread', 'SystemSpread'] },
    ]),
  })];

  const xml = makeDrawio(nodes, [], { semanticNodes });
  const collectionCell = xml.match(/<mxCell id="n1-part-1"[^>]+>/u)?.[0] || '';
  const spreadCell = xml.match(/<mxCell id="n1-part-2"[^>]+>/u)?.[0] || '';
  assert.match(collectionCell, /%23ffe6cc/iu);
  assert.doesNotMatch(collectionCell, /sketch-fill/u);
  assert.match(spreadCell, /%23E1D5E7/u);
  assert.match(spreadCell, /%239673A6/u);
});

test('a curved terminal method tile reserves its side depth beyond the text width', () => {
  const nodes = [node('fixture.ts:6:80:6:120', ['Call', 'Method'], {
    displayX: 0,
    displayY: 0,
    render_parts_layout: 'horizontal',
    render_parts_json: JSON.stringify([
      { kind: 'punctuation', text: 'await', labels: ['Keyword', 'System'] },
      { kind: 'value', text: 'activeRemote', labels: ['FieldAccess'] },
      { kind: 'method', text: 'sendMessage(', labels: ['Method'] },
    ]),
  })];

  const xml = makeDrawio(nodes, [], { semanticNodes });
  assert.match(xml, /id="n1-part-3"[\s\S]+?<mxGeometry x="123" y="0" width="95" height="30"/u);
});

test('standalone virtual result variables use sharp variable rectangles', () => {
  const nodes = [node('fixture.ts:6:80:6:90:result', [
    'Value',
    'Variable',
    'Result',
    'Virtual',
    'SemanticExpansion',
    'Primitive',
  ], {
    displayX: 0,
    displayY: 0,
    diaName: 'result',
  })];

  const xml = makeDrawio(nodes, [], { semanticNodes });
  assert.match(xml, /id="n1"[^>]+rounded=0[^>]+fillColor=#FFE6CC[^>]+strokeColor=#BE7000/u);
});

test('virtual result arguments inside assignment mosaics use sketch fills', () => {
  const nodes = [node('fixture.ts:6:91:6:100', [
    'Value',
    'Assignment',
    'ContainerMethod',
    'Set',
  ], {
    displayX: 0,
    displayY: 0,
    render_parts_layout: 'container-overlay-side',
    render_parts_json: JSON.stringify([
      { kind: 'value-container', text: 'target', fillState: 'empty' },
      { kind: 'method', text: 'set(', labels: ['Method', 'ContainerMethod'] },
      { kind: 'virtual-value', text: 'result', labels: ['Value', 'Result', 'Virtual'] },
      { kind: 'punctuation', text: ')', labels: ['CallBoundary'] },
    ]),
  })];

  const xml = makeDrawio(nodes, [], { semanticNodes });
  assert.match(xml, /id="n1-part-3"[^>]+clipPath/u);
  assert.match(xml, /id="n1-part-3"[^>]+%23FFE6CC[^>]+%23BE7000/u);
});

test('real callback parameters stay solid inside virtual set mosaics', () => {
  const nodes = [node('fixture.ts:6:101:6:120', [
    'Value',
    'Assignment',
    'ContainerMethod',
    'Set',
    'SemanticExpansion',
    'Primitive',
  ], {
    displayX: 0,
    displayY: 0,
    render_parts_layout: 'container-overlay-side',
    render_parts_json: JSON.stringify([
      { kind: 'value-container', text: 'matchingCommand', fillState: 'empty' },
      { kind: 'method', text: 'set(', labels: ['Method', 'ContainerMethod'] },
      { kind: 'value', text: 'cmd', labels: ['Value', 'Occurrence', 'Iteration'] },
      { kind: 'punctuation', text: ')', labels: ['CallBoundary'] },
    ]),
  })];

  const xml = makeDrawio(nodes, [], { semanticNodes });
  assert.match(xml, /id="n1-part-2"[^>]+clipPath/u);
  assert.match(xml, /id="n1-part-4"[^>]+clipPath/u);
  assert.match(xml, /id="n1-part-3"[^>]+%23FFE6CC[^>]+%23BE7000/u);
  assert.doesNotMatch(xml, /id="n1-part-3"[^>]+clipPath/u);
});

test('standalone variables use sharp rectangles while NEXT and value routes use their semantic colors', () => {
  const emptyId = 'fixture.ts:7:1:7:10';
  const readyId = 'fixture.ts:7:20:7:30';
  const callId = 'fixture.ts:7:40:7:50';
  const nodes = [
    node(emptyId, ['Value', 'ValueSlot', 'Variable'], { displayX: 0, displayY: 0, diaName: 'pending' }),
    node(readyId, ['Value', 'ComputedValue', 'Variable'], { displayX: 1, displayY: 0, diaName: 'ready' }),
    node(callId, ['Call', 'Start'], { displayX: 2, displayY: 0, diaName: 'run' }),
  ];
  const edges = [
    { start: emptyId, end: callId, type: 'NEXT', props: { flowLayer: 'control' } },
    { start: readyId, end: emptyId, type: 'YIELDS_VALUE', props: { flowLayer: 'data' } },
  ];

  const xml = makeDrawio(nodes, edges, { semanticNodes });
  assert.match(xml, /id="n1"[^>]+rounded=0[^>]+fillColor=#ffffff[^>]+stableId="fixture.ts:7:1:7:10"/u);
  assert.match(xml, /id="n2"[^>]+rounded=0[^>]+fillColor=#FFE6CC[^>]+stableId="fixture.ts:7:20:7:30"/u);
  assert.match(xml, /id="n3"[^>]+shape=image;[^>]+%23DAE8FC[^>]+%23007FFF[^>]+stableId="fixture.ts:7:40:7:50"/u);
  assert.match(xml, /id="n3"[^>]*>[\s\S]*?<mxGeometry[^>]+height="30"/u);
  assert.match(xml, /strokeColor=#007FFF[^>]+edgeType="NEXT"/u);
  assert.match(xml, /strokeColor=#BE7000[^>]+edgeType="YIELDS_VALUE"/u);
});

test('named ARG and FIELD slots are italic and ARG enters a horizontal mosaic from the left', () => {
  const callId = 'fixture.ts:8:1:8:12';
  const argumentId = 'fixture.ts:8:20:8:42';
  const nodes = [
    node(callId, ['Call', 'Start'], {
      displayX: 0,
      displayY: 0,
      diaName: 'send(',
    }),
    node(argumentId, ['Arg', 'Object', 'CompactObject'], {
      displayX: 1,
      displayY: 1,
      render_parts_layout: 'horizontal',
      render_parts_json: JSON.stringify([
        { kind: 'punctuation', text: '{', labels: ['Object', 'Open'] },
        { kind: 'punctuation', text: 'uuid:', labels: ['Object', 'Field', 'FieldName'] },
        { kind: 'value', text: 'message.uuid', labels: ['Value', 'ValueAccess'] },
        { kind: 'punctuation', text: '}', labels: ['Object', 'Close'] },
      ]),
    }),
  ];
  const edges = [{
    start: callId,
    end: argumentId,
    type: 'ARG',
    props: { flowLayer: 'data', displayLabel: 'opts', argumentName: 'opts' },
  }];

  const xml = makeDrawio(nodes, edges, { semanticNodes, suppressFoldingContainers: true });
  assert.match(xml, /id="n2-part-2"[^>]+fontStyle=2/u);
  assert.match(xml, /value="opts"[^>]+fontStyle=2[^>]+entryX=0;entryY=0\.5/u);
});

test('slot labels matching passed objects or their terminal fields are omitted before family sizing', () => {
  const callId = 'fixture.ts:8:50:8:62';
  const argumentId = 'fixture.ts:8:70:8:105';
  const nodes = [
    node(callId, ['Call', 'Start'], {
      displayX: 0,
      displayY: 0,
      diaName: 'accept(',
    }),
    node(argumentId, ['Arg', 'ValueAccess'], {
      displayX: 1,
      displayY: 1,
      render_parts_layout: 'horizontal',
      render_parts_json: JSON.stringify([
        { kind: 'value', text: 'speculationAccept', labels: ['Value', 'ValueAccess'] },
        { kind: 'field', text: '.setAppState', labels: ['Field', 'ValueAccess'] },
      ]),
    }),
  ];
  const render = (displayLabel) => makeDrawio(nodes, [{
    start: callId,
    end: argumentId,
    type: 'ARG',
    props: { flowLayer: 'data', displayLabel, argumentName: 'setAppState' },
  }], { semanticNodes, suppressFoldingContainers: true });

  const redundantXml = render('setAppState');
  const blankXml = render('');
  const redundantEdge = redundantXml.match(/<mxCell id="e1"[\s\S]*?<\/mxCell>/u)?.[0] || '';
  assert.match(redundantEdge, /value=""/u);
  assert.match(redundantEdge, /argumentName="setAppState"/u);
  assert.doesNotMatch(redundantEdge, /fontStyle=2/u);

  const geometry = (xml) => xml.match(/id="n2"[\s\S]*?<mxGeometry x="([^"]+)" y="([^"]+)" width="([^"]+)"/u)?.slice(1);
  assert.deepEqual(geometry(redundantXml), geometry(blankXml));

  const objectId = 'fixture.ts:8:110:8:122';
  const fieldId = 'fixture.ts:8:125:8:138';
  const fieldXml = makeDrawio([
    node(objectId, ['Object', 'Open'], { displayX: 0, displayY: 0, diaName: '{' }),
    node(fieldId, ['Field', 'ValueAccess'], { displayX: 1, displayY: 0, diaName: 'attribution' }),
  ], [{
    start: objectId,
    end: fieldId,
    type: 'FIELD',
    props: { flowLayer: 'data', displayLabel: 'attribution', fieldName: 'attribution' },
  }], { semanticNodes, suppressFoldingContainers: true });
  const fieldEdge = fieldXml.match(/<mxCell id="e1"[\s\S]*?<\/mxCell>/u)?.[0] || '';
  assert.match(fieldEdge, /value=""/u);
  assert.match(fieldEdge, /fieldName="attribution"/u);
});

test('producer returns bypass only their extractor-bounded SubStep', () => {
  const assignmentId = 'fixture.ts:10:1:10:10';
  const localId = 'fixture.ts:10:20:10:30';
  const producerId = 'fixture.ts:10:40:10:50';
  const laterId = 'fixture.ts:11:1:11:10';
  const nodes = [
    node(assignmentId, ['Value', 'Assignment', 'ContainerMethod', 'Set'], {
      displayX: 0,
      displayY: 0,
      operationIndex: 10,
    }),
    node(localId, ['Op'], { displayX: 1, displayY: 1, operationIndex: 11 }),
    node(producerId, ['Op'], { displayX: 2, displayY: 1, operationIndex: 12 }),
    node(laterId, ['Op'], { displayX: 1, displayY: 5, operationIndex: 20 }),
  ];
  const edges = [{
    start: producerId,
    end: assignmentId,
    type: 'ASSIGNS_VALUE',
    props: {
      flowLayer: 'data',
      producerRouteRole: 'return-bottom',
      producerScopeStartOrder: 10,
      producerScopeEndOrder: 12,
    },
  }];

  const xml = makeDrawio(nodes, edges, { semanticNodes, suppressFoldingContainers: true });
  const edgeCell = xml.match(/<mxCell id="e1"[\s\S]*?<\/mxCell>/u)?.[0] || '';
  const routeY = Number(edgeCell.match(/<mxPoint x="[^"]+" y="([^"]+)"/u)?.[1]);
  const laterY = Number(xml.match(/id="n4"[\s\S]*?<mxGeometry x="[^"]+" y="([^"]+)"/u)?.[1]);
  assert.ok(Number.isFinite(laterY));
  if (Number.isFinite(routeY)) {
    assert.ok(routeY < laterY, 'a local producer bypass must not descend below later SubSteps');
  } else {
    assert.doesNotMatch(edgeCell, /(?:exit|entry)[XY]=0\.(?:25|75)/u);
  }
});

test('a bottom assignment return clears its complete family and keeps terminal stubs on one lane', () => {
  const targetId = 'fixture.ts:10:1:10:12';
  const producerId = 'fixture.ts:10:20:10:34';
  const nodes = [
    node(targetId, ['Value', 'ValueSlot', 'ValueCreate', 'Assignment', 'ContainerMethod', 'Set'], {
      displayX: 0,
      displayY: 0,
      operationIndex: 10,
      diaName: 'target',
    }),
    node(producerId, ['Call', 'Op', 'Method', 'System'], {
      displayX: 2,
      displayY: 0,
      operationIndex: 12,
      diaName: 'producer()',
    }),
  ];
  const edges = [
    { start: targetId, end: producerId, type: 'EVAL', props: {} },
    {
      start: producerId,
      end: targetId,
      type: 'ASSIGNS_VALUE',
      props: {
        protocolRole: 'assignment-return',
        producerScopeStartOrder: 10,
        producerScopeEndOrder: 12,
      },
    },
  ];

  const xml = makeDrawio(nodes, edges, { semanticNodes, suppressFoldingContainers: true });
  const geometry = (cellId) => {
    const match = xml.match(new RegExp(
      `<mxCell id="${cellId}"[^>]*>[\\s\\S]*?<mxGeometry x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`,
      'u',
    ));
    assert.ok(match, `geometry not found: ${cellId}`);
    return match.slice(1).map(Number);
  };
  const target = geometry('n1');
  const producer = geometry('n2');
  const edgeCell = xml.match(/<mxCell id="e2"[\s\S]*?<\/mxCell>/u)?.[0] || '';
  const points = [...edgeCell.matchAll(/<mxPoint x="([^"]+)" y="([^"]+)"/gu)]
    .map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));
  assert.equal(points.length, 2);
  assert.equal(points[0].y, points[1].y, 'the target stub must not reverse away from the family lane');
  assert.ok(
    points[0].y >= Math.max(target[1] + target[3], producer[1] + producer[3]) + 20,
    'the return lane must clear the complete endpoint family by at least 20px',
  );
  assert.ok(
    points[0].y - (producer[1] + producer[3]) >= 20,
    'the selected bottom source port must keep a full terminal stub before turning',
  );
});

test('iteration returns are routed after value results from the same SubStep', () => {
  const substepId = 'fixture.ts:12:1:12:80:submethod';
  const predicateId = 'fixture.ts:12:10:12:20';
  const shiftId = 'fixture.ts:12:30:12:40';
  const setId = 'fixture.ts:12:50:12:60';
  const nodes = [
    node(predicateId, ['Branch'], { memberOfSubmethodStableId: substepId }),
    node(shiftId, ['Collection', 'Method', 'Shift'], { memberOfSubmethodStableId: substepId }),
    node(setId, ['Value', 'Assignment', 'Set'], { memberOfSubmethodStableId: substepId }),
  ];
  const nodeById = new Map(nodes.map((item) => [item.id, item]));
  const nodeBoxes = new Map([
    [predicateId, { x: 200, y: 100, width: 100, height: 30 }],
    [shiftId, { x: 0, y: 0, width: 100, height: 30 }],
    [setId, { x: 0, y: 100, width: 100, height: 30 }],
  ]);
  const repeat = {
    start: predicateId,
    end: shiftId,
    type: 'FALSE',
    props: { protocolRole: 'iteration-repeat' },
  };
  const value = {
    start: shiftId,
    end: setId,
    type: 'YIELDS_VALUE',
    props: { protocolRole: 'iteration-pass' },
  };

  assert.deepEqual(
    orderEdgesForRouting([repeat, value], nodeBoxes, nodeById),
    [value, repeat],
  );
});

test('an executed predicate transition reserves its target before the following repeat', () => {
  const firstId = 'fixture.ts:12:81:12:90';
  const nextId = 'fixture.ts:12:91:12:100';
  const receiverId = 'fixture.ts:12:101:12:110:receiver';
  const firstSubstep = 'fixture.ts:12:81:12:90:substep';
  const repeatSubstep = 'fixture.ts:12:91:12:110:substep';
  const nodes = [
    node(firstId, ['Branch'], { memberOfSubmethodStableId: firstSubstep }),
    node(nextId, ['Branch'], { memberOfSubmethodStableId: repeatSubstep }),
    node(receiverId, ['Collection', 'Method', 'Shift'], { memberOfSubmethodStableId: firstSubstep }),
  ];
  const transition = {
    start: firstId,
    end: nextId,
    type: 'FALSE',
    props: {},
  };
  const repeat = {
    start: nextId,
    end: receiverId,
    type: 'FALSE',
    props: { protocolRole: 'iteration-repeat' },
  };
  const ordered = orderEdgesForRouting([repeat, transition], new Map([
    [firstId, { x: 0, y: 100, width: 100, height: 30 }],
    [nextId, { x: 200, y: 100, width: 100, height: 30 }],
    [receiverId, { x: 400, y: 0, width: 100, height: 30 }],
  ]), new Map(nodes.map((item) => [item.id, item])));

  assert.deepEqual(ordered, [transition, repeat]);
});

test('a predicate-chain transition reserves the next predicate before its outcomes', () => {
  const firstId = 'fixture.ts:14:1:14:10';
  const nextId = 'fixture.ts:14:11:14:20';
  const resultId = 'fixture.ts:14:21:14:30';
  const nodes = [
    node(firstId, ['Branch'], { operationIndex: 10 }),
    node(nextId, ['Branch'], { operationIndex: 20 }),
    node(resultId, ['Value'], { operationIndex: 30 }),
  ];
  const transition = { start: firstId, end: nextId, type: 'FALSE', props: {} };
  const trueOutcome = { start: nextId, end: resultId, type: 'TRUE', props: {} };
  const falseOutcome = { start: nextId, end: resultId, type: 'FALSE', props: {} };
  const ordered = orderEdgesForRouting(
    [trueOutcome, falseOutcome, transition],
    new Map([
      [firstId, { x: 0, y: 0, width: 100, height: 30 }],
      [nextId, { x: 200, y: 0, width: 100, height: 30 }],
      [resultId, { x: 0, y: 100, width: 100, height: 30 }],
    ]),
    new Map(nodes.map((item) => [item.id, item])),
  );

  assert.ok(ordered.indexOf(transition) < ordered.indexOf(trueOutcome));
  assert.ok(ordered.indexOf(transition) < ordered.indexOf(falseOutcome));
});

test('extracted operation order precedes geometric routing preferences', () => {
  const nodes = [
    node('early', ['Branch'], { operationIndex: 10 }),
    node('middle', ['Branch'], { operationIndex: 20 }),
    node('late', ['Branch'], { operationIndex: 30 }),
    node('target', ['Value'], { operationIndex: 40 }),
  ];
  const early = { start: 'early', end: 'target', type: 'TRUE', props: {} };
  const middle = { start: 'middle', end: 'target', type: 'FALSE', props: {} };
  const late = { start: 'late', end: 'target', type: 'TRUE', props: {} };
  const ordered = orderEdgesForRouting(
    [late, middle, early],
    new Map([
      ['early', { x: 400, y: 200, width: 100, height: 30 }],
      ['middle', { x: 200, y: 100, width: 100, height: 30 }],
      ['late', { x: 0, y: 0, width: 100, height: 30 }],
      ['target', { x: 500, y: 300, width: 100, height: 30 }],
    ]),
    new Map(nodes.map((item) => [item.id, item])),
  );

  assert.deepEqual(ordered, [early, middle, late]);
});

test('an evaluation entry reserves its standard predicate port before the reverse outcome', () => {
  const valueId = 'fixture.ts:18:1:18:20';
  const predicateId = 'fixture.ts:18:23:18:40';
  const nodes = [
    node(valueId, ['Method', 'Value', 'BooleanFlag', 'Assignment', 'ContainerMethod', 'Set'], {
      renderPartsLayout: 'container-overlay',
      renderPartsJson: JSON.stringify([
        { stableId: `${valueId}:container`, text: 'flag', kind: 'value-container' },
        { stableId: `${valueId}:set`, text: 'set', kind: 'method' },
      ]),
    }),
    node(predicateId, ['Branch', 'Operand', 'Data'], {
      displayX: 1,
      renderPartsLayout: 'horizontal',
      renderPartsJson: JSON.stringify([
        { stableId: `${predicateId}:base`, text: 'guard', kind: 'value' },
        { stableId: `${predicateId}:field`, text: '.active', kind: 'field' },
      ]),
    }),
  ];
  const edges = [
    {
      start: predicateId,
      end: valueId,
      type: 'FALSE',
      props: { targetRenderPartStableId: `${valueId}:set` },
    },
    {
      start: valueId,
      end: predicateId,
      type: 'EVAL',
      props: {
        producerRouteRole: 'entry',
        sourceRenderPartStableId: `${valueId}:container`,
      },
    },
  ];
  const ordered = orderEdgesForRouting(edges, new Map([
    [valueId, { x: 0, y: 0, width: 180, height: 57 }],
    [predicateId, { x: 240, y: 0, width: 140, height: 30 }],
  ]), new Map(nodes.map((item) => [item.id, item])));

  assert.equal(ordered[0].type, 'EVAL');
  assert.equal(ordered[1].type, 'FALSE');

  const xml = makeDrawio(nodes, edges, { semanticNodes, suppressFoldingContainers: true });
  const evalCell = xml.match(/<mxCell(?=[^>]+edgeType="EVAL")[^>]+>/u)?.[0] || '';
  const falseCell = xml.match(/<mxCell(?=[^>]+edgeType="FALSE")[^>]+>/u)?.[0] || '';
  assert.match(evalCell, /entryX=0;entryY=0\.5/u);
  assert.doesNotMatch(evalCell, /entryY=0\.(?!5)/u);
  assert.match(falseCell, /exitX=0\.5;exitY=1/u);
});

test('a producer entry reserves its source ports before control entry and continuation edges', () => {
  const previousId = 'fixture.ts:19:1:19:10';
  const valueId = 'fixture.ts:20:1:20:20';
  const producerId = 'fixture.ts:21:1:21:20';
  const continuationId = 'fixture.ts:22:1:22:20';
  const nodes = [
    node(previousId, ['Branch', 'Flow'], { operationIndex: 10 }),
    node(valueId, ['Method', 'Value', 'ValueSlot', 'Set'], { operationIndex: 20 }),
    node(producerId, ['Call'], { operationIndex: 21 }),
    node(continuationId, ['Branch', 'Flow'], { operationIndex: 30 }),
  ];
  const controlEntry = { start: previousId, end: valueId, type: 'TRUE', props: {} };
  const evaluation = {
    start: valueId,
    end: producerId,
    type: 'EVAL',
    props: { producerRouteRole: 'entry' },
  };
  const continuation = { start: valueId, end: continuationId, type: 'NEXT', props: {} };
  const ordered = orderEdgesForRouting(
    [continuation, controlEntry, evaluation],
    new Map([
      [previousId, { x: 0, y: 0, width: 100, height: 30 }],
      [valueId, { x: 0, y: 100, width: 100, height: 30 }],
      [producerId, { x: 200, y: 100, width: 100, height: 30 }],
      [continuationId, { x: 0, y: 200, width: 100, height: 30 }],
    ]),
    new Map(nodes.map((item) => [item.id, item])),
  );

  assert.equal(ordered[0], evaluation);
  assert.ok(ordered.indexOf(evaluation) < ordered.indexOf(controlEntry));
  assert.ok(ordered.indexOf(evaluation) < ordered.indexOf(continuation));
});

test('SubStep exits are routed after its iteration repeats', () => {
  const substepId = 'fixture.ts:13:1:13:80:submethod';
  const predicateId = 'fixture.ts:13:10:13:20';
  const shiftId = 'fixture.ts:13:30:13:40';
  const setId = 'fixture.ts:13:50:13:60';
  const joinId = 'fixture.ts:14:1:14:10';
  const nodes = [
    node(predicateId, ['Branch'], { memberOfSubmethodStableId: substepId }),
    node(shiftId, ['Collection', 'Method', 'Shift'], { memberOfSubmethodStableId: substepId }),
    node(setId, ['Value', 'Assignment', 'Set'], { memberOfSubmethodStableId: substepId }),
    node(joinId, ['Flow', 'Join']),
  ];
  const nodeById = new Map(nodes.map((item) => [item.id, item]));
  const nodeBoxes = new Map([
    [predicateId, { x: 200, y: 100, width: 100, height: 30 }],
    [shiftId, { x: 0, y: 0, width: 100, height: 30 }],
    [setId, { x: 0, y: 100, width: 100, height: 30 }],
    [joinId, { x: 300, y: 200, width: 40, height: 40 }],
  ]);
  const value = {
    start: shiftId,
    end: setId,
    type: 'YIELDS_VALUE',
    props: { protocolRole: 'iteration-pass' },
  };
  const repeat = {
    start: predicateId,
    end: shiftId,
    type: 'FALSE',
    props: { protocolRole: 'iteration-repeat' },
  };
  const exit = {
    start: predicateId,
    end: joinId,
    type: 'TRUE',
    props: {},
  };

  assert.deepEqual(
    orderEdgesForRouting([exit, repeat, value], nodeBoxes, nodeById),
    [value, repeat, exit],
  );
});

test('object field corridors are routed before iteration repeats', () => {
  const braceId = 'fixture.ts:15:1:15:10:brace';
  const fieldId = 'fixture.ts:15:20:15:30:field';
  const repeatSourceId = 'fixture.ts:16:20:16:30:repeat';
  const shiftId = 'fixture.ts:14:1:14:10:shift';
  const nodes = [
    node(braceId, ['Object', 'ObjectBrace', 'Open']),
    node(fieldId, ['Field']),
    node(repeatSourceId, ['Op']),
    node(shiftId, ['Collection', 'Method', 'Shift']),
  ];
  const nodeById = new Map(nodes.map((item) => [item.id, item]));
  const nodeBoxes = new Map(nodes.map((item, index) => [
    item.id,
    { x: index * 100, y: index * 50, width: 80, height: 30 },
  ]));
  const field = { start: braceId, end: fieldId, type: 'FIELD', props: {} };
  const repeat = {
    start: repeatSourceId,
    end: shiftId,
    type: 'REPEATS',
    props: { protocolRole: 'iteration-repeat' },
  };

  assert.deepEqual(orderEdgesForRouting([repeat, field], nodeBoxes, nodeById), [field, repeat]);
});

test('iteration repeats are routed in positioned SubStep order', () => {
  const nodes = [
    node('upper', ['Op']),
    node('lower', ['Op']),
    node('upper-target', ['Collection', 'Method', 'Shift']),
    node('lower-target', ['Collection', 'Method', 'Shift']),
  ];
  const nodeById = new Map(nodes.map((item) => [item.id, item]));
  const nodeBoxes = new Map([
    ['upper', { x: 300, y: 300, width: 80, height: 30 }],
    ['lower', { x: 100, y: 500, width: 80, height: 30 }],
    ['upper-target', { x: 100, y: 100, width: 80, height: 30 }],
    ['lower-target', { x: 100, y: 0, width: 80, height: 30 }],
  ]);
  const upper = { start: 'upper', end: 'upper-target', type: 'REPEATS', props: { protocolRole: 'iteration-repeat' } };
  const lower = { start: 'lower', end: 'lower-target', type: 'REPEATS', props: { protocolRole: 'iteration-repeat' } };

  assert.deepEqual(orderEdgesForRouting([lower, upper], nodeBoxes, nodeById), [upper, lower]);
});

test('unconditional REPEATS routes use NEXT blue while binary-expression repeats stay red', () => {
  const sourceA = 'fixture.ts:12:1:12:10';
  const sourceB = 'fixture.ts:12:20:12:30';
  const targetA = 'fixture.ts:13:1:13:10';
  const targetB = 'fixture.ts:13:20:13:30';
  const nodes = [
    node(sourceA, ['Op'], { displayX: 2, displayY: 2 }),
    node(targetA, ['Collection', 'Method', 'Shift'], { displayX: 0, displayY: 0 }),
    node(sourceB, ['Branch'], { displayX: 4, displayY: 2 }),
    node(targetB, ['Collection', 'Method', 'Shift'], { displayX: 3, displayY: 0 }),
  ];
  const edges = [
    { start: sourceA, end: targetA, type: 'REPEATS', props: { repeatOrigin: 'sequence', protocolRole: 'iteration-repeat' } },
    { start: sourceB, end: targetB, type: 'REPEATS', props: { repeatOrigin: 'binary-expression', protocolRole: 'iteration-repeat' } },
  ];

  const xml = makeDrawio(nodes, edges, { semanticNodes, suppressFoldingContainers: true });
  assert.match(xml, /id="e1"[^>]+strokeColor=#007FFF[^>]+edgeType="REPEATS"/u);
  assert.match(xml, /id="e2"[^>]+strokeColor=#CC0000[^>]+edgeType="REPEATS"/u);
  assert.match(xml, /id="e1"[\s\S]*?<Array as="points">/u);
  assert.match(xml, /id="e2"[\s\S]*?<Array as="points">/u);
});

test('row-zero collection attachment aligns shift with its iterator body', () => {
  const targetId = 'fixture.ts:4:1:4:10';
  const headerId = 'fixture.ts:4:20:4:30';
  const itemId = 'fixture.ts:4:30:4:40';
  const popId = 'fixture.ts:4:40:4:50';
  const nodes = [
    node(targetId, ['Value', 'Variable', 'Assignment', 'Set'], {
      displayX: 0,
      displayY: 0,
      render_parts_layout: 'container-overlay',
      render_parts_json: JSON.stringify([
        { kind: 'value-container', text: 'result' },
        { kind: 'method', text: 'set', labels: ['Set'] },
      ]),
    }),
    node(headerId, ['Method', 'SubStep'], {
      displayX: 1,
      displayY: 0,
      parentSubmethodStableId: targetId,
    }),
    node(itemId, ['Value', 'Variable', 'Assignment', 'Set'], {
      displayX: 1,
      displayY: 1,
      render_parts_layout: 'container-overlay',
      render_parts_json: JSON.stringify([
        { kind: 'value-container', text: 'item' },
        { kind: 'method', text: 'set', labels: ['Set'] },
      ]),
    }),
    node(popId, ['Collection', 'Method', 'Pull', 'SubStepAttachment'], {
      displayX: 2,
      displayY: 0,
      memberOfSubmethodStableId: headerId,
      submethodAnchorStableId: itemId,
      submethodRelativeRow: 0,
      render_parts_layout: 'container-overlay',
      render_parts_json: JSON.stringify([
        { kind: 'collection-container', text: 'items' },
        { kind: 'method', text: 'shift', labels: ['Shift'] },
      ]),
    }),
  ];

  const xml = makeDrawio(nodes, [], { semanticNodes, suppressFoldingContainers: true });
  const geometry = (cellId) => {
    const match = xml.match(new RegExp(
      `<mxCell id="${cellId}"[^>]*>[\\s\\S]*?<mxGeometry x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`,
      'u',
    ));
    assert.ok(match, `geometry not found: ${cellId}`);
    return match.slice(1).map(Number);
  };
  const target = geometry('n3');
  const targetBody = geometry('n3-part-1');
  const pop = geometry('n4');
  const popMethod = geometry('n4-part-2');
  const targetCenterY = target[1] + targetBody[1] + targetBody[3] / 2;
  const popCenterY = pop[1] + popMethod[1] + popMethod[3] / 2;
  assert.equal(popCenterY, targetCenterY);
});

test('for-of shift is positioned on the iterator row and uses one-way value ports', () => {
  const iteratorId = 'fixture.ts:9:12:9:16:iterator';
  const collectionId = 'fixture.ts:9:20:9:25:collection';
  const nodes = [
    node(iteratorId, ['Value', 'Iterator', 'Assignment', 'Set'], {
      displayX: 0,
      displayY: 0,
      render_parts_layout: 'container-overlay',
      render_parts_json: JSON.stringify([
        { kind: 'value-container', text: 'item' },
        { kind: 'method', text: 'set', labels: ['Set'] },
      ]),
    }),
    node(collectionId, ['Collection', 'Method', 'Pull', 'Shift'], {
      displayX: 1,
      displayY: 0,
      render_parts_layout: 'container-overlay',
      render_parts_json: JSON.stringify([
        { kind: 'collection-container', text: 'items' },
        { kind: 'method', text: 'shift', labels: ['Shift'] },
      ]),
    }),
  ];
  const edges = [
    { start: iteratorId, end: collectionId, type: 'EVAL', props: { protocolRole: 'collection-shift-eval', oneWay: true } },
    { start: collectionId, end: iteratorId, type: 'YIELDS_VALUE', props: { protocolRole: 'iteration-pass', diaName: 'value' } },
  ];
  const xml = makeDrawio(nodes, edges, { semanticNodes, suppressFoldingContainers: true });
  const geometry = (cellId) => {
    const match = xml.match(new RegExp(
      `<mxCell id="${cellId}"[^>]*>[\\s\\S]*?<mxGeometry x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`,
      'u',
    ));
    assert.ok(match, `geometry not found: ${cellId}`);
    return match.slice(1).map(Number);
  };
  const iterator = geometry('n1');
  const iteratorBody = geometry('n1-part-1');
  const collection = geometry('n2');
  const shift = geometry('n2-part-2');
  assert.equal(
    iterator[1] + iteratorBody[1] + iteratorBody[3] / 2,
    collection[1] + shift[1] + shift[3] / 2,
  );
  assert.doesNotMatch(xml, /id="e1"[^>]+startArrow=block/u);
});

test('a for-of applies one horizontal-frame gap before its iterator subcolumn', () => {
  const loopId = 'fixture.ts:12:1:16:2';
  const iteratorId = 'fixture.ts:12:12:12:16:iterator';
  const collectionId = 'fixture.ts:12:20:12:25:collection';
  const sourceId = 'fixture.ts:13:3:13:15';
  const continuationId = 'fixture.ts:14:3:14:18';
  const predicateId = 'fixture.ts:15:3:15:12';
  const rejectedId = 'fixture.ts:16:3:16:14';
  const nodes = [
    node(loopId, ['Loop', 'System'], { displayX: 0, displayY: 0 }),
    node(iteratorId, ['Value', 'Iterator', 'Assignment', 'Set'], {
      displayX: 0,
      displayY: 0,
      collectionMethod: 'for-of',
      render_parts_layout: 'container-overlay',
      render_parts_json: JSON.stringify([
        { kind: 'value-container', text: 'item', fillState: 'empty' },
        { kind: 'method', text: 'set', labels: ['Method', 'ContainerMethod', 'Virtual'] },
      ]),
    }),
    node(collectionId, ['Collection', 'Method', 'Pull', 'Shift'], {
      displayX: 1,
      displayY: 0,
    }),
    node(sourceId, ['Value'], { displayX: 2, displayY: 1 }),
    node(continuationId, ['Call'], { displayX: 2, displayY: 2 }),
    node(predicateId, ['Branch'], { displayX: 1, displayY: 3 }),
    node(rejectedId, ['Call'], { displayX: 1, displayY: 4 }),
  ];
  const edges = [
    { start: loopId, end: iteratorId, type: 'NEXT', props: {} },
    { start: iteratorId, end: collectionId, type: 'EVAL', props: { protocolRole: 'collection-shift-eval' } },
    { start: sourceId, end: continuationId, type: 'NEXT', props: {} },
    { start: predicateId, end: rejectedId, type: 'FALSE', props: {} },
  ];
  const xml = makeDrawio(nodes, edges, { semanticNodes, suppressFoldingContainers: true });
  const geometry = (cellId) => {
    const match = xml.match(new RegExp(
      `<mxCell id="${cellId}"[^>]*>[\\s\\S]*?<mxGeometry x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`,
      'u',
    ));
    assert.ok(match, `geometry not found: ${cellId}`);
    return match.slice(1).map(Number);
  };
  const loop = geometry('n1');
  const iterator = geometry('n2');
  const iteratorBody = geometry('n2-part-1');
  const source = geometry('n4');
  const continuation = geometry('n5');
  const predicate = geometry('n6');
  const rejected = geometry('n7');
  assert.equal(
    iterator[0] - (loop[0] + loop[2]),
    56,
  );
  assert.equal(
    iterator[1] + iteratorBody[1] + iteratorBody[3] / 2,
    loop[1] + loop[3] / 2,
    'the iterator body must share the horizontal axis of for',
  );
  assert.equal(
    source[0] + source[2] / 2,
    continuation[0] + continuation[2] / 2,
    'NEXT must stay in its current subcolumn',
  );
  assert.equal(
    predicate[0] + predicate[2] / 2,
    rejected[0] + rejected[2] / 2,
    'FALSE must stay in its current subcolumn',
  );
});

test('field producers continue below their field and expanded state writes reserve their family footprint', () => {
  const rootId = 'fixture.ts:20:1:28:2';
  const resultId = `${rootId}:result`;
  const storeId = `${rootId}:store`;
  const field0Id = `${rootId}:field:0`;
  const field1Id = `${rootId}:field:1`;
  const closeId = `${rootId}:close`;
  const incrementId = `${rootId}:increment`;
  const recordId = `${rootId}:record`;
  const recordWriteId = `${recordId}:write`;
  const nodes = [
    node(rootId, ['Call', 'SubStep'], {
      displayX: 0, displayY: 0, submethodStableId: rootId, submethodRelativeRow: 0,
    }),
    node(resultId, ['Field', 'Return', 'LocalBinding', 'SubStepMember'], {
      displayX: 0, displayY: 1, memberOfSubmethodStableId: rootId, submethodRelativeRow: 1,
    }),
    node(storeId, ['Store', 'SubStepMember'], {
      displayX: 0, displayY: 2, memberOfSubmethodStableId: rootId, submethodRelativeRow: 2,
      renderPartsLayout: 'container-overlay-side',
      renderPartsJson: JSON.stringify([
        { kind: 'storage-container', text: 'AppState store' },
        { kind: 'method', text: 'write(' },
        { kind: 'punctuation', text: '{' },
      ]),
    }),
    node(field0Id, ['Field', 'Spread', 'SubStepAttachment'], {
      displayX: 3, displayY: 2, memberOfSubmethodStableId: rootId, submethodRelativeRow: 2, fieldIndex: 0,
    }),
    node(field1Id, ['Field', 'SubStepAttachment'], {
      displayX: 3, displayY: 3, memberOfSubmethodStableId: rootId, submethodRelativeRow: 2, fieldIndex: 1,
    }),
    node(closeId, ['Field', 'Join', 'Method', 'CallBoundary'], {
      displayX: 4, displayY: 2,
      diaName: ')',
      callMosaicRole: 'close',
      renderPartsLayout: 'horizontal',
      renderPartsJson: JSON.stringify([
        { kind: 'method', text: ')' },
      ]),
    }),
    node(incrementId, ['Request', 'SubStep'], {
      displayX: 1, displayY: 4, submethodStableId: incrementId,
      parentSubmethodStableId: rootId, submethodRelativeRow: 0,
    }),
    node(recordId, ['Request', 'SubStep'], {
      displayX: 2, displayY: 4.2, submethodStableId: recordId,
      parentSubmethodStableId: incrementId, submethodRelativeRow: 0,
    }),
    node(recordWriteId, ['Store', 'SubStepMember'], {
      displayX: 2, displayY: 5.2, memberOfSubmethodStableId: recordId, submethodRelativeRow: 1,
    }),
  ];
  const edges = [
    { start: resultId, end: incrementId, type: 'NEXT', props: {} },
    {
      start: incrementId,
      end: resultId,
      type: 'YIELDS_VALUE',
      props: { protocolRole: 'assignment-return' },
    },
    { start: incrementId, end: recordId, type: 'ASYNC', props: {} },
    { start: storeId, end: field0Id, type: 'FIELD', props: {} },
    { start: storeId, end: field1Id, type: 'FIELD', props: {} },
    { start: field0Id, end: closeId, type: 'FieldJoin', props: {} },
    { start: field1Id, end: closeId, type: 'FieldJoin', props: {} },
  ];
  const xml = makeDrawio(nodes, edges, { semanticNodes, suppressFoldingContainers: true });
  const geometry = (cellId) => {
    const match = xml.match(new RegExp(
      `<mxCell id="${cellId}"[^>]*>[\\s\\S]*?<mxGeometry x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`,
      'u',
    ));
    assert.ok(match, `geometry not found: ${cellId}`);
    return match.slice(1).map(Number);
  };
  const result = geometry('n2');
  const store = geometry('n3');
  const field0 = geometry('n4');
  const field1 = geometry('n5');
  const close = geometry('n6');
  const increment = geometry('n7');
  const record = geometry('n8');
  const openingMethod = geometry('n3-part-2');

  assert.equal(result[0] + result[2] / 2, increment[0] + increment[2] / 2);
  assert.equal(
    increment[1] - (result[1] + result[3]),
    60,
    'a field producer starts on the next visual SubStep grade below its field',
  );
  assert.equal(
    increment[0] + increment[2] / 2,
    record[0] + record[2] / 2,
    'an ASYNC child submethod must continue in the same vertical column',
  );
  assert.ok(record[1] >= increment[1] + increment[3]);
  assert.equal(
    store[1] + openingMethod[1] + openingMethod[3] / 2,
    close[1] + close[3] / 2,
  );
  assert.ok(field0[0] >= store[0] + store[2]);
  assert.ok(field1[1] >= field0[1] + field0[3]);
  assert.ok(close[0] >= Math.max(
    field0[0] + field0[2],
    field1[0] + field1[2],
    increment[0] + increment[2],
  ));
  const assignmentReturnCell = xml.match(
    /<mxCell(?=[^>]+edgeType="YIELDS_VALUE")[^>]+source="n7" target="n2"[^>]*>/u,
  )?.[0] || '';
  assert.match(
    assignmentReturnCell,
    /exitX=1;exitY=0\.(?:25|5|75)/u,
    'assignment returns may select any available right-side source port instead of forcing one port',
  );
  assert.doesNotMatch(
    assignmentReturnCell,
    /exitX=0\.5;exitY=0;/u,
    'an ordinary YIELDS_VALUE return must not create an outgoing top port',
  );
  assert.match(xml, /<mxCell id="n6" value="\)"[^>]+%23DAE8FC[^>]+%23007FFF/u);
  assert.equal(xml.includes('<mxCell id="n6" value="}"'), false);
  assert.match(
    xml,
    /<mxCell[^>]*style="[^"]*dashed=1;[^"]*"[^>]*source="n7" target="n8"/u,
    'ASYNC submethod transitions must render as dashed arrows',
  );
});

test('an object-family obstacle includes the SubStep that produces a field value', () => {
  const familyId = 'fixture.ts:25:10:30:2:object';
  const leftId = `${familyId}:brace:left:0`;
  const rightId = `${familyId}:brace:right:0`;
  const fieldId = `${familyId}:field:0`;
  const producerId = `${fieldId}:producer`;
  const nodes = [
    node(leftId, ['Object', 'ObjectBrace', 'Open'], { objectFamilyStableId: familyId }),
    node(rightId, ['Object', 'ObjectBrace', 'Close'], { objectFamilyStableId: familyId }),
    node(fieldId, ['Field', 'Assignment'], { nestedEvaluationDirection: 'down' }),
    node(producerId, ['Request', 'SubStep'], {
      submethodStableId: producerId,
      parentSubmethodStableId: fieldId,
    }),
  ];
  const edges = [
    { start: leftId, end: fieldId, type: 'FIELD', props: {} },
    { start: fieldId, end: rightId, type: 'FieldJoin', props: {} },
    { start: fieldId, end: producerId, type: 'EVAL', props: {} },
    {
      start: producerId,
      end: fieldId,
      type: 'YIELDS_VALUE',
      props: { protocolRole: 'assignment-return' },
    },
  ];
  const boxes = new Map([
    [leftId, { x: 100, y: 100, width: 20, height: 80 }],
    [rightId, { x: 300, y: 100, width: 20, height: 80 }],
    [fieldId, { x: 160, y: 110, width: 100, height: 40 }],
    [producerId, { x: 140, y: 180, width: 140, height: 30 }],
  ]);

  const [obstacle] = buildObjectFamilyRouteObstacles(nodes, edges, boxes);
  assert.ok(obstacle.memberIds.has(producerId));
  assert.equal(obstacle.bottom, 210);
});

test('object-family positioning moves an assignment producer with its field', () => {
  const callId = 'fixture.ts:40:1:48:2:call';
  const familyId = `${callId}:arg0`;
  const leftId = `${familyId}:brace:left:0`;
  const rightId = `${familyId}:brace:right:0`;
  const spreadId = `${familyId}:field:0`;
  const valueId = `${familyId}:field:1`;
  const producerId = `${valueId}:producer`;
  const nodes = [
    node(callId, ['Call', 'SubStep'], {
      displayX: 0, displayY: 0, submethodStableId: callId, submethodRelativeRow: 0,
    }),
    node(leftId, ['Object', 'ObjectBrace', 'Open', 'Arg'], {
      displayX: 1,
      displayY: 0,
      objectFamilyStableId: familyId,
      objectBraceSide: 'left',
      objectBracePairIndex: 0,
      objectBraceFieldIndicesJson: JSON.stringify([0, 1]),
      objectBraceMosaicNeighborStableId: callId,
    }),
    node(rightId, ['Object', 'ObjectBrace', 'Close', 'Arg'], {
      displayX: 4,
      displayY: 0,
      objectFamilyStableId: familyId,
      objectBraceSide: 'right',
      objectBracePairIndex: 0,
      objectBraceFieldIndicesJson: JSON.stringify([0, 1]),
    }),
    node(spreadId, ['Field', 'Spread', 'SubStepMember'], {
      displayX: 2, displayY: -1, fieldIndex: 0,
      memberOfSubmethodStableId: callId, submethodRelativeRow: 1,
    }),
    node(valueId, ['Field', 'Return', 'LocalBinding', 'SubStepMember'], {
      displayX: 2, displayY: 1, fieldIndex: 1,
      memberOfSubmethodStableId: callId, submethodRelativeRow: 2,
    }),
    node(producerId, ['Request', 'SubStep'], {
      displayX: 3, displayY: 0, submethodStableId: producerId,
      parentSubmethodStableId: callId, submethodRelativeRow: 0,
    }),
  ];
  const edges = [
    { start: callId, end: leftId, type: 'ARG', props: { layoutFrame: 'horizontal' } },
    { start: leftId, end: spreadId, type: 'FIELD', props: { layoutFrame: 'horizontal', fieldIndex: 0 } },
    { start: leftId, end: valueId, type: 'FIELD', props: { layoutFrame: 'horizontal', fieldIndex: 1 } },
    { start: spreadId, end: rightId, type: 'FieldJoin', props: { fieldIndex: 0 } },
    { start: valueId, end: rightId, type: 'FieldJoin', props: { fieldIndex: 1 } },
    {
      start: producerId,
      end: valueId,
      type: 'YIELDS_VALUE',
      props: { protocolRole: 'assignment-return' },
    },
  ];
  const nodeBoxes = new Map([
    [callId, { x: 0, y: 100, width: 110, height: 30 }],
    [leftId, { x: 150, y: 100, width: 20, height: 60 }],
    [rightId, { x: 400, y: 100, width: 20, height: 60 }],
    [spreadId, { x: 200, y: 70, width: 60, height: 30 }],
    [valueId, { x: 200, y: 112, width: 80, height: 40 }],
    [producerId, { x: 160, y: 172, width: 160, height: 30 }],
  ]);
  alignObjectBraceFamilies(nodes, edges, nodeBoxes);
  const value = nodeBoxes.get(valueId);
  const producer = nodeBoxes.get(producerId);

  assert.equal(
    producer.x + producer.width / 2,
    value.x + value.width / 2,
    'the producer and its assigned field must move as one centered subcolumn',
  );
  assert.ok(
    producer.y >= value.y + value.height,
    'the producer must remain below its assigned field',
  );
});

test('renderer uses extracted Steps for layout but serializes only FlowBlock containers', () => {
  const nodes = [
    node('fixture.ts:1:1:1:5', ['ValueSlot', 'ValueAccess']),
    node('fixture.ts:1:8:1:20', ['Branch', 'Operand', 'ValueAccess']),
  ];
  const edges = [{
    start: nodes[0].id,
    end: nodes[1].id,
    type: 'NEXT',
    props: {},
  }];

  const xml = makeDrawio(nodes, edges, { semanticNodes });
  assert.equal((xml.match(/graphKind="Step"/gu) || []).length, 0);
  assert.equal((xml.match(/graphKind="FlowBlock"/gu) || []).length, 1);
  assert.equal(xml.includes('renderer-value-access:'), false);
  assert.equal(xml.includes('execution:'), false);
});

test('renderer rejects Step ownership that was not extracted', () => {
  const nodes = [node('fixture.ts:1:1:1:5', ['ValueAccess'], {
    parentStepStableId: 'flow-step:statement:fixture.ts:9:1:9:2',
  })];
  assert.throws(
    () => makeDrawio(nodes, [], { semanticNodes }),
    /Extracted Step was not found/u,
  );
});

test('renderer rejects FlowBlock ownership that was not extracted', () => {
  const nodes = [node('fixture.ts:1:1:1:5', ['ValueAccess'], {
    parentFlowBlockStableId: 'flow-block:side:true:fixture.ts:9:1:9:2',
  })];
  assert.throws(
    () => makeDrawio(nodes, [], { semanticNodes }),
    /Extracted FlowBlock was not found/u,
  );
});

test('nested side-flow Step keeps its head family on the local lane and its TRUE bridge inside both rows', () => {
  const outerBlockId = 'flow-block:side:true:fixture.ts:1:1:8:1';
  const innerBlockId = 'flow-block:side:true:fixture.ts:3:1:7:1';
  const sourceStepId = 'flow-step:condition:fixture.ts:2:1:2:20';
  const targetStepId = 'flow-step:execution:fixture.ts:3:1:6:20';
  const sourceId = 'fixture.ts:2:1:2:20';
  const targetId = 'fixture.ts:3:1:3:20';
  const fieldId = 'fixture.ts:4:1:4:10';
  const nextId = 'fixture.ts:5:1:5:10';
  const fixtureNode = (id, labels, step, block, displayX, displayY) => ({
    id,
    labels,
    props: {
      label: id,
      parentFnStableId: 'fixture.ts:1:1:8:1',
      parentStepStableId: step,
      parentFlowBlockStableId: block,
      flowStepOrder: displayY,
      displayX,
      displayY,
    },
  });
  const nodes = [
    fixtureNode(sourceId, ['Branch', 'Flow'], sourceStepId, outerBlockId, 2, 0),
    fixtureNode(targetId, ['Start', 'ValueAccess'], targetStepId, innerBlockId, 2, 1),
    fixtureNode(fieldId, ['Field', 'ValueAccess'], targetStepId, innerBlockId, 3, 1),
    fixtureNode(nextId, ['Call', 'Start'], targetStepId, innerBlockId, 0, 2),
  ];
  const edges = [
    { start: sourceId, end: targetId, type: 'TRUE', props: { displayLabel: 'TRUE', sourcePort: 'bottom', targetPort: 'top' } },
    { start: targetId, end: fieldId, type: 'FIELD', props: { displayLabel: 'field' } },
    { start: targetId, end: nextId, type: 'NEXT', props: {} },
  ];
  const facts = [
    { key: sourceStepId, labels: ['Step'], props: { headStableIds: [sourceId], tailStableIds: [sourceId] } },
    { key: targetStepId, labels: ['Step'], props: { headStableIds: [targetId], tailStableIds: [nextId] } },
    { key: outerBlockId, labels: ['Block'], props: { headStableIds: [sourceId], tailStableIds: [nextId] } },
    {
      key: innerBlockId,
      labels: ['Block'],
      props: {
        headStableIds: [targetId],
        tailStableIds: [nextId],
        parentFlowBlockStableId: outerBlockId,
      },
    },
  ];

  const xml = makeDrawio(nodes, edges, { semanticNodes: facts });
  const targetCell = xml.match(new RegExp(`<mxCell[^>]+stableId="${targetId}"[^>]*>[\\s\\S]*?<mxGeometry x="([^"]+)"`, 'u'));
  const nextCell = xml.match(new RegExp(`<mxCell[^>]+stableId="${nextId}"[^>]*>[\\s\\S]*?<mxGeometry x="([^"]+)"`, 'u'));
  assert.ok(targetCell && nextCell);
  assert.ok(
    Number(targetCell[1]) <= Number(nextCell[1]) + 1,
    `the Step head must stay on its local control lane: head=${targetCell[1]} next=${nextCell[1]}`,
  );

  const sourceRow = xml.match(new RegExp(`<mxCell[^>]+stableId="${sourceStepId}"[^>]*>[\\s\\S]*?<mxGeometry[^>]+width="([^"]+)"`, 'u'));
  const sourcePort = xml.match(/id="e1-source-port"[\s\S]*?<mxGeometry x="([^"]+)"/u);
  if (sourcePort) {
    assert.ok(sourceRow);
    assert.ok(Number(sourcePort[1]) >= 0);
    assert.ok(Number(sourcePort[1]) + 6 <= Number(sourceRow[1]), 'the TRUE bridge port must remain inside the source Step');
  } else {
    assert.match(xml, /<mxCell id="e1"[^>]+parent="1"/u);
    assert.equal(xml.includes('id="e1-boundary"'), false);
  }
  assert.equal((xml.match(/value="true"/gu) || []).length, 1);
});

test('a cross-Step top port stays central after Step heads align on their visual axes', () => {
  const sourceStepId = 'flow-step:statement:fixture.ts:20:1:20:40';
  const targetStepId = 'flow-step:condition:fixture.ts:21:1:21:40';
  const sourceId = 'fixture.ts:20:7:20:22';
  const targetId = 'fixture.ts:21:7:21:31';
  const props = (parentStepStableId, flowStepOrder, displayY) => ({
    parentFnStableId: 'fixture.ts:1:1:30:1',
    parentStepStableId,
    flowStepOrder,
    displayX: 1,
    displayY,
  });
  const nodes = [
    {
      id: sourceId,
      labels: ['Method', 'ValueSlot', 'Assignment', 'ContainerMethod', 'Set', 'SemanticExpansion', 'Primitive'],
      props: {
        ...props(sourceStepId, 0, 0),
        renderPartsLayout: 'container-overlay-side',
        renderPartsJson: JSON.stringify([
          { kind: 'value-container', text: 'matchingCommand', fillState: 'empty' },
          { kind: 'method', text: 'set(', labels: ['Method', 'ContainerMethod'] },
          { kind: 'value', text: 'cmd', labels: ['Value', 'Occurrence'] },
          { kind: 'punctuation', text: ')', labels: ['CallBoundary'] },
        ]),
      },
    },
    {
      id: targetId,
      labels: ['Branch', 'Flow', 'PredicateOperator'],
      props: {
        ...props(targetStepId, 1, 1),
        diaName: 'isCommandEnabled(cmd)',
      },
    },
  ];
  const edges = [{
    start: sourceId,
    end: targetId,
    type: 'NEXT',
    props: { flowLayer: 'control', sourcePort: 'bottom', targetPort: 'top-50' },
  }];
  const facts = [
    { key: sourceStepId, labels: ['Step'], props: { headStableIds: [sourceId], tailStableIds: [sourceId] } },
    { key: targetStepId, labels: ['Step'], props: { headStableIds: [targetId], tailStableIds: [targetId] } },
  ];

  const xml = makeDrawio(nodes, edges, { semanticNodes: facts });
  const targetSegment = xml.match(/id="e1-target"[^>]+style="([^"]+)"/u)?.[1] || '';
  const entryX = Number(targetSegment.match(/entryX=([0-9.]+)/u)?.[1]);
  assert.equal(entryX, 0.5, 'the target node itself must align to the source axis');
});

test('same-subColumn top ports follow the active endpoint axis in both directions', () => {
  const localStepId = 'flow-step:condition:fixture.ts:40:1:42:40';
  const upperId = 'fixture.ts:40:1:40:20';
  const compositeId = 'fixture.ts:41:1:41:40';
  const lowerId = 'fixture.ts:42:1:42:30';
  const localNode = (id, labels, displayY, extra = {}) => ({
    id,
    labels,
    props: {
      label: id,
      parentFnStableId: 'fixture.ts:1:1:50:1',
      parentStepStableId: localStepId,
      flowStepOrder: 0,
      displayX: 1,
      displayY,
      ...extra,
    },
  });
  const nodes = [
    localNode(upperId, ['Branch', 'Operand'], 0, { diaName: 'isCommandEnabled(cmd)' }),
    localNode(compositeId, ['Branch', 'Collection', 'PredicateCall'], 1, {
      renderPartsLayout: 'container-overlay-side',
      renderPartsJson: JSON.stringify([
        { kind: 'collection-container', text: 'cmd.aliases', labels: ['Collection'] },
        { kind: 'method', text: 'includes(', labels: ['Method', 'System'] },
        { kind: 'value', text: 'commandName', labels: ['Value'] },
        { kind: 'punctuation', text: ')', labels: ['CallBoundary'] },
      ]),
    }),
    localNode(lowerId, ['Branch', 'Operand'], 2, { diaName: 'getCommandName(cmd) === commandName' }),
  ];
  const edges = [
    { start: upperId, end: compositeId, type: 'FALSE', props: { flowLayer: 'control' } },
    { start: compositeId, end: lowerId, type: 'FALSE', props: { flowLayer: 'control' } },
  ];
  const xml = makeDrawio(nodes, edges, {
    semanticNodes: [{
      key: localStepId,
      labels: ['Step'],
      props: { headStableIds: [upperId], tailStableIds: [lowerId] },
    }],
  });
  const edgeStyle = (sourceStableId) => xml.match(new RegExp(
    `<mxCell(?=[^>]+stableId="${sourceStableId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}")(?=[^>]+edgeType="FALSE")[^>]+style="([^"]+)"[^>]*>`,
    'u',
  ))?.[1] || '';
  const upperEntryX = Number(edgeStyle(upperId).match(/entryX=([0-9.]+)/u)?.[1]);
  const lowerEntryX = Number(edgeStyle(compositeId).match(/entryX=([0-9.]+)/u)?.[1]);
  assert.ok(upperEntryX < 0.5, `entry into the right-offset overlay must shift left, entryX=${upperEntryX}`);
  assert.ok(lowerEntryX > 0.5, `entry from the right-offset overlay must shift right, entryX=${lowerEntryX}`);
});

test('iteration exhaustion from above enters the collection FlowJoin through its top port', () => {
  const localStepId = 'flow-step:statement:fixture.ts:10:1:10:80';
  const guardId = 'fixture.ts:10:20:10:40:iteration:available';
  const predicateId = 'fixture.ts:10:41:10:55';
  const joinId = 'fixture.ts:10:20:10:70:flow-join';
  const fixtureNode = (id, labels, displayX, displayY) => ({
    id,
    labels,
    props: {
      label: id,
      parentFnStableId: 'fixture.ts:1:1:20:1',
      parentStepStableId: localStepId,
      flowStepOrder: 0,
      displayX,
      displayY,
    },
  });
  const nodes = [
    fixtureNode(guardId, ['Branch', 'Operand', 'IterationGuard'], 2, 0),
    fixtureNode(predicateId, ['Branch', 'Operand'], 2, 1),
    fixtureNode(joinId, ['Join', 'Flow', 'CollectionExit'], 0, 2),
  ];
  const edges = [{
    start: guardId,
    end: joinId,
    type: 'FALSE',
    props: { stableId: guardId, displayLabel: 'FALSE' },
  }];
  const xml = makeDrawio(nodes, edges, {
    semanticNodes: [{
      key: localStepId,
      labels: ['Step'],
      props: { headStableIds: [guardId], tailStableIds: [joinId] },
    }],
  });
  const edgeOffset = xml.indexOf('edgeType="FALSE"');
  assert.notEqual(edgeOffset, -1);
  const cellStart = xml.lastIndexOf('<mxCell', edgeOffset);
  const cellEnd = xml.indexOf('</mxCell>', edgeOffset);
  const edgeXml = xml.slice(cellStart, cellEnd + '</mxCell>'.length);
  assert.match(edgeXml, /exitY=1/u);
  assert.match(edgeXml, /entryX=0\.5;entryY=0/u);
});

test('an incoming route from above does not share the FlowJoin outgoing port', () => {
  const localStepId = 'flow-step:condition:fixture.ts:30:1:32:20';
  const predicateId = 'fixture.ts:30:1:30:20';
  const joinId = 'fixture.ts:31:1:31:2';
  const continuationId = 'fixture.ts:32:1:32:20';
  const nodes = [
    node(predicateId, ['Branch', 'Flow', 'PredicateCall'], { displayX: 0, displayY: 0 }),
    node(joinId, ['Join', 'Flow', 'Exclusive'], { displayX: 0, displayY: 1 }),
    node(continuationId, ['Branch', 'Flow'], { displayX: 0, displayY: 2 }),
  ].map((item) => ({
    ...item,
    props: { ...item.props, parentStepStableId: localStepId, parentFlowBlockStableId: '' },
  }));
  const edges = [
    { start: predicateId, end: joinId, type: 'FALSE', props: { stableId: predicateId } },
    { start: joinId, end: continuationId, type: 'NEXT', props: { stableId: joinId } },
  ];
  const xml = makeDrawio(nodes, edges, {
    semanticNodes: [{
      key: localStepId,
      labels: ['Step'],
      props: { headStableIds: [predicateId], tailStableIds: [continuationId] },
    }],
  });
  const falseCell = xml.match(/<mxCell[^>]+edgeType="FALSE"[^>]*>/u)?.[0] || '';
  const nextCell = xml.match(/<mxCell[^>]+edgeType="NEXT"[^>]*>/u)?.[0] || '';
  assert.match(falseCell, /entryX=0\.5;entryY=0/u);
  assert.match(nextCell, /exitX=0\.5;exitY=1/u);
});

test('Step inherits its flow column and a new FlowBlock starts in the next column', () => {
  const rootStep1 = 'step:root:1';
  const rootStep2 = 'step:root:2';
  const sideStep1 = 'step:side:1';
  const sideStep2 = 'step:side:2';
  const sideBlock = 'flow-block:side:true:fixture';
  const nodes = [
    { id: 'root-1', labels: ['Value'], props: { parentStepStableId: rootStep1, flowStepOrder: 0 } },
    { id: 'root-2', labels: ['Value'], props: { parentStepStableId: rootStep2, flowStepOrder: 1 } },
    { id: 'side-1', labels: ['Value'], props: { parentStepStableId: sideStep1, parentFlowBlockStableId: sideBlock, flowStepOrder: 2 } },
    { id: 'side-detail', labels: ['Value'], props: { parentStepStableId: sideStep1, parentFlowBlockStableId: sideBlock, flowStepOrder: 2 } },
    { id: 'side-2', labels: ['Value'], props: { parentStepStableId: sideStep2, parentFlowBlockStableId: sideBlock, flowStepOrder: 3 } },
  ];
  const semanticNodes = [
    { key: rootStep1, labels: ['Step'], props: { headStableIds: ['root-1'] } },
    { key: rootStep2, labels: ['Step'], props: { headStableIds: ['root-2'] } },
    { key: sideStep1, labels: ['Step'], props: { headStableIds: ['side-1'] } },
    { key: sideStep2, labels: ['Step'], props: { headStableIds: ['side-2'] } },
    { key: sideBlock, labels: ['Block'], props: { headStableIds: ['side-1'], ownerBranchStableIds: ['root-2'] } },
  ];
  const positions = new Map([
    ['root-1', { x: 0, y: 0 }],
    ['root-2', { x: 4, y: 1 }],
    ['side-1', { x: 8, y: 2 }],
    ['side-detail', { x: 10, y: 2 }],
    ['side-2', { x: 12, y: 3 }],
  ]);

  const result = assignStepAndFlowBlockColumns(nodes, [], semanticNodes, positions);
  assert.equal(result.movedStepCount, 3);
  assert.equal(positions.get('root-1').x, 0);
  assert.equal(positions.get('root-2').x, 0);
  assert.equal(positions.get('side-1').x, 1);
  assert.equal(positions.get('side-detail').x, 3);
  assert.equal(positions.get('side-2').x, 1);
});

test('a projected Step head keeps the main column when its extracted id has a horizontal owner', () => {
  const rootStep = 'step:root';
  const predicateStep = 'step:predicate';
  const firstPredicate = 'fixture.ts:20:1:20:20';
  const secondPredicate = 'fixture.ts:20:24:20:60';
  const nodes = [
    { id: 'root', labels: ['Join'], props: { parentStepStableId: rootStep, flowStepOrder: 0 } },
    // Keep the second predicate first to prove that member order is not used as the Step axis.
    { id: secondPredicate, labels: ['Branch'], props: { parentStepStableId: predicateStep, flowStepOrder: 1 } },
    { id: firstPredicate, labels: ['Branch'], props: { parentStepStableId: predicateStep, flowStepOrder: 1 } },
  ];
  const semanticNodes = [
    { key: rootStep, labels: ['Step'], props: { headStableIds: ['root'] } },
    {
      key: predicateStep,
      labels: ['Step'],
      props: {
        headStableIds: [`${firstPredicate}:horizontal-owner-fixture.ts-1-1-100-1`],
      },
    },
  ];
  const positions = new Map([
    ['root', { x: 0, y: 0 }],
    [secondPredicate, { x: 6, y: 1 }],
    [firstPredicate, { x: 5, y: 1 }],
  ]);

  assignStepAndFlowBlockColumns(nodes, [], semanticNodes, positions);

  assert.equal(positions.get(firstPredicate).x, 0);
  assert.equal(positions.get(secondPredicate).x, 1);
});

test('a Step takes its FlowBlock column from the extracted Step instead of member order', () => {
  const rootStep = 'step:root';
  const sideStep = 'step:side';
  const sideBlock = 'flow-block:side:true:fixture';
  const nodes = [
    { id: 'root', labels: ['Branch'], props: { parentStepStableId: rootStep, flowStepOrder: 0 } },
    { id: 'external-detail', labels: ['Value'], props: { parentStepStableId: sideStep, flowStepOrder: 1 } },
    { id: 'side-head', labels: ['Value'], props: { parentStepStableId: sideStep, parentFlowBlockStableId: sideBlock, flowStepOrder: 1 } },
  ];
  const semanticNodes = [
    { key: rootStep, labels: ['Step'], props: { headStableIds: ['root'] } },
    {
      key: sideStep,
      labels: ['Step'],
      props: { headStableIds: ['side-head'], parentFlowBlockStableId: sideBlock },
    },
    {
      key: sideBlock,
      labels: ['Block'],
      props: { headStableIds: ['side-head'], ownerBranchStableIds: ['root'] },
    },
  ];
  const positions = new Map([
    ['root', { x: 0, y: 0 }],
    ['external-detail', { x: 7, y: 1 }],
    ['side-head', { x: 8, y: 1 }],
  ]);

  assignStepAndFlowBlockColumns(nodes, [], semanticNodes, positions);

  assert.equal(positions.get('side-head').x, 1);
  assert.equal(positions.get('external-detail').x, 0);
});

test('a combined Step FlowBlock owns the next column instead of inheriting its parent block column', () => {
  const rootStep = 'step:root';
  const parentStep = 'step:parent';
  const parentBlock = 'flow-block:side:true:parent';
  const combinedStepBlock = 'flow-step:execution:combined';
  const nodes = [
    { id: 'root', labels: ['Branch'], props: { parentStepStableId: rootStep, flowStepOrder: 0 } },
    {
      id: 'parent-head',
      labels: ['Branch'],
      props: { parentStepStableId: parentStep, parentFlowBlockStableId: parentBlock, flowStepOrder: 1 },
    },
    {
      id: 'combined-head',
      labels: ['Call'],
      props: { parentStepStableId: combinedStepBlock, parentFlowBlockStableId: combinedStepBlock, flowStepOrder: 2 },
    },
  ];
  const semanticNodes = [
    { key: rootStep, labels: ['Step'], props: { headStableIds: ['root'] } },
    { key: parentStep, labels: ['Step'], props: { headStableIds: ['parent-head'], parentFlowBlockStableId: parentBlock } },
    { key: parentBlock, labels: ['Block'], props: { headStableIds: ['parent-head'], ownerBranchStableIds: ['root'] } },
    {
      key: combinedStepBlock,
      labels: ['Step', 'Block'],
      props: {
        headStableIds: ['combined-head'],
        parentFlowBlockStableId: parentBlock,
        ownerBranchStableIds: ['parent-head'],
        combinedStepFlowBlock: true,
      },
    },
  ];
  const positions = new Map([
    ['root', { x: 0, y: 0 }],
    ['parent-head', { x: 4, y: 1 }],
    ['combined-head', { x: 8, y: 2 }],
  ]);

  assignStepAndFlowBlockColumns(nodes, [], semanticNodes, positions);

  assert.equal(positions.get('parent-head').x, 1);
  assert.equal(positions.get('combined-head').x, 2);
});
