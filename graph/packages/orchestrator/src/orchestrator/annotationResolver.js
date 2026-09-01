import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import neo4j from 'neo4j-driver';

import {
  getAnnotationProfile,
  loadCompositionContextDependenciesMany,
  resolveAnnotationSubjects,
} from './annotationProfiles.js';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function integer(value) {
  if (neo4j.isInt(value)) return value.toNumber();
  return Number(value || 0);
}

export function normalizeAnnotationRefreshMode({ refreshMode, refresh, overwrite } = {}) {
  const requested = refreshMode ?? refresh ?? overwrite ?? 'reuse';
  if (requested === false || requested === null || requested === undefined || requested === 'reuse') {
    return 'reuse';
  }
  if (requested === true || requested === 'root' || requested === 'overwrite') return 'root';
  if (requested === 'subtree' || requested === 'all') return 'subtree';
  throw new Error(`Unsupported annotation refresh mode: ${String(requested)}.`);
}

export function shouldRefreshAnnotation(refreshMode, depth) {
  return refreshMode === 'subtree' || (refreshMode === 'root' && depth === 0);
}

const PARAMETER_SYNTHESIS_CONTRACT_VERSION = 1;
const FUNCTIONAL_ACCUMULATION_CONTRACT_VERSION = 2;
const FUNCTIONAL_ACCUMULATION_MAX_DEPTH = 32;
const TOOL_GIT_COMMIT_SHORT_HASH = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
})();

export function getAnnotationToolMetadata({ maxDepth } = {}) {
  const hasDepth = maxDepth !== null && maxDepth !== undefined && maxDepth !== '';
  const numericDepth = hasDepth ? Number(maxDepth) : Number.NaN;
  return {
    toolGitCommitShortHash: TOOL_GIT_COMMIT_SHORT_HASH,
    maxDepth: Number.isFinite(numericDepth)
      ? Math.max(0, Math.min(8, Math.trunc(numericDepth)))
      : null,
  };
}

export function validateAnnotationTextEncoding(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('annotationId and text are required.');
  const questionMarkCount = [...text].filter((character) => character === '?').length;
  const hasQuestionMarkReplacement = text.length >= 12 && questionMarkCount / text.length >= 0.2;
  const hasUtf8DecodedAsSingleByteText = /(?:Р.|С.){4,}/u.test(text);
  if (text.includes('\uFFFD') || hasQuestionMarkReplacement || hasUtf8DecodedAsSingleByteText) {
    throw new Error('Annotation text has invalid character encoding. Send JSON as UTF-8 without replacement characters.');
  }
  return text;
}

function isParameterBinding(item) {
  return item?.annotationKind === 'Binding'
    && (item.context?.scope === 'parameter'
      || item.labels?.includes('ParameterBinding')
      || item.context?.labels?.includes('ParameterBinding'));
}

function isFunctionalEntity(item) {
  return item?.annotationKind === 'FunctionalEntity'
    || item?.labels?.includes('DeveloperDefined');
}

function isFunctionalParameter(item) {
  return isFunctionalEntity(item) && item?.labels?.includes('Parameter');
}

function annotationContractFingerprint(item) {
  if (isFunctionalEntity(item)) {
    return { functionalAccumulationContractVersion: FUNCTIONAL_ACCUMULATION_CONTRACT_VERSION };
  }
  return isParameterBinding(item)
    ? { parameterSynthesisContractVersion: PARAMETER_SYNTHESIS_CONTRACT_VERSION }
    : {};
}

async function ensureAnnotationSchema(session) {
  await session.run('CREATE CONSTRAINT annotation_id IF NOT EXISTS FOR (annotation:Annotation) REQUIRE annotation.annotationId IS UNIQUE');
  await session.run('CREATE CONSTRAINT annotation_job_id IF NOT EXISTS FOR (job:AnnotationJob) REQUIRE job.jobId IS UNIQUE');
  await session.run('CREATE CONSTRAINT annotation_task_id IF NOT EXISTS FOR (task:AnnotationTask) REQUIRE task.taskId IS UNIQUE');
  await session.run('CREATE INDEX annotation_head_id IF NOT EXISTS FOR (annotation:Annotation) ON (annotation.headID)');
  await session.run('CREATE INDEX annotation_fn_stable_id IF NOT EXISTS FOR (subject:Fn) ON (subject.stableId)');
  await session.run('CREATE INDEX annotation_step_stable_id IF NOT EXISTS FOR (subject:Step) ON (subject.stableId)');
  await session.run('CREATE INDEX annotation_block_stable_id IF NOT EXISTS FOR (subject:Block) ON (subject.stableId)');
  await session.run('CREATE INDEX annotation_primitive_stable_id IF NOT EXISTS FOR (subject:Primitive) ON (subject.stableId)');
  await session.run('CREATE INDEX annotation_primitive_parent_step IF NOT EXISTS FOR (subject:Primitive) ON (subject.parentStepStableId)');
  await session.run('CREATE INDEX annotation_value_slot_stable_id IF NOT EXISTS FOR (subject:ValueSlot) ON (subject.stableId)');
  await session.run('CREATE INDEX annotation_value_slot_parent_step IF NOT EXISTS FOR (subject:ValueSlot) ON (subject.parentStepStableId)');
  await session.run('CREATE INDEX annotation_value_access_stable_id IF NOT EXISTS FOR (subject:ValueAccess) ON (subject.stableId)');
  await session.run('CREATE INDEX annotation_request_parent_step IF NOT EXISTS FOR (subject:Request) ON (subject.parentStepStableId)');
  await session.run('CREATE INDEX annotation_op_parent_step IF NOT EXISTS FOR (subject:Op) ON (subject.parentStepStableId)');
  await session.run('CREATE INDEX annotation_call_parent_step IF NOT EXISTS FOR (subject:Call) ON (subject.parentStepStableId)');
  await session.run('CREATE INDEX annotation_request_stable_id IF NOT EXISTS FOR (subject:Request) ON (subject.stableId)');
  await session.run('CREATE INDEX annotation_op_stable_id IF NOT EXISTS FOR (subject:Op) ON (subject.stableId)');
  await session.run('CREATE INDEX annotation_call_stable_id IF NOT EXISTS FOR (subject:Call) ON (subject.stableId)');
  await session.run('CREATE INDEX annotation_capture_owner IF NOT EXISTS FOR (subject:CapturedBinding) ON (subject.parentFnStableId)');
  await session.run('CREATE INDEX annotation_file_stable_id IF NOT EXISTS FOR (subject:File) ON (subject.stableId)');
  await session.run('CREATE INDEX annotation_package_stable_id IF NOT EXISTS FOR (subject:Package) ON (subject.stableId)');
  await session.run('CREATE INDEX annotation_developer_stable_id IF NOT EXISTS FOR (subject:DeveloperDefined) ON (subject.stableId)');
}

