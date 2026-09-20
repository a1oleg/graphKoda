import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAnnotationTask,
  completeAnnotation,
  isAnnotationPassReady,
  getAnnotationToolMetadata,
  normalizeAnnotationRefreshMode,
  selectNextAnnotationTask,
  shouldRecurseAnnotationDependency,
  shouldRefreshAnnotation,
  validateAnnotationTextEncoding,
} from './annotationResolver.js';
import {
  getAnnotationProfile,
  inferAnnotationKind,
  loadCompositionContextDependenciesMany,
  resolveAnnotationSubjects,
} from './annotationProfiles.js';

test('a saved root alone does not complete the accumulated annotation pass', () => {
  assert.equal(isAnnotationPassReady({ status: 'ready' }, [{ status: 'pending' }]), false);
  assert.equal(isAnnotationPassReady({ status: 'ready' }, [{ status: 'ready' }]), true);
  assert.equal(isAnnotationPassReady({ status: 'pending' }, []), false);
});

test('annotation task requires database persistence for every generated result', () => {
  const task = buildAnnotationTask({ stableId: 'subject', annotationKind: 'FunctionalEntity' }, 'root');
  assert.equal(task.completion.required, true);
  assert.equal(task.completion.storage, 'neo4j');
  assert.equal(task.completion.successCondition, 'persisted-ready');
  assert.equal(task.completion.passScope, 'all-non-reference-dependencies-and-root');
});

test('workflow completion rejects unfinished dependencies without writing', async () => {
  const driver = { session: () => ({
    run: async () => ({ records: [{ get: (key) => key === 'missing' ? ['child'] : 'annotation:test' }] }),
    close: async () => {},
  }) };
  await assert.rejects(completeAnnotation(driver, 'neo4j', {
    annotationId: 'annotation:test', text: 'Ready text',
  }), /dependencies are not ready/);
});

test('explicit save uses the same canonical writer without completing child tasks', async () => {
  const queries = [];
  const driver = { session: () => ({
    async run(query, params) {
      queries.push({ query, params });
      return { records: [{ get(key) {
        return ({ missing: ['child'], stableId: 'subject', profileVersion: 7,
          maxDepth: 4, previousText: '' })[key] ?? null;
      } }] };
    },
    close: async () => {},
  }) };
  const result = await completeAnnotation(driver, 'neo4j', {
    annotationId: 'annotation:test', text: 'Ready text', maxDepth: 4,
  }, { requireReadyDependencies: false });
  assert.equal(result.annotationId, 'annotation:test');
  assert.equal(result.status, 'ready');
  assert.equal(queries[1].params.text, 'Ready text');
  assert.match(queries[1].query, /annotationId: \$annotationId/);
  assert.match(queries[2].query, /legacy.annotationId IS NULL/);
  assert.equal(queries.length, 3);
});

test('annotation metadata identifies the tool commit and requested depth', () => {
  const metadata = getAnnotationToolMetadata({ maxDepth: '4' });

  assert.match(metadata.toolGitCommitShortHash, /^[0-9a-f]{12}$/);
  assert.equal(metadata.maxDepth, 4);
  assert.equal(getAnnotationToolMetadata().maxDepth, null);
  assert.equal(getAnnotationToolMetadata({ maxDepth: null }).maxDepth, null);
});

test('annotation refresh defaults to reuse and can target only the root or the complete subtree', () => {
  assert.equal(normalizeAnnotationRefreshMode(), 'reuse');
  assert.equal(normalizeAnnotationRefreshMode({ overwrite: true }), 'root');
  assert.equal(normalizeAnnotationRefreshMode({ refresh: 'root' }), 'root');
  assert.equal(normalizeAnnotationRefreshMode({ refreshMode: 'subtree' }), 'subtree');
  assert.equal(shouldRefreshAnnotation('reuse', 0), false);
  assert.equal(shouldRefreshAnnotation('root', 0), true);
  assert.equal(shouldRefreshAnnotation('root', 1), false);
  assert.equal(shouldRefreshAnnotation('subtree', 7), true);
  assert.throws(
    () => normalizeAnnotationRefreshMode({ refreshMode: 'dependencies' }),
    /Unsupported annotation refresh mode/,
  );
});

