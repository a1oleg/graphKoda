const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const vscode = require('vscode');
const { diagramFilePath, ensureDiagramFile } = require('./diagramFiles');
const { resolveActiveDiagramPath } = require('./diagramContext');
const {
  buildAnnotationWorkflowPrompt,
  classifyAnnotationWorkflowResponse,
  compactAnnotationClientContext,
  resolveAnnotationTargetStableId,
} = require('./annotationWorkflowPrompt');

let drawioStaticServer = null;
let graphCommandServer = null;
let orchestratorEnsurePromise = null;
let stubAppTerminal = null;
let runtimeAnalysisPanel = null;
let runtimeAnalysisState = null;
let annotationVisualizerPanel = null;
let runtimeHighlightBridgeRevision = 0;
let runtimeHighlightBridgeMessage = null;
let runtimeHighlightBridgeFunctionStableId = '';
const diagramPanelsByPath = new Map();

const GRAPH_COMMAND_PORT = 17843;

const EXTENSION_VERSION = require('./package.json').version;
const FUNCTION_DIAGRAMS = [
  {
    name: 'onSubmit',
    sourceFile: 'REPL.tsx',
    sourceLine: 3142,
    stableId: 'screens/REPL.tsx:3142:31:3533:3',
    rootStableId: 'screens/REPL.tsx:3142:31:3533:3',
  },
].map((diagram) => ({
  ...diagram,
  title: `${diagram.name}-${diagram.sourceFile}-${diagram.sourceLine}`,
}));
const HELPERS_FUNCTIONAL_SEGMENT = {
  stableId: 'screens/REPL.tsx:3142:53:3142:80',
  label: 'helpers',
};

class GraphNode {
  constructor(kind, payload) {
    this.kind = kind;
    this.payload = payload;
    this.id = `${kind}:${payload.renderer || 'default'}:${payload.stableId || payload.label}`;
  }
}

class GraphExplorerProvider {
  constructor(workspaceRoot, extensionPath) {
    this.workspaceRoot = workspaceRoot;
    this.extensionPath = extensionPath;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node) {
    const item = new vscode.TreeItem(node.payload.label, vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    item.description = node.payload.description || '';
    item.tooltip = [node.payload.label, node.payload.stableId, node.payload.tooltip || 'draw.io'].join('\n');
    item.iconPath = node.payload.iconPath
      ? vscode.Uri.file(node.payload.iconPath)
      : new vscode.ThemeIcon(node.payload.icon || 'symbol-method');
    item.contextValue = node.kind;
    item.command = {
      command: node.payload.command || 'coldKodeGraphExplorer.openNode',
      title: node.payload.commandTitle || 'Open Graph',
      arguments: [node],
    };
    return item;
  }

  async getChildren(node) {
    if (node) return [];
    return [
      new GraphNode('action', {
        label: 'Run app (stub)',
        description: 'response: заглушка',
        tooltip: 'Launch the interactive app without model API calls',
        icon: 'play',
        command: 'coldKodeGraphExplorer.runStubApp',
        commandTitle: 'Run App (Stub)',
      }),
      new GraphNode('action', {
        label: 'Нарисовать Фишера',
        description: 'Aura → draw.io',
        tooltip: 'Фишер-Йетс: раскрыть вызываемые функции на одной диаграмме',
        icon: 'type-hierarchy-sub',
        command: 'coldKodeGraphExplorer.openFisherYates',
        commandTitle: 'Нарисовать Фишера',
      }),
      ...FUNCTION_DIAGRAMS.map((diagram) => new GraphNode('function', {
      ...diagram,
      label: diagram.title,
      renderer: 'drawio-function',
      tooltip: path.relative(this.workspaceRoot, diagramFilePath(this.workspaceRoot, {
        kind: 'flow',
        functionStableId: diagram.rootStableId,
        label: diagram.name,
      })),
      iconPath: path.join(this.extensionPath, 'media', 'graph-flow.svg'),
      })),
    ];
  }
}

async function activate(context) {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || context.extensionPath;
  const provider = new GraphExplorerProvider(workspaceRoot, context.extensionPath);

  try {
    await trustCanonicalDrawioPlugin(workspaceRoot);
  } catch (error) {
    console.warn(`Could not register the canonical draw.io plugin fingerprint: ${error?.message || error}`);
  }

  const drawioPluginWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      workspaceRoot,
      'graph/vendor/drawio/src/main/webapp/plugins/codexGraph.js',
    ),
  );
  const refreshDrawioPluginTrust = () => trustCanonicalDrawioPlugin(workspaceRoot).catch((error) => {
    console.warn(`Could not refresh the canonical draw.io plugin fingerprint: ${error?.message || error}`);
  });

  startGraphCommandServer(context, workspaceRoot).catch((error) => {
    vscode.window.showErrorMessage(`Graph command bridge failed: ${error?.message || error}`);
  });

  context.subscriptions.push(
    drawioPluginWatcher,
    drawioPluginWatcher.onDidCreate(refreshDrawioPluginTrust),
    drawioPluginWatcher.onDidChange(refreshDrawioPluginTrust),
    vscode.window.registerUriHandler({
      handleUri: (uri) => handleGraphContextUri(context, workspaceRoot, uri),
    }),
    vscode.window.registerTreeDataProvider('coldKodeGraphExplorer.functions', provider),
    vscode.window.onDidCloseTerminal((terminal) => {
      if (terminal === stubAppTerminal) stubAppTerminal = null;
    }),
    vscode.commands.registerCommand('coldKodeGraphExplorer.refresh', () => {
      clearDiagramCache(workspaceRoot);
      provider.refresh();
    }),
    vscode.commands.registerCommand('coldKodeGraphExplorer.openNode', (node) => openNodeDiagram(context, workspaceRoot, node)),
    vscode.commands.registerCommand('coldKodeGraphExplorer.openFisherYates', async () => {
      try {
        const outputPath = path.join(workspaceRoot, 'graph/draw/generated/Fisher-Yates.drawio');
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Фишер-Йетс из Aura' }, () => new Promise((resolve, reject) => {
          execFile(process.platform === 'win32' ? 'node.exe' : 'node', ['dev/exportFisherYatesDrawio.mjs', '--output', outputPath], {
            cwd: workspaceRoot, env: { ...process.env }, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 16 * 1024 * 1024,
          }, (error, stdout, stderr) => error ? reject(new Error([error.message, stderr, stdout].filter(Boolean).join('\n'))) : resolve());
        }));
        await openDrawioFile(outputPath);
      } catch (error) { vscode.window.showErrorMessage(`Fisher-Yates: ${error?.message || error}`); }
    }),
    vscode.commands.registerCommand('coldKodeGraphExplorer.openRuntimeAnalysis', (item) => openRuntimeAnalysis(context, workspaceRoot, item || {})),
    vscode.commands.registerCommand('coldKodeGraphExplorer.openAnnotationVisualizer', async (item) => {
      try {
        const stableId = typeof item === 'string' ? item : item?.payload?.stableId || item?.stableId || 'screens/REPL.tsx:3142:82:3146:3';
        await openAnnotationVisualizer(context, workspaceRoot, stableId);
      } catch (error) {
        vscode.window.showErrorMessage(`Annotation visualizer failed: ${error?.message || error}`);
      }
    }),
    vscode.commands.registerCommand('coldKodeGraphExplorer.openHelpersFunctionalSegment', async () => {
      try {
        await openFunctionalSegmentDiagram(context, workspaceRoot, HELPERS_FUNCTIONAL_SEGMENT);
      } catch (error) {
        vscode.window.showErrorMessage(`Helpers functional segment failed: ${error?.message || error}`);
      }
    }),
    vscode.commands.registerCommand('coldKodeGraphExplorer.runStubApp', () => runStubApp(workspaceRoot)),
  );
}

