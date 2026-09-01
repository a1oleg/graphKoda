import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRuntimePathSelection } from './runtimePathDrawio.mjs';

const fixtureXml = '<mxfile><diagram id="p"><mxGraphModel><root>'
  + '<mxCell id="0"/><mxCell id="1" parent="0"/>'
  + '<mxCell id="a" vertex="1" parent="1" stableId="a" style="strokeWidth=1;"/>'
  + '<mxCell id="b" vertex="1" parent="1" stableId="b" style="strokeWidth=1;"/>'
  + '<mxCell id="c" vertex="1" parent="1" stableId="c" style="strokeWidth=1;"/>'
  + '<mxCell id="ab" edge="1" parent="1" source="a" target="b" stableId="a" targetStableId="b" edgeType="NEXT" style="strokeWidth=1;"/>'
  + '<mxCell id="bc" edge="1" parent="1" source="b" target="c" stableId="b" targetStableId="c" edgeType="NEXT" style="strokeWidth=1;"/>'
  + '</root></mxGraphModel></diagram></mxfile>';

test('builds a transient runtime selection without changing draw.io XML', () => {
  const selection = buildRuntimePathSelection(fixtureXml, [
    { stableId: 'a', role: 'call' },
    { stableId: 'c', role: 'call' },
  ]);
  assert.deepEqual(selection.involvedEdgeIds.sort(), ['ab', 'bc']);
  assert.equal(fixtureXml.includes('runtimeObserved'), false);
  assert.deepEqual(selection.edgePairs.map((edge) => edge.edgeType), ['NEXT', 'NEXT']);
});

test('uses causally adjacent events instead of also highlighting a predicate shortcut', () => {
  const xml = '<mxfile><diagram id="p"><mxGraphModel><root>'
    + '<mxCell id="0"/><mxCell id="1" parent="0"/>'
    + '<mxCell id="p" vertex="1" parent="1" stableId="p"/>'
    + '<mxCell id="a" vertex="1" parent="1" stableId="a"/>'
    + '<mxCell id="shortcut" vertex="1" parent="1" stableId="shortcut"/>'
    + '<mxCell id="b" vertex="1" parent="1" stableId="b"/>'
    + '<mxCell id="q" vertex="1" parent="1" stableId="q"/>'
    + '<mxCell id="end" vertex="1" parent="1" stableId="end"/>'
    + '<mxCell id="p-true" edge="1" source="p" target="a" stableId="p" targetStableId="a" edgeType="TRUE"/>'
    + '<mxCell id="a-shortcut" edge="1" source="a" target="shortcut" stableId="a" targetStableId="shortcut" edgeType="NEXT"/>'
    + '<mxCell id="shortcut-q" edge="1" source="shortcut" target="q" stableId="shortcut" targetStableId="q" edgeType="NEXT"/>'
    + '<mxCell id="a-b" edge="1" source="a" target="b" stableId="a" targetStableId="b" edgeType="NEXT"/>'
    + '<mxCell id="b-q" edge="1" source="b" target="q" stableId="b" targetStableId="q" edgeType="NEXT"/>'
    + '<mxCell id="q-false" edge="1" source="q" target="end" stableId="q" targetStableId="end" edgeType="FALSE"/>'
    + '</root></mxGraphModel></diagram></mxfile>';
  const selection = buildRuntimePathSelection(xml, [
    { stableId: 'p', role: 'predicate', outcome: true },
    { stableId: 'a', role: 'call' },
    { stableId: 'b', role: 'call' },
    { stableId: 'q', role: 'predicate', outcome: false },
  ]);

  assert.deepEqual(selection.involvedEdgeIds.sort(), ['a-b', 'b-q', 'p-true', 'q-false']);
});

