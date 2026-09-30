"""Operator CLI.

  python -m kritvia_api.cli bootstrap --email you@sitelytc.com --name "Mayank Thakur" --org "Sitelytc Group"
      Creates (or reuses) the owner account, the organisation and the three dogfood ventures
      (Sitelytc/software, Truhome Finance/finance, Cloud Kitchen/kitchen), gives the owner the
      working roles (approver, loan_officer, kitchen_manager), and enables the workflows with
      their schedules. Idempotent: safe to run again. Password is read from KRITVIA_BOOTSTRAP_PASSWORD
      or prompted.

  python -m kritvia_api.cli verify-audit --org <org_id>
      Recomputes the hash chain for an organisation (run as the migration/owner role).

  python -m kritvia_api.cli new-kek
      Prints a fresh base64 master key-encryption key (back it up offline!).
"""
from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import os
import sys
import uuid

from sqlalchemy import text

from kritvia_api.db.session import dispose_engine, tenant_tx
from kritvia_api.security import hash_password, verify_password

VENTURES = [
    {"name": "Sitelytc", "slug": "sitelytc", "kind": "software", "roles": ["approver"],
     "workflows": {"lead_triage": {}, "meeting_digest": {}}},
    {"name": "Truhome Finance", "slug": "truhome", "kind": "finance", "roles": ["loan_officer"],
     "workflows": {"loan_verification": {}, "meeting_digest": {}}},
    {"name": "Cloud Kitchen", "slug": "kitchen", "kind": "kitchen", "roles": ["kitchen_manager"],
     "workflows": {"kitchen_daily": {"schedule": "23:30"}}},
]


async def bootstrap(email: str, name: str, org_name: str, org_slug: str, password: str) -> dict:
    async with tenant_tx(None) as conn:
        row = (await conn.execute(text("SELECT * FROM auth_lookup(:e)"), {"e": email})).first()
        if row is None:
            if len(password) < 12:
                raise SystemExit("password must be at least 12 characters")
            uid = (await conn.execute(text("SELECT auth_register(:e, :n, :h)"),
                                      {"e": email, "n": name, "h": hash_password(password)})).scalar_one()
        else:
            if not verify_password(password, row.password_hash):
                raise SystemExit("an account with that email exists and the password does not match")
            uid = row.id
    out: dict = {"user_id": str(uid), "ventures": {}}
    async with tenant_tx(uid) as conn:
        org = (await conn.execute(text("SELECT id FROM organisations WHERE slug = :s"), {"s": org_slug})).scalar()
        if org is None:
            org = (await conn.execute(text("SELECT create_organisation(:n, :s)"),
                                      {"n": org_name, "s": org_slug})).scalar_one()
        out["org_id"] = str(org)
        for v in VENTURES:
            vid = (await conn.execute(text("SELECT id FROM ventures WHERE org_id = :o AND slug = :s"),
                                      {"o": org, "s": v["slug"]})).scalar()
            if vid is None:
                vid = (await conn.execute(text("SELECT create_venture(:o, :n, :s)"),
                                          {"o": org, "n": v["name"], "s": v["slug"]})).scalar_one()
            await conn.execute(text(
                "INSERT INTO venture_settings (org_id, venture_id, kind) VALUES (:o, :v, :k)"
                " ON CONFLICT (venture_id) DO UPDATE SET kind = EXCLUDED.kind"), {"o": org, "v": vid, "k": v["kind"]})
            for role in v["roles"]:
                exists = (await conn.execute(text(
                    "SELECT 1 FROM memberships WHERE user_id = :u AND venture_id = :v AND role = :r"),
                    {"u": uid, "v": vid, "r": role})).first()
                if not exists:
                    await conn.execute(text("SELECT add_member(:o, :v, :u, :r)"),
                                       {"o": org, "v": vid, "u": uid, "r": role})
            for wf, cfg in v["workflows"].items():
                await conn.execute(text(
                    "INSERT INTO workflow_configs (org_id, venture_id, workflow, enabled, schedule, settings, updated_by)"
                    " VALUES (:o, :v, :w, true, :s, '{}', :u) ON CONFLICT (venture_id, workflow) DO NOTHING"),
                    {"o": org, "v": vid, "w": wf, "s": cfg.get("schedule"), "u": uid})
            out["ventures"][v["slug"]] = str(vid)
    return out


async def verify_audit(org_id: uuid.UUID) -> None:
    import asyncpg
    dsn = os.environ.get("MIGRATION_DATABASE_URL")
    if not dsn:
        raise SystemExit("MIGRATION_DATABASE_URL is required")
    conn = await asyncpg.connect(dsn)
    try:
        broken = await conn.fetchval("SELECT private.audit_verify($1)", org_id)
        total = await conn.fetchval("SELECT count(*) FROM audit_log WHERE org_id = $1", org_id)
    finally:
        await conn.close()
    print(json.dumps({"org_id": str(org_id), "rows": total, "intact": broken is None, "first_broken_seq": broken}))
    if broken is not None:
        sys.exit(2)


def main() -> None:
    p = argparse.ArgumentParser(prog="kritvia")
    sub = p.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("bootstrap")
    b.add_argument("--email", required=True)
    b.add_argument("--name", required=True)
    b.add_argument("--org", default="Sitelytc Group")
    b.add_argument("--org-slug", default="sitelytc-group")
    v = sub.add_parser("verify-audit")
    v.add_argument("--org", required=True, type=uuid.UUID)
    sub.add_parser("new-kek")
    a = p.parse_args()

    if a.cmd == "new-kek":
        from kritvia_api.services.crypto import AESGCM
        import base64
        print(base64.b64encode(AESGCM.generate_key(bit_length=256)).decode())
        return
    if a.cmd == "verify-audit":
        asyncio.run(verify_audit(a.org))
        return
    password = os.environ.get("KRITVIA_BOOTSTRAP_PASSWORD") or getpass.getpass("Password (min 12 chars): ")

    async def run() -> dict:
        try:
            return await bootstrap(a.email, a.name, a.org, a.org_slug, password)
        finally:
            await dispose_engine()
    print(json.dumps(asyncio.run(run()), indent=2))


if __name__ == "__main__":
    main()
