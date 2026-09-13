import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';
import neo4j from 'neo4j-driver';
import { auraConnection, fisherYatesRoot, fisherYatesScope } from './fisherYatesConfig.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['shuffle.ts'].map(f => path.join(root, 'examples/fisher-yates/src', f));
const program = ts.createProgram(files, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: [], strict: true });
const checker = program.getTypeChecker();
const diagnostics = ts.getPreEmitDiagnostics(program);
assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory:()=>root,getCanonicalFileName:f=>f,getNewLine:()=> '\n' }));
function location(node) {
  const file = node.getSourceFile();
  const start = file.getLineAndCharacterOfPosition(ts.isFunctionDeclaration(node) ? node.getChildren(file).find(c => c.kind === ts.SyntaxKind.FunctionKeyword).getStart(file) : node.getStart(file));
  const end = file.getLineAndCharacterOfPosition(node.end);
  const relative = path.relative(root, file.fileName).replaceAll('\\','/');
  return { stableId: `${relative}:${start.line+1}:${start.character}:${end.line+1}:${end.character}`,
    repoRelativePath: relative, startLine: start.line+1, startColumn: start.character, endLine: end.line+1, endColumn: end.character };
}
function declaration(expression) {
  let symbol = checker.getSymbolAtLocation(expression);
  if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.valueDeclaration || symbol?.declarations?.[0];
}
const functions = files.flatMap(f => program.getSourceFile(f).statements.filter(ts.isFunctionDeclaration));
const calls = [];
for (const fn of functions) {
  function walk(n) {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) calls.push({ fn, call:n });
    ts.forEachChild(n,walk);
  }
  walk(fn.body);
}
const annotations = {
  shuffle:'Копирует список и идёт с конца к началу. Для каждой позиции выбирает индекс от нуля до неё включительно и меняет элементы местами. Возвращает перестановку без потерь и повторного добавления участников.',
  randomIndex:'Выбирает случайный индекс в доступной части списка: умножает Math.random() на её длину и округляет вниз.',
  swap:'Меняет местами два элемента массива через временную переменную. Если индексы совпали, массив не изменяется. Здесь достаточно операций JavaScript, дальнейших вызовов нет.',
  'Math.random':'Стандартный источник псевдослучайного числа в диапазоне [0, 1). Для криптографических задач не предназначен.',
  'Math.floor':'Округляет число вниз до целого. Преобразует масштабированное случайное значение в индекс массива.',
};
const nodes = new Map(), edges = new Map();
function add(node,title) {
  const props = location(node);
  const system = node.getSourceFile().isDeclarationFile;
  Object.assign(props, {name:title,syntax:node.getText(),contextTitle:title,contextKind:system?'Системный API':'Функция',contextSystemBoundary:system,
    contextQuestion:'Какова роль в перемешивании?',contextAnnotation:annotations[title],contextAnnotationSource:'prepared-from-source'});
  assert.ok(props.contextAnnotation, `Missing annotation for ${title}`);
  nodes.set(props.stableId,props);return props.stableId;
}
// Follow parameter forwarding within the selected entry-point scenario.
function resolve(expression, evidence, seen = new Set()) {
  const decl = declaration(expression);
  assert.ok(decl, `Unresolved ${expression.getText()}`);
  if (!ts.isParameter(decl)) return {decl,title:expression.getText(),evidence};
  assert.ok(!seen.has(decl),'Recursive parameter binding');seen.add(decl);
  evidence.push(location(decl).stableId);
  if (decl.initializer) {
    assert.ok(calls.filter(x=>declaration(x.call.expression)===decl.parent).every(x=>!x.call.arguments?.[decl.parent.parameters.indexOf(decl)]), 'Default argument overridden');
    return resolve(decl.initializer,evidence,seen);
  }
  const incoming = calls.filter(x=>declaration(x.call.expression)===decl.parent);
  assert.equal(incoming.length,1,'Ambiguous parameter binding');
  const argument = incoming[0].call.arguments[decl.parent.parameters.indexOf(decl)];
  assert.ok(argument);evidence.push(location(argument).stableId);
  return resolve(argument,evidence,seen);
}
for (const fn of functions) add(fn,fn.name.text);
assert.ok(nodes.has(fisherYatesRoot));
for (const {fn,call} of calls) {
  const resolved = resolve(call.expression,[location(call).stableId]);
  const from = location(fn).stableId;
  const to = add(resolved.decl,ts.isFunctionDeclaration(resolved.decl)&&resolved.decl.name ? resolved.decl.name.text : resolved.title);
  const type = ts.isNewExpression(call)?'CONSTRUCTS':resolved.evidence.length>1?'CALLS_BOUND_VALUE':'CALLS';
  edges.set(`${from}|${type}|${to}`,{from,to,type,evidence:resolved.evidence});
}
const aura = auraConnection();
try {
  await aura.session.executeWrite(async tx=>{
    for(const props of nodes.values()) {
      const check=await tx.run('MATCH (n {stableId:$id}) RETURN count(n) AS count',{id:props.stableId});assert.ok(check.records[0].get('count').toNumber()<=1);
      const label=props.contextSystemBoundary?'ExternalBoundary:System':'FunctionImplementation';
      await tx.run(`MERGE (n {stableId:$id}) SET n:CodeEntity:${label},n += $props`,{id:props.stableId,props});
    }
    await tx.run('MATCH ()-[r {contextScope:$scope}]->() DELETE r',{scope:fisherYatesScope});
    for(const [order,e] of [...edges.values()].entries()) await tx.run(`MATCH (a {stableId:$from}),(b {stableId:$to}) MERGE (a)-[r:${e.type} {contextScope:$scope}]->(b)
      SET r.contextOrder=$order,r.evidenceNodes=$evidence,r.derivation='typescript-symbol-resolution'`,{...e,scope:fisherYatesScope,order:neo4j.int(order)});
  });
  console.log(JSON.stringify({nodes:nodes.size,edges:edges.size,root:fisherYatesRoot}));
}finally{await aura.session.close();await aura.driver.close();}
