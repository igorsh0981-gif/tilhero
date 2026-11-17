"""Токен ссылки согласия родителя для подростка 14–17 (`https://t.me/<bot>/<app>?startapp=gc_<token>`).

Токен — 32 байта в base64url (43 символа). В БД хранится только sha256(token) (`guardian_consent_requests.token_hash`):
утечка дампа не даёт рабочих ссылок. Сам токен выводится HMAC-SHA256 из ключа сервиса (INTERNAL_JWT_SECRET с
разделением доменов) и id запроса — поэтому повтор команды с тем же Idempotency-Key возвращает ту же ссылку, хотя
токен нигде не хранится (как ссылки приглашений social). Без ключа сервиса токен не вычислить.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import uuid

TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")
_KEY_LABEL = b"tilhero:identity:guardian-consent-token:v1"


def token_key(secret: str) -> bytes:
    return hmac.new(secret.encode("utf-8"), _KEY_LABEL, hashlib.sha256).digest()


def derive_token(key: bytes, request_id: uuid.UUID) -> str:
    raw = hmac.new(key, request_id.bytes, hashlib.sha256).digest()  # 32 байта
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def well_formed(token: str) -> bool:
    return bool(TOKEN_RE.match(token))
