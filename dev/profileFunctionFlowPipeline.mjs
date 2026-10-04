import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2];
if (!output) throw new Error('Usage: node dev/profileFunctionFlowPipeline.mjs <new-output-directory>');
const directory = path.resolve(output);
if (fs.existsSync(directory)) throw new Error('Use a new output directory; existing snapshots are never overwritten.');
fs.mkdirSync(directory, { recursive: true });
const log = fs.createWriteStream(path.join(directory, 'pipeline.log'));
const started = performance.now();
// Match the orchestrator's extractor budget; retain an explicit caller override.
const inheritedNodeOptions = process.env.NODE_OPTIONS || '';
const heapOverride = inheritedNodeOptions.match(/(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s+)(\d+)/);
const nodeOptions = heapOverride ? inheritedNodeOptions : `${inheritedNodeOptions} --max-old-space-size=8192`.trim();
const nodeHeapLimitMb = heapOverride ? Number(heapOverride[1]) : 8192;
const child = spawn(process.execPath, ['--import', 'tsx',
  'graph/static-extract/ts/fromASTtoPreGraphFlow.ts', '--output-format', 'duckdb',
  '--staging-path', path.join(directory, 'stage.duckdb'),
  '--parquet-dir', path.join(directory, 'parquet')], {
  cwd: root, env: { ...process.env, NODE_OPTIONS: nodeOptions }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let tail = '';
let result;
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { log.write(chunk); process.stderr.write(chunk); });
child.stdout.on('data', chunk => {
  log.write(chunk);
  tail += chunk;
  let end;
  while ((end = tail.indexOf('\n')) >= 0) {
    const line = tail.slice(0, end);
    tail = tail.slice(end + 1);
    if (line.startsWith('{')) result = JSON.parse(line);
  }
});
child.on('error', error => { log.end(); console.error(error); process.exitCode = 1; });
child.on('close', code => {
  log.end();
  if (code !== 0 || !result?.ok) {
    console.error(`Extraction profile failed (exit=${code}); see ${directory}`);
    process.exitCode = 1;
    return;
  }
  const report = { version: 1, ...result,
    nodeHeapLimitMb,
    commandWallSeconds: (performance.now() - started) / 1000,
    generatesAnnotations: false, writesNeo4j: false,
    memoryMeasurement: 'Process RSS at operation end, not a sampled peak.',
    cpuMeasurement: 'Process user+system CPU, including native workers; not per-thread attribution.' };
  report.transportProfiling = process.env.GRAPH_EXTRACT_PROFILE_TRANSPORT === '1';
  report.transportMeasurement = 'Optional wall-time instrumentation per raw record adds overhead. Appender time includes binding conversions; flush/close are separate. These totals include metadata and canonical records, not only function bodies.';
  fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, report: path.join(directory, 'summary.json'),
    counts: result.counts, stageSeconds: result.stageSeconds }));
});
