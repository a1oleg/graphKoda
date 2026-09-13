import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const file = fileURLToPath(new URL('../graph/draw/generated/Fisher-Yates.drawio', import.meta.url));
const server = fileURLToPath(new URL('../../drawio-inspector/src/mcp.mjs', import.meta.url));
const client = new Client({ name: 'fisher-layout-audit', version: '1.0.0' });
const prefix = 'examples/fisher-yates/src/shuffle.ts:';
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server] }));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: { file, mode: 'rendered', limit: 500, ...args } },
      undefined, { timeout: 180000 });
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return result.structuredContent;
  };
  const region = await call('inspect_region', { stableId: `${prefix}5:2:8:3:for`, padding: 10000 });
  const validation = await call('validate_geometry', {});
  if (region.truncated || validation.truncated) throw new Error('Incomplete MCP report');
  const vertex = (suffix, label) => region.elements.find(e => e.kind === 'vertex'
    && e.stableId === prefix + suffix && (label === undefined || e.label === label));
  const start = vertex('1:7:11:1:flow-start', 'Start');
  const entry = vertex('5:2:8:3:for', 'for');
  const initial = vertex('5:11:5:15', 'last');
  const condition = vertex('5:39:5:47', '');
  const update = vertex('5:49:5:55', 'last');
  const returned = vertex('10:2:10:18:return', '');
  const repeat = region.elements.find(e => e.kind === 'edge' && e.edgeType === 'REPEATS'
    && e.stableId === `${prefix}5:49:5:55`);
  const parentIds = new Set(region.elements.map(e => e.parent));
  const namespace = entry.cellId.slice(0, entry.cellId.indexOf('-') + 1);
  const loopRight = Math.max(...region.elements.filter(e => e.kind === 'vertex'
    && e.cellId.startsWith(namespace) && !parentIds.has(e.cellId)
    && e.bounds.y >= initial.bounds.y - 100 && e.bounds.y <= update.bounds.y + update.bounds.height)
    .map(e => e.bounds.x + e.bounds.width));
  const center = e => e.bounds.x + e.bounds.width / 2;
  const checks = {
    forOnMainAxis: Math.abs(center(entry) - center(start)) < 2,
    initializationToRight: initial.bounds.x > entry.bounds.x + entry.bounds.width,
    conditionAfterInitialization: condition.bounds.y > initial.bounds.y + initial.bounds.height,
    updateAfterCondition: update.bounds.y > condition.bounds.y + condition.bounds.height,
    returnBelowLoopOnMainAxis: returned.bounds.y > update.bounds.y + update.bounds.height
      && Math.abs(center(returned) - center(start)) < 2,
    noNodeIntersections: !validation.findings.some(f => f.rule === 'edge-crosses-node'),
    repeatOutsideRight: repeat.route.some((point, index, points) => index > 0
      && Math.abs(point.x - points[index - 1].x) < 0.5 && point.x > loopRight
      && Math.abs(point.y - points[index - 1].y) > 100),
    noGeometryFindings: validation.totalFindings === 0,
  };
  const output = fileURLToPath(new URL('../tmp/fisher-yates/mcp-audit.json', import.meta.url));
  fs.mkdirSync(fileURLToPath(new URL('../tmp/fisher-yates', import.meta.url)), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ checks, region, validation }, null, 2));
  console.log(JSON.stringify({ checks, findings: validation.findings, output }, null, 2));
  if (Object.values(checks).some(ok => !ok)) process.exitCode = 1;
} finally {
  await client.close();
}
