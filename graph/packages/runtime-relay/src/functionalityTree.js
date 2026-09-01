import { runReadQuery } from './runtimeEvents.js';

function normalizeStringList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

const OBJECT_REL_TYPES = [
  'READS_OBJECT',
  'TESTS_OBJECT',
  'CREATES_OBJECT',
  'UPDATES_OBJECT',
  'REMOVES_OBJECT',
  'RETURNS_OBJECT',
  'USES_OBJECT',
];

const GENERIC_FAMILY_NAMES = new Set([
  'Array',
  'Boolean',
  'Date',
  'Function',
  'Map',
  'Number',
  'Object',
  'Promise',
  'Set',
  'String',
]);

const CLUSTER_LABEL_STOP_WORDS = new Set([
  'action',
  'actions',
  'active',
  'allowed',
  'cached',
  'current',
  'default',
  'input',
  'params',
  'regular',
  'request',
  'required',
  'saved',
  'settings',
  'stars',
  'status',
  'topics',
  'type',
  'update',
  'updates',
]);

function createFamilyAggregate(key) {
  return {
    key,
    label: key,
    objectKeys: new Set(),
    objectTypes: new Set(),
    stepIds: new Set(),
    functionIds: new Set(),
    relationKinds: new Set(),
    actionKinds: new Set(),
    laneKinds: new Set(),
    controlRoles: new Set(),
    lifecycleStages: new Set(),
    storeKeys: new Set(),
    storeNames: new Set(),
    routeSize: 0,
  };
}

function splitObjectKeySegments(objectKey) {
  return String(objectKey || '')
    .split(/[:.\[\]<>]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function normalizeFamilyCandidate(value) {
  const normalizedValue = String(value || '').trim();
  if (!normalizedValue) {
    return '';
  }

  return normalizedValue
    .split('@')[0]
    .replace(/^const:/i, '')
    .replace(/^temp:/i, '')
    .trim();
}

function isGenericFamilyName(value) {
  const normalizedValue = normalizeFamilyCandidate(value);
  if (!normalizedValue) {
    return true;
  }

  if (GENERIC_FAMILY_NAMES.has(normalizedValue)) {
    return true;
  }

  if (/^[A-Z]$/.test(normalizedValue)) {
    return true;
  }

  return /(Function|Promise|Element|Node|Buffer|Setter|Callback|Handler|Actions|Ref(Object)?|State)$/i.test(normalizedValue);
}

function pickObjectFamily(row) {
  const typeCandidates = [
    normalizeFamilyCandidate(row.objectType),
    ...normalizeStringList(row.objectTypes).map(normalizeFamilyCandidate),
  ].filter(Boolean);

  const specificType = typeCandidates.find((candidate) => !isGenericFamilyName(candidate));
  if (specificType) {
    return specificType;
  }

  const objectName = normalizeFamilyCandidate(row.objectName);
  if (objectName && !isGenericFamilyName(objectName)) {
    return objectName;
  }

  const objectKeySegments = splitObjectKeySegments(row.objectKey).map(normalizeFamilyCandidate);
  const keyCandidate = [...objectKeySegments].reverse().find((candidate) => !isGenericFamilyName(candidate));
  if (keyCandidate) {
    return keyCandidate;
  }

  return normalizeFamilyCandidate(row.objectType || row.objectName || row.objectKey);
}

function buildStepThreshold(values, percentile) {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * percentile)));
  return sorted[index];
}

function buildRouteDescriptor(route) {
  route.routeSize = route.stepIds.size + route.functionIds.size + route.storeKeys.size + route.objectKeys.size;
  return route;
}

function calculateSetContainment(parentSet, childSet) {
  if (!childSet.size) {
    return 1;
  }

  let overlap = 0;
  childSet.forEach((value) => {
    if (parentSet.has(value)) {
      overlap += 1;
    }
  });

  return overlap / childSet.size;
}

function calculateJaccard(leftSet, rightSet) {
  if (!leftSet.size && !rightSet.size) {
    return 1;
  }

  let intersection = 0;
  leftSet.forEach((value) => {
    if (rightSet.has(value)) {
      intersection += 1;
    }
  });

  const union = leftSet.size + rightSet.size - intersection;
  return union ? intersection / union : 0;
}

