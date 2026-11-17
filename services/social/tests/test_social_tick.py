"""invites:tick (AT-10): одно напоминание через 24 ч после открытия без ответа; истёкшие → expired; повтор и
параллельные запуски без дублей; вход только по SCHEDULER_TOKEN."""

from __future__ import annotations

import asyncio
from datetime import timedelta

from pydantic import SecretStr


async def test_scheduler_auth(env) -> None:
    path = "/internal/v1/invites:tick"
    me = env.identity.add()
    r = await env.c.post(path)
    assert r.status_code == 401 and r.json()["code"] == "SCHEDULER_TOKEN_INVALID"
    assert (await env.c.post(path, headers={"authorization": "Bearer nope"})).status_code == 401
    for issuer in ("telegram-bff", "notifications"):
        r = await env.c.post(path, headers=env.h(me, issuer=issuer))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    assert (await env.c.post(path, headers=env.sched)).status_code == 200
    env.settings.scheduler_token = SecretStr("")
    assert (await env.c.post(path, headers=env.sched)).status_code == 401


async def test_one_reminder_24h_after_open(env) -> None:
    inviter, guest = env.identity.add(), env.identity.add()
    iid, token = await env.invite(inviter, "friend")
    await env.open(guest, token)
    env.now += timedelta(hours=23, minutes=59)
    assert await env.tick() == {"reminders": 0, "expired": 0}
    env.now += timedelta(minutes=1)
    assert await env.tick() == {"reminders": 1, "expired": 0}
    env.now += timedelta(hours=1)
    assert await env.tick() == {"reminders": 0, "expired": 0}  # одно на получателя
    [ev] = await env.events("social.invite.reminder_due.v1")
    assert ev.payload == {"invite_id": iid, "inviter_user_id": str(inviter), "invitee_user_id": str(guest),
                          "kind": "friend"}
    # карточка из напоминания (startapp=invite_<id>) доступна получателю
    r = await env.c.get(f"/internal/v1/invites/{iid}/preview", headers=env.h(guest))
    assert r.status_code == 200 and r.json()["can_accept"] is True


async def test_no_reminder_when_answered_or_inactive(env) -> None:
    inviter = env.identity.add()
    answered, declined, revoked_guest, expired_guest, used_guest, pending = (env.identity.add() for _ in range(6))
    a_id, a_tok = await env.invite(inviter, "friend")
    d_id, d_tok = await env.invite(inviter, "friend")
    r_id, r_tok = await env.invite(inviter, "friend")
    f_id, f_tok = await env.invite(inviter, "family")
    ref_id, ref_tok = await env.invite(inviter, "referral")
    await env.open(answered, a_tok)
    await env.accept(answered, a_id)
    await env.open(declined, d_tok)
    await env.decline(declined, d_id)
    await env.open(revoked_guest, r_tok)
    await env.c.delete(f"/internal/v1/me/invites/{r_id}", headers=env.h(inviter))
    await env.open(expired_guest, f_tok)
    await env.open(used_guest, ref_tok)
    await env.accept(used_guest, ref_id)
    env.now += timedelta(days=6)
    await env.open(pending, ref_tok)  # реферальная многоразовая — ждёт ответа
    env.now += timedelta(days=1, hours=1)  # семейное истекло (7 дней), pending открыл 25 ч назад
    assert await env.tick() == {"reminders": 1, "expired": 1}
    [ev] = await env.events("social.invite.reminder_due.v1")
    assert ev.payload["invitee_user_id"] == str(pending) and ev.payload["kind"] == "referral"
    [(status,)] = await env.sql("SELECT status FROM invites WHERE invite_id = :i", i=f_id)
    assert status == "expired"
    assert (await env.tick())["expired"] == 0


async def test_old_opens_are_not_reminded(env) -> None:
    inviter, guest = env.identity.add(), env.identity.add()
    _, token = await env.invite(inviter, "referral")
    await env.open(guest, token)
    env.now += timedelta(days=8)  # планировщик простаивал больше недели
    assert (await env.tick())["reminders"] == 0


async def test_concurrent_ticks_do_not_duplicate(env) -> None:
    inviter = env.identity.add()
    _, token = await env.invite(inviter, "referral")
    for _ in range(5):
        await env.open(env.identity.add(), token)
    env.now += timedelta(days=1)
    results = await asyncio.gather(*[env.c.post("/internal/v1/invites:tick", headers=env.sched) for _ in range(3)])
    assert sum(r.json()["reminders"] for r in results) == 5
    assert len(await env.events("social.invite.reminder_due.v1")) == 5
