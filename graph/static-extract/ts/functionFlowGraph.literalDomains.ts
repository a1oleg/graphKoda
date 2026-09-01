import ts from 'typescript';

import {
  getExtendedStableId,
  getRepoRelativePath,
  getStableId,
  isTrackedSourceFile,
} from './functionFlowGraph.infrastructure.js';
import type { CanonicalEntity, CanonicalRelationship } from './functionFlowDuckdbStage.js';

type LiteralValue = string | number | boolean;

type DomainMember = {
  stableId: string;
  name?: string;
  value: LiteralValue;
  valueKind: 'string' | 'number' | 'boolean';
  ordinal: number;
};

type LiteralDomain = {
  stableId: string;
  name: string;
  kind: 'enum' | 'literal-union';
  typeText: string;
  repoRelativePath: string;
  declarationStableId: string;
  members: DomainMember[];
};

export type FiniteLiteralOccurrence = {
  stableId: string;
  sourceStableId: string;
  domainStableId: string;
  memberStableId: string;
  parentFnStableId?: string;
  repoRelativePath: string;
  rawText: string;
  value: LiteralValue;
  valueKind: 'string' | 'number' | 'boolean';
};

export type FiniteLiteralDomainGraph = {
  entities: CanonicalEntity[];
  relationships: CanonicalRelationship[];
  occurrences: FiniteLiteralOccurrence[];
};

function literalKey(value: LiteralValue) {
  return `${typeof value}:${String(value)}`;
}

function literalFromTypeNode(node: ts.TypeNode): LiteralValue | undefined {
  if (!ts.isLiteralTypeNode(node)) return undefined;
  const literal = node.literal;
  if (ts.isStringLiteral(literal) || ts.isNumericLiteral(literal)) {
    return ts.isStringLiteral(literal) ? literal.text : Number(literal.text);
  }
  if (literal.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (literal.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isPrefixUnaryExpression(literal) && ts.isNumericLiteral(literal.operand)) {
    const number = Number(literal.operand.text);
    return literal.operator === ts.SyntaxKind.MinusToken ? -number : number;
  }
  return undefined;
}

function literalFromExpression(node: ts.Expression): LiteralValue | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
    const number = Number(node.operand.text);
    return node.operator === ts.SyntaxKind.MinusToken ? -number : number;
  }
  return undefined;
}

function valueKind(value: LiteralValue): DomainMember['valueKind'] {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  return 'boolean';
}

function enclosingFunctionStableId(node: ts.Node) {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) return getStableId(current.getSourceFile(), current);
    current = current.parent;
  }
  return undefined;
}

function isDeclarationLiteral(node: ts.Node) {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isTypeNode(current) || ts.isEnumMember(current)) return true;
    if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) return true;
    if (ts.isComputedPropertyName(current)) return false;
    if (
      (ts.isPropertyAssignment(current) || ts.isPropertyDeclaration(current) || ts.isPropertySignature(current))
      && current.name === node
    ) return true;
    if (ts.isStatement(current) || ts.isExpression(current)) break;
    current = current.parent;
  }
  return false;
}

function domainFromTypeAlias(declaration: ts.TypeAliasDeclaration): LiteralDomain | undefined {
  if (!ts.isUnionTypeNode(declaration.type)) return undefined;
  const values = declaration.type.types.map(literalFromTypeNode);
  if (values.some((value) => value === undefined)) return undefined;
  const uniqueValues = [...new Map(values.map((value) => [literalKey(value!), value!])).values()];
  if (uniqueValues.length < 2) return undefined;
  const declarationStableId = getStableId(declaration.getSourceFile(), declaration);
  const stableId = `literal-domain:${declarationStableId}`;
  return {
    stableId,
    name: declaration.name.text,
    kind: 'literal-union',
    typeText: declaration.type.getText(declaration.getSourceFile()),
    repoRelativePath: getRepoRelativePath(declaration.getSourceFile().fileName),
    declarationStableId,
    members: uniqueValues.map((value, ordinal) => ({
      stableId: `${stableId}:member:${ordinal}`,
      value,
      valueKind: valueKind(value),
      ordinal,
    })),
  };
}

