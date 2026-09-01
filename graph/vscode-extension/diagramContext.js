const path = require('node:path');

function resolveActiveDiagramPath(workspaceRoot, tabInput) {
  const fsPath = String(tabInput?.uri?.fsPath || '').trim();
  if (!fsPath || path.extname(fsPath).toLowerCase() !== '.drawio') return '';

  const root = path.resolve(workspaceRoot);
  const candidate = path.resolve(fsPath);
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return '';
  return candidate;
}

module.exports = { resolveActiveDiagramPath };
