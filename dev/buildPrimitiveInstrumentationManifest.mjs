import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const result = {
    inputPath: 'tmp/primitive-onsubmit.json',
    outputPath: 'tmp/primitive-instrumentation-manifest.json',
  };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--input') result.inputPath = argv[++index] || result.inputPath;
    else if (argv[index] === '--output') result.outputPath = argv[++index] || result.outputPath;
  }
  return result;
}

const args = parseArgs(process.argv);
const inputPath = path.resolve(args.inputPath);
const outputPath = path.resolve(args.outputPath);
const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

const entries = (payload.nodes || [])
  .filter((node) => (
    node.labels?.includes('Primitive')
    && node.instrumentationStrategy
    && node.instrumentationStrategy !== 'structural-only'
    && node.instrumentationTargetStableId
  ))
  .map((node) => ({
    stableId: node.stableId,
    primitiveKind: node.primitiveKind || null,
    executionOutcome: node.executionOutcome || null,
    runtimeEventKind: node.runtimeEventKind,
    instrumentationStrategy: node.instrumentationStrategy,
    instrumentationPhase: node.instrumentationPhase,
    instrumentationTargetStableId: node.instrumentationTargetStableId,
    parentFnStableId: node.parentFnStableId,
    sourceStateId: node.sourceStateId || null,
    repoRelativePath: node.repoRelativePath,
    filePath: node.filePath,
    startLine: node.startLine,
    startColumn: node.startColumn,
    endLine: node.endLine,
    endColumn: node.endColumn,
  }))
  .sort((left, right) => (
    String(left.repoRelativePath).localeCompare(String(right.repoRelativePath))
    || Number(left.startLine) - Number(right.startLine)
    || Number(left.startColumn) - Number(right.startColumn)
    || String(left.stableId).localeCompare(String(right.stableId))
  ));

const entriesByTargetStableId = Object.fromEntries(
  [...Map.groupBy(entries, (entry) => entry.instrumentationTargetStableId)]
    .map(([stableId, targetEntries]) => [stableId, targetEntries]),
);

const manifest = {
  schemaVersion: 1,
  generatedFrom: inputPath,
  entryCount: entries.length,
  entries,
  entriesByTargetStableId,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  ok: true,
  outputPath,
  entryCount: entries.length,
  targetCount: Object.keys(entriesByTargetStableId).length,
})}\n`);
