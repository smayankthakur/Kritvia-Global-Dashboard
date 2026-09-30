"""Entry point: python -m kritvia_jobs <job>  (input JSON on stdin, output JSON on stdout)."""
from __future__ import annotations

import json
import sys

from kritvia_jobs import JOBS

MAX_INPUT = 20 * 1024 * 1024


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in JOBS:
        print(json.dumps({"error": f"unknown job; allowed: {', '.join(JOBS)}"}))
        return 2
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        print(json.dumps({"error": "input too large"}))
        return 2
    payload = json.loads(raw or b"{}")
    job = sys.argv[1]
    if job == "forecast":
        from kritvia_jobs.forecast import run
    elif job == "bom":
        from kritvia_jobs.bom import run
    elif job == "net_probe":
        from kritvia_jobs.probe import run
    else:
        def run(p):  # echo: used by health checks
            return {"echo": p}
    out = run(payload)
    sys.stdout.write(json.dumps(out, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
