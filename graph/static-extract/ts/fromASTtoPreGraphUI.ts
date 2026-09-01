import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { buildStableIdFromCoordinates } from '../../packages/runtime-core/src/stableId.js';

type UiAffordanceRow = {
  key: string;
  ownerStableId: string;
  ownerName: string;
  ownerFilePath: string;
  ownerRepoRelativePath: string;
  ownerStartLine: number;
  ownerStartColumn: number;
  elementName: string;
  elementKind: 'intrinsic' | 'component';
  primaryDescendantKind: string;
  descendantKinds: string[];
  interactionKinds: string[];
  eventHandlerNames: string[];
  roleValues: string[];
  tagPath: string;
  depth: number;
  line: number;
  column: number;
  targetStableId?: string;
  targetName?: string;
};

type UiHandlerEdgeRow = {
  affordanceKey: string;
  ownerStableId: string;
  handlerStableId: string;
  handlerName?: string;
  eventHandlerName: string;
  resolutionKind: 'direct-ref' | 'direct-call' | 'inline-handler';
};

type ExtractedPayload = {
  uiControls: UiAffordanceRow[];
  uiInputs: UiAffordanceRow[];
  controlHandlerEdges: UiHandlerEdgeRow[];
  inputHandlerEdges: UiHandlerEdgeRow[];
};

type HandlerTarget = {
  stableId: string;
  handlerName?: string;
};

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(scriptPath), '..', '..', '..');
const tsconfigPath = path.join(workspaceRoot, 'tsconfig.json');

const SKIP_PATH_FRAGMENTS = [
  '/node_modules/',
  '/dist/',
  '/build/',
  '/src/lib/gramjs/tl/',
  '/src/components/test/',
  '/src/components/demo/',
  '/src/components/mock/',
];

const INTRINSIC_INTERACTION_KINDS: Record<string, string[]> = {
  a: ['link'],
  button: ['press'],
  details: ['toggle'],
  dialog: ['dialog'],
  form: ['submit'],
  input: ['input'],
  option: ['selection'],
  select: ['selection'],
  summary: ['toggle'],
  textarea: ['input'],
};

const INTRINSIC_DESCENDANT_KINDS: Record<string, string[]> = {
  a: ['navigational-link'],
  button: ['button'],
  details: ['toggle'],
  form: ['form'],
  input: ['form-control'],
  menu: ['menu'],
  select: ['form-control', 'selection-control'],
  summary: ['toggle'],
  textarea: ['form-control'],
};

const EVENT_INTERACTION_KINDS: Record<string, string[]> = {
  onChange: ['input'],
  onClick: ['press'],
  onContextMenu: ['menu'],
  onInput: ['input'],
  onKeyDown: ['key-input'],
  onKeyUp: ['key-input'],
  onMouseDown: ['press'],
  onPointerDown: ['press'],
  onScroll: ['scroll'],
  onSubmit: ['submit'],
  onTouchEnd: ['press'],
  onTouchStart: ['press'],
  onWheel: ['scroll'],
};

const ROLE_INTERACTION_KINDS: Record<string, string[]> = {
  button: ['press'],
  checkbox: ['toggle'],
  link: ['link'],
  menuitem: ['menu'],
  option: ['selection'],
  radio: ['toggle'],
  searchbox: ['input'],
  slider: ['input'],
  spinbutton: ['input'],
  switch: ['toggle'],
  tab: ['selection'],
  textbox: ['input'],
};

const ROLE_DESCENDANT_KINDS: Record<string, string[]> = {
  button: ['button'],
  checkbox: ['toggle'],
  link: ['navigational-link'],
  menu: ['menu'],
  menubar: ['menu'],
  menuitem: ['menu'],
  menuitemcheckbox: ['menu', 'toggle'],
  menuitemradio: ['menu', 'toggle'],
  radio: ['toggle'],
  searchbox: ['form-control'],
  slider: ['form-control'],
  spinbutton: ['form-control'],
  switch: ['toggle'],
  tab: ['navigational-link', 'selection-control'],
  tablist: ['menu'],
  textbox: ['form-control'],
};

const CUSTOM_COMPONENT_INTERACTION_PATTERNS: Array<[RegExp, string[]]> = [
  [/(^|)(Button|Chip|Tab|Tabs|Toolbar|SeekLine)$/i, ['press']],
  [/(^|)(Link|Anchor)$/i, ['link']],
  [/(Input|Textarea|Search|Select|Picker|Slider|Seek|Range)$/i, ['input']],
  [/(^|)(Checkbox|Radio|Switch|Toggle)$/i, ['toggle']],
  [/(^|)(Menu|Dropdown|Popover|Tooltip|Dialog|Modal)$/i, ['menu']],
];