async function openAnnotationVisualizer(context, workspaceRoot, stableId) {
  const query = new URLSearchParams({ stableId });
  const launch = await callOrchestratorJson(workspaceRoot, `/api/annotations/visualizer?${query}`);
  const baseUrl = new URL(resolveOrchestratorBaseUrl(workspaceRoot));
  const url = new URL(launch.url);
  if (url.origin !== baseUrl.origin || url.pathname !== '/annotation-plan/assets/replay.html') {
    throw new Error('Unexpected annotation visualizer URL');
  }
  url.searchParams.set('host', 'vscode');
  if (!annotationVisualizerPanel) {
    annotationVisualizerPanel = vscode.window.createWebviewPanel(
      'coldKodeAnnotationVisualizer', 'Annotation Visualizer', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [],
        portMapping: [{ webviewPort: Number(url.port || 80), extensionHostPort: Number(url.port || 80) }] },
    );
    context.subscriptions.push(annotationVisualizerPanel);
    annotationVisualizerPanel.webview.onDidReceiveMessage(async (message) => {
      if (message?.type !== 'annotationVisualizer') return;
      try {
        if (message.action === 'addToChat' && typeof message.text === 'string') {
          await addTextToCodexThread(message.text, typeof message.stableId === 'string' ? message.stableId : '', null, { includeStableIdHeader: false });
        } else if (message.action === 'openSource' && typeof message.file === 'string') {
          const sourceRoot = resolveSourceRoot(workspaceRoot);
          const target = path.resolve(sourceRoot, message.file);
          const relative = path.relative(sourceRoot, target);
          if (relative.startsWith('..') || path.isAbsolute(relative) || !Number.isInteger(message.line) || message.line < 1) return;
          const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
          const line = Math.min(message.line - 1, document.lineCount - 1);
          await vscode.window.showTextDocument(document, { selection: new vscode.Range(line, 0, line, 0) });
        }
      } catch (error) { vscode.window.showErrorMessage(`Annotation action failed: ${error?.message || error}`); }
    });
    annotationVisualizerPanel.onDidDispose(() => { annotationVisualizerPanel = null; });
  }
  annotationVisualizerPanel.title = `Annotation: ${launch.title}`;
  const nonce = crypto.randomBytes(16).toString('hex');
  annotationVisualizerPanel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${escapeHtml(url.origin)}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style>
    </head><body><iframe title="Annotation Visualizer" src="${escapeHtml(url.href)}"></iframe>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi(), frame = document.querySelector('iframe');
      window.addEventListener('message', event => {
        if (event.source !== frame.contentWindow || event.origin !== new URL(frame.src).origin) return;
        if (event.data?.type === 'annotationVisualizer' && ['addToChat', 'openSource'].includes(event.data.action)) vscode.postMessage(event.data);
      });
    </script></body></html>`;
  annotationVisualizerPanel.reveal(vscode.ViewColumn.Active);
}

function runStubApp(workspaceRoot) {
  if (stubAppTerminal) {
    stubAppTerminal.dispose();
    stubAppTerminal = null;
  }

  stubAppTerminal = vscode.window.createTerminal({
    name: 'Claude Stub',
    cwd: workspaceRoot,
    env: {
      CLAUDE_CODE_MODEL_STUB: '1',
      CLAUDE_CODE_MODEL_STUB_RESPONSE: 'заглушка',
      GRAPH_NODE_LOGGING: '1',
      RUNTIME_RELAY_URL: 'http://127.0.0.1:8787/graph-relay',
    },
  });
  stubAppTerminal.show();
  stubAppTerminal.sendText('npm run original:claude:node-pass', true);
}

async function trustCanonicalDrawioPlugin(workspaceRoot) {
  const pluginPath = path.resolve(
    workspaceRoot,
    'graph',
    'vendor',
    'drawio',
    'src',
    'main',
    'webapp',
    'plugins',
    'codexGraph.js',
  );
  if (!fs.existsSync(pluginPath)) return;

  const pluginId = vscode.Uri.file(pluginPath).toString();
  const fingerprint = crypto
    .createHash('sha256')
    .update(fs.readFileSync(pluginPath, 'utf8'), 'utf8')
    .digest('hex');
  const configuration = vscode.workspace.getConfiguration('hediet.vscode-drawio');
  const knownPlugins = configuration.get('knownPlugins', []);
  const existing = Array.isArray(knownPlugins) ? knownPlugins : [];
  const alreadyTrusted = existing.some((entry) => (
    entry?.pluginId === pluginId
    && entry?.fingerprint === fingerprint
    && entry?.allowed === true
  ));
  const obsoleteEntries = existing.some((entry) => (
    entry?.pluginId === pluginId
    && (entry?.fingerprint !== fingerprint || entry?.allowed !== true)
  ));
  if (alreadyTrusted && !obsoleteEntries) return;

  await configuration.update(
    'knownPlugins',
    [
      ...existing.filter((entry) => entry?.pluginId !== pluginId),
      { pluginId, fingerprint, allowed: true },
    ],
    vscode.ConfigurationTarget.Global,
  );
}

async function handleGraphContextUri(context, workspaceRoot, uri) {
  if (uri.path !== '/graph-context') return;
  const payloadText = new URLSearchParams(uri.query).get('payload');
  if (!payloadText) return;

  let item;
  try {
    item = JSON.parse(payloadText);
  } catch {
    throw new Error('Invalid graph context payload.');
  }

  await handleGraphContextItem(context, workspaceRoot, item);
}

async function handleGraphContextItem(context, workspaceRoot, item) {
  const stableId = String(item.stableId || '');
  const headStableIds = Array.isArray(item.headStableIds) ? item.headStableIds.map(String).filter(Boolean) : [];
  const tailStableIds = Array.isArray(item.tailStableIds) ? item.tailStableIds.map(String).filter(Boolean) : [];
  const text = [
    buildGraphItemTitle(item.kind || 'GraphItem', item.label, stableId || item.targetStableId),
    stableId ? `stableId: ${stableId}` : '',
    item.locationStableId ? `locationStableId: ${item.locationStableId}` : '',
    item.sourceStableId ? `sourceStableId: ${item.sourceStableId}` : '',
    headStableIds.length ? `headStableIds: ${headStableIds.join(', ')}` : '',
    tailStableIds.length ? `tailStableIds: ${tailStableIds.join(', ')}` : '',
    item.targetStableId ? `targetStableId: ${item.targetStableId}` : '',
    item.edgeType ? `edgeType: ${item.edgeType}` : '',
    item.argumentName ? `argumentName: ${item.argumentName}` : '',
    item.fieldName ? `fieldName: ${item.fieldName}` : '',
  ].filter(Boolean).join('\n');

  if (item.action === 'addToCodexThread') {
    await addTextToCodexThread(text, stableId, null, { includeStableIdHeader: false });
    return;
  }
  if (item.action === 'openStableId') {
    await openStableId(workspaceRoot, headStableIds[0] || tailStableIds[0] || item.locationStableId || stableId);
    return;
  }
  if (item.action === 'openSourceStableId') {
    await openStableId(workspaceRoot, item.sourceStableId);
    return;
  }
  if (item.action === 'openDefinitionAtStableId') {
    await openDefinitionAtStableId(workspaceRoot, item.locationStableId || stableId, item.sourceSymbol);
    return;
  }
  if (item.action === 'annotateGraphItem') {
    const activeTabInput = vscode.window.tabGroups?.activeTabGroup?.activeTab?.input;
    await annotateGraphItem(workspaceRoot, {
      ...item,
      chatText: text,
      diagramPath: item.diagramPath || resolveActiveDiagramPath(workspaceRoot, activeTabInput),
    });
    return;
  }
  if (item.action === 'saveAnnotation') {
    const activeTabInput = vscode.window.tabGroups?.activeTabGroup?.activeTab?.input;
    return saveDrawioAnnotation(workspaceRoot, {
      diagramPath: item.diagramPath || resolveActiveDiagramPath(workspaceRoot, activeTabInput),
      annotationCellId: item.annotationCellId,
      annotationText: item.annotationText,
      maxDepth: item.annotationMaxDepth,
      stableId,
      targetStableId: item.targetStableId,
      kind: item.kind,
    });
  }
  if (item.action === 'openRuntimeAnalysis') {
    await openRuntimeAnalysis(context, workspaceRoot, {
      stableId: item.sourceCallStableId || stableId,
      label: item.label || stableId,
      functionStableId: item.functionStableId || '',
    });
    return;
  }

  if (item.action === 'showFunctionalSegment') {
    await openFunctionalSegmentDiagram(context, workspaceRoot, {
      stableId,
      label: item.label || stableId,
    });
    return;
  }

  if (item.action === 'openFunctionFlow' || item.action === 'showFunctionFlow') {
    await openGeneratedFunctionDiagram(context, workspaceRoot, {
      kind: 'flow',
      functionStableId: item.functionStableId,
      label: item.label,
    });
    return;
  }
  if (item.action === 'showFunctionSequence') {
    await openGeneratedFunctionDiagram(context, workspaceRoot, {
      kind: 'sequence',
      functionStableId: item.functionStableId,
      label: item.label,
    });
    return;
  }
}

async function startGraphCommandServer(context, workspaceRoot) {
  if (graphCommandServer) return;

  const server = http.createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    const requestUrl = new URL(request.url || '/', `http://127.0.0.1:${GRAPH_COMMAND_PORT}`);
    if (request.method === 'GET' && requestUrl.pathname === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ version: EXTENSION_VERSION, extensionPath: __dirname,
        runtimePanelOpen: Boolean(runtimeAnalysisPanel) }));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/runtime-highlight') {
      const after = Number(requestUrl.searchParams.get('after') || 0);
      const functionStableId = String(requestUrl.searchParams.get('functionStableId') || '');
      const compatible = !runtimeHighlightBridgeFunctionStableId
        || !functionStableId
        || runtimeHighlightBridgeFunctionStableId === functionStableId;
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        revision: runtimeHighlightBridgeRevision,
        message: compatible && runtimeHighlightBridgeRevision > after
          ? runtimeHighlightBridgeMessage
          : null,
      }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/graph-context') {
      response.writeHead(404);
      response.end('Not found');
      return;
    }

    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) request.destroy();
    });
    request.on('end', async () => {
      try {
        const result = await handleGraphContextItem(context, workspaceRoot, JSON.parse(body));
        if (result !== undefined) {
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify(result));
        } else {
          response.writeHead(204);
          response.end();
        }
      } catch (error) {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end(error?.stack || String(error));
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(GRAPH_COMMAND_PORT, '127.0.0.1', resolve);
  });
  graphCommandServer = server;
}

function deactivate() {
  if (drawioStaticServer?.server) {
    drawioStaticServer.server.close();
    drawioStaticServer = null;
  }
  if (graphCommandServer) {
    graphCommandServer.close();
    graphCommandServer = null;
  }
}

async function openNodeDiagram(context, workspaceRoot, node) {
  if (!node) return;
  try {
    const draw = await ensurePanelFunctionDiagram(workspaceRoot, node.payload);
    await openDrawioFile(draw.filePath);
  } catch (error) {
    vscode.window.showErrorMessage(`Open diagram failed: ${error?.message || error}`);
  }
}

