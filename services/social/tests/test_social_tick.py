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


async def test_no_reminder_to_who_cannot_accept_now(env) -> None:
    """D-02 / P-5: напоминание — только тому, у кого карточка сейчас показала бы can_accept=true (и есть согласие
    с политикой). Подросток без согласия родителя, уже друзья, уже в семье, реферал уже использован, согласие
    отозвано — без напоминания."""
    inviter, other = env.identity.add("Азиза"), env.identity.add("Бобур")
    teen = env.identity.add("Тимур", age="14-17")
    friend, member, used, revoked, ok = (env.identity.add() for _ in range(5))
    # подросток без согласия родителя открыл приглашение: карточка «принять нельзя»
    _, t_tok = await env.invite(inviter, "friend")
    r = await env.open(teen, t_tok)
    assert r.json()["can_accept"] is False and r.json()["reason"] == "not_allowed"
    # уже друзья: приняли одно приглашение, открыли второе
    f1, f1_tok = await env.invite(inviter, "friend")
    await env.open(friend, f1_tok)
    assert (await env.accept(friend, f1)).status_code == 200
    _, ref_tok = await env.invite(inviter, "referral")
    assert (await env.open(friend, ref_tok)).json()["reason"] == "already_friends"
    # уже в семье пригласившего: второе семейное приглашение
    m1, m1_tok = await env.invite(inviter, "family")
    await env.open(member, m1_tok)
    assert (await env.accept(member, m1)).status_code == 200
    _, m2_tok = await env.invite(inviter, "family")
    assert (await env.open(member, m2_tok)).json()["reason"] == "already_member"
    # реферал уже использован (принят чужой), открыт второй
    o_ref, o_ref_tok = await env.invite(other, "referral")
    await env.open(used, o_ref_tok)
    assert (await env.accept(used, o_ref)).status_code == 200
    assert (await env.open(used, ref_tok)).json()["reason"] == "already_used"
    # согласие отозвано после открытия
    await env.open(revoked, ref_tok)
    env.identity.set_consent(revoked, False)
    # и тот, кто может принять
    await env.open(ok, ref_tok)
    env.now += timedelta(hours=25)
    assert await env.tick() == {"reminders": 1, "expired": 0}
    [ev] = await env.events("social.invite.reminder_due.v1")
    assert ev.payload["invitee_user_id"] == str(ok)
    # отложенные не помечены: подросток получил согласие родителя — напоминание в следующий tick, одно
    await env.grant_guardian_consent(teen)
    env.now += timedelta(hours=1)
    assert await env.tick() == {"reminders": 1, "expired": 0}
    env.now += timedelta(hours=1)
    assert await env.tick() == {"reminders": 0, "expired": 0}
    reminded = [e.payload["invitee_user_id"] for e in await env.events("social.invite.reminder_due.v1")]
    assert reminded == [str(ok), str(teen)]
    [(n,)] = await env.sql("SELECT count(*) FROM invite_redemptions WHERE reminded_at IS NULL "
                           "AND accepted_at IS NULL AND declined_at IS NULL")
    assert n == 4  # друг, участник семьи, использованный реферал, отозванное согласие — ждут, не помечены


async def test_identity_unavailable_defers_reminder(env) -> None:
    inviter, guest = env.identity.add(), env.identity.add()
    _, token = await env.invite(inviter, "friend")
    await env.open(guest, token)
    env.now += timedelta(hours=25)
    env.identity.down = True
    assert await env.tick() == {"reminders": 0, "expired": 0}  # без профиля — не напоминаем, tick не падает
    env.identity.down = False
    env.now += timedelta(hours=1)
    assert await env.tick() == {"reminders": 1, "expired": 0}


async def test_deferred_rows_do_not_starve_others(env) -> None:
    """Отложенные строки не помечаются, поэтому tick просматривает кандидатов целиком, а не первые N."""
    env.settings.tick_batch_size = 10
    inviter = env.identity.add("Азиза")
    _, token = await env.invite(inviter, "referral")
    for _ in range(23):  # раньше всех открыли подростки без согласия родителя
        await env.open(env.identity.add(age="14-17"), token)
    env.now += timedelta(minutes=5)
    late = env.identity.add()
    await env.open(late, token)
    env.now += timedelta(hours=25)
    assert await env.tick() == {"reminders": 1, "expired": 0}
    [ev] = await env.events("social.invite.reminder_due.v1")
    assert ev.payload["invitee_user_id"] == str(late)
