import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import paths from '../../../../../dev/projectPaths.cjs';
import { getExtractStatus, resolvePythonExecutable } from './graphExtract.js';

const root = path.join(paths.dataRoot, 'checks', 'graph-ranking');
const parquet = path.join(paths.dataRoot, 'checks', 'streaming', 'parquet');
const lockPath = path.join(root, 'active.json');
let active = null;
let graphMutations = 0;
export async function withRankingExclusion(operation) {
  if (isRankingActive()) throw new Error('Graph ranking is active');
  graphMutations++;
  try { return await operation(); } finally { graphMutations--; }
}
export function getRankingPlan() {
  return { version: 3, parquet, outputRoot: root,
    levels: ['dependencyStructuralLevel', 'dependencyComponentLevel'],
    individual: 'No level for cycle members and consumers of cycles.',
    components: 'SCC sinks=0, consumer=1+max(external prerequisites).',
    generatesAnnotations: false, reextracts: false, annotationProfilesCertified: false,
    publication: 'Explicit POST /api/graph/ranking/persist; local Neo4j only; complete snapshot must match.' };
}
export function getAnnotationInventoryPlan() {
  return { version: 4, parquet, outputRoot: root,
    modes: ['standalone', 'inline', 'reference', 'unresolved'],
    generatesAnnotations: false, writesGraph: false, generationQueueCertified: false,
    evidence: 'Explicit body, ownership and reference edges with existing endpoints; all alternatives retained.',
    result: 'summary.json and subjects.parquet; paginated /api/graph/annotation-inventory/subjects',
    exclusion: 'Shares the ranking lock; cannot overlap managed extraction or graph mutations.' };
}
export async function getAnnotationInventoryPreflight() {
  return { ...await getRankingPreflight(), plan: getAnnotationInventoryPlan() };
}
export function getAnnotationInventoryStatus(runId) {
  const latestPath = path.join(root, 'latest-inventory.json');
  const id = runId || (fs.existsSync(latestPath) ? JSON.parse(fs.readFileSync(latestPath, 'utf8')).runId : null);
  const run = id ? readRun(id) : null;
  if (run && run.operation !== 'annotation-inventory') throw new Error('Invalid request: not an annotation inventory run');
  return { ok: true, running: run?.status === 'running' && active?.runId === id,
    recoveryRequired: run?.status === 'running' && active?.runId !== id,
    run, plan: getAnnotationInventoryPlan() };
}
export async function getAnnotationInventorySubjects({ runId, stableId, mode, limit = '50', offset = '0' }) {
  const { run } = getAnnotationInventoryStatus(runId);
  if (!run || run.status !== 'complete') throw new Error('Invalid request: completed inventory required');
  if (mode && !getAnnotationInventoryPlan().modes.includes(mode)) throw new Error('Invalid request: unknown inventory mode');
  if (!/^\d+$/.test(String(limit)) || Number(limit) < 1 || Number(limit) > 200 ||
      !/^\d+$/.test(String(offset)) || !Number.isSafeInteger(Number(offset))) throw new Error('Invalid request: invalid pagination');
  const args = [path.join(paths.toolRoot, 'dev', 'readAnnotationSubjects.py'), '--report', runPath(run.runId),
    '--limit', String(limit), '--offset', String(offset)];
  if (stableId) args.push('--stable-id', stableId);
  if (mode) args.push('--mode', mode);
  const { stdout } = await promisify(execFile)(resolvePythonExecutable(), args, {
    cwd: paths.toolRoot, windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  return { ok: true, runId: run.runId, ...JSON.parse(stdout) };
}
function runPath(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id || '')) throw new Error('Valid ranking runId required');
  return path.join(root, id);
}
function readRun(id) {
  const file = path.join(runPath(id), 'run.json');
  if (!fs.existsSync(file)) throw new Error('Invalid request: ranking runId not found');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function save(run) {
  const file = path.join(runPath(run.runId), 'run.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(run, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}
export function isRankingActive() { return active !== null || fs.existsSync(lockPath); }
export function getRankingStatus(runId) {
  const lock = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, 'utf8')) : null;
  const latest = fs.existsSync(path.join(root, 'latest.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'latest.json'), 'utf8')) : null;
  const id = runId || lock?.runId || latest?.runId;
  return { ok: true, running: Boolean(active), recoveryRequired: Boolean(lock && !active),
    run: id ? readRun(id) : null, lock, plan: getRankingPlan() };
}
export function recoverRanking() {
  if (!fs.existsSync(lockPath)) return { ok: true, recovered: false };
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const run = readRun(lock.runId);
  const alive = pid => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
  };
  if (active || alive(run.pid) || (lock.orchestratorPid !== process.pid && alive(lock.orchestratorPid))) {
    return { ok: false, error: 'Ranking owner or worker is still running' };
  }
  run.status = 'interrupted'; save(run); fs.unlinkSync(lockPath);
  return { ok: true, recovered: true, runId: run.runId };
}
export async function getRankingPreflight() {
  const missing = ['nodes.parquet', 'relationships.parquet'].filter(file => !fs.existsSync(path.join(parquet, file)));
  let python = null, error = null;
  try {
    python = resolvePythonExecutable();
    await promisify(execFile)(python, ['-c', 'import duckdb, pyarrow, neo4j, dotenv'], {
      cwd: paths.toolRoot, windowsHide: true, timeout: 15000 });
  } catch (failure) { error = failure.message; }
  const busy = isRankingActive() || graphMutations > 0 || getExtractStatus().running;
  return { ok: true, ready: !missing.length && !error && !busy, missing, python, error, busy, plan: getRankingPlan() };
}
function launch(run, python, script, args) {
  fs.mkdirSync(root, { recursive: true });
  const fd = fs.openSync(lockPath, 'wx');
  fs.writeFileSync(fd, JSON.stringify({ runId: run.runId, orchestratorPid: process.pid }));
  fs.closeSync(fd);
  active = run;
  fs.writeFileSync(path.join(root, run.operation === 'annotation-inventory' ? 'latest-inventory.json' : 'latest.json'), JSON.stringify({ runId: run.runId }));
  run.status = 'running'; run.startedAt = new Date().toISOString();
  save(run);
  run.logPath = path.join(runPath(run.runId), `${run.operation}.log`);
  const log = fs.openSync(run.logPath, 'a');
  const child = spawn(python, [path.join(paths.toolRoot, 'dev', script), ...args], {
    cwd: paths.toolRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  run.pid = child.pid; save(run);
  let pending = '', spawnError = null, stderrTail = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    fs.writeSync(log, chunk); pending += chunk;
    const lines = pending.split(/\r?\n/); pending = lines.pop().slice(-65536);
    for (const line of lines) {
      try { run.progress = JSON.parse(line); } catch { /* Diagnostics remain in log. */ }
    }
    save(run);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    fs.writeSync(log, chunk);
    stderrTail = (stderrTail + chunk).slice(-4000);
  });
  child.on('error', error => { spawnError = error.message; });
  child.on('close', code => {
    fs.closeSync(log);
    run.status = code === 0 && !spawnError ? 'complete' : 'failed';
    run.exitCode = code; run.error = spawnError || (code === 0 ? null : stderrTail || `Worker exited: ${code}`);
    run.completedAt = new Date().toISOString();
    try {
      if (['calculate', 'annotation-inventory'].includes(run.operation) && run.status === 'complete') {
        run.summary = JSON.parse(fs.readFileSync(path.join(runPath(run.runId), 'summary.json'), 'utf8'));
        run.calculationComplete = run.operation === 'calculate';
      }
    } catch (error) { run.status = 'failed'; run.error = error.message; }
    save(run); active = null; fs.unlinkSync(lockPath);
  });
  return { ok: true, runId: run.runId, status: run.status, operation: run.operation };
}
export async function startRanking() {
  const preflight = await getRankingPreflight();
  if (!preflight.ready || isRankingActive() || graphMutations > 0 || getExtractStatus().running) return { ok: false, error: 'Ranking preflight failed', preflight };
  const run = { runId: crypto.randomUUID(), operation: 'calculate', calculationComplete: false };
  fs.mkdirSync(runPath(run.runId), { recursive: true });
  return launch(run, preflight.python, 'globalGraphDependencyLevels.py', ['--parquet', parquet, '--output', runPath(run.runId)]);
}
export async function startAnnotationInventory() {
  const preflight = await getAnnotationInventoryPreflight();
  if (!preflight.ready || isRankingActive() || graphMutations > 0 || getExtractStatus().running) {
    return { ok: false, error: 'Annotation inventory preflight failed', preflight };
  }
  const run = { runId: crypto.randomUUID(), operation: 'annotation-inventory' };
  fs.mkdirSync(runPath(run.runId), { recursive: true });
  return launch(run, preflight.python, 'inventoryAnnotationSubjects.py', ['--parquet', parquet, '--output', runPath(run.runId)]);
}
export function persistRanking(runId) {
  if (isRankingActive() || graphMutations > 0 || getExtractStatus().running) return { ok: false, error: 'Graph operation already running' };
  const run = readRun(runId);
  if (!run.calculationComplete) return { ok: false, error: 'Completed calculation required' };
  run.operation = 'persist'; run.progress = null;
  return launch(run, resolvePythonExecutable(), 'persistGlobalGraphDependencyLevels.py', ['--report', runPath(runId)]);
}