async function openDrawioFile(filePath) {
  await vscode.commands.executeCommand(
    'vscode.open',
    vscode.Uri.file(path.resolve(filePath)),
    { preview: false },
  );
}

async function openDrawioDiagramPanel(context, workspaceRoot, { title, filePath }) {
  const panelTitle = path.basename(filePath);
  const panelKey = process.platform === 'win32'
    ? path.resolve(filePath).toLowerCase()
    : path.resolve(filePath);
  const existingPanel = diagramPanelsByPath.get(panelKey);
  if (existingPanel) {
    existingPanel.title = panelTitle;
    existingPanel.reveal(vscode.ViewColumn.One, true);
    return existingPanel;
  }
  const panel = vscode.window.createWebviewPanel(
    'coldKodeGraphDiagram',
    panelTitle,
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(workspaceRoot, 'graph', 'vendor', 'drawio', 'src', 'main', 'webapp')),
        vscode.Uri.file(path.join(workspaceRoot, 'graph', 'draw')),
        vscode.Uri.file(path.join(workspaceRoot, 'tmp', 'graph-vscode-cache')),
      ],
    },
  );

  panel.webview.html = buildLoadingHtml(title);
  panel.webview.onDidReceiveMessage(
    async (message) => {
      if (!message) return;
      if (message.type === 'addToCodexThread') {
        const text = String(message.text || '');
        const stableId = String(message.stableId || '') || extractStableIdFromText(text);
        await addTextToCodexThread(text, stableId, null, {
          includeStableIdHeader: false,
        });
      } else if (message.type === 'openStableId') {
        await openStableId(workspaceRoot, String(message.stableId || '') || extractStableIdFromText(String(message.text || '')));
      } else if (message.type === 'openDefinitionAtStableId') {
        await openDefinitionAtStableId(
          workspaceRoot,
          String(message.stableId || '') || extractStableIdFromText(String(message.text || '')),
          String(message.sourceSymbol || ''),
        );
      } else if (message.type === 'openFunctionFlow' || message.type === 'showFunctionFlow') {
        try {
          await openGeneratedFunctionDiagram(context, workspaceRoot, {
            kind: 'flow',
            functionStableId: String(message.functionStableId || ''),
            label: String(message.label || ''),
          });
        } catch (error) {
          vscode.window.showErrorMessage(`Open Flow Diagram failed: ${error?.message || error}`);
        }
      } else if (message.type === 'showFunctionSequence') {
        try {
          await openGeneratedFunctionDiagram(context, workspaceRoot, {
            kind: 'sequence',
            functionStableId: String(message.functionStableId || ''),
            label: String(message.label || ''),
          });
        } catch (error) {
          vscode.window.showErrorMessage(`Show Sequence failed: ${error?.message || error}`);
        }
      } else if (message.type === 'openRuntimeAnalysis') {
        try {
          await openRuntimeAnalysis(context, workspaceRoot, {
            stableId: String(message.stableId || ''),
            label: String(message.label || ''),
            functionStableId: String(message.functionStableId || ''),
            diagramPanel: panel,
          });
        } catch (error) {
          vscode.window.showErrorMessage(`Runtime Analysis failed: ${error?.message || error}`);
        }
      } else if (message.type === 'showFunctionalSegment') {
        try {
          await openFunctionalSegmentDiagram(context, workspaceRoot, {
            stableId: String(message.stableId || ''),
            label: String(message.label || ''),
          });
        } catch (error) {
          vscode.window.showErrorMessage(`Functional Segment failed: ${error?.message || error}`);
        }
      } else if (message.type === 'annotateGraphItem') {
        try {
          const result = await annotateGraphItem(workspaceRoot, {
            stableId: String(message.stableId || ''),
            targetStableId: String(message.targetStableId || ''),
            chatText: String(message.text || ''),
            label: String(message.label || ''),
            kind: String(message.kind || ''),
            labels: Array.isArray(message.labels) ? message.labels.map(String) : [],
            diagramPath: String(filePath || message.diagramPath || ''),
            cellId: String(message.cellId || ''),
            x: Number(message.x),
            y: Number(message.y),
            width: Number(message.width),
            height: Number(message.height),
            refreshMode: String(message.refreshMode || 'reuse'),
          });
          await panel.webview.postMessage({ type: 'annotationResult', ...result });
        } catch (error) {
          await panel.webview.postMessage({
            type: 'annotationResult',
            annotation: `Annotation failed: ${error?.message || error}`,
          });
        }
      } else if (message.type === 'saveDrawioAnnotation') {
        try {
          const result = await saveDrawioAnnotation(workspaceRoot, {
            diagramPath: String(filePath || message.diagramPath || ''),
            annotationCellId: String(message.annotationCellId || ''),
            annotationText: String(message.annotationText || ''),
            maxDepth: message.maxDepth,
            stableId: String(message.stableId || ''),
            targetStableId: String(message.targetStableId || ''),
            kind: String(message.kind || ''),
          });
          await panel.webview.postMessage({
            type: 'drawioAnnotationSaveResult',
            requestId: String(message.requestId || ''),
            ...result,
          });
        } catch (error) {
          await panel.webview.postMessage({
            type: 'drawioAnnotationSaveResult',
            requestId: String(message.requestId || ''),
            ok: false,
            error: error?.message || String(error),
          });
        }
      }
    },
    undefined,
    context.subscriptions,
  );
  diagramPanelsByPath.set(panelKey, panel);
  panel.onDidDispose(() => {
    if (diagramPanelsByPath.get(panelKey) === panel) diagramPanelsByPath.delete(panelKey);
  }, null, context.subscriptions);

  try {
    const diagram = await buildDrawioFileHtml(workspaceRoot, filePath, title);
    panel.webview.html = diagram.html;
    watchDiagramFileForPanel(panel, filePath);
  } catch (error) {
    panel.webview.html = buildErrorHtml(title, error);
  }
  return panel;
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if ((response.statusCode || 500) >= 400) {
          reject(new Error(`Runtime relay returned HTTP ${response.statusCode}: ${body}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Runtime relay returned invalid JSON: ${error.message}`));
        }
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error('Runtime relay request timed out')));
    request.on('error', reject);
  });
}

async function loadRuntimeAnalysis(stableId, sessionId, invocationEventId) {
  const url = new URL('http://127.0.0.1:8787/runtime-analysis');
  url.searchParams.set('stableId', stableId);
  if (sessionId) url.searchParams.set('sessionId', sessionId);
  if (invocationEventId) url.searchParams.set('invocationEventId', invocationEventId);
  let response;
  try {
    response = await requestJson(url);
  } catch (error) {
    if (error?.message !== 'Runtime relay request timed out') throw error;
    response = await requestJson(url);
  }
  if (!response.ok) throw new Error(response.error || 'Runtime analysis failed');
  return response.analysis;
}

