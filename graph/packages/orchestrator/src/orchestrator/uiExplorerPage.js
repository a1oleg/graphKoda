function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderUiExplorerPage(baseUrl = 'http://127.0.0.1:8791/') {
  const safeBaseUrl = escapeHtml(baseUrl);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>teleGraph UI Explorer</title>
  <style>
    :root {
      --bg: #f2efe8;
      --panel: rgba(255, 251, 245, 0.96);
      --panel-strong: #fffdf8;
      --line: #d9cfbf;
      --ink: #241f19;
      --muted: #74695b;
      --accent: #1f6f5d;
      --accent-soft: #d9efe7;
      --surface: #dce8f8;
      --affordance: #ffe4b7;
      --function: #f8d4d0;
      --data: #efe3fb;
      --result: #d8efd4;
      --shadow: 0 1rem 2rem rgba(36, 31, 25, 0.08);
      --radius: 1rem;
      --font-display: Georgia, 'Times New Roman', serif;
      --font-body: 'Segoe UI', sans-serif;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: var(--font-body);
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(31, 111, 93, 0.14), transparent 28%),
        radial-gradient(circle at top right, rgba(145, 95, 52, 0.12), transparent 24%),
        linear-gradient(180deg, #f6f2eb, var(--bg));
    }

    .page {
      display: flex;
      padding: 1rem;
      min-height: 100vh;
    }

    .panel {
      background: var(--panel);
      border: 1px solid rgba(114, 105, 91, 0.18);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      min-height: 0;
      width: 100%;
    }

    .panelHeader {
      padding: 1rem 1rem 0.75rem;
      border-bottom: 1px solid rgba(114, 105, 91, 0.14);
      background: linear-gradient(180deg, rgba(255,255,255,0.75), rgba(255,255,255,0));
    }

    .panelTitle {
      margin: 0;
      font-family: var(--font-display);
      font-size: 1.25rem;
      line-height: 1.15;
    }

    .panelMeta {
      margin-top: 0.35rem;
      color: var(--muted);
      font-size: 0.9rem;
      line-height: 1.35;
    }

    .panelBody {
      padding: 1rem;
      overflow: auto;
      min-height: 0;
    }

    .filterStack {
      display: grid;
      gap: 0.65rem;
      margin-bottom: 0.85rem;
    }

    .familyFilter {
      margin-bottom: 0.85rem;
      padding: 0.75rem;
      border: 1px solid rgba(36, 31, 25, 0.1);
      border-radius: 0.75rem;
      background: rgba(255, 255, 255, 0.6);
    }

    .filterStack .familyFilter {
      margin-bottom: 0;
    }

    .familyFilterHeader {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 0.75rem;
      margin-bottom: 0.55rem;
    }

    .familyFilterTitle {
      font-size: 0.85rem;
      font-weight: 700;
    }

    .familyFilterMeta {
      color: var(--muted);
      font-size: 0.75rem;
    }

    .familyFilterOptions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem 0.55rem;
    }

    .familyFilterOption {
      display: inline-flex;
      align-items: center;
      gap: 0.32rem;
      min-width: 0;
      padding: 0.16rem 0.45rem;
      border: 1px solid rgba(36, 31, 25, 0.12);
      border-radius: 999px;
      background: rgba(255, 253, 248, 0.84);
      color: var(--ink);
      font-size: 0.76rem;
      line-height: 1.25;
      cursor: pointer;
      user-select: none;
    }

    .familyFilterOption input {
      width: 0.9rem;
      height: 0.9rem;
      margin: 0;
      accent-color: var(--accent);
    }

    .treeRoot {
      display: grid;
      grid-template-columns: minmax(18rem, 0.9fr) minmax(24rem, 1.4fr) minmax(18rem, 0.9fr);
      grid-template-areas:
        "app app app"
        "topOverlay topOverlay topOverlay"
        "left middle right"
        "bottomOverlay modalOverlay effectOverlay"
        "main main main";
      gap: 0.85rem;
      align-items: start;
    }

    .uiBlock {
      min-width: 0;
      min-height: 14rem;
      border: 1px solid rgba(36, 31, 25, 0.12);
      border-radius: 0.75rem;
      background: rgba(255, 255, 255, 0.62);
      overflow: hidden;
    }

    .uiBlock[data-region='app'] {
      grid-area: app;
      min-height: 8rem;
    }

    .uiBlock[data-region='topOverlay'] {
      grid-area: topOverlay;
      min-height: 8rem;
      border-color: rgba(31, 111, 93, 0.22);
      background: rgba(217, 239, 231, 0.45);
    }

    .uiBlock[data-region='left'] {
      grid-area: left;
    }

    .uiBlock[data-region='middle'] {
      grid-area: middle;
      min-height: 28rem;
    }

    .uiBlock[data-region='right'] {
      grid-area: right;
    }

    .uiBlock[data-region='main'] {
      grid-area: main;
      min-height: 10rem;
    }

    .uiBlock[data-region='bottomOverlay'] {
      grid-area: bottomOverlay;
      min-height: 10rem;
    }

    .uiBlock[data-region='modalOverlay'] {
      grid-area: modalOverlay;
      min-height: 10rem;
    }

    .uiBlock[data-region='effectOverlay'] {
      grid-area: effectOverlay;
      min-height: 10rem;
    }

    .blockHeader {
      padding: 0.75rem 0.85rem 0.55rem;
      border-bottom: 1px solid rgba(36, 31, 25, 0.1);
      background: rgba(255, 253, 248, 0.72);
    }

    .blockTitle {
      margin: 0;
      font-size: 0.95rem;
      line-height: 1.2;
      font-weight: 700;
    }

    .blockTitleLine {
      display: flex;
      min-width: 0;
      align-items: center;
      gap: 0.45rem;
      flex-wrap: wrap;
    }

    .blockMeta {
      margin-top: 0.25rem;
      color: var(--muted);
      font-size: 0.78rem;
      line-height: 1.35;
    }

    .blockBody {
      padding: 0.75rem;
      overflow: auto;
      max-height: 58vh;
    }

    .treeList,
    .treeList ul {
      list-style: none;
      margin: 0;
      padding-left: 1rem;
    }

    .treeList {
      padding-left: 0;
    }

    .treeNode {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.25rem 0;
      min-width: 0;
    }

    .treeNode button,
    .treeNodeAction,
    .toolbar button,
    .detailAffordance button,
    .filterSectionToggle,
    .objectFunctionToggle {
      border: 1px solid rgba(36, 31, 25, 0.14);
      background: rgba(255,255,255,0.82);
      color: var(--ink);
      border-radius: 999px;
      padding: 0.3rem 0.65rem;
      font: inherit;
      cursor: pointer;
    }

    .filterSectionToggle,
    .objectFunctionToggle {
      width: 1.65rem;
      min-width: 1.65rem;
      padding: 0.2rem 0;
      text-align: center;
    }

    .objectFunctionGroup {
      margin: -0.1rem 0 0.35rem 1.6rem;
      color: var(--muted);
      font-size: 0.78rem;
    }

    .objectFunctionSummary {
      margin-left: 0.4rem;
    }

    .objectFunctionList {
      display: grid;
      gap: 0.18rem;
      margin-top: 0.35rem;
      padding-left: 2.05rem;
    }

    .objectFunctionRow {
      display: block;
      min-width: 0;
    }

    .objectFunctionName {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--ink);
    }

    .treeToggle {
      width: 1.8rem;
      min-width: 1.8rem;
      padding: 0.3rem 0;
      text-align: center;
    }

    .treeNodeAction {
      background: var(--accent-soft);
      border-color: rgba(31, 111, 93, 0.22);
      color: #0f4b3d;
    }

    .treeLabelButton {
      border: 0;
      background: transparent;
      padding: 0;
      min-width: 0;
      text-align: left;
      cursor: pointer;
      color: inherit;
      flex: 1 1 auto;
    }

    .treeLabel {
      display: block;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .treeLabelLine {
      display: flex;
      min-width: 0;
      align-items: center;
      gap: 0.4rem;
      flex-wrap: wrap;
    }

    .domainActionBadge {
      flex: 0 0 auto;
      border-radius: 999px;
      max-width: 18rem;
      padding: 0.08rem 0.5rem;
      background: #1f6f5d;
      color: white;
      font-size: 0.72rem;
      font-weight: 700;
      line-height: 1.35;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .domainActionBadge[data-scope='branch'] {
      background: #315f8d;
    }

    .domainActionBadge[data-scope='object'] {
      background: #7b4d8f;
    }

    .treeMeta {
      display: block;
      font-size: 0.8rem;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .pathForest {
      display: grid;
      gap: 0.35rem;
    }

    .pathEmpty {
      color: var(--muted);
      font-size: 0.82rem;
      line-height: 1.45;
    }

    .pathBranch {
      border-left: 1px solid rgba(36, 31, 25, 0.12);
      margin-left: 0.35rem;
      padding-left: 0.5rem;
    }

    .pathNodeLine {
      display: flex;
      min-width: 0;
      align-items: center;
      gap: 0.25rem;
      padding: 0.1rem 0;
      flex-wrap: wrap;
    }

    .pathCrumb {
      display: inline-flex;
      max-width: 18rem;
      min-width: 0;
      align-items: center;
      gap: 0.28rem;
      border: 1px solid rgba(36, 31, 25, 0.12);
      border-radius: 999px;
      background: rgba(255, 253, 248, 0.88);
      padding: 0.18rem 0.55rem;
      font-size: 0.78rem;
      line-height: 1.25;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .pathCrumb[data-terminal='false'] {
      display: inline;
      max-width: none;
      border: 0;
      border-radius: 0;
      background: transparent;
      padding: 0;
      color: var(--ink);
      font-size: 0.82rem;
      font-weight: 400;
      overflow: visible;
      text-overflow: clip;
    }

    .pathCrumb[data-terminal='false']::after {
      content: '/';
      color: var(--muted);
      margin-left: 0.25rem;
    }

    .pathCrumb[data-terminal='true'] {
      border-color: rgba(31, 111, 93, 0.3);
      background: rgba(217, 239, 231, 0.72);
      font-weight: 700;
    }

    .pathMeta {
      color: var(--muted);
      font-size: 0.72rem;
    }

    .selected > .treeNode .treeLabel {
      color: var(--accent);
    }

    .placeholder {
      color: var(--muted);
      line-height: 1.5;
      font-size: 0.95rem;
    }

    .statusBar {
      position: fixed;
      left: 1rem;
      right: 1rem;
      bottom: 1rem;
      padding: 0.75rem 1rem;
      border-radius: 999px;
      background: rgba(36, 31, 25, 0.9);
      color: white;
      box-shadow: var(--shadow);
      opacity: 0;
      transform: translateY(1rem);
      transition: opacity 180ms ease, transform 180ms ease;
      pointer-events: none;
    }

    .statusBar[data-visible='true'] {
      opacity: 1;
      transform: translateY(0);
    }

    @media (max-width: 1100px) {
      .treeRoot {
        grid-template-columns: 1fr;
        grid-template-areas:
          "app"
          "topOverlay"
          "left"
          "middle"
          "right"
          "bottomOverlay"
          "modalOverlay"
          "effectOverlay"
          "main";
      }

      .panel {
        min-height: 24rem;
      }
    }
  </style>
</head>
<body>
  <div class="page">
    <section class="panel">
      <header class="panelHeader">
        <h1 class="panelTitle">UI Creation Explorer</h1>
        <div class="panelMeta">Top UI blocks from Neo4j. Select an object to render full UI paths to creation/send terminals inside each block.</div>
      </header>
      <div class="panelBody">
        <div class="filterStack">
          <div id="objectFilter" class="familyFilter"></div>
        </div>
        <div id="treeRoot" class="treeRoot"></div>
      </div>
    </section>
  </div>

  <div id="statusBar" class="statusBar" data-visible="false"></div>

  <script>
    const BASE_URL = ${JSON.stringify(safeBaseUrl)};
    const API_BASE = new URL('.', BASE_URL).toString();
    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    const state = {
      expandedKeys: new Set(),
      childrenByKey: new Map(),
      leafKeys: new Set(),
      blocks: [],
      availableObjectKeys: [],
      objectCatalogByKey: new Map(),
      expandedObjectFunctionKeys: new Set(),
      objectFunctionsByObjectKey: new Map(),
      objectPathsByObjectKey: new Map(),
      selectedObjectKeys: new Set(),
      blockScrollTopById: new Map(),
    };

    const treeRoot = document.getElementById('treeRoot');
    const objectFilter = document.getElementById('objectFilter');
    const statusBar = document.getElementById('statusBar');

    function setStatus(message, isError = false) {
      statusBar.textContent = message;
      statusBar.style.background = isError ? 'rgba(122, 28, 40, 0.92)' : 'rgba(36, 31, 25, 0.92)';
      statusBar.dataset.visible = 'true';
      clearTimeout(setStatus.timeoutId);
      setStatus.timeoutId = setTimeout(() => {
        statusBar.dataset.visible = 'false';
      }, 2600);
    }

    async function fetchJson(path) {
      const response = await fetch(new URL(path, API_BASE));
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Request failed');
      }
      return payload;
    }

    async function loadObjectFunctions(objectKey) {
      if (state.objectFunctionsByObjectKey.has(objectKey)) {
        return state.objectFunctionsByObjectKey.get(objectKey);
      }

      const query = new URLSearchParams({ objectKey });
      const payload = await fetchJson('/api/ui-explorer/object-functions?' + query.toString());
      const functions = payload.functions || [];
      state.objectFunctionsByObjectKey.set(objectKey, functions);
      return functions;
    }

    async function loadObjectPaths(objectKey) {
      if (state.objectPathsByObjectKey.has(objectKey)) {
        return state.objectPathsByObjectKey.get(objectKey);
      }

      const query = new URLSearchParams({ objectKey });
      const payload = await fetchJson('/api/ui-explorer/object-paths?' + query.toString());
      const paths = payload.paths || [];
      state.objectPathsByObjectKey.set(objectKey, paths);
      return paths;
    }

    async function loadObjectCatalog() {
      const payload = await fetchJson('/api/ui-explorer/objects');
      const objects = payload.objects || [];
      state.objectCatalogByKey = new Map(objects.map((item) => [item.objectKey, item]));
      state.availableObjectKeys = objects.map((item) => item.objectKey).filter(Boolean).sort();
    }

    async function loadTopBlocks() {
      const payload = await fetchJson('/api/ui-explorer/top-blocks');
      state.blocks = payload.blocks || [];
    }

    function getSelectedAffordanceObjectDetails(surface) {
      if (surface.ownerKind !== 'ui-affordance') {
        return [];
      }

      return (surface.objectDomainDetails || [])
        .filter((detail) => detail?.objectKey && state.selectedObjectKeys.has(detail.objectKey))
        .map((detail) => ({
          objectKey: detail.objectKey,
          familyKeys: detail.familyKeys || [],
          evidenceKinds: detail.evidenceKinds || [],
          functionNames: detail.functionNames || [],
          exposureSurfaceKeys: detail.exposureSurfaceKeys || [],
          ownerSurfaceKeys: [],
          isTerminal: true,
        }))
        .sort((left, right) => left.objectKey.localeCompare(right.objectKey));
    }

    async function setObjectSelected(objectKey, checked) {
      if (checked) {
        const paths = await loadObjectPaths(objectKey);
        if (!paths.length) {
          throw new Error(objectKey + ': no prepared UI paths yet');
        }
        state.selectedObjectKeys.add(objectKey);
      } else {
        state.selectedObjectKeys.delete(objectKey);
      }
    }

    function formatObjectBadgeText(item) {
      const functionNames = item.functionNames || [];
      if (functionNames.length) {
        return item.objectKey + ': ' + functionNames.join(', ');
      }
      return item.objectKey;
    }

    function getSelectedPathsForBlock(blockKey) {
      return [...state.selectedObjectKeys].flatMap((objectKey) => (
        state.objectPathsByObjectKey.get(objectKey) || []
      ).filter((path) => path.blockKey === blockKey));
    }

    function getSelectedPathSummariesForBlock(blockKey) {
      const byObjectKey = new Map();
      getSelectedPathsForBlock(blockKey).forEach((path) => {
        if (!path.objectKey || byObjectKey.has(path.objectKey)) {
          return;
        }
        byObjectKey.set(path.objectKey, {
          objectKey: path.objectKey,
          familyKeys: [],
          evidenceKinds: [],
          functionNames: [],
        });
      });
      return [...byObjectKey.values()].sort((left, right) => left.objectKey.localeCompare(right.objectKey));
    }

    function makePathNodeKey(segment) {
      return [
        segment.kind || 'surface',
        segment.key || '',
        segment.objectKey || '',
        segment.functionName || '',
      ].join(':');
    }

    function buildPathForest(paths) {
      const root = { children: new Map(), paths: [] };
      for (const path of paths || []) {
        let cursor = root;
        const segments = (path.surfaces || []).map((surface) => ({
            kind: 'surface',
            key: surface.key,
            label: surface.ownerName || '(unnamed surface)',
            meta: [surface.surfaceKind, surface.ownerRepoRelativePath].filter(Boolean).join(' | '),
          }));

        for (const segment of segments) {
          const key = makePathNodeKey(segment);
          if (!cursor.children.has(key)) {
            cursor.children.set(key, {
              ...segment,
              children: new Map(),
              terminalPaths: [],
            });
          }
          cursor = cursor.children.get(key);
        }
        if (!segments.length) {
          const key = makePathNodeKey({
            kind: 'surface',
            key: path.terminal?.key || path.objectFunctionKey,
            label: path.terminal?.ownerName || path.functionName || '(object function)',
            meta: [path.terminal?.surfaceKind, path.terminal?.handlerName].filter(Boolean).join(' | '),
          });
          if (!cursor.children.has(key)) {
            cursor.children.set(key, {
              kind: 'surface',
              key,
              label: path.terminal?.ownerName || path.functionName || '(object function)',
              meta: [path.terminal?.surfaceKind, path.terminal?.handlerName].filter(Boolean).join(' | '),
              children: new Map(),
              terminalPaths: [],
            });
          }
          cursor = cursor.children.get(key);
        }
        cursor.terminalPaths.push(path);
      }
      return root;
    }

    function makePathBadge(path) {
      const badge = document.createElement('span');
      badge.className = 'domainActionBadge';
      badge.dataset.scope = 'object';
      const displayFunctionName = path.uiActionName || path.terminal?.uiActionName || path.functionName;
      badge.textContent = path.objectKey + (displayFunctionName ? ': ' + displayFunctionName : '');
      badge.title = [
        path.objectKey,
        displayFunctionName ? 'UI action: ' + displayFunctionName : undefined,
        path.functionName && path.functionName !== displayFunctionName ? 'Business function: ' + path.functionName : undefined,
        path.terminal?.elementName ? 'Element: ' + path.terminal.elementName : undefined,
        path.terminal?.eventName ? 'Event: ' + path.terminal.eventName : undefined,
        path.terminal?.handlerName ? 'Handler: ' + path.terminal.handlerName : undefined,
        path.terminal?.line ? 'Line: ' + path.terminal.line : undefined,
        path.terminal?.tagPath ? 'Tag: ' + path.terminal.tagPath : undefined,
        path.terminal?.exposureKey ? 'Exposure: ' + path.terminal.exposureKey : undefined,
      ].filter(Boolean).join('\\n');
      return badge;
    }

    function renderPathTreeNode(node) {
      const wrapper = document.createElement('div');
      wrapper.className = 'pathBranch';

      const chain = [];
      let cursor = node;
      while (cursor) {
        chain.push(cursor);
        const children = [...cursor.children.values()];
        if (cursor.kind === 'terminal' || (cursor.terminalPaths || []).length || children.length !== 1) {
          break;
        }
        cursor = children[0];
      }

      const line = document.createElement('div');
      line.className = 'pathNodeLine';

      chain.forEach((segment) => {
        const crumb = document.createElement('span');
        crumb.className = 'pathCrumb';
        crumb.dataset.terminal = segment.kind === 'terminal' ? 'true' : 'false';
        crumb.textContent = segment.label;
        crumb.title = [segment.label, segment.meta].filter(Boolean).join('\\n');
        line.append(crumb);

        if (segment.kind === 'terminal' && segment.meta) {
          const meta = document.createElement('span');
          meta.className = 'pathMeta';
          meta.textContent = segment.meta;
          line.append(meta);
        }

        const terminalBadgeKeys = new Set();
        (segment.terminalPaths || []).forEach((path) => {
          const badgeKey = [path.objectKey, path.functionName].filter(Boolean).join(':');
          if (terminalBadgeKeys.has(badgeKey)) {
            return;
          }
          terminalBadgeKeys.add(badgeKey);
          line.append(makePathBadge(path));
        });
      });
      wrapper.append(line);

      const lastSegment = chain[chain.length - 1];
      [...lastSegment.children.values()]
        .sort((left, right) => left.label.localeCompare(right.label))
        .forEach((child) => wrapper.append(renderPathTreeNode(child)));

      return wrapper;
    }

    function renderPathForest(block) {
      const paths = getSelectedPathsForBlock(block.id);
      const container = document.createElement('div');
      container.className = 'pathForest';
      if (!paths.length) {
        const empty = document.createElement('div');
        empty.className = 'pathEmpty';
        empty.textContent = state.selectedObjectKeys.size
          ? 'No selected object paths in this block.'
          : 'Select an object to render UI paths.';
        container.append(empty);
        return container;
      }

      const forest = buildPathForest(paths);
      [...forest.children.values()]
        .sort((left, right) => left.label.localeCompare(right.label))
        .forEach((child) => container.append(renderPathTreeNode(child)));
      return container;
    }

    function appendObjectBadges(container, objectItems, titlePrefix) {
      (objectItems || []).filter(Boolean).forEach((item) => {
        const badge = document.createElement('span');
        badge.className = 'domainActionBadge';
        badge.dataset.scope = 'object';
        badge.textContent = formatObjectBadgeText(item);
        badge.title = titlePrefix + ': ' + item.objectKey
          + (item.familyKeys?.length ? '\\nFamilies: ' + item.familyKeys.join(', ') : '')
          + (item.functionNames?.length ? '\\nFunctions: ' + item.functionNames.join(', ') : '')
          + (item.evidenceKinds?.length ? '\\nEvidence: ' + item.evidenceKinds.join(', ') : '');
        container.append(badge);
      });
    }

    function makeNodeKey(surface, parentNodeKey = '') {
      return parentNodeKey ? parentNodeKey + '>' + surface.key : surface.key;
    }

    async function expandSurface(surface, nodeKey) {
      if (!state.childrenByKey.has(nodeKey)) {
        const query = new URLSearchParams({ surfaceKey: surface.key });
        if (surface.parentKey) {
          query.set('parentSurfaceKey', surface.parentKey);
        }
        const payload = await fetchJson('/api/ui-explorer/children?' + query.toString());
        const children = payload.children || [];
        state.childrenByKey.set(nodeKey, children);
        if (!children.length) {
          state.leafKeys.add(nodeKey);
          renderTree();
          return;
        }
      }
      state.expandedKeys.add(nodeKey);
      renderTree();
    }

    function collapseSurface(nodeKey) {
      state.expandedKeys.delete(nodeKey);
      renderTree();
    }

    function makeTreeBranch(surface, depth = 0, parentNodeKey = '', options = {}) {
      const nodeKey = makeNodeKey(surface, parentNodeKey);
      const item = document.createElement('li');
      item.dataset.key = nodeKey;

      const row = document.createElement('div');
      row.className = 'treeNode';

      const isKnownLeaf = state.leafKeys.has(nodeKey) || surface.hasChildren === false || surface.ownerKind === 'ui-affordance';

      const toggle = document.createElement('button');
      toggle.className = 'treeToggle';
      toggle.textContent = isKnownLeaf ? 'В·' : (state.expandedKeys.has(nodeKey) ? 'в€’' : '+');
      toggle.title = isKnownLeaf ? 'No child UI nodes' : (state.expandedKeys.has(nodeKey) ? 'Collapse' : 'Expand');
      toggle.disabled = isKnownLeaf;
      toggle.addEventListener('click', async () => {
        try {
          if (isKnownLeaf) {
            return;
          }
          if (state.expandedKeys.has(nodeKey)) {
            collapseSurface(nodeKey);
          } else {
            await expandSurface(surface, nodeKey);
          }
        } catch (error) {
          setStatus(error.message || String(error), true);
        }
      });
      row.append(toggle);

      const labelButton = document.createElement('button');
      labelButton.className = 'treeLabelButton';
      labelButton.innerHTML = '<span class="treeLabelLine"><span class="treeLabel"></span></span><span class="treeMeta"></span>';
      labelButton.querySelector('.treeLabel').textContent = surface.ownerName || '(unnamed surface)';
      appendObjectBadges(
        labelButton.querySelector('.treeLabelLine'),
        surface.ownerKind === 'ui-affordance'
          ? getSelectedAffordanceObjectDetails(surface)
          : [],
        'Creation/send trace on this path',
      );
      labelButton.querySelector('.treeMeta').textContent = [
        surface.surfaceKind,
        surface.layout?.summary,
        surface.via || undefined,
      ].filter(Boolean).join(' | ');
      row.append(labelButton);

      item.append(row);

      if (state.expandedKeys.has(nodeKey)) {
        const children = state.childrenByKey.get(nodeKey) || [];
        if (children.length) {
          const childList = document.createElement('ul');
          children.forEach((child) => {
            childList.append(makeTreeBranch(child, depth + 1, nodeKey, options));
          });
          item.append(childList);
        }
      }

      return item;
    }

    function makeBlock(block) {
      const blockElement = document.createElement('section');
      blockElement.className = 'uiBlock';
      blockElement.dataset.region = block.region || 'main';
      blockElement.dataset.blockId = block.id || '';

      const header = document.createElement('header');
      header.className = 'blockHeader';
      header.innerHTML = '<h2 class="blockTitle"><span class="blockTitleLine"><span class="blockTitleText"></span></span></h2><div class="blockMeta"></div>';
      header.querySelector('.blockTitleText').textContent = block.title || 'UI Block';
      appendObjectBadges(
        header.querySelector('.blockTitleLine'),
        state.selectedObjectKeys.size
          ? getSelectedPathSummariesForBlock(block.id)
          : [],
        'Creation/send trace in this UI block',
      );
      header.querySelector('.blockMeta').textContent = block.description || '';
      blockElement.append(header);

      const body = document.createElement('div');
      body.className = 'blockBody';
      body.dataset.blockId = block.id || '';
      if (state.selectedObjectKeys.size) {
        body.append(renderPathForest(block));
      } else {
        const list = document.createElement('ul');
        list.className = 'treeList';
        const nodes = block.nodes?.length ? block.nodes : (block.root ? [block.root] : []);
        nodes.forEach((node) => list.append(makeTreeBranch(node)));
        body.append(list);
      }
      blockElement.append(body);

      return blockElement;
    }

    function renderCheckboxFilter(container, {
      title,
      hiddenMeta,
      activeMeta,
      keys,
      isChecked,
      isIndeterminate,
      isDisabled = () => false,
      onToggle,
      formatLabel = (value) => value,
      renderExtra,
    }) {
      container.innerHTML = '';
      const header = document.createElement('div');
      header.className = 'familyFilterHeader';
      header.innerHTML = '<div class="familyFilterTitle"></div><div class="familyFilterMeta"></div>';
      header.querySelector('.familyFilterTitle').textContent = title;
      header.querySelector('.familyFilterMeta').textContent = state.selectedObjectKeys.size ? activeMeta : hiddenMeta;
      container.append(header);

      const options = document.createElement('div');
      options.className = 'familyFilterOptions';

      keys.forEach((key) => {
        const option = document.createElement('label');
        option.className = 'familyFilterOption';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.disabled = isDisabled(key);
        checkbox.checked = isChecked(key);
        checkbox.indeterminate = isIndeterminate(key);
        checkbox.addEventListener('change', async () => {
          try {
            await onToggle(key, checkbox.checked);
            renderTree();
          } catch (error) {
            checkbox.checked = !checkbox.checked;
            setStatus(error.message || String(error), true);
          }
        });
        const label = document.createElement('span');
        label.textContent = formatLabel(key);
        label.title = key;
        if (checkbox.disabled) {
          option.title = key + ': no prepared object traces';
        }
        option.append(checkbox, label);
        options.append(option);
        if (renderExtra) {
          const extra = renderExtra(key);
          if (extra) {
            options.append(extra);
          }
        }
      });

      container.append(options);
    }

    function renderObjectFunctionList(objectKey) {
      const wrapper = document.createElement('div');
      wrapper.className = 'objectFunctionGroup';
      wrapper.dataset.expanded = state.expandedObjectFunctionKeys.has(objectKey) ? 'true' : 'false';

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'objectFunctionToggle';
      toggle.textContent = state.expandedObjectFunctionKeys.has(objectKey) ? '-' : '+';
      toggle.title = state.expandedObjectFunctionKeys.has(objectKey)
        ? 'Collapse object functions'
        : 'Expand object functions';
      toggle.addEventListener('click', async () => {
        try {
          if (state.expandedObjectFunctionKeys.has(objectKey)) {
            state.expandedObjectFunctionKeys.delete(objectKey);
          } else {
            state.expandedObjectFunctionKeys.add(objectKey);
            await loadObjectFunctions(objectKey);
          }
          renderTree();
        } catch (error) {
          setStatus(error.message || String(error), true);
        }
      });

      const summary = document.createElement('span');
      summary.className = 'objectFunctionSummary';
      summary.textContent = 'creation/send functions';
      wrapper.append(toggle, summary);

      if (!state.expandedObjectFunctionKeys.has(objectKey)) {
        return wrapper;
      }

      const list = document.createElement('div');
      list.className = 'objectFunctionList';
      const functions = state.objectFunctionsByObjectKey.get(objectKey) || [];
      functions.slice(0, 80).forEach((item) => {
        const row = document.createElement('div');
        row.className = 'objectFunctionRow';
        const name = document.createElement('span');
        name.className = 'objectFunctionName';
        name.textContent = item.functionName || '(unnamed)';
        name.title = item.targetRepoRelativePath || item.functionName || '';
        row.append(name);
        list.append(row);
      });
      wrapper.append(list);
      return wrapper;
    }

    function renderObjectFilter() {
      renderCheckboxFilter(objectFilter, {
        title: 'Creates / sends',
        hiddenMeta: 'Creation/send traces hidden by default',
        activeMeta: 'Showing selected creation/send traces',
        keys: state.availableObjectKeys,
        isChecked: (objectKey) => state.selectedObjectKeys.has(objectKey),
        isIndeterminate: () => false,
        isDisabled: (objectKey) => !state.objectCatalogByKey.has(objectKey),
        onToggle: setObjectSelected,
        renderExtra: renderObjectFunctionList,
      });
    }

    function rememberBlockScrollPositions() {
      document.querySelectorAll('.blockBody[data-block-id]').forEach((body) => {
        if (body.dataset.blockId) {
          state.blockScrollTopById.set(body.dataset.blockId, body.scrollTop);
        }
      });
    }

    function restoreBlockScrollPositions() {
      document.querySelectorAll('.blockBody[data-block-id]').forEach((body) => {
        if (!body.dataset.blockId) {
          return;
        }

        const scrollTop = state.blockScrollTopById.get(body.dataset.blockId);
        if (scrollTop !== undefined) {
          body.scrollTop = scrollTop;
        }
      });
    }

    function renderTree() {
      rememberBlockScrollPositions();
      renderObjectFilter();
      treeRoot.innerHTML = '';
      state.blocks.forEach((block) => treeRoot.append(makeBlock(block)));
      requestAnimationFrame(restoreBlockScrollPositions);
    }

    async function boot() {
      try {
        await loadTopBlocks();
        await loadObjectCatalog();
        renderTree();
      } catch (error) {
        setStatus(error.message || String(error), true);
        treeRoot.innerHTML = '<p class="placeholder">Explorer failed to load. Check orchestrator logs and Neo4j connectivity.</p>';
      }
    }

    boot();
  </script>
</body>
</html>`;
}


