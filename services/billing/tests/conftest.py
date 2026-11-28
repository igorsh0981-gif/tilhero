from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from sqlalchemy import text

from tilhero_billing.domain.payments import PaymentService
from tilhero_billing.providers.base import (
    Checkout,
    FiscalOutcome,
    InboundCall,
    OrderView,
    OutboundResponse,
    RefundOutcome,
    RemoteRecord,
    TxnView,
)
from tilhero_billing.settings import Settings
from tilhero_common.app import Runtime
from tilhero_common.internal_auth import HEADER, Actor, issue_token
from tilhero_common.messaging import ConsumerSpec, Envelope, InMemoryBus, make_envelope
from tilhero_common.testing import (
    TEST_ADMIN_URL,
    TEST_REDIS_URL,
    assert_event_conforms,
    create_schema,
    drop_schema,
    migrate,
    unique_schema,
)

SERVICE_DIR = str(Path(__file__).resolve().parents[1])
SCHEDULER_TOKEN = "s" * 40
# заведомо тестовые значения (не секреты): ключи провайдеров в тестах — только такие строки
EDGE_TOKEN = "test-edge-token-" + "e" * 24
T0 = datetime(2026, 11, 20, 5, 0, tzinfo=UTC)  # 10:00 в Ташкенте
ALL_PERMS = ("billing.read", "billing.manage", "billing.publish", "billing.approve", "billing.refund",
             "subscriptions.override")


def make_settings(**kw: Any) -> Settings:
    base: dict[str, Any] = {"env": "test", "internal_jwt_secret": "t" * 40, "scheduler_token": SCHEDULER_TOKEN,
                            "payments_edge_token": EDGE_TOKEN, "redis_url": TEST_REDIS_URL}
    base.update(kw)
    return Settings(**base)


class RecordingBus(InMemoryBus):
    """Шина в памяти, которая запоминает исключения обработчиков (InMemoryBus прячет их в DLQ)."""

    def __init__(self) -> None:
        super().__init__()
        self.errors: list[BaseException] = []

    async def subscribe(self, spec: ConsumerSpec) -> None:
        orig = spec.handler

        async def handler(env: Envelope) -> None:
            try:
                await orig(env)
            except Exception as exc:
                self.errors.append(exc)
                raise

        spec.handler = handler
        await super().subscribe(spec)


class FakeAdapter:
    """Адаптер-заглушка ядра (настоящие — потоки B и G): ссылки, возвраты, чеки, выписка — управляемые."""

    def __init__(self, code: str, settings: Settings) -> None:
        self.code = code
        self.settings = settings
        self.down = False
        self.refund_outcome = RefundOutcome(kind="api_ok") if code in ("telegram_stars", "click") else \
            RefundOutcome(kind="manual", instruction={"provider": code})
        self.fiscal = FiscalOutcome(kind="registered", fiscal_receipt_id="FR-1", qr_code_url="https://ofd.test/r/1")
        self.remote: list[RemoteRecord] | None = None
        self.refunds: list[tuple[str, uuid.UUID | None]] = []
        self.checkouts: list[int] = []

    def enabled(self) -> bool:
        return self.settings.provider_enabled(self.code)

    async def checkout(self, order: OrderView, *, locale: str, return_url: str | None) -> Checkout:
        if self.down:
            raise RuntimeError("down")
        self.checkouts.append(order.order_no)
        if self.code == "telegram_stars":
            return Checkout(kind="invoice_link", url=f"https://t.me/$inv{order.order_no}")
        return Checkout(kind="redirect", url=f"https://checkout.{self.code}.test/{order.order_no}?r={return_url}")

    async def handle(self, call: InboundCall, payments: Any) -> OutboundResponse:
        return OutboundResponse(status_code=200, body={}, result_code="0")

    async def refund(self, txn: TxnView, *, account_id: uuid.UUID | None) -> RefundOutcome:
        self.refunds.append((txn.provider_txn_id, account_id))
        if self.down:
            raise RuntimeError("down")
        return self.refund_outcome

    async def fiscalize(self, txn: TxnView, order: OrderView) -> FiscalOutcome:
        return self.fiscal

    async def remote_status(self, since: datetime) -> list[RemoteRecord] | None:
        return self.remote