async function openRuntimeAnalysis(context, workspaceRoot, item) {
  const stableId = String(item?.stableId || '');
  if (!stableId) {
    vscode.window.showWarningMessage('Runtime Analysis requires a graph item with stableId.');
    return;
  }

  if (!runtimeAnalysisPanel) {
    runtimeAnalysisPanel = vscode.window.createWebviewPanel(
      'coldKodeRuntimeAnalysis',
      'Runtime Analysis',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    runtimeAnalysisPanel.onDidDispose(() => {
      const diagramPanel = runtimeAnalysisState?.diagramPanel || null;
      const functionStableId = runtimeAnalysisState?.functionStableId || '';
      runtimeAnalysisPanel = null;
      runtimeAnalysisState = null;
      try {
        void postRuntimeHighlightClear(diagramPanel, functionStableId);
      } catch {
        // The diagram can be disposed before the analysis panel.
      }
    }, null, context.subscriptions);
    runtimeAnalysisPanel.webview.onDidReceiveMessage(async (message) => {
      const state = runtimeAnalysisState;
      if (!state || !message) return;
      if (message.type === 'ready' || message.type === 'refresh' || message.type === 'selectInvocation') {
        try {
          const analysis = await loadRuntimeAnalysis(
            state.stableId,
            message.sessionId || undefined,
            message.invocationEventId || undefined,
          );
          state.analysis = analysis;
          await runtimeAnalysisPanel.webview.postMessage({ type: 'analysis', analysis, label: state.label });
        } catch (error) {
          await runtimeAnalysisPanel.webview.postMessage({ type: 'analysisError', error: error?.message || String(error) });
        }
        return;
      }
      if (message.type === 'showCase') {
        const iteration = (state.analysis?.cases || state.analysis?.iterations)?.find((candidate) => candidate.index === Number(message.index));
        if (iteration) await postRuntimeHighlight(state.diagramPanel, iteration, state.functionStableId);
      } else if (message.type === 'showSegment') {
        const segment = state.analysis?.segments?.find((candidate) => candidate.id === message.id);
        if (segment) await postRuntimeHighlight(state.diagramPanel, segment, state.functionStableId);
      } else if (message.type === 'clearHighlight') {
        await postRuntimeHighlightClear(state.diagramPanel, state.functionStableId);
      }
    }, undefined, context.subscriptions);
  } else {
    runtimeAnalysisPanel.reveal(vscode.ViewColumn.Beside, true);
  }

  runtimeAnalysisState = {
    stableId,
    label: String(item?.label || stableId),
    functionStableId: String(item?.functionStableId || ''),
    diagramPanel: item?.diagramPanel || runtimeAnalysisState?.diagramPanel || null,
    analysis: null,
  };
  runtimeAnalysisPanel.title = 'Статистика цикла';
  const { boxImage } = await import(require('node:url').pathToFileURL(path.join(workspaceRoot, 'dev/localCoordinateDrawio.mjs')).href);
  runtimeAnalysisPanel.webview.html = buildRuntimeAnalysisHtml(boxImage());
  try {
    const analysis = await loadRuntimeAnalysis(stableId);
    runtimeAnalysisState.analysis = analysis;
    await runtimeAnalysisPanel.webview.postMessage({ type: 'analysis', analysis, label: runtimeAnalysisState.label });
  } catch (error) {
    await runtimeAnalysisPanel.webview.postMessage({ type: 'analysisError', error: error?.message || String(error) });
  }
}

function publishRuntimeHighlight(message, functionStableId = '') {
  runtimeHighlightBridgeRevision += 1;
  runtimeHighlightBridgeMessage = message;
  runtimeHighlightBridgeFunctionStableId = String(functionStableId || '');
}

async function postRuntimeHighlight(panel, selection, functionStableId = '') {
  const message = {
    type: 'runtimeHighlight',
    selection: {
      staticStableIds: selection.staticStableIds || [],
      nodeHighlights: selection.nodeHighlights || [],
      edgePairs: selection.edgePairs || [],
    },
  };
  publishRuntimeHighlight({ action: 'runtimeHighlight', selection: message.selection }, functionStableId);
  if (panel) await panel.webview.postMessage(message);
}

async function postRuntimeHighlightClear(panel, functionStableId = '') {
  publishRuntimeHighlight({ action: 'runtimeHighlightClear' }, functionStableId);
  if (panel) await panel.webview.postMessage({ type: 'runtimeHighlightClear' });
}

function buildRuntimeAnalysisHtml(variableBoxImage) {
  return `<!doctype html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  * { box-sizing: border-box; }
  body { color-scheme:light; --loop-panel-foreground:#202124; --loop-panel-editor-background:#ffffff; --loop-panel-panel-border:#d8dce0; --loop-panel-focusBorder:#1670b7; --loop-panel-editorWidget-background:#f5f7f9; --loop-panel-descriptionForeground:#59636e; --loop-panel-list-hoverBackground:#edf4fa; --loop-panel-errorForeground:#b42318; --loop-panel-font-family:Arial,sans-serif; }
  .variable-box { display:inline-grid; place-items:center; width:64px; height:44px; background:center/100% 100% no-repeat url("${variableBoxImage}"); padding-bottom:3px; font-weight:600; }
  .details td { overflow-wrap:anywhere; }
  .details tr.selected { background:#e1effa; }
  body { margin: 0; color: var(--loop-panel-foreground); background: var(--loop-panel-editor-background); font: 13px/1.4 var(--loop-panel-font-family); }
  header { min-height:44px; padding:11px 12px; border-bottom:1px solid var(--loop-panel-panel-border); }
  header code { display:block; overflow:hidden; color:var(--loop-panel-foreground); text-overflow:ellipsis; white-space:nowrap; }
  section { padding:12px; border-bottom:1px solid var(--loop-panel-panel-border); }
  .all-frame { width:100%; padding:8px; color:var(--loop-panel-foreground); background:transparent; border:1px solid var(--loop-panel-panel-border); border-radius:3px; cursor:pointer; text-align:left; }
  .all-frame:hover,.all-frame.selected { border-color:var(--loop-panel-focusBorder); }
  .all-label { display:block; margin-bottom:6px; font-size:11px; font-weight:600; }
  .bar { display:flex; width:100%; height:34px; overflow:hidden; border:1px solid var(--loop-panel-panel-border); background:var(--loop-panel-editorWidget-background); }
  .bar-segment { min-width:2px; height:100%; border:0; border-right:1px solid var(--loop-panel-editor-background); cursor:pointer; }
  .bar-segment:hover,.bar-segment.selected { outline:2px solid var(--loop-panel-focusBorder); outline-offset:-2px; }
  .legend { display:flex; flex-wrap:wrap; gap:8px 14px; margin-top:8px; }
  .segment { display:grid; grid-template-columns:11px minmax(0,1fr) auto; align-items:center; gap:6px; min-width:170px; padding:2px 4px; color:var(--loop-panel-foreground); background:transparent; border:1px solid transparent; cursor:pointer; text-align:left; }
  .segment.selected { border-color:var(--loop-panel-focusBorder); }
  .swatch,.case-marker { width:9px; height:9px; border-radius:50%; }
  .segment-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .segment-count { color:var(--loop-panel-descriptionForeground); font-variant-numeric:tabular-nums; }
  .details { width:100%; border-collapse:collapse; }
  th,td { padding:5px 7px; border-bottom:1px solid var(--loop-panel-panel-border); text-align:left; }
  tbody tr { cursor:pointer; }
  tbody tr:hover { background:var(--loop-panel-list-hoverBackground); }
  .marker-cell { width:22px; }
  .accumulator { max-width:420px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .muted { color:var(--loop-panel-descriptionForeground); }
  .error-box { padding:12px; color:var(--loop-panel-errorForeground); white-space:pre-wrap; }
</style></head>
<body>
  <header><code id="stableId"></code><span id="loopCounts"></span></header>
  <div id="error" class="error-box" hidden></div>
  <main id="main" hidden>
    <section><button id="all" class="all-frame"><span class="all-label">ALL</span><span id="bar" class="bar"></span></button><div id="segments" class="legend"></div></section>
    <section><table class="details"><thead><tr><th class="marker-cell"></th><th>#</th><th><span id="itemHeader">Item</span></th><th id="outcomeHeader">Outcome</th><th id="accumulatorHeader" style="white-space:pre-line">accum:</th><th>Duration</th></tr></thead><tbody id="details"></tbody></table></section>
  </main>
<script>
  const vscode = acquireVsCodeApi();
  let current = null;
  let selectedSegmentId = null;
  const byId = (id) => document.getElementById(id);
  function caseColor(outcome, analysis) {
    if (outcome === 'continue') return '#17834b';
    if (outcome === 'break') return '#c33a3a';
    if (analysis?.segments?.length === 1 && !(analysis.segments[0].branchPath || []).length) return '#F2C185';
    if (outcome === 'accepted' || outcome === 'matched' || outcome === 'accumulated') return '#006600';
    if (outcome === 'error') return '#c27d00';
    return '#CC0000';
  }
  function selectedRowsFor(segment) {
    const indexes = new Set(segment?.iterationIndexes || []);
    return (current?.cases || current?.iterations || []).filter((item) => indexes.has(item.index));
  }
  function selectSegment(item) {
    selectedSegmentId = item.id;
    byId('all').classList.remove('selected');
    document.querySelectorAll('[data-segment-id]').forEach((element) => {
      element.classList.toggle('selected', element.getAttribute('data-segment-id') === item.id);
    });
    showRows(selectedRowsFor(item));
    vscode.postMessage({type:'showSegment',id:item.id});
  }
  function selectAll() {
    selectedSegmentId = null;
    byId('all').classList.add('selected');
    document.querySelectorAll('[data-segment-id]').forEach((element) => element.classList.remove('selected'));
    showRows(current?.cases || current?.iterations || []);
    vscode.postMessage({type:'clearHighlight'});
  }
  function renderDistribution(analysis) {
    const items = analysis.segments || []; const total = Math.max(1, analysis.totalCases || analysis.totalIterations || 0);
    const bar = byId('bar'); const legend = byId('segments'); bar.replaceChildren(); legend.replaceChildren();
    items.forEach((item) => {
      const color = caseColor(item.outcome, analysis);
      const slice = document.createElement('span'); slice.className = 'bar-segment'; slice.setAttribute('data-segment-id', item.id);
      slice.style.width = (item.count / total * 100) + '%'; slice.style.background = color; slice.title = item.label + ': ' + item.count;
      slice.onclick = (event) => { event.stopPropagation(); selectSegment(item); }; bar.appendChild(slice);
      const button = document.createElement('button'); button.type = 'button'; button.className = 'segment'; button.setAttribute('data-segment-id', item.id); button.title = item.label;
      const swatch = document.createElement('span'); swatch.className = 'swatch'; swatch.style.background = color;
      const name = document.createElement('span'); name.className = 'segment-label'; name.textContent = item.label;
      const count = document.createElement('span'); count.className = 'segment-count'; count.textContent = item.count + ' · ' + Math.round(item.count / total * 100) + '%';
      button.append(swatch, name, count); button.onclick = () => selectSegment(item); legend.appendChild(button);
    });
    const selected = items.find((item) => item.id === selectedSegmentId);
    if (selected) {
      document.querySelectorAll('[data-segment-id="' + selected.id + '"]').forEach((element) => element.classList.add('selected'));
      showRows(selectedRowsFor(selected));
    } else {
      selectAll();
    }
  }
  function render(analysis) {
    current = analysis;
    byId('error').hidden = true; byId('main').hidden = false;
    byId('stableId').textContent = analysis.stableId || '';
    byId('loopCounts').textContent = 'Iterations: ' + analysis.totalIterations
      + (analysis.conditionChecks ? ' | Condition: ' + analysis.conditionChecks.total
        + ' | true: ' + analysis.conditionChecks.true + ' | false: ' + analysis.conditionChecks.false : '');
    byId('accumulatorHeader').textContent = 'accum:' + (analysis.accumulatorName ? '\\n' + analysis.accumulatorName : '');
    current.hasAccumulator = Boolean(analysis.accumulatorName || (analysis.cases || analysis.iterations || []).some(item => item.accumulatorState != null));
    byId('accumulatorHeader').hidden = !current.hasAccumulator;
    byId('itemHeader').textContent = analysis.iterationVariable || 'Item';
    byId('itemHeader').className = analysis.iterationVariable ? 'variable-box' : '';
    byId('outcomeHeader').textContent = analysis.methodName === 'for' ? 'Transition' : 'Outcome';
    renderDistribution(analysis);
  }
  function showRows(items) {
    const rows = items.map((item) => {
      const row = document.createElement('tr');
      const markerCell = document.createElement('td'); markerCell.className = 'marker-cell';
      const marker = document.createElement('span'); marker.className = 'case-marker'; marker.style.display = 'block'; marker.style.background = caseColor(item.outcome, current); markerCell.appendChild(marker); row.appendChild(markerCell);
      let itemValue = item.itemPreview || '';
      if (current.iterationVariable && item.itemPreview) {
        try { itemValue = JSON.parse(item.itemPreview)[current.iterationVariable]; } catch {}
      }
      [item.index + 1, itemValue, item.transition || item.outcome, ...(current.hasAccumulator ? [item.accumulatorState || '—'] : []), item.durationMs + ' ms'].forEach((value, index) => {
        const cell=document.createElement('td'); cell.textContent=String(value); if (current.hasAccumulator && index === 3) cell.className = 'accumulator'; row.appendChild(cell);
      });
      row.onclick = () => {
        document.querySelectorAll('#details tr').forEach(element => element.classList.remove('selected'));
        row.classList.add('selected');
        vscode.postMessage({type:'showCase',index:item.index});
      };
      return row;
    });
    byId('details').replaceChildren(...rows);
  }
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'analysis') render(event.data.analysis);
    if (event.data?.type === 'analysisError') { byId('main').hidden=true; byId('error').hidden=false; byId('error').textContent=event.data.error; }
  });
  byId('all').onclick = selectAll;
  vscode.postMessage({type:'ready'});
</script></body></html>`;
}

async function buildDrawioFileHtml(workspaceRoot, filePath, diagramTitle) {
  const draw = { filePath };
  const drawioXml = fs.readFileSync(draw.filePath, 'utf8');
  const drawioBaseUrl = await getDrawioStaticBaseUrl(workspaceRoot);
  const drawioSrc = `${drawioBaseUrl}index.html?dev=1&embed=1&proto=json&configure=1&ui=min&plugins=1&p=codexGraph&spin=1&modified=0&saveAndExit=0&noSaveBtn=1&noExitBtn=1&codexGraphVersion=${encodeURIComponent(EXTENSION_VERSION)}`;
  const preloadedAnnotations = await loadGraphAnnotationsFromOrchestrator(workspaceRoot);

  const html = `<!doctype html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .frame-wrap { width: 100%; height: 100vh; }
    iframe { width: 100%; height: 100%; border: 0; background: white; }
    .drawio-status { position: fixed; right: 10px; bottom: 8px; z-index: 10; padding: 4px 7px; border: 1px solid var(--vscode-panel-border); border-radius: 3px; background: var(--vscode-editorWidget-background); color: var(--vscode-descriptionForeground); font-size: 11px; }
    ${interactionCss()}
  </style>
</head>
<body>
  <div class="frame-wrap"><iframe id="drawioFrame" src="${escapeHtml(drawioSrc)}"></iframe></div>
  <div id="drawioStatus" class="drawio-status">draw.io loading</div>
  ${interactionMarkup()}
  <script>
    const vscode = acquireVsCodeApi();
    let drawioXml = ${JSON.stringify(drawioXml)};
    const graphAnnotations = ${JSON.stringify(preloadedAnnotations || {})};
    const frame = document.getElementById('drawioFrame');
    const drawioStatus = document.getElementById('drawioStatus');
    const annotationPopover = document.getElementById('annotationPopover');
    const annotationText = document.getElementById('annotationText');
    const closeAnnotation = document.getElementById('closeAnnotation');
    let loaded = false;
    let activeAnnotationItem = null;

    function postToDrawio(payload) {
      frame?.contentWindow?.postMessage(JSON.stringify(payload), '*');
    }
    function showAnnotation(text, item) {
      activeAnnotationItem = item || activeAnnotationItem;
      annotationText.textContent = text || '';
      annotationText.style.display = 'block';
      annotationPopover.style.display = 'block';
    }
    function annotationKey(item) {
      if (!item) return '';
      if (item.targetStableId) return (item.stableId || '') + '->' + item.targetStableId;
      return item.stableId || '';
    }
    function buildChatText(item) {
      if (!item) return '';
      const isEdge = !!item.targetStableId || String(item.kind || '').includes('edge');
      const isVisualProxy = item.kind === 'VisualProxy' || !!item.visualProxyStableId;
      const labels = Array.isArray(item.labels) ? item.labels.filter(Boolean) : [];
      const displayedKinds = labels[0] || item.kind || 'Graph item';
      const displayedLabel = String(item.label || item.stableId || 'item');
      const repeatedLabel = displayedKinds.split(':').some(kind => kind.toLowerCase() === displayedLabel.toLowerCase());
      const lines = [
        repeatedLabel ? displayedKinds : displayedKinds + ': ' + displayedLabel,
      ];
      if (isEdge) {
        if (item.stableId) lines.push('sourceStableId: ' + item.stableId);
        if (item.targetStableId) lines.push('targetStableId: ' + item.targetStableId);
        if (item.canonicalTargetStableId) lines.push('canonicalTargetStableId: ' + item.canonicalTargetStableId);
        lines.push('Neo4j/MCP: the edge endpoints are in the graph; fetch one-hop neighbor context from these stableId values when needed.');
      } else {
        if (item.stableId) lines.push('stableId: ' + item.stableId);
        if (item.locationStableId) lines.push('locationStableId: ' + item.locationStableId);
        if (item.sourceStableId) lines.push('sourceStableId: ' + item.sourceStableId);
        if (Array.isArray(item.headStableIds) && item.headStableIds.length) lines.push('headStableIds: ' + item.headStableIds.join(', '));
        if (Array.isArray(item.tailStableIds) && item.tailStableIds.length) lines.push('tailStableIds: ' + item.tailStableIds.join(', '));
        if (isVisualProxy) {
          if (item.sourceCallStableId) lines.push('sourceCallStableId: ' + item.sourceCallStableId);
          if (item.visualCopyIndex && item.visualCopyCount) lines.push('visualCopy: ' + item.visualCopyIndex + '/' + item.visualCopyCount);
          lines.push('Visual proxy: this drawn node is a local visual copy of the canonical stableId above, placed next to its caller to avoid long cross-diagram call edges.');
        }
        lines.push('Neo4j/MCP: neighboring graph nodes are available one hop from stableId.');
      }
      if (item.edgeType) lines.push('edgeType: ' + item.edgeType);
      if (item.argumentName) lines.push('argumentName: ' + item.argumentName);
      if (item.fieldName) lines.push('fieldName: ' + item.fieldName);
      if (item.layoutTrace) lines.push('', item.layoutTrace);
      return lines.filter(Boolean).join('\\n');
    }
    function handleGraphAction(item) {
      if (!item) return;
      if (item.action === 'addToCodexThread') {
        vscode.postMessage({ type: 'addToCodexThread', text: buildChatText(item), stableId: item.stableId || '' });
      } else if (item.action === 'openStableId') {
        const codeStableId = (Array.isArray(item.headStableIds) && item.headStableIds[0])
          || (Array.isArray(item.tailStableIds) && item.tailStableIds[0])
          || item.locationStableId
          || item.stableId
          || '';
        vscode.postMessage({ type: 'openStableId', text: buildChatText(item), stableId: codeStableId });
      } else if (item.action === 'openSourceStableId') {
        vscode.postMessage({
          type: 'openStableId',
          text: buildChatText(item),
          stableId: item.sourceStableId || '',
        });
      } else if (item.action === 'openDefinitionAtStableId') {
        vscode.postMessage({
          type: 'openDefinitionAtStableId',
          text: buildChatText(item),
          stableId: item.locationStableId || item.stableId || '',
          sourceSymbol: item.sourceSymbol || '',
        });
      } else if (item.action === 'openFunctionFlow' || item.action === 'showFunctionFlow') {
        vscode.postMessage({
          type: 'openFunctionFlow',
          functionStableId: item.functionStableId || item.sourceStableId || '',
          label: item.label || '',
        });
      } else if (item.action === 'showFunctionSequence') {
        vscode.postMessage({
          type: 'showFunctionSequence',
          functionStableId: item.functionStableId || item.sourceStableId || '',
          label: item.label || '',
        });
      } else if (item.action === 'openRuntimeAnalysis') {
        vscode.postMessage({
          type: 'openRuntimeAnalysis',
          stableId: item.sourceCallStableId || item.stableId || '',
          label: item.label || '',
          functionStableId: item.functionStableId || '',
        });
      } else if (item.action === 'annotateGraphItem') {
        const key = annotationKey(item);
        const existing = graphAnnotations[key] || graphAnnotations[item.stableId || ''];
        if (existing?.text || typeof existing === 'string') {
          showAnnotation(existing.text || existing, item);
        }
        activeAnnotationItem = item;
        vscode.postMessage({
          type: 'annotateGraphItem',
          text: buildChatText(item),
          label: item.label || '',
          kind: item.kind || '',
          labels: Array.isArray(item.labels) ? item.labels : [],
          stableId: item.stableId || '',
          headStableIds: Array.isArray(item.headStableIds) ? item.headStableIds : [],
          tailStableIds: Array.isArray(item.tailStableIds) ? item.tailStableIds : [],
          targetStableId: item.targetStableId || '',
          visualProxyStableId: item.visualProxyStableId || '',
          sourceCallStableId: item.sourceCallStableId || '',
          visualCopyIndex: item.visualCopyIndex || '',
          visualCopyCount: item.visualCopyCount || '',
          diagramPath: ${JSON.stringify(draw.filePath)},
          cellId: item.cellId || '',
          x: item.x,
          y: item.y,
          width: item.width,
          height: item.height,
          refreshMode: item.refreshMode || 'reuse',
        });
      } else if (item.action === 'saveAnnotation') {
        vscode.postMessage({
          type: 'saveDrawioAnnotation',
          requestId: item.requestId || '',
          annotationCellId: item.annotationCellId || '',
          annotationText: item.annotationText || '',
          maxDepth: item.annotationMaxDepth || null,
          stableId: item.stableId || '',
          targetStableId: item.targetStableId || '',
          kind: item.kind || '',
          diagramPath: ${JSON.stringify(draw.filePath)},
        });
      }
    }
    function loadDrawio(force) {
      if (!frame || (loaded && !force)) return;
      loaded = true;
      postToDrawio({
        action: 'load',
        xml: drawioXml,
        title: ${JSON.stringify(diagramTitle)},
        autosave: 0,
        modified: false,
        noSaveBtn: 1,
        noExitBtn: 1,
        saveAndExit: 0,
      });
    }
    window.addEventListener('message', (event) => {
      let message = event.data;
      if (typeof message === 'string') {
        try { message = JSON.parse(message); } catch { return; }
      }
      if (!message) return;
      if (message.type === 'annotationResult') {
        if (message.annotation) {
          const key = annotationKey(activeAnnotationItem);
          if (key) graphAnnotations[key] = { text: message.annotation };
          showAnnotation(message.annotation, activeAnnotationItem);
        }
        return;
      }
      if (message.type === 'reloadDrawioXml') {
        drawioXml = message.xml || drawioXml;
        loadDrawio(true);
        return;
      }
      if (message.type === 'drawioAnnotationSaveResult') {
        if (message.ok) {
          const key = message.annotationKey || message.stableId || '';
          if (key) graphAnnotations[key] = { text: message.text || '' };
        }
        postToDrawio({
          action: 'codexGraphResponse',
          requestId: message.requestId || '',
          result: message,
        });
        return;
      }
      if (message.type === 'runtimeHighlight' || message.type === 'runtimeHighlightClear') {
        postToDrawio({
          action: message.type === 'runtimeHighlight' ? 'runtimeHighlight' : 'runtimeHighlightClear',
          selection: message.selection || null,
        });
        return;
      }
      if (!frame || event.source !== frame.contentWindow) return;
      if (message.event === 'configure') {
        postToDrawio({
          action: 'configure',
          config: {
            darkColor: '#1e1e1e',
            defaultGridEnabled: true,
            defaultConnectable: false,
            defaultConnectionArrowsEnabled: false,
            hideMenuItems: ['exportAs', 'importFrom', 'print'],
            showLinkIcons: false,
          },
        });
      } else if (message.event === 'init') {
        if (drawioStatus) drawioStatus.textContent = 'draw.io initialized';
        loadDrawio(false);
      } else if (message.event === 'codexGraphPluginLoaded') {
        if (drawioStatus) drawioStatus.textContent = 'codexGraph plugin loaded';
      } else if (message.event === 'codexGraphContext') {
        handleGraphAction(message.payload);
      }
    });
    closeAnnotation?.addEventListener('click', () => annotationPopover.style.display = 'none');
    document.getElementById('refreshAnnotation')?.addEventListener('click', () => {
      if (!activeAnnotationItem) return;
      handleGraphAction({ ...activeAnnotationItem, action: 'annotateGraphItem', refreshMode: 'root' });
    });
  </script>
</body>
</html>`;
  return { html, filePath: draw.filePath };
}

function watchDiagramFileForPanel(panel, filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  let disposed = false;
  let timer = null;
  let watcher = null;

  const reload = () => {
    if (disposed) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (disposed || !fs.existsSync(filePath)) return;
      try {
        const xml = fs.readFileSync(filePath, 'utf8');
        await panel.webview.postMessage({ type: 'reloadDrawioXml', xml });
      } catch {
        // File may be mid-write; the next fs event will retry.
      }
    }, 150);
  };

  try {
    watcher = fs.watch(filePath, reload);
  } catch {
    return;
  }

  panel.onDidDispose(() => {
    disposed = true;
    clearTimeout(timer);
    watcher?.close();
  });
}

