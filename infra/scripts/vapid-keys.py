#!/usr/bin/env python3
"""Prints a fresh VAPID key pair for web push. Run once, put the two lines in /opt/kritvia/.env.

    python3 infra/scripts/vapid-keys.py
"""
import base64

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

key = ec.generate_private_key(ec.SECP256R1())
raw_priv = key.private_numbers().private_value.to_bytes(32, "big")
raw_pub = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()  # noqa: E731
print(f"VAPID_PUBLIC_KEY={b64(raw_pub)}")
print(f"VAPID_PRIVATE_KEY={b64(raw_priv)}")
print("VAPID_SUBJECT=mailto:support@sitelytc.com")
