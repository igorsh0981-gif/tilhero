"""«Четыре глаза» (§1.13, AT-95): заявка (subscriptions.override + step-up) → подтверждение другим сотрудником
(billing.approve + step-up), автор не подтверждает (SELF_APPROVAL), баланс не в минус, выдача и отзыв периода,
отклонение, отзыв автором, истечение 72 ч, гонка двух решений, аудит обоих сотрудников."""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

from conftest import Env


async def _setup(env: Env) -> tuple[uuid.UUID, str]:
    a = await env.account()
    await env.trial(a)
    pid = (await env.one("SELECT period_id FROM periods WHERE account_id = :a", a=a))[0]
    return a, str(pid)


async def test_minutes_adjustment_needs_another_staff(env: Env) -> None:
    a, pid = await _setup(env)
    author, approver = str(uuid.uuid4()), str(uuid.uuid4())
    body: dict[str, Any] = {"kind": "minutes", "minutes": 30, "period_id": pid, "reason": "компенсация сбоя ИИ"}
    await env.adm("POST", f"accounts/{a}/adjustments", body, 403, step_up=False, key="k-adj-001")
    await env.adm("POST", f"accounts/{a}/adjustments", body, 403, perms=("billing.approve",), key="k-adj-001")
    adj = await env.adm("POST", f"accounts/{a}/adjustments", body, 202, key="k-adj-001", staff_id=author)
    assert adj["status"] == "pending" and adj["can_cancel"] and not adj["can_decide"]
    again = await env.adm("POST", f"accounts/{a}/adjustments", body, 202, key="k-adj-001", staff_id=author)
    assert again["adjustment_id"] == adj["adjustment_id"]
    r = await env.adm("POST", f"adjustments/{adj['adjustment_id']}/approve", {}, 409, staff_id=author)
    assert r["code"] == "SELF_APPROVAL"
    await env.adm("POST", f"adjustments/{adj['adjustment_id']}/approve", {}, 403, step_up=False, staff_id=approver)
    done = await env.adm("POST", f"adjustments/{adj['adjustment_id']}/approve", {}, staff_id=approver)
    assert done["status"] == "applied" and done["decided_by"]["staff_id"] == approver
    assert done["before_value"]["minutes_left"] == 60 and done["after_value"]["minutes_left"] == 90
    assert (await env.balance(a))["left"] == 90
    led = await env.one("SELECT kind, minutes, actor, ref_kind FROM minute_ledger WHERE kind = 'adjust'")
    assert tuple(led) == ("adjust", 30, f"staff:{approver}", "adjustment")
    [ev] = await env.events("billing.adjustment.applied.v1")
    assert ev.payload["minutes"] == 30 and ev.payload["kind"] == "minutes"
    [audit] = [e for e in await env.events("admin.audit.recorded.v1")
               if e.payload["action"] == "billing.adjustment_approved"]
    assert audit.payload["actor_id"] == approver and audit.payload["after"]["requested_by"] == author
    await env.adm("POST", f"adjustments/{adj['adjustment_id']}/approve", {}, 409, staff_id=str(uuid.uuid4()))
    # ученику — запись «начислено поддержкой» без комментария сотрудника
    hist = (await env.get(a, "minutes"))["items"]
    assert hist[0]["kind"] == "adjust" and "reason" not in hist[0]


