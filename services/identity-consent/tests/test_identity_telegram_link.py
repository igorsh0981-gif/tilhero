"""Спринт 8 (INTERNAL_API §9): связь Telegram ID ↔ аккаунт для telegram-bot-gateway (Stars) и telegram-bff (вход на
сайт оплаты); порядок удаления Telegram ID в саге (после ACK billing); `guardian_user_id` в выгрузке профилей.

- `GET /internal/v1/telegram-users/{telegram_user_id}/account` → `{account_id, age_band, guardian_consent, status}`
  (bot-gateway, telegram-bff; без `sub`); детский профиль, обезличенный, неизвестный — 404 USER_NOT_FOUND;
- `GET /internal/v1/accounts/{account_id}/telegram-user` → `{telegram_user_id}` (только bot-gateway, без `sub`);
  удаляемый аккаунт отдаётся до ACK billing.
"""

from __future__ import annotations

import io
import logging
import random
import uuid

import pytest
from deletion_kit import CONFIRM, DOMAINS, ack_all, request_deletion
from test_identity_guardian_grants import _granted_teen

from tilhero_common.logging import JsonFormatter

ACCOUNT = "/internal/v1/telegram-users/{tg}/account"
TELEGRAM_USER = "/internal/v1/accounts/{uid}/telegram-user"
ACCOUNT_FIELDS = {"account_id", "age_band", "guardian_consent", "status"}


def _tg() -> int:
    return random.randint(10**9, 10**11)


async def _account(env, tg: int, issuer: str = "telegram-bot-gateway"):
    return await env.call("GET", ACCOUNT.format(tg=tg), None, issuer=issuer)


async def _telegram_user(env, uid: str, issuer: str = "telegram-bot-gateway"):
    return await env.call("GET", TELEGRAM_USER.format(uid=uid), None, issuer=issuer)


async def test_account_by_telegram_id(env) -> None:
    tg_adult, tg_teen, tg_young, tg_new = _tg(), _tg(), _tg(), _tg()
    adult = await env.adult(telegram_user_id=tg_adult)
    parent = await env.parent()
    teen = await _granted_teen(env, parent, telegram_user_id=tg_teen)
    young = await env.teen(telegram_user_id=tg_young)  # 14–17 без согласия родителя
    fresh = await env.new_user(telegram_user_id=tg_new)  # возраст ещё не выбран
    for issuer in ("telegram-bot-gateway", "telegram-bff"):
        r = await _account(env, tg_adult, issuer)
        assert r.status_code == 200, r.text
        assert r.json() == {"account_id": adult, "age_band": "18+", "guardian_consent": "not_required",
                            "status": "ACTIVE"}
        assert r.headers["cache-control"] == "no-store"
        assert str(tg_adult) not in r.text  # Telegram ID в ответе не возвращается
    assert (await _account(env, tg_teen)).json() == {
        "account_id": teen, "age_band": "14-17", "guardian_consent": "granted", "status": "ACTIVE"}
    body = (await _account(env, tg_young)).json()
    assert set(body) == ACCOUNT_FIELDS
    assert (body["account_id"], body["age_band"]) == (young, "14-17") and body["guardian_consent"] != "granted"
    assert (await _account(env, tg_new)).json() == {
        "account_id": fresh, "age_band": None, "guardian_consent": "not_required", "status": "ACTIVE"}


async def test_account_by_telegram_id_disabled_and_unknown(env) -> None:
    tg = _tg()
    uid = await env.adult(telegram_user_id=tg)
    r = await env.call("POST", "/internal/v1/me/disable", uid)
    assert r.status_code == 200, r.text
    assert (await _account(env, tg)).json()["status"] == "DISABLED"
    missing = await _account(env, _tg())
    assert missing.status_code == 404 and missing.json()["code"] == "USER_NOT_FOUND"


