"""Next-day demand forecast per dish.

Model selection (deterministic for identical input):
  * statsforecast AutoETS(season_length=7) when installed and >= 28 days of history
  * otherwise a weighted same-weekday model with a clamped recent-trend factor
  * fewer than 7 days: mean of what exists

Missing dates inside the history are treated as zero sales (kitchen open, nothing
sold). A 7-day rolling-origin backtest reports MAPE so the UI can show how much
to trust each dish's number.
"""
from __future__ import annotations

import math
from datetime import date, timedelta

WEEKDAY_WEIGHTS = (0.4, 0.3, 0.2, 0.1)


def _dense(points: list[dict], end: date) -> list[float]:
    if not points:
        return []
    by_day: dict[date, float] = {}
    for p in points:
        d = date.fromisoformat(str(p["date"])[:10])
        by_day[d] = by_day.get(d, 0.0) + float(p["qty"])
    start = min(by_day)
    n = (end - start).days + 1
    return [by_day.get(start + timedelta(days=i), 0.0) for i in range(max(n, 0))]


def _weighted_weekday(history: list[float]) -> float:
    n = len(history)
    if n == 0:
        return 0.0
    if n < 7:
        return sum(history) / n
    same = [history[n - 7 * k] for k in range(1, 5) if n - 7 * k >= 0]
    w = WEEKDAY_WEIGHTS[: len(same)]
    base = sum(a * b for a, b in zip(same, w)) / sum(w)
    if n >= 14:
        last, prev = sum(history[-7:]) / 7, sum(history[-14:-7]) / 7
        if prev > 0:
            base *= min(1.25, max(0.8, last / prev))
    return max(0.0, base)


def _ets(history: list[float]) -> float | None:
    try:
        import numpy as np  # type: ignore
        from statsforecast.models import AutoETS  # type: ignore
    except ImportError:
        return None
    if len(history) < 28:
        return None
    model = AutoETS(season_length=7)
    res = model.forecast(y=np.asarray(history, dtype=float), h=1)
    return max(0.0, float(res["mean"][0]))


def predict(history: list[float]) -> tuple[float, str]:
    ets = _ets(history)
    if ets is not None:
        return ets, "auto_ets"
    return _weighted_weekday(history), ("weekday_weighted" if len(history) >= 7 else "mean")


def backtest_mape(history: list[float], days: int = 7) -> float | None:
    errs = []
    for i in range(min(days, len(history)), 0, -1):
        train, actual = history[:-i], history[-i]
        if len(train) < 7 or actual <= 0:
            continue
        pred, _ = predict(train)
        errs.append(abs(pred - actual) / actual)
    return round(100 * sum(errs) / len(errs), 1) if errs else None


def run(payload: dict) -> dict:
    target = date.fromisoformat(payload["target_date"])
    end = target - timedelta(days=1)
    out = {}
    for dish, points in (payload.get("series") or {}).items():
        history = _dense([p for p in points if date.fromisoformat(str(p["date"])[:10]) <= end], end)
        qty, method = predict(history)
        mape = backtest_mape(history)
        spread = (mape or 25.0) / 100
        out[dish] = {
            "qty": round(qty, 2),
            "lo": round(max(0.0, qty * (1 - spread)), 2),
            "hi": round(qty * (1 + spread), 2),
            "method": method,
            "history_days": len(history),
            "mape_backtest": mape,
            "same_weekday_last_week": history[-7] if len(history) >= 7 else None,
            "yesterday": history[-1] if history else None,
        }
    return {"target_date": target.isoformat(), "forecasts": out,
            "portions_total": math.fsum(v["qty"] for v in out.values())}