function tokenizeLabel(label) {
  return String(label || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 3)
    .filter((token) => !['api', 'data', 'input', 'output', 'type', 'value', 'object'].includes(token));
}

function calculateClusterSimilarity(left, right) {
  return calculateJaccard(left.functionIds, right.functionIds) * 0.35
    + calculateJaccard(left.stepIds, right.stepIds) * 0.25
    + calculateJaccard(left.storeKeys, right.storeKeys) * 0.1
    + calculateJaccard(left.relationKinds, right.relationKinds) * 0.1
    + calculateJaccard(left.lifecycleStages, right.lifecycleStages) * 0.1
    + calculateJaccard(left.laneKinds, right.laneKinds) * 0.05
    + calculateJaccard(left.objectTypes, right.objectTypes) * 0.05;
}

function buildLeafNode(descriptor) {
  return {
    key: descriptor.key,
    label: descriptor.key,
    routeSize: descriptor.routeSize,
    nodeCount: descriptor.stepIds.size,
    edgeCount: descriptor.relationKinds.size,
    objectCount: descriptor.objectKeys.size,
    objectTypes: [...descriptor.objectTypes].sort(),
    primaryLaneKinds: [...descriptor.laneKinds].sort(),
    controlRoleHints: [...descriptor.controlRoles].sort(),
    lifecycleStageHints: [...descriptor.lifecycleStages].sort(),
    relationKinds: [...descriptor.relationKinds].sort(),
    actionKinds: [...descriptor.actionKinds].sort(),
    stores: [...descriptor.storeNames].sort(),
    children: [],
    reason: undefined,
  };
}

function buildClusterSeed(nodeOrDescriptor) {
  const descriptor = nodeOrDescriptor.descriptor || nodeOrDescriptor;
  return {
    descriptor,
    key: descriptor.key,
    label: descriptor.key,
    functionIds: new Set(descriptor.functionIds),
    stepIds: new Set(descriptor.stepIds),
    storeKeys: new Set(descriptor.storeKeys),
    relationKinds: new Set(descriptor.relationKinds),
    objectTypes: new Set(descriptor.objectTypes),
    laneKinds: new Set(descriptor.laneKinds),
    controlRoles: new Set(descriptor.controlRoles),
    lifecycleStages: new Set(descriptor.lifecycleStages),
    routeSize: descriptor.routeSize,
    leafLabels: [descriptor.key],
    node: buildLeafNode(descriptor),
  };
}

function buildClusterLabel(leafLabels, laneKinds, depth, sequenceIndex) {
  const tokenCounts = new Map();
  leafLabels.forEach((label) => {
    new Set(tokenizeLabel(label)).forEach((token) => {
      tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
    });
  });
  const commonToken = [...tokenCounts.entries()]
    .filter(([, count]) => count >= Math.max(2, Math.ceil(leafLabels.length * 0.5)))
    .sort((leftEntry, rightEntry) => rightEntry[1] - leftEntry[1] || leftEntry[0].localeCompare(rightEntry[0]))[0]?.[0];
  const sortedLaneKinds = [...laneKinds].sort();

  return commonToken
    ? `${commonToken[0].toUpperCase()}${commonToken.slice(1)} cluster`
    : sortedLaneKinds.length === 1
      ? `${sortedLaneKinds[0]} cluster`
      : `cluster ${depth + 1}.${sequenceIndex + 1}`;
}

