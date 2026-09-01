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
