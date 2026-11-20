from __future__ import annotations

from functools import lru_cache
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import Field, SecretStr, field_validator, model_validator

from tilhero_common.settings import ServiceSettings

MIN_SCHEDULER_TOKEN_LEN = 32
# адреса доменов, которые вызывает memory (INTERNAL_API §0): в stage/prod задаются явно
REQUIRED_URLS = ("catalog_url", "assessment_url", "ai_gateway_url", "identity_consent_url")


class Settings(ServiceSettings):
    service_name: str = "memory"
    db_pool_size: int = 3
    db_max_overflow: int | None = 2
    db_schema: str | None = "memory"
    port: int = 8116

    # catalog (8110): версии контента с ключами, словарь курса (lookup, ai-entries, forms), задания проверок
    catalog_url: str = "http://127.0.0.1:8110"
    catalog_timeout_seconds: float = Field(default=3.0, gt=0, le=30)
    versions_cache_size: int = Field(default=1024, ge=16, le=100_000)
    titles_cache_seconds: int = Field(default=300, ge=0, le=86_400)
    # assessment (8113): GET /internal/v1/evaluations/{id}/memory-feed
    assessment_url: str = "http://127.0.0.1:8113"
    assessment_timeout_seconds: float = Field(default=5.0, gt=0, le=30)
    # ai-gateway (8114): teaching_coach gloss_word (deadline 8 с), статус (2 с), оценка произношения (15 с)
    ai_gateway_url: str = "http://127.0.0.1:8114"
    gloss_deadline_ms: int = Field(default=8000, ge=1000, le=60_000)
    gloss_timeout_seconds: float = Field(default=9.0, gt=0, le=60)
    ai_status_timeout_seconds: float = Field(default=2.0, gt=0, le=10)
    speech_timeout_seconds: float = Field(default=15.0, gt=0, le=60)
    # identity-consent (8101): GET /internal/v1/users/{lrn}/public — согласие на запись голоса
    identity_consent_url: str = "http://127.0.0.1:8101"
    identity_timeout_seconds: float = Field(default=3.0, gt=0, le=30)

    default_pair_id: str = "ru-en"
    default_timezone: str = "Asia/Tashkent"
    review_voice: str = Field(default="en-US", pattern="^(en-GB|en-US)$")

    # Вход n8n `memory-tick`: `Authorization: Bearer <SCHEDULER_TOKEN>`. Пусто — вход выключен.
    scheduler_token: SecretStr = SecretStr("")

    # «Повторение дня» (INTERNAL_API §1.3)
    due_limit_adults: int = Field(default=20, ge=1, le=200)
    due_limit_kids: int = Field(default=10, ge=1, le=200)
    new_limit_adults: int = Field(default=5, ge=0, le=50)
    new_limit_kids: int = Field(default=3, ge=0, le=50)
    checks_per_session: int = Field(default=2, ge=0, le=10)
    check_items: int = Field(default=3, ge=2, le=10)
    inactivity_minutes: int = Field(default=10, ge=1, le=120)
    session_expiry_minutes: int = Field(default=120, ge=10, le=24 * 60)
    cards_limit: int = Field(default=2000, ge=10, le=100_000)

    # перевод по тапу: Redis-кеш `gloss:v1:<pair>:<key>`; namespace — только тесты (изоляция параллельных прогонов)
    gloss_cache_ttl_seconds: int = Field(default=3600, ge=1, le=30 * 86_400)
    gloss_cache_namespace: str = Field(default="", max_length=64, pattern=r"^[a-z0-9_]*$")

    # напоминания и tick (INTERNAL_API §1.8)
    # окно напоминания: с REMINDER_HOUR до REMINDER_UNTIL_HOUR по поясу плана (раз в день; пропущенный tick догоняется)
    reminder_hour: int = Field(default=19, ge=0, le=23)
    reminder_until_hour: int = Field(default=22, ge=1, le=24)
    reminder_min_due: int = Field(default=5, ge=1, le=2000)
    reminders_per_tick: int = Field(default=500, ge=1, le=10_000)
    inactivity_days_for_checks: int = Field(default=14, ge=1, le=90)
    error_card_retention_days: int = Field(default=90, ge=1, le=3650)
    pronunciation_retention_days: int = Field(default=180, ge=1, le=3650)
    answer_retention_days: int = Field(default=90, ge=1, le=3650)
    tick_batch_size: int = Field(default=500, ge=1, le=10_000)
    # граница «сегодня» статистики админки
    stats_timezone: str = "Asia/Tashkent"

    @field_validator("scheduler_token", mode="before")
    @classmethod
    def _strip_token(cls, v: object) -> object:
        return v.strip() if isinstance(v, str) else v

    @field_validator("default_timezone", "stats_timezone")
    @classmethod
    def _tz(cls, v: str) -> str:
        try:
            ZoneInfo(v)  # неизвестная зона — ошибка конфигурации при старте
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError(f"unknown timezone {v!r}") from exc
        return v

    @model_validator(mode="after")
    def _guards(self) -> Settings:
        for name in REQUIRED_URLS:
            value = str(getattr(self, name))
            if self.is_secure_env and (name not in self.model_fields_set or not value.strip()):
                raise ValueError(f"{name.upper()} is required in stage/prod")
            if not value.startswith(("http://", "https://")):
                raise ValueError(f"{name.upper()} must be an http(s) URL")
        # от tick зависят сроки хранения (ошибки 90 дней, произношение 180 дней) и напоминания
        token = self.scheduler_token.get_secret_value()
        if self.is_secure_env and len(token) < MIN_SCHEDULER_TOKEN_LEN:
            raise ValueError(f"SCHEDULER_TOKEN is required (>= {MIN_SCHEDULER_TOKEN_LEN} chars) in stage/prod")
        if self.reminder_until_hour <= self.reminder_hour:
            raise ValueError("REMINDER_UNTIL_HOUR must be after REMINDER_HOUR")
        if self.gloss_timeout_seconds * 1000 <= self.gloss_deadline_ms:
            raise ValueError("GLOSS_TIMEOUT_SECONDS must exceed GLOSS_DEADLINE_MS")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
