from __future__ import annotations

from functools import lru_cache
from zoneinfo import ZoneInfo

from pydantic import Field, SecretStr, field_validator, model_validator

from tilhero_common.settings import ServiceSettings

MIN_SCHEDULER_TOKEN_LEN = 32
MIN_USER_REF_SECRET_LEN = 32
# dev/test: псевдоним ученика в карточке «Контроля диалогов» стабилен между запусками; stage/prod — свой секрет
DEV_USER_REF_SECRET = "tilhero-dev-user-ref-secret-not-for-production"  # noqa: S105 — значение только dev/test
# адреса доменов, которые вызывает lessons (INTERNAL_API §0): в stage/prod задаются явно
REQUIRED_URLS = ("catalog_url", "ai_gateway_url", "assessment_url", "learning_plan_url", "diagnostics_url")


class Settings(ServiceSettings):
    service_name: str = "lessons"
    # пул Postgres по нагрузке сервиса (сумма максимумов всех сервисов — бюджет max_connections)
    db_pool_size: int = 3
    db_max_overflow: int | None = 2
    db_schema: str | None = "lessons"
    port: int = 8112

    # catalog (8110): пары, снимок курса (ETag), версии контента с ключами, упражнения к медиа
    catalog_url: str = "http://127.0.0.1:8110"
    catalog_timeout_seconds: float = Field(default=3.0, gt=0, le=30)
    pairs_cache_ttl_seconds: int = Field(default=60, ge=1, le=3600)
    snapshot_revalidate_seconds: int = Field(default=30, ge=0, le=3600)
    # опубликованная версия сущности (указатель) кешируется на N секунд; сами версии неизменяемы — бессрочно (LRU)
    published_cache_seconds: int = Field(default=30, ge=0, le=3600)
    versions_cache_size: int = Field(default=1024, ge=16, le=100_000)
    default_pair_id: str = "ru-en"
    default_course_id: str = "en-core"

    # Цепочка таймаутов (README «Таймауты»): telegram-bff → lessons 25 с (шаги), finish — 35 с;
    # lessons → ai-gateway 20 с < 25; ai-gateway статус — 2 с (старт не ждёт); lessons → assessment 30 с — больше,
    # чем assessment → ai-gateway (≥ 26 с), и вместе с второстепенными вызовами итогов (≤ 2 + 2 с) меньше 35 с.
    # ai-gateway (8114): conversation_partner, teaching_coach. Недоступен — урок идёт без ИИ
    ai_gateway_url: str = "http://127.0.0.1:8114"
    ai_timeout_seconds: float = Field(default=20.0, gt=0, le=60)
    # GET /internal/v1/status при старте занятия (R1-16): короткий — нет ответа за 2 с, режим full (как ошибка связи)
    ai_status_timeout_seconds: float = Field(default=2.0, gt=0, le=10)
    # assessment (8113): POST /internal/v1/evaluations — синхронно при finish (INTERNAL_API §2.2; R2-02 — 30 с)
    assessment_url: str = "http://127.0.0.1:8113"
    assessment_timeout_seconds: float = Field(default=32.0, gt=0, le=60)
    # второстепенные вызовы итогов (finish): «было» навыков + названия (параллельно) и следующий урок — каждый этап
    # не дольше N с, иначе без них; повторное чтение оценки в GET …/summary (без ИИ) — не дольше M с
    summary_aux_timeout_seconds: float = Field(default=2.0, gt=0, le=10)
    summary_refresh_timeout_seconds: float = Field(default=5.0, gt=0, le=20)
    # learning-plan (8102): следующий урок для итогов; diagnostics (8111): карта навыков (повторение, «было → стало»)
    learning_plan_url: str = "http://127.0.0.1:8102"
    diagnostics_url: str = "http://127.0.0.1:8111"
    aux_timeout_seconds: float = Field(default=3.0, gt=0, le=30)

    # псевдоним ученика в карточке сессии (admin): HMAC-SHA256(user_id, USER_REF_SECRET)[:8 hex] — без секрета
    # не сопоставить с user_id (R2-06). Обязателен в stage/prod (≥ 32 символов), в dev/test — значение по умолчанию
    user_ref_secret: SecretStr = SecretStr(DEV_USER_REF_SECRET)

    # Вход n8n `lessons-tick`: `Authorization: Bearer <SCHEDULER_TOKEN>`. Пусто — вход выключен.
    scheduler_token: SecretStr = SecretStr("")

    # правила сессии (INTERNAL_API §2.2)
    inactivity_minutes: int = Field(default=10, ge=1, le=120)
    pause_expiry_hours: int = Field(default=72, ge=1, le=24 * 30)
    ready_expiry_hours: int = Field(default=24, ge=1, le=24 * 30)
    # текст реплик и открытых ответов ученика хранится N дней, затем стирается tick-ом
    text_retention_days: int = Field(default=90, ge=1, le=3650)
    # очередь повторения: ошибка или подсказка → задание вернётся через N дней
    review_delay_days: int = Field(default=1, ge=0, le=60)
    # повторная отправка в assessment сессий без оценки — не дольше N дней после завершения
    evaluation_retry_days: int = Field(default=7, ge=1, le=60)
    tick_batch_size: int = Field(default=200, ge=1, le=5000)
    # время на повторную отправку оценок за один tick: 75 + таймаут assessment (30) < 120 с ожидания n8n
    tick_resend_budget_seconds: float = Field(default=75.0, gt=0, le=600)
    # граница «сегодня» статистики админки (period=day)
    stats_timezone: str = "Asia/Tashkent"
    # длительность практики (сценарий, медиа, повтор) для ограничения minutes (≤ 2× длительности)
    practice_duration_min: int = Field(default=10, ge=1, le=60)

    @field_validator("scheduler_token", mode="before")
    @classmethod
    def _strip_token(cls, v: object) -> object:
        return v.strip() if isinstance(v, str) else v

    @field_validator("user_ref_secret", mode="before")
    @classmethod
    def _ref_secret(cls, v: object) -> object:
        """Пусто — значение dev/test по умолчанию (в stage/prod оно отклоняется проверкой ниже)."""
        if isinstance(v, str):
            return v.strip() or DEV_USER_REF_SECRET
        return v

    @field_validator("stats_timezone")
    @classmethod
    def _tz(cls, v: str) -> str:
        ZoneInfo(v)  # неизвестная зона — ошибка конфигурации при старте
        return v

    @model_validator(mode="after")
    def _guards(self) -> Settings:
        for name in REQUIRED_URLS:
            value = str(getattr(self, name))
            if self.is_secure_env and (name not in self.model_fields_set or not value.strip()):
                raise ValueError(f"{name.upper()} is required in stage/prod")
            if not value.startswith(("http://", "https://")):
                raise ValueError(f"{name.upper()} must be an http(s) URL")
        # от tick зависят сроки хранения ПДн (стирание текстов через 90 дней) — в stage/prod токен обязателен (R3-05)
        token = self.scheduler_token.get_secret_value()
        if self.is_secure_env and len(token) < MIN_SCHEDULER_TOKEN_LEN:
            raise ValueError(f"SCHEDULER_TOKEN is required (>= {MIN_SCHEDULER_TOKEN_LEN} chars) in stage/prod")
        ref_secret = self.user_ref_secret.get_secret_value()
        if self.is_secure_env and ("user_ref_secret" not in self.model_fields_set or ref_secret == DEV_USER_REF_SECRET
                                   or len(ref_secret) < MIN_USER_REF_SECRET_LEN):
            raise ValueError(f"USER_REF_SECRET must be set (>= {MIN_USER_REF_SECRET_LEN} chars) in stage/prod")
        return self

    def user_ref_key(self) -> bytes:
        return self.user_ref_secret.get_secret_value().encode("utf-8")


@lru_cache
def get_settings() -> Settings:
    return Settings()