async def test_telegram_id_of_account(env) -> None:
    tg = _tg()
    uid = await env.adult(telegram_user_id=tg)
    r = await _telegram_user(env, uid)
    assert r.status_code == 200, r.text
    assert r.json() == {"telegram_user_id": tg}
    assert r.headers["cache-control"] == "no-store"
    # детский профиль: своего Telegram нет — 404 (не Telegram ID опекуна)
    child = (await env.child(uid))["learner_id"]
    r = await _telegram_user(env, child)
    assert r.status_code == 404 and r.json()["code"] == "USER_NOT_FOUND"
    r = await _telegram_user(env, str(uuid.uuid4()))
    assert r.status_code == 404 and r.json()["code"] == "USER_NOT_FOUND"
    assert (await env.call("GET", "/internal/v1/accounts/not-a-uuid/telegram-user", None,
                           issuer="telegram-bot-gateway")).status_code == 422


@pytest.mark.parametrize("caller", ["social", "notifications", "billing", "gamification", "lessons", "user-admin"])
async def test_account_lookup_callers(env, caller: str) -> None:
    tg = _tg()
    uid = await env.adult(telegram_user_id=tg)
    r = await _account(env, tg, caller)
    assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    r = await _telegram_user(env, uid, caller)
    assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"


async def test_telegram_user_only_bot_gateway_and_no_user_context(env) -> None:
    tg = _tg()
    uid = await env.adult(telegram_user_id=tg)
    # telegram-bff переводит Telegram ID в аккаунт (вход на сайт), но обратного перевода не получает
    r = await _telegram_user(env, uid, "telegram-bff")
    assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    # без токена — 401
    assert (await env.client.get(ACCOUNT.format(tg=tg))).status_code == 401
    assert (await env.client.get(TELEGRAM_USER.format(uid=uid))).status_code == 401
    bad = {"X-Internal-Token": "not-a-jwt"}
    assert (await env.client.get(ACCOUNT.format(tg=tg), headers=bad)).status_code == 401
    # служебный вызов — без контекста ученика (`sub` → 403)
    for issuer, path in (("telegram-bot-gateway", ACCOUNT.format(tg=tg)),
                         ("telegram-bff", ACCOUNT.format(tg=tg)),
                         ("telegram-bot-gateway", TELEGRAM_USER.format(uid=uid))):
        r = await env.client.get(path, headers=env.h(uid, issuer=issuer))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_CONTEXT_NOT_ALLOWED", (issuer, path)


@pytest.mark.parametrize("raw", ["0", "-5", "abc", "1.5", str(2**63)])
async def test_account_lookup_invalid_telegram_id(env, raw: str) -> None:
    r = await env.call("GET", f"/internal/v1/telegram-users/{raw}/account", None, issuer="telegram-bot-gateway")
    assert r.status_code == 422, raw


async def test_child_has_no_telegram_lookup(env) -> None:
    """Детский профиль нельзя найти по Telegram ID опекуна: возвращается сам аккаунт опекуна."""
    tg = _tg()
    guardian = await env.adult(telegram_user_id=tg)
    await env.child(guardian)
    assert (await _account(env, tg)).json()["account_id"] == guardian


async def test_deletion_order_telegram_id_lives_until_billing_ack(env) -> None:
    """INTERNAL_API §9 и §1.16: Telegram ID снимается последним — после ACK billing (bot-gateway успевает отменить
    подписку Stars по account_id). Пока профиль удаляется, перевод работает в обе стороны, со статусом."""
    assert "billing" in env.settings.deletion_domains and "billing" in DOMAINS
    tg = _tg()
    uid, rid = await request_deletion(env, telegram_user_id=tg)
    body = (await _account(env, tg)).json()
    assert body["account_id"] == uid and body["status"] == "DELETION_REQUESTED"
    assert (await _telegram_user(env, uid)).json() == {"telegram_user_id": tg}
    # все домены, кроме billing, подтвердили — Telegram ID ещё на месте
    await ack_all(env, uid, rid, [d for d in DOMAINS if d != "billing"])
    assert (await env.user_row(uid)).status == "DELETION_REQUESTED"
    assert (await _telegram_user(env, uid)).json() == {"telegram_user_id": tg}
    assert (await _account(env, tg)).status_code == 200
    # ACK billing — обезличивание: перевода больше нет
    await ack_all(env, uid, rid, ["billing"])
    row = await env.user_row(uid)
    assert row.status == "DELETED" and row.telegram_user_id is None
    for r in (await _account(env, tg), await _telegram_user(env, uid)):
        assert r.status_code == 404 and r.json()["code"] == "USER_NOT_FOUND"
    # ACK billing принимается только от billing
    events = await env.events("user.domain.deleted.v1", uid)
    assert any(e.payload["domain"] == "identity-consent" for e in events)


