function buildJsonCommand(url, method = 'GET', body) {
  if (!body) {
    return `curl.exe -s ${url}`;
  }

  const payload = JSON.stringify(body).replace(/"/g, '\\"');
  return `curl.exe -s -X ${method} -H "content-type: application/json" -d "${payload}" ${url}`;
}

function buildOrchestratorRunbook(baseUrl) {
  const statusUrl = new URL('/api/status/gateway', baseUrl).toString();
  const startNeo4jUrl = new URL('/api/actions/start-neo4j', baseUrl).toString();
  const neo4jStatusUrl = new URL('/api/status/neo4j', baseUrl).toString();

  return {
    summary: 'Usual local cycle: check orchestrator, start Neo4j, then confirm Neo4j readiness.',
    steps: [
      {
        step: 1,
        label: 'Check orchestrator',
        method: 'GET',
        url: statusUrl,
        command: buildJsonCommand(statusUrl),
        successSignals: ['ok=true', 'reachable=true'],
      },
      {
        step: 2,
        label: 'Start Neo4j',
        method: 'POST',
        url: startNeo4jUrl,
        body: {},
        command: buildJsonCommand(startNeo4jUrl, 'POST', {}),
        successSignals: ['healthy=true in the response body', 'managed=true when the orchestrator owns the process'],
      },
      {
        step: 3,
        label: 'Check readiness',
        method: 'GET',
        url: neo4jStatusUrl,
        command: buildJsonCommand(neo4jStatusUrl),
        successSignals: ['healthy=true', 'reachable=true'],
      },
    ],
  };
}

export function getOrchestratorLanding(baseUrl = 'http://127.0.0.1:8791/') {
  const resolvedBaseUrl = new URL('/', baseUrl).toString();
  const healthUrl = new URL('/health', resolvedBaseUrl).toString();
  const statusUrl = new URL('/api/status/gateway', resolvedBaseUrl).toString();
  const knowledgeUrl = new URL('/api/knowledge/orchestrator', resolvedBaseUrl).toString();

  return {
    ok: true,
    kind: 'orchestrator-landing',
    summary: 'Root landing payload for the HTTP orchestrator. Start from status or knowledge, then use the 3-step Neo4j runbook below.',
    baseUrl: resolvedBaseUrl,
    visibleEntrypoints: {
      health: healthUrl,
      status: statusUrl,
      knowledge: knowledgeUrl,
    },
    runbook: buildOrchestratorRunbook(resolvedBaseUrl),
  };
}

export function getRuntimeCausalGuide() {
  return {
    summary: 'Runtime causal inspection is no longer exposed through a query-language transport in this package. Use the Redis-backed runtime-store and orchestrator status surfaces instead.',
    workflow: [
      'Run the browser helper scenario and wait until relay acceptance and Redis-backed runtime writes have caught up.',
      'Verify /api/status/runtime-ingestion before assuming runtime evidence exists.',
      'Use runtime-store-backed logs and explainability surfaces exposed by the orchestrator workflow instead of reviving legacy query contracts.',
      'If a dedicated HTTP causal-inspection route is needed later, add it to orchestrator.js instead of reviving query-language contracts.',
    ],
    caveats: [
      'HTTP 200 from relay proves queue acceptance, not by itself that Redis already contains the expected session rows.',
      'No legacy runtime-causal query endpoint remains in the active runtime-relay control surface.',
    ],
  };
}

export function getRuntimeIngestionGuide(baseUrl = 'http://127.0.0.1:8791') {
  const readinessUrl = `${baseUrl}/api/status/runtime-ingestion`;
  const ensureUrl = `${baseUrl}/api/actions/ensure-runtime-ingestion-readiness`;
  const repairUrl = `${baseUrl}/api/actions/repair-runtime-materialization`;

  return {
    summary: 'Bring relay and Redis into a ready state through the HTTP orchestrator surfaces instead of ad hoc shell runbooks.',
    workflow: [
      'Check /api/status/runtime-ingestion first; it is the canonical readiness surface for relay publish and Redis runtime-store availability.',
      'If readiness is false, inspect missingRequirements, actions, and materialization.repairSteps before choosing a follow-up action.',
      'Use /api/actions/ensure-runtime-ingestion-readiness to start the relay when the stack is not ready yet.',
      'Re-check /api/status/runtime-ingestion after each action instead of assuming relay startup implies runtime-store health.',
    ],
    caveats: [
      'Relay health proves HTTP acceptance only; it does not guarantee that the expected session has already been written into Redis.',
      'materialization is now a Redis-backed availability summary rather than legacy consumer telemetry.',
    ],
    readinessCheck: {
      purpose: 'Inspect the full readiness surface before choosing any orchestration action.',
      method: 'GET',
      url: readinessUrl,
      command: buildJsonCommand(readinessUrl),
      expectedSignals: [
        'ready should only be trusted when relay and Redis are both healthy.',
        'bootstrapPath.topologyMode should be relay-to-redis.',
        'actions and repairSteps already describe the next HTTP action and why it is recommended.',
      ],
    },
    ensureAction: {
      purpose: 'Start or adopt the relay in one idempotent orchestrator action.',
      method: 'POST',
      url: ensureUrl,
      body: {},
      command: buildJsonCommand(ensureUrl, 'POST', {}),
      expectedSignals: [
        'Use this when relay is down or runtime readiness is otherwise false.',
        'This action is idempotent and is the preferred recovery path before trying narrower manual restarts.',
      ],
    },
    repairAction: {
      purpose: 'Refresh the current Redis-backed readiness surface after relay or Redis-side changes.',
      method: 'POST',
      url: repairUrl,
      body: {},
      command: buildJsonCommand(repairUrl, 'POST', {}),
      expectedSignals: [
        'Use this when relay and Redis should already be healthy but readiness still needs to be refreshed.',
        'Re-check /api/status/runtime-ingestion after repair; relay health alone does not prove that Redis contains the expected runtime events.',
      ],
    },
  };
}

export function getOrchestratorGuide(baseUrl = 'http://127.0.0.1:8791/') {
  const healthUrl = new URL('/health', baseUrl).toString();
  const statusUrl = new URL('/api/status/gateway', baseUrl).toString();
  const knowledgeUrl = new URL('/api/knowledge/orchestrator', baseUrl).toString();
  const neo4jStatusUrl = new URL('/api/status/neo4j', baseUrl).toString();
  const infraReadinessUrl = new URL('/api/status/infra-readiness', baseUrl).toString();
  const ensureInfraReadinessUrl = new URL('/api/actions/ensure-infra-readiness', baseUrl).toString();
  const startNeo4jUrl = new URL('/api/actions/start-neo4j', baseUrl).toString();
  const restartInfraReadinessUrl = new URL('/api/actions/restart-infra-readiness', baseUrl).toString();
  const reproMonitorUrl = new URL('/api/status/repro-monitor?tailLines=12', baseUrl).toString();
  const processDiagnosticsUrl = new URL('/api/status/process-diagnostics?tailLines=20', baseUrl).toString();
  const annotationWorkflowStartUrl = new URL('/api/graph/annotations/workflow/start', baseUrl).toString();
  const annotationWorkflowCompleteUrl = new URL('/api/graph/annotations/workflow/complete', baseUrl).toString();
  const annotationJobsUrl = new URL('/api/annotation-jobs', baseUrl).toString();

  return {
    summary: 'Start the orchestrator from npm, verify the endpoint with the HTTP status route, and monitor long repro runs through the aggregated repro-monitor route instead of inferring progress from terminal silence.',
    startCommand: 'npm run graph:orchestrator',
    baseUrl,
    runbook: {
      ...buildOrchestratorRunbook(baseUrl),
      visibleAt: knowledgeUrl,
    },
    healthCheck: {
      purpose: 'Check that the orchestrator is up and that Neo4j connectivity succeeded.',
      url: healthUrl,
      command: buildJsonCommand(healthUrl),
      expectedSignals: [
        'HTTP 200 with ok=true means the orchestrator endpoint is reachable.',
        'database and uri confirm which Neo4j target the orchestrator verified during startup.',
      ],
    },
    statusCheck: {
      purpose: 'Inspect orchestrator pid, uptime, and managed log ownership through the status route.',
      url: statusUrl,
      command: buildJsonCommand(statusUrl),
      expectedSignals: [
        'ok=true means the status route itself is reachable.',
        'pid and uptimeMs let you tell whether you are still talking to the same orchestrator process after a restart.',
        'managed/logPath show whether the current orchestrator process wrote its own persisted state and log file.',
        'quickstartRunbook embeds the 3-call local cycle directly in the main gateway status payload.',
      ],
    },
    annotationWorkflow: {
      purpose: 'Resolve typed graph context recursively, canonicalize proxies, reuse persisted annotations, and execute missing annotations bottom-up through a persistent job.',
      preferredJobApi: {
        create: {
          method: 'POST',
          url: annotationJobsUrl,
          body: { stableId: '<stableId>', maxDepth: 4, refreshMode: 'reuse', clientContext: null },
          refreshModes: {
            reuse: 'Reuse every ready annotation whose code/context fingerprint is current.',
            root: 'Regenerate only the selected root while reusing ready dependency annotations.',
            subtree: 'Regenerate the root and every annotatable dependency in its bottom-up branch.',
          },
        },
        status: {
          method: 'GET',
          urlTemplate: new URL('/api/annotation-jobs/{jobId}', baseUrl).toString(),
        },
        leaseNext: {
          method: 'POST',
          urlTemplate: new URL('/api/annotation-jobs/{jobId}/lease-next', baseUrl).toString(),
        },
        completeTask: {
          method: 'POST',
          urlTemplate: new URL('/api/annotation-tasks/{taskId}/complete', baseUrl).toString(),
          note: 'Submit task.completion.body with only its text placeholder replaced.',
        },
      },
      compatibilityWorkflowApi: {
      start: {
        method: 'POST',
        url: annotationWorkflowStartUrl,
        body: { stableId: '<stableId>', maxDepth: 4, refreshMode: 'reuse', clientContext: null },
      },
      complete: {
        method: 'POST',
        url: annotationWorkflowCompleteUrl,
        note: 'Submit task.completion.body with only its text placeholder replaced. The response is the next task or the ready root annotation.',
      },
      },
      states: ['queued', 'needs-generation', 'waiting', 'ready'],
    },
    neo4jCheck: {
      purpose: 'Inspect the Neo4j dependency directly before feature-graph or static-draw operations.',
      url: neo4jStatusUrl,
      command: buildJsonCommand(neo4jStatusUrl),
      expectedSignals: [
        'healthy=true means feature graph resolution can talk to Neo4j right now.',
        'Use /api/actions/start-neo4j for a plain start request, or /api/actions/recover-neo4j when a stuck local listener may need replacement.',
      ],
    },
    startNeo4jAction: {
      purpose: 'Request a plain Neo4j start through the orchestrator-managed infra service registry.',
      url: startNeo4jUrl,
      method: 'POST',
      body: {},
      command: buildJsonCommand(startNeo4jUrl, 'POST', {}),
      expectedSignals: [
        'Use this first when Neo4j is simply down and no forced recovery path is needed.',
        'The response mirrors the Neo4j status surface, so healthy=true confirms the started instance is usable.',
      ],
    },
    processDiagnosticsCheck: {
      purpose: 'Inspect the full managed process surface, port ownership, runtime readiness, and recent log tails in one response.',
      url: processDiagnosticsUrl,
      command: buildJsonCommand(processDiagnosticsUrl),
      expectedSignals: [
        'summary.activeProcessCount shows how many tracked process slots currently have a pid or running flag.',
        'orphanedProcesses is the fastest way to catch unmanaged listeners before starting a second server copy.',
        'logTails lets you inspect current-run output without tailing individual log files manually.',
      ],
    },
    infraReadinessCheck: {
      purpose: 'Only read the current infra-readiness snapshot before choosing any recovery action.',
      url: infraReadinessUrl,
      method: 'GET',
      command: buildJsonCommand(infraReadinessUrl),
      expectedSignals: [
        'ready=true means the currently observed infra chain is healthy enough for a run without forcing changes.',
        'actions describes the next mutation surface instead of forcing manual process hunting.',
      ],
    },
    ensureInfraReadinessAction: {
      purpose: 'Read infra-readiness and start missing pieces when possible.',
      url: ensureInfraReadinessUrl,
      method: 'POST',
      body: { loggingEnabled: true },
      command: buildJsonCommand(ensureInfraReadinessUrl, 'POST', { loggingEnabled: true }),
      expectedSignals: [
        'Use this when you want the orchestrator to reconcile the stack without forcing a hard restart first.',
        'This is the generic pre-run infra mutation used by higher-level feature routes.',
      ],
    },
    restartInfraReadinessAction: {
      purpose: 'Force a restart of the managed infra-readiness chain and then read the resulting readiness snapshot.',
      url: restartInfraReadinessUrl,
      method: 'POST',
      body: { loggingEnabled: true },
      command: buildJsonCommand(restartInfraReadinessUrl, 'POST', { loggingEnabled: true }),
      expectedSignals: [
        'Use this when lighter ensure logic is not enough and a clean restart is desired.',
        'performedSteps explains which managed services were actually restarted.',
      ],
    },
    reproMonitorCheck: {
      purpose: 'Monitor an orchestrator-driven repro run through one aggregated status route instead of terminal idleness heuristics.',
      url: reproMonitorUrl,
      command: buildJsonCommand(reproMonitorUrl),
      expectedSignals: [
        'ready should become true only when the orchestrator is alive, the ordinary dev server is healthy, and Neo4j is reachable.',
        'gatewayLog.freshForCurrentRun=true means the current orchestrator process wrote the visible log file itself.',
        'ordinaryDevServerLog.hasCompileSuccess=true is the strongest signal that webpack finished compiling after a restart.',
      ],
    },
  };
}

export function getPlaywrightDevopsGuide(baseUrl = 'http://127.0.0.1:8791') {
  const statusUrl = `${baseUrl}/api/status/playwright-devops`;
  const mockedStatusUrl = `${baseUrl}/api/status/mocked-dev-server`;
  const startMockedUrl = `${baseUrl}/api/actions/start-mocked-dev-server`;
  const cleanupMockedUrl = `${baseUrl}/api/actions/cleanup-mocked-dev-server`;
  const startCaptureUrl = `${baseUrl}/api/actions/start-playwright-session-capture`;

  return {
    summary: 'Use the HTTP Playwright devops routes as the canonical surface for mocked dev server reachability, session storage state presence, orphaned ports, and the next recommended action.',
    workflow: [
      'Check /api/status/playwright-devops first to inspect mocked server health, ordinary and mocked session state, port bindings, and recommended actions.',
      'If the mocked dev server is not healthy, prefer /api/actions/start-mocked-dev-server or /api/actions/cleanup-mocked-dev-server instead of manual process hunting.',
      'If a Playwright flow depends on stored auth, inspect ordinarySession or mockedSession before rerunning the scenario.',
      'If storage state is missing or stale, refresh it through /api/actions/start-playwright-session-capture and then re-check /api/status/playwright-devops.',
    ],
    caveats: [
      'The orchestrator can detect missing storage state and unhealthy base URLs, but it does not complete interactive Telegram login for you.',
      'A reachable mocked server can still be unmanaged or orphaned; check port ownership before starting another copy.',
    ],
    statusCheck: {
      purpose: 'Inspect mocked server health, session-state presence, port ownership, and recommended actions in one response.',
      method: 'GET',
      url: statusUrl,
      command: buildJsonCommand(statusUrl),
      expectedSignals: [
        'mockedServer.healthy and mockedServer.reachable should be true before mocked helpers run against localhost:1235.',
        'If port.orphaned is true, use cleanup-mocked-dev-server before starting another mocked server.',
      ],
    },
    mockedStatusCheck: {
      purpose: 'Inspect only the mocked dev server surface when you do not need full Playwright session detail.',
      method: 'GET',
      url: mockedStatusUrl,
      command: buildJsonCommand(mockedStatusUrl),
      expectedSignals: [
        'healthy=true means the mocked dev server itself is reachable.',
        'port.orphaned=true means the port is occupied by an unmanaged process and should be cleaned first.',
      ],
    },
    startMockedAction: {
      purpose: 'Start the mocked webpack dev server through the gateway-managed HTTP surface.',
      method: 'POST',
      url: startMockedUrl,
      body: {},
      command: buildJsonCommand(startMockedUrl, 'POST', {}),
    },
    cleanupMockedAction: {
      purpose: 'Stop a gateway-managed mocked server or kill an orphaned listener on port 1235.',
      method: 'POST',
      url: cleanupMockedUrl,
      body: {},
      command: buildJsonCommand(cleanupMockedUrl, 'POST', {}),
    },
    startCaptureAction: {
      purpose: 'Start interactive or sourced Playwright session capture for a selected session kind.',
      method: 'POST',
      url: startCaptureUrl,
      body: { kind: 'ORDINARY_DEV' },
      command: buildJsonCommand(startCaptureUrl, 'POST', { kind: 'ORDINARY_DEV' }),
    },
  };
}

export function getReverseObservationGuide(baseUrl = 'http://127.0.0.1:8791') {
  const readinessUrl = `${baseUrl}/api/status/reverse-observation`;
  const ensureStackUrl = `${baseUrl}/api/actions/ensure-reverse-observation-stack`;
  const ensureServiceUrl = `${baseUrl}/api/actions/ensure-reverse-service`;

  return {
    summary: 'Use the HTTP reverse-observation readiness and repair routes before running thin browser helpers.',
    workflow: [
      'Check /api/status/reverse-observation before any helper run that depends on relay-backed runtime observation.',
      'If readiness is false, inspect actions and prefer /api/actions/ensure-reverse-observation-stack over manual restarts.',
      'Keep browser helpers thin: they should drive the app and emit runtime traffic, not interpret relay, Redis, or Neo4j results themselves.',
    ],
    caveats: [
      'Helper success does not prove relay publish unless the external observation surfaces confirm it.',
      'reverse-observation covers relay health only; Redis-backed runtime availability still belongs to /api/status/runtime-ingestion.',
    ],
    readinessCheck: {
      purpose: 'Inspect reverse observation readiness, unhealthy services, and recommended actions before running hot observation helpers.',
      method: 'GET',
      url: readinessUrl,
      command: buildJsonCommand(readinessUrl),
      expectedSignals: [
        'ready should be true before relying on relay-backed runtime observation during a helper run.',
        'If actions are present, prefer those HTTP actions over ad hoc terminal restarts.',
      ],
    },
    ensureStackAction: {
      purpose: 'Start or adopt all unhealthy reverse observation services in one idempotent HTTP action.',
      method: 'POST',
      url: ensureStackUrl,
      body: { services: ['RELAY'] },
      command: buildJsonCommand(ensureStackUrl, 'POST', { services: ['RELAY'] }),
    },
    ensureServiceAction: {
      purpose: 'Start or adopt one named reverse service when a narrower repair step is enough.',
      method: 'POST',
      url: ensureServiceUrl,
      body: { service: 'RELAY' },
      command: buildJsonCommand(ensureServiceUrl, 'POST', { service: 'RELAY' }),
    },
  };
}

export function getPlaywrightProjectGuide() {
  return {
    summary: 'Use this guide for the stable Playwright project entrypoints: default mocked base URL, top-level npm scripts, and the distinction between mocked and ordinary dev flows.',
    workflow: [
      'Run ordinary helpers against localhost:1234 only when the ordinary dev server is reachable.',
      'Run mocked helpers against localhost:1235 only when the mocked dev server status is healthy.',
      'Prefer orchestrator HTTP status routes over terminal heuristics for deciding whether the project is ready.',
    ],
  };
}