const CUSTOM_COMPONENT_DESCENDANT_KIND_PATTERNS: Array<[RegExp, string[]]> = [
  [/(^|)(Button|Chip|Action|Trigger)$/i, ['button']],
  [/(^|)(Link|Anchor|Breadcrumb|Nav|Navigation|Tab|Tabs)$/i, ['navigational-link']],
  [/(^|)(Form)$/i, ['form']],
  [/(Input|Textarea|Search|Select|Picker|Slider|Seek|Range|Field)$/i, ['form-control']],
  [/(^|)(Checkbox|Radio|Switch|Toggle)$/i, ['toggle']],
  [/(^|)(Menu|Dropdown|Popover|Tooltip|MenuItem|ContextMenu)$/i, ['menu']],
  [/(^|)(Dialog|Modal)$/i, ['dialog-trigger']],
];

const ATTRIBUTE_DESCENDANT_KIND_HINTS: Record<string, string[]> = {
  href: ['navigational-link'],
  to: ['navigational-link'],
  action: ['form'],
  formaction: ['form'],
};

const INPUT_TYPE_DESCENDANT_KINDS: Record<string, string[]> = {
  button: ['button'],
  checkbox: ['toggle'],
  email: ['form-control'],
  number: ['form-control'],
  password: ['form-control'],
  radio: ['toggle'],
  range: ['form-control'],
  reset: ['button'],
  search: ['form-control'],
  submit: ['button', 'form'],
  text: ['form-control'],
  url: ['form-control'],
};

const DESCENDANT_KIND_PRIORITY = [
  'navigational-link',
  'toggle',
  'menu',
  'form',
  'button',
  'selection-control',
  'form-control',
  'dialog-trigger',
  'interactive',
];

const CONTROL_DESCENDANT_KINDS = new Set([
  'button',
  'toggle',
  'menu',
  'navigational-link',
  'dialog-trigger',
  'form',
]);

const INPUT_DESCENDANT_KINDS = new Set([
  'form-control',
  'selection-control',
]);

const formatHost: ts.FormatDiagnosticsHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => workspaceRoot,
  getNewLine: () => '\n',
};

function toPosix(filePath: string) {
  return filePath.replace(/\\/g, '/');
}

function getRepoRelativePath(filePath: string) {
  return toPosix(path.relative(workspaceRoot, filePath));
}

function isTrackedSourceFile(sourceFile: ts.SourceFile) {
  if (sourceFile.isDeclarationFile) {
    return false;
  }

  const normalized = toPosix(path.resolve(sourceFile.fileName)).toLowerCase();
  const isKnownUiRoot = normalized.startsWith(toPosix(path.join(workspaceRoot, 'src/components')).toLowerCase())
    || normalized.startsWith(toPosix(path.join(workspaceRoot, 'screens')).toLowerCase());
  if (!isKnownUiRoot) {
    return false;
  }

  if (!normalized.endsWith('.tsx') && !normalized.endsWith('.jsx')) {
    return false;
  }

  return !SKIP_PATH_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function createProgram() {
  const configText = fs.readFileSync(tsconfigPath, 'utf8');
  const parsedConfig = ts.parseConfigFileTextToJson(tsconfigPath, configText);
  if (parsedConfig.error) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext([parsedConfig.error], formatHost));
  }

  const config = ts.parseJsonConfigFileContent(parsedConfig.config, ts.sys, workspaceRoot);
  if (config.errors.length) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(config.errors, formatHost));
  }

  return ts.createProgram({
    rootNames: config.fileNames,
    options: config.options,
  });
}

function isFunctionLikeNode(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node);
}

function getPropertyNameText(name: ts.PropertyName | ts.MemberName) {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    return name.expression.getText();
  }

  return name.getText();
}

function getFunctionName(node: ts.FunctionLikeDeclaration) {
  if ('name' in node && node.name) {
    return getPropertyNameText(node.name);
  }

  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (parent && ts.isPropertyAssignment(parent)) {
    return getPropertyNameText(parent.name);
  }

  return '<anonymous>';
}

function unwrapJsxExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }

  return current;
}

