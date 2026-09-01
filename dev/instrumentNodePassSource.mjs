import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { transformAsync } from '@babel/core';

import nodePassInstrumentationPlugin from './babelNodePassInstrumentationPlugin.mjs';

const manifestPath = fileURLToPath(new URL('../graph/instrumentation/node-pass-targets.json', import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

function normalizePath(value = '') {
  return String(value).replace(/\\/g, '/');
}

export function getNodePassTargetsForFile(filePath) {
  const normalizedFilePath = normalizePath(filePath);
  return manifest.targets.filter((target) => normalizedFilePath.endsWith(normalizePath(target.filePath)));
}

export async function instrumentNodePassSource(source, filePath) {
  const targets = getNodePassTargetsForFile(filePath);
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
    plugins: [[nodePassInstrumentationPlugin, { targets }]],
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