function enumMemberValue(member: ts.EnumMember, checker: ts.TypeChecker): LiteralValue | undefined {
  const constant = checker.getConstantValue(member);
  if (typeof constant === 'string' || typeof constant === 'number') return constant;
  if (member.initializer) return literalFromExpression(member.initializer);
  return undefined;
}

function domainFromEnum(declaration: ts.EnumDeclaration, checker: ts.TypeChecker): LiteralDomain | undefined {
  const values = declaration.members.map((member) => enumMemberValue(member, checker));
  if (values.some((value) => value === undefined)) return undefined;
  const declarationStableId = getStableId(declaration.getSourceFile(), declaration);
  const stableId = `literal-domain:${declarationStableId}`;
  return {
    stableId,
    name: declaration.name.text,
    kind: 'enum',
    typeText: declaration.name.text,
    repoRelativePath: getRepoRelativePath(declaration.getSourceFile().fileName),
    declarationStableId,
    members: values.map((value, ordinal) => ({
      stableId: `${stableId}:member:${ordinal}`,
      name: declaration.members[ordinal].name.getText(declaration.getSourceFile()),
      value: value!,
      valueKind: valueKind(value!),
      ordinal,
    })),
  };
}

function declarationDomainForType(
  type: ts.Type,
  domainsByDeclaration: Map<ts.Declaration, LiteralDomain>,
  seen = new Set<ts.Type>(),
): LiteralDomain | undefined {
  if (seen.has(type)) return undefined;
  seen.add(type);

  const symbols = [type.aliasSymbol, type.getSymbol()].filter((symbol): symbol is ts.Symbol => Boolean(symbol));
  for (const symbol of symbols) {
    for (const declaration of symbol.declarations || []) {
      const domain = domainsByDeclaration.get(declaration);
      if (domain) return domain;
    }
  }

  for (const argument of type.aliasTypeArguments || []) {
    const domain = declarationDomainForType(argument, domainsByDeclaration, seen);
    if (domain) return domain;
  }
  if (type.flags & ts.TypeFlags.Object) {
    const reference = type as ts.TypeReference;
    for (const argument of reference.typeArguments || []) {
      const domain = declarationDomainForType(argument, domainsByDeclaration, seen);
      if (domain) return domain;
    }
  }
  if (type.isUnionOrIntersection()) {
    for (const part of type.types) {
      const domain = declarationDomainForType(part, domainsByDeclaration, seen);
      if (domain) return domain;
    }
  }
  return undefined;
}

function expressionDomain(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  domainsByDeclaration: Map<ts.Declaration, LiteralDomain>,
) {
  const contextual = checker.getContextualType(expression);
  if (contextual) {
    const domain = declarationDomainForType(contextual, domainsByDeclaration);
    if (domain) return domain;
  }
  return declarationDomainForType(checker.getTypeAtLocation(expression), domainsByDeclaration);
}

function domainEntities(domain: LiteralDomain): CanonicalEntity[] {
  return [{
    stableId: domain.stableId,
    labels: ['LiteralDomain', domain.kind === 'enum' ? 'Enum' : 'LiteralUnion'],
    props: {
      name: domain.name,
      domain_kind: domain.kind,
      type_text: domain.typeText,
      repo_relative_path: domain.repoRelativePath,
      declaration_stable_id: domain.declarationStableId,
      annotationKind: 'LiteralDomain',
      flow_layer: 'data',
    },
  }, ...domain.members.map((member) => ({
    stableId: member.stableId,
    labels: ['LiteralDomainValue', domain.kind === 'enum' ? 'EnumMember' : 'LiteralUnionMember'],
    props: {
      name: member.name || String(member.value),
      value: member.value,
      value_kind: member.valueKind,
      ordinal: member.ordinal,
      domain_stable_id: domain.stableId,
      annotationKind: 'LiteralDomainValue',
      flow_layer: 'data',
    },
  }))];
}

