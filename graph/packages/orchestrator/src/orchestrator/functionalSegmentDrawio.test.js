import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildLayout,
  collapseSameRangeValueRoles,
  collapseShorthandPropertyReferences,
  hideRootTypeContext,
  projectFunctionalSegment,
  renderFunctionalSegmentDrawio,
} from './functionalSegmentDrawio.js';

test('functional segment renders only source-graph entities and relationships', () => {
  const rendered = renderFunctionalSegmentDrawio({
    rootStableId: 'fixture.ts:1:0:1:7:parameter',
    rootLabel: 'helpers',
    nodes: [
      { stableId: 'fixture.ts:1:0:1:7:parameter', name: 'helpers', labels: ['DeveloperDefined', 'Parameter'], annotation: 'Накопленная аннотация helpers' },
      { stableId: 'fixture.ts:1:9:1:27:type-declaration', name: 'PromptInputHelpers', labels: ['DeveloperDefined', 'TypeDeclaration'] },
      { stableId: 'PromptInput.tsx:10:0:40:1:value-declaration', name: 'PromptInput', labels: ['DeveloperDefined', 'Component'] },
      { stableId: 'PromptInput.tsx:20:2:20:8:argument-value:1', name: 'argument 1', labels: ['Value', 'ArgumentValue'] },
      { stableId: 'PromptInput.tsx:22:2:22:7:value-declaration', name: 'clearBuffer', labels: ['DeveloperDefined'], annotation: 'Очищает буфер' },
      { stableId: 'node_modules/node/timers.d.ts:1:0:1:12:value-declaration', name: 'clearTimeout', labels: ['System', 'ValueDeclaration'] },
    ],
    edges: [
      { sourceStableId: 'fixture.ts:1:0:1:7:parameter', targetStableId: 'fixture.ts:1:9:1:27:type-declaration', type: 'TYPED_AS' },
      { sourceStableId: 'PromptInput.tsx:10:0:40:1:value-declaration', targetStableId: 'PromptInput.tsx:20:2:20:8:argument-value:1', type: 'HAS_OPERATION' },
      { sourceStableId: 'PromptInput.tsx:20:2:20:8:argument-value:1', targetStableId: 'fixture.ts:1:0:1:7:parameter', type: 'BINDS_TO_PARAMETER' },
      { sourceStableId: 'PromptInput.tsx:20:2:20:8:argument-value:1', targetStableId: 'PromptInput.tsx:22:2:22:7:value-declaration', type: 'VALUE_FROM' },
      { sourceStableId: 'PromptInput.tsx:22:2:22:7:value-declaration', targetStableId: 'node_modules/node/timers.d.ts:1:0:1:12:value-declaration', type: 'CALLS' },
    ],
  });

  assert.doesNotMatch(rendered.xml, /PromptInputHelpers|edgeType="TYPED_AS"/);
  assert.match(rendered.xml, /PromptInput/);
  assert.match(rendered.xml, /annotationEmbedded="1"/);
  assert.match(rendered.xml, /annotationSavedText=/);
  assert.match(rendered.xml, /Накопленная аннотация helpers/);
  assert.match(rendered.xml, /edgeType="BINDS_TO_PARAMETER"[^>]*value="BINDS_TO_PARAMETER"/);
  assert.match(rendered.xml, /graphKind="System"/);
  assert.doesNotMatch(rendered.xml, /graphKind="Annotation"|annotationTargetId=|annotationLink=|SUPPLIED_BY|System boundary|edgeType="DEPENDS_ON"/);
});

test('functional segment rejects an empty graph', () => {
  assert.throws(() => renderFunctionalSegmentDrawio({ rootStableId: 'helpers', nodes: [] }), /no root or source-graph nodes/i);
});

test('projection keeps real connector paths and removes unannotated owner branches', () => {
  const segment = projectFunctionalSegment({
    rootStableId: 'helpers',
    nodes: [
      { stableId: 'helpers', labels: ['DeveloperDefined'], annotation: 'root annotation' },
      { stableId: 'type', labels: ['DeveloperDefined', 'TypeDeclaration'] },
      { stableId: 'origin', labels: ['ArgumentValue'] },
      { stableId: 'connector', labels: ['Value'] },
      { stableId: 'clearBuffer', labels: ['DeveloperDefined'], annotation: 'clears buffer' },
      { stableId: 'system', labels: ['System'] },
      { stableId: 'PromptInput', labels: ['DeveloperDefined', 'Component'] },
      { stableId: 'owner-operation', labels: ['Call'] },
    ],
    edges: [
      { sourceStableId: 'helpers', targetStableId: 'type', type: 'TYPED_AS' },
      { sourceStableId: 'origin', targetStableId: 'helpers', type: 'BINDS_TO_PARAMETER' },
      { sourceStableId: 'origin', targetStableId: 'connector', type: 'VALUE_FROM' },
      { sourceStableId: 'connector', targetStableId: 'clearBuffer', type: 'RESOLVES_TO' },
      { sourceStableId: 'clearBuffer', targetStableId: 'system', type: 'CALLS' },
      { sourceStableId: 'PromptInput', targetStableId: 'owner-operation', type: 'HAS_OPERATION' },
      { sourceStableId: 'owner-operation', targetStableId: 'origin', type: 'HAS_ARGUMENT' },
    ],
  });

  assert.deepEqual(new Set(segment.nodes.map((node) => node.stableId)), new Set([
    'helpers', 'origin', 'connector', 'clearBuffer', 'system',
  ]));
  assert.equal(segment.edges.length, 4);
  assert.ok(segment.edges.every((edge) => edge.sourceStableId !== 'PromptInput'));
  assert.ok(segment.edges.some((edge) => edge.type === 'BINDS_TO_PARAMETER'));
  assert.ok(segment.edges.every((edge) => edge.type !== 'TYPED_AS'));
});

