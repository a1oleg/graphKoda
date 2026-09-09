const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('visualizer command uses the API, reuses its Webview, and rejects foreign URLs', async () => {
  const source = fs.readFileSync(require.resolve('./extension.js'), 'utf8');
  const start = source.indexOf('async function openAnnotationVisualizer(');
  const end = source.indexOf('\nfunction runStubApp(', start);
  let created = 0, requested, disposed;
  let url = 'http://127.0.0.1:8791/annotation-plan/assets/replay.html?stableId=test';
  let receiveMessage;
  const panel = {webview: {onDidReceiveMessage(callback) {receiveMessage = callback;}}, reveal() {}, onDidDispose(callback) { disposed = callback; }};
  const sandbox = {
    URL, URLSearchParams, crypto: require('node:crypto'), path: require('node:path'), annotationVisualizerPanel: null,
    callOrchestratorJson: async (_root, path) => { requested = path; return {url, title:'test'}; },
    resolveOrchestratorBaseUrl: () => 'http://127.0.0.1:8791',
    resolveSourceRoot: root => root,
    escapeHtml: value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;'),
    vscode: {ViewColumn:{Active:1}, window:{createWebviewPanel(_type, _title, _column, options) {
      created++; assert.equal(options.enableScripts, true); return panel;
    }}},
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end), sandbox);
  const context = {subscriptions:[]};
  await sandbox.openAnnotationVisualizer(context, 'workspace', 'source:1:2');
  assert.equal(new URL(requested, url).searchParams.get('stableId'), 'source:1:2');
  assert.match(panel.webview.html, /<iframe/);
  assert.match(panel.webview.html, /host=vscode/);
  assert.match(panel.webview.html, /event.source !== frame.contentWindow/);
  let sent;
  sandbox.addTextToCodexThread = async (text,stableId) => {sent={text,stableId};};
  await receiveMessage({type:'annotationVisualizer',action:'addToChat',text:'node context',stableId:'source:1:2'});
  assert.deepEqual(sent, {text:'node context',stableId:'source:1:2'});
  assert.match(panel.webview.html, /\['addToChat', 'openSource'\]/);
  await receiveMessage({type:'annotationVisualizer',action:'openSource',file:'../secret',line:1});
  assert.match(panel.webview.html, /frame-src http:\/\/127.0.0.1:8791/);
  await sandbox.openAnnotationVisualizer(context, 'workspace', 'source:1:2');
  assert.equal(created, 1);
  disposed(); assert.equal(sandbox.annotationVisualizerPanel, null);
  url = 'https://example.com/annotation-plan/assets/replay.html';
  await assert.rejects(sandbox.openAnnotationVisualizer(context, 'workspace', 'source:1:2'), /Unexpected/);
});
