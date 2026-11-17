from functools import lru_cache

from pydantic import Field

from tilhero_common.settings import ServiceSettings


class Settings(ServiceSettings):
    service_name: str = "preferences"
    # спринт 9 (Q10): пул Postgres по нагрузке сервиса; сумма максимумов всех сервисов — infra/railway/setup.py
    # DB_POOLS (≤ 80 при max_connections 100 вместе с миграциями)
    db_pool_size: int = 2
    db_max_overflow: int | None = 1
    db_schema: str | None = "preferences"
    port: int = 8102

    # Агрегат спроса для discovery (GET /internal/v1/demand): группы меньше порога скрываются (k-анонимность),
    # в каждом списке — не больше demand_top_n позиций.
    demand_min_group: int = Field(default=1, ge=1, le=10_000)
    demand_top_n: int = Field(default=50, ge=1, le=500)


@lru_cache
def get_settings() -> Settings:
    return Settings()
