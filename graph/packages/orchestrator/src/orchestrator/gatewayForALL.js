import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  enrichRuntimeEventRecords,
  fetchRuntimeEventRecords,
  runReadQuery,
} from '../../../runtime-relay/src/runtimeEvents.js';
import {
  findLatestSessionIdForFunctionsInRedis,
  isRedisRuntimeStoreConfig,
  loadFeatureRuntimeCoverageFromRedis,
} from '../../../runtime-relay/src/runtimeRedis.js';
import {
  buildStableIdDescriptorFromRecord,
  buildStableIdLocation,
  getStableIdKey,
} from '../../../../stableIdModel.js';

const execFileAsync = promisify(execFile);

function assertRedisRuntimeStoreConfig(runtimeStore) {
  if (!isRedisRuntimeStoreConfig(runtimeStore)) {
    throw new Error('Non-Redis runtime store configs are no longer supported. Configure a Redis runtime store.');
  }

  return runtimeStore;
}

function resolveGraphPythonCli() {
  const candidates = process.platform === 'win32'
    ? [
      path.join(process.cwd(), '.venv', 'Scripts', 'python.exe'),
      'python',
      'py',
    ]
    : [
      path.join(process.cwd(), '.venv', 'bin', 'python3'),
      path.join(process.cwd(), '.venv', 'bin', 'python'),
      'python3',
      'python',
    ];

  return candidates.find((candidate) => !candidate.includes(path.sep) || fs.existsSync(candidate));
}

function normalizeRepoRelativePath(repoRelativePath) {
  if (!repoRelativePath) {
    return undefined;
  }

  return String(repoRelativePath).replace(/\\/g, '/').replace(/^\.\//, '');
}

function normalizeFilePath(filePath) {
  if (!filePath) {
    return undefined;
  }

  const normalizedValue = String(filePath).trim().replace(/\\/g, '/');
  if (!normalizedValue) {
    return undefined;
  }

  if (path.isAbsolute(normalizedValue)) {
    return normalizedValue;
  }

  return path.resolve(process.cwd(), normalizedValue).replace(/\\/g, '/');
}

function normalizeBusinessObjectList(values) {
  if (Array.isArray(values)) {
    return [...new Set(values
      .map((value) => String(value || '').trim())
      .filter(Boolean))];
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

  return [...new Set(trimmed.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean))];
}

function getFunctionCandidateStable(candidate) {
  return candidate?.stable || buildStableIdDescriptorFromRecord(candidate);
}

function hasExactCoordinateHint({ startLine, startColumn, endLine, endColumn }) {
  return [startLine, startColumn, endLine, endColumn].every((value) => Number.isInteger(value) && value > 0);
}

function hasLineHint(line) {
  return Number.isInteger(line) && line > 0;
}

function describeFunctionCandidate(candidate) {
  const stable = getFunctionCandidateStable(candidate);
  return normalizeRepoRelativePath(candidate?.repoRelativePath || stable?.repoRelativePath)
    || getStableIdKey(candidate?.stableId || stable)
    || '<unknown>';
}

function selectFunctionCandidate(candidates, {
  name,
  repoRelativePath,
  filePath,
  stableId,
  line,
  startLine,
  startColumn,
  endLine,
  endColumn,
}) {
  const normalizedRepoRelativePath = normalizeRepoRelativePath(repoRelativePath);
  const normalizedFilePath = normalizeFilePath(filePath);
  const hintedStableId = getStableIdKey(stableId);
  const filteredCandidates = candidates.filter((candidate) => {
    const stable = getFunctionCandidateStable(candidate);
    const candidateRepoRelativePath = normalizeRepoRelativePath(candidate?.repoRelativePath || stable?.repoRelativePath);
    const candidateFilePath = normalizeFilePath(stable?.filePath);

    if (normalizedRepoRelativePath && candidateRepoRelativePath !== normalizedRepoRelativePath) {
      return false;
    }

    if (normalizedFilePath && candidateFilePath !== normalizedFilePath) {
      return false;
    }

    return true;
  });

  if (!filteredCandidates.length) {
    return null;
  }

  if (hintedStableId) {
    const exactStableIdMatch = filteredCandidates.find((candidate) => getStableIdKey(candidate?.stableId || getFunctionCandidateStable(candidate)) === hintedStableId);
    if (exactStableIdMatch) {
      return exactStableIdMatch;
    }
  }

  if (hasExactCoordinateHint({ startLine, startColumn, endLine, endColumn })) {
    const exactCoordinateMatches = filteredCandidates.filter((candidate) => {
      const stable = getFunctionCandidateStable(candidate);

      return stable?.startLine === startLine
        && stable?.startColumn === startColumn
        && stable?.endLine === endLine
        && stable?.endColumn === endColumn;
    });

    if (exactCoordinateMatches.length === 1) {
      return exactCoordinateMatches[0];
    }
  }

  if (hasLineHint(line)) {
    const lineMatches = filteredCandidates.filter((candidate) => {
      const stable = getFunctionCandidateStable(candidate);

      return Number.isInteger(stable?.startLine)
        && Number.isInteger(stable?.endLine)
        && stable.startLine <= line
        && stable.endLine >= line;
    });

    if (lineMatches.length === 1) {
      return lineMatches[0];
    }
  }

  if (filteredCandidates.length > 1) {
    const locations = filteredCandidates
      .map((candidate) => describeFunctionCandidate(candidate))
      .sort()
      .join(', ');
    throw new Error(`Function name is ambiguous: ${name}. Matches: ${locations}`);
  }

  return filteredCandidates[0];
}

async function loadFunctionCandidatesByName(driver, database, name) {
  const records = await runReadQuery(
    driver,
    database,
    `
      MATCH (fn:Fn {name: $name})
      RETURN fn.stableId AS stableId,
             fn.name AS name,
             fn.label AS label,
             fn.repo_relative_path AS repoRelativePath
      ORDER BY coalesce(fn.repo_relative_path, ''), fn.stableId
    `,
    { name },
  );

  return records.filter((record) => record?.stableId);
}

async function extractFunctionCandidatesByName(name) {
  const extractorPath = path.resolve(process.cwd(), 'graph', 'static-extract', 'ts', 'fromASTtoPreGraphFlow.ts');
  const tsNodeRegisterPath = path.resolve(process.cwd(), 'dev', 'registerTsNodeEsm.mjs');
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', './dev/registerTsNodeEsm.mjs', extractorPath, '--fn-name', name, '--metadata-only'],
    { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 },
  );

  const payload = JSON.parse(stdout || '{}');
  return Array.isArray(payload.functions)
    ? payload.functions
      .map((candidate) => {
        const stable = candidate?.stableId && typeof candidate.stableId === 'object' && !Array.isArray(candidate.stableId)
          ? candidate.stableId
          : buildStableIdDescriptorFromRecord(candidate);
        const stableId = getStableIdKey(stable);

        if (!stableId) {
          return undefined;
        }

        return {
          ...candidate,
          stableId,
          stable,
          repoRelativePath: candidate?.repoRelativePath || stable?.repoRelativePath || null,
        };
      })
      .filter(Boolean)
    : [];
}

async function resolveFunctionCandidateByName(driver, database, { name, repoRelativePath }) {
  const extractedCandidates = await extractFunctionCandidatesByName(name);
  const extractedMatch = selectFunctionCandidate(extractedCandidates, { name, repoRelativePath });
  if (extractedMatch) {
    return extractedMatch;
  }

  const graphCandidates = await loadFunctionCandidatesByName(driver, database, name);
  return selectFunctionCandidate(graphCandidates, { name, repoRelativePath });
}

function buildFunctionCoordinateSnapshot(record = {}, stableIdOverride) {
  const effectiveRecord = record || {};
  const stable = stableIdOverride && typeof stableIdOverride === 'object' && !Array.isArray(stableIdOverride)
    ? stableIdOverride
    : buildStableIdDescriptorFromRecord(effectiveRecord, stableIdOverride ? { stableId: stableIdOverride } : undefined);

  return {
    stableId: getStableIdKey(stableIdOverride || stable || effectiveRecord.stableId),
    stable,
    sourceStateId: stable?.sourceStateId || effectiveRecord.sourceStateId || null,
    filePath: normalizeFilePath(stable?.filePath || effectiveRecord.filePath) || null,
    repoRelativePath: normalizeRepoRelativePath(effectiveRecord.repoRelativePath || stable?.repoRelativePath) || null,
    startLine: stable?.startLine ?? effectiveRecord.startLine ?? null,
    startColumn: stable?.startColumn ?? effectiveRecord.startColumn ?? null,
    endLine: stable?.endLine ?? effectiveRecord.endLine ?? null,
    endColumn: stable?.endColumn ?? effectiveRecord.endColumn ?? null,
    stableIdSuffix: stable?.suffix ?? effectiveRecord.stableIdSuffix ?? null,
  };
}

