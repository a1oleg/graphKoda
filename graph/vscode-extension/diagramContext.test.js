const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { resolveActiveDiagramPath } = require('./diagramContext');

test('resolves a drawio file from the active custom-editor tab', () => {
  const workspaceRoot = path.resolve('C:\\repo');
  const diagramPath = path.join(workspaceRoot, 'graph', 'draw', 'flow.drawio');
  assert.equal(resolveActiveDiagramPath(workspaceRoot, {
    uri: { fsPath: diagramPath },
  }), diagramPath);
});

test('rejects non-diagram and out-of-workspace active tabs', () => {
  const workspaceRoot = path.resolve('C:\\repo');
  assert.equal(resolveActiveDiagramPath(workspaceRoot, {
    uri: { fsPath: path.join(workspaceRoot, 'screens', 'REPL.tsx') },
  }), '');
  assert.equal(resolveActiveDiagramPath(workspaceRoot, {
    uri: { fsPath: path.resolve('C:\\elsewhere', 'flow.drawio') },
  }), '');
});
