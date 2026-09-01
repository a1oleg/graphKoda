# coldKode Graph Explorer

Local VS Code extension for browsing the graph-backed function diagram.

Current first slice:

- the explorer exposes `onSubmit`;
- flow and sequence diagrams are standalone files under `graph/draw/generated`;
- annotation snippets are directly editable and persist confirmed edits to the graph and diagram;
- flow names follow `<function-name>-<source-file>-<start-line>.drawio`;
- sequence names add the `-sequence` suffix;
- parameter and developer-defined nodes expose a `показать функциональный сегмент` action; the generated `-functional-segment` diagram renders the minimal connected projection of extracted TypeScript paths from the root through annotated entities to the first real `System` declarations, omits the root's type-only context, retains unannotated connector nodes only when a real path needs them, keeps descendants of a three-way split in fixed annotation-width lanes, visually merges same-range shorthand `PropertyValue`/`ValueReference` and `ArgumentValue`/`ObjectConstruction` roles, absorbs callee references into calls whose selected `CALLS` declaration is known, and embeds each ready annotation inside its source entity;
- flow diagrams load the complete function-owned graph, including its proxies, while separately declared local-function bodies remain in their own diagrams;
- selecting a diagram refreshes the generated file from the current graph before opening it; annotation cells are preserved.
