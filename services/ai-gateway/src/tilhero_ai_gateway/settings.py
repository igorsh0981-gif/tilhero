from __future__ import annotations

import re
from functools import lru_cache
from typing import Final, Literal
from zoneinfo import ZoneInfo

from pydantic import Field, SecretStr, field_validator, model_validator

from tilhero_common.settings import ServiceSettings

REGION_RE: Final = re.compile(r"[a-z][a-z0-9]{1,39}")


class Settings(ServiceSettings):
    service_name: str = "ai-gateway"
    # пул Postgres по нагрузке сервиса (сумма максимумов — infra/railway/setup.py DB_POOLS)
    db_pool_size: int = 2
    db_max_overflow: int | None = 1
    db_schema: str | None = "ai_gateway"
    port: int = 8114

    # Провайдер ИИ: anthropic (prod) | fake (тесты, стенд e2e; в stage/prod запрещён)
    ai_provider: Literal["anthropic", "fake"] = "anthropic"
    # Ключ Anthropic — ТОЛЬКО переменная окружения ai-gateway (не БД, не логи, не ответы). Пусто — ИИ выключен.
    anthropic_api_key: SecretStr | None = None
    # База Messages API (тесты подменяют транспорт httpx; в stage/prod — только https)
    anthropic_base_url: str = "https://api.anthropic.com"

    # Оценка произношения (спринт 5, INTERNAL_API §3.2): azure (prod) | fake (тесты, стенд e2e; в stage/prod запрещён).
    # Ключ и регион Azure Speech — ТОЛЬКО переменные окружения ai-gateway (в Railway — ссылки на общие переменные
    # проекта, вводит владелец). Пусто — «не настроено»: speech_available=false, вызовы — unavailable: not_configured.
    speech_provider: Literal["azure", "fake"] = "azure"
    azure_speech_key: SecretStr | None = None
    azure_speech_region: str | None = None

    # Каталог сида версий и золотых тестов для миграции 0002 (по умолчанию — migrations/seed; тесты — свой набор)
    seed_dir: str | None = None
    # Пространство ключей Redis: идемпотентность вызовов (request_id, 24 ч) и команд сотрудников, последняя ошибка
    cache_namespace: str = "ai-gateway"
    invoke_cache_ttl_seconds: int = Field(default=24 * 3600, ge=60, le=7 * 24 * 3600)

    # «День» ученика для лимита в день и границы сводок — по Ташкенту; месяц потолка — календарный месяц UTC
    timezone: str = "Asia/Tashkent"
    # публикация и канарейка — по прогону золотых тестов этой версии не старше N дней
    golden_run_max_age_days: int = Field(default=14, ge=1, le=90)
    # Публикация и канарейка по прогону на fake — только dev/e2e-стенд (INTERNAL_API §9); в stage/prod — только
    # прогон на anthropic. true в stage/prod — ошибка конфигурации при старте.
    ai_allow_fake_test_publish: bool = False
    # прогон, «зависший» в running дольше N минут (рестарт процесса), при старте помечается failed
    golden_run_stale_minutes: int = Field(default=60, ge=5, le=24 * 60)
    # не больше N золотых прогонов в сутки (по TIMEZONE) на все агенты — прогон на anthropic стоит денег (ревью R1-11)
    golden_runs_daily_limit: int = Field(default=20, ge=1, le=1000)

    @field_validator("anthropic_api_key", "azure_speech_key", mode="before")
    @classmethod
    def _strip_key(cls, v: object) -> object:
        if isinstance(v, str):
            v = v.strip()
            return v or None
        return v

    @field_validator("azure_speech_region", mode="before")
    @classmethod
    def _region(cls, v: object) -> object:
        """Пустая ссылка Railway (`${{shared.AZURE_SPEECH_REGION}}` до ввода владельцем) — «не задан». Неверный формат
        не роняет сервис (ИИ уроков не должен страдать из-за необязательной функции): регион считается не заданным
        (`speech_region` → None), в админке виден введённый текст."""
        if isinstance(v, str):
            v = v.strip().lower()
            return v or None
        return v

    @field_validator("timezone")
    @classmethod
    def _tz(cls, v: str) -> str:
        ZoneInfo(v)  # неизвестная зона — ошибка конфигурации при старте
        return v

    @model_validator(mode="after")
    def _provider_guard(self) -> Settings:
        if self.is_secure_env and self.ai_provider == "fake":
            raise ValueError("AI_PROVIDER=fake is not allowed in stage/prod")
        if self.is_secure_env and self.speech_provider == "fake":
            raise ValueError("SPEECH_PROVIDER=fake is not allowed in stage/prod")
        if self.ai_allow_fake_test_publish and self.env not in ("dev", "test"):
            raise ValueError("AI_ALLOW_FAKE_TEST_PUBLISH=true is allowed only with ENV dev|test")
        if not self.anthropic_base_url.startswith(("https://", "http://")):
            raise ValueError("ANTHROPIC_BASE_URL must be an http(s) URL")
        if self.is_secure_env and not self.anthropic_base_url.startswith("https://"):
            raise ValueError("ANTHROPIC_BASE_URL must be https in stage/prod")
        return self

    @property
    def publish_providers(self) -> tuple[str, ...]:
        """Провайдеры прогона, по которому можно публиковать версию и ставить канарейку."""
        return ("anthropic", "fake") if self.ai_allow_fake_test_publish else ("anthropic",)

    @property
    def api_key(self) -> str | None:
        """Значение ключа — только для заголовка запроса к провайдеру (никогда в логи и ответы)."""
        return self.anthropic_api_key.get_secret_value() if self.anthropic_api_key is not None else None

    @property
    def speech_key(self) -> str | None:
        """Ключ Azure Speech — только для заголовка Ocp-Apim-Subscription-Key (никогда в логи, ответы и БД)."""
        return self.azure_speech_key.get_secret_value() if self.azure_speech_key is not None else None

    @property
    def speech_region(self) -> str | None:
        """Регион Azure (westeurope, eastus2, …) или None — не задан или не похож на регион (тогда речь выключена)."""
        region = self.azure_speech_region
        return region if region is not None and REGION_RE.fullmatch(region) else None


@lru_cache
def get_settings() -> Settings:
    return Settings()
