import fs from 'node:fs';
import path from 'node:path';

const OUTPUT_DEFAULT = 'graph/draw/onSubmit-activeRemote-condition-golden.drawio';
const SOURCE_PATH = 'screens/REPL.tsx';
const CONDITION_STABLE_ID = 'screens/REPL.tsx:3416:8:3419:29';

const palette = Object.freeze({
  actionFill: '#ffe6cc',
  actionStroke: '#9a5d00',
  valueFill: '#dae8fc',
  valueStroke: '#6c8ebf',
  collectionFill: '#b7cce3',
  expressionFill: '#ffffff',
  errorFill: '#f8cecc',
  errorStroke: '#b85450',
  trueStroke: '#82b366',
});

function xml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseArgs(argv) {
  const outputIndex = argv.indexOf('--output');
  return { outputPath: outputIndex >= 0 ? argv[outputIndex + 1] : OUTPUT_DEFAULT };
}

function splitCallImage(side, fillColor, strokeColor, predicate = false) {
  const startPath = predicate
    ? 'M 18 2 H 98 V 48 H 18 L 2 25 Z'
    : 'M 2 2 H 98 V 48 H 2 Z';
  const middlePath = 'M 2 2 H 98 V 48 H 2 Z';
  const endPath = predicate
    ? 'M 2 2 H 82 L 98 25 L 82 48 H 2 Z'
    : 'M 2 2 H 98 V 48 H 2 Z';
  const shape = side === 'start' ? startPath : side === 'end' ? endPath : middlePath;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 50' preserveAspectRatio='none'><path d='${shape}' fill='${fillColor}' stroke='${strokeColor}' stroke-width='1' stroke-linejoin='miter' vector-effect='non-scaling-stroke'/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function mosaicImage(side, fillColor, strokeColor) {
  const shape = side === 'start'
    ? 'M 18 1 H 100 V 49 H 18 L 2 25 Z'
    : side === 'end'
      ? 'M 0 1 H 82 L 98 25 L 82 49 H 0 Z'
      : 'M 0 1 H 100 V 49 H 0 Z';
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 50' preserveAspectRatio='none'><path d='${shape}' fill='${fillColor}' stroke='${strokeColor}' stroke-width='1' vector-effect='non-scaling-stroke'/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const styles = {
  title: 'text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontSize=20;fontStyle=1;fontColor=#000000;',
  axis: `shape=line;direction=south;whiteSpace=wrap;html=1;strokeColor=${palette.actionStroke};strokeWidth=2;fillColor=none;fontColor=none;`,
  axisTitle: 'text;html=1;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;fontSize=16;fontStyle=1;fontColor=#000000;',
  value: `rounded=1;arcSize=14;whiteSpace=wrap;html=1;fillColor=${palette.valueFill};strokeColor=${palette.valueStroke};fontColor=#000000;`,
  valueBold: `rounded=1;arcSize=14;whiteSpace=wrap;html=1;fillColor=${palette.valueFill};strokeColor=${palette.valueStroke};fontColor=#000000;fontStyle=1;`,
  action: `rounded=0;whiteSpace=wrap;html=1;fillColor=${palette.actionFill};strokeColor=${palette.actionStroke};fontColor=#000000;fontStyle=1;`,
  collection: `shape=datastore;whiteSpace=wrap;html=1;fillColor=${palette.collectionFill};strokeColor=#000000;strokeWidth=1.5;fontColor=#000000;fontStyle=1;`,
  predicate: `shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;fillColor=${palette.expressionFill};strokeColor=${palette.actionStroke};fontColor=#000000;fontStyle=1;`,
  outcomeFalse: `rounded=1;arcSize=14;whiteSpace=wrap;html=1;fillColor=${palette.errorFill};strokeColor=${palette.errorStroke};fontColor=${palette.errorStroke};fontStyle=1;`,
  outcomeTrue: `rounded=1;arcSize=14;whiteSpace=wrap;html=1;fillColor=#e6f2e6;strokeColor=${palette.trueStroke};fontColor=#2e7d32;fontStyle=1;`,
};

function imageStyle(image, bold = false) {
  return `shape=image;imageAspect=0;image=${image};whiteSpace=wrap;html=1;labelPosition=center;align=center;verticalLabelPosition=middle;verticalAlign=middle;spacing=4;fontColor=#000000;${bold ? 'fontStyle=1;' : ''}`;
}