class FakeBotGw:
    """telegram-bot-gateway: POST /internal/v1/stars/subscriptions/edit."""

    def __init__(self) -> None:
        self.edits: list[dict[str, Any]] = []
        self.down = False
        self.payer_unknown = False

    def handler(self, request: httpx.Request) -> httpx.Response:
        if self.down:
            return httpx.Response(503, json={"code": "UNAVAILABLE", "message": "down"})
        if request.url.path == "/internal/v1/stars/subscriptions/edit":
            body = json.loads(request.content)
            if self.payer_unknown:
                return httpx.Response(409, json={"code": "STARS_PAYER_UNKNOWN", "message": "нет"})
            self.edits.append(body)
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404, json={"code": "NOT_FOUND", "message": request.url.path})


class FakeGame:
    """gamification: GET /internal/v1/game/purchases/by-order/{order_id} (до начисления — 404)."""

    def __init__(self) -> None:
        self.purchases: dict[str, dict[str, Any]] = {}
        self.down = False

    def handler(self, request: httpx.Request) -> httpx.Response:
        if self.down:
            return httpx.Response(503, json={"code": "UNAVAILABLE", "message": "down"})
        oid = request.url.path.rsplit("/", 1)[-1]
        if oid in self.purchases:
            return httpx.Response(200, json=self.purchases[oid])
        return httpx.Response(404, json={"code": "PURCHASE_NOT_FOUND", "message": "нет"})


class FakeIdentity:
    def __init__(self) -> None:
        self.profiles: list[dict[str, Any]] = []
        self.down = False

    def handler(self, request: httpx.Request) -> httpx.Response:
        if self.down:
            return httpx.Response(503, json={"code": "UNAVAILABLE", "message": "down"})
        if request.url.path == "/internal/v1/export/profiles":
            start = int(request.url.params.get("cursor") or 0)
            limit = int(request.url.params.get("limit") or 500)
            page = self.profiles[start:start + limit]
            nxt = str(start + limit) if start + limit < len(self.profiles) else None
            return httpx.Response(200, json={"items": page, "next_cursor": nxt})
        return httpx.Response(404, json={"code": "NOT_FOUND", "message": request.url.path})


