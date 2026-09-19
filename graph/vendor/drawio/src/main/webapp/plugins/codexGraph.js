Draw.loadPlugin(function(ui) {
  var postRequestSequence = 0;
  var pendingPostCallbacks = {};

  function hidePageTabsPermanently() {
    // coldKode opens every diagram as an independent file. Page tabs therefore
    // consume editor space without representing anything the workflow can use.
    ui.tabContainerVisible = false;
    ui.isTabContainerVisible = function() { return false; };
    if (typeof ui.updateTabContainer === 'function') ui.updateTabContainer();
    if (ui.tabContainer != null) ui.tabContainer.style.display = 'none';
    if (typeof ui.refresh === 'function') ui.refresh();
  }

  hidePageTabsPermanently();

  function hidePresenterFormatPanel() {
    if (typeof urlParams !== 'undefined' && urlParams.codexPresenter === '1') {
      ui.toggleFormatPanel(false);
    }
  }
  hidePresenterFormatPanel();
  ui.addListener('fileLoaded', hidePresenterFormatPanel);

  function completePostRequest(requestId, result) {
    var callback = pendingPostCallbacks[requestId];
    if (typeof callback !== 'function') return;
    delete pendingPostCallbacks[requestId];
    callback(result || {});
  }

  function post(payload, callback) {
    try {
      var requestPayload = payload;
      var requestId = '';
      if (typeof callback === 'function') {
        postRequestSequence += 1;
        requestId = 'codex-graph-' + Date.now().toString(36) + '-' + postRequestSequence;
        requestPayload = Object.assign({}, payload, { requestId: requestId });
        pendingPostCallbacks[requestId] = callback;
      }
      // Graph Explorer hosts this draw.io build from its local HTTP server and
      // owns the parent message channel. Hediet's regular editor does not, so
      // commands from that webview must go through VS Code's URI handler.
      if (window.location.protocol === 'http:' && window.location.hostname === '127.0.0.1') {
        window.parent.postMessage(JSON.stringify({
          event: 'codexGraphContext',
          payload: requestPayload
        }), '*');
        return;
      }

      fetch('http://127.0.0.1:17843/graph-context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestPayload)
      }).then(function(response) {
        if (!response.ok) {
          return response.text().then(function(message) {
            throw new Error(message || ('HTTP ' + response.status));
          });
        }
        return response.text().then(function(message) {
          if (!requestId) return;
          var result = {};
          if (message) {
            try { result = JSON.parse(message); } catch (error) { result = { ok: true }; }
          }
          completePostRequest(requestId, result);
        });
      }).catch(function(error) {
        if (requestId) completePostRequest(requestId, { ok: false, error: error.message || String(error) });
        ui.handleError(error);
      });
    } catch (error) {
      // draw.io plugins must not break the editor.
    }
  }

  function postLoaded() {
    try {
      window.parent.postMessage(JSON.stringify({
        event: 'codexGraphPluginLoaded',
        payload: { ok: true }
      }), '*');
    } catch (error) {
      // ignored
    }
  }

  function getAttribute(cell, name) {
    if (cell == null) return '';
    if (typeof cell.getAttribute === 'function') {
      var direct = cell.getAttribute(name);
      if (direct != null && direct !== '') return String(direct);
    }
    if (cell.value != null && typeof cell.value.getAttribute === 'function') {
      var valueAttr = cell.value.getAttribute(name);
      if (valueAttr != null && valueAttr !== '') return String(valueAttr);
    }
    if (cell[name] != null && cell[name] !== '') return String(cell[name]);
    return '';
  }

  function getCellLink(graph, cell) {
    var direct = getAttribute(cell, 'link');
    if (direct) return direct;
    if (graph != null && typeof graph.getLinkForCell === 'function') {
      try {
        var graphLink = graph.getLinkForCell(cell);
        if (graphLink != null && graphLink !== '') return String(graphLink);
      } catch (error) {
        // Fall through to other metadata locations.
      }
    }
    return '';
  }

  function decodeGraphLink(link) {
    if (!link || String(link).indexOf('codex-graph://item?') !== 0) return {};
    var query = String(link).split('?')[1] || '';
    var params = {};
    query.replace(/&amp;/g, '&').split('&').forEach(function(part) {
      var pair = part.split('=');
      if (!pair[0]) return;
      params[decodeURIComponent(pair[0])] = decodeURIComponent((pair[1] || '').replace(/\+/g, ' '));
    });
    return params;
  }

  function getCellPayload(cell) {
    var linkPayload = decodeGraphLink(getCellLink(graph, cell));
    var geometry = cell != null ? cell.geometry : null;
    var kind = getAttribute(cell, 'graphKind') || linkPayload.kind || '';
    var labelsRaw = getAttribute(cell, 'graphLabels') || linkPayload.labels || '';
    var labels = String(labelsRaw || '').split(',').map(function(label) {
      return label.trim();
    }).filter(Boolean);
    var stableId = getAttribute(cell, 'stableId') || linkPayload.stableId || '';
    var locationStableId = getAttribute(cell, 'locationStableId') || linkPayload.locationStableId || '';
    var sourceStableId = getAttribute(cell, 'sourceStableId') || linkPayload.sourceStableId || '';
    var sourceLookup = getAttribute(cell, 'sourceLookup') || linkPayload.sourceLookup || '';
    var sourceSymbol = getAttribute(cell, 'sourceSymbol') || linkPayload.sourceSymbol || '';
    var headStableIds = getAttribute(cell, 'headStableIds') || linkPayload.headStableIds || '';
    var tailStableIds = getAttribute(cell, 'tailStableIds') || linkPayload.tailStableIds || '';
    var functionStableId = getAttribute(cell, 'functionStableId') || linkPayload.functionStableId || '';
    var targetStableId = getAttribute(cell, 'targetStableId') || linkPayload.targetStableId || '';
    var canonicalTargetStableId = getAttribute(cell, 'canonicalTargetStableId') || linkPayload.canonicalTargetStableId || '';
    var visualProxyStableId = getAttribute(cell, 'visualProxyStableId') || linkPayload.visualProxyStableId || '';
    var sourceCallStableId = getAttribute(cell, 'sourceCallStableId') || linkPayload.sourceCallStableId || '';
    var visualCopyIndex = getAttribute(cell, 'visualCopyIndex') || linkPayload.visualCopyIndex || '';
    var visualCopyCount = getAttribute(cell, 'visualCopyCount') || linkPayload.visualCopyCount || '';
    var edgeType = getAttribute(cell, 'edgeType') || linkPayload.edgeType || '';
    var argumentName = getAttribute(cell, 'argumentName') || linkPayload.argumentName || '';
    var fieldName = getAttribute(cell, 'fieldName') || linkPayload.fieldName || '';
    var label = getAttribute(cell, 'graphLabel') || linkPayload.label || '';
    var layoutTrace = getAttribute(cell, 'layoutTrace') || '';

    if (!label) {
      var value = cell != null ? cell.value : '';
      if (typeof value === 'string') {
        label = value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      } else if (value != null && typeof value.getAttribute === 'function') {
        label = value.getAttribute('label') || value.getAttribute('value') || '';
      }
    }

    if (!kind && !stableId && !targetStableId) return null;

    return {
      cellId: cell != null && cell.id != null ? String(cell.id) : '',
      kind: kind || 'GraphItem',
      labels: labels,
      stableId: stableId,
      locationStableId: locationStableId,
      sourceStableId: sourceStableId,
      sourceLookup: sourceLookup,
      sourceSymbol: sourceSymbol,
      headStableIds: String(headStableIds || '').split(',').map(function(value) { return value.trim(); }).filter(Boolean),
      tailStableIds: String(tailStableIds || '').split(',').map(function(value) { return value.trim(); }).filter(Boolean),
      functionStableId: functionStableId,
      targetStableId: targetStableId,
      canonicalTargetStableId: canonicalTargetStableId,
      visualProxyStableId: visualProxyStableId,
      sourceCallStableId: sourceCallStableId,
      visualCopyIndex: visualCopyIndex,
      visualCopyCount: visualCopyCount,
      edgeType: edgeType,
      argumentName: argumentName,
      fieldName: fieldName,
      layoutTrace: layoutTrace,
      x: geometry != null && geometry.x != null ? Number(geometry.x) : null,
      y: geometry != null && geometry.y != null ? Number(geometry.y) : null,
      width: geometry != null && geometry.width != null ? Number(geometry.width) : null,
      height: geometry != null && geometry.height != null ? Number(geometry.height) : null,
      label: label || stableId || targetStableId || 'graph item'
    };
  }

  function sendAction(cell, action) {
    var payload = getCellPayload(cell);
    if (!payload) return;
    payload.action = action;
    post(payload);
  }

  function sendRuntimeAnalysisAction(cell) {
    var payload = getCellPayload(cell);
    if (!payload) return;
    ensureRuntimeHighlightBridge();
    payload.action = 'openRuntimeAnalysis';
    payload.stableId = runtimeStableIdKey(payload.sourceCallStableId || payload.stableId);
    payload.sourceCallStableId = payload.stableId;
    post(payload);
  }

  function isCodeDefinitionStableId(stableId) {
    return /(?:^|[\\/])[A-Za-z0-9_.\-/\\]+\.(?:tsx?|jsx?|mjs|cjs):\d+:\d+:\d+:\d+(?::|$)/i.test(String(stableId || ''));
  }

  function functionFlowStableId(payload) {
    if (!payload) return '';
    var callable = (payload.labels || []).some(function(label) {
      return label === 'Call'
        || label === 'Request'
        || label === 'Fn'
        || label === 'Function'
        || label === 'Method';
    });
    if (callable && isCodeDefinitionStableId(payload.sourceStableId)) {
      return payload.sourceStableId;
    }
    return payload.functionStableId || '';
  }

  function sendFunctionAction(cell, action, functionStableId) {
    var payload = getCellPayload(cell);
    if (!payload || !functionStableId) return;
    payload.functionStableId = functionStableId;
    payload.action = action;
    post(payload);
  }

  function sendSourceAction(cell) {
    var payload = getCellPayload(cell);
    if (!payload) return;
    if (payload.sourceStableId) {
      payload.action = 'openStableId';
      payload.stableId = payload.sourceStableId;
      payload.locationStableId = payload.sourceStableId;
    } else if (payload.locationStableId && payload.sourceLookup === 'definition') {
      payload.action = 'openDefinitionAtStableId';
      payload.stableId = payload.locationStableId;
    } else {
      return;
    }
    post(payload);
  }

  var graph = ui.editor != null ? ui.editor.graph : null;
  if (graph == null || graph.popupMenuHandler == null) {
    postLoaded();
    return;
  }
  var model = graph.getModel();
  var shapesHiddenForRoot = null;
  function hideShapesForGraphDocument() {
    var root = typeof model.getRoot === 'function' ? model.getRoot() : model.cells;
    if (root === shapesHiddenForRoot) return;
    var cells = model.cells || {};
    var isGraphDocument = Object.keys(cells).some(function(id) {
      return Boolean(getAttribute(cells[id], 'graphKind') || getAttribute(cells[id], 'functionStableId'));
    });
    if (!isGraphDocument) return;
    shapesHiddenForRoot = root;
    if (ui.sidebarWindow && ui.sidebarWindow.window) {
      ui.sidebarWindow.window.setVisible(false);
    } else if (typeof ui.toggleShapesPanel === 'function') {
      ui.toggleShapesPanel(false);
    }
  }
  model.addListener(mxEvent.CHANGE, hideShapesForGraphDocument);
  hideShapesForGraphDocument();
  var runtimeOriginalStyles = {};
  var runtimeOutlines = [];
  var runtimeTraceActive = false;
  var runtimeHighlightBridgeRevision = 0;
  var runtimeHighlightBridgeTimer = null;
  var runtimeHighlightBridgePolling = false;
  var runtimeValueCells = [];
  var runtimeValueOriginalGeometries = {};
  var runtimeValuesActive = false;

  function clearRuntimeHighlight() {
    model.beginUpdate();
    try {
      runtimeOutlines.forEach(function(cell) {
        if (cell != null && model.contains(cell)) model.remove(cell);
      });
      runtimeOutlines = [];
      Object.keys(runtimeOriginalStyles).forEach(function(id) {
        var cell = model.getCell(id);
        if (cell != null) model.setStyle(cell, runtimeOriginalStyles[id]);
      });
      runtimeOriginalStyles = {};
    } finally {
      model.endUpdate();
    }
    graph.refresh();
    runtimeTraceActive = false;
  }

  function diagramFunctionStableId(selectedCell) {
    var fallback = '';
    var root = '';
    var frequency = {};
    Object.keys(model.cells || {}).forEach(function(id) {
      var cell = model.cells[id];
      if (!model.isVertex(cell)) return;
      var labels = getAttribute(cell, 'graphLabels').split(',').filter(Boolean);
      var functionStableId = getAttribute(cell, 'functionStableId');
      if (functionStableId) frequency[functionStableId] = (frequency[functionStableId] || 0) + 1;
      var isFunctionStart = labels.indexOf('FunctionStart') >= 0
        || (labels.indexOf('Start') >= 0 && labels.indexOf('ExecutionBoundary') >= 0)
        || getAttribute(cell, 'graphKind') === 'Start'
        || (getAttribute(cell, 'graphLabel') === 'Start' && labels.indexOf('Fn') >= 0);
      if (isFunctionStart && !root) {
        root = functionStableId || runtimeStableIdKey(getAttribute(cell, 'stableId'));
        return;
      }
      if (labels.length === 1 && labels[0] === 'Fn' && functionStableId && !fallback) {
        fallback = functionStableId;
      }
    });
    var selectedOwner = selectedCell != null ? getAttribute(selectedCell, 'functionStableId') : '';
    var frequentOwner = Object.keys(frequency).sort(function(left, right) {
      return frequency[right] - frequency[left];
    })[0] || '';
    return selectedOwner || root || frequentOwner || fallback;
  }

  function isRuntimeLoopPayload(payload) {
    var labels = (payload && payload.labels) || [];
    return labels.indexOf('Loop') >= 0
      || labels.indexOf('For') >= 0
      || (labels.indexOf('Iterator') >= 0 && labels.indexOf('Iterate') >= 0);
  }

  function annotationLinkForCell(cell) {
    if (cell == null || getAttribute(cell, 'graphKind') !== 'Annotation') return null;
    var cells = model.cells || {};
    var ids = Object.keys(cells);
    for (var index = 0; index < ids.length; index += 1) {
      var candidate = cells[ids[index]];
      if (!model.isEdge(candidate) || getAttribute(candidate, 'annotationLink') !== '1') continue;
      var source = typeof model.getTerminal === 'function'
        ? model.getTerminal(candidate, true)
        : candidate.source;
      if (source === cell || (source != null && source.id === cell.id)) return candidate;
    }
    return null;
  }

  function annotationLinkIsVisible(link) {
    return link != null && (typeof model.isVisible !== 'function' || model.isVisible(link));
  }

  function toggleAnnotationLink(cell) {
    var link = annotationLinkForCell(cell);
    if (link == null || typeof model.setVisible !== 'function') return;
    model.beginUpdate();
    try {
      model.setVisible(link, !annotationLinkIsVisible(link));
    } finally {
      model.endUpdate();
    }
    graph.refresh();
  }

  var annotationControls = document.createElement('div');
  var annotationSaveButton = document.createElement('button');
  var annotationCancelButton = document.createElement('button');
  var annotationSavedTexts = {};
  var annotationSavePending = false;
  annotationControls.style.cssText = 'display:none;position:absolute;z-index:1000;gap:3px;';
  annotationSaveButton.type = 'button';
  annotationSaveButton.textContent = 'Сохранить';
  annotationCancelButton.type = 'button';
  annotationCancelButton.textContent = 'Отменить';
  [annotationSaveButton, annotationCancelButton].forEach(function(button) {
    button.style.cssText = 'height:18px;padding:0 5px;border:1px solid #999;border-radius:2px;background:#fff;color:#333;font:10px Arial,sans-serif;line-height:16px;cursor:pointer;';
    annotationControls.appendChild(button);
  });
  graph.container.appendChild(annotationControls);

  model.beginUpdate();
  try {
    Object.keys(model.cells || {}).forEach(function(id) {
      var annotationCell = model.cells[id];
      if (!model.isVertex(annotationCell) || getAttribute(annotationCell, 'graphKind') !== 'Annotation') return;
      var style = String(annotationCell.style || '');
      style = mxUtils.setStyle(style, mxConstants.STYLE_ALIGN, mxConstants.ALIGN_CENTER);
      style = mxUtils.setStyle(style, mxConstants.STYLE_SPACING_LEFT, 0);
      style = mxUtils.setStyle(style, mxConstants.STYLE_SPACING_RIGHT, 0);
      model.setStyle(annotationCell, style);
    });
  } finally {
    model.endUpdate();
  }

  function annotationPlainText(value) {
    var text = value == null ? '' : String(value);
    if (!/<(?:div|p|br|span|b|i|font)\b/i.test(text)) return text.replace(/\r\n?/g, '\n');
    var holder = document.createElement('div');
    holder.innerHTML = text
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:div|p)>/gi, '\n');
    return String(holder.textContent || holder.innerText || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n?/g, '\n')
      .replace(/\n+$/g, '');
  }

  function selectedAnnotationCell() {
    var cell = graph.getSelectionCell();
    return cell != null && getAttribute(cell, 'graphKind') === 'Annotation' ? cell : null;
  }

  function currentAnnotationText(cell) {
    var editor = graph.cellEditor;
    if (editor != null && editor.editingCell === cell && editor.textarea != null) {
      var liveValue = editor.textarea.value != null ? editor.textarea.value : editor.textarea.innerHTML;
      return annotationPlainText(liveValue);
    }
    return annotationPlainText(cell != null ? cell.value : '');
  }

  function savedAnnotationText(cell) {
    if (cell == null) return '';
    if (!Object.prototype.hasOwnProperty.call(annotationSavedTexts, cell.id)) {
      annotationSavedTexts[cell.id] = annotationPlainText(getAttribute(cell, 'annotationSavedText') || cell.value || '');
    }
    return annotationSavedTexts[cell.id];
  }

  function positionAnnotationControls(cell) {
    var state = cell != null ? graph.view.getState(cell) : null;
    if (state == null) return;
    var controlsWidth = annotationControls.offsetWidth || 112;
    var controlsHeight = annotationControls.offsetHeight || 18;
    annotationControls.style.left = Math.max(state.x + 4, state.x + state.width - controlsWidth - 4) + 'px';
    annotationControls.style.top = Math.max(state.y + 4, state.y + state.height - controlsHeight - 4) + 'px';
  }

  function refreshAnnotationControls() {
    var cell = selectedAnnotationCell();
    if (cell == null) {
      annotationControls.style.display = 'none';
      return;
    }
    var text = currentAnnotationText(cell);
    var dirty = text !== savedAnnotationText(cell);
    if (!dirty) {
      annotationControls.style.display = 'none';
      return;
    }
    annotationControls.style.display = 'flex';
    annotationSaveButton.disabled = annotationSavePending || !text.trim();
    annotationCancelButton.disabled = annotationSavePending;
    [annotationSaveButton, annotationCancelButton].forEach(function(button) {
      button.style.opacity = button.disabled ? '.45' : '1';
      button.style.cursor = button.disabled ? 'default' : 'pointer';
    });
    positionAnnotationControls(cell);
  }

  function annotationTargetPayload(cell) {
    var targetId = getAttribute(cell, 'annotationTargetId');
    var target = targetId && typeof model.getCell === 'function' ? model.getCell(targetId) : null;
    return { targetId: targetId, payload: getCellPayload(target) || {} };
  }

  function saveSelectedAnnotation() {
    var cell = selectedAnnotationCell();
    if (cell == null || annotationSavePending) return;
    if (graph.cellEditor != null && graph.cellEditor.editingCell === cell) graph.stopEditing(false);
    var text = currentAnnotationText(cell).trim();
    if (!text || text === savedAnnotationText(cell)) {
      refreshAnnotationControls();
      return;
    }
    var target = annotationTargetPayload(cell);
    annotationSavePending = true;
    refreshAnnotationControls();
    post({
      action: 'saveAnnotation',
      annotationCellId: String(cell.id || ''),
      annotationTargetId: target.targetId,
      annotationText: text,
      annotationMaxDepth: getAttribute(cell, 'annotationMaxDepth'),
      stableId: target.payload.stableId || '',
      targetStableId: target.payload.targetStableId || '',
      kind: target.payload.kind || ''
    }, function(result) {
      annotationSavePending = false;
      if (!result || result.ok === false) {
        refreshAnnotationControls();
        ui.handleError(new Error((result && result.error) || 'Annotation save failed.'));
        return;
      }
      var savedText = annotationPlainText(result.text || text);
      annotationSavedTexts[cell.id] = savedText;
      cell.annotationSavedText = savedText;
      if (currentAnnotationText(cell) !== savedText) model.setValue(cell, savedText);
      refreshAnnotationControls();
      var saveAction = ui.actions != null && typeof ui.actions.get === 'function'
        ? ui.actions.get('save')
        : null;
      if (saveAction != null && typeof saveAction.funct === 'function') saveAction.funct();
    });
  }

  function cancelSelectedAnnotationEdit() {
    var cell = selectedAnnotationCell();
    if (cell == null || annotationSavePending) return;
    if (graph.cellEditor != null && graph.cellEditor.editingCell === cell) graph.stopEditing(true);
    model.beginUpdate();
    try {
      model.setValue(cell, savedAnnotationText(cell));
    } finally {
      model.endUpdate();
    }
    graph.refresh(cell);
    refreshAnnotationControls();
  }

  annotationSaveButton.addEventListener('click', saveSelectedAnnotation);
  annotationCancelButton.addEventListener('click', cancelSelectedAnnotationEdit);
  graph.getSelectionModel().addListener(mxEvent.CHANGE, refreshAnnotationControls);
  model.addListener(mxEvent.CHANGE, refreshAnnotationControls);
  graph.view.addListener(mxEvent.SCALE, refreshAnnotationControls);
  graph.view.addListener(mxEvent.TRANSLATE, refreshAnnotationControls);
  graph.container.addEventListener('input', function() {
    window.setTimeout(refreshAnnotationControls, 0);
  }, true);

  var baseIsCellEditable = graph.isCellEditable;
  graph.isCellEditable = function(cell) {
    if (getAttribute(cell, 'graphKind') === 'Annotation') return true;
    return baseIsCellEditable.apply(this, arguments);
  };

  function runtimeStableIdKey(stableId) {
    var normalized = String(stableId || '').replace(/\\/g, '/');
    var match = /(?:^|:)((?:[A-Za-z]:\/)?[^:]+?\.(?:tsx?|jsx?|mjs|cjs)):(\d+):(\d+):(\d+):(\d+)(?::|$)/i.exec(normalized);
    return match
      ? match[1] + ':' + match[2] + ':' + match[3] + ':' + match[4] + ':' + match[5]
      : normalized;
  }

  function runtimeTraceEdgePairs(sequence, dataOnly) {
    var nodesByStableId = {};
    var outgoingBySource = {};
    var relatedStableIds = {};
    var objectFamilyMembers = {};
    function relateStableIds(left, right) {
      left = runtimeStableIdKey(left);
      right = runtimeStableIdKey(right);
      if (!left || !right || left === right) return;
      (relatedStableIds[left] || (relatedStableIds[left] = {}))[right] = true;
      (relatedStableIds[right] || (relatedStableIds[right] = {}))[left] = true;
    }
    Object.keys(model.cells || {}).forEach(function(id) {
      var cell = model.cells[id];
      if (model.isVertex(cell)) {
        var stableId = getAttribute(cell, 'stableId');
        if (stableId) {
          var stableIdKey = runtimeStableIdKey(stableId);
          (nodesByStableId[stableIdKey] || (nodesByStableId[stableIdKey] = [])).push(cell);
          [
            'objectBraceMosaicNeighborStableId',
            'compositionOwnerStableId',
            'overlayOwnerStableId',
            'attachmentOwnerStableId',
            'mosaicOwnerStableIds'
          ].forEach(function(key) {
            getAttribute(cell, key).split(',').filter(Boolean).forEach(function(related) {
              relateStableIds(stableId, related);
            });
          });
          var family = getAttribute(cell, 'objectFamilyStableId');
          if (family) (objectFamilyMembers[family] || (objectFamilyMembers[family] = {}))[stableIdKey] = true;
        }
      }
      if (!model.isEdge(cell)) return;
      var source = model.getTerminal(cell, true);
      var target = model.getTerminal(cell, false);
      if (source == null || target == null) return;
      (outgoingBySource[source.id] || (outgoingBySource[source.id] = [])).push(cell);
    });
    Object.keys(objectFamilyMembers).forEach(function(family) {
      var members = Object.keys(objectFamilyMembers[family]);
      for (var index = 1; index < members.length; index += 1) relateStableIds(members[0], members[index]);
    });

    function edgePair(edge) {
      return {
        sourceStableId: getAttribute(edge, 'stableId'),
        targetStableId: getAttribute(edge, 'targetStableId'),
        edgeType: getAttribute(edge, 'edgeType'),
        producerOutcome: getAttribute(edge, 'producerOutcome'),
        weight: 1
      };
    }

    function targetId(edge) {
      var target = model.getTerminal(edge, false);
      return target != null ? target.id : '';
    }

    function activateCell(cell, activeNodeIds) {
      var queue = [cell];
      while (queue.length) {
        var current = queue.shift();
        if (current == null || activeNodeIds[current.id]) continue;
        activeNodeIds[current.id] = true;
        var stableId = runtimeStableIdKey(getAttribute(current, 'stableId'));
        (nodesByStableId[stableId] || []).forEach(function(alias) { queue.push(alias); });
        Object.keys(relatedStableIds[stableId] || {}).forEach(function(related) {
          (nodesByStableId[related] || []).forEach(function(member) { queue.push(member); });
        });
      }
    }

    function expandObservedDataEdges(selected, activeNodeIds) {
      var fanoutTypes = { ARG: true, FIELD: true };
      var joinTypes = { ArgJoin: true, FieldJoin: true, XOR_JOIN: true };
      var valueTypes = {
        ASSIGNS_VALUE: true,
        YIELDS_VALUE: true,
        PASSES_VALUE: true,
        EMITS_VALUE: true,
        PRODUCES_VALUE: true,
        RESULT: true,
        EVAL: true
      };
      var changed = true;
      while (changed) {
        changed = false;
        Object.keys(model.cells || {}).forEach(function(id) {
          var edge = model.cells[id];
          if (!model.isEdge(edge) || selected[id]) return;
          if (getAttribute(edge, 'producerOutcome')) return;
          var edgeType = getAttribute(edge, 'edgeType');
          var source = model.getTerminal(edge, true);
          var target = model.getTerminal(edge, false);
          if (source == null || target == null) return;
          var sourceActive = activeNodeIds[source.id] === true;
          var targetActive = activeNodeIds[target.id] === true;
          var include = fanoutTypes[edgeType]
            ? sourceActive || targetActive
            : joinTypes[edgeType] || valueTypes[edgeType]
              ? sourceActive
              : false;
          if (!include) return;
          selected[id] = edge;
          activateCell(source, activeNodeIds);
          activateCell(target, activeNodeIds);
          changed = true;
        });
      }
    }

    function expandDeterministicControlEdges(selected, activeNodeIds) {
      var changed = true;
      while (changed) {
        changed = false;
        Object.keys(activeNodeIds).forEach(function(sourceId) {
          var outgoing = outgoingBySource[sourceId] || [];
          if (outgoing.some(function(edge) {
            var type = getAttribute(edge, 'edgeType');
            return type === 'TRUE' || type === 'FALSE';
          })) return;
          var continuations = outgoing.filter(function(edge) {
            return getAttribute(edge, 'edgeType') === 'NEXT';
          });
          if (continuations.length !== 1 || selected[continuations[0].id]) return;
          var edge = continuations[0];
          var source = model.getTerminal(edge, true);
          var target = model.getTerminal(edge, false);
          if (source == null || target == null) return;
          selected[edge.id] = edge;
          activateCell(source, activeNodeIds);
          activateCell(target, activeNodeIds);
          changed = true;
        });
      }
    }

    function shortestPath(sourceCells, targetCells, outcome) {
      var targets = {};
      targetCells.forEach(function(cell) { targets[cell.id] = true; });
      var expected = typeof outcome === 'boolean' ? (outcome ? 'TRUE' : 'FALSE') : '';
      var expectedProducerOutcome = typeof outcome === 'boolean' ? String(outcome) : '';
      var queue = [];
      var visited = {};
      sourceCells.forEach(function(source) {
        var outgoing = outgoingBySource[source.id] || [];
        if (expected) outgoing = outgoing.filter(function(edge) {
          return getAttribute(edge, 'edgeType') === expected
            || getAttribute(edge, 'producerOutcome') === expectedProducerOutcome;
        });
        outgoing.forEach(function(edge) {
          var target = targetId(edge);
          if (!target) return;
          if (targets[target]) queue.unshift({ done: true, edges: [edge] });
          else queue.push({ nodeId: target, edges: [edge] });
        });
      });
      while (queue.length) {
        var current = queue.shift();
        if (current.done) return current.edges;
        if (!current.nodeId || visited[current.nodeId]) continue;
        visited[current.nodeId] = true;
        (outgoingBySource[current.nodeId] || []).forEach(function(edge) {
          var target = targetId(edge);
          if (!target || visited[target]) return;
          var edges = current.edges.concat([edge]);
          if (targets[target]) queue.unshift({ done: true, edges: edges });
          else queue.push({ nodeId: target, edges: edges });
        });
      }
      return [];
    }

    var selected = {};
    function addEdges(edges) {
      edges.forEach(function(edge) { selected[edge.id] = edge; });
    }
    var visibleSequence = sequence.filter(function(event) {
      return (nodesByStableId[runtimeStableIdKey(event.stableId)] || []).length > 0;
    });
    var predicates = visibleSequence.filter(function(event) {
      return event.role === 'predicate' && typeof event.outcome === 'boolean';
    });
    predicates.forEach(function(event) {
      var sources = nodesByStableId[runtimeStableIdKey(event.stableId)] || [];
      var expected = event.outcome ? 'TRUE' : 'FALSE';
      var expectedProducerOutcome = String(event.outcome);
      var outcomeEdge = null;
      sources.some(function(source) {
        outcomeEdge = (outgoingBySource[source.id] || []).find(function(edge) {
          return getAttribute(edge, 'edgeType') === expected
            || getAttribute(edge, 'producerOutcome') === expectedProducerOutcome;
        }) || null;
        return outcomeEdge != null;
      });
      if (!outcomeEdge || (dataOnly && !getAttribute(outcomeEdge, 'producerOutcome'))) return;
      selected[outcomeEdge.id] = outcomeEdge;
    });
    for (var index = 0; !dataOnly && index + 1 < visibleSequence.length; index += 1) {
      var event = visibleSequence[index];
      var nextEvent = visibleSequence[index + 1];
      addEdges(shortestPath(
        nodesByStableId[runtimeStableIdKey(event.stableId)] || [],
        nodesByStableId[runtimeStableIdKey(nextEvent.stableId)] || [],
        event.outcome
      ));
    }
    var activeNodeIds = {};
    visibleSequence.forEach(function(event) {
      (nodesByStableId[runtimeStableIdKey(event.stableId)] || []).forEach(function(cell) {
        activateCell(cell, activeNodeIds);
      });
    });
    Object.keys(selected).forEach(function(id) {
      var source = model.getTerminal(selected[id], true);
      var target = model.getTerminal(selected[id], false);
      if (source != null) activateCell(source, activeNodeIds);
      if (target != null) activateCell(target, activeNodeIds);
    });
    expandObservedDataEdges(selected, activeNodeIds);
    if (!dataOnly) expandDeterministicControlEdges(selected, activeNodeIds);
    expandObservedDataEdges(selected, activeNodeIds);

    var nodeHighlights = {};
    sequence.filter(function(event) { return event.role === 'predicate'; }).forEach(function(event) {
      nodeHighlights[event.stableId] = {
        stableId: event.stableId,
        role: 'predicate-stage',
        outcome: event.outcome
      };
    });
    Object.keys(selected).forEach(function(id) {
      var edge = selected[id];
      [model.getTerminal(edge, true), model.getTerminal(edge, false)].forEach(function(cell) {
        if (cell == null) return;
        var stableId = getAttribute(cell, 'stableId');
        var labels = getAttribute(cell, 'graphLabels').split(',').filter(Boolean);
        var isBranch = labels.indexOf('Branch') >= 0;
        var isJoin = labels.indexOf('DataJoin') >= 0
          || (labels.indexOf('Join') >= 0
            && (labels.indexOf('Flow') >= 0 || labels.indexOf('Exclusive') >= 0)
            && labels.indexOf('FnVisualProxy') < 0);
        if ((!isBranch && !isJoin) || nodeHighlights[stableId]) return;
        var outcome;
        if (isBranch && model.getTerminal(edge, true) === cell) {
          var edgeType = getAttribute(edge, 'edgeType');
          if (edgeType === 'TRUE' || edgeType === 'FALSE') outcome = edgeType === 'TRUE';
          else if (getAttribute(edge, 'producerOutcome')) outcome = getAttribute(edge, 'producerOutcome') === 'true';
        }
        nodeHighlights[stableId] = {
          stableId: stableId,
          role: isBranch ? 'predicate-stage' : 'join-stage',
          outcome: outcome
        };
      });
    });
    return {
      edgePairs: Object.keys(selected).map(function(id) { return edgePair(selected[id]); }),
      nodeHighlights: Object.keys(nodeHighlights).map(function(stableId) { return nodeHighlights[stableId]; })
    };
  }

  function toggleRuntimeTrace(cell) {
    if (runtimeTraceActive) {
      clearRuntimeHighlight();
      return;
    }
    var stableId = diagramFunctionStableId(cell);
    if (!stableId) {
      ui.handleError(new Error('The current diagram has no function stableID (codexGraph root-v2).'));
      return;
    }
    var url = 'http://127.0.0.1:8787/runtime-trace?stableId=' + encodeURIComponent(stableId);
    fetch(url)
      .then(function(response) {
        if (!response.ok) throw new Error('Runtime trace request failed: HTTP ' + response.status);
        return response.json();
      })
      .then(function(result) {
        if (!result.ok) throw new Error(result.error || 'Runtime trace request failed');
        var trace = result.trace || {};
        var sequence = trace.chain || [];
        if (!sequence.length) throw new Error('No runtime trace is stored for ' + stableId);
        var runtimeSelection = runtimeTraceEdgePairs(sequence);
        runtimeHighlight({
          staticStableIds: sequence.map(function(event) { return event.stableId; }),
          nodeHighlights: runtimeSelection.nodeHighlights,
          edgePairs: runtimeSelection.edgePairs
        });
        runtimeTraceActive = true;
      })
      .catch(function(error) { ui.handleError(error); });
  }

  function clearRuntimeValues() {
    model.beginUpdate();
    try {
      runtimeValueCells.forEach(function(cell) {
        if (cell != null && model.contains(cell)) model.remove(cell);
      });
      runtimeValueCells = [];
      Object.keys(runtimeValueOriginalGeometries).forEach(function(id) {
        var cell = model.getCell(id);
        if (cell != null) model.setGeometry(cell, runtimeValueOriginalGeometries[id]);
      });
      runtimeValueOriginalGeometries = {};
    } finally {
      model.endUpdate();
    }
    graph.refresh();
    runtimeValuesActive = false;
  }

  function runtimeStepCell(stableId) {
    var result = null;
    Object.keys(model.cells || {}).some(function(id) {
      var cell = model.cells[id];
      if (!model.isVertex(cell) || getAttribute(cell, 'runtimeStepStableId') !== stableId) return false;
      result = cell;
      return true;
    });
    return result;
  }

  function rememberRuntimeValueGeometry(cell) {
    if (cell == null || runtimeValueOriginalGeometries[cell.id]) return;
    var geometry = model.getGeometry(cell);
    if (geometry != null) runtimeValueOriginalGeometries[cell.id] = geometry.clone();
  }

  function translateRuntimeValueChildren(parent, dx, dy) {
    var count = model.getChildCount(parent);
    for (var index = 0; index < count; index += 1) {
      var child = model.getChildAt(parent, index);
      if (runtimeValueCells.indexOf(child) >= 0) continue;
      var geometry = model.getGeometry(child);
      if (geometry == null) continue;
      rememberRuntimeValueGeometry(child);
      var translated = geometry.clone();
      translated.translate(dx, dy);
      model.setGeometry(child, translated);
    }
  }

  function expandRuntimeValueAncestors(cell) {
    var current = cell;
    var parent = model.getParent(current);
    while (parent != null && model.isVertex(parent)) {
      var currentGeometry = model.getGeometry(current);
      var parentGeometry = model.getGeometry(parent);
      if (currentGeometry == null || parentGeometry == null) break;
      var leftOverflow = Math.min(0, currentGeometry.x - 16);
      var leftExpansion = -leftOverflow;
      var requiredWidth = currentGeometry.x + leftExpansion + currentGeometry.width + 16;
      var requiredHeight = currentGeometry.y + currentGeometry.height + 16;
      if (leftExpansion > 0 || requiredWidth > parentGeometry.width || requiredHeight > parentGeometry.height) {
        rememberRuntimeValueGeometry(parent);
        var expanded = parentGeometry.clone();
        if (leftExpansion > 0) {
          expanded.x -= leftExpansion;
          expanded.width += leftExpansion;
          translateRuntimeValueChildren(parent, leftExpansion, 0);
        }
        expanded.width = Math.max(expanded.width, requiredWidth);
        expanded.height = Math.max(expanded.height, requiredHeight);
        model.setGeometry(parent, expanded);
      }
      current = parent;
      parent = model.getParent(current);
    }
  }

  function runtimeValueLabel(value) {
    var name = String(value.variableName || 'value');
    var preview = String(value.valuePreview == null ? 'undefined' : value.valuePreview);
    function escapeHtml(text) {
      return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    return '<b>' + escapeHtml(name) + '</b><br><span style="color:#555">'
      + escapeHtml(preview) + '</span>';
  }

  function showRuntimeValues(result) {
    clearRuntimeValues();
    var values = (result && result.values) || [];
    var byStep = {};
    values.forEach(function(value) {
      if (!value.ownerStepStableId) return;
      (byStep[value.ownerStepStableId] || (byStep[value.ownerStepStableId] = [])).push(value);
    });
    model.beginUpdate();
    try {
      Object.keys(byStep).forEach(function(stepStableId) {
        var step = runtimeStepCell(stepStableId);
        var stepGeometry = step && model.getGeometry(step);
        if (step == null || stepGeometry == null) return;
        rememberRuntimeValueGeometry(step);
        var entries = byStep[stepStableId];
        var fieldGap = 8;
        var fieldHeight = 44;
        var maxWidth = 180;
        entries.forEach(function(value) {
          var longestLine = Math.max(
            String(value.variableName || '').length,
            String(value.valuePreview || '').split(/\r?\n/).reduce(function(max, line) {
              return Math.max(max, line.length);
            }, 0)
          );
          maxWidth = Math.max(maxWidth, Math.min(420, longestLine * 7 + 24));
        });
        var panelWidth = maxWidth + 24;
        translateRuntimeValueChildren(step, panelWidth, 0);
        var fieldX = 16;
        var fieldTop = 16;
        entries.forEach(function(value, index) {
          var geometry = new mxGeometry(fieldX, fieldTop + index * (fieldHeight + fieldGap), maxWidth, fieldHeight);
          var cell = new mxCell(runtimeValueLabel(value), geometry,
            'rounded=0;html=1;whiteSpace=wrap;overflow=hidden;align=right;verticalAlign=middle;spacing=6;'
            + 'fillColor=#ffffff;strokeColor=#878787;strokeWidth=1.5;fontColor=#222222;');
          cell.vertex = true;
          model.add(step, cell);
          runtimeValueCells.push(cell);
        });
        var expanded = stepGeometry.clone();
        expanded.x -= panelWidth;
        expanded.width += panelWidth;
        expanded.height = Math.max(
          expanded.height,
          fieldTop + entries.length * fieldHeight + Math.max(0, entries.length - 1) * fieldGap + 8,
        );
        model.setGeometry(step, expanded);
        expandRuntimeValueAncestors(step);
      });
    } finally {
      model.endUpdate();
    }
    graph.refresh();
    runtimeValuesActive = runtimeValueCells.length > 0;
  }

  function toggleRuntimeValues() {
    if (runtimeValuesActive) {
      clearRuntimeValues();
      return;
    }
    var stableId = diagramFunctionStableId(graph.getSelectionCell());
    if (!stableId) {
      ui.handleError(new Error('The current diagram has no function stableID.'));
      return;
    }
    var url = 'http://127.0.0.1:8787/runtime-values?stableId=' + encodeURIComponent(stableId);
    fetch(url)
      .then(function(response) {
        if (!response.ok) throw new Error('Runtime values request failed: HTTP ' + response.status);
        return response.json();
      })
      .then(function(result) {
        if (!result.ok) throw new Error(result.error || 'Runtime values request failed');
        if (!result.values || !result.values.values || !result.values.values.length) {
          throw new Error('No runtime set values are stored for ' + stableId);
        }
        showRuntimeValues(result.values);
      })
      .catch(function(error) { ui.handleError(error); });
  }

  function runtimeStyleValue(style, key) {
    var match = String(style || '').match(new RegExp('(?:^|;)' + key + '=([^;]+)'));
    return match ? match[1] : '';
  }

  function runtimeStrokeColor(cell, fallback) {
    var style = cell.style || '';
    var directColor = runtimeStyleValue(style, 'strokeColor');
    if (directColor && directColor !== 'none') return directColor;
    var image = runtimeStyleValue(style, 'image');
    if (image.indexOf('data:image/svg+xml,') === 0) {
      try {
        var svg = decodeURIComponent(image.slice('data:image/svg+xml,'.length));
        var stroke = svg.match(/\bstroke=['"]([^'"]+)['"]/i);
        if (stroke && stroke[1] !== 'none') return stroke[1];
      } catch (error) {
        // Fall back to the semantic color when a foreign image cannot be decoded.
      }
    }
    return fallback;
  }

  function runtimeOutlineStyle(cell, color, strokeWidth) {
    var original = cell.style || '';
    var image = runtimeStyleValue(original, 'image');
    if (image.indexOf('data:image/svg+xml,') === 0) {
      try {
        var prefix = 'data:image/svg+xml,';
        var sourceSvg = decodeURIComponent(image.slice(prefix.length));
        var sketchMethodPath = sourceSvg.match(/<clipPath\s+id=['"]c['"]>\s*<path\s+d=['"]([^'"]+)['"]\s*\/>\s*<\/clipPath>/i);
        if (sketchMethodPath) {
          var viewBox = sourceSvg.match(/\bviewBox=['"]([^'"]+)['"]/i);
          var outlineSvg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='" + (viewBox ? viewBox[1] : '0 0 100 50') + "'>"
            + "<path d='" + sketchMethodPath[1] + "' fill='none' stroke='" + color + "' stroke-width='" + strokeWidth
            + "' stroke-linejoin='miter' vector-effect='non-scaling-stroke'/></svg>";
          return 'shape=image;imageAspect=0;image=' + prefix + encodeURIComponent(outlineSvg)
            + ';pointerEvents=0;movable=0;resizable=0;rotatable=0;deletable=0;editable=0;connectable=0;';
        }
        if (sourceSvg.indexOf('sketch-fill') >= 0) {
          return 'rounded=1;arcSize=10;fillOpacity=0;strokeOpacity=100;strokeColor=' + color
            + ';strokeWidth=' + strokeWidth + ';html=1;shadow=0;pointerEvents=0;movable=0;resizable=0;'
            + 'rotatable=0;deletable=0;editable=0;connectable=0;';
        }
        var svg = sourceSvg
          .replace(/\bfill=['"][^'"]*['"]/gi, "fill='none'")
          .replace(/\bstroke=['"][^'"]*['"]/gi, "stroke='" + color + "'")
          .replace(/\bstroke-width=['"][^'"]*['"]/gi, "stroke-width='" + strokeWidth + "'");
        return 'shape=image;imageAspect=0;image=' + prefix + encodeURIComponent(svg)
          + ';pointerEvents=0;movable=0;resizable=0;rotatable=0;deletable=0;editable=0;connectable=0;';
      } catch (error) {
        // Standard shape outline below is still preferable to highlighting a parent group.
      }
    }
    return original
      + ';fillOpacity=0;strokeOpacity=100;strokeColor=' + color + ';strokeWidth=' + strokeWidth
      + ';shadow=0;pointerEvents=0;movable=0;resizable=0;rotatable=0;deletable=0;editable=0;connectable=0;';
  }

  function addRuntimeCellOutline(cell, color, strokeWidth, outlineStyle) {
    var geometry = model.getGeometry(cell);
    var parent = model.getParent(cell);
    if (geometry == null || parent == null) return;
    var outline = new mxCell('', geometry.clone(), outlineStyle || runtimeOutlineStyle(cell, color, strokeWidth));
    outline.vertex = true;
    var cellIndex = typeof parent.getIndex === 'function' ? parent.getIndex(cell) : -1;
    model.add(parent, outline, cellIndex >= 0 ? cellIndex + 1 : model.getChildCount(parent));
    runtimeOutlines.push(outline);
  }

  function runtimeStableIdRoot(cell, stableId) {
    var current = cell;
    var parent = model.getParent(current);
    while (parent != null && getAttribute(parent, 'stableId') === stableId) {
      current = parent;
      parent = model.getParent(current);
    }
    return current;
  }

  function runtimePredicateOverlay(root) {
    for (var index = 0; index < model.getChildCount(root); index += 1) {
      var child = model.getChildAt(root, index);
      if (String(child.id || '').indexOf('-predicate-overlay') >= 0) return child;
    }
    return null;
  }

  function addRuntimeMosaicPredicateOutline(root, color, strokeWidth) {
    addRuntimeCellOutline(
      root,
      color,
      strokeWidth,
      'shape=hexagon;perimeter=hexagonPerimeter2;fixedSize=1;size=16;fillOpacity=0;strokeOpacity=100;'
        + 'strokeColor=' + color + ';strokeWidth=' + strokeWidth + ';html=1;shadow=0;pointerEvents=0;'
        + 'movable=0;resizable=0;rotatable=0;deletable=0;editable=0;connectable=0;',
    );
  }

  function isRuntimeHighlightableVertex(cell) {
    return model.isVertex(cell)
      && model.getChildCount(cell) === 0
      && runtimeStyleValue(cell.style, 'foldBoundaryPort') !== '1';
  }

  function runtimeHighlight(selection) {
    clearRuntimeHighlight();
    if (selection && selection.eventSequences && selection.eventSequences.length) {
      selection = Object.assign({}, selection, {
        edgePairs: (selection.edgePairs || []).slice(),
        nodeHighlights: (selection.nodeHighlights || []).slice()
      });
      selection.eventSequences.forEach(function(events) {
        var detail = runtimeTraceEdgePairs(events.filter(function(event) {
          return ['collection-pop', 'collection-predicate', 'collection-result'].indexOf(event.role) < 0;
        }), true);
        selection.edgePairs = selection.edgePairs.concat(detail.edgePairs);
        selection.nodeHighlights = selection.nodeHighlights.concat(detail.nodeHighlights);
      });
    }
    var nodeHighlights = (selection && selection.nodeHighlights) || [];
    if (!nodeHighlights.length) {
      nodeHighlights = ((selection && selection.staticStableIds) || []).map(function(stableId) {
        return { stableId: stableId, outcome: null };
      });
    }
    var edgePairs = (selection && selection.edgePairs) || [];
    var matchedEdges = [];
    var endpointIds = {};
    Object.keys(model.cells || {}).forEach(function(id) {
      var cell = model.cells[id];
      if (!model.isEdge(cell)) return;
      var stableId = runtimeStableIdKey(getAttribute(cell, 'stableId'));
      var targetStableId = runtimeStableIdKey(getAttribute(cell, 'targetStableId'));
      var edgeType = getAttribute(cell, 'edgeType');
      var protocolRole = getAttribute(cell, 'protocolRole');
      var source = model.getTerminal(cell, true);
      var target = model.getTerminal(cell, false);
      var sourceStableIds = [
        stableId,
        runtimeStableIdKey(getAttribute(source, 'stableId')),
        runtimeStableIdKey(getAttribute(source, 'sourceStableId')),
        runtimeStableIdKey(getAttribute(source, 'sourceCallStableId')),
      ];
      var targetStableIds = [
        targetStableId,
        runtimeStableIdKey(getAttribute(target, 'stableId')),
        runtimeStableIdKey(getAttribute(target, 'sourceStableId')),
        runtimeStableIdKey(getAttribute(target, 'sourceCallStableId')),
      ];
      var pair = edgePairs.find(function(candidate) {
        return sourceStableIds.indexOf(runtimeStableIdKey(candidate.sourceStableId)) >= 0
          && targetStableIds.indexOf(runtimeStableIdKey(candidate.targetStableId)) >= 0
          && (!candidate.edgeType
            || candidate.edgeType === edgeType
            || (candidate.edgeType === 'REPEATS'
              && (protocolRole === 'iteration-repeat'
                || String(cell.value || '').toLowerCase() === 'repeat')))
          && (!candidate.producerOutcome
            || candidate.producerOutcome === getAttribute(cell, 'producerOutcome'));
      });
      if (!pair) return;
      matchedEdges.push({ cell: cell, pair: pair });
      if (source != null) endpointIds[source.id] = true;
      if (target != null) endpointIds[target.id] = true;
    });
    var firstCell = null;
    model.beginUpdate();
    try {
      matchedEdges.forEach(function(match) {
        var cell = match.cell;
        var id = cell.id;
        var weight = Math.min(8, 2 + Math.log2(Number(match.pair.weight || 1) + 1));
        var color = runtimeStrokeColor(cell, '#9a5d00');
        runtimeOriginalStyles[id] = cell.style || '';
        model.setStyle(cell, (cell.style || '') + ';strokeColor=' + color + ';strokeWidth=' + weight + ';shadow=0;');
      });
      var highlightedNodes = {};
      Object.keys(endpointIds).forEach(function(id) {
        var cell = model.getCell(id);
        if (!model.isVertex(cell)) return;
        var cellStableId = getAttribute(cell, 'stableId');
        var stableId = runtimeStableIdKey(cellStableId);
        var nodeHighlight = nodeHighlights.find(function(candidate) {
          return runtimeStableIdKey(candidate.stableId) === stableId;
        });
        var isPredicate = nodeHighlight && nodeHighlight.role === 'predicate-stage';
        var isJoin = nodeHighlight && nodeHighlight.role === 'join-stage';
        if (isPredicate) {
          if (highlightedNodes[stableId]) return;
          highlightedNodes[stableId] = true;
          var root = runtimeStableIdRoot(cell, cellStableId);
          var overlay = runtimePredicateOverlay(root);
          var predicateColor = nodeHighlight.outcome ? '#2e7d32' : '#CC0000';
          if (overlay != null) {
            addRuntimeCellOutline(overlay, predicateColor, 3);
            if (firstCell == null) firstCell = overlay;
          } else {
            addRuntimeMosaicPredicateOutline(root, predicateColor, 3);
            if (firstCell == null) firstCell = root;
          }
          return;
        }
        if (isJoin) {
          if (highlightedNodes[stableId]) return;
          highlightedNodes[stableId] = true;
          var joinRoot = runtimeStableIdRoot(cell, cellStableId);
          addRuntimeCellOutline(joinRoot, runtimeStrokeColor(joinRoot, '#007FFF'), 3);
          if (firstCell == null) firstCell = joinRoot;
        }
      });
    } finally {
      model.endUpdate();
    }
    graph.refresh();
  }

  function pollRuntimeHighlightBridge() {
    pollDemoBridge();
    if (getAttribute(graph.getModel().getCell('1'), 'graphSceneId')) return;
    if (runtimeHighlightBridgePolling) return;
    runtimeHighlightBridgePolling = true;
    var functionStableId = diagramFunctionStableId(graph.getSelectionCell());
    var url = 'http://127.0.0.1:17843/runtime-highlight?after=' + runtimeHighlightBridgeRevision
      + '&functionStableId=' + encodeURIComponent(functionStableId || '');
    fetch(url)
      .then(function(response) {
        if (!response.ok) throw new Error('Runtime highlight bridge failed: HTTP ' + response.status);
        return response.json();
      })
      .then(function(result) {
        if (Number(result.revision) > runtimeHighlightBridgeRevision) {
          runtimeHighlightBridgeRevision = Number(result.revision);
        }
        var message = result.message || null;
        if (message && message.action === 'runtimeHighlight') runtimeHighlight(message.selection || {});
        if (message && message.action === 'runtimeHighlightClear') clearRuntimeHighlight();
        runtimeHighlightBridgePolling = false;
      }, function() {
        runtimeHighlightBridgePolling = false;
      });
  }

  function ensureRuntimeHighlightBridge() {
    if (runtimeHighlightBridgeTimer != null || typeof window.setInterval !== 'function') return;
    runtimeHighlightBridgeTimer = window.setInterval(pollRuntimeHighlightBridge, 500);
    pollRuntimeHighlightBridge();
  }

  // Demonstration commands operate on the real popup, using its own item handlers.
  // Never change graph geometry or resolve a semantic id to an arbitrary first tile.
  var demoPolling = false;
  var demoMenuItems = [];
  function demoFrame() {
    // OBS can capture this window while the narrator works in another window.
    // Chromium may suspend animation frames in an unfocused/occluded webview.
    return new Promise(function(resolve) {
      var frame, timer;
      function done() { clearTimeout(timer); cancelAnimationFrame(frame); resolve(); }
      timer = setTimeout(done, 100);
      frame = requestAnimationFrame(done);
    });
  }
  var presentationPointers = {};
  function clearPresentationPointers() {
    Object.keys(presentationPointers).forEach(function(id){presentationPointers[id].element.remove();});
    presentationPointers={};
  }
  // Pointer positions come from view geometry, so discard them when that geometry changes.
  graph.getModel().addListener(mxEvent.CHANGE,clearPresentationPointers);
  [mxEvent.SCALE,mxEvent.TRANSLATE,mxEvent.SCALE_AND_TRANSLATE].forEach(function(event){graph.getView().addListener(event,clearPresentationPointers);});
  function presentationOwner() {
    var sceneId=getAttribute(graph.getModel().getCell('1'),'graphSceneId');
    if(sceneId)return 'graph-scene:'+sceneId;
    var roots=Object.keys(graph.getModel().cells).map(function(id){return graph.getModel().cells[id];}).filter(function(c){return c.vertex&&c.parent&&c.parent.id==='1'&&getAttribute(c,'graphKind')==='Fn';});
    return roots.length===1?getAttribute(roots[0],'stableId'):diagramFunctionStableId(null);
  }
  async function performPresentationCommand(command) {
    if(command.functionStableId!==presentationOwner())throw new Error('Wrong presentation document');
    var model=graph.getModel(), allCells=Object.keys(model.cells).map(function(id){return model.cells[id];});
    var matches=allCells.filter(function(c){return c.vertex&&getAttribute(c,'stableId')===command.stableId&&(!command.cellId||c.id===command.cellId);});
    // An annotation belongs to the supplied semantic head via its explicit target id.
    if (!matches.length && command.cellId) matches=allCells.filter(function(c){var owner=model.getCell(getAttribute(c,'annotationTargetId'));return c.id===command.cellId&&c.vertex&&owner&&getAttribute(owner,'stableId')===command.stableId;});
    if(matches.length!==1)throw new Error('Missing/ambiguous semantic target; specify cellId');
    var cell=matches[0];
    for(var p=cell.parent;p;p=p.parent)if(p.collapsed)graph.foldCells(false,false,[p]);
    graph.getView().validate();
    var state=graph.getView().getState(cell);if(!state)throw new Error('Target not visible');
    if(command.action==='presentRead'){
      var v=graph.getView();
      return {stableId:command.stableId,cellId:cell.id,camera:{scale:v.scale,translate:{x:v.translate.x,y:v.translate.y},scrollLeft:graph.container.scrollLeft,scrollTop:graph.container.scrollTop},annotations:allCells.filter(function(c){var owner=model.getCell(getAttribute(c,'annotationTargetId'));return c.vertex&&owner&&getAttribute(owner,'stableId')===command.stableId;}).map(function(c){return {cellId:c.id,text:graph.convertValueToString(c)};})};
    }
    if(command.action==='presentFocus'){
      // Reapply before framing: a restored floating Format window can cover targets.
      hidePresenterFormatPanel();
      var view=graph.getView(), bounds=new mxRectangle(state.x,state.y,state.width,state.height), included=[cell.id];
      if(command.includeStep&&cell.parent&&/^fold-row-/.test(cell.parent.id))allCells.forEach(function(c){if(c.vertex&&c!==cell&&c.parent===cell.parent){var s=view.getState(c);if(s){bounds.add(new mxRectangle(s.x,s.y,s.width,s.height));included.push(c.id);}}});
      if(command.includeAnnotations)allCells.forEach(function(c){var owner=model.getCell(getAttribute(c,'annotationTargetId'));if(c.vertex&&owner&&getAttribute(owner,'stableId')===command.stableId){var s=view.getState(c);if(s){bounds.add(new mxRectangle(s.x,s.y,s.width,s.height));included.push(c.id);}}});
      var logical=new mxRectangle(bounds.x/view.scale-view.translate.x,bounds.y/view.scale-view.translate.y,bounds.width/view.scale,bounds.height/view.scale);
      var width=logical.width,height=logical.height;
      var scale=Math.max(.1,Math.min(2,(graph.container.clientWidth-96)/width,(graph.container.clientHeight-96)/height));
      if(command.previousStableId)scale=Math.min(view.scale,scale);
      var initialScale=view.scale,initialX=(graph.container.scrollLeft+graph.container.clientWidth/2)/view.scale-view.translate.x,initialY=(graph.container.scrollTop+graph.container.clientHeight/2)/view.scale-view.translate.y;
      var finalX=logical.x+logical.width/2,finalY=logical.y+logical.height/2;
      if(command.previousStableId){var half=(graph.container.clientWidth/2-48)/scale;finalX=Math.max(logical.x+logical.width-half,Math.min(initialX,logical.x+half));}
      var duration=Math.max(0,Math.min(5000,Number(command.durationMs)||0)),started=performance.now(),samples=[];
      clearPresentationPointers();
      do {
        var t=duration?Math.min(1,(performance.now()-started)/duration):1,k=t*t*(3-2*t),s=initialScale+(scale-initialScale)*k;
        graph.zoomTo(s);view=graph.getView();
        var cx=(initialX+(finalX-initialX)*k+view.translate.x)*view.scale,cy=(initialY+(finalY-initialY)*k+view.translate.y)*view.scale;
        graph.container.scrollLeft=Math.max(0,cx-graph.container.clientWidth/2);graph.container.scrollTop=Math.max(0,cy-graph.container.clientHeight/2);
        samples.push({t:t,scale:view.scale,left:graph.container.scrollLeft,top:graph.container.scrollTop});
        if(t<1)await demoFrame();
      }while(t<1);
      await demoFrame();
      return {stage:'focused',stableId:command.stableId,cellId:cell.id,scale:graph.getView().scale,includedCellIds:included,formatPanelVisible:ui.isFormatPanelVisible(),transition:{durationMs:duration,samples:samples},viewport:{width:graph.container.clientWidth,height:graph.container.clientHeight}};
    }
    if(command.action==='presentPointer'){
      var id=command.pointerId||'narrator';if(!/^[a-zA-Z0-9_-]{1,40}$/.test(id))throw new Error('Invalid pointer id');
      var target={x:state.x+state.width,y:state.y+state.height/2},entry=presentationPointers[id];
      var textBounds=null;
      if(command.text!=null){
        if(typeof command.text!=='string'||!command.text.length||command.text.length>500)throw new Error('Specify a nonempty text target');
        var root=state.text&&state.text.node;if(!root)throw new Error('Target has no rendered text');
        var walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),nodes=[],full='',node;
        while((node=walker.nextNode())){nodes.push({node:node,start:full.length});full+=node.nodeValue;}
        var offset=full.indexOf(command.text);
        if(offset<0||full.indexOf(command.text,offset+1)>=0)throw new Error('Text target missing or ambiguous in rendered label');
        var end=offset+command.text.length,first=nodes.find(function(n){return n.start+n.node.nodeValue.length>offset;}),last=nodes.find(function(n){return n.start+n.node.nodeValue.length>=end;});
        var range=document.createRange();range.setStart(first.node,offset-first.start);range.setEnd(last.node,end-last.start);
        var rects=Array.from(range.getClientRects()).filter(function(r){return r.width>0&&r.height>0;});
        if(!rects.length)throw new Error('Text target is not laid out');
        var rect=rects[0],containerRect=graph.container.getBoundingClientRect();
        if(rect.left<containerRect.left||rect.right>containerRect.right||rect.top<containerRect.top||rect.bottom>containerRect.bottom)throw new Error('Text target is outside the visible diagram');
        target={x:rect.left+rect.width/2-containerRect.left+graph.container.scrollLeft,y:rect.bottom-containerRect.top+graph.container.scrollTop};
        textBounds={x:rect.left-containerRect.left,y:rect.top-containerRect.top,width:rect.width,height:rect.height};
      }
      if(!entry){var svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('width','48');svg.setAttribute('height','64');svg.style.cssText='position:absolute;pointer-events:none;z-index:100;overflow:visible';var arrow=document.createElementNS(svg.namespaceURI,'path');arrow.setAttribute('d','M 0 0 L 5 38 L 14 28 L 29 51 L 38 45 L 23 23 L 37 20 Z');arrow.setAttribute('fill','#e53935');arrow.setAttribute('stroke','white');svg.appendChild(arrow);graph.container.appendChild(svg);entry=presentationPointers[id]={element:svg,x:target.x,y:target.y};}
      var from={x:entry.x,y:entry.y},duration=Math.max(0,Math.min(5000,Number(command.durationMs)||0)),started=performance.now();
      do{var t=duration?Math.min(1,(performance.now()-started)/duration):1,k=t*t*(3-2*t);entry.x=from.x+(target.x-from.x)*k;entry.y=from.y+(target.y-from.y)*k;entry.element.style.left=entry.x+'px';entry.element.style.top=entry.y+'px';if(t<1)await demoFrame();}while(t<1);
      return {stage:'pointer-moved',stableId:command.stableId,cellId:cell.id,text:command.text||null,textBounds:textBounds,coordinateSource:textBounds?'Rendered text Range geometry':'draw.io view geometry'};
    }
    throw new Error('Unsupported presentation command');
  }
  // Scene control uses mxGeometry coordinates. It is isolated from flow diagrams.
  async function performSceneCommand(command) {
    var model = graph.getModel();
    var sceneId = getAttribute(model.getCell('1'), 'graphSceneId');
    if (!sceneId || command.functionStableId !== 'graph-scene:' + sceneId) throw new Error('Wrong graph scene');
    if (command.action === 'sceneSync') {
      if (typeof command.xml !== 'string' || command.xml.length > 500000) throw new Error('Invalid scene XML');
      var doc = mxUtils.parseXml(command.xml);
      var incoming = doc.getElementsByTagName('mxGraphModel')[0];
      if (!incoming || incoming.getAttribute('graphSceneId') !== sceneId) throw new Error('Scene identity mismatch');
      ui.editor.setGraphXml(incoming);
      await demoFrame();
      return {stage:'scene-synced',sceneId:sceneId};
    }
    if (command.action === 'sceneRead') {
      var view = graph.getView();
      return {sceneId:sceneId,coordinateSpace:'draw.io model',camera:{scale:view.scale,translate:{x:view.translate.x,y:view.translate.y},scrollLeft:graph.container.scrollLeft,scrollTop:graph.container.scrollTop},
        cells:Object.keys(model.cells).map(function(id) {
          var c=model.cells[id], g=model.getGeometry(c);
          return g ? {cellId:id,stableId:getAttribute(c,'stableId'),edge:!!c.edge,x:g.x,y:g.y,width:g.width,height:g.height,source:c.source&&c.source.id,target:c.target&&c.target.id,sourcePoint:g.sourcePoint,targetPoint:g.targetPoint} : null;
        }).filter(Boolean)};
    }
    if (command.action === 'scenePointer') {
      if (!/^[a-zA-Z0-9_-]{1,40}$/.test(command.pointerId)) throw new Error('Invalid pointer id');
      var id='pointer-'+command.pointerId, cell=model.getCell(id), target=command.pointer;
      if (!target) { if (cell) graph.removeCells([cell]); return {stage:'pointer-hidden'}; }
      if (!Number.isFinite(target.x)||!Number.isFinite(target.y)||Math.abs(target.x)>100000||Math.abs(target.y)>100000) throw new Error('Invalid pointer coordinates');
      var old=cell && model.getGeometry(cell), from=old && old.targetPoint || target;
      if (!cell) cell=graph.insertEdge(graph.getDefaultParent(),id,'',null,null,'endArrow=classic;endFill=1;strokeColor=#e53935;strokeWidth=4;');
      var duration=Math.max(0,Math.min(5000,Number(command.durationMs)||0)), started=performance.now();
      do {
        var t=duration?Math.min(1,(performance.now()-started)/duration):1,k=t*t*(3-2*t);
        var x=from.x+(target.x-from.x)*k,y=from.y+(target.y-from.y)*k;
        var geometry=model.getGeometry(cell).clone();geometry.setTerminalPoint(new mxPoint(x+42,y+55),true);geometry.setTerminalPoint(new mxPoint(x,y),false);
        model.setGeometry(cell,geometry);
        if(t<1)await demoFrame();
      } while(t<1);
      return {stage:'pointer-moved',sceneId:sceneId,cellId:id,x:target.x,y:target.y};
    }
    throw new Error('Unsupported scene action');
  }
  async function performDemoCommand(command) {
    if (command.action.indexOf('present') === 0) return performPresentationCommand(command);
    if (command.action.indexOf('scene') === 0) return performSceneCommand(command);
    var menu = graph.popupMenuHandler;
    if (command.action === 'dismissMenu') { menu.hideMenu(); demoMenuItems = []; return { stage: 'menu-closed' }; }
    if (command.action === 'contextMenu') {
      var cells = Object.keys(graph.getModel().cells).map(function(id) { return graph.getModel().cells[id]; });
      var candidates = cells.filter(function(cell) {
        return command.cellId ? cell.id === command.cellId : getAttribute(cell, 'stableId') === command.stableId;
      });
      if (candidates.length !== 1) throw new Error('Target missing or ambiguous; provide exact cellId');
      var cell = candidates[0];
      graph.setSelectionCell(cell); graph.scrollCellToVisible(cell);
      await demoFrame();
      var state = graph.getView().getState(cell);
      if (!state) throw new Error('Target is hidden/collapsed');
      var rect = graph.container.getBoundingClientRect();
      var x = rect.left + state.x + state.width / 2 - graph.container.scrollLeft;
      var y = rect.top + state.y + state.height / 2 - graph.container.scrollTop;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) throw new Error('Target is outside visible diagram');
      var originalAdd = menu.addItem;
      demoMenuItems = [];
      menu.addItem = function(label, image, callback) {
        var args = Array.prototype.slice.call(arguments);
        var item = { label: label, invoked: false, row: null };
        if (typeof callback === 'function') args[2] = function() { item.invoked = true; return callback.apply(this, arguments); };
        var row = originalAdd.apply(this, args);
        if (typeof callback === 'function') { item.row = row; demoMenuItems.push(item); }
        return row;
      };
      try { menu.popup(x, y, cell, new MouseEvent('contextmenu', { clientX:x,clientY:y,button:2,buttons:2 })); }
      finally { menu.addItem = originalAdd; }
      await demoFrame();
      if (!menu.isMenuShowing()) throw new Error('Context menu did not open');
      return { stage:'menu-open',cellId:cell.id,items:demoMenuItems.map(function(item){return item.label;}) };
    }
    if (command.action === 'menuClick') {
      if (!menu.isMenuShowing()) throw new Error('Open the context menu first');
      var matches = demoMenuItems.filter(function(item){return item.label === command.label;});
      if (matches.length !== 1 || !matches[0].row || !matches[0].row.isConnected) throw new Error('Menu item missing or ambiguous');
      var item = matches[0];
      var EventType = mxClient.IS_POINTER ? PointerEvent : MouseEvent;
      item.row.dispatchEvent(new EventType(mxClient.IS_POINTER ? 'pointerdown' : 'mousedown',{bubbles:true,button:0,buttons:1}));
      item.row.dispatchEvent(new EventType(mxClient.IS_POINTER ? 'pointerup' : 'mouseup',{bubbles:true,button:0}));
      await demoFrame();
      if (!item.invoked) throw new Error('Menu item handler did not run');
      return {stage:'menu-handler-invoked',label:item.label};
    }
    throw new Error('Unsupported diagram demo action');
  }
  async function pollDemoBridge() {
    if (demoPolling) return;
    demoPolling = true;
    try {
      var owner = presentationOwner();
      if (!owner) return;
      var response = await fetch('http://127.0.0.1:17843/demo/next?functionStableId=' + encodeURIComponent(owner));
      if (!response.ok) return;
      var command = (await response.json()).command;
      if (!command) return;
      var reply = {requestId:command.requestId};
      try { reply.result = await performDemoCommand(command); } catch(error) { reply.error = error.message; }
      await fetch('http://127.0.0.1:17843/demo/ack',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(reply)});
    } catch(error) { /* Bridge may be unavailable while VS Code reloads. */ }
    finally { demoPolling = false; }
  }

  window.addEventListener('message', function(event) {
    var message = event.data;
    if (typeof message === 'string') {
      try { message = JSON.parse(message); } catch (error) { return; }
    }
    if (!message) return;
    if (message.action === 'codexGraphResponse' && message.requestId) {
      completePostRequest(message.requestId, message.result || {});
    }
    if (message.action === 'runtimeHighlight') runtimeHighlight(message.selection || {});
    if (message.action === 'runtimeHighlightClear') clearRuntimeHighlight();
  });

  var oldFactory = graph.popupMenuHandler.factoryMethod;
  graph.popupMenuHandler.factoryMethod = function(menu, cell, evt) {
    if (oldFactory != null) {
      oldFactory.apply(this, arguments);
    }

    var payload = getCellPayload(cell);
    if (payload == null) return;

    try {
      menu.addSeparator();
    } catch (error) {
      // ignored
    }

    if (payload.kind === 'Annotation') {
      var annotationLink = annotationLinkForCell(cell);
      if (annotationLink != null) {
        menu.addItem(annotationLinkIsVisible(annotationLink) ? 'скрыть Связь' : 'показать Связь', null, function() {
          toggleAnnotationLink(cell);
        });
      }
    }

    menu.addItem('добавить в Чат', null, function() {
      sendAction(cell, 'addToCodexThread');
    });
    menu.addItem('перейти в Код', null, function() {
      sendAction(cell, 'openStableId');
    });
    if (payload.sourceStableId || (payload.locationStableId && payload.sourceLookup === 'definition')) {
      menu.addItem('перейти в Первоисточник', null, function() {
        sendSourceAction(cell);
      });
    }
    var flowStableId = functionFlowStableId(payload);
    if (flowStableId) {
      menu.addItem('открыть в отдельной Диаграмме', null, function() {
        sendFunctionAction(cell, 'openFunctionFlow', flowStableId);
      });
    }
    if (payload.functionStableId) {
      menu.addItem('Show Sequence', null, function() {
        sendAction(cell, 'showFunctionSequence');
      });
    }
    menu.addItem('получить Аннотацию', null, function() {
      sendAction(cell, 'annotateGraphItem');
    });
    if (payload.stableId && (
      payload.labels.indexOf('DeveloperDefined') >= 0
      || payload.labels.indexOf('Parameter') >= 0
    )) {
      menu.addItem('показать функциональный сегмент', null, function() {
        sendAction(cell, 'showFunctionalSegment');
      });
    }
    if (isRuntimeLoopPayload(payload)) {
      menu.addItem('показать статистику Цикла', null, function() {
        sendRuntimeAnalysisAction(cell);
      });
    }
    menu.addItem(runtimeTraceActive ? 'скрыть Trace функции' : 'показать Trace функции', null, function() {
      toggleRuntimeTrace(cell);
    });
    menu.addItem(runtimeValuesActive ? 'скрыть Значения' : 'показать Значения', null, function() {
      toggleRuntimeValues();
    });
  };

  ensureRuntimeHighlightBridge();
  postLoaded();
});

