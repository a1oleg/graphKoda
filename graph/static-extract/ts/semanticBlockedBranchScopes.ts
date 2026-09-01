import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

type BranchScopeRow = {
  decisionId: string;
  decisionKind: 'if' | 'ternary' | 'switch';
  decisionStartLine: number;
  decisionStartColumn: number;
  decisionEndLine: number;
  decisionEndColumn: number;
  branchId: string;
  branchKind: 'then' | 'else' | 'whenTrue' | 'whenFalse' | 'case' | 'default';
  filePath: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  hasReturn: boolean;
  hasThrow: boolean;
  hasBreak: boolean;
  hasContinue: boolean;
  hasTerminator: boolean;
  callNames: string[];
  snippet: string;
};

type ExtractedPayload = {
  branches: BranchScopeRow[];
};

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(scriptPath), '..', '..', '..');
const tsconfigPath = path.join(workspaceRoot, 'tsconfig.json');

const SKIP_PATH_FRAGMENTS = [
  '/node_modules/',
  '/dist/',
  '/build/',
  '/src/lib/gramjs/tl/',
];

function toPosix(filePath: string) {
  return filePath.replace(/\\/g, '/');
}

function isTrackedSourceFile(sourceFile: ts.SourceFile) {
  if (sourceFile.isDeclarationFile) {
    return false;
  }

  const normalized = toPosix(sourceFile.fileName);
  if (!normalized.startsWith(toPosix(path.join(workspaceRoot, 'src')))) {
    return false;
  }

  return !SKIP_PATH_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function getLineAndColumn(sourceFile: ts.SourceFile, position: number) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(position);
  return {
    line: line + 1,
    column: character,
  };
}

function getDecisionId(sourceFile: ts.SourceFile, node: ts.Node) {
  const start = getLineAndColumn(sourceFile, node.getStart(sourceFile));
  const kind = ts.isIfStatement(node)
    ? 'if'
    : ts.isConditionalExpression(node)
      ? 'ternary'
      : ts.isSwitchStatement(node)
        ? 'switch'
        : 'decision';

  return `${toPosix(sourceFile.fileName)}:${start.line}:${start.column}:${kind}`;
}

function getBranchId(sourceFile: ts.SourceFile, node: ts.Node, branchKind: BranchScopeRow['branchKind'], branchNode?: ts.Node) {
  if (branchNode && (branchKind === 'case' || branchKind === 'default')) {
    const start = getLineAndColumn(sourceFile, branchNode.getStart(sourceFile));
    return `${getDecisionId(sourceFile, node)}#${branchKind}:${start.line}:${start.column}`;
  }

  return `${getDecisionId(sourceFile, node)}#${branchKind}`;
}

function normalizeSnippet(text: string) {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function getCallName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }

  if (ts.isElementAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    return expression.expression.text;
  }

  return undefined;
}

function collectBranchFacts(node: ts.Node, sourceFile: ts.SourceFile) {
  const callNames = new Set<string>();
  let hasReturn = false;
  let hasThrow = false;
  let hasBreak = false;
  let hasContinue = false;

  function visit(current: ts.Node): void {
    if (ts.isFunctionLike(current) && current !== node) {
      return;
    }

    if (ts.isReturnStatement(current)) {
      hasReturn = true;
    } else if (ts.isThrowStatement(current)) {
      hasThrow = true;
    } else if (ts.isBreakStatement(current)) {
      hasBreak = true;
    } else if (ts.isContinueStatement(current)) {
      hasContinue = true;
    } else if (ts.isCallExpression(current)) {
      const name = getCallName(current.expression);
      if (name) {
        callNames.add(name);
      }
    }

    ts.forEachChild(current, visit);
  }

  visit(node);

  return {
    callNames: Array.from(callNames).sort(),
    hasReturn,
    hasThrow,
    hasBreak,
    hasContinue,
    hasTerminator: hasReturn || hasThrow || hasBreak || hasContinue,
    snippet: normalizeSnippet(node.getText(sourceFile)),
  };
}

