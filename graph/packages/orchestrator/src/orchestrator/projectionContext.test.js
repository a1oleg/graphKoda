import assert from 'node:assert/strict';
import test from 'node:test';
import { loadProjectionDependencies, projectionProfiles } from './projectionContext.js';
import { getAnnotationProfile, inferAnnotationKind } from './annotationProfiles.js';

const record = row => ({ get: key => row[key] });
test('separate call sites stay separate even when they reuse one selector function', async () => {
  const session = { async run() { return {records:[
    record({stableId:'left',selectorId:'call-left',memberId:'member-left',nodeIds:['left','call-left','selector'],relationshipTypes:['VALUE_FROM','HAS_ARGUMENT']}),
    record({stableId:'right',selectorId:'call-right',memberId:'member-right',nodeIds:['right','call-right','selector'],relationshipTypes:['VALUE_FROM','HAS_ARGUMENT']}),
  ]}; } };
  const result=await loadProjectionDependencies(session,['left','right']);
  assert.equal(result.get('left')[0].stableId,'call-left');
  assert.equal(result.get('right')[0].stableId,'call-right');
  assert.equal(result.get('left')[0].annotationKind,'Projection');
});
test('a focused gateway does not also expand its unrestricted functional dependencies', async () => {
  let calls=0;
  const session={async run(){calls++;return {records:[record({stableId:'selected',selectorId:'call',nodeIds:['selected','call'],relationshipTypes:['VALUE_FROM']})]};}};
  const result=await getAnnotationProfile('FunctionalEntity').dependenciesMany(session,['selected']);
  assert.equal(calls,1);
  assert.deepEqual(result.get('selected').map(x=>x.stableId),['call']);
});
test('runtime-selected members keep their focused profile even when also type members', () => {
  assert.equal(inferAnnotationKind(['TypeMember','DeveloperDefined','MemberDeclaration'],'SelectedMember'),'SelectedMember');
  assert.equal(inferAnnotationKind(['TypeMember','DeveloperDefined','MemberDeclaration']),null);
  assert.equal(inferAnnotationKind(['Call','DeveloperDefined'],'Projection'),'Projection');
});
test('missing writers are an explicit boundary, not permission for an aggregate fallback', async () => {
  const session={async run(){return {records:[]};}};
  const result=await projectionProfiles.SelectedMember.contextMany(session,['field']);
  assert.equal(result.get('field').resolutionStatus,'no-proven-writers');
  assert.deepEqual(result.get('field').writes,[]);
});