async def test_billing_ack_from_other_producer_ignored(env) -> None:
    from tilhero_common.messaging import make_envelope

    tg = _tg()
    uid, rid = await request_deletion(env, telegram_user_id=tg)
    await ack_all(env, uid, rid, [d for d in DOMAINS if d != "billing"])
    forged = make_envelope("user.domain.deleted.v1",
                           {"user_id": uid, "request_id": rid, "domain": "billing", "mode": "anonymized"},
                           producer="gamification")
    await env.bus.publish(forged)
    await env.flush()
    assert (await env.user_row(uid)).telegram_user_id == tg
    assert (await _telegram_user(env, uid)).status_code == 200


async def test_relogin_after_deletion_is_new_account(env) -> None:
    tg = _tg()
    uid, rid = await request_deletion(env, telegram_user_id=tg)
    await ack_all(env, uid, rid)
    fresh = await env.new_user(telegram_user_id=tg)
    assert fresh != uid
    assert (await _account(env, tg)).json()["account_id"] == fresh
    assert (await _telegram_user(env, uid)).status_code == 404


async def test_telegram_id_not_logged(env) -> None:
    tg = 7_070_707_071
    uid = await env.adult(telegram_user_id=tg)
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter("identity-consent"))
    logging.getLogger().addHandler(handler)
    try:
        await _account(env, tg)
        await _account(env, tg, "social")
        await _telegram_user(env, uid)
        await env.call("GET", "/internal/v1/telegram-users/7070707072/account", None, issuer="telegram-bff")
    finally:
        logging.getLogger().removeHandler(handler)
    logs = stream.getvalue()
    assert "/internal/v1/telegram-users/{telegram_user_id}/account" in logs
    assert "/internal/v1/accounts/{account_id}/telegram-user" in logs
    assert str(tg) not in logs and "7070707072" not in logs


async def test_export_profiles_guardian_and_billing_caller(env) -> None:
    parent = await env.parent()
    child = (await env.child(parent, "Мадина", "6-9"))["learner_id"]
    items: list[dict] = []
    cursor = None
    while True:
        path = "/internal/v1/export/profiles?limit=1000" + (f"&cursor={cursor}" if cursor else "")
        r = await env.call("GET", path, None, issuer="billing")
        assert r.status_code == 200, r.text
        items += r.json()["items"]
        cursor = r.json()["next_cursor"]
        if cursor is None:
            break
    rows = {i["user_id"]: i for i in items}
    assert rows[child]["guardian_user_id"] == parent and rows[child]["kind"] == "child"
    assert rows[parent]["guardian_user_id"] is None
    # billing — служебный вызов без контекста ученика
    r = await env.client.get("/internal/v1/export/profiles", headers=env.h(parent, issuer="billing"))
    assert r.status_code == 403 and r.json()["code"] == "CALLER_CONTEXT_NOT_ALLOWED"
    # удаляемый ребёнок не выгружается
    r = await env.call("POST", "/internal/v1/me/deletion-request", parent, CONFIRM)
    assert r.status_code == 202
    r = await env.call("GET", "/internal/v1/export/profiles?limit=1000", None, issuer="billing")
    assert child not in {i["user_id"] for i in r.json()["items"]}
