from __future__ import annotations

from functools import lru_cache
from zoneinfo import ZoneInfo

from pydantic import Field, SecretStr, field_validator, model_validator

from tilhero_common.settings import ServiceSettings

MIN_SCHEDULER_TOKEN_LEN = 32


class Settings(ServiceSettings):
    service_name: str = "catalog"
    # пул Postgres по нагрузке сервиса (сумма максимумов — infra/railway/setup.py DB_POOLS)
    db_pool_size: int = 2
    db_max_overflow: int | None = 1
    db_schema: str | None = "catalog"
    port: int = 8110

    # Вход n8n в POST /internal/v1/catalog:tick: `Authorization: Bearer <SCHEDULER_TOKEN>`. Пусто — вход выключен.
    scheduler_token: SecretStr = SecretStr("")
    # Флаг media.external_sources: публикация origin licensed / platform_embed (до решения владельца и юриста — нет)
    media_external_sources: bool = False
    # Предупреждение на обзоре: лицензия медиа истекает в ≤ N дней
    rights_warning_days: int = Field(default=14, ge=1, le=90)
    # «Сегодня» для прав медиа и сводки — по Ташкенту (территория UZ)
    timezone: str = "Asia/Tashkent"
    # Заявки ученика на песни и фильмы: не больше N за скользящие сутки
    media_requests_per_day: int = Field(default=5, ge=1, le=100)
    # Каталог сида контента для миграции 0003 (по умолчанию — migrations/seed рядом с миграциями; тесты — свой набор)
    seed_dir: str | None = None
    # Пространство ключей Redis (идемпотентность команд сотрудников)
    cache_namespace: str = "catalog"

    @field_validator("scheduler_token", mode="before")
    @classmethod
    def _strip_token(cls, v: object) -> object:
        return v.strip() if isinstance(v, str) else v

    @field_validator("timezone")
    @classmethod
    def _tz(cls, v: str) -> str:
        ZoneInfo(v)  # неизвестная зона — ошибка конфигурации при старте
        return v

    @model_validator(mode="after")
    def _scheduler_token_guard(self) -> Settings:
        token = self.scheduler_token.get_secret_value()
        if self.is_secure_env and token and len(token) < MIN_SCHEDULER_TOKEN_LEN:
            raise ValueError(f"SCHEDULER_TOKEN must be empty or >= {MIN_SCHEDULER_TOKEN_LEN} chars in stage/prod")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
