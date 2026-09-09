import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import {
  writeRuntimeLogContract,
} from '../../../../loggingProfileModel.js';

import {
  runReadQuery,
} from '../../../runtime-relay/src/runtimeEvents.js';
import {
  clearRuntimeRedis,
  getRuntimeRedisStats,
  isRedisRuntimeStoreConfig,
  pingRuntimeRedis,
} from '../../../runtime-relay/src/runtimeRedis.js';
import {
  DEFAULT_RUNTIME_RELAY_HEALTH_URL,
  DEFAULT_RUNTIME_RELAY_STATS_URL,
  DEFAULT_RUNTIME_RELAY_URL,
  buildRuntimeStoreConfig,
} from '../../../runtime-relay/src/config.js';
import {
  DEVOPS_SERVICE_LOG_DIR,
  INFRA_SERVICE_LOG_DIR,
  REVERSE_SERVICE_LOG_DIR,
  buildOrchestratorConfig,
} from './config.js';
import { resolveFeatureBabelFunctionSetPath } from './featureRestore.js';
import { buildApiRouteCatalog } from './apiContract.js';

const ORDINARY_DEV_SERVER_URL = 'http://127.0.0.1:1234/';
const MOCKED_DEV_SERVER_URL = 'http://127.0.0.1:1235/';
const DEFAULT_FEATURE_BABEL_CONFIG_PATH = resolveFeatureBabelFunctionSetPath();
const PLAYWRIGHT_AUTH_DIR = path.resolve(process.cwd(), 'tests', 'playwright', '.auth');
const PLAYWRIGHT_PROFILE_DIR = path.resolve(process.cwd(), 'tests', 'playwright', '.profile');

const INFRA_SERVICE_SPECS = {
  NEO4J: {
    script: 'graph:neo4j:start',
    startTimeoutMs: 20_000,
  },
};

function getNeo4jLaunchMode() {
  return (process.env.NEO4J_LAUNCH_MODE || 'managed').trim().toLowerCase();
}

function isExternallyManagedNeo4j() {
  return getNeo4jLaunchMode() === 'external';
}

function buildExternalNeo4jManagementStatus(currentStatus, action) {
  return {
    ...currentStatus,
    skipped: true,
    externallyManaged: true,
    launchMode: getNeo4jLaunchMode(),
    error: currentStatus.healthy
      ? null
      : currentStatus.error || 'Neo4j is externally managed; start it from Neo4j Desktop.',
    message: currentStatus.healthy
      ? `Neo4j is externally managed; ${action} was skipped because Desktop Neo4j is already reachable.`
      : `Neo4j is externally managed; ${action} was skipped. Start the DBMS from Neo4j Desktop, then retry.`,
  };
}

const REVERSE_SERVICE_SPECS = {
  RELAY: {
    script: 'graph:relay:redis',
    url: DEFAULT_RUNTIME_RELAY_URL,
    healthUrl: DEFAULT_RUNTIME_RELAY_HEALTH_URL,
    startTimeoutMs: 20_000,
  },
};

const DEVOPS_SERVICE_SPECS = {
  ORDINARY_SERVER: {
    script: 'dev:graph-profile',
    url: ORDINARY_DEV_SERVER_URL,
    port: 1234,
    startTimeoutMs: 120_000,
  },
  MOCKED_SERVER: {
    script: 'dev:mocked',
    url: MOCKED_DEV_SERVER_URL,
    port: 1235,
    startTimeoutMs: 120_000,
  },
};

const DEVOPS_PORT_SPECS = {
  ORDINARY_DEV: {
    port: 1234,
    url: ORDINARY_DEV_SERVER_URL,
  },
  MOCKED_DEV: {
    port: 1235,
    url: MOCKED_DEV_SERVER_URL,
  },
};

const PLAYWRIGHT_SESSION_SPECS = {
  ORDINARY_DEV: {
    baseUrl: 'http://localhost:1234/',
    expectedPort: 'ORDINARY_DEV',
    storageStatePath: path.join(PLAYWRIGHT_AUTH_DIR, 'session.json'),
    userDataDir: path.join(PLAYWRIGHT_PROFILE_DIR, 'ordinary-dev'),
  },
  MOCKED_DEV: {
    baseUrl: 'http://localhost:1235/',
    expectedPort: 'MOCKED_DEV',
    storageStatePath: path.join(PLAYWRIGHT_AUTH_DIR, 'session.test.json'),
    userDataDir: path.join(PLAYWRIGHT_PROFILE_DIR, 'mocked'),
  },
};

const PLAYWRIGHT_CAPTURE_SPECS = {
  ORDINARY_DEV: {
    service: 'PLAYWRIGHT_SESSION_ORDINARY_DEV',
    defaultScript: 'auth:refresh-session',
    interactive: true,
  },
  MOCKED_DEV: {
    service: 'PLAYWRIGHT_SESSION_MOCKED_DEV',
    defaultScript: 'auth:save-session',
    interactive: true,
    env: {
      TELEGRAM_TEST_SERVER: '1',
    },
  },
};

const GRAPH_SESSION_LAUNCH_SPEC = {
  service: 'GRAPH_SESSION_ORDINARY_DEV',
  script: 'graph:open-session',
  kind: 'ORDINARY_DEV',
};

function resolveFeatureLoggingRequest(requestOrConfig = {}) {
  const request = typeof requestOrConfig === 'boolean'
    ? { loggingEnabled: requestOrConfig }
    : requestOrConfig || {};

  const shouldEnableLogging = request.loggingEnabled !== undefined
    ? Boolean(request.loggingEnabled)
    : Boolean(request?.config?.loggingEnabled);

  if (!shouldEnableLogging) {
    return {
      config: {
        runtimeProfile: 'static-replay-minimal',
        runtimeRequireExplicitSession: false,
        loggingEnabled: false,
        instrumentationInclude: [],
        deferManualScreenShareStartup: false,
      },
    };
  }

  if (!request?.config || typeof request.config !== 'object') {
    throw new Error('Logging can only be enabled with an explicit feature-derived config injected alongside the repro.');
  }

  const config = {
    ...request.config,
    loggingEnabled: true,
  };

  return { config };
}

function buildFeatureLoggingEnv(requestOrConfig = {}) {
  const request = typeof requestOrConfig === 'boolean'
    ? { loggingEnabled: requestOrConfig }
    : requestOrConfig || {};
  const { config } = resolveFeatureLoggingRequest(requestOrConfig);

  writeRuntimeLogContract(config);

  const env = {
    GRAPH_LOGGING_ENABLED: config.loggingEnabled ? '1' : '0',
    GRAPH_LOGGING_CONFIG_JSON: JSON.stringify(config),
    RUNTIME_PROFILE: config.runtimeProfile,
    RUNTIME_RELAY_URL: DEFAULT_RUNTIME_RELAY_URL,
  };

  if (request.enableBabelAutoInstrumentation) {
    env.GRAPH_FEATURE_BABEL_AUTO_INSTRUMENT = '1';
    env.GRAPH_FEATURE_BABEL_CONFIG_PATH = request.babelInstrumentationConfigPath || DEFAULT_FEATURE_BABEL_CONFIG_PATH;
  }

  return env;
}

const INFRA_SERVICE_RUNTIME = new Map();
const REVERSE_SERVICE_RUNTIME = new Map();
const DEVOPS_SERVICE_RUNTIME = new Map();
let ordinaryDevServerStartPromise;
const ORCHESTRATOR_CONFIG = buildOrchestratorConfig();
const RUNTIME_MATERIALIZATION_FRESHNESS_WINDOW_MS = 5 * 60 * 1000;

function buildActionRecommendation({
  action,
  method = 'POST',
  path,
  body = null,
  idempotent = false,
  destructive = false,
  targetStateDelta = null,
  statusPath = null,
  preconditions = [],
  sideEffects = [],
  reason = '',
}) {
  return {
    action,
    method,
    path,
    body,
    idempotent,
    destructive,
    targetStateDelta,
    statusPath,
    preconditions,
    sideEffects,
    reason,
  };
}

function runCommandCapture(command, args = [], extraOptions = undefined) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(extraOptions || {}),
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr, code, signal: signal || null });
        return;
      }

      const error = new Error(`Command failed with exit code ${code}: ${command} ${args.join(' ')}`);
      error.code = code;
      error.signal = signal || null;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

function runNpmScriptCapture(script, scriptArgs = []) {
  const spawnSpec = buildNpmRunSpawnSpec(script, scriptArgs);
  return runCommandCapture(spawnSpec.command, spawnSpec.args);
}

function mergeNodeOptions(...values) {
  return [...new Set(values
    .flatMap((value) => String(value || '').split(/\s+/g))
    .map((value) => value.trim())
    .filter(Boolean))].join(' ');
}

function runNpmScriptCaptureResult(script, scriptArgs = [], extraEnv = undefined) {
  const spawnSpec = buildNpmRunSpawnSpec(script, scriptArgs);

  return new Promise((resolve, reject) => {
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        ...(extraEnv || {}),
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({
        ok: code === 0,
        exitCode: Number.isInteger(code) ? code : null,
        signal: signal || null,
        stdout,
        stderr,
      });
    });
  });
}

const FEATURE_SCENARIO_SPECS = [
  {
    script: 'graph:scenario:candidate-build',
    args: ['--skip-launch=true', '--headless=false', '--flow=group-call-screen-share'],
    matches: /screen|share|presentation/i,
  },
];