test('three-way split uses fixed annotation-width lanes for every descendant', () => {
  const segment = hideRootTypeContext({
    rootStableId: 'helpers',
    nodes: [
      { stableId: 'helpers', labels: ['DeveloperDefined'], annotation: 'root' },
      { stableId: 'type', name: 'PromptInputHelpers', labels: ['TypeDeclaration'] },
      { stableId: 'object', labels: ['ArgumentObjectValue'] },
      { stableId: 'branch-a', labels: ['DeveloperDefined'], annotation: 'a' },
      { stableId: 'branch-b', labels: ['DeveloperDefined'], annotation: 'b' },
      { stableId: 'branch-c', labels: ['DeveloperDefined'], annotation: 'c' },
      { stableId: 'a-child', labels: ['Call'] },
      { stableId: 'b-child', labels: ['Call'] },
      { stableId: 'c-child', labels: ['Call'] },
    ],
    edges: [
      { sourceStableId: 'helpers', targetStableId: 'type', type: 'TYPED_AS' },
      { sourceStableId: 'object', targetStableId: 'helpers', type: 'BINDS_TO_PARAMETER' },
      { sourceStableId: 'object', targetStableId: 'branch-a', type: 'HAS_PROPERTY' },
      { sourceStableId: 'object', targetStableId: 'branch-b', type: 'HAS_PROPERTY' },
      { sourceStableId: 'object', targetStableId: 'branch-c', type: 'HAS_PROPERTY' },
      { sourceStableId: 'branch-a', targetStableId: 'a-child', type: 'VALUE_FROM' },
      { sourceStableId: 'branch-b', targetStableId: 'b-child', type: 'VALUE_FROM' },
      { sourceStableId: 'branch-c', targetStableId: 'c-child', type: 'VALUE_FROM' },
    ],
  });
  const layout = buildLayout(segment);

  assert.equal(layout.branchPoint, 'object');
  assert.equal(layout.branchHeads.length, 3);
  assert.equal(layout.positions.get('branch-a').x, layout.positions.get('a-child').x - 95);
  assert.equal(layout.positions.get('branch-b').x, layout.positions.get('b-child').x - 95);
  assert.equal(layout.positions.get('branch-c').x, layout.positions.get('c-child').x - 95);
  assert.equal(layout.positions.get('branch-b').x - layout.positions.get('branch-a').x, 466);
  assert.equal(layout.positions.get('branch-c').x - layout.positions.get('branch-b').x, 466);
  assert.ok(!segment.nodes.some((node) => node.stableId === 'type'));
});

test('shorthand property and same-range value reference share one rendered node', () => {
  const shorthandProperty = 'fixture.ts:2:4:2:19:property-value';
  const valueReference = 'fixture.ts:2:4:2:19:value-reference';
  const segment = collapseShorthandPropertyReferences({
    rootStableId: 'object',
    nodes: [
      { stableId: 'object', labels: ['ObjectConstruction'] },
      { stableId: shorthandProperty, name: 'setCursorOffset', labels: ['Value', 'PropertyValue'] },
      { stableId: valueReference, name: 'setCursorOffset', labels: ['Reference', 'ValueReference'] },
      { stableId: 'declaration', name: 'setCursorOffset', labels: ['DeveloperDefined'] },
    ],
    edges: [
      { sourceStableId: 'object', targetStableId: shorthandProperty, type: 'HAS_PROPERTY' },
      { sourceStableId: shorthandProperty, targetStableId: valueReference, type: 'VALUE_FROM' },
      { sourceStableId: valueReference, targetStableId: 'declaration', type: 'RESOLVES_TO' },
    ],
  });

  assert.equal(segment.nodes.length, 3);
  const merged = segment.nodes.find((node) => node.stableId === shorthandProperty);
  assert.deepEqual(merged.collapsedStableIds, [shorthandProperty, valueReference]);
  assert.ok(merged.labels.includes('PropertyValue'));
  assert.ok(merged.labels.includes('ValueReference'));
  assert.deepEqual(segment.edges.map((edge) => edge.type), ['HAS_PROPERTY', 'RESOLVES_TO']);
  assert.equal(segment.edges[1].sourceStableId, shorthandProperty);
  assert.equal(segment.edges[1].extractedSourceStableId, valueReference);
});

