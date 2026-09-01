import ts from 'typescript';

import {
  getExtendedStableId,
  isTrackedSourceFile,
} from './functionFlowGraph.infrastructure.js';
import { resolveCanonicalDeclarationStableId } from './functionFlowGraph.canonicalReferences.js';

type FunctionLikeWithBody = ts.FunctionLikeDeclaration & { body: ts.ConciseBody };

export type ParameterOriginFact = {
  targetFnStableId: string;
  targetParameterStableId: string;
  targetParameterSlotStableId: string;
  targetParameterTypeDeclarationStableId?: string;
  parameterName: string;
  parameterIndex: number;
  callExpression: ts.CallExpression;
  callStableId: string;
  callerFn?: FunctionLikeWithBody;
  callerFnStableId?: string;
  argument: ts.Expression;
  argumentStableId: string;
  argumentText: string;
  argumentBinding?: {
    declaration: ts.Declaration;
    stableId: string;
    name: string;
    parameter: boolean;
  };
  callbackDispatch: boolean;
  useCallAsValueSource: boolean;
};

function argumentBinding(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): ParameterOriginFact['argumentBinding'] {
  let current = unwrapExpression(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrapExpression(current.expression);
  }
  if (!ts.isIdentifier(current)) return undefined;
  const declaration = symbolDeclarations(checker, current).find((candidate) => (
    ts.isParameter(candidate)
    || ts.isVariableDeclaration(candidate)
    || ts.isBindingElement(candidate)
  ));
  if (!declaration) return undefined;
  const nameNode = ts.isBindingElement(declaration) || ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)
    ? declaration.name
    : undefined;
  return {
    declaration,
    stableId: getExtendedStableId(declaration.getSourceFile(), declaration),
    name: nameNode?.getText(declaration.getSourceFile()) || current.text,
    parameter: ts.isParameter(declaration),
  };
}

