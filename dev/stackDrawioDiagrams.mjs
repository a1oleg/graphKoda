import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const result = {
    basePath: '',
    appendPath: '',
    outputPath: '',
    prefix: 'stacked',
    gap: 80,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base') result.basePath = argv[++index] || '';
    else if (arg === '--append') result.appendPath = argv[++index] || '';
    else if (arg === '--output') result.outputPath = argv[++index] || '';
    else if (arg === '--prefix') result.prefix = argv[++index] || result.prefix;
    else if (arg === '--gap') result.gap = Number(argv[++index]);
  }
  if (!result.basePath || !result.appendPath || !result.outputPath) {
    throw new Error(
      'Usage: node dev/stackDrawioDiagrams.mjs --base <file> --append <file> --output <file> [--prefix <id>] [--gap <px>]',
    );
  }
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(result.prefix)) {
    throw new Error(`Invalid ID prefix: ${result.prefix}`);
  }
  if (!Number.isFinite(result.gap) || result.gap < 0) {
    throw new Error(`Invalid gap: ${result.gap}`);
  }
  return result;
}

function rootContent(xml, filePath) {
  const start = xml.indexOf('<root>');
  const end = xml.lastIndexOf('</root>');
  if (start < 0 || end < start) throw new Error(`No draw.io root in ${filePath}`);
  const content = xml.slice(start + '<root>'.length, end);
  return content
    .replace(/^\s*<mxCell id="0"\s*\/>\s*/u, '')
    .replace(/^\s*<mxCell id="1" parent="0"\s*\/>\s*/u, '');
}

function layoutBounds(xml, filePath) {
  const match = xml.match(
    /<mxCell id="fold-layout-root"[^>]*>\s*<mxGeometry x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/u,
  );
  if (match) {
    const [, x, y, width, height] = match.map(Number);
    if (![x, y, width, height].every(Number.isFinite)) {
      throw new Error(`Invalid fold-layout-root geometry in ${filePath}`);
    }
    return { x, y, width, height, kind: 'fold-root' };
  }

  const geometries = [...xml.matchAll(
    /<mxCell\b(?=[^>]*\bparent="1")(?=[^>]*\bvertex="1")[^>]*>\s*<mxGeometry x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/gu,
  )].map((geometryMatch) => geometryMatch.slice(1, 5).map(Number))
    .filter((values) => values.every(Number.isFinite));
  if (!geometries.length) throw new Error(`No top-level vertex geometry in ${filePath}`);
  const x = Math.min(...geometries.map(([itemX]) => itemX));
  const y = Math.min(...geometries.map(([, itemY]) => itemY));
  const right = Math.max(...geometries.map(([itemX, , width]) => itemX + width));
  const bottom = Math.max(...geometries.map(([, itemY, , height]) => itemY + height));
  return { x, y, width: right - x, height: bottom - y, kind: 'flat' };
}

function stackedLayoutBottom(xml, filePath) {
  const bounds = layoutBounds(xml, filePath);
  return bounds.y + bounds.height;
}

function modelDimension(xml, name) {
  const value = Number(xml.match(new RegExp(`\\b${name}="([^"]+)"`, 'u'))?.[1]);
  return Number.isFinite(value) ? value : 0;
}

function prefixCellReferences(fragment, prefix) {
  return fragment.replace(
    /\b(id|parent|source|target)="([^"]+)"/gu,
    (match, attribute, value) => {
      if (attribute === 'parent' && value === '1') return match;
      return `${attribute}="${prefix}-${value}"`;
    },
  );
}

const args = parseArgs(process.argv);
const baseXml = fs.readFileSync(args.basePath, 'utf8');
const appendXml = fs.readFileSync(args.appendPath, 'utf8');
const appendBounds = layoutBounds(appendXml, args.appendPath);
const prefixedCellPattern = new RegExp(
  `<mxCell id="${args.prefix}-[^"]+"[^>]*(?:\\s*/>|>[\\s\\S]*?</mxCell>)`,
  'gu',
);
const cleanBaseXml = baseXml.replace(prefixedCellPattern, '');
const baseBounds = layoutBounds(cleanBaseXml, args.basePath);
const appendY = stackedLayoutBottom(cleanBaseXml, args.basePath) + args.gap;
let appended = prefixCellReferences(rootContent(appendXml, args.appendPath), args.prefix);
if (appendBounds.kind === 'fold-root') {
  appended = appended.replace(
    new RegExp(
      `(<mxCell id="${args.prefix}-fold-layout-root"[^>]*>\\s*<mxGeometry x=")[^"]+(" y=")[^"]+(" width=")`,
      'u',
    ),
    `$1${appendBounds.x}$2${appendY}$3`,
  );
} else {
  const stackRootId = `${args.prefix}-stack-root`;
  appended = appended.replace(/\bparent="1"/gu, `parent="${stackRootId}"`);
  const stackRoot = `<mxCell id="${stackRootId}" value="" style="group;html=1;container=1;collapsible=0;" parent="1" vertex="1"><mxGeometry x="0" y="${appendY - appendBounds.y}" width="${appendBounds.x + appendBounds.width}" height="${appendBounds.y + appendBounds.height}" as="geometry" /></mxCell>`;
  appended = `${stackRoot}${appended}`;
}

const rootEnd = cleanBaseXml.lastIndexOf('</root>');
if (rootEnd < 0) throw new Error(`No draw.io root in ${args.basePath}`);
let output = `${cleanBaseXml.slice(0, rootEnd)}${appended}${cleanBaseXml.slice(rootEnd)}`;
const pageWidth = Math.max(
  modelDimension(baseXml, 'pageWidth'),
  modelDimension(appendXml, 'pageWidth'),
  appendBounds.x + appendBounds.width + 240,
);
const pageHeight = Math.max(
  modelDimension(baseXml, 'pageHeight'),
  appendY + appendBounds.height + 120,
);
output = output
  .replace(/\bpageWidth="[^"]+"/u, `pageWidth="${Math.ceil(pageWidth)}"`)
  .replace(/\bpageHeight="[^"]+"/u, `pageHeight="${Math.ceil(pageHeight)}"`);

fs.mkdirSync(path.dirname(args.outputPath), { recursive: true });
fs.writeFileSync(args.outputPath, output, 'utf8');
console.log(JSON.stringify({
  ok: true,
  outputPath: args.outputPath,
  base: { path: args.basePath, ...baseBounds },
  appended: {
    path: args.appendPath,
    prefix: args.prefix,
    x: appendBounds.x,
    y: appendY,
    width: appendBounds.width,
    height: appendBounds.height,
  },
  pageWidth: Math.ceil(pageWidth),
  pageHeight: Math.ceil(pageHeight),
}, null, 2));