function collectReturnedJsxRoots(node: ts.FunctionLikeDeclaration) {
  const roots: ts.Expression[] = [];
  const seenRootPositions = new Set<number>();

  function pushRoot(expression: ts.Expression) {
    const position = expression.getStart();
    if (seenRootPositions.has(position)) {
      return;
    }
    seenRootPositions.add(position);
    roots.push(expression);
  }

  function pushIfJsx(expression: ts.Expression | undefined) {
    if (!expression) {
      return;
    }

    const jsxNodes = extractImmediateJsxNodes(expression);
    if (jsxNodes.length) {
      jsxNodes.forEach(pushRoot);
    }
  }

  if (node.body && ts.isBlock(node.body)) {
    function visit(current: ts.Node): void {
      if (current !== node.body && isFunctionLikeNode(current)) {
        return;
      }
      if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current) || ts.isJsxFragment(current)) {
        pushRoot(current);
      }
      if (ts.isReturnStatement(current)) {
        pushIfJsx(current.expression);
        return;
      }
      ts.forEachChild(current, visit);
    }

    visit(node.body);
  } else if (node.body && ts.isExpression(node.body)) {
    pushIfJsx(node.body);
  }

  return roots;
}

function getLineAndColumn(sourceFile: ts.SourceFile, position: number) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(position);
  return {
    line: line + 1,
    column: character,
  };
}

function getStableIdStartPosition(sourceFile: ts.SourceFile, node: ts.Node) {
  let position = node.getStart(sourceFile);

  if (!isFunctionLikeNode(node) || !node.modifiers?.length) {
    return position;
  }

  let skippedModifierEnd: number | undefined;
  for (const modifier of node.modifiers) {
    if (modifier.kind !== ts.SyntaxKind.ExportKeyword && modifier.kind !== ts.SyntaxKind.DefaultKeyword) {
      break;
    }

    skippedModifierEnd = modifier.getEnd();
  }

  if (skippedModifierEnd === undefined) {
    return position;
  }

  position = skippedModifierEnd;
  while (position < sourceFile.text.length && /\s/.test(sourceFile.text[position])) {
    position += 1;
  }

  return position;
}

function getStableId(sourceFile: ts.SourceFile, node: ts.Node) {
  const startPosition = getStableIdStartPosition(sourceFile, node);
  const start = getLineAndColumn(sourceFile, startPosition);
  const endPosition = Math.max(startPosition, node.getEnd());
  const end = getLineAndColumn(sourceFile, endPosition);
  return buildStableIdFromCoordinates({
    filePath: toPosix(path.resolve(sourceFile.fileName)),
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  });
}

function extractImmediateJsxNodes(expression: ts.Expression): Array<ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment> {
  const current = unwrapJsxExpression(expression);
  if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current) || ts.isJsxFragment(current)) {
    return [current];
  }
  if (ts.isConditionalExpression(current)) {
    return [
      ...extractImmediateJsxNodes(current.whenTrue),
      ...extractImmediateJsxNodes(current.whenFalse),
    ];
  }
  if (ts.isBinaryExpression(current) && [
    ts.SyntaxKind.AmpersandAmpersandToken,
    ts.SyntaxKind.BarBarToken,
    ts.SyntaxKind.QuestionQuestionToken,
  ].includes(current.operatorToken.kind)) {
    const nodes: Array<ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment> = [];
    if (ts.isExpression(current.left)) {
      nodes.push(...extractImmediateJsxNodes(current.left));
    }
    if (ts.isExpression(current.right)) {
      nodes.push(...extractImmediateJsxNodes(current.right));
    }
    return nodes;
  }
  if (ts.isArrayLiteralExpression(current)) {
    return current.elements.flatMap((element) => ts.isExpression(element) ? extractImmediateJsxNodes(element) : []);
  }

  return [];
}

function getJsxTagNameText(tagName: ts.JsxTagNameExpression) {
  if (ts.isIdentifier(tagName) || ts.isThisTypeNode(tagName)) {
    return tagName.getText();
  }
  if (ts.isPropertyAccessExpression(tagName)) {
    return tagName.name.text;
  }
  if (ts.isJsxNamespacedName(tagName)) {
    return `${tagName.namespace.text}:${tagName.name.text}`;
  }

  return tagName.getText();
}

function getAttributeName(attribute: ts.JsxAttributeLike) {
  if (!ts.isJsxAttribute(attribute)) {
    return undefined;
  }

  return attribute.name.text;
}

function getStringLikeAttributeValue(attribute: ts.JsxAttributeLike) {
  if (!ts.isJsxAttribute(attribute) || !attribute.initializer) {
    return undefined;
  }
  if (ts.isStringLiteral(attribute.initializer)) {
    return attribute.initializer.text;
  }
  if (ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression && ts.isStringLiteralLike(attribute.initializer.expression)) {
    return attribute.initializer.expression.text;
  }

  return undefined;
}

