from functools import lru_cache

from pydantic import Field, field_validator, model_validator

from tilhero_common.settings import ServiceSettings


class Settings(ServiceSettings):
    service_name: str = "identity-consent"
    # спринт 9 (Q10): пул Postgres по нагрузке сервиса; сумма максимумов всех сервисов — infra/railway/setup.py
    # DB_POOLS (≤ 80 при max_connections 100 вместе с миграциями)
    db_pool_size: int = 2
    db_max_overflow: int | None = 2
    db_schema: str | None = "identity_consent"
    port: int = 8101

    # Действующая версия политики обработки данных (тексты — tilhero_identity.domain.policy).
    current_policy_version: str = "1.0"
    default_timezone: str = "Asia/Tashkent"

    # PIN / биометрия: общий счётчик попыток (ТЗ TG-FR-003, решение заказчика №4).
    pin_max_attempts: int = Field(default=5, ge=1)
    pin_lock_seconds: int = Field(default=300, ge=1)

    # Сброс PIN кодом из бота.
    pin_reset_code_ttl_seconds: int = Field(default=600, ge=60, le=3600)  # шаблон кода: 1–60 минут
    pin_reset_code_max_attempts: int = Field(default=5, ge=1)
    pin_reset_min_interval_seconds: int = Field(default=60, ge=1)
    pin_reset_daily_limit: int = Field(default=5, ge=1)

    # notifications: синхронная доставка кода сброса PIN (POST /internal/v1/notifications/transactional)
    notifications_url: str = "http://127.0.0.1:8104"
    notifications_timeout_seconds: float = Field(default=8.0, gt=0)

    # audit: синхронная запись просмотра чувствительного поля (reveal) — без записи значение не выдаётся
    audit_url: str = "http://127.0.0.1:8105"
    audit_timeout_seconds: float = Field(default=3.0, gt=0)
    reveal_expires_in_seconds: int = Field(default=60, ge=10, le=300)
    # Квота раскрытий на сотрудника (защита от массовой выгрузки Telegram ID): N за окно, Redis
    reveal_limit_per_window: int = Field(default=20, ge=1)
    reveal_window_seconds: int = Field(default=3600, ge=60)

    # Домены, которые обязаны подтвердить удаление (user.domain.deleted.v1) до обезличивания профиля.
    # offers — спринт 5; recommendations (реакции), watch (слежения), news (настройки и отметки) — спринт 6;
    # ai-concierge (переписки, ходы, квоты) и ai-control (назначения уровня доступа, обезличивание usage) — спринт 7.
    deletion_domains: list[str] = Field(default_factory=lambda: [
        "preferences", "support", "notifications", "offers", "recommendations", "watch", "news",
        "ai-concierge", "ai-control"])

    # Сага удаления (спринт 9, ADR-009, INTERNAL_API §1.3): повторы запроса неответившим доменам — через N минут от
    # запроса (дальше каждые 1440 мин, пока запрос открыт); «зависло» — через DELETION_STUCK_HOURS; таймер опрашивает
    # раз в DELETION_SWEEP_SECONDS (0 — таймер выключен); ручной повтор сотрудником — не чаще раза в N секунд.
    deletion_retry_schedule_minutes: str = "15,60,240,720,1440"
    deletion_stuck_hours: float = Field(default=24, gt=0)
    deletion_sweep_seconds: float = Field(default=60, ge=0)
    deletion_manual_retry_min_seconds: int = Field(default=300, ge=0)

    @field_validator("deletion_retry_schedule_minutes")
    @classmethod
    def _schedule(cls, v: str) -> str:
        from tilhero_identity.deletion.saga import parse_schedule

        return ",".join(str(m) for m in parse_schedule(v))

    @property
    def deletion_retry_schedule(self) -> tuple[int, ...]:
        from tilhero_identity.deletion.saga import parse_schedule

        return parse_schedule(self.deletion_retry_schedule_minutes)

    @model_validator(mode="after")
    def _identity_guard(self) -> "Settings":
        from tilhero_identity.domain.policy import POLICIES

        if self.current_policy_version not in POLICIES:
            raise ValueError(f"CURRENT_POLICY_VERSION={self.current_policy_version!r} has no policy text")
        if self.is_secure_env and not self.redis_url:
            raise ValueError("REDIS_URL is required: PIN attempts and reset codes live in Redis")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
