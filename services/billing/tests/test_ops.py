"""tick, сверка, отчёты и курсы, сага удаления, проекция учеников, провайдеры, вход планировщика (§1.14–1.16,
AT-97/99/101) и запросы потоков B и G к ядру: pre-checkout продления Stars, «не найден у провайдера», ссылка на чек
Click позже регистрации, автопродление через адаптер Stars."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

import pytest
from conftest import SCHEDULER_TOKEN, Env

from tilhero_billing.domain import ports
from tilhero_billing.domain.ports import StarsRecurrence
from tilhero_billing.providers.base import FiscalOutcome, RemoteRecord


async def _stars_sub(env: Env, a: uuid.UUID, charge: str = "ch-sub") -> uuid.UUID:
    o = await env.order(a, "plus_30d", expect=201)
    oid = (await env.one("SELECT order_id FROM orders WHERE order_no = :n", n=o["order_no"]))[0]
    await env.pay.paid("telegram_stars", charge, f"o:{oid}", 250, payer_account_id=a,
                       recurring=StarsRecurrence(True, True, env.now + timedelta(days=30)), provider_time=env.now,
                       meta={})
    return oid  # type: ignore[no-any-return]


async def _web_paid(env: Env, a: uuid.UUID, provider: str = "click", product: str = "til_100") -> tuple[int, str]:
    extra: dict[str, Any] = {"start_mode": "now"} if product.startswith("plus") else {}
    o = await env.order(a, product, provider, expect=201, **extra)
    tid = f"{provider}-{uuid.uuid4().hex[:8]}"
    amount = (await env.one("SELECT amount_tiyin FROM orders WHERE order_no = :n", n=o["order_no"]))[0]
    await env.pay.create(provider, tid, str(o["order_no"]), amount, env.now, {})
    await env.pay.perform(provider, tid)
    return int(o["order_no"]), tid


async def test_scheduler_auth(env: Env) -> None:
    r = await env.c.post("/internal/v1/billing:tick")
    assert r.status_code == 401
    r = await env.c.post("/internal/v1/billing:tick", headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401
    r = await env.c.post("/internal/v1/billing:tick", headers=env.svc("telegram-bff"))
    assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    out = await env.tick()
    assert out["skipped"] is False and "recon" in out


async def test_recon_paid_not_fulfilled_stale_drift_and_resolve(env: Env) -> None:
    a = await env.account()
    o = await env.order(a, "til_100", expect=201)
    oid = (await env.one("SELECT order_id FROM orders WHERE order_no = :n", n=o["order_no"]))[0]
    await env.pay.paid("telegram_stars", "ch-pnf", f"o:{oid}", 15, payer_account_id=a, recurring=None,
                       provider_time=env.now, meta={})
    c = await env.order(a, "til_100", "click", expect=201)
    await env.pay.create("click", "c-stale", str(c["order_no"]), 500_000, env.now, {})
    await env.trial(a)
    env.shift(minutes=61)
    await env.tick()
    kinds = {r[0] for r in await env.sql("SELECT kind FROM reconciliation_items")}
    assert {"paid_not_fulfilled", "stale_created"} <= kinds
    await env.tick()  # dedup — второй раз не создаётся
    assert (await env.one("SELECT count(*) FROM reconciliation_items WHERE kind = 'paid_not_fulfilled'"))[0] == 1
    # расхождение остатков: пересчёт по реестру и пункт
    await env.sql("UPDATE period_balances SET spent = 5")
    run = await env.reconcile()
    assert run["kind"] == "daily" and run["found"] >= 1 and run["error"] is None
    assert (await env.balance(a))["spent"] == 0
    items = await env.adm("GET", "reconciliation/items", None)
    drift = next(i for i in items["items"] if i["kind"] == "balance_drift")
    assert drift["details"]["was"][1] == 5
    pnf = next(i for i in items["items"] if i["kind"] == "paid_not_fulfilled")
    assert pnf["order_no"] == o["order_no"]
    await env.adm("POST", f"reconciliation/items/{pnf['item_id']}/resolve", {"status": "resolved", "note": "кратко"},
                  422)
    done = await env.adm("POST", f"reconciliation/items/{pnf['item_id']}/resolve",
                         {"status": "resolved", "note": "тилы зачислены вручную"})
    assert done["status"] == "resolved" and done["resolved_by"]["name"] == "Финансист"
    await env.adm("POST", f"reconciliation/items/{pnf['item_id']}/resolve",
                  {"status": "ignored", "note": "повторный разбор"}, 409)
    await env.adm("POST", f"reconciliation/items/{pnf['item_id']}/resolve",
                  {"status": "ignored", "note": "без права разбора"}, 403, perms=("billing.read",))
    manual = await env.adm("POST", "reconciliation/runs")
    assert manual["kind"] == "manual"


async def test_recon_remote_statements(env: Env) -> None:
    a = await env.account()
    await _stars_sub(env, a, "ch-known")
    _, click_tid = await _web_paid(env, a, "click")
    env.shift(hours=2)
    env.adapters["telegram_stars"].remote = [
        RemoteRecord(provider="telegram_stars", provider_txn_id="ch-extra", order_ref=None, amount_tiyin=None,
                     amount_stars=99, state="performed", at=env.now)]
    # «платёж не найден» у Click при нашей проведённой транзакции — расхождение (запрос потока B)
    env.adapters["click"].remote = [
        RemoteRecord(provider="click", provider_txn_id=click_tid, order_ref=None, amount_tiyin=500_000,
                     amount_stars=None, state="unknown", at=env.now),
        RemoteRecord(provider="click", provider_txn_id="never-ours", order_ref=None, amount_tiyin=1,
                     amount_stars=None, state="unknown", at=env.now)]
    await env.reconcile()
    rows = {r[0] for r in await env.sql("SELECT dedup_key FROM reconciliation_items "
                                        "WHERE kind IN ('stars_unmatched', 'provider_mismatch')")}
    assert "stars_unmatched:remote:in:ch-extra" in rows
    assert any(k.startswith("stars_unmatched:local:") for k in rows)  # наша ch-known не в выписке
    assert f"provider_mismatch:click:{click_tid}:unknown" in rows
    assert not any("never-ours" in k for k in rows)


async def test_click_receipt_link_arrives_later(env: Env) -> None:
    a = await env.account()
    order_no, tid = await _web_paid(env, a, "click")
    env.adapters["click"].fiscal = FiscalOutcome(kind="registered", provider_receipt_id="P1")
    await env.tick()
    assert tuple(await env.one("SELECT status, qr_code_url FROM fiscal_receipts")) == ("registered", None)
    env.adapters["click"].fiscal = FiscalOutcome(kind="registered", provider_receipt_id="P1",
                                                 qr_code_url="https://ofd.test/r/late")
    env.shift(minutes=2)
    await env.tick()
    assert (await env.one("SELECT qr_code_url FROM fiscal_receipts"))[0] == "https://ofd.test/r/late"
    assert await env.pay.update_fiscal_link("click", tid, "sale", "https://ofd.test/r/new")
    assert not await env.pay.update_fiscal_link("click", tid, "sale", "http://insecure")
    assert not await env.pay.update_fiscal_link("click", "nope", "sale", "https://ofd.test/x")
    assert (await env.get(a, f"orders/{order_no}", chn="web"))["receipt_url"] == "https://ofd.test/r/new"


async def test_stars_renewal_pre_checkout_and_auto_renew(env: Env) -> None:
    a = await env.account()
    first = await _stars_sub(env, a)
    payload = f"o:{first}"
    # pre-checkout продления (§14 S2) — по payload первого заказа живой подписки; и при STARS_ENABLED=false
    env.settings.stars_enabled = False
    ok = await env.pay.check("telegram_stars", payload, 250, payer_account_id=a)
    assert ok.order.order_id == first
    with pytest.raises(ports.PayerMismatch):
        await env.pay.check("telegram_stars", payload, 250, payer_account_id=uuid.uuid4())
    with pytest.raises(ports.AmountMismatch):
        await env.pay.check("telegram_stars", payload, 300, payer_account_id=a)
    env.settings.stars_enabled = True
    # автопродление из Mini App → bot-gateway (адаптер без edit_subscription — прямой вызов)
    view = await env.post(a, "stars-subscription", {"auto_renew": False})
    assert view["stars_subscription"]["status"] == "canceled" and not view["stars_subscription"]["auto_renew"]
    assert env.botgw.edits[-1] == {"account_id": str(a), "telegram_payment_charge_id": "ch-sub",
                                   "is_canceled": True}
    env.botgw.down = True
    assert (await env.post(a, "stars-subscription", {"auto_renew": True}, 503))["code"] == "STARS_UNAVAILABLE"
    env.botgw.down = False
    view = await env.post(a, "stars-subscription", {"auto_renew": True})
    assert view["stars_subscription"]["auto_renew"] is True
    b = await env.account()
    assert (await env.post(b, "stars-subscription", {"auto_renew": True}, 404))["code"] == \
        "STARS_SUBSCRIPTION_NOT_FOUND"
    # адаптер Stars с edit_subscription (поток G) — вызывается он
    calls: list[dict[str, Any]] = []

    async def edit_subscription(**kw: Any) -> None:
        calls.append(kw)

    env.adapters["telegram_stars"].edit_subscription = edit_subscription  # type: ignore[attr-defined]
    await env.post(a, "stars-subscription", {"auto_renew": False})
    assert calls == [{"account_id": a, "first_charge_id": "ch-sub", "is_canceled": True}]


async def test_reports_and_rates(env: Env) -> None:
    a = await env.account()
    await _web_paid(env, a, "payme", "plus_30d")
    await _stars_sub(env, await env.account())
    t = await env.account()
    await env.trial(t)
    s = await env.adm("GET", "reports/summary?period=day")
    assert s["web"]["revenue_tiyin"] == 4_900_000 and s["web"]["by_provider"]["payme"]["orders"] == 1
    assert s["stars"]["revenue_stars"] == 250 and s["stars"]["est_net_tiyin"] is None
    assert s["trials_started"] == 1 and s["minutes"]["granted"] == 300 + 300 + 60 and s["refunds_count"] == 0
    assert s["recon_open"] == 0
    assert s["by_product"]["plus_30d"] == {"orders": 2, "revenue_tiyin": 4_900_000, "revenue_stars": 250}
    await env.adm("PUT", "star-rate", {"star_in_tiyin": 0, "valid_from": "2026-11-01", "reason": "оценка финансов"},
                  422)
    await env.adm("PUT", "star-rate", {"star_in_tiyin": 15_000, "valid_from": "2026-11-01",
                                       "reason": "оценка вознаграждения"}, 403, perms=("billing.read",))
    await env.adm("PUT", "star-rate", {"star_in_tiyin": 15_000, "valid_from": "2026-11-01",
                                       "reason": "оценка вознаграждения"})
    await env.adm("PUT", "fx", {"usd_in_tiyin": 1_280_000, "valid_from": "2026-11-01", "reason": "курс ЦБ на 1-е"})
    s = await env.adm("GET", "reports/summary?period=month")
    assert s["stars"]["est_net_tiyin"] == 250 * 15_000 and s["fx"] == {"usd_in_tiyin": 1_280_000,
                                                                       "valid_from": "2026-11-01"}
    assert (await env.adm("GET", "fx"))["items"][0]["set_by"]["name"] == "Финансист"
    d = await env.adm("GET", "reports/daily?from=2026-11-19&to=2026-11-20")
    assert [x["date"] for x in d["items"]] == ["2026-11-19", "2026-11-20"]
    assert d["items"][1]["web_revenue_tiyin"] == 4_900_000
    await env.adm("GET", "reports/daily?from=2026-01-01&to=2026-11-20", None, 400)
    await env.adm("GET", "reports/summary", perms=("dashboard.read",))
    providers = {p["provider"]: p for p in (await env.adm("GET", "providers"))["items"]}
    assert providers["payme"]["enabled"] and not providers["payme"]["configured"]  # ключей нет — «не задан»
    assert "payme_key" not in str(providers)


async def test_projection_events_and_bootstrap(env: Env) -> None:
    teen = uuid.uuid4()
    await env.publish("user.profile.updated.v1", {"user_id": str(teen), "changed_fields": ["guardian_consent"],
                                                   "age_band": "14-17", "guardian_consent": "granted"},
                      "identity-consent")
    row = await env.one("SELECT kind, age_band, guardian_consent FROM learners WHERE user_id = :u", u=teen)
    assert tuple(row) == ("account", "14-17", "granted")
    await env.publish("user.profile.updated.v1", {"user_id": str(teen), "changed_fields": ["guardian_consent"],
                                                   "guardian_consent": "declined"}, "lessons")  # чужой издатель
    assert (await env.one("SELECT guardian_consent FROM learners WHERE user_id = :u", u=teen))[0] == "granted"
    parent, child, orphan = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    env.idc.profiles = [
        {"user_id": str(parent), "kind": "account", "age_band": "18+", "guardian_consent": "not_required",
         "updated_at": env.ts()},
        {"user_id": str(child), "kind": "child", "age_band": "6-9", "guardian_consent": None,
         "updated_at": env.ts(), "guardian_user_id": str(parent)},
        {"user_id": str(orphan), "kind": "child", "age_band": "6-9", "guardian_consent": None,
         "updated_at": env.ts()}]
    r = await env.c.post("/internal/v1/projections/bootstrap", headers={"Authorization": f"Bearer {SCHEDULER_TOKEN}"})
    assert r.json() == {"profiles": {"status": "completed", "items": 3}}
    rows = {r[0]: (r[1], r[2]) for r in await env.sql("SELECT user_id, kind, account_id FROM learners")}
    assert rows[child] == ("child", parent) and orphan not in rows
    r = await env.c.post("/internal/v1/projections/bootstrap", headers={"Authorization": f"Bearer {SCHEDULER_TOKEN}"})
    assert r.json()["profiles"]["status"] == "skipped"


async def test_deletion_saga_anonymizes_and_cancels_stars_first(env: Env) -> None:
    a = await env.account()
    child = uuid.uuid4()
    await env.profile(child, kind="child", age_band="6-9", guardian=a)
    first = await _stars_sub(env, a)
    pending = await env.order(a, "til_100", "payme", expect=201)
    await env.pay.create("payme", "pm-del", str(pending["order_no"]), 500_000, env.now, {})
    await env.hold(a, minutes=10)
    # детский профиль удаляется отдельно: learner_id → NULL, строки проекции нет
    await env.lesson_done(a, (await env.hold(a, minutes=5))["hold_id"], 3)
    await env.delete(child)
    assert await env.sql("SELECT 1 FROM learners WHERE user_id = :u", u=child) == []
    await env.delete(a)
    assert env.botgw.edits[-1]["is_canceled"] is True  # до удаления данных
    for table in ("periods", "period_balances", "minute_ledger", "minute_holds", "adjustments"):
        assert (await env.one(f"SELECT count(*) FROM {table}"))[0] == 0, table  # noqa: S608
    assert (await env.one("SELECT count(*) FROM orders WHERE account_id IS NOT NULL"))[0] == 0
    assert (await env.one("SELECT status FROM orders WHERE order_no = :n", n=pending["order_no"]))[0] == "cancelled"
    assert tuple(await env.one("SELECT state, cancel_reason FROM provider_transactions WHERE provider_txn_id = "
                               "'pm-del'")) == ("cancelled", "order_closed")
    assert tuple(await env.one("SELECT account_id, status FROM stars_subscriptions")) == (None, "canceled")
    [ack] = await env.events("user.domain.deleted.v1", user_id=a)
    assert ack.payload["domain"] == "billing" and ack.payload["mode"] == "anonymized"
    # ACK — после отмены подписки Stars и удаления/обезличивания (одна транзакция с данными, outbox)
    assert env.botgw.edits and (await env.one("SELECT count(*) FROM deleted_users WHERE user_id = :u", u=a))[0] == 1
    [child_ack] = await env.events("user.domain.deleted.v1", user_id=child)
    assert child_ack.payload["domain"] == "billing"
    await env.delete(a)  # повтор — снова ACK
    assert len(await env.events("user.domain.deleted.v1", user_id=a)) == 2
    # платёж после удаления: деньги записаны, пункт сверки
    await env.pay.paid("telegram_stars", "ch-late", f"o:{first}", 250, payer_account_id=a,
                       recurring=StarsRecurrence(True, False, env.now + timedelta(days=60)), provider_time=env.now,
                       meta={})
    assert await env.sql("SELECT 1 FROM reconciliation_items WHERE kind = 'paid_after_deletion'")
    assert (await env.get(a, "subscription", 410))["code"] == "USER_DELETED"
    with pytest.raises(ports.OrderNotFound):
        await env.pay.check("payme", str(pending["order_no"]) + "0", 500_000)
    with pytest.raises(ports.OrderClosed):
        await env.pay.create("payme", "pm-after", str(pending["order_no"]), 500_000, env.now, {})