test('explicit maxDepth also bounds functional accumulation', () => {
  const dependency = { recurse: true };

  assert.equal(shouldRecurseAnnotationDependency(dependency, 3, 4), true);
  assert.equal(shouldRecurseAnnotationDependency(dependency, 4, 4), false);
  assert.equal(shouldRecurseAnnotationDependency({ recurse: false }, 0, 4), false);
});

test('composition context dependencies are method-agnostic and resolve semantic participants', async () => {
  let query = '';
  const session = {
    async run(text) {
      query = text;
      return {
        records: [{
          get(name) {
            if (name === 'stableId') return 'assignment';
            if (name === 'compositionMembers') {
              return [{
                memberStableId: 'producer',
                memberOperationIndex: 12,
                bindings: [{
                  stableId: 'source-binding', labels: ['ValueSlot', 'CapturedBinding'],
                  annotationKind: 'Binding', operationIndex: 1,
                }],
                callables: [{
                  stableId: 'callee', labels: ['Fn'], annotationKind: 'Callable', operationIndex: 12,
                }],
                boundaries: [],
              }];
            }
            return null;
          },
        }],
      };
    },
  };

  const dependencies = await loadCompositionContextDependenciesMany(session, ['assignment']);

  assert.deepEqual(dependencies.get('assignment'), [{
    stableId: 'source-binding', annotationKind: 'Binding', role: 'composition-value',
    dependencyKind: 'semantic', recurse: true, ordinal: 1,
  }, {
    stableId: 'callee', annotationKind: 'Callable', role: 'composition-callable',
    dependencyKind: 'semantic', recurse: true, ordinal: 12,
  }]);
  assert.match(query, /EVAL\|ASSIGNS_VALUE\|ARG\|FIELD\|ON_RECEIVER/);
  assert.match(query, /\*0\.\.4\]->\(member\)/);
  assert.match(query, /linkedBinding\.canonicalStableId/);
  assert.match(query, /linkedSemanticDeclaration:Declaration/);
  assert.match(query, /USES_REFERENCE/);
  assert.match(query, /RESOLVES_TO/);
  assert.match(query, /directDeclaration/);
  assert.match(query, /directSemanticDeclaration:Declaration/);
  assert.match(query, /composedDeclaration:Declaration/);
  assert.match(query, /directSemanticDeclaration IS NULL/);
  assert.match(query, /subjectSemantic\.annotationKind IS NOT NULL/);
  assert.match(query, /canonicalLinkedCallable/);
  assert.match(query, /canonicalLinkedCallable:CallableDeclaration/);
  assert.match(query, /state_resource_stableId: subject\.stableId/);
  assert.match(query, /state_update_action = 'create'/);
  assert.match(query, /node\.parentStepStableId = compositionRoot\.parentStepStableId/);
  assert.doesNotMatch(query, /Object\.values/);
});

test('predicate invocation uses the call-site annotation profile without a Call label', () => {
  assert.equal(
    inferAnnotationKind(['Branch', 'Read', 'Flow', 'Start', 'PredicateCall']),
    'CallSite',
  );
});

test('a graph-backed invocation promotes an annotation proxy to a call-site subject', async () => {
  let query = '';
  const session = {
    async run(text) {
      query = text;
      return {
        records: [{
          toObject: () => ({
            requestedStableId: 'predicate',
            stableId: 'predicate',
            labels: ['Branch', 'Operand', 'AnnotationProxy'],
            annotationKind: null,
            subjectHasInvocation: true,
            requestedIsFnDeclaration: false,
          }),
        }],
      };
    },
  };

  const subjects = await resolveAnnotationSubjects(session, ['predicate']);

  assert.equal(subjects.get('predicate').annotationKind, 'CallSite');
  assert.match(query, /subjectHasInvocation/);
  assert.match(query, /CALL\|REQUEST\|INVOKES/);
});

test('a callable with internal invocations remains a callable subject', async () => {
  const session = {
    async run() {
      return {
        records: [{
          toObject: () => ({
            requestedStableId: 'callable',
            stableId: 'callable',
            labels: ['Fn', 'DeveloperDefined', 'CallableDeclaration'],
            annotationKind: 'Callable',
            subjectHasInvocation: true,
            requestedIsFnDeclaration: false,
          }),
        }],
      };
    },
  };

  const subjects = await resolveAnnotationSubjects(session, ['callable']);

  assert.equal(subjects.get('callable').annotationKind, 'Callable');
});

