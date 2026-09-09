import assert from 'node:assert/strict';
import test from 'node:test';

import { scopeCanonicalReferenceGraph } from './fromASTtoPreGraphFlow.ts';
import type { CanonicalEntity, CanonicalRelationship } from './functionFlowDuckdbStage.ts';

function entity(
  stableId: string,
  labels: string[],
  repoRelativePath: string,
  startLine: number,
  endLine = startLine,
): CanonicalEntity {
  return {
    stableId,
    labels,
    props: {
      repoRelativePath,
      startLine,
      startColumn: 0,
      endLine,
      endColumn: endLine === startLine ? 10 : 1,
    },
  };
}

function relationship(fromId: string, toId: string, type: string): CanonicalRelationship {
  return { fromId, toId, type, props: {} };
}

test('export modifiers do not exclude a function from its own scoped import', () => {
  const fn = entity('subject.ts:1:7:10:1', ['FunctionImplementation'], 'subject.ts', 1, 10);
  const parameter = entity('subject.ts:1:25:1:30', ['Parameter'], 'subject.ts', 1);
  parameter.props.startColumn = 25;
  parameter.props.endColumn = 30;
  const jsx = entity('subject.ts:4:2:4:10', ['ComponentConstruction'], 'subject.ts', 4);
  const edges = [relationship(fn.stableId, parameter.stableId, 'HAS_PARAMETER'),
    relationship(fn.stableId, jsx.stableId, 'DECLARES_JSX')];
  const result = scopeCanonicalReferenceGraph({ entities: [fn, parameter, jsx], relationships: edges }, fn.stableId);
  assert.deepEqual(result.relationships, edges);
  assert.ok(result.entities.some(e => e.stableId === fn.stableId));
});

test('scoped canonical graph keeps boundary references without entering callee bodies', () => {
  const fnId = 'subject.ts:1:0:10:1';
  const localCallId = 'subject.ts:3:2:3:8';
  const calleeId = 'callee.ts:1:0:5:1';
  const calleeOperationId = 'callee.ts:2:2:2:9';
  const systemId = 'node_modules/runtime.d.ts:1:0:1:20';
  const entities = [
    entity(fnId, ['FunctionImplementation'], 'subject.ts', 1, 10),
    entity(localCallId, ['Call'], 'subject.ts', 3),
    entity(calleeId, ['CallableDeclaration', 'DeveloperDefined'], 'callee.ts', 1, 5),
    entity(calleeOperationId, ['Call'], 'callee.ts', 2),
    entity(systemId, ['CallableDeclaration', 'System'], 'node_modules/runtime.d.ts', 1),
  ];
  const relationships = [
    relationship(fnId, localCallId, 'AST_CHILD'),
    relationship(localCallId, calleeId, 'CALLS'),
    relationship(calleeId, calleeOperationId, 'AST_CHILD'),
    relationship(calleeOperationId, systemId, 'CALLS'),
  ];

  const scoped = scopeCanonicalReferenceGraph({ entities, relationships }, fnId);
  const ids = new Set(scoped.entities.map((row) => row.stableId));

  assert(ids.has(localCallId));
  assert(ids.has(calleeId), 'the direct callable boundary must remain available');
  assert(!ids.has(calleeOperationId), 'the scoped import must not enter the callee body');
  assert(!ids.has(systemId), 'transitive dependencies belong to the existing full graph');
  assert(scoped.relationships.some((row) => row.fromId === localCallId && row.toId === calleeId));
});

