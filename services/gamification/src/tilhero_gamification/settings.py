from __future__ import annotations

from functools import lru_cache
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import Field, SecretStr, field_validator, model_validator

from tilhero_common.settings import ServiceSettings

MIN_SCHEDULER_TOKEN_LEN = 32
MIN_MEMBER_ID_KEY_LEN = 32
# только dev/test: в stage/prod запрещён валидатором
_DEV_MEMBER_ID_KEY = "dev-member-id-key-change-me-0000000000"
# адреса доменов, которые вызывает gamification (спринт 7, INTERNAL_API §0): в stage/prod задаются явно
REQUIRED_URLS = ("social_url", "lessons_url", "diagnostics_url", "identity_consent_url")


class Settings(ServiceSettings):
    """gamification (8117): начисления — по событиям; синхронно (спринт 7) — social (связь учеников, member_id →
    user_id) и lessons (набор заданий дуэли) только в командах дуэли (INTERNAL_API спринта 7 §0)."""

    service_name: str = "gamification"
    db_pool_size: int = 3
    db_max_overflow: int | None = 2
    db_schema: str | None = "gamification"
    port: int = 8117

    # день ученика без проекции плана; граница «сегодня» обзора админки
    default_timezone: str = "Asia/Tashkent"
    stats_timezone: str = "Asia/Tashkent"

    # спринт 7: social (8109) — GET /internal/v1/relations/{a}/{b}, GET /internal/v1/members/{member_id}, выгрузки
    # families / friendships; lessons (8112) — POST /internal/v1/duel-sets. Недоступность → 503 (UPSTREAM_UNAVAILABLE /
    # DUEL_SET_UNAVAILABLE)
    social_url: str = "http://127.0.0.1:8109"
    social_timeout_seconds: float = Field(default=3.0, gt=0, le=30)
    lessons_url: str = "http://127.0.0.1:8112"
    lessons_timeout_seconds: float = Field(default=5.0, gt=0, le=30)
    # diagnostics (8111): разовая загрузка проекции полос уровня — GET /internal/v1/export/levels
    diagnostics_url: str = "http://127.0.0.1:8111"
    diagnostics_timeout_seconds: float = Field(default=10.0, gt=0, le=60)
    # identity-consent (8101): разовая загрузка возраста и согласия родителя — GET /internal/v1/export/profiles
    identity_consent_url: str = "http://127.0.0.1:8101"
    identity_consent_timeout_seconds: float = Field(default=10.0, gt=0, le=60)
    # разовая загрузка проекций (семьи, дружбы, полосы уровня) из выгрузок social и diagnostics: в фоне при старте,
    # пока не завершена; сбой источника — повтор следующим tick (POST /internal/v1/projections/bootstrap — вручную)
    projection_bootstrap_on_start: bool = True
    projection_page_size: int = Field(default=500, ge=1, le=500)
    # переход рефералов спринта 6: pending «доживает» по прежнему правилу N дней с принятия, затем — expired
    legacy_referral_days: int = Field(default=90, ge=1, le=365)  # REFERRAL_VOID_DAYS спринта 6
    # MEMBER_ID_KEY: member_id = "mb_" + base64url(HMAC-SHA256(key, str(user_id))[:16]) — один ключ у social,
    # gamification и lessons (INTERNAL_API спринта 7 §0); в stage/prod обязателен (≥ 32 символов)
    member_id_key: SecretStr = SecretStr(_DEV_MEMBER_ID_KEY)
    # неделя лиг: понедельник 00:00 – воскресенье 24:00 по этому поясу (одна на всех)
    league_timezone: str = "Asia/Tashkent"
    # пара ученика без диагностики (лига, дуэль по умолчанию)
    default_pair_id: str = Field(default="ru-en", pattern=r"^[a-z]{2,3}-[a-z]{2,3}$")
    # дуэль после play_deadline завершается tick'ом не раньше чем через N минут: lessons успевает закрыть
    # незаконченные сессии со счётом по отвеченному (§3.1)
    duel_finish_grace_minutes: int = Field(default=30, ge=0, le=24 * 60)

    # Вход n8n `game-tick` (каждые 15 минут): `Authorization: Bearer <SCHEDULER_TOKEN>`. Пусто — вход выключен.
    scheduler_token: SecretStr = SecretStr("")
    tick_batch_size: int = Field(default=500, ge=1, le=10_000)
    # сверка wallets с реестром — не чаще раза в RECONCILE_HOURS
    reconcile_hours: int = Field(default=24, ge=1, le=168)
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

    @field_validator("scheduler_token", "member_id_key", mode="before")
    @classmethod
    def _strip_token(cls, v: object) -> object:
        return v.strip() if isinstance(v, str) else v

    @field_validator("default_timezone", "stats_timezone", "league_timezone")
    @classmethod
    def _tz(cls, v: str) -> str:
        try:
            ZoneInfo(v)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError(f"unknown timezone {v!r}") from exc
        return v

    @model_validator(mode="after")
    def _guards(self) -> Settings:
        # от tick зависят конец дня заданий, окончание событий недели, сверка кошельков, лиги и дедлайны дуэлей
        token = self.scheduler_token.get_secret_value()
        if self.is_secure_env and len(token) < MIN_SCHEDULER_TOKEN_LEN:
            raise ValueError(f"SCHEDULER_TOKEN is required (>= {MIN_SCHEDULER_TOKEN_LEN} chars) in stage/prod")
        for name in REQUIRED_URLS:
            value = str(getattr(self, name))
            if self.is_secure_env and (name not in self.model_fields_set or not value.strip()):
                raise ValueError(f"{name.upper()} is required in stage/prod")
            if not value.startswith(("http://", "https://")):
                raise ValueError(f"{name.upper()} must be an http(s) URL")
        key = self.member_id_key.get_secret_value()
        if self.is_secure_env and (key == _DEV_MEMBER_ID_KEY or len(key) < MIN_MEMBER_ID_KEY_LEN):
            raise ValueError(f"MEMBER_ID_KEY is required (>= {MIN_MEMBER_ID_KEY_LEN} chars) in stage/prod")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