function parseScenarioSummary(stdout) {
  if (!stdout) {
    return undefined;
  }

  const markerIndex = stdout.lastIndexOf('FLOW_DONE');
  if (markerIndex >= 0) {
    const candidate = stdout.slice(markerIndex + 'FLOW_DONE'.length).trim();
    if (candidate.startsWith('{')) {
      try {
        return JSON.parse(candidate);
      } catch {
        return undefined;
      }
    }
  }

  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function detectScenarioFailure({ stdout, stderr, exitCode, signal }) {
  const combinedOutput = `${stderr || ''}\n${stdout || ''}`;

  if (/heap out of memory|javascript heap out of memory|reached heap limit|ineffective mark-compacts near heap limit/i.test(combinedOutput)) {
    return {
      kind: 'OUT_OF_MEMORY',
      message: 'Scenario process ran out of memory.',
    };
  }

  if (signal) {
    return {
      kind: 'PROCESS_SIGNAL',
      message: `Scenario process terminated by signal ${signal}.`,
    };
  }

  if (exitCode !== null) {
    return {
      kind: 'NON_ZERO_EXIT',
      message: `Scenario process exited with code ${exitCode}.`,
    };
  }

  return {
    kind: 'UNKNOWN_FAILURE',
    message: 'Scenario process failed without an exit code.',
  };
}

function buildFailedScenarioSummary(executionResult, parsedSummary) {
  const failure = detectScenarioFailure(executionResult);

  return {
    ...(parsedSummary && typeof parsedSummary === 'object' ? parsedSummary : {}),
    ok: false,
    status: 'FAILED',
    exitCode: executionResult.exitCode,
    signal: executionResult.signal,
    failureKind: failure.kind,
    failureMessage: failure.message,
  };
}

function resolveFeatureScenarioSpec(feature) {
  const haystack = [
    feature?.key,
    feature?.name,
    ...(Array.isArray(feature?.aliases) ? feature.aliases : []),
    feature?.stableId,
  ].filter(Boolean).join(' ');

  return FEATURE_SCENARIO_SPECS.find((spec) => spec.matches.test(haystack));
}

function mergeFeatureScenarioArgs(...argSets) {
  return [...new Set(argSets
    .flat()
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

function normalizeFeatureScenarioSpec(feature, scenarioSpec) {
  const matched = resolveFeatureScenarioSpec(feature);

  if (scenarioSpec?.script) {
    return {
      script: scenarioSpec.script,
      args: mergeFeatureScenarioArgs(
        matched?.script === scenarioSpec.script ? matched.args : [],
        Array.isArray(scenarioSpec.args) ? scenarioSpec.args : [],
      ),
    };
  }

  if (!matched) {
    return undefined;
  }

  return {
    script: matched.script,
    args: mergeFeatureScenarioArgs(Array.isArray(matched.args) ? matched.args : []),
  };
}

function buildFeatureScenarioEnv() {
  return {
    NODE_OPTIONS: mergeNodeOptions(process.env.NODE_OPTIONS, '--max-old-space-size=8192'),
  };
}

export async function runFeatureScenario(feature, scenarioSpec) {
  const spec = normalizeFeatureScenarioSpec(feature, scenarioSpec);
  if (!spec) {
    throw new Error(`No feature scenario is registered for feature ${feature?.key || feature?.stableId || 'unknown'}.`);
  }

  const executionResult = await runNpmScriptCaptureResult(spec.script, spec.args, buildFeatureScenarioEnv());
  const parsedSummary = parseScenarioSummary(executionResult.stdout);
  const summary = executionResult.ok
    ? (parsedSummary || null)
    : buildFailedScenarioSummary(executionResult, parsedSummary);

  const failure = executionResult.ok ? null : detectScenarioFailure(executionResult);

  return {
    script: spec.script,
    args: spec.args,
    ok: executionResult.ok,
    exitCode: executionResult.exitCode,
    signal: executionResult.signal,
    failure,
    summary,
    stdout: executionResult.stdout.trim() || null,
    stderr: executionResult.stderr.trim() || null,
  };
}

function appendManagedServiceLog(logPath, message) {
  if (!logPath || !message) {
    return;
  }

  fs.appendFileSync(logPath, `${message.trimEnd()}\n`);
}

function extractPortFromAddress(value) {
  const match = value.match(/:(\d+)\s*$/);
  return match ? Number(match[1]) : undefined;
}

async function getListeningProcessByPort(port) {
  if (process.platform !== 'win32') {
    return undefined;
  }

  try {
    const { stdout } = await runCommandCapture('netstat', ['-ano', '-p', 'tcp']);
    const line = stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => {
        if (!entry || !entry.toUpperCase().includes('LISTENING')) {
          return false;
        }

        const parts = entry.split(/\s+/);
        return extractPortFromAddress(parts[1] || '') === Number(port);
      });

    if (!line) {
      return undefined;
    }

    const parts = line.split(/\s+/);
    const pid = Number(parts[parts.length - 1]);
    if (!pid) {
      return undefined;
    }

    let processName;
    try {
      const tasklist = await runCommandCapture('tasklist', ['/FO', 'CSV', '/NH', '/FI', `PID eq ${pid}`]);
      const firstLine = tasklist.stdout.trim().split(/\r?\n/)[0] || '';
      processName = firstLine.match(/^"([^"]+)"/)?.[1];
    } catch {
      processName = undefined;
    }

    return {
      pid,
      processName: processName || null,
    };
  } catch {
    return undefined;
  }
}

async function isDescendantProcess(pid, ancestorPid) {
  if (!pid || !ancestorPid || pid === ancestorPid || process.platform !== 'win32') {
    return pid === ancestorPid;
  }

  try {
    const { stdout } = await runCommandCapture('powershell', [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress',
    ]);
    const rows = JSON.parse(stdout);
    const items = Array.isArray(rows) ? rows : rows ? [rows] : [];
    const parentByPid = new Map(items.map((item) => [Number(item.ProcessId), Number(item.ParentProcessId)]));

    let currentPid = Number(pid);
    const expectedAncestorPid = Number(ancestorPid);
    const visited = new Set();
    while (currentPid && !visited.has(currentPid)) {
      if (currentPid === expectedAncestorPid) {
        return true;
      }

      visited.add(currentPid);
      currentPid = parentByPid.get(currentPid);
    }

    return false;
  } catch {
    return false;
  }
}

function getServiceStateFilePath(scope, service) {
  const dir = scope === 'infra'
    ? INFRA_SERVICE_LOG_DIR
    : scope === 'devops'
      ? DEVOPS_SERVICE_LOG_DIR
      : REVERSE_SERVICE_LOG_DIR;
  return path.join(dir, `${service.toLowerCase()}.state.json`);
}

function readPersistedServiceRecord(scope, service) {
  if (!ORCHESTRATOR_CONFIG.persistProcessState) {
    return undefined;
  }

  const statePath = getServiceStateFilePath(scope, service);
  if (!fs.existsSync(statePath)) {
    return undefined;
  }

  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function getGraphGatewayServiceStatePath() {
  return getServiceStateFilePath('devops', 'ORCHESTRATOR');
}

function readGraphGatewayServiceRecord() {
  return readPersistedServiceRecord('devops', 'ORCHESTRATOR');
}

function getGraphGatewayFallbackLogPath() {
  return ORCHESTRATOR_CONFIG.persistProcessState
    ? path.join(DEVOPS_SERVICE_LOG_DIR, 'orchestrator.log')
    : null;
}

function writePersistedServiceRecord(scope, service, record) {
  if (!ORCHESTRATOR_CONFIG.persistProcessState) {
    return;
  }

  const statePath = getServiceStateFilePath(scope, service);
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(record, null, 2));
}

function deletePersistedServiceRecord(scope, service) {
  if (!ORCHESTRATOR_CONFIG.persistProcessState) {
    return;
  }

  const statePath = getServiceStateFilePath(scope, service);
  if (fs.existsSync(statePath)) {
    fs.rmSync(statePath, { force: true });
  }
}

function adoptPersistedServiceRecord(map, scope, service) {
  if (!ORCHESTRATOR_CONFIG.persistProcessState) {
    const existingRecord = map.get(service);

    if (!existingRecord) {
      return undefined;
    }

    if (existingRecord.pid && !isPidAlive(existingRecord.pid)) {
      map.delete(service);
      return undefined;
    }

    return existingRecord;
  }

  const existingRecord = map.get(service);
  if (existingRecord) {
    if (!isPidAlive(existingRecord.pid)) {
      map.delete(service);
      deletePersistedServiceRecord(scope, service);
      return undefined;
    }

    return existingRecord;
  }

  const persistedRecord = readPersistedServiceRecord(scope, service);
  if (!persistedRecord) {
    return undefined;
  }

  if (!isPidAlive(persistedRecord.pid)) {
    deletePersistedServiceRecord(scope, service);
    return undefined;
  }

  const adoptedRecord = {
    ...persistedRecord,
    running: true,
  };

  map.set(service, adoptedRecord);
  return adoptedRecord;
}

function buildOperationalKnowledge({
  summary,
  prerequisites = [],
  startup = [],
  healthChecks = [],
  recoveryHints = [],
  knownIssues = [],
  observations = [],
  followUps = [],
}) {
  return {
    summary,
    prerequisites,
    startup,
    healthChecks,
    recoveryHints,
    knownIssues,
    observations,
    followUps,
  };
}

function buildMockedDevKnowledge(status, portStatus) {
  return buildOperationalKnowledge({
    summary: 'Mocked dev server is the APP_MOCKED_CLIENT webpack dev server used by mocked Playwright and product scenarios on port 1235.',
    prerequisites: [
      'The mocked server runs npm run dev:mocked and the gateway now injects a graph-derived instrumentation manifest before launch.',
      'Port 1235 must be free, or the existing listener must already be the intended mocked app instance.',
      'Playwright mocked flows commonly expect tests/playwright/.auth/session.test.json and tests/playwright/.profile/mocked.',
    ],
    startup: [
      'Start mocked dev server through the orchestrator startMockedDevServer action when you need LoggingUseful-scoped instrumentation.',
      'Use npm run dev:mocked directly only when you explicitly do not need the graph-derived manifest path.',
      'Use mocked Playwright flows against http://localhost:1235/.',
      'If mocked auth state is missing, save it manually with TELEGRAM_TEST_SERVER=1 npm run auth:save-session.',
    ],
    healthChecks: [
      'HTTP 200 on http://127.0.0.1:1235/ indicates the mocked dev app is reachable.',
      'Port inspection should confirm whether port 1235 is free, managed by the gateway, or occupied by an unmanaged process.',
      status?.logPath ? `Gateway-managed mocked server logs are written to ${status.logPath}.` : 'Gateway-managed mocked server logs are written to tmp/devops-service-logs/mocked_server.log.',
    ],
    recoveryHints: [
      'If port 1235 is occupied by an unmanaged process, inspect the reported PID before starting another mocked server.',
      'If the mocked app is reachable but unmanaged, you can still use it for Playwright flows without starting a second copy.',
      'If a gateway-managed mocked server exits unexpectedly, check the log for webpack compile failures or port collisions.',
    ],
    knownIssues: [
      'Port 1235 can be occupied by stale webpack or serve processes from earlier dev or Playwright runs.',
      'Mocked Playwright auth is file-based; gateway status can detect missing storage/profile paths but does not complete interactive login itself.',
    ],
    observations: [
      status?.healthy
        ? 'Mocked dev server is currently healthy and reachable.'
        : 'Mocked dev server is not currently healthy.',
      portStatus.portFree
        ? 'Port 1235 is currently free.'
        : `Port 1235 is occupied${portStatus.listenerPid ? ` by PID ${portStatus.listenerPid}` : ''}.`,
      portStatus.orphaned
        ? 'Port 1235 appears to be occupied by an unmanaged process.'
        : 'Port 1235 is not currently flagged as orphaned.',
    ],
    followUps: [
      'If mocked Playwright runs are common, keep session.test.json refreshed so auth-dependent flows start faster.',
    ],
  });
}

function buildPlaywrightSessionKnowledge(kind, status) {
  const isMocked = kind === 'MOCKED_DEV';
  return buildOperationalKnowledge({
    summary: isMocked
      ? 'Mocked Playwright session state targets the mocked dev server on localhost:1235.'
      : 'Ordinary Playwright session state targets the ordinary dev server on localhost:1234.',
    prerequisites: [
      `Expected storage state path: ${status.storageStatePath}.`,
      `Expected persistent profile path: ${status.userDataDir}.`,
      `Expected base URL: ${status.baseUrl}.`,
    ],
    startup: [
      isMocked
        ? 'For mocked auth capture, start the mocked app first and then run TELEGRAM_TEST_SERVER=1 npm run auth:save-session.'
        : 'For ordinary auth capture, start the ordinary dev app first and then run npm run auth:save-session or npm run auth:refresh-session.',
    ],
    healthChecks: [
      `Base URL reachability should succeed on ${status.baseUrl}.`,
      'Storage state presence is a fast local indicator, but not proof that the stored auth is still valid.',
      `Saved-session snapshot currently reports ${status.storageStateCookieCount} cookies and ${status.storageStateOriginCount} origins.`,
      status.savedSessionLikelyUsable
        ? 'Saved session looks locally usable, but a real headed launch is still the final proof of authorization.'
        : 'Saved session is not yet locally convincing; inspect the verification steps and refresh auth if needed.',
    ],
    recoveryHints: [
      isMocked
        ? 'If mocked Playwright flows fail on auth setup, regenerate tests/playwright/.auth/session.test.json against the mocked server.'
        : 'If ordinary Playwright flows lose auth, refresh tests/playwright/.auth/session.json through the refresh-session script.',
    ],
    observations: [
      status.storageStateExists
        ? 'Expected Playwright storage state file exists.'
        : 'Expected Playwright storage state file is missing.',
      status.storageStateParseOk
        ? 'Stored Playwright storage state parsed successfully.'
        : 'Stored Playwright storage state could not be parsed or has no expected browser-state shape.',
      status.storageStateHasBaseUrlOrigin
        ? 'Stored Playwright storage state includes the target base URL origin.'
        : 'Stored Playwright storage state does not include the target base URL origin.',
      status.userDataDirExists
        ? 'Expected Playwright persistent profile directory exists.'
        : 'Expected Playwright persistent profile directory is missing.',
      status.baseUrlReachable
        ? 'Expected Playwright base URL is reachable.'
        : 'Expected Playwright base URL is not reachable.',
      status.savedSessionCheckMessage,
    ],
  });
}

function inspectPlaywrightStorageState(storageStatePath, baseUrl) {
  if (!fs.existsSync(storageStatePath)) {
    return {
      storageStateCookieCount: 0,
      storageStateOriginCount: 0,
      storageStateHasBaseUrlOrigin: false,
      storageStateParseOk: false,
      savedSessionLikelyUsable: false,
      savedSessionCheckMessage: 'Saved session file is missing.',
      savedSessionVerificationSteps: [
        `Check whether ${storageStatePath} exists.`,
        'If it is missing, refresh the session through the Playwright auth helper.',
      ],
    };
  }

  try {
    const payload = JSON.parse(fs.readFileSync(storageStatePath, 'utf8'));
    const cookies = Array.isArray(payload?.cookies) ? payload.cookies : [];
    const origins = Array.isArray(payload?.origins) ? payload.origins : [];
    const baseUrlOrigin = new URL(baseUrl).origin;
    const storageStateHasBaseUrlOrigin = origins.some((origin) => origin?.origin === baseUrlOrigin);
    const storageStateCookieCount = cookies.length;
    const storageStateOriginCount = origins.length;
    const storageStateParseOk = Array.isArray(payload?.cookies) || Array.isArray(payload?.origins);
    const savedSessionLikelyUsable = Boolean(storageStateParseOk && (storageStateHasBaseUrlOrigin || storageStateCookieCount > 0));

    return {
      storageStateCookieCount,
      storageStateOriginCount,
      storageStateHasBaseUrlOrigin,
      storageStateParseOk,
      savedSessionLikelyUsable,
      savedSessionCheckMessage: savedSessionLikelyUsable
        ? 'Saved session has browser-state data consistent with a reusable Playwright login snapshot.'
        : 'Saved session file exists, but its browser-state footprint does not yet look strong enough for reuse.',
      savedSessionVerificationSteps: [
        `Check whether ${storageStatePath} still exists and is fresh enough for the intended run.`,
        `Confirm the storage state JSON parses and carries cookies/origins for ${baseUrlOrigin}.`,
        `Confirm ${baseUrl} is reachable before launching Playwright with the saved session.`,
        'If all of the above pass but the browser still lands on login, refresh the saved session.',
      ],
    };
  } catch (error) {
    return {
      storageStateCookieCount: 0,
      storageStateOriginCount: 0,
      storageStateHasBaseUrlOrigin: false,
      storageStateParseOk: false,
      savedSessionLikelyUsable: false,
      savedSessionCheckMessage: error instanceof Error
        ? `Saved session file could not be parsed: ${error.message}`
        : `Saved session file could not be parsed: ${String(error)}`,
      savedSessionVerificationSteps: [
        `Open ${storageStatePath} and verify it is valid Playwright storageState JSON.`,
        'If the file is malformed or stale, refresh the Playwright session from the auth helper.',
      ],
    };
  }
}

function getInfraServiceSpec(service) {
  const spec = INFRA_SERVICE_SPECS[service];
  if (!spec) {
    throw new Error(`Unsupported infrastructure service: ${service}`);
  }

  return spec;
}

function getReverseServiceSpec(service) {
  const spec = REVERSE_SERVICE_SPECS[service];
  if (!spec) {
    throw new Error(`Unsupported reverse service: ${service}`);
  }

  return spec;
}

function getInfraServiceRecord(service) {
  return adoptPersistedServiceRecord(INFRA_SERVICE_RUNTIME, 'infra', service);
}

function getReverseServiceRecord(service) {
  return adoptPersistedServiceRecord(REVERSE_SERVICE_RUNTIME, 'reverse', service);
}

function getDevopsServiceRecord(service) {
  return adoptPersistedServiceRecord(DEVOPS_SERVICE_RUNTIME, 'devops', service);
}

function ensureInfraServiceLogDir() {
  fs.mkdirSync(INFRA_SERVICE_LOG_DIR, { recursive: true });
}

function ensureDevopsServiceLogDir() {
  fs.mkdirSync(DEVOPS_SERVICE_LOG_DIR, { recursive: true });
}

function ensureReverseServiceLogDir() {
  fs.mkdirSync(REVERSE_SERVICE_LOG_DIR, { recursive: true });
}

function getNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function getNpmCliPath() {
  if (process.platform !== 'win32') {
    return null;
  }

  const candidate = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return fs.existsSync(candidate) ? candidate : null;
}

function getNpxCommand() {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function buildNpmRunSpawnSpec(script, scriptArgs = []) {
  const npmCommand = getNpmCommand();
  const npmCliPath = getNpmCliPath();
  const normalizedArgs = Array.isArray(scriptArgs)
    ? scriptArgs.map((value) => String(value)).filter(Boolean)
    : [];

  if (process.platform === 'win32' && npmCliPath) {
    return {
      command: process.execPath,
      args: [npmCliPath, 'run', script, ...(normalizedArgs.length ? ['--', ...normalizedArgs] : [])],
    };
  }

  return {
    command: npmCommand,
    args: ['run', script, ...(normalizedArgs.length ? ['--', ...normalizedArgs] : [])],
  };
}

function buildWebpackSpawnSpec(mode) {
  const normalizedMode = mode || 'development';
  const npxCommand = getNpxCommand();

  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `${npxCommand} webpack --mode ${normalizedMode}`],
    };
  }

  return {
    command: npxCommand,
    args: ['webpack', '--mode', normalizedMode],
  };
}

