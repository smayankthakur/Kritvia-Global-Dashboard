# services/mcp-runner — hosted MCP apps for the App store

Runs stdio MCP servers (npm via `npx`, PyPI via `uvx`, or a container image) that Kritvia's team approved, one
gVisor container per installed app, and bridges them to HTTP for the API (`POST /mcp/{id}`). See `app.py` for the
layers of isolation and `guard.py` for the egress proxy. Full description: `docs/app-store.md`.

```
docker compose --profile apps up -d --build mcp-runner     # needs MCP_RUNNER_TOKEN in .env and gVisor (runsc)
pytest services/mcp-runner/tests                           # local stdio server, no docker
```
