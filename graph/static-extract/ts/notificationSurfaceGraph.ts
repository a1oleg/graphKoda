import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

type NotificationSurfaceEvidenceRow = {
  key: string;
  emitterFilePath: string;
  emitterRepoRelativePath: string;
  emitterName: string;
  emitterStartLine: number;
  emitterStartColumn: number;
  surfaceKind: 'in-app-notification-surface' | 'browser-notification-surface' | 'push-notification-surface';
  notificationTone: 'error' | 'warning' | 'success' | 'info';
  deliveryKind: 'toast-action' | 'browser-notification-api' | 'service-worker-notification-api' | 'service-worker-bridge';
  line: number;
  column: number;
};

type ExtractedPayload = {
  notificationSurfaceEvidence: NotificationSurfaceEvidenceRow[];
};

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = projectPaths.sourceRoot;
const tsconfigPath = path.join(workspaceRoot, 'tsconfig.json');

const SKIP_PATH_FRAGMENTS = [
  '/node_modules/',
  '/dist/',
  '/build/',
  '/src/lib/gramjs/tl/',
];

const PUSH_NOTIFICATION_FILE_SUFFIX = '/src/serviceWorker/pushNotification.ts';
const ERROR_TOKENS = ['error', 'failed', 'invalid', 'inaccessible', 'expired', 'unexpected'];
const WARNING_TOKENS = [
  'warning',
  'premium',
  'required',
  'unsupported',
  'unavailable',
  'floodwait',
  'notallowed',
  'disallow',
  'denied',
  'blocked',
  'restricted',
  'limit',
  'reached',
  'prevented',
  'inactive',
  'missing',
  'notfound',
];
const SUCCESS_TOKENS = [
  'success',
  'successful',
  'successfully',
  'copied',
  'saved',
  'sent',
  'added',
  'updated',
  'set',
  'done',
  'complete',
  'completed',
  'opened',
  'received',
  'logged',
  'transferred',
  'gifted',
  'published',
  'reminder',
  'toast',
];
const EXACT_WARNING_SIGNALS = [
  'nousernamefound',
  'floodwait',
  'privatechannelinaccessible',
  'chatpermissionnotavailable',
  'optionpremiumrequiredmessage',
  'permissionnolocationposition',
  'this voice chat is not active',
  'user does not exist',
  'big live streams are not yet supported',
];
const PREFIX_WARNING_SIGNALS = [
  'limitreached',
  'inviteblocked',
  'actionunsupported',
  'storyunsupported',
  'messageunsupported',
  'channelpermissiondenied',
  'channelpersmissiondenied',
  'senddisallow',
  'attachmenu',
  'conversationdefaultrestricted',
  'unconfirmedauthdenied',
];
const EXACT_SUCCESS_SIGNALS = [
  'datecopiedtoast',
  'linkcopied',
  'textcopied',
  'phonecopied',
  'walletaddresscopied',
  'businesslocationcopied',
  'exacttextcopied',
  'remindersettoast',
  'hidaccount',
];
const PREFIX_SUCCESS_SIGNALS = [
  'botauthsuccess',
  'gifttransfersuccess',
  'actionsuggestedpostsuccess',
  'settingspasscodesuccess',
  'titleagechecksuccess',
  'editadmintransfer',
  'actionpaymentdone',
  'removegiftdescriptionsuccess',
  'giftinfosaved',
  'actionstargiftself',
];
const EXACT_ERROR_SIGNALS = [
  'errorurlexpired',
  'errorfocusinaccessiblemessage',
  'aimessageeditorgenericerror',
  'generalerror',
];
const PREFIX_ERROR_SIGNALS = [
  'error',
  'passkey',
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

function isTrackedPath(filePath: string) {
  const normalized = toPosix(path.resolve(filePath));
  if (!normalized.startsWith(toPosix(path.join(workspaceRoot, 'src')))) {
    return false;
  }

  return !SKIP_PATH_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function isTrackedSourceFile(sourceFile: ts.SourceFile) {
  if (sourceFile.isDeclarationFile) {
    return false;
  }

  return isTrackedPath(sourceFile.fileName);
}

function getLineAndColumn(sourceFile: ts.SourceFile, position: number) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(position);
  return {
    line: line + 1,
    column: character,
  };
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

function getObjectLiteralPropertyStringValue(node: ts.ObjectLiteralExpression, propertyName: string) {
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const name = property.name;
    const matchesName = (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === propertyName;
    if (!matchesName || !ts.isStringLiteral(property.initializer)) {
      continue;
    }
    return property.initializer.text;
  }

  return undefined;
}

function getObjectLiteralPropertyNode(node: ts.ObjectLiteralExpression, propertyName: string) {
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }

    const name = property.name;
    const matchesName = (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === propertyName;
    if (matchesName) {
      return property.initializer;
    }
  }

  return undefined;
}

function normalizeToneSignal(value: string) {
  return value.trim().toLowerCase();
}

function addToneTokensFromText(value: string, tokens: Set<string>) {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');

  normalized
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .forEach((part) => tokens.add(part));
}

function collectToneTokens(node: ts.Node | undefined, sourceFile: ts.SourceFile, tokens: Set<string>) {
  if (!node) {
    return;
  }

  function visit(currentNode: ts.Node): void {
    if (ts.isStringLiteral(currentNode) || ts.isNoSubstitutionTemplateLiteral(currentNode)) {
      addToneTokensFromText(currentNode.text, tokens);
      return;
    }
    if (ts.isIdentifier(currentNode)) {
      addToneTokensFromText(currentNode.text, tokens);
    }
    if (ts.isPropertyAssignment(currentNode)) {
      const name = currentNode.name;
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
        addToneTokensFromText(name.text, tokens);
      }
    }

    ts.forEachChild(currentNode, visit);
  }

  visit(node);
  addToneTokensFromText(node.getText(sourceFile), tokens);
}

