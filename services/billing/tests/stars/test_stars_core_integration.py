"""Stars через ядро billing (поток A): маршруты /internal/v1/stars/* → адаптер → настоящий `PaymentService` →
миграция 0001 в PostgreSQL (роли billing_owner / billing). Проверяет стык G ↔ A: журнал pre-checkout по query_id,
первый платёж подписки → период до subscription_expiration_date и подписка Stars, повтор charge id без второй выдачи,
продление → заказ renewal, обновление subscription, refunded_payment, «зафиксированные» ошибки → 2xx, provider_calls."""

from __future__ import annotations

import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from sqlalchemy import func, select
from stars_testkit import ACCOUNT, OTHER_ACCOUNT, FakeBotGateway, make_settings

from tilhero_billing.api import stars as stars_api
from tilhero_billing.clients import BOTGW
from tilhero_billing.main import build_app
from tilhero_common.app import Runtime
from tilhero_common.testing import internal_headers, migrated_under_roles

models = pytest.importorskip("tilhero_billing.models")
pytest.importorskip("tilhero_billing.domain.payments")
if not hasattr(models, "Order"):  # миграция и модели ядра ещё не сданы
    pytest.skip("billing core models are not ready", allow_module_level=True)

SERVICE_DIR = str(__import__("pathlib").Path(__file__).resolve().parents[2])


def _settings(**kw: Any):
    return make_settings(stand_catalog_on_start=False, **kw)


async def _order(rt: Runtime, *, mode: str = "subscription", amount: int = 250, account: uuid.UUID = ACCOUNT,
                 ttl: timedelta = timedelta(hours=1)) -> str:
    now = datetime.now(UTC)
    oid = uuid.uuid4()
    async with rt.transaction() as db:
        db.add(models.Order(
            order_id=oid, account_id=account, beneficiary_id=account, channel="miniapp",
            product_code="plus_30d" if mode == "subscription" else "til_100",
            product_kind="subscription" if mode == "subscription" else "til_pack", catalog_version=1,
            product_snapshot={"days": 30, "minutes": 300, "features": ["ai_lessons", "pair_lessons"], "til": 100,
                              "title": {"ru": "TilHero Плюс", "uz": "TilHero Plus"}},
            provider="telegram_stars", currency="XTR", amount_tiyin=None, amount_stars=amount, stars_mode=mode,
            status="pending", offer_version="1.0", locale="ru", idempotency_key=f"t-{oid}",
            expires_at=now + ttl, created_at=now))
    return f"o:{oid}"


async def _count(rt: Runtime, model: Any, *where: Any) -> int:
    async with rt.transaction() as db:
        return int(await db.scalar(select(func.count()).select_from(model).where(*where)) or 0)


class _Billing:
    def __init__(self, settings: Any, rt: Runtime, client: httpx.AsyncClient) -> None:
        self.settings, self.rt, self.client = settings, rt, client
        self.h = internal_headers(settings, issuer="telegram-bot-gateway")

    async def post(self, path: str, body: dict[str, Any]) -> httpx.Response:
        return await self.client.post(f"/internal/v1/stars/{path}", json=body, headers=self.h)


@asynccontextmanager
async def _core(prefix: str):
    async with migrated_under_roles(SERVICE_DIR, _settings, prefix) as (settings, _roles):
        rt = Runtime(settings)
        # payment_port не задан: маршрут берёт PaymentService ядра по умолчанию
        app = build_app(settings, rt, transports={BOTGW: FakeBotGateway().transport()}, routers=[stars_api.router])
        async with app.router.lifespan_context(app):
            transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
            async with httpx.AsyncClient(transport=transport, base_url="http://billing") as c:
                yield _Billing(settings, rt, c)


def _payment(ref: str, charge: str, *, amount: int = 250, recurring: bool = False, first: bool = False,
             expires: datetime | None = None) -> dict[str, Any]:
    return {"telegram_payment_charge_id": charge, "account_id": str(ACCOUNT), "currency": "XTR",
            "total_amount": amount, "invoice_payload": ref, "is_recurring": recurring, "is_first_recurring": first,
            "subscription_expiration_date": expires.isoformat() if expires else None,
            "paid_at": datetime.now(UTC).isoformat()}


