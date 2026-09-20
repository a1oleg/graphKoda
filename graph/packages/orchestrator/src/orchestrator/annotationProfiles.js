import neo4j from 'neo4j-driver';

import { relationshipTypesForAnnotation } from './relationshipSemantics.js';
import { loadProjectionDependencies, projectionProfiles } from './projectionContext.js';
import { loadPropertyProjectionContexts } from './propertyProjectionContext.js';

const PROFILE_VERSION = 13;

function normalizeNeo4jValue(value) {
  if (neo4j.isInt(value)) return value.inSafeRange() ? value.toNumber() : value.toString();
  if (Array.isArray(value)) return value.map(normalizeNeo4jValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, normalizeNeo4jValue(nested)]));
  }
  return value;
}

function parseCallableRoleBindings(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Object.entries(parsed)
      .filter(([, stableId]) => typeof stableId === 'string' && stableId.length > 0)
      .map(([role, stableId]) => ({ role, stableId }));
  } catch {
    return [];
  }
}

export function inferAnnotationKind(labels, explicitKind) {
  const labelSet = new Set(labels || []);
  if (labelSet.has('VisualProxy') || labelSet.has('PresentationOnly')) return null;
  if (explicitKind === 'Projection' || explicitKind === 'SelectedMember') return explicitKind;
  const typeOnlyDeclaration = (
    labelSet.has('TypeReference')
    || labelSet.has('TypeDeclaration')
    || labelSet.has('TypeAliasDeclaration')
    || labelSet.has('AliasDeclaration')
    || labelSet.has('TypeMember')
  ) && !(
    labelSet.has('ValueSlot')
    || labelSet.has('ValueDeclaration')
    || labelSet.has('Parameter')
    || labelSet.has('Fn')
    || labelSet.has('FunctionImplementation')
    || labelSet.has('CallableDeclaration')
    || labelSet.has('Component')
  );
  // Type-only declarations constrain code but do not execute it. Keep them in
  // the subject context as reference evidence; never turn them into recursive
  // functional-annotation tasks merely because an extracted annotationKind is
  // present on the declaration.
  if (typeOnlyDeclaration) return null;
  // A function head is accumulated through its direct steps and flow blocks.
  // DeveloperDefined describes its ownership boundary, not a competing
  // annotation role.
  if (labelSet.has('Fn')) return 'Callable';
  if (labelSet.has('DeveloperDefined') && (
    labelSet.has('Parameter')
    || labelSet.has('ValueDeclaration')
    || labelSet.has('FunctionImplementation')
    || labelSet.has('Component')
  )) return 'FunctionalEntity';
  // A local function declaration is rendered as a value slot, but its semantic
  // subject is the declared callable rather than the variable holding it.
  if (labelSet.has('FnDeclaration')) return 'Callable';
  // Extracted operation roles are authoritative when a legacy annotationKind
  // still describes the value/container represented by the same code range.
  if (labelSet.has('Call') || labelSet.has('Request') || labelSet.has('Op') || labelSet.has('PredicateCall')) return 'CallSite';
  if (explicitKind) return String(explicitKind);
  if (labelSet.has('Flow') && labelSet.has('Block')) return 'FlowBlock';
  if (labelSet.has('Loop')) return 'Loop';
  if (labelSet.has('Primitive')) return 'ExecutionPrimitive';
  if (labelSet.has('Step')) return 'Step';
  if (labelSet.has('ValueAccess')) return 'ValueUse';
  if (labelSet.has('ValueSlot')) return 'Binding';
  if (labelSet.has('Storage') || labelSet.has('Cell') || labelSet.has('Setting')) return 'StorageCell';
  if (labelSet.has('File') || labelSet.has('Package')) return 'Module';
  if (labelSet.has('External')) return 'ExternalComponent';
  if (labelSet.has('UiSurface')) return 'UiSurface';
  if (labelSet.has('DetachedAsyncCall') || labelSet.has('AwaitedAsyncCall')) return 'AsyncFlow';
  return null;
}

async function runSingle(session, query, parameters) {
  const result = await session.run(query, parameters);
  if (!result.records.length) return null;
  return normalizeNeo4jValue(result.records[0].toObject());
}

const ANNOTATION_COMPOSITION_RELATION_TYPES = relationshipTypesForAnnotation('composition');

function contextualDependency(candidate, role, ordinal) {
  const labels = candidate?.labels || [];
  const annotationKind = inferAnnotationKind(labels, candidate?.annotationKind);
  if (!candidate?.stableId || !annotationKind) return null;
  return {
    stableId: candidate.stableId,
    annotationKind,
    role,
    dependencyKind: 'semantic',
    recurse: true,
    ordinal: Number(candidate.operationIndex || ordinal || 0),
  };
}

export async function loadCompositionContextDependenciesMany(session, stableIds) {
  const result = await session.run(`
    UNWIND $stableIds AS stableId
    MATCH (subject {stableId: stableId})
    OPTIONAL MATCH (subjectSemantic)-[:COMPOSES_SYNTAX]->(subject)
    WHERE subjectSemantic.annotationKind IS NOT NULL
    OPTIONAL MATCH (stateCreation:Call {state_resource_stableId: subject.stableId})
    WHERE stateCreation.state_update_action = 'create'
    WITH subject,
         [subject]
         + collect(DISTINCT subjectSemantic)
         + collect(DISTINCT stateCreation) AS compositionRoots
    UNWIND compositionRoots AS compositionRoot
    OPTIONAL MATCH compositionPath = (compositionRoot)-[:${ANNOTATION_COMPOSITION_RELATION_TYPES.join('|')}*0..4]->(member)
    WHERE all(node IN nodes(compositionPath) WHERE (
      node = subject
      OR node = compositionRoot
      OR (
        compositionRoot.parentStepStableId IS NOT NULL
        AND node.parentStepStableId = compositionRoot.parentStepStableId
      )
    ))
    WITH subject, [node IN collect(DISTINCT member) WHERE node IS NOT NULL] AS members
    UNWIND members AS member
    CALL (member) {
      OPTIONAL MATCH (member)-[:READS_VALUE|RECEIVES_VALUE|CAPTURES_VALUE]->(linkedBinding:ValueSlot)
      OPTIONAL MATCH (linkedCanonical:ValueSlot {
        stableId: coalesce(linkedBinding.canonicalStableId, linkedBinding.bindingStableId, linkedBinding.value_slot_stableId)
      })
      OPTIONAL MATCH (linkedBinding)-[:COMPOSES_SYNTAX]->(linkedSemanticDeclaration:Declaration)
      OPTIONAL MATCH (directBinding:ValueSlot {
        stableId: coalesce(member.value_slot_stableId, member.bindingStableId, member.canonicalStableId)
      })
      OPTIONAL MATCH (directDeclaration {
        stableId: coalesce(member.value_slot_stableId, member.bindingStableId)
      })
      OPTIONAL MATCH (directBinding)-[:COMPOSES_SYNTAX]->(directSemanticDeclaration:Declaration)
      OPTIONAL MATCH (member)-[:COMPOSES_SYNTAX]->(composedDeclaration:Declaration)
      OPTIONAL MATCH (member)-[:USES_REFERENCE]->(:ValueReference)-[:RESOLVES_TO]->(resolvedDeclaration)
      OPTIONAL MATCH (resolvedSemantic)-[:COMPOSES_SYNTAX]->(resolvedDeclaration)
      WHERE resolvedSemantic.annotationKind IS NOT NULL
      WITH member,
           collect(DISTINCT coalesce(linkedSemanticDeclaration, linkedCanonical, linkedBinding))
           + collect(DISTINCT directSemanticDeclaration)
           + collect(DISTINCT composedDeclaration)
           + collect(DISTINCT coalesce(resolvedSemantic, resolvedDeclaration))
           + collect(DISTINCT CASE
               WHEN composedDeclaration IS NULL
                 AND directSemanticDeclaration IS NULL
                 AND resolvedDeclaration IS NULL
               THEN coalesce(directBinding, directDeclaration)
               ELSE null
             END) AS linkedValues
      UNWIND CASE
        WHEN [binding IN linkedValues WHERE binding IS NOT NULL] = [] THEN [null]
        ELSE [binding IN linkedValues WHERE binding IS NOT NULL]
      END AS rawBinding
      OPTIONAL MATCH (rawBinding)-[:COMPOSES_SYNTAX]->(canonicalDeclaration:Declaration)
      WITH collect(DISTINCT coalesce(canonicalDeclaration, rawBinding)) AS canonicalBindings
      RETURN [binding IN canonicalBindings WHERE binding IS NOT NULL | {
        stableId: binding.stableId,
        labels: labels(binding),
        annotationKind: binding.annotationKind,
        operationIndex: binding.operation_index
      }] AS bindings
    }
    CALL (member) {
      OPTIONAL MATCH (declaredCallable {stableId: member.calleeStableId})
      WHERE (declaredCallable:Fn OR (declaredCallable:CallableDeclaration AND declaredCallable:FunctionImplementation))
        AND NOT declaredCallable:PresentationOnly
        AND NOT declaredCallable:VisualProxy
      OPTIONAL MATCH (member)-[invocation]->(linkedCallable)
      WHERE type(invocation) IN ['CALL', 'CALLS', 'REQUEST', 'READ', 'WRITE', 'INVOKES', 'DETACHES_ASYNC', 'AWAITS_ASYNC']
        AND (linkedCallable:Fn OR (linkedCallable:CallableDeclaration AND linkedCallable:FunctionImplementation))
        AND NOT linkedCallable:PresentationOnly
        AND NOT linkedCallable:VisualProxy
      OPTIONAL MATCH (canonicalLinkedCallable {
        stableId: coalesce(linkedCallable.canonicalStableId, linkedCallable.calleeStableId)
      })
      WHERE (canonicalLinkedCallable:Fn OR (canonicalLinkedCallable:CallableDeclaration AND canonicalLinkedCallable:FunctionImplementation))
        AND NOT canonicalLinkedCallable:PresentationOnly
        AND NOT canonicalLinkedCallable:VisualProxy
      WITH member,
           collect(DISTINCT declaredCallable)
           + collect(DISTINCT coalesce(canonicalLinkedCallable, linkedCallable)) AS linkedCallables
      RETURN [callable IN linkedCallables WHERE callable IS NOT NULL | {
        stableId: callable.stableId,
        labels: labels(callable),
        annotationKind: callable.annotationKind,
        operationIndex: member.operation_index
      }] AS callables
    }
    CALL (member) {
      OPTIONAL MATCH (member)-[interaction]-(boundary)
      WHERE (boundary:Storage OR boundary:External OR boundary:UiSurface)
        AND type(interaction) IN ['READ', 'WRITE', 'REQUEST', 'RESPONSE', 'USES', 'AFFECTS']
      WITH member, collect(DISTINCT boundary) AS boundaries
      RETURN [boundary IN boundaries WHERE boundary IS NOT NULL | {
        stableId: boundary.stableId,
        labels: labels(boundary),
        annotationKind: boundary.annotationKind,
        operationIndex: member.operation_index
      }] AS boundaries
    }
    RETURN subject.stableId AS stableId,
           collect(DISTINCT {
             memberStableId: member.stableId,
             memberOperationIndex: member.operation_index,
             bindings: bindings,
             callables: callables,
             boundaries: boundaries
           }) AS compositionMembers
  `, { stableIds });

  const dependenciesByStableId = new Map(stableIds.map((stableId) => [stableId, []]));
  for (const record of result.records) {
    const stableId = record.get('stableId');
    const members = normalizeNeo4jValue(record.get('compositionMembers') || []);
    const dependencies = dependenciesByStableId.get(stableId) || [];
    const seen = new Set(dependencies.map((dependency) => dependency.stableId));
    for (const member of members) {
      for (const [role, candidates] of [
        ['composition-value', member.bindings || []],
        ['composition-callable', member.callables || []],
        ['composition-boundary', member.boundaries || []],
      ]) {
        for (const candidate of candidates) {
          const dependency = contextualDependency(candidate, role, member.memberOperationIndex);
          if (!dependency || dependency.stableId === stableId || seen.has(dependency.stableId)) continue;
          dependencies.push(dependency);
          seen.add(dependency.stableId);
        }
      }
    }
    dependenciesByStableId.set(stableId, dependencies);
  }
  return dependenciesByStableId;
}