function buildSyntheticCluster(group, children, depth, sequenceIndex) {
  const functionIds = new Set(group.flatMap((item) => [...item.functionIds]));
  const stepIds = new Set(group.flatMap((item) => [...item.stepIds]));
  const storeKeys = new Set(group.flatMap((item) => [...item.storeKeys]));
  const relationKinds = new Set(group.flatMap((item) => [...item.relationKinds]));
  const objectTypes = new Set(group.flatMap((item) => [...item.objectTypes]));
  const laneKinds = new Set(group.flatMap((item) => [...item.laneKinds]));
  const controlRoles = new Set(group.flatMap((item) => [...item.controlRoles]));
  const lifecycleStages = new Set(group.flatMap((item) => [...item.lifecycleStages]));
  const leafLabels = group.flatMap((item) => item.leafLabels);
  const label = buildClusterLabel(leafLabels, laneKinds, depth, sequenceIndex);

  return {
    key: group.map((item) => item.key).join('+'),
    label,
    functionIds,
    stepIds,
    storeKeys,
    relationKinds,
    objectTypes,
    laneKinds,
    controlRoles,
    lifecycleStages,
    routeSize: group.reduce((sum, item) => sum + item.routeSize, 0),
    leafLabels,
    node: {
      key: group.map((item) => item.key).join('+'),
      label,
      routeSize: group.reduce((sum, item) => sum + item.routeSize, 0),
      nodeCount: children.reduce((sum, item) => sum + (item.nodeCount || 0), 0),
      edgeCount: relationKinds.size,
      objectCount: objectTypes.size,
      objectTypes: [...objectTypes].sort(),
      primaryLaneKinds: [...laneKinds].sort(),
      controlRoleHints: [...controlRoles].sort(),
      lifecycleStageHints: [...lifecycleStages].sort(),
      relationKinds: [...relationKinds].sort(),
      actionKinds: normalizeStringList(group.flatMap((item) => item.node.actionKinds || [])),
      stores: normalizeStringList(group.flatMap((item) => item.node.stores || [])),
      children,
      reason: undefined,
    },
  };
}

function getDominantLaneKey(descriptor) {
  return [...descriptor.laneKinds].sort()[0] || 'unassigned';
}

function buildSimilarityHierarchy(descriptors, thresholds, depth = 0) {
  const seeds = descriptors.map(buildClusterSeed);
  const threshold = thresholds[Math.min(depth, thresholds.length - 1)];

  if (seeds.length <= 2 || depth >= thresholds.length) {
    return seeds.map((seed) => seed.node);
  }

  const visited = new Set();
  const groups = [];

  for (let index = 0; index < seeds.length; index += 1) {
    if (visited.has(index)) {
      continue;
    }

    const queue = [index];
    visited.add(index);
    const component = [];

    while (queue.length) {
      const currentIndex = queue.shift();
      const current = seeds[currentIndex];
      component.push(current);

      for (let nextIndex = 0; nextIndex < seeds.length; nextIndex += 1) {
        if (visited.has(nextIndex)) {
          continue;
        }

        const next = seeds[nextIndex];
        if (calculateClusterSimilarity(current, next) < threshold) {
          continue;
        }

        visited.add(nextIndex);
        queue.push(nextIndex);
      }
    }

    groups.push(component);
  }

  if (groups.length === 1 && groups[0].length === seeds.length) {
    const fallbackBuckets = new Map();
    seeds.forEach((seed) => {
      const bucketKey = getDominantLaneKey(seed.descriptor);
      const current = fallbackBuckets.get(bucketKey);
      if (current) {
        current.push(seed);
      } else {
        fallbackBuckets.set(bucketKey, [seed]);
      }
    });

    if (fallbackBuckets.size > 1) {
      return [...fallbackBuckets.entries()]
        .map(([bucketKey, bucket], bucketIndex) => {
          if (bucket.length === 1) {
            return bucket[0].node;
          }

          const childDescriptors = bucket.map((item) => item.descriptor);
          const nestedChildren = depth + 1 >= thresholds.length
            ? bucket.map((item) => item.node)
            : buildSimilarityHierarchy(childDescriptors, thresholds, depth + 1);
          const cluster = buildSyntheticCluster(bucket, nestedChildren, depth, bucketIndex);
          cluster.node.label = `${bucketKey} cluster`;
          return cluster.node;
        })
        .sort((left, right) => {
          if (right.routeSize !== left.routeSize) {
            return right.routeSize - left.routeSize;
          }

          return left.label.localeCompare(right.label);
        });
    }

    if (depth + 1 >= thresholds.length) {
      return seeds.map((seed) => seed.node);
    }

    return buildSimilarityHierarchy(descriptors, thresholds, depth + 1);
  }

  return groups.map((group, groupIndex) => {
    if (group.length === 1) {
      return group[0].node;
    }

    const childDescriptors = group.map((item) => item.descriptor);
    const nestedChildren = buildSimilarityHierarchy(childDescriptors, thresholds, depth + 1);
    return buildSyntheticCluster(group, nestedChildren.length ? nestedChildren : group.map((item) => item.node), depth, groupIndex).node;
  }).sort((left, right) => {
    if (right.routeSize !== left.routeSize) {
      return right.routeSize - left.routeSize;
    }

    return left.label.localeCompare(right.label);
  });
}

