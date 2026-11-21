"""Реферальные награды по кампании и совместные достижения (INTERNAL_API спринта 7 §2.4, AT-77, AT-78): награды
обеим сторонам по social.referral.qualified.v1 (только social), повтор события — одна награда, ack
game.referral.rewarded.v1; удалённому — без награды. Парный урок: XP за вклад (в итогах сессии участника), значок
together_1 обоим только при цели и вкладе каждого; молчавший — без XP и значка; только от lessons."""

from __future__ import annotations

import uuid
from typing import Any

from conftest import Env

from tilhero_gamification.domain.social_rewards import pair_session_id


async def qualified(env: Env, inviter: uuid.UUID, invitee: uuid.UUID, referral: uuid.UUID | None = None, *,
                    inviter_reward: dict[str, int] | None = None, invitee_reward: dict[str, int] | None = None,
                    monthly_cap: int = 10, qualified_at: str | None = None, producer: str = "social") -> uuid.UUID:
    rid = referral or uuid.uuid4()
    await env.publish("social.referral.qualified.v1", {
        "referral_id": str(rid), "inviter_user_id": str(inviter), "invitee_user_id": str(invitee),
        "campaign_version": 2, "inviter_reward": inviter_reward or {"freeze": 2, "til": 0},
        "invitee_reward": invitee_reward or {"freeze": 0, "til": 15}, "inviter_monthly_cap": monthly_cap,
        "qualified_at": qualified_at or env.ts()}, producer)
    return rid


async def test_referral_rewards_once_and_ack(env: Env) -> None:
    inviter, invitee = uuid.uuid4(), uuid.uuid4()
    await qualified(env, inviter, invitee, producer="lessons")  # чужой издатель — игнор
    assert await env.sql("SELECT count(*) FROM referral_rewards") == [(0,)]
    rid = await qualified(env, inviter, invitee, inviter_reward={"freeze": 2, "til": 10})
    await qualified(env, inviter, invitee, rid, inviter_reward={"freeze": 2, "til": 10})  # повтор события
    a = [(op.currency, op.amount, op.reason, op.idempotency_key) for op in await env.ops(inviter)]
    b = [(op.currency, op.amount, op.reason, op.idempotency_key) for op in await env.ops(invitee)]
    assert a == [("freeze", 2, "referral_bonus", f"referral:{rid}:inviter:freeze"),
                 ("til", 10, "referral_bonus", f"referral:{rid}:inviter:til")]
    assert b == [("til", 15, "referral_welcome", f"referral:{rid}:invitee:til")]
    assert (await env.wallet(inviter))["freeze"] == 2 + 2  # + бонус регистрации при первом ходе
    acks = await env.events("game.referral.rewarded.v1")
    assert {e.payload["referral_id"] for e in acks} == {str(rid)} and len(acks) == 2  # ack и на повтор
    assert acks[0].payload["inviter_user_id"] == str(inviter) and acks[0].payload["invitee_user_id"] == str(invitee)
    wallet = await env.adm("GET", f"wallets/{inviter}")
    assert wallet["referrals"]["rewarded"] == 1
    # история ученика: referral_welcome виден как обычная операция
    hist = await env.get(invitee, "history")
    assert [i["reason"] for i in hist["items"] if i["reason"].startswith("referral")] == ["referral_welcome"]


async def test_referral_deleted_invitee(env: Env) -> None:
    inviter, invitee = uuid.uuid4(), uuid.uuid4()
    await env.publish("user.deletion.requested.v1", {"user_id": str(invitee), "request_id": str(uuid.uuid4()),
                                                     "requested_at": env.ts()}, "identity-consent")
    rid = await qualified(env, inviter, invitee)
    assert await env.ops(invitee, bonus=True) == [] and await env.sql(
        "SELECT count(*) FROM learners WHERE user_id = :u", u=invitee) == [(0,)]
    assert [op.reason for op in await env.ops(inviter)] == ["referral_bonus"]
    [ack] = await env.events("game.referral.rewarded.v1")
    assert ack.payload["referral_id"] == str(rid) and ack.payload["invitee_user_id"] is None


async def pair_completed(env: Env, room: uuid.UUID, parts: list[tuple[uuid.UUID, bool, int]], *,
                         goal: bool = True, producer: str = "lessons") -> None:
    await env.publish("lesson.pair.completed.v1", {
        "room_id": str(room), "scenario_id": "sc-cafe", "pair_id": "ru-en", "status": "finished",
        "end_reason": "completed", "team_goal_reached": goal,
        "participants": [{"user_id": str(u), "role": "AB"[i], "contributed": c, "turns": t,
                          "speaking_seconds": 30 * t, "minutes": 12} for i, (u, c, t) in enumerate(parts)],
        "ended_at": env.ts()}, producer)


def pair_ops(ops: list[Any]) -> list[tuple[int, str]]:
    return [(op.amount, op.idempotency_key) for op in ops if op.reason == "pair_lesson"]


async def test_pair_lesson_xp_and_together_badge(env: Env) -> None:
    a, b, silent = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    room = uuid.uuid4()
    await pair_completed(env, room, [(a, True, 6), (b, True, 5)], producer="social")  # чужой издатель — игнор
    assert pair_ops(await env.ops(a)) == []
    await pair_completed(env, room, [(a, True, 6), (b, True, 5)])
    await pair_completed(env, room, [(a, True, 6), (b, True, 5)])  # повтор комнаты — без второго учёта
    for u in (a, b):
        assert pair_ops(await env.ops(u)) == [(25, f"pair:{room}:{u}")]
        rewards = await env.get(u, "rewards", params={"source_session_id": str(pair_session_id(room, u))})
        assert rewards["status"] == "ready" and [o["reason"] for o in rewards["operations"]] == ["pair_lesson"]
        assert [x["code"] for x in rewards["badges"]] == ["together_1"]
    badges = await env.events("game.badge.earned.v1")
    assert sorted(e.payload["user_id"] for e in badges if e.payload["badge_code"] == "together_1") == sorted(
        [str(a), str(b)])
    view = {x["code"]: x for x in (await env.get(a, "badges"))["items"]}
    assert view["together_1"]["basis"] == {"metric": "together", "value": 1, "threshold": 1}
    # молчавший: ни XP, ни значка; партнёр — XP за вклад, но без «Вместе» (вклад не у обоих)
    room2 = uuid.uuid4()
    await pair_completed(env, room2, [(silent, False, 0), (b, True, 7)])
    assert pair_ops(await env.ops(silent, bonus=True)) == []
    assert await env.sql("SELECT count(*) FROM badges WHERE user_id = :u", u=silent) == [(0,)]
    assert len(pair_ops(await env.ops(b))) == 2
    [(together,)] = await env.sql("SELECT together_count FROM learners WHERE user_id = :u", u=b)
    assert together == 1
    # цель не достигнута — XP за вклад, без значка
    c, d = uuid.uuid4(), uuid.uuid4()
    await pair_completed(env, uuid.uuid4(), [(c, True, 4), (d, True, 4)], goal=False)
    assert len(pair_ops(await env.ops(c))) == 1
    assert await env.sql("SELECT count(*) FROM badges WHERE user_id = :u", u=c) == [(0,)]
    # XP парного урока идёт в XP недели
    [(week,)] = await env.sql("SELECT league_week FROM ledger WHERE user_id = :u AND reason = 'pair_lesson'", u=c)
    assert week is not None
    # kind pair в lesson.session.completed — без начислений
    await env.lesson(c, "pair", session_id=pair_session_id(uuid.uuid4(), c))
    assert len([op for op in await env.ops(c) if op.currency == "xp"]) == 1