async def test_negative_reject_cancel_expire_and_race(env: Env) -> None:
    a, pid = await _setup(env)
    r = await env.adm("POST", f"accounts/{a}/adjustments", {"kind": "minutes", "minutes": -61, "period_id": pid,
                                                            "reason": "снять лишние минуты"}, 409, key="k-adj-002")
    assert r["code"] == "BALANCE_NEGATIVE"
    r = await env.adm("POST", f"accounts/{a}/adjustments", {"kind": "minutes", "minutes": 5,
                                                            "reason": "без периода нельзя"}, 422, key="k-adj-003")
    assert r["code"] == "ADJUSTMENT_INVALID"
    await env.adm("POST", f"accounts/{uuid.uuid4()}/adjustments",
                  {"kind": "grant_period", "days": 7, "minutes": 60, "reason": "неизвестный аккаунт"}, 404,
                  key="k-adj-004")
    author = str(uuid.uuid4())
    neg = await env.adm("POST", f"accounts/{a}/adjustments", {"kind": "minutes", "minutes": -20, "period_id": pid,
                                                              "reason": "снять 20 минут"}, 202, key="k-adj-005",
                        staff_id=author)
    rej = await env.adm("POST", f"adjustments/{neg['adjustment_id']}/reject", {"note": "нет оснований"})
    assert rej["status"] == "rejected" and (await env.balance(a))["left"] == 60
    c = await env.adm("POST", f"accounts/{a}/adjustments", {"kind": "minutes", "minutes": 10, "period_id": pid,
                                                            "reason": "отменю сам"}, 202, key="k-adj-006",
                      staff_id=author)
    await env.adm("POST", f"adjustments/{c['adjustment_id']}/cancel", None, 404)  # не автор
    assert (await env.adm("POST", f"adjustments/{c['adjustment_id']}/cancel", None, staff_id=author))["status"] \
        == "cancelled"
    old = await env.adm("POST", f"accounts/{a}/adjustments", {"kind": "minutes", "minutes": 10, "period_id": pid,
                                                              "reason": "истечёт через 72 ч"}, 202, key="k-adj-007",
                        staff_id=author)
    env.shift(hours=73)
    await env.tick()
    rows = await env.adm("GET", "adjustments")
    assert {i["adjustment_id"]: i["status"] for i in rows["items"]}[old["adjustment_id"]] == "expired"
    # две решающие одновременно — одна применяет, вторая 409
    b, pid_b = await _setup(env)
    g = await env.adm("POST", f"accounts/{b}/adjustments", {"kind": "minutes", "minutes": 15, "period_id": pid_b,
                                                            "reason": "гонка решений"}, 202, key="k-adj-008",
                      staff_id=author)
    h1, h2 = env.staff(), env.staff()
    rs = await asyncio.gather(*[env.c.post(f"/internal/v1/admin/billing/adjustments/{g['adjustment_id']}/approve",
                                           json={}, headers=h) for h in (h1, h2)])
    assert sorted(r.status_code for r in rs) == [200, 409]
    assert (await env.balance(b))["left"] == 75


async def test_grant_and_revoke_period(env: Env) -> None:
    a = await env.account()
    author = str(uuid.uuid4())
    g = await env.adm("POST", f"accounts/{a}/adjustments", {"kind": "grant_period", "days": 14, "minutes": 120,
                                                            "reason": "подарок поддержки"}, 202, key="k-adj-010",
                      staff_id=author)
    done = await env.adm("POST", f"adjustments/{g['adjustment_id']}/approve", {"note": "ок"})
    assert done["status"] == "applied"
    view = await env.get(a, "subscription")
    assert view["status"] == "active" and view["plan"]["code"] == "grant" and view["period"]["minutes_left"] == 120
    pid = (await env.one("SELECT period_id FROM periods WHERE account_id = :a AND source = 'grant'", a=a))[0]
    rv = await env.adm("POST", f"accounts/{a}/adjustments", {"kind": "revoke_period", "period_id": str(pid),
                                                             "reason": "выдано по ошибке"}, 202, key="k-adj-011",
                       staff_id=author)
    await env.adm("POST", f"adjustments/{rv['adjustment_id']}/approve", {})
    row = await env.one("SELECT status, close_reason FROM periods WHERE period_id = :p", p=pid)
    assert tuple(row) == ("revoked", "staff")
    led = await env.one("SELECT minutes, idempotency_key FROM minute_ledger WHERE kind = 'revoke'")
    assert led[0] == -120 and led[1] == f"revoke:{pid}:{rv['adjustment_id']}"
    card = await env.adm("GET", f"accounts/{a}")
    assert card["status"] == "expired" and card["periods"][0]["close_reason"] == "staff"
    ledger = await env.adm("GET", f"accounts/{a}/ledger")
    assert [i["kind"] for i in ledger["items"]] == ["revoke", "grant"]


