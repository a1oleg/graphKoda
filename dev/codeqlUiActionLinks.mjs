import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import projectPaths from './projectPaths.cjs';

const workspaceRoot = projectPaths.toolRoot;
const cacheRoot = path.join(projectPaths.dataRoot, 'codeql');
const toolCacheRoot = path.join(os.homedir(), '.cache', 'telegraph-codeql');
const sourceRoot = path.join(cacheRoot, 'source-root');
const cliRoot = path.join(toolCacheRoot, 'cli');
const databasePath = path.join(cacheRoot, 'databases', 'javascript');
const queryRoot = path.join(workspaceRoot, 'graph', 'codeql');
const storageSeedsPath = path.join(queryRoot, 'storage-seeds.json');
const generatedStorageSeedsPath = path.join(queryRoot, 'StorageSeedsGenerated.qll');
const queryPath = path.join(queryRoot, 'ui-action-links.ql');
const storageAccessorsQueryPath = path.join(queryRoot, 'parameterized-storage-accessors.ql');
const storageAccessorCallsQueryPath = path.join(queryRoot, 'parameterized-storage-accessor-calls.ql');
const resultBqrsPath = path.join(cacheRoot, 'results', 'ui-action-links.bqrs');
const resultJsonPath = path.join(cacheRoot, 'results', 'ui-action-links.json');
const resultFactsPath = path.join(cacheRoot, 'results', 'ui-action-links.facts.json');
const storageAccessorsBqrsPath = path.join(cacheRoot, 'results', 'parameterized-storage-accessors.bqrs');
const storageAccessorsJsonPath = path.join(cacheRoot, 'results', 'parameterized-storage-accessors.json');
const storageAccessorsFactsPath = path.join(cacheRoot, 'results', 'parameterized-storage-accessors.facts.json');
const storageAccessorCallsBqrsPath = path.join(cacheRoot, 'results', 'parameterized-storage-accessor-calls.bqrs');
const storageAccessorCallsJsonPath = path.join(cacheRoot, 'results', 'parameterized-storage-accessor-calls.json');
const storageAccessorCallsFactsPath = path.join(cacheRoot, 'results', 'parameterized-storage-accessor-calls.facts.json');
const manifestPath = path.join(cacheRoot, 'manifest.json');
const ignoredSourcePathParts = new Set([
  '.cache',
  '.git',
  '.venv',
  'graph',
  'node_modules',
  'tmp',
]);

function readJson(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
  }
}

