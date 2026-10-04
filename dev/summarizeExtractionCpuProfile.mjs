import fs from 'node:fs';

const filename = process.argv[2];
if (!filename) throw new Error('Usage: node dev/summarizeExtractionCpuProfile.mjs <profile.cpuprofile>');
const profile = JSON.parse(fs.readFileSync(filename, 'utf8'));
const nodes = new Map(profile.nodes.map(node => [node.id, node]));
const parents = new Map();
for (const node of profile.nodes) for (const child of node.children || []) parents.set(child, node.id);
const totals = new Map();
function keyFor(node) {
  const frame = node.callFrame;
  return JSON.stringify([frame.functionName, frame.url, frame.lineNumber + 1]);
}
for (let i = 0; i < (profile.samples || []).length; i++) {
  let id = profile.samples[i];
  const seconds = (profile.timeDeltas?.[i] || 0) / 1e6;
  const seen = new Set();
  let self = true;
  while (id !== undefined) {
    const node = nodes.get(id);
    if (!node) break;
    const key = keyFor(node);
    if (!seen.has(key)) {
      const row = totals.get(key) || { function: node.callFrame.functionName,
        url: node.callFrame.url, generatedLine: node.callFrame.lineNumber + 1, selfSeconds: 0, inclusiveSeconds: 0 };
      row.inclusiveSeconds += seconds;
      if (self) row.selfSeconds += seconds;
      totals.set(key, row);
      seen.add(key);
    }
    self = false;
    id = parents.get(id);
  }
}
const rows = [...totals.values()];
const report = { profile: filename, sampledSeconds: (profile.timeDeltas || []).reduce((a, b) => a + b, 0) / 1e6,
  topSelf: rows.sort((a, b) => b.selfSeconds - a.selfSeconds).slice(0, 20),
  extractorInclusive: rows.filter(row => /static-extract/.test(row.url))
    .sort((a, b) => b.inclusiveSeconds - a.inclusiveSeconds).slice(0, 30),
  limitation: 'V8 sampling of the main JavaScript thread; native worker CPU is not attributed. Lines refer to generated JavaScript, not source-map-resolved TypeScript. Inclusive times overlap and must not be summed.' };
const json = JSON.stringify(report, null, 2);
if (process.argv[3]) fs.writeFileSync(process.argv[3], json, { encoding: 'utf8', flag: 'wx' });
console.log(json);
