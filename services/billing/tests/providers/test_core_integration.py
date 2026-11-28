"""Payme, Click, Uzum через ядро billing (поток A): `/provider/v1/*` → адаптер (фабрика `build_adapter(rt)` по
соглашению domain/adapters.py) → настоящий `PaymentService` → миграция 0001 в PostgreSQL (роли billing_owner /
billing). Проверяет стык B ↔ A: идемпотентность по (provider, provider_txn_id), один performed на заказ, таймаут Payme,
попытки Click, заказ не `web` — «не найден», SetFiscalData, журнал provider_calls через `record_call` ядра."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import httpx
import pytest
from conftest import EDGE_TOKEN, SERVICE_DIR
from sqlalchemy import func, select

from providers.fakes import Clock, provider_settings
from providers.simulators import ClickMerchantApi, ClickSim, PaymeSim, UzumSim
from tilhero_billing.main import build_app
from tilhero_billing.providers import payme
from tilhero_billing.providers.click import ClickAdapter
from tilhero_billing.providers.common import CoreJournalSink, dt_to_ms
from tilhero_common.app import Runtime
from tilhero_common.testing import migrated_under_roles

models = pytest.importorskip("tilhero_billing.models")
pytest.importorskip("tilhero_billing.domain.payments")
if not hasattr(models, "Order"):  # миграция и модели ядра ещё не сданы
    pytest.skip("billing core models are not ready", allow_module_level=True)

SNAPSHOT = {"til": 100, "title": {"ru": "100 тилов", "uz": "100 til"},
            "fiscal": {"ikpu": "10305008002000000", "package_code": "1545643", "units": 1, "vat_percent": 12,
                       "receipt_title": "100 til"}}
EDGE = {"X-Edge-Token": EDGE_TOKEN, "X-Forwarded-For": "6.6.6.6, 185.234.113.7, 100.64.0.9"}


def _settings(**kw: Any) -> Any:
    return provider_settings(stand_catalog_on_start=False, projection_bootstrap_on_start=False, **kw)


class Core:
    def __init__(self, rt: Runtime, client: httpx.AsyncClient, clock: Clock) -> None:
        self.rt, self.c, self.clock = rt, client, clock
        self.payme, self.uzum = PaymeSim(), UzumSim()
        # sign_time Click — местное время Ташкента (§14 C4), от часов теста: попадает в окно сверки ядра
        self.click = ClickSim(sign_time=clock().astimezone(ZoneInfo("Asia/Tashkent")).strftime("%Y-%m-%d %H:%M:%S"))

    async def order(self, provider: str, *, amount: int = 500_000, stars: bool = False) -> int:
        now = self.clock()
        oid, account = uuid.uuid4(), uuid.uuid4()
        async with self.rt.transaction() as db:
            db.add(models.Order(
                order_id=oid, account_id=account, beneficiary_id=account,
                channel="miniapp" if stars else "web", product_code="til_100", product_kind="til_pack",
                catalog_version=1, product_snapshot=SNAPSHOT, provider="telegram_stars" if stars else provider,
                currency="XTR" if stars else "UZS", amount_tiyin=None if stars else amount,
                amount_stars=15 if stars else None, stars_mode="one_time" if stars else None, status="pending",
                offer_version="1.0", locale="ru", idempotency_key=f"t-{oid}", expires_at=now + timedelta(hours=24),
                created_at=now))
        async with self.rt.transaction() as db:
            return int(await db.scalar(select(models.Order.order_no).where(models.Order.order_id == oid)))

    async def status(self, order_no: int) -> str:
        async with self.rt.transaction() as db:
            return str(await db.scalar(select(models.Order.status).where(models.Order.order_no == order_no)))

    async def count(self, model: Any, *where: Any) -> int:
        async with self.rt.transaction() as db:
            return int(await db.scalar(select(func.count()).select_from(model).where(*where)) or 0)

    async def rpc(self, method: str, params: dict[str, Any], *, rpc_id: int = 1,
                  headers: dict[str, str] | None = None) -> dict[str, Any]:
        r = await self.c.post("/provider/v1/payme", content=self.payme.body(method, params, rpc_id),
                              headers=EDGE | (self.payme.headers() if headers is None else headers))
        assert r.status_code == 200, r.text  # Payme — всегда HTTP 200
        return dict(r.json())

    async def click_op(self, op: str, form: dict[str, str]) -> dict[str, Any]:
        r = await self.c.post(f"/provider/v1/click/{op}", content=self.click.encode(form),
                              headers=EDGE | {"Content-Type": "application/x-www-form-urlencoded"})
        assert r.status_code == 200, r.text
        return dict(r.json())

    async def uzum_op(self, op: str, **kw: Any) -> tuple[int, dict[str, Any]]:
        kw.setdefault("timestamp", dt_to_ms(self.clock()))
        r = await self.c.post(f"/provider/v1/uzum/{op}", content=self.uzum.body(op, **kw),
                              headers=EDGE | self.uzum.headers())
        return r.status_code, dict(r.json())


@asynccontextmanager
async def core(prefix: str, click_api: ClickMerchantApi | None = None) -> AsyncIterator[Core]:
    async with migrated_under_roles(SERVICE_DIR, _settings, prefix) as (settings, _roles):
        rt = Runtime(settings)
        clock = Clock(datetime.now(UTC).replace(microsecond=0))
        rt.clock = clock  # type: ignore[attr-defined]  # часы ядра (domain/common.now_of)
        overrides: dict[str, Any] | None = None
        if click_api is not None:  # исходящие Click — в симулятор; выписка — PaymentService ядра
            from tilhero_billing.domain.payments import PaymentService

            async def statement(f: datetime, t: datetime) -> Any:
                return await PaymentService(rt).statement("click", f, t)

            adapter = ClickAdapter(settings, transport=click_api.transport(), statement=statement, clock=clock,
                                   sink=CoreJournalSink(PaymentService(rt)))  # журнал — как в build_adapter
            adapter.http.retry_delay = 0
            overrides = {"click": adapter}
        app = build_app(settings, rt, adapters=overrides)  # маршруты B подключаются ядром сами (optional_routers)
        async with app.router.lifespan_context(app):
            transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
            async with httpx.AsyncClient(transport=transport, base_url="http://billing") as c:
                yield Core(rt, c, clock)


async def test_payme_through_core() -> None:
    async with core("bill_payme") as b:
        no = await b.order("payme")
        acc = {"order_id": str(no)}
        assert (await b.c.post("/provider/v1/payme", content=b"{}")).status_code == 404  # без X-Edge-Token
        assert (await b.rpc("CheckPerformTransaction", {"amount": 500_000, "account": acc},
                            headers=b.payme.headers(key="test-wrong")))["error"]["code"] == -32504
        check = await b.rpc("CheckPerformTransaction", {"amount": 500_000, "account": acc})
        assert check["result"]["allow"] is True, check
        assert (await b.rpc("CheckPerformTransaction", {"amount": 400_000, "account": acc}))["error"]["code"] == -31001

        params = {"id": "6745a1b2c3d4e5f6000000aa", "time": dt_to_ms(b.clock()), "amount": 500_000, "account": acc}
        first = await b.rpc("CreateTransaction", params, rpc_id=7)
        assert first["result"]["state"] == 1, first
        assert await b.rpc("CreateTransaction", params, rpc_id=7) == first
        busy = await b.rpc("CheckPerformTransaction", {"amount": 500_000, "account": acc})
        assert busy["error"]["code"] == payme.E_ORDER_BUSY
        second_id = await b.rpc("CreateTransaction", {**params, "id": "6745a1b2c3d4e5f6000000ab"})
        assert second_id["error"]["code"] == payme.E_ORDER_BUSY

        b.clock.advance(seconds=5)
        done = await b.rpc("PerformTransaction", {"id": params["id"]}, rpc_id=8)
        assert done["result"]["state"] == 2, done
        assert await b.rpc("PerformTransaction", {"id": params["id"]}, rpc_id=8) == done
        assert await b.status(no) == "paid"
        assert await b.count(models.ProviderTransaction, models.ProviderTransaction.state == "performed") == 1

        state = await b.rpc("CheckTransaction", {"id": params["id"]})
        assert state["result"]["state"] == 2 and state["result"]["perform_time"] == done["result"]["perform_time"]
        stmt = await b.rpc("GetStatement", {"from": params["time"] - 1, "to": params["time"] + 1})
        assert [t["id"] for t in stmt["result"]["transactions"]] == [params["id"]]
        assert stmt["result"]["transactions"][0]["account"] == acc

        fiscal = {"receipt_id": 777, "status_code": 0, "terminal_id": "EP000000000001", "fiscal_sign": "1234567890",
                  "qr_code_url": "https://ofd.soliq.uz/check?t=1"}
        assert (await b.rpc("SetFiscalData", {"id": params["id"], "type": "PERFORM", "fiscal_data": fiscal}
                            ))["result"] == {"success": True}
        assert (await b.rpc("SetFiscalData", {"id": "unknown-id", "type": "PERFORM", "fiscal_data": fiscal}
                            ))["error"]["code"] == -32001
        assert await b.count(models.FiscalReceipt, models.FiscalReceipt.status == "registered") == 1

        # журнал provider_calls — через record_call ядра, только метаданные, IP — второй справа
        async with b.rt.transaction() as db:
            calls = (await db.execute(select(models.ProviderCall).where(models.ProviderCall.provider == "payme")
                                      )).scalars().all()
        assert len(calls) >= 10 and {c.direction for c in calls} == {"in"}
        assert {str(c.client_ip) for c in calls} == {"185.234.113.7"}
        assert "PerformTransaction" in {c.method for c in calls}
        # стык: адаптеры — из реестра ядра (build_adapter), порт — PaymentService, свои запасные не строились
        from tilhero_billing.domain.payments import PaymentService
        from tilhero_billing.providers.click import ClickAdapter
        from tilhero_billing.providers.payme import PaymeAdapter
        from tilhero_billing.providers.uzum import UzumAdapter

        registry = b.rt.billing_adapters  # type: ignore[attr-defined]
        assert [type(registry.get(c)) for c in ("payme", "click", "uzum")] == [PaymeAdapter, ClickAdapter,
                                                                                UzumAdapter]
        assert registry.get("click").statement is not None  # сверка Click — по выписке ядра
        app = b.c._transport.app  # type: ignore[attr-defined]
        assert isinstance(app.state.payment_port, PaymentService)
        assert not hasattr(app.state, "fiat_adapters")


async def test_payme_refund_by_cancel_through_core() -> None:
    async with core("bill_payme_r") as b:
        no = await b.order("payme")
        params = {"id": "6745a1b2c3d4e5f6000000ac", "time": dt_to_ms(b.clock()), "amount": 500_000,
                  "account": {"order_id": str(no)}}
        await b.rpc("CreateTransaction", params)
        await b.rpc("PerformTransaction", {"id": params["id"]})
        cancelled = await b.rpc("CancelTransaction", {"id": params["id"], "reason": 5}, rpc_id=3)
        assert cancelled["result"]["state"] == -2, cancelled
        assert await b.rpc("CancelTransaction", {"id": params["id"], "reason": 5}, rpc_id=3) == cancelled
        check = await b.rpc("CheckTransaction", {"id": params["id"]})
        assert check["result"]["state"] == -2 and check["result"]["reason"] == 5


async def test_payme_timeout_and_foreign_order_through_core() -> None:
    async with core("bill_payme_t") as b:
        no = await b.order("payme")
        params = {"id": "6745a1b2c3d4e5f6000000ad", "time": dt_to_ms(b.clock()), "amount": 500_000,
                  "account": {"order_id": str(no)}}
        assert (await b.rpc("CreateTransaction", params))["result"]["state"] == 1
        b.clock.advance(milliseconds=payme.TIMEOUT_MS + 1)
        assert (await b.rpc("PerformTransaction", {"id": params["id"]}))["error"]["code"] == -31008
        check = await b.rpc("CheckTransaction", {"id": params["id"]})
        assert check["result"]["state"] == -1 and check["result"]["reason"] == 4
        assert await b.status(no) == "pending"
        # заказ Mini App (Stars) и заказ другого фиатного провайдера для Payme не существуют
        for other in (await b.order("payme", stars=True), await b.order("click")):
            body = await b.rpc("CheckPerformTransaction", {"amount": 500_000, "account": {"order_id": str(other)}})
            assert body["error"]["code"] == -31050 and body["error"]["data"] == "order_id"


async def test_click_through_core() -> None:
    async with core("bill_click") as b:
        no = await b.order("click", amount=1_500_000)
        prep = await b.click_op("prepare", b.click.prepare_form("8001", no, "15000.00"))
        assert prep["error"] == 0, prep
        assert await b.click_op("prepare", b.click.prepare_form("8001", no, "15000.00")) == prep
        second = await b.click_op("prepare", b.click.prepare_form("8002", no, "15000.00"))
        assert second["error"] == 0 and second["merchant_prepare_id"] != prep["merchant_prepare_id"]
        assert (await b.click_op("prepare", b.click.prepare_form("8003", no, "15000.01")))["error"] == -2
        assert (await b.click_op("prepare", b.click.prepare_form("8004", no, "15000.00", sign_string="0" * 32))
                )["error"] == -1

        done = await b.click_op("complete", b.click.complete_form("8001", no, "15000.00",
                                                                  prep["merchant_prepare_id"]))
        assert done["error"] == 0 and done["merchant_confirm_id"] == prep["merchant_prepare_id"], done
        assert (await b.click_op("complete", b.click.complete_form("8001", no, "15000.00",
                                                                   prep["merchant_prepare_id"])))["error"] == -4
        # вторая попытка по оплаченному заказу: -4 и при повторе (ядро закрыло её order_closed)
        for _ in range(2):
            other = await b.click_op("complete", b.click.complete_form("8002", no, "15000.00",
                                                                       second["merchant_prepare_id"]))
            assert other["error"] == -4, other
        assert await b.status(no) == "paid"
        assert await b.count(models.ProviderTransaction, models.ProviderTransaction.state == "performed") == 1
        # Click: после проведения ядро ставит чек продажи в очередь фискализации (submit_items — tick)
        assert await b.count(models.FiscalReceipt, models.FiscalReceipt.source == "click_ofd") == 1

        cancel_no = await b.order("click", amount=1_500_000)
        p = await b.click_op("prepare", b.click.prepare_form("8101", cancel_no, "15000.00"))
        assert (await b.click_op("complete", b.click.complete_form("8101", cancel_no, "15000.00",
                                                                   p["merchant_prepare_id"], error="-5017"))
                )["error"] == -9
        assert await b.status(cancel_no) == "pending"
        assert (await b.click_op("prepare", b.click.prepare_form("8102", 999_999_999, "15000.00")))["error"] == -5


async def test_uzum_through_core() -> None:
    async with core("bill_uzum") as b:
        no = await b.order("uzum", amount=12_900_000)
        status, body = await b.uzum_op("check", order_no=no)
        assert status == 200 and body["status"] == "OK", body
        status, body = await b.uzum_op("create", trans_id="uz-int-1", order_no=no, amount=12_900_000)
        assert status == 200 and body["status"] == "CREATED", body
        assert (await b.uzum_op("create", trans_id="uz-int-1", order_no=no, amount=12_900_000))[1][
            "errorCode"] == 10010
        status, body = await b.uzum_op("confirm", trans_id="uz-int-1")
        assert status == 200 and body["status"] == "CONFIRMED", body
        assert (await b.uzum_op("confirm", trans_id="uz-int-1"))[1]["errorCode"] == 10016
        assert (await b.uzum_op("status", trans_id="uz-int-1"))[1]["status"] == "CONFIRMED"
        assert await b.status(no) == "paid"
        assert (await b.uzum_op("check", order_no=no))[1]["errorCode"] == 10008
        status, body = await b.uzum_op("reverse", trans_id="uz-int-1")
        assert status == 200 and body["status"] == "REVERSED", body
        assert (await b.uzum_op("reverse", trans_id="uz-int-1"))[1]["errorCode"] == 10018


async def test_click_reconciliation_and_refund_through_core() -> None:
    """Сверка ядра (`reconciliation.remote`) по `status_by_mti`: совпадает — пунктов нет; у Click платёж отменён, а у
    нас проведён — `provider_mismatch`. Возврат через адаптер (`reversal`) — api_ok."""
    from tilhero_billing.domain import reconciliation

    api = ClickMerchantApi()
    async with core("bill_click_rec", click_api=api) as b:
        no = await b.order("click", amount=1_500_000)
        prep = await b.click_op("prepare", b.click.prepare_form("8201", no, "15000.00"))
        await b.click_op("complete", b.click.complete_form("8201", no, "15000.00", prep["merchant_prepare_id"]))
        api.payments[str(no)] = {"payment_id": "98201", "status": 2}
        b.clock.advance(minutes=5)
        found = await reconciliation.remote(b.rt, b.clock(), None)
        assert found["provider_mismatch"] == 0 and ("GET", "status_by_mti") in {(m, o) for m, o, _ in api.requests}
        api.payments[str(no)]["status"] = -99  # отмена у Click без нашего возврата
        found = await reconciliation.remote(b.rt, b.clock(), None)
        assert found["provider_mismatch"] == 1
        assert await b.count(models.ReconciliationItem, models.ReconciliationItem.kind == "provider_mismatch") == 1
        from tilhero_billing.domain.payments import PaymentService

        txn = await PaymentService(b.rt).get("click", "8201")
        api.payments[str(no)]["status"] = 2
        outcome = await b.rt.billing_adapters.get("click").refund(txn, account_id=None)  # type: ignore[attr-defined]
        assert outcome.kind == "api_ok" and api.bad_auth == 0
        async with b.rt.transaction() as db:
            outbound = (await db.execute(select(models.ProviderCall.method).where(
                models.ProviderCall.provider == "click", models.ProviderCall.direction == "out"))).scalars().all()
        assert {"status_by_mti", "reversal"} <= set(outbound)  # исходящие — тоже в provider_calls