async function loadAnnotations(session, annotationIds) {
  if (!annotationIds.length) return new Map();
  const result = await session.run(`
    UNWIND $annotationIds AS annotationId
    OPTIONAL MATCH (annotation:Annotation {annotationId: annotationId})
    RETURN annotationId, annotation.text AS text, annotation.status AS status,
           annotation.updatedAt AS updatedAt, annotation.source AS source,
           annotation.toolGitCommitShortHash AS toolGitCommitShortHash,
           annotation.maxDepth AS maxDepth
  `, { annotationIds });
  return new Map(result.records.map((record) => [record.get('annotationId'), {
    text: record.get('text') || '',
    status: record.get('status') || 'pending',
    updatedAt: record.get('updatedAt') || null,
    source: record.get('source') || null,
    toolGitCommitShortHash: record.get('toolGitCommitShortHash') || null,
    maxDepth: record.get('maxDepth') === null ? null : integer(record.get('maxDepth')),
  }]));
}

async function persistPendingAnnotations(session, items) {
  if (!items.length) return;
  await session.run(`
    UNWIND $items AS item
    MATCH (subject:$(item.subjectLabel) {stableId: item.stableId})
    MERGE (annotation:Annotation {annotationId: item.annotationId})
    ON CREATE SET annotation.status = 'pending', annotation.createdAt = $now
    SET annotation.status = CASE WHEN item.refreshRequested THEN 'pending' ELSE annotation.status END,
        annotation.refreshRequestedAt = CASE WHEN item.refreshRequested THEN $now ELSE annotation.refreshRequestedAt END,
        annotation.headID = item.stableId,
        annotation.annotationKind = item.annotationKind,
        annotation.profileId = item.profileId,
        annotation.profileVersion = item.profileVersion,
        annotation.maxDepth = item.maxDepth,
        annotation.contextFingerprint = item.contextFingerprint,
        annotation.contextJson = item.contextJson,
        annotation.referenceDependenciesJson = item.referenceDependenciesJson,
        annotation.labelsJson = item.labelsJson,
        annotation.updatedAt = coalesce(annotation.updatedAt, $now)
    MERGE (subject)-[:HAS_ANNOTATION]->(annotation)
    WITH subject, annotation, item
    OPTIONAL MATCH (subject)-[:HAS_ANNOTATION]->(previous:Annotation)
    WHERE previous.profileId = item.profileId
      AND previous.annotationId <> annotation.annotationId
      AND previous.status = 'ready'
    SET previous.status = 'stale', previous.staleAt = $now
  `, { items, now: new Date().toISOString() });
}

async function persistDependencies(session, dependencies) {
  if (!dependencies.length) return;
  await session.run(`
    UNWIND $dependencies AS dependency
    MATCH (parent:Annotation {annotationId: dependency.parentAnnotationId})
    MATCH (child:Annotation {annotationId: dependency.childAnnotationId})
    MERGE (parent)-[relation:DEPENDS_ON]->(child)
    SET relation.role = dependency.role,
        relation.ordinal = dependency.ordinal,
        relation.dependencyKind = dependency.dependencyKind
  `, { dependencies });
}

