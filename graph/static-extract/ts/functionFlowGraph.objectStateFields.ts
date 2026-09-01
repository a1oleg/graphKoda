type FlowEdgeKind = 'NEXT' | 'TRUE' | 'FALSE' | 'OPTION_CASE' | 'OPTION_DEFAULT' | 'REJOINS' | 'MERGES_TO';

type ObjectStateRef = {
  k: string;
  v: number;
};

type FlowNodeRowSubset = {
  readObjectKeys?: string[];
  readObjectStatesJson?: string;
  testedObjectKeys?: string[];
  testedObjectStatesJson?: string;
  createdObjectKeys?: string[];
  createdObjectStatesJson?: string;
  replacedObjectKeys?: string[];
  replacedObjectStatesJson?: string;
  removedObjectKeys?: string[];
  removedObjectStatesJson?: string;
  resultObjectKeys?: string[];
  resultObjectStatesJson?: string;
  mergedObjectKeys?: string[];
  mergedObjectStatesJson?: string;
};

type PendingExitSubset = {
  edgeType: FlowEdgeKind;
  objectKeys?: string[];
};

export type ObjectKeyParts = {
  baseKey: string;
  version: number;
};

export function getObjectKeyParts(objectKey: string): ObjectKeyParts {
  const match = objectKey.match(/^(.*)@v(\d+)$/);
  if (!match) {
    return { baseKey: objectKey, version: 0 };
  }

  return {
    baseKey: match[1],
    version: Number(match[2]),
  };
}

export function normalizeObjectKeys(objectKeys: string[]) {
  const preferredByBase = new Map<string, string>();

  for (const objectKey of objectKeys) {
    const { baseKey, version } = getObjectKeyParts(objectKey);
    const current = preferredByBase.get(baseKey);
    if (!current || version >= getObjectKeyParts(current).version) {
      preferredByBase.set(baseKey, objectKey);
    }
  }

  return [...preferredByBase.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, objectKey]) => objectKey);
}

export function findCurrentObjectKey(baseKey: string, objectKeys: string[]) {
  return normalizeObjectKeys(objectKeys).find((objectKey) => getObjectKeyParts(objectKey).baseKey === baseKey);
}

function toDisplayObjectKey(objectStateId: string) {
  return objectStateId.replace(/@v\d+$/, '');
}

function toDisplayObjectKeys(objectStateIds: string[]) {
  const preferredByBase = new Map<string, string>();

  for (const objectStateId of objectStateIds) {
    const displayKey = toDisplayObjectKey(objectStateId);
    const current = preferredByBase.get(displayKey);
    if (!current || getObjectKeyParts(objectStateId).version >= getObjectKeyParts(current).version) {
      preferredByBase.set(displayKey, objectStateId);
    }
  }

  return [...preferredByBase.keys()].sort((left, right) => left.localeCompare(right));
}

function toObjectStateRef(objectStateId: string): ObjectStateRef {
  const { baseKey, version } = getObjectKeyParts(objectStateId);

  return {
    k: baseKey,
    v: version,
  };
}

function serializeObjectStates(objectStateIds: string[]) {
  return JSON.stringify(normalizeObjectKeys(objectStateIds).map((objectStateId) => toObjectStateRef(objectStateId)));
}

export function buildNodeObjectStateFields(
  extra: Partial<FlowNodeRowSubset>,
): Partial<FlowNodeRowSubset> {
  const result: Partial<FlowNodeRowSubset> = {};
  const mappings: Array<[keyof FlowNodeRowSubset, keyof FlowNodeRowSubset]> = [
    ['readObjectKeys', 'readObjectStatesJson'],
    ['testedObjectKeys', 'testedObjectStatesJson'],
    ['createdObjectKeys', 'createdObjectStatesJson'],
    ['replacedObjectKeys', 'replacedObjectStatesJson'],
    ['removedObjectKeys', 'removedObjectStatesJson'],
    ['resultObjectKeys', 'resultObjectStatesJson'],
    ['mergedObjectKeys', 'mergedObjectStatesJson'],
  ];
  const resultRecord = result as Record<string, unknown>;

  for (const [visibleKey, hiddenKey] of mappings) {
    const objectStateIds = extra[visibleKey] as string[] | undefined;
    if (!objectStateIds) {
      continue;
    }

    resultRecord[visibleKey] = toDisplayObjectKeys(objectStateIds);
    resultRecord[hiddenKey] = serializeObjectStates(objectStateIds);
  }

  return result;
}

export function serializeIncomingObjectStates(
  incomingExits: PendingExitSubset[],
) {
  return JSON.stringify(incomingExits.map((exit) => ({
    edgeType: exit.edgeType,
    objectKeys: toDisplayObjectKeys(normalizeObjectKeys(exit.objectKeys || [])),
    objectStates: normalizeObjectKeys(exit.objectKeys || []).map((objectStateId) => toObjectStateRef(objectStateId)),
  })));
}
