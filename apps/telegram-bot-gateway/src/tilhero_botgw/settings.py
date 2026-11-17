from __future__ import annotations

import re
from functools import lru_cache
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator, model_validator

from tilhero_common.settings import ServiceSettings

_SECRET_RE = re.compile(r"^[A-Za-z0-9_-]{1,256}$")  # ограничение Telegram для secret_token
_TOKEN_RE = re.compile(r"^\d{5,16}:[A-Za-z0-9_-]{30,64}$")


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
    # BOT_AUTO_SETUP=true: при каждом запуске идемпотентно настроить webhook, команды, кнопку меню и описания
    # (без drop_pending_updates) — шаг «выполнить setup в Shell» не нужен; ошибка Telegram не мешает старту.
    bot_auto_setup: bool = False
    miniapp_url: str = "https://localhost:5173"  # MINIAPP_URL
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

    # Спринт 8 (INTERNAL_API §6): чат операторов — только из env, вызывающий чат не выбирает.
    # OPS_ALERT_CHAT_ID: целое (группа — отрицательное); пусто — оповещения выключены (409 OPS_CHAT_NOT_CONFIGURED).
    ops_alert_chat_id: int | None = None
    # ADMIN_WEB_URL: кнопка «Открыть мониторинг» — только https на этом домене
    admin_web_url: str | None = None
    # спринт 9: кнопка «Runbook» в ops-сообщениях — только ссылки с этим префиксом (https)
    runbook_base_url: str = "https://github.com/igorsh0981-gif/tilhero/blob/main/docs/runbooks/"
    ops_messages_per_minute: int = Field(default=20, ge=1, le=60)  # OPS_MESSAGES_PER_MINUTE (лимит групп Telegram)

    @field_validator("ops_alert_chat_id", "admin_web_url", mode="before")
    @classmethod
    def _empty_is_none(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            return None
        return value.strip() if isinstance(value, str) else value

    @property
    def admin_web_host(self) -> str | None:
        """Домен кнопок ops-сообщений; None — ADMIN_WEB_URL не задан или не https (кнопка не отправляется)."""
        if not _is_https(self.admin_web_url):
            return None
        return (urlsplit(self.admin_web_url or "").hostname or "").lower() or None

    @model_validator(mode="after")
    def _validate(self) -> Settings:
        if not self.telegram_webhook_url and self.railway_public_domain:
            self.telegram_webhook_url = f"https://{self.railway_public_domain.strip().rstrip('/')}/telegram/webhook"
        secret = self.telegram_webhook_secret.get_secret_value()
        if secret and not _SECRET_RE.match(secret):
            raise ValueError("TELEGRAM_WEBHOOK_SECRET: 1–256 символов A-Z a-z 0-9 _ -")
        if self.internal_port == self.port:
            raise ValueError("INTERNAL_PORT must differ from PORT: internal API must not be public")
        if self.ops_alert_chat_id == 0:
            raise ValueError("OPS_ALERT_CHAT_ID: ненулевое целое (id группы — отрицательное) или пусто")
        if self.admin_web_url and not _is_https(self.admin_web_url) and self.is_secure_env:
            raise ValueError("ADMIN_WEB_URL must be https in prod")
        if self.is_secure_env:
            if not _TOKEN_RE.match(self.bot_token.get_secret_value()):
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
