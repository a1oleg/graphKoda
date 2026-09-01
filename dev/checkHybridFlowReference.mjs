import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import neo4j from 'neo4j-driver';
import {
  createNeo4jDriver,
  describeNeo4jProfile,
  loadActualGraphProfile,
  loadGoldenAuraProfile,
} from './hybridFlowNeo4jProfiles.mjs';

const workspaceRoot = process.cwd();

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    modelId: 'on-submit-hybrid-flow-v1',
    scenarioId: undefined,
    auraEnvPath: path.join(workspaceRoot, 'graph', '.env.aura'),
    actualEnvPath: path.join(workspaceRoot, 'graph', '.env'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--model') {
      args.modelId = argv[index + 1];
      index += 1;
    } else if (arg === '--scenario') {
      args.scenarioId = argv[index + 1];
      index += 1;
    } else if (arg === '--aura-env') {
      args.auraEnvPath = path.resolve(workspaceRoot, argv[index + 1]);
      index += 1;
    } else if (arg === '--actual-env') {
      args.actualEnvPath = path.resolve(workspaceRoot, argv[index + 1]);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node dev/checkHybridFlowReference.mjs [--model <id>] [--scenario <id>] '
        + '[--aura-env <path>] [--actual-env <path>]',
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function asNumber(value) {
  return neo4j.isInt(value) ? value.toNumber() : Number(value || 0);
}

async function main() {
  const args = parseArgs();
  const referenceProfile = loadGoldenAuraProfile(args.auraEnvPath);
  const actualProfile = loadActualGraphProfile(args.actualEnvPath);
  const referenceDriver = createNeo4jDriver(referenceProfile);
  const actualDriver = createNeo4jDriver(actualProfile);
  const referenceSession = referenceDriver.session({
    database: referenceProfile.database,
    defaultAccessMode: neo4j.session.READ,
  });
  const actualSession = actualDriver.session({
    database: actualProfile.database,
    defaultAccessMode: neo4j.session.READ,
  });

  try {
    const scenarioResult = await referenceSession.run(`
      MATCH (model:GoldenModel {modelId: $modelId})-[:HAS_GOLDEN_SCENARIO]->(scenario:GoldenScenario)
      WHERE $scenarioId IS NULL OR scenario.scenarioId = $scenarioId
      RETURN scenario.scenarioId AS scenarioId,
             scenario.title AS title,
             scenario.protocol AS protocol,
             scenario.sourceSpan AS sourceSpan,
             model.functionStableId AS functionStableId,
             model.sourceDrawio AS sourceDrawio,
             model.sourceHash AS sourceHash
      ORDER BY scenario.scenarioId
    `, { modelId: args.modelId, scenarioId: args.scenarioId || null });
    const selectedScenarioIds = scenarioResult.records.map((record) => record.get('scenarioId'));
    const entityResult = await referenceSession.run(`
      MATCH (scenario:GoldenScenario {goldenModelId: $modelId})-[:HAS_GOLDEN_ENTITY]->(expected:GoldenEntity)
      WHERE scenario.scenarioId IN $scenarioIds
      RETURN scenario.scenarioId AS scenarioId,
             expected.role AS role,
             expected.semanticKind AS semanticKind,
             expected.actualStableId AS stableId,
             expected.labelsAll AS labelsAll,
             expected.propertiesJson AS propertiesJson
      ORDER BY scenarioId, role
    `, { modelId: args.modelId, scenarioIds: selectedScenarioIds });
    const relationResult = await referenceSession.run(`
      MATCH (scenario:GoldenScenario {goldenModelId: $modelId})-[:HAS_GOLDEN_RELATION]->(expected:GoldenRelation)
      MATCH (expected)-[:FROM_GOLDEN_ENTITY]->(source:GoldenEntity)
      MATCH (expected)-[:TO_GOLDEN_ENTITY]->(target:GoldenEntity)
      WHERE scenario.scenarioId IN $scenarioIds
      RETURN scenario.scenarioId AS scenarioId,
             expected.fromRole AS fromRole,
             expected.type AS type,
             expected.toRole AS toRole,
             source.actualStableId AS sourceStableId,
             target.actualStableId AS targetStableId
      ORDER BY scenarioId, expected.goldenId
    `, { modelId: args.modelId, scenarioIds: selectedScenarioIds });
    const forbiddenResult = await referenceSession.run(`
      MATCH (scenario:GoldenScenario {goldenModelId: $modelId})
        -[:HAS_GOLDEN_FORBIDDEN_PATTERN]->(pattern:GoldenForbiddenPattern)
      WHERE scenario.scenarioId IN $scenarioIds
      RETURN scenario.scenarioId AS scenarioId,
             pattern.actualStableId AS stableId,
             pattern.reason AS reason
      ORDER BY scenarioId, pattern.goldenId
    `, { modelId: args.modelId, scenarioIds: selectedScenarioIds });
    const compositionResult = await referenceSession.run(`
      MATCH (scenario:GoldenScenario {goldenModelId: $modelId})
      WHERE scenario.scenarioId IN $scenarioIds
      OPTIONAL MATCH (scenario)-[:HAS_GOLDEN_CONSTRAINT]->(constraint:GoldenCompositionConstraint)
      OPTIONAL MATCH (scenario)-[:HAS_GOLDEN_LANE]->(lane:GoldenLane)
      RETURN scenario.scenarioId AS scenarioId,
             count(DISTINCT constraint) AS constraintCount,
             count(DISTINCT lane) AS laneCount
    `, { modelId: args.modelId, scenarioIds: selectedScenarioIds });

    const requiredStableIds = entityResult.records.map((record) => record.get('stableId'));
    const forbiddenStableIds = forbiddenResult.records.map((record) => record.get('stableId'));
    const inspectedStableIds = [...new Set([...requiredStableIds, ...forbiddenStableIds])];
    const actualNodeResult = await actualSession.run(`
      MATCH (actual)
      WHERE actual.stableId IN $stableIds
      RETURN actual.stableId AS stableId,
             labels(actual) AS labels,
             properties(actual) AS properties
    `, { stableIds: inspectedStableIds });
    const actualByStableId = new Map(actualNodeResult.records.map((record) => [
      record.get('stableId'),
      {
        labels: record.get('labels') || [],
        properties: record.get('properties') || {},
      },
    ]));
    const requiredSourceIds = [...new Set(relationResult.records.map((record) => record.get('sourceStableId')))];
    const requiredTargetIds = [...new Set(relationResult.records.map((record) => record.get('targetStableId')))];
    const actualRelationResult = await actualSession.run(`
      MATCH (source)-[relation]->(target)
      WHERE source.stableId IN $sourceStableIds
        AND target.stableId IN $targetStableIds
      RETURN source.stableId AS sourceStableId,
             type(relation) AS type,
             target.stableId AS targetStableId
    `, { sourceStableIds: requiredSourceIds, targetStableIds: requiredTargetIds });
    const actualRelationKeys = new Set(actualRelationResult.records.map((record) => [
      record.get('sourceStableId'),
      record.get('type'),
      record.get('targetStableId'),
    ].join('\u0000')));

    const entitiesByScenario = new Map();
    const relationsByScenario = new Map();
    const forbiddenByScenario = new Map();
    const compositionByScenario = new Map(compositionResult.records.map((record) => [
      record.get('scenarioId'),
      {
        constraints: asNumber(record.get('constraintCount')),
        lanes: asNumber(record.get('laneCount')),
      },
    ]));
    for (const record of entityResult.records) {
      const scenarioId = record.get('scenarioId');
      if (!entitiesByScenario.has(scenarioId)) entitiesByScenario.set(scenarioId, []);
      entitiesByScenario.get(scenarioId).push(record);
    }
    for (const record of relationResult.records) {
      const scenarioId = record.get('scenarioId');
      if (!relationsByScenario.has(scenarioId)) relationsByScenario.set(scenarioId, []);
      relationsByScenario.get(scenarioId).push(record);
    }
    for (const record of forbiddenResult.records) {
      const scenarioId = record.get('scenarioId');
      if (!forbiddenByScenario.has(scenarioId)) forbiddenByScenario.set(scenarioId, []);
      forbiddenByScenario.get(scenarioId).push(record);
    }

    const scenarios = [];
    for (const record of scenarioResult.records) {
      const scenarioId = record.get('scenarioId');
      const findings = [];
      const entityRecords = entitiesByScenario.get(scenarioId) || [];
      for (const entityRecord of entityRecords) {
        const role = entityRecord.get('role');
        const stableId = entityRecord.get('stableId');
        const labelsAll = entityRecord.get('labelsAll') || [];
        const actual = actualByStableId.get(stableId);
        if (!actual) {
          findings.push({
            kind: 'missing-entity',
            role,
            semanticKind: entityRecord.get('semanticKind'),
            stableId,
          });
          continue;
        }
        for (const label of labelsAll) {
          if (!actual.labels.includes(label)) {
            findings.push({
              kind: 'missing-label',
              role,
              stableId,
              expected: label,
              actual: actual.labels,
            });
          }
        }
        const expectedProperties = JSON.parse(entityRecord.get('propertiesJson') || '{}');
        for (const [key, expected] of Object.entries(expectedProperties)) {
          if (actual.properties[key] !== expected) {
            findings.push({
              kind: 'property-mismatch',
              role,
              stableId,
              property: key,
              expected,
              actual: actual.properties[key],
            });
          }
        }
      }
      for (const relationRecord of relationsByScenario.get(scenarioId) || []) {
        const relationKey = [
          relationRecord.get('sourceStableId'),
          relationRecord.get('type'),
          relationRecord.get('targetStableId'),
        ].join('\u0000');
        if (!actualRelationKeys.has(relationKey)) {
          findings.push({
            kind: 'missing-relation',
            fromRole: relationRecord.get('fromRole'),
            type: relationRecord.get('type'),
            toRole: relationRecord.get('toRole'),
            sourceStableId: relationRecord.get('sourceStableId'),
            targetStableId: relationRecord.get('targetStableId'),
          });
        }
      }
      for (const forbiddenRecord of forbiddenByScenario.get(scenarioId) || []) {
        const stableId = forbiddenRecord.get('stableId');
        if (actualByStableId.has(stableId)) {
          findings.push({
            kind: 'forbidden-entity',
            stableId,
            reason: forbiddenRecord.get('reason'),
          });
        }
      }
      const composition = compositionByScenario.get(scenarioId) || { constraints: 0, lanes: 0 };
      scenarios.push({
        scenarioId,
        title: record.get('title'),
        protocol: record.get('protocol'),
        ok: findings.length === 0,
        entities: entityRecords.length,
        constraints: composition.constraints,
        lanes: composition.lanes,
        findings,
      });
    }
    const modelRecord = scenarioResult.records[0];
    const sourceDrawio = modelRecord?.get('sourceDrawio');
    const importedSourceHash = modelRecord?.get('sourceHash');
    const currentSourceHash = sourceDrawio
      ? crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.resolve(workspaceRoot, sourceDrawio)))
          .digest('hex')
      : null;
    const referenceFresh = Boolean(
      importedSourceHash
      && currentSourceHash
      && importedSourceHash === currentSourceHash,
    );

    const summary = {
      ok: referenceFresh && scenarios.length > 0 && scenarios.every((scenario) => scenario.ok),
      modelId: args.modelId,
      reference: {
        sourceDrawio,
        importedSourceHash,
        currentSourceHash,
        fresh: referenceFresh,
        store: describeNeo4jProfile(referenceProfile),
      },
      actualStore: describeNeo4jProfile(actualProfile),
      scenarios,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) process.exitCode = 1;
  } finally {
    await Promise.all([
      referenceSession.close(),
      actualSession.close(),
    ]);
    await Promise.all([
      referenceDriver.close(),
      actualDriver.close(),
    ]);
  }
}

await main();
