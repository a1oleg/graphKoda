import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { config as loadDotEnv } from 'dotenv';
import neo4j from 'neo4j-driver';

import {
  loadFunctionalSegment,
  loadFunctionalSegmentWithoutAnnotations,
  renderFunctionalSegmentDrawio,
} from '../graph/packages/orchestrator/src/orchestrator/functionalSegmentDrawio.js';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

loadDotEnv({ path: path.join(process.cwd(), 'graph', '.env'), quiet: true });
const outputPath = path.resolve(argument('--output'));
const rootStableId = String(argument('--stable-id') || '').trim();
if (!rootStableId) throw new Error('--stable-id is required.');
if (!argument('--output')) throw new Error('--output is required.');

const uri = process.env.NEO4J_URI;
const user = process.env.NEO4J_USER || process.env.NEO4J_USERNAME;
const password = process.env.NEO4J_PASSWORD;
const database = process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j';
if (!uri || !user || !password) throw new Error('Neo4j credentials are required in graph/.env.');

const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
try {
  const segment = process.argv.includes('--without-annotations')
    ? await loadFunctionalSegmentWithoutAnnotations(driver, database, rootStableId)
    : await loadFunctionalSegment(driver, database, rootStableId);
  const rendered = renderFunctionalSegmentDrawio(segment);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, rendered.xml, 'utf8');
  process.stdout.write(`${JSON.stringify({
    ok: true,
    outputPath,
    rootStableId,
    nodeCount: segment.nodes.length,
    edgeCount: segment.edges.length,
    width: rendered.width,
    height: rendered.height,
  })}\n`);
} finally {
  await driver.close();
}