export async function resolveAnnotation(driver, database, {
  stableId,
  maxDepth = 3,
  atStableId,
  atOperationIndex,
  persist = true,
  refreshMode,
  refresh,
  overwrite,
  onTiming,
} = {}) {
  const requestedStableId = String(stableId || '').trim();
  if (!requestedStableId) throw new Error('stableId is required.');
  const requestedDepth = Number(maxDepth);
  const depthLimit = Math.max(0, Math.min(8, Number.isFinite(requestedDepth) ? requestedDepth : 3));
  const resolvedRefreshMode = normalizeAnnotationRefreshMode({ refreshMode, refresh, overwrite });
  const session = driver.session({ database });
  const generationOrder = [];
  const memo = new Map();
  const visiting = new Set();
  const timings = [];
  const startedAt = performance.now();

  async function timed(phase, details, operation) {
    const started = performance.now();
    try {
      return await operation();
    } finally {
      const timing = { phase, ...details, milliseconds: Math.round(performance.now() - started) };
      timings.push(timing);
      onTiming?.(timing);
    }
  }

  try {
    if (persist) await timed('ensure-schema', {}, () => ensureAnnotationSchema(session));
    let resolvedAtOperationIndex = Number.isFinite(Number(atOperationIndex)) ? Number(atOperationIndex) : null;
    if (resolvedAtOperationIndex === null && atStableId) {
      const pointResult = await timed('resolve-request-point', {}, () => session.run(`
        MATCH (point {stableId: $atStableId})
        RETURN point.operation_index AS operationIndex
        LIMIT 1
      `, { atStableId: String(atStableId) }));
      const pointValue = pointResult.records[0]?.get('operationIndex');
      resolvedAtOperationIndex = pointValue === null || pointValue === undefined ? null : integer(pointValue);
    }
    const profileOptions = { atOperationIndex: resolvedAtOperationIndex };

    async function loadReferenceItems(dependencies, depth) {
      if (!dependencies.length) return new Map();
      const stableIds = [...new Set(dependencies.map((dependency) => dependency.stableId))];
      const annotationKinds = new Map(dependencies.map((dependency) => [dependency.stableId, dependency.annotationKind]));
      const subjectsByRequestedId = await timed('resolve-reference-subjects', { depth, count: stableIds.length },
        () => resolveAnnotationSubjects(session, stableIds, annotationKinds));
      const grouped = new Map();
      for (const requestedId of stableIds) {
        const subject = subjectsByRequestedId.get(requestedId);
        if (!subject) continue;
        const profile = getAnnotationProfile(subject.annotationKind);
        if (!profile) continue;
        const group = grouped.get(profile.id) || { profile, subjects: [] };
        group.subjects.push(subject);
        grouped.set(profile.id, group);
      }
      const references = new Map();
      for (const { profile, subjects } of grouped.values()) {
        const profileStableIds = [...new Set(subjects.map((subject) => subject.stableId))];
        const contexts = profile.contextMany
          ? await timed('load-reference-contexts', { depth, profileId: profile.id, count: profileStableIds.length },
            () => profile.contextMany(session, profileStableIds, profileOptions))
          : new Map();
        if (!profile.contextMany) {
          for (const id of profileStableIds) {
            const row = await timed('load-reference-context', { depth, profileId: profile.id, count: 1 },
              () => profile.context(session, id, profileOptions));
            contexts.set(id, row?.context || row);
          }
        }
        for (const subject of subjects) {
          references.set(subject.requestedStableId, {
            stableId: subject.stableId,
            annotationKind: subject.annotationKind,
            labels: subject.labels,
            status: 'reference',
            referenceOnly: true,
            context: contexts.get(subject.stableId) || null,
          });
        }
      }
      return references;
    }

    async function visitMany(stableIds, depth, annotationKinds = new Map()) {
      const unresolvedIds = [...new Set(stableIds)].filter((id) => !memo.has(id) && !visiting.has(id));
      if (!unresolvedIds.length) return;
      const subjectsByRequestedId = await timed('resolve-subjects', { depth, count: unresolvedIds.length },
        () => resolveAnnotationSubjects(session, unresolvedIds, annotationKinds));
      const resolvedSubjects = unresolvedIds.map((id) => {
        const subject = subjectsByRequestedId.get(id);
        if (!subject) throw new Error(`Annotation subject not found: ${id}`);
        return subject;
      });
      const subjects = [];
      for (const subject of resolvedSubjects) {
        if (subject.annotationKind === null) {
          const reference = {
            stableId: subject.stableId,
            annotationKind: null,
            labels: subject.labels,
            status: 'reference',
            referenceOnly: true,
          };
          memo.set(subject.requestedStableId, reference);
          memo.set(subject.stableId, reference);
          continue;
        }
        subjects.push(subject);
      }
      const grouped = new Map();
      for (const subject of subjects) {
        const profile = getAnnotationProfile(subject.annotationKind);
        if (!profile) throw new Error(`No annotation profile for ${subject.stableId}: ${subject.annotationKind || subject.labels.join(',')}`);
        const group = grouped.get(profile.id) || { profile, subjects: [] };
        group.subjects.push(subject);
        grouped.set(profile.id, group);
      }

      const prepared = [];
      subjects.forEach((subject) => {
        visiting.add(subject.requestedStableId);
        visiting.add(subject.stableId);
      });
      for (const { profile, subjects: profileSubjects } of grouped.values()) {
        const profileStableIds = [...new Set(profileSubjects.map((subject) => subject.stableId))];
        const contexts = profile.contextMany
          ? await timed('load-contexts', { depth, profileId: profile.id, count: profileStableIds.length },
            () => profile.contextMany(session, profileStableIds, profileOptions))
          : new Map();
        if (!profile.contextMany) {
          for (const id of profileStableIds) {
            const row = await timed('load-context', { depth, profileId: profile.id, count: 1 },
              () => profile.context(session, id, profileOptions));
            contexts.set(id, row?.context || row);
          }
        }
        const dependencyMap = profile.dependenciesMany
          ? await timed('load-dependencies', { depth, profileId: profile.id, count: profileStableIds.length },
            () => profile.dependenciesMany(session, profileStableIds, profileOptions))
          : new Map();
        if (!profile.dependenciesMany) {
          for (const id of profileStableIds) {
            dependencyMap.set(id, await timed('load-dependency', { depth, profileId: profile.id, count: 1 },
              () => profile.dependencies(session, id, profileOptions)));
          }
        }
        const compositionDependencyMap = profile.compositionContext
          ? await timed(
            'load-composition-dependencies',
            { depth, profileId: profile.id, count: profileStableIds.length },
            () => loadCompositionContextDependenciesMany(session, profileStableIds),
          )
          : new Map();
        for (const subject of profileSubjects) {
          const requestPointContext = profile.id === 'callable-summary'
            ? {}
            : { requestPoint: subject.requestPoint };
          prepared.push({
            subject,
            profile,
            context: {
              ...(contexts.get(subject.stableId) || {}),
              ...requestPointContext,
            },
            dependencies: [
              ...(dependencyMap.get(subject.stableId) || []),
              ...(compositionDependencyMap.get(subject.stableId) || []),
            ]
              .filter((dependency, index, dependencies) => (
                dependency.stableId !== subject.stableId
                && dependencies.findIndex((candidate) => candidate.stableId === dependency.stableId) === index
              ))
              .sort((left, right) => integer(left.ordinal) - integer(right.ordinal) || String(left.stableId).localeCompare(String(right.stableId))),
          });
        }
      }

      const shouldRecurse = (entry, dependency) => dependency.recurse && (
        entry.profile.accumulateToSystemBoundary
          ? depth < FUNCTIONAL_ACCUMULATION_MAX_DEPTH
          : depth < depthLimit
      );
      const recursiveDependencies = prepared.flatMap((entry) => entry.dependencies
        .filter((dependency) => shouldRecurse(entry, dependency)));
      if (recursiveDependencies.length) {
        await visitMany(
          recursiveDependencies.map((dependency) => dependency.stableId),
          depth + 1,
          new Map(recursiveDependencies.map((dependency) => [dependency.stableId, dependency.annotationKind])),
        );
      }
      const boundaryDependencies = prepared.flatMap((entry) => entry.dependencies
        .filter((dependency) => dependency.recurse && !shouldRecurse(entry, dependency)));
      const boundaryReferences = await loadReferenceItems(boundaryDependencies, depth + 1);

      const pendingRows = [];
      for (const entry of prepared) {
        const childItems = entry.dependencies.map((dependency) => {
          const child = shouldRecurse(entry, dependency) ? memo.get(dependency.stableId) : null;
          return {
            ...(child || boundaryReferences.get(dependency.stableId) || {
              stableId: dependency.stableId,
              annotationKind: dependency.annotationKind,
              status: 'reference',
              referenceOnly: true,
            }),
            role: dependency.role,
            dependencyKind: dependency.dependencyKind || 'semantic',
            ordinal: integer(dependency.ordinal),
          };
        });
        const contextFingerprint = hash({
          profileId: entry.profile.id,
          profileVersion: entry.profile.version,
          context: entry.context,
          dependencies: childItems.map((child) => ({
            stableId: child.stableId,
            annotationId: child.annotationId,
            role: child.role,
            referenceContextFingerprint: child.referenceOnly ? hash(child.context || null) : null,
          })),
          ...annotationContractFingerprint({
            annotationKind: entry.subject.annotationKind,
            labels: entry.subject.labels,
            context: entry.context,
          }),
        });
        const annotationId = `annotation:${hash({ stableId: entry.subject.stableId, profileId: entry.profile.id, profileVersion: entry.profile.version, contextFingerprint })}`;
        entry.item = {
          requestedStableId: entry.subject.requestedStableId,
          stableId: entry.subject.stableId,
          annotationKind: entry.subject.annotationKind,
          labels: entry.subject.labels,
          profileId: entry.profile.id,
          profileVersion: entry.profile.version,
          annotationId,
          contextFingerprint,
          context: entry.context,
          dependencies: childItems,
        };
        pendingRows.push({
          ...entry.item,
          subjectLabel: entry.subject.labels[0],
          contextJson: JSON.stringify(entry.item.context ?? null),
          referenceDependenciesJson: JSON.stringify(entry.item.dependencies.filter((dependency) => dependency.referenceOnly)),
          labelsJson: JSON.stringify(entry.item.labels || []),
          maxDepth: depthLimit,
          refreshRequested: shouldRefreshAnnotation(resolvedRefreshMode, depth),
        });
      }
      if (persist) {
        await timed('persist-annotations', { depth, count: pendingRows.length },
          () => persistPendingAnnotations(session, pendingRows));
      }
      const cachedById = persist
        ? await timed('load-annotations', { depth, count: pendingRows.length },
          () => loadAnnotations(session, pendingRows.map((item) => item.annotationId)))
        : new Map();
      const dependencyRows = [];
      for (const entry of prepared) {
        const cached = cachedById.get(entry.item.annotationId);
        entry.item.status = cached?.status || 'pending';
        entry.item.annotation = cached?.status === 'ready' ? cached.text : '';
        entry.item.toolGitCommitShortHash = cached?.toolGitCommitShortHash || null;
        entry.item.maxDepth = cached?.maxDepth ?? depthLimit;
        memo.set(entry.subject.requestedStableId, entry.item);
        memo.set(entry.subject.stableId, entry.item);
        if (entry.item.status !== 'ready') generationOrder.push(entry.item);
        for (const child of entry.item.dependencies) {
          if (!child.annotationId) continue;
          dependencyRows.push({
            parentAnnotationId: entry.item.annotationId,
            childAnnotationId: child.annotationId,
            role: child.role || 'dependency',
            dependencyKind: child.dependencyKind || 'semantic',
            ordinal: integer(child.ordinal),
          });
        }
      }
      if (persist) {
        await timed('persist-dependencies', { depth, count: dependencyRows.length },
          () => persistDependencies(session, dependencyRows));
      }
      subjects.forEach((subject) => {
        visiting.delete(subject.requestedStableId);
        visiting.delete(subject.stableId);
      });
    }

    await visitMany([requestedStableId], 0);
    const root = memo.get(requestedStableId);
    return {
      ok: true,
      status: root.status === 'ready' ? 'ready' : 'needs-generation',
      root,
      generationOrder,
      diagnostics: {
        totalMilliseconds: Math.round(performance.now() - startedAt),
        atOperationIndex: resolvedAtOperationIndex,
        persisted: Boolean(persist),
        refreshMode: resolvedRefreshMode,
        timings,
      },
    };
  } finally {
    await session.close();
  }
}