test('explicit property and differently ranged reference remain separate', () => {
  const segment = collapseShorthandPropertyReferences({
    rootStableId: 'object',
    nodes: [
      { stableId: 'object', labels: ['ObjectConstruction'] },
      { stableId: 'fixture.ts:2:4:2:20:property-value', name: 'key', labels: ['PropertyValue'] },
      { stableId: 'fixture.ts:2:9:2:19:value-reference', name: 'value', labels: ['ValueReference'] },
    ],
    edges: [{
      sourceStableId: 'fixture.ts:2:4:2:20:property-value',
      targetStableId: 'fixture.ts:2:9:2:19:value-reference',
      type: 'VALUE_FROM',
    }],
  });
  assert.equal(segment.nodes.length, 3);
  assert.equal(segment.edges.length, 1);
});

test('same-range argument role and object construction share one rendered node', () => {
  const argument = 'fixture.ts:2:4:5:5:argument-value:1';
  const object = 'fixture.ts:2:4:5:5:object-construction';
  const segment = collapseSameRangeValueRoles({
    rootStableId: 'helpers',
    nodes: [
      { stableId: argument, name: 'argument 1', labels: ['Value', 'ArgumentValue'] },
      { stableId: object, name: 'object literal', labels: ['Value', 'ObjectConstruction'] },
      { stableId: 'property', name: 'clearBuffer', labels: ['PropertyValue'] },
      { stableId: 'helpers', name: 'helpers', labels: ['DeveloperDefined', 'Parameter'] },
    ],
    edges: [
      { sourceStableId: argument, targetStableId: object, type: 'VALUE_FROM' },
      { sourceStableId: object, targetStableId: 'property', type: 'HAS_PROPERTY' },
      { sourceStableId: argument, targetStableId: 'helpers', type: 'BINDS_TO_PARAMETER' },
    ],
  });

  assert.equal(segment.nodes.length, 3);
  const merged = segment.nodes.find((node) => node.stableId === argument);
  assert.equal(merged.name, 'argument 1: object literal');
  assert.ok(merged.labels.includes('ArgumentObjectValue'));
  assert.deepEqual(merged.collapsedStableIds, [argument, object]);
  assert.deepEqual(new Set(segment.edges.map((edge) => edge.type)), new Set([
    'HAS_PROPERTY', 'BINDS_TO_PARAMETER',
  ]));
  assert.ok(segment.edges.every((edge) => edge.sourceStableId === argument));
  assert.equal(
    segment.edges.find((edge) => edge.type === 'HAS_PROPERTY').extractedSourceStableId,
    object,
  );
});

test('resolved call absorbs its callee reference and omits unselected overloads', () => {
  const call = 'fixture.ts:2:4:2:29:call';
  const reference = 'fixture.ts:2:4:2:12:value-reference';
  const selectedOverload = 'react.d.ts:10:0:10:80:value-declaration';
  const otherOverload = 'react.d.ts:12:0:12:70:value-declaration';
  const segment = collapseSameRangeValueRoles({
    rootStableId: 'binding',
    nodes: [
      { stableId: 'binding', name: 'setValue', labels: ['DeveloperDefined'] },
      { stableId: call, name: 'useState', labels: ['Call', 'CallResult'] },
      { stableId: reference, name: 'useState', labels: ['Reference', 'ValueReference'] },
      { stableId: selectedOverload, name: 'useState', labels: ['System', 'ValueDeclaration'] },
      { stableId: otherOverload, name: 'useState', labels: ['System', 'ValueDeclaration'] },
    ],
    edges: [
      { sourceStableId: 'binding', targetStableId: call, type: 'READS_FROM' },
      { sourceStableId: call, targetStableId: reference, type: 'CALLS_VALUE' },
      { sourceStableId: call, targetStableId: selectedOverload, type: 'CALLS' },
      { sourceStableId: reference, targetStableId: selectedOverload, type: 'RESOLVES_TO' },
      { sourceStableId: reference, targetStableId: otherOverload, type: 'RESOLVES_TO' },
    ],
  });

  assert.deepEqual(new Set(segment.nodes.map((node) => node.stableId)), new Set([
    'binding', call, selectedOverload,
  ]));
  const merged = segment.nodes.find((node) => node.stableId === call);
  assert.ok(merged.labels.includes('ResolvedCall'));
  assert.deepEqual(merged.collapsedStableIds, [call, reference]);
  assert.deepEqual(segment.edges.map((edge) => edge.type), ['READS_FROM', 'CALLS']);
  assert.ok(segment.edges.every((edge) => edge.type !== 'CALLS_VALUE' && edge.type !== 'RESOLVES_TO'));
});
