# graphKoda

 набор инструментов для извлечения, хранения, анализа и визуализации
графа TypeScript/React-приложения. Репозиторий **не содержит исходники Claude
Code**.

Исходник, для которого разрабатывался инструментарий:
[anarchic/claude-code на GitVerse](https://gitverse.ru/anarchic/claude-code).

## Что входит

- TypeScript AST/checker extractor и координатные `stableId`;
- scoped extractor daemon для быстрых повторных импортов;
- CodeQL-запросы для готовых канонических и storage-связей;
- DuckDB staging и Parquet-выгрузка полного графа;
- Python-валидатор и импорт в Neo4j;
- Redis runtime relay, трассы исполнения и статистика циклов;
- локальный orchestrator HTTP API, OpenAPI и Swagger UI;
- MCP-серверы для read-only Neo4j и Redis; Google Sheets MCP вынесен в отдельный репозиторий;
- web explorer и расширение VS Code;
- renderer диаграмм и наш fork draw.io.

```text
Claude Code source
  ├─ TypeScript AST/checker ─┐
  ├─ CodeQL facts ──────────┼─> DuckDB/Parquet ─> Neo4j
  └─ runtime instrumentation ─> relay ─> Redis
                                      │
VS Code / web explorer <─ orchestrator API ─> draw.io renderer
```

## Требования

- Git;
- Node.js 22.6+ и npm 10.8+;
- Python 3.11+;
- Docker Desktop/Podman либо установленный Neo4j 5;
- Redis 7 (готовый Compose-файл включён);
- VS Code 1.90+;
- CodeQL CLI. Скрипты умеют загрузить CLI в пользовательский кеш при первом
  запуске, но для закрытой сети его можно установить заранее.

На Windows команды ниже выполняются из PowerShell.

## Установка

Клонируйте исходник и инструментарий в разные каталоги:

```powershell
git clone https://gitverse.ru/anarchic/claude-code C:\work\claude-code
git clone https://github.com/a1oleg/graphKoda C:\work\graphKoda-tools
```

Наложите только инструментарий на рабочую копию исходника:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
C:\work\graphKoda-tools\scripts\install-overlay.ps1 `
  -TargetPath C:\work\claude-code
```

Скрипт копирует `graph/`, graph-ориентированные файлы `dev/` и Compose Redis,
ставит Node-зависимости без изменения `package.json/package-lock.json` исходника,
создаёт `.venv` и ставит Python-зависимости. Повторный запуск обновляет overlay.

Загрузите официальный draw.io и наложите наш plugin (upstream не хранится в
`graphKoda`, чтобы не переносить встроенные сторонние OAuth identifiers):

```powershell
C:\work\graphKoda-tools\scripts\setup-drawio.ps1 `
  -TargetPath C:\work\claude-code
```

Перейдите в исходник и создайте локальную конфигурацию:

```powershell
cd C:\work\claude-code
Copy-Item graph\.env.example graph\.env -ErrorAction SilentlyContinue
```

Минимально замените `NEO4J_PASSWORD=change-me`. `graph/.env` игнорируется Git и
не должен отправляться ни в этот, ни в upstream-репозиторий.

## Neo4j

Автоматический launcher выбирает уже работающий сервер, CLI, Docker/Podman,
Neo4j Desktop или WSL:

```powershell
node dev/neo4j/startNeo4jServer.mjs
```

Стандартные адреса: Bolt `127.0.0.1:7687`, Browser
`http://127.0.0.1:7474`. Если сервер запускается отдельно, задайте
`NEO4J_LAUNCH_MODE=external`.

## Redis и runtime relay

```powershell
docker compose -f docker-compose.redis.yml up -d
node dev/redis/startRuntimeRelayToRedis.mjs
```

Redis слушает `6379`, relay — `http://127.0.0.1:8787/graph-relay`.
Instrumented-приложение отправляет события в relay; Redis хранит события,
значения `set`, ветви, repeat/iteration и данные для подсветки runtime-пути.

Проверки:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
Invoke-RestMethod http://127.0.0.1:8787/stats
```

## Полная экстракция: TypeScript → DuckDB/Parquet → Neo4j

```powershell
node dev/runGraphExtract.mjs func
```

Промежуточные данные создаются в `graph/.runtime/cache/`:

- `function-flow.duckdb` — staging и статистика;
- `function-flow-parquet/` — канонические entities/relationships в Parquet.

После успешной экстракции Python проверяет контракт и загружает граф в Neo4j.
Полный импорт очищает базу, поэтому не используйте одну Neo4j database для
посторонних данных. Для изоляции задайте отдельную `NEO4J_DATABASE`.

Scoped-импорт функции запускается через orchestrator API по координатному ID:

```powershell
$body = @{ fnStableId = 'screens/REPL.tsx:3142:31:3533:3' } | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:8791/api/actions/import-functions `
  -Method Post -ContentType application/json -Body $body
```

Daemon сохраняет TypeScript `Program` и semantic context между запросами.

## CodeQL

Первый запуск создаёт JavaScript/TypeScript database в
`.cache/codeql/databases/javascript`, устанавливает qlpack и выполняет запросы:

```powershell
node dev/codeqlCanonicalReferenceLinks.mjs
node dev/codeqlStructuralStorageFacts.mjs
```

`canonical-reference-links.ql` уточняет `RESOLVES_TO`, aliases/re-exports и
канонические объявления. Storage-запросы находят устойчивые accessor-операции.
CodeQL дополняет AST extractor; локальная структура `if`, assignments, calls и
мозаики не зависят от CodeQL.

## Orchestrator, OpenAPI и Swagger

```powershell
node dev/startOrchestrator.mjs
```

- health: `http://127.0.0.1:8791/health`;
- OpenAPI JSON: `http://127.0.0.1:8791/openapi.json`;
- Swagger UI: `http://127.0.0.1:8791/docs`;
- каталог API: `http://127.0.0.1:8791/api`.

Orchestrator управляет импортом, рендерингом, аннотациями, runtime-анализом и
локальными сервисами. По умолчанию он слушает только loopback.

## VS Code extension

Соберите и установите текущую версию:

```powershell
cd C:\work\claude-code
npx @vscode/vsce package --cwd graph/vscode-extension
code --install-extension graph/vscode-extension/graphKoda-graph-explorer-*.vsix --force
```

После перезапуска VS Code в Activity Bar появится **Graph Explorer**. Расширение
открывает функцию/узел в коде, рисует отдельную flow-диаграмму, показывает trace
и runtime analysis, запрашивает/обновляет аннотации и открывает Swagger через
локальный orchestrator.

## MCP

Neo4j MCP запускается из рабочей копии исходника:

```powershell
.venv\Scripts\python.exe graph\mcp\neo4j_mcp_server.py
```

Redis MCP:

```powershell
node graph\mcp\redis_mcp_server.mjs
```

Оба используют локальные настройки; пароль Neo4j читается из `graph/.env`.
Google Sheets MCP вынесен в отдельный репозиторий
[google-sheets-mcp](https://github.com/a1oleg/google-sheets-mcp).
Добавьте его папку в workspace; настройки service account находятся в его
игнорируемом `.env`, а подключение — в `.vscode/mcp.json` этого репозитория.

## Renderer и draw.io

Renderer строит `.drawio` из Neo4j-сегмента, а не из заранее сохранённой
картинки. Сгенерированные файлы попадают в `graph/draw/generated/` и не
коммитятся. `setup-drawio.ps1` получает официальный draw.io в
`graph/vendor/drawio` и сохраняет наш
`graph/vendor/drawio/src/main/webapp/plugins/codexGraph.js` с формами, портами,
folding и runtime-подсветкой.

## Проверка установки

```powershell
node --test graph/packages/orchestrator/src/orchestrator/*.test.js `
  graph/packages/runtime-relay/src/*.test.mjs graph/vscode-extension/*.test.js `
  dev/functionDiagramScope.structure.test.mjs dev/runtimePathDrawio.test.mjs `
  dev/runtimeSetValues.test.mjs dev/runtimeTraceStableId.test.mjs dev/stableId.test.mjs
.venv\Scripts\python.exe -m unittest discover -s graph/static-extract/py -p 'test_*.py'
node dev/checkOrchestratorHealth.mjs
```

Готовая диаграмма Фишера проверяется через draw.io MCP: `npm run fisher:audit`.
Проверяется реальный файл `graph/draw/generated/Fisher-Yates.drawio`, без
синтетических графов. Новые проверки добавляются по коллизиям, обнаруженным
пользователем в конкретном кейсе.

## Fisher Runtime

`npm run fisher:up` запускает Redis в Docker (только localhost) и runtime-relay.
`npm run fisher:run` инструментирует реальный `shuffle.ts` через Babel и выполняет
перемешивание A-H в новой сессии, не удаляя предыдущие прогоны.

В контекстном меню диаграммы доступны Trace функции и значения; для узла `for`
доступна статистика цикла. Панель показывает итерации и проверки условия.
После обновления расширения перезагрузите окно VS Code и откройте диаграмму заново.

Runtime Swagger: http://127.0.0.1:8787/api/docs (отдельно от Swagger оркестратора).
`POST /fisher/run` запускает тот же прогон. `GET /runtime-trace` и
`GET /runtime-values` принимают `stableId` функции; `GET /runtime-analysis` принимает
`stableId` цикла. Необязательный `sessionId` выбирает конкретный прогон, иначе последний.
`npm run fisher:runtime:check` проверяет реальные данные через API и Execute в Swagger.
Отчёты и инструментированный код находятся в `tmp/fisher-yates/runtime/`.
Панель `for` показывает `cases`: семь `continue` и завершающий `break` при
ложном условии; `totalIterations` остаётся равным семи, `totalCases` равен восьми.
`npm run fisher:panel:check` проверяет реальные кейсы, их связи через draw.io MCP
и отображение светлой панели с коробкой переменной вместо заголовка Item.

## Безопасность

- никогда не коммитьте `graph/.env`, service-account JSON, `.cache`, `.venv`,
  Parquet/DuckDB, Redis/Neo4j data, runtime traces и `.vsix`;
- не публикуйте orchestrator, Neo4j, Redis и relay наружу без отдельной
  аутентификации и TLS;
- перед push запускайте secret scan (`gitleaks detect --source .` либо
  `trufflehog filesystem . --no-update`);