function collectRawToneSignals(node: ts.Node | undefined, signals: Set<string>) {
  if (!node) {
    return;
  }

  function visit(currentNode: ts.Node): void {
    if (ts.isStringLiteral(currentNode) || ts.isNoSubstitutionTemplateLiteral(currentNode)) {
      signals.add(normalizeToneSignal(currentNode.text));
      return;
    }

    ts.forEachChild(currentNode, visit);
  }

  visit(node);
}

function hasExactSignal(signals: Set<string>, candidates: string[]) {
  return candidates.some((candidate) => signals.has(candidate));
}

function hasPrefixedSignal(signals: Set<string>, prefixes: string[]) {
  const values = Array.from(signals);
  return prefixes.some((prefix) => values.some((value) => value.startsWith(prefix)));
}

function classifyInAppNotificationTone(node: ts.CallExpression, sourceFile: ts.SourceFile) {
  const [firstArgument] = node.arguments;
  if (!firstArgument || !ts.isObjectLiteralExpression(firstArgument)) {
    return 'info' as const;
  }

  const tokens = new Set<string>();
  const rawSignals = new Set<string>();
  const titleNode = getObjectLiteralPropertyNode(firstArgument, 'title');
  const messageNode = getObjectLiteralPropertyNode(firstArgument, 'message');
  const actionTextNode = getObjectLiteralPropertyNode(firstArgument, 'actionText');
  const classNameNode = getObjectLiteralPropertyNode(firstArgument, 'className');
  const typeNode = getObjectLiteralPropertyNode(firstArgument, 'type');

  collectToneTokens(titleNode, sourceFile, tokens);
  collectToneTokens(messageNode, sourceFile, tokens);
  collectToneTokens(actionTextNode, sourceFile, tokens);
  collectToneTokens(classNameNode, sourceFile, tokens);
  collectToneTokens(typeNode, sourceFile, tokens);
  collectRawToneSignals(titleNode, rawSignals);
  collectRawToneSignals(messageNode, rawSignals);
  collectRawToneSignals(actionTextNode, rawSignals);
  collectRawToneSignals(classNameNode, rawSignals);
  collectRawToneSignals(typeNode, rawSignals);

  const iconValue = getObjectLiteralPropertyStringValue(firstArgument, 'icon');
  if (iconValue) {
    tokens.add(iconValue.toLowerCase());
    rawSignals.add(normalizeToneSignal(iconValue));
  }

  if (getObjectLiteralPropertyStringValue(firstArgument, 'type') === 'paidMessage') {
    tokens.add('paidmessage');
    rawSignals.add('paidmessage');
  }

  if (hasExactSignal(rawSignals, EXACT_SUCCESS_SIGNALS) || hasPrefixedSignal(rawSignals, PREFIX_SUCCESS_SIGNALS)) {
    return 'success' as const;
  }

  if (hasExactSignal(rawSignals, EXACT_WARNING_SIGNALS) || hasPrefixedSignal(rawSignals, PREFIX_WARNING_SIGNALS)) {
    return 'warning' as const;
  }

  if (hasExactSignal(rawSignals, EXACT_ERROR_SIGNALS) || hasPrefixedSignal(rawSignals, PREFIX_ERROR_SIGNALS)) {
    return 'error' as const;
  }

  if (ERROR_TOKENS.some((token) => tokens.has(token))) {
    return 'error' as const;
  }

  if (WARNING_TOKENS.some((token) => tokens.has(token))) {
    return 'warning' as const;
  }

  if (SUCCESS_TOKENS.some((token) => tokens.has(token)) || tokens.has('star') || tokens.has('paidmessage')) {
    return 'success' as const;
  }

  return 'info' as const;
}

