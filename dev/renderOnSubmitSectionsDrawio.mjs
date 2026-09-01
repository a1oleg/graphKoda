import fs from 'node:fs';
import path from 'node:path';

import { deriveOnSubmitSections } from './deriveOnSubmitSections.mjs';

const outputArg = process.argv.includes('--output')
  ? process.argv[process.argv.indexOf('--output') + 1]
  : undefined;
const outputPath = path.resolve(process.cwd(), outputArg || 'graph/draw/onSubmit-function-sections.drawio');

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(value, max = 74) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
}

function styleForKind(kind) {
  const styles = {
    'submit-preflight': ['#e8f4ff', '#4f8cc9'],
    'immediate-command': ['#fff4df', '#c08a2c'],
    'remote-empty-guard': ['#f7f7f7', '#8a8a8a'],
    'idle-return-guard': ['#fff0f0', '#c45f5f'],
    'history-capture': ['#eaf7ed', '#5a9b66'],
    'input-classification': ['#f0f0ff', '#7871c7'],
    'submit-readiness': ['#f0f0ff', '#7871c7'],
    'input-ui-reset': ['#eaf9fb', '#56a6b3'],
    'speculation-accept': ['#f5ecff', '#9563c7'],
    'remote-submit': ['#fff2ea', '#c07048'],
    'prompt-pipeline-handoff': ['#eaf3ff', '#4f77c9'],
    'stashed-prompt-restore': ['#eef8f1', '#5e9e72'],
  };
  const [fill, stroke] = styles[kind] || ['#f5f5f5', '#777777'];
  return `rounded=1;whiteSpace=wrap;html=1;fillColor=${fill};strokeColor=${stroke};strokeWidth=1.5;fontColor=#1f1f1f;fontSize=12;align=left;verticalAlign=top;spacing=10;`;
}

function headerStyleForKind(kind) {
  return `${styleForKind(kind)}fontStyle=1;verticalAlign=middle;`;
}

function stepStyleForKind(kind) {
  const styles = {
    'submit-preflight': ['#f5fbff', '#4f8cc9'],
    'immediate-command': ['#fffaf0', '#c08a2c'],
    'remote-empty-guard': ['#ffffff', '#8a8a8a'],
    'idle-return-guard': ['#fff8f8', '#c45f5f'],
    'history-capture': ['#f5fbf6', '#5a9b66'],
    'input-classification': ['#f8f8ff', '#7871c7'],
    'submit-readiness': ['#f8f8ff', '#7871c7'],
    'input-ui-reset': ['#f4fcfd', '#56a6b3'],
    'speculation-accept': ['#fbf7ff', '#9563c7'],
    'remote-submit': ['#fff8f4', '#c07048'],
    'prompt-pipeline-handoff': ['#f5f9ff', '#4f77c9'],
    'stashed-prompt-restore': ['#f6fbf7', '#5e9e72'],
  };
  const [fill, stroke] = styles[kind] || ['#ffffff', '#777777'];
  return `rounded=1;whiteSpace=wrap;html=1;fillColor=${fill};strokeColor=${stroke};strokeWidth=1.2;fontColor=#1f1f1f;fontSize=10;align=left;verticalAlign=middle;spacing=7;`;
}

function cell(lines, id, value, style, x, y, width, height) {
  lines.push(`<mxCell id="${escapeXml(id)}" value="${escapeXml(value)}" style="${style}" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${width}" height="${height}" as="geometry" /></mxCell>`);
}

function edge(lines, id, source, target, value = '', style = 'edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;strokeColor=#555555;strokeWidth=1.4;') {
  lines.push(`<mxCell id="${escapeXml(id)}" value="${escapeXml(value)}" style="${style}" edge="1" parent="1" source="${escapeXml(source)}" target="${escapeXml(target)}"><mxGeometry relative="1" as="geometry" /></mxCell>`);
}

