# Diagram Workflow

- The user describes the current diagram and the desired result for a concrete case.
- Implement that change and run the existing draw.io MCP checks against the actual diagram. Fix findings before finishing.
- When the user reports a collision, fix it and add an automatic check for that real case.
- Do not invent or run synthetic renderer/extractor scenarios, fabricated graphs, or mock diagram XML. Use actual source and generated diagrams.
- Do not inspect diagram screenshots; use the project's draw.io MCP.
- Report checks for the diagram being worked on, not unrelated test suites.
