import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

import { config } from 'dotenv';

config({ path: 'graph/.env' });

const DEFAULT_NEO4J_URI = process.env.NEO4J_URI || 'neo4j://127.0.0.1:7687';
const DEFAULT_NEO4J_HTTP_PORT = Number(process.env.NEO4J_HTTP_PORT || 7474);
const DEFAULT_NEO4J_CONTAINER_NAME = process.env.NEO4J_CONTAINER_NAME || 'telegraph-neo4j-local';
const DEFAULT_NEO4J_DOCKER_IMAGE = process.env.NEO4J_DOCKER_IMAGE || 'neo4j:5-community';
const NEO4J_LAUNCH_MODE = (process.env.NEO4J_LAUNCH_MODE || 'managed').trim().toLowerCase();
const DESKTOP_OFFLINE_DBMSS_ROOTS = [
  'C:\\Program Files\\Neo4j Desktop 2\\resources\\offline\\dbmss',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Neo4j Desktop 2', 'resources', 'offline', 'dbmss'),
];
const DESKTOP_OFFLINE_RUNTIME_ROOTS = [
  'C:\\Program Files\\Neo4j Desktop 2\\resources\\offline\\runtime',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Neo4j Desktop 2', 'resources', 'offline', 'runtime'),
];

function parseNeo4jUri(uri) {
  const parsed = new URL(uri.replace(/^neo4j(\+s)?/u, 'bolt$1'));
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 7687),
  };
}

async function checkTcpPort(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finalize = (result) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finalize(true));
    socket.once('timeout', () => finalize(false));
    socket.once('error', () => finalize(false));
    socket.connect(port, host);
  });
}

function resolveNeo4jHomeCandidate() {
  const neo4jHome = process.env.NEO4J_HOME;
  if (!neo4jHome) {
    return undefined;
  }

  const executableName = process.platform === 'win32' ? 'neo4j.bat' : 'neo4j';
  const executablePath = path.join(neo4jHome, 'bin', executableName);
  return fs.existsSync(executablePath) ? executablePath : undefined;
}

function canRunCommand(command, args = ['--version']) {
  try {
    execFileSync(command, args, {
      stdio: 'ignore',
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(bat|cmd)$/iu.test(command),
    });
    return true;
  } catch {
    return false;
  }
}

function listExistingDirectories(paths) {
  return paths.filter((candidate) => candidate && fs.existsSync(candidate));
}

function findNewestDirectory(rootPath, matcher) {
  if (!rootPath || !fs.existsSync(rootPath)) {
    return undefined;
  }

  const candidates = fs.readdirSync(rootPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && matcher(entry.name))
    .map((entry) => path.join(rootPath, entry.name))
    .sort((left, right) => right.localeCompare(left));

  return candidates[0];
}

function resolveDesktopBundleHome() {
  for (const rootPath of listExistingDirectories(DESKTOP_OFFLINE_DBMSS_ROOTS)) {
    const homePath = findNewestDirectory(rootPath, (name) => name.startsWith('neo4j-'));
    if (homePath && fs.existsSync(path.join(homePath, 'bin', process.platform === 'win32' ? 'neo4j.bat' : 'neo4j'))) {
      return homePath;
    }
  }

  return undefined;
}