const LEFT_EDGE_STYLE = 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;exitX=0;exitY=0.5;exitDx=0;exitDy=0;entryX=1;entryY=0.5;entryDx=0;entryDy=0;';
const RIGHT_EDGE_STYLE = 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;exitX=1;exitY=0.5;exitDx=0;exitDy=0;entryX=0;entryY=0.5;entryDx=0;entryDy=0;';
const RETURN_EDGE_STYLE = 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=open;dashed=1;exitX=0;exitY=0.5;exitDx=0;exitDy=0;entryX=1;entryY=0.5;entryDx=0;entryDy=0;';

function sectionLabel(section) {
  const calls = section.targetCalls
    .slice(0, 4)
    .map((call) => `вЂў ${truncate(call.targetName || call.calleeText, 46)} :${call.line}`)
    .join('&#xa;');
  return [
    `${section.index}. ${section.label}`,
    `${section.lines} В· ${section.stepCount} flow steps${section.hasEarlyReturn ? ' В· early return' : ''}`,
    calls ? `&#xa;${calls}` : '',
  ].join('&#xa;');
}

function evidenceLabel(section) {
  return [
    'evidence',
    truncate(section.evidence, 170),
  ].join('&#xa;');
}

function targetLabel(call) {
  const file = String(call.targetStableId || '').split(':')[0];
  return [
    `${call.targetName || call.calleeText}`,
    `call @ ${call.line}:${call.column}`,
    file ? truncate(file, 42) : '',
  ].filter(Boolean).join('&#xa;');
}

function isRenderableResource(resource) {
  return resource && resource.resourceKind !== 'async-control';
}

function isUiLayerResource(resource) {
  return resource && ['ui-state', 'input-state'].includes(resource.resourceKind);
}

function resourceLabel(resource) {
  return [
    `${resource.accessType || resource.relType} ${resource.resourceName}`,
    `${resource.resourceKind}/${resource.resourceSubkind}`,
    `@ ${resource.line}:${resource.column}`,
  ].filter(Boolean).join('&#xa;');
}

function resourceStyle(resource) {
  const styles = {
    'ui-state': ['#f3ecff', '#8b61bd'],
    'input-state': ['#eaf9fb', '#51a5b1'],
    'history-store': ['#eaf7ed', '#5a9b66'],
    'telemetry-sink': ['#fff4df', '#c08a2c'],
    'config-store': ['#f0f0ff', '#7871c7'],
    'runtime-state': ['#f7f7f7', '#777777'],
    'remote-session': ['#fff0f0', '#c45f5f'],
  };
  const [fill, stroke] = styles[resource.resourceKind] || ['#ffffff', '#8a8a8a'];
  return `rounded=1;whiteSpace=wrap;html=1;fillColor=${fill};strokeColor=${stroke};fontColor=#242424;fontSize=10;align=left;verticalAlign=middle;spacing=8;`;
}

function uiEntrypointLabel(entry) {
  return [
    `${entry.elementName}.${entry.eventHandlerName}`,
    `${entry.surfaceName} В· ${entry.affordanceKind}`,
    `@ ${entry.line}:${entry.column}`,
  ].filter(Boolean).join('&#xa;');
}

function uiUpdateLabel(resource) {
  return [
    `${resource.accessType || resource.relType} ${resource.resourceName}`,
    `${resource.resourceKind}/${resource.resourceSubkind}`,
    `@ ${resource.line}:${resource.column}`,
  ].filter(Boolean).join('&#xa;');
}

