"""Настройки billing (8118, схема `billing`) — INTERNAL_API спринта 8 §0.7 (флаги), §0.8 (секреты), §13 (переменные).

Секреты провайдеров (`PAYME_KEY`, `PAYME_SUBSCRIBE_KEY`, `CLICK_SECRET_KEY`, `UZUM_PASSWORD`) вводит владелец в
переменные Railway (ссылка `${{shared.<ИМЯ>}}` только у billing); `PAYMENTS_EDGE_TOKEN` генерирует
infra/railway/setup.py (тот же у payments-edge). Значения — только `SecretStr`: не в логах, `repr`, ответах и ошибках
конфигурации (`hide_input_in_errors`). Токена бота у billing нет и быть не должно: Bot API — через bot-gateway.

stage/prod: адреса соседей заданы явно, `SCHEDULER_TOKEN` и `PAYMENTS_EDGE_TOKEN` ≥ 32 символов, `WEB_PAY_ORIGIN` —
https; флаг провайдера включён при пустом ключе или реквизитах — сервис не стартует. `PAYMENTS_ENABLED` по умолчанию
выключен в stage/prod и включён в dev/test.
"""

from __future__ import annotations

import ipaddress
from functools import lru_cache
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import Field, SecretStr, field_validator, model_validator

from tilhero_common.settings import ServiceSettings

MIN_TOKEN_LEN = 32
# адреса доменов, которые вызывает billing (INTERNAL_API §0.3): в stage/prod задаются явно
REQUIRED_URLS = ("identity_consent_url", "gamification_url", "botgw_url", "web_pay_origin")
SECRET_FIELDS = ("payme_key", "payme_subscribe_key", "click_secret_key", "uzum_password", "payments_edge_token",
                 "scheduler_token")


def _cidrs(value: str) -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    """«10.0.0.0/8, 2001:db8::/32» → сети; пусто — проверка IP выключена (В16, О8)."""
    return [ipaddress.ip_network(x.strip(), strict=False) for x in value.split(",") if x.strip()]