const PROFILES = {
  ...projectionProfiles,
  EntityContext: {
    id: 'entity-context',
    version: 1,
    compositionContext: false,
    async context(session, stableId) {
      return runSingle(session, `
        MATCH (subject {stableId: $stableId})
        OPTIONAL MATCH (subject)-[relation]-(neighbor)
        RETURN properties(subject) AS subject,
               labels(subject) AS labels,
               collect(DISTINCT {
                 relation: type(relation),
                 outgoing: startNode(relation) = subject,
                 stableId: neighbor.stableId,
                 labels: labels(neighbor),
                 name: coalesce(neighbor.name, neighbor.diaName, neighbor.label),
                 syntax: coalesce(neighbor.syntax, neighbor.action_text_raw, neighbor.sourceText, neighbor.text)
               }) AS neighbors
      `, { stableId });
    },
    async dependencies() { return []; },
  },
  FunctionalEntity: {
    id: 'functional-accumulation',
    version: 8,
    compositionContext: false,
    accumulateToSystemBoundary: true,
    async contextMany(session, stableIds) {
      const selected = await loadPropertyProjectionContexts(session, stableIds);
      const remainingIds = stableIds.filter(id => !selected.has(id));
      if (!remainingIds.length) return selected;
      const result = await session.run(`
        UNWIND $stableIds AS stableId
        MATCH (subject:DeveloperDefined {stableId: stableId})
        OPTIONAL MATCH effectPath=(subject)-[:AST_CHILD|VALUE_FROM|RESOLVES_TO|SELECTS_RETURN_PROPERTY|HAS_OPERATION|CALLS|READS_FROM|WRITES_TO*1..8]->(system:System)
        WHERE none(node IN nodes(effectPath)[1..-1] WHERE node:DeveloperDefined OR node:System)
        WITH subject, collect(DISTINCT CASE WHEN system IS NULL THEN null ELSE {
               stableId: system.stableId,
               name: system.name,
               labels: labels(system),
               relationshipTypes: [relation IN relationships(effectPath) | type(relation)],
               operationSyntax: [node IN nodes(effectPath) WHERE node:Operation | coalesce(node.syntax, node.action_text_raw)]
             } END) AS terminalEffects
        CALL (subject) {
          MATCH p=(subject)-[r]-(neighbor)
          WHERE type(r) IN ['WRITES_TO', 'READS_FROM', 'VALUE_FROM', 'RESOLVES_TO',
            'BINDS_TO_PARAMETER', 'HAS_PROPERTY', 'HAS_ARGUMENT', 'CALLS', 'CALLS_VALUE']
            OR (type(r) = 'AST_CHILD' AND startNode(r):FunctionImplementation)
          RETURN collect(DISTINCT p) AS directEvidence
        }
        CALL (subject) {
          MATCH p=(consumer)-[:VALUE_FROM|READS_FROM|RESOLVES_TO|CALLS_VALUE|HAS_ARGUMENT*1..3]->(subject)
          WHERE none(n IN nodes(p)[1..-1] WHERE n:DeveloperDefined OR n:System)
            AND (consumer:Operation OR consumer:PropertyValue OR consumer:ArgumentValue
              OR consumer:ValueWrite OR consumer:ValueProjection)
          WITH DISTINCT p ORDER BY length(p), [n IN nodes(p) | n.stableId]
          LIMIT 81
          RETURN collect(p) AS usageEvidence
        }
        RETURN subject.stableId AS stableId, {
          stableId: subject.stableId,
          labels: labels(subject),
          name: subject.name,
          syntax: coalesce(subject.syntax, subject.action_text_raw),
          repoRelativePath: coalesce(subject.repoRelativePath, subject.repo_relative_path),
          range: {
            startLine: coalesce(subject.startLine, subject.start_line),
            startColumn: coalesce(subject.startColumn, subject.start_column),
            endLine: coalesce(subject.endLine, subject.end_line),
            endColumn: coalesce(subject.endColumn, subject.end_column)
          },
          terminalEffects: [effect IN terminalEffects WHERE effect IS NOT NULL],
          evidenceGraph: {
            usageMaxHops: 3,
            usagePathLimit: 80,
            usageTruncated: size(usageEvidence) > 80,
            paths: [p IN directEvidence + usageEvidence[0..80] | {
              nodes: [n IN nodes(p) | {
                stableId: n.stableId, name: n.name, labels: labels(n),
                syntax: CASE WHEN n:FunctionImplementation AND n <> subject THEN null
                  ELSE left(coalesce(n.syntax, n.action_text_raw), 2000) END,
                syntaxTruncated: CASE WHEN n:FunctionImplementation AND n <> subject THEN false
                  ELSE size(coalesce(n.syntax, n.action_text_raw, '')) > 2000 END,
                index: n.index, propertyName: n.propertyName
              }],
              edges: [r IN relationships(p) | {
                fromId: startNode(r).stableId, toId: endNode(r).stableId,
                type: type(r), properties: properties(r)
              }]
            }]
          }
        } AS context
      `, { stableIds: remainingIds });
      return new Map([...selected, ...result.records.map((record) => [record.get('stableId'), normalizeNeo4jValue(record.get('context'))])]);
    },
    async dependenciesMany(session, stableIds) {
      const projections = await loadProjectionDependencies(session, stableIds);
      const selected = await loadPropertyProjectionContexts(session, stableIds.filter(id => !projections.has(id)));
      for (const [id, selection] of selected) projections.set(id, selection.dependencies.flatMap((candidate, ordinal) => {
        const annotationKind = inferAnnotationKind(candidate.labels, candidate.annotationKind);
        return annotationKind ? [{stableId: candidate.stableId, annotationKind,
          role: 'selected-property-origin', dependencyKind: 'value-provenance', recurse: true,
          ordinal, evidencePath: candidate.evidencePath}] : [];
      }));
      const remainingIds = stableIds.filter(id => !projections.has(id));
      if (!remainingIds.length) return projections;
      const result = await session.run(`
        UNWIND $stableIds AS stableId
        MATCH (subject:DeveloperDefined {stableId: stableId})
        CALL (subject) {
          MATCH (subject)<-[binding:BINDS_TO_PARAMETER]-(boundOrigin)
          WITH subject, collect({origin: boundOrigin, resolution: binding.resolution}) AS bindings
          UNWIND [binding IN bindings
            WHERE binding.resolution = 'typescript-checker-jsx-prop-flow'
               OR none(other IN bindings WHERE other.resolution = 'typescript-checker-jsx-prop-flow')
          ] AS selectedBinding
          WITH subject, selectedBinding.origin AS origin
          MATCH forwardPath=(origin)-[:AST_CHILD|VALUE_FROM|HAS_PROPERTY|RESOLVES_TO|SELECTS_RETURN_PROPERTY|HAS_OPERATION|CALLS|CALLS_VALUE|READS_FROM|WRITES_TO*1..12]->(candidate:DeveloperDefined)
          WHERE subject:Parameter
            AND none(edge IN relationships(forwardPath) WHERE type(edge) = 'READS_FROM'
              AND EXISTS { MATCH (projection)-[:SELECTS_RETURN_PROPERTY]->() WHERE projection = startNode(edge) })
            AND coalesce(candidate.declarationKind, '') <> 'FunctionType'
            AND none(node IN nodes(forwardPath)[0..-1] WHERE node:DeveloperDefined OR node:System)
          RETURN candidate, 1 + length(forwardPath) AS distance
          UNION
          MATCH directPath=(subject)-[:AST_CHILD|VALUE_FROM|RESOLVES_TO|SELECTS_RETURN_PROPERTY|HAS_OPERATION|CALLS|CALLS_VALUE|READS_FROM|WRITES_TO*1..12]->(candidate:DeveloperDefined)
          WHERE coalesce(candidate.declarationKind, '') <> 'FunctionType'
            AND none(edge IN relationships(directPath) WHERE type(edge) = 'READS_FROM'
              AND EXISTS { MATCH (projection)-[:SELECTS_RETURN_PROPERTY]->() WHERE projection = startNode(edge) })
            AND none(node IN nodes(directPath)[1..-1] WHERE node:DeveloperDefined OR node:System)
          RETURN candidate, length(directPath) AS distance
        }
        WITH subject, candidate, min(distance) AS distance
        ORDER BY distance, candidate.stableId
        RETURN subject.stableId AS stableId, collect({
          stableId: candidate.stableId,
          annotationKind: 'FunctionalEntity',
          role: 'functional-descendant',
          dependencyKind: 'functional-accumulation',
          recurse: true,
          ordinal: distance
        }) AS dependencies
      `, { stableIds: remainingIds });
      return new Map([...projections, ...result.records.map((record) => [record.get('stableId'), normalizeNeo4jValue(record.get('dependencies'))])]);
    },
    async context(session, stableId) {
      return (await this.contextMany(session, [stableId])).get(stableId) || null;
    },
    async dependencies(session, stableId) {
      return (await this.dependenciesMany(session, [stableId])).get(stableId) || [];
    },
  },
  Callable: {
    id: 'callable-summary',
    version: PROFILE_VERSION,
    async context(session, stableId) {
      return runSingle(session, `
        MATCH (subject {stableId: $stableId})
        WHERE subject:Fn OR subject:FnDeclaration
        CALL (subject) {
          OPTIONAL MATCH (step:Step)
          WHERE step.parentFlowBlockStableId IS NULL AND (
            (subject:Fn AND step.parentFnStableId = subject.stableId)
            OR (subject:FnDeclaration AND step.parentLocalFunctionStableId = subject.stableId)
          )
          WITH step ORDER BY step.flowStepOrder, step.operation_index
          RETURN collect(CASE WHEN step IS NULL THEN null ELSE {
            stableId: step.stableId,
            kind: step.flowStepKind,
            order: step.flowStepOrder
          } END) AS directSteps
        }
        CALL (subject) {
          OPTIONAL MATCH (block:Flow:Block)
          WHERE block.parentFlowBlockStableId IS NULL AND (
            (subject:Fn AND block.parentFnStableId = subject.stableId)
            OR (subject:FnDeclaration AND block.parentLocalFunctionStableId = subject.stableId)
          )
          WITH block ORDER BY block.flowBlockOrder, block.operation_index
          RETURN collect(CASE WHEN block IS NULL THEN null ELSE {
            stableId: block.stableId,
            role: block.flowBlockRole,
            outcome: block.flowBlockOutcome,
            order: block.flowBlockOrder
          } END) AS directBlocks
        }
        RETURN {
          stableId: subject.stableId,
          labels: labels(subject),
          name: coalesce(subject.name, subject.diaName, subject.localFunctionName),
          repoRelativePath: subject.repo_relative_path,
          sourceStateId: subject.source_state_id,
          range: {startLine: subject.start_line, startColumn: subject.start_column, endLine: subject.end_line, endColumn: subject.end_column},
          directSteps: [step IN directSteps WHERE step IS NOT NULL],
          directBlocks: [block IN directBlocks WHERE block IS NOT NULL]
        } AS context
      `, { stableId });
    },
    async dependencies(session, stableId) {
      const row = await runSingle(session, `
        MATCH (subject {stableId: $stableId})
        WHERE subject:Fn OR subject:FnDeclaration
        CALL (subject) {
          OPTIONAL MATCH (step:Step)
          WHERE step.parentFlowBlockStableId IS NULL AND (
            (subject:Fn AND step.parentFnStableId = subject.stableId)
            OR (subject:FnDeclaration AND step.parentLocalFunctionStableId = subject.stableId)
          )
          RETURN collect(DISTINCT CASE WHEN step IS NULL THEN null ELSE {
            stableId: step.stableId, annotationKind: 'Step', role: 'direct-step', dependencyKind: 'containment', recurse: true, ordinal: coalesce(step.flowStepOrder, step.operation_index, 0)
          } END) AS directSteps
        }
        CALL (subject) {
          OPTIONAL MATCH (block:Flow:Block)
          WHERE block.parentFlowBlockStableId IS NULL AND (
            (subject:Fn AND block.parentFnStableId = subject.stableId)
            OR (subject:FnDeclaration AND block.parentLocalFunctionStableId = subject.stableId)
          )
          RETURN collect(DISTINCT CASE WHEN block IS NULL THEN null ELSE {
            stableId: block.stableId, annotationKind: 'FlowBlock', role: 'direct-flow-block', dependencyKind: 'containment', recurse: true, ordinal: coalesce(block.flowBlockOrder, block.operation_index, 0)
          } END) AS directBlocks
        }
        CALL (subject) {
          OPTIONAL MATCH (subject)-[:DECLARED_IN]->(module:File)
          RETURN collect(DISTINCT CASE WHEN module IS NULL THEN null ELSE {
            stableId: module.stableId, annotationKind: 'Module', role: 'declaring-module', dependencyKind: 'semantic', recurse: true, ordinal: -1
          } END) AS modules
        }
        RETURN [item IN directBlocks + directSteps + modules WHERE item IS NOT NULL] AS dependencies
      `, { stableId });
      return row?.dependencies || [];
    },
  },
  Step: {
    id: 'step',
    version: PROFILE_VERSION,
    async contextMany(session, stableIds, options = {}) {
      const result = await session.run(`
        UNWIND $stableIds AS stableId
        MATCH (step:Step {stableId: stableId})
        MATCH (outerOwner:Fn {stableId: step.parentFnStableId})
        OPTIONAL MATCH (localOwner:FnDeclaration {stableId: step.parentLocalFunctionStableId})
        WITH step, coalesce(localOwner, outerOwner) AS owner
        OPTIONAL MATCH (member:Primitive|ValueSlot|Request|Op|Call|FnDeclaration {parentStepStableId: step.stableId})
        WHERE member.annotationKind IS NOT NULL
          AND NOT member:VisualProxy
          AND NOT member:FlowBlock
          AND NOT member:Step
        WITH step, owner, member
        ORDER BY member.operation_index
        WITH step, owner, collect(CASE WHEN member IS NULL THEN null ELSE {
          stableId: member.stableId, labels: labels(member), label: member.label,
          diaName: member.diaName, actionTextRaw: member.actionTextRaw,
            annotationKind: CASE WHEN member:Parameter THEN 'FunctionalEntity' ELSE member.annotationKind END,
          operationIndex: member.operation_index
        } END) AS members
        RETURN step.stableId AS stableId, {
          stableId: step.stableId, kind: step.flowStepKind, order: step.flowStepOrder,
          headStableIds: step.headStableIds, tailStableIds: step.tailStableIds,
          owner: {stableId: owner.stableId, name: coalesce(owner.name, owner.diaName, owner.localFunctionName)},
          members: [member IN members WHERE member IS NOT NULL]
        } AS context
      `, { stableIds });
      return new Map(result.records.map((record) => [record.get('stableId'), normalizeNeo4jValue(record.get('context'))]));
    },
    async dependenciesMany(session, stableIds) {
      const result = await session.run(`
        UNWIND $stableIds AS stableId
        MATCH (step:Step {stableId: stableId})
        MATCH (member:Primitive|ValueSlot|Request|Op|Call|FnDeclaration {parentStepStableId: step.stableId})
        WHERE member.annotationKind IS NOT NULL
          AND NOT member:VisualProxy
          AND NOT member:FlowBlock
          AND NOT member:Step
        WITH step, member
        ORDER BY member.operation_index, member.stableId
        RETURN step.stableId AS stableId, collect(DISTINCT {
          stableId: member.stableId,
           annotationKind: CASE WHEN member:Parameter THEN 'FunctionalEntity' ELSE member.annotationKind END,
          role: 'semantic-member',
          dependencyKind: 'containment',
           recurse: NOT member:Parameter,
          ordinal: coalesce(member.operation_index, 0)
        }) AS dependencies
      `, { stableIds });
      return new Map(result.records.map((record) => [record.get('stableId'), normalizeNeo4jValue(record.get('dependencies'))]));
    },
    async context(session, stableId) {
      return runSingle(session, `
        MATCH (step:Step {stableId: $stableId})
        MATCH (outerOwner:Fn {stableId: step.parentFnStableId})
        OPTIONAL MATCH (localOwner:FnDeclaration {stableId: step.parentLocalFunctionStableId})
        WITH step, coalesce(localOwner, outerOwner) AS owner
        OPTIONAL MATCH (member:Primitive|ValueSlot|Request|Op|Call|FnDeclaration {parentStepStableId: step.stableId})
        WHERE member.annotationKind IS NOT NULL
          AND NOT member:VisualProxy
          AND NOT member:FlowBlock
          AND NOT member:Step
        WITH step, owner, member
        ORDER BY member.operation_index
        WITH step, owner, collect(CASE WHEN member IS NULL THEN null ELSE {
          stableId: member.stableId,
          labels: labels(member),
          label: member.label,
          diaName: member.diaName,
          actionTextRaw: member.actionTextRaw,
            annotationKind: CASE WHEN member:Parameter THEN 'FunctionalEntity' ELSE member.annotationKind END,
          operationIndex: member.operation_index
        } END) AS members
        RETURN {
          stableId: step.stableId,
          kind: step.flowStepKind,
          order: step.flowStepOrder,
          headStableIds: step.headStableIds,
          tailStableIds: step.tailStableIds,
          owner: {stableId: owner.stableId, name: coalesce(owner.name, owner.diaName, owner.localFunctionName)},
          members: [member IN members WHERE member IS NOT NULL]
        } AS context
      `, { stableId });
    },
    async dependencies(session, stableId) {
      const row = await runSingle(session, `
        MATCH (step:Step {stableId: $stableId})
        MATCH (member:Primitive|ValueSlot|Request|Op|Call|FnDeclaration {parentStepStableId: step.stableId})
        WHERE member.annotationKind IS NOT NULL
          AND NOT member:VisualProxy
          AND NOT member:FlowBlock
          AND NOT member:Step
        WITH member ORDER BY member.operation_index, member.stableId
        RETURN collect(DISTINCT {
          stableId: member.stableId,
          annotationKind: CASE WHEN member:Parameter THEN 'FunctionalEntity' ELSE member.annotationKind END,
          role: 'semantic-member',
          dependencyKind: 'containment',
          recurse: NOT member:Parameter,
          ordinal: coalesce(member.operation_index, 0)
        }) AS dependencies
      `, { stableId });
      return row?.dependencies || [];
    },
  },
  FlowBlock: {
    id: 'flow-block',
    version: PROFILE_VERSION,
    async context(session, stableId) {
      return runSingle(session, `
        MATCH (block:Flow:Block {stableId: $stableId})
        MATCH (owner:Fn {stableId: block.parentFnStableId})
        CALL (block) {
          OPTIONAL MATCH (step:Step {parentFlowBlockStableId: block.stableId})
          WITH step ORDER BY step.flowStepOrder, step.operation_index
          RETURN collect(CASE WHEN step IS NULL THEN null ELSE {
            stableId: step.stableId,
            kind: step.flowStepKind,
            order: step.flowStepOrder
          } END) AS directSteps
        }
        CALL (block) {
          OPTIONAL MATCH (child:Flow:Block)-[:NESTED_IN]->(block)
          RETURN collect(DISTINCT CASE WHEN child IS NULL THEN null ELSE {
            stableId: child.stableId,
            role: child.flowBlockRole,
            outcome: child.flowBlockOutcome,
            order: child.flowBlockOrder
          } END) AS childBlocks
        }
        RETURN {
          stableId: block.stableId,
          labels: labels(block),
          role: block.flowBlockRole,
          outcome: block.flowBlockOutcome,
          order: block.flowBlockOrder,
          ownerBranchStableIds: block.ownerBranchStableIds,
          headStableIds: block.headStableIds,
          tailStableIds: block.tailStableIds,
          parentFlowBlockStableId: block.parentFlowBlockStableId,
          owner: {stableId: owner.stableId, name: coalesce(owner.name, owner.diaName, owner.localFunctionName)},
          directSteps: [step IN directSteps WHERE step IS NOT NULL],
          childBlocks: [child IN childBlocks WHERE child IS NOT NULL]
        } AS context
      `, { stableId });
    },
    async dependencies(session, stableId) {
      const row = await runSingle(session, `
        MATCH (block:Flow:Block {stableId: $stableId})
        CALL (block) {
          OPTIONAL MATCH (step:Step {parentFlowBlockStableId: block.stableId})
          RETURN collect(DISTINCT CASE WHEN step IS NULL THEN null ELSE {
            stableId: step.stableId,
            annotationKind: 'Step',
            role: 'direct-step',
            dependencyKind: 'containment',
            recurse: true,
            ordinal: coalesce(step.flowStepOrder, step.operation_index, 0)
          } END) AS steps
        }
        CALL (block) {
          OPTIONAL MATCH (child:Flow:Block)-[:NESTED_IN]->(block)
          RETURN collect(DISTINCT CASE WHEN child IS NULL THEN null ELSE {
            stableId: child.stableId,
            annotationKind: 'FlowBlock',
            role: 'nested-flow-block',
            dependencyKind: 'containment',
            recurse: true,
            ordinal: coalesce(child.flowBlockOrder, child.operation_index, 0)
          } END) AS childBlocks
        }
        RETURN [item IN steps + childBlocks WHERE item IS NOT NULL] AS dependencies
      `, { stableId });
      return row?.dependencies || [];
    },
  },
  Loop: {
    id: 'loop-summary',
    version: PROFILE_VERSION,
    compositionContext: true,
    async context(session, stableId) {
      return runSingle(session, `
        MATCH (loop:Loop {stableId: $stableId})
        OPTIONAL MATCH (source:ValueSlot {stableId: loop.value_slot_stableId})
        OPTIONAL MATCH (loop)-[:NEXT]->(iterator:Iterator)
        CALL (loop) {
          OPTIONAL MATCH (member {parentStepStableId: loop.parentStepStableId})
          WHERE member.parentFnStableId = loop.parentFnStableId
            AND member.stableId <> loop.stableId
            AND NOT member:PresentationOnly
            AND NOT member:VisualProxy
          WITH member ORDER BY member.operation_index
          RETURN collect(CASE WHEN member IS NULL THEN null ELSE {
            stableId: member.stableId,
            labels: labels(member),
            syntax: coalesce(member.action_text_raw, member.condition_raw, member.operation_subject_text),
            subjectText: member.operation_subject_text,
            operationIndex: member.operation_index
          } END) AS members
        }
        RETURN {
          stableId: loop.stableId,
          labels: labels(loop),
          syntax: coalesce(loop.condition_raw, loop.operation_subject_text),
          collectionMethod: loop.collectionMethod,
          iterationMode: loop.collection_iteration_mode,
          resultMode: loop.collection_result_mode,
          ownerFnStableId: loop.parentFnStableId,
          ownerStepStableId: loop.parentStepStableId,
          ownerFlowBlockStableId: loop.parentFlowBlockStableId,
          source: CASE WHEN source IS NULL THEN null ELSE {
            stableId: source.stableId,
            labels: labels(source),
            name: coalesce(source.value_name, source.diaName, source.label),
            syntax: coalesce(source.value_operation_syntax, source.action_text_raw, source.operation_subject_text)
          } END,
          iterator: CASE WHEN iterator IS NULL THEN null ELSE {
            stableId: iterator.stableId,
            labels: labels(iterator),
            name: coalesce(iterator.value_name, iterator.diaName, iterator.label),
            syntax: coalesce(iterator.action_text_raw, iterator.operation_subject_text)
          } END,
          members: [member IN members WHERE member IS NOT NULL]
        } AS context
      `, { stableId });
    },
    async dependencies(session, stableId) {
      const row = await runSingle(session, `
        MATCH (loop:Loop {stableId: $stableId})
        OPTIONAL MATCH (member {parentStepStableId: loop.parentStepStableId})
        WHERE member.parentFnStableId = loop.parentFnStableId
          AND member.stableId <> loop.stableId
          AND (member:Annotatable OR member:Branch)
          AND NOT member:PresentationOnly
          AND NOT member:VisualProxy
        WITH member ORDER BY member.operation_index
        RETURN collect(CASE
          WHEN member:Primitive THEN {
            stableId: member.stableId, annotationKind: 'ExecutionPrimitive', role: 'loop-member',
            dependencyKind: 'containment', recurse: true, ordinal: coalesce(member.operation_index, 0)
          }
          WHEN member:Call OR member:Request OR member:Op THEN {
            stableId: member.stableId, annotationKind: 'CallSite', role: 'loop-member',
            dependencyKind: 'containment', recurse: true, ordinal: coalesce(member.operation_index, 0)
          }
          WHEN member:ValueAccess THEN {
            stableId: member.stableId, annotationKind: 'ValueUse', role: 'loop-member',
            dependencyKind: 'containment', recurse: true, ordinal: coalesce(member.operation_index, 0)
          }
          WHEN member:ValueSlot THEN {
            stableId: member.stableId, annotationKind: 'Binding', role: 'loop-member',
            dependencyKind: 'containment', recurse: true, ordinal: coalesce(member.operation_index, 0)
          }
          ELSE null END) AS dependencies
      `, { stableId });
      return (row?.dependencies || []).filter(Boolean);
    },
  },
  ExecutionPrimitive: {
    id: 'execution-primitive',
    version: PROFILE_VERSION + 5,
    compositionContext: false,
    async context(session, stableId) {
      return runSingle(session, `
        MATCH (primitive:Primitive {stableId: $stableId})
        CALL (primitive) {
          OPTIONAL MATCH (source)-[incoming]->(primitive)
          RETURN collect(DISTINCT CASE WHEN source IS NULL THEN null ELSE {
            relation: type(incoming),
            stableId: source.stableId,
            labels: labels(source),
            layer: incoming.flow_layer,
            name: coalesce(source.value_name, source.name, source.diaName, source.label),
            syntax: coalesce(source.action_text_raw, source.condition_raw, source.operation_subject_text),
            subjectText: source.operation_subject_text,
            valueText: source.operation_value_text
          } END) AS incomingItems
        }
        CALL (primitive) {
          OPTIONAL MATCH (primitive)-[outgoing]->(target)
          RETURN collect(DISTINCT CASE WHEN target IS NULL THEN null ELSE {
            relation: type(outgoing),
            stableId: target.stableId,
            labels: labels(target),
            layer: outgoing.flow_layer,
            name: coalesce(target.value_name, target.name, target.diaName, target.label),
            syntax: coalesce(target.action_text_raw, target.condition_raw, target.operation_subject_text),
            subjectText: target.operation_subject_text,
            valueText: target.operation_value_text
          } END) AS outgoingItems
        }
        CALL (primitive) {
          OPTIONAL MATCH (primitive)-[:EVAL]->(expression)
          RETURN collect(DISTINCT CASE WHEN expression IS NULL THEN null ELSE {
            stableId: expression.stableId,
            labels: labels(expression),
            syntax: coalesce(expression.action_text_raw, expression.condition_raw, expression.operation_subject_text),
            subjectText: expression.operation_subject_text,
            valueText: expression.operation_value_text
          } END) AS sourceExpressions
        }
        CALL (primitive) {
          OPTIONAL MATCH (producer)-[:ASSIGNS_VALUE]->(primitive)
          OPTIONAL MATCH (callable:Fn {stableId: coalesce(producer.canonicalStableId, producer.calleeStableId)})
          RETURN collect(DISTINCT CASE WHEN producer IS NULL THEN null ELSE {
            stableId: producer.stableId,
            labels: labels(producer),
            name: coalesce(producer.callee_name, producer.name, producer.diaName, producer.label),
            syntax: coalesce(producer.call_text_raw, producer.action_text_raw, producer.operation_subject_text),
            callableStableId: callable.stableId,
            callableName: callable.name
          } END) AS producers
        }
        CALL (primitive) {
          OPTIONAL MATCH (primitive)-[:USES_LITERAL]->(occurrence:LiteralOccurrence)-[:RESOLVES_TO]->(selected:LiteralDomainValue)<-[:HAS_MEMBER]-(domain:LiteralDomain)
          OPTIONAL MATCH (domain)-[:HAS_MEMBER]->(allowed:LiteralDomainValue)
          WITH domain, occurrence, selected, allowed ORDER BY allowed.ordinal
          WITH domain, occurrence, selected, collect(CASE WHEN allowed IS NULL THEN null ELSE {
            name: allowed.name, value: allowed.value, ordinal: allowed.ordinal
          } END) AS allowedValues
          RETURN collect(DISTINCT CASE WHEN domain IS NULL THEN null ELSE {
            domainStableId: domain.stableId,
            domainName: domain.name,
            domainKind: domain.domain_kind,
            typeText: domain.type_text,
            selectedValue: selected.value,
            selectedName: selected.name,
            occurrenceSyntax: occurrence.raw_text,
            allowedValues: [value IN allowedValues WHERE value IS NOT NULL]
          } END) AS literalDomains
        }
        CALL (primitive) {
          OPTIONAL MATCH (primitive)-[:EVAL]->(request:Request)-[:INVOKES]->(producerProxy)-[:REQUEST]->(configurationGetter:Fn)
          OPTIONAL MATCH (request)-[:ARG]->(keyArgument:ArgumentOccurrence {argument_index: 0})
          OPTIONAL MATCH (request)-[:ARG]->(defaultArgument:ArgumentOccurrence {argument_index: 1})
          WITH primitive, configurationGetter, keyArgument, defaultArgument
          OPTIONAL MATCH (peerRequest:Request:Annotatable)-[:INVOKES]->(peerProxy)-[:REQUEST]->(configurationGetter)
          OPTIONAL MATCH (peerRequest)-[:ARG]->(peerKeyArgument:ArgumentOccurrence {argument_index: 0})
          OPTIONAL MATCH (peerProxy)-[:ASSIGNS_VALUE]->(peerPrimitive:Primitive:Annotatable)-[:COMPOSES_SYNTAX]->(peerDeclaration:Declaration)
          WHERE peerKeyArgument.action_text_raw = keyArgument.action_text_raw
            AND peerPrimitive.repo_relative_path = primitive.repo_relative_path
          OPTIONAL MATCH (use)-[:USES_REFERENCE]->(reference)-[:RESOLVES_TO]->(peerDeclaration)
          OPTIONAL MATCH controlledPath=(use)-[:TRUE|FALSE|NEXT|ArgJoin*1..10]->(effect)
          WHERE effect.parentFnStableId = peerPrimitive.parentFnStableId
            AND coalesce(effect.operation_index, use.operation_index) >= coalesce(use.operation_index, 0)
            AND coalesce(effect.operation_index, peerPrimitive.operation_index) <= coalesce(peerPrimitive.operation_index, 0) + 40
          WITH configurationGetter, keyArgument, defaultArgument, peerPrimitive,
               collect(DISTINCT CASE WHEN use IS NULL THEN null ELSE {
                 stableId: use.stableId,
                 labels: labels(use),
                 operationIndex: use.operation_index,
                 ownerFnStableId: use.parentFnStableId,
                 relation: 'USES_REFERENCE',
                 syntax: coalesce(use.condition_raw, use.action_text_raw, use.operation_subject_text),
                 subjectText: use.operation_subject_text,
                 valueText: use.operation_value_text
               } END) AS uses,
               collect(DISTINCT CASE
                 WHEN effect IS NULL OR (effect.action_text_raw IS NULL AND effect.condition_raw IS NULL) THEN null
                 ELSE {
                   stableId: effect.stableId,
                   labels: labels(effect),
                   operationIndex: effect.operation_index,
                   ownerFnStableId: effect.parentFnStableId,
                   syntax: coalesce(effect.condition_raw, effect.action_text_raw, effect.operation_subject_text),
                   subjectText: effect.operation_subject_text,
                   valueText: effect.operation_value_text
                 }
               END) AS controlledEffects
          WITH configurationGetter, keyArgument, defaultArgument,
               collect(DISTINCT CASE WHEN peerPrimitive IS NULL THEN null ELSE {
                 stableId: peerPrimitive.stableId,
                 ownerFnStableId: peerPrimitive.parentFnStableId,
                 operationIndex: peerPrimitive.operation_index,
                 syntax: peerPrimitive.action_text_raw,
                 uses: [item IN uses WHERE item IS NOT NULL],
                 controlledEffects: [item IN controlledEffects WHERE item IS NOT NULL]
               } END) AS consumers
          RETURN CASE WHEN configurationGetter IS NULL OR keyArgument IS NULL THEN null ELSE {
            getterStableId: configurationGetter.stableId,
            getterName: configurationGetter.name,
            key: coalesce(keyArgument.operation_value_text, keyArgument.action_text_raw),
            defaultValue: coalesce(defaultArgument.operation_value_text, defaultArgument.action_text_raw),
            consumers: [consumer IN consumers WHERE consumer IS NOT NULL]
          } END AS configurationSemantics
        }
        RETURN {
          stableId: primitive.stableId,
          labels: labels(primitive),
          label: primitive.label,
          primitiveKind: primitive.primitive_kind,
          executionOutcome: primitive.execution_outcome,
          runtimeEventKind: primitive.runtime_event_kind,
          instrumentationStrategy: primitive.instrumentation_strategy,
          instrumentationPhase: primitive.instrumentation_phase,
          instrumentationTargetStableId: primitive.instrumentation_target_stable_id,
          sequenceOwnerStableId: primitive.sequence_owner_stable_id,
          ownerFnStableId: primitive.parentFnStableId,
          ownerStepStableId: primitive.parentStepStableId,
          ownerFlowBlockStableId: primitive.parentFlowBlockStableId,
          incoming: [item IN incomingItems WHERE item IS NOT NULL],
          outgoing: [item IN outgoingItems WHERE item IS NOT NULL],
          sourceExpressions: [item IN sourceExpressions WHERE item IS NOT NULL],
          producers: [item IN producers WHERE item IS NOT NULL],
          literalDomains: [item IN literalDomains WHERE item IS NOT NULL],
          configurationSemantics: configurationSemantics
        } AS context
      `, { stableId });
    },
    async dependencies(session, stableId) {
      const row = await runSingle(session, `
        MATCH (primitive:Primitive {stableId: $stableId})
        CALL (primitive) {
          OPTIONAL MATCH (producer)-[:ASSIGNS_VALUE]->(primitive)
          OPTIONAL MATCH (callable:Fn {stableId: coalesce(producer.canonicalStableId, producer.calleeStableId)})
          RETURN collect(DISTINCT CASE WHEN callable IS NULL THEN null ELSE {
            stableId: callable.stableId,
            annotationKind: 'Callable',
            role: 'value-producer-callable',
            dependencyKind: 'semantic',
            recurse: true,
            ordinal: coalesce(producer.operation_index, 0)
          } END) AS callables
        }
        CALL (primitive) {
          OPTIONAL MATCH (operand:ValueAccess)-[input]->(primitive)
          WHERE type(input) IN ['VALUE', 'OPERAND', 'LEFT_OPERAND', 'RIGHT_OPERAND', 'TRUE', 'FALSE']
          OPTIONAL MATCH (operand)-[:READS_VALUE|RECEIVES_VALUE|CAPTURES_VALUE]->(linkedBinding:ValueSlot)
          OPTIONAL MATCH (directBinding:ValueSlot {
            stableId: coalesce(operand.value_slot_stableId, operand.bindingStableId, operand.canonicalStableId)
          })
          WITH operand, coalesce(linkedBinding, directBinding) AS binding
          RETURN collect(DISTINCT CASE WHEN binding IS NULL THEN null ELSE {
            stableId: binding.stableId,
            annotationKind: 'Binding',
            role: 'expression-operand',
            dependencyKind: 'semantic',
            recurse: CASE
              WHEN binding:Parameter THEN false
              ELSE true
            END,
            ordinal: coalesce(operand.operation_index, 0)
          } END) AS operands
        }
        CALL (primitive) {
          OPTIONAL MATCH (primitive)-[:COMPOSES_SYNTAX]->(syntaxRoot)
          OPTIONAL MATCH canonicalPath=(syntaxRoot)-[:HAS_ARGUMENT|VALUE_FROM|CALLS_VALUE|READS_FROM|RESOLVES_TO|HAS_PROPERTY*1..6]->(candidate:DeveloperDefined)
          WHERE candidate <> primitive
            AND (candidate:Fn OR candidate:CallableDeclaration OR candidate:ValueSlot OR candidate:ValueDeclaration)
          RETURN collect(DISTINCT CASE WHEN candidate IS NULL THEN null ELSE {
            stableId: candidate.stableId,
            annotationKind: CASE
              WHEN candidate:Fn THEN 'Callable'
              ELSE 'FunctionalEntity'
            END,
            role: 'canonical-expression-participant',
            dependencyKind: 'semantic',
            recurse: CASE
              WHEN candidate:Parameter THEN false
              ELSE true
            END,
            ordinal: coalesce(candidate.operation_index, primitive.operation_index, 0)
          } END) AS canonicalParticipants
        }
        RETURN [dependency IN callables + operands + canonicalParticipants WHERE dependency IS NOT NULL] AS dependencies
      `, { stableId });
      return (row?.dependencies || []).filter(Boolean);
    },
  },
  Binding: {
    id: 'binding-history',
    version: PROFILE_VERSION + 4,
    // A binding already owns an explicit value-history traversal below. Generic
    // syntax composition expands one property read into its whole aggregate
    // parameter/type and is renderer context, not additional value provenance.
    compositionContext: false,
    async contextMany(session, stableIds, options = {}) {
      const result = await session.run(`
        UNWIND $stableIds AS stableId
        MATCH (binding:ValueSlot {stableId: stableId})
        CALL (binding) {
          OPTIONAL MATCH (binding)-[:USES_LITERAL]->(occurrence:LiteralOccurrence)-[:RESOLVES_TO]->(selected:LiteralDomainValue)<-[:HAS_MEMBER]-(domain:LiteralDomain)
          OPTIONAL MATCH (domain)-[:HAS_MEMBER]->(allowed:LiteralDomainValue)
          WITH domain, occurrence, selected, allowed ORDER BY allowed.ordinal
          WITH domain, occurrence, selected, collect(CASE WHEN allowed IS NULL THEN null ELSE {
            name: allowed.name, value: allowed.value, ordinal: allowed.ordinal
          } END) AS allowedValues
          RETURN collect(DISTINCT CASE WHEN domain IS NULL THEN null ELSE {
            domainStableId: domain.stableId, domainName: domain.name, domainKind: domain.domain_kind,
            typeText: domain.type_text, selectedValue: selected.value, selectedName: selected.name,
            occurrenceSyntax: occurrence.raw_text,
            allowedValues: [value IN allowedValues WHERE value IS NOT NULL]
          } END) AS literalDomains
        }
        OPTIONAL MATCH (stateCreation:Call {state_resource_stableId: binding.stableId})
        WHERE stateCreation.state_update_action = 'create'
        OPTIONAL MATCH (localSlot:ValueSlot)
        WHERE localSlot = binding
          OR localSlot.bindingStableId = binding.stableId
          OR localSlot.canonicalStableId = binding.stableId
          OR localSlot.originalStableId = binding.stableId
        OPTIONAL MATCH (event)-[access]->(localSlot)
        WHERE type(access) IN ['CREATES_VALUE', 'RECEIVES_VALUE', 'READS_VALUE', 'WRITES_VALUE', 'PASSES_VALUE', 'CLEARS_VALUE', 'DELETES_VALUE', 'CAPTURES_VALUE']
          AND ($atOperationIndex IS NULL OR event.operation_index <= $atOperationIndex)
        OPTIONAL MATCH (step:Step {stableId: event.parentStepStableId})
        OPTIONAL MATCH (origin)-[pass:PASSES_VALUE]->(event)
        OPTIONAL MATCH (caller:Fn)
        WHERE caller = origin OR caller.stableId = origin.parentFnStableId
        WITH binding, literalDomains, stateCreation, event, access, step, collect(DISTINCT CASE WHEN origin IS NULL THEN null ELSE {
          stableId: origin.stableId, labels: labels(origin), syntax: origin.action_text_raw,
          relation: type(pass), argumentName: pass.argument_name, argumentIndex: pass.argument_index,
          argumentText: pass.argument_text_raw, callSiteStableId: pass.call_site_stable_id,
          callerFnStableId: caller.stableId, callerName: caller.name,
          sourceBindingStableId: CASE WHEN origin:ValueSlot THEN origin.stableId ELSE null END,
          sourceBindingName: CASE WHEN origin:ValueSlot THEN coalesce(origin.value_name, origin.label) ELSE null END
        } END) AS origins
        ORDER BY event.operation_index
        WITH binding, literalDomains, stateCreation, collect(DISTINCT CASE WHEN event IS NULL THEN null ELSE {
          relation: type(access), eventStableId: event.stableId, eventLabels: labels(event),
          operationIndex: event.operation_index, syntax: event.value_operation_syntax, stepStableId: step.stableId,
          origins: [origin IN origins WHERE origin IS NOT NULL]
        } END) AS history
        RETURN binding.stableId AS stableId, {
          stableId: binding.stableId, labels: labels(binding), name: coalesce(binding.value_name, binding.label),
          scope: binding.value_scope, declarationKind: binding.variable_declaration_kind,
          declarationSyntax: coalesce(binding.value_operation_syntax, binding.action_text_raw),
          initializer: coalesce(binding.operation_value_text, stateCreation.operation_value_text),
          stateInitialization: CASE WHEN stateCreation IS NULL THEN null ELSE {
            stableId: stateCreation.stableId,
            syntax: coalesce(stateCreation.value_operation_syntax, stateCreation.action_text_raw),
            initializer: stateCreation.operation_value_text,
            documentation: stateCreation.source_documentation
          } END,
          ownerFnStableId: binding.parentFnStableId,
          history: [event IN history WHERE event IS NOT NULL],
          literalDomains: [item IN literalDomains WHERE item IS NOT NULL]
        } AS context
      `, { stableIds, atOperationIndex: options.atOperationIndex ?? null });
      return new Map(result.records.map((record) => [record.get('stableId'), normalizeNeo4jValue(record.get('context'))]));
    },
    async dependenciesMany(session, stableIds, options = {}) {
      const result = await session.run(`
        UNWIND $stableIds AS stableId
        MATCH (binding:ValueSlot {stableId: stableId})
        OPTIONAL MATCH (localSlot:ValueSlot)
        WHERE localSlot = binding
          OR localSlot.bindingStableId = binding.stableId
          OR localSlot.canonicalStableId = binding.stableId
          OR localSlot.originalStableId = binding.stableId
        OPTIONAL MATCH (event)-[access]->(localSlot)
        WHERE type(access) IN ['CREATES_VALUE', 'RECEIVES_VALUE', 'READS_VALUE', 'WRITES_VALUE', 'PASSES_VALUE', 'CLEARS_VALUE', 'DELETES_VALUE', 'CAPTURES_VALUE']
          AND ($atOperationIndex IS NULL OR event.operation_index <= $atOperationIndex)
        OPTIONAL MATCH (event)-[invocation]->(target:Fn)
        WHERE type(invocation) IN ['CALL', 'REQUEST', 'READ', 'WRITE', 'DETACHES_ASYNC', 'AWAITS_ASYNC']
        OPTIONAL MATCH (event)-[storageEffect]->(storage)
        WHERE type(storageEffect) IN ['READ', 'WRITE', 'READS_VALUE', 'WRITES_VALUE']
          AND (storage:Storage OR storage:Cell OR storage:Setting)
          AND storage.stableId = binding.stableId
        OPTIONAL MATCH (origin)-[:PASSES_VALUE]->(event)
        OPTIONAL MATCH (caller:Fn)
        WHERE caller = origin OR caller.stableId = origin.parentFnStableId
        WITH binding,
             collect(DISTINCT CASE WHEN target IS NULL THEN null ELSE {
               stableId: target.stableId, annotationKind: 'Callable', role: 'value-use-callable', recurse: true, ordinal: coalesce(event.operation_index, 0)
             } END) AS callables,
             collect(DISTINCT CASE WHEN storage IS NULL THEN null ELSE {
               stableId: storage.stableId, annotationKind: 'StorageCell', role: 'value-storage', recurse: true, ordinal: coalesce(event.operation_index, 0)
             } END) AS storages,
             collect(DISTINCT CASE WHEN caller IS NULL THEN null ELSE {
               stableId: caller.stableId, annotationKind: 'Callable', role: 'parameter-origin-caller', recurse: false, ordinal: coalesce(event.operation_index, 0)
             } END) AS callers,
             collect(DISTINCT CASE WHEN origin:ValueSlot THEN {
               stableId: origin.stableId, annotationKind: 'Binding', role: 'parameter-origin-binding', recurse: true, ordinal: coalesce(event.operation_index, 0)
             } ELSE null END) AS sourceBindings
        RETURN binding.stableId AS stableId, [item IN callables + storages + callers + sourceBindings WHERE item IS NOT NULL] AS dependencies
      `, { stableIds, atOperationIndex: options.atOperationIndex ?? null });
      return new Map(result.records.map((record) => [record.get('stableId'), normalizeNeo4jValue(record.get('dependencies'))]));
    },
    async context(session, stableId, options = {}) {
      return runSingle(session, `
        MATCH (binding:ValueSlot {stableId: $stableId})
        CALL (binding) {
          OPTIONAL MATCH (binding)-[:USES_LITERAL]->(occurrence:LiteralOccurrence)-[:RESOLVES_TO]->(selected:LiteralDomainValue)<-[:HAS_MEMBER]-(domain:LiteralDomain)
          OPTIONAL MATCH (domain)-[:HAS_MEMBER]->(allowed:LiteralDomainValue)
          WITH domain, occurrence, selected, allowed ORDER BY allowed.ordinal
          WITH domain, occurrence, selected, collect(CASE WHEN allowed IS NULL THEN null ELSE {
            name: allowed.name, value: allowed.value, ordinal: allowed.ordinal
          } END) AS allowedValues
          RETURN collect(DISTINCT CASE WHEN domain IS NULL THEN null ELSE {
            domainStableId: domain.stableId, domainName: domain.name, domainKind: domain.domain_kind,
            typeText: domain.type_text, selectedValue: selected.value, selectedName: selected.name,
            occurrenceSyntax: occurrence.raw_text,
            allowedValues: [value IN allowedValues WHERE value IS NOT NULL]
          } END) AS literalDomains
        }
        OPTIONAL MATCH (stateCreation:Call {state_resource_stableId: binding.stableId})
        WHERE stateCreation.state_update_action = 'create'
        OPTIONAL MATCH (localSlot:ValueSlot)
        WHERE localSlot = binding
          OR localSlot.bindingStableId = binding.stableId
          OR localSlot.canonicalStableId = binding.stableId
          OR localSlot.originalStableId = binding.stableId
        OPTIONAL MATCH (event)-[access]->(localSlot)
        WHERE type(access) IN ['CREATES_VALUE', 'RECEIVES_VALUE', 'READS_VALUE', 'WRITES_VALUE', 'PASSES_VALUE', 'CLEARS_VALUE', 'DELETES_VALUE', 'CAPTURES_VALUE']
          AND ($atOperationIndex IS NULL OR event.operation_index <= $atOperationIndex)
        OPTIONAL MATCH (step:Step {stableId: event.parentStepStableId})
        OPTIONAL MATCH (origin)-[pass:PASSES_VALUE]->(event)
        OPTIONAL MATCH (caller:Fn)
        WHERE caller = origin OR caller.stableId = origin.parentFnStableId
        WITH binding, literalDomains, stateCreation, event, access, step, collect(DISTINCT CASE WHEN origin IS NULL THEN null ELSE {
          stableId: origin.stableId, labels: labels(origin), syntax: origin.action_text_raw,
          relation: type(pass), argumentName: pass.argument_name, argumentIndex: pass.argument_index,
          argumentText: pass.argument_text_raw, callSiteStableId: pass.call_site_stable_id,
          callerFnStableId: caller.stableId, callerName: caller.name,
          sourceBindingStableId: CASE WHEN origin:ValueSlot THEN origin.stableId ELSE null END,
          sourceBindingName: CASE WHEN origin:ValueSlot THEN coalesce(origin.value_name, origin.label) ELSE null END
        } END) AS origins
        ORDER BY event.operation_index
        WITH binding, literalDomains, stateCreation, collect(DISTINCT CASE WHEN event IS NULL THEN null ELSE {
          relation: type(access),
          eventStableId: event.stableId,
          eventLabels: labels(event),
          operationIndex: event.operation_index,
          syntax: event.value_operation_syntax,
          stepStableId: step.stableId,
          origins: [origin IN origins WHERE origin IS NOT NULL]
        } END) AS history
        RETURN {
          stableId: binding.stableId,
          labels: labels(binding),
          name: coalesce(binding.value_name, binding.label),
          scope: binding.value_scope,
          declarationKind: binding.variable_declaration_kind,
          declarationSyntax: coalesce(binding.value_operation_syntax, binding.action_text_raw),
          initializer: coalesce(binding.operation_value_text, stateCreation.operation_value_text),
          stateInitialization: CASE WHEN stateCreation IS NULL THEN null ELSE {
            stableId: stateCreation.stableId,
            syntax: coalesce(stateCreation.value_operation_syntax, stateCreation.action_text_raw),
            initializer: stateCreation.operation_value_text,
            documentation: stateCreation.source_documentation
          } END,
          ownerFnStableId: binding.parentFnStableId,
          history: [event IN history WHERE event IS NOT NULL],
          literalDomains: [item IN literalDomains WHERE item IS NOT NULL]
        } AS context
      `, { stableId, atOperationIndex: options.atOperationIndex ?? null });
    },
    async dependencies() {
      return [];
    },
  },
  CallSite: {
    id: 'call-site',
    version: PROFILE_VERSION + 4,
    compositionContext: true,
    async contextMany(session, stableIds) {
      const result = await session.run(`
        UNWIND $stableIds AS stableId
        MATCH (site {stableId: stableId})
        WHERE site:Request OR site:Op OR site:Call OR EXISTS { MATCH (site)-[:CALL|REQUEST|INVOKES]->(:Fn) }
        OPTIONAL MATCH (step:Step {stableId: site.parentStepStableId})
        CALL (site) {
          OPTIONAL MATCH (site)-[relation]->(target)
          WHERE type(relation) IN ['CALL', 'REQUEST', 'READ', 'WRITE', 'ARG', 'FIELD', 'RESULT', 'RESPONSE', 'DETACHES_ASYNC', 'AWAITS_ASYNC', 'INVOKES']
          RETURN collect(CASE WHEN target IS NULL THEN null ELSE {
            type: type(relation), targetStableId: target.stableId, targetLabels: labels(target),
            targetLabel: coalesce(target.name, target.label),
            targetCanonicalStableId: coalesce(target.canonicalStableId, target.calleeStableId)
          } END) AS relations
        }
        CALL (site) {
          OPTIONAL MATCH (site)-[:COMPOSES_SYNTAX]->(receiverCall:Call)
          OPTIONAL MATCH (site)-[:COMPOSES_SYNTAX]->(memberReference:MemberReference)
          WHERE coalesce(memberReference.startLine, memberReference.start_line, 0) > coalesce(receiverCall.endLine, receiverCall.end_line, 0)
             OR (
               coalesce(memberReference.startLine, memberReference.start_line, 0) = coalesce(receiverCall.endLine, receiverCall.end_line, 0)
               AND coalesce(memberReference.startColumn, memberReference.start_column, 0) >= coalesce(receiverCall.endColumn, receiverCall.end_column, 0)
             )
          OPTIONAL MATCH (memberReference)-[:RESOLVES_TO]->(memberDeclaration:Declaration)
          RETURN collect(DISTINCT CASE WHEN memberReference IS NULL THEN null ELSE {
            stableId: memberReference.stableId,
            name: coalesce(memberReference.name, memberReference.label),
            syntax: coalesce(memberReference.syntax, memberReference.action_text_raw),
            declaration: CASE WHEN memberDeclaration IS NULL THEN null ELSE {
              stableId: memberDeclaration.stableId,
              name: coalesce(memberDeclaration.name, memberDeclaration.label),
              syntax: coalesce(memberDeclaration.syntax, memberDeclaration.action_text_raw),
              labels: labels(memberDeclaration)
            } END
          } END) AS trailingMemberAccesses
        }
        CALL (site) {
          OPTIONAL MATCH (site)-[:COMPOSES_SYNTAX]->(receiverCall:Call)
          OPTIONAL MATCH (site)-[:COMPOSES_SYNTAX]->(focusedReference:MemberReference)-[:RESOLVES_TO]->(focusedDeclaration:Declaration)
          WHERE coalesce(focusedReference.startLine, focusedReference.start_line, 0) > coalesce(receiverCall.endLine, receiverCall.end_line, 0)
             OR (
               coalesce(focusedReference.startLine, focusedReference.start_line, 0) = coalesce(receiverCall.endLine, receiverCall.end_line, 0)
               AND coalesce(focusedReference.startColumn, focusedReference.start_column, 0) >= coalesce(receiverCall.endColumn, receiverCall.end_column, 0)
             )
          OPTIONAL MATCH (peerUse)-[:USES_MEMBER_REFERENCE]->(peerReference:MemberReference)-[:RESOLVES_TO]->(focusedDeclaration)
          WITH DISTINCT peerUse
          CALL (peerUse) {
            OPTIONAL MATCH effectPath=(peerUse)-[:TRUE|FALSE|NEXT*1..5]->(effect)
            WHERE effect.parentFnStableId = peerUse.parentFnStableId
               OR effect.parentFnStableId IS NULL
            RETURN collect(DISTINCT CASE
              WHEN effect IS NULL OR coalesce(effect.condition_raw, effect.action_text_raw, effect.operation_subject_text) IS NULL THEN null
              ELSE {
                stableId: effect.stableId,
                labels: labels(effect),
                syntax: coalesce(effect.condition_raw, effect.action_text_raw, effect.operation_subject_text),
                valueText: effect.operation_value_text
              }
            END) AS controlledEffects
          }
          RETURN collect(DISTINCT CASE WHEN peerUse IS NULL THEN null ELSE {
            stableId: peerUse.stableId,
            labels: labels(peerUse),
            syntax: coalesce(peerUse.condition_raw, peerUse.action_text_raw, peerUse.operation_subject_text),
            controlledEffects: [effect IN controlledEffects WHERE effect IS NOT NULL]
          } END) AS relatedMemberUses
        }
        CALL (site) {
          OPTIONAL MATCH (capture:CapturedBinding {parentFnStableId: site.parentFnStableId})
          WHERE coalesce(capture.value_name, capture.label) = coalesce(site.operation_callee_text, site.callee_name)
          OPTIONAL MATCH (binding:ValueSlot {stableId: capture.bindingStableId})
          OPTIONAL MATCH (producer)-[:ASSIGNS_VALUE]->(binding)
          OPTIONAL MATCH (producer)-[originInvocation]->(originTarget:Fn)
          WHERE type(originInvocation) IN ['CALL', 'REQUEST', 'READ', 'WRITE', 'INVOKES']
          RETURN collect(DISTINCT CASE WHEN originTarget IS NULL THEN null ELSE {
            bindingStableId: binding.stableId, producerStableId: producer.stableId,
            producerText: coalesce(producer.call_text_raw, producer.action_text_raw),
            relation: type(originInvocation), targetStableId: originTarget.stableId,
            targetName: coalesce(originTarget.name, originTarget.label), targetLabels: labels(originTarget)
          } END) AS callableOrigins
        }
        OPTIONAL MATCH (declaredCallee:Fn {stableId: site.calleeStableId})
        RETURN site.stableId AS stableId, {
          stableId: site.stableId, labels: labels(site), label: site.label,
          callText: coalesce(site.call_text_raw, site.action_text_raw, site.condition_raw),
          callee: CASE WHEN site.calleeStableId IS NULL THEN null ELSE {
            stableId: coalesce(declaredCallee.stableId, site.calleeStableId),
            name: coalesce(declaredCallee.name, declaredCallee.label, site.callee_name),
            labels: labels(declaredCallee)
          } END,
          operationIndex: site.operation_index, ownerFnStableId: site.parentFnStableId,
          stepStableId: step.stableId,
          relations: [relation IN relations WHERE relation IS NOT NULL],
          memberAccesses: [memberAccess IN trailingMemberAccesses WHERE memberAccess IS NOT NULL],
          relatedMemberUses: [memberUse IN relatedMemberUses WHERE memberUse IS NOT NULL],
          callableOrigins: [origin IN callableOrigins WHERE origin IS NOT NULL],
          executionRoleBindingsJson: site.execution_role_bindings_json
        } AS context
      `, { stableIds });
      const contexts = new Map(result.records.map((record) => [
        record.get('stableId'), normalizeNeo4jValue(record.get('context')),
      ]));
      const roleStableIds = [...new Set([...contexts.values()].flatMap((context) => (
        parseCallableRoleBindings(context.executionRoleBindingsJson).map((binding) => binding.stableId)
      )))];
      if (!roleStableIds.length) return contexts;
      const targetResult = await session.run(`
        UNWIND $stableIds AS stableId
        MATCH (target:Fn {stableId: stableId})
        RETURN target.stableId AS stableId, coalesce(target.name, target.label) AS name, labels(target) AS labels
      `, { stableIds: roleStableIds });
      const targetByStableId = new Map(targetResult.records.map((record) => [record.get('stableId'), {
        stableId: record.get('stableId'), name: record.get('name'), labels: record.get('labels'),
      }]));
      for (const context of contexts.values()) {
        context.nestedCalls = parseCallableRoleBindings(context.executionRoleBindingsJson)
          .map((binding) => ({ ...targetByStableId.get(binding.stableId), role: binding.role }))
          .filter((target) => target.stableId);
      }
      return contexts;
    },
    async dependenciesMany(session, stableIds) {
      const result = await session.run(`
        UNWIND $stableIds AS stableId
        MATCH (site {stableId: stableId})
        WHERE site:Request OR site:Op OR site:Call OR EXISTS { MATCH (site)-[:CALL|REQUEST|INVOKES]->(:Fn) }
        CALL (site) {
          OPTIONAL MATCH (declaredCallee:Fn {stableId: site.calleeStableId})
          OPTIONAL MATCH (site)-[relation]->(linkedTarget:Fn)
          WHERE type(relation) IN ['CALL', 'CALLS', 'REQUEST', 'READ', 'WRITE', 'DETACHES_ASYNC', 'AWAITS_ASYNC', 'INVOKES']
            AND NOT linkedTarget:PresentationOnly
            AND NOT linkedTarget:VisualProxy
          OPTIONAL MATCH (canonicalTarget:Fn {stableId: coalesce(linkedTarget.canonicalStableId, linkedTarget.calleeStableId)})
          WITH collect(DISTINCT declaredCallee) + collect(DISTINCT coalesce(canonicalTarget, linkedTarget)) AS candidates
          RETURN reduce(targets = [], target IN candidates |
            CASE WHEN target IS NULL OR target IN targets THEN targets ELSE targets + target END
          ) AS targets
        }
        CALL (site) {
          OPTIONAL MATCH (capture:CapturedBinding {parentFnStableId: site.parentFnStableId})
          WHERE coalesce(capture.value_name, capture.label) = coalesce(site.operation_callee_text, site.callee_name)
          OPTIONAL MATCH (binding:ValueSlot {stableId: capture.bindingStableId})
          OPTIONAL MATCH (producer)-[:ASSIGNS_VALUE]->(binding)
          OPTIONAL MATCH (producer)-[originInvocation]->(originTarget:Fn)
          WHERE type(originInvocation) IN ['CALL', 'REQUEST', 'READ', 'WRITE', 'INVOKES']
          RETURN collect(DISTINCT originTarget) AS originTargets
        }
        RETURN site.stableId AS stableId,
          [target IN targets | {
            stableId: target.stableId, annotationKind: 'Callable', role: 'callee', dependencyKind: 'semantic', recurse: true, ordinal: coalesce(site.operation_index, 0)
          }] + [target IN originTargets WHERE target IS NOT NULL | {
            stableId: target.stableId, annotationKind: 'Callable', role: 'value-origin', dependencyKind: 'semantic', recurse: true, ordinal: coalesce(site.operation_index, 0)
          }] AS dependencies,
          site.execution_role_bindings_json AS executionRoleBindingsJson,
          EXISTS {
            MATCH (site)-[:COMPOSES_SYNTAX]->(receiverCall:Call)
            MATCH (site)-[:COMPOSES_SYNTAX]->(memberReference:MemberReference)
            WHERE coalesce(memberReference.startLine, memberReference.start_line, 0) > coalesce(receiverCall.endLine, receiverCall.end_line, 0)
               OR (
                 coalesce(memberReference.startLine, memberReference.start_line, 0) = coalesce(receiverCall.endLine, receiverCall.end_line, 0)
                 AND coalesce(memberReference.startColumn, memberReference.start_column, 0) >= coalesce(receiverCall.endColumn, receiverCall.end_column, 0)
               )
          } AS hasTrailingMemberAccess,
          coalesce(site.operation_index, 0) AS operationIndex
      `, { stableIds });
      const rows = result.records.map((record) => normalizeNeo4jValue(record.toObject()));
      const roleStableIds = [...new Set(rows.flatMap((row) => (
        parseCallableRoleBindings(row.executionRoleBindingsJson).map((binding) => binding.stableId)
      )))];
      const callableStableIds = new Set();
      if (roleStableIds.length) {
        const targetResult = await session.run(`
          UNWIND $stableIds AS stableId
          MATCH (target:Fn {stableId: stableId})
          RETURN target.stableId AS stableId
        `, { stableIds: roleStableIds });
        targetResult.records.forEach((record) => callableStableIds.add(record.get('stableId')));
      }
      return new Map(rows.map((row) => {
        const dependencies = row.hasTrailingMemberAccess ? [] : (row.dependencies || []);
        if (row.hasTrailingMemberAccess) return [row.stableId, dependencies];
        const seen = new Set(dependencies.map((dependency) => dependency.stableId));
        for (const binding of parseCallableRoleBindings(row.executionRoleBindingsJson)) {
          if (!callableStableIds.has(binding.stableId) || seen.has(binding.stableId)) continue;
          dependencies.push({
            stableId: binding.stableId, annotationKind: 'Callable', role: binding.role,
            dependencyKind: 'semantic', recurse: true, ordinal: row.operationIndex || 0,
          });
          seen.add(binding.stableId);
        }
        return [row.stableId, dependencies];
      }));
    },
    async context(session, stableId) {
      const row = await runSingle(session, `
        MATCH (site {stableId: $stableId})
        WHERE site:Request OR site:Op OR site:Call OR EXISTS { MATCH (site)-[:CALL|REQUEST|INVOKES]->(:Fn) }
        OPTIONAL MATCH (step:Step {stableId: site.parentStepStableId})
        OPTIONAL MATCH (site)-[relation]->(target)
        WHERE type(relation) IN ['CALL', 'CALLS', 'REQUEST', 'READ', 'WRITE', 'ARG', 'FIELD', 'RESULT', 'RESPONSE', 'DETACHES_ASYNC', 'AWAITS_ASYNC', 'INVOKES']
        WITH site, step, collect(CASE WHEN target IS NULL THEN null ELSE {
          type: type(relation), targetStableId: target.stableId, targetLabels: labels(target),
          targetLabel: coalesce(target.name, target.label),
          targetCanonicalStableId: coalesce(target.canonicalStableId, target.calleeStableId)
        } END) AS relations
        CALL (site) {
          OPTIONAL MATCH (site)-[:COMPOSES_SYNTAX]->(receiverCall:Call)
          OPTIONAL MATCH (site)-[:COMPOSES_SYNTAX]->(memberReference:MemberReference)
          WHERE coalesce(memberReference.startLine, memberReference.start_line, 0) > coalesce(receiverCall.endLine, receiverCall.end_line, 0)
             OR (
               coalesce(memberReference.startLine, memberReference.start_line, 0) = coalesce(receiverCall.endLine, receiverCall.end_line, 0)
               AND coalesce(memberReference.startColumn, memberReference.start_column, 0) >= coalesce(receiverCall.endColumn, receiverCall.end_column, 0)
             )
          OPTIONAL MATCH (memberReference)-[:RESOLVES_TO]->(memberDeclaration:Declaration)
          RETURN collect(DISTINCT CASE WHEN memberReference IS NULL THEN null ELSE {
            stableId: memberReference.stableId,
            name: coalesce(memberReference.name, memberReference.label),
            syntax: coalesce(memberReference.syntax, memberReference.action_text_raw),
            declaration: CASE WHEN memberDeclaration IS NULL THEN null ELSE {
              stableId: memberDeclaration.stableId,
              name: coalesce(memberDeclaration.name, memberDeclaration.label),
              syntax: coalesce(memberDeclaration.syntax, memberDeclaration.action_text_raw),
              labels: labels(memberDeclaration)
            } END
          } END) AS trailingMemberAccesses
        }
        CALL (site) {
          OPTIONAL MATCH (site)-[:COMPOSES_SYNTAX]->(receiverCall:Call)
          OPTIONAL MATCH (site)-[:COMPOSES_SYNTAX]->(focusedReference:MemberReference)-[:RESOLVES_TO]->(focusedDeclaration:Declaration)
          WHERE coalesce(focusedReference.startLine, focusedReference.start_line, 0) > coalesce(receiverCall.endLine, receiverCall.end_line, 0)
             OR (
               coalesce(focusedReference.startLine, focusedReference.start_line, 0) = coalesce(receiverCall.endLine, receiverCall.end_line, 0)
               AND coalesce(focusedReference.startColumn, focusedReference.start_column, 0) >= coalesce(receiverCall.endColumn, receiverCall.end_column, 0)
             )
          OPTIONAL MATCH (peerUse)-[:USES_MEMBER_REFERENCE]->(peerReference:MemberReference)-[:RESOLVES_TO]->(focusedDeclaration)
          WITH DISTINCT peerUse
          CALL (peerUse) {
            OPTIONAL MATCH effectPath=(peerUse)-[:TRUE|FALSE|NEXT*1..5]->(effect)
            WHERE effect.parentFnStableId = peerUse.parentFnStableId
               OR effect.parentFnStableId IS NULL
            RETURN collect(DISTINCT CASE
              WHEN effect IS NULL OR coalesce(effect.condition_raw, effect.action_text_raw, effect.operation_subject_text) IS NULL THEN null
              ELSE {
                stableId: effect.stableId,
                labels: labels(effect),
                syntax: coalesce(effect.condition_raw, effect.action_text_raw, effect.operation_subject_text),
                valueText: effect.operation_value_text
              }
            END) AS controlledEffects
          }
          RETURN collect(DISTINCT CASE WHEN peerUse IS NULL THEN null ELSE {
            stableId: peerUse.stableId,
            labels: labels(peerUse),
            syntax: coalesce(peerUse.condition_raw, peerUse.action_text_raw, peerUse.operation_subject_text),
            controlledEffects: [effect IN controlledEffects WHERE effect IS NOT NULL]
          } END) AS relatedMemberUses
        }
        CALL (site) {
          OPTIONAL MATCH (capture:CapturedBinding)
          WHERE capture.parentFnStableId = site.parentFnStableId
            AND coalesce(capture.value_name, capture.label) = coalesce(site.operation_callee_text, site.callee_name)
          OPTIONAL MATCH (binding {stableId: capture.bindingStableId})
          OPTIONAL MATCH (producer)-[:ASSIGNS_VALUE]->(binding)
          OPTIONAL MATCH (producer)-[originInvocation]->(originTarget:Fn)
          WHERE type(originInvocation) IN ['CALL', 'REQUEST', 'READ', 'WRITE', 'INVOKES']
          RETURN collect(DISTINCT CASE WHEN originTarget IS NULL THEN null ELSE {
            bindingStableId: binding.stableId,
            producerStableId: producer.stableId,
            producerText: coalesce(producer.call_text_raw, producer.action_text_raw),
            relation: type(originInvocation),
            targetStableId: originTarget.stableId,
            targetName: coalesce(originTarget.name, originTarget.label),
            targetLabels: labels(originTarget)
          } END) AS callableOrigins
        }
        OPTIONAL MATCH (declaredCallee:Fn {stableId: site.calleeStableId})
        RETURN {
          stableId: site.stableId,
          labels: labels(site),
          label: site.label,
          callText: coalesce(site.call_text_raw, site.action_text_raw, site.condition_raw),
          callee: CASE WHEN site.calleeStableId IS NULL THEN null ELSE {
            stableId: coalesce(declaredCallee.stableId, site.calleeStableId),
            name: coalesce(declaredCallee.name, declaredCallee.label, site.callee_name),
            labels: labels(declaredCallee)
          } END,
          operationIndex: site.operation_index,
          ownerFnStableId: site.parentFnStableId,
          stepStableId: step.stableId,
          relations: [relation IN relations WHERE relation IS NOT NULL],
          memberAccesses: [memberAccess IN trailingMemberAccesses WHERE memberAccess IS NOT NULL],
          relatedMemberUses: [memberUse IN relatedMemberUses WHERE memberUse IS NOT NULL],
          callableOrigins: [origin IN callableOrigins WHERE origin IS NOT NULL],
          executionRoleBindingsJson: site.execution_role_bindings_json
        } AS context
      `, { stableId });
      if (!row?.context) return row;
      const bindings = parseCallableRoleBindings(row.context.executionRoleBindingsJson);
      if (!bindings.length) return row;
      const result = await session.run(`
        MATCH (target:Fn)
        WHERE target.stableId IN $stableIds
        RETURN collect({
          stableId: target.stableId,
          name: coalesce(target.name, target.label),
          labels: labels(target)
        }) AS targets
      `, { stableIds: bindings.map((binding) => binding.stableId) });
      const targets = normalizeNeo4jValue(result.records[0]?.toObject()?.targets || []);
      const targetByStableId = new Map(targets.map((target) => [target.stableId, target]));
      row.context.nestedCalls = bindings
        .map((binding) => ({ ...targetByStableId.get(binding.stableId), role: binding.role }))
        .filter((target) => target.stableId);
      return row;
    },
    async dependencies(session, stableId) {
      const row = await runSingle(session, `
        MATCH (site {stableId: $stableId})
        WHERE site:Request OR site:Op OR site:Call OR EXISTS { MATCH (site)-[:CALL|REQUEST|INVOKES]->(:Fn) }
        OPTIONAL MATCH (declaredCallee:Fn {stableId: site.calleeStableId})
        OPTIONAL MATCH (site)-[relation]->(linkedTarget:Fn)
        WHERE type(relation) IN ['CALL', 'CALLS', 'REQUEST', 'READ', 'WRITE', 'DETACHES_ASYNC', 'AWAITS_ASYNC', 'INVOKES']
          AND NOT linkedTarget:PresentationOnly
          AND NOT linkedTarget:VisualProxy
        OPTIONAL MATCH (canonicalTarget:Fn {stableId: coalesce(linkedTarget.canonicalStableId, linkedTarget.calleeStableId)})
        WITH site, collect(DISTINCT declaredCallee) + collect(DISTINCT coalesce(canonicalTarget, linkedTarget)) AS candidates
        WITH site, reduce(targets = [], target IN candidates |
          CASE WHEN target IS NULL OR target IN targets THEN targets ELSE targets + target END
        ) AS targets
        CALL (site) {
          OPTIONAL MATCH (capture:CapturedBinding)
          WHERE capture.parentFnStableId = site.parentFnStableId
            AND coalesce(capture.value_name, capture.label) = coalesce(site.operation_callee_text, site.callee_name)
          OPTIONAL MATCH (binding {stableId: capture.bindingStableId})
          OPTIONAL MATCH (producer)-[:ASSIGNS_VALUE]->(binding)
          OPTIONAL MATCH (producer)-[originInvocation]->(originTarget:Fn)
          WHERE type(originInvocation) IN ['CALL', 'REQUEST', 'READ', 'WRITE', 'INVOKES']
          RETURN collect(DISTINCT originTarget) AS originTargets
        }
        RETURN [target IN targets | {
          stableId: target.stableId, annotationKind: 'Callable', role: 'callee', recurse: true, ordinal: coalesce(site.operation_index, 0)
        }] + [target IN originTargets WHERE target IS NOT NULL | {
          stableId: target.stableId, annotationKind: 'Callable', role: 'value-origin', recurse: true, ordinal: coalesce(site.operation_index, 0)
        }] AS dependencies, site.execution_role_bindings_json AS executionRoleBindingsJson,
        EXISTS {
          MATCH (site)-[:COMPOSES_SYNTAX]->(receiverCall:Call)
          MATCH (site)-[:COMPOSES_SYNTAX]->(memberReference:MemberReference)
          WHERE coalesce(memberReference.startLine, memberReference.start_line, 0) > coalesce(receiverCall.endLine, receiverCall.end_line, 0)
             OR (
               coalesce(memberReference.startLine, memberReference.start_line, 0) = coalesce(receiverCall.endLine, receiverCall.end_line, 0)
               AND coalesce(memberReference.startColumn, memberReference.start_column, 0) >= coalesce(receiverCall.endColumn, receiverCall.end_column, 0)
             )
        } AS hasTrailingMemberAccess,
        coalesce(site.operation_index, 0) AS operationIndex
      `, { stableId });
      const dependencies = row?.hasTrailingMemberAccess ? [] : (row?.dependencies || []);
      if (row?.hasTrailingMemberAccess) return dependencies;
      const bindings = parseCallableRoleBindings(row?.executionRoleBindingsJson);
      if (!bindings.length) return dependencies;
      const result = await session.run(`
        MATCH (target:Fn)
        WHERE target.stableId IN $stableIds
        RETURN collect(target.stableId) AS stableIds
      `, { stableIds: bindings.map((binding) => binding.stableId) });
      const callableStableIds = new Set(normalizeNeo4jValue(
        result.records[0]?.toObject()?.stableIds || [],
      ));
      const seen = new Set(dependencies.map((dependency) => dependency.stableId));
      for (const binding of bindings) {
        if (!callableStableIds.has(binding.stableId) || seen.has(binding.stableId)) continue;
        dependencies.push({
          stableId: binding.stableId,
          annotationKind: 'Callable',
          role: binding.role,
          recurse: true,
          ordinal: row?.operationIndex || 0,
        });
        seen.add(binding.stableId);
      }
      return dependencies;
    },
  },
  AsyncFlow: {
    id: 'async-flow',
    version: PROFILE_VERSION,
    compositionContext: true,
    async context(session, stableId) {
      return runSingle(session, `
        MATCH (flow:Request|Op|Call {stableId: $stableId})
        OPTIONAL MATCH (flow)-[relation]->(target)
        WHERE type(relation) IN ['DETACHES_ASYNC', 'AWAITS_ASYNC', 'CALL', 'REQUEST', 'RESPONSE', 'NEXT']
        WITH flow, collect(CASE WHEN target IS NULL THEN null ELSE {
          type: type(relation), targetStableId: target.stableId, targetLabels: labels(target)
        } END) AS transitions
        RETURN {
          stableId: flow.stableId,
          labels: labels(flow),
          label: flow.label,
          asyncContract: flow.async_contract,
          schedulerKind: flow.async_scheduler_kind,
          ownerFnStableId: flow.parentFnStableId,
          transitions: [transition IN transitions WHERE transition IS NOT NULL]
        } AS context
      `, { stableId });
    },
    async dependencies() {
      return [];
    },
  },
  UiSurface: {
    id: 'ui-surface',
    version: PROFILE_VERSION,
    async context(session, stableId) {
      return runSingle(session, `
        MATCH (surface {stableId: $stableId})
        OPTIONAL MATCH (actor)-[incoming]->(surface)
        OPTIONAL MATCH (surface)-[outgoing]->(consumer)
        WITH surface,
             collect(DISTINCT CASE WHEN actor IS NULL THEN null ELSE {
               type: type(incoming), stableId: actor.stableId, labels: labels(actor)
             } END) AS incomingItems,
             collect(DISTINCT CASE WHEN consumer IS NULL THEN null ELSE {
               type: type(outgoing), stableId: consumer.stableId, labels: labels(consumer)
             } END) AS outgoingItems
        RETURN {
          stableId: surface.stableId,
          labels: labels(surface),
          label: surface.label,
          slotName: surface.ui_slot_name,
          virtualViewKind: surface.virtual_view_kind,
          incoming: [item IN incomingItems WHERE item IS NOT NULL],
          outgoing: [item IN outgoingItems WHERE item IS NOT NULL]
        } AS context
      `, { stableId });
    },
    async dependencies() {
      return [];
    },
  },
  StorageCell: {
    id: 'storage-cell',
    version: PROFILE_VERSION,
    async context(session, stableId) {
      return runSingle(session, `
        MATCH (storage {stableId: $stableId})
        OPTIONAL MATCH (actor)-[incoming]->(storage)
        OPTIONAL MATCH (storage)-[outgoing]->(dependent)
        WITH storage,
             collect(DISTINCT CASE
               WHEN actor IS NULL OR type(incoming) IN ['HAS_ANNOTATION', 'DEPENDS_ON'] THEN null
               ELSE {
               type: type(incoming), stableId: actor.stableId, labels: labels(actor),
               ownerFnStableId: actor.parentFnStableId, operationIndex: actor.operation_index
             } END) AS incomingItems,
             collect(DISTINCT CASE
               WHEN dependent IS NULL OR type(outgoing) IN ['HAS_ANNOTATION', 'DEPENDS_ON'] THEN null
               ELSE {
               type: type(outgoing), stableId: dependent.stableId, labels: labels(dependent)
             } END) AS outgoingItems
        RETURN {
          stableId: storage.stableId,
          labels: labels(storage),
          name: coalesce(storage.resource_name, storage.setting_name, storage.label),
          resourceKind: storage.resource_kind,
          resourceSubkind: storage.resource_subkind,
          parentStableId: storage.parentStableId,
          affectorsAndReaders: [item IN incomingItems WHERE item IS NOT NULL],
          dependents: [item IN outgoingItems WHERE item IS NOT NULL]
        } AS context
      `, { stableId });
    },
    async dependencies() {
      return [];
    },
  },
  ExternalComponent: {
    id: 'external-component',
    version: PROFILE_VERSION,
    async context(session, stableId) {
      return runSingle(session, `
        MATCH (component {stableId: $stableId})
        OPTIONAL MATCH (actor)-[incoming]->(component)
        WITH component, collect(DISTINCT CASE WHEN actor IS NULL THEN null ELSE {
          type: type(incoming), stableId: actor.stableId, labels: labels(actor),
          ownerFnStableId: actor.parentFnStableId, operationIndex: actor.operation_index
        } END) AS interactions
        RETURN {
          stableId: component.stableId,
          labels: labels(component),
          name: coalesce(component.resource_name, component.label),
          resourceKind: component.resource_kind,
          resourceSubkind: component.resource_subkind,
          interactions: [item IN interactions WHERE item IS NOT NULL]
        } AS context
      `, { stableId });
    },
    async dependencies(_session, _stableId, _options = {}) {
      return [];
    },
  },
  Module: {
    id: 'module',
    version: PROFILE_VERSION,
    async context(session, stableId) {
      return runSingle(session, `
        MATCH (module {stableId: $stableId})
        WHERE module:File OR module:Package
        CALL (module) {
          OPTIONAL MATCH (callable:Fn)-[:DECLARED_IN]->(module)
          RETURN collect(DISTINCT CASE WHEN callable IS NULL THEN null ELSE {
            stableId: callable.stableId, name: callable.name,
            range: {startLine: callable.start_line, endLine: callable.end_line}
          } END) AS declaredCallables
        }
        CALL (module) {
          OPTIONAL MATCH (module)-[relation]->(dependency)
          WHERE type(relation) IN ['IMPORTS_FILE', 'IMPORTS_PACKAGE']
          RETURN collect(DISTINCT CASE WHEN dependency IS NULL THEN null ELSE {
            relation: type(relation), stableId: dependency.stableId,
            labels: labels(dependency), name: coalesce(dependency.name, dependency.path, dependency.label)
          } END) AS imports
        }
        RETURN {
          stableId: module.stableId,
          labels: labels(module),
          name: coalesce(module.name, module.path, module.label),
          repoRelativePath: coalesce(module.repo_relative_path, module.relative_path, module.path),
          declaredCallables: [item IN declaredCallables WHERE item IS NOT NULL],
          imports: [item IN imports WHERE item IS NOT NULL]
        } AS context
      `, { stableId });
    },
    async dependencies() {
      return [];
    },
  },
  ValueUse: {
    id: 'value-use',
    version: PROFILE_VERSION + 4,
    // The point-specific context already resolves the accessed binding and its
    // relevant writes. Generic syntax composition belongs to rendering and
    // otherwise turns one comparison into the complete provenance trees of
    // every operand.
    compositionContext: false,
    async context(session, stableId) {
      return runSingle(session, `
        MATCH (access:ValueAccess {stableId: $stableId})
        OPTIONAL MATCH (directBinding:ValueSlot {stableId: access.value_slot_stableId})
        CALL (access) {
          OPTIONAL MATCH (access)-[valueRelation:READS_VALUE|WRITES_VALUE|CLEARS_VALUE|DELETES_VALUE|CREATES_VALUE|RECEIVES_VALUE]->(linkedBinding:ValueSlot)
          WITH linkedBinding, valueRelation
          ORDER BY linkedBinding.operation_index, linkedBinding.stableId
          RETURN head([item IN collect(linkedBinding) WHERE item IS NOT NULL]) AS linkedBinding
        }
        WITH access, coalesce(directBinding, linkedBinding) AS binding
        CALL (access) {
          OPTIONAL MATCH (source)-[incoming]->(access)
          RETURN collect(DISTINCT CASE WHEN source IS NULL THEN null ELSE {
            relation: type(incoming), stableId: source.stableId,
            labels: labels(source), syntax: coalesce(source.condition_raw, source.operation_subject_text, source.action_text_raw)
          } END) AS incomingItems
        }
        CALL (access) {
          OPTIONAL MATCH (access)-[outgoing]->(target)
          WHERE NOT target:Annotation AND type(outgoing) <> 'HAS_ANNOTATION'
          RETURN collect(DISTINCT CASE WHEN target IS NULL THEN null ELSE {
            relation: type(outgoing), stableId: target.stableId,
            labels: labels(target), syntax: coalesce(target.condition_raw, target.operation_subject_text, target.action_text_raw)
          } END) AS outgoingItems
        }
        CALL (access) {
          OPTIONAL MATCH (access)-[usage:USES_REFERENCE|USES_MEMBER_REFERENCE]->(reference)-[:RESOLVES_TO]->(declaration:Declaration)
          RETURN collect(DISTINCT CASE WHEN declaration IS NULL THEN null ELSE {
            usage: type(usage),
            referenceStableId: reference.stableId,
            referenceLabels: labels(reference),
            stableId: declaration.stableId,
            labels: labels(declaration),
            name: declaration.name,
            syntax: coalesce(declaration.syntax, declaration.action_text_raw)
          } END) AS resolvedReferences
        }
        CALL (access) {
          OPTIONAL MATCH (access)-[:USES_REFERENCE]->(requestReference)-[:RESOLVES_TO]->(declaration:Declaration)
          OPTIONAL MATCH (directWrite:RefWrite)-[:WRITES_TO]->(directReference)-[:RESOLVES_TO]->(declaration)
          OPTIONAL MATCH (directOwner:FunctionImplementation)-[:AST_CHILD]->(directWrite)
          CALL (directOwner) {
            OPTIONAL MATCH (directOwner)-[:NEXT]->(guard:Branch)
            RETURN collect(DISTINCT CASE WHEN guard IS NULL THEN null ELSE {
              stableId: guard.stableId,
              condition: coalesce(guard.condition_raw, guard.operation_subject_text, guard.syntax, guard.action_text_raw)
            } END) AS ownerGuards
          }
          CALL (directOwner) {
            OPTIONAL MATCH (directOwner)-[callRelation:CALL|CALLS]->(called)
            RETURN collect(DISTINCT CASE WHEN called IS NULL THEN null ELSE {
              stableId: called.stableId,
              relation: type(callRelation),
              labels: labels(called),
              name: coalesce(called.label, called.name),
              syntax: CASE WHEN size(coalesce(called.syntax, '')) <= 240 THEN called.syntax ELSE null END
            } END) AS ownerCalls
          }
          RETURN collect(DISTINCT CASE WHEN directWrite IS NULL
            OR directWrite.stableId = access.stableId
            OR (coalesce(directWrite.repoRelativePath, directWrite.repo_relative_path) = coalesce(access.repoRelativePath, access.repo_relative_path)
              AND coalesce(directWrite.startLine, directWrite.start_line) = coalesce(access.startLine, access.start_line)
              AND coalesce(directWrite.startColumn, directWrite.start_column) = coalesce(access.startColumn, access.start_column)
              AND coalesce(directWrite.endLine, directWrite.end_line) = coalesce(access.endLine, access.end_line))
            THEN null ELSE {
            stableId: directWrite.stableId,
            kind: 'direct-write',
            labels: labels(directWrite),
            syntax: coalesce(directWrite.action_text_raw, directWrite.syntax, directWrite.operation_subject_text),
            operationIndex: directWrite.operation_index,
            ownerFnStableId: directOwner.stableId,
            ownerName: coalesce(directOwner.label, directOwner.name),
            ownerGuards: [guard IN ownerGuards WHERE guard IS NOT NULL],
            ownerCalls: [call IN ownerCalls WHERE call IS NOT NULL]
          } END) AS directWrites
        }
        CALL (access) {
          OPTIONAL MATCH (access)-[:USES_REFERENCE]->(requestReference)-[:RESOLVES_TO]->(declaration:Declaration)
          OPTIONAL MATCH (actualArgument:ArgumentValue)-[:RESOLVES_TO]->(declaration)
          OPTIONAL MATCH (actualArgument)-[binding:BINDS_TO_PARAMETER]->(forwardedParameter:Parameter)
          WHERE binding.resolution = 'typescript-checker-rest-callback-forwarding'
          OPTIONAL MATCH (forwardedWrite:RefWrite)-[:WRITES_TO]->(forwardedReference)-[:RESOLVES_TO]->(forwardedParameter)
          OPTIONAL MATCH (forwardedOwner:FunctionImplementation)-[:AST_CHILD]->(forwardedWrite)
          CALL (forwardedOwner) {
            OPTIONAL MATCH (forwardedOwner)-[:NEXT]->(guard:Branch)
            RETURN collect(DISTINCT CASE WHEN guard IS NULL THEN null ELSE {
              stableId: guard.stableId,
              condition: coalesce(guard.condition_raw, guard.operation_subject_text, guard.syntax, guard.action_text_raw)
            } END) AS ownerGuards
          }
          CALL (forwardedOwner) {
            OPTIONAL MATCH (forwardedOwner)-[callRelation:CALL|CALLS]->(called)
            RETURN collect(DISTINCT CASE WHEN called IS NULL THEN null ELSE {
              stableId: called.stableId,
              relation: type(callRelation),
              labels: labels(called),
              name: coalesce(called.label, called.name),
              syntax: CASE WHEN size(coalesce(called.syntax, '')) <= 240 THEN called.syntax ELSE null END
            } END) AS ownerCalls
          }
          RETURN collect(DISTINCT CASE WHEN forwardedWrite IS NULL THEN null ELSE {
            stableId: forwardedWrite.stableId,
            kind: 'forwarded-write',
            labels: labels(forwardedWrite),
            syntax: coalesce(forwardedWrite.action_text_raw, forwardedWrite.syntax, forwardedWrite.operation_subject_text),
            operationIndex: forwardedWrite.operation_index,
            ownerFnStableId: forwardedOwner.stableId,
            ownerName: coalesce(forwardedOwner.label, forwardedOwner.name),
            ownerGuards: [guard IN ownerGuards WHERE guard IS NOT NULL],
            ownerCalls: [call IN ownerCalls WHERE call IS NOT NULL],
            viaArgumentStableId: actualArgument.stableId,
            viaParameterStableId: forwardedParameter.stableId,
            viaParameterName: forwardedParameter.name
          } END) AS forwardedWrites
        }
        RETURN {
          stableId: access.stableId,
          labels: labels(access),
          syntax: coalesce(access.condition_raw, access.operation_subject_text, access.action_text_raw),
          subjectText: access.operation_subject_text,
          condition: access.condition_raw,
          operationCode: access.operation_code,
          valueName: access.value_name,
          valueScope: access.value_scope,
          valueAction: access.value_action,
          flowLaneRole: access.flowLaneRole,
          ownerFnStableId: access.parentFnStableId,
          ownerStepStableId: access.parentStepStableId,
          origin: CASE WHEN binding IS NULL THEN null ELSE {
            stableId: binding.stableId,
            labels: labels(binding),
            name: coalesce(binding.value_name, binding.label),
            declarationKind: binding.variable_declaration_kind,
            syntax: coalesce(binding.value_operation_syntax, binding.action_text_raw),
            initializer: binding.operation_value_text,
            valueScope: binding.value_scope
          } END,
          lifecycle: [item IN directWrites + forwardedWrites WHERE item IS NOT NULL],
          resolvedReferences: [item IN resolvedReferences WHERE item IS NOT NULL],
          incoming: [item IN incomingItems WHERE item IS NOT NULL],
          outgoing: [item IN outgoingItems WHERE item IS NOT NULL]
        } AS context
      `, { stableId });
    },
    async dependencies(session, stableId) {
      const row = await runSingle(session, `
        MATCH (access:ValueAccess {stableId: $stableId})
        OPTIONAL MATCH (directSlot:ValueSlot {stableId: access.value_slot_stableId})
        OPTIONAL MATCH (access)-[:READS_VALUE|WRITES_VALUE|CLEARS_VALUE|DELETES_VALUE|CREATES_VALUE|RECEIVES_VALUE]->(linkedSlot:ValueSlot)
        WITH access, [slot IN collect(DISTINCT coalesce(directSlot, linkedSlot))
          WHERE slot IS NOT NULL AND NOT slot:ParameterBinding] AS localSlots
        RETURN [localSlot IN localSlots | {
          stableId: localSlot.stableId,
          annotationKind: 'Binding',
          role: 'value-origin',
          recurse: true,
          ordinal: coalesce(localSlot.operation_index, access.operation_index, 0)
        }] AS dependencies
      `, { stableId });
      return (row?.dependencies || []).filter(Boolean);
    },
  },
};

