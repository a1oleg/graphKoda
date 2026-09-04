const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const pluginSource = fs.readFileSync(
  path.resolve(__dirname, '../vendor/drawio/src/main/webapp/plugins/codexGraph.js'),
  'utf8',
);

function loadMenu(attributes, options = {}) {
  const posted = [];
  const items = [];
  const fetched = [];
  const modelListeners = [];
  const selectionListeners = [];
  const windowMessageListeners = [];
  const elements = [];
  const createElement = (tagName) => {
    const listeners = {};
    const element = {
      tagName,
      style: {},
      children: [],
      textContent: '',
      innerHTML: '',
      value: '',
      disabled: false,
      offsetWidth: 132,
      offsetHeight: 30,
      appendChild(child) { this.children.push(child); },
      addEventListener(name, listener) { listeners[name] = listener; },
      dispatch(name) { listeners[name]?.({ preventDefault() {} }); },
    };
    elements.push(element);
    return element;
  };
  const rootFunctionStableId = options.rootFunctionStableId || '';
  const rootStartStableId = options.rootStartStableId || '';
  const rootCell = rootFunctionStableId || rootStartStableId ? {
    id: 'function-start',
    getAttribute(name) {
      return {
        stableId: rootStartStableId,
        graphKind: rootStartStableId ? 'Start' : '',
        graphLabels: rootStartStableId ? 'Start,FunctionStart,ExecutionBoundary' : 'Fn',
        graphLabel: 'Start',
        functionStableId: rootFunctionStableId,
      }[name] || '';
    },
  } : null;
  const model = {
    cells: rootCell ? { [rootCell.id]: rootCell } : {},
    isVertex: (cell) => cell === rootCell,
    isEdge: (cell) => cell?.edge === true,
    getTerminal: (edge, source) => source ? edge.source : edge.target,
    isVisible: (cell) => cell.visible !== false,
    setVisible: (cell, visible) => { cell.visible = visible; },
    getCell: (id) => model.cells[id] || null,
    setValue: (cell, value) => { cell.value = value; },
    setStyle: (cell, style) => { cell.style = style; },
    addListener(name, listener) { modelListeners.push(listener); },
    beginUpdate() {},
    endUpdate() {},
  };
  let selectedCell = null;
  const graph = {
    popupMenuHandler: { factoryMethod: null },
    getModel: () => model,
    getLinkForCell: () => '',
    container: { appendChild() {}, addEventListener() {} },
    view: {
      getState: () => ({ x: 10, y: 10, width: 240, height: 72 }),
      addListener() {},
    },
    cellEditor: { editingCell: null, textarea: null },
    getSelectionCell: () => selectedCell,
    getSelectionModel: () => ({ addListener(name, listener) { selectionListeners.push(listener); } }),
    isCellEditable: () => true,
    stopEditing() {},
    refresh() {},
  };
  let uiRefreshCount = 0;
  const tabContainer = { style: { display: '' } };
  const ui = {
    editor: { graph },
    tabContainer,
    tabContainerVisible: true,
    isTabContainerVisible() { return this.tabContainerVisible; },
    updateTabContainer() {
      this.tabContainer.style.display = this.isTabContainerVisible() ? '' : 'none';
    },
    refresh() { uiRefreshCount += 1; },
  };
  let pluginIndex = 0;
  vm.runInNewContext(pluginSource, {
    Draw: {
      loadPlugin(callback) {
        if (pluginIndex++ === 0) callback(ui);
      },
    },
    window: {
      location: { protocol: 'http:', hostname: '127.0.0.1' },
      parent: {
        postMessage(message) {
          posted.push(JSON.parse(message));
        },
      },
      addEventListener(name, listener) {
        if (name === 'message') windowMessageListeners.push(listener);
      },
      setTimeout(callback) { callback(); },
    },
    document: { createElement },
    mxEvent: { CHANGE: 'change', SCALE: 'scale', TRANSLATE: 'translate' },
    fetch(url) {
      fetched.push(String(url));
      return new Promise(() => {});
    },
  });
  const cell = {
    id: 'fixture-cell',
    value: attributes.graphLabel || '',
    geometry: {},
    getAttribute(name) {
      return attributes[name] || '';
    },
  };
  selectedCell = cell;
  selectionListeners.forEach((listener) => listener());
  model.cells[cell.id] = cell;
  if (attributes.graphKind === 'Annotation' && options.annotationLink !== false) {
    const target = { id: 'annotation-target' };
    model.cells[target.id] = target;
    model.cells['annotation-link'] = {
      id: 'annotation-link',
      edge: true,
      source: cell,
      target,
      visible: options.annotationLinkVisible === true,
      getAttribute(name) {
        return name === 'annotationLink' ? '1' : '';
      },
    };
  }
  graph.popupMenuHandler.factoryMethod({
    addSeparator() {},
    addItem(title, icon, action) {
      items.push({ title, action });
    },
  }, cell, {});
  const buttons = elements.filter((element) => element.tagName === 'button');
  const annotationControls = elements.find((element) => element.tagName === 'div');
  return {
    items,
    posted,
    fetched,
    cell,
    model,
    buttons,
    annotationControls,
    ui,
    tabContainer,
    getUiRefreshCount: () => uiRefreshCount,
    notifyModelChange: () => modelListeners.forEach((listener) => listener()),
    dispatchWindowMessage: (data) => windowMessageListeners.forEach((listener) => listener({ data })),
  };
}

