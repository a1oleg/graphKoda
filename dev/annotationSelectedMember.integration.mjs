// Read-only regression against the imported source graph; no fabricated graph.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import dotenv from 'dotenv';
import neo4j from 'neo4j-driver';
import { resolveAnnotation } from '../graph/packages/orchestrator/src/orchestrator/annotationResolver.js';

const env = dotenv.parse(fs.readFileSync(new URL('../graph/.env', import.meta.url)));
const database = env.NEO4J_DATABASE || env.NEO4J_DB || 'neo4j';
const driver = neo4j.driver(env.NEO4J_URI, neo4j.auth.basic(env.NEO4J_USER || env.NEO4J_USERNAME, env.NEO4J_PASSWORD));
try {
  const result = await resolveAnnotation(driver, database, {
    stableId: 'services/api/claude.ts:1052:4:1052:39', maxDepth: 4, persist: false,
  });
  const root = result.root;
  assert.equal(root.context.callText, 'isNonCustomOpusModel(options.model)');
  assert.deepEqual(root.context.memberAccesses, []);
  assert.deepEqual(root.context.relatedMemberUses, []);
  assert(!root.dependencies.some(d => d.stableId === 'services/api/claude.ts:1028:2:1028:18'));
  const selection = root.dependencies.find(d => d.annotationKind === 'MemberProjection');
  assert(selection);
  assert.equal(selection.context.selectedProperty, 'model');
  assert(selection.context.selections.every(s => s.propertyName === 'model'));
  assert(selection.context.unresolved.every(s => s.propertyName === 'model'));
  assert(root.dependencies.some(d => d.stableId === 'utils/model/model.ts:40:7:47:1'));
  assert(selection.context.selections.length > 0, 'must reach actual model fields through destructured wrapper arguments');
  assert(selection.context.selections.some(s => s.evidencePath.nodeIds.includes('services/api/claude.ts:720:2:720:9')));
  assert(selection.context.selections.some(s => s.evidencePath.nodeIds.includes('services/api/claude.ts:763:2:763:9')));
  assert(!result.generationOrder.some(d => /:156:44:156:75|:667:16:667:61|:1310:12:1310:50/.test(d.stableId)), 'unrelated permission callbacks must remain excluded');
  console.log(JSON.stringify({ tasks: result.generationOrder.length, selectedProperty: selection.context.selectedProperty,
    unresolved: selection.context.unresolved, status: 'passed' }, null, 2));
} finally {
  await driver.close();
}
