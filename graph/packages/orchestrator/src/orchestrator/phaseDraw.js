import fs from 'node:fs';
import path from 'node:path';

import { renderFeatureFnGraphDrawio } from './featureDraw.js';

function escapeXml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#xa;');
}

function sanitizeFileName(text) {
  const sanitized = String(text || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'phase';
}

function shorten(text, maxLength = 96) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function getStepLabel(step) {
  return shorten(step?.operationCalleeText || step?.actionText || step?.name || step?.stableId || 'step');
}

function getParticipantLabel(participant) {
  const node = participant?.node;
  const kind = participant?.kind || (node?.synthetic ? 'Call target' : node?.isFunction ? 'Fn' : 'Participant');
  const name = node?.name || node?.label || participant?.key || 'participant';
  return `${kind}\n${name}`;
}

function writeTextFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${content}\n`, 'utf8');
}

function addVertex(lines, id, value, style, x, y, width, height) {
  lines.push(`<mxCell id="${escapeXml(id)}" value="${escapeXml(value)}" style="${style}" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${width}" height="${height}" as="geometry" /></mxCell>`);
}

function addEdge(lines, id, value, source, target, dashed = false) {
  const style = dashed
    ? 'edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=open;dashed=1;strokeColor=#666666;'
    : 'edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;strokeColor=#333333;strokeWidth=2;';
  lines.push(`<mxCell id="${escapeXml(id)}" value="${escapeXml(value)}" style="${style}" edge="1" parent="1" source="${escapeXml(source)}" target="${escapeXml(target)}"><mxGeometry relative="1" as="geometry" /></mxCell>`);
}

function collectPhaseCallEvents(phase, pathGraph) {
  const pathItem = pathGraph?.paths?.[0] || { nodes: [] };
  const nodes = pathItem.nodes || [];
  const owner = phase?.owner || {
    stableId: phase?.ownerFnStableId || 'owner',
    name: phase?.ownerFnStableId || 'owner',
    isFunction: true,
  };
  const participants = [{ key: 'owner', kind: 'Owner', node: owner }];
  const participantByKey = new Map([['owner', participants[0]]]);
  const events = [];

  nodes.forEach((step) => {
    if (!step?.callTarget?.stableId) {
      return;
    }

    const targetKey = step.callTarget.stableId;
    if (!participantByKey.has(targetKey)) {
      const participant = {
        key: targetKey,
        kind: step.callTarget.synthetic ? 'Call target' : 'Fn',
        node: step.callTarget,
      };
      participantByKey.set(targetKey, participant);
      participants.push(participant);
    }

    const role = step.stableId === phase?.headStepStableId
      ? 'HEAD'
      : step.stableId === phase?.tailStepStableId
        ? 'TAIL'
        : '';
    events.push({
      from: 'owner',
      to: targetKey,
      label: `${role ? `${role}: ` : ''}${getStepLabel(step)}`,
      responseLabel: step.callTarget.synthetic ? null : 'return',
    });
  });

  if (!events.length && nodes.length) {
    events.push({
      from: 'owner',
      to: 'owner',
      label: `HEAD -> TAIL: ${getStepLabel(nodes[0])} ... ${getStepLabel(nodes.at(-1))}`,
      responseLabel: null,
    });
  }

  return { participants, events };
}