function hasFunctionCoordinateDiff(sourceSnapshot, graphSnapshot) {
  if (!sourceSnapshot?.stableId) {
    return false;
  }

  if (!graphSnapshot?.stableId) {
    return true;
  }

  return sourceSnapshot.stableId !== graphSnapshot.stableId
    || sourceSnapshot.sourceStateId !== graphSnapshot.sourceStateId
    || sourceSnapshot.filePath !== graphSnapshot.filePath
    || sourceSnapshot.repoRelativePath !== graphSnapshot.repoRelativePath
    || sourceSnapshot.startLine !== graphSnapshot.startLine
    || sourceSnapshot.startColumn !== graphSnapshot.startColumn
    || sourceSnapshot.endLine !== graphSnapshot.endLine
    || sourceSnapshot.endColumn !== graphSnapshot.endColumn
    || sourceSnapshot.stableIdSuffix !== graphSnapshot.stableIdSuffix;
}

function hasImportedFunctionFlow(functionFlow) {
  return Boolean(functionFlow?.stableId && functionFlow?.stepIds?.length);
}

async function runFunctionFlowImporter({ stableId, allFunctions = false }) {
  const pythonCli = resolveGraphPythonCli();
  if (!pythonCli) {
    throw new Error('Could not resolve a Python executable for function flow import.');
  }

  const importerPath = path.resolve(process.cwd(), 'graph', 'static-extract', 'py', 'fromPreGraphToNeo4j.py');
  const importerArgs = allFunctions
    ? [importerPath, 'func']
    : [importerPath, 'func', '--fn-stable-id', stableId];

  await execFileAsync(
    pythonCli,
    importerArgs,
    { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 },
  );
}

async function ensureFunctionPreGraphImported(stableId) {
  await runFunctionFlowImporter({ stableId });
}

export async function reimportFunctionFlow(driver, database, {
  stableId,
  name,
  repoRelativePath,
  repair = true,
  allFunctions = false,
}) {
  if (allFunctions) {
    await runFunctionFlowImporter({ allFunctions: true });

    return {
      stableId: '__all_functions__',
      requestedStableId: stableId || undefined,
      name: 'ALL_FUNCTIONS',
      repoRelativePath: undefined,
      changed: false,
      imported: true,
    };
  }

  let resolvedStableId = stableId;
  let resolvedEntity;

  if (resolvedStableId) {
    resolvedEntity = await loadFunctionEntity(driver, database, resolvedStableId);

    if (repair && !resolvedEntity?.name && name) {
      resolvedEntity = await resolveFunctionEntity(driver, database, {
        name,
        repoRelativePath,
        ensureFlow: false,
      });
      resolvedStableId = resolvedEntity?.stableId || resolvedStableId;
    }
  } else if (name) {
    resolvedEntity = await resolveFunctionEntity(driver, database, {
      name,
      repoRelativePath,
      ensureFlow: false,
    });
    resolvedStableId = resolvedEntity?.stableId;
  }

  if (!resolvedStableId) {
    return {
      stableId: stableId || '__unresolved__',
      requestedStableId: stableId || undefined,
      name: name || undefined,
      repoRelativePath: repoRelativePath || undefined,
      changed: false,
      imported: false,
    };
  }

  await runFunctionFlowImporter({ stableId: resolvedStableId });

  const importedEntity = await resolveFunctionEntity(driver, database, {
    stableId: resolvedStableId,
    ensureFlow: false,
  });
  const importedFlow = await loadFunctionFlow(driver, database, resolvedStableId);

  return {
    stableId: resolvedStableId,
    requestedStableId: stableId || undefined,
    name: importedEntity?.name || name || undefined,
    repoRelativePath: importedEntity?.repoRelativePath || repoRelativePath || undefined,
    changed: Boolean(stableId && resolvedStableId !== stableId),
    imported: hasImportedFunctionFlow(importedFlow),
  };
}

async function ensureFunctionFlowByName(driver, database, { name, repoRelativePath, ensureFlow = true }) {
  const candidate = await resolveFunctionCandidateByName(driver, database, { name, repoRelativePath });
  if (!candidate?.stableId) {
    return null;
  }

  let functionFlow = await loadFunctionFlow(driver, database, candidate.stableId);
  if (!hasImportedFunctionFlow(functionFlow) && ensureFlow) {
    await ensureFunctionPreGraphImported(candidate.stableId);
    functionFlow = await loadFunctionFlow(driver, database, candidate.stableId);
  }

  return {
    stableId: candidate.stableId,
    functionFlow,
  };
}

export async function ensureFunctionFlowResolved(driver, database, {
  stableId,
  name,
  repoRelativePath,
  ensureFlow = true,
}) {
  if (stableId) {
    let functionFlow = await loadFunctionFlow(driver, database, stableId);
    if (!hasImportedFunctionFlow(functionFlow) && ensureFlow) {
      await ensureFunctionPreGraphImported(stableId);
      functionFlow = await loadFunctionFlow(driver, database, stableId);
    }

    return functionFlow;
  }

  if (!name) {
    throw new Error('Function resolution requires stableId or name');
  }

  const resolved = await ensureFunctionFlowByName(driver, database, { name, repoRelativePath, ensureFlow });
  return resolved?.functionFlow || null;
}

export async function resolveFunctionEntity(driver, database, {
  stableId,
  name,
  repoRelativePath,
  ensureFlow = false,
}) {
  if (stableId) {
    if (ensureFlow) {
      await ensureFunctionFlowResolved(driver, database, { stableId, ensureFlow: true });
    }

    return loadFunctionEntity(driver, database, stableId);
  }

  if (!name) {
    throw new Error('Function resolution requires stableId or name');
  }

  const candidate = await resolveFunctionCandidateByName(driver, database, { name, repoRelativePath });
  if (!candidate?.stableId) {
    return null;
  }

  if (ensureFlow) {
    await ensureFunctionFlowResolved(driver, database, {
      stableId: candidate.stableId,
      name,
      repoRelativePath,
      ensureFlow: true,
    });
  }

  const entity = await loadFunctionEntity(driver, database, candidate.stableId);
  if (entity?.name || entity?.repoRelativePath) {
    return entity;
  }

  return {
    stableId: getStableIdKey(candidate.stableId) || null,
    stable: buildStableIdDescriptorFromRecord(candidate),
    name: candidate.name || null,
    label: candidate.label || candidate.name || null,
    repoRelativePath: candidate.repoRelativePath || buildStableIdLocation(candidate)?.repoRelativePath || null,
  };
}

