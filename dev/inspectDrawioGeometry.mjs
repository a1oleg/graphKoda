import fs from 'node:fs';

const DEFAULT_DRAWIO = 'tmp/graph-vscode-cache/local-onsubmit-steps.drawio';

function usage() {
  console.log(`Usage:
  node dev/inspectDrawioGeometry.mjs [drawioPath] [--edge stableId] [--node stableId] [--big-gap N] [--free-corridors N] [--min-vertical N] [--limit N] [--fail-on-issues true]

Examples:
  node dev/inspectDrawioGeometry.mjs --edge screens/REPL.tsx:3154:32:3154:50
  node dev/inspectDrawioGeometry.mjs tmp/graph-vscode-cache/local-onsubmit-steps.drawio --big-gap 800
  node dev/inspectDrawioGeometry.mjs --free-corridors 2 --min-vertical 300 --limit 20
`);
}

function parseArgs(argv) {
  const args = { drawioPath: DEFAULT_DRAWIO, edges: [], nodes: [], bigGap: null, freeCorridors: null, minVertical: 0, limit: null, failOnIssues: false };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith('--')) args.drawioPath = rest.shift();
  while (rest.length) {
    const key = rest.shift();
    const value = rest.shift();
    if (!value) throw new Error(`Missing value for ${key}`);
    if (key === '--edge') args.edges.push(value);
    else if (key === '--node') args.nodes.push(value);
    else if (key === '--big-gap') args.bigGap = Number(value);
    else if (key === '--free-corridors') args.freeCorridors = Number(value);
    else if (key === '--min-vertical') args.minVertical = Number(value);
    else if (key === '--limit') args.limit = Number(value);
    else if (key === '--fail-on-issues') args.failOnIssues = value === 'true' || value === '1' || value === 'yes';
    else throw new Error(`Unknown argument: ${key}`);
  }
  return args;
}