Draw.loadPlugin(function (ui) {
  var graph = ui.editor.graph;
  var model = graph.getModel();
  var baseGetFoldingImage = graph.getFoldingImage;
  var baseIsCellFoldable = graph.isCellFoldable;
  var baseInstallCellOverlayListeners = graph.cellRenderer.installCellOverlayListeners;
  var imageCache = {};
  var refreshTimer = null;

  function ColdKodeFoldingFrameShape() {
    mxShape.call(this);
  }

  mxUtils.extend(ColdKodeFoldingFrameShape, mxShape);

  ColdKodeFoldingFrameShape.prototype.paintVertexShape = function (canvas, x, y, width, height) {
    var flowBlock = getNumber(this.style || {}, 'flowBlock', 0) === 1;
    var stroke = mxUtils.getValue(this.style || {}, mxConstants.STYLE_STROKECOLOR, '#878787');
    var strokeWidth = getNumber(this.style || {}, mxConstants.STYLE_STROKEWIDTH, 1.5);
    var horizontalLength = Math.min(width * 0.22, 220);
    var verticalLength = Math.min(height * 0.45, 90);
    var steps = [
      { from: 0, to: 0.2, alpha: 1 },
      { from: 0.2, to: 0.4, alpha: 0.72 },
      { from: 0.4, to: 0.6, alpha: 0.45 },
      { from: 0.6, to: 0.8, alpha: 0.22 },
      { from: 0.8, to: 1, alpha: 0.08 },
    ];

    function segment(x1, y1, x2, y2, alpha) {
      canvas.setAlpha(alpha);
      canvas.begin();
      canvas.moveTo(x1, y1);
      canvas.lineTo(x2, y2);
      canvas.stroke();
    }

    canvas.setStrokeColor(stroke);
    canvas.setStrokeWidth(strokeWidth);
    if (flowBlock) {
      steps.forEach(function (step) {
        segment(x, y + verticalLength * step.from, x, y + verticalLength * step.to, step.alpha);
        segment(x + width, y + verticalLength * step.from, x + width, y + verticalLength * step.to, step.alpha);
        segment(x, y + height - verticalLength * step.from, x, y + height - verticalLength * step.to, step.alpha);
        segment(x + width, y + height - verticalLength * step.from, x + width, y + height - verticalLength * step.to, step.alpha);
      });
    } else {
      segment(x, y, x, y + height, 1);
      segment(x + width, y, x + width, y + height, 1);
    }
    steps.forEach(function (step) {
      segment(x + horizontalLength * step.from, y, x + horizontalLength * step.to, y, step.alpha);
      segment(x + horizontalLength * step.from, y + height, x + horizontalLength * step.to, y + height, step.alpha);
      segment(x + width - horizontalLength * step.from, y, x + width - horizontalLength * step.to, y, step.alpha);
      segment(x + width - horizontalLength * step.from, y + height, x + width - horizontalLength * step.to, y + height, step.alpha);
    });
    canvas.setAlpha(1);
  };

  mxCellRenderer.registerShape('coldKodeFoldingFrame', ColdKodeFoldingFrameShape);

  function getNumber(style, key, fallback) {
    var value = parseFloat(mxUtils.getValue(style, key, fallback));
    return isNaN(value) ? fallback : value;
  }

  function getCellAttribute(cell, name) {
    if (cell == null) return '';
    if (typeof cell.getAttribute === 'function') {
      var direct = cell.getAttribute(name);
      if (direct != null && direct !== '') return String(direct);
    }
    if (cell.value != null && typeof cell.value.getAttribute === 'function') {
      var value = cell.value.getAttribute(name);
      if (value != null && value !== '') return String(value);
    }
    if (cell[name] != null && cell[name] !== '') return String(cell[name]);
    return '';
  }

  function isFoldingRow(cell) {
    if (cell == null || !model.isVertex(cell)) return false;
    var style = graph.getCurrentCellStyle(cell);
    return getNumber(style, 'foldingRow', 0) === 1 &&
      getNumber(style, 'foldingIconSize', 0) > 0;
  }

  function isStepRow(cell) {
    return isFoldingRow(cell) && getCellAttribute(cell, 'graphKind') === 'Step';
  }

  function isFlowBlockRow(cell) {
    if (!isFoldingRow(cell)) return false;
    return getNumber(graph.getCurrentCellStyle(cell), 'flowBlock', 0) === 1;
  }

  function isPureStepRow(cell) {
    return isStepRow(cell) && !isFlowBlockRow(cell);
  }

  function createImage(size, collapsed) {
    var key = size + ':' + collapsed;
    if (imageCache[key] == null) {
      var stroke = Math.max(1, Math.round(size * 0.08));
      var low = Math.round(size * 0.28);
      var high = Math.round(size * 0.72);
      var middle = size / 2;
      var symbol = collapsed
        ? '<path d="M ' + middle + ' ' + low + ' L ' + middle + ' ' + high +
          ' M ' + low + ' ' + middle + ' L ' + high + ' ' + middle +
          '" stroke="#333333" stroke-width="' + stroke + '"/>'
        : '<path d="M ' + low + ' ' + middle + ' L ' + high + ' ' + middle +
          '" stroke="#333333" stroke-width="' + stroke + '"/>';
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size +
        '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' +
        '<rect x="1" y="1" width="' + (size - 2) + '" height="' + (size - 2) +
        '" rx="2" stroke="#777777" fill="#f5f5f5" stroke-width="' + stroke + '"/>' +
        symbol + '</svg>';
      imageCache[key] = new mxImage(
        'data:image/svg+xml,' + encodeURIComponent(svg), size, size
      );
    }
    return imageCache[key];
  }

  function createStepDetailCheckboxImage(size, checked) {
    var key = 'data:' + size + ':' + checked;
    if (imageCache[key] == null) {
      var stroke = Math.max(1, Math.round(size * 0.1));
      var mark = checked
        ? '<path d="M ' + Math.round(size * 0.22) + ' ' + Math.round(size * 0.52) +
          ' L ' + Math.round(size * 0.43) + ' ' + Math.round(size * 0.72) +
          ' L ' + Math.round(size * 0.8) + ' ' + Math.round(size * 0.28) +
          '" fill="none" stroke="#2f6f3e" stroke-width="' + stroke +
          '" stroke-linecap="round" stroke-linejoin="round"/>'
        : '';
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size +
        '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' +
        '<rect x="1" y="1" width="' + (size - 2) + '" height="' + (size - 2) +
        '" rx="2" stroke="#777777" fill="#ffffff" stroke-width="' + stroke + '"/>' +
        mark + '</svg>';
      imageCache[key] = new mxImage(
        'data:image/svg+xml,' + encodeURIComponent(svg), size, size
      );
    }
    return imageCache[key];
  }

  function stepDetailCells(stepCell) {
    var stepStableId = getCellAttribute(stepCell, 'stableId');
    var cells = model.cells || {};
    if (!stepStableId) return [];
    return Object.keys(cells)
      .map(function(id) { return cells[id]; })
      .filter(function(candidate) {
        var visibility = getCellAttribute(candidate, 'stepVisibility');
        var isDetail = visibility === 'detail'
          || (visibility === '' && getCellAttribute(candidate, 'flowLayer') === 'data');
        return isDetail
          && getCellAttribute(candidate, 'ownerStepStableId') === stepStableId;
      });
  }

  function isStepDetailVisible(stepCell) {
    var cells = stepDetailCells(stepCell);
    return cells.length === 0 || cells.some(function(cell) { return model.isVisible(cell); });
  }

  function isStepDetailCellForOverlay(cell) {
    var visibility = getCellAttribute(cell, 'stepVisibility');
    return visibility === 'detail'
      || (visibility === '' && getCellAttribute(cell, 'flowLayer') === 'data');
  }

  function isFoldBoundaryPort(cell) {
    if (cell == null || !model.isVertex(cell)) return false;
    return getNumber(graph.getCurrentCellStyle(cell), 'foldBoundaryPort', 0) === 1;
  }

  function directStepChildren(stepCell) {
    var children = [];
    var childCount = model.getChildCount(stepCell);
    for (var index = 0; index < childCount; index += 1) {
      children.push(model.getChildAt(stepCell, index));
    }
    return children;
  }

  function setCellAttribute(cell, name, value) {
    if (cell == null) return;
    var text = String(value);
    cell[name] = text;
    if (typeof cell.setAttribute === 'function') {
      cell.setAttribute(name, text);
    } else if (cell.value != null &&
        typeof cell.value.setAttribute === 'function') {
      cell.value.setAttribute(name, text);
    }
  }

  function translatedChildGeometry(geometry, dy) {
    var translated = geometry.clone();
    if (typeof translated.translate === 'function') {
      translated.translate(0, dy);
    } else {
      translated.y += dy;
    }
    return translated;
  }

  function coreVertexBounds(stepCell) {
    var bounds = null;
    directStepChildren(stepCell).forEach(function(child) {
      if (!model.isVertex(child) || isStepDetailCellForOverlay(child)) return;
      var geometry = model.getGeometry(child);
      if (geometry == null) return;
      if (isFoldBoundaryPort(child)) {
        if (bounds != null) {
          bounds.left = Math.min(bounds.left, geometry.x);
          bounds.right = Math.max(bounds.right, geometry.x + geometry.width);
        }
        return;
      }
      var left = geometry.x;
      var top = geometry.y;
      var right = geometry.x + geometry.width;
      var bottom = geometry.y + geometry.height;
      if (bounds == null) {
        bounds = { left: left, top: top, right: right, bottom: bottom };
      } else {
        bounds.left = Math.min(bounds.left, left);
        bounds.top = Math.min(bounds.top, top);
        bounds.right = Math.max(bounds.right, right);
        bounds.bottom = Math.max(bounds.bottom, bottom);
      }
    });
    return bounds;
  }

  function moveBottomBoundaryPorts(stepCell, beforeHeight, afterHeight) {
    directStepChildren(stepCell).forEach(function(child) {
      if (!isFoldBoundaryPort(child)) return;
      var geometry = model.getGeometry(child);
      if (geometry == null || geometry.y + geometry.height / 2 < beforeHeight / 2) return;
      var moved = geometry.clone();
      moved.y = afterHeight - geometry.height / 2;
      model.setGeometry(child, moved);
    });
  }

  function updateStepBoundaryEdgeRatios(stepCell) {
    var stepGeometry = model.getGeometry(stepCell);
    if (stepGeometry == null || stepGeometry.width <= 0) return;
    directStepChildren(stepCell).forEach(function(port) {
      if (!isFoldBoundaryPort(port) || isStepDetailCellForOverlay(port)) return;
      var match = String(port.id || '').match(/^(.*)-(source|target)-port$/);
      var portGeometry = model.getGeometry(port);
      if (!match || portGeometry == null) return;
      var boundaryEdge = model.getCell(match[1] + '-boundary');
      if (boundaryEdge == null) return;
      var ratio = Math.max(0.02, Math.min(
        0.98,
        (portGeometry.x + portGeometry.width / 2) / stepGeometry.width
      ));
      var styleKey = match[2] === 'source' ? 'exitX' : 'entryX';
      var styleParts = String(boundaryEdge.style || '')
        .split(';')
        .filter(function(part) { return part && part.indexOf(styleKey + '=') !== 0; });
      styleParts.push(styleKey + '=' + String(ratio));
      model.setStyle(
        boundaryEdge,
        styleParts.join(';') + ';'
      );
    });
  }

  function shiftStepCoreChildren(stepCell, dy) {
    if (dy === 0) return;
    directStepChildren(stepCell).forEach(function(child) {
      if (isFoldBoundaryPort(child) || isStepDetailCellForOverlay(child)) return;
      var geometry = model.getGeometry(child);
      if (geometry == null) return;
      model.setGeometry(child, translatedChildGeometry(geometry, dy));
    });
  }

  function compactStepToCore(stepCell) {
    if (graph.isCellCollapsed(stepCell)) return;
    var beforeGeometry = model.getGeometry(stepCell);
    var bounds = coreVertexBounds(stepCell);
    if (beforeGeometry == null || bounds == null) return;
    beforeGeometry = beforeGeometry.clone();
    var topPadding = 38;
    var bottomPadding = 22;
    var rightPadding = 36;
    var coreShiftY = topPadding - bounds.top;
    var compactHeight = Math.max(88, topPadding + (bounds.bottom - bounds.top) + bottomPadding);
    var compactWidth = Math.max(160, Math.min(beforeGeometry.width, bounds.right + rightPadding));
    if (compactHeight >= beforeGeometry.height
        && compactWidth >= beforeGeometry.width
        && coreShiftY === 0) return;

    setCellAttribute(stepCell, 'stepDetailExpandedHeight', beforeGeometry.height);
    setCellAttribute(stepCell, 'stepDetailExpandedWidth', beforeGeometry.width);
    setCellAttribute(stepCell, 'stepDetailCoreShiftY', coreShiftY);
    setCellAttribute(stepCell, 'stepDetailCompact', '1');
    shiftStepCoreChildren(stepCell, coreShiftY);
    moveBottomBoundaryPorts(stepCell, beforeGeometry.height, compactHeight);
    var compactGeometry = beforeGeometry.clone();
    compactGeometry.height = compactHeight;
    compactGeometry.width = compactWidth;
    model.setGeometry(stepCell, compactGeometry);
    updateStepBoundaryEdgeRatios(stepCell);
    shiftFollowingRows(stepCell, beforeGeometry);
  }

  function restoreStepFromCore(stepCell) {
    var beforeGeometry = model.getGeometry(stepCell);
    var expandedHeight = parseFloat(getCellAttribute(stepCell, 'stepDetailExpandedHeight'));
    var expandedWidth = parseFloat(getCellAttribute(stepCell, 'stepDetailExpandedWidth'));
    var coreShiftY = parseFloat(getCellAttribute(stepCell, 'stepDetailCoreShiftY'));
    if (beforeGeometry == null || !isFinite(expandedHeight) || expandedHeight <= 0) return;
    beforeGeometry = beforeGeometry.clone();
    if (!isFinite(coreShiftY)) coreShiftY = 0;
    shiftStepCoreChildren(stepCell, -coreShiftY);
    moveBottomBoundaryPorts(stepCell, beforeGeometry.height, expandedHeight);
    var expandedGeometry = beforeGeometry.clone();
    expandedGeometry.height = expandedHeight;
    if (isFinite(expandedWidth) && expandedWidth > 0) expandedGeometry.width = expandedWidth;
    model.setGeometry(stepCell, expandedGeometry);
    updateStepBoundaryEdgeRatios(stepCell);
    setCellAttribute(stepCell, 'stepDetailCompact', '0');
    shiftFollowingRows(stepCell, beforeGeometry);
  }

  function setStepDetailVisible(stepCell, visible) {
    var cells = stepDetailCells(stepCell);
    model.beginUpdate();
    try {
      if (visible) restoreStepFromCore(stepCell);
      cells.forEach(function(cell) {
        model.setVisible(cell, visible);
      });
      if (!visible) compactStepToCore(stepCell);
    } finally {
      model.endUpdate();
    }
    graph.refresh();
    if (ui.editor != null && typeof ui.editor.setModified === 'function') {
      ui.editor.setModified(true);
    }
    scheduleRefresh();
  }

  function translatedGeometry(geometry, dy) {
    var translated = geometry.clone();
    translated.y += dy;
    if (translated.alternateBounds != null) {
      translated.alternateBounds = translated.alternateBounds.clone();
      translated.alternateBounds.y += dy;
    }
    return translated;
  }

  function shiftFollowingRows(cell, beforeGeometry) {
    var afterGeometry = model.getGeometry(cell);
    if (beforeGeometry == null || afterGeometry == null) return;
    var delta = afterGeometry.height - beforeGeometry.height;
    if (delta === 0) return;
    var parent = model.getParent(cell);
    var parentGeometry = model.getGeometry(parent);
    var childCount = model.getChildCount(parent);
    for (var index = 0; index < childCount; index += 1) {
      var sibling = model.getChildAt(parent, index);
      if (sibling === cell || !isFoldingRow(sibling)) continue;
      var siblingGeometry = model.getGeometry(sibling);
      if (siblingGeometry != null && siblingGeometry.y > beforeGeometry.y) {
        model.setGeometry(sibling, translatedGeometry(siblingGeometry, delta));
      }
    }
    if (parentGeometry != null) {
      var beforeParentGeometry = parentGeometry.clone();
      var resizedParent = parentGeometry.clone();
      resizedParent.height += delta;
      model.setGeometry(parent, resizedParent);
      if (isFoldingRow(parent)) shiftFollowingRows(parent, beforeParentGeometry);
    }
  }

  graph.getFoldingImage = function (state) {
    if (state != null && isFoldingRow(state.cell)) return null;
    return baseGetFoldingImage.apply(this, arguments);
  };

  graph.isCellFoldable = function(cell, collapse) {
    if (isPureStepRow(cell)) return false;
    return baseIsCellFoldable.apply(this, arguments);
  };

  graph.cellRenderer.installCellOverlayListeners = function (state, overlay, shape) {
    baseInstallCellOverlayListeners.apply(this, arguments);
    if ((!overlay.coldKodeFoldingControl && !overlay.coldKodeStepDetailControl) ||
        shape == null || shape.node == null) return;
    mxEvent.addListener(shape.node, 'contextmenu', function (evt) {
      graph.setSelectionCell(state.cell);
      graph.popupMenuHandler.popup(mxEvent.getClientX(evt), mxEvent.getClientY(evt), state.cell, evt);
      mxEvent.consume(evt);
    });
  };

  function setRowCollapsed(cell, collapse) {
    if (!isFoldingRow(cell) || isPureStepRow(cell) ||
        graph.isCellCollapsed(cell) === collapse) return;
    var beforeGeometry = model.getGeometry(cell);
    if (beforeGeometry == null || beforeGeometry.alternateBounds == null) return;
    beforeGeometry = beforeGeometry.clone();
    model.beginUpdate();
    try {
      model.setCollapsed(cell, collapse);
      var swappedGeometry = beforeGeometry.clone();
      swappedGeometry.swap();
      model.setGeometry(cell, swappedGeometry);
      shiftFollowingRows(cell, beforeGeometry);
    } finally {
      model.endUpdate();
    }
    graph.view.invalidate(cell, true, true);
    graph.refresh();
    if (ui.editor != null && typeof ui.editor.setModified === 'function') {
      ui.editor.setModified(true);
    }
  }

  function removeFoldingOverlay(cell) {
    var overlays = graph.getCellOverlays(cell) || [];
    overlays.slice().forEach(function (overlay) {
      if (overlay.coldKodeFoldingControl) graph.removeCellOverlay(cell, overlay);
    });
  }

  function removeStepDetailOverlay(cell) {
    var overlays = graph.getCellOverlays(cell) || [];
    overlays.slice().forEach(function (overlay) {
      if (overlay.coldKodeStepDetailControl) graph.removeCellOverlay(cell, overlay);
    });
  }

  function installFoldingOverlay(cell) {
    removeFoldingOverlay(cell);
    if (!isFoldingRow(cell) || isPureStepRow(cell)) return;
    var style = graph.getCurrentCellStyle(cell);
    var size = getNumber(style, 'foldingIconSize', 24);
    var inset = getNumber(style, 'foldingIconInset', 10);
    var topInset = getNumber(style, 'foldingIconTopInset', inset);
    var overlay = new mxCellOverlay(
      createImage(size, graph.isCellCollapsed(cell)),
      graph.isCellCollapsed(cell) ? 'Expand' : 'Collapse',
      mxConstants.ALIGN_LEFT,
      mxConstants.ALIGN_TOP
    );
    overlay.coldKodeFoldingControl = true;
    overlay.cursor = 'pointer';
    overlay.getBounds = function (state) {
      var scale = state.view.scale;
      return new mxRectangle(
        Math.round(state.x + inset * scale),
        Math.round(state.y + topInset * scale),
        Math.round(size * scale),
        Math.round(size * scale)
      );
    };
    overlay.addListener(mxEvent.CLICK, function (sender, eventObject) {
      var event = eventObject.getProperty('event');
      setRowCollapsed(cell, !graph.isCellCollapsed(cell));
      if (event != null) mxEvent.consume(event);
      scheduleRefresh();
    });
    graph.addCellOverlay(cell, overlay);
  }

  function installStepDetailOverlay(cell) {
    removeStepDetailOverlay(cell);
    if (!isStepRow(cell)) return;
    var style = graph.getCurrentCellStyle(cell);
    var foldingSize = getNumber(style, 'foldingIconSize', 24);
    var inset = getNumber(style, 'foldingIconInset', 10);
    var topInset = getNumber(style, 'foldingIconTopInset', inset);
    var size = Math.max(18, Math.round(foldingSize * 0.82));
    var checkboxInset = isPureStepRow(cell) ? inset : inset + foldingSize + 7;
    var visible = isStepDetailVisible(cell);
    var overlay = new mxCellOverlay(
      createStepDetailCheckboxImage(size, visible),
      visible ? 'Hide Step details' : 'Show Step details',
      mxConstants.ALIGN_LEFT,
      mxConstants.ALIGN_TOP
    );
    overlay.coldKodeStepDetailControl = true;
    overlay.cursor = 'pointer';
    overlay.getBounds = function (state) {
      var scale = state.view.scale;
      return new mxRectangle(
        Math.round(state.x + checkboxInset * scale),
        Math.round(state.y + (topInset + (foldingSize - size) / 2) * scale),
        Math.round(size * scale),
        Math.round(size * scale)
      );
    };
    overlay.addListener(mxEvent.CLICK, function (sender, eventObject) {
      var event = eventObject.getProperty('event');
      setStepDetailVisible(cell, !isStepDetailVisible(cell));
      if (event != null) mxEvent.consume(event);
    });
    graph.addCellOverlay(cell, overlay);
  }

  function refreshOverlays() {
    refreshTimer = null;
    var cells = model.cells || {};
    model.beginUpdate();
    try {
      Object.keys(cells).forEach(function (id) {
        if (!isFoldingRow(cells[id])) return;
        installFoldingOverlay(cells[id]);
        installStepDetailOverlay(cells[id]);
      });
    } finally {
      model.endUpdate();
    }
  }

  function scheduleRefresh() {
    if (refreshTimer != null) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(refreshOverlays, 0);
  }

  model.addListener(mxEvent.CHANGE, scheduleRefresh);
  graph.addListener(mxEvent.REFRESH, scheduleRefresh);
  scheduleRefresh();
});
