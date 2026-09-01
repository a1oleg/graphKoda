import fs from 'node:fs';
import path from 'node:path';

import { resolveFunctionActualCoordinates, resolveFunctionEntity } from './gatewayForALL.js';

export const DEFAULT_FEATURE_JSON_PATH = 'graph/toolSelectionFeature.json';
export const DEFAULT_FEATURE_PRIMARY_FUNCTION_SET_PATH = 'graph/toolSelectionFeature.static-draw.stableIds.json';
export const DEFAULT_FEATURE_BABEL_FUNCTION_SET_PATH = 'graph/toolSelectionFeature.functions.babel.json';
export const DEFAULT_FEATURE_REQUESTED_STABLE_IDS_PATH = 'graph/toolSelectionFeature.requested14.stableIds.json';

function normalizeFeatureKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeStringList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

function normalizeFeatureRepoRelativePath(value) {
  if (!value) {
    return null;
  }

  return String(value).replace(/\\/g, '/').replace(/^\.\//, '') || null;
}

function normalizePositiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function resolveFeatureJsonPath(jsonPath = DEFAULT_FEATURE_JSON_PATH) {
  return path.resolve(process.cwd(), jsonPath || DEFAULT_FEATURE_JSON_PATH);
}

function isDefaultFeatureJsonPath(jsonPath = DEFAULT_FEATURE_JSON_PATH) {
  return resolveFeatureJsonPath(jsonPath) === resolveFeatureJsonPath(DEFAULT_FEATURE_JSON_PATH);
}

function resolveFeaturePrimaryFunctionSetPath(jsonPath = DEFAULT_FEATURE_JSON_PATH) {
  if (isDefaultFeatureJsonPath(jsonPath)) {
    return path.resolve(process.cwd(), DEFAULT_FEATURE_PRIMARY_FUNCTION_SET_PATH);
  }

  return resolveFeatureJsonPath(jsonPath).replace(/\.json$/i, '.static-draw.stableIds.json');
}

function resolveFeatureBabelFunctionSetPath(jsonPath = DEFAULT_FEATURE_JSON_PATH) {
  if (isDefaultFeatureJsonPath(jsonPath)) {
    return path.resolve(process.cwd(), DEFAULT_FEATURE_BABEL_FUNCTION_SET_PATH);
  }

  return resolveFeatureJsonPath(jsonPath).replace(/\.json$/i, '.functions.babel.json');
}

function resolveFeatureRequestedStableIdsPath(jsonPath = DEFAULT_FEATURE_JSON_PATH) {
  if (isDefaultFeatureJsonPath(jsonPath)) {
    return path.resolve(process.cwd(), DEFAULT_FEATURE_REQUESTED_STABLE_IDS_PATH);
  }

  return resolveFeatureJsonPath(jsonPath).replace(/\.json$/i, '.requested14.stableIds.json');
}

function readFeatureJsonPayload(jsonPath = DEFAULT_FEATURE_JSON_PATH) {
  return JSON.parse(fs.readFileSync(resolveFeatureJsonPath(jsonPath), 'utf8')) || {};
}

export {
  isDefaultFeatureJsonPath,
  readFeatureJsonPayload,
  resolveFeatureBabelFunctionSetPath,
  resolveFeatureJsonPath,
  resolveFeaturePrimaryFunctionSetPath,
  resolveFeatureRequestedStableIdsPath,
};

function readFeatureGraphSelectorFromJson(jsonPath = DEFAULT_FEATURE_JSON_PATH) {
  const payload = readFeatureJsonPayload(jsonPath);

  return {
    key: payload?.key || payload?.name || undefined,
    name: payload?.name || payload?.key || payload?.head?.name || undefined,
    headStableId: payload?.head?.stableId || undefined,
    tailStableIds: normalizeStringList((Array.isArray(payload?.tails) ? payload.tails : []).map((item) => item?.stableId)),
    bridgeExitFnStableId: payload?.bridgeExitFnStableId || undefined,
  };
}

export { readFeatureGraphSelectorFromJson };

function buildFeatureRecordFromSelectors({
  key,
  name,
  label,
  aliases,
  goalText,
  repoRelativePath,
  headStableId,
  tailStableIds,
  bridgeExitFnStableId,
} = {}) {
  if (!headStableId) {
    return null;
  }

  const normalizedTailStableIds = normalizeStringList(tailStableIds);
  if (!normalizedTailStableIds.length) {
    return null;
  }

  const resolvedName = String(name || key || label || 'feature');

  return {
    key: normalizeFeatureKey(key || name || label || headStableId),
    name: resolvedName,
    stableId: headStableId,
    label: label || resolvedName,
    repoRelativePath: normalizeFeatureRepoRelativePath(repoRelativePath),
    aliases: normalizeStringList(aliases),
    goalText: goalText || null,
    endFnStableIds: normalizedTailStableIds,
    bridgeExitFnStableId: bridgeExitFnStableId || null,
  };
}

function buildFeatureRecordFromResolvedEntities({
  head,
  tails,
  key,
  name,
  aliases,
  goalText,
  bridgeExitFnStableId,
}) {
  if (!head?.stableId) {
    return null;
  }

  return {
    key: normalizeFeatureKey(key || name || head.name || head.stableId),
    name: String(name || head.name || 'feature'),
    stableId: head.stableId,
    label: head.label || head.name || null,
    repoRelativePath: head.repoRelativePath || null,
    aliases: normalizeStringList(aliases),
    goalText: goalText || null,
    endFnStableIds: normalizeStringList((tails || []).map((item) => item?.stableId)),
    bridgeExitFnStableId: bridgeExitFnStableId || null,
  };
}

function collectFeatureSelectorEntries(payload) {
  const selectorEntries = [payload?.head, ...(Array.isArray(payload?.tails) ? payload.tails : [])]
    .filter(Boolean)
    .map(({ stableId, name, repoRelativePath, line, startLine, startColumn, endLine, endColumn }) => ({
      stableId,
      name,
      repoRelativePath,
      line: normalizePositiveInteger(line),
      startLine: normalizePositiveInteger(startLine),
      startColumn: normalizePositiveInteger(startColumn),
      endLine: normalizePositiveInteger(endLine),
      endColumn: normalizePositiveInteger(endColumn),
    }));

  const seen = new Set();

  return selectorEntries.filter((entry) => {
    const dedupeKey = [
      entry.stableId,
      entry.name,
      entry.repoRelativePath,
      entry.line,
      entry.startLine,
      entry.startColumn,
      entry.endLine,
      entry.endColumn,
    ]
      .map((value) => String(value || '').trim())
      .join('::');

    if (!dedupeKey.replace(/[:]/g, '')) {
      return false;
    }

    if (seen.has(dedupeKey)) {
      return false;
    }

    seen.add(dedupeKey);
    return true;
  });
}

async function resolveFeatureSelectorEntity(driver, database, {
  stableId,
  name,
  repoRelativePath,
  line,
  startLine,
  startColumn,
  endLine,
  endColumn,
  ensureFlow = false,
} = {}) {
  const resolution = await resolveFunctionActualCoordinates(driver, database, {
    stableId,
    name,
    repoRelativePath,
    line,
    startLine,
    startColumn,
    endLine,
    endColumn,
    repairGraph: true,
    ensureFlow,
  }).catch(() => null);

  if (!resolution?.stableId) {
    return null;
  }

  if (resolution.fn?.stableId === resolution.stableId && (resolution.fn.name || resolution.fn.repoRelativePath)) {
    return resolution.fn;
  }

  return resolveFunctionEntity(driver, database, {
    stableId: resolution.stableId,
    ensureFlow,
  }).catch(() => null);
}

async function buildFeatureRecordFromJson(driver, database, payload, { ensureHeadFlow = false } = {}) {
  const head = await resolveFeatureSelectorEntity(driver, database, {
    stableId: payload?.head?.stableId,
    name: payload?.head?.name,
    repoRelativePath: payload?.head?.repoRelativePath,
    line: normalizePositiveInteger(payload?.head?.line),
    startLine: normalizePositiveInteger(payload?.head?.startLine),
    startColumn: normalizePositiveInteger(payload?.head?.startColumn),
    endLine: normalizePositiveInteger(payload?.head?.endLine),
    endColumn: normalizePositiveInteger(payload?.head?.endColumn),
    ensureFlow: ensureHeadFlow,
  });
  if (!head?.stableId) {
    return null;
  }

  const tailEntities = await Promise.all(
    (Array.isArray(payload?.tails) ? payload.tails : []).map((tail) => (
      resolveFeatureSelectorEntity(driver, database, {
        stableId: tail?.stableId,
        name: tail?.name,
        repoRelativePath: tail?.repoRelativePath,
        line: normalizePositiveInteger(tail?.line),
        startLine: normalizePositiveInteger(tail?.startLine),
        startColumn: normalizePositiveInteger(tail?.startColumn),
        endLine: normalizePositiveInteger(tail?.endLine),
        endColumn: normalizePositiveInteger(tail?.endColumn),
        ensureFlow: false,
      }).catch(() => null)
    )),
  );

  const bridgeExitFn = payload?.bridgeExitFn && typeof payload.bridgeExitFn === 'object'
    ? await resolveFeatureSelectorEntity(driver, database, {
      stableId: payload.bridgeExitFn.stableId,
      name: payload.bridgeExitFn.name,
      repoRelativePath: payload.bridgeExitFn.repoRelativePath,
      line: normalizePositiveInteger(payload.bridgeExitFn.line),
      startLine: normalizePositiveInteger(payload.bridgeExitFn.startLine),
      startColumn: normalizePositiveInteger(payload.bridgeExitFn.startColumn),
      endLine: normalizePositiveInteger(payload.bridgeExitFn.endLine),
      endColumn: normalizePositiveInteger(payload.bridgeExitFn.endColumn),
      ensureFlow: false,
    }).catch(() => null)
    : null;

  return buildFeatureRecordFromResolvedEntities({
    head,
    tails: tailEntities,
    key: payload?.key,
    name: payload?.name,
    aliases: payload?.aliases,
    goalText: payload?.description || payload?.goalText,
    bridgeExitFnStableId: bridgeExitFn?.stableId || payload?.bridgeExitFnStableId || null,
  });
}

async function buildFeatureRecordFromStableIds(driver, database, {
  headStableId,
  tailStableIds,
  bridgeExitFnStableId,
} = {}) {
  if (!headStableId) {
    return null;
  }

  const head = await resolveFunctionEntity(driver, database, {
    stableId: headStableId,
    ensureFlow: false,
  }).catch(() => null);

  if (!head?.stableId) {
    return null;
  }

  const tailEntities = await Promise.all(
    normalizeStringList(tailStableIds).map((stableId) => (
      resolveFunctionEntity(driver, database, {
        stableId,
        ensureFlow: false,
      }).catch(() => null)
    )),
  );

  return buildFeatureRecordFromResolvedEntities({
    head,
    tails: tailEntities,
    bridgeExitFnStableId: bridgeExitFnStableId || null,
  });
}

export async function resolveFeatureEntity(driver, database, {
  stableId,
  key,
  name,
  headStableId,
  tailStableIds,
  bridgeExitFnStableId,
  jsonPath = DEFAULT_FEATURE_JSON_PATH,
} = {}) {
  if (headStableId || tailStableIds?.length) {
    return buildFeatureRecordFromSelectors({
      key,
      name,
      label: name || key || null,
      headStableId,
      tailStableIds,
      bridgeExitFnStableId,
    }) || buildFeatureRecordFromStableIds(driver, database, {
      headStableId,
      tailStableIds,
      bridgeExitFnStableId,
    });
  }

  const payload = readFeatureJsonPayload(jsonPath);
  const jsonFeature = buildFeatureRecordFromSelectors({
    key: payload?.key,
    name: payload?.name,
    label: payload?.head?.name || payload?.name || payload?.key || null,
    aliases: payload?.aliases,
    goalText: payload?.description || payload?.goalText,
    repoRelativePath: payload?.head?.repoRelativePath,
    headStableId: payload?.head?.stableId,
    tailStableIds: normalizeStringList((Array.isArray(payload?.tails) ? payload.tails : []).map((item) => item?.stableId)),
    bridgeExitFnStableId: payload?.bridgeExitFn?.stableId || payload?.bridgeExitFnStableId || undefined,
  }) || await buildFeatureRecordFromJson(driver, database, payload);
  if (jsonFeature?.stableId) {
    if (stableId && jsonFeature.stableId !== stableId) {
      return null;
    }

    if (key && jsonFeature.key !== normalizeFeatureKey(key)) {
      return null;
    }

    if (name && ![jsonFeature.name, jsonFeature.key].includes(name) && jsonFeature.key !== normalizeFeatureKey(name)) {
      return null;
    }

    return jsonFeature;
  }

  return null;
}

async function importFeatureSelectorFunctionsFromJson(driver, database, payload) {
  const resolvedFunctions = await Promise.all(
    collectFeatureSelectorEntries(payload).map((selector) => (
      resolveFeatureSelectorEntity(driver, database, {
        stableId: selector.stableId,
        name: selector.name,
        repoRelativePath: selector.repoRelativePath,
        line: selector.line,
        startLine: selector.startLine,
        startColumn: selector.startColumn,
        endLine: selector.endLine,
        endColumn: selector.endColumn,
        ensureFlow: true,
      }).catch(() => null)
    )),
  );

  return resolvedFunctions.filter((item) => item?.stableId);
}

async function importFeatureSelectorFunctionFlowsFromJson(driver, database, payload) {
  const resolvedFunctions = await Promise.all(
    collectFeatureSelectorEntries(payload).map(async (selector) => {
      const resolvedFunction = await resolveFeatureSelectorEntity(driver, database, {
        stableId: selector.stableId,
        name: selector.name,
        repoRelativePath: selector.repoRelativePath,
        line: selector.line,
        startLine: selector.startLine,
        startColumn: selector.startColumn,
        endLine: selector.endLine,
        endColumn: selector.endColumn,
        ensureFlow: true,
      }).catch(() => null);

      if (!resolvedFunction?.stableId) {
        return undefined;
      }

      return {
        stableId: resolvedFunction.stableId,
        requestedStableId: selector.stableId || undefined,
        name: resolvedFunction.name || selector.name || undefined,
        repoRelativePath: resolvedFunction.repoRelativePath || selector.repoRelativePath || undefined,
        changed: Boolean(selector.stableId && resolvedFunction.stableId !== selector.stableId),
        imported: true,
      };
    }),
  );

  return resolvedFunctions.filter(Boolean);
}

export async function importFeatureSelectorFunctionFlowsFromJsonPath(driver, database, jsonPath = DEFAULT_FEATURE_JSON_PATH) {
  const payload = readFeatureJsonPayload(jsonPath);
  return importFeatureSelectorFunctionFlowsFromJson(driver, database, payload);
}