function isFunctionLikeWithBody(node: ts.Node | undefined): node is FunctionLikeWithBody {
  return Boolean(node && ts.isFunctionLike(node) && node.body);
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function symbolDeclarations(checker: ts.TypeChecker, node: ts.Node) {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  return symbol
    ? [symbol.valueDeclaration, ...(symbol.declarations || [])].filter((item): item is ts.Declaration => Boolean(item))
    : [];
}

function enclosingFunction(node: ts.Node): FunctionLikeWithBody | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (isFunctionLikeWithBody(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function declarationKey(declaration: ts.Declaration) {
  const owner = ts.isFunctionTypeNode(declaration)
    && declaration.parent
    && (
      ts.isPropertySignature(declaration.parent)
      || ts.isPropertyDeclaration(declaration.parent)
      || ts.isParameter(declaration.parent)
    )
    ? declaration.parent
    : declaration;
  return getExtendedStableId(owner.getSourceFile(), owner);
}

function propertyDeclarationForBindingElement(
  checker: ts.TypeChecker,
  binding: ts.BindingElement,
): ts.Declaration | undefined {
  const propertyName = (binding.propertyName || binding.name).getText(binding.getSourceFile());
  const pattern = binding.parent;
  const owner = pattern.parent;
  let sourceNode: ts.Node | undefined;
  if (ts.isVariableDeclaration(owner)) sourceNode = owner.initializer;
  if (ts.isParameter(owner)) sourceNode = owner;
  if (!sourceNode) return undefined;
  const sourceType = checker.getTypeAtLocation(sourceNode);
  const property = sourceType.getProperty(propertyName);
  return property?.valueDeclaration || property?.declarations?.[0];
}

function callbackContractDeclaration(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  seen = new Set<ts.Node>(),
): ts.Declaration | undefined {
  const current = unwrapExpression(expression);
  if (seen.has(current)) return undefined;
  seen.add(current);

  const declarations = symbolDeclarations(checker, ts.isPropertyAccessExpression(current) ? current.name : current);
  for (const declaration of declarations) {
    if (
      ts.isParameter(declaration)
      || ts.isPropertySignature(declaration)
      || ts.isMethodSignature(declaration)
      || ts.isPropertyDeclaration(declaration)
    ) {
      return declaration;
    }
    if (ts.isBindingElement(declaration)) {
      const propertyDeclaration = propertyDeclarationForBindingElement(checker, declaration);
      if (propertyDeclaration) return propertyDeclaration;
    }
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const nested = callbackContractDeclaration(checker, declaration.initializer, seen);
      if (nested) return nested;
    }
  }
  return undefined;
}

function functionTargetsFromExpression(
  checker: ts.TypeChecker,
  stableIdByDeclaration: Map<ts.Node, string>,
  expression: ts.Expression,
  seen = new Set<ts.Node>(),
): Set<string> {
  const current = unwrapExpression(expression);
  if (seen.has(current)) return new Set();
  seen.add(current);
  const targets = new Set<string>();

  if (isFunctionLikeWithBody(current)) {
    const stableId = stableIdByDeclaration.get(current);
    if (stableId) targets.add(stableId);
    return targets;
  }

  for (const declaration of symbolDeclarations(checker, ts.isPropertyAccessExpression(current) ? current.name : current)) {
    if (isFunctionLikeWithBody(declaration)) {
      const stableId = stableIdByDeclaration.get(declaration);
      if (stableId) targets.add(stableId);
      continue;
    }
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const initializer = unwrapExpression(declaration.initializer);
      if (ts.isCallExpression(initializer)) {
        for (const argument of initializer.arguments) {
          for (const stableId of functionTargetsFromExpression(checker, stableIdByDeclaration, argument, seen)) {
            targets.add(stableId);
          }
        }
      } else {
        for (const stableId of functionTargetsFromExpression(checker, stableIdByDeclaration, initializer, seen)) {
          targets.add(stableId);
        }
      }
    }
  }
  return targets;
}

function parameterName(parameter: ts.ParameterDeclaration, index: number) {
  return ts.isIdentifier(parameter.name)
    ? parameter.name.text
    : parameter.name.getText(parameter.getSourceFile()) || `arg${index}`;
}

function resolvedFunctionStableId(
  checker: ts.TypeChecker,
  stableIdByDeclaration: Map<ts.Node, string>,
  call: ts.CallExpression,
) {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  return declaration && isFunctionLikeWithBody(declaration)
    ? stableIdByDeclaration.get(declaration)
    : undefined;
}

function jsxAttributeContractDeclaration(checker: ts.TypeChecker, attribute: ts.JsxAttribute) {
  const direct = symbolDeclarations(checker, attribute.name).find((declaration) => (
    ts.isPropertySignature(declaration)
    || ts.isMethodSignature(declaration)
    || ts.isPropertyDeclaration(declaration)
    || ts.isParameter(declaration)
  ));
  if (direct) return direct;
  const expression = jsxAttributeExpression(attribute);
  const contextualSymbol = expression
    ? checker.getContextualType(expression)?.getSymbol()
    : undefined;
  const contextualDeclaration = contextualSymbol?.valueDeclaration || contextualSymbol?.declarations?.[0];
  if (contextualDeclaration) return contextualDeclaration;
  const attributes = attribute.parent;
  const attributesType = checker.getTypeAtLocation(attributes);
  const property = attributesType.getProperty(attribute.name.getText(attribute.getSourceFile()));
  return property?.valueDeclaration || property?.declarations?.[0];
}

function jsxAttributeExpression(attribute: ts.JsxAttribute) {
  const initializer = attribute.initializer;
  return initializer && ts.isJsxExpression(initializer) && initializer.expression
    ? initializer.expression
    : undefined;
}

export function collectParameterOriginFacts(
  program: ts.Program,
  stableIdByDeclaration: Map<ts.Node, string>,
): ParameterOriginFact[] {
  const checker = program.getTypeChecker();
  const functionByStableId = new Map<string, FunctionLikeWithBody>();
  const callbackTargetsByContract = new Map<string, Set<string>>();

  const addCallbackTargets = (contract: ts.Declaration | undefined, targets: Set<string>) => {
    if (!contract || targets.size === 0) return;
    const key = declarationKey(contract);
    const current = callbackTargetsByContract.get(key) || new Set<string>();
    for (const target of targets) current.add(target);
    callbackTargetsByContract.set(key, current);
  };

  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile)) continue;
    const visit = (node: ts.Node): void => {
      if (isFunctionLikeWithBody(node)) {
        const stableId = stableIdByDeclaration.get(node);
        if (stableId) functionByStableId.set(stableId, node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  // First establish which concrete functions are passed through callback
  // parameters and JSX props. Callback invocations are resolved in pass two.
  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const declaration = checker.getResolvedSignature(node)?.declaration;
        if (declaration && ts.isFunctionLike(declaration)) {
          node.arguments.forEach((argument, index) => {
            const parameter = declaration.parameters[index]
              || (declaration.parameters.at(-1)?.dotDotDotToken ? declaration.parameters.at(-1) : undefined);
            if (!parameter) return;
            addCallbackTargets(
              parameter,
              functionTargetsFromExpression(checker, stableIdByDeclaration, argument),
            );
          });
        }
      } else if (ts.isJsxAttribute(node)) {
        const expression = jsxAttributeExpression(node);
        if (expression) {
          addCallbackTargets(
            jsxAttributeContractDeclaration(checker, node),
            functionTargetsFromExpression(checker, stableIdByDeclaration, expression),
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const facts: ParameterOriginFact[] = [];
  const seenFacts = new Set<string>();
  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile)) continue;
    const visit = (node: ts.Node): void => {
      if (!ts.isCallExpression(node)) {
        ts.forEachChild(node, visit);
        return;
      }

      const directTarget = resolvedFunctionStableId(checker, stableIdByDeclaration, node);
      const contract = callbackContractDeclaration(checker, node.expression);
      const callbackTargets = contract
        ? callbackTargetsByContract.get(declarationKey(contract)) || new Set<string>()
        : new Set<string>();
      const targetIds = new Set<string>(directTarget ? [directTarget] : callbackTargets);
      const callbackDispatch = !directTarget && targetIds.size > 0;
      const callerFn = enclosingFunction(node);
      const callerFnStableId = callerFn ? stableIdByDeclaration.get(callerFn) : undefined;
      const callStableId = getExtendedStableId(sourceFile, node);

      for (const targetFnStableId of targetIds) {
        const target = functionByStableId.get(targetFnStableId);
        if (!target) continue;
        node.arguments.forEach((argument, index) => {
          const parameter = target.parameters[index]
            || (target.parameters.at(-1)?.dotDotDotToken ? target.parameters.at(-1) : undefined);
          if (!parameter) return;
          const parameterIndex = target.parameters.indexOf(parameter);
          const targetParameterSlotStableId = getExtendedStableId(parameter.getSourceFile(), parameter);
          const targetParameterStableId = targetParameterSlotStableId;
          const parameterTypeLocation = parameter.type
            ? ts.isTypeReferenceNode(parameter.type)
              ? parameter.type.typeName
              : parameter.type
            : undefined;
          const argumentStableId = `${getExtendedStableId(sourceFile, argument)}:arg${index}`;
          const key = `${callStableId}\u0000${index}\u0000${targetParameterStableId}`;
          if (seenFacts.has(key)) return;
          seenFacts.add(key);
          facts.push({
            targetFnStableId,
            targetParameterStableId,
            targetParameterSlotStableId,
            targetParameterTypeDeclarationStableId: parameterTypeLocation
              ? resolveCanonicalDeclarationStableId(checker, parameterTypeLocation)
              : undefined,
            parameterName: parameterName(parameter, parameterIndex),
            parameterIndex,
            callExpression: node,
            callStableId,
            callerFn,
            callerFnStableId,
            argument,
            argumentStableId,
            argumentText: argument.getText(sourceFile),
            argumentBinding: argumentBinding(checker, argument),
            callbackDispatch,
            useCallAsValueSource: node.arguments.length <= 1,
          });
        });
      }

      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return facts;
}
