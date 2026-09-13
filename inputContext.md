# Контекст происхождения input

Параметр: `onSubmit.input`.
stableId: `screens/REPL.tsx:3142:38:3142:51`.

## Состояние прохода

- Дата: 2026-09-06.
- Режим: `value-origin`, версия 1.
- runId: `fc2ba8ab-e292-4343-8060-ece71e5b95a0`.
- Ревизия: `1`.
- Корневая задача: `8630c43ad5321b60c20d4db39e8fc013ca76480434588ab720dc70c4d42f4629`.
- Глубина: `8`.
- Корень раскрыт; семь ветвей находятся в `PENDING`. Дальнейших шагов не выполнено.

## Шаг 1. Вхождения параметра

В графе найдены семь входящих `BINDS_TO_PARAMETER`. Для каждого аргумента место вызова определено через входящую `HAS_ARGUMENT`.
Во всех случаях передаётся первый аргумент в первый параметр: `argumentIndex = 0`, `parameterIndex = 0`.

| Ветка | Переданное выражение | stableId места вызова | stableId аргумента | Основание привязки |
| --- | --- | --- | --- | --- |
| 1 | `suggestionText` | `components/PromptInput/PromptInput.tsx:1021:13:1029:10` | `components/PromptInput/PromptInput.tsx:1021:26:1021:40` | `typescript-checker-jsx-prop-flow` |
| 2 | `inputParam` | `components/PromptInput/PromptInput.tsx:1100:10:1104:6` | `components/PromptInput/PromptInput.tsx:1100:23:1100:33` | `typescript-checker-jsx-prop-flow` |
| 3 | `content` | `screens/REPL.tsx:3117:13:3121:10` | `screens/REPL.tsx:3117:22:3117:29` | `typescript-checker` |
| 4 | `command` | `screens/REPL.tsx:3584:4:3588:6` | `screens/REPL.tsx:3584:13:3584:20` | `typescript-checker` |
| 5 | `command` | `screens/REPL.tsx:3599:4:3603:6` | `screens/REPL.tsx:3599:13:3599:20` | `typescript-checker` |
| 6 | `'/rate-limit-options'` | `screens/REPL.tsx:3616:9:3620:6` | `screens/REPL.tsx:3616:29:3616:50` | `typescript-checker` |
| 7 | `pending.input` | `screens/REPL.tsx:4800:17:4804:14` | `screens/REPL.tsx:4800:37:4800:50` | `typescript-checker` |

Это статические привязки из графа, не подтверждение исполнения всех семи вызовов. JSX-привязки не вытесняют остальные. Два вхождения `command` сохранены раздельно: совпадение текста не делает их одним местом использования.

История создания и изменений переданных значений пока не исследована. Аннотации не генерировались.

## Проверка полноты шага 1

Семь строк выше описывают найденные привязки в текущей базе, а не полный набор мест вызова.

Найден дополнительный путь в исходнике:

- REPL передаёт `onSubmit` в `CommandKeybindingHandlers` в `screens/REPL.tsx:4410` и `screens/REPL.tsx:4552`.
- Компонент объявлен как `CommandKeybindingHandlers(t0)` без типа у `t0`; callback извлекается через `const { onSubmit, ... } = t0`.
- Внутри обработчика клавиатурной команды он вызывает этот callback с выражением `` `/${commandName}` ``.
- stableId вызова: `hooks/useCommandKeybindings.tsx:81:8:83:10`.
- stableId первого аргумента: `hooks/useCommandKeybindings.tsx:81:17:81:34`.
- Передаётся первый аргумент в первый параметр; дополнительно передаётся `options.fromKeybinding = true`.

Это одно дополнительное синтаксическое место вызова, достигаемое через две JSX-передачи callback. Их не следует считать двумя разными выражениями аргумента; пути передачи callback при этом различаются.

### Причина пропуска и исправление

JSX-resolver экстрактора искал объявление свойства через тип первого параметра компонента. У нетипизированного `t0` подходящего свойства нет; следовательно, вызов локальной деструктурированной переменной не связывался с переданным callback.

В `functionFlowGraph.canonicalReferences.ts` добавлено разрешение через символ первого параметра и элементы его объектной деструктуризации. Оно поддерживает переименование свойства и не захватывает одноимённые параметры вложенных функций. Названия `CommandKeybindingHandlers` и `onSubmit` в правило не зашиты.

Проверки: 8 тестов canonical references и 3 теста scoped canonical graph прошли. Новый регрессионный тест проверяет нетипизированный параметр, переименованный callback и отсутствие ложной привязки к callback вложенной функции.

Переимпорт пока не выполнен. Сохранённый проход остаётся на ревизии `1` с семью ветвями. Восьмой путь пока подтверждён исходником; после переимпорта нужно повторно получить входящие привязки и проверить его наличие в базе. Общая полнота всех возможных callback-цепочек ещё не доказана.

## Продолжение проверки callback-цепочек

### Граница REPL.onSubmit

Аудит ссылок по символам TypeScript, а не по совпадению текста имени, дал следующие использования:

