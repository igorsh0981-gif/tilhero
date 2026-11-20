"""Кошельки в админке (§1.11, AT-72): баланс и операции, ручная операция со step-up и причиной (отдельной записью,
Idempotency-Key), обратная запись (исходная → reversed, повтор → ALREADY_REVERSED), BALANCE_NEGATIVE, возврат
покупки, аудит; комментарий сотрудника ученику не показывается."""

from __future__ import annotations

import uuid
from typing import Any

from conftest import Env


async def adjust(env: Env, user: uuid.UUID, body: dict[str, Any], expect: int = 201, key: str | None = None,
                 staff_id: str | None = None) -> dict[str, Any]:
    return dict(await env.adm("POST", f"wallets/{user}/adjustments", body, expect, key=key or f"k-{uuid.uuid4()}",
                              staff_id=staff_id))


async def test_wallet_view_and_adjustments(env: Env, user: uuid.UUID) -> None:
    await env.adm("GET", f"wallets/{user}", expect=404, perms=("game.read",))
    await env.profile(user)
    await env.lesson(user)
    w = await env.adm("GET", f"wallets/{user}", perms=("game.read",))
    assert w["audience"] == "adults" and w["freeze_stock"] == 2 and w["xp_total"] >= 20 and w["hero"] is None
    assert len(w["quests_today"]) == 3 and w["settings"] == {"auto_freeze": True, "quests_hidden": False}
    body = {"currency": "til", "amount": 50, "reason": "компенсация сбоя урока"}
    await env.adm("POST", f"wallets/{user}/adjustments", body, 403, key="k-adj-0001", step_up=False)
    await env.adm("POST", f"wallets/{user}/adjustments", body, 403, key="k-adj-0001", perms=("game.read",
                                                                                         "game.publish"))
    await env.adm("POST", f"wallets/{user}/adjustments", body, 400)
    for bad in ({**body, "reason": "коротко"}, {**body, "amount": 0}, {**body, "amount": 10_001},
                {**body, "currency": "xp", "amount": 100_001}, {**body, "currency": "gold"}):
        await adjust(env, user, bad, 422)
    await adjust(env, uuid.uuid4(), body, 404)
    op = await adjust(env, user, body, key="k-adj-0001", staff_id="staff-a")
    assert op["reason"] == "manual" and op["amount"] == 50 and op["actor"] == "staff:staff-a"
    assert op["comment"] == "компенсация сбоя урока" and op["source"]["kind"] == "staff"
    again = await adjust(env, user, body, 200, key="k-adj-0001", staff_id="staff-a")
    assert again == op
    await adjust(env, user, {**body, "amount": 51}, 422, key="k-adj-0001", staff_id="staff-a")
    til = (await env.wallet(user))["til"]
    out = await adjust(env, user, {"currency": "til", "amount": -(til + 1), "reason": "списание ошибки"}, 409)
    assert out["code"] == "BALANCE_NEGATIVE"
    out = await adjust(env, user, {"currency": "freeze", "amount": -3, "reason": "списание ошибки"}, 409)
    assert out["code"] == "BALANCE_NEGATIVE"
    await adjust(env, user, {"currency": "freeze", "amount": -2, "reason": "списание ошибки"})
    xp_up = await adjust(env, user, {"currency": "xp", "amount": 300, "reason": "перенос прогресса"})
    assert xp_up["currency"] == "xp" and (await env.wallet(user))["level"] == 3
    # реестр для сотрудника — со всеми полями; ученику — без комментария
    page = await env.adm("GET", f"wallets/{user}/ledger?limit=2", perms=("game.read",))
    assert len(page["items"]) == 2 and page["next_cursor"]
    page2 = await env.adm("GET", f"wallets/{user}/ledger?limit=50&cursor={page['next_cursor']}", perms=("game.read",))
    ids = [o["op_id"] for o in page["items"] + page2["items"]]
    assert len(ids) == len(set(ids)) == len(await env.ops(user, bonus=True))
    tils = await env.adm("GET", f"wallets/{user}/ledger?currency=til", perms=("game.read",))
    assert {o["currency"] for o in tils["items"]} == {"til"}
    await env.adm("GET", f"wallets/{user}/ledger?cursor=garbage", expect=400, perms=("game.read",))
    hist = await env.get(user, "history")
    manual = [i for i in hist["items"] if i["reason"] == "manual"]
    assert manual and all("comment" not in i and "actor" not in i for i in hist["items"])
    audits = [e for e in await env.events("admin.audit.recorded.v1") if e.payload["action"] == "game.wallet.adjusted"]
    assert len(audits) == 3 and audits[0].payload["reason"] == "компенсация сбоя урока"
    assert audits[0].payload["object_id"] == str(user)