export async function resolveFunctionActualCoordinates(driver, database, {
  stableId,
  name,
  repoRelativePath,
  filePath,
  line,
  startLine,
  startColumn,
  endLine,
  endColumn,
  repairGraph = false,
  ensureFlow = false,
} = {}) {
  const hasSourceCoordinateHint = hasLineHint(line) || hasLineHint(startLine) || hasExactCoordinateHint({
    startLine,
    startColumn,
    endLine,
    endColumn,
  });
  const graphEntity = stableId
    ? await loadFunctionEntity(driver, database, stableId)
    : hasSourceCoordinateHint
      ? null
      : await resolveFunctionEntity(driver, database, {
        name,
        repoRelativePath,
        ensureFlow: false,
      });
  const graphSnapshot = buildFunctionCoordinateSnapshot(graphEntity, graphEntity?.stable || stableId);
  const resolvedName = name || graphEntity?.name;
  const resolvedRepoRelativePath = normalizeRepoRelativePath(
    repoRelativePath || graphEntity?.repoRelativePath || graphSnapshot.repoRelativePath,
  );
  const resolvedFilePath = normalizeFilePath(filePath || graphEntity?.filePath || graphSnapshot.filePath);

  if (!resolvedName) {
    return {
      requestedStableId: stableId || null,
      existingStableId: graphSnapshot.stableId,
      graphSourceStateId: graphSnapshot.sourceStateId,
      graphFilePath: graphSnapshot.filePath,
      graphRepoRelativePath: graphSnapshot.repoRelativePath,
      graphStartLine: graphSnapshot.startLine,
      graphStartColumn: graphSnapshot.startColumn,
      graphEndLine: graphSnapshot.endLine,
      graphEndColumn: graphSnapshot.endColumn,
      existingStableIdSuffix: graphSnapshot.stableIdSuffix,
      found: false,
      changed: false,
      matchesGraph: Boolean(graphSnapshot.stableId),
      repaired: false,
      strategy: 'missing-function-name',
      fn: graphEntity?.stableId ? graphEntity : null,
      name: null,
      stableId: graphSnapshot.stableId,
      sourceStateId: graphSnapshot.sourceStateId,
      filePath: graphSnapshot.filePath,
      repoRelativePath: graphSnapshot.repoRelativePath,
      startLine: graphSnapshot.startLine,
      startColumn: graphSnapshot.startColumn,
      endLine: graphSnapshot.endLine,
      endColumn: graphSnapshot.endColumn,
      stableIdSuffix: graphSnapshot.stableIdSuffix,
    };
  }

  const extractedCandidates = await extractFunctionCandidatesByName(resolvedName);
  const extractedCandidate = selectFunctionCandidate(extractedCandidates, {
    name: resolvedName,
    repoRelativePath: resolvedRepoRelativePath,
    filePath: resolvedFilePath,
    stableId: stableId || graphSnapshot.stableId,
    line,
    startLine: startLine ?? graphSnapshot.startLine,
    startColumn: startColumn ?? graphSnapshot.startColumn,
    endLine: endLine ?? graphSnapshot.endLine,
    endColumn: endColumn ?? graphSnapshot.endColumn,
  });

  if (!extractedCandidate?.stableId) {
    return {
      requestedStableId: stableId || null,
      existingStableId: graphSnapshot.stableId,
      graphSourceStateId: graphSnapshot.sourceStateId,
      graphFilePath: graphSnapshot.filePath,
      graphRepoRelativePath: graphSnapshot.repoRelativePath,
      graphStartLine: graphSnapshot.startLine,
      graphStartColumn: graphSnapshot.startColumn,
      graphEndLine: graphSnapshot.endLine,
      graphEndColumn: graphSnapshot.endColumn,
      existingStableIdSuffix: graphSnapshot.stableIdSuffix,
      found: false,
      changed: false,
      matchesGraph: Boolean(graphSnapshot.stableId),
      repaired: false,
      strategy: 'source-extractor-no-match',
      fn: graphEntity?.stableId ? graphEntity : null,
      name: resolvedName,
      stableId: graphSnapshot.stableId,
      sourceStateId: graphSnapshot.sourceStateId,
      filePath: graphSnapshot.filePath,
      repoRelativePath: resolvedRepoRelativePath || graphSnapshot.repoRelativePath,
      startLine: graphSnapshot.startLine,
      startColumn: graphSnapshot.startColumn,
      endLine: graphSnapshot.endLine,
      endColumn: graphSnapshot.endColumn,
      stableIdSuffix: graphSnapshot.stableIdSuffix,
    };
  }

  const sourceSnapshot = buildFunctionCoordinateSnapshot(extractedCandidate, extractedCandidate.stable || extractedCandidate.stableId);
  const changed = hasFunctionCoordinateDiff(sourceSnapshot, graphSnapshot);
  let resolvedStableId = sourceSnapshot.stableId;
  let repaired = false;
  let fn = graphEntity?.stableId ? graphEntity : null;

  if (repairGraph && changed) {
    const repairResult = await reimportFunctionFlow(driver, database, {
      stableId: graphSnapshot.stableId || stableId,
      name: resolvedName,
      repoRelativePath: resolvedRepoRelativePath,
      repair: true,
    });

    resolvedStableId = repairResult?.stableId || resolvedStableId;
    repaired = Boolean(repairResult?.imported);
    fn = resolvedStableId
      ? await resolveFunctionEntity(driver, database, { stableId: resolvedStableId, ensureFlow })
      : null;
  } else if (ensureFlow && resolvedStableId) {
    fn = await resolveFunctionEntity(driver, database, { stableId: resolvedStableId, ensureFlow });
  }

  return {
    requestedStableId: stableId || null,
    existingStableId: graphSnapshot.stableId,
    graphSourceStateId: graphSnapshot.sourceStateId,
    graphFilePath: graphSnapshot.filePath,
    graphRepoRelativePath: graphSnapshot.repoRelativePath,
    graphStartLine: graphSnapshot.startLine,
    graphStartColumn: graphSnapshot.startColumn,
    graphEndLine: graphSnapshot.endLine,
    graphEndColumn: graphSnapshot.endColumn,
    existingStableIdSuffix: graphSnapshot.stableIdSuffix,
    found: true,
    changed,
    matchesGraph: !changed,
    repaired,
    strategy: 'source-extractor-by-name-and-path',
    fn,
    name: resolvedName,
    stableId: resolvedStableId,
    stable: sourceSnapshot.stable,
    sourceStateId: sourceSnapshot.sourceStateId,
    filePath: sourceSnapshot.filePath,
    repoRelativePath: sourceSnapshot.repoRelativePath,
    startLine: sourceSnapshot.startLine,
    startColumn: sourceSnapshot.startColumn,
    endLine: sourceSnapshot.endLine,
    endColumn: sourceSnapshot.endColumn,
    stableIdSuffix: sourceSnapshot.stableIdSuffix,
  };
}

function normalizeStableIdFilePath(filePath) {
  const normalizedPath = String(filePath || '').trim().replace(/\\/g, '/');
  if (!normalizedPath) {
    throw new Error('filePath is required to build stableId');
  }

  if (/^[A-Za-z]:\//.test(normalizedPath) || normalizedPath.startsWith('/')) {
    return normalizedPath;
  }

  return path.resolve(process.cwd(), normalizedPath).replace(/\\/g, '/');
}

function parseStableIdCoordinate(value, label) {
  const numericValue = Number(value);
  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }

  return numericValue;
}

export function buildStableIdFromCoordinates({ filePath, startLine, startColumn, endLine, endColumn }) {
  const normalizedFilePath = normalizeStableIdFilePath(filePath);
  const resolvedStartLine = parseStableIdCoordinate(startLine, 'startLine');
  const resolvedStartColumn = parseStableIdCoordinate(startColumn, 'startColumn');
  const resolvedEndLine = parseStableIdCoordinate(endLine ?? startLine, 'endLine');
  const resolvedEndColumn = parseStableIdCoordinate(endColumn ?? startColumn, 'endColumn');

  return `${normalizedFilePath}:${resolvedStartLine}:${resolvedStartColumn}:${resolvedEndLine}:${resolvedEndColumn}`;
}

async function loadFunctionEntity(driver, database, stableId) {
  const records = await runReadQuery(
    driver,
    database,
    `
      MATCH (fn:Fn {stableId: $stableId})
      RETURN fn.stableId AS stableId,
             fn.source_state_id AS sourceStateId,
             fn.file_path AS filePath,
             fn.start_line AS startLine,
             fn.start_column AS startColumn,
             fn.end_line AS endLine,
             fn.end_column AS endColumn,
             fn.stableIdSuffix AS stableIdSuffix,
              fn.name AS name,
             fn.label AS label,
             fn.repo_relative_path AS repoRelativePath,
             coalesce(fn.business_object_keys, []) AS businessObjectKeys,
             coalesce(fn.business_object_roles, []) AS businessObjectRoles,
             fn.business_object_summary_json AS businessObjectSummaryJson
      LIMIT 1
    `,
    { stableId },
  );

  if (records[0]?.stableId) {
    const stable = buildStableIdDescriptorFromRecord(records[0]);
    return {
      ...records[0],
      stable,
      repoRelativePath: records[0].repoRelativePath || stable?.repoRelativePath || null,
      businessObjectKeys: normalizeBusinessObjectList(records[0].businessObjectKeys),
      businessObjectRoles: normalizeBusinessObjectList(records[0].businessObjectRoles),
    };
  }

  return {
    stableId,
    name: null,
    label: null,
    repoRelativePath: null,
    businessObjectKeys: [],
    businessObjectRoles: [],
    businessObjectSummaryJson: null,
  };
}

