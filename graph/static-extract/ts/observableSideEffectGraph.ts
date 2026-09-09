import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

type ObservableSideEffectEvidenceRow = {
  key: string;
  emitterFilePath: string;
  emitterRepoRelativePath: string;
  emitterName: string;
  emitterStartLine: number;
  emitterStartColumn: number;
  effectKind: 'notification' | 'modal' | 'dialog' | 'download' | 'sound';
  effectSubkind: string;
  targetName: string;
  line: number;
  column: number;
};

type ExtractedPayload = {
  observableSideEffectEvidence: ObservableSideEffectEvidenceRow[];
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

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }

  return current;
}

function getCallTargetName(expression: ts.Expression) {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) {
    return current.text;
  }
  if (ts.isPropertyAccessExpression(current)) {
    return current.name.text;
  }

  return undefined;
}

function classifyObservableSideEffect(node: ts.Node, sourceFile: ts.SourceFile) {
  const normalizedFilePath = toPosix(path.resolve(sourceFile.fileName));

  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Notification') {
    return {
      effectKind: 'notification' as const,
      effectSubkind: 'browser-notification',
      targetName: 'Notification',
    };
  }

  if (!ts.isCallExpression(node)) {
    return undefined;
  }

  const targetName = getCallTargetName(node.expression);
  if (!targetName) {
    return undefined;
  }

  if (targetName === 'showNotification') {
    if (
      ts.isPropertyAccessExpression(unwrapExpression(node.expression))
      && unwrapExpression(node.expression).name.text === 'showNotification'
      && unwrapExpression(node.expression).expression.getText(sourceFile) === 'self.registration'
    ) {
      return {
        effectKind: 'notification' as const,
        effectSubkind: 'push-notification',
        targetName,
      };
    }

    return {
      effectKind: 'notification' as const,
      effectSubkind: normalizedFilePath.endsWith(PUSH_NOTIFICATION_FILE_SUFFIX) ? 'push-notification' : 'in-app-notification',
      targetName,
    };
  }

  if (targetName === 'playNotificationSound') {
    return {
      effectKind: 'sound' as const,
      effectSubkind: 'notification-sound',
      targetName,
    };
  }

  if (targetName === 'showDialog') {
    return {
      effectKind: 'dialog' as const,
      effectSubkind: 'show-dialog',
      targetName,
    };
  }

  if (targetName === 'downloadMedia' || targetName === 'downloadSelectedMessages' || targetName === 'respondForDownload') {
    return {
      effectKind: 'download' as const,
      effectSubkind: targetName === 'respondForDownload' ? 'service-worker-download' : 'action-download',
      targetName,
    };
  }

  if (/^open[A-Z].*Modal$/.test(targetName)) {
    return {
      effectKind: 'modal' as const,
      effectSubkind: 'action-modal',
      targetName,
    };
  }

  if (/^open[A-Z].*Dialog$/.test(targetName)) {
    return {
      effectKind: 'dialog' as const,
      effectSubkind: 'action-dialog',
      targetName,
    };
  }

  return undefined;
}

function extractObservableSideEffectEvidence(program: ts.Program) {
  const rows: ObservableSideEffectEvidenceRow[] = [];
  const seenKeys = new Set<string>();

  function pushRow(row: ObservableSideEffectEvidenceRow) {
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

      const evidence = classifyObservableSideEffect(currentNode, sourceFile);
      if (evidence) {
        const start = getLineAndColumn(sourceFile, currentNode.getStart(sourceFile));
        pushRow({
          key: `${emitterFilePath}:${emitterStart.line}:${emitterStart.column}:${evidence.effectKind}:${evidence.effectSubkind}:${evidence.targetName}:${start.line}:${start.column}`,
          emitterFilePath,
          emitterRepoRelativePath,
          emitterName,
          emitterStartLine: emitterStart.line,
          emitterStartColumn: emitterStart.column,
          effectKind: evidence.effectKind,
          effectSubkind: evidence.effectSubkind,
          targetName: evidence.targetName,
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
    observableSideEffectEvidence: extractObservableSideEffectEvidence(program),
  };

  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

main();
import projectPaths from '../../../dev/projectPaths.cjs';
