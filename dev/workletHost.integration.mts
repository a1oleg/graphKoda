import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import ts from 'typescript';
import {DuckDBInstance} from '@duckdb/node-api';
import {getExtendedStableId} from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';
import {findHostRuntimeContract} from '../graph/static-extract/ts/functionFlowGraph.hostEnvironments.ts';

const [snapshot, baseline, sourceRoot] = process.argv.slice(2);
if (!snapshot || !baseline || !sourceRoot) throw new Error('Usage: <snapshot> <baseline> <source-root>');
const file = path.join(sourceRoot, 'tsconfig.json');
const config = ts.readConfigFile(file, ts.sys.readFile);
assert.ok(!config.error);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, sourceRoot, undefined, file);
const program = ts.createProgram(parsed.fileNames, parsed.options), checker = program.getTypeChecker();
const source = program.getSourceFile(path.join(sourceRoot, 'src/util/voiceRecording/recorderWorklet.js'))!;
const idFor = (node: ts.Node) => getExtendedStableId(node.getSourceFile(), node);
const ast = new Map<string, ts.Node>();
const visit = (node: ts.Node) => { ast.set(idFor(node), node); ts.forEachChild(node, visit); };
visit(source);
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
function verifyStandardMember(node: ts.Node, owner: string, member: string) {
  const declarations = checker.getSymbolAtLocation(node)?.declarations || [];
  assert.ok(declarations.length);
  assert.ok(declarations.every(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile())
    && ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name.text === owner
    && 'name' in declaration && (declaration as ts.NamedDeclaration).name?.getText() === member));
}
try {
  const current = await load(snapshot), old = await load(baseline);
  const confirmedStableIds = [...old.plan].filter(([id, plan]) => plan.decision === 'blocked-unresolved'
    && current.plan.get(id)?.decision === 'external-boundary').map(([id]) => id);
  assert.equal(confirmedStableIds.length, 2);
  const changed = new Set(confirmedStableIds), loaderIds = new Set<string>(), expectedEdges = new Set<string>();
  const names: string[] = [];
  for (const id of confirmedStableIds) {
    const syntax = ast.get(id)!;
    assert.ok(ts.isIdentifier(syntax)); names.push(syntax.text);
    assert.ok(!checker.getSymbolAtLocation(syntax)?.declarations?.length);
    const host = findHostRuntimeContract(program, syntax)!;
    assert.ok(host); assert.equal(host.loaders.length, 1);
    const node = current.nodes.get(id)!;
    for (const label of ['HostRuntimeAccess', 'System', 'ExternalBoundary']) assert.ok(node.labels.includes(label));
    assert.equal(node.props.declarationResolution, 'no-source-declaration');
    assert.equal(node.props.runtimeScope, 'AudioWorkletGlobalScope');
    assert.equal(node.props.runtimeExecution, 'not-observed');
    assert.equal(node.props.runtimeContractUrl, host.specification);
    for (const loader of host.loaders) {
      assert.ok(ts.isPropertyAccessExpression(loader.expression));
      const method = loader.expression;
      verifyStandardMember(method.name, 'Worklet', 'addModule');
      assert.ok(ts.isPropertyAccessExpression(method.expression));
      verifyStandardMember(method.expression.name, 'BaseAudioContext', 'audioWorklet');
      const url = loader.arguments[0];
      assert.ok(ts.isNewExpression(url) && url.arguments?.length === 2);
      assert.ok(ts.isIdentifier(url.expression));
      const urlDeclarations = checker.getSymbolAtLocation(url.expression)?.declarations || [];
      assert.ok(urlDeclarations.length && urlDeclarations.every(declaration =>
        program.isSourceFileDefaultLibrary(declaration.getSourceFile())
        && 'name' in declaration && (declaration as ts.NamedDeclaration).name?.getText() === 'URL'));
      const [specifier, base] = url.arguments;
      assert.ok(ts.isStringLiteralLike(specifier));
      assert.ok(ts.isPropertyAccessExpression(base) && base.name.text === 'url'
        && ts.isMetaProperty(base.expression) && base.expression.keywordToken === ts.SyntaxKind.ImportKeyword);
      const resolved = new URL(specifier.text, pathToFileURL(loader.getSourceFile().fileName));
      resolved.search = ''; resolved.hash = '';
      assert.equal(path.resolve(fileURLToPath(resolved)), path.resolve(source.fileName));
      const loaderId = idFor(loader); loaderIds.add(loaderId);
      const loaderNode = current.nodes.get(loaderId)!;
      assert.equal(loaderNode.props.name, loader.getText());
      assert.ok(loaderNode.labels.includes('HostModuleLoader'));
      assert.equal(current.plan.get(loaderId)?.decision, 'external-boundary');
      const key = edgeKey(id, 'HOSTED_BY', loaderId); expectedEdges.add(key);
      assert.equal(current.edges.get(key)?.resolution, 'typescript-standard-audioworklet-loader');
      assert.deepEqual(current.plan.get(id)!.values, [loaderId]);
    }
  }
  assert.deepEqual(names.sort(), ['AudioWorkletProcessor', 'registerProcessor']);
  assert.equal(loaderIds.size, 1);
  assert.deepEqual(new Set([...current.nodes.keys()].filter(id => !old.nodes.has(id))), loaderIds);
  for (const [id, previous] of old.nodes) {
    const node = current.nodes.get(id)!;
    assert.equal(node.labels.length, new Set(node.labels).size);
    if (!changed.has(id)) assert.deepEqual(node, previous);
    else {
      const addedLabels = ['HostRuntimeAccess', 'ExternalBoundary', 'System'];
      assert.deepEqual(node.labels.filter(label => !addedLabels.includes(label)).sort(), [...previous.labels].sort());
      for (const [name, value] of Object.entries(previous.props)) assert.deepEqual(name === 'roles'
        ? node.props[name].filter((role: string) => !addedLabels.includes(role)) : node.props[name], value);
    }
  }
  for (const [key, props] of old.edges) assert.deepEqual(current.edges.get(key), props);
  assert.deepEqual(new Set([...current.edges.keys()].filter(key => !old.edges.has(key))), expectedEdges);
  for (const [id, plan] of old.plan) if (!changed.has(id)) assert.deepEqual(current.plan.get(id), plan);
  assert.ok(![...current.plan.values()].some(plan => plan.decision.startsWith('blocked-')));
  console.log(JSON.stringify({ok: true, confirmedStableIds, astVerified: true, standardLoaderVerified: true,
    oldGraphRetained: true, runtimeExecutionNotClaimed: true, writesNeo4j: false}));
} finally { db.closeSync(); instance.closeSync(); }
