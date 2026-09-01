import fs from 'node:fs';
import path from 'node:path';

const inputPath = path.resolve(process.argv[2] || 'tmp/primitive-onsubmit.json');
const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const nodes = payload.nodes || [];
const edges = payload.edges || [];
const nodeById = new Map(nodes.map((node) => [node.stableId, node]));
const findings = [];

const executionJunctions = nodes.filter((node) => node.labels?.includes('ExecutionJunction'));
for (const junction of executionJunctions) {
  if (!junction.executionColumnOwnerStableId) {
    findings.push(`${junction.stableId}: ExecutionJunction has no executionColumnOwnerStableId`);
  }
  if (!junction.executionJunctionKind) {
    findings.push(`${junction.stableId}: ExecutionJunction has no executionJunctionKind`);
  }
  if (!Number.isInteger(junction.executionJunctionOrder)) {
    findings.push(`${junction.stableId}: ExecutionJunction has no integer executionJunctionOrder`);
  }
}

const primitives = nodes.filter((node) => (
  node.labels?.includes('Primitive') && !node.labels?.includes('ExecutionJunction')
));
for (const primitive of primitives) {
  if (primitive.annotationKind !== 'ExecutionPrimitive') {
    findings.push(`${primitive.stableId}: Primitive annotationKind is ${primitive.annotationKind || 'missing'}`);
  }
  if (!primitive.primitiveKind && !primitive.executionOutcome) {
    findings.push(`${primitive.stableId}: Primitive has neither primitiveKind nor executionOutcome`);
  }
  if (!primitive.runtimeEventKind) {
    findings.push(`${primitive.stableId}: Primitive has no runtimeEventKind`);
  }
  if (!primitive.instrumentationStrategy) {
    findings.push(`${primitive.stableId}: Primitive has no instrumentationStrategy`);
  }
  if (primitive.primitiveKind && primitive.instrumentationStrategy !== 'structural-only') {
    if (!primitive.instrumentationPhase) {
      findings.push(`${primitive.stableId}: executable Primitive has no instrumentationPhase`);
    }
    if (!primitive.instrumentationTargetStableId) {
      findings.push(`${primitive.stableId}: executable Primitive has no instrumentationTargetStableId`);
    }
  }
}

const assignments = primitives.filter((node) => node.primitiveKind === 'assign');
for (const assignment of assignments) {
  const incomingValues = edges.filter((edge) => (
    edge.toId === assignment.stableId && edge.type === 'ASSIGNS_VALUE'
  ));
  const writes = edges.filter((edge) => (
    edge.fromId === assignment.stableId && edge.type === 'WRITES_VALUE'
  ));
  const targets = edges.filter((edge) => (
    edge.fromId === assignment.stableId && edge.type === 'TARGETS_VALUE'
  ));
  if (!incomingValues.length) {
    findings.push(`${assignment.stableId}: Assign has no ASSIGNS_VALUE input`);
  }
  if (writes.length !== 1) {
    findings.push(`${assignment.stableId}: Assign has ${writes.length} WRITES_VALUE edges, expected 1`);
  }
  if (targets.length !== 1 || targets[0]?.toId !== writes[0]?.toId) {
    findings.push(`${assignment.stableId}: Assign target does not match its write target`);
  }
}

const flowBlocks = nodes.filter((node) => (
  node.labels?.includes('Flow') && node.labels?.includes('Block')
));
const flowBlockById = new Map(flowBlocks.map((block) => [block.stableId, block]));
for (const block of flowBlocks) {
  const members = nodes.filter((node) => node.parentFlowBlockStableId === block.stableId);
  if (!members.length) findings.push(`${block.stableId}: FlowBlock has no direct members`);
  if (!block.headStableIds?.length) findings.push(`${block.stableId}: FlowBlock has no headStableIds`);
  if (!block.tailStableIds?.length) findings.push(`${block.stableId}: FlowBlock has no tailStableIds`);
  for (const stableId of [...(block.headStableIds || []), ...(block.tailStableIds || [])]) {
    if (!nodeById.has(stableId) && !payload.functions?.some((fn) => fn.stableId === stableId)) {
      findings.push(`${block.stableId}: boundary node is missing: ${stableId}`);
    }
  }
  if (block.parentFlowBlockStableId && !flowBlockById.has(block.parentFlowBlockStableId)) {
    findings.push(`${block.stableId}: parent FlowBlock is missing: ${block.parentFlowBlockStableId}`);
  }
  if (!block.ownerBranchStableIds?.length) {
    findings.push(`${block.stableId}: FlowBlock has no ownerBranchStableIds`);
  }
}

