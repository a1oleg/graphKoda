const fs = require('node:fs');
const path = require('node:path');

const DIAGRAM_OUTPUT_RELATIVE_DIR = path.join('graph', 'draw', 'generated');
const DIAGRAM_KINDS = new Set(['flow', 'sequence', 'functional-segment']);
const pendingRenders = new Map();

function diagramLabelSlug(label) {
  const slug = String(label || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/^Fn\s+/i, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'function';
}

function diagramSourceCoordinate(functionStableId) {
  const stableId = String(functionStableId || '').trim();
  const match = stableId.match(/^(.*):(\d+):(\d+):(\d+):(\d+)(?::.*)?$/);
  if (!match) return null;
  return {
    fileName: path.basename(match[1].replace(/\\/g, '/')),
    startLine: Number(match[2]),
  };
}

function diagramFileName({ kind, functionStableId, label }) {
  const normalizedKind = String(kind || '').toLowerCase();
  if (!DIAGRAM_KINDS.has(normalizedKind)) {
    throw new Error(`Unsupported diagram kind: ${kind}`);
  }
  const stableId = String(functionStableId || '').trim();
  if (!stableId) throw new Error('The diagram has no function stable ID.');
  const coordinate = diagramSourceCoordinate(stableId);
  const sourceSuffix = coordinate ? `-${coordinate.fileName}-${coordinate.startLine}` : '';
  const kindSuffix = normalizedKind === 'sequence'
    ? '-sequence'
    : normalizedKind === 'functional-segment'
      ? '-functional-segment'
      : '';
  return `${diagramLabelSlug(label)}${sourceSuffix}${kindSuffix}.drawio`;
}

function diagramOutputDirectory(workspaceRoot) {
  return path.join(path.resolve(workspaceRoot), DIAGRAM_OUTPUT_RELATIVE_DIR);
}

function diagramFilePath(workspaceRoot, descriptor) {
  return path.join(diagramOutputDirectory(workspaceRoot), diagramFileName(descriptor));
}

async function ensureDiagramFile(workspaceRoot, descriptor, render) {
  const outputPath = diagramFilePath(workspaceRoot, descriptor);
  const pending = pendingRenders.get(outputPath);
  if (pending) return pending;

  const renderPromise = (async () => {
    const refreshed = fs.existsSync(outputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await render(outputPath);
    if (!fs.existsSync(outputPath)) {
      throw new Error(`Renderer did not create ${outputPath}.`);
    }
    return { filePath: outputPath, reused: false, refreshed };
  })();
  pendingRenders.set(outputPath, renderPromise);
  try {
    return await renderPromise;
  } finally {
    pendingRenders.delete(outputPath);
  }
}

module.exports = {
  DIAGRAM_OUTPUT_RELATIVE_DIR,
  diagramFileName,
  diagramFilePath,
  diagramLabelSlug,
  diagramOutputDirectory,
  diagramSourceCoordinate,
  ensureDiagramFile,
};