function classifyNotificationEvidence(node: ts.Node, sourceFile: ts.SourceFile) {
  const normalizedFilePath = toPosix(path.resolve(sourceFile.fileName));
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Notification') {
    return {
      surfaceKind: 'browser-notification-surface' as const,
      notificationTone: 'info' as const,
      deliveryKind: 'browser-notification-api' as const,
    };
  }

  if (!ts.isCallExpression(node)) {
    return undefined;
  }

  if (
    ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === 'showNotification'
    && node.expression.expression.getText(sourceFile) === 'self.registration'
  ) {
    return {
      surfaceKind: 'push-notification-surface' as const,
      notificationTone: 'info' as const,
      deliveryKind: 'service-worker-notification-api' as const,
    };
  }

  if (ts.isIdentifier(node.expression) && node.expression.text === 'showNotification') {
    if (normalizedFilePath.endsWith(PUSH_NOTIFICATION_FILE_SUFFIX)) {
      return {
        surfaceKind: 'push-notification-surface' as const,
        notificationTone: 'info' as const,
        deliveryKind: 'service-worker-notification-api' as const,
      };
    }

    return {
      surfaceKind: 'in-app-notification-surface' as const,
      notificationTone: classifyInAppNotificationTone(node, sourceFile),
      deliveryKind: 'toast-action' as const,
    };
  }

  if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'showNotification') {
    return {
      surfaceKind: 'in-app-notification-surface' as const,
      notificationTone: classifyInAppNotificationTone(node, sourceFile),
      deliveryKind: 'toast-action' as const,
    };
  }

  if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'postMessage') {
    const [firstArgument] = node.arguments;
    if (firstArgument && ts.isObjectLiteralExpression(firstArgument)) {
      const typeValue = getObjectLiteralPropertyStringValue(firstArgument, 'type');
      if (typeValue === 'showMessageNotification') {
        return {
          surfaceKind: 'push-notification-surface' as const,
          notificationTone: 'info' as const,
          deliveryKind: 'service-worker-bridge' as const,
        };
      }
    }
  }

  return undefined;
}

function extractNotificationSurfaceEvidence(program: ts.Program) {
  const rows: NotificationSurfaceEvidenceRow[] = [];
  const seenKeys = new Set<string>();

  function pushRow(row: NotificationSurfaceEvidenceRow) {
    if (seenKeys.has(row.key)) {
      return;
    }

    seenKeys.add(row.key);
    rows.push(row);
  }

  function scanFunction(node: ts.FunctionLikeDeclaration, sourceFile: ts.SourceFile) {
    if (!node.body) {
      return;
    }

    const emitterFilePath = toPosix(path.resolve(sourceFile.fileName));
    const emitterRepoRelativePath = getRepoRelativePath(emitterFilePath);
    const emitterName = getFunctionName(node);
    const emitterStart = getLineAndColumn(sourceFile, node.getStart(sourceFile));

    function visit(currentNode: ts.Node): void {
      if (currentNode !== node && isFunctionLikeNode(currentNode)) {
        return;
      }

      const evidence = classifyNotificationEvidence(currentNode, sourceFile);
      if (evidence) {
        const start = getLineAndColumn(sourceFile, currentNode.getStart(sourceFile));
        pushRow({
          key: `${emitterFilePath}:${emitterStart.line}:${emitterStart.column}:${evidence.surfaceKind}:${evidence.notificationTone}:${evidence.deliveryKind}:${start.line}:${start.column}`,
          emitterFilePath,
          emitterRepoRelativePath,
          emitterName,
          emitterStartLine: emitterStart.line,
          emitterStartColumn: emitterStart.column,
          surfaceKind: evidence.surfaceKind,
          notificationTone: evidence.notificationTone,
          deliveryKind: evidence.deliveryKind,
          line: start.line,
          column: start.column,
        });
      }

      ts.forEachChild(currentNode, visit);
    }

    visit(node.body);
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile)) {
      continue;
    }

    function visit(node: ts.Node): void {
      if (isFunctionLikeNode(node)) {
        scanFunction(node, sourceFile);
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  rows.sort((left, right) => {
    if (left.emitterFilePath !== right.emitterFilePath) {
      return left.emitterFilePath.localeCompare(right.emitterFilePath);
    }
    if (left.emitterStartLine !== right.emitterStartLine) {
      return left.emitterStartLine - right.emitterStartLine;
    }
    if (left.line !== right.line) {
      return left.line - right.line;
    }
    return left.key.localeCompare(right.key);
  });

  return rows;
}

function main() {
  const program = createProgram();
  const payload: ExtractedPayload = {
    notificationSurfaceEvidence: extractNotificationSurfaceEvidence(program),
  };

  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

main();
import projectPaths from '../../../dev/projectPaths.cjs';
