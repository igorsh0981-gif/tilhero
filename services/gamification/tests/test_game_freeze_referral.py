"""Заморозки (AT-66/67): 2 при регистрации (ученик и детский профиль), трата по пропуску при auto_freeze → событие
game.streak.frozen.v1, повтор без второго списания, без заморозки и при выключенной автозаморозке — ничего; поздний
пропуск. Рефералы спринта 6 (после первого урока) отключены в спринте 7."""

from __future__ import annotations

import uuid
from datetime import timedelta

from conftest import Env


async def test_registration_bonus_account_and_child(env: Env, user: uuid.UUID) -> None:
    child = uuid.uuid4()
    await env.profile(user)
    await env.profile(child, kind="child", age_band="6-9", guardian=user)
    for u in (user, child):
        assert (await env.wallet(u))["freeze"] == 2
        [op] = await env.ops(u, bonus=True)
        assert (op.reason, op.currency, op.amount, op.rules_version) == ("registration_bonus", "freeze", 2, 2)
    [(kind, account, celebrations)] = await env.sql(
        "SELECT kind, account_id, celebrations FROM learners WHERE user_id = :u", u=child)
    assert (kind, account, celebrations) == ("child", user, "quiet")


async def test_missed_day_spends_freeze_once(env: Env, user: uuid.UUID) -> None:
    await env.profile(user)
    missed_day = env.today - timedelta(days=1)
    await env.missed(user, missed_day)
    [ev] = await env.events("game.streak.frozen.v1", user)
    assert ev.payload["local_date"] == missed_day.isoformat() and ev.payload["freeze_left"] == 1
    ops = [op for op in await env.ops(user) if op.reason == "streak_freeze"]
    assert [(op.amount, op.idempotency_key) for op in ops] == [(-1, f"freeze:{user}:{missed_day}")]
    assert str(ops[0].op_id) == ev.payload["op_id"]
    await env.missed(user, missed_day)  # повтор пропуска того же дня — без второго списания
    assert len(await env.events("game.streak.frozen.v1", user)) == 1
    assert (await env.wallet(user))["freeze"] == 1
    env.now += timedelta(days=1)
    await env.missed(user)  # следующий пропуск — последняя заморозка
    env.now += timedelta(days=1)
    await env.missed(user)  # запас 0 — серия рвётся мягко, без операций
    assert (await env.wallet(user))["freeze"] == 0
    assert len(await env.events("game.streak.frozen.v1", user)) == 2
    assert [b.payload["badge_code"] for b in await env.events("game.badge.earned.v1", user)] == ["first_freeze"]


async def test_auto_freeze_off_late_and_foreign(env: Env, user: uuid.UUID) -> None:
    await env.profile(user)
    s = await env.send("PATCH", user, "settings", {"auto_freeze": False})
    assert s["auto_freeze"] is False
    await env.missed(user)
    assert (await env.wallet(user))["freeze"] == 2
    await env.send("PATCH", user, "settings", {"auto_freeze": True})
    await env.missed(user, producer="lessons")  # чужой издатель — игнор
    await env.missed(user, env.today - timedelta(days=3))  # пропуск больше суток назад — не тратится
    await env.missed(user, env.today)  # день ещё не закончился
    assert (await env.wallet(user))["freeze"] == 2
    assert await env.events("game.streak.frozen.v1", user) == []


async def test_sprint6_referral_rule_disabled(env: Env, user: uuid.UUID) -> None:
    """Спринт 7: правило «после первого урока приглашённого» отключено — приглашение и урок ничего не начисляют,
    новые строки referrals не создаются (награды — по social.referral.qualified.v1, test_social_rewards)."""
    invitee = uuid.uuid4()
    await env.profile(user)
    await env.invite(user, invitee)
    await env.lesson(invitee)
    assert await env.sql("SELECT count(*) FROM referrals") == [(0,)]
    assert (await env.wallet(user))["freeze"] == 2
    assert [op for op in await env.ops(user) if op.reason == "referral_bonus"] == []


async def test_parallel_events_of_one_learner(env: Env, user: uuid.UUID) -> None:
    """Параллельные события одного ученика сериализуются: кошелёк = сумма реестра."""
    import asyncio

    invitee = uuid.uuid4()
    await asyncio.gather(*[env.lesson(invitee, passed=True) for _ in range(4)],
                         *[env.review(invitee, reviewed=10, correct=5) for _ in range(2)])
    [(xp, til)] = await env.sql("SELECT sum(amount) FILTER (WHERE currency='xp'), sum(amount) FILTER "
                                "(WHERE currency='til') FROM ledger WHERE user_id = :u", u=invitee)
    w = await env.wallet(invitee)
    assert (w["xp"], w["til"]) == (xp, til) and xp >= 4 * 30 + 2 * 15
    [(lessons,)] = await env.sql("SELECT lessons_completed FROM learners WHERE user_id = :u", u=invitee)
    assert lessons == 4