class Settings(ServiceSettings):
    """billing: каталог, заказы и каналы, платёжный контур и адаптеры, периоды, реестр минут, возвраты, сверка."""

    service_name: str = "billing"
    port: int = 8118
    db_schema: str | None = "billing"
    db_pool_size: int = 3
    db_max_overflow: int | None = 2

    # ---- соседи (INTERNAL_API §0.3)
    # identity-consent (8101): выгрузка профилей для проекции learners (в фоне, повтор tick'ом)
    identity_consent_url: str = "http://127.0.0.1:8101"
    identity_consent_timeout_seconds: float = Field(default=10.0, gt=0, le=60)
    # gamification (8117): пред-проверка возврата тилов GET /internal/v1/game/purchases/by-order/{order_id}
    gamification_url: str = "http://127.0.0.1:8117"
    gamification_timeout_seconds: float = Field(default=5.0, gt=0, le=30)
    # telegram-bot-gateway, ВНУТРЕННИЙ порт (8108): /internal/v1/stars/* — ссылка на счёт, возврат, автопродление,
    # выписка. Недоступен → 503 STARS_UNAVAILABLE
    botgw_url: str = "http://127.0.0.1:8108"
    botgw_timeout_seconds: float = Field(default=5.0, gt=0, le=30)
    # исходящие к провайдерам (Click Merchant API, Payme receipts.get_all, Uzum): таймаут, один повтор на сеть/5xx
    provider_timeout_seconds: float = Field(default=10.0, gt=0, le=60)
    # сайт оплаты: возврат покупателя с провайдера — {WEB_PAY_ORIGIN}/orders/{order_no}; в stage/prod — https
    web_pay_origin: str = "http://localhost:5175"
    # дни и месяцы отчётов (потолок ИИ — месяц UTC)
    timezone: str = "Asia/Tashkent"

    # ---- флаги запуска (§0.7; prod — всё выключено до ответов владельца и мерчантов)
    # не задан — по окружению: выключен в stage/prod, включён в dev/test (см. _payments_default)
    payments_enabled: bool = False
    stars_enabled: bool = False
    payme_enabled: bool = False
    click_enabled: bool = False
    uzum_enabled: bool = False
    trial_on_enforcement: bool = False

    # ---- Payme Merchant API (§1.6; что не подтверждено — §14 P1–P6)
    payme_merchant_id: str = ""
    payme_login: str = "Paycom"  # §14 P1: логин Basic по практике; сверить в песочнице
    payme_key: SecretStr = SecretStr("")  # ключ кассы (в песочнице — тестовый)
    payme_checkout_url: str = "https://checkout.paycom.uz"  # §14 P6: адрес тестовой среды задаётся переменной
    payme_allowed_cidrs: str = ""
    payme_subscribe_url: str = ""
    payme_subscribe_key: SecretStr = SecretStr("")  # необязателен: только сверка receipts.get_all

    # ---- Click SHOP API и Merchant API (§1.7; §14 C1–C4)
    click_service_id: str = ""
    click_merchant_id: str = ""
    click_merchant_user_id: str = ""
    click_secret_key: SecretStr = SecretStr("")
    click_pay_url: str = "https://my.click.uz/services/pay"
    click_api_url: str = "https://api.click.uz/v2/merchant"  # §14 C1: по практике; сверить
    click_allowed_cidrs: str = ""

    # ---- Uzum Merchant API (§1.8; за флагом до сверки спецификации — §14 U1, О7)
    uzum_service_id: str = ""
    uzum_login: str = ""
    uzum_password: SecretStr = SecretStr("")
    uzum_account_field: str = Field(default="order_id", pattern=r"^[A-Za-z_][A-Za-z0-9_]{0,39}$")
    uzum_checkout_url_template: str = ""  # {service_id}, {order_no}, {amount_tiyin}, {return_url}
    uzum_allowed_cidrs: str = ""

    # ---- входы
    # payments-edge → billing: заголовок X-Edge-Token (иначе 404); один токен у billing и payments-edge
    payments_edge_token: SecretStr = SecretStr("")
    # n8n billing-tick (5 мин) и billing-reconcile (сутки): Authorization: Bearer; пусто — вход выключен
    scheduler_token: SecretStr = SecretStr("")

    @field_validator(*SECRET_FIELDS, mode="before")
    @classmethod
    def _strip_secret(cls, v: object) -> object:
        return v.strip() if isinstance(v, str) else v

    @field_validator("payme_allowed_cidrs", "click_allowed_cidrs", "uzum_allowed_cidrs")
    @classmethod
    def _valid_cidrs(cls, v: str) -> str:
        try:
            _cidrs(v)
        except ValueError as exc:
            raise ValueError("ожидается список CIDR через запятую") from exc
        return v

    @field_validator("timezone")
    @classmethod
    def _tz(cls, v: str) -> str:
        try:
            ZoneInfo(v)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError(f"unknown timezone {v!r}") from exc
        return v

    @model_validator(mode="before")
    @classmethod
    def _payments_default(cls, data: Any) -> Any:
        if isinstance(data, dict) and data.get("payments_enabled") in (None, ""):
            env = str(data.get("env") or "dev").strip()
            data = {**data, "payments_enabled": env not in ("stage", "prod")}
        return data

    @model_validator(mode="after")
    def _guards(self) -> Settings:
        secure = self.is_secure_env
        for name in REQUIRED_URLS:
            value = str(getattr(self, name)).strip()
            if secure and (name not in self.model_fields_set or not value):
                raise ValueError(f"{name.upper()} is required in stage/prod")
            if not value.startswith(("http://", "https://")):
                raise ValueError(f"{name.upper()} must be an http(s) URL")
        if secure and not self.web_pay_origin.startswith("https://"):
            raise ValueError("WEB_PAY_ORIGIN must be https in stage/prod")
        for name in ("payments_edge_token", "scheduler_token"):
            secret: SecretStr = getattr(self, name)
            if secure and len(secret.get_secret_value()) < MIN_TOKEN_LEN:
                raise ValueError(f"{name.upper()} is required (>= {MIN_TOKEN_LEN} chars) in stage/prod")
        if secure:
            # флаг провайдера включён — ключи и реквизиты обязательны (§13): пустой ключ в stage/prod не стартует
            required: dict[str, tuple[str, ...]] = {
                "payme_enabled": ("payme_merchant_id", "payme_key", "payme_checkout_url"),
                "click_enabled": ("click_service_id", "click_merchant_id", "click_merchant_user_id",
                                  "click_secret_key", "click_pay_url"),
                "uzum_enabled": ("uzum_service_id", "uzum_login", "uzum_password", "uzum_checkout_url_template"),
            }
            for flag, fields in required.items():
                if not getattr(self, flag):
                    continue
                for field in fields:
                    value = getattr(self, field)
                    raw = value.get_secret_value() if isinstance(value, SecretStr) else str(value)
                    if not raw.strip():
                        raise ValueError(f"{field.upper()} is required when {flag.upper()}=true in stage/prod")
            for name in ("payme_checkout_url", "payme_subscribe_url", "click_pay_url", "click_api_url"):
                value = str(getattr(self, name))
                if value and not value.startswith("https://"):
                    raise ValueError(f"{name.upper()} must be https in stage/prod")
        return self

    def allowed_cidrs(self, provider: str) -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
        """Сети провайдера для проверки IP колбэка; пустой список — проверка выключена (В16)."""
        return _cidrs(str(getattr(self, f"{provider}_allowed_cidrs")))

    def provider_enabled(self, provider: str) -> bool:
        """Общий выключатель и флаг провайдера (telegram_stars — STARS_ENABLED)."""
        flag = "stars_enabled" if provider == "telegram_stars" else f"{provider}_enabled"
        return self.payments_enabled and bool(getattr(self, flag))


@lru_cache
def get_settings() -> Settings:
    return Settings()
