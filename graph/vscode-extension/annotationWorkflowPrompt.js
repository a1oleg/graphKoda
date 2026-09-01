function compactAnnotationClientContext(item = {}) {
  return {
    diagramPath: String(item.diagramPath || ''),
    element: {
      cellId: String(item.cellId || ''),
    },
  };
}

function resolveAnnotationTargetStableId(item = {}) {
  return String(item.stableId || item.targetStableId || '').trim();
}

function classifyAnnotationWorkflowResponse(workflow = {}) {
  if (workflow.status === 'ready') return 'ready';
  if (workflow.status === 'waiting') return 'waiting';
  if (workflow.status === 'queued') return 'generate';
  if (workflow.status === 'needs-generation' && workflow.task) return 'generate';
  return 'unexpected';
}

function buildAnnotationWorkflowPrompt({
  orchestratorBaseUrl,
  stableId,
  clientContext,
  maxDepth = 4,
  refreshMode = 'reuse',
} = {}) {
  const normalizedStableId = String(stableId || '').trim();
  const endpoint = new URL('/api/annotation-jobs', orchestratorBaseUrl).toString();
  const requestBody = {
    stableId: normalizedStableId,
    atStableId: normalizedStableId,
    maxDepth,
    clientContext,
    refreshMode,
  };
  return [
    'Продолжи graph-first annotation workflow.',
    'Получай графовый контекст непосредственно у оркестратора; во вложенном файле его копии нет.',
    '',
    `POST ${endpoint}`,
    JSON.stringify(requestBody, null, 2),
    '',
    'При status=needs-generation создай русское описание строго по task.contextBundle и task.requirements.',
    'Отправляй task.completion.body как JSON в UTF-8; не допускай замены кириллицы символами ? или �.',
    'Вызови POST task.completion.endpoint на том же orchestrator origin с task.completion.body, заменив только text.',
    'Повторяй обработку каждого следующего ответа needs-generation; jobId, taskId и leaseToken не изменяй.',
    'При status=waiting не генерируй текст: повтори POST /api/annotation-jobs/{jobId}/lease-next после завершения параллельной задачи.',
    'Не выполняй собственные Cypher-запросы и не расширяй полученный контекст.',
    'При status=ready верни annotation и diagramInsertion.',
  ].join('\n');
}

module.exports = {
  buildAnnotationWorkflowPrompt,
  classifyAnnotationWorkflowResponse,
  compactAnnotationClientContext,
  resolveAnnotationTargetStableId,
};
