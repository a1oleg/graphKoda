import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import projectPaths from './projectPaths.cjs';

const workspaceRoot = projectPaths.toolRoot;
const codeql = path.join(os.homedir(), '.cache', 'telegraph-codeql', 'cli', 'codeql', process.platform === 'win32' ? 'codeql.exe' : 'codeql');
const database = path.join(projectPaths.dataRoot, 'codeql', 'databases', 'javascript');
const query = path.join(workspaceRoot, 'graph', 'codeql', 'canonical-reference-links.ql');
const resultRoot = path.join(projectPaths.dataRoot, 'codeql', 'results');
const bqrs = path.join(resultRoot, 'canonical-reference-links.bqrs');
const decoded = path.join(resultRoot, 'canonical-reference-links.json');
const facts = path.join(resultRoot, 'canonical-reference-links.facts.json');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: workspaceRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

if (!existsSync(codeql)) {
  run(process.execPath, [path.join(workspaceRoot, 'dev', 'codeqlUiActionLinks.mjs'), 'database']);
}
if (process.argv.includes('--force-db') || !existsSync(path.join(database, 'codeql-database.yml'))) {
  run(process.execPath, [path.join(workspaceRoot, 'dev', 'codeqlUiActionLinks.mjs'), 'database', '--force']);
}

mkdirSync(resultRoot, { recursive: true });
run(codeql, ['pack', 'install', path.join(workspaceRoot, 'graph', 'codeql')]);
run(codeql, ['query', 'run', query, '--database', database, '--output', bqrs]);
run(codeql, ['bqrs', 'decode', bqrs, '--format=json', '--output', decoded]);

const payload = JSON.parse(readFileSync(decoded, 'utf8'));
const tuples = payload['#select']?.tuples || [];
const rows = tuples.map((tuple) => ({
  relation: tuple[0],
  referenceKind: tuple[1],
  referencePath: tuple[2],
  referenceStartLine: tuple[3],
  referenceStartColumn: tuple[4],
  referenceEndLine: tuple[5],
  referenceEndColumn: tuple[6],
  referenceName: tuple[7],
  targetPath: tuple[8],
  targetStartLine: tuple[9],
  targetStartColumn: tuple[10],
  targetEndLine: tuple[11],
  targetEndColumn: tuple[12],
  targetName: tuple[13],
}));
writeFileSync(facts, `${JSON.stringify({ source: 'codeql/canonical-reference-links', rows }, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ facts, rowCount: rows.length }, null, 2));

