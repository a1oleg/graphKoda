import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isFunctionFlowCompositionRelationship,
  isFunctionFlowRenderedRelationship,
  isFunctionFlowTraversalRelationship,
  isFunctionFlowVisibleRelationship,
  isFunctionalSegmentVisibleRelationship,
  relationshipTypesForAnnotation,
} from './relationshipSemantics.js';

test('annotation composition is independent from renderer presentation', () => {
  const composition = relationshipTypesForAnnotation('composition');
  assert.ok(composition.includes('EVAL'));
  assert.ok(composition.includes('ARG'));
  assert.ok(composition.includes('FIELD'));
  assert.ok(!composition.includes('PASSES_VALUE'));
  assert.ok(!composition.includes('COMPOSES_SYNTAX'));
  assert.ok(!composition.includes('RESOLVES_TO'));
  assert.equal(isFunctionFlowTraversalRelationship('ARG'), true);
  assert.equal(isFunctionFlowCompositionRelationship('ARG'), true);
  assert.equal(isFunctionFlowVisibleRelationship('ARG'), false);
  assert.equal(isFunctionFlowRenderedRelationship({ type: 'ARG', props: {} }), false);
  assert.equal(isFunctionFlowRenderedRelationship({
    type: 'ARG',
    props: { flowFamilyConnector: true },
  }), true);
  assert.equal(isFunctionFlowTraversalRelationship('FIELD'), true);
  assert.equal(isFunctionFlowCompositionRelationship('FIELD'), true);
  assert.equal(isFunctionFlowVisibleRelationship('FIELD'), false);
});

test('syntax composition is available to composition rendering but not drawn as an edge', () => {
  assert.equal(isFunctionFlowCompositionRelationship('COMPOSES_SYNTAX'), true);
  assert.equal(isFunctionFlowTraversalRelationship('COMPOSES_SYNTAX'), false);
  assert.equal(isFunctionFlowVisibleRelationship('COMPOSES_SYNTAX'), false);
  assert.equal(isFunctionalSegmentVisibleRelationship('COMPOSES_SYNTAX'), false);
});

test('resolution stays semantic without leaking into a function-flow diagram', () => {
  assert.deepEqual(relationshipTypesForAnnotation('resolution'), ['RESOLVES_TO', 'USES_REFERENCE']);
  assert.equal(isFunctionFlowTraversalRelationship('RESOLVES_TO'), false);
  assert.equal(isFunctionFlowVisibleRelationship('RESOLVES_TO'), false);
  assert.equal(isFunctionalSegmentVisibleRelationship('RESOLVES_TO'), true);
});

test('unknown execution relations preserve existing renderer behavior', () => {
  assert.equal(isFunctionFlowTraversalRelationship('NEXT'), true);
  assert.equal(isFunctionFlowVisibleRelationship('NEXT'), true);
});
