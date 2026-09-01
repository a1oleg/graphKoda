import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import {
  createProgram,
  getExtendedStableId,
  getRepoRelativePath,
  getStableId,
  isTrackedSourceFile,
} from './functionFlowGraph.infrastructure.js';

type BoundaryDefinition = {
  kind: 'function-entry' | 'call-site' | 'step-text';
  calleeText?: string;
  text?: string;
};

type PhaseDefinition = {
  key: string;
  label: string;
  phaseKind: string;
  featureKey: string;
  order?: number;
  direction?: string;
  ownerFunction: {
    stableId: string;
    name?: string;
    repoRelativePath?: string;
  };
  head: BoundaryDefinition;
  tail: BoundaryDefinition;
};

type PhaseDefinitionsPayload = {
  phases: PhaseDefinition[];
};

type BoundaryRow = {
  role: 'head' | 'tail';
  stableId: string;
  calleeText: string;
  actionText: string;
  repoRelativePath: string;
};

type PhaseRow = {
  key: string;
  label: string;
  phaseKind: string;
  featureKey: string;
  order: number | null;
  direction: string;
  ownerFnStableId: string;
  ownerFnName: string | null;
  ownerRepoRelativePath: string | null;
  headStepStableId: string;
  tailStepStableId: string;
  boundaries: BoundaryRow[];
};

function parseArgs() {
  const args = process.argv.slice(2);
  const result: { definitionsPath: string; outputPath?: string } = {
    definitionsPath: path.resolve(process.cwd(), 'graph', 'phases.json'),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--definitions-path') {
      result.definitionsPath = path.resolve(process.cwd(), args[index + 1] || '');
      index += 1;
    } else if (arg === '--output-path') {
      result.outputPath = path.resolve(process.cwd(), args[index + 1] || '');
      index += 1;
    }
  }

  return result;
}

function readDefinitions(definitionsPath: string): PhaseDefinitionsPayload {
  return JSON.parse(fs.readFileSync(definitionsPath, 'utf8')) as PhaseDefinitionsPayload;
}