async def test_staff_commands_replay_same_answer_by_idempotency_key(env: Env) -> None:
    """Урок спринта 7 (поток F): повтор после потерянного ответа с тем же Idempotency-Key — тот же ответ, а не 409/404;
    отзыв заявки — автор с subscriptions.override."""
    a, pid = await _setup(env)
    author, approver = str(uuid.uuid4()), str(uuid.uuid4())
    body = {"kind": "minutes", "minutes": 5, "period_id": pid, "reason": "повтор решения"}
    adj = await env.adm("POST", f"accounts/{a}/adjustments", body, 202, key="k-adj-rep-1", staff_id=author)
    first = await env.adm("POST", f"adjustments/{adj['adjustment_id']}/approve", {}, key="k-dec-rep-1",
                          staff_id=approver)
    h = {**env.staff(staff_id=approver), "Idempotency-Key": "k-dec-rep-1"}
    r = await env.c.post(f"/internal/v1/admin/billing/adjustments/{adj['adjustment_id']}/approve", json={}, headers=h)
    assert r.status_code == 200 and r.json() == first and r.headers["idempotent-replayed"] == "true"
    await env.adm("POST", f"adjustments/{adj['adjustment_id']}/approve", {}, 409, staff_id=approver)  # без ключа
    await env.adm("POST", f"adjustments/{adj['adjustment_id']}/approve", {"note": "другое тело"}, 422,
                  key="k-dec-rep-1", staff_id=approver)
    assert (await env.balance(a))["left"] == 65  # применено один раз
    # отзыв: нужен subscriptions.override; повтор — тот же ответ
    c = await env.adm("POST", f"accounts/{a}/adjustments", {**body, "reason": "отзову сам"}, 202,
                      key="k-adj-rep-2", staff_id=author)
    await env.adm("POST", f"adjustments/{c['adjustment_id']}/cancel", None, 403, perms=("billing.read",),
                  staff_id=author)
    one = await env.adm("POST", f"adjustments/{c['adjustment_id']}/cancel", None, key="k-cancel-rep",
                        staff_id=author)
    assert await env.adm("POST", f"adjustments/{c['adjustment_id']}/cancel", None, key="k-cancel-rep",
                         staff_id=author) == one
    # каталог: активация и откат повторяются тем же ответом
    staff = str(uuid.uuid4())
    v1 = await env.adm("GET", "catalog/1")
    await env.adm("PUT", "catalog/draft", {"payload": v1["payload"], "comment": None})
    await env.adm("POST", "catalog/draft/validate")
    act = await env.adm("POST", "catalog/draft/activate", {"comment": "повтор активации"}, key="k-act-rep",
                        staff_id=staff)
    assert await env.adm("POST", "catalog/draft/activate", {"comment": "повтор активации"}, key="k-act-rep",
                         staff_id=staff) == act
    rb = await env.adm("POST", "catalog/1/rollback", {"comment": "повтор отката"}, key="k-rb-rep", staff_id=staff)
    assert await env.adm("POST", "catalog/1/rollback", {"comment": "повтор отката"}, key="k-rb-rep",
                         staff_id=staff) == rb
    assert [v["status"] for v in (await env.adm("GET", "catalog"))["items"]].count("active") == 1
    assert len((await env.adm("GET", "catalog"))["items"]) == 3  # откат один раз
    # курс и массовая выдача пробного
    fx = {"usd_in_tiyin": 1_280_000, "valid_from": "2026-11-01", "reason": "курс ЦБ на 1-е"}
    assert await env.adm("PUT", "fx", fx, key="k-fx-rep", staff_id=staff) == \
        await env.adm("PUT", "fx", fx, key="k-fx-rep", staff_id=staff)
    env.settings.trial_on_enforcement = True
    try:
        await env.account()
        g1 = await env.adm("POST", "trials:grant-all", {"reason": "включаем пэйвол"}, key="k-grant-rep",
                           staff_id=staff)
        assert g1["granted"] >= 1
        assert await env.adm("POST", "trials:grant-all", {"reason": "включаем пэйвол"}, key="k-grant-rep",
                             staff_id=staff) == g1
    finally:
        env.settings.trial_on_enforcement = False