test('page tab bar stays hidden because every diagram is a separate file', () => {
  const result = loadMenu({ graphKind: 'Value', graphLabel: 'input' });
  assert.equal(result.ui.tabContainerVisible, false);
  assert.equal(result.ui.isTabContainerVisible(), false);
  assert.equal(result.tabContainer.style.display, 'none');
  assert.equal(result.getUiRefreshCount(), 1);

  result.ui.tabContainerVisible = true;
  result.ui.updateTabContainer();
  assert.equal(result.tabContainer.style.display, 'none');
});

test('annotation nodes exclusively expose a persistent connector visibility toggle', () => {
  const hidden = loadMenu({ graphKind: 'Annotation', graphLabel: 'annotation' });
  const show = hidden.items.find((item) => item.title === 'показать Связь');
  assert.ok(show);
  assert.equal(hidden.items.some((item) => item.title === 'скрыть Связь'), false);
  show.action();

  const visible = loadMenu(
    { graphKind: 'Annotation', graphLabel: 'annotation' },
    { annotationLinkVisible: true },
  );
  assert.equal(visible.items.some((item) => item.title === 'скрыть Связь'), true);

  const ordinary = loadMenu({ stableId: 'fixture.ts:1:1:1:2', graphLabels: 'Value' });
  assert.equal(ordinary.items.some((item) => item.title === 'показать Связь'), false);
  assert.equal(ordinary.items.some((item) => item.title === 'скрыть Связь'), false);
});

test('annotation edit controls appear only after a change and cancel restores the baseline', () => {
  const result = loadMenu({
    graphKind: 'Annotation',
    graphLabel: 'Saved text',
    annotationSavedText: 'Saved text',
  });
  const save = result.buttons.find((button) => button.textContent === 'Сохранить');
  const cancel = result.buttons.find((button) => button.textContent === 'Отменить');

  assert.ok(save);
  assert.ok(cancel);
  assert.equal(result.annotationControls.style.display, 'none');
  result.cell.value = 'Edited text';
  result.notifyModelChange();
  assert.equal(result.annotationControls.style.display, 'flex');
  assert.equal(save.disabled, false);
  cancel.dispatch('click');
  assert.equal(result.cell.value, 'Saved text');
  assert.equal(result.annotationControls.style.display, 'none');

  result.cell.value = 'Persist this text';
  result.notifyModelChange();
  save.dispatch('click');
  const request = result.posted.find((entry) => entry.payload?.action === 'saveAnnotation');
  assert.ok(request);
  assert.equal(request.payload.annotationText, 'Persist this text');
  assert.ok(request.payload.requestId);
});

test('annotation controls are compact and have no surrounding panel', () => {
  assert.match(pluginSource, /annotationControls\.style\.cssText = 'display:none;position:absolute;z-index:1000;gap:3px;'/);
  assert.match(pluginSource, /height:18px;padding:0 5px/);
  assert.doesNotMatch(pluginSource, /annotationControls\.style\.cssText = '[^']*(?:background|border|box-shadow|padding)/);
});

test('developer-defined calls expose their source function flow', () => {
  const sourceStableId = 'screens/REPL.tsx:1259:34:1263:3';
  const ownerFunctionStableId = 'screens/REPL.tsx:3142:31:3533:3';
  const result = loadMenu({
    stableId: 'screens/REPL.tsx:3151:4:3151:17',
    sourceStableId,
    functionStableId: ownerFunctionStableId,
    graphLabels: 'Call,Start',
    graphLabel: 'repinScroll()',
  });
  const flow = result.items.find((item) => item.title === 'открыть в отдельной Диаграмме');

  assert.ok(flow);
  flow.action();
  const message = result.posted.find((entry) => entry.payload?.action === 'openFunctionFlow');
  assert.ok(message);
  assert.equal(message.payload.functionStableId, sourceStableId);
});