const ANNOTATION_REQUIREMENTS = Object.freeze({
  ExecutionPrimitive: [
    'Explain the semantic source of the produced value using source expressions and producer callable annotations.',
    'For feature flags and external settings, state their graph-visible purpose, key, fallback, and retrieval behavior.',
    'When configurationSemantics is present, use its exact-key consumers, conditions, and controlled effects to explain the setting variants and observable behavior.',
    'Avoid implementation-only instrumentation terms unless they explain an observable effect.',
  ],
  Binding: [
    'Lead with the domain meaning of the value, using stateInitialization documentation and initializer when available.',
    'Then explain where the value originates and list only its relevant mutations in operation order up to the request point.',
    'Name connected storage and callable sources when they are present in the context.',
  ],
  ValueUse: [
    'Lead with the domain meaning of the concrete value or member read at this exact request point.',
    'Use value-origin dependency annotations and origin syntax to explain every semantic component of a computed value.',
    'For a branch operand, mention truthy and falsy outcomes only after defining the value, and keep that local-flow explanation to one short clause.',
    'Do not describe preceding or subsequent predicates when they do not define the selected value.',
    'Prioritize why the comparison matters over explaining standard language operators or string methods.',
    'Avoid generic descriptions of JavaScript evaluation, bindings, assignments, equality, or trimming.',
  ],
  Callable: [
    'Explain the callable purpose from its ordered steps and observable effects.',
    'Use dependency annotations to summarize invoked callables without inventing implementation details.',
  ],
  Step: [
    'Explain inputs, ordered actions, branches, value effects, calls, and storage or external effects represented by the step.',
    'Distinguish control flow from value flow.',
  ],
  FlowBlock: [
    'Explain the execution alternative represented by the block and summarize its ordered steps.',
  ],
  Loop: [
    'Explain which collection or condition drives the loop and what one iteration represents.',
    'Summarize graph-visible per-item branches and effects from the annotated loop members.',
    'Do not explain generic loop syntax or instrumentation mechanics.',
  ],
  CallSite: [
    'Explain supplied graph relations and the annotated callee contract only when the invocation itself is the semantic focus.',
    'When memberAccesses is non-empty, lead with the domain purpose and controlled behavior of the exact trailing member, using relatedMemberUses as evidence; treat the receiver call only as the source of its object.',
    'For a member-focused condition, do not explain JavaScript operators, boolean truth tables, optionality, or the mechanics of reading a property. State what real-world or product behavior this condition permits, suppresses, or remembers.',
  ],
  StorageCell: [
    'Explain what is stored and identify graph-visible writers, readers, and dependents.',
  ],
  ExternalComponent: [
    'Explain the external boundary and graph-visible interactions only.',
  ],
  FunctionalEntity: [
    'Describe the accumulated functional meaning of this developer-defined entity in Russian.',
    'Use ready annotations from functional descendants as the primary evidence and merge them without repeating implementation names.',
    'When terminal system effects are present, infer behavior from operation syntax, arguments, writes, and system targets; do not annotate or explain the system declarations themselves.',
    'Do not use TYPED_AS, ALIASES, HAS_MEMBER, HAS_PARAMETER, or lexical containment as evidence of behavior.',
    'Keep distinct effects, state changes, and boundary interactions; remove duplicate wording inherited through reference and declaration nodes.',
  ],
  Module: [
    'Explain the source module responsibility from its declared callables and direct imports.',
    'Do not infer behavior from imported module names alone.',
  ],
});

const GLOBAL_ANNOTATION_REQUIREMENTS = Object.freeze([
  'Stay within the selected entity and request point. Do not narrate subsequent steps or downstream uses outside that entity, except exact-key configuration consumers explicitly supplied in configurationSemantics.',
  'Reference-only dependencies are intentional depth-boundary context. Use their supplied context directly; do not return a refusal, missing-context response, or boundary error because they have no generated annotation.',
]);

function annotationObjective(item) {
  if (isFunctionalEntity(item)) {
    return isFunctionalParameter(item)
      ? 'Synthesize in Russian the accumulated functional capabilities supplied to this parameter, from terminal system effects upward.'
      : 'Synthesize in Russian this developer-defined entity from its functional descendants and terminal system effects.';
  }
  if (isParameterBinding(item)) {
    return 'Infer and describe in Russian the domain meaning of this parameter from its graph-visible origins and uses.';
  }
  return `Describe this ${item.annotationKind} in Russian using only the supplied graph context.`;
}

