import assert from 'node:assert/strict';
import test from 'node:test';
import { omitEntryParameters, expandedFunctionView } from './expandedFunctionView.mjs';

const node = (key, labels, step, fn = 'root') => ({ key, labels,
  props: { parentFnStableId: fn, parentStepStableId: step } });
const edge = (start, end, type = 'NEXT') => ({ start, end, type });

test('secondary view removes complete parameter families, not body reads or nested parameters', () => {
  const nodes = [node('start', ['FunctionStart']), node('param', ['Parameter'], 'signature'),
    node('field', ['Field'], 'signature'), node('close', ['Join'], 'signature'),
    node('signature', ['Step']), node('body', ['ValueAccess'], 'statement'),
    node('nested', ['Parameter'], 'nested-signature', 'callback')];
  const edges = [edge('start', 'param'), edge('param', 'field', 'FIELD'),
    edge('field', 'close', 'FieldJoin'), edge('close', 'body'), edge('body', 'param', 'READS_VALUE')];
  const before = JSON.stringify({ nodes, edges });
  const view = omitEntryParameters(nodes, edges, 'root');
  assert.deepEqual(view.nodes.map(n => n.key), ['start', 'body', 'nested']);
  assert.deepEqual(view.edges.map(e => [e.start, e.end, e.type]), [['start', 'body', 'NEXT']]);
  assert.equal(JSON.stringify({ nodes, edges }), before);
});

test('parameter-free functions remain unchanged and ambiguous continuations fail explicitly', () => {
  const nodes = [node('start', ['FunctionStart']), node('body', ['Call'])];
  const edges = [edge('start', 'body')];
  assert.deepEqual(omitEntryParameters(nodes, edges, 'root'), { nodes, edges });
  assert.throws(() => omitEntryParameters([...nodes, node('p', ['Parameter'])],
    [edge('start', 'p'), edge('p', 'body'), edge('p', 'start')], 'root'), /one body continuation/);
  assert.equal(expandedFunctionView.kind, 'expanded-functions');
});