async function ensurePanelFunctionDiagram(workspaceRoot, diagram) {
  const functionStableId = diagram.rootStableId;
  return ensureDiagramFile(workspaceRoot, {
    kind: 'flow',
    functionStableId,
    label: diagram.name,
  }, (outputPath) => renderPreservingAnnotations(
    outputPath,
    () => runLocalIterativeRenderer(workspaceRoot, outputPath, functionStableId),
  ));
}

async function openGeneratedFunctionDiagram(context, workspaceRoot, { kind, functionStableId, label }) {
  const result = await ensureDiagramFile(workspaceRoot, {
    kind,
    functionStableId,
    label,
  }, (outputPath) => renderPreservingAnnotations(outputPath, () => (kind === 'sequence'
    ? runLocalSequenceRenderer(workspaceRoot, outputPath, functionStableId)
    : runLocalIterativeRenderer(workspaceRoot, outputPath, functionStableId))));
  await openDrawioFile(result.filePath);
  vscode.window.setStatusBarMessage(
    result.refreshed
      ? `Refreshed diagram: ${path.basename(result.filePath)}`
      : `Created diagram: ${path.basename(result.filePath)}`,
    5000,
  );
  return result;
}

async function openFunctionalSegmentDiagram(context, workspaceRoot, { stableId, label }) {
  const rootStableId = String(stableId || '').trim();
  if (!rootStableId) throw new Error('Functional Segment requires stableId.');
  const descriptor = {
    kind: 'functional-segment',
    functionStableId: rootStableId,
    label: label || 'functional-segment',
  };
  let result;
  try {
    result = await ensureDiagramFile(workspaceRoot, descriptor, (outputPath) => (
      runFunctionalSegmentRenderer(workspaceRoot, outputPath, rootStableId)
    ));
  } catch (error) {
    const existingPath = diagramFilePath(workspaceRoot, descriptor);
    if (!fs.existsSync(existingPath)) throw error;
    await openDrawioFile(existingPath);
    vscode.window.showWarningMessage(
      `Opened the existing functional segment; refresh failed: ${error?.message || error}`,
    );
    return { filePath: existingPath, reused: true, refreshed: false, refreshError: error };
  }
  await openDrawioFile(result.filePath);
  vscode.window.setStatusBarMessage(
    result.refreshed
      ? `Refreshed functional segment: ${path.basename(result.filePath)}`
      : `Created functional segment: ${path.basename(result.filePath)}`,
    5000,
  );
  return result;
}

