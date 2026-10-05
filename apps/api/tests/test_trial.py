"""The Free plan is a 15-day trial. Trials are held open until online payment is live; after
that an unpaid organisation becomes read-only (view, export, delete) until it chooses a plan.
Each person gets one free trial."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import asyncpg
import pytest

from conftest import ADMIN_DSN, make_actor

from kritvia_api.config import get_settings
from kritvia_api.services.quota import trial_for

pytestmark = pytest.mark.asyncio


async def _trial_org(client, monkeypatch, name="trial"):
    monkeypatch.setattr(get_settings(), "default_plan", "free")
    owner = await make_actor(client, name)
    org = (await owner.post("/orgs", json={"name": "Trial Co", "slug": "t-" + uuid.uuid4().hex[:8]})).json()["id"]
    v = (await owner.post(f"/orgs/{org}/ventures", json={"name": "Shop", "slug": "shop"})).json()["id"]
    return owner, org, v


async def _end_trial(org, days_ago=1):
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute("UPDATE organisations SET trial_ends_at = now() - make_interval(days => $2) WHERE id = $1",
                           uuid.UUID(org), days_ago)
    finally:
        await conn.close()


async def test_trial_lasts_15_days_and_waits_for_payments(client, monkeypatch):
    owner, org, v = await _trial_org(client, monkeypatch)
    monkeypatch.setattr(get_settings(), "payments_live_at", datetime.now(UTC) - timedelta(days=30))
    plan = (await owner.get(f"/orgs/{org}/plan")).json()
    assert plan["plan"]["code"] == "free" and plan["plan"]["name"] == "Free trial" and plan["plan"]["trial_days"] == 15
    assert plan["trial"]["days_left"] in (15, 16) and not plan["trial"]["expired"] and not plan["read_only"]

    await _end_trial(org)
    # payments not live yet: the trial is held open
    monkeypatch.setattr(get_settings(), "payments_live_at", None)
    plan = (await owner.get(f"/orgs/{org}/plan")).json()
    assert plan["trial"]["held"] and not plan["read_only"]
    # payments went live yesterday: 3 more days to choose
    monkeypatch.setattr(get_settings(), "payments_live_at", datetime.now(UTC) - timedelta(days=1))
    assert not (await owner.get(f"/orgs/{org}/plan")).json()["read_only"]
    t = trial_for("free", datetime.now(UTC) - timedelta(days=1))
    assert t and not t.expired and (t.ends_at - datetime.now(UTC)).days == 1


async def test_ended_trial_is_read_only_until_a_plan_is_chosen(client, monkeypatch):
    owner, org, v = await _trial_org(client, monkeypatch, "expired")
    lead = (await owner.post(f"/ventures/{v}/leads", json={"name": "Before", "notes": "x"})).json()["id"]
    await _end_trial(org)
    monkeypatch.setattr(get_settings(), "payments_live_at", datetime.now(UTC) - timedelta(days=30))

    plan = (await owner.get(f"/orgs/{org}/plan")).json()
    assert plan["read_only"] and plan["plan"]["code"] == "expired" and plan["trial"]["expired"]
    # nothing new: writes answer 402 with a clear message
    r = await owner.post(f"/ventures/{v}/leads", json={"name": "After", "notes": "x"})
    assert r.status_code == 402 and "free trial has ended" in r.json()["detail"]
    assert (await owner.post(f"/orgs/{org}/ventures", json={"name": "Two", "slug": "two"})).status_code == 402
    r = await owner.post(f"/ventures/{v}/runs", json={"workflow": "inbox_assistant", "input": {"text": "hi"}})
    assert r.status_code == 402
    # but people can still read, export and delete
    assert (await owner.get(f"/ventures/{v}/leads")).status_code == 200
    assert (await owner.get("/auth/me/export")).status_code == 200
    assert (await owner.delete(f"/ventures/{v}/leads/{lead}")).status_code == 204
    # choosing a plan stays open, and a paid plan lifts the lock at once
    assert (await owner.get(f"/orgs/{org}/billing")).status_code in (200, 404)
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute("SELECT set_org_plan($1, 'starter', NULL)", uuid.UUID(org))
    finally:
        await conn.close()
    assert (await owner.post(f"/ventures/{v}/leads", json={"name": "Paid", "notes": "x"})).status_code == 201
    assert not (await owner.get(f"/orgs/{org}/plan")).json()["read_only"]


async def test_one_free_trial_per_person(client, monkeypatch):
    owner, org, _ = await _trial_org(client, monkeypatch, "twice")
    r = await owner.post("/orgs", json={"name": "Second", "slug": "s-" + uuid.uuid4().hex[:8]})
    assert r.status_code == 402 and "already have a free trial for Trial Co" in r.json()["detail"]
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute("SELECT set_org_plan($1, 'growth', NULL)", uuid.UUID(org))
    finally:
        await conn.close()
    assert (await owner.post("/orgs", json={"name": "Second", "slug": "s-" + uuid.uuid4().hex[:8]})).status_code == 201
