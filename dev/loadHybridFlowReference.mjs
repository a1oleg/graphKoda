export async function loadHybridFlowReference(
  driver,
  database,
  modelId = 'on-submit-hybrid-flow-v1',
) {
  const session = driver.session({ database });
  try {
    const scenarioResult = await session.run(`
      MATCH (model:GoldenModel {modelId: $modelId})
        -[:HAS_GOLDEN_SCENARIO]->(scenario:GoldenScenario)
      RETURN scenario.scenarioId AS scenarioId,
             scenario.title AS title,
             scenario.protocol AS protocol,
             scenario.method AS method,
             scenario.sourceSpan AS sourceSpan,
             model.functionStableId AS functionStableId
      ORDER BY scenario.scenarioId
    `, { modelId });
    const scenarioIds = scenarioResult.records.map((record) => record.get('scenarioId'));
    const entityResult = await session.run(`
      MATCH (scenario:GoldenScenario {goldenModelId: $modelId})
        -[:HAS_GOLDEN_ENTITY]->(entity:GoldenEntity)
      WHERE scenario.scenarioId IN $scenarioIds
      RETURN scenario.scenarioId AS scenarioId,
             entity.role AS role,
             entity.semanticKind AS semanticKind,
             entity.actualStableId AS actualStableId,
             entity.labelsAll AS labelsAll,
             entity.propertiesJson AS propertiesJson
      ORDER BY scenario.scenarioId, entity.role
    `, { modelId, scenarioIds });
    const relationResult = await session.run(`
      MATCH (scenario:GoldenScenario {goldenModelId: $modelId})
        -[:HAS_GOLDEN_RELATION]->(relation:GoldenRelation)
      WHERE scenario.scenarioId IN $scenarioIds
      RETURN scenario.scenarioId AS scenarioId,
             relation.fromRole AS fromRole,
             relation.type AS type,
             relation.toRole AS toRole,
             relation.layer AS layer,
             relation.name AS name
      ORDER BY scenario.scenarioId, relation.goldenId
    `, { modelId, scenarioIds });
    const constraintResult = await session.run(`
      MATCH (scenario:GoldenScenario {goldenModelId: $modelId})
        -[:HAS_GOLDEN_CONSTRAINT]->(constraint:GoldenCompositionConstraint)
      WHERE scenario.scenarioId IN $scenarioIds
      RETURN scenario.scenarioId AS scenarioId,
             constraint.type AS type,
             constraint.subjectRole AS subjectRole,
             constraint.objectRole AS objectRole,
             constraint.policy AS policy
      ORDER BY scenario.scenarioId, constraint.goldenId
    `, { modelId, scenarioIds });
    const laneResult = await session.run(`
      MATCH (scenario:GoldenScenario {goldenModelId: $modelId})
        -[:HAS_GOLDEN_LANE]->(lane:GoldenLane)
      WHERE scenario.scenarioId IN $scenarioIds
      RETURN scenario.scenarioId AS scenarioId,
             lane.ownerRole AS ownerRole,
             lane.direction AS direction,
             lane.visualKind AS visualKind,
             lane.headerRole AS headerRole,
             lane.hideInternalChain AS hideInternalChain,
             lane.orderedRoles AS orderedRoles
      ORDER BY scenario.scenarioId, lane.goldenId
    `, { modelId, scenarioIds });

    const byId = new Map(scenarioResult.records.map((record) => {
      const scenarioId = record.get('scenarioId');
      return [scenarioId, {
        scenarioId,
        title: record.get('title'),
        protocol: record.get('protocol'),
        method: record.get('method'),
        sourceSpan: record.get('sourceSpan'),
        functionStableId: record.get('functionStableId'),
        entities: [],
        relations: [],
        constraints: [],
        lanes: [],
      }];
    }));
    for (const record of entityResult.records) {
      byId.get(record.get('scenarioId'))?.entities.push({
        role: record.get('role'),
        semanticKind: record.get('semanticKind'),
        actualStableId: record.get('actualStableId'),
        labelsAll: record.get('labelsAll') || [],
        properties: JSON.parse(record.get('propertiesJson') || '{}'),
      });
    }
    for (const record of relationResult.records) {
      byId.get(record.get('scenarioId'))?.relations.push({
        from: record.get('fromRole'),
        type: record.get('type'),
        to: record.get('toRole'),
        layer: record.get('layer'),
        name: record.get('name') || '',
      });
    }
    for (const record of constraintResult.records) {
      byId.get(record.get('scenarioId'))?.constraints.push({
        type: record.get('type'),
        subject: record.get('subjectRole'),
        object: record.get('objectRole'),
        policy: record.get('policy') || '',
      });
    }
    for (const record of laneResult.records) {
      byId.get(record.get('scenarioId'))?.lanes.push({
        owner: record.get('ownerRole'),
        direction: record.get('direction'),
        visualKind: record.get('visualKind') || '',
        headerRole: record.get('headerRole') || '',
        hideInternalChain: record.get('hideInternalChain') === true,
        orderedRoles: record.get('orderedRoles') || [],
      });
    }
    return {
      modelId,
      scenarios: [...byId.values()],
      scenarioCount: scenarioResult.records.length,
    };
  } finally {
    await session.close();
  }
}
