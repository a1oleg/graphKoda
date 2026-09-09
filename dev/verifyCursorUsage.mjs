import assert from 'node:assert/strict';
import { config } from 'dotenv';
import neo4j from 'neo4j-driver';
import { inspectValueUsage } from '../graph/packages/orchestrator/src/orchestrator/valueUsage.js';

config({ path: 'graph/.env', quiet: true });
const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(
  process.env.NEO4J_USER || process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD));
const session = driver.session({ database: process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j', defaultAccessMode: 'READ' });
try {
  const target = await session.run(`MATCH (n)-[r:READS_FROM]->(receiver)
    WHERE n.stableId STARTS WITH 'components/TextInput.tsx:114:' AND r.propertyName='cursorOffset'
    RETURN n.stableId AS id`);
  assert.equal(target.records.length, 1);
  const targetId = target.records[0].get('id');
  const queue = [{ stableId: 'components/PromptInput/PromptInput.tsx:2195:4:2195:16',
    context: { selection: 'usage', frames: [], memberPath: [] }, path: [] }];
  const visited = new Set();
  let found;
  while (queue.length && visited.size < 150) {
    const item = queue.shift();
    const key = JSON.stringify([item.stableId, item.context.memberPath, item.context.frames]);
    if (visited.has(key)) continue;
    visited.add(key);
    if (item.stableId === targetId) { found = item; break; }
    if (item.path.length >= 14) continue;
    const result = await inspectValueUsage(session, item);
    if (process.env.DEBUG_CURSOR_USAGE === '1') console.log(JSON.stringify({ id: item.stableId,
      memberPath: item.context.memberPath, children: result.children.map(c => ({ id: c.stableId, memberPath: c.context.memberPath })) }));
    for (const child of result.children) {
      if (child.unresolved) continue;
      queue.push({ ...child, path: [...item.path, { from: item.stableId, to: child.stableId,
        relation: child.relation, memberPath: child.context.memberPath }] });
    }
  }
  assert.ok(found, `Selected field did not reach TextInput.props.cursorOffset; inspected=${visited.size}`);
  console.log(JSON.stringify({ ok: true, inspected: visited.size, path: found.path, fullCursorRouteVerified: false }, null, 2));
} finally { await session.close(); await driver.close(); }