function renderPhaseSequenceDrawio(phase, pathGraph) {
  const sequence = collectPhaseCallEvents(phase, pathGraph);
  const laneWidth = 170;
  const laneGap = 28;
  const left = 28;
  const top = 110;
  const headerHeight = 70;
  const eventStartY = 235;
  const eventGap = 62;
  const width = Math.max(
    900,
    left * 2 + sequence.participants.length * laneWidth + Math.max(sequence.participants.length - 1, 0) * laneGap,
  );
  const height = Math.max(760, eventStartY + sequence.events.length * eventGap * 2 + 110);
  const laneCenterByKey = new Map();
  const lines = [];

  lines.push('<mxfile host="app.diagrams.net" modified="2026-06-08T00:00:00.000Z" agent="Codex" version="24.7.17">');
  lines.push(`<diagram id="${escapeXml(phase?.key || 'phase')}" name="Phase">`);
  lines.push(`<mxGraphModel dx="${width}" dy="${height}" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${width}" pageHeight="${height}" math="0" shadow="0">`);
  lines.push('<root><mxCell id="0" /><mxCell id="1" parent="0" />');
  addVertex(
    lines,
    'title',
    `phase sequence\n${phase?.key || ''} - ${phase?.label || ''}\nhead/tail local path: ${pathGraph?.pathCount || 0}; call axes: ${Math.max(sequence.participants.length - 1, 0)}`,
    'text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;whiteSpace=wrap;rounded=0;fontSize=16;fontStyle=1;',
    20,
    20,
    width - 40,
    70,
  );

  sequence.participants.forEach((participant, index) => {
    const x = left + index * (laneWidth + laneGap);
    const centerX = x + laneWidth / 2;
    laneCenterByKey.set(participant.key, centerX);
    const fillColor = participant.key === 'owner'
      ? '#d9ead3'
      : participant.node?.synthetic
        ? '#fff2cc'
        : '#dae8fc';
    const strokeColor = participant.key === 'owner'
      ? '#5f874f'
      : participant.node?.synthetic
        ? '#d6b656'
        : '#6c8ebf';
    addVertex(lines, `lane-${index}`, getParticipantLabel(participant), `rounded=1;whiteSpace=wrap;html=1;fillColor=${fillColor};strokeColor=${strokeColor};fontColor=#000000;`, x, top, laneWidth, headerHeight);
    addVertex(lines, `axis-${index}`, '', 'rounded=0;whiteSpace=wrap;html=1;fillColor=#d9d9d9;strokeColor=#a6a6a6;dashed=1;opacity=60;', centerX - 1, top + headerHeight + 10, 2, height - top - headerHeight - 70);
  });

  sequence.events.forEach((event, index) => {
    const y = eventStartY + index * eventGap * 2;
    const fromX = laneCenterByKey.get(event.from);
    const toX = laneCenterByKey.get(event.to);
    if (fromX === undefined || toX === undefined) {
      return;
    }

    const sourceId = `event-${index}-source`;
    const targetId = `event-${index}-target`;
    addVertex(lines, sourceId, '', 'ellipse;whiteSpace=wrap;html=1;aspect=fixed;fillColor=#333333;strokeColor=#333333;opacity=0;', fromX - 4, y - 4, 8, 8);
    addVertex(lines, targetId, '', 'ellipse;whiteSpace=wrap;html=1;aspect=fixed;fillColor=#333333;strokeColor=#333333;opacity=0;', toX - 4, y - 4, 8, 8);
    addEdge(lines, `event-${index}`, event.label, sourceId, targetId);

    if (event.responseLabel) {
      const responseY = y + eventGap;
      const responseSourceId = `event-${index}-response-source`;
      const responseTargetId = `event-${index}-response-target`;
      addVertex(lines, responseSourceId, '', 'ellipse;whiteSpace=wrap;html=1;aspect=fixed;fillColor=#666666;strokeColor=#666666;opacity=0;', toX - 4, responseY - 4, 8, 8);
      addVertex(lines, responseTargetId, '', 'ellipse;whiteSpace=wrap;html=1;aspect=fixed;fillColor=#666666;strokeColor=#666666;opacity=0;', fromX - 4, responseY - 4, 8, 8);
      addEdge(lines, `event-${index}-response`, event.responseLabel, responseSourceId, responseTargetId, true);
    }
  });

  lines.push('</root></mxGraphModel></diagram></mxfile>');
  return {
    drawioXml: lines.join(''),
    nodeCount: sequence.participants.length,
    edgeCount: sequence.events.length + sequence.events.filter((event) => event.responseLabel).length,
  };
}

export function buildPhasePathGraphDrawDiagram(phase, pathGraph) {
  if (!pathGraph?.available) {
    return {
      available: false,
      error: pathGraph?.error || 'Phase path graph is unavailable.',
      phase,
      saved: false,
      filePath: null,
      format: null,
      pathCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      drawioXml: null,
    };
  }

  const render = renderPhaseSequenceDrawio(phase, pathGraph);
  const filePath = path.resolve(process.cwd(), 'graph', 'draw', `${sanitizeFileName(`${phase?.key || 'phase'}-phase-path`)}.drawio`);
  writeTextFile(filePath, render.drawioXml);
  return {
    available: true,
    error: null,
    phase,
    saved: true,
    filePath,
    format: 'drawio',
    pathCount: pathGraph.pathCount || 0,
    nodeCount: render.nodeCount,
    edgeCount: render.edgeCount,
    drawioXml: render.drawioXml,
  };
}