test('parameter nodes expose the functional segment action', () => {
  const result = loadMenu({
    stableId: 'screens/REPL.tsx:3142:53:3142:80:parameter',
    graphKind: 'ValueAccess',
    graphLabels: 'ValueAccess,ValueReceive,Parameter,Variable,OperationProvider,CapabilityBundle',
    graphLabel: 'helpers',
  });
  const action = result.items.find((item) => item.title === 'показать функциональный сегмент');
  assert.ok(action);
  action.action();
  const message = result.posted.find((entry) => entry.payload?.action === 'showFunctionalSegment');
  assert.equal(message?.payload?.stableId, 'screens/REPL.tsx:3142:53:3142:80:parameter');
});

test('non-code system methods do not gain a function flow command', () => {
  const result = loadMenu({
    stableId: 'visual:fn:fixture->system-push',
    sourceStableId: 'system-push',
    graphLabels: 'Method,System',
    graphLabel: 'push(',
  });

  assert.equal(result.items.some((item) => item.title === 'открыть в отдельной Диаграмме'), false);
});

test('explicit function declarations keep flow and sequence commands', () => {
  const functionStableId = 'screens/REPL.tsx:3142:31:3533:3';
  const result = loadMenu({
    stableId: functionStableId,
    functionStableId,
    graphLabels: 'Fn,Declaration',
    graphLabel: 'onSubmit',
  });

  assert.equal(result.items.some((item) => item.title === 'открыть в отдельной Диаграмме'), true);
  assert.equal(result.items.some((item) => item.title === 'Show Sequence'), true);
});

test('all graph items expose the function trace toggle but not loop statistics', () => {
  const result = loadMenu({
    stableId: 'screens/REPL.tsx:3154:8:3154:28',
    graphLabels: 'Branch',
    graphLabel: 'feature?',
  });

  assert.equal(result.items.some((item) => item.title === 'показать Trace функции'), true);
  assert.equal(result.items.some((item) => item.title === 'показать статистику Цикла'), false);
  assert.equal(result.items.some((item) => item.title === 'показать Значения'), true);
});

test('runtime values command loads values for the current diagram function', () => {
  const ownerStableId = 'screens/REPL.tsx:3142:31:3533:3';
  const result = loadMenu({
    stableId: 'screens/REPL.tsx:3165:12:3165:24',
    graphLabels: 'Value,Set',
    graphLabel: 'trimmedInput',
  }, { rootFunctionStableId: ownerStableId });

  result.items.find((item) => item.title === 'показать Значения').action();
  assert.equal(result.fetched.length, 1);
  assert.equal(new URL(result.fetched[0]).pathname, '/runtime-values');
  assert.equal(new URL(result.fetched[0]).searchParams.get('stableId'), ownerStableId);
});

test('runtime value fields occupy a left expansion of their Step', () => {
  assert.match(pluginSource, /translateRuntimeValueChildren\(step, panelWidth, 0\)/);
  assert.match(pluginSource, /expanded\.x -= panelWidth/);
  assert.match(pluginSource, /expanded\.width \+= panelWidth/);
  assert.match(pluginSource, /var fieldX = 16/);
  assert.match(pluginSource, /var fieldTop = 16/);
  assert.match(pluginSource, /align=right;verticalAlign=middle/);
});

test('iteration roots expose cycle statistics', () => {
  const result = loadMenu({
    stableId: 'screens/REPL.tsx:3195:31:3195:104:horizontal-owner-screens/REPL.tsx-3142-31-3533-3',
    graphLabels: 'Op,Method,Iterator,System,Primitive,Iterate',
    graphLabel: 'filter',
  });

  assert.equal(result.items.some((item) => item.title === 'показать Trace функции'), true);
  assert.equal(result.items.some((item) => item.title === 'показать статистику Цикла'), true);
  result.items.find((item) => item.title === 'показать статистику Цикла').action();
  const request = result.posted.find((message) => message.payload?.action === 'openRuntimeAnalysis');
  assert.equal(request?.payload?.stableId, 'screens/REPL.tsx:3195:31:3195:104');
});

test('runtime case highlights match canonical IDs to role-suffixed diagram edges', () => {
  const result = loadMenu({ stableId: 'fixture.ts:1:1:1:2', graphLabels: 'Value' });
  const source = { id: 'source' };
  const target = { id: 'target' };
  const edge = {
    id: 'edge',
    edge: true,
    source,
    target,
    style: 'strokeColor=#007FFF;strokeWidth=1;',
    getAttribute(name) {
      return {
        stableId: 'screens/REPL.tsx:3173:77:3173:101:horizontal-owner-owner',
        targetStableId: 'screens/REPL.tsx:3173:12:3173:27:horizontal-owner-owner',
        edgeType: 'TRUE',
      }[name] || '';
    },
  };
  result.model.cells.edge = edge;
  result.dispatchWindowMessage({
    action: 'runtimeHighlight',
    selection: {
      edgePairs: [{
        sourceStableId: 'screens/REPL.tsx:3173:77:3173:101',
        targetStableId: 'screens/REPL.tsx:3173:12:3173:27',
        edgeType: 'TRUE',
      }],
    },
  });

  assert.match(edge.style, /strokeWidth=3;/);
});