function getFunctionName(node: ts.FunctionLikeDeclaration) {
  if ('name' in node && node.name && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  if (node.parent && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text;
  }
  if (
    node.parent
    && ts.isCallExpression(node.parent)
    && node.parent.parent
    && ts.isVariableDeclaration(node.parent.parent)
    && ts.isIdentifier(node.parent.parent.name)
  ) {
    return node.parent.parent.name.text;
  }
  if (node.parent && ts.isPropertyAssignment(node.parent)) {
    return node.parent.name.getText();
  }
  return '<anonymous>';
}

function getCalleeText(callExpression: ts.CallExpression, sourceFile: ts.SourceFile) {
  return callExpression.expression.getText(sourceFile).replace(/\s+/g, ' ').trim();
}

function findOwnerFunction(program: ts.Program, definition: PhaseDefinition) {
  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile)) {
      continue;
    }

    let result: { sourceFile: ts.SourceFile; node: ts.FunctionLikeDeclaration; name: string } | undefined;
    function visit(node: ts.Node): void {
      if (result) {
        return;
      }
      if (ts.isFunctionLike(node) && node.body) {
        const stableId = getStableId(sourceFile, node);
        const extendedStableId = getExtendedStableId(sourceFile, node);
        const name = getFunctionName(node);
        if (
          stableId === definition.ownerFunction.stableId
          || extendedStableId === definition.ownerFunction.stableId
          || (
            definition.ownerFunction.name
            && definition.ownerFunction.repoRelativePath
            && name === definition.ownerFunction.name
            && getRepoRelativePath(sourceFile.fileName) === definition.ownerFunction.repoRelativePath
          )
        ) {
          result = { sourceFile, node, name };
          return;
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    if (result) {
      return result;
    }
  }

  return undefined;
}

function findBoundaryCall(
  sourceFile: ts.SourceFile,
  owner: ts.FunctionLikeDeclaration,
  boundary: BoundaryDefinition,
) {
  const matches: ts.CallExpression[] = [];
  if (boundary.kind !== 'call-site' || !boundary.calleeText) {
    return undefined;
  }

  function visit(node: ts.Node): void {
    if (node !== owner && ts.isFunctionLike(node)) {
      return;
    }
    if (ts.isCallExpression(node) && getCalleeText(node, sourceFile) === boundary.calleeText) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  }

  visit(owner.body || owner);
  matches.sort((left, right) => left.getStart(sourceFile) - right.getStart(sourceFile));
  return matches[0];
}

function findBoundaryNode(
  sourceFile: ts.SourceFile,
  owner: ts.FunctionLikeDeclaration,
  boundary: BoundaryDefinition,
) {
  if (boundary.kind === 'function-entry') {
    return owner;
  }

  if (boundary.kind === 'call-site') {
    return findBoundaryCall(sourceFile, owner, boundary);
  }

  const text = String(boundary.text || '').trim();
  if (!text) {
    return undefined;
  }

  const matches: ts.Node[] = [];
  function visit(node: ts.Node): void {
    if (node !== owner && ts.isFunctionLike(node)) {
      return;
    }
    if (node.getText(sourceFile).replace(/\s+/g, ' ').trim() === text) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  }

  visit(owner.body || owner);
  matches.sort((left, right) => left.getStart(sourceFile) - right.getStart(sourceFile));
  return matches[0];
}

function buildBoundaryRow(
  sourceFile: ts.SourceFile,
  role: 'head' | 'tail',
  boundary: BoundaryDefinition,
  boundaryNode: ts.Node,
): BoundaryRow {
  const calleeText = boundary.kind === 'function-entry' && ts.isFunctionLike(boundaryNode)
    ? getFunctionName(boundaryNode)
    : ts.isCallExpression(boundaryNode)
    ? getCalleeText(boundaryNode, sourceFile)
    : boundary.text || boundaryNode.getText(sourceFile);
  return {
    role,
    stableId: ts.isFunctionLike(boundaryNode)
      ? getStableId(sourceFile, boundaryNode)
      : getExtendedStableId(sourceFile, boundaryNode),
    calleeText,
    actionText: boundaryNode.getText(sourceFile),
    repoRelativePath: getRepoRelativePath(sourceFile.fileName),
  };
}

function extractPhaseRows(program: ts.Program, definitions: PhaseDefinition[]) {
  const phases: PhaseRow[] = [];
  const errors: string[] = [];

  for (const definition of definitions) {
    const owner = findOwnerFunction(program, definition);
    if (!owner) {
      errors.push(`Owner function was not found for phase ${definition.key}: ${definition.ownerFunction.stableId}`);
      continue;
    }

    const headNode = findBoundaryNode(owner.sourceFile, owner.node, definition.head);
    const tailNode = findBoundaryNode(owner.sourceFile, owner.node, definition.tail);
    if (!headNode || !tailNode) {
      errors.push(`Boundary was not found for phase ${definition.key}. head=${Boolean(headNode)} tail=${Boolean(tailNode)}`);
      continue;
    }
    if (headNode.getStart(owner.sourceFile) >= tailNode.getStart(owner.sourceFile)) {
      errors.push(`Phase ${definition.key} has non-forward local order.`);
      continue;
    }

    const head = buildBoundaryRow(owner.sourceFile, 'head', definition.head, headNode);
    const tail = buildBoundaryRow(owner.sourceFile, 'tail', definition.tail, tailNode);
    phases.push({
      key: definition.key,
      label: definition.label,
      phaseKind: definition.phaseKind,
      featureKey: definition.featureKey,
      order: typeof definition.order === 'number' ? definition.order : null,
      direction: definition.direction || 'local-order',
      ownerFnStableId: getStableId(owner.sourceFile, owner.node),
      ownerFnName: owner.name || null,
      ownerRepoRelativePath: getRepoRelativePath(owner.sourceFile.fileName),
      headStepStableId: head.stableId,
      tailStepStableId: tail.stableId,
      boundaries: [head, tail],
    });
  }

  return { phases, errors };
}

function isEntrypoint() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

function main() {
  const args = parseArgs();
  const definitions = readDefinitions(args.definitionsPath);
  const payload = extractPhaseRows(createProgram(), definitions.phases || []);
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  if (args.outputPath) {
    fs.writeFileSync(args.outputPath, serialized, 'utf8');
    return;
  }
  process.stdout.write(serialized);
}

if (isEntrypoint()) {
  main();
}