function sortHierarchyNodes(nodes) {
  return [...nodes].sort((left, right) => {
    if ((right.routeSize || 0) !== (left.routeSize || 0)) {
      return (right.routeSize || 0) - (left.routeSize || 0);
    }

    return String(left.label || '').localeCompare(String(right.label || ''));
  });
}

function buildSyntheticContainmentNode(label, children) {
  const routeSize = children.reduce((sum, child) => sum + (child.routeSize || 0), 0);
  const nodeCount = children.reduce((sum, child) => sum + (child.nodeCount || 0), 0);
  const objectCount = children.reduce((sum, child) => sum + (child.objectCount || 0), 0);

  return {
    key: `type:${label}`,
    label,
    routeSize,
    nodeCount,
    edgeCount: children.reduce((sum, child) => sum + (child.edgeCount || 0), 0),
    objectCount,
    objectTypes: normalizeStringList(children.flatMap((child) => child.objectTypes || [])),
    primaryLaneKinds: normalizeStringList(children.flatMap((child) => child.primaryLaneKinds || [])),
    controlRoleHints: normalizeStringList(children.flatMap((child) => child.controlRoleHints || [])),
    lifecycleStageHints: normalizeStringList(children.flatMap((child) => child.lifecycleStageHints || [])),
    relationKinds: normalizeStringList(children.flatMap((child) => child.relationKinds || [])),
    actionKinds: normalizeStringList(children.flatMap((child) => child.actionKinds || [])),
    stores: normalizeStringList(children.flatMap((child) => child.stores || [])),
    children,
    reason: 'type-containment',
  };
}

function buildSyntheticContainmentLeaf(label) {
  return {
    key: `type:${label}`,
    label,
    routeSize: 0,
    nodeCount: 0,
    edgeCount: 0,
    objectCount: 0,
    objectTypes: [],
    primaryLaneKinds: [],
    controlRoleHints: [],
    lifecycleStageHints: [],
    relationKinds: [],
    actionKinds: [],
    stores: [],
    children: [],
    reason: 'type-containment',
  };
}

function collectSubtreeLabels(node) {
  return [
    String(node?.label || '').trim(),
    ...normalizeStringList((node?.children || []).flatMap((child) => collectSubtreeLabels(child))),
  ].filter(Boolean);
}

function buildContainmentTokenCounts(node) {
  const tokenCounts = new Map();
  collectSubtreeLabels(node)
    .flatMap((label) => tokenizeLabel(label))
    .filter((token) => !CLUSTER_LABEL_STOP_WORDS.has(token))
    .forEach((token) => {
      tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
    });

  return tokenCounts;
}

function getDominantContainmentTokens(node) {
  const rankedTokens = [...buildContainmentTokenCounts(node).entries()]
    .sort((leftEntry, rightEntry) => rightEntry[1] - leftEntry[1] || leftEntry[0].localeCompare(rightEntry[0]));
  const highestCount = rankedTokens[0]?.[1] || 0;
  if (!highestCount) {
    return [];
  }

  return rankedTokens
    .filter(([, count]) => count >= Math.max(2, Math.ceil(highestCount * 0.6)))
    .slice(0, 4)
    .map(([token]) => token);
}

function buildContainmentClusterLabel(nodes, fallbackIndex) {
  const tokenCounts = new Map();
  nodes.forEach((node) => {
    new Set(buildContainmentTokenCounts(node).keys()).forEach((token) => {
      tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
    });
  });

  const selectedToken = [...tokenCounts.entries()]
    .filter(([, count]) => count >= Math.max(2, Math.ceil(nodes.length * 0.5)))
    .sort((leftEntry, rightEntry) => rightEntry[1] - leftEntry[1] || leftEntry[0].localeCompare(rightEntry[0]))[0]?.[0];

  if (selectedToken) {
    return `${selectedToken[0].toUpperCase()}${selectedToken.slice(1)} cluster`;
  }

  const fallbackToken = [...tokenCounts.entries()]
    .filter(([token]) => !CLUSTER_LABEL_STOP_WORDS.has(token))
    .sort((leftEntry, rightEntry) => rightEntry[1] - leftEntry[1] || leftEntry[0].localeCompare(rightEntry[0]))[0]?.[0];

  if (fallbackToken) {
    return `${fallbackToken[0].toUpperCase()}${fallbackToken.slice(1)} cluster`;
  }

  return `type cluster ${fallbackIndex + 1}`;
}

