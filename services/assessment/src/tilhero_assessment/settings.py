from __future__ import annotations

from functools import lru_cache

from pydantic import Field, SecretStr, field_validator, model_validator

from tilhero_common.settings import ServiceSettings

MIN_SCHEDULER_TOKEN_LEN = 32


class Settings(ServiceSettings):
    service_name: str = "assessment"
    # пул Postgres по нагрузке сервиса (сумма максимумов всех сервисов — бюджет max_connections)
    db_pool_size: int = 3
    db_max_overflow: int | None = 2
    db_schema: str | None = "assessment"
    port: int = 8113

    # catalog (8110): версии контента с ключами `GET /internal/v1/versions/{kind}/{key}/{version}` (INTERNAL_API §4).
    # Версии неизменяемы — кеш бессрочный (ограничен по числу записей, вытеснение LRU).
    catalog_url: str = "http://127.0.0.1:8110"
    catalog_timeout_seconds: float = Field(default=3.0, gt=0, le=30)
    content_cache_size: int = Field(default=512, ge=16, le=10_000)

    # ai-gateway (8114): независимый оценщик `independent_evaluator`; при таймауте — оценка без открытой части
    # (partial). Шлюзу передаётся deadline_ms = таймаут − 1 с (ревью R1-03): он не начинает попытку, которая не успеет.
    # ≥ 26 с: попытка оценщика v2 — до 12 с, плюс повтор/резервная модель. Цепочка таймаутов (каждый больше
    # следующего): BFF finish → lessons → assessment (> этого + catalog) → ai-gateway (этот) → дедлайн шлюза.
    ai_gateway_url: str = "http://127.0.0.1:8114"
    ai_gateway_timeout_seconds: float = Field(default=26.0, ge=2, le=61)
    # уверенность оценщика ниже порога → ручная проверка (requires_human_review), баллы не меняются
    evaluator_min_confidence: float = Field(default=0.5, ge=0, le=1)

    # апелляция — в течение N дней с момента актуальной оценки (INTERNAL_API §3.1)
    appeal_window_days: int = Field(default=14, ge=1, le=365)
    # часовой пояс границы «сегодня» статистики админки
    stats_timezone: str = "Asia/Tashkent"

    # Вход n8n `assessment-tick`: `Authorization: Bearer <SCHEDULER_TOKEN>`. Пусто — вход выключен.
    scheduler_token: SecretStr = SecretStr("")
    # текст апелляции (свободный текст ученика) стирается через N дней после решения (ревью R1-14)
    appeal_reason_retention_days: int = Field(default=90, ge=1, le=3650)
    tick_batch_size: int = Field(default=500, ge=10, le=10_000)
    # memory-feed (спринт 5): цитата ученика (evidence) не отдаётся memory для сессий старше N дней — срок хранения
    # текста ученика (90 дней, как реплики в lessons и цитата в карточке memory); сама оценка не меняется
    memory_evidence_retention_days: int = Field(default=90, ge=1, le=3650)

    @field_validator("scheduler_token", mode="before")
    @classmethod
    def _strip_token(cls, v: object) -> object:
        return v.strip() if isinstance(v, str) else v

    @model_validator(mode="after")
    def _urls_guard(self) -> Settings:
        # stage/prod: адреса зависимостей задаются явно — без них оценка молча шла бы в localhost
        for field, env in (("catalog_url", "CATALOG_URL"), ("ai_gateway_url", "AI_GATEWAY_URL")):
            value: str = getattr(self, field)
            if self.is_secure_env and (field not in self.model_fields_set or not value.strip()):
                raise ValueError(f"{env} is required in stage/prod")
            if not value.startswith(("http://", "https://")):
                raise ValueError(f"{env} must be an http(s) URL")
        # от tick зависят сроки хранения ПДн (стирание текстов через 90 дней) — в stage/prod токен обязателен (R3-05)
        token = self.scheduler_token.get_secret_value()
        if self.is_secure_env and len(token) < MIN_SCHEDULER_TOKEN_LEN:
            raise ValueError(f"SCHEDULER_TOKEN is required (>= {MIN_SCHEDULER_TOKEN_LEN} chars) in stage/prod")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