class Env:
    def __init__(self, settings: Settings, client: httpx.AsyncClient, runtime: Runtime, bus: RecordingBus,
                 adapters: dict[str, FakeAdapter], botgw: FakeBotGw, game: FakeGame, idc: FakeIdentity) -> None:
        self.settings = settings
        self.c = client
        self.runtime = runtime
        self.bus = bus
        self.adapters = adapters
        self.botgw = botgw
        self.game = game
        self.idc = idc
        self.pay = PaymentService(runtime)
        self.now = T0

        def clock() -> datetime:
            self.now += timedelta(milliseconds=1)
            return self.now

        runtime.clock = clock  # type: ignore[attr-defined]

    def shift(self, **kw: float) -> None:
        self.now += timedelta(**kw)

    # ---------- заголовки
    def h(self, account: uuid.UUID, *, lrn: uuid.UUID | None = None, age_band: str | None = "18+",
          chn: str | None = "miniapp", issuer: str = "telegram-bff") -> dict[str, str]:
        extra: dict[str, Any] = {"lrn": str(lrn or account)}
        if age_band:
            extra["age_band"] = age_band
        if chn:
            extra["chn"] = chn
        token = issue_token(self.settings.internal_jwt_secret.get_secret_value(), issuer=issuer,
                            audience="billing", subject=str(account), extra=extra)
        return {HEADER: token}

    def svc(self, issuer: str, subject: uuid.UUID | None = None) -> dict[str, str]:
        return {HEADER: issue_token(self.settings.internal_jwt_secret.get_secret_value(), issuer=issuer,
                                    audience="billing", subject=str(subject) if subject else None)}

    def staff(self, *perms: str, step_up: bool = True, staff_id: str | None = None,
              issuer: str = "admin-bff") -> dict[str, str]:
        a = Actor(id=staff_id or str(uuid.uuid4()), role="finance", permissions=frozenset(perms or ALL_PERMS),
                  name="Финансист")
        out = {HEADER: issue_token(self.settings.internal_jwt_secret.get_secret_value(), issuer=issuer,
                                   audience="billing", actor=a)}
        if step_up:
            out["X-Step-Up"] = "ok"
        return out

    # ---------- API
    async def get(self, account: uuid.UUID, path: str, expect: int = 200, params: Any = None, **hk: Any) -> Any:
        r = await self.c.get(f"/internal/v1/me/billing/{path}", headers=self.h(account, **hk), params=params)
        assert r.status_code == expect, r.text
        return r.json()

    async def post(self, account: uuid.UUID, path: str, body: Any = None, expect: int | tuple[int, ...] = 200, *,
                   key: str | None = None, **hk: Any) -> Any:
        headers = self.h(account, **hk)
        if key is not None:
            headers["Idempotency-Key"] = key
        r = await self.c.post(f"/internal/v1/me/billing/{path}", json=body, headers=headers)
        ok = expect if isinstance(expect, tuple) else (expect,)
        assert r.status_code in ok, r.text
        return r.json()

    async def order(self, account: uuid.UUID, product: str = "til_100", provider: str = "telegram_stars",
                    expect: int | tuple[int, ...] = (200, 201), *, key: str | None = None, **extra: Any) -> Any:
        chn = extra.pop("chn", "web" if provider != "telegram_stars" else "miniapp")
        hk = {k: extra.pop(k) for k in ("lrn", "age_band") if k in extra}
        body = {"product_code": product, "provider": provider, "offer_version": "1.0", **extra}
        return await self.post(account, "orders", body, expect, key=key or f"k-{uuid.uuid4()}", chn=chn, **hk)

    async def trial(self, account: uuid.UUID, expect: int = 201, **hk: Any) -> Any:
        return await self.post(account, "trial", None, expect, key=f"k-{uuid.uuid4()}", **hk)

    async def adm(self, method: str, path: str, body: Any = None, expect: int = 200, *, perms: tuple[str, ...] = (),
                  step_up: bool = True, key: str | None = None, staff_id: str | None = None,
                  headers: dict[str, str] | None = None) -> Any:
        h = self.staff(*perms, step_up=step_up, staff_id=staff_id)
        if key is not None:
            h["Idempotency-Key"] = key
        h.update(headers or {})
        r = await self.c.request(method, f"/internal/v1/admin/billing/{path}", json=body, headers=h)
        assert r.status_code == expect, r.text
        return r.json() if r.content else None

    async def hold(self, user: uuid.UUID, *, feature: str = "ai_lessons", ref_kind: str = "session",
                   ref_id: uuid.UUID | None = None, minutes: int = 40, expect: int = 200) -> Any:
        r = await self.c.post("/internal/v1/holds", json={
            "user_id": str(user), "feature": feature, "ref_kind": ref_kind, "ref_id": str(ref_id or uuid.uuid4()),
            "minutes_planned": minutes}, headers=self.svc("lessons", user))
        assert r.status_code == expect, r.text
        return r.json()

    async def tick(self) -> dict[str, Any]:
        r = await self.c.post("/internal/v1/billing:tick", headers={"Authorization": f"Bearer {SCHEDULER_TOKEN}"})
        assert r.status_code == 200, r.text
        return dict(r.json())

    async def reconcile(self) -> dict[str, Any]:
        r = await self.c.post("/internal/v1/billing:reconcile",
                              headers={"Authorization": f"Bearer {SCHEDULER_TOKEN}"})
        assert r.status_code == 200, r.text
        return dict(r.json())

    # ---------- события
    async def flush(self) -> None:
        assert self.runtime.relay is not None
        await self.runtime.relay.drain()

    async def events(self, event_type: str, **match: Any) -> list[Envelope]:
        await self.flush()
        found = [e for e in self.bus.of_type(event_type)
                 if all(e.payload.get(k) == (str(v) if isinstance(v, uuid.UUID) else v) for k, v in match.items())]
        for e in found:
            assert_event_conforms(e)
            assert e.producer == "billing"
        return found

    async def publish(self, event_type: str, payload: dict[str, Any], producer: str,
                      env: Envelope | None = None) -> Envelope:
        self.now += timedelta(seconds=1)
        e = env or make_envelope(event_type, payload, producer=producer)
        assert_event_conforms(e)
        before = len(self.bus.errors)
        await self.bus.publish(e)
        if len(self.bus.errors) > before:
            raise self.bus.errors[-1]
        await self.flush()
        return e

    async def profile(self, user: uuid.UUID, kind: str = "account", age_band: str | None = "18+",
                      guardian: uuid.UUID | None = None) -> None:
        await self.publish("user.profile.created.v1", {
            "user_id": str(user), "kind": kind, "locale": "ru", "age_band": age_band,
            "guardian_user_id": str(guardian) if guardian else None,
            "created_at": self.ts()}, "identity-consent")

    async def consent(self, user: uuid.UUID, consent: str = "granted", age_band: str = "14-17") -> None:
        await self.publish("user.profile.updated.v1", {
            "user_id": str(user), "changed_fields": ["guardian_consent"], "age_band": age_band, "is_minor": True,
            "guardian_consent": consent}, "identity-consent")

    async def lesson_done(self, user: uuid.UUID, hold_id: str | None, billable: int | None,
                          status: str = "completed", env: Envelope | None = None) -> Envelope:
        return await self.publish("lesson.session.completed.v1", {
            "session_id": str(uuid.uuid4()), "user_id": str(user), "kind": "lesson", "pair_id": "ru-en",
            "status": status, "minutes": 12, "practice_only": False, "finished_at": self.ts(),
            "billable_minutes": billable, "billing_hold_id": hold_id}, "lessons", env=env)

    async def delete(self, user: uuid.UUID) -> None:
        await self.publish("user.deletion.requested.v1", {
            "user_id": str(user), "request_id": str(uuid.uuid4()), "requested_at": self.ts()}, "identity-consent")

    def ts(self) -> str:
        return self.now.isoformat().replace("+00:00", "Z")

    async def sql(self, stmt: str, **params: Any) -> Any:
        async with self.runtime.transaction() as s:
            result = await s.execute(text(stmt), params)
            return result.all() if result.returns_rows else None

    async def one(self, stmt: str, **params: Any) -> Any:
        rows = await self.sql(stmt, **params)
        assert rows, stmt
        return rows[0]

    async def account(self, age_band: str = "18+") -> uuid.UUID:
        user = uuid.uuid4()
        await self.profile(user, age_band=age_band)
        return user

    async def balance(self, account: uuid.UUID) -> dict[str, int]:
        row = await self.sql("SELECT b.granted, b.spent, b.removed, b.held, b.overage FROM period_balances b "
                             "JOIN periods p ON p.period_id = b.period_id WHERE p.account_id = :a AND "
                             "p.status = 'active'", a=account)
        if not row:
            return {}
        g, s, r, h, o = row[0]
        return {"granted": g, "spent": s, "removed": r, "held": h, "overage": o, "left": g - s - r - h}