function runFunctionalSegmentRenderer(workspaceRoot, outputPath, stableId) {
  return new Promise((resolve, reject) => {
    execFile(process.platform === 'win32' ? 'node.exe' : 'node', [
      'dev/exportFunctionalSegmentDrawio.mjs',
      '--output', outputPath,
      '--stable-id', stableId,
    ], {
      cwd: workspaceRoot,
      env: { ...process.env },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (!error) return resolve({ outputPath, stdout });
      reject(new Error([error.message, stderr, stdout].filter(Boolean).join('\n').trim()));
    });
  });
}

function runLocalSequenceRenderer(workspaceRoot, outputPath, functionStableId) {
  return new Promise((resolve, reject) => {
    execFile(process.platform === 'win32' ? 'node.exe' : 'node', [
      'dev/exportLocalFunctionSequenceDrawio.mjs',
      '--output', outputPath,
      '--fn-stable-id', functionStableId,
    ], {
      cwd: workspaceRoot,
      env: { ...process.env },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (!error) return resolve({ outputPath, stdout });
      reject(new Error([error.message, stderr, stdout].filter(Boolean).join('\n').trim()));
    });
  });
}

function runLocalIterativeRenderer(workspaceRoot, outputPath, functionStableId) {
  return new Promise((resolve, reject) => {
    execFile(process.platform === 'win32' ? 'node.exe' : 'node', [
      'dev/exportLocalIterativeCoordinateDrawio.mjs',
      '--output', outputPath,
      '--fn-stable-id', functionStableId,
    ], {
      cwd: workspaceRoot,
      env: { ...process.env },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (!error) return resolve({ outputPath, stdout });
      reject(new Error([error.message, stderr, stdout].filter(Boolean).join('\n').trim()));
    });
  });
}

function readDrawioAnnotationCells(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const xml = fs.readFileSync(filePath, 'utf8');
  return [...xml.matchAll(/<mxCell\b[^>]*\bid="annotation-[^"]+"[^>]*(?:\/>|>[\s\S]*?<\/mxCell>)/g)]
    .map((match) => match[0]);
}

function restoreDrawioAnnotationCells(filePath, cells) {
  if (!cells?.length || !fs.existsSync(filePath)) return;
  let xml = fs.readFileSync(filePath, 'utf8');
  const rootCloseIndex = xml.indexOf('</root>');
  if (rootCloseIndex < 0) return;
  const missing = cells.filter((cell) => {
    const id = cell.match(/\bid="([^"]+)"/)?.[1];
    return id && !xml.includes(`id="${id}"`);
  });
  if (!missing.length) return;
  xml = `${xml.slice(0, rootCloseIndex)}${missing.join('\n')}\n${xml.slice(rootCloseIndex)}`;
  fs.writeFileSync(filePath, xml, 'utf8');
}