function getHandlerExpression(attribute: ts.JsxAttributeLike) {
  if (!ts.isJsxAttribute(attribute) || !attribute.initializer || !ts.isJsxExpression(attribute.initializer) || !attribute.initializer.expression) {
    return undefined;
  }

  return attribute.initializer.expression;
}

function isIntrinsicTagName(tagName: string) {
  return /^[a-z]/.test(tagName);
}

function resolveTargetStableId(
  checker: ts.TypeChecker,
  stableIdByDeclaration: Map<ts.Node, string>,
  tagName: ts.JsxTagNameExpression,
) {
  if (!ts.isIdentifier(tagName) && !ts.isPropertyAccessExpression(tagName)) {
    return undefined;
  }

  const symbol = checker.getSymbolAtLocation(tagName);
  const resolved = symbol && ((symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol);
  for (const declaration of resolved?.declarations ?? []) {
    const stableId = stableIdByDeclaration.get(declaration);
    if (stableId) {
      return {
        stableId,
        targetName: 'name' in declaration && declaration.name && (ts.isIdentifier(declaration.name) || ts.isPrivateIdentifier(declaration.name))
          ? declaration.name.text
          : resolved?.getName(),
      };
    }
  }

  return undefined;
}

function getWrappedFunctionLike(expression: ts.Expression | undefined): ts.FunctionLikeDeclaration | undefined {
  if (!expression) {
    return undefined;
  }

  const current = unwrapJsxExpression(expression);
  if (isFunctionLikeNode(current)) {
    return current;
  }

  if (ts.isCallExpression(current)) {
    for (const argument of current.arguments) {
      if (!ts.isExpression(argument)) {
        continue;
      }

      const wrapped = getWrappedFunctionLike(argument);
      if (wrapped) {
        return wrapped;
      }
    }
  }

  return undefined;
}

function getDeclarationDisplayName(declaration: ts.Declaration, fallbackName?: string) {
  if ('name' in declaration && declaration.name) {
    const name = declaration.name;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
      return name.text;
    }
    if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
      return name.text;
    }
  }

  if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
    return declaration.name.text;
  }

  if (ts.isPropertyAssignment(declaration)) {
    return getPropertyNameText(declaration.name);
  }

  return fallbackName;
}

function resolveTargetsFromSymbol(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
  stableIdByDeclaration: Map<ts.Node, string>,
) {
  if (!symbol) {
    return [] as HandlerTarget[];
  }

  const resolved = (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol;
  const targets: HandlerTarget[] = [];
  const seenStableIds = new Set<string>();

  for (const declaration of resolved.declarations ?? []) {
    const stableId = stableIdByDeclaration.get(declaration) || stableIdByDeclaration.get(declaration.parent);
    if (!stableId || seenStableIds.has(stableId)) {
      continue;
    }

    targets.push({
      stableId,
      handlerName: getDeclarationDisplayName(declaration, resolved.getName()),
    });
    seenStableIds.add(stableId);
  }

  return targets;
}

function resolveHandlerTargetsFromExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  stableIdByDeclaration: Map<ts.Node, string>,
): HandlerTarget[] {
  const current = unwrapJsxExpression(expression);

  if (ts.isIdentifier(current) || ts.isPropertyAccessExpression(current)) {
    return resolveTargetsFromSymbol(checker.getSymbolAtLocation(current), checker, stableIdByDeclaration);
  }

  if (ts.isCallExpression(current)) {
    return resolveHandlerTargetsFromExpression(current.expression, checker, stableIdByDeclaration);
  }

  if (ts.isConditionalExpression(current)) {
    return [
      ...resolveHandlerTargetsFromExpression(current.whenTrue, checker, stableIdByDeclaration),
      ...resolveHandlerTargetsFromExpression(current.whenFalse, checker, stableIdByDeclaration),
    ];
  }

  if (ts.isBinaryExpression(current) && [
    ts.SyntaxKind.AmpersandAmpersandToken,
    ts.SyntaxKind.BarBarToken,
    ts.SyntaxKind.QuestionQuestionToken,
  ].includes(current.operatorToken.kind)) {
    const targets: HandlerTarget[] = [];
    if (ts.isExpression(current.left)) {
      targets.push(...resolveHandlerTargetsFromExpression(current.left, checker, stableIdByDeclaration));
    }
    if (ts.isExpression(current.right)) {
      targets.push(...resolveHandlerTargetsFromExpression(current.right, checker, stableIdByDeclaration));
    }
    return targets;
  }

  if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
    const targets: HandlerTarget[] = [];
    const seenStableIds = new Set<string>();

    const pushTargets = (nextTargets: HandlerTarget[]) => {
      nextTargets.forEach((target) => {
        if (seenStableIds.has(target.stableId)) {
          return;
        }

        targets.push(target);
        seenStableIds.add(target.stableId);
      });
    };

    if (current.body && ts.isExpression(current.body)) {
      pushTargets(resolveHandlerTargetsFromExpression(current.body, checker, stableIdByDeclaration));
      return targets;
    }

    if (current.body && ts.isBlock(current.body)) {
      function visit(node: ts.Node): void {
        if (node !== current.body && isFunctionLikeNode(node)) {
          return;
        }

        if (ts.isCallExpression(node)) {
          pushTargets(resolveHandlerTargetsFromExpression(node.expression, checker, stableIdByDeclaration));
        } else if (ts.isReturnStatement(node) && node.expression) {
          pushTargets(resolveHandlerTargetsFromExpression(node.expression, checker, stableIdByDeclaration));
        }

        ts.forEachChild(node, visit);
      }

      visit(current.body);
    }

    return targets;
  }

  return [];
}