function calculateContainmentNodeSimilarity(leftNode, rightNode) {
  const leftTokens = new Set(collectSubtreeLabels(leftNode).flatMap((label) => tokenizeLabel(label)));
  const rightTokens = new Set(collectSubtreeLabels(rightNode).flatMap((label) => tokenizeLabel(label)));
  return calculateJaccard(leftTokens, rightTokens);
}

function buildFeatureLayerCandidates(nodes) {
  const candidatesByToken = new Map();

  nodes.forEach((node) => {
    const tokenCounts = buildContainmentTokenCounts(node);
    getDominantContainmentTokens(node).forEach((token) => {
      const current = candidatesByToken.get(token) || {
        token,
        label: `${token[0].toUpperCase()}${token.slice(1)}`,
        nodes: [],
        nodeKeys: new Set(),
        subtreeMentionCount: 0,
        totalChildCount: 0,
        totalRouteSize: 0,
        totalObjectCount: 0,
      };

      current.nodes.push(node);
      current.nodeKeys.add(String(node.key || node.label || ''));
      current.subtreeMentionCount += tokenCounts.get(token) || 0;
      current.totalChildCount += (node.children || []).length;
      current.totalRouteSize += node.routeSize || 0;
      current.totalObjectCount += node.objectCount || 0;
      candidatesByToken.set(token, current);
    });
  });

  const totalNodeCount = Math.max(nodes.length, 1);

  return [...candidatesByToken.values()]
    .map((candidate) => {
      const rootSupport = candidate.nodeKeys.size;
      const coverageRatio = rootSupport / totalNodeCount;
      const structureScore = candidate.totalChildCount + candidate.totalRouteSize + candidate.totalObjectCount;
      const isValid = rootSupport >= 2
        && coverageRatio <= 0.45
        && candidate.subtreeMentionCount >= rootSupport + 1
        && structureScore >= rootSupport;

      return {
        ...candidate,
        rootSupport,
        coverageRatio,
        structureScore,
        isValid,
        score: (rootSupport * 4) + candidate.subtreeMentionCount + Math.min(candidate.totalChildCount, 6),
      };
    })
    .filter((candidate) => candidate.isValid)
    .sort((left, right) => right.score - left.score || right.rootSupport - left.rootSupport || left.token.localeCompare(right.token));
}

function buildValidatedFeatureLayer(nodes) {
  const candidates = buildFeatureLayerCandidates(nodes);
  const assignedNodeKeys = new Set();
  const featureNodes = [];
  const featureCandidateSummaries = [];

  candidates.forEach((candidate) => {
    const availableNodes = candidate.nodes.filter((node) => !assignedNodeKeys.has(String(node.key || node.label || '')));
    if (availableNodes.length < 2) {
      return;
    }

    availableNodes.forEach((node) => {
      assignedNodeKeys.add(String(node.key || node.label || ''));
    });

    featureNodes.push({
      ...buildSyntheticContainmentNode(candidate.label, sortHierarchyNodes(availableNodes)),
      reason: 'feature-layer-candidate',
      featureToken: candidate.token,
    });
    featureCandidateSummaries.push({
      token: candidate.token,
      label: candidate.label,
      rootSupport: candidate.rootSupport,
      subtreeMentionCount: candidate.subtreeMentionCount,
      coverageRatio: candidate.coverageRatio,
      structureScore: candidate.structureScore,
      score: candidate.score,
      memberRootLabels: availableNodes.map((node) => String(node.label || '')).filter(Boolean).sort(),
    });
  });

  return {
    featureNodes: sortHierarchyNodes(featureNodes),
    featureCandidateSummaries,
    leftoverNodes: sortHierarchyNodes(nodes.filter((node) => !assignedNodeKeys.has(String(node.key || node.label || '')))),
  };
}

