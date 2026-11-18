from __future__ import annotations

from functools import lru_cache

from pydantic import Field, SecretStr, field_validator, model_validator

from tilhero_common.settings import ServiceSettings

MIN_SCHEDULER_TOKEN_LEN = 32


class Settings(ServiceSettings):
    service_name: str = "learning-plan"
    # пул Postgres по нагрузке сервиса (сумма максимумов всех сервисов — бюджет max_connections, см. aievent Q10)
    db_pool_size: int = 2
    db_max_overflow: int | None = 1
    db_schema: str | None = "learning_plan"
    port: int = 8102

    # Вход n8n в POST /internal/v1/plan:tick: `Authorization: Bearer <SCHEDULER_TOKEN>`. Пусто — вход выключен (401).
    scheduler_token: SecretStr = SecretStr("")
    # Часовой пояс плана по умолчанию (если клиент не передал ?tz= или передал неизвестную зону)
    default_timezone: str = "Asia/Tashkent"
    # Окно tick (last_tick_at, now] не длиннее этого: после простоя старые слоты не «догоняются»
    tick_max_lookback_hours: int = Field(default=24, ge=1, le=24)
    tick_batch_size: int = Field(default=500, ge=10, le=5000)
    # occurred_at занятия: не раньше N дней назад и не позже допуска часов клиента
    activity_max_age_days: int = Field(default=7, ge=1, le=30)
    activity_future_skew_seconds: int = Field(default=300, ge=0, le=3600)

    @field_validator("scheduler_token", mode="before")
    @classmethod
    def _strip_token(cls, v: object) -> object:
        return v.strip() if isinstance(v, str) else v

    @model_validator(mode="after")
    def _scheduler_token_guard(self) -> Settings:
        # stage/prod: пусто (вход выключен) или не короче 32 символов (ревью P-8)
        token = self.scheduler_token.get_secret_value()
        if self.is_secure_env and token and len(token) < MIN_SCHEDULER_TOKEN_LEN:
            raise ValueError(f"SCHEDULER_TOKEN must be empty or >= {MIN_SCHEDULER_TOKEN_LEN} chars in stage/prod")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