test('bridges invisible Step events through joins and expands executed argument data', () => {
  const xml = '<mxfile><diagram id="p"><mxGraphModel><root>'
    + '<mxCell id="0"/><mxCell id="1" parent="0"/>'
    + '<mxCell id="call" vertex="1" parent="1" stableId="call"/>'
    + '<mxCell id="arg" vertex="1" parent="1" stableId="arg"/>'
    + '<mxCell id="close" vertex="1" parent="1" stableId="close"/>'
    + '<mxCell id="join" vertex="1" parent="1" stableId="join" graphLabels="Flow,Join,Exclusive"/>'
    + '<mxCell id="next" vertex="1" parent="1" stableId="next"/>'
    + '<mxCell id="arg-edge" edge="1" source="call" target="arg" stableId="call" targetStableId="arg" edgeType="ARG"/>'
    + '<mxCell id="arg-join" edge="1" source="arg" target="close" stableId="arg" targetStableId="close" edgeType="ArgJoin"/>'
    + '<mxCell id="to-join" edge="1" source="call" target="join" stableId="call" targetStableId="join" edgeType="NEXT"/>'
    + '<mxCell id="after-join" edge="1" source="join" target="next" stableId="join" targetStableId="next" edgeType="NEXT"/>'
    + '</root></mxGraphModel></diagram></mxfile>';
  const selection = buildRuntimePathSelection(xml, [
    { stableId: 'call', role: 'call' },
    { stableId: 'invisible-step', role: 'step' },
    { stableId: 'next', role: 'call' },
  ]);

  assert.deepEqual(
    selection.involvedEdgeIds.sort(),
    ['after-join', 'arg-edge', 'arg-join', 'to-join'],
  );
  assert.deepEqual(selection.nodeHighlights, [
    { stableId: 'join', role: 'join-stage', outcome: undefined },
  ]);
});

test('activates every rendered part of a graph node and reaches its data join', () => {
  const xml = '<mxfile><diagram id="p"><mxGraphModel><root>'
    + '<mxCell id="0"/><mxCell id="1" parent="0"/>'
    + '<mxCell id="result-group" vertex="1" parent="1" stableId="result"/>'
    + '<mxCell id="result-port" vertex="1" parent="result-group" stableId="result"/>'
    + '<mxCell id="join" vertex="1" parent="1" stableId="join" graphLabels="DataJoin"/>'
    + '<mxCell id="selected" edge="1" source="branch" target="result-port" stableId="branch" targetStableId="result" edgeType="FALSE"/>'
    + '<mxCell id="joined" edge="1" source="result-group" target="join" stableId="result" targetStableId="join" edgeType="XOR_JOIN"/>'
    + '<mxCell id="branch" vertex="1" parent="1" stableId="branch" graphLabels="Branch"/>'
    + '</root></mxGraphModel></diagram></mxfile>';
  const selection = buildRuntimePathSelection(xml, [
    { stableId: 'branch', role: 'predicate', outcome: false },
    { stableId: 'result', role: 'value' },
  ]);
  assert.deepEqual(selection.involvedEdgeIds.sort(), ['joined', 'selected']);
  assert.ok(selection.nodeHighlights.some((entry) => entry.stableId === 'join' && entry.role === 'join-stage'));
});

test('selects one optional value return by producer outcome', () => {
  const xml = '<mxfile><diagram id="p"><mxGraphModel><root>'
    + '<mxCell id="0"/><mxCell id="1" parent="0"/>'
    + '<mxCell id="branch" vertex="1" parent="1" stableId="branch"/>'
    + '<mxCell id="set" vertex="1" parent="1" stableId="set"/>'
    + '<mxCell id="top" edge="1" parent="1" source="branch" target="set" stableId="branch" targetStableId="set" edgeType="ASSIGNS_VALUE" producerOutcome="true"/>'
    + '<mxCell id="bottom" edge="1" parent="1" source="branch" target="set" stableId="branch" targetStableId="set" edgeType="ASSIGNS_VALUE" producerOutcome="false"/>'
    + '</root></mxGraphModel></diagram></mxfile>';
  const selection = buildRuntimePathSelection(xml, [
    { stableId: 'branch', role: 'predicate', outcome: false },
    { stableId: 'set', role: 'value', outcome: undefined },
  ]);
  assert.deepEqual(selection.involvedEdgeIds, ['bottom']);
  assert.deepEqual(selection.edgePairs.map((edge) => edge.producerOutcome), ['false']);
  assert.deepEqual(selection.nodeHighlights, [
    { stableId: 'branch', role: 'predicate-stage', outcome: false },
  ]);
});
