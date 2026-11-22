"""Каркас billing (поток 0): настройки и проверки stage/prod, health, миграции под ролями billing_owner / billing,
протокол адаптера и порт платежей, деньги — только целые (ADR-0001)."""

from __future__ import annotations

import ast
import dataclasses
import re
import typing
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from conftest import EDGE_TOKEN, SCHEDULER_TOKEN, SERVICE_DIR, make_settings
from pydantic import SecretStr, ValidationError

from tilhero_billing.domain import ports
from tilhero_billing.main import build_app
from tilhero_billing.providers import base
from tilhero_billing.settings import Settings
from tilhero_common.app import Runtime
from tilhero_common.testing import ddl_allowed_for, migrated_under_roles

PKG = Path(SERVICE_DIR) / "src" / "tilhero_billing"
PROD_KEYS = {"internal_jwt_secret": "p" * 48, "internal_jwt_private_key": "k" * 43}
PROD_URLS = {"identity_consent_url": "http://identity-consent.railway.internal:8101",
             "gamification_url": "http://gamification.railway.internal:8117",
             "botgw_url": "http://telegram-bot-gateway.railway.internal:8108",
             "web_pay_origin": "https://pay.example.uz"}


def prod(**kw: Any) -> Settings:
    return Settings(**{"env": "prod", **PROD_KEYS, **PROD_URLS, "scheduler_token": SCHEDULER_TOKEN,
                       "payments_edge_token": EDGE_TOKEN, **kw})


# ---------------------------------------------------------------- настройки

def test_dev_defaults_and_flags() -> None:
    s = make_settings()
    assert s.service_name == "billing" and s.port == 8118 and s.db_schema == "billing"
    assert s.payments_enabled is True  # dev/test — включён, stage/prod — выключен (§0.7)
    assert not (s.stars_enabled or s.payme_enabled or s.click_enabled or s.uzum_enabled or s.trial_on_enforcement)
    assert not s.provider_enabled("payme") and not s.provider_enabled("telegram_stars")
    assert make_settings(stars_enabled=True).provider_enabled("telegram_stars")
    assert not make_settings(stars_enabled=True, payments_enabled=False).provider_enabled("telegram_stars")
    assert s.botgw_url.endswith(":8108") and s.timezone == "Asia/Tashkent"
    assert s.allowed_cidrs("payme") == []  # пусто — проверка IP выключена (В16)
    cidrs = make_settings(click_allowed_cidrs="10.0.0.0/8, 2001:db8::/32").allowed_cidrs("click")
    assert [str(c) for c in cidrs] == ["10.0.0.0/8", "2001:db8::/32"]
    with pytest.raises(ValidationError):
        make_settings(uzum_allowed_cidrs="not-a-network")


def test_prod_defaults_off_and_required_values() -> None:
    s = prod()
    assert s.payments_enabled is False and not s.provider_enabled("telegram_stars")
    assert prod(payments_enabled=True).payments_enabled is True
    for name in PROD_URLS:
        urls = {k: v for k, v in PROD_URLS.items() if k != name}
        with pytest.raises(ValidationError, match=name.upper()):
            Settings(env="prod", **PROD_KEYS, **urls, scheduler_token=SCHEDULER_TOKEN, payments_edge_token=EDGE_TOKEN)
    with pytest.raises(ValidationError, match="WEB_PAY_ORIGIN must be https"):
        prod(web_pay_origin="http://pay.example.uz")
    for name in ("payments_edge_token", "scheduler_token"):
        with pytest.raises(ValidationError, match=name.upper()):
            prod(**{name: "short"})