function mergeTopLevelContainmentClusters(nodes) {
  const mergedNodes = [];
  const clusterByLabel = new Map();

  nodes.forEach((node) => {
    const reason = String(node?.reason || '');
    if (!reason.startsWith('type-containment-') || !(node?.children || []).length) {
      mergedNodes.push(node);
      return;
    }

    const label = String(node.label || '').trim();
    if (!label) {
      mergedNodes.push(node);
      return;
    }

    const current = clusterByLabel.get(label);
    if (current) {
      current.push(node);
    } else {
      clusterByLabel.set(label, [node]);
    }
  });

  clusterByLabel.forEach((bucket, label) => {
    if (bucket.length === 1) {
      mergedNodes.push(bucket[0]);
      return;
    }

    mergedNodes.push({
      ...buildSyntheticContainmentNode(label, sortHierarchyNodes(bucket.flatMap((node) => node.children || []))),
      reason: 'type-containment-merged',
    });
  });

  return sortHierarchyNodes(mergedNodes);
}

function clusterTopLevelContainmentNodes(nodes, threshold = 0.2) {
  if (nodes.length <= 12) {
    return nodes;
  }

  const visited = new Set();
  const groups = [];

  for (let index = 0; index < nodes.length; index += 1) {
    if (visited.has(index)) {
      continue;
    }

    const queue = [index];
    const group = [];
    visited.add(index);

    while (queue.length) {
      const currentIndex = queue.shift();
      const currentNode = nodes[currentIndex];
      group.push(currentNode);

      for (let nextIndex = 0; nextIndex < nodes.length; nextIndex += 1) {
        if (visited.has(nextIndex)) {
          continue;
        }

        if (calculateContainmentNodeSimilarity(currentNode, nodes[nextIndex]) < threshold) {
          continue;
        }

        visited.add(nextIndex);
        queue.push(nextIndex);
      }
    }

    groups.push(group);
  }

  if (groups.every((group) => group.length === 1)) {
    return nodes;
  }

  return mergeTopLevelContainmentClusters(sortHierarchyNodes(groups.map((group, index) => {
    if (group.length === 1) {
      return group[0];
    }

    return {
      ...buildSyntheticContainmentNode(buildContainmentClusterLabel(group, index), sortHierarchyNodes(group)),
      reason: 'type-containment-cluster',
    };
  })));
}

function buildTypeContainmentHierarchy(descriptors, typeContainmentRows) {
  const descriptorByKey = new Map(descriptors.map((descriptor) => [descriptor.key, descriptor]));
  const relevantRows = typeContainmentRows
    .filter((row) => row.parentName !== row.childName)
    .filter((row) => !isGenericFamilyName(row.parentName))
    .filter((row) => !isGenericFamilyName(row.childName));

  if (!relevantRows.length) {
    return {
      nodes: [],
      usedDescriptorKeys: new Set(),
    };
  }

  const childToParents = new Map();
  const parentToChildren = new Map();
  relevantRows.forEach((row) => {
    const parents = childToParents.get(row.childName) || [];
    parents.push(row.parentName);
    childToParents.set(row.childName, parents);

    const children = parentToChildren.get(row.parentName) || new Set();
    children.add(row.childName);
    parentToChildren.set(row.parentName, children);
  });

  const assignedParentByChild = new Map();
  [...childToParents.entries()].forEach(([childName, parentNames]) => {
    const candidates = [...new Set(parentNames)].sort((left, right) => {
      const leftHasDescriptor = descriptorByKey.has(left) ? 1 : 0;
      const rightHasDescriptor = descriptorByKey.has(right) ? 1 : 0;
      if (rightHasDescriptor !== leftHasDescriptor) {
        return rightHasDescriptor - leftHasDescriptor;
      }

      const leftChildCount = parentToChildren.get(left)?.size || 0;
      const rightChildCount = parentToChildren.get(right)?.size || 0;
      if (rightChildCount !== leftChildCount) {
        return rightChildCount - leftChildCount;
      }

      return left.localeCompare(right);
    });

    const selectedParent = candidates.find((candidate) => candidate !== childName);
    if (selectedParent) {
      assignedParentByChild.set(childName, selectedParent);
    }
  });

  const childrenByParent = new Map();
  [...assignedParentByChild.entries()].forEach(([childName, parentName]) => {
    const currentChildren = childrenByParent.get(parentName) || [];
    currentChildren.push(childName);
    childrenByParent.set(parentName, currentChildren);
  });

  const usedDescriptorKeys = new Set();
  const cache = new Map();
  const visiting = new Set();

  function buildNode(name) {
    if (cache.has(name)) {
      return cache.get(name);
    }

    if (visiting.has(name)) {
      return undefined;
    }

    visiting.add(name);
    const childNames = sortHierarchyNodes((childrenByParent.get(name) || [])
      .map((childName) => buildNode(childName))
      .filter(Boolean));
    const descriptor = descriptorByKey.get(name);
    let node;

    if (descriptor) {
      usedDescriptorKeys.add(name);
      node = {
        ...buildLeafNode(descriptor),
        children: childNames,
        reason: childNames.length ? 'type-containment' : undefined,
      };
    } else if (childNames.length) {
      node = buildSyntheticContainmentNode(name, childNames);
    } else {
      node = buildSyntheticContainmentLeaf(name);
    }

    visiting.delete(name);
    if (node) {
      cache.set(name, node);
    }
    return node;
  }

  const rootNames = [...new Set([
    ...childrenByParent.keys(),
    ...descriptors.map((descriptor) => descriptor.key),
  ])].filter((name) => !assignedParentByChild.has(name));
  const nodes = sortHierarchyNodes(rootNames.map((name) => buildNode(name)).filter(Boolean));

  return {
    nodes,
    usedDescriptorKeys,
  };
}

