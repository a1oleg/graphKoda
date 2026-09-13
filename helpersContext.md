# helpers: первый горизонт

```ts
type PromptInputHelpers = {
  setCursorOffset: (offset: number) => void;
  clearBuffer: () => void;
  resetHistory: () => void;
};
```

`helpers → TYPED_AS → PromptInputHelpers → HAS_MEMBER`: три направления.
Следующий хоп выбирает один член и ищет его происхождение в переданных аргументах.
Это сигнатуры, не реализации. `clearBuffer` и `resetHistory` пока не раскрыты.

## setCursorOffset: первый хоп

```text
setCursorOffset
  <- PromptInput:252: setCursorOffset [одно объявление, 2 места передачи]
  <- REPL: () => {}                  [5 отдельных пустых функций]
```

Путь: `SATISFIES_MEMBER` в обратную сторону, затем `RESOLVES_TO` или `VALUE_FROM`.
Получены источники поля; объекты-аргументы остаются доказательствами, не задачами.
Шесть разных источников, семь контекстов передачи. Другие поля не раскрывались.
Числа относятся к текущей базе, не доказывают полноту всех мест вызова.

## setCursorOffset: второй хоп

Обходчик остановился: `ValueHistory / REACHING_DEFINITIONS_REQUIRED`.
Отдельная проверка графа обнаружила доступный путь, который он пока не прошёл:

```text
setCursorOffset → READS_FROM → useState<number>(input.length)
                             → CALLS → React.useState [System, ExternalBoundary]
setCursorOffset → WRITES_TO → cursorOffset
```

Это происхождение сеттера состояния, не системная операция отрисовки курсора.
Системная граница здесь представлена декларацией из `@types/react`, не телом реализации.

<!-- value-origin v3; runId=72ba5f0a-1a2a-47b1-8c7c-bfe7f648f385; revision=3 -->

## Использование cursorOffset

Проверено по исходникам для ветки `TextInput`, не выполнено обходчиком:

```text
cursorOffset → baseProps → TextInput.props.cursorOffset
  → useTextInput.externalOffset → Cursor.fromText(..., offset)
  → cursor.getPosition() → cursorLine / cursorColumn
  → BaseTextInput → useDeclaredCursor → Ink.cursorDeclaration
  → cursorPosition / cursorMove → writeDiffToTerminal → stdout.write
```

Смысл: позиция в тексте преобразуется в экранные координаты физического курсора.
В графе проверен переход от чтения `baseProps.cursorOffset` к исходному состоянию
через `RESOLVES_TO` и к члену типа через `SATISFIES_MEMBER`; полный путь выше ещё
не подтверждён как проходимый графовый маршрут. Состояние workflow не изменялось.

### Проверка до исправления экстрактора

- Разрыв передачи: `<TextInput {...baseProps}>` (PromptInput:2243) имеет `CALLS`,
  но не передачу аргумента в `TextInput.props` (TextInput:37). У параметра нет
  входящих `BINDS_TO_PARAMETER`. Общий тип поля не заменяет контекст передачи.
- Разрыв разрешения вызова: `setCursorDeclaration` (use-declared-cursor:57)
  имеет `CALLS` к сигнатуре CursorDeclarationContext:23, не к реализации Ink:1436.
- Есть локальные участки: `TextInput.externalOffset → VALUE_FROM → props.cursorOffset`;
  аргумент `offset` у `Cursor.fromText` имеет `BINDS_TO_PARAMETER`;
  вызов `useDeclaredCursor` имеет `CALLS` к телу функции.
- Конец есть: `ink/terminal.ts:247 stdout.write → CALLS → @types/node Writable.write`,
  с метками `System / ExternalBoundary`.

Итог: целевой маршрут передачи значения не непрерывен. Проверка только чтением;
ни переимпорт, ни исправление связей, ни продвижение workflow не выполнялись.

### После scoped-переимпорта

- Восстановлен путь JSX: вызов → `HAS_ARGUMENT` → props → `BINDS_TO_PARAMETER`;
  props → `SPREADS_FROM` → spread → `VALUE_FROM` → ссылка на `baseProps`.
  Порядок spread и явных полей сохранён; одинаковые диапазоны исходника не склеиваются.
- Добавлен путь контекста: `useContext → READS_CONTEXT → ссылка → RESOLVES_TO → контекст
  ← PROVIDES_CONTEXT ← поле value → VALUE_FROM → выражение провайдера`.
- Проверка: `node dev/verifyCursorProvenance.mjs`, обе проверки прошли.
  Переимпортированы PromptInput, useDeclaredCursor и App.render; аннотации сохранены.
- На этом этапе полный проход ещё не был готов.

### Стратегия v4: назначение состояния

```text
setCursorOffset -> WRITES_TO -> cursorOffset
  <- RESOLVES_TO / READS_FROM / VALUE_FROM <- чтения
  -> передача значения -> потребители
```

- Run `54215861-82fd-49b0-9281-3aa238acc24a`, revision 2: выполнены первые два хопа;
  найдены 51 вхождение чтения, включая поле в `baseProps`. Это не 51 независимый поток.