async function loadFunctionFlow(driver, database, stableId) {
  const records = await runReadQuery(
    driver,
    database,
    `
      MATCH (fn:Fn {stableId: $stableId})
      OPTIONAL MATCH (step:Step {parentFnStableId: $stableId})
      RETURN fn.stableId AS stableId,
              fn.source_state_id AS sourceStateId,
              fn.file_path AS filePath,
              fn.start_line AS startLine,
              fn.start_column AS startColumn,
              fn.end_line AS endLine,
              fn.end_column AS endColumn,
              fn.stableIdSuffix AS stableIdSuffix,
             fn.label AS label,
             fn.repo_relative_path AS repoRelativePath,
             collect(step.stableId) AS stepIds
    `,
    { stableId },
  );
  const record = records[0];
  if (!record?.stableId) {
    return null;
  }

  const stable = buildStableIdDescriptorFromRecord(record);
  return {
    ...record,
    stable,
    repoRelativePath: record.repoRelativePath || stable?.repoRelativePath || null,
    stepIds: (record.stepIds || []).filter(Boolean),
  };
}

export async function findLatestSessionIdForFunctions(runtimeStore, stableIds) {
  return findLatestSessionIdForFunctionsInRedis(assertRedisRuntimeStoreConfig(runtimeStore), stableIds);
}

export async function loadFeatureRuntimeCoverage(runtimeStore, stableIds, {
  sessionId,
  useLatestSessionIfMissing = true,
} = {}) {
  return loadFeatureRuntimeCoverageFromRedis(assertRedisRuntimeStoreConfig(runtimeStore), stableIds, {
    sessionId,
    useLatestSessionIfMissing,
  });
}

export async function loadFunctionRuntimeLogs(runtimeStore, driver, database, stableId, { limit = 100, sessionId } = {}) {
  try {
    const safeRuntimeStore = assertRedisRuntimeStoreConfig(runtimeStore);
    const resolvedSessionId = sessionId || await findLatestSessionIdForFunctionsInRedis(safeRuntimeStore, [stableId]);
    if (!resolvedSessionId) {
      return {
        available: true,
        error: null,
        sessionId: null,
        eventCount: 0,
        events: [],
      };
    }

    const records = await fetchRuntimeEventRecords(safeRuntimeStore, {
      limit: Math.max(1, Math.min(limit, 500)),
      sessionId: resolvedSessionId,
      ownerFnStableId: stableId,
    });
    const enriched = await enrichRuntimeEventRecords(driver, database, records);
    const events = enriched.filter((record) => record.ownerFnStableId === stableId);

    return {
      available: true,
      error: null,
      sessionId: resolvedSessionId,
      eventCount: events.length,
      events,
    };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
      sessionId: null,
      eventCount: 0,
      events: [],
    };
  }
}

function uniq(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function toTitleCase(value) {
  const normalized = normalizeText(value)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : 'Unknown';
}

function shortenText(value, maxLength = 120) {
  const normalized = normalizeText(value);
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function getStepDisplayText(step) {
  return normalizeText(
    step?.operationCalleeText
    || step?.actionTextRaw
    || step?.conditionRaw
    || step?.label
    || step?.operationValueText
    || step?.operationSubjectText
    || 'unknown',
  );
}

function parseStableCoordinates(stableId) {
  if (!stableId) {
    return null;
  }

  return buildStableIdLocation({ stableId }) || null;
}

function sortJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, sortJsonValue(value[key])]),
    );
  }

  return value;
}

function createJsonSignature(value) {
  return JSON.stringify(sortJsonValue(value ?? null));
}

function deriveRepoSurface(repoRelativePath) {
  if (!repoRelativePath) {
    return null;
  }

  const normalizedPath = repoRelativePath.replace(/\\/g, '/').replace(/\.[^.]+$/, '');
  const segments = normalizedPath.split('/').filter(Boolean);

  if (normalizedPath.startsWith('src/components/')) {
    return segments.slice(0, Math.min(4, segments.length)).join('/');
  }

  if (normalizedPath.startsWith('src/global/actions/')) {
    return segments.slice(0, Math.min(4, segments.length)).join('/');
  }

  if (normalizedPath.startsWith('src/api/gramjs/methods/')) {
    return normalizedPath;
  }

  if (segments.length <= 1) {
    return normalizedPath;
  }

  return segments.slice(0, segments.length - 1).join('/');
}

function sortEventsChronologically(events) {
  return [...events].sort((left, right) => {
    const leftTime = left?.ingestedAt ? Date.parse(left.ingestedAt) : 0;
    const rightTime = right?.ingestedAt ? Date.parse(right.ingestedAt) : 0;
    return leftTime - rightTime;
  });
}

function buildTraceInputSummary(events) {
  const orderedEvents = sortEventsChronologically(events);
  const requestCarrier = orderedEvents.find((event) => {
    const requestProps = event?.requestProps;
    return requestProps && (typeof requestProps !== 'object' || Object.keys(requestProps).length > 0);
  });
  if (requestCarrier?.requestProps) {
    return requestCarrier.requestProps;
  }

  const topLevelKeys = uniq(orderedEvents.map((event) => event?.topLevelKey));
  const resourceIds = uniq(orderedEvents.map((event) => event?.resourceId));
  const resourceSemanticIds = uniq(orderedEvents.map((event) => event?.resourceSemanticId));
  const resourceSemanticDetailIds = uniq(orderedEvents.map((event) => event?.resourceSemanticDetailId));

  if (!topLevelKeys.length && !resourceIds.length && !resourceSemanticIds.length && !resourceSemanticDetailIds.length) {
    return null;
  }

  return {
    topLevelKeys,
    resourceIds,
    resourceSemanticIds,
    resourceSemanticDetailIds,
  };
}

