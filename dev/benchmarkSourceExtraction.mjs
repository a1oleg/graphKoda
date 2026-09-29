import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import projectPaths from './projectPaths.cjs';

const args = process.argv.slice(2);
const child = args.includes('--worker');
const full = args.includes('--full');
const ids = args.flatMap((arg, i) => arg === '--fn' ? [args[i + 1]] : []);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const timeoutMs = Number(option('--timeout-seconds', '180')) * 1000;
const output = path.resolve(option('--output', path.join(projectPaths.dataRoot, 'checks', 'extraction-benchmark.jsonl')));
if ((!full && !ids.length) || ids.some((id) => !id) || !(timeoutMs > 0)) {
  throw new Error('Use --fn stableId (repeatable) or --full; optional --timeout-seconds and --output. No database writes.');
}

if (!child) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const log = fs.createWriteStream(output);
  const worker = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), ...args, '--worker'], {
    cwd: projectPaths.toolRoot,
    env: { ...process.env, GRAPH_EXTRACT_TIMINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  worker.stdout.on('data', (data) => { process.stdout.write(data); log.write(data); });
  worker.stderr.on('data', (data) => {
    process.stderr.write(data);
    log.write(`${JSON.stringify({ stage: 'diagnostic', text: data.toString() })}\n`);
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; worker.kill(); }, timeoutMs);
  worker.on('error', (error) => { process.stderr.write(`${error.stack}\n`); });
  worker.on('close', (code, signal) => {
    clearTimeout(timer);
    log.end(`${JSON.stringify({ stage: 'exit', code, signal, timedOut })}\n`);
    process.exitCode = timedOut ? 124 : code ?? 1;
  });
} else {
  const { createProgram } = await import('../graph/static-extract/ts/functionFlowGraph.infrastructure.ts');
  const { createFunctionFlowExtractionContext, extractFunctionFlowGraphs } = await import('../graph/static-extract/ts/fromASTtoPreGraphFlow.ts');
  const start = performance.now();
  const report = (stage, detail = {}) => console.log(JSON.stringify({
    stage, elapsedMs: Math.round(performance.now() - start),
    rssMB: Math.round(process.memoryUsage().rss / 1048576), ...detail,
  }));
  const timed = (stage, run) => {
    report(`${stage}:start`);
    const t = performance.now();
    const result = run();
    report(stage, { durationMs: Math.round(performance.now() - t) });
    return result;
  };
  try {
    report('source', { sourceRoot: projectPaths.sourceRoot, node: process.version });
    const program = timed('program', () => createProgram());
    report('files', { roots: program.getRootFileNames().length, total: program.getSourceFiles().length });
    const context = timed('context', () => createFunctionFlowExtractionContext(program));
    for (const id of full ? [undefined] : ids) {
      let previousHash;
      for (let repeat = 0; repeat < (full ? 1 : 2); repeat++) {
        report('request', { id: id ?? '*', repeat });
        const result = timed('extract', () => extractFunctionFlowGraphs(program, id, context,
          args.includes('--include-parameter-origins') ? { includeParameterOrigins: true } : {}));
        report('counts', Object.fromEntries(Object.entries(result).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length])));
        if (!full) {
          const hash = createHash('sha256').update(JSON.stringify(result)).digest('hex');
          report('repeat-check', { hash, matchesPrevious: previousHash ? hash === previousHash : null });
          if (previousHash && previousHash !== hash) throw new Error('Repeated extraction differs for the same Program');
          previousHash = hash;
        }
      }
      if (args.includes('--compare-origins') && id) {
        const result = timed('extract-with-origins', () => extractFunctionFlowGraphs(program, id, context, { includeParameterOrigins: true }));
        report('origin-counts', Object.fromEntries(Object.entries(result).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length])));
        report('origin-hash', { hash: createHash('sha256').update(JSON.stringify(result)).digest('hex') });
      }
    }
  } catch (error) {
    report('failure', { error: error.stack || String(error) });
    process.exitCode = 1;
  }
}
