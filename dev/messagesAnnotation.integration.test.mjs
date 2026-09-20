import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

// Run `node dev/inspectMessagesAnnotation.mjs --resolve` against the real local
// graph first. No manufactured nodes, paths, or source fixtures are used here.
const report = JSON.parse(fs.readFileSync('tmp/messages-annotation-audit.json', 'utf8'));
test('messages: destructured origins retain their field selection', () => {
  const selected = report.generationOrder.filter(item => item.context.selectedProperty === 'messages');
  assert.ok(selected.length >= 2);
  for (const item of selected) {
    assert.equal(item.context.selectedProperty, 'messages');
    for (const selection of item.context.selections) {
      assert.equal(selection.propertyName, 'messages');
      assert.ok(selection.evidencePath.relationshipTypes.includes('HAS_PROPERTY'));
    }
    assert.ok(item.dependencies.every(d => d.role === 'selected-property-origin'));
  }
  assert.ok(selected.some(i => i.context.selections.length > 0));
  assert.ok(selected.some(i => i.dependencies.some(d => d.annotationKind === 'CallSite')),
    'Selected calls must remain explicit steps, not be dropped or skipped to their bodies');
});
test('messages: aggregate parameters and type references are not generation tasks', () => {
  const ids = new Set(report.generationOrder.map(i => i.stableId));
  assert.ok(!ids.has('services/api/claude.ts:714:49:728:1'));
  assert.ok(!ids.has('services/api/claude.ts:757:47:771:1'));
  assert.ok(!ids.has('utils/hooks/apiQueryHookHelper.ts:59:25:59:44'));
  assert.ok(report.generationOrder.length < 208);
  assert.ok(ids.has('services/api/claude.ts:1023:2:1023:21'));
  assert.ok(ids.has('utils/hooks/apiQueryHookHelper.ts:69:12:69:52'));
});
