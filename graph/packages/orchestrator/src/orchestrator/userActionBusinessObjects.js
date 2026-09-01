import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const TECHNICAL_PREFIX_TOKENS = new Set([
  'Api', 'Current', 'Input', 'Local', 'Raw', 'Resolved', 'Result', 'Runtime', 'Stored', 'Typed', 'Ui', 'Update', 'Updates',
]);
const OPERATION_PREFIX_TOKENS = new Set([
  'Add', 'Apply', 'Attach', 'Build', 'Check', 'Clear', 'Close', 'Confirm', 'Create', 'Delete', 'Discard', 'Dismiss', 'Edit',
  'Export', 'Fetch', 'Forward', 'Get', 'Handle', 'Hide', 'Import', 'Install', 'Join', 'Leave', 'Load', 'Manage', 'Mark',
  'Move', 'Notify', 'Open', 'Read', 'Remove', 'Render', 'Resolve', 'Save', 'Select', 'Send', 'Set', 'Show', 'Start', 'Stop',
  'Toggle', 'Translate', 'Update', 'Upload', 'View', 'Watch', 'Write',
]);
const TECHNICAL_SUFFIX_TOKENS = new Set([
  'Builder', 'Config', 'Configuration', 'Connection', 'Context', 'Data', 'Descriptor', 'Fields', 'Handler', 'Info', 'Json',
  'Meta', 'Model', 'Options', 'Params', 'Payload', 'Presentation', 'Record', 'Request', 'Response', 'Result', 'Shape',
  'State', 'Type', 'Value', 'Wrapper',
]);
const HUMAN_PATTERNS = [
  { canonicalName: 'GroupCall', requiredTokens: ['Group', 'Call'] },
  { canonicalName: 'ForumTopic', requiredTokens: ['Forum', 'Topic'] },
];
const HUMAN_TOKEN_MAP = new Map([
  ['Audio', 'Audio'],
  ['Bot', 'Bot'],
  ['Call', 'Call'],
  ['Channel', 'Channel'],
  ['Chat', 'Chat'],
  ['Contact', 'Contact'],
  ['Dialog', 'Dialog'],
  ['Document', 'Document'],
  ['File', 'File'],
  ['Forum', 'Forum'],
  ['Geo', 'Location'],
  ['Gift', 'Gift'],
  ['Invoice', 'Invoice'],
  ['Location', 'Location'],
  ['Media', 'Media'],
  ['Message', 'Message'],
  ['Participant', 'User'],
  ['Photo', 'Photo'],
  ['Poll', 'Poll'],
  ['Profile', 'Profile'],
  ['Reaction', 'Reaction'],
  ['Session', 'Session'],
  ['Sticker', 'Sticker'],
  ['Story', 'Story'],
  ['Stream', 'Stream'],
  ['Theme', 'Theme'],
  ['Thread', 'Topic'],
  ['Topic', 'Topic'],
  ['User', 'User'],
  ['Video', 'Video'],
  ['Voice', 'Voice'],
]);
const HUMAN_PRIORITY = [
  'GroupCall', 'ForumTopic', 'Message', 'Chat', 'Channel', 'Dialog', 'User', 'Bot', 'Contact', 'Profile', 'Call', 'Reaction',
  'Story', 'Poll', 'Gift', 'Invoice', 'Photo', 'Video', 'Audio', 'Voice', 'Document', 'File', 'Sticker', 'Media', 'Theme',
  'Location', 'Topic', 'Forum', 'Session', 'Stream',
];

function normalizeStringList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

function splitTokens(typeName) {
  const normalized = String(typeName || '').trim().replace(/[^A-Za-z0-9_]+/g, ' ');
  if (!normalized) {
    return [];
  }

  const rawTokens = normalized.match(/[A-Z]+(?=$|[A-Z][a-z0-9])|[A-Z]?[a-z0-9]+/g) || [];
  return normalizeStringList(rawTokens.map((token) => {
    const value = String(token || '').trim();
    return value ? `${value[0].toUpperCase()}${value.slice(1)}` : undefined;
  }));
}

function trimTokens(tokens) {
  let startIndex = 0;
  let endIndex = tokens.length;

  while (startIndex < endIndex && TECHNICAL_PREFIX_TOKENS.has(tokens[startIndex])) {
    startIndex += 1;
  }
  while (startIndex < endIndex && OPERATION_PREFIX_TOKENS.has(tokens[startIndex])) {
    startIndex += 1;
  }
  while (endIndex > startIndex && TECHNICAL_SUFFIX_TOKENS.has(tokens[endIndex - 1])) {
    endIndex -= 1;
  }

  return tokens.slice(startIndex, endIndex);
}

