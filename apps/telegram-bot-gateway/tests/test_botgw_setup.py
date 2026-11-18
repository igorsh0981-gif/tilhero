"""python -m tilhero_botgw.setup: webhook, команда /start RU/UZ, кнопка меню, описания RU/UZ; валидация настроек."""

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
        "setMyCommands[uz]",
        "setChatMenuButton",
        "setMyDescription",
        "setMyShortDescription",
        "setMyDescription[ru]",
        "setMyShortDescription[ru]",
        "setMyDescription[uz]",
        "setMyShortDescription[uz]",
    ]
    calls = dict(tg.calls[:1])
    assert calls["setWebhook"] == {
        "url": WEBHOOK,
        "secret_token": SECRET,
        "drop_pending_updates": True,
        "allowed_updates": ["message", "callback_query", "my_chat_member"],
        "max_connections": 40,
    }
    assert tg.calls[1][1] == {"commands": [{"command": "start", "description": "Открыть TilHero"}]}  # по умолчанию RU
    ru_commands, uz_commands = tg.calls[2][1], tg.calls[3][1]
    assert ru_commands == {"commands": [{"command": "start", "description": "Открыть TilHero"}], "language_code": "ru"}
    assert uz_commands == {
        "commands": [{"command": "start", "description": "TilHeroʼni ochish"}],
        "language_code": "uz",
    }
    menu = tg.calls[4][1]["menu_button"]
    assert menu == {"type": "web_app", "text": "TilHero", "web_app": {"url": MINIAPP}}
    ru_desc, uz_desc = tg.calls[7][1], tg.calls[9][1]
    assert ru_desc["language_code"] == "ru" and "мини-приложении" in ru_desc["description"]
    assert uz_desc["language_code"] == "uz" and "mini-ilovada" in uz_desc["description"]
    for _, body in tg.calls:  # ничего туристического
        assert not any(w in str(body).lower() for w in ("событи", "поездк", "билет", "отель", "event", "trip"))
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


def test_miniapp_url_required_and_not_local_in_secure_env(monkeypatch) -> None:
    """P-12: забытый MINIAPP_URL в stage/prod не подменяется localhost — сервис не стартует; localhost и петлевые
    адреса запрещены; в dev/test по умолчанию — локальный Vite."""
    monkeypatch.delenv("MINIAPP_URL", raising=False)
    prod = {"internal_jwt_secret": "p" * 40, "internal_jwt_private_key": "A" * 43, "bot_token": TOKEN,
            "telegram_webhook_secret": SECRET, "redis_url": "redis://r"}
    for env_name in ("stage", "prod"):
        with pytest.raises(ValidationError, match="MINIAPP_URL must be set"):
            Settings(env=env_name, **prod)
        with pytest.raises(ValidationError, match="MINIAPP_URL must be set"):
            Settings(env=env_name, miniapp_url="  ", **prod)
        for local in ("https://localhost:5173", "https://LOCALHOST/app", "https://app.localhost/",
                      "https://127.0.0.1:5173", "https://127.1.2.3/", "https://[::1]:5173/", "https://0.0.0.0/"):
            with pytest.raises(ValidationError, match="localhost"):
                Settings(env=env_name, miniapp_url=local, **prod)
        with pytest.raises(ValidationError, match="https"):
            Settings(env=env_name, miniapp_url="http://app.tilhero.test", **prod)
        assert Settings(env=env_name, miniapp_url=MINIAPP, **prod).miniapp_url == MINIAPP
    for env_name in ("dev", "test"):
        assert Settings(env=env_name).miniapp_url == "https://localhost:5173"
    monkeypatch.setenv("MINIAPP_URL", "https://app.tilhero.uz/")
    assert Settings(env="prod", **prod).miniapp_url == "https://app.tilhero.uz/"
