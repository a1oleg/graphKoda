import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export type AccessorRole = 'Getter' | 'Setter';

type StorageFact = {
  accessorName?: string;
  callerRepoRelativePath?: string;
  callLine?: number;
  callColumn?: number;
  accessorRepoRelativePath?: string;
  accessorLine?: number;
  accessorColumn?: number;
  accessType?: string;
};

export type AccessorIndex = {
  roleByFunctionStableId: ReadonlyMap<string, AccessorRole>;
  roleForCall: (sourceFile: ts.SourceFile, call: ts.CallExpression | ts.NewExpression) => AccessorRole | undefined;
  roleForExternalAccessor: (name: string | undefined) => AccessorRole | undefined;
};

function loadStorageFacts(): StorageFact[] {
  const factsPath = path.join(projectPaths.dataRoot, 'codeql/results/parameterized-storage-accessor-calls.facts.json');
  if (!fs.existsSync(factsPath)) return [];
  try {
    const payload = JSON.parse(fs.readFileSync(factsPath, 'utf8')) as { rows?: StorageFact[] };
    return payload.rows || [];
  } catch {
    return [];
  }
}

function normalizedPath(value: string | undefined) {
  return String(value || '').replaceAll('\\', '/');
}

function locationKey(repoRelativePath: string, line: number) {
  return `${normalizedPath(repoRelativePath)}:${line}`;
}

function bodyExpression(node: ts.FunctionLikeDeclaration): { mode: 'return' | 'effect'; expression: ts.Expression } | undefined {
  if (!node.body) return undefined;
  if (ts.isExpression(node.body)) return { mode: 'return', expression: node.body };
  if (!ts.isBlock(node.body) || node.body.statements.length !== 1) return undefined;
  const [statement] = node.body.statements;
  if (ts.isReturnStatement(statement) && statement.expression) {
    return { mode: 'return', expression: statement.expression };
  }
  if (ts.isExpressionStatement(statement)) {
    return { mode: 'effect', expression: statement.expression };
  }
  return undefined;
}

function containsControlOrNestedFunction(root: ts.Node) {
  let rejected = false;
  const visit = (node: ts.Node) => {
    if (node !== root && ts.isFunctionLike(node)) {
      rejected = true;
      return;
    }
    if (
      ts.isAwaitExpression(node)
      || ts.isConditionalExpression(node)
      || ts.isBinaryExpression(node) && [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(node.operatorToken.kind)
    ) {
      rejected = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return rejected;
}

function structurallyAllowsRole(node: ts.FunctionLikeDeclaration, role: AccessorRole) {
  const body = bodyExpression(node);
  if (!body || containsControlOrNestedFunction(body.expression)) return false;
  if (role === 'Getter') return body.mode === 'return';
  if (body.mode !== 'effect') return false;
  return ts.isCallExpression(body.expression)
    || ts.isBinaryExpression(body.expression) && body.expression.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && body.expression.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
}

function roleFromAccessTypes(accessTypes: Set<string>): AccessorRole | undefined {
  if (accessTypes.size !== 1) return undefined;
  const [accessType] = accessTypes;
  if (accessType === 'read') return 'Getter';
  if (['create', 'update', 'clear', 'delete', 'write'].includes(accessType)) return 'Setter';
  return undefined;
}

export function buildAccessorIndex(
  program: ts.Program,
  stableIdByDeclaration: ReadonlyMap<ts.Node, string>,
  getRepoRelativePath: (fileName: string) => string,
): AccessorIndex {
  const facts = loadStorageFacts();
  const accessTypesByAccessor = new Map<string, Set<string>>();
  const factsByCallLine = new Map<string, StorageFact[]>();
  const externalAccessTypesByName = new Map<string, Set<string>>();

  for (const fact of facts) {
    const accessorPath = normalizedPath(fact.accessorRepoRelativePath);
    const accessorLine = Number(fact.accessorLine);
    const accessType = String(fact.accessType || '').toLowerCase();
    if (accessorPath && Number.isFinite(accessorLine) && accessorLine > 0 && accessType) {
      const key = locationKey(accessorPath, accessorLine);
      const types = accessTypesByAccessor.get(key) || new Set<string>();
      types.add(accessType);
      accessTypesByAccessor.set(key, types);
    } else if (accessorPath && accessorLine === 0 && accessType) {
      const accessorName = String(fact.accessorName || '').trim();
      if (accessorName) {
        const types = externalAccessTypesByName.get(accessorName) || new Set<string>();
        types.add(accessType);
        externalAccessTypesByName.set(accessorName, types);
      }
    }

    const callerPath = normalizedPath(fact.callerRepoRelativePath);
    const callLine = Number(fact.callLine);
    if (callerPath && Number.isFinite(callLine) && callLine > 0) {
      const key = locationKey(callerPath, callLine);
      factsByCallLine.set(key, [...(factsByCallLine.get(key) || []), fact]);
    }
  }

  const roleByFunctionStableId = new Map<string, AccessorRole>();
  const roleByAccessorLocation = new Map<string, AccessorRole>();
  for (const sourceFile of program.getSourceFiles()) {
    const repoRelativePath = normalizedPath(getRepoRelativePath(sourceFile.fileName));
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node) && node.body) {
        const stableId = stableIdByDeclaration.get(node) || stableIdByDeclaration.get(node.parent);
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        const key = locationKey(repoRelativePath, line);
        const role = roleFromAccessTypes(accessTypesByAccessor.get(key) || new Set());
        if (stableId && role && structurallyAllowsRole(node, role)) {
          roleByFunctionStableId.set(stableId, role);
          roleByAccessorLocation.set(key, role);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return {
    roleByFunctionStableId,
    roleForExternalAccessor(name) {
      return roleFromAccessTypes(externalAccessTypesByName.get(String(name || '').trim()) || new Set());
    },
    roleForCall(sourceFile, call) {
      const repoRelativePath = normalizedPath(getRepoRelativePath(sourceFile.fileName));
      const start = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile));
      const factsOnLine = factsByCallLine.get(locationKey(repoRelativePath, start.line + 1)) || [];
      const matching = factsOnLine.filter((fact) => {
        const column = Number(fact.callColumn);
        return !Number.isFinite(column) || Math.abs(column - (start.character + 1)) <= 2;
      });
      const roles = new Set<AccessorRole>();
      for (const fact of matching) {
        const accessorLine = Number(fact.accessorLine);
        const accessorPath = normalizedPath(fact.accessorRepoRelativePath);
        const role = accessorLine > 0
          ? roleByAccessorLocation.get(locationKey(accessorPath, accessorLine))
          : roleFromAccessTypes(new Set([String(fact.accessType || '').toLowerCase()]));
        if (role) roles.add(role);
      }
      return roles.size === 1 ? [...roles][0] : undefined;
    },
  };
}
import projectPaths from '../../../dev/projectPaths.cjs';
