from __future__ import annotations

import base64
import os
import uuid

import asyncpg
import pytest

from conftest import ADMIN_DSN

from kritvia_api.db.session import tenant_tx
from kritvia_api.services.crypto import CryptoError, EnvelopeCrypto, LocalKeyProvider

pytestmark = pytest.mark.asyncio


def provider():
    return LocalKeyProvider(os.environ["MASTER_KEK_B64"])


async def test_notes_are_ciphertext_at_rest(world):
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        raw = await conn.fetchval("SELECT notes_enc FROM leads WHERE id = $1", uuid.UUID(world["a_lead"]))
        wrapped = await conn.fetchval("SELECT wrapped_dek FROM tenant_keys WHERE venture_id = $1",
                                      uuid.UUID(world["site"]))
    finally:
        await conn.close()
    assert raw[:3] == b"KV1" and b"Next.js" not in raw
    assert wrapped is not None and len(wrapped) == 12 + 32 + 16


async def test_ciphertext_is_bound_to_venture_and_purpose(world):
    site, tru = uuid.UUID(world["site"]), uuid.UUID(world["tru"])
    async with tenant_tx(world["mayank"].id) as conn:
        c = EnvelopeCrypto(conn, provider())
        blob = await c.encrypt(site, "leads.notes", "hello")
        assert await c.decrypt_str(site, "leads.notes", blob) == "hello"
        with pytest.raises(CryptoError):
            await c.decrypt(site, "loan.documents", blob)       # wrong purpose
        with pytest.raises(CryptoError):
            await c.decrypt(tru, "leads.notes", blob)           # copied to another venture
        tampered = blob[:-1] + bytes([blob[-1] ^ 1])
        with pytest.raises(CryptoError):
            await c.decrypt(site, "leads.notes", tampered)


async def test_rotation_keeps_old_data_readable(world):
    site = uuid.UUID(world["site"])
    async with tenant_tx(world["mayank"].id) as conn:
        c = EnvelopeCrypto(conn, provider())
        old = await c.encrypt(site, "p", "before rotation")
        new_version = await c.rotate(site)
        new = await c.encrypt(site, "p", "after rotation")
    async with tenant_tx(world["mayank"].id) as conn:
        c = EnvelopeCrypto(conn, provider())
        assert await c.decrypt_str(site, "p", old) == "before rotation"
        assert await c.decrypt_str(site, "p", new) == "after rotation"
    assert new_version >= 2 and old[3:7] != new[3:7]


async def test_wrong_master_key_cannot_unwrap(world):
    other = LocalKeyProvider(base64.b64encode(os.urandom(32)).decode())
    async with tenant_tx(world["alice"].id) as conn:
        blob = await EnvelopeCrypto(conn, provider()).encrypt(uuid.UUID(world["site"]), "p", "x")
    async with tenant_tx(world["alice"].id) as conn:
        with pytest.raises(CryptoError):
            await EnvelopeCrypto(conn, other).decrypt(uuid.UUID(world["site"]), "p", blob)


async def test_user_without_access_cannot_load_venture_key(world):
    """RLS hides tenant_keys too: Alice cannot even fetch Truhome's wrapped DEK."""
    async with tenant_tx(world["bob"].id) as conn:
        blob = await EnvelopeCrypto(conn, provider()).encrypt(uuid.UUID(world["tru"]), "p", "loan data")
    async with tenant_tx(world["alice"].id) as conn:
        with pytest.raises(CryptoError, match="key version not found"):
            await EnvelopeCrypto(conn, provider()).decrypt(uuid.UUID(world["tru"]), "p", blob)