function createManifestPath() {
  return path.resolve(
    process.cwd(),
    'tmp',
    `graph-instrumentation-manifest.${process.pid}.${Date.now()}.json`,
  );
}

function writeJsonFile(filePath, payload) {
  const directoryPath = path.dirname(filePath);

  fs.mkdirSync(directoryPath, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function summarizeManifestForLog({ config, manifest, manifestPath } = {}) {
  return {
    configId: config?.configId || 'glc_unknown',
    loggingEnabled: Boolean(config?.loggingEnabled),
    runtimeRequireExplicitSession: Boolean(config?.runtimeRequireExplicitSession),
    featureKey: config?.featureTrace?.featureKey,
    headStableIdCount: config?.featureTrace?.headStableIds?.length || 0,
    functionStableIdCount: config?.featureTrace?.allowedStableIds?.length || 0,
    manifestFunctionStableIdCount: manifest?.functionStableIds?.length || 0,
    bridgeFileCount: manifest?.bridgeFiles?.length || config?.featureTrace?.bridgeFiles?.length || 0,
    sampleHeadStableIds: Array.isArray(config?.featureTrace?.headStableIds) ? config.featureTrace.headStableIds.slice(0, 3) : [],
    sampleFunctionStableIds: Array.isArray(config?.featureTrace?.allowedStableIds) ? config.featureTrace.allowedStableIds.slice(0, 3) : [],
    sampleManifestFunctionStableIds: Array.isArray(manifest?.functionStableIds) ? manifest.functionStableIds.slice(0, 3) : [],
    manifestPath: manifestPath || null,
  };
}

function launchManagedReverseService(service, spec, logPath) {
  const logFd = fs.openSync(logPath, 'a');
  const spawnSpec = buildNpmRunSpawnSpec(spec.script);
  const shouldDetach = process.platform !== 'win32';
  const child = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: process.cwd(),
    detached: shouldDetach,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    env: process.env,
  });

  fs.closeSync(logFd);

  REVERSE_SERVICE_RUNTIME.set(service, {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    logPath,
    running: true,
    lastExitCode: null,
  });
  writePersistedServiceRecord('reverse', service, REVERSE_SERVICE_RUNTIME.get(service));

  child.on('exit', (code) => {
    const currentRecord = REVERSE_SERVICE_RUNTIME.get(service);
    if (!currentRecord || currentRecord.pid !== child.pid) {
      return;
    }

    REVERSE_SERVICE_RUNTIME.set(service, {
      ...currentRecord,
      running: false,
      lastExitCode: code ?? 0,
    });
    deletePersistedServiceRecord('reverse', service);
  });

  if (shouldDetach) {
    child.unref();
  }

  return child;
}

function isPidAlive(pid) {
  if (!pid || !Number.isFinite(Number(pid))) {
    return false;
  }

  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function isHttpServiceHealthy(url) {
  try {
    const response = await fetch(url, { method: 'GET' });
    return response.ok;
  } catch {
    return false;
  }
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) {
      return undefined;
    }

    return response.json();
  } catch {
    return undefined;
  }
}

async function isTcpServiceReachable(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: Number(port) });
    const finalize = (value) => {
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(1500);
    socket.once('connect', () => finalize(true));
    socket.once('timeout', () => finalize(false));
    socket.once('error', () => finalize(false));
  });
}

function buildRuntimeCleanupResult({
  ok,
  message,
  cleanedTargets = [],
  performedSteps = [],
  errors = [],
  redis,
  runtimeIngestionReadiness,
}) {
  return {
    ok,
    message,
    cleanedTargets,
    performedSteps,
    errors,
    relayAssumedStateless: true,
    redis,
    runtimeIngestionReadiness,
  };
}

async function runNpmScriptAndWait(script, logPath) {
  const spawnSpec = buildNpmRunSpawnSpec(script);
  const logFd = fs.openSync(logPath, 'a');

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(spawnSpec.command, spawnSpec.args, {
        cwd: process.cwd(),
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
        env: process.env,
      });

      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(`Script ${script} failed with exit code ${code}`));
      });
    });
  } finally {
    fs.closeSync(logFd);
  }
}

export async function getReverseServiceStatus(service) {
  const spec = getReverseServiceSpec(service);
  const record = getReverseServiceRecord(service);
  const baseStatus = {
    service,
    script: spec.script,
    url: spec.url || null,
    pid: record?.pid || null,
    managed: Boolean(record?.pid && isPidAlive(record.pid)),
    startedAt: record?.startedAt || null,
    logPath: record?.logPath || null,
    lastExitCode: record?.lastExitCode ?? null,
    running: record ? Boolean(record.running && isPidAlive(record.pid)) : false,
    healthy: false,
    reachable: false,
    error: null,
    details: null,
  };

  try {
    if (service === 'RELAY') {
      const reachable = await isHttpServiceHealthy(spec.healthUrl || spec.url);
      return {
        ...baseStatus,
        healthy: reachable,
        reachable,
        details: { healthUrl: spec.healthUrl || null },
        knowledge: buildOperationalKnowledge({
          summary: 'Relay accepts runtime envelopes over HTTP and writes them into Redis. Its health does not guarantee that the runtime store contains recent traffic.',
          prerequisites: [
            `App traffic must point to ${DEFAULT_RUNTIME_RELAY_URL}.`,
          ],
          startup: ['Start relay: npm run graph:relay:redis.'],
          healthChecks: [`Relay health endpoint: ${spec.healthUrl || spec.url}.`, 'Inspect /stats to confirm stored rows and the configured Redis runtime store.'],
          recoveryHints: ['If relay health is up but runtime rows are missing, inspect Redis connectivity and then restart relay.'],
          knownIssues: ['HTTP 200 from /graph-relay proves request handling, not by itself that the expected runtime session has already been written.'],
          observations: [reachable ? 'Relay health endpoint is responding.' : 'Relay health endpoint is not responding.', 'Runtime logs terminate in Redis, not in Neo4j.'],
          followUps: [],
        }),
      };
    }

    return {
      ...baseStatus,
      knowledge: buildOperationalKnowledge({
        summary: `${service} reverse service status is available, but no service-specific runbook is attached.`,
        observations: ['No service-specific operational knowledge is attached.'],
      }),
    };
  } catch (error) {
    return {
      ...baseStatus,
      error: error instanceof Error ? error.message : String(error),
      knowledge: buildOperationalKnowledge({
        summary: `${service} reverse service status is available, but health evaluation failed.`,
        observations: ['Health evaluation threw before service-specific knowledge could be enriched.'],
      }),
    };
  }
}

export async function listReverseServiceStatuses() {
  return Promise.all(Object.keys(REVERSE_SERVICE_SPECS).map((service) => getReverseServiceStatus(service)));
}

async function getNeo4jServiceStatus({ driver, database }) {
  const spec = getInfraServiceSpec('NEO4J');
  const record = getInfraServiceRecord('NEO4J');
  const externallyManaged = isExternallyManagedNeo4j();
  const baseStatus = {
    service: 'NEO4J',
    script: spec.script,
    url: null,
    pid: record?.pid || null,
    managed: !externallyManaged && Boolean(record?.pid && isPidAlive(record.pid)),
    externallyManaged,
    launchMode: getNeo4jLaunchMode(),
    startedAt: record?.startedAt || null,
    logPath: record?.logPath || null,
    lastExitCode: record?.lastExitCode ?? null,
    running: record && !externallyManaged ? Boolean(record.running && isPidAlive(record.pid)) : false,
    healthy: false,
    reachable: false,
    error: null,
    details: null,
  };

  try {
    await driver.verifyConnectivity();
    const records = await runReadQuery(
      driver,
      database,
      'CALL dbms.components() YIELD name, versions, edition RETURN name, versions, edition LIMIT 1',
    );
    const recordInfo = records[0] || { name: 'unknown', versions: [], edition: 'unknown' };

    return {
      ...baseStatus,
      running: true,
      healthy: true,
      reachable: true,
      details: {
        ...recordInfo,
        database,
      },
      knowledge: buildOperationalKnowledge({
        summary: 'Neo4j local graph status for static/function-flow surfaces only; runtime logs are not materialized here.',
        observations: [
          'Neo4j connectivity succeeded.',
          externallyManaged
            ? 'Neo4j process ownership is external; use Neo4j Desktop to start/stop it.'
            : 'Neo4j may be managed by the orchestrator when it owns the process record.',
          'Runtime logs are expected to land in Redis through the relay, not in Neo4j.',
        ],
      }),
    };
  } catch (error) {
    return {
      ...baseStatus,
      error: error instanceof Error ? error.message : String(error),
      knowledge: buildOperationalKnowledge({
        summary: 'Neo4j local graph status for static/function-flow surfaces only; runtime logs are not materialized here.',
        recoveryHints: [
          externallyManaged
            ? 'Neo4j is externally managed; start the target DBMS from Neo4j Desktop.'
            : 'Use /api/actions/start-neo4j or /api/actions/recover-neo4j only when orchestrator owns Neo4j.',
          'Runtime logging readiness should be checked through Redis and relay surfaces instead of neo4jHealth.',
        ],
        observations: [
          'Neo4j connectivity failed.',
          externallyManaged
            ? 'The orchestrator will not start or kill Neo4j in external launch mode.'
            : 'The orchestrator may try to start Neo4j in managed launch mode.',
          'This does not block relay-to-Redis runtime logging by itself.',
        ],
      }),
    };
  }
}

export async function getInfraServiceStatus(service, context) {
  if (service === 'NEO4J') {
    return getNeo4jServiceStatus(context);
  }

  throw new Error(`Unsupported infrastructure service: ${service}`);
}

export async function startInfraService(service, context) {
  const spec = getInfraServiceSpec(service);
  const currentStatus = await getInfraServiceStatus(service, context);
  if (service === 'NEO4J' && isExternallyManagedNeo4j()) {
    return buildExternalNeo4jManagementStatus(currentStatus, 'start-neo4j');
  }
  if (currentStatus.healthy) {
    return currentStatus;
  }

  const existingRecord = getInfraServiceRecord(service);
  if (existingRecord?.running && isPidAlive(existingRecord.pid)) {
    return currentStatus;
  }

  if (!spec.script) {
    return {
      ...currentStatus,
      error: currentStatus.error || `Start script is not configured for ${service}.`,
    };
  }

  ensureInfraServiceLogDir();
  const logPath = path.join(INFRA_SERVICE_LOG_DIR, `${service.toLowerCase()}.log`);
  const logFd = fs.openSync(logPath, 'a');
  const spawnSpec = buildNpmRunSpawnSpec(spec.script);
  const child = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    env: process.env,
  });

  fs.closeSync(logFd);

  INFRA_SERVICE_RUNTIME.set(service, {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    logPath,
    running: true,
    lastExitCode: null,
  });
  writePersistedServiceRecord('infra', service, INFRA_SERVICE_RUNTIME.get(service));

  child.on('exit', (code) => {
    const currentRecord = INFRA_SERVICE_RUNTIME.get(service);
    if (!currentRecord || currentRecord.pid !== child.pid) {
      return;
    }

    INFRA_SERVICE_RUNTIME.set(service, {
      ...currentRecord,
      running: false,
      lastExitCode: code ?? 0,
    });
    deletePersistedServiceRecord('infra', service);
  });

  child.unref();

  const deadlineAt = Date.now() + (spec.startTimeoutMs || 20_000);
  let lastStatus = await getInfraServiceStatus(service, context);
  while (Date.now() < deadlineAt) {
    if (lastStatus.healthy) {
      return lastStatus;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
    lastStatus = await getInfraServiceStatus(service, context);
  }

  return lastStatus;
}

