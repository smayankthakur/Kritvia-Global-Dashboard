# services/mcp-runner — hosted MCP apps for the App store

Runs stdio MCP servers (npm via `npx`, PyPI via `uvx`, or a container image) that Kritvia's team approved, one
gVisor container per installed app, and bridges them to HTTP for the API (`POST /mcp/{id}`). See `app.py` for the
layers of isolation and `guard.py` for the egress proxy. Full description: `docs/app-store.md`.

```
docker compose --profile apps up -d --build mcp-runner     # needs MCP_RUNNER_TOKEN in .env and gVisor (runsc)
pytest services/mcp-runner/tests                           # local stdio server, no docker
```

## Pinned releases and separation (test report round 2: S6, S7)

- Approvals are pinned to the registry's own fingerprint of the reviewed release (npm sha512 integrity, the
  sha256 of one PyPI file, an image digest). The instance downloads exactly that file and checks it before
  running anything; images run by digest. An approval also names the package exactly as the reviewer saw it, and
  a resubmission can't rewrite an approved entry, or a waiting one someone else sent in.
- Each instance runs on an internal network of its own (`kv-mcp-…`), shared only with this runner's egress proxy,
  so apps of different businesses can't reach each other (`MCP_PER_APP_NETWORK=0` uses the shared network).
- The control API (8300) refuses any request that arrives over a sandbox network.
- In production the runner reaches Docker through `mcp-docker` (tecnativa/docker-socket-proxy, pinned by digest),
  limited to containers, networks and images; the runner no longer mounts the Docker socket.