function decodeXml(text) {
  return String(text ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attrs(text) {
  const result = {};
  for (const match of text.matchAll(/\s([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)) {
    result[match[1]] = decodeXml(match[2]);
  }
  return result;
}

function numberAttr(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseDrawio(xml) {
  const cells = new Map();
  const nodesByStableId = new Map();
  const edgesByStableId = new Map();

  for (const match of xml.matchAll(/<mxCell\b([^>]*)>([\s\S]*?)<\/mxCell>/g)) {
    const cell = attrs(match[1]);
    cell.body = match[2];
    cell.kind = cell.vertex === '1' ? 'node' : cell.edge === '1' ? 'edge' : 'other';
    cell.value = decodeXml(cell.value || '');
    const geometryMatch = cell.body.match(/<mxGeometry\b([^>]*)/);
    if (geometryMatch) {
      const geometry = attrs(geometryMatch[1]);
      cell.geometry = {
        x: numberAttr(geometry.x),
        y: numberAttr(geometry.y),
        width: numberAttr(geometry.width),
        height: numberAttr(geometry.height),
      };
    }
    cell.points = [...cell.body.matchAll(/<mxPoint\b([^>]*)\/>/g)].map((pointMatch) => {
      const point = attrs(pointMatch[1]);
      return { x: numberAttr(point.x), y: numberAttr(point.y) };
    });
    cells.set(cell.id, cell);
    if (cell.kind === 'node' && cell.codeStableId) nodesByStableId.set(cell.codeStableId, cell);
    if (cell.kind === 'edge' && cell.codeStableId) {
      if (!edgesByStableId.has(cell.codeStableId)) edgesByStableId.set(cell.codeStableId, []);
      edgesByStableId.get(cell.codeStableId).push(cell);
    }
  }

  return { cells, nodesByStableId, edgesByStableId };
}

function bbox(cell) {
  const geometry = cell?.geometry || {};
  if ([geometry.x, geometry.y, geometry.width, geometry.height].some((value) => value === null || value === undefined)) return null;
  return {
    left: geometry.x,
    top: geometry.y,
    right: geometry.x + geometry.width,
    bottom: geometry.y + geometry.height,
    cx: geometry.x + geometry.width / 2,
    cy: geometry.y + geometry.height / 2,
    width: geometry.width,
    height: geometry.height,
  };
}

function styleMap(style) {
  const result = {};
  for (const part of String(style || '').split(';')) {
    if (!part) continue;
    const index = part.indexOf('=');
    if (index === -1) result[part] = true;
    else result[part.slice(0, index)] = part.slice(index + 1);
  }
  return result;
}

function portFromStyle(style, prefix) {
  const parsed = styleMap(style);
  const x = Number(parsed[`${prefix}X`]);
  const y = Number(parsed[`${prefix}Y`]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x === 0.5 && y === 0) return 'top';
  if (x === 1 && y === 0.5) return 'right';
  if (x === 0.5 && y === 1) return 'bottom';
  if (x === 0 && y === 0.5) return 'left';
  return `${prefix}(${x},${y})`;
}

function edgePath(edge, source, target) {
  const sourceBox = bbox(source);
  const targetBox = bbox(target);
  const sourcePort = portFromStyle(edge.style, 'exit');
  const targetPort = portFromStyle(edge.style, 'entry');
  return {
    sourcePort,
    targetPort,
    sourceBox,
    targetBox,
    points: edge.points,
    polyline: buildPolyline(sourceBox, sourcePort, edge.points, targetBox, targetPort),
  };
}

function portPoint(box, port) {
  if (!box) return null;
  const parsed = parsePort(port);
  if (parsed) {
    if (parsed.side === 'top') return { x: box.left + box.width * parsed.ratio, y: box.top };
    if (parsed.side === 'bottom') return { x: box.left + box.width * parsed.ratio, y: box.bottom };
    if (parsed.side === 'left') return { x: box.left, y: box.top + box.height * parsed.ratio };
    if (parsed.side === 'right') return { x: box.right, y: box.top + box.height * parsed.ratio };
  }
  if (port === 'top') return { x: box.cx, y: box.top };
  if (port === 'right') return { x: box.right, y: box.cy };
  if (port === 'bottom') return { x: box.cx, y: box.bottom };
  if (port === 'left') return { x: box.left, y: box.cy };
  return { x: box.cx, y: box.cy };
}

function parsePort(port) {
  const match = String(port || '').match(/^(top|right|bottom|left)-(\d{1,3})$/u);
  if (!match) return null;
  return { side: match[1], ratio: Math.max(0, Math.min(100, Number(match[2]))) / 100 };
}

function buildPolyline(sourceBox, sourcePort, points, targetBox, targetPort) {
  const source = portPoint(sourceBox, sourcePort);
  const target = portPoint(targetBox, targetPort);
  return [source, ...points, target]
    .filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({ x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 }));
}

function inspectNode(cell) {
  const box = bbox(cell);
  return {
    id: cell.id,
    value: cell.value,
    codeStableId: cell.codeStableId,
    graphKind: cell.graphKind,
    box,
    layoutTrace: cell.layoutTrace || '',
  };
}

function inspectEdge(edge, parsed) {
  const source = parsed.cells.get(edge.source);
  const target = parsed.cells.get(edge.target);
  const path = edgePath(edge, source, target);
  const sourceBox = path.sourceBox;
  const targetBox = path.targetBox;
  const dy = sourceBox && targetBox ? Math.round((targetBox.cy - sourceBox.cy) * 10) / 10 : null;
  const dx = sourceBox && targetBox ? Math.round((targetBox.cx - sourceBox.cx) * 10) / 10 : null;
  return {
    id: edge.id,
    type: edge.edgeType,
    codeStableId: edge.codeStableId,
    targetStableId: edge.targetStableId,
    canonicalTargetStableId: edge.canonicalTargetStableId,
    source: source ? inspectNode(source) : null,
    target: target ? inspectNode(target) : null,
    dx,
    dy,
    sourcePort: path.sourcePort,
    targetPort: path.targetPort,
    points: path.points,
    polyline: path.polyline,
  };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function findBigGaps(parsed, threshold) {
  const rows = [];
  for (const cell of parsed.cells.values()) {
    if (cell.kind !== 'edge') continue;
    const source = parsed.cells.get(cell.source);
    const target = parsed.cells.get(cell.target);
    const sourceBox = bbox(source);
    const targetBox = bbox(target);
    if (!sourceBox || !targetBox) continue;
    const dy = targetBox.cy - sourceBox.cy;
    if (Math.abs(dy) < threshold) continue;
    rows.push({
      edgeType: cell.edgeType,
      codeStableId: cell.codeStableId,
      targetStableId: cell.targetStableId,
      dy: Math.round(dy),
      source: source?.value,
      target: target?.value,
      sourcePort: portFromStyle(cell.style, 'exit'),
      targetPort: portFromStyle(cell.style, 'entry'),
      pointCount: cell.points.length,
    });
  }
  rows.sort((left, right) => Math.abs(right.dy) - Math.abs(left.dy));
  return rows;
}

function horizontalAxes(parsed) {
  return [...new Set([...parsed.cells.values()]
    .filter((cell) => cell.kind === 'node')
    .map(bbox)
    .filter(Boolean)
    .flatMap((box) => [box.top, box.cy, box.bottom])
    .map((value) => Math.round(value * 10) / 10))]
    .sort((left, right) => left - right);
}

function nodeIntersectsHorizontalBand(box, y, x, tolerance) {
  if (!box) return false;
  return box.left - tolerance <= x
    && x <= box.right + tolerance
    && box.top - tolerance <= y
    && y <= box.bottom + tolerance;
}

function hasNodeOnHorizontalCorridor(parsed, y, x1, x2, tolerance) {
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  for (const cell of parsed.cells.values()) {
    if (cell.kind !== 'node') continue;
    const box = bbox(cell);
    if (!box) continue;
    if (box.right < left - tolerance || box.left > right + tolerance) continue;
    if (box.top - tolerance <= y && y <= box.bottom + tolerance) return true;
  }
  return false;
}

function findFreeHorizontalCorridorIssues(parsed, minFreeCorridors, minVertical = 0) {
  const axes = horizontalAxes(parsed);
  const tolerance = 2;
  const rows = [];
  for (const edge of parsed.cells.values()) {
    if (edge.kind !== 'edge') continue;
    const source = parsed.cells.get(edge.source);
    const target = parsed.cells.get(edge.target);
    const path = edgePath(edge, source, target);
    if (path.polyline.length < 2) continue;
    const sourceBox = path.sourceBox;
    const targetBox = path.targetBox;
    if (!sourceBox || !targetBox) continue;

    for (let index = 0; index < path.polyline.length - 1; index += 1) {
      const from = path.polyline[index];
      const to = path.polyline[index + 1];
      if (Math.abs(from.x - to.x) > tolerance) continue;
      const yMin = Math.min(from.y, to.y);
      const yMax = Math.max(from.y, to.y);
      if (yMax - yMin < Math.max(1, minVertical)) continue;

      const freeAxes = axes.filter((y) => {
        if (y <= yMin + tolerance || y >= yMax - tolerance) return false;
        if (nodeIntersectsHorizontalBand(sourceBox, y, from.x, tolerance)) return false;
        if (nodeIntersectsHorizontalBand(targetBox, y, from.x, tolerance)) return false;
        return !hasNodeOnHorizontalCorridor(parsed, y, from.x, targetBox.cx, tolerance);
      });
      if (freeAxes.length < minFreeCorridors) continue;

      rows.push({
        edgeType: edge.edgeType,
        codeStableId: edge.codeStableId,
        targetStableId: edge.targetStableId,
        source: source?.value,
        target: target?.value,
        sourcePort: path.sourcePort,
        targetPort: path.targetPort,
        sourceCenter: { x: sourceBox.cx, y: sourceBox.cy },
        targetCenter: { x: targetBox.cx, y: targetBox.cy },
        centerDelta: {
          dx: Math.round((targetBox.cx - sourceBox.cx) * 10) / 10,
          dy: Math.round((targetBox.cy - sourceBox.cy) * 10) / 10,
        },
        verticalSegment: {
          index,
          x: from.x,
          y1: yMin,
          y2: yMax,
          length: Math.round(yMax - yMin),
        },
        freeHorizontalCorridorCount: freeAxes.length,
        firstFreeHorizontalCorridors: freeAxes.slice(0, 8),
        pointCount: edge.points.length,
      });
    }
  }
  rows.sort((left, right) => (right.freeHorizontalCorridorCount - left.freeHorizontalCorridorCount)
    || (right.verticalSegment.length - left.verticalSegment.length));
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.drawioPath)) {
    usage();
    throw new Error(`draw.io file was not found: ${args.drawioPath}`);
  }

  const parsed = parseDrawio(fs.readFileSync(args.drawioPath, 'utf8'));
  const output = {
    file: args.drawioPath,
    cells: parsed.cells.size,
    nodes: [...parsed.cells.values()].filter((cell) => cell.kind === 'node').length,
    edges: [...parsed.cells.values()].filter((cell) => cell.kind === 'edge').length,
  };

  if (args.nodes.length) {
    output.nodesByStableId = args.nodes.map((stableId) => {
      const node = parsed.nodesByStableId.get(stableId);
      return node ? inspectNode(node) : { codeStableId: stableId, missing: true };
    });
  }

  if (args.edges.length) {
    output.edgesByStableId = args.edges.flatMap((stableId) => {
      const edges = parsed.edgesByStableId.get(stableId) || [];
      return edges.length
        ? edges.map((edge) => inspectEdge(edge, parsed))
        : [{ codeStableId: stableId, missing: true }];
    });
  }

  if (args.bigGap !== null) output.bigGaps = findBigGaps(parsed, args.bigGap);
  if (args.freeCorridors !== null) {
    const issues = findFreeHorizontalCorridorIssues(parsed, args.freeCorridors, args.minVertical);
    output.freeCorridorIssues = Number.isFinite(args.limit) ? issues.slice(0, args.limit) : issues;
    output.freeCorridorIssueCount = issues.length;
    if (args.failOnIssues && issues.length) process.exitCode = 2;
  }
  printJson(output);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