export async function stopInfraService(service, context) {
  const record = getInfraServiceRecord(service);
  if (!record?.pid) {
    const status = await getInfraServiceStatus(service, context);
    return {
      ...status,
      error: status.error || 'Service is not managed by the gateway process registry.',
    };
  }

  if (isPidAlive(record.pid)) {
    await terminateProcessTree(record.pid);
  }

  INFRA_SERVICE_RUNTIME.set(service, {
    ...record,
    running: false,
  });
  INFRA_SERVICE_RUNTIME.delete(service);
  deletePersistedServiceRecord('infra', service);

  const deadlineAt = Date.now() + 10_000;
  let lastStatus = await getInfraServiceStatus(service, context);
  while (Date.now() < deadlineAt) {
    if (!lastStatus.running && !lastStatus.reachable) {
      return lastStatus;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
    lastStatus = await getInfraServiceStatus(service, context);
  }

  return lastStatus;
}

export async function startReverseService(service) {
  const spec = getReverseServiceSpec(service);
  const currentStatus = await getReverseServiceStatus(service);
  if (currentStatus.healthy) {
    return currentStatus;
  }

  const existingRecord = getReverseServiceRecord(service);
  if (existingRecord?.running && isPidAlive(existingRecord.pid)) {
    await stopReverseService(service);
  }

  ensureReverseServiceLogDir();
  const logPath = path.join(REVERSE_SERVICE_LOG_DIR, `${service.toLowerCase()}.log`);
  launchManagedReverseService(service, spec, logPath);

  const deadlineAt = Date.now() + (spec.startTimeoutMs || 20_000);
  let lastStatus = await getReverseServiceStatus(service);
  while (Date.now() < deadlineAt) {
    if (lastStatus.healthy) {
      return lastStatus;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
    lastStatus = await getReverseServiceStatus(service);
  }

  return lastStatus;
}

async function terminateProcessTree(pid) {
  if (!pid) {
    return;
  }

  if (process.platform === 'win32') {
    await new Promise((resolve, reject) => {
      const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('exit', (code) => {
        if (code === 0 || code === 128 || code === 255) {
          resolve();
          return;
        }

        reject(new Error(`taskkill failed with code ${code}`));
      });
      child.on('error', reject);
    });
    return;
  }

  process.kill(-pid, 'SIGTERM');
}

export async function stopReverseService(service) {
  const record = getReverseServiceRecord(service);
  if (!record?.pid) {
    const status = await getReverseServiceStatus(service);
    return {
      ...status,
      error: status.error || 'Service is not managed by the gateway process registry.',
    };
  }

  if (isPidAlive(record.pid)) {
    await terminateProcessTree(record.pid);
  }

  REVERSE_SERVICE_RUNTIME.set(service, {
    ...record,
    running: false,
  });
  REVERSE_SERVICE_RUNTIME.delete(service);
  deletePersistedServiceRecord('reverse', service);

  const deadlineAt = Date.now() + 10_000;
  let lastStatus = await getReverseServiceStatus(service);
  while (Date.now() < deadlineAt) {
    if (!lastStatus.running && !lastStatus.reachable) {
      return lastStatus;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
    lastStatus = await getReverseServiceStatus(service);
  }

  return lastStatus;
}

export async function ensureReverseService(service) {
  const status = await getReverseServiceStatus(service);
  if (status.healthy) {
    return status;
  }

  return startReverseService(service);
}

export async function ensureReverseObservationStack(services) {
  const selectedServices = services?.length ? services : Object.keys(REVERSE_SERVICE_SPECS);
  const ensuredServices = [];

  for (const service of selectedServices) {
    ensuredServices.push(await ensureReverseService(service));
  }

  const readiness = await getReverseReadyForObservation();

  return {
    requestedServices: selectedServices,
    ensuredServices,
    readiness,
  };
}

export async function getReverseReadyForObservation() {
  const services = await listReverseServiceStatuses();
  const unhealthyServices = services.filter((service) => !service.healthy).map((service) => service.service);
  const recommendedServices = [...unhealthyServices];
  const managedServices = services.filter((service) => service.managed).map((service) => service.service);
  const ready = unhealthyServices.length === 0;
  const actions = [
    ...(!ready ? [buildActionRecommendation({
      action: 'ENSURE_REVERSE_OBSERVATION_STACK',
      path: '/api/actions/ensure-reverse-observation-stack',
      body: {
        services: recommendedServices,
      },
      idempotent: true,
      destructive: false,
      targetStateDelta: {
        ready: true,
        unhealthyServices: [],
      },
      statusPath: '/api/status/reverse-observation',
      preconditions: [
        'HTTP orchestrator is reachable.',
      ],
      sideEffects: [
        'Ensures all currently unhealthy reverse observation services are started or adopted.',
      ],
      reason: `Reverse observation is not ready, so the stack-level ensure mutation can reconcile: ${recommendedServices.join(', ')}.`,
    })] : []),
    ...services.filter((service) => !service.healthy).map((service) => buildActionRecommendation({
      action: 'ENSURE_REVERSE_SERVICE',
      path: '/api/actions/ensure-reverse-service',
      body: {
        service: service.service,
      },
      idempotent: true,
      destructive: false,
      targetStateDelta: {
        service: service.service,
        healthy: true,
        reachable: true,
        running: true,
      },
      statusPath: '/api/status/reverse-observation',
      preconditions: [
        `Reverse service ${service.service} is currently unhealthy.`,
      ],
      sideEffects: [
        `Ensures reverse service ${service.service} is started or adopted if already running.`,
      ],
      reason: `Reverse service ${service.service} is unhealthy and blocks hot observation readiness.`,
    })),
    ...managedServices.map((service) => buildActionRecommendation({
      action: 'STOP_REVERSE_SERVICE',
      path: '/api/actions/stop-reverse-service',
      body: {
        service,
      },
      idempotent: true,
      destructive: true,
      targetStateDelta: {
        service,
        managed: false,
        running: false,
      },
      statusPath: '/api/status/reverse-observation',
      preconditions: [
        `Reverse service ${service} is currently managed by the gateway or its persisted registry.`,
      ],
      sideEffects: [
        `Stops reverse service ${service} if it is gateway-managed.`,
      ],
      reason: `Reverse service ${service} is currently managed and can be stopped explicitly.`,
    })),
  ];

  return {
    ready,
    unhealthyServices,
    recommendedServices,
    services,
    actions,
    message: ready
      ? 'Reverse runtime observation is ready: relay is healthy.'
      : `Reverse hot observation is not ready. Unhealthy services: ${unhealthyServices.join(', ')}`,
  };
}

async function getDevopsPortStatus(name, managedPid) {
  const spec = DEVOPS_PORT_SPECS[name];
  const listener = await getListeningProcessByPort(spec.port);
  const reachable = await isTcpServiceReachable('127.0.0.1', spec.port);
  const managed = Boolean(
    managedPid
    && listener?.pid
    && isPidAlive(managedPid)
    && await isDescendantProcess(listener.pid, managedPid)
  );

  return {
    name,
    port: spec.port,
    url: spec.url,
    portFree: !listener?.pid,
    reachable,
    listenerPid: listener?.pid || null,
    listenerProcessName: listener?.processName || null,
    managed,
    orphaned: Boolean(listener?.pid && !managed),
    details: {
      expectedUrl: spec.url,
      listenerAlive: listener?.pid ? isPidAlive(listener.pid) : false,
    },
  };
}

function buildOrphanedProcessStatuses(portStatuses) {
  const grouped = new Map();

  for (const portStatus of portStatuses) {
    if (!portStatus.orphaned || !portStatus.listenerPid) {
      continue;
    }

    const existing = grouped.get(portStatus.listenerPid) || {
      pid: portStatus.listenerPid,
      processName: portStatus.listenerProcessName || null,
      ports: [],
      reason: 'Listener occupies a reserved dev or mocked port but is not managed by the gateway.',
    };

    existing.ports.push(portStatus.name);
    grouped.set(portStatus.listenerPid, existing);
  }

  return [...grouped.values()];
}

function buildMockedDevServerActions(status) {
  return [
    ...(!status.healthy && !status.port.orphaned ? [buildActionRecommendation({
      action: 'START_MOCKED_DEV_SERVER',
      path: '/api/actions/start-mocked-dev-server',
      idempotent: true,
      destructive: false,
      targetStateDelta: {
        healthy: true,
        reachable: true,
        running: true,
        managed: true,
      },
      statusPath: '/api/status/mocked-dev-server',
      preconditions: [
        'Port 1235 is not currently blocked by an unmanaged process.',
      ],
      sideEffects: [
        'Starts or adopts the mocked webpack dev server on port 1235.',
      ],
      reason: 'Mocked dev server is not healthy and can be started through the gateway.',
    })] : []),
    ...(status.managed ? [buildActionRecommendation({
      action: 'STOP_MOCKED_DEV_SERVER',
      path: '/api/actions/stop-mocked-dev-server',
      idempotent: true,
      destructive: true,
      targetStateDelta: {
        healthy: false,
        reachable: false,
        running: false,
        managed: false,
      },
      statusPath: '/api/status/mocked-dev-server',
      preconditions: [
        'The mocked dev server is currently managed by the gateway registry.',
      ],
      sideEffects: [
        'Stops the gateway-managed mocked webpack dev server and frees port 1235.',
      ],
      reason: 'Mocked dev server is gateway-managed and can be stopped explicitly.',
    })] : []),
    ...((status.managed || status.port.orphaned) ? [buildActionRecommendation({
      action: 'CLEANUP_MOCKED_DEV_SERVER',
      path: '/api/actions/cleanup-mocked-dev-server',
      idempotent: true,
      destructive: true,
      targetStateDelta: {
        mockedPortFree: true,
        orphanedProcesses: [],
      },
      statusPath: '/api/status/playwright-devops',
      preconditions: [
        'Mocked dev port is either gateway-managed or occupied by an unmanaged process.',
      ],
      sideEffects: [
        'Stops the managed mocked dev server or kills the orphaned listener on port 1235.',
      ],
      reason: status.port.orphaned
        ? `Port 1235 is occupied by unmanaged PID ${status.port.listenerPid}.`
        : 'Mocked dev server is currently managed and can be cleaned up to restore a free port.',
    })] : []),
  ];
}

function buildPlaywrightDevopsActions(status) {
  return [
    ...buildMockedDevServerActions(status.mockedServer),
    ...status.ordinarySession.actions,
    ...status.mockedSession.actions,
  ];
}

function getDevopsServiceSpec(service) {
  const spec = DEVOPS_SERVICE_SPECS[service];
  if (!spec) {
    throw new Error(`Unsupported devops service: ${service}`);
  }

  return spec;
}

function getPlaywrightSessionSpec(kind) {
  const spec = PLAYWRIGHT_SESSION_SPECS[kind];
  if (!spec) {
    throw new Error(`Unsupported Playwright session kind: ${kind}`);
  }

  return spec;
}

function getPlaywrightCaptureSpec(kind) {
  const spec = PLAYWRIGHT_CAPTURE_SPECS[kind];
  if (!spec) {
    throw new Error(`Unsupported Playwright capture kind: ${kind}`);
  }

  return spec;
}

function getPlaywrightCaptureRecord(kind) {
  const service = getPlaywrightCaptureSpec(kind).service;
  const existingRecord = DEVOPS_SERVICE_RUNTIME.get(service);
  if (existingRecord) {
    if (existingRecord.running && existingRecord.pid && !isPidAlive(existingRecord.pid)) {
      const stoppedRecord = {
        ...existingRecord,
        running: false,
      };
      DEVOPS_SERVICE_RUNTIME.set(service, stoppedRecord);
      writePersistedServiceRecord('devops', service, stoppedRecord);
      return stoppedRecord;
    }

    return existingRecord;
  }

  const persistedRecord = readPersistedServiceRecord('devops', service);
  if (!persistedRecord) {
    return undefined;
  }

  if (persistedRecord.running && persistedRecord.pid && isPidAlive(persistedRecord.pid)) {
    DEVOPS_SERVICE_RUNTIME.set(service, persistedRecord);
    return persistedRecord;
  }

  return {
    ...persistedRecord,
    running: false,
  };
}

function getGraphSessionLaunchRecord() {
  return getDevopsServiceRecord(GRAPH_SESSION_LAUNCH_SPEC.service);
}

function buildGraphSessionLaunchStatus() {
  const record = getGraphSessionLaunchRecord();
  if (!record) {
    return undefined;
  }

  return {
    script: record.script || GRAPH_SESSION_LAUNCH_SPEC.script,
    pid: record.pid || null,
    managed: Boolean(record.pid && isPidAlive(record.pid)),
    startedAt: record.startedAt || null,
    logPath: record.logPath || null,
    lastExitCode: record.lastExitCode ?? null,
    running: Boolean(record.running && (!record.pid || isPidAlive(record.pid))),
    loggingEnabled: record.loggingEnabled !== false,
    sessionSource: record.sessionSource || 'none',
    sessionMode: record.sessionMode || 'launcher',
    baseUrl: record.baseUrl || PLAYWRIGHT_SESSION_SPECS.ORDINARY_DEV.baseUrl,
  };
}

function buildPlaywrightCaptureStatus(kind) {
  const spec = getPlaywrightCaptureSpec(kind);
  const record = getPlaywrightCaptureRecord(kind);
  if (!record) {
    return undefined;
  }

  return {
    script: record.script || spec.defaultScript,
    interactive: Boolean(record.interactive),
    pid: record.pid || null,
    managed: Boolean(record.pid && isPidAlive(record.pid)),
    startedAt: record.startedAt || null,
    logPath: record.logPath || null,
    lastExitCode: record.lastExitCode ?? null,
    running: Boolean(record.running && record.pid && isPidAlive(record.pid)),
    sourceStorageStatePath: record.sourceStorageStatePath || null,
  };
}

function buildPlaywrightSessionActions(status) {
  const statusPath = '/api/status/playwright-devops';

  return [
    ...(status.kind === 'ORDINARY_DEV' && !status.launch?.running ? [buildActionRecommendation({
      action: 'LAUNCH_GRAPH_SESSION',
      path: '/api/actions/launch-graph-session',
      body: {
        loggingEnabled: true,
      },
      idempotent: true,
      destructive: false,
      targetStateDelta: {
        kind: status.kind,
        launchRunning: true,
      },
      statusPath,
      preconditions: [],
      sideEffects: [
        'Starts or restarts the ordinary dev server on port 1234 with the requested runtime logging mode.',
        'Reuses the existing saved session without opening a browser window when storageState is already usable.',
        'Falls back to launching an Edge browser window only when manual auth/session recovery is needed.',
        'Saves Playwright storageState automatically after successful login/auth.',
      ],
      reason: 'Launch the ordinary Telegram session through the orchestrator with saved-session reuse first and manual auth fallback only when needed.',
    })] : []),
    ...(status.kind === 'ORDINARY_DEV' && status.launch?.running ? [buildActionRecommendation({
      action: 'STOP_GRAPH_SESSION',
      path: '/api/actions/stop-graph-session',
      idempotent: true,
      destructive: true,
      targetStateDelta: {
        kind: status.kind,
        launchRunning: false,
      },
      statusPath,
      preconditions: [
        'A gateway-managed graph session launcher is currently running for the ordinary dev session.',
      ],
      sideEffects: [
        'Stops the managed browser launcher process and closes its browser tree.',
      ],
      reason: 'Stop the currently managed ordinary graph session launcher.',
    })] : []),
    ...(!status.capture?.running && status.baseUrlReachable ? [buildActionRecommendation({
      action: 'START_PLAYWRIGHT_SESSION_CAPTURE',
      path: '/api/actions/start-playwright-session-capture',
      body: {
        kind: status.kind,
      },
      idempotent: true,
      destructive: false,
      targetStateDelta: {
        kind: status.kind,
        captureRunning: true,
      },
      statusPath,
      preconditions: [
        `Expected base URL ${status.baseUrl} is reachable.`,
      ],
      sideEffects: [
        'Launches the Playwright auth helper script and may open an Edge browser window for interactive login.',
      ],
      reason: status.storageStateExists
        ? 'Playwright session artifacts exist, but you can explicitly relaunch session capture or refresh through the gateway.'
        : 'Playwright session storage state is missing, and the auth helper can be launched through the gateway.',
    })] : []),
    ...(status.capture?.running ? [buildActionRecommendation({
      action: 'STOP_PLAYWRIGHT_SESSION_CAPTURE',
      path: '/api/actions/stop-playwright-session-capture',
      body: {
        kind: status.kind,
      },
      idempotent: true,
      destructive: true,
      targetStateDelta: {
        kind: status.kind,
        captureRunning: false,
      },
      statusPath,
      preconditions: [
        `A managed Playwright session capture is currently running for ${status.kind}.`,
      ],
      sideEffects: [
        'Stops the managed Playwright auth helper process and closes the associated browser tree.',
      ],
      reason: `Playwright session capture for ${status.kind} is currently managed and can be stopped explicitly.`,
    })] : []),
  ];
}

export async function getPlaywrightSessionStatus(kind) {
  const spec = getPlaywrightSessionSpec(kind);
  const portStatus = await getDevopsPortStatus(spec.expectedPort);
  const storageStateExists = fs.existsSync(spec.storageStatePath);
  const userDataDirExists = fs.existsSync(spec.userDataDir);
  const storageStateUpdatedAt = storageStateExists ? fs.statSync(spec.storageStatePath).mtime.toISOString() : null;
  const savedSessionInspection = inspectPlaywrightStorageState(spec.storageStatePath, spec.baseUrl);
  const capture = buildPlaywrightCaptureStatus(kind);
  const status = {
    kind,
    baseUrl: spec.baseUrl,
    expectedPort: spec.expectedPort,
    storageStatePath: spec.storageStatePath,
    storageStateExists,
    storageStateUpdatedAt,
    ...savedSessionInspection,
    userDataDir: spec.userDataDir,
    userDataDirExists,
    baseUrlReachable: portStatus.reachable,
    launch: kind === 'ORDINARY_DEV' ? buildGraphSessionLaunchStatus() : undefined,
    capture,
  };

  return {
    ...status,
    actions: buildPlaywrightSessionActions(status),
    knowledge: buildPlaywrightSessionKnowledge(kind, status),
  };
}

function buildPlaywrightCaptureLaunch(kind, sourceStorageStatePath) {
  const spec = getPlaywrightCaptureSpec(kind);
  const env = {
    ...process.env,
    ...(spec.env || {}),
  };
  let script = spec.defaultScript;

  if (sourceStorageStatePath) {
    script = 'auth:save-session';
    env.PLAYWRIGHT_SESSION_SOURCE_PATH = sourceStorageStatePath;
  }

  return {
    service: spec.service,
    script,
    interactive: !sourceStorageStatePath,
    env,
  };
}

export async function startPlaywrightSessionCapture(kind, sourceStorageStatePath) {
  const launch = buildPlaywrightCaptureLaunch(kind, sourceStorageStatePath);
  const existingRecord = getDevopsServiceRecord(launch.service);
  if (existingRecord?.running && isPidAlive(existingRecord.pid)) {
    return getPlaywrightSessionStatus(kind);
  }

  ensureDevopsServiceLogDir();
  const logPath = path.join(DEVOPS_SERVICE_LOG_DIR, `${launch.service.toLowerCase()}.log`);
  const logFd = fs.openSync(logPath, 'a');
  const spawnSpec = buildNpmRunSpawnSpec(launch.script);
  const child = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    env: launch.env,
  });

  fs.closeSync(logFd);

  const record = {
    pid: child.pid,
    script: launch.script,
    interactive: launch.interactive,
    startedAt: new Date().toISOString(),
    logPath,
    running: true,
    lastExitCode: null,
    sourceStorageStatePath: sourceStorageStatePath || null,
  };

  DEVOPS_SERVICE_RUNTIME.set(launch.service, record);
  writePersistedServiceRecord('devops', launch.service, record);

  child.on('exit', (code) => {
    const currentRecord = DEVOPS_SERVICE_RUNTIME.get(launch.service);
    if (!currentRecord || currentRecord.pid !== child.pid) {
      return;
    }

    const stoppedRecord = {
      ...currentRecord,
      running: false,
      lastExitCode: code ?? 0,
    };
    DEVOPS_SERVICE_RUNTIME.set(launch.service, stoppedRecord);
    writePersistedServiceRecord('devops', launch.service, stoppedRecord);
  });

  child.unref();

  return getPlaywrightSessionStatus(kind);
}

export async function stopPlaywrightSessionCapture(kind) {
  const spec = getPlaywrightCaptureSpec(kind);
  const record = getDevopsServiceRecord(spec.service);
  if (!record?.pid) {
    return getPlaywrightSessionStatus(kind);
  }

  if (isPidAlive(record.pid)) {
    await terminateProcessTree(record.pid);
  }

  const stoppedRecord = {
    ...record,
    running: false,
    lastExitCode: record.lastExitCode ?? 0,
  };
  DEVOPS_SERVICE_RUNTIME.set(spec.service, stoppedRecord);
  writePersistedServiceRecord('devops', spec.service, stoppedRecord);

  return getPlaywrightSessionStatus(kind);
}

export async function getMockedDevServerStatus() {
  const spec = getDevopsServiceSpec('MOCKED_SERVER');
  const record = getDevopsServiceRecord('MOCKED_SERVER');
  const portStatus = await getDevopsPortStatus('MOCKED_DEV', record?.pid);
  const reachable = await isHttpServiceHealthy(spec.url);
  const running = Boolean((record?.running && record?.pid && isPidAlive(record.pid)) || portStatus.listenerPid);
  const pid = record?.pid || portStatus.listenerPid || null;
  const managed = portStatus.managed;
  const error = portStatus.orphaned
    ? `Port ${portStatus.port} is occupied by unmanaged PID ${portStatus.listenerPid}.`
    : null;

  const status = {
    script: spec.script,
    url: spec.url,
    pid,
    managed,
    startedAt: record?.startedAt || null,
    logPath: record?.logPath || null,
    lastExitCode: record?.lastExitCode ?? null,
    running,
    healthy: reachable,
    reachable: portStatus.reachable,
    error,
    details: {
      portStatus,
    },
    port: portStatus,
  };

  return {
    ...status,
    actions: buildMockedDevServerActions(status),
    knowledge: buildMockedDevKnowledge(status, portStatus),
  };
}

export async function startMockedDevServer({ manifest } = {}) {
  const spec = getDevopsServiceSpec('MOCKED_SERVER');
  const currentStatus = await getMockedDevServerStatus();
  if (currentStatus.healthy) {
    return currentStatus;
  }

  if (currentStatus.port.orphaned) {
    return currentStatus;
  }

  const existingRecord = getDevopsServiceRecord('MOCKED_SERVER');
  if (existingRecord?.running && isPidAlive(existingRecord.pid)) {
    return currentStatus;
  }

  ensureDevopsServiceLogDir();
  const logPath = path.join(DEVOPS_SERVICE_LOG_DIR, 'mocked_server.log');
  const logFd = fs.openSync(logPath, 'a');
  const spawnSpec = buildNpmRunSpawnSpec(spec.script);
  const env = {
    ...process.env,
  };

  const child = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    env,
  });

  fs.closeSync(logFd);

  DEVOPS_SERVICE_RUNTIME.set('MOCKED_SERVER', {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    logPath,
    running: true,
    lastExitCode: null,
  });
  writePersistedServiceRecord('devops', 'MOCKED_SERVER', DEVOPS_SERVICE_RUNTIME.get('MOCKED_SERVER'));

  child.on('exit', (code) => {
    const currentRecord = DEVOPS_SERVICE_RUNTIME.get('MOCKED_SERVER');
    if (!currentRecord || currentRecord.pid !== child.pid) {
      return;
    }

    DEVOPS_SERVICE_RUNTIME.set('MOCKED_SERVER', {
      ...currentRecord,
      running: false,
      lastExitCode: code ?? 0,
    });
    deletePersistedServiceRecord('devops', 'MOCKED_SERVER');
  });

  child.unref();

  const deadlineAt = Date.now() + spec.startTimeoutMs;
  let lastStatus = await getMockedDevServerStatus();
  while (Date.now() < deadlineAt) {
    if (lastStatus.healthy) {
      return lastStatus;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
    lastStatus = await getMockedDevServerStatus();
  }

  return lastStatus;
}

