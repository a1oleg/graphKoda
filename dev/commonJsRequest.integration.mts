import assert from 'node:assert/strict';
import path from 'node:path';
import ts from 'typescript';
import {DuckDBInstance} from '@duckdb/node-api';
import {getExtendedStableId} from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';
import {findCommonJsModuleRequest} from '../graph/static-extract/ts/functionFlowGraph.runtimeIntrinsics.ts';

const [snapshot, baseline, sourceRoot] = process.argv.slice(2);
if (!snapshot || !baseline || !sourceRoot) throw new Error('Usage: <snapshot> <baseline> <source-root>');
const configFile = path.join(sourceRoot, 'tsconfig.json');
const config = ts.readConfigFile(configFile, ts.sys.readFile);
assert.ok(!config.error);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, sourceRoot, undefined, configFile);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const source = program.getSourceFile(path.join(sourceRoot, 'src/lib/fasttextweb/fasttext-wasm.js'))!;
const ast = new Map<string, ts.Node>();
const visit = (node: ts.Node) => { ast.set(getExtendedStableId(source, node), node); ts.forEachChild(node, visit); };
visit(source);
// Compare with the recognizer shipped in the installed compiler, not a mock.
const compiler = ts as typeof ts & {isRequireCall(node: ts.Node, literalOnly: boolean): boolean};
assert.equal(typeof compiler.isRequireCall, 'function');
const instance = await DuckDBInstance.create(':memory:');
const db = await instance.connect();
const edgeKey = (from: string, kind: string, to: string) => JSON.stringify([from, kind, to]);
async function load(root: string) {
  const nodes = new Map((await db.runAndReadAll('SELECT stable_id,labels,props_json FROM read_parquet(?)',
    [path.join(root, 'parquet/nodes.parquet')])).getRowsJS().map(([id, labels, props]) =>
    [String(id), {labels: labels as string[], props: JSON.parse(String(props))}]));
  const edges = new Map((await db.runAndReadAll('SELECT from_id,rel_type,to_id,props_json FROM read_parquet(?)',
    [path.join(root, 'parquet/relationships.parquet')])).getRowsJS().map(([from, kind, to, props]) =>
    [edgeKey(String(from), String(kind), String(to)), JSON.parse(String(props))]));
  const plan = new Map((await db.runAndReadAll('SELECT stable_id,decision,context_targets,required_value_context FROM read_parquet(?)',
    [path.join(root, 'inventory/annotation-plan.parquet')])).getRowsJS().map(([id, decision, owners, values]) =>
    [String(id), {decision: String(decision), owners: owners as string[], values: values as string[]}]));
  return {nodes, edges, plan};
}
try {
  const current = await load(snapshot), old = await load(baseline);
  assert.equal(current.nodes.size, old.nodes.size);
  const changed = [...current.nodes].filter(([, node]) => node.labels.includes('CommonJsModuleRequest'));
  assert.equal(changed.length, 3);
  const ids = new Set(changed.map(([id]) => id));
  const specifierIds = new Set<string>();
  const specifiers: string[] = [];
  for (const [id, node] of changed) {
    const syntax = ast.get(id)!;
    assert.ok(syntax && ts.isIdentifier(syntax) && ts.isCallExpression(syntax.parent));
    assert.equal(syntax.parent.expression, syntax);
    assert.ok(compiler.isRequireCall(syntax.parent, true));
    assert.ok(!program.getTypeChecker().getSymbolAtLocation(syntax)?.declarations?.length);
    const specifier = findCommonJsModuleRequest(program, syntax)!;
    assert.equal(specifier, syntax.parent.arguments[0]);
    assert.ok(ts.isStringLiteralLike(specifier));
    assert.equal(node.props.moduleSpecifier, specifier.text);
    specifiers.push(specifier.text);
    assert.equal(node.props.declarationResolution, 'no-source-declaration');
    assert.equal(node.props.moduleResolution, 'not-requested');
    assert.ok(!node.labels.includes('System') && !node.labels.includes('ExternalBoundary'));
    const specifierId = getExtendedStableId(source, specifier);
    specifierIds.add(specifierId);
    assert.ok(current.nodes.has(specifierId));
    assert.equal(current.edges.get(edgeKey(id, 'REQUESTS_MODULE', specifierId))?.resolution, 'ast-commonjs-module-specifier');
    assert.equal(old.plan.get(id)!.decision, 'blocked-unresolved');
    const plan = current.plan.get(id)!;
    assert.equal(plan.decision, 'compose-in-owner');
    assert.deepEqual(plan.owners, [getExtendedStableId(source, syntax.parent)]);
    assert.deepEqual(plan.values, [specifierId]);
  }
  assert.deepEqual(specifiers.sort(), ['crypto', 'fs', 'path']);
  for (const [id, previous] of old.nodes) {
    const node = current.nodes.get(id)!;
    assert.equal(node.labels.length, new Set(node.labels).size);
    if (specifierIds.has(id)) {
      const normalize = (entry: typeof node) => ({
        labels: [...entry.labels].sort(),
        props: {...entry.props,
          roles: [...entry.props.roles].sort(),
          roleNames: [...entry.props.roleNames].sort()}
      });
      assert.deepEqual(normalize(node), normalize(previous));
    }
    else if (!ids.has(id)) assert.deepEqual(node, previous);
    else {
      assert.deepEqual(node.labels.filter(label => label !== 'CommonJsModuleRequest'), previous.labels);
      for (const [name, value] of Object.entries(previous.props)) assert.deepEqual(name === 'roles'
        ? node.props[name].filter((role: string) => role !== 'CommonJsModuleRequest') : node.props[name], value);
    }
  }
  for (const [key, props] of old.edges) assert.deepEqual(current.edges.get(key), props);
  const added = [...current.edges.keys()].filter(key => !old.edges.has(key));
  assert.equal(added.length, 3);
  for (const key of added) {
    const [from, kind] = JSON.parse(key);
    assert.ok(ids.has(from)); assert.equal(kind, 'REQUESTS_MODULE');
  }
  for (const [id, plan] of old.plan) if (!ids.has(id)) assert.deepEqual(current.plan.get(id), plan);
  console.log(JSON.stringify({ok: true, confirmedStableIds: [...ids], astVerified: true,
    compilerRecognizerVerified: true, oldGraphRetained: true, loaderDeclarationUnresolved: true,
    moduleDefinitionsNotClaimedResolved: true, writesNeo4j: false}));
} finally { db.closeSync(); instance.closeSync(); }
