import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type StorageNode = {
  stableId: string;
  labels: string[];
  annotationKind: 'StorageCell' | 'ExternalComponent';
  parentFnStableId: string;
  repoRelativePath: string;
  resourceKind: string;
  resourceSubkind: string;
  resourceName: string;
  settingKind?: string;
  settingSubkind?: string;
  settingName?: string;
  resourceSemanticId?: string;
  resourceSemanticDetailId?: string;
  parentStableId?: string;
  resourceCellName?: string;
  resourceCellKind?: string;
  settingCellName?: string;
  settingCellKind?: string;
  flowLayer?: 'data';
  dataFlowRole?: 'storage';
};

export type StorageEdge = {
  flowNodeStableId: string;
  stableId: string;
  targetLabel: string;
  relType: string;
  accessType: string;
  calleeText?: string;
  asyncKind?: string;
  asyncPhase?: string;
  signalKind?: string;
  continuationKind?: string;
  resourceCellName?: string;
  parentStableId?: string;
  flowLayer?: 'data';
};

export type StorageLink = {
  sourceStableId: string;
  targetStableId: string;
  sourceLabel?: string;
  targetLabel?: string;
  relType: string;
  label?: string;
  calleeText?: string;
  flowLayer?: 'data';
};

export type StorageBinding = {
  flowNodeStableId: string;
  accessorStableId: string;
  storageStableId: string;
  relType: 'READ' | 'WRITE';
};

type SemanticFlowNode = {
  stableId: unknown;
  parentFnStableId: unknown;
  repoRelativePath: string;
  labels: string[];
  operationCode?: string;
  operationCalleeText?: string;
  operationValueText?: string;
  operationDetailJson?: string;
  calleeStableId?: unknown;
  asyncSchedulerKind?: string;
  stateResourceStableId?: string;
  stateResourceParentFnStableId?: string;
  stateResourceRepoRelativePath?: string;
  stateResourceName?: string;
  stateSetterName?: string;
  stateUpdateAction?: 'create' | 'write' | 'clear';
};

type CodeqlStorageFact = {
  callerRepoRelativePath?: string;
  callLine?: number;
  callColumn?: number;
  keyLiteral?: string;
  keyExpression?: string;
  accessType?: string;
  accessorMode?: string;
  accessorName?: string;
  storageClass?: string;
  providerEvidence?: string;
  storageEvidence?: Array<{ accessorMode?: string; storageExpression?: string }>;
};

export function shouldMaterializeStorageFactInFunction(
  fact: Pick<CodeqlStorageFact, 'storageClass'>,
): boolean {
  // bun:bundle feature(...) keys are compile-time predicates represented by
  // their call sites. They are not runtime storage cells and must not create
  // function-level resource nodes or READ edges.
  return fact.storageClass !== 'build-gate';
}

type FeatureOriginFacts = {
  originNodes?: StorageNode[];
  originEdges?: StorageLink[];
};

const ACCESS_RELATIONSHIPS: Record<string, string> = {
  clear: 'CLEAR',
  create: 'CREATE',
  delete: 'DELETE',
  derive: 'DERIVE',
  emit: 'EMIT',
  read: 'READ',
  signal: 'SIGNAL',
  start: 'START',
  cancel: 'CANCEL',
  test: 'TEST',
  update: 'UPDATE',
  wait: 'WAIT',
};

const LINK_RELATIONSHIPS: Record<string, string> = {
  input: 'DERIVES_FROM',
  'part-of': 'PART_OF',
};

