import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function sanitizeFileName(text) {
  const sanitized = String(text || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'function-flow';
}

function parseRendererSummary(output) {
  const match = String(output || '').match(/Wrote\s+(\d+)\s+flow nodes,\s+(\d+)\s+resources,\s+(\d+)\s+target Fns and\s+(\d+)\s+edges/i);
  if (!match) {
    return {};
  }

  return {
    flowNodeCount: Number(match[1]),
    resourceNodeCount: Number(match[2]),
    targetFnCount: Number(match[3]),
    edgeCount: Number(match[4]),
  };
}

export function buildFunctionFlowDrawDiagram({
  fnStableId,
  outputPath,
  source = 'semantic/functionFlowGraph',
  rangeStart,
  rangeEnd,
  stageLabel,
} = {}) {
  if (!fnStableId) {
    throw new Error('fnStableId is required for function-flow draw.');
  }

  const workspaceRoot = process.cwd();
  const rendererPath = path.join(workspaceRoot, 'graph', 'static-extract', 'py', 'function_flow_drawio.py');
  const resolvedOutputPath = path.resolve(
    workspaceRoot,
    outputPath || path.join('graph', 'draw', `${sanitizeFileName(`${fnStableId}-function-flow`)}.drawio`),
  );
  const args = [
    rendererPath,
    '--fn-stable-id',
    fnStableId,
    '--source',
    source,
    '--output',
    resolvedOutputPath,
  ];
  if (Number.isFinite(Number(rangeStart))) {
    args.push('--range-start', String(Number(rangeStart)));
  }
  if (Number.isFinite(Number(rangeEnd))) {
    args.push('--range-end', String(Number(rangeEnd)));
  }
  if (stageLabel) {
    args.push('--stage-label', String(stageLabel));
  }

  const result = spawnSync(
    'python',
    args,
    {
      cwd: workspaceRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000,
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `Function-flow renderer exited with ${result.status}.`);
  }

  const drawioXml = fs.existsSync(resolvedOutputPath)
    ? fs.readFileSync(resolvedOutputPath, 'utf8')
    : null;
  const summary = parseRendererSummary(`${result.stdout}\n${result.stderr}`);

  return {
    available: true,
    error: null,
    saved: Boolean(drawioXml),
    filePath: resolvedOutputPath,
    format: 'drawio',
    fnStableId,
    source,
    rangeStart: Number.isFinite(Number(rangeStart)) ? Number(rangeStart) : null,
    rangeEnd: Number.isFinite(Number(rangeEnd)) ? Number(rangeEnd) : null,
    stageLabel: stageLabel || null,
    drawioXml,
    stdout: result.stdout,
    stderr: result.stderr,
    ...summary,
  };
}