export function getAnnotationProfile(annotationKind) {
  return PROFILES[annotationKind] || null;
}

export async function resolveAnnotationSubjects(session, requestedStableIds, annotationKinds = new Map()) {
  const primaryLabels = {
    Projection: 'Call',
    SelectedMember: 'MemberDeclaration',
    FunctionalEntity: 'DeveloperDefined',
    Callable: 'Fn|FnDeclaration',
    Step: 'Step',
    FlowBlock: 'Block',
    Loop: 'Loop',
    ExecutionPrimitive: 'Primitive',
    Binding: 'ValueSlot',
    ValueUse: 'ValueAccess',
    CallSite: 'Request|Op|Call',
    AsyncFlow: 'Request|Op|Call',
    UiSurface: 'UiSurface',
    StorageCell: 'Storage',
    ExternalComponent: 'External',
  };
  const requested = [...new Set(requestedStableIds)].map((stableId) => ({
    stableId,
    primaryLabel: primaryLabels[annotationKinds.get(stableId)] || null,
  }));
  const rows = [];
  const hinted = requested.filter((item) => item.primaryLabel);
  const unhinted = requested.filter((item) => !item.primaryLabel);
  if (hinted.length) {
    const byLabel = new Map();
    for (const item of hinted) byLabel.set(item.primaryLabel, [...(byLabel.get(item.primaryLabel) || []), item.stableId]);
    for (const [primaryLabel, stableIds] of byLabel) {
      if (!primaryLabel.split('|').every((label) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(label))) {
        throw new Error(`Invalid annotation subject label: ${primaryLabel}`);
      }
      const result = await session.run(`
        UNWIND $stableIds AS stableId
        MATCH (requested:${primaryLabel} {stableId: stableId})
        OPTIONAL MATCH (requested)-[:PROXY_OF]->(proxyTarget)
        OPTIONAL MATCH (canonicalFn:Fn {stableId: requested.canonicalStableId})
        OPTIONAL MATCH (canonicalStep:Step {stableId: requested.canonicalStableId})
        OPTIONAL MATCH (canonicalBlock:Block {stableId: requested.canonicalStableId})
        OPTIONAL MATCH (canonicalPrimitive:Primitive {stableId: requested.canonicalStableId})
        OPTIONAL MATCH (canonicalBinding:ValueSlot {stableId: requested.canonicalStableId})
        OPTIONAL MATCH (canonicalAccess:ValueAccess {stableId: requested.canonicalStableId})
        OPTIONAL MATCH (canonicalStorage:Storage {stableId: requested.canonicalStableId})
        OPTIONAL MATCH (canonicalExternal:External {stableId: requested.canonicalStableId})
        OPTIONAL MATCH (canonicalFile:File {stableId: requested.canonicalStableId})
        OPTIONAL MATCH (canonicalPackage:Package {stableId: requested.canonicalStableId})
        OPTIONAL MATCH (canonicalSurface:UiSurface {stableId: requested.canonicalStableId})
        OPTIONAL MATCH (valueSlot:ValueSlot {stableId: requested.value_slot_stableId})
        OPTIONAL MATCH (declaredFn:Fn {stableId: requested.calleeStableId})
        WITH requested,
             CASE WHEN requested:FnDeclaration
               THEN requested
               ELSE coalesce(
                 proxyTarget, canonicalFn, canonicalStep, canonicalBlock, canonicalPrimitive,
                 canonicalBinding, canonicalAccess, canonicalStorage, canonicalExternal,
                 canonicalFile, canonicalPackage, canonicalSurface,
                 CASE WHEN requested:AnnotationProxy THEN valueSlot ELSE null END,
                 requested
               )
             END AS subject
        RETURN requested.stableId AS requestedStableId,
               subject.stableId AS stableId,
               labels(subject) AS labels,
               subject.annotationKind AS annotationKind,
               subject.label AS label,
               subject.name AS name,
               requested.diaName AS requestedDiaName,
               requested.action_text_raw AS requestedActionText,
               requested.operation_index AS requestedOperationIndex,
               requested.parameterTypeText AS requestedTypeText,
               EXISTS { MATCH (subject)-[:CALL|REQUEST|INVOKES]->(:Fn) } AS subjectHasInvocation,
               requested:FnDeclaration AS requestedIsFnDeclaration
      `, { stableIds });
      rows.push(...result.records);
    }
  }
  if (unhinted.length) {
    const result = await session.run(`
    UNWIND $items AS item
    MATCH (requested {stableId: item.stableId})
    OPTIONAL MATCH (requested)-[:PROXY_OF]->(proxyTarget)
    OPTIONAL MATCH (canonicalFn:Fn {stableId: requested.canonicalStableId})
    OPTIONAL MATCH (canonicalStep:Step {stableId: requested.canonicalStableId})
    OPTIONAL MATCH (canonicalBlock:Block {stableId: requested.canonicalStableId})
    OPTIONAL MATCH (canonicalPrimitive:Primitive {stableId: requested.canonicalStableId})
    OPTIONAL MATCH (canonicalBinding:ValueSlot {stableId: requested.canonicalStableId})
    OPTIONAL MATCH (canonicalAccess:ValueAccess {stableId: requested.canonicalStableId})
    OPTIONAL MATCH (canonicalStorage:Storage {stableId: requested.canonicalStableId})
    OPTIONAL MATCH (canonicalExternal:External {stableId: requested.canonicalStableId})
    OPTIONAL MATCH (canonicalFile:File {stableId: requested.canonicalStableId})
    OPTIONAL MATCH (canonicalPackage:Package {stableId: requested.canonicalStableId})
    OPTIONAL MATCH (canonicalSurface:UiSurface {stableId: requested.canonicalStableId})
    OPTIONAL MATCH (valueSlot:ValueSlot {stableId: requested.value_slot_stableId})
    OPTIONAL MATCH (declaredFn:Fn {stableId: requested.calleeStableId})
    WITH requested,
         CASE WHEN requested:FnDeclaration
           THEN requested
           ELSE coalesce(
             proxyTarget, canonicalFn, canonicalStep, canonicalBlock, canonicalPrimitive,
             canonicalBinding, canonicalAccess, canonicalStorage, canonicalExternal,
             canonicalFile, canonicalPackage, canonicalSurface,
             CASE WHEN requested:AnnotationProxy THEN valueSlot ELSE null END,
             requested
           )
         END AS subject
    RETURN requested.stableId AS requestedStableId,
           subject.stableId AS stableId,
           labels(subject) AS labels,
           subject.annotationKind AS annotationKind,
           subject.label AS label,
           subject.name AS name,
           requested.diaName AS requestedDiaName,
           requested.action_text_raw AS requestedActionText,
           requested.operation_index AS requestedOperationIndex,
           requested.parameterTypeText AS requestedTypeText,
           EXISTS { MATCH (subject)-[:CALL|REQUEST|INVOKES]->(:Fn) } AS subjectHasInvocation,
           requested:FnDeclaration AS requestedIsFnDeclaration
  `, { items: unhinted });
    rows.push(...result.records);
  }
  return new Map(rows.map((record) => {
    const row = normalizeNeo4jValue(record.toObject());
    return [row.requestedStableId, {
      ...row,
      annotationKind: ['Projection', 'SelectedMember'].includes(annotationKinds.get(row.requestedStableId))
        ? annotationKinds.get(row.requestedStableId)
        : row.requestedIsFnDeclaration
        ? 'Callable'
        : row.subjectHasInvocation
          && !row.labels.includes('Fn')
          && !row.labels.includes('FnDeclaration')
          ? 'CallSite'
        : inferAnnotationKind(
            row.labels,
            row.requestedStableId !== row.stableId
              ? row.annotationKind
              : annotationKinds.get(row.requestedStableId) || row.annotationKind,
          ),
      requestPoint: {
        stableId: row.requestedStableId,
        diaName: row.requestedDiaName,
        actionText: row.requestedActionText,
        operationIndex: row.requestedOperationIndex,
        typeText: row.requestedTypeText,
      },
    }];
  }));
}

export const annotationProfileContract = Object.freeze(Object.fromEntries(
  Object.entries(PROFILES).map(([annotationKind, profile]) => [annotationKind, {
    id: profile.id,
    version: profile.version,
  }]),
));
