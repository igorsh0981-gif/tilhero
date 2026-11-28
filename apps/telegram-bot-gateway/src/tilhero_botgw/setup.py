"""Настройка бота в Telegram. В prod — автоматически при каждом запуске (BOT_AUTO_SETUP=true, см. auto_setup);
вручную — `python -m tilhero_botgw.setup` (со сбросом ожидающих обновлений).

setWebhook (url, secret_token, allowed_updates + pre_checkout_query и subscription, drop_pending_updates) →
setMyCommands: /start, /paysupport, /support, /terms (спринт 8, требование Telegram для продаж за Stars), RU/UZ
(+ по умолчанию RU) → setChatMenuButton (web_app на MINIAPP_URL) → setMyDescription / setMyShortDescription RU/UZ
(+ по умолчанию RU). TELEGRAM_TEST_ENV=true — всё в тестовой среде Telegram (…/bot<token>/test/<METHOD>).
Нужны BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_WEBHOOK_URL (https …/telegram/webhook),
MINIAPP_URL (https).
"""

from __future__ import annotations

import asyncio
import sys
from typing import Any

import httpx

from tilhero_botgw.settings import Settings, _is_https, get_settings
from tilhero_botgw.telegram import TelegramClient, TelegramError, silence_http_logging
from tilhero_botgw.texts import BOT_COMMANDS, DESCRIPTIONS, Lang

# Спринт 8 (Stars): pre_checkout_query и subscription (BotSubscriptionUpdated, Bot API 10.2) — явно: при заданном
# списке Telegram присылает только перечисленные типы; successful_payment и refunded_payment приходят в message
ALLOWED_UPDATES = ["message", "callback_query", "my_chat_member", "pre_checkout_query", "subscription"]
DEFAULT_LANG: Lang = "ru"  # язык по умолчанию (клиент Telegram без ru/uz)
LANGS: tuple[Lang, ...] = ("ru", "uz")


def plan(settings: Settings, *, drop_pending_updates: bool = True) -> list[tuple[str, dict[str, Any]]]:
    if not settings.bot_token.get_secret_value():
        raise ValueError("BOT_TOKEN не задан")
    if not settings.telegram_webhook_secret.get_secret_value():
        raise ValueError("TELEGRAM_WEBHOOK_SECRET не задан")
    if not _is_https(settings.telegram_webhook_url):
        raise ValueError("TELEGRAM_WEBHOOK_URL должен быть https-адресом …/telegram/webhook")
    if not _is_https(settings.miniapp_url):
        raise ValueError("MINIAPP_URL должен быть https-адресом Mini App")
    calls: list[tuple[str, dict[str, Any]]] = [
        (
            "setWebhook",
            {
                "url": settings.telegram_webhook_url,
                "secret_token": settings.telegram_webhook_secret.get_secret_value(),
                "allowed_updates": ALLOWED_UPDATES,
                "drop_pending_updates": drop_pending_updates,
                "max_connections": 40,
            },
        ),
        ("setMyCommands", {"commands": BOT_COMMANDS[DEFAULT_LANG]}),
    ]
    for lang in LANGS:
        calls.append(("setMyCommands", {"commands": BOT_COMMANDS[lang], "language_code": lang}))
    calls.append(
        (
            "setChatMenuButton",
            {
                "menu_button": {
                    "type": "web_app",
                    "text": settings.menu_button_text,
                    "web_app": {"url": settings.miniapp_url},
                }
            },
        )
    )
    calls.append(("setMyDescription", {"description": DESCRIPTIONS[DEFAULT_LANG]["description"]}))
    calls.append(("setMyShortDescription", {"short_description": DESCRIPTIONS[DEFAULT_LANG]["short"]}))
    for lang in LANGS:
        calls.append(
            ("setMyDescription", {"description": DESCRIPTIONS[lang]["description"], "language_code": lang})
        )
        calls.append(
            (
                "setMyShortDescription",
                {"short_description": DESCRIPTIONS[lang]["short"], "language_code": lang},
            )
        )
    return calls


async def run_setup(
    settings: Settings,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    drop_pending_updates: bool = True,
) -> list[str]:
    calls = plan(settings, drop_pending_updates=drop_pending_updates)
    client = TelegramClient(
        settings.bot_token.get_secret_value(),
        api_base=settings.telegram_api_base,
        timeout=settings.telegram_timeout_seconds,
        transport=transport,
        test_env=settings.telegram_test_env,
    )
    done: list[str] = []
    try:
        for method, payload in calls:
            await client.call(method, payload)
            done.append(method + (f"[{payload['language_code']}]" if "language_code" in payload else ""))
    finally:
        await client.aclose()
    return done


AUTO_SETUP_TIMEOUT_SECONDS = 20.0  # старт не ждёт Telegram дольше (healthcheck Railway — 60 с)


def auto_setup(settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None) -> bool:
    """Автонастройка при старте (BOT_AUTO_SETUP=true): ожидающие обновления не сбрасываются,
    ошибки только логируются (без токена) — сервис стартует в любом случае."""
    import logging

    log = logging.getLogger("tilhero_botgw.setup")
    try:
        done = asyncio.run(
            asyncio.wait_for(
                run_setup(settings, transport=transport, drop_pending_updates=False),
                timeout=AUTO_SETUP_TIMEOUT_SECONDS,
            )
        )
    except ValueError as exc:
        log.error("bot auto-setup skipped: %s", exc)
        return False
    except TelegramError as exc:
        log.error("bot auto-setup failed: Telegram %s: %s", exc.status, exc.description)
        return False
    except TimeoutError:
        log.error("bot auto-setup failed: timeout %.0fs", AUTO_SETUP_TIMEOUT_SECONDS)
        return False
    except Exception as exc:  # сеть и прочее: старт важнее настройки
        log.error("bot auto-setup failed: %s", type(exc).__name__)
        return False
    log.info("bot auto-setup ok: %d calls", len(done))
    return True


def main() -> int:
    silence_http_logging()
    try:
        done = asyncio.run(run_setup(get_settings()))
    except ValueError as exc:
        print(f"setup: {exc}", file=sys.stderr)
        return 2
    except TelegramError as exc:
        # description уже очищен от токена (TelegramClient.scrub)
        print(f"setup: Telegram ответил {exc.status}: {exc.description}", file=sys.stderr)
        return 1
    for step in done:
        print(f"ok {step}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
