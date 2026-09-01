import process from 'node:process';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import { config } from 'dotenv';
import neo4j from 'neo4j-driver';
import { buildStableIdLocation } from '../graph/stableIdModel.js';

const workspaceRoot = process.cwd();
const FUNCTION_FLOW_SOURCE = 'functionFlowGraph';
const CONTROL_EDGE_TYPES = ['NEXT', 'TRUE', 'FALSE', 'OPTION_CASE', 'OPTION_DEFAULT', 'REJOINS', 'MERGES_TO'];
const KEYWORD_RE = /presentation|screen|share|groupcall|callapi|joingroupcallpresentation|startsharingscreen|handleupdategroupcallconnection|getuserstream|initializeconnection|invokeRequest/i;

function parseArgs(argv) {
  const args = {
    featureName: 'feature-path',
    startFnStableId: undefined,
    endFnStableId: undefined,
    output: undefined,
    jsonOutput: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === '--feature-name') {
      args.featureName = value;
      index += 1;
    } else if (arg === '--start-fn-stable-id') {
      args.startFnStableId = value;
      index += 1;
    } else if (arg === '--end-fn-stable-id') {
      args.endFnStableId = value;
      index += 1;
    } else if (arg === '--output') {
      args.output = path.resolve(value);
      index += 1;
    } else if (arg === '--json-output') {
      args.jsonOutput = path.resolve(value);
      index += 1;
    }
  }

  if (!args.startFnStableId || !args.endFnStableId) {
    throw new Error('Pass --start-fn-stable-id and --end-fn-stable-id.');
  }

  return args;
}

