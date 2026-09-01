import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import dotenv from 'dotenv';
import neo4j from 'neo4j-driver';

const workspaceRoot = process.cwd();
const source = 'semantic/phaseGraph';

dotenv.config({ path: path.join(workspaceRoot, 'graph', '.env') });

function normalizeNeo4jUri(uri) {
  return String(uri || '')
    .replace('neo4j://localhost', 'bolt://localhost')
    .replace('neo4j://127.0.0.1', 'bolt://127.0.0.1');
}

function runExtractor(outputPath) {
  const extractorPath = path.join(workspaceRoot, 'graph', 'static-extract', 'ts', 'phaseGraph.ts');
  const definitionsPath = path.join(workspaceRoot, 'graph', 'phases.json');
  const tsxCliPath = path.join(workspaceRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const result = spawnSync(
    process.execPath,
    [tsxCliPath, extractorPath, '--definitions-path', definitionsPath, '--output-path', outputPath],
    {
      cwd: workspaceRoot,
      encoding: 'utf8',
      windowsHide: true,
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`phaseGraph extractor failed:\n${result.stderr || result.stdout}`);
  }
}

async function clearPrevious(session) {
  await session.executeWrite(async (tx) => {
    await tx.run(
      `
        MATCH ()-[rel]->()
        WHERE rel.source = $source
        DELETE rel
      `,
      { source },
    );
    await tx.run(
      `
        MATCH (phase:Phase {source: $source})
        DETACH DELETE phase
      `,
      { source },
    );
  });
}

async function writePhases(session, phases) {
  await session.executeWrite(async (tx) => {
    await tx.run(
      `
        UNWIND $phases AS row
        MERGE (phase:Phase {key: row.key})
        SET phase.key = row.key,
            phase.label = row.label,
            phase.phase_kind = row.phaseKind,
            phase.feature_key = row.featureKey,
            phase.order = row.order,
            phase.direction = row.direction,
            phase.ownerFnStableId = row.ownerFnStableId,
            phase.headStepStableId = row.headStepStableId,
            phase.tailStepStableId = row.tailStepStableId,
            phase.source = $source
        WITH phase, row
        MATCH (owner:Fn {stableId: row.ownerFnStableId})
        MERGE (owner)-[ownerRel:HAS_PHASE]->(phase)
        SET ownerRel.source = $source,
            ownerRel.direction = row.direction
        WITH phase, row
        MATCH (head {stableId: row.headStepStableId})
        MATCH (tail {stableId: row.tailStepStableId})
        MERGE (phase)-[headRel:HEADS_AT]->(head)
        SET headRel.source = $source,
            headRel.boundary_role = 'head'
        MERGE (phase)-[tailRel:TAILS_AT]->(tail)
        SET tailRel.source = $source,
            tailRel.boundary_role = 'tail'
        MERGE (head)-[flowRel:PHASE_FLOWS_TO]->(tail)
        SET flowRel.source = $source,
            flowRel.phase_key = row.key,
            flowRel.direction = row.direction
      `,
      { phases, source },
    );

    await tx.run(
      `
        UNWIND $phases AS row
        MATCH (phase:Phase {key: row.key})
        UNWIND row.boundaries AS boundary
        MATCH (step:Step {stableId: boundary.stableId})
        MERGE (step)-[rel:EVIDENCES_PHASE]->(phase)
        SET rel.source = $source,
            rel.boundary_role = boundary.role,
            rel.callee_text = boundary.calleeText,
            rel.evidence_text = boundary.actionText
      `,
      { phases, source },
    );
  });
}

async function main() {
  const tempPath = path.join(os.tmpdir(), `phases-${Date.now()}.json`);
  try {
    runExtractor(tempPath);
    const payload = JSON.parse(fs.readFileSync(tempPath, 'utf8'));
    if (payload.errors?.length) {
      throw new Error(`phaseGraph extractor returned errors:\n${payload.errors.join('\n')}`);
    }

    const uri = normalizeNeo4jUri(process.env.NEO4J_URI);
    const user = process.env.NEO4J_USER || process.env.NEO4J_USERNAME;
    const password = process.env.NEO4J_PASSWORD;
    const database = process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j';
    const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
    const session = driver.session({ database });
    try {
      await clearPrevious(session);
      await writePhases(session, payload.phases || []);
    } finally {
      await session.close();
      await driver.close();
    }

    console.log(`Imported ${payload.phases?.length || 0} phase(s) into Neo4j.`);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

