"""Allow-listed jobs that run inside the Kritvia sandbox.

Each job is a pure function: JSON in (stdin) -> JSON out (stdout). No network,
no filesystem beyond /tmp, no secrets. Numbers that reach clients (forecasts,
quantities, PO totals) are computed here, deterministically — never by an LLM.
"""
JOBS = ("forecast", "bom", "echo", "net_probe")
