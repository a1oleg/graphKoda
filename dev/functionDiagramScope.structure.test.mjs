import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const exporterSource = fs.readFileSync(
  new URL('./exportLocalIterativeCoordinateDrawio.mjs', import.meta.url),
  'utf8',
);
const loaderSource = fs.readFileSync(
  new URL('../graph/packages/orchestrator/src/orchestrator/localCoordinateSync.js', import.meta.url),
  'utf8',
);
const extensionSource = fs.readFileSync(
  new URL('../graph/vscode-extension/extension.js', import.meta.url),
  'utf8',
);

test('function diagrams have no hop-depth option or bounded traversal loader', () => {
  assert.doesNotMatch(exporterSource, /--depth|args\.depth|loadOnSubmitSubgraphIterative/u);
  assert.doesNotMatch(extensionSource, /--depth/u);
  assert.doesNotMatch(loaderSource, /loadOnSubmitSubgraphIterative|numericDepth|frontierElementIds/u);
});

test('function diagrams traverse from the function NEXT entry and stop at the function boundary', () => {
  assert.match(exporterSource, /await loadFunctionDiagramSubgraph\(\s*driver,\s*config\.database,\s*fnStableId,?\s*\)/u);
  assert.match(loaderSource, /MATCH \(fn:Fn \{stableId: \$fnStableId\}\)/u);
  assert.match(loaderSource, /OPTIONAL MATCH \(fn\)-\[relationship:NEXT \{source: \$source\}\]->\(owned\)/u);
  assert.match(loaderSource, /UNWIND \$frontier AS sourceElementId/u);
  assert.match(loaderSource, /elementId\(source\) = sourceElementId/u);
  assert.match(loaderSource, /coalesce\(target\.parentFnStableId, target\.parent_fn_stable_id\) = \$fnStableId/u);
  assert.doesNotMatch(loaderSource, /MATCH \(target\)-\[relationship \{source: \$source\}\]->\(source\)/u);
  assert.match(loaderSource, /MATCH \(step:Step \{stableId: stableId\}\)/u);
  assert.match(loaderSource, /MATCH \(block:Block \{stableId: stableId\}\)/u);
  assert.doesNotMatch(loaderSource, /OPTIONAL MATCH \(local\)/u);
  assert.match(exporterSource, /implicitLocalFunctionScope\?\.directDeclarationStableId/u);
  assert.match(exporterSource, /currentFunctionOwners\.has\(localFunctionOwner\)/u);
  assert.match(exporterSource, /declaration:LocalFunctionProxy OR declaration:FnDeclaration/u);
  assert.match(exporterSource, /parentLocalFunctionStableId/u);
});

test('graph explorer exposes only onSubmit with the extension icon', () => {
  assert.match(extensionSource, /name: 'onSubmit'/u);
  assert.doesNotMatch(extensionSource, /name: 'onDone'/u);
  assert.match(extensionSource, /path\.join\(this\.extensionPath, 'media', 'graph-flow\.svg'\)/u);
});
