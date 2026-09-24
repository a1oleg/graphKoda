import {parse} from '@babel/parser';

export const modelStubTraceFile = 'services/api/claude.ts';
export function modelStubTraceTargets(source) {
  const ast = parse(source, {sourceType:'module', plugins:['typescript','jsx']});
  let fn;
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' && node.id?.name === 'queryModel') fn = node;
    for (const [key,value] of Object.entries(node)) {
      if (['loc','extra','comments','tokens'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(ast.program);
  const branch = fn?.body.body.find(n=>n.type==='IfStatement' && n.test.type==='CallExpression' && n.test.callee.name==='isModelStubEnabled');
  if (!branch) throw new Error('Model-stub trace: queryModel/isModelStubEnabled branch not found');
  const id=n=>`${modelStubTraceFile}:${n.loc.start.line}:${n.loc.start.column}:${n.loc.end.line}:${n.loc.end.column}`;
  const target=(node,role,instrumentationKind)=>({filePath:modelStubTraceFile,stableId:id(node),ownerFnStableId:id(fn),
    startLine:node.loc.start.line,startColumn:node.loc.start.column,endLine:node.loc.end.line,endColumn:node.loc.end.column,
    role,instrumentationKind,startsChain:role==='function'});
  return [target(fn,'function','function-entry'),target(branch.test,'predicate','expression')];
}
