from functools import lru_cache

from tilhero_common.settings import ServiceSettings


class Settings(ServiceSettings):
    service_name: str = "audit"
    # спринт 9 (Q10): пул Postgres по нагрузке сервиса; сумма максимумов всех сервисов — infra/railway/setup.py
    # DB_POOLS (≤ 80 при max_connections 100 вместе с миграциями)
    db_pool_size: int = 1
    db_max_overflow: int | None = 1
    db_schema: str | None = "audit"
    port: int = 8105


@lru_cache
def get_settings() -> Settings:
    return Settings()