function buildHierarchy(descriptors, typeContainmentRows = []) {
  const containmentHierarchy = buildTypeContainmentHierarchy(descriptors, typeContainmentRows);
  const leftoverDescriptors = descriptors.filter((descriptor) => !containmentHierarchy.usedDescriptorKeys.has(descriptor.key));
  const fallbackChildren = leftoverDescriptors.length
    ? buildSimilarityHierarchy(leftoverDescriptors, [0.08, 0.14, 0.22])
    : [];
  const baseRootChildren = sortHierarchyNodes([...containmentHierarchy.nodes, ...fallbackChildren]);
  const featureLayer = buildValidatedFeatureLayer(baseRootChildren);
  const clusteredLeftovers = clusterTopLevelContainmentNodes(featureLayer.leftoverNodes);
  const rootChildren = mergeTopLevelContainmentClusters(sortHierarchyNodes([...featureLayer.featureNodes, ...clusteredLeftovers]));

  return {
    key: 'runtime',
    label: 'Application runtime',
    children: rootChildren,
    featureLayerCandidates: featureLayer.featureCandidateSummaries,
  };
}

function renderHierarchyText(tree) {
  const lines = [tree.label];

  function walk(node, prefix, isLast) {
    const branch = isLast ? '└─ ' : '├─ ';
    lines.push(`${prefix}${branch}${node.label}`);
    const nextPrefix = `${prefix}${isLast ? '   ' : '│  '}`;
    node.children.forEach((child, index) => {
      walk(child, nextPrefix, index === node.children.length - 1);
    });
  }

  tree.children.forEach((child, index) => {
    walk(child, '', index === tree.children.length - 1);
  });

  return lines.join('\n');
}