function resourcesForCall(section, call) {
  const direct = (section.resourceTouches || [])
    .filter(isRenderableResource)
    .filter((resource) => resource.stepStableId === call.stepStableId);
  const nested = (call.resources || []).filter(isRenderableResource);
  const seen = new Set();
  return [...direct, ...nested].filter((resource) => {
    const key = `${resource.resourceKey}:${resource.accessType || resource.relType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function directResourcesWithoutTargetCall(section) {
  const targetStepIds = new Set((section.targetCalls || []).map((call) => call.stepStableId));
  return (section.resourceTouches || [])
    .filter(isRenderableResource)
    .filter((resource) => !targetStepIds.has(resource.stepStableId));
}

function sectionHeaderLabel(section) {
  return [
    `${section.index}. ${section.label}`,
    section.lines,
  ].filter(Boolean).join('&#xa;');
}

function stepLabel(step) {
  const hints = [
    step.calls.length ? `${step.calls.length} call${step.calls.length === 1 ? '' : 's'}` : '',
    step.uiResources.length ? `${step.uiResources.length} UI/input` : '',
    step.directResources.length ? `${step.directResources.length} resource` : '',
  ].filter(Boolean).join(' В· ');
  return [
    truncate(step.primaryText, 76),
    `${step.line}:${step.column}${hints ? ` | ${hints}` : ''}`,
  ].join('&#xa;');
}

function addSectionStep(stepsById, stepStableId, line, column, primaryText) {
  const key = stepStableId || `line:${line}:${column}:${primaryText}`;
  if (!stepsById.has(key)) {
    stepsById.set(key, {
      key,
      stepStableId,
      line: Number(line || 0),
      column: Number(column || 0),
      primaryText: primaryText || 'operation',
      calls: [],
      uiResources: [],
      directResources: [],
    });
  }
  const step = stepsById.get(key);
  if (!step.primaryText || step.primaryText === 'operation') {
    step.primaryText = primaryText || step.primaryText;
  }
  return step;
}

function buildSectionSteps(section) {
  const stepsById = new Map();
  const targetStepIds = new Set((section.targetCalls || []).map((call) => call.stepStableId));

  for (const call of section.targetCalls || []) {
    const step = addSectionStep(
      stepsById,
      call.stepStableId,
      call.line,
      call.column,
      call.calleeText || call.targetName || 'call',
    );
    step.calls.push(call);
  }

  for (const resource of section.resourceTouches || []) {
    if (!isRenderableResource(resource)) continue;
    const step = addSectionStep(
      stepsById,
      resource.stepStableId,
      resource.line,
      resource.column,
      resource.resourceName || resource.resourceKey || 'resource',
    );
    if (isUiLayerResource(resource)) {
      step.uiResources.push(resource);
    } else if (!targetStepIds.has(resource.stepStableId)) {
      step.directResources.push(resource);
    }
  }

  return [...stepsById.values()]
    .filter((step) => step.calls.length || step.uiResources.length || step.directResources.length)
    .sort((left, right) => (left.line - right.line) || (left.column - right.column) || left.key.localeCompare(right.key));
}

function stepBlockHeight(section, step, callHeight, callGap, resourceHeight, resourceGap) {
  const callRows = step.calls.reduce((sum, call) => {
    const callResources = resourcesForCall(section, call).filter((resource) => !isUiLayerResource(resource));
    return sum + Math.max(callHeight, callResources.length * resourceHeight + Math.max(0, callResources.length - 1) * resourceGap);
  }, 0);
  const uiRows = step.uiResources.length
    ? step.uiResources.length * resourceHeight + Math.max(0, step.uiResources.length - 1) * resourceGap
    : 0;
  const directRows = step.directResources.length
    ? step.directResources.length * resourceHeight + Math.max(0, step.directResources.length - 1) * resourceGap
    : 0;
  return Math.max(46, callRows + Math.max(0, step.calls.length - 1) * callGap, uiRows, directRows);
}

function renderDrawio(payload) {
  const sections = payload.sections;
  const sectionWidth = 360;
  const targetWidth = 260;
  const resourceWidth = 280;
  const uiWidth = 230;
  const uiX = 20;
  const sectionX = 330;
  const targetX = 820;
  const resourceX = 1220;
  const startY = 150;
  const gapY = 42;
  const callHeight = 54;
  const callGap = 12;
  const resourceHeight = 54;
  const resourceGap = 10;
  const headerHeight = 54;
  const stepHeight = 42;
  const stepWidth = 320;
  const stepX = sectionX + 20;
  const stepGap = 14;
  const sectionHeights = sections.map((section) => {
    const steps = buildSectionSteps(section);
    const stepsHeight = steps.reduce((sum, step) => {
      return sum + stepBlockHeight(section, step, callHeight, callGap, resourceHeight, resourceGap);
    }, 0);
    return headerHeight + (steps.length ? 16 + stepsHeight + Math.max(0, steps.length - 1) * stepGap + 16 : 18);
  });
  const totalHeight = sectionHeights.reduce((sum, height) => sum + height, 0) + gapY * (sections.length - 1) + 220;

  const lines = [];
  lines.push('<mxfile host="app.diagrams.net" modified="2026-06-09T00:00:00.000Z" agent="Codex" version="24.7.17">');
  lines.push('<diagram id="onSubmit-function-sections" name="onSubmit sections"><mxGraphModel dx="1900" dy="1100" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1540" pageHeight="' + totalHeight + '" math="0" shadow="0"><root>');
  lines.push('<mxCell id="0" /><mxCell id="1" parent="0" />');

  cell(lines, 'title', `Function sections&#xa;${payload.function.name}()&#xa;${payload.function.repoRelativePath}`, 'text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;whiteSpace=wrap;rounded=0;fontSize=18;fontStyle=1;', 30, 20, 760, 72);
  cell(lines, 'root-fn', `Fn&#xa;${payload.function.name}()&#xa;${payload.function.stableId}`, 'rounded=1;whiteSpace=wrap;html=1;fillColor=#24292f;strokeColor=#24292f;fontColor=#ffffff;fontStyle=1;fontSize=12;align=center;verticalAlign=middle;', sectionX, 70, sectionWidth, 58);

  const uiEntrypoints = payload.uiEntrypoints || [];
  uiEntrypoints.forEach((entry, index) => {
    const id = `ui-entry-${index + 1}`;
    const entryY = startY + index * 70;
    cell(lines, id, uiEntrypointLabel(entry), 'rounded=1;whiteSpace=wrap;html=1;fillColor=#edf6ff;strokeColor=#4f8cc9;fontColor=#1f1f1f;fontSize=10;align=left;verticalAlign=middle;spacing=8;', uiX, entryY, uiWidth, 56);
    edge(lines, `ui-entry-${index + 1}-to-root`, id, 'root-fn', entry.eventHandlerName || 'event', 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;strokeColor=#4f8cc9;strokeWidth=1.3;fontSize=9;');
  });

  let y = startY;
  sections.forEach((section, index) => {
    const sectionId = `section-${section.index}`;
    const height = sectionHeights[index];
    const steps = buildSectionSteps(section);
    cell(lines, sectionId, sectionHeaderLabel(section), headerStyleForKind(section.kind), sectionX, y, sectionWidth, headerHeight);
    let stepY = y + headerHeight + 16;
    steps.forEach((step, stepIndex) => {
      const blockHeight = stepBlockHeight(section, step, callHeight, callGap, resourceHeight, resourceGap);
      const stepId = `section-${section.index}-step-${stepIndex + 1}`;
      cell(lines, stepId, stepLabel(step), stepStyleForKind(section.kind), stepX, stepY, stepWidth, stepHeight);

      step.uiResources.forEach((resource, resourceIndex) => {
        const id = `section-${section.index}-step-${stepIndex + 1}-ui-${resourceIndex + 1}`;
        const resourceY = stepY + resourceIndex * (resourceHeight + resourceGap);
        cell(lines, id, uiUpdateLabel(resource), resourceStyle(resource), uiX, resourceY, uiWidth, resourceHeight);
        edge(lines, `section-${section.index}-step-${stepIndex + 1}-ui-edge-${resourceIndex + 1}`, stepId, id, resource.accessType || resource.relType, `${LEFT_EDGE_STYLE}strokeColor=#7a6ab0;strokeWidth=1.2;fontSize=9;`);
      });

      let callY = stepY;
      step.calls.forEach((call, callIndex) => {
        const callId = `section-${section.index}-step-${stepIndex + 1}-call-${callIndex + 1}`;
        const callResources = resourcesForCall(section, call).filter((resource) => !isUiLayerResource(resource));
        const callBlockHeight = Math.max(callHeight, callResources.length * resourceHeight + Math.max(0, callResources.length - 1) * resourceGap);
        cell(lines, callId, targetLabel(call), 'rounded=1;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#6f6f6f;fontColor=#2f2f2f;fontSize=10;align=left;verticalAlign=middle;spacing=8;', targetX, callY, targetWidth, callHeight);
        edge(lines, `section-${section.index}-step-${stepIndex + 1}-call-edge-${callIndex + 1}`, stepId, callId, truncate(call.calleeText || call.targetName, 28), `${RIGHT_EDGE_STYLE}strokeColor=#4e6f9e;strokeWidth=1.3;fontSize=9;`);
        edge(lines, `section-${section.index}-step-${stepIndex + 1}-return-edge-${callIndex + 1}`, callId, stepId, 'return', `${RETURN_EDGE_STYLE}strokeColor=#9b9b9b;strokeWidth=1;fontSize=9;`);
        callResources.forEach((resource, resourceIndex) => {
          const resourceId = `section-${section.index}-step-${stepIndex + 1}-call-${callIndex + 1}-resource-${resourceIndex + 1}`;
          const resourceY = callY + resourceIndex * (resourceHeight + resourceGap);
          cell(lines, resourceId, resourceLabel(resource), resourceStyle(resource), resourceX, resourceY, resourceWidth, resourceHeight);
          edge(lines, `section-${section.index}-step-${stepIndex + 1}-call-${callIndex + 1}-resource-edge-${resourceIndex + 1}`, callId, resourceId, resource.accessType || resource.relType, `${RIGHT_EDGE_STYLE}strokeColor=#8a6f3e;strokeWidth=1.2;fontSize=9;`);
        });
        callY += callBlockHeight + callGap;
      });

      step.directResources.forEach((resource, resourceIndex) => {
        const resourceId = `section-${section.index}-step-${stepIndex + 1}-direct-resource-${resourceIndex + 1}`;
        const resourceY = stepY + resourceIndex * (resourceHeight + resourceGap);
        cell(lines, resourceId, resourceLabel(resource), resourceStyle(resource), resourceX, resourceY, resourceWidth, resourceHeight);
        edge(lines, `section-${section.index}-step-${stepIndex + 1}-direct-resource-edge-${resourceIndex + 1}`, stepId, resourceId, resource.accessType || resource.relType, `${RIGHT_EDGE_STYLE}strokeColor=#8a6f3e;strokeWidth=1.2;fontSize=9;`);
      });

      stepY += blockHeight + stepGap;
    });
    if (index === 0) {
      edge(lines, 'root-to-section-1', 'root-fn', sectionId);
    } else {
      edge(lines, `section-flow-${sections[index - 1].index}-${section.index}`, `section-${sections[index - 1].index}`, sectionId);
    }
    y += height + gapY;
  });

  lines.push('</root></mxGraphModel></diagram></mxfile>');
  return lines.join('');
}

const payload = await deriveOnSubmitSections();
const drawioXml = renderDrawio(payload);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, drawioXml, 'utf8');

console.log(JSON.stringify({
  saved: true,
  outputPath,
  sectionCount: payload.sections.length,
  totalStepCount: payload.sections.reduce((sum, section) => sum + section.stepCount, 0),
  targetCallCount: payload.sections.reduce((sum, section) => sum + section.targetCalls.length, 0),
  targetFnCount: new Set(payload.sections.flatMap((section) => section.targetCalls.map((call) => call.targetStableId))).size,
  terminalResourceTouchCount: payload.sections.reduce((sum, section) => sum + (section.resourceTouches || []).filter(isRenderableResource).length, 0),
  uiEntrypointCount: (payload.uiEntrypoints || []).length,
  uiUpdateTouchCount: payload.sections.reduce((sum, section) => sum + (section.resourceTouches || []).filter(isUiLayerResource).length, 0),
  sections: payload.sections.map((section) => ({
    index: section.index,
    label: section.label,
    lines: section.lines,
    stepCount: section.stepCount,
    targetCalls: section.targetCalls.length,
    terminalResources: (section.resourceTouches || []).filter(isRenderableResource).length,
  })),
}, null, 2));