def build_env_app(settings: Settings, runtime: Runtime, adapters: dict[str, FakeAdapter], botgw: FakeBotGw,
                  game: FakeGame, idc: FakeIdentity) -> Any:
    from tilhero_billing.main import build_app

    transports: dict[str, httpx.AsyncBaseTransport] = {
        "telegram-bot-gateway": httpx.MockTransport(botgw.handler),
        "gamification": httpx.MockTransport(game.handler),
        "identity-consent": httpx.MockTransport(idc.handler)}
    return build_app(settings, runtime, transports=transports, adapters=adapters)  # type: ignore[arg-type]


async def open_env(**kw: Any):  # type: ignore[no-untyped-def]
    schema = unique_schema("bill")
    await create_schema(schema)
    settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema, stars_enabled=True, payme_enabled=True,
                             click_enabled=True, uzum_enabled=True, projection_bootstrap_on_start=False, **kw)
    await migrate(SERVICE_DIR, settings)
    bus = RecordingBus()
    runtime = Runtime(settings, bus=bus)
    adapters = {code: FakeAdapter(code, settings) for code in ("telegram_stars", "payme", "click", "uzum")}
    botgw, game, idc = FakeBotGw(), FakeGame(), FakeIdentity()
    app = build_env_app(settings, runtime, adapters, botgw, game, idc)
    return schema, settings, bus, runtime, adapters, botgw, game, idc, app


@pytest.fixture
async def env():  # type: ignore[no-untyped-def]
    schema, settings, bus, runtime, adapters, botgw, game, idc, app = await open_env()
    async with app.router.lifespan_context(app):
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://billing")
        e = Env(settings, client, runtime, bus, adapters, botgw, game, idc)
        await e.flush()
        yield e
        await client.aclose()
        assert bus.dlq == [], bus.dlq
    await drop_schema(schema)


__all__ = ["ALL_PERMS", "EDGE_TOKEN", "SCHEDULER_TOKEN", "SERVICE_DIR", "T0", "Env", "FakeAdapter", "make_settings"]