function annotationRequirements(item) {
  if (isParameterBinding(item)) {
    return [
      ...GLOBAL_ANNOTATION_REQUIREMENTS,
      'Treat incoming origins as alternative ways to supply the same parameter, not as separate meanings by default.',
      'Use ready annotations of source bindings and the graph-visible structure of origins and uses as evidence.',
      'Infer the narrowest domain-level meaning that is true for all supported origins.',
      'Do not enumerate call sites, functions, variable names, source paths, or graph relation names.',
      'Use downstream usages only as semantic evidence; do not narrate what the code does after receiving the parameter.',
      'Return exactly one concise sentence.',
    ];
  }
  return [
    ...GLOBAL_ANNOTATION_REQUIREMENTS,
    ...(ANNOTATION_REQUIREMENTS[item.annotationKind] || [
      'Explain the entity purpose, incoming context, and observable effects represented in the graph.',
    ]),
  ];
}

export function buildAnnotationTask(item, rootStableId, options = {}) {
  const dependencies = (item.dependencies || []).map((dependency) => ({
    stableId: dependency.stableId,
    annotationKind: dependency.annotationKind,
    role: dependency.role,
    dependencyKind: dependency.dependencyKind || 'semantic',
    status: dependency.status,
    referenceOnly: Boolean(dependency.referenceOnly),
    annotation: dependency.annotation || '',
    context: dependency.referenceOnly ? dependency.context : undefined,
  }));
  return {
    jobId: options.jobId,
    taskId: options.taskId,
    leaseToken: options.leaseToken,
    annotationId: item.annotationId,
    stableId: item.stableId,
    annotationKind: item.annotationKind,
    labels: item.labels,
    objective: annotationObjective(item),
    requirements: annotationRequirements(item),
    synthesis: isFunctionalEntity(item) ? {
      mode: 'bottom-up-functional-accumulation',
      evidence: ['functional-descendant-annotations', 'terminal-system-effects', 'operation-syntax'],
      boundary: 'System',
      output: isFunctionalParameter(item) ? 'concise-capability-summary' : 'concise-functional-summary',
    } : isParameterBinding(item) ? {
      mode: 'bottom-up-semantic-summary',
      evidence: ['origin-annotations', 'origin-structure', 'usage-structure'],
      output: 'one-sentence-domain-meaning',
    } : undefined,
    contextBundle: {
      subject: {
        stableId: item.stableId,
        annotationKind: item.annotationKind,
        labels: item.labels,
      },
      context: item.context,
      dependencies,
    },
    completion: {
      endpoint: options.taskId
        ? `/api/annotation-tasks/${encodeURIComponent(options.taskId)}/complete`
        : '/api/graph/annotations/workflow/complete',
      body: {
        rootStableId,
        rootAnnotationId: options.rootAnnotationId,
        annotationId: item.annotationId,
        jobId: options.jobId,
        taskId: options.taskId,
        leaseToken: options.leaseToken,
        maxDepth: options.maxDepth,
        atStableId: options.atStableId,
        atOperationIndex: options.atOperationIndex,
        clientContext: options.clientContext,
        source: 'codex',
        text: '<generated annotation>',
      },
    },
  };
}

export function selectNextAnnotationTask(generationOrder = []) {
  return generationOrder.find((item) => (
    item.status !== 'ready'
    && (item.dependencies || []).every((dependency) => (
      dependency.referenceOnly || dependency.status === 'ready'
    ))
  )) || null;
}

const ANNOTATION_TASK_LEASE_MS = 5 * 60 * 1000;

async function persistAnnotationJob(session, {
  root,
  generationOrder,
  rootStableId,
  maxDepth,
  atStableId,
  atOperationIndex,
  clientContext,
}) {
  if (!root?.annotationId) {
    throw new Error(`Cannot persist annotation workflow without a root annotation ID for ${rootStableId || 'unknown root'}.`);
  }
  const now = new Date().toISOString();
  const jobId = `annotation-job:${hash({
    rootAnnotationId: root.annotationId,
    clientContext: clientContext || null,
  })}`;
  const tasks = generationOrder
    .filter((item) => item.status !== 'ready')
    .map((item) => ({
      taskId: `annotation-task:${hash({ jobId, annotationId: item.annotationId })}`,
      annotationId: item.annotationId,
    }));
  await session.run(`
    MATCH (root:Annotation {annotationId: $rootAnnotationId})
    MERGE (job:AnnotationJob {jobId: $jobId})
    ON CREATE SET job.createdAt = $now
    SET job.rootStableId = $rootStableId,
        job.rootAnnotationId = $rootAnnotationId,
        job.status = CASE WHEN root.status = 'ready' THEN 'complete' ELSE 'pending' END,
        job.maxDepth = $maxDepth,
        job.atStableId = $atStableId,
        job.atOperationIndex = $atOperationIndex,
        job.clientContextJson = $clientContextJson,
        job.updatedAt = $now
    MERGE (job)-[:ROOT]->(root)
    WITH job
    UNWIND $tasks AS item
    MATCH (annotation:Annotation {annotationId: item.annotationId})
    MERGE (task:AnnotationTask {taskId: item.taskId})
    ON CREATE SET task.createdAt = $now, task.status = 'pending'
    SET task.annotationId = item.annotationId,
        task.updatedAt = $now,
        task.status = CASE WHEN annotation.status = 'ready' THEN 'complete' ELSE task.status END
    MERGE (job)-[:HAS_TASK]->(task)
    MERGE (task)-[:GENERATES]->(annotation)
  `, {
    jobId,
    rootAnnotationId: root.annotationId,
    rootStableId,
    maxDepth: integer(maxDepth),
    atStableId: atStableId || null,
    atOperationIndex: Number.isFinite(Number(atOperationIndex)) ? Number(atOperationIndex) : null,
    clientContextJson: JSON.stringify(clientContext || null),
    tasks,
    now,
  });
  return jobId;
}

function annotationItemFromTaskRecord(record) {
  const persistedDependencies = normalizeNeo4jDependencies(record.get('dependencies'));
  const referenceDependencies = parseStoredJson(record.get('referenceDependenciesJson'), []);
  return {
    annotationId: record.get('annotationId'),
    stableId: record.get('stableId'),
    annotationKind: record.get('annotationKind'),
    status: record.get('annotationStatus') || 'pending',
    context: parseStoredJson(record.get('contextJson'), null),
    labels: parseStoredJson(record.get('labelsJson'), []),
    dependencies: [...persistedDependencies, ...referenceDependencies]
      .sort((left, right) => integer(left.ordinal) - integer(right.ordinal)),
  };
}

function normalizeNeo4jDependencies(dependencies) {
  return (dependencies || []).filter(Boolean).map((dependency) => ({
    ...dependency,
    ordinal: integer(dependency.ordinal),
  }));
}

