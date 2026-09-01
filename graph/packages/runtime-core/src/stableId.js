function normalizePathSlashes(filePath) {
  return String(filePath || '').trim().replace(/\\/g, '/');
}

function normalizeRepoRootPath(repoRoot) {
  const normalized = normalizePathSlashes(repoRoot).replace(/\/+$/, '');
  return normalized || undefined;
}

function resolveDefaultRepoRoot() {
  if (typeof process === 'undefined' || !process.cwd) {
    return undefined;
  }

  try {
    return normalizeRepoRootPath(process.cwd());
  } catch {
    return undefined;
  }
}

function stripRepoRoot(filePath, repoRoot) {
  const normalizedRepoRoot = normalizeRepoRootPath(repoRoot);
  if (!normalizedRepoRoot) {
    return filePath;
  }

  if (filePath === normalizedRepoRoot) {
    return '.';
  }

  const repoPrefix = `${normalizedRepoRoot}/`;
  if (filePath.startsWith(repoPrefix)) {
    return filePath.slice(repoPrefix.length);
  }

  return filePath;
}

const STABLE_ID_RE = /^(.*):(\d+):(\d+):(\d+):(\d+)$/;
const EXTENDED_STABLE_ID_RE = /^(.*):(\d+):(\d+):(\d+):(\d+)(?::(.*))?$/;

export function normalizeStableIdFilePath(filePath, { resolveRelativePath } = {}) {
  const normalizedPath = normalizePathSlashes(filePath);
  if (!normalizedPath) {
    throw new Error('filePath is required to build stableId');
  }

  if (/^[A-Za-z]:\//.test(normalizedPath) || normalizedPath.startsWith('/')) {
    return stripRepoRoot(normalizedPath, resolveDefaultRepoRoot());
  }

  if (resolveRelativePath) {
    return normalizePathSlashes(resolveRelativePath(normalizedPath));
  }

  return normalizedPath;
}

function parseStableIdCoordinate(value, label) {
  const numericValue = Number(value);
  const isColumn = label.toLowerCase().includes('column');
  const minimumValue = isColumn ? 0 : 1;

  if (!Number.isInteger(numericValue) || numericValue < minimumValue) {
    throw new Error(`${label} must be an integer >= ${minimumValue}`);
  }

  return numericValue;
}

export function buildStableIdFromCoordinates(
  { filePath, startLine, startColumn, endLine, endColumn },
  options,
) {
  const normalizedFilePath = normalizeStableIdFilePath(filePath, options);
  const resolvedStartLine = parseStableIdCoordinate(startLine, 'startLine');
  const resolvedStartColumn = parseStableIdCoordinate(startColumn, 'startColumn');
  const resolvedEndLine = parseStableIdCoordinate(endLine ?? startLine, 'endLine');
  const resolvedEndColumn = parseStableIdCoordinate(endColumn ?? startColumn, 'endColumn');

  return `${normalizedFilePath}:${resolvedStartLine}:${resolvedStartColumn}:${resolvedEndLine}:${resolvedEndColumn}`;
}

function parseStableIdMatch(stableId, { allowSuffix = false } = {}) {
  const pattern = allowSuffix ? EXTENDED_STABLE_ID_RE : STABLE_ID_RE;
  return pattern.exec(String(stableId || ''));
}

export function parseStableId(stableId, options) {
  const match = parseStableIdMatch(stableId, options);
  if (!match) {
    throw new Error(`Unsupported stableId format: ${stableId}`);
  }

  return {
    filePath: match[1],
    startLine: Number(match[2]),
    startColumn: Number(match[3]),
    endLine: Number(match[4]),
    endColumn: Number(match[5]),
    suffix: match[6],
  };
}

export function tryParseStableId(stableId, options) {
  try {
    return parseStableId(stableId, options);
  } catch {
    return undefined;
  }
}

export function getStableIdValue(stableId) {
  if (typeof stableId === 'string') {
    return stableId;
  }

  if (stableId && typeof stableId.value === 'string') {
    return stableId.value;
  }

  return undefined;
}

export function buildStableIdDescriptor(stableId, options = {}) {
  const value = getStableIdValue(stableId);
  if (!value) {
    throw new Error('stableId value is required');
  }

  const parsed = tryParseStableId(value, { allowSuffix: true });

  return {
    value,
    sourceStateId: options.sourceStateId,
    filePath: options.filePath || parsed?.filePath,
    repoRelativePath: options.repoRelativePath,
    startLine: options.startLine ?? parsed?.startLine,
    startColumn: options.startColumn ?? parsed?.startColumn,
    endLine: options.endLine ?? parsed?.endLine,
    endColumn: options.endColumn ?? parsed?.endColumn,
    suffix: options.suffix ?? parsed?.suffix,
  };
}

export function normalizeStableId(stableId, options) {
  const parsed = parseStableId(stableId, { allowSuffix: true });
  const sourceFilePath = options?.sourceFilePath
    ? normalizePathSlashes(options.sourceFilePath)
    : undefined;

  if (sourceFilePath && normalizePathSlashes(parsed.filePath).endsWith(sourceFilePath)) {
    parsed.filePath = sourceFilePath;
  }

  return buildStableIdFromCoordinates(parsed, options);
}
