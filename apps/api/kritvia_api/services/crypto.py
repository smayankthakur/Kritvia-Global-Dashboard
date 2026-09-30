"""Envelope encryption: one data-encryption key (DEK) per venture, wrapped by a
key-encryption key (KEK).

  plaintext --AES-256-GCM(DEK)--> ciphertext stored in the column
  DEK       --AES-256-GCM(KEK)--> wrapped_dek stored in tenant_keys

The KEK sits behind KeyProvider. LocalKeyProvider keeps it in an env var on the
VM (dogfooding); a KmsKeyProvider for the client's cloud KMS implements the same
two methods for VPC deployments, and nothing else changes.

Associated data binds every ciphertext to its venture and purpose, so a value
copied into another venture's row, or another column, fails to decrypt.

Blob layout:  b"KV1" | key_version (4 bytes, big-endian) | nonce (12) | ciphertext+tag
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import struct
import uuid
from typing import Protocol

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection

MAGIC = b"KV1"
_HEADER = struct.Struct(">3sI")


class CryptoError(Exception):
    pass


class KeyProvider(Protocol):
    kek_id: str

    def wrap(self, dek: bytes, context: bytes) -> bytes: ...
    def unwrap(self, wrapped: bytes, context: bytes) -> bytes: ...
    def keyed_hash(self, label: str, data: bytes) -> str: ...


class LocalKeyProvider:
    def __init__(self, kek_b64: str, kek_id: str = "local-v1") -> None:
        if not kek_b64:
            raise CryptoError("MASTER_KEK_B64 is not set; generate one with `python -m kritvia_api.services.crypto`")
        key = base64.b64decode(kek_b64)
        if len(key) != 32:
            raise CryptoError("master KEK must be 32 bytes")
        self._aead = AESGCM(key)
        self._hash_key = HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
                              info=b"kritvia-keyed-hash-v1").derive(key)
        self.kek_id = kek_id

    def keyed_hash(self, label: str, data: bytes) -> str:
        """Deterministic, non-reversible identifier (HMAC-SHA256 under a KEK-derived key)."""
        return hmac.new(self._hash_key, label.encode() + b"|" + data, hashlib.sha256).hexdigest()

    def wrap(self, dek: bytes, context: bytes) -> bytes:
        nonce = os.urandom(12)
        return nonce + self._aead.encrypt(nonce, dek, context)

    def unwrap(self, wrapped: bytes, context: bytes) -> bytes:
        try:
            return self._aead.decrypt(wrapped[:12], wrapped[12:], context)
        except Exception as exc:  # InvalidTag
            raise CryptoError("unable to unwrap DEK") from exc


def _kek_context(venture_id: uuid.UUID, version: int) -> bytes:
    return f"kritvia-dek|{venture_id}|{version}".encode()


def _data_aad(venture_id: uuid.UUID, purpose: str) -> bytes:
    return f"kritvia-data|{venture_id}|{purpose}".encode()


class EnvelopeCrypto:
    """Per-request helper. DEKs are cached only for the lifetime of this object."""

    def __init__(self, conn: AsyncConnection, provider: KeyProvider) -> None:
        self._conn = conn
        self._provider = provider
        self._deks: dict[tuple[uuid.UUID, int], bytes] = {}

    async def _load(self, venture_id: uuid.UUID, version: int | None) -> tuple[int, bytes] | None:
        q = "SELECT key_version, wrapped_dek FROM tenant_keys WHERE venture_id = :v"
        params: dict = {"v": venture_id}
        if version is not None:
            q += " AND key_version = :ver"
            params["ver"] = version
        q += " ORDER BY key_version DESC LIMIT 1"
        row = (await self._conn.execute(text(q), params)).first()
        if row is None:
            return None
        ver, wrapped = row
        dek = self._provider.unwrap(bytes(wrapped), _kek_context(venture_id, ver))
        self._deks[(venture_id, ver)] = dek
        return ver, dek

    async def _current_dek(self, venture_id: uuid.UUID) -> tuple[int, bytes]:
        found = await self._load(venture_id, None)
        if found:
            return found
        return await self._create(venture_id, 1)

    async def _create(self, venture_id: uuid.UUID, version: int) -> tuple[int, bytes]:
        dek = AESGCM.generate_key(bit_length=256)
        wrapped = self._provider.wrap(dek, _kek_context(venture_id, version))
        try:
            async with self._conn.begin_nested():
                await self._conn.execute(
                    text(
                        "INSERT INTO tenant_keys (org_id, venture_id, key_version, wrapped_dek, kek_id) "
                        "SELECT org_id, id, :ver, :w, :kek FROM ventures WHERE id = :v"
                    ),
                    {"v": venture_id, "ver": version, "w": wrapped, "kek": self._provider.kek_id},
                )
        except IntegrityError:
            # Another request created it first; use theirs.
            found = await self._load(venture_id, version)
            if found is None:
                raise
            return found
        self._deks[(venture_id, version)] = dek
        return version, dek

    async def rotate(self, venture_id: uuid.UUID) -> int:
        """Add a new DEK version. Old ciphertexts stay readable; new writes use the new key."""
        current = await self._load(venture_id, None)
        next_version = (current[0] + 1) if current else 1
        ver, _ = await self._create(venture_id, next_version)
        return ver

    async def encrypt(self, venture_id: uuid.UUID, purpose: str, plaintext: str | bytes) -> bytes:
        data = plaintext.encode() if isinstance(plaintext, str) else plaintext
        ver, dek = await self._current_dek(venture_id)
        nonce = os.urandom(12)
        ct = AESGCM(dek).encrypt(nonce, data, _data_aad(venture_id, purpose))
        return _HEADER.pack(MAGIC, ver) + nonce + ct

    async def decrypt(self, venture_id: uuid.UUID, purpose: str, blob: bytes) -> bytes:
        blob = bytes(blob)
        magic, ver = _HEADER.unpack_from(blob)
        if magic != MAGIC:
            raise CryptoError("unrecognised ciphertext format")
        dek = self._deks.get((venture_id, ver))
        if dek is None:
            found = await self._load(venture_id, ver)
            if found is None:
                raise CryptoError("key version not found for this venture")
            dek = found[1]
        off = _HEADER.size
        try:
            return AESGCM(dek).decrypt(blob[off : off + 12], blob[off + 12 :], _data_aad(venture_id, purpose))
        except Exception as exc:
            raise CryptoError("decryption failed (wrong venture, purpose or tampered data)") from exc

    async def decrypt_str(self, venture_id: uuid.UUID, purpose: str, blob: bytes | None) -> str | None:
        if blob is None:
            return None
        return (await self.decrypt(venture_id, purpose, blob)).decode()


def principal_hash(provider: KeyProvider, org_id: uuid.UUID, identifier: str) -> str:
    """Stable pseudonymous id for a data principal within an org (DPDP requests,
    consents, erasure). Normalises emails/phones/PAN so the same person matches."""
    ident = identifier.strip().lower()
    digits = "".join(ch for ch in ident if ch.isdigit())
    if "@" not in ident and len(digits) >= 10 and len(digits) == len(ident.replace("+", "").replace(" ", "")
                                                                     .replace("-", "")):
        ident = digits[-10:]  # phone numbers: last 10 digits
    return provider.keyed_hash(f"dp|{org_id}", ident.encode())


def mask_label(identifier: str) -> str:
    ident = identifier.strip()
    if "@" in ident:
        ident = ident.lower()
        user, _, dom = ident.partition("@")
        return f"{user[:1]}***@{dom}"
    if sum(c.isdigit() for c in ident) >= 8:
        return "******" + ident[-4:]
    return " ".join(w[:1] + "*" * max(len(w) - 1, 2) for w in ident.split())


if __name__ == "__main__":
    print(base64.b64encode(AESGCM.generate_key(bit_length=256)).decode())