function runCapture(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function codeqlExecutable() {
  return process.platform === 'win32'
    ? path.join(cliRoot, 'codeql', 'codeql.exe')
    : path.join(cliRoot, 'codeql', 'codeql');
}

function ensureCodeQlCli() {
  const executable = codeqlExecutable();
  if (existsSync(executable)) {
    return executable;
  }

  mkdirSync(cliRoot, { recursive: true });
  const release = JSON.parse(runCapture(
    'curl.exe',
    ['-fsSL', 'https://api.github.com/repos/github/codeql-cli-binaries/releases/latest'],
  ));
  const assetName = process.platform === 'win32'
    ? 'codeql-win64.zip'
    : process.platform === 'darwin'
      ? 'codeql-osx64.zip'
      : 'codeql-linux64.zip';
  const asset = release.assets.find((entry) => entry.name === assetName);
  if (!asset?.browser_download_url) {
    throw new Error(`Could not find CodeQL asset ${assetName} in latest release.`);
  }

  const archivePath = path.join(toolCacheRoot, assetName);
  run('curl.exe', ['-fL', asset.browser_download_url, '-o', archivePath]);
  run('tar.exe', ['-xf', archivePath, '-C', cliRoot]);
  return executable;
}

function currentSourceFingerprint() {
  return runCapture('git', ['rev-parse', 'HEAD']).trim();
}

function qlString(value) {
  return JSON.stringify(String(value || ''));
}

function buildDisjunction(rows, renderRow) {
  const rendered = rows.map(renderRow).filter(Boolean);
  if (!rendered.length) {
    return 'false';
  }
  return rendered.map((row) => `(${row})`).join('\n  or\n  ');
}

function ensureGeneratedStorageSeeds() {
  const seeds = readJson(storageSeedsPath, {});
  const sdkPatterns = Array.isArray(seeds.settingsSdkImportPatterns) ? seeds.settingsSdkImportPatterns : [];
  const externalSdkCalls = Array.isArray(seeds.externalSettingsSdkCalls) ? seeds.externalSettingsSdkCalls : [];
  const seedFileRegexps = Array.isArray(seeds.seedFileRegexps) ? seeds.seedFileRegexps : [];
  const storageSymbolNames = Array.isArray(seeds.storageSymbolNames) ? seeds.storageSymbolNames : [];

  const sdkPredicate = buildDisjunction(sdkPatterns, (entry) => {
    const regexp = entry && typeof entry === 'object' ? entry.regexp : '';
    const provider = entry && typeof entry === 'object' ? entry.provider : '';
    if (!regexp || !provider) return '';
    return `imprt.getImportedPathString().regexpMatch(${qlString(regexp)}) and provider = ${qlString(provider)}`;
  });
  const filePredicate = buildDisjunction(seedFileRegexps, (regexp) => {
    return regexp ? `f.getRelativePath().regexpMatch(${qlString(regexp)})` : '';
  });
  const symbolPredicate = buildDisjunction(storageSymbolNames, (name) => {
    return name ? `name = ${qlString(name)}` : '';
  });
  const externalSdkCallPredicate = buildDisjunction(externalSdkCalls, (entry) => {
    const provider = entry && typeof entry === 'object' ? entry.provider : '';
    const importRegexp = entry && typeof entry === 'object' ? entry.importRegexp : '';
    const calleeName = entry && typeof entry === 'object' ? entry.calleeName : '';
    const keyArgIndex = Number.isInteger(entry?.keyArgIndex) ? entry.keyArgIndex : 0;
    const mode = entry && typeof entry === 'object' ? entry.mode : 'sdk-read';
    if (!provider || !importRegexp || !calleeName) return '';
    return [
      `imprt.getImportedPathString().regexpMatch(${qlString(importRegexp)})`,
      `provider = ${qlString(provider)}`,
      `calleeName = ${qlString(calleeName)}`,
      `keyArgIndex = ${keyArgIndex}`,
      `mode = ${qlString(mode)}`,
    ].join(' and ');
  });

  writeFileSync(generatedStorageSeedsPath, [
    'import javascript',
    '',
    '/** Generated from graph/codeql/storage-seeds.json. Do not edit by hand. */',
    'predicate configuredSettingsSdkImport(Import imprt, string provider) {',
    `  ${sdkPredicate}`,
    '}',
    '',
    'predicate configuredExternalSettingsSdkCall(Import imprt, string provider, string calleeName, int keyArgIndex, string mode) {',
    `  ${externalSdkCallPredicate}`,
    '}',
    '',
    'predicate configuredStructuralSeedFile(File f) {',
    `  ${filePredicate}`,
    '}',
    '',
    'predicate configuredStorageSymbolName(string name) {',
    `  ${symbolPredicate}`,
    '}',
    '',
  ].join('\n'));
}

function shouldCopySourcePath(sourcePath) {
  const relativePath = path.relative(projectPaths.sourceRoot, sourcePath);
  if (!relativePath) {
    return true;
  }
  return !relativePath.split(path.sep).some((part) => ignoredSourcePathParts.has(part));
}

function prepareSourceRoot() {
  rmSync(sourceRoot, { recursive: true, force: true });
  mkdirSync(sourceRoot, { recursive: true });

  for (const entry of readdirSync(projectPaths.sourceRoot, { withFileTypes: true })) {
    if (ignoredSourcePathParts.has(entry.name)) {
      continue;
    }
    const from = path.join(projectPaths.sourceRoot, entry.name);
    const to = path.join(sourceRoot, entry.name);
    cpSync(from, to, {
      recursive: true,
      dereference: false,
      filter: shouldCopySourcePath,
    });
  }
}

function ensureDatabase(codeql, { force = false } = {}) {
  const manifest = readJson(manifestPath, {});
  const sourceFingerprint = currentSourceFingerprint();
  if (
    !force
    && existsSync(path.join(databasePath, 'codeql-database.yml'))
    && manifest.sourceFingerprint === sourceFingerprint
    && manifest.sourceRoot === sourceRoot
  ) {
    return;
  }
  if (!force && existsSync(path.join(databasePath, 'codeql-database.yml')) && !existsSync(manifestPath)) {
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({
      sourceFingerprint,
      databasePath,
      updatedAt: new Date().toISOString(),
      recoveredFromExistingDatabase: true,
    }, null, 2));
    return;
  }

  rmSync(databasePath, { recursive: true, force: true });
  prepareSourceRoot();
  mkdirSync(path.dirname(databasePath), { recursive: true });
  run(codeql, [
    'database',
    'create',
    databasePath,
    '--language=javascript-typescript',
    '--source-root',
    sourceRoot,
    '--overwrite',
  ]);
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify({
    sourceFingerprint,
    databasePath,
    sourceRoot,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

function runQuery(codeql) {
  ensureGeneratedStorageSeeds();
  mkdirSync(path.dirname(resultBqrsPath), { recursive: true });
  run(codeql, [
    'pack',
    'install',
    queryRoot,
  ]);
  run(codeql, [
    'query',
    'run',
    queryPath,
    '--database',
    databasePath,
    '--output',
    resultBqrsPath,
  ]);
  run(codeql, [
    'bqrs',
    'decode',
    resultBqrsPath,
    '--format=json',
    '--output',
    resultJsonPath,
  ]);
  writeFactRows();
}

function tupleValue(value) {
  if (value && typeof value === 'object' && 'label' in value) {
    return value.label;
  }
  return value;
}

function writeFactRows() {
  const payload = readJson(resultJsonPath, {});
  const tuples = payload['#select']?.tuples || [];
  const rows = [];
  const seen = new Set();

  for (const tuple of tuples) {
    const row = {
      functionLabel: String(tupleValue(tuple[0]) || ''),
      functionName: String(tupleValue(tuple[1]) || ''),
      actionName: String(tupleValue(tuple[2]) || ''),
      repoRelativePath: String(tupleValue(tuple[3]) || '').replaceAll('\\\\', '/'),
      callLine: Number(tupleValue(tuple[4]) || 0),
      callColumn: Number(tupleValue(tuple[5]) || 0),
    };
    if (!row.functionName || !row.actionName || !row.repoRelativePath || !row.callLine) {
      continue;
    }

    const key = `${row.functionName}::${row.actionName}::${row.repoRelativePath}::${row.callLine}::${row.callColumn}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    rows.push(row);
  }

  writeFileSync(resultFactsPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    rows,
  }, null, 2));
}

function writeStorageAccessorFactRows() {
  const payload = readJson(storageAccessorsJsonPath, {});
  const tuples = payload['#select']?.tuples || [];
  const rows = [];
  const seen = new Set();

  for (const tuple of tuples) {
    const row = {
      functionLabel: String(tupleValue(tuple[0]) || ''),
      functionName: String(tupleValue(tuple[1]) || ''),
      repoRelativePath: String(tupleValue(tuple[2]) || '').replaceAll('\\\\', '/'),
      functionLine: Number(tupleValue(tuple[3]) || 0),
      functionColumn: Number(tupleValue(tuple[4]) || 0),
      keyParameterName: String(tupleValue(tuple[5]) || ''),
      keyParameterIndex: Number(tupleValue(tuple[6]) || 0),
      accessMode: String(tupleValue(tuple[7]) || ''),
      storageExpression: String(tupleValue(tuple[8]) || ''),
      accessLine: Number(tupleValue(tuple[9]) || 0),
      accessColumn: Number(tupleValue(tuple[10]) || 0),
    };
    if (!row.functionName || !row.repoRelativePath || !row.keyParameterName || !row.accessMode || !row.storageExpression) {
      continue;
    }

    const key = [
      row.functionName,
      row.repoRelativePath,
      row.functionLine,
      row.functionColumn,
      row.keyParameterName,
      row.keyParameterIndex,
      row.accessMode,
      row.storageExpression,
      row.accessLine,
      row.accessColumn,
    ].join('::');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    rows.push(row);
  }

  writeFileSync(storageAccessorsFactsPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'codeql/parameterized-storage-accessors',
    description: 'Functions whose parameter is structurally used as a key for object/Map storage access.',
    rows,
  }, null, 2));
}

function writeStorageAccessorCallFactRows() {
  const payload = readJson(storageAccessorCallsJsonPath, {});
  const tuples = payload['#select']?.tuples || [];
  const rowsByKey = new Map();

  for (const tuple of tuples) {
    const row = {
      callLabel: String(tupleValue(tuple[0]) || ''),
      callerName: String(tupleValue(tuple[1]) || ''),
      callerRepoRelativePath: String(tupleValue(tuple[2]) || '').replaceAll('\\\\', '/'),
      callerLine: Number(tupleValue(tuple[3]) || 0),
      callerColumn: Number(tupleValue(tuple[4]) || 0),
      accessorName: String(tupleValue(tuple[5]) || ''),
      accessorRepoRelativePath: String(tupleValue(tuple[6]) || '').replaceAll('\\\\', '/'),
      accessorLine: Number(tupleValue(tuple[7]) || 0),
      accessorColumn: Number(tupleValue(tuple[8]) || 0),
      keyParameterName: String(tupleValue(tuple[9]) || ''),
      keyArgumentIndex: Number(tupleValue(tuple[10]) || 0),
      keyExpression: String(tupleValue(tuple[11]) || ''),
      keyLiteral: String(tupleValue(tuple[12]) || ''),
      callLine: Number(tupleValue(tuple[13]) || 0),
      callColumn: Number(tupleValue(tuple[14]) || 0),
      accessorMode: String(tupleValue(tuple[15]) || ''),
      storageExpression: String(tupleValue(tuple[16]) || ''),
      providerEvidence: String(tupleValue(tuple[17]) || ''),
      providerImportPath: String(tupleValue(tuple[18]) || ''),
    };
    if (!row.callerName || !row.accessorName || !row.callerRepoRelativePath || !row.accessorRepoRelativePath || !row.callLine) {
      continue;
    }

    const storageClass = classifyStorageAccessorCallFact(row);
    const accessType = classifyStorageAccessorAccessType(row);
    const key = [
      row.callerName,
      row.callerRepoRelativePath,
      row.accessorName,
      row.accessorRepoRelativePath,
      row.keyArgumentIndex,
      row.keyExpression,
      row.callLine,
      row.callColumn,
      row.providerEvidence,
      row.providerImportPath,
    ].join('::');
    const storageEvidence = {
      accessorMode: row.accessorMode,
      storageExpression: row.storageExpression,
    };
    const existing = rowsByKey.get(key);
    if (existing) {
      const evidenceKey = `${storageEvidence.accessorMode}::${storageEvidence.storageExpression}`;
      if (!existing.storageEvidenceKeys.has(evidenceKey)) {
        existing.storageEvidenceKeys.add(evidenceKey);
        existing.storageEvidence.push(storageEvidence);
      }
      continue;
    }
    rowsByKey.set(key, {
      callLabel: row.callLabel,
      callerName: row.callerName,
      callerRepoRelativePath: row.callerRepoRelativePath,
      callerLine: row.callerLine,
      callerColumn: row.callerColumn,
      accessorName: row.accessorName,
      accessorRepoRelativePath: row.accessorRepoRelativePath,
      accessorLine: row.accessorLine,
      accessorColumn: row.accessorColumn,
      keyParameterName: row.keyParameterName,
      keyArgumentIndex: row.keyArgumentIndex,
      keyExpression: row.keyExpression,
      keyLiteral: row.keyLiteral,
      callLine: row.callLine,
      callColumn: row.callColumn,
      providerEvidence: row.providerEvidence,
      providerImportPath: row.providerImportPath,
      storageClass,
      accessType,
      storageEvidence: [storageEvidence],
      storageEvidenceKeys: new Set([`${storageEvidence.accessorMode}::${storageEvidence.storageExpression}`]),
    });
  }

  const rows = Array.from(rowsByKey.values(), (row) => {
    const { storageEvidenceKeys, ...serializableRow } = row;
    return serializableRow;
  });

  writeFileSync(storageAccessorCallsFactsPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'codeql/parameterized-storage-accessor-calls',
    description: 'Call sites whose callee is a structurally detected parameterized settings/storage accessor.',
    rows,
  }, null, 2));
}

function classifyStorageAccessorCallFact(row) {
  if (row.providerEvidence === 'BunBundle' && row.providerImportPath === 'bun:bundle') {
    return 'build-gate';
  }
  if (row.providerEvidence === 'GrowthBook' || row.providerEvidence === 'Statsig' || row.providerEvidence === 'LaunchDarkly' || row.providerEvidence === 'Unleash') {
    return 'runtime-feature-store';
  }
  if (row.accessorMode.includes('map-') || row.accessorMode.includes('index-')) {
    return 'parameterized-store';
  }
  return 'settings-store';
}

function classifyStorageAccessorAccessType(row) {
  const mode = String(row.accessorMode || '').toLowerCase();
  if (mode.includes('write')) return 'update';
  if (mode.includes('delete')) return 'delete';
  if (mode.includes('clear')) return 'clear';
  return 'read';
}

function runStorageAccessorQuery(codeql) {
  ensureGeneratedStorageSeeds();
  mkdirSync(path.dirname(storageAccessorsBqrsPath), { recursive: true });
  run(codeql, [
    'pack',
    'install',
    queryRoot,
  ]);
  run(codeql, [
    'query',
    'run',
    storageAccessorsQueryPath,
    '--database',
    databasePath,
    '--output',
    storageAccessorsBqrsPath,
  ]);
  run(codeql, [
    'bqrs',
    'decode',
    storageAccessorsBqrsPath,
    '--format=json',
    '--output',
    storageAccessorsJsonPath,
  ]);
  writeStorageAccessorFactRows();

  run(codeql, [
    'query',
    'run',
    storageAccessorCallsQueryPath,
    '--database',
    databasePath,
    '--output',
    storageAccessorCallsBqrsPath,
  ]);
  run(codeql, [
    'bqrs',
    'decode',
    storageAccessorCallsBqrsPath,
    '--format=json',
    '--output',
    storageAccessorCallsJsonPath,
  ]);
  writeStorageAccessorCallFactRows();
}

const command = process.argv[2] || 'run';
const codeql = ensureCodeQlCli();

if (command === 'database') {
  ensureDatabase(codeql, { force: process.argv.includes('--force') });
} else if (command === 'query') {
  ensureDatabase(codeql, { force: process.argv.includes('--force-db') });
  runQuery(codeql);
} else if (command === 'run') {
  ensureDatabase(codeql, { force: process.argv.includes('--force-db') });
  runQuery(codeql);
} else if (command === 'storage') {
  ensureDatabase(codeql, { force: process.argv.includes('--force-db') });
  runStorageAccessorQuery(codeql);
} else if (command === 'storage-facts') {
  writeStorageAccessorFactRows();
  writeStorageAccessorCallFactRows();
} else {
  console.error('Usage: node dev/codeqlUiActionLinks.mjs [database|query|run|storage|storage-facts] [--force|--force-db]');
  process.exit(1);
}

console.log(JSON.stringify({
  codeql,
  databasePath,
  resultJsonPath,
  resultFactsPath,
  storageAccessorsJsonPath,
  storageAccessorsFactsPath,
  storageAccessorCallsJsonPath,
  storageAccessorCallsFactsPath,
}, null, 2));