for (const block of flowBlocks) {
  const seen = new Set([block.stableId]);
  let parentId = block.parentFlowBlockStableId;
  while (parentId) {
    if (seen.has(parentId)) {
      findings.push(`${block.stableId}: cyclic FlowBlock nesting through ${parentId}`);
      break;
    }
    seen.add(parentId);
    parentId = flowBlockById.get(parentId)?.parentFlowBlockStableId;
  }
}

const receiverOccurrences = nodes.filter((node) => (
  node.labels?.includes('Receiver') && node.labels?.includes('Occurrence')
));
for (const receiver of receiverOccurrences) {
  const receiverEdges = edges.filter((edge) => (
    edge.toId === receiver.stableId && edge.type === 'ON_RECEIVER'
  ));
  if (receiver.sourceCallStableId) {
    if (receiver.stableId === receiver.sourceCallStableId) {
      findings.push(`${receiver.stableId}: receiver occurrence collapsed into its source call`);
    }
    const connectedToCall = receiverEdges.some((edge) => {
      if (edge.fromId === receiver.sourceCallStableId) return true;
      return nodeById.get(edge.fromId)?.sourceCallStableId === receiver.sourceCallStableId;
    });
    if (!connectedToCall) {
      findings.push(`${receiver.stableId}: receiver occurrence is not connected to its source call or method proxy`);
    }
  }
}

const methodProxies = nodes.filter((node) => (
  node.labels?.includes('FnVisualProxy') && node.labels?.includes('Method')
));
for (const proxy of methodProxies) {
  const invocations = edges.filter((edge) => (
    edge.toId === proxy.stableId && edge.type === 'INVOKES'
  ));
  const receivers = edges.filter((edge) => (
    edge.fromId === proxy.stableId && edge.type === 'ON_RECEIVER'
  ));
  if (invocations.length !== 1) {
    findings.push(`${proxy.stableId}: method proxy has ${invocations.length} INVOKES edges, expected 1`);
  }
  if (receivers.length !== 1) {
    findings.push(`${proxy.stableId}: method proxy has ${receivers.length} ON_RECEIVER edges, expected 1`);
  }
}

for (const edge of edges) {
  if (
    edge.fromId === edge.toId
    && (
      edge.semanticExpansion === 'collection-iteration'
      || edge.semanticExpansion === 'primitive-execution'
      || edge.flowLayer === 'structure'
    )
  ) {
    findings.push(`${edge.fromId}: semantic self-edge ${edge.type}`);
  }
}

const countBy = (items, key) => Object.fromEntries(
  [...Map.groupBy(items, key)].map(([value, rows]) => [value, rows.length]),
);

const summary = {
  ok: findings.length === 0,
  inputPath,
  primitiveCount: primitives.length,
  primitiveKinds: countBy(primitives, (node) => node.primitiveKind || `outcome:${node.executionOutcome}`),
  assignmentCount: assignments.length,
  flowBlockCount: flowBlocks.length,
  nestedFlowBlockCount: flowBlocks.filter((block) => block.parentFlowBlockStableId).length,
  receiverOccurrenceCount: receiverOccurrences.length,
  executionJunctionCount: executionJunctions.length,
  methodProxyCount: methodProxies.length,
  producedValueCount: edges.filter((edge) => edge.type === 'PRODUCES_VALUE').length,
  findings,
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (findings.length) process.exitCode = 1;