function dedupeEvents(events) {
  const seen = new Set();

  return events.filter((event) => {
    const key = event?.nodeId || `${event?.ingestedAt || ''}:${event?.kind || ''}:${event?.staticStepId || ''}:${event?.correlationId || ''}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function isSourceFunctionEvent(event, stableId) {
  return event?.ownerFnStableId === stableId;
}

function getBranchOutcome(events) {
  const evidenceKinds = uniq(events.map((event) => event?.fnName || event?.kind));

  if (events.some((event) => event?.kind === 'then' || event?.fnName === 'then')) {
    return { outcome: 'then', evidenceKinds };
  }

  if (events.some((event) => event?.kind === 'else' || event?.fnName === 'else')) {
    return { outcome: 'else', evidenceKinds };
  }

  if (events.some((event) => event?.kind === 'branch-hit' || event?.fnName === 'branch-hit')) {
    return { outcome: 'taken', evidenceKinds };
  }

  if (events.some((event) => ['predicate-eval', 'decision'].includes(event?.kind))) {
    return { outcome: 'evaluated', evidenceKinds };
  }

  return { outcome: 'not-observed', evidenceKinds };
}

async function loadFunctionBranchPoints(driver, database, stableId) {
  const records = await runReadQuery(
    driver,
    database,
    `
      MATCH (step:Step {parentFnStableId: $stableId})
      WHERE step:Branch OR step:Switch OR step:Case OR coalesce(step.condition_raw, '') <> ''
      OPTIONAL MATCH (step)-[rel]->()
      RETURN step.stableId AS stepId,
             step.label AS label,
             step.condition_raw AS conditionRaw,
             step.operation_code AS operationCode,
              step.operation_index AS operationIndex,
             collect(DISTINCT coalesce(rel.label, type(rel))) AS outgoingLabels
            ORDER BY operationIndex, stepId
    `,
    { stableId },
  );

  return records.map((record) => {
    const coordinates = parseStableCoordinates(record.stepId) || {};

    return {
      ...record,
      startLine: coordinates.startLine || null,
      startColumn: coordinates.startColumn || null,
      endLine: coordinates.endLine || null,
      endColumn: coordinates.endColumn || null,
      outgoingLabels: (record.outgoingLabels || []).filter(Boolean),
    };
  });
}

async function loadFunctionOutgoingConnections(driver, database, stableId, sourceRepoRelativePath) {
  const records = await runReadQuery(
    driver,
    database,
    `
      MATCH (step:Step {parentFnStableId: $stableId})-[rel]->(target:Fn)
      WHERE target.stableId <> $stableId
      RETURN step.stableId AS stepId,
              step.operation_index AS operationIndex,
             rel.call_text_raw AS callTextRaw,
             coalesce(rel.label, type(rel)) AS edgeLabel,
             target.stableId AS targetStableId,
             target.name AS targetName,
             target.label AS targetLabel,
             target.repo_relative_path AS targetRepoRelativePath
            ORDER BY operationIndex, stepId, targetStableId
    `,
    { stableId },
  );

  const sourceSurface = deriveRepoSurface(sourceRepoRelativePath);

  return records.map((record) => {
    const targetRepoRelativePath = record.targetRepoRelativePath || buildStableIdLocation({ stableId: record.targetStableId })?.repoRelativePath;
    const targetSurface = deriveRepoSurface(targetRepoRelativePath);

    return {
      ...record,
      targetRepoRelativePath,
      sourceSurface,
      targetSurface,
      crossComponent: Boolean(sourceSurface && targetSurface && sourceSurface !== targetSurface),
    };
  });
}

async function fetchExecutionTraceEvents(runtimeStore, driver, database, {
  sessionId,
  ownerFnStableId,
  correlationIds = [],
  resourceIds = [],
  resourceSemanticIds = [],
  resourceSemanticDetailIds = [],
  limit = 500,
}) {
  const hasScope = Boolean(
    ownerFnStableId
    || correlationIds.length
    || resourceIds.length
    || resourceSemanticIds.length
    || resourceSemanticDetailIds.length
  );

  if (!hasScope) {
    return [];
  }

  const safeRuntimeStore = assertRedisRuntimeStoreConfig(runtimeStore);
  const records = await fetchRuntimeEventRecords(safeRuntimeStore, {
    sessionId,
    limit: Math.max(1, Math.min(limit, 2_000)),
  });

  const ownerFnStableIdSet = new Set(ownerFnStableId ? [ownerFnStableId] : []);
  const correlationIdSet = new Set(correlationIds.filter(Boolean));
  const resourceIdSet = new Set(resourceIds.filter(Boolean));
  const resourceSemanticIdSet = new Set(resourceSemanticIds.filter(Boolean));
  const resourceSemanticDetailIdSet = new Set(resourceSemanticDetailIds.filter(Boolean));
  const filteredRecords = records.filter((record) => (
    ownerFnStableIdSet.has(record.ownerFnStableId)
    || correlationIdSet.has(record.correlationId)
    || resourceIdSet.has(record.resourceId)
    || resourceSemanticIdSet.has(record.resourceSemanticId)
    || resourceSemanticDetailIdSet.has(record.resourceSemanticDetailId)
  ));

  if (!filteredRecords.length) {
    return [];
  }

  const enriched = await enrichRuntimeEventRecords(driver, database, filteredRecords);
  const enrichedByNodeId = new Map(enriched.map((record) => [record.nodeId, record]));

  return filteredRecords.map((record) => {
    const enrichedRecord = enrichedByNodeId.get(record.nodeId) || {};

    return {
      ...record,
      ...enrichedRecord,
      requestProps: record.requestProps || null,
      responseProps: record.responseProps || null,
    };
  });
}

function buildTraceBuckets(sourceEvents) {
  const seedEvents = sourceEvents.filter((event) => (
    event?.correlationId
    || event?.resourceId
    || event?.resourceSemanticId
    || event?.resourceSemanticDetailId
    || event?.requestProps
    || event?.topLevelKey
  ));
  const selectedSeedEvents = seedEvents.length ? seedEvents : sourceEvents;
  const buckets = new Map();

  for (const event of selectedSeedEvents) {
    const inputSummary = event.requestProps || (event.topLevelKey ? { topLevelKey: event.topLevelKey } : null);
    const inputSignature = createJsonSignature(inputSummary || {
      correlationId: event.correlationId || null,
      resourceId: event.resourceId || null,
      resourceSemanticId: event.resourceSemanticId || null,
      resourceSemanticDetailId: event.resourceSemanticDetailId || null,
    });
    const traceKey = [event.correlationId || '', event.resourceId || '', event.resourceSemanticId || '', event.resourceSemanticDetailId || '', inputSignature].join('|');
    const existing = buckets.get(traceKey);
    if (existing) {
      existing.seedEvents.push(event);
      continue;
    }

    buckets.set(traceKey, {
      traceKey,
      correlationId: event.correlationId || null,
      resourceId: event.resourceId || null,
      resourceSemanticId: event.resourceSemanticId || null,
      resourceSemanticDetailId: event.resourceSemanticDetailId || null,
      inputSignature,
      seedEvents: [event],
    });
  }

  return [...buckets.values()];
}

export async function loadFunctionExecutionBranches(runtimeStore, driver, database, stableId, {
  sessionId,
  limit = 200,
} = {}) {
  const functionEntity = await loadFunctionEntity(driver, database, stableId);
  const [branchPoints, outgoingConnections] = await Promise.all([
    loadFunctionBranchPoints(driver, database, stableId),
    loadFunctionOutgoingConnections(driver, database, stableId, functionEntity.repoRelativePath),
  ]);
  const resolvedSessionId = sessionId || await findLatestSessionIdForFunctions(runtimeStore, [stableId]);

  if (!resolvedSessionId) {
    return {
      fnStableId: stableId,
      fnName: functionEntity.name,
      label: functionEntity.label,
      repoRelativePath: functionEntity.repoRelativePath,
      sessionId: null,
      branchPointCount: branchPoints.length,
      outgoingConnectionCount: outgoingConnections.length,
      traceCount: 0,
      branchPoints,
      outgoingConnections,
      traces: [],
    };
  }

  const sourceEvents = await fetchExecutionTraceEvents(runtimeStore, driver, database, {
    sessionId: resolvedSessionId,
    ownerFnStableId: stableId,
    limit: Math.max(limit, 500),
  });
  const correlationIds = uniq(sourceEvents.map((event) => event.correlationId));
  const resourceIds = uniq(sourceEvents.map((event) => event.resourceId));
  const resourceSemanticIds = uniq(sourceEvents.map((event) => event.resourceSemanticId));
  const resourceSemanticDetailIds = uniq(sourceEvents.map((event) => event.resourceSemanticDetailId));
  const expandedEvents = await fetchExecutionTraceEvents(runtimeStore, driver, database, {
    sessionId: resolvedSessionId,
    ownerFnStableId: stableId,
    correlationIds,
    resourceIds,
    resourceSemanticIds,
    resourceSemanticDetailIds,
    limit: Math.max(limit * 4, 500),
  });
  const branchPointIds = new Set(branchPoints.map((point) => point.stepId));
  const outgoingTargetIds = new Set(outgoingConnections.map((connection) => connection.targetStableId));
  const relevantEvents = dedupeEvents(expandedEvents.filter((event) => (
    isSourceFunctionEvent(event, stableId)
    || branchPointIds.has(event.staticStepId)
    || outgoingTargetIds.has(event.ownerFnStableId)
  )));

  const traces = buildTraceBuckets(sourceEvents).map((bucket) => {
    const relatedEvents = sortEventsChronologically(relevantEvents.filter((event) => {
      if (bucket.correlationId && event.correlationId === bucket.correlationId) {
        return true;
      }

      if (bucket.resourceId && event.resourceId === bucket.resourceId) {
        return true;
      }

      if (bucket.resourceSemanticDetailId) {
        return event.resourceSemanticDetailId === bucket.resourceSemanticDetailId;
      }

      if (bucket.resourceSemanticId && event.resourceSemanticId === bucket.resourceSemanticId) {
        return true;
      }

      return !bucket.correlationId && !bucket.resourceId && !bucket.resourceSemanticId && !bucket.resourceSemanticDetailId
        && isSourceFunctionEvent(event, stableId);
    }));
    const sourceRelatedEvents = relatedEvents.filter((event) => isSourceFunctionEvent(event, stableId));
    const inputSummary = buildTraceInputSummary(sourceRelatedEvents.length ? sourceRelatedEvents : bucket.seedEvents);
    const inputSignature = createJsonSignature(inputSummary || {
      correlationId: bucket.correlationId || null,
      resourceId: bucket.resourceId || null,
      resourceSemanticId: bucket.resourceSemanticId || null,
      resourceSemanticDetailId: bucket.resourceSemanticDetailId || null,
    });
    const branchOutcomes = branchPoints.map((branchPoint) => {
      const evidence = relatedEvents.filter((event) => event.staticStepId === branchPoint.stepId);
      const outcome = getBranchOutcome(evidence);

      return {
        stepId: branchPoint.stepId,
        conditionRaw: branchPoint.conditionRaw,
        outcome: outcome.outcome,
        evidenceKinds: outcome.evidenceKinds,
      };
    });
    const downstreamCalls = outgoingConnections.map((connection) => {
      const evidence = relatedEvents.filter((event) => event.ownerFnStableId === connection.targetStableId);

      return {
        stepId: connection.stepId,
        targetStableId: connection.targetStableId,
        targetName: connection.targetName,
        targetRepoRelativePath: connection.targetRepoRelativePath,
        observed: evidence.length > 0,
        eventKinds: uniq(evidence.map((event) => event.fnName || event.kind)),
        correlationIds: uniq(evidence.map((event) => event.correlationId)),
        resourceIds: uniq(evidence.map((event) => event.resourceId)),
        resourceSemanticIds: uniq(evidence.map((event) => event.resourceSemanticId)),
        resourceSemanticDetailIds: uniq(evidence.map((event) => event.resourceSemanticDetailId)),
      };
    });

    return {
      traceKey: bucket.traceKey,
      correlationId: bucket.correlationId,
      resourceId: bucket.resourceId,
      resourceSemanticId: bucket.resourceSemanticId,
      resourceSemanticDetailId: bucket.resourceSemanticDetailId,
      inputSignature,
      inputSummary,
      branchOutcomes,
      downstreamCalls,
      eventCount: relatedEvents.length,
      events: relatedEvents.map((event) => ({
        ingestedAt: event.ingestedAt,
        sessionId: event.sessionId,
        correlationId: event.correlationId,
        resourceId: event.resourceId,
        resourceSemanticId: event.resourceSemanticId,
        resourceSemanticDetailId: event.resourceSemanticDetailId,
        kind: event.kind,
        fnName: event.fnName,
        staticStepId: event.staticStepId,
        ownerFnStableId: event.ownerFnStableId,
        decisionId: event.decisionId,
        predicateId: event.predicateId,
        branchId: event.branchId,
        topLevelKey: event.topLevelKey,
        requestProps: event.requestProps,
        responseProps: event.responseProps,
      })),
    };
  }).filter((trace) => trace.eventCount > 0);

  return {
    fnStableId: stableId,
    fnName: functionEntity.name,
    label: functionEntity.label,
    repoRelativePath: functionEntity.repoRelativePath,
    sessionId: resolvedSessionId,
    branchPointCount: branchPoints.length,
    outgoingConnectionCount: outgoingConnections.length,
    traceCount: traces.length,
    branchPoints,
    outgoingConnections,
    traces,
  };
}

function filterRuntimeEvents(runtimeEvents, predicate) {
  return runtimeEvents.filter((event) => predicate(event, event?.kind, event?.fnName));
}

function isTelegramApiUpdateBoundaryEvent(event) {
  return event?.boundaryChannel === 'apiUpdate'
    || event?.kind === 'telegram-update-receive'
    || event?.kind === 'api-update-dispatch'
    || event?.kind === 'api-update-receive'
    || event?.asyncKind === 'telegram-update'
    || event?.asyncKind === 'api-update';
}

function isGenericFollowUpEvidence(_, kind) {
  return kind === 'call-dispatch' || kind === 'follow-up-call';
}

function summarizeExplainability(functionEntity, steps, runtimeLogs) {
  const stepCount = steps.length;
  const runtimeEvents = runtimeLogs.events || [];
  const runtimeMarkers = uniq(runtimeEvents.map((event) => event.kind));
  const hasTelegramApiBoundary = runtimeEvents.some(isTelegramApiUpdateBoundaryEvent);
  const hasParallelFetch = steps.some((step) => step.operationCalleeText === 'Promise.all');
  const hasGuard = steps.some((step) => step.label === 'if' || step.conditionRaw);
  const hasStateUpdate = steps.some((step) => (
    step.operationCalleeText === 'updateStickerSets'
    || step.operationCalleeText === 'updateCustomEmojiSets'
    || step.operationCalleeText === 'setGlobal'
  ));
  const hasFanOut = steps.some((step) => step.operationCalleeText?.startsWith('actions.'));

  if (hasParallelFetch && hasGuard && hasStateUpdate && hasFanOut) {
    return 'Loads data in parallel, guards on missing payloads, updates state, and triggers follow-up actions.';
  }

  if (hasTelegramApiBoundary) {
    return 'Combines semantic function-flow with runtime evidence across the Telegram update to apiUpdate boundary.';
  }

  if (runtimeMarkers.length && stepCount) {
    return 'Combines semantic function-flow with runtime evidence for the observed execution slice.';
  }

  if (stepCount) {
    return 'Derived from semantic function-flow only; runtime evidence is limited or absent.';
  }

  return functionEntity?.label || 'No explainability surface is available for this function yet.';
}

function buildExplainabilityBlocks(steps, runtimeLogs) {
  const runtimeEvents = runtimeLogs.events || [];
  const blocks = [];
  const makeRuntimeSummary = (events) => ({
    runtimeObserved: events.length > 0,
    runtimeMarkers: uniq(events.map((event) => event.kind)),
    correlationIds: uniq(events.map((event) => event.correlationId)),
    resourceIds: uniq(events.map((event) => event.resourceId)),
    resourceSemanticIds: uniq(events.map((event) => event.resourceSemanticId)),
    resourceSemanticDetailIds: uniq(events.map((event) => event.resourceSemanticDetailId)),
    evidenceCount: events.length,
  });

  const telegramApiBoundaryEvents = filterRuntimeEvents(runtimeEvents, (event) => isTelegramApiUpdateBoundaryEvent(event));
  if (telegramApiBoundaryEvents.length) {
    blocks.push({
      blockId: 'telegram_api_update_boundary',
      kind: 'runtime-boundary-chain',
      title: 'Bridge Telegram update to apiUpdate',
      purpose: 'Carry a server-side Telegram update through the runtime boundary into the local apiUpdate handler pipeline.',
      certainty: 'runtime-confirmed',
      entryStepId: null,
      exitStepId: null,
      stepIds: [],
      calls: uniq(telegramApiBoundaryEvents.map((event) => event.fnName || event.kind)),
      reads: uniq(telegramApiBoundaryEvents.map((event) => event.boundaryMessageType || event.resourceId).filter(Boolean)),
      writes: uniq(telegramApiBoundaryEvents.map((event) => event.boundaryChannel || event.boundaryTransport).filter(Boolean)),
      branchConditions: [],
      ...makeRuntimeSummary(telegramApiBoundaryEvents),
    });
  }

  const fetchSteps = steps.filter((step) => (
    step.operationCalleeText === 'callApi'
    || step.operationCalleeText === 'Promise.all'
    || step.actionTextRaw?.includes('fetchStickerSets')
    || step.actionTextRaw?.includes('fetchCustomEmojiSets')
  ));
  if (fetchSteps.length) {
    const events = filterRuntimeEvents(runtimeEvents, (event, kind, fnName) => (
      ['callApi', 'invokeRequest', 'worker-request-receive', 'api-method-forward-bind'].includes(kind)
      || (kind === 'call' && ['callApi', 'invokeRequest'].includes(fnName))
      || ['fetchStickerSets', 'fetchCustomEmojiSets'].includes(event.resourceId)
    ));
    blocks.push({
      blockId: 'fetch_pair',
      kind: 'parallel-fetch',
      title: 'Load remote payloads',
      purpose: 'Obtain the API payloads needed before any state update.',
      certainty: events.length ? 'runtime-confirmed' : 'static-fact',
      entryStepId: fetchSteps[0]?.stableId || null,
      exitStepId: fetchSteps.at(-1)?.stableId || null,
      stepIds: fetchSteps.map((step) => step.stableId),
      calls: uniq(fetchSteps.map((step) => step.operationCalleeText || step.actionTextRaw)),
      reads: uniq(fetchSteps.map((step) => step.operationSubjectText).filter(Boolean)),
      writes: [],
      branchConditions: [],
      ...makeRuntimeSummary(events),
    });
  }

  const guardSteps = steps.filter((step) => step.label === 'if' || step.conditionRaw);
  if (guardSteps.length) {
    const predicateEvents = filterRuntimeEvents(runtimeEvents, (_, kind, fnName) => (
      ['condition', 'IfDecision', 'then', 'else'].includes(kind)
      || ['predicate-eval', 'decision', 'branch-hit'].includes(kind)
      || ['condition', 'IfDecision', 'then', 'else'].includes(fnName)
    ));
    blocks.push({
      blockId: 'guard',
      kind: 'guard',
      title: 'Guard required payloads',
      purpose: 'Abort early when the required payloads are missing.',
      certainty: predicateEvents.length ? 'runtime-inferred' : 'static-fact',
      entryStepId: guardSteps[0]?.stableId || null,
      exitStepId: guardSteps.at(-1)?.stableId || null,
      stepIds: guardSteps.map((step) => step.stableId),
      calls: [],
      reads: uniq(guardSteps.map((step) => step.operationSubjectText)),
      writes: [],
      branchConditions: uniq(guardSteps.map((step) => step.conditionRaw).filter(Boolean)),
      ...makeRuntimeSummary(predicateEvents),
    });
  }

  const stateUpdateSteps = steps.filter((step) => (
    step.operationCalleeText === 'getGlobal'
    || step.operationCalleeText === 'updateStickerSets'
    || step.operationCalleeText === 'updateCustomEmojiSets'
    || step.operationCalleeText === 'setGlobal'
  ));
  if (stateUpdateSteps.length) {
    const events = filterRuntimeEvents(runtimeEvents, (_, kind, fnName) => (
      ['processAndUpdateEntities', 'sendToOrigin'].includes(kind)
      || (kind === 'call' && ['processAndUpdateEntities', 'sendToOrigin'].includes(fnName))
    ));
    blocks.push({
      blockId: 'state_update',
      kind: 'state-update',
      title: 'Update state',
      purpose: 'Refresh local state from the fetched payloads.',
      certainty: events.length ? 'runtime-inferred' : 'static-fact',
      entryStepId: stateUpdateSteps[0]?.stableId || null,
      exitStepId: stateUpdateSteps.at(-1)?.stableId || null,
      stepIds: stateUpdateSteps.map((step) => step.stableId),
      calls: uniq(stateUpdateSteps.map((step) => step.operationCalleeText || step.actionTextRaw)),
      reads: uniq(stateUpdateSteps.map((step) => step.operationSubjectText).filter(Boolean)),
      writes: uniq(stateUpdateSteps.map((step) => step.operationValueText || step.actionTextRaw)),
      branchConditions: [],
      ...makeRuntimeSummary(events),
    });
  }

  const stateUpdateRuntimeEvents = filterRuntimeEvents(runtimeEvents, (_, kind, fnName) => (
    ['processAndUpdateEntities', 'sendToOrigin'].includes(kind)
    || (kind === 'call' && ['processAndUpdateEntities', 'sendToOrigin'].includes(fnName))
  ));
  const successfulGuardEvents = filterRuntimeEvents(runtimeEvents, (_, kind, fnName) => (
    kind === 'then' || fnName === 'then' || kind === 'branch-hit' || fnName === 'branch-hit'
  ));

  const fanOutSteps = steps.filter((step) => step.operationCalleeText?.startsWith('actions.'));
  if (fanOutSteps.length) {
    const directEvents = filterRuntimeEvents(runtimeEvents, isGenericFollowUpEvidence);
    const events = directEvents.length
      ? directEvents
      : stateUpdateRuntimeEvents.length && successfulGuardEvents.length
        ? [{ kind: 'control-flow-inferred', fnName: 'post-state-update-fan-out' }]
        : [];
    blocks.push({
      blockId: 'fan_out',
      kind: 'fan-out-call',
      title: 'Trigger follow-up work',
      purpose: 'Start downstream loading that depends on the updated state.',
      certainty: directEvents.length ? 'runtime-confirmed' : events.length ? 'runtime-inferred' : 'static-fact',
      entryStepId: fanOutSteps[0]?.stableId || null,
      exitStepId: fanOutSteps.at(-1)?.stableId || null,
      stepIds: fanOutSteps.map((step) => step.stableId),
      calls: uniq(fanOutSteps.map((step) => step.operationCalleeText || step.actionTextRaw)),
      reads: uniq(fanOutSteps.map((step) => step.operationSubjectText).filter(Boolean)),
      writes: [],
      branchConditions: [],
      ...makeRuntimeSummary(events),
    });
  }

  return blocks;
}

function buildExplainabilityDecisions(steps, runtimeLogs) {
  const runtimeEvents = runtimeLogs.events || [];
  const predicateEvents = filterRuntimeEvents(runtimeEvents, (_, kind, fnName) => (
    ['condition', 'IfDecision', 'then', 'else'].includes(kind)
    || ['predicate-eval', 'decision', 'branch-hit'].includes(kind)
    || ['condition', 'IfDecision', 'then', 'else'].includes(fnName)
  ));

  return steps
    .filter((step) => step.label === 'if' || step.conditionRaw)
    .map((step, index) => ({
      decisionId: `decision_${index + 1}`,
      condition: step.conditionRaw || step.actionTextRaw || 'unknown',
      meaning: 'Branch outcome depends on this condition.',
      certainty: predicateEvents.length
        ? 'runtime-inferred'
        : 'static-fact',
      runtimeObserved: predicateEvents.length > 0,
      chosenOutcome: predicateEvents.some((event) => event.fnName === 'then' || event.kind === 'then' || event.fnName === 'else' || event.kind === 'else')
        ? (predicateEvents.some((event) => event.fnName === 'then' || event.kind === 'then') ? 'then' : 'else')
        : 'unknown',
      predicateEvidence: uniq(predicateEvents.map((event) => event.fnName || event.kind)),
      stepIds: [step.stableId],
    }));
}

function buildExplainabilityEffects(steps, runtimeLogs) {
  const runtimeEvents = runtimeLogs.events || [];
  const effects = [];
  const stateUpdateSteps = steps.filter((step) => (
    step.operationCalleeText === 'updateStickerSets'
    || step.operationCalleeText === 'updateCustomEmojiSets'
    || step.operationCalleeText === 'setGlobal'
  ));
  if (stateUpdateSteps.length) {
    effects.push({
      effectId: 'state_update_global',
      kind: 'state-update',
      target: 'global',
      meaning: 'Persist refreshed state derived from fetched payloads.',
      certainty: filterRuntimeEvents(runtimeEvents, (_, kind, fnName) => (
        ['processAndUpdateEntities', 'sendToOrigin'].includes(kind)
        || (kind === 'call' && ['processAndUpdateEntities', 'sendToOrigin'].includes(fnName))
      )).length
        ? 'runtime-inferred'
        : 'static-fact',
      runtimeMarkers: uniq(filterRuntimeEvents(runtimeEvents, (_, kind, fnName) => (
        ['processAndUpdateEntities', 'sendToOrigin'].includes(kind)
        || (kind === 'call' && ['processAndUpdateEntities', 'sendToOrigin'].includes(fnName))
      )).map((event) => event.fnName || event.kind)),
      stepIds: stateUpdateSteps.map((step) => step.stableId),
    });
  }

  const fanOutSteps = steps.filter((step) => step.operationCalleeText?.startsWith('actions.'));
  if (fanOutSteps.length) {
    const directEvents = filterRuntimeEvents(runtimeEvents, isGenericFollowUpEvidence);
    const inferredFanOutMarkers = directEvents.length
      ? directEvents.map((event) => event.fnName || event.resourceId || event.kind)
      : filterRuntimeEvents(runtimeEvents, (_, kind, fnName) => (
        ['processAndUpdateEntities', 'sendToOrigin'].includes(kind)
        || (kind === 'call' && ['processAndUpdateEntities', 'sendToOrigin'].includes(fnName))
      )).length && filterRuntimeEvents(runtimeEvents, (_, kind, fnName) => (
        kind === 'then' || fnName === 'then' || kind === 'branch-hit' || fnName === 'branch-hit'
      )).length
        ? ['control-flow-inferred']
        : [];
    effects.push({
      effectId: 'fan_out_action',
      kind: 'fan-out-call',
      target: fanOutSteps[0]?.operationCalleeText || 'follow-up',
      meaning: 'Trigger downstream work after the current function finishes its local update.',
      certainty: directEvents.length ? 'runtime-confirmed' : inferredFanOutMarkers.length ? 'runtime-inferred' : 'static-fact',
      runtimeMarkers: uniq(inferredFanOutMarkers),
      stepIds: fanOutSteps.map((step) => step.stableId),
    });
  }

  return effects;
}

export async function loadFunctionExplainability(runtimeStore, driver, database, stableId, {
  sessionId,
  limit = 100,
  runtimeLogs: runtimeLogsOverride,
} = {}) {
  const functionEntity = await loadFunctionEntity(driver, database, stableId);
  const functionFlow = await loadFunctionFlow(driver, database, stableId);
  const steps = functionFlow
    ? (await Promise.all((functionFlow.stepIds || []).map((stepId) => loadStep(driver, database, stepId)))).filter(Boolean)
    : [];
  const runtimeLogs = runtimeLogsOverride
    || await loadFunctionRuntimeLogs(runtimeStore, driver, database, stableId, { limit, sessionId });
  const blocks = buildExplainabilityBlocks(steps, runtimeLogs);
  const decisions = buildExplainabilityDecisions(steps, runtimeLogs);
  const effects = buildExplainabilityEffects(steps, runtimeLogs);
  const correlationIds = uniq(runtimeLogs.events?.map((event) => event.correlationId));
  const resourceIds = uniq(runtimeLogs.events?.map((event) => event.resourceId));
  const resourceSemanticIds = uniq(runtimeLogs.events?.map((event) => event.resourceSemanticId));
  const resourceSemanticDetailIds = uniq(runtimeLogs.events?.map((event) => event.resourceSemanticDetailId));
  const predicateEvents = filterRuntimeEvents(runtimeLogs.events || [], (_, kind, fnName) => (
    ['condition', 'IfDecision', 'then', 'else'].includes(kind)
    || ['predicate-eval', 'decision', 'branch-hit'].includes(kind)
    || ['condition', 'IfDecision', 'then', 'else'].includes(fnName)
  ));
  const openQuestions = [];
  if (!runtimeLogs.sessionId) {
    openQuestions.push('No runtime session was resolved for this function.');
  }
  if (!runtimeLogs.events?.length) {
    openQuestions.push('No runtime evidence was attached to the current explainability surface.');
  }
  if (decisions.length && !predicateEvents.length) {
    openQuestions.push('Branch outcomes remain static-only because runtime predicate evidence was not observed.');
  }

  return {
    fnStableId: stableId,
    fnName: functionEntity.name,
    label: functionEntity.label,
    repoRelativePath: functionEntity.repoRelativePath,
    runtimeScope: {
      sessionId: runtimeLogs.sessionId,
      correlationIds,
      resourceIds,
      resourceSemanticIds,
      resourceSemanticDetailIds,
      eventCount: runtimeLogs.eventCount,
      available: runtimeLogs.available,
      error: runtimeLogs.error,
    },
    summary: {
      whatThisFunctionDoes: summarizeExplainability(functionEntity, steps, runtimeLogs),
      staticCoverage: steps.length ? 1 : 0,
      runtimeCoverage: blocks.length ? Number((blocks.filter((block) => block.runtimeObserved).length / blocks.length).toFixed(3)) : 0,
    },
    blocks,
    decisions,
    effects,
    openQuestions,
  };
}

function buildCoverageTargets(explainability) {
  const targets = [];

  for (const block of explainability.blocks || []) {
    if (!block.runtimeObserved) {
      targets.push({
        targetId: `block:${block.blockId}`,
        category: 'block',
        title: `Cover block ${block.blockId}`,
        reason: `Semantic block \"${block.title}\" has no runtime evidence in the current scope.`,
        priority: block.kind === 'state-update' || block.kind === 'parallel-fetch' ? 'high' : 'medium',
        status: 'uncovered',
        blockId: block.blockId,
        decisionId: null,
        effectId: null,
        stepIds: block.stepIds || [],
        recommendedEvidenceKinds: block.kind === 'guard'
          ? ['condition', 'IfDecision', 'then', 'else']
          : block.kind === 'fan-out-call'
            ? ['call-dispatch', 'follow-up-call']
            : ['callApi', 'invokeRequest', 'processAndUpdateEntities', 'sendToOrigin'],
      });
    }
  }

  for (const decision of explainability.decisions || []) {
    if (!decision.runtimeObserved) {
      targets.push({
        targetId: `decision:${decision.decisionId}`,
        category: 'decision',
        title: `Resolve decision ${decision.decisionId}`,
        reason: `Branch condition \"${decision.condition}\" is present statically but has no runtime predicate evidence.`,
        priority: 'high',
        status: 'uncovered',
        blockId: null,
        decisionId: decision.decisionId,
        effectId: null,
        stepIds: decision.stepIds || [],
        recommendedEvidenceKinds: ['condition', 'IfDecision', 'then', 'else'],
      });
    }
  }

  for (const effect of explainability.effects || []) {
    if (!(effect.runtimeMarkers || []).length) {
      targets.push({
        targetId: `effect:${effect.effectId}`,
        category: 'effect',
        title: `Confirm effect ${effect.effectId}`,
        reason: `Effect \"${effect.meaning}\" has no direct runtime markers in the current scope.`,
        priority: effect.kind === 'state-update' ? 'high' : 'medium',
        status: 'uncovered',
        blockId: null,
        decisionId: null,
        effectId: effect.effectId,
        stepIds: effect.stepIds || [],
        recommendedEvidenceKinds: effect.kind === 'state-update'
          ? ['processAndUpdateEntities', 'sendToOrigin']
          : ['call-dispatch', 'follow-up-call'],
      });
    }
  }

  return targets;
}