function normalizeLaneNode(node, { isRoot = false, isTarget = false } = {}) {
  const labels = [...(node?.labels || [])];
  const normalizedLabels = labels.length ? labels : ['Fn', 'Unassigned'];
  return {
    stableId: node?.stableId,
    name: node?.name || node?.label || node?.operationCalleeText || '<anonymous>',
    label: node?.label,
    labels: normalizedLabels,
    layer: node?.layer,
    repoRelativePath: node?.repoRelativePath || node?.location?.repoRelativePath,
    location: node?.location,
    isFunction: true,
    isExternal: Boolean(node?.isExternal),
    isRoot,
    isTarget,
    synthetic: Boolean(node?.synthetic),
    runtimeObserved: false,
    isRuntimeOnly: Boolean(node?.synthetic),
    runtimeLoggable: Boolean(node?.runtimeLoggable),
    loggingUsefulKinds: node?.loggingUsefulKinds || [],
    loggingUsefulReasons: node?.loggingUsefulReasons || [],
  };
}

function buildPhaseLaneGraph(phase, pathGraph) {
  const pathItem = pathGraph?.paths?.[0] || { nodes: [] };
  const ownerNode = normalizeLaneNode(phase?.owner || {
    stableId: phase?.ownerFnStableId || 'phase-owner',
    name: phase?.ownerFnStableId || 'phase owner',
    labels: ['Fn', 'APIBridge'],
  }, { isRoot: true });
  const nodesById = new Map([[ownerNode.stableId, ownerNode]]);
  const edgesByKey = new Map();

  for (const step of pathItem.nodes || []) {
    const callTarget = step?.callTarget;
    if (!callTarget?.stableId || callTarget.stableId === ownerNode.stableId) {
      continue;
    }

    const isTail = step.stableId === phase?.tailStepStableId;
    const targetNode = normalizeLaneNode(callTarget, { isTarget: isTail });
    if (!nodesById.has(targetNode.stableId)) {
      nodesById.set(targetNode.stableId, targetNode);
    }

    const edgeKey = `${ownerNode.stableId}->${targetNode.stableId}:${step.stableId}`;
    edgesByKey.set(edgeKey, {
      fromId: ownerNode.stableId,
      toId: targetNode.stableId,
      displayType: step.stableId === phase?.headStepStableId
        ? 'HEAD'
        : isTail
          ? 'TAIL'
          : 'CALL',
      displayLabel: getStepLabel(step),
      hasCall: true,
    });
  }

  const allNodes = [...nodesById.values()];
  const targetIds = new Set(
    [...edgesByKey.values()]
      .filter((edge) => edge.displayType === 'TAIL')
      .map((edge) => edge.toId),
  );
  const flowNodes = allNodes.filter((node) => node.stableId !== ownerNode.stableId && !targetIds.has(node.stableId));
  const targetFns = allNodes.filter((node) => targetIds.has(node.stableId));

  return {
    root: ownerNode,
    flowNodes,
    targetFns,
    nodes: allNodes,
    edges: [...edgesByKey.values()],
  };
}

export function buildPhaseSwimlaneDrawDiagram(phase, pathGraph) {
  if (!pathGraph?.available) {
    return {
      available: false,
      error: pathGraph?.error || 'Phase path graph is unavailable.',
      phase,
      saved: false,
      filePath: null,
      format: null,
      pathCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      drawioXml: null,
    };
  }

  const graph = buildPhaseLaneGraph(phase, pathGraph);
  const featureLike = {
    key: phase?.key,
    name: phase?.label || phase?.key,
    stableId: phase?.ownerFnStableId,
  };
  const drawioXml = renderFeatureFnGraphDrawio(featureLike, graph, {
    messages: [{
      severity: 'info',
      code: 'PHASE_SWIMLANE_RENDERED',
      message: `Rendered phase swimlane graph: nodes=${graph.nodes.length}, edges=${graph.edges.length}.`,
    }],
  });
  const filePath = path.resolve(process.cwd(), 'graph', 'draw', `${sanitizeFileName(`${phase?.key || 'phase'}-phase-swimlane`)}.drawio`);
  writeTextFile(filePath, drawioXml);

  return {
    available: true,
    error: null,
    phase,
    saved: true,
    filePath,
    format: 'drawio',
    pathCount: pathGraph.pathCount || 0,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    drawioXml,
  };
}


