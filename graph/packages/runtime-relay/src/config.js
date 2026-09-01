import { execFileSync } from 'node:child_process';

export const DEFAULT_RUNTIME_RELAY_URL = process.env.RUNTIME_RELAY_URL || 'http://127.0.0.1:8787/graph-relay';
export const DEFAULT_RUNTIME_RELAY_HEALTH_URL = new URL('/health', DEFAULT_RUNTIME_RELAY_URL).toString();
export const DEFAULT_RUNTIME_RELAY_STATS_URL = new URL('/stats', DEFAULT_RUNTIME_RELAY_URL).toString();
export const DEFAULT_RUNTIME_STORAGE_BACKEND = process.env.RUNTIME_STORAGE_BACKEND || 'redis';

const DEFAULT_RUNTIME_REDIS_URL = 'redis://127.0.0.1:6379';

function resolveWslRuntimeRedisUrl() {
  if (process.platform !== 'win32') {
    return null;
  }

  try {
    const host = execFileSync(
      'wsl',
      ['bash', '-lc', "command -v redis-cli >/dev/null 2>&1 && redis-cli ping >/dev/null 2>&1 && hostname -I | cut -d' ' -f1"],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    ).trim();

    return host ? `redis://${host}:6379` : null;
  } catch {
    return null;
  }
}

function isWindowsTcpEndpointReachable(host, port) {
  if (process.platform !== 'win32') {
    return false;
  }

  try {
    const raw = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Test-NetConnection ${host} -Port ${port} -WarningAction SilentlyContinue).TcpTestSucceeded`,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    ).trim().toLowerCase();

    return raw === 'true';
  } catch {
    return false;
  }
}

function resolveWindowsRuntimeRedisUrl() {
  if (process.platform !== 'win32') {
    return null;
  }

  if (isWindowsTcpEndpointReachable('127.0.0.1', 6379)) {
    return DEFAULT_RUNTIME_REDIS_URL;
  }

  const wslUrl = resolveWslRuntimeRedisUrl();
  if (!wslUrl) {
    return null;
  }

  const { hostname, port } = new URL(wslUrl);
  if (isWindowsTcpEndpointReachable(hostname, Number(port || 6379))) {
    return wslUrl;
  }

  return null;
}

export function buildRuntimeStoreConfig() {
  const resolvedRedisUrl = process.platform === 'win32'
    ? (process.env.RUNTIME_REDIS_URL || resolveWindowsRuntimeRedisUrl() || DEFAULT_RUNTIME_REDIS_URL)
    : (process.env.RUNTIME_REDIS_URL || DEFAULT_RUNTIME_REDIS_URL);

  return {
    backend: DEFAULT_RUNTIME_STORAGE_BACKEND,
    url: resolvedRedisUrl,
    namespace: process.env.RUNTIME_REDIS_NAMESPACE || 'runtime',
    connectTimeoutMs: Number(process.env.RUNTIME_REDIS_CONNECT_TIMEOUT_MS || 3000),
  };
}
