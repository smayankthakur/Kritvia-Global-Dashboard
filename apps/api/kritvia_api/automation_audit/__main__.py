"""python -m kritvia_api.automation_audit [--json PATH] [--write-baseline]"""
from __future__ import annotations

import argparse
import json
import sys

from kritvia_api.automation_audit import audit


def main() -> int:
    ap = argparse.ArgumentParser(description="Kritvia automation scorecard")
    ap.add_argument("--json", help="write the full report as JSON to this path")
    ap.add_argument("--write-baseline", action="store_true", help="save today's levels as the floor the tests keep")
    a = ap.parse_args()
    report = audit.run()
    if a.json:
        with open(a.json, "w") as f:
            json.dump(report, f, indent=2, ensure_ascii=False)
    if a.write_baseline:
        audit.BASELINE.write_text(json.dumps({j["key"]: j["level"] for j in report["jobs"]}, indent=2) + "\n")
    sys.stdout.write(audit.markdown(report))
    bad = [f"{j['key']}: {p}" for j in report["jobs"] for p in j["problems"]] + \
          [f"{i['workflow']}: {i['problem']}" for i in report["integrity"]] + audit.regressions(report)
    for b in bad:
        sys.stderr.write(f"PROBLEM {b}\n")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