export async function loadFunctionalityTreeFromGraph(driver, database, {
  minStepCount = 6,
  specificityPercentile = 0.88,
} = {}) {
  const [records, typeContainmentRows] = await Promise.all([
    runReadQuery(
      driver,
      database,
      `
        MATCH (step:Step)-[rel]->(object:FlowObject)
        WHERE type(rel) IN $relTypes
        OPTIONAL MATCH (fn:Fn {stableId: step.parentFnStableId})
        RETURN object.object_key AS objectKey,
               object.object_name AS objectName,
               object.object_type AS objectType,
               coalesce(object.object_types, []) AS objectTypes,
               step.stableId AS stepStableId,
               step.operation_code AS operationCode,
               fn.stableId AS fnStableId,
               fn.primary_lane_kind AS primaryLaneKind,
               coalesce(fn.control_role_hints, []) AS controlRoleHints,
               coalesce(fn.lifecycle_stage_hints, []) AS lifecycleStageHints,
               type(rel) AS relType,
               rel.action_kind AS actionKind,
               rel.store_key AS storeKey,
               rel.store_name AS storeName
        ORDER BY fnStableId, stepStableId
      `,
      { relTypes: OBJECT_REL_TYPES },
    ),
    runReadQuery(
      driver,
      database,
      `
        MATCH (parent:BusinessObjectType)-[rel:CONTAINS_TYPE]->(child:BusinessObjectType)
        RETURN parent.name AS parentName,
               child.name AS childName,
               rel.container_kind AS containerKind,
               rel.field_name AS fieldName,
               rel.field_path AS fieldPath
      `,
      {},
    ).catch(() => []),
  ]);

  const routeByFamily = new Map();
  records.forEach((row) => {
    const familyKey = pickObjectFamily(row);
    if (!familyKey || isGenericFamilyName(familyKey)) {
      return;
    }

    let route = routeByFamily.get(familyKey);
    if (!route) {
      route = createFamilyAggregate(familyKey);
      routeByFamily.set(familyKey, route);
    }

    if (row.objectKey) {
      route.objectKeys.add(String(row.objectKey));
    }
    normalizeStringList(row.objectTypes).forEach((value) => route.objectTypes.add(value));
    if (row.objectType) {
      route.objectTypes.add(String(row.objectType));
    }
    if (row.stepStableId) {
      route.stepIds.add(String(row.stepStableId));
    }
    if (row.fnStableId) {
      route.functionIds.add(String(row.fnStableId));
    }
    if (row.relType) {
      route.relationKinds.add(String(row.relType));
    }
    if (row.actionKind) {
      route.actionKinds.add(String(row.actionKind));
    }
    if (row.primaryLaneKind) {
      route.laneKinds.add(String(row.primaryLaneKind));
    }
    normalizeStringList(row.controlRoleHints).forEach((value) => route.controlRoles.add(value));
    normalizeStringList(row.lifecycleStageHints).forEach((value) => route.lifecycleStages.add(value));
    if (row.storeKey) {
      route.storeKeys.add(String(row.storeKey));
    }
    if (row.storeName) {
      route.storeNames.add(String(row.storeName));
    }
  });

  const routes = [...routeByFamily.values()].map(buildRouteDescriptor);
  const maxSpecificStepCount = buildStepThreshold(routes.map((route) => route.stepIds.size), specificityPercentile);
  const filteredRoutes = routes.filter((route) => route.stepIds.size >= minStepCount)
    .filter((route) => !maxSpecificStepCount || route.stepIds.size <= maxSpecificStepCount);

  if (!filteredRoutes.length && !typeContainmentRows.length) {
    return {
      available: false,
      error: 'No FlowObject families or BusinessObjectType containment edges with sufficient graph support were found.',
      routeCount: 0,
      text: null,
      payload: null,
    };
  }

  const descriptors = filteredRoutes
    .filter((descriptor) => descriptor.key && descriptor.stepIds.size);
  const tree = buildHierarchy(descriptors, typeContainmentRows);

  return {
    available: true,
    error: null,
    routeCount: filteredRoutes.length,
    text: renderHierarchyText(tree),
    payload: JSON.stringify({
      root: tree,
      routeCount: filteredRoutes.length,
      descriptors: descriptors.map((descriptor) => ({
        key: descriptor.key,
        routeSize: descriptor.routeSize,
        nodeCount: descriptor.stepIds.size,
        edgeCount: descriptor.relationKinds.size,
        objectCount: descriptor.objectKeys.size,
        objectTypes: [...descriptor.objectTypes].sort(),
        primaryLaneKinds: [...descriptor.laneKinds].sort(),
        controlRoleHints: [...descriptor.controlRoles].sort(),
        lifecycleStageHints: [...descriptor.lifecycleStages].sort(),
        stores: [...descriptor.storeNames].sort(),
      })),
      featureLayerCandidates: tree.featureLayerCandidates,
      validatedFeatureCandidates: tree.featureLayerCandidates,
      featureLayerRootLabels: tree.children
        .filter((child) => child.reason === 'feature-layer-candidate')
        .map((child) => child.label),
      featureLayerValidation: {
        minRootSupport: 2,
        maxCoverageRatio: 0.45,
        minSubtreeMentionsOffset: 1,
        minStructureScorePerRoot: 1,
      },
      typeContainmentEdgeCount: typeContainmentRows.length,
    }),
  };
}