@pytest.mark.parametrize("flag,fields", [
    ("payme_enabled", {"payme_merchant_id": "test-merchant", "payme_key": "test-payme-key"}),
    ("click_enabled", {"click_service_id": "1", "click_merchant_id": "2", "click_merchant_user_id": "3",
                       "click_secret_key": "test-click-secret"}),
    ("uzum_enabled", {"uzum_service_id": "1", "uzum_login": "test-login", "uzum_password": "test-uzum-password",
                      "uzum_checkout_url_template": "https://checkout.example/{order_no}"}),
])
def test_prod_provider_flag_requires_keys(flag: str, fields: dict[str, str]) -> None:
    """В stage/prod флаг провайдера при пустом ключе или реквизитах — сервис не стартует (§13); значения ключей не
    попадают в текст ошибки и repr."""
    assert prod(**{flag: True}, **fields)
    for missing in fields:
        rest = {k: v for k, v in fields.items() if k != missing}
        with pytest.raises(ValidationError, match=missing.upper()) as err:
            prod(**{flag: True}, **rest)
        for value in fields.values():
            if "test-" in value and len(value) > 8:
                assert value not in str(err.value)
    # dev/test — без ключей (симуляторы)
    assert make_settings(**{flag: True})


def test_secrets_are_secretstr_and_hidden() -> None:
    s = make_settings(payme_key="test-payme-key-XYZ", click_secret_key="test-click-secret-XYZ",
                      uzum_password="test-uzum-password-XYZ")
    for name in ("payme_key", "payme_subscribe_key", "click_secret_key", "uzum_password", "payments_edge_token",
                 "scheduler_token"):
        assert isinstance(getattr(s, name), SecretStr), name
    text = repr(s) + str(s.model_dump())
    for value in ("test-payme-key-XYZ", "test-click-secret-XYZ", "test-uzum-password-XYZ", EDGE_TOKEN):
        assert value not in text
    # токена бота у billing нет (только bot-gateway и telegram-bff — INTERNAL_API §0.8)
    assert not any("bot_token" in f for f in Settings.model_fields)
    with pytest.raises(ValidationError) as err:
        prod(payme_enabled=True, payme_key="test-payme-key-XYZ")
    assert "test-payme-key-XYZ" not in str(err.value)


# ---------------------------------------------------------------- health и миграции под ролями

async def test_health_without_dependencies() -> None:
    settings = make_settings(redis_url=None)
    app = build_app(settings, Runtime(settings))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://billing") as c:
            assert (await c.get("/health/live")).json() == {"status": "ok"}
            r = await c.get("/health/ready")
            assert r.status_code == 200 and r.json()["status"] == "ok"
            assert set(app.state.runtime.clients) == {"identity-consent", "gamification", "telegram-bot-gateway"}


async def test_migrations_under_owner_runtime_without_ddl() -> None:
    """Alembic идёт под billing_owner (MIGRATION_DATABASE_URL); сервис — под billing (DATABASE_URL) без DDL: в схеме
    ничего не создаёт и не может снять триггеры неизменяемости (их добавит миграция 0001 потока A)."""
    async with migrated_under_roles(SERVICE_DIR, make_settings, "bill_roles") as (settings, roles):
        assert settings.database_url == roles.runtime_url and settings.migration_database_url == roles.owner_url
        assert await ddl_allowed_for(roles.runtime_url, roles.schema, "orders") == []
        app = build_app(settings, Runtime(settings))
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://billing") as c:
                r = await c.get("/health/ready")
                assert r.status_code == 200, r.text
                assert r.json()["checks"]["db"] == "ok"


def test_alembic_scripts_dir_and_env() -> None:
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
    script = ScriptDirectory.from_config(cfg)
    # каркас: миграций нет (0001 со всеми таблицами §1.1 — поток A); одна голова после её появления
    assert len(script.get_heads()) <= 1
    env = (Path(SERVICE_DIR) / "migrations" / "env.py").read_text()
    assert "messaging_metadata" in env and "tilhero_billing.models" in env


# ---------------------------------------------------------------- протокол адаптера и порт платежей

