import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import ts from 'typescript';
import {DuckDBInstance} from '@duckdb/node-api';
import {getExtendedStableId} from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';

const [snapshot, baseline, sourceRoot] = process.argv.slice(2);
if (!snapshot || !baseline || !sourceRoot) throw new Error('Usage: <snapshot> <baseline> <source-root>');
const configFile = path.join(sourceRoot, 'tsconfig.json');
const actualConfig = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
  "import {createProgram} from './graph/static-extract/ts/functionFlowGraph.infrastructure.ts';"
  + "const p=createProgram();console.log(JSON.stringify({path:p.getCompilerOptions().configFilePath,errors:p.getOptionsDiagnostics().map(d=>d.code)}));"],
  {cwd: process.cwd(), env: {...process.env, graphKoda_SOURCE_ROOT: sourceRoot}, encoding: 'utf8'}));
assert.equal(path.resolve(actualConfig.path), path.resolve(configFile));
assert.deepEqual(actualConfig.errors, []);
const config = ts.readConfigFile(configFile, ts.sys.readFile);
assert.ok(!config.error);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, sourceRoot, undefined, configFile);
assert.equal(parsed.errors.length, 0);
const program = ts.createProgram(parsed.fileNames, parsed.options);
assert.equal(program.getOptionsDiagnostics().length, 0);
const checker = program.getTypeChecker();
const ast = new Map<string, ts.Node>();
const source = program.getSourceFile(path.join(sourceRoot, 'src/util/languageDetection.ts'))!;
const visit = (node: ts.Node) => { ast.set(getExtendedStableId(source, node), node); ts.forEachChild(node, visit); };
visit(source);
const instance = await DuckDBInstance.create(':memory:');
const db = await instance.connect();
try {
  const nodes = new Map((await db.runAndReadAll('SELECT stable_id,labels,props_json FROM read_parquet(?)',
    [path.join(snapshot, 'parquet/nodes.parquet')])).getRowsJS().map(([id, labels, props]) =>
    [String(id), {labels: labels as string[], props: JSON.parse(String(props))}]));
  const oldNodes = (await db.runAndReadAll('SELECT stable_id,props_json FROM read_parquet(?)',
    [path.join(baseline, 'parquet/nodes.parquet')])).getRowsJS();
  const replacements = new Map<string, string>();
  for (const [rawId, rawProps] of oldNodes) {
    const id = String(rawId), props = JSON.parse(String(rawProps));
    if (nodes.has(id)) continue;
    if (id.startsWith('../coldKode/node_modules/vite/')) {
      const target = id.replace('../coldKode/', '');
      assert.ok(nodes.has(target));
      assert.equal(nodes.get(target)!.props.syntax, props.syntax);
      assert.ok(program.getSourceFile(path.resolve(sourceRoot, nodes.get(target)!.props.repoRelativePath)),
        'Replacement absent from compiler program');
      replacements.set(id, target);
    } else {
      assert.ok(id.startsWith('visual:fn:') && id.includes('->unresolved-'));
      const candidates = [...nodes].filter(([, node]) => node.props.sourceCallStableId === props.sourceCallStableId
        && node.props.call_boundary_role === props.call_boundary_role);
      assert.equal(candidates.length, 1);
      const [target, node] = candidates[0];
      assert.equal(node.props.call_origin, 'standard-library');
      assert.ok(nodes.get(node.props.call_origin_declaration_stable_id)!.labels.includes('ExternalBoundary'));
      replacements.set(id, target);
    }
  }
  const edges = new Set((await db.runAndReadAll('SELECT from_id,rel_type,to_id FROM read_parquet(?)',
    [path.join(snapshot, 'parquet/relationships.parquet')])).getRowsJS().map(row => JSON.stringify(row)));
  const oldEdges = (await db.runAndReadAll('SELECT from_id,rel_type,to_id FROM read_parquet(?)',
    [path.join(baseline, 'parquet/relationships.parquet')])).getRowsJS();
  for (const [from, kind, to] of oldEdges) {
    const key = JSON.stringify([replacements.get(String(from)) || from, kind, replacements.get(String(to)) || to]);
    assert.ok(edges.has(key), `Existing edge lost after verified identity replacement: ${key}`);
  }
  const transitions = (await db.runAndReadAll(`SELECT a.stable_id,a.decision,a.context_targets
    FROM read_parquet(?) a JOIN read_parquet(?) b USING(stable_id) WHERE b.decision='blocked-unresolved'`,
    [path.join(snapshot, 'inventory/annotation-plan.parquet'), path.join(baseline, 'inventory/annotation-plan.parquet')])).getRowsJS();
  assert.equal(transitions.length, 3);
  const confirmedStableIds: string[] = [];
  for (const [rawId, decision, targets] of transitions) {
    const id = String(rawId), syntax = ast.get(id)!;
    assert.ok(syntax && ts.isIdentifier(syntax));
    assert.equal(decision, 'follow-original');
    const declarations = checker.getSymbolAtLocation(syntax)?.declarations;
    assert.ok(declarations?.length);
    const resolved = declarations.map(declaration => getExtendedStableId(declaration.getSourceFile(), declaration));
    assert.deepEqual(targets, resolved);
    for (const target of resolved) {
      assert.ok(edges.has(JSON.stringify([id, 'RESOLVES_TO', target])));
      assert.ok(nodes.get(target)!.labels.includes('ExternalBoundary'));
      assert.ok(declarations.some(declaration => declaration.getSourceFile().isDeclarationFile
        && getExtendedStableId(declaration.getSourceFile(), declaration) === target));
    }
    confirmedStableIds.push(id);
  }
  console.log(JSON.stringify({ok: true, confirmedStableIds, configuredTypesResolved: true,
    targetsVerifiedByTypeChecker: true, verifiedIdentityReplacements: replacements.size,
    existingConnectivityRetained: true, renderMetadataChecked: false, writesNeo4j: false}));
} finally { db.closeSync(); instance.closeSync(); }