export async function leaseNextAnnotationTask(driver, database, {
  jobId,
} = {}) {
  const resolvedJobId = String(jobId || '').trim();
  if (!resolvedJobId) throw new Error('jobId is required.');
  const session = driver.session({ database });
  try {
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + ANNOTATION_TASK_LEASE_MS).toISOString();
    const proposedLeaseToken = crypto.randomUUID();
    const result = await session.run(`
      MATCH (job:AnnotationJob {jobId: $jobId})-[:ROOT]->(root:Annotation)
      SET job.leaseProbeAt = $now
      WITH job, root
      OPTIONAL MATCH (job)-[:HAS_TASK]->(task:AnnotationTask)-[:GENERATES]->(candidate:Annotation)
      WHERE candidate.status <> 'ready'
        AND (task.status <> 'leased' OR task.leaseExpiresAt IS NULL OR task.leaseExpiresAt <= $now)
        AND NOT EXISTS {
          MATCH (candidate)-[:DEPENDS_ON]->(missing:Annotation)
          WHERE missing.status <> 'ready'
        }
      OPTIONAL MATCH path = (root)-[:DEPENDS_ON*0..8]->(candidate)
      WITH job, root, task, candidate, max(length(path)) AS depth
      ORDER BY depth DESC, candidate.annotationId
      LIMIT 1
      FOREACH (_ IN CASE WHEN task IS NULL THEN [] ELSE [1] END |
        SET task.status = 'leased',
            task.leaseToken = $proposedLeaseToken,
            task.leaseExpiresAt = $leaseExpiresAt,
            task.updatedAt = $now,
            job.status = 'running',
            job.updatedAt = $now
      )
      WITH job, root, task, candidate
      OPTIONAL MATCH (candidate)-[relation:DEPENDS_ON]->(dependency:Annotation)
      WITH job, root, task, candidate, relation, dependency
      ORDER BY relation.ordinal, dependency.headID
      RETURN job.jobId AS jobId,
             job.rootStableId AS rootStableId,
             job.maxDepth AS maxDepth,
             job.atStableId AS atStableId,
             job.atOperationIndex AS atOperationIndex,
             job.clientContextJson AS clientContextJson,
             root.annotationId AS rootAnnotationId,
             root.status AS rootStatus,
             root.text AS rootText,
             root.toolGitCommitShortHash AS rootToolGitCommitShortHash,
             root.maxDepth AS rootMaxDepth,
             task.taskId AS taskId,
             task.leaseToken AS leaseToken,
             candidate.annotationId AS annotationId,
             candidate.headID AS stableId,
             candidate.annotationKind AS annotationKind,
             candidate.status AS annotationStatus,
             candidate.contextJson AS contextJson,
             candidate.referenceDependenciesJson AS referenceDependenciesJson,
             candidate.labelsJson AS labelsJson,
             collect(CASE WHEN dependency IS NULL THEN null ELSE {
               stableId: dependency.headID,
               annotationKind: dependency.annotationKind,
               role: relation.role,
               dependencyKind: relation.dependencyKind,
               ordinal: relation.ordinal,
               status: dependency.status,
               annotation: dependency.text
             } END) AS dependencies
    `, { jobId: resolvedJobId, proposedLeaseToken, leaseExpiresAt, now });
    const record = result.records[0];
    if (!record) throw new Error(`Annotation job not found: ${resolvedJobId}`);
    const clientContext = parseStoredJson(record.get('clientContextJson'), null);
    if (record.get('rootStatus') === 'ready') {
      await session.run(`
        MATCH (job:AnnotationJob {jobId: $jobId})
        SET job.status = 'complete', job.updatedAt = $now
      `, { jobId: resolvedJobId, now });
      return {
        ok: true,
        status: 'ready',
        jobId: resolvedJobId,
        rootStableId: record.get('rootStableId'),
        annotation: record.get('rootText') || '',
        annotationMetadata: {
          toolGitCommitShortHash: record.get('rootToolGitCommitShortHash') || null,
          maxDepth: record.get('rootMaxDepth') === null ? null : integer(record.get('rootMaxDepth')),
        },
        clientContext,
      };
    }
    if (!record.get('taskId') || !record.get('annotationId')) {
      return {
        ok: true,
        status: 'waiting',
        jobId: resolvedJobId,
        rootStableId: record.get('rootStableId'),
        clientContext,
      };
    }
    const item = annotationItemFromTaskRecord(record);
    return {
      ok: true,
      status: 'needs-generation',
      jobId: resolvedJobId,
      rootStableId: record.get('rootStableId'),
      task: buildAnnotationTask(item, record.get('rootStableId'), {
        jobId: resolvedJobId,
        taskId: record.get('taskId'),
        leaseToken: record.get('leaseToken'),
        rootAnnotationId: record.get('rootAnnotationId'),
        maxDepth: integer(record.get('maxDepth')),
        atStableId: record.get('atStableId'),
        atOperationIndex: record.get('atOperationIndex'),
        clientContext,
      }),
      clientContext,
    };
  } finally {
    await session.close();
  }
}

export async function getAnnotationJob(driver, database, { jobId } = {}) {
  const resolvedJobId = String(jobId || '').trim();
  if (!resolvedJobId) throw new Error('jobId is required.');
  const session = driver.session({ database });
  try {
    const result = await session.run(`
      MATCH (job:AnnotationJob {jobId: $jobId})-[:ROOT]->(root:Annotation)
      OPTIONAL MATCH (job)-[:HAS_TASK]->(task:AnnotationTask)-[:GENERATES]->(annotation:Annotation)
      WITH job, root, collect(CASE WHEN task IS NULL THEN null ELSE {
        taskId: task.taskId,
        taskStatus: task.status,
        leaseExpiresAt: task.leaseExpiresAt,
        annotationId: annotation.annotationId,
        annotationStatus: annotation.status,
        stableId: annotation.headID
      } END) AS tasks
      RETURN job.jobId AS jobId,
             job.status AS status,
             job.rootStableId AS rootStableId,
             root.annotationId AS rootAnnotationId,
             root.status AS rootStatus,
             root.text AS annotation,
             root.toolGitCommitShortHash AS toolGitCommitShortHash,
             root.maxDepth AS annotationMaxDepth,
             job.clientContextJson AS clientContextJson,
             [task IN tasks WHERE task IS NOT NULL] AS tasks
    `, { jobId: resolvedJobId });
    const record = result.records[0];
    if (!record) throw new Error(`Annotation job not found: ${resolvedJobId}`);
    const tasks = normalizeNeo4jDependencies(record.get('tasks'));
    const completedTaskCount = tasks.filter((task) => (
      task.taskStatus === 'complete' || task.annotationStatus === 'ready'
    )).length;
    const leasedTaskCount = tasks.filter((task) => task.taskStatus === 'leased').length;
    return {
      ok: true,
      jobId: record.get('jobId'),
      status: record.get('rootStatus') === 'ready' ? 'complete' : record.get('status'),
      rootStableId: record.get('rootStableId'),
      rootAnnotationId: record.get('rootAnnotationId'),
      annotation: record.get('annotation') || '',
      annotationMetadata: {
        toolGitCommitShortHash: record.get('toolGitCommitShortHash') || null,
        maxDepth: record.get('annotationMaxDepth') === null ? null : integer(record.get('annotationMaxDepth')),
      },
      clientContext: parseStoredJson(record.get('clientContextJson'), null),
      taskCount: tasks.length,
      completedTaskCount,
      leasedTaskCount,
      remainingTaskCount: tasks.length - completedTaskCount,
      tasks,
    };
  } finally {
    await session.close();
  }
}

