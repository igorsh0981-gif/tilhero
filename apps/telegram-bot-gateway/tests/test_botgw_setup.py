"""python -m tilhero_botgw.setup: webhook, команды RU/EN, кнопка меню, описания; валидация настроек."""

from __future__ import annotations

import httpx
import pytest
from botgw_testkit import MINIAPP, SECRET, TOKEN, FakeTelegram, make_settings
from pydantic import ValidationError

from tilhero_botgw import setup as botgw_setup
from tilhero_botgw.settings import Settings
from tilhero_botgw.telegram import TelegramError

WEBHOOK = "https://bot.tilhero.test/telegram/webhook"


async def test_setup_configures_bot() -> None:
    tg = FakeTelegram()
    settings = make_settings("t_setup", telegram_webhook_url=WEBHOOK)
    done = await botgw_setup.run_setup(settings, transport=httpx.MockTransport(tg.handler))
    assert done == [
        "setWebhook",
        "setMyCommands",
        "setMyCommands[ru]",
        "setMyCommands[en]",
        "setChatMenuButton",
        "setMyDescription",
        "setMyShortDescription",
        "setMyDescription[ru]",
        "setMyShortDescription[ru]",
        "setMyDescription[en]",
        "setMyShortDescription[en]",
    ]
    calls = dict(tg.calls[:1])
    assert calls["setWebhook"] == {
        "url": WEBHOOK,
        "secret_token": SECRET,
        "drop_pending_updates": True,
        "allowed_updates": ["message", "callback_query", "my_chat_member"],
        "max_connections": 40,
    }
    ru_commands = tg.calls[2][1]
    assert ru_commands["language_code"] == "ru"
    assert [c["command"] for c in ru_commands["commands"]] == ["start", "events", "watch", "support", "help"]
    assert ru_commands["commands"][1]["description"] == "Каталог событий"
    menu = tg.calls[4][1]["menu_button"]
    assert menu == {"type": "web_app", "text": "TilHero", "web_app": {"url": MINIAPP}}
    ru_desc = tg.calls[7][1]
    assert ru_desc["language_code"] == "ru" and "мини-приложении" in ru_desc["description"]
    assert all(len(body.get("short_description", "")) <= 120 for _, body in tg.calls)
    assert all(len(body.get("description", "")) <= 512 for _, body in tg.calls)
    assert tg.tokens_seen == {TOKEN}


@pytest.mark.parametrize(
    "overrides",
    [
        {"telegram_webhook_url": None},
        {"telegram_webhook_url": "http://bot.tilhero.test/telegram/webhook"},
        {"telegram_webhook_url": WEBHOOK, "miniapp_url": "http://app.test"},
        {"telegram_webhook_url": WEBHOOK, "bot_token": ""},
        {"telegram_webhook_url": WEBHOOK, "telegram_webhook_secret": ""},
    ],
)
async def test_setup_validates_config(overrides) -> None:
    tg = FakeTelegram()
    with pytest.raises(ValueError):
        await botgw_setup.run_setup(
            make_settings("t_setup", **overrides), transport=httpx.MockTransport(tg.handler)
        )
    assert tg.calls == []


async def test_setup_reports_telegram_error_without_token() -> None:
    tg = FakeTelegram()
    tg.queue.append((400, {"ok": False, "error_code": 400, "description": f"bad webhook for bot{TOKEN}"}))
    with pytest.raises(TelegramError) as info:
        await botgw_setup.run_setup(
            make_settings("t_setup", telegram_webhook_url=WEBHOOK), transport=httpx.MockTransport(tg.handler)
        )
    assert TOKEN not in info.value.description and len(tg.calls) == 1


def test_main_exit_codes(monkeypatch, capsys) -> None:
    monkeypatch.setattr(
        botgw_setup, "get_settings", lambda: make_settings("t_setup", telegram_webhook_url=None)
    )
    assert botgw_setup.main() == 2
    assert "TELEGRAM_WEBHOOK_URL" in capsys.readouterr().err


def test_settings_validation() -> None:
    prod = {"internal_jwt_secret": "p" * 40, "internal_jwt_private_key": "A" * 43}
    with pytest.raises(ValidationError):
        Settings(telegram_webhook_secret="bad secret with spaces")
    with pytest.raises(ValidationError):  # internal API на публичном порту — запрещено (ревью P1)
        Settings(env="test", port=8107, internal_port=8107)
    with pytest.raises(ValidationError):  # prod без токена
        Settings(env="prod", telegram_webhook_secret=SECRET, redis_url="redis://r", **prod)
    with pytest.raises(ValidationError):  # prod с коротким секретом
        Settings(
            env="prod",
            bot_token=TOKEN,
            telegram_webhook_secret="short",
            miniapp_url=MINIAPP,
            redis_url="redis://r",
            **prod,
        )
    with pytest.raises(ValidationError):  # stage — те же требования, что и prod
        Settings(env="stage", telegram_webhook_secret=SECRET, redis_url="redis://r", **prod)
    full = {"bot_token": TOKEN, "telegram_webhook_secret": SECRET, "miniapp_url": MINIAPP, "redis_url": "redis://r"}
    with pytest.raises(ValidationError):  # prod требует личный ключ внутреннего JWT (EdDSA)
        Settings(env="prod", internal_jwt_secret="p" * 40, **full)
    ok = Settings(env="prod", **full, **prod)
    assert TOKEN not in repr(ok) and SECRET not in repr(ok) and "A" * 43 not in repr(ok)
    assert (ok.port, ok.internal_port) == (8107, 8108)


def test_webhook_url_from_railway_public_domain() -> None:
    s = make_settings("t_setup", telegram_webhook_url=None, railway_public_domain="botgw.up.railway.app")
    assert s.telegram_webhook_url == "https://botgw.up.railway.app/telegram/webhook"
    explicit = make_settings("t_setup", telegram_webhook_url=WEBHOOK, railway_public_domain="other.app")
    assert explicit.telegram_webhook_url == WEBHOOK


def test_auto_setup_keeps_pending_updates() -> None:
    tg = FakeTelegram()
    settings = make_settings("t_setup", telegram_webhook_url=WEBHOOK)
    assert botgw_setup.auto_setup(settings, transport=httpx.MockTransport(tg.handler)) is True
    assert tg.calls[0][0] == "setWebhook" and tg.calls[0][1]["drop_pending_updates"] is False
    assert len(tg.calls) == 11


def test_auto_setup_never_raises(caplog) -> None:
    tg = FakeTelegram()
    tg.queue.append((401, {"ok": False, "error_code": 401, "description": f"Unauthorized bot{TOKEN}"}))
    settings = make_settings("t_setup", telegram_webhook_url=WEBHOOK)
    assert botgw_setup.auto_setup(settings, transport=httpx.MockTransport(tg.handler)) is False
    assert TOKEN not in caplog.text
    tg2 = FakeTelegram()
    tg2.queue.append(httpx.ConnectError("down"))
    assert botgw_setup.auto_setup(settings, transport=httpx.MockTransport(tg2.handler)) is False
    assert botgw_setup.auto_setup(make_settings("t_setup", telegram_webhook_url=None)) is False


def test_auto_setup_times_out(monkeypatch) -> None:
    import asyncio

    async def slow(*_a, **_k):
        await asyncio.sleep(5)

    monkeypatch.setattr(botgw_setup, "run_setup", slow)
    monkeypatch.setattr(botgw_setup, "AUTO_SETUP_TIMEOUT_SECONDS", 0.05)
    assert botgw_setup.auto_setup(make_settings("t_setup", telegram_webhook_url=WEBHOOK)) is False