function classifyInteractiveElement(
  checker: ts.TypeChecker,
  stableIdByDeclaration: Map<ts.Node, string>,
  node: ts.JsxOpeningLikeElement,
) {
  const elementName = getJsxTagNameText(node.tagName);
  const elementKind = isIntrinsicTagName(elementName) ? 'intrinsic' as const : 'component' as const;
  const descendantKinds = new Set<string>();
  const interactionKinds = new Set<string>();
  const eventHandlerNames: string[] = [];
  const roleValues: string[] = [];

  if (elementKind === 'intrinsic') {
    for (const kind of INTRINSIC_INTERACTION_KINDS[elementName] ?? []) {
      interactionKinds.add(kind);
    }

    for (const kind of INTRINSIC_DESCENDANT_KINDS[elementName] ?? []) {
      descendantKinds.add(kind);
    }
  }

  for (const attribute of node.attributes.properties) {
    const attributeName = getAttributeName(attribute);
    if (!attributeName) {
      continue;
    }

    if (EVENT_INTERACTION_KINDS[attributeName]) {
      eventHandlerNames.push(attributeName);
      for (const kind of EVENT_INTERACTION_KINDS[attributeName]) {
        interactionKinds.add(kind);
      }
    }

    if (attributeName === 'href' || attributeName === 'to') {
      interactionKinds.add('link');
    }

    for (const kind of ATTRIBUTE_DESCENDANT_KIND_HINTS[attributeName] ?? []) {
      descendantKinds.add(kind);
    }

    if (attributeName === 'role') {
      const roleValue = getStringLikeAttributeValue(attribute);
      if (roleValue) {
        roleValues.push(roleValue);
        for (const kind of ROLE_INTERACTION_KINDS[roleValue] ?? []) {
          interactionKinds.add(kind);
        }
        for (const kind of ROLE_DESCENDANT_KINDS[roleValue] ?? []) {
          descendantKinds.add(kind);
        }
      }
    }

    if (attributeName === 'type' && elementName === 'input') {
      const inputType = getStringLikeAttributeValue(attribute)?.toLowerCase();
      if (inputType) {
        for (const kind of INPUT_TYPE_DESCENDANT_KINDS[inputType] ?? []) {
          descendantKinds.add(kind);
        }
      }
    }
  }

  if (elementKind === 'component') {
    for (const [pattern, kinds] of CUSTOM_COMPONENT_INTERACTION_PATTERNS) {
      if (!pattern.test(elementName)) {
        continue;
      }

      for (const kind of kinds) {
        interactionKinds.add(kind);
      }
    }

    for (const [pattern, kinds] of CUSTOM_COMPONENT_DESCENDANT_KIND_PATTERNS) {
      if (!pattern.test(elementName)) {
        continue;
      }

      for (const kind of kinds) {
        descendantKinds.add(kind);
      }
    }
  }

  if (!interactionKinds.size) {
    return undefined;
  }

  if (!descendantKinds.size) {
    if (interactionKinds.has('link')) {
      descendantKinds.add('navigational-link');
    }
    if (interactionKinds.has('toggle')) {
      descendantKinds.add('toggle');
    }
    if (interactionKinds.has('menu')) {
      descendantKinds.add('menu');
    }
    if (interactionKinds.has('submit')) {
      descendantKinds.add('form');
    }
    if (interactionKinds.has('press')) {
      descendantKinds.add('button');
    }
    if (interactionKinds.has('selection')) {
      descendantKinds.add('selection-control');
    }
    if (interactionKinds.has('input') || interactionKinds.has('key-input')) {
      descendantKinds.add('form-control');
    }
  }

  if (!descendantKinds.size) {
    descendantKinds.add('interactive');
  }

  const sortedDescendantKinds = [...descendantKinds].sort((left, right) => {
    const leftPriority = DESCENDANT_KIND_PRIORITY.indexOf(left);
    const rightPriority = DESCENDANT_KIND_PRIORITY.indexOf(right);

    if (leftPriority === -1 && rightPriority === -1) {
      return left.localeCompare(right);
    }
    if (leftPriority === -1) {
      return 1;
    }
    if (rightPriority === -1) {
      return -1;
    }

    return leftPriority - rightPriority;
  });

  const target = elementKind === 'component'
    ? resolveTargetStableId(checker, stableIdByDeclaration, node.tagName)
    : undefined;

  return {
    elementName,
    elementKind,
    descendantKinds: sortedDescendantKinds,
    primaryDescendantKind: sortedDescendantKinds[0],
    interactionKinds: [...interactionKinds].sort(),
    eventHandlerNames: [...new Set(eventHandlerNames)].sort(),
    roleValues: [...new Set(roleValues)].sort(),
    targetStableId: target?.stableId,
    targetName: target?.targetName,
  };
}

