from __future__ import annotations

from functools import lru_cache

from pydantic import AliasChoices, Field, SecretStr, field_validator

from tilhero_common.settings import ServiceSettings


class Settings(ServiceSettings):
    service_name: str = "notifications"
    # спринт 9 (Q10): пул Postgres по нагрузке сервиса; сумма максимумов всех сервисов — infra/railway/setup.py
    # DB_POOLS (≤ 80 при max_connections 100 вместе с миграциями)
    db_pool_size: int = 2
    db_max_overflow: int | None = 1
    db_schema: str | None = "notifications"
    port: int = 8104

    identity_consent_url: str = "http://127.0.0.1:8101"
    # ВНУТРЕННИЙ порт telegram-bot-gateway (INTERNAL_PORT 8108, только приватная сеть); публичный 8107 —
    # только webhook Telegram (ревью P1). Переменная BOTGW_URL (BOT_GATEWAY_URL — прежнее имя).
    bot_gateway_url: str = Field(
        default="http://127.0.0.1:8108",
        validation_alias=AliasChoices("bot_gateway_url", "botgw_url", "BOTGW_URL", "BOT_GATEWAY_URL"),
    )
    # Синхронная отправка транзакционного (код сброса PIN): ответ identity-consent в пределах его таймаута
    transactional_send_timeout_seconds: float = 6.0

    redis_key_prefix: str = "notif"
    delivery_cache_ttl_seconds: int = 300  # адрес/язык/настройки пользователя (identity-consent), 5 мин
    default_timezone: str = "Asia/Tashkent"  # bff.ts NotificationSettings.timezone по умолчанию

    # Планировщик внутри сервиса: отложенные (тихие часы) и повторы доставки
    dispatcher_enabled: bool = True
    dispatch_interval_seconds: float = 1.0
    dispatch_batch_size: int = 50
    dispatch_concurrency: int = 5
    lease_seconds: int = 60  # «аренда» строки на время отправки; после сбоя процесса строку подберут снова
    max_attempts: int = 8
    retry_delays_seconds: tuple[int, ...] = (30, 120, 600, 1800, 3600)

    # Дайджест (спринт 6, §5): POST /internal/v1/notifications:digest — n8n каждые 15 мин, Bearer SCHEDULER_TOKEN.
    # Пустой токен выключает вход планировщика (401).
    scheduler_token: SecretStr = SecretStr("")
    digest_default_time: str = "09:00"  # если identity-consent не вернул digest_time
    # Окно отправки после digest_time: прогон n8n в окне собирает дайджест; пункты, пришедшие позже, ждут завтра
    digest_window_minutes: int = Field(default=120, ge=15, le=720)
    digest_recheck_minutes: int = Field(default=60, ge=5, le=1440)  # не реже — перечитать digest_time/timezone
    digest_batch_users: int = Field(default=500, ge=1, le=5000)
    digest_concurrency: int = Field(default=5, ge=1, le=50)
    digest_max_items: int = Field(default=10, ge=1, le=10)
    digest_retention_days: int = Field(default=7, ge=1, le=90)  # отметки дедупликации собранных пунктов

    # Спринт 8 (§6): оповещения операторам (notifications.ops_alerts → bot-gateway /internal/v1/ops-messages).
    # ADMIN_WEB_URL — база кнопки «Открыть мониторинг»; пусто или не https — сообщение без кнопки.
    admin_web_url: str | None = None
    # Повторов доставки оповещения (429, bot-gateway/Telegram недоступен) до статуса failed; задержку даёт шина
    # (backoff до 5 мин, но не раньше retry_after) — 20 попыток ≈ час
    ops_max_attempts: int = Field(default=20, ge=1, le=200)
    # спринт 9 (INTERNAL_API §6.2): кнопка «Runbook» — только ссылки с этим префиксом (раздел docs/runbooks репозитория)
    runbook_base_url: str = "https://github.com/igorsh0981-gif/tilhero/blob/main/docs/runbooks/"

    @field_validator("admin_web_url", mode="before")
    @classmethod
    def _empty_url(cls, v: object) -> object:
        if isinstance(v, str):
            v = v.strip().rstrip("/")
            return v or None
        return v

    @field_validator("scheduler_token", mode="before")
    @classmethod
    def _strip_token(cls, v: object) -> object:
        return v.strip() if isinstance(v, str) else v


@lru_cache
def get_settings() -> Settings:
    return Settings()
