"""Minimal forward-only SQL migration runner.

Migrations are plain .sql files in apps/api/migrations, applied in filename
order, each in its own transaction, as the owner role. A checksum is stored so
an edited-after-apply migration is caught instead of silently diverging.

Running beside a live API (every deploy):
  * one migrator at a time (a Postgres advisory lock);
  * each migration waits at most MIGRATION_LOCK_TIMEOUT (default 5s) for a table lock instead of
    queueing behind a long transaction while every query queues behind it; it is tried again 3 times,
    then the deploy stops (deploy.sh keeps the old version running);
  * a file whose first line is `-- kritvia: no-transaction` runs outside a transaction, for
    CREATE INDEX CONCURRENTLY (one statement per such file).
Write migrations to take short locks: constraints NOT VALID and then VALIDATE, indexes on big tables
CONCURRENTLY, no table rewrites.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import sys
from pathlib import Path

import asyncpg

LOCK_KEY = 7310421          # pg_advisory_lock key: one migrator at a time
NO_TRANSACTION = "-- kritvia: no-transaction"
MIGRATIONS_DIR = Path(os.environ.get("KRITVIA_MIGRATIONS_DIR")
                      or Path(__file__).resolve().parents[2] / "migrations")


async def _apply(conn, sql: str, version: str, checksum: str, lock_timeout: str) -> None:
    record = "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)"
    if sql.lstrip().startswith(NO_TRANSACTION):
        await conn.execute(f"SET lock_timeout = '{lock_timeout}'")
        try:
            await conn.execute(sql)
        finally:
            await conn.execute("RESET lock_timeout")
        await conn.execute(record, version, checksum)
        return
    async with conn.transaction():
        await conn.execute(f"SET LOCAL lock_timeout = '{lock_timeout}'")
        await conn.execute(sql)
        await conn.execute(record, version, checksum)


async def migrate(dsn: str, directory: Path = MIGRATIONS_DIR, *, attempts: int = 4) -> list[str]:
    conn = await asyncpg.connect(dsn)
    applied: list[str] = []
    lock_timeout = os.environ.get("MIGRATION_LOCK_TIMEOUT", "5s")
    if not lock_timeout.replace("ms", "").replace("s", "").isdigit():
        raise ValueError("MIGRATION_LOCK_TIMEOUT must look like 5s or 500ms")
    try:
        await conn.execute("SELECT pg_advisory_lock($1)", LOCK_KEY)
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
            for attempt in range(1, attempts + 1):
                try:
                    await _apply(conn, sql, version, checksum, lock_timeout)
                    break
                except asyncpg.exceptions.LockNotAvailableError:
                    if attempt == attempts:
                        raise RuntimeError(f"migration {version} could not get its table locks within "
                                           f"{lock_timeout} ({attempts} tries); a long transaction is holding them") from None
                    print(f"migration {version}: tables busy, trying again ({attempt}/{attempts})", file=sys.stderr)
                    await asyncio.sleep(3 * attempt)
            applied.append(version)
    finally:
        try:
            await conn.execute("SELECT pg_advisory_unlock_all()")
        finally:
            await conn.close()
    return applied


if __name__ == "__main__":
    dsn = os.environ.get("MIGRATION_DATABASE_URL")
    if not dsn:
        sys.exit("MIGRATION_DATABASE_URL is required (connect as kritvia_owner)")
    for v in asyncio.run(migrate(dsn)):
        print(f"applied {v}")
