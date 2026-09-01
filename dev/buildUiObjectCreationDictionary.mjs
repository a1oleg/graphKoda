import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import neo4j from 'neo4j-driver';

const workspaceRoot = process.cwd();
const outputDir = path.join(workspaceRoot, 'graph', 'draw', 'ui-object-usage');
const outputJsonPath = path.join(outputDir, 'creator-methods.json');
const outputMarkdownPath = path.join(outputDir, 'creator-methods.md');

dotenv.config({ path: path.join(workspaceRoot, 'graph', '.env'), quiet: true });

function toPlainNeo4jValue(value) {
  if (neo4j.isInt(value)) {
    return value.toNumber();
  }
  if (Array.isArray(value)) {
    return value.map(toPlainNeo4jValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, toPlainNeo4jValue(nestedValue)]),
    );
  }
  return value;
}

function createNeo4jDriver() {
  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USER || process.env.NEO4J_USERNAME;
  const password = process.env.NEO4J_PASSWORD;
  if (!uri || !user || !password) {
    throw new Error('NEO4J_URI, NEO4J_USER/NEO4J_USERNAME and NEO4J_PASSWORD must be set in graph/.env');
  }
  return neo4j.driver(uri, neo4j.auth.basic(user, password));
}

async function runNeo4jRead(driver, query, parameters = {}) {
  const database = process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j';
  const session = driver.session({ database, defaultAccessMode: neo4j.session.READ });
  try {
    const result = await session.run(query, parameters);
    return result.records.map((record) => Object.fromEntries(
      record.keys.map((key) => [key, toPlainNeo4jValue(record.get(key))]),
    ));
  } finally {
    await session.close();
  }
}

function categorizeRepoPath(repoRelativePath = '') {
  if (repoRelativePath.startsWith('src/api/gramjs/apiBuilders/')) return 'api-builder';
  if (repoRelativePath.startsWith('src/api/gramjs/methods/')) return 'api-method';
  if (repoRelativePath.startsWith('src/api/gramjs/updates/')) return 'api-update';
  if (repoRelativePath.startsWith('src/global/actions/api/')) return 'global-api-action';
  if (repoRelativePath.startsWith('src/global/actions/apiUpdaters/')) return 'global-api-updater';
  if (repoRelativePath.startsWith('src/global/actions/ui/')) return 'global-ui-action';
  if (repoRelativePath.startsWith('src/global/reducers/')) return 'global-reducer';
  if (repoRelativePath.startsWith('src/global/selectors/')) return 'global-selector';
  if (repoRelativePath.startsWith('src/components/')) return 'ui-local';
  return 'other';
}

function isBusinessCreatorCategory(category) {
  return [
    'api-builder',
    'api-method',
    'api-update',
    'global-api-action',
    'global-api-updater',
  ].includes(category);
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function groupByObject(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.objectKey)) {
      grouped.set(row.objectKey, []);
    }
    grouped.get(row.objectKey).push(row);
  }
  return grouped;
}

