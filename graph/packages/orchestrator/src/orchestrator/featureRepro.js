import fs from 'node:fs';
import path from 'node:path';

import { resolveFunctionActualCoordinates, resolveFunctionEntity } from './gatewayForALL.js';

function sanitizeFileName(text) {
  const sanitized = String(text || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'feature-repro';
}

function writeJsonFile(filePath, payload) {
  const directoryPath = path.dirname(filePath);
  fs.mkdirSync(directoryPath, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function buildDefaultFeatureReproPath(feature) {
  const featureSlug = sanitizeFileName(`${feature?.key || feature?.name || feature?.stableId || 'feature'}-repro`);
  return path.resolve(process.cwd(), 'graph', 'repros', `${featureSlug}.${Date.now()}.json`);
}

async function buildFunctionSelectorPayload(driver, database, stableId) {
  if (!stableId) {
    return undefined;
  }

  const entity = await resolveFunctionEntity(driver, database, { stableId, ensureFlow: false }).catch(() => null);
  const resolution = await resolveFunctionActualCoordinates(driver, database, {
    stableId,
    name: entity?.name,
    repoRelativePath: entity?.repoRelativePath,
    repairGraph: true,
  }).catch(() => null);
  const resolvedName = resolution?.name || entity?.name || entity?.label;
  const resolvedRepoRelativePath = resolution?.repoRelativePath || entity?.repoRelativePath;

  if (!resolvedName || !resolvedRepoRelativePath) {
    return undefined;
  }

  return {
    name: resolvedName,
    repoRelativePath: resolvedRepoRelativePath,
    startLine: resolution?.startLine,
    startColumn: resolution?.startColumn,
    endLine: resolution?.endLine,
    endColumn: resolution?.endColumn,
  };
}

async function buildFeatureReproFilePayload(driver, database, feature) {
  const head = await buildFunctionSelectorPayload(driver, database, feature?.stableId);
  const tails = (await Promise.all((feature?.endFnStableIds || []).map((stableId) => (
    buildFunctionSelectorPayload(driver, database, stableId)
  )))).filter(Boolean);
  const bridgeExitFn = await buildFunctionSelectorPayload(driver, database, feature?.bridgeExitFnStableId);

  return {
    schema: {
      kind: 'feature-repro',
      version: 2,
    },
    generatedAt: new Date().toISOString(),
    source: 'selectors',
    feature: {
      key: feature?.key || undefined,
      name: feature?.name || undefined,
      label: feature?.label || undefined,
      repoRelativePath: feature?.repoRelativePath || undefined,
      aliases: Array.isArray(feature?.aliases) ? feature.aliases : [],
      goalText: feature?.goalText || undefined,
    },
    head,
    tails,
    bridgeExitFn,
  };
}

export { buildFeatureReproFilePayload };

export async function saveFeatureReproFile(driver, database, feature, { outputPath } = {}) {
  const payload = await buildFeatureReproFilePayload(driver, database, feature);
  const filePath = path.resolve(process.cwd(), outputPath || buildDefaultFeatureReproPath(feature));
  writeJsonFile(filePath, payload);

  return {
    feature,
    saved: true,
    filePath,
    format: 'json',
  };
}