async function renderPreservingAnnotations(filePath, render) {
  const annotations = readDrawioAnnotationCells(filePath);
  await render();
  restoreDrawioAnnotationCells(filePath, annotations);
}

async function getDrawioStaticBaseUrl(workspaceRoot) {
  const webappRoot = path.join(workspaceRoot, 'graph', 'vendor', 'drawio', 'src', 'main', 'webapp');
  if (drawioStaticServer?.root === webappRoot) return drawioStaticServer.baseUrl;
  if (drawioStaticServer?.server) {
    drawioStaticServer.server.close();
    drawioStaticServer = null;
  }
  if (!fs.existsSync(path.join(webappRoot, 'index.html'))) {
    throw new Error(`Local draw.io fork webapp is missing: ${webappRoot}`);
  }
  const server = http.createServer((request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const pathname = decodeURIComponent(url.pathname || '/');
      const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const absolutePath = path.resolve(webappRoot, relativePath);
      if (!isPathInside(webappRoot, absolutePath)) {
        response.writeHead(403);
        response.end('Forbidden');
        return;
      }
      const stat = fs.existsSync(absolutePath) ? fs.statSync(absolutePath) : null;
      const filePath = stat?.isDirectory() ? path.join(absolutePath, 'index.html') : absolutePath;
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        response.writeHead(404);
        response.end('Not found');
        return;
      }
      response.writeHead(200, {
        'content-type': mimeTypeForPath(filePath),
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      fs.createReadStream(filePath).pipe(response);
    } catch (error) {
      response.writeHead(500);
      response.end(String(error?.message || error));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  drawioStaticServer = {
    root: webappRoot,
    server,
    baseUrl: `http://127.0.0.1:${address.port}/`,
  };
  return drawioStaticServer.baseUrl;
}

function mimeTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
  }[ext] || 'application/octet-stream';
}

async function addTextToCodexThread(text, stableId = '', fileMeta = null, options = {}) {
  const includeStableIdHeader = options.includeStableIdHeader !== false;
  const normalizedStableId = String(stableId || '').trim();
  const textBody = String(text || '').trim();
  const hasStableId = hasStableIdLine(textBody);
  const stableIdLine = normalizedStableId && (includeStableIdHeader || !hasStableId) ? `stableId: ${normalizedStableId}` : '';
  const content = [stableIdLine, textBody].filter(Boolean).join('\n');
  if (!content) return;
  await vscode.env.clipboard.writeText(content);
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showWarningMessage('No workspace folder is open; node text was copied to clipboard.');
    return;
  }
  const contextDir = path.join(workspaceRoot, 'tmp', 'graph-vscode-cache', 'codex-context');
  fs.mkdirSync(contextDir, { recursive: true });
  const fileName = buildCodexContextFileName(text, stableId, fileMeta);
  const contextPath = path.join(contextDir, fileName);
  fs.writeFileSync(contextPath, `\uFEFF${content}\n`, 'utf8');

  try {
    const commands = new Set(await vscode.commands.getCommands(true));
    if (commands.has('chatgpt.addFileToThread')) {
      await vscode.commands.executeCommand(
        'chatgpt.addFileToThread',
        vscode.Uri.file(contextPath),
      );
      return contextPath;
    }

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(contextPath));
    const editor = await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
    const start = new vscode.Position(0, 0);
    const end = document.lineAt(document.lineCount - 1).range.end;
    editor.selection = new vscode.Selection(start, end);
    await vscode.commands.executeCommand('chatgpt.addToThread');
    if (vscode.window.activeTextEditor?.document.uri.fsPath === contextPath) {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
    return contextPath;
  } catch (error) {
    vscode.window.showWarningMessage(`Codex addToThread failed; node text was copied to clipboard. ${error?.message || error}`);
    return contextPath;
  }
}

function hasStableIdLine(text) {
  return /^(?:stableId|sourceStableId|targetStableId):\s*\S+/im.test(String(text || ''));
}

function buildCodexContextFileName(text, stableId = '', fileMeta = null) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const titleLine = lines[0] || 'Graph item';
  const [kindRaw, labelRaw = ''] = titleLine.split(/:\s*/, 2);
  const kind = sanitizeFileNamePart(fileMeta?.kind || kindRaw || 'GraphItem');
  const rawLabel = String(fileMeta?.label || labelRaw || '').trim();
  const kindWords = String(fileMeta?.kind || kindRaw || '')
    .split(/[-:]/)
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);
  const label = kindWords.includes(rawLabel.toLowerCase()) ? '' : sanitizeFileNamePart(rawLabel);
  const fullStableId = String(stableId || extractStableIdFromText(text) || '').trim();
  const stable = sanitizeFileNamePart(sourceLocationForFileName(fullStableId) || fullStableId);
  const stableHash = fullStableId
    ? crypto.createHash('sha1').update(fullStableId).digest('hex').slice(0, 10)
    : '';
  return [kind, label, stable, stableHash].filter(Boolean).join('__') + '.txt';
}

function buildGraphItemTitle(kind, label, fallback = '') {
  const displayedKind = String(kind || 'GraphItem').trim() || 'GraphItem';
  const displayedLabel = String(label || fallback || '').trim();
  const kindWords = displayedKind.split(':').map((word) => word.trim().toLowerCase()).filter(Boolean);
  return displayedLabel && !kindWords.includes(displayedLabel.toLowerCase())
    ? `${displayedKind}: ${displayedLabel}`
    : displayedKind;
}

function sourceLocationForFileName(stableId) {
  const matches = [...String(stableId || '').matchAll(/([A-Za-z0-9_.\-/\\]+\.(?:tsx?|jsx?|mjs|cjs)):(\d+):(\d+):(\d+):(\d+)/gi)];
  const match = matches.at(-1);
  if (!match) return '';
  const sourcePath = match[1].replace(/\\/g, '/');
  return `${sourcePath}:${match.slice(2).join(':')}`;
}

function extractStableIdFromText(text) {
  const match = String(text || '').match(/[A-Za-z0-9_.\/\\-]+:\d+:\d+:\d+:\d+/);
  return match?.[0] || '';
}