class _FakeAdapter:
    code: base.ProviderCode = "payme"

    def enabled(self) -> bool:
        return True

    async def checkout(self, order: base.OrderView, *, locale: str, return_url: str | None) -> base.Checkout:
        return base.Checkout(kind="redirect", url="https://checkout.example/")

    async def handle(self, call: base.InboundCall, payments: ports.PaymentPort) -> base.OutboundResponse:
        return base.OutboundResponse(status_code=200, body={"jsonrpc": "2.0", "id": 1, "result": {}}, result_code="0")

    async def refund(self, txn: base.TxnView, *, account_id: UUID | None) -> base.RefundOutcome:
        return base.RefundOutcome(kind="manual", instruction={"provider": "payme"})

    async def fiscalize(self, txn: base.TxnView, order: base.OrderView) -> base.FiscalOutcome:
        return base.FiscalOutcome(kind="no_op")

    async def remote_status(self, since: datetime) -> list[base.RemoteRecord] | None:
        return None


def test_adapter_protocol_and_channels() -> None:
    assert isinstance(_FakeAdapter(), base.ProviderAdapter)
    assert not isinstance(object(), base.ProviderAdapter)
    assert set(typing.get_args(base.ProviderCode)) == set(base.PROVIDERS)
    assert base.CHANNEL_PROVIDERS == {"miniapp": ("telegram_stars",), "renewal": ("telegram_stars",),
                                      "web": ("payme", "click", "uzum")}
    assert base.STARS_SUBSCRIPTION_PERIOD_SECONDS == 2_592_000 and base.STARS_SUBSCRIPTION_MAX_PRICE == 10_000
    now = datetime.now(UTC)
    order = base.OrderView(order_id=uuid4(), order_no=100001, channel="web", status="pending", product_code="plus_30d",
                           product_kind="subscription", title={"ru": "Плюс", "uz": "Plus"}, description=None,
                           stars_title=None, provider="payme", currency="UZS", amount_tiyin=4_900_000,
                           amount_stars=None, stars_mode=None, invoice_link=None, locale="ru", expires_at=now,
                           created_at=now)
    with pytest.raises(dataclasses.FrozenInstanceError):
        order.amount_tiyin = 1  # type: ignore[misc]


def test_payment_port_operations_and_errors() -> None:
    ops = {"check", "create", "perform", "paid", "cancel", "refunded", "stars_subscription_state", "get", "statement",
           "store_fiscal"}
    assert ops <= set(dir(ports.PaymentPort))
    errors = [c for c in vars(ports).values() if isinstance(c, type) and issubclass(c, ports.PaymentError)]
    names = {c.__name__ for c in errors}
    assert {"OrderNotFound", "OrderClosed", "AlreadyPaid", "AmountMismatch", "OrderBusy", "PayerMismatch",
            "PaymentsDisabled", "TxnNotFound", "TxnTimedOut", "InvalidState", "SubscriptionNotFound",
            "ReceiptTxnNotFound"} <= names
    codes = [c.code for c in errors]
    assert len(codes) == len(set(codes))


# ---------------------------------------------------------------- деньги — только целые (ADR-0001)

MONEY_WORDS = ("amount", "price", "tiyin", "stars")


def _money_annotations() -> list[tuple[str, str, str]]:
    out = []
    for path in PKG.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                name = node.target.id
                if any(w in name.lower() for w in MONEY_WORDS):
                    out.append((path.name, name, ast.unparse(node.annotation)))
            elif isinstance(node, ast.arg) and node.annotation is not None:
                if any(w in node.arg.lower() for w in MONEY_WORDS):
                    out.append((path.name, node.arg, ast.unparse(node.annotation)))
    return out


def test_money_is_integer_only() -> None:
    """Нет float, Decimal и NUMERIC для денег: суммы — int (тийины и Stars) в коде, BIGINT / INTEGER в миграциях."""
    numeric = re.compile(r"\bNumeric\s*\(|\bNUMERIC\s*\(|\bDECIMAL\s*\(", re.IGNORECASE)
    for path in [*PKG.rglob("*.py"), *(Path(SERVICE_DIR) / "migrations").rglob("*.py")]:
        text = path.read_text(encoding="utf-8")
        assert "import decimal" not in text and "from decimal" not in text, path.name
        assert not numeric.search(text), path.name
    found = _money_annotations()
    assert ("base.py", "amount_tiyin", "int | None") in found and ("ports.py", "amount", "int") in found
    for file, name, ann in found:
        assert "float" not in ann and "Decimal" not in ann, (file, name, ann)