function extractHumanCanonicalNames(typeName) {
  const tokens = trimTokens(splitTokens(typeName));
  if (!tokens.length) {
    return [];
  }

  const tokenSet = new Set(tokens);
  const names = [];

  HUMAN_PATTERNS.forEach(({ canonicalName, requiredTokens }) => {
    if (requiredTokens.every((token) => tokenSet.has(token))) {
      names.push(canonicalName);
    }
  });

  tokens.forEach((token) => {
    const mapped = HUMAN_TOKEN_MAP.get(token);
    if (mapped) {
      names.push(mapped);
    }
  });

  return normalizeStringList(names)
    .filter((name, _, allNames) => {
      if (name === 'Call' && allNames.includes('GroupCall')) {
        return false;
      }
      if (name === 'Topic' && allNames.includes('ForumTopic')) {
        return false;
      }
      if (name === 'Forum' && allNames.includes('ForumTopic')) {
        return false;
      }
      if (name === 'Media' && allNames.some((value) => ['Photo', 'Video', 'Audio', 'Voice', 'Document', 'File', 'Sticker'].includes(value))) {
        return false;
      }
      if (name === 'User' && allNames.some((value) => ['Bot', 'Contact', 'Profile'].includes(value))) {
        return false;
      }

      return true;
    })
    .sort((left, right) => HUMAN_PRIORITY.indexOf(left) - HUMAN_PRIORITY.indexOf(right))
    .slice(0, 3);
}

function parseSummary(summaryJson) {
  if (!summaryJson) {
    return [];
  }

  try {
    const parsed = JSON.parse(summaryJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function runTsxExtractor(extractorPath, args = []) {
  const relativeExtractorPath = path.relative(process.cwd(), extractorPath).replace(/\\/g, '/');
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', './dev/registerTsNodeEsm.mjs', relativeExtractorPath, ...args],
    { cwd: process.cwd(), maxBuffer: 20 * 1024 * 1024 },
  );

  return JSON.parse(stdout || '{}');
}

async function loadUiActionPayload() {
  const extractorPath = path.resolve(process.cwd(), 'graph', 'static-extract', 'ts', 'uiIntentEntryGraph.ts');
  return runTsxExtractor(extractorPath);
}

async function loadFunctionMetadata(stableId) {
  const extractorPath = path.resolve(process.cwd(), 'graph', 'static-extract', 'ts', 'fromASTtoPreGraphFlow.ts');
  const payload = await runTsxExtractor(extractorPath, ['--fn-stable-id', stableId, '--metadata-only']);
  return Array.isArray(payload?.functions) ? payload.functions[0] : undefined;
}

export async function loadUserActionBusinessObjects() {
  const uiPayload = await loadUiActionPayload();
  const actionNames = new Set(normalizeStringList((uiPayload?.syntheticDispatches || []).map((row) => row.actionName)));
  const actionEntrypoints = (uiPayload?.actionEntrypoints || []).filter((row) => actionNames.has(row.actionName));
  const aggregateByKey = new Map();
  const chunkSize = 8;

  for (let index = 0; index < actionEntrypoints.length; index += chunkSize) {
    const batch = actionEntrypoints.slice(index, index + chunkSize);
    const metadataBatch = await Promise.all(batch.map(async (entrypoint) => ({
      entrypoint,
      functionMetadata: await loadFunctionMetadata(entrypoint.entrypointStableId).catch(() => undefined),
    })));

    metadataBatch.forEach(({ entrypoint, functionMetadata }) => {
      const summaries = parseSummary(functionMetadata?.businessObjectSummaryJson);
      const representationTypeNames = normalizeStringList(summaries.flatMap((summary) => (
        Array.isArray(summary?.representationTypeNames) && summary.representationTypeNames.length
          ? summary.representationTypeNames
          : [summary?.typeName]
      )));

      representationTypeNames.forEach((representationTypeName) => {
        extractHumanCanonicalNames(representationTypeName).forEach((canonicalName) => {
          const key = `business-object:${canonicalName}`;
          let aggregate = aggregateByKey.get(key);
          if (!aggregate) {
            aggregate = {
              businessObjectKey: key,
              canonicalName,
              actionNames: new Set(),
              entrypointNames: new Set(),
              representationTypeNames: new Set(),
            };
            aggregateByKey.set(key, aggregate);
          }

          aggregate.actionNames.add(entrypoint.actionName);
          aggregate.entrypointNames.add(entrypoint.entrypointName);
          aggregate.representationTypeNames.add(representationTypeName);
        });
      });
    });
  }

  return [...aggregateByKey.values()]
    .map((aggregate) => ({
      businessObjectKey: aggregate.businessObjectKey,
      canonicalName: aggregate.canonicalName,
      actionNames: [...aggregate.actionNames].sort(),
      actionCount: aggregate.actionNames.size,
      entrypointNames: [...aggregate.entrypointNames].sort(),
      entrypointCount: aggregate.entrypointNames.size,
      representationTypeNames: [...aggregate.representationTypeNames].sort(),
    }))
    .sort((left, right) => right.actionCount - left.actionCount || left.canonicalName.localeCompare(right.canonicalName));
}



