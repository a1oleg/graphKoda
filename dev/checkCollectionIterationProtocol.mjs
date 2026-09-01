import fs from 'node:fs';
import path from 'node:path';

const inputArgument = process.argv[2] || 'tmp/collection-protocol-smoke.json';
const inputPath = inputArgument === '-' ? '<stdin>' : path.resolve(inputArgument);
const payload = JSON.parse(inputArgument === '-'
  ? fs.readFileSync(0, 'utf8')
  : fs.readFileSync(inputPath, 'utf8'));
const nodes = payload.nodes || [];
const edges = payload.edges || [];
const nodeById = new Map(nodes.map((node) => [node.stableId, node]));
const outgoing = new Map();

for (const edge of edges) {
  if (!outgoing.has(edge.fromId)) outgoing.set(edge.fromId, []);
  outgoing.get(edge.fromId).push(edge);
}

function hasEdge(fromId, type, toId) {
  return (outgoing.get(fromId) || []).some((edge) => edge.type === type && (!toId || edge.toId === toId));
}

function reaches(startId, predicate, allowedTypes, limit = 100) {
  const queue = [startId];
  const seen = new Set(queue);
  while (queue.length && seen.size <= limit) {
    const current = queue.shift();
    if (predicate(nodeById.get(current), current)) return true;
    for (const edge of outgoing.get(current) || []) {
      if (!allowedTypes.has(edge.type) || seen.has(edge.toId)) continue;
      seen.add(edge.toId);
      queue.push(edge.toId);
    }
  }
  return false;
}

const findings = [];
const heads = nodes.filter((node) => (
  node.semanticExpansion === 'collection-iteration'
  && node.executionScopeKind === 'collection-call'
));

