"""Minimal forward-only SQL migration runner.

Migrations are plain .sql files in apps/api/migrations, applied in filename
order, each in its own transaction, as the owner role. A checksum is stored so
an edited-after-apply migration is caught instead of silently diverging.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import sys
from pathlib import Path

import asyncpg

MIGRATIONS_DIR = Path(os.environ.get("KRITVIA_MIGRATIONS_DIR")
                      or Path(__file__).resolve().parents[2] / "migrations")


async def migrate(dsn: str, directory: Path = MIGRATIONS_DIR) -> list[str]:
    conn = await asyncpg.connect(dsn)
    applied: list[str] = []
    try:
        await conn.execute(
            """CREATE TABLE IF NOT EXISTS schema_migrations (
                   version text PRIMARY KEY,
                   checksum text NOT NULL,
                   applied_at timestamptz NOT NULL DEFAULT now())"""
        )
        done = {r["version"]: r["checksum"] for r in await conn.fetch("SELECT * FROM schema_migrations")}
        for path in sorted(directory.glob("*.sql")):
            sql = path.read_text()
            checksum = hashlib.sha256(sql.encode()).hexdigest()
            version = path.stem
            if version in done:
                if done[version] != checksum:
                    raise RuntimeError(f"migration {version} was modified after being applied")
                continue
            async with conn.transaction():
                await conn.execute(sql)
                await conn.execute(
                    "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", version, checksum
                )
            applied.append(version)
    finally:
        await conn.close()
    return applied


if __name__ == "__main__":
    dsn = os.environ.get("MIGRATION_DATABASE_URL")
    if not dsn:
        sys.exit("MIGRATION_DATABASE_URL is required (connect as kritvia_owner)")
    for v in asyncio.run(migrate(dsn)):
        print(f"applied {v}")