export async function startAnnotationWorkflow(driver, database, {
  stableId,
  rootStableId,
  maxDepth = 4,
  atStableId,
  atOperationIndex,
  clientContext,
  leaseTask = true,
  refreshMode,
  refresh,
  overwrite,
} = {}) {
  const requestedStableId = String(rootStableId || stableId || '').trim();
  if (!requestedStableId) throw new Error('stableId is required.');
  const resolution = await resolveAnnotation(driver, database, {
    stableId: requestedStableId,
    maxDepth,
    atStableId,
    atOperationIndex,
    persist: true,
    refreshMode,
    refresh,
    overwrite,
  });
  if (resolution.status === 'ready') {
    return {
      ok: true,
      status: 'ready',
      rootStableId: requestedStableId,
      annotation: resolution.root.annotation,
      annotationMetadata: {
        toolGitCommitShortHash: resolution.root.toolGitCommitShortHash || null,
        maxDepth: resolution.root.maxDepth ?? null,
      },
      root: resolution.root,
      clientContext: clientContext || null,
      diagnostics: resolution.diagnostics,
    };
  }
  const session = driver.session({ database });
  let jobId;
  try {
    jobId = await persistAnnotationJob(session, {
      root: resolution.root,
      generationOrder: resolution.generationOrder,
      rootStableId: requestedStableId,
      maxDepth,
      atStableId,
      atOperationIndex,
      clientContext,
    });
  } finally {
    await session.close();
  }
  if (!leaseTask) {
    return {
      ok: true,
      status: 'queued',
      jobId,
      rootStableId: requestedStableId,
      clientContext: clientContext || null,
      remaining: resolution.generationOrder.filter((item) => item.status !== 'ready').length,
      diagnostics: resolution.diagnostics,
    };
  }
  const leased = await leaseNextAnnotationTask(driver, database, { jobId });
  return {
    ...leased,
    remaining: resolution.generationOrder.filter((item) => item.status !== 'ready').length,
    diagnostics: resolution.diagnostics,
  };
}

