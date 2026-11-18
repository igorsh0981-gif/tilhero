from functools import lru_cache

from tilhero_common.settings import ServiceSettings


class Settings(ServiceSettings):
    service_name: str = "support"
    # пул Postgres по нагрузке сервиса; сумма максимумов всех сервисов — infra/railway/setup.py DB_POOLS
    # (≤ 80 при max_connections 100 вместе с миграциями)
    db_pool_size: int = 1
    db_max_overflow: int | None = 1
    db_schema: str | None = "support"
    port: int = 8103

    # Лимиты клиента (защита от спама в очередь операторов)
    max_open_tickets: int = 10
    max_user_messages_per_hour: int = 30
    # Порог «скоро просрочено» для SLA-таймеров очереди
    sla_soon_minutes: int = 30
    # Граница «сегодня» в статистике Dashboard (period=today) — по часовому поясу заказчика
    stats_timezone: str = "Asia/Tashkent"


@lru_cache
def get_settings() -> Settings:
    return Settings()
