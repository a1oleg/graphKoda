import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const EXTRACT_MODES = {
  func: ['func'],
};

let activeRun = null;
let lastRun = null;

const execFileAsync = promisify(execFile);

export function buildExtractCommand(mode, scriptArgs = []) {
  const runnerPath = path.resolve(process.cwd(), 'dev', 'runGraphExtract.mjs');
  return {
    command: process.execPath,
    args: [runnerPath, mode, ...scriptArgs],
  };
}

function readLocalGraphEnv() {
  const envPath = path.resolve(process.cwd(), 'graph', '.env');
  if (!fs.existsSync(envPath)) {
    return {};
  }

  const result = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (!/^\s*[^#][^=]*=/.test(line)) {
      continue;
    }
    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    if (!key.startsWith('NEO4J_') && key !== 'GRAPH_NEO4J_URI') {
      continue;
    }
    result[key] = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return result;
}

function ensureLogDir() {
  const logDir = path.resolve(process.cwd(), 'graph', '.runtime', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  return logDir;
}

function readLogTail(logPath, maxBytes = 24_000) {
  if (!logPath || !fs.existsSync(logPath)) {
    return '';
  }

  const stat = fs.statSync(logPath);
  const length = Math.min(stat.size, maxBytes);
  const fd = fs.openSync(logPath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function appendLogLine(logPath, line) {
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`, 'utf8');
}

function markGraphImportRunStopped(logPath) {
  const script = `
import json
import sys

sys.path.insert(0, 'graph/static-extract/py')

try:
    from neo4j import GraphDatabase
    from common import load_settings

    settings = load_settings()
    driver = GraphDatabase.driver(settings['uri'], auth=(settings['username'], settings['password']))
    try:
        with driver.session(database=settings['database']) as session:
            row = session.run("""
                MATCH (r:GraphImportRun {source: 'semantic/functionFlowGraph', status: 'running'})
                WITH r ORDER BY r.updated_at DESC LIMIT 1
                SET r.status = 'stopped',
                    r.current_phase = 'stopped',
                    r.finished_at = datetime(),
                    r.updated_at = datetime()
                RETURN r.id AS id
            """).single()
            print(json.dumps({'ok': True, 'id': row['id'] if row else None}))
    finally:
        driver.close()
except Exception as error:
    print(json.dumps({'ok': False, 'error': str(error)}))
    sys.exit(1)
`;

  const result = spawnSync('python', ['-c', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...readLocalGraphEnv(),
    },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });

  const stdout = result.stdout?.trim() || '';
  let parsed = null;
  try {
    parsed = stdout ? JSON.parse(stdout) : null;
  } catch {
    parsed = null;
  }

  if (result.status === 0 && parsed?.ok) {
    appendLogLine(logPath, `[orchestrator] GraphImportRun marked stopped: ${parsed.id || 'none'}`);
    return {
      ok: true,
      id: parsed.id || null,
    };
  }

  const error = parsed?.error || result.stderr?.trim() || stdout || `python exited with status ${result.status}`;
  appendLogLine(logPath, `[orchestrator] failed to mark GraphImportRun stopped: ${error}`);
  return {
    ok: false,
    error,
  };
}

function isProcessRunning(pid) {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getLogStats(logPath) {
  if (!logPath || !fs.existsSync(logPath)) {
    return {
      exists: false,
      sizeBytes: 0,
      updatedAt: null,
    };
  }

  const stat = fs.statSync(logPath);
  return {
    exists: true,
    sizeBytes: stat.size,
    updatedAt: stat.mtime.toISOString(),
  };
}

function queryWindowsProcessTree(rootPid) {
  if (!rootPid || process.platform !== 'win32') {
    return [];
  }

  const script = `
    $root = ${Number(rootPid)};
    $all = Get-CimInstance Win32_Process;
    $ids = @($root);
    for ($i = 0; $i -lt 12; $i++) {
      $children = $all | Where-Object { $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId };
      if (-not $children) { break }
      $ids += $children.ProcessId;
    }
    $all |
      Where-Object { $ids -contains $_.ProcessId } |
      Sort-Object ParentProcessId,ProcessId |
      Select-Object ProcessId,ParentProcessId,Name,CommandLine |
      ConvertTo-Json -Compress
  `;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000,
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(result.stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
      pid: Number(item.ProcessId),
      parentPid: Number(item.ParentProcessId),
      name: item.Name || null,
      commandLine: item.CommandLine || null,
    }));
  } catch {
    return [];
  }
}

function queryProcessTree(rootPid) {
  if (!rootPid) {
    return [];
  }

  if (process.platform === 'win32') {
    return queryWindowsProcessTree(rootPid);
  }

  return isProcessRunning(rootPid)
    ? [{ pid: rootPid, parentPid: null, name: null, commandLine: null }]
    : [];
}

function decorateRun(run, { tailLog = false } = {}) {
  if (!run) {
    return null;
  }

  const processTree = queryProcessTree(run.pid);
  const rootRunning = isProcessRunning(run.pid);
  const log = getLogStats(run.logPath);

  return {
    ...run,
    running: Boolean(run.running && rootRunning),
    rootRunning,
    processTree,
    processTreeCount: processTree.length,
    elapsedMs: run.startedAt
      ? ((run.finishedAt ? Date.parse(run.finishedAt) : Date.now()) - Date.parse(run.startedAt))
      : null,
    log,
    logTail: tailLog && run.logPath ? readLogTail(run.logPath) : undefined,
  };
}

function refreshActiveRun() {
  if (!activeRun) {
    return;
  }

  if (isProcessRunning(activeRun.pid)) {
    return;
  }

  lastRun = {
    ...activeRun,
    finishedAt: new Date().toISOString(),
    exitCode: null,
    signal: 'lost',
    running: false,
  };
  activeRun = null;
}

function normalizeMode(mode) {
  const normalized = String(mode || 'func').trim();
  if (!EXTRACT_MODES[normalized]) {
    throw new Error(`Unknown graph extract mode: ${normalized}. Expected one of: ${Object.keys(EXTRACT_MODES).join(', ')}.`);
  }
  return normalized;
}

function normalizeScopedFnStableId(value) {
  const stableId = String(value || '').trim();
  return stableId || null;
}

function normalizeScopedFnStableIds(value) {
  const rawItems = Array.isArray(value) ? value : [value];
  const stableIds = rawItems
    .flatMap((item) => String(item || '').split(/\r?\n|,/))
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(stableIds)];
}

export function normalizePreserveAnnotations(value) {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value === 'string') return !['false', '0', 'no', 'off'].includes(value.trim().toLowerCase());
  return value !== false && value !== 0;
}

function parseLastJsonLine(output) {
  const lines = String(output || '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return {};
  try {
    return JSON.parse(lines.at(-1));
  } catch {
    return {};
  }
}

function resolvePythonExecutable() {
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

  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && !fs.existsSync(candidate)) {
      continue;
    }

    const result = spawnSync(candidate, ['--version'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
    });
    if (result.status === 0) {
      return candidate;
    }
  }

  throw new Error('Could not resolve Python executable for scoped graph import.');
}

async function cleanupScopedFunctionImport(
  pythonExecutable,
  stableId,
  logPath,
  timeoutMs,
  preserveAnnotations,
) {
  const cleanupScript = `
import json
import sys

sys.path.insert(0, 'graph/static-extract/py')

from neo4j import GraphDatabase
from common import load_settings

settings = load_settings()
preserve_annotations = json.loads(sys.argv[2])
driver = GraphDatabase.driver(settings['uri'], auth=(settings['username'], settings['password']))
try:
    with driver.session(database=settings['database']) as session:
        annotations_deleted = 0
        if not preserve_annotations:
            annotation_result = session.run("""
                MATCH (n {source: 'semantic/functionFlowGraph'})-[:HAS_ANNOTATION]->(annotation:Annotation)
                WHERE n.parent_fn_stable_id = $stableId
                   OR n.parentFnStableId = $stableId
                   OR (n:Fn AND n.stableId STARTS WITH 'missing:')
                WITH DISTINCT annotation
                DETACH DELETE annotation
                RETURN count(*) AS deleted
            """, {'stableId': sys.argv[1]}).single()
            annotations_deleted = annotation_result['deleted'] if annotation_result else 0
        result = session.run("""
            MATCH (n {source: 'semantic/functionFlowGraph'})
            WHERE n.parent_fn_stable_id = $stableId
               OR n.parentFnStableId = $stableId
               OR (n:Fn AND n.stableId STARTS WITH 'missing:')
            WITH n
            CALL (n) {
              DETACH DELETE n
            } IN TRANSACTIONS OF 1000 ROWS
            RETURN count(*) AS deleted
        """, {'stableId': sys.argv[1]})
        row = result.single()
        print(json.dumps({
            'ok': True,
            'deleted': row['deleted'] if row else 0,
            'annotationsDeleted': annotations_deleted,
            'preserveAnnotations': preserve_annotations,
        }))
finally:
    driver.close()
`;
  const completed = await execFileAsync(
    pythonExecutable,
    ['-c', cleanupScript, stableId, JSON.stringify(Boolean(preserveAnnotations))],
    {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...readLocalGraphEnv(),
      PYTHONUNBUFFERED: '1',
      FORCE_COLOR: '0',
    },
    windowsHide: true,
    timeout: Math.max(30_000, Number(timeoutMs) || 180_000),
    maxBuffer: 1024 * 1024,
    },
  );
  if (completed.stdout) fs.appendFileSync(logPath, completed.stdout);
  if (completed.stderr) fs.appendFileSync(logPath, completed.stderr);
  try {
    return JSON.parse(String(completed.stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1) || '{}');
  } catch {
    return { ok: true, deleted: null };
  }
}

export function getExtractPlan() {
  return {
    modes: Object.fromEntries(
      Object.entries(EXTRACT_MODES).map(([mode, steps]) => [mode, { steps }]),
    ),
    scopedFuncImport: {
      bodyField: 'fnStableId',
      argv: '--fn-stable-id',
      modes: ['func'],
      appendRoute: '/api/actions/import-functions',
      preserveAnnotations: {
        bodyField: 'preserveAnnotations',
        default: true,
      },
    },
    scripts: {
      func: 'graph:extract:func',
    },
  };
}

export function getExtractPreflight({ mode = 'func' } = {}) {
  const normalizedMode = normalizeMode(mode);
  const script = `graph:extract:${normalizedMode}`;
  const importerPath = path.resolve(process.cwd(), 'graph', 'static-extract', 'py', 'fromPreGraphToNeo4j.py');
  const packagePath = path.resolve(process.cwd(), 'package.json');
  const packageJson = fs.existsSync(packagePath)
    ? JSON.parse(fs.readFileSync(packagePath, 'utf8'))
    : {};
  const checks = {
    importer: {
      ready: fs.existsSync(importerPath),
      path: importerPath,
    },
    npmScript: {
      ready: typeof packageJson.scripts?.[script] === 'string',
      name: script,
      command: packageJson.scripts?.[script] || null,
    },
    python: {
      ready: false,
      executable: null,
      modules: ['duckdb', 'neo4j'],
      error: null,
    },
  };

  try {
    const pythonExecutable = resolvePythonExecutable();
    const moduleProbe = spawnSync(
      pythonExecutable,
      ['-c', 'import duckdb, neo4j'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
      },
    );
    checks.python.executable = pythonExecutable;
    checks.python.ready = moduleProbe.status === 0;
    checks.python.error = moduleProbe.status === 0
      ? null
      : moduleProbe.stderr?.trim() || moduleProbe.stdout?.trim() || `Python exited with status ${moduleProbe.status}`;
  } catch (error) {
    checks.python.error = error.message;
  }

  refreshActiveRun();
  const processReady = !activeRun;
  return {
    ok: true,
    ready: processReady && Object.values(checks).every((check) => check.ready),
    mode: normalizedMode,
    checks,
    process: {
      ready: processReady,
      activeRun: decorateRun(activeRun),
    },
    plan: getExtractPlan(),
  };
}

export function getExtractStatus({ tailLog = false } = {}) {
  refreshActiveRun();
  return {
    ok: true,
    running: Boolean(activeRun),
    activeRun: decorateRun(activeRun, { tailLog }),
    lastRun: decorateRun(lastRun, { tailLog }),
    plan: getExtractPlan(),
  };
}

export async function importFunctionsScoped({
  fnStableId,
  fnStableIds,
  timeoutMs = 180_000,
  preserveAnnotations = true,
} = {}) {
  refreshActiveRun();
  if (activeRun) {
    return {
      ok: false,
      running: true,
      error: `Graph extract is already running in mode ${activeRun.mode}.`,
      activeRun: decorateRun(activeRun),
    };
  }

  const stableIds = normalizeScopedFnStableIds(fnStableIds || fnStableId);
  if (!stableIds.length) {
    return {
      ok: false,
      running: false,
      error: 'fnStableId or fnStableIds is required.',
    };
  }

  const pythonExecutable = resolvePythonExecutable();
  const shouldPreserveAnnotations = normalizePreserveAnnotations(preserveAnnotations);
  const importerPath = path.resolve(process.cwd(), 'graph', 'static-extract', 'py', 'fromPreGraphToNeo4j.py');
  const logPath = path.join(
    ensureLogDir(),
    `extract-func-scoped-${new Date().toISOString().replace(/[:.]/g, '-')}.log`,
  );
  const startedAt = new Date().toISOString();
  const results = [];

  appendLogLine(
    logPath,
    `[orchestrator] scoped append import starting count=${stableIds.length} preserveAnnotations=${shouldPreserveAnnotations}`,
  );
  for (const stableId of stableIds) {
    const args = [importerPath, 'func', '--append', '--fn-stable-id', stableId];
    if (!shouldPreserveAnnotations) args.push('--no-preserve-annotations');
    const stepStartedAt = new Date().toISOString();
    appendLogLine(logPath, `[orchestrator] import ${stableId}`);
    try {
      const cleanup = await cleanupScopedFunctionImport(
        pythonExecutable,
        stableId,
        logPath,
        timeoutMs,
        shouldPreserveAnnotations,
      );
      appendLogLine(logPath, `[orchestrator] cleanup ${stableId}: deleted=${cleanup.deleted ?? 'unknown'}`);
      const completed = await execFileAsync(pythonExecutable, args, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...readLocalGraphEnv(),
          PYTHONUNBUFFERED: '1',
          FORCE_COLOR: '0',
        },
        windowsHide: true,
        timeout: Math.max(30_000, Number(timeoutMs) || 180_000),
        maxBuffer: 8 * 1024 * 1024,
      });
      if (completed.stdout) fs.appendFileSync(logPath, completed.stdout);
      if (completed.stderr) fs.appendFileSync(logPath, completed.stderr);
      const importSummary = parseLastJsonLine(completed.stdout);
      results.push({
        stableId,
        ok: true,
        cleanup,
        preserveAnnotations: shouldPreserveAnnotations,
        annotationsRestored: Number(importSummary.annotationsRestored) || 0,
        startedAt: stepStartedAt,
        finishedAt: new Date().toISOString(),
        stdoutTail: String(completed.stdout || '').slice(-4_000),
        stderrTail: String(completed.stderr || '').slice(-4_000),
      });
    } catch (error) {
      const stdout = String(error.stdout || '');
      const stderr = String(error.stderr || '');
      if (stdout) fs.appendFileSync(logPath, stdout);
      if (stderr) fs.appendFileSync(logPath, stderr);
      appendLogLine(logPath, `[orchestrator] failed ${stableId}: ${error.message}`);
      results.push({
        stableId,
        ok: false,
        cleanup: null,
        startedAt: stepStartedAt,
        finishedAt: new Date().toISOString(),
        exitCode: Number.isInteger(error.code) ? error.code : null,
        signal: error.signal || null,
        error: error.message,
        stdoutTail: stdout.slice(-4_000),
        stderrTail: stderr.slice(-4_000),
      });
      break;
    }
  }

  const ok = results.every((item) => item.ok);
  appendLogLine(logPath, `[orchestrator] scoped append import finished ok=${ok}`);
  return {
    ok,
    running: false,
    append: true,
    preserveAnnotations: shouldPreserveAnnotations,
    mode: 'func',
    startedAt,
    finishedAt: new Date().toISOString(),
    requestedCount: stableIds.length,
    importedCount: results.filter((item) => item.ok).length,
    failedCount: results.filter((item) => !item.ok).length,
    logPath,
    results,
  };
}

export function startExtract({
  mode = 'func',
  fnStableId,
  catalogOnly = false,
  preserveAnnotations = true,
} = {}) {
  if (activeRun) {
    return {
      ok: false,
      running: true,
      error: `Graph extract is already running in mode ${activeRun.mode}.`,
      activeRun,
    };
  }

  const normalizedMode = normalizeMode(mode);
  const scopedFnStableId = normalizeScopedFnStableId(fnStableId);
  if (scopedFnStableId && normalizedMode !== 'func') {
    return {
      ok: false,
      running: false,
      error: 'fnStableId can only be used with func extract mode.',
    };
  }
  if (catalogOnly && (normalizedMode !== 'func' || scopedFnStableId)) {
    return {
      ok: false,
      running: false,
      error: 'catalogOnly is supported only for an unscoped func import.',
    };
  }
  const script = `graph:extract:${normalizedMode}`;
  const shouldPreserveAnnotations = normalizePreserveAnnotations(preserveAnnotations);
  const scriptArgs = scopedFnStableId
    ? [
      '--fn-stable-id',
      scopedFnStableId,
      ...(!shouldPreserveAnnotations ? ['--no-preserve-annotations'] : []),
    ]
    : [
      ...(catalogOnly ? ['--catalog-only'] : []),
      ...(!shouldPreserveAnnotations ? ['--no-preserve-annotations'] : []),
    ];
  const logPath = path.join(
    ensureLogDir(),
    `extract-${normalizedMode}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`,
  );
  appendLogLine(logPath, `[orchestrator] starting ${script}${scopedFnStableId ? ` scoped to ${scopedFnStableId}` : ''}`);
  // Stable IDs arrive through the HTTP API. Pass them as argv directly to
  // Node; routing this through `cmd.exe /c npm run ...` would interpret shell
  // metacharacters on Windows.
  const spawnSpec = buildExtractCommand(normalizedMode, scriptArgs);
  const child = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      ...readLocalGraphEnv(),
      PYTHONUNBUFFERED: '1',
      FORCE_COLOR: '0',
    },
  });

  child.stdout?.on('data', (chunk) => {
    fs.appendFileSync(logPath, chunk);
  });
  child.stderr?.on('data', (chunk) => {
    fs.appendFileSync(logPath, chunk);
  });

  const run = {
    mode: normalizedMode,
    fnStableId: scopedFnStableId,
    preserveAnnotations: shouldPreserveAnnotations,
    steps: EXTRACT_MODES[normalizedMode],
    script,
    scriptArgs,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    signal: null,
    running: true,
    logPath,
  };
  activeRun = run;

  child.on('error', (error) => {
    if (activeRun?.pid !== child.pid) {
      return;
    }
    appendLogLine(logPath, `[orchestrator] process error: ${error.message}`);
    lastRun = {
      ...activeRun,
      finishedAt: new Date().toISOString(),
      exitCode: null,
      signal: 'error',
      error: error.message,
      running: false,
    };
    activeRun = null;
  });

  child.on('exit', (code, signal) => {
    if (activeRun?.pid !== child.pid) {
      return;
    }
    appendLogLine(logPath, `[orchestrator] finished exitCode=${Number.isInteger(code) ? code : 'null'} signal=${signal || 'null'}`);
    lastRun = {
      ...activeRun,
      finishedAt: new Date().toISOString(),
      exitCode: Number.isInteger(code) ? code : null,
      signal: signal || null,
      running: false,
    };
    activeRun = null;
  });

  return {
    ok: true,
    running: true,
    run,
  };
}

export function stopExtract() {
  refreshActiveRun();
  if (!activeRun) {
    return {
      ok: true,
      running: false,
      stopped: false,
      message: 'No active graph extract is running.',
      lastRun: decorateRun(lastRun),
    };
  }

  const run = activeRun;
  const processTree = queryProcessTree(run.pid);
  const pids = [...new Set(processTree.map((item) => item.pid).filter(Boolean))].sort((left, right) => right - left);
  appendLogLine(run.logPath, `[orchestrator] stop requested for pid tree: ${pids.join(', ') || run.pid}`);

  if (process.platform === 'win32' && pids.length) {
    spawnSync('powershell.exe', ['-NoProfile', '-Command', `$pids = @(${pids.join(',')}); $pids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`], {
      windowsHide: true,
      timeout: 10_000,
    });
  } else {
    for (const pid of pids.length ? pids : [run.pid]) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Best effort stop; status refresh below reports what remains.
      }
    }
  }

  const graphImportRunStop = markGraphImportRunStopped(run.logPath);

  lastRun = {
    ...run,
    finishedAt: new Date().toISOString(),
    exitCode: null,
    signal: 'stopped',
    running: false,
  };
  activeRun = null;

  return {
    ok: true,
    running: false,
    stopped: true,
    stoppedPids: pids,
    graphImportRunStop,
    lastRun: decorateRun(lastRun, { tailLog: true }),
  };
}