async def test_one_time_stars_purchase_through_core() -> None:
    async with _core("bill_stars1") as b:
        rt = b.rt
        ref = await _order(rt, mode="one_time", amount=15)
        pc = {"query_id": "pcq-int-1", "account_id": str(ACCOUNT), "currency": "XTR", "total_amount": 15,
              "invoice_payload": ref}

        # pre-checkout: ок, чужой плательщик, неверная сумма, заказ не найден; повтор query_id — тот же ответ
        r = await b.post("pre-checkout", pc)
        assert r.status_code == 200 and r.json() == {"ok": True}, r.text
        assert (await b.post("pre-checkout", {**pc, "query_id": "pcq-int-2", "account_id": str(OTHER_ACCOUNT)})
                ).json() == {"ok": False, "error": "payer_mismatch"}
        assert (await b.post("pre-checkout", {**pc, "query_id": "pcq-int-3", "total_amount": 1})).json() == {
            "ok": False, "error": "amount_mismatch"}
        assert (await b.post("pre-checkout", {**pc, "query_id": "pcq-int-4", "invoice_payload": f"o:{uuid.uuid4()}"})
                ).json() == {"ok": False, "error": "order_not_found"}
        assert (await b.post("pre-checkout", pc)).json() == {"ok": True, "replayed": True}
        assert await _count(rt, models.StarsPreCheckout) == 4

        # платёж ×2 → одна транзакция, заказ paid (тилы — подтверждение gamification); повторный pre-checkout — оплачен
        for _ in range(2):
            r = await b.post("payments", _payment(ref, "stxINT-once", amount=15))
            assert r.status_code == 200 and r.json() == {"ok": True}, r.text
        assert await _count(rt, models.ProviderTransaction) == 1
        async with rt.transaction() as db:
            order = await db.scalar(select(models.Order).where(models.Order.order_id == uuid.UUID(ref[2:])))
        assert order is not None and order.status == "paid"
        assert (await b.post("pre-checkout", {**pc, "query_id": "pcq-int-5"})).json() == {
            "ok": False, "error": "already_paid"}

        # платёж по неизвестному заказу — 2xx (ядро записало пункт сверки), Telegram не повторяет
        lost = await b.post("payments", _payment(f"o:{uuid.uuid4()}", "stxINT-lost"))
        assert lost.status_code == 200 and lost.json()["reconciliation"] == "ORDER_NOT_FOUND"
        kinds = {k for (k,) in await _rows(rt, select(models.ReconciliationItem.kind))}
        assert "unmatched_settlement" in kinds

        # refunded_payment → транзакция refunded (повтор — без изменений); неизвестный charge — 409 (повтор Telegram)
        back = {"telegram_payment_charge_id": "stxINT-once", "total_amount": 15, "invoice_payload": ref}
        assert (await b.post("refunds-received", back)).status_code == 200
        assert (await b.post("refunds-received", back)).status_code == 200
        async with rt.transaction() as db:
            state = await db.scalar(select(models.ProviderTransaction.state).where(
                models.ProviderTransaction.provider_txn_id == "stxINT-once"))
        assert state == "refunded"
        unknown = await b.post("refunds-received", {**back, "telegram_payment_charge_id": "stxINT-none"})
        assert unknown.status_code == 409 and unknown.json()["code"] == "STARS_TXN_NOT_FOUND"

        # журнал provider_calls — входящие обновления (метаданные, без тел)
        assert await _count(rt, models.ProviderCall, models.ProviderCall.direction == "in") >= 10


async def test_stars_subscription_through_core() -> None:
    async with _core("bill_stars2") as b:
        rt = b.rt
        ref = await _order(rt)
        expires = (datetime.now(UTC) + timedelta(days=30)).replace(microsecond=0)
        first = _payment(ref, "stxINT-first", recurring=True, first=True, expires=expires)
        for _ in range(2):  # повтор charge id — без второй выдачи
            r = await b.post("payments", first)
            assert r.status_code == 200 and r.json() == {"ok": True}, r.text
        assert await _count(rt, models.ProviderTransaction) == 1
        async with rt.transaction() as db:
            sub = await db.scalar(select(models.StarsSubscription))
            period = await db.scalar(select(models.Period).where(models.Period.status == "active"))
        assert sub is not None and sub.status == "active" and sub.first_charge_id == "stxINT-first"
        assert period is not None and period.ends_at == expires and period.account_id == ACCOUNT

        # вторая подписка при живой — отказ в pre-checkout
        ref2 = await _order(rt)
        assert (await b.post("pre-checkout", {"query_id": "pcq-sub-1", "account_id": str(ACCOUNT), "currency": "XTR",
                                              "total_amount": 250, "invoice_payload": ref2})).json() == {
            "ok": False, "error": "subscription_exists"}

        # продление → заказ renewal и следующая транзакция
        renew = _payment(ref, "stxINT-renew", recurring=True, expires=expires + timedelta(days=30))
        assert (await b.post("payments", renew)).status_code == 200
        assert await _count(rt, models.Order, models.Order.channel == "renewal") == 1
        assert await _count(rt, models.ProviderTransaction) == 2

        # обновление subscription: canceled → статус; неизвестная подписка — 2xx, пункт сверки
        upd = {"account_id": str(ACCOUNT), "invoice_payload": ref, "state": "canceled"}
        assert (await b.post("subscription-updates", upd)).json() == {"ok": True, "matched": True}
        async with rt.transaction() as db:
            assert (await db.scalar(select(models.StarsSubscription.status))) == "canceled"
        miss = await b.post("subscription-updates", {**upd, "invoice_payload": f"o:{uuid.uuid4()}"})
        assert miss.status_code == 200 and miss.json() == {"ok": True, "matched": False}


async def _rows(rt: Runtime, stmt: Any) -> list[Any]:
    async with rt.transaction() as db:
        return list((await db.execute(stmt)).all())
