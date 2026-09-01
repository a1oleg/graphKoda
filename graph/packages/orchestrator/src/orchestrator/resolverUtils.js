import { resolveFunctionEntity } from './gatewayForALL.js';

export function normalizeStringList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

export function normalizeBusinessObjectList(values) {
  if (Array.isArray(values)) {
    return normalizeStringList(values);
  }

  if (typeof values !== 'string') {
    return [];
  }

  const trimmed = values.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('[')) {
    try {
      return normalizeBusinessObjectList(JSON.parse(trimmed));
    } catch {
      return [trimmed];
    }
  }

  return normalizeStringList(trimmed.split(/[\s,]+/));
}

export async function runWriteQuery(driver, database, query, parameters = {}) {
  const session = driver.session({ database });
  try {
    const result = await session.run(query, parameters);
    return result.records.map((record) => record.toObject());
  } finally {
    await session.close();
  }
}

export async function resolveFunctionEntities(driver, database, {
  stableId,
  stableIds,
  name,
  names,
  repoRelativePath,
  repoRelativePaths,
  ensureFlow = false,
  limit = 50,
} = {}) {
  const cappedLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const resolvedEntities = [];
  const seenStableIds = new Set();

  const appendEntity = async (selector) => {
    const entity = await resolveFunctionEntity(driver, database, selector);
    if (!entity?.stableId || seenStableIds.has(entity.stableId)) {
      return;
    }

    seenStableIds.add(entity.stableId);
    resolvedEntities.push(entity);
  };

  const stableIdSelectors = normalizeStringList([stableId, ...(Array.isArray(stableIds) ? stableIds : [])]);
  for (const stableIdValue of stableIdSelectors) {
    if (resolvedEntities.length >= cappedLimit) {
      return resolvedEntities;
    }

    await appendEntity({ stableId: stableIdValue, ensureFlow });
  }

  const nameSelectors = normalizeStringList([name, ...(Array.isArray(names) ? names : [])]);
  const repoPathSelectors = normalizeStringList([repoRelativePath, ...(Array.isArray(repoRelativePaths) ? repoRelativePaths : [])]);
  const pairPathsByIndex = repoPathSelectors.length > 1 && repoPathSelectors.length === nameSelectors.length;
  const sharedRepoPath = pairPathsByIndex ? undefined : repoPathSelectors[0];

  for (const [index, nameValue] of nameSelectors.entries()) {
    if (resolvedEntities.length >= cappedLimit) {
      break;
    }

    await appendEntity({
      name: nameValue,
      repoRelativePath: pairPathsByIndex ? repoPathSelectors[index] : sharedRepoPath,
      ensureFlow,
    });
  }

  return resolvedEntities;
}