export function collectFiniteLiteralDomainGraph(program: ts.Program): FiniteLiteralDomainGraph {
  const checker = program.getTypeChecker();
  const domainsByDeclaration = new Map<ts.Declaration, LiteralDomain>();
  const enumMembers = new Map<ts.EnumMember, { domain: LiteralDomain; member: DomainMember }>();

  for (const sourceFile of program.getSourceFiles()) {
    function visitDeclaration(node: ts.Node): void {
      if (ts.isTypeAliasDeclaration(node)) {
        const domain = domainFromTypeAlias(node);
        if (domain) domainsByDeclaration.set(node, domain);
      } else if (ts.isEnumDeclaration(node)) {
        const domain = domainFromEnum(node, checker);
        if (domain) {
        domainsByDeclaration.set(node, domain);
          node.members.forEach((member, index) => enumMembers.set(member, { domain, member: domain.members[index] }));
        }
      }
      ts.forEachChild(node, visitDeclaration);
    }
    visitDeclaration(sourceFile);
  }

  const occurrences: FiniteLiteralOccurrence[] = [];
  const usedDomains = new Map<string, LiteralDomain>();
  for (const sourceFile of program.getSourceFiles()) {
    if (!isTrackedSourceFile(sourceFile)) continue;
    function visitOccurrence(node: ts.Node): void {
      let domain: LiteralDomain | undefined;
      let member: DomainMember | undefined;
      let value: LiteralValue | undefined;

      if (ts.isPropertyAccessExpression(node)) {
        const symbol = checker.getSymbolAtLocation(node.name);
        const enumMember = symbol?.declarations?.find(ts.isEnumMember);
        const match = enumMember ? enumMembers.get(enumMember) : undefined;
        if (match) ({ domain, member } = match);
      } else if (ts.isExpression(node) && !isDeclarationLiteral(node)) {
        value = literalFromExpression(node);
        if (value !== undefined) {
          domain = expressionDomain(node, checker, domainsByDeclaration);
          member = domain?.members.find((candidate) => literalKey(candidate.value) === literalKey(value!));
        }
      }

      if (domain && member) {
        value ??= member.value;
        const sourceStableId = getExtendedStableId(sourceFile, node);
        usedDomains.set(domain.stableId, domain);
        occurrences.push({
          stableId: `literal-occurrence:${sourceStableId}`,
          sourceStableId,
          domainStableId: domain.stableId,
          memberStableId: member.stableId,
          parentFnStableId: enclosingFunctionStableId(node),
          repoRelativePath: getRepoRelativePath(sourceFile.fileName),
          rawText: node.getText(sourceFile),
          value,
          valueKind: valueKind(value),
        });
      }
      ts.forEachChild(node, visitOccurrence);
    }
    visitOccurrence(sourceFile);
  }

  const entities = [...usedDomains.values()].flatMap(domainEntities);
  entities.push(...occurrences.map((occurrence) => ({
    stableId: occurrence.stableId,
    labels: ['Literal', 'LiteralOccurrence', 'FiniteDomainValue'],
    props: {
      raw_text: occurrence.rawText,
      value: occurrence.value,
      value_kind: occurrence.valueKind,
      repo_relative_path: occurrence.repoRelativePath,
      parentFnStableId: occurrence.parentFnStableId,
      domain_stable_id: occurrence.domainStableId,
      annotationKind: 'LiteralOccurrence',
      flow_layer: 'data',
    },
  })));

  const relationships: CanonicalRelationship[] = [];
  for (const domain of usedDomains.values()) {
    for (const member of domain.members) {
      relationships.push({
        fromId: domain.stableId,
        toId: member.stableId,
        type: 'HAS_MEMBER',
        props: { ordinal: member.ordinal, flow_layer: 'data' },
      });
    }
  }
  for (const occurrence of occurrences) {
    relationships.push({
      fromId: occurrence.stableId,
      toId: occurrence.memberStableId,
      type: 'RESOLVES_TO',
      props: { flow_layer: 'data' },
    });
  }
  return { entities, relationships, occurrences };
}