async def test_reverse_operation(env: Env, user: uuid.UUID) -> None:
    await env.send("PATCH", user, "settings", {"quests_hidden": True})
    await env.lesson(user)
    [xp_op, til_op] = await env.ops(user)
    reason = {"reason": "урок засчитан по ошибке"}
    await env.adm("POST", f"wallets/{user}/ledger/{xp_op.op_id}/reverse", reason, 403, step_up=False)
    other = uuid.uuid4()
    await env.ensure(other)
    await env.adm("POST", f"wallets/{other}/ledger/{xp_op.op_id}/reverse", reason, 404)  # чужая операция
    await env.adm("POST", f"wallets/{user}/ledger/{xp_op.op_id}/reverse", {"reason": "кратко"}, 422)
    rev = await env.adm("POST", f"wallets/{user}/ledger/{xp_op.op_id}/reverse", reason)
    assert rev["reason"] == "reversal" and rev["amount"] == -20 and rev["reversal_of"] == str(xp_op.op_id)
    rows = await env.sql("SELECT status, reversed_by FROM ledger WHERE op_id = :o", o=xp_op.op_id)
    assert rows == [("reversed", uuid.UUID(rev["op_id"]))]
    out = await env.adm("POST", f"wallets/{user}/ledger/{xp_op.op_id}/reverse", reason, 409)
    assert out["code"] == "ALREADY_REVERSED"
    out = await env.adm("POST", f"wallets/{user}/ledger/{rev['op_id']}/reverse", reason, 409)
    assert out["code"] == "OPERATION_NOT_REVERSIBLE"
    # обратная запись тилов не уводит баланс в минус
    await env.grant(user, "til", 35)
    await env.buy(user, "streak_freeze")  # 40 тилов → 0
    out = await env.adm("POST", f"wallets/{user}/ledger/{til_op.op_id}/reverse", reason, 409)
    assert out["code"] == "BALANCE_NEGATIVE"
    shop_op = next(o for o in await env.ops(user) if o.reason == "shop")
    out = await env.adm("POST", f"wallets/{user}/ledger/{shop_op.op_id}/reverse", reason, 409)
    assert out["code"] == "OPERATION_NOT_REVERSIBLE" and out["details"]["hint"] == "refund"
    w = await env.wallet(user)
    [(xp, til, fr)] = await env.sql("SELECT sum(amount) FILTER (WHERE currency='xp'), sum(amount) FILTER "
                                    "(WHERE currency='til'), sum(amount) FILTER (WHERE currency='freeze') FROM "
                                    "ledger WHERE user_id = :u", u=user)
    assert (w["xp"], w["til"], w["freeze"]) == (xp, til, fr) == (0, 0, 2 + 1)  # бонус регистрации + покупка
    hist = (await env.get(user, "history"))["items"]
    assert [i["status"] for i in hist if i["op_id"] == str(xp_op.op_id)] == ["reversed"]


async def test_refund_purchase(env: Env, user: uuid.UUID) -> None:
    await env.grant(user, "til", 200)
    p = await env.buy(user, "frame_gold")
    await env.send("PUT", user, "equipment", {"background_code": None, "frame_code": "frame_gold"})
    reason = {"reason": "купил по ошибке, возврат"}
    await env.adm("POST", f"wallets/{user}/purchases/{p['purchase_id']}/refund", reason, 403, step_up=False)
    await env.adm("POST", f"wallets/{user}/purchases/{uuid.uuid4()}/refund", reason, 404)
    out = await env.adm("POST", f"wallets/{user}/purchases/{p['purchase_id']}/refund", reason)
    assert [(o["currency"], o["amount"], o["reason"]) for o in out["operations"]] == [("til", 150, "reversal")]
    assert (await env.wallet(user))["til"] == 200
    s = await env.get(user, "summary")
    assert s["equipment"]["frame"] is None
    assert not {i["code"]: i for i in (await env.get(user, "shop"))["items"]}["frame_gold"]["owned"]
    assert (await env.adm("POST", f"wallets/{user}/purchases/{p['purchase_id']}/refund", reason, 409))["code"] == \
        "ALREADY_REVERSED"
    await env.buy(user, "frame_gold")  # после возврата можно купить снова
    # возврат заморозки, которую уже потратили, — баланс заморозок не уходит в минус
    await env.grant(user, "freeze", -2)  # бонус регистрации
    f = await env.buy(user, "streak_freeze")
    await env.missed(user)
    out = await env.adm("POST", f"wallets/{user}/purchases/{f['purchase_id']}/refund", reason, 409)
    assert out["code"] == "BALANCE_NEGATIVE"
    [(status,)] = await env.sql("SELECT status FROM purchases WHERE purchase_id = :p", p=uuid.UUID(f["purchase_id"]))
    assert status == "completed"
    audit = [e for e in await env.events("admin.audit.recorded.v1") if e.payload["action"] == "game.purchase.refunded"]
    assert len(audit) == 1 and audit[0].payload["reason"] == "купил по ошибке, возврат"