- Поиск провайдера идёт по явным `JSX_CHILD`, `DECLARES_JSX`, `CALLS`, `ENCLOSED_BY`.
  Ближайший провайдер скрывает внешний в каждой ветке; альтернативы и условия сохраняются.
  Общее имя или тип не доказывают передачу значения.
- Scoped-переимпорт: PromptInput, TextInput, BaseTextInput, App.render; аннотации сохранялись.
  Проверены передача JSX props, связь контекста с value и владелец вызова BaseTextInput.
- Ограничение: перенос через произвольные композиции полей, возвращаемые значения и
  `props.children` ещё не образует полного маршрута. Разрывы помечаются явно;
  полный проход до системной операции курсора не подтверждён.
- Повторный поиск от `useDeclaredCursor` после импорта: подтверждённых провайдеров нет,
  остаются `COMPONENT_ANCESTRY_MISSING` выше по дереву. Поиск рассматривает все статические
  места вызова хука; ограничение конкретной цепочкой потребления состояния ещё требуется.

### Стратегия v5: составные значения и scoped-корень

```text
baseProps.cursorOffset -> JSX spread -> TextInput.props.cursorOffset
useDeclaredCursor <- BaseTextInput <- TextInput <- PromptInput <- memo <- REPL
```

- Первая строка подтверждена обходом рабочего графа (`dev/verifyCursorUsage.mjs`),
  выбранное поле не подменяется целым объектом. Учитываются порядок spread и перезаписи.
- Исправлена потеря корневой экспортированной функции при scoped-импорте:
  stableId исключает `export`, а диапазон исходника его включает. Теперь корень
  определяется также по идентичности; `HAS_PARAMETER` и `DECLARES_JSX` сохраняются.
- Известные места вызова ограничивают поиск провайдера. Прямые вызовы, алиасы и
  обёртки не исключают друг друга. Это статические пути, не доказательство исполнения.
- Scoped-переимпортированы PromptInput, TextInput, BaseTextInput, App.render,
  useDeclaredCursor с сохранением аннотаций. Полный импорт не запускался.
- Следующий разрыв обнаружен в динамическом импорте ResumeConversation через
  Promise.all: JSX привязывал параметры по сигнатуре, но CALLS вёл только в локальный
  binding. Экстрактор теперь также связывает с реальным телом сигнатуры, если оно есть.
  Для этого участка добавлен scoped-переимпорт launchResumeChooser и ResumeConversation.
- Полный маршрут до системной операции пока не доказан. Аудит и точные оставшиеся
  разрывы: `tmp/cursor-provider-ancestry.json` (`dev/auditCursorProviderAncestry.mjs`).
- Последний аудит после всех импортов дошёл через ResumeConversation и
  launchResumeChooser до `main.tsx:1006:542:3808:3`. Здесь остался
  `COMPONENT_ANCESTRY_MISSING`; конкретный провайдер ещё не подтверждён.

### Передача JSX в render-helper

```text
ResumeConversation <- JSX_CHILD <- App
App -> аргумент renderAndRun -> element -> root.render(element)
  -> параметр сигнатуры Root.render [реализация ещё не разрешена]
```

- Прежний выход к callback `.action(...)` был ошибочным направлением, не родителем React-дерева.
- JSX-аргумент извлекается как элемент, а не литерал. `RENDERS_VALUE` фиксирует вставку значения
  в JSX-детей; условия сохраняются. Обход переключается с родителей на передачу значения.
- Проверено на рабочем графе: путь достигает `ink/root.ts:68:11:68:26`, без callback в `main.tsx`.
  Это параметр типа, не тело метода и не системная граница. Полный путь курсора пока не замкнут.
- Выполнен только scoped-импорт launchResumeChooser и renderAndRun с сохранением аннотаций.

### Стратегия v7: граница локального использования

```text
setter --WRITES_TO--> state --ENCLOSED_BY--> owner
state --передача выбранного значения--> read <--CONSUMES_VALUE-- operation
operation --ENCLOSED_BY--> consumerOwner
```

- `purpose` (по умолчанию): `PURPOSE_BOUNDARY` только при наличии всех этих свидетельств.
  Путь, направления связей, владелец и запись перепроверяются в базе; сохраняются исходник операции и её роль.
- Экстрактор пока размечает конкретное потребление бинарными операциями и индексированием.
  Передача аргумента, сигнатура типа, имя переменной и регистрация callback не являются границей.
- Это достаточность для описания одного локального использования, не доказательство полного назначения:
  сравнение само по себе не доказывает перемещение курсора. Остальные ветки не удаляются и не считаются проверенными.
- `mechanism` продолжает обход. `PURPOSE_COMPLETE` отделён от завершения механистического прохода;
  неразрешённые ветки сохраняют общий статус `INCOMPLETE`. Objective входит в идентичность задачи.
- Scoped-импортированы TextInput и BaseTextInput с сохранением аннотаций. В рабочем графе подтверждены
  `CONSUMES_VALUE` для `props.cursorOffset < h.start` и `props.cursorOffset >= h.end`.
  Полный проход от helpers по новому критерию пока не выполнялся; Neo4j-тест проверяет границу
  на изолированной цепочке записи, владельца, чтения и потребления, включая отсутствие владельца.