test('runtime REPEATS highlights the FALSE predicate edge carrying the iteration-repeat role', () => {
  const result = loadMenu({ stableId: 'fixture.ts:1:1:1:2', graphLabels: 'Value' });
  const edge = {
    id: 'repeat-edge',
    edge: true,
    source: { id: 'predicate' },
    target: { id: 'iterator' },
    value: 'repeat',
    style: 'strokeColor=#CC0000;strokeWidth=1;',
    getAttribute(name) {
      return {
        stableId: 'screens/REPL.tsx:3173:143:3173:178:horizontal-owner-owner',
        targetStableId: 'screens/REPL.tsx:3173:30:3173:180:horizontal-owner-owner:receiver',
        edgeType: 'FALSE',
        protocolRole: 'iteration-repeat',
      }[name] || '';
    },
  };
  result.model.cells[edge.id] = edge;
  result.dispatchWindowMessage({
    action: 'runtimeHighlight',
    selection: {
      edgePairs: [{
        sourceStableId: 'screens/REPL.tsx:3173:143:3173:178',
        targetStableId: 'screens/REPL.tsx:3173:30:3173:180',
        edgeType: 'REPEATS',
      }],
    },
  });

  assert.match(edge.style, /strokeWidth=3;/);
});

test('runtime paths match repeat edges mounted to a call closing-boundary proxy', () => {
  const result = loadMenu({ stableId: 'fixture.ts:1:1:1:2', graphLabels: 'Value' });
  const edge = {
    id: 'proxy-repeat-edge',
    edge: true,
    source: {
      id: 'call-close',
      getAttribute(name) {
        return {
          stableId: 'flow:field-join:screens/REPL.tsx:3454:30:3457:13',
          sourceCallStableId: 'screens/REPL.tsx:3454:12:3457:14',
        }[name] || '';
      },
    },
    target: {
      id: 'collection-shift',
      getAttribute(name) {
        return {
          stableId: 'screens/REPL.tsx:3443:29:3443:41:collection',
        }[name] || '';
      },
    },
    value: 'repeat',
    style: 'strokeColor=#CC0000;strokeWidth=1;',
    getAttribute(name) {
      return {
        stableId: 'flow:field-join:screens/REPL.tsx:3454:30:3457:13',
        targetStableId: 'screens/REPL.tsx:3443:29:3443:41:collection',
        edgeType: 'REPEATS',
        protocolRole: 'iteration-repeat',
      }[name] || '';
    },
  };
  result.model.cells[edge.id] = edge;
  result.dispatchWindowMessage({
    action: 'runtimeHighlight',
    selection: {
      edgePairs: [{
        sourceStableId: 'screens/REPL.tsx:3454:12:3457:14',
        targetStableId: 'screens/REPL.tsx:3443:29:3443:41',
        edgeType: 'REPEATS',
      }],
    },
  });

  assert.match(edge.style, /strokeWidth=3;/);
});

test('function trace uses the current diagram root rather than the selected nested call', () => {
  const ownerStableId = 'screens/REPL.tsx:3142:31:3533:3';
  const result = loadMenu({
    stableId: 'visual:fn:logEvent',
    functionStableId: 'services/analytics/index.ts:133:7:144:1',
    graphLabels: 'Fn,Call,VisualProxy',
    graphLabel: 'logEvent',
  }, { rootFunctionStableId: ownerStableId });

  result.items.find((item) => item.title === 'показать Trace функции').action();
  assert.equal(result.fetched.length, 1);
  assert.equal(new URL(result.fetched[0]).searchParams.get('stableId'), ownerStableId);
});

test('function trace matches legacy role-suffixed diagram cells by coordinate stableId', () => {
  assert.match(pluginSource, /function runtimeStableIdKey\(stableId\)/);
  assert.match(pluginSource, /nodesByStableId\[runtimeStableIdKey\(event\.stableId\)\]/);
});

test('function trace derives the owner from a FunctionStart stableId', () => {
  const ownerStableId = 'screens/REPL.tsx:3142:31:3533:3';
  const result = loadMenu({
    stableId: 'screens/REPL.tsx:3154:8:3154:28',
    graphLabels: 'Branch',
    graphLabel: 'feature?',
  }, { rootStartStableId: `${ownerStableId}:flow-start` });

  result.items.find((item) => item.title.includes('Trace')).action();
  assert.equal(new URL(result.fetched[0]).searchParams.get('stableId'), ownerStableId);
});