const TYPE_METHOD_ACCESS = {
  MediaDevices: new Map([
    ['enumerateDevices', ['external-source', 'browser-media', 'read']],
    ['getDisplayMedia', ['external-source', 'browser-media', 'read']],
    ['getUserMedia', ['external-source', 'browser-media', 'read']],
    ['selectAudioOutput', ['external-source', 'browser-media', 'read']],
  ]),
  Storage: new Map([
    ['clear', ['browser-storage', 'browser-storage', 'clear']],
    ['getItem', ['browser-storage', 'browser-storage', 'read']],
    ['removeItem', ['browser-storage', 'browser-storage', 'delete']],
    ['setItem', ['browser-storage', 'browser-storage', 'update']],
  ]),
  CacheStorage: new Map([
    ['delete', ['browser-storage', 'browser-storage', 'delete']],
    ['has', ['browser-storage', 'browser-storage', 'test']],
    ['keys', ['browser-storage', 'browser-storage', 'read']],
    ['match', ['browser-storage', 'browser-storage', 'read']],
    ['open', ['browser-storage', 'browser-storage', 'read']],
  ]),
  Cache: new Map([
    ['add', ['browser-storage', 'browser-storage', 'create']],
    ['addAll', ['browser-storage', 'browser-storage', 'create']],
    ['delete', ['browser-storage', 'browser-storage', 'delete']],
    ['keys', ['browser-storage', 'browser-storage', 'read']],
    ['match', ['browser-storage', 'browser-storage', 'read']],
    ['matchAll', ['browser-storage', 'browser-storage', 'read']],
    ['put', ['browser-storage', 'browser-storage', 'update']],
  ]),
  BroadcastChannel: new Map([['postMessage', ['external-sink', 'network', 'emit']]]),
  MessagePort: new Map([['postMessage', ['external-sink', 'network', 'emit']]]),
  WebSocket: new Map([['send', ['external-sink', 'network', 'emit']]]),
  Worker: new Map([['postMessage', ['external-sink', 'network', 'emit']]]),
  Response: new Map([
    ['arrayBuffer', ['external-source', 'network', 'read']],
    ['blob', ['external-source', 'network', 'read']],
    ['formData', ['external-source', 'network', 'read']],
    ['json', ['external-source', 'network', 'read']],
    ['text', ['external-source', 'network', 'read']],
  ]),
} as const;

const SKIP_LABELS = new Set([
  'Arg', 'Branch', 'BreakStop', 'Case', 'Eval', 'Flow', 'FunctionEnd', 'ValueSlot',
  'FunctionProxy', 'LocalFunctionProxy', 'Object', 'Field', 'Operand',
  'Return', 'Switch', 'ThrowStop', 'Value', 'DataJoin', 'Join', 'Field', 'ObjectBrace',
]);

const ASYNC_CELL_NAMES = ['status', 'result', 'error', 'signal', 'handler', 'payload'];

function stableIdValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'value' in value) return String((value as { value: unknown }).value || '');
  return '';
}

function compactKey(value: string): string {
  if (Buffer.byteLength(value, 'utf8') <= 512) return value;
  const digest = crypto.createHash('sha1').update(value).digest('hex');
  return `${value.slice(0, 463).replace(/[:|\s]+$/, '')}:sha1:${digest}`;
}

function parseDetail(node: SemanticFlowNode): Record<string, unknown> {
  if (!node.operationDetailJson) return {};
  try {
    const parsed = JSON.parse(node.operationDetailJson);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function nestedObjects(value: unknown): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  const visit = (current: unknown) => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!current || typeof current !== 'object') return;
    const record = current as Record<string, unknown>;
    result.push(record);
    Object.values(record).forEach(visit);
  };
  visit(value);
  return result;
}

function typeNames(value: unknown): Set<string> {
  return new Set(String(value || '').match(/[A-Za-z_][A-Za-z0-9_]*/g) || []);
}

