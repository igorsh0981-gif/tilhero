from functools import lru_cache

from pydantic import Field

from tilhero_common.settings import ServiceSettings


class Settings(ServiceSettings):
    service_name: str = "user-admin"
    # спринт 9 (Q10): пул Postgres по нагрузке сервиса; сумма максимумов всех сервисов — infra/railway/setup.py
    # DB_POOLS (≤ 80 при max_connections 100 вместе с миграциями)
    db_pool_size: int = 1
    db_max_overflow: int | None = 1
    db_schema: str | None = "user_admin"
    port: int = 8121

    # identity-consent — authoritative-источник профиля (GET /admin/v1/users, /admin/v1/users/{id})
    identity_url: str = "http://127.0.0.1:8101"
    identity_timeout_seconds: float = Field(default=5.0, gt=0)

    # Курсорная сверка с identity-consent: при старте и каждые N секунд (+ досрочно после user.profile.created.v1)
    sync_enabled: bool = True
    sync_interval_seconds: float = Field(default=600.0, gt=0)
    sync_min_gap_seconds: float = Field(default=2.0, ge=0)  # не чаще одного прогона за N секунд
    # Перекрытие окна updated_after: транзакция identity, начатая раньше, может зафиксироваться позже прогона
    sync_overlap_seconds: int = Field(default=120, ge=0)
    sync_page_size: int = Field(default=100, ge=1, le=100)

    # Карточка перечитывает identity-consent, если данным больше N секунд (refreshed_at)
    card_max_age_seconds: int = Field(default=60, ge=1)

    # Граница «сегодня» для stats (period=today) — часовой пояс заказчика
    stats_timezone: str = "Asia/Tashkent"


@lru_cache
def get_settings() -> Settings:
    return Settings()