| Передача / вызов | Места | Результат проверки |
| --- | --- | --- |
| Прямые вызовы `REPL.onSubmit` | `REPL.tsx:3117`, `3584`, `3599` | Три места вызова |
| Сохранение callback в `onSubmitRef` | `REPL.tsx:3613`, `3614` | Инициализация ref и присваивание `.current`; не дополнительные вызовы |
| Вызовы через этот ref | `REPL.tsx:3616`, `4800` | Два места вызова; других использований символа ref в файле нет |
| Передача в `PromptInput.onSubmitProp` | `REPL.tsx:4905` | Получатель вызывает callback на строках `PromptInput.tsx:1021`, `1100`; дальше callback не передаётся |
| Передача в `CommandKeybindingHandlers` | `REPL.tsx:4410`, `4552` | Получатель вызывает callback в одном месте: `useCommandKeybindings.tsx:81` |
| Зависимости `useCallback`, сравнение/сохранение в compiler cache | `REPL.tsx:3591`, `3606`; `useCommandKeybindings.tsx:76`, `87` | Не дополнительные вызовы |

Итого на проверенной границе: восемь синтаксических мест вызова целевого callback. Две JSX-передачи в `CommandKeybindingHandlers` ведут к одному месту вызова, но остаются разными контекстами передачи. Новых мест непосредственного вызова `REPL.onSubmit`, кроме уже найденного восьмого, этот аудит не обнаружил.

### Предыдущий уровень: PromptInput.inputParam

`PromptInput.onSubmit` на строке 984 - другая функция, не `REPL.onSubmit`. Именно она получает и изменяет `inputParam`, после чего может вызвать `onSubmitProp`.

Параметр: `components/PromptInput/PromptInput.tsx:984:38:984:56`.

| Место вызова локального callback | Передаваемое выражение | Путь передачи callback | Привязка к inputParam в базе |
| --- | --- | --- | --- |
| `components/PromptInput/PromptInput.tsx:359` | `entry.display` | Прямой | Есть |
| `components/PromptInput/PromptInput.tsx:1650` | `input` | Прямой | Есть |
| `components/PromptInput/PromptInput.tsx:1791` | `'/buddy'` | Прямой | Есть |
| `hooks/useTypeahead.tsx:1154` | `newInput` | `PromptInput.tsx:1115` -> объект аргументов `useTypeahead` | Есть |
| `utils/suggestions/commandSuggestions.ts:536` | `newInput` | `useTypeahead` -> аргумент `applyCommandSuggestion` | Нет |
| `hooks/useTextInput.ts:266` | `originalValue` | `baseProps` -> JSX spread -> `TextInput` / `VimTextInput` -> `useTextInput` | Нет |
| `hooks/useTextInput.ts:498` | `nextCursor.text` | Тот же callback в `useTextInput` | Нет |

Вызов `applyCommandSuggestion` на `useTypeahead.tsx:946` передаёт `shouldExecute=false`; на строке 1142 - `true`. Внутренний callback вызывается только при выполнении условий на строках 531-536. Нельзя объявлять оба пути фактически исполняющими callback без учёта этих условий.

Передача для текстового ввода подтверждается следующей цепочкой:

1. `PromptInput.tsx:2174`: callback помещается в `baseProps`.
2. `PromptInput.tsx:2243`: `baseProps` раскрывается в `TextInput` или `VimTextInput`.
3. `TextInput.tsx:95`: `props.onSubmit` передаётся в `useTextInput`.
4. Альтернатива Vim: `VimTextInput.tsx:20,46,101` -> `useVimInput(t16)` -> `useVimInput.ts:46` -> `useTextInput({ ...props, ... })`.

Эти три отсутствующие привязки относятся к происхождению `inputParam`, а не являются ещё тремя непосредственными вхождениями `REPL.input`.

### Воспроизведение аудита

Добавлен `dev/auditCallbackSymbol.mts`. Скрипт собирает ссылки на выбранный символ внутри файла, включая shorthand-свойства объектов, и не смешивает одноимённые локальные функции. Межфайловые передачи в этом аудите проверены отдельно по исходникам; скрипт не заявляет автоматического разрешения всех динамических путей.

```powershell
node --import tsx dev/auditCallbackSymbol.mts screens/REPL.tsx onSubmit 3142
node --import tsx dev/auditCallbackSymbol.mts screens/REPL.tsx onSubmitRef 3613
node --import tsx dev/auditCallbackSymbol.mts components/PromptInput/PromptInput.tsx onSubmitProp 225
node --import tsx dev/auditCallbackSymbol.mts components/PromptInput/PromptInput.tsx onSubmit 984
node --import tsx dev/auditCallbackSymbol.mts hooks/useCommandKeybindings.tsx onSubmit 40
```

Все пять команд выполнены. Запрос входящих `BINDS_TO_PARAMETER` для `PromptInput.inputParam` вернул четыре привязки, перечисленные выше как имеющиеся.

Следующие конкретные пробелы для экстрактора: передача callback через JSX spread и цепочку объектов/алиасов; передача callback из параметра хука в аргумент следующей функции. В этой проверке они только локализованы, не исправлены. Переимпорт и продвижение `value-origin` не выполнялись; ревизия прохода остаётся `1`.
