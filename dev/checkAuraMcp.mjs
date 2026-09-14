import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const client = new Client({ name: 'coldkode-aura-check', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: path.join(root, '.venv/Scripts/python.exe'),
  args: [path.join(root, 'graph/mcp/neo4j_mcp_server.py'), '--profile', 'aura'],
  cwd: root, stderr: 'pipe',
});
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert(tools.some(t => t.name === 'neo4j_run_read_query'));
  assert(!tools.some(t => /materialize|invoke/.test(t.name)));
  const result = await client.callTool({ name: 'neo4j_run_read_query', arguments: {
    query: 'MATCH (n {stableId: $id})-[r]-(m) RETURN type(r) AS relation, m.stableId AS neighbor, labels(m) AS labels',
    parameters_json: JSON.stringify({ id: 'examples/fisher-yates/src/shuffle.ts:2:8:2:16' }),
    limit: 20,
  } });
  assert(!result.isError, JSON.stringify(result.content));
  const payload = result.structuredContent || JSON.parse(result.content.find(c => c.type === 'text').text);
  assert(payload.recordCount > 0, 'Alphabet has no neighbors in the configured Aura database');
  console.log(JSON.stringify({ transport: 'mcp-stdio', tools: tools.map(t => t.name), result: payload }, null, 2));
} finally {
  await client.close();
  await transport.close();
}
