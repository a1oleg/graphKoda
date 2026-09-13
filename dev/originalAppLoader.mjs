import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { transform } from 'esbuild';

import { instrumentNodePassSource } from './instrumentNodePassSource.mjs';
import projectPaths from './projectPaths.cjs';

const root = projectPaths.sourceRoot;

function resolveExistingSource(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  const withoutJs = normalized.replace(/\.js$/i, '');
  const candidates = normalized.endsWith('.js')
    ? [`${withoutJs}.ts`, `${withoutJs}.tsx`, normalized]
    : [normalized, `${normalized}.ts`, `${normalized}.tsx`, `${normalized}.js`];
  for (const candidate of candidates) {
    const absolute = path.resolve(root, candidate);
    if (existsSync(absolute)) return pathToFileURL(absolute).href;
  }
  return null;
}

function resolveRelativeSource(specifier, parentURL) {
  if (!parentURL || !specifier.startsWith('.')) return null;
  const parentPath = path.dirname(fileURLToPath(parentURL));
  const absoluteSpecifier = path.resolve(parentPath, specifier);
  const relativeSpecifier = path.relative(root, absoluteSpecifier).replace(/\\/g, '/');
  if (relativeSpecifier === 'skills/bundled/verifyContent.js') {
    const content = [
      'export const SKILL_MD = "---\\ndescription: Missing bundled verify skill stub\\n---\\n";',
      'export const SKILL_FILES = {};',
    ].join('\n');
    return `data:text/javascript,${encodeURIComponent(content)}`;
  }
  if (/\.(md|txt)$/i.test(absoluteSpecifier) && existsSync(absoluteSpecifier)) {
    const content = readFileSync(absoluteSpecifier, 'utf8');
    return `data:text/javascript,${encodeURIComponent(`export default ${JSON.stringify(content)};`)}`;
  }
  if (/\.(md|txt)$/i.test(absoluteSpecifier)) {
    const content = '---\ndescription: Missing bundled text asset stub\n---\n';
    return `data:text/javascript,${encodeURIComponent(`export default ${JSON.stringify(content)};`)}`;
  }
  return (
    resolveExistingSource(relativeSpecifier) ||
    resolveMissingSourceStub(relativeSpecifier)
  );
}

function missingInternalStub(specifier, parentURL) {
  if (!parentURL || !specifier.startsWith('.')) return null;
  const parentPath = path.dirname(fileURLToPath(parentURL));
  const absoluteSpecifier = path.resolve(parentPath, specifier);
  if (!absoluteSpecifier.startsWith(root)) return null;
  if (!specifier.endsWith('.js')) return null;
  const baseName = path.basename(specifier, '.js').replace(/[^A-Za-z0-9_$]/g, '');
  const exportName = baseName || 'MissingModule';
  const source = [
    `const stub = null;`,
    `export const ${exportName} = stub;`,
    `export default stub;`,
  ].join('\n');
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

const featureModule = [
  'const enabled = new Set((process.env.CLAUDE_CODE_FEATURES || "").split(",").map(s => s.trim()).filter(Boolean));',
  'export function feature(name) { return enabled.has(name); }',
].join('\n');

const claudeForChromeMcpStub = [
  'export const BROWSER_TOOLS = [];',
].join('\n');

const jsoncParserEsmWrapper = [
  'import { createRequire } from "node:module";',
  `const require = createRequire(${JSON.stringify(import.meta.url)});`,
  'const jsonc = require("jsonc-parser");',
  'export const applyEdits = jsonc.applyEdits;',
  'export const modify = jsonc.modify;',
  'export const parse = jsonc.parse;',
  'export default jsonc;',
].join('\n');

const colorDiffNapiStub = [
  'export const ColorDiff = null;',
  'export const ColorFile = null;',
  'export function getSyntaxTheme() { return null; }',
  'export default {};',
].join('\n');

const missingModuleStubs = new Map([
  [
    'types/connectorText.js',
    [
      'export function isConnectorTextBlock() { return false; }',
      'export const ConnectorTextBlock = undefined;',
      'export default undefined;',
    ].join('\n'),
  ],
  [
    'tools/WorkflowTool/constants.js',
    [
      'export const WORKFLOW_TOOL_NAME = "Workflow";',
      'export default WORKFLOW_TOOL_NAME;',
    ].join('\n'),
  ],
  [
    'utils/filePersistence/types.js',
    [
      'export const DEFAULT_UPLOAD_CONCURRENCY = 4;',
      'export const FILE_COUNT_LIMIT = 1000;',
      'export const OUTPUTS_SUBDIR = "outputs";',
      'export default {};',
    ].join('\n'),
  ],
]);

function resolveMissingSourceStub(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  const withoutJs = normalized.replace(/\.(ts|tsx|js)$/i, '.js');
  const source = missingModuleStubs.get(withoutJs);
  if (!source) return null;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

export async function resolve(specifier, context, defaultResolve) {
  if (typeof specifier === 'string' && specifier.endsWith('.d.ts')) {
    return {
      url: 'data:text/javascript,export default {};',
      shortCircuit: true,
    };
  }
  if (specifier === 'color-diff-napi') {
    return {
      url: `data:text/javascript,${encodeURIComponent(colorDiffNapiStub)}`,
      shortCircuit: true,
    };
  }
  if (specifier === 'jsonc-parser/lib/esm/main.js') {
    return {
      url: `data:text/javascript,${encodeURIComponent(jsoncParserEsmWrapper)}`,
      shortCircuit: true,
    };
  }
  if (specifier === 'bun:bundle') {
    return {
      url: `data:text/javascript,${encodeURIComponent(featureModule)}`,
      shortCircuit: true,
    };
  }
  if (specifier === '@ant/claude-for-chrome-mcp') {
    return {
      url: `data:text/javascript,${encodeURIComponent(claudeForChromeMcpStub)}`,
      shortCircuit: true,
    };
  }
  if (specifier.startsWith('src/')) {
    const resolved = resolveExistingSource(specifier.slice(4));
    if (resolved) return { url: resolved, shortCircuit: true };
    const missingStub = resolveMissingSourceStub(specifier.slice(4));
    if (missingStub) return { url: missingStub, shortCircuit: true };
  }
  const relativeResolved = resolveRelativeSource(specifier, context.parentURL);
  if (relativeResolved) return { url: relativeResolved, shortCircuit: true };
  const stub = missingInternalStub(specifier, context.parentURL);
  if (stub) return { url: stub, shortCircuit: true };
  return defaultResolve(specifier, context, defaultResolve);
}

export async function load(url, context, defaultLoad) {
  if (url.startsWith('file:') && /\.(ts|tsx)$/i.test(new URL(url).pathname)) {
    const filePath = fileURLToPath(url);
    const source = readFileSync(filePath, 'utf8');
    const instrumentedSource = process.env.GRAPH_NODE_LOGGING === '1'
      ? await instrumentNodePassSource(source, filePath)
      : source;
    const result = await transform(instrumentedSource, {
      sourcefile: filePath,
      sourcemap: 'inline',
      format: 'esm',
      platform: 'node',
      target: 'node22',
      loader: filePath.toLowerCase().endsWith('.tsx') ? 'tsx' : 'ts',
      jsx: 'automatic',
      tsconfigRaw: {
        compilerOptions: {
          jsx: 'react-jsx',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2022',
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
        },
      },
    });
    return {
      format: 'module',
      source: result.code,
      shortCircuit: true,
    };
  }
  return defaultLoad(url, context, defaultLoad);
}