function sanitizeFileName(text) {
  const sanitized = String(text || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'feature-path';
}

function normalizeFnNode(node) {
  const stableId = node.properties.stableId;
  return {
    kind: 'Fn',
    stableId,
    name: node.properties.name || '<anonymous>',
    labels: node.labels,
    location: buildStableIdLocation({
      stableId,
      sourceStateId: node.properties.source_state_id,
      filePath: node.properties.file_path,
      repoRelativePath: node.properties.repo_relative_path,
      startLine: node.properties.start_line,
      startColumn: node.properties.start_column,
      endLine: node.properties.end_line,
      endColumn: node.properties.end_column,
      stableIdSuffix: node.properties.stableIdSuffix,
    }, { workspaceRoot }),
  };
}

function normalizeStepNode(node) {
  const stableId = node.properties.stableId;
  return {
    kind: 'Step',
    stableId,
    labels: node.labels,
    parentFnStableId: node.properties.parentFnStableId,
    label: node.properties.label,
    operationIndex: typeof node.properties.operation_index?.toNumber === 'function'
      ? node.properties.operation_index.toNumber()
      : Number(node.properties.operation_index),
    operationCode: node.properties.operation_code,
    operationSubjectText: node.properties.operation_subject_text,
    operationValueText: node.properties.operation_value_text,
    operationCalleeText: node.properties.operation_callee_text,
    actionText: node.properties.action_text_raw,
    conditionRaw: node.properties.condition_raw,
    location: buildStableIdLocation({
      stableId,
      sourceStateId: node.properties.source_state_id,
      filePath: node.properties.file_path,
      repoRelativePath: node.properties.repo_relative_path,
      startLine: node.properties.start_line,
      startColumn: node.properties.start_column,
      endLine: node.properties.end_line,
      endColumn: node.properties.end_column,
      stableIdSuffix: node.properties.stableIdSuffix,
    }, { workspaceRoot }),
  };
}

function normalizeGraphNode(node) {
  if (node.labels.includes('Fn')) {
    return normalizeFnNode(node);
  }

  return normalizeStepNode(node);
}

function normalizeGraphRelationship(rel) {
  return {
    type: rel.type,
    source: rel.properties.source,
    role: rel.properties.role,
    label: rel.properties.label,
    callTextRaw: rel.properties.call_text_raw,
  };
}

function buildStepText(step) {
  return [
    step.operationCalleeText,
    step.actionText,
    step.conditionRaw,
    step.operationSubjectText,
    step.operationValueText,
    step.label,
  ].filter(Boolean).join(' | ');
}

function getStepImportance(step, prevNode, nextNode) {
  let score = 0;
  const summary = buildStepText(step);

  if (prevNode?.kind === 'Fn' || nextNode?.kind === 'Fn') {
    score += 80;
  }
  if (step.operationCode === 'CALL') {
    score += 70;
  }
  if (step.operationCode === 'BRANCH' || step.conditionRaw) {
    score += 55;
  }
  if (step.operationCode === 'ACTION' || step.operationCode === 'ASSIGN') {
    score += 35;
  }
  if (KEYWORD_RE.test(summary)) {
    score += 60;
  }

  return score;
}

function summarizeStep(step) {
  const detail = buildStepText(step);
  if (!detail) {
    return step.operationCode || step.label || 'step';
  }

  return detail.length <= 160 ? detail : `${detail.slice(0, 157)}...`;
}

function pickImportantNodes(pathNodes) {
  return pathNodes.filter((node, index) => {
    if (node.kind === 'Fn') {
      return true;
    }

    const prevNode = pathNodes[index - 1];
    const nextNode = pathNodes[index + 1];
    return getStepImportance(node, prevNode, nextNode) >= 70;
  });
}

function buildImportantHighlights(pathNodes) {
  return pathNodes
    .map((node, index) => {
      if (node.kind === 'Fn') {
        return {
          stableId: node.stableId,
          kind: node.kind,
          name: node.name,
          reason: 'function-boundary',
          score: 100,
        };
      }

      const prevNode = pathNodes[index - 1];
      const nextNode = pathNodes[index + 1];
      const score = getStepImportance(node, prevNode, nextNode);
      if (score < 70) {
        return undefined;
      }

      let reason = 'important-step';
      if (prevNode?.kind === 'Fn' || nextNode?.kind === 'Fn') {
        reason = 'function-transition';
      } else if (node.operationCode === 'CALL') {
        reason = 'call-step';
      } else if (node.operationCode === 'BRANCH' || node.conditionRaw) {
        reason = 'decision-step';
      }

      return {
        stableId: node.stableId,
        kind: node.kind,
        summary: summarizeStep(node),
        reason,
        score,
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score)
    .slice(0, 16);
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '&#xa;');
}

function renderPathDrawio(payload) {
  const displayNodes = [];
  const importantNodeIds = new Set(payload.importantPathNodes.map((node) => node.stableId));

  let skippedSteps = 0;
  payload.path.nodes.forEach((node) => {
    if (importantNodeIds.has(node.stableId)) {
      if (skippedSteps) {
        displayNodes.push({
          kind: 'Gap',
          stableId: `gap-${displayNodes.length}`,
          label: `+${skippedSteps} intermediate steps`,
        });
        skippedSteps = 0;
      }
      displayNodes.push(node);
    } else {
      skippedSteps += 1;
    }
  });
  if (skippedSteps) {
    displayNodes.push({
      kind: 'Gap',
      stableId: `gap-${displayNodes.length}`,
      label: `+${skippedSteps} intermediate steps`,
    });
  }

  const nodeWidth = 980;
  const fnHeight = 92;
  const stepHeight = 76;
  const gapHeight = 44;
  const verticalGap = 26;
  const x = 40;
  let y = 120;
  const lines = [];

  const canvasHeight = 180 + displayNodes.reduce((acc, node) => acc + (node.kind === 'Fn' ? fnHeight : node.kind === 'Gap' ? gapHeight : stepHeight) + verticalGap, 0);
  const canvasWidth = 1120;

  lines.push('<mxfile host="app.diagrams.net" modified="2026-05-09T00:00:00.000Z" agent="GitHub Copilot" version="24.7.17">');
  lines.push(`<diagram id="${escapeXml(payload.featureSlug)}" name="Page-1">`);
  lines.push(`<mxGraphModel dx="${canvasWidth}" dy="${canvasHeight}" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${canvasWidth}" pageHeight="${Math.max(canvasHeight, 1600)}" math="0" shadow="0">`);
  lines.push('<root>');
  lines.push('<mxCell id="0" />');
  lines.push('<mxCell id="1" parent="0" />');
  lines.push(`<mxCell id="title" value="${escapeXml(`${payload.featureName} feature path\nsource: ${FUNCTION_FLOW_SOURCE}\nstart: ${payload.startFn.name}()\nend: ${payload.endFn.name}()`)}" style="text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;whiteSpace=wrap;rounded=0;fontSize=16;fontStyle=1;" vertex="1" parent="1"><mxGeometry x="20" y="20" width="1000" height="88" as="geometry" /></mxCell>`);

  const cellIds = [];
  for (const node of displayNodes) {
    let height = stepHeight;
    let value = '';
    let style = 'rounded=1;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#666666;fontColor=#000000;';

    if (node.kind === 'Fn') {
      height = fnHeight;
      value = `${node.name}()\n${node.location.repoRelativePath}\n${node.location.startLine}:${node.location.startColumn}-${node.location.endLine}:${node.location.endColumn}`;
      const isEndpoint = node.stableId === payload.startFn.stableId || node.stableId === payload.endFn.stableId;
      style = `rounded=1;whiteSpace=wrap;html=1;fillColor=${isEndpoint ? '#b7e1cd' : '#dae8fc'};strokeColor=${isEndpoint ? '#3d7a57' : '#6c8ebf'};fontColor=#000000;fontStyle=1;`;
    } else if (node.kind === 'Gap') {
      height = gapHeight;
      value = node.label;
      style = 'rounded=1;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;fontColor=#000000;dashed=1;';
    } else {
      height = stepHeight;
      value = `${node.operationCode || node.label || 'STEP'}\n${summarizeStep(node)}`;
      style = 'rounded=1;whiteSpace=wrap;html=1;fillColor=#fce5cd;strokeColor=#c27c0e;fontColor=#000000;';
    }

    lines.push(`<mxCell id="${escapeXml(node.stableId)}" value="${escapeXml(value)}" style="${style}" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${nodeWidth}" height="${height}" as="geometry" /></mxCell>`);
    cellIds.push(node.stableId);
    y += height + verticalGap;
  }

  for (let index = 0; index < cellIds.length - 1; index += 1) {
    lines.push(`<mxCell id="edge-${index}" value="" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;strokeColor=#4d4d4d;" edge="1" parent="1" source="${escapeXml(cellIds[index])}" target="${escapeXml(cellIds[index + 1])}"><mxGeometry relative="1" as="geometry" /></mxCell>`);
  }

  lines.push('</root>');
  lines.push('</mxGraphModel>');
  lines.push('</diagram>');
  lines.push('</mxfile>');
  return lines.join('');
}

async function queryFunctionRecord(session, stableId) {
  const result = await session.run(
    'MATCH (fn:Fn {stableId: $stableId}) RETURN fn LIMIT 1',
    { stableId },
  );
  const record = result.records[0]?.get('fn');
  if (!record) {
    throw new Error(`Function was not found in graph: ${stableId}`);
  }

  return normalizeFnNode(record);
}

async function queryShortestPath(session, startFnStableId, endFnStableId) {
  const result = await session.run(
    `
      MATCH (start:Fn {stableId: $startFnStableId}), (finish:Fn {stableId: $endFnStableId})
      MATCH path = shortestPath((start)-[:NEXT|TRUE|FALSE|OPTION_CASE|OPTION_DEFAULT|REJOINS|MERGES_TO*]->(finish))
      WHERE all(rel IN relationships(path) WHERE rel.source = $source)
      RETURN nodes(path) AS nodes, relationships(path) AS rels
    `,
    {
      startFnStableId,
      endFnStableId,
      source: FUNCTION_FLOW_SOURCE,
    },
  );

  const record = result.records[0];
  if (!record) {
    return undefined;
  }

  return {
    nodes: record.get('nodes').map((node) => normalizeGraphNode(node)),
    rels: record.get('rels').map((rel) => normalizeGraphRelationship(rel)),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  config({ path: path.join(workspaceRoot, 'graph', '.env') });

  const driver = neo4j.driver(
    process.env.NEO4J_URI,
    neo4j.auth.basic(process.env.NEO4J_USER || process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD),
  );
  const database = process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j';
  const session = driver.session({ database });

  try {
    const startFn = await queryFunctionRecord(session, args.startFnStableId);
    const endFn = await queryFunctionRecord(session, args.endFnStableId);
    const pathResult = await queryShortestPath(session, args.startFnStableId, args.endFnStableId);

    if (!pathResult) {
      throw new Error(`No directed function-flow path was found between ${args.startFnStableId} and ${args.endFnStableId}.`);
    }

    const featureSlug = sanitizeFileName(args.featureName);
    const importantPathNodes = pickImportantNodes(pathResult.nodes);
    const payload = {
      schema: { kind: 'feature-fn-step-path', version: 1 },
      generatedAt: new Date().toISOString(),
      source: FUNCTION_FLOW_SOURCE,
      featureName: args.featureName,
      featureSlug,
      startFn,
      endFn,
      path: {
        nodeCount: pathResult.nodes.length,
        edgeCount: pathResult.rels.length,
        nodes: pathResult.nodes,
        rels: pathResult.rels,
      },
      importantPathNodes,
      keyHighlights: buildImportantHighlights(pathResult.nodes),
    };

    const output = args.output || path.join(workspaceRoot, 'graph', `${featureSlug}.drawio`);
    const jsonOutput = args.jsonOutput || path.join(workspaceRoot, 'graph', `${featureSlug}.json`);
    mkdirSync(path.dirname(output), { recursive: true });
    mkdirSync(path.dirname(jsonOutput), { recursive: true });
    writeFileSync(jsonOutput, `${JSON.stringify(payload, undefined, 2)}\n`);
    writeFileSync(output, `${renderPathDrawio(payload)}\n`);

    process.stdout.write(`Wrote ${payload.path.nodeCount} path nodes and ${payload.path.edgeCount} path edges to ${jsonOutput}\n`);
    process.stdout.write(`Wrote draw.io path diagram to ${output}\n`);
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

