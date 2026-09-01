# Graph Orchestrator

Оркестратор — локальная HTTP control plane для графового экстрактора, Neo4j,
аннотаций, draw.io, runtime-trace/repro и управляемых dev-сервисов. Точка входа —
[`src/orchestrator.js`](src/orchestrator.js), запуск — `npm run graph:orchestrator`.

## API

- Swagger UI: `http://127.0.0.1:8791/api/docs`
- Swagger alias: `http://127.0.0.1:8791/swagger`
- OpenAPI 3.1: `http://127.0.0.1:8791/api/openapi.json`
- API audit: `http://127.0.0.1:8791/api/docs/audit`
- Process and route catalog: `http://127.0.0.1:8791/api/status/gateway`

Swagger assets обслуживаются локально из `swagger-ui-dist`; доступ в интернет для
страницы документации не требуется.

## Архитектура

```text
HTTP server (orchestrator.js)
├─ transport: JSON/body/error normalization, HTML/static responses
├─ GET/POST dispatch: совместимые публичные URL
├─ API contract (apiContract.js)
│  ├─ taxonomy and operation metadata
│  ├─ gateway route catalog
│  ├─ OpenAPI 3.1 document
│  ├─ Swagger UI
│  └─ machine-readable audit
└─ domain modules
   ├─ serviceManagement / graphExtract / graphReset
   ├─ annotationResolver / annotationProfiles
   ├─ feature* / phase* / functionFlowDraw
   └─ uiExplorer*
```

`apiContract.js` — единый описательный источник правды. Исполняющие handlers
остаются в `orchestrator.js`, поскольку они имеют разные зависимости и жизненные
циклы. Тест `apiContract.test.js` извлекает фактические ветви router'а из исходника
и требует их полного совпадения с контрактом. Поэтому новый endpoint нельзя
добавить «мимо» OpenAPI и каталога статуса.

## Таксономия

Публичные операции разделены на группы:

- Documentation — discovery, health, knowledge, OpenAPI и Swagger;
- Status — только чтение состояния процессов и инфраструктуры;
- Extraction — plan/preflight/status и управление импортом;
- Annotations — хранение, DAG resolution и persistent jobs;
- Graph — общие graph-запросы и административные операции;
- Diagrams, Functions, Phases, Features — построение соответствующих моделей;
- UI Explorer — UI/business-object проекции;
- Services — управление локальными процессами и readiness.

Существующие URL сохранены для совместимости. Alias помечаются `deprecated` в
OpenAPI. Потенциально разрушительные операции отмечаются отдельно и обязаны иметь
явный confirmation contract; сброс Neo4j требует `confirm: "RESET_GRAPH"`.

## Транспортные соглашения

- Успешный JSON-ответ содержит `ok` там, где это поддерживает domain handler.
- Ошибки формы запроса возвращаются как HTTP 400 с `code=INVALID_REQUEST`.
- Неожиданные ошибки возвращаются как HTTP 500 с `code=INTERNAL_ERROR`.
- Stack trace и локальные пути больше не публикуются в HTTP-ответе.
- Неизвестный route — HTTP 404; неподдерживаемый method — HTTP 405.
- POST по умолчанию документируется с JSON body. Специализированные схемы уже
  заданы для scoped import, graph reset, annotation workflow, function flow и
  feature selection; остальные допускают расширяемый объект до типизации их
  domain payload.

## Результат ревизии

До систематизации существовали два расходящихся набора сведений: реальные
`handleGet`/`handlePost` и вручную поддерживаемый неполный каталог в
`serviceManagement.js`. Старый каталог удалён. Новый контракт покрывает все
исполняемые операции, выделяет legacy aliases и destructive actions и проверяется
автоматически.

Следующий безопасный этап — постепенно вынести сами handlers в табличный router и
заменить оставшиеся `GenericObject` body schemas точными схемами domain-модулей.
Это можно делать без изменения публичных URL и без второго каталога маршрутов.