function edgeStyle(color, extra = '') {
  return `edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;strokeWidth=1.5;strokeColor=${color};fontColor=${color};${extra}`;
}

function buildDiagram() {
  const cells = [];
  let edgeIndex = 0;
  const vertex = (id, label, style, x, y, width, height, attrs = '') => {
    cells.push(`<mxCell id="${xml(id)}" value="${xml(label)}" style="${style}" vertex="1" parent="1" stableId="${xml(attrs || id)}"><mxGeometry x="${x}" y="${y}" width="${width}" height="${height}" as="geometry" /></mxCell>`);
  };
  const edge = (source, target, label = '', color = palette.valueStroke, styleExtra = '', points = []) => {
    const pointXml = points.length
      ? `<Array as="points">${points.map(([x, y]) => `<mxPoint x="${x}" y="${y}" />`).join('')}</Array>`
      : '';
    cells.push(`<mxCell id="e${++edgeIndex}" value="${xml(label)}" style="${edgeStyle(color, styleExtra)}" edge="1" parent="1" source="${xml(source)}" target="${xml(target)}"><mxGeometry relative="1" as="geometry">${pointXml}</mxGeometry></mxCell>`);
  };

  vertex('title', 'if condition @ REPL.tsx:3416', styles.title, 40, 20, 520, 36);

  // Function and external-data axes use the current golden sequence palette.
  const axes = [
    ['condition-axis', 'condition', 130, 90, 1100],
    ['commands-axis', 'commands', 570, 265, 725],
    ['candidate-axis', 'c', 850, 340, 650],
    ['enabled-axis', 'isCommandEnabled', 1160, 470, 520],
    ['name-axis', 'getCommandName', 1470, 650, 340],
  ];
  for (const [id, label, x, y, height] of axes) {
    vertex(`${id}-title`, label, styles.axisTitle, x - 100, 62, 200, 32);
    vertex(id, '', styles.axis, x - 4, y, 8, height);
  }

  vertex('active-remote', 'activeRemote', styles.collection, 285, 112, 190, 70, 'screens/REPL.tsx:1422:8:1422:20');
  vertex('remote-read-a', 'activeRemote', imageStyle(mosaicImage('start', palette.valueFill, palette.valueStroke)), 55, 125, 155, 54);
  vertex('remote-read-b', '.isRemoteMode', imageStyle(mosaicImage('end', palette.valueFill, palette.valueStroke)), 210, 125, 150, 54);
  edge('active-remote', 'remote-read-b', 'isRemoteMode', palette.valueStroke, 'exitX=0;exitY=0.5;entryX=1;entryY=0.5;');

  vertex('remote-false', 'FALSE', styles.outcomeFalse, 30, 220, 105, 42);
  edge('remote-read-a', 'remote-false', 'false', palette.errorStroke, 'exitX=0.5;exitY=1;entryX=1;entryY=0.5;');

  vertex('slash-command', 'isSlashCommand', styles.predicate, 245, 225, 190, 60);
  edge('remote-read-b', 'slash-command', 'true', palette.trueStroke, 'exitX=0.5;exitY=1;entryX=0;entryY=0.5;');
  vertex('not-slash-outcome', 'not local-jsx', styles.outcomeTrue, 30, 320, 145, 44);
  edge('slash-command', 'not-slash-outcome', 'false', palette.errorStroke, 'exitX=0;exitY=0.5;entryX=1;entryY=0.5;');

  // commands.find(c => ...) is a collection operation: collection backing is
  // attached only to the opening call half.
  vertex('commands-store-back', '', styles.collection, 473, 309, 185, 68);
  vertex('find-open', 'find(', imageStyle(splitCallImage('start', palette.actionFill, palette.actionStroke, false), true), 500, 320, 150, 58);
  vertex('find-arg', 'c =>', imageStyle(splitCallImage('middle', palette.valueFill, palette.valueStroke, false), true), 650, 320, 105, 58);
  vertex('find-close', ')', imageStyle(splitCallImage('end', palette.actionFill, palette.actionStroke, false), true), 755, 320, 78, 58);
  edge('slash-command', 'find-open', 'true', palette.trueStroke, 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;');
  edge('find-open', 'candidate', 'extract next c', palette.valueStroke, 'exitX=0.5;exitY=1;entryX=0;entryY=0.5;', [[570, 420], [760, 420]]);

  vertex('candidate', 'c', styles.valueBold, 780, 398, 140, 50);

  // name = input.trim().slice(1).split(/\s/)[0]
  vertex('name-slot', 'name', `rounded=1;arcSize=14;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=${palette.valueStroke};strokeWidth=2;fontColor=#000000;fontStyle=1;`, 720, 480, 130, 48);
  vertex('name-set', 'set', styles.action, 775, 523, 66, 32);
  vertex('input', 'input', imageStyle(mosaicImage('start', palette.valueFill, palette.valueStroke)), 895, 475, 105, 54);
  vertex('trim', 'trim()', imageStyle(mosaicImage('middle', palette.actionFill, palette.actionStroke), true), 1000, 475, 105, 54);
  vertex('slice-open', 'slice(', imageStyle(splitCallImage('start', palette.actionFill, palette.actionStroke)), 1105, 475, 100, 54);
  vertex('slice-arg', '1', imageStyle(splitCallImage('middle', '#e1d5e7', '#9673a6')), 1205, 475, 54, 54);
  vertex('slice-close', ')', imageStyle(splitCallImage('end', palette.actionFill, palette.actionStroke), true), 1259, 475, 58, 54);
  vertex('split-open', 'split(', imageStyle(splitCallImage('start', palette.actionFill, palette.actionStroke)), 1317, 475, 105, 54);
  vertex('split-arg', '/\\s/', imageStyle(splitCallImage('middle', '#e1d5e7', '#9673a6')), 1422, 475, 72, 54);
  vertex('split-close', ')', imageStyle(splitCallImage('end', palette.actionFill, palette.actionStroke), true), 1494, 475, 58, 54);
  vertex('first-item', '[0]', imageStyle(mosaicImage('end', palette.actionFill, palette.actionStroke), true), 1552, 475, 72, 54);
  edge('name-slot', 'input', 'evaluate', palette.valueStroke, 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;');
  edge('first-item', 'name-set', 'name', palette.valueStroke, 'exitX=0.5;exitY=1;entryX=1;entryY=0.5;', [[1590, 570], [870, 570]]);

  // First conjunct: isCommandEnabled(c), rendered as a split predicate call.
  vertex('enabled-open', 'isCommandEnabled(', imageStyle(splitCallImage('start', palette.actionFill, palette.actionStroke, true), true), 925, 625, 190, 60);
  vertex('enabled-arg', 'c', imageStyle(splitCallImage('middle', palette.valueFill, palette.valueStroke, true), true), 1115, 625, 62, 60);
  vertex('enabled-close', ')', imageStyle(splitCallImage('end', palette.actionFill, palette.actionStroke, true), true), 1177, 625, 62, 60);
  edge('candidate', 'enabled-open', 'c', palette.valueStroke, 'exitX=0.5;exitY=1;entryX=0;entryY=0.5;', [[850, 600], [900, 600]]);

  // OR alternatives are complete expression mosaics. Operators contain only
  // the operator; values, literals, and calls retain their own color families.
  vertex('name-eq-left', 'c.name', imageStyle(mosaicImage('start', palette.valueFill, palette.valueStroke)), 850, 750, 125, 56);
  vertex('name-eq-op', '===', imageStyle(mosaicImage('middle', palette.expressionFill, palette.actionStroke), true), 975, 750, 62, 56);
  vertex('name-eq-right', 'name', imageStyle(mosaicImage('end', palette.valueFill, palette.valueStroke)), 1037, 750, 110, 56);

  vertex('aliases-value', 'c.aliases?', imageStyle(mosaicImage('start', palette.valueFill, palette.valueStroke)), 850, 835, 130, 56);
  vertex('includes-open', 'includes(', imageStyle(splitCallImage('middle', palette.actionFill, palette.actionStroke, true), true), 980, 835, 125, 56);
  vertex('includes-arg', 'name!', imageStyle(splitCallImage('middle', palette.valueFill, palette.valueStroke, true), true), 1105, 835, 95, 56);
  vertex('includes-close', ')', imageStyle(splitCallImage('end', palette.actionFill, palette.actionStroke, true), true), 1200, 835, 62, 56);

  vertex('get-name-open', 'getCommandName(', imageStyle(splitCallImage('start', palette.actionFill, palette.actionStroke, true), true), 1275, 920, 175, 56);
  vertex('get-name-arg', 'c', imageStyle(splitCallImage('middle', palette.valueFill, palette.valueStroke, true), true), 1450, 920, 60, 56);
  vertex('get-name-close', ')', imageStyle(splitCallImage('end', palette.actionFill, palette.actionStroke, true), true), 1510, 920, 62, 56);
  vertex('get-name-op', '===', imageStyle(mosaicImage('middle', palette.expressionFill, palette.actionStroke), true), 1572, 920, 62, 56);
  vertex('get-name-value', 'name', imageStyle(mosaicImage('end', palette.valueFill, palette.valueStroke)), 1634, 920, 105, 56);

  edge('enabled-close', 'name-eq-left', 'true', palette.trueStroke, 'exitX=0.5;exitY=1;entryX=0;entryY=0.5;', [[1208, 720], [815, 720]]);
  edge('name-eq-right', 'find-close', 'match', palette.trueStroke, 'exitX=0.5;exitY=1;entryX=1;entryY=0.5;', [[1092, 815], [1780, 815], [1780, 350]]);
  edge('name-eq-right', 'aliases-value', 'false', palette.errorStroke, 'exitX=0.5;exitY=1;entryX=0;entryY=0.5;');
  edge('includes-close', 'find-close', 'match', palette.trueStroke, 'exitX=1;exitY=0.5;entryX=1;entryY=0.5;', [[1800, 863], [1800, 350]]);
  edge('includes-close', 'get-name-open', 'false', palette.errorStroke, 'exitX=0.5;exitY=1;entryX=0;entryY=0.5;');
  edge('get-name-value', 'find-close', 'match', palette.trueStroke, 'exitX=1;exitY=0.5;entryX=1;entryY=0.5;', [[1820, 948], [1820, 350]]);
  edge('get-name-value', 'candidate', 'next c', palette.errorStroke, 'exitX=0.5;exitY=1;entryX=0.5;entryY=1;', [[1685, 1030], [850, 1030]]);

  // Final comparison and negation after find returns its selected item.
  vertex('find-type', 'found?.type', imageStyle(mosaicImage('start', palette.valueFill, palette.valueStroke)), 875, 1080, 150, 58);
  vertex('type-op', '===', imageStyle(mosaicImage('middle', palette.expressionFill, palette.actionStroke), true), 1025, 1080, 65, 58);
  vertex('local-jsx', "'local-jsx'", imageStyle(mosaicImage('end', '#ffffff', palette.valueStroke)), 1090, 1080, 145, 58);
  vertex('negate', '!', styles.predicate, 1265, 1080, 75, 58);
  edge('find-close', 'find-type', 'found / undefined', palette.valueStroke, 'exitX=0.5;exitY=1;entryX=0;entryY=0.5;', [[795, 1050], [830, 1050]]);
  edge('local-jsx', 'negate', '', palette.actionStroke, 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;');

  vertex('condition-true', 'TRUE: enter remote branch', styles.outcomeTrue, 1120, 1190, 260, 52);
  vertex('condition-false', 'FALSE: continue locally', styles.outcomeFalse, 1420, 1190, 240, 52);
  edge('negate', 'condition-true', 'true', palette.trueStroke, 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;');
  edge('negate', 'condition-false', 'false', palette.errorStroke, 'exitX=1;exitY=0.5;entryX=0.5;entryY=0;', [[1540, 1110]]);
  edge('not-slash-outcome', 'condition-true', 'true', palette.trueStroke, 'exitX=0.5;exitY=1;entryX=0;entryY=0.5;', [[100, 1160], [1080, 1160]]);

  return `<mxfile host="app.diagrams.net" modified="2026-08-03T00:00:00.000Z" agent="Codex" version="24.7.17"><diagram id="active-remote-if-golden" name="Condition"><mxGraphModel dx="1900" dy="1350" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1900" pageHeight="1350" math="0" shadow="0"><root><mxCell id="0" /><mxCell id="1" parent="0" />${cells.join('')}</root></mxGraphModel></diagram></mxfile>`;
}

function verifySource() {
  const source = fs.readFileSync(SOURCE_PATH, 'utf8');
  const expected = "if (activeRemote.isRemoteMode && !(isSlashCommand && commands.find(c => {";
  if (!source.includes(expected)) {
    throw new Error(`Expected condition was not found in ${SOURCE_PATH}`);
  }
}

const args = parseArgs(process.argv);
verifySource();
const outputPath = path.resolve(args.outputPath);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, buildDiagram(), 'utf8');
console.log(JSON.stringify({ ok: true, outputPath, sourcePath: SOURCE_PATH, conditionStableId: CONDITION_STABLE_ID }));
