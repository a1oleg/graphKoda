const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildAnnotationWorkflowPrompt,
  classifyAnnotationWorkflowResponse,
  compactAnnotationClientContext,
  resolveAnnotationTargetStableId,
} = require('./annotationWorkflowPrompt');

test('annotation target falls back to the graph target when the visual item has no stable id', () => {
  assert.equal(resolveAnnotationTargetStableId({
    stableId: '',
    targetStableId: 'screens/REPL.tsx:3293:12:3293:22',
  }), 'screens/REPL.tsx:3293:12:3293:22');
  assert.equal(resolveAnnotationTargetStableId({
    stableId: 'source',
    targetStableId: 'target',
  }), 'source');
});

test('annotation handoff keeps only draw.io insertion identity', () => {
  const context = compactAnnotationClientContext({
    diagramPath: 'graph/draw/flow.drawio',
    cellId: 'n255',
    labels: ['Method', 'Value'],
    label: 'submitsNow',
    x: 98.5,
    y: 38,
    width: 186,
    height: 57,
  });

  assert.deepEqual(context, {
    diagramPath: 'graph/draw/flow.drawio',
    element: { cellId: 'n255' },
  });
});

test('annotation prompt requests graph context instead of embedding the task', () => {
  const prompt = buildAnnotationWorkflowPrompt({
    orchestratorBaseUrl: 'http://127.0.0.1:8791/',
    stableId: 'screens/REPL.tsx:3343:10:3343:20',
    clientContext: {
      diagramPath: 'graph/draw/flow.drawio',
      element: { cellId: 'n255' },
    },
    refreshMode: 'root',
  });

  assert.match(prompt, /POST http:\/\/127\.0\.0\.1:8791\/api\/annotation-jobs/);
  assert.match(prompt, /"stableId": "screens\/REPL\.tsx:3343:10:3343:20"/);
  assert.match(prompt, /"cellId": "n255"/);
  assert.match(prompt, /"refreshMode": "root"/);
  assert.match(prompt, /JSON в UTF-8/);
  assert.match(prompt, /Продолжи graph-first annotation workflow/);
  assert.doesNotMatch(prompt, /"contextBundle"|"labels"|"width"|"height"/);
});

test('annotation workflow treats waiting as a valid in-progress state', () => {
  assert.equal(classifyAnnotationWorkflowResponse({ status: 'waiting' }), 'waiting');
  assert.equal(classifyAnnotationWorkflowResponse({ status: 'queued' }), 'generate');
  assert.equal(classifyAnnotationWorkflowResponse({ status: 'needs-generation', task: {} }), 'generate');
  assert.equal(classifyAnnotationWorkflowResponse({ status: 'ready' }), 'ready');
  assert.equal(classifyAnnotationWorkflowResponse({ status: 'needs-generation' }), 'unexpected');
});
