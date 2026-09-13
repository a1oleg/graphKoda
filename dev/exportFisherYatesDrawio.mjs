import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auraConnection, fisherYatesRoot } from './fisherYatesConfig.mjs';
import { composeExpandedFunctions } from './expandedFunctionDrawio.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : path.join(root, 'graph/draw/generated/Fisher-Yates.drawio');
const aura = auraConnection();
let functions, calls;
try {
  const result = await aura.session.run(`MATCH (root:Fn {stableId:$id}) WHERE root.expandDeveloperCalls = true
    MATCH (fn:Fn)-[:NEXT {extractionScope:'fisher-yates-flow'}]->(:FunctionStart)
    WHERE fn.repo_relative_path STARTS WITH 'examples/fisher-yates/' AND NOT fn:VisualProxy AND fn.name IS NOT NULL
    RETURN fn.stableId AS id, fn.name AS name`, { id: fisherYatesRoot });
  functions = new Map(result.records.map(r => [r.get('id'), { name: r.get('name') }]));
  if (!functions.has(fisherYatesRoot)) throw new Error('Extract Fisher-Yates into Aura first (npm run fisher:import)');
  const edges = await aura.session.run(`MATCH (call)-[:CALLS]->(fn:Fn)
    WHERE call.parentFnStableId IN $ids AND fn.stableId IN $ids
      AND NOT call:VisualProxy AND NOT call:Return
    RETURN DISTINCT call.stableId AS id, call.parentFnStableId AS owner, fn.stableId AS callee
    ORDER BY id`, { ids: [...functions.keys()] });
  calls = edges.records.map(r => r.toObject());
} finally { await aura.session.close(); await aura.driver.close(); }
const documents = new Map();
fs.mkdirSync(path.join(root, 'tmp/fisher-yates'), { recursive: true });
for (const [id, fn] of functions) {
  const file = path.join(root, 'tmp/fisher-yates', `${fn.name}.drawio`);
  execFileSync(process.execPath, ['dev/exportLocalIterativeCoordinateDrawio.mjs', '--aura', '--fn-stable-id', id, '--output', file], {
    cwd: root, windowsHide: true, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  documents.set(id, fs.readFileSync(file, 'utf8'));
}
const result = composeExpandedFunctions(fisherYatesRoot, functions, calls, documents);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, result.xml);
console.log(JSON.stringify({ output, calls, blocks: result.boxes }));
