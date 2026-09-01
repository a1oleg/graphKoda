import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hydrateSyntaxCompositions,
  isProjectionOnlySemanticEdge,
  loadFunctionDiagramSubgraph,
} from './localCoordinateSync.js';

function record(values) {
  return { get: (key) => values[key] };
}

test('renderer compatibility mosaic is hydrated from extracted composition relationships', () => {
  const nodes = [{
    key: 'fixture.ts:1:0:1:14:call-role',
    labels: ['Call'],
    props: {
      actionTextRaw: 'consume(value)',
      compositionLayout: 'diagonal',
      compositionPrimaryOrder: 0,
    },
  }];
  const parts = [{ key: 'fixture.ts:1:8:1:13', labels: ['ValueReference'], props: { syntax: 'value' } }];
  const edges = [{
    start: 'fixture.ts:1:0:1:14',
    end: 'fixture.ts:1:8:1:13',
    type: 'COMPOSES_SYNTAX',
    props: { order: 1, partKind: 'value', layout: 'diagonal' },
  }];
  const [hydrated] = hydrateSyntaxCompositions(nodes, parts, edges);
  const renderedParts = JSON.parse(hydrated.props.renderPartsJson);

  assert.equal(hydrated.props.renderPartsSource, 'COMPOSES_SYNTAX');
  assert.equal(hydrated.props.renderPartsLayout, 'diagonal');
  assert.deepEqual(renderedParts.map((part) => part.stableId), [
    'fixture.ts:1:0:1:14:call-role',
    'fixture.ts:1:8:1:13',
  ]);
});

test('collection iteration chain remains available to coordinate traversal', () => {
  const extracted = (type) => ({
    type,
    props: { semantic_expansion: 'collection-iteration' },
  });

  assert.equal(isProjectionOnlySemanticEdge(extracted('NEXT')), false);
  assert.equal(isProjectionOnlySemanticEdge(extracted('YIELDS_VALUE')), false);
  assert.equal(isProjectionOnlySemanticEdge(extracted('READS_VALUE')), false);
});

test('extracted state update closing boundary remains available to coordinate traversal', () => {
  assert.equal(isProjectionOnlySemanticEdge({
    type: 'NEXT',
    props: { semantic_expansion: 'state-update' },
  }), false);
});

test('diagram loading admits every brace layer of an object family reached from a declaration mosaic', async () => {
  const fnStableId = 'fixture.ts:1:0:6:1';
  const declarationStableId = 'fixture.ts:2:8:5:10';
  const familyStableId = `${declarationStableId}:declared-element-type:brace:left:0`;
  const closeStableId = `${declarationStableId}:declare-close`;
  const graphNode = (elementId, labels, props) => ({ elementId, labels, props });
  const graphEdge = (elementId, startElementId, endElementId, type) => ({
    elementId,
    startElementId,
    endElementId,
    type,
    props: { source: 'semantic/functionFlowGraph' },
  });
  const fn = graphNode('fn', ['Fn'], { stableId: fnStableId });
  const declaration = graphNode('declaration', ['Collection', 'Declaration'], {
    stableId: declarationStableId,
    parentFnStableId: fnStableId,
  });
  const leftBrace = graphNode('left-brace', ['ObjectBrace', 'ObjectType', 'Open'], {
    stableId: familyStableId,
    parentFnStableId: fnStableId,
    objectFamilyStableId: familyStableId,
    objectBraceMosaicNeighborStableId: declarationStableId,
  });
  const rightBrace = graphNode('right-brace', ['ObjectBrace', 'ObjectType', 'Close'], {
    stableId: `${declarationStableId}:declared-element-type:brace:right:0`,
    parentFnStableId: fnStableId,
    objectFamilyStableId: familyStableId,
    objectBraceMosaicNeighborStableId: closeStableId,
  });
  const innerLeftBrace = graphNode('inner-left-brace', ['ObjectBrace', 'ObjectType', 'Open'], {
    stableId: `${declarationStableId}:declared-element-type:brace:left:1`,
    parentFnStableId: fnStableId,
    objectFamilyStableId: familyStableId,
  });
  const innerRightBrace = graphNode('inner-right-brace', ['ObjectBrace', 'ObjectType', 'Close'], {
    stableId: `${declarationStableId}:declared-element-type:brace:right:1`,
    parentFnStableId: fnStableId,
    objectFamilyStableId: familyStableId,
  });
  const field = graphNode('field', ['Field', 'ObjectTypeField'], {
    stableId: `${declarationStableId}:declared-element-type:field:0`,
    parentFnStableId: fnStableId,
    objectFamilyStableId: familyStableId,
  });
  const close = graphNode('close', ['FieldJoin', 'TypeFamilyClose'], {
    stableId: closeStableId,
    parentFnStableId: fnStableId,
  });
  const ownership = graphEdge('ownership', 'fn', 'declaration', 'NEXT');
  const fieldEntry = graphEdge('field-entry', 'left-brace', 'field', 'FIELD');
  const fieldJoin = graphEdge('field-join', 'field', 'right-brace', 'FieldJoin');

  const session = {
    async run(query) {
      if (query.includes('MATCH (fn:Fn {stableId: $fnStableId})')) {
        return { records: [record({
          fn,
          ownedNodes: [declaration],
          ownershipEdges: [ownership],
        })] };
      }
      if (query.includes('UNWIND $frontier AS sourceElementId')) {
        return { records: [record({ targetNodes: [], relationships: [] })] };
      }
      if (query.includes('reachedElementIds')) {
        return { records: [record({ relationships: [ownership] })] };
      }
      if (query.includes('MATCH (anchor:ObjectBrace)')) {
        return { records: [record({
          nodes: [leftBrace, rightBrace, innerLeftBrace, innerRightBrace, field, close],
          relationships: [fieldEntry, fieldJoin],
        })] };
      }
      if (query.includes('COMPOSES_SYNTAX')) {
        return { records: [record({ parts: [], relationships: [] })] };
      }
      throw new Error(`Unexpected loader query: ${query}`);
    },
    async close() {},
  };
  const driver = { session: () => session };

  const loaded = await loadFunctionDiagramSubgraph(driver, 'neo4j', fnStableId);

  assert.ok(loaded.nodes.some((node) => node.key === familyStableId));
  assert.ok(loaded.nodes.some((node) => node.key === innerLeftBrace.props.stableId));
  assert.ok(loaded.nodes.some((node) => node.key === innerRightBrace.props.stableId));
  assert.ok(loaded.nodes.some((node) => node.key === closeStableId));
  assert.ok(loaded.semanticEdges.some((edge) => (
    edge.type === 'FIELD' && edge.start === familyStableId
  )));
  assert.ok(loaded.semanticEdges.some((edge) => (
    edge.type === 'FieldJoin' && edge.end === rightBrace.props.stableId
  )));
});
