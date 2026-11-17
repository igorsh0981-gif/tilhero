"""Внутренняя аутентификация сервис → сервис (v2, ревью спринта 1).

Внутренний JWT подписывается EdDSA (Ed25519) ЛИЧНЫМ ключом вызывающего сервиса:
  header.kid = iss = вызывающий сервис, aud — целевой сервис, sub — user_id конечного пользователя,
  actor — сотрудник админки {id, role, name, permissions[]} — принимается ТОЛЬКО от admin-bff.
Получатель проверяет подпись открытым ключом конкретного издателя, поэтому сервис не может выпустить
токен от имени другого (раньше общий HS256-секрет позволял любому сервису подписаться как admin-bff).

Ключи:
- stage/prod: INTERNAL_JWT_PRIVATE_KEY (base64url seed 32 байта) + INTERNAL_JWT_PUBLIC_KEYS (JSON {issuer: pub}).
  Генерация: `uv run python infra/scripts/gen_internal_keys.py`.
- dev/test: ключи выводятся детерминированно из INTERNAL_JWT_SECRET и имени издателя (HMAC-SHA256), чтобы
  локальный стенд и тесты работали без раздачи ключей. В stage/prod вывод запрещён.

user_id берётся ТОЛЬКО из токена (защита от IDOR); права сотрудника проверяются в домене.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import math
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import jwt
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi import Request

from tilhero_common import context
from tilhero_common.errors import forbidden, unauthorized
from tilhero_common.settings import ServiceSettings

ALGORITHM = "EdDSA"
HEADER = "x-internal-token"
STAFF_ISSUERS = frozenset({"admin-bff"})


# ---------------------------------------------------------------- keys

def _b64d(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def derive_seed(secret: str, issuer: str) -> bytes:
    return hmac.new(secret.encode(), f"tilhero-internal-jwt:{issuer}".encode(), hashlib.sha256).digest()


def private_from_seed(seed: bytes) -> Ed25519PrivateKey:
    return Ed25519PrivateKey.from_private_bytes(seed)


def public_raw(key: Ed25519PrivateKey) -> bytes:
    return key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)


@dataclass(frozen=True)
class KeyRing:
    """Ключи сервиса: свой закрытый (для подписи) и открытые ключи издателей (для проверки)."""

    issuer: str
    private_key: Ed25519PrivateKey
    public_keys: dict[str, Ed25519PublicKey]
    derived_secret: str | None = None  # только dev/test

    def public_key_for(self, issuer: str) -> Ed25519PublicKey | None:
        key = self.public_keys.get(issuer)
        if key is None and self.derived_secret is not None:
            key = private_from_seed(derive_seed(self.derived_secret, issuer)).public_key()
        return key

    @classmethod
    def derived(cls, secret: str, issuer: str) -> KeyRing:
        return cls(issuer, private_from_seed(derive_seed(secret, issuer)), {}, derived_secret=secret)


_KEYRINGS: dict[int, tuple[ServiceSettings, KeyRing]] = {}


def keyring_for(settings: ServiceSettings) -> KeyRing:
    cached = _KEYRINGS.get(id(settings))
    if cached is not None and cached[0] is settings:
        return cached[1]
    publics = {
        name: Ed25519PublicKey.from_public_bytes(_b64d(value))
        for name, value in settings.internal_jwt_public_keys.items()
    }
    if settings.internal_jwt_private_key is not None:
        priv = private_from_seed(_b64d(settings.internal_jwt_private_key.get_secret_value()))
        ring = KeyRing(settings.service_name, priv, publics)
    elif settings.is_secure_env:
        raise RuntimeError("INTERNAL_JWT_PRIVATE_KEY is required in stage/prod")
    else:
        ring = KeyRing(
            settings.service_name,
            private_from_seed(derive_seed(settings.internal_jwt_secret.get_secret_value(), settings.service_name)),
            publics,
            derived_secret=settings.internal_jwt_secret.get_secret_value(),
        )
    _KEYRINGS[id(settings)] = (settings, ring)
    return ring


def _ring(key: KeyRing | str, issuer: str) -> KeyRing:
    return KeyRing.derived(key, issuer) if isinstance(key, str) else key


# ---------------------------------------------------------------- tokens

@dataclass(frozen=True)
class Actor:
    id: str
    role: str
    permissions: frozenset[str] = field(default_factory=frozenset)
    name: str | None = None


@dataclass(frozen=True)
class Principal:
    issuer: str
    subject: str | None
    actor: Actor | None
    claims: dict[str, Any]

    @property
    def user_id(self) -> str:
        if not self.subject:
            raise unauthorized("USER_CONTEXT_REQUIRED", "Нужен контекст пользователя")
        return self.subject

    def require_permission(self, permission: str) -> Actor:
        if self.actor is None:
            raise forbidden("STAFF_CONTEXT_REQUIRED", "Команда доступна только сотрудникам")
        if permission not in self.actor.permissions:
            raise forbidden("PERMISSION_DENIED", "Недостаточно прав", {"permission": permission})
        return self.actor


def issue_token(
    key: KeyRing | str,
    *,
    issuer: str,
    audience: str,
    subject: str | None = None,
    actor: Actor | None = None,
    ttl_seconds: int = 60,
    extra: dict[str, Any] | None = None,
) -> str:
    """key — KeyRing сервиса (prod) или секрет dev/test (ключ издателя выводится из него)."""
    ring = _ring(key, issuer)
    if ring.issuer != issuer:
        raise ValueError(f"key ring of {ring.issuer!r} cannot sign as {issuer!r}")
    now = int(time.time())
    claims: dict[str, Any] = {"iss": issuer, "aud": audience, "iat": now, "exp": now + ttl_seconds,
                              "jti": uuid.uuid4().hex}
    if subject:
        claims["sub"] = subject
    if actor:
        claims["actor"] = {"id": actor.id, "role": actor.role, "permissions": sorted(actor.permissions)}
        if actor.name:
            claims["actor"]["name"] = actor.name
    if extra:
        claims.update(extra)
    return jwt.encode(claims, ring.private_key, algorithm=ALGORITHM, headers={"kid": issuer})


MAX_TTL_SECONDS = 120  # INTERNAL_JWT_MAX_TTL_SECONDS по умолчанию; выпуск — 60 с
CLOCK_SKEW_SECONDS = 30  # INTERNAL_JWT_CLOCK_SKEW_SECONDS: iat из будущего не дальше этого


def verify_token(
    token: str, key: KeyRing | str, *, audience: str, allowed_issuers: set[str] | None = None,
    max_ttl_seconds: int = MAX_TTL_SECONDS, clock_skew_seconds: int = CLOCK_SKEW_SECONDS,
) -> Principal:
    """Подпись EdDSA ключом издателя, `aud`, обязательные `iss/aud/iat/exp`; срок жизни `exp − iat` не больше
    `max_ttl_seconds` (SEC9-01: долгоживущий токен — даже подписанный допустимым вызывающим — отклоняется), `iat`
    из будущего не дальше `clock_skew_seconds`; истёкший — `INTERNAL_TOKEN_EXPIRED`, иначе —
    `INTERNAL_TOKEN_INVALID`."""
    try:
        header = jwt.get_unverified_header(token)
        unverified = jwt.decode(token, options={"verify_signature": False})
    except jwt.PyJWTError as exc:
        raise unauthorized("INTERNAL_TOKEN_INVALID", "Неверный внутренний токен") from exc
    issuer = str(unverified.get("iss", ""))
    if header.get("alg") != ALGORITHM or header.get("kid") != issuer or not issuer:
        raise unauthorized("INTERNAL_TOKEN_INVALID", "Неверный внутренний токен")
    ring = KeyRing.derived(key, issuer) if isinstance(key, str) else key
    public = ring.public_key_for(issuer)
    if public is None:
        raise unauthorized("INTERNAL_TOKEN_UNKNOWN_ISSUER", "Издатель внутреннего токена неизвестен")
    try:
        claims = jwt.decode(token, public, algorithms=[ALGORITHM], audience=audience,
                            options={"require": ["exp", "iat", "iss", "aud"], "verify_iat": False})
    except jwt.ExpiredSignatureError as exc:
        raise unauthorized("INTERNAL_TOKEN_EXPIRED", "Внутренний токен истёк") from exc
    except jwt.PyJWTError as exc:
        raise unauthorized("INTERNAL_TOKEN_INVALID", "Неверный внутренний токен") from exc
    iat, exp = claims.get("iat"), claims.get("exp")
    if not (isinstance(iat, int | float) and isinstance(exp, int | float)) or isinstance(iat, bool) \
            or isinstance(exp, bool) or not (math.isfinite(iat) and math.isfinite(exp)):
        raise unauthorized("INTERNAL_TOKEN_INVALID", "Неверный внутренний токен")
    if iat > time.time() + clock_skew_seconds or exp - iat > max_ttl_seconds or exp <= iat:
        raise unauthorized("INTERNAL_TOKEN_INVALID", "Неверный внутренний токен")
    if allowed_issuers is not None and issuer not in allowed_issuers:
        raise forbidden("CALLER_NOT_ALLOWED", "Сервис не имеет доступа к этому API", {"caller": issuer})
    actor = None
    if isinstance(claims.get("actor"), dict):
        if issuer not in STAFF_ISSUERS:
            raise forbidden("ACTOR_NOT_ALLOWED", "Контекст сотрудника принимается только от admin-bff")
        a = claims["actor"]
        actor = Actor(id=str(a["id"]), role=str(a["role"]), permissions=frozenset(a.get("permissions", [])),
                      name=a.get("name"))
    return Principal(issuer=issuer, subject=claims.get("sub"), actor=actor, claims=claims)


class InternalAuth:
    """FastAPI-зависимость: `principal: Principal = Depends(InternalAuth({"telegram-bff"}))`."""

    def __init__(self, allowed_issuers: set[str] | None = None) -> None:
        self.allowed_issuers = allowed_issuers

    async def __call__(self, request: Request) -> Principal:
        settings: ServiceSettings = request.app.state.runtime.settings
        token = request.headers.get(HEADER)
        if not token:
            raise unauthorized("INTERNAL_TOKEN_MISSING", "Нет внутреннего токена")
        principal = verify_token(token, keyring_for(settings), audience=settings.service_name,
                                 allowed_issuers=self.allowed_issuers,
                                 max_ttl_seconds=settings.internal_jwt_max_ttl_seconds,
                                 clock_skew_seconds=settings.internal_jwt_clock_skew_seconds)
        if principal.subject:
            context.user_pid_var.set(context.pseudonymize(principal.subject))
        # спринт 9 (INTERNAL_API §2.3): int.caller — на пару (вызывающий, сервис), один раз на запрос
        limiter = getattr(request.app.state.runtime, "ratelimiter", None)
        if limiter is not None and not getattr(request.state, "rl_caller_checked", False):
            request.state.rl_caller_checked = True
            await limiter.enforce("int.caller", f"{principal.issuer}@{settings.service_name}")
        return principal
