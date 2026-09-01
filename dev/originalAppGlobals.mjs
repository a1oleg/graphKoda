import { createRequire } from 'node:module';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { installRuntimeNodePassReporter } from './runtimeNodePassReporter.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const localRequire = createRequire(import.meta.url);
const rootRequire = createRequire(path.join(root, 'package.json'));
const enabledFeatures = new Set(
  (process.env.CLAUDE_CODE_FEATURES || '')
    .split(',')
    .map(feature => feature.trim())
    .filter(Boolean),
);

const originalModuleLoad = Module._load;
Module._load = function loadWithDevVirtualModules(request, parent, isMain) {
  if (typeof request === 'string' && request.endsWith('.d.ts')) {
    return {};
  }
  if (typeof request === 'string' && /\.(md|txt)$/i.test(request)) {
    const parentDir = parent?.filename ? path.dirname(parent.filename) : root;
    const absolute = path.resolve(parentDir, request);
    if (existsSync(absolute)) {
      return readFileSync(absolute, 'utf8');
    }
    return '---\ndescription: Missing bundled text asset stub\n---\n';
  }
  if (request === 'bun:bundle') {
    return {
      feature: name => enabledFeatures.has(name),
    };
  }
  if (request === '@ant/claude-for-chrome-mcp') {
    return {
      BROWSER_TOOLS: [],
    };
  }
  if (request === '@alcalzone/ansi-tokenize') {
    const tokenize = value => [{ type: 'text', value: String(value ?? ''), fullWidth: false }];
    const ansiCodesToString = codes => (Array.isArray(codes) ? codes.map(code => code?.code || '').join('') : '');
    const reduceAnsiCodes = codes => (Array.isArray(codes) ? codes : []);
    return {
      tokenize,
      ansiCodesToString,
      reduceAnsiCodes,
      undoAnsiCodes: ansiCodesToString,
      diffAnsiCodes: (_previous, next) => reduceAnsiCodes(next),
      styledCharsFromTokens: tokens => (Array.isArray(tokens) ? tokens : []).flatMap(token => String(token.value ?? '').split('').map(value => ({ value, codes: [] }))),
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

globalThis.require = specifier => {
  try {
    return localRequire(specifier);
  } catch (error) {
    if (typeof specifier === 'string' && specifier.startsWith('.')) {
      const rootRelative = specifier.replace(/^(\.\.\/)+/, './');
      try {
        return rootRequire(rootRelative);
      } catch {
        const withoutJs = rootRelative.replace(/\.js$/i, '');
        for (const extension of ['.ts', '.tsx']) {
          const candidate = `${withoutJs}${extension}`;
          if (!existsSync(path.join(root, candidate))) continue;
          try {
            return rootRequire(candidate);
          } catch {
            // Keep trying; surface the original error if no candidate works.
          }
        }
      }
    }
    if (typeof specifier === 'string' && specifier.startsWith('src/')) {
      const rootRelative = `./${specifier.slice(4)}`;
      try {
        return rootRequire(rootRelative);
      } catch {
        const withoutJs = rootRelative.replace(/\.js$/i, '');
        for (const extension of ['.ts', '.tsx']) {
          const candidate = `${withoutJs}${extension}`;
          if (!existsSync(path.join(root, candidate))) continue;
          try {
            return rootRequire(candidate);
          } catch {
            // Keep trying; surface the original error if no candidate works.
          }
        }
      }
    }
    throw error;
  }
};

globalThis.MACRO = {
  VERSION: process.env.CLAUDE_CODE_DEV_VERSION || '0.0.0-dev',
};

installRuntimeNodePassReporter();
