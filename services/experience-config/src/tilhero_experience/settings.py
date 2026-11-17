from functools import lru_cache

from tilhero_common.settings import ServiceSettings


class Settings(ServiceSettings):
    service_name: str = "experience-config"
    # пул Postgres по нагрузке сервиса; сумма максимумов всех сервисов — infra/railway/setup.py DB_POOLS
    # (≤ 80 при max_connections 100 вместе с миграциями)
    db_pool_size: int = 1
    db_max_overflow: int | None = 1
    db_schema: str | None = "experience_config"
    port: int = 8106
    # Кэш текущей конфигурации в Redis (INTERNAL_API: 60 с; инвалидация при активации/откате).
    cache_ttl_seconds: int = 60
    cache_namespace: str = "expcfg"


@lru_cache
def get_settings() -> Settings:
    return Settings()