function countBy(values) {
  const counts = {};
  for (const value of values) {
    counts[value] = (counts[value] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function renderMarkdown(payload) {
  const lines = [
    '# UI Object Creator Methods',
    '',
    `Generated: ${payload.generatedAt}`,
    '',
    'Source: explicit `(:Step)-[:CREATES_OBJECT]->(:CreatedObject)` evidence only. No lexical substring matching.',
    '',
    `Dictionary objects: ${payload.summary.dictionaryObjectCount}`,
    `Objects with explicit creators: ${payload.summary.objectCountWithCreators}`,
    `Creator methods: ${payload.summary.creatorMethodCount}`,
    `Business creator methods: ${payload.summary.businessCreatorMethodCount}`,
    `UI-related creator methods: ${payload.summary.uiRelatedCreatorMethodCount}`,
    `UI-related business creator methods: ${payload.summary.uiRelatedBusinessCreatorMethodCount}`,
    `Objects with UI-related business creators: ${payload.summary.objectCountWithUiRelatedBusinessCreators}`,
    '',
    '| Object | Creator methods | Business creators | UI-related business creators | Categories | Sample UI-related business functions |',
    '| --- | ---: | ---: | ---: | --- | --- |',
  ];

  for (const object of payload.objects) {
    const sampleBusinessFunctions = object.uiRelatedBusinessCreators
      .slice(0, 8)
      .map((creator) => `${creator.functionName} (${creator.category})`)
      .join('<br>');
    const categorySummary = Object.entries(object.categoryCounts)
      .map(([category, count]) => `${category}:${count}`)
      .join('<br>');
    lines.push(`| ${[
      `\`${object.objectKey}\``,
      object.creatorMethodCount,
      object.businessCreatorMethodCount,
      object.uiRelatedBusinessCreatorMethodCount,
      categorySummary || '-',
      sampleBusinessFunctions || '-',
    ].join(' | ')} |`);
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

const creatorQuery = `
MATCH (objectFunction:UiObjectFunction {source:'semantic/uiObjectFunction'})
WHERE coalesce(objectFunction.domain_label, '') STARTS WITH 'Api'
WITH collect(DISTINCT objectFunction.domain_label) AS dictionaryObjects
MATCH (step:Step)-[rel:CREATES_OBJECT {source:'semantic/functionFlowGraph'}]->(created:CreatedObject {source:'semantic/functionFlowGraph'})
UNWIND ([created.object_type] + coalesce(created.object_types, [])) AS matchedObjectKey
WITH dictionaryObjects, step, rel, created, matchedObjectKey
WHERE matchedObjectKey IN dictionaryObjects
MATCH (fn:Fn {source:'semantic/functionFlowGraph', stableId: created.parentFnStableId})
WITH matchedObjectKey AS objectKey, fn, rel, created, step
WITH objectKey, fn,
  count(DISTINCT created.object_key) AS createdEvidenceCount,
  collect(DISTINCT created.created_object_source) AS createdObjectSources,
  collect(DISTINCT rel.action_kind) AS actionKinds,
  collect(DISTINCT step.stableId)[0..8] AS sampleStepStableIds
OPTIONAL MATCH (directEntry:UiIntentEntry {source:'uiIntentEntry'})-[:TRIGGERS_STATIC_HANDLER|TARGETS_STATIC_FN]->(fn)
OPTIONAL MATCH (entryViaAction:UiIntentEntry {source:'uiIntentEntry'})
  -[:TRIGGERS_STATIC_HANDLER|TARGETS_STATIC_FN]->(:Fn)-[:TARGETS_ACTION_FN]->(fn)
RETURN objectKey,
  fn.name AS functionName,
  fn.stableId AS fnStableId,
  fn.repo_relative_path AS repoRelativePath,
  createdEvidenceCount,
  createdObjectSources,
  actionKinds,
  sampleStepStableIds,
  count(DISTINCT directEntry) AS directUiEntryCount,
  count(DISTINCT entryViaAction) AS viaActionUiEntryCount
ORDER BY objectKey, repoRelativePath, functionName
`;

const objectCatalogQuery = `
MATCH (objectFunction:UiObjectFunction {source:'semantic/uiObjectFunction'})
WHERE coalesce(objectFunction.domain_label, '') STARTS WITH 'Api'
RETURN collect(DISTINCT objectFunction.domain_label) AS objectKeys
`;

const driver = createNeo4jDriver();
try {
  const [catalogRow] = await runNeo4jRead(driver, objectCatalogQuery);
  const dictionaryObjectKeys = uniqueSorted(catalogRow?.objectKeys || []);
  const rows = await runNeo4jRead(driver, creatorQuery);
  const enrichedRows = rows.map((row) => {
    const category = categorizeRepoPath(row.repoRelativePath);
    return {
      ...row,
      category,
      isBusinessCreator: isBusinessCreatorCategory(category),
      uiEntryCount: row.directUiEntryCount + row.viaActionUiEntryCount,
      isUiRelated: row.directUiEntryCount + row.viaActionUiEntryCount > 0,
    };
  });

  const grouped = groupByObject(enrichedRows);
  const objects = dictionaryObjectKeys.map((objectKey) => {
    const creators = (grouped.get(objectKey) || [])
      .sort((left, right) => (
        Number(right.isBusinessCreator) - Number(left.isBusinessCreator)
        || Number(right.isUiRelated) - Number(left.isUiRelated)
        || left.category.localeCompare(right.category)
        || left.repoRelativePath.localeCompare(right.repoRelativePath)
        || left.functionName.localeCompare(right.functionName)
      ));
    const businessCreators = creators.filter((creator) => creator.isBusinessCreator);
    const uiRelatedCreators = creators.filter((creator) => creator.isUiRelated);
    const uiRelatedBusinessCreators = businessCreators.filter((creator) => creator.isUiRelated);
    return {
      objectKey,
      creatorMethodCount: creators.length,
      businessCreatorMethodCount: businessCreators.length,
      uiRelatedCreatorMethodCount: uiRelatedCreators.length,
      uiRelatedBusinessCreatorMethodCount: uiRelatedBusinessCreators.length,
      categoryCounts: countBy(creators.map((creator) => creator.category)),
      businessCreatorCategories: countBy(businessCreators.map((creator) => creator.category)),
      uiRelatedBusinessCreatorCategories: countBy(uiRelatedBusinessCreators.map((creator) => creator.category)),
      uiRelatedBusinessCreators,
      businessCreators,
      allCreators: creators,
    };
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    source: {
      graphEvidence: '(:Step)-[:CREATES_OBJECT {source:"semantic/functionFlowGraph"}]->(:CreatedObject {source:"semantic/functionFlowGraph"})',
      objectMatch: 'CreatedObject.object_type/object_types exact match with UiObjectFunction.domain_label',
      lexicalMatching: false,
      graphWrites: false,
    },
    summary: {
      dictionaryObjectCount: dictionaryObjectKeys.length,
      objectCountWithCreators: objects.filter((object) => object.creatorMethodCount > 0).length,
      objectCountWithBusinessCreators: objects.filter((object) => object.businessCreatorMethodCount > 0).length,
      objectCountWithUiRelatedCreators: objects.filter((object) => object.uiRelatedCreatorMethodCount > 0).length,
      objectCountWithUiRelatedBusinessCreators: objects.filter((object) => object.uiRelatedBusinessCreatorMethodCount > 0).length,
      creatorMethodCount: enrichedRows.length,
      businessCreatorMethodCount: enrichedRows.filter((row) => row.isBusinessCreator).length,
      uiRelatedCreatorMethodCount: enrichedRows.filter((row) => row.isUiRelated).length,
      uiRelatedBusinessCreatorMethodCount: enrichedRows.filter((row) => row.isBusinessCreator && row.isUiRelated).length,
      directUiEntryLinks: enrichedRows.reduce((sum, row) => sum + row.directUiEntryCount, 0),
      viaActionUiEntryLinks: enrichedRows.reduce((sum, row) => sum + row.viaActionUiEntryCount, 0),
      categoryCounts: countBy(enrichedRows.map((row) => row.category)),
    },
    objects,
  };

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputJsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(outputMarkdownPath, renderMarkdown(payload));

  console.log(JSON.stringify({
    outputJsonPath,
    outputMarkdownPath,
    summary: payload.summary,
  }, null, 2));
} finally {
  await driver.close();
}

