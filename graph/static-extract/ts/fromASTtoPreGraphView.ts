import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { buildStableIdFromCoordinates } from '../../packages/runtime-core/src/stableId.js';

type ViewSurfaceRow = {
  key: string;
  parentSurfaceKey?: string;
  ownerStableId: string;
  ownerName: string;
  ownerFilePath: string;
  ownerRepoRelativePath: string;
  ownerStartLine: number;
  ownerStartColumn: number;
  ownerEndLine: number;
  ownerEndColumn: number;
  ownerKind: 'component' | 'render-helper' | 'class-render-method';
  surfaceKind: string;
  jsxRootCount: number;
  interactiveDescendantCount: number;
  childComponentCount: number;
};

type ViewInteractiveDescendantRow = {
  key: string;
  surfaceKey: string;
  ownerStableId: string;
  elementName: string;
  elementKind: 'intrinsic' | 'component';
  descendantKinds: string[];
  primaryDescendantKind: string;
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

type ViewComponentDescendantRow = {
  key: string;
  surfaceKey: string;
  ownerStableId: string;
  elementName: string;
  tagPath: string;
  depth: number;
  line: number;
  column: number;
  targetStableId: string;
  targetName?: string;
};

type ViewSurfaceTypeRefRow = {
  key: string;
  surfaceKey: string;
  ownerStableId: string;
  typeKey: string;
  typeName: string;
  useCount: number;
};

type ViewSurfaceOwnedTypeRefRow = {
  key: string;
  surfaceKey: string;
  ownerStableId: string;
  evidenceKind: 'prop-field' | 'callback-param';
  fieldName: string;
  typeKey: string;
  typeName: string;
  useCount: number;
};

type ViewSurfaceHostSlotRow = {
  key: string;
  surfaceKey: string;
  ownerStableId: string;
  hostSelector: string;
  tagPath: string;
  line: number;
  column: number;
};

type ViewSurfacePortalUsageRow = {
  key: string;
  surfaceKey: string;
  ownerStableId: string;
  hostSelector: string;
  tagPath: string;
  line: number;
  column: number;
};

type ViewSurfaceContainmentEdgeRow = {
  parentSurfaceKey: string;
  childSurfaceKey: string;
  via: 'nested' | 'component' | 'effective' | 'explorer';
  evidenceCount: number;
  maxDepth: number;
  jsxMinLine?: number;
  jsxMinColumn?: number;
  candidateParentCount?: number;
  sampleTagPaths: string[];
  sampleElementNames: string[];
  sampleTargetNames: string[];
};

type UiExplorerTopBlockRow = {
  key: string;
  title: string;
  region: string;
  description: string;
  rootSurfaceKey?: string;
  sortOrder: number;
};

type UiExplorerTopBlockSurfaceEdgeRow = {
  blockKey: string;
  surfaceKey: string;
  role: 'root' | 'node';
  sortOrder: number;
  layoutPlacement?: string;
  layoutSummary?: string;
};

type ExtractedPayload = {
  viewSurfaces: ViewSurfaceRow[];
  interactiveDescendants: ViewInteractiveDescendantRow[];
  componentDescendants: ViewComponentDescendantRow[];
  surfaceTypeRefs: ViewSurfaceTypeRefRow[];
  surfaceOwnedTypeRefs: ViewSurfaceOwnedTypeRefRow[];
  surfaceHostSlots: ViewSurfaceHostSlotRow[];
  surfacePortalUsages: ViewSurfacePortalUsageRow[];
  surfaceNestedEdges: ViewSurfaceContainmentEdgeRow[];
  surfaceContainmentEdges: ViewSurfaceContainmentEdgeRow[];
  surfaceEffectiveEdges: ViewSurfaceContainmentEdgeRow[];
  surfaceExplorerEdges: ViewSurfaceContainmentEdgeRow[];
  topBlocks: UiExplorerTopBlockRow[];
  topBlockSurfaceEdges: UiExplorerTopBlockSurfaceEdgeRow[];
};

type ResolvedSurfaceTarget = {
  stableId: string;
  declaration?: ts.FunctionLikeDeclaration;
  targetName?: string;
};

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = projectPaths.sourceRoot;
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

const TRACKED_TYPE_DIRS = [
  'src/api/types/',
  'src/global/types/',
  'src/types/',
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
  [/(^|)(Input|Textarea|Search|Select|Picker|Slider|Seek|Range)$/i, ['input']],
  [/(^|)(Checkbox|Radio|Switch|Toggle)$/i, ['toggle']],
  [/(^|)(Menu|Dropdown|Popover|Tooltip|Dialog|Modal)$/i, ['menu']],
];

const CUSTOM_COMPONENT_DESCENDANT_KIND_PATTERNS: Array<[RegExp, string[]]> = [
  [/(^|)(Button|Chip|Action|Trigger)$/i, ['button']],
  [/(^|)(Link|Anchor|Breadcrumb|Nav|Navigation|Tab|Tabs)$/i, ['navigational-link']],
  [/(^|)(Form)$/i, ['form']],
  [/(^|)(Input|Textarea|Search|Select|Picker|Slider|Seek|Range|Field)$/i, ['form-control']],
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

function getFunctionName(node: ts.FunctionLikeDeclaration) {
  if ('name' in node && node.name) {
    if (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name)) {
      return node.name.text;
    }
    if (ts.isStringLiteral(node.name) || ts.isNumericLiteral(node.name)) {
      return node.name.text;
    }
  }

  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (parent && ts.isPropertyAssignment(parent)) {
    if (ts.isIdentifier(parent.name) || ts.isPrivateIdentifier(parent.name)) {
      return parent.name.text;
    }
    if (ts.isStringLiteral(parent.name) || ts.isNumericLiteral(parent.name)) {
      return parent.name.text;
    }
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

function isJsxLikeExpression(node: ts.Expression | undefined): node is ts.Expression {
  if (!node) {
    return false;
  }

  const current = unwrapJsxExpression(node);
  return ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current) || ts.isJsxFragment(current);
}

function collectReturnedExpressions(node: ts.FunctionLikeDeclaration) {
  const expressions: ts.Expression[] = [];

  if (node.body && ts.isBlock(node.body)) {
    function visit(current: ts.Node): void {
      if (current !== node.body && isFunctionLikeNode(current)) {
        return;
      }
      if (ts.isReturnStatement(current) && current.expression) {
        expressions.push(current.expression);
        return;
      }
      ts.forEachChild(current, visit);
    }

    visit(node.body);
  } else if (node.body && ts.isExpression(node.body)) {
    expressions.push(node.body);
  }

  return expressions;
}

function getLineAndColumn(sourceFile: ts.SourceFile, position: number) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(position);
  return {
    line: line + 1,
    column: character,
  };
}

function getStableId(sourceFile: ts.SourceFile, node: ts.Node) {
  const start = getLineAndColumn(sourceFile, node.getStart(sourceFile));
  const end = getLineAndColumn(sourceFile, node.getEnd());
  return buildStableIdFromCoordinates({
    filePath: toPosix(path.resolve(sourceFile.fileName)),
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  });
}

function getParentSurfaceKey(
  sourceFile: ts.SourceFile,
  stableIdByDeclaration: Map<ts.Node, string>,
  node: ts.FunctionLikeDeclaration,
) {
  let current = node.parent;

  while (current) {
    if (isFunctionLikeNode(current)) {
      return stableIdByDeclaration.get(current) || getStableId(sourceFile, current);
    }

    current = current.parent;
  }

  return undefined;
}

function tokenize(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function getOwnerKind(node: ts.FunctionLikeDeclaration, ownerName: string): ViewSurfaceRow['ownerKind'] {
  if (ts.isMethodDeclaration(node) && ownerName === 'render') {
    return 'class-render-method';
  }

  return /^[A-Z]/.test(ownerName) ? 'component' : 'render-helper';
}

function isRenderHelperName(name: string) {
  return /^render[A-Z_]/u.test(name) || name === 'renderTextWithEntities';
}

function detectSurfaceKind(ownerName: string, repoRelativePath: string, ownerKind: ViewSurfaceRow['ownerKind']) {
  const tokens = new Set([...tokenize(ownerName), ...tokenize(repoRelativePath)]);
  if (tokens.has('modal') || tokens.has('dialog')) {
    return 'modal-view-surface';
  }
  if (tokens.has('viewer') || tokens.has('preview') || tokens.has('story')) {
    return 'viewer-view-surface';
  }
  if (tokens.has('menu') || tokens.has('picker') || tokens.has('tooltip') || tokens.has('popover')) {
    return 'overlay-view-surface';
  }
  if (tokens.has('settings') || tokens.has('panel') || tokens.has('sidebar') || tokens.has('column')) {
    return 'panel-view-surface';
  }
  if (ownerKind === 'class-render-method') {
    return 'class-render-view-surface';
  }
  if (ownerKind === 'render-helper') {
    return 'render-helper-view-surface';
  }

  return 'component-view-surface';
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

function isIntrinsicTagName(tagName: string) {
  return /^[a-z]/.test(tagName);
}

function isPortalComponentTagName(checker: ts.TypeChecker, tagName: ts.JsxTagNameExpression) {
  const symbol = checker.getSymbolAtLocation(tagName);
  const resolved = symbol && ((symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol);
  for (const declaration of resolved?.declarations ?? []) {
    const repoRelativePath = getRepoRelativePath(declaration.getSourceFile().fileName);
    if (repoRelativePath === 'src/components/ui/Portal.ts') {
      return true;
    }
  }

  return false;
}

function getPortalContainerSelector(node: ts.JsxOpeningLikeElement) {
  for (const attribute of node.attributes.properties) {
    const attributeName = getAttributeName(attribute);
    if (attributeName !== 'containerSelector') {
      continue;
    }

    return getStringLikeAttributeValue(attribute) || '#portals';
  }

  return '#portals';
}

function getStableIdForSurfaceDeclaration(
  stableIdByDeclaration: Map<ts.Node, string>,
  declaration: ts.Node | undefined,
) {
  if (!declaration) {
    return undefined;
  }

  return stableIdByDeclaration.get(declaration)
    || stableIdByDeclaration.get(declaration.parent);
}

function getStaticStringLiteralText(expression: ts.Expression | undefined) {
  if (!expression) {
    return undefined;
  }

  const current = unwrapJsxExpression(expression);
  if (ts.isStringLiteralLike(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
    return current.text;
  }

  return undefined;
}

function getModuleLoaderBundleName(expression: ts.Expression | undefined) {
  if (!expression) {
    return undefined;
  }

  const current = unwrapJsxExpression(expression);
  if (ts.isPropertyAccessExpression(current) && ts.isIdentifier(current.expression)) {
    return current.name.text;
  }

  if (ts.isElementAccessExpression(current)) {
    return getStaticStringLiteralText(current.argumentExpression);
  }

  if (ts.isIdentifier(current)) {
    return current.text;
  }

  return undefined;
}

function getBundleModuleTargetKey(bundleName: string, moduleName: string) {
  return `${bundleName}::${moduleName}`;
}

function resolveSurfaceTargetFromModuleLoaderCall(
  bundleModuleSurfaceTargets: ReadonlyMap<string, ResolvedSurfaceTarget>,
  callExpression: ts.CallExpression,
) {
  const callee = unwrapJsxExpression(callExpression.expression);
  if (!ts.isIdentifier(callee) || callee.text !== 'useModuleLoader') {
    return undefined;
  }

  const bundleName = getModuleLoaderBundleName(callExpression.arguments[0]);
  const moduleName = getStaticStringLiteralText(callExpression.arguments[1]);
  if (!bundleName || !moduleName) {
    return undefined;
  }

  return bundleModuleSurfaceTargets.get(getBundleModuleTargetKey(bundleName, moduleName));
}

function resolveSurfaceTargetFromExpression(
  checker: ts.TypeChecker,
  stableIdByDeclaration: Map<ts.Node, string>,
  bundleModuleSurfaceTargets: ReadonlyMap<string, ResolvedSurfaceTarget>,
  expression: ts.Expression,
  visitedDeclarations = new Set<ts.Node>(),
): ResolvedSurfaceTarget | undefined {
  const current = unwrapJsxExpression(expression);

  if (ts.isIdentifier(current) || ts.isPropertyAccessExpression(current)) {
    const symbol = checker.getSymbolAtLocation(current);
    const resolved = symbol && ((symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol);
    for (const declaration of resolved?.declarations ?? []) {
      const target = resolveSurfaceTargetFromDeclaration(
        checker,
        stableIdByDeclaration,
        bundleModuleSurfaceTargets,
        declaration,
        visitedDeclarations,
      );
      if (target) {
        return target;
      }
    }

    return undefined;
  }

  if (ts.isCallExpression(current)) {
    const moduleLoaderTarget = resolveSurfaceTargetFromModuleLoaderCall(bundleModuleSurfaceTargets, current);
    if (moduleLoaderTarget) {
      return moduleLoaderTarget;
    }

    for (const argument of current.arguments) {
      const target = resolveSurfaceTargetFromExpression(
        checker,
        stableIdByDeclaration,
        bundleModuleSurfaceTargets,
        argument,
        visitedDeclarations,
      );
      if (target) {
        return target;
      }
    }

    return resolveSurfaceTargetFromExpression(
      checker,
      stableIdByDeclaration,
      bundleModuleSurfaceTargets,
      current.expression,
      visitedDeclarations,
    );
  }

  return undefined;
}

function resolveSurfaceTargetFromDeclaration(
  checker: ts.TypeChecker,
  stableIdByDeclaration: Map<ts.Node, string>,
  bundleModuleSurfaceTargets: ReadonlyMap<string, ResolvedSurfaceTarget>,
  declaration: ts.Node,
  visitedDeclarations = new Set<ts.Node>(),
): ResolvedSurfaceTarget | undefined {
  if (visitedDeclarations.has(declaration)) {
    return undefined;
  }

  visitedDeclarations.add(declaration);

  const stableId = getStableIdForSurfaceDeclaration(stableIdByDeclaration, declaration);
  if (stableId) {
    return {
      stableId,
      declaration: isFunctionLikeNode(declaration)
        ? declaration
        : ts.isVariableDeclaration(declaration) && declaration.initializer && isFunctionLikeNode(declaration.initializer)
          ? declaration.initializer
          : undefined,
      targetName: 'name' in declaration && declaration.name && ts.isIdentifier(declaration.name)
        ? declaration.name.text
        : undefined,
    };
  }

  if (ts.isExportAssignment(declaration)) {
    return resolveSurfaceTargetFromExpression(
      checker,
      stableIdByDeclaration,
      bundleModuleSurfaceTargets,
      declaration.expression,
      visitedDeclarations,
    );
  }

  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    return resolveSurfaceTargetFromExpression(
      checker,
      stableIdByDeclaration,
      bundleModuleSurfaceTargets,
      declaration.initializer,
      visitedDeclarations,
    );
  }

  return undefined;
}

function buildBundleModuleSurfaceTargets(
  program: ts.Program,
  checker: ts.TypeChecker,
  stableIdByDeclaration: Map<ts.Node, string>,
) {
  const targets = new Map<string, ResolvedSurfaceTarget>();

  for (const sourceFile of program.getSourceFiles()) {
    const repoRelativePath = getRepoRelativePath(sourceFile.fileName);
    if (!repoRelativePath.startsWith('src/bundles/') || !repoRelativePath.endsWith('.ts')) {
      continue;
    }

    const bundleName = path.parse(sourceFile.fileName).name;
    const bundleEnumName = bundleName.charAt(0).toUpperCase() + bundleName.slice(1);

    function visit(current: ts.Node): void {
      if (ts.isExportDeclaration(current)
        && current.moduleSpecifier
        && current.exportClause
        && ts.isNamedExports(current.exportClause)) {
        const moduleSymbol = checker.getSymbolAtLocation(current.moduleSpecifier);
        const resolvedModuleSymbol = moduleSymbol && ((moduleSymbol.flags & ts.SymbolFlags.Alias)
          ? checker.getAliasedSymbol(moduleSymbol)
          : moduleSymbol);
        if (!resolvedModuleSymbol) {
          ts.forEachChild(current, visit);
          return;
        }

        const exportSymbolsByName = new Map(
          checker.getExportsOfModule(resolvedModuleSymbol).map((symbol) => [symbol.getName(), symbol]),
        );

        for (const element of current.exportClause.elements) {
          const exportedName = element.name.text;
          const importedName = element.propertyName?.text || exportedName;
          const exportSymbol = exportSymbolsByName.get(importedName);
          const resolvedExportSymbol = exportSymbol && ((exportSymbol.flags & ts.SymbolFlags.Alias)
            ? checker.getAliasedSymbol(exportSymbol)
            : exportSymbol);
          if (!resolvedExportSymbol) {
            continue;
          }

          for (const declaration of resolvedExportSymbol.declarations ?? []) {
            const target = resolveSurfaceTargetFromDeclaration(
              checker,
              stableIdByDeclaration,
              new Map<string, ResolvedSurfaceTarget>(),
              declaration,
            );
            if (!target) {
              continue;
            }

            targets.set(getBundleModuleTargetKey(bundleEnumName, exportedName), {
              ...target,
              targetName: exportedName,
            });
            break;
          }
        }
      }

      ts.forEachChild(current, visit);
    }

    visit(sourceFile);
  }

  return targets;
}

function resolveTargetSurface(
  checker: ts.TypeChecker,
  stableIdByDeclaration: Map<ts.Node, string>,
  bundleModuleSurfaceTargets: ReadonlyMap<string, ResolvedSurfaceTarget>,
  tagName: ts.JsxTagNameExpression,
) {
  if (!ts.isIdentifier(tagName) && !ts.isPropertyAccessExpression(tagName)) {
    return undefined;
  }

  const symbol = checker.getSymbolAtLocation(tagName);
  const resolved = symbol && ((symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol);
  for (const declaration of resolved?.declarations ?? []) {
    const target = resolveSurfaceTargetFromDeclaration(
      checker,
      stableIdByDeclaration,
      bundleModuleSurfaceTargets,
      declaration,
    );
    if (target) {
      return {
        ...target,
        targetName: target.targetName || resolved?.getName(),
      };
    }
  }

  return undefined;
}

function resolveTargetStableId(
  checker: ts.TypeChecker,
  stableIdByDeclaration: Map<ts.Node, string>,
  bundleModuleSurfaceTargets: ReadonlyMap<string, ResolvedSurfaceTarget>,
  tagName: ts.JsxTagNameExpression,
) {
  const target = resolveTargetSurface(checker, stableIdByDeclaration, bundleModuleSurfaceTargets, tagName);
  if (!target) {
    return undefined;
  }

  return {
    stableId: target.stableId,
    targetName: target.targetName,
  };
}

function resolveFunctionLikeDeclarationFromExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): ts.FunctionLikeDeclaration | undefined {
  const current = unwrapJsxExpression(expression);
  if (!ts.isIdentifier(current) && !ts.isPropertyAccessExpression(current)) {
    return undefined;
  }

  const symbol = checker.getSymbolAtLocation(current);
  const resolved = symbol && ((symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol);
  for (const declaration of resolved?.declarations ?? []) {
    if (isFunctionLikeNode(declaration)) {
      return declaration;
    }

    if (ts.isVariableDeclaration(declaration)
      && declaration.initializer
      && isFunctionLikeNode(declaration.initializer)) {
      return declaration.initializer;
    }
  }

  return undefined;
}

function resolveDeclarationFromExpression(checker: ts.TypeChecker, expression: ts.Expression) {
  const current = unwrapJsxExpression(expression);
  if (!ts.isIdentifier(current) && !ts.isPropertyAccessExpression(current)) {
    return undefined;
  }

  const symbol = checker.getSymbolAtLocation(current);
  const resolved = symbol && ((symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol);
  return resolved?.declarations?.[0];
}

function getRenderableExpressionsFromDeclaration(declaration: ts.Declaration | undefined) {
  if (!declaration) {
    return [];
  }

  if (ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isExpression(declaration.initializer)) {
    return [declaration.initializer];
  }

  if (isFunctionLikeNode(declaration)) {
    return collectReturnedExpressions(declaration);
  }

  return [];
}

function extractRenderableJsxNodes(
  checker: ts.TypeChecker,
  stableIdByDeclaration: Map<ts.Node, string>,
  bundleModuleSurfaceTargets: ReadonlyMap<string, ResolvedSurfaceTarget>,
  expression: ts.Expression,
  visitedTargetStableIds = new Set<string>(),
): Array<ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment> {
  const jsxNodes: Array<ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment> = [];
  const seenNodes = new Set<ts.Node>();
  const visitedRenderHelperDeclarations = new Set<ts.Node>();

  function visit(current: ts.Node | undefined): void {
    if (!current) {
      return;
    }

    let effectiveNode = current;
    if (ts.isExpression(effectiveNode)) {
      effectiveNode = unwrapJsxExpression(effectiveNode);
    }

    if (seenNodes.has(effectiveNode)) {
      return;
    }
    seenNodes.add(effectiveNode);

    if (ts.isIdentifier(effectiveNode) || ts.isPropertyAccessExpression(effectiveNode)) {
      const declaration = resolveDeclarationFromExpression(checker, effectiveNode);
      for (const declarationExpression of getRenderableExpressionsFromDeclaration(declaration)) {
        visit(declarationExpression);
      }
    }

    if (ts.isJsxElement(effectiveNode) || ts.isJsxSelfClosingElement(effectiveNode) || ts.isJsxFragment(effectiveNode)) {
      jsxNodes.push(effectiveNode);
      return;
    }

    if (ts.isCallExpression(effectiveNode)) {
      const target = resolveTargetSurface(
        checker,
        stableIdByDeclaration,
        bundleModuleSurfaceTargets,
        effectiveNode.expression,
      );
      if (target?.declaration && !visitedTargetStableIds.has(target.stableId)) {
        visitedTargetStableIds.add(target.stableId);
        for (const returnedExpression of collectReturnedExpressions(target.declaration)) {
          visit(returnedExpression);
        }
      }

      const renderHelperDeclaration = resolveFunctionLikeDeclarationFromExpression(checker, effectiveNode.expression);
      if (renderHelperDeclaration && !visitedRenderHelperDeclarations.has(renderHelperDeclaration)) {
        visitedRenderHelperDeclarations.add(renderHelperDeclaration);
        for (const returnedExpression of collectReturnedExpressions(renderHelperDeclaration)) {
          visit(returnedExpression);
        }
      }
    }

    ts.forEachChild(effectiveNode, visit);
  }

  visit(expression);

  return jsxNodes;
}

function collectCalledSurfaceTargets(
  checker: ts.TypeChecker,
  stableIdByDeclaration: Map<ts.Node, string>,
  bundleModuleSurfaceTargets: ReadonlyMap<string, ResolvedSurfaceTarget>,
  expression: ts.Expression,
) {
  const rows: Array<{ target: ResolvedSurfaceTarget; node: ts.CallExpression }> = [];
  const seenNodes = new Set<ts.Node>();

  function visit(current: ts.Node | undefined): void {
    if (!current) {
      return;
    }

    let effectiveNode = current;
    if (ts.isExpression(effectiveNode)) {
      effectiveNode = unwrapJsxExpression(effectiveNode);
    }

    if (seenNodes.has(effectiveNode)) {
      return;
    }
    seenNodes.add(effectiveNode);

    if (ts.isIdentifier(effectiveNode) || ts.isPropertyAccessExpression(effectiveNode)) {
      const declaration = resolveDeclarationFromExpression(checker, effectiveNode);
      for (const declarationExpression of getRenderableExpressionsFromDeclaration(declaration)) {
        visit(declarationExpression);
      }
    }

    if (ts.isCallExpression(effectiveNode)) {
      const target = resolveTargetSurface(
        checker,
        stableIdByDeclaration,
        bundleModuleSurfaceTargets,
        effectiveNode.expression,
      );
      if (target && isRenderHelperName(target.targetName || '')) {
        rows.push({ target, node: effectiveNode });
      }
    }

    ts.forEachChild(effectiveNode, visit);
  }

  visit(expression);

  return rows;
}

function collectReturnedJsxRoots(
  checker: ts.TypeChecker,
  stableIdByDeclaration: Map<ts.Node, string>,
  bundleModuleSurfaceTargets: ReadonlyMap<string, ResolvedSurfaceTarget>,
  node: ts.FunctionLikeDeclaration,
) {
  const roots: Array<ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment> = [];
  const seenRoots = new Set<ts.Node>();

  for (const expression of collectReturnedExpressions(node)) {
    for (const jsxNode of extractRenderableJsxNodes(checker, stableIdByDeclaration, bundleModuleSurfaceTargets, expression)) {
      if (seenRoots.has(jsxNode)) {
        continue;
      }

      seenRoots.add(jsxNode);
      roots.push(jsxNode);
    }
  }

  return roots;
}

function classifyInteractiveElement(
  checker: ts.TypeChecker,
  stableIdByDeclaration: Map<ts.Node, string>,
  bundleModuleSurfaceTargets: ReadonlyMap<string, ResolvedSurfaceTarget>,
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
    ? resolveTargetStableId(checker, stableIdByDeclaration, bundleModuleSurfaceTargets, node.tagName)
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

function buildViewDescendantBaseKey(
  surfaceKey: string,
  tagPath: string,
  interaction: ReturnType<typeof classifyInteractiveElement>,
) {
  const eventHandlerKey = [...interaction.eventHandlerNames].sort().join('+') || 'no-handler';
  const roleKey = [...interaction.roleValues].sort().join('+') || 'no-role';
  const targetKey = interaction.targetName || interaction.targetStableId || 'no-target';

  return [
    surfaceKey,
    tagPath,
    interaction.elementName,
    interaction.primaryDescendantKind,
    eventHandlerKey,
    roleKey,
    targetKey,
  ].join('::');
}

function buildViewComponentBaseKey(
  surfaceKey: string,
  tagPath: string,
  elementName: string,
  targetStableId: string,
) {
  return `${surfaceKey}::component::${tagPath}::${elementName}::${targetStableId}`;
}

function buildViewHostSlotBaseKey(surfaceKey: string, hostSelector: string, tagPath: string) {
  return `${surfaceKey}::host-slot::${hostSelector}::${tagPath}`;
}

function buildViewPortalUsageBaseKey(surfaceKey: string, hostSelector: string, tagPath: string) {
  return `${surfaceKey}::portal-usage::${hostSelector}::${tagPath}`;
}

function buildSurfaceNestedEdges(viewSurfaces: ViewSurfaceRow[]): ViewSurfaceContainmentEdgeRow[] {
  const surfaceKeys = new Set(viewSurfaces.map((row) => row.key).filter(Boolean));
  const seen = new Set<string>();
  const rows: ViewSurfaceContainmentEdgeRow[] = [];

  for (const row of viewSurfaces) {
    const parentSurfaceKey = row.parentSurfaceKey || '';
    const childSurfaceKey = row.key;
    if (!parentSurfaceKey || !childSurfaceKey || parentSurfaceKey === childSurfaceKey || !surfaceKeys.has(parentSurfaceKey)) {
      continue;
    }

    const edgeKey = `${parentSurfaceKey}::${childSurfaceKey}`;
    if (seen.has(edgeKey)) {
      continue;
    }
    seen.add(edgeKey);
    rows.push({
      parentSurfaceKey,
      childSurfaceKey,
      via: 'nested',
      evidenceCount: 1,
      maxDepth: 0,
      sampleTagPaths: [],
      sampleElementNames: [],
      sampleTargetNames: [],
    });
  }

  return rows;
}

function appendSample(values: string[], value: string | undefined) {
  if (value && !values.includes(value) && values.length < 5) {
    values.push(value);
  }
}

function buildSurfaceContainmentEdges(
  componentDescendants: ViewComponentDescendantRow[],
  viewSurfaces: ViewSurfaceRow[],
): ViewSurfaceContainmentEdgeRow[] {
  const surfaceKeys = new Set(viewSurfaces.map((row) => row.key).filter(Boolean));
  const rowsByKey = new Map<string, ViewSurfaceContainmentEdgeRow>();

  for (const row of componentDescendants) {
    const parentSurfaceKey = row.surfaceKey;
    const childSurfaceKey = row.targetStableId;
    if (!parentSurfaceKey || !childSurfaceKey || parentSurfaceKey === childSurfaceKey || !surfaceKeys.has(childSurfaceKey)) {
      continue;
    }

    const edgeKey = `${parentSurfaceKey}::${childSurfaceKey}`;
    let edge = rowsByKey.get(edgeKey);
    if (!edge) {
      edge = {
        parentSurfaceKey,
        childSurfaceKey,
        via: 'component',
        evidenceCount: 0,
        maxDepth: 0,
        jsxMinLine: row.line,
        jsxMinColumn: row.column,
        sampleTagPaths: [],
        sampleElementNames: [],
        sampleTargetNames: [],
      };
      rowsByKey.set(edgeKey, edge);
    }

    edge.evidenceCount += 1;
    edge.maxDepth = Math.max(edge.maxDepth, row.depth || 0);
    if (!edge.jsxMinLine || row.line < edge.jsxMinLine || (row.line === edge.jsxMinLine && row.column < (edge.jsxMinColumn || 0))) {
      edge.jsxMinLine = row.line;
      edge.jsxMinColumn = row.column;
    }
    appendSample(edge.sampleTagPaths, row.tagPath);
    appendSample(edge.sampleElementNames, row.elementName);
    appendSample(edge.sampleTargetNames, row.targetName);
  }

  return [...rowsByKey.values()].sort((left, right) => {
    return right.evidenceCount - left.evidenceCount
      || right.maxDepth - left.maxDepth
      || left.parentSurfaceKey.localeCompare(right.parentSurfaceKey)
      || left.childSurfaceKey.localeCompare(right.childSurfaceKey);
  });
}

function buildSurfaceEffectiveEdges(
  componentEdges: ViewSurfaceContainmentEdgeRow[],
  nestedEdges: ViewSurfaceContainmentEdgeRow[],
): ViewSurfaceContainmentEdgeRow[] {
  const rows: ViewSurfaceContainmentEdgeRow[] = [];
  const seen = new Set<string>();

  for (const sourceRows of [componentEdges, nestedEdges]) {
    for (const row of sourceRows) {
      const edgeKey = `${row.parentSurfaceKey}::${row.childSurfaceKey}`;
      if (seen.has(edgeKey)) {
        continue;
      }
      seen.add(edgeKey);
      rows.push({
        ...row,
        via: 'effective',
      });
    }
  }

  return rows;
}

function buildSurfaceExplorerEdges(
  effectiveEdges: ViewSurfaceContainmentEdgeRow[],
  viewSurfaces: ViewSurfaceRow[],
): ViewSurfaceContainmentEdgeRow[] {
  const surfaceByKey = new Map(viewSurfaces.map((row) => [row.key, row]));
  const candidatesByChild = new Map<string, ViewSurfaceContainmentEdgeRow[]>();

  function parentScore(row: ViewSurfaceContainmentEdgeRow) {
    const parent = surfaceByKey.get(row.parentSurfaceKey);
    const ownerKind = parent?.ownerKind || '';
    const parentPath = parent?.ownerRepoRelativePath || '';
    const parentName = parent?.ownerName || '';
    const ownerScore = ownerKind === 'render-helper' ? 2 : 0;
    const uiPrimitiveScore = parentPath.startsWith('src/components/ui/') ? 1 : 0;
    const line = row.jsxMinLine || 999999;
    return [ownerScore, uiPrimitiveScore, line, parentName] as const;
  }

  function compareParentScore(left: ViewSurfaceContainmentEdgeRow, right: ViewSurfaceContainmentEdgeRow) {
    const leftScore = parentScore(left);
    const rightScore = parentScore(right);
    for (let index = 0; index < leftScore.length; index += 1) {
      const leftValue = leftScore[index];
      const rightValue = rightScore[index];
      if (leftValue === rightValue) {
        continue;
      }
      return typeof leftValue === 'number' && typeof rightValue === 'number'
        ? leftValue - rightValue
        : String(leftValue).localeCompare(String(rightValue));
    }
    return left.parentSurfaceKey.localeCompare(right.parentSurfaceKey);
  }

  for (const row of effectiveEdges) {
    if (!row.parentSurfaceKey || !row.childSurfaceKey || row.parentSurfaceKey === row.childSurfaceKey) {
      continue;
    }
    if (!surfaceByKey.has(row.parentSurfaceKey) || !surfaceByKey.has(row.childSurfaceKey)) {
      continue;
    }
    const candidates = candidatesByChild.get(row.childSurfaceKey) || [];
    candidates.push(row);
    candidatesByChild.set(row.childSurfaceKey, candidates);
  }

  const rows: ViewSurfaceContainmentEdgeRow[] = [];
  for (const candidates of candidatesByChild.values()) {
    const nestedCandidates = candidates.filter((candidate) => candidate.via === 'nested');
    const renderHelperCandidates = candidates.filter((candidate) => {
      return surfaceByKey.get(candidate.parentSurfaceKey)?.ownerKind === 'render-helper';
    });
    const selectedCandidates = nestedCandidates.length
      ? nestedCandidates
      : renderHelperCandidates.length
        ? renderHelperCandidates
        : candidates;

    for (const selected of selectedCandidates.sort(compareParentScore)) {
      rows.push({
        ...selected,
        via: 'explorer',
        candidateParentCount: candidates.length,
      });
    }
  }

  return rows.sort((left, right) => left.parentSurfaceKey.localeCompare(right.parentSurfaceKey)
    || left.childSurfaceKey.localeCompare(right.childSurfaceKey));
}

function uniqueStrings(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function stripKnownSourceExtension(repoRelativePath: string) {
  return repoRelativePath.replace(/\.(?:tsx|ts|jsx|js)$/u, '');
}

function buildStyleCandidatePaths(surface: ViewSurfaceRow, edge?: ViewSurfaceContainmentEdgeRow) {
  const repoRelativePath = String(surface.ownerRepoRelativePath || '').replace(/\\/g, '/');
  if (!repoRelativePath) {
    return [];
  }

  const withoutExtension = stripKnownSourceExtension(repoRelativePath);
  const withoutAsync = withoutExtension.replace(/\.async$/u, '');
  const directory = path.posix.dirname(withoutExtension);
  const names = uniqueStrings([
    path.posix.basename(withoutExtension),
    path.posix.basename(withoutAsync),
    ...(edge?.sampleElementNames || []),
    String(surface.ownerName || '').replace(/Async$/u, ''),
  ]);
  const bases = uniqueStrings([
    withoutExtension,
    withoutAsync,
    ...names.map((name) => path.posix.join(directory, name)),
  ]);

  return uniqueStrings(bases.flatMap((base) => [`${base}.module.scss`, `${base}.scss`]))
    .map((candidate) => path.join(workspaceRoot, candidate));
}

function readFirstExistingStyle(surface: ViewSurfaceRow, edge?: ViewSurfaceContainmentEdgeRow) {
  for (const candidate of buildStyleCandidatePaths(surface, edge)) {
    if (fs.existsSync(candidate)) {
      return {
        repoRelativePath: path.relative(workspaceRoot, candidate).replace(/\\/g, '/'),
        content: fs.readFileSync(candidate, 'utf8'),
      };
    }
  }

  return undefined;
}

function escapeRegExp(value: string) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function extractSelectorBlock(content: string, selector: string) {
  const match = new RegExp(`${escapeRegExp(selector)}\\s*\\{`, 'u').exec(content);
  if (!match) {
    return undefined;
  }

  let depth = 0;
  for (let index = match.index + match[0].length - 1; index < content.length; index += 1) {
    if (content[index] === '{') {
      depth += 1;
    } else if (content[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return content.slice(match.index, index + 1);
      }
    }
  }

  return undefined;
}

function extractRelevantStyleBlock(surface: ViewSurfaceRow, edge: ViewSurfaceContainmentEdgeRow | undefined, content: string) {
  const selectorNames = uniqueStrings([
    ...(edge?.sampleElementNames || []),
    String(surface.ownerName || '').replace(/Async$/u, ''),
  ]);
  const blocks = [
    extractSelectorBlock(content, '.root'),
    ...selectorNames.map((name) => extractSelectorBlock(content, `#${name}`)),
  ].filter(Boolean);

  return blocks.length ? blocks.join('\n') : content;
}

function readLayoutEvidence(surface: ViewSurfaceRow, edge?: ViewSurfaceContainmentEdgeRow) {
  const style = readFirstExistingStyle(surface, edge);
  if (!style) {
    return {
      placement: 'unclassified',
      summary: 'No adjacent SCSS layout evidence found.',
    };
  }

  const relevant = extractRelevantStyleBlock(surface, edge, style.content);
  const hasFixed = /\bposition\s*:\s*fixed\b/u.test(relevant);
  const hasAbsolute = /\bposition\s*:\s*absolute\b/u.test(relevant);
  const hasInsetZero = /\binset\s*:\s*0\b/u.test(relevant);
  const hasTopZero = /\btop\s*:\s*0\b/u.test(relevant);
  const hasRightZero = /\bright\s*:\s*0\b/u.test(relevant);
  const hasBottomZero = /\bbottom\s*:\s*0\b/u.test(relevant);
  const hasLeftZero = /\bleft\s*:\s*0\b/u.test(relevant);
  const hasBottom = /\bbottom\s*:/u.test(relevant);
  const hasModalLayout = /\.modal(?:-|_|\b)|\.modal-dialog\b|\.modal-content\b/u.test(relevant);
  const zIndex = /\bz-index\s*:\s*([^;]+);/u.exec(relevant)?.[1]?.trim();
  const position = /\bposition\s*:\s*([^;]+);/u.exec(relevant)?.[1]?.trim();
  const isFullScreen = hasInsetZero || (hasTopZero && hasRightZero && hasBottomZero && hasLeftZero);

  let placement = 'unclassified';
  if (hasFixed && /overlay-effects|confetti/u.test(zIndex || relevant)) {
    placement = 'fixed-effects';
  } else if (hasFixed && isFullScreen) {
    placement = 'fixed-top';
  } else if (hasModalLayout) {
    placement = 'modal';
  } else if (hasAbsolute && hasBottom) {
    placement = 'bottom-absolute';
  } else if (hasFixed) {
    placement = 'fixed';
  } else if (hasAbsolute) {
    placement = 'absolute';
  }

  const coordinates = [
    hasInsetZero ? 'inset:0' : undefined,
    hasTopZero ? 'top:0' : undefined,
    hasRightZero ? 'right:0' : undefined,
    hasBottomZero ? 'bottom:0' : undefined,
    hasLeftZero ? 'left:0' : undefined,
  ].filter(Boolean).join(', ');

  return {
    placement,
    summary: [
      style.repoRelativePath,
      position ? `position:${position}` : undefined,
      zIndex ? `z:${zIndex}` : undefined,
      coordinates || undefined,
    ].filter(Boolean).join(' | '),
  };
}

function buildUiExplorerTopBlocks(
  viewSurfaces: ViewSurfaceRow[],
  surfaceExplorerEdges: ViewSurfaceContainmentEdgeRow[],
) {
  const surfaceByKey = new Map(viewSurfaces.map((row) => [row.key, row]));
  const rootByName = new Map(viewSurfaces
    .filter((surface) => surface.ownerName === 'App' || surface.ownerName === 'Main')
    .map((surface) => [surface.ownerName, surface]));
  const appRoot = rootByName.get('App');
  const mainRoot = rootByName.get('Main');
  const childrenByParent = new Map<string, ViewSurfaceContainmentEdgeRow[]>();

  for (const edge of surfaceExplorerEdges) {
    const rows = childrenByParent.get(edge.parentSurfaceKey) || [];
    rows.push(edge);
    childrenByParent.set(edge.parentSurfaceKey, rows);
  }

  const sortEdges = (edges: ViewSurfaceContainmentEdgeRow[]) => [...edges].sort((left, right) => {
    return (left.jsxMinLine || 999999) - (right.jsxMinLine || 999999)
      || (left.jsxMinColumn || 999999) - (right.jsxMinColumn || 999999)
      || (surfaceByKey.get(left.childSurfaceKey)?.ownerName || '').localeCompare(surfaceByKey.get(right.childSurfaceKey)?.ownerName || '')
      || left.childSurfaceKey.localeCompare(right.childSurfaceKey);
  });
  const appChildren = appRoot ? sortEdges(childrenByParent.get(appRoot.key) || []) : [];
  const mainChildren = mainRoot ? sortEdges(childrenByParent.get(mainRoot.key) || []) : [];
  const directMainChildren = mainChildren.filter((edge) => {
    return edge.maxDepth === 3 || (edge.sampleTagPaths || []).some((tagPath) => /^root\[0\]>div\[0\]>[^>]+$/u.test(tagPath));
  });
  const shellChildren = directMainChildren.slice(0, 4);
  const overlayChildren = directMainChildren.slice(4);
  const overlayGroups = {
    top: [] as ViewSurfaceContainmentEdgeRow[],
    bottom: [] as ViewSurfaceContainmentEdgeRow[],
    modal: [] as ViewSurfaceContainmentEdgeRow[],
    effects: [] as ViewSurfaceContainmentEdgeRow[],
    other: [] as ViewSurfaceContainmentEdgeRow[],
  };

  for (const edge of overlayChildren) {
    const child = surfaceByKey.get(edge.childSurfaceKey);
    const layout = child ? readLayoutEvidence(child, edge) : { placement: 'unclassified', summary: '' };
    if (layout.placement === 'fixed-top' || layout.placement === 'fixed') {
      overlayGroups.top.push(edge);
    } else if (layout.placement === 'fixed-effects') {
      overlayGroups.effects.push(edge);
    } else if (layout.placement === 'modal') {
      overlayGroups.modal.push(edge);
    } else if (layout.placement === 'bottom-absolute' || layout.placement === 'absolute') {
      overlayGroups.bottom.push(edge);
    } else {
      overlayGroups.other.push(edge);
    }
  }

  const topBlocks: UiExplorerTopBlockRow[] = [];
  const topBlockSurfaceEdges: UiExplorerTopBlockSurfaceEdgeRow[] = [];

  function addBlock(row: UiExplorerTopBlockRow, edges: ViewSurfaceContainmentEdgeRow[]) {
    if (!row.rootSurfaceKey && !edges.length) {
      return;
    }
    topBlocks.push(row);
    if (row.rootSurfaceKey) {
      topBlockSurfaceEdges.push({
        blockKey: row.key,
        surfaceKey: row.rootSurfaceKey,
        role: 'root',
        sortOrder: -1,
      });
    }
    edges.forEach((edge, index) => {
      const child = surfaceByKey.get(edge.childSurfaceKey);
      const layout = child ? readLayoutEvidence(child, edge) : undefined;
      topBlockSurfaceEdges.push({
        blockKey: row.key,
        surfaceKey: edge.childSurfaceKey,
        role: 'node',
        sortOrder: index,
        layoutPlacement: layout?.placement,
        layoutSummary: layout?.summary,
      });
    });
  }

  addBlock({
    key: 'app-shell',
    title: 'App Shell',
    region: 'app',
    description: 'Top application shell surfaces from App JSX children.',
    rootSurfaceKey: appRoot?.key,
    sortOrder: 0,
  }, appChildren);
  addBlock({
    key: 'main-left',
    title: 'Main Left Area',
    region: 'left',
    description: 'First grid slots under #Main, derived from JSX order.',
    rootSurfaceKey: mainRoot?.key,
    sortOrder: 1,
  }, shellChildren.slice(0, 2));
  addBlock({
    key: 'main-center',
    title: 'Main Center Area',
    region: 'middle',
    description: 'Next grid slot under #Main, derived from JSX order.',
    rootSurfaceKey: mainRoot?.key,
    sortOrder: 2,
  }, shellChildren.slice(2, 3));
  addBlock({
    key: 'main-right',
    title: 'Main Right Area',
    region: 'right',
    description: 'Next grid slot under #Main, derived from JSX order.',
    rootSurfaceKey: mainRoot?.key,
    sortOrder: 3,
  }, shellChildren.slice(3, 4));
  addBlock({
    key: 'main-top-overlays',
    title: 'Main Top Overlays',
    region: 'topOverlay',
    description: 'Fixed full-screen #Main children from extracted SCSS layout evidence.',
    rootSurfaceKey: mainRoot?.key,
    sortOrder: 4,
  }, overlayGroups.top);
  addBlock({
    key: 'main-bottom-overlays',
    title: 'Main Bottom Overlays',
    region: 'bottomOverlay',
    description: 'Absolute bottom #Main children from extracted SCSS layout evidence.',
    rootSurfaceKey: mainRoot?.key,
    sortOrder: 5,
  }, overlayGroups.bottom);
  addBlock({
    key: 'main-modal-overlays',
    title: 'Main Modal Layer',
    region: 'modalOverlay',
    description: 'Modal/Dialog #Main children from extracted SCSS layout evidence.',
    rootSurfaceKey: mainRoot?.key,
    sortOrder: 6,
  }, overlayGroups.modal);
  addBlock({
    key: 'main-effects-overlays',
    title: 'Main Effect Layer',
    region: 'effectOverlay',
    description: 'Fixed visual-effect #Main children from extracted SCSS z-index evidence.',
    rootSurfaceKey: mainRoot?.key,
    sortOrder: 7,
  }, overlayGroups.effects);
  addBlock({
    key: 'main-other-overlays',
    title: 'Main Other Overlays',
    region: 'main',
    description: 'Direct #Main overlay children without resolved positioning evidence.',
    rootSurfaceKey: mainRoot?.key,
    sortOrder: 8,
  }, overlayGroups.other);

  return {
    topBlocks,
    topBlockSurfaceEdges,
  };
}


function collectInteractiveDescendants(
  checker: ts.TypeChecker,
  stableIdByDeclaration: Map<ts.Node, string>,
  bundleModuleSurfaceTargets: ReadonlyMap<string, ResolvedSurfaceTarget>,
  sourceFile: ts.SourceFile,
  surfaceKey: string,
  ownerStableId: string,
  jsxRoots: ts.Expression[],
) {
  const rows: ViewInteractiveDescendantRow[] = [];
  const componentRows: ViewComponentDescendantRow[] = [];
  const hostSlotRows: ViewSurfaceHostSlotRow[] = [];
  const portalUsageRows: ViewSurfacePortalUsageRow[] = [];
  const seenKeys = new Set<string>();
  const seenComponentKeys = new Set<string>();
  const seenHostSlotKeys = new Set<string>();
  const seenPortalUsageKeys = new Set<string>();
  const descendantOccurrenceByBaseKey = new Map<string, number>();
  const componentOccurrenceByBaseKey = new Map<string, number>();
  const hostSlotOccurrenceByBaseKey = new Map<string, number>();
  const portalUsageOccurrenceByBaseKey = new Map<string, number>();
  const childComponentStableIds = new Set<string>();

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
    const position = getLineAndColumn(sourceFile, opening.getStart(sourceFile));

    if (isIntrinsicTagName(elementName)) {
      for (const attribute of opening.attributes.properties) {
        const attributeName = getAttributeName(attribute);
        const attributeValue = attributeName === 'id' ? getStringLikeAttributeValue(attribute) : undefined;
        if (!attributeValue) {
          continue;
        }

        const hostSelector = `#${attributeValue}`;
        const hostSlotBaseKey = buildViewHostSlotBaseKey(surfaceKey, hostSelector, tagPath);
        const hostSlotOccurrence = hostSlotOccurrenceByBaseKey.get(hostSlotBaseKey) || 0;
        const hostSlotKey = `${hostSlotBaseKey}::occurrence[${hostSlotOccurrence}]`;
        if (!seenHostSlotKeys.has(hostSlotKey)) {
          hostSlotRows.push({
            key: hostSlotKey,
            surfaceKey,
            ownerStableId,
            hostSelector,
            tagPath,
            line: position.line,
            column: position.column,
          });
          hostSlotOccurrenceByBaseKey.set(hostSlotBaseKey, hostSlotOccurrence + 1);
          seenHostSlotKeys.add(hostSlotKey);
        }
      }
    } else if (isPortalComponentTagName(checker, opening.tagName)) {
      const hostSelector = getPortalContainerSelector(opening);
      const portalUsageBaseKey = buildViewPortalUsageBaseKey(surfaceKey, hostSelector, tagPath);
      const portalUsageOccurrence = portalUsageOccurrenceByBaseKey.get(portalUsageBaseKey) || 0;
      const portalUsageKey = `${portalUsageBaseKey}::occurrence[${portalUsageOccurrence}]`;
      if (!seenPortalUsageKeys.has(portalUsageKey)) {
        portalUsageRows.push({
          key: portalUsageKey,
          surfaceKey,
          ownerStableId,
          hostSelector,
          tagPath,
          line: position.line,
          column: position.column,
        });
        portalUsageOccurrenceByBaseKey.set(portalUsageBaseKey, portalUsageOccurrence + 1);
        seenPortalUsageKeys.add(portalUsageKey);
      }
    }

    const componentTarget = !isIntrinsicTagName(elementName)
      ? resolveTargetStableId(checker, stableIdByDeclaration, bundleModuleSurfaceTargets, opening.tagName)
      : undefined;
    if (componentTarget?.stableId) {
      const componentBaseKey = buildViewComponentBaseKey(surfaceKey, tagPath, elementName, componentTarget.stableId);
      const componentOccurrence = componentOccurrenceByBaseKey.get(componentBaseKey) || 0;
      const componentKey = `${componentBaseKey}::occurrence[${componentOccurrence}]`;
      if (!seenComponentKeys.has(componentKey)) {
        componentRows.push({
          key: componentKey,
          surfaceKey,
          ownerStableId,
          elementName,
          tagPath,
          depth: currentPathSegments.length,
          line: position.line,
          column: position.column,
          targetStableId: componentTarget.stableId,
          targetName: componentTarget.targetName,
        });
        componentOccurrenceByBaseKey.set(componentBaseKey, componentOccurrence + 1);
        seenComponentKeys.add(componentKey);
      }
      childComponentStableIds.add(componentTarget.stableId);
    }

    const interaction = classifyInteractiveElement(checker, stableIdByDeclaration, bundleModuleSurfaceTargets, opening);
    if (interaction) {
      const descendantBaseKey = buildViewDescendantBaseKey(surfaceKey, tagPath, interaction);
      const descendantOccurrence = descendantOccurrenceByBaseKey.get(descendantBaseKey) || 0;
      const key = `${descendantBaseKey}::occurrence[${descendantOccurrence}]`;
      if (!seenKeys.has(key)) {
        rows.push({
          key,
          surfaceKey,
          ownerStableId,
          elementName: interaction.elementName,
          elementKind: interaction.elementKind,
          descendantKinds: interaction.descendantKinds,
          primaryDescendantKind: interaction.primaryDescendantKind,
          interactionKinds: interaction.interactionKinds,
          eventHandlerNames: interaction.eventHandlerNames,
          roleValues: interaction.roleValues,
          tagPath,
          depth: currentPathSegments.length,
          line: position.line,
          column: position.column,
          targetStableId: interaction.targetStableId,
          targetName: interaction.targetName,
        });
        descendantOccurrenceByBaseKey.set(descendantBaseKey, descendantOccurrence + 1);
        seenKeys.add(key);
      }
    }

    if (ts.isJsxElement(node)) {
      visitJsxChildren(node.children, currentPathSegments);
    }
  }

  function recordComponentSurfaceTarget(
    target: ResolvedSurfaceTarget,
    elementName: string,
    tagPath: string,
    position: { line: number; column: number },
  ) {
    if (!target.stableId || target.stableId === surfaceKey) {
      return;
    }

    const componentBaseKey = buildViewComponentBaseKey(surfaceKey, tagPath, elementName, target.stableId);
    const componentOccurrence = componentOccurrenceByBaseKey.get(componentBaseKey) || 0;
    const componentKey = `${componentBaseKey}::occurrence[${componentOccurrence}]`;
    if (seenComponentKeys.has(componentKey)) {
      return;
    }

    componentRows.push({
      key: componentKey,
      surfaceKey,
      ownerStableId,
      elementName,
      tagPath,
      depth: tagPath.split('>').length,
      line: position.line,
      column: position.column,
      targetStableId: target.stableId,
      targetName: target.targetName,
    });
    componentOccurrenceByBaseKey.set(componentBaseKey, componentOccurrence + 1);
    seenComponentKeys.add(componentKey);
    childComponentStableIds.add(target.stableId);
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
        for (const { target, node } of collectCalledSurfaceTargets(
          checker,
          stableIdByDeclaration,
          bundleModuleSurfaceTargets,
          child.expression,
        )) {
          const position = getLineAndColumn(sourceFile, node.getStart(sourceFile));
          const elementName = target.targetName || node.expression.getText(sourceFile);
          const tagPath = [...pathSegments, `${elementName}Call[${position.line}:${position.column}]`].join('>');
          recordComponentSurfaceTarget(target, elementName, tagPath, position);
        }
        const nestedNodes = extractRenderableJsxNodes(
          checker,
          stableIdByDeclaration,
          bundleModuleSurfaceTargets,
          child.expression,
        );
        for (const nestedNode of nestedNodes) {
          visitChildNode(nestedNode);
        }
        continue;
      }

      visitChildNode(child);
    }
  }

  jsxRoots.forEach((root, index) => {
    const rootNodes = extractRenderableJsxNodes(checker, stableIdByDeclaration, bundleModuleSurfaceTargets, root);
    rootNodes.forEach((jsxNode, rootIndex) => {
      visitJsxNode(jsxNode, [`root[${index + rootIndex}]`]);
    });
  });

  return {
    rows,
    componentRows,
    hostSlotRows,
    portalUsageRows,
    childComponentCount: childComponentStableIds.size,
  };
}

function collectSurfaceTypeRefs(
  checker: ts.TypeChecker,
  declarationByNode: Map<ts.Node, string>,
  sourceFile: ts.SourceFile,
  node: ts.FunctionLikeDeclaration,
  surfaceKey: string,
  ownerStableId: string,
) {
  const rows: ViewSurfaceTypeRefRow[] = [];
  const counts = new Map<string, { typeName: string; useCount: number }>();

  function visit(current: ts.Node): void {
    if (current !== node && isFunctionLikeNode(current)) {
      return;
    }

    if (ts.isTypeReferenceNode(current)) {
      const symbol = checker.getSymbolAtLocation(current.typeName);
      const resolved = symbol && ((symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol);
      for (const declaration of resolved?.declarations ?? []) {
        const typeKey = declarationByNode.get(declaration);
        if (!typeKey) {
          continue;
        }
        const existing = counts.get(typeKey);
        const typeName = current.typeName.getText(sourceFile).split('.').at(-1) || typeKey;
        if (existing) {
          existing.useCount += 1;
        } else {
          counts.set(typeKey, { typeName, useCount: 1 });
        }
      }
    }

    ts.forEachChild(current, visit);
  }

  visit(node);

  for (const [typeKey, data] of counts.entries()) {
    rows.push({
      key: `${surfaceKey}::type::${typeKey}`,
      surfaceKey,
      ownerStableId,
      typeKey,
      typeName: data.typeName,
      useCount: data.useCount,
    });
  }

  return rows;
}

function collectTrackedTypeRefsFromType(
  checker: ts.TypeChecker,
  declarationByNode: Map<ts.Node, string>,
  type: ts.Type,
  seen = new Set<string>(),
) {
  const rows: Array<{ typeKey: string; typeName: string }> = [];

  function visit(currentType: ts.Type) {
    const typeId = String((currentType as { id?: number }).id ?? checker.typeToString(currentType));
    if (seen.has(typeId)) {
      return;
    }
    seen.add(typeId);

    const symbol = currentType.aliasSymbol || currentType.getSymbol();
    const resolved = symbol && ((symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol);
    let matched = false;
    for (const declaration of resolved?.declarations ?? []) {
      const typeKey = declarationByNode.get(declaration);
      if (!typeKey) {
        continue;
      }
      matched = true;
      rows.push({
        typeKey,
        typeName: resolved?.getName() || checker.typeToString(currentType),
      });
    }
    if (matched) {
      return;
    }

    if (currentType.isUnionOrIntersection()) {
      currentType.types.forEach(visit);
      return;
    }

    for (const typeArgument of checker.getTypeArguments(currentType as ts.TypeReference)) {
      visit(typeArgument);
    }
  }

  visit(type);

  const deduped = new Map<string, { typeKey: string; typeName: string }>();
  rows.forEach((row) => {
    if (!deduped.has(row.typeKey)) {
      deduped.set(row.typeKey, row);
    }
  });

  return [...deduped.values()];
}

function collectSurfaceOwnedTypeRefs(
  checker: ts.TypeChecker,
  declarationByNode: Map<ts.Node, string>,
  node: ts.FunctionLikeDeclaration,
  surfaceKey: string,
  ownerStableId: string,
) {
  const rows: ViewSurfaceOwnedTypeRefRow[] = [];
  const counts = new Map<string, ViewSurfaceOwnedTypeRefRow>();

  function getOwnerPropsType() {
    const propsParameter = node.parameters[0];
    if (!propsParameter) {
      return undefined;
    }

    const parameterType = checker.getTypeAtLocation(propsParameter);
    if (parameterType.getProperties().length) {
      return parameterType;
    }

    const signature = checker.getSignatureFromDeclaration(node);
    const signatureParameter = signature?.getParameters()?.[0];
    if (signatureParameter) {
      const signatureType = checker.getTypeOfSymbolAtLocation(signatureParameter, node);
      if (signatureType.getProperties().length) {
        return signatureType;
      }
    }

    const contextualType = checker.getContextualType(node as ts.Expression);
    const contextualSignature = contextualType?.getCallSignatures()?.[0];
    const contextualParameter = contextualSignature?.getParameters()?.[0];
    if (contextualParameter) {
      const contextualParameterType = checker.getTypeOfSymbolAtLocation(contextualParameter, node);
      if (contextualParameterType.getProperties().length) {
        return contextualParameterType;
      }
    }

    return parameterType;
  }

  function addEvidence(
    evidenceKind: ViewSurfaceOwnedTypeRefRow['evidenceKind'],
    fieldName: string,
    typeKey: string,
    typeName: string,
  ) {
    const key = `${surfaceKey}::owned-type::${evidenceKind}::${fieldName}::${typeKey}`;
    const existing = counts.get(key);
    if (existing) {
      existing.useCount += 1;
      return;
    }

    counts.set(key, {
      key,
      surfaceKey,
      ownerStableId,
      evidenceKind,
      fieldName,
      typeKey,
      typeName,
      useCount: 1,
    });
  }

  const propsParameter = node.parameters[0];
  const propsType = getOwnerPropsType();
  if (propsParameter && propsType) {
    for (const prop of propsType.getProperties()) {
      const propType = checker.getTypeOfSymbolAtLocation(prop, propsParameter);
      for (const ref of collectTrackedTypeRefsFromType(checker, declarationByNode, propType)) {
        addEvidence('prop-field', prop.getName(), ref.typeKey, ref.typeName);
      }
    }
  }

  function visit(current: ts.Node): void {
    if (current !== node && isFunctionLikeNode(current)) {
      for (const parameter of current.parameters) {
        if (!parameter.type) {
          continue;
        }
        const paramType = checker.getTypeAtLocation(parameter);
        const fieldName = ts.isIdentifier(parameter.name) ? parameter.name.text : parameter.name.getText();
        for (const ref of collectTrackedTypeRefsFromType(checker, declarationByNode, paramType)) {
          addEvidence('callback-param', fieldName, ref.typeKey, ref.typeName);
        }
      }
      return;
    }

    ts.forEachChild(current, visit);
  }

  if (node.body) {
    visit(node.body);
  }

  counts.forEach((row) => rows.push(row));
  return rows;
}

function main() {
  const program = createProgram();
  const checker = program.getTypeChecker();
  const stableIdByDeclaration = new Map<ts.Node, string>();
  const exportedTypeKeyByDeclaration = new Map<ts.Node, string>();

  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile) && !TRACKED_TYPE_DIRS.some((prefix) => getRepoRelativePath(path.resolve(sourceFile.fileName)).startsWith(prefix))) {
      continue;
    }

    const repoRelativePath = getRepoRelativePath(path.resolve(sourceFile.fileName));
    for (const statement of sourceFile.statements) {
      const hasExport = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
      if (!hasExport) {
        continue;
      }
      const name = ('name' in statement && statement.name && (ts.isIdentifier(statement.name) || ts.isStringLiteral(statement.name)))
        ? statement.name.text
        : undefined;
      if (!name) {
        continue;
      }
      if (!TRACKED_TYPE_DIRS.some((prefix) => repoRelativePath.startsWith(prefix))) {
        continue;
      }
      exportedTypeKeyByDeclaration.set(statement, `${repoRelativePath}::${name}`);
    }
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile)) {
      continue;
    }

    function register(current: ts.Node): void {
      if (isFunctionLikeNode(current)) {
        stableIdByDeclaration.set(current, getStableId(sourceFile, current));
        if (current.parent && ts.isVariableDeclaration(current.parent)) {
          stableIdByDeclaration.set(current.parent, getStableId(sourceFile, current));
        }
      }

      ts.forEachChild(current, register);
    }

    register(sourceFile);
  }

  const bundleModuleSurfaceTargets = buildBundleModuleSurfaceTargets(program, checker, stableIdByDeclaration);

  const viewSurfaces: ViewSurfaceRow[] = [];
  const interactiveDescendants: ViewInteractiveDescendantRow[] = [];
  const componentDescendants: ViewComponentDescendantRow[] = [];
  const surfaceTypeRefs: ViewSurfaceTypeRefRow[] = [];
  const surfaceOwnedTypeRefs: ViewSurfaceOwnedTypeRefRow[] = [];
  const surfaceHostSlots: ViewSurfaceHostSlotRow[] = [];
  const surfacePortalUsages: ViewSurfacePortalUsageRow[] = [];

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

        const jsxRoots = collectReturnedJsxRoots(checker, stableIdByDeclaration, bundleModuleSurfaceTargets, current);
        if (!jsxRoots.length) {
          ts.forEachChild(current, visit);
          return;
        }

        const ownerStableId = getStableId(sourceFile, current);
        const parentSurfaceKey = getParentSurfaceKey(sourceFile, stableIdByDeclaration, current);
        const start = getLineAndColumn(sourceFile, current.getStart(sourceFile));
        const end = getLineAndColumn(sourceFile, current.getEnd());
        const ownerKind = getOwnerKind(current, ownerName);
        const surfaceKey = ownerStableId;
        const descendantData = collectInteractiveDescendants(
          checker,
          stableIdByDeclaration,
          bundleModuleSurfaceTargets,
          sourceFile,
          surfaceKey,
          ownerStableId,
          jsxRoots,
        );

        viewSurfaces.push({
          key: surfaceKey,
          parentSurfaceKey,
          ownerStableId,
          ownerName,
          ownerFilePath,
          ownerRepoRelativePath,
          ownerStartLine: start.line,
          ownerStartColumn: start.column,
          ownerEndLine: end.line,
          ownerEndColumn: end.column,
          ownerKind,
          surfaceKind: detectSurfaceKind(ownerName, ownerRepoRelativePath, ownerKind),
          jsxRootCount: jsxRoots.length,
          interactiveDescendantCount: descendantData.rows.length,
          childComponentCount: descendantData.childComponentCount,
        });
        interactiveDescendants.push(...descendantData.rows);
        componentDescendants.push(...descendantData.componentRows);
        surfaceHostSlots.push(...descendantData.hostSlotRows);
        surfacePortalUsages.push(...descendantData.portalUsageRows);
        surfaceTypeRefs.push(...collectSurfaceTypeRefs(checker, exportedTypeKeyByDeclaration, sourceFile, current, surfaceKey, ownerStableId));
        surfaceOwnedTypeRefs.push(...collectSurfaceOwnedTypeRefs(checker, exportedTypeKeyByDeclaration, current, surfaceKey, ownerStableId));
      }

      ts.forEachChild(current, visit);
    }

    visit(sourceFile);
  }

  const surfaceNestedEdges = buildSurfaceNestedEdges(viewSurfaces);
  const surfaceContainmentEdges = buildSurfaceContainmentEdges(componentDescendants, viewSurfaces);
  const surfaceEffectiveEdges = buildSurfaceEffectiveEdges(surfaceContainmentEdges, surfaceNestedEdges);
  const surfaceExplorerEdges = buildSurfaceExplorerEdges(surfaceEffectiveEdges, viewSurfaces);
  const topBlockPayload = buildUiExplorerTopBlocks(viewSurfaces, surfaceExplorerEdges);

  const payload: ExtractedPayload = {
    viewSurfaces: viewSurfaces.sort((left, right) => left.key.localeCompare(right.key)),
    interactiveDescendants: interactiveDescendants.sort((left, right) => left.key.localeCompare(right.key)),
    componentDescendants: componentDescendants.sort((left, right) => left.key.localeCompare(right.key)),
    surfaceTypeRefs: surfaceTypeRefs.sort((left, right) => left.key.localeCompare(right.key)),
    surfaceOwnedTypeRefs: surfaceOwnedTypeRefs.sort((left, right) => left.key.localeCompare(right.key)),
    surfaceHostSlots: surfaceHostSlots.sort((left, right) => left.key.localeCompare(right.key)),
    surfacePortalUsages: surfacePortalUsages.sort((left, right) => left.key.localeCompare(right.key)),
    surfaceNestedEdges,
    surfaceContainmentEdges,
    surfaceEffectiveEdges,
    surfaceExplorerEdges,
    topBlocks: topBlockPayload.topBlocks,
    topBlockSurfaceEdges: topBlockPayload.topBlockSurfaceEdges,
  };

  process.stdout.write(JSON.stringify(payload));
}

main();
import projectPaths from '../../../dev/projectPaths.cjs';