export async function loadFunctionCoverageTargets(runtimeStore, driver, database, stableId, {
  sessionId,
  limit = 100,
  runtimeLogs,
} = {}) {
  const explainability = await loadFunctionExplainability(runtimeStore, driver, database, stableId, {
    sessionId,
    limit,
    runtimeLogs,
  });
  const targets = buildCoverageTargets(explainability);

  return {
    fnStableId: stableId,
    sessionId: explainability.runtimeScope.sessionId,
    targetCount: targets.length,
    targets,
  };
}

export async function loadStep(driver, database, stableId) {
  const records = await runReadQuery(
    driver,
    database,
    `
      MATCH (step:Step {stableId: $stableId})
      RETURN step.stableId AS stableId,
             step.source_state_id AS sourceStateId,
             step.file_path AS filePath,
             step.start_line AS startLine,
             step.start_column AS startColumn,
             step.end_line AS endLine,
             step.end_column AS endColumn,
             step.stableIdSuffix AS stableIdSuffix,
             labels(step) AS labels,
             step.label AS label,
              step.operation_index AS operationIndex,
              step.operation_code AS operationCode,
              step.operation_subject_text AS operationSubjectText,
              step.operation_value_text AS operationValueText,
              step.operation_callee_text AS operationCalleeText,
             step.condition_raw AS conditionRaw,
             step.action_text_raw AS actionTextRaw,
             coalesce(step.business_object_keys, []) AS businessObjectKeys,
             coalesce(step.business_object_roles, []) AS businessObjectRoles,
             step.business_object_summary_json AS businessObjectSummaryJson
    `,
    { stableId },
  );

  if (!records[0]) {
    return null;
  }

  const stable = buildStableIdDescriptorFromRecord(records[0]);
  return {
    ...records[0],
    stable,
    businessObjectKeys: normalizeBusinessObjectList(records[0].businessObjectKeys),
    businessObjectRoles: normalizeBusinessObjectList(records[0].businessObjectRoles),
  };
}




