# Компактные свойства узлов Bloom

У демо-узлов остаётся одна метка Neo4j: `DemoStage1` или `DemoStage2`.
Поисковые запросы расширения используют эти метки и связи `NEXT` / `VALUE_FROM`.

В свойствах сохраняются:

- `content`: код из `actionTextRaw`, `callTextRaw`, `conditionRaw` экстрактора;
  при отсутствии — фрагмент исходника по координатам экстрактора.
- `labels`: исходный массив ролей узла экстрактора, например
  `Parameter`, `ValueSlot`, `Object`, `ObjectConstruction`.
- Координаты исходника и доступные поля роли в исходном формате `props`:
  `annotationKind`, `data_flow_role`, `flow_layer`, `argument_name`,
  `argument_index`, `callee_name`, `invocation_mode`, `response_mode`.
- Идентификаторы происхождения, заголовок и свойства размещения демо.

Код ограничен первыми 24 строками и 3000 символами;
`contentTruncated` явно отмечает сокращение. Render parts, служебная геометрия
экстрактора и вложенные графы не копируются.

Перед миграцией свойства и метки сохранены в `before-compact-properties.json`.
`install_steps.py` формирует и устанавливает этот формат; `install.py`
устанавливает уже сохранённую проекцию.