function determineAffordanceType(descendantKinds: string[], interactionKinds: string[]) {
  if (descendantKinds.some((kind) => CONTROL_DESCENDANT_KINDS.has(kind))) {
    return 'control' as const;
  }

  if (descendantKinds.some((kind) => INPUT_DESCENDANT_KINDS.has(kind))) {
    return 'input' as const;
  }

  if (interactionKinds.includes('input') || interactionKinds.includes('key-input')) {
    return 'input' as const;
  }

  return 'control' as const;
}

function buildUiAffordanceBaseKey(
  ownerRepoRelativePath: string,
  ownerName: string,
  tagPath: string,
  interaction: ReturnType<typeof classifyInteractiveElement>,
) {
  const eventHandlerKey = [...interaction.eventHandlerNames].sort().join('+') || 'no-handler';
  const roleKey = [...interaction.roleValues].sort().join('+') || 'no-role';
  const targetKey = interaction.targetName || interaction.targetStableId || 'no-target';

  return [
    ownerRepoRelativePath,
    ownerName,
    tagPath,
    interaction.elementName,
    interaction.primaryDescendantKind,
    eventHandlerKey,
    roleKey,
    targetKey,
  ].join('::');
}

function buildJsxSiblingPathSegment(
  node: ts.JsxElement | ts.JsxSelfClosingElement,
  siblingCountsByTagName: Map<string, number>,
) {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  const elementName = getJsxTagNameText(opening.tagName);
  const siblingIndex = siblingCountsByTagName.get(elementName) || 0;

  siblingCountsByTagName.set(elementName, siblingIndex + 1);
  return `${elementName}[${siblingIndex}]`;
}

