# services/sandbox — isolated execution for agent computations

```
jobs/kritvia_jobs   allow-listed pure jobs: forecast, bom (+ echo, net_probe for health)
jobs/Dockerfile     job image (numpy + statsforecast), no secrets
runner/app.py       HTTP runner: starts one gVisor container per job
runner/Dockerfile   runner image (only service with the Docker socket)
```

Defence in depth (see `runner/app.py`):

1. **gVisor** (`--runtime=runsc`) — user-space kernel between job and host.
2. **Container limits** — `--network=none`, read-only root, noexec tmpfs, all caps dropped,
   `no-new-privileges`, uid 65534, memory/CPU/pids limits, timeout, fresh container per job.
3. **Allow-list** — only jobs baked into the image; capped input/output sizes.

## Install gVisor on the Oracle ARM VM

```bash
curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
  | sudo tee /etc/apt/sources.list.d/gvisor.list
sudo apt-get update && sudo apt-get install -y runsc
sudo runsc install && sudo systemctl restart docker
docker build -f services/sandbox/jobs/Dockerfile -t kritvia-sandbox-jobs:latest services/sandbox   # from repo root
```

## Exit test: sandboxed code cannot reach the network

`GET /healthz` runs the `net_probe` job, which tries to open a socket, and fails
loudly if it succeeds. `apps/api/tests/test_sandbox.py::test_docker_sandbox_has_no_network`
runs the same check against real Docker when available (skipped otherwise).

The API also ships `LocalSandbox` (subprocess, same jobs, resource limits, no
network isolation) for tests and laptop development. It refuses to start when
`ENVIRONMENT=production`.