test('operation labels override a stale binding annotation kind on a call', () => {
  assert.equal(inferAnnotationKind(['Call', 'Operation', 'CallResult'], 'Binding'), 'CallSite');
});

test('presentation-only visual proxies are never annotation subjects', () => {
  assert.equal(inferAnnotationKind(['Fn', 'Call', 'VisualProxy', 'PresentationOnly'], 'CallSite'), null);
});

test('compile-time build gates are not annotation storage subjects', () => {
  assert.equal(inferAnnotationKind(['BuildGate', 'BuildFeature']), null);
});

test('type-only declarations remain reference context instead of recursive functional tasks', () => {
  assert.equal(
    inferAnnotationKind(
      ['Declaration', 'DeveloperDefined', 'AliasDeclaration', 'TypeDeclaration', 'TypeAliasDeclaration'],
      'FunctionalEntity',
    ),
    null,
  );
  assert.equal(
    inferAnnotationKind(
      ['Declaration', 'DeveloperDefined', 'MemberDeclaration', 'TypeMember'],
      'FunctionalEntity',
    ),
    null,
  );
});

test('developer-defined canonical entities use bottom-up functional accumulation', async () => {
  assert.equal(
    inferAnnotationKind(['ValueSlot', 'Parameter', 'DeveloperDefined', 'ValueDeclaration'], 'Binding'),
    'FunctionalEntity',
  );
  assert.equal(getAnnotationProfile('FunctionalEntity').compositionContext, false);
  const queries = [];
  const session = {
    async run(text) {
      queries.push(text);
      return { records: [] };
    },
  };
  const profile = getAnnotationProfile('FunctionalEntity');
  assert.ok(profile);
  assert.equal(profile.accumulateToSystemBoundary, true);
  await profile.contextMany(session, ['helpers']);
  await profile.dependenciesMany(session, ['helpers']);
  assert.ok(queries.some(query => /RETURNS_VALUE/.test(query)));
  // Field and callback selection probes returned no matches; inspect fallback.
  const fallback = queries.filter(query => /effectPath=|directPath=/.test(query));
  queries.splice(0, queries.length, ...fallback);
  assert.match(queries[0], /system:System/);
  assert.match(queries[0], /HAS_OPERATION/);
  assert.match(queries[0], /terminalEffects/);
  assert.match(queries[1], /BINDS_TO_PARAMETER/);
  assert.match(queries[1], /typescript-checker-jsx-prop-flow/);
  assert.match(queries[1], /candidate:DeveloperDefined/);
  assert.match(queries[1], /directPath=.*VALUE_FROM\|RESOLVES_TO/);
  assert.match(queries[1], /candidate\.declarationKind/);
  assert.doesNotMatch(queries[1], /TYPED_AS|ALIASES|HAS_MEMBER|HAS_PARAMETER/);
  assert.match(queries[1], /forwardPath=.*HAS_PROPERTY/);
  assert.doesNotMatch(queries[1], /directPath=.*HAS_PROPERTY/);
  assert.match(queries[1], /CALLS_VALUE/);
  assert.match(queries[1], /READS_FROM/);
  assert.match(queries[1], /none\(edge IN relationships\(directPath\)/);
  assert.match(queries[1], /none\(edge IN relationships\(forwardPath\)/);
  assert.match(queries[1], /projection = startNode\(edge\)/);
  assert.doesNotMatch(queries[1], /HAS_ARGUMENT|RETURNS_VALUE/);
});

test('functional evidence survives context loading and task construction with directed edges', async () => {
  const evidenceGraph = {
    usageMaxHops: 3, usagePathLimit: 80, usageTruncated: false,
    paths: [{
      nodes: [{ stableId: 'writer' }, { stableId: 'slot' }, { stableId: 'owner' }],
      edges: [
        { fromId: 'writer', toId: 'slot', type: 'WRITES_TO', properties: { role: 'state-updater' } },
        { fromId: 'owner', toId: 'writer', type: 'AST_CHILD', properties: { layer: 'syntax' } },
      ],
    }],
  };
  const contexts = await getAnnotationProfile('FunctionalEntity').contextMany({
    async run(query) {
      if (query.includes('subject:PropertyProjection')) return { records: [] };
      return { records: [{ get(key) {
        return key === 'stableId' ? 'writer' : { stableId: 'writer', evidenceGraph };
      } }] };
    },
  }, ['writer']);
  const task = buildAnnotationTask({
    stableId: 'writer', annotationKind: 'FunctionalEntity', labels: ['DeveloperDefined'],
    context: contexts.get('writer'), dependencies: [],
  }, 'writer');
  assert.deepEqual(task.contextBundle.context.evidenceGraph, evidenceGraph);
});

test('loop annotation profile uses its source collection and same-function loop members', async () => {
  const queries = [];
  const session = {
    async run(text) {
      queries.push(text);
      return {
        records: [{
          toObject: () => text.includes('AS dependencies')
            ? { dependencies: [] }
            : { context: { syntax: 'const item of items', members: [] } },
        }],
      };
    },
  };
  const profile = getAnnotationProfile('Loop');
  assert.ok(profile);
  assert.equal(profile.compositionContext, true);

  await profile.context(session, 'loop');
  await profile.dependencies(session, 'loop');

  assert.match(queries[0], /loop\.value_slot_stableId/);
  assert.match(queries[0], /member\.parentFnStableId = loop\.parentFnStableId/);
  assert.match(queries[0], /NOT member:PresentationOnly/);
  assert.match(queries[0], /NOT member:VisualProxy/);
  assert.match(queries[1], /member:Annotatable OR member:Branch/);
  assert.match(queries[1], /NOT member:PresentationOnly/);
  assert.match(queries[1], /NOT member:VisualProxy/);
  assert.doesNotMatch(queries[1], /NOT member:AnnotationProxy/);
});

test('a loop value-slot pointer remains context instead of replacing the loop subject', async () => {
  let query = '';
  const session = {
    async run(text) {
      query = text;
      return {
        records: [{
          toObject: () => ({
            requestedStableId: 'loop',
            stableId: 'loop',
            labels: ['Loop'],
            annotationKind: null,
            requestedDiaName: 'for',
            requestedActionText: null,
            requestedOperationIndex: 10,
            requestedTypeText: null,
            requestedIsFnDeclaration: false,
          }),
        }],
      };
    },
  };

  const subjects = await resolveAnnotationSubjects(session, ['loop']);

  assert.match(query, /CASE WHEN requested:AnnotationProxy THEN valueSlot ELSE null END/);
  assert.equal(subjects.get('loop').stableId, 'loop');
  assert.equal(subjects.get('loop').annotationKind, 'Loop');
});

test('call-site dependencies resolve extracted and proxied callees', async () => {
  let query = '';
  const session = {
    async run(text) {
      query = text;
      return {
        records: [{
          toObject: () => ({
            dependencies: [{ stableId: 'callee', annotationKind: 'Callable', role: 'callee' }],
          }),
        }],
      };
    },
  };

  const dependencies = await getAnnotationProfile('CallSite').dependencies(session, 'site');

  assert.equal(dependencies[0].stableId, 'callee');
  assert.match(query, /site\.calleeStableId/);
  assert.match(query, /linkedTarget\.canonicalStableId/);
  assert.match(query, /'INVOKES'/);
  assert.match(query, /execution_role_bindings_json/);
  assert.match(query, /CapturedBinding/);
  assert.match(query, /ASSIGNS_VALUE/);
  assert.match(query, /'value-origin'/);
});

test('trailing member read keeps its receiver call as non-recursive provenance', async () => {
  let runCount = 0;
  const session = {
    async run(text) {
      runCount += 1;
      assert.match(text, /hasTrailingMemberAccess/);
      return {
        records: [{
          toObject: () => ({
            dependencies: [{ stableId: 'getter', annotationKind: 'Callable', role: 'callee' }],
            hasTrailingMemberAccess: true,
            executionRoleBindingsJson: JSON.stringify({ receiver: 'getter' }),
          }),
        }],
      };
    },
  };

  const dependencies = await getAnnotationProfile('CallSite').dependencies(session, 'member-read');

  assert.deepEqual(dependencies, []);
  assert.equal(runCount, 1);
});

test('call-site context exposes the callable that produced a captured callee value', async () => {
  const queries = [];
  const session = {
    async run(text) {
      queries.push(text);
      return {
        records: [{
          toObject: () => ({
            context: {
              callableOrigins: [{
                bindingStableId: 'setter-binding',
                producerStableId: 'hook-call',
                targetStableId: 'hook-function',
                targetName: 'useSetter',
              }],
            },
          }),
        }],
      };
    },
  };

  const result = await getAnnotationProfile('CallSite').context(session, 'setter-call');

  assert.equal(result.context.callableOrigins[0].targetStableId, 'hook-function');
  assert.match(queries[0], /capture\.bindingStableId/);
  assert.match(queries[0], /originTarget:Fn/);
  assert.match(queries[0], /memberAccesses/);
  assert.match(queries[0], /relatedMemberUses/);
  assert.match(queries[0], /memberReference:MemberReference/);
});

test('callable context is bounded to direct steps and blocks', async () => {
  let query = '';
  const session = {
    async run(text) {
      query = text;
      return {
        records: [{
          toObject: () => ({ context: { stableId: 'callable' } }),
        }],
      };
    },
  };

  await getAnnotationProfile('Callable').context(session, 'callable');

  assert.match(query, /step\.parentFlowBlockStableId IS NULL/);
  assert.match(query, /block\.parentFlowBlockStableId IS NULL/);
  assert.match(query, /directSteps/);
  assert.match(query, /directBlocks/);
  assert.match(query, /subject:FnDeclaration/);
  assert.match(query, /step\.parentLocalFunctionStableId = subject\.stableId/);
  assert.doesNotMatch(query, /member \{parentStepStableId/);
});

test('callable dependencies contain only first-level structure and module context', async () => {
  let query = '';
  const session = {
    async run(text) {
      query = text;
      return { records: [{ toObject: () => ({ dependencies: [] }) }] };
    },
  };

  await getAnnotationProfile('Callable').dependencies(session, 'callable');

  assert.match(query, /role: 'direct-step'/);
  assert.match(query, /role: 'direct-flow-block'/);
  assert.match(query, /dependencyKind: 'containment'/);
  assert.doesNotMatch(query, /AS callees/);
});

test('step dependencies are annotatable semantic members rather than visual proxies', async () => {
  let query = '';
  const session = {
    async run(text) {
      query = text;
      return { records: [{ toObject: () => ({ dependencies: [] }) }] };
    },
  };

  await getAnnotationProfile('Step').dependencies(session, 'step');

  assert.match(query, /member\.annotationKind IS NOT NULL/);
  assert.match(query, /NOT member:VisualProxy/);
  assert.match(query, /role: 'semantic-member'/);
  assert.match(query, /dependencyKind: 'containment'/);
  assert.match(query, /CASE WHEN member:Parameter THEN 'FunctionalEntity'/);
  assert.match(query, /recurse: NOT member:Parameter/);
  assert.match(query, /Call\|FnDeclaration/);
});

test('hinted subject lookup starts from an indexed label and canonicalizes a proxy', async () => {
  let query = '';
  const session = {
    async run(text) {
      query = text;
      return {
        records: [{
          toObject: () => ({
            requestedStableId: 'use-site',
            stableId: 'binding',
            labels: ['ValueSlot', 'LocalBinding'],
            annotationKind: 'Binding',
            requestedDiaName: 'value',
            requestedActionText: 'value',
            requestedOperationIndex: 10,
            requestedTypeText: null,
            requestedIsFnDeclaration: false,
          }),
        }],
      };
    },
  };

  const subjects = await resolveAnnotationSubjects(
    session,
    ['use-site'],
    new Map([['use-site', 'ValueUse']]),
  );

  assert.match(query, /MATCH \(requested:ValueAccess \{stableId: stableId\}\)/);
  assert.match(query, /canonicalBinding:ValueSlot/);
  assert.equal(subjects.get('use-site').stableId, 'binding');
  assert.equal(subjects.get('use-site').annotationKind, 'Binding');
  assert.equal(subjects.get('use-site').requestPoint.stableId, 'use-site');
});

test('call-site dependencies include callable execution-role bindings', async () => {
  let runCount = 0;
  const session = {
    async run() {
      runCount += 1;
      return {
        records: [{
          toObject: () => runCount === 1
            ? {
                dependencies: [],
                executionRoleBindingsJson: JSON.stringify({ incrementFunction: 'increment-fn' }),
                operationIndex: 42,
              }
            : { stableIds: ['increment-fn'] },
        }],
      };
    },
  };

  const dependencies = await getAnnotationProfile('CallSite').dependencies(session, 'site');

  assert.deepEqual(dependencies, [{
    stableId: 'increment-fn',
    annotationKind: 'Callable',
    role: 'incrementFunction',
    recurse: true,
    ordinal: 42,
  }]);
});

test('a concrete value access remains the annotation subject', () => {
  assert.equal(
    inferAnnotationKind(['Branch', 'Operand', 'Flow', 'ValueAccess', 'ValueRead']),
    'ValueUse',
  );
});

test('value-use profile resolves captured write targets as value origins', async () => {
  const queries = [];
  const session = {
    async run(text) {
      queries.push(text);
      return {
        records: [{
          toObject: () => queries.length === 1
            ? { context: { origin: { stableId: 'captured-slot' } } }
            : { dependencies: [{ stableId: 'source-slot', annotationKind: 'Binding', role: 'value-origin' }] },
        }],
      };
    },
  };
  const profile = getAnnotationProfile('ValueUse');

  assert.equal(profile.compositionContext, false);

  const context = await profile.context(session, 'write-site');
  const dependencies = await profile.dependencies(session, 'write-site');

  assert.equal(context.context.origin.stableId, 'captured-slot');
  assert.equal(dependencies[0].stableId, 'source-slot');
  assert.match(queries[0], /directBinding:ValueSlot/);
  assert.match(queries[0], /WRITES_VALUE/);
  assert.match(queries[0], /coalesce\(directBinding, linkedBinding\)/);
  assert.match(queries[0], /directWrites/);
  assert.match(queries[0], /forwardedWrites/);
  assert.match(queries[0], /ownerGuards/);
  assert.match(queries[0], /ownerCalls/);
  assert.doesNotMatch(queries[0], /ownerSyntax/);
  assert.match(queries[0], /USES_REFERENCE\|USES_MEMBER_REFERENCE/);
  assert.match(queries[0], /resolvedReferences/);
  assert.match(queries[0], /typescript-checker-rest-callback-forwarding/);
  assert.match(queries[0], /NOT target:Annotation/);
  assert.match(queries[0], /HAS_ANNOTATION/);
  assert.match(queries[1], /READS_VALUE\|WRITES_VALUE/);
  assert.match(queries[1], /directSlot:ValueSlot/);
  assert.match(queries[1], /coalesce\(directSlot, linkedSlot\)/);
});

test('a function declaration uses callable semantics even with a binding hint', () => {
  assert.equal(
    inferAnnotationKind(['FnDeclaration', 'ValueSlot', 'LocalBinding'], 'Binding'),
    'Callable',
  );
});

test('a developer-defined function head uses its callable steps rather than the generic entity walk', () => {
  assert.equal(
    inferAnnotationKind(['Fn', 'DeveloperDefined', 'ValueDeclaration', 'FunctionImplementation'], 'FunctionalEntity'),
    'Callable',
  );
});

test('annotation workflow selects only a task whose recursive dependencies are ready', () => {
  const blockedParent = {
    stableId: 'parent',
    status: 'pending',
    dependencies: [{ stableId: 'child', status: 'pending' }],
  };
  const readyLeaf = {
    stableId: 'child',
    status: 'pending',
    dependencies: [],
  };

  assert.equal(selectNextAnnotationTask([blockedParent, readyLeaf]), readyLeaf);
});

test('annotation text validation rejects character replacement caused by a broken client encoding', () => {
  assert.equal(validateAnnotationTextEncoding('Корректная аннотация.'), 'Корректная аннотация.');
  assert.throws(
    () => validateAnnotationTextEncoding('??????? ?????????? ????????'),
    /invalid character encoding/,
  );
  assert.throws(
    () => validateAnnotationTextEncoding('Повреждённый � текст'),
    /invalid character encoding/,
  );
  assert.throws(
    () => validateAnnotationTextEncoding('РџСЂРѕРґРѕР»Р¶Рё workflow'),
    /invalid character encoding/,
  );
});

test('annotation workflow accepts reference-only dependencies at the recursion boundary', () => {
  const boundedTask = {
    stableId: 'bounded',
    status: 'pending',
    dependencies: [{ stableId: 'outside', status: 'reference', referenceOnly: true }],
  };

  assert.equal(selectNextAnnotationTask([boundedTask]), boundedTask);

  const generatedTask = buildAnnotationTask({
    annotationId: 'annotation:bounded',
    stableId: 'bounded',
    annotationKind: 'Step',
    labels: ['Step'],
    context: {},
    dependencies: boundedTask.dependencies,
  }, 'bounded');
  assert.ok(generatedTask.requirements.some((requirement) => (
    requirement.includes('do not return a refusal')
    && requirement.includes('boundary error')
  )));
});

test('annotation task carries deterministic queue and lease identity into completion', () => {
  const task = buildAnnotationTask({
    annotationId: 'annotation:leaf',
    stableId: 'leaf',
    annotationKind: 'Step',
    labels: ['Step'],
    context: {},
    dependencies: [],
  }, 'root', {
    jobId: 'job',
    taskId: 'task',
    leaseToken: 'lease',
  });

  assert.equal(task.jobId, 'job');
  assert.equal(task.taskId, 'task');
  assert.equal(task.leaseToken, 'lease');
  assert.equal(task.completion.endpoint, '/api/annotation-tasks/task/complete');
  assert.equal(task.completion.body.jobId, 'job');
  assert.equal(task.completion.body.taskId, 'task');
  assert.equal(task.completion.body.leaseToken, 'lease');
});

test('annotation workflow reports no executable task for a dependency cycle', () => {
  const tasks = [
    { stableId: 'a', status: 'pending', dependencies: [{ stableId: 'b', status: 'pending' }] },
    { stableId: 'b', status: 'pending', dependencies: [{ stableId: 'a', status: 'pending' }] },
  ];

  assert.equal(selectNextAnnotationTask(tasks), null);
});

test('parameter annotation synthesizes one domain meaning from bottom-up evidence', () => {
  const task = buildAnnotationTask({
    annotationId: 'annotation:input',
    stableId: 'input',
    annotationKind: 'Binding',
    labels: ['ValueSlot', 'ParameterBinding'],
    context: { scope: 'parameter', history: [{ origins: [{ callerName: 'PromptInput' }] }] },
    dependencies: [{
      stableId: 'source-input',
      annotationKind: 'Binding',
      role: 'parameter-origin-binding',
      status: 'ready',
      annotation: 'Текст из поля ввода пользователя.',
    }, {
      stableId: 'consumer',
      annotationKind: 'Callable',
      role: 'value-use-callable',
      status: 'ready',
      annotation: 'Обрабатывает введённую строку.',
    }],
  }, 'input');

  assert.equal(task.synthesis.mode, 'bottom-up-semantic-summary');
  assert.match(task.objective, /domain meaning/);
  assert.ok(task.requirements.includes('Return exactly one concise sentence.'));
  assert.ok(task.requirements.some((requirement) => requirement.includes('Do not enumerate call sites')));
  assert.equal(task.contextBundle.dependencies[0].annotation, 'Текст из поля ввода пользователя.');
  assert.equal(task.contextBundle.dependencies[1].role, 'value-use-callable');
});

test('functional parameter task accumulates descendant annotations to the system boundary', () => {
  const task = buildAnnotationTask({
    annotationId: 'annotation:functional-helpers',
    stableId: 'helpers',
    annotationKind: 'FunctionalEntity',
    labels: ['ValueSlot', 'Parameter', 'DeveloperDefined', 'ValueDeclaration'],
    context: { syntax: 'helpers: Helpers', operations: [] },
    dependencies: [{
      stableId: 'clear-buffer',
      annotationKind: 'FunctionalEntity',
      role: 'functional-descendant',
      dependencyKind: 'functional-accumulation',
      status: 'ready',
      annotation: 'Очищает буфер и отменяет отложенную запись.',
    }],
  }, 'helpers');

  assert.equal(task.synthesis.mode, 'bottom-up-functional-accumulation');
  assert.equal(task.synthesis.boundary, 'System');
  assert.equal(task.synthesis.output, 'concise-capability-summary');
  assert.match(task.objective, /terminal system effects upward/);
  assert.ok(task.requirements.some((requirement) => requirement.includes('HAS_PARAMETER')));
  assert.equal(task.contextBundle.dependencies[0].annotation, 'Очищает буфер и отменяет отложенную запись.');
});

test('ordinary binding retains the history and mutation contract', () => {
  const task = buildAnnotationTask({
    annotationId: 'annotation:local',
    stableId: 'local',
    annotationKind: 'Binding',
    labels: ['ValueSlot'],
    context: { scope: 'local' },
    dependencies: [],
  }, 'local');

  assert.equal(task.synthesis, undefined);
  assert.ok(task.requirements.some((requirement) => requirement.includes('relevant mutations')));
  assert.equal(getAnnotationProfile('Binding').compositionContext, false);
});

test('execution primitive requests semantic configuration sources', () => {
  const task = buildAnnotationTask({
    annotationId: 'annotation:setting',
    stableId: 'setting',
    annotationKind: 'ExecutionPrimitive',
    labels: ['Primitive', 'Assign'],
    context: { sourceExpressions: [{ subjectText: 'process.env.IDLE_MINUTES' }] },
    dependencies: [],
  }, 'setting');

  assert.ok(task.requirements.some((requirement) => requirement.includes('feature flags and external settings')));
  assert.ok(task.requirements.some((requirement) => requirement.includes('configurationSemantics')));
  assert.ok(task.requirements.some((requirement) => requirement.includes('semantic source')));
});

test('execution primitive gathers exact-key configuration consumers through code-backed references', async () => {
  let query = '';
  const profile = getAnnotationProfile('ExecutionPrimitive');
  const session = {
    async run(text) {
      query = text;
      return {
        records: [{
          toObject: () => ({
            context: {
              configurationSemantics: {
                key: "'tengu_willow_mode'",
                defaultValue: "'off'",
                consumers: [],
              },
            },
          }),
        }],
      };
    },
  };

  const context = await profile.context(session, 'willow-mode');

  assert.equal(context.context.configurationSemantics.key, "'tengu_willow_mode'");
  assert.match(query, /peerKeyArgument\.action_text_raw = keyArgument\.action_text_raw/);
  assert.match(query, /USES_REFERENCE/);
  assert.match(query, /RESOLVES_TO/);
  assert.match(query, /effect\.operation_index, use\.operation_index/);
  assert.match(query, /controlledEffects/);
  assert.match(query, /configurationSemantics/);
});

test('execution primitive depends on every graph-linked expression operand', async () => {
  let query = '';
  const profile = getAnnotationProfile('ExecutionPrimitive');
  const session = {
    async run(text) {
      query = text;
      return {
        records: [{
          toObject: () => ({
            dependencies: [{
              stableId: 'is-query-active',
              annotationKind: 'Binding',
              role: 'expression-operand',
              dependencyKind: 'semantic',
              recurse: true,
              ordinal: 1,
            }, {
              stableId: 'is-external-loading',
              annotationKind: 'Binding',
              role: 'expression-operand',
              dependencyKind: 'semantic',
              recurse: true,
              ordinal: 2,
            }],
          }),
        }],
      };
    },
  };

  const dependencies = await profile.dependencies(session, 'is-loading');

  assert.deepEqual(dependencies.map((dependency) => dependency.stableId), [
    'is-query-active',
    'is-external-loading',
  ]);
  assert.match(query, /operand:ValueAccess/);
  assert.match(query, /'LEFT_OPERAND', 'RIGHT_OPERAND', 'TRUE', 'FALSE'/);
  assert.match(query, /expression-operand/);
  assert.match(query, /COMPOSES_SYNTAX/);
  assert.match(query, /canonical-expression-participant/);
  assert.match(query, /CALLS_VALUE\|READS_FROM\|RESOLVES_TO/);
  assert.match(query, /binding:Parameter/);
  assert.match(query, /candidate:Parameter/);
});

test('value-use annotation requires point-specific semantics instead of assignment narration', () => {
  const task = buildAnnotationTask({
    annotationId: 'annotation:value-use',
    stableId: 'use',
    annotationKind: 'ValueUse',
    labels: ['Branch', 'ValueAccess', 'ValueRead'],
    context: {
      syntax: 'idleHintShownRef.current',
      origin: { syntax: 'idleHintShownRef = useRef<string | false>(false)' },
    },
    dependencies: [{
      stableId: 'input-value-ref',
      annotationKind: 'Binding',
      role: 'value-origin',
      status: 'ready',
      annotation: 'Актуальное зеркало содержимого поля ввода.',
    }],
  }, 'use');

  assert.ok(task.requirements.some((requirement) => requirement.includes('exact request point')));
  assert.ok(task.requirements.some((requirement) => requirement.includes('Lead with the domain meaning')));
  assert.ok(task.requirements.some((requirement) => requirement.includes('Do not describe preceding or subsequent predicates')));
  assert.ok(task.requirements.some((requirement) => requirement.includes('Avoid generic descriptions')));
  assert.equal(task.contextBundle.dependencies[0].annotation, 'Актуальное зеркало содержимого поля ввода.');
});
