import test from 'node:test';
import assert from 'node:assert/strict';
import { initialOriginPlan, applyOriginExpansion, originTaskId, inspectOrigin } from './valueOrigin.js';

test('start queues only the root; each expansion consumes one pending task', () => {
  const plan = initialOriginPlan('input');
  const expanded = applyOriginExpansion(plan, plan.rootId, { profile: 'ParameterOrigins', children: [
    { stableId: 'argument', relation: 'BINDS_TO_PARAMETER', direction: 'incoming', context: { callSiteId: 'a' } },
    { stableId: 'argument', relation: 'BINDS_TO_PARAMETER', direction: 'incoming', context: { callSiteId: 'b' } },
  ] });
  assert.equal(plan.revision, 0);
  assert.equal(expanded.revision, 1);
  assert.equal(expanded.nodes.length, 3);
  assert.equal(expanded.nodes.filter(n => n.state === 'PENDING').length, 2);
  assert.throws(() => applyOriginExpansion(expanded, plan.rootId, {}), /pending/);
});
test('slice identity includes use site, selected value and invocation frame', () => {
  const values = [ {}, { atStableId: 'use' }, { selection: '.name' }, { frames: [{ callSiteId: 'call' }] } ];
  assert.equal(new Set(values.map(v => originTaskId('value', v))).size, 4);
});
test('missing evidence and depth limits never report a complete source path', () => {
  const plan = initialOriginPlan('input', 0);
  const limited = applyOriginExpansion(plan, plan.rootId, { children: [{ stableId: 'arg', context: {}, relation: 'VALUE_FROM' }] });
  assert.equal(limited.status, 'INCOMPLETE');
  assert.equal(limited.nodes[1].reason, 'DEPTH_BOUNDARY');
  const missing = applyOriginExpansion(plan, plan.rootId, { reason: 'RESULT_SLICE_REQUIRED' });
  assert.equal(missing.status, 'INCOMPLETE');
});
test('parameter origins preserve all bindings without JSX preference or name matching', async () => {
  let calls = 0;
  const session = { async run(query) {
    calls++;
    if (calls === 1) return { records: [{ get: key => key === 'labels' ? ['Parameter', 'DeveloperDefined'] : {} }] };
    if (query.includes('TYPED_AS')) return { records: [] };
    assert.match(query, /BINDS_TO_PARAMETER/);
    assert.doesNotMatch(query, /typescript-checker-jsx-prop-flow/);
    return { records: ['jsx', 'direct'].map((callSiteId, i) => ({ toObject: () => ({
      stableId: `arg:${i}`, syntax: i ? 'otherName' : 'input', callSiteId,
      parameterIndex: 0, argumentIndex: 0, binding: { resolution: callSiteId },
    }) })) };
  } };
  const result = await inspectOrigin(session, initialOriginPlan('input').nodes[0]);
  assert.equal(result.children.length, 2);
  assert.equal(result.children[1].context.atStableId, 'direct');
  assert.equal(result.children[1].syntax, 'otherName');
});

test('structured parameter exposes members before querying call sites', async () => {
  const names = ['first', 'second', 'third'];
  const session = { async run(query) {
    if (query.includes('RETURN labels')) return { records: [{ get: key => key === 'labels' ? ['Parameter'] : {} }] };
    assert.match(query, /TYPED_AS/);
    assert.doesNotMatch(query, /BINDS_TO_PARAMETER/);
    return { records: names.map(name => ({ toObject: () => ({ stableId: `type:${name}`, name, syntax: `${name}: () => void` }) })) };
  } };
  const plan = initialOriginPlan('parameter');
  const expansion = await inspectOrigin(session, plan.nodes[0]);
  assert.equal(expansion.profile, 'ParameterStructure');
  const next = applyOriginExpansion(plan, plan.rootId, expansion);
  assert.equal(next.nodes.length, 4);
  assert.deepEqual(next.nodes.slice(1).map(n => n.context.memberPath), names.map(name => [name]));
  assert.ok(next.nodes.slice(1).every(n => n.state === 'PENDING' && n.context.parameterId === 'parameter'));
});

