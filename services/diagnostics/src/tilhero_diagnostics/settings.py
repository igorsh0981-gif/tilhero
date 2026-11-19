from __future__ import annotations

from functools import lru_cache

from pydantic import Field, model_validator

from tilhero_common.settings import ServiceSettings


class Settings(ServiceSettings):
    service_name: str = "diagnostics"
    # пул Postgres по нагрузке сервиса (сумма максимумов всех сервисов — бюджет max_connections, aievent Q10)
    db_pool_size: int = 2
    db_max_overflow: int | None = 1
    db_schema: str | None = "diagnostics"
    port: int = 8111

    # catalog (8110): пары `GET /internal/v1/pairs` и снимок курса `GET /internal/v1/courses/{id}/snapshot` (ETag)
    catalog_url: str = "http://127.0.0.1:8110"
    catalog_timeout_seconds: float = Field(default=3.0, gt=0, le=30)
    # список пар кешируется на N секунд; при недоступности catalog доступна только пара по умолчанию
    pairs_cache_ttl_seconds: int = Field(default=60, ge=1, le=3600)
    # снимок курса перепроверяется (If-None-Match) не чаще раза в N секунд; устаревший снимок используется,
    # пока catalog недоступен
    snapshot_revalidate_seconds: int = Field(default=30, ge=0, le=3600)
    # пара по умолчанию (APP-LANG-02) и её курс — запасной вариант, если catalog недоступен
    default_pair_id: str = "ru-en"
    default_course_id: str = "en-core"

    # DIAG_RETEST_DAYS: повторная диагностика не чаще раза в N дней; пусто — значение retest_days из теста
    diag_retest_days: int | None = Field(default=None, ge=1, le=365)
    # часовой пояс границы «сегодня» статистики админки
    stats_timezone: str = "Asia/Tashkent"

    @model_validator(mode="after")
    def _catalog_url_guard(self) -> Settings:
        # stage/prod: CATALOG_URL задаётся явно (как у BFF) — без него рекомендация старта молча пропала бы
        if self.is_secure_env and ("catalog_url" not in self.model_fields_set or not self.catalog_url.strip()):
            raise ValueError("CATALOG_URL is required in stage/prod")
        if not self.catalog_url.startswith(("http://", "https://")):
            raise ValueError("CATALOG_URL must be an http(s) URL")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
