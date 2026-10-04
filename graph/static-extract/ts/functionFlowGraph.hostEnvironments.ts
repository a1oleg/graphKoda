import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import ts from 'typescript';

const audioWorkletContracts = new Map([
  ['AudioWorkletProcessor', 'https://www.w3.org/TR/webaudio-1.0/#AudioWorkletProcessor'],
  ['registerProcessor', 'https://www.w3.org/TR/webaudio-1.0/#dom-audioworkletglobalscope-registerprocessor'],
]);
const moduleLoaders = new WeakMap<ts.Program, Map<string, ts.CallExpression[]>>();

function hasStandardMember(program: ts.Program, node: ts.Node, owner: string, member: string) {
  const declarations = program.getTypeChecker().getSymbolAtLocation(node)?.declarations || [];
  return declarations.some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile())
    && ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name.text === owner
    && 'name' in declaration && (declaration as ts.NamedDeclaration).name?.getText() === member);
}

export function audioWorkletModuleTarget(program: ts.Program, call: ts.CallExpression) {
  const method = call.expression;
  if (!ts.isPropertyAccessExpression(method) || method.questionDotToken || call.questionDotToken
    || !hasStandardMember(program, method.name, 'Worklet', 'addModule')
    || !ts.isPropertyAccessExpression(method.expression) || method.expression.questionDotToken
    || !hasStandardMember(program, method.expression.name, 'BaseAudioContext', 'audioWorklet')) return;
  const argument = call.arguments[0];
  if (!argument || !ts.isNewExpression(argument) || argument.arguments?.length !== 2
    || !ts.isIdentifier(argument.expression)) return;
  const declarations = program.getTypeChecker().getSymbolAtLocation(argument.expression)?.declarations || [];
  if (!declarations.length || !declarations.every(declaration =>
    program.isSourceFileDefaultLibrary(declaration.getSourceFile())
    && 'name' in declaration && (declaration as ts.NamedDeclaration).name?.getText() === 'URL')) return;
  const [specifier, base] = argument.arguments;
  if (!ts.isStringLiteralLike(specifier) || !ts.isPropertyAccessExpression(base) || base.name.text !== 'url'
    || !ts.isMetaProperty(base.expression) || base.expression.keywordToken !== ts.SyntaxKind.ImportKeyword
    || base.expression.name.text !== 'meta') return;
  try {
    const url = new URL(specifier.text, pathToFileURL(call.getSourceFile().fileName));
    if (url.protocol !== 'file:') return;
    url.search = ''; url.hash = '';
    return program.getSourceFile(fileURLToPath(url));
  } catch {
    return;
  }
}

function loadersForProgram(program: ts.Program) {
  const cached = moduleLoaders.get(program);
  if (cached) return cached;
  const index = new Map<string, ts.CallExpression[]>();
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile || !source.text.includes('addModule')) continue;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const target = audioWorkletModuleTarget(program, node);
        if (target) {
          const key = path.resolve(target.fileName), calls = index.get(key) || [];
          calls.push(node); index.set(key, calls);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  moduleLoaders.set(program, index);
  return index;
}

export function findHostRuntimeContract(program: ts.Program, node: ts.Identifier) {
  const specification = audioWorkletContracts.get(node.text);
  if (!specification || program.getTypeChecker().getSymbolAtLocation(node)?.declarations?.length) return;
  const loaders = loadersForProgram(program).get(path.resolve(node.getSourceFile().fileName));
  if (!loaders?.length) return;
  return {scope: 'AudioWorkletGlobalScope', specification, loaders};
}
