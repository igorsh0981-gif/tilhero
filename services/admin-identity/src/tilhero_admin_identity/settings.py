from __future__ import annotations

import base64
import hashlib
from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, model_validator

from tilhero_common.settings import ServiceSettings

# Детерминированный ключ шифрования MFA-секретов — только dev/test (в stage/prod запрещён валидатором).
_DEV_MFA_KEY = hashlib.sha256(b"tilhero-dev-admin-mfa-enc-key").digest()


def decode_key(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


class Settings(ServiceSettings):
    service_name: str = "admin-identity"
    # спринт 9 (Q10): пул Postgres по нагрузке сервиса; сумма максимумов всех сервисов — infra/railway/setup.py
    # DB_POOLS (≤ 80 при max_connections 100 вместе с миграциями)
    db_pool_size: int = 1
    db_max_overflow: int | None = 1
    db_schema: str | None = "admin_identity"
    port: int = 8120

    # local — пароли в admin-identity (argon2id); ad — вход через LDAP/AD (банковский этап, сейчас 501).
    auth_mode: Literal["local", "ad"] = "local"
    # AES-256-GCM ключ шифрования TOTP-секретов: base64url 32 байта. Обязателен в stage/prod.
    admin_mfa_enc_key: SecretStr | None = None

    # Первый super_admin (только если в staff нет ни одного super_admin). Удалить после первого входа.
    admin_bootstrap_email: str | None = None
    admin_bootstrap_password: SecretStr | None = None
    admin_bootstrap_display_name: str = "Администратор"
    # Срок пароля из ADMIN_BOOTSTRAP_PASSWORD до первого входа (затем — смена пароля)
    bootstrap_password_ttl_hours: int = Field(default=72, ge=1)

    # Попытки входа: по нормализованному email (одинаково для существующих и несуществующих)
    login_max_attempts: int = Field(default=5, ge=1)
    login_lock_seconds: int = Field(default=900, ge=1)
    # Попытки TOTP: на challenge и на сотрудника (общий счётчик вход/подключение/step-up)
    mfa_max_attempts: int = Field(default=5, ge=1)
    mfa_lock_seconds: int = Field(default=900, ge=1)
    challenge_ttl_seconds: int = Field(default=300, ge=10)
    temp_password_ttl_hours: int = Field(default=24, ge=1)
    approval_ttl_hours: int = Field(default=72, ge=1)
    totp_issuer: str = "TilHero Admin"
    # Префикс ключей Redis (тесты задают уникальный)
    redis_namespace: str = "adminid"

    # Параметры argon2id (по умолчанию — рекомендации argon2-cffi; тесты могут снижать память)
    argon2_time_cost: int = Field(default=3, ge=1)
    argon2_memory_cost: int = Field(default=65536, ge=1024)
    argon2_parallelism: int = Field(default=4, ge=1)

    @model_validator(mode="after")
    def _identity_guard(self) -> Settings:
        if self.admin_mfa_enc_key is not None:
            try:
                raw = decode_key(self.admin_mfa_enc_key.get_secret_value())
            except Exception as exc:
                raise ValueError("ADMIN_MFA_ENC_KEY must be base64url of 32 bytes") from exc
            if len(raw) != 32:
                raise ValueError("ADMIN_MFA_ENC_KEY must be base64url of 32 bytes")
        elif self.is_secure_env:
            raise ValueError("ADMIN_MFA_ENC_KEY is required in stage/prod")
        # Без Redis нет блокировки перебора, challenge и idempotency — в stage/prod не стартуем вовсе
        if self.is_secure_env and not self.redis_url:
            raise ValueError("REDIS_URL is required in stage/prod")
        if self.is_secure_env and not self.database_url:
            raise ValueError("DATABASE_URL is required in stage/prod")
        if self.admin_bootstrap_password is not None and len(self.admin_bootstrap_password.get_secret_value()) < 12:
            raise ValueError("ADMIN_BOOTSTRAP_PASSWORD must be at least 12 characters")
        return self

    @property
    def mfa_key(self) -> bytes:
        if self.admin_mfa_enc_key is None:
            return _DEV_MFA_KEY
        return decode_key(self.admin_mfa_enc_key.get_secret_value())


@lru_cache
def get_settings() -> Settings:
    return Settings()