for (const head of heads) {
  const loopId = head.collectionLoopStableId;
  const pullId = `${loopId}:pull`;
  const pulledValueId = `${pullId}:value`;
  const iterationId = head.collectionIterationStableId;
  const itemId = `${iterationId}:value`;
  const iterationResultId = `${iterationId}:result`;
  const selectedValueId = `${iterationId}:selected-value`;
  const exhaustedId = `${loopId}:outcome:exhausted`;
  const undefinedValueId = `${loopId}:value:undefined`;
  const completeId = `${loopId}:complete`;
  const callResultId = `${head.stableId}:result`;
  const pulledValueName = String(nodeById.get(pulledValueId)?.diaName || '').trim();
  const itemName = String(nodeById.get(itemId)?.diaName || '').trim();
  const selectedAssignment = (outgoing.get(selectedValueId) || [])
    .find((edge) => edge.type === 'ASSIGNS_VALUE');
  const directOperation = nodes.find((node) => (
    node.collectionIterationStableId === iterationId
    && ['emit', 'accumulate'].includes(node.primitiveKind)
  ));
  const directOperationTarget = directOperation && (outgoing.get(directOperation.stableId) || [])
    .find((edge) => ['EMITS_VALUE', 'ACCUMULATES_VALUE'].includes(edge.type));
  const terminalAssignment = (outgoing.get(exhaustedId) || [])
    .find((edge) => edge.type === 'EXHAUSTED');
  const directConsumer = Boolean(selectedAssignment || directOperation);
  const requiredNodes = [
    [loopId, 'collection loop'],
    [pullId, 'pull primitive'],
    [pulledValueId, 'pulled candidate value'],
    [iterationId, 'iteration binding'],
    [itemId, 'iteration value'],
    [exhaustedId, 'exhausted outcome'],
    ...(directConsumer
      ? selectedAssignment
        ? [
          [selectedValueId, 'selected value occurrence'],
          [undefinedValueId, 'undefined fallback'],
        ]
        : [
          [directOperation.stableId, `${directOperation.primitiveKind} operation`],
        ]
      : [
          [iterationResultId, 'iteration result'],
          [completeId, 'legacy completion primitive'],
          [callResultId, 'call result'],
        ]),
  ];
  for (const [stableId, role] of requiredNodes) {
    if (!stableId || !nodeById.has(stableId)) findings.push(`${head.stableId}: missing ${role} (${stableId || 'unset'})`);
  }
  const requiredEdges = [
    [head.stableId, 'ITERATES_VALUE', loopId],
    [loopId, 'PULLS_VALUE', pullId],
    [pullId, 'YIELDS_VALUE', pulledValueId],
    [pulledValueId, 'ITEM_AVAILABLE', iterationId],
    [iterationId, 'EXTRACTS_VALUE', itemId],
    [pullId, 'EXHAUSTED', exhaustedId],
    ...(directConsumer
      ? selectedAssignment
        ? [
          [itemId, 'PASSES_VALUE', selectedValueId],
          [selectedValueId, 'ASSIGNS_VALUE', selectedAssignment.toId],
          [undefinedValueId, 'ASSIGNS_VALUE', selectedAssignment.toId],
          [exhaustedId, 'EXHAUSTED', selectedAssignment.toId],
        ]
        : [
          [directOperation.stableId, directOperationTarget?.type, directOperationTarget?.toId],
          [directOperation.stableId, 'REPEATS', pullId],
          [exhaustedId, 'EXHAUSTED', terminalAssignment?.toId],
        ]
      : [
          [exhaustedId, 'NEXT', completeId],
          [iterationResultId, 'REPEATS', pullId],
          [completeId, 'COMPLETES_VALUE', callResultId],
        ]),
  ];
  for (const [from, type, to] of requiredEdges) {
    if (!hasEdge(from, type, to)) findings.push(`${head.stableId}: missing ${from} -[${type}]-> ${to}`);
  }
  if (!itemName || pulledValueName !== itemName || /[?=>]/u.test(itemName)) {
    findings.push(
      `${head.stableId}: collection item names must come cleanly from the callback parameter `
      + `(pulled=${JSON.stringify(pulledValueName)}, item=${JSON.stringify(itemName)})`,
    );
  }
  if (!hasEdge(itemId, 'PASSES_VALUE')) {
    findings.push(`${head.stableId}: iteration value is not passed to callback`);
  }
  if (directConsumer) {
    if (nodeById.has(iterationResultId) || nodeById.has(completeId) || nodeById.has(callResultId)) {
      findings.push(`${head.stableId}: direct consumer still has generic result/completion nodes`);
    }
    const target = selectedAssignment
      ? (outgoing.get(selectedAssignment.toId) || [])
        .find((edge) => edge.type === 'TARGETS_VALUE')
      : directOperationTarget;
    if (!target || !nodeById.get(target.toId)?.labels?.includes('ValueSlot')) {
      findings.push(`${head.stableId}: direct collection consumer does not reach a ValueSlot`);
    }
  } else {
    if (![...(outgoing.values())].flat().some((edge) => (
      edge.toId === iterationResultId
      && [
        'YIELDS_VALUE',
        'EMITS_VALUE',
        'ACCUMULATES_VALUE',
        'DECIDES_VALUE',
        'PERFORMS_EFFECT',
        'ORDERS_VALUE',
      ].includes(edge.type)
    ))) {
      findings.push(`${head.stableId}: callback does not produce an iteration result`);
    }
    const reachesConsumer = reaches(
      callResultId,
      (node, stableId) => stableId !== callResultId && Boolean(node?.labels?.includes('ValueSlot')),
      new Set(['RESULT']),
    );
    if (!reachesConsumer) findings.push(`${head.stableId}: call result does not reach a ValueSlot`);
  }
}

if (!heads.length) findings.push('No collection iteration heads were extracted.');
for (const edge of edges) {
  if (edge.semanticExpansion === 'collection-iteration' && edge.fromId === edge.toId) {
    findings.push(`Collection primitive self-edge: ${edge.fromId} -[${edge.type}]-> itself`);
  }
}
const protocolRoleOwners = new Map();
for (const edge of edges.filter((candidate) => candidate.type === 'HAS_STAGE')) {
  const roles = edge.protocolRoles || (edge.protocolRole ? [edge.protocolRole] : []);
  for (const role of roles) {
    const key = `${edge.fromId}\u0000${role}`;
    const owners = protocolRoleOwners.get(key) || new Set();
    owners.add(edge.toId);
    protocolRoleOwners.set(key, owners);
  }
}
for (const [key, owners] of protocolRoleOwners) {
  if (owners.size <= 1) continue;
  const [protocolId, role] = key.split('\u0000');
  findings.push(
    `${protocolId}: protocol role ${role} has multiple owners (${[...owners].join(', ')})`,
  );
}

const summary = {
  ok: findings.length === 0,
  inputPath,
  collectionCalls: heads.length,
  findings,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (findings.length) process.exitCode = 1;
