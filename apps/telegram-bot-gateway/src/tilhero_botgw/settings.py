from __future__ import annotations

import re
from functools import lru_cache
from urllib.parse import urlsplit

from pydantic import SecretStr, field_validator, model_validator

from tilhero_common.settings import ServiceSettings

_SECRET_RE = re.compile(r"[A-Za-z0-9_-]{1,256}")  # ограничение Telegram для secret_token
_TOKEN_RE = re.compile(r"\d{5,16}:[A-Za-z0-9_-]{30,64}")
# Прямая ссылка Mini App: https://t.me/<bot>/<app> (та же проверка, что в telegram-bff config.ts)
_APP_LINK_RE = re.compile(r"https://t\.me/[A-Za-z0-9_]{5,64}/[A-Za-z0-9_]{3,64}")


def _is_https(url: str | None) -> bool:
    if not url:
        return False
    parts = urlsplit(url)
    return parts.scheme == "https" and bool(parts.hostname)


class Settings(ServiceSettings):
    """Без БД: только Redis (идемпотентность update_id и отправок). Секреты — только из окружения."""

    service_name: str = "telegram-bot-gateway"
    port: int = 8107  # PORT — публичный (webhook Telegram + health)
    internal_port: int = 8108  # INTERNAL_PORT — внутренний API (только приватная сеть Railway)
    host: str = "::"  # HOST: `::` — dual-stack (приватная сеть Railway — IPv6)

    bot_token: SecretStr = SecretStr("")  # BOT_TOKEN — никогда не логируется (и в URL запросов тоже)
    telegram_webhook_secret: SecretStr = SecretStr("")  # TELEGRAM_WEBHOOK_SECRET
    telegram_webhook_url: str | None = None  # публичный https URL …/telegram/webhook (для setup)
    # Railway сам задаёт RAILWAY_PUBLIC_DOMAIN: если TELEGRAM_WEBHOOK_URL не задан, webhook = https://<домен>/telegram/webhook
    railway_public_domain: str | None = None
    # BOT_AUTO_SETUP=true: при каждом запуске идемпотентно настроить webhook, команду /start, кнопку меню и описания
    # (без drop_pending_updates) — шаг «выполнить setup в Shell» не нужен; ошибка Telegram не мешает старту.
    bot_auto_setup: bool = False
    miniapp_url: str = "https://localhost:5173"  # MINIAPP_URL — кнопки web_app
    # TELEGRAM_APP_LINK — прямая ссылка Mini App https://t.me/<bot>/<app> (как у social): с ней payload /start
    # (inv_…, gc_…, route_…) доходит до Mini App как start_param в initData. Пусто — кнопка web_app с ?startapp=.
    telegram_app_link: str | None = None
    telegram_api_base: str = "https://api.telegram.org"  # TELEGRAM_API_BASE (в тестах — мок)
    telegram_timeout_seconds: float = 5.0
    identity_consent_url: str = "http://127.0.0.1:8101"
    menu_button_text: str = "TilHero"

    redis_key_prefix: str = "botgw"
    update_ttl_seconds: int = 48 * 3600
    message_idempotency_ttl_seconds: int = 24 * 3600
    redis_timeout_seconds: float = 0.5  # webhook отвечает ≤ 1 с даже при деградации Redis
    chat_replies_per_minute: int = 20  # анти-спам: ответов бота в один чат в минуту
    max_update_bytes: int = 256 * 1024

    @field_validator("telegram_app_link", mode="before")
    @classmethod
    def _app_link(cls, value: object) -> object:
        if isinstance(value, str):
            value = value.strip().rstrip("/")
            if not value:
                return None
            if not _APP_LINK_RE.fullmatch(value):
                raise ValueError("TELEGRAM_APP_LINK: https://t.me/<bot>/<app> без параметров")
        return value

    @model_validator(mode="after")
    def _validate(self) -> Settings:
        if not self.telegram_webhook_url and self.railway_public_domain:
            self.telegram_webhook_url = f"https://{self.railway_public_domain.strip().rstrip('/')}/telegram/webhook"
        secret = self.telegram_webhook_secret.get_secret_value()
        if secret and not _SECRET_RE.fullmatch(secret):
            raise ValueError("TELEGRAM_WEBHOOK_SECRET: 1–256 символов A-Z a-z 0-9 _ -")
        if self.internal_port == self.port:
            raise ValueError("INTERNAL_PORT must differ from PORT: internal API must not be public")
        if self.is_secure_env:
            if not _TOKEN_RE.fullmatch(self.bot_token.get_secret_value()):
                raise ValueError("BOT_TOKEN must be set in prod")
            if len(secret) < 32:
                raise ValueError("TELEGRAM_WEBHOOK_SECRET must be >= 32 chars in prod")
            if not _is_https(self.miniapp_url):
                raise ValueError("MINIAPP_URL must be https in prod")
            if not self.redis_url:
                raise ValueError("REDIS_URL is required")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
