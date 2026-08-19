"""Developer-key verification.

A developer (or admin) proves their identity by sending the developer key as a
message to the AI. The plaintext key is never stored anywhere -- only its
Argon2id hash lives in this module. When a user sends a message whose Argon2id
hash matches, they are marked as a developer (persisted to the data volume).

Argon2id is a one-way password-hashing function (not reversible encryption),
which is the correct tool here: we only ever need to *verify* a candidate, not
recover the key from storage.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

# Argon2id hash of the developer key
# (time_cost=4, memory_cost=64 MiB, parallelism=4, hash_len=32, salt_len=16).
# The salt is embedded in this string, so no separate salt is needed.
# The plaintext key itself is safe to appear in this repo per the owner;
# only this hash is stored so the key never ships in code.
DEVELOPER_KEY_HASH = (
    "$argon2id$v=19$m=65536,t=4,p=4$U0nuuLHkRKEIy3LOeYDoYA"
    "$gc/znalKIwEmsUB4dHpZDE20HwbYT3KlBxhexGi1XhQ"
)

_hasher = PasswordHasher()
_dev_file = Path(os.environ.get("DATA_DIR", "/data")) / "ai_dev.json"
_lock = threading.Lock()


def is_developer_message(text: str) -> bool:
    """True if `text` matches the developer key (Argon2id verification)."""
    if not text:
        return False
    try:
        return _hasher.verify(DEVELOPER_KEY_HASH, text)
    except VerifyMismatchError:
        return False
    except Exception:
        return False


def _load() -> dict:
    try:
        data = json.loads(_dev_file.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save(data: dict) -> None:
    try:
        _dev_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = _dev_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(data), encoding="utf-8")
        os.replace(tmp, _dev_file)
    except Exception:
        pass


def is_developer(username: str) -> bool:
    """True if this username has already proven the developer key."""
    if not username:
        return False
    with _lock:
        return bool(_load().get(username))


def mark_developer(username: str) -> None:
    """Persist the fact that `username` has proven the developer key."""
    if not username:
        return
    with _lock:
        data = _load()
        if not data.get(username):
            data[username] = True
            _save(data)
