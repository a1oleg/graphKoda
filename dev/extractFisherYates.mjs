import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
process.env.COLDKODE_SOURCE_ROOT = root;
const { extractFunctionFlowGraphs, payloadForTransport } = await import('../graph/static-extract/ts/fromASTtoPreGraphFlow.ts');
const files = ['shuffle.ts'].map(name => path.join(root, 'examples/fisher-yates/src', name));
const program = ts.createProgram(files, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext, types: [], strict: true });
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCurrentDirectory: () => root, getCanonicalFileName: f => f, getNewLine: () => '\n',
}));
const payload = payloadForTransport(extractFunctionFlowGraphs(program));
fs.mkdirSync(path.join(root, 'tmp/fisher-yates'), { recursive: true });
fs.writeFileSync(path.join(root, 'tmp/fisher-yates/extracted.json'), JSON.stringify(payload, null, 2));
console.log(JSON.stringify({ functions: payload.functions.map(f => [f.name, f.stableId]), nodes: payload.nodes.length, edges: payload.edges.length }));