function parseStoredJson(value, fallback) {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function continueAnnotationWorkflow(driver, database, {
  rootAnnotationId,
  rootStableId,
  maxDepth,
  atStableId,
  atOperationIndex,
  clientContext,
} = {}) {
  const session = driver.session({ database });
  try {
    const rootResult = await session.run(`
      MATCH (root:Annotation {annotationId: $rootAnnotationId})
      RETURN root.annotationId AS annotationId, root.headID AS stableId,
             root.annotationKind AS annotationKind, root.status AS status,
             root.text AS text, root.contextJson AS contextJson,
             root.labelsJson AS labelsJson,
             root.toolGitCommitShortHash AS toolGitCommitShortHash,
             root.maxDepth AS maxDepth
    `, { rootAnnotationId });
    const rootRecord = rootResult.records[0];
    if (!rootRecord) throw new Error(`Annotation workflow root not found: ${rootAnnotationId}`);
    const root = {
      annotationId: rootRecord.get('annotationId'),
      stableId: rootRecord.get('stableId'),
      annotationKind: rootRecord.get('annotationKind'),
      status: rootRecord.get('status') || 'pending',
      annotation: rootRecord.get('text') || '',
      context: parseStoredJson(rootRecord.get('contextJson'), null),
      labels: parseStoredJson(rootRecord.get('labelsJson'), []),
      toolGitCommitShortHash: rootRecord.get('toolGitCommitShortHash') || null,
      maxDepth: rootRecord.get('maxDepth') === null ? null : integer(rootRecord.get('maxDepth')),
    };
    if (root.status === 'ready') {
      return {
        ok: true,
        status: 'ready',
        rootStableId,
        annotation: root.annotation,
        annotationMetadata: {
          toolGitCommitShortHash: root.toolGitCommitShortHash,
          maxDepth: root.maxDepth,
        },
        root,
        clientContext: clientContext || null,
      };
    }

    const taskResult = await session.run(`
      MATCH (root:Annotation {annotationId: $rootAnnotationId})
      MATCH path = (root)-[:DEPENDS_ON*0..8]->(candidate:Annotation)
      WHERE candidate.status <> 'ready'
        AND NOT EXISTS {
          MATCH (candidate)-[:DEPENDS_ON]->(missing:Annotation)
          WHERE missing.status <> 'ready'
        }
      WITH candidate, max(length(path)) AS depth
      ORDER BY depth DESC, candidate.annotationId
      LIMIT 1
      OPTIONAL MATCH (candidate)-[relation:DEPENDS_ON]->(dependency:Annotation)
      WITH candidate, relation, dependency
      ORDER BY relation.ordinal, dependency.headID
      RETURN candidate.annotationId AS annotationId,
             candidate.headID AS stableId,
             candidate.annotationKind AS annotationKind,
             candidate.status AS status,
             candidate.contextJson AS contextJson,
             candidate.referenceDependenciesJson AS referenceDependenciesJson,
             candidate.labelsJson AS labelsJson,
             collect(CASE WHEN dependency IS NULL THEN null ELSE {
               stableId: dependency.headID,
               annotationKind: dependency.annotationKind,
               role: relation.role,
               ordinal: relation.ordinal,
               status: dependency.status,
               annotation: dependency.text
             } END) AS dependencies
    `, { rootAnnotationId });
    const taskRecord = taskResult.records[0];
    if (!taskRecord?.get('annotationId')) {
      throw new Error(`Annotation workflow has no executable task for ${rootStableId}.`);
    }
    const item = {
      annotationId: taskRecord.get('annotationId'),
      stableId: taskRecord.get('stableId'),
      annotationKind: taskRecord.get('annotationKind'),
      status: taskRecord.get('status') || 'pending',
      context: parseStoredJson(taskRecord.get('contextJson'), null),
      labels: parseStoredJson(taskRecord.get('labelsJson'), []),
      dependencies: [
        ...(taskRecord.get('dependencies') || []).filter(Boolean),
        ...parseStoredJson(taskRecord.get('referenceDependenciesJson'), []),
      ].sort((left, right) => integer(left.ordinal) - integer(right.ordinal)),
    };
    return {
      ok: true,
      status: 'needs-generation',
      rootStableId,
      task: buildAnnotationTask(item, rootStableId, {
        rootAnnotationId,
        maxDepth,
        atStableId,
        atOperationIndex,
        clientContext,
      }),
      clientContext: clientContext || null,
    };
  } finally {
    await session.close();
  }
}

export async function completeAnnotationWorkflow(driver, database, {
  jobId,
  taskId,
  leaseToken,
  rootStableId,
  rootAnnotationId,
  annotationId,
  text,
  source = 'codex',
  maxDepth = 4,
  atStableId,
  atOperationIndex,
  clientContext,
} = {}) {
  if (jobId) {
    const resolvedTaskId = String(taskId || '').trim();
    if (!resolvedTaskId) throw new Error('taskId is required for an annotation job completion.');
    const session = driver.session({ database });
    try {
      const result = await session.run(`
        MATCH (job:AnnotationJob {jobId: $jobId})-[:HAS_TASK]->(task:AnnotationTask {taskId: $taskId})-[:GENERATES]->(annotation:Annotation)
        RETURN annotation.annotationId AS annotationId,
               task.leaseToken AS leaseToken,
               task.status AS taskStatus
      `, { jobId: String(jobId), taskId: resolvedTaskId });
      const record = result.records[0];
      if (!record) throw new Error(`Annotation task not found in job: ${resolvedTaskId}`);
      if (record.get('annotationId') !== annotationId) {
        throw new Error(`Annotation task target mismatch: ${resolvedTaskId}`);
      }
      if (leaseToken && record.get('leaseToken') && record.get('leaseToken') !== leaseToken) {
        throw new Error(`Annotation task lease mismatch: ${resolvedTaskId}`);
      }
    } finally {
      await session.close();
    }
    await completeAnnotation(driver, database, { annotationId, text, source, maxDepth });
    const completionSession = driver.session({ database });
    try {
      await completionSession.run(`
        MATCH (job:AnnotationJob {jobId: $jobId})-[:HAS_TASK]->(task:AnnotationTask {taskId: $taskId})-[:GENERATES]->(annotation:Annotation)
        SET task.status = 'complete',
            task.leaseToken = null,
            task.leaseExpiresAt = null,
            task.updatedAt = $now,
            job.updatedAt = $now
        WITH job
        MATCH (job)-[:HAS_TASK]->(cachedTask:AnnotationTask)-[:GENERATES]->(cached:Annotation)
        WHERE cached.status = 'ready'
        SET cachedTask.status = 'complete', cachedTask.updatedAt = $now
      `, { jobId: String(jobId), taskId: resolvedTaskId, now: new Date().toISOString() });
    } finally {
      await completionSession.close();
    }
    return leaseNextAnnotationTask(driver, database, { jobId });
  }
  await completeAnnotation(driver, database, { annotationId, text, source, maxDepth });
  if (!rootAnnotationId) {
    return startAnnotationWorkflow(driver, database, {
      rootStableId,
      maxDepth,
      atStableId,
      atOperationIndex,
      clientContext,
    });
  }
  return continueAnnotationWorkflow(driver, database, {
    rootAnnotationId,
    rootStableId,
    maxDepth,
    atStableId,
    atOperationIndex,
    clientContext,
  });
}

export async function completeAnnotation(driver, database, {
  annotationId,
  text,
  source = 'codex',
  maxDepth,
} = {}) {
  const resolvedAnnotationId = String(annotationId || '').trim();
  const annotationText = validateAnnotationTextEncoding(text);
  if (!resolvedAnnotationId) throw new Error('annotationId and text are required.');
  const updatedAt = new Date().toISOString();
  const metadata = getAnnotationToolMetadata({ maxDepth });
  const session = driver.session({ database });
  try {
    const dependencyResult = await session.run(`
      MATCH (annotation:Annotation {annotationId: $annotationId})
      OPTIONAL MATCH (annotation)-[:DEPENDS_ON]->(dependency:Annotation)
      WITH annotation, collect(CASE WHEN dependency.status <> 'ready' THEN dependency.annotationId END) AS missing
      RETURN annotation.annotationId AS annotationId, [id IN missing WHERE id IS NOT NULL] AS missing
    `, { annotationId: resolvedAnnotationId });
    const dependencyRecord = dependencyResult.records[0];
    if (!dependencyRecord) throw new Error(`Annotation job not found: ${resolvedAnnotationId}`);
    const missing = dependencyRecord.get('missing') || [];
    if (missing.length) {
      throw new Error(`Annotation dependencies are not ready for ${resolvedAnnotationId}: ${missing.join(', ')}`);
    }
    const result = await session.run(`
      MATCH (annotation:Annotation {annotationId: $annotationId})
      WITH annotation, annotation.text AS previousText
      SET annotation.text = $text,
          annotation.status = 'ready',
          annotation.source = $source,
          annotation.toolGitCommitShortHash = $toolGitCommitShortHash,
          annotation.maxDepth = coalesce($maxDepth, annotation.maxDepth),
          annotation.updatedAt = $updatedAt
      RETURN annotation.headID AS stableId,
             annotation.profileId AS profileId,
             annotation.profileVersion AS profileVersion,
             annotation.toolGitCommitShortHash AS toolGitCommitShortHash,
             annotation.maxDepth AS maxDepth,
             previousText
    `, {
      annotationId: resolvedAnnotationId,
      text: annotationText,
      source,
      updatedAt,
      ...metadata,
    });
    const record = result.records[0];
    if (!record) throw new Error(`Annotation job not found: ${resolvedAnnotationId}`);
    const previousText = record.get('previousText') || '';
    if (previousText && previousText !== annotationText) {
      await session.run(`
        MATCH (annotation:Annotation {annotationId: $annotationId})
        MATCH (dependent:Annotation)-[:DEPENDS_ON*1..8]->(annotation)
        WHERE dependent.status = 'ready'
        SET dependent.status = 'stale', dependent.staleAt = $updatedAt
      `, { annotationId: resolvedAnnotationId, updatedAt });
    }
    return {
      ok: true,
      annotationId: resolvedAnnotationId,
      stableId: record.get('stableId'),
      profileId: record.get('profileId'),
      profileVersion: integer(record.get('profileVersion')),
      toolGitCommitShortHash: record.get('toolGitCommitShortHash') || null,
      maxDepth: record.get('maxDepth') === null ? null : integer(record.get('maxDepth')),
      status: 'ready',
      updatedAt,
    };
  } finally {
    await session.close();
  }
}
