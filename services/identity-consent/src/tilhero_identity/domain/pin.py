"""Код родителя (PIN, 4 или 6 цифр) и биометрический токен.

- хеш Argon2id с солью и параметрами в PHC-строке;
- тривиальные PIN (0000, 1234, 4321, 123456, 987654) отклоняются;
- только ASCII-цифры (str.isdigit() пропускает «١٢٣٤» и т.п.);
- биометрический токен — 32 байта из secrets, хранится только sha256, сравнение за постоянное время.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import re
import secrets
from dataclasses import dataclass
from itertools import pairwise

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

_PIN_RE = re.compile(r"[0-9]{4}|[0-9]{6}")


def pin_problem(pin: str) -> str | None:
    """None — PIN допустим; иначе причина: "format" (не 4/6 ASCII-цифр) или "trivial"."""
    if not _PIN_RE.fullmatch(pin):
        return "format"
    digits = [int(c) for c in pin]
    steps = {b - a for a, b in pairwise(digits)}
    if steps in ({0}, {1}, {-1}):
        return "trivial"
    return None


@dataclass(frozen=True)
class VerifyResult:
    ok: bool
    rehash: str | None = None  # новый хеш, если параметры Argon2 устарели


class PinHasher:
    """Argon2id (RFC 9106, low-memory профиль argon2-cffi: 64 MiB, t=3, p=4).

    CPU/память-тяжёлые операции — в пуле потоков, не больше `max_concurrency` одновременно на процесс:
    иначе всплеск запросов съедает память контейнера (64 MiB × размер пула потоков).
    """

    def __init__(self, hasher: PasswordHasher | None = None, max_concurrency: int = 4) -> None:
        self._ph = hasher or PasswordHasher()
        self._slots = asyncio.Semaphore(max_concurrency)

    async def hash(self, pin: str) -> str:
        async with self._slots:
            return await asyncio.to_thread(self._ph.hash, pin)

    async def verify(self, pin_hash: str, pin: str) -> VerifyResult:
        def _verify() -> VerifyResult:
            try:
                self._ph.verify(pin_hash, pin)
            except (VerifyMismatchError, VerificationError, InvalidHashError):
                return VerifyResult(False)
            return VerifyResult(True, self._ph.hash(pin) if self._ph.check_needs_rehash(pin_hash) else None)

        async with self._slots:
            return await asyncio.to_thread(_verify)


def new_biometric_token() -> str:
    """32 случайных байта в base64url (43 символа) — для Telegram BiometricManager.updateBiometricToken."""
    return secrets.token_urlsafe(32)


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def token_matches(token: str, stored_digest: str) -> bool:
    return hmac.compare_digest(token_digest(token), stored_digest)
