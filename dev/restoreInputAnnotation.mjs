import fs from 'node:fs';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import neo4j from 'neo4j-driver';
import { insertDrawioAnnotation } from '../graph/packages/orchestrator/src/orchestrator.js';
import { Fragment } from '../graph/packages/orchestrator/src/orchestrator/fragment.js';

const recovered = JSON.parse(fs.readFileSync('tmp/input-annotation-recovered.json', 'utf8'));
const diagramPath = 'graph/draw/generated/onSubmit-REPL.tsx-3142.drawio';
fs.copyFileSync(diagramPath, 'tmp/onSubmit-before-input-annotation.drawio');
const inserted = insertDrawioAnnotation({ diagramPath, element: { cellId: 'n2' },
  annotationText: recovered.text, replaceExistingForTarget: true,
  annotationMetadata: { toolGitCommitShortHash: recovered.toolGitCommitShortHash, maxDepth: Number(recovered.maxDepth) } });
console.log(JSON.stringify({ diagram: inserted }));
const env = dotenv.parse(fs.readFileSync('graph/.env'));
const driver = neo4j.driver(env.NEO4J_URI || 'bolt://127.0.0.1:7687',
  neo4j.auth.basic(env.NEO4J_USERNAME || env.NEO4J_USER || 'neo4j', env.NEO4J_PASSWORD), { connectionTimeout: 3000 });
const database = env.NEO4J_DATABASE || env.NEO4J_DB || 'neo4j';
try {
  const result = await new Fragment({ driver, database, headID: recovered.stableId })
    .upsertAnnotation(recovered.text, { source: `git-restore:${recovered.commit}`, maxDepth: Number(recovered.maxDepth) });
  assert.equal(result.updated, 1);
  const session = driver.session({ database });
  try {
    const verified = await session.run(`MATCH (head {stableId:$id})-[:HAS_ANNOTATION]->(a:Annotation)
      WHERE a.text=$text SET a.toolGitCommitShortHash=$hash, a.maxDepth=$depth
      RETURN a.text AS text, a.toolGitCommitShortHash AS hash`, {
      id: recovered.stableId, text: recovered.text, hash: recovered.toolGitCommitShortHash, depth: Number(recovered.maxDepth),
    });
    assert(verified.records.length > 0);
    console.log(JSON.stringify({ database: 'restored', verified: verified.records.length }));
  } finally { await session.close(); }
} finally { await driver.close(); }