test('selected member follows scoped field sources, not argument objects', async () => {
  const session = { async run(query, params) {
    if (query.includes('RETURN labels')) return { records: [{ get: key => key === 'labels' ? ['MemberDeclaration'] : {} }] };
    assert.match(query, /BINDS_TO_PARAMETER/);
    assert.match(query, /HAS_PROPERTY/);
    assert.match(query, /SATISFIES_MEMBER/);
    assert.match(query, /VALUE_FROM\|RESOLVES_TO/);
    assert.equal(params.id, 'member');
    assert.equal(params.parameterId, 'parameter');
    return { records: [{ toObject: () => ({ stableId: 'setter', fieldId: 'field', argumentId: 'object', originRelation: 'RESOLVES_TO', callSiteId: 'call', parameterIndex: 1, argumentIndex: 1 }) }] };
  } };
  const item = { stableId: 'member', context: { selection: 'member-origin', memberDeclarationId: 'member', parameterId: 'parameter', memberPath: ['first'], frames: [] } };
  const expansion = await inspectOrigin(session, item);
  assert.equal(expansion.profile, 'MemberOrigins');
  assert.equal(expansion.children[0].stableId, 'setter');
  assert.deepEqual(expansion.children[0].context.memberPath, []);
  assert.deepEqual(expansion.children[0].context.frames[0].memberPath, ['first']);
  assert.equal(expansion.children[0].context.frames[0].parameterId, 'parameter');
  assert.deepEqual(expansion.children[0].path.nodes, ['member', 'field', 'setter']);
});

test('missing member path is reported, not replaced by a whole-object task', async () => {
  const session = { async run(query) {
    if (query.includes('RETURN labels')) return { records: [{ get: key => key === 'labels' ? ['MemberDeclaration'] : {} }] };
    return { records: [{ toObject: () => ({ argumentId: 'object', fieldId: null, stableId: null }) }] };
  } };
  const result = await inspectOrigin(session, { stableId: 'member', context: {
    selection: 'member-origin', memberDeclarationId: 'member', parameterId: 'parameter', memberPath: ['field'], frames: [],
  } });
  assert.equal(result.reason, 'MEMBER_SOURCE_PATH_MISSING');
  assert.deepEqual(result.children, []);
});
test('a function does not expand every Step when a return slice is unavailable', async () => {
  const session = { run: async () => ({ records: [{ get: key => key === 'labels' ? ['Fn'] : {} }] }) };
  const result = await inspectOrigin(session, initialOriginPlan('fn').nodes[0]);
  assert.equal(result.reason, 'RESULT_SLICE_REQUIRED');
  assert.deepEqual(result.children, []);
});

test('local purpose boundary requires writer, owner and a continuous consumption path', async () => {
  const path = [{ from: 'state', to: 'read', relation: 'RESOLVES_TO', direction: 'incoming' },
    { from: 'read', to: 'op', relation: 'CONSUMES_VALUE', direction: 'incoming' }];
  const item = { stableId: 'op', context: { selection: 'usage', objective: 'purpose', frames: [],
    purposeState: { writerId: 'setter', stateId: 'state' }, usagePath: path } };
  let proof = true;
  const session = { async run(query) {
    if (query.includes('RETURN labels')) return { records: [{ get: key => key === 'labels' ? ['ValueConsumption'] : {} }] };
    if (query.includes('writer {')) {
      assert.match(query, /ENCLOSED_BY/);
      assert.match(query, /all\(edge IN \$path/);
      return { records: proof ? [{ toObject: () => ({ ownerId: 'component', consumerId: 'op' }) }] : [] };
    }
    return { records: [] };
  } };
  const expansion = await inspectOrigin(session, item);
  assert.equal(expansion.purposeBoundary, true);
  assert.equal(expansion.boundary, undefined);
  const plan = initialOriginPlan('op');
  assert.equal(applyOriginExpansion(plan, plan.rootId, expansion).nodes[0].state, 'PURPOSE_BOUNDARY');
  proof = false;
  assert.ok(!(await inspectOrigin(session, item)).purposeBoundary);
  proof = true;
  assert.ok(!(await inspectOrigin(session, { ...item, context: { ...item.context, usagePath: path.slice(1) } })).purposeBoundary);
  assert.ok(!(await inspectOrigin(session, { ...item, context: { ...item.context, objective: 'mechanism' } })).purposeBoundary);
  assert.notEqual(initialOriginPlan('op').rootId, initialOriginPlan('op', 8, 'value', 'mechanism').rootId);
});