test('scoped canonical graph retains a bounded supplied-object frame for a local parameter', () => {
  const fnId = 'subject.ts:1:0:10:1';
  const parameterId = 'subject.ts:1:20:1:27';
  const objectId = 'caller.ts:5:10:8:3';
  const propertyId = 'caller.ts:6:2:6:8';
  const referenceId = 'caller.ts:6:2:6:8:reference';
  const declarationId = 'caller.ts:2:0:2:12';
  const declarationBodyId = 'caller.ts:2:15:2:30';
  const entities = [
    entity(fnId, ['FunctionImplementation'], 'subject.ts', 1, 10),
    entity(parameterId, ['Parameter'], 'subject.ts', 1),
    entity(objectId, ['ObjectConstruction'], 'caller.ts', 5, 8),
    entity(propertyId, ['PropertyValue'], 'caller.ts', 6),
    entity(referenceId, ['Reference'], 'caller.ts', 6),
    entity(declarationId, ['ValueDeclaration'], 'caller.ts', 2),
    entity(declarationBodyId, ['Call'], 'caller.ts', 2),
  ];
  const relationships = [
    relationship(fnId, parameterId, 'AST_CHILD'),
    relationship(objectId, parameterId, 'BINDS_TO_PARAMETER'),
    relationship(objectId, propertyId, 'HAS_PROPERTY'),
    relationship(propertyId, referenceId, 'VALUE_FROM'),
    relationship(referenceId, declarationId, 'RESOLVES_TO'),
    relationship(declarationId, declarationBodyId, 'AST_CHILD'),
  ];

  const scoped = scopeCanonicalReferenceGraph({ entities, relationships }, fnId);
  const ids = new Set(scoped.entities.map((row) => row.stableId));

  assert(ids.has(objectId));
  assert(ids.has(propertyId));
  assert(ids.has(referenceId));
  assert(ids.has(declarationId));
  assert(!ids.has(declarationBodyId), 'the referenced declaration is a boundary, not a new owned range');
});

test('scoped canonical graph keeps sibling writes to an external React state slot as boundaries', () => {
  const fnId = 'subject.ts:10:0:14:1';
  const localWriteId = 'subject.ts:11:2:11:20';
  const siblingWriteId = 'subject.ts:20:2:20:20';
  const siblingBodyId = 'subject.ts:21:2:21:20';
  const stateId = 'subject.ts:2:9:2:18';
  const entities = [
    entity(fnId, ['FunctionImplementation'], 'subject.ts', 10, 14),
    entity(localWriteId, ['Call'], 'subject.ts', 11),
    entity(siblingWriteId, ['Call'], 'subject.ts', 20),
    entity(siblingBodyId, ['Call'], 'subject.ts', 21),
    entity(stateId, ['ValueSlot', 'ReactState'], 'subject.ts', 2),
  ];
  const relationships = [
    relationship(fnId, localWriteId, 'AST_CHILD'),
    relationship(localWriteId, stateId, 'WRITES_TO'),
    relationship(siblingWriteId, stateId, 'WRITES_TO'),
    relationship(siblingWriteId, siblingBodyId, 'AST_CHILD'),
  ];

  const scoped = scopeCanonicalReferenceGraph({ entities, relationships }, fnId);
  const ids = new Set(scoped.entities.map((row) => row.stableId));
  assert(ids.has(siblingWriteId), 'the sibling write is a one-hop state provenance boundary');
  assert(!ids.has(siblingBodyId), 'the sibling writer body must not be expanded');
  assert(scoped.relationships.some((row) => row.fromId === siblingWriteId && row.toId === stateId));
});

test('scoped parameter frame retains JSX spread provenance', () => {
  const fn = 'subject.ts:1:0:10:1';
  const parameter = 'subject.ts:1:20:1:27';
  const props = 'caller.ts:5:1:5:20';
  const spread = 'caller.ts:5:2:5:19';
  const reference = 'caller.ts:5:6:5:18';
  const declaration = 'caller.ts:2:0:2:12';
  const graph = {
    entities: [entity(fn, ['FunctionImplementation'], 'subject.ts', 1, 10),
      entity(parameter, ['Parameter'], 'subject.ts', 1),
      entity(props, ['ObjectConstruction'], 'caller.ts', 5),
      entity(spread, ['SpreadValue'], 'caller.ts', 5),
      entity(reference, ['Reference'], 'caller.ts', 5),
      entity(declaration, ['ValueDeclaration'], 'caller.ts', 2)],
    relationships: [relationship(fn, parameter, 'AST_CHILD'),
      relationship(props, parameter, 'BINDS_TO_PARAMETER'),
      relationship(props, spread, 'SPREADS_FROM'),
      relationship(spread, reference, 'VALUE_FROM'),
      relationship(reference, declaration, 'RESOLVES_TO')],
  };
  const scoped = scopeCanonicalReferenceGraph(graph, fn);
  assert(scoped.entities.some(n => n.stableId === declaration));
  assert(scoped.relationships.some(r => r.type === 'SPREADS_FROM'));
});
