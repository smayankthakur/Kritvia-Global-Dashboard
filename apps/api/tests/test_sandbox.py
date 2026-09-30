"""Sandbox jobs are deterministic, and the real sandbox has no network."""
from __future__ import annotations

import json
import shutil
import subprocess
from datetime import date, timedelta

import pytest

from kritvia_api.services.sandbox import LocalSandbox, SandboxError



def _series(days: int, base: float, weekend_boost: float, end: date) -> list[dict]:
    out = []
    for i in range(days):
        d = end - timedelta(days=days - 1 - i)
        out.append({"date": d.isoformat(), "qty": base + (weekend_boost if d.weekday() >= 5 else 0)})
    return out


async def test_forecast_learns_weekday_pattern():
    sb = LocalSandbox("test")
    target = date(2026, 10, 3)  # a Saturday
    series = {"biryani": _series(56, 40, 20, target - timedelta(days=1)),
              "new_dish": _series(3, 10, 0, target - timedelta(days=1)),
              "no_sales": []}
    out = await sb.run("forecast", {"target_date": target.isoformat(), "series": series})
    f = out["forecasts"]
    assert 58 <= f["biryani"]["qty"] <= 62            # Saturday ~ 60
    assert f["biryani"]["mape_backtest"] is not None and f["biryani"]["mape_backtest"] < 5
    assert f["new_dish"]["method"] == "mean" and f["new_dish"]["qty"] == 10
    assert f["no_sales"]["qty"] == 0
    again = await sb.run("forecast", {"target_date": target.isoformat(), "series": series})
    assert again == out                                # deterministic


async def test_bom_rounds_to_packs_and_totals_in_paise():
    sb = LocalSandbox("test")
    out = await sb.run("bom", {
        "portions": {"biryani": 60, "dal": 0, "mystery": 5},
        "recipes": {"biryani": [{"ingredient_id": "rice", "qty_per_portion": "0.15", "wastage_pct": "5"},
                                {"ingredient_id": "chicken", "qty_per_portion": "0.2"},
                                {"ingredient_id": "saffron", "qty_per_portion": "0.001"}]},
        "stock": {"rice": 2.5, "chicken": 20},
        "supply": {"rice": {"vendor_id": "v1", "pack_size": "5", "price_per_pack": "412.50", "min_order_packs": 1},
                   "chicken": {"vendor_id": "v2", "pack_size": "1", "price_per_pack": "240"}},
        "safety_stock_pct": 10,
    })
    req = {r["ingredient_id"]: r for r in out["requirements"]}
    assert req["rice"]["required"] == 9.45                      # 60 * 0.15 * 1.05
    # (9.45 * 1.1) - 2.5 = 7.895 kg -> 2 packs of 5 kg
    po_rice = [p for p in out["purchase_orders"] if p["vendor_id"] == "v1"][0]
    assert po_rice["lines"][0]["packs"] == 2 and po_rice["total"] == "825.00"
    assert not [p for p in out["purchase_orders"] if p["vendor_id"] == "v2"]   # 13.2 kg needed, 20 on hand
    assert out["unsourced_ingredients"] == ["saffron"]
    assert out["dishes_without_recipe"] == ["mystery"]
    assert out["grand_total"] == "825.00"


async def test_only_allow_listed_jobs_run():
    with pytest.raises(SandboxError):
        await LocalSandbox("test").run("rm_rf", {})


def test_local_sandbox_refuses_production():
    with pytest.raises(SandboxError):
        LocalSandbox("production")


@pytest.mark.skipif(not shutil.which("docker") or subprocess.run(["docker", "info"], capture_output=True).returncode,
                    reason="Docker daemon not available")
def test_docker_sandbox_has_no_network():
    """Exit criterion: sandboxed code cannot reach the network (runs the runner's exact argv)."""
    import importlib.util
    from pathlib import Path

    root = Path(__file__).resolve().parents[3]
    spec = importlib.util.spec_from_file_location("runner_app", root / "services/sandbox/runner/app.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    argv = mod.docker_argv(mod.RunIn(job="net_probe"))
    assert "--network=none" in argv and "--read-only" in argv and "--cap-drop=ALL" in argv
    runtime = "runsc" if shutil.which("runsc") else "runc"
    argv = [a if not a.startswith("--runtime=") else f"--runtime={runtime}" for a in argv]
    subprocess.run(["docker", "build", "-q", "-f", str(root / "services/sandbox/jobs/Dockerfile"), "-t",
                    "kritvia-sandbox-jobs:latest", str(root / "services/sandbox")], check=True, capture_output=True)
    res = subprocess.run(argv, input=b"{}", capture_output=True, timeout=120)
    assert json.loads(res.stdout)["network"] is False