function collectUiAffordances(
  checker: ts.TypeChecker,
  stableIdByDeclaration: Map<ts.Node, string>,
  sourceFile: ts.SourceFile,
  ownerStableId: string,
  ownerName: string,
  ownerFilePath: string,
  ownerRepoRelativePath: string,
  ownerStartLine: number,
  ownerStartColumn: number,
  jsxRoots: ts.Expression[],
) {
  const uiControls: UiAffordanceRow[] = [];
  const uiInputs: UiAffordanceRow[] = [];
  const controlHandlerEdges: UiHandlerEdgeRow[] = [];
  const inputHandlerEdges: UiHandlerEdgeRow[] = [];
  const seenAffordanceKeys = new Set<string>();
  const seenAffordanceOpeningSignatures = new Set<string>();
  const affordanceOccurrenceByBaseKey = new Map<string, number>();
  const seenControlHandlerEdges = new Set<string>();
  const seenInputHandlerEdges = new Set<string>();

  function visitJsxNode(
    node: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment,
    pathSegments: string[],
    pathSegment?: string,
  ): void {
    if (ts.isJsxFragment(node)) {
      visitJsxChildren(node.children, pathSegments);
      return;
    }

    const opening = ts.isJsxElement(node) ? node.openingElement : node;
    const elementName = getJsxTagNameText(opening.tagName);
    const currentPathSegments = [...pathSegments, pathSegment || `${elementName}[0]`];
    const tagPath = currentPathSegments.join('>');
    const interaction = classifyInteractiveElement(checker, stableIdByDeclaration, opening);

    if (interaction) {
      const position = getLineAndColumn(sourceFile, opening.getStart(sourceFile));
      const openingSignature = [
        position.line,
        position.column,
        interaction.elementName,
        interaction.eventHandlerNames.join('+'),
      ].join(':');
      if (seenAffordanceOpeningSignatures.has(openingSignature)) {
        if (ts.isJsxElement(node)) {
          visitJsxChildren(node.children, currentPathSegments);
        }
        return;
      }
      const affordanceBaseKey = buildUiAffordanceBaseKey(
        ownerRepoRelativePath,
        ownerName,
        tagPath,
        interaction,
      );
      const affordanceOccurrence = affordanceOccurrenceByBaseKey.get(affordanceBaseKey) || 0;
      const affordanceKey = `${affordanceBaseKey}::occurrence[${affordanceOccurrence}]`;

      if (!seenAffordanceKeys.has(affordanceKey)) {
        const affordanceType = determineAffordanceType(interaction.descendantKinds, interaction.interactionKinds);
        const row: UiAffordanceRow = {
          key: affordanceKey,
          ownerStableId,
          ownerName,
          ownerFilePath,
          ownerRepoRelativePath,
          ownerStartLine,
          ownerStartColumn,
          elementName: interaction.elementName,
          elementKind: interaction.elementKind,
          primaryDescendantKind: interaction.primaryDescendantKind,
          descendantKinds: interaction.descendantKinds,
          interactionKinds: interaction.interactionKinds,
          eventHandlerNames: interaction.eventHandlerNames,
          roleValues: interaction.roleValues,
          tagPath,
          depth: currentPathSegments.length,
          line: position.line,
          column: position.column,
          targetStableId: interaction.targetStableId,
          targetName: interaction.targetName,
        };

        if (affordanceType === 'control') {
          uiControls.push(row);
        } else {
          uiInputs.push(row);
        }

        affordanceOccurrenceByBaseKey.set(affordanceBaseKey, affordanceOccurrence + 1);
        seenAffordanceKeys.add(affordanceKey);
        seenAffordanceOpeningSignatures.add(openingSignature);

        for (const attribute of opening.attributes.properties) {
          const attributeName = getAttributeName(attribute);
          if (!attributeName || !EVENT_INTERACTION_KINDS[attributeName]) {
            continue;
          }

          const handlerExpression = getHandlerExpression(attribute);
          if (!handlerExpression) {
            continue;
          }

          const resolutionKind = (ts.isArrowFunction(handlerExpression) || ts.isFunctionExpression(handlerExpression))
            ? 'inline-handler' as const
            : (ts.isCallExpression(unwrapJsxExpression(handlerExpression)) ? 'direct-call' as const : 'direct-ref' as const);

          const handlerTargets = resolveHandlerTargetsFromExpression(handlerExpression, checker, stableIdByDeclaration);
          for (const handlerTarget of handlerTargets) {
            const edgeKey = `${affordanceKey}::${handlerTarget.stableId}::${attributeName}`;
            if (affordanceType === 'control') {
              if (seenControlHandlerEdges.has(edgeKey)) {
                continue;
              }
              controlHandlerEdges.push({
                affordanceKey,
                ownerStableId,
                handlerStableId: handlerTarget.stableId,
                handlerName: handlerTarget.handlerName,
                eventHandlerName: attributeName,
                resolutionKind,
              });
              seenControlHandlerEdges.add(edgeKey);
            } else {
              if (seenInputHandlerEdges.has(edgeKey)) {
                continue;
              }
              inputHandlerEdges.push({
                affordanceKey,
                ownerStableId,
                handlerStableId: handlerTarget.stableId,
                handlerName: handlerTarget.handlerName,
                eventHandlerName: attributeName,
                resolutionKind,
              });
              seenInputHandlerEdges.add(edgeKey);
            }
          }
        }
      }
    }

    if (ts.isJsxElement(node)) {
      visitJsxChildren(node.children, currentPathSegments);
    }
  }

  function visitJsxChildren(children: ts.NodeArray<ts.JsxChild>, pathSegments: string[]): void {
    const siblingCountsByTagName = new Map<string, number>();

    function visitChildNode(node: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment): void {
      if (ts.isJsxFragment(node)) {
        visitJsxNode(node, pathSegments);
        return;
      }

      visitJsxNode(node, pathSegments, buildJsxSiblingPathSegment(node, siblingCountsByTagName));
    }

    for (const child of children) {
      if (ts.isJsxText(child)) {
        continue;
      }
      if (ts.isJsxExpression(child)) {
        if (!child.expression) {
          continue;
        }
        const nestedNodes = extractImmediateJsxNodes(child.expression);
        for (const nestedNode of nestedNodes) {
          visitChildNode(nestedNode);
        }
        continue;
      }

      visitChildNode(child);
    }
  }

  jsxRoots.forEach((root, index) => {
    const rootNodes = extractImmediateJsxNodes(root);
    rootNodes.forEach((jsxNode, rootIndex) => {
      visitJsxNode(jsxNode, [`root[${index + rootIndex}]`]);
    });
  });

  return {
    uiControls,
    uiInputs,
    controlHandlerEdges,
    inputHandlerEdges,
  };
}