function cleanCell(value: unknown): string | undefined {
  const text = String(value || '').trim().replace(/^(['"`])([\s\S]*)\1$/, '$2').trim();
  if (!text || text.length > 160 || /[\r\n{}();]/.test(text)) return undefined;
  return text;
}

function resourceLabels(kind: string, subkind: string): string[] {
  if (kind === 'config-store') {
    return ['Storage', 'Setting', ...(subkind === 'feature-flags' ? ['FeatureFlagStore'] : subkind === 'global-config' ? ['GlobalConfigStore'] : [])];
  }
  if (kind === 'build-gate') return ['BuildGate', 'BuildFeature'];
  const byKind: Record<string, string[]> = {
    'async-flow': ['Async', 'Flow'],
    'browser-storage': ['Storage', 'BrowserStorage'],
    'external-sink': ['External', 'Sink'],
    'external-source': ['External', 'Source'],
    'ui-effect': ['UiEffect'],
    'ui-state': ['ValueSlot', 'Storage', 'Cell', 'UiState'],
  };
  return byKind[kind] || [];
}

function resourceId(node: SemanticFlowNode, kind: string, subkind: string, name: string): string {
  if (kind === 'config-store') return compactKey(`flow-setting:${subkind}`);
  if (kind === 'build-gate') return compactKey(`build-gate:${subkind}`);
  return compactKey(`${stableIdValue(node.parentFnStableId)}:${kind}:${name}`);
}

function annotationKindForStorageLabels(labels: string[]): StorageNode['annotationKind'] {
  return labels.some((label) => ['Storage', 'Cell', 'Setting'].includes(label))
    ? 'StorageCell'
    : 'ExternalComponent';
}

function createResource(
  node: SemanticFlowNode,
  kind: string,
  subkind: string,
  name: string,
  semanticId?: string,
  semanticDetailId?: string,
  identity?: { stableId?: string; parentFnStableId?: string; repoRelativePath?: string },
): StorageNode {
  const labels = resourceLabels(kind, subkind);
  return {
    stableId: identity?.stableId || resourceId(node, kind, subkind, name),
    labels,
    annotationKind: annotationKindForStorageLabels(labels),
    parentFnStableId: identity?.parentFnStableId || stableIdValue(node.parentFnStableId),
    repoRelativePath: identity?.repoRelativePath || node.repoRelativePath,
    resourceKind: kind,
    resourceSubkind: subkind,
    resourceName: name,
    settingKind: kind === 'config-store' ? kind : undefined,
    settingSubkind: kind === 'config-store' ? subkind : undefined,
    settingName: kind === 'config-store' ? name : undefined,
    resourceSemanticId: semanticId,
    resourceSemanticDetailId: semanticDetailId,
  };
}

function createCell(parent: StorageNode, name: string): StorageNode {
  const isSetting = parent.labels.includes('Setting');
  const isBuildGate = parent.labels.includes('BuildGate');
  return {
    ...parent,
    stableId: compactKey(`${parent.stableId}:${isSetting || isBuildGate ? '' : 'cell:'}${name}`),
    labels: [...parent.labels, 'Cell'],
    resourceName: name,
    settingName: isSetting ? name : undefined,
    parentStableId: parent.stableId,
    resourceCellName: name,
    resourceCellKind: 'cell',
    settingCellName: isSetting ? name : undefined,
    settingCellKind: isSetting ? 'cell' : undefined,
  };
}

function accessEdge(node: SemanticFlowNode, target: StorageNode, accessType: string, calleeText?: string): StorageEdge | undefined {
  const relType = ACCESS_RELATIONSHIPS[accessType];
  if (!relType) return undefined;
  return {
    flowNodeStableId: stableIdValue(node.stableId),
    stableId: target.stableId,
    targetLabel: target.labels[0],
    relType,
    accessType,
    calleeText,
    resourceCellName: target.resourceCellName,
    parentStableId: target.parentStableId,
  };
}

type IndexedCodeqlStorageFact = {
  fact: CodeqlStorageFact;
  line: number;
  column: number;
};

function compareLocation(leftLine: number, leftColumn: number, rightLine: number, rightColumn: number): number {
  return leftLine - rightLine || leftColumn - rightColumn;
}

function codeqlFactsByPath(): Map<string, IndexedCodeqlStorageFact[]> {
  const result = new Map<string, IndexedCodeqlStorageFact[]>();
  const factsPath = path.join(process.cwd(), '.cache', 'codeql', 'results', 'parameterized-storage-accessor-calls.facts.json');
  if (!fs.existsSync(factsPath)) return result;
  try {
    const payload = JSON.parse(fs.readFileSync(factsPath, 'utf8')) as { rows?: CodeqlStorageFact[] };
    for (const row of payload.rows || []) {
      const repoPath = String(row.callerRepoRelativePath || '').replaceAll('\\', '/');
      const line = Number(row.callLine);
      const column = Number(row.callColumn);
      if (!repoPath || !Number.isFinite(line) || !Number.isFinite(column)) continue;
      result.set(repoPath, [...(result.get(repoPath) || []), { fact: row, line, column }]);
    }
    for (const rows of result.values()) {
      rows.sort((left, right) => compareLocation(left.line, left.column, right.line, right.column));
    }
  } catch {
    return new Map();
  }
  return result;
}

const STORAGE_FACTS_BY_PATH = codeqlFactsByPath();

function loadFeatureOriginFacts(): FeatureOriginFacts {
  const factsPath = path.resolve('.cache/feature-origins/feature-origin-facts.json');
  if (!fs.existsSync(factsPath)) return {};
  try {
    const facts = JSON.parse(fs.readFileSync(factsPath, 'utf8')) as FeatureOriginFacts;
    return {
      ...facts,
      originNodes: (facts.originNodes || []).map((node) => ({
        ...node,
        labels: (node.labels || []).filter((label) => label !== 'FlowResource'),
        annotationKind: node.annotationKind || annotationKindForStorageLabels(node.labels || []),
      })),
    };
  } catch {
    return {};
  }
}

const FEATURE_ORIGIN_FACTS = loadFeatureOriginFacts();

function stableRange(node: SemanticFlowNode): [number, number, number, number] | undefined {
  const match = stableIdValue(node.stableId).match(/:(\d+):(\d+):(\d+):(\d+)(?::.*)?$/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
}

function codeqlFactsForNode(node: SemanticFlowNode): CodeqlStorageFact[] {
  const range = stableRange(node);
  if (!range) return [];
  const facts = STORAGE_FACTS_BY_PATH.get(node.repoRelativePath.replaceAll('\\', '/')) || [];
  let low = 0;
  let high = facts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const candidate = facts[middle];
    if (compareLocation(candidate.line, candidate.column, range[0], range[1]) < 0) low = middle + 1;
    else high = middle;
  }

  const matches: CodeqlStorageFact[] = [];
  for (let index = low; index < facts.length; index += 1) {
    const candidate = facts[index];
    if (compareLocation(candidate.line, candidate.column, range[2], range[3]) > 0) break;
    matches.push(candidate.fact);
  }
  return matches;
}

function storageSubkind(fact: CodeqlStorageFact): string {
  if (fact.storageClass === 'runtime-feature-store') return 'feature-flags';
  if (fact.storageClass === 'build-gate') return 'build-gate';
  return 'settings';
}

export function buildStorageGraph(nodes: SemanticFlowNode[]): {
  storages: StorageNode[];
  storageEdges: StorageEdge[];
  storageLinks: StorageLink[];
  storageBindings: StorageBinding[];
} {
  const storages = new Map<string, StorageNode>();
  const storageEdges = new Map<string, StorageEdge>();
  const storageLinks = new Map<string, StorageLink>();
  const storageBindings = new Map<string, StorageBinding>();

  const registerTarget = (parent: StorageNode, cellName?: string, calleeText?: string) => {
    storages.set(parent.stableId, parent);
    if (!cellName) return parent;
    const target = createCell(parent, cellName);
    storages.set(target.stableId, target);
    const link: StorageLink = { sourceStableId: target.stableId, targetStableId: parent.stableId, relType: LINK_RELATIONSHIPS['part-of'], label: 'part-of', calleeText };
    storageLinks.set(`${link.sourceStableId}:${link.relType}:${link.targetStableId}`, link);
    return target;
  };

  const addAccess = (node: SemanticFlowNode, parent: StorageNode, accessType: string, calleeText?: string, cellName?: string, asyncPayload?: Record<string, unknown>) => {
    const target = registerTarget(parent, cellName, calleeText);
    const edge = accessEdge(node, target, accessType, calleeText);
    if (!edge) return;
    if (asyncPayload) {
      edge.asyncKind = String(asyncPayload.asyncKind || '') || undefined;
      edge.asyncPhase = String(asyncPayload.asyncPhase || '') || undefined;
      edge.signalKind = String(asyncPayload.signalKind || '') || undefined;
      edge.continuationKind = String(asyncPayload.continuationKind || '') || undefined;
    }
    storageEdges.set(`${edge.flowNodeStableId}:${edge.relType}:${edge.stableId}`, edge);
  };

  for (const node of nodes) {
    const labels = new Set(node.labels || []);
    if (labels.has('ValueOutcome')) continue;
    const isPredicateOperand = labels.has('Operand') && labels.has('Branch');
    if (!isPredicateOperand && labels.size > 0 && [...labels].every((label) => SKIP_LABELS.has(label))) continue;

    for (const fact of codeqlFactsForNode(node)) {
      if (!shouldMaterializeStorageFactInFunction(fact)) continue;
      const accessType = ACCESS_RELATIONSHIPS[String(fact.accessType || '').toLowerCase()]
        ? String(fact.accessType).toLowerCase()
        : JSON.stringify(fact.storageEvidence || []).toLowerCase().includes('write') ? 'update' : 'read';
      const cellName = cleanCell(fact.keyLiteral) || cleanCell(fact.keyExpression);
      const subkind = storageSubkind(fact);
      const kind = subkind === 'build-gate' ? 'build-gate' : 'config-store';
      const provider = String(fact.providerEvidence || 'build').trim() || 'build';
      const name = cellName || String(fact.accessorName || (kind === 'build-gate' ? 'build gate' : 'settings'));
      const parent = createResource(node, kind, kind === 'build-gate' ? provider : subkind, kind === 'build-gate' ? 'bun:bundle' : name);
      const accessorRole = labels.has('Read') ? 'READ' : labels.has('Write') ? 'WRITE' : undefined;
      if (accessorRole && node.calleeStableId) {
        const accessorStableId = stableIdValue(node.calleeStableId);
        const target = registerTarget(parent, cellName, name);
        const binding: StorageBinding = {
          flowNodeStableId: stableIdValue(node.stableId),
          accessorStableId,
          storageStableId: target.stableId,
          relType: accessorRole,
        };
        storageBindings.set(`${binding.flowNodeStableId}:${binding.relType}:${binding.storageStableId}`, binding);
      } else {
        addAccess(node, parent, accessType, name, cellName);
      }
    }

    const detail = parseDetail(node);
    const semanticPayloads = nestedObjects(detail)
      .map((candidate) => candidate.semantic)
      .filter((semantic): semantic is Record<string, unknown> => Boolean(semantic && typeof semantic === 'object'));

    for (const semantic of semanticPayloads) {
      const asyncPayloads = Array.isArray(semantic.async) ? semantic.async : semantic.async && typeof semantic.async === 'object' ? [semantic.async] : [];
      for (const rawPayload of asyncPayloads) {
        const payload = rawPayload as Record<string, unknown>;
        const accessType = String(payload.accessType || '');
        const kind = String(payload.resourceKind || '').replace(/^async-(control|event)$/, 'async-flow');
        const subkind = String(payload.resourceSubkind || '');
        const name = String(payload.resourceName || '');
        if (!ACCESS_RELATIONSHIPS[accessType] || !kind || !subkind || !name) continue;
        const parent = createResource(node, kind, subkind, name, String(payload.resourceSemanticId || '') || undefined, String(payload.resourceSemanticDetailId || '') || undefined);
        addAccess(node, parent, accessType, name, undefined, payload);
        for (const cellName of kind === 'async-flow' ? ASYNC_CELL_NAMES : []) {
          const cell = createCell(parent, cellName);
          storages.set(cell.stableId, cell);
        }
        for (const rawInput of Array.isArray(payload.inputResources) ? payload.inputResources : []) {
          if (!rawInput || typeof rawInput !== 'object') continue;
          const input = rawInput as Record<string, unknown>;
          const inputKind = String(input.resourceKind || '').replace(/^async-(control|event)$/, 'async-flow');
          const inputSubkind = String(input.resourceSubkind || '');
          const inputName = String(input.resourceName || '');
          if (!inputKind || !inputSubkind || !inputName) continue;
          const source = createResource(node, inputKind, inputSubkind, inputName, String(input.resourceSemanticId || '') || undefined, String(input.resourceSemanticDetailId || '') || undefined);
          storages.set(source.stableId, source);
          const link: StorageLink = { sourceStableId: source.stableId, targetStableId: parent.stableId, relType: LINK_RELATIONSHIPS.input, label: 'input', calleeText: inputName };
          storageLinks.set(`${link.sourceStableId}:${link.relType}:${link.targetStableId}`, link);
        }
      }

      const call = semantic.call;
      if (!call || typeof call !== 'object' || node.calleeStableId) continue;
      const payload = call as Record<string, unknown>;
      const calleeText = String(payload.calleeText || node.operationCalleeText || '');
      const methodName = String(payload.methodName || '');
      const receiverTypes = typeNames(payload.receiverTypeText);
      const trustedPlatform = Boolean(payload.signatureDeclarationIsTypeLib)
        || Boolean((payload.receiverSymbol as Record<string, unknown> | undefined)?.declarationIsTypeLib);
      if (!calleeText || !methodName || !trustedPlatform) continue;
      for (const receiverType of receiverTypes) {
        const rule = TYPE_METHOD_ACCESS[receiverType as keyof typeof TYPE_METHOD_ACCESS]?.get(methodName as never) as readonly string[] | undefined;
        if (!rule) continue;
        addAccess(node, createResource(node, rule[0], rule[1], calleeText), rule[2], calleeText);
      }
      if (methodName === 'fetch' && typeNames(payload.returnTypeText).has('Response')) {
        addAccess(node, createResource(node, 'external-sink', 'network-http', calleeText), 'emit', calleeText);
        addAccess(node, createResource(node, 'external-source', 'network-http', calleeText), 'read', calleeText);
      }
    }

    if (node.asyncSchedulerKind === 'react-state'
      && node.stateResourceStableId
      && node.stateResourceName) {
      const resource = createResource(
        node,
        'ui-state',
        'react-state',
        node.stateResourceName,
        undefined,
        undefined,
        {
          stableId: node.stateResourceStableId,
          parentFnStableId: node.stateResourceParentFnStableId,
          repoRelativePath: node.stateResourceRepoRelativePath,
        },
      );
      const accessorStableId = stableIdValue(node.calleeStableId);
      if (labels.has('Write') && accessorStableId) {
        const target = registerTarget(resource, undefined, node.stateSetterName || node.operationCalleeText);
        const binding: StorageBinding = {
          flowNodeStableId: stableIdValue(node.stableId),
          accessorStableId,
          storageStableId: target.stableId,
          relType: 'WRITE',
        };
        storageBindings.set(`${binding.flowNodeStableId}:${binding.relType}:${binding.storageStableId}`, binding);
      } else {
        addAccess(
          node,
          resource,
          node.stateUpdateAction === 'create' ? 'create' : node.stateUpdateAction === 'clear' ? 'clear' : 'update',
          node.stateSetterName || node.operationCalleeText,
        );
      }
    }
  }

  const relevantOriginEdges = (FEATURE_ORIGIN_FACTS.originEdges || []).filter((edge) => storages.has(edge.targetStableId));
  const relevantOriginIds = new Set(relevantOriginEdges.map((edge) => edge.sourceStableId));
  for (const origin of FEATURE_ORIGIN_FACTS.originNodes || []) {
    if (relevantOriginIds.has(origin.stableId)) storages.set(origin.stableId, origin);
  }
  for (const edge of relevantOriginEdges) {
    storageLinks.set(`${edge.sourceStableId}:${edge.relType}:${edge.targetStableId}`, edge);
  }

  return {
    storages: [...storages.values()].map((storage) => ({
      ...storage,
      flowLayer: 'data',
      dataFlowRole: 'storage',
    })),
    storageEdges: [...storageEdges.values()].map((edge) => ({
      ...edge,
      flowLayer: 'data',
    })),
    storageLinks: [...storageLinks.values()].map((link) => ({
      ...link,
      sourceLabel: storages.get(link.sourceStableId)?.labels[0] || 'Fn',
      targetLabel: storages.get(link.targetStableId)?.labels[0],
      flowLayer: 'data',
    })),
    storageBindings: [...storageBindings.values()],
  };
}
