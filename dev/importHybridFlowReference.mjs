import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  createNeo4jDriver,
  describeNeo4jProfile,
  loadGoldenAuraProfile,
} from './hybridFlowNeo4jProfiles.mjs';

const workspaceRoot = process.cwd();

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    specPath: path.join(workspaceRoot, 'graph', 'specs', 'hybrid-flow-reference.json'),
    auraEnvPath: path.join(workspaceRoot, 'graph', '.env.aura'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--spec') {
      args.specPath = path.resolve(workspaceRoot, argv[index + 1]);
      index += 1;
    } else if (arg === '--aura-env') {
      args.auraEnvPath = path.resolve(workspaceRoot, argv[index + 1]);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node dev/importHybridFlowReference.mjs [--spec <path>] [--aura-env <path>]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function flattenSpec(spec, sourceHash) {
  const scenarios = [];
  const entities = [];
  const relations = [];
  const constraints = [];
  const lanes = [];
  const forbidden = [];

  for (const scenario of spec.scenarios || []) {
    scenarios.push({
      scenarioId: scenario.id,
      title: scenario.title,
      protocol: scenario.protocol,
      method: scenario.method,
      sourceSpan: scenario.sourceSpan,
    });
    for (const entity of scenario.entities || []) {
      entities.push({
        goldenId: `${scenario.id}::${entity.role}`,
        scenarioId: scenario.id,
        role: entity.role,
        semanticKind: entity.semanticKind,
        actualStableId: entity.actualStableId,
        labelsAll: entity.labelsAll || [],
        propertiesJson: JSON.stringify(entity.properties || {}),
        sourceCellIds: entity.sourceCellIds || [],
      });
    }
    for (const [index, relation] of (scenario.relations || []).entries()) {
      relations.push({
        goldenId: `${scenario.id}::relation:${index}`,
        scenarioId: scenario.id,
        fromRole: relation.from,
        type: relation.type,
        toRole: relation.to,
        layer: relation.layer || 'mixed',
        name: relation.name || '',
      });
    }
    for (const [index, constraint] of (scenario.composition?.constraints || []).entries()) {
      constraints.push({
        goldenId: `${scenario.id}::constraint:${index}`,
        scenarioId: scenario.id,
        type: constraint.type,
        subjectRole: constraint.subject,
        objectRole: constraint.object,
        policy: constraint.policy || '',
      });
    }
    for (const [index, lane] of (scenario.composition?.lanes || []).entries()) {
      lanes.push({
        goldenId: `${scenario.id}::lane:${index}`,
        scenarioId: scenario.id,
        ownerRole: lane.owner,
        direction: lane.direction,
        visualKind: lane.visualKind || '',
        headerRole: lane.headerRole || '',
        hideInternalChain: lane.hideInternalChain === true,
        orderedRoles: lane.orderedRoles || [],
      });
    }
    for (const [index, item] of (scenario.forbiddenEntities || []).entries()) {
      forbidden.push({
        goldenId: `${scenario.id}::forbidden:${index}`,
        scenarioId: scenario.id,
        actualStableId: item.actualStableId,
        reason: item.reason,
      });
    }
  }

  return {
    model: {
      modelId: spec.modelId,
      title: spec.title,
      schemaVersion: spec.schemaVersion,
      sourceDrawio: spec.sourceDrawio,
      sourceHash,
      functionStableId: spec.functionStableId,
    },
    scenarios,
    entities,
    relations,
    constraints,
    lanes,
    forbidden,
  };
}

function validateSpec(spec, drawioText) {
  const drawioCellIds = new Set(
    [...drawioText.matchAll(/<mxCell\b[^>]*\bid="([^"]+)"/g)].map((match) => match[1]),
  );
  const findings = [];
  for (const scenario of spec.scenarios || []) {
    const roles = new Set();
    for (const entity of scenario.entities || []) {
      if (roles.has(entity.role)) {
        findings.push(`${scenario.id}: duplicate entity role ${entity.role}`);
      }
      roles.add(entity.role);
      for (const sourceCellId of entity.sourceCellIds || []) {
        if (!drawioCellIds.has(sourceCellId)) {
          findings.push(`${scenario.id}:${entity.role}: missing draw.io cell ${sourceCellId}`);
        }
      }
    }
    for (const relation of scenario.relations || []) {
      if (!roles.has(relation.from)) findings.push(`${scenario.id}: relation source role ${relation.from} is missing`);
      if (!roles.has(relation.to)) findings.push(`${scenario.id}: relation target role ${relation.to} is missing`);
    }
    for (const constraint of scenario.composition?.constraints || []) {
      if (!roles.has(constraint.subject)) findings.push(`${scenario.id}: constraint subject role ${constraint.subject} is missing`);
      if (!roles.has(constraint.object)) findings.push(`${scenario.id}: constraint object role ${constraint.object} is missing`);
    }
    for (const lane of scenario.composition?.lanes || []) {
      if (!roles.has(lane.owner)) findings.push(`${scenario.id}: lane owner role ${lane.owner} is missing`);
      for (const role of lane.orderedRoles || []) {
        if (!roles.has(role)) findings.push(`${scenario.id}: lane role ${role} is missing`);
      }
    }
  }
  if (findings.length) {
    throw new Error(`Invalid hybrid-flow reference:\n${findings.join('\n')}`);
  }
}

async function main() {
  const args = parseArgs();
  const spec = JSON.parse(fs.readFileSync(args.specPath, 'utf8'));
  const drawioPath = path.resolve(workspaceRoot, spec.sourceDrawio);
  const drawioText = fs.readFileSync(drawioPath, 'utf8');
  validateSpec(spec, drawioText);
  const sourceHash = crypto
    .createHash('sha256')
    .update(drawioText)
    .digest('hex');
  const payload = flattenSpec(spec, sourceHash);
  const profile = loadGoldenAuraProfile(args.auraEnvPath);
  const driver = createNeo4jDriver(profile);
  const session = driver.session({ database: profile.database });

  try {
    await session.executeWrite((tx) => tx.run(`
      MATCH (item)
      WHERE item.goldenModelId = $modelId
      DETACH DELETE item
    `, { modelId: payload.model.modelId }));
    await session.executeWrite((tx) => tx.run(`
      CREATE (model:GoldenModel)
      SET model = $model,
          model.goldenModelId = $model.modelId,
          model.importedAt = datetime()
    `, { model: payload.model }));
    await session.executeWrite((tx) => tx.run(`
      MATCH (model:GoldenModel {modelId: $modelId})
      UNWIND $rows AS row
      CREATE (scenario:GoldenScenario)
      SET scenario = row,
          scenario.goldenModelId = $modelId
      CREATE (model)-[:HAS_GOLDEN_SCENARIO]->(scenario)
    `, { modelId: payload.model.modelId, rows: payload.scenarios }));
    await session.executeWrite((tx) => tx.run(`
      UNWIND $rows AS row
      MATCH (scenario:GoldenScenario {scenarioId: row.scenarioId, goldenModelId: $modelId})
      CREATE (entity:GoldenEntity)
      SET entity = row,
          entity.goldenModelId = $modelId
      CREATE (scenario)-[:HAS_GOLDEN_ENTITY {role: row.role}]->(entity)
    `, { modelId: payload.model.modelId, rows: payload.entities }));
    await session.executeWrite((tx) => tx.run(`
      UNWIND $rows AS row
      MATCH (scenario:GoldenScenario {scenarioId: row.scenarioId, goldenModelId: $modelId})
      MATCH (source:GoldenEntity {scenarioId: row.scenarioId, role: row.fromRole, goldenModelId: $modelId})
      MATCH (target:GoldenEntity {scenarioId: row.scenarioId, role: row.toRole, goldenModelId: $modelId})
      CREATE (relation:GoldenRelation)
      SET relation = row,
          relation.goldenModelId = $modelId
      CREATE (scenario)-[:HAS_GOLDEN_RELATION]->(relation)
      CREATE (relation)-[:FROM_GOLDEN_ENTITY]->(source)
      CREATE (relation)-[:TO_GOLDEN_ENTITY]->(target)
    `, { modelId: payload.model.modelId, rows: payload.relations }));
    await session.executeWrite((tx) => tx.run(`
      UNWIND $rows AS row
      MATCH (scenario:GoldenScenario {scenarioId: row.scenarioId, goldenModelId: $modelId})
      CREATE (constraint:GoldenCompositionConstraint)
      SET constraint = row,
          constraint.goldenModelId = $modelId
      CREATE (scenario)-[:HAS_GOLDEN_CONSTRAINT]->(constraint)
    `, { modelId: payload.model.modelId, rows: payload.constraints }));
    await session.executeWrite((tx) => tx.run(`
      UNWIND $rows AS row
      MATCH (scenario:GoldenScenario {scenarioId: row.scenarioId, goldenModelId: $modelId})
      CREATE (lane:GoldenLane)
      SET lane = row,
          lane.goldenModelId = $modelId
      CREATE (scenario)-[:HAS_GOLDEN_LANE]->(lane)
    `, { modelId: payload.model.modelId, rows: payload.lanes }));
    await session.executeWrite((tx) => tx.run(`
      UNWIND $rows AS row
      MATCH (scenario:GoldenScenario {scenarioId: row.scenarioId, goldenModelId: $modelId})
      CREATE (forbidden:GoldenForbiddenPattern)
      SET forbidden = row,
          forbidden.goldenModelId = $modelId
      CREATE (scenario)-[:HAS_GOLDEN_FORBIDDEN_PATTERN]->(forbidden)
    `, { modelId: payload.model.modelId, rows: payload.forbidden }));

    console.log(JSON.stringify({
      ok: true,
      modelId: payload.model.modelId,
      sourceDrawio: payload.model.sourceDrawio,
      sourceHash,
      scenarios: payload.scenarios.length,
      entities: payload.entities.length,
      relations: payload.relations.length,
      constraints: payload.constraints.length,
      lanes: payload.lanes.length,
      referenceStore: describeNeo4jProfile(profile),
    }, null, 2));
  } finally {
    await session.close();
    await driver.close();
  }
}

await main();
