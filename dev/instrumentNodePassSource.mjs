import { readFileSync } from 'node:fs';
import path from 'node:path';
import projectPaths from './projectPaths.cjs';
import {modelStubTraceFile, modelStubTraceTargets} from './modelStubTraceTargets.mjs';

import { transformAsync } from '@babel/core';

import nodePassInstrumentationPlugin from './babelNodePassInstrumentationPlugin.mjs';

function normalizePath(value = '') {
  return String(value).replace(/\\/g, '/');
}

export function getNodePassTargetsForFile(filePath, source) {
  const normalizedFilePath = normalizePath(filePath);
  if (normalizedFilePath !== modelStubTraceFile && normalizedFilePath !== normalizePath(path.join(projectPaths.sourceRoot,modelStubTraceFile))) return [];
  return modelStubTraceTargets(source ?? readFileSync(path.resolve(projectPaths.sourceRoot,filePath),'utf8'));
}

export async function instrumentNodePassSource(source, filePath) {
  const targets = getNodePassTargetsForFile(filePath, source);
  if (!targets.length) return source;

  const result = await transformAsync(source, {
    filename: filePath,
    babelrc: false,
    configFile: false,
    // esbuild emits the final inline source map in originalAppLoader. An
    // intermediate inline map here becomes source text for that second map
    // and makes large TSX modules grow by hundreds of megabytes.
    sourceMaps: false,
    parserOpts: {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
    },
    generatorOpts: {
      retainLines: true,
    },
    plugins: [[nodePassInstrumentationPlugin, { targets, sourceRoot: projectPaths.sourceRoot }]],
  });
  const instrumentedStableIds = result?.metadata?.nodePassInstrumentation?.stableIds || [];
  const missingStableIds = targets
    .map((target) => target.stableId)
    .filter((stableId) => !instrumentedStableIds.includes(stableId));

  if (missingStableIds.length) {
    throw new Error(`Babel node-pass targets were not found in ${filePath}: ${missingStableIds.join(', ')}`);
  }

  return result.code;
}
