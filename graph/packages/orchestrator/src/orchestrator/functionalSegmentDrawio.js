import crypto from 'node:crypto';

import neo4j from 'neo4j-driver';

import { isFunctionalSegmentVisibleRelationship } from './relationshipSemantics.js';

const MARGIN = 50;
const TITLE_HEIGHT = 90;
const LEVEL_HEIGHT = 175;
const NODE_WIDTH = 230;
const NODE_HEIGHT = 62;
const ANNOTATED_NODE_WIDTH = 420;
const ANNOTATED_NODE_HEIGHT = 132;
const NODE_GAP = 46;

function renderedNodeWidth(node) {
  return node.annotation ? ANNOTATED_NODE_WIDTH : NODE_WIDTH;
}

function renderedNodeHeight(node) {
  return node.annotation ? ANNOTATED_NODE_HEIGHT : NODE_HEIGHT;
}

function normalize(value) {
  if (neo4j.isInt(value)) return value.inSafeRange() ? value.toNumber() : value.toString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cellId(prefix, stableId) {
  return `${prefix}-${crypto.createHash('sha1').update(String(stableId)).digest('hex').slice(0, 14)}`;
}

function graphKind(node) {
  const labels = new Set(node.labels || []);
  if (labels.has('System')) return 'System';
  if (labels.has('ResolvedCall')) return 'ResolvedCall';
  if (labels.has('ArgumentObjectValue')) return 'ArgumentObjectValue';
  if (labels.has('ShorthandPropertyReference')) return 'ShorthandPropertyReference';
  if (labels.has('TypeDeclaration')) return 'TypeDeclaration';
  if (labels.has('Component')) return 'Component';
  if (labels.has('Call')) return 'Call';
  if (labels.has('Reference')) return 'Reference';
  if (labels.has('ArgumentValue')) return 'ArgumentValue';
  if (labels.has('PropertyValue')) return 'PropertyValue';
  if (labels.has('ObjectConstruction')) return 'ObjectConstruction';
  if (labels.has('DeveloperDefined')) return 'DeveloperDefined';
  return labels.values().next().value || 'GraphNode';
}

function nodeStyle(node, isRoot) {
  const kind = graphKind(node);
  if (isRoot) return 'fillColor=#b7e1cd;strokeColor=#1b7f5a;strokeWidth=3;';
  if (kind === 'System') return 'fillColor=#f5f5f5;strokeColor=#666666;strokeWidth=2;';
  if (kind === 'ResolvedCall') return 'fillColor=#ffe6cc;strokeColor=#b45f06;strokeWidth=2;';
  if (kind === 'ArgumentObjectValue') return 'fillColor=#fff2cc;strokeColor=#bf9000;strokeWidth=2;';
  if (kind === 'ShorthandPropertyReference') return 'fillColor=#d9eaf7;strokeColor=#4f81bd;strokeWidth=2;';
  if (kind === 'TypeDeclaration') return 'fillColor=#e1d5e7;strokeColor=#9673a6;strokeWidth=2;';
  if (kind === 'Component') return 'fillColor=#a9d08e;strokeColor=#548235;strokeWidth=3;';
  if (kind === 'DeveloperDefined') return 'fillColor=#d5e8d4;strokeColor=#82b366;strokeWidth=2;';
  if (kind === 'Call') return 'fillColor=#ffe6cc;strokeColor=#d79b00;';
  if (kind === 'Reference') return 'fillColor=#dae8fc;strokeColor=#6c8ebf;';
  if (kind === 'ArgumentValue' || kind === 'PropertyValue' || kind === 'ObjectConstruction') {
    return 'fillColor=#fff2cc;strokeColor=#d6b656;';
  }
  return 'fillColor=#f5f5f5;strokeColor=#888888;';
}

function sourceRange(stableId) {
  return String(stableId || '').replace(
    /:(?:property-value|value-reference|object-construction|argument-value:\d+)$/,
    '',
  );
}

export function collapseSameRangeValueRoles(segment) {
  const nodeById = new Map((segment.nodes || []).map((node) => [node.stableId, node]));
  const representativeById = new Map();
  const collapsedIdsByRepresentative = new Map();

  function collapseInto(representativeStableId, collapsedStableId) {
    representativeById.set(collapsedStableId, representativeStableId);
    const collapsedStableIds = collapsedIdsByRepresentative.get(representativeStableId)
      || [representativeStableId];
    if (!collapsedStableIds.includes(collapsedStableId)) collapsedStableIds.push(collapsedStableId);
    collapsedIdsByRepresentative.set(representativeStableId, collapsedStableIds);
  }

  for (const edge of segment.edges || []) {
    if (edge.type !== 'VALUE_FROM') continue;
    const property = nodeById.get(edge.sourceStableId);
    const reference = nodeById.get(edge.targetStableId);
    if (!property || !reference) continue;
    const sourceLabels = new Set(property.labels || []);
    const targetLabels = new Set(reference.labels || []);
    const isShorthandProperty = sourceLabels.has('PropertyValue')
      && targetLabels.has('ValueReference')
      && property.name === reference.name;
    const isArgumentObject = sourceLabels.has('ArgumentValue') && targetLabels.has('ObjectConstruction');
    if ((!isShorthandProperty && !isArgumentObject)
      || sourceRange(property.stableId) !== sourceRange(reference.stableId)) continue;
    collapseInto(property.stableId, reference.stableId);
  }

  const callsWithSelectedDeclaration = new Set((segment.edges || [])
    .filter((edge) => edge.type === 'CALLS')
    .map((edge) => edge.sourceStableId));
  const referencesAbsorbedByResolvedCall = new Set();
  for (const edge of segment.edges || []) {
    if (edge.type !== 'CALLS_VALUE' || !callsWithSelectedDeclaration.has(edge.sourceStableId)) continue;
    const call = nodeById.get(edge.sourceStableId);
    const reference = nodeById.get(edge.targetStableId);
    if (!(call?.labels || []).includes('Call') || !(reference?.labels || []).includes('Reference')) continue;
    collapseInto(call.stableId, reference.stableId);
    referencesAbsorbedByResolvedCall.add(reference.stableId);
  }

  if (!representativeById.size) return segment;
  const representative = (stableId) => representativeById.get(stableId) || stableId;
  const nodes = [];
  for (const node of segment.nodes) {
    if (representativeById.has(node.stableId)) continue;
    const collapsedStableIds = collapsedIdsByRepresentative.get(node.stableId);
    if (!collapsedStableIds) {
      nodes.push(node);
      continue;
    }
    const mergedNodes = collapsedStableIds.map((stableId) => nodeById.get(stableId)).filter(Boolean);
    const isArgumentObject = mergedNodes.some((mergedNode) => (mergedNode.labels || []).includes('ArgumentValue'))
      && mergedNodes.some((mergedNode) => (mergedNode.labels || []).includes('ObjectConstruction'));
    const isResolvedCall = mergedNodes.some((mergedNode) => (mergedNode.labels || []).includes('Call'))
      && mergedNodes.some((mergedNode) => (mergedNode.labels || []).includes('Reference'));
    nodes.push({
      ...node,
      name: isArgumentObject
        ? `${node.name || 'argument'}: ${mergedNodes.find((mergedNode) => (
          (mergedNode.labels || []).includes('ObjectConstruction')
        ))?.name || 'object literal'}`
        : node.name,
      labels: [...new Set([
        ...mergedNodes.flatMap((mergedNode) => mergedNode.labels || []),
        isResolvedCall
          ? 'ResolvedCall'
          : isArgumentObject
            ? 'ArgumentObjectValue'
            : 'ShorthandPropertyReference',
      ])],
      collapsedStableIds,
    });
  }

  const edgeByKey = new Map();
  for (const edge of segment.edges || []) {
    if (!isFunctionalSegmentVisibleRelationship(edge.type)) continue;
    if (edge.type === 'RESOLVES_TO' && referencesAbsorbedByResolvedCall.has(edge.sourceStableId)) continue;
    const sourceStableId = representative(edge.sourceStableId);
    const targetStableId = representative(edge.targetStableId);
    if (sourceStableId === targetStableId) continue;
    const renderedEdge = {
      ...edge,
      sourceStableId,
      targetStableId,
      extractedSourceStableId: edge.sourceStableId,
      extractedTargetStableId: edge.targetStableId,
    };
    edgeByKey.set(`${sourceStableId}\u0000${edge.type}\u0000${targetStableId}`, renderedEdge);
  }
  const edges = [...edgeByKey.values()];
  const connectedNodeIds = new Set([segment.rootStableId]);
  for (const edge of edges) {
    connectedNodeIds.add(edge.sourceStableId);
    connectedNodeIds.add(edge.targetStableId);
  }
  return {
    ...segment,
    nodes: nodes.filter((node) => connectedNodeIds.has(node.stableId) || node.annotation),
    edges,
  };
}

export const collapseShorthandPropertyReferences = collapseSameRangeValueRoles;

export function hideRootTypeContext(segment) {
  const hiddenNodeIds = new Set((segment.edges || [])
    .filter((edge) => edge.sourceStableId === segment.rootStableId && edge.type === 'TYPED_AS')
    .map((edge) => edge.targetStableId));
  if (!hiddenNodeIds.size) return segment;
  return {
    ...segment,
    nodes: segment.nodes.filter((node) => !hiddenNodeIds.has(node.stableId)),
    edges: segment.edges.filter((edge) => (
      !hiddenNodeIds.has(edge.sourceStableId) && !hiddenNodeIds.has(edge.targetStableId)
    )),
  };
}

export function buildLayout(segment) {
  const adjacency = new Map(segment.nodes.map((node) => [node.stableId, []]));
  for (const edge of segment.edges) {
    adjacency.get(edge.sourceStableId)?.push(edge.targetStableId);
    adjacency.get(edge.targetStableId)?.push(edge.sourceStableId);
  }
  for (const neighbors of adjacency.values()) neighbors.sort();
  const depth = new Map([[segment.rootStableId, 0]]);
  const parent = new Map([[segment.rootStableId, null]]);
  const queue = [segment.rootStableId];
  while (queue.length) {
    const current = queue.shift();
    const nextDepth = depth.get(current) + 1;
    for (const neighbor of adjacency.get(current) || []) {
      if (depth.has(neighbor)) continue;
      depth.set(neighbor, nextDepth);
      parent.set(neighbor, current);
      queue.push(neighbor);
    }
  }
  let disconnectedDepth = Math.max(0, ...depth.values()) + 1;
  for (const node of segment.nodes) {
    if (!depth.has(node.stableId)) depth.set(node.stableId, disconnectedDepth++);
  }

  const children = new Map(segment.nodes.map((node) => [node.stableId, []]));
  for (const [stableId, parentStableId] of parent) {
    if (parentStableId != null) children.get(parentStableId)?.push(stableId);
  }
  for (const childIds of children.values()) childIds.sort();
  const branchPoint = [...depth.entries()]
    .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
    .find(([stableId]) => (children.get(stableId) || []).length >= 3)?.[0] || null;
  const branchHeads = branchPoint ? children.get(branchPoint) : [];
  const laneByNode = new Map();
  branchHeads.forEach((head, lane) => {
    const laneQueue = [head];
    while (laneQueue.length) {
      const current = laneQueue.shift();
      if (laneByNode.has(current)) continue;
      laneByNode.set(current, lane);
      laneQueue.push(...(children.get(current) || []));
    }
  });

  const laneCount = Math.max(1, branchHeads.length);
  const canvasWidth = Math.max(
    1200,
    MARGIN * 2 + laneCount * ANNOTATED_NODE_WIDTH + Math.max(0, laneCount - 1) * NODE_GAP,
  );
  const levels = new Map();
  for (const node of segment.nodes) {
    const nodeDepth = depth.get(node.stableId);
    if (!levels.has(nodeDepth)) levels.set(nodeDepth, []);
    levels.get(nodeDepth).push(node);
  }
  const positions = new Map();
  let y = TITLE_HEIGHT;
  for (const [, nodes] of [...levels].sort(([left], [right]) => left - right)) {
    const groups = new Map();
    for (const node of nodes) {
      const lane = laneByNode.get(node.stableId);
      const groupKey = lane == null ? 'trunk' : lane;
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push(node);
    }
    for (const group of groups.values()) group.sort((left, right) => left.stableId.localeCompare(right.stableId));
    let levelHeight = 0;
    for (const group of groups.values()) {
      const groupHeight = group.reduce((sum, node, index) => (
        sum + renderedNodeHeight(node) + (index ? 24 : 0)
      ), 0);
      levelHeight = Math.max(levelHeight, groupHeight);
    }
    for (const [groupKey, group] of groups) {
      let groupY = y;
      for (const node of group) {
        const width = renderedNodeWidth(node);
        const x = groupKey === 'trunk'
          ? (canvasWidth - width) / 2
          : MARGIN + Number(groupKey) * (ANNOTATED_NODE_WIDTH + NODE_GAP)
            + (ANNOTATED_NODE_WIDTH - width) / 2;
        positions.set(node.stableId, { x, y: groupY, lane: groupKey });
        groupY += renderedNodeHeight(node) + 24;
      }
    }
    y += Math.max(LEVEL_HEIGHT, levelHeight + 43);
  }
  const canvasHeight = y + MARGIN;
  return { positions, canvasWidth, canvasHeight, branchPoint, branchHeads, laneByNode };
}

export function renderFunctionalSegmentDrawio(segment) {
  if (!segment?.rootStableId || !segment.nodes?.length) {
    throw new Error('Functional segment has no root or source-graph nodes.');
  }
  const renderedSegment = collapseSameRangeValueRoles(hideRootTypeContext(segment));
  const layout = buildLayout(renderedSegment);
  const lines = [];
  lines.push('<mxfile host="app.diagrams.net" version="24.7.17">');
  lines.push('<diagram id="functional-source-segment" name="Functional Source Segment">');
  lines.push(`<mxGraphModel grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${layout.canvasWidth}" pageHeight="${layout.canvasHeight}" math="0" shadow="0">`);
  lines.push('<root>');
  lines.push('<mxCell id="0" />');
  lines.push('<mxCell id="1" parent="0" />');
  lines.push(`<mxCell id="functional-title" value="${escapeXml(`Граф TypeScript от ${segment.rootLabel || segment.rootStableId}`)}" style="text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;whiteSpace=wrap;fontSize=16;fontStyle=1;" vertex="1" parent="1"><mxGeometry x="${MARGIN}" y="20" width="900" height="44" as="geometry" /></mxCell>`);

  for (const node of renderedSegment.nodes) {
    const position = layout.positions.get(node.stableId);
    const id = cellId('source-node', node.stableId);
    const kind = graphKind(node);
    const labels = (node.labels || []).join(',');
    const label = node.name || node.syntax || node.stableId;
    const collapsedStableIds = node.collapsedStableIds || [node.stableId];
    const value = node.annotation
      ? `<div style="font-weight:bold;text-align:center;">${label}</div><hr/><div style="font-weight:normal;text-align:left;">${node.annotation}</div>`
      : label;
    const annotationAttributes = node.annotation
      ? ` annotationEmbedded="1" annotationSavedText="${escapeXml(node.annotation)}"`
      : '';
    lines.push(`<mxCell id="${id}" stableId="${escapeXml(node.stableId)}" collapsedStableIds="${escapeXml(collapsedStableIds.join('|'))}" graphKind="${escapeXml(kind)}" graphLabel="${escapeXml(label)}" graphLabels="${escapeXml(labels)}"${annotationAttributes} value="${escapeXml(value)}" tooltip="${escapeXml(collapsedStableIds.join('\n'))}" style="rounded=1;whiteSpace=wrap;html=1;${nodeStyle(node, node.stableId === segment.rootStableId)}fontColor=#1f1f1f;fontSize=11;fontStyle=${node.annotation ? 0 : 1};align=center;verticalAlign=middle;spacing=8;" vertex="1" parent="1"><mxGeometry x="${position.x}" y="${position.y}" width="${renderedNodeWidth(node)}" height="${renderedNodeHeight(node)}" as="geometry" /></mxCell>`);
  }

  renderedSegment.edges.forEach((edge, index) => {
    lines.push(`<mxCell id="source-edge-${index}" edgeType="${escapeXml(edge.type)}" extractedSourceStableId="${escapeXml(edge.extractedSourceStableId || edge.sourceStableId)}" extractedTargetStableId="${escapeXml(edge.extractedTargetStableId || edge.targetStableId)}" value="${escapeXml(edge.type)}" style="edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;strokeColor=#4f5f70;strokeWidth=1.7;endArrow=block;endFill=1;fontSize=9;" edge="1" source="${cellId('source-node', edge.sourceStableId)}" target="${cellId('source-node', edge.targetStableId)}" parent="1"><mxGeometry relative="1" as="geometry" /></mxCell>`);
  });

  lines.push('</root>');
  lines.push('</mxGraphModel>');
  lines.push('</diagram>');
  lines.push('</mxfile>');
  return { xml: lines.join('\n'), width: layout.canvasWidth, height: layout.canvasHeight };
}

function mergeGraphPart(nodeById, edgeByKey, part) {
  for (const node of part?.nodes || []) {
    if (node?.stableId) nodeById.set(node.stableId, { ...nodeById.get(node.stableId), ...node });
  }
  for (const edge of part?.edges || []) {
    if (!edge?.sourceStableId || !edge?.targetStableId || !edge?.type) continue;
    edgeByKey.set(`${edge.sourceStableId}\u0000${edge.type}\u0000${edge.targetStableId}`, edge);
  }
}

export function projectFunctionalSegment(segment) {
  const nodeById = new Map((segment.nodes || []).map((node) => [node.stableId, node]));
  if (!nodeById.has(segment.rootStableId)) return segment;

  const adjacency = new Map([...nodeById.keys()].map((stableId) => [stableId, []]));
  for (const edge of segment.edges || []) {
    if (!nodeById.has(edge.sourceStableId) || !nodeById.has(edge.targetStableId)) continue;
    adjacency.get(edge.sourceStableId).push({ stableId: edge.targetStableId, edge });
    adjacency.get(edge.targetStableId).push({ stableId: edge.sourceStableId, edge });
  }

  const anchors = new Set([segment.rootStableId]);
  for (const node of nodeById.values()) {
    const labels = new Set(node.labels || []);
    if (node.annotation || labels.has('System')) anchors.add(node.stableId);
  }
  const previous = new Map([[segment.rootStableId, null]]);
  const previousEdge = new Map();
  const queue = [segment.rootStableId];
  while (queue.length) {
    const current = queue.shift();
    for (const next of adjacency.get(current) || []) {
      if (previous.has(next.stableId)) continue;
      previous.set(next.stableId, current);
      previousEdge.set(next.stableId, next.edge);
      queue.push(next.stableId);
    }
  }

  const keptNodeIds = new Set([segment.rootStableId]);
  const keptEdgeKeys = new Set();
  for (const anchor of anchors) {
    if (!previous.has(anchor)) continue;
    let current = anchor;
    while (current !== segment.rootStableId) {
      const edge = previousEdge.get(current);
      const parent = previous.get(current);
      if (!edge || parent == null) break;
      keptNodeIds.add(current);
      keptNodeIds.add(parent);
      keptEdgeKeys.add(`${edge.sourceStableId}\u0000${edge.type}\u0000${edge.targetStableId}`);
      current = parent;
    }
  }

  return {
    ...segment,
    nodes: segment.nodes.filter((node) => keptNodeIds.has(node.stableId)),
    edges: segment.edges.filter((edge) => keptEdgeKeys.has(
      `${edge.sourceStableId}\u0000${edge.type}\u0000${edge.targetStableId}`,
    )),
  };
}

export async function loadFunctionalSegmentWithoutAnnotations(driver, database, rootStableId) {
  const session = driver.session({ database, defaultAccessMode: neo4j.session.READ });
  try {
    const rootResult = await session.run(`
      MATCH (root {stableId: $rootStableId})
      OPTIONAL MATCH (origin)-[binding:BINDS_TO_PARAMETER]->(root)
      WITH root, origin, binding,
           CASE WHEN origin.stableId STARTS WITH 'components/PromptInput/' THEN 0 ELSE 1 END AS originPriority
      ORDER BY originPriority, origin.stableId
      WITH root, collect({origin: origin, binding: binding})[0] AS selectedOrigin
      RETURN root.name AS rootLabel,
             {stableId: root.stableId, name: root.name, syntax: root.syntax, labels: labels(root)} AS root,
             CASE WHEN selectedOrigin.origin IS NULL THEN null ELSE {
               elementId: elementId(selectedOrigin.origin),
               stableId: selectedOrigin.origin.stableId,
               name: selectedOrigin.origin.name,
               syntax: selectedOrigin.origin.syntax,
               labels: labels(selectedOrigin.origin)
             } END AS origin,
             CASE WHEN selectedOrigin.binding IS NULL THEN null ELSE {
               sourceStableId: startNode(selectedOrigin.binding).stableId,
               targetStableId: endNode(selectedOrigin.binding).stableId,
               type: type(selectedOrigin.binding)
             } END AS binding
    `, { rootStableId });
    if (!rootResult.records.length) throw new Error(`Functional segment root not found: ${rootStableId}.`);
    const rootRow = normalize(rootResult.records[0].toObject());
    const originStableId = rootRow.origin?.stableId || rootStableId;
    const nodeById = new Map([[rootRow.root.stableId, rootRow.root]]);
    const edgeByKey = new Map();
    if (rootRow.origin?.stableId) nodeById.set(rootRow.origin.stableId, rootRow.origin);
    if (rootRow.binding) mergeGraphPart(nodeById, edgeByKey, { edges: [rootRow.binding] });

    const visited = new Set([rootStableId, originStableId]);
    let frontier = rootRow.origin?.elementId ? [rootRow.origin.elementId] : [];
    for (let depth = 0; depth < 12 && frontier.length; depth += 1) {
      const stepResult = await session.run(`
        UNWIND $frontier AS sourceElementId
        MATCH (source) WHERE elementId(source) = sourceElementId
        MATCH (source)-[relationship:HAS_PROPERTY|VALUE_FROM|RESOLVES_TO|SELECTS_RETURN_PROPERTY|HAS_OPERATION|CALLS|CALLS_VALUE|READS_FROM|WRITES_TO]->(target)
        RETURN {elementId: elementId(target), stableId: target.stableId, name: target.name, syntax: target.syntax, labels: labels(target)} AS target,
               {sourceStableId: source.stableId, targetStableId: target.stableId, type: type(relationship)} AS edge
        LIMIT 5000
      `, { frontier });
      const next = [];
      for (const record of stepResult.records) {
        const row = normalize(record.toObject());
        if (!row.target?.stableId) continue;
        mergeGraphPart(nodeById, edgeByKey, { nodes: [row.target], edges: [row.edge] });
        if (!visited.has(row.target.stableId) && !row.target.labels.includes('System')) {
          visited.add(row.target.stableId);
          next.push(row.target.elementId);
        }
      }
      frontier = [...new Set(next)].slice(0, 512);
    }

    return projectFunctionalSegment({
      rootStableId,
      rootLabel: rootRow.rootLabel || rootRow.root.name || rootStableId,
      nodes: [...nodeById.values()].map((node) => ({ ...node, annotation: null })),
      edges: [...edgeByKey.values()],
    });
  } finally {
    await session.close();
  }
}

export async function loadFunctionalSegment(driver, database, rootStableId) {
  const session = driver.session({ database, defaultAccessMode: neo4j.session.READ });
  try {
    const annotationResult = await session.run(`
      MATCH (root:DeveloperDefined {stableId: $rootStableId})-[:HAS_ANNOTATION]->(rootAnnotation:Annotation {
        profileId: 'functional-accumulation', status: 'ready'
      })
      WITH root, rootAnnotation ORDER BY rootAnnotation.updatedAt DESC LIMIT 1
      MATCH path=(rootAnnotation)-[:DEPENDS_ON*0..32]->(annotation:Annotation)
      WITH root, annotation, min(length(path)) AS annotationDepth
      MATCH (subject:DeveloperDefined)-[:HAS_ANNOTATION]->(annotation)
      OPTIONAL MATCH (annotation)-[:DEPENDS_ON]->(childAnnotation:Annotation)<-[:HAS_ANNOTATION]-(childSubject:DeveloperDefined)
      RETURN root.name AS rootLabel,
             subject.stableId AS stableId,
             subject.name AS name,
             labels(subject) AS labels,
             subject.syntax AS syntax,
             annotation.text AS annotation,
             annotationDepth,
             collect(DISTINCT childSubject.stableId) AS childStableIds
      ORDER BY annotationDepth, stableId
    `, { rootStableId });
    if (!annotationResult.records.length) {
      throw new Error(`No ready functional-accumulation annotation starts at ${rootStableId}.`);
    }
    const annotationRows = annotationResult.records.map((record) => normalize(record.toObject()));
    const annotationByStableId = new Map(annotationRows.map((row) => [row.stableId, row.annotation]));
    const pairs = annotationRows.flatMap((row) => row.childStableIds.filter(Boolean).map((targetStableId) => ({
      sourceStableId: row.stableId,
      targetStableId,
    })));
    const leaves = annotationRows.filter((row) => !row.childStableIds.filter(Boolean).length).map((row) => row.stableId);
    const nodeById = new Map();
    const edgeByKey = new Map();

    const pathResult = await session.run(`
      UNWIND $pairs AS pair
      MATCH (parent:DeveloperDefined {stableId: pair.sourceStableId})
      MATCH (child:DeveloperDefined {stableId: pair.targetStableId})
      CALL (parent, child) {
        MATCH path=(parent)-[:VALUE_FROM|RESOLVES_TO|SELECTS_RETURN_PROPERTY|HAS_OPERATION|CALLS|WRITES_TO*1..12]->(child)
        WHERE none(node IN nodes(path)[1..-1] WHERE node:DeveloperDefined OR node:System)
        RETURN path, null AS binding, length(path) AS distance
        UNION
        MATCH (origin)-[binding:BINDS_TO_PARAMETER]->(parent)
        WHERE parent:Parameter
          AND (binding.resolution = 'typescript-checker-jsx-prop-flow' OR binding.resolution = 'typescript-checker')
        MATCH path=(origin)-[:VALUE_FROM|HAS_PROPERTY|RESOLVES_TO|SELECTS_RETURN_PROPERTY|HAS_OPERATION|CALLS|WRITES_TO*1..12]->(child)
        WHERE none(node IN nodes(path)[0..-1] WHERE node:DeveloperDefined OR node:System)
        RETURN path, binding, 1 + length(path) AS distance
      }
      WITH pair, path, binding, distance ORDER BY pair.sourceStableId, pair.targetStableId, distance, head(nodes(path)).stableId
      WITH pair, collect({path: path, binding: binding})[0] AS selected
      RETURN pair,
             [node IN nodes(selected.path) | {
               stableId: node.stableId, name: node.name, syntax: node.syntax, labels: labels(node)
             }] + [{stableId: pair.sourceStableId, name: null, syntax: null, labels: []}] AS nodes,
             [relationship IN relationships(selected.path) | {
               sourceStableId: startNode(relationship).stableId,
               targetStableId: endNode(relationship).stableId,
               type: type(relationship)
             }] + CASE WHEN selected.binding IS NULL THEN [] ELSE [{
               sourceStableId: startNode(selected.binding).stableId,
               targetStableId: endNode(selected.binding).stableId,
               type: type(selected.binding)
             }] END AS edges
    `, { pairs });
    pathResult.records.map((record) => normalize(record.toObject())).forEach((part) => mergeGraphPart(nodeById, edgeByKey, part));

    const effectResult = await session.run(`
      UNWIND $leaves AS stableId
      MATCH (subject:DeveloperDefined {stableId: stableId})
      MATCH path=(subject)-[:VALUE_FROM|RESOLVES_TO|SELECTS_RETURN_PROPERTY|HAS_OPERATION|CALLS|CALLS_VALUE|READS_FROM|WRITES_TO*1..8]->(system:System)
      WHERE none(node IN nodes(path)[1..-1] WHERE node:DeveloperDefined OR node:System)
      WITH stableId, nodes(path)[1] AS firstOperation, system, path ORDER BY length(path)
      WITH stableId, firstOperation, system, collect(path)[0] AS selected
      RETURN [node IN nodes(selected) | {
               stableId: node.stableId, name: node.name, syntax: node.syntax, labels: labels(node)
             }] AS nodes,
             [relationship IN relationships(selected) | {
               sourceStableId: startNode(relationship).stableId,
               targetStableId: endNode(relationship).stableId,
               type: type(relationship)
             }] AS edges
    `, { leaves });
    effectResult.records.map((record) => normalize(record.toObject())).forEach((part) => mergeGraphPart(nodeById, edgeByKey, part));

    for (const row of annotationRows) {
      const previous = nodeById.get(row.stableId) || {};
      nodeById.set(row.stableId, {
        ...previous,
        stableId: row.stableId,
        name: previous.name || row.name,
        syntax: previous.syntax || row.syntax,
        labels: previous.labels?.length ? previous.labels : row.labels,
      });
    }
    const nodes = [...nodeById.values()].map((node) => ({
      ...node,
      annotation: annotationByStableId.get(node.stableId) || null,
    }));
    return projectFunctionalSegment({
      rootStableId,
      rootLabel: annotationRows[0].rootLabel,
      nodes,
      edges: [...edgeByKey.values()],
    });
  } finally {
    await session.close();
  }
}
