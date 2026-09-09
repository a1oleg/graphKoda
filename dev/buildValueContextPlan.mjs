import fs from 'node:fs';
import { config } from 'dotenv';
import neo4j from 'neo4j-driver';
import { readValueOrigin } from '../graph/packages/orchestrator/src/orchestrator/valueOrigin.js';
import { buildValueContextPlan, saveValueContextPlan } from '../graph/packages/orchestrator/src/orchestrator/valueContextPlan.js';

const [runId, targetStableId] = process.argv.slice(2);
if (!runId || !targetStableId) throw new Error('Usage: node dev/buildValueContextPlan.mjs <runId> <targetStableId>');
config({ path: 'graph/.env', quiet: true });
const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(
  process.env.NEO4J_USER || process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD));
const database = process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j';
const session = driver.session({ database });
try {
  const source = await readValueOrigin(driver, database, runId);
  const plan = buildValueContextPlan(source, targetStableId);
  const planId = await saveValueContextPlan(session, plan);
  fs.mkdirSync('tmp/value-context-plans', { recursive: true });
  fs.writeFileSync(`tmp/value-context-plans/${planId}.json`, JSON.stringify(plan, null, 2), 'utf8');
  console.log(JSON.stringify({ planId, ...plan.stats, status: plan.status,
    nodes: plan.nodes.map(n => ({ id: n.stableId, states: n.states })) }, null, 2));
} finally { await session.close(); await driver.close(); }
