import path from 'node:path';

import { buildStableIdDescriptor, getStableIdValue } from './packages/runtime-core/src/stableId.js';

function normalizePathSlashes(filePath) {
  return filePath ? String(filePath).replace(/\\/g, '/') : undefined;
}

export function normalizeRepoRelativePath(repoRelativePath) {
  if (!repoRelativePath) {
    return undefined;
  }

  return String(repoRelativePath).replace(/\\/g, '/').replace(/^\.\//, '');
}

function deriveRepoRelativePath(filePath, workspaceRoot = process.cwd()) {
  const normalizedFilePath = normalizePathSlashes(filePath);
  if (!normalizedFilePath) {
    return undefined;
  }

  if (/^[A-Za-z]:\//.test(normalizedFilePath) || normalizedFilePath.startsWith('/')) {
    const relativePath = normalizeRepoRelativePath(path.relative(workspaceRoot, normalizedFilePath));
    if (relativePath && !relativePath.startsWith('..')) {
      return relativePath;
    }
  }

  const srcMarker = '/src/';
  const srcIndex = normalizedFilePath.indexOf(srcMarker);
  if (srcIndex >= 0) {
    return normalizedFilePath.slice(srcIndex + 1);
  }

  return normalizedFilePath;
}

export function buildStableIdDescriptorFromRecord(record = {}, options = {}) {
  const value = getStableIdValue(options.stableId || record.stableId || record.stableId || record);
  if (!value) {
    return undefined;
  }

  const filePath = normalizePathSlashes(options.filePath || record.filePath || record.file_path);
  const repoRelativePath = normalizeRepoRelativePath(
    options.repoRelativePath || record.repoRelativePath || record.repo_relative_path,
  ) || deriveRepoRelativePath(filePath);

  return buildStableIdDescriptor(value, {
    sourceStateId: options.sourceStateId || record.sourceStateId || record.source_state_id,
    filePath,
    repoRelativePath,
    startLine: options.startLine ?? record.startLine ?? record.start_line,
    startColumn: options.startColumn ?? record.startColumn ?? record.start_column,
    endLine: options.endLine ?? record.endLine ?? record.end_line,
    endColumn: options.endColumn ?? record.endColumn ?? record.end_column,
    suffix: options.suffix ?? record.suffix ?? record.stableIdSuffix ?? record.stableIdSuffix,
  });
}

export function buildStableIdLocation(record = {}, options = {}) {
  const descriptor = buildStableIdDescriptorFromRecord(record, options);
  if (!descriptor) {
    return undefined;
  }

  return {
    stableId: descriptor.value,
    value: descriptor.value,
    sourceStateId: descriptor.sourceStateId,
    absolutePath: descriptor.filePath || descriptor.value,
    filePath: descriptor.filePath || descriptor.value,
    repoRelativePath: descriptor.repoRelativePath || deriveRepoRelativePath(descriptor.filePath) || descriptor.value,
    startLine: descriptor.startLine,
    startColumn: descriptor.startColumn,
    endLine: descriptor.endLine,
    endColumn: descriptor.endColumn,
    suffix: descriptor.suffix,
  };
}

export function getStableIdKey(value) {
  return getStableIdValue(value);
}