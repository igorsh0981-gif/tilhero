from __future__ import annotations

from functools import lru_cache
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import Field, SecretStr, field_validator, model_validator

from tilhero_common.settings import ServiceSettings

MIN_SCHEDULER_TOKEN_LEN = 32


class Settings(ServiceSettings):
    """gamification (8117): начисления только по событиям, сам никого синхронно не вызывает (INTERNAL_API §0)."""

    service_name: str = "gamification"
    db_pool_size: int = 3
    db_max_overflow: int | None = 2
    db_schema: str | None = "gamification"
    port: int = 8117

    # день ученика без проекции плана; граница «сегодня» обзора админки
    default_timezone: str = "Asia/Tashkent"
    stats_timezone: str = "Asia/Tashkent"

    # Вход n8n `game-tick` (каждые 15 минут): `Authorization: Bearer <SCHEDULER_TOKEN>`. Пусто — вход выключен.
    scheduler_token: SecretStr = SecretStr("")
    tick_batch_size: int = Field(default=500, ge=1, le=10_000)
    # сверка wallets с реестром — не чаще раза в RECONCILE_HOURS
    reconcile_hours: int = Field(default=24, ge=1, le=168)
    # реферал без первого урока приглашённого — void через N дней
    referral_void_days: int = Field(default=90, ge=1, le=365)
    # заморозка выпускается не позже чем через N часов после конца пропущенного дня (§1.2); позже — не тратится
    freeze_late_hours: int = Field(default=24, ge=1, le=72)
    # награды навыков, пришедшие в течение N минут после урока, показываются в наградах этого занятия (§1.8)
    session_attribution_minutes: int = Field(default=10, ge=0, le=120)
    # уведомления о значках и росте героя — только по событиям не старше N минут (догоняющее чтение стрима)
    notify_max_age_minutes: int = Field(default=60, ge=1, le=24 * 60)
    # ключи идемпотентности команд сотрудников и несвязанные итоги навыков хранятся N дней
    idempotency_days: int = Field(default=7, ge=1, le=90)

    # картинки (§1.1 assets): ≤ 300 КБ, ≤ 1024×1024
    asset_max_bytes: int = Field(default=300 * 1024, ge=1024, le=1_000_000)
    asset_max_px: int = Field(default=1024, ge=16, le=4096)

    @field_validator("scheduler_token", mode="before")
    @classmethod
    def _strip_token(cls, v: object) -> object:
        return v.strip() if isinstance(v, str) else v

    @field_validator("default_timezone", "stats_timezone")
    @classmethod
    def _tz(cls, v: str) -> str:
        try:
            ZoneInfo(v)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError(f"unknown timezone {v!r}") from exc
        return v

    @model_validator(mode="after")
    def _guards(self) -> Settings:
        # от tick зависят конец дня заданий, окончание событий недели и сверка кошельков
        token = self.scheduler_token.get_secret_value()
        if self.is_secure_env and len(token) < MIN_SCHEDULER_TOKEN_LEN:
            raise ValueError(f"SCHEDULER_TOKEN is required (>= {MIN_SCHEDULER_TOKEN_LEN} chars) in stage/prod")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