function main() {
  const program = createProgram();
  const checker = program.getTypeChecker();
  const stableIdByDeclaration = new Map<ts.Node, string>();

  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile)) {
      continue;
    }

    function register(current: ts.Node): void {
      if (isFunctionLikeNode(current)) {
        const stableId = getStableId(sourceFile, current);
        stableIdByDeclaration.set(current, stableId);
        if (current.parent && ts.isVariableDeclaration(current.parent)) {
          stableIdByDeclaration.set(current.parent, stableId);
        }
        if (current.parent && ts.isPropertyAssignment(current.parent)) {
          stableIdByDeclaration.set(current.parent, stableId);
        }
      }

      if (ts.isVariableDeclaration(current)) {
        const wrappedFunction = getWrappedFunctionLike(current.initializer);
        if (wrappedFunction) {
          stableIdByDeclaration.set(current, getStableId(sourceFile, wrappedFunction));
        }
      }

      if (ts.isPropertyAssignment(current)) {
        const wrappedFunction = getWrappedFunctionLike(current.initializer);
        if (wrappedFunction) {
          stableIdByDeclaration.set(current, getStableId(sourceFile, wrappedFunction));
        }
      }

      ts.forEachChild(current, register);
    }

    register(sourceFile);
  }

  const uiControls: UiAffordanceRow[] = [];
  const uiInputs: UiAffordanceRow[] = [];
  const controlHandlerEdges: UiHandlerEdgeRow[] = [];
  const inputHandlerEdges: UiHandlerEdgeRow[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile)) {
      continue;
    }

    const ownerFilePath = toPosix(path.resolve(sourceFile.fileName));
    const ownerRepoRelativePath = getRepoRelativePath(ownerFilePath);

    function visit(current: ts.Node): void {
      if (isFunctionLikeNode(current)) {
        const ownerName = getFunctionName(current);
        if (ownerName === '<anonymous>') {
          ts.forEachChild(current, visit);
          return;
        }

        const jsxRoots = collectReturnedJsxRoots(current);
        if (!jsxRoots.length) {
          ts.forEachChild(current, visit);
          return;
        }

        const ownerStableId = getStableId(sourceFile, current);
        const start = getLineAndColumn(sourceFile, current.getStart(sourceFile));
        const extracted = collectUiAffordances(
          checker,
          stableIdByDeclaration,
          sourceFile,
          ownerStableId,
          ownerName,
          ownerFilePath,
          ownerRepoRelativePath,
          start.line,
          start.column,
          jsxRoots,
        );

        uiControls.push(...extracted.uiControls);
        uiInputs.push(...extracted.uiInputs);
        controlHandlerEdges.push(...extracted.controlHandlerEdges);
        inputHandlerEdges.push(...extracted.inputHandlerEdges);
      }

      ts.forEachChild(current, visit);
    }

    visit(sourceFile);
  }

  const payload: ExtractedPayload = {
    uiControls: uiControls.sort((left, right) => left.key.localeCompare(right.key)),
    uiInputs: uiInputs.sort((left, right) => left.key.localeCompare(right.key)),
    controlHandlerEdges: controlHandlerEdges.sort((left, right) => {
      return `${left.affordanceKey}::${left.handlerStableId}::${left.eventHandlerName}`
        .localeCompare(`${right.affordanceKey}::${right.handlerStableId}::${right.eventHandlerName}`);
    }),
    inputHandlerEdges: inputHandlerEdges.sort((left, right) => {
      return `${left.affordanceKey}::${left.handlerStableId}::${left.eventHandlerName}`
        .localeCompare(`${right.affordanceKey}::${right.handlerStableId}::${right.eventHandlerName}`);
    }),
  };

  process.stdout.write(JSON.stringify(payload));
}

main();
