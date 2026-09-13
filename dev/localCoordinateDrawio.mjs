import fs from 'node:fs';
import path from 'node:path';

const PORT_STUB_GAP_RATIO = 0.18;
const PORT_STUB_GAP_MIN = 14;
const PORT_STUB_GAP_MAX = 34;
const ROUTE_OBSTACLE_CLEARANCE = 20;
const ROUTE_CORRIDOR_AXIS_TOLERANCE = 2;
const HEX_SIDE_DEPTH = 16;
const METHOD_CURVED_SIDE_DEPTH = 10;
const DRAWIO_PALETTE = Object.freeze({
  actionFill: '#DAE8FC',
  actionSketchFill: '#99CCFF',
  actionStroke: '#007FFF',
  systemActionFill: '#E1D5E7',
  systemActionStroke: '#9673A6',
  operationProviderFill: '#DAE8FC',
  operationProviderBackingFill: '#BFDFFF',
  operationProviderStroke: '#007FFF',
  valueFill: '#FFE6CC',
  valueStroke: '#BE7000',
  resultFill: '#ffffff',
  collectionFill: '#FFE6CC',
  collectionStroke: '#BE7000',
  expressionFill: '#ffffff',
  expressionStroke: '#9a5d00',
  literalFill: '#ffffff',
  literalStroke: '#808080',
  developerDefinedTypeFill: '#D5E8D4',
  developerDefinedTypeStroke: '#82B366',
  missingFill: '#f8cecc',
  missingStroke: '#b85450',
});
const MOSAIC_TILE_HEIGHT = 30;
const OPERATOR_MOSAIC_TILE_HEIGHT = 20;
const FIELD_ACCESS_MOSAIC_TILE_HEIGHT = 25;
const OPERATION_PROVIDER_CONTAINER_HEIGHT = 60;
const BOX_SVG_STROKE_PADDING = 2;
const CLOSED_BOX_HEIGHT_TO_WIDTH_RATIO = 84 / 116;
const DATA_BRANCH_RESULT_GRADE_GAP = 60;
const NESTED_SUBSTEP_GRADE_GAP = 60;

const ACTION_NODE_STYLE = `rounded=1;arcSize=14;whiteSpace=wrap;html=1;fillColor=${DRAWIO_PALETTE.actionFill};strokeColor=${DRAWIO_PALETTE.actionStroke};fontColor=#000000;`;
const ACTION_NODE_BOLD_STYLE = `${ACTION_NODE_STYLE}fontStyle=1;`;
const VALUE_NODE_STYLE = `rounded=0;whiteSpace=wrap;html=1;fillColor=${DRAWIO_PALETTE.valueFill};strokeColor=${DRAWIO_PALETTE.valueStroke};fontColor=#000000;`;
const VALUE_NODE_BOLD_STYLE = `${VALUE_NODE_STYLE}fontStyle=1;`;
const LITERAL_NODE_STYLE = `rounded=1;arcSize=14;whiteSpace=wrap;html=1;fillColor=${DRAWIO_PALETTE.literalFill};strokeColor=${DRAWIO_PALETTE.literalStroke};fontColor=#000000;`;
const SYSTEM_VALUE_NODE_STYLE = `rounded=1;arcSize=14;whiteSpace=wrap;html=1;fillColor=${DRAWIO_PALETTE.literalFill};strokeColor=${DRAWIO_PALETTE.systemActionStroke};fontColor=#000000;`;
const RESULT_NODE_STYLE = `rounded=1;arcSize=14;whiteSpace=wrap;html=1;fillColor=${DRAWIO_PALETTE.resultFill};strokeColor=${DRAWIO_PALETTE.valueStroke};strokeWidth=2;fontColor=#000000;fontStyle=1;`;
const FIXED_HEX_STYLE = `fixedSize=1;size=${HEX_SIDE_DEPTH};`;
const BOOLEAN_VALUE_STYLE = `shape=hexagon;perimeter=hexagonPerimeter2;${FIXED_HEX_STYLE}whiteSpace=wrap;html=1;fillColor=${DRAWIO_PALETTE.valueFill};strokeColor=${DRAWIO_PALETTE.valueStroke};fontColor=#000000;`;
const EXPRESSION_NODE_STYLE = `shape=hexagon;perimeter=hexagonPerimeter2;${FIXED_HEX_STYLE}whiteSpace=wrap;html=1;fillColor=${DRAWIO_PALETTE.expressionFill};strokeColor=${DRAWIO_PALETTE.expressionStroke};fontColor=#000000;`;

function variableRectangleStyle({ empty = false, bold = false } = {}) {
  return `rounded=0;whiteSpace=wrap;html=1;fillColor=${empty ? '#ffffff' : DRAWIO_PALETTE.valueFill};strokeColor=${DRAWIO_PALETTE.valueStroke};fontColor=#000000;${bold ? 'fontStyle=1;' : ''}`;
}

function xml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\r?\n/g, '&#xa;');
}

function hasLabel(node, label) {
  return (node?.labels || []).includes(label);
}

function hasLabels(node, ...labels) {
  return labels.every((label) => hasLabel(node, label));
}

function isSystemValuePart(part) {
  return (part?.labels || []).includes('SystemValue');
}

function isSemanticPrimitiveNode(node) {
  return hasLabels(node, 'SemanticExpansion', 'Primitive');
}

function isVirtualCollectionPrimitiveNode(node) {
  return isSemanticPrimitiveNode(node)
    && hasLabel(node, 'Collection')
    && (hasLabel(node, 'ContainerMethod') || hasLabel(node, 'Shift') || hasLabel(node, 'Emit'));
}

function isVirtualContainerMethodNode(node) {
  return hasLabel(node, 'ContainerMethod')
    || hasLabel(node, 'Set')
    || isVirtualCollectionPrimitiveNode(node);
}

function isVirtualValueContainerNode(node) {
  return isVirtualResultNode(node)
    || (hasLabel(node, 'Virtual') && hasLabel(node, 'ValueSlot'))
    || (isSemanticPrimitiveNode(node)
      && hasLabel(node, 'Variable')
      && hasLabel(node, 'Virtual'));
}

function isSystemMethodNode(node) {
  return hasLabel(node, 'System');
}

function methodPalette(node, sketch = false) {
  if (hasLabel(node, 'SystemProvider')) {
    return {
      fill: DRAWIO_PALETTE.systemActionFill,
      stroke: DRAWIO_PALETTE.systemActionStroke,
    };
  }
  if (hasLabel(node, 'OperationProvider')) {
    return {
      fill: DRAWIO_PALETTE.operationProviderFill,
      stroke: DRAWIO_PALETTE.operationProviderStroke,
    };
  }
  if (isSystemMethodNode(node)) {
    return {
      fill: DRAWIO_PALETTE.systemActionFill,
      stroke: DRAWIO_PALETTE.systemActionStroke,
    };
  }
  return {
    fill: sketch ? DRAWIO_PALETTE.actionSketchFill : DRAWIO_PALETTE.actionFill,
    stroke: DRAWIO_PALETTE.actionStroke,
  };
}

function virtualMethodPalette() {
  return {
    fill: DRAWIO_PALETTE.actionSketchFill,
    stroke: DRAWIO_PALETTE.actionStroke,
  };
}

function operationProviderStackImage(system = false) {
  const fill = system ? DRAWIO_PALETTE.systemActionFill : DRAWIO_PALETTE.operationProviderBackingFill;
  const stroke = system ? DRAWIO_PALETTE.systemActionStroke : DRAWIO_PALETTE.operationProviderStroke;
  const methodWidth = 120;
  const methodPath = callBoundaryPath('single', methodWidth);
  const layer = (x, y) => [
    `<g transform="translate(${x} ${y})">`,
    `<path d="${methodPath}" fill="${fill}"/>`,
    `<path d="${methodPath}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="miter" vector-effect="non-scaling-stroke"/>`,
    '</g>',
  ].join('');
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 137 65" preserveAspectRatio="none">',
    layer(0, 0),
    layer(8, 7),
    layer(17, 15),
    '</svg>',
  ].join('');
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function objectBraceImage(side, width, height, centerRatio = 0.5) {
  const svgWidth = Math.max(8, Number(width) || 20);
  const svgHeight = Math.max(16, Number(height) || 30);
  const centerY = Math.max(7, Math.min(svgHeight - 7, svgHeight * centerRatio));
  const fieldX = svgWidth - 1;
  const tipX = 1;
  const shoulderX = Math.max(4, svgWidth * 0.42);
  const path = [
    `M ${fieldX} 1`,
    `C ${shoulderX} 1 ${shoulderX} ${centerY - 7} ${shoulderX} ${centerY - 4}`,
    `C ${shoulderX} ${centerY - 2} ${tipX} ${centerY - 1} ${tipX} ${centerY}`,
    `C ${tipX} ${centerY + 1} ${shoulderX} ${centerY + 2} ${shoulderX} ${centerY + 4}`,
    `C ${shoulderX} ${centerY + 7} ${shoulderX} ${svgHeight - 1} ${fieldX} ${svgHeight - 1}`,
  ].join(' ');
  const transform = side === 'right' ? ` transform='translate(${svgWidth} 0) scale(-1 1)'` : '';
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${svgWidth} ${svgHeight}' preserveAspectRatio='none'><path d='${path}'${transform} fill='none' stroke='${DRAWIO_PALETTE.valueStroke}' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round' vector-effect='non-scaling-stroke'/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function operationProviderStackStyle(system = false) {
  return `shape=image;imageAspect=0;image=${operationProviderStackImage(system)};whiteSpace=wrap;html=1;align=center;verticalAlign=middle;spacing=5;fontColor=#000000;fontStyle=1;part=1;`;
}

function booleanActionStyleForNode(node) {
  const palette = methodPalette(node);
  return `shape=hexagon;perimeter=hexagonPerimeter2;${FIXED_HEX_STYLE}whiteSpace=wrap;html=1;fillColor=${palette.fill};strokeColor=${palette.stroke};fontColor=#000000;fontStyle=1;`;
}

function isVirtualResultNode(node) {
  return hasLabel(node, 'Virtual')
    && (hasLabel(node, 'Result') || hasLabel(node, 'CallbackResult') || hasLabel(node, 'ResultTarget'));
}

function isBooleanActionNode(node) {
  return hasLabel(node, 'BooleanFlag')
    && (hasLabel(node, 'Call')
      || hasLabel(node, 'Request')
      || hasLabel(node, 'Read')
      || hasLabel(node, 'Op')
      || hasLabel(node, 'Fn')
      || hasLabel(node, 'Method'));
}

function predicateOperationCode(node) {
  return String(node.props?.operation_code || node.props?.operationCode || '').toLowerCase();
}

function isCallPredicateNode(node) {
  if (!hasLabel(node, 'Branch')) return false;
  const operationCode = predicateOperationCode(node);
  if (operationCode) return operationCode === 'boolean-call';
  return ['Call', 'Request', 'Op', 'Method'].some((label) => hasLabel(node, label));
}

function isValuePredicateNode(node) {
  if (!hasLabel(node, 'Branch') || isCallPredicateNode(node)) return false;
  const operationCode = predicateOperationCode(node);
  if (operationCode === 'boolean-call') return false;
  if (operationCode === 'boolean-value') return true;
  return hasLabel(node, 'ValueAccess') || hasLabel(node, 'ValueRead');
}

function isFlowJoinNode(node) {
  return hasLabels(node, 'Flow', 'Join');
}

function isArgJoinNode(node) {
  return hasLabels(node, 'Arg', 'Join');
}

function isExclusiveJoinNode(node) {
  return hasLabels(node, 'Join', 'Exclusive');
}

function isDataJoinNode(node) {
  return hasLabel(node, 'DataJoin');
}

function isObjectBraceNode(node) {
  return hasLabel(node, 'ObjectBrace');
}

function isFieldJoinNode(node) {
  return hasLabels(node, 'Field', 'Join');
}

function isObjectStartNode(node) {
  return hasLabel(node, 'Object');
}

function isObjectFieldNode(node) {
  return hasLabel(node, 'Field') && !hasLabel(node, 'Join') && !hasLabel(node, 'Branch');
}

function isObjectFinishNode(node) {
  return hasLabels(node, 'Field', 'Join');
}

function isCallFinishNode(node) {
  return hasLabel(node, 'Finish') && !hasLabel(node, 'Start');
}

function isBracketNode(node) {
  return isCallFinishNode(node)
    || (isObjectStartNode(node) && !hasLabel(node, 'Parameter'))
    || isObjectFinishNode(node)
    || (isArgJoinNode(node) && !isExclusiveJoinNode(node))
    || isFieldJoinNode(node);
}

export function fixedHexGeometry(width = 100) {
  const svgWidth = Math.max(2, Number(width) || 100);
  const depth = Math.min(HEX_SIDE_DEPTH, Math.max(0, (svgWidth - 2) / 2));
  return {
    svgWidth,
    leftTip: 1,
    leftShoulder: 1 + depth,
    rightShoulder: svgWidth - 1 - depth,
    rightTip: svgWidth - 1,
  };
}

function isSignificantExpressionNode(node) {
  return hasLabel(node, 'SignificantExpression');
}

function fixedMosaicTipGeometry(width = 100) {
  const svgWidth = Math.max(2, Number(width) || 100);
  const depth = Math.min(HEX_SIDE_DEPTH, Math.max(0, svgWidth - 2));
  return {
    svgWidth,
    leftTip: 1,
    leftShoulder: 1 + depth,
    rightShoulder: svgWidth - 1 - depth,
    rightTip: svgWidth - 1,
  };
}

function splitCallBoundaryImage(side, fillColor, strokeColor, predicate = false, width = 100, flatOuter = false) {
  const { svgWidth, leftTip, leftShoulder, rightShoulder, rightTip } = fixedHexGeometry(Math.max(18, Number(width) || 100));
  const rightInward = inwardRightBoundary(svgWidth);
  const leftInward = inwardLeftBoundary();
  const startPath = predicate
    ? `M ${leftShoulder} 1 ${rightInward} H ${leftShoulder} L ${leftTip} 25 Z`
    : `M 0 1 ${rightInward} H 0 Z`;
  const endPath = predicate && !flatOuter
    ? `M 0 1 H ${rightShoulder} L ${rightTip} 25 L ${rightShoulder} 49 ${leftInward} Z`
    : `M 0 1 H ${svgWidth} V 49 ${leftInward} Z`;
  const middlePath = `M 0 1 ${rightInward} H 0 ${leftInward} Z`;
  const svg = [
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${svgWidth} 50' preserveAspectRatio='none'>`,
    `<path d='${side === 'start' ? startPath : side === 'middle' ? middlePath : endPath}' fill='${fillColor}' stroke='${strokeColor}' stroke-width='1' stroke-linejoin='miter' vector-effect='non-scaling-stroke'/>`,
    '</svg>',
  ].join('');
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function horizontalMosaicImage(side, fillColor, strokeColor, predicate = false, width = 100, sketch = false) {
  const { svgWidth, leftTip, leftShoulder, rightShoulder, rightTip } = fixedMosaicTipGeometry(width);
  const startPath = predicate
    ? `M ${leftShoulder} 1 H ${svgWidth} V 49 H ${leftShoulder} L ${leftTip} 25 Z`
    : `M 0 1 H ${svgWidth} V 49 H 0 Z`;
  const middlePath = `M 0 1 H ${svgWidth} V 49 H 0 Z`;
  const endPath = predicate
    ? `M 0 1 H ${rightShoulder} L ${rightTip} 25 L ${rightShoulder} 49 H 0 Z`
    : `M 0 1 H ${svgWidth} V 49 H 0 Z`;
  const path = side === 'start' ? startPath : side === 'middle' ? middlePath : endPath;
  const svg = [
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${svgWidth} 50' preserveAspectRatio='none'>`,
    sketch ? `<defs><clipPath id='c'><path d='${path}'/></clipPath></defs>` : '',
    `<path d='${path}' fill='${sketch ? '#ffffff' : fillColor}'/>`,
    sketch ? `<path d='${sketchHatchPath(svgWidth, 50)}' clip-path='url(#c)' fill='none' stroke='${fillColor}' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'/>` : '',
    `<path d='${path}' fill='none' stroke='${strokeColor}' stroke-width='${sketch ? 1.6 : 1}' stroke-linejoin='miter' vector-effect='non-scaling-stroke'/>`,
    sketch ? `<path d='${path}' transform='translate(0.45 -0.3)' opacity='0.55' fill='none' stroke='${strokeColor}' stroke-width='0.9' stroke-linejoin='miter' vector-effect='non-scaling-stroke'/>` : '',
    '</svg>',
  ].join('');
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function verticalMosaicImage(side, fillColor, strokeColor) {
  const path = side === 'start'
    ? 'M 8 1 H 92 Q 99 1 99 8 V 50 H 1 V 8 Q 1 1 8 1 Z'
    : side === 'end'
      ? 'M 1 0 H 99 V 42 Q 99 49 92 49 H 8 Q 1 49 1 42 Z'
      : 'M 1 0 H 99 V 50 H 1 Z';
  const svg = [
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 50' preserveAspectRatio='none'>",
    `<path d='${path}' fill='${fillColor}' stroke='${strokeColor}' stroke-width='1' vector-effect='non-scaling-stroke'/>`,
    '</svg>',
  ].join('');
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function sketchHatchPath(width, height) {
  const paths = [];
  for (let diagonal = 4; diagonal < width + height; diagonal += 12) {
    const x1 = Math.max(0, diagonal - height);
    const y1 = Math.min(height, diagonal);
    const x2 = Math.min(width, diagonal);
    const y2 = Math.max(0, diagonal - width);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const bend = ((Math.floor(diagonal / 12) % 3) - 1) * 0.65;
    paths.push(
      `M ${x1 - 0.4} ${y1 + 0.2} C ${x1 + dx * 0.34} ${y1 + dy * 0.34 + bend}, ${x1 + dx * 0.68} ${y1 + dy * 0.68 - bend}, ${x2 + 0.3} ${y2 - 0.2}`,
      `M ${x1 + 0.7} ${y1 + 1.1} C ${x1 + dx * 0.31} ${y1 + dy * 0.31 - bend}, ${x1 + dx * 0.71} ${y1 + dy * 0.71 + bend}, ${x2 + 1.1} ${y2 + 0.6}`,
    );
  }
  return paths.join(' ');
}

function callArcCoordinates(width) {
  const right = Math.max(18, Number(width) || 100);
  return {
    right,
    rightShoulder: right - 10,
    rightCurve1: `${right - 6.74} 5.179 ${right - 4.329} 9.375 ${right - 2.768} 13.586`,
    rightCurve2: `${right - 1.433} 17.216 ${right - 0.765} 21.012 ${right - 0.765} 24.975`,
    rightCurve3: `${right - 0.765} 29.471 ${right - 1.662} 33.817 ${right - 3.457} 38.013`,
    rightCurve4: `${right - 5.252} 42.208 ${right - 7.433} 45.87 ${right - 10} 49`,
  };
}

function inwardRightBoundary(width) {
  const right = Math.max(18, Number(width) || 100);
  return `H ${right} C ${right - 3.26} 5.179 ${right - 5.671} 9.375 ${right - 7.232} 13.586 C ${right - 8.567} 17.216 ${right - 9.235} 21.012 ${right - 9.235} 24.975 C ${right - 9.235} 29.471 ${right - 8.338} 33.817 ${right - 6.543} 38.013 C ${right - 4.748} 42.208 ${right - 2.567} 45.87 ${right} 49`;
}

function inwardLeftBoundary() {
  return 'H 0 C 2.567 45.87 4.748 42.208 6.543 38.013 C 8.338 33.817 9.235 29.471 9.235 24.975 C 9.235 21.012 8.567 17.216 7.232 13.586 C 5.671 9.375 3.26 5.179 0 1';
}

function callBoundaryPath(side, width, torn = false) {
  const {
    right,
    rightShoulder,
    rightCurve1,
    rightCurve2,
    rightCurve3,
    rightCurve4,
  } = callArcCoordinates(width);
  const leftShoulder = 10;
  const rightArc = `H ${rightShoulder} C ${rightCurve1} C ${rightCurve2} C ${rightCurve3} C ${rightCurve4}`;
  const leftArc = `H ${leftShoulder} C 7.433 45.87 5.252 42.208 3.457 38.013 C 1.662 33.817 0.765 29.471 0.765 24.975 C 0.765 21.012 1.433 17.216 2.768 13.586 C 4.329 9.375 6.74 5.179 10 1`;
  const rightInward = inwardRightBoundary(right);
  const leftInward = inwardLeftBoundary();

  if (side === 'single') {
    return `M ${leftShoulder} 1 ${rightArc} ${leftArc} Z`;
  }
  if (side === 'start') {
    return torn
      ? `M ${leftShoulder} 1 ${rightInward} ${leftArc} Z`
      : `M ${leftShoulder} 1 H ${right} V 49 ${leftArc} Z`;
  }
  if (side === 'end') {
    return torn
      ? `M 0 1 ${rightArc} ${leftInward} Z`
      : `M 0 1 ${rightArc} H 0 Z`;
  }
  if (side === 'torn-right') {
    return `M 0 1 ${rightInward} H 0 Z`;
  }
  if (side === 'torn-left') {
    return `M 0 1 H ${right} V 49 ${leftInward} Z`;
  }
  return `M 0 1 H ${right} V 49 H 0 Z`;
}

export function methodMosaicImage(side, fillColor, strokeColor, {
  sketch = false,
  torn = false,
  width = 100,
} = {}) {
  const svgWidth = Math.max(18, Number(width) || 100);
  const normalizedSide = ['single', 'start', 'middle', 'end', 'torn-left', 'torn-right'].includes(side) ? side : 'single';
  const path = callBoundaryPath(normalizedSide, svgWidth, torn);
  const hatch = sketchHatchPath(svgWidth, 50);
  const svg = [
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${svgWidth} 50' preserveAspectRatio='none'>`,
    sketch ? `<defs><clipPath id='c'><path d='${path}'/></clipPath></defs>` : '',
    `<path d='${path}' fill='${sketch ? '#ffffff' : fillColor}'/>`,
    sketch ? `<path d='${hatch}' clip-path='url(#c)' fill='none' stroke='${fillColor}' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'/>` : '',
    `<path d='${path}' fill='none' stroke='${strokeColor}' stroke-width='${sketch ? 1.6 : 1.5}' stroke-linejoin='miter' vector-effect='non-scaling-stroke'/>`,
    sketch ? `<path d='${path}' transform='translate(0.45 -0.3)' opacity='0.55' fill='none' stroke='${strokeColor}' stroke-width='0.9' stroke-linejoin='miter' vector-effect='non-scaling-stroke'/>` : '',
    '</svg>',
  ].join('');
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function methodNodeStyle(node, side, width, { sketch = false, torn = false, fontSize = '' } = {}) {
  const palette = methodPalette(node, sketch);
  const image = methodMosaicImage(
    side,
    palette.fill,
    palette.stroke,
    { sketch, torn, width },
  );
  const bold = sketch || isVirtualContainerMethodNode(node) || hasLabel(node, 'TypeAnnotation');
  return `shape=image;imageAspect=0;image=${image};whiteSpace=wrap;html=1;labelPosition=center;align=center;verticalLabelPosition=middle;verticalAlign=middle;spacing=4;fontColor=#000000;${bold ? 'fontStyle=1;' : ''}${fontSize ? `fontSize=${fontSize};` : ''}`;
}

function boxPaths({ open = false, sketch = false, compact = false, roughPerFace = false } = {}) {
  const topFill = sketch ? 'url(#sketch-fill)' : '#fff1e0';
  const wallFill = sketch ? 'url(#sketch-fill)' : '#ffe6cc';
  const face = (path, fill) => sketch
    ? `<path d="${path}" fill="#ffffff" stroke="none"/><path d="${path}" fill="${fill}"/>${roughPerFace ? `<path d="${path}" transform="translate(0.45 -0.3)" opacity="0.45" fill="none"/>` : ''}`
    : `<path d="${path}" fill="${fill}"/>`;
  const frontBottomLeftY = compact ? 60 : 75;
  const frontBottomRightY = compact ? 68 : 83;
  const sideBottomY = compact ? 53 : 68;
  if (!open) {
    return [
      face('M5 32 L27 17 L115 25 L93 40 Z', topFill),
      face(`M5 32 L93 40 L93 ${frontBottomRightY} L5 ${frontBottomLeftY} Z`, wallFill),
      face(`M93 40 L115 25 L115 ${sideBottomY} L93 ${frontBottomRightY} Z`, wallFill),
      '<path d="M49 19 L27 34 M93 23 L71 38 M38 26.5 L82 30.5" fill="none"/>',
    ].join('');
  }
  return [
    '<path d="M5 32 L27 17 L115 25 L93 40 Z" fill="#d9aa78"/>',
    face('M27 17 L115 25 L120 8 L32 0 Z', wallFill),
    face('M5 32 L27 17 L18 5 L0 20 Z', wallFill),
    face(`M5 32 L93 40 L93 ${frontBottomRightY} L5 ${frontBottomLeftY} Z`, wallFill),
    face(`M93 40 L115 25 L115 ${sideBottomY} L93 ${frontBottomRightY} Z`, wallFill),
    face('M5 32 L93 40 L88 23 L0 15 Z', wallFill),
    face('M93 40 L115 25 L120 11 L98 26 Z', wallFill),
  ].join('');
}

function boxImage({ open = false, collection = false, sketch = false } = {}) {
  const body = boxPaths({ sketch, compact: collection });
  const top = boxPaths({ open, sketch, compact: collection, roughPerFace: sketch && open });
  const layer = (paths, transform = '', rough = sketch) => {
    const roughOutline = paths
      .replace(/<path[^>]+stroke="none"\/>/gu, '')
      .replace(/<path[^>]+transform="translate\(0\.45 -0\.3\)"[^>]*\/>/gu, '')
      .replace(/fill="[^"]+"/gu, 'fill="none"');
    return [
      `<g${transform ? ` transform="${transform}"` : ''}>`,
      paths,
      rough ? `<g transform="translate(0.45 -0.3)" opacity="0.45">${roughOutline}</g>` : '',
      '</g>',
    ].join('');
  };
  const content = collection
    ? [
        layer(body, 'translate(0 56)'),
        layer(body, 'translate(0 28)'),
        layer(top, '', sketch && !open),
      ].join('')
    : layer(top, '', sketch && !open);
  const viewBoxHeight = collection ? 124 : 90;
  const strokePadding = open || collection ? BOX_SVG_STROKE_PADDING : 0;
  const sketchDefs = sketch
    ? `<defs><pattern id="sketch-fill" width="120" height="${viewBoxHeight}" patternUnits="userSpaceOnUse"><rect width="120" height="${viewBoxHeight}" fill="#ffffff"/><path d="${sketchHatchPath(120, viewBoxHeight)}" fill="none" stroke="${DRAWIO_PALETTE.valueFill}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></pattern></defs>`
    : '';
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-strokePadding} ${-strokePadding} ${120 + strokePadding * 2} ${viewBoxHeight + strokePadding * 2}" preserveAspectRatio="none">`,
    sketchDefs,
    `<g stroke="${DRAWIO_PALETTE.valueStroke}" stroke-width="2" stroke-linejoin="round">`,
    content,
    '</g></svg>',
  ].join('');
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function boxNodeStyle({ open = false, collection = false, sketch = false, height = 40 } = {}) {
  const labelPlacement = collection
    ? 'verticalAlign=middle;spacingTop=9;'
    : `verticalAlign=bottom;spacingLeft=6;spacingBottom=${Math.round(height * 0.2)};`;
  const labelAlignment = collection ? 'align=center;' : 'align=left;';
  return `shape=image;imageAspect=0;image=${boxImage({ open, collection, sketch })};whiteSpace=wrap;html=1;${labelAlignment}${labelPlacement}fontColor=#000000;fontStyle=1;`;
}

function splitCallBoundarySide(node) {
  const explicit = node.props?.splitCallBoundary;
  if (explicit === 'start' || explicit === 'middle' || explicit === 'end') return explicit;
  const design = node.props?.callBoundaryDesign || node.props?.call_boundary_design;
  const role = node.props?.callBoundaryRole || node.props?.call_boundary_role;
  if (design !== 'split') return '';
  if (role === 'open') return 'start';
  if (role === 'close') return 'end';
  return '';
}

function isSingleNodeNoArgumentCall(node) {
  const design = node.props?.callBoundaryDesign || node.props?.call_boundary_design;
  const hasArguments = node.props?.callHasArguments ?? node.props?.call_has_arguments;
  return design === 'column' && hasArguments === false;
}

function splitCallBoundaryStyle(node, width) {
  const extractedSide = splitCallBoundarySide(node);
  if (extractedSide !== 'start' && extractedSide !== 'middle' && extractedSide !== 'end') return '';
  const mosaicOwner = node.props?.callMosaicOwnerStableId || node.props?.call_mosaic_owner_stable_id || '';
  const mosaicRole = node.props?.callMosaicRole || node.props?.call_mosaic_role || '';
  const side = mosaicOwner
    ? mosaicRole === 'open'
      ? 'start'
      : mosaicRole === 'close'
        ? 'end'
        : mosaicRole === 'argument' || mosaicRole === 'argument-close'
          ? 'middle'
          : extractedSide
    : extractedSide;
  const methodSide = mosaicOwner && mosaicRole === 'argument'
    ? 'torn-right'
    : mosaicOwner && mosaicRole === 'argument-close'
      ? 'torn-left'
      : side;
  const missing = node.labels.includes('Missing');
  const literal = side === 'middle' && node.labels.includes('Literal');
  const variable = side === 'middle'
    && (node.labels.includes('Variable') || node.labels.includes('ValueAccess') || node.labels.includes('ValueRead'));
  const fillColor = missing
    ? DRAWIO_PALETTE.missingFill
    : literal
      ? DRAWIO_PALETTE.literalFill
      : variable
        ? DRAWIO_PALETTE.valueFill
        : isSystemMethodNode(node)
          ? DRAWIO_PALETTE.systemActionFill
          : DRAWIO_PALETTE.actionFill;
  const strokeColor = missing
    ? DRAWIO_PALETTE.missingStroke
    : literal
      ? (hasLabel(node, 'SystemValue') ? DRAWIO_PALETTE.systemActionStroke : DRAWIO_PALETTE.literalStroke)
      : variable
        ? DRAWIO_PALETTE.valueStroke
        : isSystemMethodNode(node)
          ? DRAWIO_PALETTE.systemActionStroke
          : DRAWIO_PALETTE.actionStroke;
  const predicate = node.props?.callPredicate === true;
  const compact = node.props?.compactCallMosaic === true;
  const flatOuter = extractedSide === 'end' && node.props?.flattenCallBoundaryRight === true;
  const image = predicate
    ? compact
      ? horizontalMosaicImage(side, fillColor, strokeColor, true, width)
      : splitCallBoundaryImage(side, fillColor, strokeColor, true, width, flatOuter)
    : methodMosaicImage(flatOuter ? 'torn-left' : methodSide, fillColor, strokeColor, {
        sketch: isVirtualContainerMethodNode(node) || hasLabel(node, 'Virtual'),
        torn: !flatOuter && Boolean(extractedSide),
        width,
      });
  return `shape=image;imageAspect=0;image=${image};whiteSpace=wrap;html=1;labelPosition=center;align=center;verticalLabelPosition=middle;verticalAlign=middle;spacing=4;fontColor=#000000;`;
}

function expressionMosaicRole(node) {
  return node.props?.expressionMosaicRole || node.props?.expression_mosaic_role || '';
}

function expressionMosaicOrder(node) {
  const value = Number(node.props?.expressionMosaicOrder ?? node.props?.expression_mosaic_order);
  return Number.isFinite(value) ? value : expressionMosaicRole(node) === 'left' ? 0 : expressionMosaicRole(node) === 'operator' ? 1 : 2;
}

function expressionMosaicSize(node) {
  const value = Number(node.props?.expressionMosaicSize ?? node.props?.expression_mosaic_size);
  return Number.isFinite(value) && value > 0 ? value : 3;
}

function expressionMosaicParentStableId(node) {
  return node.props?.expressionMosaicParentStableId
    || node.props?.expression_mosaic_parent_stable_id
    || '';
}

function expressionMosaicLayout(node) {
  return node.props?.expressionMosaicLayout || node.props?.expression_mosaic_layout || '';
}

function expressionMosaicPartKind(node) {
  return node.props?.expressionMosaicPartKind || node.props?.expression_mosaic_part_kind || '';
}

function mosaicOwnerStableIds(node, nodeById = new Map()) {
  const callOwner = node?.props?.callMosaicOwnerStableId || node?.props?.call_mosaic_owner_stable_id;
  const expressionOwner = node?.props?.expressionMosaicOwnerStableId || node?.props?.expression_mosaic_owner_stable_id;
  const expressionOwnerNode = expressionOwner && nodeById.get(expressionOwner);
  const outerCallOwner = expressionOwnerNode?.props?.callMosaicOwnerStableId
    || expressionOwnerNode?.props?.call_mosaic_owner_stable_id;
  return [...new Set([callOwner, expressionOwner, outerCallOwner].filter(Boolean))];
}

function pushMosaicEntryOwner(node, edge, nodeById) {
  if (!node || isValueRoutingEdge(edge)) return null;
  const edgeType = String(edge?.type || '');
  const flowLayer = flowLayerForGraphItem(edge, 'control');
  if (flowLayer !== 'control' && edgeType !== 'NEXT') return null;
  const role = node.props?.callMosaicRole || node.props?.call_mosaic_role || '';
  if (role !== 'argument') return null;
  const ownerId = node.props?.callMosaicOwnerStableId || node.props?.call_mosaic_owner_stable_id || '';
  const owner = ownerId ? nodeById.get(ownerId) : null;
  return owner && isPushCollectionOverlay(owner) ? owner : null;
}

function reroutePushMosaicEntryEdges(nodes, edges) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return edges.map((edge) => {
    const owner = pushMosaicEntryOwner(nodeById.get(edge.end), edge, nodeById);
    if (!owner) return edge;
    return {
      ...edge,
      end: owner.id,
      props: {
        ...edge.props,
        targetStableId: edge.props?.targetStableId || edge.end,
        layoutEffectiveTargetStableId: owner.id,
      },
    };
  });
}

function methodChainRole(node) {
  return node.props?.methodChainRole || node.props?.method_chain_role || '';
}

function methodChainOwnerStableId(node) {
  return node.props?.methodChainOwnerStableId || node.props?.method_chain_owner_stable_id || '';
}

function methodChainMosaicStyle(node, width) {
  if (methodChainRole(node) !== 'continuation') return '';
  const palette = methodPalette(node);
  const bold = isVirtualContainerMethodNode(node);
  return `shape=image;imageAspect=0;image=${methodMosaicImage('end', palette.fill, palette.stroke, { width })};whiteSpace=wrap;html=1;labelPosition=center;align=center;verticalLabelPosition=middle;verticalAlign=middle;spacing=4;fontColor=#000000;${bold ? 'fontStyle=1;' : ''}`;
}

function expressionMosaicStyle(node, width) {
  const role = expressionMosaicRole(node);
  if (!role) return '';
  const partKind = expressionMosaicPartKind(node);
  if (partKind === 'receiver') {
    return `rounded=1;arcSize=14;whiteSpace=wrap;html=1;fillColor=${DRAWIO_PALETTE.valueFill};strokeColor=${DRAWIO_PALETTE.valueStroke};strokeWidth=1.5;fontColor=#000000;`;
  }
  if (partKind) {
    const callPart = node.labels.some((label) => ['Call', 'Request', 'Method', 'FnVisualProxy'].includes(label));
    const callPalette = methodPalette(node);
    const valuePart = partKind === 'value' && !callPart;
    const literalPart = partKind === 'literal' || node.labels.includes('Literal');
    const systemValuePart = isSystemValuePart(node);
    const operatorPart = partKind === 'operator';
    const fillColor = callPart
      ? callPalette.fill
      : literalPart
        ? DRAWIO_PALETTE.literalFill
        : valuePart ? DRAWIO_PALETTE.valueFill : '#ffffff';
    const strokeColor = callPart
      ? callPalette.stroke
      : literalPart
      ? (systemValuePart ? DRAWIO_PALETTE.systemActionStroke : DRAWIO_PALETTE.literalStroke)
      : valuePart
      ? DRAWIO_PALETTE.valueStroke
      : operatorPart
        ? DRAWIO_PALETTE.systemActionStroke
        : DRAWIO_PALETTE.actionStroke;
    const predicate = node.props?.expressionMosaicPredicate === true
      || node.props?.expression_mosaic_predicate === true;
    if (predicate) {
      const boundary = node.props?.horizontalMosaicBoundary
        || node.props?.horizontal_mosaic_boundary
        || 'middle';
      return `shape=image;imageAspect=0;image=${horizontalMosaicImage(boundary, fillColor, strokeColor, true, width)};whiteSpace=wrap;html=1;labelPosition=center;align=center;verticalLabelPosition=middle;verticalAlign=middle;spacing=4;fontColor=#000000;${partKind === 'operator' ? 'fontStyle=1;' : ''}`;
    }
    if (callPart) {
      const boundary = node.props?.horizontalMosaicBoundary
        || node.props?.horizontal_mosaic_boundary
        || 'middle';
      return `shape=image;imageAspect=0;image=${methodMosaicImage(boundary, fillColor, strokeColor, { width })};whiteSpace=wrap;html=1;labelPosition=center;align=center;verticalLabelPosition=middle;verticalAlign=middle;spacing=4;fontColor=#000000;`;
    }
    return `rounded=0;whiteSpace=wrap;html=1;fillColor=${fillColor};strokeColor=${strokeColor};strokeWidth=1.5;fontColor=#000000;${partKind === 'operator' ? 'fontStyle=1;' : ''}`;
  }
  const literal = node.labels.includes('Literal');
  const systemValue = hasLabel(node, 'SystemValue');
  const call = role !== 'operator'
    && node.labels.some((label) => ['Call', 'Request', 'Op', 'Method', 'FnVisualProxy'].includes(label));
  const variable = role !== 'operator'
    && (node.labels.includes('Variable') || node.labels.includes('ValueAccess') || node.labels.includes('ValueRead'));
  const callPalette = methodPalette(node);
  const fillColor = literal
    ? DRAWIO_PALETTE.literalFill
    : call
      ? callPalette.fill
      : variable
        ? DRAWIO_PALETTE.valueFill
        : role === 'operator'
          ? DRAWIO_PALETTE.expressionFill
          : DRAWIO_PALETTE.valueFill;
  const strokeColor = literal
    ? (systemValue ? DRAWIO_PALETTE.systemActionStroke : DRAWIO_PALETTE.literalStroke)
    : call
      ? callPalette.stroke
      : variable
        ? DRAWIO_PALETTE.valueStroke
        : role === 'operator'
          ? DRAWIO_PALETTE.systemActionStroke
          : DRAWIO_PALETTE.expressionStroke;
  const order = expressionMosaicOrder(node);
  const side = node.props?.horizontalMosaicBoundary
    || node.props?.horizontal_mosaic_boundary
    || (order === 0 ? 'start' : order === expressionMosaicSize(node) - 1 ? 'end' : 'middle');
  const image = call
    ? methodMosaicImage(side, fillColor, strokeColor, { width })
    : horizontalMosaicImage(side, fillColor, strokeColor, true, width);
  return `shape=image;imageAspect=0;image=${image};whiteSpace=wrap;html=1;labelPosition=center;align=center;verticalLabelPosition=middle;verticalAlign=middle;spacing=4;fontColor=#000000;${role === 'operator' ? 'fontStyle=1;' : ''}`;
}

function splitCallHasArguments(node) {
  return node.props?.callHasArguments ?? node.props?.call_has_arguments ?? true;
}

function renderPartsForNode(node) {
  if (node.labels.includes('HybridExhausted')) return [];
  const raw = node.props?.render_parts_json || node.props?.renderPartsJson;
  if (!raw) {
    // Cached graphs produced before literal writes became set mosaics still
    // carry the complete assignment text and ValueWrite semantics. Recover
    // the visual composition so nested-function diagrams do not regress to a
    // single solid rectangle while their extraction catches up.
    if (node.labels.includes('ValueWrite')) {
      const source = String(
        node.props?.action_text_raw
        || node.props?.actionTextRaw
        || node.props?.dia_name
        || node.props?.diaName
        || '',
      ).trim();
      const match = source.match(/^([A-Za-z_$][\w$]*)\s*=\s*(true|false|null|undefined|[-+]?\d+(?:\.\d+)?)\s*;?$/u);
      if (match) {
        const [, target, value] = match;
        return [
          { text: target, kind: 'value-container', labels: ['Value', 'Variable', 'ValueSlot'], fillState: 'empty' },
          { text: 'set(', kind: 'method', labels: ['Assignment', 'ContainerMethod', 'Method', 'Set', 'Virtual'] },
          { text: value, kind: 'literal', labels: ['Value', 'Literal'], fillState: 'filled' },
          { text: ')', kind: 'punctuation', labels: ['Assignment', 'CallBoundary', 'ContainerMethod', 'Method', 'Set', 'Virtual'] },
        ];
      }
    }
    return [];
  }
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function compactRenderPartWidth(part) {
  const text = String(part?.plainText || part?.text || '');
  const horizontalPadding = 6;
  const glyphWidth = [...text].reduce((width, character) => {
    if (/[mwMW@#%&]/u.test(character)) return width + 9;
    if (/[A-Z]/u.test(character)) return width + 8;
    if (/[ilI1|.,'`:;]/u.test(character)) return width + 3.5;
    if (/\s/u.test(character)) return width + 3.5;
    if (/[()[\]{}]/u.test(character)) return width + 4.5;
    return width + 6.5;
  }, 0);
  const estimatedTextWidth = Math.max(text.length * 6, glyphWidth);
  return Math.max(18, Math.ceil(estimatedTextWidth + horizontalPadding));
}

function structuredHorizontalPartWidth(node, part, index, count) {
  const baseWidth = compactRenderPartWidth(part);
  const text = String(part?.plainText || part?.text || '').trim();
  const arithmeticBoundary = (part?.labels || []).includes('ArithmeticBoundary');
  const callPart = part?.kind === 'method'
    || (text === ')' && !arithmeticBoundary)
    || (part?.labels || []).some((label) => ['Call', 'Request', 'Method', 'CallBoundary'].includes(label));
  if (!callPart) return baseWidth;
  const curvedSides = Number(index === 0) + Number(index === count - 1);
  return baseWidth + curvedSides * METHOD_CURVED_SIDE_DEPTH;
}

function isCompactInfixOperatorPart(part) {
  if (String(part?.kind || '') !== 'operator') return false;
  const labels = new Set(part?.labels || []);
  if (labels.has('LogicalNot') || labels.has('Spread') || labels.has('DataJoin')) return false;
  const text = String(part?.plainText || part?.text || '').trim();
  return !['!', '...', 'typeof', 'void', 'delete', 'await', '~', '++', '--'].includes(text);
}

function mosaicRenderPartHeight(part) {
  if (isCompactInfixOperatorPart(part)) return OPERATOR_MOSAIC_TILE_HEIGHT;
  return MOSAIC_TILE_HEIGHT;
}

function renderPartFontColor(part) {
  const text = String(part?.plainText || part?.text || '').trim();
  const literal = part?.kind === 'literal' || (part?.labels || []).includes('Literal');
  return literal && text === 'false' ? '#CC0000' : '#000000';
}

function predicateMosaicPartWidth(part, boundary = 'middle') {
  const tipCount = boundary === 'single'
    ? 2
    : boundary === 'start' || boundary === 'end'
      ? 1
      : 0;
  return compactRenderPartWidth(part) + tipCount * HEX_SIDE_DEPTH;
}

function variableNodeWidth(label) {
  const lines = String(label || '').split(/\r?\n/);
  if (lines.length > 1) {
    return Math.max(54, ...lines.map((line) => line.length * 7));
  }
  return Math.max(54, lines[0].length * 7 + 20);
}

function isVariableNode(node) {
  return node.labels.includes('Variable')
    || node.labels.includes('ValueSlot')
    || node.labels.includes('ComputedValue')
    || node.labels.includes('Parameter')
    || (node.labels.includes('LocalBinding') && node.labels.includes('ValueCreate'));
}

function isEmptyContainer(node, part = null) {
  const explicit = part?.fillState
    || node?.props?.fillState
    || node?.props?.fill_state
    || node?.props?.valueState
    || node?.props?.value_state;
  if (explicit) return String(explicit).toLowerCase() === 'empty';
  return hasLabel(node, 'ValueSlot')
    || hasLabels(node, 'LocalBinding', 'ValueCreate')
    || hasLabel(node, 'ResultTarget');
}

function isStandaloneVariableNode(node) {
  if (!node || expressionMosaicRole(node) || renderPartsForNode(node).length) return false;
  if (hasLabel(node, 'Collection') || hasLabel(node, 'Object') || hasLabel(node, 'Field') || hasLabel(node, 'Arg')) return false;
  if (['Call', 'Request', 'Method', 'Op', 'Fn', 'Branch'].some((label) => hasLabel(node, label))) return false;
  return isVariableNode(node)
    || hasLabel(node, 'ValueAccess')
    || hasLabel(node, 'ValueRead');
}

export function structuredHorizontalSize(node) {
  const layout = node.props?.render_parts_layout || node.props?.renderPartsLayout;
  const parts = renderPartsForNode(node);
  if (layout !== 'horizontal' || parts.length < 2) return null;
  const hexMosaic = node.labels.includes('Branch');
  const widths = parts.map((part, index) => (
    hexMosaic
      ? predicateMosaicPartWidth(part, index === 0 ? 'start' : index === parts.length - 1 ? 'end' : 'middle')
      : structuredHorizontalPartWidth(node, part, index, parts.length)
  ));
  return {
    parts,
    widths,
    heights: parts.map(mosaicRenderPartHeight),
    width: widths.reduce((sum, width) => sum + width, 0),
    height: node.labels.includes('Collection') ? 70 : MOSAIC_TILE_HEIGHT,
    hexMosaic,
  };
}

function structuredVerticalSize(node) {
  const layout = node.props?.render_parts_layout || node.props?.renderPartsLayout;
  const parts = renderPartsForNode(node);
  if (layout !== 'vertical' || parts.length < 2) return null;
  return {
    parts,
    heights: parts.map(mosaicRenderPartHeight),
    width: Math.max(...parts.map(compactRenderPartWidth)),
    height: parts.reduce((sum, part) => sum + mosaicRenderPartHeight(part), 0),
  };
}

function isInlineLiteralSetParts(parts) {
  return parts.length === 4
    && String(parts[0]?.kind || '').endsWith('-container')
    && parts[1]?.kind === 'method'
    && String(parts[1]?.text || '').endsWith('(')
    && parts[2]?.kind === 'literal'
    && parts[3]?.kind === 'punctuation';
}

function variableBoxWidth(label) {
  const lines = String(label || '').split(/\r?\n/);
  return Math.max(55, ...lines.map((line) => compactRenderPartWidth({ text: line }) + 12));
}

function variableBoxHeight(width, { open = false } = {}) {
  if (!open) return Math.max(40, Math.round(width * CLOSED_BOX_HEIGHT_TO_WIDTH_RATIO));
  return 40 + Math.min(10, Math.round(Math.max(0, width - 55) * 0.09));
}

function structuredContainerOverlaySize(node) {
  const layout = node.props?.render_parts_layout || node.props?.renderPartsLayout;
  const parts = renderPartsForNode(node);
  // Older extracted graphs described literal initialization as a vertical
  // overlay even though set(value) is a single inline call mosaic. Keep the
  // renderer compatible with those cached rows while newer extraction emits
  // container-overlay-side directly.
  const inlineLiteralSet = isInlineLiteralSetParts(parts);
  const sideBySide = layout === 'container-overlay-side' || inlineLiteralSet;
  if (layout !== 'container-overlay' && !sideBySide || parts.length < 2) return null;
  const container = parts[0];
  const storageContainer = container?.kind === 'storage-container';
  const collectionContainer = container?.kind === 'collection-container';
  const operationProviderContainer = container?.kind === 'operation-provider-container';
  const functionContainer = container?.kind === 'function-container';
  const variableContainer = !storageContainer
    && !collectionContainer
    && !operationProviderContainer
    && !functionContainer;
  const stackInset = 0;
  const overlays = parts.slice(1);
  const predicateOverlay = sideBySide && node.labels.includes('Branch');
  const overlayWidths = sideBySide
    ? overlays.map((part, index) => (
        predicateOverlay
          ? predicateMosaicPartWidth(
              part,
              index === 0 ? 'start' : index === overlays.length - 1 ? 'end' : 'middle',
            )
          : compactRenderPartWidth(part) + (
              part.kind === 'method'
                && index === overlays.length - 1
                && splitCallBoundarySide(node) === 'start'
                ? METHOD_CURVED_SIDE_DEPTH
                : 0
            )
      ))
    : overlays.map(() => Math.max(...overlays.map(compactRenderPartWidth)));
  const overlayWidth = sideBySide
    ? overlayWidths.reduce((sum, width) => sum + width, 0)
    : overlayWidths[0];
  const overlayHeights = overlays.map(mosaicRenderPartHeight);
  const overlayRowHeight = Math.max(...overlayHeights);
  const containerWidth = storageContainer
    ? Math.max(150, variableNodeWidth(container?.text))
    : functionContainer
      ? Math.max(
          variableNodeWidth(container?.text),
          compactRenderPartWidth(container) + METHOD_CURVED_SIDE_DEPTH * 2,
        )
      : variableContainer
        ? variableBoxWidth(container?.text)
        : variableNodeWidth(container?.text);
  const containerHeight = storageContainer
    ? 70
    : operationProviderContainer
      ? OPERATION_PROVIDER_CONTAINER_HEIGHT
      : collectionContainer
        ? 70
        : variableContainer
          ? variableBoxHeight(containerWidth, { open: container?.fillState === 'empty' })
          : 40;
  const overlayX = stackInset + (variableContainer
    ? Math.max(37, Math.round(containerWidth * 0.56))
    : Math.round(containerWidth / 2) + 12);
  const overlayY = stackInset + containerHeight - (variableContainer ? 10 : 13);
  return {
    parts,
    container,
    overlays,
    overlayHeights,
    overlayRowHeight,
    overlayWidths,
    sideBySide,
    collectionContainer,
    operationProviderContainer,
    functionContainer,
    stackInset,
    containerX: stackInset,
    containerY: stackInset,
    containerWidth,
    containerHeight,
    overlayWidth,
    overlayX,
    overlayY,
    width: Math.max(stackInset + containerWidth, overlayX + overlayWidth),
    height: overlayY + (sideBySide ? overlayRowHeight : overlayHeights.reduce((sum, height) => sum + height, 0)),
  };
}

function structuredContainerPartStyle(node, part, height = 40) {
  if (part?.kind === 'function-container') {
    return methodNodeStyle(node, 'single', Math.max(
      variableNodeWidth(part?.text),
      compactRenderPartWidth(part) + METHOD_CURVED_SIDE_DEPTH * 2,
    ));
  }
  if (part?.kind === 'operation-provider-container') {
    return operationProviderStackStyle((part?.labels || []).includes('SystemProvider'));
  }
  if (part?.kind === 'storage-container') {
    return 'shape=datastore;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#666666;strokeWidth=1.5;fontColor=#000000;fontStyle=1;';
  }
  const collection = part?.kind === 'collection-container';
  return boxNodeStyle({
    open: part?.fillState === 'empty',
    collection,
    height,
    sketch: isVirtualValueContainerNode(node)
      || (isEmptyContainer(node, part) && isInlineLiteralSetParts(renderPartsForNode(node))),
  });
}

function structuredContainerOverlayMethodIndex(layout) {
  if (!layout) return -1;
  const callableIndex = layout.overlays.findLastIndex((part) => (
    part.kind === 'method'
    && !(part.labels || []).some((label) => ['Keyword', 'Await', 'CallBoundary'].includes(label))
  ));
  return callableIndex >= 0
    ? callableIndex
    : layout.overlays.findIndex((part) => part.kind === 'method');
}

function isExpandedOperationProviderCall(node) {
  const layout = node?.props?.render_parts_layout || node?.props?.renderPartsLayout || '';
  return layout === 'container-overlay-side'
    && hasLabel(node, 'OperationProvider')
    && splitCallBoundarySide(node) === 'start';
}

function mosaicFieldAccessAlignment(part, nextPart) {
  const standaloneLogicalNot = String(part?.plainText || part?.text || '').trim() === '!'
    && (part?.labels || []).includes('LogicalNot');
  if (standaloneLogicalNot) {
    return 'align=right;spacing=0;spacingLeft=0;spacingRight=2;overflow=hidden;';
  }
  const fieldAccess = (part?.labels || []).includes('FieldAccess');
  const followedByFieldAccess = (nextPart?.labels || []).includes('FieldAccess');
  if (fieldAccess) return 'align=left;spacing=0;spacingLeft=3;spacingRight=0;overflow=hidden;';
  if (followedByFieldAccess) return 'align=right;spacing=0;spacingLeft=0;spacingRight=3;overflow=hidden;';
  return 'align=center;';
}

function structuredContainerOverlayPartStyle(
  node,
  part,
  index,
  count,
  sideBySide = false,
  width = 100,
  nextPart = null,
) {
  if (part?.kind === 'operation-provider-container') {
    const side = index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle';
    const systemProvider = (part?.labels || []).includes('SystemProvider');
    const fillColor = systemProvider
      ? DRAWIO_PALETTE.systemActionFill
      : DRAWIO_PALETTE.operationProviderFill;
    const strokeColor = systemProvider
      ? DRAWIO_PALETTE.systemActionStroke
      : DRAWIO_PALETTE.operationProviderStroke;
    const image = horizontalMosaicImage(side, fillColor, strokeColor, false, width);
    return `shape=image;imageAspect=0;image=${image};whiteSpace=wrap;html=1;labelPosition=center;verticalLabelPosition=middle;verticalAlign=middle;spacing=3;align=center;fontColor=#000000;fontStyle=1;`;
  }
  const arithmeticBoundary = (part?.labels || []).includes('ArithmeticBoundary');
  const callBoundary = (part?.labels || []).includes('CallBoundary')
    || (String(part?.text || '') === ')' && !arithmeticBoundary);
  const method = part?.kind === 'method' || callBoundary;
  const punctuation = part?.kind === 'punctuation';
  const operator = part?.kind === 'operator';
  const systemSpread = operator && (part?.labels || []).includes('SystemSpread');
  const literal = part?.kind === 'literal' || (part?.labels || []).includes('Literal');
  const systemValue = isSystemValuePart(part);
  const developerDefinedType = (part?.labels || []).includes('Type')
    && (part?.labels || []).includes('DeveloperDefined');
  const systemType = (part?.labels || []).includes('Type')
    && (part?.labels || []).includes('System');
  const virtualValue = part?.kind === 'virtual-value'
    || (part?.labels || []).includes('Virtual');
  const virtualMethod = method && (
    isVirtualContainerMethodNode(node) || (part?.labels || []).includes('Virtual')
  );
  const systemMethod = method && (part?.labels || []).includes('System');
  const systemProviderMethod = method && (
    hasLabel(node, 'SystemProvider')
    || (part?.labels || []).includes('SystemProvider')
  );
  const operationProviderMethod = method && (
    hasLabel(node, 'OperationProvider')
    || (part?.labels || []).includes('OperationProvider')
  );
  const typeAnnotationMethod = method && (part?.labels || []).includes('TypeAnnotation');
  const callPalette = virtualMethod
    ? virtualMethodPalette()
    : systemProviderMethod
    ? { fill: DRAWIO_PALETTE.systemActionFill, stroke: DRAWIO_PALETTE.systemActionStroke }
    : systemMethod
    ? { fill: DRAWIO_PALETTE.systemActionFill, stroke: DRAWIO_PALETTE.systemActionStroke }
    : operationProviderMethod
    ? { fill: DRAWIO_PALETTE.operationProviderFill, stroke: DRAWIO_PALETTE.operationProviderStroke }
    : methodPalette(node, virtualMethod);
  const providerType = (part?.labels || []).includes('ProviderType');
  const fillColor = method
    ? callPalette.fill
    : developerDefinedType
      ? DRAWIO_PALETTE.developerDefinedTypeFill
    : providerType
      ? DRAWIO_PALETTE.actionFill
    : systemType
      ? DRAWIO_PALETTE.systemActionFill
    : systemSpread
      ? DRAWIO_PALETTE.systemActionFill
    : punctuation || operator || literal
      ? DRAWIO_PALETTE.literalFill
    : part?.fillState === 'empty' ? '#ffffff' : DRAWIO_PALETTE.valueFill;
  const strokeColor = method
    ? callPalette.stroke
    : developerDefinedType
      ? DRAWIO_PALETTE.developerDefinedTypeStroke
    : providerType
      ? DRAWIO_PALETTE.actionStroke
    : systemType
      ? DRAWIO_PALETTE.systemActionStroke
    : literal
      ? (systemValue ? DRAWIO_PALETTE.systemActionStroke : DRAWIO_PALETTE.literalStroke)
      : systemSpread || operator
        ? DRAWIO_PALETTE.systemActionStroke
      : punctuation
        ? callPalette.stroke
        : DRAWIO_PALETTE.valueStroke;
  const splitBoundary = splitCallBoundarySide(node);
  if (method && count === 1) {
    return `shape=image;imageAspect=0;image=${methodMosaicImage(splitBoundary || 'single', fillColor, strokeColor, {
      sketch: virtualMethod,
      torn: Boolean(splitBoundary),
      width,
    })};whiteSpace=wrap;html=1;labelPosition=center;align=center;verticalLabelPosition=middle;verticalAlign=middle;spacing=3;fontColor=#000000;${operationProviderMethod ? '' : 'fontStyle=1;'}`;
  }
  const pullMethod = method && (part?.labels || []).some((label) => label === 'Pull' || label === 'Pop');
  if (pullMethod) {
    return `shape=image;imageAspect=0;image=${methodMosaicImage('single', fillColor, strokeColor, { sketch: virtualMethod, width })};whiteSpace=wrap;html=1;labelPosition=center;align=center;verticalLabelPosition=middle;verticalAlign=middle;spacing=3;fontColor=#000000;fontStyle=1;`;
  }
  const side = index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle';
  const familyBoundary = splitBoundary === 'start' && index === count - 1
    ? 'torn-right'
    : splitBoundary === 'end' && index === 0
      ? 'torn-left'
      : '';
  const predicateOverlay = sideBySide && node.labels.includes('Branch');
  const image = sideBySide
    ? method && !predicateOverlay
      ? methodMosaicImage(familyBoundary || side, fillColor, strokeColor, {
          sketch: virtualMethod,
          width,
        })
      : horizontalMosaicImage(side, fillColor, strokeColor, predicateOverlay, width, virtualValue)
    : verticalMosaicImage(side, fillColor, strokeColor);
  const bold = virtualMethod || typeAnnotationMethod || operator;
  return `shape=image;imageAspect=0;image=${image};whiteSpace=wrap;html=1;labelPosition=center;verticalLabelPosition=middle;verticalAlign=middle;spacing=3;${mosaicFieldAccessAlignment(part, nextPart)}fontColor=${renderPartFontColor(part)};${bold ? 'fontStyle=1;' : ''}`;
}

function structuredContainerOverlayPartBox(node, box, role) {
  const layout = structuredContainerOverlaySize(node);
  if (!layout || !box) return box;
  const scaleX = box.width / layout.width;
  const scaleY = box.height / layout.height;
  if (role === 'container') {
    return {
      x: box.x + layout.containerX * scaleX,
      y: box.y + layout.containerY * scaleY,
      width: layout.containerWidth * scaleX,
      height: layout.containerHeight * scaleY,
    };
  }
  if (role === 'overlay') {
    return {
      x: box.x + layout.overlayX * scaleX,
      y: box.y + layout.overlayY * scaleY,
      width: (layout.width - layout.overlayX) * scaleX,
      height: (layout.sideBySide
        ? layout.overlayRowHeight
        : layout.overlayHeights.reduce((sum, height) => sum + height, 0)) * scaleY,
    };
  }
  const methodIndex = structuredContainerOverlayMethodIndex(layout);
  if (methodIndex < 0) return box;
  const precedingHeight = layout.sideBySide ? 0 : layout.overlayHeights
    .slice(0, methodIndex)
    .reduce((sum, height) => sum + height, 0);
  const precedingWidth = layout.sideBySide ? layout.overlayWidths
    .slice(0, methodIndex)
    .reduce((sum, width) => sum + width, 0) : 0;
  const methodWidth = !layout.sideBySide || methodIndex === layout.overlays.length - 1
    ? layout.width - layout.overlayX - precedingWidth
    : layout.overlayWidths[methodIndex];
  return {
    x: box.x + (layout.overlayX + precedingWidth) * scaleX,
    y: box.y + (layout.overlayY + precedingHeight
      + (layout.sideBySide ? (layout.overlayRowHeight - layout.overlayHeights[methodIndex]) / 2 : 0)) * scaleY,
    width: methodWidth * scaleX,
    height: layout.overlayHeights[methodIndex] * scaleY,
  };
}

function containerOverlayEndpointCell(node, cellId, edge, endpoint) {
  if (!node || !cellId) return cellId;
  const layout = structuredContainerOverlaySize(node);
  if (!layout) return cellId;
  const edgeType = edge?.type || '';
  const protocolRole = edge?.props?.protocolRole || edge?.props?.protocol_role || '';
  const methodIndex = structuredContainerOverlayMethodIndex(layout);
  const methodCellId = methodIndex >= 0 ? `${cellId}-part-${methodIndex + 2}` : cellId;
  const objectOpeningIndex = layout.overlays.findIndex((part) => part.text === '{');
  const objectOpeningCellId = objectOpeningIndex >= 0
    ? `${cellId}-part-${objectOpeningIndex + 2}`
    : cellId;
  const endpointPart = containerOverlayEndpointPart(node, edge, endpoint);
  if (endpointPart === 'method') return methodCellId;
  if (endpointPart === 'container') return `${cellId}-part-1`;
  if (endpointPart === 'overlay') return `${cellId}-predicate-overlay`;
  const flowLayer = edge?.props?.flowLayer || edge?.props?.flow_layer || '';
  const producerRouteRole = edge?.props?.producerRouteRole || edge?.props?.producer_route_role || '';
  if (
    endpoint === 'target'
    && (producerRouteRole === 'return-top' || producerRouteRole === 'return-bottom')
  ) {
    return methodCellId;
  }
  const controlEdge = flowLayer === 'control'
    || ['NEXT', 'ASYNC', 'CATCH', 'TRUE', 'FALSE', 'REJOINS', 'REPEATS', 'ENTERS'].includes(edgeType);
  const controlThroughMethod = !node.labels.includes('Branch') && (node.labels.includes('Collection')
    || node.labels.includes('Storage')
    || node.labels.includes('Store')
    || node.labels.includes('StatefulOperation')
    || node.labels.includes('OperationProvider'));
  const controlThroughContainer = isExpandedOperationProviderCall(node)
    || hasLabels(node, 'OperationProvider', 'Parameter')
    || layout.operationProviderContainer
    || hasLabel(node, 'FnDeclaration');
  if (controlEdge) return controlThroughContainer
    ? `${cellId}-part-1`
    : controlThroughMethod ? methodCellId : cellId;
  if (endpoint === 'source' && edgeType === 'FIELD') return objectOpeningCellId;
  if (
    endpoint === 'source'
    && edgeType === 'YIELDS_VALUE'
    && protocolRole !== 'collection-source-value'
  ) {
    return methodCellId;
  }
  if (endpoint === 'target' && protocolRole === 'collection-shift-eval') {
    return methodCellId;
  }
  if (
    endpoint === 'target'
    && (
      edgeType === 'ASSIGNS_VALUE'
      || (['YIELDS_VALUE', 'EMITS_VALUE'].includes(edgeType) && protocolRole !== 'collection-source-value')
      || protocolRole === 'assignment-return'
    )
  ) {
    return methodCellId;
  }
  return cellId;
}

function structuredContainerOverlaySiblingPartBoxes(node, box, activeStableId) {
  const layout = structuredContainerOverlaySize(node);
  if (!layout || !box || !activeStableId) return [];
  const activeIndex = layout.overlays.findIndex((part) => part.stableId === activeStableId);
  if (activeIndex < 0 && layout.container.stableId !== activeStableId) return [];
  const scaleX = box.width / layout.width;
  const scaleY = box.height / layout.height;
  let precedingWidth = 0;
  let precedingHeight = 0;
  return layout.overlays.flatMap((part, index) => {
    const width = layout.sideBySide
      ? index === layout.overlays.length - 1
        ? layout.width - layout.overlayX - precedingWidth
        : layout.overlayWidths[index]
      : layout.overlayWidth;
    const slotHeight = layout.sideBySide
      ? layout.overlayRowHeight
      : layout.overlayHeights[index];
    const height = layout.sideBySide
      ? Math.min(mosaicRenderPartHeight(part), slotHeight)
      : slotHeight;
    const partBox = {
      id: `overlay-render-part:${node.id}:${index}`,
      left: box.x + (layout.overlayX + precedingWidth) * scaleX,
      right: box.x + (layout.overlayX + precedingWidth + width) * scaleX,
      top: box.y + (layout.overlayY + precedingHeight
        + (layout.sideBySide ? (slotHeight - height) / 2 : 0)) * scaleY,
      bottom: box.y + (layout.overlayY + precedingHeight
        + (layout.sideBySide ? (slotHeight - height) / 2 : 0) + height) * scaleY,
    };
    if (layout.sideBySide) precedingWidth += width;
    else precedingHeight += height;
    return index === activeIndex ? [] : [partBox];
  });
}

function isPushCollectionOverlay(node, layout = structuredContainerOverlaySize(node)) {
  if (!layout || !hasLabel(node, 'Collection')) return false;
  return layout.overlays.some((part) => (
    part.kind === 'method'
    && /^push\s*\(/u.test(String(part.text || '').trim())
  ));
}

function isValueRoutingEdge(edge) {
  const type = String(edge?.type || '');
  if (type === 'EVAL') return false;
  return flowLayerForGraphItem(edge, 'control') === 'data'
    || type === 'VALUE'
    || type.endsWith('_VALUE');
}

function containerOverlayEndpointPart(node, edge, endpoint) {
  const layout = structuredContainerOverlaySize(node);
  if (!layout) return '';
  const explicitPartStableId = endpoint === 'source'
    ? edge?.props?.sourceRenderPartStableId || edge?.props?.source_render_part_stable_id
    : edge?.props?.targetRenderPartStableId || edge?.props?.target_render_part_stable_id;
  if (explicitPartStableId) {
    const explicitPart = layout.parts.find((part) => part.stableId === explicitPartStableId);
    if (explicitPart === layout.container) return 'container';
    if (explicitPart?.kind === 'method') return 'method';
    if (explicitPart) return 'overlay';
  }
  // External control flow addresses the collection as a whole. Internal loop
  // flow names its method render part explicitly and is resolved above.
  if (isPushCollectionOverlay(node, layout) && !isValueRoutingEdge(edge)) return 'container';
  const edgeType = edge?.type || '';
  const protocolRole = edge?.props?.protocolRole || edge?.props?.protocol_role || '';
  const producerRouteRole = edge?.props?.producerRouteRole || edge?.props?.producer_route_role || '';
  const flowLayer = edge?.props?.flowLayer || edge?.props?.flow_layer || '';
  const hasMethod = layout.overlays.some((part) => part.kind === 'method');
  const assignmentContainer = hasMethod
    && node.labels.includes('Assignment')
    && (node.labels.includes('Set') || node.labels.includes('ContainerMethod'));
  const controlEdge = flowLayer === 'control'
    || ['NEXT', 'ASYNC', 'CATCH', 'TRUE', 'FALSE', 'REJOINS', 'REPEATS', 'ENTERS'].includes(edgeType);
  if (hasLabel(node, 'IndexedWrite') && controlEdge) return 'container';
  const controlThroughMethod = !node.labels.includes('Branch') && (node.labels.includes('Collection')
    || node.labels.includes('Storage')
    || node.labels.includes('Store')
    || node.labels.includes('StatefulOperation')
    || node.labels.includes('OperationProvider'));
  const controlThroughContainer = isExpandedOperationProviderCall(node)
    || hasLabels(node, 'OperationProvider', 'Parameter')
    || layout.operationProviderContainer
    || hasLabel(node, 'FnDeclaration');
  if (
    edgeType === 'NEXT'
    && node.labels.includes('Collection')
    && isEmptyContainer(node, layout.container)
  ) return 'container';
  if (
    endpoint === 'source'
    && edgeType === 'ARG'
    && splitCallBoundarySide(node) === 'start'
  ) return hasMethod ? 'method' : '';
  if (controlEdge && node.labels.includes('Branch') && layout.sideBySide) return 'overlay';
  if (endpoint === 'target' && (
    producerRouteRole === 'return-top'
    || producerRouteRole === 'return-bottom'
    || protocolRole === 'assignment-return'
    || protocolRole === 'collection-shift-eval'
    || (edgeType === 'EVAL' && controlThroughMethod)
    || edgeType === 'ASSIGNS_VALUE'
    || (['YIELDS_VALUE', 'EMITS_VALUE'].includes(edgeType) && protocolRole !== 'collection-source-value')
  )) return hasMethod ? 'method' : '';
  if (
    endpoint === 'source'
    && ['ASSIGNS_VALUE', 'YIELDS_VALUE', 'EMITS_VALUE'].includes(edgeType)
    && protocolRole !== 'collection-source-value'
  ) {
    return hasMethod ? 'method' : '';
  }
  if (controlEdge) {
    if (node.labels.includes('Branch')) return '';
    if (controlThroughContainer) return 'container';
    return controlThroughMethod && hasMethod ? 'method' : 'container';
  }
  if (endpoint === 'source' && (edgeType === 'EVAL' || edgeType === 'NEXT')) return 'container';
  return '';
}

function structuredRenderPartStyle(node, part, index, count, width) {
  if (node.labels.includes('Collection') && index === 0) {
    return collectionLayerStyle(part?.fillState === 'empty', isVirtualResultNode(node));
  }
  const kind = String(part?.kind || 'value');
  const text = String(part?.plainText || part?.text || '').trim();
  const side = index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle';
  const arithmeticBoundary = (part?.labels || []).includes('ArithmeticBoundary');
  const callPart = (text === ')' && !arithmeticBoundary)
    || kind === 'method'
    || (part?.labels || []).some((label) => ['Call', 'Request', 'Method', 'CallBoundary'].includes(label));
  const literalPart = kind === 'literal';
  const systemValuePart = isSystemValuePart(part);
  const operatorPart = kind === 'operator';
  const punctuationPart = kind === 'punctuation';
  const typeSeparatorPart = (part?.labels || []).includes('TypeSeparator');
  const developerDefinedTypePart = (part?.labels || []).includes('Type')
    && (part?.labels || []).includes('DeveloperDefined');
  const systemTypePart = (part?.labels || []).includes('Type')
    && (part?.labels || []).includes('System');
  const failurePart = (part?.labels || []).includes('FailureBinding')
    || (part?.labels || []).includes('Failure');
  const namedSlotPart = (part?.labels || []).some((label) => (
    label === 'FieldName' || label === 'ArgumentName'
  ));
  const keywordPart = (part?.labels || []).includes('Keyword');
  const virtualMethod = callPart && (
    isVirtualContainerMethodNode(node) || (part?.labels || []).includes('Virtual')
  );
  const operationProviderPart = hasLabel(node, 'OperationProvider')
    || (part?.labels || []).includes('OperationProvider');
  const systemCallPart = isSystemMethodNode(node) || (part?.labels || []).includes('System');
  const systemProviderPart = (part?.labels || []).includes('SystemProvider');
  const systemProviderCallContext = callPart && (
    hasLabel(node, 'SystemProvider') || systemProviderPart
  );
  const callPalette = virtualMethod
    ? virtualMethodPalette()
    : systemProviderCallContext
    ? {
        fill: DRAWIO_PALETTE.systemActionFill,
        stroke: DRAWIO_PALETTE.systemActionStroke,
      }
    : operationProviderPart
    ? {
        fill: DRAWIO_PALETTE.operationProviderFill,
        stroke: DRAWIO_PALETTE.operationProviderStroke,
      }
    : systemCallPart
    ? {
        fill: DRAWIO_PALETTE.systemActionFill,
        stroke: DRAWIO_PALETTE.systemActionStroke,
      }
    : methodPalette(node, virtualMethod);
  const providerTypePart = (part?.labels || []).includes('ProviderType');
  const typeAnnotationPart = (part?.labels || []).includes('TypeAnnotation');
  const fillColor = part?.fillState === 'empty'
    ? '#ffffff'
    : failurePart
    ? '#f8cecc'
    : callPart
    ? callPalette.fill
    : developerDefinedTypePart
      ? DRAWIO_PALETTE.developerDefinedTypeFill
    : providerTypePart
      ? DRAWIO_PALETTE.actionFill
    : systemTypePart
      ? DRAWIO_PALETTE.systemActionFill
    : systemProviderPart
      ? DRAWIO_PALETTE.systemActionFill
    : literalPart
      ? DRAWIO_PALETTE.literalFill
      : operatorPart || punctuationPart
        ? DRAWIO_PALETTE.expressionFill
        : DRAWIO_PALETTE.valueFill;
  const strokeColor = callPart
    ? callPalette.stroke
    : developerDefinedTypePart
      ? DRAWIO_PALETTE.developerDefinedTypeStroke
    : providerTypePart
      ? DRAWIO_PALETTE.actionStroke
    : systemTypePart
      ? DRAWIO_PALETTE.systemActionStroke
    : failurePart
      ? '#CC0000'
    : systemProviderPart
      ? DRAWIO_PALETTE.systemActionStroke
    : typeSeparatorPart
      ? DRAWIO_PALETTE.systemActionStroke
    : operatorPart
      ? DRAWIO_PALETTE.systemActionStroke
      : punctuationPart
        ? DRAWIO_PALETTE.expressionStroke
      : literalPart
        ? (systemValuePart ? DRAWIO_PALETTE.systemActionStroke : DRAWIO_PALETTE.literalStroke)
        : DRAWIO_PALETTE.valueStroke;
  const predicate = node.labels.includes('Branch')
    || node.labels.includes('Predicate')
    || node.props?.callPredicate === true
    || node.props?.call_predicate === true
    || node.props?.expressionMosaicPredicate === true
    || node.props?.expression_mosaic_predicate === true;
  const splitBoundary = splitCallBoundarySide(node);
  const familyBoundary = splitBoundary === 'start' && index === count - 1
    ? 'torn-right'
    : splitBoundary === 'end' && index === 0
      ? 'torn-left'
      : '';
  const image = familyBoundary && !predicate
    ? methodMosaicImage(familyBoundary, fillColor, strokeColor, {
        sketch: virtualMethod,
        width,
      })
    : callPart && isVirtualCollectionPrimitiveNode(node)
    ? methodMosaicImage(side, callPalette.fill, strokeColor, { sketch: true, width })
    : callPart && !predicate && (!keywordPart
      || ((part?.labels || []).includes('Return') && (part?.labels || []).includes('CallBoundary')))
      ? methodMosaicImage(side, fillColor, strokeColor, {
          sketch: virtualMethod,
          torn: (node.props?.callBoundaryDesign || node.props?.call_boundary_design) === 'split'
            && (side === 'start' || side === 'end'),
          width,
        })
      : horizontalMosaicImage(side, fillColor, strokeColor, predicate, width);
  const nextPart = renderPartsForNode(node)[index + 1];
  return `shape=image;imageAspect=0;image=${image};whiteSpace=wrap;html=1;labelPosition=center;verticalLabelPosition=middle;verticalAlign=middle;spacing=4;${mosaicFieldAccessAlignment(part, nextPart)}fontColor=${failurePart ? '#CC0000' : renderPartFontColor(part)};${namedSlotPart ? 'fontStyle=2;' : typeAnnotationPart || operatorPart || systemProviderPart && !callPart ? 'fontStyle=1;' : ''}`;
}

function structuredHorizontalPartBox(node, box, kind) {
  const layout = structuredHorizontalSize(node);
  if (!layout || !box) return box;
  const index = layout.parts.findIndex((part) => part.kind === kind);
  if (index < 0) return box;
  const scaleX = box.width / layout.width;
  const precedingWidth = layout.widths
    .slice(0, index)
    .reduce((sum, width) => sum + width, 0);
  return {
    x: box.x + precedingWidth * scaleX,
    y: box.y,
    width: layout.widths[index] * scaleX,
    height: box.height,
  };
}

function structuredHorizontalEndpointPartIndex(node, edge, endpoint) {
  const layout = structuredHorizontalSize(node);
  if (!layout) return -1;
  const stableId = endpoint === 'source'
    ? edge?.props?.sourceRenderPartStableId || edge?.props?.source_render_part_stable_id
    : edge?.props?.targetRenderPartStableId || edge?.props?.target_render_part_stable_id;
  if (!stableId) return -1;
  return layout.parts.findIndex((part) => part.stableId === stableId);
}

function structuredHorizontalPartBoxAtIndex(node, box, index) {
  const layout = structuredHorizontalSize(node);
  if (!layout || !box || index < 0) return null;
  const scaleX = box.width / layout.width;
  const scaleY = box.height / layout.height;
  const precedingWidth = layout.widths
    .slice(0, index)
    .reduce((sum, width) => sum + width, 0);
  const partHeight = layout.heights[index];
  return {
    x: box.x + precedingWidth * scaleX,
    y: box.y + (layout.height - partHeight) / 2 * scaleY,
    width: layout.widths[index] * scaleX,
    height: partHeight * scaleY,
  };
}

function structuredHorizontalEndpointPartBox(node, box, edge, endpoint) {
  return structuredHorizontalPartBoxAtIndex(
    node,
    box,
    structuredHorizontalEndpointPartIndex(node, edge, endpoint),
  );
}

function structuredHorizontalEndpointCell(node, cellId, edge, endpoint) {
  if (!node || !cellId) return cellId;
  const layout = structuredHorizontalSize(node);
  if (endpoint === 'source'
    && isFlowBranchNode(node)
    && (edge?.type === 'TRUE' || edge?.type === 'FALSE')) {
    return cellId;
  }
  const requestedPartIndex = structuredHorizontalEndpointPartIndex(node, edge, endpoint);
  if (requestedPartIndex >= 0) return `${cellId}-part-${requestedPartIndex + 1}`;
  if (endpoint === 'source' && edge?.type === 'FIELD') {
    const objectOpeningIndex = layout?.parts.findIndex((part) => part.text === '{') ?? -1;
    return objectOpeningIndex >= 0 ? `${cellId}-part-${objectOpeningIndex + 1}` : cellId;
  }
  if (endpoint !== 'target') return cellId;
  const protocolRole = edge?.props?.protocolRole || edge?.props?.protocol_role || '';
  if (protocolRole !== 'iteration-pass') return cellId;
  const methodIndex = layout?.parts.findIndex((part) => part.kind === 'method') ?? -1;
  return methodIndex >= 0 ? `${cellId}-part-${methodIndex + 1}` : cellId;
}

function structuredVerticalPartStyle(node, part, index, count) {
  const kind = String(part?.kind || 'value');
  const method = kind === 'method';
  const callPalette = methodPalette(node);
  const fillColor = method ? callPalette.fill : DRAWIO_PALETTE.valueFill;
  const strokeColor = method ? callPalette.stroke : DRAWIO_PALETTE.valueStroke;
  const side = index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle';
  return `shape=image;imageAspect=0;image=${verticalMosaicImage(side, fillColor, strokeColor)};whiteSpace=wrap;html=1;labelPosition=center;align=center;verticalLabelPosition=middle;verticalAlign=middle;spacing=3;fontColor=${renderPartFontColor(part)};${method ? 'fontStyle=1;' : ''}`;
}

function structuredObjectMethodVisual(node) {
  const layout = node.props?.render_parts_layout || node.props?.renderPartsLayout;
  const raw = node.props?.render_parts_json || node.props?.renderPartsJson;
  if (layout !== 'diagonal' || !raw) return null;
  let parts;
  try {
    parts = renderPartsForNode(node);
  } catch {
    return null;
  }
  if (!Array.isArray(parts) || parts.length < 2) return null;
  const primaryIndex = Math.max(0, Math.min(
    parts.length - 1,
    Number(node.props?.render_primary_part_index ?? node.props?.renderPrimaryPartIndex ?? parts.length - 1),
  ));
  const methodParts = parts.filter((part) => part.kind === 'method');
  if (!methodParts.length) return null;
  const receiverParts = parts.slice(0, primaryIndex).filter((part) => part.kind !== 'punctuation');
  // A diagonal parts layout alone does not imply an object method. Plain
  // calls also use it for their method/argument mosaic; without a distinct
  // receiver, drawing a backing layer duplicates the call inside itself.
  if (!receiverParts.length) return null;
  const receiver = receiverParts.map((part) => part.text).filter(Boolean).join('.') || parts[0].text;
  const methods = methodParts.map((part) => {
    const text = String(part.text || 'method()');
    const name = text.replace(/\([^]*$/u, '').trim() || 'method';
    return {
      name,
      label: truncateLabel(text, 64),
      methodStableId: part.sourceStableId || part.stableId || '',
      methodSourceStableId: part.canonicalStableId || '',
    };
  });
  return {
    receiver: truncateLabel(receiver, 40),
    receiverStableId: receiverParts[0]?.sourceStableId || receiverParts[0]?.stableId || '',
    receiverSourceStableId: receiverParts[0]?.canonicalStableId || '',
    receiverLabels: receiverParts.flatMap((part) => part.labels || []),
    methods,
    methodLabel: methods.at(-1)?.label || '',
    graphBacked: true,
  };
}

function objectMethodVisual(node) {
  if (
    node.labels.includes('HybridExhausted')
    || (node.props?.hybridVisualRole || node.props?.hybrid_visual_role) === 'exhausted-marker'
  ) return null;
  if (isVisualProxyNode(node) || node.props?.visualCallStub) return null;
  if (
    expressionMosaicRole(node)
    && !(node.props?.expressionMosaicReceiverBacking || node.props?.expression_mosaic_receiver_backing)
  ) return null;
  if (methodChainRole(node)) return null;
  if (node.props?.suppressObjectMethodVisual) return null;
  if ((node.props?.callMosaicRole || node.props?.call_mosaic_role) === 'open') return null;
  if (!node.labels.some((label) => ['Call', 'Request', 'Op'].includes(label))) return null;

  const structuredVisual = structuredObjectMethodVisual(node);
  if (structuredVisual) return structuredVisual;

  const graphVisual = node.props?.graphMethodVisual;
  if (graphVisual?.receiver && graphVisual?.method) {
    if (graphVisual.compositionKind === 'producer-expression') {
      const expression = truncateLabel(graphVisual.method, 64);
      return {
        receiver: truncateLabel(graphVisual.receiver, 40),
        receiverStableId: graphVisual.receiverStableId || '',
        receiverSourceStableId: graphVisual.receiverSourceStableId || '',
        receiverLabels: graphVisual.receiverLabels || [],
        methods: [{
          name: expression,
          label: expression,
          methodStableId: graphVisual.methodStableId || node.id,
          methodSourceStableId: graphVisual.methodSourceStableId || '',
        }],
        methodLabel: expression,
        graphBacked: true,
        compositionKind: graphVisual.compositionKind,
      };
    }
    const methodName = String(graphVisual.method).replace(/\([^]*$/u, '').trim() || 'method';
    const isOpeningMethod = splitCallBoundarySide(node) === 'start';
    const isHybridOpeningMethod = node.props?.hybridOpenCallBoundary === true;
    const methodLabel = isOpeningMethod
      ? `${methodName}(`
      : isHybridOpeningMethod
        ? `${methodName}(`
        : `${methodName}()`;
    return {
      receiver: truncateLabel(graphVisual.receiver, 32),
      receiverStableId: graphVisual.receiverStableId || '',
      receiverSourceStableId: graphVisual.receiverSourceStableId || '',
      receiverLabels: graphVisual.receiverLabels || [],
      methods: [{
        name: methodName,
        label: methodLabel,
        methodStableId: graphVisual.methodStableId || '',
        methodSourceStableId: graphVisual.methodSourceStableId || '',
      }],
      methodLabel,
      graphBacked: true,
    };
  }

  const callText = String(node.props?.call_text_raw || node.props?.action_text_raw || '').trim();
  const chain = parseObjectMethodChain(callText);
  if (!chain) return null;
  const methods = chain.methods.map((method, index) => {
    const isOpeningMethod = splitCallBoundarySide(node) === 'start'
      && index === chain.methods.length - 1;
    return {
      ...method,
      label: isOpeningMethod
        ? `${method.name}(`
        : node.props?.visualExpandedExpression
          ? method.name
          : `${method.name}${method.arguments}`,
    };
  });
  return {
    receiver: truncateLabel(chain.receiver, 32),
    receiverStart: chain.receiverStart,
    receiverEnd: chain.receiverEnd,
    methods,
    methodLabel: methods.at(-1).label,
  };
}

function parseObjectMethodChain(text) {
  const source = String(text || '').trim();
  const firstMethod = source.match(/(?:\?\.|\.)\s*([#A-Za-z_$][\w$]*)\s*\(/u);
  if (!firstMethod || firstMethod.index === undefined) return null;
  const receiverRaw = source.slice(0, firstMethod.index);
  const receiver = receiverRaw.trim();
  if (!/^[A-Za-z_$][\w$]*(?:(?:\?\.|\.)[#A-Za-z_$][\w$]*)*$/u.test(receiver)) return null;

  const methods = [];
  let cursor = firstMethod.index;
  while (cursor < source.length) {
    const methodMatch = source.slice(cursor).match(/^(?:\?\.|\.)\s*([#A-Za-z_$][\w$]*)\s*\(/u);
    if (!methodMatch) break;
    const name = methodMatch[1];
    const nameOffset = methodMatch[0].lastIndexOf(name);
    const openIndex = cursor + methodMatch[0].lastIndexOf('(');
    const closeIndex = matchingCallParen(source, openIndex);
    if (closeIndex < 0) return null;
    methods.push({
      name,
      nameStart: cursor + nameOffset,
      nameEnd: cursor + nameOffset + name.length,
      arguments: source.slice(openIndex, closeIndex + 1).replace(/\s+/g, ' '),
    });
    cursor = closeIndex + 1;
    const whitespace = source.slice(cursor).match(/^\s*/u)?.[0].length || 0;
    cursor += whitespace;
  }
  if (!methods.length || source.slice(cursor).trim()) return null;
  return {
    receiver,
    receiverStart: receiverRaw.indexOf(receiver),
    receiverEnd: receiverRaw.indexOf(receiver) + receiver.length,
    methods,
  };
}

function matchingCallParen(source, openIndex) {
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')' && --depth === 0) return index;
  }
  return -1;
}

function compactMethodWidth(label) {
  return Math.max(
    58,
    compactRenderPartWidth({ text: label }) + METHOD_CURVED_SIDE_DEPTH * 2,
  );
}

function objectMethodForegroundOffsetX(node) {
  const visual = objectMethodVisual(node);
  if (!visual) return 0;
  const receiverWidth = Math.max(130, String(visual.receiver || '').length * 7 + 30);
  return Math.max(0, Math.round(receiverWidth / 2 + 12 - 55));
}

function objectMethodLayerBoxes(mainBox, visual, compactMethods = false) {
  const methodCount = visual.methods.length;
  const receiverWidth = Math.max(130, String(visual.receiver || '').length * 7 + 30);
  const receiverHeight = 70;
  const receiverBox = {
    x: Math.round(mainBox.x - receiverWidth / 2 - 12 - (methodCount - 1) * 44),
    y: Math.round(mainBox.y - receiverHeight / 2 - (methodCount - 1) * 16),
    width: receiverWidth,
    height: receiverHeight,
  };
  const finalCenter = {
    x: mainBox.x + mainBox.width / 2,
    y: mainBox.y + mainBox.height / 2,
  };
  const methodBoxes = visual.methods.slice(0, -1).map((method, index) => {
    const stepsFromFinal = methodCount - index - 1;
    const width = compactMethodWidth(method.label);
    const height = compactMethods ? 30 : 44;
    return {
      ...method,
      name: method.name,
      nameStart: method.nameStart,
      nameEnd: method.nameEnd,
      label: method.label,
      x: Math.round(finalCenter.x - stepsFromFinal * 44 - width / 2),
      y: Math.round(finalCenter.y - stepsFromFinal * 16 - height / 2),
      width,
      height,
    };
  });
  return { receiverBox, methodBoxes };
}

function objectMethodReceiverStyle(visual) {
  if ((visual?.receiverLabels || []).includes('OperationProvider')) {
    return operationProviderStackStyle((visual?.receiverLabels || []).includes('SystemProvider'));
  }
  return visual?.compositionKind === 'producer-expression'
    ? `${ACTION_NODE_STYLE}fontStyle=1;part=1;`
    : `${VALUE_NODE_STYLE}part=1;`;
}

function collectionLayerStyle(open = false, sketch = false) {
  return `${boxNodeStyle({ open, collection: true, sketch })}part=1;`;
}

function backingLabelStyle({ collection = false } = {}) {
  return collection
    ? 'text;html=1;whiteSpace=wrap;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;spacingTop=9;fontStyle=1;fontColor=#000000;part=1;'
    : 'text;html=1;whiteSpace=wrap;strokeColor=none;fillColor=none;align=left;verticalAlign=top;spacingLeft=10;spacingTop=7;fontStyle=1;fontColor=#000000;part=1;';
}

function collectionStackBoxes(frontBox) {
  return [frontBox];
}

function objectMethodLayerStyle(node) {
  if (node.labels.includes('Missing')) {
    return `rounded=0;whiteSpace=wrap;html=1;fillColor=${DRAWIO_PALETTE.missingFill};strokeColor=${DRAWIO_PALETTE.missingStroke};fontColor=#000000;part=1;`;
  }
  const sketch = isVirtualContainerMethodNode(node);
  const palette = methodPalette(node, sketch);
  return `shape=image;imageAspect=0;image=${methodMosaicImage('single', palette.fill, palette.stroke, { sketch, width: 100 })};whiteSpace=wrap;html=1;align=center;verticalAlign=middle;fontColor=#000000;${hasLabel(node, 'OperationProvider') ? '' : 'fontStyle=1;'}part=1;`;
}

function isFunctionEntryNode(node) {
  if ((node?.labels || []).includes('FunctionStart')) return true;
  const visualLabels = (node?.labels || []).filter((label) => label !== 'Annotatable');
  return visualLabels.length === 1 && visualLabels[0] === 'Fn';
}

function styleForNode(node, box) {
  if (node.labels.includes('LayoutJunction')) return 'ellipse;whiteSpace=wrap;html=1;fillColor=none;strokeColor=none;opacity=0;fontColor=none;';
  if (node.labels.includes('Type') && node.labels.includes('DeveloperDefined')) return `rounded=1;whiteSpace=wrap;html=1;fillColor=${DRAWIO_PALETTE.developerDefinedTypeFill};strokeColor=${DRAWIO_PALETTE.developerDefinedTypeStroke};fontColor=#000000;`;
  const expressionMosaic = expressionMosaicStyle(node, box?.width);
  if (expressionMosaic) return expressionMosaic;
  const methodChainMosaic = methodChainMosaicStyle(node, box?.width);
  if (methodChainMosaic) return methodChainMosaic;
  const callMosaicRole = node.props?.callMosaicRole || node.props?.call_mosaic_role;
  if (
    (callMosaicRole === 'close' || callMosaicRole === 'argument-close')
    && !splitCallBoundarySide(node)
  ) {
    return methodNodeStyle(node, 'end', box?.width, {
      fontSize: 18,
      sketch: hasLabel(node, 'Virtual'),
    });
  }
  if (node.props?.hybridVisualRole === 'column-stage-port') return 'ellipse;perimeter=none;whiteSpace=wrap;html=1;fillColor=none;strokeColor=none;opacity=0;fontColor=none;';
  if (node.props?.hybridVisualRole === 'sequence-axis') return 'shape=line;direction=south;whiteSpace=wrap;html=1;strokeColor=#666666;strokeWidth=2;fillColor=none;fontColor=none;';
  if (node.props?.hybridVisualRole === 'functional-column') {
    const strokeColor = node.props?.hybridColumnBodyKind === 'quasi-function'
      ? '#000000'
      : DRAWIO_PALETTE.actionStroke;
    return `shape=line;direction=south;whiteSpace=wrap;html=1;fillColor=none;strokeColor=${strokeColor};strokeWidth=2;fontColor=none;`;
  }
  if (node.props?.hybridVisualRole === 'column-junction') return `shape=ellipse;perimeter=ellipsePerimeter;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=${DRAWIO_PALETTE.actionStroke};strokeWidth=1.5;fontColor=none;`;
  if (node.props?.hybridVisualRole === 'method-axis-header') return methodNodeStyle(node, 'single', box?.width);
  if (node.props?.hybridVisualRole === 'submethod-header') {
    const splitStyle = splitCallBoundaryStyle(node, box?.width);
    return splitStyle || methodNodeStyle(node, 'single', box?.width);
  }
  if (node.props?.hybridVisualRole === 'producer-call') return methodNodeStyle(node, 'start', box?.width);
  if (node.props?.hybridVisualRole === 'producer-close') return methodNodeStyle(node, 'end', box?.width);
  if (node.props?.hybridVisualRole === 'embedded-operation') return methodNodeStyle(node, 'single', box?.width, { sketch: isVirtualContainerMethodNode(node) });
  if (node.props?.hybridVisualRole === 'predicate-call') return booleanActionStyleForNode(node);
  if (node.props?.hybridVisualRole === 'predicate-expression') return EXPRESSION_NODE_STYLE;
  if (node.props?.hybridVisualRole === 'candidate-value') return variableRectangleStyle({ empty: true });
  if (node.props?.hybridVisualRole === 'bound-item') return variableRectangleStyle();
  if (node.props?.hybridVisualRole === 'operand-occurrence') return variableRectangleStyle();
  if (node.props?.hybridVisualRole === 'exhausted-marker') return 'shape=ellipse;perimeter=ellipsePerimeter;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#b85450;strokeWidth=2;fontColor=#b85450;fontStyle=1;';
  if (node.props?.hybridVisualRole === 'assignment') return methodNodeStyle(node, 'single', box?.width, { sketch: isVirtualContainerMethodNode(node) });
  if (node.props?.hybridVisualRole === 'selected-value') return variableRectangleStyle();
  if (node.props?.hybridVisualRole === 'result-target') return variableRectangleStyle({ empty: true });
  if (node.props?.hybridVisualRole === 'sequence-complete') return ACTION_NODE_BOLD_STYLE;
  if (node.props?.hybridVisualRole === 'state-store') return `shape=datastore;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=${DRAWIO_PALETTE.valueStroke};strokeWidth=1.5;fontColor=#000000;fontStyle=1;`;
  if (node.props?.hybridVisualRole === 'object-value') return `rounded=1;arcSize=14;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=${DRAWIO_PALETTE.valueStroke};strokeWidth=1.5;fontColor=#000000;fontStyle=1;`;
  if (node.props?.hybridVisualRole === 'failure-value') return 'rounded=1;arcSize=14;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;strokeWidth=1.5;fontColor=#b85450;fontStyle=1;';
  if (node.props?.hybridVisualRole === 'failure-argument') return 'rounded=1;arcSize=14;whiteSpace=wrap;html=1;fillColor=#e1d5e7;strokeColor=#6c8ebf;strokeWidth=1.5;fontColor=#000000;fontStyle=1;';
  if (node.labels.includes('Storage')) {
    const external = node.labels.includes('External');
    return `shape=datastore;whiteSpace=wrap;html=1;fillColor=${external ? '#f5f5f5' : '#ffffff'};strokeColor=${external ? '#666666' : DRAWIO_PALETTE.valueStroke};strokeWidth=1.5;fontColor=#000000;fontStyle=1;`;
  }
  if (node.props?.hybridVisualRole === 'field-value') return VALUE_NODE_STYLE;
  const splitCallStyle = splitCallBoundaryStyle(node, box?.width);
  if (splitCallStyle) return splitCallStyle;
  if (isCallFinishNode(node) || (isArgJoinNode(node) && !isExclusiveJoinNode(node))) {
    return methodNodeStyle(node, 'end', box?.width, { fontSize: 18 });
  }
  if (node.labels.includes('FailureBinding') || node.labels.includes('Failure')) {
    return 'rounded=0;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#CC0000;strokeWidth=1.5;fontColor=#CC0000;fontStyle=1;';
  }
  if (hasLabels(node, 'ParameterType', 'OperationProvider')) {
    return operationProviderStackStyle(false);
  }
  if (hasLabels(node, 'ParameterType', 'System')) {
    return `rounded=0;whiteSpace=wrap;html=1;fillColor=${DRAWIO_PALETTE.systemActionFill};strokeColor=${DRAWIO_PALETTE.systemActionStroke};strokeWidth=1.5;fontColor=#000000;fontStyle=1;`;
  }
  if (isFunctionEntryNode(node)) {
    return 'ellipse;perimeter=ellipsePerimeter;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;strokeWidth=2;fontColor=#000000;fontStyle=1;';
  }
  if (isStandaloneVariableNode(node)) {
    return variableRectangleStyle({ empty: isEmptyContainer(node), bold: true });
  }
  if (hasLabels(node, 'Arg', 'ValueAccess')
    && !['Join', 'Method', 'Call', 'Literal', 'ContainerMethod'].some(label => hasLabel(node, label))) {
    return variableRectangleStyle({ empty: false, bold: false });
  }
  if (node.labels.includes('EndProxy')) return 'ellipse;shape=doubleEllipse;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;dashed=1;fontColor=#000000;fontStyle=1;';
  if (node.labels.includes('ResourceProxy') && isUiNode(node)) return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#eaf3ff;strokeColor=#6c8ebf;dashed=1;fontColor=#000000;';
  if (node.labels.includes('ResourceProxy')) return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#fff7dd;strokeColor=#d6b656;dashed=1;fontColor=#000000;';
  if (node.labels.includes('Missing')) return `rounded=0;whiteSpace=wrap;html=1;fillColor=${DRAWIO_PALETTE.missingFill};strokeColor=${DRAWIO_PALETTE.missingStroke};fontStyle=1;fontColor=#000000;`;
  if (node.labels.includes('SystemValue')) return SYSTEM_VALUE_NODE_STYLE;
  if (node.labels.includes('Literal')) return LITERAL_NODE_STYLE;
  if (isObjectBraceNode(node)) {
    const side = String(node.props?.objectBraceSide || node.props?.object_brace_side || '') === 'right' ? 'right' : 'left';
    const centerRatio = Number(node.props?.objectBraceCenterRatio ?? node.props?.object_brace_center_ratio ?? 0.5);
    return `shape=image;imageAspect=0;image=${objectBraceImage(side, box?.width, box?.height, centerRatio)};whiteSpace=wrap;html=1;fontColor=none;`;
  }
  if (
    node.labels.includes('Branch')
    && node.labels.includes('Operand')
    && node.props?.label === 'ternary'
  ) return EXPRESSION_NODE_STYLE;
  if (isCallPredicateNode(node)) return booleanActionStyleForNode(node);
  if (isValuePredicateNode(node)) return BOOLEAN_VALUE_STYLE;
  if (isSignificantExpressionNode(node)) return 'rounded=0;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#9673A6;strokeWidth=1.5;fontColor=#000000;';
  if (isBooleanActionNode(node)) return booleanActionStyleForNode(node);
  if (node.labels.includes('VisualProxy')) return methodNodeStyle(node, 'single', box?.width);
  if (node.labels.includes('LocalFunctionProxy')) return methodNodeStyle(node, 'single', box?.width);
  if (node.labels.includes('FnDeclaration')) return methodNodeStyle(node, 'single', box?.width);
  if (node.labels.includes('DetachedAsyncCall')) return methodNodeStyle(node, 'single', box?.width);
  if (node.labels.includes('AwaitedAsyncCall')) return methodNodeStyle(node, 'single', box?.width);
  if (node.labels.includes('UiSurface')) return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#e1d5e7;strokeColor=#9673a6;fontColor=#000000;fontStyle=1;';
  if (node.labels.includes('UiInjection')) return methodNodeStyle(node, 'single', box?.width);
  if (node.labels.includes('VirtualView')) return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#e1d5e7;strokeColor=#9673a6;fontColor=#000000;';
  if (node.labels.includes('UpdaterFn')) return methodNodeStyle(node, 'single', box?.width);
  if (node.labels.includes('Parameter') && !node.labels.includes('Object') && !node.labels.includes('Field')) return VALUE_NODE_BOLD_STYLE;
  if (node.labels.includes('Eval')) return ACTION_NODE_BOLD_STYLE;
  if (isBracketNode(node)) return `${RESULT_NODE_STYLE}fontSize=18;`;
  if (node.props.visualCallStub) return ACTION_NODE_STYLE;
  if (isFlowValueOutcomeNode(node) && isFalsyValueOutcomeNode(node)) return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#9a5d00;fontColor=#b85450;';
  if (isFlowValueOutcomeNode(node) && isTruthyValueOutcomeNode(node)) return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#9a5d00;fontColor=#2e7d32;';
  if (isFalsyValueOutcomeNode(node)) return `${VALUE_NODE_STYLE}fontColor=#b85450;`;
  if (isTruthyValueOutcomeNode(node)) return `${VALUE_NODE_STYLE}fontColor=#2e7d32;`;
  if (node.labels.includes('ValueOutcome')) return VALUE_NODE_STYLE;
  if (node.labels.includes('ValueSlot')) return RESULT_NODE_STYLE;
  if (node.labels.includes('ComputedValue')) return VALUE_NODE_BOLD_STYLE;
  if (node.labels.includes('CallbackFn')) return methodNodeStyle(node, 'single', box?.width);
  if (node.labels.includes('ValueWrite')) return ACTION_NODE_BOLD_STYLE;
  if (node.labels.includes('LocalBinding') && node.labels.includes('ValueCreate')) return RESULT_NODE_STYLE;
  if (
    (node.labels.includes('Arg') || node.labels.includes('Field'))
    && (node.labels.includes('Call') || node.labels.includes('Method') || node.labels.includes('Request'))
  ) return methodNodeStyle(node, 'single', box?.width, { sketch: isVirtualContainerMethodNode(node) });
  if ((node.labels.includes('Arg') || node.labels.includes('Field'))
    && !node.labels.includes('Branch')
    && !node.labels.includes('Join')) return VALUE_NODE_STYLE;
  if (node.labels.includes('Object')) return RESULT_NODE_STYLE;
  if (node.labels.includes('Call') || node.labels.includes('Method') || node.labels.includes('Request')) {
    const sketch = isVirtualContainerMethodNode(node);
    return methodNodeStyle(node, 'single', box?.width, { sketch });
  }
  if (node.labels.includes('Alternative')
    || node.labels.includes('ValueAccess')
    || (node.labels.includes('Operand') && !node.labels.includes('Branch'))) return VALUE_NODE_STYLE;
  if (node.labels.includes('Value')) return VALUE_NODE_STYLE;
  if (node.labels.includes('Action') || node.labels.includes('Boundary')) return ACTION_NODE_STYLE;
  if (node.labels.includes('Read')) return ACTION_NODE_STYLE;
  if (node.labels.includes('Write')) return ACTION_NODE_STYLE;
  if (node.labels.includes('Op')) return ACTION_NODE_STYLE;
  if (node.labels.includes('Fn')) return methodNodeStyle(node, 'single', box?.width);
  if (isSettingNode(node)) return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#f0f0ff;strokeColor=#7871c7;fontColor=#000000;';
  if (node.labels.includes('Return')) return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;fontColor=#000000;fontStyle=1;';
  if (node.labels.includes('Loop')) return methodNodeStyle({
    ...node,
    labels: [...new Set([...(node.labels || []), 'System', 'Method'])],
  }, 'single', box?.width);
  if (node.labels.includes('Branch') || node.labels.includes('Switch') || node.labels.includes('Case')) return EXPRESSION_NODE_STYLE;
  if (isFlowJoinNode(node)) return `rhombus;whiteSpace=wrap;html=1;fillColor=${DRAWIO_PALETTE.actionFill};strokeColor=${DRAWIO_PALETTE.actionStroke};fontColor=#000000;fontStyle=1;`;
  if (isExclusiveJoinNode(node)) return 'rhombus;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#9a5d00;fontColor=#000000;fontStyle=1;';
  if (isDataJoinNode(node)) return `rhombus;whiteSpace=wrap;html=1;fillColor=${DRAWIO_PALETTE.valueFill};strokeColor=${DRAWIO_PALETTE.valueStroke};fontColor=#000000;fontStyle=1;`;
  if (node.labels.includes('FunctionEnd')) return 'ellipse;shape=doubleEllipse;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;fontColor=#000000;fontStyle=1;';
  if (isUiNode(node)) return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontColor=#000000;';
  if (isResourceNode(node)) return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;fontColor=#000000;';
  return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#e6f2e6;strokeColor=#82b366;fontColor=#000000;';
}

function styleForEdge(edge) {
  const type = edge.type || '';
  const flowLayer = edge.props?.flow_layer || edge.props?.flowLayer;
  const dataEdge = flowLayer === 'data'
    || [
      'EXTRACTS_VALUE',
      'PASSES_VALUE',
      'YIELDS_VALUE',
      'EMITS_VALUE',
      'ACCUMULATES_VALUE',
      'DECIDES_VALUE',
      'PERFORMS_EFFECT',
      'ORDERS_VALUE',
      'COMPLETES_VALUE',
      'ASSIGNS_VALUE',
      'TARGETS_VALUE',
    ].includes(type);
  const repeatOrigin = edge.props?.repeatOrigin || edge.props?.repeat_origin || '';
  const producerOutcome = edge.props?.producerOutcome || edge.props?.producer_outcome || '';
  const binaryRepeat = type === 'REPEATS' && repeatOrigin === 'binary-expression';
  const color = type === 'TRUE' || type === 'SHORT_CIRCUITS' || producerOutcome === 'true'
    ? '#006600'
    : type === 'FALSE' || type === 'CATCH' || binaryRepeat || type === 'EXHAUSTED' || producerOutcome === 'false'
      ? '#CC0000'
      : dataEdge && type !== 'EVAL'
        ? DRAWIO_PALETTE.valueStroke
        : type === 'NEXT' || type === 'EVAL'
          ? DRAWIO_PALETTE.actionStroke
        : edge.props?.strokeColor
          ? edge.props.strokeColor
        : type === 'PULLS_VALUE' || type === 'INVOKES'
          ? DRAWIO_PALETTE.actionStroke
          : DRAWIO_PALETTE.actionStroke;
  const fontColor = type === 'TRUE' || type === 'SHORT_CIRCUITS' || producerOutcome === 'true'
    ? '#006600'
    : type === 'FALSE' || type === 'CATCH' || binaryRepeat || type === 'EXHAUSTED' || producerOutcome === 'false'
      ? '#CC0000'
      : color;
  const asynchronousEvaluation = type === 'EVAL'
    && (edge.props?.invocationMode || edge.props?.invocation_mode) === 'asynchronous';
  const dashed = asynchronousEvaluation
    || ['CALL', 'REQUEST', 'READ', 'UPDATE', 'CREATE', 'DELETE', 'CLEAR', 'EMIT', 'WAIT', 'SUBSCRIBE', 'DECLARES_FUNCTION', 'ASYNC', 'DETACHES_ASYNC', 'AWAITS_ASYNC'].includes(type)
    ? 'dashed=1;'
    : '';
  const sourceJettySize = Number(edge.props?.sourceJettySize);
  const sourceJetty = Number.isFinite(sourceJettySize) && sourceJettySize > 0
    ? `sourceJettySize=${Math.round(sourceJettySize)};`
    : '';
  const targetJettySize = Number(edge.props?.targetJettySize);
  const targetJetty = Number.isFinite(targetJettySize) && targetJettySize > 0
    ? `targetJettySize=${Math.round(targetJettySize)};`
    : '';
  const endArrow = edge.props?.axisSegment ? 'none' : 'block';
  const slotNameStyle = slotNameForEdge(edge) ? 'fontStyle=2;' : '';
  return `edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;${sourceJetty}${targetJetty}html=1;endArrow=${endArrow};strokeColor=${color};fontColor=${fontColor};${slotNameStyle}${portStyle(edge)}${dashed}`;
}

function slotNameForEdge(edge) {
  if (!edge || (edge.type !== 'ARG' && edge.type !== 'FIELD')) return '';
  return edge.props?.display_label ?? edge.props?.displayLabel ?? '';
}

function referenceNamesFromText(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  const normalized = text
    .replace(/\?\./gu, '.')
    .replace(/^\.{1,3}/u, '')
    .replace(/[?!]+$/u, '');
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.test(normalized)) return [];
  const parts = normalized.split('.');
  return parts.length === 1 ? parts : [parts[0], parts.at(-1)];
}

function passedReferenceNames(node) {
  if (!node) return new Set();
  const names = new Set();
  const parts = renderPartsForNode(node);
  for (const part of parts) {
    const labels = Array.isArray(part?.labels) ? part.labels : [];
    if (labels.includes('FieldName')) continue;
    if (!['value', 'value-container', 'field'].includes(String(part?.kind || ''))
      && !labels.some((label) => ['Value', 'ValueAccess'].includes(label))) continue;
    for (const name of referenceNamesFromText(part?.plainText || part?.text)) names.add(name);
  }
  if (!parts.length) {
    const displayName = node.props?.diaName
      ?? node.props?.dia_name
      ?? node.props?.displayLabel
      ?? node.props?.display_label
      ?? node.props?.name
      ?? '';
    for (const name of referenceNamesFromText(displayName)) names.add(name);
  }
  return names;
}

function suppressRedundantSlotLabels(nodes, edges) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return edges.map((edge) => {
    const slotName = String(slotNameForEdge(edge) || '').trim();
    if (!slotName) return edge;
    const slotEnd = edge.props?.canonicalTargetStableId === edge.start ? 'source' : 'target';
    const passedNode = nodeById.get(slotEnd === 'source' ? edge.start : edge.end);
    if (!passedReferenceNames(passedNode).has(slotName)) return edge;
    return {
      ...edge,
      props: {
        ...edge.props,
        diaName: '',
        dia_name: '',
        displayLabel: '',
        display_label: '',
        redundantSlotLabel: true,
      },
    };
  });
}

function slotNodeEnd(edge) {
  if (!slotNameForEdge(edge)) return null;
  return edge.props?.canonicalTargetStableId === edge.start ? 'source' : 'target';
}

function labelForEdge(edge) {
  if (edge.type === 'ArgJoin' || edge.type === 'FieldJoin' || edge.type === 'XOR_JOIN') return '';
  const label = edge.props?.diaName
    ?? edge.props?.dia_name
    ?? edge.props?.display_label
    ?? edge.props?.displayLabel
    ?? '';
  return (edge.type === 'TRUE' || edge.type === 'FALSE')
    && String(label).toUpperCase() === edge.type
    ? edge.type.toLowerCase()
    : label;
}

function portStyle(edge) {
  return `${sourcePortStyle(edge.props.sourcePort)}${targetPortStyle(edge.props.targetPort)}`;
}

function sourcePortStyle(port) {
  const parsed = parsePercentPort(port);
  if (parsed) return `exitX=${parsed.x};exitY=${parsed.y};exitPerimeter=1;`;
  if (port === 'hex-right-top') return 'exitX=0.75;exitY=0;exitPerimeter=1;sourcePortConstraint=east;';
  if (port === 'hex-right-bottom') return 'exitX=0.75;exitY=1;exitPerimeter=1;sourcePortConstraint=east;';
  if (port === 'top') return 'exitX=0.5;exitY=0;exitPerimeter=1;';
  if (port === 'right') return 'exitX=1;exitY=0.5;exitPerimeter=1;';
  if (port === 'right-top') return 'exitX=0.75;exitY=0;exitPerimeter=1;';
  if (port === 'right-bottom') return 'exitX=0.75;exitY=1;exitPerimeter=1;';
  if (port === 'bottom-left') return 'exitX=0.25;exitY=1;exitPerimeter=1;';
  if (port === 'bottom-right') return 'exitX=0.75;exitY=1;exitPerimeter=1;';
  if (port === 'bottom') return 'exitX=0.5;exitY=1;exitPerimeter=1;';
  if (port === 'left') return 'exitX=0;exitY=0.5;exitPerimeter=1;';
  if (port === 'left-top') return 'exitX=0.25;exitY=0;exitPerimeter=1;';
  if (port === 'left-bottom') return 'exitX=0.25;exitY=1;exitPerimeter=1;';
  return '';
}

function targetPortStyle(port) {
  const parsed = parsePercentPort(port);
  if (parsed) return `entryX=${parsed.x};entryY=${parsed.y};entryPerimeter=1;`;
  if (port === 'hex-right-top') return 'entryX=0.75;entryY=0;entryPerimeter=1;';
  if (port === 'hex-right-bottom') return 'entryX=0.75;entryY=1;entryPerimeter=1;';
  if (port === 'top') return 'entryX=0.5;entryY=0;entryPerimeter=1;';
  if (port === 'right') return 'entryX=1;entryY=0.5;entryPerimeter=1;';
  if (port === 'right-top') return 'entryX=0.75;entryY=0;entryPerimeter=1;';
  if (port === 'right-bottom') return 'entryX=0.75;entryY=1;entryPerimeter=1;';
  if (port === 'bottom-left') return 'entryX=0.25;entryY=1;entryPerimeter=1;';
  if (port === 'bottom-right') return 'entryX=0.75;entryY=1;entryPerimeter=1;';
  if (port === 'bottom') return 'entryX=0.5;entryY=1;entryPerimeter=1;';
  if (port === 'left') return 'entryX=0;entryY=0.5;entryPerimeter=1;';
  if (port === 'left-top') return 'entryX=0.25;entryY=0;entryPerimeter=1;';
  if (port === 'left-bottom') return 'entryX=0.25;entryY=1;entryPerimeter=1;';
  return '';
}

function parsePercentPort(port) {
  const match = String(port || '').match(/^(top|right|bottom|left)-(\d{1,3}(?:\.\d+)?)$/u);
  if (!match) return null;
  const ratio = Math.max(0, Math.min(100, Number(match[2]))) / 100;
  const side = match[1];
  const point = side === 'top'
    ? { x: ratio, y: 0 }
    : side === 'bottom'
      ? { x: ratio, y: 1 }
      : side === 'left'
        ? { x: 0, y: ratio }
        : { x: 1, y: ratio };
  return { side, ratio, ...point };
}

function isUiNode(node) {
  const kind = String(node.props.resource_kind || '').toLowerCase();
  return kind === 'ui-state' || kind === 'input-state' || kind === 'ui-effect' || node.labels.includes('UiState') || node.labels.includes('InputState');
}

function isResourceNode(node) {
  return isSettingNode(node)
    || Boolean(node.props?.resource_kind)
    || node.labels.some((label) => ['Storage', 'Cell', 'HistoryStore', 'RuntimeState', 'CreatedObject', 'FlowObject'].includes(label));
}

function isSettingNode(node) {
  return node.labels.some((label) => ['Setting', 'FeatureFlagStore', 'GlobalConfigStore'].includes(label));
}

function isLayoutJunctionNode(node) {
  return node.labels.includes('LayoutJunction');
}

function isRenderHiddenNode(node) {
  return node.props.renderHidden === true || node.props.renderHidden === 'true';
}

function isVisualProxyNode(node) {
  return node.labels.includes('VisualProxy') || node.labels.includes('ResourceProxy');
}

function graphKindForNode(node) {
  const priority = [
    'FnDeclaration',
    'LocalFunctionProxy',
    'DetachedAsyncCall',
    'AwaitedAsyncCall',
    'UiSurface',
    'Fn',
    'Request',
    'Call',
    'Op',
    'Read',
    'Write',
    'ValueAccess',
    'Branch',
    'Join',
    'Return',
  ];
  return priority.find((label) => node.labels.includes(label)) || node.labels[0] || 'Node';
}

function functionStableIdForNode(node) {
  if (node.labels.includes('FunctionStart')) {
    return node.props.parentFnStableId
      || node.props.parent_fn_stable_id
      || codeLocationStableId(node.id)
      || '';
  }
  if (isVisualProxyNode(node) || node.labels.includes('FnVisualProxy') || node.labels.includes('LocalFunctionProxy') || node.labels.includes('FunctionProxy')) {
    return node.props.calleeStableId || node.props.canonicalStableId || '';
  }
  if (node.labels.includes('FnDeclaration')) {
    return node.props.calleeStableId || node.props.canonicalStableId || '';
  }
  if (node.labels.includes('Fn')) return node.id;
  return node.props.parentFnStableId || node.props.parent_fn_stable_id || '';
}

function isClosingCallBoundaryNode(node) {
  const role = node?.props?.callMosaicRole
    || node?.props?.call_mosaic_role
    || node?.props?.callBoundaryRole
    || node?.props?.call_boundary_role;
  return role === 'close'
    || role === 'argument-close'
    || splitCallBoundarySide(node) === 'end';
}

function codeLocationStableId(value) {
  const stableId = String(value || '').trim();
  return /(?:^|:)\d+:\d+:\d+:\d+(?::|$)/u.test(stableId) ? stableId : '';
}

function valueSourceStableIdCandidate(node) {
  const props = node?.props || {};
  const candidates = [
    props.value_slot_stableId,
    props.value_slot_stable_id,
    ...(Array.isArray(props.value_slot_stableIds) ? props.value_slot_stableIds : []),
  ];
  return candidates.map(codeLocationStableId).find(Boolean) || '';
}

function sourceStableIdCandidate(node) {
  const props = node?.props || {};
  const candidates = [
    props.sourceStableId,
    props.source_stable_id,
    props.declarationStableId,
    props.declaration_stable_id,
    props.canonicalStableId,
    props.canonical_stable_id,
    props.calleeStableId,
  ];
  const declaredSource = candidates.map(codeLocationStableId).find(Boolean) || '';
  if (declaredSource) return declaredSource;

  const isInvocation = ['Call', 'Request', 'Op', 'Method'].some((label) => hasLabel(node, label));
  return isInvocation ? '' : valueSourceStableIdCandidate(node);
}

function callSourceStableIds(nodes) {
  const result = new Map();
  for (const node of nodes) {
    const callSiteStableId = String(
      node.props?.sourceCallStableId
      || node.props?.source_call_stable_id
      || '',
    ).trim();
    const sourceStableId = sourceStableIdCandidate(node);
    if (callSiteStableId && sourceStableId) result.set(callSiteStableId, sourceStableId);
  }
  return result;
}

function locationStableIdForNode(node) {
  return codeLocationStableId(
    node.props?.locationStableId
    || node.props?.location_stable_id
    || node.props?.sourceCallStableId
    || node.props?.source_call_stable_id
    || node.id,
  );
}

function expressionComponentStableId(node, startOffset, endOffset) {
  const baseStableId = locationStableIdForNode(node);
  const match = baseStableId.match(/([A-Za-z0-9_.\/\\-]+\.[cm]?[jt]sx?):(\d+):(\d+):(\d+):(\d+)/u);
  if (!match || !Number.isFinite(startOffset) || !Number.isFinite(endOffset)) return baseStableId;
  const source = String(node.props?.call_text_raw || node.props?.action_text_raw || '').trim();
  const pointAt = (offset) => {
    const prefix = source.slice(0, Math.max(0, offset));
    const lines = prefix.split(/\r?\n/u);
    return {
      line: Number(match[2]) + lines.length - 1,
      column: lines.length === 1
        ? Number(match[3]) + prefix.length
        : lines.at(-1).length,
    };
  };
  const start = pointAt(startOffset);
  const end = pointAt(endOffset);
  return `${match[1]}:${start.line}:${start.column}:${end.line}:${end.column}`;
}

function labelForNode(node) {
  const props = node.props;
  if (isFlowJoinNode(node) || isDataJoinNode(node)) return 'x';
  if (isObjectBraceNode(node)) return '';
  if (node.labels.includes('LayoutJunction')) return '';
  if (
    props.hybridVisualRole === 'sequence-axis'
    || props.hybridVisualRole === 'functional-column'
    || props.hybridVisualRole === 'column-junction'
    || props.hybridVisualRole === 'column-stage-port'
  ) return '';
  if (
    props.hybridVisualRole === 'method-axis-header'
    || props.hybridVisualRole === 'producer-call'
    || props.hybridVisualRole === 'producer-close'
    || props.hybridVisualRole === 'embedded-operation'
  ) return truncateLabel(props.diaName || props.label || '');
  if (expressionMosaicRole(node)) {
    return truncateLabel(
      props.diaName
      || props.operation_value_text
      || props.operationValueText
      || props.label
      || '',
      96,
    );
  }
  if (props.splitCallBoundary === 'end' && hasLabels(node, 'Arg', 'Join', 'Collection')) return '';
  if (methodChainRole(node) === 'continuation') return truncateLabel(props.diaName || props.label || 'method()');
  if (props.splitCallBoundary === 'end') {
    if (props.compactCallMosaic === true) return ')';
    return ')';
  }
  const callMosaicRole = props.callMosaicRole || props.call_mosaic_role;
  if (callMosaicRole === 'close' || callMosaicRole === 'argument-close') {
    return truncateLabel(props.diaName || ')');
  }
  const ternaryLabel = ternaryPrefixLabel(node, props);
  if (ternaryLabel) return truncateLabel(ternaryLabel);
  if (isCallPredicateNode(node)) {
    return truncateLabel(
      props.call_text_raw
      || props.action_text_raw
      || props.operation_value_text
      || props.operationValueText
      || props.operation_callee_text
      || props.calleeName
      || props.diaName
      || props.label,
      96,
    );
  }
  const extractedCollectionStage = (props.executionScopeKind || props.execution_scope_kind) === 'collection-call';
  const objectMethod = extractedCollectionStage ? null : objectMethodVisual(node);
  if (objectMethod) {
    const suffix = props.splitCallBoundary !== 'start' && props.visualCopyIndex && props.visualCopyCount
      ? ` (${props.visualCopyIndex}/${props.visualCopyCount})`
      : '';
    return `${truncateLabel(objectMethod.methodLabel)}${suffix}`;
  }
  if (props.splitCallBoundary === 'start') {
    const rawName = props.operation_callee_text
      || props.calleeName
      || props.diaName
      || props.label
      || props.call_text_raw
      || props.action_text_raw
      || 'call';
    const name = String(rawName)
      .replace(/^Fn\s+/u, '')
      .replace(/\s*\([^]*$/u, '')
      .trim();
    const opening = '(';
    return `${truncateLabel(name || 'call')}${opening}`;
  }
  if (node.labels.includes('Alternative')) {
    const expression = props.action_text_raw
      || props.call_text_raw
      || props.operation_value_text
      || props.diaName
      || props.label;
    return truncateLabel(expression, 96);
  }
  if (isExclusiveJoinNode(node)) return 'x';
  if (isCallFinishNode(node) || isArgJoinNode(node)) return ')';
  if (isObjectFinishNode(node) || isFieldJoinNode(node)) return '}';
  if (isObjectStartNode(node)) {
    if (String(props.diaName || '').trim() === '{}') return '{}';
    return node.labels.includes('Parameter')
      ? truncateLabel(props.diaName || props.label || '{')
      : '{';
  }
  if (hasLabel(node, 'Field') && !hasLabel(node, 'Join')) {
    const fieldValue = hasLabel(node, 'Parameter')
      ? props.parameterTypeText || props.parameter_type_text
      : props.diaName || props.operation_value_text || props.operationValueText;
    if (fieldValue) return truncateLabel(fieldValue);
  }
  if (node.labels.includes('Request') || node.labels.includes('Call') || node.labels.includes('Op')) {
    if (props.visualCallStub) return truncateLabel(props.visualCallStubLabel || '', 40);
    const suffix = props.splitCallBoundary !== 'start' && props.visualCopyIndex && props.visualCopyCount
      ? ` (${props.visualCopyIndex}/${props.visualCopyCount})`
      : '';
    if (props.diaName) {
      const diaName = props.splitCallBoundary === 'start' && hasLabel(node, 'Method')
        ? `${String(props.diaName).replace(/\(.*$/u, '')}(`
        : props.diaName;
      return `${truncateLabel(diaName)}${suffix}`;
    }
    const text = props.operation_callee_text || props.calleeName || props.call_text_raw || props.action_text_raw || props.label || (node.labels.includes('Op') ? 'op' : 'call');
    return `${truncateLabel(text)}${suffix}`;
  }
  if ((node.labels.includes('Read') || node.labels.includes('Write')) && props.visualCallStub) {
    return truncateLabel(props.visualCallStubLabel || '', 40);
  }
  if (node.labels.includes('EndProxy')) {
    const index = props.visualCopyIndex;
    const count = props.visualCopyCount;
    const suffix = index && count ? `\n(${index}/${count})` : '';
    return `End${suffix}`;
  }
  if (node.labels.includes('ResourceProxy')) {
    const name = props.resource_cell_name
      || props.resource_name
      || props.name
      || props.label
      || 'resource';
    const index = props.visualCopyIndex;
    const count = props.visualCopyCount;
    const suffix = index && count ? ` (${index}/${count})` : '';
    return `${truncateLabel(name, 42)}${suffix}`;
  }
  if (props.diaName) {
    const negatedPredicateLabel = negatedPredicateLabelForNode(node);
    if (negatedPredicateLabel) return truncateLabel(negatedPredicateLabel);
    return truncateLabel(props.diaName);
  }
  if (isSettingNode(node)) {
    const name = props.setting_cell_name
      || props.setting_name
      || props.name
      || props.label
      || 'setting';
    return truncateLabel(name, 42);
  }
  if (node.labels.includes('VisualProxy')) {
    const name = props.name || props.label || 'function';
    const index = props.visualCopyIndex;
    const count = props.visualCopyCount;
    const suffix = index && count ? ` (${index}/${count})` : '';
    return `${name}()${suffix}`;
  }
  if (node.labels.includes('Method')) return `Method\n${props.missing_method_name || props.missingMethodName || props.name || props.label || 'method'}()`;
  if (isFunctionEntryNode(node)) return 'Start';
  if (node.labels.includes('Fn')) return `Fn\n${props.name || 'function'}()`;
  if (node.labels.includes('Return')) return 'Return';
  if (node.labels.includes('FunctionEnd')) return 'End';
  if (isFlowJoinNode(node)) return 'x';
  if (isArgJoinNode(node)) return 'arg join';
  if (isDataJoinNode(node)) return 'x';
  if (isFieldJoinNode(node)) return 'field join';
  if (node.labels.includes('Object')) return 'object';
  if (isObjectFieldNode(node) && props.label) return truncateLabel(props.label);
  const operationLabel = operationDisplayLabel(props);
  if (operationLabel) return truncateLabel(operationLabel);
  const expression = (node.labels.includes('Branch') && props.label === 'ternary' ? props.operation_value_text : undefined)
    || props.condition_raw
    || props.action_text_raw
    || props.operation_subject_text
    || props.operation_value_text
    || props.call_text_raw
    || props.operation_callee_text;
  if (expression) return truncateLabel(expression);
  return props.label
    || props.operation_label
    || props.operationLabel
    || props.name
    || props.resource_cell_name
    || props.resource_name
    || props.setting_cell_name
    || props.setting_name
    || props.object_name
    || props.stableId
    || node.id;
}

function negatedPredicateLabelForNode(node) {
  const props = node?.props || {};
  if (!hasLabel(node, 'PredicateOperator')) return '';
  if (String(props.diaName || '').trim() !== '!') return '';
  const conditionRaw = String(props.condition_raw || props.conditionRaw || '').replace(/\s+/g, ' ').trim();
  if (conditionRaw.startsWith('!(')) return '!()';
  if (conditionRaw.startsWith('!') && conditionRaw.length > 1) return conditionRaw;
  const operationSubject = String(props.operation_subject_text || props.operationSubjectText || '').replace(/\s+/g, ' ').trim();
  if (operationSubject.startsWith('(')) return '!()';
  if (operationSubject) return `!${operationSubject}`;
  const sourceText = sourceTextForStableId(node.id);
  if (sourceText.startsWith('!(')) return '!()';
  return sourceText.startsWith('!') && sourceText.length > 1 ? sourceText : '';
}

const sourceTextByStableId = new Map();

function sourceTextForStableId(stableId) {
  const key = String(stableId || '');
  if (sourceTextByStableId.has(key)) return sourceTextByStableId.get(key);
  const parsed = parseSourceRangeStableId(key);
  if (!parsed) {
    sourceTextByStableId.set(key, '');
    return '';
  }
  const filePath = path.resolve(process.cwd(), parsed.filePath);
  let text = '';
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/u);
    if (parsed.startLine === parsed.endLine) {
      text = String(lines[parsed.startLine - 1] || '')
        .slice(parsed.startColumn - 1, parsed.endColumn - 1)
        .trim();
    }
  } catch {
    text = '';
  }
  sourceTextByStableId.set(key, text);
  return text;
}

function parseSourceRangeStableId(stableId) {
  const parts = String(stableId || '').split(':');
  if (parts.length < 5) return null;
  const endColumn = Number(parts.at(-1));
  const endLine = Number(parts.at(-2));
  const startColumn = Number(parts.at(-3));
  const startLine = Number(parts.at(-4));
  if (![startLine, startColumn, endLine, endColumn].every(Number.isFinite)) return null;
  const filePath = parts.slice(0, -4).join(':');
  if (!filePath) return null;
  return { filePath, startLine, startColumn, endLine, endColumn };
}

function operationDisplayLabel(props) {
  const operationCode = String(props.operation_code || props.operationCode || '').toUpperCase();
  const subject = String(props.operation_subject_text || props.operationSubjectText || '').replace(/\s+/g, ' ').trim();
  const value = String(props.operation_value_text || props.operationValueText || '').replace(/\s+/g, ' ').trim();
  if ((operationCode === 'ASSIGN' || operationCode === 'BLOCK') && subject && value) {
    return `${subject} = ${value}`;
  }
  return '';
}

function ternaryPrefixLabel(node, props) {
  if (!node.labels.includes('Branch')) return '';
  if (props.label !== 'ternary') return '';
  const text = String(props.operation_value_text || props.condition_raw || '').replace(/\s+/g, ' ').trim();
  const questionIndex = text.indexOf('?');
  if (questionIndex < 0) return text;
  return text.slice(0, questionIndex + 1).trim();
}

function truncateLabel(value, max = 64) {
  const text = String(value || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function shortStable(stableId) {
  const text = String(stableId || '');
  if (text.length <= 60) return text;
  return `${text.slice(0, 28)}...${text.slice(-22)}`;
}

function sizeForNode(node, label) {
  const displayWidth = Number(node.props.displayWidth);
  const displayHeight = Number(node.props.displayHeight);
  const structuredHorizontal = structuredHorizontalSize(node);
  const structuredVertical = structuredVerticalSize(node);
  const structuredContainerOverlay = structuredContainerOverlaySize(node);
  if (structuredHorizontal) {
    const splitCallMosaic = Boolean(
      node.props?.callMosaicRole
      || node.props?.call_mosaic_role
      || node.props?.callBoundaryDesign === 'split'
      || node.props?.call_boundary_design === 'split',
    );
    return {
      width: structuredHorizontal.hexMosaic
        ? structuredHorizontal.width
        : splitCallMosaic
          ? structuredHorizontal.width
          : Number.isFinite(displayWidth) && displayWidth > 0
            ? Math.max(displayWidth, structuredHorizontal.width)
            : structuredHorizontal.width,
      height: node.labels.includes('Collection') ? structuredHorizontal.height : 30,
    };
  }
  if (structuredVertical) {
    return {
      width: Number.isFinite(displayWidth) && displayWidth > 0 ? displayWidth : structuredVertical.width,
      height: Number.isFinite(displayHeight) && displayHeight > 0 ? displayHeight : structuredVertical.height,
    };
  }
  if (structuredContainerOverlay) {
    return {
      width: structuredContainerOverlay.width,
      height: structuredContainerOverlay.height,
    };
  }
  if (node.labels.includes('LayoutJunction')) return { width: 1, height: 1 };
  if (isFlowJoinNode(node) || isDataJoinNode(node) || isExclusiveJoinNode(node)) return { width: 42, height: 42 };
  if (isFunctionEntryNode(node)) return { width: 42, height: 42 };
  if (hasLabels(node, 'ParameterType', 'OperationProvider')) {
    return { width: Math.max(130, compactMethodWidth(label)), height: 70 };
  }
  if (hasLabel(node, 'ParameterType') && !isObjectBraceNode(node)) {
    return { width: Math.max(58, compactRenderPartWidth({ text: label }) + 16), height: 30 };
  }
  if (node.props?.hybridVisualRole === 'functional-column') {
    return {
      width: 2,
      height: Number.isFinite(displayHeight) && displayHeight > 0 ? displayHeight : 260,
    };
  }
  if (node.props?.hybridVisualRole === 'column-junction') {
    return {
      width: Number.isFinite(displayWidth) && displayWidth > 0 ? displayWidth : 10,
      height: Number.isFinite(displayHeight) && displayHeight > 0 ? displayHeight : 10,
    };
  }
  if (expressionMosaicRole(node)) {
    const callPart = node.labels.some((nodeLabel) => (
      ['Call', 'Request', 'Op', 'Method', 'FnVisualProxy'].includes(nodeLabel)
    ));
    const predicate = node.props?.expressionMosaicPredicate === true
      || node.props?.expression_mosaic_predicate === true;
    const predicateBoundary = node.props?.horizontalMosaicBoundary
      || node.props?.horizontal_mosaic_boundary
      || 'middle';
    return {
      width: predicate
          ? predicateMosaicPartWidth({
            text: label,
            kind: expressionMosaicPartKind(node),
          }, predicateBoundary)
        : Number.isFinite(displayWidth) && displayWidth > 0
          ? displayWidth
          : callPart
          ? compactMethodWidth(label)
          : 82,
      height: isCompactInfixOperatorPart({
        kind: expressionMosaicPartKind(node),
        text: label,
        labels: node.labels,
      })
        ? OPERATOR_MOSAIC_TILE_HEIGHT
        : MOSAIC_TILE_HEIGHT,
    };
  }
  if (methodChainRole(node)) {
    return {
      width: Number.isFinite(displayWidth) && displayWidth > 0 ? displayWidth : compactMethodWidth(label),
      height: Number.isFinite(displayHeight) && displayHeight > 0 ? displayHeight : 60,
    };
  }
  if (node.props?.hybridVisualRole === 'exhausted-marker') {
    return {
      width: Number.isFinite(displayWidth) && displayWidth > 0 ? displayWidth : 22,
      height: Number.isFinite(displayHeight) && displayHeight > 0 ? displayHeight : 22,
    };
  }
  if (
    node.props?.hybridVisualRole === 'submethod-attachment'
    && node.labels.includes('Collection')
    && !node.labels.includes('Method')
  ) {
    return {
      width: Number.isFinite(displayWidth) && displayWidth > 0 ? displayWidth : 130,
      height: Number.isFinite(displayHeight) && displayHeight > 0 ? displayHeight : 70,
    };
  }
  const callMosaicRole = node.props?.callMosaicRole || node.props?.call_mosaic_role;
  if (callMosaicRole && callMosaicRole !== 'open' && !splitCallBoundarySide(node)) {
    return {
      width: compactRenderPartWidth({
        text: label,
        kind: callMosaicRole === 'close' || callMosaicRole === 'argument-close'
          ? 'punctuation'
          : 'value',
      }),
      height: 30,
    };
  }
  if (splitCallBoundarySide(node)) {
    const compactClosing = label === ')';
    return {
      width: compactClosing
        ? compactRenderPartWidth({ text: label, kind: 'punctuation' }) + METHOD_CURVED_SIDE_DEPTH
        : Number.isFinite(displayWidth) && displayWidth > 0
          ? displayWidth
          : compactMethodWidth(label),
      height: 30,
    };
  }
  if (node.labels.includes('Storage')) {
    return {
      width: Number.isFinite(displayWidth) && displayWidth > 0 ? displayWidth : 150,
      height: Number.isFinite(displayHeight) && displayHeight > 0 ? displayHeight : 82,
    };
  }
  if (
    (node.labels.includes('Arg') || node.labels.includes('Field'))
    && !node.labels.includes('Join')
  ) {
    return {
      width: Math.max(30, String(label || '').length * 7 + 16),
      height: 30,
    };
  }
  if (node.labels.includes('Literal')) {
    return {
      width: compactRenderPartWidth({ text: label, kind: 'literal' }),
      height: 30,
    };
  }
  if (isStandaloneVariableNode(node)) {
    return {
      width: Math.max(92, variableNodeWidth(label)),
      height: 40,
    };
  }
  if (node.props?.hybridVisualRole) {
    if (['candidate-value', 'bound-item', 'operand-occurrence', 'selected-value', 'result-target'].includes(node.props.hybridVisualRole)) {
      return {
        width: Number.isFinite(displayWidth) && displayWidth > 0 ? Math.max(92, displayWidth) : Math.max(92, variableNodeWidth(label)),
        height: Number.isFinite(displayHeight) && displayHeight > 0 ? displayHeight : 40,
      };
    }
    return {
      width: Number.isFinite(displayWidth) && displayWidth > 0 ? displayWidth : 80,
      height: Number.isFinite(displayHeight) && displayHeight > 0 ? displayHeight : 34,
    };
  }
  if (node.labels.includes('Eval')) return { width: 44, height: 50 };
  if (isBracketNode(node) && !splitCallBoundarySide(node)) return { width: 44, height: 50 };
  if (node.props.visualCallStub) return { width: Number.isFinite(displayWidth) && displayWidth > 0 ? displayWidth : 44, height: 50 };
  const objectMethod = objectMethodVisual(node);
  if (node.props.splitCallBoundary) {
    return {
      width: Number.isFinite(displayWidth) && displayWidth > 0 ? displayWidth : compactMethodWidth(label),
      height: objectMethod ? 44 : 50,
    };
  }
  if (objectMethod) return {
    width: compactMethodWidth(objectMethod.methodLabel),
    height: 30,
  };
  if (node.labels.includes('Collection')) {
    return {
      width: Number.isFinite(displayWidth) && displayWidth > 0 ? displayWidth : Math.max(116, variableNodeWidth(label)),
      height: Number.isFinite(displayHeight) && displayHeight > 0 ? displayHeight : 70,
    };
  }
  if (isObjectBraceNode(node)) return { width: 20, height: 30 };
  if (node.labels.includes('Loop')) return { width: Math.max(72, compactMethodWidth(label)), height: 40 };
  if (node.labels.includes('Branch') || node.labels.includes('Switch') || node.labels.includes('Case')) return { width: Math.max(150, label.length * 7), height: 30 };
  if (node.labels.includes('EndProxy')) return { width: 74, height: 74 };
  if (node.labels.includes('FunctionEnd')) return { width: 74, height: 74 };
  if (node.labels.includes('Return')) return { width: 150, height: 50 };
  if (node.labels.includes('ResourceProxy')) return { width: Math.max(160, label.length * 6), height: 52 };
  if (isFlowValueOutcomeNode(node)) return { width: 43, height: 21 };
  if (node.labels.includes('ValueOutcome')) return { width: Number.isFinite(displayWidth) && displayWidth > 0 ? displayWidth : 85, height: 42 };
  if (node.labels.includes('VisualProxy') && node.props.compactCallSnippet) {
    return { width: compactMethodWidth(label), height: 30 };
  }
  if (
    node.labels.includes('Call')
    || node.labels.includes('Method')
    || node.labels.includes('Fn')
    || node.labels.includes('Request')
    || node.labels.includes('VisualProxy')
  ) return { width: compactMethodWidth(label), height: 30 };
  if (Number.isFinite(displayWidth) && displayWidth > 0) return { width: displayWidth, height: 52 };
  return { width: Math.max(160, label.length * 6), height: 52 };
}

function hasGraphPosition(node) {
  return Number.isFinite(Number(node.props.displayX)) && Number.isFinite(Number(node.props.displayY));
}

function collapseMergeNodes(nodes, edges) {
  const outgoingBySource = new Map();
  for (const edge of edges) {
    if (!outgoingBySource.has(edge.start)) outgoingBySource.set(edge.start, []);
    outgoingBySource.get(edge.start).push(edge);
  }

  const collapsibleMergeIds = new Set(
    nodes
      .filter((node) => node.labels.includes('Merge'))
      .filter((node) => (outgoingBySource.get(node.id) || []).length === 1)
      .map((node) => node.id),
  );
  if (!collapsibleMergeIds.size) return { nodes, edges };

  function resolveAfterMerge(nodeId, seen = new Set()) {
    if (!collapsibleMergeIds.has(nodeId) || seen.has(nodeId)) return nodeId;
    seen.add(nodeId);
    const outgoing = outgoingBySource.get(nodeId) || [];
    if (outgoing.length !== 1) return nodeId;
    return resolveAfterMerge(outgoing[0].end, seen);
  }

  const collapsedEdges = [];
  for (const edge of edges) {
    if (collapsibleMergeIds.has(edge.start)) continue;
    const collapsedEnd = resolveAfterMerge(edge.end);
    if (collapsedEnd === edge.start) continue;
    const mergePath = edge.end !== collapsedEnd ? [edge.end] : [];
    collapsedEdges.push({
      ...edge,
      end: collapsedEnd,
      props: {
        ...edge.props,
        collapsedMergePath: mergePath,
      },
    });
  }

  const seenEdges = new Set();
  const dedupedEdges = collapsedEdges.filter((edge) => {
    const producerOutcome = edge.props?.producerOutcome || edge.props?.producer_outcome || '';
    const key = `${edge.start}->${edge.end}:${edge.type}:${producerOutcome}`;
    if (seenEdges.has(key)) return false;
    seenEdges.add(key);
    return true;
  });

  return {
    nodes: nodes.filter((node) => !collapsibleMergeIds.has(node.id)),
    edges: dedupedEdges,
  };
}

function derivePositions(nodes, edges) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const positioned = new Map();
  const central = nodes.filter(hasGraphPosition);
  const xs = central.map((node) => Number(node.props.displayX));
  const minX = Math.min(0, ...xs);
  const maxX = Math.max(0, ...xs);
  const laneCounters = new Map();

  for (const node of central) {
    positioned.set(node.id, {
      x: Number(node.props.displayX),
      y: Number(node.props.displayY),
      source: 'graph.display',
    });
  }

  const incomingByTarget = new Map();
  for (const edge of edges) {
    if (!incomingByTarget.has(edge.end)) incomingByTarget.set(edge.end, []);
    incomingByTarget.get(edge.end).push(edge);
  }

  for (const node of nodes) {
    if (positioned.has(node.id)) continue;
    const incoming = (incomingByTarget.get(node.id) || []).find((edge) => positioned.has(edge.start));
    const sourcePosition = incoming ? positioned.get(incoming.start) : null;
    const lane = isUiNode(node) ? 'left' : 'right';
    const key = `${lane}:${sourcePosition?.y ?? 0}`;
    const ordinal = laneCounters.get(key) || 0;
    laneCounters.set(key, ordinal + 1);
    const y = (sourcePosition?.y ?? 0) + ordinal * 0.8;
    const x = lane === 'left' ? minX - 2.2 : maxX + 2.2 + ordinal * 1.2;
    positioned.set(node.id, {
      x,
      y,
      source: incoming ? `derived from ${incoming.start}` : 'derived fallback',
    });
  }

  return positioned;
}

function submethodVisualAnchorOffsetY(node, nodeById, positions, scaleY, seen = new Set()) {
  if (!node || seen.has(node.id)) return 0;
  if (node.labels?.includes('HybridSubStepHeader')) return 0;
  seen.add(node.id);
  const relativeRow = Number(
    node.props?.submethodRelativeRow
    ?? node.props?.submethod_relative_row,
  );
  const headerStableId = String(
    node.props?.memberOfSubmethodStableId
    || node.props?.member_of_submethod_stable_id
    || '',
  );
  const header = nodeById.get(headerStableId);
  const fallbackParentStableId = String(
    header?.props?.parentSubmethodStableId
    || header?.props?.parent_submethod_stable_id
    || '',
  );
  const anchorStableId = String(
    node.props?.submethodAnchorStableId
    || node.props?.submethod_anchor_stable_id
    || fallbackParentStableId,
  );
  const parent = nodeById.get(anchorStableId);
  if (!parent) return 0;
  const anchorRelativeRow = Number(
    parent.props?.submethodRelativeRow
    ?? parent.props?.submethod_relative_row,
  );
  if (
    !Number.isFinite(relativeRow)
    || (relativeRow !== 0 && relativeRow !== anchorRelativeRow)
  ) return 0;
  const nodePosition = positions.get(node.id);
  const anchorPosition = positions.get(parent.id);
  const rowOffset = nodePosition && anchorPosition
    ? (anchorPosition.y - nodePosition.y) * scaleY
    : 0;
  const nodeSize = sizeForNode(node, labelForNode(node));
  const parentSize = sizeForNode(parent, labelForNode(parent));
  const nodePart = structuredContainerOverlayPartBox(node, {
    x: 0,
    y: 0,
    ...nodeSize,
  }, 'method');
  const predicatesShareRow = node.labels?.includes('Branch') && parent.labels?.includes('Branch');
  const parentPart = structuredContainerOverlayPartBox(parent, {
    x: 0,
    y: 0,
    ...parentSize,
  }, predicatesShareRow ? 'method' : 'container');
  if (!nodePart || !parentPart) return rowOffset;
  const nodeAnchorOffset = nodePart.y + nodePart.height / 2 - nodeSize.height / 2;
  const parentAnchorOffset = parentPart.y + parentPart.height / 2 - parentSize.height / 2;
  const parentVisualOffset = submethodVisualAnchorOffsetY(parent, nodeById, positions, scaleY, seen);
  return rowOffset + parentVisualOffset + parentAnchorOffset - nodeAnchorOffset;
}

function submethodVisualAnchorOffsetX(node, nodeById, positions, scaleX) {
  const relativeColumn = Number(
    node.props?.submethodRelativeColumn
    ?? node.props?.submethod_relative_column,
  );
  const relativeRow = Number(
    node.props?.submethodRelativeRow
    ?? node.props?.submethod_relative_row,
  );
  const anchorStableId = String(
    node.props?.submethodAnchorStableId
    || node.props?.submethod_anchor_stable_id
    || '',
  );
  const anchor = nodeById.get(anchorStableId);
  if (!anchor) return 0;
  const anchorColumn = Number(
    anchor.props?.submethodRelativeColumn
    ?? anchor.props?.submethod_relative_column,
  );
  const anchorRow = Number(
    anchor.props?.submethodRelativeRow
    ?? anchor.props?.submethod_relative_row,
  );
  if (
    !Number.isFinite(relativeColumn)
    || !Number.isFinite(anchorColumn)
    || relativeColumn <= anchorColumn
    || !Number.isFinite(relativeRow)
    || relativeRow !== anchorRow
  ) return 0;
  const nodePosition = positions.get(node.id);
  const anchorPosition = positions.get(anchor.id);
  if (!nodePosition || !anchorPosition) return 0;
  const nodeSize = sizeForNode(node, labelForNode(node));
  const anchorSize = sizeForNode(anchor, labelForNode(anchor));
  const nodeLeft = nodePosition.x * scaleX - nodeSize.width / 2;
  const anchorRight = anchorPosition.x * scaleX + anchorSize.width / 2;
  return Math.max(0, anchorRight + RENDERED_NODE_GAP - nodeLeft);
}

export function assignStepAndFlowBlockColumns(
  nodes,
  edges,
  semanticNodes,
  coordinates,
  columnInset = 1,
) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const stepFacts = (semanticNodes || []).filter((node) => (node.labels || []).includes('Step'));
  const blockFacts = (semanticNodes || []).filter((node) => (node.labels || []).includes('Block'));
  const stepById = new Map(stepFacts.map((step) => [step.key, step]));
  const blockById = new Map(blockFacts.map((block) => [block.key, block]));
  const membersByStepId = new Map(stepFacts.map((step) => [step.key, []]));
  const stepIdByNodeId = new Map();

  for (const node of nodes) {
    const stepId = String(node.props?.parentStepStableId || '').trim();
    if (!stepId || !stepById.has(stepId)) continue;
    membersByStepId.get(stepId).push(node);
    stepIdByNodeId.set(node.id, stepId);
  }

  const headIdForStep = (stepId) => {
    const step = stepById.get(stepId);
    const extractedHeads = Array.isArray(step?.props?.headStableIds) ? step.props.headStableIds : [];
    const stepMembers = membersByStepId.get(stepId) || [];
    const projectedHead = extractedHeads.flatMap((extractedHeadId) => stepMembers
      .filter((member) => (
        extractedHeadId === member.id
        || extractedHeadId.startsWith(`${member.id}:horizontal-owner-`)
        || extractedHeadId === member.props?.canonicalStableId
        || extractedHeadId === member.props?.canonical_stable_id
      )))[0];
    return extractedHeads.find((id) => coordinates.has(id))
      || projectedHead?.id
      || membersByStepId.get(stepId)?.find((node) => coordinates.has(node.id))?.id;
  };
  const stepHeadX = (stepId) => {
    const headId = headIdForStep(stepId);
    const coordinate = headId ? coordinates.get(headId) : undefined;
    const head = headId ? nodeById.get(headId) : undefined;
    return coordinate
      ? visualFlowAxisX(head, coordinate)
      : undefined;
  };
  const stepBlockId = (stepId) => {
    // A one-step FlowBlock is represented by the same extracted entity as its
    // Step. It owns a side-flow column even though it also names its parent
    // block for hierarchy traversal.
    if (blockById.has(stepId)) return stepId;
    const extractedOwner = parentFlowBlockStableIdForNode(stepById.get(stepId));
    if (extractedOwner) return extractedOwner;
    return (membersByStepId.get(stepId) || [])
      .map(parentFlowBlockStableIdForNode)
      .find(Boolean);
  };
  const stepOrder = (stepId) => {
    const values = (membersByStepId.get(stepId) || [])
      .map((node) => Number(node.props?.flowStepOrder))
      .filter(Number.isFinite);
    return values.length ? Math.min(...values) : Number.POSITIVE_INFINITY;
  };

  const rootSteps = stepFacts
    .map((step) => step.key)
    .filter((stepId) => membersByStepId.get(stepId)?.length && !stepBlockId(stepId))
    .sort((left, right) => stepOrder(left) - stepOrder(right));
  const fallbackSteps = stepFacts
    .map((step) => step.key)
    .filter((stepId) => membersByStepId.get(stepId)?.length)
    .sort((left, right) => stepOrder(left) - stepOrder(right));
  const rootColumn = stepHeadX(rootSteps[0] || fallbackSteps[0]);
  if (!Number.isFinite(rootColumn)) return { movedStepCount: 0, blockColumns: new Map() };

  const incomingByTarget = new Map();
  for (const edge of edges) {
    if (!incomingByTarget.has(edge.end)) incomingByTarget.set(edge.end, []);
    incomingByTarget.get(edge.end).push(edge);
  }
  const blockColumnCache = new Map();
  const blockColumn = (blockId, active = new Set()) => {
    if (!blockId || !blockById.has(blockId)) return rootColumn;
    if (blockColumnCache.has(blockId)) return blockColumnCache.get(blockId);
    if (active.has(blockId)) return rootColumn;
    active.add(blockId);
    const block = blockById.get(blockId);
    const headIds = Array.isArray(block.props?.headStableIds) ? block.props.headStableIds : [];
    const ownerIds = Array.isArray(block.props?.ownerBranchStableIds) ? block.props.ownerBranchStableIds : [];
    const externalSourceIds = [
      ...ownerIds,
      ...headIds.flatMap((headId) => (incomingByTarget.get(headId) || []).map((edge) => edge.start)),
    ].filter((sourceId) => {
      const sourceStepId = stepIdByNodeId.get(sourceId);
      return sourceStepId && stepBlockId(sourceStepId) !== blockId;
    });
    const sourceStepId = externalSourceIds.map((id) => stepIdByNodeId.get(id)).find(Boolean);
    const parentBlockId = parentFlowBlockStableIdForNode(block);
    const predecessorColumn = sourceStepId
      ? blockColumn(stepBlockId(sourceStepId), active)
      : blockColumn(parentBlockId, active);
    const result = predecessorColumn + columnInset;
    blockColumnCache.set(blockId, result);
    active.delete(blockId);
    return result;
  };

  let movedStepCount = 0;
  for (const stepId of fallbackSteps) {
    const currentHeadX = stepHeadX(stepId);
    if (!Number.isFinite(currentHeadX)) continue;
    const ownerBlockId = stepBlockId(stepId);
    const targetHeadX = ownerBlockId ? blockColumn(ownerBlockId) : rootColumn;
    const deltaX = targetHeadX - currentHeadX;
    if (Math.abs(deltaX) < 1e-9) continue;
    for (const member of membersByStepId.get(stepId) || []) {
      const coordinate = coordinates.get(member.id);
      if (coordinate) coordinate.x += deltaX;
    }
    movedStepCount += 1;
  }
  return { movedStepCount, blockColumns: blockColumnCache };
}

const FOLDING_ROW_GAP = 14;
const FOLDING_ROW_TOP_PADDING = 38;
const FOLDING_ROW_BOTTOM_PADDING = 22;
const FOLDING_ROW_HORIZONTAL_PADDING = 36;
const FOLDING_ROW_COLLAPSED_HEIGHT = 28;
const FLOW_BLOCK_CONTENT_INSET = 52;
const FLOW_BLOCK_VISUAL_OVERHANG_INSET = 16;
const FLOW_BLOCK_SIDE_COLUMN_INSET = 260;
const FLOW_BLOCK_VERTICAL_INSET = 5;
const FLOW_BLOCK_STEP_TOP_PADDING = 28;
const FLOW_BLOCK_NESTED_TOP_INSET = 36;
const FLOW_BLOCK_NESTED_BOTTOM_INSET = 36;
const FOLDING_CONTAINER_MIN_INSET = 24;
const RENDERED_NODE_GAP = 8;
const HORIZONTAL_STEP_COLUMN_GAP = 56;
const HORIZONTAL_FAMILY_BOUNDARY_GAP = 36;
const SLOT_EDGE_LABEL_CHARACTER_WIDTH = 7;
const SLOT_EDGE_LABEL_HORIZONTAL_PADDING = 28;
const HORIZONTAL_MOSAIC_OUTCOME_TOP_INSET = 24;

export function flowBlockLeftBoundary(memberBoxes, memberBounds, layoutLeft) {
  const minNodeX = Math.min(...memberBoxes.map((box) => box.x));
  const minContentX = Math.min(...memberBounds.map((bounds) => bounds.left));
  return {
    minNodeX,
    minContentX,
    x: Math.max(layoutLeft + 4, Math.min(
      minNodeX - FLOW_BLOCK_CONTENT_INSET,
      minContentX - FLOW_BLOCK_VISUAL_OVERHANG_INSET,
    )),
  };
}

function slotEdgeLabelRequiredGap(edge) {
  const name = slotNameForEdge(edge);
  return name
    ? name.length * SLOT_EDGE_LABEL_CHARACTER_WIDTH + SLOT_EDGE_LABEL_HORIZONTAL_PADDING
    : HORIZONTAL_STEP_COLUMN_GAP;
}
const COMPACT_CALL_SNIPPET_GAP = 24;

function foldingRowKey(position) {
  return Number(position?.y || 0).toFixed(6);
}

function foldingContainerMetadata(row, edges, semanticNodes = []) {
  const ordered = [...row.nodes].sort((left, right) =>
    Number(left.props?.operationIndex ?? Number.MAX_SAFE_INTEGER)
      - Number(right.props?.operationIndex ?? Number.MAX_SAFE_INTEGER)
    || left.id.localeCompare(right.id));
  const memberIds = new Set(ordered.map((node) => node.id));
  const internalTypes = new Set([
    'NEXT', 'PARAM', 'TRUE', 'FALSE', 'OPTION_CASE', 'OPTION_DEFAULT', 'MERGES_TO',
    'ITERATOR', 'OF', 'ARG', 'ArgJoin', 'XOR_JOIN', 'ARROW', 'VALUE', 'EVAL',
    'FIELD', 'FieldJoin', 'CREATES_VALUE', 'RECEIVES_VALUE', 'READS_VALUE',
    'WRITES_VALUE', 'PASSES_VALUE', 'CLEARS_VALUE', 'DELETES_VALUE', 'CAPTURES_VALUE',
  ]);
  const incoming = new Set();
  const outgoing = new Set();
  for (const edge of edges) {
    if (!internalTypes.has(edge.type) || !memberIds.has(edge.start) || !memberIds.has(edge.end)) continue;
    outgoing.add(edge.start);
    incoming.add(edge.end);
  }
  const heads = ordered.map((node) => node.id).filter((id) => !incoming.has(id));
  const tails = ordered.map((node) => node.id).filter((id) => !outgoing.has(id));
  const stepStableId = ordered
    .map((node) => String(node.props?.parentStepStableId || '').trim())
    .find(Boolean) || '';
  const stepFact = stepStableId
    ? semanticNodes.find((node) => (
        node.key === stepStableId && (node.labels || []).includes('Step')
      ))
    : undefined;
  const extractedHeadStableIds = stepFact?.props?.headStableIds
    || stepFact?.props?.head_stable_ids
    || [];
  const extractedTailStableIds = stepFact?.props?.tailStableIds
    || stepFact?.props?.tail_stable_ids
    || [];
  const headStableIds = extractedHeadStableIds.length
    ? extractedHeadStableIds.map(String)
    : heads.length ? heads : ordered.length ? [ordered[0].id] : [];
  const tailStableIds = extractedTailStableIds.length
    ? extractedTailStableIds.map(String)
    : tails.length ? tails : ordered.length ? [ordered.at(-1).id] : [];
  const anchor = ordered[0];
  const kind = stepStableId ? 'Step' : anchor ? graphKindForNode(anchor) : 'GraphGroup';
  const stableId = stepStableId || headStableIds[0] || tailStableIds[0] || '';
  const labels = stepStableId ? (stepFact?.labels || ['Step']) : (anchor?.labels || []);
  const label = stepStableId ? 'step' : anchor ? labelForNode(anchor) : 'graph group';
  const functionStableId = ordered.map(functionStableIdForNode).find(Boolean) || '';
  const query = new URLSearchParams({
    kind,
    stableId,
    functionStableId,
    headStableIds: headStableIds.join(','),
    tailStableIds: tailStableIds.join(','),
    labels: labels.join(','),
    label,
  });
  return `stableId="${xml(stableId)}" functionStableId="${xml(functionStableId)}" headStableIds="${xml(headStableIds.join(','))}" tailStableIds="${xml(tailStableIds.join(','))}" graphKind="${xml(kind)}" graphLabels="${xml(labels.join(','))}" graphLabel="${xml(label)}" link="${xml(`codex-graph://item?${query}`)}"`;
}

function flowBlockMetadata(block) {
  const rows = [...block.memberRowIds]
    .map((rowId) => block.rowsById?.get(rowId))
    .filter(Boolean)
    .sort((left, right) => left.y - right.y);
  const headStableIds = rows[0]?.nodes.map((node) => node.id) || [block.seed.id];
  const tailStableIds = rows.at(-1)?.nodes.map((node) => node.id) || [block.seed.id];
  const stableId = block.graphFact?.key || block.source.id;
  const functionStableId = functionStableIdForNode(block.source);
  const query = new URLSearchParams({
    kind: 'FlowBlock',
    stableId,
    functionStableId,
    labels: 'FlowBlock',
    label: 'side flow',
    headStableIds: headStableIds.join(','),
    tailStableIds: tailStableIds.join(','),
  });
  return `stableId="${xml(stableId)}" functionStableId="${xml(functionStableId)}" headStableIds="${xml(headStableIds.join(','))}" tailStableIds="${xml(tailStableIds.join(','))}" flowBlock="1" graphKind="FlowBlock" graphLabels="FlowBlock" graphLabel="side flow" link="${xml(`codex-graph://item?${query}`)}"`;
}

function parentFlowBlockStableIdForNode(node) {
  return String(
    node?.props?.parentFlowBlockStableId
    || node?.props?.parent_flow_block_stable_id
    || '',
  ).trim();
}

function isCombinedStepFlowBlock(block) {
  const props = block?.graphFact?.props || block?.props || {};
  return props.combinedStepFlowBlock === true
    || props.combined_step_flow_block === true;
}

function isSideFlowBlock(block) {
  const props = block?.graphFact?.props || block?.props || {};
  return props.flowBlockRole === 'side'
    || props.flow_block_role === 'side'
    || String(block?.graphFact?.key || '').startsWith('flow-block:side:');
}

function renderedFlowBlockParent(block) {
  return block?.parent || null;
}

function buildRendererFlowBlocks(
  visibleNodes,
  positions,
  nodeBoxes,
  edges,
  rows,
  rowByNodeId,
  layout,
  semanticNodes = [],
) {
  const nodeById = new Map(visibleNodes.map((node) => [node.id, node]));
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const flowBlockFacts = semanticNodes.filter((node) => {
    const labels = new Set(node.labels || []);
    return labels.has('Block');
  });
  const factById = new Map(flowBlockFacts.map((fact) => [fact.key, fact]));
  for (const node of visibleNodes) {
    const ownerStableId = parentFlowBlockStableIdForNode(node);
    if (ownerStableId && !factById.has(ownerStableId)) {
      throw new Error(`Extracted FlowBlock was not found for ${node.id}: ${ownerStableId}`);
    }
  }
  const includesBlock = (candidateId, directId) => {
    let currentId = directId;
    const seen = new Set();
    while (currentId && !seen.has(currentId)) {
      if (currentId === candidateId) return true;
      seen.add(currentId);
      currentId = parentFlowBlockStableIdForNode(factById.get(currentId));
    }
    return false;
  };
  const uniqueCandidates = flowBlockFacts.map((graphFact) => {
    const memberRowIds = new Set(rows
      .filter((row) => row.nodes.some((node) => (
        includesBlock(graphFact.key, parentFlowBlockStableIdForNode(node))
      )))
      .map((row) => row.id));
    const headIds = Array.isArray(graphFact.props?.headStableIds)
      ? graphFact.props.headStableIds
      : [];
    const ownerIds = Array.isArray(graphFact.props?.ownerBranchStableIds)
      ? graphFact.props.ownerBranchStableIds
      : [];
    const seed = headIds.map((id) => nodeById.get(id)).find(Boolean)
      || [...memberRowIds].flatMap((rowId) => rowById.get(rowId)?.nodes || [])[0];
    const source = ownerIds.map((id) => nodeById.get(id)).find(Boolean) || seed;
    return {
      key: graphFact.key,
      source,
      seed,
      graphFact,
      memberRowIds,
    };
  }).filter((candidate) => candidate.source && candidate.seed && candidate.memberRowIds.size);

  const unframedBlocks = new Set(edges.filter(edge => edge.type === 'NEXT'
    && hasLabel(nodeById.get(edge.start), 'For'))
    .map(edge => parentFlowBlockStableIdForNode(nodeById.get(edge.end))).filter(Boolean));
  const rootRight = layout.x + layout.width;
  const blocks = uniqueCandidates.filter(candidate => !unframedBlocks.has(candidate.key)).map((candidate, index) => {
    const memberRows = [...candidate.memberRowIds].map((id) => rowById.get(id)).filter(Boolean);
    const memberEntries = memberRows.flatMap((row) => row.nodes
      .map((node) => ({ node, box: nodeBoxes.get(node.id) }))
      .filter(({ box }) => Boolean(box)));
    const memberBoxes = memberEntries.map(({ box }) => box);
    const memberBounds = memberEntries.map(({ node, box }) => visualHorizontalBounds(node, box));
    const blockLeft = flowBlockLeftBoundary(memberBoxes, memberBounds, layout.x);
    const { minNodeX, minContentX } = blockLeft;
    const globalX = blockLeft.x;
    const globalY = Math.max(0, Math.min(...memberRows.map((row) => row.y)) - FLOW_BLOCK_VERTICAL_INSET);
    const globalBottom = Math.max(...memberRows.map((row) => row.y + row.height)) + FLOW_BLOCK_VERTICAL_INSET;
    return {
      id: `flow-block-${index + 1}`,
      key: candidate.key,
      source: candidate.source,
      seed: candidate.seed,
      edge: candidate.edge,
      graphFact: candidate.graphFact,
      combinedStepFlowBlock: Boolean(
        candidate.graphFact?.props?.combinedStepFlowBlock
        || candidate.graphFact?.props?.combined_step_flow_block
      ),
      memberRowIds: candidate.memberRowIds,
      minNodeX,
      minContentX,
      globalX,
      globalY,
      width: Math.max(120, rootRight - globalX + FLOW_BLOCK_CONTENT_INSET),
      height: Math.max(FOLDING_ROW_COLLAPSED_HEIGHT, globalBottom - globalY),
      parent: null,
      depth: 0,
    };
  });

  const blockByFactId = new Map(blocks.map((block) => [block.graphFact?.key, block]));
  for (const block of blocks) {
    const parentStableId = parentFlowBlockStableIdForNode(block.graphFact);
    if (parentStableId && !factById.has(parentStableId)) {
      throw new Error(`Extracted parent FlowBlock was not found for ${block.graphFact?.key}: ${parentStableId}`);
    }
    let renderedParentId = parentStableId;
    while (unframedBlocks.has(renderedParentId)) {
      renderedParentId = parentFlowBlockStableIdForNode(factById.get(renderedParentId));
    }
    block.parent = blockByFactId.get(renderedParentId) || null;
  }
  const assignDepth = (block) => {
    if (!block.parent) return 0;
    if (!Number.isFinite(block.parent.depth) || block.parent.depth <= 0) {
      block.parent.depth = assignDepth(block.parent);
    }
    return block.parent.depth + 1;
  };
  blocks.forEach((block) => { block.depth = assignDepth(block); });

  const deepestBlockByRowId = new Map();
  for (const row of rows) {
    const owners = blocks.filter((block) => block.memberRowIds.has(row.id));
    owners.sort((left, right) => right.depth - left.depth || left.memberRowIds.size - right.memberRowIds.size);
    if (owners[0]) deepestBlockByRowId.set(row.id, owners[0]);
  }
  for (const block of blocks) {
    const parentLeft = block.parent?.globalX ?? layout.x;
    const parentInset = parentLeft + (block.parent ? FOLDING_CONTAINER_MIN_INSET : 4);
    const contentBoundary = Math.min(
      block.minNodeX - FLOW_BLOCK_CONTENT_INSET,
      block.minContentX - FLOW_BLOCK_VISUAL_OVERHANG_INSET,
    );
    block.globalX = Math.max(parentInset, contentBoundary);
    block.width = Math.max(120, rootRight - block.globalX + FLOW_BLOCK_CONTENT_INSET);
  }
  for (const row of rows) {
    const owner = deepestBlockByRowId.get(row.id);
    row.flowBlock = owner || null;
    row.globalX = owner ? owner.globalX + FLOW_BLOCK_CONTENT_INSET : layout.x;
    const contentRight = Math.max(
      row.globalX + 120,
      ...row.nodes
        .map((node) => {
          const box = nodeBoxes.get(node.id);
          return box ? visualHorizontalBounds(node, box) : undefined;
        })
        .filter(Boolean)
        .map((bounds) => bounds.right),
    );
    row.width = Math.max(
      120,
      Math.ceil(contentRight - row.globalX + FOLDING_ROW_HORIZONTAL_PADDING),
    );
  }

  const renderBlocks = blocks;
  const renderBlockSet = new Set(renderBlocks);
  for (const block of renderBlocks) {
    block.parent = block.parent && renderBlockSet.has(block.parent) ? block.parent : null;
  }

  // Preserve the already positioned graph content and grow nested containers
  // from the inside out. Moving a child frame to the right would also require
  // moving its graph nodes; widening its parent to the left keeps graph
  // coordinates stable and guarantees a real nesting inset.
  [...renderBlocks]
    .sort((left, right) => right.depth - left.depth)
    .forEach((block) => {
      if (!block.parent) return;
      block.parent.globalX = Math.min(
        block.parent.globalX,
        block.globalX - FOLDING_CONTAINER_MIN_INSET,
      );
    });
  const originalRootRight = layout.x + layout.width;
  const requiredRootLeft = renderBlocks.length
    ? Math.min(layout.x, ...renderBlocks
      .filter((block) => !block.parent)
      .map((block) => block.globalX - 4))
    : layout.x;
  layout.x = requiredRootLeft;
  layout.width = originalRootRight - requiredRootLeft;

  // Measure from the deepest children outwards. A nested FlowBlock is one
  // indivisible vertical item of its parent; parents never grow upward around
  // coordinates that were already assigned.
  const originalRowY = new Map(rows.map((row) => [row.id, row.y]));
  const directItemsByBlockId = new Map(renderBlocks.map((block) => [block.id, []]));
  const rootItems = [];
  for (const block of renderBlocks) {
    if (block.parent) directItemsByBlockId.get(block.parent.id)?.push(block);
    else rootItems.push(block);
  }
  for (const row of rows) {
    if (row.flowBlock && renderBlockSet.has(row.flowBlock)) {
      directItemsByBlockId.get(row.flowBlock.id)?.push(row);
    } else {
      rootItems.push(row);
    }
  }

  const rowSemanticOrder = (row) => {
    const orders = (row?.nodes || [])
      .map((node) => Number(node.props?.flowStepOrder))
      .filter(Number.isFinite);
    return orders.length ? Math.min(...orders) : undefined;
  };
  const itemAnchorY = (item) => {
    if (item.id.startsWith('fold-row-')) {
      const semanticOrder = rowSemanticOrder(item);
      if (Number.isFinite(semanticOrder)) return semanticOrder;
      return Number.isFinite(item.graphY)
        ? item.graphY
        : originalRowY.get(item.id) ?? 0;
    }
    const memberYs = [...item.memberRowIds]
      .map((rowId) => rowSemanticOrder(rowById.get(rowId)))
      .filter(Number.isFinite);
    if (memberYs.length) return Math.min(...memberYs);
    const originalMemberYs = [...item.memberRowIds]
      .map((rowId) => originalRowY.get(rowId))
      .filter(Number.isFinite);
    return originalMemberYs.length ? Math.min(...originalMemberYs) : 0;
  };
  const sortItems = (items) => items.sort((left, right) =>
    itemAnchorY(left) - itemAnchorY(right) || left.id.localeCompare(right.id));

  const measuredBlocks = new Set();
  const measureBlock = (block) => {
    if (measuredBlocks.has(block.id)) return block.height;
    const items = sortItems(directItemsByBlockId.get(block.id) || []);
    const itemHeights = items.map((item) =>
      item.id.startsWith('fold-row-') ? item.height : measureBlock(item));
    const contentHeight = itemHeights.reduce((sum, height) => sum + height, 0)
      + Math.max(0, items.length - 1) * FOLDING_ROW_GAP;
    block.height = block.combinedStepFlowBlock
      ? contentHeight
      : Math.max(
          FOLDING_ROW_COLLAPSED_HEIGHT,
          FLOW_BLOCK_NESTED_TOP_INSET + contentHeight + FLOW_BLOCK_NESTED_BOTTOM_INSET,
        );
    const contentRight = items.length
      ? Math.max(...items.map((item) => item.globalX + item.width))
      : rootRight;
    block.width = Math.max(120, contentRight + FLOW_BLOCK_CONTENT_INSET - block.globalX);
    block.layoutItems = items;
    measuredBlocks.add(block.id);
    return block.height;
  };
  renderBlocks.forEach(measureBlock);

  const placeBlock = (block, top) => {
    block.globalY = top;
    let cursor = top + (block.combinedStepFlowBlock ? 0 : FLOW_BLOCK_NESTED_TOP_INSET);
    for (const item of block.layoutItems || []) {
      if (item.id.startsWith('fold-row-')) {
        item.y = cursor;
      } else {
        placeBlock(item, cursor);
      }
      cursor += item.height + FOLDING_ROW_GAP;
    }
  };
  sortItems(rootItems);
  let rootCursor = 0;
  for (const item of rootItems) {
    if (item.id.startsWith('fold-row-')) item.y = rootCursor;
    else placeBlock(item, rootCursor);
    rootCursor += item.height + FOLDING_ROW_GAP;
  }
  layout.height = Math.max(0, rootCursor - FOLDING_ROW_GAP);

  const rowsById = new Map(rows.map((row) => [row.id, row]));
  renderBlocks.forEach((block) => { block.rowsById = rowsById; });
  alignForInitializationRows(visibleNodes, edges, nodeBoxes, semanticNodes,
    { ...layout, rowByNodeId, blocks: renderBlocks });
  return { blocks: renderBlocks, deepestBlockByRowId };
}

function rowHeadAxisCenter(row, nodeBoxes) {
  const headStableIds = Array.isArray(row?.graphFact?.props?.headStableIds)
    ? row.graphFact.props.headStableIds
    : [];
  for (const stableId of headStableIds) {
    const box = nodeBoxes.get(stableId);
    if (box) return box.x + box.width / 2;
  }
  const centers = (row?.nodes || [])
    .map((node) => nodeBoxes.get(node.id))
    .filter(Boolean)
    .map((box) => box.x + box.width / 2);
  return centers.length ? Math.min(...centers) : undefined;
}

function sideFlowBlockColumnDelta(block, layout, nodeBoxes) {
  const sourceRow = layout.rowByNodeId.get(block.source?.id);
  if (!sourceRow || block.memberRowIds.has(sourceRow.id)) return undefined;
  const predecessorAxisX = rowHeadAxisCenter(sourceRow, nodeBoxes);
  const seedBox = nodeBoxes.get(block.seed?.id);
  if (!Number.isFinite(predecessorAxisX) || !seedBox) return undefined;
  const seedAxisX = seedBox.x + seedBox.width / 2;
  return predecessorAxisX + FLOW_BLOCK_SIDE_COLUMN_INSET - seedAxisX;
}

function foldingContainerGeometryCheck(layout, nodeBoxes) {
  const layoutNodeById = new Map(layout.rows.flatMap((row) => row.nodes).map((node) => [node.id, node]));
  const blockContainers = layout.blocks.map((block) => ({
    id: block.id,
    kind: 'FlowBlock',
    parentId: renderedFlowBlockParent(block)?.id || null,
    rect: {
      left: block.globalX,
      top: block.globalY,
      right: block.globalX + block.width,
      bottom: block.globalY + block.height,
    },
    control: {
      left: block.globalX + 14,
      top: block.globalY,
      right: block.globalX + 42,
      bottom: block.globalY + 28,
    },
  }));
  const stepContainers = layout.rows.map((row) => ({
    id: row.id,
    kind: 'Step',
    parentId: row.flowBlock?.id || null,
    rect: {
      left: row.globalX,
      top: row.y,
      right: row.globalX + row.width,
      bottom: row.y + row.height,
    },
    control: {
      left: row.globalX + 10,
      top: row.y + 10,
      right: row.globalX + 34,
      bottom: row.y + 34,
    },
  }));
  const containers = [...blockContainers, ...stepContainers];
  const byId = new Map(containers.map((container) => [container.id, container]));
  const isAncestor = (candidate, container) => {
    let parentId = container.parentId;
    while (parentId) {
      if (parentId === candidate.id) return true;
      parentId = byId.get(parentId)?.parentId || null;
    }
    return false;
  };
  const strictlyContains = (outer, inner) => (
    inner.left > outer.left
    && inner.top > outer.top
    && inner.right < outer.right
    && inner.bottom < outer.bottom
  );
  const containsWithInset = (outer, inner, inset) => (
    inner.left - outer.left >= inset
    && inner.top - outer.top >= inset
    && outer.right - inner.right >= inset
    && outer.bottom - inner.bottom >= inset
  );
  const overlapsOrTouches = (left, right) => (
    Math.max(left.left, right.left) <= Math.min(left.right, right.right)
    && Math.max(left.top, right.top) <= Math.min(left.bottom, right.bottom)
  );
  const findings = [];

  for (const row of layout.rows) {
    const stableId = String(row.graphFact?.key || '');
    const location = stableId.match(/:(\d+):\d+:(\d+):\d+$/u);
    if (
      stableId.startsWith('flow-step:statement:')
      && location
      && location[1] === location[2]
      && row.height > 2400
    ) {
      findings.push({
        type: 'implausible-single-line-step-height',
        step: { id: row.id, stableId, height: row.height },
        investigation: [
          'A single-line statement Step must not span thousands of pixels vertically.',
          'Check whether producer and container nodes were aligned before folding bounds were calculated.',
        ],
      });
    }
  }

  for (const container of containers) {
    if (!container.parentId) continue;
    const parent = byId.get(container.parentId);
    const requiredInset = container.kind === 'Step' ? 0 : FOLDING_CONTAINER_MIN_INSET;
    if (!parent || containsWithInset(parent.rect, container.rect, requiredInset)) continue;
    findings.push({
      type: 'invalid-nesting',
      parent: parent && { id: parent.id, kind: parent.kind, ...parent.rect },
      child: { id: container.id, kind: container.kind, ...container.rect },
      investigation: [
        `A nested Step or FlowBlock must keep at least ${FOLDING_CONTAINER_MIN_INSET}px from every parent boundary.`,
        'Touching, crossing, or visually protruding into the parent boundary zone is a conflict.',
      ],
    });
  }

  for (const block of layout.blocks.filter((candidate) => isSideFlowBlock(candidate))) {
    const deltaX = sideFlowBlockColumnDelta(block, layout, nodeBoxes);
    if (!Number.isFinite(deltaX) || Math.abs(deltaX) <= 1) continue;
    findings.push({
      type: 'misaligned-side-flow',
      predecessorStep: layout.rowByNodeId.get(block.source?.id)?.id || '',
      child: block.id,
      requiredContentShift: deltaX,
      expectedColumnOffset: FLOW_BLOCK_SIDE_COLUMN_INSET,
      investigation: [
        'A side-flow block head must occupy the next column after its predecessor Step head.',
      ],
    });
  }

  for (let leftIndex = 0; leftIndex < blockContainers.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < blockContainers.length; rightIndex += 1) {
      const left = blockContainers[leftIndex];
      const right = blockContainers[rightIndex];
      if (overlapsOrTouches(left.control, right.control)) {
        findings.push({
          type: 'folding-control-intersection',
          left: { id: left.id, kind: left.kind, ...left.control },
          right: { id: right.id, kind: right.kind, ...right.control },
          investigation: [
            'Folding controls of nested or adjacent containers must not overlap or touch.',
            'Control geometry is part of the rendered container layout.',
          ],
        });
      }
      if (isAncestor(left, right) || isAncestor(right, left)) continue;
      if (strictlyContains(left.rect, right.rect) || strictlyContains(right.rect, left.rect)) continue;
      if (!overlapsOrTouches(left.rect, right.rect)) continue;
      findings.push({
        type: 'container-intersection',
        left: { id: left.id, kind: left.kind, ...left.rect },
        right: { id: right.id, kind: right.kind, ...right.rect },
        investigation: [
          'Unrelated Step and FlowBlock boundaries must not intersect or touch.',
          'Only strict geometric nesting is allowed to occupy the same area.',
        ],
      });
    }
  }

  const renderedNodes = [...layout.rowByNodeId.entries()]
    .map(([nodeId, row]) => {
      const renderedNode = row?.nodes.find((candidate) => candidate.id === nodeId);
      if (renderedNode?.labels.includes('HybridSequenceAxis')) return null;
      const box = nodeBoxes.get(nodeId);
      if (!box || !row) return null;
      const visualBounds = visualNodeBounds(renderedNode, box);
      return {
        id: nodeId,
        rowId: row.id,
        objectFamilyStableId: renderedNode.props?.objectFamilyStableId || renderedNode.props?.object_family_stable_id || '',
        objectBraceSide: renderedNode.props?.objectBraceSide || renderedNode.props?.object_brace_side || '',
        objectBraceMosaicNeighborStableId: renderedNode.props?.objectBraceMosaicNeighborStableId
          || renderedNode.props?.object_brace_mosaic_neighbor_stable_id
          || '',
        methodChainOwnerStableId: methodChainOwnerStableId(renderedNode),
        isObjectBrace: isObjectBraceNode(renderedNode),
        mosaicOwnerStableIds: mosaicOwnerStableIds(renderedNode, layoutNodeById),
        overlayOwnerStableId: renderedNode.props?.hybridOverlayOwnerStableId || '',
        attachmentOwnerStableId: renderedNode.props?.hybridAttachmentOwnerStableId || '',
        compositionOwnerStableId: renderedNode.props?.hybridCompositionOwnerStableId || '',
        hybridVisualRole: renderedNode.props?.hybridVisualRole || '',
        rect: {
          left: box.x,
          top: row.y + FOLDING_ROW_TOP_PADDING + box.y - row.contentMinY,
          right: box.x + box.width,
          bottom: row.y + FOLDING_ROW_TOP_PADDING + box.y - row.contentMinY + box.height,
        },
        boundaryRect: {
          left: visualBounds.left,
          top: row.y + FOLDING_ROW_TOP_PADDING + visualBounds.top - row.contentMinY,
          right: visualBounds.right,
          bottom: row.y + FOLDING_ROW_TOP_PADDING + visualBounds.bottom - row.contentMinY,
        },
      };
    })
    .filter(Boolean);
  const renderedNodeById = new Map(renderedNodes.map((node) => [node.id, node]));
  const isCompositionAncestor = (node, possibleAncestorId) => {
    const visited = new Set();
    let current = node;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      const ownerId = current.overlayOwnerStableId
        || current.attachmentOwnerStableId
        || current.compositionOwnerStableId;
      if (!ownerId) return false;
      if (ownerId === possibleAncestorId) return true;
      current = renderedNodeById.get(ownerId);
    }
    return false;
  };

  for (const node of renderedNodes) {
    const row = byId.get(node.rowId);
    if (!row || containsWithInset(row.rect, node.boundaryRect, 0)) continue;
    findings.push({
      type: 'node-outside-step',
      node: { id: node.id, ...node.boundaryRect },
      step: row && { id: row.id, ...row.rect },
      investigation: [
        'Every rendered node must be strictly inside its owning Step.',
        'Touching or crossing the Step boundary is a conflict.',
      ],
    });
  }

  for (let leftIndex = 0; leftIndex < renderedNodes.length; leftIndex += 1) {
    const left = renderedNodes[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < renderedNodes.length; rightIndex += 1) {
      const right = renderedNodes[rightIndex];
      if (!overlapsOrTouches(left.rect, right.rect)) continue;
      const sameSideNestedObjectBraces = left.isObjectBrace
        && right.isObjectBrace
        && left.objectFamilyStableId
        && left.objectFamilyStableId === right.objectFamilyStableId
        && left.objectBraceSide === right.objectBraceSide;
      if (sameSideNestedObjectBraces) continue;
      const objectBraceMosaicSeam = (
        (left.isObjectBrace && left.objectBraceMosaicNeighborStableId === right.id)
        || (right.isObjectBrace && right.objectBraceMosaicNeighborStableId === left.id)
      ) && !(
        Math.max(left.rect.left, right.rect.left) < Math.min(left.rect.right, right.rect.right)
        && Math.max(left.rect.top, right.rect.top) < Math.min(left.rect.bottom, right.rect.bottom)
      );
      if (objectBraceMosaicSeam) continue;
      const sameMosaicBoundary = (
        left.mosaicOwnerStableIds.some((ownerId) => right.mosaicOwnerStableIds.includes(ownerId))
        && (
          Math.max(left.rect.left, right.rect.left) >= Math.min(left.rect.right, right.rect.right)
          || Math.max(left.rect.top, right.rect.top) >= Math.min(left.rect.bottom, right.rect.bottom)
        )
      );
      if (sameMosaicBoundary) continue;
      const methodChainMosaicSeam = (
        left.methodChainOwnerStableId === right.id
        || right.methodChainOwnerStableId === left.id
      ) && !(
        Math.max(left.rect.left, right.rect.left) < Math.min(left.rect.right, right.rect.right)
        && Math.max(left.rect.top, right.rect.top) < Math.min(left.rect.bottom, right.rect.bottom)
      );
      if (methodChainMosaicSeam) continue;
      const isExplicitOverlay = (
        isCompositionAncestor(left, right.id)
        || isCompositionAncestor(right, left.id)
      );
      if (isExplicitOverlay) continue;
      findings.push({
        type: 'node-intersection',
        left: { id: left.id, ...left.rect },
        right: { id: right.id, ...right.rect },
        investigation: [
          'Rendered graph nodes must not overlap or touch each other.',
          'Decorative method/object backplates are not graph nodes and are excluded.',
        ],
      });
    }
  }

  for (const node of renderedNodes) {
    const owner = byId.get(node.rowId);
    for (const container of containers) {
      if (container.id === node.rowId || isAncestor(container, owner)) continue;
      if (!overlapsOrTouches(container.rect, node.boundaryRect)) continue;
      if (strictlyContains(container.rect, node.boundaryRect)) continue;
      findings.push({
        type: 'node-container-boundary-intersection',
        node: { id: node.id, ...node.boundaryRect },
        container: { id: container.id, kind: container.kind, ...container.rect },
        investigation: [
          'A graph node must not cross or touch the boundary of an unrelated Step or FlowBlock.',
          'Nodes contained through the actual parent chain are checked against their owner separately.',
        ],
      });
    }
  }

  return {
    id: 'folding-container-boundaries',
    description: 'Graph nodes, folding controls, Steps, and FlowBlocks do not cross or touch unrelated element boundaries.',
    status: findings.length ? 'fail' : 'pass',
    findingCount: findings.length,
    findings,
  };
}

function emptyVerticalSpanCheck(layout, nodeBoxes) {
  const findings = [];
  const maximumEmptySpan = 520;
  for (const row of layout.rows) {
    const occupied = row.nodes
      .filter((node) => (
        !node.labels.includes('HybridSequenceAxis')
        && node.props?.hybridVisualRole !== 'functional-column'
      ))
      .map((node) => nodeBoxes.get(node.id))
      .filter(Boolean)
      .map((box) => ({ top: box.y, bottom: box.y + box.height }))
      .sort((left, right) => left.top - right.top);
    if (occupied.length < 2) continue;
    let occupiedBottom = occupied[0].bottom;
    for (const interval of occupied.slice(1)) {
      const gap = interval.top - occupiedBottom;
      if (gap > maximumEmptySpan) {
        findings.push({
          type: 'large-empty-vertical-span',
          stepId: row.id,
          gap,
          fromY: occupiedBottom,
          toY: interval.top,
          maximumEmptySpan,
          investigation: [
            'A Step contains a large vertical strip without rendered nodes.',
            'Check for a restored semantic node with default coordinates or an incorrectly shifted composition.',
          ],
        });
      }
      occupiedBottom = Math.max(occupiedBottom, interval.bottom);
    }
  }
  return {
    id: 'no-large-empty-vertical-spans',
    description: 'A Step does not contain unexplained empty vertical strips between rendered node groups.',
    status: findings.length ? 'fail' : 'pass',
    findingCount: findings.length,
    findings,
  };
}

function layoutFamilyStepCheck(layout) {
  const findings = [];
  for (const [nodeId, row] of layout.rowByNodeId) {
    const node = row.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) continue;
    for (const ownerId of node.props?.layoutFamilyOwnerKeys || []) {
      const ownerRow = layout.rowByNodeId.get(ownerId);
      if (!ownerRow || ownerRow.id === row.id) continue;
      findings.push({
        nodeId,
        ownerId,
        nodeStepId: row.id,
        ownerStepId: ownerRow.id,
        message: 'A layout-family member is rendered outside the Step containing its owner.',
      });
    }
  }
  return {
    id: 'layout-family-step-ownership',
    description: 'Arguments, fields, joins, and other layout-family members remain in their owner Step.',
    status: findings.length ? 'fail' : 'pass',
    findingCount: findings.length,
    findings,
  };
}

function separateRenderedNodesWithinSteps(layout, nodeBoxes) {
  let moved = 0;
  for (const row of layout.rows) {
    const boxes = row.nodes
      // Sequence axes deliberately pass through their method header and stage
      // nodes. They are lines with graph identity, not collision rectangles.
      .filter((node) => (
        !node.labels.includes('HybridSequenceAxis')
        && node.props?.hybridVisualRole !== 'functional-column'
        && !node.props?.hybridOverlayOwnerStableId
        && !node.props?.compactCallMosaic
      ))
      .map((node) => ({ node, box: nodeBoxes.get(node.id) }))
      .filter(({ box }) => box)
      .sort((left, right) => left.box.y - right.box.y || left.box.x - right.box.x);
    const placed = [];
    for (const item of boxes) {
      let requiredTop = item.box.y;
      for (const previous of placed) {
        const horizontalOverlap = Math.max(item.box.x, previous.box.x)
          <= Math.min(item.box.x + item.box.width, previous.box.x + previous.box.width);
        if (!horizontalOverlap) continue;
        requiredTop = Math.max(requiredTop, previous.box.y + previous.box.height + RENDERED_NODE_GAP);
      }
      if (requiredTop > item.box.y) {
        item.box.y = requiredTop;
        moved += 1;
      }
      placed.push(item);
    }
  }
  return moved;
}

function visualNodeBounds(node, box) {
  let boxes = [box];
  const objectMethod = objectMethodVisual(node);
  if (objectMethod) {
    const { receiverBox, methodBoxes } = objectMethodLayerBoxes(
      box,
      objectMethod,
      hasLabel(node, 'Collection'),
    );
    boxes = [box, receiverBox, ...methodBoxes];
    if (hasLabel(node, 'Collection')) boxes.push(...collectionStackBoxes(receiverBox));
  } else if (hasLabel(node, 'Collection')) {
    boxes = collectionStackBoxes(box);
  }
  return {
    left: Math.min(...boxes.map((candidate) => candidate.x)),
    top: Math.min(...boxes.map((candidate) => candidate.y)),
    right: Math.max(...boxes.map((candidate) => candidate.x + candidate.width)),
    bottom: Math.max(...boxes.map((candidate) => candidate.y + candidate.height)),
  };
}

function visualHorizontalBounds(node, box) {
  const bounds = visualNodeBounds(node, box);
  return { left: bounds.left, right: bounds.right };
}

function visualFlowAxisX(node, box) {
  if (!structuredContainerOverlaySize(node)) {
    return Number(box.x) + Number(box.width || 0) / 2;
  }
  const containerBox = structuredContainerOverlayPartBox(node, box, 'container');
  return containerBox.x + containerBox.width / 2;
}

function shiftStepContentsInsideVisualBoundary(layout, nodeBoxes) {
  let movedRows = 0;
  for (const row of layout.rows) {
    const members = row.nodes
      .map((node) => ({ node, box: nodeBoxes.get(node.id) }))
      .filter(({ box }) => box);
    if (!members.length) continue;
    const visualLeft = Math.min(...members.map(({ node, box }) => visualNodeBounds(node, box).left));
    const requiredLeft = row.globalX + FOLDING_ROW_HORIZONTAL_PADDING;
    const deltaX = Math.ceil(requiredLeft - visualLeft);
    if (deltaX <= 0) continue;
    for (const { box } of members) box.x += deltaX;
    movedRows += 1;
  }
  return movedRows;
}

function alignSingleStepHeadFamily(layout, nodeBoxes, edges, semanticNodes = []) {
  const familyEdgeTypes = new Set([
    'ARG', 'FIELD', 'ARG_JOIN', 'FIELD_JOIN',
    'MATERIALIZES_ARGUMENT', 'MATERIALIZES_FIELD',
  ]);
  const rowByNodeId = layout.rowByNodeId;
  const nodeById = new Map(layout.rows
    .flatMap((row) => row.nodes)
    .map((node) => [node.id, node]));
  const directDataJoinOutcomeKeys = new Set();
  const outcomeTypesByPair = new Map();
  for (const edge of edges) {
    if (!['TRUE', 'FALSE'].includes(edge.type) || !isDataJoinNode(nodeById.get(edge.end))) continue;
    const key = `${edge.start}\u0000${edge.end}`;
    if (!outcomeTypesByPair.has(key)) outcomeTypesByPair.set(key, new Set());
    outcomeTypesByPair.get(key).add(edge.type);
  }
  for (const [key, types] of outcomeTypesByPair) {
    if (types.has('TRUE') && types.has('FALSE')) directDataJoinOutcomeKeys.add(key);
  }
  const stepFactById = new Map(semanticNodes
    .filter((node) => (node.labels || []).includes('Step'))
    .map((node) => [node.key, node]));
  const adjacency = new Map();
  for (const edge of edges) {
    const directDataJoinOutcome = directDataJoinOutcomeKeys.has(`${edge.start}\u0000${edge.end}`);
    if (!familyEdgeTypes.has(String(edge.type || '')) && !directDataJoinOutcome) continue;
    const sourceRow = rowByNodeId.get(edge.start);
    if (!sourceRow || sourceRow !== rowByNodeId.get(edge.end)) continue;
    if (!adjacency.has(edge.start)) adjacency.set(edge.start, new Set());
    if (!adjacency.has(edge.end)) adjacency.set(edge.end, new Set());
    adjacency.get(edge.start).add(edge.end);
    adjacency.get(edge.end).add(edge.start);
  }

  let moved = 0;
  for (const row of layout.rows) {
    const stepFact = stepFactById.get(row.key);
    const headStableIds = Array.isArray(stepFact?.props?.headStableIds)
      ? stepFact.props.headStableIds.filter(Boolean)
      : [];
    if (String(stepFact?.props?.syntaxEntryStableId || '').trim()) continue;
    if (headStableIds.length !== 1) continue;
    const headId = headStableIds[0];
    if (!row.nodes.some((node) => node.id === headId)) continue;

    const familyIds = new Set();
    const queue = [headId];
    while (queue.length) {
      const nodeId = queue.shift();
      if (familyIds.has(nodeId)) continue;
      familyIds.add(nodeId);
      for (const neighborId of adjacency.get(nodeId) || []) queue.push(neighborId);
    }
    const familyMembers = row.nodes
      .filter((node) => familyIds.has(node.id))
      .map((node) => ({ node, box: nodeBoxes.get(node.id) }))
      .filter(({ box }) => box);
    const otherMembers = row.nodes
      .filter((node) => !familyIds.has(node.id))
      .map((node) => ({ node, box: nodeBoxes.get(node.id) }))
      .filter(({ box }) => box);
    if (!familyMembers.length || !otherMembers.length) continue;

    const head = familyMembers.find(({ node }) => node.id === headId);
    if (!head) continue;
    const headLeft = visualNodeBounds(head.node, head.box).left;
    const mainLaneLeft = Math.min(...otherMembers.map(({ node, box }) => (
      visualNodeBounds(node, box).left
    )));
    const deltaX = Math.round(mainLaneLeft - headLeft);
    if (deltaX >= -1) continue;
    for (const { box } of familyMembers) box.x += deltaX;
    moved += familyMembers.length;
  }
  return moved;
}

function compactHorizontalStepColumns(layout, positions, nodeBoxes, edges, options = {}) {
  const nodeById = new Map(
    layout.rows.flatMap((row) => row.nodes).map((node) => [node.id, node]),
  );
  const rowByNodeId = layout.rowByNodeId;
  const nonHorizontalTypes = new Set(['NEXT', 'REJOINS', 'REPEATS', 'EXITS']);
  const flowBranchTypes = new Set(['TRUE', 'FALSE', 'OPTION_CASE', 'OPTION_DEFAULT', 'ITERATES']);
  const isHorizontalPredicateNode = (node) => hasLabel(node, 'Branch')
    && hasLabel(node, 'SubStepAttachment')
    && (hasLabel(node, 'Operand') || hasLabel(node, 'PredicateOperator') || hasLabel(node, 'PredicateCall'));
  const adjacency = new Map();
  const edgesBySource = new Map();
  for (const edge of edges) {
    if (!edgesBySource.has(edge.start)) edgesBySource.set(edge.start, []);
    edgesBySource.get(edge.start).push(edge);
    const sourceRow = rowByNodeId.get(edge.start);
    const targetRow = rowByNodeId.get(edge.end);
    const sourcePosition = positions.get(edge.start);
    const targetPosition = positions.get(edge.end);
    if (!sourceRow || sourceRow !== targetRow || !sourcePosition || !targetPosition) continue;
    const sameSubcolumnPredicateEdge = flowBranchTypes.has(edge.type)
      && isHorizontalPredicateNode(nodeById.get(edge.start))
      && isHorizontalPredicateNode(nodeById.get(edge.end));
    if (
      (nodeById.get(edge.start)?.props?.skipHorizontalCompaction
        || nodeById.get(edge.end)?.props?.skipHorizontalCompaction)
      && !sameSubcolumnPredicateEdge
    ) continue;
    if (
      nonHorizontalTypes.has(edge.type)
      || (Math.abs(sourcePosition.x - targetPosition.x) < 0.1 && !sameSubcolumnPredicateEdge)
    ) continue;
    if (!adjacency.has(edge.start)) adjacency.set(edge.start, new Set());
    if (!adjacency.has(edge.end)) adjacency.set(edge.end, new Set());
    adjacency.get(edge.start).add(edge.end);
    adjacency.get(edge.end).add(edge.start);
  }

  const movedNodeIds = new Set();
  for (const node of nodeById.values()) {
    if (!node.props?.compactCallSnippet || !isVisualProxyNode(node)) continue;
    const sourceBox = nodeBoxes.get(node.props?.sourceCallStableId);
    const proxyBox = nodeBoxes.get(node.id);
    if (!sourceBox || !proxyBox) continue;
    const desiredX = sourceBox.x + sourceBox.width + COMPACT_CALL_SNIPPET_GAP;
    if (Math.abs(proxyBox.x - desiredX) < 1) continue;
    proxyBox.x = Math.round(desiredX);
    movedNodeIds.add(node.id);
  }
  const seen = new Set();
  for (const seedId of adjacency.keys()) {
    if (seen.has(seedId)) continue;
    const componentIds = new Set();
    const queue = [seedId];
    while (queue.length) {
      const nodeId = queue.shift();
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);
      componentIds.add(nodeId);
      for (const neighborId of adjacency.get(nodeId) || []) queue.push(neighborId);
    }
    if (componentIds.size < 2) continue;
    const predicateFrame = [...componentIds].some((nodeId) => isHorizontalPredicateNode(nodeById.get(nodeId)));
    if (options.predicateFrames === 'only' && !predicateFrame) continue;
    if (options.predicateFrames === 'exclude' && predicateFrame) continue;
    const componentRows = new Set([...componentIds].map((nodeId) => rowByNodeId.get(nodeId)));
    if (componentRows.size !== 1) continue;
    const row = [...componentRows][0];
    const branchesToAnotherFlowBlock = [...componentIds].some((nodeId) => (
      (edgesBySource.get(nodeId) || []).some((edge) => {
        if (!flowBranchTypes.has(edge.type) || componentIds.has(edge.end)) return false;
        const targetRow = rowByNodeId.get(edge.end);
        if (!targetRow) return false;
        return targetRow.flowBlock?.id !== row.flowBlock?.id;
      })
    ));
    if (branchesToAnotherFlowBlock) continue;

    const columnsByKey = new Map();
    for (const nodeId of componentIds) {
      const node = nodeById.get(nodeId);
      const box = nodeBoxes.get(nodeId);
      const position = positions.get(nodeId);
      if (!node || !box || !position) continue;
      const compactSourcePosition = node.props?.compactCallSnippet
        ? positions.get(node.props?.sourceCallStableId)
        : null;
      const positionKey = Number(compactSourcePosition?.x ?? position.x).toFixed(3);
      const key = predicateFrame && isHorizontalPredicateNode(node)
        ? `${positionKey}:${Number(node.props?.operationIndex ?? Number.MAX_SAFE_INTEGER)}:${node.id}`
        : positionKey;
      if (!columnsByKey.has(key)) columnsByKey.set(key, []);
      columnsByKey.get(key).push({ node, box, position });
    }
    const rawColumns = [...columnsByKey.values()]
      .filter((column) => column.length)
      .sort((left, right) => left[0].position.x - right[0].position.x
        || Number(left[0].node.props?.operationIndex ?? Number.MAX_SAFE_INTEGER)
          - Number(right[0].node.props?.operationIndex ?? Number.MAX_SAFE_INTEGER)
        || left[0].node.id.localeCompare(right[0].node.id));
    const columns = [];
    for (const rawColumn of rawColumns) {
      const previous = columns.at(-1);
      const graphGap = previous
        ? rawColumn[0].position.x - previous[0].position.x
        : Number.POSITIVE_INFINITY;
      const verticallyDisjoint = previous && previous.every(({ box: leftBox }) => {
        return rawColumn.every(({ box: rightBox }) => {
          return leftBox.y + leftBox.height <= rightBox.y
            || rightBox.y + rightBox.height <= leftBox.y;
        });
      });
      if (graphGap <= 0.5001 && verticallyDisjoint) {
        previous.push(...rawColumn);
        previous.mergedLogicalTracks = true;
      }
      else columns.push([...rawColumn]);
    }
    for (const column of columns) {
      if (!column.mergedLogicalTracks) continue;
      const trackCenter = Math.min(...column.map(({ node, box }) => visualFlowAxisX(node, box)));
      for (const { node, box } of column) {
        const center = visualFlowAxisX(node, box);
        box.x = Math.round(box.x + trackCenter - center);
        movedNodeIds.add(node.id);
      }
    }
    if (columns.length < 2) continue;
    const columnIndexByNodeId = new Map();
    columns.forEach((column, columnIndex) => {
      column.forEach(({ node }) => columnIndexByNodeId.set(node.id, columnIndex));
    });

    let previousRight = null;
    const columnResults = [];
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
      const column = columns[columnIndex];
      const beforeBounds = column.map(({ node, box }) => visualHorizontalBounds(node, box));
      const currentLeft = Math.min(...beforeBounds.map((bounds) => bounds.left));
      const requiredGapFromPrevious = columnIndex === 0
        ? 0
        : Math.max(
            HORIZONTAL_STEP_COLUMN_GAP,
            ...edges
              .filter((edge) => slotNameForEdge(edge))
              .filter((edge) => {
                const sourceColumn = columnIndexByNodeId.get(edge.start);
                const targetColumn = columnIndexByNodeId.get(edge.end);
                if (!Number.isInteger(sourceColumn) || !Number.isInteger(targetColumn)) return false;
                const slotColumn = slotNodeEnd(edge) === 'source' ? sourceColumn : targetColumn;
                const otherColumn = slotColumn === sourceColumn ? targetColumn : sourceColumn;
                const slotAdjacentGap = slotColumn > otherColumn
                  ? slotColumn
                  : slotColumn + 1;
                return slotAdjacentGap === columnIndex;
              })
              .map(slotEdgeLabelRequiredGap),
          );
      const desiredLeft = previousRight === null
        ? currentLeft
        : previousRight + requiredGapFromPrevious;
      const deltaX = desiredLeft - currentLeft;
      if (Math.abs(deltaX) >= 1) {
        for (const { node, box } of column) {
          box.x = Math.round(box.x + deltaX);
          movedNodeIds.add(node.id);
        }
      }
      const afterBounds = column.map(({ node, box }) => visualHorizontalBounds(node, box));
      const afterLeft = Math.min(...afterBounds.map((bounds) => bounds.left));
      const afterRight = Math.max(...afterBounds.map((bounds) => bounds.right));
      columnResults.push({
        left: afterLeft,
        right: afterRight,
        requiredGapFromPrevious,
      });
      previousRight = afterRight;
    }
  }

  return {
    moved: movedNodeIds.size,
  };
}

function buildFoldingRows(visibleNodes, positions, nodeBoxes, edges, semanticNodes = []) {
  const rowKeyByNodeId = new Map();
  const graphYByRowKey = new Map();
  const rowParent = new Map();
  const semanticStepByNodeId = new Map();
  const semanticStepOrder = new Map();
  const semanticStepFacts = new Map(semanticNodes
    .filter((node) => (node.labels || []).includes('Step'))
    .map((node) => [node.key, node]));
  for (const node of visibleNodes) {
    const position = positions.get(node.id) || { x: 0, y: 0 };
    const key = foldingRowKey(position);
    rowKeyByNodeId.set(node.id, key);
    graphYByRowKey.set(key, Number(position.y || 0));
    rowParent.set(key, key);
    const stepStableId = String(node.props?.parentStepStableId || '').trim();
    if (stepStableId) {
      if (!semanticStepFacts.has(stepStableId)) {
        throw new Error(`Extracted Step was not found for ${node.id}: ${stepStableId}`);
      }
      semanticStepByNodeId.set(node.id, stepStableId);
      const stepOrder = Number(node.props?.flowStepOrder);
      if (Number.isFinite(stepOrder)) semanticStepOrder.set(stepStableId, stepOrder);
    }
  }
  function findRow(key) {
    const parent = rowParent.get(key);
    if (!parent || parent === key) return key;
    const root = findRow(parent);
    rowParent.set(key, root);
    return root;
  }

  function unionRows(left, right) {
    if (!rowParent.has(left) || !rowParent.has(right)) return;
    const leftRoot = findRow(left);
    const rightRoot = findRow(right);
    if (leftRoot === rightRoot) return;
    const leftY = graphYByRowKey.get(leftRoot) ?? Number.POSITIVE_INFINITY;
    const rightY = graphYByRowKey.get(rightRoot) ?? Number.POSITIVE_INFINITY;
    if (leftY <= rightY) {
      rowParent.set(rightRoot, leftRoot);
    } else {
      rowParent.set(leftRoot, rightRoot);
    }
  }

  for (const node of visibleNodes) {
    const nodeRow = rowKeyByNodeId.get(node.id);
    const foldOwnerRow = rowKeyByNodeId.get(node.props?.foldStepOwnerStableId);
    if (foldOwnerRow) unionRows(nodeRow, foldOwnerRow);
    for (const ownerKey of node.props?.layoutFamilyOwnerKeys || []) {
      const ownerRow = rowKeyByNodeId.get(ownerKey);
      if (ownerRow) unionRows(nodeRow, ownerRow);
    }
  }

  const nodeById = new Map(visibleNodes.map((node) => [node.id, node]));
  const controlEdgeTypes = new Set(['NEXT', 'TRUE', 'FALSE', 'REJOINS']);
  const outgoingBySource = new Map();
  const incomingByTarget = new Map();
  for (const edge of edges) {
    if (!nodeById.has(edge.start) || !nodeById.has(edge.end)) continue;
    if (!outgoingBySource.has(edge.start)) outgoingBySource.set(edge.start, []);
    if (!incomingByTarget.has(edge.end)) incomingByTarget.set(edge.end, []);
    outgoingBySource.get(edge.start).push(edge);
    incomingByTarget.get(edge.end).push(edge);
  }

  const flowJoinNodes = visibleNodes.filter(isFlowJoinNode);
  const detachedTerminalSourceByNodeId = new Map();
  for (const node of visibleNodes.filter((candidate) => candidate.labels.includes('FunctionEnd'))) {
    const sourceEdge = (incomingByTarget.get(node.id) || []).find((edge) => {
      if (edge.type !== 'NEXT') return false;
      const source = nodeById.get(edge.start);
      if (!isFlowJoinNode(source) || source.props?.parentStepStableId) return false;
      return Boolean(String(
        source.props?.flowJoinPlacementSourceStableId
        || source.props?.flowJoinBackboneSourceStableId
        || source.props?.flowJoinEntrySourceStableId
        || '',
      ).trim());
    });
    if (sourceEdge) detachedTerminalSourceByNodeId.set(node.id, sourceEdge.start);
  }

  const groups = new Map();
  for (const node of visibleNodes) {
    if (detachedTerminalSourceByNodeId.has(node.id)) continue;
    const flowJoinSourceId = String(
      node.props?.flowJoinPlacementSourceStableId
      || node.props?.flowJoinBackboneSourceStableId
      || node.props?.flowJoinEntrySourceStableId
      || '',
    ).trim();
    if (
      isFlowJoinNode(node)
      && !node.props?.parentStepStableId
      && flowJoinSourceId
      && nodeById.has(flowJoinSourceId)
      && nodeBoxes.has(flowJoinSourceId)
    ) continue;
    const nodeRow = rowKeyByNodeId.get(node.id);
    const rootKey = semanticStepByNodeId.get(node.id) || `graph:${findRow(nodeRow)}`;
    const semanticOrder = semanticStepOrder.get(rootKey);
    if (!groups.has(rootKey)) {
      groups.set(rootKey, {
        key: rootKey,
        graphY: semanticOrder ?? Number(positions.get(node.id)?.y || 0),
        graphMinY: Number(positions.get(node.id)?.y || 0),
        graphMaxY: Number(positions.get(node.id)?.y || 0),
        nodes: [],
      });
    }
    const group = groups.get(rootKey);
    const graphY = Number(positions.get(node.id)?.y || 0);
    if (!semanticStepOrder.has(rootKey)) {
      group.graphY = Math.min(group.graphY, graphY);
    }
    group.graphMinY = Math.min(group.graphMinY, graphY, Number(node.props?.layoutFamilyMinY ?? graphY));
    group.graphMaxY = Math.max(group.graphMaxY, graphY, Number(node.props?.layoutFamilyMaxY ?? graphY));
    group.nodes.push(node);
  }

  const allBounds = visibleNodes
    .map((node) => {
      const box = nodeBoxes.get(node.id);
      return box ? visualHorizontalBounds(node, box) : undefined;
    })
    .filter(Boolean);
  const minX = Math.min(...allBounds.map((bounds) => bounds.left));
  const maxX = Math.max(...allBounds.map((bounds) => bounds.right));
  const rootX = Math.floor(minX - FOLDING_ROW_HORIZONTAL_PADDING);
  const rootY = 40;
  const width = Math.ceil(maxX - rootX + FOLDING_ROW_HORIZONTAL_PADDING);
  let nextY = 0;
  const rowByNodeId = new Map();
  const groupKeyByNodeId = new Map();
  for (const [groupKey, group] of groups) {
    group.nodes.forEach((node) => groupKeyByNodeId.set(node.id, groupKey));
  }

  const groupDependencies = new Map([...groups.keys()].map((key) => [key, new Set()]));
  const addGroupDependency = (beforeKey, afterKey) => {
    if (!beforeKey || !afterKey || beforeKey === afterKey) return;
    groupDependencies.get(afterKey)?.add(beforeKey);
  };

  // Preserve normal forward control order between extracted Steps.
  for (const edge of edges) {
    if (!controlEdgeTypes.has(edge.type)) continue;
    if (edge.type === 'REJOINS') continue;
    addGroupDependency(groupKeyByNodeId.get(edge.start), groupKeyByNodeId.get(edge.end));
  }

  const unorderedGroups = new Map(groups);
  const orderedGroups = [];
  while (unorderedGroups.size) {
    const ready = [...unorderedGroups.values()]
      .filter((group) => [...(groupDependencies.get(group.key) || [])]
        .every((dependency) => !unorderedGroups.has(dependency)))
      .sort((left, right) => left.graphY - right.graphY);
    if (!ready.length) {
      // Back edges can make the control relation cyclic even though folding
      // rows remain distinct. Break only the ordering cycle at its topmost
      // row; the actual graph edge is still rendered between the rows.
      ready.push([...unorderedGroups.values()]
        .sort((left, right) => left.graphY - right.graphY)[0]);
    }
    const next = ready[0];
    orderedGroups.push(next);
    unorderedGroups.delete(next.key);
  }

  // A back-edge can create an ordering cycle around a closing FlowJoin. The
  // graph contract is still unambiguous: all incoming rows precede the join,
  // and its NEXT continuation follows it. Restore that local order after the
  // generic cycle breaker has produced a complete ordering.
  for (const joinNode of flowJoinNodes) {
    const joinKey = groupKeyByNodeId.get(joinNode.id);
    const continuation = (outgoingBySource.get(joinNode.id) || [])
      .find((edge) => edge.type === 'NEXT');
    const continuationKey = continuation && groupKeyByNodeId.get(continuation.end);
    if (!joinKey || !continuationKey || joinKey === continuationKey) continue;
    let orderByKey = new Map(orderedGroups.map((group, index) => [group.key, index]));
    const joinIndex = orderByKey.get(joinKey);
    const continuationIndex = orderByKey.get(continuationKey);
    if (!Number.isInteger(joinIndex) || !Number.isInteger(continuationIndex) || joinIndex < continuationIndex) continue;
    const incomingKeys = new Set((incomingByTarget.get(joinNode.id) || [])
      .filter((edge) => controlEdgeTypes.has(edge.type))
      .map((edge) => groupKeyByNodeId.get(edge.start))
      .filter((key) => key && key !== joinKey && key !== continuationKey));
    orderedGroups.splice(joinIndex, 1);
    orderByKey = new Map(orderedGroups.map((group, index) => [group.key, index]));
    const targetIndex = orderByKey.get(continuationKey);
    const lastIncomingIndex = Math.max(-1, ...[...incomingKeys]
      .map((key) => orderByKey.get(key))
      .filter(Number.isInteger));
    const insertionIndex = Math.max(lastIncomingIndex + 1, targetIndex);
    orderedGroups.splice(insertionIndex, 0, groups.get(joinKey));
  }

  const rows = orderedGroups
    .map((group, index) => {
      const boxes = group.nodes.map((node) => nodeBoxes.get(node.id));
      const memberIds = new Set(group.nodes.map((node) => node.id));
      const producerReturnRouteYs = edges
        .filter((edge) => (
          memberIds.has(edge.start)
          && memberIds.has(edge.end)
          && ['return-top', 'return-bottom'].includes(
            edge.props?.producerRouteRole || edge.props?.producer_route_role || '',
          )
        ))
        .flatMap((edge) => Array.isArray(edge.props?.explicitPoints)
          ? edge.props.explicitPoints.map((point) => Number(point?.y)).filter(Number.isFinite)
          : []);
      const contentMinY = Math.min(
        ...boxes.map((box) => box.y),
        ...producerReturnRouteYs,
      );
      const contentMaxY = Math.max(
        ...boxes.map((box) => box.y + box.height),
        ...producerReturnRouteYs,
      );
      const height = Math.max(
        FOLDING_ROW_COLLAPSED_HEIGHT,
        Math.ceil(contentMaxY - contentMinY + FOLDING_ROW_TOP_PADDING + FOLDING_ROW_BOTTOM_PADDING) + 2,
      );
      const row = {
        id: `fold-row-${index + 1}`,
        key: group.key,
        graphY: group.graphY,
        nodes: group.nodes,
        x: 0,
        y: nextY,
        width,
        height,
        contentMinY,
      };
      nextY += height + FOLDING_ROW_GAP;
      group.nodes.forEach((node) => rowByNodeId.set(node.id, row));
      return row;
    });

  const layout = {
    id: 'fold-layout-root',
    x: rootX,
    y: rootY,
    width,
    height: Math.max(0, nextY - FOLDING_ROW_GAP),
    rows,
    rowByNodeId,
  };
  const flowBlockLayout = buildRendererFlowBlocks(
    visibleNodes,
    positions,
    nodeBoxes,
    edges,
    rows,
    rowByNodeId,
    layout,
    semanticNodes,
  );
  const detachedFlowJoinByNodeId = new Map();
  const flowBlockByStableId = new Map(flowBlockLayout.blocks.map((block) => [block.graphFact?.key, block]));
  const pendingDetachedJoins = [...flowJoinNodes];
  while (pendingDetachedJoins.length) {
    let progress = false;
    for (let index = pendingDetachedJoins.length - 1; index >= 0; index -= 1) {
      const joinNode = pendingDetachedJoins[index];
      if (joinNode.props?.parentStepStableId) {
        pendingDetachedJoins.splice(index, 1);
        continue;
      }
      const sourceId = String(
        joinNode.props?.flowJoinPlacementSourceStableId
        || joinNode.props?.flowJoinBackboneSourceStableId
        || joinNode.props?.flowJoinEntrySourceStableId
        || '',
      ).trim();
      if (!sourceId) {
        pendingDetachedJoins.splice(index, 1);
        continue;
      }
      const sourceRow = rowByNodeId.get(sourceId);
      const sourceDetached = detachedFlowJoinByNodeId.get(sourceId);
      const sourceBox = nodeBoxes.get(sourceId);
      const joinBox = nodeBoxes.get(joinNode.id);
      if ((!sourceRow && !sourceDetached) || !sourceBox || !joinBox) continue;
      const declaredOwnerStableId = parentFlowBlockStableIdForNode(joinNode);
      const owner = declaredOwnerStableId
        ? flowBlockByStableId.get(declaredOwnerStableId) || sourceDetached?.owner || sourceRow?.flowBlock || null
        : null;
      const sourceGlobalX = sourceDetached?.globalX ?? sourceBox.x;
      const sourceGlobalY = sourceDetached?.globalY ?? (
        sourceRow.y
        + FOLDING_ROW_TOP_PADDING
        + sourceBox.y
        - sourceRow.contentMinY
      );
      const incomingSourceBoxes = edges
        .filter((edge) => edge.end === joinNode.id)
        .map((edge) => {
          const detached = detachedFlowJoinByNodeId.get(edge.start);
          const box = nodeBoxes.get(edge.start);
          if (!box) return undefined;
          return {
            x: detached?.globalX ?? box.x,
            width: detached?.width ?? box.width,
          };
        })
        .filter(Boolean);
      const backboneSourceId = String(joinNode.props?.flowJoinBackboneSourceStableId || '').trim();
      const backboneDetached = backboneSourceId ? detachedFlowJoinByNodeId.get(backboneSourceId) : undefined;
      const backboneBox = backboneSourceId ? nodeBoxes.get(backboneSourceId) : undefined;
      const backboneNode = backboneSourceId ? nodeById.get(backboneSourceId) : undefined;
      if (isFlowJoinNode(backboneNode) && !backboneNode.props?.parentStepStableId && !backboneDetached) continue;
      const cascadesFromDetachedJoin = Boolean(
        sourceDetached
        && isFlowJoinNode(nodeById.get(sourceId))
        && !nodeById.get(sourceId)?.props?.parentStepStableId,
      );
      const seniorAxisCenterX = backboneBox
        ? (backboneDetached?.globalX ?? backboneBox.x) + (backboneDetached?.width ?? backboneBox.width) / 2
        : incomingSourceBoxes.length
          ? Math.min(...incomingSourceBoxes.map((box) => box.x + box.width / 2))
          : sourceGlobalX + sourceBox.width / 2;
      detachedFlowJoinByNodeId.set(joinNode.id, {
        owner,
        sourceId,
        globalX: seniorAxisCenterX - joinBox.width / 2,
        globalY: cascadesFromDetachedJoin
          ? sourceGlobalY + sourceBox.height + FOLDING_ROW_GAP
          : sourceGlobalY + (sourceBox.height - joinBox.height) / 2,
        width: joinBox.width,
        height: joinBox.height,
      });
      pendingDetachedJoins.splice(index, 1);
      progress = true;
    }
    if (!progress) break;
  }
  for (const [terminalId, sourceId] of detachedTerminalSourceByNodeId) {
    const source = detachedFlowJoinByNodeId.get(sourceId);
    const terminalBox = nodeBoxes.get(terminalId);
    if (!source || !terminalBox) continue;
    detachedFlowJoinByNodeId.set(terminalId, {
      owner: source.owner,
      sourceId,
      globalX: source.globalX + (source.width - terminalBox.width) / 2,
      globalY: source.globalY + source.height + FOLDING_ROW_GAP,
      width: terminalBox.width,
      height: terminalBox.height,
    });
  }
  return { ...layout, ...flowBlockLayout, detachedFlowJoinByNodeId };
}

function foldingPortStyle() {
  return 'ellipse;html=1;aspect=fixed;foldBoundaryPort=1;perimeter=none;opacity=0;fillColor=none;strokeColor=none;resizable=0;movable=0;';
}

function foldingExternalEdgeStyle(edge, sourceRatio, targetRatio, downward) {
  const boundaryEdge = {
    ...edge,
    props: {
      ...edge.props,
      sourcePort: null,
      targetPort: null,
    },
  };
  return `${styleForEdge(boundaryEdge)}startArrow=none;endArrow=none;exitX=${sourceRatio};exitY=${downward ? 1 : 0};exitPerimeter=1;entryX=${targetRatio};entryY=${downward ? 0 : 1};entryPerimeter=1;`;
}

function flowLayerForGraphItem(item, fallback = 'control') {
  const value = String(item?.props?.flow_layer || item?.props?.flowLayer || fallback).trim();
  return ['control', 'data', 'mixed'].includes(value) ? value : fallback;
}

function ownerStepStableIdForGraphItem(item) {
  return String(
    item?.props?.owner_step_stable_id
    || item?.props?.ownerStepStableId
    || item?.props?.parentStepStableId
    || '',
  ).trim();
}

function stepVisibilityForGraphItem(item) {
  const value = String(
    item?.props?.step_visibility
    || item?.props?.stepVisibility
    || '',
  ).trim();
  if (['core', 'detail'].includes(value)) return value;
  return flowLayerForGraphItem(item, 'control') === 'data' ? 'detail' : 'core';
}

function classifyStepVisibility(nodes, edges) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const detailNodeIds = new Set(
    nodes
      .filter((node) => flowLayerForGraphItem(node, 'control') === 'data')
      .map((node) => node.id),
  );
  const expansionTypes = new Set(['ARG', 'FIELD', 'VALUE']);
  const propagationStops = new Set(['NEXT', 'REJOINS', 'REPEATS', 'EXITS', 'RESULT']);

  const isValueEvaluation = (edge) => {
    if (edge.type !== 'EVAL') return false;
    const source = nodeById.get(edge.start);
    if (!source) return false;
    if (source.labels.includes('Flow') || source.labels.includes('Eval')) return false;
    return source.labels.some((label) => [
      'Value', 'ValueSlot', 'ComputedValue', 'Const', 'Parameter', 'Arg', 'Field',
    ].includes(label))
      || flowLayerForGraphItem(source, 'control') !== 'control';
  };

  for (const edge of edges) {
    if (!expansionTypes.has(edge.type) && !isValueEvaluation(edge)) continue;
    const sourceOwner = ownerStepStableIdForGraphItem(nodeById.get(edge.start) || edge);
    const targetOwner = ownerStepStableIdForGraphItem(nodeById.get(edge.end) || edge);
    if (sourceOwner && sourceOwner === targetOwner) detailNodeIds.add(edge.end);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (!detailNodeIds.has(edge.start) || detailNodeIds.has(edge.end)) continue;
      if (propagationStops.has(edge.type)) continue;
      const source = nodeById.get(edge.start);
      const target = nodeById.get(edge.end);
      if (!source || !target) continue;
      const sourceOwner = ownerStepStableIdForGraphItem(source);
      const targetOwner = ownerStepStableIdForGraphItem(target);
      if (!sourceOwner || sourceOwner !== targetOwner) continue;
      detailNodeIds.add(edge.end);
      changed = true;
    }
  }

  for (const node of nodes) {
    node.props ||= {};
    node.props.stepVisibility = detailNodeIds.has(node.id) ? 'detail' : 'core';
  }
  for (const edge of edges) {
    edge.props ||= {};
    const endpointIsDetail = detailNodeIds.has(edge.start) || detailNodeIds.has(edge.end);
    if (!ownerStepStableIdForGraphItem(edge)) {
      const sourceOwner = ownerStepStableIdForGraphItem(nodeById.get(edge.start));
      const targetOwner = ownerStepStableIdForGraphItem(nodeById.get(edge.end));
      if (sourceOwner && sourceOwner === targetOwner) {
        edge.props.ownerStepStableId = sourceOwner;
      }
    }
    edge.props.stepVisibility = (
      flowLayerForGraphItem(edge, 'control') === 'data'
      || endpointIsDetail
    ) ? 'detail' : 'core';
  }
}

function expressionMosaicClosureEdge(members, edges) {
  const terminalIds = [...members]
    .sort((left, right) => expressionMosaicOrder(right) - expressionMosaicOrder(left))
    .map((node) => node.id);
  for (const terminalId of terminalIds) {
    const edge = edges.find((candidate) => candidate.start === terminalId && candidate.type === 'ArgJoin');
    if (edge) return edge;
  }
  return undefined;
}

function rerouteLateralExpressionMosaicEdges(nodes, edges) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return edges.map((edge) => {
    const source = nodeById.get(edge.start);
    const sourcePort = String(edge.props?.sourcePort || edge.props?.source_port || '');
    const side = sourcePort.startsWith('right') ? 'right' : sourcePort.startsWith('left') ? 'left' : '';
    if (
      !side
      || !source
      || !hasLabel(source, 'Branch')
      || expressionMosaicRole(source) !== 'operator'
    ) return edge;
    const members = nodes
      .filter((node) => (
        (node.props?.expressionMosaicOwnerStableId || node.props?.expression_mosaic_owner_stable_id) === source.id
      ))
      .sort((left, right) => expressionMosaicOrder(left) - expressionMosaicOrder(right));
    const visualSource = side === 'right' ? members.at(-1) : members[0];
    if (!visualSource || visualSource.id === edge.start) return edge;
    return {
      ...edge,
      start: visualSource.id,
      props: {
        ...(edge.props || {}),
        stableId: edge.props?.stableId || edge.start,
        layoutSemanticSourceStableId: edge.start,
        layoutRouteReason: `lateral ${edge.type} exits from the ${side} edge of expression mosaic ${edge.start}`,
      },
    };
  });
}

function nestedArithmeticMosaicCheck(nodes, edges, nodeBoxes) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const findings = [];
  const operators = nodes.filter((node) => expressionMosaicLayout(node) === 'nested-right-down');
  for (const operator of operators) {
    const parentId = expressionMosaicParentStableId(operator);
    const parent = nodeById.get(parentId);
    const parentBox = nodeBoxes.get(parentId);
    const members = nodes
      .filter((node) => (
        (node.props?.expressionMosaicOwnerStableId || node.props?.expression_mosaic_owner_stable_id) === operator.id
      ))
      .sort((left, right) => expressionMosaicOrder(left) - expressionMosaicOrder(right));
    const memberBoxes = members.map((node) => nodeBoxes.get(node.id)).filter(Boolean);
    if (!parent || !parentBox || members.length !== 2 || memberBoxes.length !== 2) {
      findings.push({ stableId: operator.id, issue: 'nested arithmetic family is incomplete' });
      continue;
    }
    const familyLeft = Math.min(...memberBoxes.map((box) => box.x));
    const familyTop = Math.min(...memberBoxes.map((box) => box.y));
    const familyRight = Math.max(...memberBoxes.map((box) => box.x + box.width));
    const familyBottom = Math.max(...memberBoxes.map((box) => box.y + box.height));
    if (familyLeft <= parentBox.x + parentBox.width || familyTop <= parentBox.y + parentBox.height) {
      findings.push({ stableId: operator.id, issue: 'nested arithmetic family is not right and below its parent operator' });
    }
    const entryEdge = edges.find((edge) => edge.start === parent.id && edge.end === operator.id && edge.type === 'NEXT');
    if (!entryEdge) findings.push({ stableId: operator.id, issue: 'parent operator has no visible data transfer into nested arithmetic family' });
    const closureEdge = expressionMosaicClosureEdge(members, edges);
    const terminalMember = members.at(-1);
    if (closureEdge && closureEdge.start !== terminalMember?.id) {
      findings.push({ stableId: operator.id, issue: 'call closure does not start at the terminal arithmetic member' });
    }
    const closureBox = nodeBoxes.get(closureEdge?.end);
    if (!closureBox) {
      findings.push({ stableId: operator.id, issue: 'nested arithmetic family has no rendered call closure' });
    } else if (closureBox.x <= familyRight || closureBox.y !== parentBox.y) {
      findings.push({ stableId: operator.id, issue: 'call closure is not right of the nested family and aligned with its parent operator' });
    }
    if (closureEdge && !edges.some((edge) => edge.start === closureEdge.end && edge.type === 'FieldJoin')) {
      findings.push({ stableId: operator.id, issue: 'call closure does not rejoin its enclosing object field family' });
    }
    const expressionEndLine = Number(operator.props?.end_line ?? operator.props?.endLine);
    const ownerStepStableId = ownerStepStableIdForGraphItem(operator);
    const familyIds = new Set([...members.map((node) => node.id), parent.id, closureEdge?.end].filter(Boolean));
    const overlappingLowerSibling = nodes.find((node) => {
      if (familyIds.has(node.id) || ownerStepStableIdForGraphItem(node) !== ownerStepStableId) return false;
      const siblingStartLine = Number(node.props?.start_line ?? node.props?.startLine);
      if (!Number.isFinite(siblingStartLine) || siblingStartLine <= expressionEndLine) return false;
      const box = nodeBoxes.get(node.id);
      return box && box.y < familyBottom + 26;
    });
    if (overlappingLowerSibling) {
      findings.push({ stableId: operator.id, issue: `lower sibling overlaps nested arithmetic footprint: ${overlappingLowerSibling.id}` });
    }
  }
  return {
    id: 'nested-arithmetic-mosaic',
    description: `Nested arithmetic arguments reserve their full footprint and return to the call closure (${operators.length} checked).`,
    status: findings.length ? 'fail' : 'pass',
    findingCount: findings.length,
    findings,
  };
}

function alignPredicateCallMosaics(nodes, nodeBoxes, edges = []) {
  const roleFor = (node) => node?.props?.callMosaicRole || node?.props?.call_mosaic_role || '';
  const ownerFor = (node) => node?.props?.callMosaicOwnerStableId || node?.props?.call_mosaic_owner_stable_id || '';
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const outgoingBySource = new Map();
  for (const edge of edges) {
    outgoingBySource.set(edge.start, [...(outgoingBySource.get(edge.start) || []), edge]);
  }
  const nestedFamilyEdgeTypes = new Set([
    'ARG', 'FIELD', 'EVAL', 'ArgJoin', 'FieldJoin', 'ARG_JOIN', 'FIELD_JOIN',
    'MATERIALIZES_ARGUMENT', 'MATERIALIZES_FIELD',
  ]);
  let moved = 0;
  for (const opening of nodes.filter((node) => roleFor(node) === 'open' && ownerFor(node) === node.id)) {
    const openingBox = nodeBoxes.get(opening.id);
    if (!openingBox) continue;
    const openingMethodBox = structuredContainerOverlayPartBox(opening, openingBox, 'method');
    const mosaicY = openingMethodBox?.y ?? openingBox.y;
    const members = nodes.filter((node) => ownerFor(node) === opening.id && node.id !== opening.id);
    for (const member of members) {
      const box = nodeBoxes.get(member.id);
      if (!box || box.y === mosaicY) continue;
      box.y = mosaicY;
      moved += 1;
    }
    const argumentsInMosaic = members.filter((node) => roleFor(node) === 'argument');
    const argument = argumentsInMosaic[0];
    const argumentClosing = members.find((node) => roleFor(node) === 'argument-close');
    const closing = members.find((node) => roleFor(node) === 'close');
    const isSingleExpandedArgumentMosaic = argumentsInMosaic.length === 1
      && argumentClosing
      && closing;
    if (opening.props?.compactCallMosaic === true || isSingleExpandedArgumentMosaic) {
      const argumentBox = argument && nodeBoxes.get(argument.id);
      const argumentClosingBox = argumentClosing && nodeBoxes.get(argumentClosing.id);
      const closingBox = closing && nodeBoxes.get(closing.id);
      if (argumentBox && closingBox) {
        const desiredArgumentX = openingBox.x + openingBox.width;
        const argumentDeltaX = desiredArgumentX - argumentBox.x;
        if (argumentDeltaX) {
          const stopIds = new Set([argumentClosing?.id, closing?.id].filter(Boolean));
          const familyIds = new Set();
          const queue = [argument.id];
          while (queue.length) {
            const currentId = queue.shift();
            if (!currentId || stopIds.has(currentId) || familyIds.has(currentId)) continue;
            const current = nodeById.get(currentId);
            if (!current) continue;
            familyIds.add(currentId);
            for (const edge of outgoingBySource.get(currentId) || []) {
              if (nestedFamilyEdgeTypes.has(edge.type)) queue.push(edge.end);
            }
          }
          for (const familyId of familyIds) {
            const familyBox = nodeBoxes.get(familyId);
            if (familyBox) familyBox.x += argumentDeltaX;
          }
        }
        argumentBox.x = desiredArgumentX;
        argumentBox.y = mosaicY;
        if (argumentClosingBox) {
          const objectFamilyRight = nodes
            .filter((candidate) => (
              (candidate.props?.objectBraceSide || candidate.props?.object_brace_side) === 'left'
              && (candidate.props?.objectBraceMosaicNeighborStableId
                || candidate.props?.object_brace_mosaic_neighbor_stable_id) === argument.id
            ))
            .flatMap((objectOpening) => {
              const familyId = objectOpening.props?.objectFamilyStableId
                || objectOpening.props?.object_family_stable_id
                || objectOpening.id;
              return nodes.filter((candidate) => (
                (candidate.props?.objectFamilyStableId || candidate.props?.object_family_stable_id) === familyId
              ));
            })
            .map((candidate) => {
              const candidateBox = nodeBoxes.get(candidate.id);
              return candidateBox ? visualNodeBounds(candidate, candidateBox).right : undefined;
            })
            .filter(Number.isFinite)
            .reduce((right, candidate) => Math.max(right, candidate), Number.NEGATIVE_INFINITY);
          const nestedTailRight = edges
            .filter((edge) => (
              (edge.type === 'ArgJoin' || edge.type === 'FieldJoin')
              && edge.end === argumentClosing.id
            ))
            .map((edge) => nodeBoxes.get(edge.start))
            .filter(Boolean)
            .reduce(
              (right, box) => Math.max(right, box.x + box.width),
              Math.max(
                argumentBox.x + argumentBox.width,
                Number.isFinite(objectFamilyRight) ? objectFamilyRight : Number.NEGATIVE_INFINITY,
              ),
            );
          argumentClosingBox.x = nestedTailRight;
          argumentClosingBox.y = mosaicY;
        }
        closingBox.x = argumentClosingBox
          ? argumentClosingBox.x + argumentClosingBox.width
          : argumentBox.x + argumentBox.width;
        closingBox.y = mosaicY;
      }
    }
  }
  return moved;
}

function alignPredicateExpressionMosaics(nodes, nodeBoxes) {
  const roleFor = (node) => node?.props?.expressionMosaicRole || node?.props?.expression_mosaic_role || '';
  const ownerFor = (node) => node?.props?.expressionMosaicOwnerStableId || node?.props?.expression_mosaic_owner_stable_id || '';
  let moved = 0;
  for (const operator of nodes.filter((node) => roleFor(node) === 'operator' && ownerFor(node) === node.id)) {
    const operatorBox = nodeBoxes.get(operator.id);
    if (!operatorBox) continue;
    const backing = nodes.find((node) => (
      ownerFor(node) === operator.id && expressionMosaicPartKind(node) === 'receiver'
    ));
    const members = nodes
      .filter((node) => ownerFor(node) === operator.id && expressionMosaicPartKind(node) !== 'receiver')
      .sort((left, right) => expressionMosaicOrder(left) - expressionMosaicOrder(right));
    const operatorIndex = members.findIndex((member) => member.id === operator.id);
    const centerY = operatorBox.y + operatorBox.height / 2;
    let cursor = operatorBox.x;
    for (let index = operatorIndex - 1; index >= 0; index -= 1) {
      const box = nodeBoxes.get(members[index].id);
      if (!box) continue;
      cursor -= box.width;
      const nextY = Math.round(centerY - box.height / 2);
      if (box.x !== cursor || box.y !== nextY) moved += 1;
      box.x = cursor;
      box.y = nextY;
    }
    cursor = operatorBox.x + operatorBox.width;
    for (let index = operatorIndex + 1; index < members.length; index += 1) {
      const box = nodeBoxes.get(members[index].id);
      if (!box) continue;
      const nextY = Math.round(centerY - box.height / 2);
      if (box.x !== cursor || box.y !== nextY) moved += 1;
      box.x = cursor;
      box.y = nextY;
      cursor += box.width;
    }
    const backingBox = backing && nodeBoxes.get(backing.id);
    if (backingBox) {
      const memberBoxes = members.map((member) => nodeBoxes.get(member.id)).filter(Boolean);
      const left = Math.min(...memberBoxes.map((box) => box.x));
      const right = Math.max(...memberBoxes.map((box) => box.x + box.width));
      const nextX = Math.round((left + right - backingBox.width) / 2);
      const nextY = Math.round(operatorBox.y - backingBox.height - 12);
      if (backingBox.x !== nextX || backingBox.y !== nextY) moved += 1;
      backingBox.x = nextX;
      backingBox.y = nextY;
    }
  }
  return moved;
}

function alignNestedArithmeticMosaics(nodes, edges, nodeBoxes) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  let moved = 0;
  for (const operator of nodes.filter((node) => (
    expressionMosaicLayout(node) === 'nested-right-down'
    && expressionMosaicParentStableId(node)
  ))) {
    const parent = nodeById.get(expressionMosaicParentStableId(operator));
    const parentBox = nodeBoxes.get(parent?.id);
    if (!parent || !parentBox) continue;
    const parentMembers = nodes
      .filter((node) => (
        (node.props?.expressionMosaicOwnerStableId || node.props?.expression_mosaic_owner_stable_id) === parent.id
      ))
      .sort((left, right) => expressionMosaicOrder(left) - expressionMosaicOrder(right));
    const firstParentMember = parentMembers[0];
    const openingEdge = edges.find((edge) => edge.type === 'ARG' && edge.end === firstParentMember?.id);
    const opening = nodeById.get(openingEdge?.start);
    const openingBox = nodeBoxes.get(opening?.id);
    const firstParentBox = nodeBoxes.get(firstParentMember?.id);
    if (openingBox && firstParentBox) {
      const parentDeltaX = openingBox.x + openingBox.width + 57 - firstParentBox.x;
      const parentDeltaY = openingBox.y - firstParentBox.y;
      for (const member of parentMembers) {
        const box = nodeBoxes.get(member.id);
        if (!box) continue;
        box.x += parentDeltaX;
        box.y += parentDeltaY;
      }
      if (parentDeltaX || parentDeltaY) moved += parentMembers.length;
    }
    const members = nodes
      .filter((node) => (
        (node.props?.expressionMosaicOwnerStableId || node.props?.expression_mosaic_owner_stable_id) === operator.id
      ))
      .sort((left, right) => expressionMosaicOrder(left) - expressionMosaicOrder(right));
    const memberBoxes = members.map((node) => nodeBoxes.get(node.id)).filter(Boolean);
    if (!memberBoxes.length) continue;
    const currentLeft = Math.min(...memberBoxes.map((box) => box.x));
    const currentTop = Math.min(...memberBoxes.map((box) => box.y));
    const deltaX = parentBox.x + parentBox.width + 70 - currentLeft;
    const deltaY = parentBox.y + parentBox.height + 38 - currentTop;
    for (const box of memberBoxes) {
      box.x += deltaX;
      box.y += deltaY;
    }
    if (deltaX || deltaY) moved += members.length;

    const familyRight = Math.max(...memberBoxes.map((box) => box.x + box.width));
    const familyBottom = Math.max(...memberBoxes.map((box) => box.y + box.height));
    const closureEdge = expressionMosaicClosureEdge(members, edges);
    const closure = nodeById.get(closureEdge?.end);
    const closureBox = nodeBoxes.get(closureEdge?.end);
    if (closureBox) {
      const closureX = familyRight + 56;
      if (closureBox.x !== closureX || closureBox.y !== parentBox.y) moved += 1;
      closureBox.x = closureX;
      closureBox.y = parentBox.y;
      if (closure && opening) {
        closure.props.displayY = opening.props?.displayY;
        closure.props.display_y = opening.props?.display_y;
      }
    }

    const ownerStepStableId = ownerStepStableIdForGraphItem(operator);
    const expressionEndLine = Number(operator.props?.end_line ?? operator.props?.endLine);
    const familyIds = new Set([
      ...members.map((node) => node.id),
      ...parentMembers.map((node) => node.id),
      parent.id,
      opening?.id,
      closureEdge?.end,
    ].filter(Boolean));
    const lowerSiblings = nodes
      .filter((node) => (
        !familyIds.has(node.id)
        && ownerStepStableIdForGraphItem(node) === ownerStepStableId
        && Number(node.props?.start_line ?? node.props?.startLine) > expressionEndLine
      ))
      .map((node) => nodeBoxes.get(node.id))
      .filter(Boolean);
    if (lowerSiblings.length) {
      const lowerTop = Math.min(...lowerSiblings.map((box) => box.y));
      const siblingDeltaY = Math.max(0, familyBottom + 26 - lowerTop);
      if (siblingDeltaY) {
        lowerSiblings.forEach((box) => { box.y += siblingDeltaY; });
        moved += lowerSiblings.length;
      }
    }
  }
  return moved;
}

function alignMethodChainMosaics(nodes, nodeBoxes) {
  let moved = 0;
  const closureBySourceCallStableId = new Map(nodes
    .filter((node) => (
      String(node.props?.sourceCallStableId || node.props?.source_call_stable_id || '').trim()
      && String(node.props?.diaName || node.props?.dia_name || node.props?.label || '').trim() === ')'
    ))
    .map((node) => [
      String(node.props?.sourceCallStableId || node.props?.source_call_stable_id || '').trim(),
      node,
    ]));
  const expressionOwnerFor = (node) => (
    node?.props?.expressionMosaicOwnerStableId
    || node?.props?.expression_mosaic_owner_stable_id
    || ''
  );
  const horizontalOwners = new Set(nodes
    .filter((node) => expressionMosaicLayout(node) === 'method-chain-horizontal')
    .map(expressionOwnerFor)
    .filter(Boolean));
  for (const ownerId of horizontalOwners) {
    const members = nodes
      .filter((node) => expressionOwnerFor(node) === ownerId)
      .sort((left, right) => expressionMosaicOrder(left) - expressionMosaicOrder(right));
    const boxes = members.map((node) => nodeBoxes.get(node.id));
    if (!boxes.length || boxes.some((box) => !box)) continue;
    let x = Math.min(...boxes.map((box) => box.x));
    const y = boxes[0].y;
    for (const box of boxes) {
      if (box.x !== x || box.y !== y) moved += 1;
      box.x = x;
      box.y = y;
      x += box.width + 2;
    }
  }
  for (const method of nodes.filter((node) => methodChainRole(node) === 'continuation')) {
    const ownerStableId = methodChainOwnerStableId(method);
    const closure = closureBySourceCallStableId.get(ownerStableId);
    const ownerBox = nodeBoxes.get(closure?.id || ownerStableId);
    const methodBox = nodeBoxes.get(method.id);
    if (!ownerBox || !methodBox) continue;
    const x = ownerBox.x + ownerBox.width;
    const y = ownerBox.y;
    if (methodBox.x !== x || methodBox.y !== y || methodBox.height !== ownerBox.height) moved += 1;
    methodBox.x = x;
    methodBox.y = y;
    methodBox.height = ownerBox.height;
  }
  return moved;
}

function alignContainerProducerMosaics(nodes, edges, nodeBoxes) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  let moved = 0;
  for (const assignment of nodes.filter((node) => node.props?.hybridVisualRole === 'assignment')) {
    const targetId = assignment.props?.hybridOverlayOwnerStableId
      || assignment.props?.hybrid_overlay_owner_stable_id;
    const targetBox = nodeBoxes.get(targetId);
    if (!targetBox) continue;
    const producerIds = new Set();
    for (const edge of edges) {
      if (edge.type === 'ASSIGNS_VALUE' && edge.end === assignment.id) producerIds.add(edge.start);
      if (edge.type === 'EVAL' && edge.start === targetId) producerIds.add(edge.end);
    }
    const ownerIds = new Set([...producerIds]
      .map((id) => nodeById.get(id))
      .map((node) => node?.props?.expressionMosaicOwnerStableId || node?.props?.expression_mosaic_owner_stable_id)
      .filter(Boolean));
    if (ownerIds.size !== 1) continue;
    const [ownerId] = ownerIds;
    const members = nodes.filter((node) => (
      (node.props?.expressionMosaicOwnerStableId || node.props?.expression_mosaic_owner_stable_id) === ownerId
      && expressionMosaicPartKind(node) !== 'receiver'
    ));
    const boxes = members.map((member) => nodeBoxes.get(member.id)).filter(Boolean);
    if (!boxes.length) continue;
    const left = Math.min(...boxes.map((box) => box.x));
    const top = Math.min(...boxes.map((box) => box.y));
    const bottom = Math.max(...boxes.map((box) => box.y + box.height));
    const deltaX = targetBox.x + targetBox.width + 36 - left;
    const deltaY = Math.round(targetBox.y + targetBox.height / 2 - (top + bottom) / 2);
    if (!deltaX && !deltaY) continue;
    for (const box of boxes) {
      box.x += deltaX;
      box.y += deltaY;
    }
    moved += boxes.length;
  }
  return moved;
}

function alignDataBranchResultTargetsToFalseGrade(nodes, edges, nodeBoxes) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  let moved = 0;
  for (const target of nodes.filter((node) => hasLabel(node, 'ResultTarget'))) {
    const targetBox = nodeBoxes.get(target.id);
    if (!targetBox) continue;
    const branchEdge = edges.find((edge) => (
      edge.end === target.id
      && edge.type === 'FALSE'
      && isSlotBranchNode(nodeById.get(edge.start))
    ));
    const branchBox = nodeBoxes.get(branchEdge?.start);
    const targetContainerBox = structuredContainerOverlayPartBox(target, targetBox, 'container');
    if (!branchBox || !targetContainerBox) continue;
    const expectedContainerY = branchBox.y + DATA_BRANCH_RESULT_GRADE_GAP;
    const deltaY = Math.round(expectedContainerY - targetContainerBox.y);
    if (!deltaY) continue;
    targetBox.y += deltaY;
    moved += 1;
  }
  return moved;
}

function alignCallClosuresToOpenings(
  nodes,
  nodeBoxes,
  edges = [],
  closingJoinGap = HORIZONTAL_FAMILY_BOUNDARY_GAP,
) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const incomingByTarget = new Map();
  for (const edge of edges) {
    incomingByTarget.set(edge.end, [...(incomingByTarget.get(edge.end) || []), edge]);
  }
  const familyJoinTypes = new Set(['ArgJoin', 'FieldJoin', 'ARG_JOIN', 'FIELD_JOIN']);
  let moved = 0;
  const closures = nodes.filter((closure) => {
    const sourceCallStableId = String(
      closure.props?.sourceCallStableId || closure.props?.source_call_stable_id || '',
    ).trim();
    const label = String(closure.props?.diaName || closure.props?.dia_name || closure.props?.label || '').trim();
    return Boolean(sourceCallStableId && label === ')');
  });
  // Nested call closures can themselves be the final member of an outer call.
  // Iterate to propagate the right edge from the innermost family outwards.
  for (let pass = 0; pass < Math.max(1, closures.length); pass += 1) {
    let passMoved = 0;
    for (const closure of closures) {
      const sourceCallStableId = String(
        closure.props?.sourceCallStableId || closure.props?.source_call_stable_id || '',
      ).trim();
      const openingBox = nodeBoxes.get(sourceCallStableId);
      const closureBox = nodeBoxes.get(closure.id);
      const opening = nodeById.get(sourceCallStableId);
      const openingBoundaryBox = structuredContainerOverlayPartBox(opening, openingBox, 'method') || openingBox;
      if (!openingBoundaryBox || !closureBox) continue;
      const alignedY = Math.round(
        openingBoundaryBox.y + (openingBoundaryBox.height - closureBox.height) / 2,
      );
      const familyRight = (incomingByTarget.get(closure.id) || [])
        .filter((edge) => familyJoinTypes.has(edge.type))
        .map((edge) => {
          const source = nodeById.get(edge.start);
          const sourceBox = nodeBoxes.get(edge.start);
          return source && sourceBox ? visualNodeBounds(source, sourceBox).right : undefined;
        })
        .filter(Number.isFinite)
        .reduce((right, candidate) => Math.max(right, candidate), Number.NEGATIVE_INFINITY);
      const mountedToObjectBrace = nodes.some((node) => (
        isObjectBraceNode(node)
        && (node.props?.objectBraceSide || node.props?.object_brace_side) === 'right'
        && (
          node.props?.objectBraceMosaicNeighborStableId
          || node.props?.object_brace_mosaic_neighbor_stable_id
        ) === closure.id
      ));
      const alignedX = Number.isFinite(familyRight)
        ? Math.round(familyRight + (mountedToObjectBrace ? 0 : closingJoinGap))
        : closureBox.x;
      if (closureBox.x === alignedX && closureBox.y === alignedY) continue;
      closureBox.x = alignedX;
      closureBox.y = alignedY;
      passMoved += 1;
      moved += 1;
    }
    if (!passMoved) break;
  }
  return moved;
}

function submethodStableIdForLayout(node) {
  return String(node?.props?.submethodStableId || node?.props?.submethod_stable_id || '');
}

function parentSubmethodStableIdForLayout(node) {
  return String(node?.props?.parentSubmethodStableId || node?.props?.parent_submethod_stable_id || '');
}

function memberSubmethodStableIdForLayout(node) {
  return String(node?.props?.memberOfSubmethodStableId || node?.props?.member_of_submethod_stable_id || '');
}

function submethodRelativeRowForLayout(node) {
  const row = Number(node?.props?.submethodRelativeRow ?? node?.props?.submethod_relative_row);
  return Number.isFinite(row) ? row : Number.POSITIVE_INFINITY;
}

function alignNestedSubmethodRows(nodes, edges, nodeBoxes) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const headers = nodes.filter((node) => submethodStableIdForLayout(node) === node.id);
  const headerById = new Map(headers.map((node) => [node.id, node]));
  const childHeadersByParent = new Map();
  const membersByHeader = new Map();
  for (const header of headers) {
    const parentId = parentSubmethodStableIdForLayout(header);
    if (parentId) childHeadersByParent.set(parentId, [...(childHeadersByParent.get(parentId) || []), header.id]);
  }
  for (const node of nodes) {
    const ownerId = memberSubmethodStableIdForLayout(node);
    if (ownerId) membersByHeader.set(ownerId, [...(membersByHeader.get(ownerId) || []), node.id]);
  }
  const depthOf = (headerId) => {
    let depth = 0;
    let current = headerById.get(headerId);
    const seen = new Set();
    while (current) {
      const parentId = parentSubmethodStableIdForLayout(current);
      if (!parentId || seen.has(parentId)) break;
      seen.add(parentId);
      depth += 1;
      current = headerById.get(parentId);
    }
    return depth;
  };
  const subtreeIds = (headerId, result = new Set()) => {
    if (result.has(headerId)) return result;
    result.add(headerId);
    for (const memberId of membersByHeader.get(headerId) || []) result.add(memberId);
    for (const childId of childHeadersByParent.get(headerId) || []) subtreeIds(childId, result);
    return result;
  };
  const translateSubtree = (headerId, deltaX, deltaY) => {
    if (!deltaX && !deltaY) return 0;
    let translated = 0;
    for (const id of subtreeIds(headerId)) {
      const box = nodeBoxes.get(id);
      if (!box) continue;
      box.x += deltaX;
      box.y += deltaY;
      translated += 1;
    }
    return translated;
  };
  const incomingByTarget = new Map();
  const outgoingBySource = new Map();
  for (const edge of edges) incomingByTarget.set(edge.end, [...(incomingByTarget.get(edge.end) || []), edge]);
  for (const edge of edges) outgoingBySource.set(edge.start, [...(outgoingBySource.get(edge.start) || []), edge]);
  const alignedAxisSourceByHeader = new Map();
  let moved = 0;

  for (const header of [...headers].sort((left, right) => depthOf(left.id) - depthOf(right.id))) {
    const headerBox = nodeBoxes.get(header.id);
    if (!headerBox) continue;
    const assignmentReturnEdge = (outgoingBySource.get(header.id) || []).find((edge) => (
      edge.type === 'YIELDS_VALUE'
      && (
        String(edge.props?.protocolRole || edge.props?.protocol_role || '') === 'assignment-return'
        || hasLabel(nodeById.get(edge.end), 'Field')
      )
    ));
    if (assignmentReturnEdge) {
      const targetBox = nodeBoxes.get(assignmentReturnEdge.end);
      const target = nodeById.get(assignmentReturnEdge.end);
      if (targetBox) {
        const nestedBelowField = hasLabel(target, 'Field');
        const nextX = nestedBelowField
          ? Math.round(targetBox.x + targetBox.width / 2 - headerBox.width / 2)
          : headerBox.x;
        const nextY = nestedBelowField
          ? Math.round(targetBox.y + targetBox.height + NESTED_SUBSTEP_GRADE_GAP)
          : Math.round(targetBox.y + (targetBox.height - headerBox.height) / 2);
        moved += translateSubtree(header.id, nextX - headerBox.x, nextY - headerBox.y);
        alignedAxisSourceByHeader.set(header.id, assignmentReturnEdge.end);
      }
    }
    const returnedValueEdge = !assignmentReturnEdge && (incomingByTarget.get(header.id) || []).find((edge) => {
      const source = nodeById.get(edge.start);
      return edge.type === 'NEXT'
        && hasLabel(source, 'Return')
        && hasLabel(source, 'LocalBinding')
        && memberSubmethodStableIdForLayout(source) === parentSubmethodStableIdForLayout(header);
    });
    if (returnedValueEdge) {
      const sourceBox = nodeBoxes.get(returnedValueEdge.start);
      if (sourceBox) {
        const nextY = Math.round(sourceBox.y + (sourceBox.height - headerBox.height) / 2);
        moved += translateSubtree(header.id, 0, nextY - headerBox.y);
        alignedAxisSourceByHeader.set(header.id, returnedValueEdge.start);
      }
    }

    const parentId = parentSubmethodStableIdForLayout(header);
    const parentAxisSourceId = alignedAxisSourceByHeader.get(parentId);
    if (!parentId || !parentAxisSourceId) continue;
    const parentAxisSource = nodeById.get(parentAxisSourceId);
    const axisOwnerId = memberSubmethodStableIdForLayout(parentAxisSource);
    const sourceRow = submethodRelativeRowForLayout(parentAxisSource);
    const nextAxisMember = nodes
      .filter((node) => (
        memberSubmethodStableIdForLayout(node) === axisOwnerId
        && submethodRelativeRowForLayout(node) > sourceRow
      ))
      .sort((left, right) => submethodRelativeRowForLayout(left) - submethodRelativeRowForLayout(right))[0];
    const nextAxisBox = nodeBoxes.get(nextAxisMember?.id);
    const currentHeaderBox = nodeBoxes.get(header.id);
    if (!nextAxisBox || !currentHeaderBox) continue;
    moved += translateSubtree(header.id, 0, nextAxisBox.y - currentHeaderBox.y);
    alignedAxisSourceByHeader.set(header.id, nextAxisMember.id);
  }

  // Async child calls are a continuation below their caller, not another horizontal
  // branch. The ASYNC/CATCH edges are the extracted layout semantics for that choice.
  for (const header of [...headers].sort((left, right) => depthOf(left.id) - depthOf(right.id))) {
    const parentId = parentSubmethodStableIdForLayout(header);
    const parent = headerById.get(parentId);
    const headerBox = nodeBoxes.get(header.id);
    const parentBox = nodeBoxes.get(parent?.id);
    if (!parent || !headerBox || !parentBox) continue;
    const verticalEdge = edges.find((edge) => (
      edge.start === parent.id
      && edge.end === header.id
      && (edge.type === 'ASYNC' || edge.type === 'CATCH')
    ));
    if (!verticalEdge) continue;
    const childBoxes = [...subtreeIds(header.id)].map((id) => nodeBoxes.get(id)).filter(Boolean);
    const childTop = Math.min(...childBoxes.map((box) => box.y));
    const targetTop = parentBox.y + parentBox.height + 28;
    const deltaX = Math.round(
      parentBox.x + parentBox.width / 2 - (headerBox.x + headerBox.width / 2),
    );
    const deltaY = Math.max(0, Math.round(targetTop - childTop));
    moved += translateSubtree(header.id, deltaX, deltaY);
  }

  // Object siblings share the center of the widest fully laid-out subcolumn.
  // Measure after nested submethods because a field's producer can be much wider
  // than the field tile itself (for example, an updater callback below a field).
  const fieldEdgesByOwner = new Map();
  for (const edge of edges) {
    if (edge.type !== 'FIELD') continue;
    const horizontal = (edge.props?.layoutFrame || edge.props?.layout_frame) === 'horizontal';
    if (!horizontal) continue;
    fieldEdgesByOwner.set(edge.start, [...(fieldEdgesByOwner.get(edge.start) || []), edge]);
  }
  for (const [familyOpenId, fieldEdges] of fieldEdgesByOwner.entries()) {
    if (fieldEdges.length < 2) continue;
    const branches = fieldEdges.map((fieldEdge) => {
      const ids = new Set([fieldEdge.end]);
      for (const header of headers) {
        const returnsToField = (outgoingBySource.get(header.id) || []).some((edge) => (
          edge.end === fieldEdge.end
          && (edge.type === 'ASSIGNS_VALUE' || edge.type === 'YIELDS_VALUE')
          && String(edge.props?.protocolRole || edge.props?.protocol_role || '') === 'assignment-return'
        ));
        if (returnsToField) subtreeIds(header.id, ids);
      }
      const boxes = [...ids].map((id) => nodeBoxes.get(id)).filter(Boolean);
      if (!boxes.length) return null;
      const left = Math.min(...boxes.map((box) => box.x));
      const right = Math.max(...boxes.map((box) => box.x + box.width));
      return { ids, left, right, width: right - left, center: (left + right) / 2 };
    }).filter(Boolean);
    if (branches.length < 2) continue;
    const widest = branches.reduce((current, candidate) => (
      candidate.width > current.width ? candidate : current
    ));
    for (const branch of branches) {
      const deltaX = Math.round(widest.center - branch.center);
      if (!deltaX) continue;
      for (const id of branch.ids) {
        const box = nodeBoxes.get(id);
        if (!box) continue;
        box.x += deltaX;
        moved += 1;
      }
    }

    const familyCloseIds = new Set(fieldEdges.flatMap((fieldEdge) => (
      (outgoingBySource.get(fieldEdge.end) || [])
        .filter((edge) => edge.type === 'FieldJoin')
        .map((edge) => edge.end)
    )));
    const familyOpen = nodeById.get(familyOpenId);
    const familyOpenBox = nodeBoxes.get(familyOpenId);
    const familyCloseId = familyCloseIds.size === 1 ? [...familyCloseIds][0] : '';
    const familyClose = nodeById.get(familyCloseId);
    const familyCloseBox = nodeBoxes.get(familyCloseId);
    if (
      hasLabel(familyOpen, 'ObjectBrace')
      && hasLabel(familyOpen, 'Open')
      && hasLabel(familyClose, 'ObjectBrace')
      && hasLabel(familyClose, 'Close')
      && familyOpenBox
      && familyCloseBox
    ) {
      const interiorCenter = (
        familyOpenBox.x + familyOpenBox.width + familyCloseBox.x
      ) / 2;
      const familyDeltaX = Math.round(interiorCenter - widest.center);
      if (familyDeltaX) {
        const familyMemberIds = new Set(branches.flatMap((branch) => [...branch.ids]));
        for (const id of familyMemberIds) {
          const box = nodeBoxes.get(id);
          if (!box) continue;
          box.x += familyDeltaX;
          moved += 1;
        }
      }
    }
  }
  return moved;
}

function directMosaicOutcomeTopInset(memberIds, nodeById, outgoingByNodeId) {
  const hasDirectMosaicOutcome = [...memberIds].some((memberId) => {
    const member = nodeById.get(memberId);
    if (!member || !isBranchNode(member) || !structuredHorizontalSize(member)) return false;
    const outcomes = (outgoingByNodeId.get(memberId) || [])
      .filter((edge) => edge.type === 'TRUE' || edge.type === 'FALSE');
    return outcomes.length === 2
      && outcomes.some((edge) => edge.type === 'TRUE')
      && outcomes.some((edge) => edge.type === 'FALSE')
      && outcomes[0].end === outcomes[1].end
      && isDataJoinNode(nodeById.get(outcomes[0].end));
  });
  return hasDirectMosaicOutcome ? HORIZONTAL_MOSAIC_OUTCOME_TOP_INSET : 0;
}

function alignExpandedObjectFamilies(nodes, edges, nodeBoxes) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const outgoingByNodeId = new Map();
  for (const edge of edges) {
    outgoingByNodeId.set(edge.start, [...(outgoingByNodeId.get(edge.start) || []), edge]);
  }
  let moved = 0;
  for (const opening of nodes) {
    const openingBox = nodeBoxes.get(opening.id);
    const openingOverlay = structuredContainerOverlayPartBox(opening, openingBox, 'overlay');
    if (!openingBox || !openingOverlay) continue;
    const fieldEdges = edges.filter((edge) => edge.type === 'FIELD' && edge.start === opening.id);
    const fields = fieldEdges
      .map((edge) => nodeById.get(edge.end))
      .filter((node) => node && !isObjectBraceNode(node))
      .sort((left, right) => Number(left.props?.fieldIndex ?? left.props?.field_index ?? 0)
        - Number(right.props?.fieldIndex ?? right.props?.field_index ?? 0));
    if (!fields.length) continue;
    const families = fields.map((field) => {
      const memberIds = new Set([field.id]);
      const closureIds = new Set();
      const queue = [field.id];
      const ownerStepStableId = ownerStepStableIdForGraphItem(field);
      while (queue.length) {
        const currentId = queue.shift();
        for (const edge of outgoingByNodeId.get(currentId) || []) {
          if (edge.type === 'FieldJoin') {
            closureIds.add(edge.end);
            continue;
          }
          const target = nodeById.get(edge.end);
          if (
            !target
            || target.id === opening.id
            || memberIds.has(target.id)
            || isFlowJoinNode(target)
            || (ownerStepStableId && ownerStepStableIdForGraphItem(target) !== ownerStepStableId)
          ) continue;
          memberIds.add(edge.end);
          queue.push(edge.end);
        }
      }
      const boxes = [...memberIds].map((id) => nodeBoxes.get(id)).filter(Boolean);
      if (boxes.length !== memberIds.size) return null;
      const minX = Math.min(...boxes.map((box) => box.x));
      const topRouteInset = directMosaicOutcomeTopInset(memberIds, nodeById, outgoingByNodeId);
      const minY = Math.min(...boxes.map((box) => box.y)) - topRouteInset;
      const maxX = Math.max(...boxes.map((box) => box.x + box.width));
      const maxY = Math.max(...boxes.map((box) => box.y + box.height));
      return {
        field,
        memberIds,
        closureIds,
        minX,
        minY,
        maxX,
        maxY,
        width: maxX - minX,
        height: maxY - minY,
      };
    }).filter(Boolean);
    if (families.length !== fields.length) continue;
    const closureIds = families.map((family) => [...family.closureIds]);
    const closureId = closureIds[0]?.find((id) => closureIds.every((ids) => ids.includes(id)));
    const closureBox = nodeBoxes.get(closureId);
    if (!closureBox) continue;

    const fieldGap = 12;
    const horizontalGap = 36;
    const totalFieldHeight = families.reduce((height, family) => height + family.height, 0)
      + fieldGap * Math.max(0, families.length - 1);
    const centerY = openingOverlay.y + openingOverlay.height / 2;
    const fieldX = openingBox.x + openingBox.width + horizontalGap;
    let fieldY = Math.round(centerY - totalFieldHeight / 2);
    let maxFieldWidth = 0;
    for (const family of families) {
      const fieldBox = nodeBoxes.get(family.field.id);
      const dx = fieldX - fieldBox.x;
      const dy = fieldY - family.minY;
      for (const memberId of family.memberIds) {
        const box = nodeBoxes.get(memberId);
        if (dx || dy) moved += 1;
        box.x += dx;
        box.y += dy;
      }
      maxFieldWidth = Math.max(maxFieldWidth, family.width);
      fieldY += family.height + fieldGap;
    }
    const closureX = fieldX + maxFieldWidth + horizontalGap;
    const closureY = Math.round(centerY - closureBox.height / 2);
    if (closureBox.x !== closureX || closureBox.y !== closureY) moved += 1;
    closureBox.x = closureX;
    closureBox.y = closureY;
  }
  return moved;
}

const OBJECT_FAMILY_EXTERNAL_BINDING_EDGES = new Set([
  'CAPTURES_VALUE',
  'CLEARS_VALUE',
  'CREATES_VALUE',
  'DELETES_VALUE',
  'PASSES_VALUE',
  'READS_VALUE',
  'RECEIVES_VALUE',
  'WRITES_VALUE',
]);

export function isObjectFamilyMemberTraversalEdge(edge) {
  return !OBJECT_FAMILY_EXTERNAL_BINDING_EDGES.has(edge.type);
}

export function alignObjectBraceFamilies(nodes, edges, nodeBoxes) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const outgoingByNodeId = new Map();
  const incomingByNodeId = new Map();
  for (const edge of edges) {
    outgoingByNodeId.set(edge.start, [...(outgoingByNodeId.get(edge.start) || []), edge]);
    incomingByNodeId.set(edge.end, [...(incomingByNodeId.get(edge.end) || []), edge]);
  }
  const submethodHeaders = nodes.filter((node) => submethodStableIdForLayout(node) === node.id);
  const childSubmethodsByParent = new Map();
  const membersBySubmethod = new Map();
  for (const header of submethodHeaders) {
    const parentId = parentSubmethodStableIdForLayout(header);
    if (parentId) {
      childSubmethodsByParent.set(parentId, [
        ...(childSubmethodsByParent.get(parentId) || []),
        header.id,
      ]);
    }
  }
  for (const node of nodes) {
    const ownerId = memberSubmethodStableIdForLayout(node);
    if (ownerId) {
      membersBySubmethod.set(ownerId, [...(membersBySubmethod.get(ownerId) || []), node.id]);
    }
  }
  const submethodTreeIds = (headerId, result = new Set()) => {
    if (!headerId || result.has(headerId)) return result;
    result.add(headerId);
    for (const memberId of membersBySubmethod.get(headerId) || []) result.add(memberId);
    for (const childId of childSubmethodsByParent.get(headerId) || []) {
      submethodTreeIds(childId, result);
    }
    return result;
  };
  const bracesByFamily = new Map();
  for (const brace of nodes.filter(isObjectBraceNode)) {
    const familyId = String(brace.props?.objectFamilyStableId || brace.props?.object_family_stable_id || brace.id);
    bracesByFamily.set(familyId, [...(bracesByFamily.get(familyId) || []), brace]);
  }
  let moved = 0;

  for (const braces of bracesByFamily.values()) {
    const leftBraces = braces
      .filter((brace) => String(brace.props?.objectBraceSide || brace.props?.object_brace_side || '') === 'left')
      .sort((left, right) => Number(left.props?.objectBracePairIndex ?? left.props?.object_brace_pair_index ?? 0)
        - Number(right.props?.objectBracePairIndex ?? right.props?.object_brace_pair_index ?? 0));
    const rightBraces = braces
      .filter((brace) => String(brace.props?.objectBraceSide || brace.props?.object_brace_side || '') === 'right')
      .sort((left, right) => Number(left.props?.objectBracePairIndex ?? left.props?.object_brace_pair_index ?? 0)
        - Number(right.props?.objectBracePairIndex ?? right.props?.object_brace_pair_index ?? 0));
    if (!leftBraces.length || leftBraces.length !== rightBraces.length) continue;

    const fieldEdges = leftBraces.flatMap((brace) => (outgoingByNodeId.get(brace.id) || [])
      .filter((edge) => edge.type === 'FIELD' && !isObjectBraceNode(nodeById.get(edge.end))));
    const fields = [...new Set(fieldEdges.map((edge) => edge.end))]
      .map((id) => nodeById.get(id))
      .filter(Boolean)
      .sort((left, right) => Number(left.props?.fieldIndex ?? left.props?.field_index ?? 0)
        - Number(right.props?.fieldIndex ?? right.props?.field_index ?? 0));
    if (fields.length < 2) continue;

    const rightBraceIds = new Set(rightBraces.map((brace) => brace.id));
    const families = fields.map((field) => {
      const memberIds = new Set([field.id]);
      const queue = [field.id];
      const ownerStepStableId = ownerStepStableIdForGraphItem(field);
      while (queue.length) {
        const currentId = queue.shift();
        for (const edge of outgoingByNodeId.get(currentId) || []) {
          if (!isObjectFamilyMemberTraversalEdge(edge)) continue;
          if (rightBraceIds.has(edge.end)) continue;
          const target = nodeById.get(edge.end);
          const nestedVerticalEvaluation = edge.type === 'EVAL'
            && String(
              nodeById.get(currentId)?.props?.nestedEvaluationDirection
              || nodeById.get(currentId)?.props?.nested_evaluation_direction
              || '',
            ) === 'down';
          if (
            !target
            || memberIds.has(target.id)
            || isObjectBraceNode(target)
            || isFlowJoinNode(target)
            || (target.id !== field.id && hasLabel(target, 'SubStep') && !nestedVerticalEvaluation)
            || (ownerStepStableId && ownerStepStableIdForGraphItem(target) !== ownerStepStableId)
          ) continue;
          memberIds.add(target.id);
          queue.push(target.id);
        }
      }
      const producerHeaders = (incomingByNodeId.get(field.id) || [])
        .filter((edge) => (
          (edge.type === 'ASSIGNS_VALUE' || edge.type === 'YIELDS_VALUE')
          && String(edge.props?.protocolRole || edge.props?.protocol_role || '') === 'assignment-return'
        ))
        .map((edge) => nodeById.get(edge.start))
        .filter((node) => node && submethodStableIdForLayout(node) === node.id);
      for (const producer of producerHeaders) {
        for (const memberId of submethodTreeIds(producer.id)) memberIds.add(memberId);
      }
      const boxes = [...memberIds].map((id) => nodeBoxes.get(id)).filter(Boolean);
      if (boxes.length !== memberIds.size) return null;
      const minX = Math.min(...boxes.map((box) => box.x));
      const topRouteInset = directMosaicOutcomeTopInset(memberIds, nodeById, outgoingByNodeId);
      const minY = Math.min(...boxes.map((box) => box.y)) - topRouteInset;
      const maxX = Math.max(...boxes.map((box) => box.x + box.width));
      const maxY = Math.max(...boxes.map((box) => box.y + box.height));
      const producerWidths = producerHeaders.flatMap((header) => (
        [...submethodTreeIds(header.id)]
          .map((id) => nodeBoxes.get(id)?.width)
          .filter(Number.isFinite)
      ));
      const fieldEdge = fieldEdges.find((edge) => edge.end === field.id);
      return {
        field,
        fieldEdge,
        memberIds,
        minX,
        minY,
        width: maxX - minX,
        layoutWidth: Math.max(maxX - minX, ...producerWidths, 0),
        height: maxY - minY,
      };
    }).filter(Boolean);
    if (families.length !== fields.length) continue;

    const outerLeftBox = nodeBoxes.get(leftBraces[0].id);
    if (!outerLeftBox) continue;
    const outerLeftNeighborId = leftBraces[0].props?.objectBraceMosaicNeighborStableId
      || leftBraces[0].props?.object_brace_mosaic_neighbor_stable_id;
    const openerEdge = (incomingByNodeId.get(leftBraces[0].id) || [])
      .find((edge) => !isObjectBraceNode(nodeById.get(edge.start)));
    const opener = nodeById.get(outerLeftNeighborId || openerEdge?.start);
    const openerBox = nodeBoxes.get(opener?.id);
    const openerOverlay = opener && openerBox
      ? structuredContainerOverlayPartBox(opener, openerBox, 'overlay')
      : null;
    const requestedCenterY = openerOverlay
      ? openerOverlay.y + openerOverlay.height / 2
      : openerBox
        ? openerBox.y + openerBox.height / 2
        : outerLeftBox.y + outerLeftBox.height / 2;
    const fieldGap = 12;
    const horizontalGap = 36;
    const openingBoundaryGap = outerLeftNeighborId
      ? 0
      : slotNameForEdge(openerEdge)
        ? Math.max(horizontalGap, slotEdgeLabelRequiredGap(openerEdge))
        : horizontalGap;
    const leftX = openerBox
      ? openerBox.x + openerBox.width + openingBoundaryGap
      : outerLeftBox.x;
    const familyLeftBoundary = leftX + 20;
    const familyLayouts = families.map((family) => {
      const labelClearance = slotNameForEdge(family.fieldEdge)
        ? slotEdgeLabelRequiredGap(family.fieldEdge)
        : horizontalGap;
      return {
        family,
        leadingClearance: Math.max(horizontalGap, labelClearance),
      };
    });
    const familyContentCenterOffset = Math.max(...familyLayouts.map(({ family, leadingClearance }) => (
      leadingClearance + family.layoutWidth / 2
    )));
    const familySpan = familyContentCenterOffset
      + Math.max(...families.map((family) => family.layoutWidth / 2))
      + horizontalGap;
    const fieldMetrics = families.map((family) => {
      const fieldBox = nodeBoxes.get(family.field.id);
      return {
        height: fieldBox.height,
        topOffset: fieldBox.y - family.minY,
      };
    });
    const totalFieldHeight = fieldMetrics.reduce((sum, metric) => sum + metric.height, 0)
      + fieldGap * Math.max(0, fieldMetrics.length - 1);
    const targetTopByIndex = new Map();
    let fieldTop = requestedCenterY - totalFieldHeight / 2;
    for (let index = 0; index < families.length; index += 1) {
      targetTopByIndex.set(index, Math.round(fieldTop - fieldMetrics[index].topOffset));
      fieldTop += fieldMetrics[index].height + fieldGap;
    }

    // Field axes define the family composition. Full producer subtrees only push
    // neighboring siblings outward when their measured bounds actually overlap.
    const lowerCenterIndex = Math.floor(families.length / 2);
    for (let index = lowerCenterIndex - 1; index >= 0; index -= 1) {
      const nextTop = targetTopByIndex.get(index + 1);
      const maximumTop = nextTop - fieldGap - families[index].height;
      if (targetTopByIndex.get(index) > maximumTop) targetTopByIndex.set(index, maximumTop);
    }
    for (let index = lowerCenterIndex + 1; index < families.length; index += 1) {
      const previousBottom = targetTopByIndex.get(index - 1) + families[index - 1].height;
      const minimumTop = previousBottom + fieldGap;
      if (targetTopByIndex.get(index) < minimumTop) targetTopByIndex.set(index, minimumTop);
    }
    const boundsByFieldIndex = new Map();
    for (let index = 0; index < families.length; index += 1) {
      const family = families[index];
      const fieldY = targetTopByIndex.get(index) ?? family.minY;
      const dx = Math.round(
        familyLeftBoundary
        + familyContentCenterOffset
        - family.layoutWidth / 2
        - family.minX,
      );
      const dy = fieldY - family.minY;
      for (const memberId of family.memberIds) {
        const box = nodeBoxes.get(memberId);
        if (!box) continue;
        if (dx || dy) moved += 1;
        box.x += dx;
        box.y += dy;
      }
      const positionedFieldBox = nodeBoxes.get(family.field.id);
      boundsByFieldIndex.set(
        Number(family.field.props?.fieldIndex ?? family.field.props?.field_index ?? 0),
        {
          lineY: positionedFieldBox.y + positionedFieldBox.height / 2,
        },
      );
    }

    const centralLowerIndex = Math.floor(families.length / 2);
    const centralUpperIndex = families.length % 2 === 0
      ? centralLowerIndex - 1
      : centralLowerIndex;
    const centralUpperField = families[centralUpperIndex]?.field;
    const centralLowerField = families[centralLowerIndex]?.field;
    const centralUpperBox = nodeBoxes.get(centralUpperField?.id);
    const centralLowerBox = nodeBoxes.get(centralLowerField?.id);
    const centerY = centralUpperBox && centralLowerBox
      ? (
          centralUpperBox.y + centralUpperBox.height / 2
          + centralLowerBox.y + centralLowerBox.height / 2
        ) / 2
      : requestedCenterY;
    if (openerBox && centerY !== requestedCenterY) {
      openerBox.y += centerY - requestedCenterY;
      moved += 1;
    }

    const rightX = familyLeftBoundary + familySpan;
    const placeBrace = (brace, x) => {
      const box = nodeBoxes.get(brace.id);
      if (!box) return;
      let indices = [];
      try {
        indices = JSON.parse(String(brace.props?.objectBraceFieldIndicesJson || brace.props?.object_brace_field_indices_json || '[]'));
      } catch {
        indices = [];
      }
      const bounds = indices.map((index) => boundsByFieldIndex.get(Number(index))).filter(Boolean);
      if (!bounds.length) return;
      const minLineY = Math.min(centerY, ...bounds.map((fieldBounds) => fieldBounds.lineY));
      const maxLineY = Math.max(centerY, ...bounds.map((fieldBounds) => fieldBounds.lineY));
      const height = Math.max(30, maxLineY - minLineY);
      const y = Math.round(minLineY - Math.max(0, 30 - (maxLineY - minLineY)) / 2);
      const centerRatio = Math.max(0, Math.min(1, (centerY - y) / height));
      if (box.x !== x || box.y !== y || box.height !== height) moved += 1;
      box.x = x;
      box.y = y;
      box.width = 20;
      box.height = height;
      brace.props = {
        ...brace.props,
        objectBraceCenterRatio: centerRatio,
        objectBraceFieldPortRatiosJson: JSON.stringify(Object.fromEntries(
          indices.map((index) => {
            const fieldBounds = boundsByFieldIndex.get(Number(index));
            const ratio = fieldBounds ? Math.max(0, Math.min(1, (fieldBounds.lineY - y) / height)) : centerRatio;
            return [String(index), ratio];
          }),
        )),
      };
    };
    leftBraces.forEach((brace) => placeBrace(brace, leftX));
    rightBraces.forEach((brace) => placeBrace(brace, rightX));

    const closingEdges = rightBraces.flatMap((brace) => (outgoingByNodeId.get(brace.id) || [])
      .filter((edge) => edge.type === 'FieldJoin' && !isObjectBraceNode(nodeById.get(edge.end))));
    const outerRightNeighborId = rightBraces[0].props?.objectBraceMosaicNeighborStableId
      || rightBraces[0].props?.object_brace_mosaic_neighbor_stable_id;
    const closingIds = [...new Set([
      outerRightNeighborId,
      ...closingEdges.map((edge) => edge.end),
    ].filter((id) => id && !isObjectBraceNode(nodeById.get(id))))];
    for (const closingId of closingIds) {
      const closingBox = nodeBoxes.get(closingId);
      if (!closingBox) continue;
      const x = rightX + 20 + (outerRightNeighborId ? 0 : horizontalGap);
      const y = Math.round(centerY - closingBox.height / 2);
      if (closingBox.x !== x || closingBox.y !== y) moved += 1;
      closingBox.x = x;
      closingBox.y = y;
    }
  }
  return moved;
}

export function alignHorizontalArgumentFamilies(nodes, edges, nodeBoxes) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const outgoingBySource = new Map();
  const argumentsBySource = new Map();
  for (const edge of edges) {
    outgoingBySource.set(edge.start, [...(outgoingBySource.get(edge.start) || []), edge]);
    if (edge.type === 'ARG') {
      argumentsBySource.set(edge.start, [...(argumentsBySource.get(edge.start) || []), edge]);
    }
  }
  const objectFamilies = buildObjectFamilyRouteObstacles(nodes, edges, nodeBoxes);
  const objectFamilyByMemberId = new Map();
  for (const family of objectFamilies) {
    for (const memberId of family.memberIds) objectFamilyByMemberId.set(memberId, family);
  }

  let moved = 0;
  for (const [sourceId, unsortedArgumentEdges] of argumentsBySource.entries()) {
    const argumentEdges = [...unsortedArgumentEdges].sort((left, right) => {
      const leftNode = nodeById.get(left.end);
      const rightNode = nodeById.get(right.end);
      const indexOf = (edge, node) => Number(
        edge.props?.argumentIndex
        ?? edge.props?.argument_index
        ?? node?.props?.argumentIndex
        ?? node?.props?.argument_index
        ?? Number.MAX_SAFE_INTEGER,
      );
      return indexOf(left, leftNode) - indexOf(right, rightNode)
        || String(left.end).localeCompare(String(right.end));
    });
    if (argumentEdges.length < 2) continue;
    const branches = argumentEdges.map((edge) => {
      const objectFamily = objectFamilyByMemberId.get(edge.end);
      if (objectFamily) {
        return {
          memberIds: objectFamily.memberIds,
          left: objectFamily.left,
          right: objectFamily.right,
          top: objectFamily.top,
          bottom: objectFamily.bottom,
        };
      }
      const node = nodeById.get(edge.end);
      const box = nodeBoxes.get(edge.end);
      if (!node || !box) return null;
      const bounds = visualNodeBounds(node, box);
      return {
        memberIds: new Set([edge.end]),
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
      };
    }).filter(Boolean);
    if (branches.length !== argumentEdges.length) continue;

    const widths = branches.map((branch) => branch.right - branch.left);
    const maxWidth = Math.max(...widths);
    const source = nodeById.get(sourceId);
    const sourceBox = nodeBoxes.get(sourceId);
    const sourceBounds = source && sourceBox ? visualNodeBounds(source, sourceBox) : null;
    const requiredOpeningGap = Math.max(
      HORIZONTAL_FAMILY_BOUNDARY_GAP,
      ...argumentEdges.map((edge) => (
        slotNameForEdge(edge)
          ? slotEdgeLabelRequiredGap(edge)
          : HORIZONTAL_FAMILY_BOUNDARY_GAP
      )),
    );
    const familyLeft = sourceBounds
      ? sourceBounds.right + requiredOpeningGap
      : Math.min(...branches.map((branch) => branch.left));
    branches.forEach((branch, index) => {
      const desiredLeft = familyLeft + (maxWidth - widths[index]) / 2;
      const deltaX = Math.round(desiredLeft - branch.left);
      if (!deltaX) return;
      for (const memberId of branch.memberIds) {
        const box = nodeBoxes.get(memberId);
        if (!box) continue;
        box.x += deltaX;
        moved += 1;
      }
    });

    // Final pixel geometry is authoritative. Keep an even family's central
    // axis in the gap between its middle pair instead of letting collision
    // separation leave one sibling on the call axis.
    const familySourcePart = containerOverlayEndpointPart(source, argumentEdges[0], 'source');
    const activeFamilySourceBox = familySourcePart
      ? structuredContainerOverlayPartBox(source, sourceBox, familySourcePart)
      : sourceBox;
    const familyAxisY = activeFamilySourceBox
      ? activeFamilySourceBox.y + activeFamilySourceBox.height / 2
      : null;
    const containerPartId = structuredContainerOverlaySize(source)?.container?.stableId;
    const familyEvaluations = edges.filter(edge => edge.type === 'EVAL'
      && containerPartId
      && (edge.props?.sourceRenderPartStableId || edge.props?.source_render_part_stable_id) === containerPartId
      && branches.some(branch => branch.memberIds.has(edge.start)));
    if (Number.isFinite(familyAxisY)) {
      const branchHeights = branches.map((branch) => branch.bottom - branch.top);
      const totalHeight = branchHeights.reduce((sum, height) => sum + height, 0)
        + RENDERED_NODE_GAP * (branches.length - 1);
      let desiredTop = familyEvaluations.length
        ? familyAxisY - branchHeights[0] / 2
        : familyAxisY - totalHeight / 2;
      branches.forEach((branch, index) => {
        const deltaY = Math.round(desiredTop - branch.top);
        if (deltaY) {
          for (const memberId of branch.memberIds) {
            const box = nodeBoxes.get(memberId);
            if (!box) continue;
            box.y += deltaY;
            moved += 1;
          }
        }
        desiredTop += branchHeights[index] + RENDERED_NODE_GAP;
      });
    }

    for (const edge of familyEvaluations) {
      const target = nodeById.get(edge.end);
      const targetBox = nodeBoxes.get(edge.end);
      if (!target || !targetBox || !sourceBox) continue;
      const from = structuredContainerOverlayPartBox(source, sourceBox, 'container');
      const to = structuredContainerOverlayPartBox(target, targetBox, 'container');
      targetBox.y += (from.y + from.height / 2) - (to.y + to.height / 2);
    }

    const closingTargetSets = branches.map((branch) => new Set(
      [...branch.memberIds]
        .flatMap((memberId) => outgoingBySource.get(memberId) || [])
        .filter((edge) => edge.type === 'ArgJoin')
        .map((edge) => edge.end),
    ));
    const sharedClosingIds = [...(closingTargetSets[0] || [])]
      .filter((targetId) => closingTargetSets.every((targets) => targets.has(targetId)));
    for (const closingId of sharedClosingIds) {
      const closingBox = nodeBoxes.get(closingId);
      if (!closingBox) continue;
      const desiredX = familyLeft + maxWidth + HORIZONTAL_FAMILY_BOUNDARY_GAP;
      if (closingBox.x === desiredX) continue;
      closingBox.x = desiredX;
      moved += 1;
    }
  }
  return moved;
}

function packObjectFamilyContinuations(nodes, edges, nodeBoxes, positions) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const outgoingByNodeId = new Map();
  for (const edge of edges) {
    outgoingByNodeId.set(edge.start, [...(outgoingByNodeId.get(edge.start) || []), edge]);
  }
  const familyEdgeTypes = new Set([
    'ARG', 'FIELD', 'ArgJoin', 'FieldJoin',
    'ARG_JOIN', 'FIELD_JOIN',
    'MATERIALIZES_ARGUMENT', 'MATERIALIZES_FIELD',
  ]);
  const attachedByMosaicNeighbor = new Map();
  for (const node of nodes) {
    const ownerIds = new Set([
      node.props?.objectBraceMosaicNeighborStableId,
      node.props?.object_brace_mosaic_neighbor_stable_id,
      ...(isArgJoinNode(node) || isFieldJoinNode(node) || isCallFinishNode(node)
        ? [node.props?.sourceCallStableId, node.props?.source_call_stable_id]
        : []),
    ].map((value) => String(value || '').trim()).filter(Boolean));
    for (const ownerId of ownerIds) {
      attachedByMosaicNeighbor.set(ownerId, [
        ...(attachedByMosaicNeighbor.get(ownerId) || []),
        node.id,
      ]);
    }
  }
  const familyIdsFrom = (rootId) => {
    const ids = new Set();
    const queue = [rootId, ...(attachedByMosaicNeighbor.get(rootId) || [])];
    while (queue.length) {
      const id = queue.shift();
      if (ids.has(id) || !nodeById.has(id)) continue;
      ids.add(id);
      for (const edge of outgoingByNodeId.get(id) || []) {
        if (familyEdgeTypes.has(edge.type)) queue.push(edge.end);
      }
    }
    return ids;
  };
  const familyBounds = (ids) => {
    const boxes = [...ids].map((id) => nodeBoxes.get(id)).filter(Boolean);
    if (!boxes.length) return null;
    return {
      left: Math.min(...boxes.map((box) => box.x)),
      right: Math.max(...boxes.map((box) => box.x + box.width)),
      top: Math.min(...boxes.map((box) => box.y)),
      bottom: Math.max(...boxes.map((box) => box.y + box.height)),
    };
  };

  let moved = 0;
  const candidates = edges
    .filter((edge) => edge.type === 'NEXT')
    .filter((edge) => {
      const source = nodeById.get(edge.start);
      const target = nodeById.get(edge.end);
      if (!source || !target) return false;
      if (hasLabel(source, 'Loop')) return false;
      if (ownerStepStableIdForGraphItem(source) !== ownerStepStableIdForGraphItem(target)) return false;
      const sourcePosition = positions.get(source.id);
      const targetPosition = positions.get(target.id);
      const sameSubcolumn = Number.isFinite(sourcePosition?.x)
        && Number.isFinite(targetPosition?.x)
        && Math.abs(sourcePosition.x - targetPosition.x) < 0.1;
      const awaitingAssignment = String(
        source.props?.containerState || source.props?.container_state || '',
      ) === 'awaiting-assignment';
      const opensObjectFamily = source.props?.opensObjectFieldFamily === true
        || source.props?.opens_object_field_family === true;
      const expandedFamily = opensObjectFamily && (
        awaitingAssignment
        || (hasLabel(source, 'Collection') && hasLabel(source, 'Start'))
      );
      return (sameSubcolumn && expandedFamily) || familyIdsFrom(source.id).size > 1;
    })
    .sort((left, right) => (
      Number(positions.get(left.start)?.y || 0) - Number(positions.get(right.start)?.y || 0)
    ));

  for (const edge of candidates) {
    const sourceIds = familyIdsFrom(edge.start);
    const targetIds = familyIdsFrom(edge.end);
    const sourceBounds = familyBounds(sourceIds);
    const targetBounds = familyBounds(targetIds);
    if (!sourceBounds || !targetBounds) continue;
    const sourcePosition = positions.get(edge.start);
    const targetPosition = positions.get(edge.end);
    const sourceNode = nodeById.get(edge.start);
    const awaitingAssignment = String(
      sourceNode?.props?.containerState || sourceNode?.props?.container_state || '',
    ) === 'awaiting-assignment';
    const expandedAssignment = awaitingAssignment
      && (sourceNode?.props?.opensObjectFieldFamily === true || sourceNode?.props?.opens_object_field_family === true);
    const expandedCollectionCall = hasLabel(sourceNode, 'Collection')
      && hasLabel(sourceNode, 'Start')
      && (sourceNode.props?.opensObjectFieldFamily === true || sourceNode.props?.opens_object_field_family === true);
    if (
      (expandedAssignment || expandedCollectionCall)
      && Number.isFinite(sourcePosition?.x)
      && Number.isFinite(targetPosition?.x)
      && Math.abs(sourcePosition.x - targetPosition.x) < 0.1
    ) {
      const sourceBox = nodeBoxes.get(edge.start);
      const targetBox = nodeBoxes.get(edge.end);
      if (sourceBox && targetBox) {
        const sourceCenter = sourceBox.x + sourceBox.width / 2;
        const targetCenter = targetBox.x + targetBox.width / 2;
        const deltaX = Math.round(sourceCenter - targetCenter);
        if (deltaX) {
          for (const id of targetIds) {
            const box = nodeBoxes.get(id);
            if (!box) continue;
            box.x += deltaX;
            moved += 1;
          }
        }
      }
    }
    const desiredTop = sourceBounds.bottom + (
      awaitingAssignment ? NESTED_SUBSTEP_GRADE_GAP : RENDERED_NODE_GAP
    );
    const deltaY = Math.round(desiredTop - targetBounds.top);
    if (!deltaY || (
      deltaY > 0
      && !awaitingAssignment
      && !expandedAssignment
      && !expandedCollectionCall
    )) continue;
    for (const id of targetIds) {
      const box = nodeBoxes.get(id);
      if (!box) continue;
      box.y += deltaY;
      moved += 1;
    }
  }

  const controlRegionIds = (rootId) => {
    const ids = new Set();
    const queue = [rootId];
    while (queue.length) {
      const currentId = queue.shift();
      if (ids.has(currentId) || !nodeById.has(currentId)) continue;
      const familyIds = familyIdsFrom(currentId);
      familyIds.forEach((id) => ids.add(id));
      for (const memberId of familyIds) {
        for (const edge of outgoingByNodeId.get(memberId) || []) {
          if (edge.type === 'NEXT' && !ids.has(edge.end)) queue.push(edge.end);
        }
      }
    }
    return ids;
  };
  for (const branch of nodes.filter((node) => hasLabel(node, 'Branch'))) {
    const alternatives = (outgoingByNodeId.get(branch.id) || [])
      .filter((edge) => edge.type === 'TRUE' || edge.type === 'FALSE')
      .map((edge) => {
        const node = nodeById.get(edge.end);
        const ids = node ? controlRegionIds(node.id) : new Set();
        return { edge, node, ids, bounds: familyBounds(ids) };
      })
      .filter(({ node, bounds }) => node && bounds);
    if (alternatives.length !== 2) continue;
    alternatives.sort((left, right) => right.bounds.right - left.bounds.right);
    const side = alternatives[0];
    const main = alternatives[1];
    if (side.bounds.right <= main.bounds.right + 1) continue;
    const sideIds = side.ids;
    const mainIds = main.ids;
    const regionStartsObjectCollectionCall = (ids) => [...ids].some((id) => {
      const node = nodeById.get(id);
      return hasLabel(node, 'Collection')
        && hasLabel(node, 'Start')
        && familyIdsFrom(id).size > 1;
    });
    if (!regionStartsObjectCollectionCall(sideIds) || !regionStartsObjectCollectionCall(mainIds)) continue;
    const sideBounds = familyBounds(sideIds);
    const mainBounds = familyBounds(mainIds);
    if (!sideBounds || !mainBounds) continue;
    const desiredTop = sideBounds.bottom + RENDERED_NODE_GAP;
    const deltaY = Math.round(desiredTop - mainBounds.top);
    if (deltaY >= 0) continue;
    for (const id of mainIds) {
      const box = nodeBoxes.get(id);
      if (!box) continue;
      box.y += deltaY;
      moved += 1;
    }
  }
  return moved;
}

function routeObjectBraceFieldEndpoints(nodes, edges) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const centerPort = (brace, side) => {
    const centerRatio = Number(
      brace?.props?.objectBraceCenterRatio
      ?? brace?.props?.object_brace_center_ratio
      ?? 0.5,
    );
    const percent = Number(Math.max(0, Math.min(100, centerRatio * 100)).toFixed(3));
    return `${side}-${percent}`;
  };
  const endpointPort = (brace, fieldIndex, role) => {
    let indices = [];
    try {
      indices = JSON.parse(String(
        brace?.props?.objectBraceFieldIndicesJson
        || brace?.props?.object_brace_field_indices_json
        || '[]',
      )).map(Number).filter(Number.isFinite);
    } catch {
      indices = [];
    }
    if (!indices.length || !Number.isFinite(fieldIndex)) return role === 'source' ? 'right' : 'left';
    let fieldPortRatios = {};
    try {
      fieldPortRatios = JSON.parse(String(
        brace?.props?.objectBraceFieldPortRatiosJson
        || brace?.props?.object_brace_field_port_ratios_json
        || '{}',
      ));
    } catch {
      fieldPortRatios = {};
    }
    const fieldPortRatio = Number(fieldPortRatios[String(fieldIndex)]);
    if (Number.isFinite(fieldPortRatio)) {
      const percent = Number(Math.max(0, Math.min(100, fieldPortRatio * 100)).toFixed(3));
      return `${role === 'source' ? 'right' : 'left'}-${percent}`;
    }
    const minIndex = Math.min(...indices);
    const maxIndex = Math.max(...indices);
    if (fieldIndex !== minIndex && fieldIndex !== maxIndex) {
      const centerRatio = Number(
        brace?.props?.objectBraceCenterRatio
        ?? brace?.props?.object_brace_center_ratio
        ?? 0.5,
      );
      const percent = Number(Math.max(0, Math.min(100, centerRatio * 100)).toFixed(3));
      return `${role === 'source' ? 'right' : 'left'}-${percent}`;
    }
    if (minIndex === maxIndex) return role === 'source' ? 'right' : 'left';
    if (fieldIndex === minIndex) return role === 'source' ? 'right-0' : 'left-0';
    return role === 'source' ? 'right-100' : 'left-100';
  };
  return edges.map((edge) => {
    const source = nodeById.get(edge.start);
    const target = nodeById.get(edge.end);
    const sourceBraceSide = isObjectBraceNode(source)
      ? String(source.props?.objectBraceSide || source.props?.object_brace_side || '')
      : '';
    const targetBraceSide = isObjectBraceNode(target)
      ? String(target.props?.objectBraceSide || target.props?.object_brace_side || '')
      : '';
    const fieldIndex = Number(
      edge.props?.fieldIndex
      ?? edge.props?.field_index
      ?? target?.props?.fieldIndex
      ?? target?.props?.field_index
      ?? source?.props?.fieldIndex
      ?? source?.props?.field_index,
    );
    const sourcePort = edge.type === 'FIELD' && sourceBraceSide === 'left'
      ? endpointPort(source, fieldIndex, 'source')
      : edge.type === 'ArgJoin' && sourceBraceSide === 'right'
      ? centerPort(source, 'right')
      : null;
    const targetPort = edge.type === 'FieldJoin' && targetBraceSide === 'right'
      ? endpointPort(target, fieldIndex, 'target')
      : edge.type === 'ARG' && targetBraceSide === 'left'
      ? centerPort(target, 'left')
      : null;
    if (!sourcePort && !targetPort) return edge;
    return {
      ...edge,
      props: {
        ...edge.props,
        ...(sourcePort ? { sourcePort, sourcePortCandidates: [sourcePort] } : {}),
        ...(targetPort ? { targetPort, targetPortCandidates: [targetPort] } : {}),
        lockPortCandidates: true,
        lockResolvedRoutePoints: true,
        layoutRouteReason: [
          edge.props?.layoutRouteReason,
          'object fields attach to paired brace ends; only the central sibling uses the middle port',
        ].filter(Boolean).join('; '),
      },
    };
  });
}

function producerChainRoutingCheck(nodes, edges, nodeBoxes, layout) {
  const findings = [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const producerEdges = edges.filter((edge) => (
    (edge.props?.producerRouteRole || edge.props?.producer_route_role)
    && (() => {
      const role = edge.props?.producerRouteRole || edge.props?.producer_route_role;
      if (role === 'entry') return hasLabel(nodeById.get(edge.start), 'LocalBinding');
      const assignment = nodeById.get(edge.end);
      const containerId = assignment?.props?.hybridOverlayOwnerStableId
        || assignment?.props?.hybrid_overlay_owner_stable_id;
      return hasLabel(containerId ? nodeById.get(containerId) : assignment, 'LocalBinding');
    })()
  ));
  const returnsByTarget = new Map();
  for (const edge of producerEdges) {
    const role = edge.props?.producerRouteRole || edge.props?.producer_route_role;
    if (role === 'entry') {
      if (
        edge.type !== 'EVAL'
        || portSide(edge.props?.sourcePort) !== 'right'
        || portSide(edge.props?.targetPort) !== 'left'
        || (edge.props?.oneWay ?? edge.props?.one_way) !== true
      ) {
        findings.push({ edge: `${edge.start}->${edge.end}`, issue: 'producer entry is not a one-way right-to-left-port EVAL' });
      }
      continue;
    }
    returnsByTarget.set(edge.end, [...(returnsByTarget.get(edge.end) || []), edge]);
    const expectedPort = role === 'return-top' ? 'top' : 'bottom';
    const producerNode = nodeById.get(edge.start);
    const boundaryRole = producerNode?.props?.callBoundaryRole
      || producerNode?.props?.call_boundary_role
      || '';
    const effectiveProducerStableId = edge.props?.effectiveProducerStableId
      || edge.props?.effective_producer_stable_id
      || '';
    if (boundaryRole === 'open') {
      findings.push({
        edge: `${edge.start}->${edge.end}`,
        semanticProducerStableId: edge.props?.semanticProducerStableId
          || edge.props?.semantic_producer_stable_id
          || '',
        issue: 'producer return starts from an opening call boundary instead of its effective closing endpoint',
      });
    }
    if (effectiveProducerStableId && effectiveProducerStableId !== edge.start) {
      findings.push({
        edge: `${edge.start}->${edge.end}`,
        effectiveProducerStableId,
        issue: 'producer return source differs from the endpoint selected by hybrid projection',
      });
    }
    const points = Array.isArray(edge.props?.explicitPoints) ? edge.props.explicitPoints : [];
    const sourceRow = layout?.rowByNodeId?.get(edge.start);
    const ownerStepStableId = ownerStepStableIdForGraphItem(edge);
    const producerScopeStartOrder = Number(
      edge.props?.producerScopeStartOrder ?? edge.props?.producer_scope_start_order,
    );
    const producerScopeEndOrder = Number(
      edge.props?.producerScopeEndOrder ?? edge.props?.producer_scope_end_order,
    );
    const producerScopeStableIds = new Set(
      edge.props?.producerScopeStableIds ?? edge.props?.producer_scope_stable_ids ?? [],
    );
    const hasProducerScope = Number.isFinite(producerScopeStartOrder)
      && Number.isFinite(producerScopeEndOrder);
    const hasExplicitProducerScope = producerScopeStableIds.size > 0;
    const scopeBoxes = dedupeValues([
      ...nodes
      .filter((node) => {
        const inContainerScope = sourceRow
          ? layout.rowByNodeId.get(node.id) === sourceRow
          : !ownerStepStableId || ownerStepStableIdForGraphItem(node) === ownerStepStableId;
        if (!inContainerScope || (!hasProducerScope && !hasExplicitProducerScope)) return inContainerScope;
        if (hasExplicitProducerScope) return producerScopeStableIds.has(node.id);
        const operationIndex = Number(node.props?.operationIndex ?? node.props?.operation_index);
        return node.id === edge.start
          || (Number.isFinite(operationIndex)
            && operationIndex >= producerScopeStartOrder
            && operationIndex <= producerScopeEndOrder);
      })
      .map((node) => nodeBoxes.get(node.id))
      .filter(Boolean),
      nodeBoxes.get(edge.start),
      nodeBoxes.get(edge.end),
    ].filter(Boolean));
    const routeY = points[0]?.y;
    const scopeBoundaryY = role === 'return-top'
      ? Math.min(...scopeBoxes.map((box) => box.y))
      : Math.max(...scopeBoxes.map((box) => box.y + box.height));
    const routeClearance = role === 'return-top'
      ? scopeBoundaryY - routeY
      : routeY - scopeBoundaryY;
    const clearsCompleteScope = Number.isFinite(routeClearance)
      && routeClearance >= ROUTE_OBSTACLE_CLEARANCE;
    const optionalReturnGroupStableId = String(
      edge.props?.optionalReturnGroupStableId || edge.props?.optional_return_group_stable_id || '',
    ).trim();
    if (
      !['ASSIGNS_VALUE', 'PASSES_VALUE', 'YIELDS_VALUE', 'TRUE', 'FALSE'].includes(edge.type)
      || portSide(edge.props?.sourcePort) !== expectedPort
      || portSide(edge.props?.targetPort) !== expectedPort
      || edge.props?.lockRoutePoints !== true
      || (!optionalReturnGroupStableId && !clearsCompleteScope)
    ) {
      findings.push({ edge: `${edge.start}->${edge.end}`, role, issue: 'producer return does not bypass the complete evaluation snippet on its assigned side' });
    }
  }
  for (const [targetId, returns] of returnsByTarget) {
    const topCount = returns.filter((edge) => (edge.props?.producerRouteRole || edge.props?.producer_route_role) === 'return-top').length;
    const bottomCount = returns.length - topCount;
    const target = nodeById.get(targetId);
    const booleanAlternatives = hasLabel(target, 'BooleanFlag');
    const invalidBooleanAlternatives = booleanAlternatives && (
      topCount !== returns.filter((edge) => edge.type === 'TRUE').length
      || bottomCount !== returns.filter((edge) => edge.type === 'FALSE').length
    );
    const invalidValueAlternatives = !booleanAlternatives && (
      (returns.length === 1 && (topCount !== 0 || bottomCount !== 1))
      || (returns.length > 1 && (topCount !== 1 || bottomCount < 1))
    );
    if (invalidBooleanAlternatives || invalidValueAlternatives) {
      findings.push({
        targetStableId: targetId,
        issue: booleanAlternatives
          ? 'boolean producer alternatives must route TRUE above and FALSE below'
          : 'producer alternatives must use exactly one upper return and all remaining lower returns',
      });
    }
  }
  return {
    id: 'producer-chain-routing',
    description: `Variable producer chains enter from the left; returns bypass only their extractor-bounded producer SubStep (${producerEdges.length} edges checked).`,
    status: findings.length ? 'fail' : 'pass',
    findingCount: findings.length,
    findings,
  };
}

function producerReturnStepContainmentCheck(layout, edges) {
  const findings = [];
  let checkedRoutes = 0;
  for (const edge of edges) {
    const role = edge.props?.producerRouteRole || edge.props?.producer_route_role || '';
    if (!['return-top', 'return-bottom'].includes(role)) continue;
    const sourceRow = layout.rowByNodeId.get(edge.start);
    const targetRow = layout.rowByNodeId.get(edge.end);
    if (!sourceRow || sourceRow !== targetRow) {
      findings.push({
        edge: `${edge.start}->${edge.end}`,
        role,
        issue: 'producer return endpoints do not belong to one Step',
      });
      continue;
    }
    const points = Array.isArray(edge.props?.explicitPoints) ? edge.props.explicitPoints : [];
    if (!points.length) {
      findings.push({
        edge: `${edge.start}->${edge.end}`,
        role,
        step: sourceRow.key,
        issue: 'producer return has no explicit bypass route',
      });
      continue;
    }
    checkedRoutes += 1;
    const outsidePoints = points
      .map((point) => ({
        x: Number(point?.x),
        y: Number(point?.y) - layout.y - sourceRow.y,
      }))
      .filter((point) => (
        !Number.isFinite(point.x)
        || !Number.isFinite(point.y)
        || point.y < 0
        || point.y > sourceRow.height
      ));
    if (outsidePoints.length) {
      findings.push({
        edge: `${edge.start}->${edge.end}`,
        role,
        step: sourceRow.key,
        stepHeight: sourceRow.height,
        outsidePoints,
        issue: 'producer return bypass leaves its Step bounds',
      });
    }
  }
  return {
    id: 'producer-return-step-containment',
    description: `Producer return bypasses remain inside their owning Step (${checkedRoutes} routes checked).`,
    status: findings.length ? 'fail' : 'pass',
    findingCount: findings.length,
    findings,
  };
}

function edgeMetadata(edge, label) {
  const stableId = edge.props.stableId || edge.start;
  const targetStableId = edge.props.targetStableId || edge.end;
  const canonicalTargetStableId = edge.props.canonicalTargetStableId || '';
  const layoutEffectiveSourceStableId = edge.props.layoutEffectiveSourceStableId || '';
  const layoutEffectiveTargetStableId = edge.props.layoutEffectiveTargetStableId || '';
  const flowLayer = flowLayerForGraphItem(edge, 'control');
  const ownerStepStableId = ownerStepStableIdForGraphItem(edge);
  const stepVisibility = stepVisibilityForGraphItem(edge);
  const argumentName = edge.props?.argument_name ?? edge.props?.argumentName ?? '';
  const fieldName = edge.props?.field_name ?? edge.props?.fieldName ?? '';
  const producerOutcome = edge.props?.producer_outcome ?? edge.props?.producerOutcome ?? '';
  const protocolRole = edge.props?.protocol_role ?? edge.props?.protocolRole ?? '';
  return `stableId="${xml(stableId)}" targetStableId="${xml(targetStableId)}" canonicalTargetStableId="${xml(canonicalTargetStableId)}" layoutEffectiveSourceStableId="${xml(layoutEffectiveSourceStableId)}" layoutEffectiveTargetStableId="${xml(layoutEffectiveTargetStableId)}" graphKind="edge" edgeType="${xml(edge.type)}" protocolRole="${xml(protocolRole)}" producerOutcome="${xml(producerOutcome)}" argumentName="${xml(argumentName)}" fieldName="${xml(fieldName)}" flowLayer="${xml(flowLayer)}" stepVisibility="${xml(stepVisibility)}" ownerStepStableId="${xml(ownerStepStableId)}" link="${xml(`codex-graph://item?kind=edge&stableId=${encodeURIComponent(stableId)}&targetStableId=${encodeURIComponent(targetStableId)}&canonicalTargetStableId=${encodeURIComponent(canonicalTargetStableId)}&layoutEffectiveSourceStableId=${encodeURIComponent(layoutEffectiveSourceStableId)}&layoutEffectiveTargetStableId=${encodeURIComponent(layoutEffectiveTargetStableId)}&label=${encodeURIComponent(label)}&edgeType=${encodeURIComponent(edge.type)}&protocolRole=${encodeURIComponent(protocolRole)}&argumentName=${encodeURIComponent(argumentName)}&fieldName=${encodeURIComponent(fieldName)}`)}"`;
}

function alignInlineFlowJoins(nodes, edges, nodeBoxes, lateralStubGap) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const incomingByTarget = new Map();
  const outgoingBySource = new Map();
  for (const edge of edges) {
    if (!incomingByTarget.has(edge.end)) incomingByTarget.set(edge.end, []);
    incomingByTarget.get(edge.end).push(edge);
    if (!outgoingBySource.has(edge.start)) outgoingBySource.set(edge.start, []);
    outgoingBySource.get(edge.start).push(edge);
  }
  let moved = 0;
  const joins = nodes.filter(isFlowJoinNode);
  const backboneAlignedJoinIds = new Set();
  for (const join of joins) {
    const incomingTypes = String(join.props?.incoming_edge_types || join.props?.incomingEdgeTypes || '')
      .split(',')
      .map((type) => type.trim())
      .filter(Boolean);
    const homogeneousOutcomeJoin = incomingTypes.length > 0
      && incomingTypes.every((type) => type === incomingTypes[0])
      && (incomingTypes[0] === 'TRUE' || incomingTypes[0] === 'FALSE');
    const stepStableId = String(join.props?.parentStepStableId || '').trim();
    const sourceId = String(join.props?.flowJoinPlacementSourceStableId || '').trim();
    const backboneId = String(join.props?.flowJoinBackboneSourceStableId || '').trim();
    if (!stepStableId || !sourceId || !backboneId) continue;
    const source = nodeById.get(sourceId);
    const backbone = nodeById.get(backboneId);
    if (String(source?.props?.parentStepStableId || '').trim() !== stepStableId) continue;
    if (String(backbone?.props?.parentStepStableId || '').trim() !== stepStableId) continue;
    const sourceBox = nodeBoxes.get(sourceId);
    const backboneBox = nodeBoxes.get(backboneId);
    const joinBox = nodeBoxes.get(join.id);
    if (!sourceBox || !backboneBox || !joinBox) continue;
    const joinFlowLane = String(join.props?.flowLaneStableId || join.props?.flow_lane_stable_id || '').trim();
    const backboneFlowLane = String(backbone.props?.flowLaneStableId || backbone.props?.flow_lane_stable_id || '').trim();
    const sameExtractedFlow = !joinFlowLane || !backboneFlowLane || joinFlowLane === backboneFlowLane;
    const joinDisplayX = Number(join.props?.displayX ?? join.props?.display_x);
    const backboneDisplayX = Number(backbone.props?.displayX ?? backbone.props?.display_x);
    const sameCalculatedColumn = !Number.isFinite(joinDisplayX)
      || !Number.isFinite(backboneDisplayX)
      || joinDisplayX === backboneDisplayX;
    const returnsToInlineTerminalAxis = join.props?.inlineStepTerminalJoin === true
      || join.props?.inline_step_terminal_join === true;
    const nextX = Math.round(backboneBox.x + (backboneBox.width - joinBox.width) / 2);
    if (
      sameExtractedFlow
      && (sameCalculatedColumn || returnsToInlineTerminalAxis)
      && (!homogeneousOutcomeJoin || nextX < joinBox.x)
    ) {
      if (joinBox.x !== nextX) {
        joinBox.x = nextX;
        moved += 1;
      }
    }
    if (homogeneousOutcomeJoin) backboneAlignedJoinIds.add(join.id);
  }
  for (const join of joins) {
    if (backboneAlignedJoinIds.has(join.id)) continue;
    const joinBox = nodeBoxes.get(join.id);
    const continuation = (outgoingBySource.get(join.id) || [])
      .find((edge) => edge.type === 'NEXT' && !isFlowJoinNode(nodeById.get(edge.end)));
    const target = continuation ? nodeById.get(continuation.end) : null;
    const rawTargetBox = continuation ? nodeBoxes.get(continuation.end) : null;
    if (!joinBox || !continuation || !target || !rawTargetBox) continue;
    const horizontalTargetBox = structuredHorizontalEndpointPartBox(target, rawTargetBox, continuation, 'target');
    const overlayRole = containerOverlayEndpointPart(target, continuation, 'target');
    const targetBox = horizontalTargetBox
      || (overlayRole ? structuredContainerOverlayPartBox(target, rawTargetBox, overlayRole) : null)
      || rawTargetBox;
    const targetCenterX = boxCenter(targetBox).x;
    if (Math.abs(targetCenterX - boxCenter(joinBox).x) <= lateralStubGap) continue;
    const destinationHasConnectingJoin = (outgoingBySource.get(target.id) || [])
      .map((edge) => nodeById.get(edge.end))
      .filter(isFlowJoinNode)
      .some((downstreamJoin) => {
        const downstreamBox = nodeBoxes.get(downstreamJoin.id);
        return downstreamBox && Math.abs(boxCenter(downstreamBox).x - targetCenterX) <= lateralStubGap;
      });
    if (destinationHasConnectingJoin) continue;
    const nextX = Math.round(targetCenterX - joinBox.width / 2);
    if (joinBox.x !== nextX) {
      joinBox.x = nextX;
      moved += 1;
    }
  }
  const lateralEntryRankByEdge = new Map();
  const lateralEntryCountBySource = new Map();
  for (const edge of orderEdgesForRouting(edges, nodeBoxes, nodeById)) {
    const target = nodeById.get(edge.end);
    if (!isFlowJoinNode(target)) continue;
    const backboneId = String(target.props?.flowJoinBackboneSourceStableId || '').trim();
    if (!backboneId || edge.start === backboneId) continue;
    const rank = lateralEntryCountBySource.get(edge.start) || 0;
    lateralEntryRankByEdge.set(edge, rank);
    lateralEntryCountBySource.set(edge.start, rank + 1);
  }
  for (const join of joins) {
    const sourceId = String(join.props?.flowJoinPlacementSourceStableId || '').trim();
    const backboneId = String(join.props?.flowJoinBackboneSourceStableId || '').trim();
    const sourceBox = nodeBoxes.get(sourceId);
    const joinBox = nodeBoxes.get(join.id);
    if (!joinBox) continue;
    const lateralRouteYs = (incomingByTarget.get(join.id) || [])
      .filter((edge) => (
        edge.props?.elseIfChainBypass !== true
        && edge.props?.else_if_chain_bypass !== true
        && (backboneId ? edge.start !== backboneId : edge.type === 'REJOINS')
      ))
      .flatMap((edge) => {
        const incomingSource = nodeById.get(edge.start);
        const rawBox = nodeBoxes.get(edge.start);
        if (!incomingSource || !rawBox) return [];
        const horizontalPartBox = structuredHorizontalEndpointPartBox(incomingSource, rawBox, edge, 'source');
        const overlayRole = containerOverlayEndpointPart(incomingSource, edge, 'source');
        const box = horizontalPartBox
          || (overlayRole ? structuredContainerOverlayPartBox(incomingSource, rawBox, overlayRole) : null)
          || rawBox;
        const targetCenter = boxCenter(joinBox);
        const sourceCenter = boxCenter(box);
        const naturalSide = targetCenter.x < sourceCenter.x ? 'left' : 'right';
        const candidateSides = dedupeValues([naturalSide, 'bottom', 'right', 'top', 'left']);
        const sourceSide = candidateSides[lateralEntryRankByEdge.get(edge) || 0] || naturalSide;
        if (sourceSide === 'bottom') return [box.y + box.height + lateralStubGap];
        if (sourceSide === 'top') return [box.y - lateralStubGap];
        return [box.y + box.height / 2];
      });
    const lowestLateralRouteY = lateralRouteYs.length
      ? Math.max(...lateralRouteYs)
      : Number.NEGATIVE_INFINITY;
    const nextCenterY = Number.isFinite(lowestLateralRouteY)
      ? lowestLateralRouteY
      : sourceBox && join.props?.inlineStepTerminalJoin !== true
        ? sourceBox.y + sourceBox.height / 2
        : null;
    if (Number.isFinite(nextCenterY)) {
      const nextY = Math.round(nextCenterY - joinBox.height / 2);
      if (joinBox.y !== nextY) {
        joinBox.y = nextY;
        moved += 1;
      }
    }
  }
  return moved;
}

function iterationRepeatStepContainmentCheck(layout, edges) {
  const findings = [];
  let checkedRoutes = 0;
  for (const edge of edges) {
    const protocolRole = edge.props?.protocolRole || edge.props?.protocol_role || '';
    if (edge.type !== 'REPEATS' && protocolRole !== 'iteration-repeat') continue;
    const sourceRow = layout.rowByNodeId.get(edge.start);
    const targetRow = layout.rowByNodeId.get(edge.end);
    if (!sourceRow || sourceRow !== targetRow) continue;
    const points = Array.isArray(edge.props?.explicitPoints) ? edge.props.explicitPoints : [];
    if (!points.length) continue;
    checkedRoutes += 1;
    const outsidePoints = points
      .map((point) => ({
        x: Number(point?.x) - sourceRow.globalX,
        y: Number(point?.y) - layout.y - sourceRow.y,
      }))
      .filter((point) => (
        !Number.isFinite(point.x)
        || !Number.isFinite(point.y)
        || point.x < -1
        || point.x > sourceRow.width + 1
        || point.y < -1
        || point.y > sourceRow.height + 1
      ));
    if (outsidePoints.length) {
      findings.push({
        edge: `${edge.start}->${edge.end}`,
        step: sourceRow.key,
        stepWidth: sourceRow.width,
        stepHeight: sourceRow.height,
        outsidePoints,
        issue: 'iteration repeat leaves the measured Step bounds',
      });
    }
  }
  return {
    id: 'iteration-repeat-step-containment',
    description: `Iteration repeats remain inside the Step measured around their positioned contents (${checkedRoutes} routes checked).`,
    status: findings.length ? 'fail' : 'pass',
    findingCount: findings.length,
    findings,
  };
}

function iterationRepeatNodeIntersectionCheck(layout, edges, nodeBoxes) {
  const findings = [];
  let checkedRoutes = 0;
  for (const edge of edges) {
    const protocolRole = edge.props?.protocolRole || edge.props?.protocol_role || '';
    if (edge.type !== 'REPEATS' && protocolRole !== 'iteration-repeat') continue;
    const sourceRow = layout.rowByNodeId.get(edge.start);
    const targetRow = layout.rowByNodeId.get(edge.end);
    if (!sourceRow || sourceRow !== targetRow) continue;
    const points = Array.isArray(edge.props?.explicitPoints) ? edge.props.explicitPoints : [];
    if (points.length < 2) continue;
    checkedRoutes += 1;
    const segments = routeSegments(points);
    const blockers = sourceRow.nodes.flatMap((node) => {
      if (node.id === edge.end) return [];
      const box = nodeBoxes.get(node.id);
      if (!box) return [];
      const testedSegments = node.id === edge.start ? segments.slice(1) : segments;
      return testedSegments.some((segment) => segmentCrossesBox(segment, box))
        ? [node.id]
        : [];
    });
    if (blockers.length) {
      findings.push({
        edge: `${edge.start}->${edge.end}`,
        step: sourceRow.key,
        blockers,
        issue: 'iteration repeat crosses a node in its Step',
      });
    }
  }
  return {
    id: 'iteration-repeat-node-intersections',
    description: `Iteration repeats avoid nodes in their Step after leaving the source port (${checkedRoutes} routes checked).`,
    status: findings.length ? 'fail' : 'pass',
    findingCount: findings.length,
    findings,
  };
}

function iterationRepeatObjectFamilyIntersectionCheck(nodes, graphEdges, routedEdges, nodeBoxes) {
  const findings = [];
  let checkedRoutes = 0;
  const familyObstacles = buildObjectFamilyRouteObstacles(nodes, graphEdges, nodeBoxes);
  for (const edge of routedEdges) {
    const protocolRole = edge.props?.protocolRole || edge.props?.protocol_role || '';
    if (edge.type !== 'REPEATS' && protocolRole !== 'iteration-repeat') continue;
    const points = Array.isArray(edge.props?.explicitPoints) ? edge.props.explicitPoints : [];
    if (points.length < 2) continue;
    checkedRoutes += 1;
    const segments = routeSegments(points);
    const crossedFamilies = familyObstacles.filter((obstacle) => (
      !obstacle.memberIds.has(edge.start)
      && !obstacle.memberIds.has(edge.end)
      && !routeObstacleOverlapsNodeBox(obstacle, nodeBoxes.get(edge.start))
      && !routeObstacleOverlapsNodeBox(obstacle, nodeBoxes.get(edge.end))
      && segments.some((segment) => segmentCrossesBox(segment, obstacle))
    ));
    if (crossedFamilies.length) {
      findings.push({
        edge: `${edge.start}->${edge.end}`,
        families: crossedFamilies.map((obstacle) => obstacle.id),
        issue: 'iteration repeat enters the sealed interior of an object family',
      });
    }
  }
  return {
    id: 'iteration-repeat-object-family-intersections',
    description: `Iteration repeats treat object braces and their fields as solid routing obstacles (${checkedRoutes} routes checked).`,
    status: findings.length ? 'fail' : 'pass',
    findingCount: findings.length,
    findings,
  };
}

function routedEdgePoints(edge, nodeBoxes) {
  const sourceBox = nodeBoxes.get(edge.start);
  const targetBox = nodeBoxes.get(edge.end);
  if (!sourceBox || !targetBox) return [];
  const sourcePoint = portPoint(sourceBox, edge.props?.sourcePort) || boxCenter(sourceBox);
  const targetPoint = portPoint(targetBox, edge.props?.targetPort) || boxCenter(targetBox);
  return removeDuplicateRoutePoints([
    sourcePoint,
    ...(Array.isArray(edge.props?.explicitPoints) ? edge.props.explicitPoints : []),
    targetPoint,
  ]);
}

function iterationRepeatObjectFieldCorridorCheck(routedEdges, nodeBoxes) {
  const findings = [];
  const fieldCorridors = [];
  for (const edge of routedEdges) {
    if (edge.type !== 'FIELD' && edge.type !== 'FieldJoin') continue;
    registerRouteCorridors(fieldCorridors, routedEdgePoints(edge, nodeBoxes), {
      sourceId: edge.start,
      targetId: edge.end,
    });
  }
  let checkedRoutes = 0;
  for (const edge of routedEdges) {
    const protocolRole = edge.props?.protocolRole || edge.props?.protocol_role || '';
    if (edge.type !== 'REPEATS' && protocolRole !== 'iteration-repeat') continue;
    const points = routedEdgePoints(edge, nodeBoxes);
    if (points.length < 2) continue;
    checkedRoutes += 1;
    const conflictCount = routeForeignTargetConflictCount(points, fieldCorridors, {
      sourceId: edge.start,
      sourcePoint: points[0],
      targetId: edge.end,
      targetPoint: points.at(-1),
      forbidForeignTargetCrossings: true,
      crossingCorridors: fieldCorridors,
    });
    if (conflictCount) {
      findings.push({
        edge: `${edge.start}->${edge.end}`,
        conflictCount,
        issue: 'iteration repeat crosses a FIELD or FieldJoin corridor',
      });
    }
  }
  return {
    id: 'iteration-repeat-object-field-corridors',
    description: `Iteration repeats do not enter or cross object field corridors (${checkedRoutes} routes checked).`,
    status: findings.length ? 'fail' : 'pass',
    findingCount: findings.length,
    findings,
  };
}

function positionIterationShiftCollections(nodes, edges, nodeBoxes) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  let positioned = 0;
  for (const edge of edges) {
    const protocolRole = edge.props?.protocolRole || edge.props?.protocol_role || '';
    if (edge.type !== 'EVAL' || protocolRole !== 'collection-shift-eval') continue;
    const iterator = nodeById.get(edge.start);
    const collection = nodeById.get(edge.end);
    if (!hasLabel(iterator, 'Iterator') || !hasLabel(collection, 'Collection') || !hasLabel(collection, 'Shift')) continue;
    const iteratorBox = nodeBoxes.get(iterator.id);
    const collectionBox = nodeBoxes.get(collection.id);
    if (!iteratorBox || !collectionBox) continue;
    const iteratorContainer = structuredContainerOverlayPartBox(iterator, iteratorBox, 'container');
    const shiftMethod = structuredContainerOverlayPartBox(collection, collectionBox, 'method');
    if (!iteratorContainer || !shiftMethod) continue;
    const nextY = Math.round(
      collectionBox.y
      + iteratorContainer.y + iteratorContainer.height / 2
      - shiftMethod.y - shiftMethod.height / 2,
    );
    if (collectionBox.y === nextY) continue;
    collectionBox.y = nextY;
    positioned += 1;
  }
  return positioned;
}

export function alignForInitializationRows(nodes, edges, nodeBoxes, semanticNodes = [], foldingLayout = null) {
  const byId = new Map([...semanticNodes, ...nodes].map(node => [node.id || node.key, node]));
  const blockOf = node => node?.props?.parentFlowBlockStableId || node?.props?.parent_flow_block_stable_id;
  let moved = 0;
  for (const edge of edges) {
    const entry = byId.get(edge.start);
    const initial = byId.get(edge.end);
    if (edge.type !== 'NEXT' || !hasLabel(entry, 'For') || !hasLabel(initial, 'ValueCreate')) continue;
    const entryBox = nodeBoxes.get(entry.id);
    const initialBox = nodeBoxes.get(initial.id);
    const block = blockOf(initial);
    if (!entryBox || !initialBox || !block) continue;
    const effectiveEntry = foldingLayout ? effectiveFoldedRoutingBox(entry.id, entryBox, foldingLayout) : entryBox;
    const effectiveInitial = foldingLayout ? effectiveFoldedRoutingBox(initial.id, initialBox, foldingLayout) : initialBox;
    const container = structuredContainerOverlayPartBox(initial, effectiveInitial, 'container');
    const deltaY = effectiveEntry.y + effectiveEntry.height / 2 - (container.y + container.height / 2);
    const deltaX = foldingLayout ? 0
      : effectiveEntry.x + effectiveEntry.width + HORIZONTAL_STEP_COLUMN_GAP - container.x;
    if (Math.abs(deltaY) < 0.01 && Math.abs(deltaX) < 0.01) continue;
    const movedRows = new Set();
    for (const node of nodes) {
      let owner = blockOf(node);
      const seen = new Set();
      while (owner && owner !== block && !seen.has(owner)) {
        seen.add(owner);
        owner = blockOf(byId.get(owner));
      }
      if (owner !== block) continue;
      const box = nodeBoxes.get(node.id);
      if (!box) continue;
      if (foldingLayout) {
        const row = foldingLayout.rowByNodeId.get(node.id);
        if (row && !movedRows.has(row)) { row.y += deltaY; movedRows.add(row); moved++; }
      } else { box.x += deltaX; box.y += deltaY; moved++; }
    }
    for (const framedBlock of foldingLayout?.blocks || []) {
      if ([...framedBlock.memberRowIds].every(id => [...movedRows].some(row => row.id === id))) {
        framedBlock.globalY += deltaY;
      }
    }
  }
  return moved;
}

function positionForOfIterationColumns(nodes, edges, nodeBoxes) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  let positioned = 0;
  for (const edge of edges) {
    if (edge.type !== 'NEXT') continue;
    const loop = nodeById.get(edge.start);
    const iterator = nodeById.get(edge.end);
    if (!hasLabel(loop, 'Loop') || !hasLabel(iterator, 'Iterator')) continue;
    if (String(iterator.props?.collectionMethod || iterator.props?.collection_method || '') !== 'for-of') continue;
    const stepStableId = ownerStepStableIdForGraphItem(iterator);
    const loopBox = nodeBoxes.get(loop.id);
    const iteratorBox = nodeBoxes.get(iterator.id);
    if (!stepStableId || !loopBox || !iteratorBox) continue;
    const iteratorContainer = structuredContainerOverlayPartBox(iterator, iteratorBox, 'container');
    const desiredIteratorLeft = loopBox.x + loopBox.width + HORIZONTAL_STEP_COLUMN_GAP;
    const deltaX = Math.round(desiredIteratorLeft - iteratorBox.x);
    const iteratorCenterOffsetY = iteratorContainer.y + iteratorContainer.height / 2 - iteratorBox.y;
    const desiredIteratorTop = loopBox.y + loopBox.height / 2 - iteratorCenterOffsetY;
    const deltaY = Math.round(desiredIteratorTop - iteratorBox.y);
    if (!deltaX && !deltaY) continue;
    for (const member of nodes) {
      if (member.id === loop.id || ownerStepStableIdForGraphItem(member) !== stepStableId) continue;
      const box = nodeBoxes.get(member.id);
      if (!box) continue;
      box.x += deltaX;
      box.y += deltaY;
      positioned += 1;
    }
  }
  return positioned;
}

function positionExtractedSubstepColumns(nodes, edges, nodeBoxes) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const belongsToSubstep = (node, rootId) => {
    if (node.id === rootId) return true;
    const seen = new Set();
    let ownerId = String(
      node.props?.memberOfSubmethodStableId
      || node.props?.member_of_submethod_stable_id
      || node.props?.parentSubmethodStableId
      || node.props?.parent_submethod_stable_id
      || '',
    );
    while (ownerId && !seen.has(ownerId)) {
      if (ownerId === rootId) return true;
      seen.add(ownerId);
      const owner = nodeById.get(ownerId);
      ownerId = String(
        owner?.props?.parentSubmethodStableId
        || owner?.props?.parent_submethod_stable_id
        || '',
      );
    }
    return false;
  };
  let positioned = 0;
  for (const target of nodes) {
    const columnOffset = Number(
      target.props?.substepColumnOffset
      ?? target.props?.substep_column_offset
      ?? 0,
    );
    if (!(columnOffset > 0)) continue;
    const incoming = edges.find((edge) => (
      edge.end === target.id && ['NEXT', 'TRUE', 'FALSE'].includes(edge.type)
    ));
    const sourceBox = incoming ? nodeBoxes.get(incoming.start) : undefined;
    const targetBox = nodeBoxes.get(target.id);
    if (!sourceBox || !targetBox) continue;
    const desiredLeft = sourceBox.x + sourceBox.width + HORIZONTAL_STEP_COLUMN_GAP;
    const deltaX = Math.round(desiredLeft - targetBox.x);
    if (!deltaX) continue;
    for (const member of nodes) {
      if (!belongsToSubstep(member, target.id)) continue;
      const box = nodeBoxes.get(member.id);
      if (!box) continue;
      box.x += deltaX;
      positioned += 1;
    }
  }
  return positioned;
}

function alignExtractedSubstepRows(nodes, nodeBoxes) {
  const rowGroups = new Map();
  for (const node of nodes) {
    if (isObjectBraceNode(node)) continue;
    const ownerStableId = String(
      node.props?.memberOfSubmethodStableId
      || node.props?.member_of_submethod_stable_id
      || '',
    );
    const relativeRow = Number(
      node.props?.submethodRelativeRow
      ?? node.props?.submethod_relative_row,
    );
    const relativeColumn = Number(
      node.props?.submethodRelativeColumn
      ?? node.props?.submethod_relative_column,
    );
    if (!ownerStableId || !Number.isFinite(relativeRow) || !Number.isFinite(relativeColumn)) continue;
    const key = `${ownerStableId}\u0000${relativeRow}`;
    if (!rowGroups.has(key)) rowGroups.set(key, []);
    rowGroups.get(key).push({ node, relativeColumn });
  }

  let positioned = 0;
  for (const members of rowGroups.values()) {
    if (members.length < 2) continue;
    members.sort((left, right) => left.relativeColumn - right.relativeColumn);
    const predicatesShareRow = members.every(({ node }) => node.labels?.includes('Branch'));
    const surfaceBox = ({ node, relativeColumn }) => {
      const box = nodeBoxes.get(node.id);
      if (!box) return undefined;
      const role = predicatesShareRow || relativeColumn > members[0].relativeColumn
        ? 'method'
        : 'container';
      return structuredContainerOverlayPartBox(node, box, role);
    };
    const anchorSurface = surfaceBox(members[0]);
    if (!anchorSurface) continue;
    const targetCenterY = anchorSurface.y + anchorSurface.height / 2;
    for (const member of members.slice(1)) {
      const box = nodeBoxes.get(member.node.id);
      const surface = surfaceBox(member);
      if (!box || !surface) continue;
      const deltaY = Math.round(targetCenterY - (surface.y + surface.height / 2));
      if (!deltaY) continue;
      box.y += deltaY;
      positioned += 1;
    }
  }
  return positioned;
}

function alignHorizontalDataJoins(nodes, edges, nodeBoxes) {
  const incomingByTarget = new Map();
  const outgoingBySource = new Map();
  for (const edge of edges) {
    incomingByTarget.set(edge.end, [...(incomingByTarget.get(edge.end) || []), edge]);
    outgoingBySource.set(edge.start, [...(outgoingBySource.get(edge.start) || []), edge]);
  }
  let moved = 0;
  for (const join of nodes.filter((node) => isDataJoinNode(node) || isExclusiveJoinNode(node))) {
    const incoming = incomingByTarget.get(join.id) || [];
    const directOutcomeEdges = incoming.filter((edge) => edge.type === 'TRUE' || edge.type === 'FALSE');
    const directOutcomeSource = directOutcomeEdges.length === 2
      && directOutcomeEdges.some((edge) => edge.type === 'TRUE')
      && directOutcomeEdges.some((edge) => edge.type === 'FALSE')
      && directOutcomeEdges[0].start === directOutcomeEdges[1].start
      ? nodes.find((candidate) => candidate.id === directOutcomeEdges[0].start && isBranchNode(candidate))
      : undefined;
    const incomingSources = new Set(incoming
      .filter((edge) => edge.type === 'XOR_JOIN')
      .map((edge) => edge.start));
    if (!directOutcomeSource && incomingSources.size < 2) continue;
    const branch = directOutcomeSource || nodes.find((candidate) => {
      if (!isBranchNode(candidate)) return false;
      const outcomes = (outgoingBySource.get(candidate.id) || [])
        .filter((edge) => edge.type === 'TRUE' || edge.type === 'FALSE');
      return outcomes.some((edge) => edge.type === 'TRUE' && incomingSources.has(edge.end))
        && outcomes.some((edge) => edge.type === 'FALSE' && incomingSources.has(edge.end));
    });
    const branchBox = nodeBoxes.get(branch?.id);
    const joinBox = nodeBoxes.get(join.id);
    if (!branchBox || !joinBox) continue;
    const nextX = directOutcomeSource
      ? Math.round(branchBox.x + branchBox.width + 36)
      : joinBox.x;
    const nextY = Math.round(branchBox.y + (branchBox.height - joinBox.height) / 2);
    if (joinBox.x === nextX && joinBox.y === nextY) continue;
    joinBox.x = nextX;
    joinBox.y = nextY;
    moved += 1;
  }
  return moved;
}

export function makeDrawio(nodes, edges, options = {}) {
  const methodChainOwnerIds = new Set(nodes
    .filter((node) => methodChainRole(node) === 'continuation')
    .map((node) => methodChainOwnerStableId(node))
    .filter(Boolean));
  nodes = nodes.map((node) => {
    const side = splitCallBoundarySide(node);
    const flattenCallBoundaryRight = side === 'end' && methodChainOwnerIds.has(node.id);
    const alreadyFlattened = node.props?.flattenCallBoundaryRight === true;
    if (
      (!side || node.props?.splitCallBoundary === side)
      && alreadyFlattened === flattenCallBoundaryRight
    ) return node;
    return {
      ...node,
      props: {
        ...node.props,
        ...(side ? { splitCallBoundary: side } : {}),
        ...(flattenCallBoundaryRight ? { flattenCallBoundaryRight: true } : {}),
      },
    };
  });
  edges = suppressRedundantSlotLabels(nodes, edges);
  const suppressFoldingContainers = options.suppressFoldingContainers === true;
  const disableFoldingMechanics = options.disableFoldingMechanics === true;
  const serializeUnifiedEdges = options.serializeUnifiedEdges === true;
  const diagramId = xml(String(options.diagramId || 'function-diagram'));
  const diagramName = xml(String(options.diagramName || 'Function'));
  const positions = derivePositions(nodes, edges);
  const effectiveBridgeIds = collectEffectiveBridgeIds(nodes, edges);
  const cellIds = new Map();
  const visibleNodes = nodes.filter((node) => !isLayoutJunctionNode(node) && !isRenderHiddenNode(node) && !effectiveBridgeIds.has(node.id));
  const visibleNodeById = new Map();
  for (const node of visibleNodes) {
    visibleNodeById.set(node.id, node);
    const stableId = String(node.props?.stableId || node.props?.stable_id || '');
    if (stableId) visibleNodeById.set(stableId, node);
  }
  visibleNodes.forEach((node, index) => cellIds.set(node.id, `n${index + 1}`));

  const scaleX = 260;
  const scaleY = 130;
  const originX = 620;
  const originY = 120;
  const bounds = [];
  const nodeBoxes = new Map();

  for (const node of visibleNodes) {
    const label = labelForNode(node);
    const size = sizeForNode(node, label);
    const position = positions.get(node.id) || { x: 0, y: 0, source: 'missing' };
    const containerOverlay = structuredContainerOverlaySize(node);
    const visualAxisOffsetX = containerOverlay
      ? size.width / 2 - (containerOverlay.containerX + containerOverlay.containerWidth / 2)
      : 0;
    const x = originX
      + position.x * scaleX
      - size.width / 2
      + visualAxisOffsetX
      + Number(node.props.displayOffsetX || 0)
      + objectMethodForegroundOffsetX(node)
      + submethodVisualAnchorOffsetX(node, visibleNodeById, positions, scaleX);
    const y = originY
      + position.y * scaleY
      - size.height / 2
      + Number(node.props.displayOffsetY || 0)
      + submethodVisualAnchorOffsetY(node, visibleNodeById, positions, scaleY);
    const roundedBox = {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(size.width),
      height: Math.round(size.height),
    };
    nodeBoxes.set(node.id, roundedBox);
    bounds.push(roundedBox);
  }
  positionExtractedSubstepColumns(visibleNodes, edges, nodeBoxes);
  positionIterationShiftCollections(visibleNodes, edges, nodeBoxes);
  let obstacleLayout = buildFoldingRows(
    visibleNodes,
    positions,
    nodeBoxes,
    edges,
    options.semanticNodes || [],
  );
  const initialHorizontalCompaction = compactHorizontalStepColumns(
    obstacleLayout,
    positions,
    nodeBoxes,
    edges,
    { predicateFrames: 'exclude' },
  );
  if (initialHorizontalCompaction.moved) {
    obstacleLayout = buildFoldingRows(
      visibleNodes,
      positions,
      nodeBoxes,
      edges,
      options.semanticNodes || [],
    );
  }
  if (separateRenderedNodesWithinSteps(obstacleLayout, nodeBoxes)) {
    obstacleLayout = buildFoldingRows(
      visibleNodes,
      positions,
      nodeBoxes,
      edges,
      options.semanticNodes || [],
    );
  }
  if (
    alignPredicateCallMosaics(visibleNodes, nodeBoxes, edges)
    + alignPredicateExpressionMosaics(visibleNodes, nodeBoxes)
  ) {
    obstacleLayout = buildFoldingRows(
      visibleNodes,
      positions,
      nodeBoxes,
      edges,
      options.semanticNodes || [],
    );
  }
  // Predicate columns are placed only after their mosaics have acquired final
  // visual bounds. The remaining family alignments consume these positions.
  const horizontalCompaction = compactHorizontalStepColumns(
    obstacleLayout,
    positions,
    nodeBoxes,
    edges,
    { predicateFrames: 'only' },
  );
  if (horizontalCompaction.moved) {
    obstacleLayout = buildFoldingRows(
      visibleNodes,
      positions,
      nodeBoxes,
      edges,
      options.semanticNodes || [],
    );
  }
  if (
    alignNestedArithmeticMosaics(visibleNodes, edges, nodeBoxes)
    + alignContainerProducerMosaics(visibleNodes, edges, nodeBoxes)
    + alignNestedSubmethodRows(visibleNodes, edges, nodeBoxes)
    + alignHorizontalDataJoins(visibleNodes, edges, nodeBoxes)
    + alignExpandedObjectFamilies(visibleNodes, edges, nodeBoxes)
    + alignObjectBraceFamilies(visibleNodes, edges, nodeBoxes)
    + alignCallClosuresToOpenings(
      visibleNodes,
      nodeBoxes,
      edges,
      2 * portStubGap({ scaleX, scaleY }),
    )
    + packObjectFamilyContinuations(visibleNodes, edges, nodeBoxes, positions)
    + alignExtractedSubstepRows(visibleNodes, nodeBoxes)
    + alignHorizontalArgumentFamilies(visibleNodes, edges, nodeBoxes)
    + alignMethodChainMosaics(visibleNodes, nodeBoxes)
    + alignDataBranchResultTargetsToFalseGrade(visibleNodes, edges, nodeBoxes)
  ) {
    obstacleLayout = buildFoldingRows(
      visibleNodes,
      positions,
      nodeBoxes,
      edges,
      options.semanticNodes || [],
    );
  }
  if (alignSingleStepHeadFamily(obstacleLayout, nodeBoxes, edges, options.semanticNodes || [])) {
    obstacleLayout = buildFoldingRows(
      visibleNodes,
      positions,
      nodeBoxes,
      edges,
      options.semanticNodes || [],
    );
  }
  shiftStepContentsInsideVisualBoundary(obstacleLayout, nodeBoxes);
  assignStepAndFlowBlockColumns(
    visibleNodes,
    edges,
    options.semanticNodes || [],
    nodeBoxes,
    FLOW_BLOCK_SIDE_COLUMN_INSET,
  );
  positionForOfIterationColumns(visibleNodes, edges, nodeBoxes);
  alignForInitializationRows(visibleNodes, edges, nodeBoxes, options.semanticNodes || []);
  alignInlineFlowJoins(
    visibleNodes,
    edges,
    nodeBoxes,
    portStubGap({ scaleX, scaleY }),
  );
  // General Step/FlowBlock placement may move individual call members. Restore
  // the complete extracted call mosaic last, including chained methods after
  // the closing boundary.
  alignPredicateCallMosaics(visibleNodes, nodeBoxes, edges);
  alignCallClosuresToOpenings(
    visibleNodes,
    nodeBoxes,
    edges,
    2 * portStubGap({ scaleX, scaleY }),
  );
  alignMethodChainMosaics(visibleNodes, nodeBoxes);
  obstacleLayout = buildFoldingRows(
    visibleNodes,
    positions,
    nodeBoxes,
    edges,
    options.semanticNodes || [],
  );
  const layoutEdges = routeObjectBraceFieldEndpoints(
    visibleNodes,
    rerouteLateralExpressionMosaicEdges(visibleNodes, edges),
  );
  classifyStepVisibility(visibleNodes, layoutEdges);
  const foldingLayout = buildFoldingRows(
    visibleNodes,
    positions,
    nodeBoxes,
    layoutEdges,
    options.semanticNodes || [],
  );
  const foldGroupByNodeId = new Map(
    [...foldingLayout.rowByNodeId.entries()].map(([nodeId, row]) => [nodeId, row.key]),
  );
  // Routing has one coordinate space: the final absolute geometry after all
  // Step and FlowBlock folding containers have been laid out.
  const routingNodeBoxes = new Map(
    [...nodeBoxes.entries()].map(([nodeId, box]) => [
      nodeId,
      suppressFoldingContainers ? { ...box } : effectiveFoldedRoutingBox(nodeId, box, foldingLayout),
    ]),
  );
  const renderEdges = buildRenderableEdges(
    reroutePushMosaicEntryEdges(visibleNodes, layoutEdges),
    nodes,
    positions,
    {
      scaleX,
      scaleY,
      originX,
      originY,
      nodeBoxes: routingNodeBoxes,
      effectiveNodeBoxes: routingNodeBoxes,
      effectiveBridgeIds,
      foldGroupByNodeId,
      foldRowByNodeId: foldingLayout.rowByNodeId,
    },
  );
  if (Array.isArray(options.autoChecks)) {
    if (!suppressFoldingContainers) {
      options.autoChecks.push(foldingContainerGeometryCheck(foldingLayout, nodeBoxes));
      options.autoChecks.push(emptyVerticalSpanCheck(foldingLayout, nodeBoxes));
      options.autoChecks.push(layoutFamilyStepCheck(foldingLayout));
    }
    options.autoChecks.push(nestedArithmeticMosaicCheck(visibleNodes, layoutEdges, nodeBoxes));
    options.autoChecks.push(producerChainRoutingCheck(visibleNodes, renderEdges, routingNodeBoxes, foldingLayout));
    options.autoChecks.push(producerReturnStepContainmentCheck(foldingLayout, renderEdges));
    options.autoChecks.push(iterationRepeatStepContainmentCheck(foldingLayout, renderEdges));
    options.autoChecks.push(iterationRepeatNodeIntersectionCheck(foldingLayout, renderEdges, routingNodeBoxes));
    options.autoChecks.push(iterationRepeatObjectFamilyIntersectionCheck(
      visibleNodes,
      layoutEdges,
      renderEdges,
      routingNodeBoxes,
    ));
    options.autoChecks.push(iterationRepeatObjectFieldCorridorCheck(renderEdges, routingNodeBoxes));
  }
  const sourceStableIdByCallSite = callSourceStableIds(visibleNodes);
  const nodeCells = [];
  const foldingCells = [];
  if (!suppressFoldingContainers) {
    const extractedStepIds = new Set((options.semanticNodes || [])
      .filter((node) => (node.labels || []).includes('Step'))
      .map((node) => node.key));
    foldingCells.push(
      `<mxCell id="${foldingLayout.id}" value="" style="group;html=1;container=1;collapsible=0;" vertex="1" parent="1"><mxGeometry x="${foldingLayout.x}" y="${foldingLayout.y}" width="${foldingLayout.width}" height="${foldingLayout.height}" as="geometry" /></mxCell>`,
    );
    [...foldingLayout.blocks]
      .sort((left, right) => left.depth - right.depth || left.globalY - right.globalY)
      .forEach((block) => {
        const parent = renderedFlowBlockParent(block);
        const parentId = parent?.id || foldingLayout.id;
        const parentGlobalX = parent?.globalX ?? foldingLayout.x;
        const parentGlobalY = parent?.globalY ?? 0;
        const metadata = flowBlockMetadata(block);
        const blockStyle = disableFoldingMechanics
          ? 'shape=coldKodeFoldingFrame;html=1;container=1;collapsible=0;flowBlock=1;recursiveResize=0;rounded=0;fillColor=none;strokeColor=#878787;strokeWidth=1.5;'
          : 'shape=coldKodeFoldingFrame;html=1;container=1;collapsible=1;foldingRow=1;flowBlock=1;foldingIconSize=28;foldingIconInset=14;foldingIconTopInset=0;recursiveResize=0;rounded=0;fillColor=none;strokeColor=#878787;strokeWidth=1.5;';
        const alternateBounds = disableFoldingMechanics
          ? ''
          : `<mxRectangle x="${block.globalX - parentGlobalX}" y="${block.globalY - parentGlobalY}" width="${block.width}" height="${FOLDING_ROW_COLLAPSED_HEIGHT}" as="alternateBounds" />`;
        foldingCells.push(
          `<mxCell id="${block.id}" value="" style="${blockStyle}" parent="${parentId}" vertex="1" ${metadata}><mxGeometry x="${block.globalX - parentGlobalX}" y="${block.globalY - parentGlobalY}" width="${block.width}" height="${block.height}" as="geometry">${alternateBounds}</mxGeometry></mxCell>`,
        );
      });
    foldingLayout.rows.forEach((row) => {
      const extractedStep = extractedStepIds.has(row.key);
      const metadata = foldingContainerMetadata(
        row,
        renderEdges,
        options.semanticNodes || [],
      );
      const parent = row.flowBlock || null;
      const parentId = parent?.id || foldingLayout.id;
      const parentGlobalX = parent?.globalX ?? foldingLayout.x;
      const parentGlobalY = parent?.globalY ?? 0;
      const localX = row.globalX - parentGlobalX;
      const localY = row.y - parentGlobalY;
      foldingCells.push(extractedStep
        ? `<mxCell id="${row.id}" value="" style="group;html=1;container=1;collapsible=0;" parent="${parentId}" vertex="1" runtimeStepStableId="${xml(row.key)}"><mxGeometry x="${localX}" y="${localY}" width="${row.width}" height="${row.height}" as="geometry" /></mxCell>`
        : `<mxCell id="${row.id}" value="" style="group;html=1;container=1;collapsible=0;recursiveResize=0;" parent="${parentId}" vertex="1" ${metadata}><mxGeometry x="${localX}" y="${localY}" width="${row.width}" height="${row.height}" as="geometry" /></mxCell>`,
      );
    });
  }

  for (const node of visibleNodes) {
    const callMosaicRole = node.props?.callMosaicRole || node.props?.call_mosaic_role || '';
    const callMosaicOwnerId = node.props?.callMosaicOwnerStableId
      || node.props?.call_mosaic_owner_stable_id
      || '';
    const callMosaicOwner = callMosaicOwnerId ? visibleNodeById.get(callMosaicOwnerId) : null;
    const styleNode = callMosaicRole === 'close' && hasLabel(callMosaicOwner, 'Virtual')
      ? { ...node, labels: [...new Set([...(node.labels || []), 'Virtual'])] }
      : node;
    const label = labelForNode(node);
    const position = positions.get(node.id) || { x: 0, y: 0, source: 'missing' };
    const roundedBox = nodeBoxes.get(node.id);
    const row = foldingLayout.rowByNodeId.get(node.id);
    const detachedFlowJoin = foldingLayout.detachedFlowJoinByNodeId?.get(node.id);
    const detachedParent = detachedFlowJoin?.owner || null;
    const localBox = suppressFoldingContainers
      ? { ...roundedBox }
      : detachedFlowJoin
        ? {
            x: detachedFlowJoin.globalX - (detachedParent?.globalX ?? foldingLayout.x),
            y: detachedFlowJoin.globalY - (detachedParent?.globalY ?? 0),
            width: detachedFlowJoin.width,
            height: detachedFlowJoin.height,
          }
      : {
          x: roundedBox.x - row.globalX,
          y: FOLDING_ROW_TOP_PADDING + roundedBox.y - row.contentMinY,
          width: roundedBox.width,
          height: roundedBox.height,
        };
    const nodeParentId = suppressFoldingContainers
      ? '1'
      : detachedFlowJoin
        ? detachedParent?.id || foldingLayout.id
        : row.id;
    const layoutTrace = [
      'Layout trace:',
      `source: ${position.source}`,
      `graph x/y: ${position.x}, ${position.y}`,
      `drawio x/y: ${roundedBox.x}, ${roundedBox.y}`,
      `labels: ${node.labels.join(', ')}`,
      node.props.canonicalStableId ? `canonicalStableId: ${node.props.canonicalStableId}` : '',
      node.props.sourceCallStableId ? `sourceCallStableId: ${node.props.sourceCallStableId}` : '',
      node.props.visualCopyIndex && node.props.visualCopyCount ? `visualCopy: ${node.props.visualCopyIndex}/${node.props.visualCopyCount}` : '',
      node.props.layoutTrace ? `Coordinator trace:\n${node.props.layoutTrace}` : '',
    ].filter(Boolean).join('\n');
    const stableId = node.id;
    const locationStableId = locationStableIdForNode(node);
    const sourceStableId = sourceStableIdCandidate(node)
      || sourceStableIdByCallSite.get(node.id)
      || '';
    const functionStableId = functionStableIdForNode(node);
    const objectMethodMetadata = objectMethodVisual(node);
    const objectMethod = node.props?.splitCallBoundary === 'end' ? null : objectMethodMetadata;
    const sourceLookup = (
      !sourceStableId
      && locationStableId
      && (
        objectMethodMetadata
        || hasLabel(node, 'Method')
        || hasLabel(node, 'Collection')
        || hasLabel(node, 'ValueAccess')
      )
    ) ? 'definition' : '';
    const sourceSymbol = sourceLookup === 'definition'
      ? objectMethodMetadata?.methods?.at(-1)?.name
        || String(node.props?.operation_callee_text || '').split('.').at(-1)
        || String(label || '').replace(/\([^]*$/u, '').trim()
        || ''
      : '';
    const cellId = cellIds.get(node.id);
    const flowLayer = flowLayerForGraphItem(node, 'control');
    const ownerStepStableId = ownerStepStableIdForGraphItem(node);
    const stepVisibility = stepVisibilityForGraphItem(node);
    const flowLayerMetadata = `flowLayer="${xml(flowLayer)}" stepVisibility="${xml(stepVisibility)}" ownerStepStableId="${xml(ownerStepStableId)}"`;
    const link = `codex-graph://item?kind=node&stableId=${encodeURIComponent(stableId)}&locationStableId=${encodeURIComponent(locationStableId)}&sourceStableId=${encodeURIComponent(sourceStableId)}&sourceLookup=${encodeURIComponent(sourceLookup)}&sourceSymbol=${encodeURIComponent(sourceSymbol)}&functionStableId=${encodeURIComponent(functionStableId)}&labels=${encodeURIComponent(node.labels.join(','))}&label=${encodeURIComponent(label)}&visualProxyStableId=${encodeURIComponent(isVisualProxyNode(node) ? node.id : '')}&sourceCallStableId=${encodeURIComponent(node.props.sourceCallStableId || '')}&visualCopyIndex=${encodeURIComponent(node.props.visualCopyIndex || '')}&visualCopyCount=${encodeURIComponent(node.props.visualCopyCount || '')}`;
    const mosaicOwners = mosaicOwnerStableIds(node, new Map(visibleNodes.map((candidate) => [candidate.id, candidate])));
    const metadata = `stableId="${xml(stableId)}" locationStableId="${xml(locationStableId)}" sourceStableId="${xml(sourceStableId)}" sourceLookup="${xml(sourceLookup)}" sourceSymbol="${xml(sourceSymbol)}" functionStableId="${xml(functionStableId)}" visualProxyStableId="${xml(isVisualProxyNode(node) ? node.id : '')}" sourceCallStableId="${xml(node.props.sourceCallStableId || '')}" visualCopyIndex="${xml(node.props.visualCopyIndex || '')}" visualCopyCount="${xml(node.props.visualCopyCount || '')}" graphKind="${xml(isVisualProxyNode(node) ? node.labels[0] : graphKindForNode(node))}" graphLabels="${xml(node.labels.join(','))}" objectFamilyStableId="${xml(node.props?.objectFamilyStableId || node.props?.object_family_stable_id || '')}" objectBraceSide="${xml(node.props?.objectBraceSide || node.props?.object_brace_side || '')}" objectBraceMosaicNeighborStableId="${xml(node.props?.objectBraceMosaicNeighborStableId || node.props?.object_brace_mosaic_neighbor_stable_id || '')}" hybridVisualRole="${xml(node.props?.hybridVisualRole || '')}" protocolRole="${xml(node.props?.protocolRole || '')}" hybridCompositionId="${xml(node.props?.hybridCompositionId || '')}" compositionOwnerStableId="${xml(node.props?.hybridCompositionOwnerStableId || '')}" overlayOwnerStableId="${xml(node.props?.hybridOverlayOwnerStableId || '')}" attachmentOwnerStableId="${xml(node.props?.hybridAttachmentOwnerStableId || '')}" mosaicOwnerStableIds="${xml(mosaicOwners.join(','))}" ${detachedFlowJoin ? 'detachedFlowJoin="1"' : ''} ${flowLayerMetadata} layoutTrace="${xml(layoutTrace)}" link="${xml(link)}"`;
    const structuredHorizontal = structuredHorizontalSize(node);
    const structuredVertical = structuredVerticalSize(node);
    const structuredContainerOverlay = structuredContainerOverlaySize(node);
    if (structuredHorizontal) {
      const totalNaturalWidth = structuredHorizontal.width;
      const scale = localBox.width / totalNaturalWidth;
      let partX = 0;
      const collectionMosaic = node.labels.includes('Collection');
      const partCells = structuredHorizontal.parts.flatMap((part, index) => {
        const width = index === structuredHorizontal.parts.length - 1
          ? localBox.width - partX
          : Math.round(structuredHorizontal.widths[index] * scale);
        const compactCollectionPart = collectionMosaic && index > 0;
        const slotHeight = compactCollectionPart ? Math.min(MOSAIC_TILE_HEIGHT, localBox.height) : localBox.height;
        const height = Math.min(structuredHorizontal.heights[index], slotHeight);
        const slotY = compactCollectionPart
          ? Math.round((localBox.height - slotHeight) / 2)
          : 0;
        const y = slotY + Math.round((slotHeight - height) / 2);
        const id = `${cellId}-part-${index + 1}`;
        const cells = [`<mxCell id="${xml(id)}" value="${xml(part.text || '')}" style="${xml(structuredRenderPartStyle(node, part, index, structuredHorizontal.parts.length, width))}" vertex="1" connectable="0" parent="${xml(cellId)}" ${metadata}><mxGeometry x="${partX}" y="${y}" width="${width}" height="${height}" as="geometry" /></mxCell>`];
        partX += width;
        return cells;
      });
      nodeCells.push(
        `<mxCell id="${xml(cellId)}" value="" style="group;html=1;container=1;collapsible=0;" vertex="1" parent="${nodeParentId}" ${metadata}><mxGeometry x="${localBox.x}" y="${localBox.y}" width="${localBox.width}" height="${localBox.height}" as="geometry" /></mxCell>`,
        ...partCells,
      );
      continue;
    }
    if (structuredContainerOverlay) {
      const scaleX = localBox.width / structuredContainerOverlay.width;
      const scaleY = localBox.height / structuredContainerOverlay.height;
      const containerWidth = Math.round(structuredContainerOverlay.containerWidth * scaleX);
      const containerHeight = Math.round(structuredContainerOverlay.containerHeight * scaleY);
      const containerX = Math.round(structuredContainerOverlay.containerX * scaleX);
      const containerY = Math.round(structuredContainerOverlay.containerY * scaleY);
      const overlayX = Math.round(structuredContainerOverlay.overlayX * scaleX);
      const overlayY = Math.round(structuredContainerOverlay.overlayY * scaleY);
      const overlayWidth = localBox.width - overlayX;
      let partX = overlayX;
      let partY = overlayY;
      const overlayCells = structuredContainerOverlay.overlays.map((part, index) => {
        const width = structuredContainerOverlay.sideBySide
          ? index === structuredContainerOverlay.overlays.length - 1
            ? localBox.width - partX
            : Math.round(structuredContainerOverlay.overlayWidths[index] * scaleX)
          : overlayWidth;
        const slotHeight = structuredContainerOverlay.sideBySide
          ? Math.round(structuredContainerOverlay.overlayRowHeight * scaleY)
          : index === structuredContainerOverlay.overlays.length - 1
          ? localBox.height - partY
          : Math.round(structuredContainerOverlay.overlayHeights[index] * scaleY);
        const height = structuredContainerOverlay.sideBySide
          ? Math.min(mosaicRenderPartHeight(part), slotHeight)
          : slotHeight;
        const y = structuredContainerOverlay.sideBySide
          ? partY + Math.round((slotHeight - height) / 2)
          : partY;
        const cell = `<mxCell id="${xml(cellId)}-part-${index + 2}" value="${xml(part.text || '')}" style="${xml(structuredContainerOverlayPartStyle(
          node,
          part,
          index,
          structuredContainerOverlay.overlays.length,
          structuredContainerOverlay.sideBySide,
          width,
          structuredContainerOverlay.overlays[index + 1],
        ))}" vertex="1" connectable="0" parent="${xml(cellId)}" ${metadata}><mxGeometry x="${partX}" y="${y}" width="${width}" height="${height}" as="geometry" /></mxCell>`;
        if (structuredContainerOverlay.sideBySide) partX += width;
        else partY += height;
        return cell;
      });
      const containerCells = structuredContainerOverlay.collectionContainer
        ? [
            `<mxCell id="${xml(cellId)}-part-1" value="${xml(structuredContainerOverlay.container.text || '')}" style="${xml(structuredContainerPartStyle(node, structuredContainerOverlay.container, containerHeight))}" vertex="1" connectable="0" parent="${xml(cellId)}" ${metadata}><mxGeometry x="${containerX}" y="${containerY}" width="${containerWidth}" height="${containerHeight}" as="geometry" /></mxCell>`,
          ]
        : [
            `<mxCell id="${xml(cellId)}-part-1" value="${xml(structuredContainerOverlay.container.text || '')}" style="${xml(structuredContainerPartStyle(node, structuredContainerOverlay.container, containerHeight))}" vertex="1" connectable="0" parent="${xml(cellId)}" ${metadata}><mxGeometry x="${containerX}" y="${containerY}" width="${containerWidth}" height="${containerHeight}" as="geometry" /></mxCell>`,
          ];
      const predicateOverlayCell = node.labels.includes('Branch') && structuredContainerOverlay.sideBySide
        ? [`<mxCell id="${xml(cellId)}-predicate-overlay" value="" style="shape=hexagon;perimeter=hexagonPerimeter2;${FIXED_HEX_STYLE}fillOpacity=0;strokeOpacity=0;html=1;" vertex="1" connectable="1" parent="${xml(cellId)}" ${metadata}><mxGeometry x="${overlayX}" y="${overlayY}" width="${overlayWidth}" height="${Math.round(structuredContainerOverlay.overlayRowHeight * scaleY)}" as="geometry" /></mxCell>`]
        : [];
      nodeCells.push(
        `<mxCell id="${xml(cellId)}" value="" style="group;html=1;container=1;collapsible=0;" vertex="1" parent="${nodeParentId}" ${metadata}><mxGeometry x="${localBox.x}" y="${localBox.y}" width="${localBox.width}" height="${localBox.height}" as="geometry" /></mxCell>`,
        ...containerCells,
        ...overlayCells,
        ...predicateOverlayCell,
      );
      continue;
    }
    if (structuredVertical) {
      const totalNaturalHeight = structuredVertical.height;
      const scale = localBox.height / totalNaturalHeight;
      let partY = 0;
      const partCells = structuredVertical.parts.map((part, index) => {
        const height = index === structuredVertical.parts.length - 1
          ? localBox.height - partY
          : Math.round(structuredVertical.heights[index] * scale);
        const cell = `<mxCell id="${xml(cellId)}-part-${index + 1}" value="${xml(part.text || '')}" style="${xml(structuredVerticalPartStyle(node, part, index, structuredVertical.parts.length))}" vertex="1" connectable="0" parent="${xml(cellId)}" ${metadata}><mxGeometry x="0" y="${partY}" width="${localBox.width}" height="${height}" as="geometry" /></mxCell>`;
        partY += height;
        return cell;
      });
      nodeCells.push(
        `<mxCell id="${xml(cellId)}" value="" style="group;html=1;container=1;collapsible=0;" vertex="1" parent="${nodeParentId}" ${metadata}><mxGeometry x="${localBox.x}" y="${localBox.y}" width="${localBox.width}" height="${localBox.height}" as="geometry" /></mxCell>`,
        ...partCells,
      );
      continue;
    }
    const renderAsSimpleCallClosure = node.props?.splitCallBoundary === 'end';
    const hybridSimpleNode = node.props?.hybridVisualRole
      && node.props.hybridVisualRole !== 'collection-receiver'
      && (!hasLabel(node, 'Collection') || hasLabel(node, 'Method'))
      && !objectMethod;
    if (renderAsSimpleCallClosure || hybridSimpleNode || (!objectMethod && !hasLabel(node, 'Collection'))) {
      nodeCells.push(
        `<mxCell id="${xml(cellId)}" value="${xml(label)}" style="${xml(styleForNode(styleNode, localBox))}" vertex="1" parent="${nodeParentId}" ${metadata}><mxGeometry x="${localBox.x}" y="${localBox.y}" width="${localBox.width}" height="${localBox.height}" as="geometry" /></mxCell>`,
      );
      continue;
    }

    if (!objectMethod) {
      const stackBoxes = collectionStackBoxes(roundedBox);
      const groupMinX = Math.min(...stackBoxes.map((box) => box.x));
      const groupMinY = Math.min(...stackBoxes.map((box) => box.y));
      const groupMaxX = Math.max(...stackBoxes.map((box) => box.x + box.width));
      const groupMaxY = Math.max(...stackBoxes.map((box) => box.y + box.height));
      const groupId = `${cellId}-collection`;
      const groupLocalX = suppressFoldingContainers ? groupMinX : groupMinX - row.globalX;
      const groupLocalY = suppressFoldingContainers
        ? groupMinY
        : FOLDING_ROW_TOP_PADDING + groupMinY - row.contentMinY;
      const layerCells = stackBoxes.map((box, index) => {
        const front = index === stackBoxes.length - 1;
        const layerId = front ? cellId : `${cellId}-layer-${index + 1}`;
        return `<mxCell id="${xml(layerId)}" value="" style="${xml(collectionLayerStyle(isEmptyContainer(node), isVirtualResultNode(node)))}" vertex="1" parent="${xml(groupId)}" ${metadata}><mxGeometry x="${box.x - groupMinX}" y="${box.y - groupMinY}" width="${box.width}" height="${box.height}" as="geometry" /></mxCell>`;
      });
      nodeCells.push(
        `<mxCell id="${xml(groupId)}" value="" style="group;html=1;container=1;collapsible=0;" vertex="1" parent="${nodeParentId}" ${flowLayerMetadata}><mxGeometry x="${groupLocalX}" y="${groupLocalY}" width="${groupMaxX - groupMinX}" height="${groupMaxY - groupMinY}" as="geometry" /></mxCell>`,
        ...layerCells,
        `<mxCell id="${xml(cellId)}-label" value="${xml(label)}" style="${xml(backingLabelStyle({ collection: true }))}" vertex="1" connectable="0" parent="${xml(groupId)}" ${metadata}><mxGeometry x="${roundedBox.x - groupMinX}" y="${roundedBox.y - groupMinY}" width="${roundedBox.width}" height="${roundedBox.height}" as="geometry" /></mxCell>`,
      );
      continue;
    }

    const { receiverBox, methodBoxes } = objectMethodLayerBoxes(
      roundedBox,
      objectMethod,
      hasLabel(node, 'Collection'),
    );
    const receiverStackBoxes = hasLabel(node, 'Collection') ? collectionStackBoxes(receiverBox) : [receiverBox];
    const layerBoxes = [...receiverStackBoxes, ...methodBoxes, roundedBox];
    const groupMinX = Math.min(...layerBoxes.map((box) => box.x));
    const groupMinY = Math.min(...layerBoxes.map((box) => box.y));
    const groupMaxX = Math.max(...layerBoxes.map((box) => box.x + box.width));
    const groupMaxY = Math.max(...layerBoxes.map((box) => box.y + box.height));
    const groupGlobal = {
      x: groupMinX,
      y: groupMinY,
      width: groupMaxX - groupMinX,
      height: groupMaxY - groupMinY,
    };
    const groupId = `${cellId}-object-method`;
    const groupLocalX = suppressFoldingContainers ? groupGlobal.x : groupGlobal.x - row.globalX;
    const groupLocalY = suppressFoldingContainers
      ? groupGlobal.y
      : FOLDING_ROW_TOP_PADDING + groupGlobal.y - row.contentMinY;
    const receiverSourceStableId = objectMethod.receiverSourceStableId
      || valueSourceStableIdCandidate(node);
    const receiverLocationStableId = objectMethod.receiverStableId
      || expressionComponentStableId(
        node,
        objectMethod.receiverStart,
        objectMethod.receiverEnd,
      );
    const receiverSourceLookup = receiverSourceStableId ? '' : 'definition';
    const receiverSourceSymbol = String(objectMethod.receiver || '').split('.').at(-1);
    const receiverLabels = objectMethod.receiverLabels?.length
      ? objectMethod.receiverLabels.join(',')
      : hasLabel(node, 'Collection') ? 'Collection,ValueAccess' : 'ValueAccess';
    const receiverLink = `codex-graph://item?kind=node&stableId=${encodeURIComponent(receiverLocationStableId)}&locationStableId=${encodeURIComponent(receiverLocationStableId)}&sourceStableId=${encodeURIComponent(receiverSourceStableId)}&sourceLookup=${encodeURIComponent(receiverSourceLookup)}&sourceSymbol=${encodeURIComponent(receiverSourceSymbol)}&labels=${encodeURIComponent(receiverLabels)}&label=${encodeURIComponent(objectMethod.receiver)}`;
    const receiverMetadata = `stableId="${xml(receiverLocationStableId)}" locationStableId="${xml(receiverLocationStableId)}" sourceStableId="${xml(receiverSourceStableId)}" sourceLookup="${xml(receiverSourceLookup)}" sourceSymbol="${xml(receiverSourceSymbol)}" graphKind="${xml(hasLabel(node, 'Collection') ? 'Collection' : 'ValueAccess')}" graphLabels="${xml(receiverLabels)}" ${flowLayerMetadata} link="${xml(receiverLink)}"`;
    const receiverLayerCells = receiverStackBoxes.map((box, index) => {
      const front = index === receiverStackBoxes.length - 1;
      const receiverId = front ? `${cellId}-receiver` : `${cellId}-receiver-layer-${index + 1}`;
      return `<mxCell id="${xml(receiverId)}" value="" style="${xml(hasLabel(node, 'Collection') ? collectionLayerStyle(isEmptyContainer(node), isVirtualResultNode(node)) : objectMethodReceiverStyle(objectMethod))}" vertex="1" connectable="0" parent="${xml(groupId)}" ${receiverMetadata}><mxGeometry x="${box.x - groupGlobal.x}" y="${box.y - groupGlobal.y}" width="${box.width}" height="${box.height}" as="geometry" /></mxCell>`;
    });
    const methodLayerCell = (box, index) => {
      const methodLocationStableId = box.methodStableId
        || expressionComponentStableId(node, box.nameStart, box.nameEnd);
      const methodSourceStableId = box.methodSourceStableId || '';
      const methodSourceLookup = methodSourceStableId ? '' : 'definition';
      const methodLink = `codex-graph://item?kind=node&stableId=${encodeURIComponent(methodLocationStableId)}&locationStableId=${encodeURIComponent(methodLocationStableId)}&sourceStableId=${encodeURIComponent(methodSourceStableId)}&sourceLookup=${encodeURIComponent(methodSourceLookup)}&sourceSymbol=${encodeURIComponent(box.name)}&labels=${encodeURIComponent('Op,Method,VisualComponent')}&label=${encodeURIComponent(box.label)}`;
      const methodMetadata = `stableId="${xml(methodLocationStableId)}" locationStableId="${xml(methodLocationStableId)}" sourceStableId="${xml(methodSourceStableId)}" sourceLookup="${xml(methodSourceLookup)}" sourceSymbol="${xml(box.name)}" graphKind="Method" graphLabels="Op,Method,VisualComponent" ${flowLayerMetadata} link="${xml(methodLink)}"`;
      return `<mxCell id="${xml(cellId)}-method-${index + 1}" value="${xml(box.label)}" style="${xml(objectMethodLayerStyle(node))}" vertex="1" connectable="0" parent="${xml(groupId)}" ${methodMetadata}><mxGeometry x="${box.x - groupGlobal.x}" y="${box.y - groupGlobal.y}" width="${box.width}" height="${box.height}" as="geometry" /></mxCell>`;
    };
    nodeCells.push(
      `<mxCell id="${xml(groupId)}" value="" style="group;html=1;container=1;collapsible=0;" vertex="1" parent="${nodeParentId}" ${flowLayerMetadata}><mxGeometry x="${groupLocalX}" y="${groupLocalY}" width="${groupGlobal.width}" height="${groupGlobal.height}" as="geometry" /></mxCell>`,
      ...receiverLayerCells,
      `<mxCell id="${xml(cellId)}-receiver-label" value="${xml(objectMethod.receiver)}" style="${xml(backingLabelStyle({ collection: hasLabel(node, 'Collection') }))}" vertex="1" connectable="0" parent="${xml(groupId)}" ${receiverMetadata}><mxGeometry x="${receiverBox.x - groupGlobal.x}" y="${receiverBox.y - groupGlobal.y}" width="${receiverBox.width}" height="${receiverBox.height}" as="geometry" /></mxCell>`,
      ...methodBoxes.map(methodLayerCell),
      `<mxCell id="${xml(cellId)}" value="${xml(label)}" style="${xml(`${styleForNode(node, roundedBox)}part=1;`)}" vertex="1" parent="${xml(groupId)}" ${metadata}><mxGeometry x="${roundedBox.x - groupGlobal.x}" y="${roundedBox.y - groupGlobal.y}" width="${roundedBox.width}" height="${roundedBox.height}" as="geometry" /></mxCell>`,
    );
  }

  const edgeCells = [];
  renderEdges.forEach((edge, index) => {
    const sourceCellId = cellIds.get(edge.start);
    const targetCellId = cellIds.get(edge.end);
    const source = structuredHorizontalEndpointCell(
      visibleNodeById.get(edge.start),
      containerOverlayEndpointCell(
      visibleNodeById.get(edge.start),
      sourceCellId,
      edge,
      'source',
      ),
      edge,
      'source',
    );
    const target = structuredHorizontalEndpointCell(
      visibleNodeById.get(edge.end),
      containerOverlayEndpointCell(
      visibleNodeById.get(edge.end),
      targetCellId,
      edge,
      'target',
      ),
      edge,
      'target',
    );
    if (!source || !target) return;
    const label = labelForEdge(edge);
    const slotLabel = slotNameForEdge(edge);
    const slotLabelAtSource = slotLabel && slotNodeEnd(edge) === 'source';
    const metadata = edgeMetadata(edge, edge.type);
    const sourceRow = foldingLayout.rowByNodeId.get(edge.start);
    const targetRow = foldingLayout.rowByNodeId.get(edge.end);
    if (suppressFoldingContainers || serializeUnifiedEdges) {
      edgeCells.push(
        `<mxCell id="e${index + 1}" value="${xml(label)}" style="${xml(styleForEdge(edge))}" edge="1" parent="1" source="${xml(source)}" target="${xml(target)}" ${metadata}>${edgeGeometry(edge, (point) => point)}</mxCell>`,
      );
      return;
    }
    const sourceDetached = foldingLayout.detachedFlowJoinByNodeId?.has(edge.start);
    const targetDetached = foldingLayout.detachedFlowJoinByNodeId?.has(edge.end);
    if (sourceDetached || targetDetached) {
      edgeCells.push(
        `<mxCell id="e${index + 1}" value="${xml(label)}" style="${xml(styleForEdge(edge))}" edge="1" parent="1" source="${xml(source)}" target="${xml(target)}" ${metadata}>${edgeGeometry(edge)}</mxCell>`,
      );
      return;
    }
    if (!sourceRow || !targetRow) return;
    if (sourceRow === targetRow) {
      const toRowLocalPoint = (point) => ({
        x: point.x - sourceRow.globalX,
        y: point.y - foldingLayout.y - sourceRow.y,
      });
      edgeCells.push(
        `<mxCell id="e${index + 1}" value="${xml(label)}" style="${xml(styleForEdge(edge))}" edge="1" parent="${sourceRow.id}" source="${xml(source)}" target="${xml(target)}" ${metadata}>${edgeGeometry(edge, toRowLocalPoint)}</mxCell>`,
      );
      return;
    }

    const rawSourceBox = routingNodeBoxes.get(edge.start);
    const rawTargetBox = routingNodeBoxes.get(edge.end);
    const sourceNode = visibleNodeById.get(edge.start);
    const targetNode = visibleNodeById.get(edge.end);
    const sourceHorizontalPartBox = isFlowBranchNode(sourceNode)
      && (edge.type === 'TRUE' || edge.type === 'FALSE')
      ? null
      : structuredHorizontalEndpointPartBox(sourceNode, rawSourceBox, edge, 'source');
    const targetHorizontalPartBox = structuredHorizontalEndpointPartBox(targetNode, rawTargetBox, edge, 'target');
    const sourceEndpointPart = containerOverlayEndpointPart(sourceNode, edge, 'source');
    const targetEndpointPart = containerOverlayEndpointPart(targetNode, edge, 'target');
    const sourceBox = sourceHorizontalPartBox || (sourceEndpointPart
      ? structuredContainerOverlayPartBox(sourceNode, rawSourceBox, sourceEndpointPart)
      : rawSourceBox);
    const targetBox = targetHorizontalPartBox || (targetEndpointPart
      ? structuredContainerOverlayPartBox(targetNode, rawTargetBox, targetEndpointPart)
      : rawTargetBox);
    const sourceLanding = portPoint(sourceBox, edge.props?.sourcePort) || boxCenter(sourceBox);
    const targetLanding = portPoint(targetBox, edge.props?.targetPort) || boxCenter(targetBox);
    if (edge.type === 'REJOINS') {
      edgeCells.push(
        `<mxCell id="e${index + 1}" value="${xml(label)}" style="${xml(styleForEdge(edge))}" edge="1" parent="1" source="${xml(source)}" target="${xml(target)}" ${metadata}>${edgeGeometry(edge)}</mxCell>`,
      );
      return;
    }
    const boundaryInset = 12;
    const sharedLeft = Math.max(
      sourceRow.globalX + boundaryInset,
      targetRow.globalX + boundaryInset,
    );
    const sharedRight = Math.min(
      sourceRow.globalX + sourceRow.width - boundaryInset,
      targetRow.globalX + targetRow.width - boundaryInset,
    );
    if (sharedLeft > sharedRight) {
      edgeCells.push(
        `<mxCell id="e${index + 1}" value="${xml(label)}" style="${xml(styleForEdge(edge))}" edge="1" parent="1" source="${xml(source)}" target="${xml(target)}" ${metadata}><mxGeometry relative="1" as="geometry" /></mxCell>`,
      );
      return;
    }
    const sourceGraphPosition = positions.get(edge.start);
    const targetGraphPosition = positions.get(edge.end);
    const sameGraphColumn = Number.isFinite(sourceGraphPosition?.x)
      && Number.isFinite(targetGraphPosition?.x)
      && Math.abs(sourceGraphPosition.x - targetGraphPosition.x) < 1e-9;
    const preferredBoundaryX = sameGraphColumn ? sourceLanding.x : targetLanding.x;
    const boundaryX = Math.max(sharedLeft, Math.min(sharedRight, preferredBoundaryX));
    const alignCentralTopPortToBoundary = sameGraphColumn
      && portSide(edge.props?.targetPort) === 'top'
      && targetLanding.x > boundaryX + 1;
    const boundaryTargetPortRatio = targetBox?.width > 0
      ? Math.max(0, Math.min(1, (boundaryX - targetBox.x) / targetBox.width))
      : 0.5;
    const foldedTargetPort = alignCentralTopPortToBoundary
      ? `top-${Math.round(boundaryTargetPortRatio * 100)}`
      : edge.props?.targetPort;
    const foldedTargetLanding = portPoint(targetBox, foldedTargetPort) || targetLanding;
    const straightVerticalBoundary = Math.abs(sourceLanding.x - boundaryX) < 1
      && Math.abs(foldedTargetLanding.x - boundaryX) < 1.5
      && portSide(edge.props?.sourcePort) === 'bottom'
      && portSide(foldedTargetPort) === 'top';
    const straightJettyStyle = straightVerticalBoundary
      ? 'jettySize=0;sourceJettySize=0;targetJettySize=0;'
      : '';
    const sourceRatio = Math.max(0.02, Math.min(0.98, (boundaryX - sourceRow.globalX) / sourceRow.width));
    const targetRatio = Math.max(0.02, Math.min(0.98, (boundaryX - targetRow.globalX) / targetRow.width));
    const downward = sourceRow.y < targetRow.y;
    const sourcePortId = `e${index + 1}-source-port`;
    const targetPortId = `e${index + 1}-target-port`;
    const sourcePortY = downward ? sourceRow.height - 3 : -3;
    const targetPortY = downward ? -3 : targetRow.height - 3;
    const sourceLocalPortX = Math.round(boundaryX - sourceRow.globalX - 3);
    const targetLocalPortX = Math.round(boundaryX - targetRow.globalX - 3);
    edgeCells.push(
      `<mxCell id="${sourcePortId}" value="" style="${foldingPortStyle()}" parent="${sourceRow.id}" vertex="1" connectable="1" ${metadata}><mxGeometry x="${sourceLocalPortX}" y="${sourcePortY}" width="6" height="6" as="geometry" /></mxCell>`,
      `<mxCell id="${targetPortId}" value="" style="${foldingPortStyle()}" parent="${targetRow.id}" vertex="1" connectable="1" ${metadata}><mxGeometry x="${targetLocalPortX}" y="${targetPortY}" width="6" height="6" as="geometry" /></mxCell>`,
      `<mxCell id="e${index + 1}-source" value="${xml(slotLabelAtSource ? slotLabel : slotLabel ? '' : label)}" style="${xml(`${styleForEdge({ ...edge, props: { ...edge.props, targetPort: null } })}endArrow=none;${straightJettyStyle}`)}" edge="1" parent="${sourceRow.id}" source="${xml(source)}" target="${sourcePortId}" ${metadata}><mxGeometry${edgeLabelPosition(edge)} relative="1" as="geometry" /></mxCell>`,
      `<mxCell id="e${index + 1}-boundary" value="" style="${xml(`${foldingExternalEdgeStyle(edge, sourceRatio, targetRatio, downward)}${straightJettyStyle}`)}" edge="1" parent="1" source="${sourceRow.id}" target="${targetRow.id}" ${metadata}><mxGeometry relative="1" as="geometry" /></mxCell>`,
      `<mxCell id="e${index + 1}-target" value="${xml(slotLabelAtSource ? '' : slotLabel)}" style="${xml(`${styleForEdge({ ...edge, props: { ...edge.props, sourcePort: null, targetPort: foldedTargetPort } })}${straightJettyStyle}`)}" edge="1" parent="${targetRow.id}" source="${targetPortId}" target="${xml(target)}" ${metadata}>${slotLabelAtSource ? '<mxGeometry relative="1" as="geometry" />' : edgeGeometry(edge, (point) => ({ x: point.x - targetRow.globalX, y: point.y - foldingLayout.y - targetRow.y }))}</mxCell>`,
    );
  });

  const minCellX = Math.min(...bounds.map((item) => item.x), 0);
  const maxCellX = Math.max(...bounds.map((item) => item.x + item.width), 1600);
  const maxNodeY = Math.max(...bounds.map((item) => item.y + item.height), 1200);
  const maxCellY = suppressFoldingContainers
    ? maxNodeY
    : Math.max(foldingLayout.y + foldingLayout.height, 1200);
  const pageWidth = suppressFoldingContainers
    ? Math.ceil(maxCellX - Math.min(minCellX, 0) + 240)
    : Math.ceil(Math.max(maxCellX, foldingLayout.x + foldingLayout.width) - Math.min(minCellX, foldingLayout.x, 0) + 240);
  const pageHeight = Math.ceil(maxCellY + 240);

  return `<mxfile host="app.diagrams.net" modified="2026-07-18T00:00:00.000Z" agent="Codex" version="24.7.17"><diagram id="${diagramId}" name="${diagramName}"><mxGraphModel dx="1600" dy="1200" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="${suppressFoldingContainers || disableFoldingMechanics ? 0 : 1}" page="1" pageScale="1" pageWidth="${pageWidth}" pageHeight="${pageHeight}" math="0" shadow="0"><root><mxCell id="0" /><mxCell id="1" parent="0" />${foldingCells.join('')}${nodeCells.join('')}${edgeCells.join('')}</root></mxGraphModel></diagram></mxfile>`;
}

function collectEffectiveBridgeIds(nodes, edges) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const bridgeIds = new Set();
  for (const edge of edges) {
    const effectiveTarget = edge.props?.layoutEffectiveTargetStableId;
    const bridgeTarget = edge.props?.targetStableId || edge.end;
    if (!effectiveTarget || !bridgeTarget || effectiveTarget === bridgeTarget) continue;
    const node = nodeById.get(bridgeTarget);
    if (node?.labels?.includes('Merge')) bridgeIds.add(bridgeTarget);
  }
  return bridgeIds;
}

function graphPointToDrawio(position, { scaleX, scaleY, originX, originY }) {
  return {
    x: Math.round(originX + Number(position.x) * scaleX),
    y: Math.round(originY + Number(position.y) * scaleY),
  };
}

export function buildObjectFamilyRouteObstacles(nodes, edges, nodeBoxes) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const incomingByTarget = new Map();
  const outgoingBySource = new Map();
  for (const edge of edges) {
    incomingByTarget.set(edge.end, [...(incomingByTarget.get(edge.end) || []), edge]);
    outgoingBySource.set(edge.start, [...(outgoingBySource.get(edge.start) || []), edge]);
  }
  const headers = nodes.filter((node) => submethodStableIdForLayout(node) === node.id);
  const childHeadersByParent = new Map();
  const membersByHeader = new Map();
  for (const header of headers) {
    const parentId = parentSubmethodStableIdForLayout(header);
    if (parentId) {
      childHeadersByParent.set(parentId, [...(childHeadersByParent.get(parentId) || []), header.id]);
    }
  }
  for (const node of nodes) {
    const ownerId = memberSubmethodStableIdForLayout(node);
    if (ownerId) membersByHeader.set(ownerId, [...(membersByHeader.get(ownerId) || []), node.id]);
  }
  const addSubmethodTree = (headerId, memberIds, seen = new Set()) => {
    if (!headerId || seen.has(headerId) || !nodeById.has(headerId)) return;
    seen.add(headerId);
    memberIds.add(headerId);
    for (const memberId of membersByHeader.get(headerId) || []) memberIds.add(memberId);
    for (const childId of childHeadersByParent.get(headerId) || []) {
      addSubmethodTree(childId, memberIds, seen);
    }
  };
  const familyByBraceId = new Map();
  const memberIdsByFamily = new Map();
  for (const node of nodes) {
    if (!isObjectBraceNode(node)) continue;
    const familyId = String(
      node.props?.objectFamilyStableId
      || node.props?.object_family_stable_id
      || '',
    ).trim();
    if (!familyId) continue;
    familyByBraceId.set(node.id, familyId);
    const memberIds = memberIdsByFamily.get(familyId) || new Set();
    memberIds.add(node.id);
    const mosaicNeighborId = String(
      node.props?.objectBraceMosaicNeighborStableId
      || node.props?.object_brace_mosaic_neighbor_stable_id
      || '',
    ).trim();
    if (mosaicNeighborId) memberIds.add(mosaicNeighborId);
    memberIdsByFamily.set(familyId, memberIds);
  }
  for (const edge of edges) {
    const familyId = edge.type === 'FIELD'
      ? familyByBraceId.get(edge.start)
      : edge.type === 'FieldJoin'
        ? familyByBraceId.get(edge.end)
        : '';
    if (!familyId) continue;
    const memberIds = memberIdsByFamily.get(familyId);
    memberIds.add(edge.start);
    memberIds.add(edge.end);
  }

  for (const memberIds of memberIdsByFamily.values()) {
    const fields = [...memberIds]
      .map((id) => nodeById.get(id))
      .filter((node) => node && hasLabel(node, 'Field') && !isObjectBraceNode(node));
    for (const field of fields) {
      const producerIds = [
        ...(incomingByTarget.get(field.id) || [])
          .filter((edge) => (
            (edge.type === 'ASSIGNS_VALUE' || edge.type === 'YIELDS_VALUE')
            && String(edge.props?.protocolRole || edge.props?.protocol_role || '') === 'assignment-return'
          ))
          .map((edge) => edge.start),
        ...(String(
          field.props?.nestedEvaluationDirection
          || field.props?.nested_evaluation_direction
          || '',
        ) === 'down'
          ? (outgoingBySource.get(field.id) || [])
            .filter((edge) => edge.type === 'EVAL')
            .map((edge) => edge.end)
          : []),
      ];
      for (const producerId of new Set(producerIds)) addSubmethodTree(producerId, memberIds);
    }
  }

  return [...memberIdsByFamily.entries()].flatMap(([familyId, memberIds]) => {
    const boxes = [...memberIds].map((id) => nodeBoxes.get(id)).filter(Boolean);
    if (!boxes.length) return [];
    return [{
      id: `object-family:${familyId}`,
      memberIds,
      left: Math.min(...boxes.map((box) => box.x)),
      right: Math.max(...boxes.map((box) => box.x + box.width)),
      top: Math.min(...boxes.map((box) => box.y)),
      bottom: Math.max(...boxes.map((box) => box.y + box.height)),
    }];
  });
}

function buildRenderableEdges(edges, nodes, positions, scale) {
  const partOwners = new Map();
  for (const node of nodes) {
    const parts = renderPartsForNode(node);
    for (const part of parts) {
      if (part.stableId) partOwners.set(part.stableId,
        partOwners.has(part.stableId) ? null : node.id);
    }
  }
  edges = edges.map((edge) => {
    const partId = edge.props?.sourceRenderPartStableId || edge.props?.source_render_part_stable_id;
    const owner = partOwners.get(partId);
    return owner && owner !== edge.start ? { ...edge, start: owner, props: {
      ...edge.props, stableId: edge.props?.stableId || edge.start,
      layoutEffectiveSourceStableId: owner, lockRoutePoints: true,
    } } : edge;
  });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const routedGroups = new Map();
  const normalEdges = [];
  const effectiveBridgeIds = scale.effectiveBridgeIds || new Set();
  const outgoingBySource = new Map();
  for (const edge of edges) {
    if (edge.props?.renderHidden === true || edge.props?.render_hidden === true) continue;
    if (!outgoingBySource.has(edge.start)) outgoingBySource.set(edge.start, []);
    outgoingBySource.get(edge.start).push(edge);
  }

  function resolveVisibleTarget(id, seen = new Set()) {
    if (!id || !effectiveBridgeIds.has(id) || seen.has(id)) return id;
    seen.add(id);
    const outgoing = (outgoingBySource.get(id) || [])
      .filter((edge) => !isLayoutJunctionNode(nodeById.get(edge.end) || { labels: [] }));
    if (!outgoing.length) return id;
    const next = outgoing.find((edge) => edge.type === 'NEXT') || outgoing[0];
    return resolveVisibleTarget(next.props?.layoutEffectiveTargetStableId || next.end, seen);
  }

  for (const edge of edges) {
    if (edge.props?.renderHidden === true || edge.props?.render_hidden === true) continue;
    if (edge.props?.layoutSegment && edge.props?.stableId && edge.props?.targetStableId) {
      const renderTarget = resolveVisibleTarget(edge.props.layoutEffectiveTargetStableId || edge.props.targetStableId);
      const key = `${edge.props.stableId}->${renderTarget}:${edge.type}`;
      if (!routedGroups.has(key)) {
        routedGroups.set(key, {
          start: edge.props.stableId,
          end: renderTarget,
          type: edge.type,
          props: {
            ...edge.props,
            displayLabel: edge.props?.displayLabel
              ?? edge.props?.display_label
              ?? ((edge.type === 'TRUE' || edge.type === 'FALSE') ? edge.type.toLowerCase() : edge.type),
            sourcePort: null,
            targetPort: null,
          },
          segments: [],
        });
      }
      routedGroups.get(key).segments.push(edge);
    } else {
      if (effectiveBridgeIds.has(edge.start)) continue;
      if (effectiveBridgeIds.has(edge.end) && edge.props?.layoutEffectiveTargetStableId) {
        const renderTarget = resolveVisibleTarget(edge.props.layoutEffectiveTargetStableId);
        normalEdges.push({
          ...edge,
          end: renderTarget,
          props: {
            ...edge.props,
            renderTargetStableId: renderTarget,
          },
        });
      } else {
        normalEdges.push(edge);
      }
    }
  }

  const routedEdges = [];
  const routedCorridors = [];
  const routeState = {
    nodeById,
    edges,
    graphPositions: positions,
    portUsageByNode: new Map(),
    fanoutSourceStubBySource: new Map(),
    objectFamilyObstacles: buildObjectFamilyRouteObstacles(nodes, edges, scale.nodeBoxes),
  };
  for (const group of routedGroups.values()) {
    const ordered = group.segments.sort((left, right) => segmentOrder(left.props.layoutSegment) - segmentOrder(right.props.layoutSegment));
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const groupSourcePosition = positions.get(group.start);
    const groupTargetPosition = positions.get(group.end);
    const groupSourceBox = scale.nodeBoxes.get(group.start);
    const groupTargetBox = scale.nodeBoxes.get(group.end);
    const sourceNode = nodeById.get(group.start);
    const effectiveGroupSourceBox = scale.effectiveNodeBoxes?.get(group.start) || groupSourceBox;
    const effectiveGroupTargetBox = scale.effectiveNodeBoxes?.get(group.end) || groupTargetBox;
    const sourcePort = isFlowBranchNode(sourceNode)
      && (group.type === 'TRUE' || group.type === 'FALSE')
      && Number.isFinite(groupSourcePosition?.x)
      && Number.isFinite(groupTargetPosition?.x)
      && groupTargetPosition.x > groupSourcePosition.x
      ? 'right'
      : first?.props?.sourcePort || null;
    const targetPort = sourceBoxIsAboveTarget(effectiveGroupSourceBox, effectiveGroupTargetBox)
      ? 'top'
      : last?.props?.targetPort || null;
    const waypointIds = [];
    for (const segment of ordered) {
      if (isLayoutJunctionNode(nodeById.get(segment.start) || { labels: [] })) waypointIds.push(segment.start);
      if (isLayoutJunctionNode(nodeById.get(segment.end) || { labels: [] })) waypointIds.push(segment.end);
    }
    const uniqueWaypointIds = [...new Set(waypointIds)];
    const points = uniqueWaypointIds
      .map((id) => {
        const box = scale.nodeBoxes.get(id);
        if (box) return boxCenter(box);
        const position = positions.get(id);
        return position ? graphPointToDrawio(position, scale) : undefined;
      })
      .filter(Boolean);
    const sourceLanding = portPoint(groupSourceBox, sourcePort);
    const targetLanding = portPoint(groupTargetBox, targetPort);
    const [sourceStub, targetStub] = pairedPortStubPoints(
      sourceLanding,
      sourcePort,
      targetLanding,
      targetPort,
      Math.round(scale.scaleX / 2),
      Math.round(scale.scaleY / 2),
    );
    if (sourceStub && !samePoint(sourceStub, points[0])) {
      points.unshift(sourceStub);
    }
    if (targetStub && !samePoint(points[points.length - 1], targetStub)) {
      points.push(targetStub);
    }
    const routedEdge = {
      start: group.start,
      end: group.end,
      type: group.type,
      props: {
        ...group.props,
        sourcePort,
        targetPort,
        explicitPoints: points,
        layoutSegment: 'routed',
      },
    };
    registerRouteCorridors(routedCorridors, removeDuplicateRoutePoints([
      ...(sourceLanding ? [sourceLanding] : []),
      ...points,
      ...(targetLanding ? [targetLanding] : []),
    ]), {
      sourceId: group.start,
      sourcePort,
      targetId: group.end,
      targetPort,
    });
    registerNodePortUsage(routeState.portUsageByNode, group.start, scale.nodeBoxes.get(group.start), sourcePort, 'outgoing');
    registerNodePortUsage(routeState.portUsageByNode, group.end, scale.nodeBoxes.get(group.end), targetPort, 'incoming');
    routedEdges.push(routedEdge);
  }

  const routedKeys = new Set(routedGroups.keys());
  const visibleNormalEdges = normalEdges.filter((edge) => {
    if (isLayoutJunctionNode(nodeById.get(edge.start) || { labels: [] })) return false;
    if (isLayoutJunctionNode(nodeById.get(edge.end) || { labels: [] })) return false;
    if (effectiveBridgeIds.has(edge.start) || effectiveBridgeIds.has(edge.end)) return false;
    const sourceKey = edge.props?.stableId || edge.start;
    const targetKey = resolveVisibleTarget(edge.props?.layoutEffectiveTargetStableId || edge.props?.renderTargetStableId || edge.props?.targetStableId || edge.end);
    return !routedKeys.has(`${sourceKey}->${targetKey}:${edge.type}`);
  });
  const coordinatedNormalEdges = coordinateOptionalReturnGroups(
    uniqueRenderableEdges(visibleNormalEdges),
    scale.nodeBoxes,
  );
  const routedNormalEdges = orderEdgesForRouting(
    coordinatedNormalEdges,
    scale.nodeBoxes,
    nodeById,
  )
    .map((edge, routeIndex) => {
      if (process.env.DEBUG_LOCAL_ROUTE_TRACE === '1') {
        const sourceOperationIndex = nodeById.get(edge.start)?.props?.operationIndex
          ?? nodeById.get(edge.start)?.props?.operation_index;
        console.error(`[route:start] index=${routeIndex} operation=${sourceOperationIndex ?? ''} type=${edge.type} start=${edge.start} end=${edge.end}`);
      }
      const startedAt = Date.now();
      const routed = routeNormalEdge(edge, scale, routedCorridors, routeState);
      const elapsedMs = Date.now() - startedAt;
      if (process.env.DEBUG_LOCAL_ROUTE_TIMING === '1' && elapsedMs >= 100) {
        console.error(`[route:slow] ms=${elapsedMs} type=${edge.type} start=${edge.start} end=${edge.end}`);
      }
      return routed;
    });
  return positionRenderedEdgeLabels(routedNormalEdges.concat(routedEdges), scale);
}

function positionRenderedEdgeLabels(edges, scale) {
  return edges.map((edge) => {
    const slotName = slotNameForEdge(edge);
    const controlOutcomeLabel = (edge.type === 'TRUE' || edge.type === 'FALSE')
      && flowLayerForGraphItem(edge, 'control') === 'control'
      ? labelForEdge(edge)
      : '';
    if (!slotName && !controlOutcomeLabel) return edge;
    const explicitPoints = removeDuplicateRoutePoints(
      Array.isArray(edge.props?.explicitPoints) ? edge.props.explicitPoints : [],
    );
    const defaultStub = portStubGap(scale);
    const sourceStub = Number(edge.props?.sourceJettySize) || defaultStub;
    const targetStub = Number(edge.props?.targetJettySize) || defaultStub;
    let totalLength = explicitPoints.length >= 2
      ? sourceStub + routeManhattanLength(explicitPoints) + targetStub
      : 0;
    if (totalLength <= 0) {
      const sourcePoint = portPoint(scale.nodeBoxes.get(edge.start), edge.props?.sourcePort);
      const targetPoint = portPoint(scale.nodeBoxes.get(edge.end), edge.props?.targetPort);
      if (!sourcePoint || !targetPoint) return edge;
      totalLength = Math.abs(targetPoint.x - sourcePoint.x) + Math.abs(targetPoint.y - sourcePoint.y);
    }
    if (totalLength <= 0) return edge;
    const labelText = slotName || controlOutcomeLabel;
    const labelHalfWidth = labelText.length * SLOT_EDGE_LABEL_CHARACTER_WIDTH / 2;
    const endpointClearance = labelHalfWidth + SLOT_EDGE_LABEL_HORIZONTAL_PADDING / 2;
    if (controlOutcomeLabel) {
      const routeLength = Number(edge.props?.layoutRouteLength) || totalLength;
      const rawRelativeX = 2 * endpointClearance / routeLength - 1;
      return {
        ...edge,
        props: {
          ...edge.props,
          controlLabelRelativeX: Math.max(-0.9, Math.min(0, rawRelativeX)),
        },
      };
    }
    const atSource = slotNodeEnd(edge) === 'source';
    const rawRelativeX = atSource
      ? 2 * endpointClearance / totalLength - 1
      : 1 - 2 * endpointClearance / totalLength;
    const relativeX = atSource
      ? Math.max(-0.65, Math.min(0.5, rawRelativeX))
      : Math.max(-0.5, Math.min(0.65, rawRelativeX));
    return {
      ...edge,
      props: {
        ...edge.props,
        slotLabelRelativeX: relativeX,
      },
    };
  });
}

function uniqueRenderableEdges(edges) {
  const seen = new Set();
  return edges.filter((edge) => {
    const producerOutcome = edge.props?.producerOutcome || edge.props?.producer_outcome || '';
    const key = `${edge.start}->${edge.end}:${edge.type}:${producerOutcome}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isIterationRepeatEdge(edge) {
  const protocolRole = edge?.props?.protocolRole || edge?.props?.protocol_role || '';
  return edge?.type === 'REPEATS' || protocolRole === 'iteration-repeat';
}

function edgeRoutingSubstepStableId(edge, nodeById) {
  const source = nodeById?.get(edge.start);
  const target = nodeById?.get(edge.end);
  const sourceHeader = submethodStableIdForLayout(source);
  const targetHeader = submethodStableIdForLayout(target);
  const sourceSubstep = sourceHeader || memberSubmethodStableIdForLayout(source);
  const targetSubstep = targetHeader || memberSubmethodStableIdForLayout(target);
  if (sourceSubstep && sourceSubstep === targetSubstep) return sourceSubstep;
  if (sourceHeader) return sourceHeader;
  if (targetHeader) return targetHeader;
  return sourceSubstep || targetSubstep || '';
}

function edgeRoutingSubstepPhase(edge, nodeById, substepStableId) {
  const sourceNode = nodeById?.get(edge.start);
  const targetNode = nodeById?.get(edge.end);
  const sourceSubstep = submethodStableIdForLayout(sourceNode)
    || memberSubmethodStableIdForLayout(sourceNode);
  const targetSubstep = submethodStableIdForLayout(targetNode)
    || memberSubmethodStableIdForLayout(targetNode);
  const sourceIsMember = sourceSubstep === substepStableId;
  const targetIsMember = targetSubstep === substepStableId;
  const protocolRole = edge?.props?.protocolRole || edge?.props?.protocol_role || '';
  if (edge?.type === 'ASYNC' || edge?.type === 'CATCH') return 0;
  if (
    protocolRole === 'assignment-return'
    || edge?.type === 'YIELDS_VALUE'
    || edge?.type === 'ASSIGNS_VALUE'
  ) return 1;
  if (!sourceIsMember && targetIsMember) return -1;
  if (sourceIsMember && !targetIsMember) return 3;
  if (isIterationRepeatEdge(edge)) return 2;
  return 0;
}

function isSubstepAssignmentReturnEdge(edge, nodeById) {
  const protocolRole = edge?.props?.protocolRole || edge?.props?.protocol_role || '';
  if (protocolRole === 'assignment-return') return true;
  const sourceNode = nodeById?.get(edge.start);
  const targetNode = nodeById?.get(edge.end);
  if (
    (edge?.type === 'YIELDS_VALUE' || edge?.type === 'ASSIGNS_VALUE')
    && !hasLabel(sourceNode, 'Collection')
    && !hasLabel(sourceNode, 'Shift')
    && (
      hasLabel(sourceNode, 'SubStep')
      || hasLabel(sourceNode, 'HybridSubStepHeader')
      || hasLabel(targetNode, 'ValueCreate')
      || hasLabel(targetNode, 'ValueSlot')
    )
  ) return true;
  if (protocolRole.startsWith('iteration-')) return false;
  return edge?.type === 'YIELDS_VALUE' || edge?.type === 'ASSIGNS_VALUE';
}

export function orderEdgesForRouting(edges, nodeBoxes, nodeById) {
  const preferred = [...edges].sort((left, right) => compareEdgesForRouting(left, right, nodeBoxes, nodeById));
  const ordered = [...preferred];
  for (const evaluation of preferred.filter((edge) => (
    edge.type === 'EVAL'
    && (edge.props?.producerRouteRole || edge.props?.producer_route_role) === 'entry'
  ))) {
    const incident = ordered.filter((edge) => (
      edge !== evaluation
      && (edge.start === evaluation.start || edge.end === evaluation.start)
    ));
    if (!incident.length) continue;
    const evaluationIndex = ordered.indexOf(evaluation);
    const firstIncidentIndex = Math.min(...incident.map((edge) => ordered.indexOf(edge)));
    if (evaluationIndex < firstIncidentIndex) continue;
    ordered.splice(evaluationIndex, 1);
    ordered.splice(firstIncidentIndex, 0, evaluation);
  }
  for (const evaluation of preferred.filter((edge) => edge.type === 'EVAL')) {
    const reverseOutcomes = ordered.filter((edge) => (
      (edge.type === 'TRUE' || edge.type === 'FALSE')
      && edge.start === evaluation.end
      && edge.end === evaluation.start
    ));
    if (!reverseOutcomes.length) continue;
    const evaluationIndex = ordered.indexOf(evaluation);
    const firstOutcomeIndex = Math.min(...reverseOutcomes.map((edge) => ordered.indexOf(edge)));
    if (evaluationIndex < firstOutcomeIndex) continue;
    ordered.splice(evaluationIndex, 1);
    ordered.splice(firstOutcomeIndex, 0, evaluation);
  }
  for (const repeat of preferred.filter(isIterationRepeatEdge)) {
    let repeatIndex = ordered.indexOf(repeat);
    const delayedInputs = ordered.filter((edge, index) => (
      index > repeatIndex
      && !isIterationRepeatEdge(edge)
      && edge.end === repeat.start
      && !(edge.start === repeat.end && edge.end === repeat.start)
    ));
    for (const input of delayedInputs) {
      const inputIndex = ordered.indexOf(input);
      ordered.splice(inputIndex, 1);
      repeatIndex = ordered.indexOf(repeat);
      ordered.splice(repeatIndex, 0, input);
    }
  }
  return ordered;
}

function coordinateOptionalReturnGroups(edges, nodeBoxes) {
  const groups = new Map();
  for (const edge of edges) {
    const groupStableId = String(
      edge.props?.optionalReturnGroupStableId || edge.props?.optional_return_group_stable_id || '',
    ).trim();
    if (!groupStableId || edge.type !== 'ASSIGNS_VALUE') continue;
    if (!groups.has(groupStableId)) groups.set(groupStableId, []);
    groups.get(groupStableId).push(edge);
  }
  const coordinatedByEdge = new Map();
  for (const [groupStableId, members] of groups) {
    if (members.length !== 2) continue;
    const ordered = [...members].sort((left, right) => {
      const leftBox = nodeBoxes.get(left.start);
      const rightBox = nodeBoxes.get(right.start);
      const leftCenter = leftBox ? boxCenter(leftBox) : { x: 0, y: 0 };
      const rightCenter = rightBox ? boxCenter(rightBox) : { x: 0, y: 0 };
      return leftCenter.y - rightCenter.y
        || leftCenter.x - rightCenter.x
        || left.start.localeCompare(right.start);
    });
    ordered.forEach((edge, index) => {
      coordinatedByEdge.set(edge, {
        ...edge,
        props: {
          ...edge.props,
          producerRouteRole: index === 0 ? 'return-top' : 'return-bottom',
          optionalReturnPairRank: index,
          optionalReturnGroupStableId: groupStableId,
          layoutRouteReason: [
            edge.props?.layoutRouteReason,
            'optional DataBranch returns choose complementary corridors from final source geometry',
          ].filter(Boolean).join('; '),
        },
      });
    });
  }
  return edges.map((edge) => coordinatedByEdge.get(edge) || edge);
}

export function isLeftStepEntryBarrier(corridor, sourceBox, targetBox) {
  return corridor?.axis === 'v'
    && Number.isFinite(corridor.x)
    && corridor.x < Math.min(sourceBox.x, targetBox.x);
}

function compareEdgesForRouting(left, right, nodeBoxes, nodeById) {
  const leftRepeat = isIterationRepeatEdge(left);
  const rightRepeat = isIterationRepeatEdge(right);
  const leftIterationPass = (left.props?.protocolRole || left.props?.protocol_role) === 'iteration-pass';
  const rightIterationPass = (right.props?.protocolRole || right.props?.protocol_role) === 'iteration-pass';
  if (leftRepeat && rightIterationPass && left.end === right.start) return 1;
  if (rightRepeat && leftIterationPass && right.end === left.start) return -1;
  const leftOperationOrder = Number(
    nodeById?.get(left.start)?.props?.operationIndex
      ?? nodeById?.get(left.start)?.props?.operation_index,
  );
  const rightOperationOrder = Number(
    nodeById?.get(right.start)?.props?.operationIndex
      ?? nodeById?.get(right.start)?.props?.operation_index,
  );
  if (
    Number.isFinite(leftOperationOrder)
    && Number.isFinite(rightOperationOrder)
    && leftOperationOrder !== rightOperationOrder
  ) return leftOperationOrder - rightOperationOrder;
  const reverseEndpointPair = left.start === right.end && left.end === right.start;
  if (!reverseEndpointPair) {
    if (left.end === right.start) return -1;
    if (right.end === left.start) return 1;
  }
  const leftObjectFamilyEdge = left.type === 'FIELD' || left.type === 'FieldJoin';
  const rightObjectFamilyEdge = right.type === 'FIELD' || right.type === 'FieldJoin';
  if (leftRepeat && rightObjectFamilyEdge) return 1;
  if (rightRepeat && leftObjectFamilyEdge) return -1;
  if (leftRepeat && rightRepeat) {
    const leftSource = nodeBoxes.get(left.start);
    const rightSource = nodeBoxes.get(right.start);
    const leftSourceY = leftSource ? boxCenter(leftSource).y : 0;
    const rightSourceY = rightSource ? boxCenter(rightSource).y : 0;
    if (leftSourceY !== rightSourceY) return leftSourceY - rightSourceY;
  }
  const leftAssignmentReturn = isSubstepAssignmentReturnEdge(left, nodeById);
  const rightAssignmentReturn = isSubstepAssignmentReturnEdge(right, nodeById);
  if (leftAssignmentReturn !== rightAssignmentReturn) return leftAssignmentReturn ? 1 : -1;
  if (reverseEndpointPair) {
    const typeDelta = edgeRoutingTypePriority(left.type) - edgeRoutingTypePriority(right.type);
    if (typeDelta) return typeDelta;
  }
  const leftSubstep = edgeRoutingSubstepStableId(left, nodeById);
  const rightSubstep = edgeRoutingSubstepStableId(right, nodeById);
  if (leftSubstep && leftSubstep === rightSubstep) {
    const phaseDelta = edgeRoutingSubstepPhase(left, nodeById, leftSubstep)
      - edgeRoutingSubstepPhase(right, nodeById, rightSubstep);
    if (phaseDelta) return phaseDelta;
  }
  if (leftRepeat && rightRepeat && left.end === right.end) {
    const leftSource = nodeBoxes.get(left.start);
    const rightSource = nodeBoxes.get(right.start);
    const leftX = leftSource ? boxCenter(leftSource).x : 0;
    const rightX = rightSource ? boxCenter(rightSource).x : 0;
    if (leftX !== rightX) return rightX - leftX;
  }
  if (left.end === right.end) {
    const leftTargetPriority = edgeRoutingTypePriority(left.type);
    const rightTargetPriority = edgeRoutingTypePriority(right.type);
    if (leftTargetPriority !== rightTargetPriority) return leftTargetPriority - rightTargetPriority;
  }
  if (left.start === right.start) {
    const leftTargetNode = nodeById?.get(left.end);
    const rightTargetNode = nodeById?.get(right.end);
    const leftBackboneId = String(leftTargetNode?.props?.flowJoinBackboneSourceStableId || '').trim();
    const rightBackboneId = String(rightTargetNode?.props?.flowJoinBackboneSourceStableId || '').trim();
    const lateralFlowJoinSiblings = isFlowJoinNode(leftTargetNode)
      && isFlowJoinNode(rightTargetNode)
      && leftBackboneId
      && rightBackboneId
      && left.start !== leftBackboneId
      && right.start !== rightBackboneId;
    if (lateralFlowJoinSiblings) {
      const sourceBox = nodeBoxes.get(left.start);
      const leftTargetBox = nodeBoxes.get(left.end);
      const rightTargetBox = nodeBoxes.get(right.end);
      if (sourceBox && leftTargetBox && rightTargetBox) {
        const sourceCenter = boxCenter(sourceBox);
        const leftDistance = Math.abs(boxCenter(leftTargetBox).x - sourceCenter.x);
        const rightDistance = Math.abs(boxCenter(rightTargetBox).x - sourceCenter.x);
        if (leftDistance !== rightDistance) return rightDistance - leftDistance;
      }
    }
  }
  const leftSource = nodeBoxes.get(left.start);
  const leftTarget = nodeBoxes.get(left.end);
  const rightSource = nodeBoxes.get(right.start);
  const rightTarget = nodeBoxes.get(right.end);
  const leftSourceCenter = leftSource ? boxCenter(leftSource) : { x: 0, y: 0 };
  const rightSourceCenter = rightSource ? boxCenter(rightSource) : { x: 0, y: 0 };
  if (leftSourceCenter.x !== rightSourceCenter.x) return leftSourceCenter.x - rightSourceCenter.x;
  if (leftSourceCenter.y !== rightSourceCenter.y) return leftSourceCenter.y - rightSourceCenter.y;
  const leftFlowPriority = edgeFlowRoutingPriority(left, leftSource, leftTarget);
  const rightFlowPriority = edgeFlowRoutingPriority(right, rightSource, rightTarget);
  if (leftFlowPriority !== rightFlowPriority) return leftFlowPriority - rightFlowPriority;
  const leftTypePriority = edgeRoutingTypePriority(left.type);
  const rightTypePriority = edgeRoutingTypePriority(right.type);
  if (leftTypePriority !== rightTypePriority) return leftTypePriority - rightTypePriority;
  if (left.start === right.start && isFanoutEdge(left) && isFanoutEdge(right)) {
    const leftGap = Math.abs((leftTarget?.x ?? 0) - ((leftSource?.x ?? 0) + (leftSource?.width ?? 0)));
    const rightGap = Math.abs((rightTarget?.x ?? 0) - ((rightSource?.x ?? 0) + (rightSource?.width ?? 0)));
    if (leftGap !== rightGap) return leftGap - rightGap;
  }
  const leftMinY = Math.min(leftSource?.y ?? 0, leftTarget?.y ?? 0);
  const rightMinY = Math.min(rightSource?.y ?? 0, rightTarget?.y ?? 0);
  if (leftMinY !== rightMinY) return leftMinY - rightMinY;
  const leftMaxY = Math.max(leftSource?.y ?? 0, leftTarget?.y ?? 0);
  const rightMaxY = Math.max(rightSource?.y ?? 0, rightTarget?.y ?? 0);
  if (leftMaxY !== rightMaxY) return leftMaxY - rightMaxY;
  const leftMinX = Math.min(leftSource?.x ?? 0, leftTarget?.x ?? 0);
  const rightMinX = Math.min(rightSource?.x ?? 0, rightTarget?.x ?? 0);
  return leftMinX - rightMinX;
}

function edgeFlowRoutingPriority(edge, sourceBox, targetBox) {
  if (!sourceBox || !targetBox) return 10;
  const sourceCenter = boxCenter(sourceBox);
  const targetCenter = boxCenter(targetBox);
  const sameRow = Math.abs(sourceCenter.y - targetCenter.y) < 1;
  const goesRight = targetCenter.x > sourceCenter.x;
  const goesDown = targetCenter.y > sourceCenter.y;
  if ((edge.type === 'TRUE' || edge.type === 'FALSE') && sameRow && goesRight) return 0;
  if (edge.type === 'NEXT' && goesDown) return 1;
  if ((edge.type === 'TRUE' || edge.type === 'FALSE') && goesDown) return 2;
  if (targetCenter.x < sourceCenter.x || targetCenter.y < sourceCenter.y) return 3;
  return 4;
}

function edgeRoutingTypePriority(type) {
  if (type === 'EVAL') return 0;
  if (type === 'NEXT') return 1;
  if (type === 'TRUE' || type === 'FALSE') return 2;
  return 3;
}

function routeNormalEdge(edge, scale, routedCorridors, routeState = {}) {
  const sourceNode = routeState.nodeById?.get(edge.start);
  const targetNode = routeState.nodeById?.get(edge.end);
  const rawSourceBox = scale.nodeBoxes.get(edge.start);
  const rawTargetBox = scale.nodeBoxes.get(edge.end);
  if (!rawSourceBox || !rawTargetBox) return edge;
  const effectiveSourceBox = scale.effectiveNodeBoxes?.get(edge.start) || rawSourceBox;
  const effectiveTargetBox = scale.effectiveNodeBoxes?.get(edge.end) || rawTargetBox;
  const producerRouteRole = edge.props?.producerRouteRole || edge.props?.producer_route_role || '';
  const protocolRole = edge.props?.protocolRole || edge.props?.protocol_role || '';
  const assignmentReturn = protocolRole === 'assignment-return'
    || producerRouteRole === 'return-top'
    || producerRouteRole === 'return-bottom';
  const optionalReturnGroupStableId = String(
    edge.props?.optionalReturnGroupStableId || edge.props?.optional_return_group_stable_id || '',
  );
  const iterationPass = protocolRole === 'iteration-pass';
  const iterationRepeat = edge.type === 'REPEATS' || protocolRole === 'iteration-repeat';
  const resumeInitialization = iterationRepeat && hasLabel(targetNode, 'ValueCreate');
  const iterationExhaustion = edge.type === 'FALSE'
    && hasLabel(sourceNode, 'IterationGuard')
    && hasLabel(targetNode, 'CollectionExit');
  const repeatOrigin = edge.props?.repeatOrigin || edge.props?.repeat_origin || '';
  const unconditionalRepeat = edge.type === 'REPEATS' && repeatOrigin !== 'binary-expression';
  const producerEntry = producerRouteRole === 'entry' && edge.type === 'EVAL';
  const ordinaryYieldReturn = edge.type === 'YIELDS_VALUE'
    && !iterationPass
    && producerRouteRole !== 'return-top';
  const nestedDownEval = edge.type === 'EVAL'
    && (sourceNode?.props?.nestedEvaluationDirection
      || sourceNode?.props?.nested_evaluation_direction) === 'down';
  const wholeFlowPredicateEndpoint = isFlowBranchNode(sourceNode)
    && (edge.type === 'TRUE' || edge.type === 'FALSE');
  const sourceHorizontalPartBox = wholeFlowPredicateEndpoint
    ? null
    : structuredHorizontalEndpointPartBox(sourceNode, rawSourceBox, edge, 'source');
  const targetHorizontalPartBox = structuredHorizontalEndpointPartBox(targetNode, rawTargetBox, edge, 'target');
  const sourceOverlayPart = containerOverlayEndpointPart(sourceNode, edge, 'source');
  const targetOverlayPart = containerOverlayEndpointPart(targetNode, edge, 'target');
  const operationProviderSourceMethod = sourceOverlayPart === 'method'
    && hasLabel(sourceNode, 'OperationProvider');
  const operationProviderTargetMethod = targetOverlayPart === 'method'
    && hasLabel(targetNode, 'OperationProvider');
  const closingCallBoundaryTarget = isClosingCallBoundaryNode(targetNode);
  const sourceBox = sourceHorizontalPartBox || (sourceOverlayPart
    ? structuredContainerOverlayPartBox(sourceNode, rawSourceBox, sourceOverlayPart)
    : rawSourceBox);
  const targetBox = targetHorizontalPartBox || (targetOverlayPart
    ? structuredContainerOverlayPartBox(targetNode, rawTargetBox, targetOverlayPart)
    : protocolRole === 'iteration-pass'
    ? structuredHorizontalPartBox(targetNode, rawTargetBox, 'method')
    : producerRouteRole === 'return-top'
    || producerRouteRole === 'return-bottom'
    || edge.type === 'ASSIGNS_VALUE'
    || edge.type === 'YIELDS_VALUE'
    || protocolRole === 'assignment-return'
    ? structuredContainerOverlayPartBox(targetNode, rawTargetBox, 'method')
    : rawTargetBox);
  const sourcePartStableId = edge.props?.sourceRenderPartStableId || edge.props?.source_render_part_stable_id;
  const targetPartStableId = edge.props?.targetRenderPartStableId || edge.props?.target_render_part_stable_id;
  const sourcePortOwnerId = sourceHorizontalPartBox
    ? `${edge.start}:render-part:${sourcePartStableId}`
    : sourceOverlayPart ? `${edge.start}:visual-${sourceOverlayPart}` : edge.start;
  const targetPortOwnerId = targetHorizontalPartBox
    ? `${edge.end}:render-part:${targetPartStableId}`
    : targetOverlayPart ? `${edge.end}:visual-${targetOverlayPart}` : edge.end;
  const directMosaicDataJoin = Boolean(sourceHorizontalPartBox)
    && isDataJoinNode(targetNode)
    && (edge.type === 'TRUE' || edge.type === 'FALSE');
  const strictOperandOutcome = isOperandBranchNode(sourceNode)
    && hasLabel(sourceNode, 'Data')
    && (edge.type === 'TRUE' || edge.type === 'FALSE');
  const reverseEvaluationOutcome = (edge.type === 'TRUE' || edge.type === 'FALSE')
    && routeState.edges?.some((candidate) => (
      candidate.type === 'EVAL'
      && candidate.start === edge.end
      && candidate.end === edge.start
    ));
  const strictOperandOutcomeSourcePort = reverseEvaluationOutcome
    ? edge.type === 'FALSE' ? 'bottom' : 'top'
    : strictOperandOutcome
    ? boxCenter(targetBox).y > boxCenter(sourceBox).y + 1
      ? 'bottom'
      : boxCenter(targetBox).x < boxCenter(sourceBox).x
        ? 'left'
        : 'right'
    : null;
  const repeatCallFamilySource = iterationRepeat
    && sourceOverlayPart === 'method'
    && hasLabel(sourceNode, 'Collection')
    && hasLabel(sourceNode, 'Start');
  const elseIfChainBypass = edge.type === 'REJOINS'
    && (edge.props?.elseIfChainBypass === true || edge.props?.else_if_chain_bypass === true);
  if (elseIfChainBypass) {
    const sourcePort = 'left';
    const targetPort = 'left';
    const sourcePoint = portPoint(sourceBox, sourcePort);
    const targetPoint = portPoint(targetBox, targetPort);
    const bypassX = Math.min(sourceBox.x, targetBox.x) - 20;
    const points = removeDuplicateRoutePoints([
      { x: bypassX, y: sourcePoint.y },
      { x: bypassX, y: targetPoint.y },
    ]);
    const corridorPoints = removeDuplicateRoutePoints([sourcePoint, ...points, targetPoint]);
    registerRouteCorridors(routedCorridors, corridorPoints, {
      sourceId: edge.start,
      sourcePort,
      targetId: edge.end,
      targetPort,
    });
    registerNodePortUsage(routeState.portUsageByNode, edge.start, sourceBox, sourcePort, 'outgoing', edge.type);
    registerNodePortUsage(routeState.portUsageByNode, edge.end, targetBox, targetPort, 'incoming', edge.type);
    return {
      ...edge,
      props: {
        ...edge.props,
        sourcePort,
        targetPort,
        explicitPoints: points,
        lockRoutePoints: true,
        layoutRouteReason: 'earlier else-if body bypasses the remaining alternatives on the left and reaches the shared FlowJoin row',
      },
    };
  }
  if (
    sourceNode?.props?.hybridVisualRole === 'column-junction'
    || targetNode?.props?.hybridVisualRole === 'column-junction'
  ) {
    return {
      ...edge,
      props: {
        ...edge.props,
        sourcePort: edge.props?.sourcePort || inferSourcePort(sourceBox, targetBox),
        targetPort: edge.props?.targetPort || inferTargetPort(sourceBox, targetBox),
        sourcePortCandidates: undefined,
        targetPortCandidates: undefined,
        lockPortCandidates: false,
        layoutRouteReason: 'graph-backed functional-column junction uses elastic draw.io routing',
      },
    };
  }

  const sourceFoldGroup = scale.foldGroupByNodeId?.get(edge.start);
  const targetFoldGroup = scale.foldGroupByNodeId?.get(edge.end);
  const sourceFoldRow = scale.foldRowByNodeId?.get(edge.start);
  const targetFoldRow = scale.foldRowByNodeId?.get(edge.end);
  const lockPortCandidates = edge.props?.lockPortCandidates === true || edge.props?.lock_port_candidates === true;
  const lockedSourcePort = edge.props?.sourcePort || edge.props?.source_port;
  const lockedTargetPort = edge.props?.targetPort || edge.props?.target_port;
  const lockedSourcePortCandidates = edge.props?.sourcePortCandidates || edge.props?.source_port_candidates;
  const lockedTargetPortCandidates = edge.props?.targetPortCandidates || edge.props?.target_port_candidates;
  const horizontalStepTransition = edge.type === 'NEXT'
    && Math.abs(boxCenter(sourceBox).y - boxCenter(targetBox).y) < 1
    && (sourceBox.x + sourceBox.width < targetBox.x || targetBox.x + targetBox.width < sourceBox.x);
  const crossFoldTargetPort = !lockPortCandidates && sourceFoldRow && targetFoldRow && sourceFoldRow !== targetFoldRow
    ? horizontalStepTransition
      ? (sourceBox.x < targetBox.x ? 'left' : 'right')
      : (boxCenter(sourceBox).y < boxCenter(targetBox).y ? 'top' : 'bottom')
    : null;
  const crossFoldSourcePort = crossFoldTargetPort
    ? ({ top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[crossFoldTargetPort])
    : null;
  const relevantFoldGroups = new Set([sourceFoldGroup, targetFoldGroup].filter(Boolean));
  const producerScopeStartOrder = Number(
    edge.props?.producerScopeStartOrder ?? edge.props?.producer_scope_start_order,
  );
  const producerScopeEndOrder = Number(
    edge.props?.producerScopeEndOrder ?? edge.props?.producer_scope_end_order,
  );
  const producerScopeStableIds = new Set(
    edge.props?.producerScopeStableIds ?? edge.props?.producer_scope_stable_ids ?? [],
  );
  const hasProducerScope = assignmentReturn
    && (
      producerScopeStableIds.size > 0
      || (Number.isFinite(producerScopeStartOrder) && Number.isFinite(producerScopeEndOrder))
    );
  const repeatCrossingCorridors = iterationRepeat && sourceFoldGroup
    ? routedCorridors.flatMap((corridor) => {
        const corridorSourceGroup = scale.foldGroupByNodeId?.get(corridor.sourceId);
        const corridorTargetGroup = scale.foldGroupByNodeId?.get(corridor.targetId);
        const belongsToStep = corridorSourceGroup === sourceFoldGroup
          || corridorTargetGroup === sourceFoldGroup;
        if (!belongsToStep) return [];
        const entersStep = corridorTargetGroup === sourceFoldGroup
          && corridorSourceGroup !== sourceFoldGroup;
        const isLeftStepBoundary = isLeftStepEntryBarrier(corridor, sourceBox, targetBox);
        if (!entersStep || !isLeftStepBoundary) return [corridor];
        return [{
          ...corridor,
          from: Number.NEGATIVE_INFINITY,
          to: Number.POSITIVE_INFINITY,
          stepEntryBarrier: true,
        }];
      })
    : routedCorridors;
  const isRoutingObstacle = (nodeId) => {
    const node = routeState.nodeById?.get(nodeId);
    if ([
      'functional-column',
      'column-junction',
      'column-stage-port',
    ].includes(node?.props?.hybridVisualRole)) return false;
    if (!hasProducerScope || nodeId === edge.start || nodeId === edge.end) return true;
    if (producerScopeStableIds.size > 0) return producerScopeStableIds.has(nodeId);
    const operationIndex = Number(node?.props?.operationIndex ?? node?.props?.operation_index);
    return Number.isFinite(operationIndex)
      && operationIndex >= producerScopeStartOrder
      && operationIndex <= producerScopeEndOrder;
  };
  const routingNodeBoxes = new Map([...scale.nodeBoxes.entries()].filter(([nodeId]) => (
    isRoutingObstacle(nodeId)
    && (edge.props?.layoutEffectiveSourceStableId || !relevantFoldGroups.size || relevantFoldGroups.has(scale.foldGroupByNodeId?.get(nodeId)))
  )));
  const assignmentScopeBounds = assignmentReturn && producerRouteRole !== 'return-top'
    ? (() => {
        const boxes = dedupeValues([
          rawSourceBox,
          rawTargetBox,
          ...(hasProducerScope ? routingNodeBoxes.values() : []),
        ]);
        if (!boxes.length) return null;
        return {
          id: `assignment-scope:${edge.start}->${edge.end}`,
          left: Math.min(...boxes.map((box) => box.x)),
          right: Math.max(...boxes.map((box) => box.x + box.width)),
          top: Math.min(...boxes.map((box) => box.y)),
          bottom: Math.max(...boxes.map((box) => box.y + box.height)),
        };
      })()
    : null;
  const nodeCenters = buildBlockedNodeCenters(routingNodeBoxes, new Set([edge.start, edge.end]));
  const individualNodeObstacles = buildBlockedNodeObstacles(routingNodeBoxes, new Set([edge.start, edge.end]));
  const sourceCenterY = sourceBox.y + sourceBox.height / 2;
  const targetCenterY = targetBox.y + targetBox.height / 2;
  const repeatInteriorTop = sourceCenterY >= targetCenterY
    ? targetBox.y + targetBox.height
    : sourceBox.y + sourceBox.height;
  const repeatInteriorBottom = sourceCenterY >= targetCenterY
    ? sourceBox.y
    : targetBox.y;
  const interveningRepeatObstacles = iterationRepeat
    ? individualNodeObstacles.filter((box) => (
        box.top >= repeatInteriorTop && box.bottom <= repeatInteriorBottom
      ))
    : [];
  const repeatObstacleEnvelope = interveningRepeatObstacles.length
    ? {
        id: `repeat-envelope:${edge.start}->${edge.end}`,
        left: Math.min(...interveningRepeatObstacles.map((box) => box.left)),
        right: Math.max(...interveningRepeatObstacles.map((box) => box.right)),
        top: Math.min(...interveningRepeatObstacles.map((box) => box.top)),
        bottom: Math.max(...interveningRepeatObstacles.map((box) => box.bottom)),
      }
    : null;
  const ordinaryNodeObstaclesUnfiltered = repeatObstacleEnvelope
    ? [
        ...individualNodeObstacles.filter((box) => !interveningRepeatObstacles.includes(box)),
        repeatObstacleEnvelope,
      ]
    : individualNodeObstacles;
  const ordinaryNodeObstacles = assignmentReturn
    ? ordinaryNodeObstaclesUnfiltered.filter((obstacle) => (
        !routeObstacleOverlapsNodeBox(obstacle, rawSourceBox)
        && !routeObstacleOverlapsNodeBox(obstacle, rawTargetBox)
      ))
    : ordinaryNodeObstaclesUnfiltered;
  const objectFamilyObstacles = iterationRepeat
    ? (routeState.objectFamilyObstacles || []).filter((obstacle) => (
        !obstacle.memberIds.has(edge.start)
        && !obstacle.memberIds.has(edge.end)
        && !routeObstacleOverlapsNodeBox(obstacle, rawSourceBox)
        && !routeObstacleOverlapsNodeBox(obstacle, rawTargetBox)
        && (!relevantFoldGroups.size || [...obstacle.memberIds].some((nodeId) => (
          relevantFoldGroups.has(scale.foldGroupByNodeId?.get(nodeId))
        )))
      ))
    : [];
  const nodeObstacles = [...ordinaryNodeObstacles, ...objectFamilyObstacles];
  const endpointRenderPartObstacles = [
    ...(() => {
      const layout = structuredHorizontalSize(sourceNode);
      const endpointIndex = structuredHorizontalEndpointPartIndex(sourceNode, edge, 'source');
      if (!layout || endpointIndex < 0) return [];
      return layout.parts.flatMap((_, index) => {
        if (index === endpointIndex) return [];
        const box = structuredHorizontalPartBoxAtIndex(sourceNode, rawSourceBox, index);
        return box ? [{
          id: `source-render-part:${edge.start}:${index}`,
          left: box.x,
          right: box.x + box.width,
          top: box.y,
          bottom: box.y + box.height,
        }] : [];
      });
    })(),
    ...(() => {
      const layout = structuredHorizontalSize(targetNode);
      const endpointIndex = structuredHorizontalEndpointPartIndex(targetNode, edge, 'target');
      if (!layout || endpointIndex < 0) return [];
      return layout.parts.flatMap((_, index) => {
        if (index === endpointIndex) return [];
        const box = structuredHorizontalPartBoxAtIndex(targetNode, rawTargetBox, index);
        return box ? [{
          id: `target-render-part:${edge.end}:${index}`,
          left: box.x,
          right: box.x + box.width,
          top: box.y,
          bottom: box.y + box.height,
        }] : [];
      });
    })(),
    ...structuredContainerOverlaySiblingPartBoxes(sourceNode, rawSourceBox, sourcePartStableId),
    ...structuredContainerOverlaySiblingPartBoxes(targetNode, rawTargetBox, targetPartStableId),
  ];
  const endpointCompositeObstacles = [
    ...endpointRenderPartObstacles,
    repeatCallFamilySource ? {
      id: `source-composite:${edge.start}`,
      left: rawSourceBox.x,
      right: rawSourceBox.x + rawSourceBox.width,
      top: rawSourceBox.y,
      bottom: rawSourceBox.y + rawSourceBox.height,
    } : null,
    (iterationRepeat || edge.props?.layoutEffectiveSourceStableId) && targetOverlayPart === 'method' ? (() => {
      const targetContainerBox = structuredContainerOverlayPartBox(targetNode, rawTargetBox, 'container');
      return targetContainerBox ? {
        id: `repeat-target-container:${edge.end}`,
        left: targetContainerBox.x,
        right: targetContainerBox.x + targetContainerBox.width,
        top: targetContainerBox.y,
        bottom: targetContainerBox.y + targetContainerBox.height,
      } : null;
    })() : null,
  ].filter(Boolean);
  const routeCoreNodeObstacles = [...nodeObstacles, ...endpointCompositeObstacles];
  const stubGap = portStubGap(scale);
  const corridorIndex = buildRouteCorridorIndex(routedCorridors);
  const sourceGraphPosition = routeState.graphPositions?.get(edge.start);
  const targetGraphPosition = routeState.graphPositions?.get(edge.end);
  const localVisualResponse = edge.type === 'RESPONSE'
    && hasLabel(sourceNode, 'VisualProxy');
  const horizontalMosaicArgument = edge.type === 'ARG'
    && Boolean(structuredHorizontalSize(targetNode));
  const splitCallFamilyArgument = edge.type === 'ARG'
    && splitCallBoundarySide(sourceNode) === 'start';
  const objectBraceArgumentBoundary = (edge.type === 'ARG' && isObjectBraceNode(targetNode))
    || (edge.type === 'ArgJoin' && isObjectBraceNode(sourceNode));
  const horizontalArgumentFrame = ['ARG', 'ArgJoin'].includes(edge.type)
    && (
      (edge.props?.layoutFrame || edge.props?.layout_frame) === 'horizontal'
      || splitCallFamilyArgument
    )
    && !objectBraceArgumentBoundary;
  const sharedHorizontalFamilySource = ['ARG', 'FIELD'].includes(edge.type)
    && (
      (edge.props?.layoutFrame || edge.props?.layout_frame) === 'horizontal'
      || splitCallFamilyArgument
    );
  const flowJoinBackboneSourceId = String(
    targetNode?.props?.flowJoinBackboneSourceStableId
      || targetNode?.props?.flow_join_backbone_source_stable_id
      || '',
  ).trim();
  const lateralFlowJoinEntry = isFlowJoinNode(targetNode)
    && Boolean(flowJoinBackboneSourceId)
    && edge.start !== flowJoinBackboneSourceId;
  const returningFalse = edge.type === 'FALSE' && !isFlowJoinNode(targetNode)
    && boxCenter(targetBox).x < boxCenter(sourceBox).x
    && targetBox.y > sourceBox.y + sourceBox.height;
  // Keep visually aligned endpoints on their shared axis. Composite endpoints
  // use their active overlay box above, so their diagonal backings do not skew it.
  const basePortAttempts = buildPortAttempts(
    sourceBox,
    targetBox,
    producerEntry
      ? 'right'
      : iterationExhaustion
      ? 'bottom'
      : strictOperandOutcomeSourcePort
      ? strictOperandOutcomeSourcePort
      : assignmentReturn && producerRouteRole === 'return-top'
      ? 'top'
      : assignmentReturn && producerRouteRole === 'return-bottom'
      ? 'bottom'
      : iterationPass
      ? 'bottom'
      : repeatCallFamilySource
      ? 'bottom'
      : crossFoldSourcePort || (lockPortCandidates ? lockedSourcePort : null),
    producerEntry
      ? 'left'
      : assignmentReturn
      ? producerRouteRole === 'return-top' ? 'top' : 'bottom'
      : iterationPass
      ? 'right'
      : iterationRepeat
      ? 'right'
      : horizontalArgumentFrame
      ? 'left'
      : horizontalMosaicArgument
      ? 'left'
      : crossFoldTargetPort || (lockPortCandidates ? lockedTargetPort : null),
    {
    edgeType: edge.type,
    sourceNode,
    targetNode,
    // Folding changes the nodes' effective vertical order. Once that order
    // selects the boundary-facing ports, do not let raw graph coordinates
    // reopen the candidate set and replace them with a farther side port.
    explicitSourcePorts: returningFalse ? ['left'] : lockPortCandidates && lockedSourcePortCandidates?.length
      ? lockedSourcePortCandidates
      : producerEntry
      ? ['right']
      : iterationExhaustion
      ? ['bottom']
      : strictOperandOutcomeSourcePort
      ? dedupeValues([strictOperandOutcomeSourcePort, 'bottom', 'right', 'left', 'top'])
      : nestedDownEval
      ? ['bottom', 'right', 'top', 'left']
      : ordinaryYieldReturn
      ? expandSourcePorts(['right', 'bottom', 'left'])
      : assignmentReturn
      ? producerRouteRole === 'return-top'
        ? ['top', 'right', 'left', 'bottom']
        : producerRouteRole === 'return-bottom'
          ? ['bottom', 'right', 'left']
          : ['bottom', 'right', 'left']
      : iterationPass
      ? ['bottom']
      : iterationRepeat
      ? resumeInitialization ? ['right'] : ['bottom', 'right']
      : repeatCallFamilySource
      ? ['bottom', 'left']
      : splitCallFamilyArgument
      ? ['right']
      : operationProviderSourceMethod && edge.type === 'REJOINS'
      ? ['left']
      : operationProviderSourceMethod
      ? ['top', 'right', 'bottom', 'left']
      : lockPortCandidates
      ? lockedSourcePortCandidates
      : crossFoldSourcePort ? [crossFoldSourcePort] : undefined,
    explicitTargetPorts: returningFalse ? ['top'] : lockPortCandidates && lockedTargetPortCandidates?.length
      ? lockedTargetPortCandidates
      : producerEntry
      ? ['left']
      : closingCallBoundaryTarget
      ? ['left']
      : assignmentReturn
      ? optionalReturnGroupStableId && producerRouteRole === 'return-top'
        ? ['top']
        : optionalReturnGroupStableId && producerRouteRole === 'return-bottom'
          ? ['bottom']
        : producerRouteRole === 'return-top'
        ? ['top', 'right', 'left', 'bottom']
        : producerRouteRole === 'return-bottom'
          ? ['bottom', 'right', 'left', 'top']
          : ['bottom', 'right', 'left', 'top']
      : iterationPass
      ? ['right']
      : iterationRepeat
      ? resumeInitialization ? ['top-80']
        : hasLabel(targetNode, 'Branch') || hasLabel(targetNode, 'OperandBranch') ? ['left'] : ['right']
      : horizontalArgumentFrame
      ? ['left']
      : horizontalMosaicArgument
      ? ['left']
      : operationProviderTargetMethod && edge.type === 'NEXT'
      ? ['top']
      : operationProviderTargetMethod && sourceBoxIsAboveTarget(sourceBox, targetBox)
      ? undefined
      : operationProviderTargetMethod
      ? ['top', 'right', 'bottom', 'left']
      : directMosaicDataJoin
      ? [edge.type === 'TRUE' ? 'top' : 'left']
      : lockPortCandidates
      ? lockedTargetPortCandidates
      : crossFoldTargetPort ? [crossFoldTargetPort] : undefined,
    // A used port remains a valid candidate. Corridor routing decides whether
    // sharing it is possible; excluding it here can force a longer wrong-side
    // route before pathfinding has a chance to compare the alternatives.
    blockedSourcePorts: null,
    sourceGraphPosition,
    targetGraphPosition,
    sourceRenderPartEndpoint: Boolean(sourceHorizontalPartBox),
    incomingFromAbove: iterationRepeat ? false : sourceBoxIsAboveTarget(sourceBox, targetBox),
    lateralFlowJoinEntry,
    assignmentReturn,
    iterationRepeat,
    },
  ).map((attempt) => {
    // Circular execution boundaries expose a central top port in the engine.
    if (hasLabel(targetNode, 'FunctionEnd') || hasLabel(targetNode, 'End')) return attempt;
    const parsedTargetPort = parsePercentPort(attempt.targetPort);
    const centralTopPort = attempt.targetPort === 'top'
      || (parsedTargetPort?.side === 'top' && Math.abs(parsedTargetPort.ratio - 0.5) < 1e-9);
    const sameVisualAxis = Math.abs(boxCenter(sourceBox).x - boxCenter(targetBox).x) < 1;
    if (!sameVisualAxis || !centralTopPort || !sourceBoxIsAboveTarget(sourceBox, targetBox)) {
      return attempt;
    }
    const sourcePoint = portPoint(sourceBox, attempt.sourcePort);
    if (!sourcePoint || targetBox.width <= 0) return attempt;
    const targetRatio = (sourcePoint.x - targetBox.x) / targetBox.width;
    if (targetRatio <= 0 || targetRatio >= 1 || Math.abs(targetRatio - 0.5) < 0.005) {
      return attempt;
    }
    return {
      ...attempt,
      targetPort: `top-${Math.round(targetRatio * 100)}`,
    };
  });
  let portAttempts = basePortAttempts.filter((attempt) => portAttemptIsAvailable(
    routeState.portUsageByNode,
    sourcePortOwnerId,
    sourceBox,
    attempt.sourcePort,
    targetPortOwnerId,
    targetBox,
    attempt.targetPort,
    edge.type,
    sharedHorizontalFamilySource,
  ));
  const assignmentReturnSourceSideAvailable = (attempt) => {
    if (!assignmentReturn) return true;
    const usage = nodePortSideUsage(
      routeState.portUsageByNode,
      sourcePortOwnerId,
      portSide(attempt.sourcePort),
    );
    return usage.incoming === 0 && usage.outgoing === 0;
  };
  portAttempts = portAttempts.filter(assignmentReturnSourceSideAvailable);
  if (
    !portAttempts.length
    && !strictOperandOutcome
    && !assignmentReturn
    && !iterationRepeat
    && edge.type !== 'EVAL'
    && !isFlowBranchNode(sourceNode)
    && !operationProviderSourceMethod
    && !operationProviderTargetMethod
  ) {
    portAttempts = expandAvailablePortAttempts(
      basePortAttempts,
      routeState.portUsageByNode,
      sourcePortOwnerId,
      sourceBox,
      targetPortOwnerId,
      targetBox,
      edge.type,
      sharedHorizontalFamilySource,
    ).filter(assignmentReturnSourceSideAvailable);
  }
  if (!portAttempts.length) {
    throw new Error(`No free port pair for ${edge.type} ${edge.start} -> ${edge.end}; attempts=${JSON.stringify(basePortAttempts)}; sourceUsage=${JSON.stringify([...routeState.portUsageByNode.get(sourcePortOwnerId)?.entries() || []])}; targetUsage=${JSON.stringify([...routeState.portUsageByNode.get(targetPortOwnerId)?.entries() || []])}`);
  }
  portAttempts.sort((left, right) => {
    const leftSource = portPoint(sourceBox, left.sourcePort);
    const leftTarget = portPoint(targetBox, left.targetPort);
    const rightSource = portPoint(sourceBox, right.sourcePort);
    const rightTarget = portPoint(targetBox, right.targetPort);
    return manhattanDistance(leftSource, leftTarget) - manhattanDistance(rightSource, rightTarget);
  });
  // Port selection is part of pathfinding: compare every allowed source/target
  // pair instead of accepting the first pair that happens to have a route.
  const compareAllPortCandidates = true;
  let selectedRoute = null;
  for (const attempt of portAttempts) {
    const sourcePoint = portPoint(sourceBox, attempt.sourcePort);
    const targetPoint = portPoint(targetBox, attempt.targetPort);
    if (!sourcePoint || !targetPoint) continue;
    if (selectedRoute?.ok
      && manhattanDistance(sourcePoint, targetPoint) > selectedRoute.routeLength) continue;
    const relocatedSource = edge.props?.layoutEffectiveSourceStableId
      && edge.props.layoutEffectiveSourceStableId !== edge.props.stableId;
    let [sourceStub, targetStub] = isFanoutEdge(edge) && !relocatedSource
      ? fanoutPortStubPoints(edge.start, sourcePoint, attempt.sourcePort, targetPoint, attempt.targetPort, stubGap, routeState)
      : pairedPortStubPoints(
        sourcePoint,
        attempt.sourcePort,
        targetPoint,
        attempt.targetPort,
        stubGap,
      );
    if (assignmentScopeBounds && portSide(attempt.sourcePort) === 'bottom') {
      const bottomLaneY = Math.max(
        assignmentScopeBounds.bottom + ROUTE_OBSTACLE_CLEARANCE,
        sourcePoint.y + stubGap,
        portSide(attempt.targetPort) === 'bottom' ? targetPoint.y + stubGap : Number.NEGATIVE_INFINITY,
      );
      sourceStub = { ...sourceStub, y: bottomLaneY };
      if (portSide(attempt.targetPort) === 'bottom') {
        targetStub = { ...targetStub, y: bottomLaneY };
      }
    }
    if (repeatCallFamilySource && sourceStub) {
      const sourceSide = portSide(attempt.sourcePort);
      if (sourceSide === 'bottom') {
        sourceStub = { ...sourceStub, y: Math.max(sourceStub.y, rawSourceBox.y + rawSourceBox.height + stubGap) };
      } else if (sourceSide === 'top') {
        sourceStub = { ...sourceStub, y: Math.min(sourceStub.y, rawSourceBox.y - stubGap) };
      } else if (sourceSide === 'left') {
        sourceStub = { ...sourceStub, x: Math.min(sourceStub.x, rawSourceBox.x - stubGap) };
      } else if (sourceSide === 'right') {
        sourceStub = { ...sourceStub, x: Math.max(sourceStub.x, rawSourceBox.x + rawSourceBox.width + stubGap) };
      }
    }
    // Terminal stubs are part of the candidate route. If one conflicts with a
    // corridor, reject that candidate instead of deleting the stub and cutting
    // directly through the endpoint's composite body.
    const routeContext = {
      sourceId: edge.start,
      sourcePort: attempt.sourcePort,
      sourcePoint,
      sourceStub,
      targetId: edge.end,
      targetPort: attempt.targetPort,
      targetPoint,
      targetStub,
      nodeObstacles: routeCoreNodeObstacles,
      corridorIndex,
      forbidForeignTargetCrossings: iterationRepeat,
      // A repeat may travel around the complete Step. Use structural Step
      // membership rather than a geometric endpoint window, while keeping
      // corridors from unrelated Steps out of this routing problem.
      crossingCorridors: repeatCrossingCorridors,
      // A FlowJoin is aligned to its lowest lateral entry. Higher siblings
      // should first reach the Join-side vertical and only then descend.
      preferredInitialAxis: lateralFlowJoinEntry || returningFalse ? 'h' : null,
    };
    const routeStart = sourceStub || sourcePoint;
    const routeEnd = targetStub || targetPoint;
    const fanoutTurnGraphX = Number(edge.props?.fanoutTurnGraphX);
    const baseFanoutTurnX = Number.isFinite(fanoutTurnGraphX)
      ? graphPointToDrawio({ x: fanoutTurnGraphX, y: 0 }, scale).x
      : undefined;
    const fanoutTurnX = (edge.type === 'ArgJoin' || edge.type === 'FieldJoin')
      && portSide(attempt.targetPort) === 'left'
      && targetStub
      ? targetStub.x
      : baseFanoutTurnX;
    let routeCore = (isFanoutEdge(edge) || localVisualResponse)
      && !relocatedSource
      && !directMosaicDataJoin
      && !edge.props?.compactCallStubJoin
      ? fanoutRouteCore(routeStart, routeEnd, fanoutTurnX)
      : findOrthogonalRoute(routeStart, routeEnd, nodeCenters, routedCorridors, routeContext);
    if (iterationRepeat || assignmentReturn || relocatedSource) {
      const routeBounds = [
        ...routeCoreNodeObstacles,
        ...(assignmentScopeBounds ? [assignmentScopeBounds] : []),
        ...repeatCrossingCorridors.filter((corridor) => !corridor.stepEntryBarrier).map((corridor) => corridor.axis === 'h'
          ? {
              left: Math.min(corridor.from, corridor.to),
              right: Math.max(corridor.from, corridor.to),
              top: corridor.y,
              bottom: corridor.y,
            }
          : {
              left: corridor.x,
              right: corridor.x,
              top: Math.min(corridor.from, corridor.to),
              bottom: Math.max(corridor.from, corridor.to),
            }),
      ];
      const clearance = ROUTE_OBSTACLE_CLEARANCE;
      const finiteBounds = (key) => routeBounds.map((box) => box[key]).filter(Number.isFinite);
      let leftX = Math.min(routeStart.x, routeEnd.x, ...finiteBounds('left')) - clearance;
      let rightX = Math.max(routeStart.x, routeEnd.x, ...finiteBounds('right')) + clearance;
      const entryBarrierXs = repeatCrossingCorridors
        .filter((corridor) => corridor.stepEntryBarrier && corridor.axis === 'v' && Number.isFinite(corridor.x))
        .map((corridor) => corridor.x);
      const endpointLeft = Math.min(routeStart.x, routeEnd.x);
      const endpointRight = Math.max(routeStart.x, routeEnd.x);
      const leftBarrierX = Math.max(...entryBarrierXs.filter((x) => x < endpointLeft), Number.NEGATIVE_INFINITY);
      const rightBarrierX = Math.min(...entryBarrierXs.filter((x) => x > endpointRight), Number.POSITIVE_INFINITY);
      if (Number.isFinite(leftBarrierX)) leftX = Math.max(leftX, leftBarrierX + clearance);
      if (Number.isFinite(rightBarrierX)) rightX = Math.min(rightX, rightBarrierX - clearance);
      const topY = Math.min(routeStart.y, routeEnd.y, ...finiteBounds('top')) - clearance;
      const bottomY = Math.max(routeStart.y, routeEnd.y, ...finiteBounds('bottom')) + clearance;
      const sourceSide = portSide(attempt.sourcePort);
      const localLaneOffset = ROUTE_CORRIDOR_AXIS_TOLERANCE + 1;
      const localDepartureY = sourceSide === 'top'
        ? routeStart.y - localLaneOffset
        : routeStart.y + localLaneOffset;
      const perimeterCandidates = [
        [routeStart, { x: leftX, y: routeStart.y }, { x: leftX, y: routeEnd.y }, routeEnd],
        [routeStart, { x: rightX, y: routeStart.y }, { x: rightX, y: routeEnd.y }, routeEnd],
        [routeStart, { x: routeStart.x, y: topY }, { x: routeEnd.x, y: topY }, routeEnd],
        [routeStart, { x: routeStart.x, y: bottomY }, { x: routeEnd.x, y: bottomY }, routeEnd],
        [
          routeStart,
          { x: routeStart.x, y: bottomY },
          { x: leftX, y: bottomY },
          { x: leftX, y: routeEnd.y },
          routeEnd,
        ],
        [
          routeStart,
          { x: routeStart.x, y: bottomY },
          { x: rightX, y: bottomY },
          { x: rightX, y: routeEnd.y },
          routeEnd,
        ],
        [
          routeStart,
          { x: routeStart.x, y: localDepartureY },
          { x: leftX, y: localDepartureY },
          { x: leftX, y: routeEnd.y },
          routeEnd,
        ],
        [
          routeStart,
          { x: routeStart.x, y: localDepartureY },
          { x: rightX, y: localDepartureY },
          { x: rightX, y: routeEnd.y },
          routeEnd,
        ],
      ];
      if (resumeInitialization) {
        // A resumed loop enters the binding from above, outside the entire body.
        const blockId = targetNode.props?.parentFlowBlockStableId || targetNode.props?.parent_flow_block_stable_id;
        const members = [...routeState.nodeById.values()].filter(node => blockId &&
          (node.props?.parentFlowBlockStableId || node.props?.parent_flow_block_stable_id) === blockId);
        const boxes = members.map(node => scale.nodeBoxes.get(node.id)).filter(Boolean);
        const outerRight = Math.max(rightX, ...boxes.map(box => box.x + box.width)) + clearance;
        const aboveEntry = Math.min(routeEnd.y, topY, ...boxes.map(box => box.y)) - clearance;
        perimeterCandidates.splice(0, perimeterCandidates.length, [routeStart,
          { x: outerRight, y: routeStart.y }, { x: outerRight, y: aboveEntry },
          { x: routeEnd.x, y: aboveEntry }, routeEnd]);
      }
      routeCore = selectBestRoute(
        resumeInitialization ? perimeterCandidates : [routeCore.points, ...perimeterCandidates],
        nodeCenters,
        routedCorridors,
        routeContext,
      ) || routeCore;
    }
    const corridorPoints = removeDuplicateRoutePoints([
      sourcePoint,
      ...(sourceStub ? [sourceStub] : []),
      ...routeCore.points,
      ...(targetStub ? [targetStub] : []),
      targetPoint,
    ]);
    const points = removeDuplicateRoutePoints([
      ...(sourceStub ? [sourceStub] : []),
      ...routeCore.points,
      ...(targetStub ? [targetStub] : []),
    ]);
    const centerHitCount = routeNodeCenterHitCount(corridorPoints, nodeCenters);
    const nodeBoxHitCount = routeNodeBoxHitCount(corridorPoints, [
      ...nodeObstacles,
      ...endpointRenderPartObstacles,
    ]);
    const foreignTargetConflictCount = routeForeignTargetConflictCount(corridorPoints, routedCorridors, routeContext);
    const sameTargetCorridorCount = routeSameTargetCorridorCount(corridorPoints, routedCorridors, routeContext);
    const ok = routeCore.ok
      && centerHitCount === 0
      && nodeBoxHitCount === 0
      && foreignTargetConflictCount === 0;
    if (edge.props?.compactCallStubJoin && nodeBoxHitCount > 0) {
      const blockerIds = nodeObstacles
        .filter((box) => routeSegments(corridorPoints).some((segment) => segmentCrossesBox(segment, box)))
        .map((box) => `${box.id}[${box.left},${box.top},${box.right},${box.bottom}]`);
      throw new Error(`Compact stub join route intersects ${nodeBoxHitCount} rendered node box(es) [${blockerIds.join(', ')}]: ${edge.start} -> ${edge.end}; route=${JSON.stringify(corridorPoints)}`);
    }
    const routeLength = routeManhattanLength(corridorPoints);
    const bendCount = Math.max(0, corridorPoints.length - 2);
    const preferredProducerPort = producerRouteRole === 'return-top'
      ? 'top'
      : producerRouteRole === 'return-bottom'
        ? 'bottom'
        : '';
    const producerPortDeviation = preferredProducerPort
      ? Number(portSide(attempt.sourcePort) !== preferredProducerPort)
        + Number(portSide(attempt.targetPort) !== preferredProducerPort)
      : 0;
    const strictOutcomePortDeviation = strictOperandOutcomeSourcePort
      ? Number(portSide(attempt.sourcePort) !== strictOperandOutcomeSourcePort)
      : 0;
    const yieldReturnPortDeviation = ordinaryYieldReturn
      ? Number(portSide(attempt.sourcePort) !== 'right')
      : 0;
    const semanticPortDeviation = producerPortDeviation
      + strictOutcomePortDeviation
      + yieldReturnPortDeviation;
    const score = routeLength;
    if (!selectedRoute
      || (ok && !selectedRoute.ok)
      || (ok === selectedRoute.ok && (
        semanticPortDeviation < selectedRoute.semanticPortDeviation
        || (semanticPortDeviation === selectedRoute.semanticPortDeviation && routeLength < selectedRoute.routeLength)
        || (semanticPortDeviation === selectedRoute.semanticPortDeviation
          && routeLength === selectedRoute.routeLength && bendCount < selectedRoute.bendCount)
        || (routeLength === selectedRoute.routeLength
          && semanticPortDeviation === selectedRoute.semanticPortDeviation
          && bendCount === selectedRoute.bendCount
          && sameTargetCorridorCount > selectedRoute.sameTargetCorridorCount)
      ))) {
      selectedRoute = {
        ...attempt,
        sourcePoint,
        sourceStub,
        targetPoint,
        targetStub,
        fanoutTurnX,
        points,
        corridorPoints,
        ok,
        score,
        routeLength,
        bendCount,
        producerPortDeviation,
        semanticPortDeviation,
        sameTargetCorridorCount,
        centerHitCount,
        nodeBoxHitCount,
        foreignTargetConflictCount,
      };
    }
    if (ok && !compareAllPortCandidates) break;
  }
  if (!selectedRoute) return edge;
  if (assignmentReturn && !selectedRoute.ok) {
    const blockingNodeIds = [...nodeObstacles, ...endpointRenderPartObstacles]
      .filter((box) => routeSegments(selectedRoute.corridorPoints).some((segment) => segmentCrossesBox(segment, box)))
      .map((box) => box.id);
    throw new Error(`Assignment value route intersects its extractor-bounded SubStep: ${edge.start} -> ${edge.end}; centers=${selectedRoute.centerHitCount}; boxes=${selectedRoute.nodeBoxHitCount}[${dedupeValues(blockingNodeIds).join(',')}]; corridors=${selectedRoute.foreignTargetConflictCount}; route=${JSON.stringify(selectedRoute.corridorPoints)}`);
  }
  if (strictOperandOutcome && !selectedRoute.ok) {
    throw new Error(`Operand outcome route intersects positioned nodes or foreign corridors: ${edge.start} -> ${edge.end}; centers=${selectedRoute.centerHitCount}; boxes=${selectedRoute.nodeBoxHitCount}; corridors=${selectedRoute.foreignTargetConflictCount}; route=${JSON.stringify(selectedRoute.corridorPoints)}`);
  }
  if (iterationRepeat && !selectedRoute.ok) {
    const blockingNodeIds = routeCoreNodeObstacles
      .filter((box) => routeSegments(selectedRoute.corridorPoints).some((segment) => segmentCrossesBox(segment, box)))
      .map((box) => box.id);
    const diagnosticRouteContext = {
      sourceId: edge.start,
      sourcePort: selectedRoute.sourcePort,
      targetId: edge.end,
      targetPort: selectedRoute.targetPort,
      forbidForeignTargetCrossings: true,
      crossingCorridors: repeatCrossingCorridors,
    };
    const conflictingCorridors = repeatCrossingCorridors
      .filter((corridor) => routeSegments(selectedRoute.corridorPoints).some((segment) => (
        segmentForeignTargetConflictCount(segment, [corridor], {
          ...diagnosticRouteContext,
          crossingCorridors: [corridor],
        }) > 0
      )))
      .map((corridor) => `${corridor.sourceId}->${corridor.targetId}:${corridor.axis}`);
    throw new Error(`Iteration repeat route intersects positioned SubSteps: ${edge.start} -> ${edge.end}; centers=${selectedRoute.centerHitCount}; boxes=${selectedRoute.nodeBoxHitCount}[${dedupeValues(blockingNodeIds).join(',')}]; corridors=${selectedRoute.foreignTargetConflictCount}[${dedupeValues(conflictingCorridors).slice(0, 10).join(',')}]; route=${JSON.stringify(selectedRoute.corridorPoints)}`);
  }
  const points = selectedRoute.points;
  const sourcePortSide = portSide(selectedRoute.sourcePort);
  const coordinatedSourceJetty = (sourcePortSide === 'top' || sourcePortSide === 'bottom')
    && Math.abs(selectedRoute.sourcePoint.x - selectedRoute.targetPoint.x) >= 1
    ? terminalJettyDistance(selectedRoute.corridorPoints, selectedRoute.sourcePort)
    : 0;
  registerNodePortUsage(
    routeState.portUsageByNode,
    sourcePortOwnerId,
    sourceBox,
    selectedRoute.sourcePort,
    'outgoing',
    edge.type,
    sharedHorizontalFamilySource,
  );
  registerNodePortUsage(routeState.portUsageByNode, targetPortOwnerId, targetBox, selectedRoute.targetPort, 'incoming', edge.type);
  registerRouteCorridors(routedCorridors, selectedRoute.corridorPoints, {
    sourceId: edge.start,
    sourcePort: selectedRoute.sourcePort,
    targetId: edge.end,
    targetPort: selectedRoute.targetPort,
  });
  return {
    ...edge,
    props: {
      ...edge.props,
      sourcePort: selectedRoute.sourcePort,
      targetPort: selectedRoute.targetPort,
      ...(isFanoutEdge(edge) && (
        Number.isFinite(selectedRoute.fanoutTurnX)
        || edge.type === 'ARG'
        || edge.type === 'FIELD'
      )
        ? {
            sourceJettySize: portSide(selectedRoute.sourcePort) === 'right'
              && Number.isFinite(selectedRoute.fanoutTurnX)
              && Math.abs(selectedRoute.sourcePoint.y - selectedRoute.targetPoint.y) >= 1
              ? Math.max(stubGap, selectedRoute.fanoutTurnX - selectedRoute.sourcePoint.x)
              : portSide(selectedRoute.sourcePort) === 'bottom' && selectedRoute.sourceStub
                ? Math.max(stubGap, selectedRoute.sourceStub.y - selectedRoute.sourcePoint.y)
                : stubGap,
          }
        : {}),
      ...(coordinatedSourceJetty > stubGap
        ? { sourceJettySize: coordinatedSourceJetty }
        : {}),
      ...((edge.type === 'ArgJoin' || edge.type === 'FieldJoin')
        && portSide(selectedRoute.targetPort) === 'left'
        && selectedRoute.targetStub
        ? { targetJettySize: Math.max(stubGap / 2, selectedRoute.targetPoint.x - selectedRoute.targetStub.x) }
        : {}),
      ...((edge.props?.compactCallStubJoin
        || directMosaicDataJoin
        || iterationRepeat
        || edge.props?.optionalReturnGroupStableId
        || edge.props?.optional_return_group_stable_id
        || edge.type === 'ASSIGNS_VALUE'
        || lateralFlowJoinEntry
        || returningFalse
        || edge.props?.lockResolvedRoutePoints
        || edge.type === 'ARG'
        || edge.type === 'FIELD')
        ? { lockRoutePoints: true }
        : {}),
      explicitPoints: points,
      layoutRouteReason: [
        edge.props?.layoutRouteReason,
        'coordinated route: avoids node centers and corridors owned by another target; prefers corridors to the same target',
      ].filter(Boolean).join('; '),
      layoutRouteLength: selectedRoute.routeLength,
    },
  };
}

function buildPortAttempts(sourceBox, targetBox, explicitSourcePort, explicitTargetPort, options = {}) {
  const blockedSourcePorts = options.blockedSourcePorts || new Set();
  const filterBlocked = (attempts) => attempts.filter((attempt) => !blockedSourcePorts.has(attempt.sourcePort));
  const sourceCenter = boxCenter(sourceBox);
  const targetCenter = boxCenter(targetBox);
  const alignedDownwardNext = options.edgeType === 'NEXT'
    && targetCenter.y > sourceCenter.y
    && Math.abs(targetCenter.x - sourceCenter.x) <= 1
    && !explicitSourcePort
    && !explicitTargetPort
    && !normalizePortCandidates(options.explicitSourcePorts).length
    && !normalizePortCandidates(options.explicitTargetPorts).length;
  if (alignedDownwardNext && !blockedSourcePorts.has('bottom')) {
    return [{ sourcePort: 'bottom', targetPort: 'top' }];
  }
  const effectiveExplicitSourcePort = isBranchNode(options.sourceNode)
    && (options.edgeType === 'TRUE' || options.edgeType === 'FALSE')
    && explicitSourcePort === 'right'
    && targetCenter.x < sourceCenter.x
    ? 'left'
    : explicitSourcePort;
  const graphColumnsKnown = Number.isFinite(options.sourceGraphPosition?.x)
    && Number.isFinite(options.targetGraphPosition?.x);
  const rightColumnFlowBranchEdge = isFlowBranchNode(options.sourceNode)
    && (options.edgeType === 'TRUE' || options.edgeType === 'FALSE')
    && !options.iterationRepeat
    && (graphColumnsKnown
      ? options.targetGraphPosition.x > options.sourceGraphPosition.x
      : targetCenter.x > sourceCenter.x + 1);
  const preferredSourcePort = effectiveExplicitSourcePort || inferSourcePort(sourceBox, targetBox);
  const explicitSourcePorts = normalizePortCandidates(options.explicitSourcePorts);
  const explicitTargetPorts = normalizePortCandidates(options.explicitTargetPorts);
  const graphTargetIsLeft = Number.isFinite(options.sourceGraphPosition?.x)
    && Number.isFinite(options.targetGraphPosition?.x)
    && options.targetGraphPosition.x < options.sourceGraphPosition.x;
  const sourceIsAboveTarget = sourceBoxIsAboveTarget(sourceBox, targetBox);
  const preferredFlowJoinTargetPort = preferredTargetPortFromGraphPositions(
    options.sourceGraphPosition,
    options.targetGraphPosition,
  ) || inferTargetPort(sourceBox, targetBox);
  const sourcePorts = isFlowJoinNode(options.sourceNode)
    ? dedupeValues([
      ['top', 'right', 'bottom', 'left'].includes(preferredSourcePort) ? preferredSourcePort : null,
      'bottom',
      'right',
      'top',
      'left',
    ])
    : rightColumnFlowBranchEdge
    ? ['right', 'bottom', 'top', 'left']
    : isFlowValueOutcomeNode(options.sourceNode) && graphTargetIsLeft
    ? dedupeValues(['left', effectiveExplicitSourcePort, 'bottom', 'right'])
    : explicitSourcePorts.length
    ? explicitSourcePorts
    : options.sourceRenderPartEndpoint && options.edgeType === 'TRUE'
    ? ['top']
    : effectiveExplicitSourcePort
    ? [effectiveExplicitSourcePort]
    : options.sourceRenderPartEndpoint
    ? dedupeValues([
      options.edgeType === 'TRUE' ? 'top' : null,
      options.edgeType === 'FALSE' ? 'right' : null,
      ['top', 'right', 'bottom', 'left'].includes(preferredSourcePort) ? preferredSourcePort : null,
      'bottom',
      'right',
      'top',
      'left',
    ])
    : isFanoutType(options.edgeType)
    ? ['right']
    : isBranchNode(options.sourceNode)
    ? orderedBranchSourcePorts(sourceBox, targetBox, preferredSourcePort, options.sourceNode, options.edgeType)
    : orderedPorts({
      preferred: preferredSourcePort,
      fallback: ['bottom', 'right', 'top', 'left'],
      allowAll: true,
      role: 'source',
    });
  const targetPorts = explicitTargetPorts.length
    ? explicitTargetPorts
    : isFlowJoinNode(options.targetNode) && options.lateralFlowJoinEntry
    ? orderedPorts({
      preferred: preferredFlowJoinTargetPort,
      fallback: [],
      allowAll: true,
      role: 'target',
    })
    : options.incomingFromAbove || sourceIsAboveTarget
    ? ['top']
    : isFlowJoinNode(options.targetNode)
    ? orderedPorts({
      preferred: preferredFlowJoinTargetPort,
      fallback: [],
      allowAll: true,
      role: 'target',
    })
    : options.assignmentReturn
    ? (explicitTargetPorts.length
      ? explicitTargetPorts
      : orderedPorts({
        preferred: inferTargetPort(sourceBox, targetBox),
        fallback: [],
        allowAll: true,
        role: 'target',
      }))
    : explicitTargetPort
    ? [explicitTargetPort]
    : isFlowBranchNode(options.targetNode)
    ? orderedPorts({
      preferred: inferTargetPort(sourceBox, targetBox),
      fallback: ['left', 'right', 'top', 'bottom'],
      allowAll: true,
      role: 'target',
    })
    : options.targetNode?.props?.visualCallStub === true
    ? orderedPorts({
      preferred: 'left',
      fallback: ['left', 'top', 'bottom', 'right'],
      allowAll: false,
      role: 'target',
    })
    : isFlowValueOutcomeNode(options.targetNode)
    ? (options.edgeType === 'TRUE' || options.edgeType === 'FALSE') && sourceCenter.x > targetCenter.x
      ? ['right', 'top']
      : ['top']
    : isValueOutcomeNode(options.targetNode)
    ? ['right']
    : isSlotBranchNode(options.targetNode)
    ? ['left']
    : isHorizontalFamilyDescendantNode(options.targetNode)
    ? orderedPorts({
      preferred: 'left',
      fallback: ['left'],
      allowAll: false,
      role: 'target',
    })
    : orderedPorts({
      preferred: explicitTargetPort || inferTargetPort(sourceBox, targetBox),
      fallback: ['top', 'left'],
      allowAll: isObjectOrArgNode(options.targetNode),
      role: 'target',
    });
  const attempts = [];
  for (const sourcePort of sourcePorts) {
    for (const targetPort of targetPorts) {
      attempts.push({ sourcePort, targetPort });
    }
  }
  return filterBlocked(dedupePortAttempts(attempts));
}

function normalizePortCandidates(value) {
  if (!value) return [];
  if (Array.isArray(value)) return dedupeValues(value.map((item) => String(item || '').trim()));
  return dedupeValues(String(value).split(/[,\s]+/u).map((item) => item.trim()));
}

function isFanoutEdge(edge) {
  return isFanoutType(edge?.type);
}

function isFanoutType(type) {
  return type === 'ARG' || type === 'ArgJoin' || type === 'XOR_JOIN' || type === 'FIELD' || type === 'FieldJoin' || type === 'VALUE';
}

function dedupePortAttempts(attempts) {
  const seen = new Set();
  return attempts.filter((attempt) => {
    const key = `${attempt.sourcePort}->${attempt.targetPort}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function orderedPorts({ preferred, fallback, allowAll, role }) {
  const sides = allowAll
    ? role === 'source'
      ? ['bottom', 'right', 'top', 'left']
      : ['top', 'left', 'bottom', 'right']
    : fallback;
  const base = role === 'source' ? expandSourcePorts(sides) : sides;
  return dedupeValues([
    allowedPort(preferred, base) ? preferred : null,
    ...base,
  ]);
}

function allowedPort(port, allowedSides) {
  const side = portSide(port);
  return !!side && allowedSides.some((allowed) => portSide(allowed) === side);
}

function expandSourcePorts(sides) {
  const ports = [];
  for (const side of sides) {
    ports.push(side, `${side}-25`, `${side}-75`);
  }
  return ports;
}

function orderedBranchSourcePorts(sourceBox, targetBox, preferred, node, edgeType) {
  const sourceCenter = boxCenter(sourceBox);
  const targetCenter = boxCenter(targetBox);
  const targetBelow = targetCenter.y > sourceCenter.y;
  const targetSide = targetCenter.x < sourceCenter.x ? 'left' : 'right';
  const otherSide = targetSide === 'left' ? 'right' : 'left';
  const allowed = isSlotBranchNode(node)
    ? ['bottom', targetSide, otherSide, 'right-top', 'right-bottom']
    : targetBelow
    ? ['bottom', targetSide, otherSide]
    : targetSide === 'left'
    ? ['left', 'bottom', otherSide]
    : ['bottom', targetSide, otherSide];
  const effectivePreferred = targetBelow ? 'bottom' : preferred;
  return dedupeValues([
    allowed.includes(effectivePreferred) ? effectivePreferred : null,
    ...allowed,
  ]);
}

function isBranchNode(node) {
  return hasLabel(node, 'Branch');
}

function isFlowBranchNode(node) {
  return hasLabel(node, 'Branch') && hasLabel(node, 'Flow');
}

function isSlotBranchNode(node) {
  return hasLabel(node, 'Branch') && (hasLabel(node, 'Arg') || hasLabel(node, 'Field'));
}

function isOperandBranchNode(node) {
  return hasLabel(node, 'Branch') && hasLabel(node, 'Operand');
}

function isValueOutcomeNode(node) {
  return !!node?.labels?.includes('ValueOutcome');
}

function isFlowValueOutcomeNode(node) {
  return isValueOutcomeNode(node) && node.labels.includes('Flow');
}

function preferredTargetPortFromGraphPositions(source, target) {
  if (!Number.isFinite(source?.x)
    || !Number.isFinite(source?.y)
    || !Number.isFinite(target?.x)
    || !Number.isFinite(target?.y)) return null;
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'left' : 'right';
  return dy >= 0 ? 'top' : 'bottom';
}

function isFalsyValueOutcomeNode(node) {
  return isValueOutcomeNode(node) && node.labels.includes('FalsyOutcome');
}

function isTruthyValueOutcomeNode(node) {
  return isValueOutcomeNode(node) && node.labels.includes('TruthyOutcome');
}

function portStubGap(scale) {
  const base = Math.min(Number(scale.scaleX) || 0, Number(scale.scaleY) || 0);
  if (!Number.isFinite(base) || base <= 0) return PORT_STUB_GAP_MIN;
  return Math.max(PORT_STUB_GAP_MIN, Math.min(PORT_STUB_GAP_MAX, Math.round(base * PORT_STUB_GAP_RATIO)));
}

function portStubPoint(point, port, gap) {
  const side = portSide(port);
  if (side === 'top') return { x: point.x, y: point.y - gap };
  if (side === 'bottom') return { x: point.x, y: point.y + gap };
  if (side === 'left') return { x: point.x - gap, y: point.y };
  if (side === 'right') return { x: point.x + gap, y: point.y };
  return null;
}

function terminalJettyDistance(points, port) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  const origin = points[0];
  const side = portSide(port);
  let distance = 0;
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    const nextDistance = side === 'top' && point.x === origin.x && point.y <= origin.y
      ? origin.y - point.y
      : side === 'bottom' && point.x === origin.x && point.y >= origin.y
        ? point.y - origin.y
        : side === 'left' && point.y === origin.y && point.x <= origin.x
          ? origin.x - point.x
          : side === 'right' && point.y === origin.y && point.x >= origin.x
            ? point.x - origin.x
            : undefined;
    if (!Number.isFinite(nextDistance) || nextDistance < distance) break;
    distance = nextDistance;
  }
  return distance;
}

function fanoutPortStubPoints(sourceId, sourcePoint, sourcePort, targetPoint, targetPort, gap, routeState = {}) {
  const sourceStub = fanoutSourceStubPoint(sourceId, sourcePoint, sourcePort, targetPoint, gap, routeState);
  const targetSide = portSide(targetPort);
  if (targetSide === 'left' && targetPoint.x > sourcePoint.x && sourceStub.x < targetPoint.x) {
    return [sourceStub, portStubPoint(targetPoint, targetPort, gap)];
  }
  return [sourceStub, portStubPoint(targetPoint, targetPort, gap)];
}

function fanoutSourceStubPoint(sourceId, sourcePoint, sourcePort, targetPoint, gap, routeState = {}) {
  const cacheKey = `${sourceId}:${sourcePort || 'right'}`;
  const cached = routeState.fanoutSourceStubBySource?.get(cacheKey);
  if (cached) return cached;
  let stub;
  if (portSide(sourcePort) !== 'right') {
    stub = portStubPoint(sourcePoint, sourcePort, gap) || { x: sourcePoint.x, y: sourcePoint.y };
  } else if (targetPoint && targetPoint.x > sourcePoint.x) {
    stub = { x: sourcePoint.x + Math.min(50, gap, (targetPoint.x - sourcePoint.x) / 2), y: sourcePoint.y };
  } else {
    stub = { x: sourcePoint.x + Math.min(50, gap), y: sourcePoint.y };
  }
  routeState.fanoutSourceStubBySource?.set(cacheKey, stub);
  return stub;
}

function fanoutRouteCore(sourceStub, targetStub, commonTurnX) {
  const turnX = Number.isFinite(commonTurnX)
    ? Math.max(sourceStub.x, Math.min(commonTurnX, targetStub.x))
    : sourceStub.x;
  return {
    points: removeDuplicateRoutePoints([
      sourceStub,
      { x: turnX, y: sourceStub.y },
      { x: turnX, y: targetStub.y },
      targetStub,
    ]),
    ok: true,
    score: 0,
  };
}

function pairedPortStubPoints(sourcePoint, sourcePort, targetPoint, targetPort, gap) {
  if (!sourcePoint || !targetPoint) {
    return [
      sourcePoint ? portStubPoint(sourcePoint, sourcePort, gap) : null,
      targetPoint ? portStubPoint(targetPoint, targetPort, gap) : null,
    ];
  }
  const sourceSide = portSide(sourcePort);
  const targetSide = portSide(targetPort);
  if (
    sourceSide
    && targetSide
    && sharesPortAxis(sourcePoint, targetPoint, sourcePort)
    && sharesPortAxis(sourcePoint, targetPoint, targetPort)
    && manhattanDistance(sourcePoint, targetPoint) <= gap * 2
  ) {
    return [null, null];
  }
  return [
    portStubPoint(sourcePoint, sourcePort, gap),
    portStubPoint(targetPoint, targetPort, gap),
  ];
}

function isHorizontalFamilyDescendantNode(node) {
  if (!node?.labels?.length) return false;
  if (isObjectStartNode(node)) return false;
  return isCallFinishNode(node)
    || isArgJoinNode(node)
    || isFieldJoinNode(node)
    || node.labels.some((label) => (
      label === 'Arg'
      || label === 'Object'
    ));
}

function isObjectOrArgNode(node) {
  return isArgJoinNode(node)
    || isFieldJoinNode(node)
    || !!node?.labels?.some((label) => (
      label === 'Arg'
      || label === 'Object'
      || label === 'FlowObject'
      || label === 'CreatedObject'
      || /Arg|Object|Field/u.test(label)
    ));
}

function portSide(port) {
  const parsed = parsePercentPort(port);
  if (parsed) return parsed.side;
  if (port === 'hex-right-top' || port === 'hex-right-bottom') return 'right';
  if (port === 'bottom-left' || port === 'bottom-right') return 'bottom';
  if (port === 'top' || port === 'bottom' || port === 'left' || port === 'right') return port;
  if (String(port || '').startsWith('top-')) return 'top';
  if (String(port || '').startsWith('bottom-')) return 'bottom';
  if (String(port || '').startsWith('left-')) return 'left';
  if (String(port || '').startsWith('right-')) return 'right';
  return null;
}

function inferSourcePort(sourceBox, targetBox) {
  const sourceCenter = boxCenter(sourceBox);
  const targetCenter = boxCenter(targetBox);
  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

function inferTargetPort(sourceBox, targetBox) {
  const sourceCenter = boxCenter(sourceBox);
  const targetCenter = boxCenter(targetBox);
  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'left' : 'right';
  return dy >= 0 ? 'top' : 'bottom';
}

function boxCenter(box) {
  return {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2),
  };
}

function buildBlockedNodeCenters(nodeBoxes, allowedIds) {
  const centers = [];
  for (const [id, box] of nodeBoxes.entries()) {
    if (allowedIds.has(id)) continue;
    centers.push({ id, ...boxCenter(box) });
  }
  return centers;
}

function buildBlockedNodeObstacles(nodeBoxes, allowedIds) {
  const obstacles = [];
  for (const [id, box] of nodeBoxes.entries()) {
    if (allowedIds.has(id)) continue;
    obstacles.push({
      id,
      left: box.x,
      right: box.x + box.width,
      top: box.y,
      bottom: box.y + box.height,
    });
  }
  return obstacles;
}

function routeObstacleOverlapsNodeBox(obstacle, box) {
  if (!obstacle || !box) return false;
  return obstacle.left < box.x + box.width
    && obstacle.right > box.x
    && obstacle.top < box.y + box.height
    && obstacle.bottom > box.y;
}

function findOrthogonalRoute(sourcePoint, targetPoint, nodeCenters, routedCorridors, routeContext) {
  const directCandidates = buildRouteCandidates(sourcePoint, targetPoint);
  const direct = selectBestRoute(directCandidates, nodeCenters, routedCorridors, routeContext);
  if (direct?.ok) return direct;

  const gridRoute = findOrthogonalGridRoute(sourcePoint, targetPoint, nodeCenters, routedCorridors, routeContext);
  const candidates = [
    ...(gridRoute?.points ? [gridRoute.points] : []),
    ...directCandidates,
  ];
  return selectBestRoute(candidates, nodeCenters, routedCorridors, routeContext)
    || { points: removeDuplicateRoutePoints(candidates[0]), ok: false, score: Number.POSITIVE_INFINITY };
}

function selectBestRoute(candidates, nodeCenters, routedCorridors, routeContext) {
  let best = null;
  for (const candidate of candidates) {
    const points = removeDuplicateRoutePoints(candidate);
    const centerHitCount = routeNodeCenterHitCount(points, nodeCenters);
    const nodeBoxHitCount = routeNodeBoxHitCount(points, routeContext.nodeObstacles || []);
    const foreignTargetConflictCount = routeForeignTargetConflictCount(points, routedCorridors, routeContext);
    const sameTargetCorridorCount = routeSameTargetCorridorCount(points, routedCorridors, routeContext);
    const ok = centerHitCount === 0
      && nodeBoxHitCount === 0
      && foreignTargetConflictCount === 0;
    const routeLength = routeManhattanLength(points);
    const bendCount = Math.max(0, points.length - 2);
    const initialAxis = routeSegments(points)[0]?.axis || null;
    const initialAxisDeviation = routeContext.preferredInitialAxis
      ? Number(initialAxis !== routeContext.preferredInitialAxis)
      : 0;
    if (!best
      || (ok && !best.ok)
      || (ok === best.ok && (
        routeLength < best.routeLength
        || (routeLength === best.routeLength
          && initialAxisDeviation < best.initialAxisDeviation)
        || (routeLength === best.routeLength
          && initialAxisDeviation === best.initialAxisDeviation
          && bendCount < best.bendCount)
        || (routeLength === best.routeLength
          && initialAxisDeviation === best.initialAxisDeviation
          && bendCount === best.bendCount
          && sameTargetCorridorCount > best.sameTargetCorridorCount)
      ))) best = {
      points,
      ok,
      score: routeLength,
      routeLength,
      bendCount,
      initialAxisDeviation,
      sameTargetCorridorCount,
    };
  }
  return best;
}

function findOrthogonalGridRoute(sourcePoint, targetPoint, nodeCenters, routedCorridors, routeContext) {
  const profileStartedAt = process.env.DEBUG_LOCAL_ROUTE_GRID === '1' ? Date.now() : 0;
  const xs = routeAxesFor('x', sourcePoint, targetPoint, nodeCenters, routedCorridors, routeContext.nodeObstacles || [], routeContext);
  const ys = routeAxesFor('y', sourcePoint, targetPoint, nodeCenters, routedCorridors, routeContext.nodeObstacles || [], routeContext);
  const start = snapRoutePoint(sourcePoint);
  const goal = snapRoutePoint(targetPoint);
  if (!xs.includes(start.x)) xs.push(start.x);
  if (!xs.includes(goal.x)) xs.push(goal.x);
  if (!ys.includes(start.y)) ys.push(start.y);
  if (!ys.includes(goal.y)) ys.push(goal.y);
  xs.sort((left, right) => left - right);
  ys.sort((left, right) => left - right);

  const compareRouteStates = (left, right) => (
    (left.priority - right.priority)
    || (left.cost - right.cost)
    || left.key.localeCompare(right.key)
  );
  const open = new MinHeap(compareRouteStates);
  const initialState = {
    point: start,
    key: routePointKey(start),
    cost: 0,
    priority: manhattanDistance(start, goal),
    previousKey: null,
    direction: null,
  };
  open.push(initialState);
  const bestByKey = new Map([[initialState.key, initialState]]);
  const closed = new Set();
  let goalState = null;
  let expandedStateCount = 0;
  const xIndexByValue = new Map(xs.map((value, index) => [value, index]));
  const yIndexByValue = new Map(ys.map((value, index) => [value, index]));

  while (open.size) {
    const current = open.pop();
    if (!current || closed.has(current.key)) continue;
    if (bestByKey.get(current.key) !== current) continue;
    if (current.key === routePointKey(goal)) {
      goalState = current;
      break;
    }
    closed.add(current.key);
    expandedStateCount += 1;

    for (const next of routeGridNeighbors(current.point, xs, ys, xIndexByValue, yIndexByValue)) {
      if (next.key === current.key || closed.has(next.key)) continue;
      const segment = {
        a: current.point,
        b: next.point,
        axis: current.point.y === next.point.y ? 'h' : 'v',
      };
      const centerHits = segmentNodeCenterHitCount(segment, nodeCenters);
      const nodeBoxHits = segmentNodeBoxHitCount(segment, routeContext.nodeObstacles || []);
      const foreignTargetHits = segmentForeignTargetConflictCount(segment, routedCorridors, routeContext);
      if (nodeBoxHits > 0 || foreignTargetHits > 0) continue;
      const segmentLength = manhattanDistance(current.point, next.point);
      const initialAxisPenalty = current.direction === null
        && routeContext.preferredInitialAxis
        && segment.axis !== routeContext.preferredInitialAxis
        ? 0.001
        : 0;
      const bendPenalty = current.direction !== null && current.direction !== next.direction
        ? 0.001
        : 0;
      const nextCost = current.cost
        + segmentLength
        + initialAxisPenalty
        + bendPenalty
        + centerHits * 100000
        + nodeBoxHits * 100000;
      const existing = bestByKey.get(next.key);
      if (existing && existing.cost <= nextCost) continue;
      const state = {
        point: next.point,
        key: next.key,
        cost: nextCost,
        priority: nextCost + manhattanDistance(next.point, goal),
        previousKey: current.key,
        direction: next.direction,
      };
      bestByKey.set(next.key, state);
      open.push(state);
    }
  }

  if (profileStartedAt) {
    const elapsedMs = Date.now() - profileStartedAt;
    if (elapsedMs >= 50) {
      console.error(`[route:grid] ms=${elapsedMs} xs=${xs.length} ys=${ys.length} expanded=${expandedStateCount} obstacles=${routeContext.nodeObstacles?.length || 0} corridors=${routedCorridors.length} source=${routeContext.sourceId} target=${routeContext.targetId}`);
    }
  }

  if (!goalState) {
    if (process.env.DEBUG_LOCAL_ROUTE_GRID === '1') {
      console.error(`[route:grid:no-path] source=${routeContext.sourceId} target=${routeContext.targetId} start=${JSON.stringify(start)} goal=${JSON.stringify(goal)} xs=${JSON.stringify(xs)} ys=${JSON.stringify(ys)} obstacles=${JSON.stringify(routeContext.nodeObstacles || [])}`);
    }
    return null;
  }
  const route = [];
  for (let state = goalState; state; state = bestByKey.get(state.previousKey)) {
    route.push(state.point);
  }
  route.reverse();
  const points = compressRouteToBends(removeDuplicateRoutePoints(route));
  const centerHitCount = routeNodeCenterHitCount(points, nodeCenters);
  const nodeBoxHitCount = routeNodeBoxHitCount(points, routeContext.nodeObstacles || []);
  const foreignTargetConflictCount = routeForeignTargetConflictCount(points, routedCorridors, routeContext);
  return {
    points,
    ok: centerHitCount === 0
      && nodeBoxHitCount === 0
      && foreignTargetConflictCount === 0,
    score: goalState.cost,
  };
}

class MinHeap {
  constructor(compare) {
    this.items = [];
    this.compare = compare;
  }

  get size() {
    return this.items.length;
  }

  push(value) {
    const items = this.items;
    items.push(value);
    let index = items.length - 1;
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.compare(items[parentIndex], value) <= 0) break;
      items[index] = items[parentIndex];
      index = parentIndex;
    }
    items[index] = value;
  }

  pop() {
    const items = this.items;
    if (!items.length) return undefined;
    const root = items[0];
    const last = items.pop();
    if (!items.length) return root;
    let index = 0;
    while (true) {
      const leftIndex = index * 2 + 1;
      if (leftIndex >= items.length) break;
      const rightIndex = leftIndex + 1;
      let childIndex = leftIndex;
      if (rightIndex < items.length && this.compare(items[rightIndex], items[leftIndex]) < 0) {
        childIndex = rightIndex;
      }
      if (this.compare(items[childIndex], last) >= 0) break;
      items[index] = items[childIndex];
      index = childIndex;
    }
    items[index] = last;
    return root;
  }
}

function sourceBoxIsAboveTarget(sourceBox, targetBox) {
  if (!sourceBox || !targetBox) return false;
  return sourceBox.y + sourceBox.height <= targetBox.y + 1;
}

function effectiveFoldedRoutingBox(nodeId, box, layout) {
  const detached = layout?.detachedFlowJoinByNodeId?.get(nodeId);
  if (detached) {
    return {
      ...box,
      x: detached.globalX,
      y: layout.y + detached.globalY,
      width: detached.width ?? box.width,
      height: detached.height ?? box.height,
    };
  }
  const row = layout?.rowByNodeId?.get(nodeId);
  if (!row) return { ...box };
  return {
    ...box,
    x: box.x,
    y: layout.y + row.y + FOLDING_ROW_TOP_PADDING + box.y - row.contentMinY,
  };
}

function expandAvailablePortAttempts(
  attempts,
  portUsageByNode,
  sourceId,
  sourceBox,
  targetId,
  targetBox,
  edgeType = '',
  allowSharedOutgoing = false,
) {
  const sourceSides = dedupeValues(attempts.map((attempt) => portSide(attempt.sourcePort)));
  const targetSides = dedupeValues(attempts.map((attempt) => portSide(attempt.targetPort)));
  let sourcePorts = dedupeValues(attempts.map((attempt) => attempt.sourcePort))
    .filter((port) => !nodePortUsage(portUsageByNode, sourceId, sourceBox, port));
  if (!sourcePorts.length) {
    sourcePorts = sourceSides.flatMap((side) => Array.from({ length: 99 }, (_, index) => {
      const percent = index + 1;
      return percent === 50 ? side : `${side}-${percent}`;
    })).filter((port) => !nodePortUsage(portUsageByNode, sourceId, sourceBox, port));
  }
  let targetPorts = dedupeValues(attempts.map((attempt) => attempt.targetPort))
    .filter((port) => {
      const usage = nodePortUsage(portUsageByNode, targetId, targetBox, port);
      return !usage?.outgoing && !usage?.exclusiveIncoming;
    });
  if (!targetPorts.length) {
    targetPorts = targetSides.flatMap((side) => Array.from({ length: 99 }, (_, index) => {
      const percent = index + 1;
      return percent === 50 ? side : `${side}-${percent}`;
    })).filter((port) => {
      const usage = nodePortUsage(portUsageByNode, targetId, targetBox, port);
      return !usage?.outgoing && !usage?.exclusiveIncoming;
    });
  }
  return dedupePortAttempts(sourcePorts.flatMap((sourcePort) => targetPorts.map((targetPort) => ({
    sourcePort,
    targetPort,
  })))).filter((attempt) => portAttemptIsAvailable(
    portUsageByNode,
    sourceId,
    sourceBox,
    attempt.sourcePort,
    targetId,
    targetBox,
    attempt.targetPort,
    edgeType,
    allowSharedOutgoing,
  ));
}

function portUsageKey(_box, port) {
  const parsed = parsePercentPort(port);
  if (parsed) return `${parsed.side}:${parsed.ratio}`;
  const aliases = {
    top: 'top:0.5',
    right: 'right:0.5',
    bottom: 'bottom:0.5',
    left: 'left:0.5',
    'right-top': 'top:0.75',
    'right-bottom': 'bottom:0.75',
    'bottom-left': 'bottom:0.25',
    'bottom-right': 'bottom:0.75',
    'left-top': 'top:0.25',
    'left-bottom': 'bottom:0.25',
    'hex-right-top': 'top:0.75',
    'hex-right-bottom': 'bottom:0.75',
  };
  return aliases[port] || '';
}

function nodePortUsage(portUsageByNode, nodeId, box, port) {
  const key = portUsageKey(box, port);
  return key ? portUsageByNode?.get(nodeId)?.get(key) : undefined;
}

function nodePortSideUsage(portUsageByNode, nodeId, side) {
  const result = { incoming: 0, outgoing: 0 };
  if (!side) return result;
  for (const [key, usage] of portUsageByNode?.get(nodeId)?.entries() || []) {
    if (!key.startsWith(`${side}:`)) continue;
    result.incoming += Number(usage.incoming || 0);
    result.outgoing += Number(usage.outgoing || 0);
  }
  return result;
}

function registerNodePortUsage(
  portUsageByNode,
  nodeId,
  box,
  port,
  role,
  edgeType = '',
  allowSharedOutgoing = false,
) {
  const key = portUsageKey(box, port);
  if (!portUsageByNode || !nodeId || !key) return;
  if (!portUsageByNode.has(nodeId)) portUsageByNode.set(nodeId, new Map());
  const byPort = portUsageByNode.get(nodeId);
  if (!byPort.has(key)) byPort.set(key, {
    incoming: 0,
    outgoing: 0,
    exclusiveIncoming: false,
    outgoingTypes: new Set(),
  });
  const usage = byPort.get(key);
  const sharesSiblingFamily = allowSharedOutgoing
    && usage.incoming === 0
    && usage.outgoing > 0
    && usage.outgoingTypes?.size === 1
    && usage.outgoingTypes.has(edgeType);
  if (role === 'outgoing' && (usage.incoming > 0 || (usage.outgoing > 0 && !sharesSiblingFamily))) {
    throw new Error(`Outgoing route cannot share ${nodeId} port ${key}`);
  }
  if (role === 'incoming' && usage.outgoing > 0) {
    throw new Error(`Incoming route cannot share ${nodeId} port ${key} with an outgoing route`);
  }
  usage[role] += 1;
  if (role === 'outgoing' && edgeType) usage.outgoingTypes.add(edgeType);
  if (role === 'incoming' && edgeType === 'EVAL') usage.exclusiveIncoming = true;
}

function portAttemptIsAvailable(
  portUsageByNode,
  sourceId,
  sourceBox,
  sourcePort,
  targetId,
  targetBox,
  targetPort,
  edgeType = '',
  allowSharedOutgoing = false,
) {
  const sourceUsage = nodePortUsage(portUsageByNode, sourceId, sourceBox, sourcePort);
  const sharesSiblingFamily = allowSharedOutgoing
    && sourceUsage?.incoming === 0
    && sourceUsage?.outgoing > 0
    && sourceUsage.outgoingTypes?.size === 1
    && sourceUsage.outgoingTypes.has(edgeType);
  if (sourceUsage && (sourceUsage.incoming > 0 || (sourceUsage.outgoing > 0 && !sharesSiblingFamily))) return false;
  const targetUsage = nodePortUsage(portUsageByNode, targetId, targetBox, targetPort);
  if (targetUsage?.outgoing > 0 || targetUsage?.exclusiveIncoming) return false;
  if (sourceId === targetId && portUsageKey(sourceBox, sourcePort) === portUsageKey(targetBox, targetPort)) return false;
  return true;
}

function routeAxesFor(axis, sourcePoint, targetPoint, nodeCenters, routedCorridors, nodeObstacles = [], routeContext = {}) {
  const values = new Set([Math.round(sourcePoint[axis]), Math.round(targetPoint[axis])]);
  const otherAxis = axis === 'x' ? 'y' : 'x';
  const min = Math.min(sourcePoint[axis], targetPoint[axis]);
  const max = Math.max(sourcePoint[axis], targetPoint[axis]);
  const span = Math.max(80, max - min);
  const margin = Math.max(40, Math.round(span * 0.35));
  values.add(Math.round(min - margin));
  values.add(Math.round(max + margin));

  const otherMin = Math.min(sourcePoint[otherAxis], targetPoint[otherAxis]);
  const otherMax = Math.max(sourcePoint[otherAxis], targetPoint[otherAxis]);
  const otherSpan = Math.max(80, otherMax - otherMin);
  const otherMargin = Math.max(160, Math.round(otherSpan * 0.5));
  for (const center of nodeCenters) {
    if (center[axis] < min - margin || center[axis] > max + margin) continue;
    if (center[otherAxis] < otherMin - otherMargin || center[otherAxis] > otherMax + otherMargin) continue;
    const value = Math.round(center[axis]);
    values.add(value);
    values.add(value - 40);
    values.add(value + 40);
    if (center[otherAxis] >= otherMin - margin
      && center[otherAxis] <= otherMax + margin) {
      values.add(value - 80);
      values.add(value + 80);
    }
  }

  for (const obstacle of nodeObstacles) {
    if (axis === 'x') {
      values.add(Math.round(obstacle.left - ROUTE_OBSTACLE_CLEARANCE));
      values.add(Math.round(obstacle.right + ROUTE_OBSTACLE_CLEARANCE));
    } else {
      values.add(Math.round(obstacle.top - ROUTE_OBSTACLE_CLEARANCE));
      values.add(Math.round(obstacle.bottom + ROUTE_OBSTACLE_CLEARANCE));
    }
  }

  for (const corridor of routedCorridors) {
    if (axis === 'x' && corridor.axis === 'v') {
      if (corridor.x < min - margin || corridor.x > max + margin) continue;
      values.add(Math.round(corridor.x));
      values.add(Math.round(corridor.x - 40));
      values.add(Math.round(corridor.x + 40));
    } else if (axis === 'y' && corridor.axis === 'h') {
      if (corridor.y < min - margin || corridor.y > max + margin) continue;
      values.add(Math.round(corridor.y));
      values.add(Math.round(corridor.y - 40));
      values.add(Math.round(corridor.y + 40));
    }
    if (routeContext.forbidForeignTargetCrossings
      && (routeContext.crossingCorridors || routedCorridors).includes(corridor)
      && corridor.targetId !== routeContext.targetId) {
      if (axis === 'x' && corridor.axis === 'h') {
        values.add(Math.round(Math.min(corridor.from, corridor.to) - ROUTE_OBSTACLE_CLEARANCE));
        values.add(Math.round(Math.max(corridor.from, corridor.to) + ROUTE_OBSTACLE_CLEARANCE));
      } else if (axis === 'y' && corridor.axis === 'v') {
        values.add(Math.round(Math.min(corridor.from, corridor.to) - ROUTE_OBSTACLE_CLEARANCE));
        values.add(Math.round(Math.max(corridor.from, corridor.to) + ROUTE_OBSTACLE_CLEARANCE));
      }
    }
  }

  return [...values].filter(Number.isFinite);
}

function snapRoutePoint(point) {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

function routePointKey(point) {
  return `${point.x}:${point.y}`;
}

function routeGridNeighbors(point, xs, ys, xIndexByValue, yIndexByValue) {
  const xIndex = xIndexByValue.get(point.x) ?? -1;
  const yIndex = yIndexByValue.get(point.y) ?? -1;
  const result = [];
  if (xIndex > 0) result.push({ point: { x: xs[xIndex - 1], y: point.y }, key: `${xs[xIndex - 1]}:${point.y}`, direction: 'left' });
  if (xIndex >= 0 && xIndex < xs.length - 1) result.push({ point: { x: xs[xIndex + 1], y: point.y }, key: `${xs[xIndex + 1]}:${point.y}`, direction: 'right' });
  if (yIndex > 0) result.push({ point: { x: point.x, y: ys[yIndex - 1] }, key: `${point.x}:${ys[yIndex - 1]}`, direction: 'up' });
  if (yIndex >= 0 && yIndex < ys.length - 1) result.push({ point: { x: point.x, y: ys[yIndex + 1] }, key: `${point.x}:${ys[yIndex + 1]}`, direction: 'down' });
  return result;
}

function manhattanDistance(left, right) {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y);
}

function compressRouteToBends(route) {
  if (route.length <= 2) return route;
  const result = [route[0]];
  for (let index = 1; index < route.length - 1; index += 1) {
    const previous = route[index - 1];
    const current = route[index];
    const next = route[index + 1];
    if ((previous.x === current.x && current.x === next.x)
      || (previous.y === current.y && current.y === next.y)) {
      continue;
    }
    result.push(current);
  }
  result.push(route[route.length - 1]);
  return result;
}

function buildRouteCandidates(sourcePoint, targetPoint) {
  const step = 40;
  const minX = Math.min(sourcePoint.x, targetPoint.x);
  const maxX = Math.max(sourcePoint.x, targetPoint.x);
  const minY = Math.min(sourcePoint.y, targetPoint.y);
  const maxY = Math.max(sourcePoint.y, targetPoint.y);
  const candidates = [];
  if (sourcePoint.x === targetPoint.x || sourcePoint.y === targetPoint.y) {
    candidates.push([sourcePoint, targetPoint]);
  }
  candidates.push([sourcePoint, { x: targetPoint.x, y: sourcePoint.y }, targetPoint]);
  candidates.push([sourcePoint, { x: sourcePoint.x, y: targetPoint.y }, targetPoint]);
  for (const offset of [step, step * 2, step * 3, step * 4, step * 6]) {
    for (const y of [minY - offset, maxY + offset]) {
      candidates.push([sourcePoint, { x: sourcePoint.x, y }, { x: targetPoint.x, y }, targetPoint]);
    }
    for (const x of [minX - offset, maxX + offset]) {
      candidates.push([sourcePoint, { x, y: sourcePoint.y }, { x, y: targetPoint.y }, targetPoint]);
    }
  }
  return candidates.map(removeDuplicateRoutePoints);
}

function removeDuplicateRoutePoints(route) {
  const result = [];
  for (const point of route) {
    const previous = result[result.length - 1];
    if (previous && previous.x === point.x && previous.y === point.y) continue;
    result.push(point);
  }
  return result;
}

function routeHitsNodeCenter(route, nodeCenters) {
  return routeNodeCenterHitCount(route, nodeCenters) > 0;
}

function routeNodeCenterHitCount(route, nodeCenters) {
  let count = 0;
  for (const segment of routeSegments(route)) {
    count += segmentNodeCenterHitCount(segment, nodeCenters);
  }
  return count;
}

function routeNodeBoxHitCount(route, nodeObstacles) {
  let count = 0;
  for (const segment of routeSegments(route)) {
    count += segmentNodeBoxHitCount(segment, nodeObstacles);
  }
  return count;
}

function segmentNodeCenterHitCount(segment, nodeCenters) {
  let count = 0;
  for (const center of nodeCenters) {
    if (segmentCrossesPoint(segment, center)) count += 1;
  }
  return count;
}

function segmentNodeBoxHitCount(segment, nodeObstacles) {
  let count = 0;
  for (const box of nodeObstacles) {
    if (segmentCrossesBox(segment, box)) count += 1;
  }
  return count;
}

function segmentCrossesPoint(segment, point) {
  const tolerance = 2;
  if (segment.a.x === segment.b.x) {
    return Math.abs(point.x - segment.a.x) <= tolerance && between(point.y, segment.a.y, segment.b.y);
  }
  if (segment.a.y === segment.b.y) {
    return Math.abs(point.y - segment.a.y) <= tolerance && between(point.x, segment.a.x, segment.b.x);
  }
  return false;
}

function segmentCrossesBox(segment, box) {
  const margin = 2;
  const left = box.left - margin;
  const right = box.right + margin;
  const top = box.top - margin;
  const bottom = box.bottom + margin;
  if (segment.a.x === segment.b.x) {
    const x = segment.a.x;
    if (x <= left || x >= right) return false;
    return intervalsOverlap(segment.a.y, segment.b.y, top, bottom);
  }
  if (segment.a.y === segment.b.y) {
    const y = segment.a.y;
    if (y <= top || y >= bottom) return false;
    return intervalsOverlap(segment.a.x, segment.b.x, left, right);
  }
  return false;
}

function between(value, left, right) {
  return value > Math.min(left, right) && value < Math.max(left, right);
}

function routeForeignTargetConflictCount(route, routedCorridors, routeContext = {}) {
  let count = 0;
  for (const segment of routeSegments(route)) {
    count += segmentForeignTargetConflictCount(segment, routedCorridors, routeContext);
  }
  return count;
}

function routeSameTargetCorridorCount(route, routedCorridors, routeContext = {}) {
  let count = 0;
  for (const segment of routeSegments(route)) {
    count += segmentSameTargetCorridorCount(segment, routedCorridors, routeContext);
  }
  return count;
}

function segmentForeignTargetConflictCount(segment, routedCorridors, routeContext = {}) {
  let count = 0;
  for (const corridor of routeCorridorsNearSegment(segment, routedCorridors, routeContext.corridorIndex)) {
    if (corridor.targetId === routeContext.targetId) continue;
    if (!segmentsShareCorridor(segment, corridor)) continue;
    const currentRole = routeTerminalRole(segment, routeContext);
    const sharesRequiredSourceStub = currentRole === 'sourceStub'
      && corridor.role === 'sourceStub'
      && corridor.sourceId === routeContext.sourceId
      && corridor.sourcePort === routeContext.sourcePort;
    if (!sharesRequiredSourceStub) count += 1;
  }
  if (routeContext.forbidForeignTargetCrossings) {
    for (const corridor of routeContext.crossingCorridors || routedCorridors) {
      if (corridor.targetId === routeContext.targetId) continue;
      if (segmentCrossesForeignCorridor(segment, corridor, routeContext)) count += 1;
    }
  }
  return count;
}

function segmentSameTargetCorridorCount(segment, routedCorridors, routeContext = {}) {
  let count = 0;
  for (const corridor of routeCorridorsNearSegment(segment, routedCorridors, routeContext.corridorIndex)) {
    if (corridor.targetId === routeContext.targetId && segmentsShareCorridor(segment, corridor)) count += 1;
  }
  return count;
}

const ROUTE_CORRIDOR_INDEX_BUCKET_SIZE = 4;

function buildRouteCorridorIndex(corridors) {
  const index = { h: new Map(), v: new Map() };
  for (const corridor of corridors) {
    const coordinate = corridor.axis === 'h' ? corridor.y : corridor.x;
    if (!Number.isFinite(coordinate) || !index[corridor.axis]) continue;
    const bucket = Math.floor(coordinate / ROUTE_CORRIDOR_INDEX_BUCKET_SIZE);
    if (!index[corridor.axis].has(bucket)) index[corridor.axis].set(bucket, []);
    index[corridor.axis].get(bucket).push(corridor);
  }
  return index;
}

function routeCorridorsNearSegment(segment, corridors, index) {
  const byBucket = index?.[segment.axis];
  if (!byBucket) return corridors;
  const coordinate = segment.axis === 'h' ? segment.a.y : segment.a.x;
  const bucket = Math.floor(coordinate / ROUTE_CORRIDOR_INDEX_BUCKET_SIZE);
  return [
    ...(byBucket.get(bucket - 1) || []),
    ...(byBucket.get(bucket) || []),
    ...(byBucket.get(bucket + 1) || []),
  ];
}

function segmentsShareCorridor(segment, corridor) {
  const axisTolerance = ROUTE_CORRIDOR_AXIS_TOLERANCE;
  if (segment.axis !== corridor.axis) return false;
  if (segment.axis === 'h') {
    return Math.abs(segment.a.y - corridor.y) <= axisTolerance
      && intervalOverlapLength(segment.a.x, segment.b.x, corridor.from, corridor.to) > axisTolerance;
  }
  return Math.abs(segment.a.x - corridor.x) <= axisTolerance
    && intervalOverlapLength(segment.a.y, segment.b.y, corridor.from, corridor.to) > axisTolerance;
}

function segmentCrossesForeignCorridor(segment, corridor, routeContext = {}) {
  if (segment.axis === corridor.axis) return false;
  const horizontalY = segment.axis === 'h' ? segment.a.y : corridor.y;
  const horizontalFrom = segment.axis === 'h' ? segment.a.x : corridor.from;
  const horizontalTo = segment.axis === 'h' ? segment.b.x : corridor.to;
  const verticalX = segment.axis === 'v' ? segment.a.x : corridor.x;
  const verticalFrom = segment.axis === 'v' ? segment.a.y : corridor.from;
  const verticalTo = segment.axis === 'v' ? segment.b.y : corridor.to;
  const intersection = { x: verticalX, y: horizontalY };
  if (samePoint(intersection, routeContext.sourcePoint) || samePoint(intersection, routeContext.targetPoint)) return false;
  return betweenInclusive(verticalX, horizontalFrom, horizontalTo)
    && betweenInclusive(horizontalY, verticalFrom, verticalTo);
}

function corridorIntersectsBounds(corridor, bounds) {
  if (corridor.axis === 'h') {
    return corridor.y >= bounds.top
      && corridor.y <= bounds.bottom
      && intervalsOverlap(corridor.from, corridor.to, bounds.left, bounds.right);
  }
  return corridor.axis === 'v'
    && corridor.x >= bounds.left
    && corridor.x <= bounds.right
    && intervalsOverlap(corridor.from, corridor.to, bounds.top, bounds.bottom);
}

function betweenInclusive(value, left, right) {
  return value >= Math.min(left, right) && value <= Math.max(left, right);
}

function intervalOverlapLength(a1, a2, b1, b2) {
  return Math.max(0, Math.min(Math.max(a1, a2), Math.max(b1, b2))
    - Math.max(Math.min(a1, a2), Math.min(b1, b2)));
}

function intervalsOverlap(a1, a2, b1, b2) {
  return Math.max(Math.min(a1, a2), Math.min(b1, b2)) < Math.min(Math.max(a1, a2), Math.max(b1, b2));
}

function routeManhattanLength(route) {
  return routeSegments(route).reduce((total, segment) => total + manhattanDistance(segment.a, segment.b), 0);
}

function registerRouteCorridors(routedCorridors, route, meta = {}) {
  const segments = routeSegments(route);
  segments.forEach((segment, index) => {
    const role = index === 0
      ? 'sourceStub'
      : index === segments.length - 1
        ? 'targetStub'
        : 'body';
    if (segment.axis === 'h') {
      routedCorridors.push({ ...meta, role, axis: 'h', y: segment.a.y, from: segment.a.x, to: segment.b.x });
    } else if (segment.axis === 'v') {
      routedCorridors.push({ ...meta, role, axis: 'v', x: segment.a.x, from: segment.a.y, to: segment.b.y });
    }
  });
}

function routeTerminalRole(segment, routeContext) {
  if (sameUndirectedSegment(segment, routeContext.sourcePoint, routeContext.sourceStub)) return 'sourceStub';
  if (sameUndirectedSegment(segment, routeContext.targetStub, routeContext.targetPoint)) return 'targetStub';
  return 'body';
}

function sameUndirectedSegment(segment, left, right) {
  if (!left || !right) return false;
  return (samePoint(segment.a, left) && samePoint(segment.b, right))
    || (samePoint(segment.a, right) && samePoint(segment.b, left));
}

function routeSegments(route) {
  const segments = [];
  for (let index = 1; index < route.length; index += 1) {
    const a = route[index - 1];
    const b = route[index];
    if (!a || !b || (a.x === b.x && a.y === b.y)) continue;
    if (a.x !== b.x && a.y !== b.y) continue;
    segments.push({
      a,
      b,
      axis: a.y === b.y ? 'h' : 'v',
    });
  }
  return segments;
}

function samePoint(left, right) {
  return !!left && !!right && left.x === right.x && left.y === right.y;
}

function sharesPortAxis(left, right, port) {
  if (!left || !right || !port) return false;
  const parsed = parsePercentPort(port);
  const side = parsed?.side || port;
  if (side === 'top' || side === 'bottom') return left.x === right.x;
  if (side === 'left' || side === 'right' || port === 'left-top' || port === 'left-bottom' || port === 'right-top' || port === 'right-bottom' || port === 'hex-right-top' || port === 'hex-right-bottom') return left.y === right.y;
  return false;
}

function portPoint(box, port) {
  if (!box || !port) return null;
  const parsed = parsePercentPort(port);
  if (parsed) {
    if (parsed.side === 'top') return { x: box.x + box.width * parsed.ratio, y: box.y };
    if (parsed.side === 'bottom') return { x: box.x + box.width * parsed.ratio, y: box.y + box.height };
    if (parsed.side === 'left') return { x: box.x, y: box.y + box.height * parsed.ratio };
    if (parsed.side === 'right') return { x: box.x + box.width, y: box.y + box.height * parsed.ratio };
  }
  if (port === 'top') return { x: box.x + box.width / 2, y: box.y };
  if (port === 'right') return { x: box.x + box.width, y: box.y + box.height / 2 };
  if (port === 'right-top') return { x: box.x + box.width * 0.75, y: box.y };
  if (port === 'right-bottom') return { x: box.x + box.width * 0.75, y: box.y + box.height };
  if (port === 'hex-right-top') return { x: box.x + box.width * 0.75, y: box.y };
  if (port === 'hex-right-bottom') return { x: box.x + box.width * 0.75, y: box.y + box.height };
  if (port === 'bottom-left') return { x: box.x + box.width * 0.25, y: box.y + box.height };
  if (port === 'bottom-right') return { x: box.x + box.width * 0.75, y: box.y + box.height };
  if (port === 'bottom') return { x: box.x + box.width / 2, y: box.y + box.height };
  if (port === 'left') return { x: box.x, y: box.y + box.height / 2 };
  if (port === 'left-top') return { x: box.x + box.width * 0.25, y: box.y };
  if (port === 'left-bottom') return { x: box.x + box.width * 0.25, y: box.y + box.height };
  return null;
}

function segmentOrder(segment) {
  const grid = String(segment || '').match(/^grid-(\d+)-of-\d+$/);
  if (grid) return Number(grid[1]);
  if (segment === 'source-to-turn') return 1;
  if (segment === 'turn-to-turn') return 2;
  if (segment === 'turn-to-target') return 3;
  return 99;
}

function edgeLabelPosition(edge) {
  if (slotNameForEdge(edge)) {
    const relativeX = Number(edge.props?.slotLabelRelativeX);
    if (Number.isFinite(relativeX)) {
      return ` x="${Math.max(-1, Math.min(1, relativeX))}"`;
    }
    return slotNodeEnd(edge) === 'source' ? ' x="-0.8"' : ' x="0.8"';
  }
  const controlRelativeX = Number(edge.props?.controlLabelRelativeX);
  if (Number.isFinite(controlRelativeX)) {
    return ` x="${Math.max(-1, Math.min(1, controlRelativeX))}"`;
  }
  return labelForEdge(edge) && flowLayerForGraphItem(edge, 'control') === 'control'
    ? ' x="-0.9"'
    : '';
}

function edgeGeometry(edge, transformPoint = (point) => point) {
  const labelPosition = edgeLabelPosition(edge);
  if (edge.props?.lockRoutePoints !== true) {
    return `<mxGeometry${labelPosition} relative="1" as="geometry" />`;
  }

  const points = Array.isArray(edge.props?.explicitPoints) ? edge.props.explicitPoints : [];
  if (!points.length) return `<mxGeometry${labelPosition} relative="1" as="geometry" />`;
  const pointsXml = points
    .map(transformPoint)
    .map((point) => `<mxPoint x="${xml(point.x)}" y="${xml(point.y)}" />`)
    .join('');
  return `<mxGeometry${labelPosition} relative="1" as="geometry"><Array as="points">${pointsXml}</Array></mxGeometry>`;
}

