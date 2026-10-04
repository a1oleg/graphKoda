import fs from 'node:fs';
import path from 'node:path';

export function parseImportResult(line) {
  if (!line.trimStart().startsWith('{')) return null;
  try {
    const result = JSON.parse(line);
    return result.ok === true && result.counts && Number.isFinite(result.elapsedSeconds) ? result : null;
  } catch { return null; }
}

export function buildImportPerformance(run, result) {
  const intervals = [];
  const add = (name, seconds, extra = {}) => {
    if (Number.isFinite(seconds) && seconds >= 0) intervals.push({ name, seconds, ...extra });
  };
  add('process.total', (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000);
  if (result) {
    add('import.total', result.elapsedSeconds);
    for (const key of ['stageSeconds', 'extractSeconds', 'canonicalizeSeconds']) add(key, result[key]);
    for (const key of ['writeSeconds', 'catalogReadSeconds', 'phaseSeconds']) {
      for (const [phase, seconds] of Object.entries(result[key] || {})) add(`${key}.${phase}`, seconds);
    }
    for (const key of ['extractionMetrics', 'stageMetrics', 'transportMetrics']) {
      for (const metric of result[key] || []) add(`${key}.${metric.operation}`, metric.seconds,
        { cpuSeconds: metric.cpuSeconds, calls: metric.calls, rssBytes: metric.rssBytes });
    }
    for (const interval of result.pipelineIntervals || []) add(`pipeline.${interval.operation}`, interval.seconds,
      { startSeconds: interval.startSeconds, endSeconds: interval.endSeconds });
  }
  return { version: 1, status: run.exitCode === 0 && result ? 'complete' : 'incomplete',
    exitCode: run.exitCode, signal: run.signal || null, error: run.error || null,
    startedAt: run.startedAt, finishedAt: run.finishedAt, logPath: run.logPath,
    context: run.performanceContext, counts: result?.counts || null, intervals,
    sourceRevisions: result?.sourceRevisions || [], toolRevisions: result?.toolRevisions || [],
    options: result ? { batchSize: result.neo4jBatchSize, clearTiming: result.neo4jClearTiming } : null,
    measurement: 'Overlapping parent/child intervals must not be summed. Comparisons are observations, not causal performance claims.' };
}

function comparable(a, b) {
  return a.status === 'complete' && b.status === 'complete'
    && a.context && JSON.stringify(a.context) === JSON.stringify(b.context)
    && JSON.stringify(a.options) === JSON.stringify(b.options);
}

export function compareImportPerformance(current, previous) {
  if (!previous || !comparable(current, previous)) return null;
  const old = new Map(previous.intervals.map(row => [row.name, row]));
  const intervals = current.intervals.filter(row => old.has(row.name)).map(row => {
    const before = old.get(row.name);
    const deltaSeconds = row.seconds - before.seconds;
    return { name: row.name, previousSeconds: before.seconds, seconds: row.seconds,
      deltaSeconds, deltaPercent: before.seconds > 0 ? deltaSeconds / before.seconds * 100 : null,
      slower: deltaSeconds > 0,
      previousCalls: before.calls ?? null, calls: row.calls ?? null };
  });
  const counts = Object.fromEntries(Object.entries(current.counts || {}).map(([name, count]) => [name,
    { previous: previous.counts?.[name] ?? null, current: count,
      delta: Number.isFinite(previous.counts?.[name]) ? count - previous.counts[name] : null }]));
  return { previousFinishedAt: previous.finishedAt, previousLogPath: previous.logPath,
    sameVolume: Object.values(counts).every(row => row.delta === 0), counts, intervals,
    slowdowns: intervals.filter(row => row.slower).sort((a, b) => b.deltaSeconds - a.deltaSeconds),
    missingPreviousIntervals: current.intervals.filter(row => !old.has(row.name)).map(row => row.name),
    missingCurrentIntervals: previous.intervals.filter(row => !current.intervals.some(now => now.name === row.name)).map(row => row.name),
    sourceChanged: current.sourceRevisions?.length && previous.sourceRevisions?.length
      ? JSON.stringify(current.sourceRevisions) !== JSON.stringify(previous.sourceRevisions) : null,
    toolChanged: current.toolRevisions?.length && previous.toolRevisions?.length
      ? JSON.stringify(current.toolRevisions) !== JSON.stringify(previous.toolRevisions) : null };
}

export function readImportPerformanceHistory(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => name.endsWith('.performance.json')).flatMap(name => {
    try {
      const report = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
      return report.version === 1 && report.finishedAt ? [{ ...report, reportPath: path.join(directory, name) }] : [];
    } catch { return []; }
  }).sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));
}

export function saveImportPerformance(run, result) {
  const report = buildImportPerformance(run, result);
  const previous = readImportPerformanceHistory(path.dirname(run.logPath)).find(row => comparable(report, row));
  report.comparison = compareImportPerformance(report, previous);
  report.comparisonStatus = report.status !== 'complete' ? 'incomplete-run'
    : previous ? 'compared' : 'no-compatible-previous-run';
  report.reportPath = run.logPath.replace(/\.log$/, '.performance.json');
  const temporary = `${report.reportPath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(report, null, 2), 'utf8');
  fs.renameSync(temporary, report.reportPath);
  return report;
}
