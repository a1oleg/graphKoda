import path from 'node:path';
import process from 'node:process';

import { config as loadDotEnv } from 'dotenv';
import neo4j from 'neo4j-driver';

import {
  resolveAnnotation,
  selectNextAnnotationTask,
} from '../graph/packages/orchestrator/src/orchestrator/annotationResolver.js';

const DEFAULT_FUNCTION_STABLE_ID = 'screens/REPL.tsx:3142:31:3533:3';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function asNumber(value) {
  return neo4j.isInt(value) ? value.toNumber() : Number(value || 0);
}

async function annotationCount(driver, database) {
  const session = driver.session({ database });
  try {
    const result = await session.run('MATCH (annotation:Annotation) RETURN count(annotation) AS count');
    return asNumber(result.records[0]?.get('count'));
  } finally {
    await session.close();
  }
}

loadDotEnv({ path: path.join(process.cwd(), 'graph', '.env'), quiet: true });

const uri = process.env.NEO4J_URI;
const user = process.env.NEO4J_USER || process.env.NEO4J_USERNAME;
const password = process.env.NEO4J_PASSWORD;
const database = process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j';
if (!uri || !user || !password) {
  throw new Error('NEO4J_URI, NEO4J_USER/NEO4J_USERNAME and NEO4J_PASSWORD are required in graph/.env.');
}

const stableId = argument('--fn-stable-id', DEFAULT_FUNCTION_STABLE_ID);
const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));

try {
  const before = await annotationCount(driver, database);
  const result = await resolveAnnotation(driver, database, {
    stableId,
    maxDepth: 3,
    persist: false,
  });
  const after = await annotationCount(driver, database);
  const kinds = Object.fromEntries(result.generationOrder.reduce((counts, item) => {
    counts.set(item.annotationKind, (counts.get(item.annotationKind) || 0) + 1);
    return counts;
  }, new Map()));
  const binding = result.generationOrder.find((item) => item.annotationKind === 'Binding');
  const temporal = binding
    ? await resolveAnnotation(driver, database, {
        stableId: binding.stableId,
        atOperationIndex: binding.context?.history?.at(-1)?.operationIndex,
        maxDepth: 0,
        persist: false,
      })
    : null;

  if (result.root?.annotationKind !== 'Callable') throw new Error(`Expected Callable root, got ${result.root?.annotationKind || 'none'}.`);
  if (!result.root?.context?.steps?.length) throw new Error('Callable context has no execution steps.');
  if (!selectNextAnnotationTask(result.generationOrder)) throw new Error('Resolver produced no executable first annotation task.');
  if (before !== after) throw new Error(`Dry-run changed Annotation count: ${before} -> ${after}.`);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    stableId,
    profileId: result.root.profileId,
    steps: result.root.context.steps.length,
    generationOrder: result.generationOrder.length,
    generationKinds: kinds,
    temporalBinding: temporal ? {
      stableId: temporal.root.stableId,
      historyEntries: temporal.root.context?.history?.length || 0,
      atOperationIndex: temporal.diagnostics.atOperationIndex,
    } : null,
    annotationsBefore: before,
    annotationsAfter: after,
    milliseconds: result.diagnostics.totalMilliseconds,
  }, null, 2)}\n`);
} finally {
  await driver.close();
}
