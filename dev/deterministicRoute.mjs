import { config } from 'dotenv';
import neo4j from 'neo4j-driver';
import { startDeterministicRoute, readDeterministicRoute, nextDeterministicRoute } from '../graph/packages/orchestrator/src/orchestrator/deterministicRoute.js';

const [command, id, revision] = process.argv.slice(2);
if (!['start', 'read', 'next', 'run'].includes(command) || !id)
  throw new Error('Usage: node dev/deterministicRoute.mjs start|run <stableId> | read <runId> | next <runId> <revision>');
config({ path: new URL('../graph/.env', import.meta.url), quiet: true });
const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(
  process.env.NEO4J_USER || process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD));
const database = process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j';
try {
  let plan = command === 'start' || command === 'run'
    ? await startDeterministicRoute(driver, database, { stableId: id })
    : command === 'read' ? await readDeterministicRoute(driver, database, id)
      : await nextDeterministicRoute(driver, database, { runId: id, expectedRevision: Number(revision) });
  while (command === 'run' && plan.status === 'PAUSED') {
    plan = await nextDeterministicRoute(driver, database, { runId: plan.runId, expectedRevision: plan.revision });
  }
  console.log(JSON.stringify(plan, null, 2));
} finally { await driver.close(); }