function extractBranchScopes(program: ts.Program) {
  const rows: BranchScopeRow[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile)) {
      continue;
    }

    function visit(node: ts.Node): void {
      if (ts.isIfStatement(node)) {
        const decisionId = getDecisionId(sourceFile, node);
        const decisionStart = getLineAndColumn(sourceFile, node.getStart(sourceFile));
        const decisionEnd = getLineAndColumn(sourceFile, node.getEnd());

        for (const [branchKind, branchNode] of ([
          ['then', node.thenStatement],
          ['else', node.elseStatement],
        ] as const)) {
          if (!branchNode) {
            continue;
          }

          const start = getLineAndColumn(sourceFile, branchNode.getStart(sourceFile));
          const end = getLineAndColumn(sourceFile, branchNode.getEnd());
          const facts = collectBranchFacts(branchNode, sourceFile);

          rows.push({
            decisionId,
            decisionKind: 'if',
            decisionStartLine: decisionStart.line,
            decisionStartColumn: decisionStart.column,
            decisionEndLine: decisionEnd.line,
            decisionEndColumn: decisionEnd.column,
            branchId: getBranchId(sourceFile, node, branchKind, branchNode),
            branchKind,
            filePath: toPosix(sourceFile.fileName),
            startLine: start.line,
            startColumn: start.column,
            endLine: end.line,
            endColumn: end.column,
            hasReturn: facts.hasReturn,
            hasThrow: facts.hasThrow,
            hasBreak: facts.hasBreak,
            hasContinue: facts.hasContinue,
            hasTerminator: facts.hasTerminator,
            callNames: facts.callNames,
            snippet: facts.snippet,
          });
        }
      } else if (ts.isConditionalExpression(node)) {
        const decisionId = getDecisionId(sourceFile, node);
        const decisionStart = getLineAndColumn(sourceFile, node.getStart(sourceFile));
        const decisionEnd = getLineAndColumn(sourceFile, node.getEnd());

        for (const [branchKind, branchNode] of ([
          ['whenTrue', node.whenTrue],
          ['whenFalse', node.whenFalse],
        ] as const)) {
          const start = getLineAndColumn(sourceFile, branchNode.getStart(sourceFile));
          const end = getLineAndColumn(sourceFile, branchNode.getEnd());
          const facts = collectBranchFacts(branchNode, sourceFile);

          rows.push({
            decisionId,
            decisionKind: 'ternary',
            decisionStartLine: decisionStart.line,
            decisionStartColumn: decisionStart.column,
            decisionEndLine: decisionEnd.line,
            decisionEndColumn: decisionEnd.column,
            branchId: getBranchId(sourceFile, node, branchKind, branchNode),
            branchKind,
            filePath: toPosix(sourceFile.fileName),
            startLine: start.line,
            startColumn: start.column,
            endLine: end.line,
            endColumn: end.column,
            hasReturn: facts.hasReturn,
            hasThrow: facts.hasThrow,
            hasBreak: facts.hasBreak,
            hasContinue: facts.hasContinue,
            hasTerminator: facts.hasTerminator,
            callNames: facts.callNames,
            snippet: facts.snippet,
          });
        }
      } else if (ts.isSwitchStatement(node)) {
        const decisionId = getDecisionId(sourceFile, node);
        const decisionStart = getLineAndColumn(sourceFile, node.getStart(sourceFile));
        const decisionEnd = getLineAndColumn(sourceFile, node.getEnd());

        for (const clause of node.caseBlock.clauses) {
          const branchKind = ts.isDefaultClause(clause) ? 'default' : 'case';
          const start = getLineAndColumn(sourceFile, clause.getStart(sourceFile));
          const end = getLineAndColumn(sourceFile, clause.getEnd());
          const facts = collectBranchFacts(clause, sourceFile);

          rows.push({
            decisionId,
            decisionKind: 'switch',
            decisionStartLine: decisionStart.line,
            decisionStartColumn: decisionStart.column,
            decisionEndLine: decisionEnd.line,
            decisionEndColumn: decisionEnd.column,
            branchId: getBranchId(sourceFile, node, branchKind, clause),
            branchKind,
            filePath: toPosix(sourceFile.fileName),
            startLine: start.line,
            startColumn: start.column,
            endLine: end.line,
            endColumn: end.column,
            hasReturn: facts.hasReturn,
            hasThrow: facts.hasThrow,
            hasBreak: facts.hasBreak,
            hasContinue: facts.hasContinue,
            hasTerminator: facts.hasTerminator,
            callNames: facts.callNames,
            snippet: facts.snippet,
          });
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  rows.sort((left, right) => {
    if (left.filePath !== right.filePath) {
      return left.filePath.localeCompare(right.filePath);
    }
    if (left.startLine !== right.startLine) {
      return left.startLine - right.startLine;
    }
    if (left.startColumn !== right.startColumn) {
      return left.startColumn - right.startColumn;
    }
    return left.branchId.localeCompare(right.branchId);
  });

  return rows;
}

function main() {
  const config = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext([config.error], {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => workspaceRoot,
      getNewLine: () => '\n',
    }));
  }

  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, workspaceRoot);
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  });

  const payload: ExtractedPayload = {
    branches: extractBranchScopes(program),
  };

  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

main();