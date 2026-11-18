"""Криптопримитивы admin-identity: argon2id, TOTP (RFC 6238), AES-256-GCM для MFA-секретов, генераторы.

TOTP реализован по RFC 4226/6238 на стандартной библиотеке (hmac + base64.b32encode): SHA-1, 6 цифр, шаг 30 с.
Секрет MFA хранится только зашифрованным: version(1) || nonce(12) || AES-GCM(secret, AAD=staff_id).
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import secrets
import string
import struct
import time
import uuid
from urllib.parse import quote, urlencode

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

TOTP_DIGITS = 6
TOTP_PERIOD = 30
TOTP_WINDOW = 1
_ENC_VERSION = b"\x01"


# ---------------------------------------------------------------- пароли

class Passwords:
    """argon2id. Для неизвестного email проверяется фиктивный хеш — время ответа не выдаёт существование учётки."""

    def __init__(self, time_cost: int, memory_cost: int, parallelism: int) -> None:
        self.hasher = PasswordHasher(time_cost=time_cost, memory_cost=memory_cost, parallelism=parallelism)
        self._dummy = self.hasher.hash(secrets.token_urlsafe(24))

    def hash_sync(self, password: str) -> str:
        return self.hasher.hash(password)

    def verify_sync(self, password_hash: str | None, password: str) -> bool:
        target = password_hash or self._dummy
        ok: bool
        try:
            ok = self.hasher.verify(target, password)
        except (VerifyMismatchError, VerificationError, InvalidHashError):
            ok = False
        return ok and password_hash is not None

    def needs_rehash(self, password_hash: str) -> bool:
        try:
            return self.hasher.check_needs_rehash(password_hash)
        except InvalidHashError:
            return False

    async def hash(self, password: str) -> str:
        return await asyncio.to_thread(self.hash_sync, password)

    async def verify(self, password_hash: str | None, password: str) -> bool:
        return await asyncio.to_thread(self.verify_sync, password_hash, password)


_TEMP_ALPHABET = string.ascii_letters + string.digits


def temporary_password(length: int = 20) -> str:
    """20 символов (secrets); гарантированно есть буквы и цифры — проходит правила пароля."""
    while True:
        value = "".join(secrets.choice(_TEMP_ALPHABET) for _ in range(length))
        if any(c.isalpha() for c in value) and any(c.isdigit() for c in value):
            return value


def new_challenge() -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- TOTP

def new_totp_secret() -> bytes:
    return secrets.token_bytes(20)  # 160 бит — рекомендация RFC 4226 для SHA-1


def b32(secret: bytes) -> str:
    return base64.b32encode(secret).decode().rstrip("=")


def hotp(secret: bytes, counter: int, digits: int = TOTP_DIGITS) -> str:
    mac = hmac.new(secret, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = mac[-1] & 0x0F
    code = (struct.unpack(">I", mac[offset:offset + 4])[0] & 0x7FFFFFFF) % (10 ** digits)
    return str(code).zfill(digits)


def current_step(now: float | None = None) -> int:
    return int((time.time() if now is None else now) // TOTP_PERIOD)


def totp(secret: bytes, now: float | None = None) -> str:
    return hotp(secret, current_step(now))


def match_totp(secret: bytes, code: str, last_step: int | None, now: float | None = None) -> int | None:
    """Шаг, которому соответствует код (окно ±1), или None. Шаги ≤ last_step отвергаются (повтор кода).
    Проверяются все шаги окна без раннего выхода; сравнение — за постоянное время."""
    base = current_step(now)
    found: int | None = None
    for delta in range(-TOTP_WINDOW, TOTP_WINDOW + 1):
        step = base + delta
        if hmac.compare_digest(hotp(secret, step), code) and (last_step is None or step > last_step):
            found = step if found is None else max(found, step)
    return found


def otpauth_uri(secret: bytes, issuer: str, account: str) -> str:
    label = quote(f"{issuer}:{account}", safe=":@")
    query = urlencode({"secret": b32(secret), "issuer": issuer, "algorithm": "SHA1",
                       "digits": TOTP_DIGITS, "period": TOTP_PERIOD}, quote_via=quote)
    return f"otpauth://totp/{label}?{query}"


# ---------------------------------------------------------------- AES-256-GCM

class SecretBox:
    def __init__(self, key: bytes) -> None:
        if len(key) != 32:
            raise ValueError("AES-256-GCM key must be 32 bytes")
        self._aead = AESGCM(key)

    def encrypt(self, plaintext: bytes, staff_id: uuid.UUID) -> bytes:
        nonce = secrets.token_bytes(12)
        return _ENC_VERSION + nonce + self._aead.encrypt(nonce, plaintext, staff_id.bytes)

    def decrypt(self, blob: bytes, staff_id: uuid.UUID) -> bytes | None:
        """None — повреждено, чужой staff_id (AAD) или ключ сменён (нужно переподключение MFA)."""
        if len(blob) < 1 + 12 + 16 or blob[:1] != _ENC_VERSION:
            return None
        try:
            return self._aead.decrypt(blob[1:13], blob[13:], staff_id.bytes)
        except InvalidTag:
            return None
