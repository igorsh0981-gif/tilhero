"""Базовые настройки сервиса. Каждый сервис наследует ServiceSettings и задаёт свои поля."""

from __future__ import annotations

import json
from typing import Literal

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_DEV_SECRET = "dev-internal-secret-change-me"  # noqa: S105 - только для dev/test, в prod запрещён валидатором


class ServiceSettings(BaseSettings):
    # hide_input_in_errors: ошибка конфигурации при старте не печатает значения переменных (секреты) — ревью спринта 2
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", hide_input_in_errors=True
    )

    service_name: str
    # ENV обязателен в окружении сервиса: Runtime.start() откажется стартовать без явного значения.
    # stage и prod — «защищённые» окружения: ключи dev-деривации и dev-секреты там запрещены.
    env: Literal["dev", "test", "stage", "prod"] = "dev"
    log_level: str = "INFO"
    port: int = 8000
    service_version: str = "0.1.0"

    database_url: str | None = None
    # Роль-владелец схемы для Alembic (preDeploy). Рантайм работает под ролью сервиса без прав DDL:
    # он не может снять триггеры неизменяемости, сменить владельца или удалить таблицы (ревью спринта 1, P4).
    migration_database_url: str | None = None
    db_schema: str | None = None
    # пул соединений Postgres (SQLAlchemy): постоянных DB_POOL_SIZE + временных DB_MAX_OVERFLOW (None — столько же,
    # сколько постоянных, как до спринта 9). Сервисы задают свои умолчания (infra/railway/setup.py DB_POOLS)
    db_pool_size: int = Field(default=10, ge=1, le=100)
    db_max_overflow: int | None = Field(default=None, ge=0, le=100)

    redis_url: str | None = None

    nats_url: str | None = None
    nats_stream: str = "TILHERO"
    nats_max_deliver: int = 10
    # спринт 8: стрим TILHERO_DLQ хранит сообщения дольше основного (7 дней) — оператор успевает разобрать DLQ
    nats_dlq_max_age_days: int = Field(default=30, ge=1, le=365)

    # Секрет сервиса для HMAC (коды и т.п.). В dev/test из него же выводятся Ed25519-ключи внутреннего JWT.
    internal_jwt_secret: SecretStr = SecretStr(_DEV_SECRET)
    # срок жизни выпускаемого внутреннего JWT (≤ 60 с) и проверка входящих (SEC9-01): exp − iat ≤ MAX_TTL,
    # iat не из будущего больше чем на допуск часов
    internal_jwt_ttl_seconds: int = Field(default=60, ge=1, le=60)
    internal_jwt_max_ttl_seconds: int = Field(default=120, ge=1, le=3600)
    internal_jwt_clock_skew_seconds: int = Field(default=30, ge=0, le=300)
    # Внутренний JWT (EdDSA/Ed25519): свой закрытый ключ (base64url 32-байтного seed) и открытые ключи
    # вызывающих сервисов {"telegram-bff": "<base64url 32 байта>", ...}. Обязательны в stage/prod.
    internal_jwt_private_key: SecretStr | None = None
    internal_jwt_public_keys: dict[str, str] = Field(default_factory=dict)

    outbox_poll_interval_ms: int = 200
    outbox_batch_size: int = 100
    outbox_publish_timeout_seconds: float = 3.0
    # Опубликованные записи outbox удаляются через N часов (в них могут быть данные событий — минимизация)
    outbox_retention_hours: int = Field(default=72, ge=1)
    outbox_cleanup_interval_seconds: float = 3600.0

    # спринт 9 (INTERNAL_API §2.1): единый лимитер — false пропускает всё (авария), счёт только allowed
    rate_limits_enabled: bool = True
    rate_limit_override_refresh_seconds: float = Field(default=30.0, ge=1, le=600)

    @field_validator("internal_jwt_public_keys", mode="before")
    @classmethod
    def _parse_keys(cls, v: object) -> object:
        if isinstance(v, str):
            return json.loads(v) if v.strip() else {}
        return v

    @property
    def is_secure_env(self) -> bool:
        return self.env in ("stage", "prod")

    @model_validator(mode="after")
    def _prod_guard(self) -> ServiceSettings:
        if self.is_secure_env:
            secret = self.internal_jwt_secret.get_secret_value()
            if secret == _DEV_SECRET or len(secret) < 32:
                raise ValueError("INTERNAL_JWT_SECRET must be set (>=32 chars) in stage/prod")
            if self.internal_jwt_private_key is None:
                raise ValueError("INTERNAL_JWT_PRIVATE_KEY is required in stage/prod (gen_internal_keys.py)")
        return self

    @property
    def async_database_url(self) -> str | None:
        return to_async_url(self.database_url) if self.database_url else None


def to_async_url(url: str) -> str:
    """Railway отдаёт postgresql://… — SQLAlchemy async нужен postgresql+asyncpg://…"""
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url
