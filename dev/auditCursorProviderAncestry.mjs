import assert from 'node:assert/strict';
import fs from 'node:fs';
import { config } from 'dotenv';
import neo4j from 'neo4j-driver';
import { findContextProviders } from '../graph/packages/orchestrator/src/orchestrator/valueUsage.js';

config({ path: 'graph/.env', quiet: true });
const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(
  process.env.NEO4J_USER || process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD));
const session = driver.session({ database: process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j', defaultAccessMode: 'READ' });
try {
  // Explicitly selected test invocation chain, not a production dispatch heuristic.
  const calls = ['components/PromptInput/PromptInput.tsx:2243:130:2243:158',
    'components/TextInput.tsx:121:6:121:181', 'components/BaseTextInput.tsx:53:20:53:41'];
  const frames = [];
  for (const callSiteId of calls) {
    const result = await session.run(`MATCH (call:Call {stableId:$id})-[:CALLS]->(fn)-[r:HAS_PARAMETER]->(parameter)
      WHERE r.index=0
      RETURN DISTINCT parameter.stableId AS parameterId`, { id: callSiteId });
    assert.equal(result.records.length, 1, `Missing/ambiguous call frame: ${callSiteId}`);
    frames.push({ callSiteId, parameterId: result.records[0].get('parameterId') });
  }
  const result = await findContextProviders(session, 'ink/hooks/use-declared-cursor.ts:34:31:34:67',
    'ink/components/CursorDeclarationContext.ts:28:6:30:1', 24, frames);
  fs.mkdirSync('tmp', { recursive: true });
  fs.writeFileSync('tmp/cursor-provider-ancestry.json', JSON.stringify({ frames, ...result }, null, 2), 'utf8');
  const paths = [...result.providers, ...result.gaps].map(entry => entry.path || []);
  assert.ok(paths.some(path => path.some(edge => edge.relation === 'BINDS_TO_PARAMETER'
    && edge.to === 'interactiveHelpers.tsx:99:47:99:71')), 'Missing JSX transfer into renderAndRun');
  assert.ok(paths.every(path => path.every(edge => edge.to !== 'main.tsx:1006:542:3808:3')),
    'Command registration is not component ancestry');
  console.log(JSON.stringify({ providers: result.providers.map(p => p.providerId),
    gaps: result.gaps.map(g => ({ id: g.id, reason: g.reason })), report: 'tmp/cursor-provider-ancestry.json' }, null, 2));
} finally { await session.close(); await driver.close(); }
