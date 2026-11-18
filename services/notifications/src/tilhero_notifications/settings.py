from __future__ import annotations

from functools import lru_cache

from pydantic import AliasChoices, Field, SecretStr, field_validator, model_validator

from tilhero_common.settings import ServiceSettings

MIN_SCHEDULER_TOKEN_LEN = 32


class Settings(ServiceSettings):
    service_name: str = "notifications"
    # пул Postgres по нагрузке сервиса; сумма максимумов всех сервисов — infra/railway/setup.py
    db_pool_size: int = 2
    db_max_overflow: int | None = 1
    db_schema: str | None = "notifications"
    port: int = 8104

    identity_consent_url: str = "http://127.0.0.1:8101"
    # ВНУТРЕННИЙ порт telegram-bot-gateway (INTERNAL_PORT 8108, только приватная сеть); публичный 8107 — только
    # webhook Telegram. Переменная BOTGW_URL (BOT_GATEWAY_URL — прежнее имя).
    bot_gateway_url: str = Field(
        default="http://127.0.0.1:8108",
        validation_alias=AliasChoices("bot_gateway_url", "botgw_url", "BOTGW_URL", "BOT_GATEWAY_URL"),
    )
    # Синхронная отправка транзакционного (код сброса PIN): ответ identity-consent в пределах его таймаута
    transactional_send_timeout_seconds: float = 6.0

    redis_key_prefix: str = "notif"
    delivery_cache_ttl_seconds: int = 300  # DeliveryInfo и публичное имя (identity-consent), 5 мин
    default_timezone: str = "Asia/Tashkent"  # bff.ts NotificationSettings.timezone по умолчанию

    # Планировщик внутри сервиса (немедленные, отложенные, повторы); n8n дополнительно дёргает
    # POST /internal/v1/notifications:dispatch каждые 5 мин (Bearer SCHEDULER_TOKEN, пустой — вход выключен).
    scheduler_token: SecretStr = SecretStr("")
    dispatcher_enabled: bool = True
    dispatch_interval_seconds: float = 1.0
    dispatch_batch_size: int = Field(default=50, ge=1, le=500)
    dispatch_concurrency: int = Field(default=5, ge=1, le=50)
    dispatch_max_batches_per_call: int = Field(default=20, ge=1, le=200)  # один вызов n8n — не дольше
    lease_seconds: int = 60  # «аренда» строки на время отправки; после сбоя процесса строку подберут снова
    max_attempts: int = 8
    retry_delays_seconds: tuple[int, ...] = (30, 120, 600, 1800, 3600)

    # Политика (INTERNAL_API §4, PLAN «Правила напоминаний»)
    daily_limit: int = Field(default=3, ge=1, le=20)  # reminders + missed + social в местные сутки на ученика
    reminder_stale_hours: int = Field(default=3, ge=1, le=24)  # напоминание позже слота + 3 ч → только центр
    missed_stale_time: str = "22:00"  # пропуск: на следующий день после этого времени — только центр
    comeback_min_days: int = Field(default=7, ge=1, le=60)  # consecutive_missed ≥ 4 — не чаще раза в 7 дней
    kid_window_start: str = "08:00"  # дети 6–13: сообщения родителю только в окне 08:00–20:00 местного
    kid_window_end: str = "20:00"
    retention_days: int = Field(default=90, ge=1, le=365)  # журнал = центр уведомлений

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
