from __future__ import annotations

import hashlib
import hmac
from functools import lru_cache

from pydantic import Field, SecretStr, field_validator, model_validator

from tilhero_common.settings import ServiceSettings


class Settings(ServiceSettings):
    service_name: str = "social"
    db_pool_size: int = 2
    db_max_overflow: int | None = 1
    db_schema: str | None = "social"
    port: int = 8109

    # Вход n8n в POST /internal/v1/invites:tick: `Authorization: Bearer <SCHEDULER_TOKEN>`. Пусто — вход выключен (401).
    scheduler_token: SecretStr = SecretStr("")
    # Ключ HMAC токенов приглашений: token = base64url(HMAC-SHA256(key, invite_id))[:32]. Обязателен в stage/prod
    # (≥ 32 символов); смена ключа делает недействительными все выданные ссылки. dev/test — выводится из
    # INTERNAL_JWT_SECRET.
    invite_token_key: SecretStr | None = None
    # Прямая ссылка Mini App: https://t.me/<bot>/<app>; ссылка приглашения = <link>?startapp=inv_<token>
    telegram_app_link: str = "https://t.me/tilhero_bot/app"
    identity_consent_url: str = "http://127.0.0.1:8101"

    invite_family_ttl_days: int = Field(default=7, ge=1, le=90)
    invite_friend_ttl_days: int = Field(default=30, ge=1, le=365)
    max_active_invites: int = Field(default=10, ge=1, le=100)
    # частота создания: не больше N приглашений за скользящие 24 ч (отзыв не возвращает лимит)
    max_invites_per_day: int = Field(default=20, ge=1, le=500)
    family_max_members: int = Field(default=10, ge=2, le=50)
    # напоминание о неотвеченном приглашении — через N часов после открытия, если открыто не раньше M дней назад
    invite_reminder_after_hours: int = Field(default=24, ge=1, le=168)
    invite_reminder_max_age_days: int = Field(default=7, ge=1, le=60)
    tick_batch_size: int = Field(default=1000, ge=10, le=10000)

    @field_validator("scheduler_token", mode="before")
    @classmethod
    def _strip_token(cls, v: object) -> object:
        return v.strip() if isinstance(v, str) else v

    @field_validator("invite_token_key", mode="before")
    @classmethod
    def _empty_key(cls, v: object) -> object:
        if isinstance(v, str):
            v = v.strip()
            return v or None
        return v

    @field_validator("telegram_app_link")
    @classmethod
    def _https_link(cls, v: str) -> str:
        v = v.strip().rstrip("/")
        if not v.startswith("https://") or "?" in v or "#" in v or " " in v:
            raise ValueError("TELEGRAM_APP_LINK must be https://t.me/<bot>/<app> without query")
        return v

    @model_validator(mode="after")
    def _invite_key_guard(self) -> Settings:
        if self.is_secure_env:
            key = self.invite_token_key.get_secret_value() if self.invite_token_key else ""
            if len(key) < 32:
                raise ValueError("INVITE_TOKEN_KEY must be set (>=32 chars) in stage/prod")
        return self

    def invite_key_bytes(self) -> bytes:
        if self.invite_token_key is not None:
            return self.invite_token_key.get_secret_value().encode("utf-8")
        # dev/test: детерминированно из секрета сервиса (в stage/prod запрещено валидатором выше)
        return hmac.new(self.internal_jwt_secret.get_secret_value().encode("utf-8"), b"tilhero-invite-token-key",
                        hashlib.sha256).digest()


@lru_cache
def get_settings() -> Settings:
    return Settings()