function resolveDesktopJavaHome() {
  for (const rootPath of listExistingDirectories(DESKTOP_OFFLINE_RUNTIME_ROOTS)) {
    const javaHome = findNewestDirectory(rootPath, (name) => /jre21|jdk21/i.test(name));
    if (javaHome && fs.existsSync(path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'))) {
      return javaHome;
    }
  }

  return undefined;
}

function buildDesktopLaunchEnv() {
  const dataRoot = path.resolve(process.cwd(), '.cache', 'neo4j-desktop');
  const { host, port } = parseNeo4jUri(DEFAULT_NEO4J_URI);
  const javaHome = resolveDesktopJavaHome();

  return {
    ...(javaHome ? { JAVA_HOME: javaHome } : {}),
    NEO4J_ACCEPT_LICENSE_AGREEMENT: 'yes',
    NEO4J_dbms_security_procedures_unrestricted: 'apoc.*',
    NEO4J_dbms_security_procedures_allowlist: 'apoc.*',
    NEO4J_server_default__listen__address: host,
    NEO4J_server_http_listen__address: `${host}:${DEFAULT_NEO4J_HTTP_PORT}`,
    NEO4J_server_bolt_listen__address: `${host}:${port}`,
    NEO4J_server_directories_data: path.join(dataRoot, 'data'),
    NEO4J_server_directories_logs: path.join(dataRoot, 'logs'),
    NEO4J_server_directories_plugins: path.join(dataRoot, 'plugins'),
    NEO4J_server_directories_import: path.join(dataRoot, 'import'),
    NEO4J_server_directories_run: path.join(dataRoot, 'run'),
    NEO4J_server_directories_lib: path.join(dataRoot, 'lib'),
    NEO4J_server_directories_licenses: path.join(dataRoot, 'licenses'),
    NEO4J_server_directories_transaction__logs__root: path.join(dataRoot, 'transactions'),
  };
}

function ensureWritableDesktopHome(sourceHomePath) {
  const writableRoot = path.resolve(process.cwd(), '.cache', 'neo4j-desktop', 'home', path.basename(sourceHomePath));
  const executableName = process.platform === 'win32' ? 'neo4j.bat' : 'neo4j';
  const commandPath = path.join(writableRoot, 'bin', executableName);

  if (!fs.existsSync(commandPath)) {
    fs.mkdirSync(path.dirname(writableRoot), { recursive: true });
    fs.cpSync(sourceHomePath, writableRoot, {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
  }

  return writableRoot;
}

function installDesktopApocPlugin(sourceHomePath, writableHomePath) {
  const labsPath = path.join(sourceHomePath, 'labs');
  if (!fs.existsSync(labsPath)) {
    return;
  }

  const apocJar = fs.readdirSync(labsPath)
    .filter((entry) => /^apoc-.*-core\.jar$/u.test(entry))
    .sort((left, right) => right.localeCompare(left))[0];

  if (!apocJar) {
    return;
  }

  const pluginsPath = path.join(writableHomePath, 'plugins');
  fs.mkdirSync(pluginsPath, { recursive: true });

  for (const existingEntry of fs.readdirSync(pluginsPath)) {
    if (/^apoc-.*-core\.jar$/u.test(existingEntry) && existingEntry !== apocJar) {
      fs.rmSync(path.join(pluginsPath, existingEntry), { force: true });
    }
  }

  const sourceJarPath = path.join(labsPath, apocJar);
  const targetJarPath = path.join(pluginsPath, apocJar);
  fs.copyFileSync(sourceJarPath, targetJarPath);
}

function ensureDesktopLaunchDirectories(env) {
  [
    env.NEO4J_server_directories_data,
    env.NEO4J_server_directories_logs,
    env.NEO4J_server_directories_plugins,
    env.NEO4J_server_directories_import,
    env.NEO4J_server_directories_run,
    env.NEO4J_server_directories_lib,
    env.NEO4J_server_directories_licenses,
    env.NEO4J_server_directories_transaction__logs__root,
  ].forEach((targetPath) => {
    if (targetPath) {
      fs.mkdirSync(targetPath, { recursive: true });
    }
  });
}

function initializeDesktopPassword(homePath, env) {
  const password = process.env.NEO4J_PASSWORD;
  if (!password) {
    return;
  }

  const adminCommand = path.join(homePath, 'bin', process.platform === 'win32' ? 'neo4j-admin.bat' : 'neo4j-admin');
  try {
    execFileSync(adminCommand, ['dbms', 'set-initial-password', password], {
      stdio: 'ignore',
      windowsHide: true,
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        ...env,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already set|existing auth|live database/u.test(message)) {
      throw error;
    }
  }
}

function buildDesktopLaunchSpec() {
  const sourceHomePath = resolveDesktopBundleHome();
  if (!sourceHomePath) {
    return undefined;
  }

  const homePath = ensureWritableDesktopHome(sourceHomePath);
  const command = path.join(homePath, 'bin', process.platform === 'win32' ? 'neo4j.bat' : 'neo4j');
  const env = buildDesktopLaunchEnv();
  env.NEO4J_HOME = homePath;
  ensureDesktopLaunchDirectories(env);
  installDesktopApocPlugin(sourceHomePath, homePath);
  initializeDesktopPassword(homePath, env);

  return {
    command,
    args: ['console'],
    shell: process.platform === 'win32',
    source: 'NEO4J_DESKTOP',
    env,
  };
}

function resolveContainerRuntime() {
  if (canRunCommand('docker') && canRunCommand('docker', ['info'])) {
    return 'docker';
  }

  if (canRunCommand('podman') && canRunCommand('podman', ['info'])) {
    return 'podman';
  }

  return undefined;
}

function buildContainerLaunchSpec() {
  const { host, port } = parseNeo4jUri(DEFAULT_NEO4J_URI);
  const username = process.env.NEO4J_USER || process.env.NEO4J_USERNAME || 'neo4j';
  const password = process.env.NEO4J_PASSWORD;
  const containerRuntime = resolveContainerRuntime();

  if (!containerRuntime || !password) {
    return undefined;
  }

  if (host !== '127.0.0.1' && host !== 'localhost') {
    return undefined;
  }

  const dataDir = path.resolve(process.cwd(), '.cache', 'neo4j', 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  return {
    command: containerRuntime,
    args: [
      'run',
      '--rm',
      '--name',
      DEFAULT_NEO4J_CONTAINER_NAME,
      '-p',
      `${DEFAULT_NEO4J_HTTP_PORT}:${DEFAULT_NEO4J_HTTP_PORT}`,
      '-p',
      `${port}:${port}`,
      '-e',
      `NEO4J_AUTH=${username}/${password}`,
      '-e',
      `NEO4J_server_default__listen__address=0.0.0.0`,
      '-e',
      `NEO4J_server_http_listen__address=0.0.0.0:${DEFAULT_NEO4J_HTTP_PORT}`,
      '-e',
      `NEO4J_server_bolt_listen__address=0.0.0.0:${port}`,
      '-v',
      `${dataDir}:/data`,
      DEFAULT_NEO4J_DOCKER_IMAGE,
    ],
    shell: false,
    source: containerRuntime,
  };
}

function resolveNeo4jLaunchSpec() {
  const containerSpec = buildContainerLaunchSpec();

  const configuredBinary = process.env.NEO4J_BIN;
  if (configuredBinary && fs.existsSync(configuredBinary)) {
    return {
      command: configuredBinary,
      args: ['console'],
      shell: process.platform === 'win32' && /\.(bat|cmd)$/iu.test(configuredBinary),
      source: 'NEO4J_BIN',
    };
  }

  const homeBinary = resolveNeo4jHomeCandidate();
  if (homeBinary) {
    return {
      command: homeBinary,
      args: ['console'],
      shell: process.platform === 'win32' && /\.(bat|cmd)$/iu.test(homeBinary),
      source: 'NEO4J_HOME',
    };
  }

  const pathCommand = process.platform === 'win32' ? 'neo4j.bat' : 'neo4j';
  if (canRunCommand(pathCommand)) {
    return {
      command: pathCommand,
      args: ['console'],
      shell: process.platform === 'win32',
      source: 'PATH',
    };
  }

  if (containerSpec) {
    return containerSpec;
  }

  const desktopSpec = buildDesktopLaunchSpec();
  if (desktopSpec) {
    return desktopSpec;
  }

  if (process.platform === 'win32' && canRunCommand('wsl', ['bash', '-lc', 'command -v neo4j >/dev/null 2>&1'])) {
    return {
      command: 'wsl',
      args: ['bash', '-lc', 'neo4j console'],
      shell: false,
      source: 'WSL',
    };
  }

  throw new Error('Neo4j launcher not found. Install the neo4j CLI on PATH, set NEO4J_HOME/NEO4J_BIN, or provide Docker/Podman with NEO4J_PASSWORD.');
}

async function main() {
  if (NEO4J_LAUNCH_MODE === 'external') {
    console.log('Neo4j launch mode is external. Start Neo4j from Neo4j Desktop; graph:neo4j:start is a no-op.');
    return;
  }

  const { host, port } = parseNeo4jUri(DEFAULT_NEO4J_URI);
  const isReachable = await checkTcpPort(host, port);
  if (isReachable) {
    console.log(`Neo4j already running on ${host}:${port}.`);
    return;
  }

  const launchSpec = resolveNeo4jLaunchSpec();
  console.log(`Starting Neo4j via ${launchSpec.source}.`);

  const child = spawn(launchSpec.command, launchSpec.args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...launchSpec.env,
    },
    stdio: 'inherit',
    windowsHide: false,
    shell: launchSpec.shell,
  });

  child.on('error', (error) => {
    console.error(`Failed to start Neo4j: ${error.message}`);
    process.exitCode = 1;
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      console.error(`Neo4j process exited via signal ${signal}.`);
      process.exitCode = 1;
      return;
    }

    process.exitCode = code ?? 0;
  });
}

await main();
