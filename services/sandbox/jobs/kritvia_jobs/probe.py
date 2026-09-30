"""Isolation self-test: tries to open an outbound socket. Inside the sandbox
this must fail; the runner's health check asserts {"network": false}."""
from __future__ import annotations

import socket


def run(payload: dict) -> dict:
    host = payload.get("host", "1.1.1.1")
    port = int(payload.get("port", 53))
    try:
        with socket.create_connection((host, port), timeout=2):
            return {"network": True}
    except OSError as exc:
        return {"network": False, "error": type(exc).__name__}
