# MCP Neo4j

Current server: [mcp/neo4j_mcp_server.py](mcp/neo4j_mcp_server.py)

The server is a Python stdio MCP server for read-only Neo4j inspection.

## Profiles

- `local` reads `NEO4J_*` from [`.env`](.env).

## Tools

- `check_connection()`
- `neo4j_check_connection()`
- `run_read_query(query, parameters_json, limit)`
- `neo4j_run_read_query(query, parameters_json, limit)`
- `get_schema_overview()`
- `neo4j_get_schema_overview()`
- `get_function_catalog(query, relative_path_prefix, callable_tier, callable_kind, limit)`
- `neo4j_get_function_catalog(query, relative_path_prefix, callable_tier, callable_kind, limit)`
- `materialize_function_invocation(function_name, callable_kind)`
- `neo4j_materialize_function_invocation(function_name, callable_kind)`
- `invoke_materialized_function(function_name, callable_kind)`
- `neo4j_invoke_materialized_function(function_name, callable_kind)`

The `neo4j_*` aliases avoid name collisions with other MCP servers.

## Health Check

Run from repository root:

```powershell
& '.venv\Scripts\python.exe' 'graph\mcp\neo4j_mcp_server.py' --profile local --check
```

Expected shape:

```json
{
  "status": "ok",
  "uri": "neo4j://127.0.0.1:7687",
  "profile": "local",
  "database": "neo4j"
}
```

## VS Code

VS Code MCP config lives in [../.vscode/mcp.json](../.vscode/mcp.json):

```json
{
  "servers": {
    "neo4jGraph": {
      "type": "stdio",
      "command": "${workspaceFolder}\\.venv\\Scripts\\python.exe",
      "args": [
        "${workspaceFolder}\\graph\\mcp\\neo4j_mcp_server.py",
        "--profile",
        "local"
      ],
      "envFile": "${workspaceFolder}\\graph\\.env"
    }
  }
}
```

VS Code must be opened with `C:\GitHub\teleGraph` as the workspace folder for `${workspaceFolder}` to resolve correctly.

## Codex

Codex MCP config is global in `C:\Users\a1ole\.codex\config.toml`.

Current entry:

```toml
[mcp_servers.neo4jGraph]
command = 'C:\GitHub\teleGraph\.venv\Scripts\python.exe'
args = ['C:\GitHub\teleGraph\graph\mcp\neo4j_mcp_server.py', '--profile', 'local']
```

The server loads `graph/.env` itself, so Neo4j credentials are not duplicated in Codex config.

After editing Codex MCP config, restart the Codex session/window. MCP tools are discovered at session startup; `tool_search` cannot expose a server that was not registered when the session started.

After restart, this should return tools:

```text
tool_search("neo4j_check_connection neo4j_run_read_query neo4j_get_schema_overview")
```

## Troubleshooting

1. Neo4j must be running.
2. The health check above must return `"status": "ok"`.
3. `.venv\Scripts\python.exe` and `graph\mcp\neo4j_mcp_server.py` must exist.
4. If `tool_search` returns no Neo4j tools after config changes, restart Codex or VS Code.
5. Restarting the graph orchestrator does not restart MCP. The orchestrator and MCP server are separate processes.
