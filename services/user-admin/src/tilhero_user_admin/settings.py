from functools import lru_cache

from pydantic import Field, SecretStr, field_validator, model_validator

from tilhero_common.settings import ServiceSettings

MIN_SCHEDULER_TOKEN_LEN = 32


class Settings(ServiceSettings):
    service_name: str = "user-admin"
    # пул Postgres по нагрузке сервиса (сумма максимумов всех сервисов — бюджет max_connections)
    db_pool_size: int = 2
    db_max_overflow: int | None = 1
    db_schema: str | None = "user_admin"
    port: int = 8121

    # Источники (INTERNAL_API §3): identity-consent GET /admin/v1/users[/{id}], learning-plan GET /admin/v1/plans
    identity_consent_url: str = "http://127.0.0.1:8101"
    learning_plan_url: str = "http://127.0.0.1:8102"
    upstream_timeout_seconds: float = Field(default=5.0, gt=0)

    # Вход n8n в POST /internal/v1/reconcile: `Authorization: Bearer <SCHEDULER_TOKEN>`. Пусто — вход выключен (401).
    scheduler_token: SecretStr = SecretStr("")

    # Курсорная сверка: при старте и каждые N секунд (+ досрочно после событий без нужных данных)
    reconcile_enabled: bool = True
    reconcile_interval_seconds: float = Field(default=600.0, gt=0)
    reconcile_min_gap_seconds: float = Field(default=2.0, ge=0)  # не чаще одного прогона за N секунд
    # Перекрытие окна updated_after: транзакция источника, начатая раньше, может зафиксироваться позже прогона
    reconcile_overlap_seconds: int = Field(default=120, ge=0)
    reconcile_page_size: int = Field(default=500, ge=1, le=500)

    # Граница «сегодня» для stats (period=today) — часовой пояс заказчика
    stats_timezone: str = "Asia/Tashkent"

    @field_validator("scheduler_token", mode="before")
    @classmethod
    def _strip_token(cls, v: object) -> object:
        return v.strip() if isinstance(v, str) else v

    @model_validator(mode="after")
    def _scheduler_token_guard(self) -> "Settings":
        # stage/prod: пусто (вход выключен) или не короче 32 символов
        token = self.scheduler_token.get_secret_value()
        if self.is_secure_env and token and len(token) < MIN_SCHEDULER_TOKEN_LEN:
            raise ValueError(f"SCHEDULER_TOKEN must be empty or >= {MIN_SCHEDULER_TOKEN_LEN} chars in stage/prod")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