export async function stopMockedDevServer() {
  const record = getDevopsServiceRecord('MOCKED_SERVER');
  if (!record?.pid) {
    const status = await getMockedDevServerStatus();
    return {
      ...status,
      error: status.error || 'Mocked dev server is not managed by the gateway process registry.',
      knowledge: status.knowledge,
    };
  }

  if (isPidAlive(record.pid)) {
    await terminateProcessTree(record.pid);
  }

  DEVOPS_SERVICE_RUNTIME.set('MOCKED_SERVER', {
    ...record,
    running: false,
  });
  DEVOPS_SERVICE_RUNTIME.delete('MOCKED_SERVER');
  deletePersistedServiceRecord('devops', 'MOCKED_SERVER');

  const deadlineAt = Date.now() + 10_000;
  let lastStatus = await getMockedDevServerStatus();
  while (Date.now() < deadlineAt) {
    if (!lastStatus.running && !lastStatus.reachable) {
      return lastStatus;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
    lastStatus = await getMockedDevServerStatus();
  }

  return lastStatus;
}

export async function getPlaywrightDevopsStatus() {
  const mockedServer = await getMockedDevServerStatus();
  const ordinaryPort = await getDevopsPortStatus('ORDINARY_DEV');
  const mockedPort = mockedServer.port;
  const ports = [ordinaryPort, mockedPort];
  const ordinarySession = await getPlaywrightSessionStatus('ORDINARY_DEV');
  const mockedSession = await getPlaywrightSessionStatus('MOCKED_DEV');
  const orphanedProcesses = buildOrphanedProcessStatuses(ports);

  const messageParts = [
    mockedServer.healthy
      ? 'Mocked dev server is reachable.'
      : mockedPort.orphaned
        ? `Mocked dev port is occupied by unmanaged PID ${mockedPort.listenerPid}.`
        : 'Mocked dev server is not reachable.',
    ordinaryPort.reachable
      ? 'Ordinary dev port is reachable for Playwright ordinary flows.'
      : 'Ordinary dev port is not reachable for Playwright ordinary flows.',
    orphanedProcesses.length
      ? `${orphanedProcesses.length} orphaned dev process binding(s) detected.`
      : 'No orphaned dev port bindings detected.',
  ];

  return {
    mockedServer,
    ordinarySession,
    mockedSession,
    ports,
    orphanedProcesses,
    actions: buildPlaywrightDevopsActions({ mockedServer, ordinarySession, mockedSession, ports, orphanedProcesses }),
    message: messageParts.join(' '),
  };
}

export async function cleanupMockedDevServer() {
  const errors = [];
  let stoppedManaged = false;
  let killedPid = null;

  const status = await getMockedDevServerStatus();

  if (status.managed) {
    try {
      await stopMockedDevServer();
      stoppedManaged = true;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  } else if (status.port.orphaned && status.port.listenerPid) {
    try {
      await terminateProcessTree(status.port.listenerPid);
      killedPid = status.port.listenerPid;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const mockedServer = await getMockedDevServerStatus();
  const playwrightDevops = await getPlaywrightDevopsStatus();

  return {
    ok: errors.length === 0,
    message: stoppedManaged
      ? 'Stopped the gateway-managed mocked dev server.'
      : killedPid
        ? `Killed orphaned process ${killedPid} on the mocked dev port.`
        : 'No managed or orphaned mocked dev server process required cleanup.',
    stoppedManaged,
    killedPid,
    errors,
    mockedServer,
    playwrightDevops,
  };
}

export async function getRuntimeIngestionReadiness(context) {
  const runtimeStore = isRedisRuntimeStoreConfig(context.runtimeStore)
    ? context.runtimeStore
    : buildRuntimeStoreConfig();
  const [relay, redis] = await Promise.all([
    getReverseServiceStatus('RELAY'),
    pingRuntimeRedis(runtimeStore),
  ]);
  const stats = redis.healthy
    ? await getRuntimeRedisStats(runtimeStore)
    : { eventCount: 0, lastIngestedAt: null, namespace: runtimeStore.namespace, latestSessionId: null };
  const ready = Boolean(relay.healthy && redis.healthy);
  const missingRequirements = [
    ...(relay.healthy ? [] : ['Relay is not healthy.']),
    ...(redis.healthy ? [] : ['Redis runtime store is not healthy.']),
  ];

  return {
    ready,
    runtimePublishReady: ready,
    analyticsReady: Boolean(redis.healthy),
    runtimeStoreReady: true,
    materializationReady: Boolean(redis.healthy),
    message: ready
      ? 'Runtime ingestion is ready. Relay writes directly into Redis.'
      : `Runtime ingestion is not ready. Missing requirements: ${missingRequirements.join(' ')}`,
    missingRequirements,
    managedServices: {
      relay: relay.managed,
      redis: false,
      any: Boolean(relay.managed),
    },
    actions: [],
    bootstrapPath: {
      topologyMode: 'relay-to-redis',
      hostPlatform: process.platform,
      runtimeReadyTopic: null,
      relayBootstrapServer: null,
      runtimeStoreUrl: runtimeStore.url,
      relayUrl: DEFAULT_RUNTIME_RELAY_URL,
      relayHealthUrl: DEFAULT_RUNTIME_RELAY_HEALTH_URL,
      runtimeStoreManaged: false,
      requiresCrossBoundaryBrokerAddress: false,
      warnings: [],
      notes: [`Redis runtime namespace: ${runtimeStore.namespace}`],
    },
    materialization: {
      observed: stats.eventCount > 0,
      consumerRegistered: true,
      consumerAssigned: true,
      consumerActive: true,
      recentPollHealthy: Boolean(redis.healthy),
      rawIngesting: stats.eventCount > 0,
      flatMaterializing: stats.eventCount > 0,
      rawRowCount: stats.eventCount,
      flatRowCount: stats.eventCount,
      consumerCount: 0,
      lastRawAt: stats.lastIngestedAt,
      lastFlatAt: stats.lastIngestedAt,
      lastPollAt: stats.lastIngestedAt,
      lastCommitAt: stats.lastIngestedAt,
      lastRebalanceAt: null,
      recentExceptions: redis.error ? [redis.error] : [],
      repairSteps: [],
      message: stats.eventCount > 0
        ? 'Redis contains runtime events.'
        : 'Redis is reachable but no runtime events have been stored yet.',
    },
    relay,
    redis,
  };
}

export async function ensureRuntimeIngestionReadiness(context) {
  await startReverseService('RELAY');
  return getRuntimeIngestionReadiness(context);
}

export async function repairRuntimeMaterialization(context) {
  return getRuntimeIngestionReadiness(context);
}

function resolveInfraReadinessRequest(request = {}) {
  const normalizedRequest = request && typeof request === 'object' ? request : {};
  const hasExplicitProfile = Object.prototype.hasOwnProperty.call(normalizedRequest, 'loggingEnabled')
    || Object.prototype.hasOwnProperty.call(normalizedRequest, 'config')
    || Object.prototype.hasOwnProperty.call(normalizedRequest, 'enableBabelAutoInstrumentation')
    || Object.prototype.hasOwnProperty.call(normalizedRequest, 'babelInstrumentationConfigPath');
  const { config } = resolveFeatureLoggingRequest(normalizedRequest);
  const requireNeo4j = normalizedRequest.requireNeo4j !== undefined
    ? Boolean(normalizedRequest.requireNeo4j)
    : true;

  return {
    hasExplicitProfile,
    loggingEnabled: Boolean(config.loggingEnabled),
    config,
    configJson: JSON.stringify(config),
    requireNeo4j,
    enableBabelAutoInstrumentation: normalizedRequest.enableBabelAutoInstrumentation !== undefined
      ? Boolean(normalizedRequest.enableBabelAutoInstrumentation)
      : Boolean(config.loggingEnabled),
    babelInstrumentationConfigPath: normalizedRequest.babelInstrumentationConfigPath || undefined,
  };
}

export async function getInfraReadiness(context, request = {}) {
  const readinessRequest = resolveInfraReadinessRequest(request);
  const ordinaryRecord = getDevopsServiceRecord('ORDINARY_SERVER');
  const [neo4j, ordinaryDevServer, ordinarySession, runtimeIngestion] = await Promise.all([
    readinessRequest.requireNeo4j
      ? getInfraServiceStatus('NEO4J', context)
      : Promise.resolve({
        service: 'NEO4J',
        healthy: true,
        reachable: false,
        skipped: true,
        error: null,
        summary: 'Neo4j readiness check skipped for JSON/file-driven repro mode.',
      }),
    getOrdinaryDevServerStatus(),
    getPlaywrightSessionStatus('ORDINARY_DEV'),
    readinessRequest.loggingEnabled
      ? getRuntimeIngestionReadiness(context)
      : Promise.resolve(null),
  ]);
  const ordinaryLoggingMatches = readinessRequest.hasExplicitProfile
    ? Boolean(
      ordinaryDevServer.loggingEnabled === readinessRequest.loggingEnabled
      && ordinaryRecord?.profileConfigJson === readinessRequest.configJson
    )
    : Boolean(ordinaryDevServer.healthy);
  const ordinaryDevServerReady = Boolean(ordinaryDevServer.healthy && ordinaryLoggingMatches);
  const ordinarySessionReady = Boolean(
    ordinarySession.baseUrlReachable
    && ordinarySession.storageStateExists
    && ordinarySession.savedSessionLikelyUsable
  );
  const runtimeIngestionRequired = readinessRequest.hasExplicitProfile && readinessRequest.loggingEnabled;
  const runtimeIngestionReady = !runtimeIngestionRequired || Boolean(runtimeIngestion?.ready);
  const missingRequirements = [
    ...(!neo4j.healthy ? [neo4j.error || 'Neo4j is not healthy.'] : []),
    ...(runtimeIngestionRequired && !runtimeIngestionReady
      ? [runtimeIngestion?.message || 'Runtime ingestion is not ready.']
      : []),
    ...(!ordinaryDevServer.healthy
      ? [ordinaryDevServer.error || `Ordinary dev server is not healthy on ${ordinaryDevServer.url}.`]
      : []),
    ...(ordinaryDevServer.healthy && !ordinaryLoggingMatches
      ? ['Ordinary dev server config does not match the requested infra profile.']
      : []),
    ...(!ordinarySession.baseUrlReachable
      ? [`Ordinary session base URL is not reachable: ${ordinarySession.baseUrl}.`]
      : []),
    ...(!ordinarySession.storageStateExists
      ? [`Ordinary Playwright storage state is missing: ${ordinarySession.storageStatePath}.`]
      : []),
    ...(ordinarySession.storageStateExists && !ordinarySession.savedSessionLikelyUsable
      ? [ordinarySession.savedSessionCheckMessage || 'Ordinary Playwright session is not reusable yet.']
      : []),
  ];

  return {
    ready: Boolean(
      neo4j.healthy
      && runtimeIngestionReady
      && ordinaryDevServerReady
      && ordinarySessionReady
    ),
    requestedProfile: {
      explicit: readinessRequest.hasExplicitProfile,
      loggingEnabled: readinessRequest.hasExplicitProfile ? readinessRequest.loggingEnabled : null,
      enableBabelAutoInstrumentation: readinessRequest.hasExplicitProfile
        ? readinessRequest.enableBabelAutoInstrumentation
        : null,
      babelInstrumentationConfigPath: readinessRequest.hasExplicitProfile
        ? (readinessRequest.babelInstrumentationConfigPath || null)
        : null,
    },
    missingRequirements,
    actions: [
      ...(!neo4j.healthy ? [{
        action: 'RESTART_INFRA_READINESS',
        method: 'POST',
        path: '/api/actions/restart-infra-readiness',
        body: request,
        statusPath: '/api/status/infra-readiness',
        reason: 'Neo4j is part of the infra-readiness chain and may require a hard restart path.',
      }] : []),
      ...((runtimeIngestionRequired && !runtimeIngestionReady) || !ordinaryDevServerReady ? [{
        action: 'ENSURE_INFRA_READINESS',
        method: 'POST',
        path: '/api/actions/ensure-infra-readiness',
        body: request,
        statusPath: '/api/status/infra-readiness',
        reason: 'The infra stack is not yet ready for a run with the requested profile.',
      }] : []),
      ...(!ordinarySessionReady ? [{
        action: 'START_PLAYWRIGHT_SESSION_CAPTURE',
        method: 'POST',
        path: '/api/actions/start-playwright-session-capture',
        body: { kind: 'ORDINARY_DEV' },
        statusPath: '/api/status/playwright-devops',
        reason: 'The ordinary Playwright session is missing or not reusable yet.',
      }] : []),
    ],
    dependencies: {
      neo4j,
      runtimeIngestion,
      ordinaryDevServer: {
        ...ordinaryDevServer,
        requestedLoggingEnabled: readinessRequest.loggingEnabled,
        loggingMatches: ordinaryLoggingMatches,
      },
      ordinarySession: {
        ...ordinarySession,
        ready: ordinarySessionReady,
      },
    },
  };
}

export async function ensureInfraReadiness(context, request = {}) {
  const readinessRequest = resolveInfraReadinessRequest(request);
  const performedSteps = [];
  const neo4j = readinessRequest.requireNeo4j
    ? await getInfraServiceStatus('NEO4J', context)
    : { healthy: true, skipped: true };

  if (readinessRequest.requireNeo4j && !neo4j.healthy) {
    const startResult = await startInfraService('NEO4J', context);
    performedSteps.push(startResult.externallyManaged
      ? 'Neo4j is externally managed; skipped orchestrator start request.'
      : 'Requested Neo4j start because infra-readiness found it unhealthy.');
  }

  if (readinessRequest.loggingEnabled) {
    let runtimeIngestion = await ensureRuntimeIngestionReadiness(context);
    performedSteps.push('Rechecked runtime ingestion readiness and started relay when needed.');
    if (!runtimeIngestion.materializationReady) {
      runtimeIngestion = await repairRuntimeMaterialization(context);
      performedSteps.push('Refreshed runtime materialization readiness.');
    }
  }

  await startOrdinaryDevServer({
    loggingEnabled: readinessRequest.loggingEnabled,
    config: readinessRequest.config,
    enableBabelAutoInstrumentation: readinessRequest.enableBabelAutoInstrumentation,
    babelInstrumentationConfigPath: readinessRequest.babelInstrumentationConfigPath,
  });
  performedSteps.push('Ensured ordinary dev server is running with the requested infra profile.');

  const readiness = await getInfraReadiness(context, request);
  return {
    ...readiness,
    performedSteps,
  };
}

export async function restartInfraReadiness(context, request = {}) {
  const readinessRequest = resolveInfraReadinessRequest(request);
  const performedSteps = [];
  const reverseRelay = await getReverseServiceStatus('RELAY');
  const ordinaryDevServer = await getOrdinaryDevServerStatus();

  if (ordinaryDevServer.running) {
    await stopOrdinaryDevServer();
    performedSteps.push('Stopped ordinary dev server before infra restart.');
  }

  if (readinessRequest.loggingEnabled && reverseRelay.managed) {
    await stopReverseService('RELAY');
    performedSteps.push('Stopped managed relay before infra restart.');
  }

  const neo4jRecovery = await recoverNeo4j(context);
  performedSteps.push(neo4jRecovery.message);

  const ensured = await ensureInfraReadiness(context, request);
  return {
    ...ensured,
    restart: {
      neo4jRecovery,
    },
    performedSteps: [
      ...performedSteps,
      ...(Array.isArray(ensured.performedSteps) ? ensured.performedSteps : []),
    ],
  };
}

export async function recoverNeo4j(context) {
  const before = await getInfraServiceStatus('NEO4J', context);
  if (isExternallyManagedNeo4j()) {
    return {
      ...buildExternalNeo4jManagementStatus(before, 'recover-neo4j'),
      ok: before.healthy,
      killedPid: null,
      restarted: false,
      before,
      after: before,
      performedSteps: ['Neo4j launch mode is external; no listener was killed and no managed process was started.'],
      errors: before.healthy ? [] : [before.error || 'Desktop Neo4j is not reachable.'],
    };
  }

  const performedSteps = [];
  const errors = [];
  let killedPid = null;
  let restarted = false;

  const normalizedUri = normalizeNeo4jDriverUri(context.uri);
  const neo4jPort = normalizedUri ? Number(new URL(normalizedUri).port || 7687) : 7687;
  const portListener = await getListeningProcessByPort(neo4jPort);

  if (portListener?.pid) {
    try {
      await terminateProcessTree(portListener.pid);
      killedPid = portListener.pid;
      performedSteps.push(`Killed Neo4j listener PID ${portListener.pid} on port ${neo4jPort}.`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  } else {
    performedSteps.push(`No Neo4j listener was found on port ${neo4jPort}.`);
  }

  if (!errors.length) {
    try {
      const nextStatus = await startInfraService('NEO4J', context);
      restarted = Boolean(nextStatus.healthy || nextStatus.running || nextStatus.reachable);
      performedSteps.push(restarted
        ? 'Requested Neo4j start through the gateway infra service manager.'
        : 'Neo4j start was requested, but the service did not report healthy readiness yet.');
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const after = await getInfraServiceStatus('NEO4J', context);

  return {
    ok: after.healthy,
    message: after.healthy
      ? 'Neo4j recovered and is accepting transactions.'
      : errors.length
        ? 'Neo4j recovery attempted but failed.'
        : 'Neo4j recovery attempted, but the database is still not healthy.',
    killedPid,
    restarted,
    performedSteps,
    errors,
    before,
    after,
  };
}

export async function cleanupRuntimeIngestion(context) {
  const runtimeStore = isRedisRuntimeStoreConfig(context.runtimeStore)
    ? context.runtimeStore
    : buildRuntimeStoreConfig();
  const redis = await pingRuntimeRedis(runtimeStore);
  const errors = [];
  const performedSteps = [];

  if (!redis.healthy) {
    errors.push('Redis runtime store is not healthy, so cleanup was skipped.');
  } else {
    try {
      const cleanup = await clearRuntimeRedis(runtimeStore);
      performedSteps.push(`Deleted ${cleanup.removedKeys} Redis runtime keys from namespace ${cleanup.namespace}.`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return buildRuntimeCleanupResult({
    ok: errors.length === 0,
    message: errors.length
      ? `Runtime ingestion cleanup completed with skips: ${errors.join(' ')}`
      : `Redis runtime namespace ${runtimeStore.namespace} was cleaned. Relay remained stateless.`,
    cleanedTargets: errors.length ? [] : ['REDIS'],
    performedSteps,
    errors,
    redis: {
      ...redis,
      service: 'REDIS',
    },
    runtimeIngestionReadiness: await getRuntimeIngestionReadiness({ ...context, runtimeStore }),
  });
}

export async function stopRuntimeIngestionReadiness(context) {
  const relayStatus = await getReverseServiceStatus('RELAY');

  if (relayStatus.managed) {
    await stopReverseService('RELAY');
  }

  return getRuntimeIngestionReadiness(context);
}

export function normalizeNeo4jDriverUri(uri) {
  if (!uri) {
    return uri;
  }

  if (!uri.startsWith('neo4j://')) {
    return uri;
  }

  const parsed = new URL(uri);
  const isLocalHost = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';

  return isLocalHost ? uri.replace('neo4j://', 'bolt://') : uri;
}

export async function getOrdinaryDevServerStatus() {
  const spec = getDevopsServiceSpec('ORDINARY_SERVER');
  const record = getDevopsServiceRecord('ORDINARY_SERVER');
  const portStatus = await getDevopsPortStatus('ORDINARY_DEV', record?.pid);
  const reachable = await isHttpServiceHealthy(spec.url);

  return {
    script: spec.script,
    url: spec.url,
    pid: record?.pid || portStatus.listenerPid || null,
    managed: portStatus.managed,
    startedAt: record?.startedAt || null,
    logPath: record?.logPath || null,
    lastExitCode: record?.lastExitCode ?? null,
    running: Boolean((record?.running && record?.pid && isPidAlive(record.pid)) || portStatus.listenerPid),
    healthy: reachable,
    reachable: portStatus.reachable,
    error: portStatus.orphaned
      ? `Port ${portStatus.port} is occupied by unmanaged PID ${portStatus.listenerPid}.`
      : null,
    port: portStatus,
    loggingEnabled: record?.loggingEnabled !== false,
  };
}

const ORDINARY_DEV_SERVER_POST_HEALTH_SETTLE_MS = 4_000;
const ORDINARY_DEV_SERVER_MIN_HEALTHY_AGE_MS = 12_000;
const ORDINARY_DEV_SERVER_COMPILE_SUCCESS_PATTERNS = [
  /compiled successfully/i,
  /compiled with warnings/i,
  /webpack .*compiled/i,
];

function getStartedAtMs(value) {
  if (!value) {
    return undefined;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function readOrdinaryDevServerLogState(logPath) {
  if (!logPath || !fs.existsSync(logPath)) {
    return {
      hasCompileSuccess: false,
      size: 0,
    };
  }

  const text = fs.readFileSync(logPath, 'utf8');
  const tail = text.slice(-32_768);

  return {
    hasCompileSuccess: ORDINARY_DEV_SERVER_COMPILE_SUCCESS_PATTERNS.some((pattern) => pattern.test(tail)),
    size: Buffer.byteLength(text),
  };
}

function readLogTail(logPath, lineCount = 12) {
  if (!logPath || !fs.existsSync(logPath)) {
    return [];
  }

  return fs.readFileSync(logPath, 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .slice(-Math.max(1, lineCount));
}

function buildManagedServiceLogTail(logPath, lineCount = 12, startedAt) {
  if (!logPath || !fs.existsSync(logPath)) {
    return {
      filePath: logPath || null,
      exists: false,
      updatedAt: null,
      size: 0,
      freshForCurrentRun: false,
      tailLineCount: Math.max(1, lineCount),
      tail: [],
      hasCompileSuccess: undefined,
    };
  }

  const stat = fs.statSync(logPath);
  const logState = readOrdinaryDevServerLogState(logPath);
  const startedAtMs = getStartedAtMs(startedAt);
  const freshForCurrentRun = !startedAtMs || stat.mtimeMs >= startedAtMs - 2_000;

  return {
    filePath: logPath,
    exists: true,
    updatedAt: stat.mtime.toISOString(),
    size: stat.size,
    freshForCurrentRun,
    tailLineCount: Math.max(1, lineCount),
    tail: readLogTail(logPath, lineCount),
    hasCompileSuccess: logState.hasCompileSuccess,
  };
}

export function getOrchestratorStatus(gatewayUrl) {
  const uptimeMs = Math.max(0, Math.round(process.uptime() * 1000));
  const startedAt = new Date(Date.now() - uptimeMs).toISOString();
  const record = readGraphGatewayServiceRecord();
  const managed = ORCHESTRATOR_CONFIG.persistProcessState
    ? Boolean(record?.pid === process.pid)
    : false;

  return {
    ok: true,
    projectRoots: projectPaths,
    url: gatewayUrl || 'http://127.0.0.1:8791/',
    pid: process.pid,
    execPath: process.execPath,
    startedAt,
    uptimeMs,
    reachable: true,
    managed,
    logPath: record?.logPath || getGraphGatewayFallbackLogPath(),
    lastExitCode: managed ? record?.lastExitCode ?? null : null,
    notes: [
      'Persistent launcher: npm run graph:orchestrator:ensure.',
      'Foreground launcher: npm run graph:orchestrator.',
      'Health probe helper: node ./dev/checkOrchestratorHealth.mjs.',
    ],
    quickstartRunbook: buildOrchestratorQuickstartRunbook(gatewayUrl),
    routes: buildApiRouteCatalog(gatewayUrl),
  };
}

export function getOrchestratorRestartRunbook(gatewayUrl) {
  const baseUrl = gatewayUrl || 'http://127.0.0.1:8791/';
  const statusUrl = new URL('/api/status/gateway', baseUrl).toString();
  const restartKnowledgeUrl = new URL('/api/knowledge/restart-orchestrator', baseUrl).toString();
  const status = getOrchestratorStatus(baseUrl);

  return {
    ok: true,
    manualActionRequired: true,
    action: 'restart-orchestrator',
    url: restartKnowledgeUrl,
    reason: 'The orchestrator should not terminate and relaunch itself from inside its own HTTP request handler. Use the returned commands from the controlling shell or agent instead.',
    current: {
      pid: status.pid,
      execPath: status.execPath,
      gatewayUrl: baseUrl,
      statusUrl,
      managed: status.managed,
      logPath: status.logPath,
      startedAt: status.startedAt,
      uptimeMs: status.uptimeMs,
    },
    warnings: [
      'Run these commands outside the orchestrator process.',
      'In PowerShell, do not assign to $PID; it is a built-in read-only variable. Use $orchPid.',
      'After restart, verify that /api/status/gateway reports a different pid or a newer startedAt.',
    ],
    powershell: {
      command: [
        `$orchPid = (Invoke-RestMethod ${statusUrl}).pid`,
        'if ($orchPid) { Stop-Process -Id $orchPid -Force }',
        'Start-Sleep -Seconds 2',
        'npm run graph:orchestrator:ensure',
        'npm run graph:orchestrator:check',
      ].join('\n'),
      expectedSignals: [
        'graph:orchestrator:ensure returns ok=true',
        'graph:orchestrator:check returns reachable=true',
        `pid differs from ${status.pid} or startedAt is newer`,
      ],
    },
    steps: [
      {
        step: 1,
        kind: 'read-current-pid',
        command: `$orchPid = (Invoke-RestMethod ${statusUrl}).pid`,
      },
      {
        step: 2,
        kind: 'stop-process',
        command: 'if ($orchPid) { Stop-Process -Id $orchPid -Force }',
      },
      {
        step: 3,
        kind: 'wait',
        command: 'Start-Sleep -Seconds 2',
      },
      {
        step: 4,
        kind: 'start',
        command: 'npm run graph:orchestrator:ensure',
      },
      {
        step: 5,
        kind: 'verify',
        command: 'npm run graph:orchestrator:check',
      },
    ],
  };
}

function buildOrchestratorQuickstartRunbook(gatewayUrl) {
  const baseUrl = gatewayUrl || 'http://127.0.0.1:8791/';
  const buildUrl = (pathname) => new URL(pathname, baseUrl).toString();

  return {
    summary: 'Usual local cycle: verify orchestrator, request Neo4j start, then verify Neo4j readiness.',
    steps: [
      {
        step: 1,
        label: 'Check orchestrator',
        method: 'GET',
        path: '/api/status/gateway',
        url: buildUrl('/api/status/gateway'),
        command: `curl.exe -s ${buildUrl('/api/status/gateway')}`,
        successSignals: [
          'ok=true',
          'reachable=true',
        ],
      },
      {
        step: 2,
        label: 'Start Neo4j',
        method: 'POST',
        path: '/api/actions/start-neo4j',
        url: buildUrl('/api/actions/start-neo4j'),
        command: `curl.exe -s -X POST -H "content-type: application/json" -d "{}" ${buildUrl('/api/actions/start-neo4j')}`,
        successSignals: [
          'healthy=true in the response body',
          'managed=true when the orchestrator owns the started process',
        ],
      },
      {
        step: 3,
        label: 'Check readiness',
        method: 'GET',
        path: '/api/status/neo4j',
        url: buildUrl('/api/status/neo4j'),
        command: `curl.exe -s ${buildUrl('/api/status/neo4j')}`,
        successSignals: [
          'healthy=true',
          'reachable=true',
        ],
      },
    ],
  };
}

export async function getGraphReproMonitorStatus(context, { tailLines = 12 } = {}) {
  const [ordinaryDevServer, neo4j] = await Promise.all([
    getOrdinaryDevServerStatus(),
    getInfraServiceStatus('NEO4J', context),
  ]);
  const gateway = getOrchestratorStatus(context?.gatewayUrl);
  const gatewayLog = buildManagedServiceLogTail(gateway.logPath, tailLines, gateway.startedAt);
  const ordinaryDevServerLog = buildManagedServiceLogTail(ordinaryDevServer.logPath, tailLines, ordinaryDevServer.startedAt);
  const ready = Boolean(gateway.ok && ordinaryDevServer.healthy && neo4j.healthy);
  const messageParts = [
    gateway.ok
      ? gatewayLog.exists
        ? gatewayLog.freshForCurrentRun
          ? `gateway ok pid=${gateway.pid} with current-run log`
          : `gateway ok pid=${gateway.pid} with stale log file`
        : `gateway ok pid=${gateway.pid}`
      : 'gateway unavailable',
    ordinaryDevServer.healthy
      ? `ordinary dev ready on ${ordinaryDevServer.url}`
      : ordinaryDevServer.error || 'ordinary dev server is not healthy',
    neo4j.healthy
      ? 'neo4j reachable'
      : neo4j.error || 'neo4j is not reachable',
    ordinaryDevServerLog.exists
      ? !ordinaryDevServerLog.freshForCurrentRun
        ? 'ordinary dev log file is stale for the current run'
        : ordinaryDevServerLog.hasCompileSuccess
        ? 'ordinary dev log contains compile success marker'
        : 'ordinary dev log has no compile success marker in current tail'
      : 'ordinary dev log is not available',
  ];

  return {
    checkedAt: new Date().toISOString(),
    ready,
    message: messageParts.join('. '),
    gateway,
    gatewayLog,
    ordinaryDevServer,
    neo4j,
    ordinaryDevServerLog,
  };
}

function buildProcessSnapshot(id, status = {}, extra = {}) {
  return {
    id,
    label: extra.label || id,
    pid: status?.pid || null,
    running: Boolean(status?.running),
    healthy: typeof status?.healthy === 'boolean' ? status.healthy : null,
    reachable: typeof status?.reachable === 'boolean' ? status.reachable : null,
    managed: typeof status?.managed === 'boolean' ? status.managed : null,
    startedAt: status?.startedAt || null,
    logPath: status?.logPath || null,
    lastExitCode: status?.lastExitCode ?? null,
    error: status?.error || null,
    port: extra.port || status?.port || status?.details?.portStatus || null,
    kind: extra.kind || null,
  };
}

function collectDiagnosticActions(...actionGroups) {
  const seen = new Set();

  return actionGroups.flatMap((group) => group || []).filter((action) => {
    const key = JSON.stringify([
      action?.action,
      action?.path,
      action?.method,
      action?.body || null,
    ]);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

export async function getProcessDiagnosticsStatus(context, { tailLines = 20 } = {}) {
  const [ordinaryDevServer, mockedServer, playwrightDevops, relay, neo4j, runtimeIngestion] = await Promise.all([
    getOrdinaryDevServerStatus(),
    getMockedDevServerStatus(),
    getPlaywrightDevopsStatus(),
    getReverseServiceStatus('RELAY'),
    getInfraServiceStatus('NEO4J', context),
    getRuntimeIngestionReadiness(context),
  ]);

  const gateway = getOrchestratorStatus(context?.gatewayUrl);
  const processSnapshots = [
    buildProcessSnapshot('gateway', gateway, { label: 'Orchestrator', kind: 'gateway' }),
    buildProcessSnapshot('ordinary-dev-server', ordinaryDevServer, { label: 'Ordinary Dev Server', kind: 'dev-server' }),
    buildProcessSnapshot('mocked-dev-server', mockedServer, { label: 'Mocked Dev Server', kind: 'dev-server' }),
    buildProcessSnapshot('reverse-relay', relay, { label: 'Runtime Relay', kind: 'reverse-service' }),
    buildProcessSnapshot('neo4j', neo4j, { label: 'Neo4j', kind: 'infra-service' }),
    buildProcessSnapshot('graph-session-launch', playwrightDevops?.ordinarySession?.launch, { label: 'Graph Session Launch', kind: 'playwright-launch' }),
    buildProcessSnapshot('ordinary-session-capture', playwrightDevops?.ordinarySession?.capture, { label: 'Ordinary Session Capture', kind: 'playwright-capture' }),
    buildProcessSnapshot('mocked-session-capture', playwrightDevops?.mockedSession?.capture, { label: 'Mocked Session Capture', kind: 'playwright-capture' }),
  ];
  const activeProcessCount = processSnapshots.filter((item) => item.running || item.pid).length;
  const unhealthyCount = processSnapshots.filter((item) => item.healthy === false || item.error).length;
  const logTails = {
    gateway: buildManagedServiceLogTail(gateway.logPath, tailLines, gateway.startedAt),
    ordinaryDevServer: buildManagedServiceLogTail(ordinaryDevServer.logPath, tailLines, ordinaryDevServer.startedAt),
    mockedDevServer: buildManagedServiceLogTail(mockedServer.logPath, tailLines, mockedServer.startedAt),
    relay: buildManagedServiceLogTail(relay.logPath, tailLines, relay.startedAt),
    ordinarySessionCapture: buildManagedServiceLogTail(playwrightDevops?.ordinarySession?.capture?.logPath, tailLines, playwrightDevops?.ordinarySession?.capture?.startedAt),
    mockedSessionCapture: buildManagedServiceLogTail(playwrightDevops?.mockedSession?.capture?.logPath, tailLines, playwrightDevops?.mockedSession?.capture?.startedAt),
  };
  const actions = collectDiagnosticActions(
    ordinaryDevServer?.actions,
    mockedServer?.actions,
    playwrightDevops?.actions,
    runtimeIngestion?.actions,
    playwrightDevops?.ordinarySession?.actions,
    playwrightDevops?.mockedSession?.actions,
  );

  return {
    checkedAt: new Date().toISOString(),
    summary: {
      activeProcessCount,
      unhealthyCount,
      orphanedPortCount: Array.isArray(playwrightDevops?.orphanedProcesses) ? playwrightDevops.orphanedProcesses.length : 0,
      runtimeReady: Boolean(runtimeIngestion?.ready),
    },
    message: unhealthyCount
      ? `Detected ${unhealthyCount} unhealthy or errored process surfaces across ${activeProcessCount} tracked process slots.`
      : `Tracked ${activeProcessCount} active process slots with no unhealthy process surfaces reported.`,
    processes: processSnapshots,
    ports: playwrightDevops?.ports || [],
    orphanedProcesses: playwrightDevops?.orphanedProcesses || [],
    runtimeIngestion,
    services: {
      gateway,
      ordinaryDevServer,
      mockedServer,
      relay,
      neo4j,
      playwrightDevops,
    },
    logTails,
    actions,
  };
}

function isOrdinaryDevServerReady(status) {
  if (!status?.healthy) {
    return false;
  }

  const startedAtMs = getStartedAtMs(status.startedAt);
  const startupAgeMs = startedAtMs ? Date.now() - startedAtMs : 0;
  const logState = readOrdinaryDevServerLogState(status.logPath);

  if (logState.hasCompileSuccess) {
    return true;
  }

  return startupAgeMs >= ORDINARY_DEV_SERVER_MIN_HEALTHY_AGE_MS;
}

async function waitForOrdinaryDevServerSettle(deadlineAt) {
  const settleDeadlineAt = Math.min(
    deadlineAt,
    Date.now() + Math.max(ORDINARY_DEV_SERVER_POST_HEALTH_SETTLE_MS, ORDINARY_DEV_SERVER_MIN_HEALTHY_AGE_MS),
  );
  let lastStatus = await getOrdinaryDevServerStatus();

  while (Date.now() < settleDeadlineAt) {
    if (!lastStatus.healthy) {
      return lastStatus;
    }

    if (isOrdinaryDevServerReady(lastStatus)) {
      return lastStatus;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
    lastStatus = await getOrdinaryDevServerStatus();
  }

  return lastStatus;
}

function buildOrdinaryDevServerStartError(status) {
  const logTail = buildManagedServiceLogTail(status?.logPath, 20, status?.startedAt);
  const messageParts = [
    'Ordinary dev server did not become healthy.',
    status?.error || 'No health error was reported.',
    status?.logPath ? `Log: ${status.logPath}` : 'Log path is unavailable.',
  ];

  if (logTail.exists && logTail.tail.length) {
    messageParts.push(`Log tail:\n${logTail.tail.join('\n')}`);
  }

  const error = new Error(messageParts.join(' '));
  error.cause = {
    healthy: Boolean(status?.healthy),
    reachable: Boolean(status?.reachable),
    running: Boolean(status?.running),
    pid: status?.pid || null,
    lastExitCode: status?.lastExitCode ?? null,
    logPath: status?.logPath || null,
    logTail: logTail.tail,
  };

  return error;
}

export async function stopOrdinaryDevServer() {
  const record = getDevopsServiceRecord('ORDINARY_SERVER');
  if (record?.pid && isPidAlive(record.pid)) {
    await terminateProcessTree(record.pid);
  } else {
    const portStatus = await getDevopsPortStatus('ORDINARY_DEV');
    if (portStatus.listenerPid) {
      await terminateProcessTree(portStatus.listenerPid);
    }
  }

  DEVOPS_SERVICE_RUNTIME.delete('ORDINARY_SERVER');
  deletePersistedServiceRecord('devops', 'ORDINARY_SERVER');
}

export async function startOrdinaryDevServer(request = {}) {
  if (ordinaryDevServerStartPromise) {
    return ordinaryDevServerStartPromise;
  }

  ordinaryDevServerStartPromise = (async () => {
    const { config } = resolveFeatureLoggingRequest(request);
    const spec = getDevopsServiceSpec('ORDINARY_SERVER');
    const currentStatus = await getOrdinaryDevServerStatus();
    const currentRecord = getDevopsServiceRecord('ORDINARY_SERVER');
    const configJson = JSON.stringify(config);

    const shouldReuseCurrent = Boolean(
      currentRecord?.pid
      && isPidAlive(currentRecord.pid)
      && !currentStatus.error
      && currentRecord.profileConfigJson === configJson
      && currentRecord.loggingEnabled === config.loggingEnabled,
    );

    if (shouldReuseCurrent) {
      const deadlineAt = Date.now() + spec.startTimeoutMs;
      let lastStatus = currentStatus;

      while (Date.now() < deadlineAt) {
        if (lastStatus.healthy) {
          return waitForOrdinaryDevServerSettle(deadlineAt);
        }

        await new Promise((resolve) => setTimeout(resolve, 1_000));
        lastStatus = await getOrdinaryDevServerStatus();
      }

      throw buildOrdinaryDevServerStartError(lastStatus);
    }

    if (currentStatus.running) {
      await stopOrdinaryDevServer();
    }

    ensureDevopsServiceLogDir();
    const logPath = path.join(DEVOPS_SERVICE_LOG_DIR, 'ordinary_server.log');
    const logFd = fs.openSync(logPath, 'a');
    const launchEnv = buildFeatureLoggingEnv(request);
    const spawnSpec = buildNpmRunSpawnSpec(spec.script);
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: process.cwd(),
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
      env: {
        ...process.env,
        ...launchEnv,
      },
    });

    fs.closeSync(logFd);

    const record = {
      pid: child.pid,
      startedAt: new Date().toISOString(),
      logPath,
      running: true,
      lastExitCode: null,
      loggingEnabled: config.loggingEnabled,
      profileConfigJson: configJson,
    };
    DEVOPS_SERVICE_RUNTIME.set('ORDINARY_SERVER', record);
    writePersistedServiceRecord('devops', 'ORDINARY_SERVER', record);

    child.on('exit', (code) => {
      const nextRecord = DEVOPS_SERVICE_RUNTIME.get('ORDINARY_SERVER');
      if (!nextRecord || nextRecord.pid !== child.pid) {
        return;
      }

      DEVOPS_SERVICE_RUNTIME.set('ORDINARY_SERVER', {
        ...nextRecord,
        running: false,
        lastExitCode: code ?? 0,
      });
      deletePersistedServiceRecord('devops', 'ORDINARY_SERVER');
    });

    child.unref();

    const deadlineAt = Date.now() + spec.startTimeoutMs;
    let lastStatus = await getOrdinaryDevServerStatus();
    while (Date.now() < deadlineAt) {
      if (lastStatus.healthy) {
        return waitForOrdinaryDevServerSettle(deadlineAt);
      }

      await new Promise((resolve) => setTimeout(resolve, 1_000));
      lastStatus = await getOrdinaryDevServerStatus();
    }

    throw buildOrdinaryDevServerStartError(lastStatus);
  })();

  try {
    return await ordinaryDevServerStartPromise;
  } finally {
    ordinaryDevServerStartPromise = undefined;
  }
}

export async function launchGraphSession(request = {}) {
  const { config } = resolveFeatureLoggingRequest(request);
  const configJson = JSON.stringify(config);

  await stopGraphSession();

  const ordinaryStatus = await startOrdinaryDevServer(request);
  if (!ordinaryStatus.healthy || ordinaryStatus.loggingEnabled !== config.loggingEnabled) {
    throw new Error(
      `Failed to activate ordinary dev server for requested logging state. `
      + `healthy=${Boolean(ordinaryStatus.healthy)} loggingEnabled=${Boolean(ordinaryStatus.loggingEnabled)}.`,
    );
  }

  const reusableSessionStatus = await getPlaywrightSessionStatus('ORDINARY_DEV');
  if (reusableSessionStatus.storageStateExists && reusableSessionStatus.savedSessionLikelyUsable) {
    return reusableSessionStatus;
  }

  const sessionSpec = getPlaywrightSessionSpec('ORDINARY_DEV');
  const sessionSource = fs.existsSync(sessionSpec.userDataDir)
    ? sessionSpec.userDataDir
    : fs.existsSync(sessionSpec.storageStatePath)
      ? sessionSpec.storageStatePath
      : 'login';

  ensureDevopsServiceLogDir();
  const logPath = path.join(DEVOPS_SERVICE_LOG_DIR, 'graph_session_ordinary_dev.log');
  const logFd = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [path.resolve(process.cwd(), 'dev', 'openGraphSession.mjs')], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    env: {
      ...process.env,
      PLAYWRIGHT_SESSION_URL: sessionSpec.baseUrl,
      PLAYWRIGHT_STORAGE_STATE: sessionSpec.storageStatePath,
      PLAYWRIGHT_SESSION_USER_DATA_DIR: sessionSpec.userDataDir,
    },
  });

  fs.closeSync(logFd);

  const record = {
    pid: child.pid,
    script: GRAPH_SESSION_LAUNCH_SPEC.script,
    startedAt: new Date().toISOString(),
    logPath,
    running: true,
    lastExitCode: null,
    loggingEnabled: config.loggingEnabled,
    profileConfigJson: configJson,
    sessionSource,
    sessionMode: 'launcher',
    baseUrl: sessionSpec.baseUrl,
  };
  DEVOPS_SERVICE_RUNTIME.set(GRAPH_SESSION_LAUNCH_SPEC.service, record);
  writePersistedServiceRecord('devops', GRAPH_SESSION_LAUNCH_SPEC.service, record);

  child.on('exit', (code) => {
    const currentRecord = DEVOPS_SERVICE_RUNTIME.get(GRAPH_SESSION_LAUNCH_SPEC.service);
    if (!currentRecord || currentRecord.pid !== child.pid) {
      return;
    }

    const stoppedRecord = {
      ...currentRecord,
      running: false,
      lastExitCode: code ?? 0,
    };
    DEVOPS_SERVICE_RUNTIME.set(GRAPH_SESSION_LAUNCH_SPEC.service, stoppedRecord);
    writePersistedServiceRecord('devops', GRAPH_SESSION_LAUNCH_SPEC.service, stoppedRecord);
  });

  child.unref();

  return getPlaywrightSessionStatus('ORDINARY_DEV');
}

export async function stopGraphSession() {
  const record = getGraphSessionLaunchRecord();
  if (record?.pid && isPidAlive(record.pid)) {
    await terminateProcessTree(record.pid);
  }

  DEVOPS_SERVICE_RUNTIME.delete(GRAPH_SESSION_LAUNCH_SPEC.service);
  deletePersistedServiceRecord('devops', GRAPH_SESSION_LAUNCH_SPEC.service);

  return getPlaywrightSessionStatus('ORDINARY_DEV');
}


import projectPaths from '../../../../../dev/projectPaths.cjs';