function sanitizeFileNamePart(text) {
  return String(text || '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

async function openStableId(workspaceRoot, stableId) {
  const parsed = parseStableIdAsCodeLocation(stableId);
  if (!parsed) {
    vscode.window.showWarningMessage(`Cannot open code for stableId: ${stableId || '<empty>'}`);
    return;
  }
  const targetPath = path.join(resolveSourceRoot(workspaceRoot), parsed.relativePath);
  if (!fs.existsSync(targetPath)) {
    vscode.window.showWarningMessage(`Source file not found: ${parsed.relativePath}`);
    return;
  }
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(targetPath));
  const editor = await vscode.window.showTextDocument(document, {
    viewColumn: vscode.ViewColumn.Beside,
    preview: false,
    preserveFocus: false,
  });
  const start = new vscode.Position(Math.max(0, parsed.startLine - 1), Math.max(0, parsed.startColumn));
  const end = new vscode.Position(Math.max(0, parsed.endLine - 1), Math.max(0, parsed.endColumn));
  const range = new vscode.Range(start, end);
  editor.selection = new vscode.Selection(start, end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

async function openDefinitionAtStableId(workspaceRoot, stableId, sourceSymbol = '') {
  const parsed = parseStableIdAsCodeLocation(stableId);
  if (!parsed) {
    await openStableId(workspaceRoot, stableId);
    return;
  }
  const sourceUri = vscode.Uri.file(path.join(resolveSourceRoot(workspaceRoot), parsed.relativePath));
  if (!fs.existsSync(sourceUri.fsPath)) {
    await openStableId(workspaceRoot, stableId);
    return;
  }
  const document = await vscode.workspace.openTextDocument(sourceUri);
  const start = new vscode.Position(Math.max(0, parsed.startLine - 1), Math.max(0, parsed.startColumn));
  const end = new vscode.Position(Math.max(0, parsed.endLine - 1), Math.max(0, parsed.endColumn));
  const range = new vscode.Range(start, end);
  let position = start;
  const symbol = String(sourceSymbol || '').trim();
  if (symbol) {
    const rangeOffset = document.offsetAt(start);
    const relativeOffset = document.getText(range).lastIndexOf(symbol);
    if (relativeOffset >= 0) position = document.positionAt(rangeOffset + relativeOffset);
  }
  const definitions = await vscode.commands.executeCommand(
    'vscode.executeDefinitionProvider',
    sourceUri,
    position,
  );
  const definition = Array.isArray(definitions) ? definitions[0] : null;
  const targetUri = definition?.targetUri || definition?.uri;
  const targetRange = definition?.targetSelectionRange || definition?.targetRange || definition?.range;
  if (!targetUri || !targetRange) {
    await openStableId(workspaceRoot, stableId);
    return;
  }
  const targetDocument = await vscode.workspace.openTextDocument(targetUri);
  const editor = await vscode.window.showTextDocument(targetDocument, {
    viewColumn: vscode.ViewColumn.Beside,
    preview: false,
    preserveFocus: false,
  });
  editor.selection = new vscode.Selection(targetRange.start, targetRange.end);
  editor.revealRange(targetRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function parseStableIdAsCodeLocation(stableId) {
  const parts = String(stableId || '').split(':');
  for (let index = 0; index <= parts.length - 5; index += 1) {
    const coords = parts.slice(index + 1, index + 5);
    if (!coords.every((part) => /^\d+$/.test(part))) continue;
    const relativePath = parts.slice(0, index + 1).join(':');
    if (!relativePath) continue;
    return {
      relativePath,
      startLine: Number(coords[0]),
      startColumn: Number(coords[1]),
      endLine: Number(coords[2]),
      endColumn: Number(coords[3]),
    };
  }
  return null;
}

async function annotateGraphItem(workspaceRoot, item) {
  const stableId = String(item.stableId || '').trim();
  const targetStableId = item.targetStableId
    || extractFieldFromChatText(item.chatText, 'targetStableId')
    || extractFieldFromChatText(item.chatText, 'targetFn');
  const requestedStableId = resolveAnnotationTargetStableId({ stableId, targetStableId });
  if (!requestedStableId) throw new Error('No stableId found for annotation.');
  const labels = Array.isArray(item.labels) ? item.labels.filter(Boolean) : [];
  const clientContext = compactAnnotationClientContext(item);
  const storedAnnotation = await loadGraphAnnotationFromOrchestrator(
    workspaceRoot,
    requestedStableId,
    stableId && targetStableId ? targetStableId : '',
  );
  const storedText = typeof storedAnnotation === 'string'
    ? storedAnnotation
    : String(storedAnnotation?.text || '');
  const refreshMode = String(item.refreshMode || 'reuse');
  if (storedText && refreshMode === 'reuse') {
    const diagramInsertion = clientContext.diagramPath
      ? await callOrchestratorJson(workspaceRoot, '/api/diagrams/annotations/insert', {
          method: 'POST',
          body: {
            diagramPath: clientContext.diagramPath,
            element: clientContext.element,
            annotationText: storedText,
            annotationMetadata: {
              toolGitCommitShortHash: storedAnnotation?.toolGitCommitShortHash || null,
              maxDepth: storedAnnotation?.maxDepth ?? null,
            },
            replaceExistingForTarget: true,
          },
        })
      : null;
    return {
      annotation: storedText,
      stableId: requestedStableId,
      status: 'ready',
      storage: storedAnnotation?.storage || 'database',
      diagramInsertion,
    };
  }
  const prompt = buildAnnotationWorkflowPrompt({
    orchestratorBaseUrl: resolveOrchestratorBaseUrl(workspaceRoot),
    stableId: requestedStableId,
    clientContext,
    refreshMode,
  });
  await addTextToCodexThread(prompt, requestedStableId, {
    kind: labels[0] || item.kind || 'annotation',
    label: item.label || targetStableId || 'item',
    stableId: requestedStableId,
  }, { includeStableIdHeader: false });
  return {
    annotation: '',
    stableId: requestedStableId,
    status: 'handoff',
  };
}

async function loadGraphAnnotationFromOrchestrator(workspaceRoot, stableId, targetStableId = '') {
  try {
    const search = new URLSearchParams({ stableId });
    if (targetStableId) search.set('targetStableId', targetStableId);
    const payload = await callOrchestratorJson(workspaceRoot, `/api/graph/annotations?${search}`);
    return payload.annotation || null;
  } catch {
    return null;
  }
}

async function loadGraphAnnotationsFromOrchestrator(workspaceRoot) {
  try {
    const payload = await callOrchestratorJson(workspaceRoot, '/api/graph/annotations');
    return payload.annotations || {};
  } catch {
    return {};
  }
}

async function saveDrawioAnnotation(workspaceRoot, item) {
  const stableId = String(item.stableId || '').trim();
  const targetStableId = String(item.targetStableId || '').trim();
  const annotationText = String(item.annotationText || '').trim();
  if (!stableId || !annotationText) {
    throw new Error('Annotation target stableId and text are required.');
  }
  const result = await callOrchestratorJson(workspaceRoot, '/api/diagrams/annotations/update', {
    method: 'POST',
    body: {
      diagramPath: item.diagramPath,
      annotationCellId: item.annotationCellId,
      annotationText,
      stableId,
      targetFn: targetStableId,
      kind: targetStableId ? 'call-edge' : item.kind,
      maxDepth: item.maxDepth,
      source: 'manual-edit',
    },
  });
  return {
    ...result,
    annotationKey: targetStableId ? `${stableId}->${targetStableId}` : stableId,
    stableId,
    targetStableId,
  };
}

async function callOrchestratorJson(workspaceRoot, pathName, { method = 'GET', body } = {}) {
  const baseUrl = resolveOrchestratorBaseUrl(workspaceRoot);
  await ensureOrchestratorRunning(workspaceRoot, baseUrl);
  const response = await fetch(new URL(pathName, baseUrl), {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Orchestrator request failed: ${response.status}`);
  }
  return payload;
}

async function ensureOrchestratorRunning(workspaceRoot, baseUrl) {
  if (await isOrchestratorReachable(baseUrl)) return;
  if (!orchestratorEnsurePromise) {
    orchestratorEnsurePromise = startOrchestratorFromExtension(workspaceRoot, baseUrl)
      .finally(() => {
        orchestratorEnsurePromise = null;
      });
  }
  await orchestratorEnsurePromise;
}

async function isOrchestratorReachable(baseUrl) {
  try {
    const response = await fetch(new URL('/api/status/gateway', baseUrl), { method: 'GET' });
    if (!response.ok) return false;
    const payload = await response.json();
    return payload?.ok !== false && payload?.reachable !== false;
  } catch {
    return false;
  }
}

async function startOrchestratorFromExtension(workspaceRoot, baseUrl) {
  const logDir = path.join(workspaceRoot, 'tmp', 'devops-service-logs');
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, 'orchestrator.vscode.out.log'), 'a');
  const err = fs.openSync(path.join(logDir, 'orchestrator.vscode.err.log'), 'a');
  const ensureScript = path.join(workspaceRoot, 'dev', 'ensureOrchestrator.mjs');
  const child = spawn(process.platform === 'win32' ? 'node.exe' : 'node', [ensureScript], {
    cwd: workspaceRoot,
    env: { ...process.env, ...readGraphEnv(workspaceRoot) },
    stdio: ['ignore', out, err],
    windowsHide: true,
  });
  fs.closeSync(out);
  fs.closeSync(err);

  let childExit = null;
  child.once('exit', (code, signal) => {
    childExit = { code, signal };
  });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await isOrchestratorReachable(baseUrl)) return;
    if (childExit && childExit.code !== 0) {
      throw new Error(`Orchestrator ensure failed. Exit code: ${childExit.code}; signal: ${childExit.signal || '<none>'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Orchestrator did not become reachable at ${baseUrl}. Started PID: ${child.pid || '<unknown>'}`);
}

function resolveOrchestratorBaseUrl(workspaceRoot) {
  const env = readGraphEnv(workspaceRoot);
  const host = env.ORCHESTRATOR_HOST || env.GRAPH_GATEWAY_HOST || '127.0.0.1';
  const port = env.ORCHESTRATOR_PORT || env.GRAPH_GATEWAY_PORT || '8791';
  return `http://${host}:${port}/`;
}

function resolveSourceRoot(workspaceRoot) {
  const configPath = process.env.COLDKODE_PROJECT_CONFIG || path.join(workspaceRoot, 'coldkode.local.json');
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  return path.resolve(workspaceRoot, process.env.COLDKODE_SOURCE_ROOT || config.sourceRoot || '.');
}

function readGraphEnv(workspaceRoot) {
  const envPath = path.join(workspaceRoot, 'graph', '.env');
  if (!fs.existsSync(envPath)) return {};
  const result = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    result[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return result;
}

function extractFieldFromChatText(text, field) {
  const re = new RegExp(`^${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(.+)$`, 'im');
  const match = String(text || '').match(re);
  return match?.[1]?.trim() || '';
}

function interactionCss() {
  return `
    .annotation-popover { position: fixed; right: 18px; bottom: 18px; z-index: 1001; display: none; width: min(520px, calc(100vw - 36px)); max-height: min(460px, calc(100vh - 36px)); padding: 12px 14px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-editorWidget-background); box-shadow: 0 8px 24px rgb(0 0 0 / 28%); color: var(--vscode-foreground); }
    .annotation-text { white-space: pre-wrap; line-height: 1.45; max-height: 330px; overflow: auto; }
    .annotation-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
    .annotation-actions button { padding: 5px 10px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
  `;
}

function interactionMarkup() {
  return `
    <div id="annotationPopover" class="annotation-popover">
      <div id="annotationText" class="annotation-text"></div>
      <div class="annotation-actions">
        <button id="refreshAnnotation" type="button">Обновить</button>
        <button id="closeAnnotation" type="button">Close</button>
      </div>
    </div>
  `;
}

function clearDiagramCache(workspaceRoot) {
  const cacheDir = path.join(workspaceRoot, 'tmp', 'graph-vscode-cache');
  if (!fs.existsSync(cacheDir)) return;
  for (const entry of fs.readdirSync(cacheDir)) {
    if (entry === 'onSubmit-function-flow.drawio') {
      fs.rmSync(path.join(cacheDir, entry), { force: true });
    }
  }
}

function isPathInside(rootPath, candidatePath) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function buildLoadingHtml(label) {
  return `<!doctype html><html><body style="font-family: sans-serif; padding: 20px;"><h2>${escapeHtml(label)}</h2><p>Rendering graph diagram...</p></body></html>`;
}

function buildErrorHtml(label, error) {
  return `<!doctype html><html><body style="font-family: sans-serif; padding: 20px;"><h2>${escapeHtml(label)}</h2><pre>${escapeHtml(error?.stack || error?.message || String(error))}</pre></body></html>`;
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { activate, deactivate };

